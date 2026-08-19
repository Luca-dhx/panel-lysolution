// HOSTINGER — plan de contrôle, portée globale et appartenance (L9).
//
// Ce que cette suite prouve, invariant par invariant :
//
//   HOSTINGER_IS_PANEL_GLOBAL              un compte, pas de monde
//   TEST_AND_PROD_SHARE_GLOBAL_CREDENTIAL  deux projets, un seul jeu
//   PROJECT_CANNOT_SELECT_CREDENTIAL       ni zone, ni jeton, ni environnement
//   PROJECT_A_CANNOT_TOUCH_RESOURCE_B      l'appartenance vient du registre
//   NO_SECRET_BRIDGE                       le jeton ne sort ni en réponse ni en journal
//   TIMEOUT_SAFE                           un silence sur une écriture est INDÉCIDABLE
//   WRITE_AUDITED                          une écriture nomme sa ressource et son corrélat
//   DEPLOYMENT_ENGINE_REMAINS_AUTHORITY    l'adaptateur ne planifie rien
//
// Aucun réseau : le fournisseur est simulé, et l'on compte ses appels.
import {
  check, connectTestDatabase, finish, section, setTestEnv,
  startMemoryMongo, stopMemoryMongo,
} from './helpers/harness.js';

setTestEnv();
await startMemoryMongo();
await connectTestDatabase();

const capabilities = await import('../backend/src/services/integratedApi/hostinger/hostingerCapabilities.js');
const transport = await import('../backend/src/services/integratedApi/hostinger/hostingerTransport.js');
const adapters = await import('../backend/src/services/integratedApi/hostinger/hostingerAdapters.js');
const ownership = await import('../backend/src/services/capabilities/resourceOwnership.js');
const providerRegistry = await import('../backend/src/services/integratedApi/providerRegistry.js');
const environment = await import('../backend/src/services/integratedApi/environment.js');
const errors = await import('../backend/src/services/capabilities/capabilityErrors.js');
const { default: PanelProjectDestination, DESTINATION_STATUS } = await import(
  '../backend/src/models/PanelProjectDestination.model.js'
);

const { CAPABILITY_ERROR_CODES: CODES } = errors;
const { HOSTINGER_ADAPTERS } = adapters;

/** Sentinelle : une occurrence hors du coffre est une fuite, jamais un hasard. */
const JETON = 'HOSTINGER-L9-SENTINELLE-JAMAIS-AILLEURS-0001';
const CREDENTIALS = Object.freeze({ apiToken: JETON, baseUrl: 'https://faux-hostinger.test' });

/** Faux Hostinger : compte les appels et note ce qu'on lui envoie. */
function fournisseur(routes) {
  const appels = [];
  const impl = async (url, options) => {
    const chemin = url.replace('https://faux-hostinger.test', '');
    appels.push({
      chemin,
      methode: options.method,
      jeton: options.headers?.Authorization ?? null,
      corps: options.body ? JSON.parse(options.body) : null,
    });
    const route = routes[`${options.method} ${chemin}`] ?? routes[options.method] ?? null;
    if (typeof route === 'function') return route();
    if (!route) return reponse(404, { message: 'route non simulée' });
    return route;
  };
  impl.appels = appels;
  return impl;
}

const reponse = (status, body) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: { get: () => null },
  text: async () => JSON.stringify(body ?? {}),
});

const PORTEFEUILLE = [{ domain: 'garage-a.fr' }, { domain: 'garage-b.fr' }, { domain: 'partage.fr' }];

/** Contexte d'invocation minimal — ce que la passerelle construit. */
const contexte = (projectId, env = 'TEST') => ({ projectId, environment: env, requestId: 'req-1' });

