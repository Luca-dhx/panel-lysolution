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
import {
  claimWebhookEvent, settleWebhookEvent, classifyWebhookError,
  statusAfterFailure, CLAIM_OUTCOME,
} from './webhookLease.js';
import { reportWebhookProcessingFailure } from './webhookSupervision.js';
import { runtimeEnvironment } from '../integratedApi/environment.js';
import { capabilityByCallbackSlug } from './webhookRegistry.js';
import { loadVerificationSecrets } from './webhookSecrets.js';
import {
  verifyWebhookSignature, extractEventIdentity, parseJsonBody,
  diagnoseHmacRepresentation, readHeader,
} from './webhookSignature.js';
import { WEBHOOK_DIAGNOSTIC } from './webhookDiagnostics.js';
import { dispatchDeliveryEvent } from './emailDeliveryDispatch.js';
import { dispatchSignatureEvent, SIGNATURE_PROVIDERS } from './signatureEventDispatch.js';
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
 * ══ LES EFFETS MÉTIER D'UN ÉVÉNEMENT — UN SEUL ENDROIT ══════════════════════
 *
 * Extraits de la réception pour que la REPRISE les rejoue à l'identique. Deux
 * implémentations du même parcours auraient divergé en silence, et c'est celle
 * qu'on ne relit jamais — la reprise — qui aurait vieilli.
 *
 * NE LÈVE PAS. Chaque étape retient son échec ; l'appelant décide de l'état
 * durable (`PROCESSED` ou `FAILED`) et du statut HTTP.
 *
 * @returns {Promise<{echecs: object[], appartenance: object|null, verdictAppartenance: object, dispatch: object}>}
 */
