// Surface de PILOTAGE (/api/executions) — Phase 3C.
//
// Ce contrôleur ne fait RIEN d'autre que traduire HTTP ↔ moteur. Il ne
// valide aucune politique, n'applique aucune transition, ne contacte aucun
// projet. Toute la logique est dans `execution.service.js` — c'est ce qui
// garantit qu'aucune action ne peut contourner le moteur en passant par
// l'API.
//
// Un test d'architecture le vérifie : ce fichier ne doit importer ni le
// registre d'actions, ni un exécuteur, ni un client de pont.
import { created, ok } from '../utils/apiResponse.js';
import ApiError from '../utils/ApiError.js';
import {
  MODE,
  cancelExecution,
  catalogue,
  confirmExecution,
  createExecution,
  executionStats,
  getExecution,
  listExecutions,
  listQueue,
  prepareAction,
} from '../services/execution/execution.service.js';

/** Initiateur d'une exécution — dérivé du porteur du jeton, jamais du corps. */
function initiatorOf(req) {
  return {
    userId: req.panelUser.userId,
    userEmail: req.panelUser.email,
    role: req.panelUser.role,
  };
}

/* -------------------------------------------------------------------------- */
/*  LECTURE                                                                   */
/* -------------------------------------------------------------------------- */

/** Le catalogue d'actions — l'interface ne code aucune action en dur. */
export function actions(_req, res) {
  return ok(res, { items: catalogue() });
}

/** Statistiques d'exécution — niveau 0. */
export async function stats(_req, res) {
  return ok(res, await executionStats());
}

/** La file d'attente et ce qui tourne — niveau 1. */
export async function queue(_req, res) {
  return ok(res, { items: await listQueue() });
}

/** L'historique, filtrable — niveau 1. */
export async function history(req, res) {
  const { projectId, state, type, mode, limit } = req.query;
  return ok(res, {
    items: await listExecutions({
      projectId: projectId ?? null,
      state: state ?? null,
      type: type ?? null,
      mode: mode ?? null,
      limit: limit ? Number(limit) : 50,
    }),
  });
}

/** Le détail complet d'une exécution, journal compris — niveaux 2 et 3. */
export async function detail(req, res) {
  return ok(res, await getExecution(req.params.executionId));
}

/* -------------------------------------------------------------------------- */
/*  PRÉPARATION                                                               */
/* -------------------------------------------------------------------------- */

/**
 * PRÉPARE une action : politiques évaluées, refus expliqués, confirmation
 * annoncée — sans rien créer. C'est ce que l'écran affiche avant de proposer
 * le moindre bouton.
 */
export async function prepare(req, res) {
  const { type, projectId = null, parameters = {} } = req.body ?? {};
  if (!type) {
    throw ApiError.badRequest('PANEL_ACTION_TYPE_REQUIRED',
      'Préparation impossible parce qu’aucun type d’action n’a été fourni.');
  }
  return ok(res, await prepareAction({ type, projectId, parameters }));
}

/* -------------------------------------------------------------------------- */
/*  ÉCRITURE                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * CRÉE une exécution.
 *
 * Le mode par défaut est SIMULATION : un corps qui ne dit rien simule. Passer
 * en réel exige `mode: "EXECUTION"` — un acte explicite, jamais un défaut.
 */
export async function create(req, res) {
  const { type, projectId = null, parameters = {}, mode, correlationId = null } = req.body ?? {};
  if (!type) {
    throw ApiError.badRequest('PANEL_ACTION_TYPE_REQUIRED',
      'Exécution refusée parce qu’aucun type d’action n’a été fourni.');
  }
  if (mode !== undefined && mode !== MODE.SIMULATION && mode !== MODE.EXECUTION) {
    throw ApiError.badRequest('PANEL_EXECUTION_MODE_INVALID',
      `Exécution refusée parce que le mode « ${mode} » n’existe pas : attendus ${MODE.SIMULATION} ou ${MODE.EXECUTION}.`);
  }
  const execution = await createExecution({
    type,
    projectId,
    parameters,
    mode: mode ?? MODE.SIMULATION,
    initiator: initiatorOf(req),
    correlationId,
  });
  return created(res, execution);
}

/** Enregistre une décision de confirmation (APPROVED ou REJECTED). */
export async function confirm(req, res) {
  const { decision, comment = null } = req.body ?? {};
  if (decision !== 'APPROVED' && decision !== 'REJECTED') {
    throw ApiError.badRequest('PANEL_CONFIRMATION_DECISION_INVALID',
      'Confirmation refusée parce que la décision doit valoir APPROVED ou REJECTED.');
  }
  const user = initiatorOf(req);
  return ok(res, await confirmExecution(req.params.executionId, {
    decision,
    comment,
    userId: user.userId,
    userEmail: user.userEmail,
  }));
}

/** Annule une exécution, ou demande son annulation si elle est en cours. */
export async function cancel(req, res) {
  const user = initiatorOf(req);
  return ok(res, await cancelExecution(req.params.executionId, {
    userId: user.userId,
    userEmail: user.userEmail,
    reason: req.body?.reason ?? null,
  }));
}
