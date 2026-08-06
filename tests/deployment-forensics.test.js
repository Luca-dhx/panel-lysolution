// INSTRUMENTATION FORENSIQUE DU PANEL — mêmes garanties que SB Auto.
//
// Le Panel identifie ses runs par `runId` et ses destinations par `targetId`,
// tous deux des UUID. La sémantique, les codes d'évènement et le sanitizer sont
// IDENTIQUES : c'est la condition pour qu'un même incident se lise de la même
// façon des deux côtés.
//
// ══ CE QUE CES TESTS FIXENT ═════════════════════════════════════════════════
//
// Diagnostiquer le déploiement du 06/08 a exigé un accès SSH, `pm2 logs`, une
// lecture directe de Mongo et une reproduction locale. Trois des questions
// posées n'ont JAMAIS pu être tranchées, faute de trace :
//
//   · pourquoi le premier clic a rendu 500 — aucun run n'existait ;
//   · pourquoi le run est resté figé 8 min 36 s sur `ssh.connect` ;
//   · si le backend s'est coupé lui-même, ou s'il a levé une erreur.
//
// Chaque test ci-dessous rend l'une de ces questions répondable par la seule
// lecture du run.
import {
  check as checkHarness, connectTestDatabase, finish, section as sectionHarness,
  setTestEnv, startMemoryMongo, stopMemoryMongo,
} from './helpers/harness.js';

setTestEnv();
await startMemoryMongo();
await connectTestDatabase();

const DeploymentRun = (await import('../backend/src/models/PanelDeploymentRun.model.js')).default;
const DeploymentAttempt = (await import('../backend/src/models/PanelDeploymentAttempt.model.js')).default;
const DeploymentTarget = (await import('../backend/src/models/PanelDeploymentTarget.model.js')).default;
const jrn = await import('../backend/src/services/deployment/forensics/runJournal.service.js');
const etapes = await import('../backend/src/services/deployment/forensics/runSteps.service.js');
const garde = await import('../backend/src/services/deployment/forensics/processGuard.js');
const final = await import('../backend/src/services/deployment/forensics/finalization.service.js');
const { sanitizeHeaders, sanitizeValue } = await import('../backend/src/services/deployment/forensics/sanitize.js');
const { randomUUID } = await import('node:crypto');

/* Le harnais du Panel tient déjà le compte et rend le bilan : en garder un
   second finirait par le contredire, et c'est le genre de divergence qu'on
   ne remarque qu'une fois un test faussement vert. */
const check = checkHarness;
const section = sectionHarness;

await DeploymentTarget.init();
const { randomUUID: uuid } = await import('node:crypto');

let n = 0;
const cible = async (over = {}) => {
  n += 1;
  const at = new Date().toISOString();
  await DeploymentTarget.deleteMany({});
  return DeploymentTarget.create({
    targetId: randomUUID(),
    name: `D${n}`, url: `https://d${n}.exemple.com`, host: `d${n}.exemple.com`,
    type: 'subdomain', environment: 'TEST', backendPort: 5100 + n,
    lifecycleStatus: 'ACTIVE', state: 'DEPLOYING', createdAt: at, updatedAt: at, ...over,
  });
};
const run = async (target) => DeploymentRun.create({
  runId: randomUUID(), targetId: target.targetId, targetName: target.name, host: target.host,
  url: target.url, environment: 'TEST',
  operationType: 'DEPLOYMENT', status: 'running', startedAt: new Date().toISOString(), steps: [],
});

