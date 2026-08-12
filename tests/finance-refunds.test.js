/**
 * L10.4 — REMBOURSEMENTS STRIPE.
 *
 * Ce que ces contrôles verrouillent :
 *
 *   · qu'un remboursement soit un mouvement DISTINCT — `REFUND / OUTFLOW`,
 *     montant positif — et que l'encaissement d'origine reste intact ;
 *   · qu'il n'entre JAMAIS dans les coûts, quel que soit l'écran ;
 *   · que son identité externe soit `re_…` et jamais celle du paiement ;
 *   · qu'un double clic, une réponse perdue, un webhook et un rejeu produisent
 *     UN remboursement chez Stripe et UNE ligne au registre ;
 *   · qu'une issue inconnue ne se lise jamais « échec », et ne propose jamais
 *     d'en créer un second ;
 *   · qu'un projet ne puisse pas rembourser le paiement d'un autre ;
 *   · qu'aucun identifiant Stripe ne puisse entrer par le navigateur ;
 *   · que le monde soit DÉRIVÉ du paiement, jamais choisi ;
 *   · que retirer un encaissement remboursé soit refusé, parce qu'il laisserait
 *     une perte qui n'a pas eu lieu.
 *
 * Stripe est remplacé par un serveur local qui COMPTE les mutations reçues :
 * c'est ce compteur, et non un état applicatif, qui prouve le non-doublon.
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

/* ══════════════════════════════════════════════════════════════════════════
   UN FAUX STRIPE QUI SE SOUVIENT — clés d'idempotence, remboursements émis.
   ══════════════════════════════════════════════════════════════════════════ */

const appels = [];
/** Les remboursements RÉELLEMENT créés, par intention de paiement. */
const remboursementsParPaiement = new Map();
/** Ce que la fenêtre d'idempotence de Stripe mémorise. */
const parCleIdempotence = new Map();
const paiements = new Map();

let sequenceRefund = 0;
/** Bascules de scénario — la panne se pilote, elle ne s'attend pas. */
let prochainAppelMuet = false;
let prochainAppelRefuse = null;
/** Simule l'expiration de la fenêtre d'idempotence de Stripe. */
let oublierLesCles = false;

const fauxStripe = http.createServer((req, res) => {
  let corps = '';
  req.on('data', (c) => { corps += c; });
  req.on('end', () => {
    const cle = req.headers['idempotency-key'] ?? null;
    appels.push({ method: req.method, url: req.url, idempotencyKey: cle, body: corps });

    const repondre = (code, objet) => {
      res.writeHead(code, { 'content-type': 'application/json', 'request-id': `req_${appels.length}` });
      res.end(JSON.stringify(objet));
    };

    if (prochainAppelMuet && req.method === 'POST') {
      prochainAppelMuet = false;
      /** On ne répond PAS : le client va expirer. L'issue devient indécidable. */
      return undefined;
    }
    if (prochainAppelRefuse && req.method === 'POST') {
      const erreur = prochainAppelRefuse;
      prochainAppelRefuse = null;
      return repondre(402, { error: { code: erreur, message: 'refus simulé' } });
    }

    /* ── Lecture d'une intention de paiement ─────────────────────────────── */
    const lecturePi = /^\/v1\/payment_intents\/([^/?]+)/.exec(req.url ?? '');
    if (req.method === 'GET' && lecturePi) {
      const pi = paiements.get(decodeURIComponent(lecturePi[1]));
      if (!pi) return repondre(404, { error: { code: 'resource_missing', message: 'introuvable' } });
      return repondre(200, pi);
    }

    /* ── Liste des remboursements d'un paiement ──────────────────────────── */
    if (req.method === 'GET' && (req.url ?? '').startsWith('/v1/refunds?')) {
      const params = new URLSearchParams((req.url ?? '').split('?')[1]);
      const pi = params.get('payment_intent');
      return repondre(200, { object: 'list', has_more: false, data: remboursementsParPaiement.get(pi) ?? [] });
    }

    /* ── Création d'un remboursement ─────────────────────────────────────── */
    if (req.method === 'POST' && req.url === '/v1/refunds') {
      if (cle && !oublierLesCles && parCleIdempotence.has(cle)) {
        /** LA FENÊTRE D'IDEMPOTENCE — Stripe rend le MÊME objet, sans rien créer. */
        return repondre(200, parCleIdempotence.get(cle));
      }
      const params = new URLSearchParams(corps);
      const pi = params.get('payment_intent');
      const intention = paiements.get(pi);
      if (!intention) return repondre(404, { error: { code: 'resource_missing', message: 'introuvable' } });

      const deja = (remboursementsParPaiement.get(pi) ?? [])
        .reduce((somme, r) => somme + (r.status === 'failed' || r.status === 'canceled' ? 0 : r.amount), 0);
      const restant = intention.amount_received - deja;
      const demande = params.get('amount') ? Number(params.get('amount')) : restant;

      /** LA PROTECTION ATOMIQUE : Stripe refuse tout dépassement. */
      if (demande > restant) {
        return repondre(400, {
          error: { code: 'charge_already_refunded', message: 'Montant supérieur au remboursable.' },
        });
      }

      sequenceRefund += 1;
      const refund = {
        id: `re_test_${sequenceRefund}`,
        object: 'refund',
        amount: demande,
        currency: intention.currency,
        status: 'succeeded',
        reason: params.get('reason') ?? null,
        created: Math.floor(Date.parse('2026-08-20T10:00:00Z') / 1000),
        payment_intent: pi,
        charge: intention.latest_charge?.id ?? null,
        metadata: { ly_operation_id: params.get('metadata[ly_operation_id]') ?? null },
      };
      const liste = remboursementsParPaiement.get(pi) ?? [];
      liste.push(refund);
      remboursementsParPaiement.set(pi, liste);
      if (cle) parCleIdempotence.set(cle, refund);
      return repondre(200, refund);
    }

    /* ── Validation de clé (coffre) ──────────────────────────────────────── */
    if (req.method === 'GET' && (req.url ?? '').startsWith('/v1/account')) {
      return repondre(200, { id: 'acct_test', object: 'account', charges_enabled: true, livemode: false });
    }

    return repondre(404, { error: { message: 'route inconnue' } });
  });
});

