/**
 * NORMALISATION D'UN ÉVÉNEMENT STRIPE EN FAIT FINANCIER — fonction PURE.
 *
 * ══ CE MODULE N'APPELLE NI STRIPE, NI MONGO, NI L'HORLOGE ═══════════════════
 *
 * Il reçoit un événement tel que le fournisseur l'a envoyé, et rend soit un
 * FAIT normalisé, soit un refus motivé. Rien d'autre. C'est ce qui permet
 * d'éprouver, pour de vrai et sans réseau, les seules choses qui comptent ici :
 * quel objet est canonique, quel montant a RÉELLEMENT été encaissé, et quels
 * événements décrivent le même paiement.
 *
 * ══ LA DÉCISION STRUCTURANTE : QUEL OBJET EST CANONIQUE ═════════════════════
 *
 * Un seul paiement d'abonnement produit chez Stripe, en quelques secondes :
 *
 *     checkout.session.completed      (la session est payée)
 *     invoice.paid                    (la facture est réglée)
 *     payment_intent.succeeded        (l'intention a abouti)
 *     charge.succeeded                (la carte a été débitée)
 *
 * Quatre annonces, UN SEUL euro encaissé. Projeter chacune produirait un
 * quadruple comptage — le défaut le plus coûteux que ce lot puisse introduire,
 * parce qu'il est silencieux et qu'il fausse tous les totaux.
 *
 * La règle retenue, et elle se lit sur la charge utile seule :
 *
 *   · le paiement est FACTURÉ  → la FACTURE est canonique (`in_…`)
 *   · le paiement n'est pas facturé → la SESSION est canonique (`cs_…`)
 *
 * Une session d'abonnement porte `invoice` : elle désigne donc la facture, et
 * s'efface devant elle. Une session de frais de lancement (`mode: payment`) n'a
 * pas de facture : elle est canonique elle-même.
 *
 * Conséquence : `checkout.session.completed` d'un abonnement et `invoice.paid`
 * de sa première échéance produisent LA MÊME identité canonique, donc un seul
 * fait, donc une seule transaction. Ce n'est pas une déduplication a posteriori
 * — c'est la même clé, calculée par les deux chemins.
 *
 * ══ POURQUOI PAS `payment_intent.succeeded` ═════════════════════════════════
 *
 * Deux raisons, et la première suffirait : le Panel ne possède AUCUN lien sur
 * les `payment_intent` (voir `stripeEventRouting.js`), donc leur appartenance
 * n'est pas prouvable sans interroger Stripe — l'ordre inverse de la doctrine.
 * La seconde : ils décrivent le même euro qu'une facture ou une session déjà
 * canoniques. Ils sont donc reconnus, classés « corroboratifs », et ignorés.
 *
 * ══ INTENTION N'EST PAS ENCAISSEMENT ════════════════════════════════════════
 *
 * Une facture `open` de 100 € n'a rien encaissé. Une session `unpaid` non plus.
 * Ce module ne rend un fait QUE si de l'argent a réellement changé de main, et
 * le montant retenu est celui qui a été PAYÉ — jamais celui qui était dû.
 */

/** Ce qu'un événement peut être, du point de vue des finances. Fermé. */
export const FACT_KIND = Object.freeze({
  /** De l'argent est réellement entré. Le seul cas projeté par L10.3. */
  REVENUE: 'REVENUE',
  /** Un mouvement inverse — reconnu, NON projeté : c'est le lot L10.4. */
  REFUND: 'REFUND',
});

/** Pourquoi un événement ne produit pas de fait projetable. Diagnostic. */
export const NOT_A_FACT = Object.freeze({
  /** Type d'événement hors du périmètre financier. */
  NOT_FINANCIAL: 'NOT_FINANCIAL',
  /** Financier, mais rien n'a été encaissé (intention, échec, expiration). */
  NO_MONEY_MOVED: 'NO_MONEY_MOVED',
  /** Décrit un paiement dont un AUTRE objet porte l'identité canonique. */
  CORROBORATING_ONLY: 'CORROBORATING_ONLY',
  /** Charge utile inexploitable — objet absent, identifiant manquant. */
  MALFORMED: 'MALFORMED',
});

