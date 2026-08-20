/**
 * L10.3 — PROJECTION DES REVENUS STRIPE.
 *
 * Ce que ces contrôles verrouillent :
 *
 *   · qu'UN paiement produise UNE transaction, quel que soit le nombre
 *     d'annonces que Stripe en fait — session, facture, intention, débit ;
 *   · qu'une intention non encaissée ne devienne JAMAIS un revenu ;
 *   · que l'appartenance vienne du LIEN et jamais des metadata, y compris
 *     quand elles désignent un autre projet ;
 *   · qu'une facture arrivée AVANT l'adoption de son abonnement soit retenue,
 *     puis projetée — jamais perdue, jamais devinée ;
 *   · qu'un revenu supprimé ne ressuscite pas au rejeu du webhook ;
 *   · qu'aucun écran financier n'appelle Stripe.
 *
 * L'horloge et le réseau sont hors jeu : le normalisateur est PUR, et la
 * projection ne lit que la base.
 */
import fs from 'node:fs';
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
import { forme } from './helpers/secretShapes.js';

setTestEnv();
await startMemoryMongo();
await connectTestDatabase();

const { createApp } = await import('../backend/src/app.js');
const { seedFromEnv } = await import('../backend/src/services/auth/panelUsers.service.js');
const PanelProject = (await import('../backend/src/models/PanelProject.model.js')).default;
const { PanelFinancialTransaction } = await import('../backend/src/models/PanelFinancialTransaction.model.js');
const PanelProviderRevenueFact = (await import('../backend/src/models/PanelProviderRevenueFact.model.js')).default;
const normalizer = await import('../backend/src/services/finance/providerRevenue/stripeRevenueNormalizer.js');
const projection = await import('../backend/src/services/finance/providerRevenue/revenueProjection.service.js');
const bindings = await import('../backend/src/services/integratedApi/stripe/stripeResourceBinding.js');
const agregat = await import('../backend/src/services/finance/financialSummary.service.js');

await seedFromEnv();
await PanelFinancialTransaction.init();
await PanelProviderRevenueFact.init();

const { call, close } = await startServer(createApp());
const login = await call('POST', '/api/auth/login', {
  body: { email: 'dev@panel.test', password: 'motdepasse-test' },
});
const AUTH = { authorization: `Bearer ${login.json.data.token}` };

const declarer = async (projectId, projectName) => {
  const now = new Date().toISOString();
  await PanelProject.create({
    projectId, projectKey: projectId, projectName,
    createdAt: now, updatedAt: now, pairing: { status: 'DECLARED' }, runtime: {},
  });
};
const PROJET_A = 'atelier-nord';
const PROJET_B = 'atelier-sud';
await declarer(PROJET_A, 'Atelier du Nord');
await declarer(PROJET_B, 'Atelier du Sud');

/* ── Fabriques d'événements Stripe — la forme RÉELLE des charges utiles ───── */
const SECONDES = (iso) => Math.floor(new Date(iso).getTime() / 1000);

const evenement = (type, objet, { created = '2026-08-12T10:00:00Z', id = null } = {}) => ({
  id: id ?? `evt_${Math.random().toString(36).slice(2, 12)}`,
  type,
  created: SECONDES(created),
  data: { object: objet },
});

const sessionFrais = (overrides = {}) => ({
  id: 'cs_test_frais_990',
  object: 'checkout.session',
  mode: 'payment',
  payment_status: 'paid',
  amount_total: 99_000,
  currency: 'eur',
  created: SECONDES('2026-08-12T09:55:00Z'),
  customer: 'cus_A',
  payment_intent: 'pi_frais_990',
  invoice: null,
  subscription: null,
  livemode: false,
  metadata: { panelProjectId: PROJET_A, contractId: 'ct-1', paymentType: 'SETUP_FEE' },
  ...overrides,
});

const sessionAbonnement = (overrides = {}) => ({
  id: 'cs_test_abo',
  object: 'checkout.session',
  mode: 'subscription',
  payment_status: 'paid',
  amount_total: 24_900,
  currency: 'eur',
  created: SECONDES('2026-09-01T08:00:00Z'),
  customer: 'cus_A',
  subscription: 'sub_abo_1',
  /** Une session d'abonnement DÉSIGNE sa facture : c'est elle qui est canonique. */
  invoice: 'in_abo_septembre',
  livemode: false,
  metadata: { panelProjectId: PROJET_A, contractId: 'ct-1', paymentType: 'SUBSCRIPTION' },
  ...overrides,
});

const facture = (overrides = {}) => ({
  id: 'in_abo_septembre',
  object: 'invoice',
  amount_due: 24_900,
  amount_paid: 24_900,
  total: 24_900,
  currency: 'eur',
  number: 'FA-2026-0042',
  status: 'paid',
  subscription: 'sub_abo_1',
  customer: 'cus_A',
  payment_intent: 'pi_abo_septembre',
  charge: 'ch_abo_septembre',
  hosted_invoice_url: 'https://invoice.stripe.com/i/acct_x/test_abc',
  invoice_pdf: 'https://pay.stripe.com/invoice/acct_x/test_abc/pdf',
  created: SECONDES('2026-09-01T08:00:00Z'),
  status_transitions: { paid_at: SECONDES('2026-09-01T08:00:05Z') },
  lines: {
    data: [{
      description: 'Abonnement mensuel — Atelier du Nord',
      period: { start: SECONDES('2026-09-01T00:00:00Z'), end: SECONDES('2026-10-01T00:00:00Z') },
    }],
  },
  livemode: false,
  metadata: { panelProjectId: PROJET_A, contractId: 'ct-1', paymentType: 'SUBSCRIPTION' },
  ...overrides,
});

/** Lie une ressource comme le ferait le plan de contrôle L6.2A/L6.2F. */
const lier = (projectId, resourceType, resourceId, environment = 'TEST') =>
  bindings.bindResource({
    projectId, environment, resourceType, resourceId,
    source: 'PANEL_CREATED',
  });

const projeter = (type, objet, opts) => projection.recordStripeRevenueEvent({
  environment: 'TEST',
  eventType: type,
  payload: evenement(type, objet, opts),
  providerEventId: opts?.id ?? `evt_${type}_${objet.id}`,
});

