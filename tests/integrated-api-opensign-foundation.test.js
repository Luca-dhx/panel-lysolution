// OPENSIGN — FONDATION DU FOURNISSEUR (LOT 0).
//
// docs/integrated-api/OPENSIGN_API_AUDIT_AND_FOUNDATION.md.
//
// ══ CE QUE CETTE SUITE PROUVE, ET CE QU'ELLE NE PEUT PAS PROUVER ════════════
//
// Elle prouve que le Panel SAIT parler à OpenSign : le bon en-tête, le bon
// hôte, la bonne lecture de ses refus, la bonne place dans le plan de contrôle,
// et l'étanchéité des secrets. Aucun appel ne sort sur le réseau — `fetchImpl`
// est injecté partout.
//
// Elle ne prouve PAS qu'OpenSign se comporte comme sa documentation le dit.
// C'est l'objet du lot suivant, avec de vrais identifiants de bac à sable. Les
// hypothèses que la recette réelle devra confirmer sont marquées « HYPOTHÈSE »
// dans le rapport, et chacune a ici un test qui tombera si on la change sans
// s'en apercevoir.
//
// ══ L'INVARIANT QUI DOMINE TOUT LE LOT ══════════════════════════════════════
//
//   YOUSIGN RESTE L'AUTORITÉ.
//
// Un fournisseur ajouté ne prend rien à celui qui sert. Plusieurs contrôles
// ci-dessous ne parlent que de cela — parce qu'une migration qui casse le
// chemin qu'elle remplace n'est pas une migration, c'est une panne.
import { createHmac } from 'node:crypto';

import { check, finish, section, setTestEnv } from './helpers/harness.js';
import { forme, estFixture } from './helpers/secretShapes.js';

setTestEnv();

const registry = await import('../backend/src/services/integratedApi/providerRegistry.js');
const environment = await import('../backend/src/services/integratedApi/environment.js');
const transport = await import('../backend/src/services/integratedApi/opensign/openSignTransport.js');
const validation = await import('../backend/src/services/integratedApi/providerValidation.js');
const webhookRegistry = await import('../backend/src/services/webhooks/webhookRegistry.js');
const webhookSignature = await import('../backend/src/services/webhooks/webhookSignature.js');
const webhookAdapters = await import('../backend/src/services/webhooks/providerWebhookAdapters.js');
const ownership = await import('../backend/src/services/webhooks/webhookOwnership.js');
const routing = await import('../backend/src/services/integratedApi/signature/signatureProviderRouting.js');
const capabilityRegistry = await import('../backend/src/services/capabilities/capabilityRegistry.js');
const vault = await import('../backend/src/services/integratedApi/credentialVault.js');

const {
  SCOPES, TOKEN_STRATEGIES, PROVIDER_CODES,
  getProviderDefinition, credentialRoles, requiredRoleCodes, secretRoleCodes,
  administrableRoles, defaultRoleValue, environmentsFor, describeProviderDefinition,
  checkHostForEnvironment,
} = registry;

const {
  TRANSPORT_CODES, OUTCOMES, OpenSignTransportError, openSignFetch, classify,
  getUser, getWebhook, saveWebhook, deleteWebhook,
} = transport;

const JETON = forme.openSignApiToken('OPENSIGN0001');
const CLE_WEBHOOK = forme.openSignWebhookKey('AA01');
const SANDBOX = 'https://sandbox.opensignlabs.com/api/v1.2';
const PROD = 'https://app.opensignlabs.com/api/v1.2';
const EU = 'https://eu-app.opensignlabs.com/api/v1.2';

/** Un `fetch` de recette : il enregistre l'appel et rend ce qu'on lui dit. */
function fauxFetch(reponses) {
  const appels = [];
  const file = Array.isArray(reponses) ? [...reponses] : [reponses];
  const impl = async (url, options = {}) => {
    appels.push({ url, options, headers: options.headers ?? {} });
    const suivante = file.length > 1 ? file.shift() : file[0];
    if (typeof suivante === 'function') return suivante(url, options);
    const { status = 200, body = {}, text } = suivante ?? {};
    const corps = text !== undefined ? text : JSON.stringify(body);
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: { get: () => null },
      text: async () => corps,
      arrayBuffer: async () => Buffer.from(corps),
    };
  };
  impl.appels = appels;
  return impl;
}

const credentials = { apiToken: JETON, baseUrl: SANDBOX };

/* ══════════════════════════════════════════════════════════════════════════ */
/*  1. LE REGISTRE                                                            */
/* ══════════════════════════════════════════════════════════════════════════ */

section('1 · OPENSIGN est au registre, et son modèle d’exécution est celui du fournisseur');
{
  const definition = getProviderDefinition('OPENSIGN');
  check('déclaré au registre code-first', definition !== null);
  check('catégorie SIGNATURE', definition.category === 'SIGNATURE');
  check('la définition est gelée', Object.isFrozen(definition));

  /**
   * LA PORTÉE N'EST PAS UN CHOIX DE CONFORT.
   *
   * OpenSign émet deux jetons distincts sur deux hôtes distincts, et documente
   * qu'ils ne sont pas interchangeables — jusqu'aux gabarits, qui ne traversent
   * pas. `PANEL_GLOBAL` aurait fusionné deux comptes qui ne se voient pas.
   */
  check('portée ENVIRONMENT — deux mondes, deux comptes',
    definition.scope === SCOPES.ENVIRONMENT);
  check('deux jeux à provisionner : TEST et PROD',
    JSON.stringify(environmentsFor('OPENSIGN')) === JSON.stringify(['TEST', 'PROD']));
  check('clé statique — aucun rafraîchissement, aucun runtime à persister',
    definition.tokenStrategy === TOKEN_STRATEGIES.STATIC_KEY);
  check('les deux mondes sont annoncés supportés',
    definition.supportsTest === true && definition.supportsProd === true);
}

section('2 · Rôles de credentials — les noms du fournisseur, pas les nôtres');
{
  const codes = credentialRoles('OPENSIGN').map((r) => r.code);
  check('apiToken, webhookSecret, webhookSecretPrevious, baseUrl',
    JSON.stringify(codes) === JSON.stringify(['apiToken', 'webhookSecret', 'webhookSecretPrevious', 'baseUrl']));
  check('seul apiToken est requis', requiredRoleCodes('OPENSIGN').join() === 'apiToken');
  check('apiToken est confidentiel', secretRoleCodes('OPENSIGN').includes('apiToken'));
  check('webhookSecret est confidentiel', secretRoleCodes('OPENSIGN').includes('webhookSecret'));
  check('baseUrl ne l’est PAS — la masquer empêcherait de la vérifier',
    !secretRoleCodes('OPENSIGN').includes('baseUrl'));

  /**
   * LE RÔLE INTERNE NE DESCEND PAS JUSQU'AU FORMULAIRE.
   *
   * `webhookSecretPrevious` vit dans le coffre parce que la fenêtre de rotation
   * en a besoin, pas parce qu'un opérateur doit le connaître. L'exposer
   * ajouterait un champ que personne ne doit remplir — donc un champ que
   * quelqu'un finira par remplir.
   */
  check('webhookSecretPrevious est INTERNE (aucun formulaire)',
    !administrableRoles('OPENSIGN').some((r) => r.code === 'webhookSecretPrevious'));
  check('la vue publique ne le montre pas non plus',
    !describeProviderDefinition('OPENSIGN', { environment: 'TEST' })
      .credentialRoles.some((r) => r.code === 'webhookSecretPrevious'));

  /**
   * LA CLÉ DE WEBHOOK N'EST PAS AUTO-GÉRÉE — c'est la différence structurelle
   * avec les trois autres fournisseurs, et elle doit rester visible.
   */
  const cle = credentialRoles('OPENSIGN').find((r) => r.code === 'webhookSecret');
  check('la clé de webhook n’est pas auto-gérée', cle.autoManaged === false);
  check('…et reste facultative : sans elle, le webhook est sourd, pas cassé',
    cle.required === false);
  check('…et elle est « vérification seule » : elle ne sait rien appeler',
    cle.verificationOnly === true);
}

