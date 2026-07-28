// MACHINE À ÉTATS DES EXÉCUTIONS — Phase 3C.
//
// C'est la pièce qui contraint tout le reste : une exécution ne peut pas se
// trouver dans un état qu'elle n'a pas atteint par une transition déclarée.
// Le moteur ne « met pas à jour un statut » — il **applique une transition**,
// et refuse celles qui ne figurent pas dans la table.
//
// Service PUR : aucune E/S. La table de transitions est la seule source de
// vérité sur ce qui est permis.
//
// ── LE GRAPHE ───────────────────────────────────────────────────────────────
//
//   CREATED ──▶ WAITING_CONFIRMATION ──▶ QUEUED ──▶ RUNNING ──▶ SUCCEEDED
//      │                 │                 │           │    └──▶ FAILED ──▶ ROLLED_BACK
//      │                 │                 │           └──▶ TIMEOUT ──▶ ROLLED_BACK
//      └──▶ QUEUED       └──▶ CANCELLED    └──▶ CANCELLED
//      └──▶ CANCELLED
//      └──▶ FAILED (validation refusée)
//
// Une exécution qui n'exige pas de confirmation passe directement de CREATED
// à QUEUED : le chemin est plus court, jamais différent.

export const STATE = Object.freeze({
  CREATED: 'CREATED',
  WAITING_CONFIRMATION: 'WAITING_CONFIRMATION',
  QUEUED: 'QUEUED',
  RUNNING: 'RUNNING',
  SUCCEEDED: 'SUCCEEDED',
  FAILED: 'FAILED',
  CANCELLED: 'CANCELLED',
  ROLLED_BACK: 'ROLLED_BACK',
  TIMEOUT: 'TIMEOUT',
});

/**
 * TABLE DES TRANSITIONS — la seule autorité sur ce qui est permis.
 *
 * Chaque entrée déclare l'état source, l'état cible, et la RAISON pour
 * laquelle cette transition existe. La raison n'est pas décorative : elle
 * apparaît dans le journal d'audit, et elle oblige à justifier chaque arête
 * du graphe au moment où on l'ajoute.
 */
export const TRANSITIONS = Object.freeze([
  { from: STATE.CREATED, to: STATE.WAITING_CONFIRMATION, reason: 'La politique de l’action exige une confirmation explicite.' },
  { from: STATE.CREATED, to: STATE.QUEUED, reason: 'Aucune confirmation requise : l’exécution rejoint la file.' },
  { from: STATE.CREATED, to: STATE.FAILED, reason: 'La validation préalable a refusé l’exécution.' },
  { from: STATE.CREATED, to: STATE.CANCELLED, reason: 'Annulée avant toute mise en file.' },

  { from: STATE.WAITING_CONFIRMATION, to: STATE.QUEUED, reason: 'Confirmation obtenue.' },
  { from: STATE.WAITING_CONFIRMATION, to: STATE.CANCELLED, reason: 'Confirmation refusée ou abandonnée.' },
  { from: STATE.WAITING_CONFIRMATION, to: STATE.TIMEOUT, reason: 'Délai de confirmation dépassé.' },

  { from: STATE.QUEUED, to: STATE.RUNNING, reason: 'Prise en charge par l’exécuteur.' },
  { from: STATE.QUEUED, to: STATE.CANCELLED, reason: 'Annulée avant démarrage.' },
  { from: STATE.QUEUED, to: STATE.FAILED, reason: 'Refusée au démarrage (verrou d’exclusivité, prérequis perdu).' },

  { from: STATE.RUNNING, to: STATE.SUCCEEDED, reason: 'Exécution terminée avec succès.' },
  { from: STATE.RUNNING, to: STATE.FAILED, reason: 'Exécution terminée en erreur.' },
  { from: STATE.RUNNING, to: STATE.TIMEOUT, reason: 'Délai maximal d’exécution dépassé.' },
  // Pas de RUNNING → CANCELLED : on n'interrompt pas une opération distante en
  // cours. On demande l'annulation, elle prend effet à la prochaine étape —
  // c'est le rôle de `cancellationRequested`.

  { from: STATE.FAILED, to: STATE.ROLLED_BACK, reason: 'Compensation appliquée après échec.' },
  { from: STATE.TIMEOUT, to: STATE.ROLLED_BACK, reason: 'Compensation appliquée après dépassement de délai.' },
]);

/** États TERMINAUX : plus aucune transition n'en part. */
export const TERMINAL_STATES = Object.freeze([
  STATE.SUCCEEDED, STATE.CANCELLED, STATE.ROLLED_BACK,
]);

/**
 * États FINAUX au sens du cycle de vie : l'exécution ne progressera plus
 * d'elle-même. `FAILED` et `TIMEOUT` en font partie bien qu'une compensation
 * reste possible — elle est décidée, pas automatique.
 */
