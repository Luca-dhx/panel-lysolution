// Utilisateurs du Panel v1 — docs/architecture/04_AUTHENTICATION.md §2.
// Deux rôles (ADMIN, DEV superset), persistance MongoDB, mots de passe
// scrypt (crypto natif). Le RBAC complet attend la Phase 4+ et remplacera
// `role` sans toucher au reste.
import crypto from 'node:crypto';
import config from '../../config/env.js';
import { newBridgeId, nowIso } from '../../bridge/bridgeContract.js';
import PanelUser from '../../models/PanelUser.model.js';
import logger from '../../utils/logger.js';

export const PANEL_ROLES = Object.freeze({ ADMIN: 'ADMIN', DEV: 'DEV' });

const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1 };

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const derived = crypto.scryptSync(String(password), salt, 32, SCRYPT_PARAMS);
  return `${salt.toString('hex')}.${derived.toString('hex')}`;
}

function verifyPassword(password, stored) {
  const [saltHex, derivedHex] = String(stored).split('.');
  const derived = crypto.scryptSync(String(password), Buffer.from(saltHex, 'hex'), 32, SCRYPT_PARAMS);
  return crypto.timingSafeEqual(derived, Buffer.from(derivedHex, 'hex'));
}

export async function createUser({ email, password, displayName, role }) {
  const normalized = String(email).trim().toLowerCase();
  const user = {
    userId: newBridgeId(),
    email: normalized,
    displayName: displayName ?? normalized,
    role,
    passwordHash: hashPassword(password),
    createdAt: nowIso(),
  };
  await PanelUser.create(user);
  return toPublicUser(user);
}

export async function authenticate(email, password) {
  const user = await PanelUser.findOne({ email: String(email).trim().toLowerCase() }).lean();
  if (!user) return null;
  if (!verifyPassword(password, user.passwordHash)) return null;
  return toPublicUser(user);
}

export async function getUserById(userId) {
  const user = await PanelUser.findOne({ userId }).lean();
  return user ? toPublicUser(user) : null;
}

export function toPublicUser(user) {
  return {
    userId: user.userId,
    email: user.email,
    displayName: user.displayName,
    role: user.role,
  };
}

// Compte DEV seed — créé uniquement si AUCUN utilisateur n'existe (jamais
// d'écrasement d'un compte réel). Les règles de robustesse PROD sont
// appliquées en amont par config/env.js (fail-closed au démarrage).
export async function seedFromEnv() {
  if (await PanelUser.exists({})) return;
  if (!config.seedDevEmail || !config.seedDevPassword) {
    logger.warn('Aucun compte seed configuré (SEED_DEV_EMAIL/PASSWORD) : connexion impossible.');
    return;
  }
  await createUser({
    email: config.seedDevEmail,
    password: config.seedDevPassword,
    displayName: 'Développeur',
    role: PANEL_ROLES.DEV,
  });

  // Le journal doit permettre de se connecter sans lire le code. En TEST
  // avec le repli, on affiche l'adresse ET le mot de passe : il est public,
  // il figure dans ce dépôt, le masquer n'aurait aucune valeur de sécurité
  // et coûterait l'usage. Avec un mot de passe fourni, on ne l'affiche pas.
  if (config.seedDevIsDefault) {
    logger.warn(
      `Compte DEV de développement créé — ${config.seedDevEmail} / ${config.seedDevPassword}. `
      + 'Identifiants PUBLICS, valables en ENV=TEST uniquement. '
      + 'Définissez SEED_DEV_EMAIL et SEED_DEV_PASSWORD pour les vôtres.',
    );
  } else {
    logger.info(`Compte DEV créé : ${config.seedDevEmail} (mot de passe : SEED_DEV_PASSWORD).`);
  }
}

/**
 * CRÉE OU RÉINITIALISE le compte de développement — TEST uniquement.
 *
 * `seedFromEnv()` ne s'exécute que sur une base VIERGE : c'est ce qui
 * garantit qu'il n'écrase jamais un compte réel. La contrepartie est qu'un
 * développeur ayant oublié son mot de passe se retrouve enfermé dehors,
 * avec pour seule issue de vider la collection à la main.
 *
 * Cette fonction est cette issue, rendue explicite et bornée : elle refuse
 * de s'exécuter en PROD, où réinitialiser un mot de passe par une commande
 * locale serait une porte dérobée.
 */
export async function ensureDevAccount({ email, password } = {}) {
  if (config.isProd) {
    throw new Error(
      'Réinitialisation refusée parce que ENV=PROD : cette commande est réservée au développement.',
    );
  }
  const targetEmail = String(email ?? config.seedDevEmail ?? '').trim().toLowerCase();
  const targetPassword = password ?? config.seedDevPassword;
  if (!targetEmail || !targetPassword) {
    throw new Error(
      'Réinitialisation impossible parce qu’aucun identifiant n’est disponible : '
      + 'renseignez SEED_DEV_EMAIL et SEED_DEV_PASSWORD, ou passez-les en arguments.',
    );
  }

  const existing = await PanelUser.findOne({ email: targetEmail }).lean();
  if (existing) {
    await PanelUser.updateOne(
      { email: targetEmail },
      { $set: { passwordHash: hashPassword(targetPassword), role: PANEL_ROLES.DEV } },
    );
    return { email: targetEmail, created: false, reset: true };
  }
  await createUser({
    email: targetEmail,
    password: targetPassword,
    displayName: 'Développeur',
    role: PANEL_ROLES.DEV,
  });
  return { email: targetEmail, created: true, reset: false };
}

export async function resetUsers() {
  await PanelUser.deleteMany({});
}
