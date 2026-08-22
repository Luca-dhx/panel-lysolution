// LA REPRISE DES ÉVÉNEMENTS ABANDONNÉS — au démarrage, et sur demande.
//
// docs/architecture/WEBHOOK_CONTROL_PLANE.md §« Reprise après incident ».
//
// ── LES DEUX FILETS, ET POURQUOI IL EN FAUT DEUX ────────────────────────────
//
// 1. LE REJEU DU FOURNISSEUR. Un processus tué n'a répondu à personne : Stripe
//    voit un échec et rejoue. Depuis le bail, ce rejeu REPREND l'événement au
//    lieu d'être refusé comme doublon. C'est le filet principal, il est
//    gratuit, et il couvre le cas nominal du crash.
//
// 2. CE MODULE. Il couvre ce que le rejeu ne couvre pas : le cas où nous avons
//    répondu 200 puis perdu l'effet — un acheminement en échec, une projection
//    financière tombée, un plantage après l'envoi de la réponse. Stripe
//    considère alors la livraison réussie et ne rejouera jamais.
//
// ── D'OÙ VIENT LE CORPS, PUISQU'ON NE LE GARDE PAS ──────────────────────────
//
// De Stripe. `PanelProviderWebhookEvent` ne conserve qu'une empreinte — un
// choix de confidentialité qui tient toujours — mais il conserve
// l'IDENTIFIANT, et Stripe garde ses événements 30 jours. La reprise relit
// donc l'événement à la source : ce qui est rejoué est ce que Stripe a émis,
// et non une reconstitution à partir de nos propres notes.
//
// ── UN SEUL PARCOURS MÉTIER ─────────────────────────────────────────────────
//
// `applyProviderEventEffects` est la fonction que la RÉCEPTION appelle aussi.
// Une seconde implémentation « pour la reprise » aurait divergé en silence, et
// c'est celle qu'on ne relit jamais qui aurait vieilli.
import logger from '../../utils/logger.js';
import PanelProviderWebhookEvent, {
  WEBHOOK_EVENT_STATUS,
} from '../../models/PanelProviderWebhookEvent.model.js';
import { loadProviderCredentials } from './webhookSecrets.js';
import { retrieveEvent, TRANSPORT_CODES } from '../integratedApi/stripe/stripeTransport.js';
import { applyProviderEventEffects } from './webhookIngest.js';
import {
  abandonedFilter, claimWebhookEvent, settleWebhookEvent, classifyWebhookError,
  statusAfterFailure, CLAIM_OUTCOME, ageSeconds,
} from './webhookLease.js';
import { reportWebhookProcessingFailure, reportAbandonedSweep } from './webhookSupervision.js';

/**
 * ══ SEUL STRIPE EST REJOUABLE — ET LE BALAYAGE NE REGARDE QUE LUI ═══════════
 *
 * Brevo n'expose pas ses événements en lecture, OpenSign non plus. Pour eux,
 * une ligne abandonnée n'appelle aucun geste de notre part : nous n'avons
 * aucun moyen d'en retrouver le contenu, et leur propre mécanique de rejeu est
 * la seule réparation qui existe.
 *
 * ── LE DÉFAUT MESURÉ SUR LA PILE DÉPLOYÉE ──────────────────────────────────
 *
 * Le balayage les réclamait quand même, échouait sur
 * `WEBHOOK_REPLAY_UNSUPPORTED`, et écrivait `FAILED` — un état REPRENABLE.
 * Le passage suivant les reprenait donc, échouait de nouveau, et ainsi de suite
 * jusqu'au plafond :
 *
 *     BREVO/WEBHOOK_REPLAY_UNSUPPORTED = 30   (4 tentatives)
 *     OPENSIGN/WEBHOOK_REPLAY_UNSUPPORTED = 9
 *
 * Trente-neuf événements parfaitement traités marchaient vers `DEAD_LETTER`, et
 * la supervision allait annoncer trente-neuf incidents qui n'existaient pas.
 * Une file d'alerte qu'on apprend à ignorer ne protège plus de rien.
 *
 * Le filtre est donc posé sur le BALAYAGE, pas seulement dans le rejeu : on ne
 * réclame pas un travail qu'on ne peut pas faire.
 */
const FOURNISSEURS_REJOUABLES = Object.freeze(['STRIPE']);

