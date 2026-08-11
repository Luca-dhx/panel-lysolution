// L'AUTORITÉ DU MONTANT — le Panel décide de ce qui est facturé (L6.2B).
//
// docs/architecture/STRIPE_L6_2B_CHECKOUT_CUTOVER_REPORT.md §« Contrat ».
//
// ── LA QUESTION QUE CE FICHIER TRANCHE ──────────────────────────────────────
//
// Un projet demande « ouvre une session de paiement pour mon contrat X ». Deux
// choses doivent être décidées ailleurs que chez lui :
//
//   · CE CONTRAT EST-IL LE SIEN ?   la projection du Panel le dit, pas la
//                                   charge utile ;
//   · COMBIEN COÛTE-T-IL ?          la projection le dit, pas la charge utile.
//
// Laisser le projet annoncer le montant permettrait de facturer un euro un
// contrat à mille. Laisser le projet annoncer l'identifiant de contrat sans le
// confronter permettrait de facturer le contrat d'un autre. Les deux refus
// sont ici, avant toute construction de paramètres.
//
// ── POURQUOI LE MONTANT N'EST PAS UNE ENTRÉE, MÊME « POUR VÉRIFIER » ────────
//
// Un montant transmis puis comparé serait un montant transmis : le jour où la
// comparaison devient une tolérance — « à un centime près », « sauf en TEST » —
// l'autorité a changé de camp sans qu'aucune ligne ne le dise. Le schéma L6.1
// refuse donc `amount`, `unitAmount`, `price` et `currency` en entrée, et ce
// fichier ne les lit que dans la projection.
//
// ── CE QUI RESTE CORROBORATIF ───────────────────────────────────────────────
//
// `correlation.paymentRef` voyage jusqu'aux metadata Stripe parce que le
// journal de paiement du projet s'y rattache depuis l'origine (L6.2A §metadata).
// Ce n'est PAS une preuve d'appartenance : les metadata Stripe sont modifiables
// depuis le tableau de bord, et l'autorité d'appartenance est le registre de
// liens (`stripeResourceBinding.js`), jamais un champ éditable.
import { createHash } from 'node:crypto';

import { PanelProjectContract } from '../../../models/PanelProjectProjection.model.js';

/* -------------------------------------------------------------------------- */
/*  REFUS                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Les motifs, nommés. `CONTRACT_NOT_OWNED` couvre DÉLIBÉRÉMENT deux
 * situations — « ce projet n'a aucun contrat projeté » et « la référence
 * désigne autre chose que son contrat courant ». Les distinguer donnerait un
 * oracle : on présenterait des références au hasard et la nuance du refus
 * dirait laquelle existe. Même doctrine qu'en L6.2A pour les ressources.
 */
export const CHECKOUT_REFUSALS = Object.freeze({
  CONTRACT_NOT_OWNED: 'CONTRACT_NOT_OWNED',
  PRICE_ABSENT: 'CONTRACT_PRICE_ABSENT',
  SUBSCRIPTION_NOT_MIGRATED: 'SUBSCRIPTION_PREREQUISITES_NOT_MIGRATED',
});

export class CheckoutAuthorityError extends Error {
  constructor(reason, message) {
    super(message);
    this.name = 'CheckoutAuthorityError';
    this.reason = reason;
  }
}

/* -------------------------------------------------------------------------- */
/*  LA CLÉ D'IDEMPOTENCE STRIPE                                               */
/* -------------------------------------------------------------------------- */

/**
 * DÉRIVÉE, JAMAIS TIRÉE AU SORT — et c'est toute la garantie de non-doublon.
 *
 * Stripe déduplique sur `Idempotency-Key` : deux appels de la MÊME clé rendent
 * la même session, pas deux paiements. Encore faut-il que la clé soit
 * reproductible depuis les seules données de l'acte, sans lecture de base :
 * une clé stockée puis relue serait indisponible exactement quand on en a le
 * plus besoin — au rejeu qui suit un crash.
 *
 * Elle porte le MONDE : `TEST` et `PROD` sont deux comptes Stripe, et une clé
 * qui traverserait les deux ferait converger un acte de recette vers un acte
 * de production. Elle porte la CAPACITÉ : le même `operationId` métier peut
 * légitimement servir deux verbes. Elle porte le PROJET : deux projets peuvent
 * choisir le même `operationId` sans se connaître.
 *
 * Le hachage n'est pas une protection, c'est une NORMALISATION : longueur
 * fixe, alphabet sûr, et aucun identifiant métier lisible dans un en-tête HTTP
 * qui traverse des journaux qu'on ne relit pas.
 */
export function deriveIdempotencyKey({ environment, projectId, capability, operationId }) {
  const material = [environment, projectId, capability, operationId]
    .map((part) => String(part ?? ''))
    .join('|');
  if (!environment || !projectId || !capability || !operationId) {
    throw new CheckoutAuthorityError(
      'IDEMPOTENCY_MATERIAL_INCOMPLETE',
      'Clé d’idempotence indérivable : matériel incomplet.',
    );
  }
  return `pcp_${createHash('sha256').update(material).digest('hex').slice(0, 48)}`;
}

/* -------------------------------------------------------------------------- */
/*  RÉSOLUTION DE L'INTENTION                                                 */
/* -------------------------------------------------------------------------- */

/** Lecture par défaut de la projection. Injectable : les tests n'ont pas de base. */
async function defaultLookupContract(projectId) {
  return PanelProjectContract.findOne({ projectId }).lean();
}

