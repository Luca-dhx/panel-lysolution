// Enchaîne toute la suite (équivalent du `npm test` chaîné du projet modèle).
// Chaque test est un processus séparé : isolation totale des stores en RAM.
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const testsDir = path.dirname(fileURLToPath(import.meta.url));

const TESTS = [
  'config.test.js',
  'version-compatibility.test.js',
  'manifest.test.js',
  'capabilities.test.js',
  'registry.test.js',
  'domains.test.js',
  'persistence.test.js',
  'bridge-http.test.js',
  'bridge-conformity.test.js',
  'architecture.test.js',
  'deploy.test.js',
  'supervision.test.js',
  'spec-drift.check.mjs',
  'deployment-rollback.test.js',
  'engine-governance.test.js',
  'duplication-e2e.test.js',
  'engine-drift.check.mjs',
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
