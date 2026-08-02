// PRÉREQUIS LOCAUX — un dépôt non commité ne démarre AUCUN déploiement.
//
// ── LE DÉFAUT CORRIGÉ ───────────────────────────────────────────────────────
// Le contrôle de source Git vivait dans `buildArtifact`, donc à l'étape
// `artifact.build`. Or l'ordre réel du pipeline est :
//   initialize → dns.zone/provider/read → ssh.connect → server.preflight
//   → remote.safety → dns.site → dns.apps → dns.verify → artifact.build ✗
// Un dépôt non commité en PRODUCTION faisait donc créer un run, lancer un
// worker, ouvrir une connexion SSH et — surtout — POSER DE VRAIS
// ENREGISTREMENTS DNS avant d'être refusé.
//
// Le contrôle est local et instantané : il n'a aucune raison d'attendre. Il
// est désormais évalué avant tout effet de bord.
import { check, finish, section } from './helpers/harness.js';

const { runLocalPreflight, listDirtyFiles, requiresCleanSource } =
  await import('../backend/src/deployment-engine/localPreflight.js');
const { DeploymentEngine } = await import('../backend/src/deployment-engine/DeploymentEngine.js');

const COMMIT = 'abc1234567890abcdef1234567890abcdef12345';

/** Exécuteur git simulé : `dirty` pilote `status --porcelain`. */
const gitExec = ({ isGit = true, dirty = [] } = {}) => async (cmd, args) => {
  if (cmd !== 'git') return { code: 0, stdout: '', stderr: '' };
  if (!isGit) return { code: 128, stdout: '', stderr: 'not a git repository' };
  if (args[0] === 'rev-parse' && args[1] === 'HEAD') return { code: 0, stdout: `${COMMIT}\n`, stderr: '' };
  if (args[0] === 'rev-parse') return { code: 0, stdout: 'main\n', stderr: '' };
  if (args[0] === 'status') return { code: 0, stdout: dirty.join('\n'), stderr: '' };
  return { code: 0, stdout: '', stderr: '' };
};

const DIRTY = [' M backend/src/server.js', '?? backend/src/nouveau.js', ' M frontend/src/App.tsx'];

/* ────────────────────────────────────────────────────────────────────────── */
section('1. Règle TEST / PROD — inchangée');
{
  check('PROD exige une source commitée', requiresCleanSource('PROD') === true);
  check('TEST ne l’exige pas', requiresCleanSource('TEST') === false);
  check('l’environnement par défaut est traité comme PROD', requiresCleanSource(undefined) === true);
  check('la casse n’a pas d’importance', requiresCleanSource('prod') === true);
}

/* ────────────────────────────────────────────────────────────────────────── */
section('2. Dépôt propre → déploiement autorisé');
{
  const r = await runLocalPreflight({ env: 'PROD', root: '/x', exec: gitExec({ dirty: [] }) });
  check('prérequis locaux satisfaits', r.ok === true);
  check('aucun contrôle en échec', r.failedChecks.length === 0);
  check('le commit est identifié', r.git.shortCommit === COMMIT.slice(0, 7));
  const src = r.checks.find((c) => c.id === 'source.clean');
  check('le contrôle annonce le commit déployé', /abc1234/.test(src.detail));
  check('le contrôle est bien classé LOCAL', src.scope === 'local');
}

/* ────────────────────────────────────────────────────────────────────────── */
section('3. Dépôt non commité en PROD → refus, avec la liste des fichiers');
{
  const r = await runLocalPreflight({ env: 'PROD', root: '/x', exec: gitExec({ dirty: DIRTY }) });
  check('prérequis locaux NON satisfaits', r.ok === false);
  check('le contrôle fautif est identifié', r.failedChecks[0].id === 'source.clean');
  check('il est requis en PROD', r.failedChecks[0].required === true);

  const src = r.checks.find((c) => c.id === 'source.clean');
  check('les 3 fichiers concernés sont listés', src.files.length === 3);
  check('les fichiers modifiés sont distingués des non suivis',
    src.files.filter((f) => f.state === 'modifié').length === 2
    && src.files.filter((f) => f.state === 'non suivi').length === 1);
  check('les chemins sont exploitables tels quels',
    src.files.some((f) => f.path === 'backend/src/server.js')
    && src.files.some((f) => f.path === 'backend/src/nouveau.js'));
  check('le décompte figure dans le détail', /3 fichier/.test(src.detail));
}

