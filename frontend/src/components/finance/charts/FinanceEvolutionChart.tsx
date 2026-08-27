/**
 * L'ÉVOLUTION FINANCIÈRE — un graphique composé, sur la série du serveur.
 *
 * ══ LA QUESTION À LAQUELLE IL RÉPOND ════════════════════════════════════════
 *
 * « Est-ce que ça monte, et est-ce que ça tient ? » Trois mesures, et il en
 * faut trois pour répondre :
 *
 *   SORTIES        des BARRES. Une dépense est un événement discret, daté :
 *                  une barre le dit, une courbe suggérerait un écoulement
 *                  continu qui n'existe pas.
 *   ENCAISSEMENTS  une COURBE. C'est la mesure principale ; on veut sa forme,
 *                  pas ses valeurs une à une.
 *   NET            une COURBE, plus fine. Elle croise l'axe zéro, et c'est
 *                  exactement ce qu'on cherche à voir.
 *
 * D'où le graphique COMPOSÉ de Bklit, qui aligne barres et courbes sur le même
 * axe temporel — au lieu de trois cadres empilés qu'il faudrait comparer de
 * l'œil.
 *
 * ══ AUCUNE DONNÉE N'EST FABRIQUÉE ICI ═══════════════════════════════════════
 *
 * `summary.series` vient du serveur, qui l'agrège sur TOUT le périmètre, dans
 * SON fuseau, avec SA granularité. Ce composant met en forme et ne calcule
 * rien : voir `financeAnalytics.toEvolutionRows`. En particulier, le net est
 * repris tel quel et jamais recalculé par soustraction.
 *
 * ══ CE QU'IL FAIT QUAND IL N'Y A RIEN À TRACER ══════════════════════════════
 *
 *   0 point   la période n'a aucun mouvement → on l'écrit, en mots.
 *   1 point   une courbe d'un point est un pixel, et une aire un trait. Le
 *             lecteur y voit une panne. On rend le chiffre, pas le tracé.
 *   n points  le graphique.
 *
 * ══ POURQUOI IL EST CHARGÉ À LA DEMANDE ════════════════════════════════════
 *
 * Les graphiques Bklit tirent visx, d3 et motion. Sur les quinze écrans du
 * Panel qui n'affichent aucun graphique, ce poids n'a rien à faire dans le
 * paquet initial. Ce fichier n'est atteint que par un `import()` paresseux —
 * voir `FinanceDashboard`.
 */
import { useMemo } from 'react';
import { ComposedChart } from '@/components/charts/composed-chart';
import { SeriesBar } from '@/components/charts/series-bar';
import { Line } from '@/components/charts/line';
import { Grid } from '@/components/charts/grid';
import { XAxis } from '@/components/charts/x-axis';
import { YAxis } from '@/components/charts/y-axis';
import { ChartTooltip } from '@/components/charts/tooltip';
import { EmptyPanel } from '@/components/ui-kit';
import { formatCents, formatCompactCents, formatNetCents } from '@/lib/money';
import { densifyEvolution, evolutionState } from '@/lib/financeAnalytics';
import type { EvolutionRow } from '@/lib/financeAnalytics';
import type { FinanceSummary } from '@/types.finance';

/**
 * LES COULEURS SONT DES RANGS, PAS DES TEINTES.
 *
 * `--chart-1` … `--chart-5` sont définis dans `styles/registry.css` à partir
 * des quatre couleurs du thème. Écrire une teinte ici l'aurait figée sur le
 * thème du jour — et aurait rompu la promesse que « encaissements » a la même
 * couleur sur ce graphique, dans la répartition, et dans la légende.
 */
const COULEURS = {
  inflow: 'var(--chart-1)',
  outflow: 'var(--chart-2)',
  net: 'var(--chart-3)',
} as const;

