// EXÉCUTION & PILOTAGE — Phase 3C.
//
// EXIGENCE CENTRALE DE LA PHASE : aucun test ne contacte un serveur réel.
// Les seules E/S sont MongoDB en mémoire et un Express éphémère sur
// 127.0.0.1. Tout ce qui concerne un projet distant est SIMULÉ — ce qui est
// possible précisément parce que le moteur impose la simulation par défaut
// et n'injecte le client de pont qu'en mode EXECUTION.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  check, connectTestDatabase, finish, section, setTestEnv,
  startMemoryMongo, startServer, stopMemoryMongo,
} from './helpers/harness.js';

setTestEnv();
process.env.HEARTBEAT_INTERVAL_S = '300';
await startMemoryMongo();
await connectTestDatabase();

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = path.join(root, 'backend', 'src');
const read = (...parts) => fs.readFileSync(path.join(src, ...parts), 'utf8');

const stateSvc = await import('../backend/src/services/execution/execution-state.service.js');
const policySvc = await import('../backend/src/services/execution/execution-policy.service.js');
const logSvc = await import('../backend/src/services/execution/execution-log.service.js');
const registrySvc = await import('../backend/src/services/execution/actions/registry.js');
const executorSvc = await import('../backend/src/services/execution/executor.service.js');
const planSvc = await import('../backend/src/services/execution/execution-plan.service.js');
const engine = await import('../backend/src/services/execution/execution.service.js');
const { CONTRACT_VERSION } = await import('../backend/src/bridge/bridgeContract.js');

const { STATE, TRANSITIONS } = stateSvc;
const { DENIAL, RISK } = policySvc;
const { PHASE } = logSvc;
const { MODE } = engine;

const ENGINES = { deployment: '1.1.0', duplication: '1.1.0' };
const NOW = Date.parse('2026-08-01T12:00:00.000Z');
const ago = (s) => new Date(NOW - s * 1000).toISOString();
const inDays = (d) => new Date(NOW + d * 86_400_000).toISOString();