/**
 * Borne de balayage. Un démarrage ne doit pas se transformer en rattrapage de
 * plusieurs minutes : au-delà, la supervision porte le reste, et le passage
 * suivant le reprendra.
 */
const LOT_MAX = 50;

/**
 * REJOUER UN ÉVÉNEMENT — réclamation, relecture chez Stripe, effets, conclusion.
 *
 * La réclamation passe par le MÊME chemin atomique que la réception : si un
 * autre processus vient de reprendre cet événement, on ne le double pas.
 *
 * @returns {Promise<{outcome: string, status: string|null}>}
 */
export async function replayWebhookEvent(evenement, { fetchImpl } = {}) {
  const cle = {
    provider: evenement.provider,
    environment: evenement.environment,
    providerEventId: evenement.providerEventId,
  };

  const reclamation = await claimWebhookEvent({ Model: PanelProviderWebhookEvent, key: cle, seed: {} });
  if (reclamation.outcome !== CLAIM_OUTCOME.RECLAIMED) {
    /**
     * `CLAIMED` serait anormal ici — la ligne existait au balayage. `IN_FLIGHT`
     * et `TERMINAL` sont au contraire des issues normales et heureuses : entre
     * le balayage et maintenant, quelqu'un a fait le travail.
     */
    return { outcome: reclamation.outcome, status: null };
  }

  const conclure = async (status, error = null) => {
    await settleWebhookEvent({ Model: PanelProviderWebhookEvent, key: cle, status, error });
    return { outcome: reclamation.outcome, status };
  };

  if (!FOURNISSEURS_REJOUABLES.includes(String(evenement.provider).toUpperCase())) {
    /**
     * On rend le bail plutôt que de conclure : l'événement reste `FAILED`, donc
     * reprenable par le fournisseur, et la supervision dit pourquoi nous, nous
     * ne pouvons rien faire.
     */
    return conclure(WEBHOOK_EVENT_STATUS.FAILED, {
      code: 'WEBHOOK_REPLAY_UNSUPPORTED',
      message: `${evenement.provider} n’expose pas ses événements en relecture.`,
      retryable: true,
    });
  }

  let source;
  try {
    const credentials = await loadProviderCredentials(evenement.provider, evenement.environment);
    const { event } = await retrieveEvent({ credentials, eventId: evenement.providerEventId, fetchImpl });
    source = event;
  } catch (err) {
    /**
     * UN 404 N'EST PAS UNE PANNE — c'est une RÉPONSE, et elle est définitive.
     *
     * Stripe purge ses événements au bout de 30 jours. Le transport traduit
     * cela en `NOT_FOUND`, non reprenable ; le laisser passer pour un échec
     * ordinaire consommerait cinq tentatives avant d'aboutir au même endroit,
     * en disant « panne » là où la vérité est « il n'existe plus ».
     */
    if (err?.code === TRANSPORT_CODES.NOT_FOUND) {
      source = null;
    } else {
      const cause = classifyWebhookError(err);
      const statut = statusAfterFailure({ retryable: cause.retryable, attempts: reclamation.attempts });
      await reportWebhookProcessingFailure({
        ...cle,
        eventType: evenement.eventType,
        projectId: evenement.projectId ?? null,
        attempts: reclamation.attempts,
        status: statut,
        cause: { ...cause, message: `relecture chez le fournisseur : ${cause.message}` },
      }).catch(() => null);
      return conclure(statut, cause);
    }
  }

  /**
   * L'ÉVÉNEMENT N'EXISTE PLUS CHEZ LE FOURNISSEUR — et c'est terminal.
   *
   * Passé 30 jours, Stripe l'a purgé. Réessayer indéfiniment un identifiant qui
   * ne reviendra jamais est exactement la boucle que `DEAD_LETTER` existe pour
   * empêcher. On renonce, et on le DIT.
   */
  if (!source || source.object !== 'event') {
    await reportWebhookProcessingFailure({
      ...cle,
      eventType: evenement.eventType,
      projectId: evenement.projectId ?? null,
      attempts: reclamation.attempts,
      status: WEBHOOK_EVENT_STATUS.DEAD_LETTER,
      cause: {
        code: 'WEBHOOK_EVENT_GONE',
        message: 'introuvable chez le fournisseur (purge au-delà de 30 jours)',
        retryable: false,
      },
    }).catch(() => null);
    return conclure(WEBHOOK_EVENT_STATUS.DEAD_LETTER, {
      code: 'WEBHOOK_EVENT_GONE',
      message: 'introuvable chez le fournisseur',
      retryable: false,
    });
  }

  const effets = await applyProviderEventEffects({
    provider: evenement.provider,
    environment: evenement.environment,
    eventType: source.type ?? evenement.eventType,
    providerEventId: evenement.providerEventId,
    payload: source,
  });

  if (effets.echecs.length === 0) {
    await settleWebhookEvent({
      Model: PanelProviderWebhookEvent,
      key: cle,
      status: WEBHOOK_EVENT_STATUS.PROCESSED,
      patch: effets.verdictAppartenance,
    });
    logger.info(
      `[webhooks] ${evenement.providerEventId} (${source.type}) REPRIS et appliqué `
      + `à la tentative ${reclamation.attempts}.`,
    );
    return { outcome: reclamation.outcome, status: WEBHOOK_EVENT_STATUS.PROCESSED };
  }

  const cause = classifyWebhookError(effets.echecs[0].err);
  const statut = statusAfterFailure({ retryable: cause.retryable, attempts: reclamation.attempts });
  await settleWebhookEvent({
    Model: PanelProviderWebhookEvent,
    key: cle,
    status: statut,
    patch: effets.verdictAppartenance,
    error: { ...cause, message: `${effets.echecs[0].etape} : ${cause.message}` },
  });
  await reportWebhookProcessingFailure({
    ...cle,
    eventType: source.type ?? evenement.eventType,
    projectId: effets.appartenance?.projectId ?? evenement.projectId ?? null,
    attempts: reclamation.attempts,
    status: statut,
    cause,
  }).catch(() => null);
  return { outcome: reclamation.outcome, status: statut };
}

