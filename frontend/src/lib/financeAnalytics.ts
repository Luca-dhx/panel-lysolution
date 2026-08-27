/**
 * LES TRANSFORMATIONS DU TABLEAU DE BORD FINANCIER.
 *
 * ══ POURQUOI ELLES VIVENT ICI, ET PAS DANS LES COMPOSANTS ═══════════════════
 *
 * Parce qu'elles portent des CHIFFRES. Un graphique mal aligné se voit ; une
 * série mal construite ne se voit pas — elle se lit, et on la croit. Sorties
 * des composants, ces fonctions deviennent PURES, donc éprouvables ligne par
 * ligne, ce que la suite `tests/finance-analytics.test.js` fait.
 *
 * ══ TROIS RÈGLES QUI NE SE NÉGOCIENT PAS ════════════════════════════════════
 *
 * 1. ON N'INVENTE AUCUN TOTAL. Chaque valeur affichée vient du serveur, qui
 *    l'a calculée sur l'ENSEMBLE du périmètre. Additionner les lignes reçues
 *    par la liste — bornée par `limit` — donnerait un total plausible et faux.
 *    Rien ici n'additionne des transactions.
 *
 * 2. ON RESTE EN CENTIMES jusqu'à l'affichage. Une seule exception, documentée
 *    plus bas : les graphiques ont besoin de nombres, et un axe vertical se
 *    trace en euros. La conversion se fait AU DERNIER MOMENT, après toute
 *    addition.
 *
 * 3. ON NE FABRIQUE PAS DE TENDANCE QUAND IL N'Y A PAS DE PASSÉ. « Depuis
 *    toujours » n'a pas de période précédente ; une division par zéro n'a pas
 *    de pourcentage. Ces cas rendent `null`, et l'écran n'affiche rien —
 *    plutôt qu'un « +∞ % » ou un « +100 % » sorti de nulle part.
 */
import type {
  FinancePeriod,
  FinanceProjectLine,
  FinanceSeriesPoint,
} from '@/types.finance';

/** Le fuseau du registre financier, quand la période ne le précise pas. */
const FUSEAU_PAR_DEFAUT = 'Europe/Paris';

/**
 * UN INSTANT, RENDU EN DATE CIVILE DANS LE FUSEAU DU REGISTRE.
 *
 * `en-CA` produit `AAAA-MM-JJ`, qui est exactement la forme que la route
 * attend. Passer par `toISOString().slice(0, 10)` aurait donné la date UTC :
 * à Paris en été, un instant du 1er août à 01 h serait devenu le 31 juillet, et
 * la fenêtre de comparaison aurait glissé d'un jour deux fois par an.
 */
function dateCivile(instant: number, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(instant));
}

/* ══════════════════════════════════════════════════════════════════════════
   L'ÉVOLUTION DANS LE TEMPS
   ══════════════════════════════════════════════════════════════════════════ */

/**
 * Une ligne du graphique d'évolution.
 *
 * Les trois mesures sont en EUROS — c'est la seule conversion du module, et
 * elle est faite APRÈS que le serveur a terminé toutes ses additions. Les
 * centimes d'origine restent portés à côté : l'infobulle les reformate avec le
 * formateur monétaire du Panel, sans jamais repasser par le nombre du tracé.
 */
export interface EvolutionRow extends Record<string, unknown> {
  /** L'instant du seau. Les graphiques Bklit attendent un vrai `Date`. */
  date: Date;
  /** Libellé lisible du seau, dans le fuseau de la période. */
  label: string;
  inflow: number;
  outflow: number;
  net: number;
  inflowCents: number;
  outflowCents: number;
  netCents: number;
  /**
   * VRAI si le serveur a rendu un seau ici — FAUX si c'est nous qui l'avons
   * posé à zéro pour tenir l'axe.
   *
   * Le serveur ne renvoie QUE les périodes où il s'est passé quelque chose, et
   * il a raison de le faire : « il ne s'est rien passé » et « le solde est
   * resté à zéro » ne sont pas la même phrase, et la différence compte quand on
   * cherche un oubli de saisie.
   *
   * L'axe, lui, a besoin de tous les seaux. Ce drapeau est ce qui permet de
   * TRACER l'un sans AFFIRMER l'autre : l'infobulle d'un seau creux dit
   * « aucun mouvement », pas « 0,00 € ».
   */
  hasData: boolean;
}

