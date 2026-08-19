// LES MODÈLES D'UN PROJET, VUS PAR CE PROJET — surface de pont (L11.1).
//
// docs/email/EMAIL_TEMPLATE_MULTI_PROJECT_IMPLEMENTATION_REPORT.md §« Éditeur projet ».
//
// ── LA GARANTIE D'ISOLATION EST STRUCTURELLE, PAS DÉCLARATIVE ───────────────
//
// Il n'y a NULLE PART dans ce fichier d'identifiant de projet lu depuis l'URL,
// la query ou le corps. La portée est construite en un seul endroit —
// `scopeOfRequest()` — à partir de `req.bridgeProject.projectId`, que le jeton
// de pont a prouvé. Un projet ne peut donc pas atteindre la portée d'un autre :
// il n'existe aucun paramètre par lequel le demander.
//
// C'est le même principe que la passerelle de capacités, appliqué à l'édition :
// « un identifiant dans le chemin serait un identifiant que l'appelant choisit,
// donc une invitation à demander celui du voisin ».
//
// ── CE QU'UN PROJET NE PEUT PAS ATTEINDRE ───────────────────────────────────
//
//   · la portée PANEL — `scopeOfRequest()` ne la produit jamais ;
//   · la portée d'un autre projet — même raison ;
//   · un code qui ne lui appartient pas — `assertScopeAllowedForCode()` refuse
//     `PAYMENT_REQUEST_CREATED` en portée projet, quel que soit l'appelant.
import { ok } from '../utils/apiResponse.js';
import ApiError from '../utils/ApiError.js';
import {
  describeTemplateReadiness,
  getEditableTemplate,
  getEditableTemplateVersion,
  listEditableTemplateVersions,
  listEditableTemplates,
  previewEditableTemplate,
  restoreEditableTemplateVersion,
  sendTemplateTestEmail,
  updateEditableTemplate,
} from '../services/email/panelEmailTemplateEditor.service.js';
import { provisionProjectTemplates } from '../services/email/panelEmailTemplate.service.js';
import { assertNoScopeInBody, projectScope } from '../services/email/panelEmailTemplateScope.js';

/**
 * LA PORTÉE DE CETTE REQUÊTE — le SEUL producteur de portée de ce fichier.
 *
 * `req.bridgeProject` vient de `requireBridgeAuth`. Aucun repli, aucun défaut :
 * une requête sans fiche authentifiée n'arrive pas ici, et si elle y arrivait
 * (erreur de montage), on refuse plutôt que de fabriquer une portée anonyme.
 */
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

/**
 * L'ACTEUR — un PROJET, pas une personne.
 *
 * L'historique doit pouvoir distinguer « le DEV du Panel a réécrit ce texte » de
 * « le manager du client l'a réécrit ». Sans cette distinction, une régression de
 * contenu chez un client se diagnostiquerait à l'aveugle.
 */
function actorOf(req) {
  return {
    userId: `project:${req.bridgeProject?.projectId ?? 'inconnu'}`,
    userEmail: req.bridgeProject?.projectName ?? '',
  };
}

export async function listProjectEmailTemplates(req, res) {
  return ok(res, await listEditableTemplates(scopeOfRequest(req)));
}

export async function getProjectEmailTemplate(req, res) {
  return ok(res, await getEditableTemplate(req.params.templateId, scopeOfRequest(req)));
}

export async function putProjectEmailTemplate(req, res) {
  // Le corps ne fait autorité sur RIEN, y compris quand il concorde : un
  // `projectId` répété serait une habitude, et une habitude finit par être lue.
  assertNoScopeInBody(req.body ?? {});
  return ok(res, await updateEditableTemplate(
    req.params.templateId,
    scopeOfRequest(req),
    req.body ?? {},
    actorOf(req),
  ));
}

export async function postProjectEmailTemplatePreview(req, res) {
  assertNoScopeInBody(req.body ?? {});
  return ok(res, await previewEditableTemplate(
    req.params.templateId,
    scopeOfRequest(req),
    req.body ?? {},
  ));
}

