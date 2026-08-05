// DÉPLOIEMENT COMPLET, DE BOUT EN BOUT, SUR LES TROIS TOPOLOGIES.
//
// Même moteur, même code, trois profils : vitrine+manager, front unique, et un
// projet atypique à cinq applications. Chaque déploiement doit traverser TOUTES
// les étapes canoniques jusqu'à `deployment.finalize`, sans ERR_INVALID_ARG_TYPE
// ni WEBSITE_FINGERPRINT_MISSING.
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { check, finish, section } from './helpers/harness.js';
import { ALL_PROFILES, builtIds } from './helpers/profiles.fixture.js';

const { DeploymentEngine } = await import('../backend/src/deployment-engine/DeploymentEngine.js');
const { FakeTransport } = await import('../backend/src/deployment-engine/transport/FakeTransport.js');
const { planTopology } = await import('../backend/src/deployment-engine/topology.js');

const HOST = 'demo-generic.ly-solution.com';
const COMMIT = 'cafe0123456789abcdef0123456789abcdef0123';
const sha256 = (s) => crypto.createHash('sha256').update(Buffer.from(s, 'utf8')).digest('hex');

// Le dist produit par le build simulé — identique pour toutes les applications.
const INDEX_HTML = '<!doctype html><html><head><script type="module" src="/assets/app-TEST1234.js"></script></head><body></body></html>';
const APP_JS = 'console.log("app")';

/** Étapes canoniques que TOUT déploiement réussi doit franchir. */
const REQUIRED_STEPS = [
  'deployment.initialize', 'ssh.connect', 'server.preflight', 'artifact.build',
  'artifact.upload', 'dependencies.install', 'nginx.configure', 'https.configure',
  'services.start', 'services.verify', 'runtime.sync', 'public.healthcheck',
  'deployment.finalize',
];

