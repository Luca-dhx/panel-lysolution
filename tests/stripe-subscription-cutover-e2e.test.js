// LE TARIF, PUIS L'ABONNEMENT — l'E2E du lot (L6.2E).
//
// ══ CE QUE CE LOT DÉBLOQUE ═══════════════════════════════════════════════════
//
// Une session `mode: subscription` référence un CLIENT et un TARIF créés avant
// elle. Tant que le projet les créait avec sa clé, la session devait partir avec
// la même — sinon Stripe l'aurait refusée, devant un client qui paie. C'est la
// raison pour laquelle l'abonnement était le dernier parcours non migré.
//
// L6.2D a donné le client au Panel, ce lot lui donne le tarif. La session peut
// donc être composée entièrement de son côté.
//
// ══ LA DÉCOUVERTE QUI DÉTERMINE LA CLÉ DU TARIF ══════════════════════════════
//
// Le code historique clé ses Price sur `signatureConfiguration.version`. Or
// cette version s'incrémente à CHAQUE sauvegarde des zones de signature : elle
// mesure un document, pas un engagement commercial. Y adosser l'identité d'un
// tarif produit des Price rigoureusement identiques mais démultipliés.
//
// La clé retenue porte donc les TERMES — périodicité, montant, devise — et la
// section 4 en fait un invariant exécutable : même contrat, même version, mêmes
// termes → le MÊME Price ; termes différents → un autre, sans jamais toucher au
// premier.
import http from 'node:http';

import {
  check, connectTestDatabase, finish, section, setTestEnv,
  startMemoryMongo, startServer,
} from './helpers/harness.js';
import { startSbAutoInstance } from './helpers/sbauto-remote.js';
import { ensureClientCompany, ligneTarifaire, ventilationDepuisTTC } from './helpers/clientCompany.fixture.js';

/** Le HORS TAXE du tarif mensuel de référence — lu par plusieurs sections. */
const HT_MENSUEL = ventilationDepuisTTC(11_880).net;

setTestEnv();
const MONGO_URI = await startMemoryMongo();
await connectTestDatabase();

/** Composé à l'exécution : une chaîne de cette forme est un secret aux yeux du dépôt. */
const prefixe = (monde) => ['sk', monde, ''].join('_');
const CLE_PANEL = `${prefixe('test')}L62ESENTINELLEPANEL0000000001`;
const CLE_PROJET = `${prefixe('test')}L62ESENTINELLEPROJETJAMAISVUE2`;

const ACTEUR = { userId: 'u-dev', userEmail: 'dev@panel.test' };
const PRICE = 'billing.price.ensure';
const ENSURE = 'billing.customer.ensure';
const CHECKOUT = 'billing.checkout.create';

/* ══════════════════════════════════════════════════════════════════════════
   UN FAUX STRIPE QUI DÉDUPLIQUE — et qui REFUSE toute mutation de Price.
   ══════════════════════════════════════════════════════════════════════════ */
const appels = [];
const parCle = new Map();
const parId = new Map();
let sequence = 0;
/** Prochaine création de Price : créer, puis couper la connexion. */
let avalerProchainPrice = false;

const lireCorps = (req) => new Promise((resolve) => {
  let brut = '';
  req.on('data', (c) => { brut += c; });
  req.on('end', () => resolve(brut));
});

