// TRANSPORT OPENSIGN — le seul endroit du Panel qui parlera à OpenSign.
//
// docs/integrated-api/OPENSIGN_API_AUDIT_AND_FOUNDATION.md.
//
// ══ CE QUE CE MODULE PORTE, ET CE QU'IL NE DÉCIDE PAS ═══════════════════════
//
// Il porte : l'en-tête d'authentification, la résolution de l'hôte depuis le
// coffre, les délais bornés, les erreurs TYPÉES, et la distinction entre « il a
// dit non » et « il n'a rien dit ».
//
// Il ne décide RIEN : ni l'appartenance d'une ressource, ni le droit d'agir, ni
// l'idempotence. Ces trois-là appartiennent à la passerelle et aux modules
// d'ownership — les mélanger au transport rendrait impossible de prouver
// qu'aucun appel n'est parti avant leur verdict. C'est la discipline établie
// par `yousignTransport.js`, et elle ne change pas parce que le fournisseur
// change.
//
// ══ PÉRIMÈTRE DE CE LOT ═════════════════════════════════════════════════════
//
// Les verbes ci-dessous sont ceux du PLAN DE CONTRÔLE : lire le compte, lire
// les crédits, lire/poser/retirer l'URL de webhook. Aucun verbe de document.
//
// Ce n'est pas de la prudence décorative : créer un document OpenSign CONSOMME
// UN CRÉDIT et peut envoyer un e-mail à une personne réelle. Un verbe qui
// existe finit par être appelé — d'abord dans un test, puis par accident. Les
// verbes de document arriveront avec l'adaptateur qui sait quand les employer,
// et pas une ligne avant.
//
// ══ POURQUOI PAS DE RÉESSAI AUTOMATIQUE SUR ÉCRITURE ════════════════════════
//
// Même raison que chez Yousign : la moindre écriture engage un tiers. Ici elle
// débite en plus un crédit. Un `catch` qui rejoue produit exactement le doublon
// qu'on cherche à rendre impossible.

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
  /** Refus qui n'est ni d'entrée ni d'authentification (conflit, état). */
  REJECTED: 'REJECTED',
  RATE_LIMITED: 'RATE_LIMITED',
  /** Crédits API épuisés — le COMPTE est en cause, pas l'appel. */
  QUOTA_EXHAUSTED: 'QUOTA_EXHAUSTED',
  PROVIDER_ERROR: 'PROVIDER_ERROR',
  MALFORMED_RESPONSE: 'MALFORMED_RESPONSE',
  TIMEOUT: 'TIMEOUT',
  UNREACHABLE: 'UNREACHABLE',
});

export class OpenSignTransportError extends Error {
  constructor(code, message, {
    httpStatus = null, retryable = false, outcome = OUTCOMES.FAILED, providerError = null,
  } = {}) {
    super(message);
    this.name = 'OpenSignTransportError';
    this.code = code;
    this.httpStatus = httpStatus;
    this.retryable = retryable;
    this.outcome = outcome;
    /**
     * Le libellé d'erreur d'OpenSign, tronqué.
     *
     * OpenSign ne nomme JAMAIS le champ fautif : contrairement à
     * `invalid_params` chez Yousign, il rend une phrase unique
     * (« Something went wrong, please try again later! ») pour toutes les
     * causes d'entrée. Conserver la phrase est donc le seul repère disponible —
     * et c'est aussi ce qui permet de reconnaître les quelques refus qui, eux,
     * se distinguent (voir `classify`).
     */
    this.providerError = providerError;
  }

  /** Rejouer cette erreur peut-il produire un doublon ? */
  get replaySafe() {
    return this.outcome === OUTCOMES.FAILED;
  }
}

const stripSlash = (url) => String(url || '').replace(/\/+$/, '');

/** Message fournisseur tronqué. Jamais l'en-tête d'autorisation. */
export function safeMessage(message) {
  if (typeof message !== 'string') return null;
  const clean = message.trim();
  if (!clean) return null;
  return clean.length > 300 ? `${clean.slice(0, 300)}…` : clean;
}

/** Le libellé d'erreur, quel que soit le champ qui le porte. */
export function extractProviderError(body) {
  if (!body || typeof body !== 'object') return null;
  return safeMessage(body.error ?? body.message ?? null);
}

