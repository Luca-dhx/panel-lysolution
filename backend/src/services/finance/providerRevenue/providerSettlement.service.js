/**
 * LE COÛT FOURNISSEUR D'UN ENCAISSEMENT — observé chez Stripe, écrit au registre
 * comme une CHARGE (L13).
 *
 * ══ LE FAIT QUE CE MODULE CORRIGE ═══════════════════════════════════════════
 *
 * Jusqu'ici, un paiement de 120 € produisait UNE ligne : « +120 € ». C'est ce
 * que le client a payé, et c'est juste. Mais 117,85 € seulement avaient rejoint
 * le compte : les 2,15 € de commission n'existaient nulle part. Le chiffre
 * d'affaires était exact, le bénéfice était FAUX — surestimé de tous les frais
 * de paiement de l'année, sans qu'aucun écran ne puisse le dire.
 *
 * ══ LA DOCTRINE, EN TROIS LIGNES QUI NE SE NÉGOCIENT PAS ════════════════════
 *
 *     LE CHIFFRE D'AFFAIRES RESTE LE BRUT.        120,00 €  (REVENUE)
 *     LA COMMISSION EST UNE CHARGE.                 2,15 €  (COST)
 *     LE NET SE DÉDUIT, IL NE SE STOCKE PAS.      117,85 €  (dérivé)
 *
 * Transformer une vente de 120 € en revenu de 117,85 € serait la faute la plus
 * coûteuse du lot : elle est silencieuse, elle fausse une déclaration de TVA, et
 * elle rend le registre irréconciliable avec les factures émises. Le net n'est
 * donc écrit NULLE PART — il se lit, comme le bénéfice, par soustraction.
 *
 * ══ POURQUOI UNE TRANSACTION SÉPARÉE, ET NON UN CHAMP SUR LE REVENU ═════════
 *
 * Parce que le registre a DÉJÀ un moteur de coûts, et qu'il est générique. Un
 * mouvement `COST` + `OUTFLOW` entre dans « Coûts de la période » et diminue le
 * bénéfice, sans qu'une seule ligne de l'agrégateur change. Un champ
 * `stripeFeeCents` posé sur le revenu aurait exigé un second moteur : une somme
 * de plus dans `financialSummary`, une colonne de plus dans la répartition par
 * projet, et une occasion de plus de compter la commission deux fois.
 *
 * La séparation n'est pas non plus une invention comptable : une commission
 * bancaire EST une charge d'exploitation. Le modèle dit ce qui est vrai.
 *
 * ══ CE N'EST PAS UN SECOND PAIEMENT ═════════════════════════════════════════
 *
 * La ligne de coût porte `parentTransactionId` — le revenu qu'elle grève — et
 * une `provenance` dont l'identifiant est l'écriture de solde (`txn_…`). Elle
 * n'est donc jamais autonome : elle se lit avec son revenu, elle en hérite la
 * date comptable, et elle disparaîtrait du sens si on la détachait.
 *
 *     PAIEMENT  ←→  COÛT FOURNISSEUR  ←→  BALANCE TRANSACTION
 *
 * Les trois sont liés par des identités stables, dans les deux sens.
 *
 * ══ L'IDEMPOTENCE EST EN BASE, PAS DANS CE FICHIER ══════════════════════════
 *
 * L'index unique partiel `uniq_provider_external_object` porte déjà
 * `{provider, environment, externalKind, externalId}` sur le registre. Une même
 * `balance_transaction` observée dix fois — rejeu de webhook, convergence
 * concurrente, redémarrage au mauvais moment — ne peut produire qu'UNE ligne de
 * coût. Le second écrivain reçoit un E11000, et ce refus EST la preuve.
 *
 * ══ IL PARLE À STRIPE, DONC IL N'EST PAS APPELÉ PAR UN ÉCRAN ════════════════
 *
 * Même frontière que L10.4 : la projection ne sort jamais du Panel, ce module
 * si. Il est déclenché par les SUITES d'un encaissement prouvé
 * (`settleProjectedFact`) et par l'ordonnanceur. Jamais par une lecture
 * financière — sans quoi un onglet Finances rafraîchi en boucle déclencherait
 * autant d'appels Stripe.
 */
import { randomUUID } from 'node:crypto';

import logger from '../../../utils/logger.js';
import PanelProviderRevenueFact, {
  PROJECTION_STATUS,
} from '../../../models/PanelProviderRevenueFact.model.js';
import {
  CATEGORIES, FLOWS, ORIGINS, STATUSES, PanelFinancialTransaction,
} from '../../../models/PanelFinancialTransaction.model.js';
import { SUPPORTED_CURRENCIES } from '../money.js';
import { invokeCapability } from '../../capabilities/capabilityGateway.service.js';
import { INVOCATION_SOURCES } from '../../capabilities/invocationContext.js';
import { runtimeEnvironment } from '../../integratedApi/environment.js';
import { maskResourceId } from '../../integratedApi/stripe/stripeResourceBinding.js';
import {
  SETTLEMENT_STATUS,
  SETTLEMENT_REASON,
} from '../../integratedApi/stripe/stripeSettlementAuthority.js';
import { FACT_KIND, CANONICAL_TYPES } from './stripeRevenueNormalizer.js';

const PROVIDER = 'STRIPE';
const CAPABILITY = 'billing.settlement.retrieve';

/**
 * LE TYPE D'OBJET EXTERNE D'UNE LIGNE DE COÛT FOURNISSEUR.
 *
 * Il entre dans la clé d'unicité de la `provenance`. Le choisir DIFFÉRENT des
 * types canoniques (`INVOICE`, `CHECKOUT_SESSION`, `REFUND`) est ce qui permet
 * au coût de cohabiter avec le revenu qu'il grève : les deux mouvements ont un
 * `externalId` distinct — l'un désigne le document, l'autre l'écriture de
 * solde — et ne peuvent donc jamais se collisionner ni se confondre.
 */