/** Les types d'objet canoniques d'un fait de revenu. */
export const CANONICAL_TYPES = Object.freeze({
  INVOICE: 'INVOICE',
  CHECKOUT_SESSION: 'CHECKOUT_SESSION',
  /**
   * L10.4 — LE REMBOURSEMENT EST SON PROPRE OBJET CANONIQUE.
   *
   * Il ne pouvait pas emprunter l'identité du paiement : deux remboursements
   * partiels du même paiement se confondraient, et l'index unique de la
   * provenance n'en garderait qu'un — le ledger perdrait de l'argent rendu.
   * `re_…` est unique chez Stripe, stable, et le même quelle que soit la voie
   * par laquelle il nous parvient : réponse d'appel, webhook, ou rejeu.
   */
  REFUND: 'REFUND',
});

/**
 * Événements qui décrivent un paiement SANS jamais en porter l'identité.
 *
 * Ils sont énumérés — et non simplement ignorés par omission — pour que la
 * recette puisse prouver qu'ils ont été VUS et écartés délibérément. Un
 * événement financier qui ne produit rien parce que personne n'y a pensé est
 * indiscernable d'un événement écarté à dessein.
 */
export const CORROBORATING_EVENTS = Object.freeze([
  'payment_intent.succeeded',
  'charge.succeeded',
  'invoice.payment_succeeded',
  'invoice.finalized',
]);

/** Événements de mouvement inverse — reconnus, réservés à L10.4. */
export const REFUND_EVENTS = Object.freeze([
  'charge.refunded',
  'charge.dispute.created',
  'credit_note.created',
]);

/* -------------------------------------------------------------------------- */
/*  Lecture défensive de la charge utile                                      */
/* -------------------------------------------------------------------------- */

/** Stripe rend tantôt un identifiant, tantôt l'objet étendu. Les deux passent. */
const idOf = (value) => {
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (value && typeof value === 'object' && typeof value.id === 'string') return value.id;
  return null;
};

/**
 * L'ABONNEMENT D'UNE FACTURE — trois emplacements selon la version d'API.
 *
 * ══ POURQUOI TROIS ══════════════════════════════════════════════════════════
 *
 * Stripe a déplacé ce champ. Jusqu'aux versions 2024, la facture portait
 * `subscription` à plat. Les versions récentes le rangent sous
 * `parent.subscription_details.subscription`, et exposent aussi la ligne de
 * facture qui le référence.
 *
 * Le compte peut être migré sans que ce code le sache — le webhook porte la
 * version d'API du compte, pas la nôtre. Lire un seul emplacement ferait donc
 * cesser toute projection d'abonnement du jour au lendemain, en silence : les
 * factures continueraient d'arriver, l'appartenance ne se résoudrait plus, et
 * les revenus disparaîtraient sans qu'aucune erreur ne soit levée.
 *
 * On lit donc les trois, dans l'ordre du plus explicite au plus dérivé.
 */
export function subscriptionIdOfInvoice(invoice) {
  return idOf(invoice?.subscription)
    ?? idOf(invoice?.parent?.subscription_details?.subscription)
    ?? idOf(invoice?.lines?.data?.[0]?.parent?.subscription_item_details?.subscription)
    ?? null;
}

/** Le libellé métier porté par la première ligne d'une facture, s'il existe. */
function invoiceLineLabel(invoice) {
  const ligne = invoice?.lines?.data?.[0];
  const description = typeof ligne?.description === 'string' ? ligne.description.trim() : '';
  return description || null;
}

/** Les metadata, lues pour CORROBORER — jamais pour décider (voir l'en-tête). */
function metadataOf(objet) {
  const m = objet?.metadata;
  return m && typeof m === 'object' ? m : {};
}

const chaine = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);
const entier = (v) => (Number.isInteger(v) ? v : null);
/** Un horodatage Stripe est en SECONDES. Le convertir ici, une fois. */
const instant = (secondes) => (Number.isFinite(secondes) ? new Date(secondes * 1000) : null);

