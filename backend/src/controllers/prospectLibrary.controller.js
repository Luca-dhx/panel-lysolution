/**
 * LES DOSSIERS ET LES MODÈLES — surface HTTP.
 *
 * Une seule route de liste par famille, et le filtre passe en paramètre : les
 * deux arbres sont petits, et les demander séparément coûterait deux allers
 * pour afficher un écran qui les montre côte à côte.
 */
import { created, ok } from '../utils/apiResponse.js';
import {
  createFolder,
  createTemplate,
  deleteFolder,
  deleteTemplate,
  listFolders,
  listTemplates,
  updateFolder,
  updateTemplate,
} from '../services/prospection/prospectLibrary.service.js';

/** L'auteur d'une décision. Jamais anonyme. */
const actorOf = (req) => ({
  email: req.panelUser?.email ?? null,
  role: req.panelUser?.role ?? null,
});

export async function listFoldersHandler(req, res) {
  return ok(res, { folders: await listFolders({ kind: req.query?.kind ?? null }) });
}

export async function createFolderHandler(req, res) {
  return created(res, { folder: await createFolder(req.body ?? {}, actorOf(req)) });
}

export async function updateFolderHandler(req, res) {
  return ok(res, { folder: await updateFolder(req.params.folderId, req.body ?? {}, actorOf(req)) });
}

export async function deleteFolderHandler(req, res) {
  return ok(res, await deleteFolder(req.params.folderId));
}

export async function listTemplatesHandler(req, res) {
  return ok(res, { templates: await listTemplates({ folderId: req.query?.folderId }) });
}

export async function createTemplateHandler(req, res) {
  return created(res, { template: await createTemplate(req.body ?? {}, actorOf(req)) });
}

export async function updateTemplateHandler(req, res) {
  return ok(res, {
    template: await updateTemplate(req.params.templateId, req.body ?? {}, actorOf(req)),
  });
}

export async function deleteTemplateHandler(req, res) {
  return ok(res, await deleteTemplate(req.params.templateId));
}
