// PLAN DE CONTRÔLE — cycle de vie d'un jeu d'identifiants.
//
// Seed idempotent, index unique, écriture partielle, validation contre un
// fournisseur simulé, et la règle qui distingue « configuré » de « valide ».
//
// Le réseau n'est JAMAIS sollicité : `fetchImpl` est injecté. Une suite qui
// dépend d'un fournisseur externe échoue le jour où ce fournisseur tousse, et
// on finit par ne plus la croire.
import {
  check, finish, section, setTestEnv, startMemoryMongo, connectTestDatabase, stopMemoryMongo,
} from './helpers/harness.js';

setTestEnv();
await startMemoryMongo();
await connectTestDatabase();

const controlPlane = await import('../backend/src/services/integratedApi/controlPlane.service.js');
const { seedIntegratedApiCredentialSets } = await import(
  '../backend/src/services/integratedApi/seed.js'
);
const { default: CredentialSet, CREDENTIAL_SET_STATUS } = await import(
  '../backend/src/models/PanelIntegratedApiCredentialSet.model.js'
);
const { VALIDATION_STATUS, VALIDATION_CODES } = await import(
  '../backend/src/services/integratedApi/providerValidation.js'
);
const { PanelEvent, EVENT_TYPES } = await import(
  '../backend/src/models/PanelSupervision.model.js'
);

const SK_TEST = 'sk_test_SENTINEL0000000000AAAA1234';

/** Fournisseur simulé — aucune sortie réseau, réponses maîtrisées. */
function fakeFetch(status, body = {}, headers = {}) {
  return async () => ({
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => headers[name.toLowerCase()] ?? null },
    text: async () => JSON.stringify(body),
  });
}

async function rejects(fn, code) {
  try { await fn(); return false; } catch (err) { return err?.code === code; }
}

section('Seed — idempotent, et il ne copie RIEN');
{
  const premier = await seedIntegratedApiCredentialSets();
  // 3 fournisseurs × 2 environnements + 1 global = 7.
  check('7 jeux amorcés au premier passage', premier.created === 7 && premier.existing === 0);

  const second = await seedIntegratedApiCredentialSets();
  check('rejoué : aucun nouveau jeu', second.created === 0 && second.existing === 7);

  const troisieme = await seedIntegratedApiCredentialSets();
  check('rejoué deux fois : toujours 7', troisieme.created === 0 && troisieme.existing === 7);

  const total = await CredentialSet.countDocuments();
  check('7 documents en base, pas un de plus', total === 7);

  const tous = await CredentialSet.find({}).lean();
  check('tous les jeux amorcés sont VIDES',
    tous.every((d) => d.status === CREDENTIAL_SET_STATUS.EMPTY
      && Object.keys(d.credentialsEncrypted ?? {}).length === 0));
  check('aucun identifiant n’a été aspiré depuis un projet',
    tous.every((d) => Object.keys(d.credentialsEncrypted ?? {}).length === 0));
}

section('Index unique — un seul jeu par (fournisseur, environnement)');
{
  // L'index est construit à la demande dans mongodb-memory-server.
  await CredentialSet.syncIndexes();
  let refuse = false;
  try {
    await CredentialSet.create({
      credentialSetId: 'doublon', provider: 'STRIPE', scope: 'ENVIRONMENT',
      environment: 'TEST', projectId: null,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    });
  } catch (err) {
    refuse = err?.code === 11000;
  }
  check('un second jeu STRIPE/TEST est refusé par la base', refuse);

  let refuseGlobal = false;
  try {
    await CredentialSet.create({
      credentialSetId: 'doublon-global', provider: 'HOSTINGER', scope: 'PANEL_GLOBAL',
      environment: null, projectId: null,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    });
  } catch (err) {
    refuseGlobal = err?.code === 11000;
  }
  check('un second jeu HOSTINGER global est refusé aussi', refuseGlobal);
}

