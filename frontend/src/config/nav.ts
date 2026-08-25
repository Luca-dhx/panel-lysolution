/**
 * NAVIGATION - deux espaces, une seule regle d'acces.
 *
 * `devOnly` ne protege rien a lui seul: masquer un lien n'interdit pas d'en
 * taper l'URL. La garde de route (`RequireDev`) reste la seule barriere.
 */
import type { Role } from '@/types';
import { isPanelDeveloper } from '@/auth/roles';

export type NavSection = 'GESTION' | 'DEVELOPPEUR';

export interface NavItem {
  to: string;
  label: string;
  section: NavSection;
  devOnly?: boolean;
}

export const NAV_ITEMS: NavItem[] = [
  { to: '/', label: 'Tableau de bord', section: 'GESTION' },
  { to: '/projects', label: 'Projets clients', section: 'GESTION' },
  { to: '/agenda', label: 'Agenda et événements', section: 'GESTION' },
  { to: '/clients', label: 'Clients', section: 'GESTION' },
  { to: '/finances', label: 'Finances', section: 'GESTION' },
  { to: '/company', label: 'Mon entreprise', section: 'GESTION' },
  /**
   * DOCUMENTS LEGAUX — en GESTION, aux cotes des clients et de l'entreprise.
   *
   * Ce sont des CONTENUS metier, pas de l'infrastructure : ce qui s'y ecrit
   * s'affiche sur le site d'un client, sous sa responsabilite juridique. Les
   * ranger avec les templates d'e-mail — surface DEVELOPPEUR — en aurait fait
   * un objet technique que l'equipe n'ouvrirait jamais. L'ECRITURE reste
   * reservee aux comptes DEV, cote backend, qui est la seule barriere.
   */
  { to: '/documents-legaux', label: 'Documents legaux', section: 'GESTION' },
  /**
   * ENTREPRISE HEBERGEUSE — juste apres, parce qu'elle n'existe que pour eux.
   *
   * C'est la troisieme autorite des documents legaux : ni nous, ni le client.
   * Une entree separee plutot qu'un onglet, parce qu'on vient l'editer pour
   * elle-meme — une migration d'hebergeur, une verification annuelle — et non
   * en ecrivant un template.
   */
  { to: '/hebergeur', label: 'Entreprise hebergeuse', section: 'GESTION' },

  { to: '/supervision', label: 'Supervision', section: 'DEVELOPPEUR', devOnly: true },
  { to: '/bridges', label: 'Connexions techniques', section: 'DEVELOPPEUR', devOnly: true },
  { to: '/pairings', label: 'Appairages', section: 'DEVELOPPEUR', devOnly: true },
  { to: '/versions', label: 'Versions', section: 'DEVELOPPEUR', devOnly: true },
  { to: '/integrated-apis', label: 'Integrations API', section: 'DEVELOPPEUR', devOnly: true },
  { to: '/email-sender', label: 'Expediteur e-mail', section: 'DEVELOPPEUR', devOnly: true },
  { to: '/email-templates', label: 'Templates e-mail', section: 'DEVELOPPEUR', devOnly: true },
  { to: '/deployment', label: 'Deploiement', section: 'DEVELOPPEUR', devOnly: true },
  { to: '/panel-users', label: 'Comptes L.Y Solution', section: 'DEVELOPPEUR', devOnly: true },
  { to: '/theme', label: 'Theme du Panel', section: 'DEVELOPPEUR', devOnly: true },
  { to: '/actions', label: 'Executions', section: 'DEVELOPPEUR', devOnly: true },
];

export const SECTION_ORDER: NavSection[] = ['GESTION', 'DEVELOPPEUR'];

export const SECTION_LABELS: Record<NavSection, string> = {
  GESTION: 'Gestion',
  DEVELOPPEUR: 'Developpeur',
};

/**
 * LE FILTRE DU MENU — `devOnly` s'ouvre aux CAPACITES developpeur.
 *
 * Il testait `role === 'DEV'`. Un SUPER_ADMIN n'aurait donc vu aucune entree
 * technique, alors que toutes les routes correspondantes lui sont ouvertes:
 * une application vide pour le role le plus eleve, sans le moindre message.
 * Le predicat est celui de `@/auth/roles`, en miroir du serveur.
 */
export function navItemsFor(role: Role): NavItem[] {
  return NAV_ITEMS.filter((item) => !item.devOnly || isPanelDeveloper(role));
}