async function destination(projectId, host, { environment: env = 'TEST', status = DESTINATION_STATUS.ACTIVE } = {}) {
  await PanelProjectDestination.create({
    destinationId: `dest-${projectId}-${host}`,
    projectId,
    environment: env,
    host,
    status,
    announcedAt: new Date().toISOString(),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
}

async function invoquer(code, { projectId, input, fetchImpl, env = 'TEST' }) {
  const definition = capabilities.HOSTINGER_CAPABILITIES[code];
  const parsed = definition.inputSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, code: CODES.INPUT_INVALID, issues: parsed.error.issues.map((i) => i.path.join('.')) };
  }
  try {
    const raw = await HOSTINGER_ADAPTERS[code]({
      definition, context: contexte(projectId, env), credentials: CREDENTIALS, input: parsed.data, fetchImpl,
    });
    const out = definition.outputSchema.safeParse(raw);
    return { ok: out.success, data: out.success ? out.data : null, contractViolation: !out.success };
  } catch (err) {
    return { ok: false, code: err?.code ?? null, error: err };
  }
}

/* ========================================================================== */
section('1. HOSTINGER_IS_PANEL_GLOBAL — un compte, aucun monde');
/* ========================================================================== */
{
  const definition = providerRegistry.getProviderDefinition('HOSTINGER');
  check('portée PANEL_GLOBAL', definition.scope === providerRegistry.SCOPES.PANEL_GLOBAL);
  check('ni TEST ni PROD ne sont supportés', !definition.supportsTest && !definition.supportsProd);
  check('un seul jeu à provisionner',
    providerRegistry.environmentsFor('HOSTINGER').length === 1
    && providerRegistry.environmentsFor('HOSTINGER')[0] === null);

  // LA résolution : Hostinger n'a PAS d'environnement fournisseur.
  check('l’environnement résolu est null', environment.resolveEnvironmentForProvider('HOSTINGER') === null);
  // …et un null n'est pas un refus : `assertEnvironmentServed` le laisse passer.
  check('null traverse la garde d’environnement sans refus',
    environment.assertEnvironmentServed(null) === null);

  // Le rôle lui-même n'est pas scopé par environnement.
  check('le jeton n’est pas scopé par environnement',
    providerRegistry.credentialRole('HOSTINGER', 'apiToken').environmentScoped === false);

  const problemes = capabilities.validateHostingerCapabilities();
  check(`catalogue cohérent (${problemes.length} problème(s))`, problemes.length === 0);
  problemes.forEach((p) => console.error(`      · ${p}`));
}

/* ========================================================================== */
section('2. TEST_AND_PROD_SHARE_GLOBAL_CREDENTIAL — deux projets, un jeu');
/* ========================================================================== */
{
  await destination('projet-test', 'garage-a.fr', { environment: 'TEST' });
  await destination('projet-prod', 'garage-b.fr', { environment: 'PROD' });

  const routes = {
    'GET /api/domains/v1/portfolio': () => reponse(200, PORTEFEUILLE),
  };

  const fA = fournisseur(routes);
  await invoquer('dns.zone.resolve', { projectId: 'projet-test', input: { hostname: 'garage-a.fr', operationId: 'op-000001' }, fetchImpl: fA });
  const fB = fournisseur(routes);
  await invoquer('dns.zone.resolve', { projectId: 'projet-prod', input: { hostname: 'garage-b.fr', operationId: 'op-000002' }, fetchImpl: fB, env: 'PROD' });

  check('le projet TEST utilise le jeton global', fA.appels[0].jeton === `Bearer ${JETON}`);
  check('le projet PROD utilise LE MÊME jeton', fB.appels[0].jeton === `Bearer ${JETON}`);
  // Aucun jeu « Hostinger TEST » n'existe : le chercher échouerait toujours.
  check('aucun suffixe d’environnement dans l’URL appelée',
    fA.appels[0].chemin === '/api/domains/v1/portfolio' && !fA.appels[0].chemin.includes('TEST'));
}

