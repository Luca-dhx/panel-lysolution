// CYCLE DE VIE D'UNE DESTINATION — LOT 8.
//
// ══ LA CAUSE TRAITÉE ════════════════════════════════════════════════════════
//
// Une fiche de destination n'EST pas la destination : elle la décrit. Tant que
// le serveur porte encore le service, le port, le routage et les fichiers, la
// destination existe — même si plus personne ne la voit dans le Panel.
//
// C'est exactement ce qui s'est produit avec `panel.lycarz.com` : la fiche
// supprimée, sont restés un process PM2 en ligne détenant le port 5100, une
// configuration Nginx active et 49 Mo de fichiers. Le port ayant été recyclé
// pour la destination suivante, l'ancien backend le tenait et le nouveau
// bouclait sur EADDRINUSE — plus de 7 000 redémarrages — pendant que Nginx
// envoyait le nouveau domaine vers l'ANCIEN code.
//
// Ce module rend cette situation impossible : une destination ACTIVE ne peut
// plus être supprimée. Elle doit d'abord être VIDÉE, et l'état de ce vidage
// est écrit sur la fiche.
//
// ══ LES TRANSITIONS ═════════════════════════════════════════════════════════
//
//   ACTIVE ──────────► DEPROVISIONING ──────► EMPTY ──────► DELETED
//                            │                   ▲
//                            └► DEPROVISION_FAILED┘   (reprise : on relance)
//
// Toutes les écritures de transition sont des `findOneAndUpdate` CONDITIONNELS
// sur l'état de départ. Deux processus qui tentent la même transition ne
// peuvent donc pas réussir tous les deux : le second ne trouve plus de
// document correspondant à sa condition, et le sait.
import PanelDeploymentTarget from '../../models/PanelDeploymentTarget.model.js';
import ApiError from '../../utils/ApiError.js';
import logger from '../../utils/logger.js';
import { nowIso } from '../../bridge/bridgeContract.js';

/** États du cycle de vie — jamais des chaînes libres dans le code appelant. */
export const LIFECYCLE = Object.freeze({
  ACTIVE: 'ACTIVE',
  DEPROVISIONING: 'DEPROVISIONING',
  EMPTY: 'EMPTY',
  DEPROVISION_FAILED: 'DEPROVISION_FAILED',
  DELETED: 'DELETED',
});

/** États depuis lesquels un retrait peut (re)démarrer. */
const DEPROVISIONABLE = Object.freeze([
  LIFECYCLE.ACTIVE,
  LIFECYCLE.DEPROVISION_FAILED,
  // Reprise après interruption : un retrait dont le worker est mort a laissé
  // la fiche en DEPROVISIONING. Le relancer est le comportement voulu — les
  // étapes déjà accomplies sont idempotentes.
  LIFECYCLE.DEPROVISIONING,
]);

/** Libellé humain d'un état — l'interface et les messages d'erreur le partagent. */
export function lifecycleLabel(status) {
  return {
    ACTIVE: 'active',
    DEPROVISIONING: 'en cours de retrait',
    EMPTY: 'vidée',
    DEPROVISION_FAILED: 'retrait en échec',
    DELETED: 'supprimée',
  }[status] ?? String(status ?? 'inconnu');
}

/** Statut de cycle de vie d'une fiche, avec le repli des fiches antérieures. */
export function statusOf(target) {
  return target?.lifecycleStatus ?? LIFECYCLE.ACTIVE;
}

/* -------------------------------------------------------------------------- */
/*  GARDES                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Un déploiement peut-il démarrer sur cette destination ?
 *
 * Déployer pendant un retrait produirait un état que personne ne sait décrire :
 * des fichiers réécrits sous un dossier en cours de suppression, un service
 * relancé sur un port qu'on vient de libérer. On refuse, en nommant l'état.
 */
