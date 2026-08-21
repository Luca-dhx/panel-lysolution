// LES VERBES STRIPE SERVIS — un seul, et c'est délibéré (L6.2B).
//
// docs/architecture/STRIPE_L6_2B_CHECKOUT_CUTOVER_REPORT.md.
//
// ── CE QUE CE FICHIER GARANTIT ──────────────────────────────────────────────
//
// Qu'un acte de paiement demandé N fois n'ouvre JAMAIS qu'une seule session
// Stripe — y compris lorsque le Panel a été tué entre l'appel au fournisseur et
// l'écriture de sa propre trace, et y compris lorsque la réponse de Stripe s'est
// perdue en route.
//
// ── LES TROIS BARRIÈRES, DANS L'ORDRE ───────────────────────────────────────
//
//  1. LE LIEN. `createdByOperationId` répond à « cet acte a-t-il déjà produit
//     une session ? » sans interroger personne. Elle est DÉFINITIVE : elle vaut
//     un an après, quand plus aucune garantie fournisseur ne tient.
//
//  2. LA CLÉ D'IDEMPOTENCE. Si le lien manque, la création est retentée avec la
//     MÊME clé dérivée. Stripe rend alors sa réponse d'origine — la même
//     session — au lieu d'en ouvrir une seconde. C'est la reprise de la fenêtre
//     « créé chez Stripe, pas encore lié chez nous ».
//
//  3. LE REGISTRE D'OPÉRATIONS. Il décide QUI a le droit de tenter, et refuse
//     de laisser deux appels concurrents partir ensemble. Il porte aussi la
//     limite de la barrière 2 : au-delà de la fenêtre d'idempotence de Stripe,
//     rejouer la même clé n'est plus une convergence mais une seconde création,
//     et le Panel refuse plutôt que de deviner.
//
// ── CE QUI N'EST PAS ICI, ET POURQUOI ───────────────────────────────────────
//
// Aucun remboursement, aucune résiliation, aucun client, aucun produit, aucun
// tarif. Un fichier d'adaptateurs qui grossit d'un verbe financier à chaque
// besoin finit par contenir la logique de facturation ; chacun de ces verbes
// aura son lot, avec sa propre preuve de non-doublon.
import { createHash } from 'node:crypto';

import logger from '../../../utils/logger.js';
import {
  CAPABILITY_ERROR_CODES,
  CapabilityError,
  capabilityResourceNotOwned,
} from '../../capabilities/capabilityErrors.js';
import {
  createCheckoutSession,
  retrieveCheckoutSession,
  createCustomer,
  retrieveCustomer,
  updateCustomer,
  listCustomerTaxIds,
  createCustomerTaxId,
  retrieveSubscription,
  createProduct,
  createPrice,
  retrievePrice,
  cancelSubscriptionAtPeriodEnd,
  cancelSubscriptionNow,
  retrievePaymentIntent,
  retrieveInvoice,
  listInvoices,
  createBillingPortalSession,
  listRefunds,
  createRefund,
  StripeTransportError,
  TRANSPORT_CODES,
  OUTCOMES,
} from './stripeTransport.js';
import {
  STRIPE_RESOURCE_TYPES,
  BINDING_SOURCES,
  STRIPE_RESOURCE_NOT_OWNED,
  bindResource,
  findBindingByOperation,
  assertOwnedResource,
  maskResourceId,
} from './stripeResourceBinding.js';
import {
  CheckoutAuthorityError,
  deriveIdempotencyKey,
  resolveCheckoutIntent,
} from './stripeCheckoutAuthority.js';
import {
  CustomerAuthorityError,
  resolveCustomerIntent,
} from './stripeCustomerAuthority.js';
import {
  PriceAuthorityError,
  resolvePriceIntent,
} from './stripePriceAuthority.js';
import { ensureTaxRate } from './stripeTaxRateAuthority.js';
import { adoptSubscriptionFromSession } from './stripeSubscriptionAdoption.js';
import {
  CANCELLATION_STATE,
  cancellationOperationId,
  describeCancellationState,
  describeCancelledSubscription,
  logConvergence,
} from './stripeSubscriptionCancellation.js';
import {
  REFUND_ACT_STATE,
  REFUND_OPERATION_METADATA_KEY,
  findOwnRefund,
  describeRefundableAmount,
  chargeOfPaymentIntent,
  receiptUrlOfCharge,
  describeRefund,
} from './stripeRefundAuthority.js';
import { STRIPE_CAPABILITIES } from './stripeCapabilities.js';
import { ensureProjectWebhookEndpoint } from '../../webhooks/webhookReconciler.js';
/**
 * LA ROUTE DE RÉCEPTION DU PROJET — décidée ici, jamais par le projet.
 *
 * Elle double la convention de SB Auto (`/api/webhooks/stripe`). La recopier
 * plutôt que de l'accepter en entrée est délibéré : un projet qui choisirait
 * son chemin pourrait faire enregistrer une route qui ne vérifie aucune
 * signature, et Stripe y déverserait des événements en clair.
 */
const PROJECT_STRIPE_WEBHOOK_PATH = '/api/webhooks/stripe';

/**
 * LES ACTES COMPOSÉS GARDENT LEUR PROPRE IDENTITÉ.
 *
 * Quand le checkout d'abonnement appelle `customerEnsure`, il doit lui passer
 * la définition de `billing.customer.ensure` — pas la sienne. La clé
 * d'idempotence Stripe dérive du CODE DE CAPACITÉ : la lui laisser hériter du
 * checkout produirait une clé différente de celle qu'un appel direct à
 * `customer.ensure` aurait utilisée, donc un SECOND client pour le même
 * contrat. Le défaut serait invisible en test nominal et coûteux en production.
 */
const COMPOSEES = Object.freeze({
  CUSTOMER: Object.freeze({
    code: 'billing.customer.ensure',
    timeoutMs: STRIPE_CAPABILITIES['billing.customer.ensure'].timeoutMs,
  }),
  PRICE: Object.freeze({
    code: 'billing.price.ensure',
    timeoutMs: STRIPE_CAPABILITIES['billing.price.ensure'].timeoutMs,
  }),
});

/* -------------------------------------------------------------------------- */
/*  TRADUCTION DES REFUS                                                      */
/* -------------------------------------------------------------------------- */

/**
 * CHAQUE ADAPTATEUR TRADUIT SES PROPRES ERREURS — la leçon de L9.
 *
 * Le traducteur générique de la passerelle ne connaît que le transport Brevo :
 * une `StripeTransportError` y tomberait dans la branche « erreur non typée »
 * et ressortirait en `PROVIDER_UNAVAILABLE`, c'est-à-dire en « rien ne s'est
 * passé ». Sur une écriture financière interrompue, c'est faux — et c'est
 * exactement l'affirmation qui pousse un projet à rejouer.
 *
 * La distinction porte donc jusqu'au code rendu :
 *
 *   outcome UNKNOWN  → `CAPABILITY_TIMEOUT` (504), issue INDÉTERMINÉE, jamais
 *                      rejouable seule ;
 *   outcome FAILED   → un refus qui AFFIRME que rien n'a bougé.
 */
function translateStripeError(error, definition) {
  if (error instanceof CapabilityError) return error;

  /**
   * L'APPARTENANCE REFUSÉE — un seul code, une seule phrase (L6.2C).
   *
   * `assertOwnedResource` rend déjà le même refus pour « inconnue », « à un
   * autre » et « révoquée » ; on le traduit sans rien y ajouter. Le motif réel
   * a été journalisé côté registre, où il sert au diagnostic sans devenir une
   * sonde d'existence.
   */
  if (error?.code === STRIPE_RESOURCE_NOT_OWNED) {
    return capabilityResourceNotOwned(definition.code);
  }

  if (error instanceof CheckoutAuthorityError
    || error instanceof CustomerAuthorityError
    || error instanceof PriceAuthorityError) {
    /**
     * Un refus d'AUTORITÉ n'est pas une panne : la demande est recevable dans
     * sa forme et refusée dans son fond. `NOT_AVAILABLE` porte le motif, et
     * aucun contact fournisseur n'a eu lieu.
     */
    return new CapabilityError(
      CAPABILITY_ERROR_CODES.NOT_AVAILABLE,
      `« ${definition.code} » ne peut pas être servie pour cette demande.`,
      { reason: error.reason },
    );
  }

  if (!(error instanceof StripeTransportError)) {
    // Erreur non typée pendant une ÉCRITURE : on ne sait pas ce qui s'est
    // passé, donc on ne prétend pas que rien n'a eu lieu.
    return new CapabilityError(
      CAPABILITY_ERROR_CODES.TIMEOUT,
      `L’exécution de « ${definition.code} » s’est interrompue : l’issue est indéterminée.`,
      { replayable: false },
    );
  }

  if (error.outcome === OUTCOMES.UNKNOWN) {
    return new CapabilityError(
      CAPABILITY_ERROR_CODES.TIMEOUT,
      `Stripe n’a pas confirmé « ${definition.code} » : l’issue est indéterminée. `
      + 'La reprise passe par la même opération, jamais par un nouvel acte.',
      { httpStatus: error.httpStatus ?? null, stripeCode: error.stripeCode ?? null },
    );
  }

  if (error.code === TRANSPORT_CODES.MISSING_CREDENTIALS) {
    return new CapabilityError(
      CAPABILITY_ERROR_CODES.CREDENTIALS_MISSING,
      'Identifiants incomplets pour STRIPE.',
      { provider: 'STRIPE' },
    );
  }

  if (error.code === TRANSPORT_CODES.INPUT_INVALID) {
    return new CapabilityError(
      CAPABILITY_ERROR_CODES.INPUT_INVALID,
      `Entrée refusée par l’adaptateur de « ${definition.code} ».`,
    );
  }

  return new CapabilityError(
    CAPABILITY_ERROR_CODES.PROVIDER_UNAVAILABLE,
    `Stripe a refusé « ${definition.code} ».`,
    { httpStatus: error.httpStatus ?? null, stripeCode: error.stripeCode ?? null },
  );
}

