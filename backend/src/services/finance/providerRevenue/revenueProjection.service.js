/**
 * PROJECTION DES REVENUS FOURNISSEUR — Stripe produit des faits, le Panel les
 * inscrit.
 *
 * ══ LE SENS DE LA FLÈCHE, ET IL NE S'INVERSE JAMAIS ═════════════════════════
 *
 *     événement Stripe → fait normalisé → appartenance → transaction → écrans
 *
 * Jamais l'inverse. Aucun écran, aucun graphique, aucun agrégat n'interroge
 * Stripe : une fois projetée, la transaction vit sa vie dans le registre, et le
 * bilan reste lisible même si le fournisseur est indisponible. C'est la
 * différence entre projeter un fait et consulter un fournisseur.
 *
 * ══ CE MODULE N'APPELLE PAS STRIPE ══════════════════════════════════════════
 *
 * Pas un `fetch`, pas un client, pas une lecture d'API. Tout ce qu'il sait, il
 * le lit dans la charge utile déjà reçue et vérifiée, ou dans le registre
 * d'appartenance que le Panel a écrit lui-même. Remonter d'une facture à son
 * propriétaire en interrogeant Stripe serait payer un appel fournisseur pour
 * découvrir à qui appartient quelque chose — l'ordre inverse de la doctrine
 * posée en L6.2A.
 *
 * ══ TROIS GARANTIES, TOUTES EN BASE ═════════════════════════════════════════
 *
 *  1. UN FAIT PAR OBJET CANONIQUE — index unique sur
 *     `{provider, environment, objectType, objectId}` du fait ;
 *  2. UNE TRANSACTION PAR FAIT — index unique partiel sur `provenance.*` du
 *     ledger ;
 *  3. UNE CONVERGENCE — un fait sans propriétaire est RETENU, puis projeté dès
 *     que son lien existe. Rien n'est perdu, rien n'est deviné.
 */
import { randomUUID } from 'node:crypto';

import logger from '../../../utils/logger.js';
import { nowIso } from '../../../bridge/bridgeContract.js';
import PanelProviderRevenueFact, {
  PROJECTION_STATUS,
} from '../../../models/PanelProviderRevenueFact.model.js';
import {
  CATEGORIES, FLOWS, ORIGINS, STATUSES, PanelFinancialTransaction,
} from '../../../models/PanelFinancialTransaction.model.js';
import {
  findBinding,
  bindResource,
  maskResourceId,
  STRIPE_RESOURCE_TYPES,
  BINDING_SOURCES,
} from '../../integratedApi/stripe/stripeResourceBinding.js';
import { SUPPORTED_CURRENCIES } from '../money.js';
import {
  FACT_KIND,
  NOT_A_FACT,
  normalizeStripeRevenueEvent,
  normalizeStripeRefundEvent,
  normalizeStripeRefundObject,
} from './stripeRevenueNormalizer.js';

const PROVIDER = 'STRIPE';

/** Motifs de non-projection. Nommés : un statut muet ne se diagnostique pas. */
export const SKIP_REASON = Object.freeze({
  NO_OWNERSHIP_RESOURCE: 'NO_OWNERSHIP_RESOURCE',
  NO_BINDING: 'NO_BINDING',
  BINDING_REVOKED: 'BINDING_REVOKED',
  CURRENCY_UNSUPPORTED: 'CURRENCY_UNSUPPORTED',
  ENVIRONMENT_MISMATCH: 'ENVIRONMENT_MISMATCH',
  REFUND_DEFERRED: 'REFUND_DEFERRED',
  /**
   * L10.4 — un remboursement dont le paiement d'origine n'est pas (encore)
   * projeté. Ce n'est pas une anomalie : le webhook du remboursement peut
   * précéder l'adoption qui rendra le paiement projetable. Le fait attend.
   */
  REFUND_ORIGIN_UNKNOWN: 'REFUND_ORIGIN_UNKNOWN',
});

/* -------------------------------------------------------------------------- */
/*  RÉCEPTION                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * ENREGISTRE un événement Stripe comme fait financier, puis tente de le projeter.
 *
 * NE LÈVE JAMAIS. Appelée depuis la réception d'un webhook, qui ne doit pas
 * répondre 500 : une 500 fait rejouer le fournisseur en boucle, et un incident
 * de projection deviendrait une tempête.
 *
 * @param {object} args
 * @param {string} args.environment  celui du RUNTIME, jamais celui du corps
 * @param {string} args.eventType
 * @param {object} args.payload      l'événement complet, déjà vérifié
 * @param {string} [args.providerEventId]
 * @returns {Promise<{recorded:boolean, factId:string|null, status:string|null, reason:string|null}>}
 */
export async function recordStripeRevenueEvent({
  environment, eventType, payload, providerEventId = null,
} = {}) {
  const rien = { recorded: false, factId: null, status: null, reason: null };

  try {
    const { fact, reason } = normalizeStripeRevenueEvent({ eventType, payload, environment });

    if (!fact) {
      /**
       * UN REMBOURSEMENT PASSE PAR L'AUTRE PORTE (L10.4).
       *
       * Il s'écrit en `REFUND / OUTFLOW` avec un lien vers le paiement
       * d'origine, et un seul `charge.refunded` peut en porter plusieurs. Le
       * routage se fait ici plutôt que dans le normalisateur pour que la
       * fonction de revenu garde son contrat : un événement, au plus un fait.
       */
      if (reason === FACT_KIND.REFUND) {
        return recordStripeRefundEvent({ environment, eventType, payload, providerEventId });
      }
      return { ...rien, reason };
    }

    const enregistre = await upsertFact({ fact, eventType, providerEventId });
    const projete = await projectFact(enregistre.factId);
    return {
      recorded: true,
      factId: enregistre.factId,
      status: projete.status,
      reason: projete.reason,
    };
  } catch (err) {
    logger.error(`[finance] projection de revenu impossible — ${err?.message ?? 'erreur inconnue'}.`);
    return { ...rien, reason: 'PROJECTION_FAILED' };
  }
}

