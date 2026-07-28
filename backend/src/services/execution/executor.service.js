// DISPATCHER D'EXÉCUTEURS — Phase 3C.
//
// Le moteur ne connaît AUCUNE action en particulier. Il lit `executor` dans
// le descripteur du registre, charge le module correspondant, et l'appelle.
// Il n'existe ici aucun `switch (action.type)`, aucun `if (type === 'DEPLOY')`.
//
// ── LE CONTRAT D'UN EXÉCUTEUR ───────────────────────────────────────────────
//   simulate(ctx) → { plan[], summary, ...extra }   décrit, n'agit pas
//   execute(ctx)  → { result, summary }             agit réellement
//
// `ctx` fournit :
//   action        le descripteur appelant (un exécuteur peut servir plusieurs actions)
//   record        la fiche projet
//   project       le descripteur de supervision
//   parameters    les paramètres validés
//   log           le journal (append-only)
//   services      les capacités injectées — voir `buildServices`
//   client        ProjectBridgeClient, ou null en simulation
//   credentials   identifiants d'infrastructure, ou null
//   signal        AbortSignal du timeout
//
// C'est le moteur qui construit `client` : un exécuteur ne l'instancie jamais.
// C'est ce qui garantit qu'aucun appel distant ne contourne le moteur.
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const executorsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'executors');

/** Cache des modules chargés — un exécuteur est chargé une seule fois. */
const cache = new Map();

export class ExecutorNotFoundError extends Error {
  constructor(executorId) {
    super(`Aucun exécuteur « ${executorId} » : le descripteur référence un module inexistant.`);
    this.name = 'ExecutorNotFoundError';
    this.code = 'EXEC_EXECUTOR_NOT_FOUND';
  }
}

/** Charge l'exécuteur déclaré par une action. */
export async function loadExecutor(executorId) {
  if (cache.has(executorId)) return cache.get(executorId);
  let module;
  try {
    module = await import(pathToFileURL(path.join(executorsDir, `${executorId}.js`)).href);
  } catch {
    throw new ExecutorNotFoundError(executorId);
  }
  const executor = module.default ?? module;
  if (typeof executor.simulate !== 'function' || typeof executor.execute !== 'function') {
    throw new ExecutorNotFoundError(executorId);
  }
  cache.set(executorId, executor);
  return executor;
}

/** Un exécuteur existe-t-il pour cet identifiant ? (validation du registre) */
export async function executorExists(executorId) {
  try {
    await loadExecutor(executorId);
    return true;
  } catch {
    return false;
  }
}

/**
 * SIMULE une action. Aucun appel distant, aucune écriture — c'est la
 * responsabilité de l'exécuteur de le respecter, et le moteur ne lui fournit
 * ni `client` ni `credentials` pour l'y aider.
 */
export async function simulate(action, context) {
  const executor = await loadExecutor(action.executor);
  const outcome = await executor.simulate({ ...context, action, client: null, credentials: null });
  return {
    mode: 'SIMULATION',
    plan: outcome.plan ?? [],
    summary: outcome.summary ?? 'Simulation effectuée.',
    ...outcome,
  };
}

/**
 * EXÉCUTE réellement une action. Le moteur a déjà validé les politiques,
 * obtenu les confirmations et posé le verrou d'exclusivité.
 */
export async function execute(action, context) {
  const executor = await loadExecutor(action.executor);
  const outcome = await executor.execute({ ...context, action });
  return {
    mode: 'EXECUTION',
    result: outcome.result ?? null,
    summary: outcome.summary ?? 'Exécution terminée.',
    ...outcome,
  };
}

/** Vide le cache — réservé aux tests. */
export function resetExecutorCache() {
  cache.clear();
}

export default { loadExecutor, executorExists, simulate, execute, resetExecutorCache, ExecutorNotFoundError };
