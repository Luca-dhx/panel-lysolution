export type Role = 'ADMIN' | 'DEV';

export interface PanelUser {
  userId: string;
  email: string;
  displayName: string;
  role: Role;
}

export interface PanelVersion {
  name: string;
  softwareVersion: string;
  contractVersion: string;
  environment: string;
}

export type PairingStatus = 'DECLARED' | 'PAIRED' | 'REVOKED';

export type Liveness = 'NOT_PAIRED' | 'NEVER_SEEN' | 'ONLINE' | 'STALE' | 'OFFLINE';

export type HealthStatus = 'OK' | 'DEGRADED';

export interface PublicProject {
  projectId: string;
  projectKey: string;
  projectName: string;
  createdAt: string;
  updatedAt: string;
  pairing: {
    status: PairingStatus;
    pairedAt: string | null;
    revokedAt: string | null;
    pairingCodeExpiresAt: string | null;
  };
  runtime: {
    environment: 'TEST' | 'PROD' | null;
    softwareVersion: string | null;
    contractVersion: string | null;
    publicBackendUrl: string | null;
    lastHeartbeatAt: string | null;
    lastHealth: { status: HealthStatus; details: string | null } | null;
    bridgeStats: { outboxSize?: number; lastSyncAt?: string | null } | null;
  };
  liveness: Liveness;
  capabilities: {
    enabled: string[];
    unknown: string[];
    panelModules: string[];
  };
  manifest: unknown | null;
}
