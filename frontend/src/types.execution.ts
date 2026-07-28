// Types de la surface de PILOTAGE (/api/executions) — Phase 3C.
//
// Miroir des projections du backend. Rien ici n'est calculé côté navigateur :
// un refus, un état, un plan viennent toujours du moteur. L'interface les
// affiche, elle ne les décide pas.

export type ExecutionState =
  | 'CREATED' | 'WAITING_CONFIRMATION' | 'QUEUED' | 'RUNNING'
  | 'SUCCEEDED' | 'FAILED' | 'CANCELLED' | 'ROLLED_BACK' | 'TIMEOUT';

export type ExecutionMode = 'SIMULATION' | 'EXECUTION';
export type Risk = 'NONE' | 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
export type LogLevel = 'INFO' | 'WARNING' | 'ERROR';

export interface ParameterSpec {
  required: boolean;
  type: 'string' | 'enum' | 'array';
  values?: string[];
  description?: string;
}

export interface ActionPolicy {
  requiresConfirmation: boolean;
  confirmationsRequired: number;
  allowedEnvironments: string[];
  risk: Risk;
  rollbackable: boolean;
  timeoutMs: number;
  exclusive: boolean;
  exclusivityScope: string;
  requiredReadiness: number | null;
  blockOnDiagnostics: string[];
  prerequisites: Array<{ id: string; label: string }>;
}

export interface ActionDescriptor {
  type: string;
  label: string;
  description: string;
  category: string;
  target: 'PROJECT' | 'PANEL';
  simulatable: boolean;
  parameters: Record<string, ParameterSpec>;
  futureActions: string[];
  policy: ActionPolicy;
}

export interface PolicyCheck {
  id: string;
  label: string;
  ok: boolean;
  code?: string | null;
  message: string;
  facts?: Record<string, unknown>;
}

export interface Denial {
  code: string;
  message: string;
  facts?: Record<string, unknown>;
}

/** Résultat de la PRÉPARATION : ce que l'écran montre avant tout engagement. */
export interface ActionPreparation {
  action: ActionDescriptor;
  projectId: string | null;
  parameters: Record<string, unknown>;
  allowed: boolean;
  checks: PolicyCheck[];
  denials: Denial[];
  reason: string;
  confirmation: { required: boolean; count: number; risk: Risk };
  modes: { simulation: boolean; execution: boolean; default: ExecutionMode };
}

export interface LogEntry {
  at: string;
  phase: string;
  level: LogLevel;
  message: string;
  data: unknown;
}

export interface Confirmation {
  at: string;
  userId: string;
  userEmail: string | null;
  decision: 'APPROVED' | 'REJECTED';
  comment: string | null;
}

export interface PlanStep {
  step: string;
  description: string;
  commandCount?: number;
}

export interface Execution {
  executionId: string;
  type: string;
  projectId: string | null;
  projectName: string | null;
  environment: string | null;
  mode: ExecutionMode;
  parameters: Record<string, unknown>;
  initiator: { userId: string; userEmail: string | null; role: string | null };
  state: ExecutionState;
  stateHistory: Array<{ at: string; from: string | null; to: ExecutionState; reason: string | null }>;
  validation: {
    at: string; ok: boolean; mode: ExecutionMode;
    checks: PolicyCheck[]; denials: Denial[]; summary: string;
  } | null;
  confirmations: Confirmation[];
  confirmationsRequired: number;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  durationMs: number | null;
  result: {
    mode: ExecutionMode; summary: string;
    plan?: PlanStep[];
    consequences?: Array<{ secret: string; consequence: string }>;
    [key: string]: unknown;
  } | null;
  error: { code: string; message: string; details?: unknown } | null;
  log: LogEntry[];
  timeoutMs: number | null;
  cancellationRequested: boolean;
}

/** Ligne d'historique — le niveau 1 de la divulgation progressive. */
export interface ExecutionRow {
  executionId: string;
  type: string;
  projectId: string | null;
  projectName: string | null;
  environment: string | null;
  mode: ExecutionMode;
  state: ExecutionState;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  durationMs: number | null;
  initiator: string | null;
  confirmations: string;
  summary: string | null;
  settled: boolean;
}

export interface ExecutionStats {
  total: number;
  active: number;
  byState: Record<ExecutionState, number>;
}
