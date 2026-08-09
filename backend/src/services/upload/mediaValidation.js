/**
 * VALIDATION D'UNE IMAGE REÇUE — sur les OCTETS, jamais sur ce qu'on nous dit.
 *
 * ══ CE QUE LE FILTRE PRÉCÉDENT NE VÉRIFIAIT PAS ═════════════════════════════
 *
 * Le seul contrôle était `file.mimetype.startsWith('image/')`. Ce champ n'est
 * pas mesuré : il est DÉCLARÉ par le navigateur à partir de l'extension.
 * Renommer un fichier suffisait à le franchir — `sharp` refusait ensuite de le
 * décoder, mais l'échec remontait comme une exception non typée, rendue à
 * l'écran en « Erreur interne ». Le fichier était rejeté par accident plutôt
 * que par décision.
 *
 * On DÉCODE donc l'en-tête. Ce que `sharp` lit est une image ; ce qu'il ne lit
 * pas n'en est pas une, quel que soit son nom.
 *
 * ══ ET LA BOMBE DE DÉCOMPRESSION ════════════════════════════════════════════
 *
 * Une image peut peser 40 Ko et déclarer 60 000 × 60 000 pixels : la décoder
 * réclamerait plusieurs gigaoctets. Le poids ne protège de rien — on borne
 * aussi les DIMENSIONS, avant tout redimensionnement.
 */
import sharp from 'sharp';
import ApiError from '../../utils/ApiError.js';
import { ACCEPTED_IMAGE_FORMATS, humanBytes, policyFor } from './mediaPolicy.js';

/** Au-delà, on refuse sans décoder davantage. Voir le projet modèle. */
export const MAX_PIXELS_PER_SIDE = 12_000;

/** Codes rendus à l'appelant — stables, et distincts les uns des autres. */
export const MEDIA_ERROR = Object.freeze({
  TOO_LARGE: 'PANEL_MEDIA_TOO_LARGE',
  TYPE_UNSUPPORTED: 'PANEL_MEDIA_TYPE_UNSUPPORTED',
  INVALID: 'PANEL_MEDIA_INVALID',
  DIMENSIONS_EXCEEDED: 'PANEL_MEDIA_DIMENSIONS_EXCEEDED',
});

/**
 * Valide un buffer contre la politique de son rôle, et rend les métadonnées
 * mesurées. Lève une `ApiError` TYPÉE : chaque refus a son code, son statut et
 * ses détails. Aucun de ces cas n'est une panne.
 */
export async function validateImage(buffer, { role = null } = {}) {
  const policy = policyFor(role);

  if (!buffer || buffer.length === 0) {
    throw ApiError.badRequest(MEDIA_ERROR.INVALID, 'Aucun fichier reçu.');
  }

  /**
   * LA TAILLE D'ABORD — c'est le refus le moins coûteux, et le plus fréquent.
   * Décoder 40 Mo coûte de la mémoire ; refuser sur la longueur n'en coûte pas.
   */
  if (buffer.length > policy.maxInputBytes) {
    throw new ApiError(
      413,
      MEDIA_ERROR.TOO_LARGE,
      `Cette image est trop volumineuse (${humanBytes(buffer.length)}). `
      + `Maximum pour ce type : ${humanBytes(policy.maxInputBytes)}.`,
      { maxBytes: policy.maxInputBytes, receivedBytes: buffer.length, role },
    );
  }

  let metadata;
  try {
    metadata = await sharp(buffer).metadata();
  } catch {
    metadata = null;
  }

  if (!metadata || !metadata.format) {
    throw ApiError.badRequest(
      MEDIA_ERROR.INVALID,
      'Ce fichier n’est pas une image lisible. Formats acceptés : '
      + `${ACCEPTED_IMAGE_FORMATS.join(', ')}.`,
      { role },
    );
  }

  if (!ACCEPTED_IMAGE_FORMATS.includes(metadata.format)) {
    throw new ApiError(
      415,
      MEDIA_ERROR.TYPE_UNSUPPORTED,
      `Format d’image non pris en charge : ${metadata.format}. `
      + `Formats acceptés : ${ACCEPTED_IMAGE_FORMATS.join(', ')}.`,
      { format: metadata.format, role },
    );
  }

  const largeur = metadata.width ?? 0;
  const hauteur = metadata.height ?? 0;
  if (largeur > MAX_PIXELS_PER_SIDE || hauteur > MAX_PIXELS_PER_SIDE) {
    throw ApiError.badRequest(
      MEDIA_ERROR.DIMENSIONS_EXCEEDED,
      `Cette image est trop grande (${largeur}×${hauteur} pixels). `
      + `Maximum : ${MAX_PIXELS_PER_SIDE} pixels de côté.`,
      { width: largeur, height: hauteur, maxPixelsPerSide: MAX_PIXELS_PER_SIDE, role },
    );
  }

  return {
    format: metadata.format,
    width: largeur,
    height: hauteur,
    bytes: buffer.length,
    policy,
  };
}

export default { validateImage, MEDIA_ERROR, MAX_PIXELS_PER_SIDE };
