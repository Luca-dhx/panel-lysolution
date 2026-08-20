// BREVO — plan de contrôle, fondations L8.
//
// Ce que cette suite prouve, dans l'ordre des invariants qui comptent :
//
//   1. aucune clé ne sort — ni par une vue, ni par un journal, ni par une erreur ;
//   2. le catalogue de capacités ne parle QUE métier, et s'accorde avec le registre L1 ;
//   3. l'environnement est INJECTÉ, jamais choisi par une charge utile ;
//   4. le projet A ne peut pas écrire sous l'identité du projet B ;
//   5. « je ne sais pas » est un résultat, et il n'autorise aucun rejeu automatique ;
//   6. la comparaison d'événements Brevo tolère ce que Brevo fait réellement.
//
// Aucun réseau, aucune base : `fetchImpl` est injecté partout.
import { check, finish, section, setTestEnv } from './helpers/harness.js';
import { forme } from './helpers/secretShapes.js';

setTestEnv();

const capabilities = await import('../backend/src/services/integratedApi/brevo/brevoCapabilities.js');
const transport = await import('../backend/src/services/integratedApi/brevo/brevoTransport.js');
const events = await import('../backend/src/services/integratedApi/brevo/brevoEventMapping.js');
const senders = await import('../backend/src/services/integratedApi/brevo/brevoSenderIdentity.js');
const registry = await import('../backend/src/services/integratedApi/providerRegistry.js');
const environment = await import('../backend/src/services/integratedApi/environment.js');

const {
  BREVO_CAPABILITIES, BREVO_CAPABILITY_CODES, CAPABILITY_ERROR_CODES, ATTACHMENT_POLICY,
  TEMPLATE_AUTHORITIES, ENVIRONMENT_SOURCES, IDEMPOTENCY_STRENGTHS,
  isBrevoCapability, getBrevoCapability, describeBrevoCapability,
  capabilityRegistryDrift, validateBrevoCapabilities,
} = capabilities;

const {
  OUTCOMES, TRANSPORT_CODES, BrevoTransportError,
  sendTransactionalEmail, describeAccount, describeRetryDecision,
  normalizeProviderMessageId, providerMessageIdVariants, maskEmail,
} = transport;

const SECRET_KEY = forme.brevoApiKey('0123456789ABCDEF0123456789AB');
const CREDENTIALS = Object.freeze({ apiKey: SECRET_KEY, baseUrl: 'https://api.brevo.com/v3' });

const SENDER = { email: 'contact@garage-a.fr', name: 'Garage A' };
const RECIPIENT = { email: 'jean.dupont@exemple.fr', name: 'Jean Dupont' };

/** Réponse HTTP simulée — la forme minimale que le transport consomme. */
function httpResponse(status, body, { ok = status >= 200 && status < 300 } = {}) {
  return {
    ok,
    status,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body ?? {})),
  };
}

/** Faux `fetch` qui enregistre ses appels. Aucun réseau, jamais. */
function recordingFetch(handler) {
  const calls = [];
  const impl = async (url, options) => {
    calls.push({ url, options });
    return handler(url, options);
  };
  impl.calls = calls;
  return impl;
}

function sendWith(fetchImpl, overrides = {}) {
  return sendTransactionalEmail({
    credentials: CREDENTIALS,
    sender: SENDER,
    recipient: RECIPIENT,
    subject: 'Votre demande a bien été reçue',
    htmlContent: '<p>Bonjour Jean</p>',
    fetchImpl,
    ...overrides,
  });
}

/** Capture l'erreur d'une promesse — `null` si elle a réussi. */
async function caught(promise) {
  try {
    await promise;
    return null;
  } catch (err) {
    return err;
  }
}

/* ========================================================================== */
section('1. CATALOGUE — des intentions métier, pas une API Brevo');
/* ========================================================================== */
{
  check('exactement deux capacités déclarées', BREVO_CAPABILITY_CODES.length === 2);
  check('ce sont email.send_template et email.sender.verify',
    isBrevoCapability('email.send_template') && isBrevoCapability('email.sender.verify'));

  // §4 de la mission : ne pas inventer les capacités non utilisées. L'inventaire
  // des deux dépôts ne trouve NI SMS, NI WhatsApp, NI contacts, NI campagnes.
  for (const absent of ['sms.send', 'whatsapp.send', 'contact.list.sync', 'campaign.send', 'email.send_document']) {
    check(`${absent} n’est PAS déclaré (aucun usage dans le parc)`, !isBrevoCapability(absent));
  }

  check('le catalogue est gelé', Object.isFrozen(BREVO_CAPABILITIES));
  check('chaque capacité est gelée', Object.values(BREVO_CAPABILITIES).every((c) => Object.isFrozen(c)));

  const before = BREVO_CAPABILITY_CODES.length;
  try { BREVO_CAPABILITIES['email.send_sms'] = { code: 'email.send_sms' }; } catch { /* strict mode */ }
  check('impossible d’ajouter une capacité à chaud',
    Object.keys(BREVO_CAPABILITIES).length === before && !isBrevoCapability('email.send_sms'));

  const problems = validateBrevoCapabilities();
  check(`catalogue cohérent (${problems.length} problème(s))`, problems.length === 0);
  if (problems.length) problems.forEach((p) => console.error(`      · ${p}`));

  // Deux registres qui divergent = une interface qui promet ce que la
  // passerelle ne sait pas faire.
  const drift = capabilityRegistryDrift();
  check(`aucune dérive avec providerRegistry (${drift.length} écart(s))`, drift.length === 0);
  if (drift.length) drift.forEach((p) => console.error(`      · ${p}`));

  check('providerRegistry déclare bien BREVO en catégorie EMAIL',
    registry.getProviderDefinition('BREVO').category === 'EMAIL');
}

