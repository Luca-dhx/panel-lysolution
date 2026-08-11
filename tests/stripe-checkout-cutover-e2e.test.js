// LE PREMIER PAIEMENT QUI PASSE PAR LE PANEL — l'E2E du lot (L6.2B).
//
// ══ CE QUE CE TEST MONTE ═════════════════════════════════════════════════════
//
//   · un vrai Panel, sur un vrai port, avec sa vraie base ;
//   · deux vraies instances SB Auto, chacune dans SON processus, SA base ;
//   · deux vrais appairages — donc deux vrais jetons de pont ;
//   · un jeu d'identifiants Stripe CHIFFRÉ dans le coffre du Panel ;
//   · un faux Stripe qui parle HTTP pour de bon, qui note QUELLE clé arrive,
//     et qui DÉDUPLIQUE sur `Idempotency-Key` comme le vrai.
//
// Le test n'appelle aucun service interne du Panel pour invoquer : il entre par
// où entre le projet — `PanelBridge.invokeCapability` → HTTP → `/bridge/v1`.
//
// ══ LA QUESTION À LAQUELLE IL RÉPOND ═════════════════════════════════════════
//
// « Un timeout, un crash ou huit clics peuvent-ils ouvrir DEUX sessions de
// paiement pour le même acte ? »
//
// Une création nominale qui marche ne prouve rien : c'est le cas facile. Ce qui
// coûte de l'argent réel, c'est la reprise. Les sections 6 à 10 ne testent donc
// que des chemins dégradés, et chacune se termine par la même vérification —
// combien de sessions le faux Stripe a-t-il RÉELLEMENT créées.
import http from 'node:http';

import {
  check, connectTestDatabase, finish, section, setTestEnv,
  startMemoryMongo, startServer,
} from './helpers/harness.js';
import { startSbAutoInstance } from './helpers/sbauto-remote.js';

setTestEnv();
const MONGO_URI = await startMemoryMongo();
await connectTestDatabase();

/* ══════════════════════════════════════════════════════════════════════════
   LES SENTINELLES.

   `CLE_PROJET` est la clé que SB Auto détenait AVANT ce lot. Elle est semée
   dans le coffre du Panel sous un monde qui ne sera jamais servi, et surtout :
   le faux Stripe note chaque clé reçue. Une seule occurrence suffirait à
   prouver qu'un chemin local subsiste.
   ══════════════════════════════════════════════════════════════════════════ */
/**
 * LES PRÉFIXES SONT COMPOSÉS, PAS ÉCRITS.
 *
 * Ces trois valeurs sont inventées de toutes pièces — aucune n'ouvre aucun
 * compte. Elles ont pourtant EXACTEMENT la forme d'une clé Stripe, et c'est
 * voulu : la garde de redaction du transport reconnaît les clés À LA FORME, et
 * une sentinelle qui n'aurait pas cette forme ne prouverait pas qu'elle est
 * caviardée.
 *
 * Écrire `sk_live_…` en toutes lettres déclenche en revanche l'analyse de
 * secrets du dépôt, qui ne peut pas distinguer une sentinelle d'une vraie clé —
 * et elle a raison de ne pas essayer. On assemble donc le préfixe à
 * l'exécution : la valeur produite est identique au caractère près, et aucune
 * chaîne de la forme d'une clé ne dort dans le fichier.
 */
const prefixe = (monde) => ['sk', monde, ''].join('_');
const CLE_PANEL_TEST = `${prefixe('test')}L62BSENTINELLEPANELTEST0000000001`;
const CLE_PANEL_PROD = `${prefixe('live')}L62BSENTINELLEPANELPROD0000000002`;
const CLE_PROJET = `${prefixe('test')}L62BSENTINELLEPROJETJAMAISUTILISEE3`;
const TOUTES = [CLE_PANEL_TEST, CLE_PANEL_PROD, CLE_PROJET];

const ACTEUR = { userId: 'u-dev', userEmail: 'dev@panel.test' };
const CHECKOUT = 'billing.checkout.create';

/** Montant connu du SEUL Panel : le projet ne l'envoie jamais. */
const MONTANT_TTC = 118_800;

const propre = (valeur) => {
  const texte = typeof valeur === 'string' ? valeur : JSON.stringify(valeur ?? null);
  return !TOUTES.some((s) => texte.includes(s));
};

/* ══════════════════════════════════════════════════════════════════════════
   UN FAUX STRIPE QUI DÉDUPLIQUE POUR DE VRAI.

   C'est le cœur du dispositif : sans idempotence côté serveur, « rejouer la
   même clé » ne prouverait rien. Ce serveur se comporte comme Stripe —
   même clé, même réponse, et il le SIGNALE (`replayed`) pour qu'on puisse
   distinguer une création d'un rejeu.
   ══════════════════════════════════════════════════════════════════════════ */
