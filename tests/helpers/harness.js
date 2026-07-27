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
  process.env.PANEL_ENV = 'TEST';
  process.env.PANEL_JWT_SECRET = 'panel-test-jwt-secret';
  process.env.PANEL_ENCRYPTION_KEY = 'a'.repeat(64);
  process.env.PANEL_SEED_DEV_EMAIL = 'dev@panel.test';
  process.env.PANEL_SEED_DEV_PASSWORD = 'motdepasse-test';
  process.env.PANEL_NAME = 'Panel L.Y Solution (test)';
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
