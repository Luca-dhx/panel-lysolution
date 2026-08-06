/**
 * JOURNAL FORENSIQUE D'UN DÉPLOIEMENT — append-only, persistant, sans secret.
 *
 * ══ IDENTIQUE À CELUI DE SB AUTO, À UNE CHOSE PRÈS ══════════════════════════
 *
 * Le Panel identifie ses runs par un `runId` (UUID) et non par l'`_id` Mongo :
 * ses écritures ciblent donc `{ runId }`. Le reste — sources, niveaux, codes
 * d'évènement, sanitizer, `$push` atomique — est le même mot pour mot. Deux
 * doctrines divergentes seraient pires que pas de journal du tout : on ne
 * saurait plus lequel des deux dit la vérité.
 *
 * ══ LE MANQUE QU'IL COMBLE ══════════════════════════════════════════════════
 *
 * Diagnostiquer un déploiement exigeait jusqu'ici un terminal SSH, `pm2 logs`,
 * et l'onglet Réseau d'un navigateur ouvert AU BON MOMENT. Trois conditions
 * dont aucune n'est réunie quand l'incident se produit — et la seule trace
 * utile, le flux NDJSON, disparaissait avec l'onglet.
 *
 * Pire : quand la panne survenait AVANT la création du run, il ne restait
 * rien du tout. « Aucun run n'a été créé, donc on ne sait pas » n'est pas un
 * diagnostic, c'est un aveu.
 *
 * ══ LE PRINCIPE ═════════════════════════════════════════════════════════════
 *
 *   · APPEND-ONLY : on ajoute, on ne réécrit jamais. Un journal qu'on corrige
 *     ne raconte plus ce qui s'est passé, mais ce qu'on a compris ensuite ;
 *   · PERSISTANT : chaque entrée part en base immédiatement. Si le process
 *     meurt à la ligne suivante — c'est précisément le cas qu'on traque — la
 *     trace existe déjà ;
 *   · SANS SECRET : tout passe par le sanitizer central ;
 *   · NON BLOQUANT : journaliser ne doit jamais faire échouer une opération.
 *     Une écriture ratée est signalée en console, jamais propagée.
 *
 * ══ POURQUOI `$push` ET PAS `save()` ════════════════════════════════════════
 *
 * Un `save()` relit, modifie et réécrit le document entier : deux écritures
 * concurrentes se perdent, et le verrouillage optimiste de Mongoose lève une
 * `VersionError`. Le journal reçoit des entrées depuis le pipeline, le
 * transport SSH et le middleware HTTP EN MÊME TEMPS. `$push` est atomique et
 * ne relit rien : c'est la seule primitive correcte ici.
 */
import { randomUUID } from 'node:crypto';

import PanelDeploymentRun from '../../../models/PanelDeploymentRun.model.js';
import PanelDeploymentAttempt from '../../../models/PanelDeploymentAttempt.model.js';
import { sanitizeText, sanitizeValue } from './sanitize.js';

/** D'OÙ vient l'entrée. Un journal sans provenance ne se filtre pas. */
export const SOURCES = Object.freeze({
  ENGINE: 'ENGINE',
  HTTP: 'HTTP',
  SSH: 'SSH',
  PM2: 'PM2',
  SOCKET: 'SOCKET',
  WORKER: 'WORKER',
  FINALIZATION: 'FINALIZATION',
  BRIDGE: 'BRIDGE',
  SYSTEM: 'SYSTEM',
});

export const LEVELS = Object.freeze({
  DEBUG: 'debug', INFO: 'info', WARNING: 'warning', ERROR: 'error',
});

/**
 * LES ÉVÈNEMENTS, nommés une fois pour toutes.
 *
 * Des chaînes libres auraient dérivé au premier ajout : `SSH_TIMEOUT` ici,
 * `ssh.timeout` ailleurs, et un filtre d'interface qui ne trouve plus rien.
 */
