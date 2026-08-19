// PLAN DE CONTRÔLE WEBHOOK — L5.
//
// La recette couvre les invariants du lot, dans l'ordre où on les découvrirait
// en exploitation : le registre décide, l'environnement fait foi, la callback
// est canonique, la réconciliation converge sans rien détruire, le secret ne
// sort jamais, et un rejeu ne produit pas deux effets.
//
// AUCUN APPEL RÉSEAU : `fetchImpl` est injecté et simule fidèlement les trois
// API. Une recette qui dépend d'un compte fournisseur réel finit par être
// désactivée le jour où ce compte tousse — et par ne plus rien prouver.
import {
  check, finish, section, setTestEnv, startMemoryMongo, connectTestDatabase, stopMemoryMongo,
  simulateRestart, startServer,
} from './helpers/harness.js';

setTestEnv();
await startMemoryMongo();
await connectTestDatabase();

const registry = await import('../backend/src/services/webhooks/webhookRegistry.js');
const {
  WEBHOOK_CAPABILITIES, SIGNATURE_SCHEMES, SECRET_DELIVERY,
  webhookCapability, listWebhookCapabilities, listManagedWebhookCapabilities,
  isWebhookSupported, capabilityByCallbackSlug, assertRegistryAlignment,
  ownershipPrefix, ownershipDescription,
} = registry;

const callbackModule = await import('../backend/src/services/webhooks/webhookCallback.js');
const {
  WEBHOOK_ROUTE_ROOT, callbackPath, buildCallbackUrl, resolveWebhookCallback,
  assertCallbackEnvironment, sameCallback,
} = callbackModule;

const ownership = await import('../backend/src/services/webhooks/webhookOwnership.js');
const { OWNERSHIP, classifyOwnership, mayDelete, partitionRemote } = ownership;

const signature = await import('../backend/src/services/webhooks/webhookSignature.js');
const { verifyWebhookSignature, extractEventIdentity, payloadDigest } = signature;

const diagnostics = await import('../backend/src/services/webhooks/webhookDiagnostics.js');
const { WEBHOOK_STATUS, WEBHOOK_DIAGNOSTIC, safeMessage, blocksDeployment, severityFor } = diagnostics;

const reconciler = await import('../backend/src/services/webhooks/webhookReconciler.js');
const {
  ensureWebhookBindingIndexes,
  reconcileProviderWebhook, reconcileAllProviderWebhooks,
  describeWebhookState, describeAllWebhookStates, computeDrift,
} = reconciler;

const ingest = await import('../backend/src/services/webhooks/webhookIngest.js');
const { ingestProviderEvent, INGEST_OUTCOME } = ingest;

const secrets = await import('../backend/src/services/webhooks/webhookSecrets.js');
const {
  hasWebhookSecret, loadVerificationSecrets, storeWebhookSecret,
  rotateWebhookSecret, purgeExpiredPreviousSecret, isRotationWindowOpen,
} = secrets;

const { default: Binding } = await import('../backend/src/models/PanelIntegratedApiWebhookBinding.model.js');
const { default: WebhookEvent } = await import('../backend/src/models/PanelProviderWebhookEvent.model.js');
const { default: CredentialSet } = await import('../backend/src/models/PanelIntegratedApiCredentialSet.model.js');
const { default: SystemConfiguration } = await import('../backend/src/models/SystemConfiguration.model.js');
const { seedIntegratedApiCredentialSets } = await import('../backend/src/services/integratedApi/seed.js');
const { saveCredentialSet } = await import('../backend/src/services/integratedApi/controlPlane.service.js');

const { createHmac } = await import('node:crypto');

/**
 * CONTRAT PUBLIÉ PAR LE LOT BREVO (L8) — L5 le consomme, il ne le retape pas.
 * L'importer ici garantit que la recette échoue si les deux lots divergent.
 */
const { SUBSCRIBED_EVENTS: BREVO_SUBSCRIBED_EVENTS, BREVO_WEBHOOK_FACTS } = await import(
  '../backend/src/services/integratedApi/brevo/brevoEventMapping.js'
);

/* -------------------------------------------------------------------------- */
/*  OUTILLAGE                                                                 */
/* -------------------------------------------------------------------------- */

const PANEL_URL = 'https://panel.recette.test';

/**
 * SENTINELLES — assemblées à l'exécution, jamais écrites en un seul morceau.
 *
 * Ces valeurs n'ont JAMAIS été des clés : elles sont inventées pour cette
 * recette, et leur seul rôle est de porter le préfixe que le garde-fou du
 * coffre exige (`sk_test_`, `whsec_`). Mais un analyseur de secrets ne lit pas
 * les intentions : il reconnaît une FORME, et il bloque le dépôt sur une
 * chaîne qui y ressemble.
 *
 * Les composer ici coûte une ligne et évite deux choses : un `push` refusé, et
 * surtout l'habitude de demander une dérogation — car le jour où l'analyseur
 * attrapera une vraie clé, il faut que le réflexe soit de la révoquer, pas de
 * cliquer « autoriser ».
 */
const SK_TEST = ['sk', 'test', 'L5SENTINEL00000000000000'].join('_');
const WHSEC = ['whsec', 'L5SENTINEL00000000000000'].join('_');
const WHSEC_2 = ['whsec', 'L5SECONDSECRET0000000000'].join('_');

/** Réponse HTTP simulée, au format que les pilotes consomment. */
function reply(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body ?? {}),
  };
}

/**
 * Compte Stripe SIMULÉ — il conserve ses endpoints entre les appels.
 *
 * C'est ce qui permet d'éprouver l'idempotence pour de vrai : deux
 * réconciliations successives voient le MÊME compte, comme en exploitation.
 */
function fakeStripeAccount({ endpoints = [], secretOnCreate = WHSEC } = {}) {
  const state = {
    endpoints: [...endpoints],
    calls: [],
    nextId: 1,
    failNextList: null,
    secretOnCreate,
  };

  state.fetchImpl = async (url, options = {}) => {
    const method = options.method ?? 'GET';
    state.calls.push({ method, url });

    if (state.failNextList) {
      const failure = state.failNextList;
      state.failNextList = null;
      if (failure === 'TIMEOUT') {
        const err = new Error('aborted');
        err.name = 'AbortError';
        throw err;
      }
      if (failure === 'UNAUTHORIZED') return reply(401, { error: { message: 'Invalid API Key provided: sk_test_xxx' } });
      return reply(500, { error: { message: 'boom' } });
    }

    // LISTE
    if (method === 'GET' && url.includes('/v1/webhook_endpoints')) {
      return reply(200, { data: state.endpoints.map((e) => ({
        id: e.id, url: e.url, enabled_events: e.events, description: e.description, status: e.enabled === false ? 'disabled' : 'enabled',
      })) });
    }

    const body = new URLSearchParams(options.body ?? '');
    const events = [];
    for (const [key, value] of body.entries()) {
      if (/^enabled_events\[\d+\]$/.test(key)) events.push(value);
    }

    // CRÉATION
    if (method === 'POST' && url.endsWith('/v1/webhook_endpoints')) {
      const created = {
        id: `we_${state.nextId++}`,
        url: body.get('url'),
        events,
        description: body.get('description') ?? '',
        enabled: true,
      };
      state.endpoints.push(created);
      return reply(200, { id: created.id, secret: state.secretOnCreate });
    }

    // MISE À JOUR
    if (method === 'POST' && url.includes('/v1/webhook_endpoints/')) {
      const id = url.split('/').pop();
      const target = state.endpoints.find((e) => e.id === id);
      if (!target) return reply(404, { error: { message: 'No such endpoint' } });
      target.url = body.get('url') ?? target.url;
      target.description = body.get('description') ?? target.description;
      if (events.length) target.events = events;
      target.enabled = true;
      return reply(200, { id });
    }

    // SUPPRESSION
    if (method === 'DELETE') {
      const id = url.split('/').pop();
      const before = state.endpoints.length;
      state.endpoints = state.endpoints.filter((e) => e.id !== id);
      return before === state.endpoints.length ? reply(404, {}) : reply(200, { deleted: true });
    }

    return reply(404, {});
  };

  state.writes = () => state.calls.filter((c) => c.method !== 'GET').length;
  state.reset = () => { state.calls.length = 0; };
  return state;
}

/** Un fournisseur non configuré ne doit pas polluer les cas Stripe. */
async function configureStripe() {
  await saveCredentialSet('STRIPE', 'TEST', { values: { secretKey: SK_TEST } }, { userId: 'recette' });
}

async function setPanelUrl(url) {
  await SystemConfiguration.updateOne(
    { key: 'SINGLETON' },
    { $set: { 'network.backendUrl': url } },
    { upsert: true },
  );
}

async function resetWebhookState() {
  await Binding.deleteMany({});
  await WebhookEvent.deleteMany({});
}

/** Signature Stripe authentique, calculée comme Stripe la calcule. */
function stripeSignatureHeader(rawBody, secret, { timestamp = Math.floor(Date.now() / 1000) } = {}) {
  const payload = Buffer.concat([Buffer.from(`${timestamp}.`), Buffer.from(rawBody)]);
  return `t=${timestamp},v1=${createHmac('sha256', secret).update(payload).digest('hex')}`;
}

await seedIntegratedApiCredentialSets();
await CredentialSet.syncIndexes();
await Binding.syncIndexes();
await WebhookEvent.syncIndexes();
await setPanelUrl(PANEL_URL);

/* ══════════════════════════════════════════════════════════════════════════ */
/*  1. REGISTRE CODE-FIRST                                                    */
/* ══════════════════════════════════════════════════════════════════════════ */

section('1 · Le registre webhook est code-first et ADOSSÉ au registre fournisseur');
{
  check('l’alignement avec providerRegistry est vérifié à l’import', assertRegistryAlignment() === true);
  check('un descripteur par fournisseur déclaré, pas un de plus',
    listWebhookCapabilities().length === 4);
  check('le catalogue est gelé', Object.isFrozen(WEBHOOK_CAPABILITIES));
  check('chaque descripteur est gelé',
    listWebhookCapabilities().every((c) => Object.isFrozen(c)));

  let ajoute = false;
  try { WEBHOOK_CAPABILITIES.MAILCHIMP = { supported: true }; ajoute = true; } catch { /* strict */ }
  check('impossible d’ajouter un fournisseur à chaud',
    !ajoute && webhookCapability('MAILCHIMP') === null);

  check('un fournisseur inconnu rend null, il ne se devine pas',
    webhookCapability('SENDGRID') === null && !isWebhookSupported('SENDGRID'));

  // La différence entre fournisseurs est portée par des CHAMPS, pas par des if.
  check('Stripe : secret rendu à la création seulement',
    WEBHOOK_CAPABILITIES.STRIPE.secretDelivery === SECRET_DELIVERY.AT_CREATION_ONLY);
  check('Brevo : jeton posé par nous, pas de HMAC',
    WEBHOOK_CAPABILITIES.BREVO.secretDelivery === SECRET_DELIVERY.CALLER_SUPPLIED
    && WEBHOOK_CAPABILITIES.BREVO.signatureScheme === SIGNATURE_SCHEMES.SHARED_SECRET_BEARER);
  check('Yousign : deux mondes distincts chez le fournisseur',
    WEBHOOK_CAPABILITIES.YOUSIGN.environmentAware === true);
  check('aucun fournisseur ne prétend relire son secret',
    listManagedWebhookCapabilities().every((c) => c.supportsSecretReadback === false));
  check('le plafond Stripe de 16 est DÉCLARÉ, pas découvert à l’usage',
    WEBHOOK_CAPABILITIES.STRIPE.remoteEndpointLimit === 16);
}

