// SUPERVISION — Phase 3A. Registre, heartbeats, vivacité, santé,
// chronologie, tableau de bord, recherche.
//
// L'invariant central de la phase est vérifié ici : la supervision est en
// LECTURE SEULE. Aucun test ne provoque d'écriture vers un projet, et un
// contrôle explicite refuse toute route non-GET sur la surface.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  check, connectTestDatabase, finish, section, setTestEnv,
  startMemoryMongo, startServer, stopMemoryMongo,
} from './helpers/harness.js';

setTestEnv();
process.env.HEARTBEAT_INTERVAL_S = '300';
process.env.LIVENESS_STALE_FACTOR = '2';
process.env.LIVENESS_OFFLINE_FACTOR = '6';
await startMemoryMongo();
await connectTestDatabase();

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const registry = await import('../backend/src/services/registry/projectRegistry.service.js');
const pairing = await import('../backend/src/services/pairing/pairing.service.js');
const { registryStore } = await import('../backend/src/services/registry/registryStore.js');
const liveness = await import('../backend/src/services/supervision/liveness.service.js');
const healthSvc = await import('../backend/src/services/supervision/health.service.js');
const heartbeatSvc = await import('../backend/src/services/supervision/heartbeat.service.js');
const timeline = await import('../backend/src/services/supervision/timeline.service.js');
const fleet = await import('../backend/src/services/supervision/fleet.service.js');
const { CONTRACT_VERSION } = await import('../backend/src/bridge/bridgeContract.js');

const { LIVENESS } = liveness;
const { HEALTH } = healthSvc;
const iso = (offsetMs = 0) => new Date(Date.now() + offsetMs).toISOString();

function manifestFor(key, extra = {}) {
  return {
    manifestVersion: '1.0.0',
    /**
     * CE PANEL SERT LA RECETTE — et un projet ne s'y appaire qu'en s'y
     * déclarant. Le contrôle de concordance d'environnement (§9 de
     * 05_PAIRING) refuse un projet qui se dit en PROD sur une instance TEST :
     * cette fixture s'y conforme au lieu de décrire un parc impossible.
     */
    project: { key, name: key, environment: 'TEST', softwareVersion: 'abc1234' },
    bridge: { contractVersion: CONTRACT_VERSION, projectBridgeBasePath: '/api/project-bridge/v1' },
    contracts: { panelBridge: CONTRACT_VERSION, projectBridge: CONTRACT_VERSION },
    sync: { supportedEntityTypes: ['DIAGNOSTIC'], operations: [] },
    modules: [{ id: 'vitrine', title: 'Vitrine', status: 'ACTIVE' }],
    features: [{ id: 'sync.diagnostic', status: 'AVAILABLE' }],
    ...extra,
  };
}

// ─── LOT 3 : vivacité ──────────────────────────────────────────────────────
section('Vivacité : ONLINE / STALE / OFFLINE, seuils configurables');
{
  const paired = (lastHeartbeatAt) => ({
    pairing: { status: 'PAIRED' }, runtime: { lastHeartbeatAt },
  });
  const now = Date.now();
  const t = liveness.livenessThresholds();

  check('seuils dérivés de l’intervalle configuré',
    t.intervalS === 300 && t.staleAfterS === 600 && t.offlineAfterS === 1800);
  check('signal frais → ONLINE',
    liveness.deriveLiveness(paired(new Date(now - 10_000).toISOString()), now) === LIVENESS.ONLINE);
  check('juste avant le seuil stale → ONLINE',
    liveness.deriveLiveness(paired(new Date(now - 599_000).toISOString()), now) === LIVENESS.ONLINE);
  check('au-delà du seuil stale → STALE',
    liveness.deriveLiveness(paired(new Date(now - 601_000).toISOString()), now) === LIVENESS.STALE);
  check('juste avant le seuil offline → STALE',
    liveness.deriveLiveness(paired(new Date(now - 1_799_000).toISOString()), now) === LIVENESS.STALE);
  check('au-delà du seuil offline → OFFLINE',
    liveness.deriveLiveness(paired(new Date(now - 1_801_000).toISOString()), now) === LIVENESS.OFFLINE);
  check('appairé sans aucun signal → NEVER_SEEN (jamais OFFLINE)',
    liveness.deriveLiveness(paired(null), now) === LIVENESS.NEVER_SEEN);
  check('non appairé → NOT_PAIRED',
    liveness.deriveLiveness({ pairing: { status: 'DECLARED' }, runtime: {} }, now) === LIVENESS.NOT_PAIRED);

  check('seuils surchargeables (parc lent)',
    liveness.deriveLiveness(paired(new Date(now - 601_000).toISOString()), now,
      { staleFactor: 10 }) === LIVENESS.ONLINE);
  check('secondes depuis le dernier signal',
    liveness.secondsSinceLastHeartbeat(paired(new Date(now - 120_000).toISOString()), now) === 120);
  check('jamais vu → null', liveness.secondsSinceLastHeartbeat(paired(null), now) === null);
}

