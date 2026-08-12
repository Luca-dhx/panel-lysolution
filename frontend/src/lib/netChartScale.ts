/**
 * L'ÉCHELLE DU GRAPHIQUE DU NET — un calcul pur, séparé de son rendu.
 *
 * ══ POURQUOI CE MODULE EXISTE, PLUTÔT QU'UNE DIZAINE DE LIGNES DANS LE SVG ══
 *
 * Un graphique casse toujours aux mêmes endroits : zéro point, un seul point,
 * que du positif, que du négatif, tout à zéro. Ce sont exactement les états
 * d'un registre financier qui démarre — donc ceux que l'écran affichera le
 * premier jour, devant l'utilisateur.
 *
 * Tant que ce calcul vivait dans le composant, il n'était éprouvable que par
 * lecture de source : le dépôt n'embarque aucun moteur de rendu React, et un
 * `.tsx` ne s'importe pas depuis un runner node. Sorti ici, il s'exécute
 * VRAIMENT dans la recette, avec ses cinq cas dégénérés.
 *
 * ══ CE QUE L'ÉCHELLE GARANTIT ══════════════════════════════════════════════
 *
 *   · `amplitude` n'est JAMAIS nulle — aucune division par zéro, donc aucune
 *     coordonnée `NaN` qui ferait disparaître le tracé sans erreur ;
 *   · la ligne de zéro est TOUJOURS dans le cadre : en bas quand tout est
 *     positif, en haut quand tout est négatif, entre les deux sinon ;
 *   · une barre de valeur nulle garde un filet visible : « zéro » et « rien »
 *     ne doivent pas se ressembler.
 */
import type { FinanceSeriesPoint } from '@/types.finance';

export interface ChartGeometry {
  /** Coordonnées internes du SVG. */
  width: number;
  height: number;
  margin: { top: number; bottom: number; left: number; right: number };
}

export interface ChartBar {
  bucket: string;
  netCents: number;
  x: number;
  y: number;
  width: number;
  height: number;
  negative: boolean;
  /** Centre de la barre — c'est là que se pose son libellé. */
  center: number;
}

export interface ChartScale {
  /** Le sommet de l'échelle, en centimes. Jamais inférieur à zéro. */
  high: number;
  /** Le bas de l'échelle, en centimes. Jamais supérieur à zéro. */
  low: number;
  /** `high − low`, strictement positif par construction. */
  span: number;
  /** L'ordonnée de la ligne de zéro, dans le repère du SVG. */
  zeroY: number;
  bars: ChartBar[];
  /** Une graduation tous les N intervalles — sinon les libellés se chevauchent. */
  labelEvery: number;
}

export function computeChartScale(
  series: FinanceSeriesPoint[],
  geometry: ChartGeometry,
): ChartScale {
  const { width, height, margin } = geometry;
  const innerH = height - margin.top - margin.bottom;
  const innerW = width - margin.left - margin.right;

  const nets = series.map((point) => point.netCents);
  // `Math.max(0, …)` et `Math.min(0, …)` ancrent l'échelle sur zéro : sans eux,
  // une série de coûts seuls serait tracée entre −500 et −100, et la ligne de
  // zéro sortirait du cadre — on lirait des barres flottantes sans référence.
  let high = Math.max(0, ...nets);
  let low = Math.min(0, ...nets);
  // Registre entièrement à zéro : l'amplitude serait nulle et TOUTES les
  // coordonnées deviendraient `NaN`. Échelle symétrique arbitraire.
  if (high === 0 && low === 0) {
    high = 1;
    low = -1;
  }
  const span = high - low;

  const y = (value: number) => margin.top + ((high - value) / span) * innerH;
  const zeroY = y(0);

  // Une barre unique ne doit occuper ni toute la largeur (on lirait un aplat)
  // ni un cheveu (on ne la verrait pas).
  const step = series.length > 0 ? innerW / series.length : innerW;
  const barWidth = Math.min(Math.max(step * 0.6, 3), 56);

  const bars: ChartBar[] = series.map((point, index) => {
    const center = margin.left + step * index + step / 2;
    const valueY = y(point.netCents);
    return {
      bucket: point.bucket,
      netCents: point.netCents,
      x: center - barWidth / 2,
      y: Math.min(valueY, zeroY),
      width: barWidth,
      // Un filet minimal : une barre de hauteur nulle serait invisible, et
      // « le net de ce jour est zéro » n'est pas « il n'y a pas de jour ».
      height: Math.max(Math.abs(valueY - zeroY), 1),
      negative: point.netCents < 0,
      center,
    };
  });

  return {
    high,
    low,
    span,
    zeroY,
    bars,
    labelEvery: Math.max(1, Math.ceil(series.length / 12)),
  };
}

export default computeChartScale;
