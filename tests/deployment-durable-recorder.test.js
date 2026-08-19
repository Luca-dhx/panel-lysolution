/**
 * ══ LE JOURNAL DURABLE, ET LA BARRIÈRE DE PUBLICATION ═══════════════════════
 *
 * ── CE QUE CETTE RECETTE ÉPROUVE, ET POURQUOI ELLE EXISTE ──────────────────
 *
 * Les étapes d'un déploiement partaient en base sans être attendues. Le moteur
 * continuait donc à déployer alors que son journal durable était tombé : il
 * pouvait BASCULER LA RELEASE — modifier ce que sert la production — sans plus
 * être capable d'écrire ce qu'il était en train de faire. Le run restait figé à
 * l'étape d'avant, et plus personne, ni l'écran ni le démarrage suivant, ne
 * pouvait dire jusqu'où il était allé.
 *
 * La doctrine que cette recette verrouille tient en deux phrases :
 *
 *   AVANT la frontière de publication, une perte de journal REFUSE la
 *   publication. Rien n'a changé pour le public, s'arrêter ne coûte rien.
 *
 *   APRÈS, elle ne défait rien et ne cache rien : le run dit qu'il a publié,
 *   dit que sa chronologie est trouée, et conserve l'erreur métier primaire.
 *
 * ── POURQUOI CE N'EST PAS UN TEST DU RECORDER ─────────────────────────────
 *
 * Éprouver `createDurableRecorder` seul prouverait qu'un objet se souvient de
 * ses échecs — pas qu'un déploiement s'arrête. Toutes les injections partent
 * donc du CHEMIN RÉEL, celui du contrôleur :
 *
 *     createRun  →  runDeploymentJob  →  executeOperation
 *                →  DeploymentEngine.deployWithReport  →  finalizeRun
 *
 * avec Mongo réel (en mémoire), le vrai coffre de mots de passe, le vrai
 * registre de ports, la vraie identité de projet, le vrai pipeline distant et
 * le vrai traceur d'étapes. Le SEUL double est le TRANSPORT — aucun serveur
 * réel, aucun mot de passe VPS.
 *
 * Les deux coutures d'injection (`recorderStore`, `engine`) sont
 * ARCHITECTURALES : aucune ligne du runtime ne regarde `NODE_ENV`, et aucun
 * chemin ne se raccourcit en recette.
 */
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  check, connectTestDatabase, finish, section, setTestEnv, startMemoryMongo, stopMemoryMongo,
} from './helpers/harness.js';

setTestEnv();
await startMemoryMongo();
await connectTestDatabase();

const { DeploymentEngine } = await import('../backend/src/deployment-engine/DeploymentEngine.js');
const { FakeTransport } = await import('../backend/src/deployment-engine/transport/FakeTransport.js');
const { planTopology } = await import('../backend/src/deployment-engine/topology.js');
const profile = await import('../backend/src/deployment-engine/config/project.profile.js');
const {
  CANONICAL_STEPS, PUBLICATION, publicationBoundaryStep, isBeforePublication,
} = await import('../backend/src/deployment-engine/steps.js');

const runs = await import('../backend/src/services/deployment/deploymentRun.service.js');
const { runDeploymentJob } = await import('../backend/src/services/deployment/deploymentJob.service.js');
const {
  createDurableRecorder, RECORDER_ERRORS, DURABILITY_PHASE,
} = await import('../backend/src/services/deployment/runRecorder.service.js');
const PanelDeploymentRun = (await import('../backend/src/models/PanelDeploymentRun.model.js')).default;
const PanelDeploymentTarget = (await import('../backend/src/models/PanelDeploymentTarget.model.js')).default;

/* ────────────────────────────────────────────────────────────────────────── */
/*  LE HARNAIS                                                               */
/* ────────────────────────────────────────────────────────────────────────── */

const HOST = 'durable-recorder.ly-solution.com';
const COMMIT = 'beef0123456789abcdef0123456789abcdef0123';
const FRONTIERE = publicationBoundaryStep().id;

/**
 * LE SECRET QUE PORTE UNE PANNE MONGO RÉELLE.
 *
 * Une `MongooseServerSelectionError` cite l'URI de connexion — donc des
 * identifiants. C'est cette chaîne exacte qu'on injecte, pour vérifier qu'elle
 * ne ressort NULLE PART : ni dans le run, ni dans le rapport, ni à l'écran.
 */
const PANNE_AVEC_SECRET = 'connexion perdue : mongodb://panel:sup3rs3cret@db.interne:27017/panel_prod';
const MOT_DE_PASSE_MONGO = 'sup3rs3cret';

const INDEX_HTML = '<!doctype html><html><head><script type="module" src="/assets/app-TEST1234.js"></script></head><body></body></html>';
const APP_JS = 'console.log("app")';

/** Arborescence source minimale, conforme au profil RÉEL du Panel. */
async function makeSource() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'durable-recorder-'));
  for (const app of profile.APPS) {
    const dir = path.join(root, app.dir);
    await fs.mkdir(path.join(dir, 'src'), { recursive: true });
    await fs.writeFile(path.join(dir, 'package.json'), JSON.stringify({ name: app.id }));
    await fs.writeFile(path.join(dir, 'src', 'index.js'), '// x\n');
    await fs.writeFile(path.join(dir, 'src', 'server.js'), '// x\n');
    if (app.role === 'web' || app.role === 'web-sub' || app.role === 'static') {
      await fs.writeFile(path.join(dir, 'package-lock.json'), '{}');
    }
  }
  return root;
}

