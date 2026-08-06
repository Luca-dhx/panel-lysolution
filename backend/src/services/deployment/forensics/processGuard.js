/**
 * INSTRUMENTATION DES ERREURS NON GÉRÉES — journaliser avant de tomber.
 *
 * ══ LE TROU QU'ELLE FERME ═══════════════════════════════════════════════════
 *
 * L'application n'installait aucun `unhandledRejection` ni
 * `uncaughtExceptionMonitor`. Or `streamOperation` n'est volontairement pas
 * enveloppé dans `asyncHandler` : une erreur survenue APRÈS l'envoi des
 * en-têtes ne peut plus produire de réponse, et Node ≥ 15 termine alors le
 * process sur un rejet non géré.
 *
 * Résultat observé : le backend disparaît, PM2 le relance, l'écran affiche
 * « serveur momentanément indisponible » — et il ne reste AUCUNE trace de la
 * cause. On ne pouvait pas distinguer « erreur applicative » de « process
 * mort », alors que ce sont deux pannes opposées.
 *
 * ══ CE QUE CE MODULE NE FAIT PAS ════════════════════════════════════════════
 *
 * Il ne RATTRAPE pas. Maintenir en vie un process dont l'état est corrompu
 * produit des pannes bien pires que le redémarrage : des écritures partielles,
 * des verrous jamais relâchés, des connexions fuitées.
 *
 * `uncaughtExceptionMonitor` est un OBSERVATEUR : il ne modifie pas le
 * comportement de Node, qui termine le process comme il l'aurait fait. On
 * n'ajoute que la trace qui manquait.
 *
 * Pour `unhandledRejection`, on journalise puis on laisse le comportement par
 * défaut s'appliquer — la stratégie de redémarrage appartient à PM2.
 */
import { EVENTS, LEVELS, SOURCES, journal } from './runJournal.service.js';
import { sanitizeText } from './sanitize.js';

/**
 * LE RUN ACTIF DU PROCESS.
 *
 * Une erreur non gérée n'a aucun contexte : ni requête, ni run. Le pipeline
 * déclare donc ici le run qu'il est en train d'exécuter, ce qui permet
 * d'attacher la cause au bon endroit plutôt qu'à un journal général que
 * personne n'ouvrira.
 */
let runActif = null;

export function setActiveRun(runId) { runActif = runId ?? null; }
export function clearActiveRun(runId) { if (!runId || runActif === runId) runActif = null; }
export function getActiveRun() { return runActif; }

let installe = false;

/**
 * Installe les observateurs. Idempotent : deux appels n'empilent pas deux
 * écouteurs — ce qui doublerait chaque entrée de journal.
 */
export function installProcessGuards({ logger = console } = {}) {
  if (installe) return { installed: false, reason: 'DEJA_INSTALLE' };
  installe = true;

  process.on('unhandledRejection', (raison) => {
    const err = raison instanceof Error ? raison : new Error(String(raison));
    logger.error?.(`[forensique] rejet non géré : ${sanitizeText(err.message)}`);
    // Écriture au mieux : le process peut tomber avant qu'elle n'aboutisse.
    // C'est précisément pour cela que chaque entrée part immédiatement, sans
    // attendre une fin d'opération qui n'arrivera peut-être jamais.
    void journal(runActif, {
      source: SOURCES.SYSTEM,
      level: LEVELS.ERROR,
      eventCode: EVENTS.UNHANDLED_REJECTION,
      message: `Rejet de promesse non géré : ${err.message}`,
      error: err,
      details: { pid: process.pid, uptimeSec: Math.round(process.uptime()) },
      pid: process.pid,
    });
  });

  /**
   * `uncaughtExceptionMonitor` OBSERVE sans intercepter.
   *
   * `uncaughtException`, lui, EMPÊCHE la terminaison — ce qu'on ne veut
   * surtout pas : le process continuerait dans un état indéterminé. Le
   * moniteur laisse Node faire exactement ce qu'il aurait fait.
   */
  process.on('uncaughtExceptionMonitor', (err, origine) => {
    logger.error?.(`[forensique] exception non interceptée (${origine}) : ${sanitizeText(err.message)}`);
    void journal(runActif, {
      source: SOURCES.SYSTEM,
      level: LEVELS.ERROR,
      eventCode: EVENTS.UNCAUGHT_EXCEPTION,
      message: `Exception non interceptée (${origine}) : ${err.message}`,
      error: err,
      details: { origin: origine, pid: process.pid, uptimeSec: Math.round(process.uptime()) },
      pid: process.pid,
    });
  });

  return { installed: true };
}

/** Réinitialise l'installation — tests uniquement. */
export function resetProcessGuards() {
  installe = false;
  runActif = null;
}

export default { installProcessGuards, setActiveRun, clearActiveRun, getActiveRun, resetProcessGuards };
