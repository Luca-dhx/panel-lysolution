// LES DOCUMENTS LÉGAUX (/api/legal-templates, /api/host-companies).
//
// ══ QUI PEUT QUOI ═══════════════════════════════════════════════════════════
//
// LECTURE : tout compte authentifié du Panel. Savoir ce que les sites du parc
// publient en mentions légales fait partie du travail de gestion — c'est la
// même règle que pour les entreprises clientes et les finances.
//
// ÉCRITURE : comptes DEV (`requirePanelDev`, qui couvre DEV et SUPER_ADMIN).
// La raison n'est pas hiérarchique : ce qui est écrit ici s'affiche
// PUBLIQUEMENT sur le site de clients, sous leur responsabilité juridique. Une
// erreur de saisie s'y voit chez un tiers, sur une page opposable.
//
// ══ CE QU'AUCUN PROJET NE PEUT FAIRE ════════════════════════════════════════
//
// Écrire ici, ni lire ici. Cette surface est `/api` — l'API interne, gardée par
// un jeton d'opérateur. Le pont (`/bridge/v1`) n'expose AUCUNE route de
// document légal : la synchronisation ne transporte cette entité que dans le
// sens Panel → projet, et un projet ne peut donc pas demander le document d'un
// autre. L'autorisation est portée par l'ÉCRITURE, jamais par un filtre de
// lecture.
import { Router } from 'express';

import asyncHandler from '../utils/asyncHandler.js';
import { requirePanelDev, requirePanelUser } from '../middlewares/panelAuth.middleware.js';
import {
  archive,
  create,
  createHost,
  detail,
  list,
  listHosts,
  preview,
  previewTargets,
  projectContext,
  publish,
  remove,
  restore,
  restoreVersion,
  setHostStatus,
  update,
  updateHost,
  variables,
  versions,
} from '../controllers/legalTemplates.controller.js';

const router = Router();

router.use(asyncHandler(requirePanelUser));

/* ── LE REGISTRE ET LES CIBLES D'APERÇU ──────────────────────────────────── */
/**
 * Déclarées AVANT `/:legalTemplateId` : Express confronte les routes dans
 * l'ordre de déclaration, et `/variables` serait sinon capté comme un
 * identifiant de template — puis rendrait un 404 parfaitement mystérieux.
 */
router.get('/variables', asyncHandler(variables));
router.get('/preview-targets', asyncHandler(previewTargets));
router.get('/projects/:projectId/context', asyncHandler(projectContext));

/* ── CATALOGUE ───────────────────────────────────────────────────────────── */
router.get('/', asyncHandler(list));
router.get('/:legalTemplateId', asyncHandler(detail));
router.get('/:legalTemplateId/preview', asyncHandler(preview));
router.get('/:legalTemplateId/versions', asyncHandler(versions));

/* ── ÉCRITURE — comptes DEV ──────────────────────────────────────────────── */
router.post('/', requirePanelDev, asyncHandler(create));
router.put('/:legalTemplateId', requirePanelDev, asyncHandler(update));
router.post('/:legalTemplateId/publish', requirePanelDev, asyncHandler(publish));
router.post('/:legalTemplateId/archive', requirePanelDev, asyncHandler(archive));
router.post('/:legalTemplateId/restore', requirePanelDev, asyncHandler(restore));
router.post(
  '/:legalTemplateId/versions/:version/restore',
  requirePanelDev,
  asyncHandler(restoreVersion),
);
/**
 * La suppression est REFUSÉE dès qu'un projet référence le template — le
 * service le tranche et NOMME les projets. La route n'a pas à le savoir : une
 * règle recopiée dans un routeur est une règle qu'on oubliera de recopier au
 * second appelant.
 */
router.delete('/:legalTemplateId', requirePanelDev, asyncHandler(remove));

export default router;

/* -------------------------------------------------------------------------- */

/**
 * L'ENTREPRISE HÉBERGEUSE — routeur distinct, monté sur `/api/host-companies`.
 *
 * Il vit dans ce fichier parce que son unique raison d'être est de nourrir les
 * documents légaux : lui donner son propre module donnerait à croire qu'il
 * existe un domaine « hébergement » dans le Panel, alors qu'il n'y a qu'une
 * fiche d'identité citée par une page publique.
 */
export const hostCompaniesRouter = Router();

hostCompaniesRouter.use(asyncHandler(requirePanelUser));
hostCompaniesRouter.get('/', asyncHandler(listHosts));
hostCompaniesRouter.post('/', requirePanelDev, asyncHandler(createHost));
hostCompaniesRouter.put('/:hostCompanyId', requirePanelDev, asyncHandler(updateHost));
hostCompaniesRouter.post('/:hostCompanyId/status', requirePanelDev, asyncHandler(setHostStatus));
