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

import { archiveInvoiceForFact, backfillMissingInvoiceArchives } from './invoiceArchival.service.js';
import { announcePaymentConfirmed } from './paymentConfirmationAnnouncements.js';

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
  OWNERSHIP_OUTCOME,
  resolveStripeRevenueOwnership,
} from './stripeRevenueOwnership.js';
import {
  FACT_KIND,
  NOT_A_FACT,
  CANONICAL_TYPES,
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

      /**
       * UNE SESSION CORROBORATIVE N'EST PAS INUTILE (L10.5).
       *
       * Une session `mode: payment` avec `invoice_creation` s'efface devant sa
       * facture — c'est la doctrine L10.3, et elle évite le double comptage.
       * Mais elle porte quelque chose que la facture n'a pas : le lien vers le
       * projet, prouvé depuis sa création (L6.2B).
       *
       * Sans ce passage, une prestation ponctuelle payée restait UNOWNED pour
       * toujours : la facture n'a pas d'abonnement, donc aucune filiation, donc
       * aucun revenu. De l'argent réellement encaissé, absent du livret.
       *
       * On adopte donc l'intention de paiement AVANT de laisser passer la
       * session. La facture, qui porte la même intention, y trouvera son
       * propriétaire — quel que soit l'ordre d'arrivée des deux événements.
       */
      if (reason === NOT_A_FACT.CORROBORATING_ONLY || reason === NOT_A_FACT.NOT_FINANCIAL) {
        await adoptIntentFromSession({ environment, eventType, payload }).catch(() => null);
      }

      /**
       * UN ÉCHEC DE PRÉLÈVEMENT N'EST PAS UN REVENU — mais c'est un FAIT (L10.6).
       *
       * Il ressort ici en `NO_MONEY_MOVED`, ce qui est exact : rien n'est entré.
       * Rien n'entrera peut-être jamais, et c'est précisément l'incident. Le
       * laisser filer ferait dépendre tout le cycle de défaut d'un événement
       * que personne ne regarde.
       *
       * AUCUN mouvement n'est écrit au ledger : une absence de revenu n'est ni
       * un coût ni un revenu négatif. Voir `paymentDefaults.service.js`.
       */
      if (String(eventType) === 'invoice.payment_failed') {
        await ingestInvoiceFailure({ environment, eventType, payload }).catch((err) => {
          logger.error(`[finance] défaut de paiement non ingéré — ${err?.message ?? 'erreur inconnue'}.`);
        });
      }
      return { ...rien, reason };
    }

    const enregistre = await upsertFact({ fact, eventType, providerEventId });
    const projete = await projectAndSettle(enregistre.factId);
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
  /**
   * L'IDENTIFIANT DE LA FACTURE MANQUAIT (corrigé en L10.5).
   *
   * Les trois autres champs étaient conservés, pas lui — et rien ne s'en
   * plaignait tant que personne ne cherchait la facture par son identité. Une
   * prestation payée, elle, veut la rattacher : sans cet identifiant, elle
   * n'aurait présenté aucun document alors que Stripe en avait émis un.
   */
  if (fact.invoiceDocument?.invoiceId) enrichissables['invoiceDocument.invoiceId'] = fact.invoiceDocument.invoiceId;
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
   * ── L'APPARTENANCE — PAR LE GRAPHE INTERNE, JAMAIS PAR LES METADATA ──────
   *
   * ══ CE QUI A CHANGÉ EN L10.7, ET POURQUOI ════════════════════════════════
   *
   * On interrogeait le registre de liens sur UNE SEULE ressource : celle que
   * le normalisateur avait retenue sur la charge utile. Quand Stripe a cessé
   * d'émettre `invoice.payment_intent` à plat, une facture de prestation
   * ponctuelle s'est retrouvée sans abonnement ET sans intention : plus aucune
   * ressource à interroger, donc `UNOWNED / NO_OWNERSHIP_RESOURCE` — alors que
   * le Panel possédait la session qui avait produit ce paiement, et l'avait
   * écrite de sa propre main.
   *
   * La résolution consulte désormais TOUTES les identités corrélables du fait,
   * dans un ordre figé, et n'accepte qu'un LIEN comme preuve. Voir
   * `stripeRevenueOwnership.js` — en particulier pourquoi le client en est
   * exclu, et pourquoi l'absence de preuve reste `UNOWNED`.
   */
  const appartenance = await resolveStripeRevenueOwnership(fait);

  if (appartenance.outcome === OWNERSHIP_OUTCOME.NO_CANDIDATE) {
    /**
     * AUCUNE RESSOURCE CORRÉLABLE — il n'y a rien à chercher, et rien à
     * attendre. C'est le seul cas où `UNOWNED` est un verdict et non une
     * étape : ce fait ne porte aucune identité que le graphe puisse relier.
     */
    return marquer(fait, PROJECTION_STATUS.UNOWNED, SKIP_REASON.NO_OWNERSHIP_RESOURCE);
  }

  if (appartenance.outcome === OWNERSHIP_OUTCOME.REVOKED) {
    return marquer(fait, PROJECTION_STATUS.REVOKED, SKIP_REASON.BINDING_REVOKED);
  }

  if (appartenance.outcome !== OWNERSHIP_OUTCOME.RESOLVED) {
    /**
     * PAS DE LIEN — et il reste à décider si c'est une ATTENTE ou une IMPASSE.
     *
     * Stripe n'ordonne pas ses livraisons : `invoice.paid` peut arriver avant
     * la session qui fera adopter l'abonnement ou l'intention. Tant qu'une
     * ressource APPARENTÉE est désignée, quelqu'un peut encore la faire
     * adopter : le fait reste `PENDING`, et il sera repris à ce moment-là.
     *
     * Quand le fait ne désigne que LUI-MÊME, personne n'ira le lier : le
     * verdict honnête est `UNOWNED`. Il n'est pas définitif pour autant — la
     * convergence générale réexamine aussi les `UNOWNED` (L10.7), et un
     * événement ultérieur qui enrichit la corroboration rouvre la porte.
     */
    if (!appartenance.hasRelatedCandidate) {
      logger.info(
        `[finance] revenu sans appartenance prouvable — ${fait.objectType} `
        + `${maskResourceId(fait.objectId)} (${fait.environment}) ; `
        + 'aucune ressource apparentée désignée.',
      );
      return marquer(fait, PROJECTION_STATUS.UNOWNED, SKIP_REASON.NO_OWNERSHIP_RESOURCE);
    }

    logger.info(
      `[finance] revenu en attente d'appartenance — ${fait.objectType} `
      + `${maskResourceId(fait.objectId)} (${fait.environment}) ; `
      + `${appartenance.candidates.length} candidat(s) sans lien.`,
    );
    return marquer(fait, PROJECTION_STATUS.PENDING, SKIP_REASON.NO_BINDING);
  }

  const projectId = appartenance.projectId;

  /**
   * PAR QUELLE RESSOURCE LA PREUVE A ÉTÉ FAITE — écrit sur le fait.
   *
   * Le fait pouvait n'en désigner aucune (c'était le défaut). Une fois la
   * preuve établie, on l'inscrit : sans elle, un audit ultérieur ne saurait
   * pas dire si ce revenu a été attribué par filiation Stripe ou par le
   * graphe interne, et la convergence ciblée n'aurait rien à quoi s'accrocher.
   */
  if (appartenance.via
      && (fait.ownershipResourceType !== appartenance.via.resourceType
        || fait.ownershipResourceId !== appartenance.via.resourceId)) {
    await PanelProviderRevenueFact.updateOne(
      { factId: fait.factId },
      {
        $set: {
          ownershipResourceType: appartenance.via.resourceType,
          ownershipResourceId: appartenance.via.resourceId,
        },
      },
    ).catch(() => null);
  }
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

  /**
   * L10.5 — LA PRESTATION APPREND QU'ELLE EST PAYÉE, ET SEULEMENT MAINTENANT.
   *
   * ══ POURQUOI ICI, ET DANS CE SENS ═══════════════════════════════════════
   *
   * Le revenu vient d'être écrit, une fois, par la seule voie qui en écrive.
   * La demande de paiement en reçoit l'identité — elle ne la produit pas.
   *
   * L'inverse aurait été plus court à écrire : passer la demande à `PAID` au
   * retour de l'appel, et y créer la transaction. Il aurait produit DEUX
   * revenus pour un euro dès l'arrivée du webhook, c'est-à-dire exactement le
   * défaut que tout L10.3 existe pour rendre impossible.
   *
   * Best-effort : un revenu correctement projeté ne doit pas être perdu parce
   * que la demande qui l'a motivé n'a pas pu être mise à jour. La convergence
   * la reprendra, et le fait porte de quoi la retrouver.
   */
  /**
   * L10.6 — UNE FACTURE PAYÉE ÉTEINT L'INCIDENT QU'ELLE AVAIT OUVERT.
   *
   * La preuve du paiement est le fait Stripe qu'on vient de projeter, jamais un
   * bouton d'écran ni un retour de navigateur. Et la résolution ne rouvre AUCUN
   * site : elle retire une CAUSE, que SB Auto recombinera avec les siennes.
   *
   * Best-effort, comme le solde de prestation : un revenu correctement projeté
   * ne doit pas être perdu parce que l'incident n'a pas pu être mis à jour.
   */
  if (fait.objectType === CANONICAL_TYPES.INVOICE) {
    await eteintDefaut({ fait, transactionId }).catch((err) => {
      logger.warn(
        `[finance] incident de paiement non résolu pour ${maskResourceId(fait.objectId)} `
        + `(${fait.environment}) — ${err?.message ?? 'erreur inconnue'}. Le revenu, lui, est écrit.`,
      );
    });
  }

  await soldePrestation({ fait, transactionId }).catch((err) => {
    logger.warn(
      `[finance] prestation non soldée pour ${maskResourceId(fait.objectId)} `
      + `(${fait.environment}) — ${err?.message ?? 'erreur inconnue'}. Le revenu, lui, est écrit.`,
    );
  });

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

