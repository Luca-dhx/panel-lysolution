// LE PANEL PROVISIONNE, LE PROJET REÇOIT — l'E2E du lot (L6.3A).
//
// ══ CE QUE CE LOT DÉPLACE, ET CE QU'IL NE DÉPLACE PAS ═══════════════════════
//
// SB Auto enregistrait lui-même son endpoint chez Stripe : `POST
// /v1/webhook_endpoints`, avec SA clé secrète, à chaque démarrage et à chaque
// changement de tunnel. C'était le dernier geste qui rendait cette clé
// indispensable — donc le dernier verrou empêchant de la retirer.
//
// Le Panel le fait désormais, avec SA clé. Mais l'endpoint continue de pointer
// vers le projet, et c'est toujours le projet qui vérifie les signatures : le
// Panel ne relaie pas les événements Stripe métier, et prétendre le contraire
// couperait la réception.
//
// ══ LE POINT DÉLICAT : UN SECRET DESCEND ════════════════════════════════════
//
// Stripe ne rend le secret de signature QU'À LA CRÉATION. Le Panel le capture,
// et doit le transmettre au projet — alors que la frontière L4 interdit à tout
// identifiant fournisseur de franchir le pont.
//
// La réponse n'est pas une exception : c'est une PORTE ÉTROITE. Un `whsec_` ne
// permet aucun appel sortant — il ne sait que constater qu'un message reçu
// vient bien de Stripe. Le canal qui le transporte n'accepte qu'un champ, dont
// le rôle est déclaré « vérification seule » au registre, et dont la valeur a
// la forme attendue. Le mur reste intact ; on y a percé une serrure dont on
// connaît exactement la clé.
import http from 'node:http';
import { createHmac } from 'node:crypto';

import {
  check, connectTestDatabase, finish, section, setTestEnv,
  startMemoryMongo, startServer,
} from './helpers/harness.js';
import { startSbAutoInstance } from './helpers/sbauto-remote.js';
import { forme } from './helpers/secretShapes.js';

setTestEnv();
const MONGO_URI = await startMemoryMongo();
await connectTestDatabase();

/** Composé à l'exécution : une chaîne de cette forme est un secret aux yeux du dépôt. */
const prefixe = (monde) => ['sk', monde, ''].join('_');
const CLE_PANEL = `${prefixe('test')}L63ASENTINELLEPANEL00000000001`;
const CLE_PANEL_PROD = `${prefixe('live')}L63ASENTINELLEPANELPROD0000002`;
/** Celle que le projet détient encore — elle ne doit JAMAIS servir au provisioning. */
const CLE_PROJET = `${prefixe('test')}L63ASENTINELLEPROJETJAMAISVUE3`;

const ACTEUR = { userId: 'u-dev', userEmail: 'dev@panel.test' };
const ENSURE = 'webhook.endpoint.ensure';

/* ══════════════════════════════════════════════════════════════════════════
   UN FAUX STRIPE QUI COMPTE SES ENDPOINTS.

   La propriété qui donne sa valeur à tout le fichier : `secret` n'est rendu
   QU'À LA CRÉATION, exactement comme le vrai. Un endpoint retrouvé plus tard
   ne le redonne pas — c'est ce qui rend la stratégie de rotation nécessaire.
   ══════════════════════════════════════════════════════════════════════════ */
const appels = [];
const endpoints = new Map();
let sequence = 0;

const lireCorps = (req) => new Promise((resolve) => {
  let brut = '';
  req.on('data', (c) => { brut += c; });
  req.on('end', () => resolve(brut));
});