// ─── LOT 1/2 : registre et découverte ──────────────────────────────────────
section('Registre : tout vient du Manifest, rien n’est ressaisi');
let declared;
{
  await registryStore.clear();
  declared = await registry.declareProject({
    publicBackendUrl: 'https://garage-nord.test',
    projectName: 'Garage Nord',
    manifest: manifestFor('garage-nord', {
      engines: { deployment: '1.1.0', duplication: '1.1.0' },
      network: { primaryDomain: 'garage-nord.exemple.com', urls: { site: 'https://garage-nord.exemple.com' } },
      descriptor: { type: 'vitrine', description: 'Garage du Nord', layout: 'vitrine:web + backend:server' },
    }),
  });
  const record = await registryStore.getById(declared.record.projectId);
  const d = registry.describeProject(record);

  check('identifiant et slug', d.slug === 'garage-nord');
  check('nom issu du Manifest', d.name === 'garage-nord');
  check('type issu du Manifest', d.type === 'vitrine');
  check('description issue du Manifest', d.description === 'Garage du Nord');
  check('layout issu du Manifest', d.layout === 'vitrine:web + backend:server');
  /**
   * ── UNE FICHE NON APPAIRÉE N'A NI DESTINATION NI ENVIRONNEMENT ───────────
   *
   * UNPAIRED_PROJECT_HAS_NO_DESTINATION / UNPAIRED_PROJECT_HAS_NO_ENVIRONMENT.
   *
   * Ce test attendait auparavant que le domaine principal vienne de la
   * destination active — celle que la DÉCLARATION venait d'annoncer à partir
   * de l'adresse saisie. C'était présenter une saisie locale comme une
   * déclaration du projet.
   *
   * La destination et l'environnement d'un projet lui appartiennent : ils
   * arrivent à l'appairage, puis à chaque échange. Avant, la seule réponse
   * juste est « inconnu » — et `networkSource` le NOMME, au lieu de laisser
   * croire à un échec de résolution.
   *
   * Le manifeste, lui, continue de renseigner ce qu'il décrit légitimement :
   * le type, la topologie, les versions. Il ne sert jamais d'adresse.
   */
  check('UNPAIRED_PROJECT_HAS_NO_DESTINATION : aucun domaine principal',
    d.primaryDomain === null);
  check('…ni aucune adresse résolue', d.urls === null);
  check('…et la raison est nommée', d.networkSource === 'NON_APPAIRE');
  check('UNPAIRED_PROJECT_HAS_NO_ENVIRONMENT : environnement inconnu',
    d.environment === null);
  check('version de moteur de déploiement', d.versions.deploymentEngine === '1.1.0');
  check('version de moteur de duplication', d.versions.duplicationEngine === '1.1.0');
  check('version de contrat', d.versions.contract === CONTRACT_VERSION);
  check('format de manifeste', d.versions.manifestFormat === '1.0.0');
  check('date de création', typeof d.dates.createdAt === 'string');
  check('non appairé : pas de date d’appairage', d.dates.pairedAt === null);
  check('non appairé : aucun heartbeat', d.dates.lastHeartbeatAt === null);

  const noManifest = await registry.declareProject({ publicBackendUrl: 'https://projet-muet.test', projectName: 'Projet Muet' });
  const dm = registry.describeProject(await registryStore.getById(noManifest.record.projectId));
  check('sans Manifest : type inconnu, jamais inventé', dm.type === null && dm.layout === null);
  check('sans Manifest : le nom du registre sert de repli', dm.name === 'Projet Muet');
}