async function makeSource(profile) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), `e2e-${profile.id}-`));
  for (const app of profile.APPS) {
    const dir = path.join(root, app.dir);
    await fs.mkdir(path.join(dir, 'src'), { recursive: true });
    await fs.writeFile(path.join(dir, 'package.json'), JSON.stringify({ name: app.id }));
    await fs.writeFile(path.join(dir, 'src', 'index.js'), '// x\n');
    if (['web', 'web-sub', 'static'].includes(app.role)) await fs.writeFile(path.join(dir, 'package-lock.json'), '{}');
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

/** VPS simulé en bonne santé, qui « sert » exactement l'artefact construit. */
function healthyVps(topo) {
  const t = new FakeTransport()
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
    .on(/https:\/\/.*\/health/, { stdout: '{"success":true,"data":{"env":"PROD"}}\n200' })
    // Contrôle d'artefact web : index + JS + version.json servis == build.
    .on(/-m 10 'https:\/\/[^']+\/'/, { stdout: INDEX_HTML })
    .on(/\/assets\/app-TEST1234\.js'/, { stdout: APP_JS })
    .on(/\/version\.json'/, { stdout: JSON.stringify({ commitHash: COMMIT }) });
  t.files.set(`${topo.backendDir}/build-manifest.json`, JSON.stringify({ commitHash: COMMIT }));
  return t;
}

for (const profile of ALL_PROFILES) {
  section(`Déploiement complet — profil « ${profile.id} »`);
  const topo = planTopology({ host: HOST, profile });
  const root = await makeSource(profile);
  const tx = healthyVps(topo);

  const report = await new DeploymentEngine({ wildcardBases: ['ly-solution.com'] }).deployWithReport({
    url: `https://${HOST}`,
    transport: tx,
    options: {
      profile,
      backendPort: 4100,
      version: 'e2e',
      buildRoot: root,
      buildExec,
      requireCleanSource: false,
      dnsExpectedIp: '203.0.113.10',
      remoteEnv: {
        ENV: 'PROD', PORT: '4100', MONGODB_URI: 'mongodb://127.0.0.1:27017',
        DB_PROD: 'p', DB_TEST: 't', JWT_SECRET: 'x'.repeat(48), JWT_EXPIRES_IN: '12h',
        BRIDGE_ENCRYPTION_KEY: 'a'.repeat(64), INTEGRATED_API_ENCRYPTION_KEY: 'b'.repeat(64),
      },
      runtimeConfigSync: async ({ urls }) => ({ ok: true, urls, created: true }),
      health: { localRetries: 1, localDelayMs: 0, publicRetries: 1, publicDelayMs: 0 },
      dnsResolutionOpts: { timeoutMs: 400, minIntervalMs: 1, maxIntervalMs: 1 },
    },
  });

  const byId = new Map(report.steps.map((s) => [s.id, s]));
  const failed = report.steps.filter((s) => s.status === 'error');
  if (failed.length) console.error(`    → ${failed.map((s) => `${s.id}:${s.errorCode || ''} ${s.technicalMessage || ''}`).join(' | ')}`);

  check(`[${profile.id}] déploiement RÉUSSI`, report.ok === true && report.status === 'ok');
  check(`[${profile.id}] étape finale = deployment.finalize`, report.finalStepId === 'deployment.finalize');
  check(`[${profile.id}] aucune étape en erreur`, failed.length === 0);

  const missing = REQUIRED_STEPS.filter((id) => !['ok', 'warning', 'skipped'].includes(byId.get(id)?.status));
  check(`[${profile.id}] toutes les étapes canoniques franchies`, missing.length === 0);
  if (missing.length) console.error(`    → manquantes : ${missing.join(', ')}`);

  const md = report.markdownReport;
  check(`[${profile.id}] aucun ERR_INVALID_ARG_TYPE`, !md.includes('ERR_INVALID_ARG_TYPE'));
  check(`[${profile.id}] aucun WEBSITE_FINGERPRINT_MISSING`, !md.includes('WEBSITE_FINGERPRINT_MISSING'));
  // `/dev/null` est légitime dans les commandes shell : on ne cible que les
  // CHEMINS de publication (`…/null`, `…/undefined`, `null.next`).
  const badPath = /\/(?:null|undefined)(?:\.next|\.prev|\/|)/;
  const offending = md.split(/\r?\n/)
    .map((l) => l.replace(/\/dev\/null/g, ''))
    .filter((l) => badPath.test(l));
  check(`[${profile.id}] aucun chemin de publication null/undefined`, offending.length === 0);
  if (offending.length) console.error(`    → ${offending.slice(0, 3).join(' | ').slice(0, 300)}`);

  // L'upload a bien publié UNE application par déclaration du profil.
  const uploadedDirs = tx.uploads.map((u) => u.remotePath);
  const expectedRoots = topo.publishable.map((a) => `${a.remoteRoot}.next`);
  check(`[${profile.id}] une publication par application déclarée`,
    expectedRoots.every((r) => uploadedDirs.includes(r)));
  check(`[${profile.id}] le backend a été uploadé`, uploadedDirs.includes(topo.backendDir));
  check(`[${profile.id}] aucun upload vers un chemin vide`,
    tx.uploads.every((u) => typeof u.localPath === 'string' && u.localPath.length > 0));

  // Nginx : un server_name par hôte servi.
  const conf = [...tx.files.entries()].find(([k]) => k.endsWith('.nginx.conf'))?.[1] ?? '';
  check(`[${profile.id}] Nginx nomme chaque hôte servi`,
    topo.servedHosts.every((h) => conf.includes(`server_name ${h};`)));

  await fs.rm(root, { recursive: true, force: true });
}

section('Comparatif : les trois topologies ont produit des plans DIFFÉRENTS');
{
  const counts = ALL_PROFILES.map((p) => planTopology({ host: HOST, profile: p }).publishable.length);
  check('les plans diffèrent bien (2, 1, 3 applications publiées)', counts.join(',') === '2,1,3');
  check('chaque profil expose ses propres identifiants',
    ALL_PROFILES.every((p) => builtIds(p).length > 0));
}

finish();
