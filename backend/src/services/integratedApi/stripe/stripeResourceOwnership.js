// APPARTENANCE DES RESSOURCES STRIPE — le verrou qui manque encore (L6.1).
//
// docs/architecture/STRIPE_L6_1_CONTROL_PLANE_FOUNDATION_REPORT.md §« Ownership ».
//
// ── LE CONSTAT QUI DÉCIDE DU LOT ────────────────────────────────────────────
//
// Pour Hostinger (L9), l'appartenance venait d'une relation que le Panel tenait
// DÉJÀ : `PanelProjectDestination` dit quel projet possède quel nom d'hôte.
//
// Pour Stripe, cette relation N'EXISTE PAS. Le Panel ne sait pas quel
// `cus_…`, quel `sub_…` ni quel `cs_…` appartient à quel projet : la projection
// de contrat ne transporte aucun identifiant Stripe (vérifié dans
// `bridgeContract.contractPayloadSchema`), et le coffre ne contient qu'une clé.
//
// Conséquence directe, et c'est le résultat principal de L6.1 :
//
//   AUCUNE capacité Stripe acceptant un identifiant de ressource ne peut être
//   servie tant que ce lien n'est pas établi côté Panel.
//
// Sans lui, un projet appairé pourrait lire les factures — ou résilier
// l'abonnement — d'un autre client du même compte Stripe. Ce serait pire que la
// situation actuelle, où chaque projet détient une clé qui n'ouvre que son
// propre compte.
//
// ── CE QUE CE MODULE EST, ET CE QU'IL N'EST PAS ─────────────────────────────
//
// Il définit le CONTRAT du lien et la façon de l'interroger. Il ne le peuple
// pas : la population est une décision de lot (§« Deux routes » ci-dessous),
// et la choisir ici reviendrait à trancher L6.2 depuis une fondation.
import ApiError from '../../../utils/ApiError.js';

/** Familles de ressources Stripe que le parc manipule réellement. */
export const STRIPE_RESOURCE_KINDS = Object.freeze({
  CUSTOMER: 'CUSTOMER',
  CHECKOUT_SESSION: 'CHECKOUT_SESSION',
  SUBSCRIPTION: 'SUBSCRIPTION',
  PAYMENT_INTENT: 'PAYMENT_INTENT',
  INVOICE: 'INVOICE',
});

export const STRIPE_RESOURCE_KIND_VALUES = Object.freeze(Object.values(STRIPE_RESOURCE_KINDS));

/**
 * Préfixes d'identifiants Stripe, par famille.
 *
 * Ils servent à REFUSER tôt, pas à autoriser : qu'un identifiant commence par
 * `sub_` ne prouve rien sur son propriétaire. Mais qu'un appelant présente un
 * `cus_…` là où une capacité attend un abonnement révèle une confusion qu'il
 * vaut mieux arrêter avant d'interroger Stripe.
 */
export const RESOURCE_ID_PREFIXES = Object.freeze({
  [STRIPE_RESOURCE_KINDS.CUSTOMER]: 'cus_',
  [STRIPE_RESOURCE_KINDS.CHECKOUT_SESSION]: 'cs_',
  [STRIPE_RESOURCE_KINDS.SUBSCRIPTION]: 'sub_',
  [STRIPE_RESOURCE_KINDS.PAYMENT_INTENT]: 'pi_',
  [STRIPE_RESOURCE_KINDS.INVOICE]: 'in_',
});

/** Pourquoi une ressource est refusée. Codes fermés. */
export const OWNERSHIP_CODES = Object.freeze({
  OK: 'OK',
  /** Le lien projet ↔ ressource n'existe pas encore dans le Panel. */
  NO_BINDING: 'NO_BINDING',
  /** La ressource est liée, mais à un autre projet. */
  NOT_OWNED: 'NOT_OWNED',
  /** L'identifiant ne ressemble pas à la famille attendue. */
  MALFORMED_ID: 'MALFORMED_ID',
  /** Le lien existe, mais dans l'autre monde fournisseur. */
  ENVIRONMENT_MISMATCH: 'ENVIRONMENT_MISMATCH',
});

