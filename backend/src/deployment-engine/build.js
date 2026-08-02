/**
 * Build LOCAL & versionnement — construit l'artefact de déploiement.
 *
 * S'exécute sur la machine qui pilote le déploiement (backend du Manager), PAS
 * sur le VPS. Produit :
 *   - la version courante du projet (SHA git court, ou horodatage en repli) ;
 *   - un artefact prêt à l'upload (dist vitrine + dist manager + backend).
 *
 * ISOLATION (règle) : le build ne s'exécute JAMAIS dans l'arbre de travail
 * vivant. On copie les sources (vitrine/manager/backend) dans un répertoire de
 * staging temporaire — SANS `node_modules`, `dist`, `.git`, ni secrets `.env`
 * du backend — puis on lance `npm ci` + `npm run build` DANS le staging.
 *
 * Pourquoi : `npm ci` supprime intégralement `node_modules` avant de réinstaller.
 * Exécuté en place, il tente d'`unlink` des fichiers verrouillés par un
 * processus vivant (sur Windows, `esbuild.exe` détenu par le serveur Vite du
 * Manager) → `EPERM`. En staging isolé, l'installation ne touche jamais le
 * `node_modules` de l'app en cours d'exécution : le build est reproductible,
 * indépendant de l'état préalable de `node_modules`, et compatible Windows et
 * Linux. Seul le `dist` (public) est ensuite uploadé : aucun `.env` n'est
 * embarqué dans l'artefact.
 *
 * Utilise child_process localement (pas le Transport, qui vise le VPS).
 */
import { APPS, BUILD_STAGING_PREFIX, PROJECT_ID } from './config/project.profile.js';
import { buildableApps as topologyBuildableApps } from './topology.js';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { DeploymentError } from './errors.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
/** Racine du monorepo (…/backend/src/deployment -> remonte de 3). */
export const PROJECT_ROOT = path.resolve(__dirname, '../../..');

/** Liste d'applications d'un profil (objet complet, tableau, ou défaut du dépôt). */
function profileApps(profile) {
  if (!profile) return APPS;
  return Array.isArray(profile) ? profile : (profile.APPS ?? APPS);
}
/** Applications réellement construites (rôle, jamais nom). */
const buildableApps = (appList) => topologyBuildableApps(appList);

/**
 * Exécute une commande locale et capture la sortie.
 * Résout TOUJOURS (même sur code non nul) avec `{ code, signal, stdout, stderr }`.
 * Rejette uniquement sur erreur de spawn (ENOENT…) ou timeout — ces cas sont
 * traduits en `DeploymentError` par l'appelant.
 */
export function localExec(command, args, { cwd = PROJECT_ROOT, timeoutMs = 600_000, env } = {}) {
  return new Promise((resolve, reject) => {
    // `shell` est NÉCESSAIRE sur Windows : `npm`/`npx` y sont des scripts `.cmd`,
    // que `spawn` ne sait pas lancer directement. Mais un `cmd.exe` lancé sans
    // consigne ouvre une FENÊTRE DE CONSOLE à chaque sous-commande — le build en
    // lance plusieurs par application. `windowsHide` est l'option prévue par Node
    // pour cela : elle pose CREATE_NO_WINDOW au niveau du processus enfant.
    // Sans effet hors Windows, on la passe donc inconditionnellement.
    const child = spawn(command, args, {
      cwd,
      env: env || process.env,
      shell: process.platform === 'win32',
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
      reject(new Error(`Timeout build local (${timeoutMs} ms) : ${command} ${args.join(' ')}`));
    }, timeoutMs);
    timer.unref?.();
    child.stdout.on('data', (d) => (stdout += d.toString()));
    child.stderr.on('data', (d) => (stderr += d.toString()));
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (timedOut) return; // rejet déjà émis
      resolve({ code, signal: signal || null, stdout, stderr });
    });
  });
}

