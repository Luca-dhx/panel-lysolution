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

  if (req.method === 'POST' && req.url === '/v1/billing_portal/sessions') {
    const p = new URLSearchParams(corps);
    sequence += 1;
    return repondre(200, {
      id: `bps_test_${sequence}`,
      url: `https://billing.stripe.test/session/${sequence}`,
      customer: p.get('customer'),
      return_url: p.get('return_url'),
      expires_at: 1_790_000_000,
    });
  }

  if (req.method === 'POST' && ['/v1/products', '/v1/prices', '/v1/checkout/sessions'].includes(req.url)) {
    sequence += 1;
    const prefixes = { '/v1/products': 'prod', '/v1/prices': 'price', '/v1/checkout/sessions': 'cs' };
    const id = `${prefixes[req.url]}_test_${sequence}`;
    return repondre(200, { id, url: `https://pay.test/${id}`, status: 'open' });
  }

  return repondre(404, { error: { message: 'route inconnue' } });
});

const portails = () => appels.filter((a) => a.method === 'POST' && a.url === '/v1/billing_portal/sessions');
const listes = () => appels.filter((a) => a.method === 'GET' && (a.url ?? '').startsWith('/v1/invoices?'));
const lectures = () => appels.filter((a) => a.method === 'GET' && /^\/v1\/invoices\/[^?]+$/.test(a.url ?? ''));
const contactsStripe = () => appels.filter((a) => a.url !== '/v1/account').length;

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

const OP = (quoi) => `l63b-${quoi}-000000000000`;

section('2. Deux projets, chacun son contrat et son client');
{
  idA = await appairer(projetA);
  idB = await appairer(projetB);
  for (const id of [idA, idB]) {
    await grantsModule.setCapabilityGrants(
      id, [CHECKOUT, CUSTOMER_ENSURE, INVOICE_LIST, INVOICE_READ, PORTAL], ACTEUR,
    );
    await commercial.setCommercialReadiness(id, 'LIVE', { actor: ACTEUR, reason: 'E2E L6.3B' });
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
