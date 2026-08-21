// VALIDATION DES IDENTIFIANTS — un appel réel, en LECTURE SEULE.
//
// docs/architecture/INTEGRATED_API_CONTROL_PLANE_ROADMAP.md §13 (L1).
//
// ── CE QUE FAIT CE FICHIER, ET RIEN D'AUTRE ─────────────────────────────────
//
//   jeu d'identifiants  →  VALID | INVALID | ERROR
//
// Aucun paiement. Aucun e-mail. Aucune signature. Aucun webhook. Aucun
// enregistrement DNS. Aucun crédit débité. Les appels ci-dessous sont ceux qui
// prouvent l'authentification sans rien créer — et pour OpenSign, cette
// exigence est plus dure qu'ailleurs : la moitié de son API facture un crédit
// à la création d'un document, ce qui disqualifie d'emblée toute sonde qui
// « essaierait » un acte métier.
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
// fournisseur est tronqué et repris tel quel : Stripe, Brevo, Yousign, OpenSign
// et Hostinger n'échoent jamais la clé dans leurs corps d'erreur.
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

/** État d'une capacité sondée À CÔTÉ du credential. Voir `validateOpenSign`. */
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

/*
 * `validateYousign` A ÉTÉ RETIRÉE.
 *
 * Elle sondait deux niveaux : « cette clé est-elle authentique ? » puis
 * « permet-elle en plus de gérer les souscriptions webhook ? ». Les deux
 * questions supposaient une clé — le fournisseur est retiré, son entrée de
 * registre ne déclare plus aucun rôle de credential, et ses jeux ont été
 * supprimés des deux bases.
 *
 * Un validateur sans credential à valider n'est pas inoffensif : il rend le
 * bouton « tester la connexion » actif dans l'interface, donc il INVITE à
 * saisir une clé pour un fournisseur qui ne sert plus. C'est exactement le
 * chemin par lequel un secret revient en base.
 *
 * La leçon qu'elle portait, elle, a survécu : la séparation TEST/PROD par
 * HÔTE, et le refus d'envoyer une clé à l'hôte d'un autre monde. Elle vit
 * désormais dans `environmentHosts`, côté registre, pour tous les
 * fournisseurs qui en ont deux.
 */

/*
 * `probeYousignWebhookManagement` A ÉTÉ RETIRÉE avec son validateur.
 *
 * Elle sondait `GET /webhooks` en lecture seule pour dire si une clé pouvait,
 * EN PLUS de signer, administrer les souscriptions. Plus aucun appelant : le
 * fournisseur qu'elle sondait est retiré, et sa clé n'existe plus.
 *
 * Le patron, lui, a été repris tel quel pour OpenSign
 * (`probeOpenSignWebhookManagement`) : une capacité sondée À CÔTÉ du
 * credential, dont l'échec ne dégrade jamais le verdict de la clé.
 */

/* -------------------------------------------------------------------------- */
/*  OPENSIGN                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * OPENSIGN — VALIDATION EN TROIS NIVEAUX, SUR L'USAGE NOMINAL.
 *
 * ══ NIVEAU 0 — LE MONDE, AVANT MÊME D'APPELER ══════════════════════════════
 *
 * Même règle que Yousign, et pour un symptôme identique : OpenSign documente
 * explicitement qu'un jeton Live ne fonctionne pas en bac à sable ni l'inverse.
 * Envoyé au mauvais hôte, un jeton parfaitement valide reçoit un refus
 * d'authentification indiscernable d'une clé morte. Refuser AVANT le réseau
 * donne le bon diagnostic tout de suite, et n'expose pas le jeton à un hôte qui
 * n'est pas le sien.
 *
 * ══ NIVEAU 1 — LE CREDENTIAL : `GET /getuser` ══════════════════════════════
 *
 * La lecture la plus pauvre en privilèges de toute l'API : elle rend le compte
 * du porteur du jeton, rien d'autre. Elle ne crée aucun document, n'envoie
 * aucun e-mail et ne débite aucun crédit — trois propriétés indispensables pour
 * une sonde qu'un opérateur peut cliquer autant de fois qu'il veut.
 *
 * ⚠️ `405` EST LA RÉPONSE D'OPENSIGN À UN JETON REFUSÉ. Le classificateur HTTP
 * commun à ce fichier le rangerait en `UNEXPECTED_STATUS`, c'est-à-dire en
 * ERROR — « on n'a pas pu savoir ». Or on sait parfaitement : la clé est
 * refusée. Le verdict serait faux dans les deux sens à la fois (mauvaise
 * catégorie, mauvaise action à mener).
 *
 * ══ NIVEAUX 2 ET 3 — DEUX CAPACITÉS, SONDÉES À CÔTÉ ════════════════════════
 *
 *   webhookManagement  « ce jeton peut-il administrer l'URL de webhook ? »
 *   credits            « ce compte peut-il encore créer des documents ? »
 *
 * Aucune des deux ne dégrade JAMAIS le verdict du credential. Un jeton qui
 * s'authentifie sur un compte à zéro crédit est valide, capable d'administrer,
 * et incapable d'ouvrir une signature — trois faits vrais en même temps, que
 * « clé invalide » écraserait en un seul mensonge. Les crédits, en particulier,
 * sont une contrainte d'OpenSign que Yousign n'a pas : les ignorer ferait
 * découvrir l'épuisement au pire moment, c'est-à-dire pendant une signature.
 */
