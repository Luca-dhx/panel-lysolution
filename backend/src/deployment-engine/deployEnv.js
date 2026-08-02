/**
 * Résolution du `.env` DISTANT d'une cible de déploiement.
 *
 * RÈGLE (déploiement ≠ duplication) : DÉPLOYER, c'est embarquer le `.env` du
 * projet TEL QUEL. Le fichier `.env` du backend porte déjà les URI et NOMS de
 * base pour chaque environnement (MONGODB_URI, DB_TEST, DB_PROD) ainsi que les
 * secrets (JWT_SECRET, INTEGRATED_API_ENCRYPTION_KEY). Ces données DOIVENT
 * figurer telles quelles dans le `.env` déployé. On n'INVENTE ni base ni secret :
 * le renommage de base n'a lieu QUE lors d'une DUPLICATION (voir
 * duplication.rewriteEnv), jamais lors d'un déploiement.
 *
 * On n'écrase que ce qui est SPÉCIFIQUE À L'HÔTE cible :
 *   - ENV          : environnement visé par ce déploiement (défaut PROD) ;
 *   - PORT         : port du backend sur le VPS (target.backendPort) ;
 *   - CORS_ORIGINS : chaque hôte servi du profil, en https ;
 *   - PUBLIC_URL   : URL publique de l'hôte principal.
 * Tout le reste (MONGODB_URI, DB_TEST, DB_PROD, JWT_SECRET, JWT_EXPIRES_IN,
 * INTEGRATED_API_ENCRYPTION_KEY, et toute clé additionnelle) est repris VERBATIM.
 *
 * Aucun secret ne transite par le navigateur : la config est lue CÔTÉ SERVEUR
 * depuis le `.env` du backend de contrôle. Le contenu n'est jamais journalisé
 * (le transport n'enregistre que le CHEMIN écrit) ; seul `describeRemoteEnv`
 * (non sensible) est destiné aux logs/rapport.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DeploymentError } from './errors.js';
import { REQUIRED_REMOTE_ENV } from './config/project.profile.js';
import { planTopology } from './topology.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
/** `.env` du backend de contrôle (même emplacement que celui lu par config/env.js). */
export const DEFAULT_SOURCE_ENV = path.resolve(__dirname, '../../.env');

/** Variables du plan de contrôle / scripts : jamais embarquées sur le VPS. */
const CONTROL_ONLY_KEYS = new Set(['DEPLOY_VPS_SESSION_TTL_MS', 'CONFIRM_PROD_PROMOTION']);

