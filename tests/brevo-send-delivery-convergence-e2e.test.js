// LA TRANCHE VERTICALE BREVO — envoi ET retour de livraison (L8.4C).
//
// ══ CE QUE CE TEST PROUVE, ET CE QU'IL REFUSE DE RACCOURCIR ══════════════════
//
//   · un vrai Panel, sur un vrai port, avec son coffre chiffré ;
//   · une vraie instance SB Auto, dans SON processus, avec SA base ;
//   · un vrai appairage, un vrai octroi ;
//   · un e-mail demandé par la VRAIE façade métier du projet, `sendTemplate()` ;
//   · un faux Brevo qui parle HTTP pour de bon, et note QUELLE clé arrive ;
//   · un webhook entrant sur la VRAIE route publique du Panel ;
//   · le bus durable réel jusqu'au projet ;
//   · et à la fin, l'état de `EmailDelivery` LU DANS LA BASE DU PROJET.
//
// Le test n'appelle jamais la passerelle, ni l'adaptateur, ni le dispatcher :
// il entre par où entre une action métier, et regarde ce qui atterrit à
// l'autre bout. Court-circuiter une moitié ne prouverait que la bonne foi du
// raccourci.
import http from 'node:http';

import {
  check, connectTestDatabase, finish, section, setTestEnv,
  startMemoryMongo, startServer, stopMemoryMongo,
} from './helpers/harness.js';
import { startSbAutoInstance } from './helpers/sbauto-remote.js';

setTestEnv();
const MONGO_URI = await startMemoryMongo();
await connectTestDatabase();

/* ══════════════════════════════════════════════════════════════════════════
   SENTINELLES — une occurrence hors du coffre du Panel est une fuite.
   ══════════════════════════════════════════════════════════════════════════ */
const CLE_PANEL = ['xkeysib', 'L84CPANELTESTSEULEAUTORISEE0001'].join('-');
const CLE_PROJET_LEGACY = ['xkeysib', 'L84CPROJETLEGACYJAMAISUTILISEE2'].join('-');
const TOUTES = [CLE_PANEL, CLE_PROJET_LEGACY];

const ACTEUR = { userId: 'u-dev', userEmail: 'dev@panel.test' };
const SEND = 'email.send_template';
const TEMPLATE = 'PASSWORD_RESET_REQUEST';

const propre = (v) => {
  const t = typeof v === 'string' ? v : JSON.stringify(v ?? null);
  return !TOUTES.some((s) => t.includes(s));
};

/* ══════════════════════════════════════════════════════════════════════════
   UN FAUX BREVO QUI PARLE VRAIMENT HTTP.
   ══════════════════════════════════════════════════════════════════════════ */
const appelsBrevo = [];
const webhooksBrevo = [];
let messageIdSuivant = 1;
const fauxBrevo = http.createServer((req, res) => {
  let corps = '';
  req.on('data', (c) => { corps += c; });
  req.on('end', () => {
    appelsBrevo.push({
      url: req.url,
      apiKey: req.headers['api-key'] ?? null,
      body: corps,
    });
    // Le compte tient ses webhooks : sans cela, la réconciliation croirait
    // l'endpoint disparu juste après l'avoir créé.
    if (req.url.includes('/webhooks')) {
      if (req.method === 'POST') {
        const w = { id: 900 + webhooksBrevo.length, ...JSON.parse(corps || '{}') };
        webhooksBrevo.push(w);
        res.writeHead(201, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ id: w.id }));
        return;
      }
      if (req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ webhooks: webhooksBrevo }));
        return;
      }
      res.writeHead(204); res.end(); return;
    }
    if (req.url.includes('/smtp/email')) {
      // Brevo rend l'identifiant AVEC chevrons — c'est sa graphie réelle.
      res.writeHead(201, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ messageId: `<msg-${messageIdSuivant++}@brevo>` }));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ companyName: 'Plateforme', email: 'ops@plateforme.test' }));
  });
});
await new Promise((r) => fauxBrevo.listen(0, '127.0.0.1', r));
const BREVO_BASE = `http://127.0.0.1:${fauxBrevo.address().port}/v3`;