section('Catalogue — l’état de départ dit la vérité');
{
  const items = await controlPlane.listProviders();
  check('4 fournisseurs', items.length === 4);
  check('chacun porte sa définition et ses jeux',
    items.every((i) => i.definition && Array.isArray(i.credentialSets)));

  const stripe = items.find((i) => i.definition.provider === 'STRIPE');
  check('Stripe a deux jeux', stripe.credentialSets.length === 2);
  check('les deux sont EMPTY',
    stripe.credentialSets.every((s) => s.status === CREDENTIAL_SET_STATUS.EMPTY));
  check('l’environnement effectif de Stripe ici est TEST', stripe.effectiveEnvironment === 'TEST');
  check('le runtime est annoncé', stripe.runtimeEnvironment === 'TEST');

  const hostinger = items.find((i) => i.definition.provider === 'HOSTINGER');
  check('Hostinger n’a qu’un jeu', hostinger.credentialSets.length === 1);
  check('…sans environnement', hostinger.credentialSets[0].environment === null);
  check('…et son environnement effectif est null', hostinger.effectiveEnvironment === null);
}

section('Enregistrement — et ce qu’il NE déclenche pas');
{
  const avantEvenements = await PanelEvent.countDocuments();

  const apres = await controlPlane.saveCredentialSet('STRIPE', 'TEST', {
    values: { secretKey: SK_TEST },
  }, { userId: 'dev-1' });

  check('le jeu devient CONFIGURED', apres.status === CREDENTIAL_SET_STATUS.CONFIGURED);
  check('configured = true', apres.configured === true);
  check('la clé est marquée renseignée', apres.credentials.secretKey.configured === true);
  check('…mais sa valeur reste nulle', apres.credentials.secretKey.value === null);
  check('aucune validation n’est réclamée d’office', apres.lastValidatedAt === null);

  const evenements = await PanelEvent.find({}).sort({ occurredAt: -1 }).lean();
  check('un événement d’observabilité est enregistré',
    evenements.length === avantEvenements + 1
    && evenements[0].type === EVENT_TYPES.INTEGRATED_API_CREDENTIALS_UPDATED);
  check('il ne concerne aucun projet', evenements[0].projectId === null);
  check('il nomme les rôles, jamais les valeurs',
    evenements[0].data.written.join() === 'secretKey'
    && !JSON.stringify(evenements[0]).includes(SK_TEST));

  // L'ancien service du Panel rediffusait les clés aux projets à chaque
  // écriture. Celui-ci ne parle à personne : c'est la règle du plan de
  // contrôle, et elle doit être vérifiée, pas supposée.
  const source = controlPlane.saveCredentialSet.toString();
  check('aucune diffusion vers les projets',
    !/emitChange|publishToProject|republish|audience/.test(source));
}

section('Écriture partielle — rien n’est effacé par accident');
{
  const apres = await controlPlane.saveCredentialSet('STRIPE', 'TEST', {
    values: { publishableKey: 'pk_test_PUBLIQUE' },
  }, { userId: 'dev-1' });
  check('la clé secrète a survécu', apres.credentials.secretKey.configured === true);
  check('la clé publiable est là, et lisible',
    apres.credentials.publishableKey.value === 'pk_test_PUBLIQUE');

  check('un enregistrement sans rien à écrire est refusé',
    await rejects(() => controlPlane.saveCredentialSet('STRIPE', 'TEST', { values: {} }),
      'PANEL_INTEGRATED_API_NOTHING_TO_SAVE'));

  const retire = await controlPlane.saveCredentialSet('STRIPE', 'TEST', {
    remove: ['publishableKey'],
  }, { userId: 'dev-1' });
  check('retirer exige de nommer, et fonctionne',
    retire.credentials.publishableKey.configured === false);
  check('…sans toucher au reste', retire.credentials.secretKey.configured === true);
}