/**
 * LE SEAU EST UN INSTANT, ET IL FAUT LE LIRE DANS LE FUSEAU DE LA PÉRIODE.
 *
 * ══ CE QUE LE SERVEUR REND VRAIMENT ════════════════════════════════════════
 *
 * `$dateTrunc` tronque dans `Europe/Paris`, puis `buildSeries` sérialise en
 * `toISOString()`. Un seau n'est donc PAS `2026-08-22` : c'est
 * `2026-08-21T22:00:00.000Z` — le 22 août à minuit, heure de Paris, écrit en
 * UTC.
 *
 * ══ CE QUE LE DÉCOUPAGE NAÏF EN FAISAIT ════════════════════════════════════
 *
 * Une version antérieure découpait la chaîne sur les tirets : elle lisait
 * `["2026", "08", "21T22:00:00.000Z"]`, retenait le jour 21, et affichait
 * « 21 août » pour des mouvements du 22. En granularité mensuelle, le décalage
 * portait sur le MOIS : `2026-07-31T22:00:00.000Z` est le 1er août à Paris, et
 * se lisait « juil. 26 ».
 *
 * Le chiffre était juste ; c'est la date écrite à côté qui était fausse — le
 * genre d'erreur qu'on ne voit pas, parce qu'on la croit.
 *
 * ── CE QUE CETTE FONCTION REND ─────────────────────────────────────────────
 * Une date à MIDI en heure locale du navigateur, portant les parties civiles
 * du seau telles qu'elles se lisent dans le fuseau de la période. Midi, et non
 * minuit : c'est la seule heure qui survit à un décalage d'un fuseau dans les
 * deux sens sans changer de jour — et le tracé comme l'étiquette n'ont besoin
 * que du jour.
 *
 * Une borne déjà civile (`AAAA-MM-JJ`, sans heure) est acceptée telle quelle :
 * il n'y a alors rien à convertir.
 */
export function parseBucket(bucket: string, timeZone: string = FUSEAU_PAR_DEFAUT): Date {
  const civile = bucket.includes('T')
    ? dateCivile(new Date(bucket).getTime(), timeZone)
    : bucket;
  const [annee, mois, jour] = civile.split('-').map((n) => Number.parseInt(n, 10));
  return new Date(
    annee,
    Number.isFinite(mois) ? mois - 1 : 0,
    Number.isFinite(jour) ? jour : 1,
    12, 0, 0, 0,
  );
}

const LIBELLE_JOUR = new Intl.DateTimeFormat('fr-FR', { day: '2-digit', month: 'short' });
const LIBELLE_MOIS = new Intl.DateTimeFormat('fr-FR', { month: 'short', year: '2-digit' });
const LIBELLE_ANNEE = new Intl.DateTimeFormat('fr-FR', { year: 'numeric' });

export function formatBucketLabel(date: Date, granularity: FinancePeriod['granularity']): string {
  if (granularity === 'year') return LIBELLE_ANNEE.format(date);
  if (granularity === 'month') return LIBELLE_MOIS.format(date);
  return LIBELLE_JOUR.format(date);
}

/**
 * La série du serveur, prête pour le graphique.
 *
 * `netCents` est repris TEL QUEL et jamais recalculé depuis `inflow - outflow`.
 * Les deux devraient coïncider — mais si un jour ils divergent, c'est le
 * serveur qui a raison, et l'écart doit se voir plutôt que d'être masqué par
 * une soustraction faite ici.
 */
export function toEvolutionRows(
  series: FinanceSeriesPoint[],
  granularity: FinancePeriod['granularity'],
  timeZone: string = FUSEAU_PAR_DEFAUT,
): EvolutionRow[] {
  return series.map((point) => {
    const date = parseBucket(point.bucket, timeZone);
    return {
      date,
      label: formatBucketLabel(date, granularity),
      inflow: point.inflowCents / 100,
      outflow: point.outflowCents / 100,
      net: point.netCents / 100,
      inflowCents: point.inflowCents,
      outflowCents: point.outflowCents,
      netCents: point.netCents,
      hasData: true,
    };
  });
}

