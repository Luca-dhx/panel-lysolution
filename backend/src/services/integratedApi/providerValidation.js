// VALIDATION DES IDENTIFIANTS — un appel réel, en LECTURE SEULE.
//
// docs/architecture/INTEGRATED_API_CONTROL_PLANE_ROADMAP.md §13 (L1).
//
// ── CE QUE FAIT CE FICHIER, ET RIEN D'AUTRE ─────────────────────────────────
//
//   jeu d'identifiants  →  VALID | INVALID | ERROR
//
// Aucun paiement. Aucun e-mail. Aucune signature. Aucun webhook. Aucun
// enregistrement DNS. Les quatre appels ci-dessous sont ceux, déjà éprouvés en
// production côté projet, qui prouvent l'authentification sans rien créer.
//
// ── TROIS ISSUES, ET LA TROISIÈME COMPTE AUTANT QUE LES DEUX AUTRES ─────────
//
//   VALID   le fournisseur a répondu, et il nous reconnaît.
//   INVALID le fournisseur a répondu, et il refuse la clé (401/403).
//   ERROR   on n'a pas pu savoir — réseau, délai, panne, 5xx.
//
// Confondre INVALID et ERROR est l'erreur classique : elle fait afficher
// « clé invalide » pendant une coupure réseau, et envoie l'opérateur
// régénérer une clé qui n'avait rien.
//
// ── AUCUN SECRET NE SORT ────────────────────────────────────────────────────
//
// Les valeurs déchiffrées ne vivent que dans la portée de l'appel. Le
// diagnostic rendu ne contient que des données publiques (identifiant de
// compte, pays, version d'API, temps de réponse). Un message d'erreur du
// fournisseur est tronqué et repris tel quel : Stripe, Brevo, Yousign et
// Hostinger n'échoent jamais la clé dans leurs corps d'erreur.
import { decryptCredentialSet } from './credentialVault.js';
import { getProviderDefinition, requiredRoleCodes } from './providerRegistry.js';

const FETCH_TIMEOUT_MS = 10_000;

/** Issues possibles. Codes STABLES — l'interface et les tests s'y appuient. */
export const VALIDATION_STATUS = Object.freeze({
  VALID: 'VALID',
  INVALID: 'INVALID',
  ERROR: 'ERROR',
});

/** Codes de résultat. Fermés, lisibles, jamais un message libre. */
export const VALIDATION_CODES = Object.freeze({
  OK: 'OK',
  MISSING_CREDENTIALS: 'MISSING_CREDENTIALS',
  UNAUTHORIZED: 'UNAUTHORIZED',
  FORBIDDEN: 'FORBIDDEN',
  RATE_LIMITED: 'RATE_LIMITED',
  UNEXPECTED_STATUS: 'UNEXPECTED_STATUS',
  UNREACHABLE: 'UNREACHABLE',
  TIMEOUT: 'TIMEOUT',
  NO_VALIDATOR: 'NO_VALIDATOR',
});

/**
 * `fetch` borné dans le temps. Un fournisseur qui ne répond pas ne doit jamais
 * immobiliser une requête d'administration.
 * Injectable (`fetchImpl`) : les tests ne sortent pas sur le réseau.
 */
