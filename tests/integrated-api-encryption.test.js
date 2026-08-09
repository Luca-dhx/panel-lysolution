// COFFRE — invariant CREDENTIALS_NEVER_LEAVE_CONTROL_PLANE.
//
// Un secret est écrit, puis recherché PARTOUT où il pourrait avoir fui : dans
// le document Mongo BRUT (pas l'objet mongoose — le document réellement
// persisté), dans la sérialisation JSON du modèle, dans la vue masquée, dans
// la vue de service. Il ne doit apparaître qu'à un seul endroit :
// `decryptCredentialSet`.
//
// La sentinelle est explicite et improbable : si elle apparaît quelque part,
// c'est une fuite, jamais une coïncidence.
import {
  check, finish, section, setTestEnv, startMemoryMongo, connectTestDatabase, stopMemoryMongo,
} from './helpers/harness.js';

setTestEnv();
await startMemoryMongo();
await connectTestDatabase();

const SENTINEL_SECRET = 'sk_test_SENTINEL0000000000AAAA1234';
const SENTINEL_BREVO = 'xkeysib-SENTINEL0000000000BBBB5678';
const SENTINEL_TOKEN = 'SENTINEL0000000000CCCC9012';

const vault = await import('../backend/src/services/integratedApi/credentialVault.js');
const controlPlane = await import('../backend/src/services/integratedApi/controlPlane.service.js');
const { default: CredentialSet } = await import(
  '../backend/src/models/PanelIntegratedApiCredentialSet.model.js'
);
const { seedIntegratedApiCredentialSets } = await import(
  '../backend/src/services/integratedApi/seed.js'
);

await seedIntegratedApiCredentialSets();

/** Le texte contient-il l'une des sentinelles ? */
function leaks(text) {
  const haystack = typeof text === 'string' ? text : JSON.stringify(text ?? null);
  return [SENTINEL_SECRET, SENTINEL_BREVO, SENTINEL_TOKEN].some((s) => haystack.includes(s));
}

section('Chiffrement — AES-256-GCM, jamais deux fois le même cryptogramme');
{
  const { stored } = vault.encryptCredentialValues({
    provider: 'STRIPE',
    values: { secretKey: SENTINEL_SECRET },
    environment: 'TEST',
  });
  const encrypted = stored.secretKey.encrypted;
  check('la valeur stockée n’est pas le clair', encrypted !== SENTINEL_SECRET);
  check('le clair n’apparaît pas dans le cryptogramme', !encrypted.includes(SENTINEL_SECRET));
  check('format iv.tag.ciphertext', encrypted.split('.').length === 3);

  const second = vault.encryptCredentialValues({
    provider: 'STRIPE', values: { secretKey: SENTINEL_SECRET }, environment: 'TEST',
  });
  check('IV aléatoire : deux chiffrements diffèrent',
    second.stored.secretKey.encrypted !== encrypted);
  check('…mais l’empreinte, elle, est stable',
    second.stored.secretKey.fingerprint === stored.secretKey.fingerprint);
  check('l’empreinte ne contient pas le clair', !leaks(stored.secretKey.fingerprint));
  check('lastFour ne garde que 4 caractères', stored.secretKey.lastFour === '1234');
}

section('Écriture partielle — une valeur vide CONSERVE, elle n’efface pas');
{
  const premier = vault.encryptCredentialValues({
    provider: 'STRIPE', values: { secretKey: SENTINEL_SECRET }, environment: 'TEST',
  });
  const second = vault.encryptCredentialValues({
    provider: 'STRIPE',
    current: premier.stored,
    values: { secretKey: '', publishableKey: 'pk_test_VISIBLE' },
    environment: 'TEST',
  });
  check('la clé secrète survit à un champ vide', Boolean(second.stored.secretKey));
  check('l’autre clé est bien écrite', Boolean(second.stored.publishableKey));
  check('seule la clé écrite est rapportée', second.written.join() === 'publishableKey');

  const retrait = vault.encryptCredentialValues({
    provider: 'STRIPE', current: second.stored, remove: ['secretKey'], environment: 'TEST',
  });
  check('retirer exige de NOMMER la clé', retrait.stored.secretKey === undefined);
  check('le retrait est rapporté', retrait.removed.join() === 'secretKey');
}

