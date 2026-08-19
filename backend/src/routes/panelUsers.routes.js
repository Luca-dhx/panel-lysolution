// LES COMPTES DU PANEL — trois surfaces, trois droits (L12.B-F, L12.C, LOT SUPER_ADMIN).
//
// ── LA DISTINCTION QUE CE FICHIER PORTE ─────────────────────────────────────
//
//   `/me`         SON PROPRE PROFIL. Tout compte du Panel, ADMIN compris.
//   lecture       L'ANNUAIRE. Capacités développeur — DEV ou SUPER_ADMIN.
//   écriture      L'ADMINISTRATION D'AUTRUI. SUPER_ADMIN seul.
//
// Elles se ressemblent — ce sont les mêmes documents — et elles n'ont rien à
// voir : la première corrige son nom, la deuxième renseigne, la troisième crée,
// promeut, révoque et supprime.
//
// ══ POURQUOI L'ÉCRITURE A QUITTÉ LES COMPTES DEV ════════════════════════════
//
// Un DEV pouvait activer/désactiver un compte et accorder un accès chez un
// client, sous la seule réserve de ne pas se servir lui-même. C'était le
// meilleur arbitrage possible tant qu'aucun rôle souverain n'existait : il
// fallait bien que quelqu'un puisse ouvrir la fédération, et le seul rôle
// technique disponible était DEV.
//
// Ce lot crée ce rôle. Décider qui entre chez un client est une décision de
// GOUVERNANCE, pas une opération de développement — et l'ancienne garde
// « demandez à un collègue » ne faisait que répartir un pouvoir souverain entre
// pairs. DEV garde tout ce dont le développement a besoin : les surfaces
// techniques, la lecture de l'annuaire, et les projets qu'on lui a accordés.
//
// ══ POURQUOI LA LECTURE RESTE OUVERTE AUX DEV ═══════════════════════════════
//
// Parce qu'un développeur doit pouvoir répondre à « qui d'autre a accès à ce
// projet ? » sans demander à quelqu'un. La liste ne porte aucun secret — ni
// empreinte de mot de passe, ni `tokenVersion`, ni jeton — et la fermer
// n'ajouterait aucune sécurité, seulement une dépendance de plus.
import { Router } from 'express';

import asyncHandler from '../utils/asyncHandler.js';
import {
  requirePanelDeveloper,
  requirePanelUser,
  requireSuperAdmin,
} from '../middlewares/panelAuth.middleware.js';
import {
  deletePanelUser,
  getOwnProfile,
  listAccessibleProjects,
  listPanelUsers,
  patchOwnProfile,
  patchPanelUser,
  postPanelUser,
  postPanelUserInvitation,
} from '../controllers/panelUsers.controller.js';

const router = Router();

router.use(asyncHandler(requirePanelUser));

/* ══════════════════════════════════════════════════════════════════════════
   SON PROPRE PROFIL — AVANT toute garde de privilège.

   ══ POURQUOI CES DEUX ROUTES SONT EN TÊTE ═══════════════════════════════════

   Consulter et corriger son propre nom n'est pas une opération technique :
   c'est le minimum qu'on doive à quiconque possède un compte. Les placer sous
   une garde de privilège interdirait à un ADMIN de corriger une faute de frappe
   dans son propre nom — et surtout, cela ferait dépendre un droit PERSONNEL
   d'un privilège d'ADMINISTRATION, ce que ce montage existe pour séparer.

   Elles sont sûres parce qu'elles n'ont pas de sujet : `req.panelUser.userId`
   est le seul compte qu'elles puissent lire ou écrire, et le contrôleur refuse
   tout champ qui ne soit pas `displayName`.

   ══ ET AVANT `/:userId` ════════════════════════════════════════════════════

   Sans cet ordre, `me` serait lu comme un identifiant de compte. La route
   d'administration prendrait la main, la garde souveraine s'appliquerait, et un
   ADMIN recevrait un 403 sur son propre profil.
   ══════════════════════════════════════════════════════════════════════════ */
router.get('/me', asyncHandler(getOwnProfile));
router.patch('/me', asyncHandler(patchOwnProfile));

/* ══════════════════════════════════════════════════════════════════════════
   LECTURE — capacités développeur.
   ══════════════════════════════════════════════════════════════════════════ */
router.get('/', requirePanelDeveloper, asyncHandler(listPanelUsers));
/** Montée AVANT `/:userId/…` — sinon « projects » serait lu comme un compte. */
router.get('/projects', requirePanelDeveloper, asyncHandler(listAccessibleProjects));

/* ══════════════════════════════════════════════════════════════════════════
   ÉCRITURE — souveraine, et sans exception de cible.

   Un SUPER_ADMIN agit sur un ADMIN, sur un DEV, sur un autre SUPER_ADMIN et
   sur lui-même. Aucune garde `CANNOT_EDIT_SUPER_ADMIN`, aucune garde « il doit
   rester un souverain » : ce sont des décisions de produit, prises et
   documentées dans le contrôleur. La protection contre la maladresse est une
   confirmation à l'écran qui NOMME la conséquence — pas un refus serveur qui
   empêcherait aussi les décisions légitimes.

   ══ UN SEUL `PATCH`, ET NON TROIS ROUTES DE CHAMP ═══════════════════════════

   `PATCH /:userId/enabled` et `PUT /:userId/project-access` ont disparu au
   profit d'un `PATCH /:userId` strict. Trois routes pour trois champs, c'est
   trois événements d'audit pour une seule décision d'un opérateur, et un état
   intermédiaire observable entre deux d'entre elles — un compte réactivé une
   demi-seconde avant de recevoir ses accès. La liste des champs reste FERMÉE
   par `.strict()` : un `PATCH` générique n'est dangereux que s'il accepte ce
   qu'on ne lui a pas nommé.
   ══════════════════════════════════════════════════════════════════════════ */
router.post('/', requireSuperAdmin, asyncHandler(postPanelUser));
router.patch('/:userId', requireSuperAdmin, asyncHandler(patchPanelUser));
router.delete('/:userId', requireSuperAdmin, asyncHandler(deletePanelUser));
router.post('/:userId/invitation', requireSuperAdmin, asyncHandler(postPanelUserInvitation));

export default router;
