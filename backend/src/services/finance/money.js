/**
 * MONNAIE — la seule représentation d'un montant dans le Panel (L10.1).
 *
 * ══ POURQUOI CE MODULE EXISTE, ET POURQUOI IL EST SI PETIT ══════════════════
 *
 * L'audit du parc n'a trouvé AUCUNE primitive monétaire côté Panel. Les seuls
 * montants qui traversent le code sont ceux que Stripe DÉCRIT dans ses contrats
 * de lecture (`amountDue`, `amountPaid`, `unit_amount`) : ce sont des champs de
 * fournisseur, validés par zod à la frontière, jamais une convention du Panel.
 * Le registre financier ne peut donc rien réutiliser — il doit poser la
 * convention, une fois, ici.
 *
 * ══ CENTIMES ENTIERS, ET RIEN D'AUTRE ═══════════════════════════════════════
 *
 * Un montant persisté est un ENTIER de centimes. Jamais un flottant.
 *
 *     0,10 € + 0,20 €  →  10 + 20 = 30 centimes
 *
 * et non `0.1 + 0.2 === 0.30000000000000004`, qui est ce que produit toute
 * addition d'euros en JavaScript. La dérive ne se voit pas sur deux lignes ;
 * elle se voit sur une année de mouvements, dans un bénéfice net qui ne tombe
 * jamais juste et que personne ne sait expliquer.
 *
 * ── POURQUOI LES CENTIMES ET NON LES MICROS ─────────────────────────────────
 * Les micros (10⁻⁶) servent quand un prix unitaire se divise — coût à
 * l'impression, au jeton, à la seconde. Rien ici ne se divise : on enregistre
 * des mouvements de trésorerie, chacun égal à ce qui a réellement quitté ou
 * rejoint un compte. Et le jour où une transaction Stripe entrera dans ce
 * registre, elle arrivera DÉJÀ en unités mineures : la correspondance sera
 * l'identité, sans division, donc sans arrondi — c'est-à-dire sans le seul
 * endroit où un centime peut se perdre.
 *
 * ══ LA SAISIE N'EST PAS UN CALCUL ═══════════════════════════════════════════
 *
 * `parseAmountToCents` lit une chaîne, chiffre par chiffre. Elle ne multiplie
 * jamais par cent :
 *
 *     Math.round(1.005 * 100)  →  100   (et non 101)
 *
 * parce que `1.005` n'existe pas en binaire — la valeur stockée est très
 * légèrement inférieure. Un utilisateur qui saisit « 1,005 » n'a de toute façon
 * rien à faire ici : on le lui REFUSE au lieu de choisir à sa place quel
 * centime perdre.
 */
import ApiError from '../../utils/ApiError.js';

/**
 * LA DEVISE CANONIQUE — une seule, et c'est un choix, pas une limite subie.
 *
 * L.Y Solution facture en euros. Accepter d'autres devises exigerait des taux,
 * une date de conversion, une devise de consolidation et une politique
 * d'arrondi : quatre décisions comptables qu'aucun écran de ce lot ne pose.
 * Le champ `currency` existe donc sur le modèle — pour que la question puisse
 * être rouverte sans migration — mais une seule valeur est acceptée à
 * l'écriture, et les agrégats ne somment jamais deux devises.
 */
export const CANONICAL_CURRENCY = 'EUR';

/** Devises acceptées à l'écriture. Une seule aujourd'hui, et c'est explicite. */
export const SUPPORTED_CURRENCIES = Object.freeze([CANONICAL_CURRENCY]);

/** Nombre de décimales de l'unité mineure. `EUR` → 2. */
export const MINOR_UNIT_DIGITS = 2;

/**
 * PLAFOND D'UN MOUVEMENT — dix milliards d'euros.
 *
 * Ce n'est pas une opinion sur le chiffre d'affaires : c'est la borne qui
 * garantit que toute SOMME de mouvements reste un entier exact en JavaScript.
 * `Number.MAX_SAFE_INTEGER` vaut ≈ 9,007 × 10¹⁵ centimes ; un plafond de 10¹²
 * centimes par ligne laisse la place à plusieurs milliers de lignes avant que
 * l'addition ne puisse devenir approximative. Au-delà, on refuse plutôt que de
 * calculer faux en silence.
 */
