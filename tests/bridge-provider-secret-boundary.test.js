// LA FRONTIÈRE — invariant PROVIDER_SECRETS_NEVER_CROSS_THE_BRIDGE (lot L4).
//
// Deux garanties, et la seconde compte plus que la première :
//
//   1. les identifiants des QUATRE fournisseurs actuels sont refusés ;
//   2. l'invariant SURVIT AU CINQUIÈME — un rôle déclaré `secret: true` dans
//      le registre est bloqué sans que personne ait pensé à l'ajouter ici.
//
// Une garde adossée à une liste de mots vieillit mal : elle protège ce qu'on
// connaissait le jour où on l'a écrite. Celle-ci lit le registre.
import { check, finish, section, setTestEnv } from './helpers/harness.js';
import { forme } from './helpers/secretShapes.js';

setTestEnv();

const guard = await import('../backend/src/bridge/providerSecretGuard.js');
const {
  assertNoProviderSecrets, inspectForProviderSecrets,
  forbiddenCredentialRoles, publishableCredentialRoles,
  ProviderSecretLeakError,
} = guard;

const passe = (payload) => inspectForProviderSecrets(payload).clean;
const refuse = (payload) => !inspectForProviderSecrets(payload).clean;

section('Le vocabulaire vient du registre, pas d’une liste de mots');
{
  const interdits = forbiddenCredentialRoles();
  const publiables = publishableCredentialRoles();

  for (const role of ['secretkey', 'apikey', 'apitoken', 'webhooksecret']) {
    check(`« ${role} » est interdit`, interdits.has(role));
  }
  check('« publishablekey » N’EST PAS interdite', !interdits.has('publishablekey'));
  check('…elle est explicitement publiable', publiables.has('publishablekey'));
  check('« baseurl » est publiable', publiables.has('baseurl'));

  // Ceux-là n'appartiennent à aucun fournisseur : c'est le filet générique.
  for (const role of ['password', 'bridgetoken', 'credentialsencrypted']) {
    check(`« ${role} » est interdit (filet générique)`, interdits.has(role));
  }
}

section('Les quatre fournisseurs actuels — refusés par le NOM du champ');
{
  check('Stripe secretKey', refuse({ provider: 'STRIPE', secretKey: forme.stripeTest('XXXXXXXXXXXX') }));
  check('Brevo apiKey', refuse({ provider: 'BREVO', apiKey: forme.brevoApiKey('AAAAAAAAAAAAAAAAAAAA') }));
  check('Yousign apiKey', refuse({ provider: 'YOUSIGN', apiKey: forme.yousignApiKey('AAAAAAAAAAAA') }));
  check('Hostinger apiToken', refuse({ provider: 'HOSTINGER', apiToken: 'AAAAAAAAAAAAAAAA' }));
  check('secret de webhook', refuse({ webhookSecret: forme.stripeWebhook('AAAAAAAAAAAA') }));

  check('la forme historique { credentials: {...} } est refusée',
    refuse({ apiId: 'x', key: 'stripe', credentials: { secretKey: forme.stripeTest('AAAAAAAAAAAA') } }));

  check('un champ interdit imbriqué profond est trouvé',
    refuse({ a: { b: { c: [{ apiKey: forme.brevoApiKey('AAAAAAAAAAAAAAAAAAAA') }] } } }));

  check('l’erreur NOMME le chemin, jamais la valeur', (() => {
    try {
      assertNoProviderSecrets({ api: { secretKey: forme.stripeTest('SENTINELLE123456') } });
      return false;
    } catch (err) {
      return err instanceof ProviderSecretLeakError
        && err.path === 'payload.api.secretKey'
        && !err.message.includes('SENTINELLE');
    }
  })());
}

section('Refusés par la FORME de la valeur, quel que soit le champ');
{
  // Une clé peut fuir sous un nom innocent : la garde la reconnaît quand même.
  check('sk_live_ sous « note »',
    refuse({ note: `la clé est ${forme.stripeLive('AB-CD-EF-GH-IJ-KL')}` }));
  check('sk_test_ sous « description »', refuse({ description: forme.stripeTest('AB-CD-EF-GH-IJ-KL') }));
  check('whsec_ dans un tableau', refuse({ items: [forme.stripeWebhook('AB-CD-EF-GH-IJ-KL')] }));
  check('xkeysib- sous « value »', refuse({ value: forme.brevoApiKey('AB-CD-EF-GH-IJ-KL-MN-OP-QR-S') }));

  // Une documentation qui cite le préfixe seul ne doit pas être refusée : la
  // garde exige une longueur plausible.
  check('« commence par sk_test_ » n’est pas une fuite',
    passe({ hint: 'la clé commence par sk_test_' }));
}