/* ══════════════════════════════════════════════════════════════════════════ */
section('AUCUN SECRET NE PEUT ENTRER DANS LE JOURNAL');
{
  const propre = sanitizeValue({
    sshPassword: 'MonMotDePasse!2026',
    bridgeToken: 'abcdef0123456789abcdef',
    authorization: 'Bearer eyJhbGciOiJIUzI1NiJ9.charge.signature',
    imbrique: { apiKey: 'sk_live_ABCDEFGHIJKLMNOP', innocent: 'valeur visible' },
    message: 'échec de connexion à mongodb+srv://user:motdepasse@cluster.mongodb.net/base',
    trace: 'Bearer eyJhbGciOiJIUzI1NiJ9.aaaaaaaaaaaaaaaaaaaaaaaa.bbbb',
  });
  const texte = JSON.stringify(propre);

  check('le mot de passe SSH n’apparaît pas', !texte.includes('MonMotDePasse'));
  check('le jeton de pont non plus', !texte.includes('abcdef0123456789'));
  check('un en-tête d’autorisation non plus', !texte.includes('eyJhbGciOiJIUzI1NiJ9'));
  check('une clé d’API imbriquée non plus', !texte.includes('sk_live_ABCDEFGHIJKLMNOP'));
  check('une URI Mongo avec identifiants non plus', !texte.includes('motdepasse@cluster'));
  check('…mais ce qui n’est pas secret reste lisible', texte.includes('valeur visible'));

  const entetes = sanitizeHeaders({
    authorization: 'Bearer secret', cookie: 'session=abc',
    'content-type': 'application/json', 'user-agent': 'Chrome',
  });
  check('les en-têtes conservent le contenu utile', entetes['content-type'] === 'application/json');
  check('…et rejettent l’autorisation', entetes.authorization === undefined);
  check('…et les cookies', entetes.cookie === undefined);
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('UN 500 AVANT LA CRÉATION DU RUN LAISSE UNE TRACE');
{
  await DeploymentAttempt.deleteMany({});
  const tentative = await jrn.openAttempt({
    requestId: 'req-0001', route: '/api/deployment/deploy/stream', method: 'POST', user: 'dev@exemple.com',
  });
  await jrn.journalAttempt(tentative._id, {
    source: jrn.SOURCES.HTTP, level: jrn.LEVELS.ERROR,
    eventCode: jrn.EVENTS.HTTP_REQUEST_FAILED,
    message: 'Erreur avant création du run',
    error: Object.assign(new Error('boom'), { code: 'X_FAIL' }),
    details: { headersSent: false, sshPassword: 'NE-DOIT-PAS-APPARAITRE' },
  });
  await jrn.closeAttempt(tentative._id, { runId: null, status: 'failed', httpStatus: 500 });

  const relue = await DeploymentAttempt.findById(tentative._id).lean();
  check('la tentative existe MÊME SANS run', relue !== null && relue.run === null);
  check('…elle porte la route exacte', relue.route === '/api/deployment/deploy/stream');
  check('…le requestId', relue.requestId === 'req-0001');
  check('…le status HTTP', relue.httpStatus === 500);
  check('…le code d’erreur', relue.journal[0].errorCode === 'X_FAIL');
  check('…la pile', typeof relue.journal[0].stack === 'string' && relue.journal[0].stack.includes('Error'));
  check('…et AUCUN secret', !JSON.stringify(relue).includes('NE-DOIT-PAS-APPARAITRE'));
  check('« aucun run créé donc on ne sait pas » n’est plus une réponse possible',
    relue.journal.length > 0);
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('TOUTE ÉTAPE RUNNING FINIT PAR UN ÉTAT TERMINAL');
{
  const t = await cible();
  const r = await run(t);

  await etapes.recordStep(r.runId, { stepId: 'ssh.connect', label: 'Connexion sécurisée', status: 'running' });
  let relu = await DeploymentRun.findOne({ runId: r.runId }).lean();
  check('l’étape est PERSISTÉE, pas seulement émise', relu.steps[0]?.id === 'ssh.connect');
  check('…marquée en cours', relu.steps[0].status === 'running');
  check('…et le run pointe dessus', relu.currentStepId === 'ssh.connect');
  check('…avec une entrée de journal', relu.journal.some((e) => e.eventCode === 'STEP_STARTED'));

  // Le process meurt ici — c'est exactement le cas du 06/08.
  const repris = await etapes.recoverOrphanRuns({ reason: 'process_restart' });
  check('au redémarrage, le run orphelin est repris', repris.recovered === 1);

  relu = await DeploymentRun.findOne({ runId: r.runId }).lean();
  check('l’étape figée devient INTERRUPTED, pas ERROR',
    relu.steps[0].status === 'interrupted');
  check('…car elle n’a pas échoué : elle a été coupée',
    relu.steps[0].finishedAt !== null);
  check('le run est clos', relu.status === 'interrupted');
  check('…et la cause est nommée',
    relu.journal.some((e) => e.eventCode === 'RUN_INTERRUPTED_BY_PROCESS_RESTART'));
  check('…avec le PID du nouveau process',
    relu.journal.find((e) => e.eventCode === 'RUN_INTERRUPTED_BY_PROCESS_RESTART').details.newPid === process.pid);
  check('plus aucun chargement éternel n’est possible', relu.currentStepId === null);
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('UNE ERREUR NON GÉRÉE EST JOURNALISÉE AVANT LA CHUTE');
{
  const t = await cible();
  const r = await run(t);

  garde.resetProcessGuards();
  const silencieux = { error: () => {} };
  const pose = garde.installProcessGuards({ logger: silencieux });
  check('les observateurs s’installent', pose.installed === true);
  check('…et une seconde pose est ignorée',
    garde.installProcessGuards({ logger: silencieux }).installed === false);

  garde.setActiveRun(r.runId);
  check('le run actif est déclaré au process', garde.getActiveRun() === r.runId);

  // On déclenche l'observateur comme Node le ferait.
  process.emit('unhandledRejection', Object.assign(new Error('rejet simulé'), { code: 'ECONNRESET' }));
  await new Promise((res) => { setTimeout(res, 120); });

  const relu = await DeploymentRun.findOne({ runId: r.runId }).lean();
  const entree = relu.journal.find((e) => e.eventCode === 'UNHANDLED_REJECTION');
  check('le rejet non géré est inscrit DANS LE RUN', Boolean(entree));
  check('…avec son code', entree?.errorCode === 'ECONNRESET');
  check('…sa pile', typeof entree?.stack === 'string');
  check('…et le PID du process qui tombe', entree?.pid === process.pid);

  garde.clearActiveRun(r.runId);
  check('le run cesse d’être actif après l’opération', garde.getActiveRun() === null);
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('LE SUCCÈS EXIGE UNE FINALISATION VÉRIFIÉE');
{
  // 1. Destination NON finalisée : l'état exact du 06/08.
  const t1 = await cible({ state: 'DEPLOYING' });
  const r1 = await run(t1);
  const verdict1 = await final.verifyFinalization(r1.runId, t1.targetId);

  check('une destination restée DEPLOYING n’est PAS finalisée', verdict1.finalized === false);
  check('…et la raison est nommée',
    verdict1.missing.some((m) => m.includes('state=DEPLOYING')));

  const relu1 = await DeploymentRun.findOne({ runId: r1.runId }).lean();
  check('le run passe à « finalization_failed »', relu1.status === 'finalization_failed');
  check('…ni succès, ni échec de déploiement', relu1.status !== 'ok' && relu1.status !== 'error');
  check('…le détail des contrôles est conservé', relu1.finalization.checks.stateOk === false);
  check('…et le journal le dit', relu1.journal.some((e) => e.eventCode === 'FINALIZATION_FAILED'));

  // 2. Destination finalisée, mais port non prouvé.
  const t2 = await cible({ state: 'DEPLOYED' });
  const r2 = await run(t2);
  const verdict2 = await final.verifyFinalization(r2.runId, t2.targetId);
  check('un port non ACTIVE suffit à refuser le succès', verdict2.finalized === false);
  check('…et le dit explicitement',
    verdict2.missing.some((m) => m.includes('réservation de port')));
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('LE JOURNAL EST APPEND-ONLY ET EXPOSÉ PAR L’API');
{
  const t = await cible();
  const r = await run(t);

  for (const code of ['PM2_STATE_BEFORE', 'PM2_RESTART_REQUESTED', 'PM2_STATE_AFTER']) {
    await jrn.journal(r.runId, {
      source: jrn.SOURCES.PM2, eventCode: code, processName: 'sbauto-demo', port: 5002, pid: 4242,
      message: `étape ${code}`,
    });
  }
  const relu = await DeploymentRun.findOne({ runId: r.runId }).lean();
  check('les entrées s’ajoutent dans l’ordre',
    relu.journal.map((e) => e.eventCode).join(',') === 'PM2_STATE_BEFORE,PM2_RESTART_REQUESTED,PM2_STATE_AFTER');
  check('…chacune porte sa source', relu.journal.every((e) => e.source === 'PM2'));
  check('…son process et son port',
    relu.journal[0].processName === 'sbauto-demo' && relu.journal[0].port === 5002);
  check('…et son PID', relu.journal[0].pid === 4242);

  const { describeRun } = await import('../backend/src/services/deployment/deploymentRun.service.js');
  const vue = describeRun(await DeploymentRun.findOne({ runId: r.runId }).lean());
  check('l’API expose le journal', Array.isArray(vue.journal) && vue.journal.length === 3);
  check('…et le verdict de finalisation quand il existe', vue.finalization === null);

  // Un runId inconnu ne doit rien casser.
  const ignore = await jrn.journal(null, { eventCode: 'X' });
  check('journaliser sans run est sans effet, pas une erreur', ignore === null);
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('LE RAPPORT DIAGNOSTIC — fait observé et cause déduite, jamais confondus');
{
  const fs = await import('node:fs/promises');
  const ui = (await fs.readFile(new URL('../frontend/src/components/deployment/RunDiagnostics.tsx', import.meta.url), 'utf8'))
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  check('le journal est filtrable par source', /SOURCES/.test(ui));
  check('le rapport complet est copiable en un geste', /Copier le rapport/.test(ui));
  check('la cause déduite est présentée comme telle', /cause déduite/.test(ui));
  check('…distinguée des faits OBSERVÉS', /faits observés/.test(ui));
  check('…et une cause non établie est annoncée comme hypothèse',
    /NON établie/.test(ui) && /hypothèse/.test(ui));
  check('la certitude vient du journal, pas d’une supposition de l’écran',
    /certain === true/.test(ui));
  check('une entrée SANS déduction reste affichée telle quelle',
    /if \(!d \|\| typeof d !== 'object' \|\| !\('causeDeduite' in d\)\) return null/.test(ui));
}

/* ══════════════════════════════════════════════════════════════════════════ */

await stopMemoryMongo();
finish();