const buildExec = async (cmd, args, { cwd } = {}) => {
  if (cmd === 'git') {
    if (args[0] === 'rev-parse' && args[1] === 'HEAD') return { code: 0, signal: null, stdout: `${COMMIT}\n`, stderr: '' };
    if (args[0] === 'rev-parse') return { code: 0, signal: null, stdout: 'main\n', stderr: '' };
    return { code: 0, signal: null, stdout: '', stderr: '' };
  }
  if (cmd === 'npm' && args[0] === 'run' && args[1] === 'build') {
    const dist = path.join(cwd, 'dist');
    await fs.mkdir(path.join(dist, 'assets'), { recursive: true });
    await fs.writeFile(path.join(dist, 'index.html'), INDEX_HTML);
    await fs.writeFile(path.join(dist, 'assets', 'app-TEST1234.js'), APP_JS);
  }
  return { code: 0, signal: null, stdout: '', stderr: '' };
};

const SOURCE = await makeSource();
const TOPO = planTopology({ host: HOST, profile });

/**
 * ══ LA TRACE ORDONNÉE — LA PREUVE DE LA BARRIÈRE ════════════════════════════
 *
 * Comparer des horodatages ne prouverait rien : deux écritures de la même
 * milliseconde sont indiscernables, et c'est précisément l'ordre de ces
 * deux-là qui décide si l'on publie avant de savoir l'écrire.
 *
 * Écritures durables et gestes distants poussent donc dans LE MÊME tableau, à
 * l'instant où ils ont lieu. L'ordre du tableau EST l'ordre des faits.
 */
class TracingTransport extends FakeTransport {
  constructor(trace) { super(); this.trace = trace; }

  async exec(command, opts) {
    this.trace.push({ kind: 'remote.exec', command });
    return super.exec(command, opts);
  }

  async uploadDir(localPath, remotePath) {
    this.trace.push({ kind: 'remote.upload', remotePath });
    return super.uploadDir(localPath, remotePath);
  }

  async uploadFile(localPath, remotePath) {
    this.trace.push({ kind: 'remote.upload', remotePath });
    return super.uploadFile(localPath, remotePath);
  }

  async writeFile(remotePath, content) {
    this.trace.push({ kind: 'remote.write', remotePath });
    return super.writeFile(remotePath, content);
  }
}

