// Assistant en ligne de commande du déploiement du Panel.
//
// Depuis la Phase 2D, cet assistant ne réimplémente plus rien : il pilote le
// MOTEUR STANDARD de l'écosystème (`backend/src/deployment-engine/`), le même
// que celui des projets vitrines, avec le profil du Panel
// (`deployment-engine/config/project.profile.js`).
//
// Deux modes :
//   • SIMULATION (défaut)  — affiche le plan complet, n'exécute RIEN, ne se
//     connecte à aucun serveur. Aucun secret n'apparaît dans la sortie.
//   • EXÉCUTION (--execute) — préflight, build, upload, releases, Nginx,
//     HTTPS, PM2, health checks, configuration des domaines, rollback.
//     Exige explicitement --execute ET des identifiants SSH.
//
// Le domaine fourni est la SEULE entrée : URLs, Nginx, `.env` distant, CORS
// et configuration système en base en découlent (docs 24 et 27).
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadDeployConfig } from './lib/config.mjs';
import { buildPlan, buildRollbackPlan, LOCAL_QUALITY_COMMANDS, STEPS } from './lib/plan.mjs';
import { buildRemoteEnv, parseEnvFile, validateRemoteEnv } from './lib/remoteEnv.mjs';

const panelRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function flag(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}
const has = (name) => process.argv.includes(`--${name}`);

