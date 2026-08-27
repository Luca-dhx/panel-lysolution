/**
 * L'EN-TÊTE D'ÉCRAN — un seul, pour les cinq écrans refondus.
 *
 * ══ CE QU'IL REMPLACE ═══════════════════════════════════════════════════════
 *
 * Chaque page écrivait son propre `<header className="page-header">` avec un
 * `h1`, un paragraphe, et — selon l'écran — un lien de retour, des boutons
 * dans un `div.contract-actions` posé en dessous, parfois une pastille d'état.
 * Cinq variantes de la même chose, dont aucune ne se comportait pareil quand
 * la place manquait : sur mobile, les boutons passaient sous le titre ici, à
 * côté là, et débordaient ailleurs.
 *
 * ══ CE QU'IL GARANTIT ═══════════════════════════════════════════════════════
 *
 *   · le retour, le titre et les pastilles se lisent dans cet ordre ;
 *   · les actions restent à droite tant qu'il y a la place, passent dessous
 *     ensuite — jamais coupées, jamais sur deux lignes à moitié ;
 *   · l'action PRINCIPALE est toujours la dernière du groupe, donc la plus à
 *     droite : c'est là que le pouce et le regard finissent leur course ;
 *   · un seul `h1` par écran, et il est ici.
 *
 * Aucune couleur en dur : tout vient des utilitaires branchés sur `tokens.css`.
 */
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Icon } from '@/components/Icon';
import { cx } from '@/utils/cx';

export interface PageHeaderProps {
  title: string;
  /** Une phrase, pas un paragraphe : ce qui n'est pas lu occupe quand même la place. */
  description?: ReactNode;
  /** Le fil d'Ariane du pauvre : un seul cran, celui qui sert vraiment. */
  backTo?: { to: string; label: string };
  /**
   * L'IDENTITÉ VISUELLE DU SUJET — un logo, des initiales.
   *
   * Posée À GAUCHE du titre, sur la même ligne, et `shrink-0` : elle ne pousse
   * ni les pastilles ni les actions, et disparaît proprement si l'objet n'en a
   * pas. Une fiche projet ou une fiche entreprise en a une ; une page de liste
   * n'en a pas.
   */
  avatar?: ReactNode;
  /** Pastilles d'état, à droite du titre. */
  badges?: ReactNode;
  /** Boutons et contrôles. La principale en dernier. */
  actions?: ReactNode;
  /** Une bande de filtres, sous l'en-tête et au-dessus du contenu. */
  toolbar?: ReactNode;
  className?: string;
}

export function PageHeader({
  title,
  description,
  backTo,
  avatar,
  badges,
  actions,
  toolbar,
  className,
}: PageHeaderProps) {
  return (
    <header className={cx('uui flex flex-col gap-4', className)}>
      {backTo ? (
        <Link
          to={backTo.to}
          className="inline-flex w-max items-center gap-1.5 text-sm text-tertiary transition hover:text-primary"
        >
          {/*
            Le chevron sert de flèche : une icône par direction aurait ajouté un
            tracé à la table pour une rotation. UNE seule rotation, et une seule
            source : `icon-flip-y` (une règle CSS) et `rotate-90` (un utilitaire
            Tailwind) écrivent tous deux `transform`, et le résultat dépendait
            alors de l'ordre des feuilles.
          */}
          <Icon name="chevron-down" size={14} className="rotate-90" />
          {backTo.label}
        </Link>
      ) : null}

      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div className="flex min-w-0 flex-1 items-start gap-3">
          {avatar ? <span className="mt-0.5 shrink-0">{avatar}</span> : null}
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-3">
              <h1 className="text-xl font-semibold text-primary md:text-display-xs">{title}</h1>
              {badges}
            </div>
            {description ? (
              <p className="mt-1 max-w-3xl text-sm text-tertiary">{description}</p>
            ) : null}
          </div>
        </div>

        {actions ? (
          /*
            `shrink-0` sur le groupe et `flex-wrap` à l'intérieur : les actions
            gardent leur largeur naturelle tant que la ligne tient, puis se
            replient entre elles — jamais tronquées par le titre qui grandit.
          */
          <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>
        ) : null}
      </div>

      {toolbar}
    </header>
  );
}

export default PageHeader;
