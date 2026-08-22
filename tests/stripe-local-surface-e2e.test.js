// LES DERNIÈRES LECTURES, ET LE PORTAIL — l'E2E du lot (L6.3B).
//
// ══ CE QUE CE LOT DÉPLACE ═══════════════════════════════════════════════════
//
// Après L6.3A, cinq appels Stripe locaux subsistaient dans SB Auto. Quatre
// d'entre eux étaient des lectures, plus l'ouverture du portail client. Aucun
// ne déplaçait d'argent — et c'est précisément pourquoi ils avaient survécu à
// sept lots de migration financière.
//
// Ils empêchaient pourtant de retirer la clé du projet, ce qui est le seul
// objectif restant.
//
// ══ LE VERBE QUI COMPTE VRAIMENT ════════════════════════════════════════════
//
// Le PORTAIL. Il ne déplace pas d'argent lui-même, mais il ouvre au client un
// écran contenant ses moyens de paiement, ses factures et ses abonnements.
//
// Le projet y passait le `customerId` qu'il portait en fiche locale. Une
// reprise de données, une copie de contrat, un identifiant hérité — et l'écran
// s'ouvrait sur le dossier de quelqu'un d'autre. L'appel aurait réussi. Rien ne
// l'aurait signalé. C'est la seule fuite du parc qui n'aurait ressemblé à
// aucune effraction.
//
// Le projet nomme désormais son CONTRAT, et le Panel remonte au client par le
// lien qu'il a lui-même écrit en L6.2D.
import http from 'node:http';

import {
  check, connectTestDatabase, finish, section, setTestEnv,
  startMemoryMongo, startServer,
} from './helpers/harness.js';
import { startSbAutoInstance } from './helpers/sbauto-remote.js';
import { ensureClientCompany, ligneTarifaire } from './helpers/clientCompany.fixture.js';

setTestEnv();
const MONGO_URI = await startMemoryMongo();
await connectTestDatabase();

const prefixe = (monde) => ['sk', monde, ''].join('_');
const CLE_PANEL = `${prefixe('test')}L63BSENTINELLEPANEL00000000001`;
const CLE_PANEL_PROD = `${prefixe('live')}L63BSENTINELLEPANELPROD0000002`;
const CLE_PROJET = `${prefixe('test')}L63BSENTINELLEPROJETJAMAISVUE3`;

const ACTEUR = { userId: 'u-dev', userEmail: 'dev@panel.test' };
const CHECKOUT = 'billing.checkout.create';
const CUSTOMER_ENSURE = 'billing.customer.ensure';
const INVOICE_LIST = 'billing.invoice.list';
const INVOICE_READ = 'billing.invoice.retrieve';
const PORTAL = 'billing.portal.create';

/* ══════════════════════════════════════════════════════════════════════════
   UN FAUX STRIPE QUI COMPTE SES APPELS — c'est le compteur qui prouve
   qu'un refus n'a RIEN coûté.
   ══════════════════════════════════════════════════════════════════════════ */
const appels = [];
const clients = new Map();
const factures = new Map();
let sequence = 0;

const lireCorps = (req) => new Promise((resolve) => {
  let brut = '';
  req.on('data', (c) => { brut += c; });
  req.on('end', () => resolve(brut));
});

/** Le catalogue fiscal du faux compte — voir le bloc de routes plus bas. */
const tauxTva = new Map();
/** Table d'idempotence PROPRE aux taux : elle ne doit pas polluer celle des sessions. */
const tauxParCle = new Map();
/**
 * LE COMPTE DE RECETTE, TEL QU'IL ÉTAIT AVANT CE LOT.
 *
 * Une seule configuration, celle par DÉFAUT, avec `customer_update` ACTIVÉ sur
 * `name, email, address, phone`. Ce n'est pas une invention : c'est la mesure
 * faite sur le vrai compte Stripe TEST. Le Panel ouvrait ses sessions sans
 * désigner de configuration, Stripe appliquait donc celle-ci, et le client
 * pouvait réécrire depuis le portail la raison sociale et l'adresse que
 * `PanelClientCompany` détient.
 *
 * Elle est là pour prouver deux choses à la fois : que le Panel ne s'en sert
 * plus, et qu'il ne la MODIFIE pas — elle ne lui appartient pas.
 */
