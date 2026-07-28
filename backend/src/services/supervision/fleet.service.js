// LE PARC — agrégation, alertes et recherche. Phase 3A, LECTURE SEULE.
//
// Ce service est le « NOC » du Panel : il répond à « comment va le parc ? »
// en une seule lecture, sans jamais contacter un projet.
//
// Discipline de « progressive disclosure » : les fonctions ici produisent
// deux niveaux de détail distincts — un RÉSUMÉ très synthétique (quelques
// nombres, utilisable avec des centaines de projets) et des LIGNES de parc
// (une par projet, sans le détail technique). Le détail complet n'est
// calculé que pour un projet donné, à la demande.
import { CONTRACT_VERSION } from '../../bridge/bridgeContract.js';
import { listProjects, describeProject } from '../registry/projectRegistry.service.js';
import { buildAlerts, buildProjectHealth, HEALTH } from './health.service.js';
import { deriveLiveness, LIVENESS, livenessThresholds, secondsSinceLastHeartbeat } from './liveness.service.js';
import { parkTimeline } from './timeline.service.js';
import { interpretCapabilities } from '../manifest/capabilities.service.js';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

/**
 * Versions de moteurs ATTENDUES — celles que le Panel lui-même embarque.
 * Elles servent de référence pour détecter une dérive du parc. Le Panel ne
 * les impose à personne : il constate un écart.
 */
export function expectedEngineVersions() {
  const engines = {};
  for (const [key, dir] of [['deployment', 'deployment-engine'], ['duplication', 'duplication-engine']]) {
    try {
      engines[key] = require(`../../${dir}/engine.manifest.json`).version;
    } catch {
      // Moteur absent : aucune référence, donc aucune dérive détectable.
    }
  }
  return engines;
}

function supervisionContext(now = Date.now()) {
  return {
    now,
    panelContractVersion: CONTRACT_VERSION,
    expectedEngines: expectedEngineVersions(),
  };
}

/**
 * LIGNE DE PARC — le niveau 1 de la divulgation progressive.
 *
 * Volontairement pauvre : de quoi lister, trier, filtrer et cliquer. Aucun
 * manifeste, aucun composant, aucun historique — ce sont les niveaux 2 et 3.
 */
export function toFleetRow(record, context) {
  const health = buildProjectHealth(record, context);
  const descriptor = describeProject(record);
  return {
    projectId: record.projectId,
    slug: record.projectKey,
    name: descriptor.name,
    type: descriptor.type,
    environment: descriptor.environment,
    primaryDomain: descriptor.primaryDomain,
    pairingStatus: record.pairing?.status ?? null,
    liveness: health.liveness,
    health: health.status,
    softwareVersion: descriptor.versions.software,
    contractVersion: descriptor.versions.contract,
    deploymentEngineVersion: descriptor.versions.deploymentEngine,
    duplicationEngineVersion: descriptor.versions.duplicationEngine,
    lastHeartbeatAt: descriptor.dates.lastHeartbeatAt,
    secondsSinceLastHeartbeat: secondsSinceLastHeartbeat(record, context.now),
    // Compteur d'anomalies : suffit à trier « ce qui va mal » en tête sans
    // charger le détail de chaque composant.
    issues: (health.counts[HEALTH.ERROR] ?? 0) + (health.counts[HEALTH.WARNING] ?? 0),
  };
}

/** Répartition d'une clé sur le parc, en objet { valeur: nombre }. */
function countBy(rows, pick) {
  return rows.reduce((acc, row) => {
    const key = pick(row) ?? 'UNKNOWN';
    return { ...acc, [key]: (acc[key] ?? 0) + 1 };
  }, {});
}

/**
 * TABLEAU DE BORD — niveau 0 : quelques nombres, rien d'autre.
 *
 * Conçu pour rester lisible à 3 projets comme à 300 : aucune liste complète
 * n'est renvoyée, seulement des compteurs, les répartitions de versions et
 * les alertes (bornées).
 */
export async function buildDashboard({ now = Date.now(), alertLimit = 20, activityLimit = 15 } = {}) {
  const context = supervisionContext(now);
  const records = await listProjects();
  const rows = records.map((record) => toFleetRow(record, context));

  const byLiveness = countBy(rows, (r) => r.liveness);
  const byEnvironment = countBy(rows.filter((r) => r.environment), (r) => r.environment);
  const byHealth = countBy(rows, (r) => r.health);
  const byType = countBy(rows.filter((r) => r.type), (r) => r.type);

  const alerts = buildAlerts(records, context);
  const severity = countBy(alerts, (a) => a.severity);

  return {
    generatedAt: new Date(now).toISOString(),
    // Le Panel se décrit lui-même : c'est la référence de comparaison.
    panel: {
      contractVersion: CONTRACT_VERSION,
      engines: context.expectedEngines,
      thresholds: livenessThresholds(),
    },
    totals: {
      projects: rows.length,
      paired: rows.filter((r) => r.pairingStatus === 'PAIRED').length,
      online: byLiveness[LIVENESS.ONLINE] ?? 0,
      stale: byLiveness[LIVENESS.STALE] ?? 0,
      offline: byLiveness[LIVENESS.OFFLINE] ?? 0,
      neverSeen: byLiveness[LIVENESS.NEVER_SEEN] ?? 0,
      notPaired: byLiveness[LIVENESS.NOT_PAIRED] ?? 0,
      test: byEnvironment.TEST ?? 0,
      prod: byEnvironment.PROD ?? 0,
    },
    health: {
      ok: byHealth[HEALTH.OK] ?? 0,
      warning: byHealth[HEALTH.WARNING] ?? 0,
      error: byHealth[HEALTH.ERROR] ?? 0,
      unknown: byHealth[HEALTH.UNKNOWN] ?? 0,
    },
    byType,
    versions: {
      software: countBy(rows.filter((r) => r.softwareVersion), (r) => r.softwareVersion),
      contract: countBy(rows.filter((r) => r.contractVersion), (r) => r.contractVersion),
      deploymentEngine: countBy(rows.filter((r) => r.deploymentEngineVersion), (r) => r.deploymentEngineVersion),
      duplicationEngine: countBy(rows.filter((r) => r.duplicationEngineVersion), (r) => r.duplicationEngineVersion),
    },
    alerts: {
      total: alerts.length,
      error: severity.ERROR ?? 0,
      warning: severity.WARNING ?? 0,
      info: severity.INFO ?? 0,
      items: alerts.slice(0, alertLimit),
    },
    // « Ce qui demande de l'attention » — les projets en anomalie, en tête.
    attention: rows
      .filter((r) => r.issues > 0)
      .sort((a, b) => b.issues - a.issues)
      .slice(0, 10),
    recentActivity: await parkTimeline({ limit: activityLimit }),
  };
}

