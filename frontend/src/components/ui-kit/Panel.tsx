/**
 * UN BLOC DE CONTENU — le cadre commun des écrans refondus.
 *
 * ══ CE QU'IL EST, ET CE QU'IL N'EST PAS ═════════════════════════════════════
 *
 * Ce n'est pas un remplacement de `<Card>` : la carte maison sert encore les
 * quinze écrans que cette mission ne touche pas, et la remplacer partout aurait
 * été une réécriture. C'est le cadre des écrans REFONDUS, avec ce que la carte
 * ne savait pas faire :
 *
 *   · un en-tête à trois zones — titre, pastille de compte, actions à droite ;
 *   · une description sous le titre, qui ne pousse pas les actions ;
 *   · un pied facultatif, séparé, pour une note ou une pagination ;
 *   · un mode `flush` : le contenu touche les bords, ce dont un tableau a
 *     besoin pour que ses lignes traversent toute la carte.
 *
 * ── L'EN-TÊTE PASSE EN COLONNE À 1024 px, PAS À 768 ─────────────────────────
 * La barre latérale du Panel reprend 250 px dès 900 px de fenêtre : il y a donc
 * MOINS de place à 900 px qu'à 768 px, où elle est encore un tiroir. Un palier
 * posé au réflexe `md` fait déborder juste après le seuil du tiroir — sur la
 * seule largeur où personne ne pense à regarder.
 */
import type { ReactNode } from 'react';
import { cx } from '@/utils/cx';

export interface PanelProps {
  title?: ReactNode;
  description?: ReactNode;
  /** Un compte, une pastille — ce qui qualifie le titre sans le rallonger. */
  badge?: ReactNode;
  actions?: ReactNode;
  footer?: ReactNode;
  /** Le contenu touche les bords du cadre. Pour les tableaux. */
  flush?: boolean;
  children: ReactNode;
  className?: string;
  bodyClassName?: string;
}

export function Panel({
  title,
  description,
  badge,
  actions,
  footer,
  flush = false,
  children,
  className,
  bodyClassName,
}: PanelProps) {
  const aUnEntete = Boolean(title || description || actions || badge);

  return (
    <section
      className={cx(
        'uui overflow-hidden rounded-xl bg-primary shadow-xs ring-1 ring-secondary',
        className,
      )}
    >
      {aUnEntete ? (
        <div className="flex flex-col gap-3 border-b border-secondary px-4 py-4 lg:flex-row lg:items-center lg:justify-between lg:px-6 lg:py-5">
          <div className="min-w-0 flex-1">
            {title ? (
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="text-md font-semibold text-primary">{title}</h2>
                {badge}
              </div>
            ) : null}
            {description ? (
              <p className="mt-0.5 text-sm text-tertiary">{description}</p>
            ) : null}
          </div>
          {actions ? (
            <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>
          ) : null}
        </div>
      ) : null}

      <div className={cx(flush ? '' : 'px-4 py-4 lg:px-6 lg:py-5', bodyClassName)}>
        {children}
      </div>

      {footer ? (
        <div className="border-t border-secondary px-4 py-3 text-sm text-tertiary lg:px-6">
          {footer}
        </div>
      ) : null}
    </section>
  );
}

export default Panel;