const { createApp } = await import('../backend/src/app.js');
const registre = await import('../backend/src/services/registry/projectRegistry.service.js');
const controlPlane = await import('../backend/src/services/integratedApi/controlPlane.service.js');
const senders = await import('../backend/src/services/email/panelSenderIdentity.service.js');
const globalSender = await import('../backend/src/services/email/panelGlobalSender.service.js');
const templates = await import('../backend/src/services/email/panelEmailTemplate.service.js');
const { seedIntegratedApiCredentialSets } = await import('../backend/src/services/integratedApi/seed.js');
const { resetSyncCore } = await import('../backend/src/services/sync/syncCore.service.js');
const { updateNetworkConfiguration } = await import('../backend/src/services/network/networkConfig.service.js');
const { reconcileProviderWebhook } = await import('../backend/src/services/webhooks/webhookReconciler.js');
const { loadVerificationSecrets } = await import('../backend/src/services/webhooks/webhookSecrets.js');
const { default: CredentialSet } = await import('../backend/src/models/PanelIntegratedApiCredentialSet.model.js');
const { default: Operation } = await import('../backend/src/models/PanelCapabilityOperation.model.js');

await resetSyncCore();
await seedIntegratedApiCredentialSets();
await templates.seedPlatformTemplates();
await updateNetworkConfiguration({ backendUrl: 'https://panel-l84c.test' }, { requirePublic: false });

const { base: panelUrl } = await startServer(createApp());

/* ══════════════════════════════════════════════════════════════════════════
   1. LE PANEL EST PRÊT — clé, modèle, webhook.
   ══════════════════════════════════════════════════════════════════════════ */
section('1 · Le Panel détient la clé, le modèle et l’endpoint');
{
  await controlPlane.saveCredentialSet('BREVO', 'TEST', {
    values: { apiKey: CLE_PANEL, baseUrl: BREVO_BASE },
  }, ACTEUR);
  const verdict = await controlPlane.validateCredentialSet('BREVO', 'TEST', { actor: ACTEUR });
  check('la clé du Panel est validée par un appel réel', verdict.validation.status === 'VALID');

  // Le binding webhook doit exister : sans lui, un appel entrant est refusé.
  const rec = await reconcileProviderWebhook({ provider: 'BREVO' });
  check('le webhook Brevo du Panel est réconcilié', rec.status === 'READY');
  check('…et son jeton de vérification est en coffre', rec.secretConfigured === true);
}

/* ══════════════════════════════════════════════════════════════════════════
   2. UNE INSTANCE RÉELLE, APPAIRÉE, AVEC SA CLÉ LEGACY INTACTE.
   ══════════════════════════════════════════════════════════════════════════ */
const instance = await startSbAutoInstance({
  mongoUri: MONGO_URI, dbName: 'sbauto_l84c', env: 'TEST', projectName: 'Projet L8.4C',
});

