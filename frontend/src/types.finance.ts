/**
 * REGISTRE FINANCIER — le contrat de lecture, côté écran.
 *
 * Les montants sont TOUJOURS des centimes entiers, et les champs le disent
 * (`amountCents`, `netCents`…). Le suffixe n'est pas une coquetterie : c'est ce
 * qui empêche qu'un composant additionne des euros par mégarde. La conversion
 * n'a lieu qu'à l'affichage, une fois, dans `lib/money.ts`.
 */

/** Le sens de la trésorerie — il décide du SIGNE, et de rien d'autre. */
export type FinanceFlow = 'INFLOW' | 'OUTFLOW';

/** La nature comptable — elle décide du TOTAL dans lequel la ligne est comptée. */
export type FinanceCategory = 'REVENUE' | 'COST' | 'REFUND' | 'ADJUSTMENT';

/** Le mécanisme qui a produit le mouvement. Seul `MANUAL` existe en L10.1. */
export type FinanceOrigin = 'MANUAL' | 'STRIPE' | 'RECURRING_COST' | 'INVOICE' | 'IMPORT';

export type FinanceStatus = 'RECORDED' | 'PENDING' | 'FAILED' | 'CANCELLED';

export type FinancePeriodKey =
  | 'ALL' | 'TODAY' | 'LAST_7_DAYS' | 'LAST_30_DAYS'
  | 'CURRENT_MONTH' | 'CURRENT_YEAR' | 'CUSTOM';

/** La portée d'une lecture. Explicite : aucune ne se déduit d'un champ absent. */
export type FinanceScope = 'all' | 'project' | 'company';

export type FinanceSort = 'DATE_DESC' | 'DATE_ASC' | 'AMOUNT_DESC' | 'AMOUNT_ASC';

export interface FinanceProvenance {
  provider: string | null;
  environment: 'TEST' | 'PROD' | null;
  externalId: string | null;
  externalKind: string | null;
}

/**
 * LE JUSTIFICATIF, VU DE L'ÉCRAN — une référence, jamais une adresse.
 *
 * Il n'y a délibérément aucun champ d'URL : un document privé ne se télécharge
 * que par la route authentifiée de son mouvement. Un `url` ici finirait dans un
 * `<a href>`, et ce lien-là serait copié hors de toute session.
 */
export interface TransactionReceipt {
  mediaId: string;
  attachedAt: string | null;
  attachedBy: string | null;
  /** Le nom que l'utilisateur a déposé — pour l'afficher, pas pour ouvrir. */
  filename: string | null;
  mime: string | null;
  size: number | null;
  /** Faux quand le descripteur a disparu : « référencé, indisponible ». */
  available: boolean;
}

export interface FinancialTransaction {
  transactionId: string;
  /** `null` = mouvement propre à L.Y Solution. C'est un rattachement, pas un vide. */
  projectId: string | null;
  /** Le nom du projet au moment de la saisie — pour l'audit, jamais l'autorité. */
  projectNameSnapshot: string | null;
  flow: FinanceFlow;
  category: FinanceCategory;
  origin: FinanceOrigin;
  status: FinanceStatus;
  label: string;
  description: string;
  amountCents: number;
  currency: string;
  effectiveDate: string;
  parentTransactionId: string | null;
  /**
   * `null` quand il n'y a RIEN à dire. L'écran n'affiche donc jamais quatre
   * lignes vides qui ressembleraient à des champs Stripe en attente.
   */
  provenance: FinanceProvenance | null;
  deletedAt: string | null;
  deletedBy: string | null;
  deletionReason: string | null;
  createdBy: string | null;
  updatedBy: string | null;
  createdAt: string;
  updatedAt: string;
  editable: boolean;
  notEditableReason: string | null;

  /* ── L10.2 ─────────────────────────────────────────────────────────────── */
  /** La règle qui a produit ce mouvement. `null` pour une saisie manuelle. */
  sourceId: string | null;
  /** Le cycle matérialisé (`AAAA-MM-JJ`), moitié de sa clé d'unicité. */
  cycleKey: string | null;
  sourceRevision: number | null;
  receipt: TransactionReceipt | null;

