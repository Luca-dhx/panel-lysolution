// LES RÉSERVATIONS BLOQUÉES — et le geste qui les débloque (R10.5C).
//
// ══ POURQUOI CET ÉCRAN EXISTE ═══════════════════════════════════════════════
//
// Ouvrir une signature réserve le contrat AVANT d'appeler Yousign. Sur une
// issue INDÉTERMINÉE — délai dépassé, fournisseur muet — la réservation n'est
// PAS libérée : la demande a peut-être été créée, et libérer le contrat
// autoriserait une seconde ouverture, donc une seconde sollicitation d'un
// signataire réel.
//
// C'est le bon arbitrage, et il a une conséquence qu'il faut assumer : le
// contrat reste verrouillé jusqu'à ce qu'un humain tranche. Sans cet écran, ce
// verrou serait invisible — un contrat « qui ne veut plus démarrer », sans
// message, sans trace, et sans moyen de le débloquer autrement qu'en base.
//
// ══ CE QUE CET ÉCRAN NE FAIT PAS ════════════════════════════════════════════
//
// Il ne rejoue rien, il n'appelle pas Yousign, et il ne devine pas. Trancher
// « la demande a-t-elle été créée ? » suppose de regarder le compte Yousign, et
// c'est un travail humain. L'outil se contente de MONTRER ce qui est bloqué et
// de permettre de le libérer en connaissance de cause — avec une trace.
//
// ══ POURQUOI LA LIBÉRATION EST AUDITÉE ══════════════════════════════════════
//
// Elle autorise une seconde ouverture. Si la première avait abouti sans qu'on
// le sache, le signataire recevra deux demandes — et quelqu'un devra pouvoir
// répondre à « qui a débloqué, quand, et pourquoi ». Un geste réversible se
// journalise ; celui-ci ne l'est pas.
import ApiError from '../../../utils/ApiError.js';
import logger from '../../../utils/logger.js';
import { nowIso } from '../../../bridge/bridgeContract.js';
import PanelSignatureBinding from '../../../models/PanelSignatureBinding.model.js';
import { recordEvent, EVENT_TYPES } from '../../supervision/timeline.service.js';
import { maskResourceId } from './signatureOwnership.js';

/**
 * Une réservation est « bloquée » quand elle n'a jamais reçu son identifiant
 * Yousign — donc quand l'appel n'a pas abouti de façon connue.
 *
 * Le marqueur est le préfixe `pending:` posé à la réservation. Il n'y a pas de
 * champ « bloqué » séparé, délibérément : un état dérivé ne peut pas mentir,
 * là où un drapeau écrit à part finit par diverger de la réalité.
 */
const PENDING_PREFIX = 'pending:';

/** Depuis combien de temps une réservation doit-elle traîner pour être suspecte ? */
const STALE_AFTER_MS = 5 * 60 * 1000;

function isPending(binding) {
  return String(binding?.resourceId ?? '').startsWith(PENDING_PREFIX);
}

/**
 * Les réservations en attente, éventuellement filtrées par projet.
 *
 * `staleFor` est rendu pour que l'écran distingue une ouverture EN COURS (deux
 * secondes) d'une réservation abandonnée (deux jours) — sans quoi un opérateur
 * verrait dans la même liste une opération saine et un incident.
 */
export async function listPendingReservations({ projectId = null, now = Date.now() } = {}) {
  const filter = { closedAt: null, resourceId: new RegExp(`^${PENDING_PREFIX}`) };
  if (projectId) filter.projectId = projectId;

  const rows = await PanelSignatureBinding.find(filter).sort({ createdAt: 1 }).lean();
  return rows.map((b) => {
    const since = Date.parse(b.createdAt);
    const ageMs = Number.isFinite(since) ? now - since : null;
    return {
      projectId: b.projectId,
      environment: b.environment,
      contractRef: b.contractRef,
      operationId: b.createdByOperationId,
      createdAt: b.createdAt,
      ageMs,
      /**
       * Le verdict d'ANCIENNETÉ, pas un verdict d'incident : on ne sait pas si
       * la demande existe chez Yousign, et l'écran ne doit pas le prétendre.
       */
      stale: ageMs !== null && ageMs > STALE_AFTER_MS,
    };
  });
}

/**
 * Libère une réservation bloquée — geste d'exploitation, DEV uniquement.
 *
 * ── CE QUE L'OPÉRATEUR AUTORISE EN CLIQUANT ─────────────────────────────────
 *
 * Une nouvelle ouverture pour ce contrat. Si la demande d'origine avait en fait
 * abouti chez Yousign, le signataire en recevra une seconde. C'est pourquoi le
 * motif est OBLIGATOIRE : il force à écrire ce qu'on a vérifié avant de
 * trancher, et c'est ce texte qu'on relira si un signataire se plaint.
 */
export async function releaseReservation({ operationId, actor = {}, reason }) {
  const motif = String(reason ?? '').trim();
  if (!motif) {
    throw ApiError.badRequest(
      'PANEL_SIGNATURE_RELEASE_REASON_REQUIRED',
      'Un motif est requis : débloquer autorise une seconde demande de signature, '
      + 'et la trace doit dire ce qui a été vérifié.',
    );
  }

  const binding = await PanelSignatureBinding.findOne({ createdByOperationId: operationId }).lean();
  if (!binding) {
    throw ApiError.notFound(
      'PANEL_SIGNATURE_RESERVATION_UNKNOWN',
      'Aucune réservation sous cet identifiant d’opération.',
    );
  }
  if (!isPending(binding)) {
    /**
     * La réservation a abouti depuis : elle porte un vrai identifiant Yousign.
     * La supprimer effacerait le lien d'appartenance d'une demande VIVANTE, et
     * son webhook ne retrouverait plus son projet.
     */
    throw ApiError.conflict(
      'PANEL_SIGNATURE_RESERVATION_NOT_PENDING',
      'Cette réservation a abouti : elle porte une demande réelle et ne peut pas être libérée. '
      + 'Utilisez l’annulation de signature si la demande doit être interrompue.',
    );
  }

  await PanelSignatureBinding.deleteOne({ createdByOperationId: operationId });

  logger.warn(
    `[signature] réservation libérée à la main — projet ${binding.projectId}, `
    + `contrat ${binding.contractRef}, opération ${maskResourceId(operationId)}`
    + `${actor.userEmail ? ` par ${actor.userEmail}` : ''}.`,
  );

  await recordEvent({
    projectId: binding.projectId,
    type: EVENT_TYPES.CAPABILITY_REFUSED,
    source: 'PANEL',
    /**
     * `WARNING`, et non `INFO` : ce geste autorise une seconde sollicitation
     * juridique. Le ranger avec les faits ordinaires le rendrait invisible dans
     * la chronologie, c'est-à-dire introuvable le jour où on le cherche.
     */
    severity: 'WARNING',
    summary: `Réservation de signature libérée manuellement (contrat ${binding.contractRef}).`,
    data: {
      capability: 'signature.request.open',
      contractRef: binding.contractRef,
      environment: binding.environment,
      operationId,
      reason: motif.slice(0, 500),
      actor: actor.userId ?? null,
      at: nowIso(),
    },
  }).catch(() => {});

  return { released: true, contractRef: binding.contractRef, projectId: binding.projectId };
}

export default { listPendingReservations, releaseReservation };
