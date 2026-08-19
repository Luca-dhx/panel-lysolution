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
import {
  buildPlan, buildRollbackPlan, describeRemoteLayout, LOCAL_QUALITY_COMMANDS, STEPS,
} from './lib/plan.mjs';
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

/**
 * AFFICHER LE PLAN — celui du MOTEUR, sans rien y ajouter (R10.1).
 *
 * Le plan ne porte plus de commandes shell : elles appartiennent au pipeline,
 * qui les compose à l'exécution. Ce qui s'affiche est donc ce qui est
 * réellement connu d'avance — les étapes, les chemins, les liens persistants —
 * et rien de plus. Une simulation qui inventerait le reste ferait relire une
 * fiction à qui s'apprête à déployer.
 */
function printPlan(plan) {
  for (const phase of plan) {
    console.log(`\n▸ ${phase.step} — ${phase.description}`);
    for (const file of phase.writeFiles ?? []) {
      console.log(`  · écrire ${file.path} (${file.content.split('\n').length} lignes générées)`);
    }
    for (const command of phase.commands ?? []) console.log(`  $ ${command}`);
    // Les liens PERSISTANTS : la réponse à « mes données survivent-elles ? ».
    for (const link of phase.links ?? []) {
      console.log(`  · ${link.from} -> ${link.to}   (persistant)`);
    }
    for (const pub of phase.publications ?? []) {
      console.log(`  · ${pub.id} (${pub.host}) : ${pub.next} → ${pub.target}, retour ${pub.prev}`);
    }
    for (const swap of phase.swaps ?? []) console.log(`  ↩ ${swap}`);
    for (const caveat of phase.caveats ?? []) console.log(`  ⚠ ${caveat}`);
    if (phase.healthCheck) {
      console.log(`  ✓ contrôle de santé : ${phase.healthCheck.url} (ENV attendu ${phase.healthCheck.expectEnv})`);
    }
  }
}

