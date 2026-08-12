import { randomUUID } from 'node:crypto';

import ApiError from '../../../utils/ApiError.js';
import logger from '../../../utils/logger.js';
import registryStore from '../../registry/registryStore.js';
import {
  CATEGORIES, FLOWS, ORIGINS, STATUSES, PanelFinancialTransaction,
} from '../../../models/PanelFinancialTransaction.model.js';
import {
  PanelRefundRequest, REFUND_REQUEST_STATUS, mayReplayRefund,
} from '../../../models/PanelRefundRequest.model.js';
import PanelProviderRevenueFact, {
  PROJECTION_STATUS,
} from '../../../models/PanelProviderRevenueFact.model.js';
import { invokeCapability } from '../../capabilities/capabilityGateway.service.js';
import { INVOCATION_SOURCES } from '../../capabilities/invocationContext.js';
import { CapabilityError } from '../../capabilities/capabilityErrors.js';
import { runtimeEnvironment } from '../../integratedApi/environment.js';
import { refundOperationId, STRIPE_REFUND_REASONS } from '../../integratedApi/stripe/stripeRefundAuthority.js';
import { recordStripeRefundResponse } from '../providerRevenue/revenueProjection.service.js';

/**
 * L'ORCHESTRATION DU REMBOURSEMENT (L10.4).
 *
 * ══ CE QUE CE MODULE EST, ET CE QU'IL N'EST PAS ═════════════════════════════
 *
 * Il ne parle PAS à Stripe. Il ne connaît ni clé, ni URL, ni version d'API : il
 * demande un acte au plan de contrôle et en lit l'issue. Toute la partie
 * fournisseur — appartenance, idempotence, convergence, traduction d'erreur —
 * vit dans l'adaptateur, où elle est éprouvée pour toutes les capacités.
 *
 * Ce qu'il porte, c'est la partie COMPTABLE de l'acte, et elle est à lui seul :
 *
 *   • quel mouvement peut être remboursé, et de combien ;
 *   • l'intention DURABLE, écrite avant tout contact fournisseur ;
 *   • la traduction d'une issue technique en état financier lisible ;
 *   • le refus de proposer un second remboursement quand le premier est
 *     seulement INCONNU.
 *
 * ══ CE QUE LE NAVIGATEUR FOURNIT, ET C'EST TOUT ═════════════════════════════
 *
 *   • `transactionId` — une identité INTERNE, sans valeur chez Stripe ;
 *   • un montant, une raison.
 *
 * Il ne fournit JAMAIS `pi_…`, `ch_…`, `in_…`, ni le monde. Les accepter
 * reviendrait à laisser un client désigner la ressource à muter — le projet B
 * rembourserait le paiement du projet A en changeant un champ. Tout cela est
 * RÉSOLU côté serveur, depuis le fait fournisseur né d'un webhook signé.
 */

const CAPABILITY = 'billing.refund';

/** Les motifs Stripe, exposés à l'écran. Aucun autre n'est accepté par l'API. */
export const REFUND_REASONS = STRIPE_REFUND_REASONS;

/**
 * L'ÉTAT DÉRIVÉ D'UN REVENU. Calculé, JAMAIS stocké.
 *
 * Un solde stocké se désynchronise au premier remboursement écrit par une voie
 * imprévue — un webhook, un rejeu, une correction. Une somme d'écritures filles
 * ne le peut pas : elle est le registre lui-même.
 */
export const REFUND_STATE = Object.freeze({
  NONE: 'NON_REMBOURSE',
  PARTIAL: 'PARTIELLEMENT_REMBOURSE',
  FULL: 'REMBOURSE',
});

const nowIso = () => new Date().toISOString();

/* -------------------------------------------------------------------------- */
/*  L'ÉTAT DÉRIVÉ                                                             */
/* -------------------------------------------------------------------------- */

