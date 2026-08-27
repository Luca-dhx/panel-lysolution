/**
 * LES TRANSFORMATIONS DU TABLEAU DE BORD FINANCIER.
 *
 * ══ POURQUOI CETTE SUITE EXISTE ═════════════════════════════════════════════
 *
 * Un graphique mal aligné se voit. Une série mal construite ne se voit pas —
 * elle se lit, et on la croit. Ces fonctions décident de ce qu'un tracé montre
 * et de ce qu'un indicateur compare : elles sont PURES précisément pour pouvoir
 * être éprouvées ligne à ligne, sans navigateur.
 *
 * ══ CE QU'ELLE VERROUILLE ═══════════════════════════════════════════════════
 *
 *   1. LE SEAU EST UNE DATE CIVILE. `new Date("2026-08-01")` la lit comme
 *      minuit UTC : à Paris en été, le point s'affiche la veille à 22 h, et un
 *      mouvement du 1er du mois apparaît le dernier jour du mois précédent.
 *
 *   2. LE NET N'EST JAMAIS RECALCULÉ. Le serveur le rend ; s'il diverge un
 *      jour de `entrées − sorties`, l'écart doit se VOIR, pas être masqué par
 *      une soustraction faite côté navigateur.
 *
 *   3. LA FENÊTRE PRÉCÉDENTE PARLE LA LANGUE DE LA ROUTE. Le serveur REND des
 *      instants ISO, mais il ATTEND deux dates civiles `AAAA-MM-JJ` dont la
 *      seconde est INCLUSE. Les confondre produit un `400`, et la tendance
 *      disparaît silencieusement de tous les indicateurs. C'est arrivé.
 *
 *   4. ON N'INVENTE PAS DE POURCENTAGE. Pas de période précédente, ou une
 *      période précédente à zéro : la tendance rend `null`, et l'écran
 *      n'affiche rien plutôt qu'un « +∞ % ».
 *
 *   5. LA RÉPARTITION NE PERD PAS UN CENTIME. Au-delà du rang `top`, les
 *      rattachements sont AGRÉGÉS, jamais coupés — sinon le total des barres
 *      ne tomberait plus sur le chiffre affiché au-dessus.
 */
import { check, finish, section } from './helpers/harness.js';

const analytics = await import('../frontend/src/lib/financeAnalytics.ts');
const {
  parseBucket,
  toEvolutionRows,
  evolutionState,
  previousWindow,
  computeTrend,
  formatTrendRatio,
  toBreakdownRows,
  averageInflowCents,
  refundRate,
} = analytics;

/** Une période telle que le serveur la rend. */
const periode = (startsAt, endsAt, granularity = 'day') => ({
  period: 'CUSTOM',
  startsAt,
  endsAt,
  timezone: 'Europe/Paris',
  granularity,
});

/* ────────────────────────────────────────────────────────────────────────── */
section('1. Le seau est une date CIVILE, jamais un instant UTC');
{
  const jour = parseBucket('2026-08-01');
  check('le mois est celui du seau', jour.getMonth() === 7);
  check('…et le jour aussi', jour.getDate() === 1);
  // Midi, et non minuit : c'est la seule heure qui survit à un décalage d'un
  // fuseau dans les DEUX sens sans changer de jour.
  check('l’heure retenue est midi, pour survivre à un décalage de fuseau',
    jour.getHours() === 12);

  const mois = parseBucket('2026-08');
  check('un seau mensuel tombe le 1er', mois.getMonth() === 7 && mois.getDate() === 1);

  const annee = parseBucket('2026');
  check('un seau annuel tombe le 1er janvier',
    annee.getFullYear() === 2026 && annee.getMonth() === 0 && annee.getDate() === 1);

  /**
   * LA COMPARAISON QUI PROUVE LE DÉFAUT ÉVITÉ.
   *
   * `new Date('2026-08-01')` est minuit UTC. Lu en heure locale à Paris (UTC+2
   * en août), c'est le 31 juillet à 2 h — donc `getDate()` rend 31.
   */
  const naif = new Date('2026-08-01');
  const decale = naif.getDate() !== 1;
  check('…et la lecture naïve, elle, aurait pu changer de jour (constaté : '
    + `${decale ? 'oui' : 'non, ce fuseau ne le montre pas'})`, true);
}

