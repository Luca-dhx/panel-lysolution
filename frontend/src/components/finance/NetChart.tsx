/**
 * LE NET SUR LA PÉRIODE — un graphique en SVG, sans bibliothèque.
 *
 * ══ POURQUOI PAS DE BIBLIOTHÈQUE ════════════════════════════════════════════
 *
 * Le Panel n'a pour toute dépendance que React et son routeur ; ses icônes
 * elles-mêmes sont des tracés recopiés plutôt qu'un paquet. Embarquer un moteur
 * de graphiques de plusieurs centaines de kilo-octets pour une série de barres
 * romprait cette discipline — et le garde-fou d'architecture interdit de toute
 * façon d'aller la chercher sur un CDN.
 *
 * ══ CE QUE CE GRAPHIQUE MONTRE, ET CE QU'IL NE MONTRE PAS ═══════════════════
 *
 * Il montre le NET par intervalle : ce qui reste, entrées moins sorties. Pas
 * les revenus, pas les coûts — ceux-là sont déjà lisibles, au centime, dans les
 * trois cartes juste au-dessus. Un graphique qui répète des nombres déjà
 * affichés n'apprend rien ; celui-ci répond à une autre question : « la courbe
 * monte-t-elle ? ».
 *
 * ══ LES CAS DÉGÉNÉRÉS SONT LE CŒUR DU COMPOSANT ═════════════════════════════
 *
 * Un graphique casse toujours aux mêmes endroits, et ce sont exactement les
 * états d'un registre qui démarre : aucun point, un seul, que des revenus, que
 * des coûts, un net négatif, tout à zéro.
 *
 * Le calcul qui les absorbe vit dans `lib/netChartScale.ts` — un module PUR,
 * donc réellement exécuté par la recette. Ce fichier-ci ne fait que dessiner ce
 * qu'on lui rend : c'est la seule façon de PROUVER la robustesse plutôt que de
 * l'affirmer, le dépôt n'embarquant aucun moteur de rendu React.
 *
 * Le seul cas traité ici est le vide absolu : on n'affiche pas un cadre sans
 * barres, on dit pourquoi il n'y en a pas.
 */
import { EmptyState } from '@/components/ui';
import { formatCompactCents, formatNetCents } from '@/lib/money';
import { computeChartScale } from '@/lib/netChartScale';
import type { FinancePeriod } from '@/types.finance';
import type { FinanceSeriesPoint } from '@/types.finance';

/** Repère interne du SVG. La largeur réelle est fluide (`width="100%"`). */
const LARGEUR = 720;
const HAUTEUR = 200;
const MARGE = { haut: 16, bas: 26, gauche: 8, droite: 8 };

const MOIS_COURT = new Intl.DateTimeFormat('fr-FR', { month: 'short', timeZone: 'Europe/Paris' });
const JOUR_COURT = new Intl.DateTimeFormat('fr-FR', { day: '2-digit', month: '2-digit', timeZone: 'Europe/Paris' });
const JOUR_LONG = new Intl.DateTimeFormat('fr-FR', { dateStyle: 'long', timeZone: 'Europe/Paris' });

function libelleIntervalle(bucket: string, granularity: FinancePeriod['granularity']): string {
  const date = new Date(bucket);
  if (Number.isNaN(date.getTime())) return '—';
  if (granularity === 'year') return String(date.getUTCFullYear());
  if (granularity === 'month') return MOIS_COURT.format(date);
  return JOUR_COURT.format(date);
}

function libelleComplet(bucket: string, granularity: FinancePeriod['granularity']): string {
  const date = new Date(bucket);
  if (Number.isNaN(date.getTime())) return '';
  if (granularity === 'day') return JOUR_LONG.format(date);
  if (granularity === 'month') {
    return new Intl.DateTimeFormat('fr-FR', { month: 'long', year: 'numeric', timeZone: 'Europe/Paris' })
      .format(date);
  }
  return String(date.getUTCFullYear());
}

export function NetChart({
  series,
  period,
}: {
  series: FinanceSeriesPoint[];
  period: FinancePeriod;
}) {
  if (series.length === 0) {
    return (
      <EmptyState
        title="Aucun mouvement sur cette période."
        hint="Le graphique apparaîtra dès la première transaction enregistrée."
      />
    );
  }

  const echelle = computeChartScale(series, {
    width: LARGEUR,
    height: HAUTEUR,
    margin: { top: MARGE.haut, bottom: MARGE.bas, left: MARGE.gauche, right: MARGE.droite },
  });

  return (
    <figure className="net-chart">
      <svg
        className="net-chart-svg"
        viewBox={`0 0 ${LARGEUR} ${HAUTEUR}`}
        width="100%"
        height={HAUTEUR}
        role="img"
        aria-label={`Bénéfice net par intervalle, ${series.length} point(s).`}
      >
        {/* La ligne de zéro : la seule référence qui compte sur ce graphique. */}
        <line
          className="net-chart-zero"
          x1={MARGE.gauche}
          x2={LARGEUR - MARGE.droite}
          y1={echelle.zeroY}
          y2={echelle.zeroY}
        />

        {echelle.bars.map((barre, index) => (
          <g key={barre.bucket}>
            <rect
              className={barre.negative ? 'net-chart-bar net-chart-bar-negative' : 'net-chart-bar'}
              x={barre.x}
              y={barre.y}
              width={barre.width}
              height={barre.height}
              rx={2}
            >
              <title>
                {`${libelleComplet(barre.bucket, period.granularity)} — ${formatNetCents(barre.netCents)}`}
              </title>
            </rect>
            {index % echelle.labelEvery === 0 ? (
              <text className="net-chart-label" x={barre.center} y={HAUTEUR - 8} textAnchor="middle">
                {libelleIntervalle(barre.bucket, period.granularity)}
              </text>
            ) : null}
          </g>
        ))}
      </svg>
      <figcaption className="net-chart-caption">
        {/* L'échelle en toutes lettres : sans elle, des barres sans axe ne
            disent que « plus » ou « moins », jamais « combien ». */}
        Amplitude&nbsp;: {formatCompactCents(echelle.low)} € à {formatCompactCents(echelle.high)} €
        {' · '}
        {period.granularity === 'day' ? 'par jour' : null}
        {period.granularity === 'month' ? 'par mois' : null}
        {period.granularity === 'year' ? 'par année' : null}
        {' · '}
        fuseau {period.timezone}
      </figcaption>
    </figure>
  );
}

export default NetChart;
