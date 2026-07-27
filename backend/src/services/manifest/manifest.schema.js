// Validation du Manifest « Manager Standard » —
// docs/architecture/20_MANAGER_STANDARD.md §3.
// Lecteur tolérant : les capacités inconnues sont acceptées et signalées,
// jamais refusées ; seule une majeure de format inconnue est refusée.
import { z } from 'zod';
import { KNOWN_CAPABILITIES } from './capabilities.catalog.js';

export const MANIFEST_FORMAT_VERSION = '1.0.0';

const SEMVER_RE = /^\d+\.\d+\.\d+$/;
const semver = z.string().regex(SEMVER_RE, 'version sémantique attendue (x.y.z)');

export const manifestSchema = z
  .object({
    manifestVersion: semver,
    project: z
      .object({
        projectKey: z.string().min(3).max(120),
        projectName: z.string().min(1),
        softwareVersion: semver,
        contractVersion: semver,
        environment: z.enum(['TEST', 'PROD']),
      })
      .strict(),
    // Booléens uniquement ; les clés hors catalogue sont tolérées (lecteur
    // tolérant) et remontées dans `unknownCapabilities`.
    capabilities: z.record(z.string().min(1), z.boolean()).optional(),
    modules: z
      .array(
        z
          .object({
            id: z.string().min(1),
            label: z.string().min(1),
          })
          .strict(),
      )
      .optional(),
  })
  .strict();

// Valide un Manifest. Retourne toujours un objet — jamais d'exception :
//   { valid: true,  manifest, unknownCapabilities: string[] }
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

  const unknownCapabilities = Object.keys(manifest.capabilities ?? {}).filter(
    (name) => !KNOWN_CAPABILITIES.includes(name),
  );
  return { valid: true, manifest, unknownCapabilities };
}