/** Les chemins distants réels, affichés avant le plan : c'est le contexte. */
function printLayout(layout) {
  console.log('\n▸ disposition distante (topologie du moteur)');
  console.log(`  · racine du site   : ${layout.siteRoot}`);
  console.log(`  · backend (stable) : ${layout.backendDir}`);
  console.log(`  · partagé          : ${layout.sharedRoot}`);
  console.log(`  · médias publics   : ${layout.sharedUploads}`);
  console.log(`  · médias privés    : ${layout.sharedStorage}`);
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

/**
 * ══ QUELLE URL LE MOTEUR ATTEND — celle du SITE, jamais celle de l'API ══════
 *
 * Le moteur reçoit l'adresse de la DESTINATION et dérive lui-même le sous-
 * domaine d'API (`api.<hôte>`), les racines Nginx et les hôtes à certifier.
 * Lui passer l'adresse du backend le faisait donc dériver une seconde fois :
 * `api.api.panel.ly-solution.com`. Certbot demandait un certificat pour un nom
 * qui n'existe pas, échouait — et le déploiement s'arrêtait avant PM2, après
 * avoir uploadé l'artefact et réécrit Nginx.
 *
 * Le produit, lui, a toujours passé l'adresse du site (`target.url`, voir
 * `deploymentExecutor.service.js`). Ce CLI était le seul à faire autrement, et
 * seule l'exécution réelle pouvait le révéler : la simulation ne certifie rien.
 *
 * `backendUrl` reste utilisé pour ce à quoi il sert : dire où aller vérifier.
 */
/** Exécution réelle : délègue intégralement au moteur standard. */
async function execute(deployConfig, { mode, targetReleaseId }) {
  const engineDir = path.join(panelRoot, 'backend', 'src', 'deployment-engine');
  const { DeploymentEngine } = await import(`file://${path.join(engineDir, 'index.js')}`);
  const { SshTransport } = await import(`file://${path.join(engineDir, 'transport', 'SshTransport.js')}`);
  const { openSession, closeSession } = await import(`file://${path.join(engineDir, 'passwordVault.js')}`);
  /**
   * ══ LA CONFIGURATION RÉSEAU EST PUBLIÉE, PAS SUPPOSÉE ══════════════════════
   *
   * L'étape `runtime_config` du pipeline n'agit que si l'appelant lui fournit de
   * quoi écrire : sans `runtimeConfigSync`, elle se déclare « non configuré
   * (façade/test) » et rend `ok`. Ce CLI ne la fournissait pas — un déploiement
   * par la ligne de commande ne publiait donc JAMAIS ses adresses, et le Panel
   * continuait d'annoncer aux projets celles qu'il portait avant.
   *
   * Le produit, lui, la câble depuis toujours (`deploymentExecutor.service.js`).
   * On emprunte exactement la même fonction : il n'y a qu'une manière d'écrire
   * cette configuration, et ce n'est pas au CLI de l'inventer.
   */
  const { syncRuntimeNetworkConfiguration } = await import(`file://${path.join(engineDir, 'runtimeConfig.js')}`);

  const creds = sshCredentials(deployConfig);
  const localEnv = parseEnvFile(fs.readFileSync(path.join(panelRoot, 'backend', '.env'), 'utf8'));
  const remoteEnv = buildRemoteEnv(localEnv, deployConfig);

  // Le mot de passe n'existe qu'en RAM, le temps de la session.
  /**
   * ══ `openSession` REND UN OBJET, PAS UN IDENTIFIANT ════════════════════════
   *
   * Cette ligne affectait le retour entier à `sessionId`, puis le passait au
   * moteur. Le coffre cherchait alors une session à la clé `[object Object]`,
   * n'en trouvait aucune, et le déploiement s'arrêtait sur `NO_VPS_SESSION` —
   * « session absente ou expirée », alors qu'elle venait d'être ouverte.
   *
   * Le défaut ne se voyait qu'en EXÉCUTION RÉELLE : la simulation n'ouvre
   * aucune session. Il coûtait donc toute la chaîne de qualité et le build
   * avant de se manifester.
   */
  const { sessionId } = openSession({
    host: creds.host, username: creds.username, password: creds.password,
  });
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
      // Aucune logique de rollback ici : le CLI ne fait que déléguer et
      // afficher. Toute la mécanique (vérification d'intégrité, bascule
      // atomique, relance du service, contrôle de santé, restauration en cas
      // d'échec) appartient au moteur — voir deployment-engine/rollback.js.
      const state = await engine.listReleases({
        url: deployConfig.urls.frontendUrl, sessionId, remoteRoot: deployConfig.remoteRoot,
      });
      console.log(`\n▸ version déployée  : ${state.current ?? 'inconnue'}`);
      console.log(`▸ version précédente: ${state.previous ?? 'aucune'}`);
      for (const slot of state.slots ?? []) {
        console.log(`  ${slot.hasPrev ? '↩' : '·'} ${slot.id} — ${slot.hasPrev ? slot.prev : 'aucun .prev'}`);
      }
      /**
       * REFUS TÔT, ET LISIBLE. Le moteur refuserait de toute façon, mais après
       * une connexion et deux lectures : autant le dire ici, avec la raison.
       */
      if (!state.canRollback) {
        console.error('\n✗ Aucun retour arrière possible : ce serveur n’a reçu qu’un seul '
          + 'déploiement, ou un dossier de secours a été retiré.\n');
        process.exitCode = 1;
        return;
      }
      /**
       * `--to` n'est plus honoré : le pipeline ne conserve qu'UNE génération
       * précédente. Le taire laisserait croire qu'on a visé une release.
       */
      if (targetReleaseId && targetReleaseId !== state.previous) {
        console.log(`\n⚠ --to ${targetReleaseId} ignoré : une seule version précédente existe `
          + `(${state.previous}).`);
      }

      const result = await engine.rollback({
        url: deployConfig.urls.frontendUrl,
        sessionId,
        options: {
          remoteRoot: deployConfig.remoteRoot,
          backendPort: deployConfig.backendPort,
          env: deployConfig.environment,
        },
        onStep,
      });
      console.log(`\n✓ Rollback terminé — ${result.from ?? 'aucune'} → ${result.to} (santé confirmée).\n`);
      return;
    }

    console.log('\n▸ déploiement réel (préflight → build → pipeline)…');
    const result = await engine.deploy({
      url: deployConfig.urls.frontendUrl,
      sessionId,
      options: {
        remoteRoot: deployConfig.remoteRoot,
        backendPort: deployConfig.backendPort,
        env: deployConfig.environment,
        remoteEnv,
        runtimeConfigSync: syncRuntimeNetworkConfiguration,
      },
      onStep,
    });
    /**
     * ══ UN ÉCHEC NE S'ANNONCE PAS « TERMINÉ » ══════════════════════
     *
     * `engine.deploy()` ne LÈVE PAS quand une étape du pipeline échoue : il
     * rend `{ ok: false, pipeline }`, parce que l'appelant a besoin du détail
     * des étapes — celles qui ont abouti autant que celle qui a cédé. Ce CLI
     * ignorait `ok` et imprimait « ✓ Déploiement terminé » dans tous les cas,
     * puis sortait en 0.
     *
     * Ce que cela coûtait : un déploiement arrêté à `certbot` — donc sans
     * rechargement Nginx, sans redémarrage PM2, sans contrôle de santé — était
     * annoncé comme publié. Le service continuait de servir l'ANCIENNE version,
     * et l'opérateur allait vérifier une URL qui répond 200 pour de mauvaises
     * raisons. Une chaîne d'intégration, elle, voyait un succès.
     *
     * On lit donc le verdict du moteur, on nomme l'étape fautive et son code,
     * et l'on sort en échec. Les étapes abouties sont rappelées : savoir que
     * l'upload a réussi change ce qu'on fait ensuite.
     */
    if (result?.ok === false) {
      const etapes = result.pipeline?.steps ?? [];
      const fautive = etapes.find((e) => e.status === 'error');
      const code = fautive?.error?.code ?? result.pipeline?.error?.code;
      console.error(`
✗ Déploiement INTERROMPU à l’étape « ${fautive?.step ?? result.pipeline?.failedStep ?? 'inconnue'} »`
        + `${code ? ` [${code}]` : ''}`);
      const message = fautive?.error?.message ?? result.pipeline?.error?.message;
      if (message) console.error(`  ${message}`);
      const abouties = etapes.filter((e) => e.status === 'ok').map((e) => e.step);
      if (abouties.length) {
        console.error('');
        console.error(`  étapes abouties : ${abouties.join(', ')}`);
      }
      console.error('');
      console.error('  Le service distant n’a PAS été rechargé : il sert toujours la version précédente.');
      process.exitCode = 1;
      return;
    }

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
  /**
   * LE `.env` VA DANS LE BACKEND, pas dans `shared/` (R10.1).
   *
   * Le pipeline l'écrit dans `<backend>/.env` puis le RELIT depuis le disque du
   * serveur pour vérifier que les clés critiques ont atterri. Annoncer un autre
   * chemin ici enverrait chercher le fichier au mauvais endroit le jour d'un
   * incident.
   */
  console.log(`  ✓ ${Object.keys(remoteEnv).length} variables prêtes pour `
    + `${describeRemoteLayout(deployConfig).backendDir}/.env`);
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

  printLayout(describeRemoteLayout(deployConfig));
  printPlan(buildPlan(deployConfig, { releaseId: id }));
  console.log(`\n✓ Simulation terminée — ${STEPS.length} étapes planifiées, aucune action exécutée.`);
  console.log('  Les étapes et les chemins ci-dessus sont LUS dans le moteur '
    + '(PIPELINE_STEPS + planTopology) : la simulation ne peut pas diverger de l’exécution.');
  console.log('  Pour exécuter réellement : DEPLOY_SSH_PASSWORD=… node deploy/deploy.mjs --execute …\n');
}

main();
