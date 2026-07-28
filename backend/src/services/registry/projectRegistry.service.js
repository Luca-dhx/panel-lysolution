// Le registre des projets — docs/architecture/02_PROJECT_REGISTRY.md.
// Catégorie 3 : cette donnée n'existe que dans le Panel et ne transite jamais
// vers un projet.
import config from '../../config/env.js';
import { deriveLiveness, LIVENESS, secondsSinceLastHeartbeat } from '../supervision/liveness.service.js';
import { buildProjectHealth } from '../supervision/health.service.js';
import { newBridgeId, nowIso } from '../../bridge/bridgeContract.js';
import ApiError from '../../utils/ApiError.js';
import registryStore from './registryStore.js';
import { issuePairingCode } from '../pairing/pairing.service.js';
import { validateManifest } from '../manifest/manifest.schema.js';
import { interpretCapabilities } from '../manifest/capabilities.service.js';
import { recordEvent, EVENT_TYPES } from '../supervision/timeline.service.js';

const PROJECT_KEY_RE = /^[a-z0-9][a-z0-9-]{1,118}[a-z0-9]$/;

// La vivacité et la santé vivent dans les services de supervision : le
// registre les EXPOSE, il ne les recalcule pas (une seule implémentation).
export { LIVENESS, deriveLiveness };

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

export async function declareProject({ projectKey, projectName, manifest = null }) {
  if (typeof projectKey !== 'string' || !PROJECT_KEY_RE.test(projectKey)) {
    throw ApiError.badRequest(
      'PANEL_PROJECT_KEY_INVALID',
      'projectKey invalide : 3 à 120 caractères, kebab-case (a-z, 0-9, tirets).',
    );
  }
  if (typeof projectName !== 'string' || projectName.trim().length === 0) {
    throw ApiError.badRequest('PANEL_PROJECT_NAME_REQUIRED', 'projectName est requis.');
  }
  if (await registryStore.getByKey(projectKey)) {
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
  const manifestSource = validatedManifest ? 'MANUAL' : null;
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
    manifestSource,
  };
  await registryStore.insert(record);

  await recordEvent({
    projectId: record.projectId,
    type: EVENT_TYPES.PROJECT_DECLARED,
    source: 'PANEL_OBSERVATION',
    summary: `Projet « ${record.projectName} » déclaré dans le registre.`,
    occurredAt: now,
  });

  const { code, expiresAt } = await issuePairingCode(record);
  return { record, pairingCode: code, pairingCodeExpiresAt: expiresAt };
}

export async function getProjectOrThrow(projectId) {
  const record = await registryStore.getById(projectId);
  if (!record) {
    throw ApiError.notFound('PANEL_PROJECT_NOT_FOUND', 'Projet inconnu du registre.');
  }
  return record;
}

export function listProjects() {
  return registryStore.list();
}

// Saisie manuelle d'un Manifest — CANAL DE SECOURS uniquement (projet parlant
// encore un contrat 1.0.x, sans transport de Manifest). Dès qu'un Manifest a
// été reçu via le pont (bootstrap 1.1+), il fait foi : la saisie manuelle est
// refusée pour qu'elle ne puisse jamais contredire ce que le projet déclare.
export async function updateManifest(projectId, manifestInput) {
  const record = await getProjectOrThrow(projectId);
  if (record.manifestSource === 'BRIDGE') {
    throw ApiError.conflict(
      'PANEL_MANIFEST_BRIDGE_AUTHORITATIVE',
      'Ce projet transmet son Manifest via le pont : la saisie manuelle est désactivée.',
    );
  }
  const validation = assertValidManifestOrThrow(manifestInput);
  assertManifestIdentityMatches(record, validation.manifest);
  record.manifest = validation.manifest;
  record.manifestSource = 'MANUAL';
  await registryStore.save(record);
  return { record, unknownFeatures: validation.unknownFeatures };
}

// Une identité de Manifest qui ne correspond pas à la fiche est une erreur —
// jamais un écrasement silencieux.
function assertManifestIdentityMatches(record, manifest) {
  if (manifest.project.key !== record.projectKey) {
    throw ApiError.badRequest(
      'PANEL_MANIFEST_IDENTITY_MISMATCH',
      `Le Manifest déclare project.key « ${manifest.project.key} » mais la fiche est « ${record.projectKey} ».`,
    );
  }
}

// Manifest reçu par le PONT (bootstrap ≥ 1.1.0) — canal officiel, prioritaire
// et définitif : il remplace toute saisie manuelle antérieure.
export async function setManifestFromBridge(record, manifest) {
  record.manifest = manifest;
  record.manifestSource = 'BRIDGE';
  await registryStore.save(record);
  return record;
}

export async function removeProject(projectId) {
  const record = await getProjectOrThrow(projectId);
  if (record.pairing.status === 'PAIRED') {
    throw ApiError.conflict(
      'PANEL_PROJECT_STILL_PAIRED',
      'Ce projet est encore appairé : révoquez l’appairage avant de le retirer du parc.',
    );
  }
  await registryStore.remove(projectId);
  return { removed: true };
}

