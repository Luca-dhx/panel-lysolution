// Écrit le domaine choisi dans la configuration système du Panel.
// Appelé par le moteur de déploiement (étape runtime.network) : c'est le
// point unique où un déploiement propage son domaine — aucune édition
// manuelle dispersée.
//
// Usage :
//   node scripts/set-network-configuration.mjs --backend-url https://… --frontend-url https://…
import { connectDatabase, disconnectDatabase } from '../src/config/db.js';
import { updateNetworkConfiguration, getSystemConfiguration } from '../src/services/network/networkConfig.service.js';
import logger from '../src/utils/logger.js';

function readFlag(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

const backendUrl = readFlag('backend-url');
const frontendUrl = readFlag('frontend-url');

if (!backendUrl && !frontendUrl) {
  console.error('Usage : node scripts/set-network-configuration.mjs --backend-url <url> [--frontend-url <url>]');
  process.exit(1);
}

try {
  await connectDatabase();
  await updateNetworkConfiguration({ backendUrl, frontendUrl }, { updatedBy: 'deployment' });

  // Relecture : on ne se fie jamais à l'écriture seule (même discipline que
  // la relecture du .env distant côté déploiement).
  const configuration = await getSystemConfiguration();
  if (backendUrl && configuration.network.backendUrl !== backendUrl) {
    throw new Error('Relecture incohérente : backendUrl non enregistrée.');
  }
  if (frontendUrl && configuration.network.frontendUrl !== frontendUrl) {
    throw new Error('Relecture incohérente : frontendUrl non enregistrée.');
  }
  logger.success(
    `Configuration réseau enregistrée (backend ${configuration.network.backendUrl}, frontend ${configuration.network.frontendUrl}).`,
  );
  await disconnectDatabase();
  process.exit(0);
} catch (err) {
  logger.error(`Configuration réseau impossible : ${err.message}`);
  await disconnectDatabase().catch(() => {});
  process.exit(1);
}