export const PROVIDER_FEE_EXTERNAL_KIND = 'BALANCE_TRANSACTION';

/**
 * Au-delà, on cesse de réessayer AUTOMATIQUEMENT.
 *
 * Ce n'est pas un abandon : le fait garde son motif, il reste lisible dans la
 * file de diagnostic, et un rattrapage explicite peut le forcer. C'est une
 * protection contre une ressource définitivement illisible, qu'on
 * réinterrogerait à chaque cycle pour toujours — c'est-à-dire un appel Stripe
 * par heure et par paiement mort.
 */
export const MAX_TENTATIVES_SETTLEMENT = 6;

/** Ce qu'une capture a produit. Nommé : un retour muet ne se diagnostique pas. */
export const SETTLEMENT_OUTCOME = Object.freeze({
  /** Les chiffres sont là et la ligne de coût a été écrite (ou n'avait pas lieu d'être). */
  SETTLED: 'SETTLED',
  /** Déjà observé, rien à faire. C'est le résultat NORMAL d'un rejeu. */
  ALREADY_SETTLED: 'ALREADY_SETTLED',
  /** Stripe n'a pas encore arrêté ses comptes. On repassera. */
  PENDING: 'PENDING',
  /** Rien à attendre : aucune ressource ne mène à une écriture de solde. */
  UNAVAILABLE: 'UNAVAILABLE',
  /** Des chiffres inexploitables par le registre — devise, incohérence. */
  UNUSABLE: 'UNUSABLE',
  /** Le fait n'est pas projeté : il n'a pas de mouvement à grever. */
  NOT_PROJECTED: 'NOT_PROJECTED',
  /** Trop d'échecs successifs : on ne réessaie plus tout seul. */
  ABANDONED: 'ABANDONED',
  /** L'appel n'a pas abouti — rejouable au cycle suivant. */
  FAILED: 'FAILED',
});

/**
 * L'OBSERVATION LA PLUS SÛRE GAGNE — et une attente ne défait jamais un acquis.
 *
 * ══ LE DÉFAUT QUE CETTE RÈGLE FERME ═════════════════════════════════════════
 *
 * Les webhooks n'arrivent pas dans l'ordre, et la convergence tourne en
 * parallèle d'eux. Rien n'empêche donc une lecture ANCIENNE — partie avant que
 * Stripe n'arrête ses comptes — de revenir APRÈS une lecture récente qui, elle,
 * portait les chiffres.
 *
 * Sans arbitrage, ce retardataire remettrait `providerFeeCents` à `null` et le
 * statut à `PENDING` sur un encaissement déjà soldé. La ligne de coût déjà
 * écrite au registre resterait — l'index l'y maintient — mais plus rien ne
 * l'expliquerait : un bilan avec une charge que son écran ne sait plus
 * justifier est pire qu'un bilan incomplet.
 *
 * La règle ne dépend d'aucune horloge, et c'est délibéré : comparer des dates
 * supposerait que les horloges concordent. **Un `SETTLED` ne se remplace que
 * par lui-même, c'est-à-dire jamais.** Tout le reste s'écrase librement — un
 * `PENDING` n'a rien à perdre.
 */
export function shouldReplaceSettlement(existant, entrant) {
  if (!entrant?.status) return false;
  if (existant?.status === SETTLEMENT_STATUS.SETTLED) return false;
  return true;
}

/**
 * PAR QUELLE RESSOURCE ON REMONTE À L'ÉCRITURE DE SOLDE.
 *
 * ══ POURQUOI L'ORDRE COMPTE ═════════════════════════════════════════════════
 *
 * Un REMBOURSEMENT a sa propre écriture — montant négatif, et un frais qui dit
 * si le fournisseur a rendu sa commission. Emprunter celle du débit inscrirait
 * le frais du PAIEMENT une seconde fois, en charge, sur un mouvement de sortie.
 *
 * Un REVENU, lui, n'a pas d'écriture propre : ni une facture ni une session ne
 * touchent le solde. C'est le DÉBIT qui le fait, et on le rejoint par
 * l'intention quand la charge utile l'a donnée, par le débit sinon.
 *
 * ══ ET QUAND LE WEBHOOK N'A DONNÉ NI L'UNE NI L'AUTRE ═══════════════════════
 *
 * C'est le cas NOMINAL sur un compte récent, et la recette réelle l'a montré :
 * en `2026-06-24.dahlia`, un `invoice.paid` ne porte ni `charge`, ni
 * `payment_intent`, ni `payments.data`. Les deux premières voies tombent
 * ensemble — exactement comme en L10.7.
 *
 * On repart alors de ce que le Panel possède à coup sûr : **l'identité
 * canonique du fait**. La facture, lui, ne bouge pas d'une version d'API à
 * l'autre, et le fournisseur la relira avec la version ÉPINGLÉE du Panel, où le
 * règlement est présent. Une convergence ne doit jamais dépendre du champ qu'un
 * webhook expose ce mois-ci.
 *
 * L'ordre reste du plus DIRECT au plus DÉRIVÉ : ce que la charge utile affirme
 * d'abord, la relecture ensuite — un appel de moins quand elle suffit.
 */
export function settlementReferenceOf(fait) {
  if (fait?.kind === FACT_KIND.REFUND || fait?.objectType === CANONICAL_TYPES.REFUND) {
    return fait?.objectId ? { refundId: fait.objectId } : null;
  }
  const intention = fait?.corroboration?.paymentIntentId;
  if (intention) return { paymentIntentId: intention };
  const debit = fait?.corroboration?.chargeId;
  if (debit) return { chargeId: debit };
  /**
   * LE REPLI QUI FERME LE DÉFAUT — l'objet canonique lui-même.
   *
   * Réservé à la FACTURE : une session sans facture porte toujours son
   * `payment_intent` (Stripe ne l'en a pas retiré), et la relire n'apprendrait
   * rien de plus. Étendre le repli à tout objet canonique aurait ajouté un
   * appel fournisseur là où la charge utile suffit.
   */
  if (fait?.objectType === CANONICAL_TYPES.INVOICE && fait?.objectId) {
    return { invoiceId: fait.objectId };
  }
  return null;
}

