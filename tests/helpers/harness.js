import fs from 'node:fs';
import path from 'node:path';
// Harnais de test commun — même philosophie que le projet modèle : runners
// node autonomes, compteur pass/fail, aucun framework.
// IMPORTANT : appeler setTestEnv() AVANT tout import dynamique du backend
// (config/env.js est fail-closed).
let pass = 0;
let fail = 0;

export function check(name, cond) {
  if (cond) {
    pass += 1;
    console.log(`  ✓ ${name}`);
  } else {
    fail += 1;
    console.error(`  ✗ ${name}`);
  }
}

export function section(title) {
  console.log(`\n${title}`);
}

export function finish() {
  console.log(`\n${pass} réussis, ${fail} échoués`);
  process.exit(fail === 0 ? 0 : 1);
}

export function setTestEnv() {
  process.env.PANEL_SKIP_DOTENV = '1'; // jamais le .env local dans les tests
  process.env.ENV = 'TEST';
  process.env.MONGODB_URI = process.env.MONGODB_URI ?? 'mongodb://127.0.0.1:27017';
  process.env.DB_TEST = 'panel_test';
  process.env.DB_PROD = 'panel_prod';
  process.env.JWT_SECRET = 'panel-test-jwt-secret-0123456789abcdef0123456789abcdef';
  process.env.JWT_EXPIRES_IN = '12h';
  process.env.BRIDGE_ENCRYPTION_KEY = 'a'.repeat(64);
  process.env.SEED_DEV_EMAIL = 'dev@panel.test';
  process.env.SEED_DEV_PASSWORD = 'motdepasse-test';
  process.env.PANEL_NAME = 'Panel L.Y Solution (test)';
}

// MongoDB éphémère en mémoire — aucun service externe requis pour la suite.
// À appeler APRÈS setTestEnv() et AVANT tout import du backend : l'URI doit
// être en place quand config/env.js est évalué.
let memoryServer = null;

export async function startMemoryMongo() {
  // Les tests vivent hors de backend/ : on résout la dépendance depuis
  // backend/node_modules explicitement.
  const { createRequire } = await import('node:module');
  const { pathToFileURL } = await import('node:url');
  const require = createRequire(new URL('../../backend/package.json', import.meta.url));
  const { MongoMemoryServer } = await import(
    pathToFileURL(require.resolve('mongodb-memory-server')).href
  );
  memoryServer = await MongoMemoryServer.create();
  process.env.MONGODB_URI = memoryServer.getUri();
  return process.env.MONGODB_URI;
}

export async function connectTestDatabase() {
  const { connectDatabase } = await import('../../backend/src/config/db.js');
  await connectDatabase();
}

export async function stopMemoryMongo() {
  const { disconnectDatabase } = await import('../../backend/src/config/db.js');
  await disconnectDatabase();
  if (memoryServer) await memoryServer.stop();
  memoryServer = null;
}

// Redémarrage simulé : on coupe la connexion applicative et on la rétablit
// sur la MÊME base — ce qui survit est ce qui est réellement persisté.
export async function simulateRestart() {
  const { connectDatabase, disconnectDatabase } = await import('../../backend/src/config/db.js');
  await disconnectDatabase();
  await connectDatabase();
}

export async function rejectsWith(fn, code) {
  try {
    await fn();
    return false;
  } catch (err) {
    return err?.code === code || err?.details?.code === code;
  }
}

// Serveur Express éphémère + client fetch minimal.
/**
 * Démarre le serveur du Panel sur un port LIBRE — ou sur un port IMPOSÉ.
 *
 * ── POURQUOI LE PORT IMPOSÉ EXISTE ────────────────────────────────────────
 *
 * Un projet appairé mémorise l'ADRESSE de son Panel. Éprouver « le Panel
 * revient » en le relançant sur un autre port n'éprouverait rien : le projet
 * parlerait à une adresse morte, et l'on prendrait une panne d'appairage pour
 * une panne de convergence. Le retour se fait donc sur LE MÊME port.
 */
export async function startServer(app, { port = 0 } = {}) {
  const server = await new Promise((resolve) => {
    const s = app.listen(port, () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, path, { headers = {}, body } = {}) => {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: body !== undefined ? { 'content-type': 'application/json', ...headers } : headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    let json = null;
    try {
      json = await res.json();
    } catch {
      json = null;
    }
    return { status: res.status, json, headers: res.headers };
  };
  const close = () => new Promise((resolve) => server.close(resolve));
  return { base, call, close };
}

/**
 * LES MÉDIAS ÉCRITS PAR UNE RECETTE NE SURVIVENT PAS À LA RECETTE.
 *
 * ══ CE QUE CE GARDE-FOU FERME ═══════════════════════════════════════════════
 *
 * Les suites qui éprouvent le pipeline d'import écrivent de VRAIS fichiers dans
 * `uploads/` — c'est justement ce qui rend la preuve valable : aucun étage n'est
 * doublé. Mais elles n'en retiraient aucun. Trente-cinq `.webp` s'étaient
 * accumulés dans le dossier que le runtime SERT, laissés par des exécutions
 * successives.
 *
 * Ils n'ont jamais pu être commités (`uploads/` est ignoré depuis le lot B),
 * donc le dépôt n'a rien risqué. Mais un dossier de médias qui grossit à chaque
 * `npm test` finit par ressembler à des données de production, et c'est
 * exactement le genre de résidu qu'on ne distingue plus le jour où il compte.
 *
 * On ne supprime QUE ce que la recette a créé : l'inventaire est pris avant,
 * comparé après. Un fichier antérieur — un vrai média local — n'est jamais
 * touché.
 */
export function guardUploads(dossier = path.resolve(process.cwd(), 'uploads')) {
  const avant = new Set(fs.existsSync(dossier) ? fs.readdirSync(dossier) : []);
  return {
    /** Retire les fichiers apparus depuis l'inventaire. Ne lève jamais. */
    cleanup() {
      if (!fs.existsSync(dossier)) return { removed: 0 };
      let removed = 0;
      for (const nom of fs.readdirSync(dossier)) {
        if (avant.has(nom)) continue;
        try {
          fs.rmSync(path.join(dossier, nom), { force: true });
          removed += 1;
        } catch {
          // Un fichier verrouillé n'est pas une raison de faire échouer une
          // suite verte : le nettoyage est une hygiène, pas une assertion.
        }
      }
      return { removed };
    },
  };
}
