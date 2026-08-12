/**
 * MÉDIAS PRIVÉS — le même protocole que les médias publics, un autre dossier.
 *
 * ══ CE QUE CE MODULE EST, ET SURTOUT CE QU'IL N'EST PAS ═════════════════════
 *
 * Ce n'est PAS un service de fichiers pour les finances. C'est l'extension
 * PRIVÉE du protocole Media du Panel — celui qui produit déjà les descripteurs
 * `PanelMedia`, calcule les clés d'objet par empreinte et sait à quel monde
 * (TEST/PROD) un fichier appartient.
 *
 * Tout ce qui distingue un média privé d'un média public tient en trois
 * points :
 *
 *   1. IL N'EST PAS RÉENCODÉ. Un logo est décodé, pivoté, redimensionné et
 *      converti en WebP. Une facture est stockée OCTET POUR OCTET : réencoder
 *      un justificatif produirait un document qui n'est plus celui que le
 *      fournisseur a émis, avec une empreinte qui ne prouve plus rien.
 *
 *   2. IL VIT AILLEURS. `storage/media/`, jamais `uploads/`. Aucun bloc
 *      `location` d'Nginx, aucun `express.static` ne dessert ce dossier.
 *
 *   3. IL N'EST JAMAIS PUBLIÉ. Le transfert vers `shared/uploads` d'une
 *      destination l'ignore explicitement — voir
 *      `publishPanelMediaOnDestination`.
 *
 * Tout le reste — identité, empreinte, environnement, descripteur, cycle de
 * vie — est rigoureusement celui des autres médias, et vient des mêmes
 * fonctions.
 *
 * ══ CE MODULE NE DÉCIDE D'AUCUNE AUTORISATION ═══════════════════════════════
 *
 * Il sait ouvrir et lire un fichier privé ; il ne sait pas QUI a le droit de le
 * lire. Cette question n'a pas de réponse générique : elle dépend de l'objet
 * métier auquel le média est rattaché — un justificatif suit les droits de sa
 * transaction, un contrat suivrait ceux de son projet.
 *
 * Le domaine propriétaire porte donc la route et l'autorisation ; ce module
 * porte les octets et le descripteur. C'est cette frontière qui permettra aux
 * factures et aux contrats de réutiliser le mécanisme sans hériter des règles
 * d'accès des finances.
 *
 * ══ LOCALHOST ET DÉPLOYÉ : UN SEUL CHEMIN ═══════════════════════════════════
 *
 * `config.paths.privateMedia` vaut `<backend>/storage/media` dans les deux cas.
 * Sur une instance déployée, `<backend>/storage` est un LIEN SYMBOLIQUE vers
 * `shared/storage`, posé à chaque release par le pipeline — le fichier survit
 * donc au redéploiement sans qu'une seule ligne d'ici ne distingue les deux
 * mondes. Aucun `if (localhost)` n'existe dans ce module, et il ne doit jamais
 * en apparaître : c'est la couche Media qui absorbe la différence.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import ApiError from '../../utils/ApiError.js';
import { config } from '../../config/env.js';
import PanelMedia from '../../models/PanelMedia.model.js';
import { nowIso } from '../../bridge/bridgeContract.js';
import { objectKeyFor, sha256Of } from './mediaDescriptor.service.js';
import {
  decodeUploadFilename, safeOriginalFilename, validateDocument,
} from './documentValidation.js';

/** Le dossier des médias privés — créé à la demande, jamais supposé présent. */
export function privateMediaDir() {
  return config.paths?.privateMedia || path.resolve(process.cwd(), 'storage', 'media');
}

/** La visibilité d'un média privé — une constante, jamais une chaîne recopiée. */
export const PRIVATE = 'PRIVATE';

