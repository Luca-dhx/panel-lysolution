/**
 * ORDONNANCEUR DES COÛTS RÉCURRENTS — une commodité, jamais la garantie.
 *
 * ══ CE QU'IL AJOUTE, ET CE QU'IL N'EST PAS AUTORISÉ À PORTER ════════════════
 *
 * La matérialisation a déjà lieu à CHAQUE lecture financière : ce que quelqu'un
 * regarde est à jour au moment où il le regarde, quel que soit le temps écoulé.
 * C'est la garantie, et elle ne dépend d'aucun processus resté éveillé.
 *
 * Cet ordonnanceur ne sert qu'à un cas : personne n'ouvre le Panel pendant
 * plusieurs jours, et l'on veut quand même que les occurrences existent — pour
 * qu'un export, une lecture directe en base ou un futur rapport les trouvent.
 *
 * Il ne doit JAMAIS devenir la seule source d'écriture. Un système où le coût
 * du mois dépend d'un cron qui tourne à minuit transforme une minute
 * d'indisponibilité en un mois manquant, et personne ne s'en aperçoit avant la
 * clôture.
 *
 * ══ CADENCE ═════════════════════════════════════════════════════════════════
 *
 * Une heure. Le plus court cycle possible est le jour : sonder plus souvent ne
 * découvrirait rien de plus. Le premier passage a lieu AU DÉMARRAGE — c'est lui
 * qui rattrape les cycles d'une coupure, sans attendre l'heure suivante.
 *
 * Même forme que `eventScheduler` : minuteur unique, `unref`, garde de
 * réentrance, arrêt propre. Deux ordonnanceurs du même dépôt qui se
 * comporteraient différemment finiraient par être débogués deux fois.
 */
import logger from '../../utils/logger.js';
import { materializeAllDue } from './recurringCosts.service.js';

const TICK_MS = 3_600_000;

let timer = null;
let enCours = false;

/**
 * Un cycle. Se protège de lui-même : si un passage dure plus longtemps que
 * l'intervalle, le suivant s'efface plutôt que de travailler en double.
 *
 * Il n'a de toute façon pas besoin de cette garde pour être correct —
 * l'unicité vient de l'index `{sourceId, cycleKey}` — mais deux passages
 * simultanés produiraient des erreurs de clé dupliquée pour rien.
 */
export async function runRecurringCostCycle() {
  if (enCours) return { skipped: true };
  enCours = true;
  try {
    const rapport = await materializeAllDue({});
    if (rapport.created) {
      logger.info(`[finance] ${rapport.created} occurrence(s) de coût récurrent portée(s) au registre.`);
    }
    if (rapport.overflow) {
      logger.warn(`[finance] ${rapport.overflow} récurrence(s) encore en retard : rattrapage borné, poursuite au cycle suivant.`);
    }
    return rapport;
  } catch (err) {
    // Un cycle raté sera revu au suivant, et de toute façon à la prochaine
    // lecture d'écran. Inutile de bruire.
    logger.warn(`[finance] Cycle des coûts récurrents interrompu : ${err.message}`);
    return { definitions: 0, created: 0, error: err.message };
  } finally {
    enCours = false;
  }
}

export function startRecurringCostScheduler({ intervalMs = TICK_MS } = {}) {
  if (timer) return timer;
  void runRecurringCostCycle();
  timer = setInterval(() => { void runRecurringCostCycle(); }, intervalMs);
  timer.unref?.();
  logger.info(`Coûts récurrents : matérialisation toutes les ${Math.round(intervalMs / 60_000)} min.`);
  return timer;
}

export function stopRecurringCostScheduler() {
  if (!timer) return false;
  clearInterval(timer);
  timer = null;
  return true;
}

export function isRecurringCostSchedulerRunning() {
  return timer !== null;
}

export default {
  startRecurringCostScheduler,
  stopRecurringCostScheduler,
  runRecurringCostCycle,
  isRecurringCostSchedulerRunning,
};
