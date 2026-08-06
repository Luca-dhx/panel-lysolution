// MOTEUR D'EXÉCUTION — Phase 3C, LOT 1.
//
// ── LA RÈGLE FONDATRICE ─────────────────────────────────────────────────────
// Le Panel n'exécute JAMAIS une action métier directement. Il :
//   prépare → valide → confirme → planifie → exécute → suit → historise.
// Tout passe par ce module. Aucun contrôleur, aucune route, aucun autre
// service ne doit appeler un exécuteur ni un client de pont pour agir.
//
// Ce que le moteur garantit, et que rien d'autre ne peut garantir :
//   · un état ne change que par une TRANSITION déclarée (execution-state) ;
//   · aucune exécution ne démarre sans POLITIQUES satisfaites (execution-policy) ;
//   · aucune action à risque ne part sans CONFIRMATION explicite ;
//   · tout est JOURNALISÉ, et le journal est masqué avant persistance ;
//   · le mode SIMULATION est le défaut : l'exécution réelle se demande.
//
// ── CE QUE LE MOTEUR NE CONNAÎT PAS ─────────────────────────────────────────
// Aucun identifiant d'action n'apparaît dans ce fichier. Pas de `switch`, pas
// de `if (type === 'DEPLOY')`. Le moteur lit le registre, applique ce qu'il y
// trouve, appelle l'exécuteur déclaré. C'est ce qui rend l'ajout d'une action
// possible sans toucher au cœur — et c'est vérifié par un test.
import { randomUUID } from 'node:crypto';

import PanelExecution from '../../models/PanelExecution.model.js';
import ApiError from '../../utils/ApiError.js';
import ProjectBridgeClient from '../../bridge/ProjectBridgeClient.js';
import { CONTRACT_VERSION, nowIso } from '../../bridge/bridgeContract.js';
import logger from '../../utils/logger.js';

import { getOutboundBridgeToken } from '../pairing/pairing.service.js';
import {
  getProjectOrThrow,
  recordAppliedConfiguration,
  setManifestFromBridge,
} from '../registry/projectRegistry.service.js';
import { validateManifest } from '../manifest/manifest.schema.js';
import { expectedEngineVersions } from '../supervision/fleet.service.js';
import { buildProjectHealth } from '../supervision/health.service.js';
import { diagnoseProject } from '../diagnostic/diagnostic.service.js';

import { getAction, listActions, validateParameters } from './actions/registry.js';
import { STATE, ACTIVE_STATES, isSettled, transition, transitionsFrom } from './execution-state.service.js';
import { DENIAL, confirmationRequirement, evaluatePolicy } from './execution-policy.service.js';
import { PHASE, createLog } from './execution-log.service.js';
import * as executor from './executor.service.js';
import * as plans from './execution-plan.service.js';
import { outboundBaseUrl } from '../registry/projectDestination.service.js';

export const MODE = Object.freeze({ SIMULATION: 'SIMULATION', EXECUTION: 'EXECUTION' });

/* -------------------------------------------------------------------------- */
/*  CONTEXTE                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Rassemble tout ce dont les politiques et l'exécuteur ont besoin.
 *
 * Le contexte est calculé À CHAQUE ÉTAPE (création, confirmation, démarrage) :
 * un projet peut être tombé entre la demande et le lancement, et la politique
 * doit alors refuser. Un contexte mis en cache serait un contexte périmé.
 */
export async function buildExecutionContext({ action, projectId, parameters, executionId = null, now = Date.now() }) {
  const context = {
    parameters: parameters ?? {},
    executionId,
    now,
    record: null,
    project: null,
    health: null,
    diagnosis: null,
    activeExecutions: await listActiveExecutions(),
  };

  if (action?.target === 'PROJECT' && projectId) {
    const record = await getProjectOrThrow(projectId);
    const expectedEngines = expectedEngineVersions();
    const supervision = { now, panelContractVersion: CONTRACT_VERSION, expectedEngines };
    context.record = record;
    context.health = buildProjectHealth(record, supervision);
    context.diagnosis = diagnoseProject(record, { now, expectedEngines });
    context.project = { environment: record.runtime?.environment ?? null };
  }

  return context;
}

