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
export async function startServer(app) {
  const server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
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