/* ========================================================================== */
section('2. CAPACITÉ — aucune fuite de fournisseur dans le contrat');
/* ========================================================================== */
{
  for (const code of BREVO_CAPABILITY_CODES) {
    const capability = getBrevoCapability(code);
    const inputNames = capability.input.map((f) => f.name);

    // L'expéditeur n'est PAS un paramètre : sinon un projet écrit au nom d'un autre.
    check(`${code} : l’expéditeur n’est pas une entrée`,
      !inputNames.some((n) => /^(sender|from|fromEmail|senderEmail)$/.test(n)));
    // L'environnement n'est PAS un paramètre : la doctrine appartient au Panel.
    check(`${code} : l’environnement n’est pas une entrée`,
      !inputNames.some((n) => /^(mode|environment|providerMode|env)$/.test(n)));
    check(`${code} : environnement résolu par le plan de contrôle`,
      capability.environmentSource === ENVIRONMENT_SOURCES.CONTROL_PLANE);
    // Aucune clé, aucune URL, aucun client brut n'entre dans une intention.
    check(`${code} : aucune entrée ne porte une clé ou une URL d’API`,
      !inputNames.some((n) => /apiKey|baseUrl|endpoint|url|token|secret/i.test(n)));

    // §C : l'autorité du contenu reste au Panel.
    check(`${code} : autorité du contenu = PANEL`, capability.templateAuthority === TEMPLATE_AUTHORITIES.PANEL);
    check(`${code} : « templateId » interdit dans le corps Brevo`,
      capability.providerMapping.forbiddenBodyFields.includes('templateId'));

    // §H : Brevo n'offre aucune idempotence — c'est nous qui la tenons.
    check(`${code} : idempotence tenue par l’appelant`,
      capability.idempotency.strength === IDEMPOTENCY_STRENGTHS.CALLER_ENFORCED);
    check(`${code} : aucun en-tête d’idempotence fournisseur`, capability.idempotency.providerHeader === null);
    check(`${code} : aucun rejeu automatique sur issue inconnue`, capability.retryOnUnknownOutcome === false);
    check(`${code} : délai d’attente borné`, capability.timeoutMs > 0 && capability.timeoutMs <= 30_000);

    // §I : le Panel garde le diagnostic, le projet garde la communication.
    check(`${code} : le journal ne porte ni adresse ni contenu`,
      !capability.audit.some((f) => /recipient|email|content|html|subject|variables/i.test(f)));
    check(`${code} : le journal porte l’environnement et l’opération`,
      capability.audit.includes('environment') && capability.audit.includes('operationId'));
  }

  // §L : aucune pièce jointe aujourd'hui, et jamais par un chemin de fichier.
  check('pièces jointes non supportées aujourd’hui', ATTACHMENT_POLICY.supported === false);
  check('aucun chemin de fichier ne sera jamais accepté', ATTACHMENT_POLICY.acceptsFilesystemPath === false);
  check('la forme future est une référence de média', ATTACHMENT_POLICY.futureReferenceKind === 'MEDIA_REF');
  check('l’appartenance du média sera vérifiée', ATTACHMENT_POLICY.requiresOwnershipCheck === true);
  check('taille bornée', ATTACHMENT_POLICY.maxBytes > 0 && ATTACHMENT_POLICY.maxBytes <= 10 * 1024 * 1024);
  check('types bornés', ATTACHMENT_POLICY.allowedMimeTypes.length > 0);

  // Une capacité inconnue ne se devine pas.
  check('capacité inconnue → null', getBrevoCapability('email.send_sms') === null);
  check('description d’une capacité inconnue → null', describeBrevoCapability('email.send_sms') === null);

  const view = describeBrevoCapability('email.send_template');
  check('la vue publique n’expose PAS le chemin d’API', !('providerMapping' in view) && !JSON.stringify(view).includes('/smtp/email'));
  check('la vue publique dit que rien n’est invocable en L8', view.invocable === false);
  check('CAPABILITY_UNSUPPORTED existe pour une capacité inconnue',
    Boolean(CAPABILITY_ERROR_CODES.CAPABILITY_UNSUPPORTED));
}