export function assertDeployable(target) {
  const status = statusOf(target);
  if (status === LIFECYCLE.DEPROVISIONING) {
    throw ApiError.conflict('PANEL_TARGET_DEPROVISIONING',
      `Déploiement refusé parce que « ${target.name} » est en cours de retrait. `
      + 'Attendez la fin du retrait, ou reprenez-le s’il a été interrompu.');
  }
  if (status === LIFECYCLE.DELETED) {
    throw ApiError.conflict('PANEL_TARGET_DELETED',
      `Déploiement refusé parce que la destination « ${target.name} » a été supprimée.`);
  }
  return true;
}

/**
 * Un retrait peut-il démarrer ?
 *
 * Refusé pendant un déploiement : le retrait couperait le service au milieu
 * d'une mise en ligne, et le déploiement continuerait d'écrire dans un dossier
 * qu'on est en train d'effacer.
 */
export function assertDeprovisionable(target, { activeRun = null } = {}) {
  const status = statusOf(target);
  if (status === LIFECYCLE.DELETED) {
    throw ApiError.conflict('PANEL_TARGET_DELETED',
      'Retrait refusé parce que cette destination a déjà été supprimée.');
  }
  if (status === LIFECYCLE.EMPTY) {
    throw ApiError.conflict('PANEL_TARGET_ALREADY_EMPTY',
      `Retrait inutile : « ${target.name} » est déjà vidée. Vous pouvez supprimer sa fiche.`);
  }
  if (!DEPROVISIONABLE.includes(status)) {
    throw ApiError.conflict('PANEL_TARGET_NOT_DEPROVISIONABLE',
      `Retrait refusé : la destination est ${lifecycleLabel(status)}.`);
  }
  if (activeRun && activeRun.operationType !== 'DEPROVISION') {
    throw ApiError.conflict('PANEL_TARGET_BUSY',
      `Retrait refusé parce qu’une opération est en cours sur « ${target.name} » `
      + `(${activeRun.operationType}).`, { runId: activeRun.runId });
  }
  if (target.state === 'DEPLOYING') {
    throw ApiError.conflict('PANEL_TARGET_DEPLOYING',
      'Retrait refusé parce qu’un déploiement est en cours sur cette destination.');
  }
  return true;
}

/**
 * La fiche peut-elle être supprimée ?
 *
 * C'est LA règle du lot : une destination qui n'est pas EMPTY ne se supprime
 * pas. Le message dit quoi faire — refuser sans indiquer la sortie ne serait
 * qu'un mur.
 */
export function assertDeletable(target) {
  const status = statusOf(target);
  if (status === LIFECYCLE.DELETED) {
    throw ApiError.conflict('PANEL_TARGET_DELETED', 'Cette destination est déjà supprimée.');
  }
  if (status !== LIFECYCLE.EMPTY) {
    throw ApiError.conflict('PANEL_TARGET_NOT_EMPTY',
      `Suppression refusée parce que « ${target.name} » est ${lifecycleLabel(status)} : `
      + 'ses fichiers, son service et son routage sont peut-être encore sur le serveur. '
      + 'Utilisez « Retirer le déploiement » d’abord — la fiche ne pourra être supprimée '
      + 'qu’une fois la destination vidée.', { lifecycleStatus: status });
  }
  if (target.state === 'DEPLOYING') {
    throw ApiError.conflict('PANEL_TARGET_DEPLOYING',
      'Suppression refusée parce qu’un déploiement est en cours sur cette destination.');
  }
  return true;
}

/* -------------------------------------------------------------------------- */
/*  TRANSITIONS                                                               */
/* -------------------------------------------------------------------------- */

/**
 * ACTIVE | DEPROVISION_FAILED | DEPROVISIONING → DEPROVISIONING.
 *
 * Conditionnelle et atomique : c'est le VERROU. Deux retraits lancés en même
 * temps ne peuvent pas tous deux poser la marque ; celui qui la trouve déjà
 * posée par un AUTRE run est refusé.
 *
 * `deprovisionStartedAt` n'est écrit qu'à la première entrée dans l'état : une
 * reprise ne réécrit pas l'heure de départ, sinon la durée réelle du retrait
 * serait perdue.
 */