/* --------------------------------------------------------------------------
   L'AXE COUVRE LA PERIODE, PAS SEULEMENT LES JOURS OU IL S'EST PASSE QUELQUE
   CHOSE
   -------------------------------------------------------------------------- */

/**
 * LA CLEF CIVILE D'UN SEAU, DANS LE FUSEAU DE LA PERIODE.
 *
 * `2026-08-21T22:00:00.000Z` a Paris devient `2026-08-22` au jour, `2026-08` au
 * mois, `2026` a l'annee. C'est par cette clef, et jamais par l'instant brut,
 * qu'un seau du serveur retrouve sa place sur l'axe : deux instants differents
 * peuvent designer le meme jour civil, et c'est le jour civil qu'on affiche.
 */
function clefDeSeau(
  instant: number,
  granularity: FinancePeriod['granularity'],
  timeZone: string,
): string {
  const civile = dateCivile(instant, timeZone);
  if (granularity === 'year') return civile.slice(0, 4);
  if (granularity === 'month') return civile.slice(0, 7);
  return civile;
}

/** Les parties civiles d'une clef, quelle que soit sa longueur. */
function partiesDeClef(clef: string): { annee: number; mois: number; jour: number } {
  const [annee, mois, jour] = clef.split('-').map((n) => Number.parseInt(n, 10));
  return {
    annee,
    mois: Number.isFinite(mois) ? mois : 1,
    jour: Number.isFinite(jour) ? jour : 1,
  };
}

/**
 * GARDE-FOU. La granularite du serveur borne deja le nombre de seaux -- au jour
 * jusqu'a 62 jours, au mois jusqu'a deux ans -- mais une periode aberrante ne
 * doit pas pouvoir faire boucler l'ecran.
 */
const SEAUX_MAX = 400;

/**
 * TOUS LES SEAUX DE LA PERIODE, DANS L'ORDRE, LES CREUX COMPRIS.
 *
 * == POURQUOI L'ECRAN COMBLE CE QUE LE SERVEUR LAISSE VIDE ==================
 *
 * Le serveur ne rend que les periodes ou il s'est passe quelque chose, et son
 * commentaire dit pourquoi : inventer trente points nuls ferait lire « le
 * benefice est reste a zero » la ou la verite est « il ne s'est rien passe ».
 * Cette distinction est JUSTE, et elle est conservee -- chaque seau comble
 * porte `hasData: false`, et l'infobulle d'un seau creux dit « aucun
 * mouvement ».
 *
 * Ce qu'un axe creux coutait, en revanche : un mois entier se resumait a un
 * point isole, sans echelle de temps. On ne voyait pas QUAND dans le mois, ni
 * combien de jours etaient restes sans mouvement. Un graphique dont l'axe
 * horizontal ne couvre pas la periode qu'il annonce ne repond pas a la question
 * qu'on lui pose.
 *
 * Poser zero n'est d'ailleurs pas fabriquer une donnee : l'absence de mouvement
 * un jour donne VAUT zero euro ce jour-la. Ce qui serait fabrique, ce serait
 * d'interpoler, de lisser, ou de prolonger une tendance -- et rien de tout cela
 * n'est fait ici.
 *
 * == LES BORNES SONT SEMI-OUVERTES =========================================
 *
 * `[startsAt, endsAt[`. Le dernier seau a couvrir est donc celui qui contient
 * `endsAt` moins un instant : pour le mois d'aout, `endsAt` est le 1er
 * septembre a minuit, et l'axe s'arrete au 31 aout.
 *
 * == « DEPUIS TOUJOURS » N'A PAS DE BORNES ==================================
 *
 * La periode `ALL` rend `startsAt: null`. L'axe part alors du premier seau
 * RECU -- le premier fait connu -- et court jusqu'a aujourd'hui. Sans le
 * moindre mouvement ET sans bornes, il n'y a rien a dessiner : la fonction rend
 * une liste vide, et l'ecran le dit avec des mots.
 */