/* ========================================================================== */
section('3. TRANSPORT — chemin nominal, et ce qu’il conserve');
/* ========================================================================== */
{
  const fetchImpl = recordingFetch(async () => httpResponse(201, { messageId: '<202608100930.42@smtp-relay.brevo.com>' }));
  const result = await sendWith(fetchImpl);

  check('issue SENT', result.outcome === OUTCOMES.SENT);
  // La poignée de corrélation du suivi : sans elle, aucun événement ne se rattache.
  check('identifiant de message conservé, sous forme canonique',
    result.providerMessageId === '202608100930.42@smtp-relay.brevo.com');
  check('statut HTTP remonté', result.httpStatus === 201);
  check('durée mesurée', Number.isFinite(result.durationMs));

  const [call] = fetchImpl.calls;
  check('un seul appel', fetchImpl.calls.length === 1);
  check('vers POST {base}/smtp/email',
    call.url === 'https://api.brevo.com/v3/smtp/email' && call.options.method === 'POST');
  check('authentification par en-tête api-key (jamais Bearer)',
    call.options.headers['api-key'] === SECRET_KEY && !('Authorization' in call.options.headers));
  check('charset annoncé explicitement',
    /charset=utf-8/i.test(call.options.headers['Content-Type']));

  const body = JSON.parse(call.options.body);
  // §C : le contenu part rendu. Un templateId ferait sortir le contenu de nos versions.
  check('aucun templateId envoyé à Brevo', !('templateId' in body));
  check('sujet et HTML rendus par le Panel', body.subject && body.htmlContent);
  check('destinataire unique', Array.isArray(body.to) && body.to.length === 1);
  check('expéditeur = celui résolu par le Panel', body.sender.email === SENDER.email);
  check('aucun replyTo quand aucun n’est demandé', !('replyTo' in body));

  // Le signal d'annulation doit exister : sans lui, aucun délai n'est réellement borné.
  check('un signal d’abandon accompagne la requête', Boolean(call.options.signal));
}

/* ========================================================================== */
section('4. TRANSPORT — aucun secret ne sort, jamais');
/* ========================================================================== */
{
  const logs = [];
  const original = console.log;
  console.log = (...args) => { logs.push(args.join(' ')); };
  let result;
  try {
    result = await sendWith(recordingFetch(async () => httpResponse(201, { messageId: 'abc@brevo' })));
  } finally {
    console.log = original;
  }

  const journal = logs.join('\n');
  check('aucune clé API dans le journal', !journal.includes(SECRET_KEY));
  check('aucun fragment de clé dans le journal', !/xkeysib-/.test(journal));
  check('aucune adresse en clair dans le journal',
    !journal.includes(RECIPIENT.email) && !journal.includes(SENDER.email));
  check('adresses masquées présentes', journal.includes(maskEmail(RECIPIENT.email)));
  check('ni sujet ni HTML dans le journal',
    !journal.includes('Votre demande a bien été reçue') && !journal.includes('<p>Bonjour Jean</p>'));

  // Le résultat rendu à l'appelant ne doit rien porter de confidentiel non plus.
  const serialized = JSON.stringify(result);
  check('aucun secret dans le résultat', !serialized.includes(SECRET_KEY) && !/xkeysib-/.test(serialized));

  // Une erreur ne doit pas non plus recopier la clé pour « expliquer ».
  const error = await caught(sendTransactionalEmail({
    credentials: CREDENTIALS,
    sender: SENDER,
    recipient: RECIPIENT,
    subject: 'x',
    htmlContent: '<p>x</p>',
    fetchImpl: async () => httpResponse(401, { code: 'unauthorized', message: `Key ${SECRET_KEY} rejected` }),
  }));
  check('401 : erreur typée UNAUTHORIZED', error?.code === TRANSPORT_CODES.UNAUTHORIZED);
  check('401 : le message nomme les DEUX causes possibles (clé, IP)',
    /clé invalide/i.test(error.message) && /IP/i.test(error.message));
  // Brevo n'écho pas la clé en pratique ; si un jour il le faisait, on le verrait ici.
  check('le message d’erreur reste borné', error.message.length < 400);
}

/* ========================================================================== */
section('5. TRANSPORT — refus fournisseur : que faire, et surtout que NE PAS faire');
/* ========================================================================== */
{
  const cases = [
    { status: 400, body: { message: 'sender not valid' }, code: TRANSPORT_CODES.REJECTED, retryable: false },
    { status: 401, body: { message: 'unauthorized' }, code: TRANSPORT_CODES.UNAUTHORIZED, retryable: false },
    { status: 402, body: { message: 'not enough credits' }, code: TRANSPORT_CODES.QUOTA_EXHAUSTED, retryable: false },
    { status: 403, body: { message: 'forbidden' }, code: TRANSPORT_CODES.UNAUTHORIZED, retryable: false },
    { status: 429, body: { message: 'too many requests' }, code: TRANSPORT_CODES.RATE_LIMITED, retryable: true },
    { status: 500, body: { message: 'oops' }, code: TRANSPORT_CODES.PROVIDER_ERROR, retryable: true },
    { status: 503, body: { message: 'maintenance' }, code: TRANSPORT_CODES.PROVIDER_ERROR, retryable: true },
  ];

  for (const testCase of cases) {
    const error = await caught(sendWith(async () => httpResponse(testCase.status, testCase.body)));
    check(`${testCase.status} → ${testCase.code}`, error?.code === testCase.code);
    check(`${testCase.status} → retryable=${testCase.retryable}`, error.retryable === testCase.retryable);
    // Brevo a RÉPONDU : il a tranché, donc rien n'est parti, donc rejouer est sûr.
    check(`${testCase.status} → issue FAILED (rejeu sans risque de doublon)`, error.outcome === OUTCOMES.FAILED);
    check(`${testCase.status} → replaySafe`, error.replaySafe === true);
    check(`${testCase.status} → statut HTTP conservé`, error.httpStatus === testCase.status);
  }

  const decision = describeRetryDecision(
    await caught(sendWith(async () => httpResponse(429, { message: 'slow down' }))),
  );
  check('429 : reprise AUTOMATIQUE autorisée', decision.automatic === true);

  const permanent = describeRetryDecision(
    await caught(sendWith(async () => httpResponse(400, { message: 'sender not valid' }))),
  );
  check('400 : aucune reprise (échec définitif)',
    permanent.automatic === false && permanent.reason === 'ECHEC_DEFINITIF');
}

