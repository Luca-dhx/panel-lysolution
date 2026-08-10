// LA CALLBACK — une seule fabrique d'URL, et elle ne devine rien.
//
// docs/architecture/WEBHOOK_CONTROL_PLANE.md §« Callback ».
//
// ── CE QUI EST INTERDIT, ET POURQUOI ────────────────────────────────────────
//
// Pas de domaine codé en dur. Pas de `req.headers.host`. Pas d'URL construite
// depuis le nom d'un projet. Une callback est une adresse qu'on DONNE à un
// tiers : s'il l'apprend fausse, il l'appellera fausse pendant des mois, et
// l'erreur ne se verra qu'en l'absence d'événements — c'est-à-dire dans le
// silence, la panne la plus longue à diagnostiquer.
//
// La seule source est `networkConfig.service.js`, qui applique déjà la règle de
// priorité canonique (configuration système → PUBLIC_URL → défaut local) et
// refuse une adresse locale en PROD.
//
// ── LES DEUX MONDES NE SE CROISENT JAMAIS ───────────────────────────────────
//
// Une instance de Panel TEST ne peut pas fabriquer la callback PROD : elle n'a
// pas l'adresse publique de l'autre instance, et l'inventer produirait
// exactement l'accident qu'on cherche à rendre impossible — des événements de
// production livrés à une recette. La demande est donc REFUSÉE, pas approximée.
import ApiError from '../../utils/ApiError.js';
import { resolveBackendUrl } from '../network/networkConfig.service.js';
import { runtimeEnvironment } from '../integratedApi/environment.js';
import { webhookCapability } from './webhookRegistry.js';
import { WEBHOOK_DIAGNOSTIC } from './webhookDiagnostics.js';

/**
 * Racine des routes entrantes. HORS de `/api` : ce n'est pas la surface
 * interne du Panel, c'est une surface publique appelée par des tiers, montée
 * AVANT `express.json()` parce que la vérification de signature exige le corps
 * brut, octet pour octet.
 */
export const WEBHOOK_ROUTE_ROOT = '/webhooks/providers';

/** Chemin de la callback d'un fournisseur. Relatif — jamais un domaine. */
export function callbackPath(capability) {
  return `${WEBHOOK_ROUTE_ROOT}/${capability.callbackSlug}`;
}

/** Chemin de la sonde anonyme, sans effet de bord. */
export function healthPath(capability) {
  return `${callbackPath(capability)}/health`;
}

/** Assemble une URL absolue depuis une racine publique déjà validée. */
export function buildCallbackUrl({ backendUrl, capability }) {
  const base = String(backendUrl ?? '').trim().replace(/\/+$/, '');
  if (!base) return '';
  return `${base}${callbackPath(capability)}`;
}

/**
 * La callback CANONIQUE d'un fournisseur, pour l'environnement servi ici.
 *
 * @returns {Promise<{
 *   provider: string, environment: string, url: string, backendUrl: string|null,
 *   source: string, ready: boolean, code: string|null
 * }>}
 *
 * `ready: false` n'est pas une erreur : un Panel fraîchement installé n'a pas
 * encore d'adresse publique, et le réconciliateur doit pouvoir le CONSTATER
 * sans lever. Le refus dur est réservé au désaccord d'environnement.
 */
export async function resolveWebhookCallback(provider, {
  environment = runtimeEnvironment(),
  resolve = resolveBackendUrl,
} = {}) {
  const capability = webhookCapability(provider);
  if (!capability) {
    throw ApiError.notFound(
      WEBHOOK_DIAGNOSTIC.WEBHOOK_PROVIDER_UNKNOWN,
      `Callback impossible : « ${provider} » n’est pas au registre des fournisseurs.`,
    );
  }

  assertCallbackEnvironment(environment);

  if (!capability.supported) {
    return {
      provider: capability.provider,
      environment,
      url: '',
      backendUrl: null,
      source: 'NONE',
      ready: false,
      code: WEBHOOK_DIAGNOSTIC.WEBHOOK_UNSUPPORTED,
    };
  }

  const { url: backendUrl, source } = await resolve();
  const url = buildCallbackUrl({ backendUrl, capability });

  return {
    provider: capability.provider,
    environment,
    url,
    backendUrl: backendUrl ?? null,
    source,
    ready: Boolean(url),
    code: url ? null : WEBHOOK_DIAGNOSTIC.WEBHOOK_CALLBACK_NOT_PUBLIC,
  };
}

/**
 * FAIL CLOSED — cette instance sert-elle bien le monde demandé ?
 *
 * Enregistrer une callback, c'est écrire chez un tiers une adresse qui recevra
 * de VRAIS événements. Le provisionnement d'identifiants tolère les deux mondes
 * (`assertAdministrableEnvironment`) ; l'écriture d'une callback, non : elle est
 * une action réelle, dont l'effet survit à la session.
 */
export function assertCallbackEnvironment(requested, { runtime = runtimeEnvironment() } = {}) {
  if (requested !== runtime) {
    throw ApiError.conflict(
      WEBHOOK_DIAGNOSTIC.WEBHOOK_CALLBACK_ENVIRONMENT_MISMATCH,
      `Refusé : cette instance sert ${runtime}. Elle ne peut pas enregistrer `
      + `la callback ${requested} — elle n’a pas l’adresse publique de l’autre `
      + `instance, et l’inventer livrerait les événements ${requested} ici.`,
    );
  }
  return requested;
}

/**
 * Deux URLs désignent-elles le MÊME endpoint ?
 *
 * La comparaison est faite sur l'URL normalisée (schéma, hôte en minuscules,
 * chemin sans barre finale). Une comparaison de chaînes brutes signalerait une
 * dérive pour un `https://x.fr/webhooks/providers/stripe/` qui n'en est pas une,
 * et le réconciliateur repousserait un `update` inutile à chaque passage.
 */
export function sameCallback(a, b) {
  const normalize = (value) => {
    const text = String(value ?? '').trim();
    if (!text) return '';
    try {
      const parsed = new URL(text);
      const path = parsed.pathname.replace(/\/+$/, '') || '/';
      return `${parsed.protocol}//${parsed.host.toLowerCase()}${path}${parsed.search}`;
    } catch {
      return text.replace(/\/+$/, '');
    }
  };
  const left = normalize(a);
  const right = normalize(b);
  return Boolean(left) && left === right;
}

export default {
  WEBHOOK_ROUTE_ROOT,
  callbackPath,
  healthPath,
  buildCallbackUrl,
  resolveWebhookCallback,
  assertCallbackEnvironment,
  sameCallback,
};
