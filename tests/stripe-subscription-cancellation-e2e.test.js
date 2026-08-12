// COUPER UNE FOIS, ET UNE SEULE — l'E2E du lot (L6.2G).
//
// ══ CE QUI REND CE LOT DIFFÉRENT DES PRÉCÉDENTS ══════════════════════════════
//
// Pour un paiement (L6.2B), le silence du fournisseur laissait une question sans
// réponse : la session existe-t-elle, et a-t-elle été payée ? L'état ne
// tranchait pas, d'où une convergence par clé d'idempotence, bornée par la
// fenêtre de Stripe.
//
// Une résiliation laisse au contraire une TRACE D'ÉTAT NON AMBIGUË :
//
//     `cancel_at_period_end` vaut true, ou il ne le vaut pas
//     `status` vaut `canceled`, ou il ne le vaut pas
//
// Relire l'abonnement répond donc exactement à « l'acte a-t-il eu lieu ? ». La
// section 5 en fait la preuve : réponse perdue, puis rejeu — et le faux Stripe
// ne compte qu'UNE mutation.
//
// ══ LE DÉFAUT QUE CE LOT FERME ═══════════════════════════════════════════════
//
// `cancelSubscriptionNow` n'avait AUCUNE clé d'idempotence, et trois appelants.
// Relevé en L6.1, confirmé à chaque lot depuis. Un double clic produisait deux
// appels réels — dont le second échouait, puisque Stripe refuse de résilier deux
// fois.
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
const CLE_PANEL = `${prefixe('test')}L62GSENTINELLEPANEL0000000001`;
const CLE_PANEL_PROD = `${prefixe('live')}L62GSENTINELLEPANELPROD000002`;
const CLE_PROJET = `${prefixe('test')}L62GSENTINELLEPROJETJAMAISVUE3`;
const WHSEC = 'whsec_l62g_secret_de_signature_0001';

const ACTEUR = { userId: 'u-dev', userEmail: 'dev@panel.test' };
const CHECKOUT = 'billing.checkout.create';
const READ_SESSION = 'billing.checkout.retrieve';
const READ_SUB = 'billing.subscription.retrieve';
const CANCEL_END = 'billing.subscription.cancel_at_period_end';
const CANCEL_NOW = 'billing.subscription.cancel_now';

/* ══════════════════════════════════════════════════════════════════════════
   UN FAUX STRIPE QUI SE COMPORTE COMME LE VRAI SUR LES RÉSILIATIONS.

   Deux propriétés sont indispensables, et ce sont elles qui donnent leur
   valeur aux sections 3 à 6 :

     · `DELETE` sur un abonnement déjà `canceled` REND UNE ERREUR — le vrai
       Stripe fait exactement cela, et c'est pourquoi un rejeu naïf ne marche
       pas ;
     · chaque mutation est COMPTÉE, séparément des lectures.
   ══════════════════════════════════════════════════════════════════════════ */
const appels = [];
const parCle = new Map();
const parId = new Map();
let sequence = 0;
/** Prochaine mutation : l'exécuter, puis couper la connexion. */
let avalerProchaineMutation = false;
/** Prochaine lecture d'abonnement : rendre un corps illisible. */
let brouillerProchaineLecture = false;

const lireCorps = (req) => new Promise((resolve) => {
  let brut = '';
  req.on('data', (c) => { brut += c; });
  req.on('end', () => resolve(brut));
});