export const SETTLED_STATES = Object.freeze([
  STATE.SUCCEEDED, STATE.FAILED, STATE.CANCELLED, STATE.ROLLED_BACK, STATE.TIMEOUT,
]);

/** États pendant lesquels une exécution occupe un verrou d'exclusivité. */
export const ACTIVE_STATES = Object.freeze([
  STATE.WAITING_CONFIRMATION, STATE.QUEUED, STATE.RUNNING,
]);

export const isTerminal = (state) => TERMINAL_STATES.includes(state);
export const isSettled = (state) => SETTLED_STATES.includes(state);
export const isActive = (state) => ACTIVE_STATES.includes(state);

/** Transitions possibles depuis un état donné. */
export function transitionsFrom(state) {
  return TRANSITIONS.filter((t) => t.from === state);
}

/** Une transition est-elle déclarée ? */
export function canTransition(from, to) {
  return TRANSITIONS.some((t) => t.from === from && t.to === to);
}

/**
 * APPLIQUE une transition, ou explique précisément pourquoi elle est refusée.
 *
 * Jamais « transition invalide » tout court : le refus nomme l'état courant,
 * l'état visé, et les transitions qui SERAIENT possibles. C'est la même
 * exigence d'explication que la Phase 3B.
 *
 * @returns {{ ok: true, from, to, reason } | { ok: false, code, message, allowed }}
 */
export function transition(from, to, { context = {} } = {}) {
  if (!Object.values(STATE).includes(from)) {
    return { ok: false, code: 'EXEC_STATE_UNKNOWN', message: `État courant inconnu : « ${from} ».`, allowed: [] };
  }
  if (!Object.values(STATE).includes(to)) {
    return { ok: false, code: 'EXEC_STATE_UNKNOWN', message: `État visé inconnu : « ${to} ».`, allowed: [] };
  }
  if (from === to) {
    return {
      ok: false,
      code: 'EXEC_TRANSITION_NOOP',
      message: `L’exécution est déjà dans l’état ${from}.`,
      allowed: transitionsFrom(from).map((t) => t.to),
    };
  }

  const declared = TRANSITIONS.find((t) => t.from === from && t.to === to);
  if (!declared) {
    const allowed = transitionsFrom(from).map((t) => t.to);
    return {
      ok: false,
      code: isTerminal(from) ? 'EXEC_STATE_TERMINAL' : 'EXEC_TRANSITION_FORBIDDEN',
      message: isTerminal(from)
        ? `L’exécution est dans l’état terminal ${from} : plus aucune transition n’est possible.`
        : `Transition ${from} → ${to} non déclarée. Depuis ${from}, seuls ${allowed.join(', ') || '(aucun état)'} sont atteignables.`,
      allowed,
    };
  }

  return { ok: true, from, to, reason: declared.reason, context };
}

/**
 * Vérifie l'intégrité du graphe — un graphe mal formé est un défaut, pas une
 * surprise à découvrir en production.
 */
export function validateGraph(transitions = TRANSITIONS) {
  const errors = [];
  const states = new Set(Object.values(STATE));

  for (const t of transitions) {
    if (!states.has(t.from)) errors.push(`état source inconnu : ${t.from}`);
    if (!states.has(t.to)) errors.push(`état cible inconnu : ${t.to}`);
    if (!t.reason) errors.push(`transition ${t.from} → ${t.to} sans raison déclarée`);
  }

  const seen = new Set();
  for (const t of transitions) {
    const key = `${t.from}→${t.to}`;
    if (seen.has(key)) errors.push(`transition dupliquée : ${key}`);
    seen.add(key);
  }

  // Tout état non terminal doit avoir au moins une sortie, sinon une
  // exécution pourrait s'y échouer définitivement sans être « terminée ».
  for (const state of states) {
    if (isTerminal(state)) continue;
    if (transitionsFrom(state).length === 0) {
      errors.push(`état sans issue : ${state} (ni terminal, ni sortant)`);
    }
  }

  // Tout état doit être atteignable depuis CREATED.
  const reachable = new Set([STATE.CREATED]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const t of transitions) {
      if (reachable.has(t.from) && !reachable.has(t.to)) {
        reachable.add(t.to);
        grew = true;
      }
    }
  }
  for (const state of states) {
    if (!reachable.has(state)) errors.push(`état inatteignable depuis CREATED : ${state}`);
  }

  return { valid: errors.length === 0, errors, states: [...states], transitionCount: transitions.length };
}

export default {
  STATE, TRANSITIONS, TERMINAL_STATES, SETTLED_STATES, ACTIVE_STATES,
  transition, canTransition, transitionsFrom, validateGraph,
  isTerminal, isSettled, isActive,
};