/**
 * COMBIEN CES MOUVEMENTS ONT-ILS DÉJÀ RENDU ?
 *
 * ══ UNE SEULE REQUÊTE POUR TOUTE LA PAGE ════════════════════════════════════
 *
 * Même raison que la jointure des justificatifs : un livret de revenus affiche
 * cinquante lignes, et une requête par ligne ferait un N+1 sur l'écran le plus
 * consulté du lot.
 *
 * ══ LES SUPPRIMÉS NE COMPTENT PAS ═══════════════════════════════════════════
 *
 * Un remboursement retiré du livret ne participe plus aux totaux ; il ne doit
 * donc pas non plus réduire le remboursable restant, sans quoi l'écran
 * interdirait un remboursement que Stripe accepterait.
 *
 * @param {string[]} transactionIds
 * @returns {Promise<Map<string, {refundedCents:number, state:string, count:number}>>}
 */
export async function refundedByParent(transactionIds) {
  const ids = [...new Set((transactionIds ?? []).filter(Boolean))];
  if (ids.length === 0) return new Map();

  const lignes = await PanelFinancialTransaction.aggregate([
    {
      $match: {
        parentTransactionId: { $in: ids },
        category: CATEGORIES.REFUND,
        status: STATUSES.RECORDED,
        deletedAt: null,
      },
    },
    {
      $group: {
        _id: '$parentTransactionId',
        refundedCents: { $sum: '$amountCents' },
        count: { $sum: 1 },
      },
    },
  ]);

  const carte = new Map();
  for (const ligne of lignes) {
    carte.set(ligne._id, { refundedCents: ligne.refundedCents, count: ligne.count });
  }
  return carte;
}

/** L'état dérivé d'un revenu, à partir de son montant et de ce qui est rendu. */
export function refundStateOf({ amountCents, refundedCents }) {
  const rendu = Number.isInteger(refundedCents) ? refundedCents : 0;
  if (rendu <= 0) return REFUND_STATE.NONE;
  /**
   * `>=` et non `===` : un remboursement peut dépasser le montant projeté si le
   * revenu a été projeté partiellement (paiement capturé en plusieurs fois).
   * Afficher « partiellement remboursé » à 100 % rendu serait faux.
   */
  return rendu >= amountCents ? REFUND_STATE.FULL : REFUND_STATE.PARTIAL;
}

/**
 * COMPLÈTE des mouvements publics avec leur état de remboursement.
 *
 * N'ajoute rien aux mouvements qui ne peuvent pas être remboursés — une ligne
 * de coût n'a pas d'état de remboursement, et lui en donner un vide
 * encombrerait chaque réponse d'un champ toujours nul.
 */
export async function withRefundState(transactions) {
  const remboursables = transactions.filter(
    (t) => t.category === CATEGORIES.REVENUE && t.origin === ORIGINS.STRIPE && !t.deletedAt,
  );
  if (remboursables.length === 0) return transactions;

  const carte = await refundedByParent(remboursables.map((t) => t.transactionId));
  const enSuspens = await pendingRequestsFor(remboursables.map((t) => t.transactionId));

  for (const t of remboursables) {
    const rendu = carte.get(t.transactionId)?.refundedCents ?? 0;
    t.refund = {
      state: refundStateOf({ amountCents: t.amountCents, refundedCents: rendu }),
      refundedCents: rendu,
      remainingCents: Math.max(0, t.amountCents - rendu),
      count: carte.get(t.transactionId)?.count ?? 0,
      /**
       * LA VÉRIFICATION EN COURS — ce qui empêche un second remboursement.
       *
       * Tant qu'une demande est `UNKNOWN` ou `PROCESSING`, l'écran doit dire
       * « vérification en cours » et NON « remboursable ». Sans ce champ, un
       * appel dont la réponse s'est perdue laisserait le bouton actif et
       * l'argent partirait deux fois.
       */
      pending: enSuspens.get(t.transactionId) ?? null,
    };
  }
  return transactions;
}

/** Les demandes non conclues d'un lot de mouvements. Une requête, pas N. */
async function pendingRequestsFor(transactionIds) {
  const ids = [...new Set((transactionIds ?? []).filter(Boolean))];
  if (ids.length === 0) return new Map();

  const lignes = await PanelRefundRequest.find({
    sourceTransactionId: { $in: ids },
    status: { $in: [REFUND_REQUEST_STATUS.REQUESTED, REFUND_REQUEST_STATUS.PROCESSING, REFUND_REQUEST_STATUS.UNKNOWN] },
  }).sort({ requestedAt: 1 }).lean();

  const carte = new Map();
  for (const ligne of lignes) {
    if (carte.has(ligne.sourceTransactionId)) continue;
    carte.set(ligne.sourceTransactionId, {
      refundRequestId: ligne.refundRequestId,
      status: ligne.status,
      amountCents: ligne.amountCents,
      requestedAt: ligne.requestedAt,
    });
  }
  return carte;
}

