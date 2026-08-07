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

// Options non secrètes de l'opération (retrait : confirmation de suppression
// des données persistantes, chemins d'autres projets à protéger). Illisible ou
// absente, on retombe sur le comportement le PLUS PRUDENT : aucune option.
let operationOptions = {};
try {
  operationOptions = process.env.PANEL_DEPLOY_OPTIONS
    ? JSON.parse(process.env.PANEL_DEPLOY_OPTIONS)
    : {};
} catch {
  operationOptions = {};
}

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
const { installProcessGuards, setActiveRun } = await import('../services/deployment/forensics/processGuard.js');
const { journal, SOURCES, LEVELS } = await import('../services/deployment/forensics/runJournal.service.js');
const { verifyFinalization } = await import('../services/deployment/forensics/finalization.service.js');

await connectDatabase();
await runs.attachWorker(runId, process.pid);

/**
 * LES OBSERVATEURS D'ERREURS, ICI ET PAS SEULEMENT DANS L'API.
 *
 * Le déploiement vit dans CE processus. Une erreur non gérée y tue le worker
 * au milieu d'une mise en ligne, et l'API — qui a rendu 202 depuis longtemps —
 * n'en saurait rien. Le run resterait « en cours » sans la moindre cause.
 *
 * Le run actif est déclaré : une erreur sans contexte s'inscrit ainsi dans le
 * bon run plutôt que nulle part.
 */
installProcessGuards({ logger: console });
setActiveRun(runId);
await journal(runId, {
  source: SOURCES.WORKER,
  level: LEVELS.INFO,
  eventCode: 'WORKER_STARTED',
  message: `Worker détaché démarré (pid ${process.pid}).`,
  details: { pid: process.pid, operation: process.env.PANEL_DEPLOY_OPERATION ?? null },
  pid: process.pid,
});

// Battement de cœur : c'est lui qui permettra de conclure qu'un run est
// orphelin si ce processus meurt sans avoir conclu.
const beat = setInterval(() => { void runs.heartbeat(runId); }, 5_000);
beat.unref?.();

let outcome = { status: 'error', summary: null, error: null };

/**
 * FILE D'ÉCRITURE DES ÉTAPES — sérialisée, dans l'ordre d'émission.
 *
 * Le moteur émet `running` puis l'état terminal de la même étape. Quand rien
 * ne les sépare (aucun travail distant entre les deux : préflight,
 * finalisation), les deux écritures partaient en parallèle et se doublaient :
 * si `running` se déposait APRÈS `ok`, l'étape restait « en cours », et
 * `finalizeRun` requalifiait tout `running` résiduel en `error`. D'où des
 * étapes rouges sur un déploiement pourtant réussi à 20/20 — et un journal
 * d'évènements qui annonçait la fin avant le début.
 *
 * Chaîner les écritures rend l'ordre d'émission égal à l'ordre de
 * matérialisation. Aucune étape, aucun statut, aucun contrat ne change.
 */
let stepQueue = Promise.resolve();
const enqueueStep = (step) => {
  stepQueue = stepQueue.then(() => runs.recordStep(runId, step)).catch(() => {});
  return stepQueue;
};

try {
  const target = await targets.getTargetOrThrow(targetId);
  const { executeOperation } = await import('../services/deployment/deploymentExecutor.service.js');

  outcome = await executeOperation({
    operationType,
    target,
    sshPassword,
    releaseId,
    runId,
    options: operationOptions,
    user: process.env.PANEL_DEPLOY_USER || null,
    onStep: (step) => enqueueStep(step),
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
    // On attend que la file soit vide AVANT de conclure : `finalizeRun`
    // requalifie les étapes encore `running` en `error`. Conclure pendant
    // qu'une écriture est en vol condamnerait une étape déjà terminée.
    await stepQueue;
    await runs.finalizeRun(runId, outcome);

    // C'est CET appel qui fait passer la destination de « Publication… » à
    // « En ligne ». Il doit donc précéder toute vérification de cet état.
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

    /**
     * L'INVARIANT DU SUCCÈS — vérifié, jamais déduit, et vérifié APRÈS coup.
     *
     * Un pipeline vert ne suffit pas : on RELIT la destination et la
     * réservation de port. C'est en déduisant le succès sans relire l'état
     * persisté qu'un écran de succès a pu coexister avec une destination
     * figée en « Publication… ».
     *
     * ── L'ORDRE, ET POURQUOI IL EST LE DÉFAUT CORRIGÉ ─────────────────────
     * Cette relecture précédait `recordDeployment` — c'est-à-dire l'écriture
     * même qu'elle était censée constater. Elle trouvait donc immanquablement
     * `state=DEPLOYING` et « verrou encore posé », et classait en
     * `finalization_failed` un déploiement parfaitement réussi. Le run
     * `88022404` du 06/08 en est l'exemple : toutes les étapes vertes,
     * version 62241f6 en ligne, et un rapport annonçant une finalisation non
     * vérifiée. Vérifier avant d'écrire ne prouve rien : cela invente un échec.
     */
    if (outcome?.status === 'ok') {
      await verifyFinalization(runId, targetId).catch(() => null);
    }
  } catch {
    // La conclusion n'a pas pu être écrite : le run sera vu comme orphelin
    // au prochain démarrage, ce qui est le comportement correct.
  }
  await disconnectDatabase().catch(() => {});
  process.exit(outcome.status === 'ok' ? 0 : 1);
}
