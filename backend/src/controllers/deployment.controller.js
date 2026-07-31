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
import {
  createTarget, deleteTarget, deploymentSummary, describeTarget,
  getTargetOrThrow, listTargets, markDeploying, updateTarget,
} from '../services/deployment/deploymentTarget.service.js';
import {
  activeRunFor, createRun, getRunOrThrow, listRuns,
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

  return created(res, {
    runId,
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
