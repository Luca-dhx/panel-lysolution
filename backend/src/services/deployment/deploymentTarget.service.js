// DESTINATIONS DE DÉPLOIEMENT — Phase 4.
//
// Une destination est décrite par son URL ; tout le reste (hôte, type,
// domaine enregistrable, base wildcard) est DÉDUIT par le moteur. On ne
// stocke ces déductions que pour pouvoir les afficher et filtrer sans
// relancer une analyse — jamais pour les saisir séparément, ce qui
// permettrait à deux champs de se contredire.
import { randomUUID } from 'node:crypto';

import PanelDeploymentTarget from '../../models/PanelDeploymentTarget.model.js';
import ApiError from '../../utils/ApiError.js';
import config from '../../config/env.js';
import { nowIso } from '../../bridge/bridgeContract.js';
import { parseTargetUrl, wildcardBasesFromEnv } from '../../deployment-engine/url.js';
import { REQUIRED_REMOTE_ENV, DEFAULT_REMOTE_ROOT } from '../../deployment-engine/config/project.profile.js';
import { resolveBackendUrl } from '../network/networkConfig.service.js';

/* -------------------------------------------------------------------------- */
/*  LECTURE                                                                   */
/* -------------------------------------------------------------------------- */

export async function listTargets() {
  const docs = await PanelDeploymentTarget.find().sort({ createdAt: 1 }).lean();
  return docs.map(describeTarget);
}

export async function getTargetOrThrow(targetId) {
  const doc = await PanelDeploymentTarget.findOne({ targetId }).lean();
  if (!doc) throw ApiError.notFound('PANEL_TARGET_NOT_FOUND', 'Destination de déploiement inconnue.');
  return doc;
}

/**
 * Vue d'une destination. Il n'y a rien à masquer : aucun secret n'est stocké.
 * On ajoute en revanche ce que l'opérateur doit savoir AVANT de déployer —
 * les variables que le serveur exigera.
 */
export function describeTarget(target) {
  return {
    targetId: target.targetId,
    name: target.name,
    url: target.url,
    host: target.host,
    type: target.type,
    registrableDomain: target.registrableDomain,
    subdomain: target.subdomain,
    wildcardBase: target.wildcardBase,
    environment: target.environment,
    sshHost: target.sshHost,
    sshUser: target.sshUser,
    sshPort: target.sshPort,
    backendPort: target.backendPort,
    remoteRoot: target.remoteRoot,
    dbName: target.dbName,
    certbotEmail: target.certbotEmail,
    extraEnv: target.extraEnv ?? {},
    selfHosted: target.selfHosted === true,
    state: target.state,
    currentVersion: target.currentVersion,
    currentReleaseId: target.currentReleaseId,
    lastDeployedAt: target.lastDeployedAt,
    lastRunId: target.lastRunId,
    history: (target.history ?? []).slice(0, 10),
    createdAt: target.createdAt,
    updatedAt: target.updatedAt,
    // Ce que le serveur exigera dans son .env — affiché pour que l'opérateur
    // les prépare, pas pour qu'il les saisisse ici.
    requiredRemoteEnv: requiredEnvFor(target.environment),
  };
}

/** Les variables obligatoires, `__DB_FOR_ENV__` résolue pour cet ENV. */
export function requiredEnvFor(environment) {
  return REQUIRED_REMOTE_ENV.map((name) =>
    (name === '__DB_FOR_ENV__' ? (environment === 'PROD' ? 'DB_PROD' : 'DB_TEST') : name));
}

/* -------------------------------------------------------------------------- */
/*  ÉCRITURE                                                                  */
/* -------------------------------------------------------------------------- */

const PORT_MIN = 1024;
const PORT_MAX = 65535;

/**
 * Valide et normalise une saisie. Refuse en NOMMANT le champ — même
 * discipline que le reste du Panel depuis la Phase 3B.
 */