/** Exécutions occupant un verrou — la base fait foi, pas une variable locale. */
async function listActiveExecutions() {
  const docs = await PanelExecution.find({ state: { $in: [...ACTIVE_STATES] } })
    .select('executionId type projectId state createdAt')
    .lean();
  return docs.map((doc) => ({
    id: doc.executionId,
    type: doc.type,
    projectId: doc.projectId,
    state: doc.state,
    createdAt: doc.createdAt,
  }));
}

/* -------------------------------------------------------------------------- */
/*  TRANSITIONS                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Applique une transition sur un document, ou refuse en l'expliquant.
 * C'est le SEUL endroit du Panel qui écrit `state` : partout ailleurs on
 * demande une transition.
 */
function applyTransition(doc, to, { log, reason = null } = {}) {
  const result = transition(doc.state, to);
  if (!result.ok) {
    throw ApiError.conflict('PANEL_EXECUTION_TRANSITION_REFUSED', result.message, {
      code: result.code,
      from: doc.state,
      to,
      allowed: result.allowed,
    });
  }
  const at = nowIso();
  doc.stateHistory.push({ at, from: doc.state, to, reason: reason ?? result.reason });
  doc.state = to;
  if (to === STATE.RUNNING && !doc.startedAt) doc.startedAt = at;
  if (isSettled(to)) {
    doc.finishedAt = at;
    doc.durationMs = doc.startedAt ? Date.parse(at) - Date.parse(doc.startedAt) : null;
  }
  if (log) log.info(phaseForState(to), `${doc.state} — ${reason ?? result.reason}`);
  return result;
}

/** Phase de journal correspondant à un état — table, pas cascade de `if`. */
const STATE_PHASE = Object.freeze({
  [STATE.CREATED]: PHASE.CREATION,
  [STATE.WAITING_CONFIRMATION]: PHASE.CONFIRMATION,
  [STATE.QUEUED]: PHASE.QUEUE,
  [STATE.RUNNING]: PHASE.START,
  [STATE.SUCCEEDED]: PHASE.END,
  [STATE.FAILED]: PHASE.END,
  [STATE.CANCELLED]: PHASE.END,
  [STATE.ROLLED_BACK]: PHASE.COMPENSATION,
  [STATE.TIMEOUT]: PHASE.END,
});
const phaseForState = (state) => STATE_PHASE[state] ?? PHASE.STEP;

/* -------------------------------------------------------------------------- */
/*  PRÉPARATION — ce que l'interface montre AVANT de proposer quoi que ce soit */
/* -------------------------------------------------------------------------- */

/**
 * PRÉPARE une action sans rien créer : politiques évaluées, paramètres
 * vérifiés, confirmation annoncée. C'est ce que l'écran affiche avant même
 * que l'opérateur ne clique.
 *
 * Aucune écriture, aucun appel distant.
 */
