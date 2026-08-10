// FRONTIÈRE HOSTINGER — la seule porte du Panel vers l'API Hostinger (L9).
//
// docs/architecture/HOSTINGER_CONTROL_PLANE.md §« Adaptateur ».
//
// ── TROIS ENDPOINTS, ET PAS UN DE PLUS ──────────────────────────────────────
//
//   GET  /api/domains/v1/portfolio      les domaines du compte
//   GET  /api/dns/v1/zones/{zone}       les enregistrements d'une zone
//   PUT  /api/dns/v1/zones/{zone}       l'upsert — la SEULE écriture
//
// L'API Hostinger en expose une trentaine (VPS, facturation, hébergement
// d'agence, snapshots, reset de zone, verrou de domaine…). L'inventaire du
// 2026-08-10 montre que le parc n'en appelle que trois. Les autres ne sont pas
// « pas encore branchées » : elles n'ont aucun usage, et une frontière qui les
// exposerait offrirait un pouvoir que personne n'a demandé — dont
// `POST /zones/{zone}/reset`, qui efface une zone entière.
//
// ── LE RETRY EST UNE DÉCISION, PAS UN RÉGLAGE ───────────────────────────────
//
// GET : réessayé sur 429/5xx, avec back-off. Relire est gratuit.
// PUT : JAMAIS réessayé. L'API ne documente aucune clé d'idempotence, et un
// upsert rejoué après un silence peut écraser un enregistrement qu'un humain
// vient de corriger entre-temps. Le rejeu d'une écriture d'infrastructure est
// un arbitrage, pas un automatisme.
//
// ── « JE NE SAIS PAS » EST UN RÉSULTAT ──────────────────────────────────────
//
// Un délai dépassé sur le PUT ne dit pas que l'enregistrement n'a pas été
// écrit : la requête a pu aboutir et seule la réponse se perdre. On rend donc
// `outcome: UNKNOWN`, distinct de `FAILED` — même invariant qu'en L8, et pour
// la même raison : sans lui, un appelant rejoue et écrase.
import logger from '../../../utils/logger.js';

export const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_GET_RETRIES = 2;

