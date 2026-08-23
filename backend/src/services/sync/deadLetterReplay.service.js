// REJOUER UNE ÉCRITURE QUE LE PROJET A GARÉE — une republication contrôlée.
//
// docs/architecture/WEBHOOK_CONTROL_PLANE.md §« Rejeu d'une lettre morte ».
//
// ══ CE QUE LE REJEU N'EST PAS ═══════════════════════════════════════════════
//
//   · ce n'est PAS un retour en arrière du curseur. Reculer le curseur
//     relivrerait TOUT ce qui suit l'écriture garée — des centaines
//     d'applications déjà faites, pour en réparer une ;
//   · ce n'est PAS un chemin spécial qui contournerait les applicateurs. Un
//     rejeu qui n'emprunte pas le pipeline normal ne prouve rien de ce que
//     l'on cherche à prouver ;
//   · ce n'est PAS une suppression de la lettre morte. Elle n'est marquée
//     résolue qu'APRÈS que le projet a réellement appliqué.
//
// ══ CE QU'IL EST ════════════════════════════════════════════════════════════
//
//     lettre morte  →  on relit le fait canonique AU JOURNAL DU PANEL
//                   →  on le republie sous une NOUVELLE séquence
//                   →  le projet le tire, l'applique, son curseur avance
//                   →  il résout lui-même la lettre morte, par identité métier
//
// Le fait republié est le MÊME : mêmes `entityType`, `entityId`, `payload`,
// `modifiedAt`. Seule l'identité TECHNIQUE change — un nouveau `writeId`, une
// nouvelle séquence —, parce qu'une écriture déjà dépassée par le curseur ne
// serait jamais reservie sous son ancien identifiant.
//
// ══ POURQUOI `modifiedAt` N'EST PAS RAFRAÎCHI ═══════════════════════════════
//
// Les applicateurs du projet arbitrent au dernier-écrit-gagne sur `modifiedAt`.
// Le rafraîchir ferait gagner un fait ANCIEN contre l'état courant : on
// réparerait un blocage en écrasant une vérité plus récente. Le fait garde donc
// sa date, et s'il est périmé, l'applicateur l'écarte — ce qui est correct.
import crypto from 'node:crypto';

import logger from '../../utils/logger.js';
import ApiError from '../../utils/ApiError.js';
import { PanelSyncJournalEntry } from '../../models/PanelSyncState.model.js';
import PanelDeadLetterReplay, { REPLAY_STATUS } from '../../models/PanelDeadLetterReplay.model.js';
import { registryStore } from '../registry/registryStore.js';
import { emitChange } from './syncCore.service.js';
import { nowIso } from '../../bridge/bridgeContract.js';
import config from '../../config/env.js';

/** Codes de refus — stables, pour l'écran et le diagnostic. */
export const REPLAY_REFUSAL = Object.freeze({
  PROJECT_UNKNOWN: 'PANEL_REPLAY_PROJECT_UNKNOWN',
  PROJECT_NOT_PAIRED: 'PANEL_REPLAY_PROJECT_NOT_PAIRED',
  WRITE_UNKNOWN: 'PANEL_REPLAY_WRITE_UNKNOWN',
  NOT_FOR_THIS_PROJECT: 'PANEL_REPLAY_NOT_FOR_THIS_PROJECT',
  ALREADY_IN_FLIGHT: 'PANEL_REPLAY_ALREADY_IN_FLIGHT',
});

/**
 * REJOUER — idempotent, et l'idempotence est portée par l'index.
 *
 * @param {object} p
 * @param {string} p.projectId
 * @param {string} p.writeId    l'écriture GARÉE, telle que le projet la nomme
 * @param {object} [p.actor]    qui demande — pour la trace, jamais pour l'accès
 * @returns {Promise<object>} la nouvelle livraison
 */