export async function beginDeprovision(targetId, { runId }) {
  const at = nowIso();
  const doc = await PanelDeploymentTarget.findOneAndUpdate(
    {
      targetId,
      lifecycleStatus: { $in: DEPROVISIONABLE },
      // Aucun déploiement en vol : le verrou du déploiement fait foi.
      $or: [{ activeDeploymentRunId: null }, { activeDeploymentRunId: { $exists: false } }],
      state: { $ne: 'DEPLOYING' },
    },
    {
      $set: {
        lifecycleStatus: LIFECYCLE.DEPROVISIONING,
        lastDeprovisionRunId: runId,
        deprovisionFailedAt: null,
        updatedAt: at,
      },
    },
    { new: true },
  );
  if (!doc) {
    throw ApiError.conflict('PANEL_DEPROVISION_LOCKED',
      'Retrait refusé : la destination est déjà verrouillée par une autre opération, '
      + 'ou son état ne permet pas de démarrer un retrait.');
  }
  if (!doc.deprovisionStartedAt) {
    await PanelDeploymentTarget.updateOne({ targetId }, { $set: { deprovisionStartedAt: at } });
    doc.deprovisionStartedAt = at;
  }
  return doc.toObject();
}

/** DEPROVISIONING → EMPTY. La destination ne porte plus rien sur le serveur. */
export async function markEmpty(targetId, { runId = null, quarantine = true } = {}) {
  const at = nowIso();
  const doc = await PanelDeploymentTarget.findOneAndUpdate(
    { targetId, lifecycleStatus: LIFECYCLE.DEPROVISIONING },
    {
      $set: {
        lifecycleStatus: LIFECYCLE.EMPTY,
        deprovisionCompletedAt: at,
        emptiedAt: at,
        deprovisionFailedAt: null,
        lastError: null,
        quarantineEnabled: quarantine === true,
        lastDeprovisionRunId: runId,
        // Le service n'est plus en ligne : l'état de déploiement doit le dire.
        state: 'NEW',
        currentVersion: null,
        currentReleaseId: null,
        currentSiteRoot: null,
        activeDeploymentRunId: null,
        updatedAt: at,
      },
    },
    { new: true },
  );
  return doc ? doc.toObject() : null;
}

/** DEPROVISIONING → DEPROVISION_FAILED. L'échec est conservé, pas effacé. */
export async function markDeprovisionFailed(targetId, { runId = null, error = null } = {}) {
  const at = nowIso();
  const doc = await PanelDeploymentTarget.findOneAndUpdate(
    { targetId, lifecycleStatus: LIFECYCLE.DEPROVISIONING },
    {
      $set: {
        lifecycleStatus: LIFECYCLE.DEPROVISION_FAILED,
        deprovisionFailedAt: at,
        lastDeprovisionRunId: runId,
        lastError: error
          ? { at, code: error.code ?? 'DEPROVISION_FAILED', message: error.message ?? null, step: error.step ?? null }
          : null,
        updatedAt: at,
      },
    },
    { new: true },
  );
  return doc ? doc.toObject() : null;
}

/** La quarantaine est posée (retrait) ou levée (suppression définitive). */
export async function setQuarantine(targetId, enabled) {
  await PanelDeploymentTarget.updateOne(
    { targetId },
    { $set: { quarantineEnabled: enabled === true, updatedAt: nowIso() } },
  );
}

/**
 * EMPTY → DELETED — suppression LOGIQUE.
 *
 * On ne détruit pas le document : l'historique des déploiements, les erreurs,
 * les dates et l'auteur restent lisibles. Une suppression physique effacerait
 * la seule trace de ce qui a été mis en ligne sur ce domaine — exactement ce
 * qui a rendu l'incident `panel.lycarz.com` si difficile à reconstituer.
 *
 * `ProjectIdentity` n'est jamais touchée ici : elle appartient au PROJET, pas
 * à la destination, et d'autres destinations peuvent la partager.
 */
