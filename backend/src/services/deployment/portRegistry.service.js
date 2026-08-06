// AUTORITÉ CENTRALE DES PORTS APPLICATIFS — LOT 9.
//
// ══ LA CAUSE TRAITÉE ════════════════════════════════════════════════════════
//
// L'attribution était « le plus haut port déjà attribué en base, plus un ».
// Elle ne consultait qu'une seule source : les fiches du Panel. Elle ignorait
// donc les process encore en ligne dont la fiche a disparu, les sockets
// réellement ouvertes, et les services système.
//
// Après la suppression de la fiche de `panel.lycarz.com`, le port 5100 est
// redescendu dans la plage libre et a été réattribué à la destination
// suivante — alors que l'ancien backend, toujours en ligne, le DÉTENAIT. Le
// nouveau service a bouclé sur EADDRINUSE plus de 7 000 fois, pendant que
// Nginx envoyait le trafic du nouveau domaine vers l'ancien code.
//
// ══ LA RÈGLE ═══════════════════════════════════════════════════════════════
//
// Un port n'est libre que si les TROIS sources le disent : la base, PM2, les
// sockets. Et il n'est ACTIF que lorsqu'on a prouvé que le bon PID le détient.
//
// L'allocation suit donc sept temps :
//   1. charger les ports réservés en base ;
//   2. lire les process PM2 du serveur ;
//   3. lire les sockets réelles ;
//   4. exclure tout ce qui est occupé, réservé ou interdit ;
//   5. réserver transactionnellement (index unique partiel) ;
//   6. vérifier de nouveau juste avant le démarrage ;
//   7. n'activer qu'après preuve que le bon PID détient le port.
//
// Sans transport (écran de création : aucun mot de passe SSH), seules les
// étapes 1, 4 et 5 sont possibles. La réservation est alors marquée non
// vérifiée, et les étapes 2, 3, 6 et 7 ont lieu au déploiement — moment où
// une connexion existe. Prétendre avoir vérifié un serveur qu'on n'a pas
// contacté serait pire que de l'annoncer.
import PanelPortReservation from '../../models/PanelPortReservation.model.js';
import ApiError from '../../utils/ApiError.js';
import logger from '../../utils/logger.js';
import { nowIso } from '../../bridge/bridgeContract.js';
import {
  NEVER_ALLOCATE, PORT_ERRORS, PORT_RANGE, findFreePort, readPortLandscape,
} from '../../deployment-engine/ports.js';

export const RESERVATION_STATUS = Object.freeze({
  RESERVED: 'RESERVED',
  ACTIVE: 'ACTIVE',
  RELEASING: 'RELEASING',
  RELEASED: 'RELEASED',
});

/** Réservations qui RETIENNENT encore le port. */
const VIVANTES = [RESERVATION_STATUS.RESERVED, RESERVATION_STATUS.ACTIVE, RESERVATION_STATUS.RELEASING];

/** Nombre de collisions tolérées avant d'abandonner l'allocation. */
const MAX_TENTATIVES = 25;

/**
 * L'INDEX UNIQUE DOIT EXISTER AVANT LA PREMIÈRE RÉSERVATION.
 *
 * C'est lui, et lui seul, qui rend la réservation transactionnelle : sans lui,
 * deux allocations simultanées lisent les mêmes ports libres et écrivent
 * toutes les deux. Mongoose construit ses index en tâche de fond ; attendre
 * cette construction est donc un PRÉALABLE, pas une optimisation.
 *
 * `Model.init()` est idempotent et mémorise sa promesse : l'appeler à chaque
 * réservation ne coûte rien après la première.
 */
async function ensureIndexes() {
  await PanelPortReservation.init();
}

/** Clé de serveur normalisée. Un port appartient à un serveur, pas au Panel. */
export function serverKeyOf(target) {
  const brut = target?.sshHost ?? target?.serverKey ?? null;
  if (!brut) {
    throw ApiError.badRequest('PANEL_PORT_NO_SERVER',
      'Port impossible à réserver : la destination ne déclare aucun serveur.');
  }
  return String(brut).trim().toLowerCase();
}