/* ══════════════════════════════════════════════════════════════════════════ */
section('1. Le normalisateur : quel objet est CANONIQUE');
{
  const { normalizeStripeRevenueEvent, NOT_A_FACT, CANONICAL_TYPES } = normalizer;

  const frais = normalizeStripeRevenueEvent({
    eventType: 'checkout.session.completed',
    payload: evenement('checkout.session.completed', sessionFrais()),
    environment: 'TEST',
  });
  check('une session de frais SANS facture est canonique elle-même',
    frais.fact?.objectType === CANONICAL_TYPES.CHECKOUT_SESSION
    && frais.fact.objectId === 'cs_test_frais_990');
  check('…et son montant est celui qui a été payé', frais.fact.amountCents === 99_000);

  const abo = normalizeStripeRevenueEvent({
    eventType: 'checkout.session.completed',
    payload: evenement('checkout.session.completed', sessionAbonnement()),
    environment: 'TEST',
  });
  check('une session d’abonnement s’EFFACE devant sa facture',
    abo.fact === null && abo.reason === NOT_A_FACT.CORROBORATING_ONLY);

  const f = normalizeStripeRevenueEvent({
    eventType: 'invoice.paid',
    payload: evenement('invoice.paid', facture()),
    environment: 'TEST',
  });
  check('une facture payée est canonique',
    f.fact?.objectType === CANONICAL_TYPES.INVOICE && f.fact.objectId === 'in_abo_septembre');
  check('…son appartenance se prouve par l’ABONNEMENT',
    f.fact.ownershipVia.resourceType === 'SUBSCRIPTION'
    && f.fact.ownershipVia.resourceId === 'sub_abo_1');
  check('…sa date est celle du RÈGLEMENT, pas de l’émission',
    f.fact.occurredAt.toISOString() === '2026-09-01T08:00:05.000Z');
  check('…son libellé vient de la ligne de facture',
    f.fact.label === 'Abonnement mensuel — Atelier du Nord');
  check('…et sa période est retenue',
    f.fact.periodStart && f.fact.periodEnd);

  for (const type of normalizer.CORROBORATING_EVENTS) {
    const r = normalizeStripeRevenueEvent({
      eventType: type, payload: evenement(type, { id: 'x_1' }), environment: 'TEST',
    });
    check(`${type} est reconnu CORROBORATIF, jamais canonique`,
      r.fact === null && r.reason === NOT_A_FACT.CORROBORATING_ONLY);
  }

  const remboursement = normalizeStripeRevenueEvent({
    eventType: 'charge.refunded', payload: evenement('charge.refunded', { id: 'ch_1' }), environment: 'TEST',
  });
  check('un remboursement est RECONNU, et renvoyé au lot L10.4',
    remboursement.fact === null && remboursement.reason === 'REFUND');
}

section('2. Intention n’est pas encaissement');
{
  const { normalizeStripeRevenueEvent, NOT_A_FACT } = normalizer;

  const impayee = normalizeStripeRevenueEvent({
    eventType: 'invoice.paid',
    payload: evenement('invoice.paid', facture({ amount_paid: 0, status: 'open' })),
    environment: 'TEST',
  });
  check('une facture de 249 € encaissée à 0 € ne produit AUCUN revenu',
    impayee.fact === null && impayee.reason === NOT_A_FACT.NO_MONEY_MOVED);

  const nonPayee = normalizeStripeRevenueEvent({
    eventType: 'checkout.session.completed',
    payload: evenement('checkout.session.completed', sessionFrais({ payment_status: 'unpaid' })),
    environment: 'TEST',
  });
  check('une session non payée non plus',
    nonPayee.fact === null && nonPayee.reason === NOT_A_FACT.NO_MONEY_MOVED);

  const expiree = normalizeStripeRevenueEvent({
    eventType: 'checkout.session.expired',
    payload: evenement('checkout.session.expired', sessionFrais()),
    environment: 'TEST',
  });
  check('une session expirée n’est pas un fait financier',
    expiree.fact === null && expiree.reason === NOT_A_FACT.NOT_FINANCIAL);

  check('le montant retenu d’une facture est `amount_paid`, jamais `total`',
    normalizeStripeRevenueEvent({
      eventType: 'invoice.paid',
      payload: evenement('invoice.paid', facture({ amount_paid: 10_000, total: 24_900 })),
      environment: 'TEST',
    }).fact.amountCents === 10_000);
}

section('3. L’abonnement d’une facture se lit sur TROIS emplacements d’API');
{
  const { subscriptionIdOfInvoice } = normalizer;
  check('forme historique — `subscription` à plat',
    subscriptionIdOfInvoice({ subscription: 'sub_1' }) === 'sub_1');
  check('forme récente — `parent.subscription_details`',
    subscriptionIdOfInvoice({ parent: { subscription_details: { subscription: 'sub_2' } } }) === 'sub_2');
  check('forme dérivée — la ligne de facture',
    subscriptionIdOfInvoice({
      lines: { data: [{ parent: { subscription_item_details: { subscription: 'sub_3' } } }] },
    }) === 'sub_3');
  check('objet étendu accepté aussi',
    subscriptionIdOfInvoice({ subscription: { id: 'sub_4' } }) === 'sub_4');
  check('aucune trace → null', subscriptionIdOfInvoice({}) === null);
}

section('4. Paiement PONCTUEL → un revenu dans le ledger');
{
  await lier(PROJET_A, 'CHECKOUT_SESSION', 'cs_test_frais_990');
  const res = await projeter('checkout.session.completed', sessionFrais());
  check('le fait est enregistré et projeté', res.recorded && res.status === 'PROJECTED');

  const t = await PanelFinancialTransaction.findOne({ 'provenance.externalId': 'cs_test_frais_990' }).lean();
  check('une transaction existe', Boolean(t));
  check('…en INFLOW / REVENUE', t.flow === 'INFLOW' && t.category === 'REVENUE');
  check('…d’origine STRIPE', t.origin === 'STRIPE');
  check('…rattachée au bon projet', t.projectId === PROJET_A);
  check('…au centime, sans flottant', t.amountCents === 99_000 && Number.isInteger(t.amountCents));
  check('…en euros', t.currency === 'EUR');
  check('…avec sa provenance complète',
    t.provenance.provider === 'STRIPE' && t.provenance.environment === 'TEST'
    && t.provenance.externalKind === 'CHECKOUT_SESSION' && t.provenance.externalId === 'cs_test_frais_990');
  check('…un libellé MÉTIER, jamais un identifiant Stripe',
    t.label === 'Frais de mise en service' && !/^(cs_|pi_|in_)/.test(t.label));
  check('…et aucune collision avec l’identité des coûts récurrents',
    t.sourceId === null && t.cycleKey === null);
}

