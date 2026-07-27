/**
 * Garde-fous anti-injection shell (défense en profondeur).
 *
 * Les routes valident déjà les entrées (Zod), mais ces valeurs finissent
 * interpolées dans des commandes distantes. On revérifie AU POINT D'USAGE : si
 * une valeur non sûre atteignait le moteur par un autre chemin (ancien document,
 * future CLI…), on refuse plutôt que d'exécuter une commande douteuse.
 */
import { DeploymentError } from './errors.js';
import { BACKUP_ROOT } from './config/project.profile.js';

const SAFE_DB = /^[a-zA-Z0-9_-]{1,63}$/;
const SAFE_PATH = /^\/[a-zA-Z0-9_./-]{1,255}$/;
// La racine des sauvegardes vient du profil de projet ; seule la partie
// variable (nom d'archive) est contrainte ici.
const SAFE_ARCHIVE = new RegExp(
  `^${BACKUP_ROOT.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/[A-Za-z0-9_.-]+\\.tar\\.gz$`,
);
// Aucun métacaractère shell autorisé dans un hostname (déjà validé par url.js,
// revérifié ici pour les usages hors parseTargetUrl).
const SAFE_HOST = /^[a-zA-Z0-9_.:-]{1,255}$/;

export function assertSafeDbName(value) {
  if (!value || !SAFE_DB.test(value)) {
    throw new DeploymentError('UNSAFE_INPUT', 'Nom de base de données non sûr.', { details: { field: 'dbName' } });
  }
  return value;
}

export function assertSafePath(value) {
  if (!value || !SAFE_PATH.test(value)) {
    throw new DeploymentError('UNSAFE_INPUT', 'Chemin distant non sûr.', { details: { field: 'path' } });
  }
  return value;
}

export function assertSafeArchive(value) {
  if (!value || !SAFE_ARCHIVE.test(value)) {
    throw new DeploymentError('UNSAFE_INPUT', 'Chemin d’archive non sûr.', { details: { field: 'archive' } });
  }
  return value;
}

export function assertSafeHost(value) {
  if (!value || !SAFE_HOST.test(value)) {
    throw new DeploymentError('UNSAFE_INPUT', 'Adresse serveur non sûre.', { details: { field: 'host' } });
  }
  return value;
}

export default { assertSafeDbName, assertSafePath, assertSafeArchive, assertSafeHost };