/* ========================================================================== */
section('6. TRANSPORT — « je ne sais pas » est un résultat (§H)');
/* ========================================================================== */
{
  // Délai dépassé : la requête est peut-être arrivée, l'e-mail peut-être parti.
  const timedOut = await caught(sendWith(async (_url, options) => {
    const abortError = new Error('aborted');
    abortError.name = 'AbortError';
    void options;
    throw abortError;
  }));
  check('délai dépassé → TIMEOUT', timedOut?.code === TRANSPORT_CODES.TIMEOUT);
  check('délai dépassé → issue UNKNOWN, JAMAIS « non envoyé »', timedOut.outcome === OUTCOMES.UNKNOWN);
  check('délai dépassé → retryable (ça pourrait marcher)', timedOut.retryable === true);
  check('délai dépassé → PAS rejouable sans arbitrage', timedOut.replaySafe === false);
  const ambiguous = describeRetryDecision(timedOut);
  check('délai dépassé → aucune reprise automatique', ambiguous.automatic === false);
  check('délai dépassé → arbitrage humain explicite',
    ambiguous.reason === 'ISSUE_INCONNUE_ARBITRAGE_HUMAIN');

  // Panne réseau : même raisonnement, même refus de deviner.
  const unreachable = await caught(sendWith(async () => { throw new TypeError('fetch failed'); }));
  check('réseau coupé → UNREACHABLE', unreachable?.code === TRANSPORT_CODES.UNREACHABLE);
  check('réseau coupé → issue UNKNOWN', unreachable.outcome === OUTCOMES.UNKNOWN);
  check('réseau coupé → aucune reprise automatique', describeRetryDecision(unreachable).automatic === false);

  // 2xx sans messageId : hors contrat. L'e-mail est probablement parti, mais
  // on n'a plus la poignée pour le suivre — surtout ne pas rejouer.
  const malformed = await caught(sendWith(async () => httpResponse(201, { ok: true })));
  check('2xx sans messageId → MALFORMED_RESPONSE', malformed?.code === TRANSPORT_CODES.MALFORMED_RESPONSE);
  check('2xx sans messageId → issue UNKNOWN (pas FAILED)', malformed.outcome === OUTCOMES.UNKNOWN);
  check('2xx sans messageId → non retryable', malformed.retryable === false);

  // Corps illisible : on ne propage RIEN du texte reçu.
  const garbage = await caught(sendWith(async () => httpResponse(500, '<html>Bad Gateway — proxy interne 10.0.0.4</html>')));
  check('corps illisible → erreur typée, pas de propagation', garbage?.code === TRANSPORT_CODES.PROVIDER_ERROR);
  check('corps illisible → aucun fragment du corps dans le message',
    !garbage.message.includes('10.0.0.4') && !garbage.message.includes('<html>'));

  // Un 2xx illisible n'a pas non plus de messageId : même traitement.
  const garbageOk = await caught(sendWith(async () => httpResponse(201, 'accepté')));
  check('2xx illisible → issue UNKNOWN', garbageOk?.outcome === OUTCOMES.UNKNOWN);
}

/* ========================================================================== */
section('7. TRANSPORT — entrées refusées AVANT tout appel');
/* ========================================================================== */
{
  const never = recordingFetch(async () => httpResponse(201, { messageId: 'ne-devrait-pas-arriver' }));

  const cases = [
    ['expéditeur absent', { sender: { email: '' } }],
    ['expéditeur illisible', { sender: { email: 'pas-une-adresse' } }],
    ['destinataire absent', { recipient: { email: '' } }],
    ['destinataire illisible', { recipient: { email: 'jean@' } }],
    ['sujet manquant', { subject: '' }],
    ['contenu manquant', { htmlContent: '' }],
  ];
  for (const [label, overrides] of cases) {
    const error = await caught(sendWith(never, overrides));
    check(`${label} → INPUT_INVALID`, error?.code === TRANSPORT_CODES.INPUT_INVALID);
    check(`${label} → issue FAILED (rien n’a été tenté)`, error.outcome === OUTCOMES.FAILED);
  }
  check('aucun appel au fournisseur pour une entrée invalide', never.calls.length === 0);

  // Un jeu d'identifiants incomplet n'est pas une panne de fournisseur.
  const noKey = await caught(sendTransactionalEmail({
    credentials: { baseUrl: 'https://api.brevo.com/v3' },
    sender: SENDER, recipient: RECIPIENT, subject: 's', htmlContent: '<p>c</p>',
    fetchImpl: never,
  }));
  check('clé absente → MISSING_CREDENTIALS', noKey?.code === TRANSPORT_CODES.MISSING_CREDENTIALS);
  const noBase = await caught(sendTransactionalEmail({
    credentials: { apiKey: SECRET_KEY },
    sender: SENDER, recipient: RECIPIENT, subject: 's', htmlContent: '<p>c</p>',
    fetchImpl: never,
  }));
  check('URL de base absente → MISSING_CREDENTIALS', noBase?.code === TRANSPORT_CODES.MISSING_CREDENTIALS);
  check('toujours aucun appel réseau', never.calls.length === 0);
}