/* -------------------------------------------------------------------------- */
/*  NORMALISATION                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Transforme un événement Stripe en fait financier canonique.
 *
 * @param {object} args
 * @param {string} args.eventType    type Stripe (`invoice.paid`…)
 * @param {object} args.payload      l'événement COMPLET tel que Stripe l'envoie
 * @param {string} args.environment  celui du RUNTIME — jamais celui du corps
 * @returns {{fact: object|null, reason: string|null}}
 */
export function normalizeStripeRevenueEvent({ eventType, payload, environment } = {}) {
  const type = String(eventType ?? '');
  const objet = payload?.data?.object ?? null;

  if (REFUND_EVENTS.includes(type)) {
    /**
     * RECONNU ICI, TRAITÉ AILLEURS.
     *
     * Cette fonction rend UN fait ; un seul `charge.refunded` peut en porter
     * plusieurs, un par remboursement du débit. L10.4 les normalise donc dans
     * `normalizeStripeRefundEvent()`, qui rend une liste. Le classement est
     * conservé tel quel pour que l'appelant sache qu'il doit l'y envoyer.
     */
    return { fact: null, reason: FACT_KIND.REFUND };
  }
  if (CORROBORATING_EVENTS.includes(type)) {
    return { fact: null, reason: NOT_A_FACT.CORROBORATING_ONLY };
  }
  if (!objet) return { fact: null, reason: NOT_A_FACT.MALFORMED };

  if (type === 'invoice.paid') return normalizeInvoice({ objet, payload, environment });
  if (type === 'checkout.session.completed' || type === 'checkout.session.async_payment_succeeded') {
    return normalizeSession({ objet, payload, environment, eventType: type });
  }
  return { fact: null, reason: NOT_A_FACT.NOT_FINANCIAL };
}

/**
 * UNE FACTURE PAYÉE — le fait canonique de tout paiement facturé.
 *
 * `amount_paid` et rien d'autre. `total` et `amount_due` décrivent ce qui était
 * ATTENDU ; une facture de 100 € réglée à 0 € (paiement en échec, avoir
 * appliqué) rendrait alors un revenu de 100 € qui n'existe pas.
 */
function normalizeInvoice({ objet, payload, environment }) {
  const invoiceId = idOf(objet);
  if (!invoiceId) return { fact: null, reason: NOT_A_FACT.MALFORMED };

  const amountPaid = entier(objet.amount_paid);
  if (!amountPaid || amountPaid <= 0) {
    return { fact: null, reason: NOT_A_FACT.NO_MONEY_MOVED };
  }

  const subscriptionId = subscriptionIdOfInvoice(objet);
  const meta = metadataOf(objet);

  return {
    fact: {
      kind: FACT_KIND.REVENUE,
      environment,
      /** L'identité canonique : c'est elle qui dédoublonne. */
      objectType: CANONICAL_TYPES.INVOICE,
      objectId: invoiceId,

      amountCents: amountPaid,
      currency: String(objet.currency ?? '').toUpperCase() || null,

      /**
       * LA DATE ÉCONOMIQUE est celle du RÈGLEMENT, pas celle de l'émission.
       * Une facture émise le 28 et payée le 2 appartient au mois du paiement —
       * c'est ce mois-là qui a vu l'argent arriver.
       */
      occurredAt: instant(objet.status_transitions?.paid_at)
        ?? instant(objet.created)
        ?? instant(payload?.created),

      label: invoiceLineLabel(objet),
      periodStart: instant(objet.lines?.data?.[0]?.period?.start),
      periodEnd: instant(objet.lines?.data?.[0]?.period?.end),

      /**
       * PAR QUELLE RESSOURCE L'APPARTENANCE SE PROUVE.
       *
       * Une facture n'a pas de lien à elle : elle en hérite de l'abonnement qui
       * l'a produite — filiation désignée par Stripe sur l'objet lui-même,
       * exactement comme l'adoption L6.2F. Aucun appel fournisseur.
       */
      ownershipVia: subscriptionId
        ? { resourceType: 'SUBSCRIPTION', resourceId: subscriptionId }
        : null,

      /** Identités secondaires — pour l'audit et pour préparer L10.4. */
      corroboration: {
        subscriptionId,
        paymentIntentId: idOf(objet.payment_intent),
        chargeId: idOf(objet.charge),
        customerId: idOf(objet.customer),
        checkoutSessionId: null,
        invoiceNumber: chaine(objet.number),
        claimedProjectId: chaine(meta.panelProjectId),
        contractId: chaine(meta.contractId),
        paymentType: chaine(meta.paymentType),
      },

      /** Ce que Stripe expose du document — voir la doctrine des justificatifs. */
      invoiceDocument: {
        invoiceId,
        number: chaine(objet.number),
        hostedUrl: chaine(objet.hosted_invoice_url),
        pdfUrl: chaine(objet.invoice_pdf),
      },

      /** Le monde déclaré par Stripe — recoupé, jamais cru. Voir le service. */
      declaredLivemode: typeof objet.livemode === 'boolean' ? objet.livemode : null,
    },
    reason: null,
  };
}

