// REGISTRE DES FOURNISSEURS — L1 du plan de contrôle IntegratedAPI.
//
// docs/architecture/INTEGRATED_API_CONTROL_PLANE_ROADMAP.md §2, §3, §4.2.
//
// ── CODE-FIRST, ET C'EST UN INVARIANT ───────────────────────────────────────
//
// Ce fichier EST la source de vérité des fournisseurs supportés. Rien en base
// ne peut en ajouter, en retirer, ni en modifier un. La raison n'est pas
// esthétique : un registre modifiable depuis Mongo permettrait de déclarer un
// fournisseur sans driver, sans validation et sans test — l'interface
// afficherait une intégration qui n'existe pas, et un opérateur y saisirait
// une vraie clé.
//
// Ajouter un fournisseur = ajouter une entrée ICI, plus un validateur.
//
// ── CE QUE CE REGISTRE N'EST PAS ────────────────────────────────────────────
//
// Il ne contient AUCUNE valeur de credential, AUCUNE URL de webhook réelle,
// AUCUN secret. Il décrit des FORMES : quels rôles existent, lesquels sont
// requis, lesquels sont confidentiels, quelle est l'URL par défaut.
//
// ── PÉRIMÈTRE L1 ────────────────────────────────────────────────────────────
//
// Les quatre fournisseurs ci-dessous sont les seuls PROUVÉS par le code (audit
// §2.1). Ubiflow, AssuCarteGrise, CarVertical, Car Studio AI et Autoviza
// n'existent nulle part : ils ne sont pas déclarés ici.
//
// `capabilities[]` et `webhook` sont DÉCLARATIFS en L1 — ils préparent L3
// (passerelle de capacités) et L5 (registre de webhooks). Aucune capacité
// n'est invocable, aucun webhook n'est créé dans ce lot.

/* -------------------------------------------------------------------------- */
/*  SCOPES                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Portée d'un jeu d'identifiants — « combien de comptes fournisseur
 * l'entreprise détient-elle réellement ? ».
 *
 * Les quatre valeurs sont admises par le modèle dès L1 (décision D5 de
 * l'audit) pour qu'un fournisseur futur n'impose pas une migration de schéma.
 * Seules les deux premières sont utilisées aujourd'hui, et seules elles sont
 * exposées par l'interface.
 */
export const SCOPES = Object.freeze({
  /** Un seul jeu pour toute la plateforme, quel que soit l'environnement. */
  PANEL_GLOBAL: 'PANEL_GLOBAL',
  /** Un jeu par environnement (TEST, PROD). Le cas courant. */
  ENVIRONMENT: 'ENVIRONMENT',
  /** Un jeu par projet — aucun fournisseur actuel ne l'impose. */
  PROJECT: 'PROJECT',
  /** Un jeu par projet ET par environnement — aucun fournisseur actuel. */
  PROJECT_ENVIRONMENT: 'PROJECT_ENVIRONMENT',
});

export const SCOPE_VALUES = Object.freeze(Object.values(SCOPES));

/** Scopes réellement portés par un fournisseur déclaré — ceux que l'UI montre. */
export const ACTIVE_SCOPES = Object.freeze([SCOPES.PANEL_GLOBAL, SCOPES.ENVIRONMENT]);

/** Les deux environnements. Un Panel n'en sert qu'un (audit §7). */
export const ENVIRONMENTS = Object.freeze(['TEST', 'PROD']);

/**
 * Stratégie de jeton d'un fournisseur.
 *
 * `STATIC_KEY` : la clé est le jeton. Rien à rafraîchir, rien à persister en
 * plus du credential set.
 *
 * Les quatre fournisseurs actuels sont tous `STATIC_KEY` — d'où l'absence
 * d'entité `IntegratedApiRuntime` en L1 (audit §4.2, phase 7 : NOT_NEEDED_L1).
 */
export const TOKEN_STRATEGIES = Object.freeze({
  STATIC_KEY: 'STATIC_KEY',
  OAUTH_REFRESH: 'OAUTH_REFRESH',
});