const fauxStripe = http.createServer(async (req, res) => {
  const auth = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
  const corps = req.method !== 'GET' ? await lireCorps(req) : '';
  appels.push({ method: req.method, url: req.url, auth, corps });

  const repondre = (code, objet) => {
    res.writeHead(code, { 'content-type': 'application/json' });
    res.end(JSON.stringify(objet));
  };

  if (req.url === '/v1/account') return repondre(200, { id: 'acct_panel', country: 'FR' });

  const cible = /^\/v1\/webhook_endpoints(?:\/([^/?]+))?/.exec(req.url ?? '');
  if (!cible) return repondre(404, { error: { message: 'route inconnue' } });
  const id = cible[1];
  const params = new URLSearchParams(corps);
  const evenements = () => [...params.keys()]
    .filter((k) => k.startsWith('enabled_events['))
    .map((k) => params.get(k));

  if (req.method === 'GET' && !id) {
    // La liste NE REND JAMAIS le secret — comme chez le vrai Stripe.
    return repondre(200, {
      data: [...endpoints.values()].map(({ secret, ...reste }) => reste),
    });
  }

  if (req.method === 'POST' && !id) {
    sequence += 1;
    const we = `we_test_${sequence}`;
    const objet = {
      id: we,
      url: params.get('url'),
      description: params.get('description') ?? '',
      enabled_events: evenements(),
      status: 'enabled',
      metadata: { managedBy: params.get('metadata[managedBy]') ?? '' },
      /** Rendu une seule fois, à cet instant précis. */
      secret: `whsec_${we}_signature_de_test`,
    };
    endpoints.set(we, objet);
    return repondre(200, objet);
  }

  if (req.method === 'POST' && id) {
    const objet = endpoints.get(id);
    if (!objet) return repondre(404, { error: { message: 'No such webhook endpoint' } });
    objet.url = params.get('url') ?? objet.url;
    objet.description = params.get('description') ?? objet.description;
    const evts = evenements();
    if (evts.length) objet.enabled_events = evts;
    const { secret, ...sansSecret } = objet;
    return repondre(200, sansSecret);
  }

  if (req.method === 'DELETE' && id) {
    endpoints.delete(id);
    return repondre(200, { id, deleted: true });
  }

  return repondre(404, { error: { message: 'route inconnue' } });
});

const creations = () => appels.filter((a) => a.method === 'POST' && a.url === '/v1/webhook_endpoints');
/**
 * Les créations D'ENDPOINT DE PROJET — voir `endpointsProjet`. Le plan de
 * contrôle enregistre aussi l'endpoint du PANEL, qui n'appartient à aucun
 * projet et n'a donc rien à faire dans un compte de prolifération par projet.
 */
const creationsProjet = () => creations()
  .filter((a) => !String(a.corps ?? '').includes('panel-l63a.test'));
const suppressions = () => appels.filter((a) => a.method === 'DELETE');

await new Promise((resolve) => fauxStripe.listen(0, '127.0.0.1', resolve));
const STRIPE_BASE = `http://127.0.0.1:${fauxStripe.address().port}`;

/* ══════════════════════════════════════════════════════════════════════════ */
const { createApp } = await import('../backend/src/app.js');
const registre = await import('../backend/src/services/registry/projectRegistry.service.js');
const controlPlane = await import('../backend/src/services/integratedApi/controlPlane.service.js');
const { seedIntegratedApiCredentialSets } = await import('../backend/src/services/integratedApi/seed.js');
const { resetSyncCore } = await import('../backend/src/services/sync/syncCore.service.js');
const { updateNetworkConfiguration } = await import('../backend/src/services/network/networkConfig.service.js');
const { default: Binding, WEBHOOK_DESTINATION } = await import('../backend/src/models/PanelIntegratedApiWebhookBinding.model.js');
const secrets = await import('../backend/src/services/webhooks/projectWebhookSecrets.js');
const { assertVerificationSecretOnly } = await import('../backend/src/bridge/providerSecretGuard.js');
const { assertNoProviderSecrets } = await import('../backend/src/bridge/providerSecretGuard.js');

await resetSyncCore();
await seedIntegratedApiCredentialSets();
await updateNetworkConfiguration({ backendUrl: 'https://panel-l63a.test' }, { requirePublic: false });

/**
 * LES ENDPOINTS DE PROJET — le Panel a désormais LE SIEN, et il ne compte pas.
 *
 * ══ POURQUOI CE FILTRE EXISTE ═══════════════════════════════════════════════
 *
 * Cette suite comptait `endpoints.size` : à l'époque, tout endpoint chez le
 * fournisseur appartenait forcément à un projet. Depuis, le plan de contrôle
 * enregistre l'endpoint DU PANEL — celui qui reçoit les faits de facturation
 * pour la plateforme elle-même. Le compte brut vaut donc un de plus, et la
 * suite lisait « deux endpoints » là où il n'y a jamais eu qu'un projet.
 *
 * Compter les endpoints de PROJET dit exactement ce que la suite veut dire, et
 * continue de le dire le jour où la plateforme en enregistrera un troisième
 * pour son propre compte.
 */
