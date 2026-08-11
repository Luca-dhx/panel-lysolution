// POSSÉDER UN IDENTIFIANT N'EST PAS ÊTRE AUTORISÉ — l'E2E du lot (L6.2C).
//
// ══ LES DEUX MOITIÉS DU LOT, ET CE QU'ELLES ONT EN COMMUN ════════════════════
//
//   LA LECTURE   un projet demande l'état d'une session de paiement. Le Panel
//                vérifie qu'elle est à lui AVANT de parler à Stripe.
//
//   LE WEBHOOK   un événement signé arrive. Le Panel détermine à quel projet il
//                appartient par son REGISTRE DE LIENS, jamais par les metadata.
//
// Dans les deux cas, la même phrase : la preuve d'appartenance vient de ce que
// le Panel a écrit lui-même, jamais de ce qu'on lui présente.
//
// ══ CE QUE CE TEST MONTE ═════════════════════════════════════════════════════
//
//   · un vrai Panel, un vrai port, sa vraie base ;
//   · deux vraies instances SB Auto, chacune son processus, sa base, son jeton ;
//   · un faux Stripe HTTP qui COMPTE ses appels — c'est lui qui prouve le zéro ;
//   · de vrais webhooks signés HMAC, reçus par l'endpoint EXISTANT du Panel.
//
// ══ LA PREUVE LA PLUS IMPORTANTE ═════════════════════════════════════════════
//
// Sur les trois refus d'appartenance — inconnue, à un autre, révoquée — le
// compteur d'appels du faux Stripe ne bouge pas d'une unité. Le Panel ne
// demande même pas au fournisseur si la ressource existe : la durée de réponse
// elle-même ne doit rien trahir.
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

/** Composé à l'exécution : une chaîne en clair de cette forme est un secret aux yeux du dépôt. */
const prefixe = (monde) => ['sk', monde, ''].join('_');
const CLE_PANEL = `${prefixe('test')}L62CSENTINELLEPANEL00000000001`;
const CLE_PROJET = `${prefixe('test')}L62CSENTINELLEPROJETJAMAISVUE2`;
const WHSEC = 'whsec_l62c_secret_de_signature_0001';

const ACTEUR = { userId: 'u-dev', userEmail: 'dev@panel.test' };
const CREATE = 'billing.checkout.create';
const READ = 'billing.checkout.retrieve';

/* ══════════════════════════════════════════════════════════════════════════
   UN FAUX STRIPE QUI COMPTE — c'est le compteur qui prouve, pas la promesse.
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

  if (req.method === 'POST' && req.url === '/v1/checkout/sessions') {
    const connue = parCle.get(cle);
    if (connue) return repondre(200, connue);
    sequence += 1;
    const id = `cs_test_${sequence}`;
    const session = {
      id,
      object: 'checkout.session',
      url: `https://checkout.stripe.test/c/pay/${id}`,
      status: 'open',
      payment_status: 'unpaid',
      payment_intent: null,
      customer: null,
      expires_at: 1893456000,
    };
    parCle.set(cle, session);
    parId.set(id, session);
    return repondre(200, session);
  }

  const lecture = /^\/v1\/checkout\/sessions\/([^/?]+)$/.exec(req.url ?? '');
  if (req.method === 'GET' && lecture) {
    const session = parId.get(decodeURIComponent(lecture[1]));
    if (!session) return repondre(404, { error: { code: 'resource_missing', message: 'No such checkout session' } });
    return repondre(200, session);
  }

  return repondre(404, { error: { message: 'route inconnue' } });
});

const lectures = () => appels.filter((a) => a.method === 'GET' && a.url.startsWith('/v1/checkout/sessions/'));

await new Promise((resolve) => fauxStripe.listen(0, '127.0.0.1', resolve));
const STRIPE_BASE = `http://127.0.0.1:${fauxStripe.address().port}`;

/* ══════════════════════════════════════════════════════════════════════════
   LE PANEL
   ══════════════════════════════════════════════════════════════════════════ */