/**
 * ENREGISTRE UN DOCUMENT PRIVÉ et rend son descripteur.
 *
 * Le fichier est validé sur ses OCTETS, empreinté, écrit sous une clé calculée,
 * puis décrit dans `PanelMedia` comme n'importe quel autre média du Panel.
 *
 * ══ POURQUOI L'ÉCRITURE PRÉCÈDE LE DESCRIPTEUR ══════════════════════════════
 *
 * Un descripteur sans fichier est un mensonge que rien ne rattrape : l'écran
 * proposerait un téléchargement qui échouerait toujours. Un fichier sans
 * descripteur, au contraire, est un simple orphelin — invisible, inoffensif, et
 * ramassable. On accepte donc le second risque, jamais le premier.
 *
 * ══ DÉDUPLICATION : NON, ET C'EST DÉLIBÉRÉ ══════════════════════════════════
 *
 * Les médias publics dédupliquent par empreinte : deux imports du même logo
 * rendent le même objet. Pour un justificatif, ce serait une faute — deux
 * occurrences distinctes qui recevraient la même facture partageraient un
 * objet, et retirer la pièce de l'une la retirerait de l'autre. Chaque
 * justificatif est un objet à lui, même si son contenu est identique.
 *
 * @param {object} args
 * @param {Buffer} args.buffer
 * @param {string} args.scope      la famille métier (`FINANCIAL_RECEIPT`…)
 * @param {string} [args.role]     le rôle documentaire, pour la politique
 * @param {string} [args.filename] le nom déposé — pour le rendre, jamais pour écrire
 * @param {string} [args.createdBy]
 * @returns {Promise<object>} le descripteur `PanelMedia`
 */
export async function storePrivateDocument({
  buffer, scope, role = null, filename = null, createdBy = null,
}) {
  if (!scope) throw new TypeError('Un média privé exige une portée métier.');

  const mesure = validateDocument(buffer, { role });
  const empreinte = sha256Of(buffer);
  const mediaId = randomUUID();
  const objectKey = objectKeyFor({ mediaId, sha256: empreinte, extension: mesure.extension });

  const dossier = privateMediaDir();
  await fs.mkdir(dossier, { recursive: true });
  const destination = path.join(dossier, objectKey);

  /**
   * CEINTURE ET BRETELLES — le chemin résolu doit rester DANS le dossier.
   *
   * La clé d'objet est calculée, donc sûre par construction. Ce contrôle ne
   * protège pas d'elle : il protège du jour où quelqu'un modifiera
   * `objectKeyFor` sans penser à ce module.
   */
  if (path.dirname(path.resolve(destination)) !== path.resolve(dossier)) {
    throw ApiError.badRequest(
      'PANEL_MEDIA_PATH_ESCAPE',
      'Chemin de média hors du dossier autorisé.',
    );
  }

  await fs.writeFile(destination, buffer);

  const at = nowIso();
  const doc = await PanelMedia.create({
    mediaId,
    environment: config.env,
    /**
     * `publicationState` reste LOCAL_ONLY, et pour toujours.
     *
     * « Publié » signifie « constaté servi par une destination ». Un média
     * privé n'est servi par aucune destination — le promouvoir un jour
     * affirmerait une exposition publique qui n'existe pas.
     */
    publicationState: 'LOCAL_ONLY',
    visibility: PRIVATE,
    objectKey,
    /**
     * `path` NE PORTE PAS `/uploads` — c'est tout l'enjeu.
     *
     * Le champ décrit où le média vit, et un média privé ne vit pas dans
     * l'espace servi. Écrire ici un chemin en `/uploads/…` ferait croire à
     * `resolvePanelMediaUrl` qu'il peut en dériver une adresse publique.
     */
    path: `storage/media/${objectKey}`,
    mime: mesure.mime,
    size: mesure.bytes,
    width: null,
    height: null,
    sha256: empreinte,
    version: 1,
    scope,
    role,
    /**
     * Le nom est d'abord REMIS DANS SON ENCODAGE, puis nettoyé.
     *
     * L'ordre compte : nettoyer d'abord retirerait les octets hauts d'un nom
     * accentué avant qu'on ait pu le relire, et « Août » deviendrait « Aot ».
     */
    originalFilename: safeOriginalFilename(
      decodeUploadFilename(filename),
      { fallback: `justificatif.${mesure.extension}` },
    ),
    createdAt: at,
    updatedAt: at,
    createdBy,
  });

  return doc.toObject();
}

