// SSH, PM2, REDÉMARRAGE ET FLUX — les angles morts, côté Panel.
//
// ══ POURQUOI CE FICHIER EXISTE ══════════════════════════════════════════════
//
// Le Panel déploie parfois SA PROPRE application : l'API meurt au milieu de
// l'opération. Trois faits étaient jusqu'ici indistinguables dans les traces :
//
//   · une connexion SSH qui ne répond jamais (le run figé sans explication) ;
//   · un redémarrage VOULU, classé « interrompu » comme un plantage ;
//   · un port gardé par un ancien service pendant que le nouveau boucle.
//
// Le Panel diffère de SB Auto sur un point structurant : son travail s'exécute
// dans un worker DÉTACHÉ, pas dans la requête HTTP. La coupure d'API n'y tue
// donc pas le déploiement — mais elle tue la réponse. Les tests ci-dessous
// vérifient les deux moitiés séparément, parce que ce sont deux pannes.
import { EventEmitter } from 'node:events';

import {
  check, connectTestDatabase, finish, section,
  setTestEnv, startMemoryMongo, stopMemoryMongo,
} from './helpers/harness.js';

setTestEnv();
await startMemoryMongo();
await connectTestDatabase();

const { SshTransport } = await import('../backend/src/deployment-engine/transport/SshTransport.js');
const DeploymentRun = (await import('../backend/src/models/PanelDeploymentRun.model.js')).default;
const DeploymentTarget = (await import('../backend/src/models/PanelDeploymentTarget.model.js')).default;
const marqueur = await import('../backend/src/services/deployment/forensics/restartMarker.service.js');
const runs = await import('../backend/src/services/deployment/deploymentRun.service.js');
const targets = await import('../backend/src/services/deployment/deploymentTarget.service.js');
const etapes = await import('../backend/src/services/deployment/forensics/runSteps.service.js');
const pm2t = await import('../backend/src/services/deployment/forensics/pm2Trace.js');
const garde = await import('../backend/src/services/deployment/forensics/processGuard.js');
const { deduireCauseCoupure, CAUSES } = await import('../backend/src/services/deployment/forensics/streamCause.js');
const { randomUUID } = await import('node:crypto');

const lireSource = async (chemin) => (await import('node:fs/promises'))
  .readFile(new URL(chemin, import.meta.url), 'utf8');

/** Un fichier privé de ses commentaires : sinon une assertion se valide sur sa propre explication. */
const sansCommentaires = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

/**
 * UN CLIENT ssh2 SIMULÉ — il émet ce qu'on lui demande, quand on veut.
 *
 * Les vrais chemins de sortie de ssh2 sont exactement ceux-ci. Les éprouver un
 * par un est la seule façon de vérifier qu'AUCUN ne laisse la promesse
 * pendante : c'était précisément le défaut derrière le run figé 8 min 36 s.
 */
function clientSimule(evenement, { delaiMs = 5 } = {}) {
  const c = new EventEmitter();
  c.connect = () => {
    if (evenement === 'rien') return; // ne règle jamais : le cas du blocage
    setTimeout(() => c.emit(
      evenement,
      evenement === 'error' ? Object.assign(new Error('refusé'), { code: 'ECONNREFUSED' }) : undefined,
    ), delaiMs);
  };
  c.end = () => {};
  c.destroy = () => {};
  return c;
}

const connecter = async (evenement, opts = {}) => {
  const vus = [];
  const tx = new SshTransport({
    host: '203.0.113.10', username: 'root', password: 'SECRET-A-NE-PAS-VOIR',
    connectTimeoutMs: opts.connectTimeoutMs ?? 200,
    clientFactory: () => clientSimule(evenement, opts),
    observer: (e) => vus.push(e),
  });
  let erreur = null;
  try { await tx._connect(); } catch (e) { erreur = e; }
  return { vus, erreur };
};