async function normalize(input, { existing = null } = {}) {
  const errors = [];
  const url = String(input.url ?? existing?.url ?? '').trim();
  const name = String(input.name ?? existing?.name ?? '').trim();
  const environment = String(input.environment ?? existing?.environment ?? '').trim().toUpperCase();

  if (name.length < 2) errors.push('name : au moins 2 caractères.');
  if (environment !== 'TEST' && environment !== 'PROD') {
    errors.push(`environment : TEST ou PROD attendu (reçu « ${environment || 'vide'} »).`);
  }

  // L'URL est analysée par le MOTEUR : c'est lui qui fait autorité sur ce
  // qu'est un hôte valide, pas une expression régulière locale.
  let parsed;
  try {
    parsed = parseTargetUrl(url, { wildcardBases: wildcardBasesFromEnv() });
  } catch (err) {
    errors.push(`url : ${err.message}`);
  }

  const backendPort = Number(input.backendPort ?? existing?.backendPort);
  if (!Number.isInteger(backendPort) || backendPort < PORT_MIN || backendPort > PORT_MAX) {
    errors.push(`backendPort : entier entre ${PORT_MIN} et ${PORT_MAX} attendu.`);
  }
  const sshPort = Number(input.sshPort ?? existing?.sshPort ?? 22);
  if (!Number.isInteger(sshPort) || sshPort < 1 || sshPort > PORT_MAX) {
    errors.push('sshPort : entier entre 1 et 65535 attendu.');
  }

  const sshHost = String(input.sshHost ?? existing?.sshHost ?? '').trim();
  if (!sshHost) errors.push('sshHost : adresse du serveur requise (IP ou nom).');

  const remoteRoot = String(input.remoteRoot ?? existing?.remoteRoot ?? DEFAULT_REMOTE_ROOT).trim();
  if (!remoteRoot.startsWith('/')) errors.push('remoteRoot : chemin absolu attendu.');

  const certbotEmail = (input.certbotEmail ?? existing?.certbotEmail ?? '').trim() || null;
  if (certbotEmail && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(certbotEmail)) {
    errors.push('certbotEmail : adresse e-mail attendue.');
  }

  if (errors.length > 0) {
    throw ApiError.badRequest('PANEL_TARGET_INVALID',
      `Destination refusée parce que ${errors.length} champ(s) sont invalides : ${errors.join(' ')}`,
      { errors });
  }

  return {
    name,
    url: parsed.canonicalUrl ?? url,
    host: parsed.host,
    type: parsed.type,
    registrableDomain: parsed.registrableDomain ?? null,
    subdomain: parsed.subdomain ?? null,
    wildcardBase: parsed.wildcardBase ?? null,
    environment,
    sshHost,
    sshUser: String(input.sshUser ?? existing?.sshUser ?? 'root').trim() || 'root',
    sshPort,
    backendPort,
    remoteRoot,
    dbName: (input.dbName ?? existing?.dbName ?? '').trim() || null,
    certbotEmail,
    extraEnv: input.extraEnv ?? existing?.extraEnv ?? {},
    selfHosted: await detectSelfHosted(parsed.host),
  };
}

/**
 * Cette destination héberge-t-elle le Panel qui pilote ?
 *
 * On compare à l'URL publique RÉSOLUE (configuration en base, puis `.env`) :
 * c'est la seule adresse dont le Panel soit sûr. Un opérateur ne devrait pas
 * avoir à cocher une case pour cela — se tromper aurait pour conséquence un
 * déploiement tué en plein vol.
 */
async function detectSelfHosted(host) {
  try {
    const backend = await resolveBackendUrl();
    if (!backend?.url) return false;
    const own = new URL(backend.url).hostname.toLowerCase();
    return own === String(host).toLowerCase();
  } catch {
    return false;
  }
}

export async function createTarget(input, actor = {}) {
  const value = await normalize(input);
  if (await PanelDeploymentTarget.exists({ host: value.host })) {
    throw ApiError.conflict('PANEL_TARGET_HOST_TAKEN',
      `Destination refusée parce que l’hôte « ${value.host} » est déjà déclaré.`);
  }
  const at = nowIso();
  const doc = await PanelDeploymentTarget.create({
    ...value,
    targetId: randomUUID(),
    state: 'NEW',
    createdAt: at,
    updatedAt: at,
    createdBy: actor.userId ?? null,
  });
  return describeTarget(doc.toObject());
}

