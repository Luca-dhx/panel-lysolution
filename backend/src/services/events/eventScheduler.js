/**
 * DÉTECTION DES ÉCHÉANCES — côté serveur, jamais côté page ouverte.
 *
 * ── POURQUOI PAS DANS LE NAVIGATEUR ─────────────────────────────────────────
 * Un événement doit devenir « à confirmer » même si personne n'a le Panel
 * ouvert. Faire dépendre la détection d'un onglet ferait qu'un lundi matin
 * sans connexion effacerait toutes les échéances du week-end.
 *
 * À l'échéance, une réunion passe « à confirmer » et engendre UN événement en
 * attente. Elle n'est jamais déclarée tenue : seul un humain le sait.
 *
 * ── CADENCE ─────────────────────────────────────────────────────────────────
 * Une minute. Un rendez-vous ne se compte pas à la seconde, et une requête
 * indexée par minute ne coûte rien. Le premier passage a lieu au démarrage :
 * si le Panel a été arrêté une nuit, les échéances de la nuit sont rattrapées
 * immédiatement, pas une minute plus tard.
 *
 * ── ARRÊT PROPRE ────────────────────────────────────────────────────────────
 * `stopEventScheduler()` coupe le minuteur et le repasse à `null` : un second
 * appel ne fait rien, et rien ne survit à l'arrêt du serveur. Le minuteur est
 * `unref` — il n'empêche jamais le processus de se terminer.
 */
import logger from '../../utils/logger.js';
import { convertDueMeetings } from './meetings.service.js';

const TICK_MS = 60_000;

let timer = null;
let enCours = false;

/**
 * Un cycle. Se protège de lui-même : si un passage dure plus longtemps que
 * l'intervalle, le suivant s'efface plutôt que de travailler en double.
 */
export async function runEventCycle() {
  if (enCours) return { skipped: true };
  enCours = true;
  try {
    return await convertDueMeetings();
  } catch (err) {
    // Une échéance ratée sera revue au cycle suivant : inutile de bruire.
    logger.warn(`Cycle des événements interrompu : ${err.message}`);
    return { meetings: 0, events: 0, error: err.message };
  } finally {
    enCours = false;
  }
}

export function startEventScheduler({ intervalMs = TICK_MS } = {}) {
  if (timer) return timer;
  void runEventCycle();
  timer = setInterval(() => { void runEventCycle(); }, intervalMs);
  timer.unref?.();
  logger.info(`Échéances des événements : vérification toutes les ${Math.round(intervalMs / 1000)} s.`);
  return timer;
}

export function stopEventScheduler() {
  if (!timer) return false;
  clearInterval(timer);
  timer = null;
  return true;
}

export function isEventSchedulerRunning() {
  return timer !== null;
}

export default { startEventScheduler, stopEventScheduler, runEventCycle, isEventSchedulerRunning };