const endpointsProjet = () => [...endpoints.values()]
  .filter((e) => !String(e.url ?? '').includes('panel-l63a.test'));

const { base: panelUrl } = await startServer(createApp());

section('1. Le coffre — la clé du Panel, dans deux mondes');
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
  mongoUri: MONGO_URI, dbName: 'sbauto_l63a_a', env: 'TEST', projectName: 'SB Auto L6.3A A',
});
const projetB = await startSbAutoInstance({
  mongoUri: MONGO_URI, dbName: 'sbauto_l63a_b', env: 'TEST', projectName: 'SB Auto L6.3A B',
});

let idA;
let idB;

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

section('2. Deux projets, ouverts et accordés');
{
  idA = await appairer(projetA);
  idB = await appairer(projetB);
  /**
   * Le projet doit avoir son catalogue local pour pouvoir RANGER le secret
   * qu'il recevra. C'est la graine que `bootstrap()` pose en production.
   */
  await projetA.seedIntegratedApis();
  await projetB.seedIntegratedApis();
  for (const id of [idA, idB]) {
  }
  check('deux projets distincts', typeof idA === 'string' && idA !== idB);
}

/* ══════════════════════════════════════════════════════════════════════════
   SCÉNARIO A — projet sans endpoint → ENSURE → création + secret → webhook signé
   ══════════════════════════════════════════════════════════════════════════ */
const URL_A1 = 'https://projet-a-tunnel-un.test';
let secretA = null;
section('A. Aucun endpoint : le Panel le crée, le projet reçoit son secret');
{
  const avant = creations().length;
  const r = await projetA.ensureStripeWebhook({ mode: 'TEST', publicBackendUrl: URL_A1 });

  check('la demande aboutit', r.ok === true);
  check('…un endpoint a été créé', r.data.created === true);
  check('…et il porte un identifiant Stripe', /^we_/.test(r.data.endpointId ?? ''));
  check('UNE création émise', creations().length === avant + 1);
  check('la clé partie est celle du COFFRE du Panel', appels.at(-1).auth === CLE_PANEL);

  /**
   * L'ENDPOINT POINTE VERS LE PROJET, PAS VERS LE PANEL. C'est l'invariant qui
   * distingue ce lot d'une simple centralisation : sans lui, le réconciliateur
   * aurait « corrigé » l'adresse vers le Panel et coupé net la réception.
   */
  const cree = [...endpoints.values()].at(-1);
  check('…et son adresse est celle du PROJET', cree.url === `${URL_A1}/api/webhooks/stripe`);
  check('…jamais celle du Panel', !cree.url.includes('panel-l63a.test'));

  const lien = await Binding.findOne({ provider: 'STRIPE', destination: 'PROJECT', projectId: idA }).lean();
  check('le lien est rattaché au projet', lien?.projectId === idA);
  check('…et marqué comme destiné au PROJET', lien?.destination === WEBHOOK_DESTINATION.PROJECT);

  /** LE SECRET N'EST PAS DANS LE RÉSULTAT — la garde L4 le refuserait. */
  check('le résultat ne contient AUCUN secret', (() => {
    try { assertNoProviderSecrets(r.data, { label: 'ensure' }); return true; } catch { return false; }
  })());

  const range = await secrets.readProjectVerificationSecret({
    projectId: idA, provider: 'STRIPE', environment: 'TEST',
  });
  secretA = range?.secret ?? null;
  check('le Panel a rangé le secret pour CE projet', typeof secretA === 'string' && secretA.startsWith('whsec_'));

  /**
   * ET LE PROJET L'A RAPATRIÉ : c'est ce qui prouve que la porte étroite
   * fonctionne de bout en bout, et non seulement côté Panel.
   */
  check('le projet a rapatrié un secret', r.data.secretRefreshed === true);
  const local = await projetA.readCredential({ provider: 'STRIPE', field: 'webhookSecret', mode: 'TEST' });
  check('…et c’est EXACTEMENT celui que le Panel a rangé', local === secretA);
}

