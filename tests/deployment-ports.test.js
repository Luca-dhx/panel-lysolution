// REGISTRE ET ALLOCATION DES PORTS — LOT 9.
//
// ══ CE QUI EST PROUVÉ ICI ═══════════════════════════════════════════════════
//
// Un port applicatif ne peut appartenir qu'à UNE destination vivante, sur UN
// serveur — et il n'est libre que si les trois sources le disent : la base,
// PM2, les sockets réelles.
//
// L'ancienne règle — « le plus haut port déjà attribué en base, plus un » — ne
// consultait qu'une seule source. Après la suppression de la fiche de
// `panel.lycarz.com`, le port 5100 est redescendu dans la plage libre et a été
// réattribué, alors que l'ancien backend le DÉTENAIT toujours. Le nouveau
// service a bouclé sur EADDRINUSE plus de 7 000 fois pendant que Nginx
// envoyait le trafic du nouveau domaine vers l'ancien code.
//
// On vérifie donc, séparément :
//   1. le MOTEUR lit le serveur (sockets, PM2) et refuse ce qu'il ne peut pas
//      prouver — collision, PID étranger, boucle de redémarrage ;
//   2. le REGISTRE réserve transactionnellement, ne libère que sur preuve, et
//      ne recycle jamais un port qu'il n'a pas vu libre.
import {
  check, connectTestDatabase, finish, section, setTestEnv,
  startMemoryMongo, stopMemoryMongo,
} from './helpers/harness.js';

setTestEnv();
await startMemoryMongo();
await connectTestDatabase();

const {
  PORT_ERRORS, PORT_RANGE, NEVER_ALLOCATE, findFreePort, readListeningSockets,
  readPm2Processes, readPortLandscape, probePort, assertPortAvailableFor, verifyServiceHealth,
} = await import('../backend/src/deployment-engine/ports.js');
const { restartBackend, pm2AppName } = await import('../backend/src/deployment-engine/pm2.js');
const { FakeTransport } = await import('../backend/src/deployment-engine/transport/FakeTransport.js');

const registry = await import('../backend/src/services/deployment/portRegistry.service.js');
const targets = await import('../backend/src/services/deployment/deploymentTarget.service.js');
const lifecycle = await import('../backend/src/services/deployment/destinationLifecycle.service.js');
const PanelPortReservation = (await import('../backend/src/models/PanelPortReservation.model.js')).default;
const PanelDeploymentTarget = (await import('../backend/src/models/PanelDeploymentTarget.model.js')).default;

const SERVEUR = '203.0.113.10';

/* ══════════════════════════════════════════════════════════════════════════ */
/*  UN SERVEUR SIMULÉ — sockets réelles + process PM2                        */
/* ══════════════════════════════════════════════════════════════════════════ */

/** Ligne `ss -ltnp` telle qu'un serveur Linux la produit. */
function ligneSs({ port, pid, nom = 'node', adresse = '127.0.0.1' }) {
  return `LISTEN 0      511          ${adresse}:${port}          0.0.0.0:*    `
    + (pid ? `users:(("${nom}",pid=${pid},fd=23))` : '');
}

/**
 * Serveur simulé : ce que `ss` montre, et ce que PM2 déclare. Les deux sont
 * distincts À DESSEIN — c'est justement leur divergence qui révèle un port
 * détenu par un process oublié.
 */
class Serveur extends FakeTransport {
  constructor({ sockets = [], pm2 = {}, ssIllisible = false } = {}) {
    super({ pm2 });
    this.sockets = sockets;
    this.ssIllisible = ssIllisible;
    /** Ports dont la socket a été ouverte par PM2 — donc refermée avec lui. */
    this.socketsDePm2 = new Set();
  }

  /**
   * Un process qui démarre OUVRE sa socket ; supprimé, il la referme. Sans
   * cela, le double présenterait un service « en ligne » qui n'écoute rien —
   * un état que le moteur refuse à juste titre, mais qui ne dit rien du code.
   */
  _synchroniserSockets() {
    const actifs = new Map();
    for (const [, etat] of this.pm2) {
      if (etat && typeof etat === 'object' && etat.port) actifs.set(etat.port, etat.pid ?? null);
    }
    this.sockets = this.sockets.filter((s) => !this.socketsDePm2.has(s.port) || actifs.has(s.port));
    for (const [port, pid] of actifs) {
      if (!this.sockets.some((s) => s.port === port)) {
        this.sockets.push({ port, pid, nom: 'node' });
        this.socketsDePm2.add(port);
      }
    }
  }

