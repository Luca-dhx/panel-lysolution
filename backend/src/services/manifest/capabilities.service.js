// Interprétation des capacités — les règles de
// docs/architecture/21_PROJECT_CAPABILITIES.md §3, implémentées une fois.
// Fonction pure : jamais mise en cache, jamais stockée — recalculée à la
// lecture depuis le Manifest.
import { CAPABILITIES_CATALOG, KNOWN_CAPABILITIES } from './capabilities.catalog.js';

export function interpretCapabilities(manifest) {
  const declared = manifest?.capabilities ?? {};

  // Règle 2 et 3 : absent = false ; Manifest absent = tout à false.
  const known = {};
  for (const name of KNOWN_CAPABILITIES) {
    known[name] = declared[name] === true;
  }

  const enabled = KNOWN_CAPABILITIES.filter((name) => known[name]);

  // Règle 4 : inconnue = tolérée, signalée, ignorée par l'interprétation.
  const unknown = Object.keys(declared).filter((name) => !KNOWN_CAPABILITIES.includes(name));

  const panelModules = [
    ...new Set(enabled.flatMap((name) => CAPABILITIES_CATALOG[name].panelModules)),
  ];

  return { known, enabled, unknown, panelModules };
}

export default interpretCapabilities;