/** Le catalogue fiscal du faux compte — voir le bloc de routes plus bas. */
const tauxTva = new Map();
/** Table d'idempotence PROPRE aux taux : elle ne doit pas polluer celle des sessions. */
const tauxParCle = new Map();
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

  /**
   * MUTER UN PRICE EST IMPOSSIBLE, ET LE FAUX FOURNISSEUR LE FAIT RESPECTER.
   *
   * Stripe interdit de modifier le montant, la devise ou la périodicité d'un
   * Price. Si notre code tentait un jour de « corriger » un tarif au lieu d'en
   * créer un autre, ce refus le ferait échouer bruyamment — plutôt que de
   * laisser un test vert masquer une réécriture de l'histoire.
   */
  const mutation = /^\/v1\/prices\/([^/?]+)$/.exec(req.url ?? '');
  if (req.method === 'POST' && mutation) {
    return repondre(400, { error: { message: 'Un Price ne se modifie pas.' } });
  }

  if (req.method === 'POST' && (req.url === '/v1/prices' || req.url === '/v1/products'
    || req.url === '/v1/customers' || req.url === '/v1/checkout/sessions')) {
    if (avalerProchainPrice && req.url === '/v1/prices') {
      avalerProchainPrice = false;
      sequence += 1;
      fabriquer(req.url, cle, corps);
      req.socket.destroy();
      return;
    }
    const connu = parCle.get(cle);
    if (connu) return repondre(200, connu);
    sequence += 1;
    return repondre(200, fabriquer(req.url, cle, corps));
  }

  const lecture = /^\/v1\/(prices|customers|checkout\/sessions)\/([^/?]+)$/.exec(req.url ?? '');
  if (req.method === 'GET' && lecture) {
    const objet = parId.get(decodeURIComponent(lecture[2]));
    if (!objet) return repondre(404, { error: { code: 'resource_missing', message: 'introuvable' } });
    return repondre(200, objet);
  }

  /* ── MISE À JOUR D'UN CLIENT ────────────────────────────────────────────
     `ensure` fait désormais CONVERGER l'identité de facturation : il relit le
     client, compare à ce que le Panel détient, et écrit sur écart. Un faux
     Stripe muet sur cette écriture ferait échouer le paiement pour une route
     manquante, pas pour une règle métier. */
  const majClient = /^\/v1\/customers\/([^/?]+)$/.exec(req.url ?? "");
  if (req.method === 'POST' && majClient) {
    const client = parId.get(decodeURIComponent(majClient[1]));
    if (!client) return repondre(404, { error: { code: 'resource_missing' } });
    const champs = new URLSearchParams(corps);
    for (const cle of ['name', 'email', 'phone']) {
      if (champs.has(cle)) client[cle] = champs.get(cle);
    }
    client.address = {
      line1: champs.get('address[line1]') ?? null,
      line2: champs.get('address[line2]') ?? null,
      postal_code: champs.get('address[postal_code]') ?? null,
      city: champs.get('address[city]') ?? null,
      country: champs.get('address[country]') ?? null,
    };
    return repondre(200, client);
  }
  /* ── TVA (chantier « facturation légale ») ──────────────────────────────
     Le plan de contrôle garantit un TaxRate avant toute session, puis pose le
     numéro de TVA du client. Un faux Stripe muet sur ces routes ferait échouer
     le paiement en PROVIDER_UNAVAILABLE — c'est-à-dire pour une raison qui n'a
     rien à voir avec ce que le test éprouve. */
  if (req.method === 'GET' && (req.url ?? '').startsWith('/v1/tax_rates')) {
    return repondre(200, { object: 'list', data: [...tauxTva.values()] });
  }
  if (req.method === 'POST' && req.url === '/v1/tax_rates') {
    const connu = tauxParCle.get(cle);
    if (connu) return repondre(200, connu);
    sequence += 1;
    const taux = {
      id: `txr_test_${sequence}`,
      object: 'tax_rate',
      active: true,
      inclusive: false,
      percentage: Number(new URLSearchParams(corps).get('percentage')),
      country: new URLSearchParams(corps).get('country'),
      display_name: new URLSearchParams(corps).get('display_name'),
    };
    tauxTva.set(taux.id, taux);
    tauxParCle.set(cle, taux);
    return repondre(200, taux);
  }
  const listeTva = /^\/v1\/customers\/([^/?]+)\/tax_ids/.exec(req.url ?? '');
  if (listeTva && req.method === 'GET') return repondre(200, { object: 'list', data: [] });
  if (listeTva && req.method === 'POST') {
    return repondre(200, { id: `txi_test_${(sequence += 1)}`, object: 'tax_id' });
  }
  return repondre(404, { error: { message: 'route inconnue' } });
});

function fabriquer(url, cle, corps) {
  const params = new URLSearchParams(corps);
  const prefixes = {
    '/v1/prices': 'price', '/v1/products': 'prod',
    '/v1/customers': 'cus', '/v1/checkout/sessions': 'cs',
  };
  const id = `${prefixes[url]}_test_${sequence}`;
  const objet = { id, object: prefixes[url], deleted: false };
  if (url === '/v1/prices') {
    objet.unit_amount = Number(params.get('unit_amount'));
    objet.currency = params.get('currency');
    objet.recurring = { interval: params.get('recurring[interval]') };
    objet.product = params.get('product');
  }
  if (url === '/v1/checkout/sessions') {
    objet.url = `https://pay.test/${id}`;
    objet.status = 'open';
    objet.payment_status = 'unpaid';
    objet.customer = params.get('customer');
    objet.subscription = null;
    objet.mode = params.get('mode');
  }
  parCle.set(cle, objet);
  parId.set(id, objet);
  return objet;
}