/**
 * QUEL MOUVEMENT UN FRAIS DOIT PRODUIRE — sens compris.
 *
 * ══ LE SIGNE VIENT DE STRIPE, LE SENS VIENT D'ICI ═══════════════════════════
 *
 * `fee > 0` : le fournisseur a prélevé. C'est une CHARGE, et elle sort.
 * `fee < 0` : le fournisseur a RENDU une commission — cela arrive sur certains
 *             remboursements, selon le pays et l'ancienneté du débit. Ce n'est
 *             pas un revenu (aucun client n'a payé) : c'est une CORRECTION qui
 *             entre. La ranger en `REVENUE` gonflerait le chiffre d'affaires
 *             d'une somme qui n'a jamais été facturée.
 * `fee === 0` : Stripe affirme n'avoir rien prélevé. Un mouvement de zéro n'est
 *             pas un mouvement (doctrine L10.1) : on n'écrit RIEN, et
 *             l'observation reste sur le fait pour l'expliquer.
 *
 * Le montant rendu est TOUJOURS POSITIF : le sens est porté par `flow`, jamais
 * par un signe — deux porteurs du même sens finissent toujours par se
 * contredire.
 */
export function feeMovementOf({ fait, providerFeeCents }) {
  if (!Number.isInteger(providerFeeCents) || providerFeeCents === 0) return null;

  const remboursement = fait?.kind === FACT_KIND.REFUND;
  const restitue = providerFeeCents < 0;

  return {
    category: restitue ? CATEGORIES.ADJUSTMENT : CATEGORIES.COST,
    flow: restitue ? FLOWS.INFLOW : FLOWS.OUTFLOW,
    amountCents: Math.abs(providerFeeCents),
    label: restitue
      ? 'Commission Stripe restituée'
      : (remboursement ? 'Commission Stripe sur remboursement' : 'Commission Stripe'),
  };
}

/* -------------------------------------------------------------------------- */
/*  ÉCRITURE                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * ÉCRIT LA LIGNE DE COÛT — une seule, quoi qu'il arrive.
 *
 * ══ TOUT EST EN `$setOnInsert`, COMME LE REVENU ═════════════════════════════
 *
 * Un frais déjà écrit ne se réécrit pas. Stripe ne révise d'ailleurs pas une
 * `balance_transaction` : elle est arrêtée le jour où elle est créée. Mais
 * l'important n'est pas là — c'est qu'un total déjà affiché ne doit pas pouvoir
 * changer parce qu'un webhook a été rejoué.
 *
 * ══ LA LECTURE N'EXCLUT PAS LES SUPPRIMÉS ═══════════════════════════════════
 *
 * Même raison qu'au revenu (L10.3) : un coût retiré du livret par un opérateur
 * ne doit PAS réapparaître au rejeu suivant. La suppression est LOGIQUE, la clé
 * d'identité externe reste occupée, et l'on retrouve la pierre tombale.
 *
 * ══ LA DATE COMPTABLE EST CELLE DU REVENU, PAS CELLE DE L'OBSERVATION ═══════
 *
 * La commission a été prélevée sur CE paiement-là. La rattacher au jour où le
 * Panel l'a apprise ferait tomber un frais de fin de mois dans le mois suivant,
 * et le bénéfice de deux mois serait faux — l'un en trop, l'autre en moins.
 */
async function upsertFeeTransaction({ fait, revenu, settlement, mouvement }) {
  const clef = {
    'provenance.provider': PROVIDER,
    'provenance.environment': fait.environment,
    'provenance.externalKind': PROVIDER_FEE_EXTERNAL_KIND,
    'provenance.externalId': settlement.balanceTransactionId,
  };

  const existante = await PanelFinancialTransaction.findOne(clef)
    .select('transactionId deletedAt').lean();
  if (existante) {
    if (existante.deletedAt) {
      logger.info(
        `[finance] rejeu sur un coût fournisseur SUPPRIMÉ — `
        + `${maskResourceId(settlement.balanceTransactionId)} (${fait.environment}) : aucune résurrection.`,
      );
    }
    return existante.transactionId;
  }

  const transactionId = randomUUID();
  try {
    await PanelFinancialTransaction.updateOne(
      clef,
      {
        $setOnInsert: {
          transactionId,
          projectId: revenu.projectId ?? null,
          projectNameSnapshot: revenu.projectNameSnapshot ?? null,
          /** Le coût suit l'identité de facturation du revenu qu'il grève. */
          clientCompanyId: revenu.clientCompanyId ?? null,
          flow: mouvement.flow,
          /**
           * `COST`, et surtout PAS une catégorie « STRIPE_FEE ».
           *
           * La taxonomie reste fournisseur-agnostique : Stripe est une ORIGINE.
           * Inventer une catégorie par fournisseur ferait éclater le compte de
           * résultat en autant de colonnes que d'intégrations — et le jour où
           * un second PSP arriverait, il faudrait refaire l'écran Finances.
           */
          category: mouvement.category,
          origin: ORIGINS.STRIPE,
          status: STATUSES.RECORDED,
          label: `${mouvement.label} — ${revenu.label}`,
          description: descriptionDuFrais({ fait, settlement }),
          amountCents: mouvement.amountCents,
          currency: settlement.currency,
          effectiveDate: revenu.effectiveDate ?? new Date(),
          sourceId: null,
          cycleKey: null,
          sourceRevision: null,
          /** LE LIEN DÉTERMINISTE — ce coût grève CE paiement, et lui seul. */
          parentTransactionId: revenu.transactionId,
          provenance: {
            provider: PROVIDER,
            environment: fait.environment,
            externalId: settlement.balanceTransactionId,
            externalKind: PROVIDER_FEE_EXTERNAL_KIND,
          },
          receipt: { mediaId: null, attachedAt: null, attachedBy: null },
          deletedAt: null,
          deletedBy: null,
          deletionReason: null,
          createdBy: 'stripe',
          updatedBy: 'stripe',
        },
      },
      { upsert: true },
    );
  } catch (err) {
    /**
     * COURSE PERDUE — un autre écrivain vient d'insérer le même coût. L'index a
     * tranché, l'objectif est atteint : on relit et l'on rend le sien.
     */
    if (err?.code !== 11000) throw err;
    const gagnante = await PanelFinancialTransaction.findOne(clef).select('transactionId').lean();
    return gagnante?.transactionId ?? transactionId;
  }

  const ecrite = await PanelFinancialTransaction.findOne(clef).select('transactionId').lean();
  return ecrite?.transactionId ?? transactionId;
}

