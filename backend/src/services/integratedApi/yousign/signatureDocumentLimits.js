// LA TAILLE D'UN DOCUMENT DE SIGNATURE — une limite dite, pas subie (R10.5C).
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
// son PDF, du Panel ou de Yousign, ni quelle taille viser.
//
// Ce module nomme donc la limite, la convertit dans l'unité que l'humain
// manipule (des mégaoctets de PDF, pas des caractères de base64), et produit un
// refus qui dit quoi faire.
//
// ══ POURQUOI CETTE VALEUR ═══════════════════════════════════════════════════
//
// Yousign accepte des documents nettement plus gros. La contrainte n'est donc
// pas la sienne : c'est celle de notre transport, qui charge le contenu en
// mémoire des deux côtés du pont. 12 Mio couvre très largement un contrat signé
// (les nôtres pèsent quelques centaines de kio) tout en gardant l'empreinte
// mémoire d'une invocation prévisible.
//
// Le jour où un document légitime la dépasse, la réponse n'est PAS de monter la
// borne : c'est d'ouvrir le transport binaire dédié, avec sa propre garde
// d'appartenance. La limite est ce qui rendra cette décision visible.

/** Taille maximale du PDF DÉCODÉ. L'unité de l'humain, pas celle du transport. */
export const MAX_DOCUMENT_BYTES = 12 * 1024 * 1024;

/**
 * Taille maximale de la CHAÎNE base64 correspondante.
 *
 * base64 produit 4 caractères pour 3 octets, plus le remplissage. On borne la
 * chaîne AVANT de la décoder : décoder 100 Mio pour découvrir qu'ils sont de
 * trop reviendrait à faire payer l'attaque avant de la refuser.
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
 * @returns {{ok: true, byteLength: number} | {ok: false, code: string, message: string, byteLength: number}}
 */
export function checkDocumentSize(base64) {
  const raw = String(base64 ?? '');

  /**
   * On mesure la chaîne D'ABORD. Un `Buffer.from` sur une entrée démesurée
   * allouerait la mémoire que le refus est censé économiser.
   */
  if (raw.length > MAX_DOCUMENT_BASE64_LENGTH) {
    return {
      ok: false,
      code: DOCUMENT_TOO_LARGE,
      byteLength: Math.floor((raw.length * 3) / 4),
      message: `Document trop volumineux : la limite est de ${toMiB(MAX_DOCUMENT_BYTES)} Mio `
        + 'par document de signature. Allégez le PDF (compression des images) '
        + 'avant de relancer la signature.',
    };
  }

  const byteLength = Buffer.byteLength(raw, 'base64');
  if (byteLength > MAX_DOCUMENT_BYTES) {
    return {
      ok: false,
      code: DOCUMENT_TOO_LARGE,
      byteLength,
      message: `Document trop volumineux : ${toMiB(byteLength)} Mio pour une limite de `
        + `${toMiB(MAX_DOCUMENT_BYTES)} Mio. Allégez le PDF (compression des images) `
        + 'avant de relancer la signature.',
    };
  }

  return { ok: true, byteLength };
}

export default { MAX_DOCUMENT_BYTES, MAX_DOCUMENT_BASE64_LENGTH, DOCUMENT_TOO_LARGE, checkDocumentSize };