async function validateOpenSign(values, { fetchImpl, environment = null }) {
  const base = stripSlash(values.baseUrl);
  const details = {
    baseUrl: base,
    // Chez OpenSign, c'est l'HÔTE qui porte le monde, pas le jeton.
    hostEnvironment: /sandbox/.test(base) ? 'sandbox' : /eu-app/.test(base) ? 'eu' : 'production',
    probe: 'GET /getuser',
  };

  /* -- NIVEAU 0 : LE MONDE ------------------------------------------------ */
  const hote = checkHostForEnvironment('OPENSIGN', 'baseUrl', environment, base);
  if (hote) {
    return {
      status: VALIDATION_STATUS.INVALID,
      code: VALIDATION_CODES.WRONG_ENVIRONMENT,
      message: hote.reason === 'OTHER_ENVIRONMENT'
        ? `L’URL de base vise « ${hote.actual} », l’hôte ${hote.otherEnvironment} d’OpenSign, `
          + `alors que ce jeu est ${environment}. Le jeton n’est pas en cause : un jeton Sandbox `
          + `et un jeton Live ne sont pas interchangeables, et le refus ressemble à un jeton `
          + `invalide. Attendu : ${hote.expected}.`
        : `L’URL de base doit viser « ${hote.expected} » en ${environment}. `
          + `La région UE (eu-app) est un compte distinct, pas un alias : elle exige une `
          + `décision d’architecture, pas une URL.`,
      details: { ...details, expectedHost: hote.expected, actualHost: hote.actual },
      durationMs: 0,
    };
  }

  /* -- NIVEAU 1 : LE CREDENTIAL ------------------------------------------- */
  const { response, durationMs } = await timedFetch(
    `${base}/getuser`,
    { headers: { 'x-api-token': values.apiToken, accept: 'application/json' } },
    fetchImpl,
  );
  const json = await readJson(response);
  details.httpStatus = response.status;
  details.durationMs = durationMs;

  if (!response.ok) {
    details.providerMessage = safeMessage(json?.error ?? json?.message);

    // Le 405 d'OpenSign : un jeton refusé, pas une méthode interdite.
    if (response.status === 405 || response.status === 401) {
      return {
        status: VALIDATION_STATUS.INVALID,
        code: VALIDATION_CODES.UNAUTHORIZED,
        message: `OpenSign a refusé le jeton (HTTP ${response.status} — chez ce fournisseur, `
          + `405 signifie « Invalid API token », pas « méthode non autorisée »). `
          + `Vérifiez qu’il s’agit bien du jeton ${details.hostEnvironment}.`,
        details,
        durationMs,
      };
    }
    if (response.status === 404) {
      return {
        status: VALIDATION_STATUS.INVALID,
        code: VALIDATION_CODES.FORBIDDEN,
        message: 'OpenSign ne trouve aucun utilisateur pour ce jeton : il est syntaxiquement '
          + 'accepté mais ne désigne aucun compte.',
        details,
        durationMs,
      };
    }
    return {
      ...classifyHttp(response.status),
      message: `OpenSign a répondu ${response.status}.`,
      details,
      durationMs,
    };
  }

  details.account = json?.email ?? null;
  details.accountName = json?.name ?? null;
  details.company = json?.company ?? null;

  /* -- NIVEAU 2 : L'ADMINISTRATION DU WEBHOOK ----------------------------- */
  details.capabilities = {
    webhookManagement: await probeOpenSignWebhookManagement(base, values.apiToken, fetchImpl),
  };

  /* -- NIVEAU 3 : LES CRÉDITS -------------------------------------------- */
  details.credits = await probeOpenSignCredits(base, values.apiToken, fetchImpl);

  const alertes = [];
  if (details.capabilities.webhookManagement === CAPABILITY_STATE.FORBIDDEN) {
    alertes.push('elle n’est pas autorisée à administrer l’URL de webhook');
  }
  if (details.credits?.total === 0) {
    alertes.push('le compte n’a plus aucun crédit API : aucune signature ne pourra être ouverte');
  }

  return {
    status: VALIDATION_STATUS.VALID,
    code: VALIDATION_CODES.OK,
    message: alertes.length
      ? `OpenSign reconnaît le jeton (${details.hostEnvironment}), mais ${alertes.join(' et ')}.`
      : `OpenSign reconnaît le jeton (${details.hostEnvironment}`
        + `${details.account ? `, compte ${details.account}` : ''}).`,
    details,
    durationMs,
  };
}