/* -------------------------------------------------------------------------- */
/*  ÉLIGIBILITÉ                                                               */
/* -------------------------------------------------------------------------- */

/**
 * CE MOUVEMENT PEUT-IL ÊTRE REMBOURSÉ, ET DE COMBIEN ?
 *
 * Appelée par l'écran pour décider d'afficher le bouton, ET par l'exécution
 * pour refuser. Le même code répond aux deux : une éligibilité calculée deux
 * fois finit par diverger, et c'est alors l'écran qui promet ce que le serveur
 * refuse.
 *
 * NE LÈVE PAS pour un refus métier — elle rend un verdict nommé, que l'écran
 * peut afficher tel quel.
 */
export async function describeRefundEligibility(transactionId) {
  const mouvement = await PanelFinancialTransaction.findOne({ transactionId }).lean();
  if (!mouvement) {
    throw ApiError.notFound('PANEL_FINANCE_TRANSACTION_NOT_FOUND', 'Mouvement introuvable.');
  }

  const refus = (code, reason) => ({
    eligible: false, code, reason, transactionId, refund: null,
  });

  if (mouvement.deletedAt) {
    return refus('TRANSACTION_DELETED', 'Ce mouvement est supprimé : il ne se rembourse plus.');
  }
  if (mouvement.category !== CATEGORIES.REVENUE || mouvement.flow !== FLOWS.INFLOW) {
    return refus('NOT_A_REVENUE', 'Seul un revenu encaissé peut être remboursé.');
  }
  if (mouvement.origin !== ORIGINS.STRIPE) {
    /**
     * Un revenu saisi à la main n'a pas d'argent chez Stripe à rendre.
     * Rembourser un encaissement manuel se fait par une saisie manuelle de
     * remboursement — ce que L10.1 permet déjà, et ce lot ne le change pas.
     */
    return refus('NOT_A_PROVIDER_REVENUE', 'Ce revenu n’a pas été encaissé par Stripe : aucun remboursement automatique.');
  }
  if (!mouvement.projectId) {
    return refus('NO_PROJECT', 'Ce mouvement n’est rattaché à aucun projet : le monde et les identifiants sont introuvables.');
  }

  const fait = await PanelProviderRevenueFact.findOne({
    transactionId,
    projectionStatus: PROJECTION_STATUS.PROJECTED,
  }).select('environment corroboration currency amountCents').lean();

  if (!fait?.corroboration?.paymentIntentId) {
    /**
     * Le fait existe mais sans intention de paiement — cas d'une facture
     * ancienne dont Stripe n'a jamais exposé le `payment_intent`. Il n'y a rien
     * à rembourser automatiquement, et l'inventer serait pire que le refus.
     */
    return refus('NO_PAYMENT_INTENT', 'Le paiement d’origine n’expose aucune intention de paiement : remboursement automatique impossible.');
  }

  const carte = await refundedByParent([transactionId]);
  const rendu = carte.get(transactionId)?.refundedCents ?? 0;
  const restant = Math.max(0, mouvement.amountCents - rendu);

  const enSuspens = (await pendingRequestsFor([transactionId])).get(transactionId) ?? null;
  const etat = {
    state: refundStateOf({ amountCents: mouvement.amountCents, refundedCents: rendu }),
    collectedCents: mouvement.amountCents,
    refundedCents: rendu,
    remainingCents: restant,
    currency: mouvement.currency,
    environment: fait.environment,
    pending: enSuspens,
  };

  if (enSuspens) {
    return {
      eligible: false,
      code: 'REFUND_IN_FLIGHT',
      reason: enSuspens.status === REFUND_REQUEST_STATUS.UNKNOWN
        ? 'Un remboursement est en cours de vérification : son issue n’est pas encore connue.'
        : 'Un remboursement est déjà en cours sur ce mouvement.',
      transactionId,
      refund: etat,
    };
  }
  if (restant <= 0) {
    return { eligible: false, code: 'FULLY_REFUNDED', reason: 'Ce paiement a déjà été intégralement remboursé.', transactionId, refund: etat };
  }

  /**
   * ── LE MONDE, DÉRIVÉ ET VÉRIFIÉ — JAMAIS CHOISI ────────────────────────
   *
   * Il vient du paiement d'origine. Si cette instance ne sert pas ce monde-là,
   * on refuse ICI, avec un message qui le dit. Laisser l'appel partir
   * produirait un refus d'appartenance indistinct d'une tentative croisée, et
   * un opérateur parfaitement légitime croirait à une brèche.
   */
  const monde = runtimeEnvironment();
  if (fait.environment !== monde) {
    return {
      eligible: false,
      code: 'ENVIRONMENT_MISMATCH',
      reason: `Ce paiement appartient au monde ${fait.environment} ; cette instance sert ${monde}.`,
      transactionId,
      refund: etat,
    };
  }

  return { eligible: true, code: null, reason: null, transactionId, refund: etat };
}