/* ========================================================================== */
section('3. PROJECT_CANNOT_SELECT_CREDENTIAL — ni zone, ni jeton, ni monde');
/* ========================================================================== */
{
  const jamais = fournisseur({});
  const interdits = [
    ['zone', { hostname: 'garage-a.fr', zone: 'partage.fr', operationId: 'op-000003' }],
    ['domain', { hostname: 'garage-a.fr', domain: 'partage.fr', operationId: 'op-000003' }],
    ['apiToken', { hostname: 'garage-a.fr', apiToken: 'volé', operationId: 'op-000003' }],
    ['baseUrl', { hostname: 'garage-a.fr', baseUrl: 'https://evil.test', operationId: 'op-000003' }],
    ['environment', { hostname: 'garage-a.fr', environment: 'PROD', operationId: 'op-000003' }],
    ['provider', { hostname: 'garage-a.fr', provider: 'STRIPE', operationId: 'op-000003' }],
  ];
  for (const [champ, input] of interdits) {
    const r = await invoquer('dns.zone.resolve', { projectId: 'projet-test', input, fetchImpl: jamais });
    check(`« ${champ} » dans l’entrée → refusé`, r.ok === false && r.code === CODES.INPUT_INVALID);
  }
  check('aucun appel fournisseur sur une entrée refusée', jamais.appels.length === 0);

  // La zone n'est JAMAIS une entrée : c'est elle qui porte le pouvoir.
  for (const code of capabilities.HOSTINGER_CAPABILITY_CODES) {
    const shape = capabilities.HOSTINGER_CAPABILITIES[code].inputSchema.shape;
    check(`${code} : la ressource est désignée par « hostname »`, Object.hasOwn(shape, 'hostname'));
    check(`${code} : « zone » n’est pas une entrée`, !Object.hasOwn(shape, 'zone'));
  }
}

/* ========================================================================== */
section('4. PROJECT_A_CANNOT_TOUCH_RESOURCE_B — l’appartenance fait foi');
/* ========================================================================== */
{
  const routes = {
    'GET /api/domains/v1/portfolio': () => reponse(200, PORTEFEUILLE),
    'PUT /api/dns/v1/zones/garage-b.fr': () => reponse(200, {}),
    'PUT /api/dns/v1/zones/garage-a.fr': () => reponse(200, {}),
  };

  // A tente d'écrire chez B.
  const f = fournisseur(routes);
  const vol = await invoquer('dns.record.ensure', {
    projectId: 'projet-test',
    input: { hostname: 'garage-b.fr', type: 'A', content: '1.2.3.4', operationId: 'op-000010' },
    fetchImpl: f,
  });
  check('A écrivant chez B → refusé', vol.ok === false);
  check('…code CAPABILITY_RESOURCE_NOT_OWNED', vol.code === CODES.RESOURCE_NOT_OWNED);
  check('…AVANT tout appel fournisseur', f.appels.length === 0);
  check('…et le refus ne révèle PAS ce que A possède',
    !vol.error.message.includes('garage-a.fr'));

  // Un sous-domaine de son propre hôte : autorisé.
  const f2 = fournisseur(routes);
  const propre = await invoquer('dns.record.ensure', {
    projectId: 'projet-test',
    input: { hostname: 'manager.garage-a.fr', type: 'A', content: '1.2.3.4', operationId: 'op-000011' },
    fetchImpl: f2,
  });
  check('son propre sous-domaine → accepté', propre.ok === true);
  check('…écrit dans SA zone', f2.appels.at(-1).chemin === '/api/dns/v1/zones/garage-a.fr');
  check('…avec le nom RELATIF, pas le FQDN', f2.appels.at(-1).corps.zone[0].name === 'manager');

  // La frontière de label : `notgarage-a.fr` n'est pas couvert par `garage-a.fr`.
  check('la couverture s’arrête à une frontière de label',
    ownership.isCoveredBy('manager.garage-a.fr', 'garage-a.fr') === true
    && ownership.isCoveredBy('notgarage-a.fr', 'garage-a.fr') === false);

  // Une destination RETIRÉE ne fonde plus aucun droit.
  await destination('projet-ancien', 'ancien.fr', { status: DESTINATION_STATUS.RETIRED });
  const perime = await invoquer('dns.record.ensure', {
    projectId: 'projet-ancien',
    input: { hostname: 'ancien.fr', type: 'A', content: '1.2.3.4', operationId: 'op-000012' },
    fetchImpl: fournisseur(routes),
  });
  check('une destination RETIRÉE ne fonde plus de droit', perime.code === CODES.RESOURCE_NOT_OWNED);

  // Un projet sans destination ne possède rien.
  const sans = await invoquer('dns.zone.resolve', {
    projectId: 'projet-inconnu',
    input: { hostname: 'garage-a.fr', operationId: 'op-000013' },
    fetchImpl: fournisseur(routes),
  });
  check('un projet sans destination ne possède rien', sans.code === CODES.RESOURCE_NOT_OWNED);
}

