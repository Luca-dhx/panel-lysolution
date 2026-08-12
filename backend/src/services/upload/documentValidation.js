/**
 * VALIDATION D'UN DOCUMENT REÇU — sur les OCTETS, jamais sur son nom.
 *
 * ══ LE PENDANT DE `mediaValidation.js`, POUR CE QUI NE SE DÉCODE PAS ════════
 *
 * `validateImage` s'appuie sur `sharp` : ce que `sharp` lit est une image, ce
 * qu'il ne lit pas n'en est pas une. C'est un contrôle par DÉCODAGE, et il est
 * excellent — mais il ne sait rien d'un PDF.
 *
 * Ici, le contrôle est un contrôle de SIGNATURE : on lit les premiers octets et
 * on les compare aux nombres magiques du format. C'est volontairement plus
 * modeste qu'un décodage — on ne prétend pas qu'un PDF est bien formé, on
 * prétend qu'il commence par `%PDF-`. Ce que cela ferme est précis et suffisant :
 *
 *   · un exécutable renommé `facture.pdf` ;
 *   · une archive renommée `facture.pdf` ;
 *   · un HTML renommé `facture.pdf`, qui serait le vecteur le plus direct si le
 *     fichier venait un jour à être ouvert dans un onglet.
 *
 * ══ L'EXTENSION N'EST JAMAIS UNE PREUVE, NI MÊME UN INDICE ══════════════════
 *
 * Ni l'extension du fichier déposé, ni le `Content-Type` annoncé par le
 * navigateur n'entrent dans la décision. Les deux sont fournis par le client.
 * L'extension de STOCKAGE est DÉDUITE du type mesuré — jamais reprise du nom.
 */
import ApiError from '../../utils/ApiError.js';
import {
  ACCEPTED_DOCUMENT_TYPES, documentPolicyFor, documentTypeOf, humanBytes,
} from './mediaPolicy.js';

/** Codes rendus à l'appelant — distincts, stables, et réutilisables. */
export const DOCUMENT_ERROR = Object.freeze({
  EMPTY: 'PANEL_DOCUMENT_EMPTY',
  TOO_LARGE: 'PANEL_DOCUMENT_TOO_LARGE',
  TYPE_UNSUPPORTED: 'PANEL_DOCUMENT_TYPE_UNSUPPORTED',
});

/**
 * SIGNATURES — les octets de tête de chaque format accepté.
 *
 * Elles sont énumérées ici plutôt que devinées : une table lisible se relit et
 * se complète, une heuristique se contourne.
 */
