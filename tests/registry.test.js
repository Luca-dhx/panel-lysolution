// Le registre + l'appairage au niveau service : un projet conforme au
// Manager Standard peut être déclaré, appairé, supervisé, révoqué, ré-appairé.
// Contrat 1.1.0 : le Manifest officiel voyage avec le bootstrap.
import { check, finish, rejectsWith, section, setTestEnv } from './helpers/harness.js';

setTestEnv();
process.env.HEARTBEAT_INTERVAL_S = '300';

const registry = await import('../backend/src/services/registry/projectRegistry.service.js');
const pairing = await import('../backend/src/services/pairing/pairing.service.js');
const { registryStore } = await import('../backend/src/services/registry/registryStore.js');
const { CONTRACT_VERSION } = await import('../backend/src/bridge/bridgeContract.js');

function conformManifest(overrides = {}) {
  return {
    manifestVersion: '1.0.0',
    project: {
      key: 'garage-exemple',
      name: 'Garage Exemple',
      environment: 'PROD',
      softwareVersion: 'abc1234',
      ...(overrides.project ?? {}),
    },
    bridge: { contractVersion: CONTRACT_VERSION, projectBridgeBasePath: '/api/project-bridge/v1' },
    contracts: { panelBridge: CONTRACT_VERSION, projectBridge: CONTRACT_VERSION },
    sync: { supportedEntityTypes: ['DIAGNOSTIC'], operations: [] },
    modules: [{ id: 'panel-bridge', title: 'Pont Panel', status: 'ACTIVE' }],
    features: [
      { id: 'sync.diagnostic', status: 'AVAILABLE' },
      { id: 'sync.contracts', status: 'AVAILABLE' },
      { id: 'sync.invoicing', status: 'RESERVED' },
    ],
  };
}

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

await registryStore.clear();