export async function replayDeadLetter({ projectId, writeId, actor = null } = {}) {
  if (!projectId || !writeId) {
    throw ApiError.badRequest(REPLAY_REFUSAL.WRITE_UNKNOWN, 'Projet et écriture sont requis.');
  }

  /**
   * ── LE PROJET DOIT EXISTER ET ÊTRE APPAIRÉ ────────────────────────────────
   *
   * Republier vers un projet désappairé écrirait au journal une entrée que
   * personne ne viendra jamais tirer. Ce n'est pas une réparation, c'est un
   * déchet — et il compterait comme retard pour toujours.
   */
  const fiche = await registryStore.getById(projectId);
  if (!fiche) {
    throw ApiError.notFound(REPLAY_REFUSAL.PROJECT_UNKNOWN, 'Projet inconnu du registre.');
  }
  if (fiche.pairing?.status !== 'PAIRED') {
    throw ApiError.conflict(
      REPLAY_REFUSAL.PROJECT_NOT_PAIRED,
      'Ce projet n’est pas appairé : une republication n’aurait aucun destinataire.',
    );
  }

  /**
   * ── LE FAIT CANONIQUE EST RELU AU JOURNAL — L'AUTORITÉ, PAS UNE COPIE ─────
   *
   * La lettre morte du projet ne conserve ni charge utile ni séquence : elle
   * garde un type, un identifiant et un motif — délibérément, pour ne pas
   * devenir un second entrepôt de données personnelles. Le journal du Panel,
   * lui, garde le fait entier. C'est donc lui qu'on relit.
   */
  const origine = await PanelSyncJournalEntry.findOne({ 'change.writeId': writeId }).lean();
  if (!origine) {
    throw ApiError.notFound(
      REPLAY_REFUSAL.WRITE_UNKNOWN,
      'Aucune écriture de ce nom au journal : elle n’a jamais été émise par ce Panel.',
    );
  }

  /**
   * ── ELLE DOIT ÊTRE ADRESSÉE À CE PROJET ──────────────────────────────────
   *
   * `audience: null` est une diffusion à tout le parc : la republier vers un
   * seul projet est légitime — c'est lui qui l'a garée. Une écriture NOMMÉE
   * pour un autre projet, en revanche, ne doit jamais atterrir ici : ce serait
   * exactement le chemin par lequel un opérateur ferait fuiter la donnée d'un
   * client vers un autre.
   */
  if (origine.audience !== null && origine.audience !== projectId) {
    throw ApiError.conflict(
      REPLAY_REFUSAL.NOT_FOR_THIS_PROJECT,
      'Cette écriture est nommément destinée à un autre projet.',
    );
  }

  const precedents = await PanelDeadLetterReplay.countDocuments({ projectId, replayOfWriteId: writeId });

  /**
   * ══ ON RÉSERVE AVANT DE PUBLIER, ET C'EST L'ORDRE QUI COMPTE ═════════════
   *
   * La première version publiait puis écrivait la trace, en laissant l'index
   * unique refuser la seconde. Le double clic rendait bien UN seul rejeu
   * logique — mais DEUX entrées au journal, la perdante partant quand même
   * vers le projet. Mesuré sur la pile déployée : `EN ATTENTE 2` pour un seul
   * geste, et trois applications au lieu de deux.
   *
   * Inoffensif — les applicateurs sont idempotents — mais faux : un opérateur
   * qui clique deux fois ne demande pas deux livraisons. On réserve donc la
   * trace D'ABORD. Le perdant est refusé AVANT d'avoir publié quoi que ce
   * soit, et il n'y a jamais qu'une entrée au journal.
   */
  const replayId = crypto.randomUUID();
  const demandeA = nowIso();
  try {
    await PanelDeadLetterReplay.create({
      replayId,
      projectId,
      replayOfWriteId: writeId,
      replayOfSeq: origine.seq ?? null,
      /**
       * L'identité de la republication n'existe pas encore : la réservation
       * porte des valeurs provisoires, remplacées dès l'émission faite. Les
       * laisser vides ferait échouer la validation du modèle, et un modèle
       * permissif « le temps de la réservation » finirait par tolérer une
       * trace sans republication.
       */
      newWriteId: `en-attente:${replayId}`,
      newSeq: -1,
      entityType: origine.change.entityType,
      entityId: origine.change.entityId,
      attempt: precedents + 1,
      status: REPLAY_STATUS.REPUBLISHED,
      requestedAt: demandeA,
      requestedBy: actor?.userEmail ?? actor?.userId ?? null,
    });
  } catch (err) {
    if (err?.code === 11000) {
      const enVol = await PanelDeadLetterReplay
        .findOne({ projectId, replayOfWriteId: writeId, status: REPLAY_STATUS.REPUBLISHED })
        .lean();
      throw ApiError.conflict(
        REPLAY_REFUSAL.ALREADY_IN_FLIGHT,
        'Un rejeu de cette écriture est déjà en vol : attendez qu’il soit consommé.',
        { replayId: enVol?.replayId ?? null, newSeq: enVol?.newSeq ?? null },
      );
    }
    throw err;
  }

  /**
   * ── LA REPUBLICATION ──────────────────────────────────────────────────────
   *
   * `audience` est FORCÉE au projet demandeur, même si l'originale était une
   * diffusion : on répare le blocage d'UN projet, pas de tout le parc. Les
   * autres, s'ils l'ont appliquée, n'ont rien à recevoir.
   */
  let nouvelle;
  try {
    nouvelle = await emitChange({
      entityType: origine.change.entityType,
      entityId: origine.change.entityId,
      deleted: origine.change.deleted === true,
      payload: origine.change.payload ?? null,
      modifiedAt: origine.change.modifiedAt,
      audience: projectId,
    });
  } catch (err) {
    /**
     * L'ÉMISSION A ÉCHOUÉ — on retire la réservation.
     *
     * La laisser bloquerait tout rejeu futur de cette écriture, pour une
     * republication qui n'a jamais eu lieu. Une réservation qui survit à son
     * échec est un verrou orphelin.
     */
    await PanelDeadLetterReplay.deleteOne({ replayId }).catch(() => null);
    throw err;
  }

  await PanelDeadLetterReplay.updateOne(
    { replayId },
    { $set: { newWriteId: nouvelle.change.writeId, newSeq: nouvelle.seq } },
  );

  logger.info(
    `[replay] ${projectId} : ${origine.change.entityType}/${origine.change.entityId} republié `
    + `(seq ${origine.seq ?? '?'} → ${nouvelle.seq}, tentative ${precedents + 1}).`,
  );

  return describeReplay({
    replayId,
    projectId,
    replayOfWriteId: writeId,
    replayOfSeq: origine.seq ?? null,
    newWriteId: nouvelle.change.writeId,
    newSeq: nouvelle.seq,
    entityType: origine.change.entityType,
    entityId: origine.change.entityId,
    attempt: precedents + 1,
    status: REPLAY_STATUS.REPUBLISHED,
    requestedAt: demandeA,
  });
}

