// LA PREMIÈRE ADOPTION — et pourquoi elle reste une preuve (L6.2F).
//
// ══ LA SYMÉTRIE QUE CE LOT CASSE, ET POURQUOI C'EST LÉGITIME ═════════════════
//
// Depuis L6.2A, une ressource n'appartient à un projet que parce que le Panel
// l'a CRÉÉE. Toute autre voie a été refusée, lot après lot : un identifiant
// présenté n'est pas une preuve de propriété.
//
// L'abonnement ne peut pas suivre cette règle. Le Panel crée le client, le
// produit, le tarif et la session — mais Stripe crée la Subscription, tout
// seul, au moment où le client paie. Il n'existe aucun `subscriptions.create()`
// à contrôler.
//
// La filiation remplace la création :
//
//     Session possédée  →  `session.subscription`  →  Subscription adoptée
//
// Ce n'est pas « on nous a dit que » : le fournisseur lui-même, sur un objet
// que nous possédons déjà, désigne la ressource comme issue de cet objet.
//
// ══ CE QUE CE TEST DOIT DONC PROUVER EN PRIORITÉ ═════════════════════════════
//
// Que l'adoption ne s'obtient JAMAIS autrement. Les sections 5 à 8 ne testent
// que des tentatives de contournement — metadata mensongères, session d'un
// autre, abonnement présenté sans filiation, arrivées dans le désordre.
import http from 'node:http';
import { createHmac } from 'node:crypto';

import {
  check, connectTestDatabase, finish, section, setTestEnv,
  startMemoryMongo, startServer,
} from './helpers/harness.js';
import { startSbAutoInstance } from './helpers/sbauto-remote.js';

setTestEnv();
const MONGO_URI = await startMemoryMongo();
await connectTestDatabase();

/** Composé à l'exécution : une chaîne de cette forme est un secret aux yeux du dépôt. */
const prefixe = (monde) => ['sk', monde, ''].join('_');
const CLE_PANEL = `${prefixe('test')}L62FSENTINELLEPANEL0000000001`;
const CLE_PROJET = `${prefixe('test')}L62FSENTINELLEPROJETJAMAISVUE2`;
const WHSEC = 'whsec_l62f_secret_de_signature_0001';

const ACTEUR = { userId: 'u-dev', userEmail: 'dev@panel.test' };
const CHECKOUT = 'billing.checkout.create';
const READ_SESSION = 'billing.checkout.retrieve';
const READ_SUB = 'billing.subscription.retrieve';
const PRICE = 'billing.price.ensure';
const CUSTOMER = 'billing.customer.ensure';

/* ══════════════════════════════════════════════════════════════════════════
   UN FAUX STRIPE COMPLET — sessions, abonnements, et un compteur d'appels.
   ══════════════════════════════════════════════════════════════════════════ */
const appels = [];
const parCle = new Map();
const parId = new Map();
let sequence = 0;

const lireCorps = (req) => new Promise((resolve) => {
  let brut = '';
  req.on('data', (c) => { brut += c; });
  req.on('end', () => resolve(brut));
});

const fauxStripe = http.createServer(async (req, res) => {
  const cle = req.headers['idempotency-key'] ?? null;
  const auth = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
  const corps = req.method === 'POST' ? await lireCorps(req) : '';
  appels.push({ method: req.method, url: req.url, cle, auth, corps });

  const repondre = (code, objet) => {
    res.writeHead(code, { 'content-type': 'application/json' });
    res.end(JSON.stringify(objet));
  };

  if (req.url === '/v1/account') return repondre(200, { id: 'acct_panel', country: 'FR' });

  if (req.method === 'POST' && ['/v1/customers', '/v1/products', '/v1/prices', '/v1/checkout/sessions'].includes(req.url)) {
    const connu = parCle.get(cle);
    if (connu) return repondre(200, connu);
    sequence += 1;
    return repondre(200, fabriquer(req.url, cle, corps));
  }

  const lecture = /^\/v1\/(customers|prices|subscriptions|checkout\/sessions)\/([^/?]+)$/.exec(req.url ?? '');
  if (req.method === 'GET' && lecture) {
    const objet = parId.get(decodeURIComponent(lecture[2]));
    if (!objet) return repondre(404, { error: { code: 'resource_missing', message: 'introuvable' } });
    return repondre(200, objet);
  }

  return repondre(404, { error: { message: 'route inconnue' } });
});

