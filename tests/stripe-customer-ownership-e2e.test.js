// UN CONTRAT, UN CLIENT — l'E2E du lot (L6.2D).
//
// ══ LA DÉCOUVERTE QUE CE TEST DÉFEND ═════════════════════════════════════════
//
// Le client Stripe n'est PAS global au projet. Un projet ayant eu trois
// contrats a trois clients, et c'est correct : chaque contrat porte son propre
// engagement, ses propres factures, souvent son propre signataire.
//
//     Projet A                     et NON :     Projet A
//      ├── Contrat 1 → cus_111                   └── cus_unique
//      └── Contrat 2 → cus_222
//
// La section 5 en fait un invariant exécutable : deux contrats du même projet,
// deux clients distincts, deux liens distincts. Une implémentation
// `projectId → customerId` la ferait échouer immédiatement.
//
// ══ CE QUE CE TEST MONTE ═════════════════════════════════════════════════════
//
//   · un vrai Panel, un vrai port, sa vraie base ;
//   · deux vraies instances SB Auto, chacune son processus, sa base, son jeton ;
//   · un faux Stripe HTTP qui DÉDUPLIQUE sur `Idempotency-Key`, comme le vrai ;
//   · des sentinelles distinctes pour la clé du Panel et celle du projet.
import http from 'node:http';

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
const CLE_PANEL = `${prefixe('test')}L62DSENTINELLEPANEL0000000001`;
const CLE_PANEL_PROD = `${prefixe('live')}L62DSENTINELLEPANELPROD000002`;
const CLE_PROJET = `${prefixe('test')}L62DSENTINELLEPROJETJAMAISVUE3`;

const ACTEUR = { userId: 'u-dev', userEmail: 'dev@panel.test' };
const ENSURE = 'billing.customer.ensure';
const CHECKOUT = 'billing.checkout.create';

/* ══════════════════════════════════════════════════════════════════════════
   UN FAUX STRIPE QUI DÉDUPLIQUE POUR DE VRAI.
   Sans idempotence côté serveur, « rejouer la même clé » ne prouverait rien.
   ══════════════════════════════════════════════════════════════════════════ */
const appels = [];
const parCle = new Map();
const parId = new Map();
let sequence = 0;
/** Prochain POST /v1/customers : créer, puis couper la connexion. */
let avalerProchaineCreation = false;

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

  if (req.method === 'POST' && req.url === '/v1/customers') {
    if (avalerProchaineCreation) {
      /**
       * LE CAS QUI JUSTIFIE LA CONVERGENCE : le client EST créé, et la réponse
       * ne revient jamais. Le Panel ne sait pas ; Stripe, si.
       */
      avalerProchaineCreation = false;
      sequence += 1;
      fabriquer(cle);
      req.socket.destroy();
      return;
    }
    const connu = parCle.get(cle);
    if (connu) return repondre(200, connu);
    sequence += 1;
    return repondre(200, fabriquer(cle));
  }

  const lecture = /^\/v1\/customers\/([^/?]+)$/.exec(req.url ?? '');
  if (req.method === 'GET' && lecture) {
    const client = parId.get(decodeURIComponent(lecture[1]));
    if (!client) return repondre(404, { error: { code: 'resource_missing', message: 'No such customer' } });
    return repondre(200, client);
  }

  if (req.method === 'POST' && req.url === '/v1/checkout/sessions') {
    const connue = parCle.get(cle);
    if (connue) return repondre(200, connue);
    sequence += 1;
    const id = `cs_test_${sequence}`;
    const session = { id, object: 'checkout.session', url: `https://pay.test/${id}`, status: 'open', payment_status: 'unpaid' };
    parCle.set(cle, session);
    parId.set(id, session);
    return repondre(200, session);
  }

  return repondre(404, { error: { message: 'route inconnue' } });
});

function fabriquer(cle) {
  const id = `cus_test_${sequence}`;
  const client = { id, object: 'customer', email: null, name: null, deleted: false };
  parCle.set(cle, client);
  parId.set(id, client);
  return client;
}