/* -------------------------------------------------------------------------- */
/*  LECTURE                                                                   */
/* -------------------------------------------------------------------------- */

/** Réservations vivantes d'un serveur. */
export async function liveReservations(serverKey) {
  return PanelPortReservation.find({ serverKey, status: { $in: VIVANTES } })
    .sort({ port: 1 }).lean();
}

/** Ports retenus par la base sur un serveur. */
export async function reservedPorts(serverKey) {
  return (await liveReservations(serverKey)).map((r) => r.port);
}

/** La réservation vivante d'une destination, s'il y en a une. */
export async function reservationFor(targetId) {
  return PanelPortReservation.findOne({
    deploymentTargetId: targetId, status: { $in: VIVANTES },
  }).lean();
}

/** Projection lisible — ce que l'interface et les rapports affichent. */
export function describeReservation(doc) {
  if (!doc) return null;
  return {
    port: doc.port,
    serverKey: doc.serverKey,
    host: doc.host ?? null,
    deploymentTargetId: doc.deploymentTargetId ?? null,
    projectIdentityId: doc.projectIdentityId ?? null,
    environment: doc.environment,
    serviceType: doc.serviceType ?? 'backend',
    status: doc.status,
    reservedAt: doc.reservedAt,
    activatedAt: doc.activatedAt ?? null,
    releasedAt: doc.releasedAt ?? null,
    processName: doc.processName ?? null,
    pid: doc.pid ?? null,
    lastVerifiedAt: doc.lastVerifiedAt ?? null,
    lastConflict: doc.lastConflict ?? null,
  };
}

/** Vue complète du registre d'un serveur — pour l'écran et le diagnostic. */
export async function describeServerRegistry(serverKey) {
  const docs = await PanelPortReservation.find({ serverKey }).sort({ port: 1 }).lean();
  return {
    serverKey,
    range: PORT_RANGE,
    neverAllocate: NEVER_ALLOCATE,
    reservations: docs.map(describeReservation),
    live: docs.filter((d) => VIVANTES.includes(d.status)).length,
  };
}

/* -------------------------------------------------------------------------- */
/*  RÉSERVATION                                                               */
/* -------------------------------------------------------------------------- */

/**
 * RÉSERVE un port pour une destination — ou rend celui qu'elle a déjà.
 *
 * ── LA MÊME DESTINATION GARDE SON PORT ──────────────────────────────────────
 * Un redéploiement ne change JAMAIS de port : le service PM2 et la
 * configuration Nginx en place le référencent. En changer casserait le proxy
 * pendant que le service, lui, écoute ailleurs.
 *
 * @param {object} args
 * @param {object} args.target     destination (targetId, sshHost, environment, host…)
 * @param {object} [args.transport] transport ouvert — permet les étapes 2, 3
 *        (lecture PM2 et sockets). Absent : réservation depuis la base seule,
 *        marquée non vérifiée.
 * @returns {Promise<{port:number, reservation:object, verified:boolean, landscape:object|null}>}
 */