export function densifyEvolution(
  series: FinanceSeriesPoint[],
  period: FinancePeriod,
  maintenant: number = Date.now(),
): EvolutionRow[] {
  const fuseau = period.timezone || FUSEAU_PAR_DEFAUT;
  const granularite = period.granularity;

  const recus = new Map<string, FinanceSeriesPoint>();
  for (const point of series) {
    recus.set(clefDeSeau(new Date(point.bucket).getTime(), granularite, fuseau), point);
  }

  const instantsRecus = series.map((p) => new Date(p.bucket).getTime());
  const debut = period.startsAt
    ? new Date(period.startsAt).getTime()
    : (instantsRecus.length ? Math.min(...instantsRecus) : null);
  if (debut === null) return [];

  /*
    Le dernier instant COUVERT, borne haute exclue. On retire une milliseconde
    plutot qu'un jour : a la granularite mensuelle, retirer un jour ferait
    perdre le dernier mois d'une periode qui s'arrete pile au premier du mois
    suivant.
  */
  const finBrute = period.endsAt ? new Date(period.endsAt).getTime() - 1 : maintenant;
  const fin = Math.max(finBrute, instantsRecus.length ? Math.max(...instantsRecus) : finBrute);

  const clefFin = clefDeSeau(fin, granularite, fuseau);
  const lignes: EvolutionRow[] = [];
  const curseur = partiesDeClef(clefDeSeau(debut, granularite, fuseau));

  for (let garde = 0; garde < SEAUX_MAX; garde += 1) {
    const aa = String(curseur.annee).padStart(4, '0');
    const mm = String(curseur.mois).padStart(2, '0');
    const jj = String(curseur.jour).padStart(2, '0');
    const clef = granularite === 'year'
      ? aa
      : granularite === 'month' ? `${aa}-${mm}` : `${aa}-${mm}-${jj}`;

    const date = new Date(curseur.annee, curseur.mois - 1, curseur.jour, 12, 0, 0, 0);
    const point = recus.get(clef);
    lignes.push({
      date,
      label: formatBucketLabel(date, granularite),
      inflow: (point?.inflowCents ?? 0) / 100,
      outflow: (point?.outflowCents ?? 0) / 100,
      net: (point?.netCents ?? 0) / 100,
      inflowCents: point?.inflowCents ?? 0,
      outflowCents: point?.outflowCents ?? 0,
      netCents: point?.netCents ?? 0,
      hasData: point !== undefined,
    });

    if (clef >= clefFin) break;

    /*
      L'avancee se fait sur le CALENDRIER, jamais en ajoutant 86 400 000 ms :
      un jour d'octobre dure vingt-cinq heures a Paris, et une arithmetique en
      millisecondes produirait deux fois le meme jour civil.
    */
    if (granularite === 'year') {
      curseur.annee += 1;
    } else if (granularite === 'month') {
      curseur.mois += 1;
      if (curseur.mois > 12) { curseur.mois = 1; curseur.annee += 1; }
    } else {
      const suivant = new Date(Date.UTC(curseur.annee, curseur.mois - 1, curseur.jour));
      suivant.setUTCDate(suivant.getUTCDate() + 1);
      curseur.annee = suivant.getUTCFullYear();
      curseur.mois = suivant.getUTCMonth() + 1;
      curseur.jour = suivant.getUTCDate();
    }
  }

  return lignes;
}

/**
 * CE QUE L'ÉCRAN PEUT TRACER.
 *
 * ══ POURQUOI « UN SEUL POINT » A DISPARU ═══════════════════════════════════
 *
 * Cet état existait parce que l'axe ne portait que les seaux REÇUS : un mois
 * entier se réduisait alors à un point isolé, et un point isolé ressemble à une
 * panne d'affichage plus qu'à une information. L'écran renonçait donc au tracé
 * et montrait les trois chiffres.
 *
 * `densifyEvolution` a supprimé la cause : l'axe couvre désormais la période
 * ANNONCÉE, du premier au dernier seau, creux compris. Un mouvement isolé le
 * 22 août se lit sur trente et un jours, à sa place — ce qui est précisément ce
 * qu'on demande à un graphique d'évolution.
 *
 * ══ IL RESTE DEUX ÉTATS, ET UN SEUL EMPÊCHE DE DESSINER ════════════════════
 *
 *   `empty`     aucun seau à porter. Cela n'arrive plus que pour « depuis
 *               toujours » sur un registre vide : sans bornes ET sans fait, il
 *               n'y a aucun axe à construire. Cela se dit avec des mots.
 *   `barren`    l'axe existe et la période est couverte, mais AUCUN seau ne
 *               porte de mouvement. On trace — l'échelle de temps est une
 *               information — et on ajoute une phrase, parce qu'un graphique
 *               plat sans explication laisse croire à une panne de chargement.
 *   `ready`     au moins un mouvement dans la période.
 */
