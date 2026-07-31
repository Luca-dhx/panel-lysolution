// RUNS DE DÉPLOIEMENT — Phase 4.
//
// Ce module est écrit par DEUX processus distincts :
//   · le backend du Panel, qui crée le run puis le LIT ;
//   · le worker détaché, qui l'exécute et l'ÉCRIT au fil de l'eau.
//
// Toutes les écritures sont donc des mises à jour ATOMIQUES ciblées
// (`updateOne` avec `$set`/`$push`), jamais un `save()` sur un document
// chargé en mémoire. Deux processus sauvegardant le même document se
// écraseraient mutuellement — et l'un des deux perdrait la trace de ce qu'il
// vient de faire.
import { randomUUID } from 'node:crypto';

import PanelDeploymentRun from '../../models/PanelDeploymentRun.model.js';
import ApiError from '../../utils/ApiError.js';
import { nowIso } from '../../bridge/bridgeContract.js';

/** Un journal ne doit pas faire exploser la limite BSON de 16 Mo. */
const MAX_LOG_ENTRIES = 2000;
const MAX_LOG_MESSAGE = 2000;

/**
 * Au-delà de ce silence, un run « en cours » est considéré ORPHELIN : son
 * processus est mort sans conclure. Le worker bat toutes les 5 s ; on laisse
 * une marge large, car un build local peut monopoliser la boucle
 * d'événements.
 */
export const HEARTBEAT_TIMEOUT_MS = 90_000;

/* -------------------------------------------------------------------------- */
/*  CYCLE DE VIE                                                              */
/* -------------------------------------------------------------------------- */

export async function createRun({
  target, operationType, user = null, selfDeployment = false,
}) {
  const runId = randomUUID();
  await PanelDeploymentRun.create({
    runId,
    targetId: target.targetId,
    targetName: target.name,
    url: target.url,
    host: target.host,
    environment: target.environment,
    operationType,
    status: 'running',
    startedAt: nowIso(),
    user,
    selfDeployment,
  });
  return runId;
}

/** Le worker s'annonce : c'est lui qui tient désormais la plume. */
export async function attachWorker(runId, pid) {
  await PanelDeploymentRun.updateOne(
    { runId },
    { $set: { workerPid: pid, workerHeartbeatAt: nowIso() } },
  );
}

export async function heartbeat(runId) {
  await PanelDeploymentRun.updateOne({ runId }, { $set: { workerHeartbeatAt: nowIso() } });
}

/**
 * Enregistre l'avancement d'une étape.
 *
 * Idempotent par `id` : le moteur émet plusieurs fois la même étape (running
 * puis ok), et la seconde émission doit MODIFIER la première, pas en ajouter
 * une seconde. Sans cela la checklist afficherait chaque étape en double.
 */
export async function recordStep(runId, { id, label, status, message = null, errorCode = null }) {
  const at = nowIso();
  const doc = await PanelDeploymentRun.findOne({ runId }).select('steps').lean();
  if (!doc) return;

  const index = doc.steps.findIndex((s) => s.id === id);
  if (index === -1) {
    await PanelDeploymentRun.updateOne({ runId }, {
      $push: {
        steps: {
          id,
          label: label ?? id,
          order: doc.steps.length,
          status: status ?? 'running',
          startedAt: at,
          finishedAt: status && status !== 'running' ? at : null,
          durationMs: null,
          message,
          errorCode,
        },
      },
      $set: { workerHeartbeatAt: at },
    });
    return;
  }

  const previous = doc.steps[index];
  const finished = status && status !== 'running';
  await PanelDeploymentRun.updateOne({ runId }, {
    $set: {
      [`steps.${index}.status`]: status ?? previous.status,
      [`steps.${index}.label`]: label ?? previous.label,
      [`steps.${index}.message`]: message ?? previous.message,
      [`steps.${index}.errorCode`]: errorCode ?? previous.errorCode,
      ...(finished
        ? {
          [`steps.${index}.finishedAt`]: at,
          [`steps.${index}.durationMs`]: previous.startedAt
            ? Date.parse(at) - Date.parse(previous.startedAt)
            : null,
        }
        : {}),
      workerHeartbeatAt: at,
    },
  });
}

/** Ajoute une ligne de journal, bornée en taille et en nombre. */
export async function appendLog(runId, message, level = 'INFO') {
  const entry = {
    at: nowIso(),
    level,
    message: String(message).slice(0, MAX_LOG_MESSAGE),
  };
  await PanelDeploymentRun.updateOne({ runId }, {
    $push: { log: { $each: [entry], $slice: -MAX_LOG_ENTRIES } },
    $set: { workerHeartbeatAt: entry.at },
  });
}

/** Conclut un run. Après cet appel, plus rien ne doit l'écrire. */
export async function finalizeRun(runId, {
  status, summary = null, error = null, version = null, releaseId = null, deployedUrl = null,
}) {
  const doc = await PanelDeploymentRun.findOne({ runId }).select('startedAt').lean();
  if (!doc) return null;
  const at = nowIso();
  await PanelDeploymentRun.updateOne({ runId }, {
    $set: {
      status,
      summary,
      error,
      version,
      releaseId,
      deployedUrl,
      finishedAt: at,
      durationMs: Date.parse(at) - Date.parse(doc.startedAt),
      workerPid: null,
    },
  });
  return PanelDeploymentRun.findOne({ runId }).lean();
}

