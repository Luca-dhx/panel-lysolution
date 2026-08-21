// LA VENTILATION FISCALE D'UNE LIGNE DE CONTRAT — lue, jamais recalculée.
//
// ══ LA QUESTION QUE CE MODULE TRANCHE ═══════════════════════════════════════
//
// Le Panel doit facturer « 79,99 € HT · TVA 20 % : 16,00 € · 95,99 € TTC ». Il
// ne connaissait, jusqu'ici, que le dernier des trois nombres.
//
// Deux façons d'obtenir les deux autres, et une seule est acceptable.
//
// ── CE QU'ON NE FAIT PAS : DÉDUIRE ──────────────────────────────────────────
//
//     HT = round(TTC / (1 + taux/100))
//
// La formule est juste, et le résultat peut différer de ce que le CONTRAT a
// calculé. Le contrat part du HT et arrondit la TVA (`round(HT × taux / 100)`,
// voir `computePricing` côté projet) ; la déduction part du TTC et arrondit le
// HT. Les deux chemins ne se rejoignent pas toujours au centime.
//
// Un écart d'un centime entre le contrat SIGNÉ et la facture ÉMISE est la pire
// incohérence de tout ce chantier : elle est minuscule, elle est invisible en
// recette, et elle est indéfendable devant un comptable.
//
// ── CE QU'ON FAIT : LIRE, PUIS VÉRIFIER ─────────────────────────────────────
//
// Le projet transporte désormais `amountExcludingTax`, `taxAmount` et
// `taxRate` (contrat de pont >= 1.10.0). On les LIT, et l'on VÉRIFIE que
// `HT + TVA = TTC`. Si l'égalité est fausse, on REFUSE : une ligne qui ne
// s'additionne pas ne doit pas devenir une facture.
//
// ══ ET QUAND LA PROJECTION NE PORTE RIEN ? ══════════════════════════════════
//
// C'est le cas d'un projet pas encore redéployé. On refuse de VENTILER — sans
// jamais inventer un taux, et sans jamais transformer un TTC en HT. Le refus
// est nommé, et il dit quoi faire : redéployer le projet pour qu'il publie sa
// ventilation.
//
// C'est le même arbitrage que `resolveTaxRate` pour les prestations
// ponctuelles : « il aurait été facile d'écrire `?? 20` », et cette ligne-là
// aurait facturé un taux que personne n'a décidé.
import { computeTax } from '../finance/money.js';

/** Les motifs, nommés. Rendus à l'exploitant, jamais au client. */
export const FISCAL_REFUSALS = Object.freeze({
  /** La projection ne porte pas la ventilation (projet antérieur à 1.10.0). */
  BREAKDOWN_ABSENT: 'CONTRACT_TAX_BREAKDOWN_ABSENT',
  /** `HT + TVA ≠ TTC` — la ligne ne s'additionne pas. */
  BREAKDOWN_INCOHERENT: 'CONTRACT_TAX_BREAKDOWN_INCOHERENT',
});

export class FiscalLineError extends Error {
  constructor(reason, message, details = null) {
    super(message);
    this.name = 'FiscalLineError';
    this.reason = reason;
    this.details = details;
  }
}

/**
 * UN ENTIER DE CENTIMES, ou `null` — et `null` doit RESTER `null`.
 *
 * ══ LE PIÈGE QUE CETTE FONCTION ÉVITE ═══════════════════════════════════════
 *
 *     Number(null)       →  0
 *     Number('')         →  0
 *     Number(undefined)  →  NaN
 *
 * Une projection qui porte explicitement `amountExcludingTax: null` — le cas
 * NORMAL d'un projet antérieur au contrat 1.10.0 — serait donc lue « 0 centime
 * hors taxe ». La ligne échouerait ensuite au contrôle d'addition, et le refus
 * dirait « la ventilation ne s'additionne pas » là où il faut dire « il n'y a
 * pas de ventilation ».
 *
 * Les deux refus n'envoient pas la même personne au même endroit : l'un fait
 * chercher un centime d'arrondi, l'autre fait redéployer un projet.
 */
const entier = (valeur) => {
  if (valeur === null || valeur === undefined || valeur === '') return null;
  const nombre = Number(valeur);
  return Number.isInteger(nombre) ? nombre : null;
};