/** Critères de recherche reconnus (LOT 8). */
export const SEARCH_FIELDS = Object.freeze([
  'q', 'name', 'slug', 'domain', 'type', 'environment',
  'liveness', 'health', 'pairing', 'module', 'feature',
  'softwareVersion', 'contractVersion', 'deploymentEngine', 'duplicationEngine',
]);

const includes = (haystack, needle) =>
  typeof haystack === 'string' && haystack.toLowerCase().includes(String(needle).toLowerCase());

/**
 * RECHERCHE dans le parc — filtres combinables (ET logique).
 *
 * `q` est le filtre libre : il balaie nom, slug, domaine, type et versions.
 * Les autres critères sont exacts (ou « contient » pour les textes libres).
 */
export async function searchFleet(criteria = {}, { now = Date.now(), limit = 100 } = {}) {
  const context = supervisionContext(now);
  const records = await listProjects();

  const matched = records.filter((record) => {
    const row = toFleetRow(record, context);
    const capabilities = interpretCapabilities(record.manifest);

    if (criteria.q) {
      const haystack = [
        row.name, row.slug, row.primaryDomain, row.type,
        row.softwareVersion, row.contractVersion,
        row.deploymentEngineVersion, row.duplicationEngineVersion,
      ];
      if (!haystack.some((value) => includes(value, criteria.q))) return false;
    }
    if (criteria.name && !includes(row.name, criteria.name)) return false;
    if (criteria.slug && !includes(row.slug, criteria.slug)) return false;
    if (criteria.domain && !includes(row.primaryDomain, criteria.domain)) return false;
    if (criteria.type && row.type !== criteria.type) return false;
    if (criteria.environment && row.environment !== criteria.environment) return false;
    if (criteria.liveness && row.liveness !== criteria.liveness) return false;
    if (criteria.health && row.health !== criteria.health) return false;
    if (criteria.pairing && row.pairingStatus !== criteria.pairing) return false;
    if (criteria.softwareVersion && row.softwareVersion !== criteria.softwareVersion) return false;
    if (criteria.contractVersion && row.contractVersion !== criteria.contractVersion) return false;
    if (criteria.deploymentEngine && row.deploymentEngineVersion !== criteria.deploymentEngine) return false;
    if (criteria.duplicationEngine && row.duplicationEngineVersion !== criteria.duplicationEngine) return false;
    if (criteria.module && !capabilities.projectModules.active.includes(criteria.module)
        && !capabilities.projectModules.optional.includes(criteria.module)) return false;
    if (criteria.feature && !capabilities.enabled.includes(criteria.feature)
        && !capabilities.reserved.includes(criteria.feature)) return false;
    return true;
  });

  const rows = matched
    .map((record) => toFleetRow(record, context))
    // Ce qui va mal d'abord : un opérateur ouvre le Panel pour ça.
    .sort((a, b) => b.issues - a.issues || a.name.localeCompare(b.name));

  return { total: rows.length, returned: Math.min(rows.length, limit), items: rows.slice(0, limit) };
}

/**
 * FACETTES de recherche — les valeurs réellement présentes dans le parc.
 * Permet à l'interface de proposer des filtres sans les inventer.
 */
export async function searchFacets({ now = Date.now() } = {}) {
  const context = supervisionContext(now);
  const records = await listProjects();
  const rows = records.map((record) => toFleetRow(record, context));
  const distinct = (pick) => [...new Set(rows.map(pick).filter(Boolean))].sort();
  const modules = new Set();
  const features = new Set();
  for (const record of records) {
    const capabilities = interpretCapabilities(record.manifest);
    capabilities.projectModules.active.forEach((m) => modules.add(m));
    capabilities.projectModules.optional.forEach((m) => modules.add(m));
    capabilities.enabled.forEach((f) => features.add(f));
    capabilities.reserved.forEach((f) => features.add(f));
  }
  return {
    types: distinct((r) => r.type),
    environments: distinct((r) => r.environment),
    liveness: distinct((r) => r.liveness),
    health: distinct((r) => r.health),
    softwareVersions: distinct((r) => r.softwareVersion),
    contractVersions: distinct((r) => r.contractVersion),
    deploymentEngineVersions: distinct((r) => r.deploymentEngineVersion),
    duplicationEngineVersions: distinct((r) => r.duplicationEngineVersion),
    modules: [...modules].sort(),
    features: [...features].sort(),
  };
}

export { supervisionContext };
export default { buildDashboard, searchFleet, searchFacets, toFleetRow, expectedEngineVersions, SEARCH_FIELDS };