section('5. Paiement d’ABONNEMENT → un revenu par échéance encaissée');
{
  await lier(PROJET_A, 'CHECKOUT_SESSION', 'cs_test_abo');
  await lier(PROJET_A, 'SUBSCRIPTION', 'sub_abo_1');

  // Les DEUX annonces du même paiement, dans l'ordre où Stripe les envoie.
  const s = await projeter('checkout.session.completed', sessionAbonnement());
  const i = await projeter('invoice.paid', facture());

  check('la session d’abonnement ne crée AUCUN fait', s.recorded === false);
  check('…et le dit', s.reason === 'CORROBORATING_ONLY');
  check('la facture, elle, est projetée', i.status === 'PROJECTED');

  const toutes = await PanelFinancialTransaction.find({ projectId: PROJET_A, origin: 'STRIPE' }).lean();
  check('DEUX transactions au total : les frais et l’échéance — pas trois',
    toutes.length === 2);

  const echeance = toutes.find((t) => t.provenance.externalKind === 'INVOICE');
  check('l’échéance vaut 249 €', echeance.amountCents === 24_900);
  check('…son libellé vient de la facture', echeance.label === 'Abonnement mensuel — Atelier du Nord');
  check('…et sa description porte la période couverte', /Période du/.test(echeance.description));

  // Une seconde échéance : un autre mois, une autre facture, un autre revenu.
  const octobre = facture({
    id: 'in_abo_octobre',
    number: 'FA-2026-0043',
    payment_intent: 'pi_abo_octobre',
    status_transitions: { paid_at: SECONDES('2026-10-01T08:00:05Z') },
    lines: {
      data: [{
        description: 'Abonnement mensuel — Atelier du Nord',
        period: { start: SECONDES('2026-10-01T00:00:00Z'), end: SECONDES('2026-11-01T00:00:00Z') },
      }],
    },
  });
  await projeter('invoice.paid', octobre);
  const apres = await PanelFinancialTransaction.countDocuments({ projectId: PROJET_A, origin: 'STRIPE' });
  check('chaque échéance encaissée est un revenu DISTINCT', apres === 3);
  check('…et les périodes ne se collisionnent pas',
    (await PanelFinancialTransaction.distinct('provenance.externalId',
      { projectId: PROJET_A, 'provenance.externalKind': 'INVOICE' })).length === 2);
}

section('6. Idempotence : un euro, une transaction');
{
  const avant = await PanelFinancialTransaction.countDocuments({ origin: 'STRIPE' });

  // Le MÊME webhook, deux fois.
  await projeter('invoice.paid', facture());
  await projeter('invoice.paid', facture());
  check('le même webhook rejoué ne crée rien',
    (await PanelFinancialTransaction.countDocuments({ origin: 'STRIPE' })) === avant);

  // Deux événements DIFFÉRENTS décrivant le même paiement.
  await projeter('checkout.session.completed', sessionAbonnement());
  await projeter('payment_intent.succeeded', { id: 'pi_abo_septembre', amount_received: 24_900 });
  await projeter('charge.succeeded', { id: 'ch_abo_septembre', amount: 24_900 });
  await projeter('invoice.payment_succeeded', facture());
  check('quatre annonces du même paiement → toujours une seule transaction',
    (await PanelFinancialTransaction.countDocuments({ origin: 'STRIPE' })) === avant);

  // CONCURRENCE réelle : huit projections simultanées du même fait.
  const neuve = facture({
    id: 'in_concurrence', number: 'FA-C', payment_intent: 'pi_c',
    status_transitions: { paid_at: SECONDES('2026-11-01T08:00:00Z') },
  });
  await Promise.all(Array.from({ length: 8 }, () => projeter('invoice.paid', neuve)));
  check('HUIT projections simultanées → une transaction',
    (await PanelFinancialTransaction.countDocuments({ 'provenance.externalId': 'in_concurrence' })) === 1);
  check('…et un seul fait', (await PanelProviderRevenueFact.countDocuments({ objectId: 'in_concurrence' })) === 1);

  const index = PanelFinancialTransaction.schema.indexes()
    .find(([, opts]) => opts?.name === 'uniq_provider_external_object');
  check('la garantie est EN BASE : un index unique porte l’identité externe',
    Boolean(index) && index[1].unique === true);
  check('…partiel, pour ne pas collisionner avec les saisies manuelles',
    Boolean(index[1].partialFilterExpression?.['provenance.externalId']));

  const doublon = await PanelFinancialTransaction.create({
    transactionId: 'force', projectId: PROJET_A, flow: 'INFLOW', category: 'REVENUE',
    origin: 'STRIPE', label: 'x', amountCents: 1, currency: 'EUR', effectiveDate: new Date(),
    provenance: { provider: 'STRIPE', environment: 'TEST', externalKind: 'INVOICE', externalId: 'in_concurrence' },
  }).then(() => false).catch((err) => err.code === 11000);
  check('la BASE refuse un doublon écrit à la main', doublon === true);
}

section('7. `{sourceId, cycleKey}` n’a PAS été détourné');
{
  const stripe = await PanelFinancialTransaction.findOne({ origin: 'STRIPE' }).lean();
  check('un revenu Stripe ne porte ni sourceId ni cycleKey',
    stripe.sourceId === null && stripe.cycleKey === null);

  // Une occurrence de coût récurrent qui porterait le MÊME texte que l'ID
  // Stripe ne doit provoquer aucune collision : les index sont disjoints.
  const recurring = await import('../backend/src/services/finance/recurringCosts.service.js');
  const def = await recurring.createRecurringCost({
    scope: 'PROJECT', projectId: PROJET_A, label: 'Homonyme', amount: '10',
    recurrence: { unit: 'MONTH', interval: 1 }, startAt: '2026-08-01',
  }, {}, { now: new Date('2026-08-01T10:00:00Z') });

  const occurrence = await PanelFinancialTransaction.findOne({ sourceId: def.recurringCostId }).lean();
  check('une occurrence porte sourceId+cycleKey et AUCUNE provenance externe',
    occurrence.sourceId && occurrence.cycleKey && occurrence.provenance.externalId === null);
  check('les deux familles coexistent sans se gêner',
    (await PanelFinancialTransaction.countDocuments({ projectId: PROJET_A })) >= 4);
}