/* -------------------------------------------------------------------------- */
/*  EXÉCUTION                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * REMBOURSE — l'acte complet, du clic au mouvement comptable.
 *
 * ══ L'ORDRE, ET IL N'EST PAS NÉGOCIABLE ═════════════════════════════════════
 *
 *   1. ÉLIGIBILITÉ    refuser tôt, et pour une raison nommée.
 *   2. INTENTION      écrite en base AVANT tout contact fournisseur. C'est elle
 *                     qui porte l'identité de l'acte ; sans elle, un appel dont
 *                     la réponse se perd ne laisse AUCUNE trace, et le rejeu
 *                     rembourserait une seconde fois.
 *   3. APPEL          par le plan de contrôle, jamais en direct.
 *   4. PROJECTION     le fait rendu par la réponse entre au ledger, par la même
 *                     porte que le webhook qui suivra.
 *
 * L'étape 2 avant l'étape 3 est la seule chose qui rende ce lot sûr. Toutes les
 * autres protections — clé d'idempotence, métadonnée, index unique — en
 * dépendent, puisqu'elles dérivent toutes de l'identité écrite là.
 */
export async function requestRefund({
  transactionId, amountCents = null, providerReason = null, operatorReason = null, actor = {},
  fetchImpl,
} = {}) {
  // ── 1. ÉLIGIBILITÉ ────────────────────────────────────────────────────────
  const verdict = await describeRefundEligibility(transactionId);
  if (!verdict.eligible) {
    throw ApiError.conflict(`PANEL_REFUND_${verdict.code}`, verdict.reason, { refund: verdict.refund });
  }

  const montant = normalizeAmount(amountCents, verdict.refund.remainingCents);
  const motif = normalizeReason(providerReason);

  const mouvement = await PanelFinancialTransaction.findOne({ transactionId })
    .select('projectId currency').lean();
  const fait = await PanelProviderRevenueFact.findOne({ transactionId })
    .select('corroboration environment').lean();

  // ── 2. L'INTENTION, DURABLE, AVANT TOUT APPEL ─────────────────────────────
  const refundRequestId = randomUUID();
  const operationId = refundOperationId({ environment: fait.environment, refundRequestId });

  const demande = await PanelRefundRequest.create({
    refundRequestId,
    operationId,
    projectId: mouvement.projectId,
    sourceTransactionId: transactionId,
    environment: fait.environment,
    paymentIntentId: fait.corroboration.paymentIntentId,
    amountCents: montant,
    currency: mouvement.currency,
    providerReason: motif,
    operatorReason: normalizeOperatorReason(operatorReason),
    status: REFUND_REQUEST_STATUS.REQUESTED,
    requestedBy: {
      userId: actor.userId ?? null,
      email: actor.email ?? null,
      name: actor.name ?? null,
    },
    requestedAt: nowIso(),
  });

  return executeRefundRequest({ demande: demande.toObject(), fetchImpl });
}