// Un secret ne doit jamais apparaître dans un journal de déploiement.
const SECRET_RE = /SECRET|KEY|PASSWORD|TOKEN|MONGODB_URI/i;
function redactEnv(env) {
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

function printPlan(plan) {
  for (const phase of plan) {
    console.log(`\n▸ ${phase.step} — ${phase.description}`);
    for (const file of phase.writeFiles ?? []) {
      console.log(`  · écrire ${file.path} (${file.content.split('\n').length} lignes générées)`);
    }
    for (const command of phase.commands) console.log(`  $ ${command}`);
    if (phase.healthCheck) {
      console.log(`  ✓ contrôle de santé : ${phase.healthCheck.url} (ENV attendu ${phase.healthCheck.expectEnv})`);
    }
  }
}

/**
 * Identifiants SSH — jamais en argument de ligne de commande (ils resteraient
 * dans l'historique du shell et dans la liste des processus). Ils viennent de
 * l'environnement, et ne sont jamais journalisés.
 */
function sshCredentials(deployConfig) {
  const password = process.env.DEPLOY_SSH_PASSWORD;
  if (!password) {
    console.error('\n✗ DEPLOY_SSH_PASSWORD absente de l’environnement.');
    console.error('  L’exécution réelle exige les identifiants SSH du serveur cible :');
    console.error('    DEPLOY_SSH_PASSWORD=… node deploy/deploy.mjs --execute …');
    console.error('  (jamais en argument de commande : l’historique du shell les conserverait)\n');
    process.exit(1);
  }
  return {
    host: deployConfig.sshHost,
    username: deployConfig.sshUser,
    password,
    port: Number(process.env.DEPLOY_SSH_PORT || 22),
  };
}

/** Exécution réelle : délègue intégralement au moteur standard. */
async function execute(deployConfig, { mode, targetReleaseId }) {
  const engineDir = path.join(panelRoot, 'backend', 'src', 'deployment-engine');
  const { DeploymentEngine } = await import(`file://${path.join(engineDir, 'index.js')}`);
  const { SshTransport } = await import(`file://${path.join(engineDir, 'transport', 'SshTransport.js')}`);
  const { openSession, closeSession } = await import(`file://${path.join(engineDir, 'passwordVault.js')}`);

  const creds = sshCredentials(deployConfig);
  const localEnv = parseEnvFile(fs.readFileSync(path.join(panelRoot, 'backend', '.env'), 'utf8'));
  const remoteEnv = buildRemoteEnv(localEnv, deployConfig);

  // Le mot de passe n'existe qu'en RAM, le temps de la session.
  const sessionId = openSession({ host: creds.host, username: creds.username, password: creds.password });
  const engine = new DeploymentEngine({
    transportFactory: () => new SshTransport(creds),
    mongoUri: localEnv.MONGODB_URI,
  });

  const onStep = (evt) => {
    const label = evt.step ?? evt.phase ?? 'étape';
    const state = evt.status ?? evt.state ?? '';
    console.log(`  ▸ ${label}${state ? ` — ${state}` : ''}${evt.message ? ` : ${evt.message}` : ''}`);
  };

  try {
    if (mode === 'rollback') {
      console.log(`\n▸ rollback vers ${targetReleaseId}`);
      const result = await engine.rollback?.({
        url: deployConfig.urls.backendUrl,
        sessionId,
        releaseId: targetReleaseId,
        options: { remoteRoot: deployConfig.remoteRoot, backendPort: deployConfig.backendPort, env: deployConfig.environment },
        onStep,
      });
      if (!result) {
        console.error('\n✗ Le moteur ne propose pas encore de rollback piloté.');
        console.error('  Repointer manuellement le lien « current » puis relancer le service :');
        for (const phase of buildRollbackPlan(deployConfig, { targetReleaseId })) {
          for (const command of phase.commands) console.error(`    $ ${command}`);
        }
        process.exit(2);
      }
      console.log('\n✓ Rollback terminé.\n');
      return;
    }

    console.log('\n▸ déploiement réel (préflight → build → pipeline)…');
    const result = await engine.deploy({
      url: deployConfig.urls.backendUrl,
      sessionId,
      options: {
        remoteRoot: deployConfig.remoteRoot,
        backendPort: deployConfig.backendPort,
        env: deployConfig.environment,
        remoteEnv,
      },
      onStep,
    });
    console.log(`\n✓ Déploiement terminé — version ${result.version}, cible ${result.target?.host}.`);
    console.log(`  Vérifier : ${deployConfig.urls.backendUrl}/health et ${deployConfig.urls.backendUrl}/api/version\n`);
  } catch (err) {
    console.error(`\n✗ Déploiement interrompu : ${err.code ? `[${err.code}] ` : ''}${err.message}`);
    if (err.failedChecks) {
      for (const check of err.failedChecks) console.error(`    · ${check.id ?? check.name} : ${check.message ?? ''}`);
    }
    process.exitCode = 1;
  } finally {
    closeSession(sessionId);
  }
}

async function main() {
  const executeMode = has('execute');
  const mode = has('rollback') ? 'rollback' : 'deploy';

  let deployConfig;
  try {
    const explicitConfig = flag('config');
    deployConfig = loadDeployConfig(explicitConfig ?? path.join(panelRoot, 'deploy', 'deploy.config.json'), {
      host: flag('host'),
      environment: flag('env'),
      sshHost: flag('ssh-host'),
      sshUser: flag('ssh-user'),
      backendPort: flag('port') ? Number(flag('port')) : undefined,
    }, Boolean(explicitConfig));
  } catch (err) {
    console.error(`\n✗ ${err.message}\n`);
    process.exit(1);
  }

  const id = flag('release') ?? releaseId();
  console.log(`\n━━━ Déploiement du Panel — ${mode.toUpperCase()} ━━━`);
  console.log(`  moteur       : deployment-engine (standard L.Y Solution)`);
  console.log(`  domaine      : ${deployConfig.host}`);
  console.log(`  environnement: ${deployConfig.environment}`);
  console.log(`  serveur      : ${deployConfig.sshUser}@${deployConfig.sshHost}`);
  console.log(`  release      : ${id}`);
  console.log(`  URLs dérivées: ${deployConfig.urls.frontendUrl} (front) / ${deployConfig.urls.backendUrl} (api)`);
  console.log(`  mode         : ${executeMode ? 'EXÉCUTION RÉELLE' : 'SIMULATION (--dry-run implicite)'}`);

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
    if (executeMode) return execute(deployConfig, { mode, targetReleaseId: target });
    printPlan(buildRollbackPlan(deployConfig, { targetReleaseId: target }));
    console.log('\n✓ Simulation de rollback terminée — aucune action exécutée.\n');
    return;
  }

  // --- Chaîne de qualité locale (bloquante en exécution réelle) ------------
  console.log('\n▸ chaîne de qualité (locale, bloquante)');
  for (const [step, { cwd, command }] of Object.entries(LOCAL_QUALITY_COMMANDS)) {
    if (!executeMode) {
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

  if (executeMode) return execute(deployConfig, { mode });

  printPlan(buildPlan(deployConfig, { releaseId: id }));
  console.log(`\n✓ Simulation terminée — ${STEPS.length} étapes planifiées, aucune action exécutée.`);
  console.log('  Pour exécuter réellement : DEPLOY_SSH_PASSWORD=… node deploy/deploy.mjs --execute …\n');
}

main();
