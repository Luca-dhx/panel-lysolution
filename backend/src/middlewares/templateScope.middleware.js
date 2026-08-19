// LA PORTÉE D'UNE REQUÊTE D'ÉDITION — le SEUL endroit où le réseau en produit une.
//
// docs/email/EMAIL_TEMPLATE_MULTI_PROJECT_IMPLEMENTATION_REPORT.md §« Sécurité ».
//
// ── LA CORRECTION DE LA PHASE 0.1, EN DEUX GESTES ───────────────────────────
//
// L'audit avait trouvé qu'un `PUT /email-templates/:code` portant
// `{"projectId":"<un client>"}` créait un document que l'IHM ne montrait jamais,
// que l'historique ignorait, que la restauration ne pouvait pas annuler — et
// que le runtime servait à ce projet, en priorité, indéfiniment.
//
// Deux gestes referment cela, et il en fallait deux :
//
//   1. LE CORPS EST REFUSÉ. Pas ignoré : refusé, avec un code. Un corps ignoré
//      en silence laisse l'appelant croire qu'il a agi, et invite le prochain
//      développeur à rebrancher le champ « puisqu'il était déjà envoyé ».
//
//   2. LA PORTÉE EST CONSTRUITE ICI, à partir de paramètres de REQUÊTE
//      explicitement nommés, puis VALIDÉE contre le registre des projets. Une
//      portée qui désigne un projet inexistant est refusée — sinon on
//      recréerait la ligne fantôme sous un autre nom.
//
// ── POURQUOI LA QUERY, ET PAS LE CHEMIN ─────────────────────────────────────
//
// `GET /email-templates/:scope/:scopeId?/:code` aurait été plus joli. Il aurait
// aussi cassé les neuf routes existantes, leur écran, leurs tests et le client
// TypeScript, dans le même lot que le changement de comportement du résolveur.
// Deux ruptures simultanées se diagnostiquent mal. La query est explicite,
// versionnable, et le défaut — PANEL — est le seul défaut sûr.
import ApiError from '../utils/ApiError.js';
import {
  SCOPE_TYPES,
  assertNoScopeInBody,
  assertScopeUsable,
  normalizeScope,
  panelScope,
} from '../services/email/panelEmailTemplateScope.js';

/**
 * Construit `req.templateScope` — portée VALIDÉE, ou refus.
 *
 * Asynchrone : la validation d'un projet interroge le registre. À monter avec
 * `asyncHandler`, comme les autres gardes du Panel.
 */
export async function resolveTemplateScope(req, _res, next) {
  // Le corps ne fait autorité sur RIEN, y compris quand il concorde.
  assertNoScopeInBody(req.body ?? {});

  const requested = req.query?.scope ?? req.query?.scopeType ?? null;

  if (requested === null || requested === undefined || String(requested).trim() === '') {
    // Défaut SÛR : une portée absente désigne le contenu de L.Y Solution,
    // jamais celui d'un client.
    req.templateScope = panelScope();
    return next();
  }

  const scope = normalizeScope({
    scopeType: requested,
    scopeId: req.query?.projectId ?? req.query?.scopeId ?? null,
  });

  await assertScopeUsable(scope);
  req.templateScope = scope;
  return next();
}

/**
 * RESTREINT une requête à la portée PANEL.
 *
 * Réservée aux routes qui n'ont pas de sens ailleurs. Aucune n'existe
 * aujourd'hui ; la garde est là pour que la prochaine n'ait pas à réinventer
 * « et si quelqu'un passait ?scope=PROJECT ».
 */
export function requirePanelScope(req, _res, next) {
  if (req.templateScope?.scopeType !== SCOPE_TYPES.PANEL) {
    return next(ApiError.forbidden(
      'PANEL_EMAIL_TEMPLATE_SCOPE_FORBIDDEN',
      'Cette opération ne s’applique qu’à la portée PANEL.',
    ));
  }
  return next();
}

export default { resolveTemplateScope, requirePanelScope };