/* -------------------------------------------------------------------------- */
/*  DÉFINITIONS                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Un rôle de credential.
 *
 * `secret: true`  → la valeur ne sort JAMAIS d'ici. L'API renvoie au mieux
 *                   une empreinte et les quatre derniers caractères.
 * `secret: false` → valeur publique par nature (clé publiable, URL de base).
 *                   Lisible dans l'interface, parce que la masquer
 *                   n'apporterait rien et empêcherait de la vérifier.
 *
 * `autoManaged`   → renseigné par la machine, pas par un humain (le secret de
 *                   webhook Stripe n'est rendu qu'à la création de l'endpoint).
 *                   Jamais requis : il arrive tout seul, en L5.
 *
 * `internal`      → le rôle vit dans le coffre, mais n'apparaît dans AUCUNE
 *                   vue : ni formulaire, ni réponse d'API. Réservé aux valeurs
 *                   qu'un humain ne doit ni saisir ni voir exister — le secret
 *                   de webhook RETIRÉ, gardé quelques minutes le temps que les
 *                   événements en vol se vident (L5.1). L'afficher n'aurait
 *                   aucun usage et offrirait un second endroit où se tromper.
 *
 * `defaultValue`  → proposé, pas imposé. Une valeur stockée l'emporte toujours.
 */
function role(code, label, options = {}) {
  return Object.freeze({
    code,
    label,
    secret: options.secret !== false,
    required: options.required === true,
    autoManaged: options.autoManaged === true,
    internal: options.internal === true,
    /** Le rôle porte-t-il une valeur différente par environnement ? */
    environmentScoped: options.environmentScoped !== false,
    /** Préfixe attendu, par environnement — détecte une clé live saisie en TEST. */
    prefixByEnvironment: options.prefixByEnvironment
      ? Object.freeze({ ...options.prefixByEnvironment })
      : null,
    /** Indication générique de préfixe, quand l'environnement ne le distingue pas. */
    prefixHint: options.prefixHint ?? null,
    defaultValue: options.defaultValue ?? null,
    hint: options.hint ?? null,
  });
}

/** Valeur par défaut d'un rôle qui dépend de l'environnement (Yousign). */
function environmentDefault(byEnvironment) {
  return Object.freeze({ ...byEnvironment });
}