section('3 · Les hôtes — une CONTRAINTE, pas un défaut');
{
  check('TEST propose le bac à sable', defaultRoleValue('OPENSIGN', 'baseUrl', 'TEST') === SANDBOX);
  check('PROD propose app (décision documentée, pas eu-app)',
    defaultRoleValue('OPENSIGN', 'baseUrl', 'PROD') === PROD);

  /**
   * L'INCIDENT QUE CETTE CONTRAINTE EXISTE POUR ÉVITER — déjà vécu avec
   * Yousign : une clé de bac à sable envoyée à l'hôte de production reçoit un
   * refus qui ressemble à une clé morte, sur TOUTES les routes. Le Panel
   * concluait « clé invalide », et l'opérateur cherchait du côté de sa clé.
   */
  const prodEnTest = checkHostForEnvironment('OPENSIGN', 'baseUrl', 'TEST', PROD);
  check('l’hôte de PROD est refusé dans un jeu TEST',
    prodEnTest?.reason === 'OTHER_ENVIRONMENT' && prodEnTest.otherEnvironment === 'PROD');
  const sandboxEnProd = checkHostForEnvironment('OPENSIGN', 'baseUrl', 'PROD', SANDBOX);
  check('…et réciproquement',
    sandboxEnProd?.reason === 'OTHER_ENVIRONMENT' && sandboxEnProd.otherEnvironment === 'TEST');

  /**
   * L'UE EST UN AUTRE COMPTE, PAS UNE AUTRE URL. La saisir aujourd'hui n'est
   * donc pas « une variante » : c'est pointer un tenant où le jeton du compte
   * n'existe pas. Le refus est nommé UNKNOWN_HOST, et non OTHER_ENVIRONMENT —
   * ce n'est pas l'autre monde du même compte.
   */
  const euEnProd = checkHostForEnvironment('OPENSIGN', 'baseUrl', 'PROD', EU);
  check('l’hôte UE est refusé tant qu’il n’est pas l’hôte choisi',
    euEnProd?.reason === 'UNKNOWN_HOST');

  check('une URL malformée est refusée sans exception',
    checkHostForEnvironment('OPENSIGN', 'baseUrl', 'TEST', 'pas-une-url')?.reason === 'MALFORMED');
  check('une valeur vide ne dit rien (le défaut s’appliquera)',
    checkHostForEnvironment('OPENSIGN', 'baseUrl', 'TEST', '') === null);
}

section('4 · Routage d’environnement — fail-closed, sans repli silencieux');
{
  const definition = getProviderDefinition('OPENSIGN');
  check('un Panel TEST résout le jeu TEST',
    environment.resolveIntegratedApiEnvironment({
      providerDefinition: definition, runtimeEnvironment: 'TEST',
    }) === 'TEST');
  check('un Panel PROD résout le jeu PROD',
    environment.resolveIntegratedApiEnvironment({
      providerDefinition: definition, runtimeEnvironment: 'PROD',
    }) === 'PROD');

  /**
   * CONFIGURER PROD DEPUIS UN PANEL TEST EST LÉGITIME (c'est du
   * provisionnement) ; EXÉCUTER EN PROD DEPUIS UN PANEL TEST NE L'EST JAMAIS.
   * Deux fonctions, deux verdicts — et c'est la seconde qui protège.
   */
  check('administrer le jeu PROD depuis un Panel TEST reste permis',
    environment.assertAdministrableEnvironment('PROD', definition) === 'PROD');
  let refus = null;
  try { environment.assertEnvironmentServed('PROD', { runtimeEnvironment: 'TEST' }); }
  catch (err) { refus = err?.code; }
  check('agir en PROD depuis un Panel TEST est REFUSÉ',
    refus === environment.INTEGRATED_API_ENVIRONMENT_MISMATCH);
  check('…et un environnement absent n’est pas un passe-droit : il est exigé',
    (() => {
      try { environment.assertAdministrableEnvironment(null, definition); return false; }
      catch (err) { return err?.code === 'PANEL_INTEGRATED_API_ENVIRONMENT_REQUIRED'; }
    })());
}

/* ══════════════════════════════════════════════════════════════════════════ */
/*  5. LE TRANSPORT                                                           */
/* ══════════════════════════════════════════════════════════════════════════ */

section('5 · Le transport — le bon en-tête, et RIEN qui vienne d’ailleurs que du coffre');
{
  const impl = fauxFetch({ status: 200, body: { objectId: 'FGik23bhUJ', email: 'a@b.test' } });
  await getUser({ credentials, fetchImpl: impl });

  const [appel] = impl.appels;
  check('l’URL est celle du coffre, préfixe compris',
    appel.url === `${SANDBOX}/getuser`);
  check('l’en-tête est x-api-token — le nom du fournisseur',
    appel.headers['x-api-token'] === JETON);
  /**
   * PAS DE `Bearer`. OpenSign n'utilise pas `Authorization` : y glisser le
   * jeton « au cas où » l'enverrait à un en-tête que des intermédiaires
   * journalisent volontiers, pour une authentification qui n'en a pas besoin.
   */
  check('aucun en-tête Authorization n’est posé',
    appel.headers.Authorization === undefined && appel.headers.authorization === undefined);
  check('un GET ne porte aucun corps', appel.options.body === undefined);
  check('l’appel est borné dans le temps', Boolean(appel.options.signal));
}

section('6 · Aucun hôte n’est écrit dans le driver');
{
  let code = null;
  try {
    await getUser({ credentials: { apiToken: JETON }, fetchImpl: fauxFetch({ status: 200 }) });
  } catch (err) { code = err?.code; }
  /**
   * SANS HÔTE, ON N'APPELLE PAS. Le repli qu'on n'a pas écrit est le pire
   * défaut possible ici : un défaut sur la production ferait partir une clé de
   * bac à sable dans le monde réel, et l'appel RÉUSSIRAIT peut-être.
   */
  check('un hôte absent est un refus, jamais un défaut',
    code === TRANSPORT_CODES.MISSING_CREDENTIALS);

  let sansJeton = null;
  try {
    await getUser({ credentials: { baseUrl: SANDBOX }, fetchImpl: fauxFetch({ status: 200 }) });
  } catch (err) { sansJeton = err?.code; }
  check('un jeton absent aussi', sansJeton === TRANSPORT_CODES.MISSING_CREDENTIALS);
}

