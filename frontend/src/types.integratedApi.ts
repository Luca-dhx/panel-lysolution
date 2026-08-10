// PLAN DE CONTRÔLE INTEGRATEDAPI — le contrat vu du navigateur (L1).
//
// Ces types décrivent EXACTEMENT ce que le backend rend. Ils n'ont pas de
// champ `value` pour un rôle confidentiel : ce n'est pas un oubli, c'est
// l'invariant. Une valeur confidentielle n'arrive jamais ici.

export type IntegratedApiScope =
  | 'PANEL_GLOBAL'
  | 'ENVIRONMENT'
  | 'PROJECT'
  | 'PROJECT_ENVIRONMENT';

export type IntegratedApiEnvironment = 'TEST' | 'PROD';

export type CredentialSetStatus = 'EMPTY' | 'CONFIGURED' | 'VALID' | 'INVALID' | 'ERROR';

/** Un rôle de credential, tel que le registre code-first le décrit. */
export interface CredentialRoleDefinition {
  code: string;
  label: string;
  /** Confidentiel : sa valeur ne descend jamais jusqu'ici. */
  secret: boolean;
  required: boolean;
  /** Renseigné par la machine (secret de webhook), jamais par un humain. */
  autoManaged: boolean;
  environmentScoped: boolean;
  prefixHint: string | null;
  prefixByEnvironment: Record<string, string> | null;
  hint: string | null;
  defaultValue: string | null;
}

export interface ProviderDefinition {
  provider: string;
  label: string;
  category: string;
  scope: IntegratedApiScope;
  tokenStrategy: 'STATIC_KEY' | 'OAUTH_REFRESH';
  supportsTest: boolean;
  supportsProd: boolean;
  supportsWebhookReconciliation: boolean;
  documentation: string | null;
  console: string | null;
  /** Prévues pour L3. Aucune n'est invocable aujourd'hui. */
  capabilities: string[];
  environments: Array<IntegratedApiEnvironment | null>;
  credentialRoles: CredentialRoleDefinition[];
}

/** L'état d'un rôle : renseigné ou non, et ce qu'on a le droit d'en montrer. */
export interface CredentialRoleState {
  configured: boolean;
  secret: boolean;
  fingerprint: string | null;
  /** « ••••••••4xK2 » pour un rôle confidentiel, `null` sinon. */
  maskedValue: string | null;
  /** La valeur EN CLAIR — uniquement pour un rôle public (clé publiable, URL). */
  value: string | null;
  defaultValue: string | null;
  updatedAt: string | null;
}

export interface CredentialSetView {
  credentialSetId: string | null;
  provider: string;
  scope: IntegratedApiScope;
  environment: IntegratedApiEnvironment | null;
  projectId: string | null;
  configured: boolean;
  status: CredentialSetStatus;
  storedStatus: CredentialSetStatus;
  /** Une preuve de validité qui ne porte plus sur la clé actuellement en place. */
  validationStale: boolean;
  lastValidatedAt: string | null;
  lastValidationCode: string | null;
  lastValidationMessage: string;
  lastValidationDurationMs: number | null;
  lastValidationDetails: Record<string, unknown> | null;
  credentials: Record<string, CredentialRoleState>;
  updatedAt: string | null;
}

export interface ProviderView {
  definition: ProviderDefinition;
  /** L'environnement que CETTE instance de Panel sert. Un constat. */
  runtimeEnvironment: IntegratedApiEnvironment;
  /** Celui qu'une action métier utiliserait ici. `null` pour un global. */
  effectiveEnvironment: IntegratedApiEnvironment | null;
  validatable: boolean;
  credentialSets: CredentialSetView[];
}

export interface ValidationOutcome {
  status: 'VALID' | 'INVALID' | 'ERROR';
  code: string;
  message: string;
  durationMs: number | null;
  details: Record<string, unknown> | null;
}

export type ValidatedCredentialSet = CredentialSetView & { validation: ValidationOutcome };

/* -------------------------------------------------------------------------- */
/*  PLAN DE CONTRÔLE WEBHOOK (L5)                                             */
/* -------------------------------------------------------------------------- */

export type WebhookStatus =
  | 'UNSUPPORTED'
  | 'PENDING'
  | 'RECONCILING'
  | 'READY'
  | 'DRIFTED'
  | 'WARNING'
  | 'ERROR';

/**
 * L'état d'un webhook, vu du navigateur.
 *
 * Il n'y a PAS de champ portant un secret, ni son masque, ni son empreinte —
 * `secretConfigured` est un booléen, et c'est tout ce dont un écran a besoin
 * pour dire « saurais-je vérifier un événement qui arrive maintenant ? ».
 *
 * `callbackUrl`, en revanche, s'affiche en clair : c'est une adresse publique
 * que le fournisseur connaît déjà, et la masquer empêcherait de la comparer à
 * ce que son tableau de bord montre.
 */
