// PILOTES DISTANTS — le CRUD d'un endpoint chez un fournisseur (L5).
//
// docs/architecture/WEBHOOK_CONTROL_PLANE.md §« Contrat de pilote ».
//
// ── LE CONTRAT, EN QUATRE VERBES ────────────────────────────────────────────
//
//   list(ctx)                 → RemoteWebhook[]
//   create(ctx, desired)      → { id, secret|null }
//   update(ctx, id, desired)  → void
//   remove(ctx, id)           → void
//
//   RemoteWebhook = { id, url, events[], description, enabled }
//
// Quatre verbes, pas quarante. L'abstraction s'arrête là où le réconciliateur
// s'arrête : ce lot pose une fondation, il ne modélise pas l'intégralité des
// API de trois fournisseurs.
//
// ── CE QUE CES PILOTES NE FONT PAS ──────────────────────────────────────────
//
// Aucun appel MÉTIER. Pas un paiement, pas un e-mail, pas une signature. Ils ne
// touchent QUE `/v1/webhook_endpoints`, `/v3/webhooks` et `/webhooks`. Migrer
// les appels métier appartient à L6, L7 et L8 — les inclure ici cacherait trois
// lots dans celui-ci.
//
// ── DISCIPLINE ──────────────────────────────────────────────────────────────
//
// `fetch` nu, délai borné, erreurs TYPÉES (`WebhookError`), aucun secret dans
// un message ni dans un journal. `fetchImpl` est injectable : la recette ne
// sort jamais sur le réseau, et ne touche donc jamais un vrai compte.
import { WebhookError, WEBHOOK_DIAGNOSTIC, safeMessage } from './webhookDiagnostics.js';

const FETCH_TIMEOUT_MS = 10_000;

const stripSlash = (url) => String(url ?? '').replace(/\/+$/, '');

/**
 * `fetch` borné. Un fournisseur muet ne doit jamais immobiliser une
 * réconciliation — encore moins un démarrage de Panel.
 */
async function timedFetch(url, options, fetchImpl) {
  const impl = fetchImpl ?? globalThis.fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await impl(url, { ...options, signal: controller.signal });
  } catch (err) {
    throw new WebhookError(
      WEBHOOK_DIAGNOSTIC.WEBHOOK_REMOTE_UNREACHABLE,
      err?.name === 'AbortError'
        ? 'Fournisseur injoignable : délai dépassé.'
        : 'Fournisseur injoignable : erreur réseau.',
    );
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

/**
 * Traduction d'une réponse d'erreur en diagnostic TYPÉ.
 *
 * `401/403` → `WEBHOOK_AUTH_INVALID` : la clé est en cause, réessayer n'aidera
 * pas. Tout le reste → `WEBHOOK_REMOTE_ERROR`, sauf le plafond d'endpoints, qui
 * mérite son propre code parce qu'il ne se répare qu'en supprimant un endpoint
 * ailleurs (roadmap §8.2, plafond Stripe de 16).
 */
function remoteError(response, json) {
  const raw = json?.error?.message || json?.message || json?.detail || json?.title || '';
  const message = safeMessage(raw || `Réponse ${response.status}.`);

  if (response.status === 401 || response.status === 403) {
    return new WebhookError(WEBHOOK_DIAGNOSTIC.WEBHOOK_AUTH_INVALID, message);
  }
  if (/limit|maximum|too many|quota/i.test(raw) && response.status < 500) {
    return new WebhookError(WEBHOOK_DIAGNOSTIC.WEBHOOK_REMOTE_LIMIT_REACHED, message);
  }
  return new WebhookError(WEBHOOK_DIAGNOSTIC.WEBHOOK_REMOTE_ERROR, message, {
    httpStatus: response.status,
  });
}

/** Une clé requise absente est un prérequis manquant, jamais une panne. */
function requireCredential(ctx, role) {
  const value = ctx?.credentials?.[role];
  if (!value) {
    throw new WebhookError(
      WEBHOOK_DIAGNOSTIC.WEBHOOK_CREDENTIALS_MISSING,
      `Identifiant « ${role} » absent du coffre pour ce jeu.`,
    );
  }
  return value;
}

/* -------------------------------------------------------------------------- */
/*  STRIPE — /v1/webhook_endpoints (form-encoded, Bearer sk_…)                */
/* -------------------------------------------------------------------------- */

/** Sérialisation form-encoded de Stripe : tableaux `k[0]`, maps `k[clé]`. */
export function stripeForm(fields) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) value.forEach((item, i) => params.append(`${key}[${i}]`, String(item)));
    else if (typeof value === 'object') {
      Object.entries(value).forEach(([k, v]) => params.append(`${key}[${k}]`, String(v)));
    } else params.append(key, String(value));
  }
  return params;
}