/**
 * EXÉCUTE une demande — neuve, ou reprise après une issue inconnue.
 *
 * Séparée de `requestRefund` pour une seule raison : la reprise. Une demande
 * `UNKNOWN` ne doit surtout pas repasser par la création d'intention, qui lui
 * donnerait une NOUVELLE identité — donc une nouvelle clé, donc un second
 * remboursement bien réel. Elle rentre ici, avec la sienne.
 */
export async function executeRefundRequest({ demande, fetchImpl } = {}) {
  if (!mayReplayRefund(demande.status)) {
    throw ApiError.conflict(
      'PANEL_REFUND_ALREADY_SETTLED',
      'Cette demande de remboursement est déjà conclue.',
    );
  }

  const panelProject = await registryStore.getById(demande.projectId);
  if (!panelProject) {
    throw ApiError.notFound('PANEL_PROJECT_NOT_FOUND', `Projet inconnu : ${demande.projectId}.`);
  }

  await PanelRefundRequest.updateOne(
    { refundRequestId: demande.refundRequestId },
    {
      $set: { status: REFUND_REQUEST_STATUS.PROCESSING, lastAttemptAt: nowIso() },
      $inc: { attempts: 1 },
    },
  );

  // ── 3. L'APPEL, PAR LE PLAN DE CONTRÔLE ───────────────────────────────────
  let resultat;
  try {
    resultat = await invokeCapability({
      code: CAPABILITY,
      panelProject,
      /**
       * LE PANEL AGIT POUR LE PROJET, SANS QUE LE PROJET DEMANDE RIEN.
       *
       * C'est le premier usage servi de cette source. Elle ne relâche que
       * l'octroi — voir la passerelle. Appartenance, monde, coffre, réservation
       * d'opération et journal s'appliquent à l'identique.
       */
      source: INVOCATION_SOURCES.PANEL_INTERNAL,
      payload: {
        paymentIntentId: demande.paymentIntentId,
        ...(Number.isInteger(demande.amountCents) ? { amountCents: demande.amountCents } : {}),
        ...(demande.providerReason ? { reason: demande.providerReason } : {}),
        operationId: demande.operationId,
      },
      fetchImpl,
    });
  } catch (error) {
    return settleFailure({ demande, error });
  }

  // ── 4. LA PROJECTION ──────────────────────────────────────────────────────
  return settleSuccess({ demande, resultat });
}

/**
 * L'ISSUE HEUREUSE — Stripe a rendu un `re_…`.
 *
 * `outcome: ALREADY_REFUNDED` passe ici aussi, et c'est voulu : une convergence
 * est un succès. La demande se conclut sur le remboursement retrouvé, sans
 * qu'aucun second acte n'ait été émis.
 */