function fabriquer(url, cle, corps) {
  const params = new URLSearchParams(corps);
  const prefixes = {
    '/v1/customers': 'cus', '/v1/products': 'prod',
    '/v1/prices': 'price', '/v1/checkout/sessions': 'cs',
  };
  const id = `${prefixes[url]}_test_${sequence}`;
  const objet = { id, object: prefixes[url] };
  if (url === '/v1/checkout/sessions') {
    Object.assign(objet, {
      url: `https://pay.test/${id}`,
      status: 'open',
      payment_status: 'unpaid',
      mode: params.get('mode'),
      customer: params.get('customer'),
      subscription: null,
      metadata: { panelProjectId: params.get('metadata[panelProjectId]'), contractId: params.get('metadata[contractId]') },
    });
  }
  parCle.set(cle, objet);
  parId.set(id, objet);
  return objet;
}

/**
 * LE PAIEMENT — ce que Stripe fait tout seul, et que le Panel ne contrôle pas.
 * C'est ce geste qui fait naître la Subscription, et donc tout le problème du lot.
 */
function payer(sessionId, { subscriptionId } = {}) {
  const session = parId.get(sessionId);
  const sub = subscriptionId ?? `sub_test_${(sequence += 1)}`;
  Object.assign(session, { status: 'complete', payment_status: 'paid', subscription: sub, url: null });
  parId.set(sub, {
    id: sub, object: 'subscription', status: 'active',
    cancel_at_period_end: false,
    current_period_start: 1_780_000_000, current_period_end: 1_790_000_000,
    latest_invoice: `in_${sub}`, customer: session.customer,
  });
  return sub;
}

const lectures = (p) => appels.filter((a) => a.method === 'GET' && a.url.startsWith(p));

await new Promise((resolve) => fauxStripe.listen(0, '127.0.0.1', resolve));
const STRIPE_BASE = `http://127.0.0.1:${fauxStripe.address().port}`;

/* ══════════════════════════════════════════════════════════════════════════
   LE PANEL
   ══════════════════════════════════════════════════════════════════════════ */
const { createApp } = await import('../backend/src/app.js');
const registre = await import('../backend/src/services/registry/projectRegistry.service.js');
const controlPlane = await import('../backend/src/services/integratedApi/controlPlane.service.js');
const { seedIntegratedApiCredentialSets } = await import('../backend/src/services/integratedApi/seed.js');
const { resetSyncCore } = await import('../backend/src/services/sync/syncCore.service.js');
const { updateNetworkConfiguration } = await import('../backend/src/services/network/networkConfig.service.js');
const { PanelProjectContract } = await import('../backend/src/models/PanelProjectProjection.model.js');
const { default: PanelStripeResourceBinding } = await import('../backend/src/models/PanelStripeResourceBinding.model.js');
const binding = await import('../backend/src/services/integratedApi/stripe/stripeResourceBinding.js');
const adoption = await import('../backend/src/services/integratedApi/stripe/stripeSubscriptionAdoption.js');
const routing = await import('../backend/src/services/webhooks/stripeEventRouting.js');
const { ingestProviderEvent, INGEST_OUTCOME } = await import('../backend/src/services/webhooks/webhookIngest.js');
const { default: WebhookEvent } = await import('../backend/src/models/PanelProviderWebhookEvent.model.js');
const { default: WebhookBinding } = await import('../backend/src/models/PanelIntegratedApiWebhookBinding.model.js');
const { storeWebhookSecret } = await import('../backend/src/services/webhooks/webhookSecrets.js');

await resetSyncCore();
await seedIntegratedApiCredentialSets();
await updateNetworkConfiguration({ backendUrl: 'https://panel-l62f.test' }, { requirePublic: false });

const { base: panelUrl } = await startServer(createApp());