/* -------------------------------------------------------------------------- */
/*  L10.4 — RÉCEPTION DES REMBOURSEMENTS                                      */
/* -------------------------------------------------------------------------- */

/**
 * UN ÉVÉNEMENT `charge.refunded` → autant de faits que de remboursements.
 *
 * NE LÈVE JAMAIS, pour la même raison que son homologue de revenu : une 500
 * ferait rejouer Stripe en boucle.
 */
export async function recordStripeRefundEvent({
  environment, eventType, payload, providerEventId = null,
} = {}) {
  const rien = { recorded: false, factId: null, status: null, reason: null };

  try {
    const { facts, reason } = normalizeStripeRefundEvent({ eventType, payload, environment });
    if (!facts.length) {
      logger.info(
        `[finance] événement de remboursement reçu (${eventType}, ${environment}) — `
        + `aucun fait projetable : ${reason}.`,
      );
      return { ...rien, reason };
    }

    const resultats = [];
    for (const fact of facts) {
      const enregistre = await upsertFact({ fact, eventType, providerEventId });
      const projete = await projectFact(enregistre.factId);
      resultats.push({ factId: enregistre.factId, status: projete.status, reason: projete.reason });
    }
    /**
     * On rend le PREMIER pour garder le contrat de retour d'un webhook, et la
     * liste complète pour la recette. Un `charge.refunded` qui réannonce deux
     * anciens remboursements et en apporte un neuf rend donc trois entrées,
     * dont deux convergentes.
     */
    return { recorded: true, ...resultats[0], results: resultats };
  } catch (err) {
    logger.error(`[finance] projection de remboursement impossible — ${err?.message ?? 'erreur inconnue'}.`);
    return { ...rien, reason: 'PROJECTION_FAILED' };
  }
}

/**
 * LA RÉPONSE DE L'APPEL → LE MÊME FAIT QUE LE WEBHOOK.
 *
 * ══ POURQUOI ELLE EXISTE, ALORS QUE LE WEBHOOK SUFFIRAIT ═══════════════════
 *
 * Parce qu'entre l'appel et le webhook il s'écoule un temps que l'opérateur
 * voit. Sans cette porte, il cliquerait « Rembourser », obtiendrait un succès,
 * et ne verrait RIEN dans le livret pendant plusieurs secondes — puis une ligne
 * apparaîtrait sans qu'il l'ait demandée. Il rembourserait une seconde fois.
 *
 * ══ POURQUOI ELLE NE DUPLIQUE RIEN ═════════════════════════════════════════
 *
 * Elle traverse le même normalisateur, produit la même identité canonique
 * `re_…`, et retombe sur le même index unique. Le webhook qui suit MET À JOUR
 * le fait au lieu de l'insérer. L'ordre n'a aucune importance : si le webhook
 * arrive d'abord — ce qui se produit —, c'est l'appel qui converge.
 */
export async function recordStripeRefundResponse({
  environment, refund, chargeReceiptUrl = null,
} = {}) {
  const rien = { recorded: false, factId: null, status: null, reason: null };
  try {
    const { fact, reason } = normalizeStripeRefundObject({ refund, environment, chargeReceiptUrl });
    if (!fact) return { ...rien, reason };

    const enregistre = await upsertFact({ fact, eventType: 'api.refunds.create', providerEventId: null });
    const projete = await projectFact(enregistre.factId);
    return {
      recorded: true,
      factId: enregistre.factId,
      status: projete.status,
      reason: projete.reason,
      transactionId: projete.transactionId ?? null,
    };
  } catch (err) {
    logger.error(`[finance] projection du remboursement rendu par l'appel impossible — ${err?.message}.`);
    return { ...rien, reason: 'PROJECTION_FAILED' };
  }
}

/**
 * ÉCRIT le fait, ou le RETROUVE s'il existe déjà.
 *
 * ══ POURQUOI `$setOnInsert` SUR LES CHAMPS ÉCONOMIQUES ══════════════════════
 *
 * Le montant, la devise et la date sont posés à la PREMIÈRE annonce et ne
 * bougent plus. Une seconde annonce du même paiement — une facture réémise, un
 * rejeu tardif — ne doit pas pouvoir réécrire le montant d'un fait déjà
 * comptabilisé : ce serait modifier un bilan à distance, depuis un webhook.
 *
 * Ce qui s'ENRICHIT en revanche : le document de facture et les identités
 * secondaires, qui n'existent pas toujours à la première annonce et ne changent
 * aucun total. Voir `enrichissables` ci-dessous.
 */
