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
import { findBinding, maskResourceId } from '../../integratedApi/stripe/stripeResourceBinding.js';
import { SUPPORTED_CURRENCIES } from '../money.js';
import { FACT_KIND, NOT_A_FACT, normalizeStripeRevenueEvent } from './stripeRevenueNormalizer.js';

const PROVIDER = 'STRIPE';

/** Motifs de non-projection. Nommés : un statut muet ne se diagnostique pas. */
export const SKIP_REASON = Object.freeze({
  NO_OWNERSHIP_RESOURCE: 'NO_OWNERSHIP_RESOURCE',
  NO_BINDING: 'NO_BINDING',
  BINDING_REVOKED: 'BINDING_REVOKED',
  CURRENCY_UNSUPPORTED: 'CURRENCY_UNSUPPORTED',
  ENVIRONMENT_MISMATCH: 'ENVIRONMENT_MISMATCH',
  REFUND_DEFERRED: 'REFUND_DEFERRED',
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
       * UN REMBOURSEMENT EST RECONNU, PAS PROJETÉ.
       *
       * Il appartient au lot L10.4, qui devra l'écrire en `REFUND / OUTFLOW`
       * avec un lien vers le paiement d'origine. Le classer ici plutôt que de
       * l'ignorer laisse une trace exploitable — et prouve que l'événement a
       * bien été VU, ce qui est la première question qu'on posera ce jour-là.
       */
      if (reason === FACT_KIND.REFUND) {
        logger.info(
          `[finance] fait de remboursement reçu (${eventType}, ${environment}) — `
          + 'reconnu, non projeté : périmètre du lot L10.4.',
        );
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
  return { examined: enAttente.length, projected };
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
  projectFact,
  convergePendingFactsFor,
  convergePendingRevenue,
  describeProviderFact,
  listUnprojectedFacts,
  labelOf,
  descriptionOf,
};