const SIGNATURES = [
  // `%PDF-` — la norme l'exige en tête de fichier.
  { mime: 'application/pdf', at: 0, bytes: [0x25, 0x50, 0x44, 0x46, 0x2d] },
  // JPEG : marqueur SOI.
  { mime: 'image/jpeg', at: 0, bytes: [0xff, 0xd8, 0xff] },
  // PNG : signature de huit octets, dont le `\r\n` qui détecte une corruption
  // par transfert texte — on vérifie les huit, pas seulement les quatre.
  { mime: 'image/png', at: 0, bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  // WebP : conteneur RIFF, marque `WEBP` à l'octet 8. Les deux sont exigées :
  // `RIFF` seul désigne aussi un WAV ou un AVI.
  { mime: 'image/webp', at: 0, bytes: [0x52, 0x49, 0x46, 0x46], also: { at: 8, bytes: [0x57, 0x45, 0x42, 0x50] } },
  // HEIC : boîte `ftyp` à l'octet 4, marque de marque à l'octet 8.
  { mime: 'image/heic', at: 4, bytes: [0x66, 0x74, 0x79, 0x70], also: { at: 8, bytes: [0x68, 0x65, 0x69, 0x63] } },
  { mime: 'image/heic', at: 4, bytes: [0x66, 0x74, 0x79, 0x70], also: { at: 8, bytes: [0x6d, 0x69, 0x66, 0x31] } },
];

function correspond(buffer, { at, bytes }) {
  if (buffer.length < at + bytes.length) return false;
  return bytes.every((octet, i) => buffer[at + i] === octet);
}

/** Le type RÉEL d'un buffer, mesuré — ou `null` si aucune signature ne colle. */
export function sniffDocumentMime(buffer) {
  if (!buffer || buffer.length === 0) return null;
  for (const signature of SIGNATURES) {
    if (!correspond(buffer, signature)) continue;
    if (signature.also && !correspond(buffer, signature.also)) continue;
    return signature.mime;
  }
  return null;
}

/**
 * Valide un document contre la politique de son rôle, et rend ce qui a été
 * MESURÉ — jamais ce qui a été déclaré.
 *
 * @param {Buffer} buffer
 * @param {object} [opts]
 * @param {string} [opts.role] rôle documentaire (`receipt`…)
 * @returns {{mime:string, extension:string, label:string, bytes:number, policy:object}}
 */
export function validateDocument(buffer, { role = null } = {}) {
  if (!buffer || buffer.length === 0) {
    throw ApiError.badRequest(DOCUMENT_ERROR.EMPTY, 'Aucun fichier reçu.');
  }

  const policy = documentPolicyFor(role);

  // LA TAILLE D'ABORD : c'est le refus le moins coûteux, et le plus fréquent.
  if (buffer.length > policy.maxInputBytes) {
    throw new ApiError(
      413,
      DOCUMENT_ERROR.TOO_LARGE,
      `Ce document est trop volumineux (${humanBytes(buffer.length)}). `
      + `Maximum : ${humanBytes(policy.maxInputBytes)}.`,
      { maxBytes: policy.maxInputBytes, receivedBytes: buffer.length, role },
    );
  }

  const mime = sniffDocumentMime(buffer);
  const type = mime ? documentTypeOf(mime) : null;
  if (!type) {
    throw new ApiError(
      415,
      DOCUMENT_ERROR.TYPE_UNSUPPORTED,
      'Ce fichier n’est pas d’un type accepté pour un justificatif. '
      + `Acceptés : ${ACCEPTED_DOCUMENT_TYPES.map((t) => t.label).join(', ')}. `
      + 'Le contrôle porte sur le contenu du fichier, pas sur son extension.',
      { accepted: ACCEPTED_DOCUMENT_TYPES.map((t) => t.mime), role },
    );
  }

  return {
    mime: type.mime,
    // L'extension de STOCKAGE vient du type MESURÉ. La reprendre du nom déposé
    // laisserait l'utilisateur choisir une partie du chemin d'écriture.
    extension: type.extension,
    label: type.label,
    bytes: buffer.length,
    policy,
  };
}

/**
 * REMET UN NOM DE FICHIER MULTIPART DANS SON ENCODAGE RÉEL.
 *
 * ══ LE DÉFAUT QUE CETTE FONCTION FERME ══════════════════════════════════════
 *
 * `busboy` — donc `multer` — décode les paramètres d'en-tête multipart en
 * LATIN-1, conformément à la vieille lecture de la RFC 2616. Les navigateurs,
 * eux, envoient ces octets en UTF-8. Conséquence directe, et systématique en
 * français :
 *
 *     déposé   « Facture Août 2026.pdf »
 *     reçu     « Facture AoÃ»t 2026.pdf »
 *
 * Le fichier est parfaitement stocké ; c'est son NOM qui est abîmé, et il le
 * reste pour toujours puisqu'on le conserve tel quel. L'utilisateur retélécharge
 * alors un document au nom illisible, sans comprendre d'où ça vient.
 *
 * ══ POURQUOI LA CONVERSION EST CONDITIONNELLE ═══════════════════════════════
 *
 * Réinterpréter systématiquement casserait le cas inverse : un nom déjà décodé
 * correctement en UTF-8 (client exotique, future version de `busboy`, appel
 * interne) deviendrait du charabia à son tour. On ne convertit donc QUE si le
 * résultat est de l'UTF-8 valide — la présence du caractère de remplacement
 * `U+FFFD` prouve que l'hypothèse était fausse, et l'on garde l'original.
 *
 * Un nom purement ASCII traverse les deux encodages à l'identique : la
 * conversion est alors sans effet, ce qui est exactement ce qu'on veut.
 */
/** Un octet hors ASCII — le seul cas où une réinterprétation a un sens. */
/**
 * Construit depuis une chaîne d'ÉCHAPPEMENTS plutôt qu'écrit littéralement :
 * une classe de caractères contenant de vrais octets hauts est illisible dans
 * un éditeur, et se perd au premier copier-coller mal encodé.
 */
const HORS_ASCII = new RegExp('[\\u0080-\\u00ff]');
/** Le caractère de remplacement : la preuve que l'hypothèse UTF-8 est fausse. */
const REMPLACEMENT = '�';

export function decodeUploadFilename(nom) {
  const brut = String(nom ?? '');
  if (!brut) return brut;
  // Purement ASCII : rien à réparer, et rien à risquer.
  if (!HORS_ASCII.test(brut)) return brut;

  const relu = Buffer.from(brut, 'latin1').toString('utf8');
  return relu.includes(REMPLACEMENT) ? brut : relu;
}

/** Séparateurs de chemin — neutralisés, jamais interprétés. */
const SEPARATEURS = /[\\/]/g;
/**
 * Caractères de contrôle et guillemet double.
 *
 * Ils casseraient l'en-tête `Content-Disposition`, où le nom voyage entre
 * guillemets — et un saut de ligne y permettrait d'injecter un second en-tête.
 * Construit par code point plutôt qu'écrit littéralement : un caractère de
 * contrôle collé dans une source est invisible à la relecture.
 */
const CONTROLES = new RegExp(`[${'\\u0000-\\u001f\\u007f"'}]`, 'g');

/**
 * NETTOIE UN NOM DÉPOSÉ pour l'en-tête `Content-Disposition` — et pour LUI SEUL.
 *
 * Ce nom ne sert JAMAIS à écrire sur le disque : la clé d'objet est calculée
 * depuis l'identifiant et l'empreinte. Il est conservé pour rendre à
 * l'utilisateur un fichier qui porte le nom qu'il lui connaît.
 *
 * On retire tout séparateur de chemin et tout caractère de contrôle : même
 * inoffensif ici, un `../` conservé dans une base finit un jour par être
 * concaténé ailleurs par quelqu'un qui ignorait d'où il venait.
 */
export function safeOriginalFilename(nom, { fallback = 'document' } = {}) {
  const brut = String(nom ?? '').trim();
  if (!brut) return fallback;
  const nettoye = brut
    .replace(SEPARATEURS, '_')
    .replace(CONTROLES, '')
    // Un nom qui commence par des points désigne un fichier caché, ou pire un
    // segment de remontée. Ni l'un ni l'autre n'est un nom de facture.
    .replace(/^\.+/, '')
    .slice(0, 180)
    .trim();
  return nettoye || fallback;
}

export default {
  DOCUMENT_ERROR,
  sniffDocumentMime,
  validateDocument,
  safeOriginalFilename,
};
