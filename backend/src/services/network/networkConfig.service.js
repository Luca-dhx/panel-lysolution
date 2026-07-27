// Résolveur CANONIQUE des URLs du Panel — la seule source de vérité.
// Aucun domaine n'est codé en dur ailleurs dans le code.
//
// Règle de priorité (docs/architecture/24_ENVIRONMENT_AND_DOMAINS.md §3) :
//   1. configuration système persistée en base (posée par le déploiement,
//      modifiable ensuite sans redéployer) ;
//   2. variable d'environnement PUBLIC_URL (repli d'amorçage) ;
//   3. valeur locale de développement (NETWORK_DEFAULTS).
// Une seule information, une seule règle — jamais deux sources
// contradictoires pour une même URL.
//
// En PROD, une URL non publiquement joignable (http, localhost) est refusée :
// le Panel préfère annoncer « URL indisponible » plutôt que diffuser une
// adresse locale à un projet distant.
import config from '../../config/env.js';
import SystemConfiguration from '../../models/SystemConfiguration.model.js';
import {
  isPubliclyReachableUrl,
  normalizeAppUrl,
  safeNormalizeAppUrl,
} from '../../utils/normalizeAppUrl.js';
import ApiError from '../../utils/ApiError.js';

// Repli de DÉVELOPPEMENT uniquement : ces adresses ne sont jamais retenues
// en PROD (elles échouent au test de joignabilité publique). Elles évitent
// d'avoir à configurer quoi que ce soit pour un `npm run dev`.
const LOCAL_DEFAULTS = Object.freeze({
  backendUrl: `http://localhost:${config.port}`,
  frontendUrl: 'http://localhost:5273',
});

export const URL_SOURCE = Object.freeze({
  SYSTEM_CONFIGURATION: 'SYSTEM_CONFIGURATION',
  ENVIRONMENT: 'ENVIRONMENT',
  LOCAL_DEFAULT: 'LOCAL_DEFAULT',
  NONE: 'NONE',
});

// Upsert ATOMIQUE : deux lectures concurrentes (le /api/version résout
// backend et frontend en parallèle) ne doivent pas tenter deux insertions
// du même singleton.
export async function getSystemConfiguration() {
  return SystemConfiguration.findOneAndUpdate(
    { key: 'SINGLETON' },
    { $setOnInsert: { key: 'SINGLETON' } },
    { new: true, upsert: true },
  ).lean();
}

// Résout une URL selon la règle de priorité. Retourne toujours
// { url, source } — `url` peut être null en PROD si rien de public n'est
// configuré (jamais une adresse locale annoncée comme publique).
export async function resolveUrl(field) {
  const configuration = await getSystemConfiguration();
  const stored = safeNormalizeAppUrl(configuration.network?.[field]);
  const fromEnv = field === 'backendUrl' ? safeNormalizeAppUrl(config.publicUrl) : null;
  const local = LOCAL_DEFAULTS[field];

  const candidates = [
    { url: stored, source: URL_SOURCE.SYSTEM_CONFIGURATION },
    { url: fromEnv, source: URL_SOURCE.ENVIRONMENT },
    { url: local, source: URL_SOURCE.LOCAL_DEFAULT },
  ];

  for (const candidate of candidates) {
    if (!candidate.url) continue;
    if (config.isProd && !isPubliclyReachableUrl(candidate.url)) continue;
    return candidate;
  }
  return { url: null, source: URL_SOURCE.NONE };
}

export async function resolveBackendUrl() {
  return resolveUrl('backendUrl');
}

export async function resolveFrontendUrl() {
  return resolveUrl('frontendUrl');
}

// Origines CORS autorisées = origines dérivées des URLs configurées
// + origines statiques du .env (CORS_ORIGINS). Dédupliquées.
export async function resolveAllowedOrigins() {
  const [backend, frontend] = await Promise.all([resolveBackendUrl(), resolveFrontendUrl()]);
  const derived = [frontend.url, backend.url].filter(Boolean);
  const staticOrigins = config.corsOrigins.map(safeNormalizeAppUrl).filter(Boolean);
  return [...new Set([...derived, ...staticOrigins])];
}

// Écriture de la configuration système — utilisée par l'API DEV et par le
// déploiement (scripts/set-network-configuration.mjs). Valide et normalise
// avant d'écrire ; en PROD, refuse une URL non publiquement joignable.
export async function updateNetworkConfiguration(input, { updatedBy = null, requirePublic = config.isProd } = {}) {
  const network = {};
  for (const field of ['backendUrl', 'frontendUrl']) {
    if (input?.[field] === undefined) continue;
    let normalized;
    try {
      normalized = normalizeAppUrl(input[field]);
    } catch (err) {
      throw ApiError.badRequest('PANEL_NETWORK_URL_INVALID', `${field} : ${err.message}`);
    }
    if (requirePublic && !isPubliclyReachableUrl(normalized)) {
      throw ApiError.badRequest(
        'PANEL_NETWORK_URL_NOT_PUBLIC',
        `${field} doit être une URL HTTPS publique en PROD (reçu une adresse locale ou non chiffrée).`,
      );
    }
    network[field] = normalized;
  }
  if (Object.keys(network).length === 0) {
    throw ApiError.badRequest('PANEL_NETWORK_URL_REQUIRED', 'Aucune URL fournie.');
  }

  const update = Object.fromEntries(
    Object.entries(network).map(([field, value]) => [`network.${field}`, value]),
  );
  await SystemConfiguration.updateOne(
    { key: 'SINGLETON' },
    { $set: { ...update, updatedBy } },
    { upsert: true },
  );
  return getSystemConfiguration();
}
