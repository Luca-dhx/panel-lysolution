// Surface HTTP réelle /bridge/v1 : serveur Express éphémère + fetch — le
// cycle de vie complet du contrat PanelBridge (v1.1.0), plus l'auth de la
// surface interne /api.
import { check, finish, section, setTestEnv, startServer } from './helpers/harness.js';

setTestEnv();

const { createApp } = await import('../backend/src/app.js');
const {
  CONTRACT_VERSION,
  CONTRACT_VERSION_HEADER,
} = await import('../backend/src/bridge/bridgeContract.js');
const registry = await import('../backend/src/services/registry/projectRegistry.service.js');
const { registryStore } = await import('../backend/src/services/registry/registryStore.js');
const { emitChange, resetSyncCore } = await import('../backend/src/services/sync/syncCore.service.js');
const { seedFromEnv } = await import('../backend/src/services/auth/panelUsers.service.js');

await seedFromEnv();
await resetSyncCore();

const { call, close } = await startServer(createApp());
const H = { [CONTRACT_VERSION_HEADER]: CONTRACT_VERSION };
const uuid = () => crypto.randomUUID();
const iso = (offsetMs = 0) => new Date(Date.now() + offsetMs).toISOString();

section('Garde de version du contrat (toutes routes, ping compris)');
{
  const noHeader = await call('GET', '/bridge/v1/ping');
  check('ping sans en-tête → 409 BRIDGE_CONTRACT_VERSION_UNSUPPORTED',
    noHeader.status === 409 && noHeader.json.code === 'BRIDGE_CONTRACT_VERSION_UNSUPPORTED');
  check('…mais l’en-tête de réponse annonce la version du Panel',
    noHeader.headers.get(CONTRACT_VERSION_HEADER) === CONTRACT_VERSION);

  const wrongMajor = await call('GET', '/bridge/v1/ping', { headers: { [CONTRACT_VERSION_HEADER]: '2.0.0' } });
  check('majeure inconnue → 409', wrongMajor.status === 409);

  const okPing = await call('GET', '/bridge/v1/ping', { headers: H });
  check('ping conforme → 200 {status, service, time}',
    okPing.status === 200 && okPing.json.success === true
    && okPing.json.data.status === 'ok' && okPing.json.data.service === 'panel-bridge-api'
    && typeof okPing.json.data.time === 'string');

  const minorAbove = await call('GET', '/bridge/v1/ping', { headers: { [CONTRACT_VERSION_HEADER]: '1.9.0' } });
  check('mineure supérieure du client acceptée (même majeure)', minorAbove.status === 200);
}

section('Bootstrap — POST /bridge/v1/pairings');
const declared = await registry.declareProject({ projectKey: 'projet-http', projectName: 'Projet HTTP' });
let bridgeToken;
{
  const invalid = await call('POST', '/bridge/v1/pairings', { headers: H, body: { hello: 'world' } });
  check('DTO invalide → 400 BRIDGE_INVALID_PAYLOAD',
    invalid.status === 400 && invalid.json.code === 'BRIDGE_INVALID_PAYLOAD');
  check('…avec le détail zod des champs', Array.isArray(invalid.json.details?.issues));

  const dto = {
    contractVersion: CONTRACT_VERSION,
    projectKey: 'projet-http',
    projectName: 'Projet HTTP',
    environment: 'TEST',
    softwareVersion: '1.0.0',
    publicBackendUrl: null,
    pairingCode: 'PAIR-FAUX-FAUX-FAUX',
  };
  const badCode = await call('POST', '/bridge/v1/pairings', { headers: H, body: dto });
  check('code inconnu → 401 BRIDGE_PAIRING_CODE_INVALID',
    badCode.status === 401 && badCode.json.code === 'BRIDGE_PAIRING_CODE_INVALID');

  const good = await call('POST', '/bridge/v1/pairings', {
    headers: H,
    body: { ...dto, pairingCode: declared.pairingCode },
  });
  check('bootstrap conforme → 201', good.status === 201 && good.json.success === true);
  check('bridgeToken + projectId + identité du Panel délivrés',
    typeof good.json.data.bridgeToken === 'string'
    && good.json.data.projectId === declared.record.projectId
    && good.json.data.panel.contractVersion === CONTRACT_VERSION);
  bridgeToken = good.json.data.bridgeToken;

  // Défense en profondeur : un code encore présent sur une fiche PAIRED.
  const { sha256Hex } = await import('../backend/src/utils/panelCrypto.js');
  const pairedRecord = await registryStore.getById(declared.record.projectId);
  pairedRecord.pairing.pairingCodeHash = sha256Hex('PAIR-TEST-DEJA-PAIR');
  pairedRecord.pairing.pairingCodeExpiresAt = iso(60_000);
  await registryStore.save(pairedRecord);
  const alreadyPaired = await call('POST', '/bridge/v1/pairings', {
    headers: H,
    body: { ...dto, pairingCode: 'PAIR-TEST-DEJA-PAIR' },
  });
  check('fiche déjà appairée → 409 BRIDGE_ALREADY_PAIRED',
    alreadyPaired.status === 409 && alreadyPaired.json.code === 'BRIDGE_ALREADY_PAIRED');
  pairedRecord.pairing.pairingCodeHash = null;
  pairedRecord.pairing.pairingCodeExpiresAt = null;
  await registryStore.save(pairedRecord);
}