async function upsertFact({ fact, eventType, providerEventId }) {
  const at = nowIso();
  const clef = {
    provider: PROVIDER,
    environment: fact.environment,
    objectType: fact.objectType,
    objectId: fact.objectId,
  };

  /**
   * ENRICHISSEMENT — seulement ce qui ne change aucun chiffre.
   *
   * Une facture arrive parfois sans numéro ni PDF, qui apparaissent quelques
   * secondes plus tard sur un second événement. Les accueillir est le sens même
   * de la convergence ; accueillir un nouveau MONTANT ne l'est pas.
   */
  const enrichissables = {};
  if (fact.invoiceDocument?.pdfUrl) enrichissables['invoiceDocument.pdfUrl'] = fact.invoiceDocument.pdfUrl;
  if (fact.invoiceDocument?.hostedUrl) enrichissables['invoiceDocument.hostedUrl'] = fact.invoiceDocument.hostedUrl;
  if (fact.invoiceDocument?.number) enrichissables['invoiceDocument.number'] = fact.invoiceDocument.number;
  for (const [clef2, valeur] of Object.entries(fact.corroboration ?? {})) {
    if (valeur) enrichissables[`corroboration.${clef2}`] = valeur;
  }
  if (fact.label) enrichissables.label = fact.label;

  /**
   * L10.4 — L'ÉTAT D'UN REMBOURSEMENT ÉVOLUE, ET CET ENRICHISSEMENT-LÀ COMPTE.
   *
   * Un `re_…` créé `pending` sur prélèvement devient `succeeded` des jours plus
   * tard, par webhook. L'accueillir est le sens même de la convergence — et il
   * ne change AUCUN chiffre : le montant reste sous `$setOnInsert`, comme
   * partout ailleurs. L'écran gagne seulement le droit de dire la vérité.
   */
  if (fact.refundStatus) enrichissables.refundStatus = fact.refundStatus;
  if (fact.refundReason) enrichissables.refundReason = fact.refundReason;
  if (fact.chargeReceiptUrl) enrichissables.chargeReceiptUrl = fact.chargeReceiptUrl;

  const factId = randomUUID();
  await PanelProviderRevenueFact.updateOne(
    clef,
    {
      $setOnInsert: {
        factId,
        kind: fact.kind,
        amountCents: fact.amountCents,
        currency: fact.currency,
        occurredAt: fact.occurredAt,
        periodStart: fact.periodStart ?? null,
        periodEnd: fact.periodEnd ?? null,
        ownershipResourceType: fact.ownershipVia?.resourceType ?? null,
        ownershipResourceId: fact.ownershipVia?.resourceId ?? null,
        projectionStatus: PROJECTION_STATUS.PENDING,
        firstSeenAt: at,
      },
      $set: { ...enrichissables, lastSeenAt: at },
      /**
       * `$slice: -5` — une trace de diagnostic, pas un journal. Un fait
       * réannoncé cent fois par un fournisseur en difficulté ne doit pas faire
       * grossir sans fin un document que l'on relit à la main.
       */
      $push: {
        seenEvents: {
          $each: [{ providerEventId, eventType, at }],
          $slice: -5,
        },
      },
    },
    { upsert: true },
  ).catch(async (err) => {
    // Collision : un autre écrivain vient de créer le même fait. C'est le
    // résultat NORMAL d'une course, et l'objectif est atteint.
    if (err?.code !== 11000) throw err;
  });

  const document = await PanelProviderRevenueFact.findOne(clef).lean();
  return { factId: document?.factId ?? factId, document };
}

/* -------------------------------------------------------------------------- */
/*  PROJECTION                                                                */
/* -------------------------------------------------------------------------- */

/**
 * PROJETTE un fait vers le ledger — si, et seulement si, tout est prouvé.
 *
 * Idempotente : rejouée sur un fait déjà projeté, elle ne fait rien. C'est ce
 * qui rend la convergence rejouable à volonté, depuis n'importe quel
 * déclencheur.
 */
export async function projectFact(factId) {
  const fait = await PanelProviderRevenueFact.findOne({ factId }).lean();
  if (!fait) return { status: null, reason: 'FACT_NOT_FOUND' };
  if (fait.projectionStatus === PROJECTION_STATUS.PROJECTED) {
    return { status: PROJECTION_STATUS.PROJECTED, reason: null, transactionId: fait.transactionId };
  }
  if (fait.projectionStatus === PROJECTION_STATUS.DEFERRED) {
    return { status: PROJECTION_STATUS.DEFERRED, reason: fait.projectionReason };
  }

  /**
   * ── LA DEVISE ────────────────────────────────────────────────────────────
   *
   * Le registre est monodevise depuis L10.1, et l'agrégateur ne somme jamais
   * deux devises. Un encaissement dans une devise non gérée est donc RETENU et
   * NON projeté — jamais converti à la volée, ce qui exigerait un taux, une
   * date et une politique d'arrondi qu'aucun écran ne pose.
   */
  if (!fait.currency || !SUPPORTED_CURRENCIES.includes(fait.currency)) {
    return marquer(fait, PROJECTION_STATUS.SKIPPED, SKIP_REASON.CURRENCY_UNSUPPORTED);
  }

  /**
   * ── UN REMBOURSEMENT NE SE PROUVE PAS COMME UN REVENU (L10.4) ────────────
   *
   * Un revenu prouve son appartenance par une ressource Stripe possédée. Un
   * remboursement, lui, n'a ni session ni abonnement : il n'a qu'un paiement,
   * dont le Panel connaît DÉJÀ le propriétaire pour l'avoir projeté. Interroger
   * à nouveau le registre de liens serait redemander une réponse qu'on a — et
   * l'on n'aurait rien à lui présenter, un `re_…` n'étant lié à rien.
   */
  if (fait.kind === FACT_KIND.REFUND) return projectRefundFact(fait);

  /**
   * ── L'APPARTENANCE — PAR LE LIEN, JAMAIS PAR LES METADATA ────────────────
   *
   * La ressource porteuse a été retenue par le normalisateur : la session pour
   * un paiement de frais, l'ABONNEMENT pour une facture. On interroge le
   * registre d'appartenance (L6.2A), et lui seul.
   */
  if (!fait.ownershipResourceType || !fait.ownershipResourceId) {
    return marquer(fait, PROJECTION_STATUS.UNOWNED, SKIP_REASON.NO_OWNERSHIP_RESOURCE);
  }

  const lien = await findBinding({
    environment: fait.environment,
    resourceType: fait.ownershipResourceType,
    resourceId: fait.ownershipResourceId,
  });

  if (!lien) {
    /**
     * PAS ENCORE DE LIEN — et ce n'est pas forcément une anomalie.
     *
     * Stripe n'ordonne pas ses livraisons : `invoice.paid` peut arriver avant
     * la session qui a fait adopter l'abonnement. Le fait reste PENDING, et il
     * sera repris dès l'adoption. Le classer UNOWNED tout de suite fermerait
     * la porte à cette convergence.
     */
    logger.info(
      `[finance] revenu en attente d'appartenance — ${fait.objectType} `
      + `${maskResourceId(fait.objectId)} (${fait.environment}) via `
      + `${fait.ownershipResourceType} ${maskResourceId(fait.ownershipResourceId)}.`,
    );
    return marquer(fait, PROJECTION_STATUS.PENDING, SKIP_REASON.NO_BINDING);
  }
  if (lien.revokedAt) {
    return marquer(fait, PROJECTION_STATUS.REVOKED, SKIP_REASON.BINDING_REVOKED);
  }

  const projectId = lien.projectId;
  const revendique = fait.corroboration?.claimedProjectId ?? null;
  const claimMismatch = Boolean(revendique && revendique !== projectId);
  if (claimMismatch) {
    logger.warn(
      `[finance] REVENDICATION DIVERGENTE sur ${fait.objectType} ${maskResourceId(fait.objectId)} `
      + `(${fait.environment}) : les metadata désignent un autre projet que le lien. Le lien fait autorité.`,
    );
  }

  const transactionId = await upsertTransaction({ fait, projectId });

  /**
   * L10.4 — L'INTENTION DE PAIEMENT DEVIENT POSSÉDÉE ICI, ET NULLE PART AILLEURS.
   *
   * C'est l'instant exact où les trois preuves coexistent : la ressource
   * porteuse vient d'être reconnue possédée, le fait vient d'un webhook signé, et
   * Stripe désigne la filiation. Poser le lien plus tard obligerait à les
   * rassembler à nouveau ; le poser ailleurs les dissocierait.
   *
   * Rejouer un revenu déjà projeté ne repasse pas ici — mais la convergence
   * générale le fait pour les paiements antérieurs au lot. Voir
   * `adoptMissingPaymentIntents()`.
   */
  await adoptPaymentIntent({ fait, projectId });

  await PanelProviderRevenueFact.updateOne(
    { factId },
    {
      $set: {
        projectId,
        ownership: 'OWNED',
        claimMismatch,
        projectionStatus: PROJECTION_STATUS.PROJECTED,
        projectionReason: null,
        transactionId,
        projectedAt: new Date(),
        lastSeenAt: nowIso(),
      },
    },
  );

  return { status: PROJECTION_STATUS.PROJECTED, reason: null, transactionId, projectId };
}