/** VPS simulé en bonne santé, qui « sert » exactement l'artefact construit. */
function healthyVps(trace, surcharges = []) {
  const t = new TracingTransport(trace)
    .on('id -un', { stdout: 'root' })
    .on('command -v nginx', { stdout: 'OK' })
    .on('command -v node', { stdout: 'OK' })
    .on('command -v pm2', { stdout: 'OK' })
    .on('command -v certbot', { stdout: 'OK' })
    .on('command -v mongod', { stdout: 'OK' })
    .on('nginx -t', { stdout: 'syntax is ok\ntest is successful' })
    .on('test -w /var/www', { stdout: 'WRITABLE' })
    .on(/df -Pk/, { stdout: '2000000' })
    .on('fullchain.pem', { stdout: 'OK' })
    .on(/127\.0\.0\.1.*health/, { stdout: '200' })
    .on(/https:\/\/.*\/health/, { stdout: '{"success":true,"data":{"env":"TEST"}}\n200' })
    .on(/-m 10 'https:\/\/[^']+\/'/, { stdout: INDEX_HTML })
    .on(/\/assets\/app-TEST1234\.js'/, { stdout: APP_JS })
    .on(/\/version\.json'/, { stdout: JSON.stringify({ commitHash: COMMIT }) });
  t.files.set(`${TOPO.backendDir}/build-manifest.json`, JSON.stringify({ commitHash: COMMIT }));
  // Une règle ajoutée après coup SURCHARGE les précédentes (sémantique du double).
  for (const s of surcharges) t.on(s.match, s.response);
  return t;
}

/**
 * LE MOTEUR RÉEL, avec ce que seul l'environnement peut fournir.
 *
 * Rien de la doctrine n'est remplacé : la barrière, le registre des étapes, le
 * pipeline et le rapport sont ceux de la production. On ne fournit que le
 * transport et les réglages que le moteur expose déjà comme injectables —
 * la source à construire, l'IP attendue, les temporisations.
 */
class HarnessEngine extends DeploymentEngine {
  constructor(tx) {
    super({ wildcardBases: ['ly-solution.com'], mongoUri: process.env.MONGODB_URI });
    this.tx = tx;
  }

  async deployWithReport({ options = {}, ...reste }) {
    return super.deployWithReport({
      ...reste,
      transport: this.tx,
      options: {
        ...options,
        profile,
        version: 'e2e',
        buildRoot: SOURCE,
        buildExec,
        requireCleanSource: false,
        dnsExpectedIp: '203.0.113.10',
        /**
         * ══ LA SYNCHRONISATION RÉSEAU EST SIMULÉE — et il le fallait ═══════
         *
         * Cette recette construit son moteur avec le VRAI `MONGODB_URI` : elle
         * éprouve le journal durable de production, et c'est tout son intérêt.
         * Mais l'étape `runtime_config` du pipeline, elle, ÉCRIT — elle publie
         * les URLs de la destination dans la configuration système.
         *
         * Faute d'être simulée, elle écrivait donc le domaine FICTIF de cette
         * recette — `durable-recorder.ly-solution.com` — dans la configuration
         * RÉELLE du Panel de TEST. Constaté en exploitation : le Panel déployé
         * annonçait aux projets une adresse d'API qui n'a jamais existé, et
         * chaque passage de la chaîne de qualité la réécrivait après un
         * déploiement qui venait de la corriger.
         *
         * Les recettes voisines simulent déjà cette capacité (voir
         * `engine-genericity-e2e`). Celle-ci ne le faisait pas, et elle est la
         * seule à porter l'URI réelle : la combinaison des deux faisait la
         * fuite. On rend donc l'étape observable sans la laisser écrire — ce
         * qui n'enlève rien au sujet de la recette, qui est le journal.
         */
        runtimeConfigSync: async ({ urls }) => ({ ok: true, urls, created: false, simule: true }),
        health: { localRetries: 1, localDelayMs: 0, publicRetries: 1, publicDelayMs: 0 },
        dnsResolutionOpts: { timeoutMs: 400, minIntervalMs: 1, maxIntervalMs: 1 },
      },
    });
  }
}

/**
 * LE MAGASIN D'ÉCRITURES INSTRUMENTÉ.
 *
 * Il APPELLE LES VRAIES ÉCRITURES — c'est bien le journal de production qui
 * est éprouvé — et refuse celles que la recette a désignées. Une panne de
 * persistance ne se provoque pas autrement sans mettre un `if (test)` dans le
 * runtime, ce que ce lot interdit explicitement.
 */
function magasin({ echecEtape = null, echecFinalize = false, echecLog = false, trace = null } = {}) {
  return {
    async recordStep(runId, step) {
      if (echecEtape?.(step)) throw new Error(PANNE_AVEC_SECRET);
      await runs.recordStep(runId, step);
      trace?.push({ kind: 'persist', stepId: step.id, status: step.status });
    },
    async appendLog(runId, message, level) {
      if (echecLog) throw new Error(PANNE_AVEC_SECRET);
      return runs.appendLog(runId, message, level);
    },
    async finalizeRun(runId, payload) {
      if (echecFinalize) throw new Error(PANNE_AVEC_SECRET);
      return runs.finalizeRun(runId, payload);
    },
  };
}

/** Le prédicat le plus courant : « cette étape-là, dans cet état-là ». */
const surEtape = (id, status = null) => (step) =>
  step?.id === id && (status === null || step?.status === status);

let compteur = 0;
async function nouvelleDestination() {
  compteur += 1;
  const at = new Date().toISOString();
  await PanelDeploymentTarget.deleteMany({});
  const targetId = crypto.randomUUID();
  await PanelDeploymentTarget.create({
    targetId,
    name: `Panel recette ${compteur}`,
    url: `https://${HOST}`,
    host: HOST,
    type: 'subdomain',
    registrableDomain: 'ly-solution.com',
    subdomain: 'durable-recorder',
    wildcardBase: 'ly-solution.com',
    environment: 'TEST',
    sshHost: '203.0.113.10',
    sshUser: 'root',
    sshPort: 22,
    backendPort: 5400 + compteur,
    remoteRoot: '/var/www',
    lifecycleStatus: 'ACTIVE',
    state: 'NEW',
    createdAt: at,
    updatedAt: at,
  });
  return PanelDeploymentTarget.findOne({ targetId }).lean();
}

/**
 * UN DÉPLOIEMENT COMPLET, PAR LE CHEMIN RÉEL.
 *
 * Exactement ce que fait le contrôleur, puis le worker : on ouvre le run, on
 * pose le verrou de destination, puis on exécute le travail.
 */
async function deploiement({ store = undefined, surcharges = [], trace = [] } = {}) {
  const target = await nouvelleDestination();
  const runId = await runs.createRun({
    target, operationType: 'DEPLOYMENT', user: 'recette@panel.test',
  });
  const { markDeploying } = await import('../backend/src/services/deployment/deploymentTarget.service.js');
  await markDeploying(target.targetId, runId);

  const tx = healthyVps(trace, surcharges);
  const journaux = [];
  const resultat = await runDeploymentJob({
    runId,
    targetId: target.targetId,
    operationType: 'DEPLOYMENT',
    sshPassword: 'mot-de-passe-de-recette',
    user: 'recette@panel.test',
    engine: new HarnessEngine(tx),
    recorderStore: store,
    logger: { error: (m) => journaux.push(String(m)), warn: () => {}, info: () => {} },
  });

  const doc = await PanelDeploymentRun.findOne({ runId }).lean();
  const cible = await PanelDeploymentTarget.findOne({ targetId: target.targetId }).lean();
  return { runId, target, tx, trace, resultat, doc, cible, journaux };
}

const etape = (doc, id) => (doc?.steps ?? []).find((s) => s.id === id);
const aUploade = (tx) => tx.uploads.length > 0;

/* ════════════════════════════════════════════════════════════════════════════
   1. NOMINAL — le chemin complet, sans aucune panne
   ════════════════════════════════════════════════════════════════════════════ */
section('1. Nominal — 23 étapes, publication franchie, journal complet');
{
  const trace = [];
  const { doc, cible, resultat, tx } = await deploiement({ trace });

  const rouges = (doc.steps ?? []).filter((s) => s.status === 'error');
  if (rouges.length) console.error(`    → ${rouges.map((s) => `${s.id}:${s.errorCode ?? ''}`).join(' | ')}`);

  check('le déploiement réussit', resultat.outcome.status === 'ok');
  check(`les ${CANONICAL_STEPS.length} étapes canoniques sont tranchées`,
    (doc.steps ?? []).length === CANONICAL_STEPS.length
      && (doc.steps ?? []).every((s) => ['ok', 'warning', 'skipped'].includes(s.status)));
  check('aucune étape en erreur', rouges.length === 0);
  check('la publication est constatée OCCURRED', doc.publication.state === PUBLICATION.OCCURRED);
  check('…et nommée sur l’étape frontière du registre', doc.publication.boundaryStepId === FRONTIERE);
  check('le journal est déclaré COMPLET', doc.publication.journalComplete === true);
  check('aucune erreur de persistance', doc.persistenceError == null);
  check('le run est conclu', resultat.finalized === true && doc.status === 'ok');
  check('la destination est passée en ligne', cible.state === 'DEPLOYED');
  check('…et son verrou de déploiement est retombé', cible.activeDeploymentRunId == null);
  check('le transfert a bien eu lieu', aUploade(tx));
}

/* ════════════════════════════════════════════════════════════════════════════
   2. LA PREUVE D'ORDRE — persister AVANT de publier
   ════════════════════════════════════════════════════════════════════════════ */
section('2. Barrière prouvée par l’ORDRE des faits, pas par des horodatages');
{
  const trace = [];
  const store = magasin({ trace });
  const { tx } = await deploiement({ store, trace });

  const premierTransfert = trace.findIndex((e) => e.kind === 'remote.upload');
  const persistances = trace
    .map((e, i) => ({ ...e, i }))
    .filter((e) => e.kind === 'persist' && isBeforePublication(e.stepId));
  const derniereAvant = persistances.length ? persistances[persistances.length - 1].i : -1;

  check('un transfert a bien eu lieu (sinon la preuve serait vide)', premierTransfert >= 0);
  check('des étapes pré-publication ont bien été persistées', persistances.length > 0);
  check('TOUTE persistance pré-publication précède le premier geste de publication',
    derniereAvant >= 0 && premierTransfert > derniereAvant);
  check('…dont la dernière : `artifact.build` est durable avant le premier transfert',
    trace.findIndex((e) => e.kind === 'persist' && e.stepId === 'artifact.build' && e.status === 'ok')
      < premierTransfert);
  check('aucun transfert n’a précédé une écriture durable',
    tx.uploads.length > 0 && premierTransfert > 0);
}

/* ════════════════════════════════════════════════════════════════════════════
   3. LA DERNIÈRE ÉCRITURE AVANT PUBLICATION ÉCHOUE — le test principal du lot
   ════════════════════════════════════════════════════════════════════════════ */
section('3. Dernière écriture durable avant la bascule perdue → RIEN n’est publié');
{
  const trace = [];
  const store = magasin({ echecEtape: surEtape('artifact.build', 'ok'), trace });
  const { doc, resultat, tx, cible } = await deploiement({ store, trace });

  check('LA COMMANDE DE PUBLICATION N’EST JAMAIS ÉMISE', tx.uploads.length === 0);
  check('…aucun `.next` n’est apparu sur le serveur',
    !tx.commands.some(({ command }) => command.includes('.next')));
  check('le déploiement est refusé', resultat.outcome.status === 'error');
  check('…avec un code de refus typé',
    [RECORDER_ERRORS.WRITE_FAILED, RECORDER_ERRORS.UNAVAILABLE].includes(resultat.outcome.error?.code));
  check('l’arrêt est nommé sur l’étape frontière', resultat.outcome.error?.step === FRONTIERE);
  check('la publication est déclarée NON ATTEINTE — et non « issue inconnue »',
    doc.publication.state === PUBLICATION.NOT_REACHED);
  check('aucune étape postérieure à la frontière n’a réussi',
    (doc.steps ?? []).filter((s) => !isBeforePublication(s.id) && s.status === 'ok').length === 0);
  check('la destination n’est PAS annoncée en ligne', cible.state !== 'DEPLOYED');
  check('le journal est marqué incomplet', doc.publication.journalComplete === false);
  check('…à l’étape exacte qui n’a pas pu être écrite',
    doc.publication.degradedAtStepId === 'artifact.build');
}

/* ════════════════════════════════════════════════════════════════════════════
   4. PANNES PRÉ-PUBLICATION — fail closed, à chaque étape
   ════════════════════════════════════════════════════════════════════════════ */
section('4. Toute perte de journal AVANT la frontière ferme la porte');
for (const id of ['deployment.initialize', 'ssh.connect', 'server.preflight', 'dns.verify', 'artifact.build']) {
  const trace = [];
  const store = magasin({ echecEtape: surEtape(id), trace });
  const { doc, resultat, tx, cible } = await deploiement({ store, trace });

  check(`[${id}] aucun transfert vers le serveur`, tx.uploads.length === 0);
  check(`[${id}] le déploiement est en échec`, resultat.outcome.status === 'error');
  check(`[${id}] la publication reste NON ATTEINTE`, doc.publication.state === PUBLICATION.NOT_REACHED);
  check(`[${id}] la destination n’est jamais annoncée en ligne`, cible.state !== 'DEPLOYED');
  check(`[${id}] aucun faux SUCCÈS`, doc.status !== 'ok');
}

/* ════════════════════════════════════════════════════════════════════════════
   5. PANNES POST-PUBLICATION — on ne réécrit pas l'histoire
   ════════════════════════════════════════════════════════════════════════════ */
section('5. Après la bascule, la perte de journal ne dépublie rien');
for (const id of ['dependencies.install', 'uploads.migrate', 'media.publish']) {
  const trace = [];
  const store = magasin({ echecEtape: surEtape(id), trace });
  const { doc, tx } = await deploiement({ store, trace });

  check(`[${id}] le transfert a bien eu lieu`, aUploade(tx));
  check(`[${id}] la publication est reconnue comme AYANT EU LIEU`,
    doc.publication.state === PUBLICATION.OCCURRED);
  check(`[${id}] le journal est déclaré INCOMPLET`, doc.publication.journalComplete === false);
  check(`[${id}] …à l’étape exacte perdue`, doc.publication.degradedAtStepId === id);
  check(`[${id}] la perte est typée POST_PUBLICATION`,
    doc.persistenceError?.phase === DURABILITY_PHASE.POST_PUBLICATION
    && doc.persistenceError?.code === RECORDER_ERRORS.PERSISTENCE_LOST);
  check(`[${id}] le run n’affirme JAMAIS que rien n’a été publié`,
    doc.publication.state !== PUBLICATION.NOT_REACHED);
}

/* ════════════════════════════════════════════════════════════════════════════
   6. SANTÉ PUBLIQUE EN ÉCHEC + PERTE DE JOURNAL — trois faits, aucun écrasé
   ════════════════════════════════════════════════════════════════════════════ */
section('6. Publié, santé publique KO, journal troué — les trois faits survivent');
{
  const trace = [];
  const store = magasin({ echecEtape: surEtape('media.publish'), trace });
  const { doc, tx } = await deploiement({
    store,
    trace,
    // Le site répond, mais pas ce qu'on vient de publier : c'est un échec de
    // vérification publique, pas une panne de transport.
    surcharges: [{ match: /-m 10 'https:\/\/[^']+\/'/, response: { stdout: '<html>ancienne version</html>' } }],
  });

  check('FAIT 1 — la publication a eu lieu', doc.publication.state === PUBLICATION.OCCURRED && aUploade(tx));
  check('FAIT 2 — la vérification publique a échoué',
    doc.status !== 'ok' && Boolean(doc.error?.code));
  check('FAIT 3 — le journal durable est dégradé', doc.publication.journalComplete === false);
  check('l’erreur PRIMAIRE reste celle du déploiement, pas celle du journal',
    doc.error?.code !== RECORDER_ERRORS.PERSISTENCE_LOST
    && doc.error?.code !== RECORDER_ERRORS.WRITE_FAILED);
  check('…et la panne de journal voyage à côté, dans son propre champ',
    doc.persistenceError?.code === RECORDER_ERRORS.PERSISTENCE_LOST);
}

/* ════════════════════════════════════════════════════════════════════════════
   7. ERREUR PRIMAIRE + ERREUR DE JOURNAL — jamais l'inverse
   ════════════════════════════════════════════════════════════════════════════ */
section('7. Une commande distante échoue, puis le journal tombe');
{
  const trace = [];
  const store = magasin({ echecEtape: surEtape('dependencies.install', 'error'), trace });
  const { doc, tx } = await deploiement({
    store,
    trace,
    surcharges: [{ match: /npm ci/, response: { code: 1, stderr: 'npm ERR! code ELIFECYCLE' } }],
  });

  check('le transfert avait eu lieu (on est après la frontière)', aUploade(tx));
  check('l’erreur primaire est celle de la commande distante',
    Boolean(doc.error?.code)
    && ![RECORDER_ERRORS.PERSISTENCE_LOST, RECORDER_ERRORS.WRITE_FAILED, RECORDER_ERRORS.UNAVAILABLE]
      .includes(doc.error.code));
  check('…nommée sur l’étape qui a réellement échoué',
    doc.error?.step === 'dependencies.install');
  check('la panne de journal ne l’a PAS remplacée',
    doc.persistenceError?.code === RECORDER_ERRORS.PERSISTENCE_LOST
    && doc.error.code !== doc.persistenceError.code);
  check('la publication reste reconnue', doc.publication.state === PUBLICATION.OCCURRED);
}

/* ════════════════════════════════════════════════════════════════════════════
   8. LA CONCLUSION ÉCHOUE — la production peut être saine
   ════════════════════════════════════════════════════════════════════════════ */
section('8. `finalizeRun` échoue alors que le déploiement a réussi');
{
  const trace = [];
  const store = magasin({ echecFinalize: true, trace });
  const { doc, cible, resultat, journaux, runId } = await deploiement({ store, trace });

  check('le déploiement lui-même a réussi', resultat.outcome.status === 'ok');
  check('la conclusion est signalée comme NON écrite', resultat.finalized === false);
  check('…avec une cause typée', resultat.finalizationError?.code === RECORDER_ERRORS.PERSISTENCE_LOST);
  check('le run n’est PAS annoncé réussi — on n’a pas su l’écrire', doc.status !== 'ok');
  check('la panne est tracée là où elle survit à Mongo (sortie d’erreur)',
    journaux.some((l) => l.includes('NON CONCLU') && l.includes(runId)));
  check('…et la trace nomme l’état de publication', journaux.some((l) => l.includes('publication=FRANCHIE')));
  check('la DESTINATION, elle, est bien enregistrée en ligne',
    cible.state === 'DEPLOYED' && resultat.targetRecorded === true);
  check('…et son verrou est retombé (sinon elle serait figée à jamais)',
    cible.activeDeploymentRunId == null);

  /**
   * LA RÉCONCILIATION — c'est le prochain démarrage qui tranche, et il ne
   * tranche PAS « rien n'a été publié ».
   */
  await PanelDeploymentRun.updateOne({ runId }, { $set: { workerHeartbeatAt: new Date(Date.now() - 600_000).toISOString() } });
  const reconcilies = await runs.finalizeOrphanRuns();
  const apres = await PanelDeploymentRun.findOne({ runId }).lean();
  check('le run non conclu est repris au démarrage suivant', reconcilies === 1);
  check('…en « interrompu », ni réussi ni échoué', apres.status === 'interrupted');
  check('…et la publication CONSTATÉE est conservée', apres.publication.state === PUBLICATION.OCCURRED);
  check('…le résumé dit que la version est en ligne, et déconseille la relance à l’aveugle',
    /MISE EN LIGNE/.test(apres.summary) && /avant de relancer/i.test(apres.summary));
  check('…et le journal est marqué incomplet', apres.publication.journalComplete === false);
}

/* ════════════════════════════════════════════════════════════════════════════
   9. `createRun` — rien ne commence sans journal
   ════════════════════════════════════════════════════════════════════════════ */
section('9. Sans run durable, aucune mutation externe');
{
  // Une destination dont l'environnement viole le schéma : l'écriture durable
  // est REFUSÉE par la base elle-même — la panne la plus proche du réel.
  let refus = null;
  try {
    await runs.createRun({
      target: { targetId: 'x', name: 'x', url: 'https://x.test', host: 'x.test', environment: 'INEXISTANT' },
      operationType: 'DEPLOYMENT',
    });
  } catch (err) { refus = err; }

  check('l’ouverture du run est REFUSÉE', refus !== null);
  check('…avec un code stable', refus?.code === RECORDER_ERRORS.UNAVAILABLE);
  check('…et un message qui affirme que rien n’a bougé', /Rien n’a été modifié/.test(refus?.message ?? ''));
  check('aucun run n’a été créé', (await PanelDeploymentRun.countDocuments({ targetId: 'x' })) === 0);

  /**
   * ET LE TRAVAIL REFUSE DE COMMENCER POUR UN RUN QUI N'EXISTE PAS.
   *
   * `updateOne` sur un document absent ne lève pas : sans contrôle explicite,
   * le worker déployait pour de bon en écrivant chaque étape dans le vide.
   */
  const target = await nouvelleDestination();
  const trace = [];
  const tx = healthyVps(trace);
  const resultat = await runDeploymentJob({
    runId: crypto.randomUUID(), // jamais créé
    targetId: target.targetId,
    operationType: 'DEPLOYMENT',
    sshPassword: 'mot-de-passe-de-recette',
    engine: new HarnessEngine(tx),
    logger: { error: () => {} },
  });

  check('le travail est refusé d’emblée', resultat.startedWork === false);
  check('…avec le code d’indisponibilité du journal',
    resultat.outcome.error?.code === RECORDER_ERRORS.UNAVAILABLE);
  check('0 commande distante', tx.commands.length === 0);
  check('0 transfert', tx.uploads.length === 0);
  check('0 geste tracé, quel qu’il soit', trace.length === 0);
}

/* ════════════════════════════════════════════════════════════════════════════
   10. LE CONTRAT DU RECORDER, ÉPROUVÉ SEUL
   ════════════════════════════════════════════════════════════════════════════ */
section('10. Le contrat du journal durable, indépendamment du moteur');
{
  const target = await nouvelleDestination();
  const runId = await runs.createRun({ target, operationType: 'DEPLOYMENT' });

  // Écriture critique perdue → la barrière REFUSE.
  const avant = createDurableRecorder(runId, {
    store: magasin({ echecEtape: surEtape('ssh.connect') }),
  });
  avant.recordStep({ id: 'ssh.connect', status: 'running' });
  let leve = null;
  try { await avant.assertDurable(); } catch (err) { leve = err; }
  check('une écriture critique perdue fait REFUSER la publication', leve !== null);
  check('…avec le code d’écriture refusée', leve?.code === RECORDER_ERRORS.WRITE_FAILED);
  check('…et la cause est caviardée', !String(leve?.cause ?? '').includes(MOT_DE_PASSE_MONGO));
  check('le verdict de durabilité est PRE_PUBLICATION',
    avant.durabilityVerdict().error?.phase === DURABILITY_PHASE.PRE_PUBLICATION);

  // Écriture tardive perdue → la barrière LAISSE PASSER.
  const apres = createDurableRecorder(runId, {
    store: magasin({ echecEtape: surEtape('media.publish') }),
  });
  apres.recordStep({ id: FRONTIERE, status: 'ok' });
  apres.recordStep({ id: 'media.publish', status: 'ok' });
  await apres.drain();
  let leve2 = null;
  try { await apres.assertDurable(); } catch (err) { leve2 = err; }
  check('une écriture perdue APRÈS la frontière ne refuse plus rien', leve2 === null);
  check('…mais elle est retenue', apres.lateFailure()?.stepId === 'media.publish');
  check('…et typée POST_PUBLICATION',
    apres.durabilityVerdict().error?.phase === DURABILITY_PHASE.POST_PUBLICATION);
  check('le cliquet est définitif : la frontière franchie ne se rouvre pas',
    apres.published() === true);

  // Une ligne de journal perdue n'arrête RIEN et ne tue pas le process.
  const logs = createDurableRecorder(runId, { store: magasin({ echecLog: true }) });
  logs.recordLog('une ligne perdue', 'INFO');
  logs.recordStep({ id: 'ssh.connect', status: 'ok' });
  await logs.drain();
  check('la perte d’une ligne de journal ne refuse aucune publication',
    logs.criticalFailure() === null);
  check('…mais elle n’est pas avalée non plus', logs.logFailure() !== null);

  // Idempotence : deux fois la même étape ne produit pas deux lignes.
  const idem = createDurableRecorder(runId);
  idem.recordStep({ id: 'nginx.configure', status: 'running' });
  idem.recordStep({ id: 'nginx.configure', status: 'ok' });
  await idem.drain();
  const docIdem = await PanelDeploymentRun.findOne({ runId }).lean();
  check('une étape émise deux fois reste UNE ligne de checklist',
    docIdem.steps.filter((s) => s.id === 'nginx.configure').length === 1);
}

/* ════════════════════════════════════════════════════════════════════════════
   11. CONCURRENCE — le verrou de destination survit au nouveau journal
   ════════════════════════════════════════════════════════════════════════════ */
section('11. Deux déploiements sur la même destination : un seul gagne');
{
  const target = await nouvelleDestination();
  const premier = await runs.createRun({ target, operationType: 'DEPLOYMENT' });
  const { markDeploying } = await import('../backend/src/services/deployment/deploymentTarget.service.js');
  await markDeploying(target.targetId, premier);

  const actif = await runs.activeRunFor(target.targetId);
  check('le premier run est vu comme ACTIF', actif?.runId === premier);
  check('…ce qui est exactement ce que le contrôleur refuse en 409', actif !== null);

  const cible = await PanelDeploymentTarget.findOne({ targetId: target.targetId }).lean();
  check('le verrou de destination est posé', cible.activeDeploymentRunId === premier);

  // Le premier conclut ; la place se libère — et une seule fois.
  await runs.finalizeRun(premier, { status: 'error', summary: 'abandonné' });
  check('la destination redevient disponible après conclusion',
    (await runs.activeRunFor(target.targetId)) === null);

  const second = await runs.createRun({ target, operationType: 'DEPLOYMENT' });
  check('un second run peut alors être ouvert', typeof second === 'string' && second !== premier);
  check('…et il devient à son tour le seul actif',
    (await runs.activeRunFor(target.targetId))?.runId === second);
}

/* ════════════════════════════════════════════════════════════════════════════
   12. RUNS ORPHELINS — la fenêtre de crash, modélisée
   ════════════════════════════════════════════════════════════════════════════ */
section('12. Crash du processus : ce que le prochain démarrage a le droit de dire');
{
  const target = await nouvelleDestination();
  // La reprise est GLOBALE par nature (elle balaie tous les runs en cours). On
  // part donc d'une ardoise nette, sinon on compterait aussi les runs laissés
  // volontairement ouverts par les sections précédentes.
  await PanelDeploymentRun.deleteMany({});

  /** Crash AVANT la bascule : personne n'a rien vu changer. */
  const avant = await runs.createRun({ target, operationType: 'DEPLOYMENT' });
  await runs.recordStep(avant, { id: 'artifact.build', status: 'ok' });
  await PanelDeploymentRun.updateOne({ runId: avant }, { $set: { workerHeartbeatAt: new Date(Date.now() - 600_000).toISOString() } });

  /** Crash PENDANT la bascule : issue inconnue, et on le dit. */
  const pendant = await runs.createRun({ target, operationType: 'DEPLOYMENT' });
  await runs.recordStep(pendant, { id: FRONTIERE, status: 'running' });
  await PanelDeploymentRun.updateOne({ runId: pendant }, { $set: { workerHeartbeatAt: new Date(Date.now() - 600_000).toISOString() } });

  /** Crash APRÈS la bascule : la version est en ligne. */
  const apres = await runs.createRun({ target, operationType: 'DEPLOYMENT' });
  await runs.recordStep(apres, { id: FRONTIERE, status: 'ok' });
  await runs.recordStep(apres, { id: 'services.start', status: 'running' });
  await PanelDeploymentRun.updateOne({ runId: apres }, { $set: { workerHeartbeatAt: new Date(Date.now() - 600_000).toISOString() } });

  const nb = await runs.finalizeOrphanRuns();
  check('les trois runs orphelins sont repris', nb === 3);

  const lu = async (id) => PanelDeploymentRun.findOne({ runId: id }).lean();
  const a = await lu(avant); const p = await lu(pendant); const b = await lu(apres);

  check('crash AVANT la bascule → NOT_REACHED', a.publication.state === PUBLICATION.NOT_REACHED);
  check('…et le résumé rassure justement : le site sert sa version précédente',
    /version précédente/.test(a.summary));
  check('crash PENDANT la bascule → POSSIBLE, pas « rien publié »',
    p.publication.state === PUBLICATION.POSSIBLE);
  check('…et le résumé dit que l’issue est inconnue', /issue est inconnue|inconnue/i.test(p.summary));
  check('crash APRÈS la bascule → OCCURRED', b.publication.state === PUBLICATION.OCCURRED);
  check('…et le résumé interdit la relance à l’aveugle', /MISE EN LIGNE/.test(b.summary));
  check('les trois sont marqués journal incomplet',
    [a, p, b].every((d) => d.publication.journalComplete === false));
  check('aucun n’est déclaré réussi ni échoué',
    [a, p, b].every((d) => d.status === 'interrupted'));
  check('un second passage ne reprend plus rien', (await runs.finalizeOrphanRuns()) === 0);
}

/* ════════════════════════════════════════════════════════════════════════════
   13. LE FLUX CLIENT — une fenêtre fermée n'arrête pas un déploiement
   ════════════════════════════════════════════════════════════════════════════ */
section('13. Déconnexion du client : aucune incidence transactionnelle');
{
  const target = await nouvelleDestination();
  const runId = await runs.createRun({ target, operationType: 'DEPLOYMENT' });
  const recorder = createDurableRecorder(runId);

  // Le client lit le flux, puis s'en va. C'est une LECTURE : elle ne détient
  // rien, n'annule rien, et le worker vit dans un autre processus.
  const { readEventsSince } = runs;
  await recorder.recordStep({ id: 'deployment.initialize', status: 'ok' });
  const vu = await readEventsSince(runId, 0);
  const curseur = vu.events[vu.events.length - 1].seq;

  // « Déconnexion » : plus personne ne lit. Le journal, lui, continue.
  for (const id of [FRONTIERE, 'dependencies.install', 'services.start']) {
    await recorder.recordStep({ id, status: 'ok' });
  }
  await recorder.drain();
  await recorder.assertDurable();

  const doc = await PanelDeploymentRun.findOne({ runId }).lean();
  check('les écritures critiques ont continué sans lecteur',
    ['deployment.initialize', FRONTIERE, 'dependencies.install', 'services.start']
      .every((id) => etape(doc, id)?.status === 'ok'));
  check('la barrière n’a pas été dégradée par l’absence de client',
    recorder.criticalFailure() === null);

  const reprise = await readEventsSince(runId, curseur);
  check('un client qui revient retrouve TOUT ce qu’il a manqué',
    reprise.events.length === 3 && reprise.events.every((e) => e.seq > curseur));
  check('…sans aucun doublon', new Set(reprise.events.map((e) => e.seq)).size === reprise.events.length);

  /**
   * ET LA RAISON DE FOND : LE FLUX NE DÉTIENT RIEN.
   *
   * Il ne diffuse pas l'exécution — il RELIT un journal persisté écrit par un
   * autre processus. Une fenêtre fermée ne peut donc rien annuler, parce qu'il
   * n'y a rien à annuler de son côté. On le vérifie sur le handler lui-même :
   * la seule primitive qu'il emploie est une lecture.
   */
  const fsSync = await import('node:fs');
  const controleur = fsSync.readFileSync(
    new URL('../backend/src/controllers/deployment.controller.js', import.meta.url), 'utf8',
  );
  const handler = controleur.slice(
    controleur.indexOf('export async function runStream'),
    controleur.indexOf('export async function runs('),
  );
  check('le flux est une LECTURE : aucune écriture d’étape',
    !/recordStep|finalizeRun|appendLog|appendEvent|updateOne/.test(handler));
  check('…et la fermeture du client ne fait qu’arrêter d’écrire dans la réponse',
    /req\.on\('close'/.test(handler) && !/abort|cancel|kill/i.test(handler));
}

/* ════════════════════════════════════════════════════════════════════════════
   14. REDACTION — une panne Mongo ne raconte pas ses identifiants
   ════════════════════════════════════════════════════════════════════════════ */
section('14. Aucun secret ne sort d’une panne de persistance');
{
  const trace = [];
  const store = magasin({ echecEtape: surEtape('dependencies.install'), trace });
  const { doc } = await deploiement({ store, trace });

  const brut = JSON.stringify(doc);
  check('le mot de passe Mongo injecté n’apparaît nulle part',
    !brut.includes(MOT_DE_PASSE_MONGO));
  check('aucune URI Mongo avec identifiants ne subsiste',
    !/mongodb(\+srv)?:\/\/[^\s"'\\]*:[^\s"'\\]*@/.test(brut));
  check('la clé de chiffrement du pont n’apparaît pas',
    !brut.includes(process.env.BRIDGE_ENCRYPTION_KEY));
  check('le secret JWT n’apparaît pas', !brut.includes(process.env.JWT_SECRET));
  check('le mot de passe SSH n’apparaît pas', !brut.includes('mot-de-passe-de-recette'));
  check('…mais la cause reste exploitable (motif conservé, caviardé)',
    typeof doc.persistenceError?.reason === 'string'
    && doc.persistenceError.reason.includes('«caviardé»'));
}

await fs.rm(SOURCE, { recursive: true, force: true });
await stopMemoryMongo();
finish();