/** Enveloppe : toute sortie de ce module est un refus de passerelle typé. */
async function guard(definition, operation) {
  try {
    return await operation();
  } catch (error) {
    throw translateStripeError(error, definition);
  }
}

/* -------------------------------------------------------------------------- */
/*  billing.checkout.create                                                   */
/* -------------------------------------------------------------------------- */

const SESSION = STRIPE_RESOURCE_TYPES.CHECKOUT_SESSION;

/**
 * Ce que le projet reçoit — un CONSTAT, jamais l'objet Stripe.
 *
 * `url` est NULLABLE, et c'est un fait métier, pas une commodité : Stripe cesse
 * de rendre une URL dès que la session est complétée ou expirée. Promettre une
 * chaîne obligerait à en fabriquer une, et le projet enverrait un client vers un
 * lien mort en croyant l'envoyer payer.
 */
function describeSession(session, creation, operationId) {
  return {
    checkoutSessionId: String(session?.id ?? ''),
    url: session?.url ?? null,
    status: session?.status ?? null,
    paymentStatus: session?.payment_status ?? null,
    /**
     * Stripe rend soit l'identifiant, soit l'objet développé selon l'appel.
     * On n'en garde que l'identifiant : développer ferait traverser au pont
     * l'adresse, les moyens de paiement et le compte — qu'aucune capacité n'a
     * promis.
     */
    paymentIntentId: idOf(session?.payment_intent),
    customerId: idOf(session?.customer),
    subscriptionId: idOf(session?.subscription),
    creation,
    operationId,
  };
}

const idOf = (value) => (typeof value === 'string' ? value : value?.id ?? null);

/**
 * Ouvre — ou RETROUVE — la session de paiement d'un acte métier.
 *
 * L'ordre des trois barrières est l'invariant de ce lot : le lien d'abord, la
 * clé ensuite, jamais l'inverse. Inverser reviendrait à parler au fournisseur
 * pour découvrir ce qu'on savait déjà, et à dépendre d'une fenêtre de 24 heures
 * là où une lecture locale répond pour toujours.
 */
async function checkoutCreate({ definition, context, credentials, input, fetchImpl }) {
  const { projectId, environment } = context;

  /**
   * ── BARRIÈRE 0 : L'AUTORITÉ ────────────────────────────────────────────────
   * Le contrat est-il le sien, et combien coûte-t-il ? Résolu AVANT tout
   * contact fournisseur : un refus ici ne laisse aucune trace chez Stripe.
   */
  const intent = await guard(definition, () => resolveCheckoutIntent({ projectId, environment, input }));

  /**
   * ── L'ABONNEMENT COMPOSE TROIS ACTES, DANS CET ORDRE (L6.2E) ───────────────
   *
   * Une session `mode: subscription` référence un client et un tarif qui doivent
   * exister AVANT elle. Le Panel les garantit lui-même, avec sa clé, et les lie
   * — c'est ce qui rend l'abonnement migrable là où il ne l'était pas.
   *
   * L'ordre n'est pas négociable : Stripe refuse une session qui référence un
   * objet inexistant, et cet échec surviendrait devant un client qui paie.
   *
   * Chacun de ces deux actes porte SA propre identité dérivée, donc sa propre
   * convergence : un client déjà garanti n'est pas recréé parce qu'un tarif
   * manquait. On ne compose pas trois actes en un seul — on les enchaîne, et
   * chacun reste idempotent pour son compte.
   */
  /**
   * ── LE TAUX DE TVA — GARANTI AVANT TOUTE SESSION ──────────────────────────
   *
   * ══ POURQUOI C'EST UN ACTE À PART ENTIÈRE ═════════════════════════════════
   *
   * Une session qui référencerait un `tax_rate` inexistant serait refusée par
   * Stripe — devant un client qui paie. Le taux est donc garanti d'abord,
   * exactement comme le client et le tarif d'un abonnement le sont : « d'abord
   * les ressources, ensuite la session ».
   *
   * Ce n'est PAS une capacité offerte au projet : aucun projet ne peut demander
   * la création d'un taux, ce qui lui permettrait de peupler le catalogue
   * fiscal du compte. C'est une conséquence interne de la construction du
   * paiement.
   *
   * Le taux vient de `intent.fiscal`, c'est-à-dire du CONTRAT — jamais d'une
   * décision de ce fichier, et jamais d'un calcul du fournisseur.
   */
  const taxRateId = await guard(definition, () => ensureTaxRate({
    credentials,
    environment,
    percentage: intent.fiscal.taxRate,
    /**
     * LE PAYS D'IMPOSITION est celui du VENDEUR — L.Y Solution —, pas celui de
     * l'acheteur. C'est le régime de TVA française sur des prestations rendues
     * à un client français, tel que le contrat l'établit. Le déduire de
     * l'adresse du client ferait dépendre le taux d'un champ de fiche, et
     * changerait la fiscalité d'un contrat déjà signé au premier déménagement.
     */
    country: 'FR',
    timeoutMs: definition.timeoutMs,
    fetchImpl,
  }));

  let params;
  let customerId = null;
  if (input.paymentType === 'SUBSCRIPTION') {
    const client = await customerEnsure({
      definition: COMPOSEES.CUSTOMER, context, credentials, fetchImpl,
      input: { contractRef: input.contractRef },
    });
    const tarif = await priceEnsure({
      definition: COMPOSEES.PRICE, context, credentials, fetchImpl,
      input: { contractRef: input.contractRef },
    });
    customerId = client.customerId;
    params = intent.paramsFor({ customerId: client.customerId, priceId: tarif.priceId, taxRateId });
  } else {
    /**
     * ── LE PAIEMENT UNIQUE RÉFÉRENCE LUI AUSSI SON CLIENT ─────────────────
     *
     * ══ CE QU'IL NE FAISAIT PAS, ET CE QUE ÇA COÛTAIT ═══════════════════════
     *
     * `mode: payment` ouvrait une session SANS client : Stripe en créait un à
     * la volée, à partir de ce que l'acheteur saisissait dans le formulaire.
     * La facture portait donc l'adresse e-mail tapée par la personne devant
     * l'écran — un gérant, une secrétaire, parfois une adresse personnelle —
     * et aucune identité juridique.
     *
     * En référençant le client du contrat, la facture porte la RAISON SOCIALE,
     * l'ADRESSE et le NUMÉRO DE TVA de l'entreprise cliente, exactement comme
     * une facture d'abonnement. C'est le même client, le même historique, et
     * la même identité pour les deux natures de paiement d'un même contrat.
     *
     * ── ET LES PRESTATIONS PONCTUELLES ? ─────────────────────────────────
     *
     * Elles n'ont pas de contrat (`intent.contractId === null`), donc pas de
     * client dérivable — le client Stripe est lié au CONTRAT, c'est la doctrine
     * de L6.2D. Elles restent sans client référencé, et le repli est explicite
     * plutôt que subi.
     */
    if (intent.contractId) {
      const client = await customerEnsure({
        definition: COMPOSEES.CUSTOMER, context, credentials, fetchImpl,
        input: { contractRef: input.contractRef },
      });
      customerId = client.customerId;
    }
    params = intent.paramsFor({ taxRateId });
    if (customerId) params = { ...params, customer: customerId };
  }

  /**
   * ── BARRIÈRE 1 : LE LIEN ───────────────────────────────────────────────────
   * Cet acte a déjà produit une session : on la relit, on ne la recrée pas.
   * C'est une lecture INTERNE de reprise — elle ne fait pas de
   * `billing.checkout.retrieve` une capacité offerte au projet.
   */
  const known = await findBindingByOperation({
    projectId, environment, resourceType: SESSION, operationId: input.operationId,
  });
  if (known) {
    if (known.revokedAt) {
      /**
       * Un lien révoqué désigne une session qu'on a cessé de reconnaître. La
       * relire la remettrait en circulation ; en créer une autre doublerait
       * l'acte. Le seul geste sûr est de refuser et de laisser un humain
       * trancher.
       */
      throw new CapabilityError(
        CAPABILITY_ERROR_CODES.NOT_AVAILABLE,
        `« ${definition.code} » : cette opération désigne une session révoquée.`,
        { reason: 'BINDING_REVOKED' },
      );
    }
    const replayed = await guard(definition, () => retrieveCheckoutSession({
      credentials, sessionId: known.resourceId, timeoutMs: definition.timeoutMs, fetchImpl,
    }));
    logger.info(
      `[stripe] checkout REPRISE — ${maskResourceId(known.resourceId)} `
      + `(${projectId}, ${environment}, opération ${input.operationId}).`,
    );
    return describeSession(replayed.session, 'REUSED', input.operationId);
  }

  /**
   * ── BARRIÈRE 2 : LA CLÉ ────────────────────────────────────────────────────
   * Aucun lien : soit l'acte n'a jamais eu lieu, soit il a eu lieu et le Panel
   * est mort avant de l'écrire. Les deux se règlent de la même façon — le même
   * appel, la même clé. Stripe tranche, et il tranche sans doubler.
   */
  const idempotencyKey = deriveIdempotencyKey({
    environment, projectId, capability: definition.code, operationId: input.operationId,
  });

  const created = await guard(definition, () => createCheckoutSession({
    credentials,
    params,
    idempotencyKey,
    timeoutMs: definition.timeoutMs,
    fetchImpl,
  }));

  const session = created.session;
  if (!session?.id) {
    /**
     * 2xx sans identifiant : Stripe a peut-être créé la session. On ne peut ni
     * la lier ni la rendre, donc on ne prétend pas savoir.
     */
    throw new CapabilityError(
      CAPABILITY_ERROR_CODES.TIMEOUT,
      `Stripe a répondu à « ${definition.code} » sans identifiant de session : issue indéterminée.`,
    );
  }

  /**
   * ── LE LIEN, IMMÉDIATEMENT ─────────────────────────────────────────────────
   *
   * La fenêtre entre la ligne du dessus et celle-ci est IRRÉDUCTIBLE : Stripe
   * et Mongo n'ont pas de transaction commune. On ne prétend pas la fermer, on
   * la rend reprenable — c'est précisément ce que la barrière 1 relit au
   * passage suivant.
   *
   * Un échec d'écriture du lien n'est PAS masqué : la session existe, elle
   * appartient à ce projet, et la taire laisserait une ressource orpheline que
   * personne ne saurait plus réclamer.
   */
  await bindResource({
    projectId,
    environment,
    resourceType: SESSION,
    resourceId: session.id,
    source: BINDING_SOURCES.PANEL_CREATED,
    createdByOperationId: input.operationId,
  }).catch((error) => {
    logger.error(
      `[stripe] session ${maskResourceId(session.id)} créée mais NON LIÉE `
      + `(${projectId}, ${environment}) : ${error?.code ?? 'UNEXPECTED'}.`,
    );
    throw new CapabilityError(
      CAPABILITY_ERROR_CODES.TIMEOUT,
      `« ${definition.code} » : la session a été ouverte mais le Panel n’a pas pu enregistrer `
      + 'son appartenance. La reprise de la même opération la retrouvera.',
      { reason: 'BINDING_WRITE_FAILED' },
    );
  });

  /**
   * ── LA PRESTATION APPREND QUE SA SESSION EST OUVERTE (L10.5) ──────────────
   *
   * APRÈS le lien, jamais avant : on n'annonce un paiement en cours que
   * lorsqu'il est établi que la session existe ET qu'elle appartient au projet.
   *
   * Best-effort assumé. Cette écriture ne conditionne rien — la preuve du
   * paiement viendra du webhook, qui retrouvera la demande par la session, par
   * l'intention ou par la métadonnée. Faire échouer une session RÉELLEMENT
   * ouverte parce qu'on n'a pas su noter son état ferait payer au client une
   * erreur d'écriture de notre côté.
   */
  if (input.paymentType === 'SERVICE' && intent.paymentRequestId) {
    await noterSessionSurPrestation({
      paymentRequestId: intent.paymentRequestId,
      checkoutSessionId: session.id,
      url: session.url ?? null,
    }).catch((error) => {
      logger.warn(
        `[stripe] session ${maskResourceId(session.id)} ouverte, prestation non mise à jour `
        + `(${projectId}, ${environment}) : ${error?.message ?? 'erreur inconnue'}.`,
      );
    });
  }

  const vue = describeSession(session, 'CREATED', input.operationId);
  /**
   * `customer` n'est pas toujours renvoyé par Stripe sur une session fraîche ;
   * pour un abonnement, nous SAVONS lequel a été attaché puisque nous venons de
   * le garantir. Le rendre permet au projet de tenir son journal sans avoir à
   * relire la session — et sans jamais choisir le client lui-même.
   */
  return customerId ? { ...vue, customerId: vue.customerId ?? customerId } : vue;
}

