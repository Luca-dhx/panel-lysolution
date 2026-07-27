// Configuration fail-closed — chaque cas démarre un processus Node NEUF qui
// importe config/env.js avec un environnement fabriqué (PANEL_SKIP_DOTENV=1 :
// le .env local ne « répare » jamais un cas de test).
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { check, finish, section } from './helpers/harness.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const envModuleUrl = pathToFileURL(path.join(root, 'backend', 'src', 'config', 'env.js')).href;

const VALID = {
  ENV: 'TEST',
  MONGODB_URI: 'mongodb://127.0.0.1:27017',
  DB_TEST: 'panel_test',
  DB_PROD: 'panel_prod',
  JWT_SECRET: 'panel-test-jwt-secret-0123456789abcdef0123456789abcdef',
  JWT_EXPIRES_IN: '12h',
  BRIDGE_ENCRYPTION_KEY: 'a'.repeat(64),
};

function loadConfig(overrides = {}) {
  const childEnv = { ...process.env, PANEL_SKIP_DOTENV: '1', ...VALID, ...overrides };
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete childEnv[key];
  }
  const script = `import(${JSON.stringify(envModuleUrl)}).then((m) => {
    console.log(JSON.stringify({ env: m.config.env, dbName: m.config.dbName, port: m.config.port }));
  });`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    env: childEnv,
    encoding: 'utf8',
  });
  let parsed = null;
  try {
    parsed = JSON.parse(result.stdout.trim().split('\n').pop());
  } catch {
    parsed = null;
  }
  return { status: result.status, config: parsed, stderr: result.stderr ?? '' };
}

section('ENV sélectionne la base — la règle du projet modèle');
{
  const test = loadConfig({ ENV: 'TEST' });
  check('ENV=TEST → DB_TEST', test.status === 0 && test.config.dbName === 'panel_test');
  const prod = loadConfig({ ENV: 'PROD', SEED_DEV_EMAIL: undefined, SEED_DEV_PASSWORD: undefined });
  check('ENV=PROD → DB_PROD', prod.status === 0 && prod.config.dbName === 'panel_prod');
  check('la casse est normalisée (test → TEST)', loadConfig({ ENV: 'test' }).config?.env === 'TEST');
}

section('ENV : aucune autre valeur silencieusement acceptée');
{
  check('ENV absent refusé', loadConfig({ ENV: undefined }).status === 1);
  check('ENV=STAGING refusé', loadConfig({ ENV: 'STAGING' }).status === 1);
  check('ENV vide refusé', loadConfig({ ENV: '' }).status === 1);
}

section('MongoDB : variables obligatoires');
{
  check('MONGODB_URI absente refusée', loadConfig({ MONGODB_URI: undefined }).status === 1);
  check('DB_TEST absente refusée en TEST', loadConfig({ DB_TEST: undefined }).status === 1);
  check('DB_PROD absente refusée en PROD',
    loadConfig({ ENV: 'PROD', DB_PROD: undefined, SEED_DEV_EMAIL: undefined, SEED_DEV_PASSWORD: undefined }).status === 1);
  check('DB_PROD absente TOLÉRÉE en TEST (base non sélectionnée)',
    loadConfig({ DB_PROD: undefined }).status === 0);
}

section('JWT : robustesse du secret imposée');
{
  check('JWT_SECRET absent refusé', loadConfig({ JWT_SECRET: undefined }).status === 1);
  check('placeholder du .env.example refusé',
    loadConfig({ JWT_SECRET: 'GENERATE_A_SECURE_RANDOM_SECRET' }).status === 1);
  check('placeholder du projet modèle refusé',
    loadConfig({ JWT_SECRET: 'change-me-with-a-long-random-string' }).status === 1);
  check('secret court (< 32) refusé', loadConfig({ JWT_SECRET: 'court' }).status === 1);
  check('JWT_EXPIRES_IN absent refusé', loadConfig({ JWT_EXPIRES_IN: undefined }).status === 1);
  check('JWT_EXPIRES_IN invalide refusé', loadConfig({ JWT_EXPIRES_IN: 'bientot' }).status === 1);
  check('JWT_EXPIRES_IN en secondes accepté', loadConfig({ JWT_EXPIRES_IN: '900' }).status === 0);
}

section('Clé de chiffrement du pont');
{
  check('BRIDGE_ENCRYPTION_KEY absente refusée', loadConfig({ BRIDGE_ENCRYPTION_KEY: undefined }).status === 1);
  check('longueur ≠ 64 hex refusée', loadConfig({ BRIDGE_ENCRYPTION_KEY: 'abcd' }).status === 1);
  check('caractères non hexadécimaux refusés', loadConfig({ BRIDGE_ENCRYPTION_KEY: 'z'.repeat(64) }).status === 1);
  check('clé égale au JWT_SECRET refusée', loadConfig({
    JWT_SECRET: 'f'.repeat(64),
    BRIDGE_ENCRYPTION_KEY: 'f'.repeat(64),
  }).status === 1);
}

section('Seed : verrouillé en PROD');
{
  const prodBase = { ENV: 'PROD' };
  check('seed par défaut (dev@panel.test) refusé en PROD', loadConfig({
    ...prodBase, SEED_DEV_EMAIL: 'dev@panel.test', SEED_DEV_PASSWORD: 'UnVraiMotDePasse!42',
  }).status === 1);
  check('mot de passe seed connu (123dev) refusé en PROD', loadConfig({
    ...prodBase, SEED_DEV_EMAIL: 'ops@ly-solution.com', SEED_DEV_PASSWORD: '123dev',
  }).status === 1);
  check('mot de passe seed < 12 caractères refusé en PROD', loadConfig({
    ...prodBase, SEED_DEV_EMAIL: 'ops@ly-solution.com', SEED_DEV_PASSWORD: 'Court!1',
  }).status === 1);
  check('seed fort accepté en PROD', loadConfig({
    ...prodBase, SEED_DEV_EMAIL: 'ops@ly-solution.com', SEED_DEV_PASSWORD: 'UnVraiMotDePasse!42',
  }).status === 0);
  check('PROD sans seed démarre (connexion impossible, jamais un défaut)', loadConfig({
    ...prodBase, SEED_DEV_EMAIL: undefined, SEED_DEV_PASSWORD: undefined,
  }).status === 0);
  check('seed par défaut TOLÉRÉ en TEST', loadConfig({
    SEED_DEV_EMAIL: 'dev@panel.test', SEED_DEV_PASSWORD: 'motdepasse-test',
  }).status === 0);
}

section('Les secrets ne fuient jamais dans les messages d’erreur');
{
  const leaky = loadConfig({
    MONGODB_URI: 'mongodb://usager:p4ssw0rd-secret@cluster.example.com:27017',
    JWT_SECRET: undefined,
  });
  check('démarrage refusé (JWT manquant)', leaky.status === 1);
  check('l’URI Mongo (credentials) n’apparaît pas sur stderr', !leaky.stderr.includes('p4ssw0rd-secret'));

  const badSecret = loadConfig({ JWT_SECRET: 'zqx-valeur-refusee' });
  check('la valeur du secret refusé n’est pas répétée', !badSecret.stderr.includes('zqx-valeur-refusee'));
}

section('Divers');
{
  check('PORT par défaut 4100', loadConfig({ PORT: undefined }).config?.port === 4100);
  check('PORT invalide refusé', loadConfig({ PORT: 'abc' }).status === 1);
}

finish();
