/**
 * L'AUTORITÉ DU FRAIS STRIPE — ce qu'une écriture de solde dit, et rien de plus
 * (L13).
 *
 * ══ LE PROBLÈME QUE CE MODULE RÉSOUT ════════════════════════════════════════
 *
 * Le registre savait dire combien un client avait PAYÉ. Il ne savait pas dire
 * combien l'entreprise avait REÇU. Entre les deux, il y a la commission du
 * fournisseur de paiement — quelques centimes, quelques euros, et sur une année
 * un poste de charge qui n'existait dans aucun total.
 *
 * ══ LE FRAIS NE SE CALCULE JAMAIS — IL S'OBSERVE ════════════════════════════
 *
 * C'est l'invariant central du lot, et il n'est pas théorique. Sur le compte de
 * recette, à la même date, avec la même devise :
 *
 *     34 800 c  →  fee 547   (1,5 % + 0,25 € — carte européenne)
 *      1 200 c  →  fee  64   (3,25 % + 0,25 € — carte hors EEE)
 *
 * Deux paiements, deux barèmes. Une formule tarifaire écrite dans le Panel
 * aurait donné le premier juste et le second faux — et personne ne l'aurait vu,
 * parce qu'un écart de vingt centimes ne se remarque pas ligne à ligne. Il se
 * remarque au bilan, un an plus tard, quand plus rien n'est vérifiable.
 *
 * L'AUTORITÉ DU MONTANT EST DONC LA `balance_transaction`, et rien d'autre :
 * ni un pourcentage, ni un palier, ni une table de tarifs recopiée. Ce module
 * LIT ce que Stripe a calculé. Il ne le recalcule pas, et il ne le corrige pas.
 *
 * ══ IL NE REND RIEN PLUTÔT QUE DE RENDRE ZÉRO ═══════════════════════════════
 *
 * `fee: 0` est une donnée : Stripe affirme qu'il n'a rien prélevé. L'absence de
 * `balance_transaction` en est une autre : Stripe ne sait pas encore. Les deux
 * se ressemblent dans un écran et sont opposées dans un bilan.
 *
 * Une charge par virement ou prélèvement n'a PAS de `balance_transaction` tant
 * que les fonds ne sont pas arrivés. Écrire `0` ce jour-là inscrirait un coût
 * nul dans les comptes, puis il faudrait le corriger — c'est-à-dire réécrire
 * une écriture passée. On préfère l'état explicite `PENDING`, et la convergence.
 *
 * ══ AUCUNE E/S, AUCUNE HORLOGE ══════════════════════════════════════════════
 *
 * Ce module reçoit une charge utile et rend une observation. C'est ce qui rend
 * éprouvable, sans réseau, la seule chose qui compte ici : que le montant du
 * frais vienne du fournisseur, et qu'aucun chemin ne permette de l'inventer.
 *
 * ══ POURQUOI IL VIT DANS LA COUCHE STRIPE, ET NON DANS LES FINANCES ═════════
 *
 * Il lit des FORMES DE CHARGE UTILE STRIPE — `amount`, `fee`, `net`,
 * `fee_details`, `available_on`. C'est exactement la nature de
 * `stripeRefundAuthority.js`, son voisin : savoir ce qu'un objet du fournisseur
 * affirme, sans rien décider de comptable.
 *
 * Le placer côté finances aurait obligé l'adaptateur — qui en a besoin pour
 * répondre au contrat de la capacité — à importer le domaine financier. Le sens
 * de la dépendance serait devenu `stripe → finance`, alors que tout le dépôt le
 * pose dans l'autre sens : les finances PROJETTENT ce que le fournisseur dit.
 *
 * Ce qui reste côté finances, c'est la RÈGLE COMPTABLE — quel mouvement écrire,
 * et laquelle de deux observations l'emporte. Voir `providerSettlement.service.js`.
 */

/** Ce que l'on sait de l'encaissement NET d'un fait. Fermé, et diagnosticable. */
export const SETTLEMENT_STATUS = Object.freeze({
  /** Stripe a rendu ses chiffres. `providerFeeCents` fait foi. */
  SETTLED: 'SETTLED',
  /**
   * Le fournisseur n'a pas encore arrêté ses comptes sur ce paiement.
   * PAS « zéro » : « pas encore ». La convergence reprendra.
   */
  PENDING: 'PENDING',
  /**
   * Aucune ressource ne permet de remonter à une `balance_transaction` — un
   * paiement sans intention ni débit, une écriture d'un autre monde. Ce n'est
   * pas une attente : il n'y a rien à attendre.
   */
  UNAVAILABLE: 'UNAVAILABLE',
  /**
   * Les chiffres existent mais ne sont pas exploitables par le registre :
   * devise non gérée, ou incohérence interne du fournisseur. On refuse plutôt
   * que d'écrire un coût qu'on ne sait pas justifier.
   */
  UNUSABLE: 'UNUSABLE',
});

