// TRANSPORT YOUSIGN — le seul endroit du Panel qui parle à Yousign (R10.5C).
//
// docs/R10_5_FINAL_EMAIL_AND_YOUSIGN_CONTROL_PLANE_REPORT.md.
//
// ══ CE QUE CE MODULE PORTE, ET CE QU'IL NE DÉCIDE PAS ═══════════════════════
//
// Il porte : les délais bornés, les erreurs TYPÉES, la distinction entre « il a
// dit non » et « il n'a rien dit », et le multipart binaire que Yousign exige.
//
// Il ne décide RIEN : ni l'appartenance d'une ressource, ni le droit d'agir, ni
// l'idempotence. Ces trois-là appartiennent à la passerelle et aux modules
// d'ownership — les mélanger au transport rendrait impossible de prouver
// qu'aucun appel n'est parti avant leur verdict.
//
// ══ POURQUOI PAS DE RÉESSAI AUTOMATIQUE SUR ÉCRITURE ════════════════════════
//
// Hostinger réessaie ses LECTURES, et c'est sans risque. Ici, la moindre
// écriture engage juridiquement un tiers : créer deux fois une demande de
// signature, c'est solliciter deux fois une personne réelle. Un réessai
// automatique sur une réponse perdue produirait exactement ce doublon.
//
// Le registre d'opérations du Panel est la seule reprise autorisée, et il exige
// une décision humaine ou une convergence explicite — jamais un `catch` qui
// rejoue.
//
// ══ LE REBRANDING ═══════════════════════════════════════════════════════════
//
// Yousign est devenu Youtrust en juillet 2026. L'hôte d'API vit dans le coffre
// (`baseUrl`), éditable, et n'est JAMAIS codé en dur ici : c'est ce qui permet
// de suivre un changement d'hôte sans redéployer.

/** Délai par défaut. Généreux : un upload de PDF n'est pas une lecture. */
export const DEFAULT_TIMEOUT_MS = 30_000;

/** Issue d'une tentative. La troisième est la raison d'être du module. */
export const OUTCOMES = Object.freeze({
  DONE: 'DONE',
  FAILED: 'FAILED',
  /** Le fournisseur n'a rien dit. L'acte a PEUT-ÊTRE eu lieu. */
  UNKNOWN: 'UNKNOWN',
});

/** Codes de transport — STABLES. L'adaptateur les traduit en codes métier. */
export const TRANSPORT_CODES = Object.freeze({
  OK: 'OK',
  MISSING_CREDENTIALS: 'MISSING_CREDENTIALS',
  INPUT_INVALID: 'INPUT_INVALID',
  UNAUTHORIZED: 'UNAUTHORIZED',
  NOT_FOUND: 'NOT_FOUND',
  REJECTED: 'REJECTED',
  RATE_LIMITED: 'RATE_LIMITED',
  PROVIDER_ERROR: 'PROVIDER_ERROR',
  MALFORMED_RESPONSE: 'MALFORMED_RESPONSE',
  TIMEOUT: 'TIMEOUT',
  UNREACHABLE: 'UNREACHABLE',
});

export class YousignTransportError extends Error {
  constructor(code, message, {
    httpStatus = null, requestId = null, retryable = false,
    outcome = OUTCOMES.FAILED, invalidParams = [],
  } = {}) {
    super(message);
    this.name = 'YousignTransportError';
    this.code = code;
    this.httpStatus = httpStatus;
    /** L'identifiant de requête de Yousign — non secret, et seul repère du support. */
    this.requestId = requestId;
    this.retryable = retryable;
    this.outcome = outcome;
    /**
     * Les champs refusés, NOMMÉS sans leurs valeurs. Yousign répond
     * `invalid_params` en nommant le champ fautif ; c'est l'information qui
     * fait gagner une heure, et elle ne porte aucune donnée personnelle.
     */
    this.invalidParams = invalidParams;
  }

  /** Rejouer cette erreur peut-il produire un doublon ? */
  get replaySafe() {
    return this.outcome === OUTCOMES.FAILED;
  }
}

/**
 * NATURE DU DOCUMENT — énumération OFFICIELLE de l'API v3.
 *
 * ⚠️ Ne jamais remplacer `signable_document` par `signable` : la sandbox répond
 * alors `400 parameters_not_valid`. C'est l'incident du 2026-07-16, conservé
 * ici parce que le code du projet l'avait appris à ses dépens.
 */
export const DOCUMENT_NATURE = Object.freeze({
  SIGNABLE: 'signable_document',
  ATTACHMENT: 'attachment',
});

const stripSlash = (url) => String(url || '').replace(/\/+$/, '');

/** Message fournisseur tronqué. Jamais l'en-tête d'autorisation. */
function safeMessage(message) {
  if (typeof message !== 'string') return '';
  const clean = message.trim();
  if (!clean) return '';
  return clean.length > 300 ? `${clean.slice(0, 300)}…` : clean;
}

