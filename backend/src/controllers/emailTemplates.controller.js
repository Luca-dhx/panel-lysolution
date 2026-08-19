// L'ÉDITEUR DE MODÈLES — surface DEV, scopée (L11.1).
//
// La portée n'est JAMAIS lue ici : elle a été construite et validée par
// `resolveTemplateScope`, et arrive sur `req.templateScope`. Un contrôleur qui
// la reconstruirait à partir de `req.query` rouvrirait la porte que le
// middleware vient de fermer — c'est exactement ce qu'un lecteur pressé ferait
// « pour éviter un import ».
import { ok } from '../utils/apiResponse.js';
import {
  compareScopesForCode,
  describeTemplateReadiness,
  getEditableTemplate,
  getEditableTemplateVersion,
  listAdministrableScopes,
  listEditableTemplateVersions,
  listEditableTemplates,
  previewEditableTemplate,
  restoreEditableTemplateVersion,
  sendTemplateTestEmail,
  updateEditableTemplate,
} from '../services/email/panelEmailTemplateEditor.service.js';
import { describeOwnership } from '../services/email/panelEmailTemplateDefinitions.js';

function actorOf(req) {
  return {
    userId: req.panelUser?.userId ?? null,
    userEmail: req.panelUser?.email ?? null,
  };
}

function scopeOf(req) {
  return req.templateScope;
}

/** Les portées que ce compte peut administrer. Le Panel DEV les a toutes. */
export async function getEmailTemplateScopes(_req, res) {
  return ok(res, await listAdministrableScopes());
}

/**
 * LA TABLE D'OWNERSHIP — quel code appartient à qui, et pourquoi.
 *
 * Exposée parce qu'elle est la réponse à la question que tout le lot pose :
 * « qui possède cette communication ? ». La garder dans le code seul obligerait
 * un exploitant à lire un fichier source pour savoir pourquoi il ne peut pas
 * éditer `PAYMENT_REQUEST_CREATED` chez un client.
 */
export async function getEmailTemplateOwnership(_req, res) {
  return ok(res, describeOwnership());
}

export async function listEmailTemplates(req, res) {
  return ok(res, await listEditableTemplates(scopeOf(req)));
}

export async function getEmailTemplate(req, res) {
  return ok(res, await getEditableTemplate(req.params.templateId, scopeOf(req)));
}

export async function putEmailTemplate(req, res) {
  return ok(res, await updateEditableTemplate(
    req.params.templateId,
    scopeOf(req),
    req.body ?? {},
    actorOf(req),
  ));
}

export async function postEmailTemplatePreview(req, res) {
  return ok(res, await previewEditableTemplate(req.params.templateId, scopeOf(req), req.body ?? {}));
}

export async function getEmailTemplateReadiness(req, res) {
  return ok(res, await describeTemplateReadiness(req.params.templateId, scopeOf(req)));
}

export async function postEmailTemplateTestSend(req, res) {
  return ok(res, await sendTemplateTestEmail(
    req.params.templateId,
    scopeOf(req),
    req.body?.recipientEmail,
  ));
}

export async function getEmailTemplateVersions(req, res) {
  return ok(res, await listEditableTemplateVersions(req.params.templateId, scopeOf(req)));
}

export async function getEmailTemplateVersion(req, res) {
  return ok(res, await getEditableTemplateVersion(
    req.params.templateId,
    scopeOf(req),
    req.params.version,
  ));
}

export async function postEmailTemplateRestore(req, res) {
  return ok(res, await restoreEditableTemplateVersion(
    req.params.templateId,
    scopeOf(req),
    req.params.version,
    actorOf(req),
  ));
}

/** Le même code, vu dans TOUTES ses portées — l'écran de comparaison du §25. */
export async function getEmailTemplateScopeComparison(req, res) {
  return ok(res, await compareScopesForCode(req.params.templateId));
}

export default {
  getEmailTemplate,
  getEmailTemplateOwnership,
  getEmailTemplateReadiness,
  getEmailTemplateScopeComparison,
  getEmailTemplateScopes,
  getEmailTemplateVersion,
  getEmailTemplateVersions,
  listEmailTemplates,
  postEmailTemplatePreview,
  postEmailTemplateRestore,
  postEmailTemplateTestSend,
  putEmailTemplate,
};
