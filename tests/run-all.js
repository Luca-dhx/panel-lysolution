// Enchaîne toute la suite (équivalent du `npm test` chaîné du projet modèle).
// Chaque test est un processus séparé : isolation totale des stores en RAM.
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const testsDir = path.dirname(fileURLToPath(import.meta.url));

const TESTS = [
  'config.test.js',
  'auth.test.js',
  'version-compatibility.test.js',
  'manifest.test.js',
  'capabilities.test.js',
  'registry.test.js',
  'project-identity.test.js',
  'project-destination.test.js',
  'project-creation.test.js',
  'domains.test.js',
  'persistence.test.js',
  'bridge-http.test.js',
  'bridge-conformity.test.js',
  'contract-actions.test.js',
  'events.test.js',
  'panel-ui.test.js',
  'panel-meetings-ui.test.js',
  'panel-timeline-ui.test.js',
  'generation-change.test.js',
  'project-connections.test.js',
  'panel-instance-environment.test.js',
  'panel-branding.test.js',
  'developer-branding-propagation.test.js',
  'developer-branding-instance-ack-e2e.test.js',
  // Cross-dépôt : un vrai SB Auto, dans son processus, tire et applique.
  'real-panel-sbauto-branding-ack-e2e.test.js',
  // Un enregistrement, et la page « Aide » du projet suit — sans second geste.
  'panel-company-save-to-help-e2e.test.js',
  // L4 — le Panel LIVRE au lieu d'attendre que le projet tire ; le journal
  // durable reste la source de vérité, et le tirage la réparation.
  'panel-to-project-event-driven-e2e.test.js',
  // L8 — l'état du site devient une projection vivante ; plus aucune lecture
  // métier directe depuis un écran du Panel.
  'project-site-status-live-e2e.test.js',
  // L1/L2 — le contrat de présentation avec médias, et le sort d'un refus.
  'project-presentation-media-contract-e2e.test.js',
  'payload-drift.check.mjs',
  // L0 — latences de référence et non-régression de la poussée immédiate.
  'event-driven-sync-baseline.test.js',
  'instance-generation-freshness.test.js',
  // L'état métier d'un projet est vivant, pas figé à l'appairage.
  'project-live-business-sync.test.js',
  // Du vrai Company.save() jusqu'à la fiche du Panel, deux backends réels.
  'project-company-live-e2e.test.js',
  'contract-current-history.test.js',
  'architecture.test.js',
  'panel-ux.test.js',
  'live-refresh.test.js',
  'deploy.test.js',
  'deployment-build.test.js',
  'deployment-remote-env.test.js',
  'deployment-local-prerequisites.test.js',
  'deployment-report-truth.test.js',
  'deployment-silence.test.js',
  'deployment-stream.test.js',
  'engine-genericity.test.js',
  'engine-genericity-e2e.test.js',
  'supervision.test.js',
  'diagnostic.test.js',
  'execution.test.js',
  'spec-drift.check.mjs',
  'deployment-rollback.test.js',
  'deployment-deprovision.test.js',
  'deployment-ports.test.js',
  // LOT B — politique d'import des médias, limites alignées, refus typés.
  'media-upload-limits.test.js',
  'media-upload-validation.test.js',
  'media-descriptor.test.js',
  'media-cache-versioning.test.js',
  'media-canonical-save.test.js',
  'media-first-deployment.test.js',
  'deployment-ui.test.js',
  'deployment-forensics.test.js',
  'deployment-ssh-restart.test.js',
  'engine-governance.test.js',
  'duplication-e2e.test.js',
  'engine-drift.check.mjs',
  // Écosystème complet — SAUTÉ proprement si SB Auto 06 n'est pas à côté.
  'ecosystem-e2e.test.js',
];

let failed = 0;
for (const file of TESTS) {
  console.log(`\n━━━ ${file} ━━━`);
  const result = spawnSync(process.execPath, [path.join(testsDir, file)], {
    stdio: 'inherit',
  });
  if (result.status !== 0) failed += 1;
}

console.log(`\n════ Suite : ${TESTS.length - failed}/${TESTS.length} fichiers OK ════`);
process.exit(failed === 0 ? 0 : 1);