export const MAX_AMOUNT_CENTS = 1_000_000_000_000;

/**
 * Lit un montant SAISI et rend des centimes entiers.
 *
 * Accepte un nombre ou une chaîne, en séparateur point ou virgule, avec ou
 * sans espaces de milliers (y compris l'espace insécable que produisent les
 * copier-coller depuis un tableur). Refuse tout le reste — dont le signe :
 * la direction d'un mouvement est portée par sa catégorie, jamais par son
 * montant (voir `PanelFinancialTransaction.model.js`).
 *
 * @param {string|number} input
 * @param {string} [champ] nom du champ, pour que le refus soit lisible
 * @returns {number} centimes, entier strictement positif
 */
export function parseAmountToCents(input, champ = 'montant') {
  if (input === null || input === undefined || input === '') {
    throw ApiError.badRequest(
      'PANEL_FINANCE_AMOUNT_REQUIRED',
      `Un ${champ} est requis.`,
    );
  }

  // `String(1e21)` rend « 1e+21 » : la notation scientifique ne franchit pas le
  // gabarit ci-dessous, et c'est voulu — personne ne saisit un montant ainsi.
  const brut = String(input)
    .trim()
    .replace(/[\s  ]/g, '')
    .replace(',', '.');

  if (!/^\d{1,13}(\.\d{1,2})?$/.test(brut)) {
    throw ApiError.badRequest(
      'PANEL_FINANCE_AMOUNT_INVALID',
      `Le ${champ} doit être un nombre positif avec au plus deux décimales `
      + '(exemples : 249, 249,50). Le sens du mouvement est donné par sa catégorie, '
      + 'jamais par un signe.',
    );
  }

  const [entier, decimales = ''] = brut.split('.');
  // Concaténation, pas multiplication : aucun flottant n'entre dans le calcul.
  const cents = Number(`${entier}${(decimales + '00').slice(0, MINOR_UNIT_DIGITS)}`);

  if (!Number.isSafeInteger(cents)) {
    throw ApiError.badRequest('PANEL_FINANCE_AMOUNT_INVALID', `Le ${champ} est hors bornes.`);
  }
  if (cents <= 0) {
    throw ApiError.badRequest(
      'PANEL_FINANCE_AMOUNT_ZERO',
      `Le ${champ} doit être strictement positif : un mouvement de zéro n'est pas un mouvement.`,
    );
  }
  if (cents > MAX_AMOUNT_CENTS) {
    throw ApiError.badRequest(
      'PANEL_FINANCE_AMOUNT_TOO_LARGE',
      `Le ${champ} dépasse la borne acceptée par le registre.`,
    );
  }
  return cents;
}

/**
 * Somme des centimes — entière, associative, exacte.
 *
 * Elle existe pour que le code du Panel n'ait jamais à écrire `reduce((a, b) =>
 * a + b)` sur des montants : le jour où l'unité changerait, il n'y aurait qu'un
 * seul endroit à relire. Les agrégats de LISTE passent par MongoDB (`$sum`) et
 * n'appellent pas cette fonction — voir `financialSummary.service.js`.
 */
export function sumCents(values = []) {
  let total = 0;
  for (const value of values) {
    if (!Number.isSafeInteger(value)) {
      throw new TypeError('Une somme de centimes n’accepte que des entiers.');
    }
    total += value;
  }
  if (!Number.isSafeInteger(total)) {
    throw new RangeError('La somme dépasse la précision entière exacte.');
  }
  return total;
}

/** Valide une devise à l'écriture. Rend le code normalisé en majuscules. */
export function normalizeCurrency(value) {
  const code = String(value ?? CANONICAL_CURRENCY).trim().toUpperCase();
  if (!SUPPORTED_CURRENCIES.includes(code)) {
    throw ApiError.badRequest(
      'PANEL_FINANCE_CURRENCY_UNSUPPORTED',
      `Devise non prise en charge : ${code}. Le registre ne traite que ${SUPPORTED_CURRENCIES.join(', ')}.`,
    );
  }
  return code;
}

export default {
  CANONICAL_CURRENCY,
  SUPPORTED_CURRENCIES,
  MINOR_UNIT_DIGITS,
  MAX_AMOUNT_CENTS,
  parseAmountToCents,
  sumCents,
  normalizeCurrency,
};
