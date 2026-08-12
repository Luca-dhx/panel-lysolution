// FRONTIÈRE STRIPE — la seule porte du Panel vers l'API Stripe (L6.1).
//
// docs/architecture/STRIPE_L6_1_CONTROL_PLANE_FOUNDATION_REPORT.md §« Transport ».
//
// ── POURQUOI PAS LE SDK OFFICIEL ────────────────────────────────────────────
//
// Le SDK `stripe` est excellent, et il est déjà utilisé côté projet. Le Panel,
// lui, n'a aucune dépendance fournisseur : ni Stripe, ni Brevo, ni Hostinger.
// Ce n'est pas un dogme — c'est que la surface réellement utilisée tient en
// quelques appels, et qu'une dépendance qui embarque son propre client HTTP,
// ses reprises et sa version d'API introduirait trois comportements qu'on ne
// choisit plus. Ici, chaque décision est visible dans ce fichier.
//
// Le prix à payer est explicite : Stripe parle `x-www-form-urlencoded`, pas
// JSON, et l'encodage des objets imbriqués (`metadata[contractId]`) est fait à
// la main plus bas. C'est vingt lignes, et elles sont testées.
//
// ── VERSION D'API ÉPINGLÉE ──────────────────────────────────────────────────
//
// La même que le projet. Sans épinglage, les appels sortants utilisent la
// version compilée du client tandis que les webhooks arrivent dans la version
// par défaut DU COMPTE : les deux divergent sans qu'aucun code ne change. C'est
// ce décalage qui a masqué un incident réel côté projet.
//
// ── UNE ÉCRITURE FINANCIÈRE N'EST PAS UNE ÉCRITURE DNS ──────────────────────
//
// Aucune reprise automatique sur une écriture, jamais — même sur 5xx, même sur
// 429. Stripe a pu encaisser avant de tomber. Et surtout : toute écriture porte
// une `Idempotency-Key` FOURNIE par l'appelant, jamais générée ici. Générer la
// clé au moment de l'appel la rendrait différente à chaque tentative, ce qui
// est exactement la façon de créer deux paiements pour un seul acte.
import logger from '../../../utils/logger.js';

/** Version épinglée — alignée sur le projet ET sur l'endpoint webhook. */
export const STRIPE_API_VERSION = '2025-02-24.acacia';

export const DEFAULT_TIMEOUT_MS = 20_000;

/** Issue d'une tentative. La troisième porte tout le risque financier. */
export const OUTCOMES = Object.freeze({
  DONE: 'DONE',
  FAILED: 'FAILED',
  /** On ne sait pas. L'argent a peut-être bougé. Aucune reprise automatique. */
  UNKNOWN: 'UNKNOWN',
});

export const TRANSPORT_CODES = Object.freeze({
  OK: 'OK',
  MISSING_CREDENTIALS: 'MISSING_CREDENTIALS',
  INPUT_INVALID: 'INPUT_INVALID',
  UNAUTHORIZED: 'UNAUTHORIZED',
  NOT_FOUND: 'NOT_FOUND',
  REJECTED: 'REJECTED',
  /** Même clé d'idempotence, paramètres différents — Stripe refuse, et il a raison. */
  IDEMPOTENCY_CONFLICT: 'IDEMPOTENCY_CONFLICT',
  RATE_LIMITED: 'RATE_LIMITED',
  PROVIDER_ERROR: 'PROVIDER_ERROR',
  MALFORMED_RESPONSE: 'MALFORMED_RESPONSE',
  TIMEOUT: 'TIMEOUT',
  UNREACHABLE: 'UNREACHABLE',
});

export class StripeTransportError extends Error {
  constructor(code, message, {
    httpStatus = null, stripeCode = null, requestId = null,
    retryable = false, outcome = OUTCOMES.FAILED, durationMs = null,
  } = {}) {
    super(message);
    this.name = 'StripeTransportError';
    this.code = code;
    this.httpStatus = httpStatus;
    /** `card_declined`, `idempotency_key_in_use`… Non secret, et actionnable. */
    this.stripeCode = stripeCode;
    /** `req_…` — la seule chose que le support Stripe demande. */
    this.requestId = requestId;
    this.retryable = retryable;
    this.outcome = outcome;
    this.durationMs = durationMs;
  }