section('Découverte : le Manifest du bootstrap fait autorité');
{
  const record = await registryStore.getById(declared.record.projectId);
  const code = await pairing.issuePairingCode(record);
  await pairing.bootstrap({
    contractVersion: CONTRACT_VERSION,
    projectKey: 'garage-nord',
    projectName: 'Garage Nord',
    environment: 'TEST',
    softwareVersion: 'def5678',
    publicBackendUrl: 'https://api.garage-nord.exemple.com',
    pairingCode: code.code,
    manifest: manifestFor('garage-nord', {
      engines: { deployment: '1.1.0', duplication: '1.1.0' },
      descriptor: { type: 'vitrine', description: 'Mise à jour par le pont', layout: 'x' },
    }),
  });
  const after = await registryStore.getById(declared.record.projectId);
  check('Manifest reçu par le pont', after.manifestSource === 'BRIDGE');
  check('description mise à jour par le projet',
    registry.describeProject(after).description === 'Mise à jour par le pont');
  check('horodatage de mise à jour du Manifest', typeof after.manifestUpdatedAt === 'string');
  check('date d’appairage renseignée', registry.describeProject(after).dates.pairedAt !== null);
}

// ─── LOT 3 : heartbeats ────────────────────────────────────────────────────
section('Heartbeats : archivage, champs 1.2.0, statistiques');
{
  const projectId = declared.record.projectId;
  for (const [i, version] of ['1.0.0', '1.0.0', '1.1.0'].entries()) {
    const record = await registryStore.getById(projectId);
    const hb = {
      sentAt: iso(-i * 1000),
      softwareVersion: version,
      environment: 'TEST',
      health: { status: 'OK', details: null },
      runtime: { uptimeSeconds: 100 + i * 50, load: { memoryUsedMb: 120 + i } },
      engines: { deployment: '1.1.0', duplication: '1.1.0' },
    };
    await heartbeatSvc.archiveHeartbeat(record, hb);
    await registry.recordHeartbeat(record, hb);
  }

  const history = await heartbeatSvc.heartbeatHistory(projectId, { limit: 10 });
  check('trois signaux archivés', history.length === 3);
  check('uptime archivé', history.some((h) => h.uptimeSeconds === 200));
  check('charge archivée', history.some((h) => h.load?.memoryUsedMb === 122));
  check('versions de moteurs archivées', history.every((h) => h.engines?.deployment === '1.1.0'));

  const stats = await heartbeatSvc.heartbeatStats(projectId);
  check('statistiques : compte', stats.count === 3);
  check('statistiques : cadence attendue exposée', stats.expectedIntervalS === 300);

  const record = await registryStore.getById(projectId);
  check('la fiche porte le dernier uptime', record.runtime.uptimeSeconds === 200);
  check('la fiche porte les versions de moteurs', record.runtime.engines.deployment === '1.1.0');
  check('la vivacité est ONLINE après signal frais',
    liveness.deriveLiveness(record) === LIVENESS.ONLINE);
}

// ─── LOT 7 : chronologie ───────────────────────────────────────────────────
section('Chronologie : le Panel reçoit ou constate, il n’invente pas');
{
  const projectId = declared.record.projectId;
  const events = await timeline.projectTimeline(projectId, { limit: 50 });
  check('des événements existent', events.length > 0);
  check('déclaration du projet enregistrée',
    events.some((e) => e.type === 'PROJECT_DECLARED'));
  check('appairage enregistré, déclaré par le projet',
    events.some((e) => e.type === 'PROJECT_PAIRED' && e.source === 'PROJECT'));
  check('changement de version constaté par le Panel',
    events.some((e) => e.type === 'VERSION_CHANGED' && e.source === 'PANEL_OBSERVATION'));
  check('déploiement détecté à partir du changement de version',
    events.some((e) => e.type === 'DEPLOYMENT_DETECTED'));
  check('toutes les sources sont explicites',
    events.every((e) => e.source === 'PROJECT' || e.source === 'PANEL_OBSERVATION'));
  check('aucune source « action du Panel » n’existe',
    events.every((e) => e.source !== 'PANEL_ACTION'));
  check('ordre antéchronologique',
    events.every((e, i) => i === 0 || e.occurredAt <= events[i - 1].occurredAt));

  const diff = timeline.diffObservations(
    { softwareVersion: '1.0.0', environment: 'TEST', lastHealth: { status: 'OK' }, uptimeSeconds: 900,
      engines: { deployment: '1.0.0' } },
    { softwareVersion: '2.0.0', environment: 'PROD', health: { status: 'DEGRADED' },
      runtime: { uptimeSeconds: 5 }, engines: { deployment: '1.1.0' } },
  );
  const types = diff.map((d) => d.type);
  check('changement de version détecté', types.includes('VERSION_CHANGED'));
  check('changement d’environnement détecté', types.includes('ENVIRONMENT_CHANGED'));
  check('changement de santé détecté', types.includes('HEALTH_CHANGED'));
  check('changement de moteur détecté', types.includes('ENGINE_VERSION_CHANGED'));
  check('redémarrage détecté (uptime réinitialisé)', types.includes('BRIDGE_RECONNECTED'));
  check('aucun constat si rien ne change',
    timeline.diffObservations({ softwareVersion: '1.0.0' }, { softwareVersion: '1.0.0' }).length === 0);
}

