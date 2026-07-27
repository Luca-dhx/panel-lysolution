/**
 * Gestion du process backend via PM2.
 *
 * Chaque cible fait tourner une instance backend nommée de façon déterministe
 * (`<slug>-<host>`, le slug venant du profil de projet) sur un port local
 * dédié. On (re)démarre l'app, on persiste la liste PM2 (survie au reboot).
 */
import { serviceName } from './config/project.profile.js';

/** Nom PM2 déterministe d'une cible. */
export function pm2AppName(host) {
  return serviceName(host);
}

/**
 * (Re)démarre le backend d'une cible sous PM2.
 * @param {object} args
 * @param {string} args.host        Hôte de la cible (nommage PM2).
 * @param {string} args.backendDir  Dossier backend déployé sur le VPS.
 * @param {number} args.port        Port local d'écoute.
 * @param {'PROD'|'TEST'} args.env  ENV applicatif (PROD par défaut en déploiement).
 * @returns {Promise<{name:string, restarted:boolean}>}
 */
export async function restartBackend(transport, { host, backendDir, port, env = 'PROD' }) {
  const name = pm2AppName(host);

  // Existe déjà ? -> reload (zéro downtime). Sinon -> start.
  const list = await transport.exec(`pm2 jlist 2>/dev/null || echo '[]'`);
  let running = false;
  try {
    running = JSON.parse(list.stdout || '[]').some((p) => p.name === name);
  } catch {
    running = list.stdout.includes(name);
  }

  const startCmd =
    `cd ${backendDir} && PORT=${port} ENV=${env} pm2 start src/server.js ` +
    `--name ${name} --update-env`;
  const reloadCmd = `cd ${backendDir} && PORT=${port} ENV=${env} pm2 reload ${name} --update-env`;

  const cmd = running ? reloadCmd : startCmd;
  const res = await transport.exec(cmd, { timeoutMs: 60_000 });
  if (res.code !== 0) {
    const { DeploymentError } = await import('./errors.js');
    throw new DeploymentError('PM2_RESTART_FAILED', `Échec du (re)démarrage PM2 de ${name}.`, {
      step: 'pm2',
      details: { output: (res.stderr || res.stdout).slice(0, 500) },
    });
  }
  await transport.exec('pm2 save');
  return { name, restarted: running };
}

export default { restartBackend, pm2AppName };
