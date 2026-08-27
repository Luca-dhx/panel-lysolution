/**
 * LES ONGLETS D'UNE FICHE — l'indicateur suit, il ne saute pas.
 *
 * ══ D'OÙ IL VIENT ══════════════════════════════════════════════════════════
 *
 * Du `smooth-tab` de Kokonut UI, dont on a gardé la seule chose qui vaut :
 * l'indicateur PARTAGÉ entre les onglets (`layoutId` de motion). Comme un seul
 * élément change de place au lieu de disparaître ici et réapparaître là, le
 * navigateur l'anime — et le regard suit le déplacement au lieu de rechercher
 * où l'onglet actif est passé.
 *
 * ══ CE QUI A ÉTÉ JETÉ, ET POURQUOI ═════════════════════════════════════════
 *
 * Tout le reste. Le composant d'origine embarque ses propres onglets en dur,
 * une palette figée (`bg-amber-500`, `bg-blue-500`, `bg-purple-500`), des
 * dégradés de texte et une icône par onglet tirée de `lucide-react`. C'est une
 * vitrine, pas une primitive : posée telle quelle dans le Panel, elle aurait
 * apporté une quatrième palette, un troisième jeu d'icônes, et des couleurs
 * incapables de suivre le thème réglable.
 *
 * Ce qui reste : la mécanique, et le vocabulaire visuel du Panel.
 *
 * ══ ACCESSIBILITÉ — CE N'EST PAS UN GROUPE DE BOUTONS ══════════════════════
 *
 * Les rôles `tablist` / `tab` sont posés, les flèches gauche/droite changent
 * d'onglet, et un SEUL onglet est dans l'ordre de tabulation (`roving
 * tabindex`). Sans cela, une fiche à cinq onglets ajoutait cinq arrêts de
 * tabulation avant d'atteindre le contenu.
 */
import { useRef } from 'react';
import type { ReactNode } from 'react';
import { motion } from 'motion/react';
import { cx } from '@/utils/cx';

export interface SmoothTab<T extends string> {
  value: T;
  label: string;
  /** Un compte à droite du libellé — « 3 » à confirmer, « 12 » mouvements. */
  badge?: ReactNode;
}

export function SmoothTabs<T extends string>({
  tabs,
  value,
  onChange,
  /**
   * Identifiant du groupe d'animation. Deux jeux d'onglets montés en même
   * temps sur un même écran DOIVENT en avoir des différents : sans cela,
   * `motion` croit qu'il s'agit du même indicateur et le fait voler de l'un à
   * l'autre.
   */
  layoutId,
  className,
}: {
  tabs: SmoothTab<T>[];
  value: T;
  onChange: (value: T) => void;
  layoutId: string;
  className?: string;
}) {
  const conteneur = useRef<HTMLDivElement>(null);

  const auClavier = (e: React.KeyboardEvent) => {
    const index = tabs.findIndex((t) => t.value === value);
    let cible = -1;
    if (e.key === 'ArrowRight') cible = (index + 1) % tabs.length;
    else if (e.key === 'ArrowLeft') cible = (index - 1 + tabs.length) % tabs.length;
    else if (e.key === 'Home') cible = 0;
    else if (e.key === 'End') cible = tabs.length - 1;
    if (cible === -1) return;
    e.preventDefault();
    onChange(tabs[cible].value);
    // Le focus SUIT la sélection : sans cela, les flèches changent d'onglet
    // pendant que le focus reste sur l'ancien, et la touche suivante repart
    // du mauvais endroit.
    conteneur.current
      ?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[cible]
      ?.focus();
  };

  return (
    <div
      ref={conteneur}
      role="tablist"
      aria-orientation="horizontal"
      onKeyDown={auClavier}
      className={cx(
        'uui flex w-max max-w-full gap-1 overflow-x-auto rounded-lg bg-secondary p-1',
        className,
      )}
    >
      {tabs.map((tab) => {
        const actif = tab.value === value;
        return (
          <button
            key={tab.value}
            type="button"
            role="tab"
            aria-selected={actif}
            tabIndex={actif ? 0 : -1}
            onClick={() => onChange(tab.value)}
            className={cx(
              'relative shrink-0 rounded-md px-3 py-1.5 text-sm font-medium whitespace-nowrap transition-colors',
              'outline-focus-ring focus-visible:outline-2 focus-visible:-outline-offset-1',
              actif ? 'text-primary' : 'text-tertiary hover:text-secondary',
            )}
          >
            {actif ? (
              <motion.span
                layoutId={layoutId}
                aria-hidden="true"
                className="absolute inset-0 rounded-md bg-primary shadow-xs ring-1 ring-secondary"
                /*
                 * Court et amorti : au-delà de ~250 ms, l'indicateur traîne
                 * derrière le contenu qui a déjà changé, et l'écran paraît
                 * lent. `prefers-reduced-motion` est respecté par `motion`.
                 */
                transition={{ type: 'spring', stiffness: 420, damping: 34 }}
              />
            ) : null}
            <span className="relative flex items-center gap-1.5">
              {tab.label}
              {tab.badge !== undefined && tab.badge !== null ? (
                <span
                  className={cx(
                    'rounded-full px-1.5 text-xs font-semibold tabular-nums',
                    actif ? 'bg-secondary text-secondary' : 'bg-primary text-tertiary',
                  )}
                >
                  {tab.badge}
                </span>
              ) : null}
            </span>
          </button>
        );
      })}
    </div>
  );
}

export default SmoothTabs;
