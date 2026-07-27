// Moteur de déploiement du Panel — assistant en ligne de commande.
//
// Discipline (alignée sur le moteur du projet modèle) :
//  - rien n'est déployé qui n'ait passé lint + typecheck + tests + build ;
//  - le .env distant est écrit PUIS RELU : une variable obligatoire absente
//    arrête le déploiement avant de démarrer le service ;
//  - releases versionnées + lien symbolique « current » : la bascule est
//    atomique et le rollback consiste à repointer le lien ;
//  - le domaine choisi alimente Nginx, le .env distant, le CORS et la
//    configuration système en base — jamais d'édition manuelle dispersée ;
//  - aucun secret n'est écrit dans le dépôt ni affiché dans les journaux.
//
// Par défaut, --dry-run : le plan complet est affiché, RIEN n'est exécuté.
// Un déploiement réel exige --execute (et une instruction explicite).
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadDeployConfig } from './lib/config.mjs';
import { buildPlan, buildRollbackPlan, LOCAL_QUALITY_COMMANDS, STEPS } from './lib/plan.mjs';
import { buildRemoteEnv, parseEnvFile, serializeEnv, validateRemoteEnv } from './lib/remoteEnv.mjs';

const panelRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function flag(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}
const has = (name) => process.argv.includes(`--${name}`);

// Le secret ne doit jamais apparaître dans un journal de déploiement.
function redactEnv(env) {
  const SECRET_RE = /SECRET|KEY|PASSWORD|TOKEN|MONGODB_URI/i;
  return Object.fromEntries(
    Object.entries(env).map(([key, value]) => [key, SECRET_RE.test(key) ? '«redacted»' : value]),
  );
}

function releaseId() {
  let commit = 'nogit';
  try {
    commit = execSync('git rev-parse --short HEAD', { cwd: panelRoot, encoding: 'utf8' }).trim();
  } catch { /* dépôt absent : identifiant horodaté seul */ }
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '-');
  return `${stamp}-${commit}`;
}

function main() {
  const execute = has('execute');
  const mode = has('rollback') ? 'rollback' : 'deploy';

  let deployConfig;
  try {
    deployConfig = loadDeployConfig(flag('config') ?? path.join(panelRoot, 'deploy', 'deploy.config.json'), {
      host: flag('host'),
      environment: flag('env'),
      sshHost: flag('ssh-host'),
      sshUser: flag('ssh-user'),
      backendPort: flag('port') ? Number(flag('port')) : undefined,
    });
  } catch (err) {
    console.error(`\n✗ ${err.message}\n`);
    process.exit(1);
  }

  const id = flag('release') ?? releaseId();
  console.log(`\n━━━ Déploiement du Panel — ${mode.toUpperCase()} ━━━`);
  console.log(`  domaine      : ${deployConfig.host}`);
  console.log(`  environnement: ${deployConfig.environment}`);
  console.log(`  serveur      : ${deployConfig.sshUser}@${deployConfig.sshHost}`);
  console.log(`  release      : ${id}`);
  console.log(`  URLs dérivées: ${deployConfig.urls.frontendUrl} (front) / ${deployConfig.urls.backendUrl} (api)`);
  console.log(`  mode         : ${execute ? 'EXÉCUTION RÉELLE' : 'SIMULATION (--dry-run implicite)'}`);

  // --- Validation du .env distant, avant toute étape -----------------------
  const localEnvPath = path.join(panelRoot, 'backend', '.env');
  if (!fs.existsSync(localEnvPath)) {
    console.error('\n✗ backend/.env introuvable : les secrets du déploiement en sont issus.\n');
    process.exit(1);
  }
  const localEnv = parseEnvFile(fs.readFileSync(localEnvPath, 'utf8'));
  const remoteEnv = buildRemoteEnv(localEnv, deployConfig);
  const validation = validateRemoteEnv(remoteEnv);

  console.log('\n▸ validate.env');
  if (!validation.valid) {
    console.error(`  ✗ variables obligatoires absentes ou vides : ${validation.missing.join(', ')}`);
    console.error('    (renseigner backend/.env — voir backend/.env.example)\n');
    process.exit(1);
  }
  console.log(`  ✓ ${Object.keys(remoteEnv).length} variables prêtes pour ${deployConfig.paths.envFile}`);
  console.log(`  · valeurs pilotées par le déploiement : ${JSON.stringify(redactEnv({
    ENV: remoteEnv.ENV, PORT: remoteEnv.PORT, PUBLIC_URL: remoteEnv.PUBLIC_URL, CORS_ORIGINS: remoteEnv.CORS_ORIGINS,
  }))}`);

  if (mode === 'rollback') {
    const target = flag('to');
    if (!target) {
      console.error('\n✗ --rollback exige --to <releaseId>\n');
      process.exit(1);
    }
    printPlan(buildRollbackPlan(deployConfig, { targetReleaseId: target }));
    finish(execute);
    return;
  }

  // --- Chaîne de qualité locale -------------------------------------------
  console.log('\n▸ chaîne de qualité (locale, bloquante)');
  for (const [step, { cwd, command }] of Object.entries(LOCAL_QUALITY_COMMANDS)) {
    if (!execute) {
      console.log(`  · ${step} : ${command} (dans ${cwd}/)`);
      continue;
    }
    console.log(`  ▸ ${step} : ${command}`);
    try {
      execSync(command, { cwd: path.join(panelRoot, cwd), stdio: 'inherit' });
    } catch {
      console.error(`\n✗ ${step} a échoué — déploiement interrompu (aucune action distante).\n`);
      process.exit(1);
    }
  }

  printPlan(buildPlan(deployConfig, { releaseId: id }));
  finish(execute);
}

function printPlan(plan) {
  for (const phase of plan) {
    console.log(`\n▸ ${phase.step} — ${phase.description}`);
    for (const file of phase.writeFiles ?? []) {
      console.log(`  · écrire ${file.path} (${file.content.split('\n').length} lignes générées)`);
    }
    for (const command of phase.commands) {
      console.log(`  $ ${command}`);
    }
    if (phase.healthCheck) {
      console.log(`  ✓ contrôle de santé : ${phase.healthCheck.url} (ENV attendu ${phase.healthCheck.expectEnv})`);
    }
  }
}

function finish(execute) {
  if (execute) {
    // L'exécution distante (SSH) est le seul maillon non couvert par cette
    // phase : elle exige une instruction explicite et un serveur cible.
    console.error('\n✗ L’exécution distante n’est pas activée dans cette version.');
    console.error('  Le plan ci-dessus est complet et vérifié ; le transport SSH sera branché');
    console.error('  lors du premier déploiement réel, sur instruction explicite.\n');
    process.exit(2);
  }
  console.log(`\n✓ Simulation terminée — ${STEPS.length} étapes planifiées, aucune action exécutée.\n`);
}

main();