export async function applyProviderEventEffects({
  provider, environment, eventType, providerEventId, payload,
} = {}) {
  /**
   * ══ CE QUI A ÉCHOUÉ EST RETENU, PLUS ABSORBÉ ═══════════════════════
   *
   * Chaque étape reste BEST-EFFORT vis-à-vis d'HTTP — répondre 500 à Stripe
   * déclencherait une tempête de rejeux, et c'est toujours vrai.
   *
   * Mais « ne pas répondre 500 » ne veut pas dire « oublier ». Les échecs étaient
   * absorbés dans un `.catch` qui rendait `null` : l'événement finissait quand
   * même comme s'il avait été traité, et l'effet manquant n'existait plus nulle
   * part. Ils sont désormais RETENUS, et l'événement se conclut en `FAILED` —
   * donc REPRENABLE, au prochain rejeu comme au prochain démarrage.
   */
  const echecs = [];
  const retenir = (etape) => (err) => {
    logger.error(`[webhooks] ${etape} — ${err?.message ?? 'erreur inconnue'}.`);
    echecs.push({ etape, err });
    return null;
  };

  /**
   * ── À QUI EST-IL ? (L6.2C) ──────────────────────────────────────────
   *
   * Résolu APRÈS la signature et APRÈS la réclamation, et ENREGISTRÉ sur
   * l'événement — y compris quand la réponse est « à personne ». Un événement non
   * attribué qu'on ne consigne pas est un événement perdu, et une perte
   * silencieuse est la pire des issues sur un flux financier.
   */
  const appartenance = await resolveStripeEventOwnership({
    provider, environment, eventType, payload,
  }).catch(retenir('appartenance non résolue'));

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
      session: payload?.data?.object ?? null,
      source: 'LEARNED_FROM_WEBHOOK',
    }).catch(retenir('adoption d’abonnement impossible'));
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
  {
    await recordStripeRevenueEvent({
      environment,
      eventType,
      payload,
      providerEventId,
    }).catch(retenir('projection financière impossible'));

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
      }).catch(retenir('convergence financière impossible'));
    }
  }

  const verdictAppartenance = appartenance && appartenance.ownership !== EVENT_OWNERSHIP.NOT_ROUTABLE
    ? {
      projectId: appartenance.projectId,
      ownership: appartenance.ownership,
      claimMismatch: appartenance.claimMismatch,
    }
    : {};

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
  let dispatch = { dispatched: false, reason: null };
  {
    /**
     * DEUX ACHEMINEMENTS, ET CHACUN NE RECONNAÎT QUE LES SIENS.
     *
     * L'aiguillage porte sur le DOMAINE, pas sur le nom d'un fournisseur : la
     * signature d'un côté, la délivrabilité de l'autre. Un `=== 'YOUSIGN'`
     * suffisait tant qu'un domaine n'avait qu'un fournisseur ; il aurait fallu
     * l'allonger à chaque migration, et il aurait fini par porter la logique
     * qu'il était censé router.
     *
     * Chaque acheminement refuse poliment ce qui n'est pas de son ressort, et
     * la liste des fournisseurs de signature vit dans le module qui les
     * traduit — pas ici.
     */
    const acheminer = SIGNATURE_PROVIDERS.has(String(provider).toUpperCase())
      ? dispatchSignatureEvent
      : dispatchDeliveryEvent;
    dispatch = await acheminer({
      provider,
      environment,
      payload,
      eventType,
    }).catch((err) => {
      retenir('acheminement impossible')(err);
      return { dispatched: false, reason: 'DISPATCH_FAILED' };
    });
  }
  return { echecs, appartenance, verdictAppartenance, dispatch };
}


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

  /**
   * ── IDEMPOTENCE — L'ÉTAT TRANCHE, PAS LA SEULE EXISTENCE ────────────────
   *
   * Ici se trouvait le défaut que ce lot ferme. La ligne était créée, son
   * refus en E11000 valait « doublon », et c'était tout. Un crash entre cette
   * écriture et les effets métier plus bas rendait l'événement définitivement
   * inapplicable : Stripe rejouait, nous répondions « déjà vu », et le fait
   * financier n'existait jamais.
   *
   * La réclamation est atomique et conditionnée à l'ÉTAT (`webhookLease.js`).
   * Un rejeu d'événement conclu reste un doublon ; un rejeu d'événement
   * ABANDONNÉ est une reprise, et c'est exactement la réparation gratuite que
   * le fournisseur nous offrait et que nous refusions.
   */
  const cle = { provider, environment, providerEventId: identity.providerEventId };
  let reclamation;
  try {
    reclamation = await claimWebhookEvent({
      Model: PanelProviderWebhookEvent,
      key: cle,
      seed: {
        bindingId: binding.bindingId,
        eventType: identity.eventType,
        payloadHash: identity.payloadHash,
        signatureVerified: signature.proven,
        receivedAt: nowIso(),
      },
    });
  } catch (err) {
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

  /**
   * `duplicate` ne signifie plus « la ligne existait ». Il signifie « il n'y a
   * rien à faire » — soit parce que l'événement est conclu, soit parce qu'un
   * autre processus le tient sous un bail valide.
   *
   * Le second cas mérite son propre mot dans le diagnostic : « déjà traité » et
   * « en cours de traitement ailleurs » se ressemblent en HTTP et ne se
   * ressemblent pas du tout dans un incident.
   */
  const duplicate = reclamation.outcome === CLAIM_OUTCOME.TERMINAL
    || reclamation.outcome === CLAIM_OUTCOME.IN_FLIGHT;
  if (reclamation.outcome === CLAIM_OUTCOME.RECLAIMED) {
    logger.warn(
      `[webhooks] ${provider}/${environment} : ${identity.providerEventId} REPRIS `
      + `(tentative ${reclamation.attempts}) — un traitement précédent ne s'est jamais achevé.`,
    );
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
   * Les effets métier vivent dans `applyProviderEventEffects` — la MÊME
   * fonction que la reprise appelle. C'est ce qui garantit qu'un événement
   * repris au démarrage produit exactement ce qu'il aurait produit à l'heure.
   */
  const effets = duplicate
    ? { echecs: [], appartenance: null, verdictAppartenance: {}, dispatch: { dispatched: false, reason: 'DUPLICATE' } }
    : await applyProviderEventEffects({
      provider,
      environment,
      eventType: identity.eventType,
      providerEventId: identity.providerEventId,
      payload: parsed,
    });
  const { echecs, appartenance, verdictAppartenance, dispatch } = effets;

  /**
   * ══ CONCLURE — ET NE JAMAIS DIRE « FAIT » QUAND ÇA NE L'EST PAS ═════════
   *
   * C'est la ligne qui rend le bail utile. Tant qu'elle n'est pas écrite, le
   * bail court ; s'il expire, l'événement redevient reprenable. Un processus
   * tué juste avant elle laisse donc un `PROCESSING` périmé — récupérable — et
   * non un `PROCESSED` mensonger.
   *
   * `settleWebhookEvent` n'écrit que si le bail est ENCORE le nôtre : un
   * traitement qui a dépassé sa durée et dont l'événement a été repris ailleurs
   * ne vient pas effacer le travail de son successeur.
   */
  if (!duplicate) {
    if (echecs.length === 0) {
      await settleWebhookEvent({
        Model: PanelProviderWebhookEvent,
        key: cle,
        status: WEBHOOK_EVENT_STATUS.PROCESSED,
        patch: verdictAppartenance,
      }).catch(() => null);
    } else {
      const cause = classifyWebhookError(echecs[0].err);
      const statut = statusAfterFailure({
        retryable: cause.retryable,
        attempts: reclamation.attempts,
      });
      await settleWebhookEvent({
        Model: PanelProviderWebhookEvent,
        key: cle,
        status: statut,
        patch: verdictAppartenance,
        error: { ...cause, message: `${echecs[0].etape} : ${cause.message}` },
      }).catch(() => null);
      await reportWebhookProcessingFailure({
        provider,
        environment,
        providerEventId: identity.providerEventId,
        eventType: identity.eventType,
        projectId: appartenance?.projectId ?? null,
        attempts: reclamation.attempts,
        status: statut,
        cause,
      }).catch(() => null);
    }
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