/**
 * CE QUE LA LIGNE DE COÛT DIT D'ELLE-MÊME.
 *
 * Elle nomme l'écriture de solde. C'est la seule information qui permette à un
 * exploitant de retrouver la ligne correspondante dans le tableau de bord
 * Stripe — et c'est la preuve, lisible dans le registre lui-même, que le
 * montant n'a pas été calculé ici.
 */
function descriptionDuFrais({ fait, settlement }) {
  const parts = [
    `Frais de paiement Stripe, relevés sur l’écriture de solde ${settlement.balanceTransactionId}.`,
  ];
  if (Number.isInteger(settlement.grossCents) && Number.isInteger(settlement.netCents)) {
    parts.push(`Brut ${settlement.grossCents} c — frais ${settlement.providerFeeCents} c = net ${settlement.netCents} c.`);
  }
  parts.push(`Encaissement ${fait.objectType} ${fait.objectId}.`);
  return parts.join(' ');
}

/* -------------------------------------------------------------------------- */
/*  CAPTURE                                                                   */
/* -------------------------------------------------------------------------- */

/** Inscrit l'observation sur le fait — SANS jamais écraser un `SETTLED`. */
async function inscrire(fait, patch, { incrementer = false } = {}) {
  if (!shouldReplaceSettlement(fait.settlement, patch)) return false;

  const set = {};
  for (const [clef, valeur] of Object.entries(patch)) set[`settlement.${clef}`] = valeur;
  set['settlement.observedAt'] = new Date();

  /**
   * LA CONDITION EST DANS LE FILTRE, PAS SEULEMENT DANS LE `if` CI-DESSUS.
   *
   * Entre la lecture du fait et cette écriture, une autre convergence a pu
   * inscrire un `SETTLED`. Le refuser en mémoire ne suffit donc pas : la
   * garantie doit vivre dans la base, exactement comme l'unicité des
   * mouvements. Un `findOne` suivi d'un `updateOne` sans condition est une
   * course, toujours.
   */
  const res = await PanelProviderRevenueFact.updateOne(
    { factId: fait.factId, 'settlement.status': { $ne: SETTLEMENT_STATUS.SETTLED } },
    { $set: set, ...(incrementer ? { $inc: { 'settlement.attempts': 1 } } : {}) },
  );
  return res.modifiedCount > 0;
}

/**
 * DONNE SON COÛT À UN ENCAISSEMENT PROUVÉ — ou explique pourquoi il n'en a pas.
 *
 * NE LÈVE JAMAIS. Le chemin qui mène ici part d'un webhook signé : une
 * exception y produirait une 500, donc un rejeu du fournisseur en boucle sur un
 * paiement parfaitement encaissé. Un frais manquant est un défaut réparable ;
 * un revenu perdu ne l'est pas.
 *
 * @param {string} factId
 * @param {{fetchImpl?: Function}} [options]
 */