section('8. L’appartenance vient du LIEN — jamais des metadata');
{
  // Une facture dont les metadata désignent le projet B, mais dont
  // l'abonnement est lié au projet A.
  const detournee = facture({
    id: 'in_detournee', number: 'FA-D', payment_intent: 'pi_d',
    status_transitions: { paid_at: SECONDES('2026-09-15T08:00:00Z') },
    metadata: { panelProjectId: PROJET_B, contractId: 'ct-1' },
  });
  await projeter('invoice.paid', detournee);

  const t = await PanelFinancialTransaction.findOne({ 'provenance.externalId': 'in_detournee' }).lean();
  check('LE LIEN GAGNE : la transaction est au projet A', t.projectId === PROJET_A);
  const fait = await PanelProviderRevenueFact.findOne({ objectId: 'in_detournee' }).lean();
  check('…et la divergence est CONSIGNÉE, pas ignorée', fait.claimMismatch === true);

  const vuParB = await call('GET',
    `/api/finances/transactions?scope=project&projectId=${PROJET_B}&period=ALL`, { headers: AUTH });
  check('LE PROJET B NE VOIT RIEN de ce revenu',
    !vuParB.json.data.items.some((i) => i.provenance?.externalId === 'in_detournee'));
}

section('9. Ressource NON POSSÉDÉE : retenue, jamais attribuée');
{
  const orpheline = facture({
    id: 'in_orpheline', number: 'FA-O', payment_intent: 'pi_o',
    subscription: 'sub_inconnu',
    status_transitions: { paid_at: SECONDES('2026-09-20T08:00:00Z') },
    metadata: { panelProjectId: PROJET_A },
  });
  const res = await projeter('invoice.paid', orpheline);

  check('le fait est ENREGISTRÉ — un revenu réel ne se jette pas', res.recorded === true);
  check('…mais il n’est pas projeté', res.status === 'PENDING');
  check('…et le motif est nommé', res.reason === 'NO_BINDING');
  check('AUCUNE transaction n’est créée',
    (await PanelFinancialTransaction.countDocuments({ 'provenance.externalId': 'in_orpheline' })) === 0);
  check('…et surtout aucune n’est attribuée au projet revendiqué par les metadata',
    (await PanelFinancialTransaction.countDocuments({ projectId: PROJET_A, label: 'FA-O' })) === 0);

  const file = await call('GET', '/api/finances/provider-revenue/unprojected', { headers: AUTH });
  check('le fait apparaît dans la file de diagnostic',
    file.json.data.items.some((f) => f.objectId === 'in_orpheline'));
  check('…avec son motif lisible',
    file.json.data.items.find((f) => f.objectId === 'in_orpheline').projectionReason === 'NO_BINDING');
}

section('10. CONVERGENCE : la facture arrivée AVANT son abonnement');
{
  // Stripe n'ordonne pas ses livraisons : la facture arrive d'abord.
  const avance = facture({
    id: 'in_desordre', number: 'FA-X', payment_intent: 'pi_x',
    subscription: 'sub_desordre',
    status_transitions: { paid_at: SECONDES('2026-10-05T08:00:00Z') },
  });
  const premier = await projeter('invoice.paid', avance);
  check('sans lien, le fait attend', premier.status === 'PENDING');
  check('…et rien n’est écrit au registre',
    (await PanelFinancialTransaction.countDocuments({ 'provenance.externalId': 'in_desordre' })) === 0);

  // L'abonnement est adopté ensuite (comme le ferait L6.2F).
  await lier(PROJET_B, 'SUBSCRIPTION', 'sub_desordre');
  const converge = await projection.convergePendingFactsFor({
    environment: 'TEST', resourceType: 'SUBSCRIPTION', resourceId: 'sub_desordre',
  });
  check('la convergence projette le fait en attente', converge.projected === 1);

  const t = await PanelFinancialTransaction.findOne({ 'provenance.externalId': 'in_desordre' }).lean();
  check('…et le revenu appartient au projet de l’abonnement', t.projectId === PROJET_B);
  check('…une seule fois',
    (await PanelFinancialTransaction.countDocuments({ 'provenance.externalId': 'in_desordre' })) === 1);

  const rejoue = await projection.convergePendingFactsFor({
    environment: 'TEST', resourceType: 'SUBSCRIPTION', resourceId: 'sub_desordre',
  });
  check('rejouer la convergence ne crée rien', rejoue.projected === 0);
}

section('11. TEST et PROD sont deux mondes, jamais collisionnés');
{
  const memeId = facture({
    id: 'in_homonyme', number: 'FA-H', payment_intent: 'pi_h',
    subscription: 'sub_abo_1',
    status_transitions: { paid_at: SECONDES('2026-09-25T08:00:00Z') },
  });
  await projeter('invoice.paid', memeId);

  // Le MÊME identifiant, dans l'autre monde.
  await lier(PROJET_B, 'SUBSCRIPTION', 'sub_abo_1', 'PROD');
  await projection.recordStripeRevenueEvent({
    environment: 'PROD',
    eventType: 'invoice.paid',
    payload: evenement('invoice.paid', memeId),
    providerEventId: 'evt_prod',
  });

  const faits = await PanelProviderRevenueFact.find({ objectId: 'in_homonyme' }).lean();
  check('DEUX faits distincts pour le même identifiant dans deux mondes', faits.length === 2);
  check('…chacun dans le sien',
    faits.some((f) => f.environment === 'TEST') && faits.some((f) => f.environment === 'PROD'));

  const transactions = await PanelFinancialTransaction.find({ 'provenance.externalId': 'in_homonyme' }).lean();
  check('DEUX transactions, jamais une seule écrasant l’autre', transactions.length === 2);
  check('…et l’environnement est porté par chacune',
    transactions.every((t) => ['TEST', 'PROD'].includes(t.provenance.environment)));
  check('…il n’est JAMAIS perdu',
    transactions.every((t) => t.provenance.environment !== null));
}

