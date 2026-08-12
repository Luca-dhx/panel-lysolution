/**
 * JUSTIFICATIFS — le rattachement d'un document privé à un mouvement.
 *
 * ══ CE MODULE NE STOCKE RIEN ════════════════════════════════════════════════
 *
 * Il n'écrit aucun fichier, ne calcule aucune empreinte, ne nomme aucun objet.
 * Tout cela appartient au protocole Media (`privateMedia.service.js`), qui le
 * fait déjà pour l'ensemble du Panel. Ce module fait exactement deux choses :
 *
 *   1. il DÉCIDE qui a le droit de déposer ou de lire — parce que cette
 *      décision dépend de la transaction, et d'elle seule ;
 *   2. il RELIE un `mediaId` à un mouvement.
 *
 * C'est la frontière qui permettra à une facture client ou à un contrat de
 * réutiliser le même stockage privé sans hériter des règles d'accès des
 * finances.
 *
 * ══ POURQUOI L'ADRESSE DE LECTURE PASSE PAR LA TRANSACTION ══════════════════
 *
 * On aurait pu exposer `/api/media/private/:mediaId`. C'eût été une surface
 * dont l'autorisation ne peut venir que d'une table d'ACL parallèle : le média,
 * seul, ne sait pas à qui il appartient.
 *
 * En passant par `/api/finances/transactions/:id/receipt`, le CHEMIN porte le
 * contexte : on charge la transaction, on vérifie que le média demandé est bien
 * LE SIEN, et l'autorisation devient une conséquence de l'objet métier. Un
 * `mediaId` volé sur une autre transaction ne mène nulle part — c'est ce que
 * vérifie `assertBelongsTo`.
 */
import ApiError from '../../utils/ApiError.js';
import { PanelFinancialTransaction } from '../../models/PanelFinancialTransaction.model.js';
import PanelMedia from '../../models/PanelMedia.model.js';
import { EVENT_TYPES } from '../../models/PanelSupervision.model.js';
import { recordEvent } from '../supervision/timeline.service.js';
import logger from '../../utils/logger.js';
import {
  deletePrivateMedia, privateDescriptorOf, readPrivateMedia, storePrivateDocument,
} from '../upload/privateMedia.service.js';

/**
 * LA PORTÉE MÉTIER de ces documents dans le protocole Media.
 *
 * Elle sert à les distinguer des logos et portraits dans la collection
 * commune : même protocole, familles séparées. Un futur `PROJECT_CONTRACT`
 * ou `CLIENT_INVOICE` s'ajoutera de la même façon.
 */
export const RECEIPT_SCOPE = 'FINANCIAL_RECEIPT';

/** Le rôle documentaire — il choisit la politique de taille et de types. */
export const RECEIPT_ROLE = 'receipt';

async function loadTransactionOrThrow(transactionId) {
  const document = await PanelFinancialTransaction.findOne({ transactionId });
  if (!document) {
    throw ApiError.notFound('PANEL_FINANCE_TRANSACTION_NOT_FOUND', 'Mouvement introuvable.');
  }
  return document;
}

/**
 * ATTACHE un justificatif — ou REMPLACE celui qui s'y trouve.
 *
 * ══ LE REMPLACEMENT NE DÉTRUIT PAS L'ANCIEN ═════════════════════════════════
 *
 * L'ancien média est marqué supprimé et son fichier retiré, mais son
 * descripteur SURVIT : on saura toujours qu'une pièce a été remplacée, quand,
 * et par qui. Effacer le descripteur ferait disparaître le fait lui-même.
 *
 * ══ ORDRE DES OPÉRATIONS ════════════════════════════════════════════════════
 *
 * On écrit le nouveau média AVANT de détacher l'ancien, et l'on ne détache
 * l'ancien qu'une fois le nouveau réellement lié. Un échec en cours laisse donc
 * au pire un média orphelin — invisible et inoffensif — jamais une transaction
 * qui aurait perdu sa pièce sans en avoir reçu de nouvelle.
 */
export async function attachReceipt(transactionId, { buffer, filename }, actor = {}) {
  const transaction = await loadTransactionOrThrow(transactionId);

  /**
   * UN MOUVEMENT SUPPRIMÉ N'ACCUEILLE PLUS DE PIÈCE.
   *
   * Il reste auditable, et son justificatif éventuel reste lisible — mais lui
   * en ajouter un nouveau reviendrait à documenter une ligne qui ne compte
   * plus. Le refus est explicite plutôt que silencieux.
   */
  if (transaction.deletedAt) {
    throw ApiError.conflict(
      'PANEL_FINANCE_TRANSACTION_DELETED',
      'Ce mouvement est supprimé : on ne lui attache plus de justificatif. '
      + 'Le justificatif déjà présent, lui, reste consultable.',
    );
  }

  const ancien = transaction.receipt?.mediaId ?? null;

  const media = await storePrivateDocument({
    buffer,
    scope: RECEIPT_SCOPE,
    role: RECEIPT_ROLE,
    filename,
    createdBy: actor.email ?? null,
  });

  transaction.receipt = {
    mediaId: media.mediaId,
    attachedAt: new Date(),
    attachedBy: actor.email ?? null,
  };
  transaction.updatedBy = actor.email ?? null;
  await transaction.save();

  if (ancien && ancien !== media.mediaId) {
    await deletePrivateMedia(ancien, { deletedBy: actor.email ?? null }).catch((err) => {
      // L'ancien fichier resté sur le disque est un résidu, pas un incident :
      // il n'est plus référencé et ne sortira par aucune route.
      logger.warn(`[finance] Ancien justificatif ${ancien} non retiré : ${err.message}`);
    });
  }

  await journal(transaction, actor, {
    summary: ancien
      ? `Justificatif remplacé sur « ${transaction.label} ».`
      : `Justificatif attaché à « ${transaction.label} ».`,
    extra: { mediaId: media.mediaId, replaced: Boolean(ancien), mime: media.mime, size: media.size },
  });

  return { transaction, receipt: privateDescriptorOf(media) };
}