/* -------------------------------------------------------------------------- */
/*  L12 — CE QUI SUIT UN ENCAISSEMENT PROUVÉ                                  */
/* -------------------------------------------------------------------------- */

/**
 * DONNE SES SUITES À UN FAIT QUI VIENT DE DEVENIR PROJETÉ.
 *
 * ══ POURQUOI CETTE FONCTION EST ICI ET NON DANS `projectFact` ═══════════════
 *
 * Parce que `projectFact` ne parle à personne, et que l'en-tête de ce module
 * en fait une promesse : « pas un `fetch`, pas un client, pas une lecture
 * d'API ». Archiver une facture EST un téléchargement, et annoncer un
 * encaissement EST un appel de capacité. Les glisser dans la projection aurait
 * rendu l'en-tête faux — or c'est lui qu'on relit pour savoir ce qu'un
 * mouvement a pu déclencher.
 *
 * La projection décide donc, et cette fonction agit. La frontière est nette :
 * en amont, rien ne sort du Panel ; en aval, rien ne touche au registre.
 *
 * ══ CE QUI EST GARANTI INDÉPENDANT DU NAVIGATEUR ════════════════════════════
 *
 * Tout. L'appelant est un webhook signé ou une convergence de serveur ; aucune
 * redirection, aucun `session_id`, aucun retour d'onglet n'y participe. Fermer
 * la page Stripe avant le retour ne change rien à ce qui suit.
 *
 * ══ L'ORDRE N'EST PAS ARBITRAIRE ════════════════════════════════════════════
 *
 * La FACTURE d'abord, l'ANNONCE ensuite. Le message invite à ouvrir un
 * mouvement dont la pièce se télécharge : l'expédier avant l'archivage
 * enverrait le destinataire vers un justificatif absent, à l'instant précis où
 * on lui dit d'aller le voir.
 *
 * Un archivage en échec n'empêche PAS l'annonce. Le mouvement existe, il est
 * lisible, et le rattrapage posera la pièce ; retenir la notification jusqu'à
 * la réparation d'un PDF ferait dépendre une information financière de la
 * disponibilité d'un serveur de documents.
 *
 * ══ NE LÈVE JAMAIS ══════════════════════════════════════════════════════════
 *
 * Ni l'une ni l'autre des deux suites ne peut défaire un revenu écrit. Le
 * chemin qui mène ici part d'un webhook, et une exception y produirait une 500
 * — donc un rejeu du fournisseur en boucle sur un paiement parfaitement
 * encaissé.
 */
