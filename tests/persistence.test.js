// Persistance MongoDB : ce qui doit survivre à un redémarrage y survit, et
// aucun secret n'est écrit en clair. Le « redémarrage » coupe la connexion
// applicative et la rétablit sur la MÊME base : seul ce qui est réellement
// persisté réapparaît.
import {
  check,
  connectTestDatabase,
  finish,
  rejectsWith,
  section,
  setTestEnv,
  simulateRestart,
  startMemoryMongo,
  stopMemoryMongo,
} from './helpers/harness.js';

setTestEnv();
await startMemoryMongo();
await connectTestDatabase();

const registry = await import('../backend/src/services/registry/projectRegistry.service.js');
const pairing = await import('../backend/src/services/pairing/pairing.service.js');
const sync = await import('../backend/src/services/sync/syncCore.service.js');
const users = await import('../backend/src/services/auth/panelUsers.service.js');
const { registryStore } = await import('../backend/src/services/registry/registryStore.js');
const { CONTRACT_VERSION, EMITTERS } = await import('../backend/src/bridge/bridgeContract.js');
const PanelProject = (await import('../backend/src/models/PanelProject.model.js')).default;

const uuid = () => crypto.randomUUID();
const iso = () => new Date().toISOString();

section('Registre : une fiche déclarée survit au redémarrage');
let declared;
{
  declared = await registry.declareProject({ publicBackendUrl: 'https://projet-durable.test', projectName: 'Projet durable' });
  await simulateRestart();
  const reloaded = await registryStore.getById(declared.record.projectId);
  check('fiche retrouvée après redémarrage', reloaded?.projectKey === 'projet-durable');
  check('statut conservé', reloaded.pairing.status === 'DECLARED');
  check('hash du code d’appairage conservé', /^[0-9a-f]{64}$/.test(reloaded.pairing.pairingCodeHash));
  check('recherche par clé opérationnelle après redémarrage',
    (await registryStore.getByKey('projet-durable'))?.projectId === declared.record.projectId);
}

section('Appairage : le code émis AVANT redémarrage reste utilisable');
let bridgeToken;
{
  const result = await pairing.bootstrap({
    contractVersion: CONTRACT_VERSION,
    projectKey: 'projet-durable',
    projectName: 'Projet durable',
    environment: 'TEST',
    softwareVersion: '1.0.0',
    publicBackendUrl: 'https://api.exemple.invalid',
    pairingCode: declared.pairingCode,
  });
  bridgeToken = result.bridgeToken;
  check('bootstrap réussi avec un code survivant au redémarrage', bridgeToken.length === 64);

  await simulateRestart();
  const authenticated = await pairing.authenticateBridgeToken(bridgeToken);
  check('le bridgeToken authentifie encore après redémarrage',
    authenticated?.projectKey === 'projet-durable');
  check('la copie chiffrée reste déchiffrable après redémarrage',
    pairing.getOutboundBridgeToken(authenticated) === bridgeToken);
  check('statut PAIRED conservé', authenticated.pairing.status === 'PAIRED');
}

section('Aucun secret en clair dans le document Mongo');
{
  const raw = await PanelProject.findOne({ projectKey: 'projet-durable' }).lean();
  const serialized = JSON.stringify(raw);
  check('le bridgeToken n’apparaît nulle part en clair', !serialized.includes(bridgeToken));
  check('le code d’appairage n’apparaît pas en clair', !serialized.includes(declared.pairingCode));
  check('le hash du token est bien un SHA-256 hexadécimal',
    /^[0-9a-f]{64}$/.test(raw.pairing.bridgeTokenHash));
  check('la copie sortante est chiffrée au format iv.tag.données',
    /^[0-9a-f]+\.[0-9a-f]+\.[0-9a-f]+$/.test(raw.pairing.bridgeTokenEncrypted));
  check('le hash n’est PAS la valeur chiffrée (deux usages distincts)',
    raw.pairing.bridgeTokenHash !== raw.pairing.bridgeTokenEncrypted);
}

section('Manifest et heartbeat persistés');
{
  const record = await registryStore.getById(declared.record.projectId);
  await registry.recordHeartbeat(record, {
    sentAt: iso(),
    softwareVersion: '1.2.3',
    environment: 'TEST',
    health: { status: 'OK', details: null },
    bridgeStats: { outboxSize: 7, lastSyncAt: null },
  });
  await registry.setManifestFromBridge(await registryStore.getById(record.projectId), {
    manifestVersion: '1.0.0',
    project: { key: 'projet-durable', name: 'Projet durable', environment: 'TEST', softwareVersion: 'dev' },
    bridge: { contractVersion: CONTRACT_VERSION, projectBridgeBasePath: '/api/project-bridge/v1' },
    contracts: { panelBridge: CONTRACT_VERSION, projectBridge: CONTRACT_VERSION },
    sync: { supportedEntityTypes: ['DIAGNOSTIC'], operations: [] },
    modules: [{ id: 'panel-bridge', title: 'Pont Panel', status: 'ACTIVE' }],
    features: [{ id: 'sync.diagnostic', status: 'AVAILABLE' }],
  });

  await simulateRestart();
  const reloaded = await registryStore.getById(declared.record.projectId);
  check('heartbeat persisté', reloaded.runtime.softwareVersion === '1.2.3'
    && reloaded.runtime.bridgeStats.outboxSize === 7);
  check('manifest persisté', reloaded.manifest.project.key === 'projet-durable');
  check('source du manifest persistée', reloaded.manifestSource === 'BRIDGE');
  check('la vivacité reste dérivée (jamais un champ stocké)',
    !('liveness' in reloaded) && registry.deriveLiveness(reloaded) === 'ONLINE');
}

