// Types de la surface de DÉPLOIEMENT (/api/deployment) — Phase 4.
//
// Remarque qui se lit dans les types : `sshPassword` n'apparaît que dans les
// types de REQUÊTE, jamais dans un type de réponse. Le mot de passe monte,
// il ne redescend jamais.

export type DeploymentState = 'NEW' | 'DEPLOYING' | 'DEPLOYED' | 'FAILED';
export type RunStatus = 'running' | 'ok' | 'warning' | 'error' | 'interrupted';
export type OperationType =
  | 'CONNECTION_TEST' | 'PRECHECK' | 'SIMULATION' | 'DEPLOYMENT' | 'ROLLBACK'
  | 'DEPROVISION' | 'DESTINATION_DELETE';

/**
 * CYCLE DE VIE d'une destination — distinct de `DeploymentState`.
 *
 * `DeploymentState` dit comment s'est passé le dernier déploiement.
 * `LifecycleStatus` dit ce que la destination OCCUPE encore sur le serveur —
 * et c'est lui, et lui seul, qui autorise une suppression.
 */
export type LifecycleStatus =
  | 'ACTIVE' | 'DEPROVISIONING' | 'EMPTY' | 'DEPROVISION_FAILED' | 'DELETED';

/** Ce qu'une destination occupe RÉELLEMENT sur le serveur, lu avant retrait. */
export interface DestinationInventory {
  host: string;
  siteRoot: string;
  sharedUploads: string;
  sharedStorage: string;
  servedHosts: string[];
  pm2Name: string;
  exists: boolean;
  resolvedPath: string | null;
  size: string | null;
  files: number;
  persistentFiles: number;
  uploads: number;
  storage: number;
  outboundSymlinks: string[];
  pm2: { present: boolean; pid?: number | null; status?: string | null; execPath?: string | null; restarts?: number | null };
  port: number | null;
  portFree: boolean;
  portHolder: string | null;
}

export interface DestinationInspection {
  target: DeploymentTarget;
  inventory: DestinationInventory;
  /** Des données métier seront perdues : le retrait exigera une confirmation. */
  requiresPersistentDataConfirmation: boolean;
  /** Un lien sortant a été trouvé : le retrait sera refusé tel quel. */
  blockedBySymlinks: boolean;
}

export interface DeploymentTarget {
  targetId: string;
  name: string;
  url: string;
  host: string;
  type: 'subdomain' | 'domain';
  registrableDomain: string | null;
  subdomain: string | null;
  wildcardBase: string | null;
  environment: 'TEST' | 'PROD';
  sshHost: string | null;
  sshUser: string;
  sshPort: number;
  backendPort: number;
  /** Même valeur que `backendPort`, sous le nom qu'emploie le registre des ports. */
  port: number;
  remoteRoot: string;
  dbName: string | null;
  certbotEmail: string | null;
  extraEnv: Record<string, string>;
  /** Cette destination héberge le Panel qui pilote — déduit, jamais saisi. */
  selfHosted: boolean;
  state: DeploymentState;

  // ── Cycle de vie ────────────────────────────────────────────────────────
  lifecycleStatus: LifecycleStatus;
  lifecycleLabel: string;
  deprovisionStartedAt: string | null;
  deprovisionCompletedAt: string | null;
  deprovisionFailedAt: string | null;
  lastDeprovisionRunId: string | null;
  emptiedAt: string | null;
  deletedAt: string | null;
  lastError: { at?: string; code?: string; message?: string | null; step?: string | null } | null;
  /** Le domaine répond 410 Gone : posé au retrait, levé à la suppression. */
  quarantineEnabled: boolean;
  activeDeploymentRunId: string | null;
  currentSiteRoot: string | null;
  projectIdentityId: string | null;
  /**
   * Ce que le BACKEND autorise. Calculé côté serveur pour que la règle ne
   * soit pas réécrite dans le navigateur, où elle divergerait dès la
   * première évolution du cycle de vie.
   */
  canDeploy: boolean;
  canDeprovision: boolean;
  canDelete: boolean;
  currentVersion: string | null;
  currentReleaseId: string | null;
  lastDeployedAt: string | null;
  lastRunId: string | null;
  history: Array<{
    at: string;
    operationType: string;
    version: string | null;
    user: string | null;
    durationMs: number | null;
    success: boolean;
    failedStep: string | null;
    error: string | null;
  }>;
  createdAt: string;
  updatedAt: string;
  /** Variables que le serveur exigera dans son .env. */
  requiredRemoteEnv: string[];
  /**
   * Ce que le backend a DÉDUIT, avec l'origine de chaque valeur. Affiché
   * pour que la déduction ne ressemble pas à de la magie — l'opérateur ne
   * les saisit pas, mais il a le droit de les voir.
   */
  derived: Array<{ label: string; value: string; from: string }>;
}