/* ========================================================================== */
section('8. TRANSPORT — surface minimale, et diagnostic de compte');
/* ========================================================================== */
{
  // Un « client Brevo » générique exposerait une surface que personne n'a demandée.
  const exported = Object.keys(transport.default);
  const operations = exported.filter((name) => /^(send|describe|list|create|update|delete)/.test(name));
  check('deux opérations réseau seulement, nommées',
    operations.includes('sendTransactionalEmail') && operations.includes('describeAccount'));
  check('aucune opération contacts / listes / campagnes / SMS',
    !exported.some((name) => /contact|list|campaign|sms|whatsapp/i.test(name)));

  const fetchImpl = recordingFetch(async () => httpResponse(200, { companyName: 'L.Y Solution', email: 'ops@ly.fr' }));
  const account = await describeAccount({ credentials: CREDENTIALS, fetchImpl });
  check('GET {base}/account', fetchImpl.calls[0].url === 'https://api.brevo.com/v3/account');
  check('lecture seule : aucun corps envoyé', fetchImpl.calls[0].options.body === undefined);
  check('compte remonté', account.ok === true && account.account === 'L.Y Solution');

  const refused = await caught(describeAccount({
    credentials: CREDENTIALS,
    fetchImpl: async () => httpResponse(401, { message: 'unauthorized' }),
  }));
  check('compte : 401 → UNAUTHORIZED', refused?.code === TRANSPORT_CODES.UNAUTHORIZED);

  // Corrélation : les deux graphies d'un identifiant Brevo doivent être connues.
  check('identifiant normalisé sans chevrons', normalizeProviderMessageId('<a@b>') === 'a@b');
  check('les deux variantes sont proposées',
    providerMessageIdVariants('<a@b>').join(',') === 'a@b,<a@b>');
  check('identifiant absent → aucune variante', providerMessageIdVariants('').length === 0);
}

/* ========================================================================== */
section('9. MULTI-PROJET — le projet A n’écrit pas sous l’identité du projet B');
/* ========================================================================== */
{
  const STORE = {
    'projet-a|PROD': { fromEmail: 'contact@garage-a.fr', fromName: 'Garage A', replyToEmail: 'sav@garage-a.fr' },
    'projet-b|PROD': { fromEmail: 'contact@garage-b.fr', fromName: 'Garage B' },
    'projet-a|TEST': { fromEmail: 'recette@garage-a.fr', fromName: 'Garage A (recette)' },
  };
  const lookup = async ({ projectId, environment: env }) => STORE[`${projectId}|${env}`] ?? null;

  const identityA = await senders.resolveSenderIdentity({
    authenticatedProjectId: 'projet-a', environment: 'PROD', lookup,
  });
  check('projet A : sa propre identité', identityA.fromEmail === 'contact@garage-a.fr');
  check('projet A : son adresse de réponse', identityA.replyTo.email === 'sav@garage-a.fr');

  const identityB = await senders.resolveSenderIdentity({
    authenticatedProjectId: 'projet-b', environment: 'PROD', lookup,
  });
  check('projet B : sa propre identité', identityB.fromEmail === 'contact@garage-b.fr');
  check('A et B ne partagent PAS d’identité', identityA.fromEmail !== identityB.fromEmail);
  check('projet B sans reply-to → null, pas d’emprunt', identityB.replyTo === null);

  // LE test qui compte : la charge utile ne prend jamais le pas sur le contexte.
  const usurpation = await caught(senders.resolveSenderIdentity({
    authenticatedProjectId: 'projet-a', requestedProjectId: 'projet-b', environment: 'PROD', lookup,
  }));
  check('A demandant l’identité de B → refusé', usurpation !== null);
  check('refus en 403', usurpation.statusCode === 403 || usurpation.status === 403);
  check('code SCOPE_VIOLATION', String(usurpation.code) === senders.SENDER_IDENTITY_CODES.SCOPE_VIOLATION);

  // Le même identifiant répété est une redondance, pas une usurpation.
  const redundant = await senders.resolveSenderIdentity({
    authenticatedProjectId: 'projet-a', requestedProjectId: 'projet-a', environment: 'PROD', lookup,
  });
  check('projectId redondant mais identique → accepté', redundant.fromEmail === 'contact@garage-a.fr');

  // Sans contexte authentifié, il n'y a rien à résoudre.
  const anonymous = await caught(senders.resolveSenderIdentity({
    authenticatedProjectId: '', environment: 'PROD', lookup,
  }));
  check('aucun projet authentifié → refusé', anonymous !== null);

  const unknown = await caught(senders.resolveSenderIdentity({
    authenticatedProjectId: 'projet-c', environment: 'PROD', lookup,
  }));
  check('projet sans identité → SENDER_IDENTITY_MISSING',
    String(unknown?.code) === senders.SENDER_IDENTITY_CODES.NOT_CONFIGURED);
}

