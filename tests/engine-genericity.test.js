// GÉNÉRICITÉ DU MOTEUR DE DÉPLOIEMENT.
//
// Preuve, exécutable, que le deployment-engine ne connaît AUCUN nom
// d'application : les trois topologies de référence (vitrine+manager,
// front unique, projet atypique à cinq applications) traversent les mêmes
// fonctions, sans qu'une ligne du moteur ne change.
//
// Contient aussi les GARDE-FOUS de non-retour : toute réapparition d'un
// `vitrineDist`, `managerDist`, `artifact.web.vitrine`… fait échouer la suite.
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { check, finish, section } from './helpers/harness.js';
import { SB_AUTO, PANEL, ATYPIQUE, ALL_PROFILES, builtIds } from './helpers/profiles.fixture.js';

const engineDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'backend', 'src', 'deployment-engine');
const { planTopology } = await import('../backend/src/deployment-engine/topology.js');
const { planSites, servedHosts, renderNginxConfig } = await import('../backend/src/deployment-engine/nginx.js');
const { buildArtifact } = await import('../backend/src/deployment-engine/build.js');
const { deriveNetworkUrls } = await import('../backend/src/deployment-engine/runtimeConfig.js');
const { parseTargetUrl } = await import('../backend/src/deployment-engine/url.js');

const HOST = 'demo.ly-solution.com';
const target = parseTargetUrl(`https://${HOST}`, { wildcardBases: ['ly-solution.com'] });

/* ────────────────────────────────────────────────────────────────────────── */
section('1. Topologie : dérivée du profil, pour les trois projets');
{
  for (const p of ALL_PROFILES) {
    const t = planTopology({ host: HOST, profile: p, remoteRoot: '/var/www' });
    const expectedPublished = builtIds(p);

    check(`[${p.id}] une racine distante par application publiée`,
      t.publishable.map((a) => a.id).join(',') === expectedPublished.join(','));
    check(`[${p.id}] toutes les racines distantes sont des chemins valides`,
      t.publishable.every((a) => typeof a.remoteRoot === 'string' && a.remoteRoot.startsWith(`/var/www/${HOST}/`)));
    check(`[${p.id}] tous les hôtes servis sont des chaînes non vides`,
      t.publishable.every((a) => typeof a.host === 'string' && a.host.endsWith(HOST)));
    check(`[${p.id}] backendDir dérivé du rôle server`,
      typeof t.backendDir === 'string' && t.backendDir.startsWith(`/var/www/${HOST}/`));
    check(`[${p.id}] hôte API dérivé`, t.apiHost === `api.${HOST}`);
  }

  // Topologies attendues, explicitement.
  const sb = planTopology({ host: HOST, profile: SB_AUTO });
  check('[sb-auto] hôtes : site + manager', sb.publishable.map((a) => a.host).join(',') === `${HOST},manager.${HOST}`);
  check('[sb-auto] racines : /vitrine + /manager (inchangé)',
    sb.roots.vitrine === `/var/www/${HOST}/vitrine` && sb.roots.manager === `/var/www/${HOST}/manager`);

  const pan = planTopology({ host: HOST, profile: PANEL });
  check('[panel] un seul front, sur l’hôte principal',
    pan.publishable.length === 1 && pan.publishable[0].host === HOST);
  check('[panel] aucun hôte dérivé à certifier hormis l’API',
    pan.dedicatedCertHosts.join(',') === `api.${HOST}`);

  const at = planTopology({ host: HOST, profile: ATYPIQUE });
  check('[atypique] 3 applications publiées (web, admin, docs) — le worker est exclu',
    at.publishable.map((a) => a.id).join(',') === 'web,admin,docs');
  check('[atypique] le worker n’expose aucun hôte',
    !at.apps.some((a) => a.id === 'worker'));
  check('[atypique] hôtes dérivés : admin + docs + api',
    at.dedicatedCertHosts.join(',') === `admin.${HOST},docs.${HOST},api.${HOST}`);
  check('[atypique] le backend s’appelle « api » et reste résolu par son rôle',
    at.backendDir === `/var/www/${HOST}/api`);
}

/* ────────────────────────────────────────────────────────────────────────── */
section('2. Nginx : un bloc serveur par application déclarée');
{
  for (const p of ALL_PROFILES) {
    const t = planTopology({ host: HOST, profile: p });
    const sites = planSites(target, { profile: p, roots: t.roots, hosts: t.hosts, backendPort: 4100 });
    const staticSites = sites.filter((s) => s.kind === 'static');

    check(`[${p.id}] un bloc statique par application publiée`,
      staticSites.map((s) => s.id).join(',') === builtIds(p).join(','));
    check(`[${p.id}] chaque bloc statique a une racine résolue (jamais null)`,
      staticSites.every((s) => typeof s.root === 'string' && s.root.length > 0));
    check(`[${p.id}] un hôte API proxifié est toujours présent`,
      sites.some((s) => s.kind === 'proxy' && s.host === `api.${HOST}`));

    const conf = renderNginxConfig(target, { profile: p, roots: t.roots, hosts: t.hosts, backendPort: 4100 });
    check(`[${p.id}] la configuration nomme chaque hôte servi`,
      servedHosts(target, { profile: p, hosts: t.hosts }).every((h) => conf.includes(`server_name ${h};`)));
  }
  const atSites = planSites(target, { profile: ATYPIQUE, roots: planTopology({ host: HOST, profile: ATYPIQUE }).roots, backendPort: 4100 });
  check('[atypique] aucun bloc serveur pour le worker', !atSites.some((s) => s.id === 'worker'));
}