  /** Rejouer cette erreur peut-il faire bouger de l'argent une seconde fois ? */
  get replaySafe() {
    return this.outcome === OUTCOMES.FAILED;
  }
}

/* -------------------------------------------------------------------------- */
/*  ENCODAGE                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Encodage `x-www-form-urlencoded` à la mode Stripe.
 *
 * `{ metadata: { a: 1 }, line_items: [{ price: 'x' }] }` devient
 * `metadata[a]=1&line_items[0][price]=x`. C'est la convention de l'API, et la
 * respecter à la main évite d'embarquer un SDK pour cette seule raison.
 *
 * `undefined` est OMIS, `null` transmis comme chaîne vide : Stripe distingue
 * « je ne dis rien » de « je vide le champ », et confondre les deux effacerait
 * une valeur qu'on voulait laisser en place.
 */
export function encodeForm(payload, prefix = '', out = []) {
  for (const [key, value] of Object.entries(payload ?? {})) {
    if (value === undefined) continue;
    const path = prefix ? `${prefix}[${key}]` : key;
    if (value === null) {
      out.push(`${encodeURIComponent(path)}=`);
    } else if (Array.isArray(value)) {
      value.forEach((item, index) => {
        if (item !== null && typeof item === 'object') encodeForm(item, `${path}[${index}]`, out);
        else out.push(`${encodeURIComponent(`${path}[${index}]`)}=${encodeURIComponent(String(item))}`);
      });
    } else if (typeof value === 'object') {
      encodeForm(value, path, out);
    } else {
      out.push(`${encodeURIComponent(path)}=${encodeURIComponent(String(value))}`);
    }
  }
  return out.join('&');
}

const stripSlash = (url) => String(url || '').replace(/\/+$/, '');

/**
 * Motifs de clés Stripe, reconnus À LA FORME.
 *
 * Même filet que la garde de pont (L4) : une clé peut voyager sous un nom
 * innocent, ou dans une phrase. Ici elle arrive dans le message d'erreur du
 * fournisseur — `Invalid API Key provided: sk_live_…`. Stripe caviarde
 * généralement la sienne, mais « généralement » n'est pas une garantie, et un
 * proxy intermédiaire ne caviarde rien du tout.
 */
const KEY_PATTERNS = Object.freeze([
  // Volontairement SANS frontière de mot : une clé collée à un guillemet, une
  // virgule ou un chemin doit être caviardée elle aussi. Trop caviarder ne
  // coûte qu'une phrase moins précise ; pas assez coûte une clé publiée.
  /(?:sk|rk)_(?:test|live)_[A-Za-z0-9]+/g,
  /pk_(?:test|live)_[A-Za-z0-9]+/g,
  /whsec_[A-Za-z0-9]+/g,
]);

/**
 * Message fournisseur repris dans un diagnostic : tronqué ET CAVIARDÉ.
 *
 * On garde le texte parce qu'il est souvent la seule explication utile
 * (« le montant doit être supérieur à 0.50 € »). On en retire ce qui ne doit
 * jamais voyager — le message part dans une réponse, un journal, un ticket.
 */
function safeMessage(message) {
  if (typeof message !== 'string') return '';
  let clean = message.trim();
  if (!clean) return '';
  for (const pattern of KEY_PATTERNS) clean = clean.replace(pattern, '«clé caviardée»');
  return clean.length > 300 ? `${clean.slice(0, 300)}…` : clean;
}

/**
 * Attente entre deux tentatives de LECTURE.
 *
 * Le minuteur n'est PAS `unref` : on est en train de l'attendre. Le détacher
 * dirait « ne garde pas le processus ouvert pour ça » alors que la suite du
 * code en dépend — et dans une boucle d'événements au repos, la reprise ne
 * partirait jamais. Le défaut est silencieux en production (un serveur tient la
 * boucle) et visible en test, ce qui est la pire des combinaisons.
 */
