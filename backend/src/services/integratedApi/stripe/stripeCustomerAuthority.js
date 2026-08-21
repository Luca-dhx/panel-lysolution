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
//
// ══ CE QUE CE FICHIER A CHANGÉ AVEC LE CHANTIER « ENTREPRISE CLIENTE » ══════
//
// ── CE QUI SE PASSAIT ────────────────────────────────────────────────────────
//
//     name = input.customer?.name || projection.reference || contractId
//
// Le projet n'avait aucune raison de fournir un nom — il ne connaissait pas
// l'identité juridique de son propriétaire —, et le repli l'emportait donc
// systématiquement. `projection.reference`, c'est la RÉFÉRENCE DE CONTRAT.
// D'où, sur la facture QWSK7ZZY-0004 :
//
//     Facturer à : CTR-2026-0002
//
// Un numéro de contrat en guise de raison sociale, aucune adresse, aucun
// SIREN. Une pièce qu'aucun comptable ne peut inscrire dans un livre.
//
// ── CE QUI SE PASSE MAINTENANT ──────────────────────────────────────────────
//
// L'identité vient de `PanelClientCompany`, l'entreprise cliente RATTACHÉE au
// projet, et de nulle part ailleurs. Le projet ne propose plus rien : le champ
// `customer` de l'entrée n'est plus lu. La référence de contrat, elle, reste —
// mais à sa place : en `metadata`, comme référence commerciale, jamais comme
// identité du destinataire.
//
// ── ET SI AUCUNE ENTREPRISE N'EST RATTACHÉE ? ───────────────────────────────
//
// On REFUSE. Le repli d'avant produisait une facture juridiquement inutilisable
// tout en encaissant l'argent : le pire des deux mondes, puisque personne ne
// s'en apercevait avant le contrôle. Un refus, lui, se voit immédiatement et se
// corrige en renseignant la fiche.
import { PanelProjectContract } from '../../../models/PanelProjectProjection.model.js';
import {
  effectiveBillingAddress,
  resolveClientCompanyReadiness,
} from '../../clientCompany/clientCompanyReadiness.js';

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
  /**
   * AUCUNE IDENTITÉ LÉGALE EXPLOITABLE — et ce refus-là est NOMMÉ.
   *
   * ══ POURQUOI IL N'EST PAS INDISTINCT, CONTRAIREMENT AUX AUTRES ═══════════
   *
   * La doctrine d'indistinction protège contre un ORACLE : un projet ne doit
   * pas pouvoir apprendre le parc en comparant des refus. Ici, il n'y a rien à
   * apprendre — le projet interroge SA propre situation, et la réponse ne parle
   * que de lui.
   *
   * Et surtout : c'est la seule réponse ACTIONNABLE du lot. « Refusé » sans
   * motif enverrait un exploitant chercher une panne Stripe ; « votre
   * entreprise cliente n'est pas complète » l'envoie remplir trois champs.
   */
  CLIENT_COMPANY_NOT_READY: 'CLIENT_COMPANY_NOT_READY',
});

