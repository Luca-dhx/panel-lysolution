// Santé et version du Panel lui-même — le Panel est un projet standard et
// expose les mêmes points que les projets (/health, /api/version).
import { createRequire } from 'node:module';
import mongoose from 'mongoose';
import config from '../../config/env.js';
import { CONTRACT_VERSION, nowIso } from '../../bridge/bridgeContract.js';
import { resolveBackendUrl, resolveFrontendUrl } from '../network/networkConfig.service.js';

const require = createRequire(import.meta.url);
const pkg = require('../../../package.json');

// /health reste TRIVIAL et sans dépendance lente : c'est la sonde du
// déploiement et de Nginx. L'état Mongo est lu sur la connexion en cours,
// jamais par une requête réseau.
export function buildHealth() {
  const dbReady = mongoose.connection.readyState === 1;
  return {
    status: dbReady ? 'ok' : 'degraded',
    service: 'panel-backend',
    env: config.env,
    database: dbReady ? 'connected' : 'disconnected',
    time: nowIso(),
  };
}

// /api/version expose aussi les URLs résolues : c'est la page qui permet de
// vérifier, après un déploiement, que le domaine a bien été propagé.
export async function buildVersion() {
  const [backend, frontend] = await Promise.all([resolveBackendUrl(), resolveFrontendUrl()]);
  return {
    name: config.panelName,
    softwareVersion: pkg.version,
    contractVersion: CONTRACT_VERSION,
    environment: config.env,
    urls: {
      backendUrl: backend.url,
      backendUrlSource: backend.source,
      frontendUrl: frontend.url,
      frontendUrlSource: frontend.source,
    },
  };
}