async function stripeCall(ctx, path, { method = 'GET', form } = {}) {
  const key = requireCredential(ctx, 'secretKey');
  const base = stripSlash(ctx.credentials.baseUrl || 'https://api.stripe.com');
  const response = await timedFetch(
    `${base}/v1${path}`,
    {
      method,
      headers: {
        Authorization: `Bearer ${key}`,
        ...(form ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
      },
      body: form ? form.toString() : undefined,
    },
    ctx.fetchImpl,
  );
  const json = await readJson(response);
  if (!response.ok) throw remoteError(response, json);
  return json;
}

export const stripeWebhookAdapter = Object.freeze({
  provider: 'STRIPE',

  async list(ctx) {
    const json = await stripeCall(ctx, '/webhook_endpoints?limit=100');
    return (Array.isArray(json?.data) ? json.data : []).map((w) => ({
      id: String(w.id),
      url: w.url ?? '',
      events: Array.isArray(w.enabled_events) ? w.enabled_events : [],
      description: w.description ?? '',
      enabled: w.status !== 'disabled',
    }));
  },

  async create(ctx, { url, events, description }) {
    const json = await stripeCall(ctx, '/webhook_endpoints', {
      method: 'POST',
      form: stripeForm({
        url,
        description,
        enabled_events: events,
        // La métadonnée DOUBLE la description : si un opérateur réécrit la
        // description à la main dans le tableau de bord, le jeton reste
        // lisible ici, et l'endpoint reste reconnaissable comme le nôtre.
        metadata: { managedBy: 'PANEL_CONTROL_PLANE' },
      }),
    });
    // `secret` (whsec_…) n'est rendu QU'ICI, et jamais plus. L'appelant le
    // persiste dans le coffre AVANT toute autre opération.
    return { id: String(json.id), secret: json.secret ?? null };
  },

  async update(ctx, id, { url, events, description }) {
    await stripeCall(ctx, `/webhook_endpoints/${encodeURIComponent(id)}`, {
      method: 'POST',
      form: stripeForm({ url, description, enabled_events: events, disabled: false }),
    });
  },

  async remove(ctx, id) {
    const key = requireCredential(ctx, 'secretKey');
    const base = stripSlash(ctx.credentials.baseUrl || 'https://api.stripe.com');
    const response = await timedFetch(
      `${base}/v1/webhook_endpoints/${encodeURIComponent(id)}`,
      { method: 'DELETE', headers: { Authorization: `Bearer ${key}` } },
      ctx.fetchImpl,
    );
    // 404 : déjà parti. Une suppression idempotente ne se plaint pas de
    // l'absence de ce qu'elle voulait faire disparaître.
    if (!response.ok && response.status !== 404) throw remoteError(response, await readJson(response));
  },
});

/* -------------------------------------------------------------------------- */
/*  BREVO — /v3/webhooks (JSON, en-tête api-key)                              */
/* -------------------------------------------------------------------------- */

async function brevoCall(ctx, path, { method = 'GET', json: body } = {}) {
  const key = requireCredential(ctx, 'apiKey');
  const base = stripSlash(ctx.credentials.baseUrl || 'https://api.brevo.com/v3');
  const response = await timedFetch(
    `${base}${path}`,
    {
      method,
      headers: {
        'api-key': key,
        accept: 'application/json',
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    },
    ctx.fetchImpl,
  );
  return { response, json: await readJson(response) };
}

export const brevoWebhookAdapter = Object.freeze({
  provider: 'BREVO',

  async list(ctx) {
    // Filtré sur `transactional` : sans cela, les webhooks marketing et
    // inbound du même compte passeraient pour des endpoints étrangers.
    const { response, json } = await brevoCall(ctx, '/webhooks?type=transactional');

    /**
     * UNE LISTE VIDE RESSEMBLE À UNE PANNE, CHEZ BREVO.
     *
     * Un compte sans aucun webhook répond 400/404 « Webhook record does not
     * exist » (constat du lot Brevo, `BREVO_WEBHOOK_FACTS`). Traiter cette
     * réponse comme une erreur rendrait la PREMIÈRE configuration impossible :
     * le réconciliateur croirait le fournisseur cassé et n'oserait rien créer.
     *
     * Les signaux viennent du descripteur, pas d'une chaîne codée ici.
     */
    if (!response.ok) {
      const raw = String(json?.message ?? json?.error?.message ?? json?.code ?? '').toLowerCase();
      const signals = ctx.capability?.emptyListSignals ?? [];
      const looksEmpty = response.status < 500 && signals.some((signal) => raw.includes(signal.toLowerCase()));
      if (!looksEmpty) throw remoteError(response, json);
      return [];
    }

    const data = Array.isArray(json?.webhooks) ? json.webhooks : Array.isArray(json) ? json : [];
    return data.map((w) => ({
      id: String(w.id),
      url: w.url ?? '',
      events: Array.isArray(w.events) ? w.events : [],
      description: w.description ?? '',
      enabled: true, // Brevo n'expose pas d'état désactivé sur un webhook.
    }));
  },

  async create(ctx, { url, events, description, secret }) {
    // Brevo ne signe RIEN : le secret est un jeton QUE NOUS POSONS, et qu'il
    // nous renverra dans `Authorization`. C'est donc l'appelant qui le frappe,
    // et ce pilote se contente de le transmettre.
    const { response, json } = await brevoCall(ctx, '/webhooks', {
      method: 'POST',
      json: {
        url,
        description,
        events,
        type: 'transactional',
        ...(secret ? { auth: { type: 'bearer', token: secret } } : {}),
      },
    });
    if (!response.ok) throw remoteError(response, json);
    return { id: String(json.id), secret: secret ?? null };
  },

  async update(ctx, id, { url, events, description, secret }) {
    const { response, json } = await brevoCall(ctx, `/webhooks/${encodeURIComponent(id)}`, {
      method: 'PUT',
      json: {
        url,
        description,
        events,
        ...(secret ? { auth: { type: 'bearer', token: secret } } : {}),
      },
    });
    if (!response.ok) throw remoteError(response, json);
  },

  async remove(ctx, id) {
    const { response, json } = await brevoCall(ctx, `/webhooks/${encodeURIComponent(id)}`, { method: 'DELETE' });
    if (!response.ok && response.status !== 404) throw remoteError(response, json);
  },
});

/* -------------------------------------------------------------------------- */
/*  YOUSIGN — /webhooks (JSON, Bearer, hôte distinct par environnement)       */
/* -------------------------------------------------------------------------- */

async function yousignCall(ctx, path, { method = 'GET', json: body } = {}) {
  const key = requireCredential(ctx, 'apiKey');
  // L'hôte vient du coffre (rôle `baseUrl`, valeur par défaut PAR
  // ENVIRONNEMENT dans le registre). Aucun hôte n'est codé ici : Yousign est
  // devenu Youtrust en 2026-07 et ses hôtes sont à revérifier (registre,
  // `rebrandWatch`). Un hôte en dur rendrait ce changement invisible.
  const base = stripSlash(ctx.credentials.baseUrl);
  if (!base) {
    throw new WebhookError(
      WEBHOOK_DIAGNOSTIC.WEBHOOK_CREDENTIALS_MISSING,
      'URL de base Yousign absente : elle dépend de l’environnement et doit venir du coffre.',
    );
  }
  const response = await timedFetch(
    `${base}${path}`,
    {
      method,
      headers: {
        Authorization: `Bearer ${key}`,
        accept: 'application/json',
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    },
    ctx.fetchImpl,
  );
  return { response, json: await readJson(response) };
}

function mapYousign(w) {
  return {
    id: String(w.id),
    url: w.endpoint ?? w.url ?? '',
    events: Array.isArray(w.subscribed_events) ? w.subscribed_events : [],
    description: w.description ?? '',
    enabled: w.enabled !== false,
  };
}

export const yousignWebhookAdapter = Object.freeze({
  provider: 'YOUSIGN',

  async list(ctx) {
    const { response, json } = await yousignCall(ctx, '/webhooks');
    if (!response.ok) throw remoteError(response, json);
    const data = Array.isArray(json?.data) ? json.data : Array.isArray(json) ? json : [];
    return data.map(mapYousign);
  },

  async create(ctx, { url, events, description, environment }) {
    const { response, json } = await yousignCall(ctx, '/webhooks', {
      method: 'POST',
      json: {
        endpoint: url,
        description,
        // Le drapeau `sandbox` de la SOUSCRIPTION suit le monde servi : une
        // souscription PROD ne doit jamais écouter des événements de bac à
        // sable, ni l'inverse.
        sandbox: String(environment).toUpperCase() === 'TEST',
        subscribed_events: events,
        auto_retry: true,
        enabled: true,
      },
    });
    if (!response.ok) throw remoteError(response, json);
    // `secret_key` n'est rendue qu'à la création — persistée par l'appelant.
    return { id: String(json.id), secret: json.secret_key ?? json.secretKey ?? null };
  },

  async update(ctx, id, { url, events, description }) {
    const { response, json } = await yousignCall(ctx, `/webhooks/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      json: { endpoint: url, description, subscribed_events: events, enabled: true },
    });
    if (!response.ok) throw remoteError(response, json);
  },

  async remove(ctx, id) {
    const { response, json } = await yousignCall(ctx, `/webhooks/${encodeURIComponent(id)}`, { method: 'DELETE' });
    if (!response.ok && response.status !== 404) throw remoteError(response, json);
  },
});

/* -------------------------------------------------------------------------- */
/*  RÉSOLUTION                                                                */
/* -------------------------------------------------------------------------- */

const ADAPTERS = Object.freeze({
  STRIPE: stripeWebhookAdapter,
  BREVO: brevoWebhookAdapter,
  YOUSIGN: yousignWebhookAdapter,
});

/**
 * Pilote d'un fournisseur, ou `null`.
 *
 * `null` pour Hostinger n'est pas un trou : le registre déclare déjà
 * `supported: false`, et le réconciliateur ne demande jamais de pilote pour un
 * fournisseur non supporté. Les deux absences se répondent.
 */
export function webhookAdapterFor(provider) {
  return ADAPTERS[String(provider ?? '').toUpperCase()] ?? null;
}

export default {
  stripeWebhookAdapter,
  brevoWebhookAdapter,
  yousignWebhookAdapter,
  webhookAdapterFor,
  stripeForm,
};