/** Issue d'une tentative. La troisième est la raison d'être du module. */
export const OUTCOMES = Object.freeze({
  DONE: 'DONE',
  FAILED: 'FAILED',
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

export class HostingerTransportError extends Error {
  constructor(code, message, { httpStatus = null, correlationId = null, retryable = false, outcome = OUTCOMES.FAILED, durationMs = null } = {}) {
    super(message);
    this.name = 'HostingerTransportError';
    this.code = code;
    this.httpStatus = httpStatus;
    /**
     * L'identifiant de corrélation d'Hostinger. Non secret, et c'est la seule
     * chose qu'un support fournisseur demande — le perdre transforme un
     * incident en enquête.
     */
    this.correlationId = correlationId;
    this.retryable = retryable;
    this.outcome = outcome;
    this.durationMs = durationMs;
  }

  /** Rejouer cette erreur peut-il écraser quelque chose ? */
  get replaySafe() {
    return this.outcome === OUTCOMES.FAILED;
  }
}

const stripSlash = (url) => String(url || '').replace(/\/+$/, '');

/** Message fournisseur tronqué. Hostinger n'écho jamais le jeton. */
function safeMessage(message) {
  if (typeof message !== 'string') return '';
  const clean = message.trim();
  if (!clean) return '';
  return clean.length > 300 ? `${clean.slice(0, 300)}…` : clean;
}

const backoff = (attempt) => new Promise((resolve) => {
  const timer = setTimeout(resolve, Math.min(2000, 200 * 2 ** (attempt - 1)));
  timer.unref?.();
});

/**
 * Appel HTTP borné. `fetchImpl` est injectable : les tests ne sortent jamais
 * sur le réseau, et un test qui remplacerait `globalThis.fetch` contaminerait
 * les suivants.
 */
async function hostingerFetch({ credentials, method, path, body, timeoutMs, fetchImpl, retries }) {
  if (!credentials?.apiToken) {
    throw new HostingerTransportError(TRANSPORT_CODES.MISSING_CREDENTIALS, 'Jeton d’API Hostinger absent.');
  }
  const base = stripSlash(credentials.baseUrl);
  if (!base) {
    throw new HostingerTransportError(TRANSPORT_CODES.MISSING_CREDENTIALS, 'URL de base Hostinger absente.');
  }

  const maxAttempts = 1 + (retries ?? 0);
  let attempt = 0;
  let lastError = null;

  while (attempt < maxAttempts) {
    attempt += 1;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const startedAt = Date.now();
    let response;
    try {
      response = await (fetchImpl ?? globalThis.fetch)(`${base}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${credentials.apiToken}`,
          Accept: 'application/json',
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timer);
      const durationMs = Date.now() - startedAt;
      const timedOut = err?.name === 'AbortError';
      /**
       * Le silence n'a pas la même signification selon le verbe.
       *
       * Sur un GET, rien n'a changé : c'est un échec franc, et réessayer est
       * sans conséquence. Sur un PUT, l'enregistrement a PEUT-ÊTRE été écrit —
       * l'issue est indécidable, et personne ne doit rejouer à l'aveugle.
       */
      const write = method !== 'GET';
      lastError = new HostingerTransportError(
        timedOut ? TRANSPORT_CODES.TIMEOUT : TRANSPORT_CODES.UNREACHABLE,
        timedOut ? 'Hostinger n’a pas répondu dans le délai imparti.' : 'Hostinger injoignable.',
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
        // Un corps illisible (page de proxy, portail captif) ne traverse pas.
        json = null;
      }
    }
    const correlationId = json?.correlation_id
      ?? response.headers?.get?.('x-request-id')
      ?? response.headers?.get?.('x-correlation-id')
      ?? null;

    if (response.ok) return { json, correlationId, httpStatus: response.status, durationMs, attempts: attempt };

    const error = classify(response.status, json, { correlationId, durationMs, write: method !== 'GET' });
    if (error.retryable && attempt < maxAttempts) {
      await backoff(attempt);
      lastError = error;
      continue;
    }
    throw error;
  }
  throw lastError ?? new HostingerTransportError(TRANSPORT_CODES.PROVIDER_ERROR, 'Échec après plusieurs tentatives.');
}

/**
 * Traduit un refus en erreur typée, et décide s'il est SÛR de réessayer.
 *
 * Toutes ces issues sont `FAILED` : Hostinger a RÉPONDU, donc il a tranché,
 * donc rien n'a été écrit. C'est ce qui les distingue du silence.
 */
function classify(status, json, { correlationId, durationMs, write }) {
  const detail = safeMessage(json?.message);
  const suffix = detail ? ` ${detail}` : '';
  const base = { httpStatus: status, correlationId, durationMs, outcome: OUTCOMES.FAILED };

  if (status === 401 || status === 403) {
    return new HostingerTransportError(
      TRANSPORT_CODES.UNAUTHORIZED,
      `Hostinger a refusé le jeton (${status}).${suffix}`,
      { ...base, retryable: false },
    );
  }
  if (status === 404) {
    return new HostingerTransportError(TRANSPORT_CODES.NOT_FOUND, `Ressource inconnue chez Hostinger (404).${suffix}`, {
      ...base,
      retryable: false,
    });
  }
  if (status === 422 || status === 400) {
    return new HostingerTransportError(TRANSPORT_CODES.REJECTED, `Hostinger a refusé la requête (${status}).${suffix}`, {
      ...base,
      retryable: false,
    });
  }
  if (status === 429) {
    return new HostingerTransportError(TRANSPORT_CODES.RATE_LIMITED, 'Hostinger limite le débit (429).', {
      ...base,
      // Retryable seulement en LECTURE : rejouer une écriture après un refus
      // de débit reste une écriture, et rien ne prouve que la première n'est
      // pas passée juste avant le refus.
      retryable: !write,
    });
  }
  if (status >= 500) {
    return new HostingerTransportError(TRANSPORT_CODES.PROVIDER_ERROR, `Hostinger est en erreur (${status}).`, {
      ...base,
      retryable: !write,
    });
  }
  return new HostingerTransportError(TRANSPORT_CODES.PROVIDER_ERROR, `Hostinger a répondu ${status}.${suffix}`, {
    ...base,
    retryable: false,
  });
}

/* -------------------------------------------------------------------------- */
/*  OPÉRATIONS                                                                */
/* -------------------------------------------------------------------------- */

/**
 * `GET /api/domains/v1/portfolio` — les domaines du compte.
 *
 * ⚠️ Cette liste est CELLE DU COMPTE, donc celle de TOUS les clients. Elle ne
 * doit jamais être rendue telle quelle à un projet : c'est l'adaptateur qui la
 * réduit à ce que le demandeur a le droit de savoir (§« Ownership »).
 *
 * @returns {Promise<{domains: string[], httpStatus: number, correlationId: string|null, durationMs: number}>}
 */
export async function listDomains({ credentials, timeoutMs = DEFAULT_TIMEOUT_MS, fetchImpl }) {
  const res = await hostingerFetch({
    credentials, method: 'GET', path: '/api/domains/v1/portfolio',
    timeoutMs, fetchImpl, retries: DEFAULT_GET_RETRIES,
  });
  const rows = Array.isArray(res.json) ? res.json : Array.isArray(res.json?.data) ? res.json.data : [];
  return {
    domains: rows.map((row) => String(row?.domain ?? '').toLowerCase()).filter(Boolean),
    httpStatus: res.httpStatus,
    correlationId: res.correlationId,
    durationMs: res.durationMs,
  };
}

/**
 * `GET /api/dns/v1/zones/{zone}` — les enregistrements d'une zone.
 *
 * La forme rendue est celle qu'attend le moteur de déploiement
 * (`name`, `type`, `ttl`, `contents[]`) : la traduction se fait ICI, une fois,
 * plutôt que chez chaque appelant.
 */
export async function listZoneRecords({ credentials, zone, timeoutMs = DEFAULT_TIMEOUT_MS, fetchImpl }) {
  if (!zone) throw new HostingerTransportError(TRANSPORT_CODES.INPUT_INVALID, 'Zone manquante.');
  const res = await hostingerFetch({
    credentials, method: 'GET', path: `/api/dns/v1/zones/${encodeURIComponent(zone)}`,
    timeoutMs, fetchImpl, retries: DEFAULT_GET_RETRIES,
  });
  const rows = Array.isArray(res.json) ? res.json : Array.isArray(res.json?.data) ? res.json.data : [];
  return {
    zone,
    records: rows.map((row) => ({
      name: String(row?.name ?? ''),
      type: String(row?.type ?? '').toUpperCase(),
      ttl: row?.ttl ?? null,
      contents: (row?.records ?? []).map((r) => r?.content).filter(Boolean),
      disabled: (row?.records ?? []).length > 0 && (row.records).every((r) => r?.is_disabled),
    })),
    httpStatus: res.httpStatus,
    correlationId: res.correlationId,
    durationMs: res.durationMs,
  };
}

/**
 * `PUT /api/dns/v1/zones/{zone}` — LA SEULE ÉCRITURE.
 *
 * ── PORTÉE MINIMALE, ET C'EST VITAL ─────────────────────────────────────────
 *
 * `overwrite: true` sur cette API ne remplace QUE les entrées de même
 * (`name`, `type`) que celles envoyées ; le reste de la zone est préservé.
 * On n'envoie donc jamais qu'UN enregistrement à la fois. Envoyer la zone
 * entière « pour être sûr » effacerait tout ce qu'on n'aurait pas relu — y
 * compris les enregistrements d'autres clients partageant le domaine.
 *
 * Aucun retry. Aucune relecture automatique non plus : la vérification
 * appartient à l'appelant, qui sait ce qu'il attend.
 */
export async function upsertZoneRecord({ credentials, zone, name, type = 'A', content, ttl, timeoutMs = DEFAULT_TIMEOUT_MS, fetchImpl }) {
  if (!zone) throw new HostingerTransportError(TRANSPORT_CODES.INPUT_INVALID, 'Zone manquante.');
  if (!name) throw new HostingerTransportError(TRANSPORT_CODES.INPUT_INVALID, 'Nom d’enregistrement manquant.');
  if (!content) throw new HostingerTransportError(TRANSPORT_CODES.INPUT_INVALID, 'Contenu d’enregistrement manquant.');

  const record = { name, type, records: [{ content }] };
  if (ttl != null) record.ttl = ttl;

  // Trace pauvre : ni jeton, ni corps complet. Une zone et un nom relatif ne
  // sont pas des secrets — ils figurent dans le DNS public.
  logger.info(`[hostinger] PUT zone ${zone} — ${type} ${name} → ${content}`);

  const res = await hostingerFetch({
    credentials,
    method: 'PUT',
    path: `/api/dns/v1/zones/${encodeURIComponent(zone)}`,
    body: { overwrite: true, zone: [record] },
    timeoutMs,
    fetchImpl,
    retries: 0,
  });

  return {
    outcome: OUTCOMES.DONE,
    zone,
    name,
    type,
    httpStatus: res.httpStatus,
    correlationId: res.correlationId,
    durationMs: res.durationMs,
  };
}

/**
 * Faut-il, et peut-on, réessayer ? Deux questions distinctes — les confondre
 * sur une écriture d'infrastructure écrase un enregistrement corrigé à la main.
 */
export function describeRetryDecision(error) {
  if (!(error instanceof HostingerTransportError)) {
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
  HostingerTransportError,
  listDomains,
  listZoneRecords,
  upsertZoneRecord,
  describeRetryDecision,
};