section('Refus — fournisseur inconnu, environnement absurde');
{
  check('fournisseur hors registre → 404',
    await rejects(() => controlPlane.getProvider('MAILCHIMP'),
      'PANEL_INTEGRATED_API_UNKNOWN_PROVIDER'));
  check('Stripe sans environnement → refusé',
    await rejects(() => controlPlane.saveCredentialSet('STRIPE', null, { values: { secretKey: SK_TEST } }),
      'PANEL_INTEGRATED_API_ENVIRONMENT_REQUIRED'));
  check('Hostinger AVEC environnement → refusé',
    await rejects(() => controlPlane.saveCredentialSet('HOSTINGER', 'TEST', { values: { apiToken: 'x' } }),
      'PANEL_INTEGRATED_API_ENVIRONMENT_UNEXPECTED'));
}

section('Validation — VALID, et la preuve est datée');
{
  const resultat = await controlPlane.validateCredentialSet('STRIPE', 'TEST', {
    fetchImpl: fakeFetch(200, { id: 'acct_SENTINEL', country: 'FR', charges_enabled: true },
      { 'stripe-version': '2024-06-20' }),
  });
  check('issue VALID', resultat.validation.status === VALIDATION_STATUS.VALID);
  check('code OK', resultat.validation.code === VALIDATION_CODES.OK);
  check('le jeu passe à VALID', resultat.status === CREDENTIAL_SET_STATUS.VALID);
  check('la date est posée', typeof resultat.lastValidatedAt === 'string');
  check('la durée est mesurée', typeof resultat.lastValidationDurationMs === 'number');
  check('le diagnostic est NON sensible',
    resultat.validation.details.account === 'acct_SENTINEL'
    && !JSON.stringify(resultat.validation.details).includes(SK_TEST));
  check('l’environnement de la clé est constaté',
    resultat.validation.details.keyEnvironment === 'test');

  const evenement = await PanelEvent.findOne({
    type: EVENT_TYPES.INTEGRATED_API_VALIDATION_SUCCEEDED,
  }).lean();
  check('un événement de succès est journalisé', Boolean(evenement));
  check('il porte provider, environnement, portée, durée',
    evenement.data.provider === 'STRIPE' && evenement.data.environment === 'TEST'
    && evenement.data.scope === 'ENVIRONMENT' && typeof evenement.data.durationMs === 'number');
  check('il ne porte AUCUN secret', !JSON.stringify(evenement).includes(SK_TEST));
}

section('Une preuve ne survit pas à la clé qu’elle prouvait');
{
  const avant = await controlPlane.getCredentialSet('STRIPE', 'TEST');
  check('le jeu est VALID avant remplacement', avant.status === CREDENTIAL_SET_STATUS.VALID);

  await controlPlane.saveCredentialSet('STRIPE', 'TEST', {
    values: { secretKey: 'sk_test_AUTRECLE00000000000ZZZZ' },
  }, { userId: 'dev-1' });

  const apres = await controlPlane.getCredentialSet('STRIPE', 'TEST');
  check('après remplacement, le jeu retombe à CONFIGURED',
    apres.status === CREDENTIAL_SET_STATUS.CONFIGURED);
  check('…et non VALID', apres.status !== CREDENTIAL_SET_STATUS.VALID);
}

section('Validation — INVALID et ERROR ne se confondent pas');
{
  const refuse = await controlPlane.validateCredentialSet('STRIPE', 'TEST', {
    fetchImpl: fakeFetch(401, { error: { message: 'Invalid API Key provided' } }),
  });
  check('401 → INVALID (le fournisseur a répondu, il refuse)',
    refuse.validation.status === VALIDATION_STATUS.INVALID
    && refuse.validation.code === VALIDATION_CODES.UNAUTHORIZED);
  check('le jeu devient INVALID', refuse.status === CREDENTIAL_SET_STATUS.INVALID);

  const injoignable = await controlPlane.validateCredentialSet('STRIPE', 'TEST', {
    fetchImpl: async () => { throw new Error('ECONNREFUSED'); },
  });
  check('réseau coupé → ERROR, jamais INVALID',
    injoignable.validation.status === VALIDATION_STATUS.ERROR);
  check('le jeu devient ERROR, pas INVALID',
    injoignable.status === CREDENTIAL_SET_STATUS.ERROR);
  // Confondre les deux enverrait l'opérateur régénérer une clé qui n'a rien.

  const surcharge = await controlPlane.validateCredentialSet('STRIPE', 'TEST', {
    fetchImpl: fakeFetch(429, { error: { message: 'Too many requests' } }),
  });
  check('429 → ERROR (on ne sait pas si la clé est bonne)',
    surcharge.validation.status === VALIDATION_STATUS.ERROR
    && surcharge.validation.code === VALIDATION_CODES.RATE_LIMITED);
}