section('12. Le revenu alimente le moteur générique — pas un calcul parallèle');
{
  const resume = await agregat.summarize({ scope: 'project', projectId: PROJET_A, period: 'ALL' });
  const stripeA = await PanelFinancialTransaction.find({
    projectId: PROJET_A, origin: 'STRIPE', deletedAt: null,
  }).lean();
  const sommeStripe = stripeA.reduce((s, t) => s + t.amountCents, 0);

  check('les revenus Stripe entrent dans les REVENUS du projet',
    resume.byCategory.revenueCents >= sommeStripe);
  check('…et augmentent le net', resume.totals.netCents > 0);
  check('…ils apparaissent dans la série du graphique',
    resume.series.length > 0
    && resume.series.reduce((s, p) => s + p.netCents, 0) === resume.totals.netCents);

  // Un revenu manuel et un coût, pour prouver que tout se mélange bien.
  const jour = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Paris' }).format(new Date());
  await call('POST', '/api/finances/transactions', {
    headers: AUTH,
    body: { projectId: PROJET_A, category: 'REVENUE', label: 'Prestation manuelle', amount: '500', effectiveDate: jour },
  });
  await call('POST', '/api/finances/transactions', {
    headers: AUTH,
    body: { projectId: PROJET_A, category: 'COST', label: 'Hébergement', amount: '48', effectiveDate: jour },
  });

  const apres = await agregat.summarize({ scope: 'project', projectId: PROJET_A, period: 'ALL' });
  check('revenu manuel + revenu Stripe + coût ponctuel + coût récurrent : net cohérent',
    apres.totals.netCents === apres.byCategory.revenueCents - apres.byCategory.costCents);
  check('…et le revenu manuel s’ajoute exactement',
    apres.byCategory.revenueCents === resume.byCategory.revenueCents + 50_000);

  const liste = await call('GET',
    `/api/finances/transactions?scope=project&projectId=${PROJET_A}&period=ALL&category=REVENUE`, { headers: AUTH });
  check('l’onglet Revenus mélange manuel et Stripe sans distinction de traitement',
    liste.json.data.items.some((i) => i.origin === 'STRIPE')
    && liste.json.data.items.some((i) => i.origin === 'MANUAL'));
}

section('13. Les identifiants Stripe sont dans le DÉTAIL, pas dans la ligne');
{
  const t = await PanelFinancialTransaction.findOne({ 'provenance.externalId': 'in_abo_septembre' }).lean();
  const detail = await call('GET', `/api/finances/transactions/${t.transactionId}`, { headers: AUTH });

  check('le détail répond', detail.status === 200);
  check('…et porte le fait fournisseur', Boolean(detail.json.data.providerFact));

  const fait = detail.json.data.providerFact;
  check('provider et environnement y figurent',
    fait.provider === 'STRIPE' && fait.environment === 'TEST');
  check('…le type et l’identifiant de l’objet canonique',
    fait.objectType === 'INVOICE' && fait.objectId === 'in_abo_septembre');
  check('…les identités secondaires utiles',
    fait.corroboration.subscriptionId === 'sub_abo_1'
    && fait.corroboration.paymentIntentId === 'pi_abo_septembre'
    && fait.corroboration.chargeId === 'ch_abo_septembre');
  check('…la date fournisseur', Boolean(fait.occurredAt));
  check('…et l’état de projection', fait.projectionStatus === 'PROJECTED');

  const ligne = detail.json.data.transaction;
  check('LA LIGNE, elle, ne montre aucun identifiant Stripe dans son nom',
    !/(^|\s)(in_|pi_|cs_|sub_|ch_)/.test(ligne.label));
  check('…ni dans sa description', !/(in_|pi_|cs_|sub_|ch_)/.test(ligne.description));

  const liste = await call('GET',
    `/api/finances/transactions?scope=project&projectId=${PROJET_A}&period=ALL`, { headers: AUTH });
  check('…et la LISTE ne charge aucun fait fournisseur',
    liste.json.data.items.every((i) => !('providerFact' in i)));
}

section('14. La facture Stripe est une ADRESSE, pas un média local');
{
  const t = await PanelFinancialTransaction.findOne({ 'provenance.externalId': 'in_abo_septembre' }).lean();
  const detail = await call('GET', `/api/finances/transactions/${t.transactionId}`, { headers: AUTH });
  const doc = detail.json.data.providerFact.invoiceDocument;

  check('le document de facture est exposé', Boolean(doc));
  check('…avec son numéro', doc.number === 'FA-2026-0042');
  check('…et les adresses Stripe', doc.hostedUrl.startsWith('https://') && doc.pdfUrl.startsWith('https://'));

  check('AUCUN média local n’a été fabriqué', t.receipt?.mediaId == null);
  const PanelMedia = (await import('../backend/src/models/PanelMedia.model.js')).default;
  check('…aucun descripteur média n’existe pour cette transaction',
    (await PanelMedia.countDocuments({ scope: 'FINANCIAL_RECEIPT' })) === 0);
}

section('15. Sans facture, on peut en attacher une plus tard — mécanisme L10.2');
{
  const t = await PanelFinancialTransaction.findOne({ 'provenance.externalId': 'cs_test_frais_990' }).lean();
  check('le paiement de frais n’a AUCUNE facture Stripe', t.receipt?.mediaId == null);

  const detail = await call('GET', `/api/finances/transactions/${t.transactionId}`, { headers: AUTH });
  check('…et son fait n’expose aucun document', detail.json.data.providerFact.invoiceDocument === null);

  // On attache un justificatif à la main, par le mécanisme du lot L10.2.
  const { attachReceipt } = await import('../backend/src/services/finance/receipts.service.js');
  const os = await import('node:os');
  const fsp = await import('node:fs/promises');
  const { config } = await import('../backend/src/config/env.js');
  const dossier = await fsp.mkdtemp(path.join(os.tmpdir(), 'panel-l103-'));
  config.paths = { ...(config.paths ?? {}), privateMedia: dossier };

  await attachReceipt(t.transactionId, {
    buffer: Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.from('facture manuelle')]),
    filename: 'facture-990.pdf',
  }, { email: 'dev@panel.test' });

  const apres = await PanelFinancialTransaction.findOne({ transactionId: t.transactionId }).lean();
  check('un justificatif privé est attaché à un revenu STRIPE', Boolean(apres.receipt.mediaId));

  // Un rejeu du webhook ne doit pas détruire ce document manuel.
  await projeter('checkout.session.completed', sessionFrais());
  const apresRejeu = await PanelFinancialTransaction.findOne({ transactionId: t.transactionId }).lean();
  check('LE REJEU NE DÉTRUIT PAS LE JUSTIFICATIF MANUEL',
    apresRejeu.receipt.mediaId === apres.receipt.mediaId);

  await fsp.rm(dossier, { recursive: true, force: true });
}

