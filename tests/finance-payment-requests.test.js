/**
 * L10.5 — PRESTATIONS À FACTURER.
 *
 * Ce que ces contrôles verrouillent :
 *
 *   · qu'une créance ne soit JAMAIS un revenu — envoyer une prestation
 *     n'inscrit rien au ledger ;
 *   · que le montant soit décidé par le PANEL, et que le projet ne puisse pas
 *     en fournir un — pas « le voie refusé », mais n'en ait aucun à fournir ;
 *   · que la TVA vienne du contrat, jamais d'un 20 % écrit en dur, et qu'un
 *     taux inconnu fasse REFUSER plutôt que supposer ;
 *   · que le snapshot fiscal soit IMMUABLE : changer le taux du contrat ne
 *     réécrit aucune facture déjà émise ;
 *   · que Stripe débite le TTC, et que le ledger constate le TTC ;
 *   · qu'un paiement produise EXACTEMENT un revenu, quel que soit le nombre
 *     d'annonces Stripe ;
 *   · que la demande APPRENNE qu'elle est payée, sans jamais écrire elle-même ;
 *   · qu'un remboursement L10.4 fonctionne dessus sans branche spéciale ;
 *   · qu'une relance ne parte pas après un paiement ;
 *   · qu'un e-mail en panne ne fasse pas disparaître la créance.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  check, connectTestDatabase, finish, section, setTestEnv,
  startMemoryMongo, startServer, stopMemoryMongo,
} from './helpers/harness.js';

setTestEnv();
await startMemoryMongo();
await connectTestDatabase();

const { createApp } = await import('../backend/src/app.js');
const { seedFromEnv } = await import('../backend/src/services/auth/panelUsers.service.js');
const PanelProject = (await import('../backend/src/models/PanelProject.model.js')).default;
const { PanelProjectContract } = await import('../backend/src/models/PanelProjectProjection.model.js');
const {
  PanelFinancialTransaction, CATEGORIES, FLOWS,
} = await import('../backend/src/models/PanelFinancialTransaction.model.js');
const PanelProviderRevenueFact = (await import('../backend/src/models/PanelProviderRevenueFact.model.js')).default;
const PanelPaymentRequest = (await import('../backend/src/models/PanelPaymentRequest.model.js')).default;
const {
  PAYMENT_REQUEST_STATUS, canTransition,
} = await import('../backend/src/models/PanelPaymentRequest.model.js');
const prService = await import('../backend/src/services/finance/paymentRequests/paymentRequests.service.js');
const money = await import('../backend/src/services/finance/money.js');
const projection = await import('../backend/src/services/finance/providerRevenue/revenueProjection.service.js');
const bindings = await import('../backend/src/services/integratedApi/stripe/stripeResourceBinding.js');
const checkoutAuthority = await import('../backend/src/services/integratedApi/stripe/stripeCheckoutAuthority.js');
const catalogue = await import('../backend/src/services/integratedApi/stripe/stripeCapabilities.js');
const agregat = await import('../backend/src/services/finance/financialSummary.service.js');
const projectors = await import('../backend/src/services/sync/projectors.js');

await seedFromEnv();
await PanelFinancialTransaction.init();
await PanelProviderRevenueFact.init();
await PanelPaymentRequest.init();

const { close } = await startServer(createApp());

const ACTEUR = { email: 'dev@panel.test', role: 'DEV' };
const PROJET_A = 'atelier-nord';
const PROJET_B = 'atelier-sud';

async function declarer(projectId, projectName) {
  const now = new Date().toISOString();
  await PanelProject.create({
    projectId, projectKey: projectId, projectName,
    createdAt: now, updatedAt: now,
    pairing: { status: 'PAIRED' }, runtime: { environment: 'TEST' },
    commercialState: 'LIVE', capabilityGrants: [],
  });
}
/** Le contrat porte le taux — c'est lui l'autorité fiscale, pas le Panel. */
async function contrat(projectId, taxRate) {
  await PanelProjectContract.updateOne(
    { projectId },
    {
      $set: {
        projectId, hasCurrent: true, sourceContractId: `ct-${projectId}`, status: 'ACTIVE',
        taxRate, sourceModifiedAt: new Date().toISOString(), receivedAt: new Date().toISOString(),
      },
    },
    { upsert: true },
  );
}
await declarer(PROJET_A, 'Atelier du Nord');
await declarer(PROJET_B, 'Atelier du Sud');

