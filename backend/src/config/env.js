// Seul fichier du backend autorisé à lire process.env (verrouillé par
// tests/bridge-conformity.test.js).
// Mêmes conventions que le projet modèle (SB Auto 06 backend/src/config/env.js) :
//  - ENV=TEST|PROD est l'unique interrupteur d'environnement (jamais NODE_ENV) ;
//  - une seule MONGODB_URI, seul le NOM de base change (DB_TEST / DB_PROD) ;
//  - fail-closed : une variable critique absente ou invalide arrête le
//    processus avec un message clair — jamais un Panel mal configuré qui
//    tourne quand même.
// Durcissements propres au Panel (documentés dans 24_ENVIRONMENT_AND_DOMAINS) :
//  - JWT_SECRET : placeholder connu ou secret < 32 caractères REFUSÉS (le
//    projet modèle se contente d'un avertissement) ;
//  - JWT_EXPIRES_IN : obligatoire et validé ;
//  - en PROD, des identifiants seed par défaut ou faibles refusent le
//    démarrage.
// La valeur d'un secret n'apparaît JAMAIS dans un message d'erreur ou un log.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const backendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
// PANEL_SKIP_DOTENV=1 : réservé aux tests de configuration, qui doivent
// pouvoir simuler une variable ABSENTE sans être « réparés » par le .env local.
if (process.env.PANEL_SKIP_DOTENV !== '1') {
  dotenv.config({ path: path.join(backendRoot, '.env') });
}

function fail(message) {
  console.error(`[config] ${message}`);
  process.exit(1);
}

// ----------------------------------------------------------------- ENV ------
const RAW_ENV = (process.env.ENV ?? '').trim().toUpperCase();
if (RAW_ENV !== 'TEST' && RAW_ENV !== 'PROD') {
  fail(`ENV doit valoir explicitement "TEST" ou "PROD" (reçu : ${RAW_ENV || 'undefined'}).`);
}
const env = RAW_ENV;
const isProd = env === 'PROD';
const isTest = env === 'TEST';

// ----------------------------------------------------------------- Mongo ----
const mongoUri = (process.env.MONGODB_URI ?? '').trim();
if (!mongoUri) {
  fail('MONGODB_URI est requise (URI commune, le nom de base varie par ENV).');
}
const dbName = (isProd ? process.env.DB_PROD : process.env.DB_TEST)?.trim() ?? '';
if (!dbName) {
  fail(`Nom de base manquant pour ENV=${env} : renseigner ${isProd ? 'DB_PROD' : 'DB_TEST'}.`);
}

// ------------------------------------------------------------------- JWT ----
// Placeholders et valeurs d'exemple connus — refusés en toute circonstance.
const KNOWN_BAD_SECRETS = new Set([
  'change-me-with-a-long-random-string',
  'generate_a_secure_random_secret',
  'change-me',
  'changeme',
  'secret',
  'password',
]);
const jwtSecret = (process.env.JWT_SECRET ?? '').trim();
if (!jwtSecret) {
  fail('JWT_SECRET est requis (signature des JWT des utilisateurs du Panel).');
}
if (KNOWN_BAD_SECRETS.has(jwtSecret.toLowerCase())) {
  fail('JWT_SECRET est un placeholder connu : générer un vrai secret aléatoire (voir .env.example).');
}
if (jwtSecret.length < 32) {
  fail('JWT_SECRET trop court (< 32 caractères) : générer 64 octets aléatoires (voir .env.example).');
}

const jwtExpiresIn = (process.env.JWT_EXPIRES_IN ?? '').trim();
if (!/^\d+\s*(ms|s|m|h|d)?$/i.test(jwtExpiresIn)) {
  fail('JWT_EXPIRES_IN est requis et doit être une durée valide (ex. « 12h », « 7d », « 900 » secondes).');
}

// ---------------------------------------------------- chiffrement du pont ---
// Clé maître AES-256-GCM du chiffrement au repos des bridgeTokens. Clé
// DISTINCTE de l'INTEGRATED_API_ENCRYPTION_KEY des projets vitrines : le
// Panel n'a pas d'IntegratedAPI, et un secret ne se réutilise jamais entre
// deux déploiements.
const bridgeEncryptionKey = (process.env.BRIDGE_ENCRYPTION_KEY ?? '').trim();
if (!/^[0-9a-fA-F]{64}$/.test(bridgeEncryptionKey)) {
  fail('BRIDGE_ENCRYPTION_KEY est requise : 64 caractères hexadécimaux (AES-256-GCM).');
}
if (bridgeEncryptionKey === jwtSecret) {
  fail('BRIDGE_ENCRYPTION_KEY ne doit jamais être égale à JWT_SECRET (une clé par usage).');
}

