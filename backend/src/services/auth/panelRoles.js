// LES RÔLES DU PANEL — une seule définition, et c'est tout l'objet du fichier.
//
// ══ POURQUOI CE MODULE EXISTE ═══════════════════════════════════════════════
//
// Il y avait deux rôles, et une seule question à poser : « est-ce DEV ? ». Elle
// s'écrivait `role === 'DEV'` à sept endroits, et cela marchait — parce qu'avec
// deux valeurs, une comparaison EST la hiérarchie.
//
// Un troisième rôle change la nature du problème. `SUPER_ADMIN` doit franchir
// toutes les portes que `DEV` franchit, sans être `DEV`. Chaque comparaison
// directe devient donc un refus silencieux, et il n'y a aucun endroit où le
// remarquer : rien ne casse, une personne est simplement enfermée dehors. La
// correction naïve — écrire `role === 'DEV' || role === 'SUPER_ADMIN'` partout —
// reporte le problème au quatrième rôle, et garantit qu'un des sites sera
// oublié.
//
// Ce module est donc la SEULE définition de l'échelle, et les gardes ne posent
// plus la question « quel rôle ? » mais « quelle capacité ? ».
//
// ══ CE QUE CHAQUE RÔLE EST ══════════════════════════════════════════════════
//
//   ADMIN        compte de gestion. Le parc, les clients, l'agenda, les
//                finances. Aucune surface technique, aucune administration de
//                comptes, aucun accès à un projet client.
//
//   DEV          développeur L.Y Solution. Toutes les surfaces techniques du
//                Panel, et l'accès aux projets clients dans la limite de son
//                `projectAccess`. Il LIT l'annuaire des comptes ; il n'en
//                administre aucun.
//
//   SUPER_ADMIN  le rôle SOUVERAIN du Panel. Tout ce que DEV peut faire, plus
//                l'administration complète des comptes — création, rôle, état,
//                accès projets, suppression — y compris sur d'autres
//                SUPER_ADMIN et sur lui-même.
//
// ══ CE QUE `SUPER_ADMIN` N'EST PAS ══════════════════════════════════════════
//
// Ce n'est pas un rôle de PROJET. Un projet client possède son propre modèle
// de rôles et n'a jamais entendu parler du nôtre. Quand un SUPER_ADMIN entre
// dans un projet par la fédération, il y entre comme DEV — voir
// `FEDERATED_PROJECT_ROLE`.

export const PANEL_ROLES = Object.freeze({
  ADMIN: 'ADMIN',
  DEV: 'DEV',
  SUPER_ADMIN: 'SUPER_ADMIN',
});

/**
 * LES VALEURS ACCEPTÉES — l'unique source de l'énumération.
 *
 * Le schéma Mongoose, les schémas Zod, les types du frontend et les écrans en
 * dérivent. Une seconde liste écrite à la main quelque part serait une liste
 * qui divergera : c'est déjà arrivé pour d'autres énumérations de ce dépôt, et
 * le symptôme — une valeur valide refusée par une seule couche — est
 * particulièrement pénible à diagnostiquer.
 */
export const PANEL_ROLE_VALUES = Object.freeze(Object.values(PANEL_ROLES));

/**
 * LE RÔLE QUE LES PROJETS REÇOIVENT — et le seul.
 *
 * ══ POURQUOI LA PROJECTION EST UNE RÈGLE, ET NON UNE COMMODITÉ ══════════════
 *
 * Un projet client ne connaît que son propre modèle de rôles. Lui envoyer
 * `SUPER_ADMIN` reviendrait à lui demander d'interpréter une valeur dont il
 * ignore le sens — et un jour, quelqu'un lui donnerait un sens. Le risque n'est
 * pas théorique : un manager qui verrait passer « SUPER_ADMIN » finirait par en
 * faire un privilège local, et une hiérarchie du PANEL déciderait alors de
 * droits CHEZ UN CLIENT.
 *
 * L'assertion affirme donc une seule chose au projet : « ce porteur est un
 * développeur autorisé ». Ce qu'il est CHEZ NOUS ne le regarde pas.
 */
export const FEDERATED_PROJECT_ROLE = PANEL_ROLES.DEV;

/** Le rôle est-il une valeur connue ? */
export function isPanelRole(role) {
  return PANEL_ROLE_VALUES.includes(role);
}

/** Ce compte est-il souverain sur le Panel ? */
export function isSuperAdmin(role) {
  return role === PANEL_ROLES.SUPER_ADMIN;
}

/**
 * CE COMPTE A-T-IL LES CAPACITÉS DÉVELOPPEUR DU PANEL ?
 *
 * C'est la question que posent toutes les surfaces techniques — déploiement,
 * intégrations, modèles e-mail, supervision, appairages. Elle n'est PAS « le
 * rôle vaut-il DEV » : `SUPER_ADMIN ≥ DEV`, et l'échelle vit ici plutôt que
 * dans chacune des vingt routes concernées.
 */
export function isPanelDeveloper(role) {
  return role === PANEL_ROLES.DEV || isSuperAdmin(role);
}

/**
 * CE RÔLE PERMET-IL D'ENTRER DANS UN PROJET CLIENT ?
 *
 * Même population que les capacités développeur, et ce n'est pas un hasard :
 * entrer dans le code d'un client EST une surface technique. `ADMIN` en est
 * exclu — il l'était déjà, et le rester est le point de la doctrine.
 *
 * Fonction distincte de `isPanelDeveloper` malgré l'égalité actuelle : les deux
 * questions ne sont pas la même, et le jour où l'une bougera, on ne veut pas
 * découvrir qu'on a déplacé l'autre par accident.
 */
export function grantsProjectFederation(role) {
  return isPanelDeveloper(role);
}

/**
 * CE COMPTE PEUT-IL ADMINISTRER LES COMPTES DU PANEL ?
 *
 * Création, rôle, activation, accès projets, suppression. Souveraineté pleine,
 * sans exception de cible : un SUPER_ADMIN agit sur un autre SUPER_ADMIN et
 * sur lui-même. C'est une décision de produit, assumée et documentée.
 */
export function administersPanelUsers(role) {
  return isSuperAdmin(role);
}

export default {
  PANEL_ROLES,
  PANEL_ROLE_VALUES,
  FEDERATED_PROJECT_ROLE,
  administersPanelUsers,
  grantsProjectFederation,
  isPanelDeveloper,
  isPanelRole,
  isSuperAdmin,
};