/**
 * Import DYNAMIQUE, pour la même raison que dans l'autorité de checkout : ce
 * fichier sert le plan de contrôle Stripe et ne doit pas tirer le domaine
 * financier dans son graphe de chargement.
 */
async function noterSessionSurPrestation(args) {
  const { attachCheckoutSession } = await import(
    '../../finance/paymentRequests/paymentRequests.service.js'
  );
  return attachCheckoutSession(args);
}

/* -------------------------------------------------------------------------- */
/*  billing.checkout.retrieve                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Lit une session de paiement — SI ELLE EST À CE PROJET.
 *
 * ══ L'ORDRE EST TOUTE LA SÉCURITÉ ═══════════════════════════════════════════
 *
 *   appartenance  →  fournisseur
 *
 * et jamais l'inverse. Demander la session à Stripe puis vérifier ses metadata
 * aurait trois défauts, du plus visible au plus grave :
 *
 *   · le Panel paierait un aller-retour réseau pour une demande illégitime ;
 *   · la durée de réponse trahirait l'existence de la ressource — un refus
 *     instantané et un refus lent ne se confondent pas ;
 *   · l'autorisation reposerait sur des metadata ÉDITABLES depuis le tableau de
 *     bord Stripe, c'est-à-dire sur une donnée que le demandeur peut influencer.
 *
 * Sur les trois refus d'appartenance (inconnue, à un autre, révoquée) :
 * `STRIPE_PROVIDER_CALLS = 0`. C'est vérifié par le test, pas seulement promis.
 */
async function checkoutRetrieve({ definition, context, credentials, input, fetchImpl }) {
  const { projectId, environment } = context;

  // ── L'APPARTENANCE, AVANT TOUT CONTACT ────────────────────────────────────
  await guard(definition, () => assertOwnedResource({
    projectId, environment, resourceType: SESSION, resourceId: input.checkoutSessionId,
  }));

  const lu = await guard(definition, () => retrieveCheckoutSession({
    credentials,
    sessionId: input.checkoutSessionId,
    timeoutMs: definition.timeoutMs,
    fetchImpl,
  }));

  const session = lu.session;

  /**
   * ── ADOPTION DE L'ABONNEMENT, AU PASSAGE (L6.2F) ──────────────────────────
   *
   * L'appartenance de la session vient d'être vérifiée : nous tenons donc la
   * filiation qui rend l'adoption légitime. Si cette session a produit un
   * abonnement, c'est le moment de le lier — sans quoi le seul chemin
   * d'adoption serait le webhook, et un webhook perdu laisserait la ressource
   * orpheline pour toujours.
   *
   * BEST-EFFORT ASSUMÉ : une adoption qui échoue ne doit pas faire échouer la
   * lecture. Le projet a demandé l'état d'une session ; le lui refuser parce
   * qu'une écriture annexe a échoué serait lui infliger notre problème.
   */
  if (session?.subscription) {
    await adoptSubscriptionFromSession({
      environment, session, source: BINDING_SOURCES.IMPORTED_WITH_PROOF,
    }).catch(() => null);
  }
  /**
   * LE LIEN AFFIRME, LE FOURNISSEUR DÉMENT — on ne tranche pas tout seul.
   *
   * Un `resource_missing` après une appartenance valide est une INCOHÉRENCE :
   * peut-être une purge du compte, peut-être un mauvais monde, peut-être un
   * lien écrit à tort. Révoquer le lien automatiquement ferait de l'avis
   * ponctuel d'un fournisseur une décision d'appartenance définitive — et la
   * ressource deviendrait irrécupérable. On refuse, on journalise, un humain
   * tranche.
   */
  if (!session?.id) {
    logger.error(
      `[stripe] INCOHÉRENCE — ${maskResourceId(input.checkoutSessionId)} est liée à `
      + `${projectId} (${environment}) mais Stripe ne la rend pas. Lien CONSERVÉ.`,
    );
    throw new CapabilityError(
      CAPABILITY_ERROR_CODES.PROVIDER_UNAVAILABLE,
      `« ${definition.code} » : le fournisseur n’a rendu aucune session exploitable.`,
      { reason: 'BINDING_PROVIDER_DIVERGENCE' },
    );
  }

  return describeSessionView(session);
}

/**
 * LE DTO DE LECTURE — exactement ce que le parcours migré consomme.
 *
 * Cette liste n'est pas « ce qui semble utile » : c'est ce que
 * `settleFromSession` lit réellement côté projet (`status`, `payment_status`,
 * `payment_intent`, `customer`), plus l'identifiant et l'URL que le parcours de
 * retour affiche, plus l'échéance qui dit si le lien vaut encore.
 *
 * Tout le reste de l'objet Stripe reste chez le Panel : la ligne d'articles,
 * l'adresse du client, ses moyens de paiement, le total facturé, le compte. Les
 * relayer « au cas où » ferait traverser au pont des données personnelles
 * qu'aucune capacité n'a promises, et qu'aucun écran ne demande.
 */
function describeSessionView(session) {
  return {
    checkoutSessionId: String(session.id),
    status: session.status ?? null,
    paymentStatus: session.payment_status ?? null,
    url: session.url ?? null,
    expiresAt: Number.isFinite(session.expires_at) ? session.expires_at : null,
    paymentIntentId: idOf(session.payment_intent),
    customerId: idOf(session.customer),
    subscriptionId: idOf(session.subscription),
  };
}

/* -------------------------------------------------------------------------- */
/*  billing.subscription.retrieve                                             */
/* -------------------------------------------------------------------------- */