/**
 * Le projet a-t-il le droit de faire payer CE contrat, et combien ?
 *
 * @param {object} args
 * @param {string} args.projectId     autorité — vient du jeton, pas de la charge utile
 * @param {string} args.environment   TEST | PROD — résolu par le runtime (L2)
 * @param {object} args.input         entrée DÉJÀ validée par le schéma L6.1
 * @param {Function} [args.lookupContract]
 * @returns {Promise<{params: object, contractId: string, amountIncludingTax: number,
 *   currency: string, reference: string|null}>}
 * @throws {CheckoutAuthorityError}
 */
export async function resolveCheckoutIntent({
  projectId, environment, input, lookupContract = defaultLookupContract,
}) {
  /**
   * L'ABONNEMENT EST REFUSÉ ICI, ET LE REFUS EST STRUCTUREL.
   *
   * Une session `mode: subscription` référence un Price et un Customer Stripe
   * créés AVANT elle. Ces trois créations — `createCustomer`, `createProduct`,
   * `createPrice` — sont explicitement hors du périmètre de ce lot. Les laisser
   * s'exécuter avec la clé du projet pendant que la session part avec celle du
   * Panel produirait une session qui référence des objets d'un AUTRE compte :
   * Stripe la refuserait, et l'échec surviendrait au pire moment — devant un
   * client qui paie.
   *
   * Ce refus n'est donc pas une lacune de la migration : c'est la migration qui
   * refuse d'être à moitié faite. Il tombe AVANT toute lecture de projection et
   * avant tout contact fournisseur.
   */
  if (input.paymentType === 'SUBSCRIPTION') {
    throw new CheckoutAuthorityError(
      CHECKOUT_REFUSALS.SUBSCRIPTION_NOT_MIGRATED,
      'L’abonnement exige un client et un tarif Stripe que le Panel ne possède pas encore.',
    );
  }

  const projection = await lookupContract(projectId);
  const contractId = projection?.sourceContractId ?? null;

  // Un seul refus pour « aucun contrat » et « pas celui-là » : voir le §refus.
  if (!projection || !contractId || contractId !== String(input.contractRef)) {
    throw new CheckoutAuthorityError(
      CHECKOUT_REFUSALS.CONTRACT_NOT_OWNED,
      'Aucun contrat de ce projet ne correspond à cette référence.',
    );
  }

  const fee = projection.pricing?.launchFee ?? null;
  const amountIncludingTax = Number(fee?.amountIncludingTax ?? 0);
  const currency = String(fee?.currency ?? '').trim();

  /**
   * Un montant nul ou absent n'est PAS « gratuit » : c'est une projection
   * incomplète. Ouvrir une session à zéro euro créerait un paiement réussi qui
   * n'a rien encaissé, et le contrat basculerait « payé ».
   */
  if (!Number.isInteger(amountIncludingTax) || amountIncludingTax <= 0 || !currency) {
    throw new CheckoutAuthorityError(
      CHECKOUT_REFUSALS.PRICE_ABSENT,
      'La projection de contrat ne porte pas de frais de lancement exploitable.',
    );
  }

  const reference = projection.reference ?? null;
  const metadata = buildMetadata({ projectId, environment, contractId, input });

  return {
    contractId,
    reference,
    amountIncludingTax,
    currency,
    params: {
      mode: 'payment',
      line_items: [
        {
          price_data: {
            currency: currency.toLowerCase(),
            product_data: {
              name: `Frais de lancement — ${reference || contractId}`,
              description: 'Paiement unique — frais de lancement du site',
            },
            unit_amount: amountIncludingTax,
          },
          quantity: 1,
        },
      ],
      success_url: input.successUrl,
      cancel_url: input.cancelUrl,
      metadata,
      payment_intent_data: { metadata },
      /**
       * `mode: payment` n'émet aucune facture par défaut. Le parcours du projet
       * en attend une (facture hébergée + PDF), et les metadata y sont recopiées
       * pour que l'événement `invoice.*` retrouve le contrat. Retirer ce bloc
       * casserait silencieusement l'historique de facturation.
       */
      invoice_creation: { enabled: true, invoice_data: { metadata } },
    },
  };
}

/**
 * Les metadata Stripe — un pont vers l'historique, pas une autorité.
 *
 * `contractId` vient de la PROJECTION (valeur confrontée), jamais de la charge
 * utile : c'est ce qui empêche un projet d'étiqueter une session au contrat
 * d'un autre. Les clés conservent EXACTEMENT les noms d'origine, parce que le
 * consommateur de webhook du projet les lit sous ces noms depuis toujours et
 * que ce lot ne touche pas aux webhooks.
 */
function buildMetadata({ projectId, environment, contractId, input }) {
  const paymentRef = input.correlation?.paymentRef ?? null;
  return {
    contractId,
    paymentType: input.paymentType,
    /**
     * Champs HISTORIQUES conservés. Ils décrivaient le monde du RUNTIME PROJET ;
     * ils décrivent désormais celui du Panel, qui est le même par construction
     * (L2 : l'environnement de l'instance décide du monde fournisseur). Ils
     * restent informatifs — la vérification, elle, est cryptographique.
     */
    providerMode: environment,
    applicationEnvironment: environment,
    ...(paymentRef ? { paymentId: paymentRef } : {}),
    /** Traçabilité du plan de contrôle. Corroboratif, jamais probant. */
    panelProjectId: projectId,
    panelOperationId: input.operationId,
  };
}

export default {
  CHECKOUT_REFUSALS,
  CheckoutAuthorityError,
  deriveIdempotencyKey,
  resolveCheckoutIntent,
};