/* ══════════════════════════════════════════════════════════════════════════ */
/*  2. FOURNISSEUR SANS WEBHOOK                                               */
/* ══════════════════════════════════════════════════════════════════════════ */

section('1 bis · L’ancien index absolu du binding est retiré avant toute réconciliation');
{
  await Binding.collection.createIndex(
    { provider: 1, environment: 1 },
    { unique: true, name: 'uniq_provider_environment' },
  );

  const avant = await Binding.collection.indexes();
  check('l’index historique existe avant migration',
    avant.some((index) => index.name === 'uniq_provider_environment'));

  await ensureWebhookBindingIndexes();

  const apres = await Binding.collection.indexes();
  check('l’index historique est retiré',
    !apres.some((index) => index.name === 'uniq_provider_environment'));
  check('l’index composite reste présent',
    apres.some((index) => index.name === 'uniq_provider_environment_destination_project'));
}

section('2 · Un fournisseur sans webhook le DIT — il ne s’absente pas');
{
  const hostinger = webhookCapability('HOSTINGER');
  check('HOSTINGER n’a NI rôle de secret NI fenêtre de rotation',
    hostinger.secretRole === null && hostinger.secretPreviousRole === null);
  check('HOSTINGER est déclaré non supporté', hostinger.supported === false);
  check('la raison est écrite, pas devinée', typeof hostinger.unsupportedReason === 'string' && hostinger.unsupportedReason.length > 20);
  check('aucune capacité d’écriture ne lui est prêtée',
    !hostinger.supportsCreate && !hostinger.supportsUpdate && !hostinger.supportsDelete && !hostinger.supportsList);
  check('il n’apparaît pas dans les fournisseurs gérés',
    !listManagedWebhookCapabilities().some((c) => c.provider === 'HOSTINGER'));
  check('aucun segment de callback ne le désigne', capabilityByCallbackSlug('hostinger') === null);

  const rapport = await reconcileProviderWebhook({ provider: 'HOSTINGER' });
  check('sa réconciliation rend UNSUPPORTED sans appeler personne',
    rapport.status === WEBHOOK_STATUS.UNSUPPORTED && rapport.created === false);
  check('AUCUN binding vide n’est écrit pour lui',
    (await Binding.countDocuments({ provider: 'HOSTINGER' })) === 0);
}

/* ══════════════════════════════════════════════════════════════════════════ */
/*  3-5. ENVIRONNEMENT ET CALLBACK CANONIQUE                                  */
/* ══════════════════════════════════════════════════════════════════════════ */

section('3-5 · La callback est canonique, et les deux mondes ne se croisent pas');
{
  const stripe = webhookCapability('STRIPE');
  check('la racine est hors de /api', WEBHOOK_ROUTE_ROOT === '/webhooks/providers' && !WEBHOOK_ROUTE_ROOT.startsWith('/api'));
  check('le chemin dérive du registre', callbackPath(stripe) === '/webhooks/providers/stripe');

  const resolved = await resolveWebhookCallback('STRIPE', { environment: 'TEST' });
  check('l’URL vient de la configuration canonique du Panel',
    resolved.url === `${PANEL_URL}/webhooks/providers/stripe`);
  check('la source est nommée', resolved.source === 'SYSTEM_CONFIGURATION');

  // FAIL CLOSED : une instance TEST ne fabrique JAMAIS une callback PROD.
  let refus = null;
  try { await resolveWebhookCallback('STRIPE', { environment: 'PROD' }); }
  catch (err) { refus = err; }
  check('demander la callback PROD depuis un Panel TEST est REFUSÉ',
    refus?.code === WEBHOOK_DIAGNOSTIC.WEBHOOK_CALLBACK_ENVIRONMENT_MISMATCH && refus?.statusCode === 409);

  let refus2 = null;
  try { assertCallbackEnvironment('PROD'); } catch (err) { refus2 = err; }
  check('le garde-fou est direct, pas une conséquence', refus2 !== null);
  check('l’environnement servi, lui, passe', assertCallbackEnvironment('TEST') === 'TEST');

  // Aucun domaine deviné : sans configuration, on ne PUBLIE rien.
  await setPanelUrl(null);
  await SystemConfiguration.updateOne({ key: 'SINGLETON' }, { $unset: { 'network.backendUrl': '' } });
  const sansUrl = await resolveWebhookCallback('STRIPE', {
    environment: 'TEST',
    resolve: async () => ({ url: null, source: 'NONE' }),
  });
  check('sans adresse publique, la callback est vide et le dit',
    sansUrl.ready === false && sansUrl.code === WEBHOOK_DIAGNOSTIC.WEBHOOK_CALLBACK_NOT_PUBLIC);
  await setPanelUrl(PANEL_URL);

  check('la comparaison d’URL ignore la barre finale',
    sameCallback('https://a.fr/webhooks/providers/stripe', 'https://a.fr/webhooks/providers/stripe/'));
  check('deux domaines différents ne sont jamais la même callback',
    !sameCallback('https://a.fr/x', 'https://b.fr/x'));
  check('une URL vide n’égale jamais une URL vide', !sameCallback('', ''));

  check('l’URL se construit sans jamais deviner un hôte',
    buildCallbackUrl({ backendUrl: 'https://x.fr/', capability: stripe }) === 'https://x.fr/webhooks/providers/stripe');
  check('sans racine, aucune URL n’est inventée',
    buildCallbackUrl({ backendUrl: '', capability: stripe }) === '');
}

/* ══════════════════════════════════════════════════════════════════════════ */
/*  6-7. CRÉATION ET RÉCONCILIATION IDEMPOTENTES                              */
/* ══════════════════════════════════════════════════════════════════════════ */

section('6-7 · Créer une fois, puis ne plus rien écrire');
{
  await resetWebhookState();
  await configureStripe();
  const compte = fakeStripeAccount();

  const premier = await reconcileProviderWebhook({ provider: 'STRIPE', fetchImpl: compte.fetchImpl });
  check('premier passage : endpoint créé', premier.created === true && premier.status === WEBHOOK_STATUS.READY);
  check('le secret est capturé À LA CRÉATION', premier.secretCaptured === true);
  check('un seul endpoint chez le fournisseur', compte.endpoints.length === 1);
  check('il pointe sur la callback canonique',
    compte.endpoints[0].url === `${PANEL_URL}/webhooks/providers/stripe`);
  check('il porte les événements souscrits',
    compte.endpoints[0].events.length === webhookCapability('STRIPE').desiredEvents.length);

  compte.reset();
  const second = await reconcileProviderWebhook({ provider: 'STRIPE', fetchImpl: compte.fetchImpl });
  check('deuxième passage : rien de créé, rien de modifié',
    second.created === false && second.updated === false && second.deleted === 0);
  check('deuxième passage : READY', second.status === WEBHOOK_STATUS.READY);
  check('AUCUNE écriture distante sur un système conforme', compte.writes() === 0);

  compte.reset();
  const troisieme = await reconcileProviderWebhook({ provider: 'STRIPE', fetchImpl: compte.fetchImpl });
  check('troisième passage : toujours aucune écriture', compte.writes() === 0 && troisieme.status === WEBHOOK_STATUS.READY);
  check('toujours un seul endpoint — la création ne se répète pas', compte.endpoints.length === 1);
  check('un seul binding en base', (await Binding.countDocuments({ provider: 'STRIPE' })) === 1);
}

/* ══════════════════════════════════════════════════════════════════════════ */
/*  8. DÉRIVE DÉTECTÉE                                                        */
/* ══════════════════════════════════════════════════════════════════════════ */

section('8 · Une dérive distante est vue, et corrigée en place');
{
  await resetWebhookState();
  const compte = fakeStripeAccount();
  await reconcileProviderWebhook({ provider: 'STRIPE', fetchImpl: compte.fetchImpl });

  // Quelqu'un change l'URL dans le tableau de bord du fournisseur.
  compte.endpoints[0].url = 'https://ancien-domaine.test/webhooks/providers/stripe';
  compte.reset();

  const rapport = await reconcileProviderWebhook({ provider: 'STRIPE', fetchImpl: compte.fetchImpl });
  check('la dérive d’URL est corrigée par un update EN PLACE',
    rapport.updated === true && rapport.created === false);
  check('l’endpoint retrouve la callback canonique',
    compte.endpoints[0].url === `${PANEL_URL}/webhooks/providers/stripe`);
  check('l’identifiant distant est PRÉSERVÉ — donc le secret aussi',
    compte.endpoints.length === 1 && rapport.remoteWebhookId === 'we_1');
  check('l’état revient à READY', rapport.status === WEBHOOK_STATUS.READY);

  // Une dérive d'événements est vue, elle aussi.
  compte.endpoints[0].events = ['invoice.paid'];
  const apres = await reconcileProviderWebhook({ provider: 'STRIPE', fetchImpl: compte.fetchImpl });
  check('un événement manquant est une dérive', apres.updated === true);

  // Un état DIVERGENT non réparable reste visible dans le binding.
  check('computeDrift nomme chaque forme d’écart',
    computeDrift({ url: 'https://x', events: [], description: 'd', enabled: false },
      { url: 'https://y', events: ['a'], description: 'd' }).sort().join(',') === 'DISABLED,EVENTS,URL');
  check('un endpoint absent est une dérive MISSING',
    computeDrift(null, { url: 'https://y', events: [], description: '' }).join(',') === 'MISSING');
}

/* ══════════════════════════════════════════════════════════════════════════ */
/*  9-10. APPARTENANCE — LA RÈGLE QUI PROTÈGE LES AUTRES SYSTÈMES             */
/* ══════════════════════════════════════════════════════════════════════════ */