/**
 * Lit un abonnement — SI IL EST À CE PROJET.
 *
 * Même ordre que la lecture de session (L6.2C), et pour les mêmes trois
 * raisons : ne pas payer un aller-retour pour une demande illégitime, ne pas
 * laisser la durée de réponse trahir l'existence de la ressource, et ne pas
 * faire reposer l'autorisation sur des metadata éditables.
 *
 * Cette capacité n'aurait rien pu vérifier avant ce lot : aucun abonnement
 * n'avait de lien. C'est l'adoption qui la rend possible, et c'est aussi elle
 * qui la rend UTILE — sans lecture, une adoption ne se constate pas.
 */
async function subscriptionRetrieve({ definition, context, credentials, input, fetchImpl }) {
  const { projectId, environment } = context;

  await guard(definition, () => assertOwnedResource({
    projectId, environment, resourceType: STRIPE_RESOURCE_TYPES.SUBSCRIPTION,
    resourceId: input.subscriptionId,
  }));

  const lu = await guard(definition, () => retrieveSubscription({
    credentials, subscriptionId: input.subscriptionId,
    timeoutMs: definition.timeoutMs, fetchImpl,
  }));

  const abonnement = lu.subscription;
  if (!abonnement?.id) {
    /**
     * Le lien affirme, le fournisseur dément. On ne révoque PAS : l'avis
     * ponctuel d'un fournisseur ne fait pas une décision d'appartenance
     * définitive, et la ressource deviendrait irrécupérable.
     */
    logger.error(
      `[stripe] INCOHÉRENCE — ${maskResourceId(input.subscriptionId)} est lié à ${projectId} `
      + `(${environment}) mais Stripe ne le rend pas. Lien CONSERVÉ.`,
    );
    throw new CapabilityError(
      CAPABILITY_ERROR_CODES.PROVIDER_UNAVAILABLE,
      `« ${definition.code} » : le fournisseur n’a rendu aucun abonnement exploitable.`,
      { reason: 'BINDING_PROVIDER_DIVERGENCE' },
    );
  }

  return describeSubscription(abonnement);
}

/**
 * LE DTO — exactement ce que la projection du projet consomme.
 *
 * Établi sur `projectSubscription()` côté SB Auto : statut, période, résiliation
 * différée, dernière facture, client. Rien d'autre ne traverse — ni les lignes
 * d'abonnement, ni le moyen de paiement par défaut, ni les remises.
 */
function describeSubscription(abonnement) {
  return {
    subscriptionId: String(abonnement.id),
    status: abonnement.status ?? null,
    cancelAtPeriodEnd: Boolean(abonnement.cancel_at_period_end),
    currentPeriodStart: Number.isFinite(abonnement.current_period_start)
      ? abonnement.current_period_start : null,
    currentPeriodEnd: Number.isFinite(abonnement.current_period_end)
      ? abonnement.current_period_end : null,
    latestInvoiceId: idOf(abonnement.latest_invoice),
    customerId: idOf(abonnement.customer),
  };
}

/* -------------------------------------------------------------------------- */
/*  billing.customer.ensure                                                   */
/* -------------------------------------------------------------------------- */

const CUSTOMER = STRIPE_RESOURCE_TYPES.CUSTOMER;

/**
 * Garantit qu'un contrat a UN client Stripe — et un seul.
 *
 * ══ LES TROIS BARRIÈRES, REPRISES DE L6.2B ══════════════════════════════════
 *
 * Le problème est le même qu'à l'ouverture d'un paiement : un acte externe dont
 * la trace locale peut manquer. La réponse est donc la même, dans le même
 * ordre — et c'est délibéré : deux mécanismes de convergence pour un même
 * problème finiraient par diverger.
 *
 *   1. LE LIEN. `createdByOperationId` porte l'identité DÉRIVÉE du contrat.
 *      Il répond « ce contrat a-t-il déjà son client ? » sans interroger
 *      personne, et il répond encore un an après.
 *   2. LA CLÉ D'IDEMPOTENCE. Si le lien manque, la création est retentée avec
 *      la MÊME clé : Stripe rend son client d'origine au lieu d'en créer un
 *      second.
 *   3. LE REGISTRE D'OPÉRATIONS. Il empêche huit appels concurrents de partir
 *      ensemble, et borne la reprise à la fenêtre du fournisseur.
 *
 * ══ CE QU'IL NE FAIT PAS : ADOPTER ══════════════════════════════════════════
 *
 * Un contrat peut déjà porter un `customerId` historique. Ce module ne le
 * regarde même pas, et le projet ne peut pas le transmettre — voir le contrat
 * d'entrée. Lier un identifiant sur la seule foi de celui qui le présente
 * transformerait le registre d'appartenance en registre de déclarations.
 */
async function customerEnsure({ definition, context, credentials, input, fetchImpl }) {
  const { projectId, environment } = context;

  // ── BARRIÈRE 0 : L'AUTORITÉ — ce contrat est-il le sien ? ─────────────────
  const intent = await guard(definition, () => resolveCustomerIntent({ projectId, environment, input }));

  // ── BARRIÈRE 1 : LE LIEN ──────────────────────────────────────────────────
  const connu = await findBindingByOperation({
    projectId, environment, resourceType: CUSTOMER, operationId: intent.operationId,
  });
  if (connu && !connu.revokedAt) {
    /**
     * On RELIT le client chez Stripe plutôt que de rendre l'identifiant tel
     * quel. Le coût est un aller-retour ; le gain est de constater une
     * suppression côté fournisseur au lieu de rendre un identifiant mort que
     * l'abonnement suivant utiliserait.
     */
    const relu = await guard(definition, () => retrieveCustomer({
      credentials, customerId: connu.resourceId, timeoutMs: definition.timeoutMs, fetchImpl,
    }));
    if (relu.customer?.deleted === true) {
      logger.error(
        `[stripe] INCOHÉRENCE — ${maskResourceId(connu.resourceId)} est lié à ${projectId} `
        + `(${environment}) mais Stripe le déclare supprimé. Lien CONSERVÉ.`,
      );
      throw new CapabilityError(
        CAPABILITY_ERROR_CODES.PROVIDER_UNAVAILABLE,
        `« ${definition.code} » : le client de ce contrat n’existe plus chez le fournisseur.`,
        { reason: 'BINDING_PROVIDER_DIVERGENCE' },
      );
    }
    /**
     * ── LA CONVERGENCE D'IDENTITÉ — CE QUI MANQUAIT ──────────────────────
     *
     * ══ LE DÉFAUT QUE CE BLOC FERME ═══════════════════════════════════════
     *
     * `ensure` créait le client UNE fois, puis se contentait de le relire.
     * Toute correction ultérieure de l'identité restait donc côté Panel :
     *
     *   · un projet dont l'entreprise cliente est rattachée APRÈS l'ouverture
     *     du contrat gardait, chez Stripe, le client anonyme du premier jour ;
     *   · un déménagement, une correction de raison sociale, un SIREN ajouté
     *     n'atteignaient jamais le fournisseur, et les factures SUIVANTES
     *     portaient encore l'ancienne identité.
     *
     * Le verbe s'appelle « ensure » : il doit garantir que le client EST ce que
     * le Panel dit, pas seulement qu'il existe.
     *
     * ══ POURQUOI LA MISE À JOUR EST CONDITIONNÉE ══════════════════════════
     *
     * Écrire à chaque appel produirait un appel fournisseur par ouverture de
     * paiement, pour ne rien changer dans l'immense majorité des cas. On
     * compare donc l'état RELU à l'état voulu, et l'on n'écrit que sur écart.
     *
     * ══ ET L'HISTORIQUE ? ════════════════════════════════════════════════
     *
     * Il ne bouge pas. Une facture Stripe déjà émise porte une COPIE de
     * l'identité au moment de l'émission : modifier le client aujourd'hui ne
     * réécrit aucune facture d'hier. C'est la garantie qui rend cette
     * convergence sans risque — et c'est aussi pourquoi le Panel garde son
     * propre instantané légal, sans dépendre de celui du fournisseur.
     */
    await convergerIdentiteClient({
      definition, credentials, fetchImpl,
      customerId: connu.resourceId,
      actuel: relu.customer,
      voulu: intent.params,
      taxIdentity: intent.taxIdentity,
      environment,
    });
    return { customerId: connu.resourceId, status: 'EXISTING' };
  }
  if (connu?.revokedAt) {
    /**
     * Lien révoqué : on a cessé de reconnaître ce client. En créer un second
     * ferait deux clients pour un contrat — précisément ce que le verbe
     * empêche. Un humain tranche.
     */
    throw new CapabilityError(
      CAPABILITY_ERROR_CODES.NOT_AVAILABLE,
      `« ${definition.code} » : le client de ce contrat a été révoqué.`,
      { reason: 'BINDING_REVOKED' },
    );
  }

  // ── BARRIÈRE 2 : LA CLÉ ───────────────────────────────────────────────────
  const idempotencyKey = deriveIdempotencyKey({
    environment, projectId, capability: definition.code, operationId: intent.operationId,
  });

  const cree = await guard(definition, () => createCustomer({
    credentials, params: intent.params, idempotencyKey, timeoutMs: definition.timeoutMs, fetchImpl,
  }));

  const customer = cree.customer;
  if (!customer?.id) {
    throw new CapabilityError(
      CAPABILITY_ERROR_CODES.TIMEOUT,
      `Stripe a répondu à « ${definition.code} » sans identifiant de client : issue indéterminée.`,
    );
  }

  // ── LE LIEN, IMMÉDIATEMENT ────────────────────────────────────────────────
  await bindResource({
    projectId,
    environment,
    resourceType: CUSTOMER,
    resourceId: customer.id,
    source: BINDING_SOURCES.PANEL_CREATED,
    createdByOperationId: intent.operationId,
  }).catch((error) => {
    logger.error(
      `[stripe] client ${maskResourceId(customer.id)} créé mais NON LIÉ `
      + `(${projectId}, ${environment}) : ${error?.code ?? 'UNEXPECTED'}.`,
    );
    throw new CapabilityError(
      CAPABILITY_ERROR_CODES.TIMEOUT,
      `« ${definition.code} » : le client a été créé mais le Panel n’a pas pu enregistrer `
      + 'son appartenance. La reprise de la même opération le retrouvera.',
      { reason: 'BINDING_WRITE_FAILED' },
    );
  });

  /**
   * LE NUMÉRO DE TVA DU CLIENT — après la création, jamais dedans.
   *
   * Stripe n'accepte pas `tax_id` à la création d'un client : c'est une
   * sous-ressource. L'inclure ferait échouer la création entière pour un champ
   * inconnu — devant un client qui paie.
   */
  await poserNumeroTva({
    definition, credentials, fetchImpl, environment,
    customerId: customer.id, taxIdentity: intent.taxIdentity, existants: [],
  });

  return { customerId: customer.id, status: 'CREATED' };
}