const creations = () => appels.filter((a) => a.method === 'POST' && a.url === '/v1/customers');
const clients = () => [...parId.keys()].filter((id) => id.startsWith('cus_'));

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
const { default: PanelStripeResourceBinding } = await import('../backend/src/models/PanelStripeResourceBinding.model.js');
const { default: PanelCapabilityOperation } = await import('../backend/src/models/PanelCapabilityOperation.model.js');
const binding = await import('../backend/src/services/integratedApi/stripe/stripeResourceBinding.js');
const autorite = await import('../backend/src/services/integratedApi/stripe/stripeCustomerAuthority.js');

await resetSyncCore();
await seedIntegratedApiCredentialSets();
await updateNetworkConfiguration({ backendUrl: 'https://panel-l62d.test' }, { requirePublic: false });

const { base: panelUrl } = await startServer(createApp());

section('1. Le coffre — deux mondes, une seule clé servira');
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

/* ══════════════════════════════════════════════════════════════════════════
   2. DEUX PROJETS RÉELS — et DEUX contrats pour le premier
   ══════════════════════════════════════════════════════════════════════════ */
const projetA = await startSbAutoInstance({
  mongoUri: MONGO_URI, dbName: 'sbauto_l62d_a', env: 'TEST', projectName: 'SB Auto L6.2D A',
});
const projetB = await startSbAutoInstance({
  mongoUri: MONGO_URI, dbName: 'sbauto_l62d_b', env: 'TEST', projectName: 'SB Auto L6.2D B',
});

const CONTRAT_A1 = 'contrat-l62d-a1-0000000001';
const CONTRAT_A2 = 'contrat-l62d-a2-0000000002';
const CONTRAT_B1 = 'contrat-l62d-b1-0000000003';
let idA;
let idB;

/**
 * La projection porte UN contrat courant par projet — c'est le modèle du Panel.
 * Pour éprouver deux contrats du même projet, on bascule la projection de A
 * d'un contrat à l'autre, exactement comme le ferait une résiliation suivie
 * d'un nouvel engagement.
 */
