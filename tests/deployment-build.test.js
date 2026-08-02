// Build de l'artefact (étape `artifact.build`) sur un projet à FRONT UNIQUE.
//
// Régression couverte : le moteur assemblait l'artefact en adressant les
// applications par leur NOM (`dists.vitrine`, `dists.manager`), noms qui
// n'existent que dans le profil d'un projet vitrine. Sur le Panel — dont le
// profil déclare une seule application front, `frontend` — ces alias valaient
// `null` et `path.join(null, 'version.json')` faisait échouer `artifact.build`
// avec ERR_INVALID_ARG_TYPE, APRÈS un build frontend pourtant réussi.
//
// La composition du projet vient du PROFIL : le build doit suivre les RÔLES
// déclarés (`web`, `web-sub`, `server`), jamais des identifiants codés en dur.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { check, finish, section } from './helpers/harness.js';

const { buildArtifact } = await import('../backend/src/deployment-engine/build.js');
const { APPS } = await import('../backend/src/deployment-engine/config/project.profile.js');

const webApps = APPS.filter((app) => app.role !== 'server');
const serverApp = APPS.find((app) => app.role === 'server');

/** Monorepo source minimal, conforme au profil réel du projet. */
async function makeSourceTree() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'panel-build-test-src-'));
  for (const app of APPS) {
    const dir = path.join(root, app.dir);
    await fs.mkdir(path.join(dir, 'src'), { recursive: true });
    await fs.writeFile(path.join(dir, 'package.json'), JSON.stringify({ name: app.id, version: '1.0.0' }));
    await fs.writeFile(path.join(dir, 'src', 'index.js'), '// source\n');
    if (app.role !== 'server') {
      await fs.writeFile(path.join(dir, 'package-lock.json'), '{"lockfileVersion":3}');
    }
  }
  return root;
}

/** `npm ci` réussit ; `npm run build` produit un dist SPA réaliste. */
const exec = async (cmd, args, { cwd } = {}) => {
  if (cmd === 'git') {
    if (args[0] === 'rev-parse' && args[1] === 'HEAD') {
      return { code: 0, signal: null, stdout: 'abc1234567890abcdef1234567890abcdef1234\n', stderr: '' };
    }
    if (args[0] === 'rev-parse') return { code: 0, signal: null, stdout: 'main\n', stderr: '' };
    return { code: 0, signal: null, stdout: '', stderr: '' }; // status --porcelain : propre
  }
  if (cmd === 'npm' && args[0] === 'run' && args[1] === 'build') {
    const dist = path.join(cwd, 'dist');
    await fs.mkdir(path.join(dist, 'assets'), { recursive: true });
    await fs.writeFile(path.join(dist, 'index.html'), '<script type="module" src="/assets/main-abc123.js"></script>');
    await fs.writeFile(path.join(dist, 'assets', 'main-abc123.js'), 'console.log(1)');
  }
  return { code: 0, signal: null, stdout: '', stderr: '' };
};

const exists = async (p) => { try { await fs.access(p); return true; } catch { return false; } };

section('artifact.build : un projet à front unique produit un artefact complet');
{
  check('le profil déclare bien une topologie à front unique (aucun web-sub)',
    webApps.length === 1 && webApps[0].role === 'web' && !APPS.some((a) => a.role === 'web-sub'));

  const root = await makeSourceTree();
  let artifact = null;
  let error = null;
  try {
    artifact = await buildArtifact({ root, exec, onLog: () => {} });
  } catch (err) {
    error = err;
  }

  // Le cœur de la régression : plus aucun chemin construit à partir de null.
  if (error) console.error(`    → ${error.code} : ${error.message}`);
  check('le build n’échoue pas après la construction du frontend', error === null);
  check('aucune erreur ERR_INVALID_ARG_TYPE', error?.code !== 'ERR_INVALID_ARG_TYPE');

  if (artifact) {
    const front = webApps[0];
    const expected = path.join(artifact.stagingRoot, front.dir, 'dist');

    check('dists contient une entrée par application front du profil',
      Object.keys(artifact.dists).length === webApps.length && artifact.dists[front.id] === expected);
    check('le dist du front est un CHEMIN, indexé par son identifiant de profil',
      typeof artifact.dists[front.id] === 'string' && artifact.dists[front.id] === expected);
    check('aucun alias nommé n’est exposé par l’artefact',
      !('vitrineDist' in artifact) && !('managerDist' in artifact));
    check('backendDir pointe le backend staged',
      artifact.backendDir === path.join(artifact.stagingRoot, serverApp.dir));

    // version.json : écrit dans CHAQUE dist déclaré, aucun autre.
    let versionEverywhere = true;
    for (const app of webApps) {
      const v = path.join(artifact.dists[app.id], 'version.json');
      if (!(await exists(v))) { versionEverywhere = false; continue; }
      const parsed = JSON.parse(await fs.readFile(v, 'utf8'));
      if (parsed.commitHash !== 'abc1234567890abcdef1234567890abcdef1234') versionEverywhere = false;
    }
    check('version.json déposé dans le dist de chaque front déclaré', versionEverywhere);
    check('build-manifest.json déposé dans le backend',
      await exists(path.join(artifact.backendDir, 'build-manifest.json')));

    // Le manifeste doit décrire le front RÉEL du projet.
    check('appArtifactHashes couvre les fronts du profil',
      Object.keys(artifact.manifest.appArtifactHashes).join(',') === webApps.map((a) => a.id).join(','));
    check('le manifeste n’expose plus d’alias nommé',
      !('vitrineArtifactHash' in artifact.manifest) && !('managerArtifactHash' in artifact.manifest));
    check('empreinte web calculée pour le front principal',
      typeof artifact.web[front.id]?.indexHash === 'string');

    await artifact.cleanup();
    check('cleanup supprime le staging', !(await exists(artifact.stagingRoot)));
  }

  await fs.rm(root, { recursive: true, force: true });
}

section('artifact.build : une source invalide échoue de façon explicite');
{
  const root = await makeSourceTree();
  await fs.rm(path.join(root, webApps[0].dir, 'package-lock.json'), { force: true });
  let code = null;
  try { await buildArtifact({ root, exec, onLog: () => {} }); } catch (err) { code = err.code; }
  check('lockfile manquant → ARTIFACT_PATH_INVALID (pas une TypeError)', code === 'ARTIFACT_PATH_INVALID');
  await fs.rm(root, { recursive: true, force: true });
}

finish();