/* ========================================================================== */
section('10. ENVIRONNEMENT — injecté, jamais choisi par une charge utile');
/* ========================================================================== */
{
  const STORE = {
    'projet-a|PROD': { fromEmail: 'contact@garage-a.fr', fromName: 'Garage A' },
    'projet-a|TEST': { fromEmail: 'recette@garage-a.fr', fromName: 'Garage A (recette)' },
  };
  const lookup = async ({ projectId, environment: env }) => STORE[`${projectId}|${env}`] ?? null;

  const prod = await senders.resolveSenderIdentity({ authenticatedProjectId: 'projet-a', environment: 'PROD', lookup });
  const test = await senders.resolveSenderIdentity({ authenticatedProjectId: 'projet-a', environment: 'TEST', lookup });
  check('TEST et PROD portent des identités distinctes', prod.fromEmail !== test.fromEmail);

  // Aucun repli : un environnement absent doit faire échouer, pas retomber sur TEST.
  const missing = await caught(senders.resolveSenderIdentity({ authenticatedProjectId: 'projet-a', lookup }));
  check('environnement absent → refusé, aucun repli sur TEST', missing !== null);
  check('code ENVIRONMENT_REQUIRED', String(missing.code).includes('ENVIRONMENT_REQUIRED'));

  // La primitive L1 reste la seule autorité, et L8 ne la redéfinit pas.
  check('le Panel de test sert TEST', environment.runtimeEnvironment() === 'TEST');
  check('BREVO est à portée ENVIRONMENT',
    environment.resolveEnvironmentForProvider('BREVO') === 'TEST');
  let mismatch = null;
  try { environment.assertEnvironmentServed('PROD'); } catch (err) { mismatch = err; }
  check('demander PROD depuis un Panel TEST → refus',
    String(mismatch?.code) === environment.INTEGRATED_API_ENVIRONMENT_MISMATCH);
  check('L8 n’introduit aucun second sélecteur d’environnement',
    !Object.keys(capabilities.default).some((k) => /mode|activeMode|selectEnvironment/i.test(k)));
}

/* ========================================================================== */
section('11. IDENTITÉ EXPÉDITRICE — aucun secret, jamais');
/* ========================================================================== */
{
  const verdict = senders.validateSenderIdentity({
    fromEmail: 'contact@garage-a.fr', fromName: 'Garage A', apiKey: SECRET_KEY,
  });
  check('une clé API dans une identité → refusée', verdict.valid === false);
  check('le problème NOMME le champ, pas sa valeur',
    verdict.problems.some((p) => p.includes('apiKey')) && !verdict.problems.join(' ').includes(SECRET_KEY));

  for (const forbidden of senders.SENDER_IDENTITY_SHAPE.forbidden) {
    const rejected = senders.validateSenderIdentity({
      fromEmail: 'a@b.fr', fromName: 'A', [forbidden]: 'valeur',
    });
    check(`« ${forbidden} » refusé dans une identité`, rejected.valid === false);
  }

  check('adresse illisible refusée',
    senders.validateSenderIdentity({ fromEmail: 'pas-une-adresse', fromName: 'A' }).valid === false);
  check('nom absent refusé',
    senders.validateSenderIdentity({ fromEmail: 'a@b.fr', fromName: '' }).valid === false);
  check('identité absente → NOT_CONFIGURED',
    senders.validateSenderIdentity(null).code === senders.SENDER_IDENTITY_CODES.NOT_CONFIGURED);

  const described = senders.describeSenderIdentity({
    projectId: 'projet-a', environment: 'PROD', fromEmail: 'contact@garage-a.fr',
    fromName: 'Garage A', replyTo: { email: 'sav@garage-a.fr' },
  });
  // L'adresse expéditrice est publique par nature : la masquer gênerait sans protéger.
  check('la vue de diagnostic montre l’adresse expéditrice', described.fromEmail === 'contact@garage-a.fr');
  check('la vue de diagnostic ne porte aucun champ inattendu',
    Object.keys(described).length === 5);
}

/* ========================================================================== */
section('12. ÉVÉNEMENTS BREVO — deux vocabulaires, une seule vérité');
/* ========================================================================== */
{
  const pairs = [
    ['hardBounce', 'hard_bounce', events.BREVO_EVENT_TYPES.HARD_BOUNCE],
    ['softBounce', 'soft_bounce', events.BREVO_EVENT_TYPES.SOFT_BOUNCE],
    ['uniqueOpened', 'unique_opened', events.BREVO_EVENT_TYPES.UNIQUE_OPENED],
    ['invalid', 'invalid_email', events.BREVO_EVENT_TYPES.INVALID],
  ];
  for (const [configTime, payloadTime, canonical] of pairs) {
    check(`« ${configTime} » et « ${payloadTime} » → ${canonical}`,
      events.normalizeBrevoEvent(configTime).canonical === canonical
      && events.normalizeBrevoEvent(payloadTime).canonical === canonical);
  }
  check('« request » → ACCEPTED (accepté, pas livré)',
    events.normalizeBrevoEvent('request').canonical === events.BREVO_EVENT_TYPES.ACCEPTED);
  check('la casse et les séparateurs sont absorbés',
    events.normalizeBrevoEvent('HARD-BOUNCE').canonical === events.BREVO_EVENT_TYPES.HARD_BOUNCE);
  check('un événement inconnu n’est PAS deviné',
    events.normalizeBrevoEvent('loadedByProxy').canonical === null);
  check('un événement inconnu se dit inconnu',
    events.normalizeBrevoEvent('loadedByProxy').known === false);

  // §8.6 : au-delà de la passerelle, plus personne ne connaît « hardBounce ».
  check('DELIVERED → EMAIL_DELIVERED',
    events.toControlPlaneEvent(events.BREVO_EVENT_TYPES.DELIVERED) === 'EMAIL_DELIVERED');
  check('HARD_BOUNCE → EMAIL_BOUNCED',
    events.toControlPlaneEvent(events.BREVO_EVENT_TYPES.HARD_BOUNCE) === 'EMAIL_BOUNCED');
  check('une ouverture ne produit AUCUN événement métier',
    events.toControlPlaneEvent(events.BREVO_EVENT_TYPES.OPENED) === null);
  check('ouverture et clic sont de l’engagement',
    events.isEngagementEvent(events.BREVO_EVENT_TYPES.OPENED)
    && events.isEngagementEvent(events.BREVO_EVENT_TYPES.CLICKED));
  check('une livraison n’est PAS de l’engagement',
    !events.isEngagementEvent(events.BREVO_EVENT_TYPES.DELIVERED));

  // Dates : quatre champs, deux unités. Confondre les deux projette en l'an 56000.
  check('ts_epoch lu en millisecondes',
    events.parseEventDate({ ts_epoch: 1786000000000 }).getTime() === 1786000000000);
  check('ts lu en secondes',
    events.parseEventDate({ ts: 1786000000 }).getTime() === 1786000000000);
  check('date ISO acceptée',
    events.parseEventDate({ date: '2026-08-10T09:30:00.000Z' }).toISOString() === '2026-08-10T09:30:00.000Z');
  check('aucune date exploitable → null', events.parseEventDate({}) === null);
}