/**
 * UNE SESSION PAYÉE — canonique SEULEMENT si elle n'a pas de facture.
 *
 * ══ LE POINT QUI ÉVITE LE DOUBLE COMPTAGE ═══════════════════════════════════
 *
 * Une session d'abonnement porte `invoice`. Elle décrit donc le même euro que
 * la facture, qui, elle, est canonique. On la classe corroborative et l'on
 * n'écrit rien : la facture arrivera (ou est déjà arrivée) avec la même
 * identité canonique.
 *
 * On pourrait objecter : « et si `invoice.paid` n'arrivait jamais ? ». Il
 * arrive — Stripe l'émet pour toute session d'abonnement payée. Et s'il
 * arrivait AVANT la session, l'abonnement ne serait pas encore adopté : le fait
 * serait retenu sans propriétaire, puis projeté à l'adoption. C'est la
 * convergence, et elle est éprouvée.
 */
function normalizeSession({ objet, payload, environment, eventType }) {
  const sessionId = idOf(objet);
  if (!sessionId) return { fact: null, reason: NOT_A_FACT.MALFORMED };

  if (objet.payment_status !== 'paid') {
    return { fact: null, reason: NOT_A_FACT.NO_MONEY_MOVED };
  }

  const invoiceId = idOf(objet.invoice);
  if (invoiceId) {
    // La facture porte l'identité. Voir l'en-tête de cette fonction.
    return { fact: null, reason: NOT_A_FACT.CORROBORATING_ONLY };
  }

  const amountTotal = entier(objet.amount_total);
  if (!amountTotal || amountTotal <= 0) {
    return { fact: null, reason: NOT_A_FACT.NO_MONEY_MOVED };
  }

  const meta = metadataOf(objet);

  return {
    fact: {
      kind: FACT_KIND.REVENUE,
      environment,
      objectType: CANONICAL_TYPES.CHECKOUT_SESSION,
      objectId: sessionId,

      amountCents: amountTotal,
      currency: String(objet.currency ?? '').toUpperCase() || null,

      /**
       * Pour un paiement immédiat, l'instant de l'ÉVÉNEMENT est le plus juste :
       * la session a pu être ouverte des heures plus tôt, et `created` daterait
       * alors l'intention, pas l'encaissement. Le repli sur `created` ne sert
       * qu'aux charges utiles incomplètes.
       */
      occurredAt: instant(payload?.created) ?? instant(objet.created),

      /**
       * LE LIBELLÉ VIENT DU PANEL, PAS DE STRIPE.
       *
       * Le seul `mode: payment` que le Panel crée est le paiement de frais de
       * lancement (L6.2B). `metadata.paymentType` le confirme. C'est une
       * corroboration éditable — acceptable ICI et nulle part ailleurs : un
       * libellé faux est cosmétique, un propriétaire faux est une brèche.
       */
      label: null,
      periodStart: null,
      periodEnd: null,

      /** La session a son PROPRE lien : l'appartenance est directe (L6.2B). */
      ownershipVia: { resourceType: 'CHECKOUT_SESSION', resourceId: sessionId },

      corroboration: {
        subscriptionId: idOf(objet.subscription),
        paymentIntentId: idOf(objet.payment_intent),
        chargeId: null,
        customerId: idOf(objet.customer),
        checkoutSessionId: sessionId,
        invoiceNumber: null,
        claimedProjectId: chaine(meta.panelProjectId),
        contractId: chaine(meta.contractId),
        paymentType: chaine(meta.paymentType),
      },

      /** Une session sans facture n'a aucun document à proposer. */
      invoiceDocument: null,

      declaredLivemode: typeof objet.livemode === 'boolean' ? objet.livemode : null,
      /** Utile au diagnostic : « quel événement a produit ce fait ? ». */
      viaEventType: eventType,
    },
    reason: null,
  };
}