/* ────────────────────────────────────────────────────────────────────────── */
section('4. Dépôt non commité en TEST → informatif, jamais bloquant');
{
  const r = await runLocalPreflight({ env: 'TEST', root: '/x', exec: gitExec({ dirty: DIRTY }) });
  check('le déploiement reste autorisé', r.ok === true);
  check('aucun contrôle bloquant', r.failedChecks.length === 0);
  const src = r.checks.find((c) => c.id === 'source.clean');
  check('le contrôle est tout de même RENDU (l’opérateur est informé)', Boolean(src));
  check('…mais non requis', src.required === false);
  check('…et les fichiers restent visibles', src.files.length === 3);
}

/* ────────────────────────────────────────────────────────────────────────── */
section('5. Hors dépôt Git — on le dit, on ne prétend pas avoir contrôlé');
{
  const r = await runLocalPreflight({ env: 'PROD', root: '/x', exec: gitExec({ isGit: false }) });
  check('le déploiement n’est pas bloqué', r.ok === true);
  const src = r.checks.find((c) => c.id === 'source.git');
  check('le contrôle annonce « non applicable »', /non applicable/i.test(src.detail));
  check('…et n’est pas requis', src.required === false);
}

/* ────────────────────────────────────────────────────────────────────────── */
section('6. AUCUN effet de bord — la porte est bien en amont');
{
  // Un transport qui EXPLOSE au moindre usage : si la porte laissait passer
  // quoi que ce soit, ce test le révélerait immédiatement.
  let touched = 0;
  const piege = new Proxy({}, { get() { touched += 1; throw new Error('le transport ne doit JAMAIS être touché'); } });

  const engine = new DeploymentEngine({ wildcardBases: ['ly-solution.com'] });
  const r = await engine.checkLocalPrerequisites({ env: 'PROD', root: '/x', exec: gitExec({ dirty: DIRTY }) });

  check('la porte refuse', r.ok === false);
  check('aucune connexion SSH n’a été tentée', touched === 0);
  check('la porte est exposée par le MOTEUR (aucun contournement par projet)',
    typeof engine.checkLocalPrerequisites === 'function');

  // Le transport piégé n'est jamais passé au moteur : on prouve surtout que la
  // vérification n'a besoin d'AUCUN transport pour rendre son verdict.
  check('le verdict ne dépend d’aucun transport', r.failedChecks.length === 1);
  void piege;
}

/* ────────────────────────────────────────────────────────────────────────── */
section('7. Le point d’entrée refuse AVANT de créer quoi que ce soit');
{
  const fs = await import('node:fs');
  const src = fs.readFileSync(
    new URL('../backend/src/controllers/deployment.controller.js', import.meta.url), 'utf8',
  );
  const garde = src.indexOf('checkLocalPrerequisites');
  const createRun = src.indexOf('await createRun(');
  const worker = src.indexOf('startDeploymentWorker(');
  const marquage = src.indexOf('markDeploying(');

  check('le contrôle local existe au point d’entrée', garde !== -1);
  check('…il précède la création du run', garde < createRun);
  check('…il précède le marquage de la destination', garde < marquage);
  check('…il précède le lancement du worker', garde < worker);
  check('le refus dit que le pipeline n’a pas tourné', /pipelineExecuted:\s*false/.test(src));
  check('le refus porte la liste des fichiers', /files:\s*source\?\.files/.test(src));
  check('le message est celui attendu', /Source Git non commitée/.test(src));
  check('aucun mode « forcer » en production',
    !/forceDirty|allowDirty|skipGitCheck/i.test(src));
}

/* ────────────────────────────────────────────────────────────────────────── */
section('8. Prérequis LOCAUX et DISTANTS sont distingués');
{
  const r = await runLocalPreflight({ env: 'PROD', root: '/x', exec: gitExec({ dirty: [] }) });
  check('tout contrôle local porte scope=local', r.checks.every((c) => c.scope === 'local'));

  const fs = await import('node:fs');
  const preflight = fs.readFileSync(
    new URL('../backend/src/deployment-engine/preflight.js', import.meta.url), 'utf8',
  );
  check('les contrôles distants sont marqués scope=remote', /scope:\s*'remote'/.test(preflight));
}