/**
 * L'ADMINISTRATION DU WEBHOOK, SONDÉE EN LECTURE SEULE.
 *
 * `GET /webhook` ne crée rien et ne modifie rien. Son échec ne peut pas
 * invalider le credential : il RENSEIGNE une capacité, et c'est la
 * réconciliation qui en tirera son propre état.
 *
 * ── AUCUN CORPS N'EST CONSERVÉ ──────────────────────────────────────────────
 *
 * La réponse porte l'URL de webhook du compte — celle d'un AUTRE Panel, le cas
 * échéant. On ne lit que le statut : la comparer, l'afficher ou la journaliser
 * ferait de la sonde de validation un révélateur d'infrastructure tierce.
 */
async function probeOpenSignWebhookManagement(base, apiToken, fetchImpl) {
  try {
    const { response } = await timedFetch(
      `${base}/webhook`,
      { headers: { 'x-api-token': apiToken, accept: 'application/json' } },
      fetchImpl,
    );
    if (response.ok) return CAPABILITY_STATE.GRANTED;
    // 405 = jeton refusé chez OpenSign ; 401/403 = refus de périmètre.
    if ([401, 403, 405].includes(response.status)) return CAPABILITY_STATE.FORBIDDEN;
    // 404 « User not found » sur cette route signifie qu'aucune URL n'est
    // posée, pas que la capacité manque : le jeton a bien été accepté.
    if (response.status === 404) return CAPABILITY_STATE.GRANTED;
    return CAPABILITY_STATE.UNKNOWN;
  } catch {
    // Une panne réseau n'est pas un refus : « je n'ai pas pu demander ».
    return CAPABILITY_STATE.UNKNOWN;
  }
}

/**
 * LES CRÉDITS — une contrainte d'EXPLOITATION, jamais un verdict sur la clé.
 *
 * OpenSign facture la création de document à l'API (Self Sign, Draft Document,
 * Create Document, Draft Template, Create Document From Template). Un compte à
 * zéro crédit s'authentifie parfaitement et ne peut plus rien ouvrir : c'est
 * une panne métier qu'aucun test d'authentification ne verrait.
 *
 * `400 Subscription not found` est une réponse NORMALE d'un compte sans
 * abonnement — elle ne dit rien de mauvais sur le jeton, et rend donc `null`.
 */
async function probeOpenSignCredits(base, apiToken, fetchImpl) {
  try {
    const { response } = await timedFetch(
      `${base}/getcredits`,
      { headers: { 'x-api-token': apiToken, accept: 'application/json' } },
      fetchImpl,
    );
    if (!response.ok) return null;
    const json = await readJson(response);
    const nombre = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);
    return {
      plan: nombre(json?.plan_credits),
      addon: nombre(json?.addon_credits),
      total: nombre(json?.total_credits),
      renewalDate: typeof json?.renewal_date === 'string' ? json.renewal_date : null,
    };
  } catch {
    return null;
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
  OPENSIGN: validateOpenSign,
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