export async function captureSettlementForFact(factId, { fetchImpl } = {}) {
  const rien = { outcome: null, factId, feeTransactionId: null, settlement: null, reason: null };
  try {
    const fait = await PanelProviderRevenueFact.findOne({ factId }).lean();
    if (!fait) return { ...rien, outcome: SETTLEMENT_OUTCOME.FAILED, reason: 'FACT_NOT_FOUND' };

    if (fait.projectionStatus !== PROJECTION_STATUS.PROJECTED || !fait.transactionId) {
      return { ...rien, outcome: SETTLEMENT_OUTCOME.NOT_PROJECTED };
    }

    /**
     * DÉJÀ SOLDÉ — le résultat NORMAL d'un rejeu, et il ne coûte pas un appel.
     *
     * C'est le garde-fou le plus rapide du module, et celui que traversent tous
     * les rejeux de webhook : un paiement dont les frais sont connus n'est
     * jamais réinterrogé, quel que soit le nombre d'annonces qui le suivent.
     *
     * ══ « SOLDÉ » NE SUFFIT PAS : IL FAUT AUSSI « COMPLET » ═════════════════
     *
     * Un encaissement peut porter ses chiffres et ne pas porter son IDENTITÉ de
     * règlement — c'est le cas de tous ceux qui ont été soldés avant que la
     * relecture de facture n'existe. Or le remboursement de L10.4 a besoin de
     * cette identité, et sans elle le Panel ne peut plus rendre l'argent.
     *
     * Un tel fait n'est donc pas « déjà fait » : il lui manque quelque chose de
     * réparable. On laisse passer, UNE fois — dès que l'intention est apprise,
     * ce garde-fou se referme pour toujours. Les montants, eux, ne bougeront
     * pas : `shouldReplaceSettlement` refuse de remplacer un `SETTLED`, et
     * l'index unique refuse une seconde charge.
     *
     * Un remboursement est exempté : son identité canonique EST son `re_…`, il
     * n'a aucune intention à apprendre.
     */
    const complet = fait.kind === FACT_KIND.REFUND
      || Boolean(fait.corroboration?.paymentIntentId);
    if (fait.settlement?.status === SETTLEMENT_STATUS.SETTLED && complet) {
      return {
        ...rien,
        outcome: SETTLEMENT_OUTCOME.ALREADY_SETTLED,
        feeTransactionId: fait.settlement.feeTransactionId ?? null,
        settlement: fait.settlement,
      };
    }

    /**
     * UN FAIT D'UN AUTRE MONDE NE SE SOLDE PAS ICI.
     *
     * Les identifiants de recette et de production sont deux comptes Stripe
     * distincts. Interroger l'un avec les clés de l'autre rendrait `NOT_FOUND`
     * au mieux, et au pire une écriture homonyme — donc un frais attribué au
     * mauvais encaissement. On refuse, en le nommant.
     */
    if (fait.environment !== runtimeEnvironment()) {
      await inscrire(fait, {
        status: SETTLEMENT_STATUS.UNAVAILABLE,
        reason: SETTLEMENT_REASON.ENVIRONMENT_MISMATCH,
        provider: PROVIDER,
      });
      return { ...rien, outcome: SETTLEMENT_OUTCOME.UNAVAILABLE, reason: SETTLEMENT_REASON.ENVIRONMENT_MISMATCH };
    }

    if ((fait.settlement?.attempts ?? 0) >= MAX_TENTATIVES_SETTLEMENT) {
      return { ...rien, outcome: SETTLEMENT_OUTCOME.ABANDONED };
    }

    const reference = settlementReferenceOf(fait);
    if (!reference) {
      /**
       * LE COMPTEUR MONTE, MÊME SANS APPEL — et c'est ce qui borne la file.
       *
       * `UNAVAILABLE` est réexaminé à chaque cycle depuis que la recette a
       * montré qu'un tel verdict pouvait devenir faux. Sans incrémenter ici, un
       * fait sans aucune référence resterait dans la file pour l'éternité, et
       * l'ordonnanceur le relirait toutes les heures sans fin.
       */
      await inscrire(fait, {
        status: SETTLEMENT_STATUS.UNAVAILABLE,
        reason: SETTLEMENT_REASON.NO_PAYMENT_REFERENCE,
        provider: PROVIDER,
      }, { incrementer: true });
      return { ...rien, outcome: SETTLEMENT_OUTCOME.UNAVAILABLE, reason: SETTLEMENT_REASON.NO_PAYMENT_REFERENCE };
    }

    /* ── L'APPEL ─────────────────────────────────────────────────────────── */
    /**
     * `PANEL_SELF`, ET C'EST LA BONNE SOURCE.
     *
     * `PANEL_INTERNAL` serait « le Panel agissant POUR un projet » — c'est le
     * remboursement, qui touche l'argent d'un client. Ici, le Panel lit SON
     * PROPRE registre de solde : combien Stripe lui a prélevé. Le projet n'est
     * pas le périmètre, et lui faire porter l'appel ferait dépendre la lecture
     * d'une fiche projet qui peut avoir été retirée depuis l'encaissement.
     */
    let vue;
    try {
      const resultat = await invokeCapability({
        code: CAPABILITY,
        source: INVOCATION_SOURCES.PANEL_SELF,
        payload: reference,
        fetchImpl,
      });
      vue = resultat?.result ?? null;
    } catch (err) {
      const message = err?.message ?? 'erreur inconnue';
      await inscrire(fait, { lastError: String(message).slice(0, 300), provider: PROVIDER }, { incrementer: true });
      logger.warn(
        `[finance] frais non relevés pour ${maskResourceId(fait.objectId)} (${fait.environment}) — `
        + `${message}. Le revenu, lui, est écrit.`,
      );
      return { ...rien, outcome: SETTLEMENT_OUTCOME.FAILED, reason: err?.code ?? 'CAPABILITY_FAILED' };
    }

    if (!vue || vue.status !== SETTLEMENT_STATUS.SETTLED) {
      const status = vue?.status ?? SETTLEMENT_STATUS.PENDING;
      await inscrire(fait, {
        status,
        reason: vue?.reason ?? null,
        provider: PROVIDER,
        balanceTransactionId: vue?.balanceTransactionId ?? null,
        chargeId: vue?.chargeId ?? null,
        lastError: null,
      }, { incrementer: true });
      return {
        ...rien,
        outcome: status === SETTLEMENT_STATUS.PENDING
          ? SETTLEMENT_OUTCOME.PENDING
          : (status === SETTLEMENT_STATUS.UNAVAILABLE
            ? SETTLEMENT_OUTCOME.UNAVAILABLE : SETTLEMENT_OUTCOME.UNUSABLE),
        reason: vue?.reason ?? null,
      };
    }

    /**
     * LA DEVISE — le registre est monodevise depuis L10.1, et l'agrégateur ne
     * somme jamais deux devises. Un frais dans une devise non gérée est donc
     * OBSERVÉ mais NON écrit : le convertir exigerait un taux, une date et une
     * politique d'arrondi qu'aucun écran ne pose.
     */
    if (!vue.currency || !SUPPORTED_CURRENCIES.includes(vue.currency)) {
      await inscrire(fait, {
        status: SETTLEMENT_STATUS.UNUSABLE,
        reason: SETTLEMENT_REASON.CURRENCY_UNSUPPORTED,
        provider: PROVIDER,
        balanceTransactionId: vue.balanceTransactionId,
        currency: vue.currency ?? null,
      }, { incrementer: true });
      return { ...rien, outcome: SETTLEMENT_OUTCOME.UNUSABLE, reason: SETTLEMENT_REASON.CURRENCY_UNSUPPORTED };
    }

    /**
     * ── LE FAIT APPREND CE QUE LA RELECTURE A DÉCOUVERT ──────────────────────
     *
     * ══ CE DÉFAUT-LÀ N'EST PAS CELUI DE CE LOT, ET LE CORRIGER EST GRATUIT ══
     *
     * Un `invoice.paid` récent ne porte plus d'intention de paiement (voir
     * `settlementReferenceOf`). Ce n'est pas seulement la capture des frais qui
     * en souffrait : le REMBOURSEMENT de L10.4 exige cette intention, et la
     * recette déployée a répondu `PANEL_REFUND_NO_PAYMENT_INTENT` sur un
     * paiement parfaitement encaissé. Le Panel ne pouvait plus rendre l'argent.
     *
     * La capture, elle, vient précisément de la retrouver. L'inscrire sur le
     * fait répare le remboursement sans toucher une ligne de L10.4 : le fait
     * gagne simplement l'identité qui lui manquait, et tous ses lecteurs en
     * profitent.
     *
     * ══ POURQUOI C'EST LÉGITIME AU REGARD DE LA DOCTRINE ════════════════════
     *
     * L10.3 range les IDENTITÉS parmi les champs « enrichissables », par
     * opposition aux MONTANTS, figés à la première annonce. Une identité
     * absente qui apparaît est une convergence ; un montant qui change serait
     * une réécriture. On n'écrase donc jamais une valeur existante — on ne
     * remplit qu'un vide.
     */
    /**
     * UNE RELECTURE QUI N'APPREND RIEN DOIT COMPTER, sans quoi un fait
     * définitivement muet reviendrait dans la file toutes les heures, pour
     * toujours. Le compteur est le seul frein — ici comme ailleurs.
     */
    if (!vue.paymentIntentId && !fait.corroboration?.paymentIntentId
      && fait.kind !== FACT_KIND.REFUND) {
      await PanelProviderRevenueFact.updateOne(
        { factId }, { $inc: { 'settlement.attempts': 1 } },
      ).catch(() => null);
    }

    if (vue.paymentIntentId && !fait.corroboration?.paymentIntentId) {
      await PanelProviderRevenueFact.updateOne(
        { factId, 'corroboration.paymentIntentId': null },
        { $set: { 'corroboration.paymentIntentId': vue.paymentIntentId } },
      ).catch(() => null);
    }
    if (vue.chargeId && !fait.corroboration?.chargeId) {
      await PanelProviderRevenueFact.updateOne(
        { factId, 'corroboration.chargeId': null },
        { $set: { 'corroboration.chargeId': vue.chargeId } },
      ).catch(() => null);
    }

    const revenu = await PanelFinancialTransaction
      .findOne({ transactionId: fait.transactionId })
      .select('transactionId projectId projectNameSnapshot clientCompanyId label effectiveDate currency flow')
      .lean();
    if (!revenu) {
      return { ...rien, outcome: SETTLEMENT_OUTCOME.NOT_PROJECTED, reason: 'TRANSACTION_MISSING' };
    }

    const mouvement = feeMovementOf({ fait, providerFeeCents: vue.providerFeeCents });
    /**
     * L'ORDRE EST : LE MOUVEMENT D'ABORD, L'OBSERVATION ENSUITE.
     *
     * Si l'on inscrivait `SETTLED` avant d'écrire le coût, une coupure entre
     * les deux laisserait un fait qui se dit soldé sans que la charge existe —
     * et le garde-fou du haut interdirait pour toujours de la rattraper. Dans
     * l'ordre inverse, une coupure laisse au pire un coût écrit et un fait qui
     * réessaiera : le second passage retrouve la ligne par son index unique,
     * n'en crée pas de seconde, et achève l'inscription.
     */
    const feeTransactionId = mouvement
      ? await upsertFeeTransaction({ fait, revenu, settlement: vue, mouvement })
      : null;

    await inscrire(fait, {
      status: SETTLEMENT_STATUS.SETTLED,
      reason: null,
      provider: PROVIDER,
      balanceTransactionId: vue.balanceTransactionId,
      grossCents: vue.grossCents,
      providerFeeCents: vue.providerFeeCents,
      netCents: vue.netCents,
      currency: vue.currency,
      providerType: vue.providerType,
      reportingCategory: vue.reportingCategory,
      providerStatus: vue.providerStatus,
      availableOn: Number.isFinite(vue.availableOn) ? new Date(vue.availableOn * 1000) : null,
      chargeId: vue.chargeId,
      exchangeRate: vue.exchangeRate,
      feeDetails: Array.isArray(vue.feeDetails) ? vue.feeDetails : [],
      feeTransactionId,
      lastError: null,
    });

    logger.info(
      `[finance] encaissement soldé — ${fait.objectType} ${maskResourceId(fait.objectId)} `
      + `(${fait.environment}) : brut ${vue.grossCents} c, frais ${vue.providerFeeCents} c, `
      + `net ${vue.netCents} c${feeTransactionId ? ' — charge écrite' : ' — aucun frais, aucune charge'}.`,
    );

    return {
      outcome: SETTLEMENT_OUTCOME.SETTLED,
      factId,
      feeTransactionId,
      settlement: vue,
      reason: null,
    };
  } catch (err) {
    logger.warn(
      `[finance] capture des frais impossible pour ${factId} — `
      + `${err?.message ?? 'erreur inconnue'}. Le revenu, lui, est écrit.`,
    );
    return { ...rien, outcome: SETTLEMENT_OUTCOME.FAILED, reason: 'UNEXPECTED' };
  }
}

