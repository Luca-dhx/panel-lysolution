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
import { currentGeneration } from '../sync/projectGeneration.js';
import {
  generateProjectKey,
  normalizeBackendUrl,
  resolveProjectName,
} from './projectIdentity.js';

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

/**
 * LE refus de doublon — un seul fait, donc un seul message.
 *
 * Même adresse, même clé dérivée, même identité annoncée, ou collision d'index
 * entre deux requêtes simultanées : ce sont cinq chemins vers la même
 * situation. Cinq messages différents feraient croire à cinq problèmes.
 */
function dejaDeclare(existant) {
  return ApiError.conflict(
    'PANEL_PROJECT_ALREADY_DECLARED',
    'Ce projet est déjà déclaré dans le Panel.',
    { projectId: existant?.projectId ?? null, projectName: existant?.projectName ?? null },
  );
}

/**
 * DÉCLARE un projet dans le registre.
 *
 * La CLÉ N'EST PAS UN PARAMÈTRE : elle est générée ici, jamais reçue. Le
 * frontend n'a donc aucun moyen de décider d'un identifiant, et l'utilisateur
 * n'a plus rien à deviner. Voir projectIdentity.js pour l'ordre de préférence.
 *
 * @param {object}  input
 * @param {string}  input.publicBackendUrl  Adresse du projet — la seule saisie obligatoire.
 * @param {string} [input.projectName]      Nom lisible ; à défaut, celui que le projet s'est donné.
 * @param {object} [input.bridgeIdentity]   Identité annoncée au ping (contrat >= 1.4.0).
 * @param {object} [input.manifest]         Manifest de secours (projets sans transport de Manifest).
 */
export async function declareProject({
  publicBackendUrl,
  projectName = null,
  bridgeIdentity = null,
  manifest = null,
} = {}) {
  const normalizedUrl = normalizeBackendUrl(publicBackendUrl);
  if (!normalizedUrl) {
    throw ApiError.badRequest(
      'PANEL_PROJECT_URL_INVALID',
      'URL du backend invalide : une adresse http(s) est requise.',
    );
  }

  const generated = generateProjectKey({
    bridgeIdentity,
    projectName,
    publicBackendUrl: normalizedUrl,
  });
  if (!generated) {
    throw ApiError.badRequest(
      'PANEL_PROJECT_KEY_UNRESOLVABLE',
      'Impossible de dériver une clé technique : donnez un nom de projet.',
    );
  }

  const resolvedName = resolveProjectName({ bridgeIdentity, projectName, publicBackendUrl: normalizedUrl });
  if (!resolvedName) {
    throw ApiError.badRequest('PANEL_PROJECT_NAME_REQUIRED', 'projectName est requis.');
  }

  // ── ANTI-DOUBLONS ────────────────────────────────────────────────────────
  // Un même projet ne peut entrer qu'une fois, par quelque porte qu'on tente :
  // même adresse, même clé dérivée, ou même identité annoncée par le pont.
  // Le message est le même dans les trois cas — c'est le même fait.
  const already =
    (await registryStore.getByBackendUrl(normalizedUrl))
    ?? (await registryStore.getByKey(generated.projectKey))
    ?? (bridgeIdentity?.projectKey
      ? await registryStore.getByKey(bridgeIdentity.projectKey)
      : null);

  if (already) throw dejaDeclare(already);

  let validatedManifest = null;
  if (manifest !== null && manifest !== undefined) {
    validatedManifest = assertValidManifestOrThrow(manifest).manifest;
  }

  const now = nowIso();
  const manifestSource = validatedManifest ? 'MANUAL' : null;
  const record = {
    projectId: newBridgeId(),
    projectKey: generated.projectKey,
    projectKeySource: generated.source,
    projectName: resolvedName,
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
      // Ce que la sonde a constaté : l'adresse est connue DÈS la déclaration
      // (c'est elle qu'on a saisie), plus seulement après l'appairage. C'est
      // ce qui rend la détection de doublons possible avant tout appairage.
      contractVersion: null,
      publicBackendUrl: normalizedUrl,
      lastHeartbeatAt: null,
      lastHealth: null,
      bridgeStats: null,
    },
    manifest: validatedManifest,
    manifestSource,
  };

  // ── LA COURSE ────────────────────────────────────────────────────────────
  // La relecture ci-dessus ne protège que d'un doublon DÉJÀ écrit : lire puis
  // écrire, ce sont deux temps. Deux requêtes lancées ensemble — un double
  // clic, deux onglets — lisaient toutes les deux « rien », et toutes les deux
  // inséraient.
  //
  // Ce qui les départage est déjà là : la clé technique est DÉTERMINISTE (même
  // adresse et même identité annoncée donnent la même clé) et son index est
  // unique. La base refuse donc la seconde insertion d'elle-même. Il ne restait
  // qu'à traduire ce refus dans le langage du métier — sans quoi le second
  // appelant recevait une erreur brute de base de données là où le premier
  // arrivé une seconde plus tard lisait une phrase claire.
  //
  // On ne pose PAS d'index unique sur l'adresse : elle est aussi réécrite au
  // bootstrap, où deux fiches distinctes peuvent légitimement annoncer la même
  // valeur. Une contrainte de base y transformerait un appairage en panne.
  try {
    await registryStore.insert(record);
  } catch (err) {
    if (err?.code !== 11000) throw err;
    const gagnant =
      (await registryStore.getByBackendUrl(normalizedUrl))
      ?? (await registryStore.getByKey(generated.projectKey));
    throw dejaDeclare(gagnant ?? { projectId: null, projectName: resolvedName });
  }

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