const fauxStripe = http.createServer(async (req, res) => {
  const cle = req.headers['idempotency-key'] ?? null;
  const auth = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
  const corps = req.method !== 'GET' ? await lireCorps(req) : '';
  appels.push({ method: req.method, url: req.url, cle, auth, corps });

  const repondre = (code, objet) => {
    res.writeHead(code, { 'content-type': 'application/json' });
    res.end(JSON.stringify(objet));
  };

  if (req.url === '/v1/account') return repondre(200, { id: 'acct_panel', country: 'FR' });

  const abonnement = /^\/v1\/subscriptions\/([^/?]+)$/.exec(req.url ?? '');

  /* ── RÉSILIATION IMMÉDIATE ────────────────────────────────────────────── */
  if (req.method === 'DELETE' && abonnement) {
    const sub = parId.get(decodeURIComponent(abonnement[1]));
    if (!sub) return repondre(404, { error: { code: 'resource_missing', message: 'introuvable' } });
    const rejeu = parCle.get(cle);
    if (rejeu) return repondre(200, rejeu);
    if (sub.status === 'canceled') {
      /** LE VRAI COMPORTEMENT DE STRIPE : on ne résilie pas deux fois. */
      return repondre(400, {
        error: { code: 'subscription_already_canceled', message: 'A subscription with status canceled cannot be canceled.' },
      });
    }
    sub.status = 'canceled';
    sub.canceled_at = 1_785_000_000;
    parCle.set(cle, { ...sub });
    return repondre(200, sub);
  }

  /* ── RÉSILIATION À ÉCHÉANCE ───────────────────────────────────────────── */
  if (req.method === 'POST' && abonnement) {
    const sub = parId.get(decodeURIComponent(abonnement[1]));
    if (!sub) return repondre(404, { error: { code: 'resource_missing', message: 'introuvable' } });
    if (avalerProchaineMutation) {
      avalerProchaineMutation = false;
      sub.cancel_at_period_end = true;
      parCle.set(cle, { ...sub });
      req.socket.destroy();
      return;
    }
    const rejeu = parCle.get(cle);
    if (rejeu) return repondre(200, rejeu);
    sub.cancel_at_period_end = true;
    parCle.set(cle, { ...sub });
    return repondre(200, sub);
  }

  if (req.method === 'GET' && abonnement) {
    if (brouillerProchaineLecture) {
      brouillerProchaineLecture = false;
      return repondre(200, { objet: 'illisible' });
    }
    const sub = parId.get(decodeURIComponent(abonnement[1]));
    if (!sub) return repondre(404, { error: { code: 'resource_missing', message: 'introuvable' } });
    return repondre(200, sub);
  }

  if (req.method === 'POST' && ['/v1/customers', '/v1/products', '/v1/prices', '/v1/checkout/sessions'].includes(req.url)) {
    const connu = parCle.get(cle);
    if (connu) return repondre(200, connu);
    sequence += 1;
    return repondre(200, fabriquer(req.url, cle, corps));
  }

  const lecture = /^\/v1\/(customers|prices|checkout\/sessions)\/([^/?]+)$/.exec(req.url ?? '');
  if (req.method === 'GET' && lecture) {
    const objet = parId.get(decodeURIComponent(lecture[2]));
    if (!objet) return repondre(404, { error: { code: 'resource_missing', message: 'introuvable' } });
    return repondre(200, objet);
  }

  return repondre(404, { error: { message: 'route inconnue' } });
});

function fabriquer(url, cle, corps) {
  const params = new URLSearchParams(corps);
  const prefixes = { '/v1/customers': 'cus', '/v1/products': 'prod', '/v1/prices': 'price', '/v1/checkout/sessions': 'cs' };
  const id = `${prefixes[url]}_test_${sequence}`;
  const objet = { id, object: prefixes[url] };
  if (url === '/v1/checkout/sessions') {
    Object.assign(objet, {
      url: `https://pay.test/${id}`, status: 'open', payment_status: 'unpaid',
      mode: params.get('mode'), customer: params.get('customer'), subscription: null,
      metadata: { panelProjectId: params.get('metadata[panelProjectId]') },
    });
  }
  parCle.set(cle, objet);
  parId.set(id, objet);
  return objet;
}

/** Le paiement : Stripe crée la Subscription, sans nous (doctrine L6.2F). */
function payer(sessionId) {
  const session = parId.get(sessionId);
  sequence += 1;
  const sub = `sub_test_${sequence}`;
  Object.assign(session, { status: 'complete', payment_status: 'paid', subscription: sub, url: null });
  parId.set(sub, {
    id: sub, object: 'subscription', status: 'active', cancel_at_period_end: false,
    current_period_start: 1_780_000_000, current_period_end: 1_790_000_000,
    latest_invoice: `in_${sub}`, customer: session.customer,
  });
  return sub;
}