/* -------------------------------------------------------------------------- */
/*  CONVERGENCE                                                               */
/* -------------------------------------------------------------------------- */

/**
 * LA FILE DES ENCAISSEMENTS SANS COÛT — reprise à chaque cycle.
 *
 * ══ POURQUOI CETTE CONVERGENCE EST INDISPENSABLE, ET PAS UN CONFORT ═════════
 *
 * Trois cas la rendent nécessaire, et le premier est le cas NOMINAL :
 *
 *  1. LES PAIEMENTS D'AVANT CE LOT. Tous les revenus déjà projetés n'ont aucune
 *     observation. Ils entrent dans cette file au premier cycle, et leur coût
 *     est rattrapé sans qu'aucune migration n'ait à réécrire quoi que ce soit.
 *
 *  2. LES ÉCRITURES DE SOLDE DIFFÉRÉES. Un prélèvement ou un virement n'a pas
 *     de `balance_transaction` le jour du paiement. Le fait est `PENDING`, et il
 *     le reste jusqu'à ce que Stripe arrête ses comptes.
 *
 *  3. LES REDÉMARRAGES. Un Panel arrêté entre l'encaissement et la capture
 *     reprend ici, sans mémoire à reconstituer : tout ce qu'il faut savoir est
 *     inscrit sur le fait.
 *
 * ══ ELLE NE S'ARRÊTE PAS AU PREMIER ÉCHEC ═══════════════════════════════════
 *
 * Chaque fait est indépendant : un paiement illisible ne doit pas empêcher les
 * quatre-vingt-dix-neuf autres d'être soldés. Le compteur de tentatives, lui,
 * finit par sortir un fait mort de la file — voir `MAX_TENTATIVES_SETTLEMENT`.
 */