  /* ── L10.4 ─────────────────────────────────────────────────────────────── */
  /**
   * L'ÉTAT DE REMBOURSEMENT — présent SEULEMENT sur un revenu Stripe vivant.
   *
   * Absent partout ailleurs, et c'est voulu : un coût n'a pas d'état de
   * remboursement, et lui en donner un vide obligerait chaque écran à
   * distinguer « nul » de « zéro rendu ».
   */
  refund?: TransactionRefundState;

  /* ── L13 ─────────────────────────────────────────────────────────────────── */
  /**
   * L'ENCAISSEMENT NET — présent SEULEMENT sur un mouvement fournisseur.
   *
   * Absent sur une saisie manuelle, sur une occurrence de coût récurrent, et
   * sur la ligne de commission elle-même : cette dernière EST le frais, lui en
   * attacher un ferait lire « frais du frais ».
   */
  settlement?: TransactionSettlement;
  /**
   * HT / TVA / TTC tels que le DOCUMENT fournisseur les portait.
   *
   * `null` quand il n'a rien ventilé — une facture sans TVA, un remboursement.
   * Jamais recalculé depuis le taux du contrat : celui-ci est celui
   * d'aujourd'hui, la facture est celle d'un jour donné.
   */
  fiscal?: TransactionFiscal | null;
}

/**
 * CE QUE LE FOURNISSEUR A PRÉLEVÉ, ET CE QUI RESTE.
 *
 * ══ LES NOMS SONT GÉNÉRIQUES, ET C'EST UNE DÉCISION ═════════════════════════
 *
 * `provider`, `providerCostCents` — jamais `stripe…`. Le jour où un second
 * fournisseur de paiement entrera, l'écran Finances n'aura pas à être refait :
 * le nom du fournisseur est une VALEUR, pas une clé.
 *
 * ══ `PENDING` N'EST PAS ZÉRO ════════════════════════════════════════════════
 *
 * `providerCostCents: null` avec `status: 'PENDING'` signifie « le fournisseur
 * n'a pas encore arrêté ses comptes ». L'écran doit alors écrire « frais en
 * cours de récupération », JAMAIS « 0,00 € » — qui affirmerait qu'il n'a rien
 * prélevé, et que personne ne reviendrait vérifier.
 */
export interface TransactionSettlement {
  status: 'SETTLED' | 'PENDING' | 'UNAVAILABLE' | 'UNUSABLE';
  reason: string | null;
  /** `STRIPE` aujourd'hui. Une valeur, jamais une clé de champ. */
  provider: string;
  /**
   * LE SENS DU MOUVEMENT — il décide de l'opération, pas seulement des mots.
   *
   * `IN` : le fournisseur RETIENT sa commission, le compte reçoit `brut − frais`.
   * `OUT` : il la PRÉLÈVE EN PLUS, le compte perd `rendu + frais`.
   *
   * Facultatif : un Panel plus ancien ne le porte pas, et l'écran retombe alors
   * sur l'encaissement, qui est le cas de loin le plus fréquent.
   */
  direction?: 'IN' | 'OUT';
  /** Ce que le REGISTRE a inscrit — l'autorité du montant encaissé. */
  grossCents: number;
  /** Ce que le fournisseur a prélevé. `null` tant qu'il ne l'a pas dit. */
  providerCostCents: number | null;
  /** DÉRIVÉ : `gross − providerCost`. Jamais stocké, jamais un revenu. */
  netCents: number | null;
  currency: string;
  /** L'écriture de solde — la PREUVE que le frais n'a pas été calculé ici. */
  balanceTransactionId: string | null;
  /** Le mouvement de charge produit. `null` si le frais était nul. */
  providerCostTransactionId: string | null;
  /** `pending` | `available` — quand le fournisseur libère les fonds. */
  providerStatus: string | null;
  availableOn: string | null;
  /** La ventilation telle que le fournisseur la donne. Lue, jamais recomposée. */
  feeDetails: {
    type: string | null;
    description: string | null;
    amountCents: number | null;
    currency: string | null;
  }[];
}

export interface TransactionFiscal {
  netExcludingTaxCents: number | null;
  taxCents: number | null;
  grossIncludingTaxCents: number;
  /** `INVOICE` ou `CHECKOUT_SESSION` — quel document portait la ventilation. */
  source: string | null;
}

export type RefundState = 'NON_REMBOURSE' | 'PARTIELLEMENT_REMBOURSE' | 'REMBOURSE';