const configurationsPortail = new Map([
  ['bpc_compte_defaut', {
    id: 'bpc_compte_defaut',
    object: 'billing_portal.configuration',
    is_default: true,
    active: true,
    created: 1_700_000_000,
    metadata: {},
    features: {
      customer_update: { enabled: true, allowed_updates: ['name', 'email', 'address', 'phone'] },
      payment_method_update: { enabled: true },
      invoice_history: { enabled: true },
      subscription_cancel: { enabled: true, mode: 'at_period_end', proration_behavior: 'none' },
      subscription_update: { enabled: false },
    },
  }],
]);

/** Traduit le formulaire Stripe reçu en objet de configuration. */
function configurationDepuisForm(id, corps, { is_default = false } = {}) {
  const p = new URLSearchParams(corps);
  const bool = (cle) => p.get(cle) === 'true';
  const champs = [];
  for (const [cle, valeur] of p.entries()) {
    if (/^features\[customer_update\]\[allowed_updates\]/.test(cle)) champs.push(valeur);
  }
  return {
    id,
    object: 'billing_portal.configuration',
    is_default,
    active: p.get('active') ? bool('active') : true,
    created: 1_800_000_000,
    metadata: {
      managedBy: p.get('metadata[managedBy]') ?? undefined,
      role: p.get('metadata[role]') ?? undefined,
    },
    features: {
      customer_update: {
        enabled: bool('features[customer_update][enabled]'),
        allowed_updates: champs,
      },
      payment_method_update: { enabled: bool('features[payment_method_update][enabled]') },
      invoice_history: { enabled: bool('features[invoice_history][enabled]') },
      subscription_cancel: {
        enabled: bool('features[subscription_cancel][enabled]'),
        mode: p.get('features[subscription_cancel][mode]'),
        proration_behavior: p.get('features[subscription_cancel][proration_behavior]'),
      },
      subscription_update: { enabled: bool('features[subscription_update][enabled]') },
    },
  };
}

