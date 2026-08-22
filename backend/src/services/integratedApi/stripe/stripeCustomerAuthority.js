// À QUEL CONTRAT APPARTIENT UN CLIENT STRIPE ? (L6.2D)
//
// docs/architecture/STRIPE_L6_2D_CUSTOMER_OWNERSHIP_REPORT.md.
//
// ══ LA CARDINALITÉ — ELLE A CHANGÉ, ET VOICI POURQUOI ═══════════════════════
//
// ── CE QUE L'AUDIT L6.2D AVAIT ÉTABLI ──────────────────────────────────────
//
// Un client Stripe par CONTRAT. Trois faits l'établissaient : la clé
// d'idempotence historique `customer-<contractId>-<mode>`, le stockage sur
// `Contract.stripe.customerId`, et la lecture inverse de la facturation.
//
// C'était une description FIDÈLE d'un système où l'acheteur n'existait pas
// comme entité : le contrat était le seul porteur disponible.
//
// ── CE QUE CETTE CARDINALITÉ COÛTAIT ───────────────────────────────────────
//
//   · deux contrats successifs du même client → deux clients Stripe, et
//     l'historique de facturation d'une seule personne morale coupé en deux ;
//   · une prestation ponctuelle, qui n'a PAS de contrat → AUCUN client, donc
//     une facture sans destinataire juridique.
//
// Le second cas n'était pas théorique : le verbe n'était pas appelé du tout,
// et une session réellement ouverte portait `customer: null`.
//
// ── LA CARDINALITÉ COURANTE ────────────────────────────────────────────────
//
//       Entreprise cliente ── (dans un monde) ──▶ UN client Stripe
//         ├── Contrat 1  ─┐
//         ├── Contrat 2  ─┼──▶ le MÊME cus_…
//         └── Prestation ─┘
//
// On facture une PERSONNE MORALE. C'est le seul niveau où « Facturer à » a un
// sens : ni un engagement, ni une instance technique.
//
// ── ET DEUX PROJETS DU MÊME CLIENT ? ───────────────────────────────────────
//
// Ils ont chacun leur client Stripe, et ce n'est pas un compromis : le
// registre d'appartenance impose qu'une ressource ait EXACTEMENT UN projet
// propriétaire. Partager un `cus_…` la rendrait possédée par deux projets, et
// chacun lirait les factures de l'autre. Aller plus loin exigerait de
// remplacer le propriétaire par un ensemble de lecteurs autorisés — un autre
// modèle de sécurité, pas un réglage.
//
// ── L'ANCIEN N'EST NI RÉÉCRIT NI SUPPRIMÉ ──────────────────────────────────
//
// Les liens existants sont ADOPTÉS sous la nouvelle clé : même ressource,
// même propriétaire, autorité mise à jour. L'abonnement en cours continue de
// fonctionner, aucune facture n'est retouchée.
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
 * Forme LISIBLE et non hachée : cette valeur ne part pas chez le fournisseur —
 * c'est la clé d'idempotence Stripe, dérivée d'elle, qui voyage. Ici, la
 * lisibilité vaut plus que l'opacité : c'est ce qu'un opérateur lira dans le
 * registre d'opérations le jour où il cherchera pourquoi un client manque.
 *
 * Le PROJET n'y figure pas : il est déjà porté par la clé du registre
 * d'opérations `(projectId, capability, operationId)`, et par le filtre du
 * registre de liens. L'y ajouter une seconde fois ne protégerait de rien.
 */