export interface TransactionRefundState {
  state: RefundState;
  /** Somme des remboursements VIVANTS rattachés. Calculée, jamais stockée. */
  refundedCents: number;
  remainingCents: number;
  count: number;
  /**
   * UNE DEMANDE NON CONCLUE — ce qui interdit d'en lancer une seconde.
   *
   * Tant qu'elle est là, l'écran dit « vérification en cours ». Il ne dit
   * JAMAIS « échec », et il ne propose surtout pas de recommencer : l'argent
   * est peut-être déjà parti.
   */
  pending: {
    refundRequestId: string;
    status: RefundRequestStatus;
    amountCents: number | null;
    requestedAt: string;
  } | null;
}

export type RefundRequestStatus =
  | 'REQUESTED' | 'PROCESSING' | 'SUCCEEDED' | 'FAILED' | 'UNKNOWN';

/** Les trois motifs que Stripe accepte. Aucun autre n'existe côté fournisseur. */
export type StripeRefundReason = 'duplicate' | 'fraudulent' | 'requested_by_customer';

export interface RefundRequest {
  refundRequestId: string;
  status: RefundRequestStatus;
  amountCents: number | null;
  currency: string;
  /** `re_…` — l'identité du REMBOURSEMENT, jamais celle du paiement. */
  refundId: string | null;
  providerStatus: string | null;
  transactionId: string | null;
  environment: 'TEST' | 'PROD';
  providerReason: string | null;
  operatorReason: string | null;
  failureCode: string | null;
  requestedAt: string;
  settledAt: string | null;
  attempts: number;
  requestedBy: { email: string | null; name: string | null };
}

/** Le verdict d'éligibilité — le même que celui dont le serveur se sert. */
export interface RefundEligibility {
  eligible: boolean;
  code: string | null;
  reason: string | null;
  transactionId: string;
  refund: {
    state: RefundState;
    collectedCents: number;
    refundedCents: number;
    remainingCents: number;
    currency: string;
    /** DÉRIVÉ du paiement d'origine. Jamais un choix offert à l'écran. */
    environment: 'TEST' | 'PROD';
    pending: TransactionRefundState['pending'];
  } | null;
}

export interface RefundOutcome {
  refundRequestId: string;
  status: RefundRequestStatus;
  refundId: string | null;
  providerStatus?: string | null;
  amountCents?: number;
  currency?: string;
  transactionId?: string | null;
  remainingCents?: number | null;
  converged?: boolean;
  code?: string;
  message?: string;
}

/* ══════════════════════════════════════════════════════════════════════════
   COÛTS RÉCURRENTS — des RÈGLES, pas des mouvements.
   ══════════════════════════════════════════════════════════════════════════ */

export type RecurrenceUnit = 'DAY' | 'MONTH' | 'YEAR';
export type RecurringScope = 'PROJECT' | 'COMPANY';
export type RecurringStatus = 'ACTIVE' | 'STOPPED';

/**
 * QUAND UNE MODIFICATION PREND EFFET.
 *
 *   NEXT        prochaine échéance — rien de matérialisé ne bouge
 *   CURRENT     cycle courant — l'occurrence existante est RÉVISÉE
 *   FROM_START  premier cycle — toutes les occurrences vivantes sont révisées
 */
export type RecurringEditMode = 'CURRENT' | 'NEXT' | 'FROM_START';

/**
 * QUAND UN ARRÊT PREND EFFET.
 *
 *   CURRENT  le cycle courant QUITTE les totaux, et plus rien n'est produit
 *   NEXT     le cycle courant reste, plus rien après lui
 */
export type RecurringStopMode = 'CURRENT' | 'NEXT';

export interface RecurringRevision {
  revision: number;
  effectiveFromCycleKey: string;
  label: string;
  description: string;
  amountCents: number;
  mode: RecurringEditMode | null;
  reason: string | null;
  createdAt: string;
  createdBy: string | null;
}

