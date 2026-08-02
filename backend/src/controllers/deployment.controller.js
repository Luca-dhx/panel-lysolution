// Surface de DÉPLOIEMENT (/api/deployment) — Phase 4.
//
// Le Panel se déploie lui-même, comme SB Auto 06 se déploie lui-même, et par
// le même moteur.
//
// ── DEUX RÈGLES TENUES ICI ──────────────────────────────────────────────────
//
//  1. Le mot de passe SSH traverse ce contrôleur et ne s'y arrête pas. Il
//     n'est ni stocké, ni journalisé, ni renvoyé. Il part directement dans
//     l'environnement du worker détaché.
//
//  2. Aucune opération ne s'exécute dans la requête HTTP. Toutes passent par
//     le worker, et la requête ne rend qu'un identifiant de run. C'est ce qui
//     permet au Panel de se déployer lui-même sans perdre le fil : la requête
//     peut être coupée, le déploiement continue.
import { created, ok } from '../utils/apiResponse.js';
import ApiError from '../utils/ApiError.js';
import config from '../config/env.js';
import { DeploymentEngine } from '../deployment-engine/DeploymentEngine.js';
import {
  createTarget, deleteTarget, deploymentSummary, describeTarget,
  getTargetOrThrow, listTargets, markDeploying, updateTarget,
} from '../services/deployment/deploymentTarget.service.js';
import {
  activeRunFor, createRun, getRunOrThrow, listRuns, readEventsSince,
} from '../services/deployment/deploymentRun.service.js';
import { startDeploymentWorker } from '../services/deployment/deploymentWorker.service.js';
import { OPERATIONS, executeOperation } from '../services/deployment/deploymentExecutor.service.js';

function actorOf(req) {
  return { userId: req.panelUser.userId, userEmail: req.panelUser.email };
}

/* -------------------------------------------------------------------------- */
/*  DESTINATIONS                                                              */
/* -------------------------------------------------------------------------- */

export async function overview(_req, res) {
  const [targets, summary, runs] = await Promise.all([
    listTargets(),
    deploymentSummary(),
    listRuns({ limit: 10 }),
  ]);
  return ok(res, { targets, summary, recentRuns: runs });
}

export async function detail(req, res) {
  const target = await getTargetOrThrow(req.params.targetId);
  const [runs, active] = await Promise.all([
    listRuns({ targetId: target.targetId, limit: 30 }),
    activeRunFor(target.targetId),
  ]);
  return ok(res, { target: describeTarget(target), runs, activeRun: active });
}

export async function create(req, res) {
  return created(res, await createTarget(req.body ?? {}, actorOf(req)));
}

export async function update(req, res) {
  return ok(res, await updateTarget(req.params.targetId, req.body ?? {}, actorOf(req)));
}

export async function remove(req, res) {
  return ok(res, await deleteTarget(req.params.targetId));
}

/* -------------------------------------------------------------------------- */
/*  OPÉRATIONS                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Démarre une opération sur une destination.
 *
 * Le corps porte `sshPassword`. C'est le seul appel du Panel qui transporte
 * un secret d'infrastructure, et il ne fait que le relayer : rien ne
 * l'écrit, rien ne le renvoie.
 */
