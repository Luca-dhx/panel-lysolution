// DIAGNOSTIC WEBHOOK — la surface interne, authentifiée (L5).
//
// ── CE QU'ELLE REND, ET CE QU'ELLE NE RENDRA JAMAIS ─────────────────────────
//
// Elle rend : le fournisseur, l'état, la callback canonique, la dérive, les
// dates, le dernier diagnostic, et un BOOLÉEN pour le secret.
//
// Elle ne rend jamais : un secret, une empreinte de secret, un masque de
// secret, une clé d'API, une charge utile d'événement. Le service ne les
// produit pas — cette absence est structurelle, pas défensive.
//
// La callback, elle, s'affiche EN CLAIR : c'est une adresse publique qu'un
// fournisseur connaît déjà, et la masquer empêcherait de la comparer à ce que
// le tableau de bord du fournisseur montre — c'est-à-dire d'exploiter.
import ApiError from '../utils/ApiError.js';
import {
  describeWebhookState,
  describeAllWebhookStates,
  reconcileProviderWebhook,
  reconcileAllProviderWebhooks,
} from '../services/webhooks/webhookReconciler.js';
import { runtimeEnvironment } from '../services/integratedApi/environment.js';
import { isKnownProvider } from '../services/integratedApi/providerRegistry.js';

/** GET /api/webhook-control-plane */
export async function listWebhookStates(req, res) {
  const environment = runtimeEnvironment();
  res.json({
    /** L'environnement N'EST PAS un paramètre : c'est celui de l'instance. */
    environment,
    items: await describeAllWebhookStates({ environment }),
  });
}

/** GET /api/webhook-control-plane/:provider */
export async function getWebhookState(req, res) {
  assertKnown(req.params.provider);
  res.json(await describeWebhookState(req.params.provider, { environment: runtimeEnvironment() }));
}

/**
 * POST /api/webhook-control-plane/reconcile
 *
 * DEV uniquement : c'est une ÉCRITURE chez un tiers. Elle crée, met à jour ou
 * retire un endpoint sur un compte fournisseur réel.
 */
export async function reconcileAll(req, res) {
  res.json(await reconcileAllProviderWebhooks({ environment: runtimeEnvironment() }));
}

/** POST /api/webhook-control-plane/:provider/reconcile */
export async function reconcileOne(req, res) {
  assertKnown(req.params.provider);
  res.json(await reconcileProviderWebhook({
    provider: req.params.provider,
    environment: runtimeEnvironment(),
  }));
}

function assertKnown(provider) {
  if (!isKnownProvider(provider)) {
    throw ApiError.notFound(
      'PANEL_INTEGRATED_API_UNKNOWN_PROVIDER',
      `Fournisseur inconnu : « ${provider} ». Le registre est code-first.`,
    );
  }
}

export default { listWebhookStates, getWebhookState, reconcileAll, reconcileOne };