/**
 * Nom de fichier accepté par Yousign : pas de séparateur de chemin, pas
 * d'espace en bordure, extension `.pdf`.
 *
 * C'est une ceinture, pas une bretelle — le stockage produit déjà des noms
 * UUID sûrs. Elle existe pour qu'un nom hérité ou exotique ne fasse pas échouer
 * un upload par un refus incompréhensible.
 */
export function toSafePdfFilename(filename) {
  const base = String(filename || '').split(/[/\\]/).pop().trim();
  const cleaned = base
    .replace(/\.pdf$/i, '')
    .replace(/[^0-9A-Za-zÀ-ÿ' ()-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-\s]+|[-\s]+$/g, '');
  return `${cleaned || 'contrat'}.pdf`;
}

/**
 * Construit le multipart d'upload — fonction PURE, donc inspectable en test
 * sans réseau ni credential. C'est le payload exact envoyé à Yousign.
 */
export function buildDocumentUploadForm({ buffer, filename, parseAnchors = false }) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw new YousignTransportError(
      TRANSPORT_CODES.INPUT_INVALID,
      'Contenu PDF binaire requis (buffer vide).',
    );
  }
  const form = new FormData();
  // Blob = binaire pur. Yousign REFUSE explicitement le base64.
  form.append('file', new Blob([buffer], { type: 'application/pdf' }), toSafePdfFilename(filename));
  form.append('nature', DOCUMENT_NATURE.SIGNABLE);
  // Omis par défaut : le placement se fait par coordonnées, un scan d'ancres
  // serait un travail inutile chez le fournisseur.
  if (parseAnchors) form.append('parse_anchors', 'true');
  return form;
}

/**
 * Classe une réponse HTTP en code de transport.
 *
 * ── LA LIGNE QUI COMPTE ─────────────────────────────────────────────────────
 *
 * `TIMEOUT` et `UNREACHABLE` sortent en `UNKNOWN`, jamais en `FAILED`. Sur une
 * écriture, `FAILED` affirme que rien n'a eu lieu — et c'est cette affirmation
 * qui pousse à rejouer, donc à doubler une sollicitation juridique.
 */
function classify(status) {
  if (status === 401 || status === 403) return TRANSPORT_CODES.UNAUTHORIZED;
  if (status === 404) return TRANSPORT_CODES.NOT_FOUND;
  if (status === 409 || status === 422 || status === 400) return TRANSPORT_CODES.INPUT_INVALID;
  if (status === 429) return TRANSPORT_CODES.RATE_LIMITED;
  if (status >= 500) return TRANSPORT_CODES.PROVIDER_ERROR;
  return TRANSPORT_CODES.REJECTED;
}

/** Extrait les champs refusés SANS leurs valeurs. */
function extractInvalidParams(body) {
  const params = Array.isArray(body?.invalid_params) ? body.invalid_params : [];
  return params
    .map((p) => ({ field: String(p?.name ?? p?.field ?? ''), reason: String(p?.reason ?? '') }))
    .filter((p) => p.field);
}

/**
 * UN appel Yousign. Rend le corps analysé, ou lève une `YousignTransportError`.
 *
 * @param {object} args
 * @param {{apiKey: string, baseUrl: string}} args.credentials — consommés, jamais rendus
 * @param {'GET'|'POST'|'DELETE'} [args.method]
 * @param {string} args.path
 * @param {object} [args.json]
 * @param {FormData} [args.form]
 * @param {boolean} [args.binary] — rend un Buffer (document signé)
 */
export async function yousignFetch({
  credentials, method = 'GET', path, json, form, binary = false,
  timeoutMs = DEFAULT_TIMEOUT_MS, fetchImpl,
}) {
  const apiKey = credentials?.apiKey;
  const baseUrl = stripSlash(credentials?.baseUrl);
  if (!apiKey || !baseUrl) {
    throw new YousignTransportError(
      TRANSPORT_CODES.MISSING_CREDENTIALS,
      'Identifiants Yousign incomplets (clé ou hôte absent).',
    );
  }

  const doFetch = fetchImpl ?? globalThis.fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let response;
  try {
    const headers = { Authorization: `Bearer ${apiKey}` };
    let body;
    if (json !== undefined) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(json);
    } else if (form !== undefined) {
      // FormData : NE JAMAIS poser Content-Type à la main — `fetch` doit
      // générer la boundary. Un multipart sans boundary casse le parsing.
      body = form;
    }
    response = await doFetch(`${baseUrl}${path}`, { method, headers, body, signal: controller.signal });
  } catch (error) {
    const aborted = error?.name === 'AbortError';
    throw new YousignTransportError(
      aborted ? TRANSPORT_CODES.TIMEOUT : TRANSPORT_CODES.UNREACHABLE,
      aborted
        ? `Yousign n’a pas répondu en ${timeoutMs} ms : l’issue est indéterminée.`
        : 'Yousign est injoignable : l’issue est indéterminée.',
      // INDÉTERMINÉ dans les deux cas : la requête a pu partir et aboutir.
      { outcome: OUTCOMES.UNKNOWN, retryable: false },
    );
  } finally {
    clearTimeout(timer);
  }

  const requestId = response.headers?.get?.('x-request-id') ?? null;

  if (binary) {
    if (!response.ok) {
      throw new YousignTransportError(
        classify(response.status),
        `Yousign a refusé le téléchargement (HTTP ${response.status}).`,
        { httpStatus: response.status, requestId },
      );
    }
    return Buffer.from(await response.arrayBuffer());
  }

  const text = await response.text();
  let parsed = {};
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      if (response.ok) {
        throw new YousignTransportError(
          TRANSPORT_CODES.MALFORMED_RESPONSE,
          'Yousign a répondu hors JSON : l’issue est indéterminée.',
          { httpStatus: response.status, requestId, outcome: OUTCOMES.UNKNOWN },
        );
      }
    }
  }

  if (!response.ok) {
    throw new YousignTransportError(
      classify(response.status),
      safeMessage(parsed?.detail || parsed?.message) || `Yousign a refusé l’appel (HTTP ${response.status}).`,
      {
        httpStatus: response.status,
        requestId,
        invalidParams: extractInvalidParams(parsed),
        // Un refus REÇU est certain : rien n'est parti, le rejeu est légitime
        // après correction.
        outcome: OUTCOMES.FAILED,
        retryable: response.status === 429 || response.status >= 500,
      },
    );
  }

  return parsed;
}