export async function convergePendingSettlements({ limit = 100, fetchImpl } = {}) {
  const borne = Math.min(Math.max(1, Number(limit) || 100), 500);

  const candidats = await PanelProviderRevenueFact.find({
    projectionStatus: PROJECTION_STATUS.PROJECTED,
    transactionId: { $ne: null },
    environment: runtimeEnvironment(),
    /**
     * `null`, `PENDING` et `UNAVAILABLE` — mais PAS `UNUSABLE`.
     *
     * ══ POURQUOI `UNAVAILABLE` REVIENT DANS LA FILE ═════════════════════════
     *
     * Il a d'abord été exclu, avec une raison qui semblait bonne : « il n'y a
     * rien à attendre ». La recette réelle a montré que c'était faux — et de la
     * pire façon, celle qui ne lève aucune erreur.
     *
     * Un `invoice.paid` du compte de recette ne porte, dans sa version d'API,
     * NI `charge`, NI `payment_intent`, NI `payments.data`. Le verdict
     * `NO_PAYMENT_REFERENCE` était donc exact au moment où il a été rendu, et
     * il est devenu faux dès qu'une voie de résolution supplémentaire a existé.
     * Exclu de la file, il aurait figé une commission manquante pour toujours,
     * en silence.
     *
     * Un verdict n'est vrai que pour le code qui l'a produit. Ce qui borne
     * réellement le coût n'est pas le statut, c'est le COMPTEUR DE TENTATIVES —
     * il est là pour ça, et il suffit.
     *
     * `UNUSABLE` reste dehors : une devise non gérée ne dépend d'aucune
     * résolution, elle dépend d'une décision comptable que ce lot n'a pas prise.
     */
    $or: [
      { 'settlement.status': null },
      { 'settlement.status': { $exists: false } },
      { 'settlement.status': SETTLEMENT_STATUS.PENDING },
      { 'settlement.status': SETTLEMENT_STATUS.UNAVAILABLE },
      /**
       * ── ET LES SOLDÉS QUI NE SONT PAS COMPLETS ──────────────────────────
       *
       * Un encaissement peut porter ses chiffres et pas son IDENTITÉ de
       * règlement : c'est le cas de tous ceux qui ont été soldés avant que la
       * relecture de facture n'existe. Sans eux dans cette file, la réparation
       * n'aurait touché que les paiements FUTURS — et le remboursement serait
       * resté impossible sur ceux qui existent déjà, c'est-à-dire exactement
       * ceux dont un client peut réclamer l'argent.
       *
       * Un remboursement en est exempté : son identité canonique EST son
       * `re_…`, il n'a aucune intention à apprendre.
       */
      {
        'settlement.status': SETTLEMENT_STATUS.SETTLED,
        'corroboration.paymentIntentId': null,
        kind: { $ne: FACT_KIND.REFUND },
      },
    ],
    'settlement.attempts': { $lt: MAX_TENTATIVES_SETTLEMENT },
  })
    .sort({ occurredAt: -1 })
    .limit(borne)
    .select('factId')
    .lean();

  let settled = 0;
  let pending = 0;
  for (const candidat of candidats) {
    // eslint-disable-next-line no-await-in-loop
    const resultat = await captureSettlementForFact(candidat.factId, { fetchImpl });
    if (resultat.outcome === SETTLEMENT_OUTCOME.SETTLED) settled += 1;
    else if (resultat.outcome === SETTLEMENT_OUTCOME.PENDING) pending += 1;
  }

  return { examined: candidats.length, settled, pending };
}

/* -------------------------------------------------------------------------- */
/*  LECTURE                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * L'ENCAISSEMENT NET D'UNE PAGE DE MOUVEMENTS — une requête, jamais N+1.
 *
 * ══ POURQUOI C'EST UNE JOINTURE ET NON UN CHAMP ═════════════════════════════
 *
 * Même raison que l'état de remboursement (L10.4) et que le descripteur de
 * justificatif (L10.2) : ce n'est pas une propriété du mouvement, c'est une
 * OBSERVATION qui vit à côté. La recopier sur la transaction en ferait une
 * seconde vérité, qui divergerait au premier rejeu.
 *
 * ══ LE READ-MODEL EST GÉNÉRIQUE, ET C'EST VOULU ═════════════════════════════
 *
 * `provider`, `providerCostCents`, `grossCents`, `netCents`. Aucun champ ne
 * s'appelle `stripe…` : le jour où un second fournisseur de paiement entrera,
 * l'écran Finances n'aura pas à être refait. Le nom du fournisseur est une
 * VALEUR, pas une clé.
 *
 * ══ AUCUN APPEL FOURNISSEUR ═════════════════════════════════════════════════
 *
 * Tout vient de la base. Un écran financier ne parle jamais à Stripe — la règle
 * centrale de L10.3, et ce lot ne l'entame pas.
 */