/**
 * L'IDENTITÉ CHEZ LE FOURNISSEUR EST-ELLE CELLE QUE LE PANEL DIT ?
 *
 * Compare les seuls champs que le Panel gouverne — nom, e-mail, adresse,
 * téléphone. Les autres attributs du client Stripe (solde, moyens de paiement,
 * préférences) ne nous appartiennent pas et ne sont jamais touchés.
 *
 * L'adresse est comparée CHAMP PAR CHAMP plutôt que par égalité d'objets :
 * Stripe rend toujours les cinq clés, à `null` pour celles qu'on n'a pas
 * envoyées, et une comparaison structurelle conclurait à un écart permanent —
 * donc à une écriture à chaque paiement.
 */
function identiteDiverge(actuel, voulu) {
  const norm = (v) => String(v ?? '').trim();
  if (norm(actuel?.name) !== norm(voulu.name)) return true;
  if (norm(actuel?.email) !== norm(voulu.email)) return true;
  if (norm(actuel?.phone) !== norm(voulu.phone)) return true;

  const a = actuel?.address ?? {};
  const b = voulu.address ?? {};
  for (const cle of ['line1', 'line2', 'postal_code', 'city', 'country']) {
    if (norm(a[cle]) !== norm(b[cle])) return true;
  }
  return false;
}

async function convergerIdentiteClient({
  definition, credentials, fetchImpl, customerId, actuel, voulu, taxIdentity, environment,
}) {
  if (identiteDiverge(actuel, voulu)) {
    /**
     * LA CLÉ D'IDEMPOTENCE PORTE L'EMPREINTE DE CE QU'ON ÉCRIT.
     *
     * Une clé fixe ferait répondre à la SECONDE correction le résultat de la
     * première : l'entreprise déménagerait deux fois, et Stripe garderait la
     * première adresse en rendant « déjà fait ». L'empreinte du contenu rend
     * chaque écriture distincte tout en restant reproductible au rejeu.
     */
    const empreinte = createHash('sha256')
      .update(JSON.stringify({ customerId, voulu }))
      .digest('hex')
      .slice(0, 32);
    await guard(definition, () => updateCustomer({
      credentials,
      customerId,
      params: voulu,
      idempotencyKey: `pcp_cusupd_${empreinte}`,
      timeoutMs: definition.timeoutMs,
      fetchImpl,
    }));
    logger.info(
      `[stripe] identité de facturation convergée — ${maskResourceId(customerId)} (${environment}).`,
    );
  }

  /**
   * LES NUMÉROS DE TVA DÉJÀ POSÉS sont relus AVANT d'en ajouter un.
   *
   * Stripe accepte plusieurs `tax_id` par client et n'en déduplique aucun :
   * sans cette lecture, chaque paiement en ajouterait un, et la facture
   * finirait par afficher cinq fois le même numéro.
   */
  const { taxIds } = await guard(definition, () => listCustomerTaxIds({
    credentials, customerId, timeoutMs: definition.timeoutMs, fetchImpl,
  }));
  await poserNumeroTva({
    definition, credentials, fetchImpl, environment, customerId, taxIdentity, existants: taxIds,
  });
}

/**
 * POSE le numéro de TVA du client — s'il en a un, et s'il n'y est pas déjà.
 *
 * ══ POURQUOI L'ÉCHEC N'INTERROMPT RIEN ══════════════════════════════════════
 *
 * Stripe VALIDE le format d'un `tax_id` et refuse ce qu'il ne reconnaît pas.
 * Un refus signifie « ce numéro ne ressemble pas à un numéro de TVA
 * intracommunautaire » — c'est une information utile à un exploitant, ce n'est
 * pas une raison d'empêcher un client de payer.
 *
 * L'échec est donc JOURNALISÉ et la facturation continue : elle partira sans le
 * numéro de TVA de l'acheteur, ce qui est exactement l'état d'avant ce lot.
 * Faire échouer un paiement pour une mention facultative serait une régression
 * déguisée en rigueur.
 */
async function poserNumeroTva({
  definition, credentials, fetchImpl, environment, customerId, taxIdentity, existants,
}) {
  if (!taxIdentity?.value) return;
  const deja = (existants ?? []).some(
    (t) => String(t?.value ?? '').toUpperCase() === taxIdentity.value.toUpperCase(),
  );
  if (deja) return;

  try {
    await createCustomerTaxId({
      credentials,
      customerId,
      type: taxIdentity.type,
      value: taxIdentity.value,
      idempotencyKey: `pcp_taxid_${customerId}_${taxIdentity.value}`.toLowerCase(),
      timeoutMs: definition.timeoutMs,
      fetchImpl,
    });
    logger.info(
      `[stripe] numéro de TVA client posé sur ${maskResourceId(customerId)} (${environment}).`,
    );
  } catch (error) {
    logger.warn(
      `[stripe] numéro de TVA client REFUSÉ par le fournisseur sur ${maskResourceId(customerId)} `
      + `(${environment}) : ${error?.code ?? error?.message ?? 'motif inconnu'}. `
      + 'La facture partira sans cette mention — vérifiez le numéro sur la fiche client.',
    );
  }
}

/* -------------------------------------------------------------------------- */
/*  billing.price.ensure                                                      */
/* -------------------------------------------------------------------------- */

const PRODUCT = STRIPE_RESOURCE_TYPES.PRODUCT;
const PRICE = STRIPE_RESOURCE_TYPES.PRICE;

/**
 * GARANTIT une ressource Stripe créée par le Panel, et son lien.
 *
 * ══ POURQUOI CE GÉNÉRIQUE EXISTE ════════════════════════════════════════════
 *
 * Product et Price posent EXACTEMENT le même problème : un acte externe dont la
 * trace locale peut manquer, et dont on veut une seule instance par identité
 * métier. Écrire deux fois la même séquence de trois barrières donnerait deux
 * occasions de diverger — et c'est toujours la copie oubliée qui duplique.
 *
 * Les trois barrières de L6.2B, dans l'ordre :
 *
 *   1. LE LIEN, définitif — `createdByOperationId` répond « cet acte a-t-il
 *      déjà produit sa ressource ? » sans interroger personne.
 *   2. LA CLÉ D'IDEMPOTENCE, dans la fenêtre du fournisseur.
 *   3. LE REGISTRE D'OPÉRATIONS, en amont, qui empêche N appels concurrents.
 */
async function ensureBoundResource({
  definition, projectId, environment, resourceType, operationId,
  params, credentials, fetchImpl, create, idOf: extraireId,
}) {
  const connu = await findBindingByOperation({
    projectId, environment, resourceType, operationId,
  });
  if (connu && !connu.revokedAt) {
    return { id: connu.resourceId, status: 'EXISTING' };
  }
  if (connu?.revokedAt) {
    /**
     * Lien révoqué : on a cessé de reconnaître cette ressource. En créer une
     * seconde donnerait deux tarifs pour des termes identiques — précisément ce
     * que la clé métier empêche. Un humain tranche.
     */
    throw new CapabilityError(
      CAPABILITY_ERROR_CODES.NOT_AVAILABLE,
      `« ${definition.code} » : une ressource de cet acte a été révoquée.`,
      { reason: 'BINDING_REVOKED' },
    );
  }

  const idempotencyKey = deriveIdempotencyKey({
    environment, projectId, capability: definition.code, operationId,
  });

  const reponse = await guard(definition, () => create({
    credentials, params, idempotencyKey, timeoutMs: definition.timeoutMs, fetchImpl,
  }));
  const id = extraireId(reponse);
  if (!id) {
    throw new CapabilityError(
      CAPABILITY_ERROR_CODES.TIMEOUT,
      `Stripe a répondu à « ${definition.code} » sans identifiant : issue indéterminée.`,
    );
  }

  await bindResource({
    projectId, environment, resourceType, resourceId: id,
    source: BINDING_SOURCES.PANEL_CREATED,
    createdByOperationId: operationId,
  }).catch((error) => {
    logger.error(
      `[stripe] ${resourceType} ${maskResourceId(id)} créé mais NON LIÉ `
      + `(${projectId}, ${environment}) : ${error?.code ?? 'UNEXPECTED'}.`,
    );
    throw new CapabilityError(
      CAPABILITY_ERROR_CODES.TIMEOUT,
      `« ${definition.code} » : la ressource a été créée mais le Panel n’a pas pu enregistrer `
      + 'son appartenance. La reprise de la même opération la retrouvera.',
      { reason: 'BINDING_WRITE_FAILED' },
    );
  });

  return { id, status: 'CREATED' };
}

