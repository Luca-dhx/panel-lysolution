/**
 * ══ LE JOURNAL DURABLE D'UN DÉPLOIEMENT — CONTRAT, ET NON COMMODITÉ ═════════
 *
 * ── LE DÉFAUT QUE CE MODULE FERME ──────────────────────────────────────────
 *
 * Les étapes partaient en base par `void recordStep(...)`, puis par une file
 * chaînée terminée d'un `.catch(() => {})`. L'ordre était garanti ; la vérité,
 * non : une écriture perdue ne laissait AUCUNE trace, et le moteur continuait.
 * Le Panel pouvait donc franchir la bascule de release — modifier la
 * production — alors qu'il n'était plus capable de journaliser ce qu'il était
 * en train de faire. Le run restait figé à l'étape d'avant, et plus personne,
 * ni l'écran ni le démarrage suivant, ne pouvait dire jusqu'où il était allé.
 *
 * ── LES TROIS ZONES, ET POURQUOI ELLES NE SE RESSEMBLENT PAS ───────────────
 *
 *   PRE_PUBLICATION   Rien n'a changé pour le public. Une écriture perdue est
 *                     RÉDHIBITOIRE : on s'arrête, et l'ancienne version
 *                     continue de servir. C'est le seul moment où refuser
 *                     coûte moins cher que continuer.
 *
 *   FRONTIÈRE         Le moteur interroge `assertDurable()` juste avant la
 *                     première mutation observable. La dernière vérité durable
 *                     doit avoir été confirmée AVANT que le monde ne change.
 *
 *   POST_PUBLICATION  Le monde a changé ; s'arrêter ne le défait pas. Une
 *                     écriture perdue est RETENUE et DITE, jamais utilisée
 *                     pour prétendre que rien n'a été publié.
 *
 * Le cliquet est définitif : une fois la frontière franchie, aucune écriture
 * ne redevient critique. Refuser un déploiement DÉJÀ publié ne le dépublierait
 * pas — cela ferait seulement perdre le rapport de ce qui vient d'avoir lieu.
 *
 * ── CE QUE L'APPELANT NE CHOISIT PAS ───────────────────────────────────────
 *
 * Le régime d'une écriture n'est PAS un argument. Il est DÉRIVÉ du registre
 * canonique des étapes (`publicationBoundaryStep`), qui est la seule
 * définition de la frontière dans tout le dépôt. Un `recordStep(step, true)`
 * aurait laissé chaque appelant se tromper une fois — et un seul `false` au
 * mauvais endroit rouvre exactement le trou que ce module ferme.
 */
import { nowIso } from '../../bridge/bridgeContract.js';
import { isBeforePublication, publicationBoundaryStep } from '../../deployment-engine/steps.js';
import {
  appendLog as appendLogReel,
  finalizeRun as finalizeRunReel,
  recordStep as recordStepReel,
} from './deploymentRun.service.js';
import {
  DURABILITY_PHASE, RECORDER_ERRORS, RecorderWriteError, redactRecorderCause,
} from './recorderErrors.js';

export {
  DURABILITY_PHASE, RECORDER_ERRORS, RecorderWriteError, redactRecorderCause,
} from './recorderErrors.js';
export { RecorderUnavailableError } from './recorderErrors.js';

/**
 * LE MAGASIN PAR DÉFAUT — les vraies écritures.
 *
 * Il est injectable pour UNE raison, et elle est architecturale : une panne de
 * persistance ne se provoque pas en production, et un `if (test)` dans le
 * runtime rouvrirait le trou qu'on ferme. La recette fournit donc un magasin
 * qui refuse d'écrire ; le reste du chemin — moteur, barrière, finalisation —
 * est exactement celui de la production.
 */
const MAGASIN_REEL = Object.freeze({
  recordStep: recordStepReel,
  appendLog: appendLogReel,
  finalizeRun: finalizeRunReel,
});

/**
 * Ouvre le journal durable d'un run.
 *
 * @param {string} runId
 * @param {{store?: {recordStep:Function, appendLog:Function, finalizeRun:Function}}} [deps]
 */