async function settleSuccess({ demande, resultat }) {
  const vue = resultat?.result ?? {};
  /**
   * DEUX FORMES DE SUCCÈS, ET LA SECONDE EST RARE MAIS RÉELLE.
   *
   * La passerelle rend la vue complète quand elle vient d'exécuter l'acte. Elle
   * rend en revanche une MÉMOÏSATION — `ALREADY_SENT` et la seule poignée de
   * corrélation — quand son registre d'opérations savait déjà l'acte abouti.
   * Cela arrive si l'on est tombé entre le succès de la passerelle et l'écriture
   * de notre propre issue. On y récupère le `re_…`, sans les montants : la
   * projection viendra du webhook, qui les porte.
   */
  const memoise = vue.status === 'ALREADY_SENT';
  const refundId = vue.refundId ?? (memoise ? vue.providerMessageId ?? null : null);

  if (!refundId) {
    /**
     * Succès annoncé sans identité de remboursement : on ne peut ni projeter ni
     * conclure. C'est un INCONNU, pas un échec — l'argent est peut-être parti.
     */
    return settleUnknown({
      demande,
      code: 'REFUND_ID_MISSING',
      message: 'Le plan de contrôle a répondu sans identifiant de remboursement.',
    });
  }

  /**
   * LA PROJECTION PASSE PAR LA MÊME PORTE QUE LE WEBHOOK.
   *
   * On ne fabrique pas ici un mouvement « à la main » depuis la vue : il
   * divergerait de celui que le webhook produirait, et l'un des deux finirait
   * par écraser l'autre. Le fait fournisseur est la source unique.
   */
  const projete = memoise
    ? { transactionId: null }
    : await recordStripeRefundResponse({
      environment: demande.environment,
      refund: {
        id: refundId,
        amount: vue.amountCents,
        currency: (vue.currency ?? demande.currency ?? 'EUR').toLowerCase(),
        status: vue.status,
        reason: vue.reason,
        created: vue.createdAt,
        payment_intent: vue.paymentIntentId ?? demande.paymentIntentId,
        charge: vue.chargeId,
        metadata: { ly_operation_id: demande.operationId },
      },
      chargeReceiptUrl: vue.receiptUrl ?? null,
    });

  await PanelRefundRequest.updateOne(
    { refundRequestId: demande.refundRequestId },
    {
      $set: {
        status: REFUND_REQUEST_STATUS.SUCCEEDED,
        refundId,
        providerStatus: vue.status ?? null,
        transactionId: projete.transactionId ?? null,
        failureCode: null,
        failureMessage: null,
        settledAt: nowIso(),
      },
    },
  );

  /**
   * AUCUNE ÉCRITURE DANS LA CHRONOLOGIE ICI, ET C'EST DÉLIBÉRÉ.
   *
   * La passerelle en pose déjà une par invocation, avec le code de capacité,
   * l'issue et l'identité de l'acte. En ajouter une seconde consommerait deux
   * places sur les 300 que retient un projet, pour dire la même chose — et la
   * chronologie n'est de toute façon pas l'archive d'un remboursement. Celle-ci
   * est `PanelRefundRequest`, qui ne s'efface jamais.
   */
  logger.info(
    `[finance] remboursement ${vue.outcome === 'ALREADY_REFUNDED' ? 'convergé' : 'effectué'} — `
    + `${refundId} sur la demande ${demande.refundRequestId} (projet ${demande.projectId}, `
    + `${demande.environment}).`,
  );

  return {
    refundRequestId: demande.refundRequestId,
    status: REFUND_REQUEST_STATUS.SUCCEEDED,
    refundId,
    providerStatus: vue.status ?? null,
    amountCents: vue.amountCents,
    currency: vue.currency ?? demande.currency,
    transactionId: projete.transactionId ?? null,
    remainingCents: vue.remainingCents ?? null,
    converged: vue.outcome === 'ALREADY_REFUNDED',
  };
}

/**
 * L'ISSUE MALHEUREUSE — et la distinction qui porte tout le lot.
 *
 * ══ ÉCHEC OU INCONNU ? ══════════════════════════════════════════════════════
 *
 * Un TIMEOUT ne dit pas que rien n'a eu lieu : il dit qu'on ne sait pas. Le
 * classer en échec ferait réactiver le bouton, et le prochain clic créerait un
 * second remboursement pour un premier peut-être abouti.
 *
 * Le plan de contrôle nomme déjà cette différence — c'est la doctrine du
 * registre d'opérations depuis L6.1, où `UNKNOWN` n'est pas rejouable comme un
 * `FAILED`. On la recopie ici dans le vocabulaire financier, sans la réinventer.
 */
