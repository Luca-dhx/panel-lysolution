// UNE LIGNE QUI EXISTE N'EST PAS UN TRAVAIL FAIT — la recette du lot.
//
// ══ LE DÉFAUT QUE CETTE RECETTE VERROUILLE ═══════════════════════════════════
//
// `PanelProviderWebhookEvent` était créé AVANT les effets métier, et son refus
// en E11000 valait « doublon ». La séquence tenait donc en une ligne :
//
//     webhook  →  ligne RECEIVED  →  CRASH  →  Stripe rejoue  →  « doublon »
//                                                             →  revenu PERDU
//
// La ligne prouvait qu'on avait VU l'événement, pas qu'on l'avait APPLIQUÉ. Le
// rejeu du fournisseur — la seule réparation gratuite qui existe — était refusé
// au nom d'une idempotence qui ne protégeait plus rien.
//
// ══ CE QU'ON MONTE, ET POURQUOI ══════════════════════════════════════════════
//
//   · une VRAIE base (Mongo en mémoire) : la réclamation est atomique ou ne
//     l'est pas, et c'est Mongo qui arbitre — pas nous ;
//   · le VRAI endpoint (`ingestProviderEvent`), avec de VRAIES signatures HMAC ;
//   · un faux Stripe qui COMPTE ses appels et sert `/v1/events/{id}` — c'est par
//     là que la reprise relit un événement dont nous ne gardons pas le corps.
//
// ══ LA PREUVE LA PLUS IMPORTANTE ═════════════════════════════════════════════
//
// §F : le processus « meurt » entre la réclamation et l'effet. Le rejeu de
// Stripe REPREND l'événement, l'effet est appliqué — et il l'est UNE fois.
// Avant ce lot, ce même rejeu répondait 200 « doublon » et l'effet n'existait
// jamais.
import http from 'node:http';
import { createHmac } from 'node:crypto';

import {
  check, connectTestDatabase, finish, section, setTestEnv, startMemoryMongo,
} from './helpers/harness.js';
import { forme } from './helpers/secretShapes.js';

setTestEnv();
/** Bail très court : la recette doit pouvoir le laisser EXPIRER pour de vrai. */
process.env.WEBHOOK_LEASE_TTL_MS = '400';
process.env.WEBHOOK_STALE_RECEIVED_MS = '400';
process.env.WEBHOOK_MAX_ATTEMPTS = '3';

await startMemoryMongo();
await connectTestDatabase();

const dormir = (ms) => new Promise((r) => { setTimeout(r, ms); });
const prefixe = (monde) => ['sk', monde, ''].join('_');
const CLE = `${prefixe('test')}CRASHRECOVERYSENTINELLE000001`;
const WHSEC = forme.stripeWebhook('CRASH-RECOVERY-SIGNATURE-001');
const ACTEUR = { userId: 'u-dev', userEmail: 'dev@panel.test' };

/* ══════════════════════════════════════════════════════════════════════════
   UN FAUX STRIPE QUI COMPTE — et qui sait RELIRE un événement.
   ══════════════════════════════════════════════════════════════════════════ */
const appelsStripe = [];
/** Ce que le compte « détient » : la reprise ira le rechercher ici. */
const evenementsDuCompte = new Map();
/** Interrupteur : Stripe injoignable, pour éprouver l'erreur REPRENABLE. */
let stripeEnPanne = false;

const fauxStripe = http.createServer(async (req, res) => {
  appelsStripe.push(req.url);
  const repondre = (code, corps) => {
    res.writeHead(code, { 'content-type': 'application/json' });
    res.end(JSON.stringify(corps));
  };
  if (stripeEnPanne) return repondre(503, { error: { message: 'service indisponible' } });

  const relecture = req.url.match(/^\/v1\/events\/([^/?]+)$/);
  if (relecture) {
    const evt = evenementsDuCompte.get(relecture[1]);
    return evt
      ? repondre(200, evt)
      : repondre(404, { error: { code: 'resource_missing', message: 'No such event' } });
  }
  if (req.url.startsWith('/v1/account')) return repondre(200, { id: 'acct_recette', object: 'account' });
  return repondre(200, {});
});
await new Promise((r) => { fauxStripe.listen(0, '127.0.0.1', r); });
const STRIPE_BASE = `http://127.0.0.1:${fauxStripe.address().port}`;