section('7 · 405 SIGNIFIE « jeton invalide » CHEZ OPENSIGN');
{
  /**
   * ══ LE PIÈGE ═════════════════════════════════════════════════════════════
   *
   * Les 36 endpoints v1.2 documentent `405 { "error": "Invalid API token!" }`.
   * Un classificateur HTTP générique range 405 dans « refus inattendu » et
   * envoie relire son URL et sa méthode — alors que la seule chose à corriger
   * est la clé. Le faux diagnostic coûte une heure à chaque fois.
   */
  check('classify(405) → UNAUTHORIZED',
    classify(405, { error: 'Invalid API token!' }) === TRANSPORT_CODES.UNAUTHORIZED);
  check('classify(401) → UNAUTHORIZED', classify(401, { error: 'nope' }) === TRANSPORT_CODES.UNAUTHORIZED);

  /**
   * MAIS 401 N'EST PAS TOUJOURS UN REFUS DE JETON. `POST /webhook` rend
   * « Webhook url already exists! » en 401 : c'est un CONFLIT, et le jeton
   * vient précisément de servir. « Clé invalide » serait faux au moment exact
   * où le webhook est correctement en place.
   */
  check('401 « already exists » → REJECTED, pas UNAUTHORIZED',
    classify(401, { error: 'Webhook url already exists!' }) === TRANSPORT_CODES.REJECTED);

  check('404 → NOT_FOUND', classify(404, { error: 'Document not found!' }) === TRANSPORT_CODES.NOT_FOUND);
  check('400 → INPUT_INVALID', classify(400, { error: 'Something went wrong' }) === TRANSPORT_CODES.INPUT_INVALID);
  /**
   * LES CRÉDITS SONT UNE PANNE DE COMPTE, PAS UNE ERREUR D'ENTRÉE. Les
   * confondre ferait chercher un champ fautif dans un payload correct.
   */
  check('400 « credits » → QUOTA_EXHAUSTED',
    classify(400, { error: 'Not enough credits to create document' }) === TRANSPORT_CODES.QUOTA_EXHAUSTED);
  check('429 → RATE_LIMITED', classify(429, {}) === TRANSPORT_CODES.RATE_LIMITED);
  check('503 → PROVIDER_ERROR', classify(503, {}) === TRANSPORT_CODES.PROVIDER_ERROR);

  // Et le chemin complet, pas seulement la fonction pure.
  let erreur = null;
  try {
    await getUser({ credentials, fetchImpl: fauxFetch({ status: 405, body: { error: 'Invalid API token!' } }) });
  } catch (err) { erreur = err; }
  check('un 405 réel remonte en UNAUTHORIZED', erreur?.code === TRANSPORT_CODES.UNAUTHORIZED);
  check('…avec le statut conservé', erreur?.httpStatus === 405);
  check('…et la phrase du fournisseur mise de côté, pas dans le message',
    erreur.providerError === 'Invalid API token!' && !erreur.message.includes('Invalid API token'));
}

section('8 · L’issue INDÉTERMINÉE — la distinction qui empêche de doubler un acte');
{
  const timeout = async () => { const e = new Error('abort'); e.name = 'AbortError'; throw e; };
  let erreur = null;
  try { await saveWebhook({ credentials, url: 'https://panel.test/hook', fetchImpl: timeout }); }
  catch (err) { erreur = err; }
  check('un délai dépassé rend TIMEOUT', erreur?.code === TRANSPORT_CODES.TIMEOUT);
  /**
   * `UNKNOWN`, ET NON `FAILED`. `FAILED` affirme que rien n'a eu lieu — et
   * c'est cette affirmation qui pousse à rejouer. Sur une écriture OpenSign,
   * rejouer débite un crédit et peut solliciter une seconde fois une personne
   * réelle.
   */
  check('…et l’issue est INDÉTERMINÉE', erreur?.outcome === OUTCOMES.UNKNOWN);
  check('…donc le rejeu automatique est interdit', erreur.replaySafe === false);

  let injoignable = null;
  try { await getUser({ credentials, fetchImpl: async () => { throw new Error('ECONNRESET'); } }); }
  catch (err) { injoignable = err; }
  check('un réseau coupé rend UNREACHABLE', injoignable?.code === TRANSPORT_CODES.UNREACHABLE);
  check('…et reste INDÉTERMINÉ', injoignable?.outcome === OUTCOMES.UNKNOWN);

  /**
   * UN REFUS REÇU, LUI, EST CERTAIN : rien n'est parti, le rejeu après
   * correction est légitime. C'est l'autre moitié de la distinction.
   */
  let refus = null;
  try { await getUser({ credentials, fetchImpl: fauxFetch({ status: 400, body: { error: 'x' } }) }); }
  catch (err) { refus = err; }
  check('un refus REÇU est certain, donc rejouable après correction',
    refus?.outcome === OUTCOMES.FAILED && refus.replaySafe === true);

  const horsJson = fauxFetch({ status: 200, text: '<html>maintenance</html>' });
  let malforme = null;
  try { await getUser({ credentials, fetchImpl: horsJson }); } catch (err) { malforme = err; }
  check('une réponse hors JSON est INDÉTERMINÉE, pas un succès vide',
    malforme?.code === TRANSPORT_CODES.MALFORMED_RESPONSE && malforme.outcome === OUTCOMES.UNKNOWN);
}

section('9 · Aucun réessai automatique — le transport ne rejoue rien, jamais');
{
  const impl = fauxFetch({ status: 500, body: { error: 'boom' } });
  try { await saveWebhook({ credentials, url: 'https://panel.test/hook', fetchImpl: impl }); } catch { /* attendu */ }
  /**
   * UN SEUL APPEL, même sur un 500 « réessayable ». Le drapeau `retryable`
   * INFORME un appelant capable de décider ; il n'autorise pas le transport à
   * décider tout seul. C'est le registre d'opérations du Panel qui reprend, et
   * lui seul.
   */
  check('un 500 sur une écriture ne produit qu’UN appel', impl.appels.length === 1);
}

section('10 · Aucun secret ne ressort d’une erreur');
{
  let erreur = null;
  try {
    await getUser({ credentials, fetchImpl: fauxFetch({ status: 405, body: { error: 'Invalid API token!' } }) });
  } catch (err) { erreur = err; }
  const trace = JSON.stringify({
    message: erreur.message, code: erreur.code, providerError: erreur.providerError,
    stack: erreur.stack, ...erreur,
  });
  check('le jeton n’apparaît nulle part dans l’erreur', !trace.includes(JETON));
  check('…ni dans son message', !erreur.message.includes(JETON));
  check('la fixture est bien reconnaissable comme telle', estFixture(JETON));
}

/* ══════════════════════════════════════════════════════════════════════════ */
/*  11. LE VALIDATEUR                                                         */
/* ══════════════════════════════════════════════════════════════════════════ */

