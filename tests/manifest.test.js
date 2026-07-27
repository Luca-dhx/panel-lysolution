// Le Manifest « Manager Standard » : validation stricte, lecteur tolérant.
import { check, finish, section, setTestEnv } from './helpers/harness.js';

setTestEnv();

const { MANIFEST_FORMAT_VERSION, validateManifest } = await import(
  '../backend/src/services/manifest/manifest.schema.js'
);

function baseManifest() {
  return {
    manifestVersion: '1.0.0',
    project: {
      projectKey: 'projet-conforme',
      projectName: 'Projet conforme',
      softwareVersion: '1.4.2',
      contractVersion: '1.0.0',
      environment: 'PROD',
    },
    capabilities: {
      supportsContracts: true,
      supportsInvoices: true,
      supportsBookings: false,
    },
    modules: [{ id: 'company', label: 'Entreprise' }],
  };
}

section('Manifest valide');
{
  const result = validateManifest(baseManifest());
  check('accepté', result.valid === true);
  check('aucune capacité inconnue', result.unknownCapabilities.length === 0);
  check('manifest restitué intact', result.manifest.project.projectKey === 'projet-conforme');
}

section('Champs optionnels');
{
  const manifest = baseManifest();
  delete manifest.capabilities;
  delete manifest.modules;
  const result = validateManifest(manifest);
  check('capabilities et modules optionnels', result.valid === true);
}

section('Lecteur tolérant : capacités inconnues');
{
  const manifest = baseManifest();
  manifest.capabilities.supportsLoyaltyProgram = true;
  const result = validateManifest(manifest);
  check('acceptée (jamais un refus)', result.valid === true);
  check('signalée dans unknownCapabilities', result.unknownCapabilities.includes('supportsLoyaltyProgram'));
}

section('Refus propres');
{
  const nonBool = baseManifest();
  nonBool.capabilities.supportsContracts = 'yes';
  check('capacité non booléenne refusée', validateManifest(nonBool).valid === false);

  const badVersion = baseManifest();
  badVersion.manifestVersion = '2.0.0';
  const resultVersion = validateManifest(badVersion);
  check('majeure de format inconnue refusée', resultVersion.valid === false);
  check(
    '…avec le code MANIFEST_VERSION_UNSUPPORTED',
    resultVersion.errors.some((e) => e.code === 'MANIFEST_VERSION_UNSUPPORTED'),
  );

  const missingProject = baseManifest();
  delete missingProject.project.softwareVersion;
  check('champ projet manquant refusé', validateManifest(missingProject).valid === false);

  const extraKey = baseManifest();
  extraKey.surprise = true;
  check('clé racine inconnue refusée (strict)', validateManifest(extraKey).valid === false);

  const badEnv = baseManifest();
  badEnv.project.environment = 'STAGING';
  check('environment hors TEST/PROD refusé', validateManifest(badEnv).valid === false);

  check('null refusé sans exception', validateManifest(null).valid === false);
  check('erreurs structurées {path, code, message}', validateManifest(null).errors.every(
    (e) => 'path' in e && 'code' in e && 'message' in e,
  ));
}

section('Version de format supportée');
{
  check('le format supporté est 1.x', MANIFEST_FORMAT_VERSION.startsWith('1.'));
  const minor = baseManifest();
  minor.manifestVersion = '1.9.0';
  check('mineure supérieure acceptée (additive)', validateManifest(minor).valid === true);
}

finish();
