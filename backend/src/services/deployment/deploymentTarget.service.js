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
import {
  LIFECYCLE, assertDeletable, lifecycleLabel, softDelete, statusOf,
} from './destinationLifecycle.service.js';
import {
  moveReservationToServer, reservePort, rollbackReservation,
} from './portRegistry.service.js';

/* -------------------------------------------------------------------------- */
/*  LECTURE                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Destinations VIVANTES — celles dont la fiche n'a pas été supprimée.
 *
 * Une fiche `DELETED` n'est pas détruite : son historique reste lisible. Elle
 * ne doit pour autant plus apparaître dans les listes de travail, sans quoi
 * l'opérateur croirait pouvoir la redéployer.
 */
export async function listTargets({ includeDeleted = false } = {}) {
  const query = includeDeleted ? {} : { lifecycleStatus: { $ne: LIFECYCLE.DELETED } };
  const docs = await PanelDeploymentTarget.find(query).sort({ createdAt: 1 }).lean();
  return docs.map(describeTarget);
}

/** Fiches supprimées — conservées pour l'audit, jamais pour l'exploitation. */
export async function listDeletedTargets() {
  const docs = await PanelDeploymentTarget.find({ lifecycleStatus: LIFECYCLE.DELETED })
    .sort({ deletedAt: -1 }).lean();
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
    // Même valeur, nommée comme le registre des ports la nomme. Le champ
    // stocké garde son nom historique ; l'interface et le registre parlent
    // de « port » — deux noms pour une seule vérité, pas deux champs.
    port: target.backendPort,
    remoteRoot: target.remoteRoot,
    dbName: target.dbName,
    certbotEmail: target.certbotEmail,
    extraEnv: target.extraEnv ?? {},
    selfHosted: target.selfHosted === true,
    state: target.state,

    // ── CYCLE DE VIE ────────────────────────────────────────────────────
    // Distinct de `state` : `state` dit comment s'est passé le dernier
    // déploiement, `lifecycleStatus` dit ce que la destination OCCUPE
    // encore sur le serveur. C'est le second qui autorise — ou non — une
    // suppression.
    lifecycleStatus: statusOf(target),
    lifecycleLabel: lifecycleLabel(statusOf(target)),
    deprovisionStartedAt: target.deprovisionStartedAt ?? null,
    deprovisionCompletedAt: target.deprovisionCompletedAt ?? null,
    deprovisionFailedAt: target.deprovisionFailedAt ?? null,
    lastDeprovisionRunId: target.lastDeprovisionRunId ?? null,
    emptiedAt: target.emptiedAt ?? null,
    deletedAt: target.deletedAt ?? null,
    lastError: target.lastError ?? null,
    quarantineEnabled: target.quarantineEnabled === true,
    activeDeploymentRunId: target.activeDeploymentRunId ?? null,
    currentSiteRoot: target.currentSiteRoot ?? null,
    projectIdentityId: target.projectIdentityId ?? null,
    // Ce que l'interface a besoin de savoir pour n'activer que ce qui est
    // permis — plutôt que de reconstruire la règle côté navigateur, où elle
    // divergerait dès la première évolution.
    canDeploy: statusOf(target) !== LIFECYCLE.DEPROVISIONING && statusOf(target) !== LIFECYCLE.DELETED,
    canDeprovision: [LIFECYCLE.ACTIVE, LIFECYCLE.DEPROVISION_FAILED, LIFECYCLE.DEPROVISIONING]
      .includes(statusOf(target)) && target.state !== 'DEPLOYING',
    canDelete: statusOf(target) === LIFECYCLE.EMPTY && target.state !== 'DEPLOYING',
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
      from: 'réservé par le registre des ports (base + PM2 + sockets réelles du serveur)',
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
 * ── L'ALLOCATION N'EST PLUS ICI (LOT 9) ────────────────────────────────────
 *
 * Ce fichier attribuait le port : « le plus haut déjà attribué en base, plus
 * un ». Cette règle ne consultait qu'une source — les fiches du Panel — et
 * ignorait donc les process encore en ligne dont la fiche avait disparu, les
 * sockets réellement ouvertes, et les services système.
 *
 * C'est ainsi que le port 5100, toujours détenu par l'ancien backend de
 * `panel.lycarz.com`, a été réattribué : le nouveau service a bouclé sur
 * EADDRINUSE plus de 7 000 fois.
 *
 * L'autorité appartient désormais à `portRegistry.service.js`, qui croise la
 * base, PM2 et les sockets réelles, réserve transactionnellement, vérifie de
 * nouveau avant démarrage et n'active qu'après preuve.
 */

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
    // Le port n'est attribué qu'à la CRÉATION, par le registre — et il ne
    // change jamais ensuite : le modifier casserait le service PM2 et la
    // configuration nginx déjà en place, qui le référencent tous les deux.
    backendPort: existing?.backendPort ?? null,
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
  // L'unicité vaut parmi les destinations VIVANTES : une fiche supprimée
  // conserve son hôte pour l'audit, mais ne réserve plus le domaine.
  if (await PanelDeploymentTarget.exists({ host: value.host, lifecycleStatus: { $ne: LIFECYCLE.DELETED } })) {
    throw ApiError.conflict('PANEL_TARGET_HOST_TAKEN',
      `Destination refusée parce que l’hôte « ${value.host} » est déjà déclaré.`);
  }

  /**
   * UNE SEULE DESTINATION ACTIVE PAR ENVIRONNEMENT.
   *
   * L'index unique partiel du modèle est la GARANTIE — il ne peut pas être
   * contourné. Ce contrôle-ci ne sert qu'à formuler le refus dans des termes
   * exploitables : une erreur de doublon Mongo dit « E11000 », pas « retirez
   * d'abord la destination existante ».
   *
   * Ce qu'il ferme : deux destinations TEST actives font de la résolution des
   * adresses et de la publication des médias une loterie, arbitrée par la date
   * du dernier déploiement.
   */
  const dejaActive = await PanelDeploymentTarget.findOne({
    environment: value.environment, lifecycleStatus: LIFECYCLE.ACTIVE,
  }).lean();
  if (dejaActive) {
    throw ApiError.conflict('PANEL_TARGET_ENVIRONMENT_TAKEN',
      `Destination refusée parce qu’une destination ${value.environment} est déjà active : `
      + `« ${dejaActive.name} » (${dejaActive.host}). Le Panel a une destination active par `
      + 'environnement, et une seule. Retirez l’existante avant d’en déclarer une nouvelle.',
      { host: dejaActive.host, environment: value.environment });
  }
  const at = nowIso();
  const targetId = randomUUID();

  /**
   * LE PORT VIENT DU REGISTRE, et il est réservé AVANT que la fiche existe.
   *
   * L'ordre compte : réserver après création laisserait exister, l'espace
   * d'une erreur, une destination sans port — donc indéployable et muette sur
   * la raison. Réserver avant, et annuler la réservation si la création
   * échoue, garantit qu'une fiche a toujours un port et qu'aucun port n'est
   * retenu par une fiche inexistante.
   */
  const reservation = await reservePort({
    target: {
      targetId,
      sshHost: value.sshHost,
      environment: value.environment,
      host: value.host,
      projectIdentityId: null,
    },
  });

  try {
    const doc = await PanelDeploymentTarget.create({
      ...value,
      backendPort: reservation.port,
      targetId,
      state: 'NEW',
      lifecycleStatus: LIFECYCLE.ACTIVE,
      createdAt: at,
      updatedAt: at,
      createdBy: actor.userId ?? null,
    });
    return describeTarget(doc.toObject());
  } catch (err) {
    // ROLLBACK : sans lui, chaque tentative ratée retiendrait un port de plus,
    // et la plage applicative se viderait sans que personne ne comprenne.
    await rollbackReservation(targetId, { reason: `création refusée : ${err.message}` })
      .catch(() => {});
    throw err;
  }
}

