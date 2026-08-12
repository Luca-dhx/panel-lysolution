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
  category?: FinanceCategory | null;
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
