// STRIPE — fondation du plan de contrôle (L6.1).
//
// Ce que cette suite prouve :
//
//   CONTRACTS            entrées invalides refusées, montants et monde exclus
//   CREDENTIAL_OWNERSHIP aucune clé ne vient du projet, aucune ne sort
//   ENVIRONMENT_OWNERSHIP le projet ne peut pas sélectionner LIVE
//   COMMERCIAL_READINESS  écriture financière bloquée hors ouverture
//   IDEMPOTENCE           une écriture sans clé est refusée AVANT l'appel
//   UNKNOWN               un silence sur une écriture ne se rejoue jamais seul
//   PROVIDER_ERRORS       refus Stripe normalisés, conflits d'idempotence à part
//   NO_SECRETS            ni clé ni corps brut dans les erreurs et le journal
//   RESOURCE_OWNERSHIP    fail closed tant que le lien projet ↔ ressource manque
//
// Aucun réseau : le fournisseur est simulé, et l'on compte ses appels.
import {
  check, finish, section, setTestEnv,
} from './helpers/harness.js';

setTestEnv();

const capabilities = await import('../backend/src/services/integratedApi/stripe/stripeCapabilities.js');
const transport = await import('../backend/src/services/integratedApi/stripe/stripeTransport.js');
const ownership = await import('../backend/src/services/integratedApi/stripe/stripeResourceOwnership.js');
const providerRegistry = await import('../backend/src/services/integratedApi/providerRegistry.js');
const environment = await import('../backend/src/services/integratedApi/environment.js');
const commercial = await import('../backend/src/services/integratedApi/commercialReadiness.js');

const { STRIPE_CAPABILITIES, STRIPE_CAPABILITY_CODES } = capabilities;
const { TRANSPORT_CODES, OUTCOMES } = transport;

/** Sentinelle : une occurrence hors du coffre est une fuite, jamais un hasard. */
const CLE = 'sk_test_L61SENTINELLESTRIPEJAMAISAILLEURS0001';
const CREDENTIALS = Object.freeze({ secretKey: CLE, baseUrl: 'https://faux-stripe.test' });

const OP = 'op-l61-0000000000000001';

/** Faux Stripe : note ce qu'on lui envoie, y compris la clé d'idempotence. */
function fournisseur(routes) {
  const appels = [];
  const impl = async (url, options) => {
    const chemin = url.replace('https://faux-stripe.test', '');
    appels.push({
      chemin,
      methode: options.method,
      cle: options.headers?.Authorization ?? null,
      idempotency: options.headers?.['Idempotency-Key'] ?? null,
      version: options.headers?.['Stripe-Version'] ?? null,
      corps: options.body ?? null,
    });
    const route = routes[`${options.method} ${chemin.split('?')[0]}`] ?? routes[options.method] ?? null;
    if (typeof route === 'function') return route();
    return route ?? reponse(404, { error: { message: 'route non simulée' } });
  };
  impl.appels = appels;
  return impl;
}

const reponse = (status, body) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: { get: (h) => (h === 'request-id' ? 'req_test_0001' : null) },
  text: async () => JSON.stringify(body ?? {}),
});