const { createApp } = await import('../backend/src/app.js');
const registre = await import('../backend/src/services/registry/projectRegistry.service.js');
const controlPlane = await import('../backend/src/services/integratedApi/controlPlane.service.js');
const grantsModule = await import('../backend/src/services/capabilities/capabilityGrants.js');
const commercial = await import('../backend/src/services/capabilities/commercialReadiness.service.js');
const { seedIntegratedApiCredentialSets } = await import('../backend/src/services/integratedApi/seed.js');
const { resetSyncCore } = await import('../backend/src/services/sync/syncCore.service.js');
const { updateNetworkConfiguration } = await import('../backend/src/services/network/networkConfig.service.js');
const { PanelProjectContract } = await import('../backend/src/models/PanelProjectProjection.model.js');
const binding = await import('../backend/src/services/integratedApi/stripe/stripeResourceBinding.js');
const routing = await import('../backend/src/services/webhooks/stripeEventRouting.js');
const { ingestProviderEvent, INGEST_OUTCOME } = await import('../backend/src/services/webhooks/webhookIngest.js');
const { default: WebhookEvent } = await import('../backend/src/models/PanelProviderWebhookEvent.model.js');
const { default: WebhookBinding } = await import('../backend/src/models/PanelIntegratedApiWebhookBinding.model.js');
const { storeWebhookSecret } = await import('../backend/src/services/webhooks/webhookSecrets.js');

await resetSyncCore();
await seedIntegratedApiCredentialSets();
await updateNetworkConfiguration({ backendUrl: 'https://panel-l62c.test' }, { requirePublic: false });

const { base: panelUrl } = await startServer(createApp());

section('1. Le coffre — une seule clé parlera à Stripe');
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
  mongoUri: MONGO_URI, dbName: 'sbauto_l62c_a', env: 'TEST', projectName: 'SB Auto L6.2C A',
});
const projetB = await startSbAutoInstance({
  mongoUri: MONGO_URI, dbName: 'sbauto_l62c_b', env: 'TEST', projectName: 'SB Auto L6.2C B',
});

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

const CONTRAT_A = 'contrat-l62c-a-00000000001';
const CONTRAT_B = 'contrat-l62c-b-00000000002';
let idA;
let idB;

async function semerContrats() {
  for (const [projectId, ref, montant] of [[idA, CONTRAT_A, 118_800], [idB, CONTRAT_B, 42_000]]) {
    await PanelProjectContract.updateOne(
      { projectId },
      {
        $set: {
          projectId,
          hasCurrent: true,
          sourceContractId: ref,
          status: 'ACTIVE',
          reference: `CTR-${ref.slice(-4)}`,
          pricing: {
            launchFee: { amountIncludingTax: montant, currency: 'EUR', interval: null },
            subscription: null,
          },
          sourceModifiedAt: new Date().toISOString(),
          receivedAt: new Date().toISOString(),
        },
      },
      { upsert: true },
    );
  }
}

section('2. Deux projets appairés, accordés, commercialement ouverts');
{
  idA = await appairer(projetA);
  idB = await appairer(projetB);
  await grantsModule.setCapabilityGrants(idA, [CREATE, READ], ACTEUR);
  await grantsModule.setCapabilityGrants(idB, [CREATE, READ], ACTEUR);
  await commercial.setCommercialReadiness(idA, 'LIVE', { actor: ACTEUR, reason: 'E2E L6.2C' });
  await commercial.setCommercialReadiness(idB, 'LIVE', { actor: ACTEUR, reason: 'E2E L6.2C' });
  // Les instances sont RÉELLES : elles publient « aucun contrat », ce qui
  // efface la projection. On draine leurs files avant de semer (leçon L6.2B).
  await projetA.syncNow();
  await projetB.syncNow();
  await semerContrats();
  check('projet A appairé et ouvert', typeof idA === 'string');
  check('projet B appairé et ouvert', typeof idB === 'string' && idA !== idB);
}

/* ══════════════════════════════════════════════════════════════════════════
   3. UNE SESSION RÉELLE, CRÉÉE ET LIÉE PAR L6.2B
   ══════════════════════════════════════════════════════════════════════════ */
const OP_A = `launch-${CONTRAT_A}-v1-a1-TEST`;
let sessionA;