/* -------------------------------------------------------------------------- */
/*  LES VERBES — un par appel réel, sans orchestration                         */
/* -------------------------------------------------------------------------- */

const call = (args) => yousignFetch(args);

/** POST /signature_requests → brouillon. */
export const createSignatureRequest = ({ credentials, name, deliveryMode = 'none', orderedSigners = true, ...rest }) =>
  call({
    ...rest,
    credentials,
    method: 'POST',
    path: '/signature_requests',
    json: { name, delivery_mode: deliveryMode, ordered_signers: orderedSigners, timezone: 'Europe/Paris' },
  });

/** POST /signature_requests/:id/documents — multipart, binaire pur. */
export const addDocument = ({ credentials, requestId, buffer, filename, parseAnchors = false, ...rest }) =>
  call({
    ...rest,
    credentials,
    method: 'POST',
    path: `/signature_requests/${requestId}/documents`,
    form: buildDocumentUploadForm({ buffer, filename, parseAnchors }),
  });

/** POST /signature_requests/:id/signers — l'ORDRE de création = ordre de signature. */
export const addSigner = ({ credentials, requestId, signer, ...rest }) =>
  call({ ...rest, credentials, method: 'POST', path: `/signature_requests/${requestId}/signers`, json: signer });

/** POST /signature_requests/:id/documents/:docId/fields. */
export const addField = ({ credentials, requestId, documentId, field, ...rest }) =>
  call({
    ...rest,
    credentials,
    method: 'POST',
    path: `/signature_requests/${requestId}/documents/${documentId}/fields`,
    json: field,
  });

/** POST /signature_requests/:id/activate → ongoing. */
export const activate = ({ credentials, requestId, ...rest }) =>
  call({ ...rest, credentials, method: 'POST', path: `/signature_requests/${requestId}/activate` });

export const getSignatureRequest = ({ credentials, requestId, ...rest }) =>
  call({ ...rest, credentials, path: `/signature_requests/${requestId}` });

export const getSigner = ({ credentials, requestId, signerId, ...rest }) =>
  call({ ...rest, credentials, path: `/signature_requests/${requestId}/signers/${signerId}` });

/** POST /signature_requests/:id/cancel — annule une demande en cours. */
export const cancelSignatureRequest = ({ credentials, requestId, reason = 'cancelled', ...rest }) =>
  call({ ...rest, credentials, method: 'POST', path: `/signature_requests/${requestId}/cancel`, json: { reason } });

/** DELETE /signature_requests/:id — supprime un BROUILLON resté en plan. */
export const deleteSignatureRequest = ({ credentials, requestId, ...rest }) =>
  call({ ...rest, credentials, method: 'DELETE', path: `/signature_requests/${requestId}`, binary: true })
    .then(() => ({ id: requestId, deleted: true }));

/** GET .../documents/:docId/download → PDF signé (Buffer). */
export const downloadSignedDocument = ({ credentials, requestId, documentId, ...rest }) =>
  call({
    ...rest,
    credentials,
    path: `/signature_requests/${requestId}/documents/${documentId}/download`,
    binary: true,
  });

export default {
  DEFAULT_TIMEOUT_MS,
  OUTCOMES,
  TRANSPORT_CODES,
  DOCUMENT_NATURE,
  YousignTransportError,
  toSafePdfFilename,
  buildDocumentUploadForm,
  yousignFetch,
  createSignatureRequest,
  addDocument,
  addSigner,
  addField,
  activate,
  getSignatureRequest,
  getSigner,
  cancelSignatureRequest,
  deleteSignatureRequest,
  downloadSignedDocument,
};
