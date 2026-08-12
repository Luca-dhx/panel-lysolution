// LA PREMIÈRE ADOPTION LÉGITIME DU PLAN DE CONTRÔLE (L6.2F).
//
// docs/architecture/STRIPE_L6_2F_SUBSCRIPTION_OWNERSHIP_REPORT.md.
//
// ══ POURQUOI UNE ADOPTION, ALORS QU'ON S'EST TOUJOURS REFUSÉ À EN FAIRE ═════
//
// Depuis L6.2A, une ressource n'appartient à un projet que parce que le PANEL
// l'a créée : la preuve est par construction, et toute autre voie a été
// refusée — un identifiant présenté n'est pas une preuve de propriété.
//
// L'abonnement casse cette symétrie, et pas par négligence : le Panel crée le
// client, le produit, le tarif et la session, mais **Stripe** crée la
// Subscription, tout seul, au moment où le client paie. Il n'existe aucun
// `subscriptions.create()` que le Panel pourrait contrôler.
//
// ══ CE QUI REND CETTE ADOPTION LÉGITIME ═════════════════════════════════════
//
// La filiation, et elle seule :
//
//     Session de paiement DONT L'APPARTENANCE EST DÉJÀ PROUVÉE
//              ↓  (Stripe, sur l'objet lui-même)
//     `session.subscription`
//              ↓
//     Subscription adoptée pour CE projet
//
// La preuve n'est pas « on nous a dit que » : c'est que le fournisseur lui-même,
// sur un objet que nous possédons déjà, désigne cette ressource comme issue de
// cet objet. Un tiers ne peut pas fabriquer cette désignation sans compromettre
// le compte Stripe — auquel cas l'appartenance n'est plus notre problème le plus
// urgent.
//
// ══ CE QUI N'EST JAMAIS UNE PREUVE ══════════════════════════════════════════
//
// `metadata.contractId`, `metadata.panelProjectId`, un `subscriptionId` envoyé
// par le projet, un client qui « ressemble » au bon. Tout cela CORROBORE — on
// l'enregistre, on signale une divergence — mais rien de tout cela ne décide.
//
// Conséquence directe : ce module n'accepte PAS d'identifiant d'abonnement en
// paramètre. Il reçoit l'objet Session tel que Stripe l'a rendu, et en extrait
// lui-même la filiation. La question « et si l'appelant mentait ? » ne se pose
// donc jamais.
import logger from '../../../utils/logger.js';
import {
  STRIPE_RESOURCE_TYPES,
  BINDING_SOURCES,
  bindResource,
  findBinding,
  maskResourceId,
} from './stripeResourceBinding.js';

const SESSION = STRIPE_RESOURCE_TYPES.CHECKOUT_SESSION;
const SUBSCRIPTION = STRIPE_RESOURCE_TYPES.SUBSCRIPTION;
const CUSTOMER = STRIPE_RESOURCE_TYPES.CUSTOMER;

/** Issue d'une tentative d'adoption. Fermé. */
export const ADOPTION = Object.freeze({
  /** La filiation est prouvée et le lien vient d'être écrit. */
  ADOPTED: 'ADOPTED',
  /** Déjà adoptée, par le même acte. Un rejeu ne produit rien. */
  ALREADY_ADOPTED: 'ALREADY_ADOPTED',
  /**
   * Rien à adopter, ou pas encore : session non possédée, session révoquée,
   * session qui n'est pas un abonnement, ou abonnement pas encore né. Ce n'est
   * PAS une erreur — c'est le cas normal avant paiement.
   */
  NOT_ELIGIBLE: 'NOT_ELIGIBLE',
  /**
   * L'abonnement est déjà lié à un AUTRE projet. Cas qui ne devrait jamais
   * survenir — il signalerait que deux sessions de projets différents désignent
   * la même Subscription. On refuse, et on le crie.
   */
  CONFLICT: 'CONFLICT',
});

/**
 * L'identité de l'acte d'adoption : la SESSION qui l'a produite.
 *
 * Ce n'est pas un `operationId` du registre d'opérations — aucune opération n'a
 * été réclamée, puisque le Panel n'a rien créé. C'est une PROVENANCE : elle dit
 * d'où vient la ressource, et elle rend l'adoption rejouable à l'identique.
 *
 * Deux adoptions successives de la même session portent la même provenance,
 * donc retombent sur la même ligne : c'est ce qui rend le rejeu inoffensif.
 */
export function subscriptionProvenance({ environment, checkoutSessionId }) {
  return `stripe-subscription-from-session:${environment}:${checkoutSessionId}`;
}

const idOf = (value) => (typeof value === 'string' ? value : value?.id ?? null);

/**
 * Adopte la Subscription issue d'une session de paiement possédée.
 *
 * NE LÈVE PAS sur un cas normal : appelée depuis une réception de webhook (qui
 * ne doit jamais répondre 500) et depuis une lecture (qui ne doit pas échouer
 * parce qu'une adoption n'a pas pu se faire).
 *
 * @param {object} args
 * @param {string} args.environment  celui du RUNTIME, jamais celui du corps
 * @param {object} args.session      l'objet Session TEL QUE STRIPE LE REND
 * @param {string} args.source       `BINDING_SOURCES.*` — comment on l'a appris
 * @returns {Promise<{outcome: string, projectId: string|null,
 *   subscriptionId: string|null, claimMismatch: boolean}>}
 */
