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
import path from 'node:path';
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

/**
 * ══ UN DISQUE SIMULÉ — parce que cette suite parle de GIT, pas de fichiers ══
 *
 * Le préflight local contrôle désormais DEUX choses : que la source est
 * commitée, et que les sources du projet sont bien là. Le second contrôle est
 * un vrai progrès — il évite qu'une machine sans les sources traverse le DNS
 * avant d'échouer au build — mais il n'est pas le sujet ici : les sections
 * ci-dessous éprouvent la règle TEST/PROD sur une racine fictive `/x`.
 *
 * On leur donne donc un disque où `/x` contient les applications déclarées par
 * le profil. Ce n'est pas contourner le nouveau contrôle : il est éprouvé pour
 * lui-même, avec un disque VIDE, dans sa propre section.
 */
const { APPS } = await import('../backend/src/deployment-engine/config/project.profile.js');
const fsPresent = {
  /**
   * On compare la FIN du chemin, pas son début : `path.resolve('/x')` donne
   * `C:\x` sous Windows et `/x` ailleurs. Faire dépendre la recette du
   * séparateur de la machine la rendrait verte ici et rouge sur le poste
   * d'à côté — pour une raison qui n'a rien à voir avec ce qu'elle éprouve.
   */
  access: async (chemin) => {
    const normalise = String(chemin).split(path.sep).join('/');
    const attendus = APPS.flatMap((app) => [
      `/${app.dir}/package.json`, `/${app.dir}/package-lock.json`,
    ]);
    if (attendus.some((fin) => normalise.endsWith(fin))) return undefined;
    throw new Error(`ENOENT: ${chemin}`);
  },
};
const fsVide = { access: async (chemin) => { throw new Error(`ENOENT: ${chemin}`); } };

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
  const r = await runLocalPreflight({ env: 'PROD', root: '/x', exec: gitExec({ dirty: [] }), fsMod: fsPresent });
  check('prérequis locaux satisfaits', r.ok === true);
  check('aucun contrôle en échec', r.failedChecks.length === 0);
  check('le commit est identifié', r.git.shortCommit === COMMIT.slice(0, 7));
  const src = r.checks.find((c) => c.id === 'source.clean');
  check('le contrôle annonce le commit déployé', /abc1234/.test(src.detail));
  check('le contrôle est bien classé LOCAL', src.scope === 'local');
}

/* ────────────────────────────────────────────────────────────────────────── */
section('2 bis. Sources absentes du disque → refus AVANT tout effet de bord');
{
  /**
   * Le défaut que ce contrôle ferme : une machine qui ne détient pas les
   * sources passait tout le préflight local, puis créait un run, ouvrait SSH,
   * POSAIT DES ENREGISTREMENTS DNS, et échouait enfin au build. Le fait était
   * pourtant connaissable ici, instantanément et sans rien toucher.
   */
  const r = await runLocalPreflight({
    env: 'PROD', root: '/x', exec: gitExec({ dirty: [] }), fsMod: fsVide,
  });
  check('prérequis locaux NON satisfaits', r.ok === false);
  const layout = r.checks.find((c) => c.id === 'source.layout');
  check('le contrôle des sources existe et échoue', layout && layout.ok === false);
  check('…il est bloquant', layout.required === true);
  check('…et il nomme le problème, pas seulement le contrôle',
    /introuvable/i.test(layout.summary ?? ''));
  check('…en désignant CHAQUE application manquante',
    APPS.every((app) => String(layout.detail).includes(app.dir)));
  check('la règle TEST/PROD ne le concerne pas : il vaut aussi en TEST',
    (await runLocalPreflight({
      env: 'TEST', root: '/x', exec: gitExec({ dirty: [] }), fsMod: fsVide,
    })).ok === false);
}