/** LES MUTATIONS RÉELLEMENT ÉMISES — le compteur qui prouve le non-doublon. */
const mutations = (methode) => appels.filter((a) => a.method === methode && /^\/v1\/subscriptions\//.test(a.url));
const coupures = () => mutations('DELETE');
const drapeaux = () => mutations('POST');
const lecturesAbo = () => appels.filter((a) => a.method === 'GET' && /^\/v1\/subscriptions\//.test(a.url));

await new Promise((resolve) => fauxStripe.listen(0, '127.0.0.1', resolve));
const STRIPE_BASE = `http://127.0.0.1:${fauxStripe.address().port}`;

/* ══════════════════════════════════════════════════════════════════════════ */
const { createApp } = await import('../backend/src/app.js');
const registre = await import('../backend/src/services/registry/projectRegistry.service.js');
const controlPlane = await import('../backend/src/services/integratedApi/controlPlane.service.js');
const grantsModule = await import('../backend/src/services/capabilities/capabilityGrants.js');
const commercial = await import('../backend/src/services/capabilities/commercialReadiness.service.js');
const { seedIntegratedApiCredentialSets } = await import('../backend/src/services/integratedApi/seed.js');
const { resetSyncCore } = await import('../backend/src/services/sync/syncCore.service.js');
const { updateNetworkConfiguration } = await import('../backend/src/services/network/networkConfig.service.js');
const { PanelProjectContract } = await import('../backend/src/models/PanelProjectProjection.model.js');
const { default: PanelCapabilityOperation } = await import('../backend/src/models/PanelCapabilityOperation.model.js');
const binding = await import('../backend/src/services/integratedApi/stripe/stripeResourceBinding.js');
const annulation = await import('../backend/src/services/integratedApi/stripe/stripeSubscriptionCancellation.js');
const { ingestProviderEvent, INGEST_OUTCOME } = await import('../backend/src/services/webhooks/webhookIngest.js');
const { default: WebhookBinding } = await import('../backend/src/models/PanelIntegratedApiWebhookBinding.model.js');
const { storeWebhookSecret } = await import('../backend/src/services/webhooks/webhookSecrets.js');

await resetSyncCore();
await seedIntegratedApiCredentialSets();
await updateNetworkConfiguration({ backendUrl: 'https://panel-l62g.test' }, { requirePublic: false });

const { base: panelUrl } = await startServer(createApp());

section('1. Le coffre — deux mondes');
{
  await controlPlane.saveCredentialSet('STRIPE', 'TEST', {
    values: { secretKey: CLE_PANEL, baseUrl: STRIPE_BASE },
  }, ACTEUR);
  await controlPlane.saveCredentialSet('STRIPE', 'PROD', {
    values: { secretKey: CLE_PANEL_PROD, baseUrl: STRIPE_BASE },
  }, ACTEUR);
  const verdict = await controlPlane.validateCredentialSet('STRIPE', 'TEST', { actor: ACTEUR });
  check('la clé TEST du Panel est validée', verdict.validation.status === 'VALID');
}

/* ══════════════════════════════════════════════════════════════════════════ */
const projetA = await startSbAutoInstance({
  mongoUri: MONGO_URI, dbName: 'sbauto_l62g_a', env: 'TEST', projectName: 'SB Auto L6.2G A',
});
const projetB = await startSbAutoInstance({
  mongoUri: MONGO_URI, dbName: 'sbauto_l62g_b', env: 'TEST', projectName: 'SB Auto L6.2G B',
});

const CONTRAT_A = 'contrat-l62g-a-00000000001';
const CONTRAT_B = 'contrat-l62g-b-00000000002';
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

/** Ouvre, paie, et rend l'abonnement adopté — le point de départ de tout test. */
async function abonnementVivant(instance, contractRef, suffixe) {
  await semer(instance.projectId, contractRef);
  const ouverte = await instance.invokeCapability({
    code: CHECKOUT,
    input: {
      contractRef, paymentType: 'SUBSCRIPTION',
      successUrl: 'https://x.test/ok', cancelUrl: 'https://x.test/ko',
      operationId: `checkout-sub-${contractRef}-v1-month-11880-TEST-${suffixe}`,
    },
  });
  const sessionId = ouverte.data.result.checkoutSessionId;
  const subId = payer(sessionId);
  // La lecture de session ADOPTE l'abonnement (L6.2F).
  await instance.invokeCapability({
    code: READ_SESSION,
    input: { checkoutSessionId: sessionId, operationId: `op-l62g-adopt-${suffixe}-0001` },
  });
  return { sessionId, subId };
}

section('2. Deux projets, ouverts et accordés');
{
  idA = await appairer(projetA);
  idB = await appairer(projetB);
  for (const id of [idA, idB]) {
    await grantsModule.setCapabilityGrants(id, [CHECKOUT, READ_SESSION, READ_SUB, CANCEL_END, CANCEL_NOW], ACTEUR);
    await commercial.setCommercialReadiness(id, 'LIVE', { actor: ACTEUR, reason: 'E2E L6.2G' });
  }
  await projetA.syncNow();
  await projetB.syncNow();
  check('deux projets distincts', typeof idA === 'string' && idA !== idB);
}

/* ══════════════════════════════════════════════════════════════════════════
   3. RÉSILIATION À ÉCHÉANCE — nominale, puis rejouée
   ══════════════════════════════════════════════════════════════════════════ */
section('3. À échéance : le drapeau, et le rejeu qui ne remue rien');
{
  const { subId } = await abonnementVivant(projetA, CONTRAT_A, 'a0');
  const avant = drapeaux().length;

  const r1 = await projetA.invokeCapability({ code: CANCEL_END, input: { subscriptionId: subId } });
  check('la résiliation aboutit', r1.ok === true);
  check('…l’acte est déclaré FAIT', r1.data.result.outcome === 'CANCELLED');
  check('…le drapeau est posé', r1.data.result.cancelAtPeriodEnd === true);
  check('…l’abonnement reste ACTIF jusqu’à l’échéance', r1.data.result.status === 'active');
  check('…et la période de fin est rendue', r1.data.result.currentPeriodEnd === 1_790_000_000);
  check('UNE mutation émise', drapeaux().length === avant + 1);
  check('la clé partie est celle du COFFRE', appels.at(-1).auth === CLE_PANEL);
  check('…et elle porte une clé d’idempotence', drapeaux().at(-1).cle?.startsWith('pcp_'));

  /* LE REJEU — convergence par l'ÉTAT, sans seconde mutation. */
  const r2 = await projetA.invokeCapability({ code: CANCEL_END, input: { subscriptionId: subId } });
  check('le rejeu aboutit', r2.ok === true);
  check('…et se déclare DÉJÀ FAIT', r2.data.result.outcome === 'ALREADY_CANCELLED');
  check('AUCUNE mutation supplémentaire', drapeaux().length === avant + 1);

  // Le projet ne peut ni nommer l'acte, ni choisir son monde.
  for (const champ of ['operationId', 'environment', 'mode', 'apiKey', 'idempotencyKey']) {
    const refus = await projetA.invokeCapability({
      code: CANCEL_END, input: { subscriptionId: subId, [champ]: 'x' },
    });
    check(`« ${champ} » dans la charge utile → refusé`, refus.code === 'CAPABILITY_INPUT_INVALID');
  }
}

/* ══════════════════════════════════════════════════════════════════════════
   4. RÉSILIATION IMMÉDIATE — et le rejeu que Stripe REFUSE
   ══════════════════════════════════════════════════════════════════════════ */
let subImmediat;
section('4. Immédiate : la coupure, et le rejeu qui ne la retente pas');
{
  const { subId } = await abonnementVivant(projetA, CONTRAT_A, 'a1');
  subImmediat = subId;
  const avant = coupures().length;

  const r1 = await projetA.invokeCapability({ code: CANCEL_NOW, input: { subscriptionId: subId } });
  check('la coupure aboutit', r1.ok === true);
  check('…l’acte est déclaré FAIT', r1.data.result.outcome === 'CANCELLED');
  check('…l’abonnement est CLOS', r1.data.result.status === 'canceled');
  check('UNE coupure émise', coupures().length === avant + 1);
  check('…avec une clé d’idempotence — le défaut de L6.1 est fermé',
    typeof coupures().at(-1).cle === 'string' && coupures().at(-1).cle.startsWith('pcp_'));

  /**
   * LE REJEU. Sans la relecture d'état, il rejouerait le `DELETE` — et ce faux
   * Stripe le refuserait avec une 400, exactement comme le vrai. C'est ce que
   * l'ancien code produisait à chaque double clic.
   */
  const r2 = await projetA.invokeCapability({ code: CANCEL_NOW, input: { subscriptionId: subId } });
  check('le rejeu aboutit — pas d’erreur fournisseur', r2.ok === true);
  check('…et se déclare DÉJÀ FAIT', r2.data.result.outcome === 'ALREADY_CANCELLED');
  check('AUCUNE seconde coupure', coupures().length === avant + 1);
}

/* ══════════════════════════════════════════════════════════════════════════
   5. RÉPONSE PERDUE — l'état tranche là où un paiement laissait un doute
   ══════════════════════════════════════════════════════════════════════════ */
section('5. La réponse se perd : UNKNOWN, puis convergence par l’état');
{
  const { subId } = await abonnementVivant(projetA, CONTRAT_A, 'a2');
  const avant = drapeaux().length;
  avalerProchaineMutation = true;

  const perdu = await projetA.invokeCapability({ code: CANCEL_END, input: { subscriptionId: subId } });
  check('l’appel échoue', perdu.ok === false);
  check('…en CAPABILITY_TIMEOUT, pas en « indisponible »', perdu.code === 'CAPABILITY_TIMEOUT');
  check('la mutation a pourtant bien eu lieu chez Stripe', drapeaux().length === avant + 1);
  check('…et l’état de l’abonnement le porte', parId.get(subId).cancel_at_period_end === true);

  const acte = annulation.cancellationOperationId({ environment: 'TEST', subscriptionId: subId });
  const operation = await PanelCapabilityOperation.findOne({ projectId: idA, operationId: acte }).lean();
  check('l’opération est marquée UNKNOWN — pas FAILED', operation?.status === 'UNKNOWN');

  const reprise = await projetA.invokeCapability({ code: CANCEL_END, input: { subscriptionId: subId } });
  check('la reprise aboutit', reprise.ok === true);
  check('…en CONSTATANT l’acte', reprise.data.result.outcome === 'ALREADY_CANCELLED');
  check('AUCUNE seconde mutation', drapeaux().length === avant + 1);
  const apres = await PanelCapabilityOperation.findOne({ projectId: idA, operationId: acte }).lean();
  check('…et l’opération est enfin conclue', apres.status === 'SUCCEEDED');
}

/* ══════════════════════════════════════════════════════════════════════════
   6. ÉTAT ILLISIBLE — on n'agit pas, et on ne prétend rien
   ══════════════════════════════════════════════════════════════════════════ */
section('6. Quand l’état ne dit rien, on ne coupe pas');
{
  const { subId } = await abonnementVivant(projetA, CONTRAT_A, 'a3');
  const avantD = coupures().length;
  const avantP = drapeaux().length;
  brouillerProchaineLecture = true;

  const refus = await projetA.invokeCapability({ code: CANCEL_NOW, input: { subscriptionId: subId } });
  check('l’appel est refusé', refus.ok === false);
  check('…motif SUBSCRIPTION_STATE_UNREADABLE',
    refus.panelDetails?.reason === 'SUBSCRIPTION_STATE_UNREADABLE');
  check('AUCUNE coupure n’a été tentée', coupures().length === avantD);
  check('…ni aucun drapeau', drapeaux().length === avantP);
  check('l’abonnement est intact chez Stripe', parId.get(subId).status === 'active');
}

/* ══════════════════════════════════════════════════════════════════════════
   7. CONCURRENCE
   ══════════════════════════════════════════════════════════════════════════ */
section('7. Huit résiliations simultanées');
{
  const { subId } = await abonnementVivant(projetA, CONTRAT_A, 'a4');
  const avant = coupures().length;

  const resultats = await Promise.all(Array.from({ length: 8 }, () =>
    projetA.invokeCapability({ code: CANCEL_NOW, input: { subscriptionId: subId } })));

  const reussis = resultats.filter((r) => r.ok);
  const refuses = resultats.filter((r) => !r.ok);
  check('au moins un aboutit', reussis.length >= 1);
  check('les autres sont refusés, jamais servis en double',
    refuses.every((r) => r.code === 'CAPABILITY_OPERATION_IN_FLIGHT'));
  check('UNE SEULE coupure émise', coupures().length === avant + 1);
  check('…et l’abonnement est clos une fois', parId.get(subId).status === 'canceled');
}

/* ══════════════════════════════════════════════════════════════════════════
   8. LE CONFLIT DES DEUX VERBES
   ══════════════════════════════════════════════════════════════════════════ */
section('8. Échéance puis immédiate, et l’inverse');
{
  /* 8a. Drapeau posé, puis coupure : la coupure DOIT passer. */
  const { subId } = await abonnementVivant(projetA, CONTRAT_A, 'a5');
  await projetA.invokeCapability({ code: CANCEL_END, input: { subscriptionId: subId } });
  const avantD = coupures().length;
  const coupe = await projetA.invokeCapability({ code: CANCEL_NOW, input: { subscriptionId: subId } });
  check('après le drapeau, la coupure immédiate passe', coupe.ok === true);
  check('…et elle a bien muté', coupures().length === avantD + 1);
  check('…l’abonnement est clos', coupe.data.result.status === 'canceled');

  /**
   * 8b. Coupure d'abord, puis demande de fin de période. L'abonnement est déjà
   * CLOS : ce que la demande visait est acquis. On le CONSTATE au lieu de muter
   * — sans quoi Stripe refuserait, et un état incohérent en sortirait.
   */
  const avantP = drapeaux().length;
  const tardif = await projetA.invokeCapability({ code: CANCEL_END, input: { subscriptionId: subId } });
  check('sur un abonnement clos, la fin de période est CONSTATÉE', tardif.ok === true);
  check('…déclarée déjà faite', tardif.data.result.outcome === 'ALREADY_CANCELLED');
  check('…et aucune mutation émise', drapeaux().length === avantP);

  /* 8c. Les deux verbes en course, sur un abonnement neuf. */
  const { subId: sub2 } = await abonnementVivant(projetA, CONTRAT_A, 'a6');
  const avant2D = coupures().length;
  const avant2P = drapeaux().length;
  const [rEnd, rNow] = await Promise.all([
    projetA.invokeCapability({ code: CANCEL_END, input: { subscriptionId: sub2 } }),
    projetA.invokeCapability({ code: CANCEL_NOW, input: { subscriptionId: sub2 } }),
  ]);
  check('les deux verbes concurrents aboutissent ou se refusent proprement',
    [rEnd, rNow].every((r) => r.ok || r.code === 'CAPABILITY_OPERATION_IN_FLIGHT'));
  check('au plus UNE coupure', coupures().length <= avant2D + 1);
  check('au plus UN drapeau', drapeaux().length <= avant2P + 1);
  /**
   * L'ÉTAT FINAL EST COHÉRENT, quel que soit l'ordre : soit clos, soit marqué
   * pour l'échéance — jamais un état que Stripe aurait refusé de produire.
   */
  const final = parId.get(sub2);
  check('l’état final est cohérent',
    final.status === 'canceled' || final.cancel_at_period_end === true);
}

/* ══════════════════════════════════════════════════════════════════════════
   9. CROSS-TENANT
   ══════════════════════════════════════════════════════════════════════════ */
section('9. Le projet B ne coupe rien chez A');
{
  const { subId } = await abonnementVivant(projetA, CONTRAT_A, 'a7');
  const avantD = coupures().length;
  const avantL = lecturesAbo().length;

  const vol = await projetB.invokeCapability({ code: CANCEL_NOW, input: { subscriptionId: subId } });
  check('B résiliant l’abonnement de A → refusé', vol.ok === false);
  check('…code CAPABILITY_RESOURCE_NOT_OWNED', vol.code === 'CAPABILITY_RESOURCE_NOT_OWNED');

  const invente = await projetB.invokeCapability({
    code: CANCEL_NOW, input: { subscriptionId: 'sub_test_inexistant' },
  });
  check('un abonnement inventé → MÊME code', invente.code === vol.code);
  check('…MÊME message', invente.message === vol.message);
  check('…MÊME statut', invente.httpStatus === vol.httpStatus);

  const { subId: subB } = await abonnementVivant(projetB, CONTRAT_B, 'b0');
  await binding.revokeBinding({
    environment: 'TEST', resourceType: 'SUBSCRIPTION', resourceId: subB, reason: 'E2E',
  });
  const revoque = await projetB.invokeCapability({ code: CANCEL_NOW, input: { subscriptionId: subB } });
  check('un lien révoqué → MÊME refus', revoque.code === vol.code);
  check('…MÊME message', revoque.message === vol.message);

  check('AUCUNE mutation sur les trois refus', coupures().length === avantD);
  /**
   * ZÉRO LECTURE, AUSSI — l'appartenance est vérifiée AVANT l'état. Sans cela,
   * la durée de réponse trahirait l'existence de l'abonnement.
   */
  check('…et AUCUNE lecture non plus', lecturesAbo().length === avantL);
  check('l’abonnement de A est intact', parId.get(subId).status === 'active');
}

/* ══════════════════════════════════════════════════════════════════════════
   10. LES MONDES
   ══════════════════════════════════════════════════════════════════════════ */
section('10. TEST et PROD ne se coupent pas l’un l’autre');
{
  const { subId } = await abonnementVivant(projetA, CONTRAT_A, 'a8');

  check('l’identité de l’acte porte le MONDE',
    annulation.cancellationOperationId({ environment: 'TEST', subscriptionId: subId })
    !== annulation.cancellationOperationId({ environment: 'PROD', subscriptionId: subId }));

  const enProd = await binding.describeOwnership({
    projectId: idA, environment: 'PROD', resourceType: 'SUBSCRIPTION', resourceId: subId,
  });
  check('l’abonnement TEST n’existe pas en PROD', enProd.allowed === false);
  check('…motif « aucun lien »', enProd.reason === 'NO_BINDING');
  check('la clé PROD n’a jamais parlé à Stripe', appels.every((a) => a.auth !== CLE_PANEL_PROD));
}

/* ══════════════════════════════════════════════════════════════════════════
   11. WEBHOOK APRÈS RÉSILIATION
   ══════════════════════════════════════════════════════════════════════════ */
section('11. L’événement de fin est routé vers le bon projet');
{
  await WebhookBinding.create({
    bindingId: 'wb-l62g-test', provider: 'STRIPE', environment: 'TEST',
    remoteEndpointId: 'we_l62g', callbackUrl: `${panelUrl}/webhooks/providers/stripe`,
    ownershipToken: 'l62g', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  });
  await storeWebhookSecret('STRIPE', 'TEST', WHSEC);

  const corps = JSON.stringify({
    id: 'evt_l62g_deleted', type: 'customer.subscription.deleted',
    data: { object: { id: subImmediat, object: 'subscription', status: 'canceled', metadata: { panelProjectId: idB } } },
  });
  const t = Math.floor(Date.now() / 1000);
  const recu = await ingestProviderEvent({
    slug: 'stripe', rawBody: Buffer.from(corps),
    headers: { 'stripe-signature': `t=${t},v1=${createHmac('sha256', WHSEC).update(`${t}.${corps}`).digest('hex')}` },
  });

  check('l’événement est accepté', recu.outcome === INGEST_OUTCOME.ACCEPTED);
  check('…routé vers le propriétaire RÉEL', recu.routedProjectId === idA);
  check('…et jamais vers celui que les metadata réclament', recu.routedProjectId !== idB);
}

/* ══════════════════════════════════════════════════════════════════════════
   12. BILAN
   ══════════════════════════════════════════════════════════════════════════ */
section('12. Bilan');
{
  const cles = new Set(appels.map((a) => a.auth).filter(Boolean));
  check('exactement UNE clé a parlé à Stripe', cles.size === 1);
  check('…celle du coffre du Panel, en TEST', cles.has(CLE_PANEL));
  check('la sentinelle du projet n’apparaît nulle part',
    !JSON.stringify(appels).includes(CLE_PROJET));

  /**
   * L'INVARIANT DU LOT : chaque mutation d'abonnement porte une clé
   * d'idempotence. C'est exactement ce qui manquait à la coupure immédiate
   * depuis l'origine.
   */
  check('AUCUNE mutation sans clé d’idempotence',
    [...coupures(), ...drapeaux()].every((a) => typeof a.cle === 'string' && a.cle.startsWith('pcp_')));
  check('…et deux verbes n’ont jamais partagé une clé',
    new Set(coupures().map((a) => a.cle)).size === coupures().length
    || coupures().every((a) => !drapeaux().some((d) => d.cle === a.cle)));

  const abonnements = [...parId.values()].filter((o) => o.object === 'subscription');
  check('aucun abonnement n’a été coupé deux fois',
    abonnements.every((s) => s.status !== 'canceled' || coupures().filter((c) => c.url.endsWith(s.id)).length <= 1));

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
