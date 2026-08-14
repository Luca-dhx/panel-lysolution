// APPARTENANCE D'UNE SIGNATURE — « cette demande est-elle à ce projet ? » (R10.5C).
//
// docs/R10_5_FINAL_EMAIL_AND_YOUSIGN_CONTROL_PLANE_REPORT.md §4.
//
// ══ LE PIÈGE QUE CE MODULE FERME ════════════════════════════════════════════
//
//   UN CREDENTIAL GLOBAL N'EST PAS UN ACCÈS GLOBAL.
//
// Le compte Yousign du Panel porte les demandes de TOUS les clients. Une
// capacité qui accepterait un `signatureRequestId` quelconque donnerait à
// n'importe quel projet appairé le droit de lire — ou d'annuler — la signature
// d'un autre. Sur un objet juridique, cela dépasse la fuite de données : c'est
// la capacité d'interrompre l'engagement d'un tiers.
//
// C'est la même leçon qu'au lot L9 pour le DNS, transposée à un objet qui
// engage des personnes plutôt qu'un domaine.
//
// ══ D'OÙ VIENT LA VÉRITÉ ════════════════════════════════════════════════════
//
// De `PanelSignatureBinding`, écrit par le Panel AVANT tout appel fournisseur.
// PAS de l'identifiant que le projet envoie : un demandeur ne prouve jamais son
// droit en nommant la ressource qu'il convoite.
//
// ══ ET L'ORDRE COMPTE AUTANT QUE LA RÈGLE ═══════════════════════════════════
//
// La vérification a lieu AVANT l'ouverture du coffre. C'est ce qui rend
// « aucun contact fournisseur sur refus » vrai par construction, et non par
// accident : une ressource étrangère est refusée sans qu'aucune clé n'ait été
// déchiffrée.
import PanelSignatureBinding, {
  SIGNATURE_RESOURCE_TYPES,
  SIGNATURE_BINDING_SOURCES,
} from '../../../models/PanelSignatureBinding.model.js';
import { nowIso } from '../../../bridge/bridgeContract.js';

/** Pourquoi une demande est refusée. Codes fermés — l'écran les traduit. */
export const SIGNATURE_OWNERSHIP_CODES = Object.freeze({
  OK: 'OK',
  /** Aucun lien : l'identifiant est inconnu du Panel (inventé, ou d'un autre monde). */
  UNKNOWN_RESOURCE: 'SIGNATURE_RESOURCE_UNKNOWN',
  /** Le lien existe, mais il appartient à un autre projet. */
  NOT_OWNED: 'SIGNATURE_RESOURCE_NOT_OWNED',
  /** L'identifiant est syntaxiquement inexploitable. */
  INVALID_RESOURCE_ID: 'SIGNATURE_RESOURCE_ID_INVALID',
});

/**
 * Un identifiant Yousign plausible.
 *
 * Volontairement large : Yousign rend des UUID, et se montrer plus précis que
 * le fournisseur ferait échouer un appel légitime le jour où sa forme change.
 * Le rôle de ce contrôle n'est pas d'authentifier — c'est le lien qui le fait —
 * mais d'écarter une chaîne vide ou manifestement absurde avant la base.
 */
const RESOURCE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{7,63}$/;

export function looksLikeSignatureResource(resourceId) {
  return RESOURCE_ID_RE.test(String(resourceId ?? ''));
}

/**
 * Masque un identifiant pour un JOURNAL.
 *
 * Il n'est pas secret — mais il désigne une signature, donc un contrat, donc
 * des personnes. Un journal d'exploitation n'a pas besoin de la valeur entière
 * pour être utile.
 */
export function maskResourceId(resourceId) {
  const value = String(resourceId ?? '');
  if (value.length <= 8) return '…';
  return `${value.slice(0, 4)}…${value.slice(-4)}`;
}

/* -------------------------------------------------------------------------- */
/*  ÉCRITURE DU LIEN                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Réserve l'ouverture d'une signature pour un contrat — AVANT tout appel.
 *
 * ── POURQUOI CETTE RÉSERVATION EXISTE, EN PLUS DU REGISTRE D'OPÉRATIONS ─────
 *
 * Le registre d'opérations empêche deux exécutions de la MÊME opération. Cette
 * réservation empêche deux opérations DIFFÉRENTES d'ouvrir deux demandes pour
 * le même contrat — le cas d'un opérateur qui clique, échoue, et reclique avec
 * une nouvelle clé d'idempotence.
 *
 * L'index partiel `signature_open_request_per_contract` arbitre en base : la
 * seconde insertion échoue, et l'appelant reçoit le lien existant plutôt qu'une
 * seconde sollicitation d'un signataire réel.
 *
 * @returns {Promise<{claimed: boolean, binding: object}>}
 *   `claimed: false` ⇒ une demande vivante existait déjà pour ce contrat.
 */
