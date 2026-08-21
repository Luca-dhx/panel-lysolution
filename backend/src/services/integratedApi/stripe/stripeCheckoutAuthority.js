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

import logger from '../../../utils/logger.js';
import { PanelProjectContract } from '../../../models/PanelProjectProjection.model.js';
import { FiscalLineError, readFiscalLine } from '../../contract/contractFiscalLine.js';
import { resolveClientCompanyReadiness } from '../../clientCompany/clientCompanyReadiness.js';

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
  /**
   * L10.5 — UN SEUL MOTIF POUR TOUTES LES PRESTATIONS REFUSÉES.
   *
   * Inconnue, appartenant à un autre projet, déjà payée, annulée, ou d'un autre
   * monde : cinq causes, un seul code et un seul message. Les distinguer
   * apprendrait à un projet que la demande d'un autre existe — exactement ce que
   * la doctrine de refus indistinct de L6.2A interdit.
   *
   * La cause réelle n'est pas perdue : elle est journalisée côté Panel, où
   * l'exploitant la lit, et où le projet ne la lit pas.
   */
  SERVICE_NOT_PAYABLE: 'SERVICE_NOT_PAYABLE',
  /**
   * AUCUNE IDENTITÉ LÉGALE DE CLIENT — la garde absolue du chantier.
   *
   * ══ POURQUOI ELLE EST ICI, ET PAS SEULEMENT DANS L'INTERFACE ═════════════
   *
   * Le Manager d'un projet masque déjà le bouton quand l'entreprise est
   * incomplète. Une interface n'est pas une barrière : la route existe, le
   * jeton de pont aussi, et un appel direct suffirait à ouvrir un paiement.
   *
   * Ce refus est BACKEND et AUTORITATIF. Il tombe AVANT tout contact
   * fournisseur : aucune session, aucun client, aucune trace chez Stripe.
   *
   * ══ POURQUOI IL EST NOMMÉ, CONTRAIREMENT AUX AUTRES ══════════════════════
   *
   * La doctrine d'indistinction protège contre un ORACLE — un projet ne doit
   * pas apprendre le parc en comparant des refus. Ici, le projet interroge SA
   * propre situation : la réponse ne parle que de lui, et elle est la seule qui
   * soit ACTIONNABLE. « Refusé » sans motif enverrait chercher une panne
   * Stripe ; ce code-ci envoie compléter une fiche.
   */
  CLIENT_COMPANY_NOT_READY: 'CLIENT_COMPANY_NOT_READY',
  /**
   * LA VENTILATION FISCALE MANQUE OU NE S'ADDITIONNE PAS.
   *
   * Distinct de `PRICE_ABSENT`, qui dit « aucun montant ». Ici il y a un
   * montant, mais on ne sait pas dire combien de TVA il contient — et une
   * facture qui ne le dit pas ne remplit pas ses mentions obligatoires.
   * Voir `contractFiscalLine.js` pour l'arbitrage complet.
   */
  TAX_BREAKDOWN_UNUSABLE: 'CONTRACT_TAX_BREAKDOWN_UNUSABLE',
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
/**
 * Lecture par défaut d'une demande de paiement. Injectable, comme le contrat.
 *
 * L'import est DYNAMIQUE : ce module appartient au plan de contrôle Stripe, et
 * le charger ne doit pas tirer tout le domaine financier dans son graphe. Il
 * consulte une autorité métier, il n'en dépend pas.
 */
async function defaultLookupPaymentRequest(args) {
  const { resolveServiceAmount } = await import(
    '../../finance/paymentRequests/paymentRequests.service.js'
  );
  return resolveServiceAmount(args);
}