/**
 * DEUX ROUTES POSSIBLES POUR PEUPLER LE LIEN — et une seule est sûre.
 *
 * Documentées ici parce que le choix appartient à L6.2, et qu'il doit être fait
 * les yeux ouverts.
 */
export const BINDING_ROUTES = Object.freeze({
  /**
   * LE PANEL CRÉE, DONC LE PANEL SAIT.
   *
   * Quand une écriture (`checkout.create`, `customer.ensure`) passe par la
   * passerelle, le Panel enregistre le lien au moment où Stripe rend l'objet.
   * C'est la route SÛRE : le lien naît d'un acte que le Panel a lui-même
   * exécuté, et aucun projet n'a jamais eu l'occasion de le déclarer.
   *
   * Son défaut est un amorçage : les ressources créées AVANT la migration
   * n'ont pas de lien. Elles restent sur le chemin local du projet — ce qui est
   * exactement ce qu'un cutover progressif suppose.
   */
  CREATED_BY_PANEL: 'CREATED_BY_PANEL',

  /**
   * L'ÉVÉNEMENT WEBHOOK APPREND LE LIEN.
   *
   * Les objets Stripe du parc portent `metadata.contractId`, et le Panel reçoit
   * déjà les projections de contrat (`sourceContractId` par projet). Un
   * événement permettrait donc de rattacher `sub_… → contrat → projet`.
   *
   * Route PLAUSIBLE mais à manier avec précaution : la métadonnée n'est fiable
   * que sur les objets que NOUS avons créés. Un objet créé à la main dans le
   * tableau de bord Stripe, ou par un futur outil tiers, pourrait porter un
   * `contractId` arbitraire. À n'activer qu'avec une vérification croisée.
   */
  LEARNED_FROM_WEBHOOK: 'LEARNED_FROM_WEBHOOK',

  /**
   * LE PROJET DÉCLARE — REFUSÉE.
   *
   * Le projet connaît ses identifiants Stripe : il serait tentant de les lui
   * faire déclarer au pont. Ce serait faire de la demande sa propre preuve,
   * exactement ce que la doctrine d'environnement interdit depuis L2. Nommée
   * ici pour qu'on ne la redécouvre pas comme une bonne idée.
   */
  DECLARED_BY_PROJECT: 'REFUSED_DECLARED_BY_PROJECT',
});

/**
 * L'identifiant a-t-il la forme de sa famille ?
 *
 * Stripe préfixe ses identifiants de façon stable et documentée. On accepte
 * aussi les identifiants de test (`cus_test_…`) : le préfixe court est un
 * préfixe du préfixe long.
 */
export function looksLikeResource(kind, resourceId) {
  const prefix = RESOURCE_ID_PREFIXES[kind];
  if (!prefix) return false;
  const id = String(resourceId ?? '').trim();
  return id.startsWith(prefix) && id.length > prefix.length;
}

/**
 * Le CONTRAT d'un résolveur d'appartenance.
 *
 * L6.2 fournira une implémentation adossée à un modèle de liaison ; ce module
 * définit ce qu'elle doit rendre, et `assertResourceOwnership` s'en sert. La
 * signature est injectable pour que la fondation soit testable sans décider du
 * stockage.
 *
 * @typedef {(args: {projectId: string, environment: string, kind: string,
 *   resourceId: string}) => Promise<{projectId: string, environment: string}|null>} BindingLookup
 */

/**
 * Ce projet peut-il agir sur cette ressource ?
 *
 * Ne LÈVE pas : rend un verdict structuré, comme pour Hostinger, afin qu'un
 * écran de diagnostic puisse expliquer un refus sans rejouer la logique.
 *
 * @param {object} args
 * @param {string} args.projectId     projet AUTHENTIFIÉ (jamais la charge utile)
 * @param {string} args.environment   monde résolu par le plan de contrôle
 * @param {string} args.kind          STRIPE_RESOURCE_KINDS
 * @param {string} args.resourceId
 * @param {BindingLookup} args.lookup
 */