export async function prepareAction({ type, projectId = null, parameters = {} }) {
  const action = getAction(type);
  if (!action) {
    throw ApiError.notFound('PANEL_ACTION_UNKNOWN', `Action refusée parce que « ${type} » n’existe pas dans le registre.`);
  }

  const parameterCheck = validateParameters(action, parameters);
  const context = await buildExecutionContext({ action, projectId, parameters });
  const policy = evaluatePolicy(action, context);
  const confirmation = confirmationRequirement(action);

  // Les paramètres sont une politique comme une autre : ils apparaissent dans
  // la même liste de refus, avec le même vocabulaire.
  const denials = [...policy.denials];
  if (!parameterCheck.valid) {
    denials.unshift({
      ok: false,
      code: DENIAL.PARAMETERS_INVALID,
      message: `Action refusée parce que les paramètres fournis sont incomplets ou invalides : ${parameterCheck.errors.join(' ')}`,
      facts: { errors: parameterCheck.errors },
    });
  }

  return {
    action: describeAction(action),
    projectId,
    parameters,
    allowed: denials.length === 0,
    checks: policy.checks,
    denials,
    // Une raison, toujours. Jamais « refusée » tout court.
    reason: denials.length === 0 ? policy.summary : denials.map((d) => d.message).join(' '),
    confirmation,
    modes: {
      // Simulation toujours possible dès que l'action sait décrire son plan,
      // même quand la politique refuse l'exécution : comprendre ce qui SERAIT
      // fait aide à corriger ce qui bloque.
      simulation: action.simulatable === true,
      execution: denials.length === 0,
      default: MODE.SIMULATION,
    },
  };
}

/** Vue publique d'un descripteur — les fonctions de prérequis ne sortent pas. */
export function describeAction(action) {
  return {
    type: action.type,
    label: action.label,
    description: action.description,
    category: action.category,
    target: action.target,
    simulatable: action.simulatable === true,
    parameters: action.parameters ?? {},
    futureActions: action.futureActions ?? [],
    policy: {
      requiresConfirmation: action.policy.requiresConfirmation,
      confirmationsRequired: action.policy.confirmationsRequired,
      allowedEnvironments: action.policy.allowedEnvironments,
      risk: action.policy.risk,
      rollbackable: action.policy.rollbackable,
      timeoutMs: action.policy.timeoutMs,
      exclusive: action.policy.exclusive,
      exclusivityScope: action.policy.exclusivityScope ?? 'PROJECT',
      requiredReadiness: action.policy.requiredReadiness ?? null,
      blockOnDiagnostics: action.policy.blockOnDiagnostics ?? [],
      prerequisites: (action.policy.prerequisites ?? []).map((p) => ({ id: p.id, label: p.label })),
    },
  };
}

/** Catalogue exposé — l'interface ne code aucune action en dur non plus. */
export function catalogue() {
  return listActions().map(describeAction);
}

/* -------------------------------------------------------------------------- */
/*  CRÉATION                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * CRÉE une exécution. Elle naît en CREATED, est validée immédiatement, puis
 * part soit en WAITING_CONFIRMATION, soit directement en QUEUED.
 *
 * `mode` vaut SIMULATION par défaut — LOT 9. Demander une exécution réelle est
 * un acte explicite.
 */