/**
 * VÉRIFIE QUE CE MÉDIA EST BIEN CELUI DE CETTE TRANSACTION.
 *
 * C'est l'unique barrière contre la lecture croisée : sans elle, connaître un
 * `mediaId` suffirait à lire la facture d'un autre projet en la demandant par
 * l'adresse d'une transaction qu'on a le droit de voir.
 */
function assertBelongsTo(transaction, mediaId) {
  const attendu = transaction.receipt?.mediaId ?? null;
  if (!attendu) {
    throw ApiError.notFound(
      'PANEL_FINANCE_RECEIPT_ABSENT',
      'Aucun justificatif n’est attaché à ce mouvement.',
    );
  }
  if (mediaId && mediaId !== attendu) {
    throw ApiError.notFound(
      'PANEL_FINANCE_RECEIPT_MISMATCH',
      'Ce document n’est pas le justificatif de ce mouvement.',
    );
  }
  return attendu;
}

/**
 * LIT le justificatif d'un mouvement — octets compris.
 *
 * ══ UN MOUVEMENT SUPPRIMÉ GARDE SON JUSTIFICATIF LISIBLE ════════════════════
 *
 * Un cycle annulé par un « arrêt actuel » sort des totaux ; sa facture reste la
 * pièce qui explique pourquoi il a existé. La rendre illisible en même temps
 * détruirait exactement la piste qu'on suivra le jour où l'on demandera ce
 * qu'est devenu ce mois-là.
 */
export async function readReceipt(transactionId, { mediaId = null } = {}) {
  const transaction = await loadTransactionOrThrow(transactionId);
  const attendu = assertBelongsTo(transaction, mediaId);
  const { media, buffer } = await readPrivateMedia(attendu);
  return { transaction, media, buffer };
}

/** Le descripteur du justificatif, sans les octets — pour les écrans. */
export async function describeReceipt(transaction) {
  const mediaId = transaction?.receipt?.mediaId;
  if (!mediaId) return null;
  const media = await PanelMedia.findOne({ mediaId }).lean();
  if (!media || media.deletedAt) return null;
  return {
    ...privateDescriptorOf(media),
    attachedAt: transaction.receipt.attachedAt
      ? new Date(transaction.receipt.attachedAt).toISOString()
      : null,
    attachedBy: transaction.receipt.attachedBy ?? null,
  };
}

/**
 * RETIRE le justificatif d'un mouvement.
 *
 * Geste EXPLICITE, jamais une cascade : rien dans la suppression d'une
 * transaction, l'arrêt d'une récurrence ou la révision d'un montant n'appelle
 * cette fonction. C'est la garantie que la pièce survit à tout ce qui n'est pas
 * une décision de la retirer.
 */
export async function detachReceipt(transactionId, actor = {}) {
  const transaction = await loadTransactionOrThrow(transactionId);
  const mediaId = transaction.receipt?.mediaId ?? null;
  if (!mediaId) return { transaction, detached: false };

  transaction.receipt = { mediaId: null, attachedAt: null, attachedBy: null };
  transaction.updatedBy = actor.email ?? null;
  await transaction.save();

  await deletePrivateMedia(mediaId, { deletedBy: actor.email ?? null }).catch((err) => {
    logger.warn(`[finance] Justificatif ${mediaId} non retiré du disque : ${err.message}`);
  });

  await journal(transaction, actor, {
    severity: 'WARNING',
    summary: `Justificatif retiré de « ${transaction.label} ».`,
    extra: { mediaId, detached: true },
  });

  return { transaction, detached: true };
}

/**
 * COMPLÈTE la chronologie. La preuve DURABLE, elle, vit sur les documents :
 * `receipt.attachedAt/By` sur la transaction, et le descripteur `PanelMedia`
 * — qui survit à la suppression du fichier et n'est jamais purgé.
 */
async function journal(transaction, actor, { severity = 'INFO', summary, extra = {} } = {}) {
  try {
    await recordEvent({
      projectId: transaction.projectId ?? null,
      type: EVENT_TYPES.FINANCIAL_TRANSACTION_UPDATED,
      source: 'PANEL',
      severity,
      summary,
      data: {
        receipt: true,
        transactionId: transaction.transactionId,
        actor: actor.email ?? null,
        ...extra,
      },
    });
  } catch (err) {
    logger.warn(`[finance] Chronologie indisponible (justificatif) : ${err.message}`);
  }
}

export default {
  RECEIPT_SCOPE,
  RECEIPT_ROLE,
  attachReceipt,
  readReceipt,
  describeReceipt,
  detachReceipt,
};