async function timedFetch(url, options = {}, fetchImpl = globalThis.fetch) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  const startedAt = Date.now();
  try {
    const response = await fetchImpl(url, { ...options, signal: controller.signal });
    return { response, durationMs: Date.now() - startedAt };
  } catch (err) {
    const timedOut = err?.name === 'AbortError';
    const error = new Error(timedOut ? 'Délai dépassé.' : 'Fournisseur injoignable.');
    error.code = timedOut ? VALIDATION_CODES.TIMEOUT : VALIDATION_CODES.UNREACHABLE;
    error.durationMs = Date.now() - startedAt;
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function readJson(response) {
  try {
    const text = await response.text();
    return text ? JSON.parse(text) : {};
  } catch {
    return {};
  }
}

/** Message fournisseur repris dans le diagnostic : tronqué, jamais un secret. */
function safeMessage(message) {
  if (typeof message !== 'string') return null;
  const clean = message.trim();
  if (!clean) return null;
  return clean.length > 300 ? `${clean.slice(0, 300)}…` : clean;
}

const stripSlash = (url) => String(url || '').replace(/\/+$/, '');

/** Traduction d'un statut HTTP en issue, commune aux quatre fournisseurs. */
function classifyHttp(status) {
  if (status === 401) return { status: VALIDATION_STATUS.INVALID, code: VALIDATION_CODES.UNAUTHORIZED };
  if (status === 403) return { status: VALIDATION_STATUS.INVALID, code: VALIDATION_CODES.FORBIDDEN };
  if (status === 429) return { status: VALIDATION_STATUS.ERROR, code: VALIDATION_CODES.RATE_LIMITED };
  return { status: VALIDATION_STATUS.ERROR, code: VALIDATION_CODES.UNEXPECTED_STATUS };
}

/* -------------------------------------------------------------------------- */
/*  VALIDATEURS — un par fournisseur, tous en lecture seule                   */
/* -------------------------------------------------------------------------- */

/** Stripe : `GET /v1/account`. Lit le compte, ne crée rien. */
async function validateStripe(values, { fetchImpl }) {
  const base = stripSlash(values.baseUrl);
  const { response, durationMs } = await timedFetch(
    `${base}/v1/account`,
    { headers: { Authorization: `Bearer ${values.secretKey}` } },
    fetchImpl,
  );
  const json = await readJson(response);
  const details = {
    baseUrl: base,
    httpStatus: response.status,
    // La clé porte son monde : c'est la vérification la plus directe qui soit.
    keyEnvironment: values.secretKey?.startsWith('sk_live_') ? 'live'
      : values.secretKey?.startsWith('sk_test_') ? 'test' : 'inconnu',
    apiVersion: response.headers?.get?.('stripe-version') ?? null,
    durationMs,
  };
  if (response.ok) {
    details.account = json?.id ?? null;
    details.country = json?.country ?? null;
    details.defaultCurrency = json?.default_currency ?? null;
    details.chargesEnabled = json?.charges_enabled ?? null;
    return {
      status: VALIDATION_STATUS.VALID,
      code: VALIDATION_CODES.OK,
      message: `Stripe reconnaît la clé${json?.id ? ` (compte ${json.id}, ${details.keyEnvironment})` : ''}.`,
      details,
      durationMs,
    };
  }
  const verdict = classifyHttp(response.status);
  details.providerMessage = safeMessage(json?.error?.message);
  return {
    ...verdict,
    message: response.status === 401
      ? 'Stripe a refusé la clé (401).'
      : `Stripe a répondu ${response.status}.`,
    details,
    durationMs,
  };
}

/**
 * Brevo : `GET {base}/account`. Auth par en-tête `api-key`, pas par Bearer.
 *
 * Un 401 Brevo signifie aussi bien « clé refusée » que « IP du serveur non
 * autorisée » (restriction « Authorised IPs » du compte), et SEUL le message
 * les distingue. Le réduire à « clé invalide » enverrait l'opérateur
 * régénérer une clé parfaitement valide.
 */
async function validateBrevo(values, { fetchImpl }) {
  const base = stripSlash(values.baseUrl);
  const { response, durationMs } = await timedFetch(
    `${base}/account`,
    { headers: { 'api-key': values.apiKey, accept: 'application/json' } },
    fetchImpl,
  );
  const json = await readJson(response);
  const details = {
    baseUrl: base,
    httpStatus: response.status,
    apiVersion: base.match(/\/(v\d+)$/)?.[1] ?? null,
    durationMs,
  };
  if (response.ok) {
    details.account = json?.companyName ?? null;
    details.accountEmail = json?.email ?? null;
    return {
      status: VALIDATION_STATUS.VALID,
      code: VALIDATION_CODES.OK,
      message: `Brevo reconnaît la clé${details.account ? ` (compte ${details.account})` : ''}.`,
      details,
      durationMs,
    };
  }
  const verdict = classifyHttp(response.status);
  details.providerCode = json?.code ?? null;
  details.providerMessage = safeMessage(json?.message);
  return {
    ...verdict,
    message: response.status === 401
      ? 'Brevo a refusé la clé (401) — clé invalide, ou IP de ce serveur non autorisée sur le compte.'
      : `Brevo a répondu ${response.status}.`,
    details,
    durationMs,
  };
}

/** Yousign : `GET {base}/users?limit=1`. Lit l'organisation, ne signe rien. */
async function validateYousign(values, { fetchImpl }) {
  const base = stripSlash(values.baseUrl);
  const { response, durationMs } = await timedFetch(
    `${base}/users?limit=1`,
    { headers: { Authorization: `Bearer ${values.apiKey}`, accept: 'application/json' } },
    fetchImpl,
  );
  const json = await readJson(response);
  const details = {
    baseUrl: base,
    httpStatus: response.status,
    // Chez Yousign, c'est l'HÔTE qui porte le monde, pas la clé.
    hostEnvironment: /sandbox/.test(base) ? 'sandbox' : 'production',
    durationMs,
  };
  if (response.ok) {
    const first = Array.isArray(json?.data) ? json.data[0] : null;
    if (first) {
      details.userEmail = first.email ?? null;
      details.organizationId = first.organization_id ?? first.organization?.id ?? null;
    }
    return {
      status: VALIDATION_STATUS.VALID,
      code: VALIDATION_CODES.OK,
      message: `Yousign reconnaît la clé (${details.hostEnvironment}).`,
      details,
      durationMs,
    };
  }
  const verdict = classifyHttp(response.status);
  details.providerMessage = safeMessage(json?.detail ?? json?.message);
  return {
    ...verdict,
    message: response.status === 401
      ? 'Yousign a refusé la clé (401).'
      : `Yousign a répondu ${response.status}.`,
    details,
    durationMs,
  };
}

/**
 * Hostinger : `GET /api/domains/v1/portfolio`. Liste les domaines gérés —
 * lecture pure, aucun enregistrement DNS touché.
 */
async function validateHostinger(values, { fetchImpl }) {
  const base = stripSlash(values.baseUrl);
  const { response, durationMs } = await timedFetch(
    `${base}/api/domains/v1/portfolio`,
    { headers: { Authorization: `Bearer ${values.apiToken}`, accept: 'application/json' } },
    fetchImpl,
  );
  const json = await readJson(response);
  const details = { baseUrl: base, httpStatus: response.status, durationMs, change: 'aucun (lecture seule)' };
  if (response.ok) {
    const domains = Array.isArray(json) ? json : Array.isArray(json?.data) ? json.data : [];
    details.domainsCount = domains.length;
    return {
      status: VALIDATION_STATUS.VALID,
      code: VALIDATION_CODES.OK,
      message: `Hostinger reconnaît le jeton (${domains.length} domaine(s) accessible(s)).`,
      details,
      durationMs,
    };
  }
  const verdict = classifyHttp(response.status);
  details.providerMessage = safeMessage(json?.message);
  return {
    ...verdict,
    message: response.status === 401
      ? 'Hostinger a refusé le jeton (401).'
      : `Hostinger a répondu ${response.status}.`,
    details,
    durationMs,
  };
}

const VALIDATORS = Object.freeze({
  STRIPE: validateStripe,
  BREVO: validateBrevo,
  YOUSIGN: validateYousign,
  HOSTINGER: validateHostinger,
});

/** Un fournisseur sait-il se valider ? Utilisé par l'UI pour griser le bouton. */
export function hasValidator(providerCode) {
  return Object.hasOwn(VALIDATORS, String(providerCode).toUpperCase());
}

/* -------------------------------------------------------------------------- */
/*  POINT D'ENTRÉE                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Valide un jeu d'identifiants CHIFFRÉ.
 *
 * Ne lève jamais : une panne fournisseur est un RÉSULTAT (`ERROR`), pas une
 * exception. L'appelant persiste le verdict dans tous les cas — c'est
 * précisément quand ça se passe mal qu'on veut une trace.
 *
 * @returns {Promise<{status, code, message, details, durationMs}>}
 */
export async function validateCredentials({
  provider,
  environment = null,
  credentialsEncrypted,
  fetchImpl = globalThis.fetch,
}) {
  const definition = getProviderDefinition(provider);
  const startedAt = Date.now();
  if (!definition) {
    return {
      status: VALIDATION_STATUS.ERROR,
      code: VALIDATION_CODES.NO_VALIDATOR,
      message: `Fournisseur inconnu : ${provider}.`,
      details: {},
      durationMs: 0,
    };
  }

  const validator = VALIDATORS[definition.code];
  if (!validator) {
    return {
      status: VALIDATION_STATUS.ERROR,
      code: VALIDATION_CODES.NO_VALIDATOR,
      message: `Aucun test de connexion pour ${definition.label}.`,
      details: {},
      durationMs: 0,
    };
  }

  // Le déchiffrement a lieu ICI, au plus près de l'appel, et les valeurs ne
  // survivent pas à cette fonction.
  let values;
  try {
    values = decryptCredentialSet(definition.code, credentialsEncrypted, { environment });
  } catch (err) {
    return {
      status: VALIDATION_STATUS.ERROR,
      code: 'DECRYPT_FAILED',
      message: err?.message ?? 'Déchiffrement impossible.',
      details: {},
      durationMs: Date.now() - startedAt,
    };
  }

  const missing = requiredRoleCodes(definition.code).filter((code) => !values[code]);
  if (missing.length > 0) {
    return {
      status: VALIDATION_STATUS.ERROR,
      code: VALIDATION_CODES.MISSING_CREDENTIALS,
      message: `Test impossible : ${missing.join(', ')} non renseigné(s).`,
      details: { missing },
      durationMs: Date.now() - startedAt,
    };
  }

  try {
    return await validator(values, { fetchImpl });
  } catch (err) {
    return {
      status: VALIDATION_STATUS.ERROR,
      code: err?.code ?? VALIDATION_CODES.UNREACHABLE,
      message: err?.message ?? 'Fournisseur injoignable.',
      details: {},
      durationMs: err?.durationMs ?? (Date.now() - startedAt),
    };
  }
}

export default { VALIDATION_STATUS, VALIDATION_CODES, validateCredentials, hasValidator };