async function settleFailure({ demande, error }) {
  const code = error instanceof CapabilityError ? error.code : 'UNEXPECTED';

  /**
   * ══ LA RÈGLE : ON NE CONCLUT « ÉCHEC » QUE SI L'ON EN EST SÛR ═════════════
   *
   * `replaySafe` est la réponse du plan de contrôle à « le fournisseur a-t-il
   * tranché ? ». Un `TIMEOUT` répond non ; un refus d'entrée, oui.
   *
   * Deux cas y échappent, et ils ont coûté cher à trouver :
   *
   *   • `OUTPUT_CONTRACT_VIOLATION` — Stripe a REMBOURSÉ, et c'est notre lecture
   *     de sa réponse qui a échoué. Le classer en échec dirait « l'argent n'est
   *     pas parti » sur un argent bel et bien parti, et rouvrirait le bouton.
   *   • toute erreur NON TYPÉE — on ne sait rien d'elle, donc on ne sait pas si
   *     elle est survenue avant ou après l'appel.
   *
   * Dans le doute, INCONNU. C'est l'état le plus coûteux à porter — il ferme le
   * bouton et demande une reprise — et c'est précisément pour cela qu'il est le
   * bon défaut : il ne rend jamais l'argent deux fois.
   */
  const nonType = !(error instanceof CapabilityError);
  const contratDeSortie = error?.details?.reason === 'OUTPUT_CONTRACT_VIOLATION';
  const indecidable = nonType || contratDeSortie || !error.replaySafe;

  if (indecidable) {
    return settleUnknown({ demande, code, message: error?.message ?? null });
  }

  await PanelRefundRequest.updateOne(
    { refundRequestId: demande.refundRequestId },
    {
      $set: {
        status: REFUND_REQUEST_STATUS.FAILED,
        failureCode: code,
        failureMessage: error?.message ?? null,
        settledAt: nowIso(),
      },
    },
  );

  logger.warn(
    `[finance] remboursement refusé — demande ${demande.refundRequestId} `
    + `(projet ${demande.projectId}, ${demande.environment}) : ${code}.`,
  );

  /** 502 : le refus vient du fournisseur, pas de la requête de l'opérateur. */
  throw new ApiError(
    502,
    'PANEL_REFUND_FAILED',
    `Le remboursement n’a pas eu lieu : ${error?.message ?? code}`,
    /**
     * `reason` porte le motif INTERNE du plan de contrôle — « pas d'adaptateur »,
     * « politique commerciale », « ressource non possédée ». Il n'est pas rendu
     * au navigateur par le contrôleur, mais il est ce qu'un exploitant vient
     * chercher quand un remboursement légitime est refusé sans explication.
     */
    { refundRequestId: demande.refundRequestId, code, reason: error?.details?.reason ?? null },
  );
}

/**
 * L'ISSUE INDÉCIDABLE — et ce que l'écran doit en faire.
 *
 * On NE LÈVE PAS une erreur d'échec : le rendu doit dire « vérification en
 * cours », pas « échec ». Et surtout, la demande reste rejouable — c'est le
 * rejeu qui tranchera, en reconnaissant l'acte chez Stripe s'il a abouti.
 */
async function settleUnknown({ demande, code, message }) {
  await PanelRefundRequest.updateOne(
    { refundRequestId: demande.refundRequestId },
    {
      $set: {
        status: REFUND_REQUEST_STATUS.UNKNOWN,
        failureCode: code,
        failureMessage: message,
      },
    },
  );

  logger.error(
    `[finance] REMBOURSEMENT INDÉTERMINÉ — demande ${demande.refundRequestId} `
    + `(projet ${demande.projectId}, ${demande.environment}) : ${code}. `
    + 'AUCUN second remboursement ne doit être créé ; la reprise convergera.',
  );

  return {
    refundRequestId: demande.refundRequestId,
    status: REFUND_REQUEST_STATUS.UNKNOWN,
    refundId: null,
    code,
    message: 'L’issue du remboursement n’est pas connue. La vérification est en cours ; '
      + 'aucun second remboursement ne sera créé.',
  };
}

/* -------------------------------------------------------------------------- */
/*  CONVERGENCE                                                               */
/* -------------------------------------------------------------------------- */

/**
 * REPREND les demandes dont l'issue est restée inconnue.
 *
 * ══ POURQUOI C'EST SÛR DE REJOUER ══════════════════════════════════════════
 *
 * Parce que le rejeu porte la MÊME identité d'acte. L'adaptateur commence par
 * chercher cette identité dans les remboursements du paiement : s'il la trouve,
 * il conclut sans rien émettre. C'est la convergence par la métadonnée, et elle
 * ne dépend pas de la fenêtre d'idempotence de Stripe.
 *
 * Appelée par l'ordonnanceur et à la lecture financière, comme la
 * matérialisation des coûts et la projection des revenus. Bornée.
 */
