/**
 * Sauvegarde & restauration d'une cible déployée.
 *
 * Contenu d'un backup (cahier des charges §10) :
 *   - base MongoDB (mongodump) ;
 *   - uploads ;
 *   - configuration (nginx + .env applicatif, SANS secret VPS) ;
 *   - version déployée ;
 *   - le tout dans une archive .tar.gz horodatée sur le VPS.
 *
 * Tout passe par le Transport : testable sans VPS. Aucun mot de passe VPS n'est
 * inscrit dans l'archive (il n'existe qu'en RAM le temps du transfert).
 */

import { assertSafeDbName, assertSafeArchive, assertSafePath } from './safety.js';
import { BACKUP_ROOT, PROJECT_SLUG } from './config/project.profile.js';

/** Chemin de l'archive de backup pour une cible + horodatage. */
export function backupArchivePath(host, stamp) {
  return `${BACKUP_ROOT}/${host}-${stamp}.tar.gz`;
}

/**
 * Crée une archive de sauvegarde d'une cible sur le VPS.
 * @param {object} args
 * @param {import('./transport/Transport.js').Transport} args.transport
 * @param {string} args.host       Hôte de la cible.
 * @param {string} args.dbName     Base MongoDB de la cible.
 * @param {string} args.mongoUri   URI MongoDB (mongodump). Jamais journalisé.
 * @param {string} args.version    Version déployée (inscrite au manifest).
 * @param {string} args.stamp      Horodatage (fourni par l'appelant, pas de Date.now interne).
 * @param {string} [args.remoteRoot]
 * @returns {Promise<{archive:string, dbName:string, version:string}>}
 */
export async function createBackup({ transport, host, dbName, mongoUri, version, stamp, remoteRoot = '/var/www' }) {
  // Anti-injection : ces valeurs entrent dans des commandes distantes.
  assertSafeDbName(dbName);
  assertSafePath(remoteRoot);
  const siteRoot = `${remoteRoot}/${host}`;
  const staging = `/tmp/${PROJECT_SLUG}-backup-${host}-${stamp}`;
  const archive = backupArchivePath(host, stamp);

  await transport.exec(`mkdir -p ${staging}/db ${staging}/uploads ${staging}/config`);

  // 1. Dump MongoDB de la base de la cible.
  await transport.exec(`mongodump --uri='${mongoUri}' --db='${dbName}' --out='${staging}/db'`, {
    timeoutMs: 300_000,
  });

  // 2. Uploads.
  await transport.exec(`cp -a ${siteRoot}/backend/uploads/. ${staging}/uploads/ 2>/dev/null || true`);

  // 3. Configuration : nginx + .env applicatif (sans secret VPS — il n'y est jamais).
  await transport.exec(`cp -a /etc/nginx/sites-available/${host}.conf ${staging}/config/ 2>/dev/null || true`);
  await transport.exec(`cp -a ${siteRoot}/backend/.env ${staging}/config/app.env 2>/dev/null || true`);

  // 4. Manifest de version.
  const manifest = JSON.stringify({ host, dbName, version, stamp }, null, 2);
  await transport.writeFile(`${staging}/manifest.json`, manifest);

  // 5. Archive.
  await transport.exec(`mkdir -p ${BACKUP_ROOT}`);
  await transport.exec(`tar -czf ${archive} -C ${staging} .`, { timeoutMs: 300_000 });
  await transport.exec(`rm -rf ${staging}`);

  return { archive, dbName, version };
}

/**
 * Restaure une cible depuis une archive de sauvegarde.
 * @returns {Promise<{restored:boolean, archive:string}>}
 */
export async function restoreBackup({ transport, host, dbName, mongoUri, archive, remoteRoot = '/var/www' }) {
  assertSafeDbName(dbName);
  assertSafePath(remoteRoot);
  assertSafeArchive(archive);
  const siteRoot = `${remoteRoot}/${host}`;
  const staging = `/tmp/${PROJECT_SLUG}-restore-${host}`;

  const exists = await transport.exec(`test -f ${archive} && echo OK || echo NO`);
  if (!exists.stdout.trim().endsWith('OK')) {
    const { DeploymentError } = await import('./errors.js');
    throw new DeploymentError('BACKUP_NOT_FOUND', `Archive de sauvegarde introuvable : ${archive}`, {
      step: 'restore',
    });
  }

  await transport.exec(`rm -rf ${staging} && mkdir -p ${staging}`);
  await transport.exec(`tar -xzf ${archive} -C ${staging}`, { timeoutMs: 300_000 });

  // 1. MongoDB : restauration avec remplacement (--drop).
  await transport.exec(`mongorestore --uri='${mongoUri}' --drop --db='${dbName}' ${staging}/db/${dbName}`, {
    timeoutMs: 300_000,
  });

  // 2. Uploads.
  await transport.exec(`mkdir -p ${siteRoot}/backend/uploads && cp -a ${staging}/uploads/. ${siteRoot}/backend/uploads/ 2>/dev/null || true`);

  await transport.exec(`rm -rf ${staging}`);
  return { restored: true, archive };
}

/** Liste les archives de backup présentes sur le VPS pour une cible. */
export async function listBackups(transport, host) {
  const res = await transport.exec(`ls -1 ${BACKUP_ROOT}/${host}-*.tar.gz 2>/dev/null || true`);
  return res.stdout
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
}

export default { createBackup, restoreBackup, listBackups, backupArchivePath };