export async function reservePort({ target, transport = null }) {
  await ensureIndexes();
  const serverKey = serverKeyOf(target);
  const at = nowIso();

  // La destination a-t-elle déjà un port ? Alors c'est le sien, point.
  const existante = await reservationFor(target.targetId);
  if (existante) {
    return {
      port: existante.port,
      reservation: describeReservation(existante),
      verified: Boolean(existante.lastVerifiedAt),
      landscape: null,
      reused: true,
    };
  }

  // 2 & 3. Ce que le SERVEUR dit — quand on peut le lui demander.
  let landscape = null;
  if (transport) {
    landscape = await readPortLandscape(transport);
    if (!landscape.socketsReadable) {
      // Une lecture ratée n'est PAS « aucun port occupé ». On le dit, et on
      // continue sur les seules sources sûres — la vérification d'avant
      // démarrage repassera dessus.
      logger.warn(`Registre des ports : sockets illisibles sur ${serverKey}. `
        + 'L’allocation s’appuie sur la base et PM2 ; la vérification avant démarrage reste bloquante.');
    }
  }

  // 4 & 5. Exclure, puis réserver TRANSACTIONNELLEMENT. L'index unique partiel
  // du modèle tranche : deux créations simultanées ne peuvent pas obtenir le
  // même port, la perdante recommence sur le suivant.
  const dejaEssayes = [];
  for (let tentative = 0; tentative < MAX_TENTATIVES; tentative += 1) {
    const reserves = await reservedPorts(serverKey);
    const port = findFreePort({
      reserved: reserves,
      occupied: landscape?.occupied ?? [],
      excluded: dejaEssayes,
    });

    try {
      const doc = await PanelPortReservation.create({
        serverKey,
        port,
        deploymentTargetId: target.targetId,
        projectIdentityId: target.projectIdentityId ?? null,
        host: target.host ?? null,
        environment: target.environment,
        serviceType: 'backend',
        status: RESERVATION_STATUS.RESERVED,
        reservedAt: at,
        lastVerifiedAt: landscape ? at : null,
        createdAt: at,
        updatedAt: at,
      });
      return {
        port,
        reservation: describeReservation(doc.toObject()),
        verified: Boolean(landscape),
        landscape,
        reused: false,
      };
    } catch (err) {
      // Doublon : une autre opération a pris ce port entre notre lecture et
      // notre écriture. C'est le cas NORMAL de la concurrence — on recommence
      // sur le suivant plutôt que d'écraser.
      if (err?.code === 11000) { dejaEssayes.push(port); continue; }
      throw err;
    }
  }

  throw ApiError.conflict(PORT_ERRORS.PORT_RESERVATION_CONFLICT,
    `Aucun port n’a pu être réservé sur ${serverKey} après ${MAX_TENTATIVES} tentatives : `
    + 'des réservations concurrentes se disputent la plage applicative.');
}

/**
 * VÉRIFICATION D'AVANT DÉMARRAGE — étape 6.
 *
 * Entre la réservation et le démarrage, le serveur a pu changer : un process
 * oublié peut avoir été relancé, un service système installé. On regarde donc
 * de nouveau, et on refuse plutôt que de laisser PM2 découvrir la collision en
 * bouclant.
 *
 * Trois issues seulement :
 *   · libre                                → on démarre ;
 *   · détenu par NOTRE service PM2         → on démarre (redéploiement) ;
 *   · détenu par autre chose               → on S'ARRÊTE, en nommant le détenteur.
 */