export async function convergePendingRefunds({ limit = 20, fetchImpl } = {}) {
  const monde = runtimeEnvironment();
  const enSuspens = await PanelRefundRequest.find({
    status: { $in: [REFUND_REQUEST_STATUS.UNKNOWN, REFUND_REQUEST_STATUS.PROCESSING] },
    /** Seul le monde servi par cette instance peut être interrogé. */
    environment: monde,
  }).sort({ requestedAt: 1 }).limit(limit).lean();

  let settled = 0;
  for (const demande of enSuspens) {
    const res = await executeRefundRequest({ demande, fetchImpl }).catch(() => null);
    if (res?.status === REFUND_REQUEST_STATUS.SUCCEEDED) settled += 1;
  }
  if (settled) logger.info(`[finance] ${settled} remboursement(s) indéterminé(s) résolu(s).`);
  return { examined: enSuspens.length, settled };
}

/* -------------------------------------------------------------------------- */
/*  LECTURE                                                                   */
/* -------------------------------------------------------------------------- */

/** L'historique des demandes d'un mouvement — pour l'écran de détail. */
export async function listRefundRequests(transactionId) {
  const lignes = await PanelRefundRequest.find({ sourceTransactionId: transactionId })
    .sort({ requestedAt: -1 }).lean();
  return lignes.map(toPublicRefundRequest);
}

export function toPublicRefundRequest(demande) {
  return {
    refundRequestId: demande.refundRequestId,
    status: demande.status,
    amountCents: demande.amountCents,
    currency: demande.currency,
    /**
     * `re_…` — l'identité du REMBOURSEMENT, jamais celle du paiement. Les deux
     * confondues, un opérateur croirait que Stripe a modifié son encaissement.
     */
    refundId: demande.refundId ?? null,
    providerStatus: demande.providerStatus ?? null,
    transactionId: demande.transactionId ?? null,
    environment: demande.environment,
    providerReason: demande.providerReason ?? null,
    operatorReason: demande.operatorReason ?? null,
    failureCode: demande.failureCode ?? null,
    requestedAt: demande.requestedAt,
    settledAt: demande.settledAt ?? null,
    attempts: demande.attempts ?? 0,
    requestedBy: {
      email: demande.requestedBy?.email ?? null,
      name: demande.requestedBy?.name ?? null,
    },
  };
}

/* -------------------------------------------------------------------------- */
/*  ENTRÉES                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * `null` = remboursement TOTAL. Toute autre valeur doit être un entier de
 * centimes strictement positif et ne pas dépasser le restant.
 *
 * On ne convertit PAS un « total » en un montant chiffré : l'omission laisse
 * Stripe trancher au moment de l'écriture, là où un montant figé échouerait si
 * un autre remboursement s'était glissé entre-temps.
 */
function normalizeAmount(amountCents, remainingCents) {
  if (amountCents === null || amountCents === undefined || amountCents === '') return null;
  const valeur = Number(amountCents);
  if (!Number.isInteger(valeur) || valeur <= 0) {
    throw ApiError.badRequest('PANEL_REFUND_AMOUNT_INVALID', 'Le montant à rembourser doit être un entier de centimes positif.');
  }
  if (valeur > remainingCents) {
    throw ApiError.badRequest(
      'PANEL_REFUND_AMOUNT_TOO_LARGE',
      'Le montant demandé dépasse le remboursable restant.',
      { remainingCents },
    );
  }
  /** Un partiel égal au restant EST un total. On le laisse tel quel : c'est
   *  l'intention exprimée, et Stripe l'accepte à l'identique. */
  return valeur;
}

function normalizeReason(reason) {
  if (!reason) return null;
  const valeur = String(reason).trim();
  if (!STRIPE_REFUND_REASONS.includes(valeur)) {
    throw ApiError.badRequest(
      'PANEL_REFUND_REASON_INVALID',
      `Motif inconnu. Stripe n’accepte que : ${STRIPE_REFUND_REASONS.join(', ')}.`,
    );
  }
  return valeur;
}

function normalizeOperatorReason(reason) {
  if (!reason) return null;
  return String(reason).trim().slice(0, 500) || null;
}

export default {
  REFUND_STATE,
  REFUND_REASONS,
  refundedByParent,
  refundStateOf,
  withRefundState,
  describeRefundEligibility,
  requestRefund,
  executeRefundRequest,
  convergePendingRefunds,
  listRefundRequests,
  toPublicRefundRequest,
};