/* ========================================================================== */
section('5. La lecture ne livre PAS la zone des autres');
/* ========================================================================== */
{
  // Deux projets partagent la même zone : chacun ne doit voir que ses hôtes.
  await destination('projet-x', 'x.partage.fr');
  await destination('projet-y', 'y.partage.fr');

  const enregistrements = [
    { name: 'x', type: 'A', ttl: 300, records: [{ content: '10.0.0.1' }] },
    { name: 'y', type: 'A', ttl: 300, records: [{ content: '10.0.0.2' }] },
    { name: '*', type: 'A', ttl: 300, records: [{ content: '10.0.0.9' }] },
    { name: 'secret-interne', type: 'A', ttl: 300, records: [{ content: '10.0.0.3' }] },
  ];
  const routes = {
    'GET /api/domains/v1/portfolio': () => reponse(200, PORTEFEUILLE),
    'GET /api/dns/v1/zones/partage.fr': () => reponse(200, enregistrements),
  };

  const r = await invoquer('dns.records.read', {
    projectId: 'projet-x',
    input: { hostname: 'x.partage.fr', operationId: 'op-000020' },
    fetchImpl: fournisseur(routes),
  });
  check('la lecture réussit', r.ok === true);
  const noms = r.data.records.map((rec) => rec.name).sort();
  check('X voit son propre enregistrement', noms.includes('x'));
  check('…et la wildcard, dont le moteur a besoin', noms.includes('*'));
  check('…mais PAS celui de Y', !noms.includes('y'));
  check('…ni l’enregistrement interne', !noms.includes('secret-interne'));
  check('…et rien d’autre', noms.length === 2);
}

/* ========================================================================== */
section('6. NO_SECRET_BRIDGE — le jeton ne sort par aucune porte');
/* ========================================================================== */
{
  const routes = {
    'GET /api/domains/v1/portfolio': () => reponse(200, PORTEFEUILLE),
    'PUT /api/dns/v1/zones/garage-a.fr': () => reponse(200, {}),
  };
  const journal = [];
  const original = console.log;
  console.log = (...args) => { journal.push(args.join(' ')); };
  let ecriture;
  try {
    ecriture = await invoquer('dns.record.ensure', {
      projectId: 'projet-test',
      input: { hostname: 'garage-a.fr', type: 'A', content: '1.2.3.4', ttl: 300, operationId: 'op-000030' },
      fetchImpl: fournisseur(routes),
    });
  } finally {
    console.log = original;
  }

  check('l’écriture réussit', ecriture.ok === true);
  check('aucun jeton dans la sortie', !JSON.stringify(ecriture.data).includes(JETON));
  check('aucune URL de fournisseur dans la sortie',
    !JSON.stringify(ecriture.data).includes('faux-hostinger.test'));
  check('aucun jeton dans le journal', !journal.join('\n').includes(JETON));
  check('le journal nomme la zone et l’enregistrement',
    journal.join('\n').includes('garage-a.fr') && journal.join('\n').includes('1.2.3.4'));

  // Le portefeuille du compte ne doit jamais traverser.
  const zone = await invoquer('dns.zone.resolve', {
    projectId: 'projet-test',
    input: { hostname: 'garage-a.fr', operationId: 'op-000031' },
    fetchImpl: fournisseur(routes),
  });
  check('la résolution ne rend PAS le portefeuille',
    !JSON.stringify(zone.data).includes('garage-b.fr') && !JSON.stringify(zone.data).includes('partage.fr'));
  check('…seulement la zone et sa provenance',
    Object.keys(zone.data).sort().join(',') === 'hostname,relativeName,source,zone');
}