export function evolutionState(rows: EvolutionRow[]): 'empty' | 'barren' | 'ready' {
  if (rows.length === 0) return 'empty';
  if (!rows.some((r) => r.hasData)) return 'barren';
  return 'ready';
}

/* ══════════════════════════════════════════════════════════════════════════
   LA PÉRIODE PRÉCÉDENTE
   ══════════════════════════════════════════════════════════════════════════ */

export interface ComparableWindow {
  /** `AAAA-MM-JJ`, INCLUSE — le vocabulaire attendu par `/api/finances`. */
  start: string;
  /** `AAAA-MM-JJ`, INCLUSE elle aussi. */
  end: string;
}

/**
 * LA FENÊTRE IMMÉDIATEMENT ANTÉRIEURE, DE MÊME DURÉE.
 *
 * ══ ELLE PARLE LA LANGUE DE LA ROUTE, PAS CELLE DU MODÈLE ══════════════════
 *
 * Le serveur REND des bornes semi-ouvertes en instants absolus
 * (`[startsAt, endsAt[`), mais il ATTEND, pour une période `CUSTOM`, deux dates
 * civiles `AAAA-MM-JJ` dont la seconde est INCLUSE. Les deux vocabulaires ne
 * sont pas interchangeables, et les confondre a un coût immédiat :
 *
 *     GET /api/finances/summary?period=CUSTOM&start=2026-06-30T22:00:00.000Z…
 *     400 Bad Request
 *
 * La tendance disparaissait alors de tous les indicateurs, silencieusement —
 * l'écran restait juste, et seule la comparaison manquait.
 *
 * ══ LE CALCUL ══════════════════════════════════════════════════════════════
 *
 * On recule sur les INSTANTS — c'est exact à travers un changement d'heure, là
 * où « moins trente jours » en heure locale se serait décalé de soixante
 * minutes. On ne convertit en dates civiles qu'À LA FIN, dans le fuseau de la
 * période :
 *
 *   fin précédente   = la veille du premier jour de la période courante
 *   début précédent  = cette veille, moins la durée de la période
 *
 * ── CE QUI REND `null`, ET C'EST VOLONTAIRE ─────────────────────────────────
 * « Depuis toujours » n'a pas d'avant. Une période sans borne ne peut pas être
 * comparée, et l'écran n'affichera aucune tendance plutôt qu'une flèche
 * inventée.
 */
export function previousWindow(period: FinancePeriod): ComparableWindow | null {
  if (!period.startsAt || !period.endsAt) return null;

  const debut = new Date(period.startsAt).getTime();
  const fin = new Date(period.endsAt).getTime();
  if (!Number.isFinite(debut) || !Number.isFinite(fin)) return null;

  const duree = fin - debut;
  if (duree <= 0) return null;

  const fuseau = period.timezone || FUSEAU_PAR_DEFAUT;
  // Une milliseconde avant le début de la période courante : le dernier
  // instant de la période précédente, donc son dernier jour civil.
  const finPrecedente = debut - 1;
  const debutPrecedent = finPrecedente - duree + 1;

  return {
    start: dateCivile(debutPrecedent, fuseau),
    end: dateCivile(finPrecedente, fuseau),
  };
}

export interface Trend {
  /** L'écart en centimes — toujours défini quand une comparaison existe. */
  deltaCents: number;
  /**
   * L'écart RELATIF, entre 0 et l'infini… sauf qu'on refuse l'infini : `null`
   * quand la période précédente était à zéro. On ne progresse pas « de 100 % »
   * par rapport à rien.
   */
  ratio: number | null;
  direction: 'up' | 'down' | 'flat';
}

