// Construction du .env DISTANT — même philosophie que deployEnv.js du
// projet modèle : les secrets sont repris VERBATIM du .env local (ils ne
// transitent jamais par le dépôt), et seules les valeurs dépendantes de
// l'hôte sont réécrites par le déploiement.
import { LOCAL_ONLY_ENV_KEYS, REQUIRED_REMOTE_ENV } from './config.mjs';

export function parseEnvFile(content) {
  const env = {};
  for (const line of String(content).split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const index = trimmed.indexOf('=');
    if (index === -1) continue;
    env[trimmed.slice(0, index).trim()] = trimmed.slice(index + 1).trim();
  }
  return env;
}

export function serializeEnv(env) {
  return `${Object.entries(env)
    .map(([key, value]) => `${key}=${value}`)
    .join('\n')}\n`;
}

// Les valeurs pilotées par le déploiement écrasent celles du .env local :
// c'est le domaine choisi qui fait autorité, pas la configuration du poste.
export function buildRemoteEnv(localEnv, deployConfig) {
  const remote = { ...localEnv };
  for (const key of LOCAL_ONLY_ENV_KEYS) delete remote[key];

  remote.ENV = deployConfig.environment;
  remote.PORT = String(deployConfig.backendPort);
  remote.PUBLIC_URL = deployConfig.urls.backendUrl;
  remote.CORS_ORIGINS = [...new Set([
    deployConfig.urls.frontendUrl,
    deployConfig.urls.backendUrl,
  ])].join(',');

  return remote;
}

// Contrôle appliqué APRÈS écriture puis relecture du fichier distant : une
// variable obligatoire absente ou vide arrête le déploiement avant le
// démarrage du service.
export function validateRemoteEnv(env) {
  const missing = REQUIRED_REMOTE_ENV.filter((key) => !env[key] || env[key].trim() === '');
  const dbKey = env.ENV === 'PROD' ? 'DB_PROD' : 'DB_TEST';
  if (!env[dbKey] || env[dbKey].trim() === '') missing.push(dbKey);
  return { valid: missing.length === 0, missing };
}