/**
 * Classe une réponse HTTP en code de transport.
 *
 * ══ DEUX PIÈGES D'OPENSIGN, ET ILS SONT TOUS LES DEUX ICI ═══════════════════
 *
 * ── 405 NE VEUT PAS DIRE « MÉTHODE NON AUTORISÉE » ──────────────────────────
 *
 * OpenSign répond `405 { "error": "Invalid API token!" }` quand le jeton est
 * refusé. C'est documenté ainsi pour les 36 endpoints de l'API v1.2, sans
 * exception.
 *
 * Un classificateur HTTP générique range 405 dans « refus inattendu ». Le
 * diagnostic devient alors « OpenSign a répondu 405 » — une phrase qui envoie
 * relire son URL et sa méthode, alors que la seule chose à corriger est la
 * clé. C'est exactement la classe de faux diagnostic que le plan de contrôle
 * existe pour supprimer.
 *
 * ── 401 NE VEUT PAS TOUJOURS DIRE « JETON REFUSÉ » ──────────────────────────
 *
 * `POST /webhook` rend `401 { "error": "Webhook url already exists!" }` quand
 * l'URL est déjà posée. C'est un CONFLIT, pas un refus d'authentification : le
 * jeton était parfaitement valide, il vient de servir. Le ranger en
 * `UNAUTHORIZED` afficherait « clé invalide » au moment précis où le webhook
 * est correctement en place.
 *
 * On ne devine pas : on RECONNAÎT ce refus par un concept, comme ailleurs dans
 * le Panel — un fournisseur peut reformuler sans changer sa règle, et une
 * correspondance littérale cesserait de le reconnaître.
 */
export function classify(status, body) {
  const message = String(extractProviderError(body) ?? '').toLowerCase();

  // 405 = jeton refusé. Voir l'entête de la fonction.
  if (status === 405) return TRANSPORT_CODES.UNAUTHORIZED;

  if (status === 401) {
    if (message.includes('exist')) return TRANSPORT_CODES.REJECTED;
    return TRANSPORT_CODES.UNAUTHORIZED;
  }
  if (status === 403) return TRANSPORT_CODES.UNAUTHORIZED;
  if (status === 404) return TRANSPORT_CODES.NOT_FOUND;
  if (status === 402) return TRANSPORT_CODES.QUOTA_EXHAUSTED;
  if (status === 400 || status === 409 || status === 422) {
    // Les crédits épuisés arrivent en 400 avec une phrase qui les nomme. Les
    // confondre avec une entrée invalide ferait chercher un champ fautif dans
    // un payload correct.
    if (message.includes('credit')) return TRANSPORT_CODES.QUOTA_EXHAUSTED;
    return TRANSPORT_CODES.INPUT_INVALID;
  }
  if (status === 429) return TRANSPORT_CODES.RATE_LIMITED;
  if (status >= 500) return TRANSPORT_CODES.PROVIDER_ERROR;
  return TRANSPORT_CODES.REJECTED;
}

/**
 * UN appel OpenSign. Rend le corps analysé, ou lève une
 * `OpenSignTransportError`.
 *
 * @param {object} args
 * @param {{apiToken: string, baseUrl: string}} args.credentials — consommés, jamais rendus
 * @param {'GET'|'POST'|'PUT'|'DELETE'} [args.method]
 * @param {string} args.path
 * @param {object} [args.json]
 * @param {boolean} [args.binary] — rend un Buffer (document signé, certificat)
 */
