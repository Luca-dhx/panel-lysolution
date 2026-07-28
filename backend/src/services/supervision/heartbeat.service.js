// HEARTBEATS — réception passive et historique.
//
// « Passif » est le mot important : le Panel n'interroge JAMAIS un projet
// pour savoir s'il est vivant. Il attend que le projet parle. Un projet qui
// se tait produit un silence observable — pas une sonde.
//
// Chaque heartbeat est : archivé (tendance), résumé sur la fiche (dernier
// état), et comparé au précédent pour alimenter la chronologie.
import config from '../../config/env.js';
import { nowIso } from '../../bridge/bridgeContract.js';
import { PanelHeartbeat } from '../../models/PanelSupervision.model.js';
import { diffObservations, recordEvent, EVENT_TYPES } from './timeline.service.js';

/**
 * Archive un heartbeat et renvoie les observations qui en découlent.
 *
 * @param {object} record    fiche projet, AVANT mise à jour
 * @param {object} heartbeat DTO validé par le miroir de contrat
 */
export async function archiveHeartbeat(record, heartbeat) {
  const receivedAt = nowIso();
  await PanelHeartbeat.create({
    projectId: record.projectId,
    receivedAt,
    sentAt: heartbeat.sentAt,
    softwareVersion: heartbeat.softwareVersion ?? null,
    environment: heartbeat.environment ?? null,
    healthStatus: heartbeat.health?.status ?? null,
    healthDetails: heartbeat.health?.details ?? null,
    uptimeSeconds: heartbeat.runtime?.uptimeSeconds ?? null,
    load: heartbeat.runtime?.load ?? null,
    components: heartbeat.runtime?.components ?? null,
    engines: heartbeat.engines ?? null,
    bridgeStats: heartbeat.bridgeStats ?? null,
  });
  await pruneHistory(record.projectId);

  // Constats de changement — comparés à l'état AVANT ce heartbeat.
  const observations = diffObservations(record.runtime ?? {}, heartbeat);
  for (const observation of observations) {
    await recordEvent({ ...observation, projectId: record.projectId, occurredAt: receivedAt });
  }
  return { receivedAt, observations };
}

/** Rétention bornée de l'historique, par projet. */
async function pruneHistory(projectId) {
  const limit = config.heartbeatHistorySize;
  const total = await PanelHeartbeat.countDocuments({ projectId });
  if (total <= limit) return;
  const obsolete = await PanelHeartbeat.find({ projectId })
    .sort({ receivedAt: -1 })
    .skip(limit)
    .select('_id')
    .lean();
  if (obsolete.length > 0) {
    await PanelHeartbeat.deleteMany({ _id: { $in: obsolete.map((h) => h._id) } });
  }
}

/** Historique d'un projet, du plus récent au plus ancien. */
export async function heartbeatHistory(projectId, { limit = 50 } = {}) {
  const rows = await PanelHeartbeat.find({ projectId })
    .sort({ receivedAt: -1 })
    .limit(Math.min(Math.max(1, limit), 500))
    .lean();
  return rows.map(({ _id, ...row }) => row);
}

/**
 * Statistiques de réception d'un projet — utiles pour juger la RÉGULARITÉ du
 * signal, pas seulement sa présence. Un projet qui envoie un heartbeat sur
 * deux est « ONLINE » mais mérite d'être regardé.
 */
export async function heartbeatStats(projectId, { sample = 50 } = {}) {
  const rows = await heartbeatHistory(projectId, { limit: sample });
  if (rows.length === 0) {
    return { count: 0, first: null, last: null, averageIntervalS: null, expectedIntervalS: config.heartbeatIntervalS, regular: null };
  }
  const times = rows.map((r) => new Date(r.receivedAt).getTime()).sort((a, b) => a - b);
  let averageIntervalS = null;
  if (times.length > 1) {
    const spans = times.slice(1).map((t, i) => (t - times[i]) / 1000);
    averageIntervalS = Math.round(spans.reduce((a, b) => a + b, 0) / spans.length);
  }
  return {
    count: rows.length,
    first: new Date(times[0]).toISOString(),
    last: new Date(times[times.length - 1]).toISOString(),
    averageIntervalS,
    expectedIntervalS: config.heartbeatIntervalS,
    // « Régulier » = cadence moyenne dans une tolérance de 50 % de l'attendu.
    regular: averageIntervalS === null
      ? null
      : averageIntervalS <= config.heartbeatIntervalS * 1.5,
  };
}

export { EVENT_TYPES };
export default { archiveHeartbeat, heartbeatHistory, heartbeatStats };
