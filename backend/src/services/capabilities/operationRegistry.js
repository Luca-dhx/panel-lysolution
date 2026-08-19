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
  /**
   * REPRENDRE — l'acte a peut-être eu lieu, et le refaire à l'identique ne peut
   * pas le doubler. Réservé aux fournisseurs qui dédupliquent eux-mêmes (L6.2B).
   */
  CONVERGE: 'CONVERGE',
});

/* -------------------------------------------------------------------------- */
/*  CONVERGENCE                                                               */
/* -------------------------------------------------------------------------- */

/**
 * QUAND UN DOUTE PEUT-IL SE LEVER TOUT SEUL ?
 *
 * ══ LA RÈGLE GÉNÉRALE NE CHANGE PAS ═════════════════════════════════════════
 *
 * Sans option de convergence, ce registre se comporte EXACTEMENT comme au lot
 * L8.3 : `UNKNOWN` interdit tout rejeu automatique, et `PENDING` refuse de
 * doubler. C'est la seule doctrine tenable face à un fournisseur qui n'offre
 * aucune clé d'idempotence — rejouer y crée un second effet réel.
 *
 * ══ CE QUE LA CONVERGENCE CHANGE, ET POUR QUI ═══════════════════════════════
 *
 * Chez un fournisseur qui déduplique sur une clé stable, refaire le MÊME appel
 * avec la MÊME clé ne produit pas un second acte : il rend le premier. Le doute
 * n'a alors plus besoin d'un arbitrage humain — il a besoin d'être rejoué à
 * l'identique. Refuser serait même nuisible : on laisserait un paiement ouvert
 * chez Stripe que plus personne ne peut retrouver.
 *
 * ══ LES DEUX BORNES, ET POURQUOI ELLES SONT INDISPENSABLES ══════════════════
 *
 *   `staleAfterMs`   une opération PENDING RÉCENTE est un CONCURRENT, pas un
 *                    survivant de crash. La laisser converger ferait partir
 *                    huit appels simultanés portant la même clé — Stripe n'en
 *                    exécuterait qu'un, mais renverrait sept conflits, et le
 *                    projet lirait sept échecs pour un paiement réussi.
 *
 *   `replayWindowMs` la garantie du fournisseur EXPIRE. Chez Stripe, une clé
 *                    d'idempotence cesse d'être reconnue après 24 heures :
 *                    au-delà, rejouer n'est plus une reprise, c'est une
 *                    SECONDE création. On refuse alors, et le doute redevient
 *                    ce qu'il était — un arbitrage humain.
 */
export const DEFAULT_CONVERGENCE = Object.freeze({
  /** 90 s : très au-delà du délai d'attente d'une écriture financière (25 s). */
  staleAfterMs: 90_000,
  /** 23 h : une marge sous la fenêtre annoncée par Stripe, jamais au-dessus. */
  replayWindowMs: 23 * 60 * 60 * 1000,
});

const ageMs = (iso) => {
  const t = Date.parse(String(iso ?? ''));
  return Number.isFinite(t) ? Date.now() - t : Number.POSITIVE_INFINITY;
};

/**
 * L'INDEX UNIQUE DOIT EXISTER AVANT LA PREMIÈRE ÉCRITURE.
 *
 * Mongoose construit ses index EN TÂCHE DE FOND : juste après une connexion,
 * `create()` peut réussir deux fois pour la même clé, et l'index refuse ensuite
 * de se construire — en silence. Toute la garantie de non-doublon reposerait
 * alors sur une course gagnée par hasard. Mémoïsé : une seule attente réelle.
 */
let indexesReady = null;
function ensureIndexes() {
  indexesReady ??= PanelCapabilityOperation.init();
  return indexesReady;
}

/** Tests uniquement : la base change entre deux suites, la promesse non. */
export function _resetIndexReadinessForTests() {
  indexesReady = null;
}

/**
 * RÉCLAME une opération, ou dit pourquoi c'est impossible.
 *
 * L'écriture est tentée AVANT toute lecture : c'est l'index unique qui arbitre.
 * Un `findOne` d'abord laisserait passer deux concurrents, et la garantie
 * reposerait sur la chance plutôt que sur la base.
 *
 * @param {object} args
 * @param {object|null} [args.convergence] politique de reprise — `null` (défaut)
 *   conserve mot pour mot la doctrine L8.3. Voir `DEFAULT_CONVERGENCE`.
 * @returns {Promise<{claim: string, operation: object}>}
 */