/**
 * ── LA CLÉ A CHANGÉ DE PORTEUR : DU CONTRAT À L’ENTREPRISE CLIENTE ────────
 *
 * ══ CE QUE LA CLÉ PAR CONTRAT PRODUISAIT ═════════════════════════════════
 *
 * Un client Stripe par CONTRAT. Donc, pour une même personne morale :
 *
 *   · deux contrats successifs        → deux clients Stripe
 *   · deux projets du même client     → deux clients Stripe
 *   · une prestation SANS contrat     → AUCUN client — et une facture sans
 *                                        destinataire identifié
 *
 * Le troisième cas était le plus grave : le verbe n’était tout simplement
 * pas appelé, et la facture d’une prestation ponctuelle ne portait aucune
 * identité juridique. Les deux premiers dupliquaient la même entreprise dans
 * le tableau de bord Stripe, avec un historique de facturation scindé.
 *
 * ══ POURQUOI L’ENTREPRISE, ET PAS LE PROJET ══════════════════════════════
 *
 * Parce que c’est elle qu’on facture. Un projet est une instance technique ;
 * un client peut en avoir plusieurs, et il ne veut pas trois fiches chez
 * Stripe pour trois sites. La personne morale est le seul niveau où
 * « Facturer à » a un sens.
 *
 * ══ CE QUI ARRIVE À L’ANCIENNE CLÉ ═══════════════════════════════════════
 *
 * Rien de destructif. Les liens existants sont ADOPTÉS sous la nouvelle clé
 * par l’adaptateur : le même `cus_…` continue de porter l’abonnement en
 * cours et son historique de factures. Voir `legacyCustomerOperationId`.
 *
 * Le MONDE reste dans la clé : `TEST` et `PROD` sont deux comptes Stripe,
 * donc deux clients distincts pour une même personne morale. Les confondre
 * ferait converger la recette vers le client de production.
 */
export function customerOperationId({ environment, clientCompanyId }) {
  return `stripe-customer:${environment}:company:${clientCompanyId}`;
}

/**
 * L’ANCIENNE CLÉ — conservée pour ADOPTER, jamais pour créer.
 *
 * Elle ne sert qu’à retrouver un client déjà créé du temps où l’autorité
 * était le contrat. L’adaptateur le rebaptise sous la clé courante ; aucun
 * second client n’est créé, aucune facture n’est réécrite.
 */