section('1. Le coffre');
{
  await controlPlane.saveCredentialSet('STRIPE', 'TEST', {
    values: { secretKey: CLE_PANEL, baseUrl: STRIPE_BASE },
  }, ACTEUR);
  const verdict = await controlPlane.validateCredentialSet('STRIPE', 'TEST', { actor: ACTEUR });
  check('la clé du Panel est validée', verdict.validation.status === 'VALID');
}

/* ══════════════════════════════════════════════════════════════════════════
   2. DEUX PROJETS RÉELS
   ══════════════════════════════════════════════════════════════════════════ */
const projetA = await startSbAutoInstance({
  mongoUri: MONGO_URI, dbName: 'sbauto_l62f_a', env: 'TEST', projectName: 'SB Auto L6.2F A',
});
const projetB = await startSbAutoInstance({
  mongoUri: MONGO_URI, dbName: 'sbauto_l62f_b', env: 'TEST', projectName: 'SB Auto L6.2F B',
});

const CONTRAT_A = 'contrat-l62f-a-00000000001';
const CONTRAT_B = 'contrat-l62f-b-00000000002';
let idA;
let idB;

async function semer(projectId, sourceContractId) {
  await PanelProjectContract.updateOne(
    { projectId },
    {
      $set: {
        projectId, hasCurrent: true, sourceContractId, status: 'ACTIVE',
        reference: `CTR-${sourceContractId.slice(-4)}`,
        document: { available: true, status: 'SIGNED', version: 1 },
        pricing: {
          launchFee: { amountIncludingTax: 118_800, currency: 'EUR', interval: null },
          subscription: { amountIncludingTax: 11_880, currency: 'EUR', interval: 'MONTH' },
        },
        sourceModifiedAt: new Date().toISOString(),
        receivedAt: new Date().toISOString(),
      },
    },
    { upsert: true },
  );
}

async function appairer(instance) {
  const declare = await registre.declareProject({
    publicBackendUrl: instance.publicBackendUrl,
    projectName: instance.projectName,
    environment: 'TEST',
  });
  const reponse = await instance.pair({
    panelUrl, pairingCode: declare.pairingCode, publicBackendUrl: instance.publicBackendUrl,
  });
  instance.projectId = reponse.projectId;
  await instance.heartbeat();
  return reponse.projectId;
}

section('2. Deux projets appairés, ouverts');
{
  idA = await appairer(projetA);
  idB = await appairer(projetB);
  for (const id of [idA, idB]) {
  }
  await projetA.syncNow();
  await projetB.syncNow();
  await semer(idA, CONTRAT_A);
  await semer(idB, CONTRAT_B);
  check('deux projets distincts', typeof idA === 'string' && idA !== idB);
}

/* ══════════════════════════════════════════════════════════════════════════
   3. L'ADOPTION PAR LA LECTURE — convergence sans webhook
   ══════════════════════════════════════════════════════════════════════════ */
const OP_A = `checkout-sub-${CONTRAT_A}-v1-month-11880-TEST-a0`;
let sessionA;
let subA;

section('3. Une session payée, relue : l’abonnement est adopté au passage');
{
  await semer(idA, CONTRAT_A);
  const ouverte = await projetA.invokeCapability({
    code: CHECKOUT,
    input: {
      contractRef: CONTRAT_A, paymentType: 'SUBSCRIPTION',
      successUrl: 'https://a.test/ok', cancelUrl: 'https://a.test/ko',
      operationId: OP_A,
    },
  });
  sessionA = ouverte.data.result.checkoutSessionId;
  check('la session d’abonnement est ouverte', ouverte.ok === true);

  /* AVANT paiement : rien à adopter, et ce n'est pas une anomalie. */
  const avantPaiement = await projetA.invokeCapability({
    code: READ_SESSION,
    input: { checkoutSessionId: sessionA, operationId: 'op-l62f-avant-paiement-1' },
  });
  check('avant paiement, aucun abonnement', avantPaiement.data.result.subscriptionId === null);
  check('…et aucun lien SUBSCRIPTION',
    (await PanelStripeResourceBinding.countDocuments({ resourceType: 'SUBSCRIPTION' })) === 0);

  /* LE CLIENT PAIE — Stripe crée la Subscription, sans nous. */
  subA = payer(sessionA);

  const apres = await projetA.invokeCapability({
    code: READ_SESSION,
    input: { checkoutSessionId: sessionA, operationId: 'op-l62f-apres-paiement-1' },
  });
  check('la session rend désormais l’abonnement', apres.data.result.subscriptionId === subA);

  const lien = await binding.findBinding({
    environment: 'TEST', resourceType: 'SUBSCRIPTION', resourceId: subA,
  });
  check('L’ABONNEMENT EST ADOPTÉ', lien !== null);
  check('…au projet propriétaire de la session', lien.projectId === idA);
  check('…et la provenance NOMME la session', lien.createdByOperationId
    === adoption.subscriptionProvenance({ environment: 'TEST', checkoutSessionId: sessionA }));
  check('…la source dit comment on l’a appris', lien.source === 'IMPORTED_WITH_PROOF');
  check('la PREUVE porte la filiation', lien.proof?.derivedFromResourceId === sessionA);
  check('…et son type', lien.proof?.derivedFromResourceType === 'CHECKOUT_SESSION');
  check('…le client est corroboré', lien.proof?.customerCorroborated === true);
}

