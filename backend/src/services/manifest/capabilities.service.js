// Interprétation des capacités déclarées par un ProjectManifest — les règles
// de docs/architecture/21_PROJECT_CAPABILITIES.md §3, implémentées une fois.
// Fonction pure : jamais mise en cache, jamais stockée — recalculée à la
// lecture depuis le Manifest.
//
// Le Panel n'affiche que ce qui existe :
//  - une feature AVAILABLE est activable ; RESERVED est visible mais inerte ;
//  - un module ACTIVE est installé ; OPTIONAL est présent mais désactivé ;
//  - une feature hors catalogue est tolérée, signalée, ignorée ;
//  - Manifest absent = rien d'activé (projet opaque, socle uniquement).
import { FEATURES_CATALOG, KNOWN_FEATURES } from './capabilities.catalog.js';

export function interpretCapabilities(manifest) {
  const features = manifest?.features ?? [];
  const modules = manifest?.modules ?? [];

  const available = features.filter((f) => f.status === 'AVAILABLE').map((f) => f.id);
  const reserved = features.filter((f) => f.status === 'RESERVED').map((f) => f.id);
  const unknown = features.map((f) => f.id).filter((id) => !KNOWN_FEATURES.includes(id));

  // `enabled` = features AVAILABLE connues du catalogue — la seule base
  // d'activation de modules du Panel.
  const enabled = available.filter((id) => KNOWN_FEATURES.includes(id));

  const panelModules = [
    ...new Set(enabled.flatMap((id) => FEATURES_CATALOG[id].panelModules)),
  ];

  return {
    enabled,
    reserved,
    unknown,
    panelModules,
    projectModules: {
      active: modules.filter((m) => m.status === 'ACTIVE').map((m) => m.id),
      optional: modules.filter((m) => m.status === 'OPTIONAL').map((m) => m.id),
    },
    sync: {
      supportedEntityTypes: manifest?.sync?.supportedEntityTypes ?? [],
      operations: manifest?.sync?.operations ?? [],
    },
  };
}

export default interpretCapabilities;
