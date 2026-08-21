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

section('PROVIDER_DEFINITION_IS_CODE_FIRST — cinq fournisseurs, pas un de plus');
{
  check('exactement 5 fournisseurs déclarés', PROVIDER_CODES.length === 5);
  check('ce sont STRIPE, BREVO, YOUSIGN, OPENSIGN, HOSTINGER',
    ['STRIPE', 'BREVO', 'YOUSIGN', 'OPENSIGN', 'HOSTINGER'].every((c) => PROVIDER_CODES.includes(c)));
  /**
   * DEUX FOURNISSEURS DE SIGNATURE, ET C'EST L'ÉTAT NORMAL PENDANT LA
   * MIGRATION.
   *
   * Yousign reste déclaré, avec ses rôles et ses capacités, tant qu'OpenSign
   * n'est pas prouvé de bout en bout. Le retirer maintenant supprimerait le
   * seul chemin de signature qui fonctionne — et il faudrait le réécrire pour
   * revenir en arrière.
   */
  check('YOUSIGN reste déclaré à côté d’OPENSIGN',
    getProviderDefinition('YOUSIGN') !== null && getProviderDefinition('OPENSIGN') !== null);
  check('les deux sont de catégorie SIGNATURE',
    getProviderDefinition('YOUSIGN').category === 'SIGNATURE'
    && getProviderDefinition('OPENSIGN').category === 'SIGNATURE');

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
  // OpenSign émet DEUX jetons (Sandbox / Live) sur DEUX hôtes, et documente
  // qu'ils ne sont pas interchangeables : la portée est imposée, pas choisie.
  check('OPENSIGN → ENVIRONMENT', getProviderDefinition('OPENSIGN').scope === SCOPES.ENVIRONMENT);
  check('HOSTINGER → PANEL_GLOBAL', getProviderDefinition('HOSTINGER').scope === SCOPES.PANEL_GLOBAL);

  check('les 4 valeurs de scope sont admises par le modèle', SCOPE_VALUES.length === 4);
  check('PROJECT et PROJECT_ENVIRONMENT sont admis mais inutilisés',
    SCOPE_VALUES.includes('PROJECT') && SCOPE_VALUES.includes('PROJECT_ENVIRONMENT')
    && listProviderDefinitions().every((d) => ACTIVE_SCOPES.includes(d.scope)));
  check('l’UI ne montre que les 2 scopes réellement portés', ACTIVE_SCOPES.length === 2);
}