export const EVENTS = Object.freeze({
  // Requête HTTP
  HTTP_REQUEST_STARTED: 'HTTP_REQUEST_STARTED',
  HTTP_STREAM_OPENED: 'HTTP_STREAM_OPENED',
  HTTP_STREAM_ABORTED: 'HTTP_STREAM_ABORTED',
  HTTP_STREAM_COMPLETED: 'HTTP_STREAM_COMPLETED',
  /** Le backend vit, mais l'écriture dans le flux a échoué : canal rompu en aval. */
  HTTP_STREAM_WRITE_FAILED: 'HTTP_STREAM_WRITE_FAILED',
  HTTP_RESPONSE_COMPLETED: 'HTTP_RESPONSE_COMPLETED',
  HTTP_REQUEST_FAILED: 'HTTP_REQUEST_FAILED',
  // Connexion au serveur
  SSH_CONNECT_STARTED: 'SSH_CONNECT_STARTED',
  SSH_READY: 'SSH_READY',
  SSH_TIMEOUT: 'SSH_TIMEOUT',
  SSH_ERROR: 'SSH_ERROR',
  SSH_CLOSED: 'SSH_CLOSED',
  SSH_ENDED: 'SSH_ENDED',
  // Service applicatif
  PM2_STATE_BEFORE: 'PM2_STATE_BEFORE',
  PM2_RESTART_REQUESTED: 'PM2_RESTART_REQUESTED',
  PM2_STATE_AFTER: 'PM2_STATE_AFTER',
  PM2_PROCESS_UNSTABLE: 'PM2_PROCESS_UNSTABLE',
  SOCKET_OWNER_VERIFIED: 'SOCKET_OWNER_VERIFIED',
  PM2_PORT_NOT_OWNED: 'PM2_PORT_NOT_OWNED',
  // Auto-redéploiement
  APPLICATION_RESTART_EXPECTED: 'APPLICATION_RESTART_EXPECTED',
  APPLICATION_RESTART_COMPLETED: 'APPLICATION_RESTART_COMPLETED',
  // Cycle de vie du process
  RUN_INTERRUPTED_BY_PROCESS_RESTART: 'RUN_INTERRUPTED_BY_PROCESS_RESTART',
  /**
   * Le run a TRAVERSÉ un redémarrage attendu sans être interrompu.
   *
   * C'est l'exact contraire du précédent, et les deux ne peuvent pas décrire
   * le même redémarrage. Voir `APPLICATION_RESTART_COMPLETED` suivi de
   * `RUN_INTERRUPTED_BY_PROCESS_RESTART` était le symptôme d'une reprise qui
   * ignorait ce qu'elle venait elle-même de constater.
   */
  RUN_RESUMED_AFTER_EXPECTED_RESTART: 'RUN_RESUMED_AFTER_EXPECTED_RESTART',
  UNHANDLED_REJECTION: 'UNHANDLED_REJECTION',
  UNCAUGHT_EXCEPTION: 'UNCAUGHT_EXCEPTION',
  // Étapes
  STEP_STARTED: 'STEP_STARTED',
  STEP_SUCCEEDED: 'STEP_SUCCEEDED',
  STEP_WARNING: 'STEP_WARNING',
  STEP_FAILED: 'STEP_FAILED',
  STEP_SKIPPED: 'STEP_SKIPPED',
  STEP_INTERRUPTED: 'STEP_INTERRUPTED',
  // Finalisation
  FINALIZATION_STARTED: 'FINALIZATION_STARTED',
  FINALIZATION_SUCCEEDED: 'FINALIZATION_SUCCEEDED',
  FINALIZATION_FAILED: 'FINALIZATION_FAILED',
});

/** Un identifiant de requête, si l'appelant n'en fournit pas. */
export const newRequestId = () => randomUUID().slice(0, 8);

/**
 * La pile n'est conservée que si l'exploitant l'a autorisé.
 *
 * Elle est utile au diagnostic et révèle l'arborescence du serveur : elle est
 * donc SANITIZÉE, et son enregistrement reste un choix explicite.
 */
function stackAutorisee() {
  return process.env.DEPLOYMENT_DIAGNOSTIC_STACKS !== 'false';
}

