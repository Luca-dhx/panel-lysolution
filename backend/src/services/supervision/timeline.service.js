// CHRONOLOGIE — Phase 3A.
//
// Règle de la phase : **le Panel ne crée aucun événement métier.** Il
// enregistre soit ce qu'un projet a déclaré, soit un CONSTAT de changement
// entre deux publications successives. Chaque entrée porte sa `source`, si
// bien qu'on ne confond jamais « le projet a dit » et « le Panel a remarqué ».
//
// Aucune entrée n'est une action : rien ici ne modifie un projet.
import config from '../../config/env.js';
import { EVENT_TYPES, PanelEvent } from '../../models/PanelSupervision.model.js';
import { nowIso } from '../../bridge/bridgeContract.js';

/** Enregistre un événement, puis borne l'historique du projet. */
export async function recordEvent({
  projectId, type, source, severity = 'INFO', summary, data = null, occurredAt = nowIso(),
}) {
  const event = { projectId, occurredAt, type, source, severity, summary, data };
  await PanelEvent.create(event);
  await pruneTimeline(projectId);
  return event;
}

/** Rétention bornée : la chronologie ne doit pas croître sans fin. */
async function pruneTimeline(projectId) {
  const limit = config.timelineHistorySize;
  const total = await PanelEvent.countDocuments({ projectId });
  if (total <= limit) return;
  const obsolete = await PanelEvent.find({ projectId })
    .sort({ occurredAt: -1 })
    .skip(limit)
    .select('_id')
    .lean();
  if (obsolete.length > 0) {
    await PanelEvent.deleteMany({ _id: { $in: obsolete.map((e) => e._id) } });
  }
}

/**
 * CONSTATS déduits de la comparaison entre l'état connu et un heartbeat
 * entrant. C'est la seule « intelligence » du Panel : remarquer un
 * changement. Il ne l'interprète pas, il le date.
 *
 * @param {object} previous  état runtime AVANT le heartbeat
 * @param {object} incoming  heartbeat validé
 * @returns {object[]} événements à enregistrer (source PANEL_OBSERVATION)
 */
export function diffObservations(previous = {}, incoming = {}) {
  const events = [];
  const observe = (type, severity, summary, data) =>
    events.push({ type, source: 'PANEL_OBSERVATION', severity, summary, data });

  // Version applicative : un changement signale un déploiement côté projet.
  const before = previous.softwareVersion ?? null;
  const after = incoming.softwareVersion ?? null;
  if (after && before && after !== before) {
    observe(EVENT_TYPES.VERSION_CHANGED, 'INFO',
      `Version applicative : ${before} → ${after}.`, { from: before, to: after });
    observe(EVENT_TYPES.DEPLOYMENT_DETECTED, 'INFO',
      `Déploiement détecté (nouvelle version ${after}).`, { version: after });
  }

  // Environnement : passer de TEST à PROD est un fait majeur.
  if (incoming.environment && previous.environment && incoming.environment !== previous.environment) {
    observe(EVENT_TYPES.ENVIRONMENT_CHANGED, 'WARNING',
      `Environnement : ${previous.environment} → ${incoming.environment}.`,
      { from: previous.environment, to: incoming.environment });
  }

  // Santé déclarée.
  const healthBefore = previous.lastHealth?.status ?? null;
  const healthAfter = incoming.health?.status ?? null;
  if (healthAfter && healthBefore && healthAfter !== healthBefore) {
    observe(EVENT_TYPES.HEALTH_CHANGED, healthAfter === 'OK' ? 'INFO' : 'WARNING',
      `Santé déclarée : ${healthBefore} → ${healthAfter}.`, { from: healthBefore, to: healthAfter });
  }

  // Moteurs standards.
  for (const [key, label] of [['deployment', 'moteur de déploiement'], ['duplication', 'moteur de duplication']]) {
    const engineBefore = previous.engines?.[key] ?? null;
    const engineAfter = incoming.engines?.[key] ?? null;
    if (engineAfter && engineBefore && engineAfter !== engineBefore) {
      observe(EVENT_TYPES.ENGINE_VERSION_CHANGED, 'INFO',
        `Version du ${label} : ${engineBefore} → ${engineAfter}.`,
        { engine: key, from: engineBefore, to: engineAfter });
    }
  }

  // Redémarrage : l'uptime repart à zéro alors qu'il était plus élevé.
  const uptimeBefore = previous.uptimeSeconds ?? null;
  const uptimeAfter = incoming.runtime?.uptimeSeconds ?? null;
  if (uptimeAfter !== null && uptimeBefore !== null && uptimeAfter < uptimeBefore) {
    observe(EVENT_TYPES.BRIDGE_RECONNECTED, 'INFO',
      'Redémarrage du projet détecté (uptime réinitialisé).',
      { previousUptimeSeconds: uptimeBefore, uptimeSeconds: uptimeAfter });
  }

  return events;
}

/** Chronologie d'un projet, du plus récent au plus ancien. */
export async function projectTimeline(projectId, { limit = 50 } = {}) {
  const events = await PanelEvent.find({ projectId })
    .sort({ occurredAt: -1 })
    .limit(Math.min(Math.max(1, limit), 500))
    .lean();
  return events.map(({ _id, ...event }) => event);
}

/** Chronologie du PARC entier — la vue « il s'est passé quoi récemment ? ». */
export async function parkTimeline({ limit = 50 } = {}) {
  const events = await PanelEvent.find({})
    .sort({ occurredAt: -1 })
    .limit(Math.min(Math.max(1, limit), 500))
    .lean();
  return events.map(({ _id, ...event }) => event);
}

export { EVENT_TYPES };
export default { recordEvent, diffObservations, projectTimeline, parkTimeline, EVENT_TYPES };