await new Promise((resolve) => fauxStripe.listen(0, '127.0.0.1', resolve));
const STRIPE_BASE = `http://127.0.0.1:${fauxStripe.address().port}`;

/** Les mutations RÉELLEMENT reçues — le compteur qui prouve le non-doublon. */
const creationsRemboursement = () => appels.filter((a) => a.method === 'POST' && a.url === '/v1/refunds');

/* ══════════════════════════════════════════════════════════════════════════ */

const { createApp } = await import('../backend/src/app.js');
const { seedFromEnv } = await import('../backend/src/services/auth/panelUsers.service.js');
const PanelProject = (await import('../backend/src/models/PanelProject.model.js')).default;
const {
  PanelFinancialTransaction, CATEGORIES, FLOWS, ORIGINS,
} = await import('../backend/src/models/PanelFinancialTransaction.model.js');
const PanelProviderRevenueFact = (await import('../backend/src/models/PanelProviderRevenueFact.model.js')).default;
const {
  PanelRefundRequest, REFUND_REQUEST_STATUS,
} = await import('../backend/src/models/PanelRefundRequest.model.js');
const normalizer = await import('../backend/src/services/finance/providerRevenue/stripeRevenueNormalizer.js');
const projection = await import('../backend/src/services/finance/providerRevenue/revenueProjection.service.js');
const refunds = await import('../backend/src/services/finance/refunds/refundOrchestration.service.js');
const autorite = await import('../backend/src/services/integratedApi/stripe/stripeRefundAuthority.js');
const bindings = await import('../backend/src/services/integratedApi/stripe/stripeResourceBinding.js');
const agregat = await import('../backend/src/services/finance/financialSummary.service.js');
const registre = await import('../backend/src/services/finance/financialTransactions.service.js');
const controlPlane = await import('../backend/src/services/integratedApi/controlPlane.service.js');
const { seedIntegratedApiCredentialSets } = await import('../backend/src/services/integratedApi/seed.js');

await seedFromEnv();
await seedIntegratedApiCredentialSets();
await PanelFinancialTransaction.init();
await PanelProviderRevenueFact.init();
await PanelRefundRequest.init();

const ACTEUR = { email: 'dev@panel.test', role: 'DEV' };
await controlPlane.saveCredentialSet('STRIPE', 'TEST', {
  values: { secretKey: 'sk_test_panel_l104', baseUrl: STRIPE_BASE },
}, ACTEUR);
/** Le coffre ne sert que des identifiants VALIDÉS — doctrine L6. */
await controlPlane.validateCredentialSet('STRIPE', 'TEST', { actor: ACTEUR });

const { call, close } = await startServer(createApp());
const login = await call('POST', '/api/auth/login', {
  body: { email: 'dev@panel.test', password: 'motdepasse-test' },
});
const AUTH = { authorization: `Bearer ${login.json.data.token}` };

const PROJET_A = 'atelier-nord';
const PROJET_B = 'atelier-sud';

async function declarer(projectId, projectName) {
  const now = new Date().toISOString();
  await PanelProject.create({
    projectId, projectKey: projectId, projectName,
    createdAt: now, updatedAt: now,
    pairing: { status: 'PAIRED' },
    runtime: { environment: 'TEST' },
    /** LIVE : un remboursement est un FINANCIAL_WRITE, refusé en pré-ouverture. */
    commercialState: 'LIVE',
    capabilityGrants: [],
  });
}
await declarer(PROJET_A, 'Atelier du Nord');
await declarer(PROJET_B, 'Atelier du Sud');

/* ── Fabriques ─────────────────────────────────────────────────────────────── */
const SECONDES = (iso) => Math.floor(new Date(iso).getTime() / 1000);

const evenement = (type, objet, { created = '2026-07-10T10:00:00Z', id = null } = {}) => ({
  id: id ?? `evt_${Math.random().toString(36).slice(2, 12)}`,
  type,
  created: SECONDES(created),
  data: { object: objet },
});

/**
 * INSTALLE UN ENCAISSEMENT COMPLET — côté Stripe et côté Panel.
 *
 * La session est liée au projet (L6.2B), l'événement est projeté (L10.3), et
 * l'intention de paiement est adoptée par filiation (L10.4). C'est l'état
 * normal d'un revenu du parc, et le point de départ de chaque scénario.
 */