/** Parse un contenu façon dotenv en objet { CLE: valeur }. */
export function parseEnv(text) {
  const out = {};
  for (const line of String(text || '').split(/\r?\n/)) {
    if (/^\s*#/.test(line) || !line.trim()) continue;
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (!m) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[m[1]] = v;
  }
  return out;
}

/** Sérialise un objet en contenu dotenv déterministe (ordre d'insertion). */
export function serializeEnv(obj) {
  return Object.entries(obj)
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');
}

/**
 * Construit le `.env` distant d'une cible à partir du `.env` source (verbatim),
 * en n'écrasant que les variables spécifiques à l'hôte.
 *
 * @param {object} target  DeploymentTarget (host, backendPort).
 * @param {object} [opts]
 * @param {string} [opts.env]           Environnement visé (défaut PROD).
 * @param {string} [opts.sourceEnvPath] Chemin du `.env` source.
 * @param {object} [opts.source]        Objet source déjà parsé (prioritaire, pour tests).
 * @param {object} [opts.fsMod]         fs (injectable pour tests).
 * @returns {{remoteEnv:object, dbName:string, env:string, sourcePath:string}}
 */
export function buildRemoteEnv(target, { env = 'PROD', sourceEnvPath = DEFAULT_SOURCE_ENV, source, fsMod = fs, profile } = {}) {
  if (!target?.host) throw new DeploymentError('DEPLOY_ENV_INVALID', 'Cible sans hôte : impossible de construire la configuration distante.', { step: 'build' });
  const host = target.host;
  const targetEnv = String(env || 'PROD').toUpperCase();
  // ORIGINES CORS : tous les hôtes RÉELLEMENT servis par le profil. Un projet à
  // front unique n'autorise que le sien ; un projet à cinq applications les
  // autorise toutes — sans qu'aucun sous-domaine ne soit supposé.
  const topo = planTopology({ host, profile });
  const corsHosts = [...new Set(topo.publishable.map((a) => a.host))];

  // Source = le `.env` du projet (verbatim). On peut l'injecter parsé (tests).
  let src = source;
  if (!src) {
    let text;
    try {
      text = fsMod.readFileSync(sourceEnvPath, 'utf8');
    } catch {
      throw new DeploymentError('DEPLOY_ENV_INCOMPLETE', `Fichier de configuration introuvable : ${sourceEnvPath}. Le déploiement embarque le .env du projet.`, {
        step: 'build',
        details: { sourcePath: sourceEnvPath },
      });
    }
    src = parseEnv(text);
  }

  // La base utilisée dépend de l'ENV visé : PROD -> DB_PROD, TEST -> DB_TEST.
  const dbKey = targetEnv === 'PROD' ? 'DB_PROD' : 'DB_TEST';

  // ── LA LISTE VIENT DU PROFIL, PAS D'UNE CONSTANTE ─────────────────────
  // Cette vérification codait en dur les secrets d'un projet VITRINE
  // (INTEGRATED_API_ENCRYPTION_KEY). Le Panel, qui n'a pas d'IntegratedAPI
  // mais exige BRIDGE_ENCRYPTION_KEY, échouait donc systématiquement à
  // l'étape de build — le moteur lui réclamait une variable qui n'a aucun
  // sens pour lui, et ignorait celle qui compte.
  //
  // Le profil de chaque projet déclare déjà `REQUIRED_REMOTE_ENV` : c'est
  // la source de vérité. Le cœur reste ainsi identique partout, et la
  // divergence passe par `config/` — la règle d'or des moteurs (2E).
  //
  // `__DB_FOR_ENV__` est le marqueur du profil pour « la base de cet ENV ».
  const missing = [];
  for (const name of REQUIRED_REMOTE_ENV) {
    const key = name === '__DB_FOR_ENV__' ? dbKey : name;
    // PORT et ENV sont posés par le moteur lui-même plus bas : les exiger
    // du .env source serait faux.
    if (key === 'PORT' || key === 'ENV') continue;
    if (!src[key]) missing.push(key);
  }
  if (missing.length) {
    throw new DeploymentError(
      'DEPLOY_ENV_INCOMPLETE',
      `Configuration incomplète pour ${host} (ENV=${targetEnv}) : ${missing.join(', ')} absent(s) du .env du projet.`,
      { step: 'build', details: { missing, sourcePath: sourceEnvPath } }
    );
  }

  // Verbatim, MOINS les clés strictement plan-de-contrôle.
  const remoteEnv = {};
  for (const [k, v] of Object.entries(src)) {
    if (!CONTROL_ONLY_KEYS.has(k)) remoteEnv[k] = v;
  }

  // Overrides SPÉCIFIQUES À L'HÔTE — rien d'autre n'est modifié.
  remoteEnv.ENV = targetEnv;
  remoteEnv.PORT = String(target.backendPort ?? src.PORT ?? '');
  remoteEnv.CORS_ORIGINS = corsHosts.map((h) => `https://${h}`).join(',');
  remoteEnv.PUBLIC_URL = `https://${host}`;

  return { remoteEnv, dbName: remoteEnv[dbKey], env: targetEnv, sourcePath: sourceEnvPath };
}

/** Résumé NON SENSIBLE (pour logs/rapport) : aucune valeur secrète. */
export function describeRemoteEnv({ remoteEnv, dbName, env }) {
  return {
    keys: Object.keys(remoteEnv),
    env,
    dbName,
    mongo: /^mongodb\+srv:/.test(remoteEnv.MONGODB_URI || '') ? 'atlas (mongodb+srv)' : 'mongodb',
    corsOrigins: remoteEnv.CORS_ORIGINS,
    publicUrl: remoteEnv.PUBLIC_URL,
  };
}

export default { buildRemoteEnv, describeRemoteEnv, parseEnv, serializeEnv, DEFAULT_SOURCE_ENV };
