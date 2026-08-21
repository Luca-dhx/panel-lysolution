// LES ENTREPRISES CLIENTES (/api/client-companies).
//
// ══ QUI PEUT QUOI, ET POURQUOI CETTE COUPURE-LÀ ═════════════════════════════
//
// LECTURE : tout compte authentifié du Panel. Savoir à qui appartient un projet
// fait partie du travail de gestion — c'est la même règle que pour les finances
// et pour la fiche d'entreprise. Réserver cette lecture aux comptes DEV ferait
// du développeur le seul à connaître les clients de l'agence.
//
// ÉCRITURE : comptes DEV uniquement (`requirePanelDev`, qui couvre DEV et
// SUPER_ADMIN). La raison n'est pas hiérarchique : ce qui est écrit ici décide
// de l'identité portée par des FACTURES et par des CONTRATS SIGNÉS, et débloque
// ou bloque les paiements d'un client. Une erreur de saisie s'y voit chez un
// tiers, sur une pièce comptable.
//
// ══ CE QU'AUCUN PROJET NE PEUT FAIRE ════════════════════════════════════════
//
// Écrire ici. Cette surface est `/api` — l'API INTERNE, gardée par un jeton
// d'utilisateur du Panel. Le pont (`/bridge/v1`) n'expose aucune route
// d'entreprise cliente, et la synchronisation ne transporte cette entité que
// dans le sens Panel → projet. Un projet REÇOIT son identité juridique ; il ne
// la déclare jamais.
import { Router } from 'express';
import multer from 'multer';

import asyncHandler from '../utils/asyncHandler.js';
import ApiError from '../utils/ApiError.js';
import { requirePanelDev, requirePanelUser } from '../middlewares/panelAuth.middleware.js';
import { MAX_INPUT_BYTES, humanBytes } from '../services/upload/mediaPolicy.js';
import {
  archive,
  create,
  detail,
  downloadDocument,
  linkProject,
  list,
  remove,
  removeDocument,
  restore,
  unlinkProject,
  update,
  uploadDocument,
} from '../controllers/clientCompanies.controller.js';

const router = Router();

/**
 * AUCUN FILTRE DE TYPE ICI — c'est délibéré.
 *
 * `file.mimetype` est DÉCLARÉ par le navigateur d'après l'extension : un filtre
 * qui s'y fierait donnerait l'illusion d'une barrière. Le vrai contrôle lit les
 * OCTETS (`documentValidation.js`), chez l'autorité média, après le relais.
 */
const receptionDocument = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_INPUT_BYTES },
});

/** Traduit les refus de `multer` en erreurs métier — jamais en « erreur interne ». */
function traduireRefusUpload(err, req, res, next) {
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return next(new ApiError(
        413,
        'PANEL_DOCUMENT_TOO_LARGE',
        `Ce document dépasse la taille maximale acceptée (${humanBytes(MAX_INPUT_BYTES)}).`,
        { maxBytes: MAX_INPUT_BYTES },
      ));
    }
    return next(ApiError.badRequest('PANEL_DOCUMENT_INVALID', `Envoi de fichier invalide (${err.code}).`));
  }
  return next(err);
}

router.use(asyncHandler(requirePanelUser));

/* ── Lecture ──────────────────────────────────────────────────────────────── */
router.get('/', asyncHandler(list));
router.get('/:clientCompanyId', asyncHandler(detail));
/**
 * Le TÉLÉCHARGEMENT reste en lecture : un compte de gestion doit pouvoir
 * consulter le Kbis d'un client sans capacité technique. L'appartenance du
 * document à la fiche, elle, est vérifiée par le service — le chemin porte le
 * contexte, jamais une liste d'autorisations parallèle.
 */
router.get('/:clientCompanyId/documents/:documentId', asyncHandler(downloadDocument));

/* ── Écriture : DEV uniquement ────────────────────────────────────────────── */
router.use(requirePanelDev);

router.post('/', asyncHandler(create));
router.patch('/:clientCompanyId', asyncHandler(update));
router.post('/:clientCompanyId/archive', asyncHandler(archive));
router.post('/:clientCompanyId/restore', asyncHandler(restore));
router.delete('/:clientCompanyId', asyncHandler(remove));

/* ── Rattachement ─────────────────────────────────────────────────────────── */
router.post('/:clientCompanyId/projects', asyncHandler(linkProject));
/**
 * Le DÉTACHEMENT ne nomme PAS l'entreprise — un projet n'en a qu'une, et
 * l'exiger dans l'adresse permettrait de détacher en citant la mauvaise, ce que
 * la route accepterait sans rien faire d'utile.
 */
router.delete('/projects/:projectId', asyncHandler(unlinkProject));

/* ── Documents ────────────────────────────────────────────────────────────── */
router.post(
  '/:clientCompanyId/documents',
  receptionDocument.single('file'),
  traduireRefusUpload,
  asyncHandler(uploadDocument),
);
router.delete('/:clientCompanyId/documents/:documentId', asyncHandler(removeDocument));

export default router;
