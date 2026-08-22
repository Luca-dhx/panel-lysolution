// CE QUE LE PONT SERT À UN PROJET AU SUJET DE SES MODÈLES — EN LECTURE SEULE.
//
// docs/architecture/BREVO_CONTROL_PLANE.md §« Templates ».
//
// ── CE QUI A DISPARU ICI, ET POURQUOI (L12.1) ───────────────────────────────
//
// Ce contrôleur exposait `PUT /email-templates/:id`, `POST /import` et
// `POST /:id/versions/:v/restore` : un projet authentifié pouvait ÉCRIRE le
// contenu de ses modèles dans la base du Panel.
//
// Aucun projet n'a jamais emprunté cette porte — l'audit a cherché l'appelant
// et n'en a trouvé aucun. Elle restait pourtant ouverte, et elle contredisait
// exactement ce que le lot établit : le Panel est la SEULE autorité d'édition.
// Une porte que personne n'utilise mais que l'architecture interdit ne se
// documente pas, elle se retire — sans quoi le premier lot pressé la trouvera
// et s'en servira.
//
// ── CE QUI RESTE, ET POURQUOI CHAQUE VERBE EST UNE LECTURE ──────────────────
//
//   GET  /email-templates              la projection autoritative du projet
//   GET  /email-templates/:id          le détail d'un modèle qui lui est affecté
//   POST /email-templates/:id/preview  un rendu d'aperçu, avec les variables
//                                      d'exemple DU PANEL — aucun corps accepté
//   GET  /email-templates/:id/readiness le diagnostic d'envoi
//   POST /email-templates/:id/test-send un envoi de test
//
// `preview` et `test-send` sont des POST parce qu'ils déclenchent un calcul ou
// un envoi, pas parce qu'ils écrivent un modèle : aucun des deux ne lit le
// corps de la requête pour en tirer du contenu.

import { ok } from '../utils/apiResponse.js';
import ApiError from '../utils/ApiError.js';
import {
  describeTemplateReadiness,
  getProjectedTemplate,
  listProjectedTemplates,
  previewProjectedTemplate,
  sendTemplateTestEmail,
} from '../services/email/panelEmailTemplateEditor.service.js';
import { projectScope } from '../services/email/panelEmailTemplateScope.js';

function scopeOfRequest(req) {
  const projectId = req.bridgeProject?.projectId;
  if (!projectId) {
    throw ApiError.unauthorized(
      'PANEL_EMAIL_TEMPLATE_SCOPE_UNAUTHENTICATED',
      'Aucun projet authentifié : aucune portée de modèle ne peut être ouverte.',
    );
  }
  return projectScope(String(projectId));
}

export async function listProjectEmailTemplates(req, res) {
  return ok(res, await listProjectedTemplates(scopeOfRequest(req)));
}

export async function getProjectEmailTemplate(req, res) {
  return ok(res, await getProjectedTemplate(req.params.templateId, scopeOfRequest(req)));
}

export async function postProjectEmailTemplatePreview(req, res) {
  return ok(res, await previewProjectedTemplate(req.params.templateId, scopeOfRequest(req)));
}

export async function getProjectEmailTemplateReadiness(req, res) {
  return ok(res, await describeTemplateReadiness(req.params.templateId, scopeOfRequest(req)));
}

export async function postProjectEmailTemplateTestSend(req, res) {
  return ok(res, await sendTemplateTestEmail(
    req.params.templateId,
    scopeOfRequest(req),
    req.body?.recipientEmail,
  ));
}

export default {
  getProjectEmailTemplate,
  getProjectEmailTemplateReadiness,
  listProjectEmailTemplates,
  postProjectEmailTemplatePreview,
  postProjectEmailTemplateTestSend,
};
