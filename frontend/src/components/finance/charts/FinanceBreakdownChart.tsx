/**
 * QUI RAPPORTE — la répartition du chiffre d'affaires par rattachement.
 *
 * ══ POURQUOI DES BARRES HORIZONTALES, ET NI CAMEMBERT NI ANNEAU ═════════════
 *
 * Trois raisons, toutes tirées de la donnée réelle :
 *
 * 1. LES ÉTIQUETTES SONT DES NOMS. « Garage du Nord — vitrine et Manager » ne
 *    tient pas sous une barre verticale : il faudrait le pivoter ou le couper.
 *    En horizontal, le nom se lit à gauche, à l'horizontale, en entier.
 *
 * 2. ON COMPARE DES LONGUEURS, PAS DES ANGLES. La question est « lequel
 *    rapporte le plus, et de combien ». L'œil compare deux longueurs alignées
 *    bien mieux que deux secteurs — c'est vrai pour tout le monde, et ça l'est
 *    encore plus quand deux clients sont proches.
 *
 * 3. LE NOMBRE DE RATTACHEMENTS N'EST PAS BORNÉ. Un camembert devient illisible
 *    au-delà de cinq ou six parts ; une liste de barres se lit à vingt.
 *
 * L'anneau de Bklit reste le bon outil pour une part sur un TOUT connu — « 62 %
 * de l'objectif ». Ce n'est pas la question posée ici.
 *
 * ══ LE GRAPHIQUE NE REMPLACE PAS LES CHIFFRES ═══════════════════════════════
 *
 * Une barre donne l'ordre de grandeur ; elle ne donne pas le centime. Le
 * tableau qui l'accompagne (voir `FinanceBreakdownPanel`) porte les montants
 * exacts. Les deux lisent la MÊME liste, dans le MÊME ordre — c'est ce qui
 * permet de passer de l'un à l'autre sans rechercher sa ligne.
 *
 * ══ CE QUI DÉPASSE EST AGRÉGÉ, JAMAIS COUPÉ ════════════════════════════════
 *
 * Au-delà du rang `top`, les rattachements sont regroupés dans « Autres », qui
 * porte leur somme exacte. Le total du graphique reste donc celui du serveur —
 * un graphique dont les barres ne totalisent pas le chiffre affiché au-dessus
 * fait douter des deux.
 */
import { BarChart } from '@/components/charts/bar-chart';
import { Bar } from '@/components/charts/bar';
import { BarYAxis } from '@/components/charts/bar-y-axis';
import { ChartTooltip } from '@/components/charts/tooltip';
import { EmptyPanel } from '@/components/ui-kit';
import { formatCents, formatNetCents } from '@/lib/money';
import type { BreakdownRow } from '@/lib/financeAnalytics';

export function FinanceBreakdownChart({ rows }: { rows: BreakdownRow[] }) {
  if (rows.length === 0) {
    return (
      <EmptyPanel
        title="Aucun mouvement enregistré"
        hint="La répartition apparaîtra dès la première transaction."
      />
    );
  }

  /*
   * LA HAUTEUR SUIT LE NOMBRE DE BARRES, elle n'est pas figée.
   *
   * Un rapport d'aspect constant aurait donné des barres de 60 px de haut pour
   * trois rattachements, et de 6 px pour vingt. On réserve donc une bande par
   * ligne, avec un plancher — c'est le seul dimensionnement qui reste lisible
   * dans les deux cas.
   */
  const hauteur = Math.max(160, rows.length * 38 + 24);

  return (
    /*
     * La hauteur est portée par le CONTENEUR, pas par le graphique : `BarChart`
     * n'expose pas de `style`, et son `aspectRatio` est justement ce qu'on ne
     * veut pas ici. Le conteneur fixe la boîte, le graphique la remplit.
     */
    <div className="uui" style={{ height: hauteur }}>
      <BarChart
        data={rows}
        xDataKey="name"
        orientation="horizontal"
        className="h-full w-full"
        /*
         * La marge gauche accueille les noms. 132 px tient « Boulangerie
         * Martin » ; au-delà, `BarYAxis` tronque proprement plutôt que de
         * pousser le tracé hors du cadre.
         */
        margin={{ top: 8, right: 16, bottom: 8, left: 132 }}
        barGap={0.35}
      >
        <BarYAxis maxLabels={24} />
        <Bar dataKey="revenue" fill="var(--chart-1)" lineCap={4} />
        <ChartTooltip
          rows={(point) => {
            const ligne = point as unknown as BreakdownRow;
            return [
              { label: 'Revenus', value: formatCents(ligne.revenueCents), color: 'var(--chart-1)' },
              { label: 'Coûts', value: formatCents(ligne.costCents), color: 'var(--chart-2)' },
              { label: 'Net', value: formatNetCents(ligne.netCents), color: 'var(--chart-3)' },
            ];
          }}
        />
      </BarChart>
    </div>
  );
}

export default FinanceBreakdownChart;