let projectId;
section('2 · Appairage, octroi, identité expéditrice');
{
  const declared = await registre.declareProject({
    publicBackendUrl: instance.publicBackendUrl,
    projectName: instance.projectName,
    environment: 'TEST',
  });
  const r = await instance.pair({
    panelUrl, pairingCode: declared.pairingCode, publicBackendUrl: instance.publicBackendUrl,
  });
  projectId = r.projectId;
  instance.projectId = projectId;
  await instance.heartbeat();
  check('le projet est appairé', typeof projectId === 'string');

  /**
   * R10.4 — l'expéditeur est GLOBAL, l'adresse de réponse reste au projet.
   * L'envoi exige le premier ; le second est facultatif, et on le pose pour
   * éprouver que les deux voyagent ensemble jusqu'à Brevo.
   */
  await globalSender.updateGlobalSender(
    { senderEmail: 'support@ly-solution.test', senderName: 'L.Y Solution' }, ACTEUR,
  );
  await senders.saveSenderIdentity(projectId, 'TEST', {
    replyToEmail: 'sav@projet-l84c.test',
  }, ACTEUR);
  check('l’octroi, l’expéditeur global et l’adresse de réponse sont posés', true);
  /**
   * ══ LE PROJET DÉCLARE CE QU'IL CONSOMME, ET C'EST CE QUI L'ÉQUIPE ═════════
   *
   * Cette section posait l'expéditeur et passait à l'envoi. Elle ne le peut
   * plus, et le produit a raison : depuis L11.1, le Panel ne sert JAMAIS son
   * propre contenu sous le nom d'un projet — il exige une instance écrite pour
   * cette portée. Et depuis ce lot, il ne devine pas non plus lesquelles : le
   * projet DÉCLARE en direct les `templateCode` qu'il consomme.
   *
   * Cette déclaration part avec la photographie complète du (ré)appairage —
   * `reconcileAll()` — donc elle est déjà EN FILE ici. Ce qui manque est le
   * cycle qui la pousse : `syncNow()` est ce cycle, celui de l'ordonnanceur
   * réel. On l'appelle, puis on vérifie que le Panel a bien reçu la déclaration
   * et provisionné ce qu'elle demande — sans qu'aucun écran ni aucun script
   * n'ait eu à nommer un modèle.
   */
  /**
   * ON ATTEND QUE LA FILE SE VIDE — un cycle peut déjà être en vol.
   *
   * L'appairage déclenche lui-même une poussée ; un `syncNow()` immédiat
   * répond `ALREADY_RUNNING` et ne pousse rien. Attendre l'ÉTAT (file vide)
   * plutôt que l'appel est la seule condition qui ait un sens ici : c'est
   * celle que le produit atteint tout seul, en exploitation.
   */
  for (let essai = 0; essai < 40; essai += 1) {
    if ((await instance.outboxPending()) === 0) break;
    await instance.syncNow().catch(() => {});
    await new Promise((r) => { setTimeout(r, 100); });
  }
  check('la file de projections du projet s’est vidée', (await instance.outboxPending()) === 0);
  {
    const { PanelProjectEmailTemplateUsage } = await import('../backend/src/models/PanelProjectProjection.model.js');
    const { default: PanelEmailTemplate } = await import('../backend/src/models/PanelEmailTemplate.model.js');
    const declaration = await PanelProjectEmailTemplateUsage.findOne({ projectId }).lean();
    check('le projet a DÉCLARÉ les modèles qu’il consomme',
      (declaration?.templateCodes ?? []).length > 0);
    check(`…dont « ${TEMPLATE} », celui que cette recette envoie`,
      (declaration?.templateCodes ?? []).includes(TEMPLATE));
    const instances = await PanelEmailTemplate.find({ projectId }).select('templateCode').lean();
    check('…et le Panel a provisionné une instance pour chacun',
      instances.length === declaration.templateCodes.length);
  }
}