export async function createExecution({
  type,
  projectId = null,
  parameters = {},
  mode = MODE.SIMULATION,
  initiator,
  correlationId = null,
  parentExecutionId = null,
}) {
  const action = getAction(type);
  if (!action) {
    throw ApiError.notFound('PANEL_ACTION_UNKNOWN', `Action refusée parce que « ${type} » n’existe pas dans le registre.`);
  }
  if (!initiator?.userId) {
    throw ApiError.badRequest('PANEL_EXECUTION_NO_INITIATOR',
      'Action refusée parce qu’aucun initiateur n’est identifié : une exécution sans auteur ne serait pas auditable.');
  }
  const resolvedMode = mode === MODE.EXECUTION ? MODE.EXECUTION : MODE.SIMULATION;

  const log = createLog();
  const createdAt = nowIso();
  log.info(PHASE.CREATION,
    `Exécution « ${action.label} » demandée par ${initiator.userEmail ?? initiator.userId} en mode ${resolvedMode}.`,
    { type, projectId, parameters });

  const context = await buildExecutionContext({ action, projectId, parameters });
  const parameterCheck = validateParameters(action, parameters);
  const policy = evaluatePolicy(action, context);
  const confirmation = confirmationRequirement(action);

  const doc = new PanelExecution({
    executionId: randomUUID(),
    type: action.type,
    projectId: context.record?.projectId ?? null,
    projectName: context.record?.projectName ?? null,
    environment: context.record?.runtime?.environment ?? null,
    mode: resolvedMode,
    parameters,
    initiator: {
      userId: initiator.userId,
      userEmail: initiator.userEmail ?? null,
      role: initiator.role ?? null,
    },
    state: STATE.CREATED,
    stateHistory: [{ at: createdAt, from: null, to: STATE.CREATED, reason: 'Exécution créée.' }],
    confirmationsRequired: confirmation.count,
    createdAt,
    timeoutMs: action.policy.timeoutMs ?? null,
    correlationId,
    parentExecutionId,
  });

  // — VALIDATION -----------------------------------------------------------
  const denials = [...policy.denials];
  if (!parameterCheck.valid) {
    denials.unshift({
      ok: false,
      code: DENIAL.PARAMETERS_INVALID,
      message: `Action refusée parce que les paramètres fournis sont incomplets ou invalides : ${parameterCheck.errors.join(' ')}`,
      facts: { errors: parameterCheck.errors },
    });
  }
  // En SIMULATION, les politiques d'exécution ne bloquent pas : c'est
  // précisément quand une action est refusée qu'on veut comprendre ce qu'elle
  // aurait fait. Les paramètres, eux, restent exigés — sans eux il n'y a pas
  // de plan à calculer.
  const blocking = resolvedMode === MODE.EXECUTION ? denials : denials.filter((d) => d.code === DENIAL.PARAMETERS_INVALID);

  doc.validation = {
    at: nowIso(),
    ok: denials.length === 0,
    mode: resolvedMode,
    checks: policy.checks.map(({ id, label, ok, code, message, facts }) => ({ id, label, ok, code: code ?? null, message, facts: facts ?? {} })),
    denials: denials.map(({ code, message, facts }) => ({ code, message, facts: facts ?? {} })),
    summary: denials.length === 0 ? policy.summary : denials.map((d) => d.message).join(' '),
  };
  log.info(PHASE.VALIDATION, doc.validation.summary);

  if (blocking.length > 0) {
    applyTransition(doc, STATE.FAILED, { log, reason: 'La validation préalable a refusé l’exécution.' });
    doc.error = { code: blocking[0].code, message: doc.validation.summary, denials: doc.validation.denials };
    log.info(PHASE.END, 'Exécution close sans avoir démarré.');
    doc.log = log.toArray();
    await doc.save();
    return doc.toObject();
  }

  // — CONFIRMATION ou FILE -------------------------------------------------
  // La simulation ne demande jamais de confirmation : elle n'a aucun effet.
  const needsConfirmation = resolvedMode === MODE.EXECUTION && confirmation.required;
  if (needsConfirmation) {
    applyTransition(doc, STATE.WAITING_CONFIRMATION, { log });
    log.info(PHASE.CONFIRMATION,
      `${confirmation.count} confirmation(s) requise(s) — risque ${confirmation.risk}.`);
  } else {
    applyTransition(doc, STATE.QUEUED, { log });
  }

  doc.log = log.toArray();
  await doc.save();

  // Une exécution mise en file démarre tout de suite : la file est la
  // sémantique, pas un délai artificiel.
  if (doc.state === STATE.QUEUED) return runQueued(doc.executionId);
  return doc.toObject();
}

/* -------------------------------------------------------------------------- */
/*  CONFIRMATION                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Enregistre une décision de confirmation.
 *
 * Le système est prêt pour la DOUBLE VALIDATION : `confirmationsRequired`
 * vient de la politique, et le passage en file n'a lieu qu'une fois le compte
 * atteint. Le jour où une action exige deux approbations, seul son descripteur
 * change. Un même utilisateur ne peut pas confirmer deux fois — sinon la
 * double validation ne vaudrait rien.
 */