// Enregistre un heartbeat (fiche déjà authentifiée par le middleware de pont).
export async function recordHeartbeat(record, heartbeat) {
  record.runtime.environment = heartbeat.environment;
  record.runtime.softwareVersion = heartbeat.softwareVersion;
  record.runtime.lastHeartbeatAt = nowIso();
  record.runtime.lastHealth = {
    status: heartbeat.health.status,
    details: heartbeat.health.details ?? null,
  };
  record.runtime.bridgeStats = heartbeat.bridgeStats ?? null;
  // Contrat >= 1.2.0 — supervision. Absent ⇒ on n'écrase pas ce qu'on savait
  // déjà : un projet peut publier ces champs par intermittence.
  if (heartbeat.runtime?.uptimeSeconds !== undefined) {
    record.runtime.uptimeSeconds = heartbeat.runtime.uptimeSeconds;
  }
  if (heartbeat.runtime?.startedAt !== undefined) {
    record.runtime.startedAt = heartbeat.runtime.startedAt;
  }
  if (heartbeat.runtime?.load !== undefined) record.runtime.load = heartbeat.runtime.load;
  if (heartbeat.runtime?.components !== undefined) {
    record.runtime.components = heartbeat.runtime.components;
  }
  if (heartbeat.engines !== undefined) record.runtime.engines = heartbeat.engines;
  await registryStore.save(record);
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
    secondsSinceLastHeartbeat: secondsSinceLastHeartbeat(record, now),
    // Identité de supervision : entièrement DÉRIVÉE du Manifest publié par le
    // projet. Rien n'est ressaisi côté Panel (20_MANAGER_STANDARD §4).
    descriptor: describeProject(record),
    capabilities: {
      enabled: capabilities.enabled,
      reserved: capabilities.reserved,
      unknown: capabilities.unknown,
      panelModules: capabilities.panelModules,
    },
    manifest: record.manifest,
    manifestSource: record.manifestSource ?? null,
    manifestUpdatedAt: record.manifestUpdatedAt ?? null,
    note: record.note ?? null,
  };
}

/**
 * DESCRIPTEUR de supervision — la carte de visite d'un projet, telle que le
 * Panel peut l'afficher.
 *
 * Toutes les valeurs viennent du Manifest ou des heartbeats. Aucune n'est
 * saisie : c'est la règle « le Manifest reste l'autorité ». Ce que le projet
 * ne publie pas vaut `null`, et l'interface affiche « inconnu ».
 */
export function describeProject(record) {
  const manifest = record.manifest ?? null;
  const runtime = record.runtime ?? {};
  return {
    slug: record.projectKey,
    name: manifest?.project?.name ?? record.projectName,
    type: manifest?.descriptor?.type ?? null,
    description: manifest?.descriptor?.description ?? null,
    layout: manifest?.descriptor?.layout ?? null,
    environment: runtime.environment ?? manifest?.project?.environment ?? null,
    primaryDomain: manifest?.network?.primaryDomain ?? domainFromUrl(runtime.publicBackendUrl),
    urls: manifest?.network?.urls ?? (runtime.publicBackendUrl ? { backend: runtime.publicBackendUrl } : null),
    versions: {
      software: runtime.softwareVersion ?? manifest?.project?.softwareVersion ?? null,
      contract: runtime.contractVersion ?? manifest?.bridge?.contractVersion ?? null,
      manifestFormat: manifest?.manifestVersion ?? null,
      deploymentEngine: runtime.engines?.deployment ?? manifest?.engines?.deployment ?? null,
      duplicationEngine: runtime.engines?.duplication ?? manifest?.engines?.duplication ?? null,
    },
    dates: {
      createdAt: record.createdAt,
      pairedAt: record.pairing?.pairedAt ?? null,
      lastHeartbeatAt: runtime.lastHeartbeatAt ?? null,
      lastActivityAt: runtime.lastHeartbeatAt ?? record.updatedAt,
      manifestUpdatedAt: record.manifestUpdatedAt ?? null,
    },
  };
}

/** Domaine extrait d'une URL, sans jamais lever. */
function domainFromUrl(url) {
  if (!url) return null;
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

/** Santé détaillée d'un projet — déléguée au service de supervision. */
export function projectHealth(record, context = {}) {
  return buildProjectHealth(record, context);
}

// Checklist de conformité Manager Standard (20_MANAGER_STANDARD §5) — états
// observables depuis le Panel ; le reste (Standalone, surface locale) relève
// de la recette du projet lui-même.
export function describeConformity(record) {
  const manifestValid = record.manifest !== null;
  const identityConsistent =
    !manifestValid || record.manifest.project.key === record.projectKey;
  return {
    declared: true,
    hasManifest: manifestValid,
    identityConsistent,
    paired: record.pairing.status === 'PAIRED',
    seenAlive: record.runtime.lastHeartbeatAt !== null,
  };
}