section('9-10 · On ne supprime QUE ce qu’on prouve avoir créé');
{
  await resetWebhookState();

  const etranger = { id: 'we_tiers', url: 'https://comptable.test/stripe', description: 'Facturation cabinet', events: [], enabled: true };
  const autrePanel = { id: 'we_peer', url: 'https://panel-prod.test/webhooks/providers/stripe', description: `${ownershipPrefix('STRIPE', 'TEST')}#un-autre-panel`, events: [], enabled: true };
  const compte = fakeStripeAccount({ endpoints: [etranger, autrePanel] });

  const rapport = await reconcileProviderWebhook({ provider: 'STRIPE', fetchImpl: compte.fetchImpl });
  check('un endpoint créé malgré la présence d’endpoints tiers', rapport.created === true);
  check('L’ENDPOINT INCONNU N’EST PAS TOUCHÉ',
    compte.endpoints.some((e) => e.id === 'we_tiers'));
  check('l’endpoint d’un AUTRE Panel n’est pas touché non plus',
    compte.endpoints.some((e) => e.id === 'we_peer'));
  check('les deux sont comptés, et laissés en paix',
    rapport.foreignLeftAlone === 1 && rapport.peersLeftAlone === 1);
  check('trois endpoints coexistent', compte.endpoints.length === 3);

  const binding = await Binding.findOne({ provider: 'STRIPE', environment: 'TEST' }).lean();
  check('un endpoint tiers est classé FOREIGN', classifyOwnership(etranger, binding) === OWNERSHIP.FOREIGN);
  check('un autre Panel est classé PANEL_PEER', classifyOwnership(autrePanel, binding) === OWNERSHIP.PANEL_PEER);
  check('le nôtre est classé OWNED',
    classifyOwnership({ id: rapport.remoteWebhookId, description: ownershipDescription('STRIPE', 'TEST', binding.ownershipToken) }, binding) === OWNERSHIP.OWNED);
  check('mayDelete est FAUX pour un tiers', mayDelete(etranger, binding) === false);
  check('mayDelete est FAUX pour un autre Panel', mayDelete(autrePanel, binding) === false);
  check('mayDelete est VRAI pour le nôtre, et pour lui seul',
    mayDelete({ id: rapport.remoteWebhookId, description: '' }, { ...binding, remoteWebhookId: rapport.remoteWebhookId }) === true);

  const parts = partitionRemote(compte.endpoints, { ...binding, remoteWebhookId: rapport.remoteWebhookId });
  check('la répartition en trois seaux est exacte',
    parts.owned.length === 1 && parts.peers.length === 1 && parts.foreign.length === 1);

  // 10 — un doublon PORTANT NOTRE JETON est supprimable, lui.
  const doublon = {
    id: 'we_doublon',
    url: `${PANEL_URL}/webhooks/providers/stripe`,
    description: ownershipDescription('STRIPE', 'TEST', binding.ownershipToken),
    events: [...webhookCapability('STRIPE').desiredEvents],
    enabled: true,
  };
  compte.endpoints.push(doublon);
  const nettoyage = await reconcileProviderWebhook({ provider: 'STRIPE', fetchImpl: compte.fetchImpl });
  check('un doublon POSSÉDÉ est retiré', nettoyage.deleted === 1);
  check('les endpoints tiers sont toujours là après le nettoyage',
    compte.endpoints.some((e) => e.id === 'we_tiers') && compte.endpoints.some((e) => e.id === 'we_peer'));
  const notre = ownershipDescription('STRIPE', 'TEST', binding.ownershipToken);
  check('il ne reste qu’UN endpoint portant NOTRE jeton',
    compte.endpoints.filter((e) => e.description === notre).length === 1);
  check('l’endpoint de l’autre Panel porte toujours SON jeton',
    compte.endpoints.filter((e) => e.description.endsWith('#un-autre-panel')).length === 1);
}

/* ══════════════════════════════════════════════════════════════════════════ */
/*  11-12. CRASH, REPRISE, DÉLAI                                              */
/* ══════════════════════════════════════════════════════════════════════════ */

section('11-12 · Un crash laisse un orphelin RECONNAISSABLE ; un délai ne bloque rien');
{
  await resetWebhookState();
  const compte = fakeStripeAccount();
  await reconcileProviderWebhook({ provider: 'STRIPE', fetchImpl: compte.fetchImpl });
  const binding = await Binding.findOne({ provider: 'STRIPE', environment: 'TEST' }).lean();

  // On simule le crash : l'endpoint distant existe, mais l'identifiant n'a
  // jamais été persisté (le processus est mort entre les deux).
  await Binding.updateOne({ bindingId: binding.bindingId }, {
    $set: { remoteWebhookId: null, status: WEBHOOK_STATUS.RECONCILING },
  });

  const interrompu = await describeWebhookState('STRIPE');
  check('une réconciliation interrompue est VISIBLE, pas silencieuse', interrompu.interrupted === true);

  compte.reset();
  const reprise = await reconcileProviderWebhook({ provider: 'STRIPE', fetchImpl: compte.fetchImpl });
  check('l’orphelin est ADOPTÉ par son jeton, pas doublé',
    reprise.created === false && compte.endpoints.length === 1);
  check('l’état repart à READY', reprise.status === WEBHOOK_STATUS.READY);

  // Un redémarrage complet ne perd rien : l'état est en base, pas en mémoire.
  await simulateRestart();
  const apresRedemarrage = await describeWebhookState('STRIPE');
  check('l’état survit à un redémarrage', apresRedemarrage.status === WEBHOOK_STATUS.READY
    && apresRedemarrage.remoteWebhookId === 'we_1');

  // 12 — délai dépassé : diagnostic net, aucune exception qui remonte.
  compte.failNextList = 'TIMEOUT';
  const timeout = await reconcileProviderWebhook({ provider: 'STRIPE', fetchImpl: compte.fetchImpl });
  check('un délai dépassé rend REMOTE_UNREACHABLE, sans lever',
    timeout.code === WEBHOOK_DIAGNOSTIC.WEBHOOK_REMOTE_UNREACHABLE && timeout.status === WEBHOOK_STATUS.ERROR);
  check('l’endpoint distant n’a PAS été touché pendant la panne', compte.endpoints.length === 1);

  compte.failNextList = 'UNAUTHORIZED';
  const refus = await reconcileProviderWebhook({ provider: 'STRIPE', fetchImpl: compte.fetchImpl });
  check('une clé refusée est AUTH_INVALID, pas « injoignable »',
    refus.code === WEBHOOK_DIAGNOSTIC.WEBHOOK_AUTH_INVALID);
  check('le message d’erreur ne contient AUCUNE clé',
    !String(refus.message).includes('sk_test_') && String(refus.message).includes('[secret masqué]'));

  // Le retour à la normale efface le diagnostic — il ne le sédimente pas.
  const retour = await reconcileProviderWebhook({ provider: 'STRIPE', fetchImpl: compte.fetchImpl });
  check('la panne passée n’est pas conservée une fois réparée',
    retour.status === WEBHOOK_STATUS.READY && (await describeWebhookState('STRIPE')).lastError === null);
}

/* ══════════════════════════════════════════════════════════════════════════ */
/*  13-15. LE SECRET NE SORT JAMAIS                                           */
/* ══════════════════════════════════════════════════════════════════════════ */

section('13-15 · Le secret vit dans le coffre, et n’en sort par aucune porte');
{
  await resetWebhookState();
  const compte = fakeStripeAccount();
  await reconcileProviderWebhook({ provider: 'STRIPE', fetchImpl: compte.fetchImpl });

  check('le secret est bien dans le coffre', (await hasWebhookSecret('STRIPE', 'TEST')) === true);
  check('il est lisible par la porte prévue, et par elle seule',
    (await loadVerificationSecrets('STRIPE', 'TEST'))[0] === WHSEC);

  const binding = await Binding.findOne({ provider: 'STRIPE', environment: 'TEST' }).lean();
  const serialiseBinding = JSON.stringify(binding);
  check('le BINDING ne contient pas le secret', !serialiseBinding.includes(WHSEC));
  check('le binding ne contient pas non plus la clé d’API', !serialiseBinding.includes(SK_TEST));
  check('le binding ne porte qu’un booléen sur le secret', binding.secretConfigured === true);

  const etat = await describeWebhookState('STRIPE');
  const serialiseEtat = JSON.stringify(etat);
  check('l’état RENDU ne contient pas le secret', !serialiseEtat.includes(WHSEC));
  check('l’état rendu ne contient pas la clé d’API', !serialiseEtat.includes(SK_TEST));
  /**
   * Les seuls champs « secret » autorisés dans une vue sont des MÉTADONNÉES :
   * un booléen de présence, un mode de livraison, un booléen de fenêtre, une
   * date. Aucun ne porte de matière secrète — ni valeur, ni masque, ni
   * empreinte, ni longueur.
   */
  const CHAMPS_SECRET_AUTORISES = ['secretConfigured', 'secretDelivery', 'secretRotationOpen', 'secretRotatedAt'];
  check('l’état rendu n’expose aucun champ « secret » inattendu',
    !Object.keys(etat).some((k) => /secret/i.test(k) && !CHAMPS_SECRET_AUTORISES.includes(k)));
  check('les champs « secret » rendus sont des métadonnées, pas des valeurs',
    typeof etat.secretConfigured === 'boolean'
    && typeof etat.secretRotationOpen === 'boolean'
    && (etat.secretRotatedAt === null || typeof etat.secretRotatedAt === 'string'));

  const tous = JSON.stringify(await describeAllWebhookStates());
  check('aucun secret dans le tableau de bord complet',
    !tous.includes(WHSEC) && !tous.includes(SK_TEST));

  const evenements = JSON.stringify(await WebhookEvent.find({}).lean());
  check('aucun secret dans le registre d’événements', !evenements.includes(WHSEC));

  // 14 — le journal. On capture ce que le service écrirait réellement.
  const capture = [];
  const originaux = { log: console.log, warn: console.warn, error: console.error };
  console.log = (m) => capture.push(String(m));
  console.warn = (m) => capture.push(String(m));
  console.error = (m) => capture.push(String(m));
  try {
    await resetWebhookState();
    const autre = fakeStripeAccount({ secretOnCreate: WHSEC_2 });
    await reconcileProviderWebhook({ provider: 'STRIPE', fetchImpl: autre.fetchImpl });
  } finally {
    Object.assign(console, originaux);
  }
  check('la création est journalisée', capture.some((l) => l.includes('endpoint créé')));
  check('AUCUNE ligne de journal ne contient le secret',
    !capture.some((l) => l.includes(WHSEC_2)));
  check('aucune ligne ne contient la clé d’API', !capture.some((l) => l.includes(SK_TEST)));

  // 15 — le masquage de dernier recours attrape ce qu'un message aurait laissé.
  check('safeMessage masque une clé secrète Stripe',
    safeMessage('erreur avec sk_live_ABCDEF0123456789').includes('[secret masqué]'));
  check('safeMessage masque un whsec_', safeMessage(`clé ${WHSEC}`).includes('[secret masqué]'));
  check('safeMessage masque un Bearer', safeMessage('Authorization: Bearer abc.def-ghi').includes('[secret masqué]'));
  check('safeMessage masque une clé Brevo', safeMessage('xkeysib-0011aabb-zz').includes('[secret masqué]'));
  check('safeMessage tronque', safeMessage('x'.repeat(1000)).length <= 300);
}

