// Types de la surface de supervision (/api/supervision) — Phase 3A.
// Miroir exact des projections du backend. Lecture seule : aucun type ici ne
// décrit une action.

export type Liveness = 'NOT_PAIRED' | 'NEVER_SEEN' | 'ONLINE' | 'STALE' | 'OFFLINE';
export type HealthLevel = 'OK' | 'WARNING' | 'ERROR' | 'UNKNOWN';
export type Severity = 'INFO' | 'WARNING' | 'ERROR';
export type EventSource = 'PROJECT' | 'PANEL_OBSERVATION';

/** Niveau 1 — une ligne de parc. Volontairement pauvre. */
export interface FleetRow {
  projectId: string;
  slug: string;
  name: string;
  type: string | null;
  environment: 'TEST' | 'PROD' | null;
  primaryDomain: string | null;
  pairingStatus: 'DECLARED' | 'PAIRED' | 'REVOKED' | null;
  liveness: Liveness;
  health: HealthLevel;
  softwareVersion: string | null;
  contractVersion: string | null;
  deploymentEngineVersion: string | null;
  duplicationEngineVersion: string | null;
  lastHeartbeatAt: string | null;
  secondsSinceLastHeartbeat: number | null;
  issues: number;
}

export interface Alert {
  severity: Severity;
  code: string;
  projectId: string;
  projectName: string;
  message: string;
}

export interface TimelineEvent {
  projectId: string;
  occurredAt: string;
  type: string;
  source: EventSource;
  severity: Severity;
  summary: string;
  data?: unknown;
}

/** Niveau 0 — le tableau de bord. Des nombres, pas des listes. */
export interface Dashboard {
  generatedAt: string;
  panel: {
    contractVersion: string;
    engines: Record<string, string>;
    thresholds: {
      intervalS: number;
      staleFactor: number;
      offlineFactor: number;
      staleAfterS: number;
      offlineAfterS: number;
    };
  };
  totals: {
    projects: number;
    paired: number;
    online: number;
    stale: number;
    offline: number;
    neverSeen: number;
    notPaired: number;
    test: number;
    prod: number;
  };
  health: { ok: number; warning: number; error: number; unknown: number };
  byType: Record<string, number>;
  versions: {
    software: Record<string, number>;
    contract: Record<string, number>;
    deploymentEngine: Record<string, number>;
    duplicationEngine: Record<string, number>;
  };
  alerts: { total: number; error: number; warning: number; info: number; items: Alert[] };
  attention: FleetRow[];
  recentActivity: TimelineEvent[];
}

export interface HealthComponent {
  id: string;
  status: HealthLevel;
  detail: string;
  source: 'PROJECT' | 'PANEL' | 'UNAVAILABLE';
}

export interface ProjectHealth {
  status: HealthLevel;
  liveness: Liveness;
  components: HealthComponent[];
  counts: Partial<Record<HealthLevel, number>>;
  evaluatedAt: string;
}

export interface ProjectDescriptor {
  slug: string;
  name: string;
  type: string | null;
  description: string | null;
  layout: string | null;
  environment: 'TEST' | 'PROD' | null;
  primaryDomain: string | null;
  urls: Record<string, string> | null;
  versions: {
    software: string | null;
    contract: string | null;
    manifestFormat: string | null;
    deploymentEngine: string | null;
    duplicationEngine: string | null;
  };
  dates: {
    createdAt: string;
    pairedAt: string | null;
    lastHeartbeatAt: string | null;
    lastActivityAt: string | null;
    manifestUpdatedAt: string | null;
  };
}

/** Niveau 2 — la fiche projet. */
export interface ProjectOverview {
  projectId: string;
  descriptor: ProjectDescriptor;
  pairing: { status: string; pairedAt: string | null; revokedAt: string | null };
  health: ProjectHealth;
  capabilities: {
    enabled: string[];
    reserved: string[];
    unknown: string[];
    modules: { active: string[]; optional: string[] };
    sync: { supportedEntityTypes: string[]; operations: string[] };
  };
  manifestSource: 'BRIDGE' | 'MANUAL' | null;
  /**
   * CONVERGENCE (Phase 4) — écart entre ce que le Panel a PUBLIÉ et ce que le
   * projet a déclaré APPLIQUER. Calculé à chaque lecture : un statut figé
   * serait périmé dès la publication suivante.
   */
  convergence: {
    status: 'CONVERGED' | 'BEHIND' | 'UNKNOWN' | 'NOTHING_PUBLISHED';
    publishedVersion: number | null;
    appliedVersion: number | null;
    integratedApiKeys: string[];
    observedAt: string | null;
    reason: string;
  };
  recentEvents: TimelineEvent[];
}

/** Niveau 3 — détails techniques, chargés à la demande. */
export interface HeartbeatStats {
  count: number;
  first: string | null;
  last: string | null;
  averageIntervalS: number | null;
  expectedIntervalS: number;
  regular: boolean | null;
}

export interface ProjectTechnical {
  projectId: string;
  runtime: Record<string, unknown>;
  manifest: unknown | null;
  manifestSource: 'BRIDGE' | 'MANUAL' | null;
  manifestUpdatedAt: string | null;
  heartbeatStats: HeartbeatStats;
}

export interface HeartbeatRow {
  receivedAt: string;
  sentAt: string;
  softwareVersion: string | null;
  environment: string | null;
  healthStatus: string | null;
  healthDetails: string | null;
  uptimeSeconds: number | null;
  load: { cpuPercent?: number; memoryUsedMb?: number; memoryTotalMb?: number } | null;
  components: Record<string, HealthLevel> | null;
  engines: Record<string, string> | null;
}

export interface SearchFacets {
  types: string[];
  environments: string[];
  liveness: string[];
  health: string[];
  softwareVersions: string[];
  contractVersions: string[];
  deploymentEngineVersions: string[];
  duplicationEngineVersions: string[];
  modules: string[];
  features: string[];
}

export interface FleetResult {
  criteria: Record<string, string>;
  total: number;
  returned: number;
  items: FleetRow[];
}