/**
 * PROJETTE UN REMBOURSEMENT — en sortie, jamais en coût.
 *
 * ══ D'OÙ VIENT L'APPARTENANCE ══════════════════════════════════════════════
 *
 * Du PAIEMENT qu'il défait, retrouvé sur nos propres écritures par son
 * intention. Rien n'est demandé à Stripe, rien n'est cru d'une métadonnée, et
 * aucun identifiant ne vient d'un navigateur : le fait d'origine est né d'un
 * webhook signé et son propriétaire a été prouvé par le registre de liens.
 *
 * ══ POURQUOI L'ATTENTE EST UN ÉTAT NORMAL ══════════════════════════════════
 *
 * Le remboursement d'un paiement encaissé avant la mise en service du lot
 * L10.3, ou d'un paiement dont l'abonnement n'est pas encore adopté, arrive
 * sans origine connue. Le classer en échec perdrait un mouvement RÉEL. Il reste
 * donc en attente et repart à chaque convergence — comme un revenu orphelin.
 */
async function projectRefundFact(fait) {
  const paymentIntentId = fait.corroboration?.paymentIntentId ?? null;
  const chargeId = fait.corroboration?.chargeId ?? null;

  if (!paymentIntentId && !chargeId) {
    return marquer(fait, PROJECTION_STATUS.PENDING, SKIP_REASON.REFUND_ORIGIN_UNKNOWN);
  }

  /**
   * L'intention d'abord, le débit en repli : certaines versions d'API omettent
   * l'une ou l'autre selon l'événement. Les deux désignent le même paiement.
   */
  const origine = await PanelProviderRevenueFact.findOne({
    provider: PROVIDER,
    environment: fait.environment,
    kind: FACT_KIND.REVENUE,
    projectionStatus: PROJECTION_STATUS.PROJECTED,
    ...(paymentIntentId
      ? { 'corroboration.paymentIntentId': paymentIntentId }
      : { 'corroboration.chargeId': chargeId }),
  }).select('objectType objectId projectId transactionId').lean();

  if (!origine?.projectId || !origine.transactionId) {
    logger.info(
      `[finance] remboursement en attente d'origine — ${maskResourceId(fait.objectId)} `
      + `(${fait.environment}) : le paiement ${maskResourceId(paymentIntentId ?? chargeId)} `
      + 'n\'est pas projeté.',
    );
    return marquer(fait, PROJECTION_STATUS.PENDING, SKIP_REASON.REFUND_ORIGIN_UNKNOWN);
  }

  const transactionId = await upsertRefundTransaction({ fait, origine });

  await PanelProviderRevenueFact.updateOne(
    { factId: fait.factId },
    {
      $set: {
        projectId: origine.projectId,
        /**
         * `OWNED_BY_ORIGIN` et non `OWNED` : la nuance est le seul endroit où se
         * lit que l'appartenance de ce mouvement est HÉRITÉE. Un opérateur qui
         * enquête doit pouvoir distinguer une preuve directe d'une filiation.
         */
        ownership: 'OWNED_BY_ORIGIN',
        refundOfObjectType: origine.objectType,
        refundOfObjectId: origine.objectId,
        refundOfTransactionId: origine.transactionId,
        projectionStatus: PROJECTION_STATUS.PROJECTED,
        projectionReason: null,
        transactionId,
        projectedAt: new Date(),
        lastSeenAt: nowIso(),
      },
    },
  );

  return {
    status: PROJECTION_STATUS.PROJECTED,
    reason: null,
    transactionId,
    projectId: origine.projectId,
  };
}