/**
 * CONVERGENCE (Phase 4, contrat >= 1.3.0) — ce que le projet déclare avoir
 * réellement appliqué.
 *
 * C'est la seule information de tout le registre que le Panel ne peut pas
 * déduire : il sait ce qu'il a ÉMIS, il ne saurait pas ce qui a PRIS EFFET.
 * Sans ce constat, « configuration publiée » et « configuration appliquée »
 * seraient confondues, et un projet resté en retard passerait inaperçu.
 */
export async function recordAppliedConfiguration(record, applied) {
  record.appliedConfiguration = {
    companyId: applied.companyId ?? null,
    companySlug: applied.companySlug ?? null,
    companyVersion: applied.companyVersion ?? null,
    companyAppliedAt: applied.companyAppliedAt ?? null,
    integratedApiCount: applied.integratedApiCount ?? 0,
    integratedApiKeys: applied.integratedApiKeys ?? [],
    lastSyncAt: applied.lastSyncAt ?? null,
    observedAt: nowIso(),
  };
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
export function toPublicProject(record, now = Date.now(), projections = {}) {
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
    // CONVERGENCE (Phase 4) — relevée lors d'une découverte. `null` signifie
    // « jamais constatée », ce qui n'est pas « rien appliqué ».
    appliedConfiguration: record.appliedConfiguration ?? null,
    note: record.note ?? null,
    // PROJECTIONS MÉTIER (Lot 1b) — poussées par le projet, rafraîchies à
    // chaque modification. `null` = jamais reçue, ce qui n'est pas « vide ».
    business: {
      presentation: projections.presentation ?? null,
      contract: projections.contract ?? null,
      /**
       * FRAÎCHEUR — d'où viennent ces projections, et sont-elles encore de ce
       * monde ? Un projet redéployé de PROD vers TEST garde son `projectId`,
       * mais tout le reste a changé : les données reçues sous PROD ne
       * décrivent plus rien. L'écran doit pouvoir le dire, et pour cela il
       * lui faut la génération de la source à côté de la génération courante.
       */
      freshness: describeFreshness(record, projections),
    },
  };
}

/**
 * Ce que le frontend a besoin de savoir pour ne JAMAIS présenter une ancienne
 * photographie comme l'état actuel. Aucune décision d'affichage ici : on
 * fournit les faits, l'écran les met en forme (voir `getProjectDataFreshness`).
 */
function describeFreshness(record, projections) {
  const { environment, generation } = currentGeneration(record);
  // La photographie la plus récemment reçue, quelle que soit l'entité : c'est
  // elle qui date la dernière synchronisation complète du projet.
  const recues = [projections.presentation, projections.contract]
    .filter(Boolean)
    .map((p) => p.receivedAt)
    .filter(Boolean)
    .sort();
  const source = projections.contract ?? projections.presentation ?? null;
  return {
    runtimeEnvironment: environment,
    runtimeGeneration: generation,
    projectionEnvironment: source?.sourceEnvironment ?? null,
    projectionGeneration: source?.sourceGeneration ?? null,
    lastSyncAt: recues.length > 0 ? recues[recues.length - 1] : null,
  };
}

/**
 * Charge les projections métier d'un LOT de projets en deux requêtes, puis les
 * distribue. Une requête par projet ferait N+1 sur la page « Projets clients ».
 */
/**
 * ÉQUIPE d'un projet — lue seulement sur la FICHE.
 *
 * Pas dans la liste : charger l'équipe de tout le parc pour afficher des
 * cartes qui ne la montrent pas serait payer un coût sans contrepartie.
 */
export async function loadProjectTeam(projectId) {
  const { PanelProjectMember } = await import('../../models/PanelProjectProjection.model.js');
  return PanelProjectMember.find({ projectId }).sort({ role: 1, email: 1 }).lean();
}

export async function loadBusinessProjections(projectIds) {
  const { PanelProjectContract, PanelProjectPresentation } = await import(
    '../../models/PanelProjectProjection.model.js'
  );
  const [presentations, contracts] = await Promise.all([
    PanelProjectPresentation.find({ projectId: { $in: projectIds } }).lean(),
    PanelProjectContract.find({ projectId: { $in: projectIds } }).lean(),
  ]);
  const byId = new Map(projectIds.map((id) => [id, { presentation: null, contract: null }]));
  for (const p of presentations) if (byId.has(p.projectId)) byId.get(p.projectId).presentation = p;
  for (const c of contracts) if (byId.has(c.projectId)) byId.get(c.projectId).contract = c;
  return byId;
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
    // PRÉSENTATION (contrat >= 1.4.x) — le nom COMMERCIAL prime sur le nom
    // technique dès que le projet le publie : c'est celui sous lequel
    // l'équipe connaît le client.
    name: manifest?.presentation?.companyName
      ?? manifest?.descriptor?.name
      ?? manifest?.project?.name
      ?? record.projectName,
    presentation: manifest?.presentation ?? null,
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
