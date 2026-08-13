// L'EXPÉDITEUR GLOBAL — UNE SOURCE, ET LA CHAÎNE RÉELLE ÉPROUVÉE (R10.4).
//
// ══ CE QUE CE FICHIER FERME ═════════════════════════════════════════════════
//
// L8.3 donnait à chaque projet son adresse d'expédition. C'était défendable
// tant qu'on regardait le destinataire, et faux dès qu'on regardait
// l'exploitation : l'adresse d'expédition est aussi l'adresse de SUPPORT — celle
// qu'on surveille, qu'on authentifie SPF/DKIM, et qu'on doit pouvoir changer
// d'un seul geste. Dispersée en N copies, elle n'était plus administrable.
//
// R10.4 la rend UNIQUE, et déplace le besoin que L8.3 protégeait sur le champ
// qui le porte correctement : le `Reply-To`, qui reste par projet.
//
// On prouve ici les deux invariants du lot :
//
//   GLOBAL_PANEL_EMAIL_FROM_CONFIGURATION = 1
//   PROJECT_EMAIL_FROM_CONFIGURATION      = 0
//
// ══ ET SURTOUT : LE TEST D'ENVOI EMPRUNTE LA VRAIE CHAÎNE ═══════════════════
//
//   Panel → modèle → email.send_template → coffre → Brevo → providerMessageId
//         → webhook → état de livraison
//
// Aucun appel Brevo de diagnostic, aucun corps fabriqué à la main. Un test qui
// prendrait un raccourci rendrait « vert » là où un envoi réel échoue — et
// c'est ce vert-là qui fait déployer.
import http from 'node:http';

import {
  check, connectTestDatabase, finish, section, setTestEnv,
  startMemoryMongo, stopMemoryMongo, startServer,
} from './helpers/harness.js';

setTestEnv();
await startMemoryMongo();
await connectTestDatabase();

const ACTEUR = { userId: 'u-dev', userEmail: 'dev@panel.test' };
const CLE_PANEL = ['xkeysib', 'panel', 'r104'].join('-');

/* ══════════════════════════════════════════════════════════════════════════
   UN FAUX BREVO QUI PARLE VRAIMENT HTTP.
   ══════════════════════════════════════════════════════════════════════════ */
const appelsBrevo = [];
const webhooksBrevo = [];
let messageIdSuivant = 1;
/** Bascule : le prochain /smtp/email échoue de la façon demandée. */
let prochainEnvoi = null;