section('Préfixe — une clé LIVE saisie en TEST est refusée AVANT chiffrement');
{
  const refuse = (fn, code) => {
    try { fn(); return false; } catch (err) { return err?.code === code; }
  };
  check('sk_live_ en TEST : refusé, et le motif est nommé',
    refuse(() => vault.encryptCredentialValues({
      provider: 'STRIPE', values: { secretKey: 'sk_live_SENTINEL' }, environment: 'TEST',
    }), 'PANEL_INTEGRATED_API_PREFIX_WRONG_ENVIRONMENT'));
  check('sk_test_ en PROD : refusé aussi',
    refuse(() => vault.encryptCredentialValues({
      provider: 'STRIPE', values: { secretKey: SENTINEL_SECRET }, environment: 'PROD',
    }), 'PANEL_INTEGRATED_API_PREFIX_WRONG_ENVIRONMENT'));
  check('une clé Brevo sans xkeysib- est refusée',
    refuse(() => vault.encryptCredentialValues({
      provider: 'BREVO', values: { apiKey: 'pas-une-cle-brevo' }, environment: 'TEST',
    }), 'PANEL_INTEGRATED_API_PREFIX_UNEXPECTED'));
  check('un rôle inconnu est refusé',
    refuse(() => vault.encryptCredentialValues({
      provider: 'STRIPE', values: { motDePasse: 'x' }, environment: 'TEST',
    }), 'PANEL_INTEGRATED_API_ROLE_UNKNOWN'));
}

section('Masquage — un secret ne rend que son empreinte et ses 4 derniers');
{
  const { stored } = vault.encryptCredentialValues({
    provider: 'STRIPE',
    values: { secretKey: SENTINEL_SECRET, publishableKey: 'pk_test_PUBLIQUE' },
    environment: 'TEST',
  });
  const vue = vault.maskCredentialSet('STRIPE', stored, { environment: 'TEST' });

  check('aucune sentinelle dans la vue masquée', !leaks(vue));
  check('secretKey : valeur nulle', vue.secretKey.value === null);
  check('secretKey : masque avec les 4 derniers', vue.secretKey.maskedValue.endsWith('1234'));
  check('secretKey : marquée confidentielle', vue.secretKey.secret === true);
  check('secretKey : empreinte présente', typeof vue.secretKey.fingerprint === 'string');

  // Une clé publiable est faite pour être servie à un navigateur : la masquer
  // n'apporterait rien et empêcherait de la relire.
  check('publishableKey : rendue en clair, car publique',
    vue.publishableKey.value === 'pk_test_PUBLIQUE' && vue.publishableKey.secret === false);

  check('un rôle non renseigné dit « non configuré »',
    vue.webhookSecret.configured === false && vue.webhookSecret.value === null);
  check('la valeur par défaut du registre est proposée',
    vue.baseUrl.defaultValue === 'https://api.stripe.com');
}

section('Déchiffrement — la seule porte, et elle complète avec les défauts');
{
  const { stored } = vault.encryptCredentialValues({
    provider: 'YOUSIGN', values: { apiKey: SENTINEL_TOKEN }, environment: 'TEST',
  });
  const clair = vault.decryptCredentialSet('YOUSIGN', stored, { environment: 'TEST' });
  check('la valeur revient intacte', clair.apiKey === SENTINEL_TOKEN);
  check('la baseUrl non saisie prend le défaut du mode',
    clair.baseUrl === 'https://api-sandbox.yousign.app/v3');
  const clairProd = vault.decryptCredentialSet('YOUSIGN', stored, { environment: 'PROD' });
  check('…et le défaut suit l’environnement demandé',
    clairProd.baseUrl === 'https://api.yousign.app/v3');
}

