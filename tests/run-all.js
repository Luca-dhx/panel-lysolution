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
  'deployment-ui.test.js',
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
