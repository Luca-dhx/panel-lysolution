// Interprétation des capacités — les règles de 21_PROJECT_CAPABILITIES §3.
import { check, finish, section, setTestEnv } from './helpers/harness.js';

setTestEnv();

const { interpretCapabilities } = await import(
  '../backend/src/services/manifest/capabilities.service.js'
);
const { CAPABILITIES_CATALOG, KNOWN_CAPABILITIES } = await import(
  '../backend/src/services/manifest/capabilities.catalog.js'
);

function manifestWith(capabilities) {
  return {
    manifestVersion: '1.0.0',
    project: {
      projectKey: 'proj-test',
      projectName: 'Projet test',
      softwareVersion: '1.0.0',
      contractVersion: '1.0.0',
      environment: 'TEST',
    },
    capabilities,
  };
}

section('Catalogue');
{
  check('au moins 11 capacités officielles', KNOWN_CAPABILITIES.length >= 11);
  const expected = [
    'supportsCompany', 'supportsServices', 'supportsBookings', 'supportsGallery',
    'supportsContracts', 'supportsInvoices', 'supportsPayments',
    'supportsStripe', 'supportsBrevo', 'supportsYousign', 'supportsCRM',
  ];
  check('toutes les capacités attendues présentes', expected.every((c) => KNOWN_CAPABILITIES.includes(c)));
  check('chaque entrée a label + panelModules', Object.values(CAPABILITIES_CATALOG).every(
    (entry) => typeof entry.label === 'string' && Array.isArray(entry.panelModules),
  ));
}

section('Règle : Manifest absent = tout à false');
{
  const result = interpretCapabilities(null);
  check('aucune capacité active', result.enabled.length === 0);
  check('aucun module Panel', result.panelModules.length === 0);
  check('le catalogue complet est résolu à false', KNOWN_CAPABILITIES.every((c) => result.known[c] === false));
}

section('Règle : absent = false');
{
  const result = interpretCapabilities(manifestWith({ supportsContracts: true }));
  check('supportsContracts active', result.known.supportsContracts === true);
  check('supportsCRM (non déclarée) inactive', result.known.supportsCRM === false);
  check('enabled = exactement ce qui est à true', result.enabled.length === 1 && result.enabled[0] === 'supportsContracts');
}

section('Règle : inconnue = tolérée, signalée, ignorée');
{
  const result = interpretCapabilities(
    manifestWith({ supportsContracts: true, supportsLoyaltyProgram: true }),
  );
  check('inconnue listée', result.unknown.includes('supportsLoyaltyProgram'));
  check('inconnue absente de enabled', !result.enabled.includes('supportsLoyaltyProgram'));
  check('inconnue sans effet sur panelModules', result.panelModules.every((m) => m === 'contracts'));
}

section('Dérivation des modules Panel');
{
  const result = interpretCapabilities(
    manifestWith({
      supportsContracts: true,
      supportsInvoices: true,
      supportsStripe: true,
      supportsBrevo: true,
      supportsServices: true,
    }),
  );
  check('contracts activé', result.panelModules.includes('contracts'));
  check('invoices activé', result.panelModules.includes('invoices'));
  check('integrated-api dédupliqué (Stripe + Brevo → une entrée)',
    result.panelModules.filter((m) => m === 'integrated-api').length === 1);
  check('catégorie 1 (services) : aucun module Panel', !result.panelModules.includes('services'));
  const explicitFalse = interpretCapabilities(manifestWith({ supportsCRM: false }));
  check('false explicite = inactif', !explicitFalse.panelModules.includes('crm'));
}

finish();
