// CYCLE DE VIE DES DESTINATIONS — LOT 8.
//
// ══ CE QUI EST PROUVÉ ICI ═══════════════════════════════════════════════════
//
// Une destination ACTIVE ne peut pas être supprimée. C'est la règle, et tout
// ce fichier tourne autour d'elle.
//
// Elle vient d'un incident réel : la fiche de `panel.lycarz.com` a été
// supprimée après un déménagement, et RIEN n'a été retiré du serveur — process
// PM2 en ligne détenant le port 5100, configuration Nginx active, 49 Mo de
// fichiers. La fiche disparue, l'allocation de port a recyclé 5100 pour la
// destination suivante : l'ancien backend le tenait, le nouveau bouclait sur
// EADDRINUSE, et Nginx envoyait le nouveau domaine vers l'ANCIEN code.
//
// On vérifie donc deux choses distinctes :
//   1. le MOTEUR retire réellement, et refuse tout ce qui est douteux
//      (chemin, lien sortant, donnée persistante, process survivant) ;
//   2. le PANEL tient le cycle de vie : ACTIVE → DEPROVISIONING → EMPTY →
//      DELETED, avec ses refus et ses reprises.
//
// Aucun serveur n'est contacté : le moteur est piloté par un double de
// transport qui modélise un vrai serveur (dossiers, PM2, ports, Nginx).
import {
  check, connectTestDatabase, finish, section, setTestEnv,
  startMemoryMongo, stopMemoryMongo,
} from './helpers/harness.js';

setTestEnv();
await startMemoryMongo();
await connectTestDatabase();

const {
  DEPROVISION_STEPS, assertSafeSiteRoot, renderNginxQuarantine, runDeprovision,
  inspectDestination, quarantineConfigPath,
} = await import('../backend/src/deployment-engine/deprovision.js');
const { FakeTransport } = await import('../backend/src/deployment-engine/transport/FakeTransport.js');
const { serviceName } = await import('../backend/src/deployment-engine/config/project.profile.js');

const targets = await import('../backend/src/services/deployment/deploymentTarget.service.js');
const lifecycle = await import('../backend/src/services/deployment/destinationLifecycle.service.js');
const executor = await import('../backend/src/services/deployment/deploymentExecutor.service.js');
const runs = await import('../backend/src/services/deployment/deploymentRun.service.js');
const PanelDeploymentTarget = (await import('../backend/src/models/PanelDeploymentTarget.model.js')).default;
const PanelDeploymentRun = (await import('../backend/src/models/PanelDeploymentRun.model.js')).default;

const HOST = 'retrait.exemple.com';
const REMOTE_ROOT = '/var/www';
const SITE_ROOT = `${REMOTE_ROOT}/${HOST}`;
const PM2_NAME = serviceName(HOST);
const PORT = 5199;

/* ══════════════════════════════════════════════════════════════════════════ */
/*  UN SERVEUR SIMULÉ — dossiers, PM2, ports, Nginx                          */
/* ══════════════════════════════════════════════════════════════════════════ */

/**
 * Le double de transport de base répond « 0 » à tout : il ne peut donc pas
 * révéler qu'une suppression n'a pas eu lieu, ni qu'un process a survécu.
 * Celui-ci modélise l'état minimal dont le retrait dépend — et le fait
 * ÉVOLUER : un dossier supprimé n'existe plus à l'étape suivante.
 */