/* ══════════════════════════════════════════════════════════════════════════
   4. LA LECTURE D'ABONNEMENT — servie parce qu'il a un propriétaire
   ══════════════════════════════════════════════════════════════════════════ */
section('4. A lit SON abonnement');
{
  const avant = lectures('/v1/subscriptions/').length;
  const lu = await projetA.invokeCapability({
    code: READ_SUB,
    input: { subscriptionId: subA, operationId: 'op-l62f-lecture-sub-a01' },
  });
  check('la lecture réussit', lu.ok === true);
  check('…UN appel Stripe', lectures('/v1/subscriptions/').length === avant + 1);
  check('…avec la clé du COFFRE', appels.at(-1).auth === CLE_PANEL);

  const attendus = ['subscriptionId', 'status', 'cancelAtPeriodEnd', 'currentPeriodStart',
    'currentPeriodEnd', 'latestInvoiceId', 'customerId'].sort();
  check('le DTO porte EXACTEMENT les sept champs contractés',
    JSON.stringify(Object.keys(lu.data.result).sort()) === JSON.stringify(attendus));
  check('…le statut', lu.data.result.status === 'active');
  check('…la période', lu.data.result.currentPeriodEnd === 1_790_000_000);
  check('aucune ligne d’abonnement ne traverse', !('items' in lu.data.result));
  check('aucun moyen de paiement ne traverse', !('default_payment_method' in lu.data.result));
}

/* ══════════════════════════════════════════════════════════════════════════
   5. CROSS-TENANT — la filiation ne se prête pas
   ══════════════════════════════════════════════════════════════════════════ */
section('5. Le projet B n’atteint ni la session ni l’abonnement de A');
{
  const avant = lectures('/v1/subscriptions/').length;

  const volSub = await projetB.invokeCapability({
    code: READ_SUB, input: { subscriptionId: subA, operationId: 'op-l62f-vol-sub-b0001' },
  });
  check('B lisant l’abonnement de A → refusé', volSub.ok === false);
  check('…code CAPABILITY_RESOURCE_NOT_OWNED', volSub.code === 'CAPABILITY_RESOURCE_NOT_OWNED');

  const inconnu = await projetB.invokeCapability({
    code: READ_SUB, input: { subscriptionId: 'sub_test_inexistant', operationId: 'op-l62f-inconnu-b00001' },
  });
  check('un abonnement inconnu → refusé', inconnu.ok === false);
  check('…MÊME code', inconnu.code === volSub.code);
  check('…MÊME message', inconnu.message === volSub.message);
  check('…MÊME statut', inconnu.httpStatus === volSub.httpStatus);
  check('LES REFUS N’ONT COÛTÉ AUCUN APPEL STRIPE',
    lectures('/v1/subscriptions/').length === avant);

  const volSession = await projetB.invokeCapability({
    code: READ_SESSION, input: { checkoutSessionId: sessionA, operationId: 'op-l62f-vol-sess-b0001' },
  });
  check('B lisant la session de A → refusé', volSession.ok === false);

  // Et B ne peut pas s'approprier l'abonnement par le registre.
  let conflit = null;
  try {
    await binding.bindResource({
      projectId: idB, environment: 'TEST', resourceType: 'SUBSCRIPTION', resourceId: subA,
    });
  } catch (err) { conflit = err; }
  check('B adoptant l’abonnement de A → conflit', conflit?.code === 'STRIPE_RESOURCE_ALREADY_BOUND');
  check('…l’abonnement reste à A',
    (await binding.findBinding({ environment: 'TEST', resourceType: 'SUBSCRIPTION', resourceId: subA }))?.projectId === idA);
}

