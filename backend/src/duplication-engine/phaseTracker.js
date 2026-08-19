import {
  DUPLICATION_PHASES,
  PHASE_STATUS,
  assertKnownPhase,
  assertKnownStatus,
  phaseDefinition,
  phaseKey,
} from './config/duplication.phases.js';

/**
 * L'ÉMETTEUR DE PHASES — définition d'un côté, exécution de l'autre.
 *
 * ══ CE QU'IL EMPÊCHE, ET POURQUOI CELA NE POUVAIT PAS ÊTRE EMPÊCHÉ AVANT ════
 *
 * Le moteur appelait `onPhase({ phase: 'copy', status: 'running' })` — une
 * chaîne libre, un objet libre. Rien ne vérifiait que la phase existait, que le
 * statut appartenait à un vocabulaire, ni que la succession avait un sens. Un
 * `phase: 'copie'` mal orthographié n'aurait produit aucune erreur : juste une
 * ligne qui ne s'allume jamais, sur une interface qui ne peut pas savoir
 * qu'elle attend quelque chose qui n'arrivera pas.
 *
 * Ce module fait de l'émission un point de contrôle :
 *
 *   · la phase doit exister DANS LE REGISTRE ;
 *   · le statut doit appartenir au vocabulaire fermé ;
 *   · la transition doit être licite ;
 *   · l'état de chaque phase est MÉMORISÉ, ce qui rend calculable la question
 *     « la duplication a-t-elle vraiment fait tout ce qu'elle devait ? ».
 *
 * ══ CE QU'IL N'EST PAS ══════════════════════════════════════════════════════
 *
 * Pas une machine à états générique. Le graphe tient en quatre lignes ; un
 * framework coûterait plus cher à relire que la règle qu'il encoderait.
 */

/**
 * LES TRANSITIONS LICITES.
 *
 *     pending ──→ running ──→ ok
 *                     └────→ error
 *     pending ──→ skipped
 *
 * Ce qui est refusé mérite d'être nommé :
 *
 *   · `pending → ok` : une phase déclarée réussie sans avoir jamais commencé.
 *     C'est LE défaut que ce lot existe pour rendre impossible — une checklist
 *     qui affiche PASS sur un travail qui n'a pas eu lieu ;
 *   · `ok → running` : une phase terminée qui recommence, donc un ordre faux ;
 *   · `error → ok` : un échec effacé par une réussite ultérieure. Un moteur qui
 *     réessaie devra le dire explicitement, pas le maquiller ;
 *   · `running → running` : deux départs pour une même phase, signe que deux
 *     chemins du pipeline se croisent.
 */
const TRANSITIONS = Object.freeze({
  [PHASE_STATUS.PENDING]: [PHASE_STATUS.RUNNING, PHASE_STATUS.SKIPPED],
  [PHASE_STATUS.RUNNING]: [PHASE_STATUS.OK, PHASE_STATUS.ERROR],
  [PHASE_STATUS.OK]: [],
  [PHASE_STATUS.ERROR]: [],
  [PHASE_STATUS.SKIPPED]: [],
});

export class PhaseProtocolError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PhaseProtocolError';
    this.code = 'DUPLICATION_PHASE_PROTOCOL';
  }
}

/**
 * Crée un traceur pour UNE exécution.
 *
 * @param {(event: object) => void} emit  destinataire des événements validés.
 * @returns {{ phase: Function, skip: Function, state: Function, checklist: Function,
 *             missingRequired: Function }}
 */
export function createPhaseTracker(emit = () => {}) {
  /** Clé d'instance → { id, target, status } */
  const etats = new Map();

  const lire = (cle) => etats.get(cle)?.status ?? PHASE_STATUS.PENDING;

  function transition(id, status, { target = null, ...details } = {}) {
    assertKnownPhase(id);
    assertKnownStatus(status);

    const definition = phaseDefinition(id);
    /**
     * UNE CIBLE N'A DE SENS QUE POUR UNE FAMILLE DYNAMIQUE.
     *
     * Sans ce contrôle, `copy` pourrait recevoir une cible et se dédoubler en
     * silence : l'interface afficherait deux lignes « Copie des fichiers », et
     * le registre n'en connaîtrait qu'une.
     */
    if (target && !definition.dynamic) {
      throw new PhaseProtocolError(
        `La phase « ${id} » n'est pas dynamique : elle ne peut pas porter la cible « ${target} ».`
      );
    }

    const cle = phaseKey(id, target);
    const avant = lire(cle);
    if (!TRANSITIONS[avant].includes(status)) {
      throw new PhaseProtocolError(
        `Transition interdite pour « ${cle} » : ${avant} → ${status}.`
      );
    }

    etats.set(cle, { id, target, status });
    /**
     * L'ÉVÉNEMENT NE PORTE NI `label` NI `order`.
     *
     * Ils sont résolvables depuis le registre, et les transporter en ferait une
     * seconde source de vérité — celle qui gagnerait, puisqu'elle arrive en
     * dernier. Le fil transporte des FAITS ; la présentation se résout à
     * l'arrivée.
     */
    emit({ phase: id, status, ...(target ? { target } : {}), ...details });
  }

  return {
    /** Émet une transition validée. */
    phase: (id, status, options) => transition(id, status, options),

    /**
     * Déclare une phase PASSÉE, avec sa raison. Jamais `ok` : une famille
     * dynamique sans aucune cible n'a rien réussi, elle n'avait rien à faire.
     */
    skip: (id, reason, options = {}) => transition(id, PHASE_STATUS.SKIPPED, { ...options, reason }),

    /** L'état courant d'une instance. */
    state: (id, target = null) => lire(phaseKey(id, target)),

    /** Toutes les instances observées, dans l'ordre canonique puis alphabétique. */
    checklist: () => [...etats.values()]
      .map((e) => ({ ...e, order: phaseDefinition(e.id).order }))
      .sort((a, b) => a.order - b.order || String(a.target).localeCompare(String(b.target)))
      .map(({ id, target, status }) => ({
        id,
        ...(target ? { target } : {}),
        status,
        label: phaseDefinition(id).label,
      })),

    /**
     * LES PHASES OBLIGATOIRES QUI N'ONT PAS ABOUTI.
     *
     * C'est ce qui rend impossible de déclarer une duplication réussie alors
     * qu'une étape a été silencieusement sautée. Une phase requise absente du
     * relevé n'est pas « probablement passée » : c'est une anomalie du moteur,
     * et le pipeline refuse de conclure.
     */
    missingRequired: () => DUPLICATION_PHASES
      .filter((d) => d.required)
      .filter((d) => {
        const instances = [...etats.values()].filter((e) => e.id === d.id);
        if (instances.length === 0) return true;
        return !instances.every((e) => e.status === PHASE_STATUS.OK || e.status === PHASE_STATUS.SKIPPED);
      })
      .map((d) => d.id),
  };
}

export default createPhaseTracker;