/* ========================================================================== */
section('7. TIMEOUT_SAFE — un silence sur une écriture est INDÉCIDABLE');
/* ========================================================================== */
{
  const abandon = () => { const e = new Error('aborted'); e.name = 'AbortError'; throw e; };

  // LECTURE : le silence est un échec franc, et réessayer est sans conséquence.
  const lecture = await transport.listDomains({
    credentials: CREDENTIALS, fetchImpl: abandon,
  }).catch((err) => err);
  check('lecture : TIMEOUT', lecture.code === transport.TRANSPORT_CODES.TIMEOUT);
  check('lecture : issue FAILED (rien n’a changé)', lecture.outcome === transport.OUTCOMES.FAILED);
  check('lecture : rejeu sans risque', lecture.replaySafe === true);

  // ÉCRITURE : l'enregistrement a PEUT-ÊTRE été posé.
  const ecriture = await transport.upsertZoneRecord({
    credentials: CREDENTIALS, zone: 'garage-a.fr', name: '@', content: '1.2.3.4', fetchImpl: abandon,
  }).catch((err) => err);
  check('écriture : TIMEOUT', ecriture.code === transport.TRANSPORT_CODES.TIMEOUT);
  check('écriture : issue UNKNOWN, jamais FAILED', ecriture.outcome === transport.OUTCOMES.UNKNOWN);
  check('écriture : rejeu NON déclaré sûr', ecriture.replaySafe === false);
  check('écriture : aucune reprise automatique',
    transport.describeRetryDecision(ecriture).automatic === false);
  check('…et le motif est un arbitrage humain',
    transport.describeRetryDecision(ecriture).reason === 'ISSUE_INCONNUE_ARBITRAGE_HUMAIN');

  // L'adaptateur porte la nuance jusqu'au code de la passerelle.
  const via = await invoquer('dns.record.ensure', {
    projectId: 'projet-test',
    input: { hostname: 'garage-a.fr', type: 'A', content: '1.2.3.4', operationId: 'op-000040' },
    fetchImpl: fournisseur({ 'GET /api/domains/v1/portfolio': () => reponse(200, PORTEFEUILLE), PUT: abandon }),
  });
  check('la passerelle rend CAPABILITY_TIMEOUT', via.code === CODES.TIMEOUT);
  check('…et le dit non rejouable', via.error.details?.replaySafe === false);

  // Aucun retry sur une écriture, même sur 5xx : Hostinger a peut-être écrit
  // avant de tomber.
  let tentatives = 0;
  const cinqCents = fournisseur({
    'GET /api/domains/v1/portfolio': () => reponse(200, PORTEFEUILLE),
    PUT: () => { tentatives += 1; return reponse(503, { message: 'indisponible' }); },
  });
  await invoquer('dns.record.ensure', {
    projectId: 'projet-test',
    input: { hostname: 'garage-a.fr', type: 'A', content: '1.2.3.4', operationId: 'op-000041' },
    fetchImpl: cinqCents,
  });
  check('une écriture 5xx n’est JAMAIS réessayée', tentatives === 1);

  // Une lecture, elle, l'est.
  let lectures = 0;
  await transport.listDomains({
    credentials: CREDENTIALS,
    fetchImpl: async () => { lectures += 1; return reponse(503, { message: 'indisponible' }); },
  }).catch(() => {});
  check('une lecture 5xx est réessayée', lectures > 1);
}

