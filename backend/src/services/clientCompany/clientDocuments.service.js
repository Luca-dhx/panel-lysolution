// LES DOCUMENTS ADMINISTRATIFS D'UNE ENTREPRISE CLIENTE.
//
// ══ CE MODULE NE STOCKE RIEN ════════════════════════════════════════════════
//
// Il n'écrit aucun fichier, ne calcule aucune empreinte, ne nomme aucun objet.
// Tout cela appartient au protocole Media PRIVÉ (`privateMedia.service.js`),
// qui le fait déjà pour les justificatifs financiers. Ce module fait deux
// choses, et deux seulement :
//
//   1. il DÉCIDE qui a le droit de déposer ou de lire — parce que cette
//      décision dépend de la FICHE CLIENTE, et d'elle seule ;
//   2. il RELIE un `mediaId` à une entreprise.
//
// C'est exactement la frontière annoncée par `receipts.service.js` : « un futur
// PROJECT_CONTRACT ou CLIENT_INVOICE s'ajoutera de la même façon ». On s'ajoute
// de la même façon, sans ouvrir une seconde pile de fichiers.
//
// ══ POURQUOI L'ADRESSE DE LECTURE PASSE PAR L'ENTREPRISE ════════════════════
//
// On aurait pu exposer `/api/media/private/:mediaId`. Cette surface-là ne peut
// être autorisée que par une table d'ACL parallèle : un média, seul, ne sait
// pas à qui il appartient.
//
// En passant par `/api/client-companies/:id/documents/:documentId`, le CHEMIN
// porte le contexte. On charge la fiche, on vérifie que le document demandé est
// bien LE SIEN, et l'autorisation devient une conséquence de l'objet métier
// plutôt qu'une liste à maintenir. Un identifiant récupéré ailleurs ne mène
// nulle part.
//
// ══ UNE SEULE AUTORITÉ MÉDIA, ET ELLE EST DÉPLOYÉE ══════════════════════════
//
// Le dépôt et la lecture RELAIENT vers l'autorité quand cette instance n'en est
// pas une — même discipline que les images (`upload.routes.js`). C'est ce qui
// fait qu'un document déposé depuis un poste de développement existe sur le
// Panel déployé, et qu'un document déposé en ligne se relit depuis le poste.
//
// Sans ce relais, le descripteur — écrit dans la base PARTAGÉE — annoncerait un
// fichier que l'autre instance ne trouverait jamais : `PANEL_MEDIA_FILE_MISSING`
// à chaque téléchargement, sur un document pourtant bien déposé.
import { randomUUID } from 'node:crypto';

import ApiError from '../../utils/ApiError.js';
import logger from '../../utils/logger.js';
import PanelClientCompany from '../../models/PanelClientCompany.model.js';
import { EVENT_TYPES } from '../../models/PanelSupervision.model.js';
import { recordEvent } from '../supervision/timeline.service.js';
import { nowIso } from '../../bridge/bridgeContract.js';
import {
  deletePrivateMedia, readPrivateMedia, storePrivateDocument,
} from '../upload/privateMedia.service.js';
import { getClientCompanyOrThrow } from './clientCompany.service.js';
import { validateClientDocumentInput } from './clientCompany.validation.js';

/**
 * LA PORTÉE MÉTIER de ces documents dans le protocole Media.
 *
 * Elle les distingue des justificatifs financiers et des logos dans la
 * collection commune : même protocole, familles séparées. C'est cette portée,
 * et non le rôle, qui permet de répondre à « quels fichiers appartiennent aux
 * dossiers clients ? » sans lire chaque descripteur.
 */
export const CLIENT_DOCUMENT_SCOPE = 'CLIENT_COMPANY_DOCUMENT';

/** Le rôle documentaire — il choisit la politique de taille et de types. */
export const CLIENT_DOCUMENT_ROLE = 'client-document';

/**
 * Le document demandé appartient-il à CETTE fiche ?
 *
 * Le refus est un 404, jamais un 403 : distinguer « ce document n'existe pas »
 * de « il existe mais pas chez vous » apprendrait à un porteur d'identifiant
 * quels documents existent ailleurs. Même doctrine que pour les ressources
 * Stripe.
 */
function documentOfOrThrow(fiche, documentId) {
  const document = (fiche.documents ?? []).find((d) => d.documentId === documentId);
  if (!document) {
    throw ApiError.notFound('PANEL_CLIENT_DOCUMENT_NOT_FOUND', 'Document introuvable.');
  }
  return document;
}

/**
 * DÉPOSE un document sur une fiche cliente.
 *
 * ══ ORDRE DES OPÉRATIONS ════════════════════════════════════════════════════
 *
 * Le média est écrit AVANT d'être référencé. Un échec en cours laisse donc au
 * pire un média orphelin — invisible, inoffensif, ramassable — jamais une fiche
 * qui annoncerait un document dont le fichier n'existe pas. Le second cas est
 * celui qu'on ne rattrape pas : l'écran proposerait un téléchargement qui
 * échouerait toujours.
 *
 * ══ AUCUN REMPLACEMENT IMPLICITE ════════════════════════════════════════════
 *
 * Déposer un nouveau Kbis n'écrase pas l'ancien. Deux Kbis de deux années sont
 * deux documents, et c'est souvent l'ancien qu'on cherche. Le remplacement est
 * un RETRAIT suivi d'un dépôt — deux gestes, deux traces.
 */