export interface RecurringCost {
  recurringCostId: string;
  scope: RecurringScope;
  projectId: string | null;
  projectNameSnapshot: string | null;
  /** Valeurs COURANTES — résolues depuis la dernière révision. */
  label: string;
  description: string;
  amountCents: number;
  currency: string;
  recurrence: { unit: RecurrenceUnit; interval: number };
  startAt: string;
  status: RecurringStatus;
  /**
   * PROCHAINE ÉCHÉANCE — affichage seulement.
   * Elle ne pèse sur aucun agrégat tant qu'elle n'est pas matérialisée.
   */
  nextOccurrenceAt: string | null;
  nextOccurrenceCycleKey: string | null;
  lastMaterializedCycleKey: string | null;
  effectiveUntilCycleKey: string | null;
  stoppedAt: string | null;
  stoppedBy: string | null;
  stopMode: RecurringStopMode | null;
  /** L'historique complet — c'est LUI l'archive durable, pas la chronologie. */
  revisions: RecurringRevision[];
  createdAt: string;
  createdBy: string | null;
  updatedAt: string;
  updatedBy: string | null;
}

export interface RecurringCostInput {
  scope: RecurringScope;
  projectId?: string | null;
  label: string;
  description?: string;
  amount: string;
  recurrence: { unit: RecurrenceUnit; interval: number };
  /** `AAAA-MM-JJ` — l'ancre, et la première échéance. */
  startAt: string;
}

export interface RecurringCostPatch {
  /** OBLIGATOIRE : « à partir de quand ? » n'a pas de réponse par défaut. */
  mode: RecurringEditMode;
  label?: string;
  description?: string;
  amount?: string;
  reason?: string;
}

/**
 * LE FAIT FOURNISSEUR D'UN MOUVEMENT — chargé À LA DEMANDE, sur le détail.
 *
 * Il n'apparaît jamais dans une liste : une colonne de `pi_3Q7x…` rendrait le
 * livret illisible pour la seule personne qui, une fois par trimestre, veut
 * rapprocher une ligne du tableau de bord Stripe.
 *
 * Ce n'est PAS une lecture du fournisseur : le fait a été normalisé à la
 * réception du webhook et vit en base. Cet écran fonctionne Stripe indisponible.
 */
export interface ProviderFact {
  factId: string;
  provider: string;
  environment: 'TEST' | 'PROD';
  /** L'objet CANONIQUE — celui qui porte l'identité économique du paiement. */
  objectType: string;
  objectId: string;
  occurredAt: string | null;
  periodStart: string | null;
  periodEnd: string | null;
  projectionStatus: string;
  projectedAt: string | null;
  /** Les metadata désignaient-elles un autre projet que le lien ? */
  claimMismatch: boolean;
  /** Identités secondaires — audit, et préparation des remboursements. */
  corroboration: {
    subscriptionId: string | null;
    paymentIntentId: string | null;
    chargeId: string | null;
    customerId: string | null;
    checkoutSessionId: string | null;
    invoiceNumber: string | null;
  };
  /**
   * LES ADRESSES STRIPE DE LA FACTURE — des liens du fournisseur, jamais un
   * média local. Voir la doctrine : aucune copie n'est matérialisée d'office.
   */
  invoiceDocument: {
    number: string | null;
    hostedUrl: string | null;
    pdfUrl: string | null;
  } | null;
  /**
   * L13 — L'ÉCRITURE DE SOLDE : la preuve, pas la lecture courante.
   *
   * Les chiffres (brut, frais, net) vivent sur le mouvement, sous
   * `settlement`, dans un vocabulaire générique. Ce bloc-ci porte les
   * identités FOURNISSEUR, pour qui veut rapprocher du tableau de bord Stripe.
   */
  settlement?: {
    status: string;
    reason: string | null;
    balanceTransactionId: string | null;
    providerType: string | null;
    reportingCategory: string | null;
    providerStatus: string | null;
    availableOn: string | null;
    chargeId: string | null;
    providerCostTransactionId: string | null;
    attempts: number;
    lastError: string | null;
  } | null;
  lastEventType: string | null;
  seenEventCount: number;
}

export interface FinancePeriod {
  period: FinancePeriodKey;
  /** Bornes SEMI-OUVERTES `[startsAt, endsAt[`. `null` pour « depuis toujours ». */
  startsAt: string | null;
  endsAt: string | null;
  timezone: string;
  granularity: 'day' | 'month' | 'year';
}

export interface FinanceSeriesPoint {
  bucket: string;
  inflowCents: number;
  outflowCents: number;
  netCents: number;
}

