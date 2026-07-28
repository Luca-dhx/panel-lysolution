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
export { checkLocalHealth, checkPublicHealth } from './health.js';
export { rollbackToRelease, listReleases, currentRelease, verifyReleaseIntegrity } from './rollback.js';
export { planSites, servedHosts } from './nginx.js';
export { Transport, execOrThrow } from './transport/Transport.js';
export { FakeTransport } from './transport/FakeTransport.js';
export { SshTransport } from './transport/SshTransport.js';
export * as passwordVault from './passwordVault.js';
export { DeploymentError, PreflightError, ValidationError } from './errors.js';