section('Déclaration d’un projet conforme au Manager Standard');
let declared;
{
  declared = await registry.declareProject({
    projectKey: 'garage-exemple',
    projectName: 'Garage Exemple',
    manifest: conformManifest(),
  });
  check('fiche créée en DECLARED', declared.record.pairing.status === 'DECLARED');
  check('projectId UUID délivré', /^[0-9a-f-]{36}$/.test(declared.record.projectId));
  check('code au format lisible PAIR-XXXX-XXXX-XXXX', /^PAIR-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(declared.pairingCode));
  check('le code n’est stocké qu’en hash', declared.record.pairing.pairingCodeHash !== declared.pairingCode
    && /^[0-9a-f]{64}$/.test(declared.record.pairing.pairingCodeHash));
  check('expiration posée', typeof declared.pairingCodeExpiresAt === 'string');
  check('manifest validé et conservé', declared.record.manifest.project.key === 'garage-exemple');
  check('manifest saisi manuellement → source MANUAL', declared.record.manifestSource === 'MANUAL');
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

section('Bootstrap (appairage) — avec Manifest 1.1 joint');
let bootstrapResult;
{
  check('Manifest joint dont project.key diverge → refus AVANT consommation du code', await rejectsWith(
    () => Promise.resolve(pairing.bootstrap(bootstrapDto(declared.pairingCode, {
      manifest: conformManifest({ project: { key: 'cle-volee' } }),
    }))),
    'BRIDGE_INVALID_PAYLOAD',
  ));

  bootstrapResult = await pairing.bootstrap(bootstrapDto(declared.pairingCode, {
    manifest: conformManifest(),
  }));
  check('le code n’a PAS été grillé par le refus précédent', typeof bootstrapResult.bridgeToken === 'string');
  check('bridgeToken délivré', bootstrapResult.bridgeToken.length === 64);
  check('projectId du registre renvoyé', bootstrapResult.projectId === declared.record.projectId);
  check('identité du Panel renvoyée', bootstrapResult.panel.contractVersion === CONTRACT_VERSION);

  const record = await registryStore.getById(declared.record.projectId);
  check('fiche PAIRED', record.pairing.status === 'PAIRED');
  check('Manifest du bootstrap conservé', record.manifest.project.key === 'garage-exemple');
  check('Manifest reçu par le pont → source BRIDGE', record.manifestSource === 'BRIDGE');
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

section('Le Manifest du pont fait foi : la saisie manuelle est verrouillée');
{
  check('PUT manuel refusé quand la source est BRIDGE', await rejectsWith(
    () => registry.updateManifest(declared.record.projectId, conformManifest()),
    'PANEL_MANIFEST_BRIDGE_AUTHORITATIVE',
  ));
}

section('Authentification par bridgeToken');
{
  const record = await pairing.authenticateBridgeToken(bootstrapResult.bridgeToken);
  check('token valide → fiche du projet', record?.projectKey === 'garage-exemple');
  check('token inconnu → null', (await pairing.authenticateBridgeToken('f'.repeat(64))) === null);
  check('token vide → null', (await pairing.authenticateBridgeToken('')) === null);
}

section('Conformité Manager Standard');
{
  const record = await registryStore.getById(declared.record.projectId);
  const conformity = registry.describeConformity(record);
  check('manifest présent', conformity.hasManifest === true);
  check('identité manifest ↔ registre cohérente', conformity.identityConsistent === true);
  check('appairé', conformity.paired === true);
  const tampered = {
    ...record,
    manifest: { ...record.manifest, project: { ...record.manifest.project, key: 'autre-cle' } },
  };
  check('divergence d’identité détectée', registry.describeConformity(tampered).identityConsistent === false);
}

section('Vivacité (dérivée, jamais stockée)');
{
  const record = await registryStore.getById(declared.record.projectId);
  check('appairé sans heartbeat : NEVER_SEEN', registry.deriveLiveness(record) === 'NEVER_SEEN');
  await registry.recordHeartbeat(record, {
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
  check('projection publique : features AVAILABLE interprétées',
    publicView.capabilities.enabled.includes('sync.contracts'));
  check('projection publique : features RESERVED visibles mais inertes',
    publicView.capabilities.reserved.includes('sync.invoicing')
    && !publicView.capabilities.enabled.includes('sync.invoicing'));
  check('module Panel dérivé des features', publicView.capabilities.panelModules.includes('contracts'));
  check('source du manifest exposée', publicView.manifestSource === 'BRIDGE');
}

section('Révocation et ré-appairage');
{
  const record = await registryStore.getById(declared.record.projectId);
  check('suppression refusée tant que PAIRED', await rejectsWith(
    () => Promise.resolve(registry.removeProject(record.projectId)),
    'PANEL_PROJECT_STILL_PAIRED',
  ));
  await pairing.revokeFromPanel(record);
  check('fiche REVOKED', record.pairing.status === 'REVOKED');
  check('ancien token mort', (await pairing.authenticateBridgeToken(bootstrapResult.bridgeToken)) === null);
  check('vivacité : NOT_PAIRED', registry.deriveLiveness(record) === 'NOT_PAIRED');
  check('manifest conservé après révocation', record.manifest !== null);

  const reissued = await pairing.issuePairingCode(record);
  check('nouveau code émis après révocation', /^PAIR-/.test(reissued.code));
  const second = await pairing.bootstrap(bootstrapDto(reissued.code, { softwareVersion: '1.5.0' }));
  check('ré-appairage réussi', (await registryStore.getById(record.projectId)).pairing.status === 'PAIRED');
  check('nouveau token différent de l’ancien', second.bridgeToken !== bootstrapResult.bridgeToken);
  check('bootstrap 1.1 SANS manifest accepté (champ optionnel)',
    (await registryStore.getById(record.projectId)).manifest !== null);

  await pairing.revokeFromPanel(record);
  const removal = await registry.removeProject(record.projectId);
  check('retrait du parc après révocation', removal.removed === true
    && (await registryStore.getById(record.projectId)) === null);
}

section('Codes expirés et projectKey trompeur');
{
  const other = await registry.declareProject({ projectKey: 'projet-b', projectName: 'Projet B' });
  const record = await registryStore.getById(other.record.projectId);
  check('bootstrap avec le bon code mais le mauvais projectKey refusé', await rejectsWith(
    () => Promise.resolve(pairing.bootstrap(bootstrapDto(other.pairingCode, { projectKey: 'projet-vole', projectName: 'X' }))),
    'BRIDGE_PAIRING_CODE_INVALID',
  ));
  record.pairing.pairingCodeExpiresAt = new Date(Date.now() - 1000).toISOString();
  await registryStore.save(record);
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