/**
 * ══ LE SEUIL D'ENLISEMENT — 20 MINUTES, ET VOICI POURQUOI ═══════════════
 *
 * Mesures réelles sur la pile déployée :
 *
 *   cadence de tirage observée     ~35 s entre l'émission et l'acquittement
 *   redémarrage complet d'un projet ~2 à 4 min (déploiement, services.start)
 *   coupure réseau passagère        quelques cycles de tirage
 *
 * 20 minutes valent donc environ TRENTE-QUATRE cycles de tirage : un projet
 * sain ne peut pas les manquer tous. Les deux bornes comptent :
 *
 *   trop COURT  →  un projet en cours de redéploiement est déclaré enlisé, et
 *                  l'opérateur rejoue une écriture qui allait arriver seule.
 *   trop LONG   →  une écriture métier reste absente une demi-journée sans que
 *                  personne ne puisse agir, la trace en vol bloquant tout
 *                  nouveau rejeu.
 */
export const REPLAY_STALL_AFTER_MS = config.replayStallAfterMs;

/**
 * ══ LA CONVERGENCE D'UN REJEU — AUTONOME, ET C'EST TOUT LE LOT ═══════════
 *
 * ── OÙ ELLE SE FAISAIT, ET POURQUOI C'ÉTAIT UN DÉFAUT ───────────────────
 *
 * À LA LECTURE de la fiche projet. Un rejeu ne passait donc `ACKNOWLEDGED` que
 * si quelqu'un ouvrait un écran — et tant qu'il ne le faisait pas, l'index
 * d'unicité interdisait tout nouveau rejeu de la même écriture.
 *
 * Une lecture qui MUTE est un piège de deux façons : l'état dépend de
 * l'attention d'un humain, et la consultation cesse d'être gratuite. Une
 * consultation doit être purement observatrice.
 *
 * ── OÙ ELLE SE FAIT MAINTENANT ───────────────────────────────────
 *
 * AU BATTEMENT, après la persistance du curseur déclaré. C'est le seul canal
 * qui parle en permanence, il porte déjà l'information, et il n'a besoin de
 * personne. Aucun minuteur parallèle n'a été créé : en créer un aurait
 * dupliqué une cadence qui existe.
 *
 * ── STRICTEMENT IDEMPOTENTE ────────────────────────────────────
 *
 * Les filtres portent sur l'ÉTAT DE DÉPART. Dix battements avec un curseur
 * déjà dépassé ne trouvent plus rien à changer : une seule transition
 * logique, un seul `acknowledgedAt`, aucune écriture inutile.
 *
 * @returns {Promise<{acknowledged: number, stalled: number}>}
 */
