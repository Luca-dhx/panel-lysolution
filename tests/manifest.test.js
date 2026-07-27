// Le ProjectManifest officiel (specs v1.1.0) : validation stricte des champs
// requis, lecteur tolérant pour le reste.
import { check, finish, section, setTestEnv } from './helpers/harness.js';

setTestEnv();

const { MANIFEST_FORMAT_VERSION, validateManifest } = await import(
  '../backend/src/services/manifest/manifest.schema.js'
);

function baseManifest() {
  return {
    manifestVersion: '1.0.0',
    project: {
      key: 'projet-conforme',
      name: 'Projet conforme',
      environment: 'PROD',
      softwareVersion: 'abc1234',
    },
    bridge: {
      contractVersion: '1.1.0',
      projectBridgeBasePath: '/api/project-bridge/v1',
    },
    contracts: { panelBridge: '1.1.0', projectBridge: '1.1.0' },
    sync: { supportedEntityTypes: ['DIAGNOSTIC'], operations: [] },
    modules: [
      { id: 'vitrine', title: 'Vitrine', status: 'ACTIVE' },
      { id: 'panel-bridge', title: 'Pont Panel', status: 'ACTIVE' },
      { id: 'yousign-signature', title: 'Signature Yousign', status: 'OPTIONAL' },
    ],
    features: [
      { id: 'sync.diagnostic', status: 'AVAILABLE' },
      { id: 'sync.contracts', status: 'RESERVED' },
      { id: 'operations.catalog', status: 'AVAILABLE' },
    ],
  };
}

section('Manifest officiel valide');
{
  const result = validateManifest(baseManifest());
  check('accepté', result.valid === true);
  check('aucune feature inconnue', result.unknownFeatures.length === 0);
  check('manifest restitué intact', result.manifest.project.key === 'projet-conforme');
  check('softwareVersion est un SHA libre (pas un semver imposé)',
    result.manifest.project.softwareVersion === 'abc1234');
}

section('Les 7 champs racine sont tous requis');
{
  for (const field of ['manifestVersion', 'project', 'bridge', 'contracts', 'sync', 'modules', 'features']) {
    const manifest = baseManifest();
    delete manifest[field];
    check(`${field} manquant refusé`, validateManifest(manifest).valid === false);
  }
}

section('Lecteur tolérant');
{
  const extraRoot = baseManifest();
  extraRoot.futureField = { additive: true };
  check('propriété racine additive (mineure future) tolérée', validateManifest(extraRoot).valid === true);

  const unknownFeature = baseManifest();
  unknownFeature.features.push({ id: 'sync.loyalty-program', status: 'AVAILABLE' });
  const result = validateManifest(unknownFeature);
  check('feature hors catalogue acceptée (jamais un refus)', result.valid === true);
  check('…signalée dans unknownFeatures', result.unknownFeatures.includes('sync.loyalty-program'));

  const minor = baseManifest();
  minor.manifestVersion = '1.9.0';
  check('mineure de format supérieure acceptée (additive)', validateManifest(minor).valid === true);
}

section('Refus propres');
{
  const badVersion = baseManifest();
  badVersion.manifestVersion = '2.0.0';
  const resultVersion = validateManifest(badVersion);
  check('majeure de format inconnue refusée', resultVersion.valid === false);
  check(
    '…avec le code MANIFEST_VERSION_UNSUPPORTED',
    resultVersion.errors.some((e) => e.code === 'MANIFEST_VERSION_UNSUPPORTED'),
  );

  const missingKey = baseManifest();
  delete missingKey.project.key;
  check('project.key manquant refusé', validateManifest(missingKey).valid === false);

  const badEnv = baseManifest();
  badEnv.project.environment = 'STAGING';
  check('environment hors TEST/PROD refusé', validateManifest(badEnv).valid === false);

  const badModuleStatus = baseManifest();
  badModuleStatus.modules[0].status = 'ENABLED';
  check('module.status hors ACTIVE/OPTIONAL refusé', validateManifest(badModuleStatus).valid === false);

  const badFeatureStatus = baseManifest();
  badFeatureStatus.features[0].status = 'ON';
  check('feature.status hors AVAILABLE/RESERVED refusé', validateManifest(badFeatureStatus).valid === false);

  const badEntityType = baseManifest();
  badEntityType.sync.supportedEntityTypes = ['PIZZA'];
  check('entityType hors enum du contrat refusé', validateManifest(badEntityType).valid === false);

  check('null refusé sans exception', validateManifest(null).valid === false);
  check('erreurs structurées {path, code, message}', validateManifest(null).errors.every(
    (e) => 'path' in e && 'code' in e && 'message' in e,
  ));
}

section('Version de format supportée');
{
  check('le format supporté est 1.x', MANIFEST_FORMAT_VERSION.startsWith('1.'));
}

finish();