/**
 * Garantit le tarif d'un contrat — Product PUIS Price, les deux liés.
 *
 * ══ POURQUOI UNE SEULE CAPACITÉ POUR DEUX RESSOURCES ════════════════════════
 *
 * L6.1 l'avait déjà tranché : `createProduct` et `createPrice` « ne sont jamais
 * un but, seulement les deux étapes que `ensureProductAndPrice` traverse ». Les
 * exposer séparément donnerait au projet le pouvoir de créer des produits
 * arbitraires sur le compte de la plateforme, pour un usage qui n'existe pas.
 *
 * ══ L'ORDRE EST IMPOSÉ PAR STRIPE ═══════════════════════════════════════════
 *
 * Un Price référence son Product : il ne peut pas exister avant lui. La fenêtre
 * « Product créé, Price pas encore » est donc structurelle, et c'est la barrière
 * 1 qui la referme au passage suivant — le Product est retrouvé par son lien,
 * et seul le Price manquant est créé.
 */
async function priceEnsure({ definition, context, credentials, input, fetchImpl }) {
  const { projectId, environment } = context;

  // ── BARRIÈRE 0 : L'AUTORITÉ — le contrat, et SES termes ───────────────────
  const intent = await guard(definition, () => resolvePriceIntent({
    projectId, environment, contractRef: input.contractRef,
  }));

  const product = await ensureBoundResource({
    definition, projectId, environment,
    resourceType: PRODUCT,
    operationId: intent.productOperationId,
    params: intent.productParams,
    credentials, fetchImpl,
    create: createProduct,
    idOf: (r) => r.product?.id ?? null,
  });

  const price = await ensureBoundResource({
    definition, projectId, environment,
    resourceType: PRICE,
    operationId: intent.priceOperationId,
    params: intent.priceParamsFor(product.id),
    credentials, fetchImpl,
    create: createPrice,
    idOf: (r) => r.price?.id ?? null,
  });

  return {
    priceId: price.id,
    productId: product.id,
    /** `EXISTING` dès que le TARIF était déjà là : c'est lui qui compte. */
    status: price.status,
    interval: intent.interval,
    intervalCount: intent.intervalCount,
    amount: intent.amount,
    currency: intent.currency,
  };
}

/* -------------------------------------------------------------------------- */
/*  billing.subscription.cancel_*                                             */
/* -------------------------------------------------------------------------- */

const SUBSCRIPTION = STRIPE_RESOURCE_TYPES.SUBSCRIPTION;

/**
 * RÉSILIE — une seule fois, quoi qu'il arrive.
 *
 * ══ L'ORDRE, ET IL N'EST PAS NÉGOCIABLE ═════════════════════════════════════
 *
 *   1. APPARTENANCE   avant tout contact fournisseur. Un abonnement qui n'est
 *                     pas au projet ne doit pas même être LU — sinon la durée
 *                     de réponse trahirait son existence.
 *   2. ÉTAT           l'acte est-il déjà inscrit ? Une résiliation laisse une
 *                     trace non ambiguë, contrairement à un paiement.
 *   3. MUTATION       seulement si l'état dit qu'elle n'a pas eu lieu.
 *
 * L'étape 2 est ce qui rend ce lot possible. Elle coûte une lecture, et elle
 * évite la seule chose qu'on ne peut pas défaire : couper deux fois, ou pire,
 * conclure qu'on n'a pas coupé alors qu'on l'a fait.
 *
 * @param {'AT_PERIOD_END'|'NOW'} kind
 */
async function cancelSubscription({ definition, context, credentials, input, fetchImpl, kind, mutate }) {
  const { projectId, environment } = context;
  const subscriptionId = input.subscriptionId;

  // ── 1. L'APPARTENANCE, AVANT TOUT CONTACT ────────────────────────────────
  await guard(definition, () => assertOwnedResource({
    projectId, environment, resourceType: SUBSCRIPTION, resourceId: subscriptionId,
  }));

  // ── 2. L'ÉTAT — l'acte est-il déjà inscrit ? ─────────────────────────────
  const lu = await guard(definition, () => retrieveSubscription({
    credentials, subscriptionId, timeoutMs: definition.timeoutMs, fetchImpl,
  }));
  const etat = describeCancellationState(lu.subscription, kind);

  if (etat === CANCELLATION_STATE.INDETERMINATE) {
    /**
     * Le lien affirme, le fournisseur ne rend rien d'exploitable. On ne mute
     * PAS : agir sans savoir dans quel état on agit est exactement ce que ce
     * module existe pour empêcher. Le lien est conservé — l'avis ponctuel d'un
     * fournisseur ne fait pas une décision d'appartenance.
     */
    logger.error(
      `[stripe-cancel] INCOHÉRENCE — ${maskResourceId(subscriptionId)} est lié à ${projectId} `
      + `(${environment}) mais son état est illisible. AUCUNE mutation émise.`,
    );
    throw new CapabilityError(
      CAPABILITY_ERROR_CODES.PROVIDER_UNAVAILABLE,
      `« ${definition.code} » : l’état de l’abonnement n’est pas lisible, aucune résiliation n’a été tentée.`,
      { reason: 'SUBSCRIPTION_STATE_UNREADABLE' },
    );
  }

  if (etat === CANCELLATION_STATE.ALREADY_DONE) {
    /**
     * CONVERGENCE PAR L'ÉTAT — le cas qui justifie tout le module.
     *
     * Un rejeu après réponse perdue, un double clic, un redémarrage du projet :
     * tous arrivent ici, et aucun n'émet de seconde mutation. La différence
     * avec un paiement est que l'état RÉPOND, au lieu de laisser un doute.
     */
    logConvergence({ subscriptionId, environment, kind, projectId });
    return describeCancelledSubscription(lu.subscription, { alreadyDone: true });
  }

  // ── 3. LA MUTATION ───────────────────────────────────────────────────────
  const idempotencyKey = deriveIdempotencyKey({
    environment, projectId, capability: definition.code,
    operationId: cancellationOperationId({ environment, subscriptionId }),
  });

  const mute = await guard(definition, () => mutate({
    credentials, subscriptionId, idempotencyKey, timeoutMs: definition.timeoutMs, fetchImpl,
  }));

  const apres = mute.subscription;
  if (!apres?.id) {
    /**
     * 2xx sans corps exploitable : la résiliation a PEUT-ÊTRE eu lieu. On ne
     * conclut pas — la reprise relira l'état, qui tranchera.
     */
    throw new CapabilityError(
      CAPABILITY_ERROR_CODES.TIMEOUT,
      `Stripe a répondu à « ${definition.code} » sans état exploitable : issue indéterminée.`,
    );
  }

  return describeCancelledSubscription(apres, { alreadyDone: false });
}

async function subscriptionCancelAtPeriodEnd(args) {
  return cancelSubscription({ ...args, kind: 'AT_PERIOD_END', mutate: cancelSubscriptionAtPeriodEnd });
}

async function subscriptionCancelNow(args) {
  return cancelSubscription({ ...args, kind: 'NOW', mutate: cancelSubscriptionNow });
}

/* -------------------------------------------------------------------------- */
/*  billing.refund                                                            */
/* -------------------------------------------------------------------------- */

const PAYMENT_INTENT = STRIPE_RESOURCE_TYPES.PAYMENT_INTENT;

/**
 * REMBOURSE — une fois par intention, jamais deux, y compris un an après.
 *
 * ══ L'ORDRE, ET IL N'EST PAS NÉGOCIABLE ═════════════════════════════════════
 *
 *   1. APPARTENANCE   avant tout contact fournisseur. Un paiement qui n'est pas
 *                     au projet ne doit pas même être LU — sinon la durée de
 *                     réponse trahirait son existence.
 *   2. ÉTAT           NOTRE acte est-il déjà inscrit ? On ne demande pas « ce
 *                     paiement est-il remboursé » : la question n'a pas de
 *                     réponse utile, un paiement pouvant l'être plusieurs fois.
 *                     On cherche notre identité dans la métadonnée.
 *   3. MUTATION       seulement si notre acte n'existe pas encore.
 *
 * ══ CE QUE L'ÉTAPE 2 ACHÈTE ════════════════════════════════════════════════
 *
 * La fenêtre d'idempotence de Stripe est bornée à 24 h. Au-delà, rejouer la
 * même clé ne converge plus : elle crée un SECOND remboursement, bien réel.
 * C'est le pire défaut que ce lot puisse produire, et la seule protection est
 * de reconnaître notre propre acte dans la liste des remboursements — ce que
 * `metadata[ly_operation_id]`, apposé à l'étape 3, rend possible pour toujours.
 *
 * ══ CE QU'ON NE VERROUILLE PAS, ET POURQUOI C'EST CORRECT ═══════════════════
 *
 * Le restant remboursable calculé à l'étape 2 est une COURTOISIE : entre sa
 * lecture et l'écriture, un autre opérateur peut rembourser. Aucun verrou
 * applicatif ne fermerait cette fenêtre — le fournisseur est la seule autorité
 * sur les sommes. Stripe refuse tout dépassement de façon atomique ; deux
 * remboursements partiels concurrents produisent donc au pire un refus propre,
 * jamais un excédent.
 */