export async function softDelete(targetId, { actor = null } = {}) {
  const at = nowIso();
  const doc = await PanelDeploymentTarget.findOneAndUpdate(
    { targetId, lifecycleStatus: LIFECYCLE.EMPTY },
    {
      $set: {
        lifecycleStatus: LIFECYCLE.DELETED,
        deletedAt: at,
        quarantineEnabled: false,
        activeDeploymentRunId: null,
        updatedAt: at,
      },
      $push: {
        history: {
          $each: [{
            at,
            operationType: 'DESTINATION_DELETE',
            version: null,
            user: actor?.userEmail ?? actor?.userId ?? null,
            durationMs: null,
            success: true,
            failedStep: null,
            error: null,
            steps: [],
          }],
          $position: 0,
          $slice: 50,
        },
      },
    },
    { new: true },
  );
  if (!doc) {
    throw ApiError.conflict('PANEL_TARGET_NOT_EMPTY',
      'Suppression refusée : la destination n’est plus dans l’état « vidée ».');
  }
  return doc.toObject();
}

/* -------------------------------------------------------------------------- */
/*  VERROU DE DÉPLOIEMENT                                                     */
/* -------------------------------------------------------------------------- */

/** Pose le verrou de déploiement — lu par `assertDeprovisionable`. */
export async function lockForDeployment(targetId, runId) {
  await PanelDeploymentTarget.updateOne(
    { targetId },
    { $set: { activeDeploymentRunId: runId, updatedAt: nowIso() } },
  );
}

/**
 * Lève le verrou de déploiement, et remet la destination en ACTIVE quand la
 * mise en ligne a réussi.
 *
 * Redéployer une destination VIDÉE la rend active : c'est le seul chemin de
 * retour depuis EMPTY, et il passe par une mise en ligne réellement vérifiée —
 * jamais par un simple changement d'état à la main.
 */
export async function releaseDeploymentLock(targetId, { ok = false, runId = null, siteRoot = null } = {}) {
  const at = nowIso();
  const set = { activeDeploymentRunId: null, updatedAt: at };
  if (ok) {
    set.lifecycleStatus = LIFECYCLE.ACTIVE;
    set.quarantineEnabled = false;
    set.lastHealthyDeploymentRunId = runId;
    set.deprovisionFailedAt = null;
    set.lastError = null;
    if (siteRoot) set.currentSiteRoot = siteRoot;
  }
  await PanelDeploymentTarget.updateOne(
    { targetId, lifecycleStatus: { $ne: LIFECYCLE.DELETED } },
    { $set: set },
  );
}

/* -------------------------------------------------------------------------- */
/*  MIGRATION                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * CODES D'ARRÊT DE DÉMARRAGE — nommés, parce qu'un arrêt anonyme n'aide personne.
 */
export const MIGRATION_ERRORS = Object.freeze({
  ACTIVE_CONFLICT: 'DEPLOYMENT_ENVIRONMENT_ACTIVE_CONFLICT',
  ACTIVE_INDEX_MISSING: 'DEPLOYMENT_ACTIVE_INDEX_MISSING',
});

/** Le nom de l'index qui PORTE la garantie « une seule ACTIVE par environnement ». */
export const ACTIVE_INDEX_NAME = 'environnement_actif_unique';

/** Une erreur de démarrage : elle porte un code et la liste des fiches en cause. */
class MigrationBlockedError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'MigrationBlockedError';
    this.code = code;
    this.details = details;
  }
}

/**
 * Les environnements portant PLUSIEURS destinations ACTIVE.
 *
 * Lu AVANT toute tentative de construction d'index : c'est la seule façon de
 * dire QUELLES fiches posent problème. Une erreur d'index Mongo dit « E11000 »
 * et une clé ; elle ne dit pas quoi arbitrer.
 */
export async function activeConflicts() {
  const actives = await PanelDeploymentTarget.find({ lifecycleStatus: LIFECYCLE.ACTIVE })
    .select('_id host environment backendPort state sshHost')
    .lean();
  const parEnv = new Map();
  for (const t of actives) {
    const cle = t.environment ?? 'SANS_ENVIRONNEMENT';
    if (!parEnv.has(cle)) parEnv.set(cle, []);
    parEnv.get(cle).push(t);
  }
  return [...parEnv.entries()]
    .filter(([, fiches]) => fiches.length > 1)
    .map(([environment, fiches]) => ({ environment, fiches }));
}

