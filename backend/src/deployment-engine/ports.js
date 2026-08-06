/**
 * PORTS APPLICATIFS — ce que le SERVEUR dit, jamais ce que la base suppose.
 *
 * ══ LE DÉFAUT CORRIGÉ ═══════════════════════════════════════════════════════
 *
 * L'attribution d'un port était « le plus haut déjà attribué en base, plus
 * un ». Cette règle ne regarde que les fiches connues du Panel. Elle ignore
 * donc :
 *
 *   · les process PM2 qui tournent encore alors que leur fiche a disparu ;
 *   · les sockets réellement ouvertes par n'importe quel autre programme ;
 *   · les services système qui écoutent sur la plage applicative.
 *
 * Après la suppression de la fiche de `panel.lycarz.com`, le port 5100 est
 * redescendu dans la plage libre. Il a été réattribué à la destination
 * suivante — alors que l'ancien backend, toujours en ligne, le DÉTENAIT. Le
 * nouveau service a bouclé sur EADDRINUSE plus de 7 000 fois, pendant que
 * Nginx envoyait le trafic du nouveau domaine vers l'ancien code. Rien, dans
 * ce mécanisme, ne pouvait détecter la collision : la base était cohérente
 * avec elle-même.
 *
 * ══ LA RÈGLE ═══════════════════════════════════════════════════════════════
 *
 * Un port n'est libre que si TROIS sources le disent :
 *   1. aucune réservation en base ne le retient ;
 *   2. aucun process PM2 ne le déclare ;
 *   3. aucune socket d'écoute ne le détient sur le serveur.
 *
 * Et un service n'est « démarré » que lorsqu'on a PROUVÉ que le PID attendu
 * détient bien le port. Un `pm2 start` qui rend 0 ne prouve rien : le process
 * peut redémarrer en boucle depuis une seconde.
 *
 * Ce module ne connaît ni la base du Panel ni celle d'un projet : il lit un
 * serveur à travers le Transport, et rend des faits. La RÉSERVATION, elle,
 * appartient à l'application — c'est elle qui a une base.
 */
import { DeploymentError } from './errors.js';
import { serviceName } from './config/project.profile.js';

/**
 * Codes d'erreur dédiés. Ils sont stables : l'interface, les rapports et les
 * tests s'y appuient, et un opérateur doit pouvoir les chercher tels quels.
 */
export const PORT_ERRORS = Object.freeze({
  /** Le process existe mais n'est pas stable (boucle de redémarrage, arrêté). */
  PM2_PROCESS_UNSTABLE: 'PM2_PROCESS_UNSTABLE',
  /** Le port visé est déjà détenu par un AUTRE process PM2. */
  PM2_PORT_COLLISION: 'PM2_PORT_COLLISION',
  /** Le port est écouté, mais par un autre PID que celui attendu. */
  PM2_PORT_NOT_OWNED: 'PM2_PORT_NOT_OWNED',
  /** Deux réservations se disputent le même port. */
  PORT_RESERVATION_CONFLICT: 'PORT_RESERVATION_CONFLICT',
  /** Le port est détenu par un programme que le Panel ne connaît pas. */
  PORT_IN_USE_UNKNOWN_PROCESS: 'PORT_IN_USE_UNKNOWN_PROCESS',
  /** Plus aucun port disponible dans la plage applicative. */
  PORT_RANGE_EXHAUSTED: 'PORT_RANGE_EXHAUSTED',
});

/**
 * Plage applicative. Elle commence au-dessus des ports réservés du système et
 * au-dessus du 4100 du développement local : une destination ne doit jamais
 * réserver le port du Panel de l'opérateur.
 */
export const PORT_RANGE = Object.freeze({ from: 5100, to: 5999 });

/**
 * Ports que le Panel ne réservera JAMAIS, même s'ils paraissent libres.
 * Un service système temporairement arrêté reste son propriétaire légitime.
 */
export const NEVER_ALLOCATE = Object.freeze([
  22, 25, 53, 80, 110, 143, 443, 465, 587, 993, 995,
  3000, 3306, 5432, 6379, 8080, 8443, 9000, 27017, 27018, 27019,
]);

/* -------------------------------------------------------------------------- */
/*  LECTURE DU SERVEUR                                                        */
/* -------------------------------------------------------------------------- */