async function refundCreate({ definition, context, credentials, input, fetchImpl }) {
  const { projectId, environment } = context;
  const { paymentIntentId, amountCents, reason, operationId } = input;

  // ── 1. L'APPARTENANCE, AVANT TOUT CONTACT ────────────────────────────────
  await guard(definition, () => assertOwnedResource({
    projectId, environment, resourceType: PAYMENT_INTENT, resourceId: paymentIntentId,
  }));

  // ── 2. L'ÉTAT — notre acte est-il déjà inscrit ? ─────────────────────────
  const lu = await guard(definition, () => retrievePaymentIntent({
    credentials, paymentIntentId, timeoutMs: definition.timeoutMs, fetchImpl,
  }));
  const liste = await guard(definition, () => listRefunds({
    credentials, paymentIntentId, timeoutMs: definition.timeoutMs, fetchImpl,
  }));

  if (liste.truncated) {
    /**
     * Plus de cent remboursements sur un paiement : la somme serait fausse et
     * notre acte pourrait se cacher dans la page suivante. On ne mute PAS.
     */
    throw new CapabilityError(
      CAPABILITY_ERROR_CODES.PROVIDER_UNAVAILABLE,
      `« ${definition.code} » : l’historique de remboursement est trop long pour être lu d’un bloc.`,
      { reason: 'REFUND_HISTORY_TRUNCATED' },
    );
  }

  const { charge } = chargeOfPaymentIntent(lu.paymentIntent);
  const receiptUrl = receiptUrlOfCharge(charge);
  const deja = findOwnRefund({ refunds: liste.refunds, operationId });

  if (deja.state === REFUND_ACT_STATE.ALREADY_DONE) {
    /**
     * CONVERGENCE PAR L'IDENTITÉ — le cas qui justifie tout le module.
     *
     * Réponse perdue, double clic, reprise après redémarrage, rejeu hors
     * fenêtre : tous arrivent ici, et aucun n'émet un second remboursement.
     */
    logger.info(
      `[stripe-refund] CONVERGENCE — ${maskResourceId(paymentIntentId)} porte déjà `
      + `l’acte ${operationId} (${environment}, projet ${projectId}). Aucune mutation.`,
    );
    const montants = describeRefundableAmount({ paymentIntent: lu.paymentIntent, refunds: liste.refunds });
    return {
      ...vueContractuelle(describeRefund(deja.refund, { receiptUrl })),
      ...(montants ?? { collectedCents: 0, refundedCents: 0, remainingCents: 0 }),
      outcome: 'ALREADY_REFUNDED',
    };
  }

  const avant = describeRefundableAmount({ paymentIntent: lu.paymentIntent, refunds: liste.refunds });
  if (!avant) {
    /**
     * Le lien affirme, le fournisseur ne rend rien de chiffrable. On ne mute
     * PAS : rembourser sans savoir combien est entré est exactement ce que ce
     * module existe pour empêcher.
     */
    logger.error(
      `[stripe-refund] INCOHÉRENCE — ${maskResourceId(paymentIntentId)} est lié à ${projectId} `
      + `(${environment}) mais ses montants sont illisibles. AUCUN remboursement émis.`,
    );
    throw new CapabilityError(
      CAPABILITY_ERROR_CODES.PROVIDER_UNAVAILABLE,
      `« ${definition.code} » : les montants du paiement ne sont pas lisibles, aucun remboursement n’a été tenté.`,
      { reason: 'PAYMENT_AMOUNTS_UNREADABLE' },
    );
  }

  if (avant.remainingCents <= 0) {
    throw new CapabilityError(
      CAPABILITY_ERROR_CODES.INPUT_INVALID,
      `« ${definition.code} » : ce paiement a déjà été intégralement remboursé.`,
      { reason: 'NOTHING_LEFT_TO_REFUND' },
    );
  }
  if (Number.isInteger(amountCents) && amountCents > avant.remainingCents) {
    throw new CapabilityError(
      CAPABILITY_ERROR_CODES.INPUT_INVALID,
      `« ${definition.code} » : le montant demandé dépasse le remboursable restant.`,
      { reason: 'REFUND_EXCEEDS_REMAINING' },
    );
  }

  // ── 3. LA MUTATION ───────────────────────────────────────────────────────
  const idempotencyKey = deriveIdempotencyKey({
    environment, projectId, capability: definition.code, operationId,
  });

  const mute = await guard(definition, () => createRefund({
    credentials,
    paymentIntentId,
    amountCents,
    reason,
    /** L'identité de l'acte, déposée CHEZ STRIPE. Sans elle, pas de rejeu sûr. */
    metadata: { [REFUND_OPERATION_METADATA_KEY]: operationId },
    idempotencyKey,
    timeoutMs: definition.timeoutMs,
    fetchImpl,
  }));

  const fait = describeRefund(mute.refund, { receiptUrl });
  if (!fait) {
    /**
     * 2xx sans remboursement exploitable : l'argent est PEUT-ÊTRE parti. On ne
     * conclut pas — la reprise relira la liste, où la métadonnée tranchera.
     */
    throw new CapabilityError(
      CAPABILITY_ERROR_CODES.TIMEOUT,
      `Stripe a répondu à « ${definition.code} » sans remboursement exploitable : issue indéterminée.`,
    );
  }

  const rendu = avant.refundedCents + fait.amountCents;
  return {
    ...vueContractuelle(fait),
    collectedCents: avant.collectedCents,
    refundedCents: rendu,
    remainingCents: Math.max(0, avant.collectedCents - rendu),
    outcome: 'REFUNDED',
  };
}

/**
 * NE REND QUE CE QUE LE CONTRAT DÉCLARE.
 *
 * `describeRefund` porte aussi `operationId` — utile au diagnostic interne,
 * absent du contrat de sortie, et refusé par un schéma `strict()`. Le laisser
 * passer faisait échouer la VALIDATION APRÈS que Stripe eut remboursé : l'acte
 * réussissait, la passerelle le rejetait, et la demande se concluait en échec
 * sur un argent bel et bien parti. Une projection explicite ferme ce piège.
 */
function vueContractuelle(fait) {
  return {
    refundId: fait.refundId,
    status: fait.status,
    amountCents: fait.amountCents,
    currency: fait.currency,
    paymentIntentId: fait.paymentIntentId,
    chargeId: fait.chargeId,
    reason: fait.reason,
    createdAt: fait.createdAt,
    receiptUrl: fait.receiptUrl,
  };
}

/* -------------------------------------------------------------------------- */
/*  LA TABLE                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Un seul verbe. La table existe quand même : elle est le point d'accroche des
 * suivants, et `assertAdapterAlignment()` vérifie qu'aucune capacité Stripe
 * déclarée servie n'y manque — ni l'inverse.
 */
/**
 * GARANTIR L'ENDPOINT WEBHOOK DU PROJET (L6.3A).
 *
 * L'adaptateur est volontairement MINCE : il traduit l'entrée validée en un
 * appel au réconciliateur de webhooks, qui possède déjà toute la doctrine —
 * reconnaissance par jeton d'appartenance, dérive, préflight du plafond, et la
 * stratégie de secret « rendu à la création seulement ».
 *
 * Écrire ici une seconde logique de convergence aurait produit deux vérités sur
 * la même question, destinées à diverger au premier cas limite.
 *
 * ── CE QU'IL NE FAIT PAS TRANSITER ──────────────────────────────────────────
 *
 * Le secret capturé ne remonte PAS dans le résultat. Il est rangé par le
 * réconciliateur dans le coffre du projet, et le projet ira le chercher par la
 * route dédiée. Ce que l'on rend ici est un CONSTAT — y compris « il y a un
 * secret à relire », qui n'en dit pas la valeur.
 */
async function webhookEndpointEnsure({ context, input, fetchImpl }) {
  const resultat = await ensureProjectWebhookEndpoint({
    provider: 'STRIPE',
    projectId: context.projectId,
    publicBackendUrl: input.publicBackendUrl,
    callbackPath: PROJECT_STRIPE_WEBHOOK_PATH,
    environment: context.environment,
    fetchImpl,
  });

  /**
   * UN ÉCHEC DE RÉCONCILIATION N'EST PAS UN SUCCÈS SILENCIEUX.
   *
   * Le réconciliateur ne lève pas : il rend un diagnostic, parce que son
   * appelant historique est une tâche de fond qui doit continuer. Ici,
   * l'appelant est un projet qui attend une réponse — lui rendre `ok` avec un
   * endpoint absent le laisserait croire qu'il peut recevoir des événements.
   */
  if (!resultat.remoteWebhookId && !resultat.created) {
    throw new CapabilityError(
      CAPABILITY_ERROR_CODES.PROVIDER_UNAVAILABLE,
      resultat.message || 'Endpoint webhook non garanti chez le fournisseur.',
      { reason: resultat.code || 'WEBHOOK_ENDPOINT_NOT_ENSURED' },
    );
  }

  return {
    endpointId: resultat.remoteWebhookId ?? null,
    url: resultat.observedUrl || resultat.desiredUrl || '',
    events: resultat.desiredEvents ?? [],
    status: String(resultat.status ?? ''),
    created: Boolean(resultat.created),
    updated: Boolean(resultat.updated),
    secretAvailable: Boolean(resultat.secretConfigured),
    secretRenewed: Boolean(resultat.secretCaptured),
  };
}

/* -------------------------------------------------------------------------- */
/*  L6.3B — LES FACTURES ET LE PORTAIL, SUR L'APPARTENANCE DU CLIENT          */
/* -------------------------------------------------------------------------- */

