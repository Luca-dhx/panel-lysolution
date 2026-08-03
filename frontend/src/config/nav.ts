/**
 * NAVIGATION — deux espaces, une seule règle d'accès.
 *
 * Le Panel s'adresse à toute l'équipe, pas aux seuls développeurs. La barre
 * latérale était plate : « Projets » y côtoyait « Bridges », « Versions » et
 * « Appairages », et rien n'était masqué — un commercial voyait la totalité de
 * l'infrastructure. Les entrées portent désormais leur section, et `devOnly`
 * dit qui peut les voir.
 *
 * `devOnly` NE PROTÈGE RIEN À LUI SEUL : masquer un lien n'interdit pas d'en
 * taper l'URL. La garde de route (`RequireDev`) est la seule barrière ; cette
 * liste ne fait que refléter la même règle dans le menu.
 */
import type { Role } from '@/types';

export type NavSection = 'GESTION' | 'DEVELOPPEUR';

export interface NavItem {
  to: string;
  label: string;
  section: NavSection;
  /** Réservé aux comptes DEV du Panel. */
  devOnly?: boolean;
}

export const NAV_ITEMS: NavItem[] = [
  // ── GESTION — le quotidien de l'équipe ────────────────────────────────────
  { to: '/', label: 'Tableau de bord', section: 'GESTION' },
  { to: '/projects', label: 'Projets clients', section: 'GESTION' },
  // Agenda ET événements : une seule page, les filtres suffisent à passer de
  // l'un à l'autre. Deux écrans auraient montré les mêmes objets deux fois.
  { to: '/agenda', label: 'Agenda et événements', section: 'GESTION' },
  // « Mon entreprise » et non « Entreprise » : cette page porte l'identité de
  // L.Y Solution publiée vers les sites, pas la fiche d'un client.
  { to: '/company', label: 'Mon entreprise', section: 'GESTION' },

  // ── DÉVELOPPEUR — l'infrastructure ────────────────────────────────────────
  { to: '/supervision', label: 'Supervision', section: 'DEVELOPPEUR', devOnly: true },
  { to: '/bridges', label: 'Connexions techniques', section: 'DEVELOPPEUR', devOnly: true },
  { to: '/pairings', label: 'Appairages', section: 'DEVELOPPEUR', devOnly: true },
  { to: '/versions', label: 'Versions', section: 'DEVELOPPEUR', devOnly: true },
  { to: '/integrated-apis', label: 'Intégrations API', section: 'DEVELOPPEUR', devOnly: true },
  { to: '/deployment', label: 'Déploiement', section: 'DEVELOPPEUR', devOnly: true },
  { to: '/theme', label: 'Thème du Panel', section: 'DEVELOPPEUR', devOnly: true },
  { to: '/actions', label: 'Exécutions', section: 'DEVELOPPEUR', devOnly: true },
];

export const SECTION_ORDER: NavSection[] = ['GESTION', 'DEVELOPPEUR'];

export const SECTION_LABELS: Record<NavSection, string> = {
  GESTION: 'Gestion',
  DEVELOPPEUR: 'Développeur',
};

/** Entrées visibles pour un rôle donné — l'unique filtre du menu. */
export function navItemsFor(role: Role): NavItem[] {
  return NAV_ITEMS.filter((item) => !item.devOnly || role === 'DEV');
}