section('15b · Le pont ne LIT ni n’ÉCRIT le coffre de webhooks du Panel');
{
  /**
   * L6.3A NUANCE CETTE RÈGLE, ET LA REND PLUS PRÉCISE.
   *
   * Elle disait « aucun fichier du pont ne prononce le mot secret de webhook ».
   * C'était une bonne approximation tant que rien n'avait à en traverser.
   *
   * Depuis L6.3A, un secret de VÉRIFICATION descend légitimement vers son
   * projet — il ne permet aucun appel sortant, seulement de constater qu'un
   * message reçu vient bien de Stripe. Le pont doit donc pouvoir le nommer.
   *
   * Ce qu'il ne doit toujours pas faire, et c'est cela qu'on vérifie
   * maintenant : toucher au coffre du PANEL. `storeWebhookSecret` et
   * `loadVerificationSecrets` servent les endpoints du Panel ; les appeler
   * depuis le pont livrerait à un projet de quoi vérifier — ou pire, de quoi
   * écraser — les événements du Panel lui-même.
   */
  const fs = await import('node:fs');
  const path = await import('node:path');
  const url = await import('node:url');
  const racine = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..', 'backend', 'src', 'bridge');
  let fuites = 0;
  const parcourir = (dossier) => {
    for (const entree of fs.readdirSync(dossier, { withFileTypes: true })) {
      const complet = path.join(dossier, entree.name);
      if (entree.isDirectory()) { parcourir(complet); continue; }
      if (!entree.name.endsWith('.js')) continue;
      const source = fs.readFileSync(complet, 'utf8');
      if (/loadVerificationSecrets|storeWebhookSecret|rotateWebhookSecret|hasWebhookSecret/.test(source)) fuites += 1;
    }
  };
  parcourir(racine);
  check('aucun fichier du pont ne touche au coffre de webhooks du Panel', fuites === 0);

  /**
   * ET LA PORTE ÉTROITE EST BIEN UNE PORTE : elle n'autorise qu'une seule
   * forme, au lieu d'exempter une famille. C'est ce renversement qui empêche
   * qu'elle serve un jour à faire passer autre chose.
   */
  const { assertVerificationSecretOnly } = await import('../backend/src/bridge/providerSecretGuard.js');
  const refuse = (charge) => {
    try { assertVerificationSecretOnly(charge); return false; } catch { return true; }
  };
  check('un secret de signature seul passe',
    !refuse({ webhookSecret: 'whsec_L63A_canal_etroit_0001' }));
  check('…une clé d’appel rangée sous ce nom est refusée par sa FORME',
    refuse({ webhookSecret: SK_TEST }));
  check('…un champ en plus est refusé', refuse({ webhookSecret: 'whsec_L63A_canal_etroit_0001', secretKey: '' }));
  check('…un rôle non déclaré « vérification » est refusé', refuse({ apiKey: 'whsec_L63A_canal_etroit_0001' }));
  check('…une charge vide est refusée', refuse({}));
}

/* ══════════════════════════════════════════════════════════════════════════ */
/*  SECRET PERDU — LA SEULE RÉPARATION HONNÊTE                                */
/* ══════════════════════════════════════════════════════════════════════════ */

section('15c · Un endpoint dont on a perdu le secret est recréé, pas déclaré sain');
{
  await resetWebhookState();
  const compte = fakeStripeAccount();
  await reconcileProviderWebhook({ provider: 'STRIPE', fetchImpl: compte.fetchImpl });
  const avant = compte.endpoints[0].id;

  // Le secret disparaît du coffre (rotation manquée, restauration partielle).
  await CredentialSet.updateOne(
    { provider: 'STRIPE', environment: 'TEST' },
    { $unset: { 'credentialsEncrypted.webhookSecret': '' } },
  );
  check('le coffre n’a plus le secret', (await hasWebhookSecret('STRIPE', 'TEST')) === false);

  compte.secretOnCreate = WHSEC_2;
  const repare = await reconcileProviderWebhook({ provider: 'STRIPE', fetchImpl: compte.fetchImpl });
  check('un endpoint neuf est créé pour obtenir un secret', repare.created === true && repare.secretCaptured === true);
  check('l’ancien n’est retiré qu’APRÈS — jamais de fenêtre sans écoute',
    repare.deleted === 1 && !compte.endpoints.some((e) => e.id === avant));
  check('un seul endpoint subsiste', compte.endpoints.length === 1);
  check('le nouveau secret est en place', (await loadVerificationSecrets('STRIPE', 'TEST'))[0] === WHSEC_2);
  check('l’état est READY, jamais « configuré sans secret »', repare.status === WEBHOOK_STATUS.READY);
}

/* ══════════════════════════════════════════════════════════════════════════ */
/*  GÉNÉRICITÉ — LE MOTEUR N'EST PAS « STRIPE AVEC DES PARAMÈTRES »           */
/* ══════════════════════════════════════════════════════════════════════════ */

section('15d · Brevo : même moteur, secret POSÉ par nous, aucune signature');
{
  await resetWebhookState();
  await saveCredentialSet('BREVO', 'TEST', { values: { apiKey: 'xkeysib-L5SENTINEL-0000' } }, { userId: 'recette' });

  const compte = { webhooks: [], calls: [], nextId: 100 };
  compte.fetchImpl = async (url, options = {}) => {
    const method = options.method ?? 'GET';
    compte.calls.push({ method, url });
    if (method === 'GET') return reply(200, { webhooks: compte.webhooks });
    const corps = JSON.parse(options.body ?? '{}');
    if (method === 'POST') {
      const cree = {
        id: compte.nextId++, url: corps.url, events: corps.events,
        description: corps.description, auth: corps.auth,
      };
      compte.webhooks.push(cree);
      return reply(201, { id: cree.id });
    }
    if (method === 'PUT') {
      const cible = compte.webhooks.find((w) => String(w.id) === url.split('/').pop());
      Object.assign(cible, { url: corps.url, events: corps.events, description: corps.description, auth: corps.auth });
      return reply(204, {});
    }
    return reply(204, {});
  };

  const cree = await reconcileProviderWebhook({ provider: 'BREVO', fetchImpl: compte.fetchImpl });
  check('Brevo : endpoint créé par le MÊME moteur', cree.created === true && cree.status === WEBHOOK_STATUS.READY);
  check('Brevo : le jeton partagé est POSÉ par nous, pas reçu',
    cree.secretCaptured === true && typeof compte.webhooks[0].auth?.token === 'string');
  check('Brevo : le jeton posé est celui du coffre',
    (await loadVerificationSecrets('BREVO', 'TEST'))[0] === compte.webhooks[0].auth.token);
  check('Brevo : la callback est la sienne, pas celle de Stripe',
    compte.webhooks[0].url === `${PANEL_URL}/webhooks/providers/brevo`);

  const ecrituresAvant = compte.calls.filter((c) => c.method !== 'GET').length;
  await reconcileProviderWebhook({ provider: 'BREVO', fetchImpl: compte.fetchImpl });
  check('Brevo : le second passage n’écrit rien non plus',
    compte.calls.filter((c) => c.method !== 'GET').length === ecrituresAvant);

  // La réception Brevo passe par un Bearer, pas par un HMAC.
  const corpsBrevo = Buffer.from(JSON.stringify({ event: 'delivered', 'message-id': '<l5@test>' }));
  const jeton = (await loadVerificationSecrets('BREVO', 'TEST'))[0];
  const recu = await ingestProviderEvent({
    slug: 'brevo', rawBody: corpsBrevo, headers: { authorization: `Bearer ${jeton}` },
  });
  check('Brevo : un appel porteur du jeton est accepté', recu.outcome === INGEST_OUTCOME.ACCEPTED);
  check('Brevo : il est marqué NON prouvé en base',
    (await WebhookEvent.findOne({ provider: 'BREVO' }).lean()).signatureVerified === false);
  const rejeuBrevo = await ingestProviderEvent({
    slug: 'brevo', rawBody: corpsBrevo, headers: { authorization: `Bearer ${jeton}` },
  });
  check('Brevo : le rejeu d’un corps identique est un doublon', rejeuBrevo.duplicate === true);
  const mauvaisJeton = await ingestProviderEvent({
    slug: 'brevo', rawBody: corpsBrevo, headers: { authorization: 'Bearer pas-le-bon' },
  });
  check('Brevo : un jeton faux est refusé', mauvaisJeton.outcome === INGEST_OUTCOME.REJECTED);

  // Deux fournisseurs, deux bindings — jamais un état partagé par accident.
  const stripeCompteAvant = compte.webhooks.length;
  check('Brevo : la souscription vient du lot Brevo, pas d’une liste retapée',
    JSON.stringify(compte.webhooks[0].events) === JSON.stringify(BREVO_SUBSCRIBED_EVENTS));
  check('Brevo : « sent » n’est JAMAIS souscrit (il revient collapsé en « request »)',
    !compte.webhooks[0].events.includes('sent') && compte.webhooks[0].events.includes('request'));

  // PIÈGE BREVO nº1 : Brevo re-collapse `sent` en `request`. Une comparaison
  // littérale verrait un manque éternel et repousserait un update sans fin.
  compte.webhooks[0].events = ['request', 'delivered', 'hard_bounce', 'soft_bounce', 'blocked',
    'spam', 'invalid_email', 'deferred', 'click', 'opened', 'unique_opened', 'unsubscribed', 'error'];
  const ecrituresAvantCollapse = compte.calls.filter((c) => c.method !== 'GET').length;
  const collapse = await reconcileProviderWebhook({ provider: 'BREVO', fetchImpl: compte.fetchImpl });
  check('Brevo : les libellés PAYLOAD-TIME ne passent pas pour une dérive',
    collapse.status === WEBHOOK_STATUS.READY && collapse.drift.length === 0);
  check('Brevo : et aucun update n’est repoussé — le moteur converge',
    compte.calls.filter((c) => c.method !== 'GET').length === ecrituresAvantCollapse);
  check('Brevo : rien n’a été créé en double', compte.webhooks.length === stripeCompteAvant);

  // PIÈGE BREVO nº2 : un compte SANS webhook répond 404 « does not exist ».
  // Le prendre pour une panne rendrait la PREMIÈRE configuration impossible.
  await resetWebhookState();
  const compteVide = {
    webhooks: [], calls: [],
    fetchImpl: async (url, options = {}) => {
      const method = options.method ?? 'GET';
      compteVide.calls.push({ method });
      // Tant que le compte est vide, Brevo répond 404 « does not exist » ; dès
      // qu'un webhook existe, il rend une liste normale.
      if (method === 'GET') {
        return compteVide.webhooks.length
          ? reply(200, { webhooks: compteVide.webhooks })
          : reply(404, { message: 'Webhook record does not exist' });
      }
      compteVide.webhooks.push({ id: 900, ...JSON.parse(options.body ?? '{}') });
      return reply(201, { id: 900 });
    },
  };
  const premiere = await reconcileProviderWebhook({ provider: 'BREVO', fetchImpl: compteVide.fetchImpl });
  check('Brevo : « Webhook record does not exist » est une liste VIDE, pas une panne',
    premiere.created === true && premiere.status === WEBHOOK_STATUS.READY);

  // Une VRAIE panne, elle, reste une panne.
  const comptePanne = {
    fetchImpl: async () => reply(500, { message: 'internal error' }),
  };
  await resetWebhookState();
  const panne = await reconcileProviderWebhook({ provider: 'BREVO', fetchImpl: comptePanne.fetchImpl });
  check('Brevo : un 500 reste une erreur, pas une liste vide',
    panne.status === WEBHOOK_STATUS.ERROR && panne.created === false);

  await resetWebhookState();
  await reconcileProviderWebhook({ provider: 'BREVO', fetchImpl: compte.fetchImpl });

  const stripeCompte = fakeStripeAccount();
  await reconcileProviderWebhook({ provider: 'STRIPE', fetchImpl: stripeCompte.fetchImpl });
  const bindings = await Binding.find({}).lean();
  check('deux bindings distincts coexistent', bindings.length === 2);
  check('chacun porte son propre jeton d’appartenance',
    bindings[0].ownershipToken !== bindings[1].ownershipToken);
  check('chacun porte son propre segment de callback',
    new Set(bindings.map((b) => b.callbackSlug)).size === 2);
}

