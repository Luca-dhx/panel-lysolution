// IDEMPOTENCE D'UNE INVOCATION — une opération, un effet (L8.3).
//
// docs/architecture/CAPABILITY_GATEWAY.md §« Idempotence ».
//
// ── LE PROBLÈME, EN UNE PHRASE ──────────────────────────────────────────────
//
// Brevo n'offre aucune clé d'idempotence sur `POST /v3/smtp/email`. Sans
// registre, deux clics — ou un rejeu du projet après un doute réseau —
// envoient deux e-mails à une personne réelle. Le fournisseur ne nous aidera
// pas : la garantie est entièrement la nôtre, ou elle n'existe pas.
//
// ── TROIS RÈGLES, ET AUCUNE N'EST NÉGOCIABLE ────────────────────────────────
//
//  1. UN SUCCÈS SE REJOUE SANS EFFET. Même `operationId` → on rend le résultat
//     CONSERVÉ, et rien ne part. L'appelant obtient la même réponse qu'au
//     premier passage, ce qui rend le rejeu sûr pour lui aussi.
//
//  2. UN CONCURRENT N'EXÉCUTE PAS. C'est l'index unique qui tranche, pas une
//     lecture préalable : deux appels simultanés passeraient tous deux un
//     `findOne`. Le second reçoit un E11000, et ce refus EST la preuve qu'un
//     envoi est déjà en cours.
//
//  3. UN DOUTE NE SE REJOUE JAMAIS TOUT SEUL. `UNKNOWN` signifie « la requête
//     a pu aboutir et seule la réponse s'est perdue ». Le ranger dans FAILED
//     transformerait un doute en certitude, ferait rejouer, et doublerait un
//     e-mail. C'est un arbitrage humain, et il doit le rester.
//
// ── CE REGISTRE EST GÉNÉRIQUE ───────────────────────────────────────────────
//
// Rien ici ne connaît Brevo ni l'e-mail. Stripe s'y branchera sans changement :
// sa stratégie `PROVIDER_IDEMPOTENT` lui permettra simplement d'ignorer la
// règle 1 — le fournisseur déduplique déjà — sans que le reste bouge.
import { createHash } from 'node:crypto';

import logger from '../../utils/logger.js';
import { nowIso } from '../../bridge/bridgeContract.js';
import PanelCapabilityOperation, {
  OPERATION_STATUS,
  mayReplay,
} from '../../models/PanelCapabilityOperation.model.js';

/** Empreinte d'un destinataire — assez pour rapprocher, jamais pour lire. */
export function hashRecipient(email) {
  const clean = String(email ?? '').trim().toLowerCase();
  if (!clean) return '';
  return createHash('sha256').update(clean).digest('hex').slice(0, 16);
}

/** Ce que l'appelant doit faire de l'opération qu'il vient de réclamer. */
export const CLAIM = Object.freeze({
  /** Elle est à lui : il exécute. */
  EXECUTE: 'EXECUTE',
  /** Déjà réussie : rendre le résultat conservé, ne rien envoyer. */
  ALREADY_SUCCEEDED: 'ALREADY_SUCCEEDED',
  /** Une autre exécution est en cours : ne pas doubler. */
  IN_FLIGHT: 'IN_FLIGHT',
  /** Issue indécidable au passage précédent : refuser, ne jamais rejouer seul. */
  UNRESOLVED: 'UNRESOLVED',
});

/**
 * RÉCLAME une opération, ou dit pourquoi c'est impossible.
 *
 * L'écriture est tentée AVANT toute lecture : c'est l'index unique qui arbitre.
 * Un `findOne` d'abord laisserait passer deux concurrents, et la garantie
 * reposerait sur la chance plutôt que sur la base.
 *
 * @returns {Promise<{claim: string, operation: object}>}
 */