/* ========================================================================== */
section('8. WRITE_AUDITED — une écriture nomme sa ressource, et rien de plus');
/* ========================================================================== */
{
  const routes = {
    'GET /api/domains/v1/portfolio': () => reponse(200, PORTEFEUILLE),
    'PUT /api/dns/v1/zones/garage-a.fr': () => reponse(200, {}),
  };
  const f = fournisseur(routes);
  const r = await invoquer('dns.record.ensure', {
    projectId: 'projet-test',
    input: { hostname: 'manager.garage-a.fr', type: 'A', content: '9.9.9.9', ttl: 600, operationId: 'op-000050' },
    fetchImpl: f,
  });

  check('la sortie nomme l’hôte, la zone et le nom relatif',
    r.data.hostname === 'manager.garage-a.fr' && r.data.zone === 'garage-a.fr' && r.data.name === 'manager');
  check('…et dit si l’écriture a eu lieu', r.data.written === true);
  check('…et porte le corrélat du fournisseur (ou null)', 'correlationId' in r.data);

  const corps = f.appels.at(-1).corps;
  // PORTÉE MINIMALE : un seul enregistrement, jamais la zone entière.
  check('un SEUL enregistrement est envoyé', corps.zone.length === 1);
  check('…avec overwrite limité à ce couple (nom, type)', corps.overwrite === true);
  check('…et le TTL demandé', corps.zone[0].ttl === 600);
  check('aucun autre nom n’apparaît dans la charge utile',
    !JSON.stringify(corps).includes('secret-interne') && !JSON.stringify(corps).includes('garage-b'));
}

/* ========================================================================== */
section('9. DEPLOYMENT_ENGINE_REMAINS_AUTHORITY — l’adaptateur ne planifie pas');
/* ========================================================================== */
{
  const source = await (await import('node:fs/promises')).readFile(
    new URL('../backend/src/services/integratedApi/hostinger/hostingerAdapters.js', import.meta.url), 'utf8',
  );
  // Le moteur décide QUOI écrire ; l'adaptateur exécute. S'il se mettait à
  // comparer, il y aurait deux idées de ce qu'est un conflit.
  check('aucune notion de conflit dans l’adaptateur', !/conflict|CONFLICT/.test(source));
  check('aucune planification (dryRun) dans l’adaptateur', !/dryRun/.test(source));
  check('aucun import du moteur de déploiement, hors résolveur de zone',
    !/deployment-engine\/(?!dns\/zoneResolver)/.test(source));

  // L'écriture est une PRIMITIVE : une entrée, un appel.
  const f = fournisseur({
    'GET /api/domains/v1/portfolio': () => reponse(200, PORTEFEUILLE),
    'PUT /api/dns/v1/zones/garage-a.fr': () => reponse(200, {}),
  });
  await invoquer('dns.record.ensure', {
    projectId: 'projet-test',
    input: { hostname: 'garage-a.fr', type: 'A', content: '1.2.3.4', operationId: 'op-000060' },
    fetchImpl: f,
  });
  const ecritures = f.appels.filter((a) => a.methode === 'PUT');
  check('une écriture = UN appel de mutation', ecritures.length === 1);
  check('…et aucune relecture automatique après écriture',
    f.appels.filter((a) => a.chemin.startsWith('/api/dns/v1/zones/') && a.methode === 'GET').length === 0);
}

