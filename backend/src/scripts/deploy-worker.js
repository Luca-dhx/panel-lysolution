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
const { installProcessGuards, setActiveRun } = await import('../services/deployment/forensics/processGuard.js');
const { runDeploymentJob } = await import('../services/deployment/deploymentJob.service.js');

await connectDatabase();

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

/**
 * ══ CE QUE CE SCRIPT NE FAIT PLUS, ET POURQUOI ══════════════════════════════
 *
 * Il portait toute l'orchestration : file d'écritures, barrière de publication,
 * conclusion, enregistrement sur la destination, vérification finale. Un point
 * d'entrée qui lit son environnement et sort par `process.exit()` ne s'éprouve
 * pas : la seule garde possible était une expression régulière sur son texte —
 * qui ne dit rien de ce que le texte fait.
 *
 * L'orchestration vit désormais dans `deploymentJob.service.js`, où la recette
 * peut la mettre en panne sur le chemin RÉEL. Ce script garde exactement ce
 * qui lui appartient : l'environnement, le secret, sa base, ses gardes, et son
 * code de sortie.
 */
const resultat = await runDeploymentJob({
  runId,
  targetId,
  operationType,
  sshPassword,
  releaseId,
  options: operationOptions,
  user: process.env.PANEL_DEPLOY_USER || null,
  // Le PID de l'API qui nous a lancés : c'est LUI qui doit mourir pour qu'un
  // redémarrage attendu soit avéré. Le worker le transmet plutôt que de laisser
  // l'exécuteur lire l'environnement — lecture réservée aux points d'entrée.
  apiPid: Number(process.env.PANEL_DEPLOY_API_PID) || null,
  logger: console,
});

await disconnectDatabase().catch(() => {});
process.exit(resultat.outcome?.status === 'ok' ? 0 : 1);