/* ══════════════════════════════════════════════════════════════════════════ */
section('LOT 2 — Machine à états');
{
  const graph = stateSvc.validateGraph();
  check('le graphe est intègre (aucun état orphelin, inatteignable ou dupliqué)',
    graph.valid === true);
  if (!graph.valid) console.error('   ', graph.errors.join(' · '));

  check('9 états déclarés', Object.keys(STATE).length === 9);
  check('chaque transition porte une raison', TRANSITIONS.every((t) => typeof t.reason === 'string' && t.reason.length > 0));

  check('CREATED → QUEUED autorisé (aucune confirmation requise)',
    stateSvc.transition(STATE.CREATED, STATE.QUEUED).ok);
  check('CREATED → RUNNING refusé (on ne saute pas la file)',
    stateSvc.transition(STATE.CREATED, STATE.RUNNING).ok === false);
  check('QUEUED → SUCCEEDED refusé (on ne réussit pas sans avoir tourné)',
    stateSvc.transition(STATE.QUEUED, STATE.SUCCEEDED).ok === false);

  // Le choix de conception le plus discutable de la phase, donc verrouillé :
  // on n'interrompt pas une opération distante en vol.
  const running = stateSvc.transition(STATE.RUNNING, STATE.CANCELLED);
  check('RUNNING → CANCELLED refusé (annulation différée, jamais brutale)', running.ok === false);
  check('…et le refus énonce les états réellement atteignables',
    running.allowed.includes(STATE.SUCCEEDED) && running.allowed.includes(STATE.TIMEOUT));

  const terminal = stateSvc.transition(STATE.SUCCEEDED, STATE.RUNNING);
  check('un état terminal refuse toute transition', terminal.ok === false && terminal.code === 'EXEC_STATE_TERMINAL');
  check('…en le disant explicitement', /terminal/i.test(terminal.message));

  const noop = stateSvc.transition(STATE.QUEUED, STATE.QUEUED);
  check('une transition vers soi-même est refusée, pas silencieuse', noop.ok === false && noop.code === 'EXEC_TRANSITION_NOOP');

  check('un état inconnu est refusé', stateSvc.transition('INVENTÉ', STATE.QUEUED).ok === false);

  check('FAILED et TIMEOUT mènent tous deux à ROLLED_BACK',
    stateSvc.canTransition(STATE.FAILED, STATE.ROLLED_BACK)
    && stateSvc.canTransition(STATE.TIMEOUT, STATE.ROLLED_BACK));
  check('les états actifs sont exactement ceux qui occupent un verrou',
    stateSvc.ACTIVE_STATES.length === 3
    && stateSvc.isActive(STATE.RUNNING) && !stateSvc.isActive(STATE.SUCCEEDED));

  // Un graphe altéré doit être détecté : la validation n'est pas décorative.
  const broken = stateSvc.validateGraph([{ from: STATE.CREATED, to: 'NULLE_PART', reason: 'x' }]);
  check('un graphe altéré est détecté', broken.valid === false);
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('LOT 4 — Registre déclaratif des actions');
{
  const validation = registrySvc.validateRegistry();
  check('le registre est complet et cohérent', validation.valid === true);
  if (!validation.valid) console.error('   ', validation.errors.join(' · '));

  // Le NOMBRE d'actions n'est pas un invariant — le registre est fait pour
  // grandir, et une assertion sur un compte échouerait à chaque ajout
  // légitime. Ce qui est invariant : chaque type est unique.
  const declared = registrySvc.listActions();
  check('le registre déclare des actions', declared.length >= 8);
  check('aucun type dupliqué', new Set(declared.map((a) => a.type)).size === declared.length);

  const withExecutors = await Promise.all(
    registrySvc.listActions().map(async (a) => executorSvc.executorExists(a.executor)),
  );
  check('chaque action a un exécuteur existant', withExecutors.every(Boolean));

  const executors = await Promise.all(
    registrySvc.listActions().map((a) => executorSvc.loadExecutor(a.executor)),
  );
  check('chaque exécuteur expose simulate() et execute()',
    executors.every((e) => typeof e.simulate === 'function' && typeof e.execute === 'function'));

  check('un exécuteur inexistant est refusé proprement',
    (await executorSvc.executorExists('n-existe-pas')) === false);

  // La preuve du contrat d'extensibilité : deux actions, un exécuteur.
  const updEngines = registrySvc.listActions().filter((a) => a.executor === 'update-engine');
  check('deux actions partagent le même exécuteur (extensibilité par descripteur)',
    updEngines.length === 2);

  // PHASE 4 — la vérification en conditions réelles : DISCOVER_PROJECT a été
  // ajoutée après coup, sans toucher au cœur. Si l'ajout avait exigé une
  // modification du moteur, les tests du LOT 10 l'auraient signalé.
  const discover = registrySvc.getAction('DISCOVER_PROJECT');
  check('une action ajoutée en Phase 4 est présente et complète',
    discover !== null && discover.executor === 'discover-project');
  check('…et n’exige aucune confirmation (lecture seule côté projet)',
    discover.policy.requiresConfirmation === false);

  const rotate = registrySvc.getAction('ROTATE_SECRETS');
  check('ROTATE_SECRETS est coté CRITICAL', rotate.policy.risk === RISK.CRITICAL);
  check('…limité à TEST', rotate.policy.allowedEnvironments.join() === 'TEST');
  check('…exclusif et confirmé', rotate.policy.exclusive && rotate.policy.requiresConfirmation);

  const deploy = registrySvc.getAction('DEPLOY');
  check('DEPLOY exige une préparation minimale', deploy.policy.requiredReadiness === 70);
  check('…et bloque sur les dérives majeures',
    deploy.policy.blockOnDiagnostics.includes('CONTRACT_MAJOR_MISMATCH'));

  const check_ = registrySvc.getAction('CHECK_HEALTH');
  check('la seule action en lecture n’exige aucune confirmation',
    check_.policy.requiresConfirmation === false && check_.policy.risk === RISK.NONE);

  check('les recommandations 3B mènent à des actions',
    registrySvc.actionsForFutureAction('PLAN_ENGINE_UPGRADE').length === 2);

  // Registre volontairement cassé : la validation doit le voir.
  const bad = registrySvc.validateRegistry([
    { type: 'X', label: 'X', description: 'x', category: 'C', target: 'PROJECT', executor: 'e',
      policy: { requiresConfirmation: true, allowedEnvironments: [], risk: 'LOW', rollbackable: false,
        timeoutMs: 0, exclusive: false, confirmationsRequired: 0 } },
  ]);
  check('un descripteur incohérent est détecté', bad.valid === false && bad.errors.length >= 3);
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('LOT 4 — Validation des paramètres');
{
  const deploy = registrySvc.getAction('DEPLOY');
  check('paramètre obligatoire manquant → refus nommé',
    registrySvc.validateParameters(deploy, { host: 'a.fr' }).errors.some((e) => /environment/.test(e)));
  check('valeur hors énumération → refus nommé',
    registrySvc.validateParameters(deploy, { host: 'a.fr', environment: 'RECETTE' })
      .errors.some((e) => /hors des choix/.test(e)));
  check('paramètre inconnu → refus (pas d’ignorance silencieuse)',
    registrySvc.validateParameters(deploy, { host: 'a.fr', environment: 'TEST', inutile: 1 })
      .errors.some((e) => /inconnu/.test(e)));
  check('paramètres corrects → accepté',
    registrySvc.validateParameters(deploy, { host: 'a.fr', environment: 'TEST' }).valid === true);
  check('un tableau attendu et non fourni est refusé',
    registrySvc.validateParameters(registrySvc.getAction('ROTATE_SECRETS'), { secrets: 'JWT_SECRET' })
      .errors.some((e) => /tableau/i.test(e)));
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('LOT 3 — Politiques : tout refus est expliqué');
{
  const record = {
    projectId: 'p-1', projectKey: 'k', projectName: 'Projet',
    pairing: { status: 'PAIRED' },
    runtime: { environment: 'PROD', publicBackendUrl: 'https://api.exemple.fr' },
    manifest: { manifestVersion: '1.0.0' },
  };
  const nominal = {
    record,
    project: { environment: 'PROD' },
    health: { liveness: 'ONLINE' },
    diagnosis: {
      readiness: { score: 95 },
      compatibility: { blocking: false, verdict: 'COMPATIBLE', reason: 'Tout concorde.', axes: [{ axis: 'bridge', verdict: 'COMPATIBLE', reason: 'ok' }] },
      diagnostics: [],
    },
    parameters: { host: 'a.fr', environment: 'PROD' },
    activeExecutions: [],
  };

  const okDeploy = policySvc.evaluatePolicy(registrySvc.getAction('DEPLOY'), nominal);
  check('situation nominale : DEPLOY autorisé', okDeploy.ok === true);
  check('…avec le détail de chaque contrôle', okDeploy.checks.length >= 6);

  // ── La règle de la phase : jamais « refusée », toujours « refusée parce que »
  const scenarios = [
    ['environnement interdit', registrySvc.getAction('ROTATE_SECRETS'),
      { ...nominal, parameters: { secrets: ['JWT_SECRET'] } }, DENIAL.ENVIRONMENT_FORBIDDEN, /PROD/],
    ['préparation insuffisante', registrySvc.getAction('DEPLOY'),
      { ...nominal, diagnosis: { ...nominal.diagnosis, readiness: { score: 42 } } }, DENIAL.READINESS_TOO_LOW, /42 %/],
    ['prérequis non satisfait', registrySvc.getAction('DEPLOY'),
      { ...nominal, record: { ...record, pairing: { status: 'PENDING' } } }, DENIAL.PREREQUISITE_UNMET, /appairé/],
    ['incompatibilité bloquante', registrySvc.getAction('DEPLOY'),
      { ...nominal, diagnosis: { ...nominal.diagnosis, compatibility: { blocking: true, verdict: 'INCOMPATIBLE', reason: 'MAJEUR différent.', axes: [] } } },
      DENIAL.COMPATIBILITY_BLOCKING, /MAJEUR/],
    ['diagnostic interdisant l’action', registrySvc.getAction('DEPLOY'),
      { ...nominal, diagnosis: { ...nominal.diagnosis, diagnostics: [{ ruleId: 'CONTRACT_MAJOR_MISMATCH', title: 'Contrat incompatible', justification: 'MAJEUR 1 contre 2' }] } },
      DENIAL.BLOCKING_DIAGNOSTIC, /Contrat incompatible/],
    ['exclusivité occupée', registrySvc.getAction('DEPLOY'),
      { ...nominal, activeExecutions: [{ id: 'x', type: 'DEPLOY', projectId: 'p-1', state: 'RUNNING', createdAt: ago(60) }] },
      DENIAL.EXCLUSIVITY_CONFLICT, /déjà en cours/],
  ];

  for (const [label, action, context, code, evidence] of scenarios) {
    const result = policySvc.evaluatePolicy(action, context);
    check(`${label} → refusé`, result.ok === false);
    check(`  …avec le code ${code}`, result.denials.some((d) => d.code === code));
    check('  …en disant « refusée parce que… »', result.denials.every((d) => /refusée parce qu/i.test(d.message)));
    check('  …et en citant le fait constaté', evidence.test(result.summary));
  }

  // Toutes les causes, pas la première : sinon on corrige en aveugle.
  const multiple = policySvc.evaluatePolicy(registrySvc.getAction('DEPLOY'), {
    ...nominal,
    record: { ...record, pairing: { status: 'PENDING' }, manifest: null },
    diagnosis: { ...nominal.diagnosis, readiness: { score: 10 } },
  });
  check('un refus multiple énonce TOUTES les causes', multiple.denials.length >= 3);
  check('…toutes présentes dans le résumé',
    multiple.denials.every((d) => multiple.summary.includes(d.message)));

  const noEnv = policySvc.evaluatePolicy(registrySvc.getAction('DEPLOY'), {
    ...nominal, project: {}, record: { ...record, runtime: { publicBackendUrl: 'https://x.fr' } },
  });
  check('un environnement inconnu est refusé, pas supposé',
    noEnv.denials.some((d) => d.code === DENIAL.ENVIRONMENT_FORBIDDEN));

  check('confirmationRequirement lit la politique, pas une constante',
    policySvc.confirmationRequirement(registrySvc.getAction('ROTATE_SECRETS')).required === true
    && policySvc.confirmationRequirement(registrySvc.getAction('CHECK_HEALTH')).required === false);
  check('les risques sont ordonnés', policySvc.isRiskier(RISK.CRITICAL, RISK.LOW));
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('LOT 7 — Journal auditable et masquage des secrets');
{
  const masked = logSvc.redact({
    JWT_SECRET: 'valeur-en-clair',
    bridgeToken: 'abcdef',
    password: 'motdepasse',
    MONGODB_URI: 'mongodb://user:pass@host/db',
    innocent: 'valeur visible',
    nested: { apiKey: 'xyz', ok: 1 },
    liste: [{ credential: 'z' }],
  });
  check('les clés secrètes sont masquées par leur NOM',
    masked.JWT_SECRET === '«redacted»' && masked.bridgeToken === '«redacted»'
    && masked.password === '«redacted»' && masked.MONGODB_URI === '«redacted»');
  check('le masquage est récursif', masked.nested.apiKey === '«redacted»' && masked.liste[0].credential === '«redacted»');
  check('ce qui n’est pas secret reste lisible', masked.innocent === 'valeur visible' && masked.nested.ok === 1);

  const byShape = logSvc.redact({
    trace: 'connexion vers mongodb://root:s3cr3t@10.0.0.1:27017/panel établie',
    jeton: 'Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTYifQ.abcdefghijklmnop',
  });
  check('une valeur sensible est masquée même sous une clé anodine',
    !byShape.trace.includes('s3cr3t') && !byShape.jeton.includes('eyJhbGciOiJIUzI1NiJ9'));

  const log = logSvc.createLog();
  log.info(PHASE.CREATION, 'créée');
  log.info(PHASE.VALIDATION, 'validée');
  log.info(PHASE.START, 'démarrée');
  const audit = logSvc.auditLog(log.toArray(), { finalState: STATE.SUCCEEDED });
  check('un journal sans fin est signalé', audit.complete === false && audit.problems.some((p) => /fin/.test(p)));

  log.info(PHASE.END, 'terminée');
  check('un journal complet est validé',
    logSvc.auditLog(log.toArray(), { finalState: STATE.SUCCEEDED }).complete === true);

  const outOfOrder = [
    { at: '2026-08-01T12:00:01.000Z', phase: PHASE.CREATION, message: 'a', level: 'INFO' },
    { at: '2026-08-01T12:00:00.000Z', phase: PHASE.VALIDATION, message: 'b', level: 'INFO' },
    { at: '2026-08-01T12:00:02.000Z', phase: PHASE.END, message: 'c', level: 'INFO' },
  ];
  check('un journal dans le désordre est signalé',
    logSvc.auditLog(outOfOrder).problems.some((p) => /antérieure/.test(p)));
  check('une phase inconnue est signalée',
    logSvc.auditLog([{ at: ago(1), phase: 'BIDON', message: 'x', level: 'INFO' }])
      .problems.some((p) => /phase inconnue/.test(p)));
  check('le rendu texte est lisible et horodaté',
    logSvc.renderLog(log.toArray()).split('\n').length === 4);
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('LOT 9 — Plans de simulation dérivés des moteurs réels');
{
  const deployPlan = planSvc.buildDeploymentPlan({ host: 'test.exemple.fr', environment: 'TEST' });
  check('le plan de déploiement couvre toutes les étapes du pipeline du moteur',
    planSvc.PIPELINE_STEPS.every((step) => deployPlan.some((p) => p.step === step)));
  check('…et chaque étape est décrite', deployPlan.every((p) => typeof p.description === 'string' && p.description.length > 0));

  const rollbackPlan = planSvc.buildRollbackPlan({ releaseId: '2026-07-01' });
  check('le plan de rollback vérifie l’intégrité AVANT la bascule',
    rollbackPlan.findIndex((p) => p.step === 'rollback.verify')
      < rollbackPlan.findIndex((p) => p.step === 'rollback.activate'));
  check('…et prévoit la restauration automatique',
    rollbackPlan.some((p) => p.step === 'rollback.restore'));
  check('…en nommant la release demandée',
    rollbackPlan.some((p) => p.description.includes('2026-07-01')));

  const migration = planSvc.planEngineMigration({ fromVersion: '1.0.0', toVersion: '1.1.0' });
  check('le plan de migration est délégué au catalogue du moteur',
    Array.isArray(migration.migrations) && Array.isArray(migration.pending));
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('LOT 10 — Le cœur ne connaît aucune action en particulier');
{
  const types = registrySvc.listActions().map((a) => a.type);
  const core = [
    ['execution.service.js', read('services', 'execution', 'execution.service.js')],
    ['executor.service.js', read('services', 'execution', 'executor.service.js')],
    ['execution-policy.service.js', read('services', 'execution', 'execution-policy.service.js')],
    ['execution-state.service.js', read('services', 'execution', 'execution-state.service.js')],
    ['execution-log.service.js', read('services', 'execution', 'execution-log.service.js')],
    ['execution.controller.js', read('controllers', 'execution.controller.js')],
    ['execution.routes.js', read('routes', 'execution.routes.js')],
  ];

  for (const [name, source] of core) {
    // Les commentaires ont le droit d'illustrer ; le CODE, non.
    const code = source.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
    const cited = types.filter((t) => code.includes(t));
    check(`${name} ne cite aucun identifiant d’action`, cited.length === 0);
    if (cited.length) console.error('   cite :', cited.join(', '));
  }

  const engineSrc = read('services', 'execution', 'execution.service.js')
    .replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
  check('le moteur ne contient aucun switch sur un type d’action', !/switch\s*\(\s*\w*\.?type/.test(engineSrc));

  // Le contrôleur est un traducteur HTTP, rien de plus.
  const controllerSrc = read('controllers', 'execution.controller.js');
  check('le contrôleur n’importe ni exécuteur, ni registre, ni client de pont',
    !/actions\/registry|executors\/|ProjectBridgeClient/.test(controllerSrc));

  // Un exécuteur ne doit jamais fabriquer son propre canal vers un projet.
  const executorsDir = path.join(src, 'services', 'execution', 'executors');
  for (const file of fs.readdirSync(executorsDir)) {
    const source = fs.readFileSync(path.join(executorsDir, file), 'utf8');
    check(`${file} n’instancie aucun client réseau`,
      !/new ProjectBridgeClient|fetch\s*\(|axios/.test(source));
  }
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('LOT 1/9 — Cycle de vie complet, en simulation');
{
  const registry = await import('../backend/src/services/registry/projectRegistry.service.js');
  const { registryStore } = await import('../backend/src/services/registry/registryStore.js');
  const PanelExecution = (await import('../backend/src/models/PanelExecution.model.js')).default;
  await registryStore.clear();
  await PanelExecution.deleteMany({});

  const declared = await registry.declareProject({ publicBackendUrl: 'https://projet-pilote.test', projectName: 'Projet Pilote' });
  const record = declared.record;
  record.pairing.status = 'PAIRED';
  record.pairing.pairedAt = ago(86_400);
  record.runtime = {
    ...record.runtime,
    environment: 'TEST',
    softwareVersion: '1.0.0',
    contractVersion: CONTRACT_VERSION,
    publicBackendUrl: 'https://api.pilote.test',
    lastHeartbeatAt: new Date().toISOString(),
    lastHealth: { status: 'OK', details: null },
    components: { frontend: 'OK', mongo: 'OK', ssl: 'OK', dns: 'OK' },
    engines: { ...ENGINES },
    certificate: { expiresAt: inDays(90) },
  };
  record.manifest = {
    manifestVersion: '1.0.0',
    project: { key: 'projet-pilote', name: 'Projet Pilote', environment: 'TEST', softwareVersion: '1.0.0' },
    bridge: { contractVersion: CONTRACT_VERSION, projectBridgeBasePath: '/api/project-bridge/v1' },
    contracts: { panelBridge: CONTRACT_VERSION, projectBridge: CONTRACT_VERSION },
    sync: { supportedEntityTypes: ['DIAGNOSTIC'], operations: [] },
    modules: [{ id: 'vitrine', title: 'Vitrine', status: 'ACTIVE' }],
    source: 'BRIDGE',
  };
  await registryStore.save(record);
  const projectId = record.projectId;
  const initiator = { userId: 'u-1', userEmail: 'dev@panel.test', role: 'DEV' };

  // ── Préparation : rien n'est créé, tout est expliqué -------------------
  const prep = await engine.prepareAction({ type: 'CHECK_HEALTH', projectId });
  check('prepareAction ne crée aucune exécution', (await PanelExecution.countDocuments()) === 0);
  check('…et annonce le mode par défaut', prep.modes.default === MODE.SIMULATION);
  check('…avec le détail des contrôles', prep.checks.length > 0 && typeof prep.reason === 'string');

  const prepDeploy = await engine.prepareAction({ type: 'DEPLOY', projectId, parameters: {} });
  check('une préparation aux paramètres manquants est refusée', prepDeploy.allowed === false);
  check('…en nommant le paramètre manquant', /host/.test(prepDeploy.reason));

  // ── Simulation d'une action sans confirmation ---------------------------
  const sim = await engine.createExecution({ type: 'CHECK_HEALTH', projectId, initiator });
  check('le mode par défaut est SIMULATION', sim.mode === MODE.SIMULATION);
  check('une simulation aboutit sans confirmation', sim.state === STATE.SUCCEEDED);
  check('…en produisant un plan réel', Array.isArray(sim.result.plan) && sim.result.plan.length === 3);
  check('…et un résumé de ce qui SERAIT fait', /Interrogerait/.test(sim.result.summary));
  check('…sans jamais contacter le projet', sim.result.mode === MODE.SIMULATION && sim.error === null);

  const historyStates = sim.stateHistory.map((h) => h.to);
  check('l’historique d’états est complet et ordonné',
    historyStates.join(' → ') === `${STATE.CREATED} → ${STATE.QUEUED} → ${STATE.RUNNING} → ${STATE.SUCCEEDED}`);
  check('…et chaque transition porte sa raison', sim.stateHistory.every((h) => h.reason));

  const auditSim = logSvc.auditLog(sim.log, { finalState: sim.state });
  check('le journal de la simulation est auditable', auditSim.complete === true);
  check('…et couvre création, validation, démarrage, résultat et fin',
    [PHASE.CREATION, PHASE.VALIDATION, PHASE.START, PHASE.RESULT, PHASE.END]
      .every((p) => auditSim.phases.includes(p)));
  check('l’initiateur est enregistré', sim.initiator.userEmail === 'dev@panel.test');
  check('la durée est mesurée', typeof sim.durationMs === 'number');

  // ── Simulation d'une action à risque : le plan est calculé pour de vrai --
  const simDeploy = await engine.createExecution({
    type: 'DEPLOY', projectId, parameters: { host: 'pilote.test', environment: 'TEST' }, initiator,
  });
  check('une simulation de DEPLOY ne demande AUCUNE confirmation',
    simDeploy.state === STATE.SUCCEEDED && simDeploy.confirmations.length === 0);
  check('…et produit le plan complet du moteur de déploiement',
    simDeploy.result.plan.length === planSvc.PIPELINE_STEPS.length + 1);

  // ── La simulation reste possible même quand l'exécution est refusée -----
  const simRotate = await engine.createExecution({
    type: 'ROTATE_SECRETS', projectId, parameters: { secrets: ['BRIDGE_ENCRYPTION_KEY'] }, initiator,
  });
  check('une action à politique refusante reste simulable', simRotate.state === STATE.SUCCEEDED);
  check('…et déclare ses CONSÉQUENCES avant toute confirmation',
    /ré-appairés/.test(JSON.stringify(simRotate.result.consequences)));
  check('…sans jamais faire apparaître une valeur de secret',
    !/BRIDGE_ENCRYPTION_KEY=|[0-9a-f]{64}/.test(JSON.stringify(simRotate)));

  // ── Exécution réelle : confirmation exigée ------------------------------
  const real = await engine.createExecution({
    type: 'DEPLOY', projectId, parameters: { host: 'pilote.test', environment: 'TEST' },
    mode: MODE.EXECUTION, initiator,
  });
  check('une exécution réelle à risque attend une confirmation', real.state === STATE.WAITING_CONFIRMATION);
  check('…avec le nombre requis annoncé', real.confirmationsRequired === 1);

  const rejected = await engine.confirmExecution(real.executionId, {
    decision: 'REJECTED', userId: 'u-1', userEmail: 'dev@panel.test', comment: 'pas maintenant',
  });
  check('un refus de confirmation annule l’exécution', rejected.state === STATE.CANCELLED);
  check('…en conservant la décision et son commentaire',
    rejected.confirmations[0].decision === 'REJECTED' && rejected.confirmations[0].comment === 'pas maintenant');

  // ── Approbation → l'exécution part et refuse honnêtement ---------------
  const approvedRun = await engine.createExecution({
    type: 'DEPLOY', projectId, parameters: { host: 'pilote.test', environment: 'TEST' },
    mode: MODE.EXECUTION, initiator,
  });
  const done = await engine.confirmExecution(approvedRun.executionId, {
    decision: 'APPROVED', userId: 'u-1', userEmail: 'dev@panel.test',
  });
  check('une confirmation obtenue met l’exécution en file puis la lance',
    done.stateHistory.map((h) => h.to).includes(STATE.RUNNING));
  check('l’exécution réelle échoue plutôt que de prétendre agir', done.state === STATE.FAILED);
  check('…en nommant précisément ce qui manque',
    /parce que/.test(done.error.message) && /identifiants|SSH/i.test(done.error.message));
  check('…et le journal reste complet', logSvc.auditLog(done.log, { finalState: done.state }).complete === true);

  check('une seconde confirmation sur une exécution close est refusée',
    await rejects(() => engine.confirmExecution(approvedRun.executionId, { decision: 'APPROVED', userId: 'u-2' }),
      'PANEL_EXECUTION_NOT_AWAITING_CONFIRMATION'));

  // ── LOT 6 — Le système est PRÊT pour la double validation ---------------
  // Rien ne l'exige aujourd'hui (toutes les actions demandent 1 confirmation),
  // mais le mécanisme est complet : on le prouve en portant l'exigence à 2,
  // exactement ce que fera un futur descripteur. Aucun code du moteur ne
  // change dans ce scénario.
  {
    const twice = await engine.createExecution({
      type: 'UPDATE_BRIDGE', projectId, parameters: {}, mode: MODE.EXECUTION, initiator,
    });
    check('une action à confirmer attend bien', twice.state === STATE.WAITING_CONFIRMATION);

    const doc = await PanelExecution.findOne({ executionId: twice.executionId });
    doc.confirmationsRequired = 2;
    await doc.save();

    const first = await engine.confirmExecution(twice.executionId, {
      decision: 'APPROVED', userId: 'u-9', userEmail: 'a@panel.test',
    });
    check('une première approbation sur deux ne lance rien',
      first.state === STATE.WAITING_CONFIRMATION);
    check('…et l’attente est journalisée', first.log.some((e) => /1\/2/.test(e.message)));

    check('le même utilisateur ne peut pas approuver deux fois',
      await rejects(() => engine.confirmExecution(twice.executionId, { decision: 'APPROVED', userId: 'u-9' }),
        'PANEL_EXECUTION_ALREADY_CONFIRMED'));

    const second = await engine.confirmExecution(twice.executionId, {
      decision: 'APPROVED', userId: 'u-10', userEmail: 'b@panel.test',
    });
    check('la seconde approbation, par un autre utilisateur, lance l’exécution',
      second.stateHistory.map((h) => h.to).includes(STATE.RUNNING));
    check('…et les deux approbateurs sont tracés',
      second.confirmations.map((c) => c.userId).join() === 'u-9,u-10');
  }

  // ── Refus à la création : validation bloquante --------------------------
  // ROTATE_SECRETS est autorisée en TEST : pour éprouver un refus réel, il
  // faut une cible en PROD — l'interdiction d'environnement est justement la
  // politique la plus tranchante du registre.
  const prod = (await registry.declareProject({ publicBackendUrl: 'https://projet-prod.test', projectName: 'Projet Prod' })).record;
  prod.pairing.status = 'PAIRED';
  prod.runtime = { ...record.runtime, environment: 'PROD' };
  prod.manifest = { ...record.manifest, project: { ...record.manifest.project, key: 'projet-prod', environment: 'PROD' } };
  await registryStore.save(prod);

  const refused = await engine.createExecution({
    type: 'ROTATE_SECRETS', projectId: prod.projectId, parameters: { secrets: ['JWT_SECRET'] },
    mode: MODE.EXECUTION, initiator,
  });
  check('une action refusée par les politiques n’atteint jamais RUNNING',
    refused.state === STATE.FAILED && !refused.stateHistory.some((h) => h.to === STATE.RUNNING));
  check('…et n’a jamais demandé de confirmation non plus',
    !refused.stateHistory.some((h) => h.to === STATE.WAITING_CONFIRMATION));
  check('…le refus est expliqué', /refusée parce qu/i.test(refused.validation.summary));
  check('…en citant l’environnement constaté', /PROD/.test(refused.validation.summary));
  check('…avec la trace de tous les contrôles', refused.validation.checks.length > 0);

  // La même action, en simulation, reste consultable : comprendre ce qui
  // serait fait aide à décider s'il faut lever le blocage.
  const refusedSim = await engine.createExecution({
    type: 'ROTATE_SECRETS', projectId: prod.projectId, parameters: { secrets: ['JWT_SECRET'] }, initiator,
  });
  check('…mais reste simulable pour comprendre', refusedSim.state === STATE.SUCCEEDED);
  check('…la simulation rappelant tout de même le refus',
    refusedSim.validation.denials.some((d) => d.code === DENIAL.ENVIRONMENT_FORBIDDEN));

  const badParams = await engine.createExecution({
    type: 'DEPLOY', projectId, parameters: { host: 'x.fr' }, initiator,
  });
  check('des paramètres invalides bloquent même en simulation',
    badParams.state === STATE.FAILED && /environment/.test(badParams.error.message));

  // ── Annulation ---------------------------------------------------------
  const toCancel = await engine.createExecution({
    type: 'ROLLBACK', projectId, parameters: { releaseId: '2026-07-01' },
    mode: MODE.EXECUTION, initiator,
  });
  const cancelled = await engine.cancelExecution(toCancel.executionId, { userId: 'u-1', userEmail: 'dev@panel.test' });
  check('une exécution en attente s’annule', cancelled.state === STATE.CANCELLED);
  check('…avec la raison journalisée', cancelled.stateHistory.at(-1).reason.includes('dev@panel.test'));

  {
    // Annulation d'une exécution EN COURS : différée, jamais brutale.
    const doc = await PanelExecution.findOne({ executionId: sim.executionId });
    doc.state = STATE.RUNNING;
    await doc.save();
    const pending = await engine.cancelExecution(sim.executionId, { userId: 'u-1' });
    check('annuler une exécution en cours pose un drapeau au lieu d’interrompre',
      pending.state === STATE.RUNNING && pending.cancellationRequested === true);
    check('…et le dit dans le journal',
      pending.log.some((e) => /prochaine étape/.test(e.message)));
    doc.state = STATE.SUCCEEDED;
    doc.cancellationRequested = false;
    await doc.save();
  }

  // ── Exclusivité : la base fait foi --------------------------------------
  {
    const blocker = await PanelExecution.create({
      executionId: 'lock-1', type: 'DEPLOY', projectId, projectName: 'Projet Pilote',
      environment: 'TEST', mode: MODE.EXECUTION, parameters: {},
      initiator: { userId: 'u-2' }, state: STATE.RUNNING, createdAt: ago(60),
    });
    const conflict = await engine.createExecution({
      type: 'DEPLOY', projectId, parameters: { host: 'pilote.test', environment: 'TEST' },
      mode: MODE.EXECUTION, initiator,
    });
    check('une seconde action exclusive sur la même cible est refusée',
      conflict.state === STATE.FAILED
      && conflict.validation.denials.some((d) => d.code === DENIAL.EXCLUSIVITY_CONFLICT));
    check('…en nommant l’exécution qui occupe le verrou', /déjà en cours/.test(conflict.validation.summary));
    await blocker.deleteOne();
  }

  // ── Timeout : le délai vient de la politique ----------------------------
  {
    const action = registrySvc.getAction('CHECK_HEALTH');
    const slow = await engine.createExecution({ type: 'CHECK_HEALTH', projectId, initiator });
    const doc = await PanelExecution.findOne({ executionId: slow.executionId });
    check('le délai persisté est celui déclaré par l’action', doc.timeoutMs === action.policy.timeoutMs);

    // On remet l'exécution en file avec un délai d'1 ms et un exécuteur lent :
    // aucun serveur n'est contacté, seul le chronomètre est éprouvé.
    doc.state = STATE.QUEUED;
    doc.timeoutMs = 1;
    doc.stateHistory = [{ at: ago(10), from: null, to: STATE.QUEUED, reason: 'remise en file (test)' }];
    doc.startedAt = null;
    doc.finishedAt = null;
    await doc.save();

    const executors = await import('../backend/src/services/execution/executor.service.js');
    const original = executors.simulate;
    const patched = await executorSvc.loadExecutor('check-health');
    const trueSimulate = patched.simulate;
    patched.simulate = async (ctx) => {
      await new Promise((resolve, reject) => {
        const t = setTimeout(resolve, 50);
        ctx.signal.addEventListener('abort', () => { clearTimeout(t); reject(new Error('interrompu')); });
      });
      return trueSimulate(ctx);
    };
    const timedOut = await engine.runQueued(slow.executionId);
    patched.simulate = trueSimulate;
    void original;

    check('un dépassement de délai mène à TIMEOUT, pas à FAILED', timedOut.state === STATE.TIMEOUT);
    check('…en expliquant que c’est le délai déclaré qui a été dépassé',
      /délai maximal/.test(timedOut.error.message));
    check('…et le journal reste complet', logSvc.auditLog(timedOut.log, { finalState: timedOut.state }).complete === true);
  }

  // ── Historisation -------------------------------------------------------
  const history = await engine.listExecutions({ projectId });
  check('l’historique est trié du plus récent au plus ancien',
    history.length > 5 && history.every((h, i) => i === 0 || h.createdAt <= history[i - 1].createdAt));
  check('chaque ligne d’historique porte état, mode, durée et initiateur',
    history.every((h) => h.state && h.mode && h.initiator !== undefined));
  check('l’historique se filtre par état',
    (await engine.listExecutions({ projectId, state: STATE.FAILED })).every((h) => h.state === STATE.FAILED));

  const stats = await engine.executionStats();
  check('les statistiques couvrent tous les états', Object.keys(stats.byState).length === 9);
  check('…et comptent ce qui est réellement en base', stats.total === await PanelExecution.countDocuments());

  check('une exécution inconnue → erreur nommée',
    await rejects(() => engine.getExecution('inexistant'), 'PANEL_EXECUTION_NOT_FOUND'));
  check('une action inconnue → erreur nommée',
    await rejects(() => engine.createExecution({ type: 'INVENTÉE', initiator }), 'PANEL_ACTION_UNKNOWN'));
  check('une exécution sans initiateur est refusée',
    await rejects(() => engine.createExecution({ type: 'CHECK_HEALTH', projectId, initiator: {} }),
      'PANEL_EXECUTION_NO_INITIATOR'));
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('Surface /api/executions');
{
  const { registryStore } = await import('../backend/src/services/registry/registryStore.js');
  const registry = await import('../backend/src/services/registry/projectRegistry.service.js');
  const { seedFromEnv } = await import('../backend/src/services/auth/panelUsers.service.js');
  const PanelExecution = (await import('../backend/src/models/PanelExecution.model.js')).default;
  await registryStore.clear();
  await PanelExecution.deleteMany({});

  const declared = await registry.declareProject({ publicBackendUrl: 'https://projet-api.test', projectName: 'Projet API' });
  const record = declared.record;
  record.pairing.status = 'PAIRED';
  record.runtime = { ...record.runtime, environment: 'TEST', publicBackendUrl: 'https://api.api.test' };
  await registryStore.save(record);
  await seedFromEnv();

  const { createApp } = await import('../backend/src/app.js');
  const { call, close } = await startServer(createApp());

  check('le pilotage est inaccessible sans JWT', (await call('GET', '/api/executions')).status === 401);
  check('…y compris en écriture', (await call('POST', '/api/executions', { body: {} })).status === 401);

  const login = await call('POST', '/api/auth/login', {
    body: { email: 'dev@panel.test', password: 'motdepasse-test' },
  });
  const auth = { authorization: `Bearer ${login.json.data.token}` };
  const id = declared.record.projectId;

  const actions = await call('GET', '/api/executions/actions', { headers: auth });
  check('GET /actions expose le catalogue en entier',
    actions.status === 200
    && actions.json.data.items.length === registrySvc.listActions().length);
  check('…sans exposer les fonctions de prérequis',
    actions.json.data.items.every((a) => a.policy.prerequisites.every((p) => p.id && p.label && !p.check)));

  const prepare = await call('POST', '/api/executions/prepare', {
    headers: auth, body: { type: 'CHECK_HEALTH', projectId: id },
  });
  check('POST /prepare évalue sans créer', prepare.status === 200 && await PanelExecution.countDocuments() === 0);
  check('…et annonce toujours une raison', typeof prepare.json.data.reason === 'string');

  const created = await call('POST', '/api/executions', {
    headers: auth, body: { type: 'CHECK_HEALTH', projectId: id },
  });
  check('POST / crée une exécution', created.status === 201);
  check('…en mode SIMULATION par défaut', created.json.data.mode === MODE.SIMULATION);
  check('…avec l’initiateur pris du jeton, jamais du corps',
    created.json.data.initiator.userEmail === 'dev@panel.test');

  const executionId = created.json.data.executionId;
  const detail = await call('GET', `/api/executions/${executionId}`, { headers: auth });
  check('GET /:id restitue le détail complet, journal compris',
    detail.status === 200 && Array.isArray(detail.json.data.log) && detail.json.data.log.length > 0);

  const list = await call('GET', `/api/executions?projectId=${id}`, { headers: auth });
  check('GET / filtre par projet', list.status === 200 && list.json.data.items.length === 1);
  check('GET /queue liste ce qui est actif',
    (await call('GET', '/api/executions/queue', { headers: auth })).json.data.items.length === 0);
  check('GET /stats compte le parc d’exécutions',
    (await call('GET', '/api/executions/stats', { headers: auth })).json.data.total === 1);

  const badMode = await call('POST', '/api/executions', {
    headers: auth, body: { type: 'CHECK_HEALTH', projectId: id, mode: 'RÉEL' },
  });
  check('un mode inventé est refusé en le nommant',
    badMode.status === 400 && /RÉEL/.test(badMode.json.message));

  const noType = await call('POST', '/api/executions', { headers: auth, body: {} });
  check('une demande sans type est refusée', noType.status === 400);

  const badDecision = await call('POST', `/api/executions/${executionId}/confirm`, {
    headers: auth, body: { decision: 'PEUT-ÊTRE' },
  });
  check('une décision de confirmation invalide est refusée', badDecision.status === 400);

  const lateConfirm = await call('POST', `/api/executions/${executionId}/confirm`, {
    headers: auth, body: { decision: 'APPROVED' },
  });
  check('confirmer une exécution close → 409 expliqué',
    lateConfirm.status === 409 && /état SUCCEEDED/.test(lateConfirm.json.message));

  check('exécution inconnue → 404 propre',
    (await call('GET', '/api/executions/inexistante', { headers: auth })).status === 404);

  for (const method of ['PUT', 'PATCH', 'DELETE']) {
    const res = await call(method, '/api/executions', { headers: auth, body: {} });
    check(`${method} /api/executions non exposé`, res.status === 404);
  }

  await close();
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('LOT 8 — L’interface ne contourne pas le moteur');
{
  const front = path.join(root, 'frontend', 'src');
  const apiClient = fs.readFileSync(path.join(front, 'lib', 'api.ts'), 'utf8');

  // Le client ne peut appeler QUE les routes du moteur : pas de raccourci
  // vers une hypothétique route d'exécution directe.
  // Les chemins sont parfois construits par gabarit : on normalise les
  // interpolations en « :id » et on coupe à la première requête ou expression.
  const executionCalls = [...apiClient.matchAll(/['"`](\/api\/executions[^'"`\n]*)/g)]
    .map((m) => m[1].replace(/\$\{[^}$]*\}/g, ':id').split(/[?$]/)[0]);
  const known = ['/api/executions', '/api/executions/actions', '/api/executions/stats',
    '/api/executions/queue', '/api/executions/prepare', '/api/executions/:id',
    '/api/executions/:id/confirm', '/api/executions/:id/cancel'];
  const unknownCalls = executionCalls.filter((route) => !known.includes(route));
  check(`le client n’appelle que les routes du moteur${unknownCalls.length ? ` — ${unknownCalls}` : ''}`,
    unknownCalls.length === 0);

  // Le mode par défaut du client doit coïncider avec celui du backend :
  // deux défauts divergents, et « simulation par défaut » ne veut plus rien dire.
  check('le client impose SIMULATION comme mode par défaut',
    /mode:\s*'SIMULATION',\s*\.\.\.body/.test(apiClient));

  const pages = fs.readdirSync(path.join(front, 'pages'))
    .filter((f) => /Action|Execution/.test(f));
  check('les écrans de pilotage existent', pages.length === 3);

  for (const file of pages) {
    const source = fs.readFileSync(path.join(front, 'pages', file), 'utf8');
    check(`${file} ne parle jamais directement à un projet`, !/fetch\s*\(/.test(source));
  }

  // Les actions viennent du catalogue servi par le backend : si l'interface
  // en codait une en dur, elle divergerait au premier ajout.
  const workflow = fs.readFileSync(path.join(front, 'pages', 'ProjectActionsPage.tsx'), 'utf8');
  const hardcoded = registrySvc.listActions().map((a) => a.type).filter((t) => workflow.includes(t));
  check(`le workflow ne code aucune action en dur${hardcoded.length ? ` — ${hardcoded}` : ''}`,
    hardcoded.length === 0);

  // La recommandation 3B ouvre le workflow ; elle ne déclenche rien.
  const diagPage = fs.readFileSync(path.join(front, 'pages', 'ProjectDiagnosticPage.tsx'), 'utf8');
  check('la recommandation mène au workflow, pas à une exécution',
    /\/actions\?futureAction=/.test(diagPage) && !/api\.create|executions\.create/.test(diagPage));
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('Aucun test n’a contacté de serveur réel');
{
  const testSource = fs.readFileSync(fileURLToPath(import.meta.url), 'utf8')
    .replace(/\/\/.*$/gm, '');
  const external = testSource.match(/https?:\/\/(?!127\.0\.0\.1|localhost)[\w.-]+/g) ?? [];
  const suspicious = external.filter((url) => !/\.test\b|exemple\.|example\./.test(url));
  check('aucune URL réelle n’apparaît dans ce fichier', suspicious.length === 0);
  if (suspicious.length) console.error('   ', suspicious.join(', '));
}

async function rejects(fn, code) {
  try {
    await fn();
    return false;
  } catch (err) {
    return err?.code === code;
  }
}

await stopMemoryMongo();
finish();