const fauxStripe = http.createServer(async (req, res) => {
  const auth = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
  const corps = req.method !== 'GET' ? await lireCorps(req) : '';
  appels.push({ method: req.method, url: req.url, auth, corps });

  const repondre = (code, objet) => {
    res.writeHead(code, { 'content-type': 'application/json' });
    res.end(JSON.stringify(objet));
  };

  if (req.url === '/v1/account') return repondre(200, { id: 'acct_panel', country: 'FR' });

  if (req.method === 'POST' && req.url === '/v1/customers') {
    sequence += 1;
    const id = `cus_test_${sequence}`;
    const objet = { id, object: 'customer', email: new URLSearchParams(corps).get('email') };
    clients.set(id, objet);
    return repondre(200, objet);
  }
  const lectureClient = /^\/v1\/customers\/([^/?]+)$/.exec(req.url ?? '');
  if (req.method === 'GET' && lectureClient) {
    const objet = clients.get(decodeURIComponent(lectureClient[1]));
    return objet ? repondre(200, objet) : repondre(404, { error: { code: 'resource_missing' } });
  }

  if (req.method === 'GET' && (req.url ?? '').startsWith('/v1/invoices?')) {
    const client = new URL(req.url, 'http://x').searchParams.get('customer');
    return repondre(200, {
      data: [...factures.values()].filter((f) => f.customer === client),
      has_more: false,
    });
  }
  const lectureFacture = /^\/v1\/invoices\/([^/?]+)$/.exec(req.url ?? '');
  if (req.method === 'GET' && lectureFacture) {
    const objet = factures.get(decodeURIComponent(lectureFacture[1]));
    return objet ? repondre(200, objet) : repondre(404, { error: { code: 'resource_missing' } });
  }

  /*
    LES CONFIGURATIONS DE PORTAIL — l'inventaire du compte.

    Le faux compte porte au départ UNE configuration, celle par DÉFAUT, réglée
    comme l'était réellement le compte de recette avant ce lot :
    `customer_update` ACTIVÉ sur name/email/address/phone. C'est elle qui rendait
    le portail éditeur de l'identité juridique, et c'est elle que le Panel ne
    doit JAMAIS s'approprier — elle n'est pas la sienne.
  */
  if (req.method === 'GET' && (req.url ?? '').startsWith('/v1/billing_portal/configurations')) {
    return repondre(200, { object: 'list', data: [...configurationsPortail.values()], has_more: false });
  }
  if (req.method === 'POST' && req.url === '/v1/billing_portal/configurations') {
    sequence += 1;
    const cfg = configurationDepuisForm(`bpc_test_${sequence}`, corps, { is_default: false });
    configurationsPortail.set(cfg.id, cfg);
    return repondre(200, cfg);
  }
  const majConfiguration = /^\/v1\/billing_portal\/configurations\/([^/?]+)$/.exec(req.url ?? '');
  if (req.method === 'POST' && majConfiguration) {
    const id = decodeURIComponent(majConfiguration[1]);
    const avant = configurationsPortail.get(id);
    if (!avant) return repondre(404, { error: { code: 'resource_missing' } });
    const cfg = configurationDepuisForm(id, corps, { is_default: avant.is_default });
    configurationsPortail.set(id, cfg);
    return repondre(200, cfg);
  }

  if (req.method === 'POST' && req.url === '/v1/billing_portal/sessions') {
    const p = new URLSearchParams(corps);
    sequence += 1;
    return repondre(200, {
      id: `bps_test_${sequence}`,
      url: `https://billing.stripe.test/session/${sequence}`,
      customer: p.get('customer'),
      return_url: p.get('return_url'),
      configuration: p.get('configuration'),
      expires_at: 1_790_000_000,
    });
  }

  if (req.method === 'POST' && ['/v1/products', '/v1/prices', '/v1/checkout/sessions'].includes(req.url)) {
    sequence += 1;
    const prefixes = { '/v1/products': 'prod', '/v1/prices': 'price', '/v1/checkout/sessions': 'cs' };
    const id = `${prefixes[req.url]}_test_${sequence}`;
    return repondre(200, { id, url: `https://pay.test/${id}`, status: 'open' });
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

const portails = () => appels.filter((a) => a.method === 'POST' && a.url === '/v1/billing_portal/sessions');
const configurationsCreees = () => appels.filter(
  (a) => a.method === 'POST' && a.url === '/v1/billing_portal/configurations',
);
const configurationsAlignees = () => appels.filter(
  (a) => a.method === 'POST' && /^\/v1\/billing_portal\/configurations\/.+/.test(a.url ?? ''),
);
const listes = () => appels.filter((a) => a.method === 'GET' && (a.url ?? '').startsWith('/v1/invoices?'));
const lectures = () => appels.filter((a) => a.method === 'GET' && /^\/v1\/invoices\/[^?]+$/.test(a.url ?? ''));
const contactsStripe = () => appels.filter((a) => a.url !== '/v1/account').length;

await new Promise((resolve) => fauxStripe.listen(0, '127.0.0.1', resolve));
const STRIPE_BASE = `http://127.0.0.1:${fauxStripe.address().port}`;

/* ══════════════════════════════════════════════════════════════════════════ */
const { createApp } = await import('../backend/src/app.js');
const registre = await import('../backend/src/services/registry/projectRegistry.service.js');
const controlPlane = await import('../backend/src/services/integratedApi/controlPlane.service.js');
const { seedIntegratedApiCredentialSets } = await import('../backend/src/services/integratedApi/seed.js');
const { resetSyncCore } = await import('../backend/src/services/sync/syncCore.service.js');
const { updateNetworkConfiguration } = await import('../backend/src/services/network/networkConfig.service.js');
const { PanelProjectContract } = await import('../backend/src/models/PanelProjectProjection.model.js');
const binding = await import('../backend/src/services/integratedApi/stripe/stripeResourceBinding.js');

await resetSyncCore();
await seedIntegratedApiCredentialSets();
await updateNetworkConfiguration({ backendUrl: 'https://panel-l63b.test' }, { requirePublic: false });

const { base: panelUrl } = await startServer(createApp());

section('1. Le coffre — la clé du Panel, deux mondes');
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
  mongoUri: MONGO_URI, dbName: 'sbauto_l63b_a', env: 'TEST', projectName: 'SB Auto L6.3B A',
});
const projetB = await startSbAutoInstance({
  mongoUri: MONGO_URI, dbName: 'sbauto_l63b_b', env: 'TEST', projectName: 'SB Auto L6.3B B',
});

const CONTRAT_A = 'contrat-l63b-a-00000000001';
const CONTRAT_B = 'contrat-l63b-b-00000000002';
let idA;
let idB;
let clientA = null;

async function semer(projectId, sourceContractId) {
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
        projectId, hasCurrent: true, sourceContractId, status: 'ACTIVE',
        reference: `CTR-${sourceContractId.slice(-4)}`,
        document: { available: true, status: 'SIGNED', version: 1 },
        pricing: {
          launchFee: { amountIncludingTax: 118_800, amountExcludingTax: 99000, taxAmount: 19800, taxRate: 20, currency: 'EUR', interval: null },
          subscription: { amountIncludingTax: 11_880, amountExcludingTax: 9900, taxAmount: 1980, taxRate: 20, currency: 'EUR', interval: 'MONTH' },
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

const OP = (quoi) => `l63b-${quoi}-000000000000`;

section('2. Deux projets, chacun son contrat et son client');
{
  idA = await appairer(projetA);
  idB = await appairer(projetB);
  for (const id of [idA, idB]) {
  }
  await semer(idA, CONTRAT_A);
  await semer(idB, CONTRAT_B);
  await projetA.syncNow();
  await projetB.syncNow();

  /** Le client de A naît par la capacité de L6.2D — jamais déclaré. */
  const r = await projetA.invokeCapability({
    code: CUSTOMER_ENSURE,
    input: { contractRef: CONTRAT_A, customer: { email: 'client-a@garage.fr', name: 'Garage A' } },
  });
  clientA = r.data?.result?.customerId ?? null;
  check('le client de A est créé par le Panel', /^cus_/.test(clientA ?? ''));

  /** Deux factures pour A, une pour un client étranger. */
  factures.set('in_a_1', {
    id: 'in_a_1', object: 'invoice', customer: clientA, number: 'INV-A-1', status: 'paid',
    paid: true, total: 11_880, tax: 1_980, amount_due: 11_880, amount_paid: 11_880,
    currency: 'eur', created: 1_780_000_000, due_date: null,
    status_transitions: { paid_at: 1_780_000_100 }, billing_reason: 'subscription_cycle',
    hosted_invoice_url: 'https://invoice.stripe.test/a1', invoice_pdf: 'https://invoice.stripe.test/a1.pdf',
  });
  factures.set('in_etranger', {
    id: 'in_etranger', object: 'invoice', customer: 'cus_dun_autre_compte', number: 'INV-X',
    status: 'paid', paid: true, total: 999_99, currency: 'eur', created: 1_780_000_000,
  });
}

/* ══════════════════════════════════════════════════════════════════════════
   A — LE PORTAIL : projet A → son client → une URL
   ══════════════════════════════════════════════════════════════════════════ */
section('A. Le portail s’ouvre sur LE client du contrat');
{
  const avant = portails().length;
  const r = await projetA.invokeCapability({
    code: PORTAL,
    input: { contractRef: CONTRAT_A, returnUrl: 'https://manager.test/abonnement', operationId: OP('portal-1') },
  });

  check('la demande aboutit', r.ok === true);
  check('…et rend une adresse de portail', /^https:\/\/billing\.stripe\.test\//.test(r.data.result.url ?? ''));
  check('UNE session créée', portails().length === avant + 1);

  /**
   * LE CLIENT ENVOYÉ EST CELUI DU LIEN, pas un que le projet aurait nommé —
   * il n'avait aucun moyen de le nommer.
   */
  const envoye = new URLSearchParams(portails().at(-1).corps).get('customer');
  check('…et c’est bien LE client du contrat', envoye === clientA);
  check('l’adresse de retour est transmise telle quelle',
    new URLSearchParams(portails().at(-1).corps).get('return_url') === 'https://manager.test/abonnement');
  check('la clé partie est celle du COFFRE', appels.at(-1).auth === CLE_PANEL);

  /**
   * AUCUNE CLÉ D'IDEMPOTENCE — et c'est le comportement CORRECT.
   *
   * Une session de portail expire et ne se rejoue pas : rendre la même à un
   * client revenu deux heures plus tard lui rendrait une URL morte. La
   * dérogation est explicite dans le transport, et elle ne concerne que lui.
   */
  check('aucune clé d’idempotence sur le portail — il est éphémère',
    !portails().at(-1).idempotency);

  /** Deux ouvertures successives donnent deux sessions NEUVES. */
  const r2 = await projetA.invokeCapability({
    code: PORTAL,
    input: { contractRef: CONTRAT_A, returnUrl: 'https://manager.test/abonnement', operationId: OP('portal-2') },
  });
  check('une seconde ouverture rend une session DIFFÉRENTE',
    r2.ok === true && r2.data.result.url !== r.data.result.url);

  /* ══════════════════════════════════════════════════════════════════════
     LA GOUVERNANCE DU PORTAIL — ce qu'il autorise, et à qui il appartient.
     ══════════════════════════════════════════════════════════════════════ */

  /**
   * LE DÉFAUT QUE CETTE SECTION VERROUILLE.
   *
   * La session ne désignait AUCUNE configuration. Stripe appliquait celle du
   * compte, qui autorisait `customer_update` sur name/email/address/phone : le
   * client pouvait réécrire, depuis le portail, l'identité juridique que
   * `PanelClientCompany` détient. Une seconde autorité, en écriture, sur des
   * données légales — et invisible, puisque aucune ligne de code ne la nommait.
   */
  const envoyeeConfig = new URLSearchParams(portails().at(-1).corps).get('configuration');
  check('la session DÉSIGNE une configuration — jamais celle du compte par défaut',
    Boolean(envoyeeConfig) && envoyeeConfig !== 'bpc_compte_defaut');

  const notre = configurationsPortail.get(envoyeeConfig);
  check('…et cette configuration porte la marque du Panel',
    notre?.metadata?.managedBy === 'PANEL_CONTROL_PLANE'
    && notre?.metadata?.role === 'PROJECT_BILLING_SELF_SERVICE');

  /* ── CE QUE LE PORTAIL REFUSE ─────────────────────────────────────────── */
  check('IDENTITÉ LÉGALE : non modifiable dans le portail',
    notre.features.customer_update.enabled === false);
  check('…et aucun champ ne reste autorisé derrière la désactivation',
    notre.features.customer_update.allowed_updates.length === 0);
  check('OFFRE : non modifiable — un avenant ne se signe pas dans un portail',
    notre.features.subscription_update.enabled === false);

  /* ── CE QUE LE PORTAIL PERMET ─────────────────────────────────────────── */
  check('MOYEN DE PAIEMENT : modifiable', notre.features.payment_method_update.enabled === true);
  check('FACTURES : consultables', notre.features.invoice_history.enabled === true);
  check('RÉSILIATION : permise', notre.features.subscription_cancel.enabled === true);
  check('…et à L’ÉCHÉANCE — la période en cours est payée',
    notre.features.subscription_cancel.mode === 'at_period_end');

  /**
   * LE PANEL NE S'APPROPRIE PAS LA CONFIGURATION DU COMPTE.
   *
   * Modifier « celle qui est par défaut » reviendrait à écraser un réglage qui
   * appartient peut-être à quelqu'un d'autre. On crée la nôtre, et on ne touche
   * à aucune autre.
   */
  const defaut = configurationsPortail.get('bpc_compte_defaut');
  check('la configuration PAR DÉFAUT du compte n’a PAS été modifiée',
    defaut.features.customer_update.enabled === true
    && defaut.features.customer_update.allowed_updates.length === 4);
  check('…et aucune mise à jour ne l’a visée',
    !configurationsAlignees().some((a) => a.url.includes('bpc_compte_defaut')));

  /**
   * CONVERGENTE : deux ouvertures ne créent qu'UNE configuration.
   *
   * Elle est durable, contrairement à la session : en créer une seconde ferait
   * perdre au Panel la réponse à « laquelle est la mienne ».
   */
  check('deux ouvertures n’ont créé qu’UNE configuration', configurationsCreees().length === 1);

  /* ── LE CONTRAT RENDU AU PROJET ───────────────────────────────────────── */
  check('le projet apprend ce que le portail permet, au lieu de le supposer',
    r2.data.result.canUpdateLegalIdentity === false
    && r2.data.result.canUpdatePaymentMethod === true
    && r2.data.result.canCancelSubscription === true
    && r2.data.result.cancellationMode === 'END_OF_PERIOD');
}

section('A bis. Une configuration qui DÉRIVE est remise à sa cible');
{
  /**
   * Un exploitant réactive `customer_update` depuis le tableau de bord — le
   * geste qui a créé le défaut d'origine, et que rien n'empêche de refaire.
   * La prochaine ouverture doit le retirer, et le DIRE.
   */
  const notre = [...configurationsPortail.values()].find((c) => c.metadata?.managedBy === 'PANEL_CONTROL_PLANE');
  notre.features.customer_update = { enabled: true, allowed_updates: ['name', 'address'] };
  notre.features.subscription_update = { enabled: true, default_allowed_updates: ['price'] };

  const avantMaj = configurationsAlignees().length;
  const avantCreation = configurationsCreees().length;

  const r = await projetA.invokeCapability({
    code: PORTAL,
    input: { contractRef: CONTRAT_A, returnUrl: 'https://manager.test/abonnement', operationId: OP('portal-3') },
  });
  check('l’ouverture aboutit malgré la dérive', r.ok === true);

  const relue = configurationsPortail.get(notre.id);
  check('l’identité légale est REDEVENUE non modifiable',
    relue.features.customer_update.enabled === false
    && relue.features.customer_update.allowed_updates.length === 0);
  check('…et l’offre aussi', relue.features.subscription_update.enabled === false);
  check('la configuration a été RÉALIGNÉE, pas recréée',
    configurationsAlignees().length === avantMaj + 1
    && configurationsCreees().length === avantCreation);
}

/* ══════════════════════════════════════════════════════════════════════════
   B & C — LE PROJET B, ET LE CONTRAT INCONNU : refus AVANT le fournisseur
   ══════════════════════════════════════════════════════════════════════════ */
section('B/C. Un contrat qui n’est pas le sien : refusé sans toucher Stripe');
{
  const avant = contactsStripe();

  const vol = await projetB.invokeCapability({
    code: PORTAL,
    input: { contractRef: CONTRAT_A, returnUrl: 'https://x.test/', operationId: OP('portal-vol') },
  });
  check('B ouvrant le portail du contrat de A → refusé', vol.ok === false);

  const inconnu = await projetB.invokeCapability({
    code: PORTAL,
    input: { contractRef: 'contrat-qui-nexiste-pas', returnUrl: 'https://x.test/', operationId: OP('portal-inc') },
  });
  check('un contrat inexistant → MÊME code', inconnu.code === vol.code);
  check('…MÊME message', inconnu.message === vol.message);

  /**
   * ZÉRO APPEL. C'est l'invariant de la phase 6 : sans lui, la durée de réponse
   * suffirait à apprendre quels contrats existent chez les autres.
   */
  check('AUCUN contact avec Stripe sur les deux refus', contactsStripe() === avant);

  /** Les lectures se refusent de la même façon, et aussi tôt. */
  const listeVolee = await projetB.invokeCapability({
    code: INVOICE_LIST, input: { contractRef: CONTRAT_A, operationId: OP('list-vol') },
  });
  const lectureVolee = await projetB.invokeCapability({
    code: INVOICE_READ, input: { contractRef: CONTRAT_A, invoiceId: 'in_a_1', operationId: OP('read-vol') },
  });
  check('B listant les factures de A → refusé', listeVolee.ok === false);
  check('B lisant une facture de A → refusé', lectureVolee.ok === false);
  check('…et toujours AUCUN contact avec Stripe', contactsStripe() === avant);
}

/* ══════════════════════════════════════════════════════════════════════════
   E — LES FACTURES DU PROJET : accessibles, et complètes
   ══════════════════════════════════════════════════════════════════════════ */
section('E. Les factures du contrat sont lisibles, et rendues entières');
{
  const avant = listes().length;
  const r = await projetA.invokeCapability({
    code: INVOICE_LIST, input: { contractRef: CONTRAT_A, operationId: OP('list-1') },
  });
  check('la liste aboutit', r.ok === true);
  check('…et ne contient QUE les factures du client possédé',
    r.data.result.invoices.length === 1 && r.data.result.invoices[0].invoiceId === 'in_a_1');
  check('UNE liste demandée', listes().length === avant + 1);

  /**
   * LES CHAMPS QUE LE PROJET ÉCRIT SONT TOUS LÀ.
   *
   * Sans eux, migrer la lecture aurait appauvri la facture locale — montant
   * hors taxe faux, date de paiement vide — et personne ne l'aurait vu avant la
   * première déclaration.
   */
  const f = r.data.result.invoices[0];
  check('…le total', f.total === 11_880);
  check('…la taxe', f.tax === 1_980);
  check('…la date de paiement effectif', f.paidAt === 1_780_000_100);
  check('…le motif de facturation', f.billingReason === 'subscription_cycle');
  check('…les deux liens', Boolean(f.hostedInvoiceUrl) && Boolean(f.invoicePdfUrl));

  const une = await projetA.invokeCapability({
    code: INVOICE_READ, input: { contractRef: CONTRAT_A, invoiceId: 'in_a_1', operationId: OP('read-1') },
  });
  check('la lecture unitaire aboutit', une.ok === true);
  check('…et rend la même facture', une.data.result.invoiceId === 'in_a_1');
}

/* ══════════════════════════════════════════════════════════════════════════
   F — UNE FACTURE D'UN AUTRE CLIENT : la filiation refuse
   ══════════════════════════════════════════════════════════════════════════ */
section('F. Une facture d’un autre client est refusée, pas rendue');
{
  const avantL = lectures().length;
  const r = await projetA.invokeCapability({
    code: INVOICE_READ,
    input: { contractRef: CONTRAT_A, invoiceId: 'in_etranger', operationId: OP('read-etr') },
  });

  check('la lecture est REFUSÉE', r.ok === false);
  check('…du même refus qu’une facture inexistante',
    r.code === 'CAPABILITY_RESOURCE_NOT_OWNED');

  /**
   * L'appel A EU LIEU — seul Stripe sait à qui est une facture — mais
   * l'appartenance du CLIENT avait été prouvée avant. Le projet ne peut donc
   * pas s'en servir comme d'un oracle : il ne peut sonder que dans le
   * périmètre d'un contrat qui est déjà le sien.
   */
  check('la lecture a bien été tentée', lectures().length === avantL + 1);
  check('…mais rien de l’autre client n’est rendu',
    !JSON.stringify(r).includes('cus_dun_autre_compte'));

  const inexistante = await projetA.invokeCapability({
    code: INVOICE_READ,
    input: { contractRef: CONTRAT_A, invoiceId: 'in_nexiste_pas', operationId: OP('read-404') },
  });
  check('une facture inexistante → refus, jamais une erreur brute', inexistante.ok === false);
}

/* ══════════════════════════════════════════════════════════════════════════
   D — TEST / PROD
   ══════════════════════════════════════════════════════════════════════════ */
section('D. TEST et PROD ne se lisent pas l’un l’autre');
{
  const enProd = await binding.describeOwnership({
    projectId: idA, environment: 'PROD', resourceType: 'CUSTOMER', resourceId: clientA,
  });
  check('le client TEST n’existe pas en PROD', enProd.allowed === false);
  check('…motif « aucun lien »', enProd.reason === 'NO_BINDING');
  check('la clé PROD n’a jamais parlé à Stripe',
    appels.every((a) => a.auth !== CLE_PANEL_PROD));
}

/* ══════════════════════════════════════════════════════════════════════════
   H / I — LE PANEL MUET : erreur franche, aucun repli local
   ══════════════════════════════════════════════════════════════════════════ */
section('H/I. Panel injoignable : échec explicite, jamais de repli');
{
  const avant = contactsStripe();

  /** On coupe le fournisseur pour le seul portail. */
  const original = fauxStripe.listeners('request')[0];
  fauxStripe.removeAllListeners('request');
  fauxStripe.on('request', (req, res) => {
    if ((req.url ?? '').includes('billing_portal')) {
      appels.push({ method: req.method, url: req.url, auth: null, corps: '' });
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'panne simulée' } }));
      return;
    }
    original(req, res);
  });

  const r = await projetA.invokeCapability({
    code: PORTAL,
    input: { contractRef: CONTRAT_A, returnUrl: 'https://manager.test/abo', operationId: OP('portal-ko') },
  });
  check('la demande ÉCHOUE franchement', r.ok === false);
  check('…et ne rend aucune adresse', !r.data?.result?.url);

  fauxStripe.removeAllListeners('request');
  fauxStripe.on('request', original);
  check('le fournisseur a bien été sollicité, puis a refusé', contactsStripe() > avant);
}

