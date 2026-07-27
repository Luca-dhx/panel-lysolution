// Catalogue officiel des features des projets vitrines — code-first, la
// référence de docs/architecture/21_PROJECT_CAPABILITIES.md §2.
// Les identifiants correspondent aux `features[].id` du ProjectManifest
// (specs v1.1.0). Évolution ADDITIVE uniquement : on ajoute, on ne renomme
// ni ne supprime.
// `panelModules` : modules d'interface du Panel que la feature activera
// (Phase 3+) — vide quand la feature n'a pas (encore) d'écran côté Panel.
export const FEATURES_CATALOG = Object.freeze({
  'sync.diagnostic': { label: 'Synchronisation — diagnostic', panelModules: [] },
  'sync.contracts': { label: 'Synchronisation — contrats', panelModules: ['contracts'] },
  'sync.invoicing': { label: 'Synchronisation — facturation', panelModules: ['invoices'] },
  'sync.dev-company': { label: 'Synchronisation — société développeur', panelModules: ['dev-company'] },
  'sync.email-templates': { label: 'Synchronisation — templates e-mails', panelModules: ['email-templates'] },
  'sync.integrated-api-config': { label: 'Synchronisation — IntegratedAPI', panelModules: ['integrated-api'] },
  'sync.events-meetings': { label: 'Synchronisation — événements & réunions', panelModules: ['events'] },
  'operations.catalog': { label: 'Catalogue d’opérations invocables', panelModules: [] },
  'manager-access-grant': { label: 'Accès Manager délégué', panelModules: [] },
});

export const KNOWN_FEATURES = Object.freeze(Object.keys(FEATURES_CATALOG));

export default FEATURES_CATALOG;