// ─── LOT 6 : santé ─────────────────────────────────────────────────────────
section('Santé : par composant, statut global, jamais de supposition');
{
  const record = await registryStore.getById(declared.record.projectId);
  const health = healthSvc.buildProjectHealth(record, {
    panelContractVersion: CONTRACT_VERSION,
    expectedEngines: { deployment: '1.1.0', duplication: '1.1.0' },
  });
  check('statut global calculé', Object.values(HEALTH).includes(health.status));
  check('composant bridge présent', health.components.some((c) => c.id === 'bridge'));
  check('composant heartbeat présent', health.components.some((c) => c.id === 'heartbeat'));
  check('composants standards couverts',
    ['backend', 'frontend', 'mongo', 'ssl', 'dns', 'deploymentEngine', 'duplicationEngine']
      .every((id) => health.components.some((c) => c.id === id)));
  check('chaque composant porte un statut valide',
    health.components.every((c) => Object.values(HEALTH).includes(c.status)));
  check('chaque composant dit d’où vient son verdict',
    health.components.every((c) => ['PROJECT', 'PANEL', 'UNAVAILABLE'].includes(c.source)));

  const notPublished = health.components.find((c) => c.id === 'frontend');
  check('un composant non publié vaut UNKNOWN, jamais OK',
    notPublished.status === HEALTH.UNKNOWN && notPublished.source === 'UNAVAILABLE');

  const engine = health.components.find((c) => c.id === 'deploymentEngine');
  check('moteur aligné → OK', engine.status === HEALTH.OK);

  const drifted = healthSvc.buildProjectHealth(record, {
    panelContractVersion: CONTRACT_VERSION,
    expectedEngines: { deployment: '2.0.0' },
  });
  check('majeure de moteur divergente → ERROR',
    drifted.components.find((c) => c.id === 'deploymentEngine').status === HEALTH.ERROR);
  check('le statut global suit le pire composant', drifted.status === HEALTH.ERROR);

  const minor = healthSvc.buildProjectHealth(record, {
    panelContractVersion: CONTRACT_VERSION,
    expectedEngines: { deployment: '1.5.0' },
  });
  check('mineure de moteur en retard → WARNING',
    minor.components.find((c) => c.id === 'deploymentEngine').status === HEALTH.WARNING);

  const incompatible = healthSvc.buildProjectHealth(
    { ...record, runtime: { ...record.runtime, contractVersion: '2.0.0' } },
    { panelContractVersion: CONTRACT_VERSION },
  );
  check('majeure de contrat incompatible → ERROR',
    incompatible.components.find((c) => c.id === 'bridge').status === HEALTH.ERROR);

  check('ordre de gravité : ERROR domine',
    healthSvc.worstOf([HEALTH.OK, HEALTH.UNKNOWN, HEALTH.WARNING, HEALTH.ERROR]) === HEALTH.ERROR);
  check('UNKNOWN l’emporte sur OK mais pas sur WARNING',
    healthSvc.worstOf([HEALTH.OK, HEALTH.UNKNOWN]) === HEALTH.UNKNOWN
    && healthSvc.worstOf([HEALTH.UNKNOWN, HEALTH.WARNING]) === HEALTH.WARNING);

  // Composant publié par le projet : repris tel quel.
  const withComponents = {
    ...record,
    runtime: { ...record.runtime, components: { mongo: 'ERROR', custom: 'WARNING' } },
  };
  const published = healthSvc.buildProjectHealth(withComponents, { panelContractVersion: CONTRACT_VERSION });
  check('composant publié repris tel quel',
    published.components.find((c) => c.id === 'mongo').status === HEALTH.ERROR);
  check('composant non standard publié également repris',
    published.components.find((c) => c.id === 'custom')?.status === HEALTH.WARNING);
}