/**
 * ══ LE BALAYAGE — appelé à l'AMORÇAGE, avant tout worker ════════════════════
 *
 * Il ne lève jamais : un rattrapage impossible ne doit pas empêcher un backend
 * de démarrer. Il RAPPORTE, et c'est ce rapport que l'amorçage journalise.
 *
 * @returns {Promise<{scanned: number, recovered: number, failed: number, skipped: number}>}
 */
export async function recoverAbandonedWebhookEvents({
  environment = null, limit = LOT_MAX, now = Date.now(), fetchImpl,
} = {}) {
  const filtre = {
    /** On ne réclame QUE ce qu'on peut rejouer — voir `FOURNISSEURS_REJOUABLES`. */
    provider: { $in: FOURNISSEURS_REJOUABLES },
    ...abandonedFilter(now),
    ...(environment ? { environment } : {}),
  };

  const abandonnes = await PanelProviderWebhookEvent.find(filtre)
    .sort({ receivedAt: 1 })
    .limit(limit)
    .lean();

  if (abandonnes.length === 0) return { scanned: 0, recovered: 0, failed: 0, skipped: 0 };

  let recovered = 0;
  let failed = 0;
  let skipped = 0;
  for (const evenement of abandonnes) {
    // eslint-disable-next-line no-await-in-loop
    const r = await replayWebhookEvent(evenement, { fetchImpl }).catch((err) => {
      logger.error(`[webhooks] reprise impossible pour ${evenement.providerEventId} — ${err?.message ?? 'erreur inconnue'}.`);
      return { outcome: 'ERROR', status: null };
    });
    if (r.status === WEBHOOK_EVENT_STATUS.PROCESSED) recovered += 1;
    else if (r.outcome === CLAIM_OUTCOME.RECLAIMED) failed += 1;
    else skipped += 1;
  }

  await reportAbandonedSweep({ environment, abandoned: abandonnes, recovered, now }).catch(() => null);
  logger.warn(
    `[webhooks] reprise au démarrage : ${abandonnes.length} abandonné(s), `
    + `${recovered} réappliqué(s), ${failed} en échec, ${skipped} pris ailleurs `
    + `(le plus ancien : ${ageSeconds(abandonnes[0], now) ?? '?'} s).`,
  );
  return { scanned: abandonnes.length, recovered, failed, skipped };
}

export default { replayWebhookEvent, recoverAbandonedWebhookEvents };