/* -------------------------------------------------------------------------- */
/*  L10.4 — LES REMBOURSEMENTS                                                */
/* -------------------------------------------------------------------------- */

/**
 * UN OBJET REFUND STRIPE → UN FAIT.
 *
 * ══ POURQUOI CETTE FONCTION EST LE CŒUR DE LA NON-DUPLICATION ══════════════
 *
 * Un remboursement nous parvient par TROIS voies, souvent les trois : la
 * réponse de l'appel qui l'a créé, le webhook `charge.refunded` qui suit, et un
 * éventuel rejeu d'archive. Elles arrivent dans n'importe quel ordre, et la
 * seconde précède parfois la première.
 *
 * Aucune règle d'ordonnancement ne rendrait cela sûr. Ce qui le rend sûr, c'est
 * que les trois voies traversent CETTE fonction et en ressortent avec la même
 * identité canonique — `re_…`, l'identifiant du remboursement chez Stripe.
 * L'index unique de la provenance fait le reste : le second passage met à jour,
 * il n'insère pas.
 *
 * ══ LE MONTANT EST POSITIF, ET CE N'EST PAS UNE ERREUR ═════════════════════
 *
 * Stripe rend `amount: 100` pour 1 € rendu, sans signe. Le ledger le garde tel
 * quel : c'est le `flow: OUTFLOW` qui porte le sens, jamais le signe du montant
 * (doctrine L10.1). Un montant négatif ici se soustrairait DEUX fois.
 */
export function normalizeStripeRefundObject({ refund, environment, chargeReceiptUrl = null } = {}) {
  const refundId = idOf(refund);
  if (!refundId || !refundId.startsWith('re_')) return { fact: null, reason: NOT_A_FACT.MALFORMED };

  const amount = entier(refund.amount);
  if (!amount || amount <= 0) return { fact: null, reason: NOT_A_FACT.NO_MONEY_MOVED };

  /**
   * `failed` et `canceled` n'ont RIEN rendu au client. Les projeter créerait
   * une sortie d'argent qui n'a pas eu lieu. Ils sont reconnus, pas projetés.
   */
  const status = chaine(refund.status);
  if (status === 'failed' || status === 'canceled') {
    return { fact: null, reason: NOT_A_FACT.NO_MONEY_MOVED };
  }

  const paymentIntentId = idOf(refund.payment_intent);
  const chargeId = idOf(refund.charge);

  return {
    fact: {
      kind: FACT_KIND.REFUND,
      environment,
      objectType: CANONICAL_TYPES.REFUND,
      objectId: refundId,

      amountCents: amount,
      currency: String(refund.currency ?? '').toUpperCase() || null,
      /** La date où l'argent est REPARTI — elle décide de son mois comptable. */
      occurredAt: instant(refund.created),
      label: null,
      periodStart: null,
      periodEnd: null,

      /**
       * AUCUNE FILIATION D'APPARTENANCE ICI, ET C'EST DÉLIBÉRÉ.
       *
       * Un remboursement n'hérite pas d'une session ni d'un abonnement : il
       * hérite du PAIEMENT qu'il défait, dont le Panel connaît déjà le
       * propriétaire pour l'avoir projeté (L10.3). La résolution se fait donc
       * sur nos propres écritures, par `paymentIntentId` — jamais sur une
       * métadonnée, jamais par un appel fournisseur.
       */
      ownershipVia: null,

      corroboration: {
        subscriptionId: null,
        paymentIntentId,
        chargeId,
        customerId: null,
        checkoutSessionId: null,
        invoiceNumber: null,
        claimedProjectId: null,
        contractId: null,
        paymentType: null,
      },

      /**
       * Un remboursement n'a PAS de facture, et n'en aura pas. Voir la doctrine
       * documentaire : Stripe n'émet ni PDF ni page hébergée pour un `re_…`.
       */
      invoiceDocument: null,
      /**
       * Le reçu de la CHARGE — que Stripe réédite en y portant les sommes
       * rendues. C'est le seul document réel de ce fait.
       */
      chargeReceiptUrl: chaine(chargeReceiptUrl) ?? chaine(refund.receipt_url),

      refundStatus: status,
      refundReason: chaine(refund.reason),

      declaredLivemode: typeof refund.livemode === 'boolean' ? refund.livemode : null,
    },
    reason: null,
  };
}

