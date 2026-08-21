/**
 * TÉLÉCHARGER UN DOCUMENT DU FOURNISSEUR — le transport, et rien d'autre.
 *
 * ══ POURQUOI CE FICHIER EXISTE, PLUTÔT QU'UN `fetch` DANS LE SERVICE ════════
 *
 * Parce que la règle du dépôt est explicite : **la décision vit ailleurs, le
 * transport vit ici**. Un `fetch` posé dans `invoiceArchival.service.js` faisait
 * de ce module à la fois celui qui décide d'archiver ET celui qui ouvre une
 * socket — et la garde d'architecture l'a refusé, à juste titre.
 *
 * Ce module ne sait donc RIEN de la finance : ni ce qu'est une facture, ni
 * quand on l'archive, ni où on la range. Il reçoit une adresse, il rend des
 * octets, et il échoue proprement.
 *
 * ══ CE N'EST PAS UN APPEL D'API ═════════════════════════════════════════════
 *
 * `invoice_pdf` est une adresse SIGNÉE que le fournisseur sert sans clé. Aucune
 * lecture de coffre, aucun crédit d'API consommé, aucune question posée sur
 * l'appartenance de quoi que ce soit — celle-ci a été prouvée bien avant, par
 * le registre de liens. C'est un GET sur un document dont un événement signé
 * nous a donné l'adresse, et c'est pourquoi ce transport ne prend pas de
 * `credentials` : lui en donner laisserait croire qu'il en a besoin.
 *
 * ══ POURQUOI `fetchImpl` EST INJECTABLE ═════════════════════════════════════
 *
 * Même raison que pour les autres transports du dépôt : une recette ne doit
 * jamais sortir sur le réseau, et un test qui simulerait le fournisseur en
 * remplaçant `globalThis.fetch` contaminerait tout ce qui tourne à côté.
 */
import ApiError from '../../../utils/ApiError.js';

/**
 * Combien de temps on laisse le fournisseur servir son document.
 *
 * Court volontairement : ce téléchargement se produit sur le chemin d'un
 * webhook, et un webhook qui n'acquitte pas fait rejouer le fournisseur en
 * boucle. Ce qui n'aboutit pas ici sera repris par le rattrapage, qui n'a
 * aucune contrainte de temps.
 */
export const DEFAULT_DOCUMENT_TIMEOUT_MS = 15_000;

/**
 * Au-delà, on refuse AVANT de lire le corps.
 *
 * Le protocole Media plafonne déjà un justificatif à 10 Mo, et refuserait donc
 * ce qui dépasse — mais après l'avoir entièrement téléchargé et gardé en
 * mémoire. Lire l'annonce de taille coûte zéro octet et ferme le cas le plus
 * cher : une adresse qui, par erreur ou par malveillance, servirait un flux
 * sans fin.
 */
export const MAX_DOCUMENT_BYTES = 16 * 1024 * 1024;

/** Codes STABLES. L'appelant s'appuie sur eux, jamais sur le texte. */
export const DOCUMENT_TRANSPORT_CODES = Object.freeze({
  UNSUPPORTED_URL: 'PANEL_PROVIDER_DOCUMENT_URL_UNSUPPORTED',
  HTTP_ERROR: 'PANEL_PROVIDER_DOCUMENT_HTTP_ERROR',
  TOO_LARGE: 'PANEL_PROVIDER_DOCUMENT_TOO_LARGE',
  EMPTY: 'PANEL_PROVIDER_DOCUMENT_EMPTY',
  UNREACHABLE: 'PANEL_PROVIDER_DOCUMENT_UNREACHABLE',
});

/**
 * SEUL `https` EST ACCEPTÉ, et l'adresse doit être absolue.
 *
 * Une adresse relative se résoudrait sur nous-mêmes ; `file:` lirait le disque
 * du serveur. Les deux se produisent le jour où une charge utile mal formée ou
 * hostile traverse le normalisateur, et aucune ne doit pouvoir être suivie.
 */
function adresseAcceptable(url) {
  try {
    return new URL(String(url)).protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * TÉLÉCHARGE un document et rend ses octets.
 *
 * Ne fait AUCUNE confiance à `Content-Type` : le fournisseur sert ses PDF en
 * `application/octet-stream`, et de toute façon un type déclaré ne prouve rien.
 * C'est la validation sur les OCTETS, en aval, qui tranche.
 *
 * @param {object} args
 * @param {string} args.url        adresse absolue, en https
 * @param {number} [args.timeoutMs]
 * @param {Function} [args.fetchImpl]
 * @returns {Promise<{bytes: Buffer, contentType: string|null}>}
 */
export async function downloadProviderDocument({
  url, timeoutMs = DEFAULT_DOCUMENT_TIMEOUT_MS, fetchImpl,
} = {}) {
  if (!adresseAcceptable(url)) {
    throw ApiError.badRequest(
      DOCUMENT_TRANSPORT_CODES.UNSUPPORTED_URL,
      'Adresse de document non exploitable : seule une adresse https absolue est suivie.',
    );
  }

  let reponse;
  try {
    reponse = await (fetchImpl ?? globalThis.fetch)(url, {
      redirect: 'follow',
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    throw new ApiError(
      502,
      DOCUMENT_TRANSPORT_CODES.UNREACHABLE,
      `Le fournisseur n’a pas servi le document (${err?.name === 'TimeoutError' ? 'délai dépassé' : 'injoignable'}).`,
    );
  }

  if (!reponse.ok) {
    throw new ApiError(
      502,
      DOCUMENT_TRANSPORT_CODES.HTTP_ERROR,
      `le fournisseur a répondu ${reponse.status}`,
      { httpStatus: reponse.status },
    );
  }

  const annonce = Number(reponse.headers?.get?.('content-length') ?? NaN);
  if (Number.isFinite(annonce) && annonce > MAX_DOCUMENT_BYTES) {
    throw new ApiError(
      413,
      DOCUMENT_TRANSPORT_CODES.TOO_LARGE,
      `Document annoncé à ${annonce} octets — au-delà de ce qu’un justificatif peut peser.`,
    );
  }

  const bytes = Buffer.from(await reponse.arrayBuffer());
  if (bytes.length === 0) {
    throw new ApiError(502, DOCUMENT_TRANSPORT_CODES.EMPTY, 'document vide');
  }
  if (bytes.length > MAX_DOCUMENT_BYTES) {
    throw new ApiError(
      413,
      DOCUMENT_TRANSPORT_CODES.TOO_LARGE,
      `Document de ${bytes.length} octets — au-delà de ce qu’un justificatif peut peser.`,
    );
  }

  return { bytes, contentType: reponse.headers?.get?.('content-type') ?? null };
}

export default {
  DEFAULT_DOCUMENT_TIMEOUT_MS,
  MAX_DOCUMENT_BYTES,
  DOCUMENT_TRANSPORT_CODES,
  downloadProviderDocument,
};
