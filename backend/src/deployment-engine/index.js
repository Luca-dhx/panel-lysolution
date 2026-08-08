/**
 * Point d'entrée public du moteur de déploiement (UI-agnostic).
 *
 * Réexporte la façade + les briques utiles. Consommateurs : routes API, future
 * CLI, panel multi-sites. Aucune logique React ici.
 */
export { DeploymentEngine, default } from './DeploymentEngine.js';
export { parseTargetUrl, wildcardBasesFromEnv, DEFAULT_WILDCARD_BASES } from './url.js';
export { runPreflight } from './preflight.js';
export { runPipeline, PIPELINE_STEPS } from './pipeline.js';
export { getProjectVersion, buildArtifact } from './build.js';
export {
  duplicateProject,
  validateDuplicationInput,
  rewriteEnv,
  sanitizeFolderName,
} from '../duplication-engine/duplication.js';
export { createBackup, restoreBackup, listBackups } from './backup.js';
export { renderNginxConfig, applyNginxConfig } from './nginx.js';
export { ensureCertificate } from './certbot.js';
export { restartBackend, pm2AppName } from './pm2.js';
export {
  PORT_ERRORS,
  PORT_RANGE,
  NEVER_ALLOCATE,
  readListeningSockets,
  readPm2Processes,
  readPortLandscape,
  probePort,
  findFreePort,
  assertPortAvailableFor,
  verifyServiceHealth,
} from './ports.js';
export { checkLocalHealth, checkPublicHealth } from './health.js';
export { rollbackToRelease, listReleases, currentRelease, verifyReleaseIntegrity } from './rollback.js';
export {
  DEPROVISION_STEPS,
  DEPROVISION_STEP_IDS,
  DESTINATION_DELETE_STEPS,
  DESTINATION_DELETE_STEP_IDS,
  DESTINATION_DELETE_REMOTE_STEP_IDS,
  runDestinationDelete,
  NEVER_DELETE,
  assertSafeSiteRoot,
  renderNginxQuarantine,
  quarantineConfigPath,
  quarantineEnabledPath,
  applyQuarantine,
  removeQuarantine,
  removeApplicationSite,
  inspectDestination,
  runDeprovision,
} from './deprovision.js';
export { planSites, servedHosts } from './nginx.js';
export { Transport, execOrThrow } from './transport/Transport.js';
export { FakeTransport } from './transport/FakeTransport.js';
export { SshTransport } from './transport/SshTransport.js';
export * as passwordVault from './passwordVault.js';
export { DeploymentError, PreflightError, ValidationError } from './errors.js';
