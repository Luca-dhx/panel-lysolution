// MODÈLE DE SANTÉ — Phase 3A, LECTURE SEULE.
//
// Principe directeur : le Panel ne SONDE rien et ne DEVINE rien. Il agrège ce
// que les projets publient. Ce qu'un projet ne publie pas vaut `UNKNOWN` —
// jamais `OK` (un silence n'est pas une bonne nouvelle), jamais `ERROR` (un
// silence n'est pas une panne).
//
// C'est la différence entre un tableau de bord honnête et un tableau de bord
// rassurant.
import config from '../../config/env.js';
import { deriveLiveness, LIVENESS, livenessThresholds } from './liveness.service.js';

export const HEALTH = Object.freeze({
  OK: 'OK',
  WARNING: 'WARNING',
  ERROR: 'ERROR',
  UNKNOWN: 'UNKNOWN',
});

/** Ordre de gravité : le statut global est le pire des composants. */
const SEVERITY_ORDER = [HEALTH.OK, HEALTH.UNKNOWN, HEALTH.WARNING, HEALTH.ERROR];

export function worstOf(statuses) {
  return statuses.reduce(
    (worst, status) =>
      SEVERITY_ORDER.indexOf(status) > SEVERITY_ORDER.indexOf(worst) ? status : worst,
    HEALTH.OK,
  );
}

/**
 * Composants standards supervisés. Un projet peut en publier d'autres via
 * `heartbeat.runtime.components` : ils sont repris tels quels.
 */
export const STANDARD_COMPONENTS = Object.freeze([
  'bridge',
  'heartbeat',
  'backend',
  'frontend',
  'mongo',
  'ssl',
  'dns',
  'deploymentEngine',
  'duplicationEngine',
]);

const component = (id, status, detail, source) => ({ id, status, detail, source });

/**
 * Santé d'un projet, composant par composant.
 *
 * `source` dit d'où vient chaque verdict — c'est essentiel pour ne pas
 * confondre « le projet dit que sa base va bien » et « le Panel suppose que
 * sa base va bien » :
 *   · PROJECT     : publié par le projet dans son heartbeat
 *   · PANEL       : constat du Panel sur des faits qu'il détient (silence,
 *                   version de contrat incompatible, dérive de moteur)
 *   · UNAVAILABLE : personne ne le sait
 *
 * @param {object} record        fiche projet
 * @param {object} [context]     { now, expectedEngines, panelContractVersion }
 */
export function buildProjectHealth(record, context = {}) {
  const now = context.now ?? Date.now();
  const liveness = deriveLiveness(record, now);
  const runtime = record?.runtime ?? {};
  const published = runtime.components ?? {};
  const components = [];

  // — Pont : appairage + compatibilité de contrat ---------------------------
  if (record?.pairing?.status !== 'PAIRED') {
    components.push(component('bridge', HEALTH.UNKNOWN,
      'Projet non appairé : aucune information de pont.', 'PANEL'));
  } else {
    const projectContract = runtime.contractVersion;
    const panelContract = context.panelContractVersion;
    if (!projectContract) {
      components.push(component('bridge', HEALTH.UNKNOWN,
        'Version de contrat non publiée.', 'PANEL'));
    } else if (panelContract && projectContract.split('.')[0] !== panelContract.split('.')[0]) {
      components.push(component('bridge', HEALTH.ERROR,
        `Majeure de contrat incompatible : projet ${projectContract}, Panel ${panelContract}.`, 'PANEL'));
    } else if (panelContract && projectContract !== panelContract) {
      components.push(component('bridge', HEALTH.WARNING,
        `Contrat en retard : projet ${projectContract}, Panel ${panelContract}.`, 'PANEL'));
    } else {
      components.push(component('bridge', HEALTH.OK, `Contrat ${projectContract}.`, 'PANEL'));
    }
  }

  // — Heartbeat : silence observable ---------------------------------------
  const thresholds = livenessThresholds();
  const heartbeatStatus = {
    [LIVENESS.ONLINE]: HEALTH.OK,
    [LIVENESS.STALE]: HEALTH.WARNING,
    [LIVENESS.OFFLINE]: HEALTH.ERROR,
    [LIVENESS.NEVER_SEEN]: HEALTH.UNKNOWN,
    [LIVENESS.NOT_PAIRED]: HEALTH.UNKNOWN,
  }[liveness];
  const heartbeatDetail = {
    [LIVENESS.ONLINE]: 'Signal reçu dans les délais.',
    [LIVENESS.STALE]: `Aucun signal depuis plus de ${thresholds.staleAfterS} s.`,
    [LIVENESS.OFFLINE]: `Aucun signal depuis plus de ${thresholds.offlineAfterS} s.`,
    [LIVENESS.NEVER_SEEN]: 'Appairé, mais aucun signal reçu à ce jour.',
    [LIVENESS.NOT_PAIRED]: 'Projet non appairé : aucun signal attendu.',
  }[liveness];
  components.push(component('heartbeat', heartbeatStatus, heartbeatDetail, 'PANEL'));

  // — Backend : ce que le projet déclare de lui-même ------------------------
  if (runtime.lastHealth?.status === 'OK') {
    components.push(component('backend', HEALTH.OK, 'Le projet se déclare en bonne santé.', 'PROJECT'));
  } else if (runtime.lastHealth?.status === 'DEGRADED') {
    components.push(component('backend', HEALTH.WARNING,
      runtime.lastHealth.details || 'Le projet se déclare dégradé.', 'PROJECT'));
  } else {
    components.push(component('backend', HEALTH.UNKNOWN, 'Aucune santé publiée.', 'UNAVAILABLE'));
  }

  // — Composants publiés par le projet (frontend, mongo, ssl, dns…) ---------
  for (const id of ['frontend', 'mongo', 'ssl', 'dns']) {
    const declared = published[id];
    if (declared) {
      components.push(component(id, declared, `État publié par le projet : ${declared}.`, 'PROJECT'));
    } else {
      components.push(component(id, HEALTH.UNKNOWN,
        'Le projet ne publie pas cet état (contrat < 1.2.0, ou composant non instrumenté).', 'UNAVAILABLE'));
    }
  }

  // — Moteurs : dérive de version détectable sans lire le code du projet ----
  for (const [id, key] of [['deploymentEngine', 'deployment'], ['duplicationEngine', 'duplication']]) {
    const version = runtime.engines?.[key];
    const expected = context.expectedEngines?.[key];
    if (!version) {
      components.push(component(id, HEALTH.UNKNOWN, 'Version de moteur non publiée.', 'UNAVAILABLE'));
    } else if (!expected) {
      components.push(component(id, HEALTH.OK, `Version ${version}.`, 'PROJECT'));
    } else if (version === expected) {
      components.push(component(id, HEALTH.OK, `Version ${version}, alignée.`, 'PANEL'));
    } else if (version.split('.')[0] !== expected.split('.')[0]) {
      components.push(component(id, HEALTH.ERROR,
        `Majeure divergente : projet ${version}, standard ${expected}.`, 'PANEL'));
    } else {
      components.push(component(id, HEALTH.WARNING,
        `Version en retard : projet ${version}, standard ${expected}.`, 'PANEL'));
    }
  }

  // — Composants NON standards publiés par le projet : repris tels quels ----
  for (const [id, status] of Object.entries(published)) {
    if (components.some((c) => c.id === id)) continue;
    components.push(component(id, status, `État publié par le projet : ${status}.`, 'PROJECT'));
  }

  const status = worstOf(components.map((c) => c.status));
  return {
    status,
    liveness,
    components,
    counts: components.reduce((acc, c) => ({ ...acc, [c.status]: (acc[c.status] ?? 0) + 1 }), {}),
    evaluatedAt: new Date(now).toISOString(),
  };
}