/** Poste un webhook Brevo sur la VRAIE route publique du Panel. */
async function webhookBrevo(payload) {
  const secret = (await loadVerificationSecrets('BREVO', 'TEST'))[0];
  const res = await fetch(`${panelUrl}/webhooks/providers/brevo`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${secret}` },
    body: JSON.stringify(payload),
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

/** Attend que le projet ait convergé, sans jamais dormir « au cas où ». */
async function convergence(deliveryId, attendu, essais = 40) {
  for (let i = 0; i < essais; i += 1) {
    const d = await instance.emailDelivery({ deliveryId });
    if (d?.status === attendu) return d;
    await instance.pull({}).catch(() => {});
  }
  return instance.emailDelivery({ deliveryId });
}

const VARIABLES = {
  'company.name': 'Entreprise L8.4C',
  'user.name': 'Client Test',
  'auth.resetUrl': 'https://projet-l84c.test/reset?t=abc',
  'auth.expiresMinutes': 30,
};

/* ══════════════════════════════════════════════════════════════════════════
   3. L'ENVOI — par la façade métier réelle du projet.
   ══════════════════════════════════════════════════════════════════════════ */
let deliveryId;
let providerMessageId;

section('3 · sendTemplate() passe par le Panel, et la clé du Panel seule sort');
{
  const avant = appelsBrevo.length;
  const envoi = await instance.sendEmail({
    templateId: TEMPLATE,
    recipient: { email: 'client@exemple.test' },
    variables: VARIABLES,
  });

  check('l’envoi aboutit', envoi.ok === true);
  deliveryId = envoi.delivery?.deliveryId;
  check('une livraison existe', typeof deliveryId === 'string');
  check('elle est SENT', envoi.delivery?.status === 'SENT');

  check('UN appel Brevo a eu lieu', appelsBrevo.length === avant + 1);
  const appel = appelsBrevo.at(-1);
  check('…sur /smtp/email', appel.url.includes('/smtp/email'));
  check('…AVEC LA CLÉ DU PANEL', appel.apiKey === CLE_PANEL);
  check('…JAMAIS la clé legacy du projet', appel.apiKey !== CLE_PROJET_LEGACY);
  check('aucun templateId Brevo dans le corps', !JSON.parse(appel.body).templateId);
  check('le corps porte le sujet et le HTML rendus par le Panel',
    typeof JSON.parse(appel.body).subject === 'string'
    && String(JSON.parse(appel.body).htmlContent).includes('Entreprise L8.4C'));
  /**
   * R10.4 — l'expéditeur est GLOBAL, l'adresse de réponse reste au projet.
   *
   * Les deux partent dans le MÊME appel, et c'est tout l'intérêt de les vérifier
   * ici plutôt qu'en test unitaire : le `From` que Brevo reçoit ne dépend
   * d'aucun réglage de ce projet, et le `Reply-To` n'en dépend que de lui.
   */
  check('SINGLE_GLOBAL_FROM — l’expéditeur est celui de la plateforme',
    JSON.parse(appel.body).sender?.email === 'support@ly-solution.test');
  check('…et jamais une adresse propre au projet',
    JSON.parse(appel.body).sender?.email !== 'contact@projet-l84c.test');
  check('l’adresse de réponse, elle, est celle du PROJET',
    JSON.parse(appel.body).replyTo?.email === 'sav@projet-l84c.test');

  // operationId === deliveryId : l'invariant qui referme la course.
  const op = await Operation.findOne({ capability: SEND, projectId }).lean();
  check('operationId === deliveryId', op?.operationId === deliveryId);
  check('l’opération est SUCCEEDED', op?.status === 'SUCCEEDED');

  const etat = await instance.emailDelivery({ deliveryId });
  providerMessageId = etat.providerMessageId;
  check('le providerMessageId est persisté côté projet', typeof providerMessageId === 'string');
  check('…sous forme CANONIQUE, sans chevrons', !providerMessageId.includes('<'));
}

/* ══════════════════════════════════════════════════════════════════════════
   4. LE RETOUR — webhook Brevo jusqu'à DELIVERED.
   ══════════════════════════════════════════════════════════════════════════ */
section('4 · Le webhook fait converger EmailDelivery sur DELIVERED');
{
  const r = await webhookBrevo({
    event: 'delivered',
    'message-id': `<${providerMessageId}>`,
    email: 'client@exemple.test',
    ts_epoch: Date.now(),
  });
  check('le Panel accepte le webhook', r.status === 200);

  const converge = await convergence(deliveryId, 'DELIVERED');
  check('EMAILDELIVERY EST DELIVERED', converge.status === 'DELIVERED');
  check('…et daté', converge.deliveredAt !== null);
  check('…avec une ligne d’historique', converge.eventCount >= 1);
}

/* ══════════════════════════════════════════════════════════════════════════
   5. DOUBLONS ET HORS ORDRE.
   ══════════════════════════════════════════════════════════════════════════ */
section('5 · Un doublon n’a qu’un effet, un événement tardif ne régresse rien');
{
  const avantEvents = (await instance.emailDelivery({ deliveryId })).eventCount;

  // MÊME webhook, deux fois — dont une fois SANS chevrons.
  await webhookBrevo({
    event: 'delivered', 'message-id': `<${providerMessageId}>`,
    email: 'client@exemple.test', ts_epoch: 1,
  });
  await webhookBrevo({
    event: 'delivered', 'message-id': providerMessageId,
    email: 'client@exemple.test', ts_epoch: 1,
  });
  await instance.syncNow().catch(() => {});

  const apres = await instance.emailDelivery({ deliveryId });
  check('le statut reste DELIVERED', apres.status === 'DELIVERED');
  check('les deux graphies du message-id désignent le MÊME fait',
    apres.eventCount === avantEvents);

  // Un « deferred » tardif ne fait pas régresser un DELIVERED.
  await webhookBrevo({
    event: 'deferred', 'message-id': providerMessageId,
    email: 'client@exemple.test', ts_epoch: Date.now(),
  });
  await instance.syncNow().catch(() => {});
  check('un événement tardif ne fait PAS régresser DELIVERED',
    (await instance.emailDelivery({ deliveryId })).status === 'DELIVERED');
}

/* ══════════════════════════════════════════════════════════════════════════
   6. REJEU DU MÊME ENVOI — un seul e-mail, une seule livraison.
   ══════════════════════════════════════════════════════════════════════════ */
section('6 · Rejouer la même intention n’envoie pas un second e-mail');
{
  const avantAppels = appelsBrevo.length;
  const avantLivraisons = await instance.emailDeliveryCount();

  const action = 'action-idempotente-001';
  const un = await instance.sendEmail({
    templateId: TEMPLATE, recipient: { email: 'client2@exemple.test' },
    variables: VARIABLES, actionExecutionId: action,
  });
  const deux = await instance.sendEmail({
    templateId: TEMPLATE, recipient: { email: 'client2@exemple.test' },
    variables: VARIABLES, actionExecutionId: action,
  });

  check('les deux appels aboutissent', un.ok === true && deux.ok === true);
  check('UN SEUL appel Brevo pour les deux', appelsBrevo.length === avantAppels + 1);
  check('UNE SEULE livraison créée',
    (await instance.emailDeliveryCount()) === avantLivraisons + 1);
  check('…et c’est la même', un.delivery.deliveryId === deux.delivery.deliveryId);
}

/* ══════════════════════════════════════════════════════════════════════════
   7. PROJET HORS LIGNE — l'événement attend, puis s'applique une seule fois.
   ══════════════════════════════════════════════════════════════════════════ */
section('7 · Projet éteint : l’événement est conservé, puis appliqué');
{
  const envoi = await instance.sendEmail({
    templateId: TEMPLATE, recipient: { email: 'offline@exemple.test' }, variables: VARIABLES,
  });
  const id = envoi.delivery.deliveryId;
  const etat = await instance.emailDelivery({ deliveryId: id });

  await instance.goOffline();

  const r = await webhookBrevo({
    event: 'delivered', 'message-id': `<${etat.providerMessageId}>`,
    email: 'offline@exemple.test', ts_epoch: Date.now(),
  });
  check('le Panel accepte le webhook même projet éteint', r.status === 200);
  check('…et la livraison est encore SENT chez le projet',
    (await instance.emailDelivery({ deliveryId: id })).status === 'SENT');

  await instance.goOnline();
  const converge = await convergence(id, 'DELIVERED');
  check('AU RETOUR, LA LIVRAISON CONVERGE', converge.status === 'DELIVERED');
  check('…appliquée une seule fois', converge.eventCount === 1);
}

/* ══════════════════════════════════════════════════════════════════════════
   8. AUCUN SECRET NULLE PART.
   ══════════════════════════════════════════════════════════════════════════ */
section('8 · La clé legacy du projet n’a jamais servi');
{
  check('AUCUN appel Brevo n’a porté la clé legacy',
    appelsBrevo.every((a) => a.apiKey !== CLE_PROJET_LEGACY));
  check('tous les appels ont porté la clé du Panel',
    appelsBrevo.every((a) => a.apiKey === CLE_PANEL));

  const dump = await instance.dbDump();
  check('aucune clé du Panel n’a atterri chez le projet', propre(dump));

  const coffre = await CredentialSet.collection.find({}).toArray();
  check('le coffre du Panel ne contient aucune valeur lisible', propre(coffre));

  const operations = await Operation.collection.find({}).toArray();
  check('le registre d’opérations ne porte ni secret ni adresse',
    propre(operations) && !JSON.stringify(operations).includes('client@exemple.test'));
}

await instance.stop();
await new Promise((r) => fauxBrevo.close(r));
await stopMemoryMongo();
finish();