/**
 * ÉCRIT LE MOUVEMENT DE REMBOURSEMENT — un seul, quelle que soit la voie.
 *
 * ══ CE QUI LE DISTINGUE D'UN COÛT, ET POURQUOI C'EST STRUCTUREL ════════════
 *
 * `flow: OUTFLOW` le fait sortir du net. `category: REFUND` l'empêche d'entrer
 * dans les charges. Les deux axes sont indépendants depuis L10.1 précisément
 * pour ce cas : rendre 100 € réduit le résultat de 100 €, mais l'entreprise n'a
 * pas dépensé 100 € de plus. Un remboursement rangé en `COST` gonflerait les
 * charges et fausserait toute analyse de marge.
 *
 * ══ LE MONTANT EST POSITIF ═════════════════════════════════════════════════
 *
 * Le sens vit dans `flow`, jamais dans le signe (doctrine L10.1). Un montant
 * négatif porté par un `OUTFLOW` se soustrairait deux fois.
 *
 * ══ LA DATE EST CELLE DU REMBOURSEMENT ═════════════════════════════════════
 *
 * Pas celle du paiement. Un encaissement de juillet remboursé en août laisse le
 * revenu en juillet et pose la sortie en août : c'est ce qui s'est passé, et
 * c'est ce que les deux mois doivent montrer.
 */
async function upsertRefundTransaction({ fait, origine }) {
  const clef = {
    'provenance.provider': PROVIDER,
    'provenance.environment': fait.environment,
    'provenance.externalKind': fait.objectType,
    'provenance.externalId': fait.objectId,
  };

  /** Même doctrine anti-résurrection que pour un revenu : on ne filtre PAS. */
  const existante = await PanelFinancialTransaction.findOne(clef)
    .select('transactionId deletedAt').lean();
  if (existante) return existante.transactionId;

  const transactionId = randomUUID();
  try {
    await PanelFinancialTransaction.updateOne(
      clef,
      {
        $setOnInsert: {
          transactionId,
          projectId: origine.projectId,
          projectNameSnapshot: null,
          flow: FLOWS.OUTFLOW,
          category: CATEGORIES.REFUND,
          origin: ORIGINS.STRIPE,
          status: STATUSES.RECORDED,
          label: refundLabelOf(fait),
          description: refundDescriptionOf(fait),
          amountCents: fait.amountCents,
          currency: fait.currency,
          effectiveDate: fait.occurredAt ?? new Date(),
          sourceId: null,
          cycleKey: null,
          sourceRevision: null,
          /**
           * LA FILIATION COMPTABLE — le seul lien entre les deux mouvements.
           *
           * Il porte l'état dérivé du revenu d'origine (non remboursé,
           * partiellement, totalement), qui n'est stocké NULLE PART : il se
           * calcule en sommant les enfants. Un solde stocké se désynchronise ;
           * une somme d'écritures, jamais.
           */
          parentTransactionId: origine.transactionId,
          provenance: {
            provider: PROVIDER,
            environment: fait.environment,
            /** `re_…`, JAMAIS l'identifiant du paiement. Deux actes, deux identités. */
            externalId: fait.objectId,
            externalKind: fait.objectType,
          },
          receipt: { mediaId: null, attachedAt: null, attachedBy: null },
          deletedAt: null,
          deletedBy: null,
          deletionReason: null,
          createdBy: 'stripe',
          updatedBy: 'stripe',
        },
      },
      { upsert: true },
    );
  } catch (err) {
    if (err?.code !== 11000) throw err;
    const gagnante = await PanelFinancialTransaction.findOne(clef).select('transactionId').lean();
    return gagnante?.transactionId ?? transactionId;
  }

  const ecrite = await PanelFinancialTransaction.findOne(clef).select('transactionId').lean();
  return ecrite?.transactionId ?? transactionId;
}

/**
 * ADOPTE L'INTENTION DE PAIEMENT (L10.4).
 *
 * ══ POURQUOI CE LIEN N'EXISTAIT PAS AVANT ══════════════════════════════════
 *
 * Personne n'avait besoin de POSSÉDER un `pi_…` : le Panel n'en créait pas et
 * n'agissait pas dessus. Rembourser change cela — et rembourser exige de
 * prouver l'appartenance de la ressource qu'on mute, pas d'une ressource
 * cousine.
 *
 * ══ POURQUOI IL EST LÉGITIME ═══════════════════════════════════════════════
 *
 * C'est l'adoption par filiation de L6.2F, appliquée d'un cran plus bas. Au
 * moment où l'on pose ce lien, trois choses sont acquises : la session ou
 * l'abonnement porteur est POSSÉDÉ, le fait vient d'un webhook SIGNÉ, et la
 * filiation est désignée par Stripe lui-même sur la charge utile. Aucune de ces
 * trois n'est une métadonnée éditable, et aucune ne vient d'un navigateur.
 *
 * Ne lève jamais : un lien manquant se rattrape à la convergence suivante, et
 * ferait au pire échouer un remboursement pour appartenance non prouvée — ce
 * qui est le bon sens du refus. Un revenu, lui, ne doit pas être perdu pour
 * autant.
 */
async function adoptPaymentIntent({ fait, projectId }) {
  const paymentIntentId = fait.corroboration?.paymentIntentId ?? null;
  if (!paymentIntentId) return;

  const porteuse = fait.ownershipResourceType && fait.ownershipResourceId
    ? { derivedFromResourceType: fait.ownershipResourceType, derivedFromResourceId: fait.ownershipResourceId }
    : {};

  try {
    await bindResource({
      projectId,
      environment: fait.environment,
      resourceType: STRIPE_RESOURCE_TYPES.PAYMENT_INTENT,
      resourceId: paymentIntentId,
      source: BINDING_SOURCES.LEARNED_FROM_WEBHOOK,
      proof: {
        ...porteuse,
        matchedProjectionContractId: fait.corroboration?.contractId ?? null,
      },
    });
  } catch (err) {
    logger.warn(
      `[finance] adoption de ${maskResourceId(paymentIntentId)} impossible `
      + `(${fait.environment}) — ${err?.message ?? 'erreur inconnue'}. Le revenu reste projeté.`,
    );
  }
}