export async function updateTarget(targetId, input, actor = {}) {
  const existing = await getTargetOrThrow(targetId);
  const value = await normalize(input, { existing });

  if (value.host !== existing.host
    && await PanelDeploymentTarget.exists({ host: value.host, targetId: { $ne: targetId } })) {
    throw ApiError.conflict('PANEL_TARGET_HOST_TAKEN',
      `Modification refusée parce que l’hôte « ${value.host} » est déjà déclaré.`);
  }

  await PanelDeploymentTarget.updateOne(
    { targetId },
    { $set: { ...value, updatedAt: nowIso(), createdBy: existing.createdBy ?? actor.userId ?? null } },
  );
  return describeTarget(await getTargetOrThrow(targetId));
}

/**
 * Supprime une destination.
 *
 * Refusé pendant un déploiement : l'historique et le run en cours seraient
 * orphelins, et le processus détaché continuerait d'écrire dans le vide.
 */
export async function deleteTarget(targetId) {
  const target = await getTargetOrThrow(targetId);
  if (target.state === 'DEPLOYING') {
    throw ApiError.conflict('PANEL_TARGET_DEPLOYING',
      'Suppression refusée parce qu’un déploiement est en cours sur cette destination.');
  }
  await PanelDeploymentTarget.deleteOne({ targetId });
  return { deleted: true };
}

/* -------------------------------------------------------------------------- */
/*  ÉTAT                                                                      */
/* -------------------------------------------------------------------------- */

export async function markDeploying(targetId, runId) {
  await PanelDeploymentTarget.updateOne(
    { targetId },
    { $set: { state: 'DEPLOYING', lastRunId: runId, updatedAt: nowIso() } },
  );
}

/** Enregistre le dénouement d'un déploiement dans l'historique. */
export async function recordDeployment(targetId, {
  operationType, ok, version, releaseId, user, durationMs, error, steps = [],
}) {
  const doc = await PanelDeploymentTarget.findOne({ targetId });
  if (!doc) return null;
  const at = nowIso();

  doc.pushHistory({
    at,
    operationType,
    version: ok ? version : null,
    user,
    durationMs,
    success: ok === true,
    failedStep: error?.step ?? null,
    error: error?.message ?? null,
    steps,
  });

  // Un préflight ou une simulation ne changent PAS l'état déployé : ils
  // n'ont rien mis en ligne. Seul un déploiement réel le fait.
  if (operationType === 'DEPLOYMENT') {
    doc.state = ok ? 'DEPLOYED' : 'FAILED';
    if (ok) {
      doc.currentVersion = version ?? doc.currentVersion;
      doc.currentReleaseId = releaseId ?? doc.currentReleaseId;
      doc.lastDeployedAt = at;
    }
  } else if (doc.state === 'DEPLOYING') {
    // On restaure l'état d'avant l'opération plutôt que d'inventer.
    doc.state = doc.lastDeployedAt ? 'DEPLOYED' : 'NEW';
  }

  doc.updatedAt = at;
  await doc.save();
  return doc.toObject();
}

/** Le Panel se connaît-il une destination ? Utilisé par l'écran d'accueil. */
export async function deploymentSummary() {
  const targets = await PanelDeploymentTarget.find().lean();
  return {
    total: targets.length,
    deployed: targets.filter((t) => t.state === 'DEPLOYED').length,
    failed: targets.filter((t) => t.state === 'FAILED').length,
    deploying: targets.filter((t) => t.state === 'DEPLOYING').length,
    environments: {
      TEST: targets.filter((t) => t.environment === 'TEST').length,
      PROD: targets.filter((t) => t.environment === 'PROD').length,
    },
    panelEnvironment: config.env,
  };
}

export default {
  listTargets, getTargetOrThrow, describeTarget, requiredEnvFor,
  createTarget, updateTarget, deleteTarget,
  markDeploying, recordDeployment, deploymentSummary,
};