section('État — configuré, et empreinte de fraîcheur');
{
  const vide = vault.encryptCredentialValues({
    provider: 'STRIPE', values: { publishableKey: 'pk_test_SEULE' }, environment: 'TEST',
  });
  check('sans la clé requise : non configuré', vault.isConfigured('STRIPE', vide.stored) === false);
  check('empreinte vide quand incomplet', vault.requiredFingerprint('STRIPE', vide.stored) === '');

  const complet = vault.encryptCredentialValues({
    provider: 'STRIPE', current: vide.stored, values: { secretKey: SENTINEL_SECRET }, environment: 'TEST',
  });
  check('avec la clé requise : configuré', vault.isConfigured('STRIPE', complet.stored) === true);
  const empreinte = vault.requiredFingerprint('STRIPE', complet.stored);
  check('empreinte non vide', empreinte.length > 0);
  check('l’empreinte ne contient pas le clair', !leaks(empreinte));

  const remplace = vault.encryptCredentialValues({
    provider: 'STRIPE', current: complet.stored,
    values: { secretKey: 'sk_test_AUTRECLE0000000000ZZZZ' }, environment: 'TEST',
  });
  check('remplacer la clé change l’empreinte — une preuve ne survit pas à sa clé',
    vault.requiredFingerprint('STRIPE', remplace.stored) !== empreinte);
}

section('CREDENTIALS_NEVER_LEAVE_CONTROL_PLANE — le parcours complet');
{
  await controlPlane.saveCredentialSet('STRIPE', 'TEST', {
    values: { secretKey: SENTINEL_SECRET, publishableKey: 'pk_test_PUBLIQUE' },
  }, { userId: 'test-dev' });
  await controlPlane.saveCredentialSet('BREVO', 'TEST', {
    values: { apiKey: SENTINEL_BREVO },
  }, { userId: 'test-dev' });
  await controlPlane.saveCredentialSet('HOSTINGER', null, {
    values: { apiToken: SENTINEL_TOKEN },
  }, { userId: 'test-dev' });

  // 1. Le document RÉELLEMENT persisté, lu par le pilote natif — pas l'objet
  //    mongoose, qui pourrait masquer à la sérialisation.
  const brut = await CredentialSet.collection.find({}).toArray();
  check('3 jeux au moins persistés', brut.length >= 3);
  check('AUCUNE sentinelle dans le document Mongo brut', !leaks(brut));

  // 2. La sérialisation d'un document mongoose — le piège du `res.json(doc)`.
  const documents = await CredentialSet.find({});
  check('AUCUNE sentinelle dans JSON.stringify(model)', !leaks(JSON.stringify(documents)));
  check('AUCUNE sentinelle dans .toObject()',
    !leaks(JSON.stringify(documents.map((d) => d.toObject()))));

  // 3. Ce que le service rend — la source de toute réponse d'API.
  check('AUCUNE sentinelle dans listProviders()', !leaks(await controlPlane.listProviders()));
  check('AUCUNE sentinelle dans getProvider()', !leaks(await controlPlane.getProvider('STRIPE')));
  check('AUCUNE sentinelle dans getCredentialSet()',
    !leaks(await controlPlane.getCredentialSet('STRIPE', 'TEST')));
  check('AUCUNE sentinelle dans describeAllAvailability()',
    !leaks(await controlPlane.describeAllAvailability()));

  // 4. …et pourtant, la valeur est bien là, lisible par la seule porte.
  const document = await CredentialSet.findOne({ provider: 'STRIPE', environment: 'TEST' }).lean();
  const clair = vault.decryptCredentialSet('STRIPE', document.credentialsEncrypted, { environment: 'TEST' });
  check('decryptCredentialSet, LUI, rend le secret', clair.secretKey === SENTINEL_SECRET);

  const global = await CredentialSet.findOne({ provider: 'HOSTINGER', environment: null }).lean();
  check('le jeu global est stocké sans environnement', global.environment === null);
  check('…et se déchiffre par la même porte',
    vault.decryptCredentialSet('HOSTINGER', global.credentialsEncrypted).apiToken === SENTINEL_TOKEN);
}

section('Le coffre survit à un redémarrage');
{
  const { simulateRestart } = await import('./helpers/harness.js');
  await simulateRestart();
  const apres = await CredentialSet.findOne({ provider: 'BREVO', environment: 'TEST' }).lean();
  const clair = vault.decryptCredentialSet('BREVO', apres.credentialsEncrypted, { environment: 'TEST' });
  check('la clé Brevo est toujours déchiffrable', clair.apiKey === SENTINEL_BREVO);
  check('…et toujours absente de la vue masquée',
    !leaks(vault.maskCredentialSet('BREVO', apres.credentialsEncrypted)));
}

await stopMemoryMongo();
finish();