/* ========================================================================== */
section('1. CONTRACTS — ce qu’une capacité refuse avant tout appel');
/* ========================================================================== */
{
  check('cinq capacités contractualisées', STRIPE_CAPABILITY_CODES.length === 5);
  const problemes = capabilities.validateStripeCapabilities();
  check(`catalogue cohérent (${problemes.length} problème(s))`, problemes.length === 0);
  problemes.forEach((p) => console.error(`      · ${p}`));

  /**
   * UNE SEULE est servie (L6.2B), et c'est exactement celle qui n'exige la
   * possession d'aucun objet Stripe préexistant. Les quatre autres attendent un
   * lien vers un client ou un abonnement que le Panel n'a jamais créé — les
   * servir reviendrait à faire confiance à l'identifiant que le projet fournit.
   */
  const servies = STRIPE_CAPABILITY_CODES.filter((c) => STRIPE_CAPABILITIES[c].migrated);
  check('deux capacités servies', servies.length === 2);
  check('…l’ouverture de session', servies.includes('billing.checkout.create'));
  check('…et sa lecture (L6.2C)', servies.includes('billing.checkout.retrieve'));
  /**
   * L6.2C lève la règle « aucune capacité servie n'exige de ressource
   * préexistante » — mais seulement pour la famille que le Panel CRÉE
   * lui-même. La lecture exige de posséder une session ; elle ne le peut que
   * parce que L6.2B en lie à chaque création.
   */
  check('la lecture EXIGE la preuve d’appartenance',
    STRIPE_CAPABILITIES['billing.checkout.retrieve'].requiresResourceOwnership === true);
  check('…et porte bien la famille SESSION',
    STRIPE_CAPABILITIES['billing.checkout.retrieve'].resourceKind === 'CHECKOUT_SESSION');
  check('aucune capacité servie n’exige une famille que le Panel ne crée pas',
    servies.every((c) => {
      const d = STRIPE_CAPABILITIES[c];
      return !d.requiresResourceOwnership || d.resourceKind === 'CHECKOUT_SESSION';
    }));
  check('chaque capacité NON servie porte une note de migration',
    STRIPE_CAPABILITY_CODES
      .filter((c) => !STRIPE_CAPABILITIES[c].migrated)
      .every((c) => Boolean(STRIPE_CAPABILITIES[c].migrationNote)));

  // Le remboursement n'est PAS contractualisé : aucun code du parc ne l'émet.
  check('billing.refund n’est PAS déclarée (aucun usage réel)',
    !capabilities.isStripeCapability('billing.refund'));
  // Ni les primitives internes de tarification.
  for (const absent of ['billing.product.create', 'billing.price.create', 'billing.portal.create']) {
    check(`${absent} n’est pas contractualisée`, !capabilities.isStripeCapability(absent));
  }

  const liste = STRIPE_CAPABILITIES['billing.invoice.list'].inputSchema;
  check('facture : client OU abonnement, jamais les deux',
    liste.safeParse({ customerId: 'cus_1', subscriptionId: 'sub_1', operationId: OP }).success === false);
  check('facture : ni l’un ni l’autre → refusé',
    liste.safeParse({ operationId: OP }).success === false);
  check('facture : un client seul → accepté',
    liste.safeParse({ customerId: 'cus_1', operationId: OP }).success === true);
  check('identifiant de mauvaise famille → refusé',
    liste.safeParse({ customerId: 'sub_1', operationId: OP }).success === false);

  const creation = STRIPE_CAPABILITIES['billing.checkout.create'].inputSchema;
  check('checkout : operationId court refusé',
    creation.safeParse({ contractRef: 'CTR-1', paymentType: 'LAUNCH_FEE', successUrl: 'https://a.fr', cancelUrl: 'https://a.fr', operationId: 'trop-court' }).success === false);
  check('checkout : URL non absolue refusée',
    creation.safeParse({ contractRef: 'CTR-1', paymentType: 'LAUNCH_FEE', successUrl: '/retour', cancelUrl: 'https://a.fr', operationId: OP }).success === false);
  check('checkout : type de paiement hors énumération refusé',
    creation.safeParse({ contractRef: 'CTR-1', paymentType: 'DONATION', successUrl: 'https://a.fr', cancelUrl: 'https://a.fr', operationId: OP }).success === false);
  check('checkout : entrée valide acceptée',
    creation.safeParse({ contractRef: 'CTR-1', paymentType: 'LAUNCH_FEE', successUrl: 'https://a.fr', cancelUrl: 'https://b.fr', operationId: OP }).success === true);
}