export async function confirmExecution(executionId, { decision, userId, userEmail = null, comment = null }) {
  const doc = await PanelExecution.findOne({ executionId });
  if (!doc) throw ApiError.notFound('PANEL_EXECUTION_NOT_FOUND', 'Exécution inconnue.');
  if (doc.state !== STATE.WAITING_CONFIRMATION) {
    throw ApiError.conflict('PANEL_EXECUTION_NOT_AWAITING_CONFIRMATION',
      `Confirmation refusée parce que l’exécution est dans l’état ${doc.state}, et non en attente de confirmation.`,
      { allowed: transitionsFrom(doc.state).map((t) => t.to) });
  }
  if (doc.confirmations.some((c) => c.userId === userId)) {
    throw ApiError.conflict('PANEL_EXECUTION_ALREADY_CONFIRMED',
      'Confirmation refusée parce que cet utilisateur s’est déjà prononcé sur cette exécution.');
  }

  const log = createLog(doc.log.map((e) => e.toObject?.() ?? e));
  doc.confirmations.push({ at: nowIso(), userId, userEmail, decision, comment });
  log.info(PHASE.CONFIRMATION, `Décision « ${decision} » de ${userEmail ?? userId}.`, { comment });

  if (decision === 'REJECTED') {
    applyTransition(doc, STATE.CANCELLED, { log, reason: `Confirmation refusée par ${userEmail ?? userId}.` });
    doc.log = log.toArray();
    await doc.save();
    return doc.toObject();
  }

  const approvals = doc.confirmations.filter((c) => c.decision === 'APPROVED').length;
  if (approvals < doc.confirmationsRequired) {
    log.info(PHASE.CONFIRMATION, `${approvals}/${doc.confirmationsRequired} confirmation(s) obtenue(s) — en attente.`);
    doc.log = log.toArray();
    await doc.save();
    return doc.toObject();
  }

  applyTransition(doc, STATE.QUEUED, { log });
  doc.log = log.toArray();
  await doc.save();
  return runQueued(doc.executionId);
}

/* -------------------------------------------------------------------------- */
/*  ANNULATION                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Annule une exécution — ou, si elle est déjà en cours, DEMANDE son
 * annulation. On n'interrompt pas une opération distante en vol : le drapeau
 * est lu à la prochaine étape.
 */
export async function cancelExecution(executionId, { userId, userEmail = null, reason = null }) {
  const doc = await PanelExecution.findOne({ executionId });
  if (!doc) throw ApiError.notFound('PANEL_EXECUTION_NOT_FOUND', 'Exécution inconnue.');

  const log = createLog(doc.log.map((e) => e.toObject?.() ?? e));
  const why = reason ?? `Annulation demandée par ${userEmail ?? userId}.`;

  if (doc.state === STATE.RUNNING) {
    doc.cancellationRequested = true;
    log.warn(PHASE.STEP,
      `${why} L’exécution est en cours : l’annulation prendra effet à la prochaine étape, aucune opération distante n’est interrompue.`);
    doc.log = log.toArray();
    await doc.save();
    return doc.toObject();
  }

  applyTransition(doc, STATE.CANCELLED, { log, reason: why });
  doc.log = log.toArray();
  await doc.save();
  return doc.toObject();
}

/* -------------------------------------------------------------------------- */
/*  EXÉCUTION                                                                 */
/* -------------------------------------------------------------------------- */

/** Capacités injectées aux exécuteurs — jamais importées par eux directement. */
function buildServices() {
  return {
    buildDeploymentPlan: plans.buildDeploymentPlan,
    buildRollbackPlan: plans.buildRollbackPlan,
    planEngineMigration: plans.planEngineMigration,
    validateManifest,
    setManifestFromBridge,
    recordAppliedConfiguration,
    panelContractVersion: CONTRACT_VERSION,
    panelEngineVersions: expectedEngineVersions(),
  };
}

/**
 * Construit le client de pont d'un projet. C'est le MOTEUR qui le fabrique :
 * un exécuteur ne détient jamais le jeton, et ne peut donc pas contacter un
 * projet hors de ce chemin.
 */
