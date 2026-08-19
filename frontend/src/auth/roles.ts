import type { Role } from '@/types';

/**
 * L'ÉCHELLE DES RÔLES, CÔTÉ ÉCRAN — miroir strict de
 * `backend/src/services/auth/panelRoles.js`.
 *
 * ══ POURQUOI UNE COPIE, ALORS QUE LA DUPLICATION EST LE MAL ═════════════════
 *
 * Parce que les deux moitiés ne répondent pas à la même question. Le serveur
 * décide QUI A LE DROIT ; l'écran décide QUOI MONTRER. La première réponse est
 * une garde, la seconde une politesse — masquer un bouton n'interdit rien, et
 * ce fichier ne prétend rien interdire.
 *
 * Ce qui serait fautif, c'est que les deux DIVERGENT : une page invisible alors
 * que l'API l'autorise est un droit inutilisable, et un bouton visible que
 * l'API refuse est une promesse non tenue. D'où une seule fonction par
 * capacité, ici comme là-bas, et le même vocabulaire des deux côtés.
 *
 * ══ CE QUE CE FICHIER REMPLACE ══════════════════════════════════════════════
 *
 * `user?.role === 'DEV'`, écrit dans la garde de route, dans le filtre du menu
 * et dans un écran. Avec deux rôles, la comparaison ÉTAIT la hiérarchie. Avec
 * trois, elle enferme dehors le rôle le plus élevé — sans erreur, sans
 * message : une personne voit simplement une application vide.
 */

/** Ce compte est-il souverain sur le Panel ? */
export function isSuperAdmin(role: Role | null | undefined): boolean {
  return role === 'SUPER_ADMIN';
}

/**
 * CE COMPTE A-T-IL LES CAPACITÉS DÉVELOPPEUR ?
 *
 * `SUPER_ADMIN ≥ DEV` : tout ce qu'un développeur voit, un souverain le voit.
 */
export function isPanelDeveloper(role: Role | null | undefined): boolean {
  return role === 'DEV' || isSuperAdmin(role);
}

/** Ce compte peut-il administrer les comptes du Panel ? */
export function administersPanelUsers(role: Role | null | undefined): boolean {
  return isSuperAdmin(role);
}

/**
 * LES LIBELLÉS — en français, et une seule fois.
 *
 * `SUPER_ADMIN` s'écrit « Super Admin » à l'écran. Laisser passer la valeur
 * brute ferait entrer une constante de code dans l'interface, et l'écran
 * parlerait la langue de la base plutôt que celle de son lecteur.
 */
export const ROLE_LABEL: Record<Role, string> = {
  SUPER_ADMIN: 'Super Admin',
  DEV: 'Développeur',
  ADMIN: 'Admin',
};

/**
 * LA COULEUR DU BADGE — une table, et non trois comparaisons en ligne.
 *
 * Ce n'est pas une capacité, c'est de la présentation : on ne peut donc pas la
 * déduire de l'échelle. Mais l'écrire en ternaires imbriqués dans un écran
 * ferait réapparaître `role === 'DEV'` là où le lot vient de le supprimer — et
 * la prochaine relecture ne saurait plus distinguer une comparaison décorative
 * d'une décision d'autorisation. Une table les distingue par construction.
 *
 * Les trois familles existent déjà dans la charte du Panel ; on n'en invente
 * pas une quatrième pour un seul écran.
 */
export const ROLE_BADGE: Record<Role, string> = {
  SUPER_ADMIN: 'badge badge-warn',
  DEV: 'badge badge-ok',
  ADMIN: 'badge badge-muted',
};

/**
 * L'ORDRE D'AFFICHAGE — du plus large au plus étroit.
 *
 * Utilisé par les formulaires de choix de rôle. Un ordre alphabétique
 * placerait « Admin » en tête et suggérerait un défaut ; celui-ci décrit une
 * échelle, ce qui est exactement ce qu'un lecteur doit comprendre.
 */
export const ROLE_ORDER: Role[] = ['SUPER_ADMIN', 'DEV', 'ADMIN'];

/** Ce que chaque rôle donne, en une phrase, pour le formulaire de création. */
export const ROLE_HINT: Record<Role, string> = {
  SUPER_ADMIN:
    'Tout ce que fait un développeur, plus l’administration complète des comptes : '
    + 'création, rôles, activation, accès aux projets, suppression.',
  DEV:
    'Surfaces techniques du Panel et accès aux projets clients, dans la limite '
    + 'des accès qui lui sont accordés. N’administre aucun compte.',
  ADMIN:
    'Gestion du parc, des clients, de l’agenda et des finances. Aucune surface '
    + 'technique, et aucun accès aux projets clients.',
};

export default {
  ROLE_BADGE, ROLE_HINT, ROLE_LABEL, ROLE_ORDER,
  administersPanelUsers, isPanelDeveloper, isSuperAdmin,
};
