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
import {
  checkHostForEnvironment,
  getProviderDefinition,
  requiredRoleCodes,
} from './providerRegistry.js';

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
  /**
   * ══ TROIS CODES DE PLUS, ET CHACUN CORRIGE UN DIAGNOSTIC FAUX ═════════════
   *
   * `FORBIDDEN` seul disait « le fournisseur a répondu 403 ». C'est un fait
   * HTTP, pas un diagnostic : il envoyait l'opérateur régénérer une clé qui
   * n'avait rien, parce que trois causes très différentes se ressemblaient.
   *
   *   WRONG_ENVIRONMENT        la clé est bonne, l'HÔTE est celui de l'autre
   *                            monde. Symptôme réel observé : 403 « You cannot
   *                            consume this service » sur TOUTES les routes, y
   *                            compris celles auxquelles la clé a droit.
   *   INSUFFICIENT_PERMISSION  la clé s'authentifie, mais son périmètre ne
   *                            couvre pas l'usage nominal.
   *   WEBHOOK_MANAGEMENT_FORBIDDEN  la clé fait le métier, mais ne peut pas
   *                            gérer les souscriptions. Ce n'est PAS un défaut
   *                            de credential : c'est une capacité manquante,
   *                            et le jeu reste VALID.
   */
  WRONG_ENVIRONMENT: 'WRONG_ENVIRONMENT',
  INSUFFICIENT_PERMISSION: 'INSUFFICIENT_PERMISSION',
  WEBHOOK_MANAGEMENT_FORBIDDEN: 'WEBHOOK_MANAGEMENT_FORBIDDEN',
});