export async function getProjectEmailTemplateReadiness(req, res) {
  return ok(res, await describeTemplateReadiness(req.params.templateId, scopeOfRequest(req)));
}

export async function postProjectEmailTemplateTestSend(req, res) {
  assertNoScopeInBody(req.body ?? {});
  return ok(res, await sendTemplateTestEmail(
    req.params.templateId,
    scopeOfRequest(req),
    req.body?.recipientEmail,
  ));
}

export async function getProjectEmailTemplateVersions(req, res) {
  return ok(res, await listEditableTemplateVersions(req.params.templateId, scopeOfRequest(req)));
}

export async function getProjectEmailTemplateVersion(req, res) {
  return ok(res, await getEditableTemplateVersion(
    req.params.templateId,
    scopeOfRequest(req),
    req.params.version,
  ));
}

export async function postProjectEmailTemplateRestore(req, res) {
  return ok(res, await restoreEditableTemplateVersion(
    req.params.templateId,
    scopeOfRequest(req),
    req.params.version,
    actorOf(req),
  ));
}

/**
 * `POST /bridge/v1/email-templates/import` — LA MIGRATION DU CONTENU LOCAL.
 *
 * ── POURQUOI CE VERBE EXISTE, ET POURQUOI IL EST TEMPORAIRE ────────────────
 *
 * SB Auto détient aujourd'hui le SEUL contenu réellement « propre au projet »
 * du parc : un HTML rédigé, relu, versionné dans sa base — et jamais expédié.
 * Le lot exige de ne pas le perdre (§5.1). Ce verbe est le chemin par lequel il
 * entre dans le Panel, poussé par le projet qui le détient, sous son jeton.
 *
 * ── IDEMPOTENT, ET NON DESTRUCTIF ─────────────────────────────────────────
 *
 * Une instance déjà posée n'est JAMAIS réécrite. Rejouer l'import après une
 * édition dans le Panel ne détruit donc pas ce qu'un DEV vient d'écrire — ce
 * qui serait la pire régression possible pour un verbe de migration.
 *
 * ── UN CONTENU INVALIDE REFUSE SA LIGNE, PAS LA MIGRATION ─────────────────
 *
 * Un HTML qui ne passe pas le validateur du Panel est rendu dans `refused`,
 * avec ses erreurs, et les autres passent. Refuser l'ensemble obligerait à
 * tout rejouer pour un modèle fautif, et inciterait à désactiver la validation.
 */
export async function postProjectEmailTemplatesImport(req, res) {
  assertNoScopeInBody(req.body ?? {});
  const scope = scopeOfRequest(req);
  const items = Array.isArray(req.body?.templates) ? req.body.templates : [];

  if (!items.length) {
    throw ApiError.badRequest(
      'PANEL_EMAIL_TEMPLATE_IMPORT_EMPTY',
      'Aucun modèle à importer : le corps doit porter un tableau « templates » non vide.',
    );
  }

  const contents = {};
  const codes = [];
  for (const item of items) {
    const templateCode = String(item?.templateCode ?? item?.templateId ?? '').trim();
    if (!templateCode) continue;
    codes.push(templateCode);
    contents[templateCode] = {
      name: item.name,
      description: item.description,
      subject: item.subject,
      html: item.html,
      enabled: item.enabled,
    };
  }

  const report = await provisionProjectTemplates(scope.scopeId, {
    codes,
    contents,
    actor: actorOf(req),
  });
  return ok(res, report);
}

export default {
  getProjectEmailTemplate,
  getProjectEmailTemplateReadiness,
  getProjectEmailTemplateVersion,
  getProjectEmailTemplateVersions,
  listProjectEmailTemplates,
  postProjectEmailTemplatePreview,
  postProjectEmailTemplateRestore,
  postProjectEmailTemplateTestSend,
  postProjectEmailTemplatesImport,
  putProjectEmailTemplate,
};