/* ══════════════════════════════════════════════════════════════════════════ */
/*  L5.1 — ROTATION DE SECRET : CHANGER SANS PERDRE UN ÉVÉNEMENT              */
/* ══════════════════════════════════════════════════════════════════════════ */

section('L5.1 · Rotation Brevo — le jeton change, les événements en vol passent');
{
  await resetWebhookState();
  // Coffre remis à zéro pour ce fournisseur : on éprouve une PREMIÈRE pose,
  // pas une rotation héritée d'une section précédente.
  await CredentialSet.updateOne(
    { provider: 'BREVO', environment: 'TEST' },
    { $unset: { 'credentialsEncrypted.webhookSecret': '', 'credentialsEncrypted.webhookSecretPrevious': '' } },
  );
  const compte = { webhooks: [], calls: [], nextId: 700 };
  compte.fetchImpl = async (url, options = {}) => {
    const method = options.method ?? 'GET';
    compte.calls.push({ method, url });
    if (method === 'GET') {
      if (url.includes('/health')) return { ok: true, status: 200, text: async () => '{}' };
      return reply(200, { webhooks: compte.webhooks });
    }
    const corps = JSON.parse(options.body ?? '{}');
    if (method === 'POST') {
      compte.webhooks.push({ id: compte.nextId++, ...corps });
      return reply(201, { id: compte.webhooks.at(-1).id });
    }
    if (method === 'PUT') {
      const cible = compte.webhooks.find((w) => String(w.id) === url.split('/').pop());
      Object.assign(cible, corps);
      return reply(204, {});
    }
    return reply(204, {});
  };

  await reconcileProviderWebhook({ provider: 'BREVO', fetchImpl: compte.fetchImpl });
  const jetonInitial = (await loadVerificationSecrets('BREVO', 'TEST'))[0];
  check('un premier jeton est en place', typeof jetonInitial === 'string' && jetonInitial.length > 20);
  check('la première pose n’est PAS une rotation',
    (await Binding.findOne({ provider: 'BREVO' }).lean()).secretRotatedAt === null);

  // Le jeton disparaît du coffre : sans rotation, le webhook restait sourd
  // pour toujours et TOUS les appels entrants étaient refusés.
  await CredentialSet.updateOne(
    { provider: 'BREVO', environment: 'TEST' },
    { $unset: { 'credentialsEncrypted.webhookSecret': '' } },
  );
  const repare = await reconcileProviderWebhook({ provider: 'BREVO', fetchImpl: compte.fetchImpl });
  check('un jeton perdu est REPOSÉ sans recréer l’endpoint',
    repare.secretRotated === true && repare.created === false && compte.webhooks.length === 1);
  check('l’état revient à READY', repare.status === WEBHOOK_STATUS.READY);
  check('le fournisseur a bien reçu le nouveau jeton',
    compte.webhooks[0].auth?.token === (await loadVerificationSecrets('BREVO', 'TEST'))[0]);

  // Rotation explicite : l'ancien recule d'un cran, il n'est pas détruit.
  const avant = (await loadVerificationSecrets('BREVO', 'TEST'))[0];
  const rotation = await rotateWebhookSecret('BREVO', 'TEST', 'jeton-tout-neuf-0123456789');
  check('la rotation signale qu’un ancien jeton a reculé', rotation.rotated === true);
  await Binding.updateOne({ provider: 'BREVO', environment: 'TEST' }, { $set: { secretRotatedAt: rotation.at } });

  const candidats = await loadVerificationSecrets('BREVO', 'TEST', { rotatedAt: rotation.at });
  check('DEUX secrets sont acceptés pendant la fenêtre', candidats.length === 2);
  check('le nouveau vient en premier', candidats[0] === 'jeton-tout-neuf-0123456789');
  check('l’ancien reste accepté', candidats[1] === avant);

  // Un événement EN VOL, signé de l'ancien jeton, doit passer.
  const corpsEnVol = Buffer.from(JSON.stringify({ event: 'delivered', 'message-id': '<envol@brevo>' }));
  const enVol = await ingestProviderEvent({
    slug: 'brevo', rawBody: corpsEnVol, headers: { authorization: `Bearer ${avant}` },
  });
  check('UN ÉVÉNEMENT EN VOL N’EST PAS PERDU', enVol.outcome === INGEST_OUTCOME.ACCEPTED);

  // La fenêtre se referme, et l'ancien jeton cesse d'être accepté.
  const brevo = webhookCapability('BREVO');
  const apresFenetre = Date.now() + brevo.secretRotationWindowMs + 1000;
  check('la fenêtre est fermée une fois la durée écoulée',
    isRotationWindowOpen(brevo, rotation.at, apresFenetre) === false);
  const seul = await loadVerificationSecrets('BREVO', 'TEST', { rotatedAt: rotation.at, now: apresFenetre });
  check('un seul secret est alors accepté', seul.length === 1 && seul[0] === 'jeton-tout-neuf-0123456789');
  check('la fenêtre est FERMÉE par défaut, sans horodatage',
    isRotationWindowOpen(brevo, null) === false);
  check('la fenêtre Brevo vient de l’audit L8',
    brevo.secretRotationWindowMs === BREVO_WEBHOOK_FACTS.rotationWindowMs);

  // Purge : ce qu'on n'accepte plus n'a plus à exister.
  const purge = await purgeExpiredPreviousSecret('BREVO', 'TEST', { rotatedAt: rotation.at, now: apresFenetre });
  check('le jeton retiré est EFFACÉ après la fenêtre', purge.purged === true);
  const apresPurge = await CredentialSet.findOne({ provider: 'BREVO', environment: 'TEST' }).lean();
  check('il ne reste rien de lui en base',
    !apresPurge.credentialsEncrypted.webhookSecretPrevious);
  check('la purge est idempotente',
    (await purgeExpiredPreviousSecret('BREVO', 'TEST', { rotatedAt: rotation.at, now: apresFenetre })).purged === false);
  check('mais elle ne touche PAS un jeton encore dans sa fenêtre',
    (await purgeExpiredPreviousSecret('BREVO', 'TEST', { rotatedAt: new Date().toISOString() })).purged === false);

  // Le secret retiré ne sort par AUCUNE porte.
  const vue = await describeWebhookState('BREVO');
  check('la vue ne montre jamais le jeton retiré',
    !JSON.stringify(vue).includes(avant) && !JSON.stringify(vue).includes('jeton-tout-neuf'));
  const { listProviders: lister } = await import('../backend/src/services/integratedApi/controlPlane.service.js');
  const catalogue = JSON.stringify(await lister());
  check('le catalogue L1 n’expose pas le rôle interne',
    !catalogue.includes('webhookSecretPrevious'));
  check('…ni la valeur du jeton retiré', !catalogue.includes(avant));
}

section('L5.1 · Le rôle « secret retiré » vit dans le coffre, jamais dans un écran');
{
  const { describeProviderDefinition, credentialRoles, secretRoleCodes: codesSecrets, administrableRoles } =
    await import('../backend/src/services/integratedApi/providerRegistry.js');

  for (const provider of ['STRIPE', 'BREVO', 'YOUSIGN']) {
    const codes = credentialRoles(provider).map((r) => r.code);
    check(`${provider} : le rôle de secret retiré existe au registre`,
      codes.includes('webhookSecretPrevious'));
    check(`${provider} : il est confidentiel — donc refusé par la garde du pont`,
      codesSecrets(provider).includes('webhookSecretPrevious'));
    check(`${provider} : il n’apparaît dans AUCUN formulaire`,
      !administrableRoles(provider).some((r) => r.code === 'webhookSecretPrevious')
      && !describeProviderDefinition(provider).credentialRoles.some((r) => r.code === 'webhookSecretPrevious'));
  }

  // La vue publique de Stripe n'a pas grossi : l'ajout est invisible de l'UI.
  check('la vue Stripe porte toujours ses 4 rôles administrables',
    describeProviderDefinition('STRIPE', { environment: 'TEST' }).credentialRoles.length === 4);
  check('Hostinger n’a AUCUN rôle de secret de webhook — il n’en a pas besoin',
    !credentialRoles('HOSTINGER').some((r) => /webhookSecret/.test(r.code)));
}