export async function attachClientDocument(clientCompanyId, { buffer, filename, meta }, actor = {}) {
  const fiche = await getClientCompanyOrThrow(clientCompanyId);

  const verdict = validateClientDocumentInput(meta);
  if (!verdict.valid) {
    throw ApiError.badRequest(
      'PANEL_CLIENT_DOCUMENT_INVALID',
      `Document invalide : ${verdict.errors.join(' · ')}`,
      { errors: verdict.errors },
    );
  }

  const media = await storePrivateDocument({
    buffer,
    scope: CLIENT_DOCUMENT_SCOPE,
    role: CLIENT_DOCUMENT_ROLE,
    filename,
    createdBy: actor.userEmail ?? null,
  });

  const at = nowIso();
  const entree = {
    documentId: randomUUID(),
    mediaId: media.mediaId,
    label: verdict.value.label,
    type: verdict.value.type,
    documentDate: verdict.value.documentDate,
    uploadedAt: at,
    uploadedBy: actor.userEmail ?? null,
  };

  await PanelClientCompany.updateOne(
    { clientCompanyId },
    { $push: { documents: entree }, $set: { updatedAt: at, updatedBy: actor.userEmail ?? null } },
  );

  await recordEvent({
    projectId: null,
    type: EVENT_TYPES.CLIENT_COMPANY_DOCUMENT_ADDED,
    source: 'PANEL',
    summary: `Document « ${entree.label} » déposé sur l’entreprise cliente « ${fiche.legalName} ».`,
    data: {
      clientCompanyId,
      documentId: entree.documentId,
      type: entree.type,
      /** La TAILLE et le TYPE, jamais le nom de fichier ni l'empreinte. */
      bytes: media.size,
      mime: media.mime,
    },
  });

  return entree;
}

/**
 * LIT un document — descripteur ET octets.
 *
 * L'appartenance est vérifiée AVANT la lecture du média : un `mediaId` valide
 * emprunté à une autre fiche ne franchit jamais cette ligne.
 */
export async function readClientDocument(clientCompanyId, documentId) {
  const fiche = await getClientCompanyOrThrow(clientCompanyId);
  const entree = documentOfOrThrow(fiche, documentId);
  const { media, buffer } = await readPrivateMedia(entree.mediaId);
  return { entry: entree, media, buffer };
}

/**
 * RETIRE un document — référence effacée, fichier supprimé.
 *
 * ══ POURQUOI LE FICHIER PART VRAIMENT, ICI ══════════════════════════════════
 *
 * Un justificatif financier SURVIT à la suppression de son mouvement : il fait
 * partie de l'audit comptable, et l'effacer détruirait ce qu'on viendra
 * chercher le jour où un total change.
 *
 * Un document administratif client n'a pas ce statut. C'est une pièce de
 * dossier, remplacée quand elle périme, et son retrait est un geste EXPLICITE
 * d'un opérateur — jamais une cascade. La conserver au repos ferait garder un
 * Kbis que plus personne ne peut consulter : une donnée personnelle d'entreprise
 * détenue sans usage ni lecteur.
 */
export async function detachClientDocument(clientCompanyId, documentId, actor = {}) {
  const fiche = await getClientCompanyOrThrow(clientCompanyId);
  const entree = documentOfOrThrow(fiche, documentId);
  const at = nowIso();

  await PanelClientCompany.updateOne(
    { clientCompanyId },
    {
      $pull: { documents: { documentId } },
      $set: { updatedAt: at, updatedBy: actor.userEmail ?? null },
    },
  );

  await deletePrivateMedia(entree.mediaId, { deletedBy: actor.userEmail ?? null }).catch((err) => {
    /**
     * La référence est déjà retirée : le document n'est plus atteignable par
     * aucune route. Un fichier resté sur le disque est un résidu, pas un
     * incident — on le dit, on ne fait pas échouer le retrait.
     */
    logger.warn(
      `[client-company] média ${entree.mediaId} non retiré du stockage : ${err.message}`,
    );
  });

  await recordEvent({
    projectId: null,
    type: EVENT_TYPES.CLIENT_COMPANY_DOCUMENT_REMOVED,
    source: 'PANEL',
    severity: 'WARNING',
    summary: `Document « ${entree.label} » retiré de l’entreprise cliente « ${fiche.legalName} ».`,
    data: { clientCompanyId, documentId, type: entree.type },
  });

  return { removed: true, documentId };
}

export default {
  CLIENT_DOCUMENT_SCOPE,
  CLIENT_DOCUMENT_ROLE,
  attachClientDocument,
  readClientDocument,
  detachClientDocument,
};