section('ENVIRONMENT_PROVIDER_REQUIRES_ENVIRONMENT / PANEL_GLOBAL_PROVIDER_HAS_NO_ENVIRONMENT');
{
  /**
   * YOUSIGN A QUITTÉ CETTE BOUCLE avec ses mondes.
   *
   * Un fournisseur RETIRÉ ne déclare plus `supportsTest` ni `supportsProd` :
   * il n'y a plus deux jeux de credentials à tenir, puisqu'il n'y en a plus un
   * seul. Exiger « deux jeux » de lui reviendrait à exiger qu'on lui garde une
   * place au coffre.
   */
  for (const code of ['STRIPE', 'BREVO', 'OPENSIGN']) {
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
  /**
   * LE FOURNISSEUR RETIRÉ N'A PLUS AUCUN RÔLE — et c'est le contrôle qui compte.
   *
   * Ce contrôle exigeait `apiKey, webhookSecret, baseUrl`. Il décrivait ce
   * qu'il fallait saisir pour s'en servir ; on ne s'en sert plus, et un rôle
   * qui subsiste, c'est un champ de saisie dans l'interface — donc une
   * invitation à recoller une clé pour un fournisseur qui ne répond plus.
   */
  check('YOUSIGN (retiré) ne déclare AUCUN rôle de credential',
    roleCodes('YOUSIGN').length === 0);
  check('OPENSIGN : apiToken, webhookSecret, baseUrl',
    ['apiToken', 'webhookSecret', 'baseUrl'].every((r) => roleCodes('OPENSIGN').includes(r)));
  // `apiToken` et non `apiKey` : c'est le nom du fournisseur (`x-api-token`).
  check('OPENSIGN n’expose PAS de rôle « apiKey »', !roleCodes('OPENSIGN').includes('apiKey'));
  check('HOSTINGER : apiToken, baseUrl',
    ['apiToken', 'baseUrl'].every((r) => roleCodes('HOSTINGER').includes(r)));

  check('STRIPE requiert secretKey, et lui seul',
    requiredRoleCodes('STRIPE').length === 1 && requiredRoleCodes('STRIPE')[0] === 'secretKey');
  check('BREVO requiert apiKey', requiredRoleCodes('BREVO').join() === 'apiKey');
  check('YOUSIGN (retiré) n’exige rien — il n’y a plus rien à exiger',
    requiredRoleCodes('YOUSIGN').length === 0);
  check('OPENSIGN requiert apiToken', requiredRoleCodes('OPENSIGN').join() === 'apiToken');
  check('HOSTINGER requiert apiToken', requiredRoleCodes('HOSTINGER').join() === 'apiToken');

  // Le secret de webhook arrive tout seul, à la création de l'endpoint (L5) :
  // l'exiger bloquerait la configuration initiale pour rien.
  const stripeWebhook = credentialRoles('STRIPE').find((r) => r.code === 'webhookSecret');
  check('le secret de webhook Stripe est auto-géré et non requis',
    stripeWebhook.autoManaged === true && stripeWebhook.required === false);
  const brevoWebhook = credentialRoles('BREVO').find((r) => r.code === 'webhookSecret');
  check('le jeton webhook Brevo est lui aussi auto-géré et non requis',
    brevoWebhook.autoManaged === true && brevoWebhook.required === false);

  /**
   * OPENSIGN EST L'EXCEPTION, ET ELLE DOIT ÊTRE VÉRIFIÉE.
   *
   * Chez les trois autres, le secret de webhook « arrive tout seul ». Chez
   * OpenSign il n'arrive JAMAIS par l'API : il se génère dans la console. Le
   * marquer `autoManaged` afficherait « arrive tout seul » sous un champ que
   * personne ne remplirait — et le webhook resterait sourd en silence.
   */
  const openSignWebhook = credentialRoles('OPENSIGN').find((r) => r.code === 'webhookSecret');
  check('la clé de webhook OpenSign n’est PAS auto-gérée (console uniquement)',
    openSignWebhook.autoManaged === false && openSignWebhook.required === false);
  check('elle est marquée « vérification seule » — elle ne sait rien appeler',
    openSignWebhook.verificationOnly === true);
  check('son aide dit OÙ la trouver, puisque l’API ne la rend pas',
    typeof openSignWebhook.hint === 'string' && /console/i.test(openSignWebhook.hint));
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

  /**
   * LE RÔLE `apiKey` DE YOUSIGN N'EXISTE PLUS — il n'y a donc plus de préfixe
   * à attendre. Ce qui était éprouvé ici (le monde porté par l'HÔTE et non par
   * la clé) l'est désormais sur OpenSign, qui a la même topologie.
   */
  const openSignJeton = credentialRoles('OPENSIGN').find((r) => r.code === 'apiToken');
  check('OPENSIGN : aucun préfixe (c’est l’hôte qui porte le monde)',
    openSignJeton.prefixHint === null && openSignJeton.prefixByEnvironment === null);
}

section('URLs par défaut — OpenSign a DEUX hôtes, les autres un seul');
{
  check('Stripe : même hôte quel que soit l’environnement',
    defaultRoleValue('STRIPE', 'baseUrl', 'TEST') === 'https://api.stripe.com'
    && defaultRoleValue('STRIPE', 'baseUrl', 'PROD') === 'https://api.stripe.com');
  /**
   * LES HÔTES DE YOUSIGN ONT DISPARU AVEC SON RÔLE `baseUrl`.
   *
   * Ils étaient la dernière chose du Panel qui savait où le joindre. Les
   * vérifier encore reviendrait à exiger qu'on garde l'adresse.
   */
  check('YOUSIGN (retiré) ne propose plus aucune URL',
    defaultRoleValue('YOUSIGN', 'baseUrl', 'TEST') === null
    && defaultRoleValue('YOUSIGN', 'baseUrl', 'PROD') === null);
  check('OpenSign TEST → sandbox',
    defaultRoleValue('OPENSIGN', 'baseUrl', 'TEST') === 'https://sandbox.opensignlabs.com/api/v1.2');
  /**
   * LE CHOIX `app` PLUTÔT QUE `eu-app` EST DOCUMENTÉ, DONC IL SE TESTE.
   *
   * `eu-app.opensignlabs.com` n'est pas un alias de routage : c'est un tenant
   * distinct, avec ses propres comptes et ses propres jetons. Basculer dessus
   * n'est pas un réglage d'exploitation mais un changement de compte — et ce
   * test est ce qui garantit que la bascule sera une modification VUE, revue et
   * datée, jamais une valeur qu'on découvre après coup dans une base.
   */
  check('OpenSign PROD → app (et non eu-app : décision documentée)',
    defaultRoleValue('OPENSIGN', 'baseUrl', 'PROD') === 'https://app.opensignlabs.com/api/v1.2');
  check('Brevo : v3', defaultRoleValue('BREVO', 'baseUrl', 'TEST') === 'https://api.brevo.com/v3');
  check('Hostinger : global, défaut sans environnement',
    defaultRoleValue('HOSTINGER', 'baseUrl', null) === 'https://developers.hostinger.com');
}

section('Jeton — aucun fournisseur n’a besoin d’un runtime persisté (NOT_NEEDED_L1)');
{
  check('tous les fournisseurs sont à clé statique',
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
  /**
   * YOUSIGN NE RÉCONCILIE PLUS RIEN — il n'a plus de secret pour signer.
   *
   * Un descripteur qui annoncerait encore la réconciliation décrirait une garde
   * qui n'existe plus : le réconciliateur irait chercher une clé supprimée, et
   * conclurait « en panne » là où la vérité est « retiré ».
   */
  check('Yousign (retiré) : plus aucune réconciliation',
    getProviderDefinition('YOUSIGN').supportsWebhookReconciliation === false);
  check('…et il est marqué comme tel, avec sa date',
    getProviderDefinition('YOUSIGN').retired === true
    && typeof getProviderDefinition('YOUSIGN').retiredAt === 'string');
  /**
   * OPENSIGN SIGNE, MAIS NE LIVRE PAS SON SECRET — les deux à la fois.
   *
   * Le confondre avec Stripe ou Yousign (`webhookSecretReturnedAtCreationOnly:
   * true`) ferait recréer l'endpoint en boucle pour capturer une valeur qui
   * n'arrive jamais — sur une ressource qui, chez OpenSign, est UNIQUE par
   * compte : chaque passage écraserait l'URL en place.
   */
  check('OpenSign : réconciliation possible',
    getProviderDefinition('OPENSIGN').supportsWebhookReconciliation === true);
  check('OpenSign : le secret n’est PAS rendu à la création (console uniquement)',
    getProviderDefinition('OPENSIGN').webhookSecretReturnedAtCreationOnly === false);
  check('OpenSign : la signature est un vrai HMAC, pas un jeton partagé',
    getProviderDefinition('OPENSIGN').webhookSignature === 'HMAC_SHA256');
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
  /**
   * LE NOM MÉTIER NE PORTE JAMAIS LE NOM DU FOURNISSEUR.
   *
   * OpenSign déclare EXACTEMENT les mêmes codes que Yousign. C'est l'invariant
   * qui rend la migration invisible depuis les projets : SB Auto appelle
   * `signature.request.open`, et n'apprend jamais qui l'exécute. Un
   * `opensign.request.open` aurait fait fuiter le fournisseur dans le contrat
   * métier — et rendu la bascule impossible sans toucher au projet.
   */
  check('OpenSign déclare les MÊMES capacités que Yousign, aux mêmes noms',
    JSON.stringify([...getProviderDefinition('OPENSIGN').capabilities].sort())
    === JSON.stringify([...getProviderDefinition('YOUSIGN').capabilities].sort()));
  check('aucune capacité ne porte le nom d’un fournisseur',
    listProviderDefinitions().every((d) => d.capabilities.every(
      (c) => !/opensign|yousign|stripe|brevo|hostinger/i.test(c))));
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

  /**
   * LA VUE D'UN FOURNISSEUR À DEUX HÔTES — éprouvée sur celui qui SERT.
   *
   * Ce contrôle portait sur Yousign : il vérifiait que l'écran propose un hôte
   * différent selon le monde. Le fournisseur est retiré et n'expose plus aucun
   * rôle ; la règle, elle, vaut toujours, et OpenSign a la même topologie.
   */
  const openSignTest = describeProviderDefinition('OPENSIGN', { environment: 'TEST' });
  const openSignProd = describeProviderDefinition('OPENSIGN', { environment: 'PROD' });
  check('la vue OpenSign change d’hôte avec l’environnement',
    openSignTest.credentialRoles.find((r) => r.code === 'baseUrl').defaultValue
    !== openSignProd.credentialRoles.find((r) => r.code === 'baseUrl').defaultValue);

  /**
   * ET LA VUE DU RETIRÉ NE PROPOSE PLUS RIEN À SAISIR.
   *
   * C'est ce qui empêche l'écran d'afficher un formulaire pour un fournisseur
   * qui ne répond plus — et donc d'inviter quelqu'un à y coller une clé.
   */
  const vueRetire = describeProviderDefinition('YOUSIGN', { environment: 'TEST' });
  check('la vue du fournisseur retiré est vide de tout champ',
    vueRetire.credentialRoles.length === 0);
}

finish();