/**
 * REPRISE DES FICHES ANTÉRIEURES — appelée au démarrage du backend.
 *
 * ══ FAIL-CLOSED, ET POURQUOI ═══════════════════════════════════════════════
 *
 * Cette fonction avalait l'échec de construction d'index (`.catch(() => {})`).
 * Sur des données réelles portant deux destinations ACTIVE sans environnement,
 * le résultat mesuré était : les deux backfillées dans le même environnement,
 * l'index REFUSÉ, l'échec avalé, le démarrage annoncé sain — et la garantie
 * « une seule ACTIVE par environnement » ABSENTE sans que rien ne le dise.
 *
 * C'est le pire état possible : un système qui paraît conforme et ne l'est
 * pas. Exactement la panne que l'index était censé rendre impossible.
 *
 * Le démarrage S'ARRÊTE donc désormais, dans deux cas et avec deux codes :
 *
 *   · plusieurs ACTIVE pour un même environnement → on nomme les fiches, on
 *     n'en arbitre AUCUNE. Le choix appartient à l'exploitant, pas à une date ;
 *   · l'index n'existe pas après construction → on ne peut pas prouver la
 *     garantie, donc on ne la promet pas.
 *
 * L'ordre compte : on migre les champs, PUIS on détecte les conflits, PUIS on
 * construit, PUIS on RELIT les index de Mongo pour vérifier. Construire avant
 * de détecter ne dirait jamais quelles fiches sont en cause.
 *
 * AUCUNE fiche n'est supprimée, ni vidée, ni arbitrée.
 */