class ServeurSimule extends FakeTransport {
  // Les compteurs portent des noms EN `…Count` : `files` et `uploads`
  // appartiennent déjà au transport simulé (système de fichiers virtuel et
  // historique des transferts). Les écraser rendait `writeFile` impossible —
  // et le retrait échouait à la quarantaine pour une raison sans rapport.
  constructor({
    dirs = [SITE_ROOT], resolved = {}, size = '49M', fileCount = 128,
    uploadCount = 0, storageCount = 0, symlinks = [], portHeldBy = null,
    pm2 = { [PM2_NAME]: `${SITE_ROOT}/backend/src/server.js` },
    nginxEnabled = [`/etc/nginx/sites-enabled/${HOST}.conf`],
    portStaysHeld = false,
    pm2Survives = false,
  } = {}) {
    super({ pm2 });
    this.dirs = new Set(dirs);
    this.resolved = resolved;
    this.size = size;
    this.fileCount = fileCount;
    this.uploadCount = uploadCount;
    this.storageCount = storageCount;
    this.symlinks = symlinks;
    this.portHeldBy = portHeldBy;
    this.nginxEnabled = new Set(nginxEnabled);
    this.portStaysHeld = portStaysHeld;
    this.pm2Survives = pm2Survives;
  }

  async exec(command, opts = {}) {
    this.commands.push({ command, opts });

    let m = command.match(/^test -d (\S+) && echo OUI \|\| echo NON$/);
    if (m) return this._out(this.dirs.has(m[1]) ? 'OUI' : 'NON');

    m = command.match(/^test -e (\S+) && echo OUI \|\| echo NON$/);
    if (m) return this._out(this.nginxEnabled.has(m[1]) ? 'OUI' : 'NON');

    m = command.match(/^readlink -f (\S+) /);
    if (m) return this._out(this.dirs.has(m[1]) ? (this.resolved[m[1]] ?? m[1]) : 'ABSENT');

    if (/^du -sh /.test(command)) return this._out(this.size);

    m = command.match(/^find (\S+) -type f /);
    if (m) {
      if (m[1].endsWith('/shared/uploads')) return this._out(String(this.uploadCount));
      if (m[1].endsWith('/shared/storage')) return this._out(String(this.storageCount));
      return this._out(String(this.fileCount));
    }

    if (/-type l -exec readlink/.test(command)) return this._out(this.symlinks.join('\n'));

    if (/^ss -ltnp /.test(command)) {
      // `portStaysHeld` : le port reste détenu même après l'arrêt du service.
      const encore = this.portHeldBy && (this.portStaysHeld || !this.pm2Deleted);
      return this._out(encore ? this.portHeldBy : 'LIBRE');
    }

    m = command.match(/^rm -rf (\S+)$/);
    if (m) { this.dirs.delete(m[1]); return this._out(''); }

    m = command.match(/^sudo rm -f (\S+)$/);
    if (m) { this.nginxEnabled.delete(m[1]); return this._out(''); }

    m = command.match(/^sudo ln -sf \S+ (\S+)$/);
    if (m) { this.nginxEnabled.add(m[1]); return this._out(''); }

    if (/^sudo nginx -t/.test(command)) {
      return this._out('nginx: configuration file syntax is ok\nnginx: configuration file test is successful');
    }

    if (/pm2 delete /.test(command) && !this.pm2Survives) this.pm2Deleted = true;
    if (/pm2 delete /.test(command) && this.pm2Survives) {
      // Le process refuse de disparaître : PM2 le redéclare.
      return this._out('');
    }
    return super.exec(command, opts);
  }