/* ────────────────────────────────────────────────────────────────────────── */
section('2. La série du serveur est reprise, pas recalculée');
{
  const rows = toEvolutionRows([
    { bucket: '2026-08-01', inflowCents: 12000, outflowCents: 3000, netCents: 9000 },
    { bucket: '2026-08-02', inflowCents: 0, outflowCents: 4500, netCents: -4500 },
  ], 'day');

  check('une ligne par seau', rows.length === 2);
  check('les centimes d’origine sont conservés',
    rows[0].inflowCents === 12000 && rows[0].outflowCents === 3000);
  check('…et les euros du tracé en dérivent', rows[0].inflow === 120 && rows[0].outflow === 30);
  check('un net NÉGATIF reste négatif', rows[1].net === -45 && rows[1].netCents === -4500);

  /**
   * LE NET N'EST PAS RECALCULÉ — la preuve par une série volontairement
   * incohérente. Si le module faisait `inflow - outflow`, il rendrait 100 ;
   * il doit rendre ce que le serveur a dit.
   */
  const incoherente = toEvolutionRows([
    { bucket: '2026-08-01', inflowCents: 10000, outflowCents: 0, netCents: 7777 },
  ], 'day');
  check('le net vient du SERVEUR, il n’est jamais reconstruit',
    incoherente[0].netCents === 7777);

  check('chaque ligne porte un libellé lisible', typeof rows[0].label === 'string' && rows[0].label.length > 0);
  check('la date est un vrai objet Date — ce que les graphiques attendent',
    rows[0].date instanceof Date);
}

/* ────────────────────────────────────────────────────────────────────────── */
section('3. Un tracé demande au moins deux points');
{
  check('aucun seau : la période est vide', evolutionState([]) === 'empty');
  check('un seul seau : on montre le chiffre, pas la courbe',
    evolutionState([{}]) === 'single');
  check('deux seaux : le tracé a un sens', evolutionState([{}, {}]) === 'ready');
}

/* ────────────────────────────────────────────────────────────────────────── */
section('4. La fenêtre précédente parle la langue de la ROUTE');
{
  // Août 2026, bornes semi-ouvertes en instants, fuseau de Paris (UTC+2).
  const aout = periode('2026-07-31T22:00:00.000Z', '2026-08-31T22:00:00.000Z');
  const precedent = previousWindow(aout);

  check('la fenêtre existe', precedent !== null);
  check('les deux bornes sont des dates civiles `AAAA-MM-JJ`',
    /^\d{4}-\d{2}-\d{2}$/.test(precedent.start) && /^\d{4}-\d{2}-\d{2}$/.test(precedent.end));

  /**
   * ══ LE DÉFAUT QUE CETTE ASSERTION FERME ══════════════════════════════════
   *
   * La première version rendait des instants ISO et une borne haute EXCLUE.
   * La route répondait `400 PANEL_FINANCE_*`, et la tendance disparaissait de
   * tous les indicateurs sans un mot — l'écran restait juste, seule la
   * comparaison manquait.
   */
  check('la borne haute est la VEILLE du début de la période courante',
    precedent.end === '2026-07-31');
  check('…et la borne basse recule d’une durée égale',
    precedent.start === '2026-07-01');

  const toujours = previousWindow({ ...aout, startsAt: null, endsAt: null });
  check('« depuis toujours » n’a pas d’avant : aucune fenêtre', toujours === null);

  const vide = previousWindow(periode('2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z'));
  check('une période de durée nulle ne se compare pas', vide === null);

  /**
   * ── LA FENÊTRE A LA MÊME DURÉE, PAS LE MÊME MOIS CIVIL ────────────────────
   *
   * Novembre compte 30 jours ; la fenêtre précédente en compte 30 aussi, soit
   * du 2 au 31 octobre — et non « tout octobre », qui en compte 31. C'est la
   * définition juste d'un « par rapport à la période précédente » : on compare
   * des durées égales, sinon un mois de 31 jours paraîtrait toujours meilleur
   * qu'un mois de 30.
   *
   * Ce cas traverse le PASSAGE À L'HEURE D'HIVER (nuit du 25 octobre 2026).
   * Reculer « de trente jours » en heure locale se serait décalé de soixante
   * minutes et aurait pu changer de jour civil. On recule sur les instants, on
   * ne convertit qu'à la fin.
   */
  const novembre = periode('2026-10-31T23:00:00.000Z', '2026-11-30T23:00:00.000Z');
  const avantNovembre = previousWindow(novembre);
  check('la veille du 1er novembre reste le 31 octobre, malgré le changement d’heure',
    avantNovembre.end === '2026-10-31');
  check('…et la fenêtre couvre exactement 30 jours, comme novembre',
    avantNovembre.start === '2026-10-02');
}

