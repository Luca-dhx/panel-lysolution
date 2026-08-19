import {
  RUN_MODES,
  STEP_STATUS,
  assertKnownStatus,
  assertKnownStep,
  canonicalStep,
  stepsForMode,
} from './steps.js';

/**
 * LE TRACEUR D'ÉTAPES DE DÉPLOIEMENT — définition d'un côté, exécution de
 * l'autre.
 *
 * ══ CE QU'IL AJOUTE À `emitStep` ════════════════════════════════════════════
 *
 * `emitStep` faisait déjà deux choses justes : il résolvait le libellé depuis le
 * registre, et il tenait la liste des étapes OUVERTES pour qu'aucune ne reste
 * « en cours » à l'écran pour l'éternité.
 *
 * Il ne vérifiait rien d'autre. Un identifiant mal orthographié — `nginx.config`
 * au lieu de `nginx.configure` — produisait un événement d'apparence normale,
 * portant son propre identifiant comme libellé, ignoré par la checklist. Aucune
 * erreur, aucune trace : juste une ligne qui n'arrive jamais.
 *
 * Ce module transforme l'émission en point de contrôle :
 *
 *   · l'étape doit exister DANS LE REGISTRE ;
 *   · le statut doit appartenir au vocabulaire fermé ;
 *   · la transition doit être licite ;
 *   · l'état de chaque étape est mémorisé, ce qui rend calculable la question
 *     « ce déploiement a-t-il vraiment fait tout ce qu'il devait ? ».
 *
 * ══ POURQUOI IL N'EST PAS CELUI DE LA DUPLICATION ═══════════════════════════
 *
 * La doctrine est la même, le graphe ne l'est pas. Le déploiement possède un
 * état `warning` réellement utilisé (une vérification DNS qui aboutit en
 * signalant une propagation incomplète), une notion de MODE (`PRECHECK` exécute
 * le prologue puis s'arrête), et des étapes conditionnelles au fournisseur DNS.
 * Réemployer le traceur de duplication aurait obligé à y ajouter tout cela,
 * pour deux moteurs qui n'ont pas les mêmes invariants.
 */

/**
 * LES TRANSITIONS LICITES.
 *
 *     pending ──→ running ──→ ok | warning | error | cancelled
 *     pending ──→ skipped
 *
 * Ce qui est refusé mérite d'être nommé :
 *
 *   · `pending → ok` : une étape déclarée réussie sans avoir commencé. C'est le
 *     mensonge que ce lot existe pour rendre impossible ;
 *   · `ok → running` : une étape terminée qui recommence — donc un ordre faux,
 *     ou deux chemins du moteur qui se croisent ;
 *   · `error → ok` : un échec effacé par une réussite ultérieure. Après la
 *     frontière de publication, cette réécriture ferait disparaître du rapport
 *     le fait qu'une version cassée a été mise en ligne ;
 *   · `running → running` : deux départs pour une même étape.
 *
 * `error → cancelled` est en revanche AUTORISÉ : le filet de dernier recours du
 * moteur clôt les étapes restées ouvertes, et une interruption d'opérateur peut
 * arriver pendant qu'une erreur se propage.
 */
const TRANSITIONS = Object.freeze({
  [STEP_STATUS.PENDING]: [
    STEP_STATUS.RUNNING,
    STEP_STATUS.SKIPPED,
    /**
     * `pending → warning` EST AUTORISÉ, et c'est une exception documentée.
     *
     * Sans fournisseur DNS, le moteur signale « gestion automatique du domaine
     * non configurée » sur `dns.provider` sans jamais l'avoir démarrée : il n'y
     * avait rien à exécuter, mais l'exploitant doit le savoir. L'alternative —
     * un `skipped` muet — perdrait précisément le message qui explique pourquoi
     * les adresses ne se configurent pas toutes seules.
     */
    STEP_STATUS.WARNING,
  ],
  [STEP_STATUS.RUNNING]: [
    STEP_STATUS.OK,
    STEP_STATUS.WARNING,
    STEP_STATUS.ERROR,
    STEP_STATUS.CANCELLED,
    STEP_STATUS.SKIPPED,
  ],
  [STEP_STATUS.OK]: [],
  [STEP_STATUS.WARNING]: [],
  [STEP_STATUS.ERROR]: [STEP_STATUS.CANCELLED],
  [STEP_STATUS.SKIPPED]: [],
  [STEP_STATUS.CANCELLED]: [],
});