  _out(stdout) { return { code: 0, stdout, stderr: '' }; }
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('SÉCURITÉ DES CHEMINS — on refuse plutôt que de nettoyer');
{
  const bon = assertSafeSiteRoot(SITE_ROOT, { remoteRoot: REMOTE_ROOT, host: HOST });
  check('le chemin canonique attendu est accepté', bon === SITE_ROOT);

  const refuse = (valeur, libelle, opts = {}) => {
    let code = null;
    try {
      assertSafeSiteRoot(valeur, { remoteRoot: REMOTE_ROOT, host: HOST, ...opts });
    } catch (err) { code = err.code; }
    check(`refusé : ${libelle}`, code === 'UNSAFE_SITE_ROOT');
  };

  refuse('/', 'la racine du disque');
  refuse('', 'un chemin vide');
  refuse(null, 'une valeur absente');
  refuse('/var/www', 'la racine des déploiements elle-même');
  refuse('/var/www/', 'la racine des déploiements avec slash final');
  refuse(`/var/www/../etc/${HOST}`, 'une remontée de répertoire');
  refuse(`/var/www//${HOST}`, 'un séparateur doublé');
  refuse(`/var/www/${HOST}; rm -rf /`, 'un métacaractère shell');
  refuse('/etc/nginx', 'un chemin hors de la racine des déploiements');
  refuse('/var/www/autre-projet.com', 'un dossier qui n’est pas celui de l’hôte');
  refuse('/var/www/html', 'un chemin protégé par principe');
  refuse(SITE_ROOT, 'un dossier protégé par l’appelant',
    { protectedPaths: [SITE_ROOT] });

  // Le chemin doit être EXACTEMENT celui dérivé de l'hôte : c'est ce qui
  // empêche une fiche incohérente de désigner le dossier d'un autre projet.
  let code = null;
  try {
    assertSafeSiteRoot('/var/www/autre.com', { remoteRoot: REMOTE_ROOT, host: HOST });
  } catch (err) { code = err.code; }
  check('une fiche qui désigne un autre dossier que le sien est refusée',
    code === 'UNSAFE_SITE_ROOT');
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('QUARANTAINE — un domaine retiré ne retombe jamais sur un autre site');
{
  const conf = renderNginxQuarantine([HOST, `api.${HOST}`], { host: HOST });
  check('un bloc serveur est produit', conf.includes('server {'));
  check('les deux hôtes sont neutralisés',
    conf.includes(`server_name ${HOST} api.${HOST};`));
  check('la réponse est 410 Gone', /return 410;/.test(conf));
  check('le challenge ACME reste servi', conf.includes('/.well-known/acme-challenge/'));
  check('la réponse n’est jamais mise en cache', conf.includes('no-store'));
  // La quarantaine ne doit surtout PAS se déclarer serveur par défaut : elle
  // répondrait alors 410 pour tous les domaines non configurés du serveur.
  check('aucune directive default_server', !/\bdefault_server\s*;/.test(conf)
    && !/listen[^;]*default_server/.test(conf));

  let code = null;
  try { renderNginxQuarantine([]); } catch (err) { code = err.code; }
  check('une quarantaine sans hôte est refusée', code === 'QUARANTINE_NO_HOST');

  check('le fichier de quarantaine est distinct de la conf applicative',
    quarantineConfigPath(HOST) !== `/etc/nginx/sites-available/${HOST}.conf`);
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('RETRAIT COMPLET — l’ordre des étapes est celui de la sécurité');
{
  const tx = new ServeurSimule({ portHeldBy: 'LISTEN 0 511 127.0.0.1:5199 users:(("node",pid=42))' });
  const vus = [];
  const res = await runDeprovision({
    transport: tx, host: HOST, remoteRoot: REMOTE_ROOT, port: PORT,
    onStep: (evt) => { if (evt.status === 'ok') vus.push(evt.step); },
  });

  check('le retrait réussit', res.ok === true);
  check('toutes les étapes sont franchies',
    vus.length === DEPROVISION_STEPS.length);
  check('…dans l’ordre déclaré par le moteur',
    vus.join('>') === DEPROVISION_STEPS.map((s) => s.id).join('>'));

  check('le process a été arrêté PUIS supprimé',
    tx.indexOf(/pm2 stop /) < tx.indexOf(/pm2 delete /));
  check('la liste PM2 a été persistée', tx.ran('pm2 save'));
  check('la configuration applicative est retirée',
    tx.ran(`sudo rm -f /etc/nginx/sites-available/${HOST}.conf`));
  check('la quarantaine est installée', tx.ran(`sudo ln -sf ${quarantineConfigPath(HOST)}`));

  // L'ORDRE QUI COMPTE : la quarantaine est posée AVANT la suppression des
  // fichiers. Entre les deux, le domaine ne doit à aucun moment retomber sur
  // le site d'un autre projet.
  check('la quarantaine précède la suppression des fichiers',
    tx.indexOf(/sites-enabled\/.*gone\.conf/) < tx.indexOf(`rm -rf ${SITE_ROOT}`));
  check('Nginx est contrôlé avant rechargement', tx.ran('sudo nginx -t'));
  check('les fichiers sont supprimés', tx.ran(`rm -rf ${SITE_ROOT}`));
  check('…et le dossier n’existe plus à la vérification finale',
    !tx.dirs.has(SITE_ROOT));

  // Rien n'a été supprimé au-delà de la destination.
  const rmDangereux = tx.commands.filter(({ command }) =>
    /^rm -rf /.test(command) && !command.includes(SITE_ROOT));
  check('aucun rm -rf hors de la destination', rmDangereux.length === 0);

  check('l’inventaire est rendu pour le rapport',
    res.inventory?.files === 128 && res.inventory?.size === '49M');
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('IDEMPOTENCE ET REPRISE — relancer un retrait ne casse rien');
{
  // Serveur DÉJÀ vidé : plus de dossier, plus de process, plus de routage.
  const tx = new ServeurSimule({
    dirs: [], fileCount: 0, pm2: {}, nginxEnabled: [], portHeldBy: null,
  });
  const res = await runDeprovision({
    transport: tx, host: HOST, remoteRoot: REMOTE_ROOT, port: PORT,
  });
  check('un retrait relancé sur une destination déjà vidée réussit', res.ok === true);
  check('…sans exécuter de suppression de fichiers',
    !tx.ran(`rm -rf ${SITE_ROOT}`));
  check('…et repose la quarantaine (elle doit rester en place)',
    tx.ran(`sudo ln -sf ${quarantineConfigPath(HOST)}`));
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('REFUS DU MOTEUR — chaque garde a sa cause et son code');
{
  // 1. Le process PM2 survit à sa suppression.
  const survivant = new ServeurSimule({ pm2Survives: true });
  const r1 = await runDeprovision({ transport: survivant, host: HOST, remoteRoot: REMOTE_ROOT, port: PORT });
  check('un process qui survit arrête le retrait',
    r1.ok === false && r1.error.code === 'PM2_PROCESS_STILL_PRESENT');
  check('…à l’étape de vérification de l’arrêt',
    r1.failedStep === 'deprovision.services.verify');
  check('…AVANT toute suppression de fichier',
    !survivant.ran(`rm -rf ${SITE_ROOT}`));

  // 2. Le port reste détenu par un autre processus.
  const portPris = new ServeurSimule({
    portHeldBy: 'LISTEN 0 511 127.0.0.1:5199 users:(("autre",pid=99))', portStaysHeld: true,
  });
  const r2 = await runDeprovision({ transport: portPris, host: HOST, remoteRoot: REMOTE_ROOT, port: PORT });
  check('un port encore détenu arrête le retrait',
    r2.ok === false && r2.error.code === 'PORT_STILL_HELD');
  check('…sans rien supprimer', !portPris.ran(`rm -rf ${SITE_ROOT}`));

  // 3. Un lien symbolique sortant.
  const lienSortant = new ServeurSimule({ symlinks: ['/var/www/autre-projet.com/uploads'] });
  const r3 = await runDeprovision({ transport: lienSortant, host: HOST, remoteRoot: REMOTE_ROOT, port: PORT });
  check('un lien pointant hors de la destination arrête le retrait',
    r3.ok === false && r3.error.code === 'OUTBOUND_SYMLINK');
  check('…dès l’inventaire', r3.failedStep === 'deprovision.inventory');
  check('…sans toucher au process', !lienSortant.ran('pm2 delete'));

  // 4. Des données persistantes sans confirmation.
  const avecDonnees = new ServeurSimule({ uploadCount: 340, storageCount: 12 });
  const r4 = await runDeprovision({ transport: avecDonnees, host: HOST, remoteRoot: REMOTE_ROOT, port: PORT });
  check('des médias persistants arrêtent le retrait par défaut',
    r4.ok === false && r4.error.code === 'DEPROVISION_PERSISTENT_DATA');
  check('…et le message dit combien de fichiers sont en jeu',
    r4.error.message.includes('352'));

  // …et le laissent passer quand l'opérateur l'a EXPLICITEMENT confirmé.
  const confirme = new ServeurSimule({ uploadCount: 340, storageCount: 12 });
  const r5 = await runDeprovision({
    transport: confirme, host: HOST, remoteRoot: REMOTE_ROOT, port: PORT,
    removePersistentData: true,
  });
  check('…sauf confirmation explicite de l’opérateur', r5.ok === true);

  // 5. Le chemin résout ailleurs sur le serveur.
  const ailleurs = new ServeurSimule({ resolved: { [SITE_ROOT]: '/srv/autre-chose' } });
  const r6 = await runDeprovision({ transport: ailleurs, host: HOST, remoteRoot: REMOTE_ROOT, port: PORT });
  check('un chemin qui résout ailleurs arrête le retrait',
    r6.ok === false && r6.error.code === 'SITE_ROOT_RESOLVES_ELSEWHERE');

  // 6. Une destination d'un AUTRE projet est protégée par l'appelant.
  const protege = new ServeurSimule();
  const r7 = await runDeprovision({
    transport: protege, host: HOST, remoteRoot: REMOTE_ROOT, port: PORT,
    protectedPaths: [SITE_ROOT],
  });
  check('un chemin protégé par l’appelant arrête le retrait',
    r7.ok === false && r7.error.code === 'UNSAFE_SITE_ROOT');
  check('…dès le verrouillage, avant toute commande',
    r7.failedStep === 'deprovision.lock');
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('INVENTAIRE — ce que l’opérateur voit avant de confirmer');
{
  const tx = new ServeurSimule({
    uploadCount: 40, storageCount: 3, portHeldBy: 'LISTEN 0 511 127.0.0.1:5199',
  });
  const inv = await inspectDestination(tx, { host: HOST, remoteRoot: REMOTE_ROOT, port: PORT });
  check('la taille est lue', inv.size === '49M');
  check('les fichiers sont comptés', inv.files === 128);
  check('les médias et le stockage sont comptés à part',
    inv.uploads === 40 && inv.storage === 3 && inv.persistentFiles === 43);
  check('le process PM2 est identifié', inv.pm2.present === true && inv.pm2Name === PM2_NAME);
  check('le port est signalé comme détenu', inv.portFree === false);
  check('les hôtes servis sont énumérés', inv.servedHosts.includes(HOST));
  check('l’inventaire n’écrit rien',
    tx.commands.every(({ command }) => !/^rm |^sudo rm |pm2 delete/.test(command)));
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('CYCLE DE VIE — une destination ACTIVE ne se supprime pas');
{
  await PanelDeploymentTarget.deleteMany({});
  const cible = await targets.createTarget({
    name: 'À retirer', url: `https://${HOST}`, environment: 'TEST', sshHost: '203.0.113.50',
  }, { userId: 'u-1' });

  check('une destination naît ACTIVE', cible.lifecycleStatus === 'ACTIVE');
  check('…et se dit supprimable seulement quand elle sera vidée',
    cible.canDelete === false && cible.canDeprovision === true);

  let code = null;
  try { await targets.deleteTarget(cible.targetId); } catch (err) { code = err.code; }
  check('la suppression d’une destination ACTIVE est REFUSÉE',
    code === 'PANEL_TARGET_NOT_EMPTY');

  const encore = await PanelDeploymentTarget.findOne({ targetId: cible.targetId }).lean();
  check('…et la fiche est toujours là', encore !== null);
  check('…toujours ACTIVE', encore.lifecycleStatus === 'ACTIVE');
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('TRANSITIONS — chaque état est atteint par une preuve, pas par un vœu');
{
  const cible = await PanelDeploymentTarget.findOne({ host: HOST }).lean();

  const apresVerrou = await lifecycle.beginDeprovision(cible.targetId, { runId: 'run-1' });
  check('ACTIVE → DEPROVISIONING', apresVerrou.lifecycleStatus === 'DEPROVISIONING');
  check('…la date de départ est posée', typeof apresVerrou.deprovisionStartedAt === 'string');
  check('…et le run est mémorisé', apresVerrou.lastDeprovisionRunId === 'run-1');

  // Un déploiement est refusé pendant le retrait.
  let code = null;
  try { lifecycle.assertDeployable(apresVerrou); } catch (err) { code = err.code; }
  check('aucun déploiement pendant un retrait', code === 'PANEL_TARGET_DEPROVISIONING');

  // Échec, puis reprise : la date de départ N'EST PAS réécrite.
  const echoue = await lifecycle.markDeprovisionFailed(cible.targetId, {
    runId: 'run-1', error: { code: 'PORT_STILL_HELD', message: 'port détenu', step: 'deprovision.port.release' },
  });
  check('DEPROVISIONING → DEPROVISION_FAILED', echoue.lifecycleStatus === 'DEPROVISION_FAILED');
  check('…la cause est conservée', echoue.lastError.code === 'PORT_STILL_HELD');
  check('…avec l’étape fautive', echoue.lastError.step === 'deprovision.port.release');

  const repris = await lifecycle.beginDeprovision(cible.targetId, { runId: 'run-2' });
  check('un retrait en échec est REPRENABLE', repris.lifecycleStatus === 'DEPROVISIONING');
  check('…sans réécrire la date de départ initiale',
    repris.deprovisionStartedAt === apresVerrou.deprovisionStartedAt);

  // Reprise après interruption : on repart de DEPROVISIONING.
  const reprisEncore = await lifecycle.beginDeprovision(cible.targetId, { runId: 'run-3' });
  check('un retrait interrompu est repris depuis DEPROVISIONING',
    reprisEncore.lifecycleStatus === 'DEPROVISIONING');

  const vide = await lifecycle.markEmpty(cible.targetId, { runId: 'run-3' });
  check('DEPROVISIONING → EMPTY', vide.lifecycleStatus === 'EMPTY');
  check('…la quarantaine est marquée posée', vide.quarantineEnabled === true);
  check('…l’état de déploiement retombe à NEW', vide.state === 'NEW');
  check('…et la version en ligne disparaît', vide.currentVersion === null);
  check('…la date de fin est posée', typeof vide.emptiedAt === 'string');
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('SUPPRESSION — logique, jamais physique, et jamais avant EMPTY');
{
  const cible = await PanelDeploymentTarget.findOne({ host: HOST }).lean();

  // Tant que la quarantaine est posée, la suppression exige une connexion.
  let code = null;
  try { await targets.deleteTarget(cible.targetId); } catch (err) { code = err.code; }
  check('une quarantaine encore en place impose de passer par le serveur',
    code === 'PANEL_TARGET_QUARANTINE_ACTIVE');

  await lifecycle.setQuarantine(cible.targetId, false);
  const res = await targets.deleteTarget(cible.targetId, { userEmail: 'dev@panel.test' });
  check('une destination VIDÉE se supprime', res.deleted === true);

  const apres = await PanelDeploymentTarget.findOne({ targetId: cible.targetId }).lean();
  check('la fiche N’EST PAS détruite', apres !== null);
  check('…elle est marquée DELETED', apres.lifecycleStatus === 'DELETED');
  check('…avec sa date de suppression', typeof apres.deletedAt === 'string');
  check('l’historique est CONSERVÉ', Array.isArray(apres.history) && apres.history.length > 0);
  check('…et porte la trace de la suppression',
    apres.history.some((h) => h.operationType === 'DESTINATION_DELETE'));

  const actives = await targets.listTargets();
  check('elle sort des destinations actives',
    !actives.some((t) => t.targetId === cible.targetId));
  const archivees = await targets.listDeletedTargets();
  check('…mais reste consultable pour l’audit',
    archivees.some((t) => t.targetId === cible.targetId));

  // Le domaine redevient disponible : c'est le but du retrait.
  const recree = await targets.createTarget({
    name: 'Reprise du domaine', url: `https://${HOST}`, environment: 'TEST', sshHost: '203.0.113.51',
  });
  check('le domaine libéré peut être redéclaré', recree.host === HOST);
  check('…et la nouvelle fiche est ACTIVE', recree.lifecycleStatus === 'ACTIVE');
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('CONCURRENCE — déploiement et retrait ne se marchent pas dessus');
{
  await PanelDeploymentTarget.deleteMany({});
  const cible = await targets.createTarget({
    name: 'Concurrence', url: 'https://concurrence.exemple.com', environment: 'TEST',
    sshHost: '203.0.113.60',
  });

  // Un déploiement est lancé : le verrou est posé.
  await targets.markDeploying(cible.targetId, 'run-deploy');
  const enCours = await PanelDeploymentTarget.findOne({ targetId: cible.targetId }).lean();
  check('un déploiement pose son verrou', enCours.activeDeploymentRunId === 'run-deploy');

  let code = null;
  try { lifecycle.assertDeprovisionable(enCours); } catch (err) { code = err.code; }
  check('aucun retrait pendant un déploiement', code === 'PANEL_TARGET_DEPLOYING');

  code = null;
  try { await lifecycle.beginDeprovision(cible.targetId, { runId: 'run-retrait' }); } catch (err) { code = err.code; }
  check('…et le verrou atomique refuse aussi',
    code === 'PANEL_DEPROVISION_LOCKED');

  // Le déploiement se conclut : le verrou tombe, le retrait redevient possible.
  await targets.recordDeployment(cible.targetId, {
    operationType: 'DEPLOYMENT', ok: true, version: 'abc1234', releaseId: 'abc1234',
    user: 'dev@panel.test', durationMs: 1000, error: null, steps: [],
  });
  const conclu = await PanelDeploymentTarget.findOne({ targetId: cible.targetId }).lean();
  check('le verrou tombe avec le déploiement', conclu.activeDeploymentRunId === null);
  check('…et un déploiement réussi rend la destination ACTIVE',
    conclu.lifecycleStatus === 'ACTIVE');

  const verrouille = await lifecycle.beginDeprovision(cible.targetId, { runId: 'run-retrait' });
  check('le retrait peut alors démarrer', verrouille.lifecycleStatus === 'DEPROVISIONING');
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('RUN DE RETRAIT — la checklist est posée avant que rien ne commence');
{
  await PanelDeploymentRun.deleteMany({});
  const cible = await PanelDeploymentTarget.findOne({ host: 'concurrence.exemple.com' }).lean();

  const runId = await runs.createRun({
    target: cible, operationType: 'DEPROVISION', user: 'dev@panel.test',
  });
  const run = await runs.getRunOrThrow(runId);
  check('le run de retrait porte la checklist du moteur',
    run.steps.length === DEPROVISION_STEPS.length);
  check('…dans l’ordre du moteur',
    run.steps.map((s) => s.id).join('>') === DEPROVISION_STEPS.map((s) => s.id).join('>'));
  check('…toutes en attente', run.steps.every((s) => s.status === 'pending'));
  check('la progression part de zéro', run.progress.percent === 0);
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('ADAPTATEUR — le Panel traduit l’issue du moteur en cycle de vie');
{
  const cible = await PanelDeploymentTarget.findOne({ host: 'concurrence.exemple.com' }).lean();
  const vue = targets.describeTarget(cible);

  // Moteur simulé : on ne teste ici que la TRADUCTION, pas le retrait — il
  // est déjà prouvé plus haut avec un serveur simulé.
  const moteurOk = {
    parseUrl: (url) => ({ host: new URL(url).hostname, canonicalUrl: url }),
    deprovision: async ({ onStep }) => {
      for (const s of DEPROVISION_STEPS) onStep({ step: s.id, label: s.label, status: 'ok', detail: {} });
      return { ok: true, steps: [], failedStep: null, inventory: { files: 12, size: '3M', servedHosts: [vue.host] } };
    },
  };

  const issue = await executor.executeOperation({
    operationType: executor.OPERATIONS.DEPROVISION,
    target: vue, sshPassword: 'secret', runId: 'run-retrait', engine: moteurOk,
  });
  check('un retrait réussi rend « ok »', issue.status === 'ok');
  const apres = await PanelDeploymentTarget.findOne({ targetId: cible.targetId }).lean();
  check('…et la destination passe EMPTY', apres.lifecycleStatus === 'EMPTY');

  // Puis un échec, sur une destination remise en retrait.
  await lifecycle.beginDeprovision(cible.targetId, { runId: 'run-4' })
    .catch(async () => {
      await PanelDeploymentTarget.updateOne({ targetId: cible.targetId },
        { $set: { lifecycleStatus: 'DEPROVISIONING' } });
    });
  const moteurKo = {
    parseUrl: moteurOk.parseUrl,
    deprovision: async () => ({
      ok: false, steps: [], failedStep: 'deprovision.port.release',
      inventory: null, error: { code: 'PORT_STILL_HELD', message: 'port détenu' },
    }),
  };
  const echec = await executor.executeOperation({
    operationType: executor.OPERATIONS.DEPROVISION,
    target: vue, sshPassword: 'secret', runId: 'run-4', engine: moteurKo,
  });
  check('un retrait échoué rend « error »', echec.status === 'error');
  check('…avec le code du moteur', echec.error.code === 'PORT_STILL_HELD');
  const enEchec = await PanelDeploymentTarget.findOne({ targetId: cible.targetId }).lean();
  check('…et la destination passe DEPROVISION_FAILED',
    enEchec.lifecycleStatus === 'DEPROVISION_FAILED');
  check('…la fiche n’est PAS supprimée', enEchec !== null);
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('MIGRATION — aucune fiche antérieure n’est perdue ni vidée');
{
  await PanelDeploymentTarget.deleteMany({});
  // Une fiche telle qu'elle existait AVANT le LOT 8 : aucun cycle de vie.
  await PanelDeploymentTarget.collection.insertOne({
    targetId: 'legacy-1', name: 'Ancienne', url: 'https://ancienne.exemple.com',
    host: 'ancienne.exemple.com', type: 'subdomain', environment: 'PROD',
    backendPort: 5100, remoteRoot: '/var/www', state: 'DEPLOYED',
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    history: [{ at: '2026-01-01T00:00:00.000Z', operationType: 'DEPLOYMENT', success: true }],
  });

  const rapport = await lifecycle.migrateDeploymentTargets();
  check('la fiche antérieure est reprise', rapport.lifecycleBackfilled === 1);

  const repris = await PanelDeploymentTarget.findOne({ targetId: 'legacy-1' }).lean();
  check('…en état ACTIVE — le choix conservateur',
    repris.lifecycleStatus === 'ACTIVE');
  check('…sans rien supprimer', repris !== null && repris.state === 'DEPLOYED');
  check('…et sans toucher à son historique', repris.history.length === 1);

  let code = null;
  try { await targets.deleteTarget('legacy-1'); } catch (err) { code = err.code; }
  check('une fiche reprise n’est donc PAS supprimable directement',
    code === 'PANEL_TARGET_NOT_EMPTY');

  // Relancer la migration ne change rien.
  const encore = await lifecycle.migrateDeploymentTargets();
  check('la migration est idempotente', encore.lifecycleBackfilled === 0);
}

await stopMemoryMongo();
finish();
