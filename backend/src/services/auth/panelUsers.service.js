// Utilisateurs du Panel v1 — docs/architecture/04_AUTHENTICATION.md §2.
// Deux rôles (ADMIN, DEV superset), store en mémoire derrière une interface
// stable, mots de passe scrypt (crypto natif). Le RBAC complet attend la
// Phase 4+ et remplacera `role` sans toucher au reste.
import crypto from 'node:crypto';
import config from '../../config/env.js';
import { newBridgeId, nowIso } from '../../bridge/bridgeContract.js';
import logger from '../../utils/logger.js';

export const PANEL_ROLES = Object.freeze({ ADMIN: 'ADMIN', DEV: 'DEV' });

const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1 };

const usersByEmail = new Map();

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

export function createUser({ email, password, displayName, role }) {
  const normalized = String(email).trim().toLowerCase();
  const user = {
    userId: newBridgeId(),
    email: normalized,
    displayName: displayName ?? normalized,
    role,
    passwordHash: hashPassword(password),
    createdAt: nowIso(),
  };
  usersByEmail.set(normalized, user);
  return toPublicUser(user);
}

export function authenticate(email, password) {
  const user = usersByEmail.get(String(email).trim().toLowerCase());
  if (!user) return null;
  if (!verifyPassword(password, user.passwordHash)) return null;
  return toPublicUser(user);
}

export function getUserById(userId) {
  for (const user of usersByEmail.values()) {
    if (user.userId === userId) return toPublicUser(user);
  }
  return null;
}

export function toPublicUser(user) {
  return {
    userId: user.userId,
    email: user.email,
    displayName: user.displayName,
    role: user.role,
  };
}

// Compte DEV seed. Sans variables seed et sans utilisateur existant, le
// serveur démarre quand même — l'API d'auth refusera simplement toute
// connexion (fail-closed côté accès, jamais côté démarrage).
export function seedFromEnv() {
  if (usersByEmail.size > 0) return;
  if (!config.seedDevEmail || !config.seedDevPassword) {
    logger.warn('Aucun compte seed configuré (PANEL_SEED_DEV_EMAIL/PASSWORD) : connexion impossible.');
    return;
  }
  createUser({
    email: config.seedDevEmail,
    password: config.seedDevPassword,
    displayName: 'Développeur',
    role: PANEL_ROLES.DEV,
  });
  logger.info(`Compte DEV seed créé (${config.seedDevEmail}).`);
}

export function resetUsers() {
  usersByEmail.clear();
}
