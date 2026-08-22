/**
 * L13 — BRUT, FRAIS FOURNISSEUR, NET.
 *
 * Ce que ces contrôles verrouillent, et pourquoi chacun compte :
 *
 *   · que le montant du frais vienne de la `balance_transaction` STRIPE et
 *     JAMAIS d'une formule tarifaire — le contrôle central du lot, doublé
 *     d'un balayage de sources qui interdit d'en réintroduire une ;
 *   · que le CHIFFRE D'AFFAIRES reste le BRUT : une vente de 120 € ne devient
 *     jamais un revenu de 117,85 € ;
 *   · que la commission diminue le BÉNÉFICE, comme une charge, sans être
 *     comptée deux fois ;
 *   · qu'une même écriture de solde observée dix fois ne produise qu'UNE
 *     ligne de coût — la garantie est en base, pas dans un `if` ;
 *   · qu'une observation en ATTENTE n'efface jamais une observation ACQUISE,
 *     quel que soit l'ordre d'arrivée ;
 *   · qu'un frais inconnu s'affiche « en cours de récupération » et JAMAIS
 *     « 0,00 € » ;
 *   · qu'une transaction antérieure au lot reste parfaitement lisible ;
 *   · qu'aucun projet ne puisse atteindre la lecture du registre de solde ;
 *   · qu'aucun écran financier n'appelle le fournisseur.
 *
 * Le faux Stripe est un vrai serveur HTTP : le Panel sort réellement de son
 * processus, avec la clé de son coffre, exactement comme en production.
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  check,
  connectTestDatabase,
  finish,
  section,
  setTestEnv,
  startMemoryMongo,
  startServer,
  stopMemoryMongo,
} from './helpers/harness.js';

setTestEnv();
await startMemoryMongo();
await connectTestDatabase();

const RACINE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ACTEUR = { email: 'dev@panel.test', name: 'Recette L13' };

/* ══════════════════════════════════════════════════════════════════════════
   LE FAUX STRIPE — il rend de VRAIES formes de charge utile.

   Les nombres viennent d'observations réelles sur le compte de recette :
   34 800 c → 547 de frais (carte européenne) et 1 200 c → 64 (carte hors EEE).
   Deux barèmes le même jour, sur le même compte : c'est ce couple qui rend
   toute formule tarifaire fausse, et c'est pour cela qu'il est reproduit ici.
   ══════════════════════════════════════════════════════════════════════════ */
const appels = [];
/** Écritures de solde servies, par identifiant de débit. */
const ecritures = new Map();
/** Débits sans écriture — le cas « pas encore arrêté par le fournisseur ». */
const debitsSansEcriture = new Set();
/** Ce que la RELECTURE d'une facture rend, par opposition à ce que le webhook dit. */
const facturesReglees = new Map();

const ecriture = ({ id, source, amount, fee, net, type = 'charge', status = 'pending' }) => ({
  id,
  object: 'balance_transaction',
  amount,
  fee,
  net,
  currency: 'eur',
  type,
  reporting_category: type,
  status,
  available_on: 1_787_875_200,
  created: 1_787_308_255,
  source,
  exchange_rate: null,
  fee_details: [{
    amount: fee, application: null, currency: 'eur',
    description: 'Stripe processing fees', type: 'stripe_fee',
  }],
});

const fauxStripe = http.createServer(async (req, res) => {
  const auth = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
  appels.push({ method: req.method, url: req.url, auth });
  const repondre = (code, objet) => {
    res.writeHead(code, { 'content-type': 'application/json' });
    res.end(JSON.stringify(objet));
  };

  if (req.url === '/v1/account') {
    return repondre(200, { id: 'acct_panel', country: 'FR', charges_enabled: true });
  }

  const intention = /^\/v1\/payment_intents\/([^/?]+)/.exec(req.url ?? '');
  if (req.method === 'GET' && intention) {
    const id = decodeURIComponent(intention[1]);
    const chargeId = id.replace('pi_', 'ch_');
    if (!ecritures.has(chargeId) && !debitsSansEcriture.has(chargeId)) {
      return repondre(404, { error: { code: 'resource_missing' } });
    }
    return repondre(200, {
      id,
      object: 'payment_intent',
      status: 'succeeded',
      latest_charge: {
        id: chargeId,
        object: 'charge',
        /** `null` = le fournisseur n'a pas encore arrêté ses comptes. */
        balance_transaction: ecritures.get(chargeId) ?? null,
      },
    });
  }

  /**
   * LA FACTURE, RELUE AVEC LA VERSION D'API DU PANEL.
   *
   * Le webhook du compte de recette (`2026-06-24.dahlia`) ne porte NI `charge`,
   * NI `payment_intent`, NI `payments.data` sur un `invoice.paid`. La relecture,
   * elle, les rend — c'est tout l'objet du repli par l'objet canonique. Le faux
   * Stripe reproduit exactement cet écart.
   */
  const factureLue = /^\/v1\/invoices\/([^/?]+)/.exec(req.url ?? '');
  if (req.method === 'GET' && factureLue) {
    const id = decodeURIComponent(factureLue[1]);
    const regle = facturesReglees.get(id);
    if (!regle) return repondre(404, { error: { code: 'resource_missing' } });
    return repondre(200, regle);
  }

  /** LE DÉBIT — il désigne son intention, et le Panel l'apprend par lui. */
  const debit = /^\/v1\/charges\/([^/?]+)/.exec(req.url ?? '');
  if (req.method === 'GET' && debit) {
    const id = decodeURIComponent(debit[1]);
    if (!ecritures.has(id) && !debitsSansEcriture.has(id)) {
      return repondre(404, { error: { code: 'resource_missing' } });
    }
    return repondre(200, {
      id,
      object: 'charge',
      payment_intent: id.replace('ch_', 'pi_'),
      balance_transaction: ecritures.get(id) ?? null,
    });
  }

  const remboursement = /^\/v1\/refunds\/([^/?]+)/.exec(req.url ?? '');
  if (req.method === 'GET' && remboursement) {
    const id = decodeURIComponent(remboursement[1]);
    const cle = `bt_${id}`;
    return repondre(200, {
      id,
      object: 'refund',
      charge: 'ch_rembourse',
      balance_transaction: ecritures.get(cle) ?? null,
    });
  }

  return repondre(404, { error: { message: 'route inconnue' } });
});
await new Promise((resolve) => fauxStripe.listen(0, '127.0.0.1', resolve));
const STRIPE_BASE = `http://127.0.0.1:${fauxStripe.address().port}`;

