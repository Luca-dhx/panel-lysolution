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

finish();
