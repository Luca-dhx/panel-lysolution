/**
 * Coffre-fort MÉMOIRE du mot de passe VPS.
 *
 * Règle ABSOLUE du cahier des charges : le mot de passe VPS n'est JAMAIS
 * persisté. Interdit dans : Mongo, .env, fichier, logs, cache, localStorage,
 * sessionStorage. Il n'existe que pendant le déploiement, en mémoire (RAM du
 * process backend), puis est détruit.
 *
 * Exception autorisée : « Conserver le mot de passe jusqu'à la fermeture du
 * Manager ». Dans ce cas UNIQUEMENT, on garde le secret en RAM (jamais sur
 * disque) jusqu'à ce que la session soit explicitement révoquée (déconnexion /
 * fermeture du Manager) ou expire.
 *
 * Implémentation : Map en mémoire, indexée par un identifiant de session opaque.
 * Aucun secret ne quitte ce module ; il n'est lu que par le transport SSH au
 * moment de l'exécution, puis effacé si non conservé.
 */
import crypto from 'node:crypto';

/** Entrées : sessionId -> { password, host, username, keep, expiresAt } */
const store = new Map();

/** Durée de vie maximale d'une session « conservée » (RAM). 8 h par défaut. */
const KEEP_TTL_MS = Number(process.env.DEPLOY_VPS_SESSION_TTL_MS) || 8 * 60 * 60 * 1000;

/** Durée de vie d'une session éphémère (non conservée) : le temps d'un déploiement. */
const EPHEMERAL_TTL_MS = 15 * 60 * 1000;

function now() {
  return Date.now();
}

function purgeExpired() {
  const t = now();
  for (const [id, entry] of store) {
    if (entry.expiresAt <= t) {
      wipe(entry);
      store.delete(id);
    }
  }
}

/** Écrase le secret en mémoire (meilleur effort : coupe la référence). */
function wipe(entry) {
  if (entry && typeof entry.password === 'string') {
    entry.password = null;
  }
}

/**
 * Ouvre une session VPS en mémoire.
 * @param {{host:string, username:string, password:string, keep?:boolean}} creds
 * @returns {{sessionId:string, keep:boolean, expiresAt:number}}
 */
export function openSession({ host, username, password, keep = false }) {
  if (!host || !username || !password) {
    throw new Error('host, username et password sont requis pour ouvrir une session VPS.');
  }
  purgeExpired();
  const sessionId = crypto.randomBytes(18).toString('base64url');
  const ttl = keep ? KEEP_TTL_MS : EPHEMERAL_TTL_MS;
  const expiresAt = now() + ttl;
  store.set(sessionId, { password, host, username, keep: Boolean(keep), expiresAt });
  return { sessionId, keep: Boolean(keep), expiresAt };
}

/**
 * Récupère les identifiants d'une session (usage interne au transport).
 * Rafraîchit l'expiration d'une session éphémère pour couvrir un déploiement long.
 * @returns {{host:string, username:string, password:string, keep:boolean}|null}
 */
export function getSession(sessionId) {
  purgeExpired();
  const entry = store.get(sessionId);
  if (!entry) return null;
  if (!entry.keep) {
    // Session éphémère : on prolonge tant qu'elle est activement utilisée.
    entry.expiresAt = now() + EPHEMERAL_TTL_MS;
  }
  return { host: entry.host, username: entry.username, password: entry.password, keep: entry.keep };
}

/** Existe-t-elle encore ? (sans exposer le secret) */
export function hasSession(sessionId) {
  purgeExpired();
  return store.has(sessionId);
}

/** Métadonnées non sensibles d'une session (pour l'UI). Jamais le mot de passe. */
export function describeSession(sessionId) {
  purgeExpired();
  const entry = store.get(sessionId);
  if (!entry) return null;
  return { host: entry.host, username: entry.username, keep: entry.keep, expiresAt: entry.expiresAt };
}

/**
 * Détruit une session (fin de déploiement non conservé, déconnexion, fermeture
 * du Manager). Idempotent.
 */
export function closeSession(sessionId) {
  const entry = store.get(sessionId);
  if (entry) wipe(entry);
  return store.delete(sessionId);
}

/**
 * Détruit une session éphémère après usage. À appeler par le moteur en fin de
 * déploiement quand `keep` est faux. Ne touche pas aux sessions conservées.
 */
export function closeIfEphemeral(sessionId) {
  const entry = store.get(sessionId);
  if (entry && !entry.keep) {
    wipe(entry);
    store.delete(sessionId);
    return true;
  }
  return false;
}

/** Détruit TOUTES les sessions (fermeture du Manager / arrêt du process). */
export function closeAll() {
  for (const entry of store.values()) wipe(entry);
  store.clear();
}

/** Nombre de sessions actives (diagnostic, jamais de secret). */
export function activeSessionCount() {
  purgeExpired();
  return store.size;
}

export default {
  openSession,
  getSession,
  hasSession,
  describeSession,
  closeSession,
  closeIfEphemeral,
  closeAll,
  activeSessionCount,
};
