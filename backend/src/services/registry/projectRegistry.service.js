// Le registre des projets — docs/architecture/02_PROJECT_REGISTRY.md.
// Catégorie 3 : cette donnée n'existe que dans le Panel et ne transite jamais
// vers un projet.
import config from '../../config/env.js';
import { newBridgeId, nowIso } from '../../bridge/bridgeContract.js';
import ApiError from '../../utils/ApiError.js';
import registryStore from './registryStore.js';
import { issuePairingCode } from '../pairing/pairing.service.js';
import { validateManifest } from '../manifest/manifest.schema.js';
import { interpretCapabilities } from '../manifest/capabilities.service.js';

const PROJECT_KEY_RE = /^[a-z0-9][a-z0-9-]{1,118}[a-z0-9]$/;

export const LIVENESS = Object.freeze({
  NOT_PAIRED: 'NOT_PAIRED',
  NEVER_SEEN: 'NEVER_SEEN',
  ONLINE: 'ONLINE',
  STALE: 'STALE',
  OFFLINE: 'OFFLINE',
});

function assertValidManifestOrThrow(manifestInput) {
  const validation = validateManifest(manifestInput);
  if (!validation.valid) {
    throw ApiError.badRequest(
      'PANEL_MANIFEST_INVALID',
      'Manifest non conforme au Manager Standard.',
      validation.errors,
    );
  }
  return validation;
}

export function declareProject({ projectKey, projectName, manifest = null }) {
  if (typeof projectKey !== 'string' || !PROJECT_KEY_RE.test(projectKey)) {
    throw ApiError.badRequest(
      'PANEL_PROJECT_KEY_INVALID',
      'projectKey invalide : 3 à 120 caractères, kebab-case (a-z, 0-9, tirets).',
    );
  }
  if (typeof projectName !== 'string' || projectName.trim().length === 0) {
    throw ApiError.badRequest('PANEL_PROJECT_NAME_REQUIRED', 'projectName est requis.');
  }
  if (registryStore.getByKey(projectKey)) {
    throw ApiError.conflict(
      'PANEL_PROJECT_KEY_TAKEN',
      `Un projet « ${projectKey} » existe déjà dans le registre.`,
    );
  }

  let validatedManifest = null;
  if (manifest !== null && manifest !== undefined) {
    validatedManifest = assertValidManifestOrThrow(manifest).manifest;
  }

  const now = nowIso();
  const record = {
    projectId: newBridgeId(),
    projectKey,
    projectName: projectName.trim(),
    createdAt: now,
    updatedAt: now,
    pairing: {
      status: 'DECLARED',
      pairingCodeHash: null,
      pairingCodeExpiresAt: null,
      bridgeTokenHash: null,
      bridgeTokenEncrypted: null,
      pairedAt: null,
      revokedAt: null,
    },
    runtime: {
      environment: null,
      softwareVersion: null,
      contractVersion: null,
      publicBackendUrl: null,
      lastHeartbeatAt: null,
      lastHealth: null,
      bridgeStats: null,
    },
    manifest: validatedManifest,
  };
  registryStore.insert(record);

  const { code, expiresAt } = issuePairingCode(record);
  return { record, pairingCode: code, pairingCodeExpiresAt: expiresAt };
}

export function getProjectOrThrow(projectId) {
  const record = registryStore.getById(projectId);
  if (!record) {
    throw ApiError.notFound('PANEL_PROJECT_NOT_FOUND', 'Projet inconnu du registre.');
  }
  return record;
}

export function listProjects() {
  return registryStore.list();
}

export function updateManifest(projectId, manifestInput) {
  const record = getProjectOrThrow(projectId);
  const validation = assertValidManifestOrThrow(manifestInput);
  record.manifest = validation.manifest;
  registryStore.save(record);
  return { record, unknownCapabilities: validation.unknownCapabilities };
}

export function removeProject(projectId) {
  const record = getProjectOrThrow(projectId);
  if (record.pairing.status === 'PAIRED') {
    throw ApiError.conflict(
      'PANEL_PROJECT_STILL_PAIRED',
      'Ce projet est encore appairé : révoquez l’appairage avant de le retirer du parc.',
    );
  }
  registryStore.remove(projectId);
  return { removed: true };
}

// Enregistre un heartbeat (fiche déjà authentifiée par le middleware de pont).
export function recordHeartbeat(record, heartbeat) {
  record.runtime.environment = heartbeat.environment;
  record.runtime.softwareVersion = heartbeat.softwareVersion;
  record.runtime.lastHeartbeatAt = nowIso();
  record.runtime.lastHealth = {
    status: heartbeat.health.status,
    details: heartbeat.health.details ?? null,
  };
  record.runtime.bridgeStats = heartbeat.bridgeStats ?? null;
  registryStore.save(record);
}

// Vivacité — dérivée à la lecture, jamais stockée (06_PROJECT_LIFECYCLE §3).
export function deriveLiveness(record, now = Date.now()) {
  if (record.pairing.status !== 'PAIRED') return LIVENESS.NOT_PAIRED;
  if (!record.runtime.lastHeartbeatAt) return LIVENESS.NEVER_SEEN;
  const elapsedS = (now - new Date(record.runtime.lastHeartbeatAt).getTime()) / 1000;
  if (elapsedS < 2 * config.heartbeatIntervalS) return LIVENESS.ONLINE;
  if (elapsedS < 6 * config.heartbeatIntervalS) return LIVENESS.STALE;
  return LIVENESS.OFFLINE;
}

// Projection publique d'une fiche : jamais un hash, jamais un secret chiffré.
export function toPublicProject(record, now = Date.now()) {
  const capabilities = interpretCapabilities(record.manifest);
  return {
    projectId: record.projectId,
    projectKey: record.projectKey,
    projectName: record.projectName,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    pairing: {
      status: record.pairing.status,
      pairedAt: record.pairing.pairedAt,
      revokedAt: record.pairing.revokedAt,
      pairingCodeExpiresAt: record.pairing.pairingCodeExpiresAt,
    },
    runtime: { ...record.runtime },
    liveness: deriveLiveness(record, now),
    capabilities: {
      enabled: capabilities.enabled,
      unknown: capabilities.unknown,
      panelModules: capabilities.panelModules,
    },
    manifest: record.manifest,
  };
}

// Checklist de conformité Manager Standard (20_MANAGER_STANDARD §5) — états
// observables depuis le Panel ; le reste (Standalone, surface locale) relève
// de la recette du projet lui-même.
export function describeConformity(record) {
  const manifestValid = record.manifest !== null;
  const identityConsistent =
    !manifestValid ||
    (record.manifest.project.projectKey === record.projectKey &&
      record.manifest.project.projectName === record.projectName);
  return {
    declared: true,
    hasManifest: manifestValid,
    identityConsistent,
    paired: record.pairing.status === 'PAIRED',
    seenAlive: record.runtime.lastHeartbeatAt !== null,
  };
}
