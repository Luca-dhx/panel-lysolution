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
}