/* ========================================================================== */
section('10. LE DÉPLOIEMENT NE DÉPEND PLUS D’AUCUNE POLITIQUE D’OUVERTURE');
/* ========================================================================== */
{
  /**
   * ── CE QUE CETTE SECTION PROUVAIT, ET CE QU'ELLE PROUVE MAINTENANT ─────────
   *
   * Elle vérifiait que les trois verbes DNS étaient AUTORISÉS en pré-ouverture,
   * par dérivation : leur effet n'était pas dans la liste des deux effets
   * interdits (`FINANCIAL_WRITE`, `LEGAL_WRITE`). C'était la garantie qu'une
   * instance non encore ouverte pouvait quand même être déployée.
   *
   * La politique d'ouverture a été supprimée. Le résultat visé — déployer sans
   * geste commercial préalable — est désormais obtenu par construction, et il
   * n'y a plus de table d'effets à interroger.
   *
   * On vérifie donc que la dépendance a bien DISPARU, plutôt que de vérifier
   * qu'elle rendait le bon verdict : c'est le seul contrôle qui empêche qu'une
   * politique d'ouverture se réintroduise un jour sur le chemin du déploiement.
   */
  const fs = await import('node:fs');
  const source = fs.readFileSync(
    new URL('../backend/src/services/integratedApi/hostinger/hostingerCapabilities.js', import.meta.url),
    'utf8',
  ).replace(/\/\*[\s\S]*?\*\//g, '');

  check('aucune table d’effets locale ne subsiste', !/PROPOSED_EFFECTS\s*=/.test(source));
  check('le catalogue DNS n’importe plus la politique d’ouverture',
    !/commercialReadiness/.test(source));
  check('…et ne déclare plus aucune nature d’effet',
    !/effectNature/.test(source) && !/CAPABILITY_EFFECTS/.test(source));

  for (const code of capabilities.HOSTINGER_CAPABILITY_CODES) {
    const definition = capabilities.HOSTINGER_CAPABILITIES[code];
    check(`${code} : ne porte aucune nature d’effet`, !('effectNature' in definition));
    check(`${code} : ne porte aucun drapeau de migration`, !('migrated' in definition));
  }

  /**
   * CE QUI GARDE RÉELLEMENT LE DNS N'A PAS BOUGÉ : l'appartenance du nom
   * d'hôte, éprouvée aux sections 5 et 6 de cette même suite.
   */
  check('les trois verbes exigent toujours la preuve d’appartenance',
    capabilities.HOSTINGER_CAPABILITY_CODES
      .every((c) => capabilities.HOSTINGER_CAPABILITIES[c].requiresResourceOwnership === true));
}

/* ========================================================================== */
section('11. CÂBLAGE L9.1 — les trois verbes sont réellement servis');
/* ========================================================================== */
{
  const registre = await import('../backend/src/services/capabilities/capabilityRegistry.js');
  const providerAdapters = await import('../backend/src/services/capabilities/providerAdapters.js');

  for (const code of capabilities.HOSTINGER_CAPABILITY_CODES) {
    const definition = registre.getCapabilityDefinition(code);
    check(`${code} : au registre de la passerelle`, Boolean(definition));
    // Figurer au registre EST la déclaration de service : le booléen `migrated`
    // a disparu, et l'adaptateur vérifié à la ligne suivante est la seule preuve.
    check(`${code} : ne porte plus de drapeau de migration`,
      definition !== null && !('migrated' in definition));
    check(`${code} : un adaptateur l’exécute`, providerAdapters.hasAdapter(code));
    check(`${code} : exige la preuve d’appartenance`, definition?.requiresResourceOwnership === true);
    check(`${code} : reste PANEL_GLOBAL`, definition?.scope === 'PANEL_GLOBAL');
  }

  /**
   * L'écriture ne doit PAS être `SAFE_RETRY`. L'entrée locale qui existait au
   * registre avant L9.1 l'annonçait ainsi — Hostinger n'expose aucune clé
   * d'idempotence sur `PUT /zones/{zone}`, et un rejeu après un silence écrase
   * une correction humaine survenue entre-temps.
   */
  check('dns.record.ensure : UNKNOWN_ON_TIMEOUT, jamais SAFE_RETRY',
    registre.getCapabilityDefinition('dns.record.ensure').idempotency === 'UNKNOWN_ON_TIMEOUT');

  check('l’alignement du registre est vert', registre.assertRegistryAlignment().length === 0);
  check('…et celui des adaptateurs aussi',
    providerAdapters.assertAdapterAlignment(registre.listCapabilityDefinitions()).length === 0);

  // BIDIRECTIONNEL : le registre L1 annonce les trois, et rien de plus.
  const annoncees = providerRegistry.getProviderDefinition('HOSTINGER').capabilities;
  check('le registre L1 annonce les TROIS verbes',
    capabilities.HOSTINGER_CAPABILITY_CODES.every((c) => annoncees.includes(c)));
  check('…et aucun verbe fantôme', annoncees.length === capabilities.HOSTINGER_CAPABILITY_CODES.length);
}

/* ========================================================================== */
section('12. OWNERSHIP — normalisation, frontières, et aucun startsWith');
/* ========================================================================== */
{
  /**
   * Le contrôle d'appartenance est la seule chose qui empêche un jeton global de
   * devenir une autorisation globale. On l'éprouve donc sur les formes qu'un
   * nom d'hôte prend réellement dans la nature, pas seulement sur le cas facile.
   */
  const PROJ = 'p-own';
  await destination(PROJ, 'garage-own.fr');

  const cas = [
    // [nom demandé, attendu, ce qu'on éprouve]
    ['garage-own.fr', true, 'l’hôte exact'],
    ['manager.garage-own.fr', true, 'un sous-domaine'],
    ['a.b.garage-own.fr', true, 'un sous-domaine profond'],
    ['GARAGE-OWN.FR', true, 'les majuscules sont normalisées'],
    ['Manager.Garage-Own.FR', true, '…y compris sur un sous-domaine'],
    ['garage-own.fr.', true, 'le point final absolu est normalisé'],
    ['notgarage-own.fr', false, 'un voisin qui COMMENCE autrement'],
    ['garage-own.fr.evil.com', false, 'un domaine qui CONTIENT le nôtre'],
    ['garage-own.frx', false, 'un suffixe collé — la frontière de label tient'],
    ['xgarage-own.fr', false, 'un préfixe collé'],
    ['garage-ownxfr', false, 'sans point : pas un sous-domaine'],
  ];

  for (const [nom, attendu, propos] of cas) {
    const verdict = await ownership.describeHostnameOwnership(PROJ, nom);
    check(`${propos} → ${attendu ? 'accepté' : 'refusé'} (${nom})`, verdict.allowed === attendu);
  }

  /**
   * IDN — le module ne traite PAS l'Unicode, et c'est un refus, pas un oubli.
   *
   * Un nom en Unicode brut est rejeté comme inexploitable : la comparaison se
   * fait sur des octets, et laisser passer deux écritures d'un même nom
   * ouvrirait la porte aux homographes. La forme punycode, elle, est de l'ASCII
   * exact et se compare sans ambiguïté — c'est celle que le DNS transporte.
   */
  const unicode = await ownership.describeHostnameOwnership(PROJ, 'garage-ôwn.fr');
  check('un nom Unicode brut est refusé, pas deviné',
    unicode.allowed === false && unicode.code === ownership.OWNERSHIP_CODES.INVALID_HOSTNAME);

  await destination('p-idn', 'xn--garage-wn-e1a.fr');
  const puny = await ownership.describeHostnameOwnership('p-idn', 'XN--GARAGE-WN-E1A.FR');
  check('la forme punycode, elle, se compare exactement', puny.allowed === true);
  const punyVoisin = await ownership.describeHostnameOwnership('p-idn', 'xn--garage-wn-e1b.fr');
  check('…et un punycode voisin ne passe pas', punyVoisin.allowed === false);

  /**
   * LA PREUVE STRUCTURELLE : aucune comparaison par préfixe.
   *
   * `startsWith` sur un nom d'hôte est la faille classique — `example.com.evil`
   * y « commence par » `example.com`. `includes` en est la variante pire encore.
   * On interdit les deux dans ce module, pour que la relecture d'un futur
   * correctif ne les réintroduise pas par commodité.
   */
  const fs = await import('node:fs');
  const src = fs.readFileSync(
    new URL('../backend/src/services/capabilities/resourceOwnership.js', import.meta.url),
    'utf8',
  ).replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
  check('aucun startsWith dans le contrôle d’appartenance', !/\.startsWith\(/.test(src));
  check('…ni includes sur un nom d’hôte', !/host[A-Za-z]*\.includes\(/.test(src));
  check('la couverture se fait sur une frontière de label',
    /endsWith\(`\.\$\{root\}`\)/.test(src));

  // Le schéma d'entrée, lui, refuse le point final au lieu de le normaliser :
  // fail closed. On le pin pour que le comportement soit un choix, pas un hasard.
  const parsed = capabilities.HOSTINGER_CAPABILITIES['dns.zone.resolve']
    .inputSchema.safeParse({ hostname: 'garage-own.fr.', operationId: 'op-12345678' });
  check('le contrat d’entrée refuse le point final (fail closed)', parsed.success === false);
}

await stopMemoryMongo();
finish();