section('Alertes : des constats, jamais des actions');
{
  const records = await registry.listProjects();
  const alerts = healthSvc.buildAlerts(records, {
    panelContractVersion: CONTRACT_VERSION,
    expectedEngines: { deployment: '2.0.0' },
  });
  check('des alertes sont produites', alerts.length > 0);
  check('chaque alerte porte code, sévérité et projet',
    alerts.every((a) => a.code && a.severity && a.projectId && a.message));
  check('dérive de moteur signalée', alerts.some((a) => a.code === 'ENGINE_DRIFT'));
  check('les erreurs viennent en premier',
    alerts.every((a, i) => i === 0
      || ['ERROR', 'WARNING', 'INFO'].indexOf(a.severity)
         >= ['ERROR', 'WARNING', 'INFO'].indexOf(alerts[i - 1].severity)));
  check('aucune alerte ne propose une action',
    alerts.every((a) => !/déployer|redémarr|corrige|lance/i.test(a.message)));
}

// ─── LOT 4 : tableau de bord ───────────────────────────────────────────────
section('Tableau de bord : des nombres, jamais la liste complète');
{
  const dashboard = await fleet.buildDashboard();
  check('total de projets', dashboard.totals.projects === 2);
  check('compteur en ligne', dashboard.totals.online === 1);
  check('compteur non appairé', dashboard.totals.notPaired === 1);
  check('répartition TEST/PROD', dashboard.totals.test === 1 && dashboard.totals.prod === 0);
  check('compteurs de santé présents',
    ['ok', 'warning', 'error', 'unknown'].every((k) => typeof dashboard.health[k] === 'number'));
  check('répartition des versions de contrat',
    dashboard.versions.contract[CONTRACT_VERSION] === 1);
  check('répartition des versions de moteur',
    dashboard.versions.deploymentEngine['1.1.0'] === 1);
  check('le Panel publie sa propre référence',
    dashboard.panel.contractVersion === CONTRACT_VERSION && dashboard.panel.thresholds.staleAfterS === 600);
  check('alertes bornées', dashboard.alerts.items.length <= 20);
  check('« à regarder » borné à 10', dashboard.attention.length <= 10);
  check('activité récente présente', Array.isArray(dashboard.recentActivity));
  check('AUCUNE liste complète du parc dans le tableau de bord',
    dashboard.projects === undefined && dashboard.items === undefined);
}

// ─── LOT 8 : recherche ─────────────────────────────────────────────────────
section('Recherche : par nom, slug, domaine, type, version, état, module');
{
  const byName = await fleet.searchFleet({ name: 'garage' });
  check('par nom', byName.total === 1 && byName.items[0].slug === 'garage-nord');
  check('par slug', (await fleet.searchFleet({ slug: 'garage-nord' })).total === 1);
  check('par domaine', (await fleet.searchFleet({ domain: 'exemple.com' })).total === 1);
  check('par type', (await fleet.searchFleet({ type: 'vitrine' })).total === 1);
  check('par environnement', (await fleet.searchFleet({ environment: 'TEST' })).total === 1);
  check('par vivacité', (await fleet.searchFleet({ liveness: 'ONLINE' })).total === 1);
  check('par version de contrat',
    (await fleet.searchFleet({ contractVersion: CONTRACT_VERSION })).total === 1);
  check('par version de moteur', (await fleet.searchFleet({ deploymentEngine: '1.1.0' })).total === 1);
  check('par module', (await fleet.searchFleet({ module: 'vitrine' })).total === 1);
  check('par fonctionnalité', (await fleet.searchFleet({ feature: 'sync.diagnostic' })).total === 1);
  check('recherche libre sur plusieurs champs', (await fleet.searchFleet({ q: 'nord' })).total === 1);
  check('critère sans correspondance → vide', (await fleet.searchFleet({ type: 'inexistant' })).total === 0);
  check('sans critère → tout le parc', (await fleet.searchFleet({})).total === 2);
  check('critères combinés (ET logique)',
    (await fleet.searchFleet({ type: 'vitrine', environment: 'PROD' })).total === 0);

  const facets = await fleet.searchFacets();
  check('facettes : types réellement présents', facets.types.includes('vitrine'));
  check('facettes : modules réellement présents', facets.modules.includes('vitrine'));
  check('facettes : aucune valeur inventée', facets.types.every((t) => typeof t === 'string'));

  const rows = (await fleet.searchFleet({})).items;
  check('une ligne de parc reste pauvre (pas de manifeste)',
    rows.every((r) => r.manifest === undefined && r.components === undefined));
  check('une ligne porte un compteur d’anomalies', rows.every((r) => typeof r.issues === 'number'));
}