/* ========================================================================== */
section('2. LE PROJET NE DÉCIDE NI DU MONDE, NI DU MONTANT, NI DE LA CLÉ');
/* ========================================================================== */
{
  const interdits = [
    'mode', 'environment', 'livemode', 'stripeEnvironment',
    'secretKey', 'apiKey', 'credentials', 'account', 'stripeAccount', 'baseUrl',
    'amount', 'unitAmount', 'price', 'currency',
  ];
  for (const code of STRIPE_CAPABILITY_CODES) {
    const schema = STRIPE_CAPABILITIES[code].inputSchema;
    const base = code === 'billing.checkout.create'
      ? { contractRef: 'CTR-1', paymentType: 'LAUNCH_FEE', successUrl: 'https://a.fr', cancelUrl: 'https://b.fr', operationId: OP }
      : code === 'billing.invoice.list' ? { customerId: 'cus_1', operationId: OP }
        : code === 'billing.checkout.retrieve' ? { checkoutSessionId: 'cs_1', operationId: OP }
          : { subscriptionId: 'sub_1', operationId: OP };
    check(`${code} : l’entrée nominale est acceptée`, schema.safeParse(base).success === true);
    const refuses = interdits.filter((champ) => schema.safeParse({ ...base, [champ]: 'x' }).success === false);
    check(`${code} : les ${interdits.length} champs interdits sont refusés`, refuses.length === interdits.length);
  }

  // Le monde reste au plan de contrôle, et Stripe est à portée ENVIRONMENT.
  check('Stripe est à portée ENVIRONMENT',
    providerRegistry.getProviderDefinition('STRIPE').scope === providerRegistry.SCOPES.ENVIRONMENT);
  check('l’environnement résolu vient du runtime',
    environment.resolveEnvironmentForProvider('STRIPE') === 'TEST');
  let refus = null;
  try { environment.assertEnvironmentServed('PROD'); } catch (err) { refus = err; }
  check('demander PROD depuis un Panel TEST → refus',
    String(refus?.code) === environment.INTEGRATED_API_ENVIRONMENT_MISMATCH);

  // La clé porte son monde : c'est la vérification la plus directe qui soit.
  const role = providerRegistry.credentialRole('STRIPE', 'secretKey');
  check('le rôle de clé secrète attend un préfixe par environnement',
    role.prefixByEnvironment?.TEST === 'sk_test_' && role.prefixByEnvironment?.PROD === 'sk_live_');
}

/* ========================================================================== */
section('3. COMMERCIAL READINESS — l’écriture financière avant l’ouverture');
/* ========================================================================== */
{
  const financieres = STRIPE_CAPABILITY_CODES.filter((c) => STRIPE_CAPABILITIES[c].financial);
  check('deux écritures financières contractualisées', financieres.length === 2);

  for (const code of financieres) {
    const verdict = commercial.canExecute({ capability: code, commercialState: 'PREOPENING' });
    check(`${code} : bloquée en pré-ouverture`, verdict.decision === commercial.DECISION.BLOCKED_PREOPENING);
    const ouvert = commercial.canExecute({ capability: code, commercialState: 'LIVE' });
    check(`${code} : autorisée une fois ouverte`, ouvert.decision === commercial.DECISION.ALLOWED);
  }

  // Les LECTURES ne sont PAS bloquées : diagnostiquer et réconcilier doivent
  // rester possibles avant l'ouverture — c'est même ce qu'on fait à ce moment-là.
  const lectures = STRIPE_CAPABILITY_CODES.filter((c) => !STRIPE_CAPABILITIES[c].financial);
  for (const code of lectures) {
    const connu = commercial.CAPABILITY_EFFECTS[code] !== undefined;
    if (!connu) {
      check(`${code} : effet proposé READ_ONLY (câblage L1.75 attendu)`,
        STRIPE_CAPABILITIES[code].effectNature === commercial.EFFECT.READ_ONLY);
      continue;
    }
    check(`${code} : autorisée en pré-ouverture`,
      commercial.canExecute({ capability: code, commercialState: 'PREOPENING' }).decision === commercial.DECISION.ALLOWED);
  }
}

