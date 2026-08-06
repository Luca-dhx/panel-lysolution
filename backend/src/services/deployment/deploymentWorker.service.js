// LANCEMENT DU WORKER DÉTACHÉ — Phase 4.
//
// Ce module ne fait qu'une chose : démarrer `scripts/deploy-worker.js` de
// telle sorte qu'il SURVIVE à l'arrêt du backend qui l'a lancé.
//
// Les trois options qui rendent cela vrai, et pourquoi :
//
//   detached: true    Le worker devient chef de son propre groupe de
//                     processus. Sans cela, un signal envoyé au backend (ce
//                     que fait `pm2 restart`) serait propagé au worker, et le
//                     déploiement mourrait avec le processus qu'il déploie.
//
//   stdio: 'ignore'   Aucun tube entre parent et enfant. Un tube maintiendrait
//                     une référence vivante entre eux, et l'enfant recevrait
//                     EPIPE dès que le parent disparaîtrait. Tout ce que le
//                     worker a à dire, il l'écrit en base.
//
//   .unref()          Le backend cesse de compter le worker dans ses
//                     événements en attente : il peut s'arrêter proprement
//                     sans attendre la fin du déploiement.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import logger from '../../utils/logger.js';

const backendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const WORKER_PATH = path.join(backendRoot, 'src', 'scripts', 'deploy-worker.js');

/**
 * Démarre le worker.
 *
 * @param {object} args
 * @param {string} args.runId
 * @param {string} args.targetId
 * @param {string} args.operationType
 * @param {string} args.sshPassword    transmis par l'ENVIRONNEMENT, jamais par argv
 * @param {string} [args.releaseId]
 * @param {string} [args.user]
 * @returns {{pid: number}}
 */
export function startDeploymentWorker({
  runId, targetId, operationType, sshPassword, releaseId = null, user = null, options = null,
}) {
  const child = spawn(process.execPath, [WORKER_PATH], {
    cwd: backendRoot,
    // `detached` permet au worker de survivre au redémarrage du backend — c'est
    // indispensable quand le Panel se déploie LUI-MÊME. Sur Windows, un enfant
    // détaché reçoit CREATE_NEW_CONSOLE : une fenêtre s'ouvre et reste affichée
    // pendant tout le déploiement. `windowsHide` est l'option Node prévue pour
    // la supprimer, sans rien changer au détachement ni à la survie du worker.
    detached: true,
    windowsHide: true,
    stdio: 'ignore',
    env: {
      ...process.env,
      PANEL_DEPLOY_RUN_ID: runId,
      PANEL_DEPLOY_TARGET_ID: targetId,
      PANEL_DEPLOY_OPERATION: operationType,
      // Le secret voyage ici, et nulle part ailleurs. `argv` serait lisible
      // par `ps aux` pour tout utilisateur de la machine ; l'environnement
      // d'un processus ne l'est que par son propriétaire et root.
      PANEL_DEPLOY_SSH_PASSWORD: sshPassword ?? '',
      PANEL_DEPLOY_RELEASE_ID: releaseId ?? '',
      PANEL_DEPLOY_USER: user ?? '',
      // Options NON SECRÈTES de l'opération (ex. « oui, efface aussi les
      // données persistantes »). Sérialisées : elles décrivent une décision
      // de l'opérateur que le worker doit connaître, et qui ne doit pas être
      // relue depuis la fiche — la fiche ne porte pas une confirmation.
      PANEL_DEPLOY_OPTIONS: options ? JSON.stringify(options) : '',
    },
  });

  child.unref();
  logger.info(`Worker de déploiement démarré (pid ${child.pid}, run ${runId}, ${operationType}).`);
  return { pid: child.pid };
}

/** Chemin du worker — exposé pour que les tests vérifient sa présence. */
export const workerPath = WORKER_PATH;

export default { startDeploymentWorker, workerPath };