section('Bootstrap 1.1 avec Manifest joint');
{
  const withManifest = await registry.declareProject({
    projectKey: 'projet-manifest',
    projectName: 'Projet Manifest',
  });
  const manifest = {
    manifestVersion: '1.0.0',
    project: { key: 'projet-manifest', name: 'Projet Manifest', environment: 'TEST', softwareVersion: 'dev' },
    bridge: { contractVersion: CONTRACT_VERSION, projectBridgeBasePath: '/api/project-bridge/v1' },
    contracts: { panelBridge: CONTRACT_VERSION, projectBridge: CONTRACT_VERSION },
    sync: { supportedEntityTypes: ['DIAGNOSTIC'], operations: [] },
    modules: [{ id: 'panel-bridge', title: 'Pont Panel', status: 'ACTIVE' }],
    features: [{ id: 'sync.diagnostic', status: 'AVAILABLE' }],
  };
  const dto = {
    contractVersion: CONTRACT_VERSION,
    projectKey: 'projet-manifest',
    projectName: 'Projet Manifest',
    environment: 'TEST',
    softwareVersion: 'dev',
    pairingCode: withManifest.pairingCode,
    manifest,
  };

  const malformed = await call('POST', '/bridge/v1/pairings', {
    headers: H,
    body: { ...dto, manifest: { ...manifest, features: [{ id: 'x', status: 'ON' }] } },
  });
  check('manifest joint malformé → 400 BRIDGE_INVALID_PAYLOAD',
    malformed.status === 400 && malformed.json.code === 'BRIDGE_INVALID_PAYLOAD');

  const good = await call('POST', '/bridge/v1/pairings', { headers: H, body: dto });
  check('bootstrap avec manifest → 201 (le refus précédent n’a pas grillé le code)',
    good.status === 201 && typeof good.json.data.bridgeToken === 'string');

  const stored = await registryStore.getById(withManifest.record.projectId);
  check('Manifest reçu au bootstrap conservé', stored.manifest?.project?.key === 'projet-manifest');
  check('source BRIDGE enregistrée', stored.manifestSource === 'BRIDGE');
}

const AUTH = { ...H, authorization: `Bearer ${bridgeToken}` };

section('Heartbeat — POST /bridge/v1/heartbeats');
{
  const noAuth = await call('POST', '/bridge/v1/heartbeats', { headers: H, body: {} });
  check('sans token → 401 BRIDGE_UNAUTHORIZED',
    noAuth.status === 401 && noAuth.json.code === 'BRIDGE_UNAUTHORIZED');

  const badToken = await call('POST', '/bridge/v1/heartbeats', {
    headers: { ...H, authorization: `Bearer ${'0'.repeat(64)}` },
    body: {},
  });
  check('token inconnu → 401', badToken.status === 401);

  const invalid = await call('POST', '/bridge/v1/heartbeats', { headers: AUTH, body: { nope: 1 } });
  check('DTO invalide → 400', invalid.status === 400 && invalid.json.code === 'BRIDGE_INVALID_PAYLOAD');

  const hb = await call('POST', '/bridge/v1/heartbeats', {
    headers: AUTH,
    body: {
      sentAt: iso(),
      softwareVersion: '1.0.1',
      environment: 'TEST',
      health: { status: 'OK', details: null },
      bridgeStats: { outboxSize: 3, lastSyncAt: null },
    },
  });
  check('heartbeat conforme → 200 {acknowledged, panelTime}',
    hb.status === 200 && hb.json.data.acknowledged === true && typeof hb.json.data.panelTime === 'string');
  const afterHb = await registryStore.getById(declared.record.projectId);
  check('le registre reflète le heartbeat',
    afterHb.runtime.softwareVersion === '1.0.1'
    && afterHb.runtime.bridgeStats.outboxSize === 3
    && registry.deriveLiveness(afterHb) === 'ONLINE');
}

