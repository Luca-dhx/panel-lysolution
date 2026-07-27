// Validation du Manifest officiel « ProjectManifest » — schéma IDENTIQUE aux
// deux specs OpenAPI v1.1.0 (docs/spec/), miroir exécutable dans
// backend/src/bridge/bridgeContract.js.
// Lecteur tolérant : les propriétés additionnelles d'un format mineur plus
// récent sont acceptées ; les modules/features hors catalogue sont acceptés
// et signalés, jamais refusés ; seule une MAJEURE de format inconnue est
// refusée.
import { MANIFEST_FORMAT_VERSION, projectManifestSchema } from '../../bridge/bridgeContract.js';
import { KNOWN_FEATURES } from './capabilities.catalog.js';

export { MANIFEST_FORMAT_VERSION };

export const manifestSchema = projectManifestSchema;

// Valide un Manifest. Retourne toujours un objet — jamais d'exception :
//   { valid: true,  manifest, unknownFeatures: string[] }
//   { valid: false, errors: [{ path, code, message }] }
export function validateManifest(input) {
  const parsed = manifestSchema.safeParse(input);
  if (!parsed.success) {
    return {
      valid: false,
      errors: parsed.error.issues.map((issue) => ({
        path: issue.path.join('.'),
        code: issue.code,
        message: issue.message,
      })),
    };
  }

  const manifest = parsed.data;
  const declaredMajor = manifest.manifestVersion.split('.')[0];
  const supportedMajor = MANIFEST_FORMAT_VERSION.split('.')[0];
  if (declaredMajor !== supportedMajor) {
    return {
      valid: false,
      errors: [
        {
          path: 'manifestVersion',
          code: 'MANIFEST_VERSION_UNSUPPORTED',
          message: `Version majeure de Manifest non supportée (reçu ${manifest.manifestVersion}, supporté ${MANIFEST_FORMAT_VERSION}).`,
        },
      ],
    };
  }

  const unknownFeatures = manifest.features
    .map((feature) => feature.id)
    .filter((id) => !KNOWN_FEATURES.includes(id));
  return { valid: true, manifest, unknownFeatures };
}