export async function claimOperation({
  projectId, capability, operationId, environment, provider,
  templateCode = null, recipientEmail = null, convergence = null,
}) {
  await ensureIndexes();
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
      /**
       * Chez un fournisseur convergent, l'appelant sait retrouver son propre
       * résultat — c'est même la première chose qu'il fait. On le laisse donc
       * REPRENDRE plutôt que de lui imposer un résumé conservé ici : le
       * registre n'a pas à connaître la forme du résultat d'un verbe financier.
       */
      return convergence
        ? { claim: CLAIM.CONVERGE, operation: existing }
        : { claim: CLAIM.ALREADY_SUCCEEDED, operation: existing };
    case OPERATION_STATUS.UNKNOWN:
      if (convergence && ageMs(existing.startedAt) <= convergence.replayWindowMs) {
        return rearm(existing, { projectId, capability, operationId, at, from: OPERATION_STATUS.UNKNOWN });
      }
      return { claim: CLAIM.UNRESOLVED, operation: existing };
    case OPERATION_STATUS.PENDING:
      /**
       * PENDING RÉCENT = concurrent : on ne double pas. PENDING ANCIEN = un
       * processus tué avant d'avoir pu conclure ; chez un fournisseur
       * convergent, c'est exactement le cas qu'il faut reprendre.
       */
      if (convergence && ageMs(existing.startedAt) > convergence.staleAfterMs) {
        if (ageMs(existing.startedAt) > convergence.replayWindowMs) {
          return { claim: CLAIM.UNRESOLVED, operation: existing };
        }
        return rearm(existing, { projectId, capability, operationId, at, from: OPERATION_STATUS.PENDING });
      }
      return { claim: CLAIM.IN_FLIGHT, operation: existing };
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

/**
 * RÉARME une opération pour une reprise — atomiquement, et une seule fois.
 *
 * La condition `status: from` est le cœur du geste : deux appelants qui
 * constatent le même `PENDING` périmé tentent tous deux de réarmer, et la base
 * n'en laisse passer qu'un. Le perdant lit `null` et repart en `IN_FLIGHT` —
 * il ne part pas parler au fournisseur « lui aussi ».
 */
async function rearm(existing, { projectId, capability, operationId, at, from }) {
  const rearmed = await PanelCapabilityOperation.findOneAndUpdate(
    { projectId, capability, operationId, status: from },
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
  return rearmed
    ? { claim: CLAIM.CONVERGE, operation: rearmed }
    : { claim: CLAIM.IN_FLIGHT, operation: existing };
}

/**
 * L'opération a abouti : on fige le résultat qu'un rejeu devra rendre.
 *
 * `artefact` porte, pour un envoi de modèle, LES COORDONNÉES DU DOCUMENT
 * RÉELLEMENT RENDU (L11.1). Il n'est connu qu'ici : la réservation précède le
 * rendu, et écrire une version devinée à ce moment-là serait un mensonge daté.
 * Absent pour toute capacité qui n'est pas un envoi — les champs restent `null`,
 * ce qui se lit « sans objet » et non « perdu ».
 */
export async function settleSucceeded(operation, {
  providerMessageId = null, durationMs = null, artefact = null,
} = {}) {
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
        ...(artefact?.templateScope !== undefined ? { templateScope: artefact.templateScope ?? null } : {}),
        ...(artefact?.templateScopeId !== undefined ? { templateScopeId: artefact.templateScopeId ?? null } : {}),
        ...(artefact?.templateVersion !== undefined ? { templateVersion: artefact.templateVersion ?? null } : {}),
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
    /** La portée et la version RÉELLEMENT expédiées — `null` hors envoi de modèle. */
    templateScope: operation.templateScope ?? null,
    templateScopeId: operation.templateScopeId ?? null,
    templateVersion: operation.templateVersion ?? null,
    environment: operation.environment,
    attempts: operation.attempts ?? 0,
    startedAt: operation.startedAt,
    settledAt: operation.settledAt ?? null,
    errorCode: operation.errorCode ?? null,
  };
}

export default {
  CLAIM,
  DEFAULT_CONVERGENCE,
  claimOperation,
  settleSucceeded,
  settleFailure,
  findByProviderMessageId,
  describeOperation,
  hashRecipient,
};
