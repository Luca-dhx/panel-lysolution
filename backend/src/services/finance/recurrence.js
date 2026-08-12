/**
 * RÉCURRENCE — le calendrier, et rien que le calendrier.
 *
 * ══ POURQUOI CE MODULE EST PUR ══════════════════════════════════════════════
 *
 * Il ne connaît ni Mongo, ni Express, ni l'horloge du système. Toutes ses
 * fonctions reçoivent leur `now`. C'est la seule façon d'éprouver pour de vrai
 * ce qui casse un moteur de récurrence : le 31 janvier, le 29 février, la nuit
 * du changement d'heure, et la reprise après quatre mois d'arrêt. Aucun de ces
 * cas ne se teste en attendant que la date arrive.
 *
 * ══ UN MOIS N'EST PAS TRENTE JOURS ══════════════════════════════════════════
 *
 * `1 MONTH ≠ 30 DAYS`, `1 YEAR ≠ 365 DAYS`. Ajouter des millisecondes ferait
 * dériver un abonnement mensuel de plusieurs jours par an, et le ferait changer
 * de mois. On progresse donc sur le CALENDRIER local d'Europe/Paris — le même
 * que celui des périodes (`period.js`), délibérément : deux calendriers dans un
 * même module financier finiraient par ranger un mouvement dans le mauvais mois.
 *
 * ══ LA RÈGLE DES DATES IMPOSSIBLES : ANCRAGE, PAS REPORT ════════════════════
 *
 * Le 31 janvier + 1 mois n'existe pas. Deux stratégies s'offrent, et une seule
 * est juste.
 *
 *   ✗ REPORT — on décale au dernier jour valide, PUIS on repart de là :
 *       31 jan → 28 fév → 28 mars → 28 avril …
 *     Le 31 est perdu pour toujours. Un abonnement souscrit le 31 se retrouve
 *     prélevé le 28, définitivement, à cause d'un seul mois court.
 *
 *   ✓ ANCRAGE — chaque échéance est calculée depuis le DÉBUT, jamais depuis la
 *     précédente :
 *       31 jan → 28 fév → 31 mars → 30 avril → 31 mai …
 *     Le jour d'ancrage est restauré dès que le mois le permet. C'est la règle
 *     de tous les systèmes de facturation, et c'est celle qu'on applique.
 *
 * Même chose pour les années : un ancrage au 29 février 2024 donne le 28
 * février 2025, 2026, 2027 — puis de nouveau le 29 février 2028.
 *
 * Conséquence pratique : `cycleDateAt(n)` ne dépend QUE de l'ancre et de `n`.
 * Elle est donc rejouable à l'identique après n'importe quelle interruption,
 * ce qui est exactement ce dont l'idempotence a besoin.
 */
import ApiError from '../../utils/ApiError.js';
import { FINANCE_TIMEZONE, localParts, startOfLocalDay } from './period.js';

/** Les trois unités du cahier des charges. Aucune autre n'a de sens ici. */
export const RECURRENCE_UNITS = Object.freeze(['DAY', 'MONTH', 'YEAR']);

/**
 * INTERVALLE MAXIMAL — arbitraire, mais borné.
 *
 * « Tous les 9 999 mois » n'est pas une récurrence, c'est une faute de frappe.
 * La borne évite surtout qu'un intervalle absurde produise des calculs de dates
 * hors de portée de `Date`.
 */
export const MAX_INTERVAL = 366;

/**
 * BORNE DE RATTRAPAGE — le garde-fou de la récurrence mal configurée.
 *
 * Une récurrence quotidienne dont l'ancre serait tombée en 1980 réclamerait
 * seize mille occurrences. On refuse de les matérialiser d'un bloc : ni la
 * base, ni l'écran, ni l'opérateur n'y survivraient, et ce n'est de toute façon
 * pas une intention. On matérialise jusqu'à cette borne et l'on SIGNALE le
 * reste — voir `dueCycles`. Ce qui est écarté n'est jamais perdu en silence.
 */
export const MAX_CATCHUP_CYCLES = 600;

/** Valide et normalise une récurrence saisie. */
export function normalizeRecurrence({ unit, interval } = {}) {
  const u = String(unit ?? '').toUpperCase();
  if (!RECURRENCE_UNITS.includes(u)) {
    throw ApiError.badRequest(
      'PANEL_FINANCE_RECURRENCE_UNIT_UNKNOWN',
      `Unité de récurrence inconnue : ${unit}. Attendu : ${RECURRENCE_UNITS.join(', ')}.`,
    );
  }
  const n = Number(interval);
  if (!Number.isInteger(n) || n < 1 || n > MAX_INTERVAL) {
    throw ApiError.badRequest(
      'PANEL_FINANCE_RECURRENCE_INTERVAL_INVALID',
      `L'intervalle doit être un entier entre 1 et ${MAX_INTERVAL}.`,
    );
  }
  return { unit: u, interval: n };
}