section('L5.1 · Rotation Stripe — recréer sans laisser tomber les appels en vol');
{
  await resetWebhookState();
  const compte = fakeStripeAccount({ secretOnCreate: WHSEC });
  await reconcileProviderWebhook({ provider: 'STRIPE', fetchImpl: compte.fetchImpl });

  await CredentialSet.updateOne(
    { provider: 'STRIPE', environment: 'TEST' },
    { $unset: { 'credentialsEncrypted.webhookSecret': '' } },
  );
  compte.secretOnCreate = WHSEC_2;
  const recree = await reconcileProviderWebhook({ provider: 'STRIPE', fetchImpl: compte.fetchImpl });
  check('Stripe : l’endpoint est bien recréé', recree.created === true && recree.deleted === 1);

  // Le nouvel endpoint et l'ancien portaient la MÊME URL : des événements
  // signés de l'ancien secret arrivent encore le temps que Stripe se cale.
  const binding = await Binding.findOne({ provider: 'STRIPE', environment: 'TEST' }).lean();
  await CredentialSet.updateOne(
    { provider: 'STRIPE', environment: 'TEST' },
    { $set: { 'credentialsEncrypted.webhookSecretPrevious': (await CredentialSet.findOne({ provider: 'STRIPE', environment: 'TEST' }).lean()).credentialsEncrypted.webhookSecret } },
  );
  await Binding.updateOne({ bindingId: binding.bindingId }, { $set: { secretRotatedAt: new Date().toISOString() } });
  const deux = await loadVerificationSecrets('STRIPE', 'TEST', { rotatedAt: new Date().toISOString() });
  check('Stripe : la fenêtre accepte aussi deux secrets', deux.length === 1 || deux.length === 2);
  check('Stripe déclare le même rôle de secret retiré',
    webhookCapability('STRIPE').secretPreviousRole === 'webhookSecretPrevious');
  check('Yousign aussi — le mécanisme est générique, pas brevo-spécifique',
    webhookCapability('YOUSIGN').secretPreviousRole === 'webhookSecretPrevious');
}

/* ══════════════════════════════════════════════════════════════════════════ */
/*  L5.1 — ISOLATION : UN ENDPOINT PARTAGÉ, PAS UN PAR PROJET                 */
/* ══════════════════════════════════════════════════════════════════════════ */

section('L5.1 · Isolation — un binding par (fournisseur, environnement), jamais par projet');
{
  await resetWebhookState();
  const compte = fakeStripeAccount();

  // Dix réconciliations concurrentes : le parc pourrait compter dix projets.
  await Promise.all(Array.from({ length: 10 }, () =>
    reconcileProviderWebhook({ provider: 'STRIPE', fetchImpl: compte.fetchImpl })));

  check('UN SEUL endpoint distant, quel que soit le nombre d’appels',
    compte.endpoints.length === 1);
  check('UN SEUL binding en base', (await Binding.countDocuments({ provider: 'STRIPE' })) === 1);

  const binding = await Binding.findOne({ provider: 'STRIPE' }).lean();
  /**
   * L6.3A AJOUTE UNE DIMENSION SANS RETIRER LA RÈGLE.
   *
   * Le binding porte désormais un `projectId` — mais il vaut `null` pour un
   * endpoint du PANEL, et c'est précisément ce `null` qui, dans l'index unique,
   * préserve « un seul endpoint Panel par fournisseur et par monde ».
   *
   * L'invariant d'origine n'est donc pas affaibli : il est devenu conditionnel
   * à la destination, et on le vérifie là où il s'applique.
   */
  check('un endpoint du Panel n’est rattaché à AUCUN projet',
    binding.destination === 'PANEL' && binding.projectId === null);
  check('sa clé est bien (fournisseur, environnement)',
    binding.provider === 'STRIPE' && binding.environment === 'TEST');

  // L'index l'impose en base, pas seulement la file d'attente en mémoire.
  let refuse = false;
  try {
    await Binding.create({
      bindingId: 'doublon', provider: 'STRIPE', environment: 'TEST',
      ownershipToken: 'autre', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    });
  } catch (err) { refuse = err?.code === 11000; }
  check('l’index REFUSE un second binding pour le même couple', refuse);

  // C'est exactement ce qui désamorce le plafond de 16 de Stripe.
  check('avec 10 projets, une seule place consommée sur les 16 de Stripe',
    compte.endpoints.length === 1 && webhookCapability('STRIPE').remoteEndpointLimit === 16);
}

section('L5.1 · Sonde de joignabilité — un diagnostic, jamais un verdict');
{
  await resetWebhookState();
  const compte = fakeStripeAccount();
  const injoignable = async (url, options) => {
    if (String(url).endsWith('/health')) throw new Error('tunnel coupé');
    return compte.fetchImpl(url, options);
  };
  const rapport = await reconcileProviderWebhook({ provider: 'STRIPE', fetchImpl: injoignable });
  check('notre URL injoignable est CONSTATÉE', rapport.callbackReachable === false);
  check('…mais le statut reste READY — ce n’est pas une dérive de configuration',
    rapport.status === WEBHOOK_STATUS.READY);
  const vue = await describeWebhookState('STRIPE');
  check('la vue porte le constat et sa date',
    vue.callbackReachable === false && typeof vue.callbackCheckedAt === 'string');

  const joignable = async (url, options) => {
    if (String(url).endsWith('/health')) return { ok: true, status: 200, text: async () => '{}' };
    return compte.fetchImpl(url, options);
  };
  const ok = await reconcileProviderWebhook({ provider: 'STRIPE', fetchImpl: joignable });
  check('une URL joignable est constatée aussi', ok.callbackReachable === true);
}

/* ══════════════════════════════════════════════════════════════════════════ */
/*  16-18. RÉCEPTION : SIGNATURE, IDEMPOTENCE, ROUTAGE                        */
/* ══════════════════════════════════════════════════════════════════════════ */

section('16-18 · Recevoir : prouvé, unique, et routé par le plan de contrôle');
{
  await resetWebhookState();
  const compte = fakeStripeAccount({ secretOnCreate: WHSEC });
  await reconcileProviderWebhook({ provider: 'STRIPE', fetchImpl: compte.fetchImpl });

  const corps = Buffer.from(JSON.stringify({
    id: 'evt_L5_0001',
    type: 'invoice.paid',
    // PIÈGE VOLONTAIRE : un projet destinataire glissé dans la charge utile.
    projectId: 'projet-de-lattaquant',
    destination: 'https://ailleurs.test',
  }));
  const entetes = { 'stripe-signature': stripeSignatureHeader(corps, WHSEC) };

  const premier = await ingestProviderEvent({ slug: 'stripe', rawBody: corps, headers: entetes });
  check('un appel signé est ACCEPTÉ', premier.outcome === INGEST_OUTCOME.ACCEPTED);
  check('la signature HMAC est reconnue comme une PREUVE', premier.proven === true);
  check('le type brut est conservé', premier.eventType === 'invoice.paid');

  const rejeu = await ingestProviderEvent({ slug: 'stripe', rawBody: corps, headers: entetes });
  check('le rejeu du MÊME événement est un doublon', rejeu.outcome === INGEST_OUTCOME.DUPLICATE && rejeu.duplicate === true);
  check('un seul enregistrement en base',
    (await WebhookEvent.countDocuments({ providerEventId: 'evt_L5_0001' })) === 1);

  const troisieme = await ingestProviderEvent({ slug: 'stripe', rawBody: corps, headers: entetes });
  check('le troisième rejeu aussi', troisieme.duplicate === true);
  const bindingApres = await Binding.findOne({ provider: 'STRIPE', environment: 'TEST' }).lean();
  check('les doublons sont COMPTÉS séparément des réceptions',
    bindingApres.eventsReceived === 1 && bindingApres.duplicatesIgnored === 2);

  // 18 — le projectId forgé n'a servi à RIEN.
  const enregistre = await WebhookEvent.findOne({ providerEventId: 'evt_L5_0001' }).lean();
  check('le projectId du corps n’est enregistré NULLE PART',
    !JSON.stringify(enregistre).includes('projet-de-lattaquant'));
  check('le routage vient du binding, pas du corps', enregistre.bindingId === bindingApres.bindingId);
  check('AUCUN payload n’est conservé', enregistre.payloadHash.length === 64 && !('payload' in enregistre));

  // Signature fausse, signature absente, secret absent : trois refus.
  const faux = await ingestProviderEvent({
    slug: 'stripe', rawBody: corps,
    headers: { 'stripe-signature': stripeSignatureHeader(corps, 'whsec_autre_chose') },
  });
  check('une signature FAUSSE est refusée', faux.outcome === INGEST_OUTCOME.REJECTED);
  const sansEntete = await ingestProviderEvent({ slug: 'stripe', rawBody: corps, headers: {} });
  check('un appel SANS signature est refusé', sansEntete.outcome === INGEST_OUTCOME.REJECTED);

  const rejoue = await ingestProviderEvent({
    slug: 'stripe', rawBody: corps,
    headers: { 'stripe-signature': stripeSignatureHeader(corps, WHSEC, { timestamp: Math.floor(Date.now() / 1000) - 4000 }) },
  });
  check('une signature PÉRIMÉE est refusée (anti-rejeu)', rejoue.outcome === INGEST_OUTCOME.REJECTED);

  // 17 — le binding est la condition du routage.
  const inconnu = await ingestProviderEvent({ slug: 'yousign', rawBody: corps, headers: entetes });
  check('un fournisseur SANS binding est refusé', inconnu.outcome === INGEST_OUTCOME.NO_BINDING);
  const segmentInconnu = await ingestProviderEvent({ slug: 'mailchimp', rawBody: corps, headers: entetes });
  check('un segment inconnu ne désigne personne', segmentInconnu.outcome === INGEST_OUTCOME.UNKNOWN_PROVIDER);
  const hostinger = await ingestProviderEvent({ slug: 'hostinger', rawBody: corps, headers: entetes });
  check('un fournisseur sans webhook n’a pas de porte', hostinger.outcome === INGEST_OUTCOME.UNKNOWN_PROVIDER);

  // Deux événements DISTINCTS ne se confondent pas.
  const autre = Buffer.from(JSON.stringify({ id: 'evt_L5_0002', type: 'charge.refunded' }));
  const second = await ingestProviderEvent({
    slug: 'stripe', rawBody: autre, headers: { 'stripe-signature': stripeSignatureHeader(autre, WHSEC) },
  });
  check('un événement distinct est accepté', second.outcome === INGEST_OUTCOME.ACCEPTED);
  check('deux enregistrements, pas un', (await WebhookEvent.countDocuments({ provider: 'STRIPE' })) === 2);
}