/* -------------------------------------------------------------------------- */
/*  LECTURE                                                                   */
/* -------------------------------------------------------------------------- */

export async function getRunOrThrow(runId) {
  const doc = await PanelDeploymentRun.findOne({ runId }).lean();
  if (!doc) throw ApiError.notFound('PANEL_RUN_NOT_FOUND', 'Exécution de déploiement inconnue.');
  return describeRun(doc);
}

/**
 * Vue complète d'un run.
 *
 * Un run `running` dont le battement est trop ancien est présenté comme
 * INTERROMPU — sans modifier la base. La lecture ne doit pas avoir d'effet de
 * bord, et un worker simplement lent ne doit pas être condamné par une
 * consultation d'écran.
 */
export function describeRun(doc) {
  const stale = doc.status === 'running'
    && doc.workerHeartbeatAt
    && Date.now() - Date.parse(doc.workerHeartbeatAt) > HEARTBEAT_TIMEOUT_MS;

  return {
    runId: doc.runId,
    targetId: doc.targetId,
    targetName: doc.targetName,
    url: doc.url,
    host: doc.host,
    environment: doc.environment,
    operationType: doc.operationType,
    status: stale ? 'interrupted' : doc.status,
    staleWorker: Boolean(stale),
    steps: doc.steps ?? [],
    log: doc.log ?? [],
    startedAt: doc.startedAt,
    finishedAt: doc.finishedAt,
    durationMs: doc.durationMs,
    version: doc.version,
    releaseId: doc.releaseId,
    deployedUrl: doc.deployedUrl,
    summary: stale && !doc.summary
      ? 'Le processus de déploiement ne donne plus signe de vie. Son issue est INCONNUE : vérifiez l’état réel du serveur avant de relancer.'
      : doc.summary,
    error: doc.error,
    user: doc.user,
    selfDeployment: doc.selfDeployment === true,
    workerHeartbeatAt: doc.workerHeartbeatAt,
  };
}

/** Résumé de ligne — pour les listes. */
export function summariseRun(doc) {
  const full = describeRun(doc);
  return {
    runId: full.runId,
    targetId: full.targetId,
    targetName: full.targetName,
    environment: full.environment,
    operationType: full.operationType,
    status: full.status,
    startedAt: full.startedAt,
    finishedAt: full.finishedAt,
    durationMs: full.durationMs,
    version: full.version,
    user: full.user,
    stepCount: full.steps.length,
    selfDeployment: full.selfDeployment,
  };
}

export async function listRuns({ targetId = null, limit = 30 } = {}) {
  const query = targetId ? { targetId } : {};
  const docs = await PanelDeploymentRun.find(query)
    .sort({ startedAt: -1 })
    .limit(Math.min(limit, 200))
    .lean();
  return docs.map(summariseRun);
}

/** Le run en cours sur une destination, s'il y en a un. */
export async function activeRunFor(targetId) {
  const doc = await PanelDeploymentRun.findOne({ targetId, status: 'running' })
    .sort({ startedAt: -1 })
    .lean();
  if (!doc) return null;
  const described = describeRun(doc);
  return described.status === 'running' ? described : null;
}

/**
 * FINALISE les runs orphelins — appelé au démarrage du backend.
 *
 * C'est exactement le cas de l'auto-déploiement réussi : le Panel a été
 * redémarré par sa propre mise en ligne. Si le worker a conclu avant, il n'y
 * a rien à faire. S'il est mort avec le processus, ce run doit cesser
 * d'apparaître « en cours » indéfiniment.
 *
 * On ne le déclare NI réussi NI échoué : `interrupted`. Trancher serait
 * inventer.
 */
export async function finalizeOrphanRuns() {
  const cutoff = new Date(Date.now() - HEARTBEAT_TIMEOUT_MS).toISOString();
  const orphans = await PanelDeploymentRun.find({
    status: 'running',
    $or: [{ workerHeartbeatAt: null }, { workerHeartbeatAt: { $lt: cutoff } }],
  }).select('runId').lean();

  for (const orphan of orphans) {
    await PanelDeploymentRun.updateOne({ runId: orphan.runId }, {
      $set: {
        status: 'interrupted',
        finishedAt: nowIso(),
        workerPid: null,
        summary: 'Exécution interrompue : le processus n’a pas conclu. '
          + 'Son issue est INCONNUE — vérifiez l’état réel du serveur avant de relancer.',
      },
    });
  }
  return orphans.length;
}

export default {
  createRun, attachWorker, heartbeat, recordStep, appendLog, finalizeRun,
  getRunOrThrow, describeRun, summariseRun, listRuns, activeRunFor, finalizeOrphanRuns,
  HEARTBEAT_TIMEOUT_MS,
};