section('11 · Le test de connexion — non destructif, et fail-closed');
{
  check('OPENSIGN a un validateur', validation.hasValidator('OPENSIGN'));

  const chiffre = vault.encryptCredentialValues({
    provider: 'OPENSIGN',
    values: { apiToken: JETON, baseUrl: SANDBOX },
    environment: 'TEST',
  }).stored;

  const impl = fauxFetch([
    { status: 200, body: { objectId: 'FGik23bhUJ', name: 'L.Y Solution', email: 'ops@ly.test' } },
    { status: 200, body: { webhook: 'https://panel.test/api/webhooks/opensign' } },
    { status: 200, body: { plan_credits: 40, addon_credits: 2, total_credits: 42, renewal_date: '2026-09-17T00:00:00.000Z' } },
  ]);
  const verdict = await validation.validateCredentials({
    provider: 'OPENSIGN', environment: 'TEST', credentialsEncrypted: chiffre, fetchImpl: impl,
  });

  check('verdict VALID', verdict.status === validation.VALIDATION_STATUS.VALID);
  /**
   * LA SONDE EST `GET /getuser`, ET C'EST UN CHOIX.
   *
   * La moitié de l'API OpenSign facture un crédit à la création d'un document :
   * toute sonde qui « essaierait » un acte métier coûterait de l'argent à
   * chaque clic sur un bouton de test. `getuser` ne crée rien, n'envoie aucun
   * e-mail, ne débite rien.
   */
  check('la sonde est bien /getuser', impl.appels[0].url.endsWith('/getuser'));
  check('aucun appel n’a créé quoi que ce soit',
    impl.appels.every((a) => (a.options.method ?? 'GET') === 'GET'));
  check('le compte lu est rendu, sans le jeton',
    verdict.details.account === 'ops@ly.test' && !JSON.stringify(verdict).includes(JETON));

  /**
   * DEUX CAPACITÉS SONDÉES À CÔTÉ, qui ne dégradent JAMAIS le verdict.
   * Les crédits sont une contrainte propre à OpenSign : les ignorer ferait
   * découvrir leur épuisement pendant une signature.
   */
  check('la capacité d’administration du webhook est renseignée',
    verdict.details.capabilities.webhookManagement === validation.CAPABILITY_STATE.GRANTED);
  check('les crédits sont lus et rendus', verdict.details.credits.total === 42);

  /** L'URL de webhook du compte n'est JAMAIS conservée : elle peut être celle
   *  d'un autre Panel. La sonde ne lit que le statut. */
  check('l’URL de webhook observée n’est pas exposée par le diagnostic',
    !JSON.stringify(verdict).includes('/api/webhooks/opensign'));
}

section('12 · Un compte sans crédit reste VALIDE — et le dit');
{
  const chiffre = vault.encryptCredentialValues({
    provider: 'OPENSIGN', values: { apiToken: JETON, baseUrl: SANDBOX }, environment: 'TEST',
  }).stored;
  const impl = fauxFetch([
    { status: 200, body: { email: 'ops@ly.test' } },
    { status: 200, body: { webhook: '' } },
    { status: 200, body: { plan_credits: 0, addon_credits: 0, total_credits: 0 } },
  ]);
  const verdict = await validation.validateCredentials({
    provider: 'OPENSIGN', environment: 'TEST', credentialsEncrypted: chiffre, fetchImpl: impl,
  });
  /**
   * TROIS FAITS VRAIS EN MÊME TEMPS : le jeton s'authentifie, la capacité
   * d'administration est là, et aucune signature ne peut être ouverte.
   * « Clé invalide » les écraserait en un seul mensonge, et enverrait
   * régénérer une clé qui n'a rien.
   */
  check('le jeton reste VALID', verdict.status === validation.VALIDATION_STATUS.VALID);
  check('…mais le message nomme l’épuisement des crédits',
    /crédit/i.test(verdict.message));
}

section('13 · Le mauvais monde est refusé AVANT le réseau');
{
  const chiffre = vault.encryptCredentialValues({
    provider: 'OPENSIGN', values: { apiToken: JETON }, environment: 'PROD',
  }).stored;
  // On force une baseUrl de bac à sable dans un jeu PROD, comme le ferait un
  // copier-coller.
  const force = vault.encryptCredentialValues({
    provider: 'OPENSIGN', current: chiffre, values: { baseUrl: SANDBOX }, environment: null,
  }).stored;

  const impl = fauxFetch({ status: 200, body: {} });
  const verdict = await validation.validateCredentials({
    provider: 'OPENSIGN', environment: 'PROD', credentialsEncrypted: force, fetchImpl: impl,
  });
  check('verdict INVALID / WRONG_ENVIRONMENT',
    verdict.status === validation.VALIDATION_STATUS.INVALID
    && verdict.code === validation.VALIDATION_CODES.WRONG_ENVIRONMENT);
  /**
   * AUCUN APPEL N'EST PARTI. Ce n'est pas une optimisation : envoyer un jeton
   * de production à l'hôte de bac à sable (ou l'inverse) l'expose à un monde
   * qui n'est pas le sien, pour un refus dont on connaissait déjà la cause.
   */
  check('…et RIEN n’est parti sur le réseau', impl.appels.length === 0);
  /**
   * LE MESSAGE DOIT FAIRE TROIS CHOSES, ET C'EST TOUT L'INTÉRÊT DU LOT :
   * nommer l'hôte visé, nommer l'hôte attendu, et DIRE QUE LA CLÉ N'EST PAS EN
   * CAUSE. Sans la troisième phrase, l'opérateur régénère un jeton parfaitement
   * valide — c'est exactement ce qui est arrivé sur Yousign.
   */
  check('le message nomme l’hôte visé', verdict.message.includes('sandbox.opensignlabs.com'));
  check('…et l’hôte attendu', verdict.message.includes('app.opensignlabs.com'));
  check('…et disculpe explicitement le jeton', /n’est pas en cause/.test(verdict.message));
}

section('14 · Un jeton refusé (405) donne le bon verdict, pas « on ne sait pas »');
{
  const chiffre = vault.encryptCredentialValues({
    provider: 'OPENSIGN', values: { apiToken: JETON, baseUrl: SANDBOX }, environment: 'TEST',
  }).stored;
  const verdict = await validation.validateCredentials({
    provider: 'OPENSIGN', environment: 'TEST', credentialsEncrypted: chiffre,
    fetchImpl: fauxFetch({ status: 405, body: { error: 'Invalid API token!' } }),
  });
  check('INVALID, et non ERROR', verdict.status === validation.VALIDATION_STATUS.INVALID);
  check('code UNAUTHORIZED', verdict.code === validation.VALIDATION_CODES.UNAUTHORIZED);
  check('le message EXPLIQUE le 405 — sinon il envoie chercher une erreur d’appel',
    /405/.test(verdict.message) && /token/i.test(verdict.message));
}

section('15 · Un jeu non configuré ne teste rien — fail-closed');
{
  const verdict = await validation.validateCredentials({
    provider: 'OPENSIGN', environment: 'TEST', credentialsEncrypted: {},
    fetchImpl: fauxFetch({ status: 200, body: {} }),
  });
  check('ERROR / MISSING_CREDENTIALS',
    verdict.status === validation.VALIDATION_STATUS.ERROR
    && verdict.code === validation.VALIDATION_CODES.MISSING_CREDENTIALS);
  check('le rôle manquant est NOMMÉ', verdict.details.missing.join() === 'apiToken');
}

/* ══════════════════════════════════════════════════════════════════════════ */
/*  16. LE WEBHOOK                                                            */
/* ══════════════════════════════════════════════════════════════════════════ */

