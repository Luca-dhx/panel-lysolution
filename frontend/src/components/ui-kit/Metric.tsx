/**
 * UN INDICATEUR — valeur, unité, période, tendance, et les trois états.
 *
 * ══ POURQUOI LES CARTES PRÉCÉDENTES NE SUFFISAIENT PLUS ═════════════════════
 *
 * Elles affichaient un nombre et un libellé. Un nombre sans période ne veut
 * rien dire — « 12 400 € » sur quoi ? — et un nombre sans comparaison ne dit
 * pas s'il est bon. Les deux manques se comblaient dans la tête du lecteur,
 * c'est-à-dire mal.
 *
 * ══ LA TENDANCE EST FACULTATIVE, ET C'EST ESSENTIEL ═════════════════════════
 *
 * Elle n'apparaît que lorsqu'une période précédente EXISTE et qu'elle n'était
 * pas à zéro. « Depuis toujours » n'a pas d'avant ; progresser de 100 % par
 * rapport à rien n'a pas de sens. Voir `financeAnalytics.previousWindow`.
 *
 * ── LE SENS D'UNE HAUSSE DÉPEND DE LA MESURE ────────────────────────────────
 * Une hausse des encaissements est une bonne nouvelle ; une hausse des coûts
 * n'en est pas une. La couleur ne se déduit donc pas de la direction, elle est
 * DÉCLARÉE par l'appelant (`goodDirection`). Sans cela, le tableau de bord
 * aurait peint en vert la seule chose qu'on ne veut pas voir monter.
 *
 * ══ LES TROIS ÉTATS SONT DANS LE COMPOSANT, PAS AUTOUR ══════════════════════
 *
 * `loading` rend un squelette de la MÊME hauteur que la valeur : la carte ne
 * change pas de taille à l'arrivée des chiffres, donc rien ne saute sous le
 * curseur. `error` reste une carte, pas un vide : on garde la place et le
 * libellé, on remplace la valeur par la raison.
 */
import type { ReactNode } from 'react';
import { cx } from '@/utils/cx';
import { Icon } from '@/components/Icon';
import type { Trend } from '@/lib/financeAnalytics';
import { formatTrendRatio } from '@/lib/financeAnalytics';

export interface MetricProps {
  label: string;
  /** Déjà formatée par l'appelant : ce composant ne divise jamais par cent. */
  value: ReactNode;
  /** Ce que la valeur recouvre — « ce mois-ci », « depuis toujours ». */
  caption?: ReactNode;
  hint?: ReactNode;
  trend?: Trend | null;
  /**
   * Le sens d'une variation FAVORABLE pour cette mesure.
   * `'none'` affiche l'écart sans le colorer — le cas d'un net, où la couleur
   * est déjà portée par la valeur elle-même.
   */
  goodDirection?: 'up' | 'down' | 'none';
  /** Tonalité de la valeur — reprend le vocabulaire des montants du Panel. */
  tone?: 'default' | 'inflow' | 'outflow' | 'ok' | 'danger';
  status?: 'loading' | 'error' | 'ready';
  error?: string | null;
  className?: string;
}

const TON_VALEUR: Record<NonNullable<MetricProps['tone']>, string> = {
  default: 'text-primary',
  inflow: 'text-utility-green-700',
  outflow: 'text-utility-red-700',
  ok: 'text-utility-green-700',
  danger: 'text-utility-red-700',
};

export function Metric({
  label,
  value,
  caption,
  hint,
  trend,
  goodDirection = 'up',
  tone = 'default',
  status = 'ready',
  error,
  className,
}: MetricProps) {
  const ratio = formatTrendRatio(trend ?? null);
  const favorable = trend && goodDirection !== 'none'
    ? (goodDirection === 'up' ? trend.direction === 'up' : trend.direction === 'down')
    : null;

  return (
    <div
      className={cx(
        'uui flex min-w-0 flex-col gap-1 rounded-xl bg-primary p-4 ring-1 ring-secondary',
        className,
      )}
    >
      <p className="truncate text-sm font-medium text-tertiary">{label}</p>

      {status === 'loading' ? (
        // La barre a la hauteur d'une ligne de valeur : rien ne bouge à l'arrivée.
        <span
          aria-hidden="true"
          className="my-0.5 h-7 w-28 animate-pulse rounded-md bg-secondary"
        />
      ) : status === 'error' ? (
        <p className="text-sm text-utility-red-700">{error ?? 'Indisponible'}</p>
      ) : (
        <p className={cx('truncate text-display-xs font-semibold', TON_VALEUR[tone])}>{value}</p>
      )}

      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        {caption ? <span className="text-xs text-quaternary">{caption}</span> : null}
        {status === 'ready' && ratio ? (
          <span
            className={cx(
              'inline-flex items-center gap-0.5 text-xs font-medium',
              favorable === null && 'text-tertiary',
              favorable === true && 'text-utility-green-700',
              favorable === false && 'text-utility-red-700',
            )}
          >
            <Icon
              name="chevron-down"
              size={11}
              className={trend?.direction === 'up' ? 'icon-flip' : undefined}
              aria-hidden="true"
            />
            {ratio}
          </span>
        ) : null}
      </div>

      {hint ? <p className="text-xs text-quaternary">{hint}</p> : null}
    </div>
  );
}

/**
 * LA RANGÉE D'INDICATEURS — une grille qui ne casse jamais.
 *
 * `auto-fit` + `minmax` plutôt qu'un nombre de colonnes par palier : le nombre
 * d'indicateurs varie selon le périmètre (les remboursements n'apparaissent que
 * s'il y en a). Une grille à quatre colonnes figées aurait laissé un trou.
 */
export function MetricRow({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={cx(
        'grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4',
        className,
      )}
    >
      {children}
    </div>
  );
}

export default Metric;