/** Un transport factice : `exec` rend ce qu'on lui dicte, commande par commande. */
function transportFactice({ sockets = '', pm2 = [] }) {
  return {
    async exec(cmd) {
      if (cmd.startsWith('ss -ltnp')) return { stdout: sockets, stderr: '', code: 0 };
      if (cmd.startsWith('pm2 jlist')) return { stdout: JSON.stringify(pm2), stderr: '', code: 0 };
      return { stdout: '', stderr: '', code: 0 };
    },
  };
}

const procPm2 = (name, pid, port, { status = 'online', restarts = 0 } = {}) => ({
  name, pid, pm2_env: { status, restart_time: restarts, env: { PORT: String(port) } },
});
const ligneSocket = (port, pid, nom) => `LISTEN 0 511 0.0.0.0:${port} 0.0.0.0:* users:(("${nom}",pid=${pid},fd=20))`;

const nouveauRun = async (extra = {}) => DeploymentRun.create({
  runId: randomUUID(), targetId: randomUUID(), targetName: 'Demo', host: 'demo.exemple.com',
  environment: 'TEST', operationType: 'DEPLOYMENT', status: 'running',
  startedAt: new Date().toISOString(), steps: [], ...extra,
});
const journalDe = async (runId) => (await DeploymentRun.findOne({ runId }).lean()).journal ?? [];

