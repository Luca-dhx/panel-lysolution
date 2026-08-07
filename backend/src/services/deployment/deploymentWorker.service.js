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
  /**
   * ROMPRE LE LIEN DE FILIATION — `detached` n'y suffit pas.
   *
   * ── CE QUI A RÉELLEMENT TUÉ LE WORKER ─────────────────────────────────────
   * `detached: true` fait du worker le chef de son propre GROUPE de processus :
   * il n'est plus atteint par un signal envoyé au groupe du backend. Mais il
   * n'en reste pas moins son ENFANT — son PPID pointe toujours sur l'API tant
   * qu'elle vit.
   *
   * Or PM2 arrête ses applications en tuant l'ARBRE (`treekill`, actif par
   * défaut) : il énumère les descendants par PPID et les signale tous. Au
   * `pm2 reload` de l'étape `services.start`, le worker était donc trouvé et
   * tué avec le service qu'il était en train de déployer — exactement au
   * moment où il devait constater le redémarrage.
   *
   * `setsid` règle cela d'une manière que rien ne contourne : il se dédouble,
   * puis s'efface. Le worker est alors adopté par le processus initial, son
   * PPID vaut 1, et aucune énumération de descendants ne peut plus le
   * rattacher au backend. Absent (Windows en développement), on retombe sur le
   * lancement direct : le comportement est celui d'avant, jamais pire.
   */
  const parSetsid = process.platform !== 'win32';
  const commande = parSetsid ? 'setsid' : process.execPath;
  const arguments_ = parSetsid ? [process.execPath, WORKER_PATH] : [WORKER_PATH];

  const environnement = {
    ...process.env,
    PANEL_DEPLOY_RUN_ID: runId,
    PANEL_DEPLOY_TARGET_ID: targetId,
    PANEL_DEPLOY_OPERATION: operationType,
    /**
     * LE PID DE L'API QUI LANCE — le worker ne peut pas le deviner.
     *
     * C'est ce processus-là qui doit mourir pour qu'un redémarrage attendu soit
     * avéré. Le laisser déduire du PID du worker revenait à comparer deux
     * processus différents par construction, donc à conclure au redémarrage à
     * chaque démarrage.
     */
    PANEL_DEPLOY_API_PID: String(process.pid),
    // Le secret voyage ici, et nulle part ailleurs. `argv` serait lisible par
    // `ps aux` pour tout utilisateur de la machine ; l'environnement d'un
    // processus ne l'est que par son propriétaire et root.
    PANEL_DEPLOY_SSH_PASSWORD: sshPassword ?? '',
    PANEL_DEPLOY_RELEASE_ID: releaseId ?? '',
    PANEL_DEPLOY_USER: user ?? '',
    // Options NON SECRÈTES de l'opération (ex. « oui, efface aussi les données
    // persistantes »). Elles décrivent une décision de l'opérateur que le
    // worker doit connaître, et qui ne doit pas être relue depuis la fiche —
    // la fiche ne porte pas une confirmation.
    PANEL_DEPLOY_OPTIONS: options ? JSON.stringify(options) : '',
  };

  const child = spawn(commande, arguments_, {
    cwd: backendRoot,
    // `detached` permet au worker de survivre au redémarrage du backend — c'est
    // indispensable quand le Panel se déploie LUI-MÊME. Sur Windows, un enfant
    // détaché reçoit CREATE_NEW_CONSOLE : une fenêtre s'ouvre et reste affichée
    // pendant tout le déploiement. `windowsHide` est l'option Node prévue pour
    // la supprimer, sans rien changer au détachement ni à la survie du worker.
    detached: true,
    windowsHide: true,
    stdio: 'ignore',
    env: environnement,
  });

  /**
   * `setsid` absent sur cette machine : on relance sans lui plutôt que
   * d'échouer. Le déploiement reste possible, avec la réserve d'avant — et
   * elle est journalisée, pas tue.
   */
  child.on('error', (err) => {
    if (!parSetsid || err.code !== 'ENOENT') {
      logger.error(`Worker de déploiement non démarré (run ${runId}) : ${err.message}`);
      return;
    }
    logger.warn('`setsid` introuvable : worker lancé en filiation directe, '
      + 'il ne survivra pas à un arrêt en arbre du backend.');
    const secours = spawn(process.execPath, [WORKER_PATH], {
      cwd: backendRoot, detached: true, windowsHide: true, stdio: 'ignore', env: environnement,
    });
    secours.unref();
  });

  child.unref();
  logger.info(`Worker de déploiement démarré (run ${runId}, ${operationType})`
    + `${parSetsid ? ', détaché de sa filiation' : ` — pid ${child.pid}`}.`);
  // Le PID rendu ici est celui du lanceur, pas du worker : avec `setsid`, le
  // worker s'enregistre lui-même par `attachWorker`, et c'est CE pid qui fait
  // foi. Aucun appelant ne se sert de celui-ci autrement que pour un message.
  return { pid: child.pid ?? null };
}

/** Chemin du worker — exposé pour que les tests vérifient sa présence. */
export const workerPath = WORKER_PATH;

export default { startDeploymentWorker, workerPath };
