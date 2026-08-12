// À QUEL CONTRAT APPARTIENT UN CLIENT STRIPE ? (L6.2D)
//
// docs/architecture/STRIPE_L6_2D_CUSTOMER_OWNERSHIP_REPORT.md.
//
// ══ LA DÉCOUVERTE QUI DÉTERMINE TOUT LE LOT ═════════════════════════════════
//
// Le client Stripe n'est PAS global au projet. L'audit du parc le prouve
// mécaniquement, par trois faits indépendants :
//
//   · la clé d'idempotence historique est `customer-<contractId>-<mode>` —
//     elle porte le contrat, pas le projet ;
//   · `Contract.stripe.customerId` est un champ du CONTRAT, sans index unique ;
//   · la facturation fait la lecture inverse `Contract.findOne({'stripe.
//     customerId': …})` — elle suppose donc au plus UN contrat par client.
//
// Un projet ayant eu trois contrats a donc trois clients Stripe, et c'est
// correct : chaque contrat porte son propre engagement, ses propres factures,
// et souvent son propre signataire.
//
//       Projet A                        et NON pas :      Projet A
//        ├── Contrat 1 → cus_111                           └── cus_unique
//        ├── Contrat 2 → cus_222
//        └── Contrat 3 → cus_333
//
// Écrire `projectId → customerId` fusionnerait les historiques de facturation
// de contrats distincts — au mieux des factures mélangées, au pire un
// prélèvement rattaché au mauvais engagement.
//
// ══ POURQUOI L'IDENTITÉ DE L'ACTE EST DÉRIVÉE, ET NON FOURNIE ═══════════════
//
// Toutes les autres capacités financières reçoivent leur `operationId` du
// projet : lui seul sait que deux clics sont la même intention. `ensure` est
// différente par nature — elle signifie « converge vers l'unique client de ce
// contrat ». Il n'y a rien à décider : la réponse correcte est déterminée par
// le contrat, et une seule.
//
// Laisser le projet nommer l'acte permettrait d'appeler deux fois avec deux
// identités pour le même contrat, et d'obtenir deux clients — exactement ce
// que le verbe promet d'empêcher. L'identité est donc DÉRIVÉE du contrat
// VÉRIFIÉ, côté Panel, et le projet ne peut pas l'influencer.
import { PanelProjectContract } from '../../../models/PanelProjectProjection.model.js';

/* -------------------------------------------------------------------------- */
/*  REFUS                                                                     */
/* -------------------------------------------------------------------------- */

export const CUSTOMER_REFUSALS = Object.freeze({
  /**
   * Couvre DÉLIBÉRÉMENT « ce projet n'a aucun contrat projeté » et « cette
   * référence n'est pas la sienne ». Les distinguer donnerait un oracle : on
   * présenterait des références au hasard et la nuance du refus dirait
   * lesquelles existent. Même doctrine qu'en L6.2A et L6.2C.
   */
  CONTRACT_NOT_OWNED: 'CONTRACT_NOT_OWNED',
});

export class CustomerAuthorityError extends Error {
  constructor(reason, message) {
    super(message);
    this.name = 'CustomerAuthorityError';
    this.reason = reason;
  }
}

/* -------------------------------------------------------------------------- */
/*  LA CLÉ MÉTIER                                                             */
/* -------------------------------------------------------------------------- */

/**
 * L'IDENTITÉ DE L'ACTE — `(environnement, contrat)`, et rien d'autre.
 *
 * Le projet n'y figure pas : il est déjà porté par la clé du registre
 * d'opérations `(projectId, capability, operationId)`, et par le filtre du
 * registre de liens. L'y ajouter une seconde fois ne protégerait de rien et
 * laisserait croire qu'un même contrat pourrait appartenir à deux projets.
 *
 * Le MONDE, lui, en fait partie : `TEST` et `PROD` sont deux comptes Stripe,
 * donc deux clients distincts pour un même contrat métier. Les confondre ferait
 * converger la recette vers le client de production.
 *
 * Forme lisible et non hachée : cette valeur ne part pas chez le fournisseur —
 * c'est la clé d'idempotence Stripe, dérivée d'elle, qui voyage. Ici, la
 * lisibilité vaut plus que l'opacité : c'est ce qu'un opérateur lira dans le
 * registre d'opérations le jour où il cherchera pourquoi un client manque.
 */