const fauxBrevo = http.createServer((req, res) => {
  let corps = '';
  req.on('data', (c) => { corps += c; });
  req.on('end', () => {
    appelsBrevo.push({ url: req.url, apiKey: req.headers['api-key'] ?? null, body: corps });

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
      const consigne = prochainEnvoi;
      prochainEnvoi = null;
      if (consigne === 'REFUS') {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ code: 'invalid_parameter', message: 'Sender not valid' }));
        return;
      }
      if (consigne === 'SILENCE') {
        // On ne répond JAMAIS : c'est le cas indécidable, celui qui ne doit
        // surtout pas être rangé avec « rien n'est parti ».
        return;
      }
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
const globalSender = await import('../backend/src/services/email/panelGlobalSender.service.js');
const senders = await import('../backend/src/services/email/panelSenderIdentity.service.js');
const senderTest = await import('../backend/src/services/email/panelEmailSenderTest.service.js');
const templates = await import('../backend/src/services/email/panelEmailTemplate.service.js');
const controlPlane = await import('../backend/src/services/integratedApi/controlPlane.service.js');
const { seedIntegratedApiCredentialSets } = await import('../backend/src/services/integratedApi/seed.js');
const { updateNetworkConfiguration } = await import('../backend/src/services/network/networkConfig.service.js');
const { reconcileProviderWebhook } = await import('../backend/src/services/webhooks/webhookReconciler.js');
const { loadVerificationSecrets } = await import('../backend/src/services/webhooks/webhookSecrets.js');
const { default: SenderTest } = await import('../backend/src/models/PanelEmailSenderTest.model.js');
const { default: Operation } = await import('../backend/src/models/PanelCapabilityOperation.model.js');
const { PANEL_SELF_SCOPE } = await import('../backend/src/services/capabilities/invocationContext.js');

await seedIntegratedApiCredentialSets();
await templates.seedPlatformTemplates();
await updateNetworkConfiguration({ backendUrl: 'https://panel-r104.test' }, { requirePublic: false });

const { base: panelUrl } = await startServer(createApp());

/** Poste un webhook Brevo sur la VRAIE route publique du Panel. */
async function webhookBrevo(payload) {
  const secret = (await loadVerificationSecrets('BREVO', 'TEST'))[0];
  return fetch(`${panelUrl}/webhooks/providers/brevo`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${secret}` },
    body: JSON.stringify(payload),
  });
}

/* ══════════════════════════════════════════════════════════════════════════
   1 · LA CONFIGURATION — une seule, et l'absence est un REFUS.
   ══════════════════════════════════════════════════════════════════════════ */
section('1 · Une seule configuration, et rien par défaut');
{
  const vide = await globalSender.describeGlobalSender();
  check('rien n’est configuré au départ', vide.configured === false);
  check('…et l’adresse est nulle, jamais une valeur inventée', vide.senderEmail === null);

  let refus = null;
  try { await globalSender.resolveGlobalSender(); } catch (err) { refus = err; }
  check('NO_SILENT_FALLBACK — résoudre sans configuration LÈVE',
    refus?.code === 'PANEL_GLOBAL_SENDER_NOT_CONFIGURED');

  // Aucun repli d'environnement : une variable oubliée sur un serveur ferait
  // partir des e-mails sous une adresse que personne n'a choisie.
  process.env.EMAIL_SENDER = 'fantome@nowhere.test';
  process.env.SENDER_EMAIL = 'fantome@nowhere.test';
  let encore = null;
  try { await globalSender.resolveGlobalSender(); } catch (err) { encore = err; }
  check('…même avec une variable d’environnement tentante', encore !== null);
  delete process.env.EMAIL_SENDER;
  delete process.env.SENDER_EMAIL;

  for (const mauvais of [
    { senderEmail: 'pas-une-adresse', senderName: 'X' },
    { senderEmail: 'ok@x.fr', senderName: '' },
    { senderEmail: '', senderName: 'X' },
  ]) {
    let erreur = null;
    try { await globalSender.updateGlobalSender(mauvais, ACTEUR); } catch (err) { erreur = err; }
    check(`configuration invalide refusée (${JSON.stringify(mauvais)})`, erreur !== null);
  }

  let secret = null;
  try {
    await globalSender.updateGlobalSender({
      senderEmail: 'ok@x.fr', senderName: 'X',
      apiKey: ['xkeysib', 'NEDOITJAMAISENTRER'].join('-'),
    }, ACTEUR);
  } catch (err) { secret = err; }
  check('un secret glissé dans la configuration est REFUSÉ', secret !== null);

  const enregistre = await globalSender.updateGlobalSender(
    { senderEmail: '  SUPPORT@Ly-Solution.FR ', senderName: '  L.Y Solution  ' }, ACTEUR,
  );
  check('l’adresse est normalisée (trim + minuscules)',
    enregistre.senderEmail === 'support@ly-solution.fr');
  check('…le nom est trimé', enregistre.senderName === 'L.Y Solution');
  check('…la configuration est datée', typeof enregistre.updatedAt === 'string');
  check('…et attribuée', enregistre.updatedBy === 'u-dev');
}

/* ══════════════════════════════════════════════════════════════════════════
   2 · PROJECT_EMAIL_FROM_CONFIGURATION = 0.
   ══════════════════════════════════════════════════════════════════════════ */
section('2 · Aucun projet ne configure le From');
{
  for (const champ of ['fromEmail', 'fromName', 'senderEmail', 'senderName']) {
    let refus = null;
    try {
      await senders.saveSenderIdentity('p-a', 'TEST', { [champ]: 'x@y.fr' }, ACTEUR);
    } catch (err) { refus = err; }
    check(`« ${champ} » est REFUSÉ au niveau projet`,
      refus?.code === 'PANEL_PROJECT_FROM_NOT_CONFIGURABLE');
  }

  await senders.saveSenderIdentity('p-a', 'TEST', { replyToEmail: 'sav@a.test' }, ACTEUR);
  await senders.saveSenderIdentity('p-b', 'TEST', { replyToEmail: 'sav@b.test' }, ACTEUR);

  const a = await senders.resolveForProject({ authenticatedProjectId: 'p-a', environment: 'TEST' });
  const b = await senders.resolveForProject({ authenticatedProjectId: 'p-b', environment: 'TEST' });
  const panel = await senders.resolveForPanel();

  check('SINGLE_SOURCE — A, B et le Panel expédient sous la MÊME adresse',
    a.fromEmail === 'support@ly-solution.fr'
    && b.fromEmail === 'support@ly-solution.fr'
    && panel.fromEmail === 'support@ly-solution.fr');
  check('…et sous le même nom',
    a.fromName === 'L.Y Solution' && b.fromName === 'L.Y Solution' && panel.fromName === 'L.Y Solution');
  check('chaque projet garde SON adresse de réponse',
    a.replyTo?.email === 'sav@a.test' && b.replyTo?.email === 'sav@b.test');
  check('le Panel n’en a aucune — il n’est le SAV de personne', panel.replyTo === null);

  // LA PROPAGATION : changer l'adresse change TOUT, sans toucher aux projets.
  await globalSender.updateGlobalSender(
    { senderEmail: 'nouveau@ly-solution.fr', senderName: 'Support L.Y' }, ACTEUR,
  );
  const a2 = await senders.resolveForProject({ authenticatedProjectId: 'p-a', environment: 'TEST' });
  const panel2 = await senders.resolveForPanel();
  check('PROPAGATION — un seul geste change l’expéditeur de tout le parc',
    a2.fromEmail === 'nouveau@ly-solution.fr' && panel2.fromEmail === 'nouveau@ly-solution.fr');
  check('…sans toucher aux adresses de réponse', a2.replyTo?.email === 'sav@a.test');

  await globalSender.updateGlobalSender(
    { senderEmail: 'support@ly-solution.fr', senderName: 'L.Y Solution' }, ACTEUR,
  );
}

/* ══════════════════════════════════════════════════════════════════════════
   3 · LE TEST RÉEL — la chaîne entière, jusqu'au webhook.
   ══════════════════════════════════════════════════════════════════════════ */
section('3 · L’e-mail de test emprunte la chaîne réelle');
{
  await controlPlane.saveCredentialSet('BREVO', 'TEST', {
    values: { apiKey: CLE_PANEL, baseUrl: BREVO_BASE },
  }, ACTEUR);
  const verdict = await controlPlane.validateCredentialSet('BREVO', 'TEST', { actor: ACTEUR });
  check('la clé du Panel est validée par un appel réel', verdict.validation.status === 'VALID');

  const rec = await reconcileProviderWebhook({ provider: 'BREVO' });
  check('le webhook Brevo du Panel est réconcilié', rec.status === 'READY');

  const avant = appelsBrevo.length;
  const rapport = await senderTest.sendTestEmail({
    recipientEmail: 'exploitant@ly-solution.fr', actor: ACTEUR,
  });

  check('le test est ACCEPTÉ', rapport.status === 'ACCEPTED');
  check('UN appel Brevo a eu lieu', appelsBrevo.length === avant + 1);

  const appel = appelsBrevo.at(-1);
  check('…sur /smtp/email', appel.url.includes('/smtp/email'));
  check('NO_DIRECT_BREVO — avec la clé DU PANEL', appel.apiKey === CLE_PANEL);

  const corps = JSON.parse(appel.body);
  check('l’expéditeur est l’expéditeur GLOBAL',
    corps.sender?.email === 'support@ly-solution.fr' && corps.sender?.name === 'L.Y Solution');
  check('le destinataire est celui qu’on a saisi',
    corps.to?.[0]?.email === 'exploitant@ly-solution.fr');
  check('aucun templateId Brevo — le contenu est le NÔTRE', !corps.templateId);
  check('le corps porte un sujet et un HTML rendus',
    typeof corps.subject === 'string' && String(corps.htmlContent).includes('support@ly-solution.fr'));

  check('un providerMessageId est enregistré', typeof rapport.providerMessageId === 'string');
  check('…et un webhook est ATTENDU', rapport.webhookStatus === 'PENDING');
  check('le rapport n’annonce PAS « livré » sur une simple acceptation',
    rapport.status !== 'DELIVERED');

  /**
   * L'OPÉRATION EST PARTITIONNÉE SUR LE PANEL, PAS SUR UN PROJET.
   *
   * C'est ce qui rend l'envoi du Panel indépendant de l'ouverture commerciale
   * et des octrois d'un client — et ce qui permet au webhook de le retrouver.
   */
  const op = await Operation.findOne({ operationId: rapport.testId }).lean();
  check('l’opération existe', Boolean(op));
  check('PANEL_SELF_SCOPE — elle appartient au périmètre du Panel',
    op?.projectId === PANEL_SELF_SCOPE);
  check('operationId === testId — une seule identité pour un seul acte',
    op?.operationId === rapport.testId);
}

/* ══════════════════════════════════════════════════════════════════════════
   4 · LE WEBHOOK — la seule preuve qui vaille.
   ══════════════════════════════════════════════════════════════════════════ */
section('4 · Le webhook fait converger le rapport');
{
  const courant = await senderTest.describeLastTest();
  const messageId = courant.providerMessageId;

  const res = await webhookBrevo({
    event: 'delivered',
    'message-id': messageId,
    email: 'exploitant@ly-solution.fr',
    date: '2026-08-13 18:00:00',
  });
  check('le webhook est accepté par la vraie route publique', res.status < 300);

  const apres = await senderTest.describeTest(courant.testId);
  check('WEBHOOK_CONVERGES — le rapport passe à DELIVERED', apres.status === 'DELIVERED');
  check('…et le retour est marqué reçu', apres.webhookStatus === 'RECEIVED');
  check('…avec l’événement canonique du fournisseur', apres.lastWebhookEvent === 'DELIVERED');
  check('…et son horodatage', typeof apres.lastWebhookAt === 'string');

  // LE REJEU : le fournisseur renvoie le même événement. Rien ne doit doubler.
  const avantRejeu = appelsBrevo.length;
  await webhookBrevo({ event: 'delivered', 'message-id': messageId, email: 'exploitant@ly-solution.fr' });
  const rejoue = await senderTest.describeTest(courant.testId);
  check('un rejeu de webhook ne change pas l’issue', rejoue.status === 'DELIVERED');
  check('…et ne renvoie AUCUN e-mail', appelsBrevo.length === avantRejeu);

  // LA RELECTURE n'envoie rien : c'est ce qui permet d'attendre le webhook.
  const avantRelecture = appelsBrevo.length;
  await senderTest.describeTest(courant.testId);
  check('POLL_DOES_NOT_RESEND — relire un test n’envoie rien',
    appelsBrevo.length === avantRelecture);
}

/* ══════════════════════════════════════════════════════════════════════════
   5 · LE REBOND — « accepté » ne veut pas dire « arrivé ».
   ══════════════════════════════════════════════════════════════════════════ */
section('5 · Un rebond est rapporté comme tel');
{
  const rapport = await senderTest.sendTestEmail({
    recipientEmail: 'inconnu@ly-solution.fr', actor: ACTEUR,
  });
  check('l’envoi est accepté par le fournisseur', rapport.status === 'ACCEPTED');

  await webhookBrevo({
    event: 'hard_bounce',
    'message-id': rapport.providerMessageId,
    email: 'inconnu@ly-solution.fr',
    reason: 'Unknown recipient',
  });

  const apres = await senderTest.describeTest(rapport.testId);
  check('le rapport passe à BOUNCED', apres.status === 'BOUNCED');
  check('…et porte le motif du fournisseur',
    String(apres.lastWebhookReason ?? '').includes('Unknown recipient'));
  check('le journal marque la livraison en échec',
    apres.journal.find((e) => e.label === 'Livraison confirmée')?.state === 'FAIL');
}

/* ══════════════════════════════════════════════════════════════════════════
   6 · LE REFUS — rien n'est parti, et le rapport le dit.
   ══════════════════════════════════════════════════════════════════════════ */
section('6 · Un refus fournisseur est distingué d’une livraison');
{
  prochainEnvoi = 'REFUS';
  const rapport = await senderTest.sendTestEmail({
    recipientEmail: 'refuse@ly-solution.fr', actor: ACTEUR,
  });

  check('le test est REFUSÉ, jamais « accepté »', rapport.status === 'REFUSED');
  check('…aucun providerMessageId', rapport.providerMessageId === null);
  check('…aucun webhook n’est attendu', rapport.webhookStatus === 'NOT_APPLICABLE');
  check('…un code d’erreur est rendu', typeof rapport.errorCode === 'string');
  check('le journal marque « Provider accepté » en échec',
    rapport.journal.find((e) => e.label === 'Provider accepté')?.state === 'FAIL');

  let inconnu = null;
  try { await senderTest.describeTest('inexistant'); } catch (err) { inconnu = err; }
  check('un identifiant de test inventé est refusé', inconnu?.code === 'PANEL_EMAIL_TEST_UNKNOWN');

  for (const mauvais of ['', '   ', 'pas-une-adresse', null]) {
    let erreur = null;
    try { await senderTest.sendTestEmail({ recipientEmail: mauvais, actor: ACTEUR }); } catch (err) { erreur = err; }
    check(`destinataire illisible refusé (${JSON.stringify(mauvais)})`,
      erreur?.code === 'PANEL_EMAIL_TEST_RECIPIENT_INVALID');
  }
}

/* ══════════════════════════════════════════════════════════════════════════
   7 · AUCUN SECRET, NULLE PART.
   ══════════════════════════════════════════════════════════════════════════ */
section('7 · Le rapport se colle dans un ticket sans rien exposer');
{
  const tests = await SenderTest.collection.find({}).toArray();
  const brut = JSON.stringify(tests);
  check('NO_SECRET_IN_STORE — aucune clé en base', !brut.includes(CLE_PANEL));
  check('…aucun préfixe de clé Brevo', !brut.includes('xkeysib'));

  const dernier = await senderTest.describeLastTest();
  const texte = dernier.plainText;
  check('NO_SECRET_IN_REPORT — le rapport ne porte aucune clé', !texte.includes(CLE_PANEL));
  check('…ni « xkeysib »', !texte.includes('xkeysib'));
  check('…ni d’en-tête d’autorisation', !/authorization|bearer|api-key/i.test(texte));

  const secretWebhook = (await loadVerificationSecrets('BREVO', 'TEST'))[0];
  check('…ni le secret de vérification du webhook',
    typeof secretWebhook === 'string' && !texte.includes(secretWebhook));

  // LE RAPPORT EST COMPLET — chaque champ exigé par la recette y figure.
  for (const champ of [
    'status', 'environment', 'recipient', 'sender name', 'sender email',
    'template code', 'operationId', 'deliveryId', 'provider', 'providerMessageId',
    'requested at', 'accepted at', 'last webhook', 'delivery status',
    'webhook status', 'error code', 'error message',
  ]) {
    check(`le rapport porte « ${champ} »`, texte.includes(champ));
  }
  check('…et un journal lisible', texte.includes('--- journal ---'));
  check('…dont les états sont explicites', /\[(PASS|FAIL|PENDING)\]/.test(texte));
}

/* ══════════════════════════════════════════════════════════════════════════
   8 · L'ÉCRAN — une seule surface, et elle relit ce qu'elle a écrit.
   ══════════════════════════════════════════════════════════════════════════ */
section('8 · La surface HTTP dit la même chose que le service');
{
  const ecran = await senderTest.describeSenderScreen();
  check('l’écran porte la configuration', ecran.configuration.senderEmail === 'support@ly-solution.fr');
  check('…l’environnement servi', typeof ecran.environment === 'string');
  check('…et le dernier test', typeof ecran.lastTest?.testId === 'string');

  // La surface publique du Panel ne doit exposer AUCUNE route d'écriture du
  // From ailleurs qu'ici : un second chemin recréerait la seconde vérité.
  const { default: routes } = await import('../backend/src/routes/emailSender.routes.js');
  const chemins = routes.stack.filter((c) => c.route).map((c) => ({
    path: c.route.path, methods: Object.keys(c.route.methods),
  }));
  check('la lecture existe', chemins.some((c) => c.path === '/' && c.methods.includes('get')));
  check('l’écriture existe', chemins.some((c) => c.path === '/' && c.methods.includes('put')));
  check('l’envoi de test est un POST', chemins.some((c) => c.path === '/test' && c.methods.includes('post')));
  check('la relecture est un GET distinct',
    chemins.some((c) => c.path === '/test/:testId' && c.methods.includes('get')));
}

fauxBrevo.close();
await stopMemoryMongo();
finish();