export async function verifyBeforeStart({ target, transport, expectedPm2Name }) {
  const serverKey = serverKeyOf(target);
  const reservation = await reservationFor(target.targetId);
  if (!reservation) {
    throw ApiError.conflict(PORT_ERRORS.PORT_RESERVATION_CONFLICT,
      `Aucune réservation de port vivante pour « ${target.name ?? target.host} » : `
      + 'le déploiement ne peut pas démarrer un service sans port attribué.');
  }
  const port = reservation.port;
  const landscape = await readPortLandscape(transport);
  const at = nowIso();

  // Une AUTRE destination du Panel réserve-t-elle ce port sur ce serveur ?
  const concurrente = await PanelPortReservation.findOne({
    serverKey,
    port,
    status: { $in: VIVANTES },
    deploymentTargetId: { $ne: target.targetId },
  }).lean();
  if (concurrente) {
    await noteConflict(reservation, { at, kind: 'RESERVATION', other: concurrente.deploymentTargetId });
    throw ApiError.conflict(PORT_ERRORS.PORT_RESERVATION_CONFLICT,
      `Le port ${port} est réservé par une autre destination sur ${serverKey}.`,
      { port, otherTargetId: concurrente.deploymentTargetId });
  }

  const pm2Concurrent = landscape.processes.find((p) => p.port === port && p.name !== expectedPm2Name);
  if (pm2Concurrent) {
    await noteConflict(reservation, { at, kind: 'PM2', holder: pm2Concurrent.name, pid: pm2Concurrent.pid });
    throw ApiError.conflict(PORT_ERRORS.PM2_PORT_COLLISION,
      `Le port ${port} est déjà utilisé par le service PM2 « ${pm2Concurrent.name} » sur ${serverKey}. `
      + 'Ce service appartient probablement à une destination retirée sans avoir été vidée.',
      { port, holder: pm2Concurrent.name, pid: pm2Concurrent.pid });
  }

  const socket = landscape.sockets.find((s) => s.port === port);
  if (socket) {
    const notre = landscape.processes.find((p) => p.name === expectedPm2Name);
    const aNous = notre && notre.pid !== null && socket.pid === notre.pid;
    if (!aNous) {
      await noteConflict(reservation, { at, kind: 'UNKNOWN', holder: socket.process, pid: socket.pid });
      throw ApiError.conflict(PORT_ERRORS.PORT_IN_USE_UNKNOWN_PROCESS,
        `Le port ${port} est détenu sur ${serverKey} par un programme inconnu du Panel `
        + `(${socket.process ?? 'processus inconnu'}${socket.pid ? `, pid ${socket.pid}` : ''}). `
        + 'Le déploiement s’arrête : disputer un port à un service légitime est pire que de ne pas déployer.',
        { port, holder: socket.process, pid: socket.pid });
    }
  }

  await PanelPortReservation.updateOne(
    { _id: reservation._id },
    { $set: { lastVerifiedAt: at, lastConflict: null, updatedAt: at } },
  );
  return { port, free: !socket, heldByUs: Boolean(socket), landscape };
}

/** Enregistre le constat contradictoire, sans changer l'état de la réservation. */
async function noteConflict(reservation, conflict) {
  await PanelPortReservation.updateOne(
    { _id: reservation._id },
    { $set: { lastConflict: conflict, lastVerifiedAt: conflict.at, updatedAt: conflict.at } },
  );
}

/**
 * ACTIVATION — étape 7. Uniquement après PREUVE que le bon PID détient le port.
 *
 * `RESERVED → ACTIVE` n'est pas une formalité : c'est la seule transition qui
 * affirme qu'un service tourne réellement derrière ce port. Un déploiement qui
 * échoue laisse la réservation en `RESERVED` — le port reste retenu, ce qui
 * est correct : la destination existe toujours.
 */
export async function activateReservation(targetId, { pid = null, processName = null } = {}) {
  const at = nowIso();
  const doc = await PanelPortReservation.findOneAndUpdate(
    { deploymentTargetId: targetId, status: { $in: [RESERVATION_STATUS.RESERVED, RESERVATION_STATUS.ACTIVE] } },
    {
      $set: {
        status: RESERVATION_STATUS.ACTIVE,
        activatedAt: at,
        pid,
        processName,
        lastVerifiedAt: at,
        lastConflict: null,
        updatedAt: at,
      },
    },
    { new: true },
  );
  return describeReservation(doc ? doc.toObject() : null);
}

/* -------------------------------------------------------------------------- */
/*  LIBÉRATION                                                                */
/* -------------------------------------------------------------------------- */

/**
 * ENGAGE la libération — `RELEASING`. Le port reste RETENU.
 *
 * Entre l'arrêt d'un service et la constatation que le port est libre, il
 * existe un intervalle où le déclarer libre serait un mensonge. L'attribuer à
 * une autre destination pendant cet intervalle reproduirait exactement
 * l'incident d'origine.
 */
export async function beginRelease(targetId) {
  const at = nowIso();
  const doc = await PanelPortReservation.findOneAndUpdate(
    { deploymentTargetId: targetId, status: { $in: VIVANTES } },
    { $set: { status: RESERVATION_STATUS.RELEASING, updatedAt: at } },
    { new: true },
  );
  return describeReservation(doc ? doc.toObject() : null);
}