/**
 * UN ÉVÉNEMENT DE REMBOURSEMENT → ZÉRO, UN OU PLUSIEURS FAITS.
 *
 * ══ POURQUOI UNE LISTE ══════════════════════════════════════════════════════
 *
 * `charge.refunded` porte le DÉBIT, pas le remboursement : son objet est la
 * charge, et `refunds.data[]` en contient tous les remboursements — y compris
 * ceux déjà connus. Un troisième remboursement partiel réémet donc un événement
 * qui décrit aussi les deux premiers. Les rendre tous est correct et voulu :
 * chacun porte son `re_…`, les deux anciens convergent sans rien dupliquer, et
 * le nouveau entre. C'est le rattrapage gratuit d'un fait qu'on aurait manqué.
 *
 * ══ CE QUI RESTE HORS PÉRIMÈTRE, ET POURQUOI ═══════════════════════════════
 *
 * `charge.dispute.created` — un litige n'est pas un remboursement. L'argent
 * n'est pas rendu, il est GELÉ le temps d'une contestation qui peut se conclure
 * dans les deux sens. Le projeter en sortie inventerait une perte qui n'existe
 * pas encore, et le rétablir ensuite demanderait un mouvement inverse d'un
 * mouvement inverse. Il reste classé, non projeté.
 *
 * `credit_note.created` — un avoir est un acte COMPTABLE sur une facture, pas
 * un mouvement de trésorerie. Il accompagne parfois un remboursement, qui a
 * alors son propre `re_…` et entre par cette porte-ci. Le projeter aussi
 * compterait l'argent rendu deux fois.
 */
export function normalizeStripeRefundEvent({ eventType, payload, environment } = {}) {
  const type = String(eventType ?? '');
  /**
   * Les deux autres événements de la liste — litige et avoir — ressortent ici
   * sans fait, pour les raisons énoncées plus haut. Ils sont VUS, pas oubliés.
   */
  if (type !== 'charge.refunded') return { facts: [], reason: NOT_A_FACT.NOT_FINANCIAL };

  const charge = payload?.data?.object ?? null;
  if (!charge) return { facts: [], reason: NOT_A_FACT.MALFORMED };

  const liste = Array.isArray(charge.refunds?.data) ? charge.refunds.data : [];
  if (liste.length === 0) return { facts: [], reason: NOT_A_FACT.MALFORMED };

  const receiptUrl = chaine(charge.receipt_url);
  const paymentIntentId = idOf(charge.payment_intent);
  const chargeId = idOf(charge);

  const facts = [];
  for (const brut of liste) {
    const { fact } = normalizeStripeRefundObject({
      refund: brut, environment, chargeReceiptUrl: receiptUrl,
    });
    if (!fact) continue;
    /**
     * La charge porte des identités que l'objet imbriqué omet parfois selon la
     * version d'API. On complète — sans jamais écraser ce que le remboursement
     * affirme lui-même.
     */
    fact.corroboration.paymentIntentId = fact.corroboration.paymentIntentId ?? paymentIntentId;
    fact.corroboration.chargeId = fact.corroboration.chargeId ?? chargeId;
    fact.viaEventType = type;
    facts.push(fact);
  }

  return { facts, reason: facts.length ? null : NOT_A_FACT.NO_MONEY_MOVED };
}

export default {
  FACT_KIND,
  NOT_A_FACT,
  CANONICAL_TYPES,
  CORROBORATING_EVENTS,
  REFUND_EVENTS,
  subscriptionIdOfInvoice,
  normalizeStripeRevenueEvent,
  normalizeStripeRefundObject,
  normalizeStripeRefundEvent,
};
