// VIVACITÉ — ONLINE / STALE / OFFLINE, dérivée des heartbeats reçus.
//
// Fonction PURE, jamais stockée : la vivacité est un calcul sur l'horloge,
// pas un état. La matérialiser produirait des fiches « ONLINE » figées dans
// une base après l'arrêt du Panel.
//
// Seuils CONFIGURABLES (docs/architecture/35_HEARTBEATS.md) : exprimés en
// multiples de l'intervalle de heartbeat attendu, parce que c'est le projet
// qui décide de sa cadence — un parc lent n'a pas les tolérances d'un parc
// local.
import config from '../../config/env.js';

export const LIVENESS = Object.freeze({
  NOT_PAIRED: 'NOT_PAIRED',
  NEVER_SEEN: 'NEVER_SEEN',
  ONLINE: 'ONLINE',
  STALE: 'STALE',
  OFFLINE: 'OFFLINE',
});

/** Seuils effectifs, en secondes. */
export function livenessThresholds(overrides = {}) {
  const intervalS = overrides.intervalS ?? config.heartbeatIntervalS;
  const staleFactor = overrides.staleFactor ?? config.livenessStaleFactor;
  const offlineFactor = overrides.offlineFactor ?? config.livenessOfflineFactor;
  return {
    intervalS,
    staleFactor,
    offlineFactor,
    staleAfterS: intervalS * staleFactor,
    offlineAfterS: intervalS * offlineFactor,
  };
}

/**
 * Vivacité d'un projet.
 *
 * Ordre des règles — il compte :
 *   1. non appairé            → NOT_PAIRED (aucune attente de signal)
 *   2. appairé, jamais vu     → NEVER_SEEN (différent de OFFLINE : on n'a
 *                               jamais eu de signal, ce n'est pas une perte)
 *   3. signal récent          → ONLINE
 *   4. signal vieillissant    → STALE
 *   5. au-delà                → OFFLINE
 *
 * @param {object} record  fiche projet
 * @param {number} [now]   horodatage de référence (injectable pour les tests)
 */
export function deriveLiveness(record, now = Date.now(), overrides = {}) {
  if (record?.pairing?.status !== 'PAIRED') return LIVENESS.NOT_PAIRED;
  const lastSeen = record?.runtime?.lastHeartbeatAt;
  if (!lastSeen) return LIVENESS.NEVER_SEEN;

  const { staleAfterS, offlineAfterS } = livenessThresholds(overrides);
  const elapsedS = (now - new Date(lastSeen).getTime()) / 1000;
  if (elapsedS < staleAfterS) return LIVENESS.ONLINE;
  if (elapsedS < offlineAfterS) return LIVENESS.STALE;
  return LIVENESS.OFFLINE;
}

/** Secondes écoulées depuis le dernier signal, ou null si jamais vu. */
export function secondsSinceLastHeartbeat(record, now = Date.now()) {
  const lastSeen = record?.runtime?.lastHeartbeatAt;
  if (!lastSeen) return null;
  return Math.max(0, Math.round((now - new Date(lastSeen).getTime()) / 1000));
}

export default { LIVENESS, deriveLiveness, livenessThresholds, secondsSinceLastHeartbeat };
