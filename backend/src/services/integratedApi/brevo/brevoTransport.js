// FRONTIÈRE BREVO — la seule porte du Panel vers l'API de Brevo (L8).
//
// docs/architecture/BREVO_CONTROL_PLANE.md §« Adaptateur ».
//
// ── CE QUE CE FICHIER EST ───────────────────────────────────────────────────
//
//   intention déjà résolue  →  UN appel HTTP  →  résultat typé
//
// Pas de règle métier, pas de modèle, pas de coffre, pas de décision
// d'environnement. Tout cela est résolu EN AMONT et lui est passé. C'est ce
// qui rend la frontière testable sans base, sans réseau et sans secret.
//
// ── CE QU'IL N'EST PAS, ET NE DOIT JAMAIS DEVENIR ───────────────────────────
//
// Un « client Brevo » générique exposé aux projets. Il n'expose que les deux
// opérations dont une capacité a besoin. Ajouter `listContacts()` « au cas où »
// ouvrirait une surface que personne n'a demandée et que tout le monde
// finirait par utiliser.
//
// ── ACCEPTÉ ≠ ENVOYÉ ≠ REÇU ─────────────────────────────────────────────────
//
// Un retour en succès signifie « Brevo a accepté la requête ». Il ne signifie
// ni que le message est parti, ni qu'il arrivera. Seul un événement webhook
// peut dire « livré » — et lui non plus n'est pas prouvé (§J).
//
// ── ET SURTOUT : « JE NE SAIS PAS » EST UN RÉSULTAT ─────────────────────────
//
// Un délai dépassé n'est PAS « non envoyé ». La requête est peut-être arrivée,
// l'e-mail est peut-être parti, et seule la réponse s'est perdue. Traiter ce
// cas comme un échec conduit tôt ou tard à un rejeu, donc à un doublon chez un
// client. D'où `outcome: UNKNOWN`, distinct de `FAILED`, sur lequel aucune
// reprise automatique n'est permise (§H).
import logger from '../../../utils/logger.js';

/** Délai par défaut d'un appel Brevo. Aligné sur le driver éprouvé du projet. */
export const DEFAULT_TIMEOUT_MS = 15_000;

/* -------------------------------------------------------------------------- */
/*  RÉSULTATS                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Issue d'une tentative — trois valeurs, et la troisième est la raison d'être
 * de ce module.
 */
export const OUTCOMES = Object.freeze({
  /** Le fournisseur a accepté. Un identifiant de message existe. */
  SENT: 'SENT',
  /** Le fournisseur a refusé, ou n'a rien reçu. Rien n'est parti. */
  FAILED: 'FAILED',
  /** On ne sait pas. L'exécution a peut-être eu lieu. Ne jamais rejouer seul. */
  UNKNOWN: 'UNKNOWN',
});

/** Codes de transport — STABLES. Une capacité les traduit en codes métier. */
export const TRANSPORT_CODES = Object.freeze({
  OK: 'OK',
  MISSING_CREDENTIALS: 'MISSING_CREDENTIALS',
  INPUT_INVALID: 'INPUT_INVALID',
  UNAUTHORIZED: 'UNAUTHORIZED',
  REJECTED: 'REJECTED',
  QUOTA_EXHAUSTED: 'QUOTA_EXHAUSTED',
  RATE_LIMITED: 'RATE_LIMITED',
  PROVIDER_ERROR: 'PROVIDER_ERROR',
  MALFORMED_RESPONSE: 'MALFORMED_RESPONSE',
  TIMEOUT: 'TIMEOUT',
  UNREACHABLE: 'UNREACHABLE',
});

/**
 * Erreur de transport. `message` est TOUJOURS sûr à afficher : Brevo n'écho
 * jamais la clé dans ses corps d'erreur, et le texte repris est tronqué.
 */
