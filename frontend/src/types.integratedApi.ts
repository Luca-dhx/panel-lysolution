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