/* ══════════════════════════════════════════════════════════════════════════
   6. LA FILIATION EST LA SEULE VOIE
   ══════════════════════════════════════════════════════════════════════════ */
section('6. Sans session possédée, aucune adoption — quoi qu’en disent les metadata');
{
  const avant = await PanelStripeResourceBinding.countDocuments({ resourceType: 'SUBSCRIPTION' });

  /* 6a. Une session que le Panel ne possède pas, même en réclamant A. */
  const orpheline = {
    id: 'cs_test_jamais_liee', mode: 'subscription', subscription: 'sub_test_orphelin',
    customer: 'cus_test_inconnu',
    metadata: { panelProjectId: idA, contractId: CONTRAT_A },
  };
  const refusee = await adoption.adoptSubscriptionFromSession({
    environment: 'TEST', session: orpheline, source: 'LEARNED_FROM_WEBHOOK',
  });
  check('session non possédée → AUCUNE adoption', refusee.outcome === adoption.ADOPTION.NOT_ELIGIBLE);
  check('…malgré des metadata qui désignent A', refusee.projectId === null);
  check('…et aucun lien créé',
    (await PanelStripeResourceBinding.countDocuments({ resourceType: 'SUBSCRIPTION' })) === avant);

  /* 6b. Une session possédée, mais qui n'a produit aucun abonnement. */
  await semer(idB, CONTRAT_B);
  const sessionB = (await projetB.invokeCapability({
    code: CHECKOUT,
    input: {
      contractRef: CONTRAT_B, paymentType: 'SUBSCRIPTION',
      successUrl: 'https://b.test/ok', cancelUrl: 'https://b.test/ko',
      operationId: `checkout-sub-${CONTRAT_B}-v1-month-11880-TEST-a0`,
    },
  })).data.result.checkoutSessionId;

  const pasEncore = await adoption.adoptSubscriptionFromSession({
    environment: 'TEST', session: parId.get(sessionB), source: 'IMPORTED_WITH_PROOF',
  });
  check('session possédée mais non payée → rien à adopter',
    pasEncore.outcome === adoption.ADOPTION.NOT_ELIGIBLE);
  check('…et ce n’est PAS une erreur', pasEncore.subscriptionId === null);

  /* 6c. Metadata mensongères sur une session RÉELLEMENT possédée par A. */
  const menteuse = { ...parId.get(sessionA), metadata: { panelProjectId: idB, contractId: CONTRAT_B } };
  const quandMeme = await adoption.adoptSubscriptionFromSession({
    environment: 'TEST', session: menteuse, source: 'LEARNED_FROM_WEBHOOK',
  });
  check('metadata désignant B, session de A → adoption vers A',
    quandMeme.projectId === idA);
  check('…et la divergence est signalée', quandMeme.claimMismatch === true);
  check('…l’abonnement appartient TOUJOURS à A',
    (await binding.findBinding({ environment: 'TEST', resourceType: 'SUBSCRIPTION', resourceId: subA }))?.projectId === idA);
}

/* ══════════════════════════════════════════════════════════════════════════
   7. IDEMPOTENCE ET CONCURRENCE
   ══════════════════════════════════════════════════════════════════════════ */