export async function settleProjectedFact(factId) {
  const rien = { archived: null, announced: null };
  try {
    const fait = await PanelProviderRevenueFact.findOne({ factId }).lean();
    if (!fait || fait.projectionStatus !== PROJECTION_STATUS.PROJECTED || !fait.transactionId) {
      return rien;
    }

    /**
     * UN REMBOURSEMENT N'A NI FACTURE NI ANNONCE D'ENCAISSEMENT.
     *
     * Le fournisseur n'émet aucun document propre à un `re_…` — c'est la
     * doctrine documentaire de L10.4 — et annoncer « un projet a payé » sur une
     * sortie d'argent serait exactement faux.
     */
    if (fait.kind === FACT_KIND.REFUND) return rien;

    const archived = await archiveInvoiceForFact(factId).catch((err) => {
      logger.warn(
        `[finance] facture non archivée pour ${maskResourceId(fait.objectId)} `
        + `(${fait.environment}) — ${err?.message ?? 'erreur inconnue'}. Le revenu, lui, est écrit.`,
      );
      return null;
    });

    const mouvement = await PanelFinancialTransaction
      .findOne({ transactionId: fait.transactionId })
      .select('transactionId projectId label amountCents currency effectiveDate projectNameSnapshot')
      .lean()
      .catch(() => null);

    const announced = await announcePaymentConfirmed({ fait, transaction: mouvement })
      .catch((err) => {
        logger.warn(
          `[finance] encaissement non annoncé pour ${maskResourceId(fait.objectId)} `
          + `(${fait.environment}) — ${err?.message ?? 'erreur inconnue'}. Le revenu, lui, est écrit.`,
        );
        return null;
      });

    return { archived, announced };
  } catch (err) {
    logger.warn(
      `[finance] suites d'encaissement non données pour ${factId} — `
      + `${err?.message ?? 'erreur inconnue'}. Le revenu, lui, est écrit.`,
    );
    return rien;
  }
}