/* ========================================================================== */
section('13. ÉVÉNEMENTS BREVO — la comparaison qui ne boucle pas');
/* ========================================================================== */
{
  // Le piège historique : `sent` souscrit revient en `request`.
  check('« sent » n’est jamais souscrit', !events.SUBSCRIBED_EVENTS.includes('sent'));
  check('et la raison est écrite noir sur blanc', Boolean(events.FORBIDDEN_SUBSCRIPTIONS.sent));
  check('« request » est souscrit à sa place', events.SUBSCRIBED_EVENTS.includes('request'));
  check('« error » est souscrit (accepté par Brevo malgré la doc)',
    events.SUBSCRIBED_EVENTS.includes('error'));
  check('tous les événements souscrits font l’aller-retour proprement',
    events.SUBSCRIBED_EVENTS.every((e) => events.ROUND_TRIP_SAFE_EVENTS.includes(e)));
  check('tous les événements souscrits sont reconnus par la table',
    events.SUBSCRIBED_EVENTS.every((e) => events.normalizeBrevoEvent(e).known));

  // L'ordre ne compte pas.
  const shuffled = [...events.SUBSCRIBED_EVENTS].reverse();
  check('ordre différent → aligné', events.compareSubscribedEvents(shuffled).aligned === true);

  // Brevo renvoie sa propre graphie : ce n'est pas une divergence.
  const otherSpelling = events.SUBSCRIBED_EVENTS.map((e) => e.replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase());
  check('graphie snake_case → aligné', events.compareSubscribedEvents(otherSpelling).aligned === true);

  // Brevo ajoute un événement de lui-même : sur-ensemble, pas divergence.
  const superset = events.compareSubscribedEvents([...events.SUBSCRIBED_EVENTS, 'proxy_open']);
  check('événement EN PLUS chez Brevo → toujours aligné', superset.aligned === true);
  check('l’extra est signalé sans être bloquant', superset.extra.length === 1);

  // Un événement réellement absent, lui, DOIT ressortir.
  const truncated = events.compareSubscribedEvents(events.SUBSCRIBED_EVENTS.filter((e) => e !== 'delivered'));
  check('« delivered » manquant → divergence', truncated.aligned === false);
  check('la liste des manquants est actionnable et canonique',
    truncated.missing.length === 1 && truncated.missing[0] === events.BREVO_EVENT_TYPES.DELIVERED);

  // Le collapse réel de Brevo : on souscrit `sent`, il renvoie `request`.
  const collapsed = events.compareSubscribedEvents(['request'], ['sent', 'request']);
  check('« sent » collapsé en « request » ne crée AUCUNE divergence', collapsed.aligned === true);

  // Aucune liste vide n'est « alignée » par accident.
  check('liste distante vide → divergence', events.compareSubscribedEvents([]).aligned === false);
}