// ------------------------------------------------------------------ seed ----
// TEST : compte DEV seed libre (confort de développement).
// PROD : identifiants par défaut ou faibles REFUSÉS au démarrage.
const KNOWN_SEED_EMAILS = new Set(['dev@mail.com', 'admin@mail.com', 'dev@panel.test']);
const KNOWN_SEED_PASSWORDS = new Set(['123dev', '123admin', 'motdepasse-test', 'password', 'changeme']);

/**
 * IDENTIFIANTS DE DÉVELOPPEMENT PAR DÉFAUT — TEST uniquement.
 *
 * Sans eux, un clone neuf démarrait, avertissait dans les journaux, et
 * n'offrait AUCUN moyen de se connecter : il fallait lire le code pour
 * comprendre qu'il manquait deux variables. Un outil d'administration qu'on
 * ne peut pas ouvrir n'est pas utilisable.
 *
 * Ces valeurs ne peuvent PAS fuir en production : elles ne sont appliquées
 * qu'en `ENV=TEST`, et la liste des identifiants refusés en PROD les
 * contient explicitement — un déploiement qui les recopierait serait arrêté
 * au démarrage.
 */
const DEV_FALLBACK_EMAIL = 'dev@panel.local';
const DEV_FALLBACK_PASSWORD = 'panel-dev-local';

const seedDevEmail = (process.env.SEED_DEV_EMAIL ?? '').trim()
  || (isProd ? null : DEV_FALLBACK_EMAIL);
const seedDevPassword = process.env.SEED_DEV_PASSWORD
  || (isProd ? null : DEV_FALLBACK_PASSWORD);
// Le repli de développement est lui-même interdit en PROD : la garde
// ci-dessous s'applique aussi à lui si quelqu'un le recopiait dans un .env.
KNOWN_SEED_EMAILS.add(DEV_FALLBACK_EMAIL);
KNOWN_SEED_PASSWORDS.add(DEV_FALLBACK_PASSWORD);
if (isProd && (seedDevEmail || seedDevPassword)) {
  if (!seedDevEmail || KNOWN_SEED_EMAILS.has(seedDevEmail.toLowerCase())) {
    fail('SEED_DEV_EMAIL en PROD : adresse réelle requise (les adresses seed de développement sont refusées).');
  }
  if (!seedDevPassword || KNOWN_SEED_PASSWORDS.has(seedDevPassword.toLowerCase())) {
    fail('SEED_DEV_PASSWORD en PROD : les mots de passe seed par défaut sont refusés.');
  }
  if (seedDevPassword.length < 12) {
    fail('SEED_DEV_PASSWORD en PROD : 12 caractères minimum.');
  }
}

// ------------------------------------------------------------- divers -------
function positiveInt(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) fail(`${name} doit être un entier positif.`);
  return value;
}

const corsOrigins = (process.env.CORS_ORIGINS ?? '')
  .split(',')
  .map((origin) => origin.trim())
  .filter((origin) => origin.length > 0);

export const config = {
  env,
  isProd,
  isTest,
  port: positiveInt('PORT', 4100),
  mongoUri,
  dbName,
  jwt: { secret: jwtSecret, expiresIn: jwtExpiresIn },
  bridgeEncryptionKey,
  panelName: (process.env.PANEL_NAME ?? '').trim() || 'Panel L.Y Solution',
  publicUrl: (process.env.PUBLIC_URL ?? '').trim() || null,
  corsOrigins,
  seedDevEmail,
  seedDevPassword,
  // Vrai quand le compte de développement vient du repli et non du .env.
  // Le serveur l'annonce au démarrage : un opérateur doit savoir qu'il se
  // connecte avec des identifiants publics, pas avec les siens.
  seedDevIsDefault: !isProd && !process.env.SEED_DEV_PASSWORD,
  heartbeatIntervalS: positiveInt('HEARTBEAT_INTERVAL_S', 300),
  pairingCodeTtlS: positiveInt('PAIRING_CODE_TTL_S', 900),
  // Supervision (Phase 3A) — seuils de vivacité, exprimés en MULTIPLES de
  // l intervalle de heartbeat attendu. Configurables : un parc de projets
  // lents ou distants n a pas les memes tolerances qu un parc local.
  livenessStaleFactor: positiveInt('LIVENESS_STALE_FACTOR', 2),
  livenessOfflineFactor: positiveInt('LIVENESS_OFFLINE_FACTOR', 6),
  // Retention de l historique de heartbeats, par projet.
  heartbeatHistorySize: positiveInt('HEARTBEAT_HISTORY_SIZE', 200),
  // Retention de la chronologie, par projet.
  timelineHistorySize: positiveInt('TIMELINE_HISTORY_SIZE', 300),
  // Certificat : seuil d alerte avant expiration, en jours.
  certificateWarningDays: positiveInt('CERTIFICATE_WARNING_DAYS', 21),
  debug: process.env.PANEL_DEBUG === '1',
};

export default config;
