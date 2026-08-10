// CONTRÔLEURS DE LA SURFACE ENTRANTE — traduction issue → statut HTTP (L5).
//
// ── POURQUOI CES STATUTS-LÀ ─────────────────────────────────────────────────
//
//   200  reçu, ou déjà connu. Un doublon est un SUCCÈS : le fournisseur a fait
//        son travail, et nous aussi. Répondre autre chose le ferait rejouer.
//   401  refusé. Un seul code pour « signature fausse », « secret absent » et
//        « en-tête manquant » — la nuance renseignerait un tiers.
//   404  segment inconnu, ou aucun binding. Là encore un seul code : dire
//        « provider connu mais non configuré » révèle notre configuration.
//
// Aucune 5xx volontaire : une 500 sur un endpoint de webhook déclenche le
// backoff du fournisseur, et un incident de persistance devient une tempête
// de rejeux. Le service ne lève pas, et ce contrôleur non plus.
import { ingestProviderEvent, INGEST_OUTCOME } from '../services/webhooks/webhookIngest.js';
import { capabilityByCallbackSlug } from '../services/webhooks/webhookRegistry.js';

/** POST /webhooks/providers/:slug */
export async function receiveProviderWebhook(req, res) {
  const result = await ingestProviderEvent({
    slug: req.params.slug,
    // `express.raw()` garantit un Buffer. Le repli couvre un montage fautif —
    // mieux vaut une signature qui échoue qu'une vérification qui saute.
    rawBody: Buffer.isBuffer(req.body) ? req.body : Buffer.from(String(req.body ?? ''), 'utf8'),
    headers: req.headers,
  });

  switch (result.outcome) {
    case INGEST_OUTCOME.ACCEPTED:
      return res.status(200).json({ received: true, duplicate: false });
    case INGEST_OUTCOME.DUPLICATE:
      // Le rejeu est absorbé, aucun effet supplémentaire n'a eu lieu.
      return res.status(200).json({ received: true, duplicate: true });
    case INGEST_OUTCOME.REJECTED:
      return res.status(401).json({ received: false });
    default:
      return res.status(404).json({ received: false });
  }
}

/**
 * GET /webhooks/providers/:slug/health
 *
 * Sonde ANONYME et SANS EFFET DE BORD : elle sert à vérifier, depuis
 * l'extérieur, que la route existe et répond — rien de plus. Elle ne dit ni si
 * un endpoint est configuré, ni si un secret est en place, ni quand le dernier
 * événement est arrivé. Ces trois réponses appartiennent à la surface
 * authentifiée.
 */
export async function probeProviderWebhook(req, res) {
  const capability = capabilityByCallbackSlug(req.params.slug);
  if (!capability) return res.status(404).json({ ok: false });
  return res.status(200).json({ ok: true, provider: capability.provider });
}

export default { receiveProviderWebhook, probeProviderWebhook };