/**
 * AJOUTE une entrée au journal d'un run.
 *
 * Ne lève JAMAIS : journaliser un incident ne doit pas en provoquer un second.
 * `runId` absent ⇒ l'entrée est écartée en silence plutôt que de chercher un
 * run au hasard.
 */
export async function journal(runId, {
  source = SOURCES.SYSTEM,
  level = LEVELS.INFO,
  eventCode,
  stepId = null,
  message = null,
  details = null,
  pid = null,
  port = null,
  processName = null,
  requestId = null,
  errorCode = null,
  error = null,
} = {}) {
  if (!runId || !eventCode) return null;

  const entree = {
    at: new Date(),
    source,
    level,
    eventCode,
    stepId,
    message: message ? sanitizeText(message) : null,
    details: details ? sanitizeValue(details) : null,
    pid: pid ?? null,
    port: port ?? null,
    processName: processName ?? null,
    requestId: requestId ?? null,
    errorCode: errorCode ?? error?.code ?? null,
    stack: error && stackAutorisee() ? sanitizeText(error.stack ?? String(error)) : null,
  };

  try {
    await PanelDeploymentRun.updateOne({ runId }, { $push: { journal: entree } });
  } catch (err) {
    // Le journal est un témoin, jamais un participant : son échec ne casse rien.
    // eslint-disable-next-line no-console
    console.error(`[forensique] entrée « ${eventCode} » non persistée : ${err.message}`);
  }
  return entree;
}

/**
 * TRACE PRÉ-RUN — quand il n'y a pas encore de run à journaliser.
 *
 * ── LE CAS QU'ELLE COUVRE ───────────────────────────────────────────────────
 * Un HTTP 500 survenu AVANT `createRun` ne laissait aucune trace : ni run, ni
 * étape, ni rien. C'est exactement ce qui s'est produit le 06/08, et c'est ce
 * qui a rendu la cause indémontrable.
 *
 * Chaque tentative ouvre donc une trace AVANT toute autre chose. Elle est
 * rattachée au run dès qu'il existe, ce qui recolle les deux moitiés de
 * l'histoire.
 */
export async function openAttempt({ requestId, route, method, targetId = null, user = null }) {
  try {
    const doc = await PanelDeploymentAttempt.create({
      requestId,
      route,
      method,
      target: targetId ?? null,
      user: user ?? null,
      startedAt: new Date(),
      status: 'open',
      journal: [],
    });
    return doc;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`[forensique] tentative non ouverte : ${err.message}`);
    return null;
  }
}

/** Ajoute au journal d'une TENTATIVE (avant l'existence d'un run). */
export async function journalAttempt(attemptId, entree) {
  if (!attemptId) return null;
  const propre = {
    at: new Date(),
    source: entree.source ?? SOURCES.HTTP,
    level: entree.level ?? LEVELS.INFO,
    eventCode: entree.eventCode,
    stepId: entree.stepId ?? null,
    message: entree.message ? sanitizeText(entree.message) : null,
    details: entree.details ? sanitizeValue(entree.details) : null,
    pid: entree.pid ?? null,
    port: entree.port ?? null,
    processName: entree.processName ?? null,
    requestId: entree.requestId ?? null,
    errorCode: entree.errorCode ?? entree.error?.code ?? null,
    stack: entree.error && stackAutorisee() ? sanitizeText(entree.error.stack ?? String(entree.error)) : null,
  };
  try {
    await PanelDeploymentAttempt.updateOne({ _id: attemptId }, { $push: { journal: propre } });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`[forensique] entrée de tentative non persistée : ${err.message}`);
  }
  return propre;
}

/** Rattache la tentative au run dès qu'il existe, puis la clôt. */
export async function closeAttempt(attemptId, { runId = null, status = 'closed', httpStatus = null } = {}) {
  if (!attemptId) return;
  try {
    await PanelDeploymentAttempt.updateOne({ _id: attemptId }, {
      $set: {
        run: runId, status, httpStatus,
        finishedAt: new Date(),
      },
    });
  } catch { /* la clôture d'une trace ne doit jamais casser une requête */ }
}

export default {
  SOURCES, LEVELS, EVENTS, newRequestId,
  journal, openAttempt, journalAttempt, closeAttempt,
};