/**
 * PROJETTE, PUIS DONNE LES SUITES. Le geste complet, en un seul appel.
 *
 * Toutes les portes qui font entrer un fait — réception d'un webhook,
 * convergence ciblée, convergence générale — passent par ici plutôt que par
 * `projectFact` seul. Sans quoi la facture et l'annonce ne suivraient que le
 * chemin du webhook, et un paiement rattrapé par convergence — c'est-à-dire
 * précisément celui qui a mal tourné — resterait sans pièce et sans message.
 */
async function projectAndSettle(factId) {
  const projete = await projectFact(factId);
  if (projete?.status === PROJECTION_STATUS.PROJECTED) await settleProjectedFact(factId);
  return projete;
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
 * LA FACTURE EST PAYÉE — l'incident correspondant s'éteint (L10.6).
 *
 * Appelée APRÈS l'écriture du revenu, jamais avant : la résolution s'appuie sur
 * un fait projeté, pas sur une intention. Sans incident ouvert pour cette
 * facture, elle ne fait rien — le cas nominal, puisque la plupart des factures
 * sont payées du premier coup.
 */
async function eteintDefaut({ fait, transactionId }) {
  const { resolveInvoiceDefault } = await import('../paymentDefaults/paymentDefaults.service.js');
  return resolveInvoiceDefault({
    environment: fait.environment,
    invoiceId: fait.objectId,
    transactionId,
    paidAt: fait.occurredAt ?? null,
  });
}

/**
 * UN ÉCHEC DE PRÉLÈVEMENT D'ABONNEMENT ENTRE DANS LE CYCLE DE DÉFAUT (L10.6).
 *
 * ══ L'APPARTENANCE D'ABORD, ET PAR LE LIEN ═════════════════════════════════
 *
 * Une facture n'a pas de lien à elle : elle hérite de celui de son ABONNEMENT,
 * exactement comme un revenu facturé (L10.3). Sans propriétaire prouvé, aucun
 * incident n'est ouvert — on ne saurait ni quelle politique de grâce appliquer,
 * ni quel site fermer.
 *
 * Les metadata ne décident de rien ici non plus : `contractId` y est lu pour
 * l'audit, le registre de liens fait autorité.
 *
 * Import DYNAMIQUE : la projection des revenus ne doit pas dépendre du domaine
 * des défauts pour projeter un encaissement.
 */
async function ingestInvoiceFailure({ environment, eventType, payload }) {
  const { normalizeInvoiceFailure } = await import(
    '../paymentDefaults/stripeInvoiceFailureNormalizer.js'
  );
  const { fait, reason } = normalizeInvoiceFailure({ eventType, payload, environment });
  if (!fait) {
    /**
     * `NOT_A_SUBSCRIPTION` est le refus le plus important du lot : une facture
     * ponctuelle — prestation L10.5, frais de lancement — ne doit JAMAIS ouvrir
     * un incident qui puisse fermer un site. Le CDC l'exclut, et le filtre est
     * ici plutôt que plus bas pour qu'aucun chemin ne le contourne.
     */
    return { recorded: false, reason };
  }

  const lien = await findBinding({
    environment,
    resourceType: STRIPE_RESOURCE_TYPES.SUBSCRIPTION,
    resourceId: fait.subscriptionId,
  });
  if (!lien || lien.revokedAt) {
    logger.info(
      `[finance] échec de prélèvement sans abonnement possédé — `
      + `${maskResourceId(fait.subscriptionId)} (${environment}). Aucun incident.`,
    );
    return { recorded: false, reason: 'SUBSCRIPTION_NOT_OWNED' };
  }

  const { recordInvoiceFailure } = await import('../paymentDefaults/paymentDefaults.service.js');
  return recordInvoiceFailure({
    ...fait,
    projectId: lien.projectId,
    contractId: fait.claimedContractId ?? null,
  });
}

/**
 * ADOPTE L'INTENTION DE PAIEMENT D'UNE SESSION POSSÉDÉE (L10.5).
 *
 * ══ POURQUOI DEPUIS LA SESSION, ET NON DEPUIS LA FACTURE ═══════════════════
 *
 * Parce que la session est la SEULE des deux dont l'appartenance soit déjà
 * prouvée : le Panel l'a créée et liée (L6.2B). La facture, elle, n'a aucun
 * lien — c'est précisément le problème qu'on résout.
 *
 * Les trois preuves de l'adoption L6.2F sont réunies à cet instant : la session
 * est possédée, l'événement est un webhook signé, et Stripe désigne lui-même la
 * filiation en portant `payment_intent` sur la session.
 *
 * ══ POURQUOI SANS ATTENDRE LE PAIEMENT ═════════════════════════════════════
 *
 * `checkout.session.completed` n'arrive QUE si la session est payée. À ce
 * moment, l'intention existe, et la facture est déjà en route — parfois déjà
 * arrivée. Adopter ici, plutôt qu'à la projection du revenu, ferme la fenêtre
 * où la facture arriverait la première et repartirait sans propriétaire.
 *
 * Ne lève jamais : une adoption manquée laisse le fait en attente, et la
 * convergence le reprendra au passage suivant.
 */
async function adoptIntentFromSession({ environment, eventType, payload }) {
  if (!String(eventType).startsWith('checkout.session.')) return;

  const session = payload?.data?.object ?? null;
  const sessionId = typeof session?.id === 'string' ? session.id : null;
  if (!sessionId) return;

  const idDe = (valeur) => {
    if (typeof valeur === 'string' && valeur.trim()) return valeur.trim();
    if (valeur && typeof valeur === 'object' && typeof valeur.id === 'string') return valeur.id;
    return null;
  };
  const intentId = idDe(session.payment_intent);
  /**
   * L10.7 — LA FACTURE QUE CETTE SESSION PRODUIT.
   *
   * ══ LE CHAÎNON QUI MANQUAIT ══════════════════════════════════════════════
   *
   * Une session `mode: payment` avec `invoice_creation` DÉSIGNE sa facture, sur
   * la charge utile, au moment où elle est payée. C'est la seule occasion où
   * les deux identités se rencontrent : la facture, elle, ne parlera jamais de
   * la session.
   *
   * On ne s'en servait pas. L'appartenance de la facture reposait donc
   * entièrement sur des champs que Stripe a depuis déplacés — et quand ils ont
   * disparu, plus rien ne reliait un revenu encaissé à son projet.
   *
   * Poser le lien ICI est l'application exacte de l'adoption par filiation
   * (L6.2F) : la session est POSSÉDÉE, l'événement est un webhook SIGNÉ, et
   * c'est Stripe lui-même qui désigne la facture. Aucune métadonnée, aucun
   * appel fournisseur, aucune corrélation devinée.
   */
  const invoiceId = idDe(session.invoice);
  if (!intentId && !invoiceId) return;

  /** LA SESSION DOIT ÊTRE POSSÉDÉE. Sans lien, aucune filiation à transmettre. */
  const lien = await findBinding({
    environment,
    resourceType: STRIPE_RESOURCE_TYPES.CHECKOUT_SESSION,
    resourceId: sessionId,
  });
  if (!lien || lien.revokedAt) return;

  /**
   * DEUX FILIATIONS, LE MÊME GESTE — et chacune converge pour son compte.
   *
   * Les traiter ensemble plutôt qu'en deux fonctions évite une asymétrie qu'on
   * paierait plus tard : c'est le MÊME instant qui prouve les deux, et un
   * ordre d'arrivée différent ne doit pas donner un résultat différent.
   */
  const filiations = [
    intentId ? { resourceType: STRIPE_RESOURCE_TYPES.PAYMENT_INTENT, resourceId: intentId } : null,
    invoiceId ? { resourceType: STRIPE_RESOURCE_TYPES.INVOICE, resourceId: invoiceId } : null,
  ].filter(Boolean);

  for (const filiation of filiations) {
    // eslint-disable-next-line no-await-in-loop
    const deja = await findBinding({
      environment,
      resourceType: filiation.resourceType,
      resourceId: filiation.resourceId,
    }).catch(() => null);

    if (!deja) {
      // eslint-disable-next-line no-await-in-loop
      await bindResource({
        projectId: lien.projectId,
        environment,
        resourceType: filiation.resourceType,
        resourceId: filiation.resourceId,
        source: BINDING_SOURCES.LEARNED_FROM_WEBHOOK,
        proof: {
          derivedFromResourceType: STRIPE_RESOURCE_TYPES.CHECKOUT_SESSION,
          derivedFromResourceId: sessionId,
        },
      }).catch((err) => {
        logger.warn(
          `[finance] filiation ${filiation.resourceType} non adoptée depuis `
          + `${maskResourceId(sessionId)} — ${err?.message ?? 'erreur inconnue'}.`,
        );
      });
    }

    /**
     * L'ADOPTION VIENT DE CRÉER UN LIEN : un fait arrivé AVANT elle peut enfin
     * trouver son projet. Même mécanisme que l'adoption d'abonnement.
     */
    // eslint-disable-next-line no-await-in-loop
    await convergePendingFactsFor({
      environment,
      resourceType: filiation.resourceType,
      resourceId: filiation.resourceId,
    }).catch(() => null);
  }
}

/**
 * SOLDE LA PRESTATION QUE CE PAIEMENT RÈGLE (L10.5).
 *
 * ══ TROIS FAÇONS DE LA RETROUVER, ET C'EST NÉCESSAIRE ══════════════════════
 *
 * La métadonnée d'abord — c'est le Panel qui l'a apposée à l'ouverture de la
 * session, et elle voyage sur la session, l'intention et la facture. Puis la
 * session, puis l'intention : Stripe n'ordonne pas ses livraisons, et
 * l'événement qui arrive en premier ne porte pas toujours les trois.
 *
 * Aucune n'est une preuve d'appartenance — celle-ci a déjà été tranchée par le
 * registre de liens, quelques lignes plus haut. Ce sont trois façons de poser
 * la même question : « de quelle demande cet euro vient-il ? ».
 *
 * Import DYNAMIQUE : la projection ne doit pas dépendre du domaine des
 * prestations pour projeter un revenu d'abonnement.
 */
async function soldePrestation({ fait, transactionId }) {
  const paymentRequestId = fait.corroboration?.paymentRequestId ?? null;
  const checkoutSessionId = fait.corroboration?.checkoutSessionId
    ?? (fait.objectType === CANONICAL_TYPES.CHECKOUT_SESSION ? fait.objectId : null);
  const paymentIntentId = fait.corroboration?.paymentIntentId ?? null;

  if (!paymentRequestId && !checkoutSessionId && !paymentIntentId) return null;

  const { markPaidFromFact } = await import('../paymentRequests/paymentRequests.service.js');
  return markPaidFromFact({
    paymentRequestId,
    checkoutSessionId,
    paymentIntentId,
    transactionId,
    environment: fait.environment,
    invoiceDocument: fait.invoiceDocument ?? null,
    paidAt: fait.occurredAt ?? null,
  });
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
/**
 * À QUELLE ENTREPRISE CLIENTE CE PROJET FACTURE-T-IL, MAINTENANT ?
 *
 * Import DYNAMIQUE : la projection de revenu ne doit pas tirer le domaine de
 * l’entreprise cliente dans son graphe de chargement — même discipline que
 * partout ailleurs dans cette couche.
 *
 * Ne LÈVE JAMAIS. Un revenu constaté est un fait : ne pas savoir le rattacher
 * à une fiche ne doit pas empêcher de l’enregistrer. Le rattachement est une
 * commodité de lecture, pas une condition d’existence.
 */
async function entrepriseClienteDe(projectId) {
  if (!projectId) return null;
  try {
    const { clientCompanyOfProject } = await import('../../clientCompany/clientCompanyReadiness.js');
    const fiche = await clientCompanyOfProject(projectId);
    return fiche?.clientCompanyId ?? null;
  } catch (err) {
    logger.warn(`[finance] entreprise cliente illisible pour ${projectId} : ${err?.message ?? 'erreur inconnue'}.`);
    return null;
  }
}

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
          /** À qui l’on a facturé — voir le modèle. `null` si rien n’est rattaché. */
          clientCompanyId: await entrepriseClienteDe(projectId),
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

  /**
   * ══ POURQUOI CE FILTRE REGARDE AUSSI LA CORROBORATION (L10.7) ════════════
   *
   * Il ne cherchait que par `ownershipResource*` — le champ que le
   * normalisateur remplit. Or le fait qui a le PLUS besoin d'être repris est
   * précisément celui qui n'a pas pu le remplir : une facture sans abonnement
   * et sans intention à plat porte `null` dans les deux colonnes.
   *
   * L'adoption de son intention ou de sa facture créait donc bien le lien
   * manquant, appelait bien cette fonction — et ne trouvait rien. Le revenu
   * restait `UNOWNED` pour toujours, avec sa preuve à côté, dans la même base.
   *
   * On interroge donc les DEUX : la ressource désignée, et les identités
   * secondaires que le fait a conservées. C'est la même question posée aux
   * deux endroits où la réponse peut se trouver.
   */
  const parRessource = { ownershipResourceType: resourceType, ownershipResourceId: resourceId };
  const parCorroboration = {
    [STRIPE_RESOURCE_TYPES.SUBSCRIPTION]: { 'corroboration.subscriptionId': resourceId },
    [STRIPE_RESOURCE_TYPES.PAYMENT_INTENT]: { 'corroboration.paymentIntentId': resourceId },
    [STRIPE_RESOURCE_TYPES.CHECKOUT_SESSION]: { 'corroboration.checkoutSessionId': resourceId },
    /** Une facture est son PROPRE objet canonique — c'est là qu'on la retrouve. */
    [STRIPE_RESOURCE_TYPES.INVOICE]: { objectType: CANONICAL_TYPES.INVOICE, objectId: resourceId },
  }[resourceType] ?? null;

  const enAttente = await PanelProviderRevenueFact.find({
    environment,
    $or: parCorroboration ? [parRessource, parCorroboration] : [parRessource],
    projectionStatus: { $in: [PROJECTION_STATUS.PENDING, PROJECTION_STATUS.UNOWNED] },
  }).select('factId').lean();

  let projected = 0;
  for (const { factId } of enAttente) {
    const res = await projectAndSettle(factId).catch((err) => {
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
  /**
   * ══ `UNOWNED` FAIT PARTIE DE CE QUI CONVERGE (L10.7) ═════════════════════
   *
   * Ce balayage ne reprenait que les faits `PENDING`. Un fait classé `UNOWNED`
   * — parce qu'au moment où il est arrivé il ne présentait aucune ressource
   * corrélable — n'était donc PLUS JAMAIS réexaminé, même quand la preuve de
   * son appartenance arrivait quelques secondes plus tard.
   *
   * C'était un état terminal de fait, sans que rien ne le déclare terminal :
   * un revenu réellement encaissé y entrait par un accident d'ordonnancement
   * et n'en sortait plus. Le seul recours était une intervention manuelle —
   * exactement ce que la projection automatique existe pour éviter.
   *
   * `UNOWNED` redevient donc ce qu'il aurait toujours dû être : un diagnostic
   * révisable. Le coût est nul quand il n'y a rien à reprendre — la résolution
   * sort sur `NO_CANDIDATE` sans toucher au registre de liens — et la garantie,
   * elle, cesse de dépendre de l'ordre dans lequel Stripe a livré ses annonces.
   */
  const enAttente = await PanelProviderRevenueFact.find({
    projectionStatus: { $in: [PROJECTION_STATUS.PENDING, PROJECTION_STATUS.UNOWNED] },
  }).sort({ firstSeenAt: 1 }).limit(limit).select('factId')
    .lean();

  let projected = 0;
  for (const { factId } of enAttente) {
    const res = await projectAndSettle(factId).catch(() => null);
    if (res?.status === PROJECTION_STATUS.PROJECTED) projected += 1;
  }

  const adoptes = await adoptMissingPaymentIntents({ limit });

  /**
   * L12 — LES FACTURES QUI MANQUENT À DES MOUVEMENTS DÉJÀ PROJETÉS.
   *
   * ══ POURQUOI ICI, AVEC LE RESTE DE LA CONVERGENCE ═══════════════════════
   *
   * Parce que c'est le même genre de retard, et qu'il se rattrape au même
   * rythme. Un Panel redémarré entre la projection et l'archivage, un PDF que
   * le fournisseur n'avait pas encore produit, un téléchargement expiré :
   * chacun laisse exactement le même état — un encaissement sans pièce — et
   * chacun se répare en repassant.
   *
   * Bornée bien plus bas que le reste : chaque unité est un téléchargement, et
   * une lecture d'écran ne doit pas déclencher cinquante requêtes sortantes.
   */
  const factures = await backfillMissingInvoiceArchives({ limit: 10 }).catch(() => null);

  return {
    examined: enAttente.length,
    projected,
    adoptedPaymentIntents: adoptes,
    invoicesArchived: factures?.archived ?? 0,
  };
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
  settleProjectedFact,
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