/**
 * LIBÈRE le port — uniquement sur PREUVE qu'il n'est plus détenu.
 *
 * Sans preuve, la réservation reste `RELEASING` : le port n'est pas rendu à la
 * plage libre. C'est la règle « aucun recyclage tant que le serveur n'est pas
 * réellement vide », et c'est elle qui empêche la répétition de l'incident.
 *
 * @param {string} targetId
 * @param {object} args
 * @param {boolean} args.verifiedFree  le port a été constaté LIBRE sur le serveur
 * @returns {Promise<{released:boolean, reservation:object|null, reason?:string}>}
 */
export async function releasePort(targetId, { verifiedFree = false, reason = null } = {}) {
  const at = nowIso();
  const courante = await reservationFor(targetId);
  if (!courante) return { released: false, reservation: null, reason: 'aucune réservation vivante' };

  if (verifiedFree !== true) {
    const doc = await PanelPortReservation.findOneAndUpdate(
      { _id: courante._id },
      {
        $set: {
          status: RESERVATION_STATUS.RELEASING,
          lastConflict: { at, kind: 'UNVERIFIED', reason: reason ?? 'libération non prouvée' },
          updatedAt: at,
        },
      },
      { new: true },
    );
    return {
      released: false,
      reservation: describeReservation(doc.toObject()),
      reason: 'le port n’a pas été constaté libre sur le serveur : il reste retenu.',
    };
  }

  const doc = await PanelPortReservation.findOneAndUpdate(
    { _id: courante._id },
    {
      $set: {
        status: RESERVATION_STATUS.RELEASED,
        releasedAt: at,
        lastVerifiedAt: at,
        lastConflict: null,
        pid: null,
        updatedAt: at,
      },
    },
    { new: true },
  );
  return { released: true, reservation: describeReservation(doc.toObject()) };
}

/**
 * ANNULE une réservation qui n'aurait jamais dû exister — rollback.
 *
 * Utilisé quand la création d'une destination échoue APRÈS la réservation :
 * sans cela, un port resterait retenu par une fiche qui n'existe pas, et la
 * plage se viderait à chaque tentative ratée.
 */
export async function rollbackReservation(targetId, { reason = 'création annulée' } = {}) {
  const at = nowIso();
  const res = await PanelPortReservation.findOneAndUpdate(
    { deploymentTargetId: targetId, status: RESERVATION_STATUS.RESERVED },
    {
      $set: {
        status: RESERVATION_STATUS.RELEASED,
        releasedAt: at,
        lastConflict: { at, kind: 'ROLLBACK', reason },
        updatedAt: at,
      },
    },
    { new: true },
  );
  return describeReservation(res ? res.toObject() : null);
}

/**
 * DÉPLACE une réservation vers un autre serveur — quand la destination change
 * de machine.
 *
 * Le port reste le même : le changer casserait la configuration Nginx et le
 * service PM2 s'ils avaient déjà été posés. En revanche la réservation cesse
 * d'être vérifiée : le nouveau serveur n'a jamais été consulté, et c'est la
 * vérification d'avant démarrage qui tranchera. Annoncer une vérification
 * qu'on n'a pas faite serait précisément la faute d'origine.
 */
export async function moveReservationToServer(targetId, serverKey) {
  const at = nowIso();
  const cle = String(serverKey).trim().toLowerCase();
  const courante = await reservationFor(targetId);
  if (!courante || courante.serverKey === cle) return describeReservation(courante);

  try {
    const doc = await PanelPortReservation.findOneAndUpdate(
      { _id: courante._id },
      {
        $set: {
          serverKey: cle,
          lastVerifiedAt: null,
          lastConflict: { at, kind: 'SERVER_CHANGED', from: courante.serverKey, to: cle },
          updatedAt: at,
        },
      },
      { new: true },
    );
    return describeReservation(doc.toObject());
  } catch (err) {
    if (err?.code !== 11000) throw err;
    // Le port est déjà pris sur le nouveau serveur : on rend l'ancien et on
    // en réserve un neuf, plutôt que de laisser deux fiches se le disputer.
    await PanelPortReservation.updateOne({ _id: courante._id }, {
      $set: {
        status: RESERVATION_STATUS.RELEASED, releasedAt: at,
        lastConflict: { at, kind: 'SERVER_CHANGED_CONFLICT', from: courante.serverKey, to: cle },
        updatedAt: at,
      },
    });
    const neuve = await reservePort({
      target: {
        targetId,
        sshHost: cle,
        environment: courante.environment,
        host: courante.host,
        projectIdentityId: courante.projectIdentityId,
      },
    });
    return neuve.reservation;
  }
}