/**
 * SOCKETS D'ÉCOUTE réellement ouvertes sur le serveur.
 *
 * `ss` est préféré à `netstat` (présent par défaut sur les distributions
 * récentes), avec un repli. Une sortie illisible n'est PAS traitée comme
 * « aucun port occupé » : elle est signalée, parce que conclure « libre »
 * d'une lecture ratée est exactement la faute qui a causé l'incident.
 *
 * @returns {Promise<{readable:boolean, sockets:Array<{port:number, address:string, pid:number|null, process:string|null}>}>}
 */
export async function readListeningSockets(transport) {
  const res = await transport.exec('ss -ltnp 2>/dev/null || netstat -ltnp 2>/dev/null || echo __NO_TOOL__')
    .catch(() => ({ stdout: '__NO_TOOL__' }));
  const sortie = String(res.stdout ?? '');
  if (sortie.includes('__NO_TOOL__') || sortie.trim().length === 0) {
    return { readable: false, sockets: [] };
  }

  const sockets = [];
  for (const ligne of sortie.split(/\r?\n/)) {
    if (!/LISTEN/i.test(ligne)) continue;
    // Adresse locale : `127.0.0.1:5100`, `*:443`, `[::]:443`, `0.0.0.0:80`.
    const adresse = ligne.match(/(\S+):(\d+)\s+\S+\s*(?:users:|$|\s)/) ?? ligne.match(/(\S+):(\d+)/);
    if (!adresse) continue;
    const port = Number(adresse[2]);
    if (!Number.isInteger(port)) continue;
    const proc = ligne.match(/users:\(\("([^"]+)",pid=(\d+)/) ?? ligne.match(/(\d+)\/(\S+)\s*$/);
    sockets.push({
      port,
      address: adresse[1],
      pid: proc ? Number(proc[2] ?? proc[1]) : null,
      process: proc ? (proc[1] && Number.isNaN(Number(proc[1])) ? proc[1] : proc[2]) : null,
    });
  }
  return { readable: true, sockets };
}

/**
 * PROCESS PM2 déclarés sur le serveur, avec le port que chacun annonce.
 *
 * Le port vient de l'environnement du process (`PORT`), pas d'une convention :
 * c'est la valeur avec laquelle il a réellement été démarré.
 */
export async function readPm2Processes(transport) {
  const res = await transport.exec('pm2 jlist 2>/dev/null || echo "[]"').catch(() => ({ stdout: '[]' }));
  let liste = [];
  try {
    liste = JSON.parse(res.stdout || '[]');
  } catch {
    return { readable: false, processes: [] };
  }
  if (!Array.isArray(liste)) return { readable: false, processes: [] };

  return {
    readable: true,
    processes: liste.map((p) => {
      const env = p?.pm2_env ?? {};
      const brut = env.env?.PORT ?? env.PORT ?? null;
      const port = brut === null || brut === undefined || brut === '' ? null : Number(brut);
      return {
        name: p?.name ?? null,
        pid: p?.pid ?? null,
        status: env.status ?? null,
        restarts: env.restart_time ?? 0,
        unstableRestarts: env.unstable_restarts ?? 0,
        pmUptime: env.pm_uptime ?? null,
        execPath: env.pm_exec_path ?? p?.pm_exec_path ?? null,
        cwd: env.pm_cwd ?? p?.pm_cwd ?? null,
        port: Number.isInteger(port) ? port : null,
      };
    }),
  };
}

/**
 * ÉTAT COMPLET des ports d'un serveur — la photographie sur laquelle une
 * allocation peut être décidée.
 *
 * @returns {Promise<{sockets, processes, socketsReadable, pm2Readable, occupied:number[]}>}
 */
export async function readPortLandscape(transport) {
  const [sockets, pm2] = await Promise.all([
    readListeningSockets(transport),
    readPm2Processes(transport),
  ]);
  const occupied = [...new Set([
    ...sockets.sockets.map((s) => s.port),
    ...pm2.processes.map((p) => p.port).filter((p) => Number.isInteger(p)),
  ])].sort((a, b) => a - b);

  return {
    sockets: sockets.sockets,
    processes: pm2.processes,
    socketsReadable: sockets.readable,
    pm2Readable: pm2.readable,
    occupied,
  };
}

/**
 * QUI détient un port, d'après le serveur.
 *
 * @returns {Promise<{port:number, free:boolean, readable:boolean, holder:{pid:number|null, process:string|null}|null, pm2Name:string|null}>}
 */
export async function probePort(transport, port) {
  const paysage = await readPortLandscape(transport);
  const socket = paysage.sockets.find((s) => s.port === port) ?? null;
  const pm2 = paysage.processes.find((p) => p.port === port) ?? null;
  return {
    port,
    readable: paysage.socketsReadable,
    free: !socket && !pm2,
    holder: socket ? { pid: socket.pid, process: socket.process } : null,
    pm2Name: pm2?.name ?? null,
  };
}

/* -------------------------------------------------------------------------- */
/*  CHOIX D'UN PORT                                                           */
/* -------------------------------------------------------------------------- */

/**
 * PREMIER PORT LIBRE de la plage — fonction PURE.
 *
 * Toutes les sources d'occupation sont fournies par l'appelant : réservations
 * de la base, ports PM2, sockets réelles. La pureté est délibérée — c'est ce
 * qui permet de vérifier la règle d'exclusion sans serveur, et d'être certain
 * qu'aucune source n'est oubliée à l'exécution.
 *
 * @param {object} args
 * @param {number[]} [args.reserved]  ports retenus par la base
 * @param {number[]} [args.occupied]  ports vus sur le serveur (PM2 + sockets)
 * @param {number[]} [args.excluded]  ports interdits par principe
 * @param {{from:number,to:number}} [args.range]
 * @returns {number}
 */
export function findFreePort({ reserved = [], occupied = [], excluded = [], range = PORT_RANGE } = {}) {
  const pris = new Set([
    ...reserved.map(Number),
    ...occupied.map(Number),
    ...excluded.map(Number),
    ...NEVER_ALLOCATE,
  ]);
  for (let port = range.from; port <= range.to; port += 1) {
    if (!pris.has(port)) return port;
  }
  throw new DeploymentError(PORT_ERRORS.PORT_RANGE_EXHAUSTED,
    `Aucun port disponible entre ${range.from} et ${range.to} : ${pris.size} port(s) occupés ou réservés.`,
    { details: { range, taken: [...pris].sort((a, b) => a - b) } });
}

/**
 * LE PORT VISÉ EST-IL UTILISABLE PAR CETTE DESTINATION ?
 *
 * Appelé juste avant de démarrer le service — c'est-à-dire APRÈS la
 * réservation, parce qu'entre les deux le serveur a pu changer. Trois issues :
 *
 *   · libre                       → on démarre ;
 *   · détenu par NOTRE process    → on démarre (redéploiement : même port) ;
 *   · détenu par autre chose      → on S'ARRÊTE, en nommant le détenteur.
 *
 * On ne tue jamais le détenteur : un process inconnu sur la plage applicative
 * peut être un service légitime, et le supprimer serait décider à la place de
 * l'administrateur du serveur.
 */
export async function assertPortAvailableFor(transport, { port, host, expectedPm2Name }) {
  const attendu = expectedPm2Name ?? serviceName(host);
  const paysage = await readPortLandscape(transport);

  const pm2Concurrent = paysage.processes.find((p) => p.port === port && p.name !== attendu);
  if (pm2Concurrent) {
    throw new DeploymentError(PORT_ERRORS.PM2_PORT_COLLISION,
      `Le port ${port} est déjà utilisé par le service PM2 « ${pm2Concurrent.name} ». `
      + 'Démarrer ici ferait boucler l’un des deux sur EADDRINUSE.',
      { step: 'services.start', details: { port, holder: pm2Concurrent.name, pid: pm2Concurrent.pid, expected: attendu } });
  }

  const socket = paysage.sockets.find((s) => s.port === port);
  if (socket) {
    const notre = paysage.processes.find((p) => p.name === attendu);
    const aNous = notre && notre.pid !== null && socket.pid === notre.pid;
    if (!aNous) {
      throw new DeploymentError(PORT_ERRORS.PORT_IN_USE_UNKNOWN_PROCESS,
        `Le port ${port} est détenu par un programme que le Panel ne connaît pas `
        + `(${socket.process ?? 'processus inconnu'}${socket.pid ? `, pid ${socket.pid}` : ''}). `
        + 'Le déploiement s’arrête plutôt que de lui disputer le port.',
        { step: 'services.start', details: { port, holder: socket.process, pid: socket.pid, expected: attendu } });
    }
  }

  return {
    port,
    free: !socket,
    heldByUs: Boolean(socket),
    readable: paysage.socketsReadable,
    expectedPm2Name: attendu,
  };
}

/* -------------------------------------------------------------------------- */
/*  SANTÉ DU SERVICE                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Au-delà de ce nombre de redémarrages non voulus, un process est considéré
 * comme BOUCLANT — le cas exact de l'incident (plus de 7 000 redémarrages).
 */
export const UNSTABLE_RESTART_THRESHOLD = 3;

/**
 * Durée minimale de vie d'un process pour qu'on le dise stable. En deçà, il
 * vient de démarrer : dire « en ligne » n'aurait aucune valeur, puisqu'un
 * process qui boucle est « en ligne » une fraction de seconde sur deux.
 */
export const MIN_STABLE_UPTIME_MS = 3000;

/**
 * SANTÉ RÉELLE d'un service PM2 — bien au-delà de `pm_exec_path`.
 *
 * ── CE QUI MANQUAIT ─────────────────────────────────────────────────────────
 * Le moteur validait le démarrage sur le seul chemin exécuté. Un process qui
 * bouclait sur EADDRINUSE présentait pourtant le BON chemin : le contrôle
 * passait, le déploiement se déclarait vert, et le service n'a jamais servi
 * une seule requête.
 *
 * On prouve donc, dans l'ordre : le process existe · il est `online` · il ne
 * boucle pas · il a un PID · son chemin et son dossier sont les bons · le port
 * est écouté · et la socket appartient à CE PID.
 *
 * @param {object} args
 * @param {string} args.name          nom PM2 attendu
 * @param {number} args.port          port attendu
 * @param {string} [args.expectedExecPath]
 * @param {string} [args.expectedCwd]
 * @param {number} [args.baselineRestarts] compteur de redémarrages AVANT
 *        l'opération : seuls les redémarrages SURVENUS DEPUIS comptent.
 * @param {(ms:number)=>Promise<void>} [args.wait] temporisation injectable.
 * @returns {Promise<object>} constat détaillé (jamais un simple booléen)
 */
export async function verifyServiceHealth(transport, {
  name, port, expectedExecPath = null, expectedCwd = null,
  baselineRestarts = null, settleMs = MIN_STABLE_UPTIME_MS, wait = defaultWait,
}) {
  const echec = (code, message, details) => {
    throw new DeploymentError(code, message, { step: 'services.start', details: { name, port, ...details } });
  };

  /**
   * On laisse au process le temps de VIVRE — ou de mourir. Sans cette pause,
   * « online » ne distingue pas un service sain d'un service qui redémarre :
   * un process qui boucle est en ligne une fraction de seconde sur deux.
   *
   * Sur un transport SIMULÉ, il n'y a aucun processus dont l'issue puisse
   * changer avec le temps : attendre n'observerait rien et ne ferait que
   * ralentir les vérifications. La pause porte sur le RÉEL, pas sur le code.
   */
  const simule = transport?.kind === 'fake';
  const pause = simule ? async () => {} : wait;

  if (settleMs > 0) await pause(settleMs);

  const premier = await readPm2Processes(transport);
  const proc = premier.processes.find((p) => p.name === name);
  if (!proc) {
    echec(PORT_ERRORS.PM2_PROCESS_UNSTABLE,
      `Le service « ${name} » n'est pas déclaré à PM2 après démarrage.`, { declared: premier.processes.map((p) => p.name) });
  }
  if (proc.status !== 'online') {
    echec(PORT_ERRORS.PM2_PROCESS_UNSTABLE,
      `Le service « ${name} » est ${proc.status ?? 'dans un état inconnu'} au lieu d'être en ligne.`,
      { status: proc.status, restarts: proc.restarts });
  }
  if (proc.pid === null || proc.pid === undefined || proc.pid === 0) {
    echec(PORT_ERRORS.PM2_PROCESS_UNSTABLE,
      `Le service « ${name} » est annoncé en ligne sans PID : il n'a pas de processus vivant.`,
      { status: proc.status });
  }

  // BOUCLE DE REDÉMARRAGE : on compare deux lectures espacées. Un compteur
  // élevé peut venir d'un historique ancien ; ce qui prouve une boucle, c'est
  // qu'il AUGMENTE pendant qu'on regarde.
  const depuisOperation = baselineRestarts === null ? null : proc.restarts - baselineRestarts;
  if (depuisOperation !== null && depuisOperation > UNSTABLE_RESTART_THRESHOLD) {
    echec(PORT_ERRORS.PM2_PROCESS_UNSTABLE,
      `Le service « ${name} » a redémarré ${depuisOperation} fois depuis le début de l'opération : il boucle.`,
      { restarts: proc.restarts, baselineRestarts, since: depuisOperation });
  }

  await pause(1500);
  const second = await readPm2Processes(transport);
  const apres = second.processes.find((p) => p.name === name);
  if (!apres) {
    echec(PORT_ERRORS.PM2_PROCESS_UNSTABLE,
      `Le service « ${name} » a disparu de PM2 pendant la vérification.`, {});
  }
  if (apres.restarts > proc.restarts) {
    echec(PORT_ERRORS.PM2_PROCESS_UNSTABLE,
      `Le service « ${name} » redémarre en boucle (${proc.restarts} → ${apres.restarts} pendant la vérification).`,
      { restarts: apres.restarts, previous: proc.restarts });
  }
  if (apres.pid !== proc.pid) {
    echec(PORT_ERRORS.PM2_PROCESS_UNSTABLE,
      `Le service « ${name} » a changé de processus pendant la vérification (pid ${proc.pid} → ${apres.pid}).`,
      { pid: apres.pid, previous: proc.pid });
  }

  // CHEMIN ET DOSSIER — la garde historique, conservée.
  const memeChemin = (valeur, attendu) => {
    if (!attendu) return true;
    if (!valeur) return false;
    const norm = (v) => String(v).replace(/\\/g, '/').replace(/\/+$/, '');
    return norm(valeur) === norm(attendu);
  };
  if (expectedExecPath && !memeChemin(apres.execPath, expectedExecPath)) {
    echec('PM2_STALE_PATH',
      `PM2 exécute ${apres.execPath ?? 'un fichier inconnu'} au lieu de ${expectedExecPath}.`,
      { execPath: apres.execPath, expected: expectedExecPath });
  }
  if (expectedCwd && !memeChemin(apres.cwd, expectedCwd)) {
    echec('PM2_STALE_PATH',
      `PM2 travaille dans ${apres.cwd ?? 'un dossier inconnu'} au lieu de ${expectedCwd}.`,
      { cwd: apres.cwd, expected: expectedCwd });
  }

  // LE PORT EST-IL ÉCOUTÉ, ET PAR NOTRE PID ?
  const { sockets, readable } = await readListeningSockets(transport);
  const socket = sockets.find((s) => s.port === port);
  if (readable && !socket) {
    echec(PORT_ERRORS.PM2_PROCESS_UNSTABLE,
      `Le service « ${name} » est en ligne mais n'écoute pas sur le port ${port}.`,
      { pid: apres.pid, listening: sockets.map((s) => s.port) });
  }
  if (readable && socket && socket.pid !== null && socket.pid !== apres.pid) {
    echec(PORT_ERRORS.PM2_PORT_NOT_OWNED,
      `Le port ${port} est écouté par le pid ${socket.pid} (${socket.process ?? 'inconnu'}) `
      + `et non par le service « ${name} » (pid ${apres.pid}). Le trafic n'arrive pas au code déployé.`,
      { pid: apres.pid, socketPid: socket.pid, socketProcess: socket.process });
  }

  return {
    name,
    port,
    pid: apres.pid,
    status: apres.status,
    restarts: apres.restarts,
    restartsSinceOperation: depuisOperation,
    execPath: apres.execPath,
    cwd: apres.cwd,
    portListened: Boolean(socket),
    portOwnedByService: Boolean(socket) && (socket.pid === null || socket.pid === apres.pid),
    socketsReadable: readable,
    healthy: true,
  };
}

/** Temporisation par défaut — injectable pour que les tests n'attendent pas. */
function defaultWait(ms) {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

export default {
  PORT_ERRORS,
  PORT_RANGE,
  NEVER_ALLOCATE,
  UNSTABLE_RESTART_THRESHOLD,
  MIN_STABLE_UPTIME_MS,
  readListeningSockets,
  readPm2Processes,
  readPortLandscape,
  probePort,
  findFreePort,
  assertPortAvailableFor,
  verifyServiceHealth,
};