/** Version courante du projet : SHA git court, sinon horodatage. */
export async function getProjectVersion(root = PROJECT_ROOT, now = new Date()) {
  try {
    const res = await localExec('git', ['rev-parse', '--short', 'HEAD'], { cwd: root, timeoutMs: 10_000 });
    const sha = res.stdout.trim();
    if (res.code === 0 && sha) {
      const dirty = await localExec('git', ['status', '--porcelain'], { cwd: root, timeoutMs: 10_000 });
      return dirty.stdout.trim() ? `${sha}-dirty` : sha;
    }
  } catch {
    /* pas de git : repli horodatage */
  }
  const p = (n) => String(n).padStart(2, '0');
  return `v${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}`;
}

/**
 * État Git EXACT de la source construite (LOT 4/5). Sert à garantir que le code
 * déployé == le code de la branche canonique, et à générer le manifeste embarqué.
 * @returns {Promise<{commitHash, shortCommit, branch, isDirty, isGit}>}
 */
export async function getGitSourceInfo(root = PROJECT_ROOT, exec = localExec) {
  try {
    const head = await exec('git', ['rev-parse', 'HEAD'], { cwd: root, timeoutMs: 10_000 });
    if (head.code !== 0 || !head.stdout.trim()) return { isGit: false, commitHash: null, shortCommit: null, branch: null, isDirty: false };
    const commitHash = head.stdout.trim();
    const [branch, dirty] = await Promise.all([
      exec('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: root, timeoutMs: 10_000 }),
      exec('git', ['status', '--porcelain'], { cwd: root, timeoutMs: 10_000 }),
    ]);
    return {
      isGit: true,
      commitHash,
      shortCommit: commitHash.slice(0, 7),
      branch: branch.stdout.trim() || null,
      isDirty: Boolean(dirty.stdout.trim()),
    };
  } catch {
    return { isGit: false, commitHash: null, shortCommit: null, branch: null, isDirty: false };
  }
}

/** Hash déterministe (sha256) du CONTENU d'un dossier (chemins triés + octets). */
async function hashDir(dir, fsMod = fs) {
  const h = crypto.createHash('sha256');
  const walk = async (d, rel = '') => {
    let entries;
    try { entries = await fsMod.readdir(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(d, e.name);
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) await walk(full, r);
      else { h.update(r); h.update(await fsMod.readFile(full)); }
    }
  };
  await walk(dir);
  return h.digest('hex').slice(0, 16);
}

/**
 * Empreinte WEB d'un dist SPA : sha256 de `index.html` + du JS d'ENTRÉE (nom + sha).
 * Sert à vérifier, APRÈS déploiement, que le navigateur reçoit BIEN cet artefact
 * (et pas une ancienne version en cache/obsolète). Les noms d'assets Vite étant
 * des hash de contenu, un nom identique ⟺ un contenu identique.
 * @returns {Promise<{indexHash:string|null, mainJs:{name:string, hash:string}|null}>}
 */
export async function webFingerprint(dist, fsMod = fs) {
  let indexBuf;
  try { indexBuf = await fsMod.readFile(path.join(dist, 'index.html')); }
  catch { return { indexHash: null, mainJs: null }; }
  const indexHash = crypto.createHash('sha256').update(indexBuf).digest('hex');
  const html = indexBuf.toString('utf8');
  // JS d'entrée : premier <script type="module" src=".../assets/xxx.js"> (sinon 1er /assets/*.js).
  const m = html.match(/<script[^>]+src="([^"]*\/assets\/[^"]+\.js)"/i) || html.match(/\/assets\/[A-Za-z0-9._-]+\.js/);
  let mainJs = null;
  if (m) {
    const name = (m[1] || m[0]).replace(/^.*\/assets\//, '');
    try {
      const jsBuf = await fsMod.readFile(path.join(dist, 'assets', name));
      mainJs = { name, hash: crypto.createHash('sha256').update(jsBuf).digest('hex') };
    } catch { /* asset introuvable : mainJs reste null */ }
  }
  return { indexHash, mainJs };
}

/* -------------------------------------------------------------------------- */
/*  Staging : copie isolée des sources                                        */
/* -------------------------------------------------------------------------- */

/** Répertoires jamais copiés dans le staging (communs à toutes les apps). */
const EXCLUDE_DIRS = new Set(['node_modules', 'dist', '.git', '.turbo', '.vite', '.cache', 'coverage']);
/** Dossiers/fichiers de runtime ou secrets exclus du backend uploadé. */
const BACKEND_EXCLUDE_DIRS = new Set(['uploads', 'storage', 'logs']);

/** Segment de chemin à exclure de la copie de staging. */
function isExcludedSegment(seg, isBackend) {
  if (EXCLUDE_DIRS.has(seg)) return true;
  if (seg.endsWith('.tsbuildinfo') || seg.endsWith('.log')) return true;
  if (isBackend) {
    if (BACKEND_EXCLUDE_DIRS.has(seg)) return true;
    // Ne JAMAIS embarquer les secrets du backend : le VPS écrit son propre .env.
    if (seg === '.env' || seg.startsWith('.env.')) return true;
  } else {
    // Frontends : on NEUTRALISE les overrides DEV (.env.local, .env.development…)
    // qui contiennent des VITE_API_URL locaux (ex. http://localhost:6070, ngrok).
    // Baked dans le bundle, ils casseraient le site déployé (appels vers le poste
    // du dev). La config PRODUCTION est écrite juste après (.env.production.local).
    if (seg === '.env.local' || seg === '.env.development' || seg === '.env.development.local') return true;
  }
  return false;
}

/** Copie `srcDir` -> `destDir` en excluant node_modules/dist/.git/secrets. */
async function copyApp(srcDir, destDir, { isBackend = false, fsMod = fs } = {}) {
  await fsMod.cp(srcDir, destDir, {
    recursive: true,
    errorOnExist: false,
    filter: (src) => {
      const rel = path.relative(srcDir, src);
      if (!rel) return true; // la racine elle-même
      return !rel.split(path.sep).some((seg) => isExcludedSegment(seg, isBackend));
    },
  });
}

async function pathExists(p, fsMod = fs) {
  try {
    await fsMod.access(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Valide la présence et la structure des trois projets. Un chemin invalide est
 * une erreur DÉMONTRÉE (pas une supposition) : package.json manquant, ou
 * lockfile absent (npm ci est alors impossible).
 */
async function resolveLayout(root, fsMod = fs, appList = APPS) {
  // La composition du projet vient du PROFIL, jamais d'une liste codée en dur :
  // c'est ce qui permet au même moteur de construire deux fronts ici, un seul
  // ailleurs, ou cinq applications sur un projet atypique.
  const apps = {};
  for (const app of appList) apps[app.id] = path.join(root, app.dir);

  // COHÉRENCE DU PROFIL, contrôlée AVANT tout build : la topologie expose des
  // chemins dérivés des rôles (`web` → hôte principal, `server` → backend). Un
  // profil qui n'en déclare pas produirait des chemins vides très en aval ; on
  // refuse ici, explicitement, plutôt que d'échouer plus tard sans motif.
  for (const role of ['web', 'server']) {
    if (!appList.some((app) => app.role === role)) {
      throw new DeploymentError('ARTIFACT_PATH_INVALID', `Profil de projet incomplet : aucune application de rôle « ${role} » déclarée.`, {
        step: 'build',
        details: { phase: 'profile', role, declared: appList.map((app) => `${app.id}:${app.role}`) },
      });
    }
  }

  for (const app of appList) {
    const dir = apps[app.id];
    if (!(await pathExists(path.join(dir, 'package.json'), fsMod))) {
      throw new DeploymentError('ARTIFACT_PATH_INVALID', `Projet introuvable ou invalide : ${app.dir}/package.json manquant.`, {
        step: 'build',
        details: { phase: 'stage', path: dir },
      });
    }
  }
  // npm ci EXIGE un lockfile cohérent : son absence est bloquante et explicite.
  // Seules les applications réellement CONSTRUITES sont concernées — le rôle le
  // dit, pas le nom.
  for (const app of buildableApps(appList)) {
    if (!(await pathExists(path.join(apps[app.id], 'package-lock.json'), fsMod))) {
      throw new DeploymentError('ARTIFACT_PATH_INVALID', `Lockfile manquant : ${app.dir}/package-lock.json (npm ci impossible).`, {
        step: 'build',
        details: { phase: 'stage', path: apps[app.id] },
      });
    }
  }
  return apps;
}

/* -------------------------------------------------------------------------- */
/*  Phases de build instrumentées                                             */
/* -------------------------------------------------------------------------- */

/**
 * Libellé lisible + code d'erreur spécialisé par phase, dérivés du profil.
 * Les identifiants de phase eux-mêmes viennent du profil (`installPhase` /
 * `buildPhase`) ; à défaut ils sont dérivés de l'identifiant d'application, de
 * sorte qu'un profil minimal reste parfaitement utilisable.
 */
function phaseMetaOf(appList) {
  return Object.fromEntries(
    buildableApps(appList).flatMap((app) => [
      [installPhaseOf(app), {
        label: app.installLabel ?? `installation des dépendances (${app.id})`,
        code: app.installFailedCode ?? `ARTIFACT_INSTALL_${app.id.toUpperCase()}_FAILED`,
      }],
      [buildPhaseOf(app), {
        label: app.buildLabel ?? `construction de ${app.id}`,
        code: app.buildFailedCode ?? `ARTIFACT_BUILD_${app.id.toUpperCase()}_FAILED`,
      }],
    ]),
  );
}

/** Identifiants de phase — déclarés au profil, sinon dérivés de l'id. */
const installPhaseOf = (app) => app.installPhase ?? `install_${app.id}`;
const buildPhaseOf = (app) => app.buildPhase ?? `build_${app.id}`;

/** Motif lisible depuis une erreur de spawn (ENOENT, timeout…). */
function spawnReason(err) {
  const msg = String(err?.message || err || '');
  if (/ENOENT/i.test(msg) || err?.code === 'ENOENT') return 'commande introuvable (npm absent du PATH ?)';
  if (/timeout/i.test(msg)) return 'délai dépassé';
  return msg || 'erreur au lancement du processus';
}

/**
 * Construit TOUTES les applications déclarées au profil, DANS un staging isolé.
 *
 * Le moteur ne connaît aucun nom d'application : il construit ce que le profil
 * déclare comme constructible (rôles `web`, `web-sub`, `static`), dans l'ordre
 * du profil.
 *
 * @param {object} [opts]
 * @param {(msg:string)=>void} [opts.onLog]   Log libre (compat historique).
 * @param {(rec:object)=>void} [opts.onPhase] Callback structuré par sous-commande
 *   { phase, command, args, cwd, startedAt, finishedAt, durationMs, code, signal,
 *     stdout, stderr, error }. Sert à alimenter le RunRecorder (rapport).
 * @param {string} [opts.root]        Racine du monorepo.
 * @param {Function} [opts.exec]      Exécuteur (injectable pour les tests).
 * @param {string} [opts.stagingBase] Base des répertoires temporaires.
 * @param {object} [opts.fsMod]       Module fs/promises (injectable pour les tests).
 * @param {object|Array} [opts.profile] Profil de projet (défaut : celui du dépôt).
 * @returns {Promise<{dists:Record<string,string>, appDirs:Record<string,string>,
 *   backendDir:string, stagingRoot:string, web:Record<string,object>,
 *   cleanup:()=>Promise<void>}>}
 *   `dists` (une entrée par application construite) et `appDirs` (une entrée
 *   par application stagée) sont les SEULES sources de vérité des chemins :
 *   aucun alias nommé n'est exposé.
 */
export async function buildArtifact({
  onLog = () => {},
  onPhase = () => {},
  root = PROJECT_ROOT,
  exec = localExec,
  stagingBase = os.tmpdir(),
  fsMod = fs,
  profile,
  // Config PRODUCTION des frontends (baked au build). VITE_API_URL vide = appels
  // RELATIFs (même origine → Nginx proxifie /api vers le backend). C'est le bon
  // choix sur le VPS : robuste, indépendant du domaine, valable pour tout front.
  frontendEnv = { VITE_API_URL: '' },
  // LOT 4 : refuse une source Git « dirty » (défaut en PROD) — on ne déploie
  // jamais des modifications non commitées, pour garantir que le code déployé
  // correspond exactement au commit annoncé.
  requireCleanSource = false,
  builtAt = new Date().toISOString(),
} = {}) {
  const appList = profileApps(profile);
  const PHASE_META = phaseMetaOf(appList);
  const apps = await resolveLayout(root, fsMod, appList);

  // Source Git EXACTE (avant tout build) — sert au garde-fou + au manifeste.
  const git = await getGitSourceInfo(root, exec);
  if (requireCleanSource && git.isGit && git.isDirty) {
    throw new DeploymentError('DEPLOY_SOURCE_DIRTY', 'Source Git non commitée (dirty) : refus de déployer des modifications non commitées. Committez d’abord.', {
      step: 'build', details: { branch: git.branch, commit: git.shortCommit },
    });
  }

  let stagingRoot = null;
  const cleanup = async () => {
    if (stagingRoot) {
      await fsMod.rm(stagingRoot, { recursive: true, force: true }).catch(() => {});
    }
  };

  /** Exécute une phase, journalise (onPhase) et échoue proprement au besoin. */
  const runPhase = async (phase, cmd, args, cwd) => {
    const meta = PHASE_META[phase];
    onLog(`[build] ${meta.label}…`);
    const startedAt = new Date();
    let res;
    let spawnError = null;
    try {
      res = await exec(cmd, args, { cwd });
    } catch (err) {
      spawnError = err;
      res = { code: null, signal: null, stdout: '', stderr: '' };
    }
    const finishedAt = new Date();
    const record = {
      phase,
      command: cmd,
      args,
      cwd,
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      durationMs: finishedAt - startedAt,
      code: res.code,
      signal: res.signal || null,
      stdout: res.stdout || '',
      stderr: res.stderr || '',
      error: spawnError ? String(spawnError.message || spawnError) : null,
    };
    onPhase(record);

    if (spawnError || res.code !== 0) {
      const reason = spawnError
        ? spawnReason(spawnError)
        : `code de sortie ${res.code}${res.signal ? ` (signal ${res.signal})` : ''}`;
      throw new DeploymentError(meta.code, `Échec — ${meta.label} : ${reason}.`, {
        step: 'build',
        details: {
          phase,
          command: `${cmd} ${args.join(' ')}`,
          cwd,
          code: res.code,
          signal: res.signal || null,
          error: record.error,
          // Extrait le plus utile : la FIN de stderr contient l'erreur réelle.
          stderrExcerpt: (res.stderr || res.stdout || record.error || '').slice(-1200),
        },
      });
    }
    return res;
  };

  try {
    stagingRoot = await fsMod.mkdtemp(path.join(stagingBase, BUILD_STAGING_PREFIX));
    // Chemins de staging dérivés du profil : `staged[appId]`.
    const staged = {};
    for (const app of appList) staged[app.id] = path.join(stagingRoot, app.dir);
    // Ce qui est CONSTRUIT vient du rôle, pas du nom.
    const webApps = buildableApps(appList);
    const serverApp = appList.find((app) => app.role === 'server');
    const stBackend = staged[serverApp.id];

    onLog('[build] préparation du staging isolé…');
    try {
      for (const app of appList) {
        // Les rôles serveur (`server`, `worker`) ont des secrets et des dossiers
        // de runtime à exclure ; les fronts, des overrides de dev à neutraliser.
        const isServerSide = app.role === 'server' || app.role === 'worker';
        await copyApp(apps[app.id], staged[app.id], { isBackend: isServerSide, fsMod });
      }
    } catch (err) {
      throw new DeploymentError('ARTIFACT_STAGE_FAILED', `Préparation du staging impossible : ${err.message}.`, {
        step: 'build',
        details: { phase: 'stage', error: String(err.message || err) },
      });
    }

    // Config PRODUCTION des frontends : `.env.production.local` a la priorité la
    // plus haute chez Vite (mode=production). On y force VITE_API_URL (vide =
    // relatif) pour que le bundle déployé n'appelle JAMAIS une URL de dev
    // (localhost/ngrok). Les overrides DEV (.env.local…) ont déjà été exclus.
    const frontEnvContent = `${Object.entries(frontendEnv).map(([k, v]) => `${k}=${v}`).join('\n')}\n`;
    onLog(`[build] config front production : ${Object.entries(frontendEnv).map(([k, v]) => `${k}=${v || '(relatif)'}`).join(', ')}`);
    for (const app of webApps) {
      await fsMod.writeFile(path.join(staged[app.id], '.env.production.local'), frontEnvContent);
    }

    // Ordre du profil : pour chaque application constructible, install puis build.
    for (const app of webApps) {
      await runPhase(installPhaseOf(app), 'npm', ['ci'], staged[app.id]);
      await runPhase(buildPhaseOf(app), 'npm', ['run', 'build'], staged[app.id]);
    }

    // Dossiers `dist` par application, contrôlés après build.
    const dists = {};
    for (const app of webApps) {
      const dir = path.join(staged[app.id], 'dist');
      if (!(await pathExists(dir, fsMod))) {
        throw new DeploymentError(
          app.missingArtifactCode || `ARTIFACT_BUILD_${app.id.toUpperCase()}_MISSING`,
          `Artefact absent après build : ${app.dir}/dist.`,
          { step: 'build', details: { phase: 'verify', path: dir } },
        );
      }
      dists[app.id] = dir;
    }
    // Médias RUNTIME : le dossier uploads VIVANT (hors staging) est la source à
    // synchroniser vers le répertoire PARTAGÉ persistant du VPS. Non versionné,
    // non buildé : simple copie de fichiers.
    const liveUploads = path.join(root, serverApp.dir, 'uploads');
    const uploadsDir = (await pathExists(liveUploads, fsMod)) ? liveUploads : null;

    // MANIFESTE DE VERSION (LOT 5) — généré depuis la VRAIE source construite.
    // Embarqué dans le backend + les deux dist (servi ensuite via /api/version).
    const manifest = {
      project: PROJECT_ID,
      commitHash: git.commitHash,
      shortCommit: git.shortCommit,
      branch: git.branch,
      isDirty: git.isDirty,
      builtAt,
      // Empreintes PAR APPLICATION, clés = identifiants du profil. Aucun alias
      // nommé : un consommateur lit `appArtifactHashes[<id du profil>]`.
      appArtifactHashes: Object.fromEntries(
        await Promise.all(webApps.map(async (app) => [app.id, await hashDir(dists[app.id], fsMod)])),
      ),
      backendSourceHash: await hashDir(path.join(stBackend, 'src'), fsMod),
    };
    const manifestJson = `${JSON.stringify(manifest, null, 2)}\n`;
    await fsMod.writeFile(path.join(stBackend, 'build-manifest.json'), manifestJson);
    // `version.json` est déposé dans le dist de CHAQUE application construite :
    // la boucle suit la composition réelle du projet, quelle qu'elle soit.
    for (const app of webApps) {
      await fsMod.writeFile(path.join(dists[app.id], 'version.json'), manifestJson);
    }

    // Empreintes WEB : servent au contrôle post-déploiement (index + JS servis ==
    // artefact construit). Non embarquées dans le manifeste public.
    const web = Object.fromEntries(
      await Promise.all(webApps.map(async (app) => [app.id, await webFingerprint(dists[app.id], fsMod)])),
    );

    onLog(`[build] artefact prêt (commit ${git.shortCommit || 'n/a'} / ${git.branch || 'n/a'}${git.isDirty ? ' · DIRTY' : ''}).`);
    // Succès : le staging survit jusqu'à l'upload ; l'appelant appelle cleanup().
    // `appDirs` expose le staging de CHAQUE application (y compris `worker`),
    // ce qui permet à l'upload de publier les rôles non-front sans les nommer.
    const appDirs = Object.fromEntries(appList.map((app) => [app.id, staged[app.id]]));
    return { dists, appDirs, backendDir: stBackend, uploadsDir, stagingRoot, cleanup, frontendEnv, manifest, git, web };
  } catch (err) {
    // Échec : on nettoie IMMÉDIATEMENT le staging (atomicité : rien n'est uploadé).
    await cleanup();
    throw err;
  }
}

export default { getProjectVersion, buildArtifact, localExec, PROJECT_ROOT };