export interface FinanceSummary {
  period: FinancePeriod;
  currency: string;
  totals: {
    inflowCents: number;
    outflowCents: number;
    /** L'unique définition du bénéfice : entrées − sorties. */
    netCents: number;
  };
  byCategory: {
    revenueCents: number;
    costCents: number;
    refundCents: number;
    adjustmentCents: number;
  };
  /**
   * L13 — DE QUOI LES COÛTS SONT FAITS. Un SOUS-ENSEMBLE, jamais un ajout.
   *
   *     totalCents = providerFeeCents + otherCents = byCategory.costCents
   *
   * L'égalité est calculée par le serveur, une fois. Aucun écran ne recompose
   * ce total — et aucun ne peut donc additionner la commission aux charges dont
   * elle fait déjà partie.
   *
   * Facultatif : un Panel plus ancien ne le porte pas, et l'écran n'affiche
   * alors simplement aucune ventilation.
   */
  costs?: {
    totalCents: number;
    providerFeeCents: number;
    otherCents: number;
    byProvider: Record<string, number>;
  };
  count: number;
  series: FinanceSeriesPoint[];
}

export interface FinanceListResult {
  items: FinancialTransaction[];
  /** Ce que le filtre retient EN TOUT — `items` s'arrête à `limit`. */
  total: number;
  limit: number;
  truncated: boolean;
  period: FinancePeriod;
}

export interface FinanceProjectLine {
  projectId: string | null;
  projectNameSnapshot: string | null;
  inflowCents: number;
  outflowCents: number;
  revenueCents: number;
  costCents: number;
  /** L13 — la part des coûts qui est une commission. SOUS-ENSEMBLE de `costCents`. */
  providerFeeCents?: number;
  netCents: number;
  count: number;
}

/** Les critères d'une lecture — la MÊME forme pour la liste et pour le résumé. */
export interface FinanceCriteria {
  scope?: FinanceScope;
  projectId?: string | null;
  period?: FinancePeriodKey;
  start?: string;
  end?: string;
  /**
   * UNE CATÉGORIE, OU PLUSIEURS SÉPARÉES PAR UNE VIRGULE (L10.4).
   *
   * Le pluriel existe pour un seul écran : « Revenus », qui doit montrer les
   * encaissements ET les remboursements qui les défont. Ranger un remboursement
   * en `COST` pour le rendre visible aurait gonflé les charges — le filtre
   * s'élargit donc, plutôt que la taxonomie ne se déforme.
   */
  category?: FinanceCategory | `${FinanceCategory},${FinanceCategory}` | null;
  flow?: FinanceFlow | null;
  search?: string | null;
  sort?: FinanceSort;
  limit?: number;
  includeDeleted?: boolean;
}

/** Le corps d'une saisie manuelle — deux catégories, et pas quatre. */
export interface ManualTransactionInput {
  projectId?: string | null;
  category: 'REVENUE' | 'COST';
  label: string;
  description?: string;
  /** Saisi en euros, converti en centimes par le backend. Jamais l'inverse. */
  amount: string;
  /** `AAAA-MM-JJ` — le format que produit `<input type="date">`. */
  effectiveDate: string;
}

export interface BulkDeleteResult {
  deleted: number;
  scope: FinanceScope;
  projectId: string | null;
  /**
   * LES RÈGLES QUI SURVIVENT au vidage du livret.
   *
   * Vider le ledger n'arrête aucun abonnement : les règles actives
   * continueront de produire des coûts. Le nombre est rendu pour que l'écran
   * puisse le dire — un utilisateur qui le découvre seul conclut à un bogue.
   */
  activeRecurringCosts: number;
}

export interface BulkScopePreview {
  scope: FinanceScope;
  projectId: string | null;
  count: number;
  activeRecurringCosts: number;
}

/* ══════════════════════════════════════════════════════════════════════════
   PRESTATIONS À FACTURER (L10.5) — de l'argent RÉCLAMÉ.

   Distinct d'une transaction : une créance n'a rien eu lieu. Elle rejoint le
   ledger à un seul instant — le paiement — et pas par cette porte : par le
   webhook Stripe, la projection L10.3, et un unique revenu.
   ══════════════════════════════════════════════════════════════════════════ */

export type PaymentRequestStatus =
  | 'DRAFT' | 'OPEN' | 'PAYMENT_PENDING' | 'PAID' | 'CANCELED' | 'EXPIRED';