export function FinanceEvolutionChart({ summary }: { summary: FinanceSummary }) {
  /**
   * La transformation est MÉMOÏSÉE sur la série elle-même : sans cela, chaque
   * rendu de la page — un survol de ligne, une frappe dans la recherche —
   * reconstruisait le tableau et faisait rejouer l'animation d'entrée du
   * graphique. C'est visible, et c'est agaçant.
   */
  const rows = useMemo<EvolutionRow[]>(
    () => densifyEvolution(summary.series, summary.period),
    [summary.series, summary.period],
  );

  const etat = evolutionState(rows);

  if (etat === 'empty') {
    return (
      <EmptyPanel
        title="Aucun mouvement sur cette période"
        hint="Élargissez la période, ou enregistrez un premier mouvement."
      />
    );
  }

  /**
   * ── LE GRAPHIQUE EST UNE IMAGE, ET SES DONNÉES RESTENT LISIBLES ───────────
   *
   * ══ CE QUE LE TRACÉ PRÉCÉDENT FAISAIT, ET QU'IL NE FALLAIT PAS PERDRE ════
   *
   * Le graphique du net était un SVG écrit à la main : il portait `role="img"`,
   * une description, et un `<title>` par barre. Un lecteur d'écran pouvait donc
   * en tirer les valeurs, une à une.
   *
   * Un graphique de librairie ne fait rien de tout cela : c'est un canevas
   * interactif dont les valeurs n'existent qu'au survol — geste qui n'a pas
   * d'équivalent au clavier ni au lecteur d'écran. Le remplacer sans rien
   * ajouter aurait été un recul d'accessibilité déguisé en modernisation.
   *
   * Deux choses le compensent :
   *
   *   · le conteneur est annoncé comme une IMAGE, avec une description qui dit
   *     ce qu'on y voit — la période couverte et les bornes de la série ;
   *   · les valeurs elles-mêmes vivent dans un TABLEAU, masqué à l'œil et non
   *     aux technologies d'assistance. C'est l'équivalent moderne des `<title>`
   *     d'avant, en plus complet : chaque seau y porte ses trois montants.
   */
  const porteurs = rows.filter((r) => r.hasData).length;
  /*
    Un libellé de seau peut DÉJÀ se terminer par un point — « 01 févr. ». Lui en
    ajouter un second donnait « au 28 févr.. » dans la description lue à voix
    haute. On ne ponctue donc que si la phrase ne l'est pas déjà.
  */
  const dernier = rows[rows.length - 1].label;
  const resume = `Évolution sur ${rows.length} points, du ${rows[0].label} au `
    + `${dernier}${dernier.endsWith('.') ? '' : '.'} Encaissements, sorties et bénéfice net. `
    + (porteurs === 0
      ? 'Aucun mouvement sur cette période.'
      : `${porteurs} période${porteurs > 1 ? 's' : ''} avec au moins un mouvement.`);

  return (
    <div className="uui">
      <div role="img" aria-label={resume}>
      <ComposedChart
        data={rows}
        xDataKey="date"
        /*
         * Le rapport d'aspect change avec la largeur : à 390 px, un 2/1
         * laisserait 195 px de haut, où trois séries et quatre graduations ne
         * tiennent pas. Le graphique devient donc plus haut, relativement,
         * quand l'écran est étroit.
         */
        aspectRatio="16 / 9"
        className="h-[220px] w-full sm:h-[260px] lg:h-[320px]"
        /*
         * La marge GAUCHE loge les graduations de montant ; à 52 px, la
         * première graduation de temps — centrée sur le premier point, donc
         * sur le bord du tracé — venait se poser dessus et se faisait rogner.
         * 68 px sépare les deux échelles. La marge basse loge la graduation de
         * temps ET l'étiquette flottante du survol.
         */
        margin={{ top: 16, right: 16, bottom: 32, left: 68 }}
        maxBarSize={28}
        barGap={2}
      >
        <Grid horizontal numTicksRows={4} />
        <YAxis
          numTicks={4}
          /* Les graduations sont des EUROS ENTIERS : deux décimales sur un axe
             ne se lisent pas, et le montant exact est dans l'infobulle. */
          formatValue={(value) => formatCompactCents(value * 100)}
        />
        {/* Trois repères suffisent : à 390 px, quatre étiquettes de date se
            chevauchent, et Bklit les fait alors disparaître au survol. */}
        <XAxis numTicks={3} tickMode="data" />

        <SeriesBar dataKey="outflow" fill={COULEURS.outflow} radius={3} />
        <Line dataKey="inflow" stroke={COULEURS.inflow} strokeWidth={2.5} />
        <Line dataKey="net" stroke={COULEURS.net} strokeWidth={1.75} showHighlight={false} />

        <ChartTooltip
          /*
           * L'infobulle reformate les CENTIMES d'origine avec le formateur
           * monétaire du Panel — elle ne remonte jamais par le nombre du tracé,
           * qui a été divisé par cent pour l'axe.
           */
          rows={(point) => {
            const ligne = point as unknown as EvolutionRow;
            /*
              UN SEAU CREUX N'EST PAS UN SOLDE NUL.
              Le serveur ne rend que les périodes où il s'est passé quelque
              chose ; les autres sont posées à zéro pour tenir l'axe. Écrire
              « 0,00 € » ferait lire « le bénéfice est resté à zéro » là où la
              vérité est « il ne s'est rien passé » — et cette différence est
              exactement ce qu'on regarde quand on cherche un oubli de saisie.
            */
            if (!ligne.hasData) {
              return [{ label: 'Aucun mouvement', value: '—', color: COULEURS.net }];
            }
            return [
              { label: 'Encaissé', value: formatCents(ligne.inflowCents), color: COULEURS.inflow },
              { label: 'Sorties', value: formatCents(ligne.outflowCents), color: COULEURS.outflow },
              { label: 'Net', value: formatNetCents(ligne.netCents), color: COULEURS.net },
            ];
          }}
        />
      </ComposedChart>
      </div>

      {/*
        LES VALEURS, EN TOUTES LETTRES — masquées à l'œil, pas au lecteur.
        `sr-only` est la classe du Panel pour cela ; le tableau porte un résumé
        (`<caption>`) et une ligne par seau.
      */}
      <table className="sr-only">
        <caption>{resume}</caption>
        <thead>
          <tr>
            <th scope="col">Période</th>
            <th scope="col">Encaissé</th>
            <th scope="col">Sorties</th>
            <th scope="col">Net</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((ligne) => (
            <tr key={ligne.label}>
              <th scope="row">{ligne.label}</th>
              {ligne.hasData ? (
                <>
                  <td>{formatCents(ligne.inflowCents)}</td>
                  <td>{formatCents(ligne.outflowCents)}</td>
                  <td>{formatNetCents(ligne.netCents)}</td>
                </>
              ) : (
                <td colSpan={3}>Aucun mouvement</td>
              )}
            </tr>
          ))}
        </tbody>
      </table>

      {/*
        LA LÉGENDE EST STATIQUE, ET SOUS LE GRAPHIQUE.
        La légende interactive de Bklit prend de la hauteur et, à 390 px, elle
        écrasait le tracé qu'elle explique. Trois puces sur une ligne suffisent :
        il n'y a que trois séries, et elles ne se masquent pas.
      */}
      {/*
        UNE PÉRIODE SANS LE MOINDRE MOUVEMENT SE TRACE QUAND MÊME.

        L'échelle de temps EST une information : elle dit sur quoi porte le
        silence. Mais un tracé plat sans un mot laisse croire à un chargement
        qui n'a pas abouti — d'où la phrase, sous le graphique et non à sa
        place.
      */}
      {etat === 'barren' ? (
        <p className="mt-3 text-xs text-quaternary">
          Aucun mouvement sur cette période. L’axe couvre tout de même la
          période choisie.
        </p>
      ) : null}

      <ul className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1">
        {[
          { label: 'Encaissé', color: COULEURS.inflow },
          { label: 'Sorties', color: COULEURS.outflow },
          { label: 'Net', color: COULEURS.net },
        ].map((serie) => (
          <li key={serie.label} className="flex items-center gap-1.5 text-xs text-tertiary">
            <span
              aria-hidden="true"
              className="size-2 rounded-full"
              style={{ backgroundColor: serie.color }}
            />
            {serie.label}
          </li>
        ))}
      </ul>
    </div>
  );
}

export default FinanceEvolutionChart;