section('16 · Le descripteur webhook dit la vérité sur OpenSign');
{
  const cap = webhookRegistry.webhookCapability('OPENSIGN');
  check('supporté', cap.supported === true);
  check('segment de callback dédié', cap.callbackSlug === 'opensign');
  check('HMAC-SHA256 sur le corps brut, en-tête x-webhook-signature',
    cap.signatureScheme === webhookRegistry.SIGNATURE_SCHEMES.HMAC_SHA256_BODY
    && cap.signatureHeader === 'x-webhook-signature');
  check('la vérification est annoncée possible', cap.supportsSignatureVerification === true);

  /**
   * LE SECRET NE VIENT PAS DE L'API — et le ranger ailleurs coûterait cher.
   *
   * `AT_CREATION_ONLY` ferait RECRÉER l'endpoint pour capturer une valeur qui
   * n'arrive jamais, sur une ressource unique par compte : chaque passage
   * écraserait l'URL en place. `CALLER_SUPPLIED` ferait tenter une rotation par
   * une route inexistante. `NONE` ferait afficher « aucune vérification
   * possible » alors qu'OpenSign signe réellement.
   */
  check('livraison du secret : OUT_OF_BAND',
    cap.secretDelivery === webhookRegistry.SECRET_DELIVERY.OUT_OF_BAND);
  check('aucun secret n’est fabriqué à la création',
    webhookRegistry.SECRET_DELIVERY.OUT_OF_BAND !== webhookRegistry.SECRET_DELIVERY.CALLER_SUPPLIED);
  check('les rôles du coffre sont ceux du registre',
    cap.secretRole === 'webhookSecret'
    && cap.secretPreviousRole === 'webhookSecretPrevious'
    && cap.apiCredentialRole === 'apiToken');

  /**
   * UNE SEULE URL PAR COMPTE. Deux Panels ne peuvent pas partager un compte
   * OpenSign : le second écraserait le webhook du premier. Le préflight le dit
   * plutôt qu'un incident.
   */
  check('plafond documenté : 1 endpoint par compte', cap.remoteEndpointLimit === 1);
  check('les cinq événements sont déclarés',
    JSON.stringify(cap.desiredEvents) === JSON.stringify(['created', 'viewed', 'signed', 'completed', 'declined']));
  /**
   * IL N'Y A RIEN À SOUSCRIRE. Le comparateur par défaut verrait cinq
   * événements éternellement « manquants » et réécrirait l'unique URL du compte
   * à chaque passage — un réconciliateur qui ne converge jamais.
   */
  check('la comparaison d’événements ne signale jamais de dérive',
    cap.compareEvents([], cap.desiredEvents).aligned === true);
  /**
   * ET IL N'Y A PAS DE DESCRIPTION. Sans ce drapeau, la divergence de
   * description serait perpétuelle, pour la même raison.
   */
  check('OpenSign n’a pas de champ description', cap.supportsDescription === false);
  check('les autres fournisseurs, eux, en ont un',
    webhookRegistry.webhookCapability('STRIPE').supportsDescription === true
    && webhookRegistry.webhookCapability('BREVO').supportsDescription === true);
}

section('17 · La signature réelle d’OpenSign est vérifiable par le moteur générique');
{
  const cap = webhookRegistry.webhookCapability('OPENSIGN');
  const charge = {
    event: 'completed',
    type: 'request-sign',
    objectId: 'kpeg6Q2rO7',
    name: 'Contrat',
    completedAt: 'Fri, 16 May 2025 16:18:35 GMT+5:30',
  };
  const corps = Buffer.from(JSON.stringify(charge), 'utf8');
  const attendue = createHmac('sha256', CLE_WEBHOOK).update(corps).digest('hex');

  const bon = webhookSignature.verifyWebhookSignature(cap, {
    rawBody: corps,
    headers: { 'x-webhook-signature': attendue },
    secrets: [CLE_WEBHOOK],
  });
  check('une signature correcte est acceptée', bon.verified === true);
  /**
   * `proven`, ET NON SEULEMENT `verified`. OpenSign signe le CORPS : le
   * détenteur de la clé est le seul à pouvoir produire cette signature pour ce
   * corps-là. C'est une preuve, pas une simple authentification de porteur
   * comme le Bearer de Brevo — et le code doit pouvoir dire la différence.
   */
  check('…et la preuve porte sur le CORPS, pas seulement sur le porteur', bon.proven === true);

  const falsifie = webhookSignature.verifyWebhookSignature(cap, {
    rawBody: Buffer.from(JSON.stringify({ ...charge, objectId: 'AUTRE12345' }), 'utf8'),
    headers: { 'x-webhook-signature': attendue },
    secrets: [CLE_WEBHOOK],
  });
  check('un corps modifié est REFUSÉ', falsifie.verified === false);

  const mauvaiseCle = webhookSignature.verifyWebhookSignature(cap, {
    rawBody: corps,
    headers: { 'x-webhook-signature': createHmac('sha256', 'autre-cle').update(corps).digest('hex') },
    secrets: [CLE_WEBHOOK],
  });
  check('une signature d’une autre clé est REFUSÉE', mauvaiseCle.verified === false);

  check('un en-tête absent est REFUSÉ',
    webhookSignature.verifyWebhookSignature(cap, { rawBody: corps, headers: {}, secrets: [CLE_WEBHOOK] })
      .reason === 'MISSING_HEADER');
  /**
   * SANS SECRET, ON N'ACCEPTE PAS « EN ATTENDANT ». Un endpoint dont la clé
   * n'a pas été recopiée est SOURD, et c'est le bon état : accepter sans
   * vérifier reviendrait à accepter n'importe qui.
   */
  check('sans secret en coffre, tout est REFUSÉ',
    webhookSignature.verifyWebhookSignature(cap, {
      rawBody: corps, headers: { 'x-webhook-signature': attendue }, secrets: [],
    }).reason === 'NO_SECRET');

  /** La fenêtre de rotation vaut aussi ici : la rotation est MANUELLE, mais
   *  les événements en vol, eux, ne le savent pas. */
  const pendantRotation = webhookSignature.verifyWebhookSignature(cap, {
    rawBody: corps,
    headers: { 'x-webhook-signature': attendue },
    secrets: [forme.openSignWebhookKey('NEUVE'), CLE_WEBHOOK],
  });
  check('l’ancienne clé reste acceptée pendant la fenêtre de rotation',
    pendantRotation.verified === true);
}

