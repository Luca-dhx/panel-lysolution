// WORKER DE DÉPLOIEMENT — processus DÉTACHÉ.
//
// ══ LE PROBLÈME QU'IL RÉSOUT ════════════════════════════════════════════════
//
// Le Panel peut se déployer LUI-MÊME. Un déploiement se termine par un
// `pm2 restart` du backend — c'est-à-dire par la mort du processus qui
// exécute le déploiement, au moment précis où il approche de la fin.
//
// Conséquences si le déploiement tournait dans le backend :
//   · la requête HTTP est coupée : l'opérateur voit une erreur réseau alors
//     que sa mise en ligne a peut-être réussi ;
//   · le run reste « en cours » pour toujours ;
//   · pire, les dernières étapes (contrôle de santé, validation) ne sont
//     jamais exécutées : on redémarre sans jamais vérifier.
//
// ══ LA SOLUTION ═════════════════════════════════════════════════════════════
//
// Le déploiement s'exécute ici, dans un processus SÉPARÉ et DÉTACHÉ :
//   · lancé avec `detached: true` puis `unref()` — il n'est plus rattaché au
//     backend et survit à son arrêt ;
//   · sa propre connexion MongoDB — il n'emprunte rien au backend ;
//   · il écrit chaque étape et chaque ligne de journal EN BASE, au fil de
//     l'eau ; l'interface ne fait que lire ce document.
//
// Tuer le backend n'interrompt donc plus rien. L'opérateur peut même fermer
// son navigateur : à la reconnexion, le run est là, avec son issue.
//
// ══ LE SECRET ═══════════════════════════════════════════════════════════════
//
// Le mot de passe SSH arrive par une VARIABLE D'ENVIRONNEMENT du processus
// enfant, jamais par `argv` — les arguments d'un processus sont lisibles par
// tout utilisateur de la machine (`ps aux`), pas son environnement. Il n'est
// écrit nulle part, et n'apparaît dans aucun journal.
import process from 'node:process';

const runId = process.env.PANEL_DEPLOY_RUN_ID;
const targetId = process.env.PANEL_DEPLOY_TARGET_ID;
const operationType = process.env.PANEL_DEPLOY_OPERATION;
const sshPassword = process.env.PANEL_DEPLOY_SSH_PASSWORD;
const releaseId = process.env.PANEL_DEPLOY_RELEASE_ID || null;

if (!runId || !targetId || !operationType) {
  console.error('deploy-worker : PANEL_DEPLOY_RUN_ID, _TARGET_ID et _OPERATION sont requis.');
  process.exit(2);
}

// On efface le secret de notre propre environnement dès qu'il est lu : si ce
// processus lançait un sous-processus, il ne l'hériterait pas.
delete process.env.PANEL_DEPLOY_SSH_PASSWORD;

const { connectDatabase, disconnectDatabase } = await import('../config/db.js');
const runs = await import('../services/deployment/deploymentRun.service.js');
const targets = await import('../services/deployment/deploymentTarget.service.js');

await connectDatabase();
await runs.attachWorker(runId, process.pid);

// Battement de cœur : c'est lui qui permettra de conclure qu'un run est
// orphelin si ce processus meurt sans avoir conclu.
const beat = setInterval(() => { void runs.heartbeat(runId); }, 5_000);
beat.unref?.();

let outcome = { status: 'error', summary: null, error: null };

try {
  const target = await targets.getTargetOrThrow(targetId);
  const { executeOperation } = await import('../services/deployment/deploymentExecutor.service.js');

  outcome = await executeOperation({
    operationType,
    target,
    sshPassword,
    releaseId,
    user: process.env.PANEL_DEPLOY_USER || null,
    onStep: (step) => runs.recordStep(runId, step),
    onLog: (message, level) => runs.appendLog(runId, message, level),
  });
} catch (err) {
  // Une erreur ici est déjà un échec de déploiement : on la consigne au lieu
  // de laisser le processus mourir en silence, ce qui laisserait le run
  // « en cours » jusqu'au prochain démarrage du backend.
  await runs.appendLog(runId, `Erreur inattendue : ${err.message}`, 'ERROR').catch(() => {});
  outcome = {
    status: 'error',
    summary: `Déploiement interrompu par une erreur inattendue : ${err.message}`,
    error: { code: err.code ?? 'WORKER_UNEXPECTED', message: err.message },
  };
} finally {
  clearInterval(beat);
  try {
    await runs.finalizeRun(runId, outcome);
    await targets.recordDeployment(targetId, {
      operationType,
      ok: outcome.status === 'ok',
      version: outcome.version ?? null,
      releaseId: outcome.releaseId ?? null,
      user: process.env.PANEL_DEPLOY_USER || null,
      durationMs: null,
      error: outcome.error,
      steps: outcome.steps ?? [],
    });
  } catch {
    // La conclusion n'a pas pu être écrite : le run sera vu comme orphelin
    // au prochain démarrage, ce qui est le comportement correct.
  }
  await disconnectDatabase().catch(() => {});
  process.exit(outcome.status === 'ok' ? 0 : 1);
}