/** Les états qui closent une étape — par réussite, par tolérance ou par renoncement. */
const ETATS_FINAUX = new Set([
  STEP_STATUS.OK,
  STEP_STATUS.WARNING,
  STEP_STATUS.SKIPPED,
  STEP_STATUS.CANCELLED,
]);

export class StepProtocolError extends Error {
  constructor(message) {
    super(message);
    this.name = 'StepProtocolError';
    this.code = 'DEPLOYMENT_STEP_PROTOCOL';
  }
}

/**
 * Crée un traceur pour UN déploiement.
 *
 * @param {object}   options
 * @param {string}   [options.mode]   DEPLOYMENT | PRECHECK — décide des étapes
 *                                    applicables, donc de ce qui est exigible.
 * @param {boolean}  [options.strict] Lever sur violation (défaut) ; sinon
 *                                    signaler sans interrompre.
 */
export function createDeploymentStepTracker({ mode = RUN_MODES.DEPLOYMENT, strict = true } = {}) {
  /** id → { status } */
  const etats = new Map();
  const violations = [];

  const lire = (id) => etats.get(id)?.status ?? STEP_STATUS.PENDING;

  const refuser = (message) => {
    violations.push(message);
    if (strict) throw new StepProtocolError(message);
    return false;
  };

  return {
    mode,

    /**
     * Valide une transition et l'enregistre. Rend `true` si l'appelant doit
     * émettre l'événement — en mode non strict, une violation rend `false`
     * plutôt que d'interrompre un déploiement en cours.
     */
    record(stepId, status) {
      assertKnownStep(stepId);
      assertKnownStatus(status);
      const avant = lire(stepId);
      if (!TRANSITIONS[avant].includes(status)) {
        return refuser(`Transition interdite pour « ${stepId} » : ${avant} → ${status}.`);
      }
      etats.set(stepId, { status });
      return true;
    },

    state: (stepId) => lire(stepId),
    violations: () => [...violations],

    /** Les étapes encore ouvertes — celles qui laisseraient un écran figé. */
    open: () => [...etats.entries()]
      .filter(([, v]) => v.status === STEP_STATUS.RUNNING)
      .map(([id]) => id),

    /**
     * La checklist DÉRIVÉE : registre pour la définition, exécution pour l'état.
     * Seules les étapes applicables au MODE y figurent — un préflight n'a pas
     * à montrer une ligne « Transfert du projet » qu'il n'exécutera jamais.
     */
    checklist: () => stepsForMode(mode).map((s) => ({
      id: s.id,
      label: mode === RUN_MODES.PRECHECK && s.precheckLabel ? s.precheckLabel : s.label,
      order: s.order,
      status: lire(s.id),
    })),

    /**
     * LES ÉTAPES OBLIGATOIRES QUI N'ONT PAS ABOUTI.
     *
     * `required` est évalué DANS LE CONTEXTE DU MODE : les étapes du
     * déploiement réel ne sont pas exigibles d'un préflight. Les étapes
     * conditionnelles (`required: false`) ne le sont jamais — elles dépendent
     * d'un fournisseur DNS que beaucoup d'installations n'ont pas.
     *
     * C'est ce qui rend impossible de conclure « déployé » alors qu'une étape a
     * été sautée par un chemin de code oublié. Le défaut est alors dans le
     * MOTEUR, et il se signale ici plutôt qu'à la première panne en production.
     */
    missingRequired: () => stepsForMode(mode)
      .filter((s) => s.required)
      .filter((s) => !ETATS_FINAUX.has(lire(s.id)))
      .map((s) => s.id),

    /** Le libellé canonique, résolu pour le mode courant. */
    label: (stepId) => {
      const meta = canonicalStep(stepId);
      return mode === RUN_MODES.PRECHECK && meta.precheckLabel ? meta.precheckLabel : meta.label;
    },
  };
}

export default createDeploymentStepTracker;