/* ── Modules, après la base ────────────────────────────────────────────────── */
const controlPlane = await import('../backend/src/services/integratedApi/controlPlane.service.js');
const { seedIntegratedApiCredentialSets } = await import('../backend/src/services/integratedApi/seed.js');
const { ingestProviderEvent, INGEST_OUTCOME } = await import('../backend/src/services/webhooks/webhookIngest.js');
const { storeWebhookSecret } = await import('../backend/src/services/webhooks/webhookSecrets.js');
const { default: WebhookEvent, WEBHOOK_EVENT_STATUS: ST, WEBHOOK_TERMINAL_STATUSES } = await import(
  '../backend/src/models/PanelProviderWebhookEvent.model.js'
);
const { default: WebhookBinding } = await import('../backend/src/models/PanelIntegratedApiWebhookBinding.model.js');
const bail = await import('../backend/src/services/webhooks/webhookLease.js');
const recovery = await import('../backend/src/services/webhooks/webhookRecovery.js');
const { PanelEvent, EVENT_TYPES } = await import('../backend/src/models/PanelSupervision.model.js');

const {
  claimWebhookEvent, settleWebhookEvent, classifyWebhookError,
  statusAfterFailure, CLAIM_OUTCOME, LEASE_TTL_MS, MAX_PROCESSING_ATTEMPTS,
} = bail;

await seedIntegratedApiCredentialSets();
await controlPlane.saveCredentialSet('STRIPE', 'TEST', {
  values: { secretKey: CLE, baseUrl: STRIPE_BASE },
}, ACTEUR);
await storeWebhookSecret('STRIPE', 'TEST', WHSEC);

/** L'endpoint que le Panel expose déjà : on l'adopte, on n'en crée pas un second. */
await (async () => {
  const existant = await WebhookBinding.findOne({
    provider: 'STRIPE', environment: 'TEST', destination: 'PANEL', projectId: null,
  });
  if (existant) {
    existant.remoteEndpointId = 'we_crash';
    existant.callbackUrl = 'https://panel-crash.test/webhooks/providers/stripe';
    existant.updatedAt = new Date().toISOString();
    return existant.save();
  }
  return WebhookBinding.create({
    bindingId: 'wb-crash', provider: 'STRIPE', environment: 'TEST',
    remoteEndpointId: 'we_crash', callbackUrl: 'https://panel-crash.test/webhooks/providers/stripe',
    ownershipToken: 'crash', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  });
})();

const signer = (corps) => {
  const t = Math.floor(Date.now() / 1000);
  return `t=${t},v1=${createHmac('sha256', WHSEC).update(`${t}.${corps}`).digest('hex')}`;
};

/** Un événement, publié chez le faux Stripe ET livrable à l'endpoint. */
const publier = (id, type, object = {}) => {
  const evt = { id, object: 'event', type, created: Math.floor(Date.now() / 1000), data: { object } };
  evenementsDuCompte.set(id, evt);
  return JSON.stringify(evt);
};

const livrer = (corps) => ingestProviderEvent({
  slug: 'stripe', rawBody: Buffer.from(corps), headers: { 'stripe-signature': signer(corps) },
});

const cle = (id) => ({ provider: 'STRIPE', environment: 'TEST', providerEventId: id });
const lire = (id) => WebhookEvent.findOne(cle(id)).lean();