const backoff = (attempt) => new Promise((resolve) => {
  setTimeout(resolve, Math.min(2000, 250 * 2 ** (attempt - 1)));
});

/* -------------------------------------------------------------------------- */
/*  APPEL                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * @param {object} args
 * @param {{secretKey: string, baseUrl?: string}} args.credentials
 * @param {'GET'|'POST'} args.method
 * @param {string} args.path        chemin exact, ex. `/v1/invoices`
 * @param {object} [args.body]      encodé en form pour un POST
 * @param {object} [args.query]     encodé en query pour un GET
 * @param {string} [args.idempotencyKey]  OBLIGATOIRE sur un POST (voir plus bas)
 */
async function stripeFetch({
  credentials, method, path, body, query,
  idempotencyKey, timeoutMs = DEFAULT_TIMEOUT_MS, fetchImpl, retries = 0,
}) {
  if (!credentials?.secretKey) {
    throw new StripeTransportError(TRANSPORT_CODES.MISSING_CREDENTIALS, 'Clé secrète Stripe absente.');
  }
  const base = stripSlash(credentials.baseUrl) || 'https://api.stripe.com';
  const write = method !== 'GET';

  /**
   * UNE ÉCRITURE SANS CLÉ D'IDEMPOTENCE EST REFUSÉE ICI, PAS CHEZ STRIPE.
   *
   * Stripe accepte parfaitement un POST sans en-tête `Idempotency-Key` : il
   * crée alors un nouvel objet à chaque appel. C'est précisément le
   * comportement qu'on ne veut jamais pouvoir obtenir par oubli.
   */
  if (write && !idempotencyKey) {
    throw new StripeTransportError(
      TRANSPORT_CODES.INPUT_INVALID,
      'Écriture Stripe refusée : aucune clé d’idempotence fournie.',
    );
  }

  const url = query && Object.keys(query).length
    ? `${base}${path}?${encodeForm(query)}`
    : `${base}${path}`;

  const maxAttempts = 1 + (write ? 0 : retries);
  let attempt = 0;
  let lastError = null;

  while (attempt < maxAttempts) {
    attempt += 1;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const startedAt = Date.now();
    let response;
    try {
      response = await (fetchImpl ?? globalThis.fetch)(url, {
        method,
        headers: {
          Authorization: `Bearer ${credentials.secretKey}`,
          'Stripe-Version': STRIPE_API_VERSION,
          Accept: 'application/json',
          ...(write ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
          ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
        },
        body: write ? encodeForm(body ?? {}) : undefined,
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timer);
      const durationMs = Date.now() - startedAt;
      const timedOut = err?.name === 'AbortError';
      /**
       * LE CAS QUI JUSTIFIE TOUT LE LOT.
       *
       * Sur une écriture, le silence ne dit pas que rien n'a eu lieu : Stripe a
       * pu créer la session, encaisser, émettre la facture — et seule la
       * réponse s'est perdue. L'issue est INDÉCIDABLE. La convergence passe par
       * un rejeu de LA MÊME clé d'idempotence, jamais par un nouvel acte.
       */
      lastError = new StripeTransportError(
        timedOut ? TRANSPORT_CODES.TIMEOUT : TRANSPORT_CODES.UNREACHABLE,
        timedOut ? 'Stripe n’a pas répondu dans le délai imparti.' : 'Stripe injoignable.',
        { retryable: !write, outcome: write ? OUTCOMES.UNKNOWN : OUTCOMES.FAILED, durationMs },
      );
      if (!write && attempt < maxAttempts) {
        await backoff(attempt);
        continue;
      }
      throw lastError;
    }
    clearTimeout(timer);

    const durationMs = Date.now() - startedAt;
    const text = await response.text().catch(() => '');
    let json = null;
    if (text) {
      try {
        json = JSON.parse(text);
      } catch {
        json = null;
      }
    }
    const requestId = response.headers?.get?.('request-id')
      ?? response.headers?.get?.('x-request-id')
      ?? null;

    if (response.ok) {
      if (json === null) {
        // 2xx illisible : on ne peut ni confirmer ni infirmer une écriture.
        throw new StripeTransportError(
          TRANSPORT_CODES.MALFORMED_RESPONSE,
          'Stripe a répondu un corps illisible.',
          { httpStatus: response.status, requestId, outcome: write ? OUTCOMES.UNKNOWN : OUTCOMES.FAILED, durationMs },
        );
      }
      return { json, requestId, httpStatus: response.status, durationMs, attempts: attempt };
    }

    const error = classify(response.status, json, { requestId, durationMs, write });
    if (error.retryable && attempt < maxAttempts) {
      await backoff(attempt);
      lastError = error;
      continue;
    }
    throw error;
  }
  throw lastError ?? new StripeTransportError(TRANSPORT_CODES.PROVIDER_ERROR, 'Échec après plusieurs tentatives.');
}

/**
 * Traduit un refus Stripe. Toutes ces issues sont `FAILED` : Stripe a RÉPONDU,
 * donc il a tranché, donc rien n'a été encaissé — à une exception près, traitée
 * séparément parce qu'elle est le piège classique de l'idempotence.
 */
function classify(status, json, { requestId, durationMs, write }) {
  const error = json?.error ?? {};
  const stripeCode = error.code ?? error.type ?? null;
  const detail = safeMessage(error.message);
  const suffix = detail ? ` ${detail}` : '';
  const base = { httpStatus: status, stripeCode, requestId, durationMs, outcome: OUTCOMES.FAILED };

  /**
   * `idempotency_key_in_use` — DEUX APPELS CONCURRENTS, MÊME CLÉ.
   *
   * Stripe traite déjà une requête portant cette clé. Le second appelant ne
   * sait pas si elle aboutira : l'issue est INDÉCIDABLE pour lui. Le ranger
   * dans `FAILED` inviterait à recréer avec une clé neuve — c'est-à-dire à
   * doubler le paiement que la clé devait empêcher.
   */
  if (stripeCode === 'idempotency_key_in_use') {
    return new StripeTransportError(
      TRANSPORT_CODES.IDEMPOTENCY_CONFLICT,
      'Une opération portant cette clé d’idempotence est déjà en cours chez Stripe.',
      { ...base, retryable: false, outcome: OUTCOMES.UNKNOWN },
    );
  }
  /**
   * Même clé, paramètres DIFFÉRENTS. Stripe refuse — et il a raison : deux
   * actes distincts ne peuvent pas partager une identité. C'est un défaut de
   * construction de clé chez nous, pas un aléa.
   */
  if (stripeCode === 'idempotency_error') {
    return new StripeTransportError(
      TRANSPORT_CODES.IDEMPOTENCY_CONFLICT,
      'Clé d’idempotence déjà utilisée avec des paramètres différents.',
      { ...base, retryable: false },
    );
  }

  if (status === 401 || status === 403) {
    return new StripeTransportError(TRANSPORT_CODES.UNAUTHORIZED, `Stripe a refusé la clé (${status}).${suffix}`, {
      ...base, retryable: false,
    });
  }
  if (status === 404) {
    return new StripeTransportError(TRANSPORT_CODES.NOT_FOUND, `Ressource inconnue chez Stripe (404).${suffix}`, {
      ...base, retryable: false,
    });
  }
  if (status === 400 || status === 402 || status === 422) {
    return new StripeTransportError(TRANSPORT_CODES.REJECTED, `Stripe a refusé la requête (${status}).${suffix}`, {
      ...base, retryable: false,
    });
  }
  if (status === 429) {
    return new StripeTransportError(TRANSPORT_CODES.RATE_LIMITED, 'Stripe limite le débit (429).', {
      ...base, retryable: !write,
    });
  }
  if (status >= 500) {
    return new StripeTransportError(TRANSPORT_CODES.PROVIDER_ERROR, `Stripe est en erreur (${status}).`, {
      // Une écriture n'est JAMAIS réessayée automatiquement, même sur 5xx :
      // Stripe a pu encaisser avant de tomber.
      ...base, retryable: !write,
    });
  }
  return new StripeTransportError(TRANSPORT_CODES.PROVIDER_ERROR, `Stripe a répondu ${status}.${suffix}`, {
    ...base, retryable: false,
  });
}

/* -------------------------------------------------------------------------- */
/*  OPÉRATIONS — celles que l'audit a trouvées, et rien d'autre               */
/* -------------------------------------------------------------------------- */

/** `GET /v1/account` — prouve l'authentification sans rien créer. */
export async function describeAccount({ credentials, timeoutMs = DEFAULT_TIMEOUT_MS, fetchImpl }) {
  const res = await stripeFetch({ credentials, method: 'GET', path: '/v1/account', timeoutMs, fetchImpl, retries: 2 });
  return {
    ok: true,
    accountId: res.json?.id ?? null,
    country: res.json?.country ?? null,
    defaultCurrency: res.json?.default_currency ?? null,
    chargesEnabled: res.json?.charges_enabled ?? null,
    /**
     * `livemode` vient de Stripe, pas de nous : c'est la seule source qui dise
     * avec certitude dans quel monde la clé nous place. On le remonte pour que
     * la passerelle puisse le confronter à l'environnement qu'elle croyait
     * servir — une clé LIVE dans un Panel TEST doit se voir.
     */
    livemode: res.json?.livemode ?? null,
    requestId: res.requestId,
    durationMs: res.durationMs,
  };
}

/** `GET /v1/checkout/sessions/{id}` — lecture. */
export async function retrieveCheckoutSession({ credentials, sessionId, timeoutMs, fetchImpl }) {
  if (!sessionId) throw new StripeTransportError(TRANSPORT_CODES.INPUT_INVALID, 'Identifiant de session manquant.');
  const res = await stripeFetch({
    credentials, method: 'GET', path: `/v1/checkout/sessions/${encodeURIComponent(sessionId)}`,
    timeoutMs, fetchImpl, retries: 2,
  });
  return { session: res.json, requestId: res.requestId, durationMs: res.durationMs };
}

/** `GET /v1/subscriptions/{id}` — lecture. */
export async function retrieveSubscription({ credentials, subscriptionId, timeoutMs, fetchImpl }) {
  if (!subscriptionId) throw new StripeTransportError(TRANSPORT_CODES.INPUT_INVALID, 'Identifiant d’abonnement manquant.');
  const res = await stripeFetch({
    credentials, method: 'GET', path: `/v1/subscriptions/${encodeURIComponent(subscriptionId)}`,
    timeoutMs, fetchImpl, retries: 2,
  });
  return { subscription: res.json, requestId: res.requestId, durationMs: res.durationMs };
}

/** `GET /v1/invoices` — lecture, bornée. */
export async function listInvoices({ credentials, customer, subscription, limit = 100, timeoutMs, fetchImpl }) {
  if (!customer && !subscription) {
    throw new StripeTransportError(TRANSPORT_CODES.INPUT_INVALID, 'Un client ou un abonnement est requis.');
  }
  const res = await stripeFetch({
    credentials, method: 'GET', path: '/v1/invoices',
    query: { ...(customer ? { customer } : {}), ...(subscription ? { subscription } : {}), limit: Math.min(limit, 100) },
    timeoutMs, fetchImpl, retries: 2,
  });
  return { invoices: res.json?.data ?? [], hasMore: res.json?.has_more ?? false, requestId: res.requestId, durationMs: res.durationMs };
}

/**
 * `POST /v1/customers` — création d'un client (L6.2D).
 *
 * ÉCRITURE, donc clé d'idempotence OBLIGATOIRE : sans elle, un rejeu après un
 * doute réseau créerait un second client pour la même personne, et l'abonnement
 * suivant se rattacherait au mauvais. Réversible chez Stripe — un client se
 * supprime — mais un doublon non détecté ne se répare pas tout seul.
 */
export async function createCustomer({ credentials, params, idempotencyKey, timeoutMs, fetchImpl }) {
  const res = await stripeFetch({
    credentials, method: 'POST', path: '/v1/customers',
    body: params, idempotencyKey, timeoutMs, fetchImpl,
  });
  logger.info(`[stripe] customer créé — ${res.json?.id ?? '(sans id)'} (req ${res.requestId ?? '—'})`);
  return { outcome: OUTCOMES.DONE, customer: res.json, requestId: res.requestId, durationMs: res.durationMs };
}

/** `GET /v1/customers/{id}` — lecture INTERNE de reprise. Aucun effet. */
export async function retrieveCustomer({ credentials, customerId, timeoutMs, fetchImpl }) {
  const res = await stripeFetch({
    credentials, method: 'GET', path: `/v1/customers/${encodeURIComponent(customerId)}`,
    timeoutMs, fetchImpl, retries: 2,
  });
  return { outcome: OUTCOMES.DONE, customer: res.json, requestId: res.requestId, durationMs: res.durationMs };
}

/**
 * `POST /v1/checkout/sessions` — ÉCRITURE FINANCIÈRE.
 *
 * La clé d'idempotence est OBLIGATOIRE et vient de l'appelant : c'est elle, et
 * elle seule, qui garantit qu'un acte métier rejoué rend la MÊME session au
 * lieu d'en ouvrir une seconde.
 */
export async function createCheckoutSession({ credentials, params, idempotencyKey, timeoutMs, fetchImpl }) {
  const res = await stripeFetch({
    credentials, method: 'POST', path: '/v1/checkout/sessions',
    body: params, idempotencyKey, timeoutMs, fetchImpl,
  });
  logger.info(`[stripe] checkout.session créée — ${res.json?.id ?? '(sans id)'} (req ${res.requestId ?? '—'})`);
  return { outcome: OUTCOMES.DONE, session: res.json, requestId: res.requestId, durationMs: res.durationMs };
}

/**
 * `POST /v1/subscriptions/{id}` — ÉCRITURE FINANCIÈRE (résiliation différée).
 *
 * `cancel_at_period_end` ne rembourse rien et ne coupe rien immédiatement, mais
 * elle décide de ne plus prélever : c'est un engagement, pas une configuration.
 */
export async function cancelSubscriptionAtPeriodEnd({ credentials, subscriptionId, idempotencyKey, timeoutMs, fetchImpl }) {
  if (!subscriptionId) throw new StripeTransportError(TRANSPORT_CODES.INPUT_INVALID, 'Identifiant d’abonnement manquant.');
  const res = await stripeFetch({
    credentials, method: 'POST', path: `/v1/subscriptions/${encodeURIComponent(subscriptionId)}`,
    body: { cancel_at_period_end: true }, idempotencyKey, timeoutMs, fetchImpl,
  });
  return { outcome: OUTCOMES.DONE, subscription: res.json, requestId: res.requestId, durationMs: res.durationMs };
}

/**
 * Faut-il, et peut-on, réessayer ?
 *
 * Sur un provider financier, la seule reprise automatique admise est celle
 * d'une LECTURE. Toute écriture dont l'issue est inconnue relève de la
 * convergence par clé d'idempotence — jamais d'un nouvel acte.
 */
export function describeRetryDecision(error) {
  if (!(error instanceof StripeTransportError)) {
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
        ? 'ISSUE_INCONNUE_CONVERGENCE_PAR_CLÉ'
        : 'ECHEC_DEFINITIF',
  };
}

export default {
  createCustomer,
  retrieveCustomer,
  STRIPE_API_VERSION,
  DEFAULT_TIMEOUT_MS,
  OUTCOMES,
  TRANSPORT_CODES,
  StripeTransportError,
  encodeForm,
  describeAccount,
  retrieveCheckoutSession,
  retrieveSubscription,
  listInvoices,
  createCheckoutSession,
  cancelSubscriptionAtPeriodEnd,
  describeRetryDecision,
};
