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
import { convergePendingRevenue } from './providerRevenue/revenueProjection.service.js';
import { convergePendingRefunds } from './refunds/refundOrchestration.service.js';

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

    /**
     * ── LES REVENUS FOURNISSEUR CONVERGENT DANS LE MÊME CYCLE (L10.3) ──────
     *
     * Un SEUL minuteur pour les deux convergences financières. En ouvrir un
     * second aurait doublé les réglages, les arrêts propres et les gardes de
     * réentrance, pour deux traitements qui répondent à la même question :
     * « qu'est-ce qui aurait dû être écrit et ne l'est pas encore ? ».
     *
     * Ce n'est pas la garantie — la projection a lieu à la réception du
     * webhook, et la convergence rejoue aussi à chaque lecture financière.
     * C'est le filet pour un fait dont le déclencheur a manqué.
     */
    const revenus = await convergePendingRevenue({}).catch((err) => {
      logger.warn(`[finance] Convergence des revenus fournisseur impossible : ${err.message}`);
      return { projected: 0 };
    });
    if (revenus.projected) {
      logger.info(`[finance] ${revenus.projected} revenu(s) fournisseur en attente projeté(s).`);
    }

    /**
     * ── LES REMBOURSEMENTS INDÉTERMINÉS CONVERGENT ICI, ET NULLE PART AILLEURS
     *   (L10.4) ─────────────────────────────────────────────────────────────
     *
     * ══ POURQUOI PAS À LA LECTURE, COMME LES DEUX AUTRES ══════════════════
     *
     * Parce que celle-ci PARLE À STRIPE. Les deux convergences précédentes
     * rejouent une résolution sur des faits déjà reçus — aucun octet ne sort.
     * Reprendre un remboursement dont l'issue est inconnue exige au contraire
     * de relire les remboursements du paiement chez le fournisseur.
     *
     * La brancher sur l'ouverture d'un écran ferait exactement ce que L10.3 a
     * interdit : « liste financière → appel provider live ». Un opérateur qui
     * consulte le livret déclencherait des appels Stripe, et une page rafraîchie
     * en boucle en déclencherait autant.
     *
     * L'ordonnanceur est le bon endroit : il tourne sans lecteur, il est borné,
     * et un remboursement indéterminé n'a pas besoin d'être résolu à la seconde
     * — il a besoin de l'être SÛREMENT. L'écran, lui, dit « vérification en
     * cours » et refuse d'en proposer un second : c'est ce qui protège l'argent,
     * pas la fraîcheur de la réponse.
     */
    const remboursements = await convergePendingRefunds({}).catch((err) => {
      logger.warn(`[finance] Convergence des remboursements impossible : ${err.message}`);
      return { settled: 0 };
    });
    if (remboursements.settled) {
      logger.info(`[finance] ${remboursements.settled} remboursement(s) indéterminé(s) résolu(s).`);
    }

    return {
      ...rapport,
      revenueProjected: revenus.projected ?? 0,
      refundsSettled: remboursements.settled ?? 0,
    };
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
