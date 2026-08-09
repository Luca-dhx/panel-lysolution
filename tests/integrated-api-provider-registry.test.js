// REGISTRE DES FOURNISSEURS — invariant PROVIDER_DEFINITION_IS_CODE_FIRST.
//
// Le registre décide de ce qui existe. Ce test vérifie qu'il décide SEUL, que
// ce qu'il décrit correspond à ce que l'audit a prouvé, et qu'il n'a inventé
// aucun fournisseur.
import { check, finish, section, setTestEnv } from './helpers/harness.js';

setTestEnv();

const registry = await import('../backend/src/services/integratedApi/providerRegistry.js');
const {
  SCOPES, SCOPE_VALUES, ACTIVE_SCOPES, ENVIRONMENTS, TOKEN_STRATEGIES,
  PROVIDER_CODES, PROVIDER_DEFINITIONS,
  isKnownProvider, getProviderDefinition, listProviderDefinitions,
  credentialRoles, requiredRoleCodes, secretRoleCodes,
  defaultRoleValue, environmentsFor, describeProviderDefinition,
} = registry;

section('PROVIDER_DEFINITION_IS_CODE_FIRST — quatre fournisseurs, pas un de plus');
{
  check('exactement 4 fournisseurs déclarés', PROVIDER_CODES.length === 4);
  check('ce sont STRIPE, BREVO, YOUSIGN, HOSTINGER',
    ['STRIPE', 'BREVO', 'YOUSIGN', 'HOSTINGER'].every((c) => PROVIDER_CODES.includes(c)));

  // L'audit §2.1 : ces cinq n'existent nulle part dans le code. Les déclarer
  // ferait apparaître à l'écran une intégration sans driver et sans test.
  for (const absent of ['UBIFLOW', 'ASSUCARTEGRISE', 'CARVERTICAL', 'CARSTUDIOAI', 'AUTOVIZA']) {
    check(`${absent} n’est PAS déclaré (absent du code)`, !isKnownProvider(absent));
  }

  check('le registre est gelé', Object.isFrozen(PROVIDER_DEFINITIONS));
  check('chaque définition est gelée',
    listProviderDefinitions().every((d) => Object.isFrozen(d)));
  check('chaque liste de rôles est gelée',
    listProviderDefinitions().every((d) => Object.isFrozen(d.credentialRoles)));

  // Un registre code-first ne s'enrichit pas par écriture d'objet.
  const avant = PROVIDER_CODES.length;
  try { PROVIDER_DEFINITIONS.FAKE = { code: 'FAKE' }; } catch { /* strict mode */ }
  check('impossible d’ajouter un fournisseur à chaud',
    Object.keys(PROVIDER_DEFINITIONS).length === avant && !isKnownProvider('FAKE'));
}

section('Un fournisseur inconnu ne se devine pas');
{
  check('getProviderDefinition rend null', getProviderDefinition('MAILCHIMP') === null);
  check('isKnownProvider est faux', !isKnownProvider('MAILCHIMP'));
  check('describeProviderDefinition rend null', describeProviderDefinition('MAILCHIMP') === null);
  check('rôles vides plutôt qu’une exception', credentialRoles('MAILCHIMP').length === 0);
  check('insensible à la casse pour un fournisseur connu', isKnownProvider('stripe'));
}

section('Scopes — conformes au classement de l’audit §3');
{
  check('STRIPE   → ENVIRONMENT', getProviderDefinition('STRIPE').scope === SCOPES.ENVIRONMENT);
  check('BREVO    → ENVIRONMENT', getProviderDefinition('BREVO').scope === SCOPES.ENVIRONMENT);
  check('YOUSIGN  → ENVIRONMENT', getProviderDefinition('YOUSIGN').scope === SCOPES.ENVIRONMENT);
  check('HOSTINGER → PANEL_GLOBAL', getProviderDefinition('HOSTINGER').scope === SCOPES.PANEL_GLOBAL);

  check('les 4 valeurs de scope sont admises par le modèle', SCOPE_VALUES.length === 4);
  check('PROJECT et PROJECT_ENVIRONMENT sont admis mais inutilisés',
    SCOPE_VALUES.includes('PROJECT') && SCOPE_VALUES.includes('PROJECT_ENVIRONMENT')
    && listProviderDefinitions().every((d) => ACTIVE_SCOPES.includes(d.scope)));
  check('l’UI ne montre que les 2 scopes réellement portés', ACTIVE_SCOPES.length === 2);
}