export async function withSettlement(transactions = []) {
  if (!Array.isArray(transactions) || transactions.length === 0) return transactions;

  /**
   * Seuls les mouvements FOURNISSEUR ont un encaissement à décrire — et pas
   * les lignes de coût elles-mêmes, qui SONT le frais : leur en attacher un
   * ferait lire « frais du frais ».
   */
  const concernes = new Set(transactions.filter((t) => (
    t?.origin === ORIGINS.STRIPE
    && t?.provenance?.externalId
    && t.provenance.externalKind !== PROVIDER_FEE_EXTERNAL_KIND
  )));
  if (concernes.size === 0) return transactions;

  const faits = await PanelProviderRevenueFact.find({
    provider: PROVIDER,
    objectId: { $in: [...new Set([...concernes].map((t) => t.provenance.externalId))] },
  })
    .select('objectId objectType environment settlement fiscal')
    .lean();

  /** La clé complète — un identifiant de recette et son homonyme de production
   * sont deux faits distincts, et jamais l'un ne doit répondre pour l'autre. */
  const clef = (environment, objectType, objectId) => `${environment} ${objectType} ${objectId}`;
  const par = new Map(faits.map((f) => [clef(f.environment, f.objectType, f.objectId), f]));

  return transactions.map((t) => {
    if (!concernes.has(t)) return t;
    const fait = par.get(clef(t.provenance.environment, t.provenance.externalKind, t.provenance.externalId));
    if (!fait) return t;
    return { ...t, settlement: publicSettlement(fait, t), fiscal: publicFiscal(fait) };
  });
}

/**
 * LA PROJECTION PUBLIQUE D'UN ENCAISSEMENT.
 *
 * ══ `grossCents` VIENT DU REGISTRE, PAS DE STRIPE ═══════════════════════════
 *
 * Le brut affiché est celui du MOUVEMENT — ce que le registre a inscrit, et ce
 * que tous les totaux comptent. Reprendre celui de l'observation ferait
 * afficher, sur un remboursement, le montant négatif tel que Stripe le voit,
 * alors que la doctrine du registre veut un montant positif porté par `flow`.
 * Deux nombres pour la même chose finissent toujours par diverger.
 *
 * Stripe reste l'autorité de ce qu'il a PRÉLEVÉ ; le registre reste l'autorité
 * de ce qui a été ENCAISSÉ.
 */
function publicSettlement(fait, transaction) {
  const s = fait.settlement ?? {};
  const status = s.status ?? SETTLEMENT_STATUS.PENDING;
  const solde = status === SETTLEMENT_STATUS.SETTLED;
  const frais = solde && Number.isInteger(s.providerFeeCents) ? Math.abs(s.providerFeeCents) : null;

  /**
   * LE SENS DÉCIDE DE L'OPÉRATION, ET C'EST TOUT SAUF UN DÉTAIL.
   *
   * Sur un ENCAISSEMENT, le fournisseur RETIENT sa commission : le compte reçoit
   * `brut − frais`.
   *
   * Sur un REMBOURSEMENT, il la PRÉLÈVE EN PLUS de la somme rendue : le compte
   * perd `rendu + frais`. Appliquer la même soustraction aurait affiché un coût
   * inférieur à la somme réellement sortie — et le seul cas où l'erreur se voit
   * est celui où le fournisseur facture un remboursement, c'est-à-dire le cas
   * qu'on ne rencontre jamais en recette et toujours en production.
   *
   * Le sens vient du MOUVEMENT, pas du signe rendu par le fournisseur : c'est la
   * doctrine du registre depuis L10.1, et elle vaut ici comme ailleurs.
   */
  const entree = transaction.flow === FLOWS.INFLOW;

  return {
    status,
    reason: s.reason ?? null,
    provider: s.provider ?? PROVIDER,
    /** `IN` : le fournisseur retient. `OUT` : il prélève en plus. */
    direction: entree ? 'IN' : 'OUT',
    /** Ce que le registre a inscrit — l'autorité du montant du mouvement. */
    grossCents: transaction.amountCents,
    /** Ce que le fournisseur a prélevé. `null` tant qu'il ne l'a pas dit. */
    providerCostCents: frais,
    /** DÉRIVÉ, jamais stocké : c'est la définition du net, pas une valeur. */
    netCents: frais === null
      ? null
      : (entree ? transaction.amountCents - frais : transaction.amountCents + frais),
    currency: s.currency ?? transaction.currency,
    /** La preuve, pour qui veut rapprocher du tableau de bord fournisseur. */
    balanceTransactionId: s.balanceTransactionId ?? null,
    /** Le mouvement de charge produit. `null` si le frais était nul. */
    providerCostTransactionId: s.feeTransactionId ?? null,
    /** `pending` | `available` — quand le fournisseur libère les fonds. */
    providerStatus: s.providerStatus ?? null,
    availableOn: s.availableOn ? new Date(s.availableOn).toISOString() : null,
    feeDetails: Array.isArray(s.feeDetails)
      ? s.feeDetails.map((d) => ({
        type: d.type ?? null,
        description: d.description ?? null,
        amountCents: Number.isInteger(d.amountCents) ? Math.abs(d.amountCents) : null,
        currency: d.currency ?? null,
      }))
      : [],
  };
}

/** HT / TVA / TTC du document fournisseur. `null` quand il n'en a pas ventilé. */
function publicFiscal(fait) {
  const f = fait.fiscal ?? {};
  if (!Number.isInteger(f.grossIncludingTaxCents)) return null;
  return {
    netExcludingTaxCents: f.netExcludingTaxCents ?? null,
    taxCents: f.taxCents ?? null,
    grossIncludingTaxCents: f.grossIncludingTaxCents,
    source: f.source ?? null,
  };
}

export default {
  SETTLEMENT_OUTCOME,
  PROVIDER_FEE_EXTERNAL_KIND,
  MAX_TENTATIVES_SETTLEMENT,
  shouldReplaceSettlement,
  settlementReferenceOf,
  feeMovementOf,
  captureSettlementForFact,
  convergePendingSettlements,
  withSettlement,
};
