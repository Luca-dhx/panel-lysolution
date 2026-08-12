/**
 * AFFICHAGE DE LA MONNAIE — le seul endroit du frontend qui divise par cent.
 *
 * ══ LA RÈGLE, EN UNE PHRASE ═════════════════════════════════════════════════
 *
 * On additionne des CENTIMES, on n'affiche que des euros. Toute addition faite
 * après une division est une addition de flottants, et c'est la porte par
 * laquelle un bénéfice cesse de tomber juste.
 *
 * ── POURQUOI CETTE DIVISION-CI EST SÛRE ─────────────────────────────────────
 * `cents / 100` produit le double le plus proche de la valeur exacte : l'erreur
 * relative est de l'ordre de 10⁻¹⁶, donc l'écart absolu reste infiniment
 * inférieur à un demi-centime pour tout montant que ce registre acceptera. Le
 * formateur arrondit ensuite à deux décimales et retrouve la valeur exacte.
 *
 * Ce qui n'est PAS sûr, et que ce module ne fera jamais, c'est de rendre ce
 * quotient à un appelant qui pourrait l'additionner. Toutes les fonctions ici
 * rendent des CHAÎNES.
 */
import type { FinanceFlow } from '@/types.finance';

const EUROS = new Intl.NumberFormat('fr-FR', {
  style: 'currency',
  currency: 'EUR',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

/** Le même format, sans le symbole — pour les axes d'un graphique. */
const NOMBRE = new Intl.NumberFormat('fr-FR', {
  minimumFractionDigits: 0,
  maximumFractionDigits: 0,
});

/** « 2 490,00 € ». Aucun signe : le sens s'affiche à part. */
export function formatCents(cents: number | null | undefined): string {
  if (cents === null || cents === undefined || Number.isNaN(cents)) return '—';
  return EUROS.format(cents / 100);
}

/**
 * LE MONTANT AVEC SON SENS — « +2 490,00 € » ou « −48,00 € ».
 *
 * Le signe vient du SENS DU FLUX, jamais du nombre stocké : les montants sont
 * tous positifs en base, et c'est ce qui garantit qu'un coût ne peut pas
 * augmenter le bénéfice par accident de saisie.
 *
 * Le caractère utilisé est le MOINS typographique (U+2212), pas le trait
 * d'union : à taille égale il s'aligne sur le plus, ce qu'un tiret ne fait pas,
 * et une colonne de montants signés se lit alors d'un coup d'œil.
 */
export function formatFlowCents(cents: number, flow: FinanceFlow): string {
  const signe = flow === 'INFLOW' ? '+' : '−';
  return `${signe}${EUROS.format(Math.abs(cents) / 100)}`;
}

/**
 * UN NET SIGNÉ — il peut être négatif, et alors il le montre.
 *
 * Un bénéfice négatif n'est pas une erreur d'affichage : c'est un mois où l'on
 * a dépensé plus qu'encaissé. Le masquer derrière une valeur absolue serait le
 * mensonge le plus coûteux que cet écran puisse faire.
 */
export function formatNetCents(cents: number): string {
  if (cents === 0) return EUROS.format(0);
  const signe = cents > 0 ? '+' : '−';
  return `${signe}${EUROS.format(Math.abs(cents) / 100)}`;
}

/** Un euro entier, sans décimale ni symbole — les graduations d'un graphique. */
export function formatCompactCents(cents: number): string {
  return NOMBRE.format(Math.round(cents / 100));
}

/** La tonalité d'un net, pour les classes de couleur du thème. */
export function netTone(cents: number): 'ok' | 'danger' | 'neutral' {
  if (cents > 0) return 'ok';
  if (cents < 0) return 'danger';
  return 'neutral';
}