/* ══════════════════════════════════════════════════════════════════════════
   SCÉNARIO B — redémarrage : aucun second endpoint
   ══════════════════════════════════════════════════════════════════════════ */
section('B. Redémarrage : la même demande ne crée rien de plus');
{
  const avant = creations().length;
  const r = await projetA.ensureStripeWebhook({ mode: 'TEST', publicBackendUrl: URL_A1 });
  check('la demande aboutit', r.ok === true);
  check('…et ne crée RIEN', r.data.created === false);
  check('AUCUNE création supplémentaire', creations().length === avant);
  check('un seul endpoint de PROJET chez le fournisseur', endpointsProjet().length === 1);

  const apres = await secrets.readProjectVerificationSecret({
    projectId: idA, provider: 'STRIPE', environment: 'TEST',
  });
  check('…et le secret n’a pas changé', apres?.secret === secretA);
}

/* ══════════════════════════════════════════════════════════════════════════
   SCÉNARIO C — huit demandes simultanées
   ══════════════════════════════════════════════════════════════════════════ */
section('C. Huit demandes simultanées : un seul endpoint logique');
{
  const avant = creations().length;
  const resultats = await Promise.all(Array.from({ length: 8 }, () =>
    projetA.ensureStripeWebhook({ mode: 'TEST', publicBackendUrl: URL_A1 })));

  check('toutes aboutissent ou se refusent proprement',
    resultats.every((r) => r.ok || typeof r.code === 'string'));
  check('AUCUNE création supplémentaire', creations().length === avant);
  check('toujours un seul endpoint de projet', endpointsProjet().length === 1);
  check('…et un seul lien en base',
    (await Binding.countDocuments({ provider: 'STRIPE', destination: 'PROJECT', projectId: idA })) === 1);
}

/* ══════════════════════════════════════════════════════════════════════════
   SCÉNARIO D — le tunnel change d'adresse
   ══════════════════════════════════════════════════════════════════════════ */
const URL_A2 = 'https://projet-a-tunnel-deux.test';
section('D. L’adresse change : convergence, sans prolifération');
{
  const avantC = creations().length;
  const r = await projetA.ensureStripeWebhook({ mode: 'TEST', publicBackendUrl: URL_A2 });

  check('la demande aboutit', r.ok === true);
  check('toujours UN SEUL endpoint de projet', endpointsProjet().length === 1);
  const courant = endpointsProjet()[0];
  check('…dont l’adresse suit le nouveau tunnel',
    courant.url === `${URL_A2}/api/webhooks/stripe`);
  check('aucune création superflue', creations().length === avantC);

  const lien = await Binding.findOne({ provider: 'STRIPE', destination: 'PROJECT', projectId: idA }).lean();
  check('le lien retient la nouvelle adresse publique', lien?.projectPublicUrl === URL_A2);
}

/* ══════════════════════════════════════════════════════════════════════════
   SCÉNARIO E — la clé du projet n'atteint jamais Stripe
   ══════════════════════════════════════════════════════════════════════════ */
section('E. La clé du projet ne parle jamais à Stripe');
{
  const cles = new Set(appels.map((a) => a.auth).filter(Boolean));
  check('exactement UNE clé a parlé au fournisseur', cles.size === 1);
  check('…celle du coffre du Panel, en TEST', cles.has(CLE_PANEL));
  check('la sentinelle du PROJET n’apparaît nulle part',
    !JSON.stringify(appels).includes(CLE_PROJET));
  check('la clé PROD n’a jamais parlé non plus',
    !cles.has(CLE_PANEL_PROD));
}

/* ══════════════════════════════════════════════════════════════════════════
   SCÉNARIO F — Panel indisponible : aucun repli local
   ══════════════════════════════════════════════════════════════════════════ */
