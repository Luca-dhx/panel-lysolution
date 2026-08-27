/**
 * LES TROIS ÉTATS — attente, vide, erreur.
 *
 * ══ POURQUOI ILS SONT DES COMPOSANTS, ET NON DES `if` DANS CHAQUE ÉCRAN ═════
 *
 * Parce qu'écrits à la main, ils divergent. Le Panel affichait selon l'endroit :
 * « Chargement… », « Chargement du parc… », un point animé, ou rien du tout.
 * Trois écrans sur quatre oubliaient l'état vide, et l'utilisateur lisait un
 * tableau sans lignes en se demandant si la requête avait échoué.
 *
 * ══ L'ATTENTE EST STRUCTURELLE, JAMAIS UN TOURNIQUET ════════════════════════
 *
 * Un `Skeleton` occupe EXACTEMENT la place du contenu à venir. C'est ce qui
 * évite le saut de mise en page — le contenu qui arrive et pousse tout vers le
 * bas juste au moment où l'on clique. Un tourniquet centré ne réserve aucune
 * place et garantit le saut.
 *
 * `Skeleton` vient de Radix Themes : il gère l'animation, `prefers-reduced-
 * motion` et l'annonce aux lecteurs d'écran, ce qu'un `div` animé à la main ne
 * fait pas.
 *
 * ══ UNE ERREUR NE DÉTRUIT PAS L'ÉCRAN ═══════════════════════════════════════
 *
 * `ErrorState` est un `Callout` Radix : un bloc d'information, pas une alerte
 * rouge pleine largeur. Il porte un bouton « Réessayer » quand l'appelant sait
 * comment réessayer — et n'en porte pas quand il ne sait pas, plutôt qu'un
 * bouton qui ne ferait rien.
 */
import type { ReactNode } from 'react';
import { Callout, Skeleton } from '@radix-ui/themes';
import { Icon } from '@/components/Icon';
import { cx } from '@/utils/cx';
import { RadixScope } from '@/components/radix/RadixScope';

/* ── ATTENTE ──────────────────────────────────────────────────────────────── */

/** Une ligne de texte fantôme. `width` en classes utilitaires. */
export function SkeletonLine({ className }: { className?: string }) {
  return (
    <RadixScope>
      <Skeleton>
        <span className={cx('block h-4 w-full rounded', className)} />
      </Skeleton>
    </RadixScope>
  );
}

/**
 * LE SQUELETTE D'UN TABLEAU — autant de lignes que la liste en affichera.
 *
 * `rows` est renseigné par l'appelant à partir de ce qu'il attend vraiment :
 * un squelette de dix lignes devant une liste qui en rendra trois provoque
 * exactement le saut qu'on cherche à éviter, en sens inverse.
 */
export function SkeletonRows({
  rows = 5,
  columns = 4,
  className,
}: {
  rows?: number;
  columns?: number;
  className?: string;
}) {
  return (
    <RadixScope>
      <div className={cx('uui flex flex-col', className)} aria-busy="true" aria-live="polite">
        <span className="sr-only">Chargement…</span>
        {Array.from({ length: rows }, (_, ligne) => (
          <div
            key={ligne}
            className="flex items-center gap-4 border-b border-secondary px-4 py-4 last:border-b-0 lg:px-6"
          >
            {Array.from({ length: columns }, (_, colonne) => (
              <Skeleton key={colonne}>
                <span
                  className={cx(
                    'block h-4 rounded',
                    colonne === 0 ? 'w-40 flex-1' : 'w-20',
                    colonne > 1 && 'hidden lg:block',
                  )}
                />
              </Skeleton>
            ))}
          </div>
        ))}
      </div>
    </RadixScope>
  );
}

/* ── VIDE ─────────────────────────────────────────────────────────────────── */

/**
 * UN VIDE ACTIONNABLE.
 *
 * « Aucun résultat » sans rien à faire laisse l'utilisateur dans une impasse.
 * Quand une action existe — créer, élargir le filtre — elle est ici.
 */
export function EmptyPanel({
  title,
  hint,
  action,
  icon = 'archive',
  className,
}: {
  title: string;
  hint?: ReactNode;
  action?: ReactNode;
  icon?: Parameters<typeof Icon>[0]['name'];
  className?: string;
}) {
  return (
    <div
      className={cx(
        'uui flex flex-col items-center justify-center gap-2 px-6 py-10 text-center',
        className,
      )}
    >
      <span className="flex size-10 items-center justify-center rounded-lg bg-secondary text-fg-quaternary">
        <Icon name={icon} size={20} aria-hidden="true" />
      </span>
      <p className="text-sm font-medium text-primary">{title}</p>
      {hint ? <p className="max-w-md text-sm text-tertiary">{hint}</p> : null}
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  );
}

/* ── ERREUR ───────────────────────────────────────────────────────────────── */

export function ErrorState({
  message,
  onRetry,
  className,
}: {
  message: string;
  onRetry?: () => void;
  className?: string;
}) {
  return (
    <RadixScope className={className}>
      <Callout.Root color="red" variant="surface" role="alert">
        <Callout.Icon>
          <Icon name="exclamation-triangle" size={16} aria-hidden="true" />
        </Callout.Icon>
        <Callout.Text>
          {message}
          {onRetry ? (
            <>
              {' '}
              <button
                type="button"
                onClick={onRetry}
                className="underline underline-offset-2"
              >
                Réessayer
              </button>
            </>
          ) : null}
        </Callout.Text>
      </Callout.Root>
    </RadixScope>
  );
}

/**
 * UN AVERTISSEMENT NON BLOQUANT — ce qui est affiché reste vrai, mais date.
 *
 * Distinct de `ErrorState` : celui-ci accompagne du contenu lisible, l'autre le
 * remplace. Les confondre ferait effacer un écran valable pour une relecture
 * ratée.
 */
export function NoticeState({
  message,
  className,
}: {
  message: ReactNode;
  className?: string;
}) {
  return (
    <RadixScope className={className}>
      <Callout.Root color="amber" variant="surface">
        <Callout.Icon>
          <Icon name="exclamation-triangle" size={16} aria-hidden="true" />
        </Callout.Icon>
        <Callout.Text>{message}</Callout.Text>
      </Callout.Root>
    </RadixScope>
  );
}