section('17b · Le diagnostic de représentation — il NOMME, il n’accepte pas');
{
  /**
   * ══ L'AMBIGUÏTÉ QUE CE DIAGNOSTIC EXISTE POUR TRANCHER ═════════════════════
   *
   * La page d'aide d'OpenSign dit « utilisez le corps brut », et l'exemple de
   * code publié juste en dessous calcule le HMAC sur `JSON.stringify(req.body)`.
   * Les deux ne coïncident que si le fournisseur émet exactement les octets
   * qu'il a signés.
   *
   * Sans diagnostic, un désaccord se présente comme un `MISMATCH` — le même mot
   * que pour une mauvaise clé ou un appel falsifié. Trois causes, trois gestes
   * opposés, aucune information pour choisir.
   */
  const charge = { event: 'signed', objectId: 'kpeg6Q2rO7', signer: { email: 'a@b.test' } };
  // Un corps « au fil » qui n'est PAS la re-sérialisation canonique : espaces
  // et ordre de clés diffèrent, exactement comme dans la vraie vie.
  const auFil = Buffer.from(`{ "event": "signed",  "objectId": "kpeg6Q2rO7",\n  "signer": { "email": "a@b.test" } }`, 'utf8');
  const canonique = Buffer.from(JSON.stringify(JSON.parse(auFil.toString('utf8'))), 'utf8');

  const signeSur = (octets) => createHmac('sha256', CLE_WEBHOOK).update(octets).digest('hex');

  check('il reconnaît une signature portant sur les OCTETS reçus',
    webhookSignature.diagnoseHmacRepresentation({
      rawBody: auFil, signatureHeader: signeSur(auFil), secrets: [CLE_WEBHOOK],
    }).matched === 'RAW_BODY');

  check('il reconnaît une signature portant sur la RE-SÉRIALISATION',
    webhookSignature.diagnoseHmacRepresentation({
      rawBody: auFil, signatureHeader: signeSur(canonique), secrets: [CLE_WEBHOOK],
    }).matched === 'JSON_RESERIALIZED');

  /**
   * ET SURTOUT : IL NE DIT PAS OUI QUAND C'EST NON. Une clé étrangère ne doit
   * correspondre à AUCUNE représentation — sinon le diagnostic deviendrait un
   * oracle, et l'on finirait par s'en servir comme d'un vérificateur.
   */
  check('une clé étrangère ne correspond à aucune représentation',
    webhookSignature.diagnoseHmacRepresentation({
      rawBody: auFil,
      signatureHeader: createHmac('sha256', 'cle-etrangere').update(auFil).digest('hex'),
      secrets: [CLE_WEBHOOK],
    }).matched === null);

  check('sans secret, il ne diagnostique rien',
    webhookSignature.diagnoseHmacRepresentation({
      rawBody: auFil, signatureHeader: signeSur(auFil), secrets: [],
    }).matched === null);

  check('un corps non-JSON n’a qu’une représentation à examiner',
    JSON.stringify(webhookSignature.diagnoseHmacRepresentation({
      rawBody: Buffer.from('pas du json'), signatureHeader: 'ff', secrets: [CLE_WEBHOOK],
    }).candidates) === JSON.stringify(['RAW_BODY']));

  /**
   * LA GARDE QUI COMPTE LE PLUS : le VÉRIFICATEUR, lui, n'a pas bougé. Une
   * signature portant sur la re-sérialisation reste REFUSÉE. Le diagnostic
   * informe le journal ; il n'ouvre aucune porte.
   */
  const cap = webhookRegistry.webhookCapability('OPENSIGN');
  check('le vérificateur REFUSE toujours une signature sur la re-sérialisation',
    webhookSignature.verifyWebhookSignature(cap, {
      rawBody: auFil,
      headers: { 'x-webhook-signature': signeSur(canonique) },
      secrets: [CLE_WEBHOOK],
    }).verified === false);
  check('…et accepte celle qui porte sur les octets reçus',
    webhookSignature.verifyWebhookSignature(cap, {
      rawBody: auFil,
      headers: { 'x-webhook-signature': signeSur(auFil) },
      secrets: [CLE_WEBHOOK],
    }).verified === true);
}

section('18 · L’identité d’un événement — OpenSign n’en fournit AUCUNE');
{
  const cap = webhookRegistry.webhookCapability('OPENSIGN');
  const signe = (email, at) => ({
    event: 'signed', objectId: 'kpeg6Q2rO7', signer: { email }, signedAt: at,
  });

  const a = webhookRegistry.openSignEventIdentity(signe('dev@ly.test', 'Fri, 16 May 2025 16:18:34 IST'), { environment: 'TEST' });
  const b = webhookRegistry.openSignEventIdentity(signe('dev@ly.test', 'Fri, 16 May 2025 16:18:34 IST'), { environment: 'TEST' });
  check('le même événement rend la MÊME clé — un rejeu reste un rejeu', a === b);

  /**
   * L'ACTEUR EST INDISPENSABLE. Sans lui, deux signataires qui signent dans la
   * même seconde produisent la même clé : le second est perdu en silence, et le
   * contrat reste éternellement à moitié signé.
   */
  check('deux signataires distincts au même instant → deux clés',
    a !== webhookRegistry.openSignEventIdentity(signe('client@ly.test', 'Fri, 16 May 2025 16:18:34 IST'), { environment: 'TEST' }));
  check('deux mondes → deux clés',
    a !== webhookRegistry.openSignEventIdentity(signe('dev@ly.test', 'Fri, 16 May 2025 16:18:34 IST'), { environment: 'PROD' }));
  check('deux événements sur le même document → deux clés',
    a !== webhookRegistry.openSignEventIdentity({ event: 'viewed', objectId: 'kpeg6Q2rO7', viewedBy: 'dev@ly.test', viewedAt: 'Fri, 16 May 2025 16:18:34 IST' }, { environment: 'TEST' }));

  /**
   * AUCUNE ADRESSE EN CLAIR. La clé ne doit pas devenir un annuaire : elle
   * distingue sans permettre de retrouver.
   */
  check('l’adresse du signataire n’apparaît pas en clair', !a.includes('dev@ly.test'));

  /**
   * L'HORODATAGE N'EST PAS PARSÉ — voir `openSignEventIdentity`. « IST »,
   * « GMT+9:30 » : `Date.parse` rend `NaN` selon le moteur, et deux événements
   * distincts partageraient alors la même identité.
   */
  check('un fuseau exotique ne casse pas la clé',
    typeof webhookRegistry.openSignEventIdentity(signe('dev@ly.test', 'Sat, 20 Dec 2025 00:58:20 GMT+9:30'), { environment: 'TEST' }) === 'string');

  check('un corps sans objectId ne produit AUCUNE clé (repli sur l’empreinte)',
    webhookRegistry.openSignEventIdentity({ event: 'signed' }, { environment: 'TEST' }) === null);

  // Et le moteur générique retombe bien sur l'empreinte du corps si la clé
  // composite est impossible : jamais d'identité vide.
  const identite = webhookSignature.extractEventIdentity(cap, {
    rawBody: Buffer.from('{"event":"signed"}'),
    parsed: { event: 'signed' },
    environment: 'TEST',
  });
  check('sans clé composite, l’identité retombe sur l’empreinte',
    identite.providerEventId.startsWith('sha256:'));
  check('le type d’événement est lu dans le champ « event »', identite.eventType === 'signed');
}