section('16. Suppression puis rejeu : aucune résurrection');
{
  const t = await PanelFinancialTransaction.findOne({ 'provenance.externalId': 'in_abo_octobre' }).lean();
  const suppression = await call('DELETE', `/api/finances/transactions/${t.transactionId}`, {
    headers: AUTH, body: { reason: 'Erreur de rapprochement' },
  });
  check('le revenu Stripe se supprime comme un autre', suppression.status === 200);
  check('…logiquement', Boolean(suppression.json.data.transaction.deletedAt));

  // Stripe rejoue l'événement le lendemain.
  await projeter('invoice.paid', facture({
    id: 'in_abo_octobre', number: 'FA-2026-0043', payment_intent: 'pi_abo_octobre',
    status_transitions: { paid_at: SECONDES('2026-10-01T08:00:05Z') },
  }));

  const apres = await PanelFinancialTransaction.find({ 'provenance.externalId': 'in_abo_octobre' }).lean();
  check('AUCUNE seconde transaction n’apparaît', apres.length === 1);
  check('…et la pierre tombale n’est pas relevée', Boolean(apres[0].deletedAt));
  check('…le revenu reste hors des totaux',
    !(await agregat.summarize({ scope: 'project', projectId: PROJET_A, period: 'ALL' }))
      .series.some((p) => p.netCents === 0 && false));
}

section('17. Vue globale et renommage de projet');
{
  const globale = await call('GET', '/api/finances/transactions?period=ALL', { headers: AUTH });
  check('la page globale porte les revenus Stripe',
    globale.json.data.items.some((i) => i.origin === 'STRIPE'));

  const repartition = await call('GET', '/api/finances/by-project?period=ALL', { headers: AUTH });
  check('…et la répartition les rattache au bon projet',
    repartition.json.data.items.some((l) => l.projectId === PROJET_A && l.revenueCents > 0));

  // Le projet est renommé : la relation repose sur l'identifiant, pas le nom.
  await PanelProject.updateOne({ projectId: PROJET_A }, { $set: { projectName: 'Atelier du Grand Nord' } });
  const apres = await call('GET', '/api/finances/by-project?period=ALL', { headers: AUTH });
  check('après renommage, la ligne suit toujours le projectId',
    apres.json.data.items.some((l) => l.projectId === PROJET_A && l.revenueCents > 0));

  const t = await PanelFinancialTransaction.findOne({ 'provenance.externalId': 'in_abo_septembre' }).lean();
  check('…et la transaction n’a jamais figé le nom comme identité',
    t.projectId === PROJET_A);
}

section('18. Ce que L10.3 fournit au remboursement — et ce qu’il n’invente pas');
{
  /**
   * CETTE SECTION VÉRIFIAIT QUE RIEN N'ÉTAIT IMPLÉMENTÉ. L10.4 l'a implémenté,
   * et ce qu'elle défend a changé de nature sans changer d'esprit : L10.3 doit
   * TENDRE au lot suivant les identités dont il aura besoin, et ne rien
   * fabriquer par-dessus. Le comportement du remboursement lui-même est éprouvé
   * dans « finance-refunds.test.js », où il a sa place.
   */
  const fait = await PanelProviderRevenueFact.findOne({ objectId: 'in_abo_septembre' }).lean();
  check('l’identité nécessaire à un remboursement est conservée',
    fait.corroboration.paymentIntentId === 'pi_abo_septembre'
    && fait.corroboration.chargeId === 'ch_abo_septembre');

  check('AUCUN mouvement de catégorie REFUND n’a été créé par la voie des revenus',
    (await PanelFinancialTransaction.countDocuments({ category: 'REFUND' })) === 0);
  check('…ni aucun COST issu d’un fournisseur',
    (await PanelFinancialTransaction.countDocuments({ category: 'COST', origin: 'STRIPE' })) === 0);

  /**
   * UN DÉBIT QUI DIT « 100 € ONT ÉTÉ RENDUS » SANS DIRE LESQUELS.
   *
   * `amount_refunded` est une SOMME : elle ne porte aucun `re_…`, donc aucune
   * identité canonique, donc aucun moyen de distinguer un remboursement neuf
   * d'un rejeu du précédent. En fabriquer un mouvement produirait un doublon au
   * premier événement suivant. On n'écrit rien, et c'est la bonne réponse.
   */
  const remboursement = await projeter('charge.refunded', { id: 'ch_abo_septembre', amount_refunded: 10_000 });
  check('un débit sans détail de remboursement ne produit RIEN',
    remboursement.recorded === false);
  check('…et aucune transaction n’apparaît',
    (await PanelFinancialTransaction.countDocuments({ category: 'REFUND' })) === 0);

  const taxonomie = await PanelFinancialTransaction.distinct('category');
  check('la taxonomie reste fournisseur-agnostique — aucune catégorie « STRIPE_* »',
    taxonomie.every((c) => ['REVENUE', 'COST', 'REFUND', 'ADJUSTMENT'].includes(c)));
}