/**
 * LE CLIENT POSSÉDÉ D'UN CONTRAT — la barrière commune aux trois verbes.
 *
 * ══ POURQUOI ELLE PRÉCÈDE TOUT APPEL ═══════════════════════════════════════
 *
 * Les trois capacités de ce lot désignent leur objet par un CONTRAT, jamais par
 * un identifiant Stripe. Il faut donc traduire « ce contrat » en « ce client »,
 * et cette traduction est le seul endroit où l'appartenance se décide.
 *
 * Elle interroge le registre de liens — écrit par `billing.customer.ensure` en
 * L6.2D — et rien d'autre. Pas les metadata, pas la projection, pas ce que le
 * projet affirme : un lien, ou un refus.
 *
 * Le refus est INDISTINGUABLE dans les trois cas qui comptent — contrat
 * inconnu, contrat d'un autre projet, lien révoqué — et il tombe AVANT le
 * premier octet envoyé à Stripe. Sans cela, la durée de réponse suffirait à
 * apprendre quels contrats existent ailleurs.
 */
async function ownedCustomerOfContract({ definition, context, input }) {
  const { projectId, environment } = context;

  // Le contrat est-il bien à ce projet ? (même autorité qu'en L6.2D)
  const intent = await guard(definition, () => resolveCustomerIntent({
    projectId, environment, input: { contractRef: input.contractRef },
  }));

  /**
   * Le lien porte l'identité DÉRIVÉE du contrat : on ne cherche pas « un
   * client de ce projet » mais « LE client de CE contrat ». La nuance compte —
   * un projet a plusieurs contrats, et servir le mauvais client ouvrirait les
   * factures d'un autre client au même projet.
   */
  const lien = await findBindingByOperation({
    projectId, environment, resourceType: CUSTOMER, operationId: intent.operationId,
  });
  if (!lien || lien.revokedAt) {
    throw capabilityResourceNotOwned(definition.code);
  }
  return { customerId: lien.resourceId, contractId: intent.contractId };
}

/** Ce qu'une facture montre au projet — jamais l'objet Stripe brut. */
function vueFacture(facture) {
  const idOf = (v) => (typeof v === 'string' ? v : v?.id ?? null);
  const nombre = (v) => (Number.isFinite(v) ? v : null);
  return {
    invoiceId: String(facture.id),
    number: facture.number ?? null,
    status: facture.status ?? null,
    paid: facture.paid === true || facture.status === 'paid',
    amountDue: nombre(facture.amount_due),
    amountPaid: nombre(facture.amount_paid),
    total: nombre(facture.total),
    tax: nombre(facture.tax),
    currency: facture.currency ?? null,
    createdAt: nombre(facture.created),
    dueAt: nombre(facture.due_date),
    paidAt: nombre(facture.status_transitions?.paid_at),
    billingReason: facture.billing_reason ?? null,
    hostedInvoiceUrl: facture.hosted_invoice_url ?? null,
    invoicePdfUrl: facture.invoice_pdf ?? null,
    customerId: idOf(facture.customer),
    /**
     * L'abonnement d'origine se lit à DEUX endroits selon la version d'API :
     * `subscription` en `acacia`, `parent.subscription_details` en `basil`.
     * C'est l'incident RX-01, et l'épinglage de version ne dispense pas de le
     * savoir — une montée de version le déplacerait sans prévenir.
     */
    subscriptionId: idOf(facture.subscription ?? facture.parent?.subscription_details?.subscription),
  };
}

/** `billing.invoice.list` — les factures du client possédé, et d'aucun autre. */
async function invoiceList({ definition, context, credentials, input, fetchImpl }) {
  const { customerId } = await ownedCustomerOfContract({ definition, context, input });

  const res = await guard(definition, () => listInvoices({
    credentials, customer: customerId, limit: input.limit ?? 100,
    timeoutMs: definition.timeoutMs, fetchImpl,
  }));

  return {
    invoices: (res.invoices ?? []).map(vueFacture),
    hasMore: Boolean(res.hasMore),
  };
}

/**
 * `billing.invoice.retrieve` — UNE facture, si elle est bien à ce client.
 *
 * La FILIATION est vérifiée après la lecture, et c'est le seul ordre possible :
 * seul Stripe sait à quel client appartient une facture. Mais l'appartenance du
 * CLIENT, elle, a été prouvée avant — un projet ne peut donc pas se servir de
 * ce verbe pour sonder l'existence de factures qui ne sont pas les siennes.
 */
async function invoiceRetrieve({ definition, context, credentials, input, fetchImpl }) {
  const { customerId } = await ownedCustomerOfContract({ definition, context, input });

  const res = await guard(definition, () => retrieveInvoice({
    credentials, invoiceId: input.invoiceId, timeoutMs: definition.timeoutMs, fetchImpl,
  }));
  const vue = vueFacture(res.invoice ?? {});

  if (!vue.customerId || vue.customerId !== customerId) {
    /**
     * MÊME REFUS QU'UNE FACTURE INEXISTANTE. Distinguer « elle existe mais
     * n'est pas à vous » de « elle n'existe pas » transformerait ce verbe en
     * oracle : on apprendrait, un identifiant à la fois, quelles factures le
     * compte contient.
     */
    logger.warn(
      `[stripe] refus de filiation — facture demandée par ${context.projectId} `
      + `(${context.environment}) : son client n’est pas celui du contrat.`,
    );
    throw capabilityResourceNotOwned(definition.code);
  }
  return vue;
}

/**
 * `billing.portal.create` — la porte du client, ouverte pour SON client.
 *
 * Stripe héberge l'écran : aucune donnée bancaire n'approche ni le projet ni le
 * Panel. Ce que ce verbe décide, et la seule chose qu'il décide, est DE QUI on
 * ouvre le dossier.
 */
async function portalCreate({ definition, context, credentials, input, fetchImpl }) {
  const { customerId } = await ownedCustomerOfContract({ definition, context, input });

  const res = await guard(definition, () => createBillingPortalSession({
    credentials, customer: customerId, returnUrl: input.returnUrl,
    timeoutMs: definition.timeoutMs, fetchImpl,
  }));

  const session = res.session ?? {};
  if (!session.url) {
    throw new CapabilityError(
      CAPABILITY_ERROR_CODES.PROVIDER_UNAVAILABLE,
      `« ${definition.code} » : le fournisseur n’a pas rendu d’adresse de portail.`,
      { reason: 'PORTAL_URL_MISSING' },
    );
  }
  return {
    url: String(session.url),
    expiresAt: Number.isFinite(session.expires_at) ? session.expires_at : null,
  };
}

export const STRIPE_ADAPTERS = Object.freeze({
  /**
   * L6.3B — les trois verbes qui retirent au projet ses dernières lectures
   * Stripe. Tous trois remontent au client par le LIEN d'appartenance, jamais
   * par un identifiant que le projet présenterait.
   */
  'billing.invoice.list': invoiceList,
  'billing.invoice.retrieve': invoiceRetrieve,
  'billing.portal.create': portalCreate,
  /**
   * L6.3A — le seul verbe qui n'agit pas sur de l'argent : il administre
   * l'endpoint par lequel le projet apprendra qu'il en a reçu.
   */
  'webhook.endpoint.ensure': webhookEndpointEnsure,
  'billing.checkout.create': checkoutCreate,
  /**
   * LA LECTURE, SERVIE PARCE QU'ELLE A ENFIN UN PROPRIÉTAIRE À VÉRIFIER.
   *
   * Elle attendait depuis L6.1, non par prudence de calendrier mais faute
   * d'ancrage : lire une session sans savoir à qui elle est aurait donné à
   * n'importe quel projet le droit de lire n'importe quelle session du compte.
   * L6.2B a commencé à en créer et à les lier ; il y a donc désormais quelque
   * chose à vérifier.
   */
  'billing.checkout.retrieve': checkoutRetrieve,
  /**
   * LE CLIENT — première ressource Stripe que le Panel crée pour un CONTRAT,
   * et non pour un acte ponctuel. C'est elle qui débloquera l'abonnement, dont
   * la session référence un client et un tarif créés avant elle.
   */
  'billing.customer.ensure': customerEnsure,
  /**
   * LE TARIF — dernière ressource qui manquait au checkout d'abonnement. Elle
   * crée DEUX objets Stripe (Product puis Price) parce que le fournisseur
   * l'impose, mais elle reste UN acte métier : « ce contrat a-t-il son tarif ? ».
   */
  'billing.price.ensure': priceEnsure,
  /**
   * LA LECTURE D'UN ABONNEMENT — servie parce qu'il a enfin un propriétaire.
   *
   * Elle attendait depuis L6.1, non par prudence mais faute d'ancrage : lire un
   * abonnement sans savoir à qui il est aurait donné à n'importe quel projet le
   * droit de lire n'importe quel abonnement du compte.
   */
  'billing.subscription.retrieve': subscriptionRetrieve,
  /**
   * LES DEUX RÉSILIATIONS — le dernier chemin d'écriture Stripe du parcours
   * d'abonnement encore local, et celui qui portait le plus vieux défaut connu
   * du parc : une coupure immédiate SANS aucune clé d'idempotence (L6.1).
   */
  'billing.subscription.cancel_at_period_end': subscriptionCancelAtPeriodEnd,
  'billing.subscription.cancel_now': subscriptionCancelNow,
  /**
   * LE REMBOURSEMENT — la seule écriture du parc qui RENDE de l'argent, et la
   * seule dont aucun code projet n'a jamais existé. Elle ne migre rien : elle
   * naît dans le plan de contrôle, appelée par le Panel pour un projet.
   */
  'billing.refund': refundCreate,
});

export default { STRIPE_ADAPTERS, translateStripeError };
