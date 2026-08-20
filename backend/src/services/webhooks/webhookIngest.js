// RÉCEPTION D'UN ÉVÉNEMENT FOURNISSEUR — vérifier, dédupliquer, journaliser.
//
// docs/architecture/WEBHOOK_CONTROL_PLANE.md §« Endpoint entrant ».
//
// ── L'ORDRE EST LA SÉCURITÉ ─────────────────────────────────────────────────
//
//   1. le SEGMENT d'URL désigne le fournisseur          (sans ambiguïté)
//   2. l'ENVIRONNEMENT est celui de l'instance          (jamais le corps)
//   3. le BINDING du plan de contrôle désigne la suite  (jamais le corps)
//   4. la SIGNATURE est vérifiée sur les octets bruts   (avant tout parse utile)
//   5. l'IDEMPOTENCE tranche                            (index unique, pas findOne)
//   6. on JOURNALISE, et on s'arrête là
//
// ── CE QUE LE CORPS NE DÉCIDE JAMAIS ────────────────────────────────────────
//
// Ni le projet destinataire, ni l'environnement, ni le fournisseur. Un webhook
// est une entrée NON AUTHENTIFIÉE tant que sa signature n'est pas vérifiée, et
// même vérifiée, il vient du fournisseur — pas de notre plan de contrôle. Un
// `projectId` glissé dans une charge utile ne doit désigner personne : c'est
// exactement le chemin par lequel un tiers ferait router ses événements vers le
// projet de son choix.
//
// Le routage vient du BINDING, c'est-à-dire d'un enregistrement que le Panel a
// écrit lui-même en réconciliant. Rien d'autre.
//
// ── OÙ S'ARRÊTE CE FICHIER ──────────────────────────────────────────────────
//
// À l'étape 6, puis un ACHEMINEMENT délégué (L8.4) : l'événement vérifié et
// unique part vers le projet qui a demandé l'envoi. La traduction en verbe
// métier vit dans `emailDeliveryDispatch.js` — un fournisseur par module, pour
// que la table de correspondance d'un lot n'entre jamais dans le moteur
// générique. Écrire ici `checkout.session.completed → PAYMENT_SUCCEEDED`
// reviendrait à faire L6 sous un autre nom.
import logger from '../../utils/logger.js';
import { nowIso } from '../../bridge/bridgeContract.js';
import PanelIntegratedApiWebhookBinding, {
  WEBHOOK_DESTINATION,
} from '../../models/PanelIntegratedApiWebhookBinding.model.js';
import PanelProviderWebhookEvent, {
  WEBHOOK_EVENT_STATUS,
} from '../../models/PanelProviderWebhookEvent.model.js';
import { runtimeEnvironment } from '../integratedApi/environment.js';
import { capabilityByCallbackSlug } from './webhookRegistry.js';
import { loadVerificationSecrets } from './webhookSecrets.js';
import {
  verifyWebhookSignature, extractEventIdentity, parseJsonBody,
  diagnoseHmacRepresentation, readHeader,
} from './webhookSignature.js';
import { WEBHOOK_DIAGNOSTIC } from './webhookDiagnostics.js';
import { dispatchDeliveryEvent } from './emailDeliveryDispatch.js';
import { dispatchSignatureEvent } from './signatureEventDispatch.js';
import { resolveStripeEventOwnership, EVENT_OWNERSHIP } from './stripeEventRouting.js';
import { adoptSubscriptionFromSession } from '../integratedApi/stripe/stripeSubscriptionAdoption.js';
import {
  convergePendingFactsFor,
  recordStripeRevenueEvent,
} from '../finance/providerRevenue/revenueProjection.service.js';

/** Issues d'une réception. Traduites en statut HTTP par le contrôleur. */
export const INGEST_OUTCOME = Object.freeze({
  ACCEPTED: 'ACCEPTED',
  DUPLICATE: 'DUPLICATE',
  UNKNOWN_PROVIDER: 'UNKNOWN_PROVIDER',
  NO_BINDING: 'NO_BINDING',
  REJECTED: 'REJECTED',
});

/**
 * Traite un appel entrant.
 *
 * @param {object} args
 * @param {string} args.slug      segment d'URL — la SEULE désignation du provider
 * @param {Buffer} args.rawBody   octets reçus, non reparsés
 * @param {object} args.headers
 * @returns {Promise<{outcome: string, provider: string|null, duplicate: boolean, code: string|null}>}
 *
 * NE LÈVE PAS : un endpoint public qui lève produit une 500, et une 500 fait
 * rejouer le fournisseur en boucle. Toute issue est une valeur de retour.
 */