section('19 · Le pilote distant — une ressource SINGLETON, sans tricherie');
{
  const adapter = webhookAdapters.webhookAdapterFor('OPENSIGN');
  check('le pilote est résolu par son code', adapter?.provider === 'OPENSIGN');

  const ctx = (impl) => ({ credentials, environment: 'TEST', fetchImpl: impl });

  const vide = fauxFetch({ status: 404, body: { error: 'User not found!' } });
  check('404 « User not found » = aucune URL posée, PAS une panne',
    (await adapter.list(ctx(vide))).length === 0);
  /**
   * SANS CETTE LECTURE, LA PREMIÈRE CONFIGURATION SERAIT IMPOSSIBLE : le
   * moteur croirait le fournisseur cassé et n'oserait rien créer.
   */
  const jamaisPose = fauxFetch({ status: 200, body: { webhook: '' } });
  check('une URL vide vaut « rien de posé »', (await adapter.list(ctx(jamaisPose))).length === 0);

  const pose = fauxFetch({ status: 200, body: { webhook: 'https://panel.test/api/webhooks/opensign' } });
  const liste = await adapter.list(ctx(pose));
  check('une URL posée rend UN endpoint', liste.length === 1);
  /**
   * L'IDENTIFIANT EST L'URL. Sur une ressource unique, l'URL EST l'identité —
   * elle est stable, lisible dans un journal, et reconstructible sans base.
   */
  check('son identifiant est l’URL elle-même', liste[0].id === liste[0].url);
  check('sa description est VIDE — OpenSign n’a pas ce champ', liste[0].description === '');
  check('ses événements se lisent « tout » — on ne peut rien souscrire',
    JSON.stringify(liste[0].events) === JSON.stringify(['*']));

  const creation = fauxFetch({ status: 200, body: { result: 'Webhook updated successfully!' } });
  const cree = await adapter.create(ctx(creation), { url: 'https://panel.test/api/webhooks/opensign' });
  check('la création POSTe bien sur /webhook',
    creation.appels[0].options.method === 'POST' && creation.appels[0].url.endsWith('/webhook'));
  check('…avec le jeton dans x-api-token',
    creation.appels[0].headers['x-api-token'] === JETON);
  /**
   * `secret: null`, TOUJOURS — et ce n'est pas une lacune du pilote. OpenSign
   * ne rend la clé par aucune route. Prétendre le contraire ferait boucler la
   * réconciliation sur une capture impossible.
   */
  check('aucun secret n’est rendu à la création', cree.secret === null);
  check('l’identifiant rendu est l’URL', cree.id === 'https://panel.test/api/webhooks/opensign');

  /**
   * « ALREADY EXISTS » SUR UNE MISE À JOUR = L'ÉTAT VOULU EST ATTEINT. Lever
   * ici ferait échouer une réconciliation qui a réussi.
   */
  const conflit = fauxFetch({ status: 401, body: { error: 'Webhook url already exists!' } });
  let leve = false;
  try { await adapter.update(ctx(conflit), 'x', { url: 'https://panel.test/api/webhooks/opensign' }); }
  catch { leve = true; }
  check('une URL déjà posée n’est pas une erreur de mise à jour', leve === false);

  /** Un vrai refus de jeton, lui, doit lever — et être nommé pour ce qu'il est. */
  const jetonMort = fauxFetch({ status: 405, body: { error: 'Invalid API token!' } });
  let diagnostic = null;
  try { await adapter.list(ctx(jetonMort)); } catch (err) { diagnostic = err?.code; }
  check('un 405 remonte en WEBHOOK_AUTH_INVALID, pas en panne transitoire',
    diagnostic === 'WEBHOOK_AUTH_INVALID');

  const suppression = fauxFetch({ status: 200, body: { result: 'Webhook deleted successfully!' } });
  await adapter.remove(ctx(suppression), 'x');
  check('la suppression appelle DELETE /webhook',
    suppression.appels[0].options.method === 'DELETE');
  const dejaVide = fauxFetch({ status: 404, body: { error: 'User not found!' } });
  let leveSurVide = false;
  try { await adapter.remove(ctx(dejaVide), 'x'); } catch { leveSurVide = true; }
  check('supprimer ce qui n’existe plus n’est pas une erreur', leveSurVide === false);
}

section('19b · L’appartenance d’un webhook SANS description');
{
  /**
   * ══ LE BLOCAGE QUE CETTE RÈGLE DÉNOUE ═════════════════════════════════════
   *
   * L'appartenance d'un endpoint se prouve normalement par un JETON écrit dans
   * sa description. OpenSign n'a pas de description : son webhook est une URL,
   * seule, unique par compte.
   *
   * Sans règle propre, AUCUN endpoint OpenSign n'est jamais reconnu comme nôtre.
   * Le plafond d'un endpoint par compte refuse alors toute création, et le plan
   * de contrôle ne converge JAMAIS : ni adoption, ni correction, ni retrait.
   * C'est un blocage définitif, pas une gêne.
   */
  const binding = {
    provider: 'OPENSIGN', environment: 'TEST',
    ownershipToken: 'jeton-de-ce-panel', remoteWebhookId: null,
  };
  const NOTRE = 'https://api.panel.test/webhooks/providers/opensign';
  const sansJeton = { desiredUrl: NOTRE, canCarryOwnershipToken: false };

  check('l’endpoint qui porte NOTRE callback est reconnu comme nôtre',
    ownership.classifyOwnership({ id: NOTRE, url: NOTRE, description: '' }, binding, sansJeton)
    === ownership.OWNERSHIP.OWNED);

  /**
   * ET LA RÈGLE RESTE ÉTROITE : une autre adresse reste étrangère. C'est ce qui
   * empêche d'écraser le webhook d'un autre Panel — sur une ressource unique
   * par compte, l'écraser couperait sa réception sans qu'il en soit averti.
   */
  check('un endpoint pointant AILLEURS reste étranger',
    ownership.classifyOwnership(
      { id: 'x', url: 'https://api.autre-panel.test/webhooks/providers/opensign', description: '' },
      binding, sansJeton,
    ) === ownership.OWNERSHIP.FOREIGN);
  check('…et il est donc INTOUCHABLE',
    ownership.mayDelete(
      { id: 'x', url: 'https://api.autre-panel.test/webhooks/providers/opensign', description: '' },
      binding, sansJeton,
    ) === false);

  check('une URL absente ne prouve rien',
    ownership.classifyOwnership({ id: 'x', url: '', description: '' }, binding, sansJeton)
    === ownership.OWNERSHIP.FOREIGN);

  /**
   * LA RÈGLE NE DÉBORDE PAS SUR LES AUTRES FOURNISSEURS. Chez eux, la preuve
   * reste le jeton : une simple égalité d'URL ne doit RIEN donner, sans quoi on
   * aurait affaibli Stripe et Yousign pour arranger OpenSign.
   */
  check('chez un fournisseur à description, l’URL seule ne prouve rien',
    ownership.classifyOwnership(
      { id: 'we_1', url: NOTRE, description: '' }, binding,
      { desiredUrl: NOTRE, canCarryOwnershipToken: true },
    ) === ownership.OWNERSHIP.FOREIGN);
  check('…et le jeton, lui, prouve toujours',
    ownership.classifyOwnership(
      { id: 'we_1', url: NOTRE, description: 'PANEL_CONTROL_PLANE_OPENSIGN_TEST#jeton-de-ce-panel' },
      binding, { desiredUrl: NOTRE, canCarryOwnershipToken: true },
    ) === ownership.OWNERSHIP.OWNED);

  /** L'identifiant persisté reste la preuve la plus forte, quel que soit le cas. */
  check('l’identifiant persisté prime sur tout le reste',
    ownership.classifyOwnership(
      { id: 'deja-connu', url: 'https://ailleurs.test/x', description: '' },
      { ...binding, remoteWebhookId: 'deja-connu' }, sansJeton,
    ) === ownership.OWNERSHIP.OWNED);
}

