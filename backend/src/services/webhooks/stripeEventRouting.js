// À QUI EST CET ÉVÉNEMENT ? — le routage par appartenance (L6.2C).
//
// docs/architecture/STRIPE_L6_2C_CHECKOUT_READ_WEBHOOK_OWNERSHIP_REPORT.md.
//
// ══ DEUX PREUVES, DEUX RESPONSABILITÉS ══════════════════════════════════════
//
//   LA SIGNATURE prouve que l'événement vient bien de Stripe.
//   LE LIEN prouve à quel projet appartient la ressource dont il parle.
//
// Ce sont deux questions distinctes, et confondre la première avec la seconde
// est l'erreur que ce module existe pour rendre impossible. Un événement
// parfaitement signé peut parler d'une ressource qui n'est à personne, ou dont
// les metadata désignent un projet qui n'en est pas le propriétaire.
//
// ══ METADATA ≠ APPARTENANCE ═════════════════════════════════════════════════
//
// `metadata.panelProjectId`, `metadata.contractId`, `metadata.paymentId` sont
// écrites par le Panel à la création (L6.2B) — mais elles sont ÉDITABLES depuis
// le tableau de bord Stripe par quiconque a accès au compte. En faire l'autorité
// reviendrait à laisser un champ modifiable décider qui reçoit un événement
// financier.
//
// Elles servent donc, et seulement, à CORROBORER : quand elles contredisent le
// lien, c'est le lien qui gagne, et la contradiction est journalisée. C'est un
// signal de sécurité, pas un cas d'erreur à réparer en silence.
//
// ══ CE QUE CE MODULE NE FAIT PAS ════════════════════════════════════════════
//
// Il ne MUTE aucun projet, et n'émet aucun verbe métier. Pendant la
// coexistence, SB Auto reçoit ces mêmes événements sur SON endpoint et y règle
// ses paiements ; projeter ici un second exemplaire du même fait ferait
// appliquer deux fois la même vérité par deux chemins différents.
//
// Il RÉSOUT et il ENREGISTRE. Le jour où l'endpoint du projet sera retiré, il
// restera à brancher une projection sur un destinataire déjà connu — et ce
// jour-là, la question « à qui ? » sera déjà résolue et éprouvée.
import logger from '../../utils/logger.js';
import {
  STRIPE_RESOURCE_TYPES,
  findBinding,
  maskResourceId,
} from '../integratedApi/stripe/stripeResourceBinding.js';

/* -------------------------------------------------------------------------- */
/*  VERDICTS                                                                  */
/* -------------------------------------------------------------------------- */

/** Ce que le Panel sait dire du destinataire d'un événement. Fermé. */
export const EVENT_OWNERSHIP = Object.freeze({
  /** Une ressource liée, un projet nommé. Le seul cas routable. */
  OWNED: 'OWNED',
  /** L'événement porte une ressource, mais aucun lien ne la revendique. */
  UNOWNED: 'UNOWNED',
  /** La ressource est connue, et son lien a été neutralisé. */
  REVOKED: 'REVOKED',
  /** Le type d'événement ne porte aucune ressource que le Panel sache lier. */
  NOT_ROUTABLE: 'NOT_ROUTABLE',
});

/* -------------------------------------------------------------------------- */
/*  LA MATRICE                                                                */
/* -------------------------------------------------------------------------- */