  async exec(command, opts = {}) {
    if (/pm2 (start|delete)/.test(command)) {
      const res = await super.exec(command, opts);
      this._synchroniserSockets();
      return res;
    }
    if (/^ss -ltnp/.test(command)) {
      this.commands.push({ command, opts });
      if (this.ssIllisible) return { code: 0, stdout: '__NO_TOOL__', stderr: '' };
      return {
        code: 0,
        stdout: ['State  Recv-Q Send-Q Local Address:Port  Peer Address:Port Process',
          ...this.sockets.map(ligneSs)].join('\n'),
        stderr: '',
      };
    }
    return super.exec(command, opts);
  }
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('LECTURE DU SERVEUR — trois sources, jamais une seule');
{
  const tx = new Serveur({
    sockets: [
      { port: 5100, pid: 4242 },
      { port: 443, pid: 900, nom: 'nginx', adresse: '*' },
      { port: 27017, pid: 700, nom: 'mongod' },
    ],
    pm2: {
      'panel-a.exemple.com': { execPath: '/var/www/a/backend/src/server.js', port: 5100, pid: 4242, status: 'online' },
      'panel-b.exemple.com': { execPath: '/var/www/b/backend/src/server.js', port: 5101, pid: 4243, status: 'online' },
    },
  });

  const socks = await readListeningSockets(tx);
  check('les sockets sont lues', socks.readable === true && socks.sockets.length === 3);
  check('…avec leur port', socks.sockets.some((s) => s.port === 5100));
  check('…et le PID qui les détient', socks.sockets.find((s) => s.port === 5100).pid === 4242);
  check('…et le nom du programme', socks.sockets.find((s) => s.port === 443).process === 'nginx');

  const procs = await readPm2Processes(tx);
  check('les process PM2 sont lus', procs.readable === true && procs.processes.length === 2);
  check('…avec le port de leur environnement',
    procs.processes.find((p) => p.name === 'panel-b.exemple.com').port === 5101);

  const paysage = await readPortLandscape(tx);
  check('le paysage réunit sockets ET process',
    paysage.occupied.includes(5100) && paysage.occupied.includes(5101)
    && paysage.occupied.includes(443) && paysage.occupied.includes(27017));

  const sonde = await probePort(tx, 5100);
  check('une sonde nomme le détenteur d’un port', sonde.free === false && sonde.holder.pid === 4242);
  check('…et le service PM2 correspondant', sonde.pm2Name === 'panel-a.exemple.com');
  check('un port libre est annoncé libre', (await probePort(tx, 5300)).free === true);

  // UNE LECTURE RATÉE N'EST PAS « AUCUN PORT OCCUPÉ ».
  const aveugle = new Serveur({ ssIllisible: true });
  const rate = await readListeningSockets(aveugle);
  check('une lecture impossible est signalée, pas confondue avec « rien »',
    rate.readable === false && rate.sockets.length === 0);
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('CHOIX D’UN PORT — une fonction pure, toutes les sources exclues');
{
  check('le premier port de la plage est pris quand tout est libre',
    findFreePort({}) === PORT_RANGE.from);
  check('un port réservé en base est exclu',
    findFreePort({ reserved: [5100] }) === 5101);
  check('un port occupé sur le serveur est exclu',
    findFreePort({ occupied: [5100, 5101] }) === 5102);
  check('les deux sources se cumulent',
    findFreePort({ reserved: [5100], occupied: [5101] }) === 5102);
  check('un port explicitement écarté l’est aussi',
    findFreePort({ excluded: [5100, 5101, 5102] }) === 5103);

  // Un service système temporairement arrêté reste son propriétaire légitime.
  check('les ports de services connus ne sont JAMAIS attribués',
    NEVER_ALLOCATE.every((p) => findFreePort({ range: { from: p, to: p + 5 } }) !== p));

  let code = null;
  try {
    findFreePort({ range: { from: 5100, to: 5102 }, occupied: [5100, 5101, 5102] });
  } catch (err) { code = err.code; }
  check('une plage entièrement occupée est refusée explicitement',
    code === PORT_ERRORS.PORT_RANGE_EXHAUSTED);
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('AVANT DÉMARRAGE — on s’arrête, on ne dispute jamais un port');
{
  const notre = 'panel-a.exemple.com';

  // 1. Port libre : on démarre.
  const libre = new Serveur({ sockets: [], pm2: {} });
  const ok = await assertPortAvailableFor(libre, { port: 5100, host: 'a.exemple.com', expectedPm2Name: notre });
  check('un port libre autorise le démarrage', ok.free === true);

  // 2. Port détenu par NOTRE service : redéploiement, on démarre.
  const nous = new Serveur({
    sockets: [{ port: 5100, pid: 4242 }],
    pm2: { [notre]: { execPath: '/var/www/a/backend/src/server.js', port: 5100, pid: 4242, status: 'online' } },
  });
  const reprise = await assertPortAvailableFor(nous, { port: 5100, host: 'a.exemple.com', expectedPm2Name: notre });
  check('un port détenu par notre propre service autorise le redéploiement',
    reprise.heldByUs === true);

  // 3. Port détenu par un AUTRE service PM2 — le cas exact de l'incident.
  const autre = new Serveur({
    sockets: [{ port: 5100, pid: 9999 }],
    pm2: { 'panel-lycarz.exemple.com': { execPath: '/var/www/vieux/backend/src/server.js', port: 5100, pid: 9999, status: 'online' } },
  });
  let err = null;
  await assertPortAvailableFor(autre, { port: 5100, host: 'a.exemple.com', expectedPm2Name: notre })
    .catch((e) => { err = e; });
  check('un port tenu par un autre service PM2 ARRÊTE le démarrage',
    err?.code === PORT_ERRORS.PM2_PORT_COLLISION);
  check('…en nommant le service fautif', err?.details?.holder === 'panel-lycarz.exemple.com');

  // 4. Port détenu par un programme inconnu du Panel.
  const inconnu = new Serveur({ sockets: [{ port: 5100, pid: 777, nom: 'postgres' }], pm2: {} });
  err = null;
  await assertPortAvailableFor(inconnu, { port: 5100, host: 'a.exemple.com', expectedPm2Name: notre })
    .catch((e) => { err = e; });
  check('un port tenu par un programme inconnu ARRÊTE le démarrage',
    err?.code === PORT_ERRORS.PORT_IN_USE_UNKNOWN_PROCESS);
  check('…en le nommant', err?.details?.holder === 'postgres');

  // On ne tue jamais le détenteur : aucune commande destructrice n'est émise.
  check('…et rien n’est tué pour libérer le port',
    !inconnu.commands.some(({ command }) => /kill|pm2 delete|fuser/.test(command)));
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('SANTÉ DU SERVICE — bien au-delà du chemin exécuté');
{
  const NOM = 'panel-a.exemple.com';
  const CHEMIN = '/var/www/a/backend/src/server.js';
  const DOSSIER = '/var/www/a/backend';

  // Sain : en ligne, stable, PID connu, port écouté par CE pid.
  const sain = new Serveur({
    sockets: [{ port: 5100, pid: 4242 }],
    pm2: { [NOM]: { execPath: CHEMIN, cwd: DOSSIER, port: 5100, pid: 4242, status: 'online', restarts: 0 } },
  });
  const sante = await verifyServiceHealth(sain, {
    name: NOM, port: 5100, expectedExecPath: CHEMIN, expectedCwd: DOSSIER,
  });
  check('un service sain est déclaré sain', sante.healthy === true);
  check('…avec son PID', sante.pid === 4242);
  check('…la preuve que le port est écouté', sante.portListened === true);
  check('…et que la socket lui appartient', sante.portOwnedByService === true);

  const refus = async (etat, options = {}) => {
    const tx = new Serveur({ sockets: options.sockets ?? [{ port: 5100, pid: 4242 }], pm2: { [NOM]: etat } });
    let e = null;
    await verifyServiceHealth(tx, {
      name: NOM, port: 5100, expectedExecPath: CHEMIN, expectedCwd: DOSSIER, ...options.args,
    }).catch((x) => { e = x; });
    return e;
  };

  let e = await refus({ execPath: CHEMIN, cwd: DOSSIER, port: 5100, pid: 4242, status: 'errored' });
  check('un service « errored » est refusé', e?.code === PORT_ERRORS.PM2_PROCESS_UNSTABLE);

  e = await refus({ execPath: CHEMIN, cwd: DOSSIER, port: 5100, pid: 0, status: 'online' });
  check('un service « en ligne » sans PID est refusé — il n’a pas de processus',
    e?.code === PORT_ERRORS.PM2_PROCESS_UNSTABLE);

  // BOUCLE DE REDÉMARRAGE — le cas des 7 000 redémarrages.
  e = await refus(
    { execPath: CHEMIN, cwd: DOSSIER, port: 5100, pid: 4242, status: 'online', restarts: 7412 },
    { args: { baselineRestarts: 7400 } },
  );
  check('un service qui a redémarré 12 fois depuis le début de l’opération BOUCLE',
    e?.code === PORT_ERRORS.PM2_PROCESS_UNSTABLE);
  check('…et le rapport dit combien de fois', e?.details?.since === 12);

  // Le port est écouté par un AUTRE processus que le nôtre.
  e = await refus(
    { execPath: CHEMIN, cwd: DOSSIER, port: 5100, pid: 4242, status: 'online' },
    { sockets: [{ port: 5100, pid: 9999, nom: 'vieux-node' }] },
  );
  check('un port écouté par un autre PID est refusé', e?.code === PORT_ERRORS.PM2_PORT_NOT_OWNED);
  check('…en nommant le PID fautif', e?.details?.socketPid === 9999);

  // En ligne mais n'écoute rien : le service ne sert pas.
  e = await refus(
    { execPath: CHEMIN, cwd: DOSSIER, port: 5100, pid: 4242, status: 'online' },
    { sockets: [] },
  );
  check('un service en ligne qui n’écoute pas son port est refusé',
    e?.code === PORT_ERRORS.PM2_PROCESS_UNSTABLE);

  // Le chemin reste contrôlé — la garde historique n'a pas disparu.
  e = await refus({ execPath: '/ailleurs/src/server.js', cwd: '/ailleurs', port: 5100, pid: 4242, status: 'online' });
  check('un chemin exécuté différent reste refusé', e?.code === 'PM2_STALE_PATH');
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('DÉMARRAGE — la collision est vue AVANT pm2 start, jamais après');
{
  const HOTE = 'neuve.exemple.com';
  const BACKEND = `/var/www/${HOTE}/backend`;

  // Un ancien service oublié détient déjà le port : c'est l'incident.
  const occupe = new Serveur({
    sockets: [{ port: 5100, pid: 9999 }],
    pm2: { 'panel-vieux.exemple.com': { execPath: '/var/www/vieux/backend/src/server.js', port: 5100, pid: 9999, status: 'online' } },
  });
  let err = null;
  await restartBackend(occupe, { host: HOTE, backendDir: BACKEND, port: 5100, env: 'TEST' })
    .catch((e) => { err = e; });
  check('un port déjà détenu empêche le démarrage', err?.code === PORT_ERRORS.PM2_PORT_COLLISION);
  check('…et AUCUN pm2 start n’a été tenté', !occupe.ran('pm2 start'));
  check('…ni aucune sauvegarde de liste PM2 sur un état faux', !occupe.ran('pm2 save'));

  // Serveur sain : le démarrage a lieu, et la preuve est rendue.
  const sain = new Serveur({ sockets: [], pm2: {} });
  const info = await restartBackend(sain, { host: HOTE, backendDir: BACKEND, port: 5100, env: 'TEST' });
  check('sur un serveur sain, le service démarre', info.action === 'start');
  check('…le port est rendu avec la preuve', info.port === 5100 && info.pid !== null);
  check('…et le nom PM2 suit la convention', info.name === pm2AppName(HOTE));
  check('…la liste PM2 est persistée APRÈS la preuve',
    sain.indexOf('pm2 save') > sain.indexOf('pm2 start'));
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('REGISTRE — réservation transactionnelle et propriétaire unique');
{
  await PanelDeploymentTarget.deleteMany({});
  await PanelPortReservation.deleteMany({});

  const a = await targets.createTarget({
    name: 'Alpha', url: 'https://a.exemple.com', environment: 'TEST', sshHost: SERVEUR,
  });
  // Une seule destination ACTIVE par environnement : la seconde est donc PROD.
  // Deux mondes, deux destinations, un seul serveur — le cas réel.
  const b = await targets.createTarget({
    name: 'Beta', url: 'https://b.exemple.com', environment: 'PROD', sshHost: SERVEUR,
  });

  check('deux destinations d’un même serveur reçoivent deux ports',
    a.backendPort !== b.backendPort);
  check('…dans la plage applicative',
    a.backendPort >= PORT_RANGE.from && b.backendPort <= PORT_RANGE.to);

  const resA = await registry.reservationFor(a.targetId);
  check('chaque port a une réservation', resA?.port === a.backendPort);
  check('…qui nomme son serveur', resA.serverKey === SERVEUR);
  check('…son environnement', resA.environment === 'TEST');
  check('…son type de service', resA.serviceType === 'backend');
  check('…et son état de départ', resA.status === 'RESERVED');
  check('une réservation faite sans connexion N’EST PAS déclarée vérifiée',
    resA.lastVerifiedAt === null);

  // MÊME DESTINATION → MÊME PORT. Un redéploiement ne change jamais de port :
  // Nginx et PM2 le référencent tous les deux.
  const encore = await registry.reservePort({ target: { ...a, sshHost: SERVEUR } });
  check('la même destination retrouve TOUJOURS son port',
    encore.port === a.backendPort && encore.reused === true);

  /**
   * Un autre SERVEUR peut porter le même numéro : un port appartient à une
   * machine, pas au Panel.
   *
   * On s'adresse ici au REGISTRE directement, sans créer de destination : le
   * Panel n'a qu'une destination active par environnement, et les deux sont
   * déjà prises ci-dessus. Ce que l'on vérifie — la portée par serveur — est
   * une propriété du registre, pas du cycle de vie des fiches.
   */
  const ailleurs = await registry.reservePort({
    target: {
      targetId: 'ailleurs', sshHost: '203.0.113.99',
      environment: 'PROD', host: 'ailleurs.exemple.com',
    },
  });
  check('un autre serveur peut réutiliser le même numéro',
    ailleurs.port === a.backendPort);

  // CONCURRENCE : deux réservations simultanées ne peuvent pas obtenir le
  // même port. L'index unique partiel tranche ; la perdante prend le suivant.
  const [c1, c2] = await Promise.all([
    registry.reservePort({ target: { targetId: 'sim-1', sshHost: SERVEUR, environment: 'TEST', host: 'sim1.exemple.com' } }),
    registry.reservePort({ target: { targetId: 'sim-2', sshHost: SERVEUR, environment: 'TEST', host: 'sim2.exemple.com' } }),
  ]);
  check('deux réservations simultanées obtiennent deux ports DIFFÉRENTS',
    c1.port !== c2.port);
  const doublons = await PanelPortReservation.aggregate([
    { $match: { serverKey: SERVEUR, status: { $ne: 'RELEASED' } } },
    { $group: { _id: '$port', n: { $sum: 1 } } },
    { $match: { n: { $gt: 1 } } },
  ]);
  check('…et aucun port n’a deux propriétaires vivants', doublons.length === 0);
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('LIBÉRATION — un port n’est rendu que sur PREUVE');
{
  const cible = await PanelDeploymentTarget.findOne({ host: 'a.exemple.com' }).lean();
  const port = cible.backendPort;

  await registry.beginRelease(cible.targetId);
  const enCours = await registry.reservationFor(cible.targetId);
  check('la libération engagée met la réservation en RELEASING',
    enCours.status === 'RELEASING');
  check('…mais le port reste RETENU',
    (await registry.reservedPorts(SERVEUR)).includes(port));

  // Sans preuve, le port N'EST PAS rendu — c'est la règle qui empêche la
  // répétition de l'incident.
  const sansPreuve = await registry.releasePort(cible.targetId, { verifiedFree: false, reason: 'retrait interrompu' });
  check('sans preuve, le port n’est PAS rendu', sansPreuve.released === false);
  check('…et reste retenu', (await registry.reservedPorts(SERVEUR)).includes(port));
  check('…la raison est consignée', sansPreuve.reservation.lastConflict?.kind === 'UNVERIFIED');

  // Avec preuve, il retourne à la plage libre.
  const avecPreuve = await registry.releasePort(cible.targetId, { verifiedFree: true });
  check('constaté libre sur le serveur, le port est rendu', avecPreuve.released === true);
  check('…la réservation passe RELEASED', avecPreuve.reservation.status === 'RELEASED');
  check('…et il quitte les ports retenus',
    !(await registry.reservedPorts(SERVEUR)).includes(port));

  // RÉUTILISATION SÛRE : le port rendu redevient attribuable — et c'est le
  // plus petit libre, donc celui-là.
  const suivante = await registry.reservePort({
    target: { targetId: 'apres-liberation', sshHost: SERVEUR, environment: 'TEST', host: 'suivante.exemple.com' },
  });
  check('un port rendu redevient attribuable', suivante.port === port);

  // L'HISTOIRE EST CONSERVÉE : on peut dire qui l'avait avant.
  const historique = await PanelPortReservation.find({ serverKey: SERVEUR, port }).lean();
  check('l’historique du port est conservé', historique.length >= 2);
  check('…dont une ligne RELEASED', historique.some((h) => h.status === 'RELEASED'));
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('VÉRIFICATION AVANT DÉMARRAGE — le registre s’oppose au serveur');
{
  await PanelDeploymentTarget.deleteMany({});
  await PanelPortReservation.deleteMany({});

  const cible = await targets.createTarget({
    name: 'Vérif', url: 'https://verif.exemple.com', environment: 'TEST', sshHost: SERVEUR,
  });
  const nom = pm2AppName(cible.host);

  // Serveur sain : la vérification passe et horodate.
  const sain = new Serveur({ sockets: [], pm2: {} });
  const verdict = await registry.verifyBeforeStart({ target: cible, transport: sain, expectedPm2Name: nom });
  check('un port libre passe la vérification', verdict.free === true);
  const apres = await registry.reservationFor(cible.targetId);
  check('…et la réservation est horodatée comme vérifiée', typeof apres.lastVerifiedAt === 'string');

  // Un service oublié détient le port : STOP.
  const squatte = new Serveur({
    sockets: [{ port: cible.backendPort, pid: 9999 }],
    pm2: { 'panel-oublie.exemple.com': { execPath: '/var/www/oublie/backend/src/server.js', port: cible.backendPort, pid: 9999, status: 'online' } },
  });
  let err = null;
  await registry.verifyBeforeStart({ target: cible, transport: squatte, expectedPm2Name: nom })
    .catch((e) => { err = e; });
  check('un service PM2 étranger sur le port ARRÊTE le déploiement',
    err?.code === PORT_ERRORS.PM2_PORT_COLLISION);
  const marque = await registry.reservationFor(cible.targetId);
  check('…et le conflit est consigné sur la réservation', marque.lastConflict?.kind === 'PM2');

  // Un programme inconnu détient le port : STOP également.
  const inconnu = new Serveur({ sockets: [{ port: cible.backendPort, pid: 777, nom: 'postgres' }], pm2: {} });
  err = null;
  await registry.verifyBeforeStart({ target: cible, transport: inconnu, expectedPm2Name: nom })
    .catch((e) => { err = e; });
  check('un programme inconnu sur le port ARRÊTE le déploiement',
    err?.code === PORT_ERRORS.PORT_IN_USE_UNKNOWN_PROCESS);

  // Une AUTRE destination du Panel réserve ce port : conflit de registre.
  await PanelPortReservation.create({
    serverKey: SERVEUR, port: 5900, deploymentTargetId: 'concurrente', environment: 'TEST',
    status: 'RESERVED', reservedAt: new Date().toISOString(),
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  });
  await PanelPortReservation.updateOne(
    { deploymentTargetId: cible.targetId, status: { $ne: 'RELEASED' } },
    { $set: { port: 5900 } },
  ).catch(() => {});
  const conflit = await PanelPortReservation.find({ serverKey: SERVEUR, port: 5900, status: { $ne: 'RELEASED' } }).lean();
  check('l’index refuse deux réservations vivantes du même port', conflit.length === 1);
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('ACTIVATION — un port n’est ACTIF qu’après preuve');
{
  await PanelDeploymentTarget.deleteMany({});
  await PanelPortReservation.deleteMany({});

  const cible = await targets.createTarget({
    name: 'Activation', url: 'https://activation.exemple.com', environment: 'TEST', sshHost: SERVEUR,
  });
  const avant = await registry.reservationFor(cible.targetId);
  check('une destination créée a un port RÉSERVÉ, pas ACTIF', avant.status === 'RESERVED');
  check('…sans PID, puisque rien ne tourne encore', avant.pid === null);

  const actif = await registry.activateReservation(cible.targetId, { pid: 4242, processName: pm2AppName(cible.host) });
  check('l’activation exige un PID et le consigne', actif.status === 'ACTIVE' && actif.pid === 4242);
  check('…avec le nom du process qui détient le port',
    actif.processName === pm2AppName(cible.host));
  check('…et son horodatage', typeof actif.activatedAt === 'string');
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('ROLLBACK — une création ratée ne retient aucun port');
{
  const avant = (await registry.reservedPorts(SERVEUR)).length;

  // Une création refusée (hôte déjà pris) ne doit laisser aucune réservation.
  let refus = null;
  await targets.createTarget({
    name: 'Doublon', url: 'https://activation.exemple.com', environment: 'TEST', sshHost: SERVEUR,
  }).catch((e) => { refus = e; });
  check('une création en doublon est refusée', refus?.code === 'PANEL_TARGET_HOST_TAKEN');
  check('…et ne retient aucun port supplémentaire',
    (await registry.reservedPorts(SERVEUR)).length === avant);

  // Rollback explicite d'une réservation orpheline.
  const orpheline = await registry.reservePort({
    target: { targetId: 'orpheline', sshHost: SERVEUR, environment: 'TEST', host: 'orpheline.exemple.com' },
  });
  const annulee = await registry.rollbackReservation('orpheline', { reason: 'test' });
  check('une réservation annulée est rendue', annulee.status === 'RELEASED');
  check('…et son port redevient libre',
    !(await registry.reservedPorts(SERVEUR)).includes(orpheline.port));
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('CYCLE COMPLET — vidée puis redéployée, sans jamais partager un port');
{
  await PanelDeploymentTarget.deleteMany({});
  await PanelPortReservation.deleteMany({});

  const cible = await targets.createTarget({
    name: 'Cycle', url: 'https://cycle.exemple.com', environment: 'TEST', sshHost: SERVEUR,
  });
  const port = cible.backendPort;

  await lifecycle.beginDeprovision(cible.targetId, { runId: 'r1' });
  await registry.beginRelease(cible.targetId);
  await lifecycle.markEmpty(cible.targetId, { runId: 'r1' });

  // Tant que le port n'a pas été CONSTATÉ libre, il reste retenu — même une
  // fois la destination vidée.
  check('une destination vidée dont le port n’a pas été constaté libre le retient encore',
    (await registry.reservedPorts(SERVEUR)).includes(port));

  const voisine = await targets.createTarget({
    name: 'Voisine', url: 'https://voisine-cycle.exemple.com', environment: 'PROD', sshHost: SERVEUR,
  });
  check('…et une nouvelle destination reçoit donc un AUTRE port',
    voisine.backendPort !== port);

  // Le port est constaté libre : il est rendu.
  await registry.releasePort(cible.targetId, { verifiedFree: true });
  check('constaté libre, il quitte les ports retenus',
    !(await registry.reservedPorts(SERVEUR)).includes(port));

  // Redéploiement de la destination vidée : elle reprend un port vérifié.
  const reprise = await registry.reservePort({ target: { ...cible, sshHost: SERVEUR } });
  check('la destination redéployée reçoit un port', Number.isInteger(reprise.port));
  check('…et ce n’est jamais celui de sa voisine', reprise.port !== voisine.backendPort);
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('MIGRATION — les ports existants sont enregistrés, jamais réattribués');
{
  await PanelDeploymentTarget.deleteMany({});
  await PanelPortReservation.deleteMany({});

  // Deux fiches telles qu'elles existaient AVANT le registre.
  const base = {
    type: 'subdomain', environment: 'PROD', remoteRoot: '/var/www', state: 'DEPLOYED',
    lifecycleStatus: 'ACTIVE', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    history: [],
  };
  await PanelDeploymentTarget.collection.insertMany([
    // Une seule ACTIVE par environnement : ces fiches héritées se répartissent
    // donc sur les deux mondes. C'est bien ce que la migration doit accepter —
    // elle reprend l'existant, elle ne le réarbitre pas.
    { ...base, targetId: 'legacy-1', name: 'Un', url: 'https://un.exemple.com', host: 'un.exemple.com', backendPort: 5100, sshHost: SERVEUR },
    { ...base, environment: 'TEST', targetId: 'legacy-2', name: 'Deux', url: 'https://deux.exemple.com', host: 'deux.exemple.com', backendPort: 5101, sshHost: SERVEUR },
    { ...base, targetId: 'legacy-3', name: 'Vidée', url: 'https://vide.exemple.com', host: 'vide.exemple.com', backendPort: 5102, sshHost: SERVEUR, lifecycleStatus: 'EMPTY' },
  ]);

  const rapport = await registry.migratePortRegistry();
  check('chaque destination existante reçoit sa réservation', rapport.reservationsCreated === 3);
  check('…aucun conflit sur des ports distincts', rapport.conflicts === 0);

  const un = await registry.reservationFor('legacy-1');
  check('le port en place est CONSERVÉ, jamais réattribué', un.port === 5100);
  check('…et n’est pas déclaré vérifié — aucun serveur n’a été consulté',
    un.lastVerifiedAt === null);
  check('…ni actif — aucune preuve n’a été faite', un.status === 'RESERVED');

  const videe = await registry.reservationFor('legacy-3');
  check('une destination VIDÉE voit son port en libération, pas libéré',
    videe.status === 'RELEASING');
  check('…donc toujours retenu, faute de preuve',
    (await registry.reservedPorts(SERVEUR)).includes(5102));

  // Relancer la migration ne crée rien.
  const encore = await registry.migratePortRegistry();
  check('la migration est idempotente', encore.reservationsCreated === 0);

  // DEUX FICHES SUR LE MÊME PORT — l'incident lui-même. On le SIGNALE.
  await PanelPortReservation.deleteMany({});
  await PanelDeploymentTarget.collection.updateOne(
    { targetId: 'legacy-2' }, { $set: { backendPort: 5100 } },
  );
  const conflictuel = await registry.migratePortRegistry();
  check('deux destinations sur le même port sont signalées',
    conflictuel.conflicts === 1);
  check('…et une seule réservation vivante subsiste sur ce port',
    (await PanelPortReservation.countDocuments({ serverKey: SERVEUR, port: 5100, status: { $ne: 'RELEASED' } })) === 1);
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('ARCHITECTURE — le moteur lit le serveur, l’application tient la base');
{
  const fs = await import('node:fs');
  const path = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const racine = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const lire = (...p) => fs.readFileSync(path.join(racine, ...p), 'utf8');

  const moteur = lire('backend', 'src', 'deployment-engine', 'ports.js');
  check('le moteur des ports n’importe AUCUN modèle du Panel',
    !/models\//.test(moteur));
  check('…ni le registre applicatif', !/portRegistry/.test(moteur));
  check('…il ne parle qu’au Transport', /transport\.exec/.test(moteur));

  const registre = lire('backend', 'src', 'services', 'deployment', 'portRegistry.service.js');
  check('le registre s’appuie sur le moteur pour lire le serveur',
    /deployment-engine\/ports\.js/.test(registre));
  check('…et ne reconstruit aucune commande distante',
    !/ss -ltnp|pm2 jlist/.test(registre));

  // L'ancienne règle ne doit plus exister nulle part.
  const service = lire('backend', 'src', 'services', 'deployment', 'deploymentTarget.service.js');
  check('l’allocation « plus haut port + 1 » a disparu du service des destinations',
    !/backendPort: -1/.test(service) && !/allocateBackendPort\s*\(/.test(service));
  check('…et le port affiché nomme sa nouvelle origine',
    /registre des ports/.test(service));
}

await stopMemoryMongo();
finish();