/* ══════════════════════════════════════════════════════════════════════════ */
section('SSH — chaque chemin de sortie produit SON évènement');
{
  const pret = await connecter('ready');
  check('une connexion réussie émet SSH_CONNECT_STARTED puis SSH_READY',
    pret.vus.map((e) => e.eventCode).join(',') === 'SSH_CONNECT_STARTED,SSH_READY');
  check('…et la promesse se règle sans erreur', pret.erreur === null);
  check('…avec une durée mesurée', typeof pret.vus[1].durationMs === 'number');

  for (const [evenement, attendu] of [
    ['error', 'SSH_ERROR'],
    ['close', 'SSH_CLOSED'],
    ['end', 'SSH_ENDED'],
    ['timeout', 'SSH_TIMEOUT'],
  ]) {
    const r = await connecter(evenement);
    check(`« ${evenement} » émet ${attendu}, et pas un SSH_ERROR générique`,
      r.vus[1]?.eventCode === attendu);
    check(`…et la promesse est REJETÉE, jamais pendante (${evenement})`, r.erreur !== null);
  }

  // Le cas du 06/08 : le serveur ne répond jamais.
  const muet = await connecter('rien', { connectTimeoutMs: 120 });
  check('un serveur muet finit en SSH_TIMEOUT — plus jamais de blocage silencieux',
    muet.vus[1]?.eventCode === 'SSH_TIMEOUT');
  check('…et la promesse se règle', muet.erreur !== null);
  check('…en nommant le plafond dépassé', /Délai de connexion SSH dépassé/.test(muet.erreur.message));

  // Une tentative « started » sans issue serait invisible : on vérifie l'appariement.
  const tous = [...pret.vus, ...muet.vus];
  const demarrages = tous.filter((e) => e.eventCode === 'SSH_CONNECT_STARTED').length;
  check('toute tentative démarrée reçoit exactement une issue',
    demarrages === tous.length - demarrages);
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('SSH — aucun secret ne franchit l’observateur');
{
  const r = await connecter('ready');
  check('le mot de passe n’est jamais publié', !JSON.stringify(r.vus).includes('SECRET-A-NE-PAS-VOIR'));
  check('…seule la MÉTHODE d’authentification l’est', r.vus[0].authMethod === 'password');
  check('…avec l’hôte', r.vus[0].host === '203.0.113.10');
  check('…le port', r.vus[0].port === 22);
  check('…et l’utilisateur', r.vus[0].username === 'root');
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('SSH — le moteur reste GÉNÉRIQUE');
{
  const source = await lireSource('../backend/src/deployment-engine/transport/SshTransport.js');
  check('le transport n’importe aucun modèle Mongo', !/from '.*models\//.test(source));
  check('…ni aucun service applicatif', !/from '.*services\//.test(source));
  check('…il se contente d’un rappel injecté', /this\._observer/.test(source));

  const tx = new SshTransport({
    host: 'h', username: 'u', password: 'p',
    connectTimeoutMs: 80, clientFactory: () => clientSimule('ready'),
  });
  let leve = null;
  try { await tx._connect(); } catch (e) { leve = e; }
  check('un transport SANS observateur fonctionne à l’identique', leve === null);
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('PM2 — le redémarrage et le propriétaire du port sont OBSERVÉS');
{
  const run = await nouveauRun();
  const avant = await pm2t.journalPm2Before(run.runId, transportFactice({
    sockets: ligneSocket(4500, 900, 'node'),
    pm2: [procPm2('panel-demo', 900, 4500, { restarts: 3 })],
  }), { processName: 'panel-demo', port: 4500 });

  check('l’état AVANT est relevé', avant.pid === 900 && avant.status === 'online');
  check('…avec le propriétaire réel du port', avant.socketPid === 900 && avant.ownedByUs === true);

  // Le service a redémarré : nouveau PID, compteur de redémarrages incrémenté.
  await pm2t.journalPm2After(run.runId, transportFactice({
    sockets: ligneSocket(4500, 901, 'node'),
    pm2: [procPm2('panel-demo', 901, 4500, { restarts: 4 })],
  }), { processName: 'panel-demo', port: 4500, avant });

  const jrn = await journalDe(run.runId);
  const apres = jrn.find((e) => e.eventCode === 'PM2_STATE_AFTER');
  check('l’état APRÈS est journalisé', Boolean(apres));
  check('…le changement de PID est DÉTECTÉ', apres.details.pidChange === true);
  check('…le redémarrage est CONFIRMÉ par le compteur PM2', apres.details.redemarre === true);
  check('…et le port reste à nous', jrn.some((e) => e.eventCode === 'SOCKET_OWNER_VERIFIED'));
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('PM2 — un port détenu par un ÉTRANGER est nommé, pas deviné');
{
  const run = await nouveauRun();
  // Le port 4500 est tenu par le pid 700 ; notre service tourne en 901.
  await pm2t.journalPm2After(run.runId, transportFactice({
    sockets: ligneSocket(4500, 700, 'ancien-service'),
    pm2: [procPm2('panel-demo', 901, 4500)],
  }), { processName: 'panel-demo', port: 4500 });

  const jrn = await journalDe(run.runId);
  const collision = jrn.find((e) => e.eventCode === 'PM2_PORT_NOT_OWNED');
  check('la collision de port est journalisée', Boolean(collision));
  check('…au niveau erreur, pas en information', collision.level === 'error');
  check('…avec le PID réel du détenteur', collision.details.socketPid === 700);
  check('…et le PID attendu, pour comparaison', collision.details.expectedPid === 901);
  check('aucun SOCKET_OWNER_VERIFIED n’est émis en même temps',
    !jrn.some((e) => e.eventCode === 'SOCKET_OWNER_VERIFIED'));
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('PM2 — un service qui n’est pas « online » est signalé instable');
{
  const run = await nouveauRun();
  await pm2t.journalPm2After(run.runId, transportFactice({
    sockets: '',
    pm2: [procPm2('panel-demo', 902, 4500, { status: 'errored' })],
  }), { processName: 'panel-demo', port: 4500 });

  const instable = (await journalDe(run.runId)).find((e) => e.eventCode === 'PM2_PROCESS_UNSTABLE');
  check('« errored » après démarrage n’est pas un succès', Boolean(instable));
  check('…et l’état exact est conservé', instable.details.status === 'errored');
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('REDÉMARRAGE ATTENDU — ce n’est pas un plantage');
{
  const maintenant = new Date().toISOString();
  const cible = await DeploymentTarget.create({
    targetId: randomUUID(), name: 'Demo', url: 'https://demo.exemple.com',
    host: 'demo.exemple.com', type: 'subdomain',
    environment: 'TEST', backendPort: 4500, lifecycleStatus: 'ACTIVE', state: 'DEPLOYING',
    createdAt: maintenant, updatedAt: maintenant,
  });
  const run = await nouveauRun({ targetId: cible.targetId });
  await etapes.recordStep(run.runId, { stepId: 'pm2', label: 'Service', status: 'running' });

  const ecrit = await marqueur.ecrireMarqueurReprise({
    runId: run.runId, targetId: cible.targetId, operation: 'DEPLOYMENT',
    nextExpectedStep: 'health', expectedProcessName: 'panel-demo', expectedPort: 4500,
  });
  check('le marqueur est écrit AVANT le redémarrage', ecrit === true);

  const relu = await marqueur.lireMarqueurReprise();
  check('…il porte le run', String(relu.run ?? relu.runId) === String(run.runId));
  check('…l’étape attendue ensuite', relu.nextExpectedStep === 'health');
  check('…le service et le port attendus',
    relu.expectedProcessName === 'panel-demo' && relu.expectedPort === 4500);
  check('…et le PID qui s’attendait à mourir', relu.pidBefore === process.pid);

  // Même process : le redémarrage n'a PAS eu lieu. On ne conclut rien.
  const memeProcess = await marqueur.consommerMarqueurReprise();
  check('un process inchangé ne consomme pas le marqueur', memeProcess.consumed === false);
  check('…et le DIT, au lieu de supposer', memeProcess.reason === 'PROCESS_INCHANGE');
  check('…le marqueur est CONSERVÉ, pas effacé', (await marqueur.lireMarqueurReprise()) !== null);

  // Nouveau process : on le simule en vieillissant le PID enregistré.
  /* Le registre Mongoose se prend par un modèle déjà chargé : `mongoose` lui-même
     n'est pas résoluble depuis `tests/`, ses modules vivant sous `backend/`. */
  await DeploymentRun.base.models.PanelDeploymentRestartMarker
    .updateOne({ key: 'SINGLETON' }, { $set: { pidBefore: process.pid - 1 } });

  const consomme = await marqueur.consommerMarqueurReprise();
  check('un nouveau process consomme le marqueur', consomme.consumed === true);
  check('…et connaît l’étape à reprendre', consomme.nextExpectedStep === 'health');
  check('le marqueur est effacé APRÈS constat', (await marqueur.lireMarqueurReprise()) === null);

  const fin = (await journalDe(run.runId)).find((e) => e.eventCode === 'APPLICATION_RESTART_COMPLETED');
  check('le retour du service est journalisé', Boolean(fin));
  check('…avec l’ancien et le nouveau PID',
    fin.details.pidBefore === process.pid - 1 && fin.details.pidAfter === process.pid);
  check('…et la durée d’indisponibilité', typeof fin.details.downtimeMs === 'number');
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('UN RUN COUPÉ EN PLEIN VOL est repris, jamais laissé « en cours »');
{
  const run = await nouveauRun();
  await etapes.recordStep(run.runId, { stepId: 'ssh', label: 'Connexion', status: 'running' });

  const repris = await etapes.recoverOrphanRuns({ reason: 'process_restart' });
  check('le run orphelin est repris au démarrage', repris.recovered >= 1);

  const relu = await DeploymentRun.findOne({ runId: run.runId }).lean();
  check('…l’étape en cours devient « interrompue », pas « en cours » à jamais',
    relu.steps.find((s) => s.id === 'ssh').status === 'interrupted');
  check('…plus aucune étape courante ne charge indéfiniment', !relu.currentStepId);
  check('…et le journal dit POURQUOI',
    (relu.journal ?? []).some((e) => e.eventCode === 'RUN_INTERRUPTED_BY_PROCESS_RESTART'));
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('LE FLUX COUPÉ — fait observé, puis cause déduite, jamais inventée');
{
  const clientParti = deduireCauseCoupure({ headersSent: true, requestAborted: true });
  check('un client qui raccroche est reconnu comme tel', clientParti.cause === CAUSES.CLIENT_ABORT);
  check('…et c’est une certitude, pas une hypothèse', clientParti.certain === true);

  const attendu = deduireCauseCoupure({ headersSent: true, restartExpected: true });
  check('un redémarrage ANNONCÉ n’est pas un plantage', attendu.cause === CAUSES.BACKEND_RESTART);

  const mort = deduireCauseCoupure({ headersSent: true, processAlive: false });
  check('une coupure sans annonce, process muet, est un plantage', mort.cause === CAUSES.BACKEND_CRASH);

  const ecriture = deduireCauseCoupure({ headersSent: true, writeFailed: true, processAlive: true });
  check('une écriture échouée alors que le backend VIT est un cas distinct',
    ecriture.cause === CAUSES.STREAM_WRITE_FAILED);
  check('…et prime sur le redémarrage : nous sommes là pour le constater',
    deduireCauseCoupure({ writeFailed: true, restartExpected: true, processAlive: true })
      .cause === CAUSES.STREAM_WRITE_FAILED);

  const inconnu = deduireCauseCoupure({ headersSent: true, processAlive: true });
  check('faute de faits, la cause reste INDÉTERMINÉE', inconnu.cause === CAUSES.INDETERMINE);
  check('…et le dit explicitement au lieu d’inventer', inconnu.certain === false);
  check('…tout en conservant les faits, pour qu’on puisse contredire la déduction',
    inconnu.faits.headersSent === true && inconnu.faits.requestAborted === false);
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('LE FLUX — l’écriture qui échoue est CAPTURÉE, pas avalée');
{
  const trace = sansCommentaires(await lireSource('../backend/src/services/deployment/forensics/httpTrace.js'));
  check('`res.write` est enveloppé', /res\.write = /.test(trace));
  check('…et son échec émet HTTP_STREAM_WRITE_FAILED', /HTTP_STREAM_WRITE_FAILED/.test(trace));
  check('…l’ouverture du flux est distinguée de sa fin', /HTTP_STREAM_OPENED/.test(trace));
  check('…une fin normale n’est pas comptée comme une coupure', /HTTP_STREAM_COMPLETED/.test(trace));
  check('la cause n’est pas devinée sur place : elle est déduite des faits',
    /deduireCauseCoupure\(/.test(trace));
  check('…et le journal sépare le fait observé de la cause déduite',
    /faits:/.test(trace) && /causeDeduite:/.test(trace));
  check('l’abandon CLIENT est écouté', /req\.on\('aborted'/.test(trace));
  check('une trace existe AVANT le run, pour les 500 précoces', /openAttempt\(/.test(trace));
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('L’ORDRE AU DÉMARRAGE — marqueur d’abord, reprise générique ensuite');
{
  const demarrage = sansCommentaires(await lireSource('../backend/src/server.js'));
  const iGarde = demarrage.indexOf('installProcessGuards(');
  const iMarqueur = demarrage.indexOf('consommerMarqueurReprise()');
  const iReprise = demarrage.indexOf('recoverOrphanRuns(');
  check('les gardes de process sont posées au démarrage', iGarde > 0);
  check('le marqueur est lu au démarrage', iMarqueur > 0);
  check('la reprise générique aussi', iReprise > 0);
  check('…et le marqueur est lu AVANT elle — sinon le redémarrage voulu passe pour un plantage',
    iMarqueur < iReprise);
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('LE WORKER DÉTACHÉ — il annonce, il n’est pas relancé tout seul');
{
  const exec = sansCommentaires(
    await lireSource('../backend/src/services/deployment/deploymentExecutor.service.js'),
  );
  check('l’état PM2 est capturé AVANT', /journalPm2Before\(/.test(exec));
  check('…et APRÈS', /journalPm2After\(/.test(exec));
  check('le marqueur est écrit avant le redémarrage', /ecrireMarqueurReprise\(/.test(exec));
  check('…et effacé après le retour du service', /effacerMarqueurReprise\(/.test(exec));
  check('le redémarrage est ANNONCÉ au journal avant la coupure',
    /APPLICATION_RESTART_EXPECTED/.test(exec));
  check('…et à l’interface, qui sinon y verrait une panne serveur',
    /'backend_restarting'/.test(exec));
  check('l’observateur SSH est branché sur le moteur', /transportObserver/.test(exec));

  const worker = sansCommentaires(await lireSource('../backend/src/scripts/deploy-worker.js'));
  check('le worker pose lui aussi les gardes de process', /installProcessGuards\(/.test(worker));
  check('…et ne relance JAMAIS un déploiement de lui-même',
    !/executeDeployment\([^)]*\)[\s\S]{0,200}executeDeployment\(/.test(worker));
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('LE RUN RÉEL add86c82 — un redémarrage attendu ne clôt plus le déploiement');
{
  /**
   * On rejoue exactement la séquence observée : le pipeline atteint
   * `services.start`, écrit le marqueur, PM2 redémarre l'API — et le nouveau
   * process démarre pendant que le worker, lui, poursuit son travail.
   */
  const maintenant = new Date().toISOString();
  // Une seule destination ACTIVE par environnement : l'index le garantit, et
  // les sections précédentes en ont laissé une.
  await DeploymentTarget.deleteMany({});
  const cible = await DeploymentTarget.create({
    targetId: randomUUID(), name: 'Panel TEST', url: 'https://panel-test.exemple.com',
    host: 'panel-test.exemple.com', type: 'subdomain', environment: 'TEST',
    backendPort: 4600, lifecycleStatus: 'ACTIVE', state: 'DEPLOYING',
    createdAt: maintenant, updatedAt: maintenant,
  });
  const r = await nouveauRun({ targetId: cible.targetId, selfDeployment: true });

  for (const fait of ['artifact.build', 'artifact.upload', 'dependencies.install',
    'uploads.migrate', 'nginx.configure', 'https.configure']) {
    await etapes.recordStep(r.runId, { stepId: fait, label: fait, status: 'ok' });
  }
  await etapes.recordStep(r.runId, { stepId: 'services.start', label: 'Démarrage des services', status: 'running' });

  // Le worker bat — c'est LUI qui exécute, et il est vivant.
  await runs.attachWorker(r.runId, 36740);
  await runs.heartbeat(r.runId);

  await marqueur.ecrireMarqueurReprise({
    runId: r.runId, targetId: cible.targetId, operation: 'DEPLOYMENT',
    nextExpectedStep: 'services.verify', expectedProcessName: 'panel-test', expectedPort: 4600,
  });
  // PM2 redémarre l'API : le marqueur a été écrit par un AUTRE pid que celui-ci.
  await DeploymentRun.base.models.PanelDeploymentRestartMarker
    .updateOne({ key: 'SINGLETON' }, { $set: { pidBefore: 224082 } });

  /* — LE NOUVEAU BACKEND DÉMARRE : c'est ici que tout se jouait — */
  const reprise = await marqueur.consommerMarqueurReprise();
  check('le redémarrage attendu est constaté', reprise.consumed === true);
  const bilan = await etapes.recoverOrphanRuns({
    reason: 'process_restart', runRepris: reprise.runId,
  });

  check('AUCUN run n’est déclaré interrompu', bilan.recovered === 0);
  check('…le run est explicitement ÉPARGNÉ', bilan.preservedRuns.includes(r.runId));

  let relu = await DeploymentRun.findOne({ runId: r.runId }).lean();
  check('le run reste « en cours », pas « interrompu »', relu.status === 'running');
  check('services.start n’est pas figé en interrompu',
    relu.steps.find((s) => s.id === 'services.start').status === 'running');

  const codes = relu.journal.map((e) => e.eventCode);
  check('le journal porte APPLICATION_RESTART_COMPLETED', codes.includes('APPLICATION_RESTART_COMPLETED'));
  check('…suivi de RUN_RESUMED_AFTER_EXPECTED_RESTART',
    codes.indexOf('RUN_RESUMED_AFTER_EXPECTED_RESTART') > codes.indexOf('APPLICATION_RESTART_COMPLETED'));
  check('…et JAMAIS de RUN_INTERRUPTED_BY_PROCESS_RESTART',
    !codes.includes('RUN_INTERRUPTED_BY_PROCESS_RESTART'));

  /* — LE WORKER, LUI, N'A PAS ÉTÉ TUÉ : il termine — */
  await etapes.recordStep(r.runId, { stepId: 'services.start', label: 'Démarrage des services', status: 'ok' });
  for (const suite of ['services.verify', 'public.healthcheck', 'runtime.sync', 'deployment.finalize']) {
    await etapes.recordStep(r.runId, { stepId: suite, label: suite, status: 'running' });
    await etapes.recordStep(r.runId, { stepId: suite, label: suite, status: 'ok' });
  }
  await runs.finalizeRun(r.runId, { status: 'ok', summary: 'Déploiement réussi.' });
  await targets.recordDeployment(cible.targetId, {
    operationType: 'DEPLOYMENT', ok: true, version: '1.0.0', releaseId: null,
    user: 'dev@exemple.com', durationMs: 1000, error: null, steps: [],
  });

  relu = await DeploymentRun.findOne({ runId: r.runId }).lean();
  check('services.start finit au VERT', relu.steps.find((s) => s.id === 'services.start').status === 'ok');
  check('services.verify a bien été exécuté', relu.steps.find((s) => s.id === 'services.verify').status === 'ok');
  check('le contrôle public aussi', relu.steps.find((s) => s.id === 'public.healthcheck').status === 'ok');
  check('la synchronisation réseau aussi', relu.steps.find((s) => s.id === 'runtime.sync').status === 'ok');
  check('la finalisation aussi', relu.steps.find((s) => s.id === 'deployment.finalize').status === 'ok');
  check('le run se conclut en succès', relu.status === 'ok');
  check('…avec une heure de fin', Boolean(relu.finishedAt));
  check('…et plus AUCUNE étape en attente ou interrompue',
    !relu.steps.some((s) => ['pending', 'running', 'interrupted'].includes(s.status)));

  const fiche = await DeploymentTarget.findOne({ targetId: cible.targetId }).lean();
  check('la destination est persistée DEPLOYED', fiche.state === 'DEPLOYED');
  check('…son historique est écrit', (fiche.history ?? []).length >= 1);
  check('…et son cycle de vie reste ACTIVE', fiche.lifecycleStatus === 'ACTIVE');
  check('le badge « Publication… » ne peut plus subsister : plus rien n’est DEPLOYING',
    relu.status === 'ok' && fiche.state !== 'DEPLOYING');
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('SCÉNARIOS NÉGATIFS — la reprise ne doit rien inventer');
{
  // 1. Le worker est RÉELLEMENT mort : silence prolongé, aucun marqueur valide.
  const mort = await nouveauRun();
  await etapes.recordStep(mort.runId, { stepId: 'services.start', label: 'Démarrage', status: 'running' });
  await DeploymentRun.updateOne({ runId: mort.runId }, {
    $set: { workerPid: 11111, workerHeartbeatAt: new Date(Date.now() - 10 * 60_000).toISOString() },
  });

  const bilan = await etapes.recoverOrphanRuns({ reason: 'process_restart' });
  check('un worker silencieux depuis 10 min est tenu pour mort', bilan.recovered >= 1);
  const relu = await DeploymentRun.findOne({ runId: mort.runId }).lean();
  check('…le run est clos comme interrompu', relu.status === 'interrupted');
  check('…l’étape en cours devient interrompue, pas en erreur',
    relu.steps.find((s) => s.id === 'services.start').status === 'interrupted');
  check('…et la cause est nommée',
    relu.journal.some((e) => e.eventCode === 'RUN_INTERRUPTED_BY_PROCESS_RESTART'));
  check('…sans jamais prétendre à une reprise',
    !relu.journal.some((e) => e.eventCode === 'RUN_RESUMED_AFTER_EXPECTED_RESTART'));

  // 2. Un run sans AUCUN battement : on ne peut pas prouver la vie, on clôt.
  const jamais = await nouveauRun();
  await etapes.recordStep(jamais.runId, { stepId: 'ssh.connect', label: 'Connexion', status: 'running' });
  const b2 = await etapes.recoverOrphanRuns({ reason: 'process_restart' });
  check('un run sans battement de cœur est clos, pas laissé en suspens', b2.recovered >= 1);

  // 3. Redémarrage ATTENDU mais backend jamais revenu : le marqueur SUBSISTE.
  const attente = await nouveauRun();
  await marqueur.ecrireMarqueurReprise({
    runId: attente.runId, targetId: randomUUID(), operation: 'DEPLOYMENT',
    nextExpectedStep: 'services.verify', expectedProcessName: 'panel-x', expectedPort: 4700,
  });
  const memeProcess = await marqueur.consommerMarqueurReprise();
  check('tant que le process n’a pas changé, rien n’est conclu', memeProcess.consumed === false);
  check('…le marqueur est CONSERVÉ pour le vrai redémarrage', (await marqueur.lireMarqueurReprise()) !== null);
  check('…et aucune reprise n’est journalisée',
    !(await journalDe(attente.runId)).some((e) => e.eventCode === 'RUN_RESUMED_AFTER_EXPECTED_RESTART'));
  await marqueur.effacerMarqueurReprise();
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('LE WORKER SURVIT À L’ARRÊT EN ARBRE DE PM2');
{
  const src = sansCommentaires(
    await lireSource('../backend/src/services/deployment/deploymentWorker.service.js'),
  );
  check('le worker est détaché de son groupe de processus', /detached: true/.test(src));
  check('…et de sa FILIATION, ce que `detached` ne fait pas', /setsid/.test(src));
  check('…sans quoi PM2 le retrouverait par son PPID', /parSetsid/.test(src));
  check('l’absence de `setsid` ne fait pas échouer le déploiement', /ENOENT/.test(src));
  check('…et elle est signalée, pas tue', /logger\.warn/.test(src));
  check('aucun tube ne relie le worker au backend', /stdio: 'ignore'/.test(src));
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('UNE PROMESSE REJETÉE SANS GARDE laisse une trace dans le run');
{
  garde.resetProcessGuards();
  const run = await nouveauRun();
  garde.installProcessGuards({ logger: { error() {}, warn() {}, info() {} } });
  garde.setActiveRun(run.runId);

  process.emit('unhandledRejection', new Error('promesse orpheline'), Promise.resolve());
  // Le gestionnaire écrit de façon asynchrone : on lui laisse un tour de boucle.
  await new Promise((r) => { setTimeout(r, 60); });

  const rejet = (await journalDe(run.runId)).find((e) => e.eventCode === 'UNHANDLED_REJECTION');
  check('le rejet non traité est rattaché au run ACTIF', Boolean(rejet));
  check('…au niveau erreur', rejet?.level === 'error');
  check('…avec le message d’origine', /promesse orpheline/.test(rejet?.message ?? ''));

  garde.clearActiveRun(run.runId);
  check('le run cesse d’être actif une fois clos', garde.getActiveRun() === null);
  garde.resetProcessGuards();
}

await stopMemoryMongo();
finish();