export async function adoptSubscriptionFromSession({ environment, session, source }) {
  const rien = { outcome: ADOPTION.NOT_ELIGIBLE, projectId: null, subscriptionId: null, claimMismatch: false };

  const checkoutSessionId = idOf(session?.id ? session : null) ?? (typeof session?.id === 'string' ? session.id : null);
  if (!checkoutSessionId) return rien;

  /**
   * ── LA PREUVE, ET ELLE VIENT EN PREMIER ───────────────────────────────────
   *
   * Sans lien sur la session, il n'y a pas de filiation : la session n'est pas
   * à nous, donc ce qu'elle a produit ne l'est pas non plus. On ne cherche pas
   * plus loin, et surtout on ne regarde pas les metadata pour « compenser ».
   */
  const lienSession = await findBinding({
    environment, resourceType: SESSION, resourceId: checkoutSessionId,
  });
  if (!lienSession || lienSession.revokedAt) return rien;

  /**
   * Une session de frais n'ouvre aucun abonnement. Le vérifier évite d'adopter
   * un objet qui n'aurait rien à voir si Stripe changeait la forme de sa charge
   * utile.
   */
  if (session.mode && session.mode !== 'subscription') return rien;

  const subscriptionId = idOf(session.subscription);
  /**
   * Pas encore d'abonnement : la session n'est pas payée. C'est le cas NORMAL
   * entre l'ouverture et le paiement, pas une anomalie — et c'est précisément
   * pourquoi l'adoption doit pouvoir se rejouer plus tard sans rien recréer.
   */
  if (!subscriptionId) return rien;

  const projectId = lienSession.projectId;

  /* ── CORROBORATIONS — enregistrées, jamais décisives ────────────────────── */
  const revendique = typeof session.metadata?.panelProjectId === 'string'
    ? session.metadata.panelProjectId.trim()
    : null;
  const claimMismatch = Boolean(revendique && revendique !== projectId);
  if (claimMismatch) {
    logger.warn(
      `[stripe-adoption] REVENDICATION DIVERGENTE — la session ${maskResourceId(checkoutSessionId)} `
      + `(${environment}) porte des metadata désignant un autre projet que son lien. `
      + 'Le lien fait autorité.',
    );
  }

  /**
   * Le client de la session est-il celui que nous possédons pour ce projet ?
   *
   * CORROBORATION, pas condition. Une session possédée dont le client ne serait
   * pas lié resterait adoptable — le lien de la session suffit. Mais la
   * divergence mérite d'être vue : elle signalerait que quelque chose s'est
   * passé hors du plan de contrôle.
   */
  const customerId = idOf(session.customer);
  let clientCoherent = null;
  if (customerId) {
    const lienClient = await findBinding({ environment, resourceType: CUSTOMER, resourceId: customerId });
    clientCoherent = Boolean(lienClient && !lienClient.revokedAt && lienClient.projectId === projectId);
    if (!clientCoherent) {
      logger.warn(
        `[stripe-adoption] client non corroboré pour la session ${maskResourceId(checkoutSessionId)} `
        + `(${environment}) : l'adoption se fait tout de même sur la foi du lien de session.`,
      );
    }
  }

  const provenance = subscriptionProvenance({ environment, checkoutSessionId });

  try {
    const { outcome } = await bindResource({
      projectId,
      environment,
      resourceType: SUBSCRIPTION,
      resourceId: subscriptionId,
      source: source ?? BINDING_SOURCES.LEARNED_FROM_WEBHOOK,
      createdByOperationId: provenance,
      proof: {
        stripeMetadataContractId: typeof session.metadata?.contractId === 'string'
          ? session.metadata.contractId : null,
        derivedFromResourceType: SESSION,
        derivedFromResourceId: checkoutSessionId,
        customerCorroborated: clientCoherent,
      },
    });

    if (outcome === 'ALREADY_BOUND') {
      return { outcome: ADOPTION.ALREADY_ADOPTED, projectId, subscriptionId, claimMismatch };
    }
    logger.info(
      `[stripe-adoption] abonnement ${maskResourceId(subscriptionId)} adopté pour ${projectId} `
      + `(${environment}) depuis la session ${maskResourceId(checkoutSessionId)}.`,
    );
    return { outcome: ADOPTION.ADOPTED, projectId, subscriptionId, claimMismatch };
  } catch (error) {
    /**
     * Le seul conflit possible est un abonnement déjà lié à un AUTRE projet.
     * Il ne devrait jamais survenir — il faudrait que deux sessions de projets
     * différents désignent la même Subscription. On refuse, on le journalise
     * fort, et on ne réattribue rien : l'index unique de L6.2A a déjà tranché.
     */
    if (error?.code === 'STRIPE_RESOURCE_ALREADY_BOUND') {
      logger.error(
        `[stripe-adoption] CONFLIT — l'abonnement ${maskResourceId(subscriptionId)} (${environment}) `
        + `est déjà lié à un autre projet que ${projectId}. Aucune réattribution.`,
      );
      return { outcome: ADOPTION.CONFLICT, projectId: null, subscriptionId, claimMismatch };
    }
    logger.error(`[stripe-adoption] adoption impossible — ${error?.code ?? 'UNEXPECTED'}.`);
    return { ...rien, subscriptionId, claimMismatch };
  }
}

export default { ADOPTION, adoptSubscriptionFromSession, subscriptionProvenance };