// ─── Surface HTTP : lecture seule ──────────────────────────────────────────
section('Surface /api/supervision : strictement en lecture');
{
  const { createApp } = await import('../backend/src/app.js');
  const { seedFromEnv } = await import('../backend/src/services/auth/panelUsers.service.js');
  await seedFromEnv();
  const { call, close } = await startServer(createApp());

  const anonymous = await call('GET', '/api/supervision/dashboard');
  check('supervision inaccessible sans JWT', anonymous.status === 401);

  const login = await call('POST', '/api/auth/login', {
    body: { email: 'dev@panel.test', password: 'motdepasse-test' },
  });
  const auth = { authorization: `Bearer ${login.json.data.token}` };

  const dash = await call('GET', '/api/supervision/dashboard', { headers: auth });
  check('GET /dashboard → 200', dash.status === 200 && dash.json.data.totals.projects === 2);

  const fleetRes = await call('GET', '/api/supervision/fleet?environment=TEST', { headers: auth });
  check('GET /fleet filtré → 200', fleetRes.status === 200 && fleetRes.json.data.total === 1);

  const facetsRes = await call('GET', '/api/supervision/facets', { headers: auth });
  check('GET /facets → 200', facetsRes.status === 200 && Array.isArray(facetsRes.json.data.types));

  const id = declared.record.projectId;
  const overview = await call('GET', `/api/supervision/projects/${id}`, { headers: auth });
  check('GET /projects/:id → fiche', overview.status === 200 && overview.json.data.descriptor.slug === 'garage-nord');
  check('la fiche embarque un aperçu court d’événements',
    overview.json.data.recentEvents.length <= 5);

  const technical = await call('GET', `/api/supervision/projects/${id}/technical`, { headers: auth });
  check('GET /technical → détails', technical.status === 200 && technical.json.data.manifest !== null);
  check('les détails techniques n’exposent aucun secret',
    !JSON.stringify(technical.json.data).match(/bridgeTokenHash|bridgeTokenEncrypted|pairingCodeHash/));

  const hb = await call('GET', `/api/supervision/projects/${id}/heartbeats`, { headers: auth });
  check('GET /heartbeats → historique', hb.status === 200 && hb.json.data.items.length === 3);

  const ev = await call('GET', `/api/supervision/projects/${id}/events`, { headers: auth });
  check('GET /events projet → chronologie', ev.status === 200 && ev.json.data.items.length > 0);

  const parkEv = await call('GET', '/api/supervision/events', { headers: auth });
  check('GET /events parc → chronologie globale', parkEv.status === 200);

  // LECTURE SEULE : aucune méthode d'écriture ne doit exister.
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    const res = await call(method, '/api/supervision/dashboard', { headers: auth, body: {} });
    check(`${method} /dashboard refusé (lecture seule)`, res.status === 404);
  }
  const writeProject = await call('POST', `/api/supervision/projects/${id}`, { headers: auth, body: {} });
  check('POST sur une fiche refusé', writeProject.status === 404);

  const unknown = await call('GET', '/api/supervision/projects/inexistant', { headers: auth });
  check('projet inconnu → 404 propre', unknown.status === 404 && unknown.json.code === 'PANEL_PROJECT_NOT_FOUND');

  await close();
}

section('Invariant de phase : aucune écriture distante dans la supervision');
{
  const supervisionDir = path.join(root, 'backend', 'src', 'services', 'supervision');
  const files = fs.readdirSync(supervisionDir).map((f) => path.join(supervisionDir, f));
  files.push(path.join(root, 'backend', 'src', 'controllers', 'supervision.controller.js'));
  files.push(path.join(root, 'backend', 'src', 'routes', 'supervision.routes.js'));

  const usesClient = files.filter((f) => /ProjectBridgeClient/.test(fs.readFileSync(f, 'utf8')));
  check(`aucun module de supervision n’appelle un projet${usesClient.length ? ` — ${usesClient.map((f) => path.basename(f))}` : ''}`,
    usesClient.length === 0);

  const usesFetch = files.filter((f) => /\bfetch\s*\(/.test(fs.readFileSync(f, 'utf8')));
  check('aucun appel réseau dans la supervision', usesFetch.length === 0);

  const routes = fs.readFileSync(path.join(root, 'backend', 'src', 'routes', 'supervision.routes.js'), 'utf8');
  check('le routeur ne déclare que des GET',
    !/router\.(post|put|patch|delete)\s*\(/i.test(routes));
}

await stopMemoryMongo();
finish();
