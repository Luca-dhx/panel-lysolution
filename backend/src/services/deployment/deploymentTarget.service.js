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
import {
  DEFAULT_REMOTE_ROOT,
  REQUIRED_REMOTE_ENV,
  serviceName,
} from '../../deployment-engine/config/project.profile.js';
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
    // CE QUE LE BACKEND A DÉDUIT. Affiché en clair : l'opérateur n'a pas à
    // saisir ces valeurs, mais il a le droit de les voir — sans quoi la
    // déduction ressemblerait à de la magie, et le jour où quelque chose
    // cloche il n'aurait aucune prise.
    derived: describeDerivation(target),
  };
}

/** Origine de chaque valeur calculée — pour l'écran « ce qui a été déduit ». */
export function describeDerivation(target) {
  return [
    { label: 'Hôte', value: target.host, from: 'analyse de l’URL par le moteur' },
    {
      label: 'Type d’adresse',
      value: target.type === 'subdomain' ? 'sous-domaine' : 'domaine',
      from: 'analyse de l’URL par le moteur',
    },
    {
      label: 'Certificat TLS',
      value: target.wildcardBase
        ? `wildcard *.${target.wildcardBase} réutilisé`
        : 'certificat dédié émis par Let’s Encrypt',
      from: 'bases wildcard du profil de déploiement',
    },
    {
      label: 'Port local du backend',
      value: String(target.backendPort),
      from: 'attribué automatiquement (plus haut port utilisé + 1)',
    },
    {
      label: 'Service PM2',
      value: serviceName(target.host),
      from: 'convention du profil : <slug>-<hôte>',
    },
    {
      label: 'Chemin sur le serveur',
      value: `${target.remoteRoot}/${target.host}`,
      from: 'racine par défaut du profil',
    },
    {
      label: 'Port SSH',
      value: String(target.sshPort ?? 22),
      from: 'standard',
    },
    {
      label: 'Contact Let’s Encrypt',
      value: target.certbotEmail ?? 'aucun — renseignez les contacts de l’entreprise',
      from: 'contacts de l’entreprise',
    },
    {
      label: 'Base de données',
      value: target.environment === 'PROD' ? 'DB_PROD' : 'DB_TEST',
      from: 'environnement de la destination',
    },
  ];
}

/** Les variables obligatoires, `__DB_FOR_ENV__` résolue pour cet ENV. */
export function requiredEnvFor(environment) {
  return REQUIRED_REMOTE_ENV.map((name) =>
    (name === '__DB_FOR_ENV__' ? (environment === 'PROD' ? 'DB_PROD' : 'DB_TEST') : name));
}

/* -------------------------------------------------------------------------- */
/*  ÉCRITURE                                                                  */
/* -------------------------------------------------------------------------- */

/* -------------------------------------------------------------------------- */
/*  CONVENTIONS — ce que le Panel DÉDUIT au lieu de le demander               */
/* -------------------------------------------------------------------------- */
//
// L'écran décrit une INTENTION : « publier ce Panel, à cette adresse, sur ce
// serveur ». C'est le backend qui construit la configuration réelle, à partir
// du profil de déploiement et des conventions du moteur.
//
// Demander un port PM2 ou une racine de déploiement à l'opérateur, c'est lui
// faire porter une décision qui appartient au moteur — et lui donner
// l'occasion de se tromper sur un détail dont il ne peut pas juger.

/** Port SSH : le standard. Le transport du moteur l'utilise par défaut. */
const SSH_PORT = 22;

/** Utilisateur par défaut. Modifiable, parce que certains hébergeurs diffèrent. */
const DEFAULT_SSH_USER = 'root';

/**
 * Premier port applicatif attribué. Au-dessus des ports réservés, et
 * au-dessus du 4100 utilisé en développement local — pour qu'une destination
 * ne réserve jamais le port du Panel de l'opérateur.
 */
const BASE_BACKEND_PORT = 5100;

