/**
 * LE VOCABULAIRE DES FINANCES, en un seul endroit.
 *
 * Le backend parle une taxonomie à deux axes (`flow` × `category`) parce qu'un
 * remboursement n'est pas un coût. L'utilisateur, lui, parle de « revenus » et
 * de « coûts ». La traduction se fait ICI, une fois : dispersée dans les
 * écrans, elle finirait par nommer la même chose de deux façons — et par faire
 * croire à deux notions là où il n'y en a qu'une.
 */
import type {
  FinanceCategory, FinanceFlow, FinanceOrigin, FinancePeriodKey, FinanceSort, FinanceStatus,
} from '@/types.finance';

/** Le libellé d'un rattachement sans projet. Jamais « — », jamais vide. */
export const LY_SOLUTION = 'L.Y Solution';

export const PERIOD_LABELS: Record<FinancePeriodKey, string> = {
  TODAY: 'Aujourd’hui',
  LAST_7_DAYS: '7 derniers jours',
  LAST_30_DAYS: '30 derniers jours',
  CURRENT_MONTH: 'Mois en cours',
  CURRENT_YEAR: 'Année en cours',
  CUSTOM: 'Période personnalisée',
  ALL: 'Depuis le début',
};

/** L'ordre du menu — du plus court au plus long, puis le cas particulier. */
export const PERIOD_ORDER: FinancePeriodKey[] = [
  'TODAY', 'LAST_7_DAYS', 'LAST_30_DAYS', 'CURRENT_MONTH', 'CURRENT_YEAR', 'ALL', 'CUSTOM',
];

export const CATEGORY_LABELS: Record<FinanceCategory, string> = {
  REVENUE: 'Revenu',
  COST: 'Coût',
  REFUND: 'Remboursement',
  ADJUSTMENT: 'Correction',
};

export const FLOW_LABELS: Record<FinanceFlow, string> = {
  INFLOW: 'Entrée',
  OUTFLOW: 'Sortie',
};

/**
 * D'OÙ VIENT LE MOUVEMENT — affiché uniquement quand ce n'est pas une saisie.
 *
 * « Saisie manuelle » n'apprend rien sur un registre qui ne contient que cela ;
 * la mention n'apparaît donc que sur le détail, où elle répond à « pourquoi ne
 * puis-je pas modifier cette ligne ? ».
 */
export const ORIGIN_LABELS: Record<FinanceOrigin, string> = {
  MANUAL: 'Saisie manuelle',
  STRIPE: 'Paiement Stripe',
  RECURRING_COST: 'Coût récurrent',
  INVOICE: 'Facture',
  IMPORT: 'Reprise d’historique',
};

export const STATUS_LABELS: Record<FinanceStatus, string> = {
  RECORDED: 'Enregistré',
  PENDING: 'En attente',
  FAILED: 'Échoué',
  CANCELLED: 'Annulé',
};

export const SORT_LABELS: Record<FinanceSort, string> = {
  DATE_DESC: 'Date — plus récent d’abord',
  DATE_ASC: 'Date — plus ancien d’abord',
  AMOUNT_DESC: 'Montant — décroissant',
  AMOUNT_ASC: 'Montant — croissant',
};

export const SORT_ORDER: FinanceSort[] = ['DATE_DESC', 'DATE_ASC', 'AMOUNT_DESC', 'AMOUNT_ASC'];

/**
 * Le nom à AFFICHER pour un rattachement.
 *
 * L'ordre de préférence n'est pas anodin : le nom VIVANT du registre d'abord,
 * l'instantané de la saisie ensuite. L'instantané existe pour survivre à la
 * disparition d'une fiche, pas pour afficher un nom périmé tant que la fiche
 * est là — un projet renommé doit se lire sous son nouveau nom.
 */
export function ownershipLabel(
  projectId: string | null,
  snapshot: string | null,
  vivants: Map<string, string>,
): string {
  if (!projectId) return LY_SOLUTION;
  return vivants.get(projectId) ?? snapshot ?? projectId;
}

/** Le jour du jour, au format que `<input type="date">` attend. */
export function todayInputValue(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Paris' }).format(new Date());
}