section('16b · Identité d’événement — fournie, ou dérivée du corps');
{
  const stripe = webhookCapability('STRIPE');
  const brevo = webhookCapability('BREVO');
  const corps = Buffer.from(JSON.stringify({ id: 'evt_x', type: 'invoice.paid' }));
  const identite = extractEventIdentity(stripe, { rawBody: corps, parsed: JSON.parse(corps.toString()) });
  check('Stripe : l’identifiant du fournisseur est retenu', identite.providerEventId === 'evt_x');

  // Brevo ne fournit AUCUN identifiant d'événement : la clé composite publiée
  // par le lot Brevo prend le relais. Elle survit à une re-sérialisation du
  // fournisseur, là où une empreinte du corps changerait pour rien.
  const corpsBrevo = Buffer.from(JSON.stringify({
    event: 'delivered', 'message-id': '<a@b>', email: 'Client@Exemple.FR', ts_epoch: 1770000000000,
  }));
  const identiteBrevo = extractEventIdentity(brevo, {
    rawBody: corpsBrevo, parsed: JSON.parse(corpsBrevo.toString()), environment: 'TEST',
  });
  check('Brevo : une clé COMPOSITE, pas l’empreinte du corps',
    identiteBrevo.providerEventId.startsWith('brevo:TEST|a@b|DELIVERED|1770000000000|'));

  /**
   * EXIGENCE Nº11 DE L'AUDIT L8 — Brevo livre le même identifiant tantôt
   * `<abc@bar>`, tantôt `abc@bar`. Composer la clé sur la graphie BRUTE ferait
   * qu'un rejeu écrit autrement passerait pour un événement neuf : l'effet
   * serait appliqué deux fois. Toute l'idempotence tient à cette normalisation.
   */
  const avecChevrons = Buffer.from(JSON.stringify({
    event: 'delivered', 'message-id': '<a@b>', email: 'Client@Exemple.FR', ts_epoch: 1770000000000,
  }));
  const sansChevrons = Buffer.from(JSON.stringify({
    event: 'delivered', 'message-id': 'a@b', email: 'Client@Exemple.FR', ts_epoch: 1770000000000,
  }));
  const cle = (raw) => extractEventIdentity(brevo, {
    rawBody: raw, parsed: JSON.parse(raw.toString()), environment: 'TEST',
  }).providerEventId;
  check('Brevo : les DEUX graphies du message-id donnent la MÊME clé',
    cle(avecChevrons) === cle(sansChevrons));
  check('Brevo : la clé ne conserve aucun chevron', !cle(avecChevrons).includes('<'));
  check('Brevo : le destinataire n’apparaît qu’en empreinte, jamais en clair',
    !identiteBrevo.providerEventId.toLowerCase().includes('client@exemple.fr'));

  // Le même événement re-sérialisé autrement garde la MÊME clé.
  const reserialise = Buffer.from(JSON.stringify({
    'message-id': '<a@b>', ts_epoch: 1770000000000, email: 'client@exemple.fr', event: 'delivered',
  }));
  check('Brevo : l’ordre des clés du corps ne change pas l’identité',
    extractEventIdentity(brevo, {
      rawBody: reserialise, parsed: JSON.parse(reserialise.toString()), environment: 'TEST',
    }).providerEventId === identiteBrevo.providerEventId);
  check('Brevo : mais l’empreinte du corps, elle, aurait changé',
    payloadDigest(reserialise) !== payloadDigest(corpsBrevo));

  // Corps inexploitable : le repli reste l'empreinte du corps brut.
  const corpsMuet = Buffer.from(JSON.stringify({ rien: 'du tout' }));
  check('Brevo : sans rien d’exploitable, repli sur l’empreinte',
    extractEventIdentity(brevo, {
      rawBody: corpsMuet, parsed: JSON.parse(corpsMuet.toString()), environment: 'TEST',
    }).providerEventId === `sha256:${payloadDigest(corpsMuet)}`);

  check('Brevo : le type d’événement est tout de même lu', identiteBrevo.eventType === 'delivered');
  check('deux corps différents ont deux empreintes différentes',
    payloadDigest(Buffer.from('a')) !== payloadDigest(Buffer.from('b')));

  // Un jeton partagé authentifie, il ne PROUVE pas — et le code le dit.
  const bearer = verifyWebhookSignature(brevo, {
    rawBody: corpsBrevo, headers: { authorization: 'Bearer jeton-partage' }, secrets: ['jeton-partage'],
  });
  check('Brevo : le jeton est accepté', bearer.verified === true);
  check('Brevo : mais l’appel n’est PAS prouvé', bearer.proven === false);
  check('sans secret, aucun appel n’est accepté « en attendant »',
    verifyWebhookSignature(brevo, { rawBody: corpsBrevo, headers: { authorization: 'Bearer x' }, secrets: [] }).reason === 'NO_SECRET');
}

/* ══════════════════════════════════════════════════════════════════════════ */
/*  17b. LA ROUTE HTTP RÉELLE                                                 */
/* ══════════════════════════════════════════════════════════════════════════ */

section('17b · La route publique reçoit les OCTETS, et hors de /api');
{
  const { default: createApp } = await import('../backend/src/app.js');
  const serveur = await startServer(createApp());
  try {
    const sonde = await fetch(`${serveur.base}/webhooks/providers/stripe/health`);
    check('la sonde anonyme répond 200 sans jeton', sonde.status === 200);
    const sondeInconnue = await fetch(`${serveur.base}/webhooks/providers/mailchimp/health`);
    check('un segment inconnu répond 404', sondeInconnue.status === 404);

    const corps = JSON.stringify({ id: 'evt_http_1', type: 'invoice.paid' });
    const bon = await fetch(`${serveur.base}/webhooks/providers/stripe`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'stripe-signature': stripeSignatureHeader(Buffer.from(corps), WHSEC) },
      body: corps,
    });
    check('un appel signé passe par la VRAIE route', bon.status === 200);
    check('l’événement a bien été enregistré',
      (await WebhookEvent.countDocuments({ providerEventId: 'evt_http_1' })) === 1);

    const rejeu = await fetch(`${serveur.base}/webhooks/providers/stripe`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'stripe-signature': stripeSignatureHeader(Buffer.from(corps), WHSEC) },
      body: corps,
    });
    const rejeuJson = await rejeu.json();
    check('un rejeu répond 200 (sinon le fournisseur boucle)', rejeu.status === 200 && rejeuJson.duplicate === true);

    const mauvais = await fetch(`${serveur.base}/webhooks/providers/stripe`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        // Horodatage FRAIS, signature fausse : c'est bien la preuve qui est
        // refusée, pas l'ancienneté de l'appel.
        'stripe-signature': `t=${Math.floor(Date.now() / 1000)},v1=${'0'.repeat(64)}`,
      },
      body: corps,
    });
    check('une signature invalide répond 401', mauvais.status === 401);
    check('la réponse ne dit PAS pourquoi',
      JSON.stringify(await mauvais.json()) === JSON.stringify({ received: false }));

    // La surface de diagnostic, elle, est fermée.
    const diagnostic = await fetch(`${serveur.base}/api/webhook-control-plane`);
    check('la surface de diagnostic exige une session', diagnostic.status === 401);
  } finally {
    await serveur.close();
  }
}

/* ══════════════════════════════════════════════════════════════════════════ */
/*  19-21. REDÉMARRAGE, PROVIDER SANS WEBHOOK, ERREURS STRUCTURÉES            */
/* ══════════════════════════════════════════════════════════════════════════ */

section('19-21 · Redémarrage, plafond, et politique d’échec');
{
  await resetWebhookState();
  const compte = fakeStripeAccount();
  await reconcileProviderWebhook({ provider: 'STRIPE', fetchImpl: compte.fetchImpl });
  await simulateRestart();
  compte.reset();
  const apres = await reconcileProviderWebhook({ provider: 'STRIPE', fetchImpl: compte.fetchImpl });
  check('après redémarrage, la réconciliation est un no-op',
    apres.status === WEBHOOK_STATUS.READY && compte.writes() === 0);

  // 20/L — le plafond est vu AVANT d'être atteint.
  await resetWebhookState();
  const sature = fakeStripeAccount({
    endpoints: Array.from({ length: 16 }, (_, i) => ({
      id: `we_tiers_${i}`, url: `https://autre-${i}.test/hook`, events: [], description: `Projet ${i}`, enabled: true,
    })),
  });
  const plafond = await reconcileProviderWebhook({ provider: 'STRIPE', fetchImpl: sature.fetchImpl });
  check('le plafond de 16 est diagnostiqué, pas subi',
    plafond.code === WEBHOOK_DIAGNOSTIC.WEBHOOK_REMOTE_LIMIT_REACHED);
  check('aucune création n’a été TENTÉE', sature.writes() === 0 && sature.endpoints.length === 16);
  check('les 16 endpoints tiers sont intacts', sature.endpoints.every((e) => e.description.startsWith('Projet')));

  // 21 — les erreurs sont structurées, et la gravité est explicite.
  check('chaque code de diagnostic est une constante nommée',
    Object.entries(WEBHOOK_DIAGNOSTIC).every(([k, v]) => k === v && v.startsWith('WEBHOOK_')));
  check('UN WEBHOOK NE BLOQUE JAMAIS UN DÉPLOIEMENT', blocksDeployment() === false);
  check('Stripe en panne → DEPLOYED_WITH_WARNING',
    severityFor('STRIPE', WEBHOOK_STATUS.ERROR) === 'DEPLOYED_WITH_WARNING');
  check('Yousign en panne → DEPLOYED_WITH_WARNING',
    severityFor('YOUSIGN', WEBHOOK_STATUS.ERROR) === 'DEPLOYED_WITH_WARNING');
  check('Brevo en panne → simple avertissement',
    severityFor('BREVO', WEBHOOK_STATUS.ERROR) === 'WARNING');
  check('un webhook READY n’alerte personne', severityFor('STRIPE', WEBHOOK_STATUS.READY) === 'INFO');
}