const creations = (chemin) => appels.filter((a) => a.method === 'POST' && a.url === chemin);
const ids = (p) => [...parId.keys()].filter((id) => id.startsWith(p));

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
const { default: PanelCapabilityOperation } = await import('../backend/src/models/PanelCapabilityOperation.model.js');
const binding = await import('../backend/src/services/integratedApi/stripe/stripeResourceBinding.js');
const tarifAutorite = await import('../backend/src/services/integratedApi/stripe/stripePriceAuthority.js');

await resetSyncCore();
await seedIntegratedApiCredentialSets();
await updateNetworkConfiguration({ backendUrl: 'https://panel-l62e.test' }, { requirePublic: false });

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
  mongoUri: MONGO_URI, dbName: 'sbauto_l62e_a', env: 'TEST', projectName: 'SB Auto L6.2E A',
});
const projetB = await startSbAutoInstance({
  mongoUri: MONGO_URI, dbName: 'sbauto_l62e_b', env: 'TEST', projectName: 'SB Auto L6.2E B',
});

const CONTRAT_A = 'contrat-l62e-a-00000000001';
const CONTRAT_B = 'contrat-l62e-b-00000000002';
let idA;
let idB;

/** La projection du Panel — SEULE autorité sur les termes du tarif. */
async function semer(projectId, sourceContractId, { amount = 11_880, interval = 'MONTH', currency = 'EUR', version = 1 } = {}) {
  /**
   * L'ENTREPRISE CLIENTE — exigée depuis le chantier « facturation légale ».
   *
   * Aucun paiement ne s'ouvre pour un projet sans identité juridique de client :
   * c'est la garde centrale de ce chantier, et elle est autoritative côté
   * backend. La semer ici n'assouplit rien — elle donne au parcours la donnée
   * qu'il exige désormais, exactement comme le fait un exploitant qui remplit
   * la fiche « Clients » avant d'encaisser.
   */
  await ensureClientCompany(projectId);
  await PanelProjectContract.updateOne(
    { projectId },
    {
      $set: {
        projectId,
        hasCurrent: true,
        sourceContractId,
        status: 'ACTIVE',
        reference: `CTR-${sourceContractId.slice(-4)}`,
        document: { available: true, status: 'SIGNED', version },
        pricing: {
          launchFee: { amountIncludingTax: 118_800, amountExcludingTax: 99000, taxAmount: 19800, taxRate: 20, currency: 'EUR', interval: null },
          subscription: ligneTarifaire(amount, { currency, interval }),
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

section('2. Deux projets appairés, accordés');
{
  idA = await appairer(projetA);
  idB = await appairer(projetB);
  for (const id of [idA, idB]) {
  }
  await projetA.syncNow();
  await projetB.syncNow();
  await semer(idA, CONTRAT_A);
  await semer(idB, CONTRAT_B, { amount: 4_900 });
  check('deux projets distincts', typeof idA === 'string' && idA !== idB);
}

/* ══════════════════════════════════════════════════════════════════════════
   3. LE TARIF — Product puis Price, les deux liés
   ══════════════════════════════════════════════════════════════════════════ */
let priceA1;
let productA;
section('3. Le tarif d’un contrat : deux ressources, un seul acte');
{
  await semer(idA, CONTRAT_A);
  const r = await projetA.invokeCapability({ code: PRICE, input: { contractRef: CONTRAT_A } });

  check('le tarif est garanti', r.ok === true);
  priceA1 = r.data.result.priceId;
  productA = r.data.result.productId;
  check('…un Price est rendu', /^price_test_\d+$/.test(priceA1));
  check('…et son Product', /^prod_test_\d+$/.test(productA));
  check('…il vient d’être créé', r.data.result.status === 'CREATED');

  /* LES TERMES VIENNENT DE LA PROJECTION, PAS DU PROJET. */
  /**
   * ── LE MONTANT D’UN PRICE EST DÉSORMAIS LE HORS TAXE ──────────────────
   *
   * Il portait le TTC, sans qu’aucune taxe ne soit jamais déclarée : les
   * factures d’abonnement affichaient trois fois le même nombre et aucune
   * mention de TVA. Le taux s’applique maintenant à l’ABONNEMENT
   * (`subscription_data.default_tax_rates`), et le Price porte le HT.
   *
   * Le prélèvement, lui, est INCHANGÉ : `HT + TVA = TTC` est vérifié avant
   * tout appel. C’est ce que la dernière assertion de ce bloc établit.
   */

  check('le montant rendu est le HORS TAXE de la projection', r.data.result.amount === HT_MENSUEL);
  check('…et il s’additionne bien au TTC du contrat',
    HT_MENSUEL + ventilationDepuisTTC(11_880).tax === 11_880);
  check('…la devise aussi', r.data.result.currency === 'eur');
  check('…et la périodicité', r.data.result.interval === 'month');

  const post = creations('/v1/prices').at(-1);
  const params = new URLSearchParams(post.corps);
  check('le montant ENVOYÉ à Stripe est le HORS TAXE de la projection',
    params.get('unit_amount') === String(HT_MENSUEL));
  check('…et le tarif déclare que son montant est HORS TAXE',
    params.get('tax_behavior') === 'exclusive');
  check('…en centimes, jamais en euros', !String(params.get('unit_amount')).includes('.'));
  check('…la devise en minuscules', params.get('currency') === 'eur');
  check('…la périodicité', params.get('recurring[interval]') === 'month');
  check('le Price est rattaché au Product', params.get('product') === productA);
  check('metadata contractId = celui de la PROJECTION', params.get('metadata[contractId]') === CONTRAT_A);
  check('metadata contractVersion conservée', params.get('metadata[contractVersion]') === '1');
  check('la clé partie est celle du COFFRE', post.auth === CLE_PANEL);
  check('la clé du PROJET n’a jamais servi', appels.every((a) => a.auth !== CLE_PROJET));

  /* LES DEUX RESSOURCES SONT LIÉES. */
  const lienPrice = await binding.findBinding({
    environment: 'TEST', resourceType: 'PRICE', resourceId: priceA1,
  });
  const lienProduct = await binding.findBinding({
    environment: 'TEST', resourceType: 'PRODUCT', resourceId: productA,
  });
  check('le Price est lié au projet', lienPrice?.projectId === idA);
  check('le Product aussi', lienProduct?.projectId === idA);
  check('…et chacun porte SON acte, distinct de l’autre',
    lienPrice.createdByOperationId !== lienProduct.createdByOperationId);
  check('l’acte du Price porte les TERMES',
    lienPrice.createdByOperationId === tarifAutorite.priceOperationId({
      environment: 'TEST', contractId: CONTRAT_A, interval: 'month', amount: HT_MENSUEL, currency: 'eur',
    }));
  check('l’acte du Product porte le CONTRAT, sans les termes',
    lienProduct.createdByOperationId === tarifAutorite.productOperationId({
      environment: 'TEST', contractId: CONTRAT_A,
    }));

  // Le rejeu ne crée rien.
  const avant = creations('/v1/prices').length;
  const rejeu = await projetA.invokeCapability({ code: PRICE, input: { contractRef: CONTRAT_A } });
  check('le rejeu retrouve le même tarif', rejeu.data.result.priceId === priceA1);
  check('…se déclare EXISTING', rejeu.data.result.status === 'EXISTING');
  check('…et n’appelle pas Stripe', creations('/v1/prices').length === avant);

  // Le projet ne peut rien imposer.
  for (const champ of ['amount', 'currency', 'interval', 'priceId', 'productId', 'operationId', 'environment']) {
    const refus = await projetA.invokeCapability({
      code: PRICE, input: { contractRef: CONTRAT_A, [champ]: 'x' },
    });
    check(`« ${champ} » dans la charge utile → refusé`, refus.code === 'CAPABILITY_INPUT_INVALID');
  }
}

/* ══════════════════════════════════════════════════════════════════════════
   4. IMMUTABILITÉ — l'invariant du lot
   ══════════════════════════════════════════════════════════════════════════ */
section('4. Changer de tarif crée un AUTRE Price — jamais une mutation');
{
  /* 4a. Une nouvelle VERSION aux MÊMES termes ne crée rien. */
  await semer(idA, CONTRAT_A, { version: 7 });
  const avantVersion = creations('/v1/prices').length;
  const memeTermes = await projetA.invokeCapability({ code: PRICE, input: { contractRef: CONTRAT_A } });
  check('une version de contrat différente, mêmes termes → MÊME Price',
    memeTermes.data.result.priceId === priceA1);
  check('…aucun Price créé', creations('/v1/prices').length === avantVersion);

  /* 4b. Un MONTANT différent crée un Price distinct — et P1 survit. */
  await semer(idA, CONTRAT_A, { amount: 29_900, version: 7 });
  const nouveau = await projetA.invokeCapability({ code: PRICE, input: { contractRef: CONTRAT_A } });
  const priceA2 = nouveau.data.result.priceId;
  check('un montant différent → un AUTRE Price', priceA2 !== priceA1);
  check('…créé, pas retrouvé', nouveau.data.result.status === 'CREATED');
  check('…au nouveau montant HORS TAXE', nouveau.data.result.amount === ventilationDepuisTTC(29_900).net);
  check('le Product, lui, est RÉUTILISÉ', nouveau.data.result.productId === productA);

  check('P1 existe toujours chez Stripe', parId.has(priceA1));
  check('…avec son montant d’origine', parId.get(priceA1).unit_amount === HT_MENSUEL);
  check('…et son lien est intact',
    (await binding.findBinding({ environment: 'TEST', resourceType: 'PRICE', resourceId: priceA1 }))?.projectId === idA);
  check('AUCUNE mutation de Price n’a été tentée',
    !appels.some((a) => a.method === 'POST' && /^\/v1\/prices\/[^/]+$/.test(a.url)));

  /* 4c. Une PÉRIODICITÉ différente crée encore un autre Price. */
  await semer(idA, CONTRAT_A, { amount: 29_900, interval: 'YEAR', version: 7 });
  const annuel = await projetA.invokeCapability({ code: PRICE, input: { contractRef: CONTRAT_A } });
  check('mensuel → annuel : un AUTRE Price', annuel.data.result.priceId !== priceA2);
  check('…avec la bonne périodicité', annuel.data.result.interval === 'year');
  check('…et le montant annuel HORS TAXE', annuel.data.result.amount === ventilationDepuisTTC(29_900).net);
  check('les trois Price coexistent',
    new Set([priceA1, priceA2, annuel.data.result.priceId]).size === 3);

  /* 4d. La DEVISE aussi — le défaut que la garde locale ne voyait pas. */
  await semer(idA, CONTRAT_A, { amount: 29_900, interval: 'YEAR', currency: 'CHF', version: 7 });
  const devise = await projetA.invokeCapability({ code: PRICE, input: { contractRef: CONTRAT_A } });
  check('une devise différente à montant IDENTIQUE → un AUTRE Price',
    devise.data.result.priceId !== annuel.data.result.priceId);
  check('…dans la bonne devise', devise.data.result.currency === 'chf');

  await semer(idA, CONTRAT_A);
}

/* ══════════════════════════════════════════════════════════════════════════
   5. CONCURRENCE
   ══════════════════════════════════════════════════════════════════════════ */
const CONTRAT_A_C = 'contrat-l62e-a-concurrence';
section('5. Huit appels simultanés pour le même contrat');
{
  await semer(idA, CONTRAT_A_C, { amount: 7_700 });
  const avantPrices = ids('price_').length;
  const avantProducts = ids('prod_').length;

  const resultats = await Promise.all(
    Array.from({ length: 8 }, () => projetA.invokeCapability({ code: PRICE, input: { contractRef: CONTRAT_A_C } })),
  );
  const reussis = resultats.filter((r) => r.ok);
  const refuses = resultats.filter((r) => !r.ok);
  check('au moins un aboutit', reussis.length >= 1);
  check('les autres sont refusés, jamais servis en double',
    refuses.every((r) => r.code === 'CAPABILITY_OPERATION_IN_FLIGHT'));
  check('UN SEUL Price créé', ids('price_').length === avantPrices + 1);
  check('UN SEUL Product créé', ids('prod_').length === avantProducts + 1);
  check('…et tous les succès désignent le même tarif',
    new Set(reussis.map((r) => r.data.result.priceId)).size === 1);
}

/* ══════════════════════════════════════════════════════════════════════════
   6. CRASH ET RÉPONSE PERDUE
   ══════════════════════════════════════════════════════════════════════════ */
const CONTRAT_A_X = 'contrat-l62e-a-crash00000';
section('6. Crash entre Product et Price, puis réponse perdue');
{
  await semer(idA, CONTRAT_A_X, { amount: 5_500 });

  /* 6a. Le Panel meurt APRÈS le Product, AVANT le Price. */
  const avantProducts = ids('prod_').length;
  avalerProchainPrice = true;
  const perdu = await projetA.invokeCapability({ code: PRICE, input: { contractRef: CONTRAT_A_X } });
  check('l’appel échoue', perdu.ok === false);
  check('…en CAPABILITY_TIMEOUT, pas en « indisponible »', perdu.code === 'CAPABILITY_TIMEOUT');
  check('le Product a bien été créé et lié', ids('prod_').length === avantProducts + 1);
  check('…et le Price aussi, chez Stripe', ids('price_').length >= 1);

  const acte = tarifAutorite.productOperationId({ environment: 'TEST', contractId: CONTRAT_A_X });
  const operation = await PanelCapabilityOperation.findOne({ projectId: idA, operationId: acte }).lean();
  check('l’opération est marquée UNKNOWN — pas FAILED', operation?.status === 'UNKNOWN');

  const avantPrices = ids('price_').length;
  const reprise = await projetA.invokeCapability({ code: PRICE, input: { contractRef: CONTRAT_A_X } });
  check('la reprise aboutit', reprise.ok === true);
  check('…sans créer de Product de plus', ids('prod_').length === avantProducts + 1);
  check('…ni de Price de plus', ids('price_').length === avantPrices);
  check('le Price perdu est retrouvé ET lié',
    (await binding.findBinding({
      environment: 'TEST', resourceType: 'PRICE', resourceId: reprise.data.result.priceId,
    }))?.projectId === idA);

  /* 6b. Crash APRÈS le Price, AVANT son lien. */
  const priceX = reprise.data.result.priceId;
  const actePrice = tarifAutorite.priceOperationId({
    environment: 'TEST',
    contractId: CONTRAT_A_X,
    interval: 'month',
    /** La clé porte le montant du tarif, donc son HORS TAXE depuis ce chantier. */
    amount: ventilationDepuisTTC(5_500).net,
    currency: 'eur',
  });
  await PanelStripeResourceBinding.deleteOne({ environment: 'TEST', resourceId: priceX });
  await PanelCapabilityOperation.updateOne(
    { projectId: idA, operationId: acte },
    { $set: { status: 'PENDING', settledAt: null, startedAt: new Date(Date.now() - 10 * 60_000).toISOString() } },
  );
  const avant = ids('price_').length;
  const repare = await projetA.invokeCapability({ code: PRICE, input: { contractRef: CONTRAT_A_X } });
  check('la reprise après crash aboutit', repare.ok === true);
  check('…sur LE MÊME Price', repare.data.result.priceId === priceX);
  check('…sans créer de Price de plus', ids('price_').length === avant);
  const lien = await binding.findBinding({
    environment: 'TEST', resourceType: 'PRICE', resourceId: priceX,
  });
  check('le lien est RÉPARÉ', lien?.projectId === idA);
  check('…et désigne toujours le même acte', lien.createdByOperationId === actePrice);
}

/* ══════════════════════════════════════════════════════════════════════════
   7. CROSS-TENANT
   ══════════════════════════════════════════════════════════════════════════ */
section('7. Le projet B n’atteint rien de A');
{
  const avant = ids('price_').length;
  const vol = await projetB.invokeCapability({ code: PRICE, input: { contractRef: CONTRAT_A } });
  check('B demandant le tarif du contrat de A → refusé', vol.ok === false);
  check('…motif CONTRACT_NOT_OWNED', vol.panelDetails?.reason === 'CONTRACT_NOT_OWNED');
  check('…et AUCUN tarif créé', ids('price_').length === avant);

  const invente = await projetB.invokeCapability({ code: PRICE, input: { contractRef: 'contrat-invente' } });
  check('une référence inventée → même code', invente.code === vol.code);
  check('…même motif', invente.panelDetails?.reason === vol.panelDetails?.reason);
  check('…même message', invente.message === vol.message);

  let conflit = null;
  try {
    await binding.bindResource({
      projectId: idB, environment: 'TEST', resourceType: 'PRICE', resourceId: priceA1,
    });
  } catch (err) { conflit = err; }
  check('B adoptant le Price de A → conflit', conflit?.code === 'STRIPE_RESOURCE_ALREADY_BOUND');
  check('…le Price reste à A',
    (await binding.findBinding({ environment: 'TEST', resourceType: 'PRICE', resourceId: priceA1 }))?.projectId === idA);

  // B obtient SON tarif, à SON montant.
  const propre = await projetB.invokeCapability({ code: PRICE, input: { contractRef: CONTRAT_B } });
  check('B obtient son propre tarif', propre.ok === true);
  check('…à SON montant HORS TAXE', propre.data.result.amount === ventilationDepuisTTC(4_900).net);
  check('…et son Price lui est lié',
    (await binding.findBinding({
      environment: 'TEST', resourceType: 'PRICE', resourceId: propre.data.result.priceId,
    }))?.projectId === idB);
}

/* ══════════════════════════════════════════════════════════════════════════
   8. TEST / PROD
   ══════════════════════════════════════════════════════════════════════════ */
section('8. Le même contrat, les mêmes termes, deux mondes');
{
  const memes = { contractId: CONTRAT_A, interval: 'month', amount: 11_880, currency: 'eur' };
  check('l’acte du Price porte le MONDE',
    tarifAutorite.priceOperationId({ environment: 'TEST', ...memes })
    !== tarifAutorite.priceOperationId({ environment: 'PROD', ...memes }));
  check('celui du Product aussi',
    tarifAutorite.productOperationId({ environment: 'TEST', contractId: CONTRAT_A })
    !== tarifAutorite.productOperationId({ environment: 'PROD', contractId: CONTRAT_A }));

  const enProd = await binding.describeOwnership({
    projectId: idA, environment: 'PROD', resourceType: 'PRICE', resourceId: priceA1,
  });
  check('le Price TEST de A n’existe pas en PROD', enProd.allowed === false);
  check('…motif « aucun lien »', enProd.reason === 'NO_BINDING');
}

/* ══════════════════════════════════════════════════════════════════════════
   9. LE CHECKOUT D'ABONNEMENT — la composition
   ══════════════════════════════════════════════════════════════════════════ */
const OP_SUB = `checkout-sub-${CONTRAT_A}-v1-month-11880-TEST-a0`;
let sessionSub;
section('9. La session d’abonnement, composée par le Panel');
{
  await semer(idA, CONTRAT_A);

  const r = await projetA.invokeCapability({
    code: CHECKOUT,
    input: {
      contractRef: CONTRAT_A, paymentType: 'SUBSCRIPTION',
      successUrl: 'https://a.test/ok', cancelUrl: 'https://a.test/ko',
      operationId: OP_SUB,
    },
  });

  check('la session d’abonnement est ouverte', r.ok === true);
  sessionSub = r.data.result.checkoutSessionId;
  check('…une session est rendue', /^cs_test_\d+$/.test(sessionSub));
  check('…avec son URL', typeof r.data.result.url === 'string');

  const post = creations('/v1/checkout/sessions').at(-1);
  const params = new URLSearchParams(post.corps);
  check('mode subscription', params.get('mode') === 'subscription');
  check('la ligne référence un PRICE, jamais un montant inline',
    params.get('line_items[0][price]')?.startsWith('price_') && !post.corps.includes('price_data'));
  check('…et c’est le tarif du contrat', params.get('line_items[0][price]') === priceA1);
  check('le CLIENT est celui du contrat', params.get('customer')?.startsWith('cus_'));
  check('…et il est rendu au projet', r.data.result.customerId === params.get('customer'));
  check('metadata paymentType SUBSCRIPTION', params.get('metadata[paymentType]') === 'SUBSCRIPTION');
  check('metadata recopiées sur l’abonnement',
    params.get('subscription_data[metadata][contractId]') === CONTRAT_A);
  check('aucun montant dans la session', !post.corps.includes('unit_amount'));

  const lien = await binding.findBinding({
    environment: 'TEST', resourceType: 'CHECKOUT_SESSION', resourceId: sessionSub,
  });
  check('la session est liée au projet', lien?.projectId === idA);

  /**
   * LE CLIENT DE A N'EST JAMAIS CELUI DE B. Le client attaché doit être lié au
   * projet demandeur — c'est ce que `customer.ensure` garantit par contrat.
   */
  const lienClient = await binding.findBinding({
    environment: 'TEST', resourceType: 'CUSTOMER', resourceId: params.get('customer'),
  });
  check('le client attaché appartient bien à A', lienClient?.projectId === idA);
}

/* ══════════════════════════════════════════════════════════════════════════
   10. IDEMPOTENCE DU CHECKOUT — la doctrine L6.2B, inchangée
   ══════════════════════════════════════════════════════════════════════════ */
section('10. Double clic, concurrence, et rien qui double');
{
  const avant = ids('cs_').length;
  const rejeu = await projetA.invokeCapability({
    code: CHECKOUT,
    input: {
      contractRef: CONTRAT_A, paymentType: 'SUBSCRIPTION',
      successUrl: 'https://a.test/ok', cancelUrl: 'https://a.test/ko',
      operationId: OP_SUB,
    },
  });
  check('le rejeu REPREND', rejeu.data.result.creation === 'REUSED');
  check('…sur la même session', rejeu.data.result.checkoutSessionId === sessionSub);
  check('…et Stripe n’a rien créé de plus', ids('cs_').length === avant);

  const entree = {
    contractRef: CONTRAT_A, paymentType: 'SUBSCRIPTION',
    successUrl: 'https://a.test/ok', cancelUrl: 'https://a.test/ko',
    operationId: `${OP_SUB}-concurrent`,
  };
  const resultats = await Promise.all(
    Array.from({ length: 8 }, () => projetA.invokeCapability({ code: CHECKOUT, input: entree })),
  );
  const reussis = resultats.filter((r) => r.ok);
  check('8 appels concurrents : au moins un aboutit', reussis.length >= 1);
  check('…les autres refusés sans doubler',
    resultats.filter((r) => !r.ok).every((r) => r.code === 'CAPABILITY_OPERATION_IN_FLIGHT'));
  check('…UNE seule session de plus', ids('cs_').length === avant + 1);
  check('…et tous les succès désignent la même',
    new Set(reussis.map((r) => r.data.result.checkoutSessionId)).size === 1);
}

/* ══════════════════════════════════════════════════════════════════════════
   11. NON-RÉGRESSION DES FRAIS (L6.2B)
   ══════════════════════════════════════════════════════════════════════════ */
section('11. Le checkout de frais n’a pas bougé');
{
  const avant = ids('cs_').length;
  const frais = await projetA.invokeCapability({
    code: CHECKOUT,
    input: {
      contractRef: CONTRAT_A, paymentType: 'LAUNCH_FEE',
      successUrl: 'https://a.test/ok', cancelUrl: 'https://a.test/ko',
      operationId: `launch-${CONTRAT_A}-v1-a1-TEST`,
    },
  });
  check('les frais restent créables', frais.ok === true);
  const post = creations('/v1/checkout/sessions').at(-1);
  const params = new URLSearchParams(post.corps);
  check('mode payment', params.get('mode') === 'payment');
  check('…le montant vient toujours de la projection, HORS TAXE',
    params.get('line_items[0][price_data][unit_amount]') === String(ventilationDepuisTTC(118_800).net));
  check('…et un taux de TVA exclusif l’accompagne',
    /^txr_test_/.test(params.get('line_items[0][tax_rates][0]') ?? ''));
  check('…la facture est toujours réclamée', params.get('invoice_creation[enabled]') === 'true');
  /**
   * ── LE CLIENT EST DÉSORMAIS ATTACHÉ AUX FRAIS, ET C’EST LE CHANTIER ───
   *
   * L6.2B n’attachait aucun client à `mode: payment` : Stripe en créait un
   * à la volée depuis le formulaire, et la facture portait l’adresse tapée
   * par la personne devant l’écran — jamais l’identité juridique du client.
   *
   * Les frais de lancement et l’abonnement d’un même contrat référencent
   * maintenant LE MÊME client : même raison sociale, même adresse, même
   * numéro de TVA, même historique de facturation.
   */
  check('…et le client du contrat est attaché aux frais',
    /^cus_/.test(params.get('customer') ?? ''));
  check('une session de plus, et une seule', ids('cs_').length === avant + 1);
}

/* ══════════════════════════════════════════════════════════════════════════
   12. BILAN
   ══════════════════════════════════════════════════════════════════════════ */
section('12. Bilan — une clé, aucune mutation, aucun doublon');
{
  const cles = new Set(appels.map((a) => a.auth).filter(Boolean));
  check('exactement UNE clé a parlé à Stripe', cles.size === 1);
  check('…celle du coffre du Panel', cles.has(CLE_PANEL));
  check('la sentinelle du projet n’apparaît nulle part',
    !JSON.stringify(appels).includes(CLE_PROJET));

  check('AUCUNE tentative de mutation de Price',
    !appels.some((a) => a.method === 'POST' && /^\/v1\/prices\/[^/]+$/.test(a.url)));
  for (const chemin of ['/v1/prices', '/v1/products', '/v1/customers', '/v1/checkout/sessions']) {
    check(`aucune création sans clé d’idempotence sur ${chemin}`,
      creations(chemin).every((a) => typeof a.cle === 'string' && a.cle.length > 0));
  }

  /**
   * L'INVARIANT FINAL, pour chaque famille : autant de ressources chez Stripe
   * que de clés d'idempotence distinctes. Une clé qui aurait produit deux
   * ressources serait le doublon que tout ce lot interdit.
   */
  for (const [chemin, prefixe2] of [['/v1/prices', 'price_'], ['/v1/products', 'prod_'], ['/v1/customers', 'cus_']]) {
    const clesDistinctes = new Set(creations(chemin).map((a) => a.cle));
    check(`${chemin} : autant de ressources que de clés distinctes`,
      ids(prefixe2).length === clesDistinctes.size);
  }

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