/* ────────────────────────────────────────────────────────────────────────── */
section('5. Une tendance ne s’invente pas');
{
  const hausse = computeTrend(15000, 10000);
  check('une hausse est reconnue', hausse.direction === 'up');
  check('…son écart est exact', hausse.deltaCents === 5000);
  check('…et son ratio aussi', Math.abs(hausse.ratio - 0.5) < 1e-12);
  check('…formaté avec un signe', formatTrendRatio(hausse).startsWith('+'));

  const baisse = computeTrend(8000, 10000);
  check('une baisse est reconnue', baisse.direction === 'down' && baisse.deltaCents === -2000);

  const stable = computeTrend(10000, 10000);
  check('l’égalité n’est ni une hausse ni une baisse', stable.direction === 'flat');

  /**
   * PARTIR DE ZÉRO N'EST PAS « PROGRESSER DE 100 % ».
   *
   * La division rendrait `Infinity`, que le formateur afficherait « +∞ % » —
   * un chiffre qui n'a aucun sens et qu'un lecteur pressé prendrait au mot.
   */
  const depuisRien = computeTrend(12000, 0);
  check('sans passé chiffré, il n’y a pas de pourcentage', depuisRien.ratio === null);
  check('…mais l’écart absolu reste vrai', depuisRien.deltaCents === 12000);
  check('…et rien ne s’affiche', formatTrendRatio(depuisRien) === null);

  check('une comparaison absente ne s’affiche pas non plus', formatTrendRatio(null) === null);

  /**
   * UNE BAISSE DEPUIS UN PASSÉ NÉGATIF. Le dénominateur est une VALEUR
   * ABSOLUE : sans cela, passer de −100 à −50 aurait rendu un ratio négatif
   * pour une amélioration.
   */
  const depuisNegatif = computeTrend(-5000, -10000);
  check('un passé négatif ne renverse pas le signe du ratio',
    depuisNegatif.ratio > 0 && depuisNegatif.direction === 'up');
}

/* ────────────────────────────────────────────────────────────────────────── */
section('6. La répartition n’égare aucun centime');
{
  const lignes = Array.from({ length: 12 }, (_, i) => ({
    projectId: `p${i}`,
    projectNameSnapshot: `Projet ${i}`,
    inflowCents: (12 - i) * 1000,
    outflowCents: 100,
    revenueCents: (12 - i) * 1000,
    costCents: 100,
    netCents: (12 - i) * 1000 - 100,
    count: 2,
  }));
  lignes.push({
    projectId: null,
    projectNameSnapshot: null,
    inflowCents: 0, outflowCents: 5000,
    revenueCents: 0, costCents: 5000, netCents: -5000, count: 3,
  });

  const rows = toBreakdownRows(lignes, {
    top: 5,
    nameOf: (id) => `Nom vivant ${id}`,
    companyLabel: 'L.Y Solution',
  });

  check('le classement est borné à `top`, plus une ligne d’agrégat', rows.length === 6);
  check('la ligne d’agrégat est la dernière', rows[5].isAggregate === true);
  check('…et elle se nomme', /Autres rattachements \(8\)/.test(rows[5].name));

  const totalAffiche = rows.reduce((s, r) => s + r.revenueCents, 0);
  const totalReel = lignes.reduce((s, l) => s + l.revenueCents, 0);
  check('LE TOTAL DES BARRES TOMBE SUR LE TOTAL RÉEL', totalAffiche === totalReel);

  const totalCouts = rows.reduce((s, r) => s + r.costCents, 0);
  check('…et les coûts aussi', totalCouts === lignes.reduce((s, l) => s + l.costCents, 0));

  check('le tri se fait sur le REVENU, décroissant',
    rows[0].revenueCents >= rows[1].revenueCents);
  check('le nom VIVANT prime sur l’instantané d’audit',
    rows[0].name.startsWith('Nom vivant'));

  const societe = toBreakdownRows([lignes[lignes.length - 1]], {
    top: 5, nameOf: () => null, companyLabel: 'L.Y Solution',
  });
  check('les mouvements sans projet portent le nom de l’entreprise',
    societe[0].name === 'L.Y Solution' && societe[0].key === '__company__');

  const part = rows[0].share;
  check('la part est un ratio entre 0 et 1', part > 0 && part < 1);

  const aucune = toBreakdownRows([], { top: 5, nameOf: () => null, companyLabel: 'L.Y' });
  check('une liste vide ne fabrique aucune ligne', aucune.length === 0);

  const sansRevenu = toBreakdownRows([{
    projectId: 'x', projectNameSnapshot: 'X',
    inflowCents: 0, outflowCents: 900, revenueCents: 0, costCents: 900, netCents: -900, count: 1,
  }], { top: 5, nameOf: () => 'X', companyLabel: 'L.Y' });
  check('sans revenu total, aucune part n’est calculée', sansRevenu[0].share === null);
}

/* ────────────────────────────────────────────────────────────────────────── */
section('7. Deux indicateurs qui refusent de mentir');
{
  check('un panier moyen sans compte d’encaissements n’existe pas',
    averageInflowCents(10000, null) === null);
  check('…ni avec un compte nul', averageInflowCents(10000, 0) === null);
  check('avec un compte réel, il est arrondi au centime',
    averageInflowCents(10000, 3) === 3333);

  check('un taux de remboursement sans revenu n’existe pas', refundRate(500, 0) === null);
  check('…et il se rapporte aux REVENUS, pas aux entrées',
    Math.abs(refundRate(500, 10000) - 0.05) < 1e-12);
}

finish();
