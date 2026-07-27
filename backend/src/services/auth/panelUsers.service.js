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
  logger.info('Compte DEV seed créé.');
}

export async function resetUsers() {
  await PanelUser.deleteMany({});
}