/* ────────────────────────────────────────────────────────────────────────── */
section('3. Dépôt non commité en PROD → refus, avec la liste des fichiers');
{
  const r = await runLocalPreflight({ env: 'PROD', root: '/x', exec: gitExec({ dirty: DIRTY }), fsMod: fsPresent });
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
  const r = await runLocalPreflight({ env: 'TEST', root: '/x', exec: gitExec({ dirty: DIRTY }), fsMod: fsPresent });
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
  const r = await runLocalPreflight({ env: 'PROD', root: '/x', exec: gitExec({ isGit: false }), fsMod: fsPresent });
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
  /**
   * « SANS TRANSPORT » se mesure au transport, pas au NOMBRE d'échecs.
   *
   * Cette ligne comptait exactement un contrôle en échec. Le compte a changé —
   * le préflight local en porte un second depuis qu'il vérifie aussi la
   * présence des sources, et sur une racine fictive `/x` les deux échouent, à
   * raison. Compter les échecs n'a jamais été le sujet : ce que la section
   * établit est qu'un verdict est rendu SANS toucher au transport, et que
   * l'échec attendu est bien nommé.
   */
  check('le verdict ne dépend d’aucun transport', touched === 0 && r.failedChecks.length > 0);
  check('…et il nomme la source non commitée',
    r.failedChecks.some((c) => c.id === 'source.clean'));
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
  /**
   * L'OUVERTURE DU RUN PASSE PAR `openRun` — et ce n'est pas cosmétique.
   *
   * `createRun` lève désormais une erreur TYPÉE quand le journal durable est
   * inaccessible ; `openRun` la traduit en refus HTTP stable, sans laisser
   * fuiter la cause d'origine (un message de pilote Mongo cite l'URI de
   * connexion, donc des identifiants). C'est CET appel qui marque l'instant où
   * le déploiement devient réel, et c'est donc lui que l'ordre doit suivre.
   */
  const createRun = src.indexOf('await openRun(');
  const worker = src.indexOf('startDeploymentWorker(');
  const marquage = src.indexOf('markDeploying(');

  check('le contrôle local existe au point d’entrée', garde !== -1);
  check('…il précède la création du run', createRun !== -1 && garde < createRun);
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
  const r = await runLocalPreflight({ env: 'PROD', root: '/x', exec: gitExec({ dirty: [] }), fsMod: fsPresent });
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

  /**
   * LE DÉPÔT EST RENDU NON COMMITÉ — par une modification que git VOIT.
   *
   * ══ POURQUOI LA SONDE PRÉCÉDENTE NE MARCHAIT PAS ══════════════════════════
   *
   * Elle créait un fichier NON SUIVI nommé `.deploy-gate-probe-<pid>.tmp`. Or
   * `.gitignore:7` ignore exactement ce motif — la règle existe pour qu'un
   * reste de sonde ne soit jamais committé, et elle fait très bien son
   * travail : `git status` ne l'a JAMAIS vue.
   *
   * Le dépôt restait donc propre, `runLocalPreflight` répondait « rien à
   * signaler », et onze assertions tombaient en cascade. Le test ne passait que
   * lorsqu'un travail en cours rendait l'arbre sale PAR AILLEURS — c'est-à-dire
   * par accident, et jamais sur un dépôt propre.
   *
   * ══ CE QU'ON FAIT À LA PLACE ══════════════════════════════════════════════
   *
   * On modifie un fichier SUIVI, et on le restaure à l'octet près dans le
   * `finally`. Une modification de fichier suivi ne peut pas être ignorée : par
   * construction, elle est toujours visible. La règle de `.gitignore` reste
   * intacte, et la garantie éprouvée devient réelle plutôt qu'accidentelle.
   */
  const probeFile = path.join(PROJECT_ROOT, 'README.md');
  const probeOriginal = fs.readFileSync(probeFile, 'utf8');
  fs.writeFileSync(probeFile, `${probeOriginal}
<!-- sonde de recette -->
`);

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
    check('…dont le fichier modifié par la sonde', (res.json?.details?.files ?? [])
      .some((f) => f.path.includes('README.md')));
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
    // RESTAURATION À L'OCTET PRÈS — un test ne laisse jamais le dépôt modifié.
    fs.writeFileSync(probeFile, probeOriginal);
  }
}

finish();