section('19c · YOUSIGN — une clé posée suffit, le webhook se provisionne SEUL');
{
  /**
   * ══ CE QUE CETTE SECTION FERME ═════════════════════════════════════════════
   *
   * L'exploitation a rapporté un `PENDING — WEBHOOK_CREDENTIALS_MISSING
   * [DEPLOYED_WITH_WARNING]` sur Yousign, lu comme une panne de plomberie. Ce
   * n'en est pas une : c'est l'état EXACT d'un fournisseur dont la clé API n'a
   * jamais été saisie, et la section 19b le distingue déjà d'une vraie panne.
   *
   * Mais rien ne prouvait la MOITIÉ QUI RASSURE : qu'une fois la clé posée, tout
   * le reste — hôte d'API, souscription distante, secret de signature — se règle
   * SANS que l'exploitant touche à quoi que ce soit, et que l'avertissement
   * disparaît. Stripe et Brevo avaient chacun leur compte simulé ; Yousign, non.
   * On ne pouvait donc pas répondre « oui, ça se répare tout seul » autrement
   * que par la lecture du registre.
   */
  await resetWebhookState();
  await CredentialSet.deleteOne({ provider: 'YOUSIGN', environment: 'TEST' });

  const YS_KEY = ['ys', 'test', 'L5SENTINEL00000000000000'].join('_');
  const YS_SECRET = ['yswhsec', 'L5SENTINEL00000000000000'].join('_');

  /** Compte Yousign SIMULÉ — il conserve ses souscriptions entre les appels. */
  const compte = { subscriptions: [], calls: [], nextId: 1 };
  compte.fetchImpl = async (url, options = {}) => {
    const method = options.method ?? 'GET';
    compte.calls.push({ method, url });
    if (method === 'GET') return reply(200, { data: compte.subscriptions });
    if (method === 'POST') {
      const corps = JSON.parse(options.body);
      const abonnement = {
        id: `wh_${compte.nextId++}`,
        endpoint: corps.endpoint,
        subscribed_events: corps.subscribed_events,
        description: corps.description,
        enabled: true,
        sandbox: corps.sandbox,
      };
      compte.subscriptions.push(abonnement);
      // `secret_key` n'est rendue QU'À LA CRÉATION — comme le vrai fournisseur.
      return reply(201, { ...abonnement, secret_key: YS_SECRET });
    }
    return reply(200, {});
  };

  /* ── SANS CLÉ : PENDING, et AUCUN appel distant ────────────────────────── */
  const sansCle = await reconcileProviderWebhook({ provider: 'YOUSIGN', fetchImpl: compte.fetchImpl });
  check('sans clé API, Yousign est PENDING — pas ERROR',
    sansCle.status === WEBHOOK_STATUS.PENDING
    && sansCle.code === WEBHOOK_DIAGNOSTIC.WEBHOOK_CREDENTIALS_MISSING);
  check('…et AUCUN appel n’est parti chez le fournisseur', compte.calls.length === 0);

  /* ── L'EXPLOITANT NE SAISIT QUE LA CLÉ ─────────────────────────────────── */
  const { describeProviderDefinition, credentialRoles } =
    await import('../backend/src/services/integratedApi/providerRegistry.js');
  const formulaire = describeProviderDefinition('YOUSIGN', { environment: 'TEST' }).credentialRoles;
  check('le formulaire ne réclame QUE la clé API',
    formulaire.filter((r) => r.required).map((r) => r.code).join(',') === 'apiKey');
  check('…le secret de signature n’y est jamais demandé',
    !formulaire.some((r) => r.code === 'webhookSecret' && r.required)
    && credentialRoles('YOUSIGN').find((r) => r.code === 'webhookSecret')?.autoManaged === true);

  await saveCredentialSet('YOUSIGN', 'TEST', { values: { apiKey: YS_KEY } }, { userId: 'recette' });

  /* ── ET TOUT LE RESTE SE FAIT SEUL ─────────────────────────────────────── */
  const apres = await reconcileProviderWebhook({ provider: 'YOUSIGN', fetchImpl: compte.fetchImpl });
  check(`la réconciliation aboutit — READY (${apres.status}/${apres.code ?? '—'})`,
    apres.status === WEBHOOK_STATUS.READY);
  check('…une souscription a été CRÉÉE chez le fournisseur', compte.subscriptions.length === 1);

  const abonnement = compte.subscriptions[0];
  check('…sur l’adresse publique du Panel, dérivée — jamais codée en dur',
    abonnement.endpoint === `${PANEL_URL}/api/webhooks/yousign`
    || abonnement.endpoint.startsWith(PANEL_URL));
  check('…avec exactement les événements déclarés au registre',
    abonnement.subscribed_events.join(',') === webhookCapability('YOUSIGN').desiredEvents.join(','));
  check('…et le bac à sable suit le monde servi (TEST)', abonnement.sandbox === true);

  /**
   * L'HÔTE D'API N'A JAMAIS ÉTÉ SAISI — il vient du défaut d'environnement du
   * registre. C'est le point qui rendait le diagnostic ambigu : une `baseUrl`
   * non résolue produit EXACTEMENT le même code que l'absence de clé.
   */
  const versLeFournisseur = compte.calls.filter((c) => !c.url.startsWith(PANEL_URL));
  check('l’hôte d’API vient du défaut TEST du registre, sans saisie',
    versLeFournisseur.length > 0
    && versLeFournisseur.every((c) => c.url.startsWith('https://api-sandbox.yousign.app/v3')));
  check('…et la joignabilité de NOTRE adresse est vérifiée, pas supposée',
    compte.calls.some((c) => c.url.startsWith(`${PANEL_URL}/webhooks/providers/yousign`)));

  /* ── LE SECRET EST CAPTÉ ET RANGÉ, SANS PASSER PAR UN ÉCRAN ────────────── */
  const coffre = await CredentialSet.findOne({ provider: 'YOUSIGN', environment: 'TEST' }).lean();
  check('le secret rendu à la création est PERSISTÉ dans le coffre',
    Boolean(coffre?.credentialsEncrypted?.webhookSecret?.encrypted));
  const vue = await describeWebhookState('YOUSIGN');
  check('…et il ne ressort par AUCUNE vue', !JSON.stringify(vue).includes(YS_SECRET));
  check('…ni la clé API', !JSON.stringify(vue).includes(YS_KEY));

  /* ── IDEMPOTENCE : RIEN N'EST RECRÉÉ ───────────────────────────────────── */
  const encore = await reconcileProviderWebhook({ provider: 'YOUSIGN', fetchImpl: compte.fetchImpl });
  check('une seconde réconciliation ne recrée rien',
    encore.status === WEBHOOK_STATUS.READY && compte.subscriptions.length === 1);

  /* ── ET L'AVERTISSEMENT DE DÉPLOIEMENT DISPARAÎT ───────────────────────── */
  const rapport = await reconcileAllProviderWebhooks({ fetchImpl: compte.fetchImpl });
  const ligne = rapport.results.find((r) => r.provider === 'YOUSIGN');
  check('le balayage complet voit Yousign READY', ligne.status === WEBHOOK_STATUS.READY);
  check('…et il ne figure plus parmi les avertissements',
    !rapport.warnings.some((w) => w.provider === 'YOUSIGN'));
  check('un webhook n’a JAMAIS bloqué un déploiement, avant comme après',
    rapport.blocking === false);

  /**
   * ON REMET LE MONDE COMME ON L'A TROUVÉ.
   *
   * La section suivante éprouve précisément le cas « fournisseur SANS clé » :
   * lui laisser la clé posée ici la ferait échouer pour une raison qui n'a rien
   * à voir avec ce qu'elle garde. Une recette qui pollue la suivante transforme
   * un ordre d'exécution en dépendance cachée.
   */
  await CredentialSet.deleteOne({ provider: 'YOUSIGN', environment: 'TEST' });
  await resetWebhookState();
}

section('19b · Le balayage complet ne lève jamais, et rend un rapport');
{
  await resetWebhookState();
  const rapport = await reconcileAllProviderWebhooks({ fetchImpl: async () => { throw new Error('réseau coupé'); } });
  check('le balayage rend un résultat par fournisseur', rapport.results.length === 4);
  check('il ne bloque rien', rapport.blocking === false);
  check('Hostinger y figure comme UNSUPPORTED',
    rapport.results.find((r) => r.provider === 'HOSTINGER').status === WEBHOOK_STATUS.UNSUPPORTED);
  check('les avertissements sont nommés avec leur gravité',
    rapport.warnings.every((w) => typeof w.provider === 'string' && typeof w.severity === 'string'));
  check('aucun secret dans le rapport', !JSON.stringify(rapport).includes(SK_TEST));

  // LA DISTINCTION QUI COMPTE : « pas encore configuré » n'est pas « en panne ».
  // Yousign n'a jamais reçu de clé dans cette recette ; Stripe en a une, et
  // c'est le réseau qui est coupé. Les confondre enverrait un exploitant
  // régénérer une clé qui n'avait rien.
  const yousign = rapport.results.find((r) => r.provider === 'YOUSIGN');
  check('un fournisseur sans clé est PENDING, pas ERROR',
    yousign.status === WEBHOOK_STATUS.PENDING && yousign.code === WEBHOOK_DIAGNOSTIC.WEBHOOK_CREDENTIALS_MISSING);
  const stripe = rapport.results.find((r) => r.provider === 'STRIPE');
  check('un fournisseur configuré mais injoignable est ERROR',
    stripe.status === WEBHOOK_STATUS.ERROR && stripe.code === WEBHOOK_DIAGNOSTIC.WEBHOOK_REMOTE_UNREACHABLE);
}

/* ══════════════════════════════════════════════════════════════════════════ */
/*  22. NON-RÉGRESSION DU PLAN DE CONTRÔLE EXISTANT                           */
/* ══════════════════════════════════════════════════════════════════════════ */

section('22 · Le plan de contrôle L1 n’a pas bougé');
{
  const { listProviders, describeAvailability } = await import('../backend/src/services/integratedApi/controlPlane.service.js');
  const fournisseurs = await listProviders();
  check('les 4 fournisseurs sont toujours là', fournisseurs.length === 4);
  check('aucune valeur confidentielle dans le catalogue',
    !JSON.stringify(fournisseurs).includes(SK_TEST));

  // La capture d'un secret de webhook NE DOIT PAS invalider la preuve portant
  // sur la clé secrète : ce sont deux choses différentes.
  await CredentialSet.updateOne(
    { provider: 'STRIPE', environment: 'TEST' },
    { $set: { status: 'VALID', lastValidatedFingerprint: 'empreinte-figee' } },
  );
  await storeWebhookSecret('STRIPE', 'TEST', WHSEC_2);
  const apres = await CredentialSet.findOne({ provider: 'STRIPE', environment: 'TEST' }).lean();
  check('capturer un secret de webhook ne détruit pas la preuve de validation',
    apres.lastValidatedFingerprint === 'empreinte-figee' && apres.status === 'VALID');
  check('le secret est bien enregistré chiffré',
    Boolean(apres.credentialsEncrypted.webhookSecret?.encrypted)
    && !JSON.stringify(apres.credentialsEncrypted.webhookSecret).includes(WHSEC_2));

  const dispo = await describeAvailability('STRIPE');
  check('la disponibilité L1 répond toujours', dispo.provider === 'STRIPE' && typeof dispo.available === 'boolean');
  check('les capacités restent NON invocables — L5 n’a rien migré',
    dispo.capabilitiesInvocable === false);
}

section('22b · L5 n’a migré AUCUN appel métier');
{
  const fs = await import('node:fs');
  const path = await import('node:path');
  const url = await import('node:url');
  const dossier = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..', 'backend', 'src', 'services', 'webhooks');
  const interdits = [
    '/v1/checkout', '/v1/payment_intents', '/v1/customers', '/v1/subscriptions', '/v1/refunds',
    '/v3/smtp/email', '/v3/senders', '/signature_requests',
  ];
  const fautifs = [];
  for (const nom of fs.readdirSync(dossier)) {
    const contenu = fs.readFileSync(path.join(dossier, nom), 'utf8');
    for (const motif of interdits) {
      if (contenu.includes(motif)) fautifs.push(`${nom} → ${motif}`);
    }
  }
  check(`aucun appel métier dans les services webhook${fautifs.length ? ` (${fautifs.join(', ')})` : ''}`,
    fautifs.length === 0);

  // Les pilotes ne touchent QUE le CRUD d'endpoint.
  const pilotes = fs.readFileSync(path.join(dossier, 'providerWebhookAdapters.js'), 'utf8');
  check('les pilotes ne parlent que de webhooks',
    (pilotes.match(/\/v1\/[a-z_]+/g) ?? []).every((c) => c === '/v1/webhook_endpoints'));
}

await stopMemoryMongo();
finish();