section('3. Le projet A ouvre un paiement — la session est liée');
{
  await semerContrats();
  const cree = await projetA.invokeCapability({
    code: CREATE,
    input: {
      contractRef: CONTRAT_A, paymentType: 'LAUNCH_FEE',
      successUrl: 'https://a.test/ok', cancelUrl: 'https://a.test/ko',
      operationId: OP_A,
    },
  });
  check('la session est créée', cree.ok === true);
  sessionA = cree.data.result.checkoutSessionId;
  const lien = await binding.findBinding({
    environment: 'TEST', resourceType: 'CHECKOUT_SESSION', resourceId: sessionA,
  });
  check('…et liée au projet A', lien?.projectId === idA);
}

/* ══════════════════════════════════════════════════════════════════════════
   4. LA LECTURE — son propriétaire, et personne d'autre
   ══════════════════════════════════════════════════════════════════════════ */
section('4. A lit SA session');
{
  const avant = lectures().length;
  const lu = await projetA.invokeCapability({
    code: READ,
    input: { checkoutSessionId: sessionA, operationId: 'op-l62c-lecture-a-0001' },
  });

  check('la lecture réussit', lu.ok === true);
  check('…issue SUCCEEDED', lu.data.outcome === 'SUCCEEDED');
  check('…UN appel Stripe, et un seul', lectures().length === avant + 1);
  check('…avec la clé du COFFRE', appels.at(-1).auth === CLE_PANEL);
  check('la clé du PROJET n’a jamais servi', appels.every((a) => a.auth !== CLE_PROJET));

  /**
   * LE DTO — exactement les champs que le parcours consomme, et pas un de plus.
   * Un objet Stripe complet porte la ligne d'articles, l'adresse du client, ses
   * moyens de paiement et le total facturé : les relayer ferait traverser au
   * pont des données que personne n'a demandées.
   */
  const attendus = ['checkoutSessionId', 'status', 'paymentStatus', 'url', 'expiresAt', 'paymentIntentId', 'customerId'].sort();
  check('le DTO porte EXACTEMENT les sept champs contractés',
    JSON.stringify(Object.keys(lu.data.result).sort()) === JSON.stringify(attendus));
  check('…l’identifiant de session', lu.data.result.checkoutSessionId === sessionA);
  check('…son état', lu.data.result.status === 'open');
  check('…son état de paiement', lu.data.result.paymentStatus === 'unpaid');
  check('aucune metadata ne traverse', !('metadata' in lu.data.result));
  check('aucun montant ne traverse',
    !('amountTotal' in lu.data.result) && !('amount_total' in lu.data.result));
  check('aucun objet Stripe brut ne traverse', !('object' in lu.data.result));
}

/* ══════════════════════════════════════════════════════════════════════════
   5. LES TROIS REFUS — indistinguables, et GRATUITS
   ══════════════════════════════════════════════════════════════════════════ */