/** Enregistre un statut de non-projection, sans jamais l'effacer en silence. */
async function marquer(fait, status, reason) {
  await PanelProviderRevenueFact.updateOne(
    { factId: fait.factId },
    { $set: { projectionStatus: status, projectionReason: reason, lastSeenAt: nowIso() } },
  );
  return { status, reason };
}

/**
 * ÉCRIT LA TRANSACTION — une seule, quoi qu'il arrive.
 *
 * ══ CE QUI EST IMMUABLE, ET CE QUI S'ENRICHIT ═══════════════════════════════
 *
 * `$setOnInsert` sur TOUT ce qui est financier : montant, devise, date, sens,
 * catégorie, projet. Une seconde annonce du même paiement ne réécrit aucun
 * chiffre — un total déjà affiché ne doit pas pouvoir changer parce qu'un
 * webhook a été rejoué.
 *
 * Ce qui s'enrichit vit ailleurs : le document de facture et les identités
 * secondaires sont sur le FAIT, pas sur la transaction. C'est aussi ce qui
 * garde la `provenance` du registre comptable maigre, comme L10.1 l'exigeait.
 *
 * ══ LE JUSTIFICATIF MANUEL N'EST JAMAIS TOUCHÉ ══════════════════════════════
 *
 * `receipt` n'apparaît pas dans `$setOnInsert` d'une mise à jour, et jamais
 * dans un `$set`. Un opérateur qui a attaché une facture à la main la conserve,
 * quel que soit le nombre d'événements Stripe qui suivent.
 */
async function upsertTransaction({ fait, projectId }) {
  const clef = {
    'provenance.provider': PROVIDER,
    'provenance.environment': fait.environment,
    'provenance.externalKind': fait.objectType,
    'provenance.externalId': fait.objectId,
  };

  /**
   * ── LA LECTURE N'EXCLUT PAS LES SUPPRIMÉS, ET C'EST PORTANT ──────────────
   *
   * Un revenu retiré du livret par un opérateur ne doit PAS réapparaître parce
   * que Stripe a rejoué son événement le lendemain. C'est le piège que la
   * doctrine de suppression devait fermer : effacer physiquement, puis recevoir
   * un rejeu, ressusciterait la ligne — et personne ne comprendrait pourquoi.
   *
   * La suppression du registre est LOGIQUE depuis L10.1 : le document reste,
   * `deletedAt` le sort des totaux, et sa clé d'identité externe reste occupée.
   * En cherchant sans filtrer sur `deletedAt`, on retrouve donc la pierre
   * tombale et l'on ne crée rien. L'index unique dit la même chose, en dernier
   * recours.
   *
   * Restaurer un revenu supprimé est un geste EXPLICITE, qui n'existe pas
   * encore — pas un effet de bord d'un webhook.
   */
  const existante = await PanelFinancialTransaction.findOne(clef)
    .select('transactionId deletedAt').lean();
  if (existante) {
    if (existante.deletedAt) {
      logger.info(
        `[finance] rejeu sur un revenu SUPPRIMÉ — ${fait.objectType} `
        + `${maskResourceId(fait.objectId)} (${fait.environment}) : aucune résurrection.`,
      );
    }
    return existante.transactionId;
  }

  const transactionId = randomUUID();
  try {
    await PanelFinancialTransaction.updateOne(
      clef,
      {
        $setOnInsert: {
          transactionId,
          projectId,
          projectNameSnapshot: null,
          flow: FLOWS.INFLOW,
          /**
           * `REVENUE`, et surtout PAS une catégorie « STRIPE_REVENUE ».
           *
           * La taxonomie comptable reste fournisseur-agnostique : Stripe est une
           * ORIGINE, pas une nature économique. Inventer une catégorie par
           * fournisseur ferait éclater le compte de résultat en autant de
           * colonnes que d'intégrations.
           */
          category: CATEGORIES.REVENUE,
          origin: ORIGINS.STRIPE,
          status: STATUSES.RECORDED,
          label: labelOf(fait),
          description: descriptionOf(fait),
          amountCents: fait.amountCents,
          currency: fait.currency,
          effectiveDate: fait.occurredAt ?? new Date(),
          sourceId: null,
          cycleKey: null,
          sourceRevision: null,
          parentTransactionId: null,
          provenance: {
            provider: PROVIDER,
            environment: fait.environment,
            externalId: fait.objectId,
            externalKind: fait.objectType,
          },
          receipt: { mediaId: null, attachedAt: null, attachedBy: null },
          deletedAt: null,
          deletedBy: null,
          deletionReason: null,
          createdBy: 'stripe',
          updatedBy: 'stripe',
        },
      },
      { upsert: true },
    );
  } catch (err) {
    /**
     * COURSE PERDUE — un autre écrivain vient d'insérer la même transaction.
     * L'index a tranché, l'objectif est atteint : on relit et l'on rend la
     * sienne.
     */
    if (err?.code !== 11000) throw err;
    const gagnante = await PanelFinancialTransaction.findOne(clef).select('transactionId').lean();
    return gagnante?.transactionId ?? transactionId;
  }

  const ecrite = await PanelFinancialTransaction.findOne(clef).select('transactionId').lean();
  return ecrite?.transactionId ?? transactionId;
}

/* -------------------------------------------------------------------------- */
/*  LIBELLÉS                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * LE NOM D'UNE LIGNE DE REVENU — métier d'abord, jamais un identifiant Stripe.
 *
 * ══ L'ORDRE DES SOURCES, ET POURQUOI ════════════════════════════════════════
 *
 *  1. la LIGNE DE FACTURE, quand Stripe la fournit : c'est le libellé que le
 *     client a vu sur son document, donc celui dont il parlera ;
 *  2. le TYPE DE PAIEMENT que le Panel a lui-même inscrit à la création
 *     (`metadata.paymentType`) : une corroboration éditable, acceptable pour un
 *     libellé — un nom faux est cosmétique, un propriétaire faux est une
 *     brèche ;
 *  3. un repli EXPLICITE, qui dit ce qu'on sait et rien de plus.
 *
 * `pi_3Q7x…` n'apparaît jamais. Un identifiant technique dans une colonne
 * « Nom » rend un livret comptable illisible, et il vit très bien dans les
 * détails, où quelqu'un le cherche vraiment.
 */