section('7. Adopter deux fois, adopter huit fois');
{
  const session = parId.get(sessionA);
  const rejeu = await adoption.adoptSubscriptionFromSession({
    environment: 'TEST', session, source: 'IMPORTED_WITH_PROOF',
  });
  check('le rejeu est ABSORBÉ', rejeu.outcome === adoption.ADOPTION.ALREADY_ADOPTED);
  check('…sur le même projet', rejeu.projectId === idA);
  check('…et une seule ligne en base',
    (await PanelStripeResourceBinding.countDocuments({
      environment: 'TEST', resourceType: 'SUBSCRIPTION', resourceId: subA,
    })) === 1);

  const resultats = await Promise.all(Array.from({ length: 8 }, () =>
    adoption.adoptSubscriptionFromSession({ environment: 'TEST', session, source: 'IMPORTED_WITH_PROOF' })));
  check('8 adoptions concurrentes : aucune n’échoue',
    resultats.every((r) => [adoption.ADOPTION.ADOPTED, adoption.ADOPTION.ALREADY_ADOPTED].includes(r.outcome)));
  check('…toujours UNE seule ligne',
    (await PanelStripeResourceBinding.countDocuments({
      environment: 'TEST', resourceType: 'SUBSCRIPTION', resourceId: subA,
    })) === 1);

  /* CRASH APRÈS VALIDATION, AVANT LE LIEN : le rejeu répare. */
  await PanelStripeResourceBinding.deleteOne({ environment: 'TEST', resourceId: subA });
  check('le lien a disparu',
    (await binding.findBinding({ environment: 'TEST', resourceType: 'SUBSCRIPTION', resourceId: subA })) === null);
  const repare = await adoption.adoptSubscriptionFromSession({
    environment: 'TEST', session, source: 'IMPORTED_WITH_PROOF',
  });
  check('la reprise ré-adopte', repare.outcome === adoption.ADOPTION.ADOPTED);
  check('…au même projet', repare.projectId === idA);
  check('…et la provenance est identique',
    (await binding.findBinding({ environment: 'TEST', resourceType: 'SUBSCRIPTION', resourceId: subA }))
      ?.createdByOperationId === adoption.subscriptionProvenance({ environment: 'TEST', checkoutSessionId: sessionA }));
}

/* ══════════════════════════════════════════════════════════════════════════
   8. LE WEBHOOK — et les arrivées dans le désordre
   ══════════════════════════════════════════════════════════════════════════ */
const signer = (corps, secret) => {
  const t = Math.floor(Date.now() / 1000);
  return `t=${t},v1=${createHmac('sha256', secret).update(`${t}.${corps}`).digest('hex')}`;
};
const evenement = (id, type, object) => JSON.stringify({ id, type, data: { object } });
const recevoir = async (id, type, object) => {
  const corps = evenement(id, type, object);
  return ingestProviderEvent({
    slug: 'stripe', rawBody: Buffer.from(corps),
    headers: { 'stripe-signature': signer(corps, WHSEC) },
  });
};