section('Sync push — POST /bridge/v1/sync/push');
{
  const entityId = uuid();
  const writeId = uuid();
  const first = await call('POST', '/bridge/v1/sync/push', {
    headers: AUTH,
    body: {
      changes: [{
        writeId, entityType: 'DIAGNOSTIC', entityId, deleted: false,
        payload: { probe: 1 }, modifiedAt: iso(), emitter: 'PROJECT',
      }],
    },
  });
  check('DIAGNOSTIC appliqué → APPLIED',
    first.status === 200 && first.json.data.results[0].status === 'APPLIED');

  const replay = await call('POST', '/bridge/v1/sync/push', {
    headers: AUTH,
    body: {
      changes: [{
        writeId, entityType: 'DIAGNOSTIC', entityId, deleted: false,
        payload: { probe: 1 }, modifiedAt: iso(), emitter: 'PROJECT',
      }],
    },
  });
  check('relivraison du même writeId → DUPLICATE (idempotence)',
    replay.json.data.results[0].status === 'DUPLICATE');

  const older = await call('POST', '/bridge/v1/sync/push', {
    headers: AUTH,
    body: {
      changes: [{
        writeId: uuid(), entityType: 'DIAGNOSTIC', entityId, deleted: false,
        payload: { probe: 0 }, modifiedAt: iso(-60_000), emitter: 'PROJECT',
      }],
    },
  });
  check('écriture plus ancienne sur la même entité → IGNORED (dernier écrit gagne)',
    older.json.data.results[0].status === 'IGNORED');

  const reserved = await call('POST', '/bridge/v1/sync/push', {
    headers: AUTH,
    body: {
      changes: [{
        writeId: uuid(), entityType: 'CONTRACT', entityId: uuid(), deleted: false,
        payload: {}, modifiedAt: iso(), emitter: 'PROJECT',
      }],
    },
  });
  check('type réservé (CONTRACT) → REJECTED, jamais un 500',
    reserved.status === 200 && reserved.json.data.results[0].status === 'REJECTED');
  check('…avec le code BRIDGE_ENTITY_TYPE_UNSUPPORTED',
    reserved.json.data.results[0].code === 'BRIDGE_ENTITY_TYPE_UNSUPPORTED');

  const badTombstone = await call('POST', '/bridge/v1/sync/push', {
    headers: AUTH,
    body: {
      changes: [{
        writeId: uuid(), entityType: 'DIAGNOSTIC', entityId: uuid(), deleted: true,
        payload: { still: 'here' }, modifiedAt: iso(), emitter: 'PROJECT',
      }],
    },
  });
  check('tombstone avec payload → REJECTED', badTombstone.json.data.results[0].status === 'REJECTED');

  const emptyBatch = await call('POST', '/bridge/v1/sync/push', { headers: AUTH, body: { changes: [] } });
  check('lot vide → 400 (minItems 1)', emptyBatch.status === 400);
}