section('Idempotence de la synchronisation : survit au redémarrage');
{
  const projectId = declared.record.projectId;
  const writeId = uuid();
  const entityId = uuid();
  const change = {
    writeId, entityType: 'DIAGNOSTIC', entityId, deleted: false,
    payload: { n: 1 }, modifiedAt: iso(), emitter: EMITTERS.PROJECT,
  };
  const first = await sync.applyIncoming(projectId, [change]);
  check('première livraison APPLIED', first.results[0].status === 'APPLIED');

  await simulateRestart();
  const replay = await sync.applyIncoming(projectId, [change]);
  check('relivraison APRÈS redémarrage → DUPLICATE (jamais réappliquée)',
    replay.results[0].status === 'DUPLICATE');

  const older = await sync.applyIncoming(projectId, [{
    ...change, writeId: uuid(), modifiedAt: new Date(Date.now() - 60_000).toISOString(),
  }]);
  check('état LWW persisté : écriture plus ancienne → IGNORED',
    older.results[0].status === 'IGNORED');

  check('diagnostic appliqué conservé', (await sync.getDiagnosticsFor(projectId)).length === 1);
}

section('Journal d’émission : persistant, ordonné, anti-écho');
{
  const projectId = declared.record.projectId;
  await sync.emitChange({ entityType: 'DIAGNOSTIC', entityId: uuid(), payload: { n: 'a' } });
  await sync.emitChange({ entityType: 'DIAGNOSTIC', entityId: uuid(), payload: { n: 'b' }, originProjectId: projectId });
  await sync.emitChange({ entityType: 'DIAGNOSTIC', entityId: uuid(), payload: { n: 'c' } });

  await simulateRestart();
  const page = await sync.pullForProject(projectId, { limit: 10 });
  check('journal persisté après redémarrage', page.changes.length === 2);
  check('ordre conservé', page.changes[0].payload.n === 'a' && page.changes[1].payload.n === 'c');
  check('anti-écho persistant (l’écriture de ce projet reste exclue)',
    !page.changes.some((c) => c.payload.n === 'b'));

  const after = await sync.emitChange({ entityType: 'DIAGNOSTIC', entityId: uuid(), payload: { n: 'd' } });
  check('le compteur de séquence n’est pas réinitialisé au redémarrage', after.seq === 4);

  const next = await sync.pullForProject(projectId, { cursor: page.cursor, limit: 10 });
  check('le curseur reste valide de part et d’autre du redémarrage',
    next.changes.length === 1 && next.changes[0].payload.n === 'd');
}

section('Utilisateurs : comptes et seed persistants');
{
  await users.resetUsers();
  await users.seedFromEnv();
  await simulateRestart();
  const authenticated = await users.authenticate('dev@panel.test', 'motdepasse-test');
  check('le compte seed survit au redémarrage', authenticated?.role === 'DEV');
  check('mauvais mot de passe toujours refusé',
    (await users.authenticate('dev@panel.test', 'faux')) === null);

  await users.seedFromEnv();
  const { default: PanelUser } = await import('../backend/src/models/PanelUser.model.js');
  check('seed idempotent : jamais un second compte',
    (await PanelUser.countDocuments({})) === 1);
}

section('Révocation et suppression : persistantes');
{
  const record = await registryStore.getById(declared.record.projectId);
  await pairing.revokeFromPanel(record);
  await simulateRestart();
  const reloaded = await registryStore.getById(declared.record.projectId);
  check('révocation persistée', reloaded.pairing.status === 'REVOKED');
  check('credentials effacés en base', reloaded.pairing.bridgeTokenHash === null
    && reloaded.pairing.bridgeTokenEncrypted === null);
  check('l’ancien token reste mort après redémarrage',
    (await pairing.authenticateBridgeToken(bridgeToken)) === null);

  await registry.removeProject(reloaded.projectId);
  await simulateRestart();
  check('suppression persistée', (await registryStore.getById(reloaded.projectId)) === null);
  check('la fiche ne réapparaît pas par la clé',
    (await registryStore.getByKey('projet-durable')) === null);
  check('projet inconnu → erreur propre', await rejectsWith(
    () => registry.getProjectOrThrow(reloaded.projectId),
    'PANEL_PROJECT_NOT_FOUND',
  ));
}

await stopMemoryMongo();
finish();