export async function settleAcknowledgedReplays({ projectId, cursorSeq, now = Date.now() }) {
  if (!projectId) return { acknowledged: 0, stalled: 0 };

  const acquittes = Number.isFinite(cursorSeq)
    ? await PanelDeadLetterReplay.updateMany(
      {
        projectId,
        status: REPLAY_STATUS.REPUBLISHED,
        newSeq: { $lte: cursorSeq, $gt: 0 },
      },
      { $set: { status: REPLAY_STATUS.ACKNOWLEDGED, acknowledgedAt: new Date(now).toISOString() } },
    )
    : { modifiedCount: 0 };

  /**
   * L'ENLISEMENT SE CONSTATE APRÈS L'ACQUITTEMENT, ET PAS AVANT.
   *
   * Un rejeu que le battement vient d'acquitter ne doit pas être déclaré
   * enlisé dans le même passage parce qu'il est vieux : il vient d'arriver.
   * L'ordre évite un état qui clignoterait entre deux battements.
   */
  const limite = new Date(now - REPLAY_STALL_AFTER_MS).toISOString();
  const enlises = await PanelDeadLetterReplay.updateMany(
    { projectId, status: REPLAY_STATUS.REPUBLISHED, requestedAt: { $lte: limite } },
    { $set: { status: REPLAY_STATUS.STALLED, stalledAt: new Date(now).toISOString() } },
  );

  const n = acquittes?.modifiedCount ?? 0;
  const m = enlises?.modifiedCount ?? 0;
  if (m > 0) {
    logger.warn(
      `[replay] ${projectId} : ${m} rejeu(x) ENLISÉ(S) — republiés depuis plus de `
      + `${Math.round(REPLAY_STALL_AFTER_MS / 60_000)} min sans être consommés. `
      + 'Aucun rejeu automatique : un opérateur décide.',
    );
  }
  return { acknowledged: n, stalled: m };
}

/** Les rejeux d'un projet — pour l'écran. Jamais la charge utile. */
export async function listReplays({ projectId, limit = 50 } = {}) {
  const lignes = await PanelDeadLetterReplay.find({ projectId })
    .sort({ requestedAt: -1 }).limit(limit).lean();
  return lignes.map(describeReplay);
}

/** Projection SÛRE — ce qui va à l'écran, et rien d'autre. */
export function describeReplay(r) {
  return {
    replayId: r.replayId,
    projectId: r.projectId,
    replayOfWriteId: r.replayOfWriteId,
    replayOfSeq: r.replayOfSeq ?? null,
    newWriteId: r.newWriteId,
    newSeq: r.newSeq,
    entityType: r.entityType ?? null,
    entityId: r.entityId ?? null,
    attempt: r.attempt ?? 1,
    status: r.status,
    requestedAt: r.requestedAt,
    requestedBy: r.requestedBy ?? null,
    acknowledgedAt: r.acknowledgedAt ?? null,
    /** Daté SEULEMENT si le rejeu n'est jamais arrivé : l'écran le dit, sans le calculer. */
    stalledAt: r.stalledAt ?? null,
  };
}

export default { replayDeadLetter, settleAcknowledgedReplays, listReplays, REPLAY_REFUSAL };