export class BrevoTransportError extends Error {
  constructor(code, message, { httpStatus = null, providerCode = null, retryable = false, outcome = OUTCOMES.FAILED, durationMs = null } = {}) {
    super(message);
    this.name = 'BrevoTransportError';
    this.code = code;
    this.httpStatus = httpStatus;
    this.providerCode = providerCode;
    /** Une nouvelle tentative a-t-elle une CHANCE d'aboutir ? */
    this.retryable = retryable;
    /**
     * Une nouvelle tentative est-elle SÛRE ? Ce n'est pas la même question.
     * Un 429 est retryable ET sûr ; un délai dépassé est retryable mais PAS
     * sûr, parce que le premier envoi est peut-être parti.
     */
    this.outcome = outcome;
    this.durationMs = durationMs;
  }

  /** Rejouer cette erreur peut-il produire un doublon ? */
  get replaySafe() {
    return this.outcome === OUTCOMES.FAILED;
  }
}

/* -------------------------------------------------------------------------- */
/*  OUTILS                                                                    */
/* -------------------------------------------------------------------------- */

const stripSlash = (url) => String(url || '').replace(/\/+$/, '');

/** Message fournisseur tronqué — repris pour le diagnostic, jamais un secret. */
function safeMessage(message) {
  if (typeof message !== 'string') return '';
  const clean = message.trim();
  if (!clean) return '';
  return clean.length > 300 ? `${clean.slice(0, 300)}…` : clean;
}

/** `jean.dupont@exemple.fr` → `j••••t@exemple.fr`. Assez pour diagnostiquer. */
export function maskEmail(value) {
  const text = String(value ?? '');
  const at = text.indexOf('@');
  if (at <= 0) return text ? '•••' : '';
  const local = text.slice(0, at);
  const domain = text.slice(at);
  if (local.length <= 2) return `${local[0]}•••${domain}`;
  return `${local[0]}••••${local[local.length - 1]}${domain}`;
}

/**
 * Forme CANONIQUE d'un identifiant de message Brevo : sans chevrons, sans
 * espaces. Écriture et lecture partagent ce helper — sinon la corrélation d'un
 * événement de livraison dépend d'un détail de format du fournisseur, et le
 * suivi « reste bloqué » sans que personne ne comprenne pourquoi.
 */
export function normalizeProviderMessageId(raw) {
  const text = String(raw ?? '').trim();
  if (!text) return '';
  return text.replace(/^<+/, '').replace(/>+$/, '').trim();
}