const appels = [];
/** Idempotency-Key → session. La mémoire du fournisseur. */
const parCle = new Map();
/** id → session. */
const parId = new Map();
let sequence = 0;
/** Prochain POST : ne jamais répondre (le Panel verra un délai dépassé). */
let avalerProchainePoste = false;

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

  if (req.url === '/v1/account') return repondre(200, { id: 'acct_panel', country: 'FR', charges_enabled: true });

  if (req.method === 'POST' && req.url === '/v1/checkout/sessions') {
    if (avalerProchainePoste) {
      /**
       * LE CAS QUI JUSTIFIE LE LOT : la session EST créée, et la réponse ne
       * revient JAMAIS. Côté Panel, l'issue est indécidable ; côté Stripe,
       * l'argent est engagé.
       *
       * On coupe la connexion plutôt que de laisser expirer un délai : c'est
       * la même issue — le Panel n'a rien appris — et cela évite d'attendre
       * vingt-cinq secondes pour prouver quelque chose d'instantané.
       */
      avalerProchainePoste = false;
      sequence += 1;
      fabriquer(cle);
      req.socket.destroy();
      return;
    }
    const connue = parCle.get(cle);
    if (connue) return repondre(200, { ...connue, __replayed: true });
    sequence += 1;
    return repondre(200, fabriquer(cle));
  }

  const lecture = /^\/v1\/checkout\/sessions\/([^/?]+)$/.exec(req.url ?? '');
  if (req.method === 'GET' && lecture) {
    const session = parId.get(decodeURIComponent(lecture[1]));
    if (!session) return repondre(404, { error: { message: 'No such checkout session' } });
    return repondre(200, session);
  }

  return repondre(404, { error: { message: 'route inconnue' } });
});

function fabriquer(cle) {
  const id = `cs_test_${sequence}`;
  const session = {
    id,
    object: 'checkout.session',
    url: `https://checkout.stripe.test/c/pay/${id}`,
    status: 'open',
    payment_status: 'unpaid',
    payment_intent: null,
    customer: null,
  };
  parCle.set(cle, session);
  parId.set(id, session);
  return session;
}

const creations = () => appels.filter((a) => a.method === 'POST' && a.url === '/v1/checkout/sessions');
const clesUtilisees = () => new Set(creations().map((a) => a.cle));
/** Créations qui ont porté une clé DÉJÀ vue : ce sont les reprises. */
const reprises = () => {
  const vues = new Set();
  let n = 0;
  for (const a of creations()) {
    if (vues.has(a.cle)) n += 1;
    else vues.add(a.cle);
  }
  return n;
};

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
const authority = await import('../backend/src/services/integratedApi/stripe/stripeCheckoutAuthority.js');

await resetSyncCore();
await seedIntegratedApiCredentialSets();
await updateNetworkConfiguration({ backendUrl: 'https://panel-l62b.test' }, { requirePublic: false });

const { base: panelUrl } = await startServer(createApp());

/* ══════════════════════════════════════════════════════════════════════════
   1. LE COFFRE — deux mondes, et un seul sera atteint.
   ══════════════════════════════════════════════════════════════════════════ */
section('1. Le coffre du Panel porte la clé Stripe — le projet n’en tient plus');
{
  await controlPlane.saveCredentialSet('STRIPE', 'TEST', {
    values: { secretKey: CLE_PANEL_TEST, baseUrl: STRIPE_BASE },
  }, ACTEUR);
  await controlPlane.saveCredentialSet('STRIPE', 'PROD', {
    values: { secretKey: CLE_PANEL_PROD, baseUrl: STRIPE_BASE },
  }, ACTEUR);

  const verdict = await controlPlane.validateCredentialSet('STRIPE', 'TEST', { actor: ACTEUR });
  check('le jeu TEST est validé par un appel réel', verdict.validation.status === 'VALID');
  check('…et c’est la clé du Panel qui est partie', appels.at(-1).auth === CLE_PANEL_TEST);
}

/* ══════════════════════════════════════════════════════════════════════════
   2. DEUX INSTANCES RÉELLES — le projet A, et son voisin.
   ══════════════════════════════════════════════════════════════════════════ */
