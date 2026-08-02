// Types de la surface de DÉPLOIEMENT (/api/deployment) — Phase 4.
//
// Remarque qui se lit dans les types : `sshPassword` n'apparaît que dans les
// types de REQUÊTE, jamais dans un type de réponse. Le mot de passe monte,
// il ne redescend jamais.

export type DeploymentState = 'NEW' | 'DEPLOYING' | 'DEPLOYED' | 'FAILED';
export type RunStatus = 'running' | 'ok' | 'warning' | 'error' | 'interrupted';
export type OperationType =
  | 'CONNECTION_TEST' | 'PRECHECK' | 'SIMULATION' | 'DEPLOYMENT' | 'ROLLBACK';

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
  remoteRoot: string;
  dbName: string | null;
  certbotEmail: string | null;
  extraEnv: Record<string, string>;
  /** Cette destination héberge le Panel qui pilote — déduit, jamais saisi. */
  selfHosted: boolean;
  state: DeploymentState;
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
    panelEnvironment: string;
  };
  recentRuns: RunRow[];
}

export interface TargetDetail {
  target: DeploymentTarget;
  runs: RunRow[];
  activeRun: DeploymentRun | null;
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