function buildClient(record, { timeoutMs }) {
  if (!outboundBaseUrl(record)) return null;
  const bridgeToken = getOutboundBridgeToken(record);
  if (!bridgeToken) return null;
  return new ProjectBridgeClient({ baseUrl: outboundBaseUrl(record), bridgeToken, timeoutMs });
}

/**
 * DÉMARRE une exécution en file.
 *
 * Le contexte est RECALCULÉ ici : entre la mise en file et le démarrage, un
 * projet a pu tomber, une autre exécution a pu prendre le verrou. Les
 * politiques sont donc réévaluées avant de lancer quoi que ce soit.
 */
export async function runQueued(executionId) {
  const doc = await PanelExecution.findOne({ executionId });
  if (!doc) throw ApiError.notFound('PANEL_EXECUTION_NOT_FOUND', 'Exécution inconnue.');
  if (doc.state !== STATE.QUEUED) return doc.toObject();

  const action = getAction(doc.type);
  const log = createLog(doc.log.map((e) => e.toObject?.() ?? e));

  if (doc.cancellationRequested) {
    applyTransition(doc, STATE.CANCELLED, { log, reason: 'Annulation demandée avant démarrage.' });
    doc.log = log.toArray();
    await doc.save();
    return doc.toObject();
  }

  const context = await buildExecutionContext({
    action,
    projectId: doc.projectId,
    parameters: doc.parameters,
    executionId: doc.executionId,
  });

  if (doc.mode === MODE.EXECUTION) {
    const recheck = evaluatePolicy(action, context);
    if (!recheck.ok) {
      log.error(PHASE.QUEUE, `Démarrage refusé parce que la situation a changé depuis la validation : ${recheck.summary}`);
      applyTransition(doc, STATE.FAILED, { log, reason: 'Refusée au démarrage (prérequis perdu).' });
      doc.error = { code: recheck.denials[0].code, message: recheck.summary };
      log.info(PHASE.END, 'Exécution close au démarrage.');
      doc.log = log.toArray();
      await doc.save();
      return doc.toObject();
    }
  }

  applyTransition(doc, STATE.RUNNING, { log });
  doc.log = log.toArray();
  await doc.save();

  // — TIMEOUT --------------------------------------------------------------
  // Le délai vient de la politique de l'action, jamais d'une constante du
  // moteur : une action longue et une action brève ne se surveillent pas
  // pareil.
  const controller = new AbortController();
  const timeoutMs = doc.timeoutMs ?? action.policy.timeoutMs;
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
  if (typeof timer.unref === 'function') timer.unref();

  const ctx = {
    record: context.record,
    project: context.project,
    parameters: doc.parameters,
    log,
    signal: controller.signal,
    services: buildServices(),
    // Ni client ni identifiants en simulation : l'impossibilité d'agir est
    // structurelle, pas une promesse de bonne conduite.
    client: doc.mode === MODE.EXECUTION ? buildClient(context.record, { timeoutMs }) : null,
    credentials: null,
    execution: { id: doc.executionId, mode: doc.mode, attempt: doc.attempt },
  };

  try {
    const outcome = doc.mode === MODE.SIMULATION
      ? await executor.simulate(action, ctx)
      : await executor.execute(action, ctx);

    clearTimeout(timer);
    log.info(PHASE.RESULT, outcome.summary);
    doc.result = sanitizeOutcome(outcome);
    applyTransition(doc, STATE.SUCCEEDED, { log });
    log.info(PHASE.END, doc.mode === MODE.SIMULATION
      ? 'Simulation terminée — aucun effet sur la cible.'
      : 'Exécution terminée.');
  } catch (err) {
    clearTimeout(timer);
    const target = timedOut ? STATE.TIMEOUT : STATE.FAILED;
    const message = timedOut
      ? `Exécution interrompue parce que le délai maximal de ${Math.round(timeoutMs / 1000)} s déclaré par l’action a été dépassé.`
      : err.message;
    log.error(PHASE.RESULT, message, { code: err.code ?? null });
    doc.error = { code: err.code ?? 'EXEC_FAILED', message, details: err.details ?? null };
    applyTransition(doc, target, { log });
    log.info(PHASE.END, 'Exécution close.');
    if (!timedOut && !(err.code ?? '').startsWith('EXEC_')) {
      logger.warn(`Exécution ${doc.executionId} en échec : ${err.message}`);
    }
  }

  doc.log = log.toArray();
  await doc.save();
  return doc.toObject();
}