export const PROVIDER_DEFINITIONS = Object.freeze({
  STRIPE: Object.freeze({
    code: 'STRIPE',
    label: 'Stripe',
    category: 'PAYMENT',
    scope: SCOPES.ENVIRONMENT,
    tokenStrategy: TOKEN_STRATEGIES.STATIC_KEY,
    supportsTest: true,
    supportsProd: true,
    /**
     * `/v1/webhook_endpoints` offre le CRUD complet et le secret n'est rendu
     * QU'À LA CRÉATION. Plafond documenté : 16 endpoints par compte et par
     * mode — c'est ce qui rend la centralisation nécessaire (audit §8.2).
     */
    supportsWebhookReconciliation: true,
    webhookSecretReturnedAtCreationOnly: true,
    documentation: 'https://docs.stripe.com/api/webhook_endpoints',
    console: 'https://dashboard.stripe.com/apikeys',
    /** Capacités PRÉVUES (L3). Aucune n'est invocable en L1. */
    capabilities: Object.freeze([
      'billing.customer.ensure',
      // L6.2E — le tarif d'un contrat : Product + Price, une seule capacité.
      'billing.price.ensure',
      'billing.checkout.create',
      // L6.2C — la lecture d'une session, servie dès lors que l'appartenance
      // de la ressource est prouvable (elle l'est depuis L6.2B).
      'billing.checkout.retrieve',
      'billing.subscription.cancel_at_period_end',
      'billing.subscription.reconcile',
      'billing.invoice.list',
      'billing.refund',
    ]),
    credentialRoles: Object.freeze([
      role('secretKey', 'Clé secrète', {
        secret: true,
        required: true,
        prefixByEnvironment: { TEST: 'sk_test_', PROD: 'sk_live_' },
      }),
      role('publishableKey', 'Clé publiable', {
        // Elle est conçue pour être servie à un navigateur : la masquer
        // n'apporterait aucune sécurité et empêcherait de la relire.
        secret: false,
        required: false,
        prefixByEnvironment: { TEST: 'pk_test_', PROD: 'pk_live_' },
      }),
      role('webhookSecret', 'Secret de signature webhook', {
        secret: true,
        required: false,
        autoManaged: true,
        prefixHint: 'whsec_',
        hint: 'Capturé automatiquement à la création de l’endpoint (L5). Stripe ne le rend qu’une fois.',
      }),
      role('webhookSecretPrevious', 'Secret de webhook retiré', {
        secret: true,
        required: false,
        autoManaged: true,
        internal: true,
        prefixHint: 'whsec_',
        hint: 'Conservé quelques minutes après une rotation, le temps que les événements déjà en vol se vident.',
      }),
      role('baseUrl', 'URL de base de l’API', {
        secret: false,
        required: false,
        defaultValue: 'https://api.stripe.com',
      }),
    ]),
  }),

  BREVO: Object.freeze({
    code: 'BREVO',
    label: 'Brevo',
    category: 'EMAIL',
    scope: SCOPES.ENVIRONMENT,
    tokenStrategy: TOKEN_STRATEGIES.STATIC_KEY,
    supportsTest: true,
    supportsProd: true,
    /**
     * `/v3/webhooks` offre le CRUD. Mais Brevo ne signe RIEN : l'authenticité
     * d'un appel entrant repose sur un secret partagé que NOUS posons, et sur
     * une allowlist d'IP. Un webhook Brevo n'est jamais prouvé
     * cryptographiquement — seulement authentifié (audit §8.2, note 2).
     */
    supportsWebhookReconciliation: true,
    webhookSecretReturnedAtCreationOnly: false,
    webhookSignature: 'SHARED_SECRET',
    documentation: 'https://developers.brevo.com/reference/createwebhook',
    console: 'https://app.brevo.com',
    capabilities: Object.freeze([
      'email.send_template',
      'email.sender.verify',
    ]),
    credentialRoles: Object.freeze([
      role('apiKey', 'Clé API', {
        secret: true,
        required: true,
        prefixHint: 'xkeysib-',
        // Un compte Brevo TEST et un compte PROD sont deux comptes distincts :
        // la clé ne porte donc aucune marque d'environnement.
      }),
      role('webhookSecret', 'Secret partagé du webhook', {
        secret: true,
        required: false,
        hint: 'Ce n’est pas une signature : Brevo renvoie l’en-tête que nous lui donnons.',
      }),
      /**
       * C'est NOUS qui posons le jeton Brevo : la rotation ne recrée donc pas
       * l'endpoint, elle le met à jour. Mais les appels DÉJÀ EN VOL portent
       * encore l'ancien jeton — sans ce rôle, ils repartent en 401 et leurs
       * événements sont perdus définitivement (audit L8, exigence nº6).
       */
      role('webhookSecretPrevious', 'Jeton de webhook retiré', {
        secret: true,
        required: false,
        autoManaged: true,
        internal: true,
        hint: 'Accepté quelques minutes après une rotation, puis effacé.',
      }),
      role('baseUrl', 'URL de base de l’API', {
        secret: false,
        required: false,
        defaultValue: 'https://api.brevo.com/v3',
      }),
    ]),
  }),

  YOUSIGN: Object.freeze({
    code: 'YOUSIGN',
    label: 'Yousign',
    category: 'SIGNATURE',
    scope: SCOPES.ENVIRONMENT,
    tokenStrategy: TOKEN_STRATEGIES.STATIC_KEY,
    supportsTest: true,
    supportsProd: true,
    supportsWebhookReconciliation: true,
    webhookSecretReturnedAtCreationOnly: true,
    documentation: 'https://developers.youtrust.com/docs/webhooks',
    console: 'https://yousign.app',
    /**
     * Yousign est devenu Youtrust en juillet 2026 et `developers.yousign.com`
     * redirige. Les hôtes d'API ci-dessous restent ceux que le code du projet
     * utilise en production ; ils sont stockés en base et ÉDITABLES, ce qui
     * contient le risque. Vérification en prérequis de L7 (audit §16, R5).
     */
    rebrandWatch: 'Yousign → Youtrust (2026-07) : hôtes d’API à revérifier avant L7.',
    capabilities: Object.freeze([
      'signature.request.create',
      'signature.document.download',
    ]),
    credentialRoles: Object.freeze([
      role('apiKey', 'Clé API', { secret: true, required: true }),
      role('webhookSecret', 'Secret de signature webhook', {
        secret: true,
        required: false,
        autoManaged: true,
        hint: 'Rendu à la création de la souscription (L5).',
      }),
      role('webhookSecretPrevious', 'Secret de webhook retiré', {
        secret: true,
        required: false,
        autoManaged: true,
        internal: true,
        hint: 'Conservé quelques minutes après une recréation, le temps que les événements en vol se vident.',
      }),
      role('baseUrl', 'URL de base de l’API', {
        secret: false,
        required: false,
        // Deux HÔTES distincts : la séparation est imposée par le fournisseur.
        defaultValue: environmentDefault({
          TEST: 'https://api-sandbox.yousign.app/v3',
          PROD: 'https://api.yousign.app/v3',
        }),
      }),
    ]),
  }),

  HOSTINGER: Object.freeze({
    code: 'HOSTINGER',
    label: 'Hostinger',
    category: 'HOSTING',
    /**
     * Un seul portefeuille de domaines, une seule clé, aucun sandbox
     * documenté. Le DNS d'un domaine de recette et celui d'un domaine de
     * production vivent dans le même compte : les séparer inventerait une
     * distinction que le fournisseur n'a pas (audit §3).
     */
    scope: SCOPES.PANEL_GLOBAL,
    tokenStrategy: TOKEN_STRATEGIES.STATIC_KEY,
    supportsTest: false,
    supportsProd: false,
    supportsWebhookReconciliation: false,
    documentation: 'https://developers.hostinger.com',
    console: 'https://hpanel.hostinger.com/profile/api',
    /**
     * Les trois verbes, dans l'ordre où le moteur de déploiement les emploie :
     * il PLANIFIE avec les deux lectures, puis MUTE. Le lot L9 n'en déclarait
     * qu'un — l'audit avait supposé que le Panel serait son propre appelant, ce
     * qui était faux : le consommateur réel est un projet, et il a besoin des
     * trois.
     */
    capabilities: Object.freeze(['dns.zone.resolve', 'dns.records.read', 'dns.record.ensure']),
    credentialRoles: Object.freeze([
      role('apiToken', 'Jeton d’API', {
        secret: true,
        required: true,
        environmentScoped: false,
      }),
      role('baseUrl', 'URL de base de l’API', {
        secret: false,
        required: false,
        environmentScoped: false,
        defaultValue: 'https://developers.hostinger.com',
      }),
    ]),
  }),
});