export function computeTrend(currentCents: number, previousCents: number): Trend {
  const deltaCents = currentCents - previousCents;
  const direction: Trend['direction'] = deltaCents > 0 ? 'up' : deltaCents < 0 ? 'down' : 'flat';
  const ratio = previousCents === 0 ? null : deltaCents / Math.abs(previousCents);
  return { deltaCents, ratio, direction };
}

const POURCENT = new Intl.NumberFormat('fr-FR', {
  style: 'percent',
  maximumFractionDigits: 1,
});

/** « +12,4 % ». `null` quand il n'y a rien à rapporter. */
export function formatTrendRatio(trend: Trend | null): string | null {
  if (!trend || trend.ratio === null) return null;
  const signe = trend.ratio > 0 ? '+' : '';
  return `${signe}${POURCENT.format(trend.ratio)}`;
}

/* ══════════════════════════════════════════════════════════════════════════
   LA RÉPARTITION PAR RATTACHEMENT
   ══════════════════════════════════════════════════════════════════════════ */

export interface BreakdownRow extends Record<string, unknown> {
  /** `null` = les mouvements propres à L.Y Solution. `'__others__'` = le reste. */
  key: string;
  name: string;
  revenueCents: number;
  costCents: number;
  netCents: number;
  count: number;
  revenue: number;
  cost: number;
  /** Part du revenu total, entre 0 et 1. `null` si le total est nul. */
  share: number | null;
  isAggregate: boolean;
}

export const OTHERS_KEY = '__others__';
export const COMPANY_KEY = '__company__';

/**
 * QUAND IL NE RESTE NI FICHE NI INSTANTANÉ.
 *
 * Le cas est RÉEL : relevé sur l'instance déployée, le seul rattachement du
 * registre pointe vers un projet retiré du parc, dont les mouvements — eux —
 * ont été conservés. C'est le bon comportement comptable : on ne supprime pas
 * un encaissement parce qu'on a supprimé un projet.
 *
 * Ce que l'écran en faisait, en revanche, était mauvais : il affichait
 * l'identifiant technique, trente-six caractères, en étiquette de barre ET en
 * libellé de ligne. Un lecteur ne peut rien en faire — il ne sait même pas
 * qu'il regarde un projet disparu plutôt qu'un nom mal renseigné.
 *
 * NOMMER L'ABSENCE N'EST PAS INVENTER UNE DONNÉE. On n'affiche aucun nom qu'on
 * n'a pas ; on dit ce qui est vrai — ce projet n'existe plus — et on garde de
 * quoi le distinguer d'un autre disparu, parce que le registre peut en compter
 * plusieurs et qu'ils ne doivent pas se confondre en une seule ligne à l'œil.
 *
 * Le fragment fait huit caractères, la longueur des références courtes du
 * Panel. La règle vit ICI, dans la couche pure, et `ownershipLabel` la lit :
 * le registre, la fiche d'un mouvement et le graphique de répartition doivent
 * nommer le même absent de la même façon.
 */
export function missingProjectLabel(projectId: string): string {
  return `Projet supprimé — ${projectId.slice(0, 8)}`;
}

/**
 * LE CLASSEMENT, BORNÉ — et ce qui dépasse est AGRÉGÉ, jamais coupé.
 *
 * ══ POURQUOI PAS SIMPLEMENT LES DIX PREMIERS ═══════════════════════════════
 *
 * Parce qu'un graphique dont les barres ne totalisent pas le chiffre affiché
 * au-dessus fait douter des deux. Au-delà du rang `top`, les rattachements sont
 * REGROUPÉS dans une ligne « Autres » qui porte leur somme exacte. Le total du
 * graphique reste donc celui du serveur, au centime.
 *
 * Le tri se fait sur le REVENU, pas sur le net : on cherche qui fait tourner
 * l'activité. Un client au net négatif reste un client qui rapporte.
 *
 * `nameOf` est injecté plutôt que lu ici : le nom courant d'un projet vient du
 * registre, l'instantané de la ligne n'est qu'un repli d'audit.
 */