/* ══════════════════════════════════════════════════════════════════════════
   LE PANEL
   ══════════════════════════════════════════════════════════════════════════ */
const { createApp } = await import('../backend/src/app.js');
const { seedFromEnv } = await import('../backend/src/services/auth/panelUsers.service.js');
const PanelProject = (await import('../backend/src/models/PanelProject.model.js')).default;
const { PanelFinancialTransaction } = await import('../backend/src/models/PanelFinancialTransaction.model.js');
const PanelProviderRevenueFact = (await import('../backend/src/models/PanelProviderRevenueFact.model.js')).default;
const controlPlane = await import('../backend/src/services/integratedApi/controlPlane.service.js');
const { seedIntegratedApiCredentialSets } = await import('../backend/src/services/integratedApi/seed.js');
const autorite = await import('../backend/src/services/integratedApi/stripe/stripeSettlementAuthority.js');
const reglement = await import('../backend/src/services/finance/providerRevenue/providerSettlement.service.js');
const projection = await import('../backend/src/services/finance/providerRevenue/revenueProjection.service.js');
const normalizer = await import('../backend/src/services/finance/providerRevenue/stripeRevenueNormalizer.js');
const bindings = await import('../backend/src/services/integratedApi/stripe/stripeResourceBinding.js');
const agregat = await import('../backend/src/services/finance/financialSummary.service.js');
const registreCapacites = await import('../backend/src/services/capabilities/capabilityRegistry.js');
const passerelle = await import('../backend/src/services/capabilities/capabilityGateway.service.js');
const { INVOCATION_SOURCES } = await import('../backend/src/services/capabilities/invocationContext.js');
const transactions = await import('../backend/src/services/finance/financialTransactions.service.js');

await seedFromEnv();
await seedIntegratedApiCredentialSets();
await PanelFinancialTransaction.init();
await PanelProviderRevenueFact.init();

const { call, close } = await startServer(createApp());
const login = await call('POST', '/api/auth/login', {
  body: { email: 'dev@panel.test', password: 'motdepasse-test' },
});
const AUTH = { authorization: `Bearer ${login.json.data.token}` };

await controlPlane.saveCredentialSet('STRIPE', 'TEST', {
  values: { secretKey: 'sk_test_panel_l13', baseUrl: STRIPE_BASE },
}, ACTEUR);
await controlPlane.validateCredentialSet('STRIPE', 'TEST', { actor: ACTEUR });

const PROJET = 'atelier-l13';
const AUTRE = 'atelier-voisin-l13';
for (const [id, nom] of [[PROJET, 'Atelier L13'], [AUTRE, 'Atelier voisin']]) {
  const now = new Date().toISOString();
  // eslint-disable-next-line no-await-in-loop
  await PanelProject.create({
    projectId: id, projectKey: id, projectName: nom,
    createdAt: now, updatedAt: now, pairing: { status: 'DECLARED' }, runtime: {},
  });
}

const SECONDES = (iso) => Math.floor(new Date(iso).getTime() / 1000);
const evenement = (type, objet, created = '2026-08-22T10:00:00Z') => ({
  id: `evt_${objet.id}_${type}`,
  type,
  created: SECONDES(created),
  data: { object: objet },
});

/**
 * UNE FACTURE PAYÉE — 100 € HT + 20 € de TVA = 120 € TTC.
 *
 * C'est l'exemple exact de la doctrine : la vente vaut 120 €, la commission en
 * retire 2,15 €, et le revenu reste 120 €.
 */
const facture = (overrides = {}) => ({
  id: 'in_l13_presta',
  object: 'invoice',
  amount_due: 12_000,
  amount_paid: 12_000,
  subtotal: 10_000,
  total_excluding_tax: 10_000,
  total: 12_000,
  tax: 2_000,
  currency: 'eur',
  number: 'FA-2026-0100',
  status: 'paid',
  subscription: null,
  customer: 'cus_l13',
  payment_intent: 'pi_l13_presta',
  charge: 'ch_l13_presta',
  created: SECONDES('2026-08-22T09:59:00Z'),
  status_transitions: { paid_at: SECONDES('2026-08-22T10:00:00Z') },
  lines: { data: [{ description: 'Prestation ponctuelle — Atelier L13' }] },
  livemode: false,
  metadata: { panelProjectId: PROJET, paymentType: 'SERVICE' },
  ...overrides,
});

const lier = (projectId, resourceType, resourceId) => bindings.bindResource({
  projectId, environment: 'TEST', resourceType, resourceId, source: 'PANEL_CREATED',
});

const factOf = (objectId) => PanelProviderRevenueFact.findOne({ objectId }).lean();
const txOf = (transactionId) => PanelFinancialTransaction.findOne({ transactionId }).lean();

