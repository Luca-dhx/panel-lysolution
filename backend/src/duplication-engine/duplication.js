/**
 * MOTEUR DE DUPLICATION (cahier des charges §1).
 *
 * Duplique LE PROJET ACTUEL (il n'existe pas de projet maître) :
 *   1. teste la connexion Mongo ;
 *   2. crée DB TEST si absente ;
 *   3. crée DB PROD si absente ;
 *   4. valide les connexions ;
 *   5. duplique physiquement le dossier courant (copie complète) ;
 *   6. réécrit .env (nom projet, DB TEST, DB PROD) ;
 *   7. lance les seeds (compte DEV + données minimales) ;
 *   8. retourne { projet, chemin, état, temps }.
 *
 * Les transformations pures (validation, réécriture .env, nom de dossier) sont
 * exportées et testées unitairement. La copie physique, Mongo et les seeds sont
 * réels mais isolés derrière des fonctions injectables pour rester testables.
 */
import crypto from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs/promises';
import { MongoClient } from 'mongodb';
import mongoose from 'mongoose';
import { ValidationError } from '../deployment-engine/errors.js';
import { PROJECT_ROOT, localExec } from '../deployment-engine/build.js';
import { normalizeGithubRepositoryUrl } from '../utils/githubRepositoryUrl.js';
import { NETWORK_DEFAULTS } from '../utils/constants.js';
import { ENV_KEYS, SECRETS_TO_GENERATE } from './config/duplication.profile.js';

/** Dossiers/fichiers jamais copiés (régénérés) : lourds ou spécifiques à l'instance. */
export const COPY_DENYLIST = new Set([
  'node_modules',
  '.git',
  'dist',
  'coverage',
  '.turbo',
  '.next',
  'migration-reports',
]);

const DB_NAME_RE = /^[a-zA-Z0-9_-]{1,63}$/;
const PROJECT_NAME_RE = /^[\w .()-]{1,80}$/u;

/** Nettoie un nom en nom de dossier sûr (sans casser l'unicité voulue). */
export function sanitizeFolderName(name) {
  return String(name)
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 100);
}

/**
 * Valide les entrées de l'assistant de duplication.
 * @param {object} input { projectName, folderName, dbTest, dbProd, devEmail, devPassword }
 * @returns {object} input normalisé (folderName nettoyé)
 */
export function validateDuplicationInput(input) {
  const { projectName, folderName, dbTest, dbProd, devEmail, devPassword, githubRepositoryUrl } = input || {};
  if (!projectName || !PROJECT_NAME_RE.test(projectName)) {
    throw new ValidationError('Nom de projet invalide.');
  }
  const folder = sanitizeFolderName(folderName || projectName);
  if (!folder) throw new ValidationError('Nom de dossier invalide.');
  if (!dbTest || !DB_NAME_RE.test(dbTest)) throw new ValidationError('Nom de base TEST invalide.');
  if (!dbProd || !DB_NAME_RE.test(dbProd)) throw new ValidationError('Nom de base PROD invalide.');
  if (dbTest === dbProd) throw new ValidationError('DB TEST et DB PROD doivent être différentes.');
  if (!devEmail || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(devEmail)) {
    throw new ValidationError('Email du compte DEV invalide.');
  }
  if (!devPassword || String(devPassword).length < 6) {
    throw new ValidationError('Mot de passe DEV trop court (min. 6 caractères).');
  }
  // URL du dépôt GitHub de la COPIE (jamais celle du projet source) —
  // obligatoire pour toute nouvelle duplication, normalisée vers la forme
  // canonique `https://github.com/<owner>/<repo>.git`.
  let repoUrl;
  try {
    repoUrl = normalizeGithubRepositoryUrl(githubRepositoryUrl);
  } catch (err) {
    throw new ValidationError(`URL du dépôt GitHub cible : ${err.message}`);
  }
  return { projectName, folderName: folder, dbTest, dbProd, devEmail, devPassword, githubRepositoryUrl: repoUrl };
}

/**
 * Met en forme une valeur de .env : brute si elle est sans ambiguïté pour
 * dotenv, sinon entre guillemets doubles (backslash et guillemets échappés).
 * Un mot de passe contenant espace ou `#` ne doit JAMAIS être tronqué.
 */