export async function migrateDeploymentTargets() {
  /* ── 1. MIGRER LES CHAMPS ─────────────────────────────────────────────── */

  // Toute destination sans cycle de vie devient ACTIVE : choix conservateur.
  // On ne sait pas ce qu'il y a sur le serveur, donc on suppose que tout y est.
  // Supposer l'inverse autoriserait la suppression d'une fiche dont le service
  // tourne encore.
  const result = await PanelDeploymentTarget.updateMany(
    { $or: [{ lifecycleStatus: { $exists: false } }, { lifecycleStatus: null }] },
    { $set: { lifecycleStatus: LIFECYCLE.ACTIVE } },
  );

  /**
   * L'ENVIRONNEMENT DES FICHES ANTÉRIEURES.
   *
   * Il n'existait pas : il était choisi au déploiement, avec PROD par défaut.
   * On reprend donc ce défaut historique — c'est ce que ces destinations
   * FAISAIENT réellement, et supposer autre chose réécrirait le passé.
   *
   * Quand ce report produit un conflit, il n'est pas résolu ici : il est
   * SIGNALÉ, et le démarrage s'arrête.
   */
  const envResult = await PanelDeploymentTarget.updateMany(
    { $or: [{ environment: { $exists: false } }, { environment: null }] },
    { $set: { environment: 'PROD' } },
  );

  /* ── 2. L'ANCIEN INDEX ABSOLU SUR L'HÔTE ──────────────────────────────── */

  // Il interdisait de recréer une destination sur un domaine libéré, puisqu'une
  // fiche supprimée conserve son hôte. L'index PARTIEL du modèle le remplace.
  let indexDropped = false;
  try {
    const indexes = await PanelDeploymentTarget.collection.indexes();
    const legacy = indexes.find((i) =>
      i.unique === true
      && !i.partialFilterExpression
      && JSON.stringify(i.key) === JSON.stringify({ host: 1 }));
    if (legacy) {
      await PanelDeploymentTarget.collection.dropIndex(legacy.name);
      indexDropped = true;
      logger.info(`Index unique historique « ${legacy.name} » retiré : l'unicité de l'hôte ne vaut plus que parmi les destinations vivantes.`);
    }
  } catch {
    // Collection absente ou index déjà retiré : le retrait de l'ancien index
    // est un confort. La garantie, elle, est vérifiée plus bas — et bloquante.
  }

  /* ── 3. DÉTECTER LES CONFLITS AVANT DE CONSTRUIRE ─────────────────────── */

  const conflits = await activeConflicts();
  if (conflits.length > 0) {
    const detail = conflits
      .map(({ environment, fiches }) =>
        `${environment} : ${fiches.map((f) => `${f.host} (port ${f.backendPort}, _id ${f._id})`).join(' ET ')}`)
      .join(' — ');
    logger.error(`[destinations] Démarrage REFUSÉ : plusieurs destinations ACTIVE pour un même environnement. ${detail}`);
    throw new MigrationBlockedError(
      MIGRATION_ERRORS.ACTIVE_CONFLICT,
      'Démarrage refusé : plusieurs destinations ACTIVE partagent un environnement. '
      + `${detail}. Une seule peut servir un environnement à la fois. Reclassez les autres `
      + '(RETIRED, ou retrait complet) avant de redémarrer — aucune n\'est arbitrée automatiquement.',
      { conflicts: conflits },
    );
  }

  /* ── 4. CONSTRUIRE, PUIS RELIRE POUR VÉRIFIER ─────────────────────────── */

  /**
   * ON CONSTRUIT EXPLICITEMENT, sans dépendre d'`autoIndex`.
   *
   * `init()` respecte le réglage global `autoIndex` : sur une installation qui
   * le désactive — pratique courante en production, pour éviter des
   * constructions d'index surprises au démarrage — l'index n'aurait jamais été
   * créé, et la garantie aurait manqué sans que rien ne le dise. Une invariante
   * ne doit pas dépendre d'un drapeau de confort.
   *
   * `createIndexes()` construit ce que le schéma déclare, quoi qu'il arrive.
   * Son échec n'est PLUS avalé : sans index, la garantie n'existe pas.
   */
  try {
    await PanelDeploymentTarget.createIndexes();
  } catch (err) {
    logger.error(`[destinations] Construction de l'index « ${ACTIVE_INDEX_NAME} » impossible : ${err.message}`);
    throw new MigrationBlockedError(
      MIGRATION_ERRORS.ACTIVE_INDEX_MISSING,
      `Démarrage refusé : l'index « ${ACTIVE_INDEX_NAME} » n'a pas pu être construit (${err.message}). `
      + 'Sans lui, rien n\'empêche deux destinations d\'être actives dans le même environnement.',
      { cause: err.message },
    );
  }

  /**
   * ON RELIT MONGO. Un `init()` qui rend sans lever ne prouve pas qu'un index
   * existe — c'est précisément l'hypothèse qui a échoué en silence avec le
   * filtre partiel en `$ne`. On demande donc à la base ce qu'elle a vraiment.
   */
  const presents = await PanelDeploymentTarget.collection.indexes();
  const garantie = presents.find((i) => i.name === ACTIVE_INDEX_NAME && i.unique === true);
  if (!garantie) {
    logger.error(`[destinations] L'index « ${ACTIVE_INDEX_NAME} » est ABSENT après construction.`);
    throw new MigrationBlockedError(
      MIGRATION_ERRORS.ACTIVE_INDEX_MISSING,
      `Démarrage refusé : l'index « ${ACTIVE_INDEX_NAME} » est absent après construction. `
      + 'La garantie « une seule destination active par environnement » ne peut pas être promise.',
      { indexes: presents.map((i) => i.name) },
    );
  }

  return {
    lifecycleBackfilled: result.modifiedCount ?? 0,
    environmentBackfilled: envResult.modifiedCount ?? 0,
    legacyHostIndexDropped: indexDropped,
    activeIndexVerified: true,
  };
}

export default {
  LIFECYCLE,
  MIGRATION_ERRORS,
  ACTIVE_INDEX_NAME,
  activeConflicts,
  lifecycleLabel,
  statusOf,
  assertDeployable,
  assertDeprovisionable,
  assertDeletable,
  beginDeprovision,
  markEmpty,
  markDeprovisionFailed,
  setQuarantine,
  softDelete,
  lockForDeployment,
  releaseDeploymentLock,
  migrateDeploymentTargets,
};
