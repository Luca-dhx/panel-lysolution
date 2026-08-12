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

  if (error instanceof CheckoutAuthorityError || error instanceof CustomerAuthorityError) {
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
    params: intent.params,
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

  return describeSession(session, 'CREATED', input.operationId);
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
});

export default { STRIPE_ADAPTERS, translateStripeError };
