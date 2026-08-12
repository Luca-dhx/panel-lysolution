/**
 * PÉRIODES — des bornes DÉTERMINISTES, calculées dans un fuseau nommé.
 *
 * ══ LE BOGUE QUE CE MODULE FERME ════════════════════════════════════════════
 *
 * « Le mois en cours » n'est pas une notion universelle : le 1er octobre à
 * 00h00 à Paris, il est encore le 30 septembre à 22h00 en UTC. Un backend
 * déployé sur un VPS réglé en UTC et un navigateur réglé sur Paris ne bornent
 * donc pas le même mois — et le total affiché change selon qui l'a calculé.
 *
 * Deux décisions ferment cela :
 *
 *   1. LE FUSEAU EST FIXE ET NOMMÉ. Ni celui du serveur, ni celui du
 *      navigateur : `Europe/Paris`, parce que c'est le fuseau dans lequel
 *      L.Y Solution facture. Déplacer le VPS ne déplacera jamais un mois
 *      comptable.
 *
 *   2. LES BORNES SONT SEMI-OUVERTES : `[début, fin[`.
 *      Aucun `23:59:59.999` n'est construit nulle part. C'est la source
 *      classique de deux défauts opposés — une transaction datée à
 *      23:59:59.9995 qui disparaît d'un mois sans apparaître dans l'autre, et
 *      une borne recopiée en `<=` qui compte le premier jour du mois suivant.
 *      Avec `début <= t < fin`, chaque instant appartient à exactement une
 *      période, par construction et non par vigilance.
 *
 * ══ AUCUNE DÉPENDANCE ═══════════════════════════════════════════════════════
 *
 * Le Panel n'embarque ni `luxon`, ni `date-fns-tz`, et n'en ajoutera pas pour
 * six bornes. `Intl.DateTimeFormat` connaît la base IANA embarquée dans Node :
 * elle sait donc où tombent les changements d'heure, y compris ceux de l'an
 * dernier. C'est elle qu'on interroge, en deux passes (voir `startOfLocalDay`).
 */
import ApiError from '../../utils/ApiError.js';

/**
 * LE FUSEAU COMPTABLE. Constante nommée, jamais `process.env` : l'architecture
 * du Panel réserve la lecture de l'environnement à `config/env.js`, et un
 * fuseau qui changerait d'un déploiement à l'autre déplacerait des mois déjà
 * clôturés.
 */
export const FINANCE_TIMEZONE = 'Europe/Paris';

export const PERIOD_KEYS = Object.freeze([
  'ALL',
  'TODAY',
  'LAST_7_DAYS',
  'LAST_30_DAYS',
  'CURRENT_MONTH',
  'CURRENT_YEAR',
  'CUSTOM',
]);

export const DEFAULT_PERIOD = 'LAST_30_DAYS';

const FORMATTER = new Intl.DateTimeFormat('en-CA', {
  timeZone: FINANCE_TIMEZONE,
  hourCycle: 'h23',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});

/**
 * Éclate un instant en composantes de calendrier LOCAL (Europe/Paris).
 *
 * EXPORTÉ depuis L10.2 : le moteur de récurrence raisonne sur le même
 * calendrier que les périodes. Deux implémentations du « quel jour est-on à
 * Paris ? » finiraient par répondre différemment une nuit de changement
 * d'heure — et un cycle mensuel tomberait alors dans le mauvais mois.
 */
export function localParts(instant) {
  const parts = {};
  for (const part of FORMATTER.formatToParts(instant)) {
    if (part.type !== 'literal') parts[part.type] = Number(part.value);
  }
  return parts;
}

/** Décalage du fuseau à cet instant précis, en millisecondes. */
function offsetAt(instant) {
  const p = localParts(instant);
  const commeSiUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return commeSiUtc - instant.getTime();
}

/**
 * Le premier instant d'un jour LOCAL, rendu en instant absolu.
 *
 * ── POURQUOI DEUX PASSES ────────────────────────────────────────────────────
 * On part du triplet naïf interprété en UTC, dont on retire le décalage. Mais
 * le décalage à retirer est celui qui règne au moment CIBLE, pas au moment de
 * départ : les deux diffèrent d'une heure les deux nuits de changement d'heure.
 * La première passe donne une estimation ; la seconde la corrige avec le
 * décalage réellement en vigueur à cette estimation. Sans elle, la nuit du
 * passage à l'heure d'hiver, « aujourd'hui » commencerait à 01h00.
 */
