// LA PROSPECTION (/api/prospects).
//
// ══ QUI PEUT QUOI, ET POURQUOI PAS LA MÊME COUPURE QU'AILLEURS ═════════════
//
// LECTURE ET ÉCRITURE : tout compte authentifié du Panel.
//
// C'est délibérément différent des entreprises clientes, dont l'écriture est
// réservée aux comptes DEV. La raison n'y était pas hiérarchique : ce qui
// s'écrit sur une entreprise cliente décide de l'identité portée par des
// FACTURES et des CONTRATS SIGNÉS. Une erreur s'y voit chez un tiers, sur une
// pièce comptable.
//
// Un prospect n'engage rien. Il ne facture pas, ne signe pas, ne s'affiche
// nulle part. C'est le carnet de l'équipe commerciale — exactement comme
// l'agenda et les événements, qui sont ouverts pour la même raison. Réserver
// cette surface aux développeurs aurait fait du développeur le seul à pouvoir
// noter un rendez-vous de prospection.
//
// ══ CE QU'AUCUN PROJET NE PEUT FAIRE ═══════════════════════════════════════
//
// Lire quoi que ce soit ici. Cette surface est `/api` — l'API INTERNE, gardée
// par un jeton d'utilisateur du Panel. Le pont (`/bridge/v1`) n'expose aucune
// route de prospection, et la synchronisation ne transporte pas cette entité.
import { Router } from 'express';
import asyncHandler from '../utils/asyncHandler.js';
import { requirePanelUser } from '../middlewares/panelAuth.middleware.js';
import {
  imageUpload,
  receiveImage,
  translateUploadErrors,
} from '../services/upload/imageEndpoint.js';
import {
  applyImport,
  changeStatus,
  create,
  detail,
  list,
  previewImport,
  remove,
  update,
} from '../controllers/prospects.controller.js';

const router = Router();
router.use(asyncHandler(requirePanelUser));

router.get('/', asyncHandler(list));
router.post('/', asyncHandler(create));

/**
 * L'IMPORT D'IMAGE — avant les routes à paramètre, et sans identifiant.
 *
 * ── POURQUOI L'IMAGE N'EST PAS RATTACHÉE À UNE FICHE ICI ────────────────────
 * On dépose souvent la photo AVANT d'avoir enregistré le prospect. Exiger un
 * identifiant aurait obligé à créer une fiche vide pour pouvoir y coller une
 * devanture, puis à nettoyer les fiches abandonnées. Le média est donc importé
 * seul, et c'est la fiche qui le CITE, à l'enregistrement.
 *
 * ── POURQUOI CETTE ROUTE PLUTÔT QUE `/api/uploads/image` ────────────────────
 * L'adresse historique est gardée par `requirePanelDev` : les médias qu'elle
 * reçoit s'affichent sur tout le parc. Une photo de prospect ne sort jamais du
 * Panel. La MÉCANIQUE est pourtant strictement la même — validation sur les
 * octets, relais vers l'autorité média, réencodage unique — et elle n'est pas
 * dupliquée : les deux routes montent le même module.
 *
 * ── LE RELAIS VISE CETTE ADRESSE, PAS CELLE DES MÉDIAS DE MARQUE ────────────
 * Une instance qui n'est pas l'autorité média RELAIE le fichier, en portant le
 * jeton de l'appelant. Relayer vers `/api/uploads/image` aurait fait refuser
 * l'amont en 403 pour un compte de gestion — la garde DEV de l'autre route
 * s'appliquant chez l'autorité. Le poste voyait « import réussi » en local et
 * un échec inexplicable en ligne.
 */
router.post(
  '/images',
  imageUpload.single('file'),
  translateUploadErrors,
  receiveImage({ relayPath: '/api/prospects/images' }),
);

/**
 * L'IMPORT JSON — avant les routes à paramètre, comme l'import d'image.
 *
 * ── POURQUOI DEUX ADRESSES ET NON UNE AVEC UN DRAPEAU ───────────────────────
 * `dryRun: true` dans le corps aurait fait tenir l'écriture et sa simulation
 * sur la MÊME adresse : une faute de frappe dans le corps, un client qui oublie
 * le drapeau, et l'aperçu écrit. Deux adresses rendent la distinction visible
 * dans le journal d'accès, et impossible à franchir par accident.
 *
 * `prospectId` est dans le CORPS, pas dans le chemin : la même route sert la
 * création (aucune fiche) et la correction (une fiche). Deux chemins auraient
 * dupliqué la validation du document — et c'est toujours celle de la création
 * qu'on oublie de mettre à jour.
 */
router.post('/import/preview', asyncHandler(previewImport));
router.post('/import', asyncHandler(applyImport));

router.get('/:prospectId', asyncHandler(detail));
router.patch('/:prospectId', asyncHandler(update));
router.post('/:prospectId/status', asyncHandler(changeStatus));
router.delete('/:prospectId', asyncHandler(remove));

export default router;