export async function updateTarget(targetId, input, actor = {}) {
  const existing = await getTargetOrThrow(targetId);
  const value = await normalize(input, { existing });

  if (value.host !== existing.host
    && await PanelDeploymentTarget.exists({
      host: value.host,
      targetId: { $ne: targetId },
      lifecycleStatus: { $ne: LIFECYCLE.DELETED },
    })) {
    throw ApiError.conflict('PANEL_TARGET_HOST_TAKEN',
      `Modification refusée parce que l’hôte « ${value.host} » est déjà déclaré.`);
  }

  await PanelDeploymentTarget.updateOne(
    { targetId },
    { $set: { ...value, updatedAt: nowIso(), createdBy: existing.createdBy ?? actor.userId ?? null } },
  );

  // CHANGEMENT DE SERVEUR : le port suit la destination — le changer casserait
  // Nginx et PM2 s'ils sont déjà posés. Mais la réservation cesse d'être
  // vérifiée : le nouveau serveur n'a jamais été consulté, et c'est le
  // contrôle d'avant démarrage qui tranchera.
  if (value.sshHost && value.sshHost !== existing.sshHost) {
    await moveReservationToServer(targetId, value.sshHost);
  }

  return describeTarget(await getTargetOrThrow(targetId));
}

/**
 * Supprime la FICHE d'une destination — jamais la destination elle-même.
 *
 * ── LA RÈGLE DU LOT 8 ───────────────────────────────────────────────────────
 * Une destination ACTIVE ne peut pas être supprimée. Supprimer la fiche d'une
 * destination encore en ligne, c'est perdre la seule trace de ce qu'il reste à
 * nettoyer sur le serveur : le process PM2 continue de tourner, il détient
 * toujours son port, Nginx continue de router — et l'allocation de port
 * recyclera un numéro déjà pris.
 *
 * La fiche ne se supprime donc qu'après un retrait VÉRIFIÉ (`EMPTY`), et la
 * suppression est LOGIQUE : l'historique, l'audit et les dates survivent. Une
 * suppression physique effacerait précisément la trace dont on a besoin le
 * jour où quelque chose cloche.
 *
 * La quarantaine 410 est levée à ce moment, et à ce moment seulement : tant
 * que le Panel connaît la destination, son domaine doit répondre « cette
 * adresse n'existe plus » plutôt que de retomber sur un autre site.
 */