export function startOfLocalDay(year, month, day) {
  const naif = Date.UTC(year, month - 1, day, 0, 0, 0, 0);
  const premiere = new Date(naif - offsetAt(new Date(naif)));
  return new Date(naif - offsetAt(premiere));
}

/** Arithmétique sur le CALENDRIER local — jamais « ± 86 400 000 ms ». */
function shiftDays({ year, month, day }, delta) {
  const curseur = new Date(Date.UTC(year, month - 1, day));
  curseur.setUTCDate(curseur.getUTCDate() + delta);
  return {
    year: curseur.getUTCFullYear(),
    month: curseur.getUTCMonth() + 1,
    day: curseur.getUTCDate(),
  };
}

const JOUR_MS = 86_400_000;

/**
 * GRANULARITÉ DU GRAPHIQUE — déduite de l'amplitude, jamais demandée.
 *
 * Trois cent soixante-cinq barres sur une année seraient illisibles, et douze
 * barres sur une semaine seraient vides. L'écran ne choisit donc pas : il
 * affiche ce que la période impose, et le backend le lui annonce.
 */
function granularityFor(startsAt, endsAt) {
  if (!startsAt || !endsAt) return 'month';
  const jours = Math.ceil((endsAt.getTime() - startsAt.getTime()) / JOUR_MS);
  if (jours <= 62) return 'day';
  if (jours <= 732) return 'month';
  return 'year';
}

/** `YYYY-MM-DD` — le seul format de date accepté pour une borne personnalisée. */
const JOUR_ISO = /^(\d{4})-(\d{2})-(\d{2})$/;

function parseJour(valeur, champ) {
  const trouve = JOUR_ISO.exec(String(valeur ?? '').trim());
  if (!trouve) {
    throw ApiError.badRequest(
      'PANEL_FINANCE_PERIOD_INVALID',
      `La borne « ${champ} » doit être un jour au format AAAA-MM-JJ.`,
    );
  }
  const [, y, m, d] = trouve.map(Number);
  if (m < 1 || m > 12 || d < 1 || d > 31) {
    throw ApiError.badRequest(
      'PANEL_FINANCE_PERIOD_INVALID',
      `La borne « ${champ} » n'est pas une date valide.`,
    );
  }
  return { year: y, month: m, day: d };
}

/**
 * Résout une période en bornes absolues semi-ouvertes `[startsAt, endsAt[`.
 *
 * `startsAt` et `endsAt` valent `null` pour `ALL` — « depuis toujours » n'a pas
 * de borne, et en fabriquer une (l'an 1970, par exemple) ferait croire à un
 * filtre là où il n'y en a pas.
 *
 * @param {object} demande
 * @param {string} [demande.period]
 * @param {string} [demande.start] `AAAA-MM-JJ`, inclus  (période CUSTOM)
 * @param {string} [demande.end]   `AAAA-MM-JJ`, INCLUS  (période CUSTOM)
 * @param {Date}   [demande.now]   l'instant de référence — injectable pour les tests
 */
