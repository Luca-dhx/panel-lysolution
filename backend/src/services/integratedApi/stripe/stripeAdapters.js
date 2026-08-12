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
  retrieveSubscription,
  createProduct,
  createPrice,
  retrievePrice,
  cancelSubscriptionAtPeriodEnd,
  cancelSubscriptionNow,
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
import { adoptSubscriptionFromSession } from './stripeSubscriptionAdoption.js';
import {
  CANCELLATION_STATE,
  cancellationOperationId,
  describeCancellationState,
  describeCancelledSubscription,
  logConvergence,
} from './stripeSubscriptionCancellation.js';
import { STRIPE_CAPABILITIES } from './stripeCapabilities.js';

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
  let params = intent.params;
  let customerId = null;
  if (input.paymentType === 'SUBSCRIPTION') {
    const client = await customerEnsure({
      definition: COMPOSEES.CUSTOMER, context, credentials, fetchImpl,
      input: { contractRef: input.contractRef, customer: {} },
    });
    const tarif = await priceEnsure({
      definition: COMPOSEES.PRICE, context, credentials, fetchImpl,
      input: { contractRef: input.contractRef },
    });
    customerId = client.customerId;
    params = intent.paramsFor({ customerId: client.customerId, priceId: tarif.priceId });
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

  const vue = describeSession(session, 'CREATED', input.operationId);
  /**
   * `customer` n'est pas toujours renvoyé par Stripe sur une session fraîche ;
   * pour un abonnement, nous SAVONS lequel a été attaché puisque nous venons de
   * le garantir. Le rendre permet au projet de tenir son journal sans avoir à
   * relire la session — et sans jamais choisir le client lui-même.
   */
  return customerId ? { ...vue, customerId: vue.customerId ?? customerId } : vue;
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

  return { customerId: customer.id, status: 'CREATED' };
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
/*  LA TABLE                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Un seul verbe. La table existe quand même : elle est le point d'accroche des
 * suivants, et `assertAdapterAlignment()` vérifie qu'aucune capacité Stripe
 * déclarée servie n'y manque — ni l'inverse.
 */
export const STRIPE_ADAPTERS = Object.freeze({
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
});

export default { STRIPE_ADAPTERS, translateStripeError };
