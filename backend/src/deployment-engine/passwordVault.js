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

/** Entrées : sessionId -> { password, host, username, expiresAt } */
const store = new Map();

/**
 * DUREE DE VIE D'UNE SESSION — une seule, et elle se prolonge a l'usage.
 *
 * Il en existait DEUX, choisies par une case a cocher : 8 h si l'operateur
 * demandait de « garder la session ouverte », 15 min sinon. On lui faisait
 * donc arbitrer la duree de vie d'un secret en RAM — une question a laquelle
 * il n'a aucun moyen de repondre, et dont la mauvaise reponse se payait par
 * une session disparue au milieu d'un retrait.
 *
 * Une seule duree suffit, parce qu'elle est REPOUSSEE a chaque utilisation :
 * une operation active ne peut pas expirer sous les pieds de celui qui la
 * mene, et une session oubliee s'eteint d'elle-meme.
 */
const SESSION_TTL_MS = Number(process.env.DEPLOY_VPS_SESSION_TTL_MS) || 30 * 60 * 1000;

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
 * @param {{host:string, username:string, password:string}} creds
 * @returns {{sessionId:string, expiresAt:number}}
 */
export function openSession({ host, username, password }) {
  if (!host || !username || !password) {
    throw new Error('host, username et password sont requis pour ouvrir une session VPS.');
  }
  purgeExpired();
  const sessionId = crypto.randomBytes(18).toString('base64url');
  const expiresAt = now() + SESSION_TTL_MS;
  store.set(sessionId, { password, host, username, expiresAt });
  return { sessionId, expiresAt };
}

/**
 * Récupère les identifiants d'une session (usage interne au transport).
 * Rafraîchit l'expiration d'une session éphémère pour couvrir un déploiement long.
 * @returns {{host:string, username:string, password:string}|null}
 */
export function getSession(sessionId) {
  purgeExpired();
  const entry = store.get(sessionId);
  if (!entry) return null;
  // TOUTE utilisation repousse l'echeance : une operation en cours ne peut pas
  // expirer entre deux de ses propres appels.
  entry.expiresAt = now() + SESSION_TTL_MS;
  return { host: entry.host, username: entry.username, password: entry.password };
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
  return { host: entry.host, username: entry.username, expiresAt: entry.expiresAt };
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
 * FERME UNE SESSION EN FIN D'OPERATION.
 *
 * Remplace `closeIfEphemeral` : il n'y a plus deux natures de session, donc
 * plus de condition a evaluer. On ferme explicitement, ou l'expiration s'en
 * charge.
 */
export function closeAfterOperation(sessionId) {
  return closeSession(sessionId);
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
  closeAfterOperation,
  closeAll,
  activeSessionCount,
};