section('Validation — impossible sans identifiants, et ce n’est pas une panne');
{
  // Le seed a créé ce jeu VIDE : son existence ne prouve rien. Le refus se
  // fonde sur les rôles requis, pas sur la présence d'un document.
  check('un jeu jamais renseigné refuse le test',
    await rejects(() => controlPlane.validateCredentialSet('YOUSIGN', 'PROD', {}),
      'PANEL_INTEGRATED_API_NOT_CONFIGURED'));

  await controlPlane.saveCredentialSet('YOUSIGN', 'TEST', {
    values: { webhookSecret: 'secret-sans-cle' },
  }, { userId: 'dev-1' });
  check('un jeu à moitié rempli refuse aussi — sans appeler le fournisseur',
    await rejects(() => controlPlane.validateCredentialSet('YOUSIGN', 'TEST', {
      fetchImpl: async () => { throw new Error('le fournisseur ne doit PAS être appelé'); },
    }), 'PANEL_INTEGRATED_API_NOT_CONFIGURED'));

  const yousign = await controlPlane.getCredentialSet('YOUSIGN', 'TEST');
  check('…et il reste EMPTY, jamais ERROR',
    yousign.status === CREDENTIAL_SET_STATUS.EMPTY);

  // La garde de la fonction pure demeure, en défense en profondeur.
  const { validateCredentials } = await import(
    '../backend/src/services/integratedApi/providerValidation.js'
  );
  const nu = await validateCredentials({
    provider: 'YOUSIGN', environment: 'TEST', credentialsEncrypted: {},
    fetchImpl: async () => { throw new Error('jamais appelé'); },
  });
  check('validateCredentials seul nomme ce qui manque',
    nu.code === VALIDATION_CODES.MISSING_CREDENTIALS && nu.details.missing.join() === 'apiKey');
}

section('Disponibilité — la question que posera la passerelle de capacités');
{
  await controlPlane.saveCredentialSet('STRIPE', 'TEST', {
    values: { secretKey: SK_TEST },
  }, { userId: 'dev-1' });
  await controlPlane.validateCredentialSet('STRIPE', 'TEST', {
    fetchImpl: fakeFetch(200, { id: 'acct_SENTINEL' }),
  });

  const stripe = await controlPlane.describeAvailability('STRIPE');
  check('Stripe est disponible', stripe.available === true);
  check('…sur l’environnement du runtime, jamais un autre', stripe.environment === 'TEST');
  check('aucune capacité n’est invocable en L1', stripe.capabilitiesInvocable === false);
  check('…mais elles sont déclarées', stripe.capabilities.includes('billing.refund'));

  const brevo = await controlPlane.describeAvailability('BREVO');
  check('Brevo n’est pas disponible', brevo.available === false);
  check('…et le motif est nommé', brevo.reason === 'NOT_CONFIGURED');

  // La signature elle-même interdit de demander un autre monde : il n'y a
  // aucun paramètre d'environnement.
  check('describeAvailability n’accepte aucun environnement',
    controlPlane.describeAvailability.length === 1);

  const tous = await controlPlane.describeAllAvailability();
  check('le diagnostic couvre les 4 fournisseurs', tous.length === 4);
  check('chacun annonce l’environnement du runtime',
    tous.every((d) => d.runtimeEnvironment === 'TEST'));
}

await stopMemoryMongo();
finish();