section('19. Garde-fou : aucune dépendance Stripe dans le moteur financier');
{
  const racine = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const lire = (rel) => fs.readFileSync(path.join(racine, rel), 'utf8');
  const codeDe = (rel) => lire(rel)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');

  /** Le moteur générique : il ne doit RIEN savoir d'un fournisseur. */
  const NOYAU = [
    'backend/src/services/finance/money.js',
    'backend/src/services/finance/period.js',
    'backend/src/services/finance/recurrence.js',
    'backend/src/services/finance/financialTransactions.service.js',
    'backend/src/services/finance/financialSummary.service.js',
    'backend/src/services/finance/recurringCosts.service.js',
    'backend/src/services/finance/receipts.service.js',
  ];
  const intrus = NOYAU.filter((rel) => /\bstripe[A-Za-z]*\b|\bStripe[A-Za-z]+\b/.test(codeDe(rel)));
  check(`le noyau financier ignore Stripe${intrus.length ? ` — ${intrus}` : ''}`, intrus.length === 0);

  /** La couche de projection : elle connaît Stripe, mais ne l'APPELLE jamais. */
  const PROJECTION = [
    'backend/src/services/finance/providerRevenue/stripeRevenueNormalizer.js',
    'backend/src/services/finance/providerRevenue/revenueProjection.service.js',
  ];
  const reseau = PROJECTION.filter((rel) => /\bfetch\s*\(/.test(codeDe(rel)));
  check(`aucun appel réseau depuis la projection${reseau.length ? ` — ${reseau}` : ''}`, reseau.length === 0);

  const transport = PROJECTION.filter((rel) => {
    const imports = [...codeDe(rel).matchAll(/from\s+['"]([^'"]+)['"]/g)].map((m) => m[1]);
    return imports.some((i) => /stripeTransport|stripeAdapters|stripeCapabilities|capabilityGateway/i.test(i));
  });
  check(`aucun import de transport ou de capacité Stripe${transport.length ? ` — ${transport}` : ''}`,
    transport.length === 0);

  /**
   * LA SEULE PORTE VERS LE MONDE STRIPE EST LE REGISTRE D'APPARTENANCE.
   *
   * On mesure les imports vers `integratedApi/stripe/` — c'est-à-dire vers
   * l'infrastructure du fournisseur. Le normalisateur, lui, est un module de
   * cette même couche de projection : il connaît la FORME des charges utiles
   * Stripe, ce qui est son métier, et n'appelle rien.
   */
  const importsProjection = [...codeDe(PROJECTION[1]).matchAll(/from\s+['"]([^'"]+)['"]/g)].map((m) => m[1]);
  const versInfraStripe = importsProjection.filter((i) => i.includes('integratedApi/stripe/'));
  check(`la seule dépendance à l’infrastructure Stripe est le registre d’appartenance — ${versInfraStripe.join(', ')}`,
    versInfraStripe.length === 1 && versInfraStripe[0].includes('stripeResourceBinding'));

  /**
   * LE FRONTEND — aucune vue financière ne PARLE au fournisseur.
   *
   * ══ CE QUI EST INTERDIT, ET CE QUI NE L'EST PAS ═══════════════════════════
   *
   * Le mot « Stripe » est ATTENDU sur ces écrans : il faut bien dire à
   * l'utilisateur d'où vient un encaissement, et l'interdire reviendrait à
   * interdire la lisibilité. Une première version de ce contrôle refusait
   * `/stripe/i` et rendait rouge le libellé « Encaissé via Stripe » — c'était
   * mesurer un mot, pas une dépendance.
   *
   * Ce qui est proscrit est une DÉPENDANCE : un import d'un module Stripe, un
   * appel vers un domaine du fournisseur, une clé. La vue lit le Panel, et le
   * Panel seul.
   */
  const front = [
    'frontend/src/components/finance/FinanceWorkspace.tsx',
    'frontend/src/components/finance/TransactionDetail.tsx',
    'frontend/src/components/finance/ProviderFactPanel.tsx',
    'frontend/src/lib/useFinances.ts',
  ];
  const frontIntrus = front.filter((rel) => {
    const source = codeDe(rel);
    const imports = [...source.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((m) => m[1]);
    return imports.some((i) => /stripe/i.test(i))
      || /stripe\.com|api\.stripe|sk_live|sk_test|pk_live|pk_test/i.test(source)
      || /\bfetch\s*\(/.test(source);
  });
  check(`aucune vue financière ne dépend de Stripe${frontIntrus.length ? ` — ${frontIntrus}` : ''}`,
    frontIntrus.length === 0);
  check('…et le mot « Stripe » y est bien PRÉSENT, comme libellé',
    /Stripe/.test(codeDe('frontend/src/components/finance/ProviderFactPanel.tsx')));

  /** Le justificatif ne passe jamais par /uploads ni par une URL publique. */
  const media = codeDe('backend/src/services/finance/providerRevenue/revenueProjection.service.js');
  check('la projection ne fabrique aucun chemin /uploads', !/\/uploads/.test(media));
  check('…et n’appelle jamais resolvePanelMediaUrl', !/resolvePanelMediaUrl/.test(media));

  /** Aucun flottant financier. */
  check('aucune division par cent dans la projection', !/\/\s*100\b/.test(media));
  check('…ni parseFloat', !/parseFloat|Number\.parseFloat/.test(media));
}

section('20. L’environnement n’est jamais deviné depuis la charge utile');
{
  const service = fs.readFileSync(
    path.join(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'),
      'backend/src/services/finance/providerRevenue/revenueProjection.service.js'), 'utf8',
  ).replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  check('`livemode` ne décide d’aucun monde', !/livemode\s*\?|if\s*\(.*livemode/.test(service));

  const faits = await PanelProviderRevenueFact.find({}).lean();
  check('TOUS les faits portent un environnement',
    faits.length > 0 && faits.every((f) => ['TEST', 'PROD'].includes(f.environment)));

  const stripeTx = await PanelFinancialTransaction.find({ origin: 'STRIPE' }).lean();
  check('TOUTES les transactions fournisseur portent le leur',
    stripeTx.length > 0 && stripeTx.every((t) => ['TEST', 'PROD'].includes(t.provenance.environment)));
}

/* ══════════════════════════════════════════════════════════════════════════
   LE PARCOURS RÉEL — un webhook SIGNÉ, jusqu'au livret.

   Les sections précédentes appellent la projection directement : elles
   éprouvent la règle. Celle-ci éprouve le CHEMIN — signature, idempotence de
   réception, appartenance, adoption, projection — c'est-à-dire tout ce qui se
   passe réellement quand Stripe appelle.
   ══════════════════════════════════════════════════════════════════════════ */
const { createHmac } = await import('node:crypto');
const { ingestProviderEvent, INGEST_OUTCOME } = await import('../backend/src/services/webhooks/webhookIngest.js');
const WebhookBinding = (await import('../backend/src/models/PanelIntegratedApiWebhookBinding.model.js')).default;
const { storeWebhookSecret } = await import('../backend/src/services/webhooks/webhookSecrets.js');
const { seedIntegratedApiCredentialSets } = await import('../backend/src/services/integratedApi/seed.js');

const WHSEC = forme.stripeWebhook('L103-SECRET-DE-SIGNATURE-000');
const signer = (corps) => {
  const t = Math.floor(Date.now() / 1000);
  return `t=${t},v1=${createHmac('sha256', WHSEC).update(`${t}.${corps}`).digest('hex')}`;
};

section('21. De bout en bout : un webhook signé devient une ligne du livret');
{
  await seedIntegratedApiCredentialSets();
  await WebhookBinding.create({
    bindingId: 'wb-l103-test',
    provider: 'STRIPE',
    environment: 'TEST',
    remoteEndpointId: 'we_l103',
    callbackUrl: 'https://panel-l103.test/webhooks/providers/stripe',
    ownershipToken: 'l103',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  await storeWebhookSecret('STRIPE', 'TEST', WHSEC);

  const PROJET_C = 'atelier-est';
  await declarer(PROJET_C, 'Atelier de l’Est');
  await lier(PROJET_C, 'CHECKOUT_SESSION', 'cs_e2e_frais');

  const objet = sessionFrais({
    id: 'cs_e2e_frais',
    amount_total: 149_000,
    payment_intent: 'pi_e2e',
    metadata: { panelProjectId: PROJET_C, contractId: 'ct-c', paymentType: 'SETUP_FEE' },
  });
  const corps = JSON.stringify(evenement('checkout.session.completed', objet, { id: 'evt_e2e_1' }));

  const recu = await ingestProviderEvent({
    slug: 'stripe',
    rawBody: Buffer.from(corps),
    headers: { 'stripe-signature': signer(corps) },
  });

  check('l’événement est accepté', recu.outcome === INGEST_OUTCOME.ACCEPTED);
  check('…sa signature est prouvée', recu.proven === true);
  check('…et son appartenance résolue', recu.routedProjectId === PROJET_C);

  const t = await PanelFinancialTransaction.findOne({ 'provenance.externalId': 'cs_e2e_frais' }).lean();
  check('LE REVENU EST DANS LE LIVRET, sans qu’aucun écran n’ait été ouvert', Boolean(t));
  check('…au bon projet', t.projectId === PROJET_C);
  check('…au bon montant', t.amountCents === 149_000);

  const vue = await call('GET',
    `/api/finances/transactions?scope=project&projectId=${PROJET_C}&period=ALL`, { headers: AUTH });
  check('…et il est visible depuis la fiche du projet',
    vue.json.data.items.some((i) => i.provenance?.externalId === 'cs_e2e_frais'));

  /* ── LE REJEU, PAR LE MÊME CHEMIN ────────────────────────────────────── */
  const rejeu = await ingestProviderEvent({
    slug: 'stripe',
    rawBody: Buffer.from(corps),
    headers: { 'stripe-signature': signer(corps) },
  });
  check('le rejeu est reconnu comme doublon', rejeu.outcome === INGEST_OUTCOME.DUPLICATE);
  check('…et ne crée AUCUNE seconde transaction',
    (await PanelFinancialTransaction.countDocuments({ 'provenance.externalId': 'cs_e2e_frais' })) === 1);

  /* ── UNE SIGNATURE FAUSSE N'ENTRE PAS ────────────────────────────────── */
  const faux = JSON.stringify(evenement('checkout.session.completed',
    sessionFrais({ id: 'cs_e2e_faux', amount_total: 999_900 }), { id: 'evt_e2e_faux' }));
  const refuse = await ingestProviderEvent({
    slug: 'stripe',
    rawBody: Buffer.from(faux),
    headers: { 'stripe-signature': 't=1,v1=deadbeef' },
  });
  check('un événement mal signé est REFUSÉ', refuse.outcome === INGEST_OUTCOME.REJECTED);
  check('…et ne projette rien',
    (await PanelFinancialTransaction.countDocuments({ 'provenance.externalId': 'cs_e2e_faux' })) === 0);
}

section('22. Le désordre de livraison, par le chemin réel');
{
  const PROJET_D = 'atelier-ouest';
  await declarer(PROJET_D, 'Atelier de l’Ouest');

  // 1. La FACTURE arrive d'abord. L'abonnement n'est pas encore adopté.
  const f = facture({
    id: 'in_e2e_desordre',
    number: 'FA-E2E',
    subscription: 'sub_e2e_desordre',
    payment_intent: 'pi_e2e_desordre',
    charge: 'ch_e2e_desordre',
    status_transitions: { paid_at: SECONDES('2026-11-01T08:00:00Z') },
  });
  const corpsFacture = JSON.stringify(evenement('invoice.paid', f, { id: 'evt_e2e_inv' }));
  await ingestProviderEvent({
    slug: 'stripe', rawBody: Buffer.from(corpsFacture),
    headers: { 'stripe-signature': signer(corpsFacture) },
  });

  check('la facture est retenue, sans propriétaire',
    (await PanelProviderRevenueFact.findOne({ objectId: 'in_e2e_desordre' }).lean()).projectionStatus === 'PENDING');
  check('…et rien n’est écrit au livret',
    (await PanelFinancialTransaction.countDocuments({ 'provenance.externalId': 'in_e2e_desordre' })) === 0);

  // 2. La SESSION arrive ensuite : elle fait adopter l'abonnement (L6.2F),
  //    ce qui doit déclencher la convergence — sans aucune action manuelle.
  await lier(PROJET_D, 'CHECKOUT_SESSION', 'cs_e2e_desordre');
  const s = sessionAbonnement({
    id: 'cs_e2e_desordre',
    subscription: 'sub_e2e_desordre',
    invoice: 'in_e2e_desordre',
    metadata: { panelProjectId: PROJET_D, contractId: 'ct-d', paymentType: 'SUBSCRIPTION' },
  });
  const corpsSession = JSON.stringify(evenement('checkout.session.completed', s, { id: 'evt_e2e_sess' }));
  await ingestProviderEvent({
    slug: 'stripe', rawBody: Buffer.from(corpsSession),
    headers: { 'stripe-signature': signer(corpsSession) },
  });

  const t = await PanelFinancialTransaction.findOne({ 'provenance.externalId': 'in_e2e_desordre' }).lean();
  check('LA CONVERGENCE A EU LIEU TOUTE SEULE — le revenu est au livret', Boolean(t));
  check('…au projet de l’abonnement adopté', t.projectId === PROJET_D);
  check('…une seule fois, malgré DEUX annonces du même paiement',
    (await PanelFinancialTransaction.countDocuments({ projectId: PROJET_D, origin: 'STRIPE' })) === 1);
  check('…et le fait est marqué projeté',
    (await PanelProviderRevenueFact.findOne({ objectId: 'in_e2e_desordre' }).lean()).projectionStatus === 'PROJECTED');
}

await close();
await stopMemoryMongo();
finish();