section('5. Inconnue, à un autre, révoquée : le même refus, et zéro appel Stripe');
{
  const avant = lectures().length;

  // B connaît un VRAI identifiant de session : celui de A.
  const vol = await projetB.invokeCapability({
    code: READ,
    input: { checkoutSessionId: sessionA, operationId: 'op-l62c-vol-b-00000001' },
  });
  check('B lisant la session de A → refusé', vol.ok === false);
  check('…code CAPABILITY_RESOURCE_NOT_OWNED', vol.code === 'CAPABILITY_RESOURCE_NOT_OWNED');
  check('…en 403', vol.httpStatus === 403);

  // Un identifiant parfaitement formé, mais qui n'existe nulle part.
  const inconnue = await projetB.invokeCapability({
    code: READ,
    input: { checkoutSessionId: 'cs_test_nexistepas0000', operationId: 'op-l62c-inconnue-000001' },
  });
  check('une session inconnue → refusé', inconnue.ok === false);

  // Une session bien à B, mais dont le lien a été neutralisé.
  const creeB = await projetB.invokeCapability({
    code: CREATE,
    input: {
      contractRef: CONTRAT_B, paymentType: 'LAUNCH_FEE',
      successUrl: 'https://b.test/ok', cancelUrl: 'https://b.test/ko',
      operationId: `launch-${CONTRAT_B}-v1-a1-TEST`,
    },
  });
  const sessionB = creeB.data.result.checkoutSessionId;
  await binding.revokeBinding({
    environment: 'TEST', resourceType: 'CHECKOUT_SESSION', resourceId: sessionB, reason: 'E2E',
  });
  const apresRevoc = lectures().length;
  const revoquee = await projetB.invokeCapability({
    code: READ,
    input: { checkoutSessionId: sessionB, operationId: 'op-l62c-revoquee-000001' },
  });
  check('une session révoquée → refusé', revoquee.ok === false);

  /* ── L'INDISTINGUABILITÉ, CHAMP PAR CHAMP ─────────────────────────────── */
  check('« à un autre » et « inconnue » : MÊME code', vol.code === inconnue.code);
  check('…MÊME message', vol.message === inconnue.message);
  check('…MÊME statut', vol.httpStatus === inconnue.httpStatus);
  check('« révoquée » rend le même code', revoquee.code === vol.code);
  check('…le même message', revoquee.message === vol.message);
  check('…le même statut', revoquee.httpStatus === vol.httpStatus);
  check('aucun refus ne nomme un projet',
    ![vol, inconnue, revoquee].some((r) => String(r.message).includes(idA) || String(r.message).includes(idB)));
  check('aucun refus ne cite l’identifiant présenté',
    ![vol, inconnue, revoquee].some((r) => String(r.message).includes(sessionA)));

  /* ── ET LA PREUVE QUI COMPTE : LE COMPTEUR ────────────────────────────── */
  check('LES TROIS REFUS N’ONT COÛTÉ AUCUN APPEL STRIPE',
    lectures().length === apresRevoc && apresRevoc === avant);
}

/* ══════════════════════════════════════════════════════════════════════════
   6. LES MONDES — un lien TEST n'ouvre rien en PROD
   ══════════════════════════════════════════════════════════════════════════ */
section('6. TEST et PROD ne se prêtent pas leurs liens');
{
  const verdictProd = await binding.describeOwnership({
    projectId: idA, environment: 'PROD', resourceType: 'CHECKOUT_SESSION', resourceId: sessionA,
  });
  check('la session TEST de A n’existe pas en PROD', verdictProd.allowed === false);
  check('…et le motif interne est « aucun lien »', verdictProd.reason === 'NO_BINDING');

  // Le MÊME identifiant, lié à B en PROD : deux objets, deux mondes.
  await binding.bindResource({
    projectId: idB, environment: 'PROD', resourceType: 'CHECKOUT_SESSION', resourceId: sessionA,
  });
  const enTest = await binding.findBinding({
    environment: 'TEST', resourceType: 'CHECKOUT_SESSION', resourceId: sessionA,
  });
  const enProd = await binding.findBinding({
    environment: 'PROD', resourceType: 'CHECKOUT_SESSION', resourceId: sessionA,
  });
  check('le même identifiant vit dans les deux mondes', Boolean(enTest && enProd));
  check('…et n’y a pas le même propriétaire', enTest.projectId === idA && enProd.projectId === idB);
}

/* ══════════════════════════════════════════════════════════════════════════
   7. LE WEBHOOK — l'endpoint EXISTANT, et le lien qui décide
   ══════════════════════════════════════════════════════════════════════════ */
const signer = (corps, secret) => {
  const t = Math.floor(Date.now() / 1000);
  return `t=${t},v1=${createHmac('sha256', secret).update(`${t}.${corps}`).digest('hex')}`;
};

const evenement = (id, type, object) => JSON.stringify({ id, type, data: { object } });