export interface WebhookStateView {
  provider: string;
  environment: IntegratedApiEnvironment;
  supported: boolean;
  status: WebhookStatus;
  /** Pourquoi ce fournisseur n'a pas de webhook. Rempli si `supported` est faux. */
  reason?: string | null;
  /** Une réconciliation antérieure s'est interrompue sans conclure. */
  interrupted?: boolean;
  signatureScheme: string;
  /** Faux pour un jeton partagé : authentifié, jamais prouvé. */
  signatureProves: boolean;
  secretDelivery: string;
  remoteEndpointLimit: number | null;
  callbackUrl: string;
  callbackReady?: boolean;
  callbackSource?: string;
  desiredUrl?: string;
  desiredEvents: string[];
  observedUrl?: string;
  observedEvents?: string[];
  remoteWebhookId?: string | null;
  drift: string[];
  secretConfigured: boolean;
  /** Le secret retiré est-il encore accepté ? Un booléen — jamais sa valeur. */
  secretRotationOpen?: boolean;
  secretRotatedAt?: string | null;
  /** Notre propre URL publique répond-elle ? `null` = jamais sondée. */
  callbackReachable?: boolean | null;
  callbackCheckedAt?: string | null;
  lastCheckedAt: string | null;
  lastReconciledAt: string | null;
  lastError: { code: string; message: string; at: string | null } | null;
  lastEventAt?: string | null;
  lastEventType?: string | null;
  eventsReceived?: number;
  duplicatesIgnored?: number;
  severity?: string;
}

export interface ProviderAvailability {
  provider: string;
  label: string;
  scope: IntegratedApiScope;
  environment: IntegratedApiEnvironment | null;
  runtimeEnvironment: IntegratedApiEnvironment;
  available: boolean;
  reason:
    | 'NOT_CONFIGURED'
    | 'NOT_VALIDATED'
    | 'VALIDATION_STALE'
    | 'INVALID_CREDENTIALS'
    | 'PROVIDER_UNREACHABLE'
    | null;
  lastValidatedAt: string | null;
  capabilities: string[];
  /** Toujours `false` en L1 — les capacités sont déclarées, pas invocables. */
  capabilitiesInvocable: boolean;
}

/**
 * UNE CAPACITÉ — ce qu'un projet peut DEMANDER (L3).
 *
 * À ne pas confondre avec `ProviderView`, qui décrit un FOURNISSEUR et ses
 * clés. Un fournisseur est un moyen ; une capacité est une intention. L'écran
 * les montre côte à côte précisément pour que la distinction se voie.
 */
export interface CapabilityView {
  code: string;
  label: string;
  provider: string;
  scope: string | null;
  /** Nature de l'effet réel — c'est elle que la politique d'ouverture lit. */
  effectNature: string | null;
  /** Branchée sur un adaptateur ? `false` = déclarée, pas encore servie. */
  migrated: boolean;
  invocable: boolean;
  idempotency: 'NONE' | 'SAFE_RETRY' | 'UNKNOWN_ON_TIMEOUT' | 'PROVIDER_IDEMPOTENT';
  timeoutMs: number;
  requiredPermissions: string[];
  /** Ce qui retient encore la migration. `null` si elle est faite. */
  migrationNote: string | null;
}

/** Une capacité, vue depuis un PROJET : accordée, et réellement effective ? */
export interface GrantedCapabilityView extends CapabilityView {
  granted: boolean;
  /**
   * Accordée ET servie. La distinction est nécessaire : accorder une capacité
   * non migrée ne casse rien, mais l'écran doit dire qu'elle refusera quand
   * même — sinon l'opérateur croit avoir ouvert un chemin qui reste fermé.
   */
  effective: boolean;
}

export interface CapabilityGrantsView {
  projectId: string;
  granted: string[];
  capabilities: GrantedCapabilityView[];
}

/* -------------------------------------------------------------------------- */
/*  OUVERTURE COMMERCIALE (L3.1)                                              */
/* -------------------------------------------------------------------------- */

export type CommercialState = 'PREOPENING' | 'LIVE';

export interface CommercialReadinessCheck {
  code: string;
  label: string;
  passed: boolean;
  detail: string | null;
}

/**
 * L'ouverture commerciale d'une instance — à côté de son environnement, jamais
 * fusionnée avec lui.
 *
 * `neverDecided` distingue « personne n'a tranché » de « quelqu'un a choisi la
 * pré-ouverture » : les deux se lisent PREOPENING, mais ne se réparent pas de
 * la même façon.
 */
export interface CommercialReadinessView {
  projectId: string | null;
  projectName: string | null;
  /** L'environnement TECHNIQUE. Affiché à côté, jamais confondu. */
  environment: IntegratedApiEnvironment | null;
  state: CommercialState;
  neverDecided: boolean;
  decidedAt: string | null;
  decidedBy: string | null;
  decisionReason: string | null;
  checks: CommercialReadinessCheck[];
  readyToGoLive: boolean;
  blockedInPreopening: Array<{ capability: string; effect: string }>;
}