/**
 * ALLOCATION DU PORT — même convention que SB Auto 06 : le plus haut déjà
 * attribué, plus un.
 *
 * C'est volontairement simple et monotone : deux destinations n'ont jamais
 * le même port, et un port libéré n'est pas réattribué. Réutiliser un port
 * libéré ferait qu'un ancien service PM2 oublié capterait le trafic d'une
 * nouvelle destination.
 */
async function allocateBackendPort() {
  const highest = await PanelDeploymentTarget.findOne()
    .sort({ backendPort: -1 })
    .select('backendPort')
    .lean();
  return highest ? highest.backendPort + 1 : BASE_BACKEND_PORT;
}

/**
 * Contact Let's Encrypt — pris sur l'ENTREPRISE, jamais demandé.
 *
 * Le Panel sait déjà qui il représente : redemander une adresse de contact
 * pour un certificat serait lui faire ressaisir ce qu'il détient. On préfère
 * le support à l'adresse générale : c'est lui qui doit recevoir une alerte
 * d'expiration.
 */
async function resolveCertbotEmail() {
  try {
    const { getActiveCompany } = await import('../company/company.service.js');
    const company = await getActiveCompany();
    return company?.contacts?.supportEmail ?? company?.contacts?.email ?? null;
  } catch {
    return null;
  }
}

/**
 * Valide l'INTENTION et construit la configuration. Refuse en nommant le
 * champ — même discipline que le reste du Panel depuis la Phase 3B.
 *
 * Les champs acceptés sont volontairement peu nombreux :
 *   name · environment · url · sshHost   (requis)
 *   sshUser · dbName                     (facultatifs, « options avancées »)
 *
 * Tout le reste est DÉDUIT et ne peut pas être envoyé par le frontend.
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

  const sshHost = String(input.sshHost ?? existing?.sshHost ?? '').trim();
  if (!sshHost) errors.push('sshHost : adresse du serveur requise (IP ou nom).');

  if (errors.length > 0) {
    throw ApiError.badRequest('PANEL_TARGET_INVALID',
      `Destination refusée parce que ${errors.length} champ(s) sont invalides : ${errors.join(' ')}`,
      { errors });
  }

  return {
    // ── INTENTION : ce que l'opérateur a exprimé ────────────────────────
    name,
    environment,
    sshHost,
    // Modifiable, mais pré-rempli : certains hébergeurs n'ouvrent pas root.
    sshUser: String(input.sshUser ?? existing?.sshUser ?? DEFAULT_SSH_USER).trim() || DEFAULT_SSH_USER,
    // Modifiable : le Panel ne peut pas deviner un nom de base déjà en place.
    dbName: String(input.dbName ?? existing?.dbName ?? '').trim() || null,

    // ── DÉDUIT de l'URL par le moteur ───────────────────────────────────
    url: parsed.canonicalUrl ?? url,
    host: parsed.host,
    type: parsed.type,
    registrableDomain: parsed.registrableDomain ?? null,
    subdomain: parsed.subdomain ?? null,
    wildcardBase: parsed.wildcardBase ?? null,

    // ── CONVENTIONS ─────────────────────────────────────────────────────
    sshPort: SSH_PORT,
    remoteRoot: existing?.remoteRoot ?? DEFAULT_REMOTE_ROOT,
    // Le port n'est alloué qu'à la création : le modifier casserait le
    // service PM2 et la configuration nginx déjà en place.
    backendPort: existing?.backendPort ?? await allocateBackendPort(),
    certbotEmail: existing?.certbotEmail ?? await resolveCertbotEmail(),
    // Aucune variable technique ne vient du frontend : le profil déclare ce
    // qui est obligatoire, et le moteur construit le .env distant.
    extraEnv: {},

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
  listTargets, getTargetOrThrow, describeTarget, describeDerivation, requiredEnvFor,
  createTarget, updateTarget, deleteTarget,
  markDeploying, recordDeployment, deploymentSummary,
};