/* -------------------------------------------------------------------------- */
/*  MIGRATION                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * REPRISE DES PORTS EXISTANTS — appelée au démarrage du backend.
 *
 * Chaque destination vivante qui porte déjà un `backendPort` reçoit une
 * réservation correspondante. On ne RÉATTRIBUE rien : le port en place est le
 * bon, puisqu'un service tourne peut-être derrière. Le registre se contente
 * d'enregistrer ce qui est.
 *
 * Une destination VIDÉE reçoit une réservation `RELEASING` et non `RELEASED` :
 * on n'a pas vérifié son serveur au démarrage, et déclarer un port libre sans
 * l'avoir constaté est exactement la faute d'origine.
 */
export async function migratePortRegistry() {
  await ensureIndexes();
  const PanelDeploymentTarget = (await import('../../models/PanelDeploymentTarget.model.js')).default;
  const cibles = await PanelDeploymentTarget.find({
    lifecycleStatus: { $ne: 'DELETED' },
    backendPort: { $ne: null },
    sshHost: { $ne: null },
  }).lean();

  let crees = 0;
  let conflits = 0;
  const at = nowIso();

  for (const cible of cibles) {
    const existante = await PanelPortReservation.findOne({
      deploymentTargetId: cible.targetId, status: { $in: VIVANTES },
    }).lean();
    if (existante) continue;

    const serverKey = String(cible.sshHost).trim().toLowerCase();
    const vide = cible.lifecycleStatus === 'EMPTY';
    try {
      await PanelPortReservation.create({
        serverKey,
        port: cible.backendPort,
        deploymentTargetId: cible.targetId,
        projectIdentityId: cible.projectIdentityId ?? null,
        host: cible.host ?? null,
        environment: cible.environment,
        serviceType: 'backend',
        // Reprise : on n'a rien vérifié, donc rien n'est déclaré ACTIF.
        status: vide ? RESERVATION_STATUS.RELEASING : RESERVATION_STATUS.RESERVED,
        reservedAt: cible.createdAt ?? at,
        lastVerifiedAt: null,
        createdAt: at,
        updatedAt: at,
      });
      crees += 1;
    } catch (err) {
      if (err?.code === 11000) {
        // Deux destinations portent le même port sur le même serveur : c'est
        // EXACTEMENT l'incident. On ne tranche pas à leur place — on le
        // signale, bruyamment, et la vérification d'avant démarrage bloquera.
        conflits += 1;
        logger.warn(`Registre des ports : le port ${cible.backendPort} de « ${cible.host} » `
          + `est déjà réservé sur ${serverKey} par une autre destination. `
          + 'Le prochain déploiement de l’une des deux sera REFUSÉ tant que le conflit dure.');
        continue;
      }
      throw err;
    }
  }

  return { reservationsCreated: crees, conflicts: conflits, targetsScanned: cibles.length };
}

export { ensureIndexes };

export default {
  RESERVATION_STATUS,
  ensureIndexes,
  serverKeyOf,
  liveReservations,
  reservedPorts,
  reservationFor,
  describeReservation,
  describeServerRegistry,
  moveReservationToServer,
  reservePort,
  verifyBeforeStart,
  activateReservation,
  beginRelease,
  releasePort,
  rollbackReservation,
  migratePortRegistry,
};