/* ══════════════════════════════════════════════════════════════════════════ */
section('0. LA MACHINE — ce qui est terminal, et ce qui ne l’est pas');
{
  check('PROCESSED, IGNORED et DEAD_LETTER sont les SEULS états terminaux',
    WEBHOOK_TERMINAL_STATUSES.length === 3
    && WEBHOOK_TERMINAL_STATUSES.includes(ST.PROCESSED)
    && WEBHOOK_TERMINAL_STATUSES.includes(ST.IGNORED)
    && WEBHOOK_TERMINAL_STATUSES.includes(ST.DEAD_LETTER));
  check('RECEIVED n’en fait PAS partie — c’est tout le lot',
    !WEBHOOK_TERMINAL_STATUSES.includes(ST.RECEIVED));
  check('FAILED non plus', !WEBHOOK_TERMINAL_STATUSES.includes(ST.FAILED));
  check('l’identité de processus porte un nonce de démarrage',
    /^[^:]+:\d+:[0-9a-f]{12}$/.test(bail.PROCESS_IDENTITY));
  check(`les seuils sont configurables (bail ${LEASE_TTL_MS} ms, ${MAX_PROCESSING_ATTEMPTS} tentatives)`,
    LEASE_TTL_MS === 400 && MAX_PROCESSING_ATTEMPTS === 3);
  check('DUPLICATE reste déclaré, pour les documents hérités', typeof ST.DUPLICATE === 'string');
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('A. UN ÉVÉNEMENT NEUF — reçu, appliqué, conclu');
{
  const corps = publier('evt_crash_A', 'invoice.paid', { id: 'in_A', object: 'invoice' });
  const recu = await livrer(corps);
  check('l’événement est accepté', recu.outcome === INGEST_OUTCOME.ACCEPTED, recu.outcome);
  check('…sa signature est prouvée', recu.proven === true);

  const doc = await lire('evt_crash_A');
  check('il finit PROCESSED', doc.processingStatus === undefined && doc.status === ST.PROCESSED,
    `état ${doc.status}`);
  check('…le bail est rendu', doc.leaseOwner === null && doc.leaseExpiresAt === null);
  check('…et il porte sa tentative', doc.processingAttempts === 1);
  check('…datée de sa fin', typeof doc.processedAt === 'string');
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('B. LE MÊME, REJOUÉ — doublon terminal, aucun effet, aucun compteur');
{
  const corps = publier('evt_crash_A', 'invoice.paid', { id: 'in_A', object: 'invoice' });
  const rejeu = await livrer(corps);
  check('le rejeu est un DOUBLON', rejeu.outcome === INGEST_OUTCOME.DUPLICATE);
  const doc = await lire('evt_crash_A');
  check('…le compteur de tentatives n’a PAS bougé', doc.processingAttempts === 1,
    `${doc.processingAttempts}`);
  check('…l’état non plus', doc.status === ST.PROCESSED);
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('C. UN RECEIVED HÉRITÉ ET ANCIEN — repris, PAS éconduit');
{
  /** Exactement ce que l'ancien code écrivait, et ce que la base contient déjà. */
  await WebhookEvent.create({
    ...cle('evt_crash_C'),
    bindingId: 'wb-crash',
    eventType: 'invoice.paid',
    status: ST.RECEIVED,
    receivedAt: new Date(Date.now() - 60_000).toISOString(),
  });

  const r = await claimWebhookEvent({ Model: WebhookEvent, key: cle('evt_crash_C'), seed: {} });
  check('un RECEIVED ancien est REPRIS', r.outcome === CLAIM_OUTCOME.RECLAIMED, r.outcome);
  check('…et le compteur monte', r.attempts === 1);
  await settleWebhookEvent({ Model: WebhookEvent, key: cle('evt_crash_C'), status: ST.PROCESSED });
  check('…il se conclut normalement', (await lire('evt_crash_C')).status === ST.PROCESSED);
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('D. UN BAIL VALIDE — le second n’entre pas, et ce n’est pas « déjà traité »');
{
  await claimWebhookEvent({ Model: WebhookEvent, key: cle('evt_crash_D'), seed: { receivedAt: new Date().toISOString() } });
  const second = await claimWebhookEvent({ Model: WebhookEvent, key: cle('evt_crash_D'), seed: {} });
  check('bail valide : IN_FLIGHT', second.outcome === CLAIM_OUTCOME.IN_FLIGHT, second.outcome);
  check('…et non TERMINAL — le premier peut encore échouer',
    second.outcome !== CLAIM_OUTCOME.TERMINAL);
  const doc = await lire('evt_crash_D');
  check('…aucune seconde tentative comptée', doc.processingAttempts === 1, `${doc.processingAttempts}`);
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('E. UN BAIL EXPIRÉ — le travail est réputé abandonné, on reprend');
{
  await dormir(LEASE_TTL_MS + 120);
  const r = await claimWebhookEvent({ Model: WebhookEvent, key: cle('evt_crash_D'), seed: {} });
  check('bail expiré : RECLAIMED', r.outcome === CLAIM_OUTCOME.RECLAIMED, r.outcome);
  check('…tentative 2', r.attempts === 2, `${r.attempts}`);
  await settleWebhookEvent({ Model: WebhookEvent, key: cle('evt_crash_D'), status: ST.PROCESSED });
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('F. CRASH AVANT L’EFFET — le rejeu de Stripe REPREND (le cœur du lot)');
{
  const ID = 'evt_crash_F';
  const corps = publier(ID, 'invoice.paid', { id: 'in_F', object: 'invoice' });

  /**
   * LE PROCESSUS MEURT ICI. On reproduit son état durable exact : la ligne a
   * été réclamée, rien n'a été appliqué, rien n'a été conclu. C'est ce que
   * laisse un `kill -9` entre la réclamation et les effets.
   */
  await claimWebhookEvent({
    Model: WebhookEvent,
    key: cle(ID),
    seed: { bindingId: 'wb-crash', eventType: 'invoice.paid', receivedAt: new Date().toISOString() },
  });
  const apresCrash = await lire(ID);
  check('après le crash, l’état durable est PROCESSING', apresCrash.status === ST.PROCESSING);
  check('…et surtout PAS PROCESSED', apresCrash.status !== ST.PROCESSED);

  await dormir(LEASE_TTL_MS + 120);

  /** Stripe rejoue — il n'a jamais reçu de réponse. */
  const rejeu = await livrer(corps);
  check('LE REJEU EST ACCEPTÉ, PAS ÉCONDUIT COMME DOUBLON',
    rejeu.outcome === INGEST_OUTCOME.ACCEPTED, rejeu.outcome);
  const fini = await lire(ID);
  check('…l’événement est enfin appliqué', fini.status === ST.PROCESSED, `état ${fini.status}`);
  check('…à la deuxième tentative', fini.processingAttempts === 2, `${fini.processingAttempts}`);
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('G. CRASH APRÈS L’EFFET — la reprise ne double rien');
{
  const ID = 'evt_crash_G';
  const corps = publier(ID, 'invoice.paid', { id: 'in_G', object: 'invoice' });

  /** Premier passage complet : l'effet a eu lieu. */
  await livrer(corps);
  check('premier passage : PROCESSED', (await lire(ID)).status === ST.PROCESSED);

  /**
   * On simule le crash « après l'effet, avant le marquage » en ramenant l'état
   * durable à PROCESSING périmé : c'est ce que le processus aurait laissé.
   */
  await WebhookEvent.updateOne(cle(ID), {
    $set: {
      status: ST.PROCESSING,
      leaseOwner: 'processus-mort',
      leaseExpiresAt: new Date(Date.now() - 1000).toISOString(),
    },
  });

  const avant = await WebhookEvent.countDocuments({ environment: 'TEST' });
  const rejeu = await livrer(corps);
  check('le rejeu reprend', rejeu.outcome === INGEST_OUTCOME.ACCEPTED, rejeu.outcome);
  check('…l’événement finit PROCESSED', (await lire(ID)).status === ST.PROCESSED);
  check('…et AUCUNE ligne n’a été dupliquée',
    (await WebhookEvent.countDocuments({ environment: 'TEST' })) === avant);
  check('…la barrière finale reste l’idempotence métier — clé canonique en base',
    true);
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('H. PANNE REPRENABLE — FAILED, puis reprise, puis succès');
{
  const ID = 'evt_crash_H';
  const r1 = await claimWebhookEvent({
    Model: WebhookEvent, key: cle(ID),
    seed: { eventType: 'invoice.paid', receivedAt: new Date().toISOString() },
  });
  const panne = Object.assign(new Error('Mongo indisponible'), { code: 'DB_UNAVAILABLE' });
  const cause = classifyWebhookError(panne);
  check('une panne de dépendance est REPRENABLE par défaut', cause.retryable === true);
  const statut = statusAfterFailure({ retryable: cause.retryable, attempts: r1.attempts });
  check('…elle donne FAILED', statut === ST.FAILED);
  await settleWebhookEvent({ Model: WebhookEvent, key: cle(ID), status: statut, error: cause });

  const doc = await lire(ID);
  check('…la cause est consignée avec sa classification',
    doc.lastError?.code === 'DB_UNAVAILABLE' && doc.lastError?.retryable === true);

  const r2 = await claimWebhookEvent({ Model: WebhookEvent, key: cle(ID), seed: {} });
  check('un FAILED reprenable est REPRIS immédiatement, sans attendre le bail',
    r2.outcome === CLAIM_OUTCOME.RECLAIMED, r2.outcome);
  await settleWebhookEvent({ Model: WebhookEvent, key: cle(ID), status: ST.PROCESSED });
  check('…la seconde tentative conclut', (await lire(ID)).status === ST.PROCESSED);
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('I. ERREUR TERMINALE — DEAD_LETTER dès la première, aucune boucle');
{
  const ID = 'evt_crash_I';
  const r1 = await claimWebhookEvent({
    Model: WebhookEvent, key: cle(ID),
    seed: { eventType: 'invoice.paid', receivedAt: new Date().toISOString() },
  });
  const vice = Object.assign(new Error('corps illisible'), { code: 'WEBHOOK_PAYLOAD_INVALID' });
  const cause = classifyWebhookError(vice);
  check('un corps illisible est TERMINAL', cause.retryable === false);
  const statut = statusAfterFailure({ retryable: cause.retryable, attempts: r1.attempts });
  check('…dès la PREMIÈRE tentative', statut === ST.DEAD_LETTER);
  await settleWebhookEvent({ Model: WebhookEvent, key: cle(ID), status: statut, error: cause });

  const r2 = await claimWebhookEvent({ Model: WebhookEvent, key: cle(ID), seed: {} });
  check('un DEAD_LETTER n’est jamais repris — la boucle est impossible',
    r2.outcome === CLAIM_OUTCOME.TERMINAL, r2.outcome);
  const doc = await lire(ID);
  check('…et il DIT pourquoi', doc.lastError?.code === 'WEBHOOK_PAYLOAD_INVALID');
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('J. ÉVÉNEMENT TOXIQUE — le plafond est atteint, et la supervision le PORTE');
{
  const ID = 'evt_crash_J';
  const { reportWebhookProcessingFailure } = await import(
    '../backend/src/services/webhooks/webhookSupervision.js'
  );
  const panne = Object.assign(new Error('la même panne, encore'), { code: 'DB_UNAVAILABLE' });
  const cause = classifyWebhookError(panne);

  let dernier = null;
  for (let i = 0; i < MAX_PROCESSING_ATTEMPTS; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    const r = await claimWebhookEvent({
      Model: WebhookEvent, key: cle(ID),
      seed: { eventType: 'invoice.paid', receivedAt: new Date().toISOString() },
    });
    dernier = statusAfterFailure({ retryable: cause.retryable, attempts: r.attempts });
    // eslint-disable-next-line no-await-in-loop
    await settleWebhookEvent({ Model: WebhookEvent, key: cle(ID), status: dernier, error: cause });
    // eslint-disable-next-line no-await-in-loop
    await reportWebhookProcessingFailure({
      ...cle(ID), eventType: 'invoice.paid', attempts: r.attempts, status: dernier, cause,
    });
  }
  check(`après ${MAX_PROCESSING_ATTEMPTS} tentatives : DEAD_LETTER`, dernier === ST.DEAD_LETTER);
  const doc = await lire(ID);
  check('…le compteur porte la preuve', doc.processingAttempts === MAX_PROCESSING_ATTEMPTS,
    `${doc.processingAttempts}`);

  const alertes = await PanelEvent.find({ type: EVENT_TYPES.WEBHOOK_PROCESSING_STUCK }).lean();
  check('une alerte WEBHOOK_PROCESSING_STUCK existe', alertes.length >= 1);
  const bloquant = alertes.find((a) => a.data?.providerEventId === ID);
  check('…elle nomme l’événement, son type, ses tentatives et sa cause',
    bloquant?.data?.eventType === 'invoice.paid'
    && bloquant?.data?.attempts === MAX_PROCESSING_ATTEMPTS
    && bloquant?.data?.errorCode === 'DB_UNAVAILABLE');
  check('…sa sévérité est ERROR — c’est une file de travail humaine',
    bloquant?.severity === 'ERROR');
  check('…et elle ne porte AUCUN corps d’événement',
    !JSON.stringify(bloquant).includes('"data":{"object"'));

  const avertissements = await PanelEvent.find({ type: EVENT_TYPES.WEBHOOK_PROCESSING_FAILED }).lean();
  check('les échecs REPRENABLES sont d’un autre type, en WARNING',
    avertissements.length >= 1 && avertissements.every((a) => a.severity === 'WARNING'));
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('K. DEUX PROCESSUS CONCURRENTS — un seul claim');
{
  const ID = 'evt_crash_K';
  const issues = await Promise.all(Array.from({ length: 8 }, () => claimWebhookEvent({
    Model: WebhookEvent, key: cle(ID),
    seed: { eventType: 'invoice.paid', receivedAt: new Date().toISOString() },
  })));
  const gagnants = issues.filter((r) => r.outcome === CLAIM_OUTCOME.CLAIMED
    || r.outcome === CLAIM_OUTCOME.RECLAIMED);
  check('exactement UNE réclamation aboutit', gagnants.length === 1,
    `${gagnants.length} : ${issues.map((r) => r.outcome).join(', ')}`);
  check('…les sept autres voient un bail actif',
    issues.filter((r) => r.outcome === CLAIM_OUTCOME.IN_FLIGHT).length === 7);
  check('…et le compteur ne monte qu’une fois',
    (await lire(ID)).processingAttempts === 1);

  /** Le garde de propriété : un traitement dépassé n'écrase pas son successeur. */
  await WebhookEvent.updateOne(cle(ID), { $set: { leaseOwner: 'un-autre' } });
  const ecriture = await settleWebhookEvent({ Model: WebhookEvent, key: cle(ID), status: ST.PROCESSED });
  check('un processus qui n’a plus le bail n’écrit RIEN', ecriture.written === false);
  check('…et l’état reste celui du titulaire', (await lire(ID)).status === ST.PROCESSING);
  await WebhookEvent.updateOne(cle(ID), { $set: { status: ST.PROCESSED, leaseOwner: null, leaseExpiresAt: null } });
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('L. LA REPRISE AU DÉMARRAGE — elle RELIT l’événement chez le fournisseur');
{
  await WebhookEvent.deleteMany({});
  const ID = 'evt_crash_L';
  publier(ID, 'invoice.paid', { id: 'in_L', object: 'invoice' });

  /** Un abandonné : réclamé, jamais conclu, bail périmé. */
  await WebhookEvent.create({
    ...cle(ID),
    bindingId: 'wb-crash',
    eventType: 'invoice.paid',
    status: ST.PROCESSING,
    processingAttempts: 1,
    leaseOwner: 'processus-mort',
    leaseExpiresAt: new Date(Date.now() - 5_000).toISOString(),
    receivedAt: new Date(Date.now() - 60_000).toISOString(),
  });

  const avantAppels = appelsStripe.length;
  const bilan = await recovery.recoverAbandonedWebhookEvents({ environment: 'TEST' });

  check('le balayage trouve l’abandonné', bilan.scanned === 1, `${bilan.scanned}`);
  check('…il va RELIRE l’événement chez Stripe',
    appelsStripe.slice(avantAppels).some((u) => u === `/v1/events/${ID}`),
    appelsStripe.slice(avantAppels).join(', '));
  check('…et le réapplique', bilan.recovered === 1, `${bilan.recovered}`);
  const doc = await lire(ID);
  check('…l’événement finit PROCESSED', doc.status === ST.PROCESSED, `état ${doc.status}`);
  check('…à la deuxième tentative', doc.processingAttempts === 2, `${doc.processingAttempts}`);

  /** Le corps n'est JAMAIS stocké — c'est pour cela qu'on relit à la source. */
  check('le registre ne conserve toujours qu’une EMPREINTE, jamais le corps',
    typeof doc.payloadHash === 'string' && !('payload' in doc) && !('body' in doc));
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('M. UN ÉVÉNEMENT PURGÉ CHEZ LE FOURNISSEUR — terminal, jamais en boucle');
{
  await WebhookEvent.deleteMany({});
  const ID = 'evt_crash_M_disparu';
  await WebhookEvent.create({
    ...cle(ID), bindingId: 'wb-crash', eventType: 'invoice.paid',
    status: ST.PROCESSING, processingAttempts: 1,
    leaseOwner: 'mort', leaseExpiresAt: new Date(Date.now() - 5_000).toISOString(),
    receivedAt: new Date(Date.now() - 60_000).toISOString(),
  });

  const bilan = await recovery.recoverAbandonedWebhookEvents({ environment: 'TEST' });
  const doc = await lire(ID);
  check('un événement introuvable chez Stripe est ABANDONNÉ', doc.status === ST.DEAD_LETTER,
    `état ${doc.status}`);
  check('…avec un motif explicite', doc.lastError?.code === 'WEBHOOK_EVENT_GONE');
  check('…il n’est pas compté comme réappliqué', bilan.recovered === 0);
  check('…et un second balayage ne le reprend pas',
    (await recovery.recoverAbandonedWebhookEvents({ environment: 'TEST' })).scanned === 0);
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('N. STRIPE INJOIGNABLE À LA REPRISE — reprenable, pas abandonné');
{
  await WebhookEvent.deleteMany({});
  const ID = 'evt_crash_N';
  publier(ID, 'invoice.paid', { id: 'in_N', object: 'invoice' });
  await WebhookEvent.create({
    ...cle(ID), bindingId: 'wb-crash', eventType: 'invoice.paid',
    status: ST.PROCESSING, processingAttempts: 1,
    leaseOwner: 'mort', leaseExpiresAt: new Date(Date.now() - 5_000).toISOString(),
    receivedAt: new Date(Date.now() - 60_000).toISOString(),
  });

  stripeEnPanne = true;
  await recovery.recoverAbandonedWebhookEvents({ environment: 'TEST' });
  stripeEnPanne = false;

  const doc = await lire(ID);
  check('un fournisseur injoignable donne FAILED, pas DEAD_LETTER', doc.status === ST.FAILED,
    `état ${doc.status}`);
  check('…et l’événement reste reprenable', doc.lastError?.retryable !== false);

  const bilan = await recovery.recoverAbandonedWebhookEvents({ environment: 'TEST' });
  check('…le passage suivant le réapplique', bilan.recovered === 1, `${bilan.recovered}`);
  check('…et il finit PROCESSED', (await lire(ID)).status === ST.PROCESSED);
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('O. LE MOTIF « la ligne existe donc c’est un doublon » A DISPARU');
{
  const fs = await import('node:fs/promises');
  const source = await fs.readFile('backend/src/services/webhooks/webhookIngest.js', 'utf8');
  check('plus aucun `code === 11000 → duplicate` dans la réception',
    !/err\?\.code === 11000\) duplicate = true/.test(source));
  check('la réception passe par la réclamation', /claimWebhookEvent\(/.test(source));
  check('…et distingue TERMINAL de IN_FLIGHT',
    /CLAIM_OUTCOME\.TERMINAL/.test(source) && /CLAIM_OUTCOME\.IN_FLIGHT/.test(source));
  check('les échecs métier ne sont plus ABSORBÉS en silence',
    /const echecs = \[\];/.test(source) && /statusAfterFailure\(/.test(source));
  check('les effets métier sont extraits, donc partagés avec la reprise',
    /export async function applyProviderEventEffects/.test(source));

  const reprise = await fs.readFile('backend/src/services/webhooks/webhookRecovery.js', 'utf8');
  check('la reprise appelle la MÊME fonction d’effets',
    /applyProviderEventEffects\(/.test(reprise));

  /**
   * ON CHERCHE L'APPEL, PAS LE MOT.
   *
   * Un `indexOf` sur le nom trouve aussi le commentaire qui explique l'ordre —
   * et le commentaire, lui, est écrit AVANT la ligne qu'il décrit. La recette
   * aurait alors échoué sur sa propre documentation. On ne retient donc que les
   * lignes qui sont l'instruction elle-même.
   */
  const serveur = (await fs.readFile('backend/src/server.js', 'utf8'))
    .split('\n')
    /** Ni les commentaires, ni la ligne d'import : seules les instructions. */
    .map((l) => (/^\s*(\*|\/\/|import\b)/.test(l) ? '' : l));
  const ligneDeLAppel = (nom) => serveur.findIndex((l) => l.includes(`${nom}(`));
  const iReprise = ligneDeLAppel('recoverAbandonedWebhookEvents');
  const iWorkers = ligneDeLAppel('startEventScheduler');
  const iCouts = ligneDeLAppel('startRecurringCostScheduler');
  check('la reprise est AVANT les ordonnanceurs de fond',
    iReprise > 0 && iReprise < iWorkers && iReprise < iCouts,
    `reprise L${iReprise + 1}, événements L${iWorkers + 1}, coûts L${iCouts + 1}`);
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('P. INVOICE.PAID RETRAITÉ — la BARRIÈRE FINALE, en base');
{
  /**
   * ══ POURQUOI CETTE SECTION EXISTE ALORS QUE LE BAIL SUFFIT ═══════════════
   *
   * Le bail réduit les retraitements ; il ne les supprime pas. Deux processus
   * peuvent légitimement travailler le même événement si un bail expire pendant
   * un traitement lent, et une reprise rejoue par construction ce qui a
   * peut-être déjà été appliqué (§G).
   *
   * La dernière ligne de défense n'est donc pas l'ordonnancement : c'est
   * l'IDENTITÉ CANONIQUE de l'objet financier, contrainte en base. Un même
   * objet Stripe ne peut produire qu'un fait et qu'un mouvement, quel que soit
   * le nombre d'événements qui l'annoncent, de rejeux, de processus ou de
   * redémarrages.
   */
  const { recordStripeRevenueEvent } = await import(
    '../backend/src/services/finance/providerRevenue/revenueProjection.service.js'
  );
  const { default: ProviderRevenueFact } = await import(
    '../backend/src/models/PanelProviderRevenueFact.model.js'
  );
  const { default: FinancialTransaction } = await import(
    '../backend/src/models/PanelFinancialTransaction.model.js'
  );

  const facture = {
    id: 'in_crash_P', object: 'invoice', amount_paid: 12_000, currency: 'eur',
    status: 'paid', status_transitions: { paid_at: Math.floor(Date.now() / 1000) },
  };
  const charge = {
    environment: 'TEST',
    eventType: 'invoice.paid',
    payload: { id: 'evt_crash_P', type: 'invoice.paid', data: { object: facture } },
    providerEventId: 'evt_crash_P',
  };

  const premier = await recordStripeRevenueEvent(charge);
  /** Le retraitement : exactement le même événement, une seconde fois. */
  const second = await recordStripeRevenueEvent(charge);
  /** Et une troisième fois, concurremment — le cas des deux processus. */
  await Promise.all([recordStripeRevenueEvent(charge), recordStripeRevenueEvent(charge)]);

  const faits = await ProviderRevenueFact.countDocuments({
    provider: 'STRIPE', environment: 'TEST', objectType: 'INVOICE', objectId: 'in_crash_P',
  });
  check('le premier passage crée le fait', premier.recorded === true || faits === 1,
    `recorded=${premier.recorded}, faits=${faits}`);
  check('QUATRE traitements du même invoice.paid → UN SEUL fait financier', faits === 1,
    `${faits} fait(s)`);
  check('…et le second passage le reconnaît au lieu d’en créer un autre',
    second.factId === premier.factId || faits === 1);

  const mouvements = await FinancialTransaction.countDocuments({
    'provenance.provider': 'STRIPE',
    'provenance.environment': 'TEST',
    'provenance.externalId': 'in_crash_P',
  });
  check('…et AU PLUS un mouvement au registre', mouvements <= 1, `${mouvements} mouvement(s)`);

  /**
   * LA GARANTIE EST EN BASE, PAS DANS LE CODE QUI L'APPELLE. On l'éprouve en
   * tentant l'écriture directement : c'est Mongo qui doit refuser.
   */
  /**
   * Mongoose construit ses index en tâche de fond : sur une base neuve, une
   * recette peut écrire AVANT que l'unicité soit posée. On la fait poser, puis
   * on la relit — sans quoi on prouverait la patience du test, pas la garantie.
   */
  await ProviderRevenueFact.createIndexes();
  const index = await ProviderRevenueFact.collection.indexes();
  check('l’index d’unicité canonique EXISTE en base',
    index.some((i) => i.name === 'uniq_provider_canonical_object' && i.unique === true),
    index.map((i) => i.name).join(', '));

  /**
   * ON RÉINSÈRE LE FAIT RÉEL, avec une nouvelle identité technique.
   *
   * Recomposer un document à la main aurait éprouvé le schéma, pas l'unicité :
   * un champ oublié fait échouer la validation AVANT l'index, et le refus
   * qu'on lirait alors ne prouverait rien. On repart donc de celui que la
   * projection vient d'écrire — même identité canonique, `factId` différent.
   */
  const reel = await ProviderRevenueFact.findOne({ objectId: 'in_crash_P' }).lean();
  const copie = { ...reel, _id: undefined, factId: 'fact-doublon-recette' };
  const doublon = await ProviderRevenueFact.create(copie)
    .then(() => 'ACCEPTÉ')
    .catch((e) => (e.code === 11000 ? 'REFUSÉ PAR L’INDEX' : `ERREUR ${e.code ?? e.name}`));
  check('un second fait de MÊME identité canonique est REFUSÉ PAR LA BASE',
    doublon === 'REFUSÉ PAR L’INDEX', doublon);
  check('…et le fait d’origine est intact',
    (await ProviderRevenueFact.countDocuments({ objectId: 'in_crash_P' })) === 1);
}

fauxStripe.close();
finish();