async function semer(projectId, sourceContractId, reference) {
  await PanelProjectContract.updateOne(
    { projectId },
    {
      $set: {
        projectId,
        hasCurrent: true,
        sourceContractId,
        status: 'ACTIVE',
        reference,
        pricing: {
          launchFee: { amountIncludingTax: 118_800, currency: 'EUR', interval: null },
          subscription: null,
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
  await grantsModule.setCapabilityGrants(idA, [ENSURE, CHECKOUT], ACTEUR);
  await grantsModule.setCapabilityGrants(idB, [ENSURE, CHECKOUT], ACTEUR);
  await projetA.syncNow();
  await projetB.syncNow();
  await semer(idA, CONTRAT_A1, 'CTR-A1');
  await semer(idB, CONTRAT_B1, 'CTR-B1');
  check('deux projets distincts', typeof idA === 'string' && idA !== idB);
}

/* ══════════════════════════════════════════════════════════════════════════
   3. PRÉ-OUVERTURE — la politique GÉNÉRIQUE, sans exception Stripe
   ══════════════════════════════════════════════════════════════════════════ */
section('3. En pré-ouverture, la politique décide — et elle AUTORISE');
{
  const avant = creations().length;
  const enPreouverture = await projetA.invokeCapability({
    code: ENSURE,
    input: { contractRef: CONTRAT_A1, customer: { email: 'client@garage.fr', name: 'Garage A' } },
  });

  /**
   * `billing.customer.ensure` est REVERSIBLE_EXTERNAL_WRITE dans la table de
   * L1.75, pas FINANCIAL_WRITE : créer un client ne débite rien et se supprime.
   * La pré-ouverture ne l'interdit donc PAS — et ce n'est pas une exception
   * Stripe, c'est la politique générique appliquée à un effet réversible.
   *
   * On le vérifie ici plutôt que de l'affirmer, et on vérifie SURTOUT que la
   * différence vient de l'effet : la capacité financière du même projet, au
   * même instant, est refusée.
   */
  check('le client est AUTORISÉ en pré-ouverture', enPreouverture.ok === true);
  check('…et il a réellement été créé', creations().length === avant + 1);

  const financiere = await projetA.invokeCapability({
    code: CHECKOUT,
    input: {
      contractRef: CONTRAT_A1, paymentType: 'LAUNCH_FEE',
      successUrl: 'https://a.test/ok', cancelUrl: 'https://a.test/ko',
      operationId: `launch-${CONTRAT_A1}-v1-a1-TEST`,
    },
  });
  check('…tandis que l’écriture FINANCIÈRE reste bloquée',
    financiere.code === 'CAPABILITY_BLOCKED_PREOPENING');
  check('…et le refus nomme l’effet', financiere.panelDetails?.effect === 'FINANCIAL_WRITE');

  await commercial.setCommercialReadiness(idA, 'LIVE', { actor: ACTEUR, reason: 'E2E L6.2D' });
  await commercial.setCommercialReadiness(idB, 'LIVE', { actor: ACTEUR, reason: 'E2E L6.2D' });
}

/* ══════════════════════════════════════════════════════════════════════════
   4. LE CHEMIN COMPLET — et la convergence par contrat
   ══════════════════════════════════════════════════════════════════════════ */
let clientA1;
section('4. Un contrat, un client — et le rejeu ne double pas');
{
  await semer(idA, CONTRAT_A1, 'CTR-A1');
  const avant = creations().length;

  const premier = await projetA.invokeCapability({
    code: ENSURE,
    input: { contractRef: CONTRAT_A1, customer: { email: 'client@garage.fr', name: 'Garage A' } },
  });
  check('la capacité répond', premier.ok === true);
  clientA1 = premier.data.result.customerId;
  check('…un client est rendu', /^cus_test_\d+$/.test(clientA1));
  check('…et il EXISTAIT déjà (créé en §3)', premier.data.result.status === 'EXISTING');
  check('aucune création supplémentaire', creations().length === avant);

  const post = creations().at(-1);
  check('la clé partie est celle du COFFRE', post.auth === CLE_PANEL);
  check('la clé du PROJET n’a jamais servi', appels.every((a) => a.auth !== CLE_PROJET));
  check('la clé PROD n’a jamais servi', appels.every((a) => a.auth !== CLE_PANEL_PROD));

  const params = new URLSearchParams(post.corps);
  check('metadata contractId = celui de la PROJECTION', params.get('metadata[contractId]') === CONTRAT_A1);
  check('metadata providerMode conservée', params.get('metadata[providerMode]') === 'TEST');
  check('l’adresse du signataire est transmise', params.get('email') === 'client@garage.fr');
  check('aucune adresse postale ne traverse', !post.corps.includes('address'));
  check('aucun moyen de paiement ne traverse', !post.corps.includes('payment_method'));

  const lien = await binding.findBinding({
    environment: 'TEST', resourceType: 'CUSTOMER', resourceId: clientA1,
  });
  check('le client est LIÉ au projet', lien?.projectId === idA);
  check('…et l’acte qui l’a produit porte le CONTRAT',
    lien.createdByOperationId === autorite.customerOperationId({ environment: 'TEST', contractId: CONTRAT_A1 }));
  check('…par la route « le Panel crée »', lien.source === 'PANEL_CREATED');

  /**
   * L'IDENTITÉ DE L'ACTE N'EST PAS NOMMÉE PAR LE PROJET. Le contrat d'entrée
   * refuse `operationId` : sans ce refus, deux appels de noms différents pour
   * le même contrat produiraient deux clients.
   */
  const nomme = await projetA.invokeCapability({
    code: ENSURE,
    input: {
      contractRef: CONTRAT_A1,
      customer: { name: 'Garage A' },
      operationId: 'op-que-le-projet-invente-1',
    },
  });
  check('un operationId dans la charge utile → REFUSÉ', nomme.ok === false);
  check('…code CAPABILITY_INPUT_INVALID', nomme.code === 'CAPABILITY_INPUT_INVALID');
  check('…et aucun client de plus', creations().length === avant);

  // Un client à adopter ne peut même pas être proposé.
  const adoption = await projetA.invokeCapability({
    code: ENSURE,
    input: { contractRef: CONTRAT_A1, customer: { name: 'X' }, customerId: 'cus_test_1' },
  });
  check('proposer un client à adopter → REFUSÉ', adoption.code === 'CAPABILITY_INPUT_INVALID');
}

/* ══════════════════════════════════════════════════════════════════════════
   5. L'INVARIANT DU LOT — le client n'est PAS un singleton du projet
   ══════════════════════════════════════════════════════════════════════════ */
section('5. Deux contrats du MÊME projet → deux clients');
{
  await semer(idA, CONTRAT_A2, 'CTR-A2');
  const avant = creations().length;

  const second = await projetA.invokeCapability({
    code: ENSURE,
    input: { contractRef: CONTRAT_A2, customer: { email: 'client2@garage.fr', name: 'Garage A bis' } },
  });
  check('le second contrat obtient un client', second.ok === true);
  const clientA2 = second.data.result.customerId;
  check('…et il vient d’être CRÉÉ', second.data.result.status === 'CREATED');

  check('CUSTOMER_OWNERSHIP_IS_NOT_PROJECT_SINGLETON', clientA2 !== clientA1);
  check('…une création a bien eu lieu', creations().length === avant + 1);

  const liens = await PanelStripeResourceBinding.find({
    projectId: idA, environment: 'TEST', resourceType: 'CUSTOMER',
  }).lean();
  check('le MÊME projet porte deux liens CUSTOMER', liens.length === 2);
  check('…un par contrat, jamais confondus',
    new Set(liens.map((l) => l.createdByOperationId)).size === 2);

  // Et chaque contrat retrouve LE SIEN, pas celui de l'autre.
  await semer(idA, CONTRAT_A1, 'CTR-A1');
  const relu1 = await projetA.invokeCapability({
    code: ENSURE, input: { contractRef: CONTRAT_A1, customer: { name: 'Garage A' } },
  });
  check('le contrat 1 retrouve SON client', relu1.data.result.customerId === clientA1);
  await semer(idA, CONTRAT_A2, 'CTR-A2');
  const relu2 = await projetA.invokeCapability({
    code: ENSURE, input: { contractRef: CONTRAT_A2, customer: { name: 'Garage A bis' } },
  });
  check('le contrat 2 retrouve LE SIEN', relu2.data.result.customerId === clientA2);
  check('…et toujours aucune création de plus', creations().length === avant + 1);
}

/* ══════════════════════════════════════════════════════════════════════════
   6. CONCURRENCE — huit appels, un client
   ══════════════════════════════════════════════════════════════════════════ */
const CONTRAT_A3 = 'contrat-l62d-a3-0000000004';
section('6. Huit appels simultanés pour le même contrat');
{
  await semer(idA, CONTRAT_A3, 'CTR-A3');
  const avant = creations().length;
  const clientsAvant = clients().length;

  const entree = { contractRef: CONTRAT_A3, customer: { email: 'a3@garage.fr', name: 'Garage A3' } };
  const resultats = await Promise.all(
    Array.from({ length: 8 }, () => projetA.invokeCapability({ code: ENSURE, input: entree })),
  );

  const reussis = resultats.filter((r) => r.ok);
  const refuses = resultats.filter((r) => !r.ok);
  check('au moins un appel aboutit', reussis.length >= 1);
  check('les autres sont refusés, jamais servis en double',
    refuses.every((r) => r.code === 'CAPABILITY_OPERATION_IN_FLIGHT'));
  check('UN SEUL client créé chez Stripe', clients().length === clientsAvant + 1);
  check('…et tous les succès désignent le même',
    new Set(reussis.map((r) => r.data.result.customerId)).size === 1);
  check('…une seule création réellement partie', creations().length === avant + 1);

  const liens = await PanelStripeResourceBinding.countDocuments({
    projectId: idA, environment: 'TEST', resourceType: 'CUSTOMER',
    createdByOperationId: autorite.customerOperationId({ environment: 'TEST', contractId: CONTRAT_A3 }),
  });
  check('un seul lien', liens === 1);
}

/* ══════════════════════════════════════════════════════════════════════════
   7. CRASH APRÈS STRIPE, AVANT LE LIEN
   ══════════════════════════════════════════════════════════════════════════ */
const CONTRAT_A4 = 'contrat-l62d-a4-0000000005';
section('7. Le Panel meurt entre la création et le lien');
{
  await semer(idA, CONTRAT_A4, 'CTR-A4');
  const premier = await projetA.invokeCapability({
    code: ENSURE, input: { contractRef: CONTRAT_A4, customer: { name: 'Garage A4' } },
  });
  const clientA4 = premier.data.result.customerId;
  const clientsApres = clients().length;
  const acte = autorite.customerOperationId({ environment: 'TEST', contractId: CONTRAT_A4 });

  // Le crash : ni lien, ni opération conclue, et l'opération est ANCIENNE.
  await PanelStripeResourceBinding.deleteOne({ environment: 'TEST', resourceId: clientA4 });
  await PanelCapabilityOperation.updateOne(
    { projectId: idA, operationId: acte },
    { $set: { status: 'PENDING', settledAt: null, startedAt: new Date(Date.now() - 10 * 60_000).toISOString() } },
  );
  check('plus aucun lien pour ce client',
    (await binding.findBinding({ environment: 'TEST', resourceType: 'CUSTOMER', resourceId: clientA4 })) === null);

  const reprise = await projetA.invokeCapability({
    code: ENSURE, input: { contractRef: CONTRAT_A4, customer: { name: 'Garage A4' } },
  });
  check('la reprise aboutit', reprise.ok === true);
  check('…sur LE MÊME client', reprise.data.result.customerId === clientA4);
  check('…et Stripe n’en a créé aucun autre', clients().length === clientsApres);

  const lien = await binding.findBinding({
    environment: 'TEST', resourceType: 'CUSTOMER', resourceId: clientA4,
  });
  check('le lien est RÉPARÉ', lien?.projectId === idA);
  check('…et désigne toujours le même acte', lien.createdByOperationId === acte);
}

/* ══════════════════════════════════════════════════════════════════════════
   8. UNKNOWN — la réponse se perd
   ══════════════════════════════════════════════════════════════════════════ */
const CONTRAT_A5 = 'contrat-l62d-a5-0000000006';
section('8. Réponse perdue : aucune seconde création');
{
  await semer(idA, CONTRAT_A5, 'CTR-A5');
  const clientsAvant = clients().length;
  avalerProchaineCreation = true;

  const perdu = await projetA.invokeCapability({
    code: ENSURE, input: { contractRef: CONTRAT_A5, customer: { name: 'Garage A5' } },
  });
  check('l’appel échoue', perdu.ok === false);
  check('…en CAPABILITY_TIMEOUT, pas en « indisponible »', perdu.code === 'CAPABILITY_TIMEOUT');
  check('Stripe a pourtant bien créé le client', clients().length === clientsAvant + 1);

  const acte = autorite.customerOperationId({ environment: 'TEST', contractId: CONTRAT_A5 });
  const operation = await PanelCapabilityOperation.findOne({ projectId: idA, operationId: acte }).lean();
  check('l’opération est marquée UNKNOWN — pas FAILED', operation?.status === 'UNKNOWN');

  const reprise = await projetA.invokeCapability({
    code: ENSURE, input: { contractRef: CONTRAT_A5, customer: { name: 'Garage A5' } },
  });
  check('la reprise converge', reprise.ok === true);
  check('…sans créer de client supplémentaire', clients().length === clientsAvant + 1);
  const lien = await binding.findBinding({
    environment: 'TEST', resourceType: 'CUSTOMER', resourceId: reprise.data.result.customerId,
  });
  check('le client perdu est retrouvé ET lié', lien?.projectId === idA);
}

/* ══════════════════════════════════════════════════════════════════════════
   9. CROSS-TENANT
   ══════════════════════════════════════════════════════════════════════════ */
section('9. Le projet B n’atteint rien de A');
{
  const clientsAvant = clients().length;

  // B présente le contrat de A.
  const vol = await projetB.invokeCapability({
    code: ENSURE, input: { contractRef: CONTRAT_A1, customer: { name: 'Voleur' } },
  });
  check('B demandant le client du contrat de A → refusé', vol.ok === false);
  check('…motif CONTRACT_NOT_OWNED', vol.panelDetails?.reason === 'CONTRACT_NOT_OWNED');
  check('…et AUCUN client créé', clients().length === clientsAvant);

  // Une référence inventée doit rendre EXACTEMENT le même refus.
  const invente = await projetB.invokeCapability({
    code: ENSURE, input: { contractRef: 'contrat-qui-nexiste-pas', customer: { name: 'X' } },
  });
  check('une référence inventée → même code', invente.code === vol.code);
  check('…même motif', invente.panelDetails?.reason === vol.panelDetails?.reason);
  check('…même message', invente.message === vol.message);

  // B ne peut pas adopter le client de A par le registre.
  let conflit = null;
  try {
    await binding.bindResource({
      projectId: idB, environment: 'TEST', resourceType: 'CUSTOMER', resourceId: clientA1,
    });
  } catch (err) { conflit = err; }
  check('B adoptant le client de A → conflit', conflit?.code === 'STRIPE_RESOURCE_ALREADY_BOUND');
  const toujours = await binding.findBinding({
    environment: 'TEST', resourceType: 'CUSTOMER', resourceId: clientA1,
  });
  check('…le client reste à A', toujours.projectId === idA);

  // Sonder l'existence : « à un autre » et « inconnu » se refusent pareil.
  const refusAutre = await binding.describeOwnership({
    projectId: idB, environment: 'TEST', resourceType: 'CUSTOMER', resourceId: clientA1,
  });
  const refusInconnu = await binding.describeOwnership({
    projectId: idB, environment: 'TEST', resourceType: 'CUSTOMER', resourceId: 'cus_test_inexistant',
  });
  check('les deux refus sont négatifs', !refusAutre.allowed && !refusInconnu.allowed);

  // B obtient SON client, pour SON contrat.
  const propre = await projetB.invokeCapability({
    code: ENSURE, input: { contractRef: CONTRAT_B1, customer: { name: 'Garage B' } },
  });
  check('B obtient son propre client', propre.ok === true);
  const lienB = await binding.findBinding({
    environment: 'TEST', resourceType: 'CUSTOMER', resourceId: propre.data.result.customerId,
  });
  check('…lié à LUI', lienB.projectId === idB);
  check('…et ce n’est pas celui de A', propre.data.result.customerId !== clientA1);
}

/* ══════════════════════════════════════════════════════════════════════════
   10. LES MONDES
   ══════════════════════════════════════════════════════════════════════════ */
section('10. Le même contrat, deux mondes, deux clients');
{
  check('l’acte porte le monde',
    autorite.customerOperationId({ environment: 'TEST', contractId: CONTRAT_A1 })
    !== autorite.customerOperationId({ environment: 'PROD', contractId: CONTRAT_A1 }));

  const enProd = await binding.describeOwnership({
    projectId: idA, environment: 'PROD', resourceType: 'CUSTOMER', resourceId: clientA1,
  });
  check('le client TEST de A n’existe pas en PROD', enProd.allowed === false);
  check('…motif « aucun lien »', enProd.reason === 'NO_BINDING');

  // Le projet ne peut pas choisir son monde.
  for (const champ of ['environment', 'mode', 'apiKey', 'provider', 'baseUrl', 'projectId']) {
    const r = await projetA.invokeCapability({
      code: ENSURE,
      input: { contractRef: CONTRAT_A1, customer: { name: 'X' }, [champ]: 'PROD' },
    });
    check(`« ${champ} » dans la charge utile → refusé`, r.ok === false);
  }
}

/* ══════════════════════════════════════════════════════════════════════════
   11. BILAN
   ══════════════════════════════════════════════════════════════════════════ */
section('11. Bilan — une clé, aucune fuite, aucun doublon');
{
  const cles = new Set(appels.map((a) => a.auth).filter(Boolean));
  check('exactement UNE clé a parlé à Stripe', cles.size === 1);
  check('…celle du coffre du Panel, en TEST', cles.has(CLE_PANEL));
  check('la sentinelle du projet n’apparaît nulle part',
    !JSON.stringify(appels).includes(CLE_PROJET));

  check('aucune création de client sans clé d’idempotence',
    creations().every((a) => typeof a.cle === 'string' && a.cle.length > 0));
  /**
   * L'INVARIANT FINAL : autant de clients chez Stripe que de clés distinctes.
   * Une clé qui aurait produit deux clients serait le doublon que tout ce lot
   * interdit.
   */
  const clesDistinctes = new Set(creations().map((a) => a.cle));
  check('autant de clients que de clés d’idempotence distinctes',
    clients().length === clesDistinctes.size);

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
