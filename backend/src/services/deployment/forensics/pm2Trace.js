/**
 * CAPTURE AUTOMATIQUE DE L'ÉTAT PM2 ET DU PROPRIÉTAIRE DU PORT.
 *
 * ══ CE QU'ELLE REND INUTILE ═════════════════════════════════════════════════
 *
 * Jusqu'ici, savoir si PM2 avait redémarré, quel PID détenait le port ou si le
 * service était stable exigeait une session SSH ouverte AU BON MOMENT. Ces
 * informations n'existent que pendant l'opération : une minute plus tard,
 * elles sont perdues.
 *
 * Le moteur les LIT déjà — `readPortLandscape` interroge les sockets réelles et
 * les process PM2 pour vérifier qu'un service démarré détient bien son port.
 * Elles étaient simplement jetées après usage. On les persiste désormais dans
 * le run, avant et après le redémarrage.
 *
 * ══ CE QU'ELLE PROUVE ═══════════════════════════════════════════════════════
 *
 * `restart_time` qui augmente et un PID qui change entre AVANT et APRÈS
 * signent un redémarrage. Un port détenu par un PID qui n'est pas celui du
 * service attendu signe une collision — c'est l'incident d'origine, et il
 * devient lisible dans l'interface, sans terminal.
 */
import { readPortLandscape } from '../../../deployment-engine/ports.js';
import { EVENTS, LEVELS, SOURCES, journal } from './runJournal.service.js';

/**
 * Relève l'état d'un service PM2 et le propriétaire réel de son port.
 *
 * Ne lève jamais : une capture de diagnostic ne doit pas faire échouer le
 * déploiement qu'elle observe.
 */
export async function capturePm2State(transport, { processName, port }) {
  try {
    const paysage = await readPortLandscape(transport);
    const proc = (paysage.processes || []).find((p) => p.name === processName) ?? null;
    const socket = (paysage.sockets || []).find((s) => s.port === port) ?? null;

    return {
      processName,
      port,
      status: proc?.status ?? null,
      pid: proc?.pid ?? null,
      /**
       * LE COMPTEUR DE REDÉMARRAGES — sous le nom que `ports.js` lui donne.
       *
       * Il s'appelle `restarts` une fois normalisé ; ne chercher que
       * `restart_time` rendait ce compteur TOUJOURS nul, et « redémarrage
       * confirmé » ne pouvait donc jamais s'afficher. Un indicateur qui ne
       * s'allume jamais se lit comme une absence de problème.
       */
      restartTime: proc?.restartTime ?? proc?.restart_time ?? proc?.restarts ?? null,
      uptime: proc?.uptime ?? proc?.pm_uptime ?? null,
      execPath: proc?.execPath ?? proc?.pm_exec_path ?? null,
      cwd: proc?.cwd ?? proc?.pm_cwd ?? null,
      exitCode: proc?.exitCode ?? null,
      socketPid: socket?.pid ?? null,
      socketProcess: socket?.process ?? null,
      socketsReadable: paysage.socketsReadable !== false,
      /** Le port est-il détenu par NOTRE service ? La seule question qui compte. */
      ownedByUs: Boolean(socket && proc && socket.pid !== null && socket.pid === proc.pid),
    };
  } catch (err) {
    return { processName, port, error: err.message, unreadable: true };
  }
}

/** Journalise l'état AVANT une opération touchant PM2. */
export async function journalPm2Before(runId, transport, { processName, port, stepId = 'pm2' }) {
  const etat = await capturePm2State(transport, { processName, port });
  await journal(runId, {
    source: SOURCES.PM2,
    level: LEVELS.INFO,
    eventCode: EVENTS.PM2_STATE_BEFORE,
    stepId,
    processName,
    port,
    pid: etat.pid ?? null,
    message: `Avant redémarrage : ${etat.status ?? 'absent'}`
      + `${etat.pid ? `, pid ${etat.pid}` : ''}`
      + `${etat.restartTime !== null ? `, ${etat.restartTime} redémarrage(s)` : ''}.`,
    details: etat,
  });
  return etat;
}

/**
 * Journalise l'état APRÈS, et TRANCHE : le service est-il sain, et détient-il
 * réellement son port ?
 */
export async function journalPm2After(runId, transport, { processName, port, avant = null, stepId = 'pm2' }) {
  const apres = await capturePm2State(transport, { processName, port });

  const redemarre = avant && apres.restartTime !== null && avant.restartTime !== null
    && apres.restartTime > avant.restartTime;
  const pidChange = avant && avant.pid !== null && apres.pid !== null && avant.pid !== apres.pid;

  await journal(runId, {
    source: SOURCES.PM2,
    level: LEVELS.INFO,
    eventCode: EVENTS.PM2_STATE_AFTER,
    stepId,
    processName,
    port,
    pid: apres.pid ?? null,
    message: `Après redémarrage : ${apres.status ?? 'absent'}`
      + `${apres.pid ? `, pid ${apres.pid}` : ''}`
      + `${redemarre ? ' — redémarrage confirmé' : ''}`
      + `${pidChange ? ` (pid ${avant.pid} → ${apres.pid})` : ''}.`,
    details: { avant, apres, redemarre, pidChange },
  });

  // Un service qui n'est pas « online » après un démarrage n'est pas démarré.
  if (apres.status && apres.status !== 'online') {
    await journal(runId, {
      source: SOURCES.PM2,
      level: LEVELS.ERROR,
      eventCode: EVENTS.PM2_PROCESS_UNSTABLE,
      stepId,
      processName,
      port,
      message: `Le service « ${processName} » est « ${apres.status} » après démarrage.`,
      details: apres,
    });
  }

  /**
   * LE PORT EST-IL À NOUS ?
   *
   * C'est la question de l'incident d'origine : un port détenu par un process
   * étranger fait tourner Nginx vers un ancien code, et le nouveau service
   * boucle sur EADDRINUSE. On la pose, et on écrit la réponse.
   */
  if (apres.socketsReadable && apres.socketPid !== null) {
    await journal(runId, {
      source: SOURCES.SOCKET,
      level: apres.ownedByUs ? LEVELS.INFO : LEVELS.ERROR,
      eventCode: apres.ownedByUs ? EVENTS.SOCKET_OWNER_VERIFIED : EVENTS.PM2_PORT_NOT_OWNED,
      stepId,
      processName,
      port,
      pid: apres.socketPid,
      message: apres.ownedByUs
        ? `Le port ${port} est bien détenu par « ${processName} » (pid ${apres.socketPid}).`
        : `Le port ${port} est détenu par le pid ${apres.socketPid}`
          + `${apres.socketProcess ? ` (${apres.socketProcess})` : ''}, qui n'est PAS « ${processName} ».`,
      details: { expectedPid: apres.pid, socketPid: apres.socketPid, socketProcess: apres.socketProcess },
    });
  }

  return apres;
}

export default { capturePm2State, journalPm2Before, journalPm2After };
