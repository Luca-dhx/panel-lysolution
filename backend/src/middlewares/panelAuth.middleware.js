// Gardes de la surface interne /api : JWT utilisateur → req.panelUser.
//
// ══ L'ÉCHELLE DES RÔLES NE VIT PAS ICI ══════════════════════════════════════
//
// Elle vit dans `services/auth/panelRoles.js`, et ces gardes ne font que la
// consulter. La distinction a un coût nul et une valeur immédiate : le jour où
// un quatrième rôle arrive, on modifie une échelle — pas vingt routes.
//
// Ce fichier portait `role !== PANEL_ROLES.DEV`. Avec deux rôles, une
// comparaison EST une hiérarchie ; avec trois, elle enferme dehors le rôle le
// plus élevé, sans que rien ne le signale.
import ApiError from '../utils/ApiError.js';
import { verifyUserToken } from '../services/auth/panelToken.service.js';
import { getStoredUserById, toPublicUser } from '../services/auth/panelUsers.service.js';
import { administersPanelUsers, isPanelDeveloper } from '../services/auth/panelRoles.js';

export async function requirePanelUser(req, _res, next) {
  const header = req.get('authorization') ?? '';
  const token = header.startsWith('Bearer ') ? header.slice('Bearer '.length).trim() : null;
  const payload = token ? verifyUserToken(token) : null;
  const storedUser = payload ? await getStoredUserById(payload.sub) : null;

  /**
   * TROIS REFUS, UN SEUL MESSAGE.
   *
   *   compte absent          — supprimé depuis l'émission du jeton
   *   `enabled === false`    — compte désactivé (L12.A)
   *   `ver` ≠ `tokenVersion` — session révoquée
   *
   * Les trois sont indistinguables de l'extérieur, et c'est voulu : distinguer
   * « désactivé » de « inconnu » renseignerait un porteur de jeton volé sur ce
   * qui est arrivé au compte. Le journal du serveur, lui, sait.
   *
   * `enabled !== false` plutôt que `enabled === true` : un document antérieur
   * au backfill n'a pas le champ, et il décrit un compte en exercice.
   *
   * ── LE RÔLE EST RELU ICI, ET C'EST CE QUI REND LES CHANGEMENTS VIVANTS ─────
   *
   * `req.panelUser.role` vient du document, jamais du jeton. Une promotion ou
   * une rétrogradation prend donc effet à la requête SUIVANTE, sans
   * reconnexion et sans invalider quoi que ce soit. C'est la raison pour
   * laquelle aucun changement de rôle n'incrémente `tokenVersion`.
   */
  const refuse = !storedUser
    || storedUser.enabled === false
    || (payload?.ver ?? 0) !== (storedUser.tokenVersion ?? 0);

  if (refuse) {
    return next(ApiError.unauthorized('PANEL_UNAUTHORIZED', 'Authentification requise.'));
  }
  req.panelUser = toPublicUser(storedUser);
  return next();
}

/**
 * LES CAPACITÉS DÉVELOPPEUR DU PANEL — `DEV` ou `SUPER_ADMIN`.
 *
 * Déploiement, intégrations, modèles e-mail, supervision, appairages,
 * exécutions, thème, imports. Tout ce que la doctrine appelle « surface
 * technique ». `ADMIN` en reste exclu, comme avant.
 */
export function requirePanelDeveloper(req, _res, next) {
  if (!isPanelDeveloper(req.panelUser?.role)) {
    return next(ApiError.forbidden(
      'PANEL_FORBIDDEN',
      'Action réservée aux comptes développeur du Panel.',
    ));
  }
  return next();
}

/**
 * L'ANCIEN NOM, CONSERVÉ — vingt fichiers de routes l'importent.
 *
 * Ce n'est pas de la complaisance : renommer vingt montages pour un changement
 * de PRÉDICAT produirait un diff où la seule modification qui compte — le
 * passage de « est DEV » à « a les capacités développeur » — serait noyée. Le
 * nom canonique est `requirePanelDeveloper` ; celui-ci est son alias, et les
 * deux désignent exactement la même fonction.
 */
export const requirePanelDev = requirePanelDeveloper;

/**
 * LA SOUVERAINETÉ — `SUPER_ADMIN` seul.
 *
 * Administration des comptes : création, rôle, activation, accès projets,
 * suppression. Sans exception de cible — un SUPER_ADMIN agit sur un autre
 * SUPER_ADMIN et sur lui-même. Voir `panelRoles.js` pour la doctrine.
 */
export function requireSuperAdmin(req, _res, next) {
  if (!administersPanelUsers(req.panelUser?.role)) {
    return next(ApiError.forbidden(
      'PANEL_SUPER_ADMIN_REQUIRED',
      'Action réservée au rôle Super Admin du Panel.',
    ));
  }
  return next();
}