section('Sync pull — GET /bridge/v1/sync/pull (anti-écho, curseur, pagination)');
{
  const targetEntity = uuid();
  emitChange({ entityType: 'DIAGNOSTIC', entityId: targetEntity, payload: { n: 1 } });
  emitChange({ entityType: 'DIAGNOSTIC', entityId: uuid(), payload: { n: 2 }, originProjectId: declared.record.projectId });
  emitChange({ entityType: 'DIAGNOSTIC', entityId: uuid(), payload: { n: 3 } });

  const page1 = await call('GET', '/bridge/v1/sync/pull?limit=1', { headers: AUTH });
  check('page 1 : une écriture, hasMore=true',
    page1.status === 200 && page1.json.data.changes.length === 1 && page1.json.data.hasMore === true);
  check('anti-écho : l’écriture originaire de CE projet est exclue',
    page1.json.data.changes[0].payload.n === 1);

  const cursor = page1.json.data.cursor;
  const page2 = await call('GET', `/bridge/v1/sync/pull?limit=10&cursor=${encodeURIComponent(cursor)}`, { headers: AUTH });
  check('page 2 via curseur opaque : la suite, sans doublon',
    page2.json.data.changes.length === 1 && page2.json.data.changes[0].payload.n === 3);
  check('fin de journal : hasMore=false', page2.json.data.hasMore === false);

  const badCursor = await call('GET', '/bridge/v1/sync/pull?cursor=%25%25%25', { headers: AUTH });
  check('curseur corrompu → 400 BRIDGE_INVALID_PAYLOAD', badCursor.status === 400);

  const badLimit = await call('GET', '/bridge/v1/sync/pull?limit=9999', { headers: AUTH });
  check('limit hors bornes → 400', badLimit.status === 400);
}

section('Unpair — DELETE /bridge/v1/pairings/current');
{
  const unpaired = await call('DELETE', '/bridge/v1/pairings/current', { headers: AUTH });
  check('désappairage → 200 {unpaired:true}',
    unpaired.status === 200 && unpaired.json.data.unpaired === true);
  check('fiche REVOKED', (await registryStore.getById(declared.record.projectId)).pairing.status === 'REVOKED');

  const afterRevoke = await call('POST', '/bridge/v1/heartbeats', { headers: AUTH, body: {} });
  check('l’ancien token répond désormais 401', afterRevoke.status === 401);

  const pingStill = await call('GET', '/bridge/v1/ping', { headers: H });
  check('ping toujours public après révocation', pingStill.status === 200);
}

section('Surface interne /api : gardes et santé');
{
  const health = await call('GET', '/health');
  check('GET /health public', health.status === 200 && health.json.data.status === 'ok');

  const version = await call('GET', '/api/version');
  check('GET /api/version : version de contrat du Panel',
    version.status === 200 && version.json.data.contractVersion === CONTRACT_VERSION);

  const anonymous = await call('GET', '/api/projects');
  check('registre inaccessible sans JWT → 401 PANEL_UNAUTHORIZED',
    anonymous.status === 401 && anonymous.json.code === 'PANEL_UNAUTHORIZED');

  const bridgeTokenOnApi = await call('GET', '/api/projects', {
    headers: { authorization: `Bearer ${bridgeToken}` },
  });
  check('un bridgeToken n’ouvre RIEN sur /api', bridgeTokenOnApi.status === 401);

  const badLogin = await call('POST', '/api/auth/login', {
    body: { email: 'dev@panel.test', password: 'mauvais' },
  });
  check('mauvais mot de passe → 401 PANEL_INVALID_CREDENTIALS',
    badLogin.status === 401 && badLogin.json.code === 'PANEL_INVALID_CREDENTIALS');

  const login = await call('POST', '/api/auth/login', {
    body: { email: 'dev@panel.test', password: 'motdepasse-test' },
  });
  check('connexion du compte seed → token + user DEV',
    login.status === 200 && typeof login.json.data.token === 'string'
    && login.json.data.user.role === 'DEV');

  const jwt = login.json.data.token;
  const me = await call('GET', '/api/auth/me', { headers: { authorization: `Bearer ${jwt}` } });
  check('GET /api/auth/me', me.status === 200 && me.json.data.user.email === 'dev@panel.test');

  const projects = await call('GET', '/api/projects', { headers: { authorization: `Bearer ${jwt}` } });
  check('liste du parc accessible avec JWT', projects.status === 200 && Array.isArray(projects.json.data.projects));
  const publicProject = projects.json.data.projects.find((p) => p.projectKey === 'projet-http');
  check('projection publique : statut REVOKED visible, aucun secret',
    publicProject.pairing.status === 'REVOKED' && !JSON.stringify(publicProject).match(/Hash|Encrypted/));

  const jwtOnBridge = await call('POST', '/bridge/v1/heartbeats', {
    headers: { ...H, authorization: `Bearer ${jwt}` },
    body: {},
  });
  check('un JWT utilisateur n’ouvre RIEN sur /bridge/v1', jwtOnBridge.status === 401);
}

await close();
finish();