export async function deleteTarget(targetId, actor = {}) {
  const target = await getTargetOrThrow(targetId);
  assertDeletable(target);
  if (target.quarantineEnabled === true) {
    throw ApiError.conflict('PANEL_TARGET_QUARANTINE_ACTIVE',
      `Suppression refusée parce que le domaine « ${target.host} » est encore neutralisé (410) `
      + 'sur le serveur. La suppression définitive doit lever cette quarantaine : '
      + 'utilisez « Supprimer la destination » avec le mot de passe SSH.',
      { host: target.host, requiresSsh: true });
  }
  const deleted = await softDelete(targetId, { actor });
  return { deleted: true, targetId, lifecycleStatus: deleted.lifecycleStatus, deletedAt: deleted.deletedAt };
}

/** Le nom de l'état, pour les messages — réexporté pour ne pas dupliquer la table. */
export { lifecycleLabel };

/* -------------------------------------------------------------------------- */
/*  ÉTAT                                                                      */
/* -------------------------------------------------------------------------- */

export async function markDeploying(targetId, runId) {
  await PanelDeploymentTarget.updateOne(
    { targetId },
    {
      $set: {
        state: 'DEPLOYING',
        lastRunId: runId,
        // Verrou lisible : tant qu'il est posé, aucun retrait ne démarre.
        activeDeploymentRunId: runId,
        updatedAt: nowIso(),
      },
    },
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
    // Le verrou de déploiement tombe avec le déploiement, réussi ou non :
    // le laisser posé interdirait à jamais le retrait de cette destination.
    doc.activeDeploymentRunId = null;
    if (ok) {
      doc.currentVersion = version ?? doc.currentVersion;
      doc.currentReleaseId = releaseId ?? doc.currentReleaseId;
      doc.lastDeployedAt = at;
      /**
       * Un déploiement RÉUSSI rend la destination ACTIVE — c'est le seul
       * chemin de retour depuis `EMPTY`, et il passe par une mise en ligne
       * réellement vérifiée. Une destination supprimée, elle, ne revient
       * jamais : sa fiche n'est plus exploitable.
       */
      if (doc.lifecycleStatus !== 'DELETED') {
        doc.lifecycleStatus = 'ACTIVE';
        doc.quarantineEnabled = false;
        doc.deprovisionFailedAt = null;
        doc.lastError = null;
      }
    } else {
      doc.lastError = error
        ? { at, code: error.code ?? 'DEPLOYMENT_FAILED', message: error.message ?? null, step: error.step ?? null }
        : doc.lastError;
    }
  } else if (operationType === 'DEPROVISION' || operationType === 'DESTINATION_DELETE') {
    // Le retrait ne repasse PAS par ici pour son état : le cycle de vie est
    // écrit par `destinationLifecycle.service`, qui seul connaît les
    // transitions valides. On ne conserve ici que la trace historique.
    doc.activeDeploymentRunId = doc.activeDeploymentRunId ?? null;
  } else if (doc.state === 'DEPLOYING') {
    // On restaure l'état d'avant l'opération plutôt que d'inventer.
    doc.state = doc.lastDeployedAt ? 'DEPLOYED' : 'NEW';
    doc.activeDeploymentRunId = null;
  }

  doc.updatedAt = at;
  await doc.save();
  return doc.toObject();
}

/** Le Panel se connaît-il une destination ? Utilisé par l'écran d'accueil. */
export async function deploymentSummary() {
  const all = await PanelDeploymentTarget.find().lean();
  const targets = all.filter((t) => statusOf(t) !== LIFECYCLE.DELETED);
  const par = (status) => targets.filter((t) => statusOf(t) === status).length;
  return {
    total: targets.length,
    deployed: targets.filter((t) => t.state === 'DEPLOYED').length,
    failed: targets.filter((t) => t.state === 'FAILED').length,
    deploying: targets.filter((t) => t.state === 'DEPLOYING').length,
    environments: {
      TEST: targets.filter((t) => t.environment === 'TEST').length,
      PROD: targets.filter((t) => t.environment === 'PROD').length,
    },
    // Le cycle de vie compte à part : une destination « vidée » n'est ni un
    // échec ni un succès de déploiement, c'est un emplacement libéré.
    lifecycle: {
      active: par(LIFECYCLE.ACTIVE),
      deprovisioning: par(LIFECYCLE.DEPROVISIONING),
      empty: par(LIFECYCLE.EMPTY),
      deprovisionFailed: par(LIFECYCLE.DEPROVISION_FAILED),
      deleted: all.filter((t) => statusOf(t) === LIFECYCLE.DELETED).length,
    },
    panelEnvironment: config.env,
  };
}

export default {
  listTargets, listDeletedTargets, getTargetOrThrow, describeTarget, describeDerivation, requiredEnvFor,
  createTarget, updateTarget, deleteTarget,
  markDeploying, recordDeployment, deploymentSummary,
};