export const PROVIDER_CODES = Object.freeze(Object.keys(PROVIDER_DEFINITIONS));

/* -------------------------------------------------------------------------- */
/*  ACCÈS                                                                     */
/* -------------------------------------------------------------------------- */

/** Un fournisseur est-il déclaré ? */
export function isKnownProvider(code) {
  return typeof code === 'string' && Object.hasOwn(PROVIDER_DEFINITIONS, code.toUpperCase());
}

/**
 * Définition d'un fournisseur, ou `null`. Volontairement tolérant : l'appelant
 * décide si l'absence est une erreur (`getProviderDefinitionOrThrow`) ou un cas
 * normal (une liste filtrée).
 */
export function getProviderDefinition(code) {
  if (!isKnownProvider(code)) return null;
  return PROVIDER_DEFINITIONS[String(code).toUpperCase()];
}

/** Tous les fournisseurs, dans un ordre STABLE — celui des écrans et des rapports. */
export function listProviderDefinitions() {
  return PROVIDER_CODES.map((code) => PROVIDER_DEFINITIONS[code]);
}

/** Rôles d'un fournisseur (tableau vide si inconnu). */
export function credentialRoles(code) {
  return getProviderDefinition(code)?.credentialRoles ?? [];
}

/** Un rôle nommé, ou `null`. */
export function credentialRole(code, roleCode) {
  return credentialRoles(code).find((r) => r.code === roleCode) ?? null;
}

