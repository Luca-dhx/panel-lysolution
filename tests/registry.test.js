// Le registre + l'appairage au niveau service : un projet conforme au
// Manager Standard peut être déclaré, appairé, supervisé, révoqué, ré-appairé.
import { check, finish, rejectsWith, section, setTestEnv } from './helpers/harness.js';

setTestEnv();
process.env.PANEL_HEARTBEAT_INTERVAL_S = '300';

const registry = await import('../backend/src/services/registry/projectRegistry.service.js');
const pairing = await import('../backend/src/services/pairing/pairing.service.js');
const { registryStore } = await import('../backend/src/services/registry/registryStore.js');
const { CONTRACT_VERSION } = await import('../backend/src/bridge/bridgeContract.js');

const CONFORM_MANIFEST = {
  manifestVersion: '1.0.0',
  project: {
    projectKey: 'garage-exemple',
    projectName: 'Garage Exemple',
    softwareVersion: '1.4.2',
    contractVersion: '1.0.0',
    environment: 'PROD',
  },
  capabilities: { supportsContracts: true, supportsBookings: true, supportsStripe: true },
  modules: [{ id: 'bookings', label: 'Réservations' }],
};

function bootstrapDto(pairingCode, overrides = {}) {
  return {
    contractVersion: CONTRACT_VERSION,
    projectKey: 'garage-exemple',
    projectName: 'Garage Exemple',
    environment: 'PROD',
    softwareVersion: '1.4.2',
    publicBackendUrl: 'https://api.garage-exemple.fr',
    pairingCode,
    ...overrides,
  };
}

registryStore.clear();

section('Déclaration d’un projet conforme au Manager Standard');
let declared;
{
  declared = registry.declareProject({
    projectKey: 'garage-exemple',
    projectName: 'Garage Exemple',
    manifest: CONFORM_MANIFEST,
  });
  check('fiche créée en DECLARED', declared.record.pairing.status === 'DECLARED');
  check('projectId UUID délivré', /^[0-9a-f-]{36}$/.test(declared.record.projectId));
  check('code au format lisible PAIR-XXXX-XXXX-XXXX', /^PAIR-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(declared.pairingCode));
  check('le code n’est stocké qu’en hash', declared.record.pairing.pairingCodeHash !== declared.pairingCode
    && /^[0-9a-f]{64}$/.test(declared.record.pairing.pairingCodeHash));
  check('expiration posée', typeof declared.pairingCodeExpiresAt === 'string');
  check('manifest validé et conservé', declared.record.manifest.project.projectKey === 'garage-exemple');
}

section('Garde-fous de déclaration');
{
  check('projectKey dupliqué refusé', await rejectsWith(
    () => registry.declareProject({ projectKey: 'garage-exemple', projectName: 'Doublon' }),
    'PANEL_PROJECT_KEY_TAKEN',
  ));
  check('projectKey non kebab-case refusé', await rejectsWith(
    () => registry.declareProject({ projectKey: 'Garage Exemple', projectName: 'X' }),
    'PANEL_PROJECT_KEY_INVALID',
  ));
  check('manifest invalide refusé à la déclaration', await rejectsWith(
    () => registry.declareProject({ projectKey: 'autre-projet', projectName: 'X', manifest: { nope: true } }),
    'PANEL_MANIFEST_INVALID',
  ));
}

section('Bootstrap (appairage)');
let bootstrapResult;
{
  bootstrapResult = pairing.bootstrap(bootstrapDto(declared.pairingCode));
  check('bridgeToken délivré', typeof bootstrapResult.bridgeToken === 'string' && bootstrapResult.bridgeToken.length === 64);
  check('projectId du registre renvoyé', bootstrapResult.projectId === declared.record.projectId);
  check('identité du Panel renvoyée', bootstrapResult.panel.contractVersion === CONTRACT_VERSION);
  const record = registryStore.getById(declared.record.projectId);
  check('fiche PAIRED', record.pairing.status === 'PAIRED');
  check('token stocké en hash, jamais en clair', record.pairing.bridgeTokenHash !== bootstrapResult.bridgeToken);
  check('copie chiffrée présente pour les appels sortants', typeof record.pairing.bridgeTokenEncrypted === 'string');
  check('copie chiffrée déchiffrable par le seul chemin prévu',
    pairing.getOutboundBridgeToken(record) === bootstrapResult.bridgeToken);
  check('code consommé', record.pairing.pairingCodeHash === null);
  check('runtime déclaré enregistré', record.runtime.softwareVersion === '1.4.2'
    && record.runtime.publicBackendUrl === 'https://api.garage-exemple.fr');
  check('rejouer le même code échoue (usage unique)', await rejectsWith(
    () => Promise.resolve(pairing.bootstrap(bootstrapDto(declared.pairingCode))),
    'BRIDGE_PAIRING_CODE_INVALID',
  ));
}