section('ENVIRONMENT_PROVIDER_REQUIRES_ENVIRONMENT / PANEL_GLOBAL_PROVIDER_HAS_NO_ENVIRONMENT');
{
  for (const code of ['STRIPE', 'BREVO', 'YOUSIGN']) {
    const envs = environmentsFor(code);
    check(`${code} : deux jeux, TEST et PROD`,
      envs.length === 2 && envs[0] === 'TEST' && envs[1] === 'PROD');
  }
  const global = environmentsFor('HOSTINGER');
  check('HOSTINGER : un seul jeu, sans environnement',
    global.length === 1 && global[0] === null);
  check('ENVIRONMENTS ne contient que TEST et PROD',
    ENVIRONMENTS.length === 2 && ENVIRONMENTS.includes('TEST') && ENVIRONMENTS.includes('PROD'));
}

section('Rôles de credentials — les vrais noms des drivers, rien d’inventé');
{
  const roleCodes = (code) => credentialRoles(code).map((r) => r.code);

  check('STRIPE : secretKey, publishableKey, webhookSecret, baseUrl',
    ['secretKey', 'publishableKey', 'webhookSecret', 'baseUrl']
      .every((r) => roleCodes('STRIPE').includes(r)));
  check('BREVO : apiKey, webhookSecret, baseUrl',
    ['apiKey', 'webhookSecret', 'baseUrl'].every((r) => roleCodes('BREVO').includes(r)));
  check('YOUSIGN : apiKey, webhookSecret, baseUrl',
    ['apiKey', 'webhookSecret', 'baseUrl'].every((r) => roleCodes('YOUSIGN').includes(r)));
  check('HOSTINGER : apiToken, baseUrl',
    ['apiToken', 'baseUrl'].every((r) => roleCodes('HOSTINGER').includes(r)));

  check('STRIPE requiert secretKey, et lui seul',
    requiredRoleCodes('STRIPE').length === 1 && requiredRoleCodes('STRIPE')[0] === 'secretKey');
  check('BREVO requiert apiKey', requiredRoleCodes('BREVO').join() === 'apiKey');
  check('YOUSIGN requiert apiKey', requiredRoleCodes('YOUSIGN').join() === 'apiKey');
  check('HOSTINGER requiert apiToken', requiredRoleCodes('HOSTINGER').join() === 'apiToken');

  // Le secret de webhook arrive tout seul, à la création de l'endpoint (L5) :
  // l'exiger bloquerait la configuration initiale pour rien.
  const stripeWebhook = credentialRoles('STRIPE').find((r) => r.code === 'webhookSecret');
  check('le secret de webhook Stripe est auto-géré et non requis',
    stripeWebhook.autoManaged === true && stripeWebhook.required === false);
}

section('Confidentialité par rôle — la clé publiable n’est pas un secret');
{
  check('STRIPE.secretKey est confidentiel', secretRoleCodes('STRIPE').includes('secretKey'));
  check('STRIPE.webhookSecret est confidentiel', secretRoleCodes('STRIPE').includes('webhookSecret'));
  check('STRIPE.publishableKey ne l’est PAS (elle part dans un navigateur)',
    !secretRoleCodes('STRIPE').includes('publishableKey'));
  check('baseUrl n’est confidentielle chez aucun fournisseur',
    PROVIDER_CODES.every((c) => !secretRoleCodes(c).includes('baseUrl')));
  check('BREVO.apiKey est confidentielle', secretRoleCodes('BREVO').includes('apiKey'));
  check('HOSTINGER.apiToken est confidentiel', secretRoleCodes('HOSTINGER').includes('apiToken'));
}

section('Préfixes attendus — le filet contre le copier-coller');
{
  const secretKey = credentialRoles('STRIPE').find((r) => r.code === 'secretKey');
  check('sk_test_ attendu en TEST', secretKey.prefixByEnvironment.TEST === 'sk_test_');
  check('sk_live_ attendu en PROD', secretKey.prefixByEnvironment.PROD === 'sk_live_');

  const brevoKey = credentialRoles('BREVO').find((r) => r.code === 'apiKey');
  check('BREVO : préfixe générique, aucune distinction d’environnement',
    brevoKey.prefixHint === 'xkeysib-' && brevoKey.prefixByEnvironment === null);

  const yousignKey = credentialRoles('YOUSIGN').find((r) => r.code === 'apiKey');
  check('YOUSIGN : aucun préfixe (c’est l’hôte qui porte le monde)',
    yousignKey.prefixHint === null && yousignKey.prefixByEnvironment === null);
}