export function resolvePeriod({ period, start, end, now = new Date() } = {}) {
  const clef = String(period ?? DEFAULT_PERIOD).toUpperCase();
  if (!PERIOD_KEYS.includes(clef)) {
    throw ApiError.badRequest(
      'PANEL_FINANCE_PERIOD_UNKNOWN',
      `Période inconnue : ${clef}. Attendu : ${PERIOD_KEYS.join(', ')}.`,
    );
  }

  const aujourdhui = localParts(now);
  const jour = { year: aujourdhui.year, month: aujourdhui.month, day: aujourdhui.day };
  const debutDeJour = (p) => startOfLocalDay(p.year, p.month, p.day);
  // Le lendemain, et non « la fin d'aujourd'hui » : la borne haute est exclue.
  const demain = () => debutDeJour(shiftDays(jour, 1));

  let startsAt = null;
  let endsAt = null;

  switch (clef) {
    case 'ALL':
      break;
    case 'TODAY':
      startsAt = debutDeJour(jour);
      endsAt = demain();
      break;
    // « 7 jours » compte SEPT JOURS CIVILS, aujourd'hui compris — c'est ce que
    // lit un utilisateur. Reculer de sept jours pleins en couvrirait huit.
    case 'LAST_7_DAYS':
      startsAt = debutDeJour(shiftDays(jour, -6));
      endsAt = demain();
      break;
    case 'LAST_30_DAYS':
      startsAt = debutDeJour(shiftDays(jour, -29));
      endsAt = demain();
      break;
    case 'CURRENT_MONTH':
      startsAt = startOfLocalDay(jour.year, jour.month, 1);
      endsAt = jour.month === 12
        ? startOfLocalDay(jour.year + 1, 1, 1)
        : startOfLocalDay(jour.year, jour.month + 1, 1);
      break;
    case 'CURRENT_YEAR':
      startsAt = startOfLocalDay(jour.year, 1, 1);
      endsAt = startOfLocalDay(jour.year + 1, 1, 1);
      break;
    case 'CUSTOM': {
      const debut = parseJour(start, 'début');
      const fin = parseJour(end, 'fin');
      startsAt = debutDeJour(debut);
      // La borne SAISIE est inclusive — « du 1er au 31 » contient le 31. On la
      // convertit ici, une fois, en borne exclue : le lendemain du 31.
      endsAt = debutDeJour(shiftDays(fin, 1));
      if (endsAt.getTime() <= startsAt.getTime()) {
        throw ApiError.badRequest(
          'PANEL_FINANCE_PERIOD_INVALID',
          'La date de fin doit être postérieure ou égale à la date de début.',
        );
      }
      break;
    }
    default:
      break;
  }

  return {
    period: clef,
    startsAt,
    endsAt,
    timezone: FINANCE_TIMEZONE,
    granularity: granularityFor(startsAt, endsAt),
  };
}

/**
 * Lit une DATE D'EFFET saisie et rend l'instant qui la représente.
 *
 * ── POURQUOI PAS `new Date(valeur)` ─────────────────────────────────────────
 * `new Date('2026-03-15')` est interprété par la norme comme MINUIT UTC. À
 * Paris, c'est le 15 mars à 01h00 — ce qui tombe bien dans la bonne journée.
 * Mais `new Date('2026-11-15')`, minuit UTC, c'est encore le 15 à 01h00 : ça
 * marche aussi. Le piège n'apparaît que pour les fuseaux à l'ouest de
 * Greenwich, où minuit UTC est la VEILLE — et un jour, quelqu'un fera tourner
 * ce Panel ailleurs.
 *
 * On ancre donc explicitement la saisie sur le début du jour LOCAL. Une date
 * saisie « 15 mars » appartient à la période « mars », partout, toujours.
 *
 * Un horodatage complet (ISO 8601 avec heure) est accepté tel quel : il vient
 * alors d'une source qui sait ce qu'elle date — un événement fournisseur, un
 * import. Seule la saisie humaine est au format jour.
 */
export function parseBusinessDate(valeur, champ = 'date') {
  const brut = String(valeur ?? '').trim();
  if (!brut) {
    throw ApiError.badRequest('PANEL_FINANCE_DATE_REQUIRED', `Une ${champ} est requise.`);
  }
  if (JOUR_ISO.test(brut)) {
    const { year, month, day } = parseJour(brut, champ);
    const instant = startOfLocalDay(year, month, day);
    // `startOfLocalDay` accepte 2026-02-31 sans broncher (JavaScript reporte
    // au 3 mars). On refuse le report : une date inexistante est une faute de
    // saisie, pas une intention.
    const relu = localParts(instant);
    if (relu.year !== year || relu.month !== month || relu.day !== day) {
      throw ApiError.badRequest(
        'PANEL_FINANCE_DATE_INVALID',
        `La ${champ} « ${brut} » n'existe pas au calendrier.`,
      );
    }
    return instant;
  }
  const instant = new Date(brut);
  if (Number.isNaN(instant.getTime())) {
    throw ApiError.badRequest(
      'PANEL_FINANCE_DATE_INVALID',
      `La ${champ} doit être un jour au format AAAA-MM-JJ.`,
    );
  }
  return instant;
}

/** Le filtre Mongo correspondant — vide si la période n'a pas de borne. */
export function dateFilterFor({ startsAt, endsAt }) {
  if (!startsAt && !endsAt) return {};
  const borne = {};
  if (startsAt) borne.$gte = startsAt;
  if (endsAt) borne.$lt = endsAt; // STRICTEMENT inférieur — la borne haute est exclue.
  return { effectiveDate: borne };
}

export default {
  FINANCE_TIMEZONE,
  PERIOD_KEYS,
  DEFAULT_PERIOD,
  resolvePeriod,
  parseBusinessDate,
  dateFilterFor,
};