section('F. Fournisseur muet : échec franc, jamais de repli');
{
  const avantC = creations().length;
  const avantS = suppressions().length;

  /** On coupe la route de provisionnement, et elle seule. */
  const vraiListen = fauxStripe.listeners('request');
  const coupe = new Promise((resolve) => {
    const saboteur = (req, res) => {
      if (/webhook_endpoints/.test(req.url ?? '')) {
        appels.push({ method: req.method, url: req.url, auth: null, corps: '' });
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'panne simulée' } }));
        return;
      }
      vraiListen[0](req, res);
    };
    fauxStripe.removeAllListeners('request');
    fauxStripe.on('request', saboteur);
    resolve();
  });
  await coupe;

  const r = await projetB.ensureStripeWebhook({
    mode: 'TEST', publicBackendUrl: 'https://projet-b.test',
  });
  check('la demande ÉCHOUE franchement', r.ok === false);
  check('…et ne prétend rien avoir garanti', !r.data?.endpointId);
  check('AUCUN endpoint créé', creations().length === avantC);
  check('…et rien de supprimé au passage', suppressions().length === avantS);

  fauxStripe.removeAllListeners('request');
  fauxStripe.on('request', vraiListen[0]);
}

/* ══════════════════════════════════════════════════════════════════════════
   SCÉNARIO G — le secret de A est inaccessible à B
   ══════════════════════════════════════════════════════════════════════════ */
section('G. Le secret d’un projet n’est pas celui d’un autre');
{
  const rB = await projetB.ensureStripeWebhook({
    mode: 'TEST', publicBackendUrl: 'https://projet-b.test',
  });
  check('B obtient son propre endpoint', rB.ok === true);
  check('…et il y en a maintenant deux (un par projet)', endpointsProjet().length === 2);

  const sB = await secrets.readProjectVerificationSecret({
    projectId: idB, provider: 'STRIPE', environment: 'TEST',
  });
  check('B a un secret', typeof sB?.secret === 'string');
  check('…DIFFÉRENT de celui de A', sB.secret !== secretA);

  /**
   * L'ISOLATION EST STRUCTURELLE : la lecture EXIGE un `projectId`, et celui
   * qui fait autorité vient du jeton de pont. Il n'existe aucune façon de
   * demander « le secret de l'autre » — pas même une fonction qui listerait.
   */
  check('aucune fonction ne permet de lister les secrets',
    typeof secrets.default.listAll !== 'function');
  const croise = await secrets.readProjectVerificationSecret({
    projectId: idB, provider: 'STRIPE', environment: 'TEST',
  });
  check('demander pour B rend le secret de B, jamais celui de A',
    croise.secret === sB.secret && croise.secret !== secretA);

  /** Les endpoints pointent chacun vers leur projet. */
  const urls = endpointsProjet().map((e) => e.url).sort();
  check('chaque endpoint pointe vers SON projet',
    urls.some((u) => u.startsWith(URL_A2)) && urls.some((u) => u.startsWith('https://projet-b.test')));
}

/* ══════════════════════════════════════════════════════════════════════════
   SCÉNARIO H — TEST et PROD ne se touchent pas
   ══════════════════════════════════════════════════════════════════════════ */
section('H. TEST et PROD : deux mondes, deux liens, deux secrets');
{
  const enProd = await Binding.findOne({
    provider: 'STRIPE', environment: 'PROD', destination: 'PROJECT', projectId: idA,
  }).lean();
  check('aucun lien PROD n’a été créé par un provisionnement TEST', enProd === null);

  const secretProd = await secrets.readProjectVerificationSecret({
    projectId: idA, provider: 'STRIPE', environment: 'PROD',
  });
  check('…ni aucun secret PROD', secretProd === null);

  check('la clé PROD du coffre n’a émis aucun appel',
    appels.every((a) => a.auth !== CLE_PANEL_PROD));
}

/* ══════════════════════════════════════════════════════════════════════════
   LA PORTE ÉTROITE — ce qu'elle accepte, et tout ce qu'elle refuse
   ══════════════════════════════════════════════════════════════════════════ */