export function quoteEnvValue(value) {
  const v = String(value ?? '');
  if (/^[A-Za-z0-9@._/:+-]*$/.test(v)) return v;
  return `"${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/**
 * Réécrit le contenu d'un .env pour le projet dupliqué (fonction PURE).
 * Remplace/insère DB_TEST, DB_PROD ; conserve toutes les autres lignes.
 * @param {string} envContent Contenu du .env source.
 * @param {object} values { dbTest, dbProd, projectName, seedDevEmail, seedDevPassword }
 * @returns {string} nouveau contenu
 */
export function rewriteEnv(envContent, {
  dbTest, dbProd, projectName, githubRepositoryUrl, seedDevEmail, seedDevPassword,
  secrets = generateProjectSecrets(),
}) {
  const lines = String(envContent || '').split(/\r?\n/);
  const setKeys = { [ENV_KEYS.dbTest]: dbTest, [ENV_KEYS.dbProd]: dbProd };
  // SÉCURITÉ : chaque copie reçoit des secrets NEUFS. Sans cela, un projet
  // dupliqué hériterait du JWT_SECRET et des clés de chiffrement de sa
  // source — la compromission de l'un compromettrait tous les autres.
  for (const [key, value] of Object.entries(secrets ?? {})) setKeys[key] = value;
  if (projectName) setKeys[ENV_KEYS.projectName] = projectName;
  // URL du dépôt de la COPIE : remplace toute valeur héritée du template
  // source — le moteur ne recopie JAMAIS l'URL du dépôt source.
  if (githubRepositoryUrl) setKeys[ENV_KEYS.githubRepositoryUrl] = githubRepositoryUrl;
  // Identifiants du PREMIER compte DEV de la copie (assistant de duplication) :
  // consommés par le seed (`bootstrap.js`) au premier lancement. Remplacent
  // toute valeur héritée du projet source — jamais recopiés tels quels.
  if (seedDevEmail) setKeys[ENV_KEYS.seedDevEmail] = seedDevEmail;
  if (seedDevPassword) setKeys[ENV_KEYS.seedDevPassword] = quoteEnvValue(seedDevPassword);
  const seen = new Set();

  const out = lines.map((line) => {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=/);
    if (m && Object.prototype.hasOwnProperty.call(setKeys, m[1])) {
      seen.add(m[1]);
      return `${m[1]}=${setKeys[m[1]]}`;
    }
    return line;
  });

  // Ajoute les clés manquantes à la fin.
  for (const [key, val] of Object.entries(setKeys)) {
    if (!seen.has(key)) out.push(`${key}=${val}`);
  }
  return out.join('\n');
}

/**
 * Génère un jeu de secrets NEUFS pour une copie, d'après le profil de
 * duplication. Source cryptographique sûre ; les valeurs ne sont jamais
 * journalisées ni retournées par une API — elles ne servent qu'à écrire le
 * `.env` de la copie.
 * @returns {Record<string,string>} { NOM_VARIABLE: valeur }
 */
export function generateProjectSecrets(specs = SECRETS_TO_GENERATE) {
  const secrets = {};
  for (const spec of specs) {
    secrets[spec.key] = crypto.randomBytes(spec.bytes).toString(spec.encoding);
  }
  return secrets;
}

/** Teste la connexion Mongo et retourne la liste des bases existantes. */
export async function testMongoConnection(mongoUri) {
  const client = new MongoClient(mongoUri, { serverSelectionTimeoutMS: 8000 });
  await client.connect();
  try {
    const admin = client.db().admin();
    const { databases } = await admin.listDatabases();
    return { ok: true, databases: databases.map((d) => d.name) };
  } finally {
    await client.close();
  }
}

/** Masque les credentials d'une URI Mongo — JAMAIS d'URI complète en clair. */
export function maskMongoUri(uri) {
  return String(uri || '').replace(/\/\/([^@/]+)@/, '//***@');
}

/** Erreur structurée d'initialisation de base (codes stables, message sûr). */
export class DatabaseInitializationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'DatabaseInitializationError';
    this.code = code;
  }
}

function isAuthMongoError(err) {
  return err?.code === 18 || err?.codeName === 'AuthenticationFailed' || /auth/i.test(String(err?.message || ''));
}

/**
 * INITIALISATION CANONIQUE d'une base logique — idempotente.
 *
 * Doctrine : dans un cluster existant, l'URI + les droits d'écriture du
 * database user SUFFISENT — une base logique se matérialise à la première
 * écriture réelle. AUCUNE Atlas Administration API n'est nécessaire pour cela.
 *
 * La matérialisation utilise les mécanismes DÉJÀ canoniques de l'application,
 * jamais un document factice :
 *  1. création des INDEX Mongoose de tous les modèles connus (crée les
 *     collections réelles avec leurs index — exactement ce que ferait l'app) ;
 *  2. insertion `$setOnInsert` du singleton SystemConfiguration (vrai document
 *     de configuration attendu par le bootstrap, valeurs par défaut) ;
 *  3. suppression du marqueur artificiel historique `_deployment_marker` ;
 *  4. vérification RÉELLE de la présence de la base après coup.
 *
 * @param {string} mongoUri
 * @param {string} dbName
 * @param {{models?:object}} [opts]  Registre de modèles (déf. mongoose.models).
 * @returns {Promise<{name:string, created:boolean, collectionsInitialized:number, indexesEnsured:number}>}
 */
export async function initializeDatabase(mongoUri, dbName, { models } = {}) {
  if (!dbName || !DB_NAME_RE.test(dbName)) {
    throw new DatabaseInitializationError('MONGO_DATABASE_NAME_INVALID', `Nom de base invalide : ${dbName}`);
  }
  let client;
  try {
    client = new MongoClient(mongoUri, { serverSelectionTimeoutMS: 8000 });
    await client.connect();
  } catch (err) {
    const code = isAuthMongoError(err) ? 'MONGO_AUTHENTICATION_FAILED' : 'MONGO_CONNECTION_FAILED';
    throw new DatabaseInitializationError(code, `Connexion Mongo impossible (${maskMongoUri(mongoUri)}).`);
  }
  try {
    const admin = client.db().admin();
    let databases;
    try {
      ({ databases } = await admin.listDatabases());
    } catch (err) {
      const code = isAuthMongoError(err) ? 'MONGO_AUTHENTICATION_FAILED' : 'MONGO_CONNECTION_FAILED';
      throw new DatabaseInitializationError(code, `Lecture des bases impossible (${maskMongoUri(mongoUri)}).`);
    }
    const existed = databases.some((d) => d.name === dbName);
    const db = client.db(dbName);

    // 1. Index Mongoose de tous les modèles du registre.
    const registry = models || mongoose.models;
    let collectionsInitialized = 0;
    let indexesEnsured = 0;
    try {
      for (const model of Object.values(registry)) {
        const collName = model?.collection?.collectionName;
        const specs = typeof model?.schema?.indexes === 'function' ? model.schema.indexes() : [];
        if (!collName || !specs.length) continue;
        for (const [fields, options] of specs) {
          await db.collection(collName).createIndex(fields, options || {});
          indexesEnsured += 1;
        }
        collectionsInitialized += 1;
      }
    } catch (err) {
      throw new DatabaseInitializationError(
        'MONGO_INDEX_INITIALIZATION_FAILED',
        `Création des index échouée sur ${dbName} : ${err?.message || 'erreur inconnue'}`
      );
    }

    // 2. Document canonique : le singleton SystemConfiguration (jamais un faux
    //    document métier). Idempotent par $setOnInsert.
    try {
      await db.collection('systemconfigurations').updateOne(
        {},
        { $setOnInsert: { network: { ...NETWORK_DEFAULTS }, updatedBy: null } },
        { upsert: true }
      );
      // 3. Le marqueur artificiel historique n'a plus de raison d'être.
      await db.collection('_deployment_marker').drop().catch(() => {});
    } catch (err) {
      throw new DatabaseInitializationError(
        'MONGO_DATABASE_INITIALIZATION_FAILED',
        `Initialisation de ${dbName} échouée : ${err?.message || 'erreur inconnue'}`
      );
    }

    // 4. Vérification réelle.
    const after = await admin.listDatabases();
    if (!after.databases.some((d) => d.name === dbName)) {
      throw new DatabaseInitializationError('MONGO_DATABASE_INITIALIZATION_FAILED', `La base ${dbName} n'existe pas après initialisation.`);
    }
    return { name: dbName, created: !existed, collectionsInitialized, indexesEnsured };
  } finally {
    await client.close().catch(() => {});
  }
}

