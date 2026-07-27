// CORS du Panel — les origines autorisées sont DÉRIVÉES des URLs
// configurées (configuration système + CORS_ORIGINS), jamais codées en dur.
// Un cache mémoire évite un aller-retour Mongo par requête ; il est
// rafraîchi au démarrage et après chaque écriture de la configuration
// réseau (même principe que corsOrigins.js du projet modèle).
import { resolveAllowedOrigins } from '../services/network/networkConfig.service.js';
import logger from '../utils/logger.js';

let allowedOrigins = [];

export async function refreshAllowedOrigins() {
  allowedOrigins = await resolveAllowedOrigins();
  logger.debug(`Origines CORS autorisées : ${allowedOrigins.join(', ') || '(aucune)'}`);
  return allowedOrigins;
}

export function getAllowedOrigins() {
  return [...allowedOrigins];
}

export function isOriginAllowed(origin) {
  return allowedOrigins.includes(origin);
}

// Requête sans Origin (serveur à serveur : c'est le cas des projets sur
// /bridge/v1) : rien à autoriser, on laisse passer sans en-tête CORS.
export function corsMiddleware(req, res, next) {
  const origin = req.get('origin');
  if (origin && isOriginAllowed(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Allow-Headers', 'authorization, content-type, x-bridge-contract-version');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  }
  if (req.method === 'OPTIONS') {
    return res.sendStatus(204);
  }
  return next();
}

export default corsMiddleware;