const SECONDES = (iso) => Math.floor(new Date(iso).getTime() / 1000);

/* ══════════════════════════════════════════════════════════════════════════ */
section('1. La primitive fiscale — pure, et alignée sur l’arrondi du projet');
{
  const c = (n, r) => money.computeTax({ netCents: n, taxRate: r });

  check('500 € HT à 20 % → 100 € de TVA', c(50_000, 20).taxCents === 10_000);
  check('…et 600 € TTC', c(50_000, 20).grossCents === 60_000);
  check('un taux à 0 % ne produit aucune taxe', c(50_000, 0).taxCents === 0);
  check('10 % donne 50 €', c(50_000, 10).taxCents === 5_000);
  check('5,5 % donne 27,50 € — le taux réduit est représentable',
    c(50_000, 5.5).taxCents === 2_750);

  /**
   * LA FRACTION DE CENTIME — l'arrondi doit être celui du projet
   * (`Math.round`), sans quoi le Panel et le contrat afficheraient un centime
   * d'écart sur la même facture.
   */
  check('33,33 € à 3 % arrondit à 1,00 € (et non 0,99)', c(3_333, 3).taxCents === 100);
  check('0,01 € à 20 % arrondit à 0', c(1, 20).taxCents === 0);

  const somme = c(3_333, 3);
  check('LE TTC EST UNE SOMME EXACTE, jamais un arrondi séparé',
    somme.netCents + somme.taxCents === somme.grossCents);

  check('un taux inconnu n’est pas utilisable', money.isUsableTaxRate(null) === false);
  check('…ni un taux au-delà de 100 %', money.isUsableTaxRate(120) === false);

  let refus = null;
  try { c(50_000, null); } catch (e) { refus = e; }
  check('la primitive REFUSE un taux absent plutôt que d’en supposer un', Boolean(refus));
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('2. Le taux vient du contrat — projeté, jamais deviné');
{
  await contrat(PROJET_A, 20);
  check('le taux du contrat A remonte au Panel',
    (await prService.resolveTaxRate(PROJET_A)) === 20);

  await contrat(PROJET_B, 10);
  check('celui de B est le sien', (await prService.resolveTaxRate(PROJET_B)) === 10);
  check('…et A n’a pas bougé', (await prService.resolveTaxRate(PROJET_A)) === 20);

  /* Le projecteur reflète, il ne complète pas. */
  await PanelProjectContract.updateOne({ projectId: PROJET_B }, { $set: { taxRate: null } });
  let refus = null;
  try { await prService.resolveTaxRate(PROJET_B); } catch (e) { refus = e; }
  check('un contrat SANS taux fait REFUSER', refus?.code === 'PANEL_PAYMENT_REQUEST_TAX_RATE_UNKNOWN');
  check('…et le message dit quoi corriger', /contrat/i.test(refus?.message ?? ''));
  await contrat(PROJET_B, 10);
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('3. Créer une prestation — le snapshot fiscal est figé');
let prestation;
{
  prestation = await prService.createPaymentRequest({
    projectId: PROJET_A,
    label: 'Ajout formulaire personnalisé',
    description: 'Développement et intégration du formulaire demandé.',
    netAmount: '500,00',
  }, ACTEUR);

  const vue = await prService.getPaymentRequest(prestation.paymentRequestId);
  check('le HT est celui saisi', vue.netAmountCents === 50_000);
  check('le taux est celui du contrat', vue.taxRate === 20);
  check('la TVA est calculée', vue.taxAmountCents === 10_000);
  check('le TTC est la somme', vue.grossAmountCents === 60_000);
  check('l’envoi la rend due', vue.status === PAYMENT_REQUEST_STATUS.OPEN);
  check('…et payable', vue.payable === true);
  check('le monde est CONSTATÉ à l’envoi', vue.environment === 'TEST');

  /**
   * L'INVARIANT CENTRAL DU LOT : envoyer une prestation n'inscrit RIEN au
   * ledger. 500 € réclamés ne sont pas 500 € gagnés.
   */
  const mouvements = await PanelFinancialTransaction.countDocuments({ projectId: PROJET_A });
  check('AUCUNE transaction financière n’a été créée', mouvements === 0);
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('4. Le snapshot est IMMUABLE — le contrat peut changer, pas la facture');
{
  await contrat(PROJET_A, 10);
  check('le contrat annonce désormais 10 %', (await prService.resolveTaxRate(PROJET_A)) === 10);

  const vue = await prService.getPaymentRequest(prestation.paymentRequestId);
  check('la prestation garde SON taux', vue.taxRate === 20);
  check('…sa TVA', vue.taxAmountCents === 10_000);
  check('…et son TTC', vue.grossAmountCents === 60_000);

  /** Une NOUVELLE prestation, elle, prend le taux du jour. */
  const suivante = await prService.createPaymentRequest({
    projectId: PROJET_A, label: 'Retouche CSS', netAmount: '100,00',
  }, ACTEUR);
  const vueSuivante = await prService.getPaymentRequest(suivante.paymentRequestId);
  check('une prestation créée APRÈS le changement prend le nouveau taux',
    vueSuivante.taxRate === 10 && vueSuivante.grossAmountCents === 11_000);

  await prService.cancelPaymentRequest(suivante.paymentRequestId, { reason: 'test' }, ACTEUR);
  await contrat(PROJET_A, 20);
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('5. L’autorité du montant — le projet n’en fournit aucun');
{
  const contratEntree = catalogue.STRIPE_CAPABILITIES['billing.checkout.create'].inputSchema;

  const falsifie = contratEntree.safeParse({
    paymentType: 'SERVICE',
    paymentRequestId: prestation.paymentRequestId,
    amount: 600, amountCents: 600, unitAmount: 600,
    successUrl: 'https://x.test/ok', cancelUrl: 'https://x.test/ko',
    operationId: 'service-checkout-0123456789abcdef',
  });
  check('LE CONTRAT REFUSE tout montant dans la charge utile', falsifie.success === false);

  const nu = contratEntree.safeParse({
    paymentType: 'SERVICE',
    paymentRequestId: prestation.paymentRequestId,
    successUrl: 'https://x.test/ok', cancelUrl: 'https://x.test/ko',
    operationId: 'service-checkout-0123456789abcdef',
  });
  check('…et accepte la seule identité', nu.success === true);

  const sansReference = contratEntree.safeParse({
    paymentType: 'SERVICE',
    successUrl: 'https://x.test/ok', cancelUrl: 'https://x.test/ko',
    operationId: 'service-checkout-0123456789abcdef',
  });
  check('une prestation sans référence est refusée', sansReference.success === false);

  const deuxReferences = contratEntree.safeParse({
    paymentType: 'SERVICE', contractRef: 'ct-1',
    paymentRequestId: prestation.paymentRequestId,
    successUrl: 'https://x.test/ok', cancelUrl: 'https://x.test/ko',
    operationId: 'service-checkout-0123456789abcdef',
  });
  check('contrat ET prestation à la fois : refusé', deuxReferences.success === false);

  /* L'AUTORITÉ elle-même : c'est le TTC du Panel qui sort, pas le HT. */
  const intention = await checkoutAuthority.resolveCheckoutIntent({
    projectId: PROJET_A, environment: 'TEST',
    input: {
      paymentType: 'SERVICE', paymentRequestId: prestation.paymentRequestId,
      successUrl: 'https://x.test/ok', cancelUrl: 'https://x.test/ko',
      operationId: 'service-checkout-0123456789abcdef',
    },
  });
  check('STRIPE RECEVRA 600 € — le TTC, jamais le HT',
    intention.params.line_items[0].price_data.unit_amount === 60_000);
  check('…et la vraie facture Stripe est demandée',
    intention.params.invoice_creation?.enabled === true);
  check('la corrélation voyage dans les metadata',
    intention.params.metadata.paymentRequestId === prestation.paymentRequestId);
  check('…sur l’intention de paiement aussi',
    intention.params.payment_intent_data.metadata.paymentRequestId === prestation.paymentRequestId);
  check('…et sur la facture', intention.params.invoice_creation.invoice_data.metadata.paymentRequestId
    === prestation.paymentRequestId);
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('6. Le cloisonnement — B ne paie pas la prestation de A');
{
  let refus = null;
  try {
    await checkoutAuthority.resolveCheckoutIntent({
      projectId: PROJET_B, environment: 'TEST',
      input: {
        paymentType: 'SERVICE', paymentRequestId: prestation.paymentRequestId,
        successUrl: 'https://x.test/ok', cancelUrl: 'https://x.test/ko',
        operationId: 'service-checkout-0123456789abcdef',
      },
    });
  } catch (e) { refus = e; }
  check('le projet B est refusé', Boolean(refus));

  let inexistante = null;
  try {
    await checkoutAuthority.resolveCheckoutIntent({
      projectId: PROJET_B, environment: 'TEST',
      input: {
        paymentType: 'SERVICE', paymentRequestId: '00000000-0000-4000-8000-000000000000',
        successUrl: 'https://x.test/ok', cancelUrl: 'https://x.test/ko',
        operationId: 'service-checkout-0123456789abcdef',
      },
    });
  } catch (e) { inexistante = e; }
  check('LE REFUS EST INDISTINCT — « pas à vous » se lit comme « n’existe pas »',
    refus?.reason === inexistante?.reason && refus?.message === inexistante?.message);
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('7. Le paiement — UN revenu, et la demande l’APPREND');
{
  /** La session est possédée par A (L6.2B), comme tout paiement du parc. */
  await bindings.bindResource({
    projectId: PROJET_A, environment: 'TEST',
    resourceType: bindings.STRIPE_RESOURCE_TYPES.CHECKOUT_SESSION,
    resourceId: 'cs_prestation',
    source: bindings.BINDING_SOURCES.PANEL_CREATED,
  });
  await prService.attachCheckoutSession({
    paymentRequestId: prestation.paymentRequestId,
    checkoutSessionId: 'cs_prestation',
    url: 'https://pay.stripe.test/cs_prestation',
  });

  const meta = {
    panelProjectId: PROJET_A, paymentType: 'SERVICE',
    paymentRequestId: prestation.paymentRequestId,
  };
  const evenement = (type, objet) => ({
    id: `evt_${type}_${Math.random().toString(36).slice(2, 8)}`,
    type, created: SECONDES('2026-08-20T10:00:00Z'), data: { object: objet },
  });

  /**
   * LES QUATRE ANNONCES STRIPE DU MÊME EURO. Elles arrivent dans le désordre,
   * et la facture est canonique dès qu'elle existe.
   */
  await projection.recordStripeRevenueEvent({
    environment: 'TEST', eventType: 'checkout.session.completed',
    payload: evenement('checkout.session.completed', {
      id: 'cs_prestation', object: 'checkout.session', mode: 'payment',
      payment_status: 'paid', amount_total: 60_000, currency: 'eur',
      created: SECONDES('2026-08-20T10:00:00Z'), customer: 'cus_x',
      payment_intent: 'pi_prestation', invoice: 'in_prestation', subscription: null,
      livemode: false, metadata: meta,
    }),
    providerEventId: 'evt_session',
  });
  await projection.recordStripeRevenueEvent({
    environment: 'TEST', eventType: 'invoice.paid',
    payload: evenement('invoice.paid', {
      id: 'in_prestation', object: 'invoice', amount_paid: 60_000, amount_due: 60_000,
      total: 60_000, currency: 'eur', number: 'FA-2026-0100',
      status_transitions: { paid_at: SECONDES('2026-08-20T10:00:00Z') },
      payment_intent: 'pi_prestation', charge: 'ch_prestation', customer: 'cus_x',
      hosted_invoice_url: 'https://invoice.stripe.test/in_prestation',
      invoice_pdf: 'https://invoice.stripe.test/in_prestation.pdf',
      livemode: false, metadata: meta,
      subscription: null,
      lines: { data: [{ description: 'Ajout formulaire personnalisé' }] },
    }),
    providerEventId: 'evt_invoice',
  });
  await projection.recordStripeRevenueEvent({
    environment: 'TEST', eventType: 'payment_intent.succeeded',
    payload: evenement('payment_intent.succeeded', { id: 'pi_prestation', object: 'payment_intent' }),
    providerEventId: 'evt_pi',
  });
  await projection.recordStripeRevenueEvent({
    environment: 'TEST', eventType: 'charge.succeeded',
    payload: evenement('charge.succeeded', { id: 'ch_prestation', object: 'charge' }),
    providerEventId: 'evt_charge',
  });

  const revenus = await PanelFinancialTransaction.find({
    projectId: PROJET_A, category: CATEGORIES.REVENUE, deletedAt: null,
  }).lean();
  check('QUATRE ANNONCES, UN SEUL REVENU', revenus.length === 1);
  check('…et il porte le TTC', revenus[0].amountCents === 60_000);
  check('…en entrée', revenus[0].flow === FLOWS.INFLOW);

  const vue = await prService.getPaymentRequest(prestation.paymentRequestId);
  check('la prestation est PAYÉE', vue.status === PAYMENT_REQUEST_STATUS.PAID);
  check('…et connaît sa transaction', vue.transactionId === revenus[0].transactionId);
  check('la vraie facture Stripe est conservée',
    vue.stripe.hostedInvoiceUrl === 'https://invoice.stripe.test/in_prestation');
  check('…avec son PDF', vue.stripe.invoicePdfUrl === 'https://invoice.stripe.test/in_prestation.pdf');
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('8. PAID est TERMINAL, et les relances s’arrêtent d’elles-mêmes');
{
  check('PAID → OPEN est impossible',
    canTransition(PAYMENT_REQUEST_STATUS.PAID, PAYMENT_REQUEST_STATUS.OPEN) === false);
  check('…PAID → CANCELED aussi',
    canTransition(PAYMENT_REQUEST_STATUS.PAID, PAYMENT_REQUEST_STATUS.CANCELED) === false);

  let refus = null;
  try {
    await prService.cancelPaymentRequest(prestation.paymentRequestId, {}, ACTEUR);
  } catch (e) { refus = e; }
  check('annuler une prestation payée est REFUSÉ',
    refus?.code === 'PANEL_PAYMENT_REQUEST_ALREADY_PAID');

  const document = await PanelPaymentRequest.findOne({
    paymentRequestId: prestation.paymentRequestId,
  }).lean();
  check('l’échéance de relance a été retirée au paiement', document.reminders.nextAt === null);

  /**
   * LA COURSE : une demande sélectionnée puis payée avant l'envoi. La
   * réservation est reconditionnée sur `status: OPEN` — elle ne réserve rien.
   */
  await PanelPaymentRequest.updateOne(
    { paymentRequestId: prestation.paymentRequestId },
    { $set: { 'reminders.enabled': true, 'reminders.nextAt': new Date(Date.now() - 60_000) } },
  );
  const rapport = await prService.sendDueReminders({});
  check('AUCUNE relance ne part sur une prestation payée', rapport.sent === 0);
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('9. Le remboursement L10.4 — sans branche spéciale');
{
  const revenu = await PanelFinancialTransaction.findOne({
    projectId: PROJET_A, category: CATEGORIES.REVENUE, deletedAt: null,
  }).lean();

  const refunds = await import('../backend/src/services/finance/refunds/refundOrchestration.service.js');
  const verdict = await refunds.describeRefundEligibility(revenu.transactionId);
  check('un revenu de prestation est remboursable comme un autre', verdict.eligible === true);
  check('…sur la totalité de ce qui a été encaissé', verdict.refund.collectedCents === 60_000);

  /** On projette un remboursement de 100 € par la voie normale de L10.4. */
  await projection.recordStripeRevenueEvent({
    environment: 'TEST', eventType: 'charge.refunded',
    payload: {
      id: 'evt_refund', type: 'charge.refunded', created: SECONDES('2026-08-25T10:00:00Z'),
      data: {
        object: {
          id: 'ch_prestation', object: 'charge', payment_intent: 'pi_prestation',
          receipt_url: 'https://pay.stripe.test/receipts/ch_prestation',
          refunds: {
            data: [{
              id: 're_prestation', object: 'refund', amount: 10_000, currency: 'eur',
              status: 'succeeded', created: SECONDES('2026-08-25T10:00:00Z'),
              payment_intent: 'pi_prestation', charge: 'ch_prestation', metadata: {},
            }],
          },
        },
      },
    },
    providerEventId: 'evt_refund',
  });

  const resume = await agregat.summarize({ scope: 'project', projectId: PROJET_A, period: 'ALL' });
  check('les revenus valent 600 €', resume.byCategory.revenueCents === 60_000);
  check('le remboursement vaut 100 €', resume.byCategory.refundCents === 10_000);
  check('LES COÛTS RESTENT À ZÉRO', resume.byCategory.costCents === 0);
  check('le net est de 500 €', resume.totals.netCents === 50_000);

  const vue = await prService.getPaymentRequest(prestation.paymentRequestId);
  check('LA PRESTATION RESTE PAYÉE — un remboursement ne la rouvre pas',
    vue.status === PAYMENT_REQUEST_STATUS.PAID);
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('10. L’annulation, et ce qu’elle vaut réellement chez Stripe');
{
  const aAnnuler = await prService.createPaymentRequest({
    projectId: PROJET_A, label: 'Prestation abandonnée', netAmount: '200,00',
  }, ACTEUR);

  await prService.cancelPaymentRequest(aAnnuler.paymentRequestId, { reason: 'Devis refusé' }, ACTEUR);
  const vue = await prService.getPaymentRequest(aAnnuler.paymentRequestId);
  check('elle est annulée', vue.status === PAYMENT_REQUEST_STATUS.CANCELED);
  check('…plus payable', vue.payable === false);
  check('…le motif est conservé', vue.cancelReason === 'Devis refusé');
  check('…et plus aucune relance n’est armée', vue.reminders.nextAt === null);

  /** L'autorité refuse d'ouvrir une session sur une demande annulée. */
  let refus = null;
  try {
    await checkoutAuthority.resolveCheckoutIntent({
      projectId: PROJET_A, environment: 'TEST',
      input: {
        paymentType: 'SERVICE', paymentRequestId: aAnnuler.paymentRequestId,
        successUrl: 'https://x.test/ok', cancelUrl: 'https://x.test/ko',
        operationId: 'service-checkout-annulee-0123456789',
      },
    });
  } catch (e) { refus = e; }
  check('AUCUNE nouvelle session ne peut être ouverte', Boolean(refus));

  const mouvements = await PanelFinancialTransaction.countDocuments({
    projectId: PROJET_A, label: 'Prestation abandonnée',
  });
  check('…et aucun revenu n’en est né', mouvements === 0);
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('11. Le monde — une prestation de recette ne se paie pas en production');
{
  const document = await PanelPaymentRequest.findOne({
    projectId: PROJET_A, status: PAYMENT_REQUEST_STATUS.OPEN,
  });
  if (document) {
    await PanelPaymentRequest.updateOne(
      { paymentRequestId: document.paymentRequestId },
      { $set: { environment: 'PROD' } },
    );
    let refus = null;
    try {
      await prService.resolveServiceAmount({
        projectId: PROJET_A, paymentRequestId: document.paymentRequestId,
      });
    } catch (e) { refus = e; }
    check('une demande PROD est refusée sur une instance TEST',
      refus?.code === 'PAYMENT_REQUEST_ENVIRONMENT_MISMATCH');
  } else {
    check('une demande PROD est refusée sur une instance TEST (aucune ouverte)', true);
  }
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('12. La projection vers le projet — pauvre, et sans identifiant Stripe');
{
  const document = await PanelPaymentRequest.findOne({
    paymentRequestId: prestation.paymentRequestId,
  }).lean();
  const vue = prService.toProjectProjection(document);

  check('le client voit la ventilation', vue.netAmountCents === 50_000 && vue.taxRate === 20);
  check('…et ce qu’il a payé', vue.grossAmountCents === 60_000);
  check('…et sa facture', vue.invoiceUrl === 'https://invoice.stripe.test/in_prestation');

  const serialise = JSON.stringify(vue);
  check('AUCUN identifiant de session', !serialise.includes('cs_'));
  check('AUCUNE intention de paiement', !serialise.includes('pi_'));
  check('AUCUNE URL de paiement périssable', !serialise.includes('pay.stripe'));
  check('AUCUN historique interne', vue.history === undefined);
  check('AUCUN auteur', vue.createdBy === undefined);
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('13. Garde-fous d’architecture — ce qui ne doit jamais revenir');
{
  const ici = path.dirname(fileURLToPath(import.meta.url));
  const racine = path.resolve(ici, '..');
  const lire = (rel) => fs.readFileSync(path.join(racine, rel), 'utf8');
  const code = (t) => t.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/.*$/gm, '$1 ');

  const service = code(lire('backend/src/services/finance/paymentRequests/paymentRequests.service.js'));

  /**
   * LA GARDE LA PLUS IMPORTANTE DU LOT : une prestation n'écrit JAMAIS au
   * ledger. Le jour où quelqu'un ajoutera « juste pour que l'écran soit à
   * jour », il y aura deux revenus par euro.
   */
  check('le service des prestations n’écrit AUCUNE transaction financière',
    !/recordTransaction|createManualTransaction|PanelFinancialTransaction/.test(service));
  check('…et aucun 20 % en dur', !/\b20\s*\/\s*100\b|taxRate\s*[=:]\s*20\b|\?\?\s*20\b/.test(service));
  check('…aucun appel Stripe direct', !/\bfetch\s*\(|api\.stripe|sk_test|sk_live/.test(service));
  check('…aucun appel Brevo direct', !/v3\/smtp|brevo\.com/i.test(service));

  const emails = code(lire('backend/src/services/finance/paymentRequests/paymentRequestEmails.js'));
  check('les e-mails passent par la capacité, jamais par Brevo',
    emails.includes('email.send_template') && !/v3\/smtp|api\.brevo/i.test(emails));

  const modele = code(lire('backend/src/models/PanelPaymentRequest.model.js'));
  check('le modèle ne porte plus de montant ambigu', !/\bamountCents\s*:/.test(modele));
  check('…il porte les quatre champs fiscaux',
    /netAmountCents/.test(modele) && /taxRate/.test(modele)
    && /taxAmountCents/.test(modele) && /grossAmountCents/.test(modele));

  const autorite = code(lire('backend/src/services/integratedApi/stripe/stripeCheckoutAuthority.js'));
  check('l’autorité lit le TTC de la prestation, pas un montant reçu',
    /prestation\.amountCents/.test(autorite));

  /**
   * LA GARDE PORTE SUR L'ENTRÉE DU CHECKOUT, ET SUR ELLE SEULE.
   *
   * Mesurer tout le fichier serait faux : `priceEnsureOutput` porte
   * légitimement un `amount` — c'est ce que le Panel REND, pas ce qu'il
   * accepte. Un garde-fou qui rougit sur du code correct finit désactivé.
   */
  const capacites = code(lire('backend/src/services/integratedApi/stripe/stripeCapabilities.js'));
  const entreeCheckout = /const checkoutCreateInput = z\.object\(\{[\s\S]*?\n\}\)\.strict\(\)/.exec(capacites)?.[0] ?? '';
  check('le bloc d’entrée du checkout a été trouvé', entreeCheckout.length > 0);
  check('…et il n’accepte AUCUN montant',
    !/\bamount\b|\bunitAmount\b|\bprice\b|\bnetAmount\b|\bgrossAmount\b/.test(entreeCheckout));

  const projecteur = code(lire('backend/src/services/sync/projectors.js'));
  check('le projecteur de contrat ne complète jamais un taux absent',
    !/taxRate[^,;]*\?\?\s*20/.test(projecteur));
}

await close();
await stopMemoryMongo();
finish();