export interface PaymentRequest {
  paymentRequestId: string;
  projectId: string;
  projectNameSnapshot: string | null;
  label: string;
  description: string;
  /** LE SNAPSHOT FISCAL, figé à la création. Jamais recalculé. */
  netAmountCents: number;
  /** Pourcentage — celui du CONTRAT au moment de la facturation. */
  taxRate: number;
  taxAmountCents: number;
  /** Ce que Stripe débite, et ce que le ledger constatera. */
  grossAmountCents: number;
  currency: string;
  status: PaymentRequestStatus;
  environment: 'TEST' | 'PROD' | null;
  payable: boolean;
  stripe: {
    checkoutSessionId: string | null;
    paymentIntentId: string | null;
    invoiceId: string | null;
    hostedInvoiceUrl: string | null;
    invoicePdfUrl: string | null;
  };
  /** Le revenu produit. `null` tant que rien n'a été encaissé. */
  transactionId: string | null;
  reminders: {
    enabled: boolean;
    intervalDays: number;
    nextAt: string | null;
    lastSentAt: string | null;
    count: number;
    lastError: string | null;
  };
  history: { at: string; from: string | null; to: string; reason: string | null; actor: string | null }[];
  createdBy: string | null;
  createdAt: string;
  sentAt: string | null;
  paidAt: string | null;
  canceledAt: string | null;
  cancelReason: string | null;
}

export interface PaymentRequestInput {
  projectId: string;
  label: string;
  description?: string;
  /** En euros, tel que saisi. Le serveur le convertit en centimes entiers. */
  netAmount: string;
  currency?: string;
  reminders?: { enabled: boolean; intervalDays?: number };
}

/* ══════════════════════════════════════════════════════════════════════════
   IMPAYÉS D'ABONNEMENT (L10.6B-3) — QUATRE DIMENSIONS, JAMAIS FUSIONNÉES.

   Ces types décrivent ce que le SERVEUR a déjà décidé. L'écran les rend ; il
   n'en dérive rien. C'est la raison d'être du découpage : un unique champ
   « état » aurait obligé React à recomposer les nuances, et il se serait
   trompé sur le seul cas qui compte —

       paiement régularisé · cause retirée · site toujours suspendu

   — où un badge unique ment quelle que soit sa couleur.
   ══════════════════════════════════════════════════════════════════════════ */

export type PaymentDefaultStatus = 'OPEN' | 'GRACE_EXPIRED' | 'RESOLVED' | 'CLOSED';

/** Le paiement lui-même. `ENDED` = abonnement éteint SANS règlement. */
export type PaymentDimensionState = 'FAILED' | 'SETTLED' | 'ENDED';
/** `UNCONFIGURED` n'est PAS « zéro » : c'est « aucune politique n'existe ». */
export type GraceDimensionState = 'UNCONFIGURED' | 'RUNNING' | 'EXPIRED' | 'NOT_APPLICABLE';
/** La cause de suspension : demandée ≠ appliquée. La nuance porte le lot. */
export type CauseDimensionState = 'NONE' | 'REQUESTED' | 'APPLIED' | 'REMOVED';
/** `UNKNOWN` quand le projet n'a jamais publié d'instantané. Pas « OK ». */
export type SiteDimensionState = 'ACCESSIBLE' | 'SUSPENDED' | 'UNKNOWN';

export interface PaymentDefaultIncident {
  paymentDefaultId: string;
  projectId: string;
  contractId: string | null;
  environment: 'TEST' | 'PROD';
  status: PaymentDefaultStatus;
  amountDueCents: number;
  currency: string;
  invoiceNumber: string | null;
  hostedInvoiceUrl: string | null;
  invoicePdfUrl: string | null;
  firstFailedAt: string;
  lastFailedAt: string | null;
  /** OBSERVATION Stripe. Le Panel ne l'a ni choisie ni programmée. */
  nextPaymentAttemptAt: string | null;
  attemptCount: number;
  /** `null` = aucune politique. `0` = aucune clémence. JAMAIS confondus. */
  graceDaysSnapshot: number | null;
  graceDeadlineAt: string | null;
  suspensionRequestedAt: string | null;
  suspensionConfirmedAt: string | null;
  causeRemovalConfirmedAt: string | null;
  resolvedAt: string | null;
  resolution: string | null;
  transactionId: string | null;
  /** Références techniques — volet « Détails », jamais la lecture courante. */
  invoiceId: string | null;
  subscriptionId: string | null;
  paymentIntentId: string | null;
  lastFailureCode: string | null;
  demandsSuspension: boolean;
}