export async function ingestProviderEvent({ slug, rawBody, headers, environment = runtimeEnvironment() } = {}) {
  const capability = capabilityByCallbackSlug(slug);
  if (!capability) {
    return {
      outcome: INGEST_OUTCOME.UNKNOWN_PROVIDER,
      provider: null,
      duplicate: false,
      code: WEBHOOK_DIAGNOSTIC.WEBHOOK_PROVIDER_UNKNOWN,
    };
  }
  const provider = capability.provider;

  // ── LE ROUTAGE VIENT DU PLAN DE CONTRÔLE ────────────────────────────────
  // Pas de binding = le Panel n'a jamais enregistré d'endpoint pour ce couple.
  // Accepter quand même reviendrait à traiter des événements dont on ne peut
  // pas dire d'où ils viennent.
  const binding = await PanelIntegratedApiWebhookBinding.findOne({
    provider,
    environment,
    destination: WEBHOOK_DESTINATION.PANEL,
    projectId: null,
  }).lean();
  if (!binding) {
    logger.warn(`[webhooks] ${provider}/${environment} : appel entrant sans binding connu — refusé.`);
    return {
      outcome: INGEST_OUTCOME.NO_BINDING,
      provider,
      duplicate: false,
      code: WEBHOOK_DIAGNOSTIC.WEBHOOK_BINDING_UNKNOWN,
    };
  }

  // ── VÉRIFICATION, SUR LES OCTETS ────────────────────────────────────────
  //
  // `secretRotatedAt` vient du BINDING, pas d'une horloge locale : c'est lui
  // qui décide si l'ancien secret est encore accepté. Un événement produit
  // avant une rotation et livré après doit passer — sinon il est perdu, et
  // aucun fournisseur ne le rejouera une fois refusé pour de bon.
  const secrets = await loadVerificationSecrets(provider, environment, {
    rotatedAt: binding.secretRotatedAt ?? null,
  });
  const signature = verifyWebhookSignature(capability, { rawBody, headers, secrets });
  if (!signature.verified) {
    // Le motif est journalisé, jamais renvoyé : distinguer « mauvaise
    // signature » de « secret absent » côté appelant renseignerait un attaquant
    // sur l'état de notre configuration.
    /**
     * ── UN `MISMATCH` NE DIT PAS ASSEZ POUR AGIR ──────────────────────────
     *
     * Trois causes produisent le même mot : une clé qui n'est pas la bonne, un
     * appel falsifié, et un fournisseur qui signe une RE-SÉRIALISATION du corps
     * plutôt que les octets émis. Les trois appellent des gestes opposés, et
     * `MISMATCH` ne permet pas de choisir — c'est ce qui pousse, au bout de
     * deux heures, à « désactiver temporairement la vérification ».
     *
     * Le diagnostic ci-dessous n'accepte RIEN : il nomme, dans le journal
     * seulement, la représentation qui aurait correspondu. Le refus, lui, est
     * déjà prononcé et ne bouge pas.
     */
    let representation = null;
    if (signature.reason === 'MISMATCH' && capability.signatureScheme === 'HMAC_SHA256_BODY') {
      representation = diagnoseHmacRepresentation({
        rawBody,
        headers,
        signatureHeader: readHeader(headers, capability.signatureHeader),
        secrets,
      });
    }
    logger.warn(
      `[webhooks] ${provider}/${environment} : appel refusé (${signature.reason})`
      + `${representation?.matched ? ` — le fournisseur signe « ${representation.matched} », pas les octets reçus` : ''}.`,
    );
    return {
      outcome: INGEST_OUTCOME.REJECTED,
      provider,
      duplicate: false,
      code: WEBHOOK_DIAGNOSTIC.WEBHOOK_SIGNATURE_REJECTED,
    };
  }

  const parsed = parseJsonBody(rawBody);
  const identity = extractEventIdentity(capability, { rawBody, parsed, environment });

  // ── IDEMPOTENCE — c'est l'INDEX qui tranche ─────────────────────────────
  // Un `findOne` préalable laisserait passer deux livraisons concurrentes du
  // même événement : toutes deux le trouveraient absent. Seule la contrainte
  // unique arbitre, et son refus EST la preuve du doublon.
  let duplicate = false;
  try {
    await PanelProviderWebhookEvent.create({
      provider,
      environment,
      providerEventId: identity.providerEventId,
      bindingId: binding.bindingId,
      eventType: identity.eventType,
      payloadHash: identity.payloadHash,
      signatureVerified: signature.proven,
      status: WEBHOOK_EVENT_STATUS.RECEIVED,
      receivedAt: nowIso(),
    });
  } catch (err) {
    if (err?.code === 11000) duplicate = true;
    else {
      // Une panne de persistance n'est pas un refus : on ne peut pas garantir
      // l'unicité, donc on ne confirme pas. Le fournisseur rejouera.
      logger.error(`[webhooks] ${provider}/${environment} : enregistrement impossible — ${err?.message ?? 'erreur inconnue'}.`);
      return {
        outcome: INGEST_OUTCOME.REJECTED,
        provider,
        duplicate: false,
        code: WEBHOOK_DIAGNOSTIC.WEBHOOK_REMOTE_ERROR,
      };
    }
  }

  await PanelIntegratedApiWebhookBinding.updateOne(
    { bindingId: binding.bindingId },
    {
      $set: {
        lastEventAt: nowIso(),
        lastEventType: identity.eventType,
        updatedAt: nowIso(),
      },
      $inc: duplicate ? { duplicatesIgnored: 1 } : { eventsReceived: 1 },
    },
  );

  /**
   * ── À QUI EST-IL ? (L6.2C) ──────────────────────────────────────────────
   *
   * Résolu APRÈS la signature et APRÈS l'idempotence, et ENREGISTRÉ sur
   * l'événement — y compris quand la réponse est « à personne ». Un événement
   * non attribué qu'on ne consigne pas est un événement perdu, et une perte
   * silencieuse est la pire des issues sur un flux financier.
   *
   * Aucune mutation métier n'en découle dans ce lot : pendant la coexistence,
   * le projet reçoit les mêmes événements sur son propre endpoint. Appliquer
   * ici le même fait une seconde fois le doublerait.
   *
   * SAUTÉ SUR UN REJEU, comme l'acheminement plus bas. Un doublon a déjà été
   * résolu à son premier passage, et son verdict est en base : le recalculer
   * réécrirait les mêmes champs pour rien, et surtout cela romprait la règle
   * que tout ce fichier applique — après l'idempotence, un rejeu ne produit
   * plus aucun effet, pas même un effet inoffensif.
   */
  const appartenance = duplicate ? null : await resolveStripeEventOwnership({
    provider, environment, eventType: identity.eventType, payload: parsed,
  }).catch((err) => {
    logger.error(`[webhooks] appartenance non résolue — ${err?.message ?? 'erreur inconnue'}.`);
    return null;
  });

  /**
   * ── ADOPTION DE L'ABONNEMENT (L6.2F) ────────────────────────────────────
   *
   * APRÈS que l'appartenance de la SESSION a été établie, et jamais avant :
   * c'est elle qui fournit la filiation. Un abonnement ne doit à aucun moment
   * être routé vers un projet dont on n'aurait pas d'abord prouvé qu'il possède
   * la session qui l'a produit.
   *
   * L'adoption est donc ici, entre la résolution et l'enregistrement — et elle
   * est BEST-EFFORT : un endpoint public qui lève produit une 500, et une 500
   * fait rejouer le fournisseur en boucle.
   */
  let adoption = null;
  if (appartenance?.ownership === EVENT_OWNERSHIP.OWNED
    && appartenance.resourceType === 'CHECKOUT_SESSION') {
    adoption = await adoptSubscriptionFromSession({
      environment,
      session: parsed?.data?.object ?? null,
      source: 'LEARNED_FROM_WEBHOOK',
    }).catch((err) => {
      logger.error(`[webhooks] adoption d’abonnement impossible — ${err?.message ?? 'erreur inconnue'}.`);
      return null;
    });
  }

  /**
   * ── PROJECTION FINANCIÈRE (L10.3) ───────────────────────────────────────
   *
   * L'événement est vérifié, unique, et son appartenance est résolue. S'il
   * porte de l'argent RÉELLEMENT encaissé, il devient un fait financier
   * normalisé, puis une transaction du registre — le même registre que les
   * revenus manuels et les coûts, jamais un second.
   *
   * ── POURQUOI ICI, ET PAS DANS UNE ROUTE D'ÉCRAN ─────────────────────────
   * Le CDC demande que le Panel converge sans action manuelle. Une projection
   * déclenchée par l'ouverture d'une page ferait dépendre l'existence d'un
   * revenu du fait que quelqu'un la regarde.
   *
   * ── APRÈS L'IDEMPOTENCE, ET APRÈS L'ADOPTION ────────────────────────────
   * Après l'idempotence : un rejeu n'arrive pas jusqu'ici, donc il ne peut pas
   * produire un second exemplaire du même euro. Après l'adoption : c'est elle
   * qui vient, peut-être, de rendre l'abonnement possédé — et donc de rendre
   * projetable une facture reçue plus tôt.
   *
   * ── BEST-EFFORT ASSUMÉ ──────────────────────────────────────────────────
   * Une projection qui échoue ne doit pas faire répondre 500 à Stripe, qui
   * rejouerait en boucle. Le fait est retenu et la convergence le reprendra ;
   * le service ne lève d'ailleurs jamais.
   */
  if (!duplicate) {
    await recordStripeRevenueEvent({
      environment,
      eventType: identity.eventType,
      payload: parsed,
      providerEventId: identity.providerEventId,
    }).catch((err) => {
      logger.error(`[webhooks] projection financière impossible — ${err?.message ?? 'erreur inconnue'}.`);
      return null;
    });

    /**
     * L'ADOPTION VIENT DE CRÉER UN LIEN : les faits qui l'attendaient peuvent
     * enfin trouver leur projet. C'est le cas d'une facture arrivée AVANT la
     * session qui l'a produite — Stripe n'ordonne pas ses livraisons.
     */
    if (adoption?.subscriptionId) {
      await convergePendingFactsFor({
        environment,
        resourceType: 'SUBSCRIPTION',
        resourceId: adoption.subscriptionId,
      }).catch((err) => {
        logger.error(`[webhooks] convergence financière impossible — ${err?.message ?? 'erreur inconnue'}.`);
        return null;
      });
    }
  }

  if (appartenance && appartenance.ownership !== EVENT_OWNERSHIP.NOT_ROUTABLE) {
    await PanelProviderWebhookEvent.updateOne(
      { provider, environment, providerEventId: identity.providerEventId },
      {
        $set: {
          projectId: appartenance.projectId,
          ownership: appartenance.ownership,
          claimMismatch: appartenance.claimMismatch,
        },
      },
    ).catch(() => {});
  }

  // ── ACHEMINEMENT MÉTIER (L8.4) ──────────────────────────────────────────
  //
  // L'événement est vérifié, unique et daté. Il peut donc partir vers le
  // projet qui a demandé l'envoi — retrouvé par l'identifiant de message que
  // NOUS avons persisté à l'émission, jamais par le corps du webhook.
  //
  // APRÈS l'idempotence, et c'est l'ordre qui compte : un rejeu du fournisseur
  // n'arrive pas jusqu'ici, donc le journal durable du projet ne peut pas
  // recevoir deux fois le même fait.
  //
  // Best-effort ASSUMÉ : un acheminement qui échoue ne doit pas faire répondre
  // 500 à Brevo, qui rejouerait en boucle. L'événement est enregistré, il est
  // rattrapable ; le perdre coûterait moins cher qu'une tempête de rejeux.
  let dispatch = { dispatched: false, reason: 'DUPLICATE' };
  if (!duplicate) {
    /**
     * DEUX ACHEMINEMENTS, UN SEUL ORDRE.
     *
     * Chacun ne reconnaît QUE son fournisseur et rend 
     * sinon — les enchaîner ainsi évite un aiguillage par nom de fournisseur
     * ici, qui grossirait à chaque migration et finirait par porter la logique
     * qu'il était censé router.
     */
    const acheminer = String(provider).toUpperCase() === 'YOUSIGN'
      ? dispatchSignatureEvent
      : dispatchDeliveryEvent;
    dispatch = await acheminer({
      provider,
      environment,
      payload: parsed,
      eventType: identity.eventType,
    }).catch((err) => {
      logger.error(`[webhooks] acheminement impossible — ${err?.message ?? 'erreur inconnue'}.`);
      return { dispatched: false, reason: 'DISPATCH_FAILED' };
    });
  }
  return {
    outcome: duplicate ? INGEST_OUTCOME.DUPLICATE : INGEST_OUTCOME.ACCEPTED,
    provider,
    environment,
    duplicate,
    eventType: identity.eventType,
    proven: signature.proven,
    /** Le projet a-t-il été prévenu, et lequel ? Diagnostic, jamais un secret. */
    dispatched: dispatch.dispatched,
    dispatchReason: dispatch.reason ?? null,
    /**
     * Le verdict d'appartenance remonte au contrôleur pour le DIAGNOSTIC. Il
     * ne change pas le statut HTTP : un événement qu'on n'attribue à personne
     * a bien été reçu et vérifié, et répondre autre chose que 2xx ferait
     * rejouer Stripe en boucle pour un problème qui n'est pas le sien.
     */
    ownership: appartenance?.ownership ?? null,
    routedProjectId: appartenance?.projectId ?? null,
    code: null,
  };
}

export default { ingestProviderEvent, INGEST_OUTCOME };