export function createDurableRecorder(runId, { store = MAGASIN_REEL } = {}) {
  const magasin = { ...MAGASIN_REEL, ...store };

  /**
   * UNE SEULE CHAÎNE POUR LES ÉTAPES — l'ordre d'émission EST l'ordre de
   * matérialisation.
   *
   * Le moteur émet `running` puis l'état terminal de la même étape. Quand rien
   * ne les sépare (préflight, finalisation), deux écritures lancées en
   * parallèle se doublaient : `running` se déposait parfois APRÈS `ok`, l'étape
   * restait « en cours », et la conclusion la requalifiait en erreur. Des
   * étapes rouges sur un déploiement réussi.
   */
  let chaineEtapes = Promise.resolve();
  /**
   * LES LIGNES DE JOURNAL ONT LEUR PROPRE CHAÎNE.
   *
   * Les mêler aux étapes ferait dépendre la barrière de publication du débit
   * des logs : une écriture de log lente retarderait la réponse à
   * `assertDurable()`, et une écriture de log perdue REFUSERAIT une
   * publication. Un commentaire ne doit pas avoir ce pouvoir.
   */
  let chaineLogs = Promise.resolve();

  let publie = false;
  let defaillanceCritique = null;
  let defaillanceTardive = null;
  let defaillanceJournal = null;

  const panneSur = (stepId, err) => ({
    stepId: stepId ?? null,
    reason: redactRecorderCause(err),
    at: nowIso(),
  });

  return {
    /**
     * ÉCRIT UNE ÉTAPE. Le régime est DÉRIVÉ, jamais choisi (voir l'en-tête).
     *
     * Ne lève pas : la panne est RETENUE. Lever ici couperait le moteur au
     * milieu d'une phase distante, ce qui produirait un état encore moins
     * descriptible que celui qu'on cherche à éviter. Le refus est prononcé à
     * un seul endroit — la frontière — où il a un sens.
     */
    recordStep(step) {
      if (!publie && !isBeforePublication(step?.id)) publie = true;
      const critique = !publie;
      chaineEtapes = chaineEtapes
        .then(() => magasin.recordStep(runId, step))
        .catch((err) => {
          const panne = panneSur(step?.id, err);
          if (critique && !defaillanceCritique) defaillanceCritique = panne;
          if (!critique) defaillanceTardive = panne;
        });
      return chaineEtapes;
    },

    /**
     * ÉCRIT UNE LIGNE DE JOURNAL — au mieux, et son échec est RETENU.
     *
     * Une ligne de journal n'a jamais autorisé ni refusé quoi que ce soit ; sa
     * perte ne doit donc rien arrêter. Mais elle ne doit pas non plus
     * disparaître : le worker la lançait sans l'attendre ni la rattraper, ce
     * qui produisait un REJET NON GÉRÉ dès que la base tombait — et Node
     * termine le process sur un rejet non géré. Le déploiement mourait donc de
     * la perte d'un commentaire.
     */
    recordLog(message, level = 'INFO') {
      chaineLogs = chaineLogs
        .then(() => magasin.appendLog(runId, message, level))
        .catch((err) => { defaillanceJournal = panneSur(null, err); });
      return chaineLogs;
    },

    /** Attend que TOUT ce qui a été émis soit matérialisé (ou ait échoué). */
    async drain() {
      await chaineEtapes;
      await chaineLogs;
    },

    /**
     * ══ LA BARRIÈRE DE PUBLICATION, CÔTÉ ÉCRIVAIN ═════════════════════════
     *
     * Le moteur la pose et pose la question ; c'est ici qu'on y répond, parce
     * que c'est ici qu'on écrit. Elle DRAINE d'abord : répondre sans attendre
     * les écritures en vol reviendrait à certifier une durabilité qu'on n'a pas
     * encore constatée.
     */
    async assertDurable() {
      await chaineEtapes;
      if (defaillanceCritique) {
        throw new RecorderWriteError(
          `Publication refusée : l'étape « ${defaillanceCritique.stepId} » n'a pas pu être `
          + 'enregistrée durablement.',
          { stepId: defaillanceCritique.stepId, cause: defaillanceCritique.reason },
        );
      }
    },

    criticalFailure: () => defaillanceCritique,
    lateFailure: () => defaillanceTardive,
    logFailure: () => defaillanceJournal,
    published: () => publie,
    boundaryStepId: () => publicationBoundaryStep()?.id ?? null,

    /**
     * ══ CE QU'ON PEUT DIRE DE LA DURABILITÉ, UNE FOIS TOUT ÉCRIT ═══════════
     *
     * Deux pertes distinctes, et les confondre serait le mensonge que ce lot
     * interdit :
     *
     *   AVANT la frontière — elle a REFUSÉ la publication (le moteur s'est
     *   arrêté). Elle est pourtant rapportée : une perte avant la frontière
     *   n'est visible nulle part ailleurs si le déploiement a échoué pour une
     *   AUTRE raison avant même d'atteindre la barrière. Sans cela, un run
     *   pouvait avoir un journal troué sans que rien ne le dise.
     *
     *   APRÈS la frontière — elle n'a rien empêché, et ne doit rien annuler.
     */
    durabilityVerdict() {
      const perte = defaillanceTardive ?? defaillanceCritique;
      if (!perte) return { complete: true, error: null, degradedAtStepId: null };
      const tardive = Boolean(defaillanceTardive);
      return {
        complete: false,
        degradedAtStepId: perte.stepId,
        error: {
          code: tardive ? RECORDER_ERRORS.PERSISTENCE_LOST : RECORDER_ERRORS.WRITE_FAILED,
          phase: tardive ? DURABILITY_PHASE.POST_PUBLICATION : DURABILITY_PHASE.PRE_PUBLICATION,
          stepId: perte.stepId,
          reason: perte.reason,
          at: perte.at,
        },
      };
    },

    /**
     * ══ LA CONCLUSION — ET CE QU'ELLE N'A PAS LE DROIT D'ÉCRASER ═══════════
     *
     * `outcome.error` est l'erreur PRIMAIRE : ce qui a réellement fait échouer
     * le déploiement (`REMOTE_COMMAND_FAILED`, `PREFLIGHT_FAILED`…). La panne
     * de persistance voyage à côté, dans `persistenceError`, jamais à la place.
     * L'inverse ferait disparaître la cause métier derrière une panne de
     * journal — c'est-à-dire ferait chercher au mauvais endroit.
     *
     * Ne lève JAMAIS : l'échec de la conclusion est RENDU, pour que l'appelant
     * décide (et le dise) au lieu de le découvrir par une exception dans un
     * `finally`.
     */
    async finalize(outcome = {}) {
      const verdict = this.durabilityVerdict();
      try {
        const doc = await magasin.finalizeRun(runId, {
          ...outcome,
          journalComplete: verdict.complete,
          journalDegradedAtStepId: verdict.degradedAtStepId,
          persistenceError: verdict.error,
        });
        return { finalized: true, run: doc ?? null, durability: verdict, error: null };
      } catch (err) {
        return {
          finalized: false,
          run: null,
          durability: verdict,
          error: {
            code: RECORDER_ERRORS.PERSISTENCE_LOST,
            reason: redactRecorderCause(err),
            at: nowIso(),
          },
        };
      }
    },
  };
}

export default {
  createDurableRecorder,
  RECORDER_ERRORS,
  DURABILITY_PHASE,
  redactRecorderCause,
};