/** Codes des rôles REQUIS pour qu'un jeu soit considéré « configuré ». */
export function requiredRoleCodes(code) {
  return credentialRoles(code).filter((r) => r.required).map((r) => r.code);
}

/** Codes des rôles confidentiels — ceux dont la valeur ne sort jamais. */
export function secretRoleCodes(code) {
  return credentialRoles(code).filter((r) => r.secret).map((r) => r.code);
}

/**
 * Rôles ADMINISTRABLES — ceux qu'une interface montre et qu'un humain remplit.
 *
 * Les rôles `internal` en sont exclus : ils vivent dans le coffre parce que le
 * plan de contrôle en a besoin, pas parce qu'un opérateur doit les connaître.
 * Les exposer ajouterait un champ que personne ne doit remplir — donc un
 * champ que quelqu'un finira par remplir.
 */
export function administrableRoles(code) {
  return credentialRoles(code).filter((r) => !r.internal);
}

/**
 * Valeur par défaut d'un rôle pour un environnement donné.
 * `defaultValue` peut être une chaîne (même valeur partout) ou une table par
 * environnement (Yousign, dont les hôtes diffèrent).
 */
export function defaultRoleValue(code, roleCode, environment = null) {
  const definition = credentialRole(code, roleCode);
  if (!definition || definition.defaultValue === null) return null;
  if (typeof definition.defaultValue === 'string') return definition.defaultValue;
  if (!environment) return null;
  return definition.defaultValue[environment] ?? null;
}

/**
 * Environnements à provisionner pour un fournisseur.
 * `PANEL_GLOBAL` → `[null]` : un seul jeu, sans environnement.
 */
export function environmentsFor(code) {
  const definition = getProviderDefinition(code);
  if (!definition) return [];
  return definition.scope === SCOPES.ENVIRONMENT ? [...ENVIRONMENTS] : [null];
}

/**
 * Vue publique d'une définition — ce que l'API rend au frontend.
 *
 * L'interface ne devine JAMAIS les champs d'un fournisseur : elle rend ce
 * tableau. C'est ce qui garantit qu'ajouter un rôle dans ce fichier suffit à
 * le faire apparaître à l'écran, sans toucher au React.
 */
export function describeProviderDefinition(code, { environment = null } = {}) {
  const definition = getProviderDefinition(code);
  if (!definition) return null;
  return {
    provider: definition.code,
    label: definition.label,
    category: definition.category,
    scope: definition.scope,
    tokenStrategy: definition.tokenStrategy,
    supportsTest: definition.supportsTest,
    supportsProd: definition.supportsProd,
    supportsWebhookReconciliation: definition.supportsWebhookReconciliation,
    documentation: definition.documentation,
    console: definition.console,
    capabilities: [...definition.capabilities],
    environments: environmentsFor(definition.code),
    // Les rôles `internal` ne descendent JAMAIS jusqu'ici : ils n'ont pas de
    // formulaire, donc pas de vue.
    credentialRoles: administrableRoles(definition.code).map((r) => ({
      code: r.code,
      label: r.label,
      secret: r.secret,
      required: r.required,
      autoManaged: r.autoManaged,
      environmentScoped: r.environmentScoped,
      prefixHint: r.prefixHint,
      prefixByEnvironment: r.prefixByEnvironment,
      hint: r.hint,
      defaultValue: defaultRoleValue(definition.code, r.code, environment),
    })),
  };
}

export default {
  SCOPES,
  SCOPE_VALUES,
  ACTIVE_SCOPES,
  ENVIRONMENTS,
  TOKEN_STRATEGIES,
  PROVIDER_DEFINITIONS,
  PROVIDER_CODES,
  isKnownProvider,
  getProviderDefinition,
  listProviderDefinitions,
  credentialRoles,
  credentialRole,
  requiredRoleCodes,
  secretRoleCodes,
  administrableRoles,
  defaultRoleValue,
  environmentsFor,
  describeProviderDefinition,
};