/* ========================================================================== */
section('4. IDEMPOTENCE — une écriture sans clé n’atteint pas Stripe');
/* ========================================================================== */
{
  const jamais = fournisseur({});
  const sansCle = await transport.createCheckoutSession({
    credentials: CREDENTIALS, params: { mode: 'payment' }, fetchImpl: jamais,
  }).catch((err) => err);
  check('écriture sans clé d’idempotence → refusée', sansCle.code === TRANSPORT_CODES.INPUT_INVALID);
  check('…AVANT tout appel réseau', jamais.appels.length === 0);

  // La même clé doit voyager telle quelle, sans être régénérée.
  const f = fournisseur({ 'POST /v1/checkout/sessions': () => reponse(200, { id: 'cs_1', url: 'https://pay.test/1' }) });
  await transport.createCheckoutSession({
    credentials: CREDENTIALS, params: { mode: 'payment' }, idempotencyKey: OP, fetchImpl: f,
  });
  await transport.createCheckoutSession({
    credentials: CREDENTIALS, params: { mode: 'payment' }, idempotencyKey: OP, fetchImpl: f,
  });
  check('deux appels du même acte portent LA MÊME clé',
    f.appels.length === 2 && f.appels[0].idempotency === OP && f.appels[1].idempotency === OP);
  check('la version d’API est épinglée sur chaque appel',
    f.appels.every((a) => a.version === transport.STRIPE_API_VERSION));
  check('le corps est encodé en form, pas en JSON',
    typeof f.appels[0].corps === 'string' && f.appels[0].corps.includes('mode=payment'));

  // Une lecture n'exige aucune clé — et n'en envoie pas.
  const lecture = fournisseur({ 'GET /v1/invoices': () => reponse(200, { data: [], has_more: false }) });
  await transport.listInvoices({ credentials: CREDENTIALS, customer: 'cus_1', fetchImpl: lecture });
  check('une lecture n’envoie aucune clé d’idempotence', lecture.appels[0].idempotency === null);
}

/* ========================================================================== */
section('5. UNKNOWN — le silence ne se rejoue jamais seul');
/* ========================================================================== */
{
  const abandon = () => { const e = new Error('aborted'); e.name = 'AbortError'; throw e; };

  const ecriture = await transport.createCheckoutSession({
    credentials: CREDENTIALS, params: { mode: 'payment' }, idempotencyKey: OP, fetchImpl: abandon,
  }).catch((err) => err);
  check('écriture : délai dépassé → TIMEOUT', ecriture.code === TRANSPORT_CODES.TIMEOUT);
  check('écriture : issue UNKNOWN, jamais FAILED', ecriture.outcome === OUTCOMES.UNKNOWN);
  check('écriture : rejeu NON déclaré sûr', ecriture.replaySafe === false);
  const decision = transport.describeRetryDecision(ecriture);
  check('écriture : aucune reprise automatique', decision.automatic === false);
  check('…et la convergence passe par la clé, pas par un nouvel acte',
    decision.reason === 'ISSUE_INCONNUE_CONVERGENCE_PAR_CLÉ');

  const lecture = await transport.listInvoices({
    credentials: CREDENTIALS, customer: 'cus_1', fetchImpl: abandon,
  }).catch((err) => err);
  check('lecture : issue FAILED (rien n’a bougé)', lecture.outcome === OUTCOMES.FAILED);
  check('lecture : rejeu sans risque', lecture.replaySafe === true);

  // Une écriture n'est JAMAIS réessayée, même sur 5xx : Stripe a pu encaisser.
  let tentatives = 0;
  await transport.createCheckoutSession({
    credentials: CREDENTIALS, params: {}, idempotencyKey: OP,
    fetchImpl: async () => { tentatives += 1; return reponse(503, { error: { message: 'indispo' } }); },
  }).catch(() => {});
  check('écriture 5xx : une seule tentative', tentatives === 1);

  let lectures = 0;
  await transport.listInvoices({
    credentials: CREDENTIALS, customer: 'cus_1',
    fetchImpl: async () => { lectures += 1; return reponse(503, { error: { message: 'indispo' } }); },
  }).catch(() => {});
  check('lecture 5xx : réessayée', lectures > 1);

  // 2xx illisible sur une écriture : indécidable, pas échoué.
  const illisible = await transport.createCheckoutSession({
    credentials: CREDENTIALS, params: {}, idempotencyKey: OP,
    fetchImpl: async () => ({ ok: true, status: 200, headers: { get: () => null }, text: async () => 'pas du json' }),
  }).catch((err) => err);
  check('2xx illisible sur une écriture → UNKNOWN', illisible.outcome === OUTCOMES.UNKNOWN);
}