/* ========================================================================== */
section('14. WEBHOOK BREVO — ce que L5 doit savoir, et que L8 ne fait pas');
/* ========================================================================== */
{
  const facts = events.BREVO_WEBHOOK_FACTS;

  // La nuance qui ne doit jamais se perdre : authentifié ≠ prouvé.
  check('aucune preuve cryptographique', facts.cryptographicProof === false);
  check('mécanisme = secret partagé Bearer', facts.signatureScheme === 'SHARED_SECRET_BEARER');
  check('les identifiants dans l’URL sont explicitement écartés',
    facts.rejectedAlternatives.some((a) => /URL/i.test(a)));
  check('l’allowlist d’IP est un complément disponible', facts.ipAllowlistAvailable === true);

  // C'est nous qui posons le secret : la rotation n'exige pas de recréer.
  check('secret fourni par l’appelant', facts.secretDelivery === 'CALLER_SUPPLIED');
  check('la rotation exige une fenêtre de tolérance', facts.rotationRequiresPreviousSecretWindow === true);
  check('la fenêtre est bornée et non nulle',
    facts.rotationWindowMs > 0 && facts.rotationWindowMs <= 60 * 60 * 1000);

  // Le piège de la PREMIÈRE configuration : liste vide qui ressemble à une panne.
  check('une liste vide ressemble à une erreur — c’est dit', facts.emptyListLooksLikeError === true);
  check('les signaux de liste vide sont énumérés', facts.emptyListSignals.length >= 3);
  check('la liste distante est filtrée par type', facts.listQuery.includes('type=transactional'));
  check('les trois types Brevo sont connus', facts.webhookTypes.length === 3);

  // Aucun identifiant d'événement : l'idempotence ne peut pas venir du fournisseur.
  check('Brevo ne fournit aucun identifiant d’événement',
    events.EVENT_IDENTITY.providerSuppliesEventId === false);
  check('le repli est une empreinte du corps BRUT',
    events.EVENT_IDENTITY.fallback === 'RAW_BODY_DIGEST');

  const first = events.buildEventIdentity({
    environment: 'PROD', providerMessageId: 'a@b',
    canonicalEvent: events.BREVO_EVENT_TYPES.DELIVERED,
    occurredAt: new Date('2026-08-10T09:30:00.000Z'), recipientHash: 'h1',
  });
  const same = events.buildEventIdentity({
    environment: 'PROD', providerMessageId: 'a@b',
    canonicalEvent: events.BREVO_EVENT_TYPES.DELIVERED,
    occurredAt: new Date('2026-08-10T09:30:00.000Z'), recipientHash: 'h1',
  });
  check('le même fait produit la même clé (rejeu absorbé)', first === same);

  const otherEnvironment = events.buildEventIdentity({
    environment: 'TEST', providerMessageId: 'a@b',
    canonicalEvent: events.BREVO_EVENT_TYPES.DELIVERED,
    occurredAt: new Date('2026-08-10T09:30:00.000Z'), recipientHash: 'h1',
  });
  check('un autre environnement produit une autre clé', first !== otherEnvironment);

  const otherEvent = events.buildEventIdentity({
    environment: 'PROD', providerMessageId: 'a@b',
    canonicalEvent: events.BREVO_EVENT_TYPES.OPENED,
    occurredAt: new Date('2026-08-10T09:30:00.000Z'), recipientHash: 'h1',
  });
  check('un autre événement produit une autre clé', first !== otherEvent);
  check('aucune adresse en clair dans la clé', !first.includes('@exemple.fr'));

  // L8 ne crée PAS de webhook : c'est le périmètre de L5, et il faut le prouver.
  const surface = Object.keys(events.default);
  check('aucune fonction de création/suppression de webhook ici',
    !surface.some((name) => /^(create|delete|ensure|reconcile|sync|repair)/i.test(name)));
  check('aucune fonction de vérification de signature ici',
    !surface.some((name) => /verify|signature/i.test(name)));
}

/* ========================================================================== */
section('15. NON-RÉGRESSION — L8 n’a rien pris à personne');
/* ========================================================================== */
{
  /**
   * Le registre L1 reste intact : les fournisseurs de L1 sont TOUS encore là,
   * avec leurs rôles.
   *
   * On ne compte plus. Compter revenait à interdire l'ajout d'un fournisseur —
   * exactement la faute que le commentaire ci-dessous dénonce pour les rôles :
   * un test qui refuse un ajout légitime transforme une exigence en obstacle.
   * Ce que cette suite doit prouver, c'est que L8 n'a RIEN PRIS à personne, pas
   * que le parc a cessé de grandir. (OpenSign est arrivé depuis, sans rien
   * retirer.)
   */
  check('les fournisseurs de L1 sont tous encore déclarés',
    ['STRIPE', 'BREVO', 'YOUSIGN', 'HOSTINGER'].every((c) => registry.isKnownProvider(c)));
  // On vérifie que les rôles CONNUS sont intacts, PAS qu'il n'y en a que trois :
  // L8 demande justement à L5 d'ajouter `webhookSecretPrevious` (§9.1, exigence 6),
  // et un test qui refuserait cet ajout transformerait une exigence en obstacle.
  const brevo = registry.getProviderDefinition('BREVO');
  check('BREVO conserve apiKey, webhookSecret et baseUrl',
    ['apiKey', 'webhookSecret', 'baseUrl'].every((role) => registry.credentialRole('BREVO', role) !== null));
  check('aucun rôle Brevo publiable par erreur', brevo.credentialRoles
    .filter((r) => r.code !== 'baseUrl').every((r) => r.secret));
  check('apiKey reste requise et confidentielle',
    registry.credentialRole('BREVO', 'apiKey').required && registry.credentialRole('BREVO', 'apiKey').secret);
  check('webhookSecret reste confidentiel',
    registry.credentialRole('BREVO', 'webhookSecret').secret);
  check('baseUrl reste publique et pré-remplie',
    !registry.credentialRole('BREVO', 'baseUrl').secret
    && registry.defaultRoleValue('BREVO', 'baseUrl') === 'https://api.brevo.com/v3');

  // La frontière L4 doit continuer de reconnaître les secrets Brevo.
  const guard = await import('../backend/src/bridge/providerSecretGuard.js');
  const leak = guard.inspectForProviderSecrets({ config: { apiKey: SECRET_KEY } });
  check('une clé Brevo ne franchit toujours pas le pont', leak.clean === false);
  const shape = guard.inspectForProviderSecrets({ note: `voici ${SECRET_KEY}` });
  check('une clé Brevo est reconnue à sa forme', shape.clean === false);
  // L'identité expéditrice, elle, doit pouvoir circuler : elle ne contient rien.
  const identity = guard.inspectForProviderSecrets({
    sender: { fromEmail: 'contact@garage-a.fr', fromName: 'Garage A' },
  });
  check('une identité expéditrice franchit le pont sans problème', identity.clean === true);
}

finish();
