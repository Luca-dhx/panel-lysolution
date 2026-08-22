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
  credentials, method, path, body, query, form,
  idempotencyKey, nonDurableWrite = false,
  timeoutMs = DEFAULT_TIMEOUT_MS, fetchImpl, retries = 0,
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
  /**
   * L'UNIQUE DÉROGATION, ET ELLE DOIT ÊTRE DEMANDÉE (L6.3B).
   *
   * Une clé d'idempotence protège en rendant la MÊME réponse à un rejeu. Cela
   * n'a de sens que si cette réponse reste utilisable — un client, un tarif,
   * une session de paiement le restent.
   *
   * Une session de PORTAIL, non : elle est à usage unique et expire. Lui poser
   * une clé rendrait à un client revenu deux heures plus tard exactement la
   * même URL — c'est-à-dire une URL morte, avec un message d'erreur Stripe
   * pour toute explication. La « protection » produirait la panne.
   *
   * La dérogation est donc EXPLICITE — un appelant doit la demander, jamais
   * l'obtenir par omission — et elle n'est légitime que pour un acte qui ne
   * crée rien de durable et qui expire seul. Une garde statique vérifie qu'un
   * seul verbe du transport la réclame.
   *
   * Le vrai risque de ces actes-là — le double clic — ne se traite pas ici : il
   * se traite là où il se produit, en empêchant la seconde soumission.
   */
  if (write && !idempotencyKey && !nonDurableWrite) {
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
 * `GET /v1/invoices/{id}` — LECTURE d'une facture (L6.3B).
 *
 * Sans effet, donc rejouable sans précaution. L'appelant a déjà prouvé qu'il
 * possède le CLIENT ; c'est lui qui vérifiera ensuite que la facture rendue
 * appartient bien à ce client — le transport ne juge de rien.
 */
export async function retrieveInvoice({ credentials, invoiceId, timeoutMs, fetchImpl }) {
  const res = await stripeFetch({
    credentials, method: 'GET', path: `/v1/invoices/${encodeURIComponent(invoiceId)}`,
    timeoutMs, fetchImpl, retries: 2,
  });
  return { outcome: OUTCOMES.DONE, invoice: res.json, requestId: res.requestId, durationMs: res.durationMs };
}

/**
 * `POST /v1/invoices/{id}/pay` — RETENTER LA COLLECTE D’UNE FACTURE EXISTANTE.
 *
 * ══ CE QUE CE VERBE FAIT, ET SURTOUT CE QU’IL NE FAIT PAS ══════════════════
 *
 * Il demande à Stripe de tenter MAINTENANT le prélèvement de la facture déjà
 * émise, avec le moyen de paiement déjà attaché au client. Il ne crée ni
 * facture, ni abonnement, ni session de paiement : la créance existe, seule
 * la tentative est nouvelle.
 *
 * ══ POURQUOI IL N’EXISTAIT PAS JUSQU’ICI ═══════════════════════════════════
 *
 * Parce que STRIPE EST L’ORDONNANCEUR des tentatives automatiques, et que
 * ce parc s’interdit d’en programmer. Ce verbe ne rompt pas cette règle : il
 * ne PROGRAMME rien. C’est une tentative UNIQUE, déclenchée par un humain qui
 * a une raison de croire que le moyen de paiement fonctionne à nouveau —
 * typiquement parce que le client vient de l’appeler.
 *
 * ══ L’IDEMPOTENCE EST INDISPENSABLE ICI ════════════════════════════════════
 *
 * Deux clics sur un bouton « Nouvelle tentative » ne doivent pas produire
 * deux prélèvements. La clé est fournie par l’appelant et dérivée de l’état
 * de la facture : même état, même clé, une seule tentative.
 */
export async function payInvoice({ credentials, invoiceId, idempotencyKey, timeoutMs, fetchImpl }) {
  const res = await stripeFetch({
    credentials,
    method: 'POST',
    path: `/v1/invoices/${encodeURIComponent(invoiceId)}/pay`,
    /**
     * AUCUN paramètre. Ni montant, ni moyen de paiement, ni devise : tout est
     * déjà porté par la facture et par le client. En envoyer relancerait le
     * débat sur « combien » au moment le plus mauvais.
     */
    body: {},
    idempotencyKey,
    timeoutMs,
    fetchImpl,
    /**
     * AUCUN RÉESSAI DE TRANSPORT. Une tentative de collecte qui n’a pas
     * répondu a PEUT-ÊTRE abouti : la rejouer d’office risquerait le double
     * débit que toute cette doctrine existe pour empêcher. L’issue
     * indéterminée est rendue telle quelle.
     */
    retries: 0,
  });
  return {
    outcome: OUTCOMES.DONE, invoice: res.json,
    requestId: res.requestId, durationMs: res.durationMs,
  };
}

/**
 * `POST /v1/billing_portal/sessions` — LE PORTAIL CLIENT (L6.3B).
 *
 * ══ POURQUOI AUCUNE CLÉ D'IDEMPOTENCE ══════════════════════════════════════
 *
 * C'est une écriture, et pourtant elle n'en porte pas — seule écriture du
 * transport dans ce cas, et c'est délibéré.
 *
 * Une session de portail est ÉPHÉMÈRE et à usage unique : elle expire, et une
 * fois suivie elle ne se rejoue pas. Une clé d'idempotence rendrait donc la
 * MÊME session à un client revenu une heure plus tard — c'est-à-dire une URL
 * morte, avec un message d'erreur Stripe pour toute explication.
 *
 * Elle ne crée par ailleurs aucun objet durable et ne déplace aucun argent :
 * la rejouer coûte un appel, pas un doublon. Le vrai risque — le double clic —
 * se traite en amont, là où il se produit.
 *
 * PRÉREQUIS : le portail doit être activé une fois dans le tableau de bord
 * Stripe, par mode. Sans cela Stripe refuse la création, et l'erreur est
 * remontée telle quelle plutôt que masquée.
 */
export async function createBillingPortalSession({ credentials, customer, returnUrl, timeoutMs, fetchImpl }) {
  if (!customer) {
    throw new StripeTransportError(TRANSPORT_CODES.INPUT_INVALID, 'Client requis pour ouvrir le portail.');
  }
  const res = await stripeFetch({
    credentials, method: 'POST', path: '/v1/billing_portal/sessions',
    body: { customer, ...(returnUrl ? { return_url: returnUrl } : {}) },
    nonDurableWrite: true,
    timeoutMs, fetchImpl,
  });
  return { outcome: OUTCOMES.DONE, session: res.json, requestId: res.requestId, durationMs: res.durationMs };
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

/**
 * `POST /v1/products` — le CONTENANT d'un tarif (L6.2E).
 *
 * Un Product ne porte aucun montant : il nomme ce qu'on vend. C'est le Price
 * qui porte les termes commerciaux, et c'est lui qui est immuable.
 */
export async function createProduct({ credentials, params, idempotencyKey, timeoutMs, fetchImpl }) {
  const res = await stripeFetch({
    credentials, method: 'POST', path: '/v1/products',
    body: params, idempotencyKey, timeoutMs, fetchImpl,
  });
  logger.info(`[stripe] product créé — ${res.json?.id ?? '(sans id)'} (req ${res.requestId ?? '—'})`);
  return { outcome: OUTCOMES.DONE, product: res.json, requestId: res.requestId, durationMs: res.durationMs };
}

/**
 * `POST /v1/prices` — LES TERMES COMMERCIAUX, et ils sont IMMUABLES.
 *
 * Stripe interdit de modifier le montant, la devise ou la périodicité d'un Price
 * existant : changer de tarif, c'est en créer un autre. Cette contrainte du
 * fournisseur est aussi la bonne sémantique métier — un abonnement souscrit à
 * 249 € doit continuer de référencer 249 €, quoi qu'il advienne du catalogue.
 *
 * On ne l'affronte donc jamais : il n'existe volontairement aucune primitive de
 * mise à jour de Price dans ce transport.
 */
export async function createPrice({ credentials, params, idempotencyKey, timeoutMs, fetchImpl }) {
  const res = await stripeFetch({
    credentials, method: 'POST', path: '/v1/prices',
    body: params, idempotencyKey, timeoutMs, fetchImpl,
  });
  logger.info(`[stripe] price créé — ${res.json?.id ?? '(sans id)'} (req ${res.requestId ?? '—'})`);
  return { outcome: OUTCOMES.DONE, price: res.json, requestId: res.requestId, durationMs: res.durationMs };
}

/** `GET /v1/prices/{id}` — lecture INTERNE de reprise. Aucun effet. */
export async function retrievePrice({ credentials, priceId, timeoutMs, fetchImpl }) {
  const res = await stripeFetch({
    credentials, method: 'GET', path: `/v1/prices/${encodeURIComponent(priceId)}`,
    timeoutMs, fetchImpl, retries: 2,
  });
  return { outcome: OUTCOMES.DONE, price: res.json, requestId: res.requestId, durationMs: res.durationMs };
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
 * `POST /v1/customers/{id}` — MISE À JOUR de l'identité de facturation.
 *
 * ══ POURQUOI CE VERBE MANQUAIT, ET CE QUE SON ABSENCE COÛTAIT ═══════════════
 *
 * Le client Stripe était créé UNE fois, à la première facturation d'un contrat,
 * et plus jamais relu en écriture. Conséquence directe : une entreprise cliente
 * rattachée APRÈS l'ouverture du contrat, ou dont l'adresse est corrigée
 * ensuite, ne parvenait jamais chez le fournisseur. Les factures suivantes
 * portaient l'identité du premier jour — c'est-à-dire, pour tout le parc
 * antérieur, la RÉFÉRENCE DE CONTRAT en guise de raison sociale.
 *
 * ══ POURQUOI UNE CLÉ D'IDEMPOTENCE MALGRÉ TOUT ═════════════════════════════
 *
 * Une mise à jour est idempotente par nature — la rejouer écrit la même chose.
 * La clé n'est donc pas là pour empêcher un doublon : elle est là parce que le
 * transport REFUSE toute écriture sans elle, et que cette règle ne doit pas
 * connaître d'exception de confort. La dérogation `nonDurableWrite` existe pour
 * les actes qui EXPIRENT, ce qui n'est pas le cas ici.
 *
 * La clé porte l'EMPREINTE de ce qu'on écrit (voir l'appelant) : deux
 * corrections successives sont deux actes distincts, et la seconde ne doit pas
 * se voir répondre le résultat de la première.
 */
export async function updateCustomer({ credentials, customerId, params, idempotencyKey, timeoutMs, fetchImpl }) {
  if (!customerId) throw new StripeTransportError(TRANSPORT_CODES.INPUT_INVALID, 'Identifiant de client manquant.');
  const res = await stripeFetch({
    credentials, method: 'POST', path: `/v1/customers/${encodeURIComponent(customerId)}`,
    body: params, idempotencyKey, timeoutMs, fetchImpl,
  });
  logger.info(`[stripe] customer mis à jour — ${res.json?.id ?? '(sans id)'} (req ${res.requestId ?? '—'})`);
  return { outcome: OUTCOMES.DONE, customer: res.json, requestId: res.requestId, durationMs: res.durationMs };
}

/**
 * `GET /v1/customers/{id}/tax_ids` — les identifiants fiscaux d'un client.
 *
 * Lecture de CONVERGENCE : on ne crée un identifiant que si le bon n'est pas
 * déjà là. Stripe accepte plusieurs `tax_id` par client et ne déduplique pas —
 * sans cette lecture, chaque passage en ajouterait un, et la facture finirait
 * par afficher le même numéro de TVA cinq fois.
 */
export async function listCustomerTaxIds({ credentials, customerId, timeoutMs, fetchImpl }) {
  const res = await stripeFetch({
    credentials, method: 'GET', path: `/v1/customers/${encodeURIComponent(customerId)}/tax_ids`,
    query: { limit: 20 }, timeoutMs, fetchImpl, retries: 2,
  });
  return { outcome: OUTCOMES.DONE, taxIds: res.json?.data ?? [], requestId: res.requestId, durationMs: res.durationMs };
}

/**
 * `POST /v1/customers/{id}/tax_ids` — le numéro de TVA du CLIENT.
 *
 * ══ CE QUE CET OBJET CHANGE SUR LA FACTURE ══════════════════════════════════
 *
 * C'est le SEUL emplacement que Stripe réserve au numéro de TVA de l'acheteur
 * sur une facture. Le mettre dans `metadata` ou dans une ligne d'adresse ne
 * l'imprimerait nulle part : la mention obligatoire manquerait, alors même que
 * la donnée serait chez le fournisseur.
 *
 * ══ POURQUOI L'ÉCHEC EST TOLÉRÉ PAR L'APPELANT ═════════════════════════════
 *
 * Stripe VALIDE le format d'un `tax_id` et refuse ce qu'il ne reconnaît pas.
 * Un refus signifie « ce numéro ne ressemble pas à un numéro français » — c'est
 * une information, pas une raison d'empêcher un client de payer. L'appelant
 * journalise et poursuit : la facture partira sans le numéro de TVA de
 * l'acheteur, ce qui est exactement l'état d'avant ce lot.
 */
export async function createCustomerTaxId({ credentials, customerId, type, value, idempotencyKey, timeoutMs, fetchImpl }) {
  const res = await stripeFetch({
    credentials, method: 'POST', path: `/v1/customers/${encodeURIComponent(customerId)}/tax_ids`,
    body: { type, value }, idempotencyKey, timeoutMs, fetchImpl,
  });
  return { outcome: OUTCOMES.DONE, taxId: res.json, requestId: res.requestId, durationMs: res.durationMs };
}

/**
 * `GET /v1/tax_rates` — le catalogue des taux déclarés sur le compte.
 *
 * Un TaxRate Stripe est IMMUABLE sur ses termes (pourcentage, inclusif ou non,
 * pays) : on ne le modifie jamais, on le retrouve ou on en crée un autre. Cette
 * lecture est donc la première barrière de convergence — sans elle, chaque
 * paiement créerait un nouveau « TVA 20 % » et le tableau de bord Stripe
 * deviendrait illisible en quelques semaines.
 */
export async function listTaxRates({ credentials, limit = 100, timeoutMs, fetchImpl }) {
  const res = await stripeFetch({
    credentials, method: 'GET', path: '/v1/tax_rates',
    query: { limit, active: true }, timeoutMs, fetchImpl, retries: 2,
  });
  return { outcome: OUTCOMES.DONE, taxRates: res.json?.data ?? [], requestId: res.requestId, durationMs: res.durationMs };
}

/**
 * `POST /v1/tax_rates` — déclare un taux de TVA sur le compte.
 *
 * ══ POURQUOI UN OBJET DÉDIÉ PLUTÔT QUE `automatic_tax` ══════════════════════
 *
 * `automatic_tax` délègue à Stripe Tax le CALCUL du taux à partir de l'adresse
 * du client. C'est un produit payant, qui exige une adresse validée et une
 * inscription fiscale déclarée par juridiction — et qui déciderait, seul, du
 * taux appliqué à une prestation. Or le taux vient déjà d'ailleurs : il est
 * écrit dans le CONTRAT, il a été accepté par le client, et c'est lui qui doit
 * figurer sur la facture. Laisser un tiers le recalculer, c'est accepter qu'il
 * en trouve un autre.
 *
 * Un `TaxRate` explicite, `inclusive: false`, appliqué à un montant HORS TAXE,
 * produit exactement la ventilation attendue — « 79,99 € HT · TVA 20 % 16,00 €
 * · 95,99 € TTC » — sans qu'aucune décision fiscale ne quitte le contrat.
 */
export async function createTaxRate({ credentials, params, idempotencyKey, timeoutMs, fetchImpl }) {
  const res = await stripeFetch({
    credentials, method: 'POST', path: '/v1/tax_rates',
    body: params, idempotencyKey, timeoutMs, fetchImpl,
  });
  logger.info(`[stripe] tax_rate créé — ${res.json?.id ?? '(sans id)'} (req ${res.requestId ?? '—'})`);
  return { outcome: OUTCOMES.DONE, taxRate: res.json, requestId: res.requestId, durationMs: res.durationMs };
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
 * `DELETE /v1/subscriptions/{id}` — RÉSILIATION IMMÉDIATE (L6.2G).
 *
 * ══ CE QUE STRIPE FAIT, ET CE QU'IL NE FAIT PAS ═════════════════════════════
 *
 * Il coupe l'abonnement séance tenante : plus aucun prélèvement, `status`
 * devient `canceled`, et l'objet reste lisible pour toujours.
 *
 * Ce qu'il ne fait PAS, c'est accepter deux fois. Résilier un abonnement déjà
 * `canceled` rend une erreur — la mutation n'est donc pas convergente chez le
 * fournisseur, contrairement au drapeau de fin de période.
 *
 * ══ POURQUOI CETTE ÉCRITURE PORTE QUAND MÊME UNE CLÉ ════════════════════════
 *
 * Le code historique du projet n'en passait AUCUNE (défaut relevé en L6.1, et
 * confirmé à chaque lot depuis). Deux clics, un rejeu HTTP ou un redémarrage
 * produisaient donc deux appels réels, dont le second échouait bruyamment — au
 * mieux. La clé rend le rejeu de la MÊME intention silencieux et sûr.
 *
 * Elle ne suffit pourtant pas : la fenêtre d'idempotence de Stripe est bornée.
 * Au-delà, c'est l'ÉTAT de l'abonnement qui tranche — et pour une résiliation,
 * il tranche sans ambiguïté. Voir `stripeSubscriptionCancellation.js`.
 */
export async function cancelSubscriptionNow({ credentials, subscriptionId, idempotencyKey, timeoutMs, fetchImpl }) {
  if (!subscriptionId) throw new StripeTransportError(TRANSPORT_CODES.INPUT_INVALID, 'Identifiant d’abonnement manquant.');
  const res = await stripeFetch({
    credentials, method: 'DELETE', path: `/v1/subscriptions/${encodeURIComponent(subscriptionId)}`,
    idempotencyKey, timeoutMs, fetchImpl,
  });
  logger.info(`[stripe] abonnement résilié immédiatement — ${res.json?.id ?? '(sans id)'} (req ${res.requestId ?? '—'})`);
  return { outcome: OUTCOMES.DONE, subscription: res.json, requestId: res.requestId, durationMs: res.durationMs };
}

/* ── L10.4 — LE REMBOURSEMENT ─────────────────────────────────────────────── */

/**
 * `GET /v1/payment_intents/{id}` — lecture, charge étendue.
 *
 * `expand[]=latest_charge` évite un second aller-retour : c'est la charge, non
 * l'intention, qui porte le reçu Stripe — le seul document que le fournisseur
 * réédite après un remboursement.
 */
export async function retrievePaymentIntent({ credentials, paymentIntentId, timeoutMs, fetchImpl }) {
  if (!paymentIntentId) {
    throw new StripeTransportError(TRANSPORT_CODES.INPUT_INVALID, 'Identifiant de paiement manquant.');
  }
  const res = await stripeFetch({
    credentials, method: 'GET', path: `/v1/payment_intents/${encodeURIComponent(paymentIntentId)}`,
    query: { expand: ['latest_charge'] }, timeoutMs, fetchImpl, retries: 2,
  });
  return { paymentIntent: res.json, requestId: res.requestId, durationMs: res.durationMs };
}

/* ── L13 — L'ÉCRITURE DE SOLDE, DONC LE FRAIS RÉEL ───────────────────────── */

/**
 * `GET /v1/payment_intents/{id}` — intention, débit ET écriture de solde.
 *
 * ══ POURQUOI UNE LECTURE DE PLUS PLUTÔT QU'UN `expand` SUR LA PRÉCÉDENTE ════
 *
 * `retrievePaymentIntent` sert le remboursement, et un remboursement est la
 * plus irréversible des écritures du parc. Élargir son `expand` aurait changé
 * la charge utile d'un chemin financier éprouvé pour le confort d'un autre —
 * un couplage qu'on paierait le jour où Stripe modifiera l'objet imbriqué.
 *
 * ══ DEUX NIVEAUX D'`expand`, ET C'EST LE MINIMUM ════════════════════════════
 *
 * Le frais ne vit ni sur l'intention ni sur la facture : il vit sur la
 * `balance_transaction` du DÉBIT. Sans le double `expand`, il faudrait trois
 * allers-retours (intention → débit → écriture) là où un seul suffit — trois
 * fois plus d'occasions qu'une convergence s'interrompe au milieu.
 *
 * ══ C'EST UNE LECTURE, DONC ELLE SE REJOUE ══════════════════════════════════
 *
 * `retries: 2` comme les autres lectures. Aucun euro ne bouge ici : la seule
 * conséquence d'un rejeu est un appel de plus.
 */
export async function retrievePaymentSettlement({
  credentials, paymentIntentId, timeoutMs, fetchImpl,
}) {
  if (!paymentIntentId) {
    throw new StripeTransportError(TRANSPORT_CODES.INPUT_INVALID, 'Identifiant de paiement manquant.');
  }
  const res = await stripeFetch({
    credentials, method: 'GET', path: `/v1/payment_intents/${encodeURIComponent(paymentIntentId)}`,
    query: { expand: ['latest_charge.balance_transaction'] },
    timeoutMs, fetchImpl, retries: 2,
  });
  return { paymentIntent: res.json, requestId: res.requestId, durationMs: res.durationMs };
}

/**
 * `GET /v1/charges/{id}` — le débit, écriture de solde étendue.
 *
 * Le repli quand un fait ne porte PAS d'intention : c'est le cas des débits
 * anciens, et de ceux qu'une version d'API a cessé de rattacher à plat. Un
 * remboursement, lui, désigne toujours son débit — c'est par ici qu'il trouve
 * son écriture.
 */
export async function retrieveChargeSettlement({
  credentials, chargeId, timeoutMs, fetchImpl,
}) {
  if (!chargeId) {
    throw new StripeTransportError(TRANSPORT_CODES.INPUT_INVALID, 'Identifiant de débit manquant.');
  }
  const res = await stripeFetch({
    credentials, method: 'GET', path: `/v1/charges/${encodeURIComponent(chargeId)}`,
    query: { expand: ['balance_transaction'] },
    timeoutMs, fetchImpl, retries: 2,
  });
  return { charge: res.json, requestId: res.requestId, durationMs: res.durationMs };
}

/**
 * `GET /v1/invoices/{id}` — LA FACTURE, POUR RETROUVER SON RÈGLEMENT.
 *
 * ══ LE DÉFAUT OBSERVÉ EN RECETTE RÉELLE, ET IL EST LE MÊME QU'EN L10.7 ══════
 *
 * Le compte de recette émet ses webhooks en `2026-06-24.dahlia`. Dans cette
 * version, un `invoice.paid` ne porte NI `charge`, NI `payment_intent`, NI même
 * `payments.data` — la sous-liste arrive vide, elle exige une expansion. Le
 * fait normalisé n'avait donc AUCUNE référence de règlement, et la capture des
 * frais rendait honnêtement `NO_PAYMENT_REFERENCE` : il n'y avait rien à
 * suivre.
 *
 * C'est exactement le défaut que L10.7 a déjà rencontré sur `invoice.payment_intent`,
 * et la leçon est la même : **ne pas dépendre du champ qu'un webhook expose**.
 * Ce que le Panel possède à coup sûr, c'est l'identité CANONIQUE du fait — la
 * facture. Il la relit donc chez le fournisseur, avec SA propre version d'API
 * épinglée, où le règlement est présent.
 *
 * ══ POURQUOI L'EXPANSION, ET POURQUOI CELLE-LÀ ══════════════════════════════
 *
 * `payments.data.payment.payment_intent` est l'emplacement des versions
 * récentes ; `charge` et `payment_intent` à plat sont ceux des anciennes. On
 * demande l'expansion et l'on lit les trois — la relecture est une lecture, son
 * coût est un appel, et son absence coûterait une commission manquante.
 */
export async function retrieveInvoicePayment({ credentials, invoiceId, timeoutMs, fetchImpl }) {
  if (!invoiceId) {
    throw new StripeTransportError(TRANSPORT_CODES.INPUT_INVALID, 'Identifiant de facture manquant.');
  }
  const res = await stripeFetch({
    credentials, method: 'GET', path: `/v1/invoices/${encodeURIComponent(invoiceId)}`,
    query: { expand: ['payments.data.payment.payment_intent'] },
    timeoutMs, fetchImpl, retries: 2,
  });
  return { invoice: res.json, requestId: res.requestId, durationMs: res.durationMs };
}

/**
 * `GET /v1/refunds/{id}` — le remboursement et SON écriture de solde.
 *
 * Un remboursement produit sa PROPRE `balance_transaction`, distincte de celle
 * du débit : montant négatif, et un `fee` qui dit — c'est tout l'enjeu — si le
 * fournisseur a rendu sa commission ou l'a gardée. Le Panel ne suppose ni l'un
 * ni l'autre : il lit.
 */
export async function retrieveRefundSettlement({
  credentials, refundId, timeoutMs, fetchImpl,
}) {
  if (!refundId) {
    throw new StripeTransportError(TRANSPORT_CODES.INPUT_INVALID, 'Identifiant de remboursement manquant.');
  }
  const res = await stripeFetch({
    credentials, method: 'GET', path: `/v1/refunds/${encodeURIComponent(refundId)}`,
    query: { expand: ['balance_transaction'] },
    timeoutMs, fetchImpl, retries: 2,
  });
  return { refund: res.json, requestId: res.requestId, durationMs: res.durationMs };
}

/**
 * `GET /v1/refunds` — LA LECTURE QUI PORTE LA CONVERGENCE DURABLE.
 *
 * Elle sert deux questions que rien d'autre ne tranche : combien ce paiement
 * a-t-il déjà rendu, et l'un de ces remboursements est-il DÉJÀ le nôtre — celui
 * qu'on s'apprête à demander sous cette identité (`stripeRefundAuthority`).
 *
 * La borne de 100 est celle de Stripe. Au-delà, la somme serait fausse et le
 * restant remboursable surévalué : l'appelant reçoit `truncated` et doit
 * refuser d'affirmer plutôt que de rembourser à l'aveugle. Cent
 * remboursements sur un même paiement n'a jamais de cause légitime.
 */
export async function listRefunds({ credentials, paymentIntentId, limit = 100, timeoutMs, fetchImpl }) {
  if (!paymentIntentId) {
    throw new StripeTransportError(TRANSPORT_CODES.INPUT_INVALID, 'Identifiant de paiement manquant.');
  }
  const res = await stripeFetch({
    credentials, method: 'GET', path: '/v1/refunds',
    query: { payment_intent: paymentIntentId, limit: Math.min(limit, 100) },
    timeoutMs, fetchImpl, retries: 2,
  });
  const data = Array.isArray(res.json?.data) ? res.json.data : null;
  return {
    refunds: data,
    truncated: res.json?.has_more === true,
    requestId: res.requestId,
    durationMs: res.durationMs,
  };
}

/**
 * `POST /v1/refunds` — L'ÉCRITURE FINANCIÈRE LA MOINS RÉVERSIBLE DU PARC.
 *
 * ══ CE QUE STRIPE GARANTIT, ET CE QU'IL NE GARANTIT PAS ═════════════════════
 *
 * Il garantit qu'on ne rendra jamais plus que ce qui a été encaissé : au-delà,
 * il refuse. C'est la seule protection ATOMIQUE contre deux remboursements
 * partiels concurrents — notre calcul du restant est une courtoisie
 * d'interface, jamais un verrou. Deux opérateurs qui cliquent en même temps
 * verront le second refus venir du fournisseur, et c'est correct.
 *
 * Il ne garantit PAS, en revanche, de refuser un second remboursement partiel
 * identique : deux fois 100 € sur 500 € encaissés sont deux actes parfaitement
 * valides. La clé d'idempotence protège la fenêtre courte ; au-delà, seule
 * `metadata[ly_operation_id]` permet de reconnaître notre propre acte. Elle est
 * donc APPOSÉE ICI, et son absence rendrait tout rejeu tardif dangereux.
 *
 * ══ LE MONTANT ══════════════════════════════════════════════════════════════
 *
 * `amountCents` absent = remboursement TOTAL du restant, décidé par Stripe.
 * On ne calcule pas le total nous-mêmes pour l'envoyer : entre notre lecture et
 * l'écriture, un autre remboursement a pu passer, et un montant figé
 * échouerait là où l'omission converge.
 */
export async function createRefund({
  credentials, paymentIntentId, amountCents, reason, metadata,
  idempotencyKey, timeoutMs, fetchImpl,
}) {
  if (!paymentIntentId) {
    throw new StripeTransportError(TRANSPORT_CODES.INPUT_INVALID, 'Identifiant de paiement manquant.');
  }
  if (amountCents !== undefined && amountCents !== null
    && (!Number.isInteger(amountCents) || amountCents <= 0)) {
    throw new StripeTransportError(TRANSPORT_CODES.INPUT_INVALID, 'Montant de remboursement invalide.');
  }

  const res = await stripeFetch({
    credentials, method: 'POST', path: '/v1/refunds',
    body: {
      payment_intent: paymentIntentId,
      ...(Number.isInteger(amountCents) ? { amount: amountCents } : {}),
      ...(reason ? { reason } : {}),
      ...(metadata && Object.keys(metadata).length ? { metadata } : {}),
    },
    idempotencyKey, timeoutMs, fetchImpl,
  });
  logger.info(
    `[stripe] remboursement émis — ${res.json?.id ?? '(sans id)'} `
    + `sur ${paymentIntentId} (req ${res.requestId ?? '—'})`,
  );
  return { outcome: OUTCOMES.DONE, refund: res.json, requestId: res.requestId, durationMs: res.durationMs };
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
  cancelSubscriptionNow,
  createCustomer,
  retrieveCustomer,
  updateCustomer,
  listCustomerTaxIds,
  createCustomerTaxId,
  listTaxRates,
  createTaxRate,
  createProduct,
  createPrice,
  retrievePrice,
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