export class CustomerAuthorityError extends Error {
  constructor(reason, message, details = null) {
    super(message);
    this.name = 'CustomerAuthorityError';
    this.reason = reason;
    this.details = details;
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
 * L'ENTREPRISE CLIENTE N'Y FIGURE PAS NON PLUS, et c'est important : un projet
 * qui change de client ne doit PAS obtenir un second client Stripe pour le même
 * contrat. Le contrat en cours garde son client et son historique de
 * facturation ; c'est le PROCHAIN contrat qui portera la nouvelle identité.
 * Faire entrer l'entreprise dans la clé aurait scindé l'historique d'un même
 * engagement en deux, sur un simple geste de rattachement.
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
 * @param {Function} [args.lookupClientCompany]
 * @returns {Promise<{contractId, operationId, params, clientCompany, taxIdentity}>}
 * @throws {CustomerAuthorityError}
 */
export async function resolveCustomerIntent({
  projectId, environment, input,
  lookupContract = defaultLookupContract,
  lookupClientCompany = resolveClientCompanyReadiness,
}) {
  const projection = await lookupContract(projectId);
  const contractId = projection?.sourceContractId ?? null;

  if (!projection || !contractId || contractId !== String(input.contractRef)) {
    throw new CustomerAuthorityError(
      CUSTOMER_REFUSALS.CONTRACT_NOT_OWNED,
      'Aucun contrat de ce projet ne correspond à cette référence.',
    );
  }

  /**
   * ── LA GARDE D'IDENTITÉ LÉGALE — AVANT TOUT CONTACT FOURNISSEUR ──────────
   *
   * Elle est ici, et non dans l'adaptateur, pour la même raison que
   * l'appartenance du contrat : un refus ne doit laisser AUCUNE trace chez
   * Stripe. Créer un client puis constater qu'on ne sait pas le nommer
   * laisserait un `cus_…` anonyme dans le compte, lié à un contrat, et il
   * faudrait ensuite décider quoi en faire.
   */
  const readiness = await lookupClientCompany({ projectId });
  if (!readiness.billing.ready) {
    throw new CustomerAuthorityError(
      CUSTOMER_REFUSALS.CLIENT_COMPANY_NOT_READY,
      readiness.state === 'MISSING_COMPANY'
        ? 'Aucune entreprise cliente n’est rattachée à ce projet : la facturation est impossible '
          + 'tant que l’identité légale du client n’est pas renseignée.'
        : 'L’entreprise cliente rattachée à ce projet est incomplète : '
          + `${readiness.billing.missing.join(', ')}.`,
      { state: readiness.state, missing: readiness.billing.missing },
    );
  }

  const company = readiness.company;
  return {
    contractId,
    operationId: customerOperationId({ environment, contractId }),
    clientCompany: company,
    params: buildParams({ projectId, environment, contractId, projection, company }),
    taxIdentity: buildTaxIdentity(company),
  };
}

/**
 * L'ADRESSE, AU FORMAT QUE STRIPE IMPRIME SUR LA FACTURE.
 *
 * `line2`, `state` et les champs vides sont OMIS plutôt qu'envoyés à `null` :
 * Stripe imprime une ligne vide pour un champ présent et nul, et une facture
 * avec un trou au milieu de l'adresse se lit comme une erreur d'édition.
 */
function buildAddress(adresse) {
  if (!adresse) return null;
  const sortie = {
    ...(adresse.line1 ? { line1: String(adresse.line1) } : {}),
    ...(adresse.line2 ? { line2: String(adresse.line2) } : {}),
    ...(adresse.postalCode ? { postal_code: String(adresse.postalCode) } : {}),
    ...(adresse.city ? { city: String(adresse.city) } : {}),
    ...(adresse.country ? { country: String(adresse.country).toUpperCase() } : {}),
  };
  return Object.keys(sortie).length > 0 ? sortie : null;
}

/**
 * LE NUMÉRO DE TVA DU CLIENT — l'objet `tax_id`, pas un champ d'adresse.
 *
 * ══ POURQUOI IL EST SÉPARÉ DES PARAMÈTRES DU CLIENT ═════════════════════════
 *
 * Stripe ne l'accepte PAS à la création d'un client : c'est une sous-ressource
 * (`POST /v1/customers/{id}/tax_ids`), créée après coup. L'inclure dans
 * `params` ferait échouer la création entière pour un champ inconnu — et le
 * refus arriverait devant un client qui paie.
 *
 * `type` est déduit du préfixe pays du numéro. On ne traite QUE `eu_vat`
 * aujourd'hui : c'est le seul régime que ce parc facture, et inventer une table
 * des trente types Stripe pour des cas qui n'existent pas produirait du code
 * que rien n'éprouve.
 *
 * `null` quand aucun numéro n'est renseigné — ce qui est parfaitement légitime :
 * une entreprise en franchise de TVA n'en a pas.
 */
function buildTaxIdentity(company) {
  const numero = String(company?.vatNumber ?? '').trim().toUpperCase();
  if (!numero) return null;
  if (!/^[A-Z]{2}[0-9A-Z]{2,13}$/.test(numero)) return null;
  return { type: 'eu_vat', value: numero };
}

/**
 * Ce qui part chez Stripe — l'identité JURIDIQUE du client, et ce qu'elle exige.
 *
 * ── CE QUI Y EST ENTRÉ AVEC CE CHANTIER, ET POURQUOI ────────────────────────
 *
 * `name`     la RAISON SOCIALE. C'est ce que Stripe imprime en tête du bloc
 *            « Facturer à », et c'est la seule valeur qui y ait un sens légal.
 *            Le nom commercial (`tradingName`) n'y figure PAS : « SB Auto 06 »
 *            peut être l'enseigne d'une « SARL DUPONT AUTOMOBILES », et c'est
 *            la seconde qui engage.
 *
 * `email`    l'adresse de FACTURATION — celle qui reçoit le document, souvent
 *            une boîte comptable. Elle est exigée par la readiness : sans elle,
 *            Stripe n'envoie la facture à personne.
 *
 * `address`  l'adresse EFFECTIVE de facturation, déjà résolue par le Panel
 *            (facturation propre, ou siège à défaut). Stripe l'imprime sous la
 *            raison sociale.
 *
 * `phone`    facultatif, imprimé quand il existe.
 *
 * ── CE QUI N'Y EST TOUJOURS PAS ─────────────────────────────────────────────
 *
 * Ni moyen de paiement, ni langue, ni fuseau, ni préférences de facturation.
 * Le besoin n'existe pas, et chaque donnée personnelle qui traverse le pont
 * doit ensuite être justifiée, protégée et purgée.
 *
 * ── LES METADATA : CORROBORATIVES, JAMAIS PROBANTES ─────────────────────────
 *
 * `contractId`, `providerMode` et `applicationEnvironment` conservent EXACTEMENT
 * leurs noms d'origine : le support et la réconciliation les lisent ainsi
 * depuis toujours, et les renommer casserait des rapprochements qu'aucun test
 * ne couvre.
 *
 * S'y ajoutent l'entreprise cliente et son SIREN — pour qu'un exploitant
 * puisse, depuis le tableau de bord Stripe, remonter à la fiche du Panel. Elles
 * restent CORROBORATIVES : les metadata Stripe s'éditent depuis le tableau de
 * bord, et l'autorité d'appartenance est le registre de liens.
 *
 * `contractReference` y entre aussi, et c'est le point du chantier : la
 * référence de contrat est une RÉFÉRENCE COMMERCIALE. Elle a sa place ici, dans
 * la description d'une ligne, dans un champ personnalisé de facture — jamais en
 * guise de raison sociale.
 */
function buildParams({ projectId, environment, contractId, projection, company }) {
  const adresse = buildAddress(effectiveBillingAddress(company));
  const email = String(company.billingEmail ?? '').trim();
  const telephone = String(company.phone ?? '').trim();

  return {
    name: String(company.legalName).trim(),
    ...(email ? { email } : {}),
    ...(adresse ? { address: adresse } : {}),
    ...(telephone ? { phone: telephone } : {}),
    metadata: {
      contractId,
      contractReference: projection.reference ?? '',
      providerMode: environment,
      applicationEnvironment: environment,
      /** Traçabilité du plan de contrôle. Corroboratif, jamais probant. */
      panelProjectId: projectId,
      clientCompanyId: company.clientCompanyId,
      ...(company.siren ? { clientSiren: company.siren } : {}),
    },
  };
}

export default {
  CUSTOMER_REFUSALS,
  CustomerAuthorityError,
  customerOperationId,
  resolveCustomerIntent,
};