/** Un nombre exploitable, ou `null`. Même piège, même remède que ci-dessus. */
const nombre = (valeur) => {
  if (valeur === null || valeur === undefined || valeur === '') return null;
  const n = Number(valeur);
  return Number.isFinite(n) ? n : null;
};

/**
 * LIT la ventilation d'une ligne tarifaire projetée.
 *
 * @param {object} ligne   `pricing.launchFee` ou `pricing.subscription`
 * @param {object} [contexte]
 * @param {number|null} [contexte.contractTaxRate]  le taux PAR DÉFAUT du contrat
 * @param {string} [contexte.label]  ce qu'on nomme dans le refus
 * @returns {{netCents:number, taxRate:number, taxCents:number, grossCents:number,
 *   currency:string}}
 * @throws {FiscalLineError}
 */
export function readFiscalLine(ligne, { contractTaxRate = null, label = 'cette ligne' } = {}) {
  const gross = entier(ligne?.amountIncludingTax);
  const net = entier(ligne?.amountExcludingTax);
  const tax = entier(ligne?.taxAmount);
  const currency = String(ligne?.currency ?? '').trim();

  /**
   * LE TAUX DE LA LIGNE PASSE DEVANT CELUI DU CONTRAT.
   *
   * Les lignes portent chacune leur taux parce qu'elles décrivent des
   * engagements distincts : des frais de mise en service et un abonnement
   * peuvent relever de régimes différents. Le taux du contrat est le DÉFAUT,
   * jamais l'autorité — il ne sert que si la ligne n'en porte pas, ce qui est
   * le cas des projections antérieures.
   */
  const rate = nombre(ligne?.taxRate) ?? nombre(contractTaxRate);

  if (net === null || tax === null || rate === null || gross === null || !currency) {
    throw new FiscalLineError(
      FISCAL_REFUSALS.BREAKDOWN_ABSENT,
      `La projection de contrat ne porte pas la ventilation fiscale de ${label} : `
      + 'montant hors taxe, montant de TVA et taux sont requis pour émettre une facture. '
      + 'Redéployez le projet pour qu’il les publie — aucun taux n’est supposé.',
      { hasNet: net !== null, hasTax: tax !== null, hasRate: rate !== null },
    );
  }

  if (net < 0 || tax < 0 || gross <= 0) {
    throw new FiscalLineError(
      FISCAL_REFUSALS.BREAKDOWN_INCOHERENT,
      `La ventilation fiscale de ${label} porte un montant négatif ou nul.`,
      { net, tax, gross },
    );
  }

  /**
   * ── LA VÉRIFICATION QUI JUSTIFIE TOUT LE MODULE ──────────────────────────
   *
   * Deux égalités, et les DEUX sont exigées :
   *
   *   HT + TVA = TTC          la ligne s'additionne ;
   *   TVA = round(HT × taux)  la TVA est bien celle du taux annoncé.
   *
   * La seconde n'est pas redondante. Sans elle, une ligne cohérente en somme
   * mais dont le taux affiché ne correspond pas au montant — 79,99 € HT,
   * 16,00 € de TVA, mais « taux : 5,5 % » — passerait, et la facture
   * mentionnerait un taux faux à côté d'un montant juste. C'est précisément le
   * genre de mention qu'un contrôle relève.
   *
   * On REFUSE plutôt que de corriger : corriger reviendrait à décider, à la
   * place du contrat, lequel des trois nombres a tort.
   */
  if (net + tax !== gross) {
    throw new FiscalLineError(
      FISCAL_REFUSALS.BREAKDOWN_INCOHERENT,
      `La ventilation fiscale de ${label} ne s’additionne pas : `
      + `${net} + ${tax} ≠ ${gross} (centimes). Aucune facture ne peut être émise sur cette base.`,
      { net, tax, gross },
    );
  }

  const attendu = computeTax({ netCents: net, taxRate: rate });
  if (attendu.taxCents !== tax) {
    throw new FiscalLineError(
      FISCAL_REFUSALS.BREAKDOWN_INCOHERENT,
      `La ventilation fiscale de ${label} annonce un taux de ${rate} % `
      + `incompatible avec son montant de TVA (${tax} centimes pour ${net} centimes hors taxe, `
      + `soit ${attendu.taxCents} attendus).`,
      { net, tax, rate, expected: attendu.taxCents },
    );
  }

  return { netCents: net, taxRate: rate, taxCents: tax, grossCents: gross, currency };
}

export default { FISCAL_REFUSALS, FiscalLineError, readFiscalLine };