/* ────────────────────────────────────────────────────────────────────────── */
section('3. Configuration réseau de la destination : clés déclarées au profil');
{
  for (const p of ALL_PROFILES) {
    const t = planTopology({ host: HOST, profile: p });
    const urls = deriveNetworkUrls({ siteHost: HOST, apiHost: t.apiHost, topology: t });
    check(`[${p.id}] les clés publiées sont exactement celles du profil`,
      Object.keys(urls).join(',') === Object.keys(p.RUNTIME_NETWORK_URLS).join(','));
    check(`[${p.id}] toutes les URLs sont en https`, Object.values(urls).every((u) => u.startsWith('https://')));
  }
  const panUrls = deriveNetworkUrls({ siteHost: HOST, apiHost: `api.${HOST}`, topology: planTopology({ host: HOST, profile: PANEL }) });
  check('[panel] aucune managerUrl inventée', !('managerUrl' in panUrls));
  const sbUrls = deriveNetworkUrls({ siteHost: HOST, apiHost: `api.${HOST}`, topology: planTopology({ host: HOST, profile: SB_AUTO }) });
  check('[sb-auto] managerUrl toujours produite, inchangée', sbUrls.managerUrl === `https://manager.${HOST}`);
  check('[atypique] clés propres au projet (consoleUrl, docsUrl)',
    (() => {
      const u = deriveNetworkUrls({ siteHost: HOST, apiHost: `api.${HOST}`, topology: planTopology({ host: HOST, profile: ATYPIQUE }) });
      return u.consoleUrl === `https://admin.${HOST}` && u.docsUrl === `https://docs.${HOST}`;
    })());
}

/* ────────────────────────────────────────────────────────────────────────── */
section('4. Build : construit ce que le profil déclare, pour les trois projets');
{
  const exec = async (cmd, args, { cwd } = {}) => {
    if (cmd === 'git') {
      if (args[0] === 'rev-parse' && args[1] === 'HEAD') return { code: 0, signal: null, stdout: 'abc1234567890abcdef1234567890abcdef1234\n', stderr: '' };
      if (args[0] === 'rev-parse') return { code: 0, signal: null, stdout: 'main\n', stderr: '' };
      return { code: 0, signal: null, stdout: '', stderr: '' };
    }
    if (cmd === 'npm' && args[0] === 'run' && args[1] === 'build') {
      const dist = path.join(cwd, 'dist');
      await fs.mkdir(path.join(dist, 'assets'), { recursive: true });
      await fs.writeFile(path.join(dist, 'index.html'), '<script type="module" src="/assets/main-abc.js"></script>');
      await fs.writeFile(path.join(dist, 'assets', 'main-abc.js'), 'console.log(1)');
    }
    return { code: 0, signal: null, stdout: '', stderr: '' };
  };
  const exists = async (p) => { try { await fs.access(p); return true; } catch { return false; } };

  for (const p of ALL_PROFILES) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), `gen-${p.id}-`));
    for (const app of p.APPS) {
      const dir = path.join(root, app.dir);
      await fs.mkdir(path.join(dir, 'src'), { recursive: true });
      await fs.writeFile(path.join(dir, 'package.json'), JSON.stringify({ name: app.id }));
      await fs.writeFile(path.join(dir, 'src', 'index.js'), '// x\n');
      if (['web', 'web-sub', 'static'].includes(app.role)) await fs.writeFile(path.join(dir, 'package-lock.json'), '{}');
    }

    let art = null; let err = null;
    try { art = await buildArtifact({ root, exec, profile: p, onLog: () => {} }); } catch (e) { err = e; }
    if (err) console.error(`    → [${p.id}] ${err.code} : ${err.message}`);
    check(`[${p.id}] build réussi`, err === null);

    if (art) {
      check(`[${p.id}] un dist par application constructible`,
        Object.keys(art.dists).join(',') === builtIds(p).join(','));
      check(`[${p.id}] tous les dists sont des chemins (aucun null)`,
        Object.values(art.dists).every((d) => typeof d === 'string' && d.length > 0));
      let versionOk = true;
      for (const id of builtIds(p)) if (!(await exists(path.join(art.dists[id], 'version.json')))) versionOk = false;
      check(`[${p.id}] version.json dans chaque dist`, versionOk);
      check(`[${p.id}] empreinte web par application`,
        builtIds(p).every((id) => typeof art.web[id]?.indexHash === 'string'));
      check(`[${p.id}] manifeste : hashes indexés par identifiant de profil`,
        Object.keys(art.manifest.appArtifactHashes).join(',') === builtIds(p).join(','));
      check(`[${p.id}] appDirs couvre TOUTES les applications (worker compris)`,
        Object.keys(art.appDirs).join(',') === p.APPS.map((a) => a.id).join(','));
      await art.cleanup();
    }
    await fs.rm(root, { recursive: true, force: true });
  }
}

