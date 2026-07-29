// Surface de SUPERVISION (/api/supervision) — Phase 3A, LECTURE SEULE.
//
// Toutes les routes de ce contrôleur sont des GET. Aucune n'écrit, aucune ne
// contacte un projet. C'est un invariant vérifié par les tests
// d'architecture : la supervision observe, elle n'administre pas.
//
// L'API suit la divulgation progressive :
//   · GET /dashboard          niveau 0 — quelques nombres
//   · GET /fleet              niveau 1 — une ligne par projet
//   · GET /projects/:id       niveau 2 — la fiche
//   · GET /projects/:id/…     niveau 3 — détails techniques à la demande
import { ok } from '../utils/apiResponse.js';
import { getProjectOrThrow, describeProject, projectHealth, toPublicProject } from '../services/registry/projectRegistry.service.js';
import { buildDashboard, searchFleet, searchFacets, supervisionContext } from '../services/supervision/fleet.service.js';
import { heartbeatHistory, heartbeatStats } from '../services/supervision/heartbeat.service.js';
import { projectTimeline, parkTimeline } from '../services/supervision/timeline.service.js';
import { interpretCapabilities } from '../services/manifest/capabilities.service.js';
import { getActiveCompany } from '../services/company/company.service.js';

/** Niveau 0 — tableau de bord du parc. */
export async function dashboard(_req, res) {
  return ok(res, await buildDashboard());
}

/** Niveau 1 — le parc, une ligne par projet, filtrable. */
export async function fleet(req, res) {
  const criteria = {};
  for (const key of [
    'q', 'name', 'slug', 'domain', 'type', 'environment', 'liveness', 'health',
    'pairing', 'module', 'feature', 'softwareVersion', 'contractVersion',
    'deploymentEngine', 'duplicationEngine',
  ]) {
    const value = req.query?.[key];
    if (typeof value === 'string' && value.trim() !== '') criteria[key] = value.trim();
  }
  const limit = Number(req.query?.limit) > 0 ? Math.min(Number(req.query.limit), 500) : 100;
  return ok(res, { criteria, ...(await searchFleet(criteria, { limit })) });
}

/** Valeurs de filtre réellement présentes dans le parc. */
export async function facets(_req, res) {
  return ok(res, await searchFacets());
}

/** Niveau 2 — la fiche projet : ce qu'on veut voir en un coup d'œil. */
export async function projectOverview(req, res) {
  const record = await getProjectOrThrow(req.params.projectId);
  const context = supervisionContext();
  const capabilities = interpretCapabilities(record.manifest);
  return ok(res, {
    projectId: record.projectId,
    descriptor: describeProject(record),
    pairing: {
      status: record.pairing.status,
      pairedAt: record.pairing.pairedAt,
      revokedAt: record.pairing.revokedAt,
    },
    health: projectHealth(record, context),
    capabilities: {
      enabled: capabilities.enabled,
      reserved: capabilities.reserved,
      unknown: capabilities.unknown,
      modules: capabilities.projectModules,
      sync: capabilities.sync,
    },
    manifestSource: record.manifestSource ?? null,
    // CONVERGENCE (Phase 4) — ce que le projet a déclaré avoir APPLIQUÉ, et
    // ce que le Panel a PUBLIÉ. Les deux côte à côte : c'est leur écart qui
    // renseigne, pas chacun pris isolément.
    convergence: await describeConvergence(record),
    // Aperçu court : les 5 derniers événements suffisent sur la fiche.
    recentEvents: await projectTimeline(record.projectId, { limit: 5 }),
  });
}

/**
 * Écart entre ce que le Panel a publié et ce que le projet applique.
 *
 * Le verdict est CALCULÉ, jamais stocké : une configuration publiée après le
 * dernier relevé rendrait immédiatement obsolète un statut figé.
 */
async function describeConvergence(record) {
  const applied = record.appliedConfiguration ?? null;
  const company = await getActiveCompany();
  const publishedVersion = company?.publishedVersion ?? null;

  if (!applied) {
    return {
      status: 'UNKNOWN',
      publishedVersion,
      appliedVersion: null,
      integratedApiKeys: [],
      observedAt: null,
      reason: 'Aucune découverte n’a encore eu lieu : le Panel ne sait pas ce que ce projet applique. Lancez « Découvrir le projet ».',
    };
  }
  if (publishedVersion === null) {
    return {
      status: 'NOTHING_PUBLISHED',
      publishedVersion: null,
      appliedVersion: applied.companyVersion ?? null,
      integratedApiKeys: applied.integratedApiKeys ?? [],
      observedAt: applied.observedAt ?? null,
      reason: 'Aucune configuration d’entreprise n’a été publiée : il n’y a rien à appliquer.',
    };
  }
  const appliedVersion = applied.companyVersion ?? null;
  const converged = appliedVersion === publishedVersion;
  return {
    status: converged ? 'CONVERGED' : 'BEHIND',
    publishedVersion,
    appliedVersion,
    integratedApiKeys: applied.integratedApiKeys ?? [],
    observedAt: applied.observedAt ?? null,
    reason: converged
      ? `Le projet applique la version ${appliedVersion}, celle qui est publiée.`
      : `Le projet applique la version ${appliedVersion ?? 'aucune'} alors que la version ${publishedVersion} est publiée : il n’a pas encore rattrapé.`,
  };
}

/** Niveau 3 — détails techniques, chargés seulement si l'on creuse. */
export async function projectTechnical(req, res) {
  const record = await getProjectOrThrow(req.params.projectId);
  return ok(res, {
    projectId: record.projectId,
    runtime: { ...record.runtime },
    manifest: record.manifest,
    manifestSource: record.manifestSource ?? null,
    manifestUpdatedAt: record.manifestUpdatedAt ?? null,
    heartbeatStats: await heartbeatStats(record.projectId),
    // La projection publique reste la référence : jamais un hash, jamais un
    // secret chiffré.
    project: toPublicProject(record),
  });
}

/** Niveau 3 — historique brut des heartbeats. */
export async function projectHeartbeats(req, res) {
  const record = await getProjectOrThrow(req.params.projectId);
  const limit = Number(req.query?.limit) > 0 ? Number(req.query.limit) : 50;
  return ok(res, {
    projectId: record.projectId,
    stats: await heartbeatStats(record.projectId),
    items: await heartbeatHistory(record.projectId, { limit }),
  });
}

/** Niveau 3 — chronologie du projet. */
export async function projectEvents(req, res) {
  const record = await getProjectOrThrow(req.params.projectId);
  const limit = Number(req.query?.limit) > 0 ? Number(req.query.limit) : 50;
  return ok(res, {
    projectId: record.projectId,
    items: await projectTimeline(record.projectId, { limit }),
  });
}

/** Chronologie du parc entier. */
export async function events(req, res) {
  const limit = Number(req.query?.limit) > 0 ? Number(req.query.limit) : 50;
  return ok(res, { items: await parkTimeline({ limit }) });
}