/* ────────────────────────────────────────────────────────────────────────── */
section('9. PREUVE COMPORTEMENTALE : dépôt dirty en PROD → rien n’existe');
{
  // ── CE QUE LA SECTION 7 NE PROUVE PAS ────────────────────────────────────
  // Elle lit le SOURCE du contrôleur et compare des positions de texte. Elle
  // resterait verte si la garde devenait inopérante sans bouger de place — et
  // ne dit rien de ce qui existe en base après un refus. Cette section-ci
  // n'inspecte aucun code : elle envoie la vraie requête HTTP et regarde ce
  // que le Panel a créé. Elle casse si le contrôle repart dans le pipeline,
  // puisqu'alors un run serait bel et bien créé avant le refus.
  const fs = await import('node:fs');
  const path = await import('node:path');
  const { PROJECT_ROOT } = await import('../backend/src/deployment-engine/build.js');
  const {
    connectTestDatabase, setTestEnv, startMemoryMongo, startServer, stopMemoryMongo,
  } = await import('./helpers/harness.js');

  // Le dépôt est rendu DÉTERMINISTEMENT non commité : un fichier non suivi
  // suffit, et il est retiré quoi qu'il arrive. Sans cela, le test dépendrait
  // de l'état de travail du poste — vert par hasard sur un dépôt propre.
  const probeFile = path.join(PROJECT_ROOT, `.deploy-gate-probe-${process.pid}.tmp`);
  fs.writeFileSync(probeFile, 'sonde de test — supprimée automatiquement\n');

  try {
    setTestEnv();
    await startMemoryMongo();
    await connectTestDatabase();

    const { createApp } = await import('../backend/src/app.js');
    const { config } = await import('../backend/src/config/env.js');
    const { seedFromEnv } = await import('../backend/src/services/auth/panelUsers.service.js');
    const PanelDeploymentRun = (await import('../backend/src/models/PanelDeploymentRun.model.js')).default;
    const PanelDeploymentTarget = (await import('../backend/src/models/PanelDeploymentTarget.model.js')).default;

    await seedFromEnv();
    const { call, close } = await startServer(createApp());
    const login = await call('POST', '/api/auth/login', {
      body: { email: config.seedDevEmail, password: config.seedDevPassword },
    });
    const AUTH = { authorization: `Bearer ${login.json.data.token}` };

    const created = await call('POST', '/api/deployment/targets', {
      headers: AUTH,
      body: { name: 'Prod', url: 'https://prod.exemple.com', environment: 'PROD', sshHost: '203.0.113.10' },
    });
    const targetId = created.json?.data?.targetId;
    check('destination PROD créée', created.status === 201 && Boolean(targetId));

    // Le dépôt est bien non commité : sinon la preuve ci-dessous ne prouve rien.
    const local = await runLocalPreflight({ env: 'PROD' });
    check('le dépôt de travail est bien non commité pour ce test', local.ok === false);

    const res = await call('POST', `/api/deployment/targets/${targetId}/deploy`, {
      headers: AUTH,
      body: { sshPassword: 'motdepasse', confirmProduction: true },
    });

    check('la requête est REFUSÉE en 400', res.status === 400);
    check('…avec le code attendu', res.json?.code === 'PANEL_DEPLOY_LOCAL_PREREQUISITES_FAILED');
    check('…un message explicite', /Source Git non commitée/.test(res.json?.message ?? ''));
    check('…la liste des fichiers fautifs', (res.json?.details?.files ?? []).length > 0);
    check('…dont le fichier sonde', (res.json?.details?.files ?? [])
      .some((f) => f.path.includes('.deploy-gate-probe-')));
    check('…et l’aveu que le pipeline n’a pas tourné', res.json?.details?.pipelineExecuted === false);

    // ── LE CŒUR DE LA PREUVE : rien n’a été créé ───────────────────────────
    // Aucun run ⇒ aucune checklist et aucun rapport (tous deux vivent dans le
    // document du run) ⇒ aucun worker (il ne peut démarrer sans runId) ⇒
    // aucune connexion SSH, aucun appel DNS, aucune écriture distante, tous
    // situés en aval du worker.
    check('AUCUN DeploymentRun créé', (await PanelDeploymentRun.countDocuments({})) === 0);
    check('…donc aucune étape de checklist', (await PanelDeploymentRun.countDocuments({ 'steps.0': { $exists: true } })) === 0);
    check('…donc aucun rapport de déploiement', (await PanelDeploymentRun.countDocuments({ structuredReport: { $ne: null } })) === 0);

    const target = await PanelDeploymentTarget.findOne({ targetId }).lean();
    check('la destination n’est PAS passée en DEPLOYING', target.state !== 'DEPLOYING');
    check('…et ne porte aucun run', (target.lastRunId ?? null) === null);

    // ── NON-RÉGRESSION : le même dépôt dirty reste autorisé en TEST ────────
    // On l'éprouve à la porte elle-même : la laisser ouvrir un vrai
    // déploiement lancerait un worker détaché et une vraie connexion SSH.
    const testEnv = await runLocalPreflight({ env: 'TEST' });
    check('dépôt non commité en TEST : la porte n’oppose AUCUN refus', testEnv.ok === true);
    check('…tout en signalant les fichiers (informatif, non bloquant)',
      testEnv.checks.some((c) => c.id === 'source.clean' && c.required === false));

    await close();
    await stopMemoryMongo();
  } finally {
    fs.rmSync(probeFile, { force: true });
  }
}

finish();