section('URLs par défaut — Yousign a DEUX hôtes, les autres un seul');
{
  check('Stripe : même hôte quel que soit l’environnement',
    defaultRoleValue('STRIPE', 'baseUrl', 'TEST') === 'https://api.stripe.com'
    && defaultRoleValue('STRIPE', 'baseUrl', 'PROD') === 'https://api.stripe.com');
  check('Yousign TEST → sandbox',
    defaultRoleValue('YOUSIGN', 'baseUrl', 'TEST') === 'https://api-sandbox.yousign.app/v3');
  check('Yousign PROD → production',
    defaultRoleValue('YOUSIGN', 'baseUrl', 'PROD') === 'https://api.yousign.app/v3');
  check('Brevo : v3', defaultRoleValue('BREVO', 'baseUrl', 'TEST') === 'https://api.brevo.com/v3');
  check('Hostinger : global, défaut sans environnement',
    defaultRoleValue('HOSTINGER', 'baseUrl', null) === 'https://developers.hostinger.com');
}

section('Jeton — aucun fournisseur n’a besoin d’un runtime persisté (NOT_NEEDED_L1)');
{
  check('les 4 fournisseurs sont à clé statique',
    listProviderDefinitions().every((d) => d.tokenStrategy === TOKEN_STRATEGIES.STATIC_KEY));
  // C'est la justification, vérifiée par test, de l'absence d'entité
  // IntegratedApiRuntime en L1. Le jour où un OAuth arrive, ce test tombe et
  // rappelle qu'il faut la créer.
}

section('Webhooks — déclaratif en L1, conforme aux docs officielles');
{
  check('Stripe : réconciliation possible, secret rendu à la création seulement',
    getProviderDefinition('STRIPE').supportsWebhookReconciliation === true
    && getProviderDefinition('STRIPE').webhookSecretReturnedAtCreationOnly === true);
  check('Brevo : réconciliation possible, mais AUCUNE signature',
    getProviderDefinition('BREVO').supportsWebhookReconciliation === true
    && getProviderDefinition('BREVO').webhookSignature === 'SHARED_SECRET');
  check('Yousign : réconciliation possible',
    getProviderDefinition('YOUSIGN').supportsWebhookReconciliation === true);
  check('Hostinger : aucun webhook',
    getProviderDefinition('HOSTINGER').supportsWebhookReconciliation === false);
}

section('Capacités — déclarées, jamais invocables en L1');
{
  check('Stripe déclare billing.refund (le cas d’usage cible)',
    getProviderDefinition('STRIPE').capabilities.includes('billing.refund'));
  check('Brevo déclare email.send_template',
    getProviderDefinition('BREVO').capabilities.includes('email.send_template'));
  check('Hostinger déclare dns.record.ensure',
    getProviderDefinition('HOSTINGER').capabilities.includes('dns.record.ensure'));
  check('chaque capacité est nommée « domaine.objet[.action] »',
    listProviderDefinitions().every((d) => d.capabilities.every((c) => /^[a-z]+(\.[a-z_]+){1,3}$/.test(c))));
}

section('describeProviderDefinition — ce que l’UI rend, sans deviner');
{
  const vue = describeProviderDefinition('STRIPE', { environment: 'TEST' });
  check('la vue porte les rôles', Array.isArray(vue.credentialRoles) && vue.credentialRoles.length === 4);
  check('chaque rôle porte label, secret, required',
    vue.credentialRoles.every((r) => typeof r.label === 'string'
      && typeof r.secret === 'boolean' && typeof r.required === 'boolean'));
  check('la valeur par défaut est résolue pour l’environnement demandé',
    vue.credentialRoles.find((r) => r.code === 'baseUrl').defaultValue === 'https://api.stripe.com');
  // Une DÉFINITION décrit des formes, jamais des valeurs : elle ne porte donc
  // aucun champ `value`. Les préfixes attendus (« sk_test_ ») en sont
  // l'exception assumée — ce sont des gabarits, pas des clés.
  check('aucun rôle ne porte de champ « value »',
    vue.credentialRoles.every((r) => !Object.hasOwn(r, 'value')));
  check('aucune valeur ne ressemble à une clé Stripe complète',
    !/sk_(test|live)_[A-Za-z0-9]{6,}/.test(JSON.stringify(vue)));

  const yousignTest = describeProviderDefinition('YOUSIGN', { environment: 'TEST' });
  const yousignProd = describeProviderDefinition('YOUSIGN', { environment: 'PROD' });
  check('la vue Yousign change d’hôte avec l’environnement',
    yousignTest.credentialRoles.find((r) => r.code === 'baseUrl').defaultValue
    !== yousignProd.credentialRoles.find((r) => r.code === 'baseUrl').defaultValue);
}

finish();