/** Pourquoi une observation n'a pas produit de chiffres. Nommé, jamais muet. */
export const SETTLEMENT_REASON = Object.freeze({
  /** Le fait ne porte ni intention de paiement ni débit. */
  NO_PAYMENT_REFERENCE: 'NO_PAYMENT_REFERENCE',
  /** Le débit existe, sa `balance_transaction` n'est pas encore rattachée. */
  BALANCE_TRANSACTION_PENDING: 'BALANCE_TRANSACTION_PENDING',
  /** La charge utile ne ressemble pas à une `balance_transaction`. */
  MALFORMED: 'MALFORMED',
  /** `amount − fee ≠ net` : le fournisseur se contredit. On n'arbitre pas. */
  INCONSISTENT: 'INCONSISTENT',
  /** Devise hors du périmètre du registre — jamais convertie à la volée. */
  CURRENCY_UNSUPPORTED: 'CURRENCY_UNSUPPORTED',
  /** Le monde du fait n'est pas celui que cette instance sert. */
  ENVIRONMENT_MISMATCH: 'ENVIRONMENT_MISMATCH',
});

/**
 * LE TYPE DE FRAIS, TEL QUE STRIPE LE NOMME.
 *
 * Conservé pour l'audit, jamais interprété : `stripe_fee`, `tax`,
 * `application_fee`… Le registre n'en tire aucune décision — il additionne le
 * `fee` total, qui est le seul chiffre que Stripe garantit égal à
 * `amount − net`. Ventiler soi-même reviendrait à recalculer, donc à risquer un
 * écart d'arrondi sur une donnée dont on n'est pas l'autorité.
 */
const chaine = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);
const entier = (v) => (Number.isInteger(v) ? v : null);
const instant = (secondes) => (Number.isFinite(secondes) ? new Date(secondes * 1000) : null);

/** Stripe rend tantôt un identifiant, tantôt l'objet étendu. Les deux passent. */
export const idOf = (value) => {
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (value && typeof value === 'object' && typeof value.id === 'string') return value.id;
  return null;
};

/**
 * LA VENTILATION DES FRAIS — recopiée telle quelle, bornée.
 *
 * Elle est conservée pour qu'un exploitant puisse LIRE ce que Stripe a facturé,
 * pas pour que le Panel le recompose. La borne existe parce qu'un document
 * qu'on relit à la main ne doit pas grossir sans fin : au-delà, la somme reste
 * juste — c'est `fee` qui fait foi — seule la ventilation est tronquée.
 */
export const MAX_FEE_DETAILS = 10;

function normalizeFeeDetails(details) {
  if (!Array.isArray(details)) return [];
  return details.slice(0, MAX_FEE_DETAILS).map((d) => ({
    type: chaine(d?.type),
    description: chaine(d?.description),
    amountCents: entier(d?.amount),
    currency: chaine(d?.currency)?.toUpperCase() ?? null,
    /** Le compte connecté qui a prélevé, s'il y en a un. Jamais le nôtre. */
    application: chaine(d?.application),
  }));
}

/**
 * UNE `balance_transaction` STRIPE → UNE OBSERVATION D'ENCAISSEMENT.
 *
 * ══ POURQUOI LA COHÉRENCE EST VÉRIFIÉE ICI ══════════════════════════════════
 *
 * `amount − fee = net` est une identité que Stripe respecte. La vérifier n'est
 * pas de la méfiance : c'est ce qui garantit que le registre n'écrira jamais un
 * triplet qui ne s'additionne pas. Le jour où une version d'API change le sens
 * d'un champ — c'est déjà arrivé sur `invoice.payment_intent` — on préfère un
 * refus nommé à trois nombres qui se contredisent dans un bilan.
 *
 * ══ LES SIGNES SONT CONSERVÉS TELS QUELS ════════════════════════════════════
 *
 * Un débit rend `amount > 0` ; un remboursement rend `amount < 0`. Ce module ne
 * normalise AUCUN signe — il rend ce que Stripe dit. C'est l'appelant qui
 * décide du sens comptable, parce que lui seul sait de quel fait il s'agit, et
 * parce que la doctrine du registre veut que le sens soit porté par `flow`,
 * jamais par le signe d'un montant.
 *
 * @param {object} args
 * @param {object} args.balanceTransaction  l'objet Stripe, tel qu'il arrive
 * @param {string[]} [args.supportedCurrencies]  devises que le registre accepte
 * @returns {{settlement: object|null, reason: string|null}}
 */