export function labelOf(fait) {
  const ligne = typeof fait.label === 'string' ? fait.label.trim() : '';
  if (ligne) return ligne.slice(0, 160);

  const type = fait.corroboration?.paymentType ?? null;
  if (type === 'SUBSCRIPTION') return 'Abonnement';
  if (type) return 'Frais de mise en service';

  return fait.objectType === 'INVOICE' ? 'Facture Stripe' : 'Paiement Stripe';
}

/**
 * LA DESCRIPTION — la période couverte quand elle existe, sinon rien.
 *
 * On n'invente pas de phrase : une description qui répète le libellé
 * n'apprend rien, et une description vide se lit très bien.
 */
export function descriptionOf(fait) {
  if (!fait.periodStart || !fait.periodEnd) {
    return fait.corroboration?.invoiceNumber ? `Facture ${fait.corroboration.invoiceNumber}` : '';
  }
  const jour = new Intl.DateTimeFormat('fr-FR', { dateStyle: 'long', timeZone: 'Europe/Paris' });
  return `Période du ${jour.format(new Date(fait.periodStart))} au ${jour.format(new Date(fait.periodEnd))}`;
}

/**
 * LE NOM D'UN REMBOURSEMENT — il dit ce qu'il est, sans identifiant Stripe.
 *
 * Un seul mot suffit dans la colonne « Nom » : le lien vers le paiement
 * d'origine est porté par `parentTransactionId`, et l'écran de détail l'affiche.
 * Répéter ici « Remboursement de la facture n°… » ferait une colonne illisible
 * pour une information déjà présente deux lignes plus haut.
 */
export function refundLabelOf(fait) {
  return fait.refundStatus === 'pending' ? 'Remboursement (en cours)' : 'Remboursement';
}

/**
 * LA DESCRIPTION — le motif Stripe traduit, quand il existe. Sinon rien.
 *
 * La raison libre de l'opérateur n'apparaît PAS ici : elle vit sur la demande
 * de remboursement, qui porte aussi son auteur. La recopier dans le ledger
 * dupliquerait une donnée éditable dans un registre qui ne l'est pas.
 */
export function refundDescriptionOf(fait) {
  const motifs = {
    duplicate: 'Paiement en double',
    fraudulent: 'Paiement frauduleux',
    requested_by_customer: 'À la demande du client',
  };
  return motifs[fait.refundReason] ?? '';
}

/* -------------------------------------------------------------------------- */
/*  CONVERGENCE                                                               */
/* -------------------------------------------------------------------------- */

/**
 * REPREND les faits qui attendaient une ressource devenue possédée.
 *
 * ══ LE SCÉNARIO QU'ELLE FERME ═══════════════════════════════════════════════
 *
 *     invoice.paid                 arrive en premier — l'abonnement n'a pas
 *                                  encore été adopté, le fait reste PENDING
 *     checkout.session.completed   arrive ensuite — l'adoption a lieu
 *                                  ↓
 *     cette fonction               le fait retrouve son propriétaire et devient
 *                                  une transaction
 *
 * Sans elle, un revenu réellement encaissé disparaîtrait pour la seule raison
 * que Stripe a livré ses annonces dans le désordre — ce qu'il fait.
 *
 * Appelée juste après l'adoption d'un abonnement, et par la convergence
 * générale. Idempotente : un fait déjà projeté n'est pas retouché.
 */
export async function convergePendingFactsFor({ environment, resourceType, resourceId } = {}) {
  if (!environment || !resourceType || !resourceId) return { projected: 0 };

  const enAttente = await PanelProviderRevenueFact.find({
    environment,
    ownershipResourceType: resourceType,
    ownershipResourceId: resourceId,
    projectionStatus: { $in: [PROJECTION_STATUS.PENDING, PROJECTION_STATUS.UNOWNED] },
  }).select('factId').lean();

  let projected = 0;
  for (const { factId } of enAttente) {
    const res = await projectFact(factId).catch((err) => {
      logger.warn(`[finance] convergence impossible pour ${factId} — ${err.message}`);
      return null;
    });
    if (res?.status === PROJECTION_STATUS.PROJECTED) projected += 1;
  }
  if (projected) {
    logger.info(
      `[finance] ${projected} revenu(s) en attente projeté(s) après adoption de `
      + `${resourceType} ${maskResourceId(resourceId)} (${environment}).`,
    );
  }
  return { projected };
}

/**
 * CONVERGENCE GÉNÉRALE — tous les faits en attente, quelle qu'en soit la cause.
 *
 * Appelée à la lecture financière et par l'ordonnanceur, exactement comme la
 * matérialisation des coûts récurrents (L10.2) : ce que quelqu'un regarde est à
 * jour au moment où il le regarde, et le système converge même sans lecteur.
 *
 * Bornée : un incident qui laisserait des milliers de faits en attente ne doit
 * pas transformer chaque ouverture d'écran en balayage complet.
 */
export async function convergePendingRevenue({ limit = 200 } = {}) {
  const enAttente = await PanelProviderRevenueFact.find({
    projectionStatus: PROJECTION_STATUS.PENDING,
  }).sort({ firstSeenAt: 1 }).limit(limit).select('factId').lean();

  let projected = 0;
  for (const { factId } of enAttente) {
    const res = await projectFact(factId).catch(() => null);
    if (res?.status === PROJECTION_STATUS.PROJECTED) projected += 1;
  }

  const adoptes = await adoptMissingPaymentIntents({ limit });
  return { examined: enAttente.length, projected, adoptedPaymentIntents: adoptes };
}