/**
 * Nettoie le résultat avant persistance : on garde ce qui explique, on jette
 * ce qui n'est pas sérialisable.
 */
function sanitizeOutcome(outcome) {
  return JSON.parse(JSON.stringify(outcome, (key, value) => (typeof value === 'function' ? undefined : value)));
}

/* -------------------------------------------------------------------------- */
/*  CONSULTATION                                                              */
/* -------------------------------------------------------------------------- */

export async function getExecution(executionId) {
  const doc = await PanelExecution.findOne({ executionId }).lean();
  if (!doc) throw ApiError.notFound('PANEL_EXECUTION_NOT_FOUND', 'Exécution inconnue.');
  return doc;
}

/** Historique, filtrable. Toujours trié du plus récent au plus ancien. */
export async function listExecutions({ projectId = null, state = null, type = null, mode = null, limit = 50 } = {}) {
  const query = {};
  if (projectId) query.projectId = projectId;
  if (state) query.state = state;
  if (type) query.type = type;
  if (mode) query.mode = mode;
  const docs = await PanelExecution.find(query)
    .sort({ createdAt: -1 })
    .limit(Math.min(limit, 200))
    .lean();
  return docs.map(summariseExecution);
}

/** Ce qui est en cours ou en attente — la file, telle qu'elle est. */
export async function listQueue() {
  const docs = await PanelExecution.find({ state: { $in: [...ACTIVE_STATES] } })
    .sort({ createdAt: 1 })
    .lean();
  return docs.map(summariseExecution);
}

/** Vue résumée — le niveau 1 de la divulgation progressive. */
export function summariseExecution(doc) {
  return {
    executionId: doc.executionId,
    type: doc.type,
    projectId: doc.projectId,
    projectName: doc.projectName,
    environment: doc.environment,
    mode: doc.mode,
    state: doc.state,
    createdAt: doc.createdAt,
    startedAt: doc.startedAt,
    finishedAt: doc.finishedAt,
    durationMs: doc.durationMs,
    initiator: doc.initiator?.userEmail ?? doc.initiator?.userId ?? null,
    confirmations: `${(doc.confirmations ?? []).filter((c) => c.decision === 'APPROVED').length}/${doc.confirmationsRequired ?? 0}`,
    summary: doc.error?.message ?? doc.result?.summary ?? doc.validation?.summary ?? null,
    settled: isSettled(doc.state),
  };
}

/** Statistiques du parc d'exécutions — le niveau 0. */
export async function executionStats() {
  const rows = await PanelExecution.aggregate([{ $group: { _id: '$state', count: { $sum: 1 } } }]);
  const byState = Object.fromEntries(Object.values(STATE).map((s) => [s, 0]));
  for (const row of rows) byState[row._id] = row.count;
  const active = ACTIVE_STATES.reduce((sum, s) => sum + (byState[s] ?? 0), 0);
  return {
    total: Object.values(byState).reduce((a, b) => a + b, 0),
    active,
    byState,
  };
}

export default {
  MODE,
  prepareAction,
  catalogue,
  describeAction,
  createExecution,
  confirmExecution,
  cancelExecution,
  runQueued,
  getExecution,
  listExecutions,
  listQueue,
  executionStats,
  buildExecutionContext,
};
