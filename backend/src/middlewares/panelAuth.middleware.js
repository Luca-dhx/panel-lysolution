// Gardes de la surface interne /api : JWT utilisateur → req.panelUser.
// DEV est un superset d'ADMIN (même principe que dans les Managers).
import ApiError from '../utils/ApiError.js';
import { verifyUserToken } from '../services/auth/panelToken.service.js';
import { getUserById, PANEL_ROLES } from '../services/auth/panelUsers.service.js';

export function requirePanelUser(req, _res, next) {
  const header = req.get('authorization') ?? '';
  const token = header.startsWith('Bearer ') ? header.slice('Bearer '.length).trim() : null;
  const payload = token ? verifyUserToken(token) : null;
  const user = payload ? getUserById(payload.sub) : null;
  if (!user) {
    return next(ApiError.unauthorized('PANEL_UNAUTHORIZED', 'Authentification requise.'));
  }
  req.panelUser = user;
  return next();
}

export function requirePanelDev(req, _res, next) {
  if (req.panelUser?.role !== PANEL_ROLES.DEV) {
    return next(ApiError.forbidden('PANEL_FORBIDDEN', 'Action réservée aux comptes DEV.'));
  }
  return next();
}
