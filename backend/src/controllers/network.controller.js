// Configuration réseau du Panel (surface interne /api/system-configuration).
// Lecture : tout utilisateur du Panel. Écriture : comptes DEV.
import { ok } from '../utils/apiResponse.js';
import {
  getSystemConfiguration,
  resolveBackendUrl,
  resolveFrontendUrl,
  updateNetworkConfiguration,
} from '../services/network/networkConfig.service.js';
import { getAllowedOrigins, refreshAllowedOrigins } from '../middlewares/cors.middleware.js';

async function describeNetwork() {
  const [configuration, backend, frontend] = await Promise.all([
    getSystemConfiguration(),
    resolveBackendUrl(),
    resolveFrontendUrl(),
  ]);
  return {
    stored: configuration.network,
    resolved: {
      backendUrl: { url: backend.url, source: backend.source },
      frontendUrl: { url: frontend.url, source: frontend.source },
    },
    corsOrigins: getAllowedOrigins(),
    updatedAt: configuration.updatedAt ?? null,
    updatedBy: configuration.updatedBy ?? null,
  };
}

export async function getNetwork(_req, res) {
  return ok(res, await describeNetwork());
}

export async function putNetwork(req, res) {
  await updateNetworkConfiguration(req.body ?? {}, { updatedBy: req.panelUser?.userId ?? null });
  await refreshAllowedOrigins();
  return ok(res, await describeNetwork());
}