export async function describeResourceOwnership({ projectId, environment, kind, resourceId, lookup }) {
  const id = String(resourceId ?? '').trim();
  const base = { kind, resourceId: id, allowed: false, boundProjectId: null };

  if (!looksLikeResource(kind, id)) {
    return { ...base, code: OWNERSHIP_CODES.MALFORMED_ID };
  }
  if (typeof lookup !== 'function') {
    /**
     * Aucun résolveur = aucun lien connu. On REFUSE, et c'est le comportement
     * voulu tant que L6.2 n'a pas choisi sa route : une fondation qui
     * autoriserait « faute de mieux » serait une porte ouverte déguisée en
     * valeur par défaut.
     */
    return { ...base, code: OWNERSHIP_CODES.NO_BINDING };
  }

  const binding = await lookup({ projectId, environment, kind, resourceId: id });
  if (!binding) return { ...base, code: OWNERSHIP_CODES.NO_BINDING };

  if (binding.projectId !== projectId) {
    // On ne dit PAS à qui elle appartient : le demandeur apprendrait le parc.
    return { ...base, code: OWNERSHIP_CODES.NOT_OWNED };
  }
  /**
   * Le lien porte son monde. Une ressource TEST invoquée depuis un Panel PROD
   * n'est pas « à quelqu'un d'autre » — elle n'existe pas dans ce monde-là, et
   * la confondre reviendrait à agir sur un objet de recette en production.
   */
  if (binding.environment && binding.environment !== environment) {
    return { ...base, code: OWNERSHIP_CODES.ENVIRONMENT_MISMATCH, boundProjectId: binding.projectId };
  }
  return { ...base, allowed: true, code: OWNERSHIP_CODES.OK, boundProjectId: binding.projectId };
}

/**
 * Variante levante, pour un adaptateur.
 *
 * Le message ne nomme jamais le propriétaire réel ni les ressources du
 * demandeur : un refus ne doit rien apprendre.
 */
export async function assertResourceOwnership(args) {
  const verdict = await describeResourceOwnership(args);
  if (verdict.allowed) return verdict;
  const message = verdict.code === OWNERSHIP_CODES.NO_BINDING
    ? 'Refusé : le Panel ne connaît aucun lien entre ce projet et cette ressource Stripe.'
    : verdict.code === OWNERSHIP_CODES.MALFORMED_ID
      ? 'Refusé : identifiant de ressource inexploitable.'
      : verdict.code === OWNERSHIP_CODES.ENVIRONMENT_MISMATCH
        ? 'Refusé : cette ressource appartient à l’autre monde fournisseur.'
        : 'Refusé : cette ressource ne relève pas de ce projet.';
  // `ApiError.forbidden` ne transporte pas de détails ; on construit donc
  // l'erreur directement, pour que le motif du refus reste lisible côté
  // diagnostic sans avoir à le déduire du texte.
  throw new ApiError(403, 'STRIPE_RESOURCE_NOT_OWNED', message, { reason: verdict.code, kind: verdict.kind });
}

/**
 * Ce qui manque, en une fonction — pour que l'écran de diagnostic et le rapport
 * disent la même chose, et que personne n'ait à relire ce fichier pour savoir
 * où en est la migration.
 */
export function describeBindingReadiness({ lookup = null } = {}) {
  const available = typeof lookup === 'function';
  return {
    available,
    /** Route retenue quand le lien existera. Aucune n'est encore branchée. */
    plannedRoute: BINDING_ROUTES.CREATED_BY_PANEL,
    refusedRoute: BINDING_ROUTES.DECLARED_BY_PROJECT,
    blocks: available ? [] : STRIPE_RESOURCE_KIND_VALUES.map((kind) => ({
      kind,
      reason: OWNERSHIP_CODES.NO_BINDING,
    })),
  };
}

export default {
  STRIPE_RESOURCE_KINDS,
  STRIPE_RESOURCE_KIND_VALUES,
  RESOURCE_ID_PREFIXES,
  OWNERSHIP_CODES,
  BINDING_ROUTES,
  looksLikeResource,
  describeResourceOwnership,
  assertResourceOwnership,
  describeBindingReadiness,
};