export async function claimSignatureRequest({
  projectId, environment, contractRef, operationId,
}) {
  const existing = await PanelSignatureBinding.findOne({
    projectId, environment, contractRef, closedAt: null,
  }).lean();
  if (existing) return { claimed: false, binding: existing };

  try {
    const created = await PanelSignatureBinding.create({
      projectId,
      environment,
      resourceType: SIGNATURE_RESOURCE_TYPES.REQUEST,
      /**
       * L'identifiant Yousign n'existe PAS encore — il naîtra de l'appel. On
       * pose une valeur de réservation dérivée de l'opération : elle occupe la
       * place, respecte l'unicité, et sera remplacée à l'acceptation.
       *
       * Sans elle, il faudrait écrire le lien APRÈS l'appel — et la fenêtre
       * entre l'appel et l'écriture est exactement celle où un crash laisse une
       * demande Yousign sans propriétaire connu.
       */
      resourceId: `pending:${operationId}`,
      contractRef,
      source: SIGNATURE_BINDING_SOURCES.CREATED,
      createdByOperationId: operationId,
      createdAt: nowIso(),
    });
    return { claimed: true, binding: created.toObject() };
  } catch (error) {
    // 11000 : une insertion concurrente a gagné. On rend la sienne.
    if (error?.code !== 11000) throw error;
    const winner = await PanelSignatureBinding.findOne({
      projectId, environment, contractRef, closedAt: null,
    }).lean();
    return { claimed: false, binding: winner };
  }
}

/**
 * Attache l'identifiant RÉEL rendu par Yousign à une réservation.
 *
 * Appelé une fois l'appel accepté. C'est le moment où la réservation devient un
 * lien véritable, et où le webhook pourra retrouver le projet.
 */
export async function attachResource({ operationId, resourceId, documentId = null }) {
  await PanelSignatureBinding.updateOne(
    { createdByOperationId: operationId },
    { $set: { resourceId, ...(documentId ? { documentId } : {}) } },
  );
  return PanelSignatureBinding.findOne({ createdByOperationId: operationId }).lean();
}

/**
 * Libère une réservation dont l'appel n'a PAS abouti.
 *
 * ── POURQUOI SEULEMENT SUR UN ÉCHEC CERTAIN ─────────────────────────────────
 *
 * Une réservation abandonnée sur une issue INDÉTERMINÉE serait un piège : la
 * demande a peut-être été créée chez Yousign, et libérer le contrat
 * autoriserait une seconde ouverture — donc le doublon qu'on évite.
 *
 * On ne libère donc que ce qui n'a jamais atteint le fournisseur.
 */
export async function releaseClaim({ operationId }) {
  await PanelSignatureBinding.deleteOne({
    createdByOperationId: operationId,
    resourceId: `pending:${operationId}`,
  });
}

/** Marque une demande close — sans jamais rompre le lien d'appartenance. */
export async function closeBinding({ environment, resourceId, reason = null }) {
  await PanelSignatureBinding.updateOne(
    { environment, resourceId },
    { $set: { closedAt: nowIso(), closedReason: reason } },
  );
}

/* -------------------------------------------------------------------------- */
/*  LECTURE ET GARDE                                                          */
/* -------------------------------------------------------------------------- */

/** Le lien d'une ressource, ou `null`. Ne lève jamais. */
export async function findBinding({ environment, resourceId }) {
  if (!looksLikeSignatureResource(resourceId)) return null;
  return PanelSignatureBinding.findOne({
    environment,
    resourceType: SIGNATURE_RESOURCE_TYPES.REQUEST,
    resourceId,
  }).lean();
}

/**
 * Vue de l'appartenance, SANS lever — pour un diagnostic.
 *
 * @returns {Promise<{owned: boolean, code: string, binding: object|null}>}
 */
export async function describeOwnership({ projectId, environment, resourceId }) {
  if (!looksLikeSignatureResource(resourceId)) {
    return { owned: false, code: SIGNATURE_OWNERSHIP_CODES.INVALID_RESOURCE_ID, binding: null };
  }
  const binding = await findBinding({ environment, resourceId });
  if (!binding) {
    return { owned: false, code: SIGNATURE_OWNERSHIP_CODES.UNKNOWN_RESOURCE, binding: null };
  }
  if (binding.projectId !== projectId) {
    /**
     * On ne dit PAS « elle appartient à un autre projet » à l'appelant : le
     * code est distinct pour NOTRE journal, mais le message rendu au projet
     * doit être indiscernable d'un identifiant inconnu. Sinon la capacité
     * devient un oracle d'existence — « cet identifiant existe-t-il ailleurs ? ».
     */
    return { owned: false, code: SIGNATURE_OWNERSHIP_CODES.NOT_OWNED, binding: null };
  }
  return { owned: true, code: SIGNATURE_OWNERSHIP_CODES.OK, binding };
}

export default {
  SIGNATURE_OWNERSHIP_CODES,
  looksLikeSignatureResource,
  maskResourceId,
  claimSignatureRequest,
  attachResource,
  releaseClaim,
  closeBinding,
  findBinding,
  describeOwnership,
};