/** Nombre de jours d'un mois donné — le seul endroit qui le sait. */
function daysInMonth(year, month) {
  // Le jour 0 du mois suivant EST le dernier jour de ce mois-ci.
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/**
 * LA DATE DE LA N-IÈME ÉCHÉANCE, calculée DEPUIS L'ANCRE.
 *
 * `n = 0` rend l'ancre elle-même — la première occurrence a lieu le jour du
 * démarrage, pas un cycle plus tard : un abonnement souscrit le 1er août est
 * facturé le 1er août.
 *
 * @param {{year:number, month:number, day:number}} anchor jour local d'ancrage
 * @param {{unit:string, interval:number}} recurrence
 * @param {number} n rang de l'échéance, à partir de 0
 * @returns {{year:number, month:number, day:number}} jour local de l'échéance
 */
export function cycleDayAt(anchor, { unit, interval }, n) {
  const pas = interval * n;

  if (unit === 'DAY') {
    // Arithmétique de CALENDRIER, pas de millisecondes : un changement d'heure
    // ne doit jamais faire glisser une échéance d'un jour.
    const curseur = new Date(Date.UTC(anchor.year, anchor.month - 1, anchor.day));
    curseur.setUTCDate(curseur.getUTCDate() + pas);
    return {
      year: curseur.getUTCFullYear(),
      month: curseur.getUTCMonth() + 1,
      day: curseur.getUTCDate(),
    };
  }

  const moisAjoutes = unit === 'YEAR' ? pas * 12 : pas;
  const total = (anchor.year * 12) + (anchor.month - 1) + moisAjoutes;
  const year = Math.floor(total / 12);
  const month = (total % 12) + 1;
  // LE JOUR D'ANCRAGE EST RESTAURÉ dès que le mois le permet — voir l'en-tête.
  const day = Math.min(anchor.day, daysInMonth(year, month));
  return { year, month, day };
}

/** L'instant absolu d'une échéance : minuit, heure de Paris. */
export function cycleInstantAt(anchor, recurrence, n) {
  const jour = cycleDayAt(anchor, recurrence, n);
  return startOfLocalDay(jour.year, jour.month, jour.day);
}

/**
 * LA CLÉ D'UN CYCLE — `AAAA-MM-JJ`, le jour local de l'échéance.
 *
 * ══ POURQUOI CETTE FORME, ET PAS UN RANG ════════════════════════════════════
 *
 * Un rang (`#3`) serait plus court mais dépendrait de l'ancre : décaler la date
 * de départ renommerait tous les cycles, et l'index d'unicité laisserait alors
 * passer des doublons. Le JOUR, lui, ne dépend que de lui-même — il reste
 * lisible dans un journal, dans une URL et dans un message d'erreur, et deux
 * cycles distincts ne peuvent pas le partager.
 */
export function cycleKeyOf(dayOrDate) {
  const jour = dayOrDate instanceof Date ? localParts(dayOrDate) : dayOrDate;
  const mm = String(jour.month).padStart(2, '0');
  const jj = String(jour.day).padStart(2, '0');
  return `${jour.year}-${mm}-${jj}`;
}

/** L'ancre d'une définition : le jour local de sa date de démarrage. */
export function anchorOf(startAt) {
  const p = localParts(new Date(startAt));
  return { year: p.year, month: p.month, day: p.day };
}

/**
 * LES CYCLES ÉCHUS À `now` — la primitive du rattrapage.
 *
 * ══ CE QU'ELLE GARANTIT ═════════════════════════════════════════════════════
 *
 * Elle rend TOUS les cycles dont l'instant est passé, du plus ancien au plus
 * récent, chacun avec sa vraie date. Un Panel arrêté quatre mois rend donc
 * quatre cycles distincts — jamais un seul cycle « compressé » portant quatre
 * fois le montant, qui perdrait les dates et rendrait le graphique faux.
 *
 * ══ LA BORNE, ET CE QU'ELLE NE FAIT PAS ═════════════════════════════════════
 *
 * Au-delà de `MAX_CATCHUP_CYCLES`, on s'arrête et l'on rend `overflow: true`
 * avec le nombre de cycles restants. On ne les perd pas en silence : l'appelant
 * les matérialisera au passage suivant, et l'écran peut le dire. Une borne qui
 * jette des données est pire que pas de borne du tout.
 *
 * @param {object} args
 * @param {Date} args.startAt
 * @param {{unit:string, interval:number}} args.recurrence
 * @param {Date} args.now
 * @param {string|null} [args.fromCycleKey] premier cycle à rendre (inclus).
 *        Sert à ne pas re-parcourir l'historique déjà matérialisé.
 * @param {string|null} [args.untilCycleKey] dernier cycle acceptable (inclus).
 *        C'est la borne d'un arrêt : au-delà, la récurrence ne produit plus.
 * @returns {{cycles: Array<{key:string, at:Date, index:number}>, overflow:boolean, remaining:number}}
 */
export function dueCycles({
  startAt, recurrence, now, fromCycleKey = null, untilCycleKey = null,
} = {}) {
  const ancre = anchorOf(startAt);
  const limite = now.getTime();
  const cycles = [];
  let index = 0;
  let overflow = false;
  let remaining = 0;

  // Borne dure : `MAX_INTERVAL` cycles × `MAX_CATCHUP_CYCLES` couvre tout usage
  // réel ; le multiplicateur protège la boucle d'une ancre aberrante.
  const plafondBoucle = MAX_CATCHUP_CYCLES * 10;

  for (; index < plafondBoucle; index += 1) {
    const at = cycleInstantAt(ancre, recurrence, index);
    if (at.getTime() > limite) break;

    const key = cycleKeyOf(localParts(at));
    // L'arrêt borne la SÉQUENCE, pas seulement l'écran : au-delà, plus rien
    // n'est dû, et la boucle n'a aucune raison de continuer.
    if (untilCycleKey && key > untilCycleKey) break;
    if (fromCycleKey && key < fromCycleKey) continue;

    if (cycles.length >= MAX_CATCHUP_CYCLES) {
      overflow = true;
      remaining += 1;
      continue;
    }
    cycles.push({ key, at, index });
  }

  return { cycles, overflow, remaining };
}

/**
 * LA PROCHAINE ÉCHÉANCE STRICTEMENT APRÈS `now` — affichage uniquement.
 *
 * Elle ne crée rien et n'entre dans AUCUN agrégat : un montant futur qui
 * pèserait sur le bénéfice ferait afficher une dépense qui n'a pas eu lieu.
 * `null` quand la récurrence est arrêtée au-delà de sa borne.
 */
export function nextOccurrenceAfter({ startAt, recurrence, now, untilCycleKey = null } = {}) {
  const ancre = anchorOf(startAt);
  const limite = now.getTime();
  for (let index = 0; index < MAX_CATCHUP_CYCLES * 10; index += 1) {
    const at = cycleInstantAt(ancre, recurrence, index);
    if (at.getTime() <= limite) continue;
    const key = cycleKeyOf(localParts(at));
    if (untilCycleKey && key > untilCycleKey) return null;
    return { key, at, index };
  }
  return null;
}

/**
 * LE CYCLE COURANT à `now` — le dernier cycle échu, ou `null` avant le premier.
 *
 * C'est lui que désignent « récurrence précédente » à la modification et
 * « arrêt actuel » : deux gestes qui parlent du cycle en cours, celui dont
 * l'occurrence existe déjà.
 */
export function currentCycleAt({ startAt, recurrence, now, untilCycleKey = null } = {}) {
  const ancre = anchorOf(startAt);
  const limite = now.getTime();
  let dernier = null;
  for (let index = 0; index < MAX_CATCHUP_CYCLES * 10; index += 1) {
    const at = cycleInstantAt(ancre, recurrence, index);
    if (at.getTime() > limite) break;
    const key = cycleKeyOf(localParts(at));
    if (untilCycleKey && key > untilCycleKey) break;
    dernier = { key, at, index };
  }
  return dernier;
}

/** Le fuseau de référence, réexporté pour que rien n'en suppose un autre. */
export { FINANCE_TIMEZONE };

export default {
  RECURRENCE_UNITS,
  MAX_INTERVAL,
  MAX_CATCHUP_CYCLES,
  normalizeRecurrence,
  cycleDayAt,
  cycleInstantAt,
  cycleKeyOf,
  anchorOf,
  dueCycles,
  nextOccurrenceAfter,
  currentCycleAt,
};