export async function openSignFetch({
  credentials, method = 'GET', path, json, binary = false,
  timeoutMs = DEFAULT_TIMEOUT_MS, fetchImpl,
}) {
  const apiToken = credentials?.apiToken;
  /**
   * L'HÔTE VIENT DU COFFRE, TOUJOURS.
   *
   * Il n'est écrit nulle part dans ce fichier — ni en dur, ni en repli. Le
   * registre porte les deux hôtes et la contrainte qui les sépare ; ici, un
   * hôte absent est une erreur, pas une occasion de choisir à la place de
   * l'exploitant. Un repli sur la production serait le pire des défauts : il
   * ferait partir une clé de bac à sable vers le monde réel.
   */
  const baseUrl = stripSlash(credentials?.baseUrl);
  if (!apiToken || !baseUrl) {
    throw new OpenSignTransportError(
      TRANSPORT_CODES.MISSING_CREDENTIALS,
      'Identifiants OpenSign incomplets (jeton ou hôte absent).',
    );
  }

  const doFetch = fetchImpl ?? globalThis.fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let response;
  try {
    const headers = {
      // Le nom exact du fournisseur. Aucun `Bearer` : OpenSign n'en veut pas.
      'x-api-token': apiToken,
      accept: 'application/json',
    };
    let body;
    if (json !== undefined) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(json);
    }
    response = await doFetch(`${baseUrl}${path}`, { method, headers, body, signal: controller.signal });
  } catch (error) {
    const aborted = error?.name === 'AbortError';
    throw new OpenSignTransportError(
      aborted ? TRANSPORT_CODES.TIMEOUT : TRANSPORT_CODES.UNREACHABLE,
      aborted
        ? `OpenSign n’a pas répondu en ${timeoutMs} ms : l’issue est indéterminée.`
        : 'OpenSign est injoignable : l’issue est indéterminée.',
      // INDÉTERMINÉ dans les deux cas : la requête a pu partir et aboutir.
      { outcome: OUTCOMES.UNKNOWN, retryable: false },
    );
  } finally {
    clearTimeout(timer);
  }

  if (binary) {
    if (!response.ok) {
      throw new OpenSignTransportError(
        classify(response.status, null),
        `OpenSign a refusé le téléchargement (HTTP ${response.status}).`,
        { httpStatus: response.status },
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
        throw new OpenSignTransportError(
          TRANSPORT_CODES.MALFORMED_RESPONSE,
          'OpenSign a répondu hors JSON : l’issue est indéterminée.',
          { httpStatus: response.status, outcome: OUTCOMES.UNKNOWN },
        );
      }
    }
  }

  if (!response.ok) {
    throw new OpenSignTransportError(
      classify(response.status, parsed),
      // On ne relaie pas la phrase du fournisseur dans le MESSAGE : elle voyage
      // dans `providerError`, où l'appelant décide s'il l'expose.
      `OpenSign a refusé l’appel (HTTP ${response.status}).`,
      {
        httpStatus: response.status,
        providerError: extractProviderError(parsed),
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
/*  LES VERBES DU PLAN DE CONTRÔLE — un par appel réel, sans orchestration     */
/* -------------------------------------------------------------------------- */

const call = (args) => openSignFetch(args);

/**
 * `GET /getuser` — le compte lui-même.
 *
 * LECTURE PURE : elle ne crée rien, n'envoie aucun e-mail, ne débite aucun
 * crédit. C'est ce qui en fait la sonde de validation d'un jeu d'identifiants :
 * son échec ne prive personne de rien, et son rejeu ne produit aucun doublon.
 */
export const getUser = ({ credentials, ...rest }) =>
  call({ ...rest, credentials, path: '/getuser' });

/**
 * `GET /getcredits` — les crédits API du compte.
 *
 * Sonde d'EXPLOITATION, pas d'authentification : un compte sans abonnement
 * répond `400 Subscription not found` alors que son jeton est parfaitement
 * valide. L'appelant doit donc traiter ce refus comme une information, jamais
 * comme un verdict sur la clé.
 */
export const getCredits = ({ credentials, ...rest }) =>
  call({ ...rest, credentials, path: '/getcredits' });

/**
 * `GET /webhook` — l'URL de webhook du compte.
 *
 * ⚠️ SINGULIER, et ce n'est pas une simplification de notre part : OpenSign ne
 * gère qu'UNE seule URL par compte. Il n'y a ni liste, ni identifiant
 * d'endpoint, ni sélection d'événements. La ressource existe, ou n'existe pas.
 */
export const getWebhook = ({ credentials, ...rest }) =>
  call({ ...rest, credentials, path: '/webhook' });

/**
 * `POST /webhook` — pose OU met à jour l'URL (le même verbe fait les deux).
 *
 * Rend `401 Webhook url already exists!` si l'URL posée est identique à
 * l'existante — un conflit, pas un refus de jeton. Voir `classify`.
 */
export const saveWebhook = ({ credentials, url, ...rest }) =>
  call({ ...rest, credentials, method: 'POST', path: '/webhook', json: { url } });

/** `DELETE /webhook` — retire l'URL du compte. */
export const deleteWebhook = ({ credentials, ...rest }) =>
  call({ ...rest, credentials, method: 'DELETE', path: '/webhook' });

/* -------------------------------------------------------------------------- */
/*  LES VERBES DE DOCUMENT — ceux qui engagent, et qui coûtent                 */
/* -------------------------------------------------------------------------- */

/**
 * `POST /createdocument` — L'ACTE COMPLET, EN UN SEUL APPEL.
 *
 * ══ CE QUE CET APPEL FAIT, ET QUE YOUSIGN DEMANDAIT EN ONZE ════════════════
 *
 * Il crée le document, y attache les signataires, y pose leurs zones, et rend
 * les liens de signature. Chez Yousign, il fallait créer un brouillon, y
 * téléverser un PDF en multipart, ajouter n signataires, poser n champs, puis
 * activer — et surtout : garder une fenêtre pendant laquelle une préparation
 * pouvait s'arrêter à mi-chemin, laissant un brouillon orphelin et facturable
 * qu'il fallait penser à supprimer.
 *
 * Cette fenêtre n'existe plus. Ce n'est pas une économie d'appels réseau, c'est
 * la disparition d'un état intermédiaire observable.
 *
 * ══ ⚠️ CET APPEL DÉBITE UN CRÉDIT ══════════════════════════════════════════
 *
 * Mesuré : un crédit par document créé, et la suppression ne le rend pas. Un
 * rejeu « pour voir » n'est donc jamais gratuit — c'est la raison d'être de la
 * réservation d'opération qui le précède côté passerelle.
 */
export const createDocument = ({ credentials, document, ...rest }) =>
  call({ ...rest, credentials, method: 'POST', path: '/createdocument', json: document });

/** `GET /document/:id` — état, piste d'audit, URL du fichier et du certificat. */
export const getDocument = ({ credentials, documentId, ...rest }) =>
  call({ ...rest, credentials, path: `/document/${encodeURIComponent(documentId)}` });

/** `GET /signinglinks/:id` — un lien par signataire, indexé par ADRESSE. */
export const getSigningLinks = ({ credentials, documentId, ...rest }) =>
  call({ ...rest, credentials, path: `/signinglinks/${encodeURIComponent(documentId)}` });

/**
 * `POST /document/:id` — RÉVOQUER.
 *
 * Le motif est un TEXTE LIBRE, et c'est une différence heureuse : chez Yousign
 * il s'agissait d'une énumération non documentée, où `'cancelled'` était refusé
 * par un message qui ne nommait aucun champ. L'incident ne peut pas se
 * reproduire ici.
 *
 * ⚠️ Mesuré : après révocation, le document passe en `declined` — OpenSign n'a
 * pas d'état « révoqué » distinct.
 */
export const revokeDocument = ({ credentials, documentId, reason, ...rest }) =>
  call({
    ...rest, credentials, method: 'POST',
    path: `/document/${encodeURIComponent(documentId)}`, json: { reason },
  });

/**
 * `DELETE /document/:id` — SUPPRIMER.
 *
 * Réservé au nettoyage de recette et à la reprise après un échec de
 * préparation. Ce n'est pas l'inverse d'une révocation : révoquer arrête un
 * engagement en le consignant, supprimer efface la trace. Le parcours métier
 * révoque ; seule la recette supprime.
 */
export const deleteDocument = ({ credentials, documentId, ...rest }) =>
  call({ ...rest, credentials, method: 'DELETE', path: `/document/${encodeURIComponent(documentId)}` });

/**
 * `PUT /document/:id` — modifier ce qui reste modifiable (jamais le fichier).
 *
 * Utile pour corriger une URL de retour après coup. Le document, lui, est figé
 * dès sa création : c'est une propriété du fournisseur, pas une limite de ce
 * module.
 */
export const updateDocument = ({ credentials, documentId, patch, ...rest }) =>
  call({
    ...rest, credentials, method: 'PUT',
    path: `/document/${encodeURIComponent(documentId)}`, json: patch,
  });

/**
 * TÉLÉCHARGE UN FICHIER QUE LE FOURNISSEUR NOUS A DÉSIGNÉ.
 *
 * ══ POURQUOI CE VERBE EXISTE, ALORS QU'IL NE VISE PAS L'API ═════════════════
 *
 * OpenSign ne SERT pas les PDF : il rend une URL PRÉ-SIGNÉE vers son stockage
 * objet, valable quelques minutes. Le document signé et le certificat d'audit
 * ne s'obtiennent que par là. Un plan de contrôle qui refuserait de suivre
 * cette URL ne pourrait jamais archiver un contrat signé — c'est-à-dire
 * échouerait sur le seul livrable qui compte juridiquement.
 *
 * ══ LES QUATRE GARDES, ET CE QU'ELLES EMPÊCHENT ═════════════════════════════
 *
 * 1. L'URL VIENT D'UNE RÉPONSE DU FOURNISSEUR, jamais d'un appelant. Un
 *    projet qui pourrait nommer l'URL à télécharger transformerait le Panel en
 *    relais de requêtes sortantes vers l'adresse de son choix — depuis
 *    l'intérieur du réseau, avec les identifiants du Panel dans le contexte.
 * 2. HTTPS EXIGÉ. Un contrat signé ne descend pas en clair.
 * 3. TAILLE BORNÉE, et vérifiée pendant la lecture — pas seulement d'après
 *    l'en-tête `content-length`, qu'un serveur peut mentir ou omettre.
 * 4. DÉLAI BORNÉ, comme tout le reste de ce module.
 *
 * ══ ET CETTE URL NE TRAVERSE JAMAIS LE PONT ════════════════════════════════
 *
 * Elle porte son propre droit d'accès : la transmettre à un projet reviendrait
 * à lui donner le document sans passer par la preuve d'appartenance. Le Panel
 * télécharge, puis rend le CONTENU.
 */
export async function fetchProviderFile({
  url, timeoutMs = DEFAULT_TIMEOUT_MS, maxBytes = 32 * 1024 * 1024, fetchImpl,
}) {
  let cible;
  try {
    cible = new URL(String(url ?? ''));
  } catch {
    throw new OpenSignTransportError(
      TRANSPORT_CODES.MALFORMED_RESPONSE,
      'OpenSign a désigné un fichier par une adresse illisible.',
    );
  }
  if (cible.protocol !== 'https:') {
    throw new OpenSignTransportError(
      TRANSPORT_CODES.MALFORMED_RESPONSE,
      'OpenSign a désigné un fichier hors HTTPS : téléchargement refusé.',
    );
  }

  const doFetch = fetchImpl ?? globalThis.fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let reponse;
  try {
    reponse = await doFetch(cible.href, { method: 'GET', signal: controller.signal });
  } catch (error) {
    throw new OpenSignTransportError(
      error?.name === 'AbortError' ? TRANSPORT_CODES.TIMEOUT : TRANSPORT_CODES.UNREACHABLE,
      'Le stockage d’OpenSign n’a pas répondu : le document n’a pas pu être lu.',
      // Une LECTURE indéterminée ne crée rien : elle est rejouable sans risque.
      { outcome: OUTCOMES.FAILED },
    );
  } finally {
    clearTimeout(timer);
  }

  if (!reponse.ok) {
    throw new OpenSignTransportError(
      classify(reponse.status, null),
      `Le stockage d’OpenSign a refusé le téléchargement (HTTP ${reponse.status}). `
      + 'Une adresse pré-signée expire : relire le document en redemande une neuve.',
      { httpStatus: reponse.status },
    );
  }

  const octets = Buffer.from(await reponse.arrayBuffer());
  if (octets.length > maxBytes) {
    throw new OpenSignTransportError(
      TRANSPORT_CODES.MALFORMED_RESPONSE,
      `Fichier hors gabarit : ${octets.length} octets pour une limite de ${maxBytes}.`,
    );
  }
  if (octets.length === 0) {
    throw new OpenSignTransportError(
      TRANSPORT_CODES.MALFORMED_RESPONSE,
      'Le stockage d’OpenSign a rendu un fichier vide.',
    );
  }
  return octets;
}

export default {
  DEFAULT_TIMEOUT_MS,
  OUTCOMES,
  TRANSPORT_CODES,
  OpenSignTransportError,
  safeMessage,
  extractProviderError,
  classify,
  openSignFetch,
  getUser,
  getCredits,
  getWebhook,
  saveWebhook,
  deleteWebhook,
  createDocument,
  getDocument,
  getSigningLinks,
  revokeDocument,
  deleteDocument,
  updateDocument,
  fetchProviderFile,
};