/* ========================================================================== */
section('6. CONFLITS D’IDEMPOTENCE — les deux cas, et leur différence');
/* ========================================================================== */
{
  // Même clé, requête EN COURS : on ne sait pas si elle aboutira.
  const enCours = await transport.createCheckoutSession({
    credentials: CREDENTIALS, params: {}, idempotencyKey: OP,
    fetchImpl: async () => reponse(409, { error: { code: 'idempotency_key_in_use', message: 'in use' } }),
  }).catch((err) => err);
  check('clé déjà en cours → IDEMPOTENCY_CONFLICT', enCours.code === TRANSPORT_CODES.IDEMPOTENCY_CONFLICT);
  check('…issue UNKNOWN : l’autre appel peut aboutir', enCours.outcome === OUTCOMES.UNKNOWN);
  check('…donc aucun rejeu avec une clé neuve', enCours.replaySafe === false);

  // Même clé, paramètres DIFFÉRENTS : défaut de construction chez nous.
  const divergent = await transport.createCheckoutSession({
    credentials: CREDENTIALS, params: {}, idempotencyKey: OP,
    fetchImpl: async () => reponse(400, { error: { code: 'idempotency_error', message: 'reused' } }),
  }).catch((err) => err);
  check('clé réutilisée avec d’autres paramètres → IDEMPOTENCY_CONFLICT',
    divergent.code === TRANSPORT_CODES.IDEMPOTENCY_CONFLICT);
  check('…issue FAILED : rien n’a été créé', divergent.outcome === OUTCOMES.FAILED);
}

/* ========================================================================== */
section('7. ERREURS FOURNISSEUR — normalisées, et sans rien relayer');
/* ========================================================================== */
{
  const cas = [
    [401, 'UNAUTHORIZED'], [403, 'UNAUTHORIZED'], [404, 'NOT_FOUND'],
    [400, 'REJECTED'], [402, 'REJECTED'], [422, 'REJECTED'], [429, 'RATE_LIMITED'],
  ];
  for (const [status, attendu] of cas) {
    const err = await transport.retrieveSubscription({
      credentials: CREDENTIALS, subscriptionId: 'sub_1',
      fetchImpl: async () => reponse(status, { error: { message: 'non', code: 'x' } }),
    }).catch((e) => e);
    check(`${status} → ${attendu}`, err.code === TRANSPORT_CODES[attendu]);
    check(`${status} → issue FAILED`, err.outcome === OUTCOMES.FAILED);
  }

  // Le `request-id` est conservé : c'est la seule chose que le support demande.
  const avecId = await transport.retrieveSubscription({
    credentials: CREDENTIALS, subscriptionId: 'sub_1',
    fetchImpl: async () => reponse(404, { error: { message: 'absent' } }),
  }).catch((e) => e);
  check('le request-id de Stripe est conservé', avecId.requestId === 'req_test_0001');

  const sansCle = await transport.listInvoices({ credentials: { baseUrl: 'https://x.test' }, customer: 'cus_1' })
    .catch((e) => e);
  check('clé absente → MISSING_CREDENTIALS', sansCle.code === TRANSPORT_CODES.MISSING_CREDENTIALS);
}

/* ========================================================================== */
section('8. AUCUN SECRET NE SORT');
/* ========================================================================== */
{
  const journal = [];
  const original = console.log;
  console.log = (...args) => { journal.push(args.join(' ')); };
  let resultat;
  try {
    resultat = await transport.createCheckoutSession({
      credentials: CREDENTIALS, params: { mode: 'payment' }, idempotencyKey: OP,
      fetchImpl: async () => reponse(200, { id: 'cs_123', url: 'https://pay.test/1' }),
    });
  } finally {
    console.log = original;
  }
  check('aucune clé dans le résultat', !JSON.stringify(resultat).includes(CLE));
  check('aucune clé dans le journal', !journal.join('\n').includes(CLE) && !/sk_test_/.test(journal.join('\n')));
  check('le journal nomme l’objet et la requête',
    journal.join('\n').includes('cs_123') && journal.join('\n').includes('req_test_0001'));

  // Stripe échoue en citant la clé : elle ne doit pas ressortir.
  const bavard = await transport.retrieveSubscription({
    credentials: CREDENTIALS, subscriptionId: 'sub_1',
    fetchImpl: async () => reponse(401, { error: { message: `Invalid key ${CLE}` } }),
  }).catch((e) => e);
  check('le message d’erreur ne recopie pas la clé', !bavard.message.includes(CLE));
  check('…et reste borné', bavard.message.length < 400);
}

