// LE TARIF D'UN CONTRAT — et pourquoi sa clé n'est pas celle qu'on croyait (L6.2E).
//
// docs/architecture/STRIPE_L6_2E_PRODUCT_PRICE_SUBSCRIPTION_CUTOVER_REPORT.md.
//
// ══ CE QUE L'AUDIT DU PARC A RÉELLEMENT TROUVÉ ══════════════════════════════
//
// Le code historique clé ses Product et Price sur la VERSION du contrat :
//
//     product-<contractId>-v<version>-<mode>
//     price-<contractId>-v<version>-<interval>-<amount>-<mode>
//
// Or `signatureConfiguration.version` s'incrémente à CHAQUE sauvegarde de la
// configuration des zones de signature (`contract.service.js:218`). Déplacer une
// zone de trois pixels la fait passer de 2 à 3 — sans qu'aucun terme commercial
// n'ait bougé.
//
// Ce n'est donc pas une version COMMERCIALE, c'est un compteur de document. Y
// adosser l'identité d'un tarif produit des Price rigoureusement identiques en
// montant, devise et périodicité, mais démultipliés — un catalogue Stripe
// pollué, et une comptabilité plus difficile à lire.
//
// ══ ET UN DÉFAUT, DANS L'AUTRE SENS ═════════════════════════════════════════
//
// La garde de cache locale compare version, périodicité et montant — mais PAS
// la devise (`subscription.service.js:128`). Un passage EUR → CHF à montant
// identique réutilisait donc le Price existant, avec la mauvaise devise.
//
// ══ LA CLÉ RETENUE : LES TERMES, RIEN QUE LES TERMES ════════════════════════
//
//   PRODUCT   (environnement, contrat)
//             Un Product ne porte aucun montant : il NOMME ce qu'on vend. Sa
//             cardinalité naturelle est donc le contrat, et les tarifs
//             successifs s'y accrochent.
//
//   PRICE     (environnement, contrat, périodicité, montant, devise)
//             Ce sont exactement les termes qu'un Price fige. Deux tarifs de
//             mêmes termes SONT le même tarif ; deux tarifs de termes
//             différents ne peuvent jamais se confondre, puisque chaque terme
//             entre dans la clé.
//
// ══ CE QUE CETTE CLÉ GARANTIT, POINT PAR POINT ══════════════════════════════
//
//   · jamais un Price réutilisé pour un autre montant    → le montant est dans la clé
//   · jamais un Price historique muté                    → on ne fait que créer
//   · jamais TEST et PROD confondus                      → l'environnement est dans la clé
//   · jamais deux contrats mélangés                      → le contrat est dans la clé
//   · un abonnement ancien garde son tarif               → rien n'est supprimé
//
// La contrainte d'immutabilité vient d'ailleurs de Stripe lui-même : un Price ne
// se modifie pas. On ne la contourne jamais — il n'existe aucune primitive de
// mise à jour de Price dans le transport.
import { PanelProjectContract } from '../../../models/PanelProjectProjection.model.js';
import { readRecurrence } from '../../contract/contractRecurrence.js';

/* -------------------------------------------------------------------------- */
/*  REFUS                                                                     */
/* -------------------------------------------------------------------------- */

export const PRICE_REFUSALS = Object.freeze({
  /** Couvre « aucun contrat » ET « pas le sien » — pas d'oracle d'existence. */
  CONTRACT_NOT_OWNED: 'CONTRACT_NOT_OWNED',
  /** La projection ne porte aucun abonnement exploitable. */
  SUBSCRIPTION_PRICE_ABSENT: 'SUBSCRIPTION_PRICE_ABSENT',
});

export class PriceAuthorityError extends Error {
  constructor(reason, message) {
    super(message);
    this.name = 'PriceAuthorityError';
    this.reason = reason;
  }
}

/* -------------------------------------------------------------------------- */
/*  LES IDENTITÉS D'ACTE                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Le Product d'un contrat. Un seul par contrat et par monde.
 *
 * Lisible et non haché : cette valeur ne part pas chez le fournisseur — c'est la
 * clé d'idempotence Stripe, dérivée d'elle, qui voyage. Ici la lisibilité vaut
 * plus que l'opacité, c'est ce qu'un opérateur lira dans le registre le jour où
 * il cherchera pourquoi un tarif manque.
 */
export function productOperationId({ environment, contractId }) {
  return `stripe-product:${environment}:${contractId}`;
}

/**
 * Le Price de TERMES donnés. Le montant est en centimes et la devise en
 * minuscules : deux graphies du même tarif produiraient deux clés, donc deux
 * Price identiques.
 *
 * ══ L'INTERVALLE FAIT PARTIE DES TERMES ═════════════════════════════════════
 *
 * `intervalCount` entre dans la clé au même titre que le montant, et l'oubli
 * aurait été silencieux : « 900 € tous les mois » et « 900 € tous les 3 mois »
 * partagent montant, devise, unité et contrat. Sans le compte, ils auraient
 * partagé la CLÉ — donc le Price. Passer d'une périodicité à l'autre aurait
 * réutilisé le tarif de l'ancienne, et le client aurait été débité à une
 * fréquence que son contrat ne dit plus. Rien ne l'aurait signalé : un Price
 * réutilisé est le cas NORMAL de cette fonction.
 *
 * ══ POURQUOI « x1 » NE S'ÉCRIT PAS ══════════════════════════════════════════
 *
 * Le réflexe serait de toujours suffixer — une forme unique se relit plus
 * facilement. Mais TOUT le parc déjà lié porte des clés de l'ancienne forme, et
 * il est intégralement en `intervalCount = 1` : suffixer sans condition les
 * aurait toutes renommées d'un coup. Aucune ne se serait plus retrouvée dans le
 * registre, et le Panel aurait recréé, pour chaque contrat, un Price
 * rigoureusement identique à celui qui existait déjà — exactement la pollution
 * de catalogue que la clé par TERMES avait été conçue pour supprimer.
 *
 * Le suffixe n'apparaît donc qu'à partir de 2. Et il ne peut pas collisionner :
 * `month` ne sera jamais égal à `monthx<n>` pour un `n` supérieur à 1. La forme
 * varie, l'identité non — c'est la seule variation qui ne coûte rien.
 */
