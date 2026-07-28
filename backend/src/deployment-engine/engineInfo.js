/**
 * INTROSPECTION DU MOTEUR — le moteur sait répondre à trois questions :
 *
 *   « qui suis-je ? »                → describeEngine()
 *   « quelles capacités ai-je ? »    → hasCapability() / capabilities
 *   « avec quoi suis-je compatible ?» → isProfileSupported(), isEngineCompatible()
 *
 * C'est ce qui permet à un projet embarquant un moteur ancien de savoir, sans
 * lire le code, ce dont il dispose — et à un outil de décider s'il peut le
 * piloter.
 *
 * Ce module ne dépend que du manifeste et du profil : il reste chargeable
 * même si le reste du moteur ne l'est pas.
 */
import { createRequire } from 'node:module';
import { PROJECT_SLUG } from './config/project.profile.js';

const require = createRequire(import.meta.url);
const manifest = require('./engine.manifest.json');

/** Champs obligatoires d'un manifeste de moteur (Phase 2E). */
export const REQUIRED_MANIFEST_FIELDS = Object.freeze([
  'engine',
  'version',
  'engineApiVersion',
  'contractVersion',
  'minimumCompatibleVersion',
  'layoutVersion',
  'releaseDate',
  'supportedProfiles',
  'capabilities',
  'breakingChanges',
]);

const SEMVER_RE = /^(\d+)\.(\d+)\.(\d+)$/;

export function parseVersion(value) {
  const m = SEMVER_RE.exec(String(value ?? '').trim());
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) };
}

/** Compare deux versions sémantiques : -1, 0, 1, ou null si l'une est invalide. */
export function compareVersions(a, b) {
  const va = parseVersion(a);
  const vb = parseVersion(b);
  if (!va || !vb) return null;
  for (const part of ['major', 'minor', 'patch']) {
    if (va[part] !== vb[part]) return va[part] < vb[part] ? -1 : 1;
  }
  return 0;
}

/** « Qui suis-je ? » — carte d'identité complète du moteur embarqué. */
export function describeEngine() {
  return {
    engine: manifest.engine,
    version: manifest.version,
    engineApiVersion: manifest.engineApiVersion,
    contractVersion: manifest.contractVersion,
    minimumCompatibleVersion: manifest.minimumCompatibleVersion,
    layoutVersion: manifest.layoutVersion,
    releaseDate: manifest.releaseDate,
    supportedProfiles: [...(manifest.supportedProfiles ?? [])],
    capabilities: [...(manifest.capabilities ?? [])],
    breakingChanges: [...(manifest.breakingChanges ?? [])],
    // Le profil réellement embarqué dans CE projet.
    activeProfile: PROJECT_SLUG,
  };
}

/** « Quelles capacités ai-je ? » */
export function hasCapability(name) {
  return (manifest.capabilities ?? []).includes(name);
}

/** Le profil de ce projet fait-il partie des profils validés ? */
export function isProfileSupported(profile = PROJECT_SLUG) {
  return (manifest.supportedProfiles ?? []).includes(profile);
}

/**
 * « Avec quelles versions suis-je compatible ? »
 *
 * Un moteur de version V peut piloter un projet dont l'état a été produit par
 * une version W si :
 *   - W ≥ `minimumCompatibleVersion` (rien de trop ancien) ;
 *   - W ≤ V (on ne pilote pas un état produit par un moteur plus récent) ;
 *   - même MAJEURE (une majeure est une rupture, par définition).
 */
export function isEngineCompatible(otherVersion) {
  const other = parseVersion(otherVersion);
  const self = parseVersion(manifest.version);
  if (!other || !self) return { compatible: false, reason: 'VERSION_INVALID' };
  if (other.major !== self.major) {
    return { compatible: false, reason: 'MAJOR_MISMATCH', expected: self.major, got: other.major };
  }
  if (compareVersions(otherVersion, manifest.minimumCompatibleVersion) < 0) {
    return { compatible: false, reason: 'TOO_OLD', minimum: manifest.minimumCompatibleVersion };
  }
  if (compareVersions(otherVersion, manifest.version) > 0) {
    return { compatible: false, reason: 'TOO_RECENT', engineVersion: manifest.version };
  }
  return { compatible: true };
}

/**
 * Validation du manifeste lui-même — un moteur sans version, ou au manifeste
 * incomplet, est un défaut de standardisation (LOT 4 : « ne jamais laisser un
 * moteur sans version »).
 */
export function validateManifest(input = manifest) {
  const errors = [];
  for (const field of REQUIRED_MANIFEST_FIELDS) {
    if (input[field] === undefined || input[field] === null) errors.push(`champ manquant : ${field}`);
  }
  if (input.version && !parseVersion(input.version)) errors.push('version : semver attendu (x.y.z)');
  if (input.minimumCompatibleVersion && !parseVersion(input.minimumCompatibleVersion)) {
    errors.push('minimumCompatibleVersion : semver attendu (x.y.z)');
  }
  if (input.version && input.minimumCompatibleVersion
      && compareVersions(input.minimumCompatibleVersion, input.version) > 0) {
    errors.push('minimumCompatibleVersion ne peut pas être supérieure à version');
  }
  if (input.capabilities && !Array.isArray(input.capabilities)) errors.push('capabilities : tableau attendu');
  if (input.supportedProfiles && !Array.isArray(input.supportedProfiles)) errors.push('supportedProfiles : tableau attendu');
  if (input.breakingChanges && !Array.isArray(input.breakingChanges)) errors.push('breakingChanges : tableau attendu');
  if (input.releaseDate && !/^\d{4}-\d{2}-\d{2}$/.test(input.releaseDate)) {
    errors.push('releaseDate : format AAAA-MM-JJ attendu');
  }
  return { valid: errors.length === 0, errors };
}

export const ENGINE_MANIFEST = Object.freeze({ ...manifest });

export default {
  describeEngine,
  hasCapability,
  isProfileSupported,
  isEngineCompatible,
  validateManifest,
  compareVersions,
  parseVersion,
  ENGINE_MANIFEST,
  REQUIRED_MANIFEST_FIELDS,
};