/**
 * RATTRAPE LES INTENTIONS DE PAIEMENT NON ADOPTÉES (L10.4).
 *
 * ══ LE PROBLÈME QU'ELLE RÉSOUT ═════════════════════════════════════════════
 *
 * Tous les revenus projetés par L10.3 l'ont été SANS poser de lien sur leur
 * `pi_…` — la notion n'existait pas. Ils sont pourtant les premiers qu'on
 * voudra rembourser, et sans lien l'appartenance ne se prouve pas : le
 * remboursement serait refusé, avec un message volontairement indistinct de
 * celui d'une tentative croisée. L'opérateur ne comprendrait pas.
 *
 * ══ POURQUOI PAS UNE MIGRATION ═════════════════════════════════════════════
 *
 * Parce qu'une migration s'exécute une fois, et qu'un lien manqué après elle —
 * un incident, un fait projeté pendant l'exécution — resterait manquant pour
 * toujours. La convergence, elle, repasse à chaque lecture financière et à
 * chaque tour d'ordonnanceur : c'est la doctrine du parc depuis L10.2, et elle
 * vaut ici pour la même raison.
 *
 * Bornée, et silencieuse quand il n'y a rien à faire.
 */
export async function adoptMissingPaymentIntents({ limit = 200 } = {}) {
  const candidats = await PanelProviderRevenueFact.find({
    provider: PROVIDER,
    kind: FACT_KIND.REVENUE,
    projectionStatus: PROJECTION_STATUS.PROJECTED,
    projectId: { $ne: null },
    'corroboration.paymentIntentId': { $ne: null },
  }).sort({ projectedAt: -1 }).limit(limit)
    .select('factId environment projectId corroboration ownershipResourceType ownershipResourceId')
    .lean();

  let adopted = 0;
  for (const fait of candidats) {
    const existant = await findBinding({
      environment: fait.environment,
      resourceType: STRIPE_RESOURCE_TYPES.PAYMENT_INTENT,
      resourceId: fait.corroboration.paymentIntentId,
    }).catch(() => null);
    if (existant) continue;

    await adoptPaymentIntent({ fait, projectId: fait.projectId });
    adopted += 1;
  }
  if (adopted) {
    logger.info(`[finance] ${adopted} intention(s) de paiement adoptée(s) rétroactivement.`);
  }
  return adopted;
}

/* -------------------------------------------------------------------------- */
/*  LECTURE                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * LE FAIT FOURNISSEUR D'UNE TRANSACTION — pour l'écran de DÉTAIL, et lui seul.
 *
 * Il n'entre dans aucune liste et dans aucun agrégat : ce sont des identités
 * techniques, et une colonne d'identifiants Stripe rendrait le livret
 * illisible. Ils sont ici parce que quelqu'un, un jour, aura besoin de
 * rapprocher une ligne du tableau de bord Stripe.
 */
export async function describeProviderFact(transaction) {
  const externalId = transaction?.provenance?.externalId;
  if (!externalId) return null;

  const fait = await PanelProviderRevenueFact.findOne({
    provider: transaction.provenance.provider ?? PROVIDER,
    environment: transaction.provenance.environment,
    objectType: transaction.provenance.externalKind,
    objectId: externalId,
  }).lean();
  if (!fait) return null;

  return {
    factId: fait.factId,
    provider: fait.provider,
    environment: fait.environment,
    objectType: fait.objectType,
    objectId: fait.objectId,
    occurredAt: fait.occurredAt ? new Date(fait.occurredAt).toISOString() : null,
    periodStart: fait.periodStart ? new Date(fait.periodStart).toISOString() : null,
    periodEnd: fait.periodEnd ? new Date(fait.periodEnd).toISOString() : null,
    projectionStatus: fait.projectionStatus,
    projectedAt: fait.projectedAt ? new Date(fait.projectedAt).toISOString() : null,
    claimMismatch: Boolean(fait.claimMismatch),
    corroboration: {
      subscriptionId: fait.corroboration?.subscriptionId ?? null,
      paymentIntentId: fait.corroboration?.paymentIntentId ?? null,
      chargeId: fait.corroboration?.chargeId ?? null,
      customerId: fait.corroboration?.customerId ?? null,
      checkoutSessionId: fait.corroboration?.checkoutSessionId ?? null,
      invoiceNumber: fait.corroboration?.invoiceNumber ?? null,
    },
    /**
     * LES ADRESSES STRIPE DU DOCUMENT — rendues telles quelles, jamais
     * republiées ni transformées en média. Voir la doctrine des justificatifs.
     */
    invoiceDocument: fait.invoiceDocument?.hostedUrl || fait.invoiceDocument?.pdfUrl
      ? {
        number: fait.invoiceDocument.number ?? null,
        hostedUrl: fait.invoiceDocument.hostedUrl ?? null,
        pdfUrl: fait.invoiceDocument.pdfUrl ?? null,
      }
      : null,
    /** Le dernier événement qui a parlé de ce fait — diagnostic d'arrivée. */
    lastEventType: fait.seenEvents?.at(-1)?.eventType ?? null,
    seenEventCount: fait.seenEvents?.length ?? 0,
  };
}

/** Les faits NON projetés — la file de diagnostic d'un exploitant. */
export async function listUnprojectedFacts({ limit = 100 } = {}) {
  return PanelProviderRevenueFact.find({
    projectionStatus: { $ne: PROJECTION_STATUS.PROJECTED },
  }).sort({ lastSeenAt: -1 }).limit(limit).lean();
}

export default {
  SKIP_REASON,
  NOT_A_FACT,
  recordStripeRevenueEvent,
  recordStripeRefundEvent,
  recordStripeRefundResponse,
  projectFact,
  convergePendingFactsFor,
  convergePendingRevenue,
  adoptMissingPaymentIntents,
  describeProviderFact,
  listUnprojectedFacts,
  labelOf,
  descriptionOf,
  refundLabelOf,
  refundDescriptionOf,
};