export function customerOperationId({ environment, contractId }) {
  return `stripe-customer:${environment}:${contractId}`;
}

/* -------------------------------------------------------------------------- */
/*  RÉSOLUTION                                                                */
/* -------------------------------------------------------------------------- */

/** Lecture par défaut de la projection. Injectable : les tests n'ont pas de base. */
async function defaultLookupContract(projectId) {
  return PanelProjectContract.findOne({ projectId }).lean();
}

/**
 * Ce contrat est-il le sien, et que faut-il envoyer à Stripe pour lui ?
 *
 * @param {object} args
 * @param {string} args.projectId    autorité — vient du jeton, pas de la charge utile
 * @param {string} args.environment  TEST | PROD — résolu par le runtime (L2)
 * @param {object} args.input        entrée DÉJÀ validée par le schéma
 * @param {Function} [args.lookupContract]
 * @returns {Promise<{contractId: string, operationId: string, params: object}>}
 * @throws {CustomerAuthorityError}
 */
export async function resolveCustomerIntent({
  projectId, environment, input, lookupContract = defaultLookupContract,
}) {
  const projection = await lookupContract(projectId);
  const contractId = projection?.sourceContractId ?? null;

  if (!projection || !contractId || contractId !== String(input.contractRef)) {
    throw new CustomerAuthorityError(
      CUSTOMER_REFUSALS.CONTRACT_NOT_OWNED,
      'Aucun contrat de ce projet ne correspond à cette référence.',
    );
  }

  return {
    contractId,
    operationId: customerOperationId({ environment, contractId }),
    params: buildParams({ projectId, environment, contractId, projection, input }),
  };
}

/**
 * Ce qui part chez Stripe — le strict nécessaire à identifier une personne.
 *
 * ── CE QUI N'Y EST PAS, ET POURQUOI ─────────────────────────────────────────
 *
 * Ni adresse, ni téléphone, ni moyen de paiement, ni langue, ni fuseau. Le code
 * historique n'en envoyait aucun, et en ajouter « pendant qu'on y est » ferait
 * traverser au pont des données personnelles que personne n'a demandées et
 * qu'il faudrait ensuite justifier, protéger et purger.
 *
 * ── LES METADATA SONT CONSERVÉES À L'IDENTIQUE ──────────────────────────────
 *
 * `contractId`, `providerMode` et `applicationEnvironment` portaient déjà ces
 * noms. Le support et la réconciliation les lisent ainsi depuis l'origine ;
 * les renommer casserait des rapprochements qu'aucun test ne couvre.
 *
 * `contractId` vient de la PROJECTION VÉRIFIÉE, jamais de la charge utile :
 * c'est ce qui empêche d'étiqueter un client au contrat d'un autre. Et cela
 * reste CORROBORATIF — les metadata Stripe s'éditent depuis le tableau de bord,
 * l'autorité d'appartenance est le registre de liens.
 */
function buildParams({ projectId, environment, contractId, projection, input }) {
  const name = String(input.customer?.name ?? '').trim() || projection.reference || contractId;
  const email = String(input.customer?.email ?? '').trim();
  return {
    ...(email ? { email } : {}),
    name,
    metadata: {
      contractId,
      providerMode: environment,
      applicationEnvironment: environment,
      /** Traçabilité du plan de contrôle. Corroboratif, jamais probant. */
      panelProjectId: projectId,
    },
  };
}

export default {
  CUSTOMER_REFUSALS,
  CustomerAuthorityError,
  customerOperationId,
  resolveCustomerIntent,
};