/**
 * ALERTES du parc — uniquement des CONSTATS, jamais des actions proposées
 * (la Phase 3A est en lecture seule).
 */
export function buildAlerts(records, context = {}) {
  const now = context.now ?? Date.now();
  const alerts = [];
  const push = (severity, code, projectId, projectName, message) =>
    alerts.push({ severity, code, projectId, projectName, message });

  for (const record of records) {
    const health = buildProjectHealth(record, { ...context, now });
    const name = record.projectName;

    if (health.liveness === LIVENESS.OFFLINE) {
      push('ERROR', 'HEARTBEAT_MISSING', record.projectId, name,
        'Aucun heartbeat reçu depuis le seuil hors ligne.');
    } else if (health.liveness === LIVENESS.STALE) {
      push('WARNING', 'HEARTBEAT_LATE', record.projectId, name,
        'Le dernier heartbeat vieillit : signal périmé.');
    }

    const bridge = health.components.find((c) => c.id === 'bridge');
    if (bridge?.status === HEALTH.ERROR) {
      push('ERROR', 'BRIDGE_INCOMPATIBLE', record.projectId, name, bridge.detail);
    } else if (bridge?.status === HEALTH.WARNING) {
      push('WARNING', 'BRIDGE_OUTDATED', record.projectId, name, bridge.detail);
    }

    for (const id of ['deploymentEngine', 'duplicationEngine']) {
      const engine = health.components.find((c) => c.id === id);
      if (engine?.status === HEALTH.ERROR) {
        push('ERROR', 'ENGINE_DRIFT', record.projectId, name, `${id} : ${engine.detail}`);
      } else if (engine?.status === HEALTH.WARNING) {
        push('WARNING', 'ENGINE_OUTDATED', record.projectId, name, `${id} : ${engine.detail}`);
      }
    }

    // Certificat : le Panel n'inspecte AUCUN certificat (ce serait une sonde
    // réseau). Il ne relaie qu'une date d'expiration publiée par le projet.
    const expiry = record.runtime?.certificate?.expiresAt;
    if (expiry) {
      const daysLeft = Math.floor((new Date(expiry).getTime() - now) / 86_400_000);
      if (daysLeft < 0) {
        push('ERROR', 'CERTIFICATE_EXPIRED', record.projectId, name,
          `Certificat expiré depuis ${Math.abs(daysLeft)} jour(s).`);
      } else if (daysLeft <= config.certificateWarningDays) {
        push('WARNING', 'CERTIFICATE_EXPIRING', record.projectId, name,
          `Certificat expirant dans ${daysLeft} jour(s).`);
      }
    }

    const softwareVersions = context.softwareVersions ?? {};
    const latest = softwareVersions[record.manifest?.descriptor?.type ?? '_'];
    if (latest && record.runtime?.softwareVersion && record.runtime.softwareVersion !== latest) {
      push('INFO', 'SOFTWARE_OUTDATED', record.projectId, name,
        `Version applicative ${record.runtime.softwareVersion}, dernière connue ${latest}.`);
    }
  }

  const rank = { ERROR: 0, WARNING: 1, INFO: 2 };
  return alerts.sort((a, b) => rank[a.severity] - rank[b.severity]);
}

export default { HEALTH, STANDARD_COMPONENTS, buildProjectHealth, buildAlerts, worstOf };