/** La mise en mots, décidée côté serveur par le mapper pur de présentation. */
export interface PaymentDefaultDisplay {
  paymentDefaultId: string;
  status: PaymentDefaultStatus;
  /** Le motif canonique. Défini une fois, jamais reformulé côté écran. */
  reasonLabel: string;
  /** Une phrase, PAS un verdict : les quatre dimensions restent affichées. */
  headline: string;
  /**
   * PEUT-ON RETENTER ? — verdict du serveur, jamais recalculé ici.
   * Facultatif : un Panel plus ancien ne le porte pas, et l’écran n’affiche
   * alors simplement aucun bouton.
   */
  retry?: PaymentDefaultRetryEligibility;
  payment: {
    state: PaymentDimensionState;
    label: string;
    firstFailedAt: string | null;
    lastFailedAt: string | null;
    amountDueCents: number;
    currency: string;
    invoiceNumber: string | null;
    hostedInvoiceUrl: string | null;
    invoicePdfUrl: string | null;
    attemptCount: number;
    nextPaymentAttemptAt: string | null;
    /**
     * Une date absente ne dit pas « aucune tentative prévue » : elle dit que
     * Stripe ne l'a pas communiquée. Le booléen porte cette nuance jusqu'ici
     * pour que l'écran n'ait pas à la redécouvrir.
     */
    nextAttemptKnown: boolean;
    nextAttemptLabel: string;
    resolvedAt: string | null;
  };
  grace: {
    state: GraceDimensionState;
    label: string;
    graceDaysSnapshot: number | null;
    graceDeadlineAt: string | null;
    note: string | null;
  };
  cause: {
    state: CauseDimensionState;
    label: string;
    /** L'INTENTION du Panel. */
    requestedAt: string | null;
    /** L'OBSERVATION du résultat, côté projet. Jamais déduite. */
    confirmedAt: string | null;
    removalConfirmedAt: string | null;
    appliedNow: boolean;
    note?: string;
  };
  site: {
    state: SiteDimensionState;
    label: string;
    accessible: boolean | null;
    /** Étiquette d'affichage du projet — JAMAIS une preuve financière. */
    dominantSource?: string | null;
    otherCauses: { key: string; label: string }[];
    causesKnown?: boolean;
    note?: string;
  };
  /** `null` quand la politique courante n'a pas été fournie à la lecture. */
  policy: {
    drifted: boolean;
    snapshot: number | null;
    current: number | null;
    note: string | null;
  } | null;
  technical: {
    paymentDefaultId: string;
    contractId: string | null;
    invoiceId: string | null;
    subscriptionId: string | null;
    paymentIntentId: string | null;
    transactionId: string | null;
    lastFailureCode: string | null;
    environment: string | null;
  };
}

export interface PaymentDefaultEntry {
  incident: PaymentDefaultIncident;
  display: PaymentDefaultDisplay;
}

export interface PaymentDefaultsView {
  projectId: string;
  /** Le premier incident VIVANT. `null` si le client est à jour. */
  active: PaymentDefaultEntry | null;
  /** Tous les incidents, du plus récent au plus ancien. Historique compris. */
  items: PaymentDefaultEntry[];
  /** `false` = le projet n'a jamais publié son état. Pas « site accessible ». */
  siteStatusKnown: boolean;
  contractPaymentGraceDays: number | null;
}

/**
 * PEUT-ON RETENTER CET IMPAYÉ ? — le verdict que le serveur rend à l’écran.
 *
 * `retryable: false` s’accompagne TOUJOURS d’un motif : un bouton absent
 * sans explication se lit comme une panne.
 */
export type PaymentDefaultRetryEligibility = {
  retryable: boolean;
  reason: string | null;
};

/**
 * CE QUE REND UNE TENTATIVE DEMANDÉE.
 *
 * `invoice` est l’état RELU chez Stripe, jamais une déduction. `incidentStatus`
 * est l’incident tel qu’il est ENCORE : inchangé, et c’est normal — la
 * résolution viendra du webhook, pas de cette réponse.
 */
export type PaymentDefaultRetryResult = {
  requested: boolean;
  invoice: {
    invoiceId: string;
    status: string | null;
    paid: boolean;
    attemptCount: number | null;
    amountRemaining: number | null;
    nextPaymentAttemptAt: number | null;
    hostedInvoiceUrl: string | null;
  } | null;
  incidentStatus: string;
};