export function normalizeBalanceTransaction({
  balanceTransaction, supportedCurrencies = null,
} = {}) {
  const bt = balanceTransaction;
  const id = idOf(bt);
  if (!bt || typeof bt !== 'object' || !id) {
    return { settlement: null, reason: SETTLEMENT_REASON.MALFORMED };
  }

  const amount = entier(bt.amount);
  const fee = entier(bt.fee);
  const net = entier(bt.net);
  if (amount === null || fee === null || net === null) {
    return { settlement: null, reason: SETTLEMENT_REASON.MALFORMED };
  }
  if (amount - fee !== net) {
    return { settlement: null, reason: SETTLEMENT_REASON.INCONSISTENT };
  }

  const currency = chaine(bt.currency)?.toUpperCase() ?? null;
  if (!currency) return { settlement: null, reason: SETTLEMENT_REASON.MALFORMED };
  if (Array.isArray(supportedCurrencies) && !supportedCurrencies.includes(currency)) {
    return { settlement: null, reason: SETTLEMENT_REASON.CURRENCY_UNSUPPORTED };
  }

  return {
    settlement: {
      provider: 'STRIPE',
      balanceTransactionId: id,
      /** Ce que le client a versé, du point de vue du fournisseur. */
      grossCents: amount,
      /** Ce que le fournisseur a prélevé. L'AUTORITÉ, et jamais une formule. */
      providerFeeCents: fee,
      /** Ce qui a rejoint le solde. Égal à `gross − fee`, vérifié ci-dessus. */
      netCents: net,
      currency,
      /**
       * `charge`, `refund`, `payout`, `stripe_fee`… — la nature de l'écriture
       * chez le fournisseur. Conservée pour le rapprochement comptable futur,
       * jamais pour décider d'une catégorie du registre.
       */
      providerType: chaine(bt.type),
      reportingCategory: chaine(bt.reporting_category),
      /** `pending` ou `available` — quand l'argent devient disponible. */
      providerStatus: chaine(bt.status),
      availableOn: instant(bt.available_on),
      occurredAt: instant(bt.created),
      /** L'objet qui a produit cette écriture (`ch_…`, `re_…`, `po_…`). */
      sourceId: idOf(bt.source),
      /**
       * Non nul quand Stripe a converti : le registre est monodevise, il ne
       * s'en sert donc pas — mais un rapprochement comptable en aura besoin le
       * jour où une devise étrangère entrera.
       */
      exchangeRate: Number.isFinite(bt.exchange_rate) ? bt.exchange_rate : null,
      feeDetails: normalizeFeeDetails(bt.fee_details),
    },
    reason: null,
  };
}

/**
 * LA `balance_transaction` D'UNE INTENTION DE PAIEMENT ÉTENDUE.
 *
 * ══ POURQUOI CE CHEMIN, ET PAS UN AUTRE ═════════════════════════════════════
 *
 * Un fait de revenu est canoniquement une FACTURE ou une SESSION. Ni l'une ni
 * l'autre ne porte de frais : ce sont des documents, pas des mouvements de
 * solde. Le frais vit sur le DÉBIT, et le débit se rejoint depuis l'intention —
 * `payment_intent.latest_charge.balance_transaction`, une seule lecture.
 *
 * Passer par la facture aurait exigé deux appels de plus (facture → débit →
 * écriture), et se serait heurté au même déplacement de champ qui a déjà cassé
 * `invoice.payment_intent` en 2025.
 *
 * ══ « PAS ENCORE » N'EST PAS « JAMAIS » ═════════════════════════════════════
 *
 * Une intention aboutie dont le débit n'a pas encore d'écriture rend
 * `BALANCE_TRANSACTION_PENDING` — un état d'attente. Une intention sans débit
 * du tout rend `NO_PAYMENT_REFERENCE` — une impasse. Les deux appellent des
 * gestes opposés : réessayer, ou cesser.
 */
export function settlementOfPaymentIntent({ paymentIntent, supportedCurrencies = null } = {}) {
  const charge = paymentIntent?.latest_charge;
  if (!charge || typeof charge !== 'object') {
    return { settlement: null, reason: SETTLEMENT_REASON.NO_PAYMENT_REFERENCE, chargeId: idOf(charge) };
  }
  const bt = charge.balance_transaction;
  if (!bt || typeof bt !== 'object') {
    return {
      settlement: null,
      reason: SETTLEMENT_REASON.BALANCE_TRANSACTION_PENDING,
      chargeId: idOf(charge),
      balanceTransactionId: idOf(bt),
    };
  }
  const { settlement, reason } = normalizeBalanceTransaction({
    balanceTransaction: bt, supportedCurrencies,
  });
  return settlement
    ? { settlement: { ...settlement, chargeId: idOf(charge) }, reason: null, chargeId: idOf(charge) }
    : { settlement: null, reason, chargeId: idOf(charge), balanceTransactionId: idOf(bt) };
}

export default {
  SETTLEMENT_STATUS,
  SETTLEMENT_REASON,
  MAX_FEE_DETAILS,
  normalizeBalanceTransaction,
  settlementOfPaymentIntent,
  idOf,
};