/**
 * ÉVÉNEMENT → RESSOURCE PORTEUSE D'APPARTENANCE.
 *
 * ══ POURQUOI SI PEU D'ENTRÉES ═══════════════════════════════════════════════
 *
 * Le Panel souscrit treize événements Stripe (registre L5). Seuls quatre
 * portent aujourd'hui une ressource dont il peut PROUVER l'appartenance : les
 * sessions de paiement, parce que L6.2B est le seul lot qui en crée et les lie.
 *
 * Les neuf autres parlent de `payment_intent`, `invoice`, `charge` ou
 * `subscription` : des objets que le Panel n'a jamais créés, donc jamais liés.
 * Les router exigerait de remonter du `payment_intent` vers sa session — c'est
 * possible, et c'est exactement ce qu'il ne faut PAS faire ici : cette remontée
 * demande un appel Stripe pour une ressource dont on ne sait pas encore si elle
 * nous concerne. On refuse de payer un appel fournisseur pour découvrir à qui
 * appartient quelque chose.
 *
 * Ils resteront `NOT_ROUTABLE` jusqu'à ce que leurs propres familles entrent
 * dans le registre de liens — c'est-à-dire jusqu'à `billing.customer.ensure` et
 * ce qui suivra. La matrice est donc une DETTE lisible, pas un oubli.
 */
export const EVENT_RESOURCE_MATRIX = Object.freeze({
  'checkout.session.completed': STRIPE_RESOURCE_TYPES.CHECKOUT_SESSION,
  'checkout.session.async_payment_succeeded': STRIPE_RESOURCE_TYPES.CHECKOUT_SESSION,
  'checkout.session.async_payment_failed': STRIPE_RESOURCE_TYPES.CHECKOUT_SESSION,
  'checkout.session.expired': STRIPE_RESOURCE_TYPES.CHECKOUT_SESSION,
});

/** Les événements souscrits qui ne portent pas encore d'appartenance prouvable. */
export const UNROUTABLE_EVENTS = Object.freeze([
  'payment_intent.succeeded',
  'payment_intent.payment_failed',
  'charge.refunded',
  'invoice.finalized',
  'invoice.paid',
  'invoice.payment_failed',
  'customer.subscription.created',
  'customer.subscription.updated',
  'customer.subscription.deleted',
]);

/* -------------------------------------------------------------------------- */
/*  CORROBORATION                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Ce que les metadata PRÉTENDENT. Jamais ce qu'on retient.
 *
 * Lu uniquement pour être comparé au lien : une divergence signale soit une
 * édition manuelle dans le tableau de bord, soit une tentative de détournement.
 * Dans les deux cas on veut le savoir, et dans aucun on ne veut y obéir.
 */
function claimedProjectId(object) {
  const claim = object?.metadata?.panelProjectId;
  return typeof claim === 'string' && claim.trim() ? claim.trim() : null;
}

/* -------------------------------------------------------------------------- */
/*  RÉSOLUTION                                                                */
/* -------------------------------------------------------------------------- */

/**
 * À quel projet appartient la ressource dont parle cet événement ?
 *
 * Appelé APRÈS la vérification de signature et APRÈS l'idempotence de
 * réception : un événement non prouvé n'arrive jamais ici, et un rejeu non
 * plus.
 *
 * NE LÈVE JAMAIS. Un endpoint public qui lève produit une 500, et une 500 fait
 * rejouer le fournisseur en boucle.
 *
 * @param {object} args
 * @param {string} args.provider
 * @param {string} args.environment  celui du RUNTIME, jamais celui du corps
 * @param {string} args.eventType
 * @param {object} args.payload      l'événement Stripe complet
 * @returns {Promise<{ownership: string, projectId: string|null,
 *   resourceType: string|null, resourceId: string|null, claimMismatch: boolean}>}
 */