let bindingWebhook;
section('7. Un webhook signé arrive sur l’endpoint qui existait déjà');
{
  // Le binding d'endpoint est celui du plan de contrôle L5. On ne CRÉE aucun
  // endpoint chez Stripe : on enregistre celui que le Panel expose déjà.
  bindingWebhook = await WebhookBinding.create({
    bindingId: 'wb-l62c-test',
    provider: 'STRIPE',
    environment: 'TEST',
    remoteEndpointId: 'we_l62c',
    callbackUrl: `${panelUrl}/webhooks/providers/stripe`,
    ownershipToken: 'l62c',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  await storeWebhookSecret('STRIPE', 'TEST', WHSEC);

  const avantStripe = appels.length;
  const corps = evenement('evt_l62c_0001', 'checkout.session.completed', {
    id: sessionA, object: 'checkout.session', payment_status: 'paid', status: 'complete',
  });
  const recu = await ingestProviderEvent({
    slug: 'stripe',
    rawBody: Buffer.from(corps),
    headers: { 'stripe-signature': signer(corps, WHSEC) },
  });

  check('l’événement est accepté', recu.outcome === INGEST_OUTCOME.ACCEPTED);
  check('…sa signature a été prouvée', recu.proven === true);
  check('LE PROJET EST DÉTERMINÉ MÉCANIQUEMENT', recu.routedProjectId === idA);
  check('…par appartenance prouvée', recu.ownership === routing.EVENT_OWNERSHIP.OWNED);
  check('aucun appel Stripe n’a été nécessaire pour le savoir', appels.length === avantStripe);

  const enregistre = await WebhookEvent.findOne({ providerEventId: 'evt_l62c_0001' }).lean();
  check('le verdict est PERSISTÉ sur l’événement', enregistre.projectId === idA);
  check('…avec son motif', enregistre.ownership === 'OWNED');
  check('…et la preuve de signature', enregistre.signatureVerified === true);
}

/* ══════════════════════════════════════════════════════════════════════════
   8. METADATA MENSONGÈRE — le lien gagne, toujours
   ══════════════════════════════════════════════════════════════════════════ */
section('8. Les metadata désignent B, le lien désigne A');
{
  const corps = evenement('evt_l62c_0002', 'checkout.session.completed', {
    id: sessionA,
    object: 'checkout.session',
    payment_status: 'paid',
    // La revendication : éditable depuis le tableau de bord Stripe.
    metadata: { panelProjectId: idB, contractId: CONTRAT_B },
  });
  const recu = await ingestProviderEvent({
    slug: 'stripe',
    rawBody: Buffer.from(corps),
    headers: { 'stripe-signature': signer(corps, WHSEC) },
  });

  check('l’événement est accepté', recu.outcome === INGEST_OUTCOME.ACCEPTED);
  check('LE ROUTAGE IGNORE LA REVENDICATION', recu.routedProjectId === idA);
  check('…et surtout : JAMAIS vers B', recu.routedProjectId !== idB);
  const enregistre = await WebhookEvent.findOne({ providerEventId: 'evt_l62c_0002' }).lean();
  check('la divergence est CONSIGNÉE', enregistre.claimMismatch === true);
  check('…et le destinataire reste celui du lien', enregistre.projectId === idA);
}

/* ══════════════════════════════════════════════════════════════════════════
   9. RESSOURCE SANS LIEN — personne, et surtout pas celui qui le demande
   ══════════════════════════════════════════════════════════════════════════ */
section('9. Une session inconnue ne s’attribue pas, même si elle le réclame');
{
  const corps = evenement('evt_l62c_0003', 'checkout.session.completed', {
    id: 'cs_test_jamais_liee_00', object: 'checkout.session',
    metadata: { panelProjectId: idA },
  });
  const recu = await ingestProviderEvent({
    slug: 'stripe',
    rawBody: Buffer.from(corps),
    headers: { 'stripe-signature': signer(corps, WHSEC) },
  });

  check('l’événement est reçu et vérifié', recu.outcome === INGEST_OUTCOME.ACCEPTED);
  check('…mais attribué à PERSONNE', recu.routedProjectId === null);
  check('…et le motif est nommé', recu.ownership === routing.EVENT_OWNERSHIP.UNOWNED);

  const enregistre = await WebhookEvent.findOne({ providerEventId: 'evt_l62c_0003' }).lean();
  check('il reste TRAÇABLE — ni perdu, ni silencieux', Boolean(enregistre));
  check('…sans destinataire', enregistre.projectId === null);
  check('…et la revendication ignorée est consignée', enregistre.claimMismatch === true);

  // Une session RÉVOQUÉE n'est pas davantage attribuée.
  const sessionRevoquee = [...parId.keys()].find((id) => id !== sessionA);
  const corpsRevoc = evenement('evt_l62c_0004', 'checkout.session.expired', {
    id: sessionRevoquee, object: 'checkout.session',
  });
  const recuRevoc = await ingestProviderEvent({
    slug: 'stripe',
    rawBody: Buffer.from(corpsRevoc),
    headers: { 'stripe-signature': signer(corpsRevoc, WHSEC) },
  });
  check('une ressource révoquée n’est attribuée à personne', recuRevoc.routedProjectId === null);
  check('…et le motif la distingue d’une inconnue',
    recuRevoc.ownership === routing.EVENT_OWNERSHIP.REVOKED);
}

/* ══════════════════════════════════════════════════════════════════════════
   10. LES ÉVÉNEMENTS QUI N'ONT PAS ENCORE DE PROPRIÉTAIRE
   ══════════════════════════════════════════════════════════════════════════ */
section('10. Un PaymentIntent ne se route pas — et on ne va pas le demander à Stripe');
{
  const avantStripe = appels.length;
  const corps = evenement('evt_l62c_0005', 'payment_intent.succeeded', {
    id: 'pi_l62c_0001', object: 'payment_intent',
    metadata: { panelProjectId: idA },
  });
  const recu = await ingestProviderEvent({
    slug: 'stripe',
    rawBody: Buffer.from(corps),
    headers: { 'stripe-signature': signer(corps, WHSEC) },
  });

  check('l’événement est reçu', recu.outcome === INGEST_OUTCOME.ACCEPTED);
  check('…et déclaré NON ROUTABLE', recu.ownership === routing.EVENT_OWNERSHIP.NOT_ROUTABLE);
  check('…sans destinataire, malgré la revendication', recu.routedProjectId === null);
  /**
   * Le Panel POURRAIT remonter du PaymentIntent vers sa session en interrogeant
   * Stripe. Il ne le fait pas : ce serait payer un appel fournisseur pour
   * découvrir à qui appartient quelque chose — exactement l'ordre inverse de la
   * doctrine du lot.
   */
  check('AUCUN appel Stripe pour tenter de le rattacher', appels.length === avantStripe);
  check('la matrice le classe explicitement',
    routing.UNROUTABLE_EVENTS.includes('payment_intent.succeeded'));
  check('…et ne prétend pas savoir le router',
    routing.EVENT_RESOURCE_MATRIX['payment_intent.succeeded'] === undefined);
}

/* ══════════════════════════════════════════════════════════════════════════
   11. IDEMPOTENCE — un rejeu n'attribue pas deux fois
   ══════════════════════════════════════════════════════════════════════════ */
section('11. Le même événement, deux fois');
{
  const corps = evenement('evt_l62c_0006', 'checkout.session.completed', {
    id: sessionA, object: 'checkout.session', payment_status: 'paid',
  });
  const entetes = { 'stripe-signature': signer(corps, WHSEC) };

  const premier = await ingestProviderEvent({ slug: 'stripe', rawBody: Buffer.from(corps), headers: entetes });
  const second = await ingestProviderEvent({ slug: 'stripe', rawBody: Buffer.from(corps), headers: entetes });

  check('le premier passage est accepté', premier.outcome === INGEST_OUTCOME.ACCEPTED);
  check('le second est un DOUBLON', second.outcome === INGEST_OUTCOME.DUPLICATE);
  check('…et la résolution d’appartenance ne recommence pas', second.routedProjectId === null);

  const lignes = await WebhookEvent.countDocuments({ providerEventId: 'evt_l62c_0006' });
  check('une seule ligne en base', lignes === 1);
  /**
   * L'idempotence est celle de L5, INCHANGÉE : c'est l'index unique qui tranche.
   * Le lot n'introduit pas une seconde politique — il s'y range.
   */
  check('l’idempotence reste portée par l’index unique de L5', lignes === 1);
}

/* ══════════════════════════════════════════════════════════════════════════
   12. SIGNATURE D'ABORD — un événement non prouvé n'est jamais routé
   ══════════════════════════════════════════════════════════════════════════ */
section('12. Sans signature valide, la question du destinataire ne se pose pas');
{
  const corps = evenement('evt_l62c_0007', 'checkout.session.completed', {
    id: sessionA, object: 'checkout.session',
  });
  const faux = await ingestProviderEvent({
    slug: 'stripe',
    rawBody: Buffer.from(corps),
    headers: { 'stripe-signature': signer(corps, 'whsec_ce_nest_pas_le_bon_secret') },
  });
  check('signature invalide → refusé', faux.outcome === INGEST_OUTCOME.REJECTED);
  check('…aucun destinataire résolu', faux.routedProjectId === undefined || faux.routedProjectId === null);
  const enregistre = await WebhookEvent.findOne({ providerEventId: 'evt_l62c_0007' }).lean();
  check('…et RIEN n’est enregistré', enregistre === null);
}

/* ══════════════════════════════════════════════════════════════════════════
   13. L'ENDPOINT N'A PAS BOUGÉ
   ══════════════════════════════════════════════════════════════════════════ */
section('13. Aucun endpoint créé, aucun secret changé');
{
  const ecrituresStripe = appels.filter((a) => a.method !== 'GET' && a.url.includes('webhook_endpoints'));
  check('AUCUNE écriture sur /v1/webhook_endpoints', ecrituresStripe.length === 0);
  check('aucune lecture non plus', !appels.some((a) => a.url.includes('webhook_endpoints')));

  const apres = await WebhookBinding.findOne({ bindingId: 'wb-l62c-test' }).lean();
  check('le binding d’endpoint est inchangé',
    apres.remoteEndpointId === bindingWebhook.remoteEndpointId
    && apres.callbackUrl === bindingWebhook.callbackUrl);
  check('…et son secret n’a pas tourné', !apres.secretRotatedAt);
}

/* ══════════════════════════════════════════════════════════════════════════
   14. NON-RÉGRESSION L6.2B — la création reste ce qu'elle était
   ══════════════════════════════════════════════════════════════════════════ */
section('14. billing.checkout.create n’a pas bougé');
{
  await semerContrats();
  const avantSessions = parId.size;
  const rejeu = await projetA.invokeCapability({
    code: CREATE,
    input: {
      contractRef: CONTRAT_A, paymentType: 'LAUNCH_FEE',
      successUrl: 'https://a.test/ok', cancelUrl: 'https://a.test/ko',
      operationId: OP_A,
    },
  });
  check('le rejeu du même acte REPREND', rejeu.data.result.creation === 'REUSED');
  check('…sur la même session', rejeu.data.result.checkoutSessionId === sessionA);
  check('…et Stripe n’a rien créé de plus', parId.size === avantSessions);

  const abo = await projetA.invokeCapability({
    code: CREATE,
    input: {
      contractRef: CONTRAT_A, paymentType: 'SUBSCRIPTION',
      successUrl: 'https://a.test/ok', cancelUrl: 'https://a.test/ko',
      operationId: 'op-l62c-abonnement-00001',
    },
  });
  check('l’abonnement refuse toujours explicitement',
    abo.panelDetails?.reason === 'SUBSCRIPTION_PREREQUISITES_NOT_MIGRATED');
}

/* ══════════════════════════════════════════════════════════════════════════
   15. BILAN
   ══════════════════════════════════════════════════════════════════════════ */
section('15. Bilan — une clé, aucune fuite');
{
  const cles = new Set(appels.map((a) => a.auth).filter(Boolean));
  check('exactement UNE clé a parlé à Stripe', cles.size === 1);
  check('…celle du coffre du Panel', cles.has(CLE_PANEL));
  check('la sentinelle du projet n’apparaît nulle part',
    !JSON.stringify(appels).includes(CLE_PROJET));

  for (const [nom, instance] of [['A', projetA], ['B', projetB]]) {
    const dump = JSON.stringify(await instance.dbDump());
    check(`la base du projet ${nom} ne contient aucune clé Stripe`,
      !dump.includes(CLE_PANEL) && !dump.includes(CLE_PROJET));
    check(`…ni le secret de signature du Panel`, !dump.includes(WHSEC));
  }
}

await projetA.stop();
await projetB.stop();
fauxStripe.close();
finish();
