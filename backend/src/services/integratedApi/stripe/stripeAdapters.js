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
} from '../../capabilities/capabilityErrors.js';
import {
  createCheckoutSession,
  retrieveCheckoutSession,
  StripeTransportError,
  TRANSPORT_CODES,
  OUTCOMES,
} from './stripeTransport.js';
import {
  STRIPE_RESOURCE_TYPES,
  BINDING_SOURCES,
  bindResource,
  findBindingByOperation,
  maskResourceId,
} from './stripeResourceBinding.js';
import {
  CheckoutAuthorityError,
  deriveIdempotencyKey,
  resolveCheckoutIntent,
} from './stripeCheckoutAuthority.js';

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

  if (error instanceof CheckoutAuthorityError) {
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
/*  LA TABLE                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Un seul verbe. La table existe quand même : elle est le point d'accroche des
 * suivants, et `assertAdapterAlignment()` vérifie qu'aucune capacité Stripe
 * déclarée servie n'y manque — ni l'inverse.
 */
export const STRIPE_ADAPTERS = Object.freeze({
  'billing.checkout.create': checkoutCreate,
});

export default { STRIPE_ADAPTERS, translateStripeError };