export function toBreakdownRows(
  lines: FinanceProjectLine[],
  {
    top = 8,
    nameOf,
    companyLabel,
    othersLabel = 'Autres rattachements',
  }: {
    top?: number;
    nameOf: (projectId: string) => string | null;
    companyLabel: string;
    othersLabel?: string;
  },
): BreakdownRow[] {
  const totalRevenu = lines.reduce((somme, l) => somme + l.revenueCents, 0);
  const part = (cents: number) => (totalRevenu === 0 ? null : cents / totalRevenu);

  const brutes = lines.map((ligne) => ({
    ligne,
    key: ligne.projectId ?? COMPANY_KEY,
    name: ligne.projectId
      ? (nameOf(ligne.projectId) ?? ligne.projectNameSnapshot ?? missingProjectLabel(ligne.projectId))
      : companyLabel,
  }));

  // Tri STABLE sur le revenu, puis sur le nom : deux rattachements à égalité ne
  // doivent pas permuter d'un rendu à l'autre, sinon le graphique « bouge »
  // tout seul à chaque rafraîchissement.
  brutes.sort((a, b) => (
    b.ligne.revenueCents - a.ligne.revenueCents
    || a.name.localeCompare(b.name, 'fr')
  ));

  const tete = brutes.slice(0, top);
  const queue = brutes.slice(top);

  const rows: BreakdownRow[] = tete.map(({ ligne, key, name }) => ({
    key,
    name,
    revenueCents: ligne.revenueCents,
    costCents: ligne.costCents,
    netCents: ligne.netCents,
    count: ligne.count,
    revenue: ligne.revenueCents / 100,
    cost: ligne.costCents / 100,
    share: part(ligne.revenueCents),
    isAggregate: false,
  }));

  if (queue.length > 0) {
    const somme = queue.reduce(
      (acc, { ligne }) => ({
        revenueCents: acc.revenueCents + ligne.revenueCents,
        costCents: acc.costCents + ligne.costCents,
        netCents: acc.netCents + ligne.netCents,
        count: acc.count + ligne.count,
      }),
      { revenueCents: 0, costCents: 0, netCents: 0, count: 0 },
    );
    rows.push({
      key: OTHERS_KEY,
      name: `${othersLabel} (${queue.length})`,
      ...somme,
      revenue: somme.revenueCents / 100,
      cost: somme.costCents / 100,
      share: part(somme.revenueCents),
      isAggregate: true,
    });
  }

  return rows;
}

/* ══════════════════════════════════════════════════════════════════════════
   LE PANIER MOYEN ET LE TAUX DE REMBOURSEMENT
   ══════════════════════════════════════════════════════════════════════════ */

/**
 * LE MONTANT MOYEN D'UN MOUVEMENT ENTRANT.
 *
 * `count` est le nombre de mouvements du périmètre, TOUTES catégories
 * confondues — c'est ce que le serveur rend. Diviser les revenus par ce
 * compte-là donnerait un « panier moyen » abaissé par chaque coût enregistré.
 * On rend donc `null` : mieux vaut ne pas afficher un indicateur que d'en
 * afficher un faux, et le jour où le serveur exposera le compte des seuls
 * encaissements, c'est ici que cela se branchera.
 */
export function averageInflowCents(
  revenueCents: number,
  inflowCount: number | null,
): number | null {
  if (inflowCount === null || inflowCount <= 0) return null;
  return Math.round(revenueCents / inflowCount);
}

/**
 * QUELLE PART DES ENCAISSEMENTS A ÉTÉ RENDUE.
 *
 * Rapporté aux REVENUS, pas aux entrées : un remboursement défait un
 * encaissement, et c'est à lui qu'il doit être comparé. `null` quand il n'y a
 * eu aucun revenu — un taux sur zéro n'existe pas.
 */
export function refundRate(refundCents: number, revenueCents: number): number | null {
  if (revenueCents <= 0) return null;
  return refundCents / revenueCents;
}

export default {
  parseBucket,
  formatBucketLabel,
  toEvolutionRows,
  densifyEvolution,
  evolutionState,
  missingProjectLabel,
  previousWindow,
  computeTrend,
  formatTrendRatio,
  toBreakdownRows,
  averageInflowCents,
  refundRate,
};