/* ══════════════════════════════════════════════════════════════════════════ */
/*  20. L'INVARIANT DE COEXISTENCE                                            */
/* ══════════════════════════════════════════════════════════════════════════ */

section('20 · LA BASCULE — OpenSign sert, Yousign reste lisible');
{
  /**
   * ══ CE QUE CETTE SECTION GARDE, MAINTENANT QUE LA BASCULE A EU LIEU ═══════
   *
   * Elle gardait « rien n'a basculé ». C'était le bon invariant tant que la
   * migration n'était pas décidée ; le conserver après la bascule aurait fait
   * échouer la suite sur le succès de son propre objet.
   *
   * Ce qu'elle garde désormais est plus dur : la bascule est FAITE et
   * RÉVERSIBLE PAR LECTURE — les nouvelles demandes partent chez OpenSign, et
   * les demandes historiques restent servies par celui qui les détient.
   */
  for (const code of getProviderDefinition('OPENSIGN').capabilities) {
    check(`« ${code} » est exécutée par OPENSIGN`,
      capabilityRegistry.getCapabilityDefinition(code)?.provider === 'OPENSIGN');
  }
  check('OPENSIGN sert bien les six capacités de signature',
    capabilityRegistry.capabilitiesForProvider('OPENSIGN').length === 6);

  /**
   * YOUSIGN DÉCLARE ENCORE LES SIX CODES — ET NE LES SERT PLUS QUE PAR REFUS.
   *
   * Ce contrôle disait « il n'a rien perdu de ce qu'il sait faire ». C'était
   * vrai pendant la bascule ; il ne l'est plus depuis son retrait. Ce qui reste
   * vrai, et qui compte, c'est que le domaine est COMPLET : chaque exécutant
   * déclare tous les actes, sinon une demande historique lèverait une exception
   * nue au lieu d'obtenir une phrase.
   *
   * Ce qu'il sert désormais, c'est un refus — éprouvé par
   * `signature-provider-retirement.test.js`.
   */
  check('YOUSIGN déclare toujours les six codes de signature',
    getProviderDefinition('YOUSIGN').capabilities.length === 6);
  check('…et il est marqué RETIRÉ', getProviderDefinition('YOUSIGN').retired === true);
  check('…et le registre ne lui en confie plus par défaut',
    capabilityRegistry.capabilitiesForProvider('YOUSIGN').length === 0);

  /**
   * L'AIGUILLAGE EXISTE, ET IL EST EXPLICITE.
   *
   * Sans lui, il n'y aurait que deux issues : renoncer aux contrats
   * historiques, ou essayer les fournisseurs l'un après l'autre — c'est-à-dire
   * envoyer l'identifiant d'un contrat chez un fournisseur qui ne le connaît
   * pas, avec les identifiants du Panel.
   */
  check('le fournisseur ACTIF est OPENSIGN', routing.ACTIVE_SIGNATURE_PROVIDER === 'OPENSIGN');
  check('les liens antérieurs au champ « provider » sont YOUSIGN',
    routing.LEGACY_SIGNATURE_PROVIDER === 'YOUSIGN');
  for (const code of ['signature.request.retrieve', 'signature.signer.retrieve',
    'signature.document.download', 'signature.request.cancel']) {
    check(`« ${code} » résout son exécutant depuis la demande`,
      typeof capabilityRegistry.getCapabilityDefinition(code).resolveProvider === 'function');
  }
  check('« signature.request.open » n’a AUCUN aiguillage : une nouvelle demande n’a pas d’histoire',
    capabilityRegistry.getCapabilityDefinition('signature.request.open').resolveProvider === null);

  /** L'ouverture n'a pas d'identifiant : l'aiguilleur rend le fournisseur actif. */
  check('sans demande nommée, l’aiguilleur rend l’ACTIF',
    await routing.resolveSignatureProvider({ environment: 'TEST' }, {}) === 'OPENSIGN');

  check('le registre des capacités reste cohérent',
    capabilityRegistry.assertRegistryAlignment().length === 0);
  /**
   * LES HÔTES DE YOUSIGN ONT DISPARU — c'était le but.
   *
   * Ce contrôle vérifiait qu'ajouter OpenSign n'avait rien déplacé chez
   * l'autre. La cohabitation est finie : ce qu'on vérifie désormais, c'est que
   * plus rien du Panel ne sait où le joindre.
   */
  check('plus aucune URL proposée pour le fournisseur retiré',
    defaultRoleValue('YOUSIGN', 'baseUrl', 'TEST') === null
    && defaultRoleValue('YOUSIGN', 'baseUrl', 'PROD') === null);
  check('…et plus aucun webhook à réconcilier chez lui',
    webhookRegistry.webhookCapability('YOUSIGN').supported === false);
}

section('21 · Aucun identifiant OpenSign ne vit hors du coffre du Panel');
{
  /**
   * LA RÈGLE : un projet ne détient JAMAIS d'identifiant fournisseur. Elle est
   * déjà tenue par l'architecture — les capacités passent par la passerelle —
   * mais un nouveau fournisseur est exactement le moment où l'on recopie une
   * clé « juste pour tester ».
   */
  const { readFileSync, readdirSync, statSync } = await import('node:fs');
  const path = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const racine = path.resolve(fileURLToPath(new URL('..', import.meta.url)), 'backend/src');

  const fichiers = [];
  (function parcourir(dossier) {
    for (const entree of readdirSync(dossier)) {
      const complet = path.join(dossier, entree);
      if (statSync(complet).isDirectory()) parcourir(complet);
      else if (complet.endsWith('.js')) fichiers.push(complet);
    }
  }(racine));

  /**
   * L'HÔTE N'EST ÉCRIT QU'AU REGISTRE. Partout ailleurs il vient du coffre —
   * c'est ce qui permet de suivre un changement d'hôte, ou une bascule vers
   * l'UE, sans redéployer et sans chercher où la valeur est recopiée.
   *
   * UNE SEULE EXEMPTION : `providerRegistry.js`, qui EST la source. Les hôtes y
   * sont, avec la contrainte qui les sépare, et nulle part ailleurs.
   *
   * L'outillage de campagne (`tools/opensign/`) contient légitimement l'hôte de
   * production — la mesure « qu'arrive-t-il si j'envoie le jeton de bac à sable
   * au mauvais monde ? » ne peut pas s'écrire sans lui. Il vit HORS de
   * `backend/src` précisément pour ne pas avoir à assouplir cette règle-ci, ni
   * les trois gardes d'architecture du Panel qui l'accompagnent.
   */
  const enDur = fichiers.filter((f) => /opensignlabs\.com/.test(readFileSync(f, 'utf8')))
    .map((f) => path.basename(f));
  check('aucun hôte OpenSign codé en dur dans le runtime, hors registre',
    enDur.every((n) => n === 'providerRegistry.js'));
  check('le runtime a bien été balayé (garde anti-test-vide)', fichiers.length > 50);

  check('le driver ne contient aucun hôte',
    !readFileSync(path.join(racine, 'services/integratedApi/opensign/openSignTransport.js'), 'utf8')
      .includes('opensignlabs.com'));
}

finish();
