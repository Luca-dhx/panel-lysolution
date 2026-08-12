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
     * RECONNU, PAS PROJETÉ. L10.3 ne traite que les revenus ; un remboursement
     * projeté aujourd'hui devrait l'être en `REFUND / OUTFLOW`, avec un lien
     * vers le paiement d'origine que ce lot ne construit pas encore. Le rendre
     * ici, classé, permet de le TRACER sans corrompre le registre.
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

export default {
  FACT_KIND,
  NOT_A_FACT,
  CANONICAL_TYPES,
  CORROBORATING_EVENTS,
  REFUND_EVENTS,
  subscriptionIdOfInvoice,
  normalizeStripeRevenueEvent,
};