/* ══════════════════════════════════════════════════════════════════════════ */
section('1. L’autorité du frais : la balance transaction, et rien d’autre');
/* ══════════════════════════════════════════════════════════════════════════ */
{
  const { normalizeBalanceTransaction, SETTLEMENT_REASON } = autorite;

  const reelle = normalizeBalanceTransaction({
    balanceTransaction: ecriture({ id: 'txn_1', source: 'ch_1', amount: 12_000, fee: 215, net: 11_785 }),
  });
  check('brut, frais et net sont LUS, pas calculés',
    reelle.settlement.grossCents === 12_000
    && reelle.settlement.providerFeeCents === 215
    && reelle.settlement.netCents === 11_785);
  check('…et l’invariant brut − frais = net tient',
    reelle.settlement.grossCents - reelle.settlement.providerFeeCents === reelle.settlement.netCents);
  check('la ventilation du fournisseur est conservée telle quelle',
    reelle.settlement.feeDetails.length === 1
    && reelle.settlement.feeDetails[0].type === 'stripe_fee'
    && reelle.settlement.feeDetails[0].amountCents === 215);
  check('la catégorie de reporting et le type sont conservés pour la comptabilité',
    reelle.settlement.reportingCategory === 'charge' && reelle.settlement.providerType === 'charge');

  /**
   * DEUX BARÈMES LE MÊME JOUR — l'observation qui condamne toute formule.
   * Si le Panel calculait « 1,5 % + 0,25 € », il rendrait 547 sur les deux.
   */
  const europe = normalizeBalanceTransaction({
    balanceTransaction: ecriture({ id: 'txn_eu', source: 'ch_eu', amount: 34_800, fee: 547, net: 34_253 }),
  });
  const hors = normalizeBalanceTransaction({
    balanceTransaction: ecriture({ id: 'txn_int', source: 'ch_int', amount: 1_200, fee: 64, net: 1_136 }),
  });
  check('deux paiements du même compte portent des barèmes DIFFÉRENTS',
    europe.settlement.providerFeeCents === 547 && hors.settlement.providerFeeCents === 64);
  check('…et aucune formule ne rendrait les deux',
    Math.round(34_800 * 0.015) + 25 === 547 && Math.round(1_200 * 0.015) + 25 !== 64);

  const incoherente = normalizeBalanceTransaction({
    balanceTransaction: ecriture({ id: 'txn_ko', source: 'ch_ko', amount: 12_000, fee: 215, net: 11_000 }),
  });
  check('un triplet qui ne s’additionne pas est REFUSÉ, jamais arbitré',
    incoherente.settlement === null && incoherente.reason === SETTLEMENT_REASON.INCONSISTENT);

  const devise = normalizeBalanceTransaction({
    balanceTransaction: { ...ecriture({ id: 'txn_usd', source: 'ch_usd', amount: 100, fee: 5, net: 95 }), currency: 'usd' },
    supportedCurrencies: ['EUR'],
  });
  check('une devise hors périmètre est refusée, jamais convertie à la volée',
    devise.settlement === null && devise.reason === SETTLEMENT_REASON.CURRENCY_UNSUPPORTED);

  const rendu = normalizeBalanceTransaction({
    balanceTransaction: ecriture({
      id: 'txn_re', source: 're_1', amount: -12_000, fee: 0, net: -12_000, type: 'refund',
    }),
  });
  check('un remboursement garde son signe NÉGATIF tel que le fournisseur le voit',
    rendu.settlement.grossCents === -12_000 && rendu.settlement.netCents === -12_000);
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('2. « Pas encore » n’est pas « zéro »');
/* ══════════════════════════════════════════════════════════════════════════ */
{
  const { settlementOfPaymentIntent, SETTLEMENT_REASON } = autorite;

  const attente = settlementOfPaymentIntent({
    paymentIntent: { id: 'pi_x', latest_charge: { id: 'ch_x', balance_transaction: null } },
  });
  check('un débit sans écriture de solde rend une ATTENTE, pas un frais nul',
    attente.settlement === null
    && attente.reason === SETTLEMENT_REASON.BALANCE_TRANSACTION_PENDING);

  const impasse = settlementOfPaymentIntent({ paymentIntent: { id: 'pi_y', latest_charge: null } });
  check('une intention sans débit du tout est une IMPASSE, pas une attente',
    impasse.settlement === null && impasse.reason === SETTLEMENT_REASON.NO_PAYMENT_REFERENCE);

  check('les deux motifs sont DISTINCTS — ils appellent des gestes opposés',
    SETTLEMENT_REASON.BALANCE_TRANSACTION_PENDING !== SETTLEMENT_REASON.NO_PAYMENT_REFERENCE);
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('3. Les règles comptables, avant toute base de données');
/* ══════════════════════════════════════════════════════════════════════════ */
{
  const { feeMovementOf, shouldReplaceSettlement, settlementReferenceOf } = reglement;
  const { SETTLEMENT_STATUS } = autorite;

  const charge = feeMovementOf({ fait: { kind: 'REVENUE' }, providerFeeCents: 215 });
  check('un frais prélevé devient une CHARGE qui sort',
    charge.category === 'COST' && charge.flow === 'OUTFLOW' && charge.amountCents === 215);

  const nul = feeMovementOf({ fait: { kind: 'REVENUE' }, providerFeeCents: 0 });
  check('un frais NUL n’écrit aucun mouvement — un mouvement de zéro n’en est pas un',
    nul === null);

  const restitue = feeMovementOf({ fait: { kind: 'REFUND' }, providerFeeCents: -215 });
  check('une commission RENDUE est une correction qui entre, jamais un revenu',
    restitue.category === 'ADJUSTMENT' && restitue.flow === 'INFLOW' && restitue.amountCents === 215);
  check('…et son montant reste POSITIF : le sens est porté par le flux',
    restitue.amountCents > 0);

  check('un acquis ne se remplace pas par une attente',
    shouldReplaceSettlement({ status: SETTLEMENT_STATUS.SETTLED }, { status: SETTLEMENT_STATUS.PENDING }) === false);
  check('…ni par un autre acquis : la première écriture fait foi',
    shouldReplaceSettlement({ status: SETTLEMENT_STATUS.SETTLED }, { status: SETTLEMENT_STATUS.SETTLED }) === false);
  check('une attente, elle, s’écrase librement',
    shouldReplaceSettlement({ status: SETTLEMENT_STATUS.PENDING }, { status: SETTLEMENT_STATUS.SETTLED }) === true);
  check('…et une observation vide n’écrase rien',
    shouldReplaceSettlement({ status: SETTLEMENT_STATUS.PENDING }, {}) === false);

  check('un revenu remonte à son écriture par l’INTENTION',
    settlementReferenceOf({ kind: 'REVENUE', corroboration: { paymentIntentId: 'pi_1' } }).paymentIntentId === 'pi_1');
  check('…un débit sert de repli quand l’intention manque',
    settlementReferenceOf({ kind: 'REVENUE', corroboration: { chargeId: 'ch_1' } }).chargeId === 'ch_1');
  check('un remboursement a sa PROPRE écriture, jamais celle du débit',
    settlementReferenceOf({ kind: 'REFUND', objectType: 'REFUND', objectId: 're_1' }).refundId === 're_1');
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('4. Le chemin complet : un encaissement, une charge, un net');
/* ══════════════════════════════════════════════════════════════════════════ */
let revenuId = null;
let coutId = null;
{
  ecritures.set('ch_l13_presta', ecriture({
    id: 'txn_l13_presta', source: 'ch_l13_presta', amount: 12_000, fee: 215, net: 11_785,
  }));

  await lier(PROJET, 'PAYMENT_INTENT', 'pi_l13_presta');
  const recu = await projection.recordStripeRevenueEvent({
    environment: 'TEST',
    eventType: 'invoice.paid',
    payload: evenement('invoice.paid', facture()),
    providerEventId: 'evt_l13_1',
  });
  check('le paiement est porté au registre', recu.status === 'PROJECTED');

  const fait = await factOf('in_l13_presta');
  revenuId = fait.transactionId;
  const revenu = await txOf(revenuId);

  check('LE CHIFFRE D’AFFAIRES RESTE LE BRUT — 120,00 €, pas 117,85 €',
    revenu.amountCents === 12_000 && revenu.category === 'REVENUE' && revenu.flow === 'INFLOW');

  await projection.settleProjectedFact(fait.factId);
  const soldé = await factOf('in_l13_presta');

  check('l’écriture de solde est inscrite sur le fait',
    soldé.settlement.status === 'SETTLED'
    && soldé.settlement.balanceTransactionId === 'txn_l13_presta');
  check('brut − frais = net, avec les chiffres du fournisseur',
    soldé.settlement.grossCents - soldé.settlement.providerFeeCents === soldé.settlement.netCents
    && soldé.settlement.providerFeeCents === 215
    && soldé.settlement.netCents === 11_785);

  coutId = soldé.settlement.feeTransactionId;
  const cout = await txOf(coutId);
  check('la commission est un MOUVEMENT à part, de catégorie COST',
    cout && cout.category === 'COST' && cout.flow === 'OUTFLOW' && cout.amountCents === 215);
  check('…rattachée au paiement qu’elle grève',
    cout.parentTransactionId === revenuId);
  check('…identifiée par l’écriture de solde, jamais par le document',
    cout.provenance.externalKind === 'BALANCE_TRANSACTION'
    && cout.provenance.externalId === 'txn_l13_presta');
  check('…datée du jour du PAIEMENT, pas du jour de l’observation',
    new Date(cout.effectiveDate).toISOString() === new Date(revenu.effectiveDate).toISOString());
  check('…et rattachée au même projet que le revenu',
    cout.projectId === PROJET && cout.projectId === revenu.projectId);
  check('la description nomme l’écriture de solde — la preuve est dans le registre',
    cout.description.includes('txn_l13_presta'));

  check('le revenu, lui, n’a pas bougé d’un centime',
    (await txOf(revenuId)).amountCents === 12_000);

  const ventilation = soldé.fiscal;
  check('HT / TVA / TTC viennent du DOCUMENT : 100 + 20 = 120',
    ventilation.netExcludingTaxCents === 10_000
    && ventilation.taxCents === 2_000
    && ventilation.grossIncludingTaxCents === 12_000);
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('5. Idempotence : même écriture observée dix fois = une seule charge');
/* ══════════════════════════════════════════════════════════════════════════ */
{
  const avant = await PanelFinancialTransaction.countDocuments({
    'provenance.externalKind': 'BALANCE_TRANSACTION',
  });

  const fait = await factOf('in_l13_presta');
  for (let i = 0; i < 5; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await reglement.captureSettlementForFact(fait.factId);
  }
  /** Le rejeu du webhook lui-même, qui repasse par toutes les suites. */
  await projection.recordStripeRevenueEvent({
    environment: 'TEST',
    eventType: 'invoice.paid',
    payload: evenement('invoice.paid', facture()),
    providerEventId: 'evt_l13_1',
  });

  const apres = await PanelFinancialTransaction.countDocuments({
    'provenance.externalKind': 'BALANCE_TRANSACTION',
  });
  check('cinq captures et un rejeu de webhook n’ont produit AUCUNE charge de plus',
    apres === avant);

  const rejeu = await reglement.captureSettlementForFact(fait.factId);
  check('…et la capture le DIT, plutôt que de le taire',
    rejeu.outcome === 'ALREADY_SETTLED');

  const revenus = await PanelFinancialTransaction.countDocuments({
    'provenance.externalId': 'in_l13_presta', deletedAt: null,
  });
  check('le paiement reste UNIQUE lui aussi', revenus === 1);
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('6. Ordre inversé : une attente n’efface jamais un acquis');
/* ══════════════════════════════════════════════════════════════════════════ */
{
  const fait = await factOf('in_l13_presta');

  /**
   * ON RETIRE L'ÉCRITURE CHEZ LE FOURNISSEUR, puis on recapture. C'est le
   * retardataire : une lecture partie avant que Stripe n'arrête ses comptes,
   * revenue après celle qui portait les chiffres.
   */
  const gardee = ecritures.get('ch_l13_presta');
  ecritures.delete('ch_l13_presta');
  debitsSansEcriture.add('ch_l13_presta');

  await reglement.captureSettlementForFact(fait.factId);
  const apres = await factOf('in_l13_presta');
  check('le frais acquis reste inscrit', apres.settlement.providerFeeCents === 215);
  check('…le statut reste SETTLED', apres.settlement.status === 'SETTLED');
  check('…et la charge n’a pas disparu du registre',
    (await txOf(apres.settlement.feeTransactionId)) !== null);

  ecritures.set('ch_l13_presta', gardee);
  debitsSansEcriture.delete('ch_l13_presta');
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('7. Absence temporaire, puis convergence — sans redémarrage magique');
/* ══════════════════════════════════════════════════════════════════════════ */
{
  const differee = facture({
    id: 'in_l13_differee',
    payment_intent: 'pi_l13_differee',
    charge: 'ch_l13_differee',
    number: 'FA-2026-0101',
  });
  debitsSansEcriture.add('ch_l13_differee');
  await lier(PROJET, 'PAYMENT_INTENT', 'pi_l13_differee');

  await projection.recordStripeRevenueEvent({
    environment: 'TEST',
    eventType: 'invoice.paid',
    payload: evenement('invoice.paid', differee),
    providerEventId: 'evt_l13_differee',
  });

  const attente = await factOf('in_l13_differee');
  check('le revenu est écrit MÊME SI les frais sont inconnus',
    attente.projectionStatus === 'PROJECTED' && attente.transactionId);
  check('…et l’attente est explicite, jamais un zéro',
    attente.settlement.status === 'PENDING'
    && attente.settlement.providerFeeCents === null
    && attente.settlement.feeTransactionId === null);

  /** Le fournisseur arrête enfin ses comptes. */
  debitsSansEcriture.delete('ch_l13_differee');
  ecritures.set('ch_l13_differee', ecriture({
    id: 'txn_l13_differee', source: 'ch_l13_differee', amount: 12_000, fee: 190, net: 11_810,
  }));

  const bilan = await reglement.convergePendingSettlements({});
  check('la convergence rattrape l’encaissement en attente', bilan.settled >= 1);

  const solde = await factOf('in_l13_differee');
  check('…et la commission rejoint le registre',
    solde.settlement.status === 'SETTLED'
    && solde.settlement.providerFeeCents === 190
    && (await txOf(solde.settlement.feeTransactionId))?.amountCents === 190);

  /** Le fait soldé ne doit plus jamais revenir dans la file. */
  const second = await reglement.convergePendingSettlements({});
  check('un encaissement soldé sort DÉFINITIVEMENT de la file', second.settled === 0);
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('8. Les agrégats : le CA reste brut, le bénéfice baisse');
/* ══════════════════════════════════════════════════════════════════════════ */
{
  const resume = await agregat.summarize({ scope: 'project', projectId: PROJET, period: 'ALL' });

  check('LES REVENUS RESTENT LE BRUT — 240,00 € pour deux ventes de 120 €',
    resume.byCategory.revenueCents === 24_000);
  check('LES COMMISSIONS SONT DES COÛTS — 4,05 €',
    resume.byCategory.costCents === 405);
  check('…et la ventilation le dit sans les compter deux fois',
    resume.costs.providerFeeCents === 405
    && resume.costs.totalCents === resume.byCategory.costCents
    && resume.costs.providerFeeCents + resume.costs.otherCents === resume.costs.totalCents);
  check('LE BÉNÉFICE BAISSE DU MONTANT DES COMMISSIONS',
    resume.totals.netCents === 24_000 - 405);
  check('…et le net fournisseur n’est JAMAIS compté comme un revenu de plus',
    resume.byCategory.revenueCents === 24_000);
  check('le détail par fournisseur reste générique',
    resume.costs.byProvider.STRIPE === 405);

  const parProjet = await agregat.summarizeByProject({ scope: 'all', period: 'ALL' });
  const ligne = parProjet.find((l) => l.projectId === PROJET);
  check('la répartition par projet porte la même ventilation',
    ligne.revenueCents === 24_000 && ligne.costCents === 405 && ligne.providerFeeCents === 405);
  check('…et son net est celui du bénéfice', ligne.netCents === 24_000 - 405);

  const voisin = parProjet.find((l) => l.projectId === AUTRE);
  check('le projet voisin ne porte AUCUNE commission — l’isolation tient',
    !voisin || (voisin.revenueCents === 0 && (voisin.providerFeeCents ?? 0) === 0));
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('9. Le read-model : brut, frais, net — et jamais « frais du frais »');
/* ══════════════════════════════════════════════════════════════════════════ */
{
  const liste = await transactions.listTransactions({ scope: 'project', projectId: PROJET, period: 'ALL' });

  const revenu = liste.items.find((t) => t.transactionId === revenuId);
  check('le revenu porte son encaissement net',
    revenu.settlement
    && revenu.settlement.grossCents === 12_000
    && revenu.settlement.providerCostCents === 215
    && revenu.settlement.netCents === 11_785);
  check('…sous des noms GÉNÉRIQUES — aucun champ ne s’appelle « stripe… »',
    Object.keys(revenu.settlement).every((k) => !k.toLowerCase().startsWith('stripe'))
    && revenu.settlement.provider === 'STRIPE');
  check('…avec la preuve de l’écriture de solde',
    revenu.settlement.balanceTransactionId === 'txn_l13_presta');
  check('…et le pont vers la charge produite',
    revenu.settlement.providerCostTransactionId === coutId);
  check('le revenu porte aussi la ventilation fiscale du document',
    revenu.fiscal.netExcludingTaxCents === 10_000 && revenu.fiscal.taxCents === 2_000);

  const cout = liste.items.find((t) => t.transactionId === coutId);
  check('la ligne de commission n’a PAS d’encaissement à elle — pas de « frais du frais »',
    cout && cout.settlement === undefined);

  const attente = liste.items.find((t) => t.provenance?.externalId === 'in_l13_differee');
  check('un encaissement soldé le dit', attente.settlement.status === 'SETTLED');

  /** Le montant affiché de la ligne reste le brut : c'est lui qui fait le CA. */
  check('le montant du mouvement n’est jamais remplacé par le net',
    revenu.amountCents === 12_000);
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('10. Les anciennes transactions restent lisibles');
/* ══════════════════════════════════════════════════════════════════════════ */
{
  /** Un revenu d'avant le lot : aucun fait, aucune observation. */
  await PanelFinancialTransaction.create({
    transactionId: 'legacy-l13',
    projectId: PROJET,
    flow: 'INFLOW',
    category: 'REVENUE',
    origin: 'STRIPE',
    status: 'RECORDED',
    label: 'Encaissement historique',
    amountCents: 9_900,
    currency: 'EUR',
    effectiveDate: new Date('2026-01-15T10:00:00Z'),
    provenance: {
      provider: 'STRIPE', environment: 'TEST',
      externalKind: 'INVOICE', externalId: 'in_avant_le_lot',
    },
  });

  const liste = await transactions.listTransactions({ scope: 'project', projectId: PROJET, period: 'ALL' });
  const ancienne = liste.items.find((t) => t.transactionId === 'legacy-l13');
  check('une transaction sans fait fournisseur se lit sans erreur', Boolean(ancienne));
  check('…et n’invente aucun frais', ancienne.settlement === undefined);

  const manuelle = await transactions.createManualTransaction({
    projectId: PROJET, category: 'COST', label: 'Hébergement', amount: '12,00',
    effectiveDate: '2026-08-01',
  }, ACTEUR);
  const relue = await transactions.getTransaction(manuelle.transactionId);
  check('une saisie manuelle n’a ni encaissement ni ventilation fiscale',
    relue.settlement === undefined && relue.fiscal === undefined);

  const resume = await agregat.summarize({ scope: 'project', projectId: PROJET, period: 'ALL' });
  check('…et le coût manuel n’entre PAS dans les commissions de paiement',
    resume.costs.providerFeeCents === 405 && resume.costs.otherCents === 1_200);
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('11. Le remboursement : ce que le fournisseur rend, et ce qu’il garde');
/* ══════════════════════════════════════════════════════════════════════════ */
{
  /**
   * L'OBSERVATION EST CELLE DE STRIPE, PAS UNE HYPOTHÈSE.
   *
   * Sur le compte de recette, un remboursement produit une écriture de
   * `fee: 0` — la commission du paiement d'origine n'est PAS rendue. Le Panel
   * n'en déduit rien : il écrit ce qu'il lit, et n'écrit aucun mouvement quand
   * le frais est nul.
   */
  ecritures.set('bt_re_l13', ecriture({
    id: 'txn_l13_refund', source: 're_l13', amount: -12_000, fee: 0, net: -12_000, type: 'refund',
  }));

  const recu = await projection.recordStripeRefundResponse({
    environment: 'TEST',
    refund: {
      id: 're_l13', object: 'refund', amount: 12_000, currency: 'eur', status: 'succeeded',
      payment_intent: 'pi_l13_presta', charge: 'ch_l13_presta',
      created: SECONDES('2026-08-23T10:00:00Z'), livemode: false,
    },
  });
  check('le remboursement est porté au registre', recu.status === 'PROJECTED');

  const fait = await factOf('re_l13');
  await projection.settleProjectedFact(fait.factId);
  const solde = await factOf('re_l13');

  check('un remboursement a SA PROPRE écriture de solde',
    solde.settlement.status === 'SETTLED'
    && solde.settlement.balanceTransactionId === 'txn_l13_refund');
  check('…dont le montant est négatif, tel que le fournisseur le voit',
    solde.settlement.grossCents === -12_000);
  check('COMMISSION NON RESTITUÉE : aucun mouvement, et c’est ce qui est OBSERVÉ',
    solde.settlement.providerFeeCents === 0 && solde.settlement.feeTransactionId === null);

  const rembourse = await txOf(solde.transactionId);
  check('le remboursement lui-même reste POSITIF et de catégorie REFUND',
    rembourse.amountCents === 12_000 && rembourse.category === 'REFUND' && rembourse.flow === 'OUTFLOW');

  const resume = await agregat.summarize({ scope: 'project', projectId: PROJET, period: 'ALL' });
  check('un remboursement ne devient JAMAIS un coût d’exploitation',
    resume.byCategory.costCents === 405 + 1_200 && resume.byCategory.refundCents === 12_000);
  check('…et la commission du paiement d’origine reste due',
    resume.costs.providerFeeCents === 405);
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('12. Le registre de solde est HORS de la surface des projets');
/* ══════════════════════════════════════════════════════════════════════════ */
{
  const definition = registreCapacites.getCapabilityDefinition('billing.settlement.retrieve');
  check('la capacité existe et se déclare hors surface projet',
    definition && definition.panelOnly === true);

  let refus = null;
  try {
    await passerelle.invokeCapability({
      code: 'billing.settlement.retrieve',
      source: INVOCATION_SOURCES.PROJECT_BRIDGE,
      panelProject: { projectId: PROJET, projectName: 'Atelier L13', runtime: { environment: 'TEST' } },
      payload: { paymentIntentId: 'pi_l13_presta' },
    });
  } catch (err) {
    refus = err;
  }
  check('un projet appairé ne peut PAS l’invoquer par le pont', refus !== null);
  check('…et le refus est INDISTINCT d’un code inconnu — jamais un oracle',
    refus.code === 'CAPABILITY_UNKNOWN');

  /** Aucune autre capacité n'est fermée : la fermeture est une exception. */
  const fermees = registreCapacites.listCapabilityDefinitions().filter((c) => c.panelOnly);
  check('elle est la SEULE capacité fermée du registre',
    fermees.length === 1 && fermees[0].code === 'billing.settlement.retrieve');
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('13. Isolation par projet et par monde');
/* ══════════════════════════════════════════════════════════════════════════ */
{
  /** Un encaissement de PROD ne se solde pas depuis une instance de recette. */
  const factId = (await factOf('in_l13_presta')).factId;
  await PanelProviderRevenueFact.updateOne({ factId }, { $set: { environment: 'PROD' } });
  const verdict = await reglement.captureSettlementForFact(factId);
  check('un fait d’un AUTRE monde n’est jamais soldé ici',
    verdict.outcome === 'ALREADY_SETTLED' || verdict.reason === 'ENVIRONMENT_MISMATCH');
  await PanelProviderRevenueFact.updateOne({ factId }, { $set: { environment: 'TEST' } });

  const coutsVoisin = await PanelFinancialTransaction.countDocuments({
    projectId: AUTRE, 'provenance.externalKind': 'BALANCE_TRANSACTION',
  });
  check('aucune commission n’a fui vers le projet voisin', coutsVoisin === 0);
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('14. AUCUNE formule tarifaire dans le dépôt');
/* ══════════════════════════════════════════════════════════════════════════ */
{
  /**
   * LE CONTRÔLE QUI EMPÊCHE LE LOT DE SE DÉFAIRE.
   *
   * Le jour où quelqu'un voudra « afficher les frais tout de suite », la
   * tentation sera d'écrire `montant * 0.015 + 25`. Ce balayage rend cette
   * ligne impossible à ajouter sans faire échouer la recette — et le message
   * d'échec dit pourquoi.
   */
  const fichiers = [
    'backend/src/services/finance/providerRevenue/providerSettlement.service.js',
    'backend/src/services/integratedApi/stripe/stripeSettlementAuthority.js',
    'backend/src/services/integratedApi/stripe/stripeAdapters.js',
    'backend/src/services/finance/financialSummary.service.js',
    'frontend/src/components/finance/SettlementBreakdown.tsx',
  ];
  /** Les barèmes Stripe européens et internationaux, sous leurs formes usuelles. */
  const bareme = /(?:0?\.014|0?\.015|0?\.0175|0?\.029|0?\.0325|1\.4\s*%|1\.5\s*%|2\.9\s*%|3\.25\s*%)/;
  const coupables = fichiers.filter((rel) => {
    const contenu = fs.readFileSync(path.join(RACINE, rel), 'utf8');
    /** Les commentaires ont le droit de CITER un barème pour dire qu'on ne le
     *  calcule pas ; le code, non. On ne garde donc que les lignes de code. */
    return contenu.split('\n').some((ligne) => {
      const nue = ligne.trim();
      if (nue.startsWith('*') || nue.startsWith('//') || nue.startsWith('/*')) return false;
      return bareme.test(nue);
    });
  });
  check(`aucun barème tarifaire codé en dur${coupables.length ? ` — ${coupables.join(', ')}` : ''}`,
    coupables.length === 0);

  const service = fs.readFileSync(
    path.join(RACINE, 'backend/src/services/finance/providerRevenue/providerSettlement.service.js'), 'utf8',
  );
  check('le service de frais ne fait aucune multiplication de montant',
    !/amountCents\s*\*|grossCents\s*\*/.test(service));
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('15. Aucun écran financier n’appelle le fournisseur');
/* ══════════════════════════════════════════════════════════════════════════ */
{
  const avant = appels.length;
  await transactions.listTransactions({ scope: 'project', projectId: PROJET, period: 'ALL' });
  await agregat.summarize({ scope: 'project', projectId: PROJET, period: 'ALL' });
  await call('GET', `/api/finances/transactions?scope=project&projectId=${PROJET}&period=ALL`, { headers: AUTH });
  await call('GET', `/api/finances/summary?scope=project&projectId=${PROJET}&period=ALL`, { headers: AUTH });
  check('lister et résumer n’a produit AUCUN appel Stripe', appels.length === avant);

  const detail = await call('GET', `/api/finances/transactions/${revenuId}`, { headers: AUTH });
  check('le détail d’un mouvement non plus', appels.length === avant && detail.status === 200);
  check('…et il porte l’écriture de solde dans ses références techniques',
    detail.json.data.providerFact?.settlement?.balanceTransactionId === 'txn_l13_presta');
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('16. Le webhook ne dit rien du règlement — la facture, elle, le dit');
/* ══════════════════════════════════════════════════════════════════════════ */
{
  /**
   * LE DÉFAUT QUE LA RECETTE DÉPLOYÉE A RÉVÉLÉ, ET QU'AUCUN CONTRÔLE LOCAL
   * N'AURAIT ATTRAPÉ.
   *
   * Le compte de recette émet ses webhooks en `2026-06-24.dahlia`. Dans cette
   * version, un `invoice.paid` ne porte NI `charge`, NI `payment_intent`, NI
   * `payments.data` — la sous-liste arrive VIDE et exige une expansion. Le fait
   * normalisé n'avait donc aucune référence de règlement, et la capture rendait
   * `NO_PAYMENT_REFERENCE` : honnête, et sans issue.
   *
   * C'est le même défaut qu'en L10.7, un champ plus loin. La correction est
   * donc la même doctrine : ne pas dépendre du champ qu'un webhook expose, mais
   * repartir de l'identité CANONIQUE que le Panel possède, et relire chez le
   * fournisseur avec SA version d'API épinglée.
   */
  const nue = facture({
    id: 'in_l13_webhook_muet',
    number: 'FA-2026-0102',
    /** Ce que la version récente NE dit PAS. */
    payment_intent: undefined,
    charge: undefined,
    payments: { data: [] },
  });
  delete nue.payment_intent;
  delete nue.charge;

  /** La relecture, elle, rend le règlement — comme le vrai Stripe. */
  facturesReglees.set('in_l13_webhook_muet', {
    id: 'in_l13_webhook_muet',
    object: 'invoice',
    payments: { data: [{ status: 'paid', payment: { payment_intent: 'pi_l13_muet' } }] },
  });
  ecritures.set('ch_l13_muet', ecriture({
    id: 'txn_l13_muet', source: 'ch_l13_muet', amount: 12_000, fee: 205, net: 11_795,
  }));

  /**
   * L'APPARTENANCE SE PROUVE PAR LA FACTURE ELLE-MÊME.
   *
   * Sans intention à plat, le normalisateur n'a plus de filiation à proposer :
   * c'est exactement la situation de L10.7, et c'est le graphe interne qui
   * répond — la session a lié sa facture avant même qu'elle soit payée.
   */
  await lier(PROJET, 'INVOICE', 'in_l13_webhook_muet');

  const recu = await projection.recordStripeRevenueEvent({
    environment: 'TEST',
    eventType: 'invoice.paid',
    payload: evenement('invoice.paid', nue),
    providerEventId: 'evt_l13_muet',
  });
  check('le revenu est porté au registre malgré un webhook muet',
    recu.status === 'PROJECTED');

  /**
   * LE FAIT TEL QUE LE WEBHOOK LE PRODUIT — avant toute relecture.
   *
   * On l'observe sur le NORMALISATEUR, qui est pur : la projection, elle,
   * enchaîne déjà ses suites, et le fait persisté a donc appris entre-temps ce
   * que la relecture lui a rendu. Les deux sont vrais, à deux instants
   * différents, et c'est le premier qui décrit le défaut.
   */
  const brut = normalizer.normalizeStripeRevenueEvent({
    eventType: 'invoice.paid',
    payload: evenement('invoice.paid', nue),
    environment: 'TEST',
  }).fact;
  check('le fait NÉ du webhook ne porte AUCUNE référence de règlement',
    !brut.corroboration.paymentIntentId && !brut.corroboration.chargeId);
  check('…et la résolution repart alors de l’objet CANONIQUE',
    reglement.settlementReferenceOf({
      kind: 'REVENUE', objectType: 'INVOICE', objectId: brut.objectId, corroboration: brut.corroboration,
    }).invoiceId === 'in_l13_webhook_muet');

  const fait = await factOf('in_l13_webhook_muet');
  await projection.settleProjectedFact(fait.factId);
  const solde = await factOf('in_l13_webhook_muet');
  check('la commission est retrouvée par relecture de la facture',
    solde.settlement.status === 'SETTLED'
    && solde.settlement.balanceTransactionId === 'txn_l13_muet'
    && solde.settlement.providerFeeCents === 205);
  check('…et la charge est écrite au registre',
    (await txOf(solde.settlement.feeTransactionId))?.amountCents === 205);
  check('brut − frais = net, sur les chiffres du fournisseur',
    solde.settlement.grossCents - solde.settlement.providerFeeCents === solde.settlement.netCents);

  /**
   * ── ET LE FAIT APPREND CE QU'IL NE SAVAIT PAS ─────────────────────────────
   *
   * Le défaut ne touchait pas que les frais : le REMBOURSEMENT de L10.4 exige
   * l'intention de paiement, et la recette déployée a répondu
   * `PANEL_REFUND_NO_PAYMENT_INTENT` sur un encaissement parfaitement réel — le
   * Panel ne pouvait plus rendre l'argent d'un client.
   *
   * La capture vient de retrouver cette intention. L'inscrire sur le fait
   * répare le remboursement sans toucher une ligne de L10.4.
   */
  check('le fait APPREND l’intention que le webhook ne portait pas',
    solde.corroboration.paymentIntentId === 'pi_l13_muet');
  check('…et le débit avec elle', solde.corroboration.chargeId === 'ch_l13_muet');

  /** On ne remplit qu'un VIDE : une identité déjà connue n'est jamais réécrite. */
  const dejaConnu = await factOf('in_l13_presta');
  check('une identité déjà présente n’est pas réécrite',
    dejaConnu.corroboration.paymentIntentId === 'pi_l13_presta');

  /**
   * ── LE GARDE-FOU SE REFERME, ET UNE SEULE FOIS ────────────────────────────
   *
   * « Soldé » ne suffisait pas : un encaissement peut porter ses chiffres et
   * pas son identité de règlement — c'est le cas de tous ceux qui ont été
   * soldés avant que la relecture n'existe. Un tel fait n'est pas « déjà
   * fait », et on le laisse repasser UNE fois. Maintenant qu'il est complet,
   * il ne repasse plus.
   */
  const apresApprentissage = await reglement.captureSettlementForFact(fait.factId);
  check('un encaissement COMPLET n’est plus jamais réinterrogé',
    apresApprentissage.outcome === 'ALREADY_SETTLED');

  const charges = await PanelFinancialTransaction.countDocuments({
    'provenance.externalId': 'txn_l13_muet',
  });
  check('…et le repassage n’a produit aucune seconde charge', charges === 1);

  /**
   * ── LES ENCAISSEMENTS DÉJÀ EN BASE SONT RATTRAPÉS, EUX AUSSI ──────────────
   *
   * Sans cela, la réparation n'aurait touché que les paiements FUTURS, et le
   * remboursement serait resté impossible sur ceux qui existent déjà —
   * c'est-à-dire exactement ceux dont un client peut réclamer l'argent.
   */
  await PanelProviderRevenueFact.updateOne(
    { objectId: 'in_l13_webhook_muet' },
    { $set: { 'corroboration.paymentIntentId': null } },
  );
  const rattrapage = await reglement.convergePendingSettlements({});
  check('un encaissement soldé mais INCOMPLET rentre dans la file',
    (await factOf('in_l13_webhook_muet')).corroboration.paymentIntentId === 'pi_l13_muet');
  /**
   * LE RATTRAPAGE REPASSE, ET NE DUPLIQUE RIEN.
   *
   * Il compte bien un encaissement soldé — il l'a réexaminé — mais l'index
   * unique et le refus de remplacer un `SETTLED` garantissent que rien n'a
   * bougé au registre. C'est la définition même d'une convergence : on peut la
   * rejouer sans conséquence.
   */
  check('le rattrapage a bien réexaminé le fait', rattrapage.examined >= 1);
  check('…sans produire de seconde charge',
    (await PanelFinancialTransaction.countDocuments({ 'provenance.externalId': 'txn_l13_muet' })) === 1);
  check('…ni modifier le frais déjà acquis',
    (await factOf('in_l13_webhook_muet')).settlement.providerFeeCents === 205);

  /**
   * UNE FACTURE SOLDÉE SANS RÈGLEMENT — avoir, ou solde client. Aucun euro n'a
   * traversé le réseau de cartes, donc aucune commission. C'est une IMPASSE,
   * et le compteur de tentatives doit la borner.
   */
  facturesReglees.set('in_l13_sans_reglement', {
    id: 'in_l13_sans_reglement', object: 'invoice', payments: { data: [] },
  });
  const avoir = facture({ id: 'in_l13_sans_reglement', number: 'FA-2026-0103' });
  delete avoir.payment_intent;
  delete avoir.charge;
  await lier(PROJET, 'INVOICE', 'in_l13_sans_reglement');
  await projection.recordStripeRevenueEvent({
    environment: 'TEST',
    eventType: 'invoice.paid',
    payload: evenement('invoice.paid', avoir),
    providerEventId: 'evt_l13_avoir',
  });
  const sansFrais = await factOf('in_l13_sans_reglement');
  check('une facture sans règlement est une IMPASSE nommée',
    sansFrais.settlement.status === 'UNAVAILABLE'
    && sansFrais.settlement.reason === 'NO_PAYMENT_REFERENCE');
  check('…et aucune charge n’est inventée',
    sansFrais.settlement.feeTransactionId === null);
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('17. Un verdict n’est vrai que pour le code qui l’a produit');
/* ══════════════════════════════════════════════════════════════════════════ */
{
  /**
   * POURQUOI `UNAVAILABLE` REVIENT DANS LA FILE.
   *
   * Il en avait d'abord été exclu — « il n'y a rien à attendre » — et la recette
   * déployée a montré le coût de cette certitude : le verdict était exact au
   * moment où il a été rendu, et il est devenu faux dès qu'une voie de
   * résolution supplémentaire a existé. Exclu, il aurait figé une commission
   * manquante pour toujours, en silence.
   *
   * Ce qui borne le coût n'est pas le statut : c'est le COMPTEUR DE TENTATIVES.
   */
  const fait = await factOf('in_l13_sans_reglement');
  const avant = fait.settlement.attempts;
  check('une impasse incrémente son compteur, même sans appel fournisseur', avant >= 1);

  const bilan = await reglement.convergePendingSettlements({});
  const apres = await factOf('in_l13_sans_reglement');
  check('…et elle est BIEN réexaminée par la convergence',
    apres.settlement.attempts > avant);
  check('la convergence ne solde rien qui ne puisse l’être', bilan.settled === 0);

  /** Au-delà de la borne, elle sort d'elle-même : pas d'appel horaire éternel. */
  await PanelProviderRevenueFact.updateOne(
    { factId: fait.factId },
    { $set: { 'settlement.attempts': reglement.MAX_TENTATIVES_SETTLEMENT } },
  );
  const verdict = await reglement.captureSettlementForFact(fait.factId);
  check('au-delà de la borne, on cesse de réessayer tout seul',
    verdict.outcome === 'ABANDONED');
  check('…mais le motif reste lisible pour un exploitant',
    (await factOf('in_l13_sans_reglement')).settlement.reason === 'NO_PAYMENT_REFERENCE');

  /** Une devise non gérée, elle, ne dépend d'aucune résolution : elle reste dehors. */
  const codeSource = fs.readFileSync(
    path.join(RACINE, 'backend/src/services/finance/providerRevenue/providerSettlement.service.js'), 'utf8',
  );
  check('`UNUSABLE` reste hors de la file — aucune relecture ne change une devise',
    !/'settlement\.status': SETTLEMENT_STATUS\.UNUSABLE/.test(codeSource));
}

await close();
await new Promise((resolve) => fauxStripe.close(resolve));
await stopMemoryMongo();
finish();