/** Les deux graphies à interroger quand on cherche une livraison. */
export function providerMessageIdVariants(id) {
  const canonical = normalizeProviderMessageId(id);
  if (!canonical) return [];
  return [canonical, `<${canonical}>`];
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function assertAddress(label, address) {
  if (!address?.email || !EMAIL_RE.test(String(address.email))) {
    throw new BrevoTransportError(TRANSPORT_CODES.INPUT_INVALID, `${label} : adresse absente ou invalide.`, {
      outcome: OUTCOMES.FAILED,
    });
  }
}

/* -------------------------------------------------------------------------- */
/*  APPEL                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Appel HTTP borné dans le temps.
 *
 * `fetchImpl` est injectable : les tests ne sortent jamais sur le réseau, et
 * un test qui simulerait Brevo en monkey-patchant `globalThis.fetch`
 * contaminerait les autres.
 */
async function brevoFetch({ credentials, path, method = 'GET', body, timeoutMs, fetchImpl }) {
  if (!credentials?.apiKey) {
    throw new BrevoTransportError(TRANSPORT_CODES.MISSING_CREDENTIALS, 'Clé API Brevo absente pour cet environnement.', {
      outcome: OUTCOMES.FAILED,
    });
  }
  const base = stripSlash(credentials.baseUrl);
  if (!base) {
    throw new BrevoTransportError(TRANSPORT_CODES.MISSING_CREDENTIALS, 'URL de base Brevo absente.', {
      outcome: OUTCOMES.FAILED,
    });
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = Date.now();
  let response;
  try {
    response = await (fetchImpl ?? globalThis.fetch)(`${base}${path}`, {
      method,
      headers: {
        'api-key': credentials.apiKey,
        accept: 'application/json',
        // `charset=utf-8` EXPLICITE : `JSON.stringify` produit de l'UTF-8, mais
        // l'annoncer retire l'ambiguïté d'interprétation. Sans lui, un accent
        // ressort en « Ãª » chez le destinataire.
        ...(body !== undefined ? { 'Content-Type': 'application/json; charset=utf-8' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
  } catch (err) {
    const durationMs = Date.now() - startedAt;
    const timedOut = err?.name === 'AbortError';
    /**
     * LE POINT CENTRAL DU MODULE.
     *
     * Aucune réponse ne signifie pas « rien ne s'est passé ». La requête a pu
     * atteindre Brevo, être acceptée, et seule la réponse s'être perdue. On
     * remonte donc `UNKNOWN` : retryable au sens « ça pourrait marcher », mais
     * PAS rejouable sans arbitrage, parce que le rejeu produirait un doublon.
     */
    throw new BrevoTransportError(
      timedOut ? TRANSPORT_CODES.TIMEOUT : TRANSPORT_CODES.UNREACHABLE,
      timedOut ? 'Brevo n’a pas répondu dans le délai imparti.' : 'Brevo injoignable.',
      { retryable: true, outcome: OUTCOMES.UNKNOWN, durationMs },
    );
  } finally {
    clearTimeout(timer);
  }

  const durationMs = Date.now() - startedAt;
  const text = await response.text().catch(() => '');
  let json = {};
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      // Corps illisible : on ne le propage PAS. Un HTML de portail captif ou
      // une page d'erreur de proxy n'a rien à faire dans un diagnostic, et
      // pourrait contenir n'importe quoi.
      json = {};
    }
  }
  return { response, json, durationMs };
}

/**
 * Traduit un refus Brevo en erreur typée — et surtout : décide s'il est SÛR de
 * réessayer.
 *
 * C'est la seule fonction qui sait faire cette différence, et elle compte. Une
 * clé refusée réessayée quatre fois ne fait que remplir le journal ; une limite
 * de débit non réessayée perd un e-mail légitime.
 *
 * Toutes les issues ci-dessous sont `FAILED` : Brevo a RÉPONDU, donc il a
 * tranché, donc rien n'est parti. C'est ce qui les rend rejouables sans risque
 * de doublon — contrairement au silence.
 */
function throwProviderError(response, json, durationMs) {
  const providerCode = json?.code ?? null;
  const detail = safeMessage(json?.message);
  const suffix = detail ? ` ${detail}` : '';
  const status = response.status;
  const base = { httpStatus: status, providerCode, durationMs, outcome: OUTCOMES.FAILED };

  // 401/403 : clé invalide OU IP de ce serveur non autorisée sur le compte.
  // Les deux se corrigent par une configuration, jamais par une reprise.
  if (status === 401 || status === 403) {
    throw new BrevoTransportError(
      TRANSPORT_CODES.UNAUTHORIZED,
      `Brevo a refusé la clé (${status}) — clé invalide, ou IP de ce serveur non autorisée sur le compte.${suffix}`,
      { ...base, retryable: false },
    );
  }
  // 400 : la requête est fautive (expéditeur non vérifié, adresse illisible).
  // La rejouer à l'identique produirait exactement le même refus.
  if (status === 400) {
    throw new BrevoTransportError(TRANSPORT_CODES.REJECTED, `Brevo a refusé l’envoi (400).${suffix}`, {
      ...base,
      retryable: false,
    });
  }
  // 402 : crédits épuisés. Aucun backoff ne recharge un compte — l'échec doit
  // être visible tout de suite, pas dilué dans quatre tentatives.
  if (status === 402) {
    throw new BrevoTransportError(TRANSPORT_CODES.QUOTA_EXHAUSTED, `Brevo refuse : crédits insuffisants (402).${suffix}`, {
      ...base,
      retryable: false,
    });
  }
  // 429 : limite de débit. Le cas que la reprise sait résoudre, et le seul.
  if (status === 429) {
    throw new BrevoTransportError(TRANSPORT_CODES.RATE_LIMITED, 'Brevo limite le débit (429).', {
      ...base,
      retryable: true,
    });
  }
  // 5xx : panne de leur côté. Brevo a répondu qu'il n'a pas traité.
  if (status >= 500) {
    throw new BrevoTransportError(TRANSPORT_CODES.PROVIDER_ERROR, `Brevo est en erreur (${status}).`, {
      ...base,
      retryable: true,
    });
  }
  throw new BrevoTransportError(TRANSPORT_CODES.PROVIDER_ERROR, `Brevo a répondu ${status}.${suffix}`, {
    ...base,
    retryable: false,
  });
}

/* -------------------------------------------------------------------------- */
/*  OPÉRATIONS — deux, et pas une de plus                                     */
/* -------------------------------------------------------------------------- */

/**
 * `POST /smtp/email` — remet UN message transactionnel.
 *
 * Le contenu est DÉJÀ RENDU par le Panel (`subject` + `htmlContent`). Aucun
 * `templateId` n'est transmis : le contenu reste dans nos versions, sous notre
 * validation, et hors de l'interface de Brevo.
 *
 * @param {object} args
 * @param {{apiKey: string, baseUrl: string}} args.credentials  déjà déchiffrés par l'appelant
 * @param {{name?: string, email: string}} args.sender          résolu par le Panel, jamais par le projet
 * @param {{name?: string, email: string}} args.recipient
 * @param {string} args.subject
 * @param {string} args.htmlContent
 * @param {string} [args.textContent]
 * @param {{name?: string, email: string}} [args.replyTo]
 * @param {string[]} [args.tags]
 * @param {number} [args.timeoutMs]
 * @param {Function} [args.fetchImpl]
 * @returns {Promise<{outcome: 'SENT', providerMessageId: string, httpStatus: number, durationMs: number}>}
 * @throws {BrevoTransportError}
 */
export async function sendTransactionalEmail({
  credentials,
  sender,
  recipient,
  subject,
  htmlContent,
  textContent,
  replyTo,
  tags,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  fetchImpl,
}) {
  assertAddress('Expéditeur', sender);
  assertAddress('Destinataire', recipient);
  if (!subject) {
    throw new BrevoTransportError(TRANSPORT_CODES.INPUT_INVALID, 'Sujet manquant.', { outcome: OUTCOMES.FAILED });
  }
  if (!htmlContent) {
    throw new BrevoTransportError(TRANSPORT_CODES.INPUT_INVALID, 'Contenu manquant.', { outcome: OUTCOMES.FAILED });
  }

  const body = {
    sender: { name: sender.name || sender.email, email: sender.email },
    to: [recipient.name ? { email: recipient.email, name: recipient.name } : { email: recipient.email }],
    subject,
    htmlContent,
    // Chaîne Unicode transmise DIRECTEMENT — aucun réencodage manuel.
    ...(textContent ? { textContent } : {}),
    // `replyTo` (le demandeur) est distinct du `sender` (notre identité).
    ...(replyTo?.email
      ? { replyTo: replyTo.name ? { email: replyTo.email, name: replyTo.name } : { email: replyTo.email } }
      : {}),
    // Étiquettes renvoyées telles quelles dans l'événement : seconde poignée de
    // corrélation, en plus de l'identifiant de message.
    ...(Array.isArray(tags) && tags.length ? { tags: tags.slice(0, 10).map(String) } : {}),
  };

  /**
   * Trace volontairement pauvre : ni sujet, ni HTML, ni adresse en clair, ni
   * clé. Une taille et deux adresses masquées suffisent à diagnostiquer un
   * contenu aberrant ; un journal n'est pas un endroit pour des données
   * personnelles.
   */
  logger.info(
    `[brevo] POST /smtp/email — destinataire ${maskEmail(recipient.email)}, `
    + `expéditeur ${maskEmail(sender.email)}, ${htmlContent.length} caractères.`,
  );

  const { response, json, durationMs } = await brevoFetch({
    credentials,
    path: '/smtp/email',
    method: 'POST',
    body,
    timeoutMs,
    fetchImpl,
  });

  if (!response.ok) throwProviderError(response, json, durationMs);

  const providerMessageId = normalizeProviderMessageId(json?.messageId);
  if (!providerMessageId) {
    /**
     * 2xx SANS identifiant de message : Brevo est hors de son contrat.
     *
     * L'issue est `UNKNOWN`, pas `FAILED` : il a répondu « accepté », donc
     * l'e-mail est probablement parti — on n'a simplement plus la poignée pour
     * le suivre. Le déclarer échoué inviterait à rejouer, donc à doubler.
     */
    throw new BrevoTransportError(
      TRANSPORT_CODES.MALFORMED_RESPONSE,
      'Brevo a répondu sans identifiant de message : l’envoi ne peut plus être suivi.',
      { httpStatus: response.status, retryable: false, outcome: OUTCOMES.UNKNOWN, durationMs },
    );
  }

  return { outcome: OUTCOMES.SENT, providerMessageId, httpStatus: response.status, durationMs };
}

/**
 * `GET /account` — prouve l'authentification sans rien créer.
 *
 * Doublon assumé avec `providerValidation.validateBrevo` (L1) ? Non : celui-ci
 * ne persiste rien et ne parle pas au coffre. L1 valide un JEU d'identifiants
 * pour l'écran d'administration ; ici, on répond à « ce transport est-il
 * utilisable maintenant ? » pour un diagnostic d'exécution.
 *
 * @returns {Promise<{ok: true, account: string|null, accountEmail: string|null, httpStatus: number, durationMs: number}>}
 */
export async function describeAccount({ credentials, timeoutMs = DEFAULT_TIMEOUT_MS, fetchImpl }) {
  const { response, json, durationMs } = await brevoFetch({
    credentials,
    path: '/account',
    timeoutMs,
    fetchImpl,
  });
  if (!response.ok) throwProviderError(response, json, durationMs);
  return {
    ok: true,
    account: json?.companyName ?? null,
    accountEmail: json?.email ?? null,
    httpStatus: response.status,
    durationMs,
  };
}

/* -------------------------------------------------------------------------- */
/*  POLITIQUE DE REPRISE                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Faut-il, et peut-on, réessayer ?
 *
 * Deux questions distinctes, et les confondre est l'erreur qui produit des
 * doublons chez de vrais clients :
 *
 *   `retryable`  — une nouvelle tentative a-t-elle une chance d'aboutir ?
 *   `replaySafe` — une nouvelle tentative risque-t-elle de doubler l'envoi ?
 *
 * Une reprise AUTOMATIQUE exige les deux. Sinon, un humain tranche.
 */
export function describeRetryDecision(error) {
  if (!(error instanceof BrevoTransportError)) {
    return { retryable: false, replaySafe: false, automatic: false, reason: 'ERREUR_NON_TYPÉE' };
  }
  const automatic = error.retryable && error.replaySafe;
  return {
    retryable: error.retryable,
    replaySafe: error.replaySafe,
    automatic,
    outcome: error.outcome,
    reason: automatic
      ? 'REPRISE_AUTOMATIQUE'
      : error.outcome === OUTCOMES.UNKNOWN
        ? 'ISSUE_INCONNUE_ARBITRAGE_HUMAIN'
        : 'ECHEC_DEFINITIF',
  };
}

export default {
  DEFAULT_TIMEOUT_MS,
  OUTCOMES,
  TRANSPORT_CODES,
  BrevoTransportError,
  sendTransactionalEmail,
  describeAccount,
  describeRetryDecision,
  normalizeProviderMessageId,
  providerMessageIdVariants,
  maskEmail,
};