section('I. Le canal de vérification n’accepte qu’une seule forme');
{
  const refuse = (charge) => {
    try { assertVerificationSecretOnly(charge); return false; } catch { return true; }
  };
  check('un secret de signature seul PASSE', !refuse({ webhookSecret: secretA }));
  check('une clé d’appel sous ce nom est refusée par sa FORME',
    refuse({ webhookSecret: CLE_PANEL }));
  check('un champ en plus est refusé', refuse({ webhookSecret: secretA, baseUrl: 'https://x' }));
  check('un rôle non déclaré « vérification » est refusé', refuse({ secretKey: secretA }));
  check('une charge vide est refusée', refuse({}));
  check('un tableau est refusé', refuse([secretA]));

  /**
   * ET LA GARDE GÉNÉRALE N'A PAS BOUGÉ : le même secret, présenté au canal
   * ordinaire, reste refusé. C'est ce qui prouve qu'on a percé une serrure et
   * non abattu le mur.
   */
  let refuseParL4 = false;
  try { assertNoProviderSecrets({ webhookSecret: secretA }); } catch { refuseParL4 = true; }
  check('le canal ORDINAIRE refuse toujours ce même secret', refuseParL4);
}

/* ══════════════════════════════════════════════════════════════════════════
   NON-RÉGRESSION MÉTIER — un vrai paiement atteint toujours le projet
   ══════════════════════════════════════════════════════════════════════════ */
section('J. Un événement signé atteint toujours le métier du projet');
{
  /**
   * LE POINT LE PLUS IMPORTANT DU LOT.
   *
   * « L'endpoint est créé » ne prouve rien : ce qui compte est qu'un événement
   * signé avec le secret livré traverse encore la vérification du projet et
   * atteigne sa logique métier. Sans cette section, on aurait pu déplacer le
   * provisionnement et rendre le projet sourd sans le voir.
   */
  const corps = JSON.stringify({
    id: 'evt_l63a_ping',
    type: 'checkout.session.completed',
    data: { object: { id: 'cs_l63a_1', object: 'checkout.session', status: 'complete', metadata: {} } },
  });
  const t = Math.floor(Date.now() / 1000);
  const signature = createHmac('sha256', secretA).update(`${t}.${corps}`).digest('hex');

  const reponse = await projetA.postWebhook({
    path: '/api/webhooks/stripe',
    body: corps,
    headers: {
      'stripe-signature': `t=${t},v1=${signature}`,
      'content-type': 'application/json',
    },
  });
  check('le projet ACCEPTE un événement signé du secret livré', reponse.status < 400);

  /**
   * ET IL REFUSE LE RESTE. Sans ce second contrôle, le premier ne prouverait
   * rien : une route qui accepte tout accepte aussi une signature valide.
   */
  const mauvais = createHmac('sha256', forme.stripeWebhook('CE-NEST-PAS-LE-BON-SECRET-00'))
    .update(`${t}.${corps}`).digest('hex');
  const refus = await projetA.postWebhook({
    path: '/api/webhooks/stripe',
    body: corps,
    headers: {
      'stripe-signature': `t=${t},v1=${mauvais}`,
      'content-type': 'application/json',
    },
  });
  check('…et REFUSE une signature qui ne vient pas de Stripe', refus.status >= 400);
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('K. Bilan');
{
  check('deux endpoints, un par projet', endpointsProjet().length === 2);
  check('…et autant de liens en base',
    (await Binding.countDocuments({ provider: 'STRIPE', destination: 'PROJECT' })) === 2);

  /**
   * AUCUNE PROLIFÉRATION : quatorze demandes ont été servies sur ce fichier
   * (une nominale, une au redémarrage, huit simultanées, une de changement
   * d'adresse, une en panne, deux pour B) et le fournisseur ne compte que deux
   * créations. C'est l'invariant du lot.
   */
  check('le fournisseur n’a jamais créé plus de deux endpoints de PROJET',
    creationsProjet().length === 2);

  for (const [nom, instance] of [['A', projetA], ['B', projetB]]) {
    const dump = JSON.stringify(await instance.dbDump());
    check(`la base du projet ${nom} ne contient aucune clé d’APPEL Stripe`,
      !dump.includes(CLE_PANEL) && !dump.includes(CLE_PANEL_PROD) && !dump.includes(CLE_PROJET));
  }
}

await projetA.stop();
await projetB.stop();
fauxStripe.close();
finish();