/** État d'une capacité sondée À CÔTÉ du credential. Voir `validateYousign`. */
export const CAPABILITY_STATE = Object.freeze({
  GRANTED: 'GRANTED',
  FORBIDDEN: 'FORBIDDEN',
  UNKNOWN: 'UNKNOWN',
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
/**
 * YOUSIGN — VALIDATION EN DEUX NIVEAUX, ET LA SEPARATION EST TOUT L'ENJEU.
 *
 * == CE QUI ETAIT SONDE, ET POURQUOI C'ETAIT LE MAUVAIS ENDROIT =============
 *
 * Le validateur appelait `GET /users` -- l'annuaire des utilisateurs de
 * l'ORGANISATION. C'est l'une des surfaces les plus privilegiees de l'API, et
 * ce n'est pas celle que le Panel utilise : nos capacites sont toutes des
 * `signature.*`. Une cle parfaitement legitime, restreinte a un workspace ou
 * en lecture seule, y repond 403 -- et le Panel concluait « cle invalide ».
 *
 * On valide desormais sur l'USAGE NOMINAL : `GET /signature_requests?limit=1`.
 * Une cle qui peut lire les demandes de signature peut faire le travail ; une
 * cle qui ne le peut pas ne le peut vraiment pas. Le sondage dit exactement ce
 * qu'on a besoin de savoir, ni plus ni moins.
 *
 * == NIVEAU 1 -- LE CREDENTIAL ==============================================
 *
 *   « cette cle est-elle utilisable par l'API Yousign DANS CET ENVIRONNEMENT ? »
 *
 * L'hote est verifie AVANT le reseau : une cle de bac a sable envoyee a l'hote
 * de production recoit un 403 sur toutes les routes, indiscernable d'une cle
 * morte. Refuser sans appeler donne le bon diagnostic tout de suite, et
 * n'expose pas la cle a un hote qui n'est pas le sien.
 *
 * == NIVEAU 2 -- LA CAPACITE ================================================
 *
 *   « cette cle permet-elle EN PLUS de gerer les souscriptions webhook ? »
 *
 * Sondee separement (`GET /webhooks`), et son echec ne degrade JAMAIS le
 * verdict du credential. Une cle qui signe sans pouvoir gerer les webhooks est
 * authentifiee, capable du metier, et incapable d'une operation
 * d'administration -- trois faits vrais en meme temps, que « cle invalide »
 * ecrasait en un seul mensonge.
 */
async function validateYousign(values, { fetchImpl, environment = null }) {
  const base = stripSlash(values.baseUrl);
  const details = {
    baseUrl: base,
    // Chez Yousign, c'est l'HOTE qui porte le monde, pas la cle.
    hostEnvironment: /sandbox/.test(base) ? 'sandbox' : 'production',
    probe: 'GET /signature_requests',
  };

  /* -- NIVEAU 0 : LE MONDE, AVANT MEME D'APPELER -------------------------- */
  const hote = checkHostForEnvironment('YOUSIGN', 'baseUrl', environment, base);
  if (hote) {
    return {
      status: VALIDATION_STATUS.INVALID,
      code: VALIDATION_CODES.WRONG_ENVIRONMENT,
      message: hote.reason === 'OTHER_ENVIRONMENT'
        ? `L\u2019URL de base vise « ${hote.actual} », l\u2019h\u00f4te ${hote.otherEnvironment} de Yousign, `
          + `alors que ce jeu est ${environment}. La cl\u00e9 n\u2019est pas en cause : Yousign refuse `
          + `toute cl\u00e9 pr\u00e9sent\u00e9e au mauvais h\u00f4te avec un 403 qui ressemble \u00e0 une cl\u00e9 `
          + `invalide. Attendu : ${hote.expected}.`
        : `L\u2019URL de base doit viser « ${hote.expected} » en ${environment}.`,
      details: { ...details, expectedHost: hote.expected, actualHost: hote.actual },
      durationMs: 0,
    };
  }

  /* -- NIVEAU 1 : L'USAGE NOMINAL ----------------------------------------- */
  const { response, durationMs } = await timedFetch(
    `${base}/signature_requests?limit=1`,
    { headers: { Authorization: `Bearer ${values.apiKey}`, accept: 'application/json' } },
    fetchImpl,
  );
  const json = await readJson(response);
  details.httpStatus = response.status;
  details.durationMs = durationMs;

  if (!response.ok) {
    details.providerMessage = safeMessage(json?.detail ?? json?.message ?? json?.title);
    details.providerType = safeMessage(json?.type);

    if (response.status === 403) {
      return {
        status: VALIDATION_STATUS.INVALID,
        code: VALIDATION_CODES.INSUFFICIENT_PERMISSION,
        message: 'Yousign authentifie la cl\u00e9 mais refuse la lecture des demandes de '
          + 'signature (403). V\u00e9rifiez le p\u00e9rim\u00e8tre de la cl\u00e9 \u2014 organisation ou '
          + 'workspace \u2014 et ses permissions.',
        details,
        durationMs,
      };
    }
    return {
      ...classifyHttp(response.status),
      message: response.status === 401
        ? 'Yousign a refus\u00e9 la cl\u00e9 (401) : elle est inconnue de cet environnement.'
        : `Yousign a r\u00e9pondu ${response.status}.`,
      details,
      durationMs,
    };
  }

  const demandes = Array.isArray(json?.data) ? json.data : [];
  details.signatureRequestsVisible = demandes.length;

  /* -- NIVEAU 2 : LA CAPACITE D'ADMINISTRER LES WEBHOOKS ------------------- */
  details.capabilities = {
    webhookManagement: await probeYousignWebhookManagement(base, values.apiKey, fetchImpl),
  };

  return {
    status: VALIDATION_STATUS.VALID,
    code: VALIDATION_CODES.OK,
    message: details.capabilities.webhookManagement === CAPABILITY_STATE.FORBIDDEN
      ? `Yousign reconna\u00eet la cl\u00e9 (${details.hostEnvironment}), mais elle n\u2019est pas autoris\u00e9e `
        + '\u00e0 g\u00e9rer les souscriptions webhook : la r\u00e9conciliation restera en erreur.'
      : `Yousign reconna\u00eet la cl\u00e9 (${details.hostEnvironment}).`,
    details,
    durationMs,
  };
}

/**
 * LA CAPACITE WEBHOOK, SONDEE EN LECTURE SEULE.
 *
 * `GET /webhooks` ne cree rien et ne modifie rien. Son echec ne peut pas
 * invalider le credential : il RENSEIGNE une capacite, et c'est la
 * reconciliation qui en tirera son propre etat.
 *
 * -- AUCUN CORPS N'EST CONSERVE, ET CE N'EST PAS DE LA PRUDENCE DE PRINCIPE --
 *
 * La reponse de cette route contient le `secret_key` EN CLAIR de chaque
 * souscription existante. On ne lit donc que le STATUT -- jamais le corps,
 * jamais un extrait, jamais un message d'erreur qui pourrait en contenir un.
 */
async function probeYousignWebhookManagement(base, apiKey, fetchImpl) {
  try {
    const { response } = await timedFetch(
      `${base}/webhooks`,
      { headers: { Authorization: `Bearer ${apiKey}`, accept: 'application/json' } },
      fetchImpl,
    );
    if (response.ok) return CAPABILITY_STATE.GRANTED;
    if (response.status === 401 || response.status === 403) return CAPABILITY_STATE.FORBIDDEN;
    return CAPABILITY_STATE.UNKNOWN;
  } catch {
    // Une panne reseau n'est pas un refus : « je n'ai pas pu demander ».
    return CAPABILITY_STATE.UNKNOWN;
  }
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
    /**
     * L'ENVIRONNEMENT EST TRANSMIS AU VALIDATEUR — il ne l'avait jamais été.
     *
     * Un validateur ne pouvait donc pas savoir dans QUEL monde il opérait, et
     * ne pouvait pas vérifier la cohérence de l'hôte qu'on lui donnait. C'est
     * précisément ce qui a laissé passer une clé de bac à sable envoyée à
     * l'hôte de production : le seul indice était un 403, et un 403 ne dit pas
     * pourquoi.
     */
    return await validator(values, { fetchImpl, environment });
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

export default {
  CAPABILITY_STATE, VALIDATION_STATUS, VALIDATION_CODES, validateCredentials, hasValidator,
};