/**
 * Initialise les DEUX bases d'un projet dupliqué (contrat du LOT MongoDB).
 * @returns {Promise<{test:object, prod:object}>}
 */
export async function initializeDuplicatedProjectDatabases({ mongoUri, testDatabaseName, productionDatabaseName, models } = {}) {
  if (!mongoUri) throw new DatabaseInitializationError('MONGO_CONNECTION_FAILED', 'MONGODB_URI requis.');
  const test = await initializeDatabase(mongoUri, testDatabaseName, { models });
  const prod = await initializeDatabase(mongoUri, productionDatabaseName, { models });
  return { test, prod };
}

/**
 * Compat historique : crée/initialise une base si absente. Délègue désormais à
 * l'initialisation CANONIQUE (index + singleton), plus de marqueur artificiel.
 * @returns {Promise<{created:boolean}>}
 */
export async function ensureDatabase(mongoUri, dbName, _stamp = 'init') {
  const r = await initializeDatabase(mongoUri, dbName);
  return { created: r.created, collectionsInitialized: r.collectionsInitialized, indexesEnsured: r.indexesEnsured };
}

/**
 * Copie récursivement un dossier en excluant la denylist.
 * @returns {Promise<{files:number, dirs:number}>}
 */
export async function copyProject(srcRoot, destRoot, { onLog = () => {} } = {}) {
  let files = 0;
  let dirs = 0;
  const walk = async (src, dest) => {
    await fs.mkdir(dest, { recursive: true });
    dirs += 1;
    const entries = await fs.readdir(src, { withFileTypes: true });
    for (const entry of entries) {
      if (COPY_DENYLIST.has(entry.name)) continue;
      const s = path.join(src, entry.name);
      const d = path.join(dest, entry.name);
      if (entry.isDirectory()) {
        await walk(s, d);
      } else if (entry.isFile()) {
        await fs.copyFile(s, d);
        files += 1;
      }
    }
  };
  onLog(`[duplicate] copie ${srcRoot} -> ${destRoot}`);
  await walk(srcRoot, destRoot);
  return { files, dirs };
}