export async function resolveStripeEventOwnership({ provider, environment, eventType, payload }) {
  const vide = {
    ownership: EVENT_OWNERSHIP.NOT_ROUTABLE,
    projectId: null,
    resourceType: null,
    resourceId: null,
    claimMismatch: false,
  };

  if (String(provider ?? '').toUpperCase() !== 'STRIPE') return vide;

  const resourceType = EVENT_RESOURCE_MATRIX[eventType] ?? null;
  if (!resourceType) return vide;

  const object = payload?.data?.object ?? null;
  const resourceId = typeof object?.id === 'string' ? object.id : null;
  if (!resourceId) return vide;

  /**
   * L'ENVIRONNEMENT VIENT DU RUNTIME, PAS DE `livemode`.
   *
   * Stripe expose `livemode` sur chaque objet, et il serait tentant de s'en
   * servir. Ce serait laisser le corps de la requête choisir dans quel monde
   * chercher — donc permettre à un événement de recette de désigner un lien de
   * production. Le monde est celui de l'endpoint qui a reçu l'appel, et lui
   * seul (doctrine L2).
   */
  const binding = await findBinding({ environment, resourceType, resourceId });

  const claim = claimedProjectId(object);

  if (!binding) {
    /**
     * AUCUN LIEN. C'est le cas NORMAL pendant la coexistence : la session a été
     * créée avant L6.2B, ou par un chemin que le Panel ne connaît pas.
     *
     * On ne cherche pas plus loin. Pas de balayage des projets, pas de seconde
     * requête chez Stripe, pas de « premier qui correspond » — et surtout pas
     * de lien créé à la volée depuis une donnée fournisseur. Un événement dont
     * on ne sait pas à qui il est n'appartient à personne.
     */
    logAnomaly(eventType, resourceId, environment, claim, null, 'sans lien');
    return {
      ownership: EVENT_OWNERSHIP.UNOWNED,
      projectId: null,
      resourceType,
      resourceId,
      /** Une revendication sans lien EST une divergence : elle ne prouve rien. */
      claimMismatch: Boolean(claim),
    };
  }

  if (binding.revokedAt) {
    /**
     * Lien révoqué : la ressource a cessé d'être reconnue. La router
     * remettrait en circulation ce qu'on avait décidé de neutraliser.
     */
    logAnomaly(eventType, resourceId, environment, claim, binding.projectId, 'lien révoqué');
    return {
      ownership: EVENT_OWNERSHIP.REVOKED,
      projectId: null,
      resourceType,
      resourceId,
      claimMismatch: Boolean(claim && claim !== binding.projectId),
    };
  }

  const mismatch = Boolean(claim && claim !== binding.projectId);
  if (mismatch) {
    /**
     * LE CAS QUI JUSTIFIE TOUT LE MODULE.
     *
     * Les metadata désignent un projet, le lien en désigne un autre. Le lien
     * gagne, sans discussion : il a été écrit par le Panel au moment où il a
     * créé la ressource, tandis que les metadata ont pu être réécrites depuis.
     */
    logger.warn(
      `[stripe-webhook] REVENDICATION DIVERGENTE — ${eventType} `
      + `${maskResourceId(resourceId)} (${environment}) : les metadata désignent un projet, `
      + `le lien en désigne un autre. Le lien fait autorité.`,
    );
  }

  return {
    ownership: EVENT_OWNERSHIP.OWNED,
    projectId: binding.projectId,
    resourceType,
    resourceId,
    claimMismatch: mismatch,
  };
}

/**
 * Trace d'un événement non attribuable.
 *
 * Ni le projet revendiqué ni l'identifiant complet ne sont écrits en clair :
 * un journal d'exploitation se lit par des gens qui n'ont pas à connaître les
 * identifiants Stripe du parc, et une trace qui fuit est une trace qu'on
 * finira par restreindre au lieu de la lire.
 */
function logAnomaly(eventType, resourceId, environment, claim, owner, motif) {
  logger.warn(
    `[stripe-webhook] NON ATTRIBUÉ (${motif}) — ${eventType} `
    + `${maskResourceId(resourceId)} (${environment})`
    + `${claim ? ' ; une revendication figure dans les metadata, elle est ignorée' : ''}`
    + `${owner ? ' ; un lien existe mais il est neutralisé' : ''}.`,
  );
}

export default {
  EVENT_OWNERSHIP,
  EVENT_RESOURCE_MATRIX,
  UNROUTABLE_EVENTS,
  resolveStripeEventOwnership,
};