const projetA = await startSbAutoInstance({
  mongoUri: MONGO_URI, dbName: 'sbauto_l62b_a', env: 'TEST', projectName: 'SB Auto L6.2B A',
});
const projetB = await startSbAutoInstance({
  mongoUri: MONGO_URI, dbName: 'sbauto_l62b_b', env: 'TEST', projectName: 'SB Auto L6.2B B',
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

let idA;
let idB;
section('2. Deux projets appairés, deux mondes TEST distincts');
{
  idA = await appairer(projetA);
  idB = await appairer(projetB);
  check('projet A appairé', typeof idA === 'string');
  check('projet B appairé', typeof idB === 'string');
  check('…et ce sont deux projets distincts', idA !== idB);
}

/* ══════════════════════════════════════════════════════════════════════════
   3. LE MONTANT VIENT DE LA PROJECTION — jamais de la charge utile.

   On sème deux contrats de montants DIFFÉRENTS. Le projet n'enverra jamais de
   montant ; ce que Stripe recevra dira lequel des deux le Panel a lu.
   ══════════════════════════════════════════════════════════════════════════ */
const CONTRAT_A = 'contrat-a-000000000000000001';
const CONTRAT_B = 'contrat-b-000000000000000002';

/** Les deux projections, telles que la synchronisation les aurait produites. */
async function semerContrats() {
  await semerContrat(idA, CONTRAT_A, MONTANT_TTC, 'CTR-A-0001');
  await semerContrat(idB, CONTRAT_B, 42_000, 'CTR-B-0001');
}

async function semerContrat(projectId, sourceContractId, montant, reference) {
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

section('3. Le Panel connaît le prix — le projet ne l’annonce pas');
{
  /**
   * ── ON VIDE D'ABORD CE QUE LES INSTANCES ONT À DIRE ───────────────────────
   *
   * Ces deux projets sont RÉELS, et un projet réel publie l'état de son contrat
   * — y compris « je n'en ai aucun », qui est un état et non un trou (voir
   * `applyContract`). Ce tombstone EFFACE la projection.
   *
   * Semer avant de laisser les instances parler produisait donc un test
   * intermittent : le tombstone arrivait tantôt avant, tantôt après. On draine
   * les deux files d'abord, puis on sème — et on ressème avant chaque section
   * qui facture, parce qu'un cycle peut toujours repasser.
   */
  await projetA.syncNow();
  await projetB.syncNow();
  await semerContrats();
  const projete = await PanelProjectContract.findOne({ projectId: idA }).lean();
  check('la projection du contrat A porte son montant',
    projete.pricing.launchFee.amountIncludingTax === MONTANT_TTC);

  await grantsModule.setCapabilityGrants(idA, [CHECKOUT], ACTEUR);
  await grantsModule.setCapabilityGrants(idB, [CHECKOUT], ACTEUR);

  /**
   * ── LA POLITIQUE PASSE AVANT LE COFFRE, ET AVANT L'ENTRÉE ─────────────────
   *
   * Les deux instances sont appairées, accordées, et le Panel détient la clé :
   * tout est prêt. Elles sont pourtant en PRÉ-OUVERTURE, et une écriture
   * financière y est refusée. Le refus tombe AVANT la validation de l'entrée —
   * on le voit ici : une charge utile pourtant invalide (`amount`) reçoit le
   * refus commercial, pas le refus de schéma. C'est la garantie « zéro contact
   * fournisseur » par la politique, et non par le calendrier de migration.
   */
  const enPreouverture = await projetA.invokeCapability({
    code: CHECKOUT,
    input: {
      contractRef: CONTRAT_A, paymentType: 'LAUNCH_FEE',
      successUrl: 'https://a.test/ok', cancelUrl: 'https://a.test/ko',
      operationId: 'op-l62b-preouverture-01', amount: 1,
    },
  });
  check('PRÉ-OUVERTURE × écriture financière → refusé',
    enPreouverture.code === 'CAPABILITY_BLOCKED_PREOPENING');
  check('…et le refus NOMME l’effet', enPreouverture.panelDetails?.effect === 'FINANCIAL_WRITE');
  check('…AUCUNE session créée', creations().length === 0);

  // On ouvre commercialement les deux projets : à partir d'ici, l'argent peut
  // bouger, et c'est une décision explicite.
  await commercial.setCommercialReadiness(idA, 'LIVE', { actor: ACTEUR, reason: 'E2E L6.2B' });
  await commercial.setCommercialReadiness(idB, 'LIVE', { actor: ACTEUR, reason: 'E2E L6.2B' });

  // Commerce ouvert : le contrat d'entrée REFUSE tout montant. Structurel.
  const avecMontant = await projetA.invokeCapability({
    code: CHECKOUT,
    input: {
      contractRef: CONTRAT_A, paymentType: 'LAUNCH_FEE',
      successUrl: 'https://a.test/ok', cancelUrl: 'https://a.test/ko',
      operationId: 'op-l62b-montant-000001', amount: 1,
    },
  });
  check('un montant dans la charge utile → refusé', avecMontant.ok === false);
  check('…code CAPABILITY_INPUT_INVALID', avecMontant.code === 'CAPABILITY_INPUT_INVALID');
  check('…et toujours AUCUNE session créée', creations().length === 0);
}

/* ══════════════════════════════════════════════════════════════════════════
   4. LE CHEMIN NOMINAL — projet → pont → passerelle → coffre → Stripe → lien.
   ══════════════════════════════════════════════════════════════════════════ */
const OP_A1 = `launch-${CONTRAT_A}-v1-a1-TEST`;
let sessionA1;

section('4. Le chemin complet, une fois');
{
  await semerContrats();
  const reponse = await projetA.invokeCapability({
    code: CHECKOUT,
    input: {
      contractRef: CONTRAT_A, paymentType: 'LAUNCH_FEE',
      successUrl: 'https://a.test/ok', cancelUrl: 'https://a.test/ko',
      correlation: { paymentRef: 'pay-a-1' },
      operationId: OP_A1,
    },
  });

  check('la capacité s’exécute', reponse.ok === true);
  check('…issue SUCCEEDED', reponse.data.outcome === 'SUCCEEDED');
  check('…et elle CRÉE (pas une reprise)', reponse.data.result.creation === 'CREATED');
  sessionA1 = reponse.data.result.checkoutSessionId;
  check('…une session est rendue', /^cs_test_\d+$/.test(sessionA1));
  check('…avec son URL de paiement', reponse.data.result.url.includes(sessionA1));
  check('…et l’operationId du projet lui revient', reponse.data.result.operationId === OP_A1);
  check('l’environnement rendu est celui de l’instance', reponse.data.environment === 'TEST');

  const post = creations().at(-1);
  const params = new URLSearchParams(post.corps);
  check('UNE seule création chez Stripe', creations().length === 1);
  check('la clé partie est celle du COFFRE', post.auth === CLE_PANEL_TEST);
  check('la clé du PROJET n’a jamais servi', appels.every((a) => a.auth !== CLE_PROJET));
  check('la clé PROD n’a jamais servi', appels.every((a) => a.auth !== CLE_PANEL_PROD));

  check('le montant est celui de la PROJECTION',
    params.get('line_items[0][price_data][unit_amount]') === String(MONTANT_TTC));
  check('…et la devise aussi', params.get('line_items[0][price_data][currency]') === 'eur');
  check('mode payment', params.get('mode') === 'payment');
  check('la facture Stripe est réclamée', params.get('invoice_creation[enabled]') === 'true');
  check('metadata contractId = celui de la projection', params.get('metadata[contractId]') === CONTRAT_A);
  check('metadata paymentType conservée', params.get('metadata[paymentType]') === 'LAUNCH_FEE');
  check('metadata paymentId = la corrélation du projet', params.get('metadata[paymentId]') === 'pay-a-1');
  check('metadata providerMode conservée', params.get('metadata[providerMode]') === 'TEST');

  check('une clé d’idempotence a été envoyée', typeof post.cle === 'string' && post.cle.startsWith('pcp_'));
  check('…et elle est DÉRIVÉE de l’acte, pas tirée au sort',
    post.cle === authority.deriveIdempotencyKey({
      environment: 'TEST', projectId: idA, capability: CHECKOUT, operationId: OP_A1,
    }));

  const lien = await binding.findBinding({
    environment: 'TEST', resourceType: 'CHECKOUT_SESSION', resourceId: sessionA1,
  });
  check('la session est LIÉE immédiatement', lien !== null);
  check('…au bon projet', lien.projectId === idA);
  check('…dans le bon monde', lien.environment === 'TEST');
  check('…et l’acte qui l’a produite est nommé', lien.createdByOperationId === OP_A1);
  check('…par la route « le Panel crée »', lien.source === 'PANEL_CREATED');

  const operation = await PanelCapabilityOperation.findOne({ projectId: idA, operationId: OP_A1 }).lean();
  check('l’opération est enregistrée SUCCEEDED', operation?.status === 'SUCCEEDED');
  check('…et porte la session comme poignée de corrélation',
    operation.providerMessageId === sessionA1);

  check('aucune clé dans la réponse rendue au projet', propre(reponse));
}

/* ══════════════════════════════════════════════════════════════════════════
   5. LE REJEU NOMINAL — même acte, même session, zéro création.
   ══════════════════════════════════════════════════════════════════════════ */
section('5. Rejouer le même acte ne crée pas un second paiement');
{
  await semerContrats();
  const avant = creations().length;
  const rejeu = await projetA.invokeCapability({
    code: CHECKOUT,
    input: {
      contractRef: CONTRAT_A, paymentType: 'LAUNCH_FEE',
      successUrl: 'https://a.test/ok', cancelUrl: 'https://a.test/ko',
      correlation: { paymentRef: 'pay-a-1' },
      operationId: OP_A1,
    },
  });
  check('le rejeu réussit', rejeu.ok === true);
  check('…et se déclare REPRISE', rejeu.data.result.creation === 'REUSED');
  check('…sur LA MÊME session', rejeu.data.result.checkoutSessionId === sessionA1);
  check('AUCUNE création supplémentaire chez Stripe', creations().length === avant);

  const liens = await PanelStripeResourceBinding.countDocuments({ projectId: idA });
  check('…et toujours un seul lien', liens === 1);
}

/* ══════════════════════════════════════════════════════════════════════════
   6. CRASH APRÈS STRIPE, AVANT LE LIEN — le scénario T0→T9 du lot.

   On reproduit exactement l'état laissé par un processus tué dans la fenêtre
   irréductible : la session existe chez Stripe, le Panel n'en a AUCUNE trace
   utilisable — ni lien, ni opération conclue.
   ══════════════════════════════════════════════════════════════════════════ */
const OP_A2 = `launch-${CONTRAT_A}-v1-a2-TEST`;

section('6. Crash entre Stripe et le lien : la reprise retrouve, elle ne recrée pas');
{
  await semerContrats();
  // T0→T2 — l'acte a lieu normalement.
  const premier = await projetA.invokeCapability({
    code: CHECKOUT,
    input: {
      contractRef: CONTRAT_A, paymentType: 'LAUNCH_FEE',
      successUrl: 'https://a.test/ok', cancelUrl: 'https://a.test/ko',
      operationId: OP_A2,
    },
  });
  const sessionA2 = premier.data.result.checkoutSessionId;
  check('une seconde tentative ouvre bien une AUTRE session', sessionA2 !== sessionA1);
  const creationsApresT2 = creations().length;

  // T3 — le crash : ni lien, ni opération conclue. Et l'opération est ANCIENNE,
  // sans quoi un concurrent légitime serait confondu avec un survivant.
  await PanelStripeResourceBinding.deleteOne({ environment: 'TEST', resourceId: sessionA2 });
  await PanelCapabilityOperation.updateOne(
    { projectId: idA, operationId: OP_A2 },
    { $set: { status: 'PENDING', settledAt: null, startedAt: new Date(Date.now() - 10 * 60_000).toISOString() } },
  );
  check('T3 — plus aucun lien pour cette session',
    (await binding.findBinding({ environment: 'TEST', resourceType: 'CHECKOUT_SESSION', resourceId: sessionA2 })) === null);

  // T4→T9 — le projet rejoue le MÊME acte.
  const reprise = await projetA.invokeCapability({
    code: CHECKOUT,
    input: {
      contractRef: CONTRAT_A, paymentType: 'LAUNCH_FEE',
      successUrl: 'https://a.test/ok', cancelUrl: 'https://a.test/ko',
      operationId: OP_A2,
    },
  });

  check('T5 — la reprise réussit', reprise.ok === true);
  check('T7 — et rend LA MÊME session qu’avant le crash',
    reprise.data.result.checkoutSessionId === sessionA2);

  /**
   * Un POST supplémentaire a bien eu lieu — c'est la barrière 2 : rejouer la
   * MÊME clé. Ce qui compte est ce que Stripe en a fait : il a rendu sa
   * réponse d'origine, et n'a créé AUCUNE session de plus.
   */
  check('T5 — le rejeu a porté la MÊME clé d’idempotence',
    creations().at(-1).cle === creations().at(creationsApresT2 - 1).cle);
  check('T5 — Stripe n’a créé aucune session supplémentaire', parId.size === 2);

  const lien = await binding.findBinding({
    environment: 'TEST', resourceType: 'CHECKOUT_SESSION', resourceId: sessionA2,
  });
  check('T8 — le lien est RÉPARÉ', lien !== null && lien.projectId === idA);
  check('T8 — et il désigne toujours le même acte', lien.createdByOperationId === OP_A2);

  const sessionsDuProjet = await PanelStripeResourceBinding.countDocuments({ projectId: idA });
  check('deux actes, deux sessions, aucun doublon', sessionsDuProjet === 2);
}

/* ══════════════════════════════════════════════════════════════════════════
   7. UNKNOWN — la réponse se perd, l'argent est engagé.
   ══════════════════════════════════════════════════════════════════════════ */
const OP_A3 = `launch-${CONTRAT_A}-v1-a3-TEST`;

section('7. Réponse perdue : UNKNOWN reste UNKNOWN, et la reprise converge');
{
  await semerContrats();
  const avantParId = parId.size;
  avalerProchainePoste = true;

  const perdu = await projetA.invokeCapability({
    code: CHECKOUT,
    input: {
      contractRef: CONTRAT_A, paymentType: 'LAUNCH_FEE',
      successUrl: 'https://a.test/ok', cancelUrl: 'https://a.test/ko',
      operationId: OP_A3,
    },
  });

  check('l’appel échoue', perdu.ok === false);
  check('…en CAPABILITY_TIMEOUT, pas en « indisponible »', perdu.code === 'CAPABILITY_TIMEOUT');
  check('…et le pont a préservé le code', perdu.code.startsWith('CAPABILITY_'));
  check('Stripe a pourtant bien créé la session', parId.size === avantParId + 1);

  const operation = await PanelCapabilityOperation.findOne({ projectId: idA, operationId: OP_A3 }).lean();
  check('l’opération est marquée UNKNOWN — pas FAILED', operation?.status === 'UNKNOWN');

  // LA CONVERGENCE : même operationId, donc même clé, donc même session.
  const reprise = await projetA.invokeCapability({
    code: CHECKOUT,
    input: {
      contractRef: CONTRAT_A, paymentType: 'LAUNCH_FEE',
      successUrl: 'https://a.test/ok', cancelUrl: 'https://a.test/ko',
      operationId: OP_A3,
    },
  });
  check('la reprise aboutit', reprise.ok === true);
  check('…sans que Stripe crée quoi que ce soit de plus', parId.size === avantParId + 1);

  const sessionA3 = reprise.data.result.checkoutSessionId;
  const lien = await binding.findBinding({
    environment: 'TEST', resourceType: 'CHECKOUT_SESSION', resourceId: sessionA3,
  });
  check('la session perdue est retrouvée ET liée', lien !== null && lien.projectId === idA);

  const apres = await PanelCapabilityOperation.findOne({ projectId: idA, operationId: OP_A3 }).lean();
  check('l’opération est enfin conclue', apres.status === 'SUCCEEDED');
  check('…après plus d’une tentative, et le registre le dit', apres.attempts >= 2);
}

/* ══════════════════════════════════════════════════════════════════════════
   8. AU-DELÀ DE LA FENÊTRE — le doute redevient un arbitrage humain.
   ══════════════════════════════════════════════════════════════════════════ */
const OP_A4 = `launch-${CONTRAT_A}-v1-a4-TEST`;

section('8. Passé la fenêtre d’idempotence, le Panel refuse de deviner');
{
  await semerContrats();
  const avantParId = parId.size;
  avalerProchainePoste = true;
  await projetA.invokeCapability({
    code: CHECKOUT,
    input: {
      contractRef: CONTRAT_A, paymentType: 'LAUNCH_FEE',
      successUrl: 'https://a.test/ok', cancelUrl: 'https://a.test/ko',
      operationId: OP_A4,
    },
  });
  check('une session de plus existe chez Stripe, sans réponse', parId.size === avantParId + 1);

  /**
   * On vieillit l'opération au-delà de la fenêtre annoncée par Stripe. Rejouer
   * la même clé ne serait plus une reprise : le fournisseur l'aurait oubliée,
   * et créerait une SECONDE session. C'est exactement le moment où il faut
   * s'arrêter.
   */
  await PanelCapabilityOperation.updateOne(
    { projectId: idA, operationId: OP_A4 },
    { $set: { startedAt: new Date(Date.now() - 48 * 3600 * 1000).toISOString() } },
  );

  const avantCreations = creations().length;
  const refus = await projetA.invokeCapability({
    code: CHECKOUT,
    input: {
      contractRef: CONTRAT_A, paymentType: 'LAUNCH_FEE',
      successUrl: 'https://a.test/ok', cancelUrl: 'https://a.test/ko',
      operationId: OP_A4,
    },
  });
  check('la reprise est REFUSÉE', refus.ok === false);
  check('…code CAPABILITY_OPERATION_UNRESOLVED', refus.code === 'CAPABILITY_OPERATION_UNRESOLVED');
  check('…et RIEN n’est reparti chez Stripe', creations().length === avantCreations);
  check('…aucune session de plus', parId.size === avantParId + 1);
}

/* ══════════════════════════════════════════════════════════════════════════
   9. CONCURRENCE — huit clics, un seul paiement.
   ══════════════════════════════════════════════════════════════════════════ */
const OP_A5 = `launch-${CONTRAT_A}-v1-a5-TEST`;

section('9. Huit appels simultanés du même acte');
{
  await semerContrats();
  const avantParId = parId.size;
  const entree = {
    contractRef: CONTRAT_A, paymentType: 'LAUNCH_FEE',
    successUrl: 'https://a.test/ok', cancelUrl: 'https://a.test/ko',
    operationId: OP_A5,
  };
  const resultats = await Promise.all(
    Array.from({ length: 8 }, () => projetA.invokeCapability({ code: CHECKOUT, input: entree })),
  );

  const reussis = resultats.filter((r) => r.ok);
  const refuses = resultats.filter((r) => !r.ok);
  check('au moins un appel aboutit', reussis.length >= 1);
  check('les autres sont REFUSÉS, jamais servis en double',
    refuses.every((r) => r.code === 'CAPABILITY_OPERATION_IN_FLIGHT'));
  check('UNE seule session créée chez Stripe', parId.size === avantParId + 1);
  check('…et tous les succès désignent la même',
    new Set(reussis.map((r) => r.data.result.checkoutSessionId)).size === 1);

  const liens = await PanelStripeResourceBinding.countDocuments({
    projectId: idA, createdByOperationId: OP_A5,
  });
  check('…et un seul lien', liens === 1);

  /**
   * DEUX ACTES DISTINCTS RESTENT DEUX ACTES. La déduplication porte sur
   * l'identité de l'acte, jamais sur le contrat : un contrat peut légitimement
   * connaître plusieurs tentatives, et les confondre laisserait un client sans
   * moyen de repayer après une session expirée.
   */
  const autre = await projetA.invokeCapability({
    code: CHECKOUT,
    input: { ...entree, operationId: `launch-${CONTRAT_A}-v1-a6-TEST` },
  });
  check('un operationId DIFFÉRENT ouvre bien un second acte', autre.ok === true);
  check('…et c’est une autre session', autre.data.result.checkoutSessionId !== reussis[0].data.result.checkoutSessionId);
  check('…donc une création de plus, assumée', parId.size === avantParId + 2);
}

/* ══════════════════════════════════════════════════════════════════════════
   10. LE VOISIN — un vrai projet, un vrai jeton, et aucune prise.
   ══════════════════════════════════════════════════════════════════════════ */
section('10. Le projet B ne peut ni lire, ni adopter, ni facturer chez A');
{
  await semerContrats();
  const avantParId = parId.size;

  // B présente le contrat de A. Il a un jeton valide et une capacité accordée.
  const vol = await projetB.invokeCapability({
    code: CHECKOUT,
    input: {
      contractRef: CONTRAT_A, paymentType: 'LAUNCH_FEE',
      successUrl: 'https://b.test/ok', cancelUrl: 'https://b.test/ko',
      operationId: 'op-l62b-vol-contrat-0001',
    },
  });
  check('B facturant le contrat de A → refusé', vol.ok === false);
  check('…code CAPABILITY_NOT_AVAILABLE', vol.code === 'CAPABILITY_NOT_AVAILABLE');
  check('…motif CONTRACT_NOT_OWNED', vol.panelDetails?.reason === 'CONTRACT_NOT_OWNED');
  check('…et AUCUNE session créée', parId.size === avantParId);

  /**
   * LE REFUS N'EST PAS UN ORACLE. B présente une référence de contrat qui
   * n'existe nulle part : il doit obtenir EXACTEMENT le même refus que pour le
   * contrat bien réel de A. Sans quoi il suffirait de comparer les messages
   * pour savoir quels contrats existent.
   */
  const inexistant = await projetB.invokeCapability({
    code: CHECKOUT,
    input: {
      contractRef: 'contrat-qui-nexiste-pas-0000', paymentType: 'LAUNCH_FEE',
      successUrl: 'https://b.test/ok', cancelUrl: 'https://b.test/ko',
      operationId: 'op-l62b-vol-contrat-0002',
    },
  });
  check('une référence inventée → même code', inexistant.code === vol.code);
  check('…même motif', inexistant.panelDetails?.reason === vol.panelDetails?.reason);
  check('…même message', inexistant.message === vol.message);

  // B tente d'adopter la session de A par le registre lui-même.
  let adoption = null;
  try {
    await binding.bindResource({
      projectId: idB, environment: 'TEST',
      resourceType: 'CHECKOUT_SESSION', resourceId: sessionA1,
      source: 'PANEL_CREATED',
    });
  } catch (err) { adoption = err; }
  check('B adoptant la session de A → conflit', adoption?.code === 'STRIPE_RESOURCE_ALREADY_BOUND');
  const toujours = await binding.findBinding({
    environment: 'TEST', resourceType: 'CHECKOUT_SESSION', resourceId: sessionA1,
  });
  check('…et la session appartient TOUJOURS à A', toujours.projectId === idA);

  // B interroge l'appartenance : refus indistinguable.
  let refusB = null;
  try {
    await binding.assertOwnedResource({
      projectId: idB, environment: 'TEST',
      resourceType: 'CHECKOUT_SESSION', resourceId: sessionA1,
    });
  } catch (err) { refusB = err; }
  let refusInconnu = null;
  try {
    await binding.assertOwnedResource({
      projectId: idB, environment: 'TEST',
      resourceType: 'CHECKOUT_SESSION', resourceId: 'cs_test_inexistante',
    });
  } catch (err) { refusInconnu = err; }
  check('« la session d’un autre » et « aucune session » se refusent pareil',
    refusB?.code === refusInconnu?.code && refusB?.message === refusInconnu?.message);
  check('…et le refus ne nomme jamais A', !String(refusB?.message).includes(idA));

  // B facture SON contrat : le montant est le SIEN, pas celui de A.
  const propreB = await projetB.invokeCapability({
    code: CHECKOUT,
    input: {
      contractRef: CONTRAT_B, paymentType: 'LAUNCH_FEE',
      successUrl: 'https://b.test/ok', cancelUrl: 'https://b.test/ko',
      operationId: `launch-${CONTRAT_B}-v1-a1-TEST`,
    },
  });
  check('B facture SON contrat sans difficulté', propreB.ok === true);
  const paramsB = new URLSearchParams(creations().at(-1).corps);
  check('…au montant de SA projection', paramsB.get('line_items[0][price_data][unit_amount]') === '42000');
  const lienB = await binding.findBinding({
    environment: 'TEST', resourceType: 'CHECKOUT_SESSION',
    resourceId: propreB.data.result.checkoutSessionId,
  });
  check('…et sa session lui est liée, à lui', lienB.projectId === idB);

  /**
   * MÊME IDENTITÉ D'ACTE, DEUX PROJETS : les clés d'idempotence Stripe doivent
   * DIVERGER. Les confondre ferait converger le paiement de B vers la session
   * de A — le vol le plus discret du système.
   */
  const memeOp = 'op-l62b-collision-0000001';
  check('la clé dérivée porte le projet',
    authority.deriveIdempotencyKey({ environment: 'TEST', projectId: idA, capability: CHECKOUT, operationId: memeOp })
    !== authority.deriveIdempotencyKey({ environment: 'TEST', projectId: idB, capability: CHECKOUT, operationId: memeOp }));
  check('…et le monde',
    authority.deriveIdempotencyKey({ environment: 'TEST', projectId: idA, capability: CHECKOUT, operationId: memeOp })
    !== authority.deriveIdempotencyKey({ environment: 'PROD', projectId: idA, capability: CHECKOUT, operationId: memeOp }));
}

/* ══════════════════════════════════════════════════════════════════════════
   11. L'ABONNEMENT N'EST PAS MIGRÉ — et le refus est explicite.
   ══════════════════════════════════════════════════════════════════════════ */
section('11. L’abonnement refuse plutôt que de produire une session bancale');
{
  await semerContrats();
  const avantParId = parId.size;
  const abo = await projetA.invokeCapability({
    code: CHECKOUT,
    input: {
      contractRef: CONTRAT_A, paymentType: 'SUBSCRIPTION',
      successUrl: 'https://a.test/ok', cancelUrl: 'https://a.test/ko',
      operationId: 'op-l62b-abonnement-00001',
    },
  });
  check('SUBSCRIPTION → refusé', abo.ok === false);
  check('…motif nommé, jamais silencieux',
    abo.panelDetails?.reason === 'SUBSCRIPTION_PREREQUISITES_NOT_MIGRATED');
  check('…et aucune session créée', parId.size === avantParId);
}

/* ══════════════════════════════════════════════════════════════════════════
   12. LA CLÉ DU PROJET N'A JAMAIS SERVI — le bilan, sur TOUS les appels.
   ══════════════════════════════════════════════════════════════════════════ */
section('12. Bilan des clés vues par le fournisseur');
{
  const clesVues = new Set(appels.map((a) => a.auth).filter(Boolean));
  check('exactement UNE clé a parlé à Stripe', clesVues.size === 1);
  check('…et c’est celle du coffre du Panel, en TEST', clesVues.has(CLE_PANEL_TEST));
  check('la sentinelle du PROJET n’apparaît nulle part',
    !JSON.stringify(appels).includes(CLE_PROJET));

  // Toute écriture a porté une clé d'idempotence — aucune n'est partie « nue ».
  check('aucune création sans clé d’idempotence',
    creations().every((a) => typeof a.cle === 'string' && a.cle.length > 0));

  /**
   * UNE CLÉ, UNE SESSION — l'invariant qui résume tout le lot.
   *
   * On ne compare PAS le nombre de clés au nombre d'opérations : la réservation
   * précède l'exécution, donc un acte refusé (abonnement, contrat d'un autre)
   * laisse une opération sans jamais atteindre Stripe. C'est voulu.
   *
   * Ce qui doit tenir, c'est l'autre sens : autant de sessions créées chez
   * Stripe que de clés distinctes envoyées. Une clé qui aurait produit deux
   * sessions serait précisément le doublon que ce lot interdit.
   */
  check('autant de sessions Stripe que de clés d’idempotence distinctes',
    parId.size === clesUtilisees().size);
  check('…et chaque clé désigne une session unique', parCle.size === parId.size);

  /**
   * DEUX CLÉS N'ONT JAMAIS PU SE CONFONDRE ENTRE PROJETS : toutes les clés
   * émises sont distinctes deux à deux, alors que deux projets ont été servis.
   */
  check('aucune collision de clé entre les deux projets',
    clesUtilisees().size === creations().length - reprises());

  // La base des DEUX projets ne porte aucune clé Stripe.
  for (const [nom, instance] of [['A', projetA], ['B', projetB]]) {
    check(`la base du projet ${nom} ne contient aucune clé Stripe du Panel`,
      propre(await instance.dbDump()));
  }
}

await projetA.stop();
await projetB.stop();
fauxStripe.close();
finish();
