// Interprétation des capacités déclarées par le ProjectManifest — les règles
// de 21_PROJECT_CAPABILITIES §3 : le Panel n'affiche que ce qui existe.
import { check, finish, section, setTestEnv } from './helpers/harness.js';

setTestEnv();

const { interpretCapabilities } = await import(
  '../backend/src/services/manifest/capabilities.service.js'
);
const { FEATURES_CATALOG, KNOWN_FEATURES } = await import(
  '../backend/src/services/manifest/capabilities.catalog.js'
);

function manifestWith({ features = [], modules = [], sync } = {}) {
  return {
    manifestVersion: '1.0.0',
    project: { key: 'proj-test', name: 'Projet test', environment: 'TEST', softwareVersion: 'dev' },
    bridge: { contractVersion: '1.1.0', projectBridgeBasePath: '/api/project-bridge/v1' },
    contracts: { panelBridge: '1.1.0', projectBridge: '1.1.0' },
    sync: sync ?? { supportedEntityTypes: ['DIAGNOSTIC'], operations: [] },
    modules,
    features,
  };
}

section('Catalogue');
{
  const expected = [
    'sync.diagnostic', 'sync.contracts', 'sync.invoicing', 'sync.dev-company',
    'sync.email-templates', 'sync.integrated-api-config', 'sync.events-meetings',
    'operations.catalog', 'manager-access-grant',
  ];
  check('au moins 9 features officielles', KNOWN_FEATURES.length >= 9);
  check('toutes les features du projet modèle présentes', expected.every((c) => KNOWN_FEATURES.includes(c)));
  check('chaque entrée a label + panelModules', Object.values(FEATURES_CATALOG).every(
    (entry) => typeof entry.label === 'string' && Array.isArray(entry.panelModules),
  ));
}

section('Règle : Manifest absent = rien d’activé');
{
  const result = interpretCapabilities(null);
  check('aucune feature active', result.enabled.length === 0);
  check('aucun module Panel', result.panelModules.length === 0);
  check('aucun entityType supporté', result.sync.supportedEntityTypes.length === 0);
}

section('Règle : seul AVAILABLE active — RESERVED est visible mais inerte');
{
  const result = interpretCapabilities(manifestWith({
    features: [
      { id: 'sync.contracts', status: 'AVAILABLE' },
      { id: 'sync.invoicing', status: 'RESERVED' },
    ],
  }));
  check('AVAILABLE dans enabled', result.enabled.includes('sync.contracts'));
  check('RESERVED hors de enabled', !result.enabled.includes('sync.invoicing'));
  check('RESERVED listé séparément', result.reserved.includes('sync.invoicing'));
  check('module Panel dérivé du seul AVAILABLE',
    result.panelModules.includes('contracts') && !result.panelModules.includes('invoices'));
}

section('Règle : inconnue = tolérée, signalée, ignorée');
{
  const result = interpretCapabilities(manifestWith({
    features: [
      { id: 'sync.contracts', status: 'AVAILABLE' },
      { id: 'sync.loyalty-program', status: 'AVAILABLE' },
    ],
  }));
  check('inconnue listée', result.unknown.includes('sync.loyalty-program'));
  check('inconnue absente de enabled', !result.enabled.includes('sync.loyalty-program'));
  check('inconnue sans effet sur panelModules', result.panelModules.every((m) => m === 'contracts'));
}

section('Modules du projet : ACTIVE / OPTIONAL restitués, jamais inventés');
{
  const result = interpretCapabilities(manifestWith({
    modules: [
      { id: 'vitrine', title: 'Vitrine', status: 'ACTIVE' },
      { id: 'yousign-signature', title: 'Signature', status: 'OPTIONAL' },
    ],
  }));
  check('modules actifs', result.projectModules.active.includes('vitrine'));
  check('modules optionnels', result.projectModules.optional.includes('yousign-signature'));
  check('un module ne crée jamais une feature', result.enabled.length === 0);
}

section('Sync : dérivé du Manifest, jamais déduit');
{
  const result = interpretCapabilities(manifestWith({
    sync: { supportedEntityTypes: ['DIAGNOSTIC', 'CONTRACT'], operations: ['contracts.reconcile'] },
  }));
  check('entityTypes restitués', result.sync.supportedEntityTypes.includes('CONTRACT'));
  check('opérations restituées', result.sync.operations.includes('contracts.reconcile'));
}

finish();