section('8. Le pipeline webhook adopte, puis route');
{
  /**
   * ══ LE PANEL A DÉJÀ SON ENDPOINT — ON L'ADOPTE, ON N'EN CRÉE PAS UN SECOND ═
   *
   * Cette section créait le binding d'endpoint de toutes pièces. Elle ne le
   * peut plus, et c'est un progrès du produit : depuis que le Panel réconcilie
   * ses webhooks à l'enregistrement des identifiants, il POSSÈDE déjà son
   * endpoint `STRIPE/TEST/PANEL`. L'index unique du modèle interdit le second —
   * « un seul endpoint par fournisseur et par monde » — et il a raison : deux
   * bindings concurrents, c'est un événement livré deux fois, ou pas du tout.
   *
   * On adopte donc celui qui existe, en y inscrivant l'endpoint distant que
   * cette recette veut éprouver. Le repli `create` reste, pour le cas où la
   * réconciliation n'aurait rien posé — la section doit tenir dans les deux
   * mondes, pas dans celui qu'on suppose.
   */
  await (async () => {
    const existant = await WebhookBinding.findOne({
      provider: 'STRIPE', environment: 'TEST', destination: 'PANEL', projectId: null,
    });
    if (existant) {
      existant.remoteEndpointId = 'we_l62f';
      existant.callbackUrl = `${panelUrl}/webhooks/providers/stripe`;
      existant.updatedAt = new Date().toISOString();
      await existant.save();
      return existant;
    }
    return WebhookBinding.create({
      bindingId: 'wb-l62f-test', provider: 'STRIPE', environment: 'TEST',
      remoteEndpointId: 'we_l62f', callbackUrl: `${panelUrl}/webhooks/providers/stripe`,
      ownershipToken: 'l62f', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    });
  })();
  await storeWebhookSecret('STRIPE', 'TEST', WHSEC);

  /* ── CAS B : l'abonnement arrive AVANT que sa session ait été vue ──────── */
  const sessionTardive = (await projetA.invokeCapability({
    code: CHECKOUT,
    input: {
      contractRef: CONTRAT_A, paymentType: 'SUBSCRIPTION',
      successUrl: 'https://a.test/ok', cancelUrl: 'https://a.test/ko',
      operationId: `${OP_A}-tardif`,
    },
  })).data.result.checkoutSessionId;
  const subTardif = payer(sessionTardive);

  const precoce = await recevoir('evt_l62f_precoce', 'customer.subscription.updated', {
    id: subTardif, object: 'subscription', status: 'active',
    metadata: { panelProjectId: idA },
  });
  check('un abonnement non encore adopté n’est routé à PERSONNE',
    precoce.routedProjectId === null);
  check('…et son motif est nommé', precoce.ownership === routing.EVENT_OWNERSHIP.UNOWNED);
  check('…malgré des metadata qui le réclament', precoce.outcome === INGEST_OUTCOME.ACCEPTED);
  const traceP = await WebhookEvent.findOne({ providerEventId: 'evt_l62f_precoce' }).lean();
  check('…mais il reste TRAÇABLE', Boolean(traceP) && traceP.projectId === null);

  /* ── CAS A : la session arrive ensuite → adoption, puis convergence ────── */
  const sessionEvent = await recevoir('evt_l62f_session', 'checkout.session.completed',
    parId.get(sessionTardive));
  check('la session est routée vers son projet', sessionEvent.routedProjectId === idA);
  const lienTardif = await binding.findBinding({
    environment: 'TEST', resourceType: 'SUBSCRIPTION', resourceId: subTardif,
  });
  check('L’ABONNEMENT EST ADOPTÉ PAR LE WEBHOOK', lienTardif?.projectId === idA);
  check('…et la source dit qu’on l’a appris d’un événement',
    lienTardif.source === 'LEARNED_FROM_WEBHOOK');

  /* ── CONVERGENCE : le même événement d'abonnement, rejoué plus tard ───── */
  const tardif = await recevoir('evt_l62f_tardif', 'customer.subscription.updated', {
    id: subTardif, object: 'subscription', status: 'active',
  });
  check('MAINTENANT il est routé', tardif.routedProjectId === idA);
  check('…par appartenance prouvée', tardif.ownership === routing.EVENT_OWNERSHIP.OWNED);
  check('AUCUN acte financier n’a été nécessaire pour converger',
    !appels.some((a) => a.method === 'POST' && a.url === '/v1/subscriptions'));

  /* ── DUPLICATA ─────────────────────────────────────────────────────────── */
  const dup = await recevoir('evt_l62f_tardif', 'customer.subscription.updated', {
    id: subTardif, object: 'subscription', status: 'active',
  });
  check('un doublon est absorbé', dup.outcome === INGEST_OUTCOME.DUPLICATE);
  check('…et une seule ligne en base',
    (await WebhookEvent.countDocuments({ providerEventId: 'evt_l62f_tardif' })) === 1);

  /* ── ORDRE : l'événement d'abonnement d'un AUTRE projet ────────────────── */
  const croise = await recevoir('evt_l62f_croise', 'customer.subscription.updated', {
    id: subTardif, object: 'subscription', metadata: { panelProjectId: idB },
  });
  check('metadata désignant B → routé vers A quand même', croise.routedProjectId === idA);
  check('…et jamais vers B', croise.routedProjectId !== idB);
}

/* ══════════════════════════════════════════════════════════════════════════
   9. RÉVOCATION ET MONDES
   ══════════════════════════════════════════════════════════════════════════ */