async function startOperation(req, res, operationType) {
  const target = await getTargetOrThrow(req.params.targetId);
  const sshPassword = req.body?.sshPassword;

  if (!sshPassword || String(sshPassword).length === 0) {
    throw ApiError.badRequest('PANEL_DEPLOY_PASSWORD_REQUIRED',
      'Opération refusée parce qu’aucun mot de passe SSH n’a été fourni. '
      + 'Le Panel n’en conserve aucun : il est demandé à chaque opération.');
  }

  // Une seule opération à la fois par destination : deux déploiements
  // simultanés sur le même hôte se marcheraient dessus (mêmes chemins, même
  // service PM2, même configuration nginx).
  const active = await activeRunFor(target.targetId);
  if (active) {
    throw ApiError.conflict('PANEL_DEPLOY_ALREADY_RUNNING',
      `Opération refusée parce qu’une exécution est déjà en cours sur « ${target.name} » `
      + `(${active.operationType}, démarrée le ${active.startedAt}).`,
      { runId: active.runId });
  }

  // PROD exige une confirmation explicite. Le coût d'une erreur y est
  // différent, et un clic de trop est moins cher qu'une production cassée.
  if (target.environment === 'PROD'
    && operationType === OPERATIONS.DEPLOYMENT
    && req.body?.confirmProduction !== true) {
    throw ApiError.badRequest('PANEL_DEPLOY_CONFIRMATION_REQUIRED',
      `Déploiement refusé parce que « ${target.name} » est une destination de PRODUCTION `
      + 'et que la confirmation explicite est absente.');
  }

  // ── PRÉREQUIS LOCAUX — AVANT TOUT EFFET DE BORD ─────────────────────────
  // Évalués sur la machine qui pilote : aucune connexion, aucune écriture.
  // Un échec ici signifie que le déploiement N'A PAS COMMENCÉ — pas de run,
  // pas de worker, pas de SSH, pas de DNS, pas de dossier distant. C'est la
  // raison d'être de ce placement : le contrôle de source vivait auparavant
  // dans `artifact.build`, donc APRÈS les mutations DNS.
  if (operationType === OPERATIONS.DEPLOYMENT) {
    const local = await new DeploymentEngine({ mongoUri: config.mongoUri })
      .checkLocalPrerequisites({ env: target.environment });
    if (!local.ok) {
      const source = local.failedChecks.find((c) => c.id === 'source.clean');
      throw ApiError.badRequest('PANEL_DEPLOY_LOCAL_PREREQUISITES_FAILED',
        'Impossible de lancer le déploiement : Source Git non commitée.', {
          scope: 'local',
          pipelineExecuted: false,
          checks: local.checks,
          failedChecks: local.failedChecks,
          files: source?.files ?? [],
        });
    }
  }

  const selfDeployment = target.selfHosted === true && operationType === OPERATIONS.DEPLOYMENT;

  const runId = await createRun({
    target,
    operationType,
    user: req.panelUser.email,
    selfDeployment,
  });
  if (operationType === OPERATIONS.DEPLOYMENT || operationType === OPERATIONS.ROLLBACK) {
    await markDeploying(target.targetId, runId);
  }

  startDeploymentWorker({
    runId,
    targetId: target.targetId,
    operationType,
    sshPassword,
    releaseId: req.body?.releaseId ?? null,
    user: req.panelUser.email,
  });

  // 202 ACCEPTED, pas 201 : rien n'est créé côté serveur au sens REST — une
  // exécution est ACCEPTÉE et se poursuivra ailleurs. Le client reçoit de quoi
  // la suivre, pas son résultat.
  return res.status(202).json({
    success: true,
    data: {
      runId,
      executionId: runId,
      status: 'queued',
      operationType,
      selfDeployment,
      // L'interface DOIT prévenir : le backend qu'elle interroge est celui qui
      // va redémarrer. Sans cet avertissement, une coupure momentanée passerait
      // pour un échec.
      notice: selfDeployment
        ? 'Ce déploiement met à jour le Panel que vous utilisez. Son backend redémarrera : '
          + 'l’interface deviendra brièvement injoignable. Le déploiement se poursuit dans un '
          + 'processus séparé — rechargez cette page pour retrouver son issue.'
        : null,
    },
  });
}

export const testConnection = (req, res) => startOperation(req, res, OPERATIONS.CONNECTION_TEST);
export const preflight = (req, res) => startOperation(req, res, OPERATIONS.PRECHECK);
export const simulate = (req, res) => startOperation(req, res, OPERATIONS.SIMULATION);
export const deploy = (req, res) => startOperation(req, res, OPERATIONS.DEPLOYMENT);
export const rollback = (req, res) => startOperation(req, res, OPERATIONS.ROLLBACK);

/* -------------------------------------------------------------------------- */
/*  RUNS                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * État d'un run. L'interface interroge cette route en boucle pendant une
 * opération : c'est le remplacement délibéré d'un flux HTTP, qui ne
 * survivrait pas au redémarrage du backend.
 */
export async function run(req, res) {
  return ok(res, await getRunOrThrow(req.params.runId));
}

/**
 * FLUX REPRENABLE des évènements d'un run (NDJSON, une ligne = un évènement).
 *
 * ── POURQUOI PAS LE FLUX DE SB AUTO ─────────────────────────────────────────
 * SB Auto diffuse le déploiement DEPUIS la requête qui l'exécute : son backend
 * n'est jamais l'application déployée, la connexion survit donc à l'opération.
 * Le Panel, lui, se déploie LUI-MÊME : à l'étape `services.start`, PM2
 * redémarre le processus qui servirait le flux. Toute connexion ouverte meurt.
 *
 * Ce flux-ci est donc alimenté par le JOURNAL PERSISTÉ qu'écrit le worker
 * détaché, et non par l'exécution. Conséquences :
 *   · le client se reconnecte avec `?since=<dernier seq reçu>` et reprend
 *     exactement où il en était — aucune perte, aucun doublon ;
 *   · l'ordre est garanti par le numéro de séquence, pas par l'ordre d'arrivée ;
 *   · une coupure due au redémarrage n'est plus un trou, c'est une pause.
 *
 * `truncated: true` signale un client trop en retard (journal borné) : il doit
 * recharger l'état complet plutôt que rejouer une suite incomplète.
 */