export function legacyCustomerOperationId({ environment, contractId }) {
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
  /**
   * ── LE CONTRAT EST DÉSORMAIS FACULTATIF, ET LA GARDE RESTE ENTIÈRE ──────
   *
   * Une prestation ponctuelle n’a pas de contrat : exiger `contractRef`
   * revenait à interdire de la facturer, ou à percer la garde qui protège
   * les paiements contractuels. On distingue donc les deux cas au lieu de
   * les confondre :
   *
   *   `contractRef` fourni  → l’appartenance est VÉRIFIÉE, exactement comme
   *                           avant. Un identifiant qui n’est pas celui du
   *                           projet est refusé, sans nuance.
   *   `contractRef` absent  → aucun contrat n’est invoqué, donc rien à
   *                           vérifier. L’autorité de facturation reste
   *                           l’entreprise cliente, contrôlée juste après.
   *
   * Ce qui n’a PAS changé : on ne facture jamais sans identité légale.
   */
  const contractRef = String(input.contractRef ?? '').trim();
  const projection = await lookupContract(projectId);
  let contractId = null;

  if (contractRef) {
    contractId = projection?.sourceContractId ?? null;
    if (!projection || !contractId || contractId !== contractRef) {
      throw new CustomerAuthorityError(
        CUSTOMER_REFUSALS.CONTRACT_NOT_OWNED,
        'Aucun contrat de ce projet ne correspond à cette référence.',
      );
    }
  }

  /**
   * ── LA CLÉ HÉRITÉE SE CHERCHE MÊME SANS CONTRAT DEMANDÉ ──────────────────
   *
   * ══ LE DÉFAUT QUE CES DEUX LIGNES FERMENT ═══════════════════════════════
   *
   * L'adoption ne se déclenchait que si l'appelant fournissait `contractRef`.
   * Une prestation ponctuelle n'en fournit jamais : elle ne trouvait donc aucun
   * lien hérité, et faisait CRÉER un second client Stripe pour une personne
   * morale qui en avait déjà un.
   *
   * C'est exactement la duplication que ce lot supprime — réintroduite par le
   * chemin même qu'il devait réparer. Constaté sur l'environnement déployé :
   * trois liens `CUSTOMER` pour un seul projet.
   *
   * ══ POURQUOI LE CONTRAT COURANT, ET PAS « UN » CONTRAT ══════════════════
   *
   * La projection ne porte qu'UN contrat par projet : le courant. C'est celui
   * dont le client Stripe porte l'abonnement vivant et l'historique de
   * facturation. Adopter le sien est donc à la fois déterministe et juste.
   *
   * Le contrat n'entre PAS dans l'intention pour autant : `contractId` reste
   * `null`, les métadonnées restent muettes, et rien ne laisse croire que cette
   * prestation appartient à un engagement.
   */
  const contratCourant = projection?.sourceContractId ?? null;

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
  const clientCompanyId = String(company?.clientCompanyId ?? '').trim();

  /**
   * ── SANS IDENTIFIANT, PAS DE CLÉ — ET SURTOUT PAS UNE CLÉ VIDE ───────────
   *
   * La clé d'acte est `…:company:<id>`. Si l'identifiant manquait, elle
   * deviendrait `…:company:undefined` — la MÊME pour tout le parc. Tous les
   * projets partageraient alors un seul client Stripe, et chacun lirait les
   * factures des autres. C'est la panne la plus grave que ce fichier puisse
   * produire, et elle serait silencieuse.
   *
   * Ce cas ne devrait pas exister — la readiness vient de déclarer la
   * facturation possible. S'il survient, la fiche et le verdict se
   * contredisent : on refuse, et l'incohérence se voit tout de suite.
   */
  if (!clientCompanyId) {
    throw new CustomerAuthorityError(
      CUSTOMER_REFUSALS.CLIENT_COMPANY_NOT_READY,
      'L’entreprise cliente de ce projet est déclarée facturable mais ne porte aucun '
      + 'identifiant : la facturation est suspendue jusqu’à ce que la fiche soit cohérente.',
      { state: readiness.state, missing: ['clientCompanyId'] },
    );
  }
  return {
    contractId,
    clientCompanyId,
    operationId: customerOperationId({ environment, clientCompanyId }),
    /**
     * L’ANCIENNE CLÉ VOYAGE AVEC L’INTENTION, dès qu’un contrat existe.
     *
     * C’est ce qui permet à l’adaptateur d’ADOPTER un client créé avant ce
     * lot au lieu d’en créer un second pour la même personne morale.
     *
     * Elle est dérivée du contrat COURANT du projet, et non de celui que
     * l’appelant a nommé : une prestation ponctuelle n’en nomme aucun, et
     * c’est précisément elle qui, sans cela, créait le doublon.
     *
     * `null` seulement quand le projet n’a jamais eu de contrat : il n’y a
     * alors rien à adopter, et la création est légitime.
     */
    legacyOperationId: contratCourant
      ? legacyCustomerOperationId({ environment, contractId: contratCourant })
      : null,
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
      /**
       * ── LE CONTRAT N’EST PLUS TOUJOURS LÀ, ET C’EST NORMAL ────────────────
       *
       * Une prestation ponctuelle n’en a pas. Les champs sont donc OMIS plutôt
       * qu’envoyés vides : `contractId: ''` dans le tableau de bord Stripe se
       * lit comme une donnée perdue, alors que l’absence se lit comme une
       * absence. Les noms, eux, ne bougent pas — le support et la
       * réconciliation les lisent ainsi depuis toujours.
       */
      ...(contractId ? { contractId } : {}),
      ...(projection?.reference ? { contractReference: projection.reference } : {}),
      providerMode: environment,
      applicationEnvironment: environment,
      /**
       * Le projet qui a créé ce client. Corroboratif, jamais probant :
       * l’autorité d’appartenance est le registre de liens.
       */
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
  legacyCustomerOperationId,
  resolveCustomerIntent,
};