section('9. Révoqué, et TEST/PROD');
{
  const sessionR = (await projetB.invokeCapability({
    code: CHECKOUT,
    input: {
      contractRef: CONTRAT_B, paymentType: 'SUBSCRIPTION',
      successUrl: 'https://b.test/ok', cancelUrl: 'https://b.test/ko',
      operationId: `checkout-sub-${CONTRAT_B}-v1-month-11880-TEST-a1`,
    },
  })).data.result.checkoutSessionId;
  const subR = payer(sessionR);
  await adoption.adoptSubscriptionFromSession({
    environment: 'TEST', session: parId.get(sessionR), source: 'IMPORTED_WITH_PROOF',
  });
  await binding.revokeBinding({
    environment: 'TEST', resourceType: 'SUBSCRIPTION', resourceId: subR, reason: 'E2E',
  });

  const avant = lectures('/v1/subscriptions/').length;
  const revoque = await projetB.invokeCapability({
    code: READ_SUB, input: { subscriptionId: subR, operationId: 'op-l62f-revoque-b00001' },
  });
  check('un abonnement révoqué → refusé', revoque.ok === false);
  check('…MÊME code qu’un inconnu', revoque.code === 'CAPABILITY_RESOURCE_NOT_OWNED');
  check('…et aucun appel Stripe', lectures('/v1/subscriptions/').length === avant);

  const revocEvent = await recevoir('evt_l62f_revoque', 'customer.subscription.updated', {
    id: subR, object: 'subscription', status: 'active',
  });
  check('…et il n’est plus routé', revocEvent.routedProjectId === null);
  check('…avec son motif propre', revocEvent.ownership === routing.EVENT_OWNERSHIP.REVOKED);

  // Les mondes.
  check('la provenance porte le MONDE',
    adoption.subscriptionProvenance({ environment: 'TEST', checkoutSessionId: sessionA })
    !== adoption.subscriptionProvenance({ environment: 'PROD', checkoutSessionId: sessionA }));
  const enProd = await binding.describeOwnership({
    projectId: idA, environment: 'PROD', resourceType: 'SUBSCRIPTION', resourceId: subA,
  });
  check('l’abonnement TEST de A n’existe pas en PROD', enProd.allowed === false);
  check('…motif « aucun lien »', enProd.reason === 'NO_BINDING');
}

/* ══════════════════════════════════════════════════════════════════════════
   10. BILAN
   ══════════════════════════════════════════════════════════════════════════ */
section('10. Bilan');
{
  const cles = new Set(appels.map((a) => a.auth).filter(Boolean));
  check('exactement UNE clé a parlé à Stripe', cles.size === 1);
  check('…celle du coffre du Panel', cles.has(CLE_PANEL));
  check('la sentinelle du projet n’apparaît nulle part',
    !JSON.stringify(appels).includes(CLE_PROJET));

  /**
   * AUCUN ABONNEMENT N'A ÉTÉ CRÉÉ PAR NOUS — c'est le fait qui rend ce lot
   * nécessaire, et le vérifier garde la porte fermée : le jour où quelqu'un
   * ajouterait un `subscriptions.create`, l'adoption cesserait d'être la seule
   * voie et la doctrine tomberait sans bruit.
   */
  check('AUCUN POST /v1/subscriptions',
    !appels.some((a) => a.method === 'POST' && a.url.startsWith('/v1/subscriptions')));
  check('aucune écriture sur un abonnement',
    !appels.some((a) => a.method === 'POST' && /^\/v1\/subscriptions\//.test(a.url)));

  const liens = await PanelStripeResourceBinding.find({ resourceType: 'SUBSCRIPTION' }).lean();
  check('chaque abonnement lié porte sa filiation',
    liens.every((l) => Boolean(l.proof?.derivedFromResourceId)));
  check('…et aucun n’est lié sans projet', liens.every((l) => Boolean(l.projectId)));

  for (const [nom, instance] of [['A', projetA], ['B', projetB]]) {
    const dump = JSON.stringify(await instance.dbDump());
    check(`la base du projet ${nom} ne contient aucune clé Stripe`,
      !dump.includes(CLE_PANEL) && !dump.includes(CLE_PROJET));
  }
}

await projetA.stop();
await projetB.stop();
fauxStripe.close();
finish();
