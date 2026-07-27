// Seul fichier du backend autorisé à lire process.env.
// Fail-closed : une variable critique absente ou invalide arrête le processus
// avec un message clair — jamais un Panel mal configuré qui tourne quand même.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const backendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
dotenv.config({ path: path.join(backendRoot, '.env') });

function fail(message) {
  console.error(`[env] ${message}`);
  process.exit(1);
}

const env = (process.env.PANEL_ENV ?? '').trim().toUpperCase();
if (env !== 'TEST' && env !== 'PROD') {
  fail('PANEL_ENV doit valoir explicitement TEST ou PROD.');
}

const jwtSecret = (process.env.PANEL_JWT_SECRET ?? '').trim();
if (!jwtSecret) {
  fail('PANEL_JWT_SECRET est requis (signature des JWT des utilisateurs du Panel).');
}

const encryptionKey = (process.env.PANEL_ENCRYPTION_KEY ?? '').trim();
if (!/^[0-9a-fA-F]{64}$/.test(encryptionKey)) {
  fail('PANEL_ENCRYPTION_KEY est requise : 64 caractères hexadécimaux (AES-256-GCM).');
}

function positiveInt(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) fail(`${name} doit être un entier positif.`);
  return value;
}

export const config = {
  env,
  isProd: env === 'PROD',
  port: positiveInt('PANEL_PORT', 4100),
  panelName: (process.env.PANEL_NAME ?? '').trim() || 'Panel L.Y Solution',
  publicUrl: (process.env.PANEL_PUBLIC_URL ?? '').trim() || null,
  jwtSecret,
  encryptionKey,
  seedDevEmail: (process.env.PANEL_SEED_DEV_EMAIL ?? '').trim() || null,
  seedDevPassword: process.env.PANEL_SEED_DEV_PASSWORD || null,
  heartbeatIntervalS: positiveInt('PANEL_HEARTBEAT_INTERVAL_S', 300),
  pairingCodeTtlS: positiveInt('PANEL_PAIRING_CODE_TTL_S', 900),
  debug: process.env.PANEL_DEBUG === '1',
};

export default config;