export async function resolveCheckoutIntent({
  projectId, environment, input,
  lookupContract = defaultLookupContract,
  lookupPaymentRequest = defaultLookupPaymentRequest,
  lookupClientCompany = resolveClientCompanyReadiness,
}) {
  /**
   * ── BARRIÈRE ZÉRO : Y A-T-IL UN CLIENT LÉGAL ? ───────────────────────────
   *
   * ══ POURQUOI ELLE PRÉCÈDE TOUT LE RESTE ═══════════════════════════════════
   *
   * Elle vaut pour LES TROIS types de paiement — frais de lancement,
   * abonnement, prestation ponctuelle — parce qu'ils produisent tous une
   * FACTURE, et qu'une facture sans destinataire identifié n'est pas une
   * facture. La placer plus bas aurait obligé à la recopier trois fois, et le
   * troisième exemplaire aurait fini par diverger.
   *
   * Elle précède aussi la lecture du contrat, et c'est délibéré : « votre
   * entreprise n'est pas renseignée » est une réponse utile, alors que
   * « contrat introuvable » sur un projet dont le contrat existe parfaitement
   * enverrait chercher au mauvais endroit.
   *
   * NO CLIENT COMPANY → NO PAYMENT. Aucune exception, aucun mode dégradé.
   */
  const readiness = await lookupClientCompany({ projectId });
  if (!readiness.billing.ready) {
    throw new CheckoutAuthorityError(
      CHECKOUT_REFUSALS.CLIENT_COMPANY_NOT_READY,
      readiness.state === 'MISSING_COMPANY'
        ? 'Aucune entreprise cliente n’est rattachée à ce projet : aucun paiement ne peut être '
          + 'ouvert tant que l’identité légale du client n’est pas renseignée.'
        : 'L’entreprise cliente rattachée à ce projet est incomplète : '
          + `${readiness.billing.missing.join(', ')}.`,
    );
  }

  /**
   * ── LA PRESTATION PONCTUELLE (L10.5) ────────────────────────────────────
   *
   * Elle sort AVANT toute lecture de contrat, parce qu'elle n'en a pas. La
   * traiter plus bas aurait obligé à rendre facultatif le refus
   * `CONTRACT_NOT_OWNED`, c'est-à-dire à percer la garde qui protège les
   * paiements contractuels.
   */
  if (input.paymentType === 'SERVICE') {
    return resolveServiceIntent({ projectId, environment, input, lookupPaymentRequest });
  }

  /**
   * L'ABONNEMENT EST SERVI DEPUIS L6.2E.
   *
   * Il était refusé ici tant qu'une session `mode: subscription` aurait
   * référencé un client et un tarif créés avec la clé du PROJET pendant que la
   * session partait avec celle du Panel — deux comptes possibles, et un échec
   * devant un client qui paie.
   *
   * Le Panel possède désormais les deux : `billing.customer.ensure` (L6.2D) et
   * `billing.price.ensure` (L6.2E). La session peut donc être construite
   * entièrement de son côté — c'est l'adaptateur qui compose les trois actes.
   */
  const projection = await lookupContract(projectId);
  const contractId = projection?.sourceContractId ?? null;

  // Un seul refus pour « aucun contrat » et « pas celui-là » : voir le §refus.
  if (!projection || !contractId || contractId !== String(input.contractRef)) {
    throw new CheckoutAuthorityError(
      CHECKOUT_REFUSALS.CONTRACT_NOT_OWNED,
      'Aucun contrat de ce projet ne correspond à cette référence.',
    );
  }

  const reference = projection.reference ?? null;
  const metadata = buildMetadata({ projectId, environment, contractId, input });

  /**
   * ── L'ABONNEMENT : LES TERMES SONT DÉJÀ FIGÉS DANS UN PRICE ───────────────
   *
   * Une session d'abonnement ne porte PAS de montant : elle référence un Price,
   * qui les porte et qui est immuable. C'est même préférable à `price_data`
   * inline — un tarif nommé se retrouve dans le catalogue Stripe, se rapproche
   * d'une facture, et ne peut pas dériver d'une session à l'autre.
   *
   * Le client et le tarif ne sont pas connus ICI : ils sont garantis par
   * l'adaptateur, qui compose les trois actes. On rend donc une fabrique plutôt
   * que des paramètres fermés — c'est la seule façon d'écrire l'ordre
   * « d'abord les ressources, ensuite la session » sans le dupliquer.
   */
  if (input.paymentType === 'SUBSCRIPTION') {
    /**
     * LE TAUX DE L'ABONNEMENT EST RÉSOLU ICI, PAS DANS LE PRICE.
     *
     * Un `Price` Stripe porte un montant et une périodicité ; il ne porte pas
     * de taux. La taxe s'applique au niveau de l'ABONNEMENT
     * (`subscription_data.default_tax_rates`), et il faut donc connaître le
     * taux au moment de composer la session — pas seulement au moment de créer
     * le tarif.
     *
     * On le lit à la même source que le montant, et l'on refuse aux mêmes
     * conditions : un abonnement dont on ne sait pas dire la TVA produirait des
     * factures récurrentes muettes, mois après mois.
     */
    const fiscal = lireVentilation(
      projection.pricing?.subscription,
      projection.taxRate,
      'l’abonnement',
    );
    return {
      contractId,
      reference,
      /** Le montant vit dans le Price. Aucun chiffre ne transite par la session. */
      amountIncludingTax: null,
      currency: null,
      /** La ventilation voyage pour que l'adaptateur garantisse le bon taux. */
      fiscal,
      paramsFor: ({ customerId, priceId, taxRateId }) => ({
        mode: 'subscription',
        customer: customerId,
        line_items: [{ price: priceId, quantity: 1 }],
        success_url: input.successUrl,
        cancel_url: input.cancelUrl,
        metadata,
        /**
         * Les metadata sont RECOPIÉES sur l'abonnement lui-même : les
         * événements `customer.subscription.*` et `invoice.*` ne les héritent
         * pas de la session, et sans elles un webhook d'abonnement arriverait
         * sans aucun rattachement lisible.
         */
        subscription_data: {
          metadata,
          /**
           * LE TAUX S'APPLIQUE À L'ABONNEMENT, ET DONC À CHAQUE FACTURE QU'IL
           * ÉMETTRA — y compris celles de l'an prochain, qu'aucun code ne
           * repassera composer. Le poser sur la seule première session aurait
           * produit une facture correcte suivie d'une série de factures muettes.
           */
          ...(taxRateId ? { default_tax_rates: [taxRateId] } : {}),
        },
      }),
    };
  }

  const fiscal = lireVentilation(
    projection.pricing?.launchFee,
    projection.taxRate,
    'les frais de lancement',
  );

  return {
    contractId,
    reference,
    /** Ce que le client débitera — inchangé par ce chantier. */
    amountIncludingTax: fiscal.grossCents,
    currency: fiscal.currency,
    fiscal,
    /**
     * LES PARAMÈTRES SE FERMENT SUR LE TAUX — comme l'abonnement se ferme sur
     * son client et son tarif. L'adaptateur garantit le `TaxRate` chez le
     * fournisseur, puis appelle cette fabrique : c'est la seule façon d'écrire
     * « d'abord la ressource, ensuite la session » sans dupliquer l'ordre.
     */
    paramsFor: ({ taxRateId }) => ({
      mode: 'payment',
      line_items: [
        {
          price_data: {
            currency: fiscal.currency.toLowerCase(),
            product_data: {
              name: `Frais de lancement — ${reference || contractId}`,
              description: 'Paiement unique — frais de lancement du site',
            },
            /**
             * ── LE MONTANT ENVOYÉ EST LE HORS TAXE ────────────────────────
             *
             * ══ CE QUI CHANGE, ET CE QUI NE CHANGE PAS ══════════════════════
             *
             * Ce qui NE CHANGE PAS : ce que le client débite. `HT + TVA = TTC`
             * a été VÉRIFIÉ (`readFiscalLine`), et Stripe recalcule la TVA à
             * partir du même HT et du même taux. Le total reste au centime ce
             * que le contrat annonce.
             *
             * Ce qui CHANGE : la facture SAIT désormais ce qu'elle contient.
             * Envoyer le TTC sans taxe déclarée produisait « 95,99 / 95,99 /
             * 95,99 » — trois fois le même nombre et aucune mention de TVA.
             *
             * L'ordre est indissociable : `unit_amount` HORS TAXE **et**
             * `tax_rates` EXCLUSIF. L'un sans l'autre est une erreur de
             * facturation — HT seul sous-facture de la TVA, TTC avec taxe
             * exclusive sur-facture d'autant.
             */
            unit_amount: fiscal.netCents,
          },
          quantity: 1,
          ...(taxRateId ? { tax_rates: [taxRateId] } : {}),
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
      invoice_creation: {
        enabled: true,
        invoice_data: {
          metadata,
          /**
           * ── LA RÉFÉRENCE DE CONTRAT, À SA PLACE ────────────────────────
           *
           * Elle figurait en guise de RAISON SOCIALE du client, ce qui était la
           * faute de tout ce chantier. Elle reste indispensable — c'est par
           * elle qu'un client rapproche une facture de son engagement — mais
           * comme RÉFÉRENCE COMMERCIALE.
           *
           * Stripe imprime les `custom_fields` en tête de facture, à côté du
           * numéro. C'est exactement l'emplacement d'un numéro de commande.
           *
           * Le champ est OMIS quand aucune référence n'existe : Stripe refuse
           * une valeur vide, et un champ « Contrat : » sans valeur se lirait
           * comme une donnée perdue.
           */
          ...(reference
            ? { custom_fields: [{ name: 'Contrat', value: String(reference).slice(0, 30) }] }
            : {}),
        },
      },
    }),
  };
}

/**
 * LIT la ventilation d'une ligne, et TRADUIT le refus dans le vocabulaire du
 * checkout.
 *
 * ══ POURQUOI UNE TRADUCTION, ET NON UNE PROPAGATION ═════════════════════════
 *
 * `FiscalLineError` appartient au domaine du contrat ; la passerelle de
 * capacités, elle, ne sait traiter que des `CheckoutAuthorityError`. Laisser
 * passer l'autre produirait une erreur non typée — donc une 500 devant un
 * client qui paie, là où le problème est une projection incomplète.
 *
 * Le motif RÉEL part au journal ; le projet reçoit un code stable et un message
 * qui dit quoi faire.
 */
function lireVentilation(ligne, contractTaxRate, label) {
  const gross = Number(ligne?.amountIncludingTax ?? 0);
  const currency = String(ligne?.currency ?? '').trim();

  /**
   * L'ABSENCE PURE ET SIMPLE reste `PRICE_ABSENT` — le motif historique. Une
   * projection sans montant n'est pas un problème de TVA : c'est un contrat
   * dont la ligne n'est pas activée, et le distinguer évite d'envoyer un
   * exploitant chercher une ventilation là où il n'y a rien à ventiler.
   */
  if (!Number.isInteger(gross) || gross <= 0 || !currency) {
    throw new CheckoutAuthorityError(
      CHECKOUT_REFUSALS.PRICE_ABSENT,
      `La projection de contrat ne porte pas ${label} de façon exploitable.`,
    );
  }

  try {
    return readFiscalLine(ligne, { contractTaxRate, label });
  } catch (err) {
    if (err instanceof FiscalLineError) {
      logger.warn(`[stripe-checkout] ventilation fiscale refusée — ${err.reason} : ${err.message}`);
      throw new CheckoutAuthorityError(CHECKOUT_REFUSALS.TAX_BREAKDOWN_UNUSABLE, err.message);
    }
    throw err;
  }
}

/**
 * UNE PRESTATION PONCTUELLE — le montant vient du Panel, jamais de l'appelant.
 *
 * ══ POURQUOI `mode: payment` ET PAS UNE FACTURE STRIPE ══════════════════════
 *
 * Le besoin métier parle de « facture », et l'on pourrait croire qu'il faut
 * l'API Invoice de Stripe — créer un brouillon, le finaliser, l'envoyer,
 * attendre son règlement. Ce serait TROIS actes fournisseur là où il en faut
 * un, trois capacités à contractualiser, et trois états de plus à faire
 * converger.
 *
 * Ce n'est pas nécessaire : `invoice_creation` fait émettre à Stripe une VRAIE
 * facture au moment du paiement, avec son numéro, sa page hébergée et son PDF.
 * Le client obtient exactement le document attendu ; le Panel n'a qu'un acte à
 * rendre idempotent. C'est déjà le choix des frais de lancement depuis L6.2B —
 * on ne l'invente pas, on l'applique à un objet qui n'est pas un contrat.
 *
 * Et il a une conséquence heureuse en aval : la session portant une facture,
 * c'est la FACTURE que L10.3 retient comme objet canonique. Session, facture,
 * intention et débit — quatre annonces Stripe — produisent donc UN seul revenu,
 * sans une ligne de code de plus.
 */
async function resolveServiceIntent({ projectId, environment, input, lookupPaymentRequest }) {
  let prestation;
  try {
    prestation = await lookupPaymentRequest({
      projectId, paymentRequestId: input.paymentRequestId,
    });
  } catch (err) {
    /**
     * La cause réelle part au JOURNAL, le refus rendu reste unique. Un projet
     * ne doit pas pouvoir distinguer « elle n'existe pas » de « elle n'est pas
     * à vous » : la seconde réponse lui apprendrait le parc.
     */
    logger.warn(
      `[stripe-checkout] prestation refusée — projet ${projectId} (${environment}) : `
      + `${err?.code ?? 'INCONNU'}.`,
    );
    throw new CheckoutAuthorityError(
      CHECKOUT_REFUSALS.SERVICE_NOT_PAYABLE,
      'Aucune prestation à payer ne correspond à cette référence.',
    );
  }

  const metadata = buildMetadata({ projectId, environment, contractId: null, input });
  /**
   * LA CORRÉLATION QUI FERME LA BOUCLE.
   *
   * Elle est recopiée sur la session, sur l'intention de paiement ET sur la
   * facture. Sans les trois, l'événement qui nous reviendra — et l'on ne sait
   * pas lequel arrivera en premier — pourrait ne porter aucun rattachement
   * lisible vers la prestation. Ce n'est PAS une autorité (une métadonnée
   * s'édite depuis le tableau de bord) : c'est un fil, et le Panel confronte
   * toujours ce qu'il y lit à ce qu'il sait.
   */
  metadata.paymentRequestId = prestation.paymentRequestId;

  /**
   * ── LA PRESTATION PORTE DÉJÀ SA VENTILATION ──────────────────────────────
   *
   * `PanelPaymentRequest` stocke `netAmountCents`, `taxRate`, `taxAmountCents`
   * et `grossAmountCents` depuis L10.5 : le Panel est ici l'auteur du calcul,
   * pas son récepteur. Il n'y a donc rien à lire au contrat et rien à déduire —
   * seulement à VÉRIFIER que ce qu'on a écrit s'additionne encore.
   *
   * La vérification n'est pas de la paranoïa : ces documents sont modifiables
   * tant qu'ils ne sont pas payés, et une correction de montant qui oublierait
   * de recalculer la TVA produirait une facture qui ne tombe pas juste.
   */
  const fiscal = lireVentilation(
    {
      amountIncludingTax: prestation.amountCents,
      amountExcludingTax: prestation.netAmountCents,
      taxAmount: prestation.taxAmountCents,
      taxRate: prestation.taxRate,
      currency: prestation.currency,
    },
    null,
    'cette prestation',
  );

  return {
    contractId: null,
    reference: prestation.label,
    amountIncludingTax: fiscal.grossCents,
    currency: fiscal.currency,
    paymentRequestId: prestation.paymentRequestId,
    fiscal,
    paramsFor: ({ taxRateId }) => ({
      mode: 'payment',
      line_items: [
        {
          price_data: {
            currency: fiscal.currency.toLowerCase(),
            product_data: {
              name: prestation.label,
              /** Stripe refuse une description vide — on omet plutôt qu'on invente. */
              ...(prestation.description ? { description: prestation.description.slice(0, 500) } : {}),
            },
            /** HORS TAXE — la taxe est déclarée ci-dessous. Voir les frais de lancement. */
            unit_amount: fiscal.netCents,
          },
          quantity: 1,
          ...(taxRateId ? { tax_rates: [taxRateId] } : {}),
        },
      ],
      success_url: input.successUrl,
      cancel_url: input.cancelUrl,
      metadata,
      payment_intent_data: { metadata },
      /** La vraie facture Stripe — page hébergée et PDF, émises au paiement. */
      invoice_creation: { enabled: true, invoice_data: { metadata } },
    }),
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
    /**
     * OMIS quand il n'y en a pas (L10.5 — une prestation n'a pas de contrat).
     * Une métadonnée vide chez Stripe se lit « contrat inconnu » plutôt que
     * « sans objet », et c'est la première chose qu'on croirait en enquêtant.
     */
    ...(contractId ? { contractId } : {}),
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