export function priceOperationId({ environment, contractId, interval, intervalCount = 1, amount, currency }) {
  const n = Number(intervalCount) >= 1 ? Number(intervalCount) : 1;
  const periodicite = n > 1 ? `${interval}x${n}` : interval;
  return `stripe-price:${environment}:${contractId}:${periodicite}:${amount}:${String(currency).toLowerCase()}`;
}

/** `MONTH`/`YEAR` du contrat → `month`/`year` de Stripe. Normalisé une seule fois. */
export function normalizeInterval(interval) {
  return String(interval ?? '').toUpperCase() === 'YEAR' ? 'year' : 'month';
}

/* -------------------------------------------------------------------------- */
/*  RÉSOLUTION                                                                */
/* -------------------------------------------------------------------------- */

async function defaultLookupContract(projectId) {
  return PanelProjectContract.findOne({ projectId }).lean();
}

/**
 * Les termes du tarif de ce contrat — lus dans la PROJECTION, jamais reçus.
 *
 * C'est la frontière financière du lot : un montant transmis puis comparé
 * resterait un montant transmis, et le jour où la comparaison devient une
 * tolérance, l'autorité a changé de camp sans qu'aucune ligne ne le dise.
 *
 * @returns {Promise<{contractId, reference, interval, amount, currency,
 *   productOperationId, priceOperationId, productParams, priceParamsFor}>}
 * @throws {PriceAuthorityError}
 */
export async function resolvePriceIntent({
  projectId, environment, contractRef, lookupContract = defaultLookupContract,
}) {
  const projection = await lookupContract(projectId);
  const contractId = projection?.sourceContractId ?? null;

  if (!projection || !contractId || contractId !== String(contractRef)) {
    throw new PriceAuthorityError(
      PRICE_REFUSALS.CONTRACT_NOT_OWNED,
      'Aucun contrat de ce projet ne correspond à cette référence.',
    );
  }

  const sub = projection.pricing?.subscription ?? null;
  const amount = Number(sub?.amountIncludingTax ?? 0);
  const currency = String(sub?.currency ?? '').trim().toLowerCase();

  /**
   * LA PÉRIODICITÉ VIENT DE LA PROJECTION, ENTIÈRE.
   *
   * `readRecurrence` rend `null` quand rien d'exploitable n'a été projeté, et
   * ce `null` n'est PAS comblé ici : on préfère refuser la création du tarif
   * plutôt que de facturer à une fréquence que personne n'a décidée. C'est la
   * même règle que pour un montant absent, quelques lignes plus bas — la
   * fréquence engage autant que la somme.
   */
  const recurrence = readRecurrence(sub);
  const interval = recurrence ? normalizeInterval(recurrence.unit) : null;
  const intervalCount = recurrence?.interval ?? null;

  /**
   * Un montant nul ou absent n'est pas « gratuit » : c'est une projection
   * incomplète. Créer un tarif à zéro produirait un abonnement qui ne prélève
   * rien tout en se déclarant actif.
   */
  if (!Number.isInteger(amount) || amount <= 0 || !currency || !recurrence) {
    throw new PriceAuthorityError(
      PRICE_REFUSALS.SUBSCRIPTION_PRICE_ABSENT,
      'La projection de contrat ne porte pas d’abonnement exploitable.',
    );
  }

  const reference = projection.reference ?? null;
  /**
   * `document.version` est recopiée dans les METADATA — pas dans la clé.
   *
   * Elle reste précieuse au support (« quelle version du contrat était en
   * vigueur ? ») et le code historique la publiait déjà sous ce nom. Mais elle
   * ne DÉCIDE de rien : voir l'en-tête du fichier.
   */
  const contractVersion = String(projection.document?.version ?? 0);

  const metadata = {
    contractId,
    contractReference: reference ?? '',
    providerMode: environment,
    applicationEnvironment: environment,
    contractVersion,
    /** Traçabilité du plan de contrôle. Corroboratif, jamais probant. */
    panelProjectId: projectId,
  };

  return {
    contractId,
    reference,
    interval,
    intervalCount,
    amount,
    currency,
    contractVersion,
    productOperationId: productOperationId({ environment, contractId }),
    priceOperationId: priceOperationId({
      environment, contractId, interval, intervalCount, amount, currency,
    }),
    productParams: {
      name: `Abonnement — ${reference || contractId}`,
      metadata,
    },
    /** Le Price a besoin du Product : ses paramètres se ferment après coup. */
    priceParamsFor: (productId) => ({
      product: productId,
      unit_amount: amount,
      currency,
      /**
       * `interval_count` est TOUJOURS transmis, même à 1.
       *
       * Stripe le suppose à 1 quand il manque, et s'en remettre à cette
       * supposition ferait dépendre la période facturée d'un défaut du
       * fournisseur plutôt que du contrat. Ce qui est écrit dans le contrat
       * doit être écrit dans l'appel.
       */
      recurring: { interval, interval_count: intervalCount },
      metadata,
    }),
  };
}

export default {
  PRICE_REFUSALS,
  PriceAuthorityError,
  productOperationId,
  priceOperationId,
  normalizeInterval,
  resolvePriceIntent,
};