/* ────────────────────────────────────────────────────────────────────────── */
section('5. Garde-fous : aucun nom d’application ne peut revenir dans le moteur');
{
  // Inventaire du cœur (le profil est le SEUL fichier autorisé à nommer).
  const coreFiles = [];
  const walk = (dir) => {
    for (const e of fsSync.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.name.endsWith('.js')) coreFiles.push(full);
    }
  };
  walk(engineDir);
  const CORE = coreFiles.filter((f) => !f.includes(`${path.sep}config${path.sep}`));
  check('le cœur du moteur compte plusieurs fichiers analysés', CORE.length >= 20);

  // Code seul : on retire commentaires de bloc, de ligne, et chaînes littérales.
  const codeOf = (src) => src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/^\s*\/\/.*$/gm, ' ')
    .replace(/(['"`])(?:\\.|(?!\1)[\s\S])*?\1/g, "''");

  // Identifiants INTERDITS : ils encodent un nom d'application dans le moteur.
  const BANNED = [
    'vitrineDist', 'managerDist', 'vitrineArtifactHash', 'managerArtifactHash',
    'deriveManagerHost', 'deriveManagerUrl', 'managerRoot', 'webVitrine', 'webManager',
    'managerRelative', 'managerPublic', 'managerNext',
  ];
  for (const name of BANNED) {
    const hits = CORE.filter((f) => new RegExp(`\\b${name}\\b`).test(codeOf(fsSync.readFileSync(f, 'utf8'))));
    check(`aucun \`${name}\` dans le cœur du moteur`, hits.length === 0);
    if (hits.length) console.error(`    → ${hits.map((h) => path.relative(engineDir, h)).join(', ')}`);
  }

  // Accès indexés par un nom d'application : `.web.vitrine`, `dists.manager`…
  const APP_NAMES = ['vitrine', 'manager', 'frontend', 'admin', 'docs'];
  const CONTAINERS = ['web', 'dists', 'roots', 'hosts', 'apps', 'appDirs', 'appArtifactHashes'];
  let indexedHits = [];
  for (const f of CORE) {
    const code = codeOf(fsSync.readFileSync(f, 'utf8'));
    for (const c of CONTAINERS) {
      for (const n of APP_NAMES) {
        if (new RegExp(`\\b${c}\\s*\\??\\.\\s*${n}\\b`).test(code)) {
          indexedHits.push(`${path.relative(engineDir, f)} : ${c}.${n}`);
        }
      }
    }
  }
  check('aucun accès du type `artifact.web.vitrine` / `dists.manager` dans le cœur', indexedHits.length === 0);
  if (indexedHits.length) console.error(`    → ${indexedHits.join(' · ')}`);

  // Le cœur ne doit plus contenir AUCUN nom d'application dans son CODE (les
  // commentaires restent libres d'expliquer l'histoire).
  //
  // Seule exception, explicitement listée : le CHANGELOG des migrations, qui
  // relate des étapes manuelles passées. Y réécrire l'histoire serait falsifier
  // un journal ; la ligne ne pilote aucun comportement.
  const ALLOWED = new Map([[path.join('migrations', 'index.js'), /Retirer toute logique de rollback des assistants/]]);
  const nameHits = [];
  for (const f of CORE) {
    const rel = path.relative(engineDir, f);
    const raw = codeOf(fsSync.readFileSync(f, 'utf8'));
    const allow = ALLOWED.get(rel);
    for (const [i, line] of raw.split('\n').entries()) {
      if (allow && allow.test(line)) continue;
      const m = line.match(/\b(vitrine|Vitrine|manager|Manager|frontend|Frontend|admin|docs)\b/);
      if (m) nameHits.push(`${rel}:${i + 1} → ${m[1]}`);
    }
  }
  check('aucun nom d’application dans le code du cœur (hors changelog listé)', nameHits.length === 0);
  if (nameHits.length) console.error(`    → ${nameHits.slice(0, 8).join(' · ')}`);

  // L'étape canonique nommée d'après une application a disparu du catalogue.
  const steps = fsSync.readFileSync(path.join(engineDir, 'steps.js'), 'utf8');
  check('l’étape canonique `dns.manager` a été remplacée par `dns.apps`',
    !steps.includes("'dns.manager'") && steps.includes("'dns.apps'"));
}

finish();