/* ══════════════════════════════════════════════════════════════════════════
   J — LA SURFACE LOCALE, VUE DEPUIS LE PROJET
   ══════════════════════════════════════════════════════════════════════════ */
section('J. Ce que le projet ne peut plus faire — prouvé DE SON CÔTÉ');
{
  /**
   * ══ POURQUOI CETTE SECTION NE LIT PAS LE CODE DU PROJET ═══════════════════
   *
   * La tentation était d'importer `stripe.provider.js` depuis ici et de
   * constater qu'il n'expose plus que `retrievePaymentIntent`. Une règle
   * d'architecture l'interdit, et elle a raison : seuls trois outils d'atelier
   * déclarés touchent au dépôt voisin, sans quoi la frontière entre les deux
   * dépôts s'effacerait un import à la fois.
   *
   * L'invariant de surface vit donc là où il s'applique —
   * `SB Auto 06/backend/src/scripts/stripe-local-surface.test.js` — qui nomme
   * la méthode restante une par une et rougit si une autre revient.
   *
   * Ce que CETTE suite prouve, et qu'aucune lecture de code ne pourrait
   * prouver : sur la totalité du trafic réellement émis, une seule clé a parlé
   * à Stripe, et ce n'est pas celle du projet. C'est un fait d'exécution, pas
   * une promesse de source.
   */
  const cles = [...new Set(appels.map((a) => a.auth).filter(Boolean))];
  check('un seul porteur de clé sur tout le scénario', cles.length === 1);
  check('…et les trois verbes du lot sont passés par lui',
    portails().length > 0 && listes().length > 0 && lectures().length > 0);
}

section('K. Bilan');
{
  const cles = new Set(appels.map((a) => a.auth).filter(Boolean));
  check('exactement UNE clé a parlé à Stripe', cles.size === 1);
  check('…celle du coffre du Panel, en TEST', cles.has(CLE_PANEL));
  check('la sentinelle du PROJET n’apparaît nulle part',
    !JSON.stringify(appels).includes(CLE_PROJET));

  for (const [nom, instance] of [['A', projetA], ['B', projetB]]) {
    const dump = JSON.stringify(await instance.dbDump());
    check(`la base du projet ${nom} ne contient aucune clé d’appel`,
      !dump.includes(CLE_PANEL) && !dump.includes(CLE_PANEL_PROD) && !dump.includes(CLE_PROJET));
  }
}

await projetA.stop();
await projetB.stop();
fauxStripe.close();
finish();