/* ========================================================================== */
section('9. RESOURCE_OWNERSHIP — fail closed tant que le lien manque');
/* ========================================================================== */
{
  const { STRIPE_RESOURCE_KINDS: KINDS, OWNERSHIP_CODES: CODES } = ownership;

  check('un identifiant de la bonne famille est reconnu',
    ownership.looksLikeResource(KINDS.SUBSCRIPTION, 'sub_123') === true);
  check('…et un identifiant d’une autre famille refusé',
    ownership.looksLikeResource(KINDS.SUBSCRIPTION, 'cus_123') === false);

  /**
   * DEPUIS L6.2A, LE DÉFAUT EST LE REGISTRE.
   *
   * En L6.1, aucun résolveur n'existait et l'absence valait refus. Le registre
   * fait désormais autorité — c'est `stripe-resource-ownership` qui l'éprouve,
   * avec une base. Cette suite-ci reste SANS base : elle décrit le CONTRAT, et
   * un contrat ne se vérifie pas en interrogeant une collection.
   *
   * Ce qui compte ici est donc que le résolveur reste INJECTABLE — sans quoi
   * aucun test ne pourrait éprouver la décision sans monter une base — et que
   * l'absence de lien vaille toujours refus.
   */
  const sansLien = await ownership.describeResourceOwnership({
    projectId: 'projet-a', environment: 'TEST', kind: KINDS.SUBSCRIPTION, resourceId: 'sub_123',
    lookup: async () => null,
  });
  check('aucun lien connu → NO_BINDING', sansLien.code === CODES.NO_BINDING);
  check('…et donc refusé', sansLien.allowed === false);

  // AVEC un résolveur, le lien décide — et il ne vient jamais du demandeur.
  const lookup = async ({ resourceId }) => (
    resourceId === 'sub_a' ? { projectId: 'projet-a', environment: 'TEST' }
      : resourceId === 'sub_b' ? { projectId: 'projet-b', environment: 'TEST' }
        : resourceId === 'sub_prod' ? { projectId: 'projet-a', environment: 'PROD' }
          : null);

  const sien = await ownership.describeResourceOwnership({
    projectId: 'projet-a', environment: 'TEST', kind: KINDS.SUBSCRIPTION, resourceId: 'sub_a', lookup,
  });
  check('sa propre ressource → autorisée', sien.allowed === true);

  const autrui = await ownership.describeResourceOwnership({
    projectId: 'projet-a', environment: 'TEST', kind: KINDS.SUBSCRIPTION, resourceId: 'sub_b', lookup,
  });
  check('la ressource d’un autre → NOT_OWNED', autrui.code === CODES.NOT_OWNED);
  check('…et le refus ne dit PAS à qui elle appartient', autrui.boundProjectId === null);

  const autreMonde = await ownership.describeResourceOwnership({
    projectId: 'projet-a', environment: 'TEST', kind: KINDS.SUBSCRIPTION, resourceId: 'sub_prod', lookup,
  });
  check('sa ressource, mais dans l’autre monde → ENVIRONMENT_MISMATCH',
    autreMonde.code === CODES.ENVIRONMENT_MISMATCH);

  // La route « le projet déclare » est nommée pour être refusée.
  check('la déclaration par le projet est explicitement refusée',
    ownership.BINDING_ROUTES.DECLARED_BY_PROJECT.startsWith('REFUSED'));

  const readiness = ownership.describeBindingReadiness();
  // L6.2A a livré le registre : l'outil existe. Ce qui reste fermé l'est par
  // absence de LIEN pour une ressource donnée, pas par absence d'outil.
  check('le registre est disponible', readiness.available === true);
  check('…et plus aucune famille n’est bloquée faute d’outil', readiness.blocks.length === 0);

  // Chaque capacité qui désigne une ressource déclare la famille attendue.
  for (const code of STRIPE_CAPABILITY_CODES) {
    const definition = STRIPE_CAPABILITIES[code];
    if (!definition.requiresResourceOwnership) continue;
    check(`${code} : famille de ressource déclarée`,
      ownership.STRIPE_RESOURCE_KIND_VALUES.includes(definition.resourceKind));
  }
  // La création de session ne possède rien : elle CRÉE.
  check('billing.checkout.create n’exige aucune ressource préexistante',
    STRIPE_CAPABILITIES['billing.checkout.create'].requiresResourceOwnership === false);
}

finish();