section('Ce qui DOIT passer — sinon la garde casse le métier');
{
  check('une charge d’entreprise complète', passe({
    companyId: 'c-1', slug: 'ly-solution', environment: 'TEST', version: 3,
    identity: { name: 'L.Y Solution', email: 'contact@ly.test' },
    branding: { logo: { objectKey: 'a.webp', sha256: 'a'.repeat(64) } },
    domains: { websiteUrl: 'https://exemple.test' },
    contacts: { phone: '0102030405' },
    legal: { siret: '12345678900011' },
    team: [{ firstName: 'A', role: 'DEV' }],
  }));

  check('une clé PUBLIABLE Stripe passe — c’est sa raison d’être',
    passe({ provider: 'STRIPE', publishableKey: 'pk_test_AbCdEfGhIjKlMnOp' }));
  check('une URL de base passe', passe({ baseUrl: 'https://api.stripe.com' }));

  // Un champ interdit mais VIDE est un reste de forme, pas une fuite.
  check('secretKey vide passe', passe({ secretKey: '' }));
  check('credentials: {} passe', passe({ credentials: {} }));
  check('apiKey: null passe', passe({ apiKey: null }));

  check('null et undefined passent', passe(null) && passe(undefined));
  check('un scalaire passe', passe(42) && passe('bonjour'));
}

section('L’INVARIANT SURVIT AU CINQUIÈME FOURNISSEUR');
{
  /**
   * On n'ajoute pas un vrai fournisseur au registre — il est gelé, et ce
   * serait une modification de production pour un test. On vérifie la
   * MÉCANIQUE : la garde dérive son vocabulaire de `credentialRoles.secret`,
   * donc tout rôle déclaré confidentiel est couvert d'office.
   */
  const registre = await import('../backend/src/services/integratedApi/providerRegistry.js');
  const interdits = forbiddenCredentialRoles();

  let rolesConfidentiels = 0;
  for (const definition of registre.listProviderDefinitions()) {
    for (const role of definition.credentialRoles) {
      if (!role.secret) continue;
      rolesConfidentiels += 1;
      check(`${definition.code}.${role.code} est couvert automatiquement`,
        interdits.has(role.code.toLowerCase()));
    }
  }
  check('au moins six rôles confidentiels sont couverts', rolesConfidentiels >= 6);

  // La preuve la plus directe : un rôle qui n'existe dans AUCUNE liste écrite
  // à la main, mais qui serait déclaré confidentiel, doit être refusé. On
  // simule en interrogeant la dérivation elle-même.
  const derive = guard.forbiddenCredentialRoles.toString();
  check('la dérivation lit bien `role.secret` du registre',
    /role\.secret/.test(derive) && /listProviderDefinitions/.test(derive));
  check('…et non une liste de fournisseurs codée en dur',
    !/STRIPE|BREVO|YOUSIGN|HOSTINGER/.test(derive));
}

section('La garde est posée à l’unique point d’émission');
{
  const fs = await import('node:fs/promises');
  const syncCore = await fs.readFile(
    new URL('../backend/src/services/sync/syncCore.service.js', import.meta.url), 'utf8',
  );
  check('syncCore.emitChange appelle la garde',
    /assertNoProviderSecrets\(payload/.test(syncCore));
  check('…AVANT d’écrire au journal',
    syncCore.indexOf('assertNoProviderSecrets(payload')
    < syncCore.indexOf('PanelSyncJournalEntry.create(entry)'));

  const pairing = await fs.readFile(
    new URL('../backend/src/services/pairing/pairing.service.js', import.meta.url), 'utf8',
  );
  check('la réponse d’appairage ne joint plus d’API intégrées',
    !/integratedApis:\s*await/.test(pairing));

  const ancien = await fs.readFile(
    new URL('../backend/src/services/company/integratedApi.service.js', import.meta.url), 'utf8',
  );
  check('l’ancien coffre ne déchiffre plus rien', !/decryptSecret\(/.test(ancien));
  // Les quatre fonctions de diffusion ne sont plus DÉCLARÉES. Le bloc de
  // commentaire qui explique leur disparition les nomme encore — c'est le
  // propos —, d'où une recherche sur la déclaration et non sur le mot.
  for (const nom of ['buildApiPayloadFor', 'publishToProject', 'republishToGrantees', 'emitRevocation']) {
    check(`…${nom} n’est plus déclarée`,
      !new RegExp(`(export\\s+)?(async\\s+)?function\\s+${nom}\\b`).test(ancien));
  }
  check('…n’émet plus rien sur le pont', !/emitChange\(/.test(ancien));
  check('…mais conserve les autorisations (elles deviendront des capacités)',
    /grantsForProject/.test(ancien));
}

finish();