export async function claimOperation({
  projectId, capability, operationId, environment, provider,
  templateCode = null, recipientEmail = null,
}) {
  const at = nowIso();
  try {
    const operation = await PanelCapabilityOperation.create({
      projectId, capability, operationId, environment, provider,
      templateCode,
      recipientHash: hashRecipient(recipientEmail),
      status: OPERATION_STATUS.PENDING,
      attempts: 1,
      startedAt: at,
    });
    return { claim: CLAIM.EXECUTE, operation: operation.toObject() };
  } catch (error) {
    if (error?.code !== 11000) throw error;
  }

  // L'insertion a été refusée : quelqu'un est passé avant. QUI, et dans quel
  // état, décide de ce que l'appelant a le droit de faire.
  const existing = await PanelCapabilityOperation
    .findOne({ projectId, capability, operationId }).lean();

  // Course extrêmement serrée : le document a disparu entre le refus et la
  // relecture. On refuse plutôt que de réessayer d'écrire — un envoi ne se
  // tente pas « au cas où ».
  if (!existing) return { claim: CLAIM.IN_FLIGHT, operation: null };

  switch (existing.status) {
    case OPERATION_STATUS.SUCCEEDED:
      return { claim: CLAIM.ALREADY_SUCCEEDED, operation: existing };
    case OPERATION_STATUS.UNKNOWN:
      return { claim: CLAIM.UNRESOLVED, operation: existing };
    case OPERATION_STATUS.FAILED:
      /**
       * Un échec CERTAIN se rejoue : rien n'est parti, et l'appelant a pu
       * corriger la cause. On réarme l'opération existante plutôt que d'en
       * créer une seconde — l'historique des tentatives reste sur une ligne.
       */
      if (mayReplay(existing.status)) {
        const rearmed = await PanelCapabilityOperation.findOneAndUpdate(
          { projectId, capability, operationId, status: OPERATION_STATUS.FAILED },
          {
            $set: {
              status: OPERATION_STATUS.PENDING,
              errorCode: null, errorMessage: '', httpStatus: null,
              startedAt: at, settledAt: null,
            },
            $inc: { attempts: 1 },
          },
          { new: true },
        ).lean();
        // `null` = un autre appelant l'a réarmée entre-temps. Il exécute, pas nous.
        return rearmed
          ? { claim: CLAIM.EXECUTE, operation: rearmed }
          : { claim: CLAIM.IN_FLIGHT, operation: existing };
      }
      return { claim: CLAIM.IN_FLIGHT, operation: existing };
    default:
      return { claim: CLAIM.IN_FLIGHT, operation: existing };
  }
}

/** L'opération a abouti : on fige le résultat qu'un rejeu devra rendre. */
export async function settleSucceeded(operation, { providerMessageId = null, durationMs = null } = {}) {
  const at = nowIso();
  await PanelCapabilityOperation.updateOne(
    { projectId: operation.projectId, capability: operation.capability, operationId: operation.operationId },
    {
      $set: {
        status: OPERATION_STATUS.SUCCEEDED,
        providerMessageId,
        durationMs,
        settledAt: at,
        errorCode: null,
        errorMessage: '',
      },
    },
  );
  return { status: OPERATION_STATUS.SUCCEEDED, providerMessageId, settledAt: at };
}

/**
 * L'opération n'a pas abouti — et la NATURE de l'échec décide de la suite.
 *
 * `resolved: false` (délai dépassé, réponse perdue) → `UNKNOWN`, et plus aucun
 * rejeu automatique. `resolved: true` (le fournisseur a dit non) → `FAILED`,
 * rejouable si la cause est corrigée.
 */
export async function settleFailure(operation, { resolved, errorCode, errorMessage = '', httpStatus = null, durationMs = null }) {
  const status = resolved ? OPERATION_STATUS.FAILED : OPERATION_STATUS.UNKNOWN;
  const at = nowIso();
  await PanelCapabilityOperation.updateOne(
    { projectId: operation.projectId, capability: operation.capability, operationId: operation.operationId },
    {
      $set: {
        status,
        errorCode: errorCode ?? null,
        errorMessage: String(errorMessage ?? '').slice(0, 300),
        httpStatus,
        durationMs,
        settledAt: at,
      },
    },
  );
  if (status === OPERATION_STATUS.UNKNOWN) {
    // Une issue indécidable mérite une trace lisible : c'est elle qu'un humain
    // viendra chercher pour décider s'il rejoue.
    logger.warn(
      `[capabilities] issue INDÉTERMINÉE — ${operation.capability} / ${operation.projectId} / `
      + `${operation.operationId} : aucun rejeu automatique.`,
    );
  }
  return { status, settledAt: at };
}

/** Retrouve l'opération qu'un événement fournisseur désigne. */
export async function findByProviderMessageId({ provider, environment, providerMessageId }) {
  if (!providerMessageId) return null;
  return PanelCapabilityOperation.findOne({
    provider: String(provider).toUpperCase(),
    environment,
    providerMessageId,
  }).lean();
}

/**
 * Vue SÛRE d'une opération — ce qu'un écran ou un projet a le droit de lire.
 * Ni contenu, ni adresse : l'empreinte du destinataire ne descend pas non plus,
 * elle ne sert qu'au rapprochement interne.
 */
export function describeOperation(operation) {
  if (!operation) return null;
  return {
    capability: operation.capability,
    operationId: operation.operationId,
    status: operation.status,
    providerMessageId: operation.providerMessageId ?? null,
    templateCode: operation.templateCode ?? null,
    environment: operation.environment,
    attempts: operation.attempts ?? 0,
    startedAt: operation.startedAt,
    settledAt: operation.settledAt ?? null,
    errorCode: operation.errorCode ?? null,
  };
}

export default {
  CLAIM,
  claimOperation,
  settleSucceeded,
  settleFailure,
  findByProviderMessageId,
  describeOperation,
  hashRecipient,
};