section('Authentification par bridgeToken');
{
  const record = pairing.authenticateBridgeToken(bootstrapResult.bridgeToken);
  check('token valide → fiche du projet', record?.projectKey === 'garage-exemple');
  check('token inconnu → null', pairing.authenticateBridgeToken('f'.repeat(64)) === null);
  check('token vide → null', pairing.authenticateBridgeToken('') === null);
}

section('Conformité Manager Standard');
{
  const record = registryStore.getById(declared.record.projectId);
  const conformity = registry.describeConformity(record);
  check('manifest présent', conformity.hasManifest === true);
  check('identité manifest ↔ registre cohérente', conformity.identityConsistent === true);
  check('appairé', conformity.paired === true);
  record.manifest = { ...record.manifest, project: { ...record.manifest.project, projectKey: 'autre-cle' } };
  check('divergence d’identité détectée', registry.describeConformity(record).identityConsistent === false);
  record.manifest = CONFORM_MANIFEST;
}

section('Vivacité (dérivée, jamais stockée)');
{
  const record = registryStore.getById(declared.record.projectId);
  check('appairé sans heartbeat : NEVER_SEEN', registry.deriveLiveness(record) === 'NEVER_SEEN');
  registry.recordHeartbeat(record, {
    sentAt: new Date().toISOString(),
    softwareVersion: '1.4.3',
    environment: 'PROD',
    health: { status: 'OK', details: null },
    bridgeStats: { outboxSize: 0 },
  });
  const now = Date.now();
  check('heartbeat frais : ONLINE', registry.deriveLiveness(record, now) === 'ONLINE');
  check('après 2×intervalle : STALE', registry.deriveLiveness(record, now + 2 * 300_000 + 1000) === 'STALE');
  check('après 6×intervalle : OFFLINE', registry.deriveLiveness(record, now + 6 * 300_000 + 1000) === 'OFFLINE');
  check('version logicielle mise à jour par le heartbeat', record.runtime.softwareVersion === '1.4.3');
  const publicView = registry.toPublicProject(record, now);
  check('projection publique sans aucun hash ni secret',
    !JSON.stringify(publicView).includes('Hash') && !JSON.stringify(publicView).includes('Encrypted'));
  check('projection publique : capacités interprétées', publicView.capabilities.enabled.includes('supportsContracts'));
}

section('Révocation et ré-appairage');
{
  const record = registryStore.getById(declared.record.projectId);
  check('suppression refusée tant que PAIRED', await rejectsWith(
    () => Promise.resolve(registry.removeProject(record.projectId)),
    'PANEL_PROJECT_STILL_PAIRED',
  ));
  pairing.revokeFromPanel(record);
  check('fiche REVOKED', record.pairing.status === 'REVOKED');
  check('ancien token mort', pairing.authenticateBridgeToken(bootstrapResult.bridgeToken) === null);
  check('vivacité : NOT_PAIRED', registry.deriveLiveness(record) === 'NOT_PAIRED');
  check('manifest conservé après révocation', record.manifest !== null);

  const reissued = pairing.issuePairingCode(record);
  check('nouveau code émis après révocation', /^PAIR-/.test(reissued.code));
  const second = pairing.bootstrap(bootstrapDto(reissued.code, { softwareVersion: '1.5.0' }));
  check('ré-appairage réussi', registryStore.getById(record.projectId).pairing.status === 'PAIRED');
  check('nouveau token différent de l’ancien', second.bridgeToken !== bootstrapResult.bridgeToken);

  pairing.revokeFromPanel(record);
  const removal = registry.removeProject(record.projectId);
  check('retrait du parc après révocation', removal.removed === true
    && registryStore.getById(record.projectId) === null);
}

section('Codes expirés et projectKey trompeur');
{
  const other = registry.declareProject({ projectKey: 'projet-b', projectName: 'Projet B' });
  const record = registryStore.getById(other.record.projectId);
  check('bootstrap avec le bon code mais le mauvais projectKey refusé', await rejectsWith(
    () => Promise.resolve(pairing.bootstrap(bootstrapDto(other.pairingCode, { projectKey: 'projet-vole', projectName: 'X' }))),
    'BRIDGE_PAIRING_CODE_INVALID',
  ));
  record.pairing.pairingCodeExpiresAt = new Date(Date.now() - 1000).toISOString();
  check('code expiré refusé', await rejectsWith(
    () => Promise.resolve(pairing.bootstrap(bootstrapDto(other.pairingCode, { projectKey: 'projet-b' }))),
    'BRIDGE_PAIRING_CODE_INVALID',
  ));
  check('version majeure de contrat inconnue refusée au bootstrap', await rejectsWith(
    () => Promise.resolve(pairing.bootstrap(bootstrapDto(other.pairingCode, { projectKey: 'projet-b', contractVersion: '2.0.0' }))),
    'BRIDGE_CONTRACT_VERSION_UNSUPPORTED',
  ));
}

finish();