async function encaisser({
  projectId, sessionId, paymentIntentId, chargeId, amountCents,
  payeLe = '2026-07-10T09:00:00Z',
}) {
  await bindings.bindResource({
    projectId,
    environment: 'TEST',
    resourceType: bindings.STRIPE_RESOURCE_TYPES.CHECKOUT_SESSION,
    resourceId: sessionId,
    source: bindings.BINDING_SOURCES.PANEL_CREATED,
  });

  paiements.set(paymentIntentId, {
    id: paymentIntentId,
    object: 'payment_intent',
    amount: amountCents,
    amount_received: amountCents,
    currency: 'eur',
    latest_charge: {
      id: chargeId,
      object: 'charge',
      receipt_url: `https://pay.stripe.test/receipts/${chargeId}`,
    },
  });

  const resultat = await projection.recordStripeRevenueEvent({
    environment: 'TEST',
    eventType: 'checkout.session.completed',
    payload: evenement('checkout.session.completed', {
      id: sessionId,
      object: 'checkout.session',
      mode: 'payment',
      payment_status: 'paid',
      amount_total: amountCents,
      currency: 'eur',
      created: SECONDES(payeLe),
      customer: 'cus_test',
      payment_intent: paymentIntentId,
      invoice: null,
      subscription: null,
      livemode: false,
      metadata: { panelProjectId: projectId, contractId: 'ct-1', paymentType: 'SETUP_FEE' },
    }, { created: payeLe }),
    providerEventId: `evt_${sessionId}`,
  });

  const fait = await PanelProviderRevenueFact.findOne({ objectId: sessionId }).lean();
  return { transactionId: fait.transactionId, projete: resultat };
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('1. L\'autorité du remboursement — pure, et elle ne devine rien');
{
  const id = autorite.refundOperationId({ environment: 'TEST', refundRequestId: 'abc-123' });
  check('l\'identité de l\'acte dérive de la DEMANDE, pas du paiement',
    id === 'stripe-refund:test:abc-123');

  /**
   * LE POINT QUI JUSTIFIE TOUT LE MODULE : deux remboursements partiels du même
   * paiement sont deux actes légitimes. Une identité dérivée du paiement les
   * confondrait, et le second serait éternellement vu comme « déjà fait ».
   */
  const a = autorite.refundOperationId({ environment: 'TEST', refundRequestId: 'demande-1' });
  const b = autorite.refundOperationId({ environment: 'TEST', refundRequestId: 'demande-2' });
  check('deux demandes distinctes portent deux identités distinctes', a !== b);

  const memeMonde = autorite.refundOperationId({ environment: 'PROD', refundRequestId: 'abc-123' });
  check('le monde fait partie de l\'identité', memeMonde !== id);

  const trouve = autorite.findOwnRefund({
    refunds: [
      { id: 're_1', metadata: { ly_operation_id: 'autre' } },
      { id: 're_2', metadata: { ly_operation_id: 'stripe-refund:test:abc-123' } },
    ],
    operationId: 'stripe-refund:test:abc-123',
  });
  check('notre acte se reconnaît par sa métadonnée, hors fenêtre d\'idempotence',
    trouve.state === autorite.REFUND_ACT_STATE.ALREADY_DONE && trouve.refund.id === 're_2');

  const absent = autorite.findOwnRefund({
    refunds: [{ id: 're_1', metadata: { ly_operation_id: 'autre' } }],
    operationId: 'stripe-refund:test:abc-123',
  });
  check('un remboursement d\'un AUTRE acte ne fait pas conclure « déjà fait »',
    absent.state === autorite.REFUND_ACT_STATE.NOT_DONE);

  const montants = autorite.describeRefundableAmount({
    paymentIntent: { amount_received: 50_000 },
    refunds: [
      { amount: 10_000, status: 'succeeded' },
      { amount: 5_000, status: 'pending' },
      { amount: 9_999, status: 'failed' },
      { amount: 8_888, status: 'canceled' },
    ],
  });
  check('un remboursement en attente COMPTE — l\'argent est engagé',
    montants.refundedCents === 15_000);
  check('un remboursement échoué ou annulé ne compte PAS',
    montants.remainingCents === 35_000);

  const illisible = autorite.describeRefundableAmount({
    paymentIntent: { amount_received: 50_000 },
    refunds: [{ amount: 'beaucoup', status: 'succeeded' }],
  });
  check('une somme non chiffrable ne rend RIEN plutôt qu\'un total faux',
    illisible === null);
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('2. Le normalisateur — un `re_…` par remboursement, quelle que soit la voie');
{
  const { fact } = normalizer.normalizeStripeRefundObject({
    environment: 'TEST',
    refund: {
      id: 're_abc', amount: 10_000, currency: 'eur', status: 'succeeded',
      reason: 'requested_by_customer', created: SECONDES('2026-08-20T10:00:00Z'),
      payment_intent: 'pi_x', charge: 'ch_x',
    },
    chargeReceiptUrl: 'https://pay.stripe.test/receipts/ch_x',
  });
  check('l\'objet canonique est le REMBOURSEMENT', fact.objectType === 'REFUND');
  check('son identité est `re_…`, jamais celle du paiement', fact.objectId === 're_abc');
  check('le montant reste POSITIF — le sens vit dans le flux', fact.amountCents === 10_000);
  check('le paiement d\'origine est conservé pour la filiation',
    fact.corroboration.paymentIntentId === 'pi_x');
  check('le reçu de la charge est le seul document réel',
    fact.chargeReceiptUrl === 'https://pay.stripe.test/receipts/ch_x');

  const echoue = normalizer.normalizeStripeRefundObject({
    environment: 'TEST',
    refund: { id: 're_ko', amount: 10_000, currency: 'eur', status: 'failed' },
  });
  check('un remboursement ÉCHOUÉ ne produit aucun fait : rien n\'est reparti',
    echoue.fact === null);

  /** Un `charge.refunded` réannonce TOUS les remboursements du débit. */
  const { facts } = normalizer.normalizeStripeRefundEvent({
    eventType: 'charge.refunded',
    environment: 'TEST',
    payload: evenement('charge.refunded', {
      id: 'ch_multi',
      object: 'charge',
      payment_intent: 'pi_multi',
      receipt_url: 'https://pay.stripe.test/receipts/ch_multi',
      refunds: {
        data: [
          { id: 're_un', amount: 5_000, currency: 'eur', status: 'succeeded', created: 1 },
          { id: 're_deux', amount: 3_000, currency: 'eur', status: 'succeeded', created: 2 },
        ],
      },
    }),
  });
  check('un seul événement peut porter PLUSIEURS remboursements', facts.length === 2);
  check('la charge complète les identités que l\'objet imbriqué omet',
    facts.every((f) => f.corroboration.paymentIntentId === 'pi_multi'));

  const litige = normalizer.normalizeStripeRefundEvent({
    eventType: 'charge.dispute.created',
    environment: 'TEST',
    payload: evenement('charge.dispute.created', { id: 'dp_1', object: 'dispute' }),
  });
  check('un LITIGE n\'est pas un remboursement : rien n\'est projeté',
    litige.facts.length === 0);

  const avoir = normalizer.normalizeStripeRefundEvent({
    eventType: 'credit_note.created',
    environment: 'TEST',
    payload: evenement('credit_note.created', { id: 'cn_1', object: 'credit_note' }),
  });
  check('un AVOIR n\'est pas un mouvement de trésorerie : rien n\'est projeté',
    avoir.facts.length === 0);
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('3. L\'encaissement adopte son intention de paiement');
let paiementA;
{
  paiementA = await encaisser({
    projectId: PROJET_A,
    sessionId: 'cs_a_500',
    paymentIntentId: 'pi_a_500',
    chargeId: 'ch_a_500',
    amountCents: 50_000,
  });

  const revenu = await PanelFinancialTransaction.findOne({ transactionId: paiementA.transactionId }).lean();
  check('le revenu est projeté', revenu?.category === CATEGORIES.REVENUE && revenu.amountCents === 50_000);

  const lien = await bindings.findBinding({
    environment: 'TEST',
    resourceType: bindings.STRIPE_RESOURCE_TYPES.PAYMENT_INTENT,
    resourceId: 'pi_a_500',
  });
  check('l\'intention de paiement est ADOPTÉE à la projection', Boolean(lien));
  check('…au bon projet', lien?.projectId === PROJET_A);
  check('…par filiation de la session possédée',
    lien?.proof?.derivedFromResourceId === 'cs_a_500');
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('4. L\'éligibilité — lue, jamais calculée par l\'écran');
{
  const verdict = await refunds.describeRefundEligibility(paiementA.transactionId);
  check('un revenu Stripe entier est remboursable', verdict.eligible === true);
  check('le montant encaissé vient du registre', verdict.refund.collectedCents === 50_000);
  check('rien n\'a encore été rendu', verdict.refund.refundedCents === 0);
  check('le restant est le tout', verdict.refund.remainingCents === 50_000);
  check('le monde est DÉRIVÉ du paiement d\'origine', verdict.refund.environment === 'TEST');
  check('l\'état dérivé démarre à « non remboursé »',
    verdict.refund.state === refunds.REFUND_STATE.NONE);

  /* Un coût n'est pas remboursable — et le refus est NOMMÉ. */
  const cout = await registre.createManualTransaction({
    projectId: PROJET_A, category: 'COST', label: 'Hébergement', amount: '200,00',
    currency: 'EUR', effectiveDate: '2026-07-15',
  }, ACTEUR);
  const refusCout = await refunds.describeRefundEligibility(cout.transactionId);
  check('un COÛT n\'est pas remboursable', refusCout.eligible === false);
  check('…et le refus est nommé', refusCout.code === 'NOT_A_REVENUE');

  /* Un revenu SAISI À LA MAIN n'a pas d'argent chez Stripe à rendre. */
  const manuel = await registre.createManualTransaction({
    projectId: PROJET_A, category: 'REVENUE', label: 'Virement direct', amount: '300,00',
    currency: 'EUR', effectiveDate: '2026-07-16',
  }, ACTEUR);
  const refusManuel = await refunds.describeRefundEligibility(manuel.transactionId);
  check('un revenu MANUEL n\'ouvre pas de remboursement automatique',
    refusManuel.eligible === false && refusManuel.code === 'NOT_A_PROVIDER_REVENUE');
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('5. Un remboursement partiel — un mouvement distinct, jamais un coût');
let idRemboursement1;
{
  const avant = creationsRemboursement().length;
  const issue = await refunds.requestRefund({
    transactionId: paiementA.transactionId,
    amountCents: 10_000,
    providerReason: 'requested_by_customer',
    operatorReason: 'Prestation de juin surfacturée',
    actor: ACTEUR,
  });
  check('l\'acte aboutit', issue.status === REFUND_REQUEST_STATUS.SUCCEEDED);
  check('UN seul appel de création est parti', creationsRemboursement().length === avant + 1);
  check('l\'identité rendue est celle du REMBOURSEMENT',
    issue.refundId.startsWith('re_'));

  idRemboursement1 = issue.transactionId;
  const ligne = await PanelFinancialTransaction.findOne({ transactionId: issue.transactionId }).lean();
  check('le mouvement est une SORTIE', ligne.flow === FLOWS.OUTFLOW);
  check('…de catégorie REFUND, jamais COST', ligne.category === CATEGORIES.REFUND);
  check('…d\'origine STRIPE', ligne.origin === ORIGINS.STRIPE);
  check('…de montant POSITIF', ligne.amountCents === 10_000);
  check('…rattaché au paiement qu\'il défait',
    ligne.parentTransactionId === paiementA.transactionId);
  check('…et son identité externe est `re_…`, jamais `pi_…`',
    ligne.provenance.externalId.startsWith('re_')
    && ligne.provenance.externalKind === 'REFUND');

  const origine = await PanelFinancialTransaction.findOne({ transactionId: paiementA.transactionId }).lean();
  check('L\'ENCAISSEMENT D\'ORIGINE EST INTACT — montant',
    origine.amountCents === 50_000);
  check('…catégorie', origine.category === CATEGORIES.REVENUE);
  check('…et sens', origine.flow === FLOWS.INFLOW);

  const etat = await refunds.describeRefundEligibility(paiementA.transactionId);
  check('l\'état dérivé devient « partiellement remboursé »',
    etat.refund.state === refunds.REFUND_STATE.PARTIAL);
  check('le restant a diminué d\'autant', etat.refund.remainingCents === 40_000);
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('6. Les totaux — rendre 100 n\'ajoute pas 100 de charges');
{
  const resume = await agregat.summarize({
    scope: 'project', projectId: PROJET_A, period: 'ALL',
  });
  /* +500 encaissé, +300 de revenu manuel, 200 de coût, 100 rendus. */
  check('les revenus restent entiers', resume.byCategory.revenueCents === 80_000);
  check('LES COÛTS NE BOUGENT PAS — 200, pas 300', resume.byCategory.costCents === 20_000);
  check('le remboursement a sa propre colonne', resume.byCategory.refundCents === 10_000);
  check('le net soustrait le remboursement',
    resume.totals.netCents === 80_000 - 20_000 - 10_000);

  /**
   * LA VÉRIFICATION QUI PORTE TOUT LE LOT : le remboursement pèse sur le net
   * SANS avoir touché aux charges. C'est exactement ce que les deux axes —
   * sens et catégorie — ont été posés pour permettre en L10.1.
   */
  check('…en sortant du net', resume.totals.outflowCents === 30_000);
  check('…sans être entré dans les charges', resume.byCategory.costCents === 20_000);
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('7. Le double clic — deux demandes, un seul appel utile');
{
  /**
   * DEUX CLICS SUR LE MÊME BOUTON produisent deux demandes distinctes côté
   * Panel : c'est voulu, deux remboursements partiels étant légitimes. Ce qui
   * doit tenir, c'est que le REJEU d'une même demande ne crée rien de neuf.
   */
  const demande = await PanelRefundRequest.findOne({ sourceTransactionId: paiementA.transactionId }).lean();
  const avant = creationsRemboursement().length;

  const rejeu = await refunds.executeRefundRequest({
    demande: { ...demande, status: REFUND_REQUEST_STATUS.UNKNOWN },
  }).catch((e) => ({ erreur: e }));

  check('rejouer une demande conclue ne crée AUCUN remboursement',
    creationsRemboursement().length === avant);
  check('…et la passerelle le dit plutôt que de le faire',
    Boolean(rejeu?.refundId) || Boolean(rejeu?.erreur));
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('8. Le webhook qui suit la réponse — aucune seconde ligne');
{
  const avantLignes = await PanelFinancialTransaction.countDocuments({
    category: CATEGORIES.REFUND, deletedAt: null,
  });

  const refund = (remboursementsParPaiement.get('pi_a_500') ?? [])[0];
  await projection.recordStripeRevenueEvent({
    environment: 'TEST',
    eventType: 'charge.refunded',
    payload: evenement('charge.refunded', {
      id: 'ch_a_500',
      object: 'charge',
      payment_intent: 'pi_a_500',
      receipt_url: 'https://pay.stripe.test/receipts/ch_a_500',
      refunds: { data: [refund] },
    }),
    providerEventId: 'evt_charge_refunded_1',
  });

  const apresLignes = await PanelFinancialTransaction.countDocuments({
    category: CATEGORIES.REFUND, deletedAt: null,
  });
  check('LE WEBHOOK CONVERGE — le nombre de remboursements ne change pas',
    apresLignes === avantLignes);

  const faits = await PanelProviderRevenueFact.countDocuments({ objectId: refund.id });
  check('…parce que l\'identité canonique est la même', faits === 1);
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('9. Le webhook AVANT toute réponse — la convergence dans l\'autre sens');
{
  const paiementB = await encaisser({
    projectId: PROJET_A,
    sessionId: 'cs_a_200',
    paymentIntentId: 'pi_a_200',
    chargeId: 'ch_a_200',
    amountCents: 20_000,
    payeLe: '2026-07-12T09:00:00Z',
  });

  /** Un remboursement fait depuis le tableau de bord Stripe : aucun appel du Panel. */
  const refundExterne = {
    id: 're_externe_1', object: 'refund', amount: 20_000, currency: 'eur',
    status: 'succeeded', created: SECONDES('2026-08-25T10:00:00Z'),
    payment_intent: 'pi_a_200', charge: 'ch_a_200', metadata: {},
  };
  remboursementsParPaiement.set('pi_a_200', [refundExterne]);

  await projection.recordStripeRevenueEvent({
    environment: 'TEST',
    eventType: 'charge.refunded',
    payload: evenement('charge.refunded', {
      id: 'ch_a_200', object: 'charge', payment_intent: 'pi_a_200',
      receipt_url: 'https://pay.stripe.test/receipts/ch_a_200',
      refunds: { data: [refundExterne] },
    }),
    providerEventId: 'evt_charge_refunded_externe',
  });

  const ligne = await PanelFinancialTransaction.findOne({
    'provenance.externalId': 're_externe_1',
  }).lean();
  check('un remboursement fait HORS du Panel entre quand même au registre',
    Boolean(ligne));
  check('…rattaché au bon paiement', ligne.parentTransactionId === paiementB.transactionId);
  check('…au bon projet', ligne.projectId === PROJET_A);

  const verdict = await refunds.describeRefundEligibility(paiementB.transactionId);
  check('…et l\'écran refuse d\'en proposer un second : plus rien à rendre',
    verdict.eligible === false && verdict.code === 'FULLY_REFUNDED');
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('10. La réponse perdue — INCONNU, jamais ÉCHEC');
{
  const paiementC = await encaisser({
    projectId: PROJET_A,
    sessionId: 'cs_a_muet',
    paymentIntentId: 'pi_a_muet',
    chargeId: 'ch_a_muet',
    amountCents: 30_000,
    payeLe: '2026-07-14T09:00:00Z',
  });

  prochainAppelMuet = true;
  const issue = await refunds.requestRefund({
    transactionId: paiementC.transactionId,
    amountCents: 5_000,
    actor: ACTEUR,
  });

  check('l\'issue est INCONNUE', issue.status === REFUND_REQUEST_STATUS.UNKNOWN);
  check('…et jamais ÉCHEC', issue.status !== REFUND_REQUEST_STATUS.FAILED);
  check('le message ne propose PAS de recommencer',
    /vérification/i.test(issue.message) && !/réessay/i.test(issue.message));

  const verdict = await refunds.describeRefundEligibility(paiementC.transactionId);
  check('LE BOUTON SE FERME tant que l\'issue est inconnue', verdict.eligible === false);
  check('…et le motif le dit', verdict.code === 'REFUND_IN_FLIGHT');

  const demande = await PanelRefundRequest.findOne({ refundRequestId: issue.refundRequestId }).lean();
  check('la demande reste rejouable', demande.status === REFUND_REQUEST_STATUS.UNKNOWN);
  check('…et elle porte son identité d\'acte, écrite AVANT l\'appel',
    demande.operationId.startsWith('stripe-refund:test:'));
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('11. Le rejeu hors fenêtre d\'idempotence — la métadonnée tranche');
{
  /**
   * LE SCÉNARIO LE PLUS DANGEREUX DU LOT.
   *
   * Stripe a bien créé le remboursement, mais la réponse s'est perdue. Un an
   * plus tard — fenêtre d'idempotence expirée — la reprise repart. Sans la
   * métadonnée, elle créerait un SECOND remboursement bien réel.
   */
  const paiementD = await encaisser({
    projectId: PROJET_A,
    sessionId: 'cs_a_tardif',
    paymentIntentId: 'pi_a_tardif',
    chargeId: 'ch_a_tardif',
    amountCents: 40_000,
    payeLe: '2026-07-16T09:00:00Z',
  });

  const issue1 = await refunds.requestRefund({
    transactionId: paiementD.transactionId, amountCents: 15_000, actor: ACTEUR,
  });
  check('le premier remboursement aboutit', issue1.status === REFUND_REQUEST_STATUS.SUCCEEDED);

  const emisAvant = creationsRemboursement().length;
  const chezStripeAvant = (remboursementsParPaiement.get('pi_a_tardif') ?? []).length;

  /** La fenêtre d'idempotence de Stripe a expiré. */
  oublierLesCles = true;

  const demande = await PanelRefundRequest.findOne({ refundRequestId: issue1.refundRequestId }).lean();
  await PanelRefundRequest.updateOne(
    { refundRequestId: demande.refundRequestId },
    { $set: { status: REFUND_REQUEST_STATUS.UNKNOWN } },
  );
  await refunds.executeRefundRequest({
    demande: { ...demande, status: REFUND_REQUEST_STATUS.UNKNOWN },
  }).catch(() => null);

  oublierLesCles = false;

  check('AUCUN second remboursement n\'existe chez Stripe',
    (remboursementsParPaiement.get('pi_a_tardif') ?? []).length === chezStripeAvant);
  check('…et aucune création n\'a même été TENTÉE',
    creationsRemboursement().length === emisAvant);

  const lignes = await PanelFinancialTransaction.countDocuments({
    parentTransactionId: paiementD.transactionId, category: CATEGORIES.REFUND, deletedAt: null,
  });
  check('le registre ne porte qu\'un seul remboursement', lignes === 1);
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('12. Le dépassement — refusé avant l\'appel, et refusé par Stripe');
{
  const verdict = await refunds.describeRefundEligibility(paiementA.transactionId);
  const trop = verdict.refund.remainingCents + 1;

  const avant = creationsRemboursement().length;
  const erreur = await refunds.requestRefund({
    transactionId: paiementA.transactionId, amountCents: trop, actor: ACTEUR,
  }).catch((e) => e);

  check('un montant supérieur au restant est refusé', erreur?.code === 'PANEL_REFUND_AMOUNT_TOO_LARGE');
  check('…AVANT tout contact fournisseur', creationsRemboursement().length === avant);

  const demandes = await PanelRefundRequest.countDocuments({
    sourceTransactionId: paiementA.transactionId,
    amountCents: trop,
  });
  check('…et sans laisser de demande orpheline', demandes === 0);
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('13. Le cloisonnement — le projet B ne rembourse pas le paiement de A');
{
  /**
   * On n'attaque pas par la route : elle ne prend qu'une identité INTERNE, et
   * le projet est résolu depuis le mouvement. On attaque donc au niveau où une
   * confusion serait possible — l'appartenance de la ressource Stripe.
   */
  const verdict = await bindings.assertOwnedResource({
    projectId: PROJET_B,
    environment: 'TEST',
    resourceType: bindings.STRIPE_RESOURCE_TYPES.PAYMENT_INTENT,
    resourceId: 'pi_a_500',
  }).then(() => null).catch((e) => e);

  check('le projet B ne possède pas l\'intention de paiement de A', Boolean(verdict));

  const inconnu = await bindings.assertOwnedResource({
    projectId: PROJET_B,
    environment: 'TEST',
    resourceType: bindings.STRIPE_RESOURCE_TYPES.PAYMENT_INTENT,
    resourceId: 'pi_inexistant_xyz',
  }).then(() => null).catch((e) => e);

  check('LE REFUS EST INDISTINCT — « pas à vous » se lit comme « n\'existe pas »',
    inconnu?.code === verdict?.code && inconnu?.message === verdict?.message);
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('14. La surface HTTP — aucun identifiant Stripe n\'entre par le navigateur');
{
  const ici = path.dirname(fileURLToPath(import.meta.url));
  const racine = path.resolve(ici, '..');
  const lire = (rel) => fs.readFileSync(path.join(racine, rel), 'utf8');
  /** Retire les commentaires : c'est le CODE qu'on mesure, pas la prose. */
  const code = (texte) => texte
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/.*$/gm, '$1 ');

  const controleur = code(lire('backend/src/controllers/finances.controller.js'));
  const bloc = /export async function refund\(req, res\) \{[\s\S]*?\n\}/.exec(controleur)?.[0] ?? '';
  check('le contrôleur de remboursement existe', bloc.length > 0);
  for (const interdit of ['paymentIntentId', 'chargeId', 'invoiceId', 'environment']) {
    check(`…et il ne lit JAMAIS « ${interdit} » du corps`, !bloc.includes(interdit));
  }

  const orchestration = code(lire('backend/src/services/finance/refunds/refundOrchestration.service.js'));
  check('l\'orchestration ne contient aucun `fetch(` direct', !/\bfetch\s*\(/.test(orchestration));
  check('…aucune adresse Stripe', !/api\.stripe|https:\/\/.*stripe\.com/.test(orchestration));
  check('…aucune clé secrète', !/sk_live|sk_test|secretKey/.test(orchestration));
  check('…et elle passe par la passerelle de capacités',
    orchestration.includes('invokeCapability'));
  check('…en source PANEL_INTERNAL', orchestration.includes('PANEL_INTERNAL'));

  const routes = code(lire('backend/src/routes/finances.routes.js'));
  check('la route de remboursement est montée SOUS la transaction',
    routes.includes('/transactions/:transactionId/refund'));

  const modale = code(lire('frontend/src/components/finance/RefundModal.tsx'));
  check('la fenêtre n\'offre AUCUN choix d\'environnement',
    !/TEST.*PROD|PROD.*TEST/.test(modale.replace(/'TEST' \| 'PROD'/g, '')));
  check('…et ne construit aucun identifiant Stripe',
    !/pi_|ch_|sk_/.test(modale));
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('15. Les dates — le paiement reste dans son mois, le remboursement dans le sien');
{
  const revenu = await PanelFinancialTransaction.findOne({ transactionId: paiementA.transactionId }).lean();
  const rembourse = await PanelFinancialTransaction.findOne({ transactionId: idRemboursement1 }).lean();

  check('l\'encaissement est daté de juillet',
    new Date(revenu.effectiveDate).getUTCMonth() === 6);
  check('le remboursement est daté d\'août',
    new Date(rembourse.effectiveDate).getUTCMonth() === 7);

  const juillet = await agregat.summarize({
    scope: 'project', projectId: PROJET_A, period: 'CUSTOM',
    start: '2026-07-01', end: '2026-08-01',
  });
  const aout = await agregat.summarize({
    scope: 'project', projectId: PROJET_A, period: 'CUSTOM',
    start: '2026-08-01', end: '2026-09-01',
  });
  /**
   * Le projet porte d'autres paiements posés par les sections précédentes : on
   * ne fige donc pas des sommes, on vérifie la SÉPARATION des deux mois, qui
   * est la seule chose que ce contrôle doit prouver.
   */
  check('juillet ne porte AUCUN remboursement', juillet.byCategory.refundCents === 0);
  check('…mais bien des encaissements', juillet.byCategory.revenueCents >= 50_000);
  check('…et août n\'invente AUCUN revenu', aout.byCategory.revenueCents === 0);
  check('août porte les remboursements, et eux seuls',
    aout.byCategory.refundCents >= 10_000 && aout.byCategory.costCents === 0);
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('16. La suppression — un encaissement remboursé ne se retire pas seul');
{
  const erreur = await registre.softDeleteTransaction(paiementA.transactionId, {}, ACTEUR)
    .then(() => null).catch((e) => e);

  check('retirer un encaissement qui porte des remboursements est REFUSÉ',
    erreur?.code === 'PANEL_FINANCE_TRANSACTION_HAS_REFUNDS');

  const encore = await PanelFinancialTransaction.findOne({ transactionId: paiementA.transactionId }).lean();
  check('…et il est toujours là', encore.deletedAt === null);

  /**
   * LA RAISON, ET ELLE EST CHIFFRÉE : sans cette garde, retirer le +500 aurait
   * laissé le −100 seul, et le net aurait affiché une PERTE de 100 € sur une
   * opération qui a rapporté 400.
   */
  const rembourse = await PanelFinancialTransaction.findOne({ transactionId: idRemboursement1 }).lean();
  check('le remboursement, LUI, se retire — il n\'a pas d\'enfant',
    Boolean(await registre.softDeleteTransaction(rembourse.transactionId, {}, ACTEUR)));

  const apres = await registre.softDeleteTransaction(paiementA.transactionId, {}, ACTEUR)
    .then((d) => d).catch(() => null);
  check('…et l\'encaissement redevient alors retirable', Boolean(apres?.deletedAt));

  /** On remet en état pour ne pas fausser les sections suivantes. */
  await PanelFinancialTransaction.updateMany(
    { transactionId: { $in: [paiementA.transactionId, rembourse.transactionId] } },
    { $set: { deletedAt: null, deletedBy: null, deletionReason: null } },
  );
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('17. Le plan de contrôle — la capacité est servie, et alignée');
{
  const registreCapacites = await import('../backend/src/services/capabilities/capabilityRegistry.js');
  const catalogue = await import('../backend/src/services/integratedApi/stripe/stripeCapabilities.js');
  const adaptateurs = await import('../backend/src/services/integratedApi/stripe/stripeAdapters.js');

  const problemes = registreCapacites.assertRegistryAlignment();
  check('le registre des capacités reste aligné', problemes.length === 0);

  const definition = registreCapacites.getCapabilityDefinition('billing.refund');
  check('« billing.refund » est SERVIE', definition.migrated === true);
  check('…avec idempotence fournisseur',
    definition.idempotency === registreCapacites.IDEMPOTENCY.PROVIDER_IDEMPOTENT);
  check('…et une poignée de corrélation qui est le `re_…`',
    definition.correlationField === 'refundId');
  check('…son contrat est le MÊME objet que celui du catalogue',
    definition.inputSchema === catalogue.STRIPE_CAPABILITIES['billing.refund'].inputSchema);
  check('…elle exige la preuve d\'appartenance',
    catalogue.STRIPE_CAPABILITIES['billing.refund'].requiresResourceOwnership === true);
  check('…sur l\'intention de paiement elle-même',
    catalogue.STRIPE_CAPABILITIES['billing.refund'].resourceKind === 'PAYMENT_INTENT');
  check('…et un adaptateur la sert', typeof adaptateurs.STRIPE_ADAPTERS['billing.refund'] === 'function');

  /** L'entrée refuse un identifiant qui n'est pas une intention de paiement. */
  const contrat = catalogue.STRIPE_CAPABILITIES['billing.refund'].inputSchema;
  const mauvais = contrat.safeParse({
    paymentIntentId: 'in_1234567890', operationId: 'stripe-refund:test:abcdefghijklmnop',
  });
  check('une FACTURE présentée là où l\'on rembourse est refusée', mauvais.success === false);

  const bon = contrat.safeParse({
    paymentIntentId: 'pi_1234567890', operationId: 'stripe-refund:test:abcdefghijklmnop',
  });
  check('…et un montant absent vaut « totalité du restant »',
    bon.success === true && bon.data.amountCents === undefined);
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('18. Le refus fournisseur — ÉCHEC franc, et la voie reste ouverte');
{
  const paiementE = await encaisser({
    projectId: PROJET_A,
    sessionId: 'cs_a_refus',
    paymentIntentId: 'pi_a_refus',
    chargeId: 'ch_a_refus',
    amountCents: 10_000,
    payeLe: '2026-07-18T09:00:00Z',
  });

  prochainAppelRefuse = 'charge_already_refunded';
  const erreur = await refunds.requestRefund({
    transactionId: paiementE.transactionId, amountCents: 5_000, actor: ACTEUR,
  }).catch((e) => e);

  check('un refus de Stripe remonte comme un échec', erreur?.code === 'PANEL_REFUND_FAILED');

  const demande = await PanelRefundRequest.findOne({
    sourceTransactionId: paiementE.transactionId,
  }).lean();
  check('la demande est marquée ÉCHOUÉE', demande.status === REFUND_REQUEST_STATUS.FAILED);
  check('…avec un motif nommé', Boolean(demande.failureCode));

  const verdict = await refunds.describeRefundEligibility(paiementE.transactionId);
  check('UN ÉCHEC NE BLOQUE PAS : rien n\'est parti, une nouvelle demande est licite',
    verdict.eligible === true);
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('19. La visibilité — « Revenus » montre les remboursements, « Coûts » jamais');
{
  const revenus = await registre.listTransactions({
    scope: 'project', projectId: PROJET_A, period: 'ALL', category: 'REVENUE,REFUND',
  });
  check('l\'onglet Revenus montre les remboursements',
    revenus.items.some((t) => t.category === 'REFUND'));
  check('…et les encaissements', revenus.items.some((t) => t.category === 'REVENUE'));

  const couts = await registre.listTransactions({
    scope: 'project', projectId: PROJET_A, period: 'ALL', category: 'COST',
  });
  check('L\'ONGLET COÛTS N\'EN MONTRE AUCUN',
    couts.items.every((t) => t.category === 'COST'));

  const revenu = revenus.items.find((t) => t.transactionId === paiementA.transactionId);
  check('un revenu porte son état de remboursement', Boolean(revenu?.refund));
  check('…chiffré', revenu.refund.refundedCents > 0);

  const cout = couts.items[0];
  check('un coût n\'en porte AUCUN — il n\'y a rien à dire', cout?.refund === undefined);
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('20. Aucun écran financier n\'appelle Stripe');
{
  const avant = appels.length;
  await registre.listTransactions({ scope: 'project', projectId: PROJET_A, period: 'ALL' });
  await agregat.summarize({ scope: 'project', projectId: PROJET_A, period: 'ALL' });
  await registre.getTransaction(paiementA.transactionId);
  await refunds.describeRefundEligibility(paiementA.transactionId);

  check('LIRE LE LIVRET NE PARLE PAS AU FOURNISSEUR', appels.length === avant);

  const reponse = await call('GET', `/api/finances/transactions?scope=project&projectId=${PROJET_A}`, {
    headers: AUTH,
  });
  check('…y compris par la route HTTP', reponse.status === 200 && appels.length === avant);
}

await close();
fauxStripe.close();
await stopMemoryMongo();
finish();