export interface RunStep {
  id: string;
  label: string;
  order: number;
  status: 'pending' | 'running' | 'ok' | 'warning' | 'error' | 'skipped';
  startedAt: string | null;
  finishedAt: string | null;
  durationMs: number | null;
  message: string | null;
  errorCode: string | null;
}

export interface RunLogEntry {
  at: string;
  level: 'INFO' | 'WARNING' | 'ERROR';
  message: string;
}

/**
 * Évènement du FLUX REPRENABLE de suivi.
 *
 * `seq` est monotone et sans trou : c'est le curseur de reprise. Les évènements
 * de service (`end`, `ping`, `reload`) n'en portent pas systématiquement.
 *   · `step`   une étape change d'état — on met à jour CETTE ligne, aucune autre ;
 *   · `log`    une ligne de journal s'ajoute ;
 *   · `end`    le run est conclu, le flux se termine normalement ;
 *   · `ping`   maintien de connexion, aucun effet visuel ;
 *   · `reload` le curseur du client est trop ancien : recharger l'état complet.
 */
export type DeployStreamEvent =
  | { seq: number; at: string; kind: 'step'; payload: Partial<RunStep> & { id: string } }
  | { seq: number; at: string; kind: 'log'; payload: RunLogEntry }
  | { kind: 'end'; status: RunStatus; seq: number }
  | { kind: 'ping'; seq: number }
  | { kind: 'reload'; reason: string; lastSeq: number };

export interface DeploymentRun {
  runId: string;
  targetId: string;
  targetName: string | null;
  url: string | null;
  host: string | null;
  environment: 'TEST' | 'PROD';
  operationType: OperationType;
  status: RunStatus;
  /** Le worker ne donne plus signe de vie : l'issue est inconnue. */
  staleWorker: boolean;
  steps: RunStep[];
  log: RunLogEntry[];
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  version: string | null;
  releaseId: string | null;
  deployedUrl: string | null;
  summary: string | null;
  error: { code: string; message: string; step?: string | null } | null;
  user: string | null;
  selfDeployment: boolean;
  workerHeartbeatAt: string | null;
  /** Rapport produit par le moteur — structuré et markdown, secrets masqués. */
  structuredReport: Record<string, unknown> | null;
  markdownReport: string | null;
  /** Avancement calculé à la lecture. */
  progress: { done: number; total: number; percent: number };
}

export interface RunRow {
  runId: string;
  targetId: string;
  targetName: string | null;
  environment: 'TEST' | 'PROD';
  operationType: OperationType;
  status: RunStatus;
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  version: string | null;
  user: string | null;
  stepCount: number;
  selfDeployment: boolean;
}

export interface DeploymentOverview {
  targets: DeploymentTarget[];
  summary: {
    total: number;
    deployed: number;
    failed: number;
    deploying: number;
    environments: { TEST: number; PROD: number };
    lifecycle: {
      active: number;
      deprovisioning: number;
      empty: number;
      deprovisionFailed: number;
      deleted: number;
    };
    panelEnvironment: string;
  };
  recentRuns: RunRow[];
}

/**
 * RÉSERVATION D'UN PORT — le port n'est plus un entier sur la fiche, c'est une
 * ressource du SERVEUR avec un propriétaire, un état et une vérification.
 *
 * « Réservé, jamais vérifié » n'est pas « actif, PID connu, socket contrôlée » :
 * confondre les deux est exactement ce qui a permis d'attribuer un port qu'un
 * ancien service détenait encore.
 */
export interface PortReservation {
  port: number;
  serverKey: string;
  host: string | null;
  deploymentTargetId: string | null;
  projectIdentityId: string | null;
  environment: 'TEST' | 'PROD';
  serviceType: string;
  status: 'RESERVED' | 'ACTIVE' | 'RELEASING' | 'RELEASED';
  reservedAt: string;
  activatedAt: string | null;
  releasedAt: string | null;
  processName: string | null;
  pid: number | null;
  lastVerifiedAt: string | null;
  lastConflict: Record<string, unknown> | null;
}

export interface TargetDetail {
  target: DeploymentTarget;
  runs: RunRow[];
  activeRun: DeploymentRun | null;
  /** Ce que le registre des ports dit de cette destination. */
  portReservation: PortReservation | null;
}

/** Ce que le Panel sait de lui-même — affiché avant de configurer. */
export interface PanelSelfInfo {
  environment: string;
  publicUrl: string | null;
  publicUrlSource: string;
  projectSlug: string;
  projectId: string;
  apps: Array<{ id: string; dir: string; role: string; nginxRole: string }>;
  wildcardBases: string[];
  defaultRemoteRoot: string;
}

export interface StartedOperation {
  runId: string;
  /** Même valeur que runId — nom attendu par le contrat 202. */
  executionId: string;
  status: string;
  operationType: OperationType;
  selfDeployment: boolean;
  notice: string | null;
}

export interface ReleaseList {
  host: string;
  current: string | null;
  releases: string[];
}