/**
 * LIT UN MÉDIA PRIVÉ — descripteur ET octets.
 *
 * Refuse tout ce qui n'est pas exactement un média privé vivant : un média
 * public passé ici serait servi hors de son cadre, et un média supprimé n'a
 * plus de fichier. Les deux refus sont distincts, parce qu'ils ne se
 * diagnostiquent pas pareil.
 *
 * L'AUTORISATION N'EST PAS ICI — voir l'en-tête de ce fichier.
 */
export async function readPrivateMedia(mediaId) {
  const media = await PanelMedia.findOne({ mediaId }).lean();
  if (!media) {
    throw ApiError.notFound('PANEL_MEDIA_NOT_FOUND', 'Document introuvable.');
  }
  if (media.visibility !== PRIVATE) {
    throw ApiError.conflict(
      'PANEL_MEDIA_NOT_PRIVATE',
      'Ce média n’est pas un document privé : il ne se lit pas par cette voie.',
    );
  }
  if (media.deletedAt) {
    throw ApiError.notFound('PANEL_MEDIA_GONE', 'Ce document a été supprimé.');
  }

  const chemin = path.join(privateMediaDir(), media.objectKey);
  let buffer;
  try {
    buffer = await fs.readFile(chemin);
  } catch {
    /**
     * LE DESCRIPTEUR EXISTE, LE FICHIER NON.
     *
     * On ne rend pas 404 « document introuvable » : ce serait dire que rien n'a
     * jamais été déposé, alors que le registre en garde la trace. C'est un
     * incident de stockage, et le nommer ainsi est la seule façon qu'il soit
     * cherché au bon endroit.
     */
    throw new ApiError(
      503,
      'PANEL_MEDIA_FILE_MISSING',
      'Le document est référencé mais son fichier est introuvable sur ce serveur. '
      + 'Vérifiez le stockage persistant de cette instance.',
    );
  }

  return { media, buffer };
}

/**
 * RETIRE un média privé — descripteur marqué, fichier effacé.
 *
 * ══ POURQUOI CE N'EST PAS APPELÉ PAR LA SUPPRESSION D'UNE TRANSACTION ═══════
 *
 * Une transaction financière supprimée reste auditable, et son justificatif
 * fait partie de l'audit. Effacer la pièce en même temps que la ligne
 * détruirait précisément ce qu'on cherchera le jour où l'on demandera pourquoi
 * un total a changé.
 *
 * Cette fonction n'est donc appelée que par un geste EXPLICITE de retrait du
 * justificatif — jamais par un nettoyage en cascade.
 */
export async function deletePrivateMedia(mediaId, { deletedBy = null } = {}) {
  const media = await PanelMedia.findOne({ mediaId }).lean();
  if (!media) return { deleted: false, alreadyGone: true };
  if (media.visibility !== PRIVATE) {
    throw ApiError.conflict(
      'PANEL_MEDIA_NOT_PRIVATE',
      'Ce média n’est pas un document privé.',
    );
  }

  const at = nowIso();
  await PanelMedia.updateOne(
    { mediaId },
    { $set: { deletedAt: at, updatedAt: at, createdBy: media.createdBy ?? deletedBy } },
  );

  try {
    await fs.unlink(path.join(privateMediaDir(), media.objectKey));
  } catch {
    // Déjà parti : le résultat voulu est atteint. Un double clic, deux onglets
    // ou une reprise après coupure ne sont pas des erreurs.
  }
  return { deleted: true, alreadyGone: false, mediaId };
}

/**
 * LE DESCRIPTEUR TEL QU'IL PART VERS UN ÉCRAN — sans aucune adresse.
 *
 * Un média privé n'a pas d'URL : il n'est joignable que par la route
 * authentifiée du domaine qui le possède. En publier une, même relative,
 * inviterait un écran à la mettre dans un `<a href>` — et ce lien-là finirait
 * par être copié hors de toute session.
 */
export function privateDescriptorOf(media) {
  if (!media?.mediaId) return null;
  return {
    mediaId: media.mediaId,
    filename: media.originalFilename ?? null,
    mime: media.mime,
    size: media.size,
    sha256: media.sha256,
    uploadedAt: media.createdAt ?? null,
    uploadedBy: media.createdBy ?? null,
  };
}

export default {
  PRIVATE,
  privateMediaDir,
  storePrivateDocument,
  readPrivateMedia,
  deletePrivateMedia,
  privateDescriptorOf,
};
