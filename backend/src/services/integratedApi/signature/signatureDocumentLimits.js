// LA TAILLE D'UN DOCUMENT DE SIGNATURE — une limite dite, pas subie.
//
// ══ POURQUOI UNE LIMITE EXPLICITE, ET PAS UN `max()` DANS UN SCHÉMA ═════════
//
// Le transit du PDF passe en base64 sur la passerelle JSON — un choix assumé :
// une seconde porte binaire aurait créé un second chemin d'exécution, donc un
// second endroit où l'appartenance pourrait être oubliée. Le prix est +33 % de
// volume, et ce prix doit être BORNÉ quelque part.
//
// Le borner par un `z.string().max(N)` anonyme aurait « marché » et mal
// échoué : l'exploitant aurait lu « String must contain at most 20000000
// character(s) » pour un contrat de 16 Mo, sans savoir si la faute venait de
// son PDF, du Panel ou du fournisseur, ni quelle taille viser.
//
// Ce module nomme donc la limite, la convertit dans l'unité que l'humain
// manipule (des mégaoctets de PDF, pas des caractères de base64), et produit un
// refus qui dit quoi faire.
//
// ══ DEUX LIMITES, ET LA PLUS BASSE GAGNE ════════════════════════════════════
//
// Il y en a deux, de natures différentes, et les confondre produirait un
// message faux :
//
//   LA NÔTRE       celle du TRANSPORT. Le contenu est chargé en mémoire des
//                  deux côtés du pont ; 12 Mio couvre très largement un contrat
//                  (les nôtres pèsent quelques centaines de kio) tout en gardant
//                  l'empreinte d'une invocation prévisible.
//
//   CELLE DU       ce que le fournisseur RETENU accepte. Mesurée, pas supposée :
//   FOURNISSEUR    OpenSign refuse au-delà de 10 Mo, avec le message
//                  « File too large. Max allowed file size is 10 MB ».
//
// ══ LE DÉFAUT QUE CETTE SECONDE LIMITE FERME ════════════════════════════════
//
// Sans elle, le Panel acceptait un document de 11 Mo, RÉSERVAIT le contrat,
// débitait un crédit chez le fournisseur, et n'apprenait le refus qu'après.
// L'exploitant lisait alors un message parlant du fournisseur, pour un problème
// qui était le sien : son PDF est trop lourd. Refuser en amont rend le refus
// gratuit et le message actionnable.
//
// Le jour où un document légitime dépasse NOTRE limite, la réponse n'est PAS de
// la monter : c'est d'ouvrir le transport binaire dédié, avec sa propre garde
// d'appartenance. La limite est ce qui rendra cette décision visible.

/** Taille maximale imposée par NOTRE transport. L'unité de l'humain. */
export const MAX_DOCUMENT_BYTES = 12 * 1024 * 1024;

/**
 * Ce que chaque fournisseur accepte réellement, en octets du fichier DÉCODÉ.
 *
 * `null` = aucune limite connue plus basse que la nôtre. Ce n'est pas « pas de
 * limite » : c'est « le fournisseur n'en documente pas, et nous n'en avons pas
 * mesuré ». La différence compte le jour où l'un des deux change.
 */
export const PROVIDER_MAX_DOCUMENT_BYTES = Object.freeze({
  /** Mesuré en bac à sable : 9,4 Mo accepté, 12 Mo refusé, message explicite. */
  OPENSIGN: 10 * 1024 * 1024,
  /** Yousign accepte nettement plus : c'est notre transport qui borne. */
  YOUSIGN: null,
});

/** La limite EFFECTIVE pour un fournisseur donné — la plus basse des deux. */
export function maxDocumentBytesFor(provider = null) {
  const duFournisseur = PROVIDER_MAX_DOCUMENT_BYTES[String(provider ?? '').toUpperCase()] ?? null;
  return duFournisseur === null ? MAX_DOCUMENT_BYTES : Math.min(MAX_DOCUMENT_BYTES, duFournisseur);
}

/**
 * Taille maximale de la CHAÎNE base64 correspondante.
 *
 * base64 produit 4 caractères pour 3 octets, plus le remplissage. On borne la
 * chaîne AVANT de la décoder : décoder 100 Mio pour découvrir qu'ils sont de
 * trop reviendrait à faire payer l'attaque avant de la refuser.
 *
 * ── POURQUOI CETTE BORNE-CI RESTE LA NÔTRE, ET NON CELLE DU FOURNISSEUR ────
 *
 * Elle protège la MÉMOIRE du Panel, et le schéma d'entrée l'applique avant même
 * de savoir quel fournisseur servira l'appel. La borne du fournisseur, elle,
 * s'applique une fois l'exécutant connu — c'est-à-dire dans l'adaptateur.
 */
export const MAX_DOCUMENT_BASE64_LENGTH = Math.ceil(MAX_DOCUMENT_BYTES / 3) * 4 + 4;

/** Code de refus — STABLE, et distinct d'une entrée simplement malformée. */
export const DOCUMENT_TOO_LARGE = 'SIGNATURE_DOCUMENT_TOO_LARGE';

/** Mégaoctets lisibles, pour un message d'exploitation. */
function toMiB(bytes) {
  return Math.round((bytes / (1024 * 1024)) * 10) / 10;
}

/**
 * Le PDF décodé tient-il dans la limite ?
 *
 * Rend un verdict plutôt que de lever : l'appelant sait, lui, s'il doit
 * traduire cela en refus de schéma ou en erreur de capacité.
 *
 * @param {string} base64
 * @param {{provider?: string|null}} [options] le fournisseur qui servira l'acte.
 *   Absent, seule la limite de transport s'applique — c'est le cas du schéma
 *   d'entrée, qui s'exécute avant que l'exécutant soit résolu.
 * @returns {{ok: true, byteLength: number} | {ok: false, code: string, message: string, byteLength: number}}
 */
export function checkDocumentSize(base64, { provider = null } = {}) {
  const raw = String(base64 ?? '');
  const limite = maxDocumentBytesFor(provider);
  const limiteBase64 = Math.ceil(limite / 3) * 4 + 4;

  /**
   * On mesure la chaîne D'ABORD. Un `Buffer.from` sur une entrée démesurée
   * allouerait la mémoire que le refus est censé économiser.
   */
  if (raw.length > limiteBase64) {
    return {
      ok: false,
      code: DOCUMENT_TOO_LARGE,
      byteLength: Math.floor((raw.length * 3) / 4),
      message: `Document trop volumineux : la limite est de ${toMiB(limite)} Mio `
        + 'par document de signature. Allégez le PDF (compression des images) '
        + 'avant de relancer la signature.',
    };
  }

  const byteLength = Buffer.byteLength(raw, 'base64');
  if (byteLength > limite) {
    return {
      ok: false,
      code: DOCUMENT_TOO_LARGE,
      byteLength,
      message: `Document trop volumineux : ${toMiB(byteLength)} Mio pour une limite de `
        + `${toMiB(limite)} Mio. Allégez le PDF (compression des images) `
        + 'avant de relancer la signature.',
    };
  }

  return { ok: true, byteLength };
}

export default {
  MAX_DOCUMENT_BYTES,
  MAX_DOCUMENT_BASE64_LENGTH,
  PROVIDER_MAX_DOCUMENT_BYTES,
  maxDocumentBytesFor,
  DOCUMENT_TOO_LARGE,
  checkDocumentSize,
};