/**
 * Orchestration complète de la duplication.
 * @param {object} input Entrées validées ou brutes (validées ici).
 * @param {object} [ctx]
 * @param {string} [ctx.sourceRoot]  Racine du projet source (déf. projet courant).
 * @param {string} [ctx.destParent]  Dossier parent où créer le projet (déf. parent du source).
 * @param {string} ctx.mongoUri      URI Mongo (obligatoire).
 * @param {string} ctx.stamp         Horodatage (fourni, pas de Date.now interne).
 * @param {(msg:string)=>void} [ctx.onLog]
 * @param {boolean} [ctx.runSeed]    Lancer `npm run seed` (déf. true).
 * @returns {Promise<{project:string, path:string, state:string, dbTest:object, dbProd:object, mongo:object, copy:object}>}
 */
export async function duplicateProject(input, ctx = {}) {
  const {
    sourceRoot = PROJECT_ROOT,
    mongoUri,
    stamp = 'init',
    onLog = () => {},
    onPhase = () => {},
    runSeed = true,
  } = ctx;
  const clean = validateDuplicationInput(input);
  if (!mongoUri) throw new ValidationError('MONGODB_URI requis pour la duplication.');

  const destParent = ctx.destParent || path.dirname(sourceRoot);
  const destRoot = path.join(destParent, clean.folderName);

  // Refus si la cible existe déjà (jamais d'écrasement silencieux).
  try {
    await fs.access(destRoot);
    throw new ValidationError(`Le dossier cible existe déjà : ${destRoot}`);
  } catch (err) {
    if (err instanceof ValidationError) throw err;
    /* n'existe pas : OK */
  }

  // 1. Connexion Mongo.
  onPhase({ phase: 'mongo', status: 'running' });
  onLog('[duplicate] test connexion Mongo…');
  const mongo = await testMongoConnection(mongoUri);
  onPhase({ phase: 'mongo', status: 'ok' });

  // 2 & 3. Création DB TEST / PROD si absentes.
  onPhase({ phase: 'databases', status: 'running' });
  const dbTest = await ensureDatabase(mongoUri, clean.dbTest, stamp);
  const dbProd = await ensureDatabase(mongoUri, clean.dbProd, stamp);

  // 4. Validation connexions (re-liste : les bases doivent désormais exister).
  const after = await testMongoConnection(mongoUri);
  const testOk = after.databases.includes(clean.dbTest);
  const prodOk = after.databases.includes(clean.dbProd);
  if (!testOk || !prodOk) {
    throw new ValidationError('Validation des bases échouée après création.');
  }
  onPhase({ phase: 'databases', status: 'ok' });

  // 5. Copie physique du dossier.
  onPhase({ phase: 'copy', status: 'running' });
  const copy = await copyProject(sourceRoot, destRoot, { onLog });
  onPhase({ phase: 'copy', status: 'ok' });

  // 6. Réécriture du .env (à partir du .env.example si pas de .env source).
  const srcEnvPath = path.join(sourceRoot, 'backend', '.env');
  const exampleEnvPath = path.join(sourceRoot, 'backend', '.env.example');
  let baseEnv = '';
  try {
    baseEnv = await fs.readFile(srcEnvPath, 'utf8');
  } catch {
    baseEnv = await fs.readFile(exampleEnvPath, 'utf8').catch(() => '');
  }
  onPhase({ phase: 'config', status: 'running' });
  const newEnv = rewriteEnv(baseEnv, {
    dbTest: clean.dbTest,
    dbProd: clean.dbProd,
    projectName: clean.projectName,
    githubRepositoryUrl: clean.githubRepositoryUrl,
    seedDevEmail: clean.devEmail,
    seedDevPassword: clean.devPassword,
  });
  // Écriture ATOMIQUE : fichier temporaire puis rename — jamais un .env tronqué.
  const envPath = path.join(destRoot, 'backend', '.env');
  const tmpPath = `${envPath}.tmp`;
  await fs.writeFile(tmpPath, `${newEnv}\n`, 'utf8');
  await fs.rename(tmpPath, envPath);

  // Vérification POST-ÉCRITURE : la clé est présente EXACTEMENT une fois, avec
  // la valeur normalisée saisie — sinon échec explicite, jamais silencieux.
  const written = await fs.readFile(envPath, 'utf8');
  const occurrences = written.split(/\r?\n/).filter((l) => /^PROJECT_GITHUB_REPOSITORY_URL=/.test(l));
  if (occurrences.length !== 1 || occurrences[0] !== `PROJECT_GITHUB_REPOSITORY_URL=${clean.githubRepositoryUrl}`) {
    throw new ValidationError('Vérification du .env dupliqué échouée : PROJECT_GITHUB_REPOSITORY_URL absente, dupliquée ou altérée.');
  }
  // Le compte DEV saisi dans l'assistant DOIT être consommable par le seed :
  // email présent exactement une fois, mot de passe présent exactement une fois.
  const writtenLines = written.split(/\r?\n/);
  const emailLines = writtenLines.filter((l) => /^SEED_DEV_EMAIL=/.test(l));
  const passwordLines = writtenLines.filter((l) => /^SEED_DEV_PASSWORD=/.test(l));
  if (emailLines.length !== 1 || emailLines[0] !== `SEED_DEV_EMAIL=${clean.devEmail}`) {
    throw new ValidationError('Vérification du .env dupliqué échouée : SEED_DEV_EMAIL absente, dupliquée ou altérée.');
  }
  if (passwordLines.length !== 1 || passwordLines[0] !== `SEED_DEV_PASSWORD=${quoteEnvValue(clean.devPassword)}`) {
    throw new ValidationError('Vérification du .env dupliqué échouée : SEED_DEV_PASSWORD absente, dupliquée ou altérée.');
  }
  onPhase({ phase: 'config', status: 'ok' });

  // 7. Seeds (compte DEV + données minimales). Best-effort documenté.
  onPhase({ phase: 'seed', status: 'running' });
  let seed = { ran: false };
  if (runSeed) {
    onLog('[duplicate] installation backend + seed…');
    const backendDir = path.join(destRoot, 'backend');
    const install = await localExec('npm', ['ci'], { cwd: backendDir, timeoutMs: 600_000 }).catch((e) => ({
      code: 1,
      stderr: e.message,
    }));
    if (install.code === 0) {
      const seedRes = await localExec('npm', ['run', 'seed'], {
        cwd: backendDir,
        timeoutMs: 120_000,
      }).catch((e) => ({ code: 1, stderr: e.message }));
      seed = { ran: seedRes.code === 0, code: seedRes.code };
    } else {
      seed = { ran: false, code: install.code, note: 'npm ci a échoué' };
    }
  }
  onPhase({ phase: 'seed', status: 'ok' });
  onPhase({ phase: 'done', status: 'ok' });

  // 8. Retour.
  return {
    project: clean.projectName,
    path: destRoot,
    state: 'created',
    mongo,
    dbTest: { name: clean.dbTest, ...dbTest },
    dbProd: { name: clean.dbProd, ...dbProd },
    copy,
    seed,
    githubRepositoryUrl: clean.githubRepositoryUrl,
    // JAMAIS le mot de passe dans le rapport — seulement l'email du compte.
    devAccount: { email: clean.devEmail },
    envCheck: {
      githubRepositoryUrl: 'present-unique-normalized',
      seedDevAccount: 'present-unique',
    },
  };
}

export default {
  duplicateProject,
  validateDuplicationInput,
  rewriteEnv,
  quoteEnvValue,
  sanitizeFolderName,
  testMongoConnection,
  ensureDatabase,
  initializeDatabase,
  initializeDuplicatedProjectDatabases,
  maskMongoUri,
  copyProject,
  COPY_DENYLIST,
};