export async function runStream(req, res) {
  const { runId } = req.params;
  const since0 = Number.parseInt(req.query.since ?? '0', 10);
  const first = await readEventsSince(runId, Number.isFinite(since0) ? since0 : 0);
  if (!first) throw ApiError.notFound('PANEL_RUN_NOT_FOUND', `Exécution « ${runId} » introuvable.`);

  res.status(200);
  res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('X-Accel-Buffering', 'no'); // Nginx ne doit pas tamponner le flux
  res.flushHeaders?.();

  let cursor = Number.isFinite(since0) ? since0 : 0;
  let closed = false;
  req.on('close', () => { closed = true; });

  const write = (obj) => res.write(`${JSON.stringify(obj)}
`);

  // Le serveur interroge la base ; le client, lui, ne sonde JAMAIS : il lit un
  // flux continu. La latence perçue est celle de cette boucle, pas d'un
  // rafraîchissement d'interface.
  const TICK_MS = 250;
  const IDLE_KEEPALIVE_MS = 15_000;
  let lastWrite = Date.now();

  try {
    let batch = first;
    for (;;) {
      if (closed) break;
      if (batch.truncated) {
        // Le client repart de l'état complet ; on lui donne le curseur EXACT
        // auquel reprendre, sinon il ne saurait pas quoi demander ensuite.
        write({ kind: 'reload', reason: 'journal tronqué', lastSeq: batch.lastSeq });
        break;
      }
      for (const evt of batch.events) {
        write(evt);
        cursor = evt.seq;
        lastWrite = Date.now();
      }
      const terminal = batch.status && batch.status !== 'running';
      if (terminal && cursor >= batch.lastSeq) { write({ kind: 'end', status: batch.status, seq: cursor }); break; }
      if (Date.now() - lastWrite > IDLE_KEEPALIVE_MS) { write({ kind: 'ping', seq: cursor }); lastWrite = Date.now(); }
      await new Promise((r) => { setTimeout(r, TICK_MS); });
      batch = await readEventsSince(runId, cursor);
      if (!batch) break;
    }
  } finally {
    res.end();
  }
  return undefined;
}

export async function runs(req, res) {
  return ok(res, {
    items: await listRuns({
      targetId: req.query.targetId ?? null,
      limit: Number(req.query.limit ?? 30),
    }),
  });
}

/* -------------------------------------------------------------------------- */
/*  RELEASES                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Liste les releases présentes sur une destination.
 *
 * Exécutée DANS la requête, contrairement aux autres opérations : c'est une
 * lecture courte, sans effet, et l'opérateur en a besoin immédiatement pour
 * choisir vers quelle release revenir.
 */
export async function releases(req, res) {
  const target = await getTargetOrThrow(req.params.targetId);
  const sshPassword = req.body?.sshPassword;
  if (!sshPassword) {
    throw ApiError.badRequest('PANEL_DEPLOY_PASSWORD_REQUIRED',
      'Lecture refusée parce qu’aucun mot de passe SSH n’a été fourni.');
  }

  const outcome = await executeOperation({
    operationType: OPERATIONS.CONNECTION_TEST,
    target: describeTarget(target),
    sshPassword,
    onStep: () => {},
    onLog: () => {},
  });

  if (outcome.status !== 'ok') {
    throw ApiError.badRequest('PANEL_DEPLOY_UNREACHABLE', outcome.summary);
  }
  return ok(res, {
    host: target.host,
    current: outcome.currentRelease ?? null,
    releases: outcome.releases ?? [],
  });
}

/** Ce que le Panel sait de lui-même — utile avant de configurer. */
export async function self(_req, res) {
  const { resolveBackendUrl } = await import('../services/network/networkConfig.service.js');
  const profile = await import('../deployment-engine/config/project.profile.js');
  const backend = await resolveBackendUrl();
  return ok(res, {
    environment: config.env,
    publicUrl: backend.url,
    publicUrlSource: backend.source,
    projectSlug: profile.PROJECT_SLUG,
    projectId: profile.PROJECT_ID,
    apps: profile.APPS.map((a) => ({ id: a.id, dir: a.dir, role: a.role, nginxRole: a.nginxRole })),
    wildcardBases: profile.DEFAULT_WILDCARD_BASES,
    defaultRemoteRoot: profile.DEFAULT_REMOTE_ROOT,
  });
}
