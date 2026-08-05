/**
 * ROLLBACK du moteur de déploiement — testé sans VPS, via un transport
 * simulé qui rejoue un système de fichiers distant.
 *
 * Ce que ces tests verrouillent :
 *  - une release incomplète n'est JAMAIS activée ;
 *  - la bascule de `current` est atomique (ln -sfn) ;
 *  - un rollback en échec RESTAURE la release d'origine ;
 *  - le service est relancé et la santé contrôlée ;
 *  - les refus portent des codes stables.
 */
import {
  rollbackToRelease,
  listReleases,
  currentRelease,
  verifyReleaseIntegrity,
} from '../backend/src/deployment-engine/rollback.js';
import { pm2AppName } from '../backend/src/deployment-engine/pm2.js';

let pass = 0;
let fail = 0;
const check = (name, cond) => {
  if (cond) { pass += 1; console.log(`  ✓ ${name}`); }
  else { fail += 1; console.error(`  ✗ ${name}`); }
};
const section = (t) => console.log(`\n${t}`);

/**
 * Transport simulé : un « serveur » minimal en mémoire.
 * `releases` : { id: { complete: bool } } · `current` : id actif
 * `healthyReleases` : releases dont le backend répond au health check.
 */
function makeTransport({ releases = {}, current = null, healthyReleases = null, failSwitch = false } = {}) {
  // `pm2Path` : chemin que PM2 a mémorisé. `null` = aucun process de ce nom.
  const state = { current, commands: [], restarts: [], pm2Path: null };
  const healthy = healthyReleases ?? Object.keys(releases);
  const tx = {
    kind: 'fake',

    async exec(cmd) {
      state.commands.push(cmd);

      if (/^ls -1 .*\/releases/.test(cmd)) {
        return { code: 0, stdout: Object.keys(releases).join('\n'), stderr: '' };
      }
      if (/^readlink -f/.test(cmd)) {
        return { code: 0, stdout: state.current ? `/var/www/site/releases/${state.current}` : '', stderr: '' };
      }
      if (/^ln -sfn/.test(cmd)) {
        if (failSwitch) return { code: 1, stdout: '', stderr: 'permission denied' };
        const m = cmd.match(/releases\/([^\s]+)\s/);
        state.current = m ? m[1] : state.current;
        return { code: 0, stdout: '', stderr: '' };
      }
      // Contrôles d'intégrité : `test -d … && echo OK || echo KO`
      if (/^test -[df]/.test(cmd)) {
        const m = cmd.match(/releases\/([^/\s]+)/);
        const id = m?.[1];
        const rel = releases[id];
        const ok = rel && (rel.complete !== false || /test -d [^/]*\/releases\/[^/\s]+ &&/.test(cmd));
        return { code: 0, stdout: ok ? 'OK' : 'KO', stderr: '' };
      }

      /**
       * ÉTAT PM2 MODÉLISÉ — répondre « aucun process » à jamais ne l'était pas.
       *
       * PM2 mémorise le chemin du script au premier `start` ; le moteur relit
       * ensuite cette liste pour PROUVER qu'il exécute bien le fichier
       * déployé. Un double qui n'enregistre rien simule un PM2 impossible.
       */
      if (/pm2 jlist/.test(cmd)) {
        const liste = state.pm2Path === null ? [] : [{
          name: pm2AppName('site.exemple.com'),
          pm2_env: {
            pm_exec_path: state.pm2Path,
            pm_cwd: state.pm2Path.replace(/\/src\/server\.js$/, ''),
          },
        }];
        return { code: 0, stdout: JSON.stringify(liste), stderr: '' };
      }
      if (/pm2 delete/.test(cmd)) {
        state.pm2Path = null;
        return { code: 0, stdout: '', stderr: '' };
      }
      if (/pm2 (start|reload)/.test(cmd)) {
        state.restarts.push(state.current);
        // Seul `start` fixe le chemin ; `reload` relance celui déjà mémorisé.
        const demarrage = cmd.match(/cd (\S+) &&[\s\S]*pm2 start (\S+) --name/);
        if (demarrage) state.pm2Path = `${demarrage[1]}/${demarrage[2]}`;
        return { code: 0, stdout: '', stderr: '' };
      }
      if (/pm2 save/.test(cmd)) return { code: 0, stdout: '', stderr: '' };
      if (/curl .*\/health/.test(cmd)) {
        return { code: 0, stdout: healthy.includes(state.current) ? '200' : '000', stderr: '' };
      }
      return { code: 0, stdout: '', stderr: '' };
    },
    async writeFile() {},
    async close() {},
  };
  return { tx, state };
}

// `healthRetries: 1` : aucun scénario n'a besoin d'attendre un service qui
// démarre lentement — on teste la LOGIQUE, pas la patience.
const ARGS = {
  host: 'site.exemple.com', backendPort: 4100, remoteRoot: '/var/www', env: 'TEST',
  healthRetries: 1, healthDelayMs: 1,
};

section('Inventaire des releases');
{
  const { tx } = makeTransport({ releases: { 'r-001': {}, 'r-003': {}, 'r-002': {} }, current: 'r-003' });
  const list = await listReleases(tx, ARGS);
  check('releases triées de la plus récente à la plus ancienne',
    JSON.stringify(list) === JSON.stringify(['r-003', 'r-002', 'r-001']));
  check('release active identifiée', (await currentRelease(tx, ARGS)) === 'r-003');
}

section('Intégrité : une release incomplète est détectée');
{
  const { tx } = makeTransport({ releases: { 'r-ok': {}, 'r-ko': { complete: false } }, current: 'r-ok' });
  const good = await verifyReleaseIntegrity(tx, { ...ARGS, releaseId: 'r-ok' });
  check('release complète : intègre', good.ok === true && good.failed.length === 0);
  const bad = await verifyReleaseIntegrity(tx, { ...ARGS, releaseId: 'r-ko' });
  check('release incomplète : refusée', bad.ok === false && bad.failed.length > 0);
  check('…avec le détail de ce qui manque', bad.failed.every((f) => f.id && f.message));
}

section('Rollback nominal');
{
  const { tx, state } = makeTransport({ releases: { 'r-001': {}, 'r-002': {} }, current: 'r-002' });
  const result = await rollbackToRelease({ transport: tx, ...ARGS });
  check('bascule vers la release précédente', result.ok === true && result.to === 'r-001');
  check('release d’origine mémorisée', result.from === 'r-002');
  check('santé confirmée', result.healthy === true);
  check('lien current effectivement repointé', state.current === 'r-001');
  check('bascule atomique (ln -sfn)', state.commands.some((c) => /^ln -sfn .*r-001/.test(c)));
  check('service relancé après bascule', state.restarts.includes('r-001'));
  check('santé contrôlée après relance', state.commands.some((c) => /curl .*\/health/.test(c)));
  check('étapes journalisées', result.steps.some((s) => s.step === 'rollback.verify' && s.status === 'ok'));
}

section('Rollback vers une release explicite');
{
  const { tx, state } = makeTransport({ releases: { 'r-001': {}, 'r-002': {}, 'r-003': {} }, current: 'r-003' });
  const result = await rollbackToRelease({ transport: tx, ...ARGS, releaseId: 'r-001' });
  check('la release demandée est activée', result.to === 'r-001' && state.current === 'r-001');
}

section('Refus explicites (codes stables)');
{
  const cases = [
    ['aucune release', { releases: {}, current: null }, {}, 'ROLLBACK_NO_RELEASE'],
    ['une seule release, déjà active', { releases: { 'r-1': {} }, current: 'r-1' }, {}, 'ROLLBACK_NO_PREVIOUS_RELEASE'],
    ['release inexistante', { releases: { 'r-1': {}, 'r-2': {} }, current: 'r-2' }, { releaseId: 'r-9' }, 'ROLLBACK_RELEASE_NOT_FOUND'],
    ['release déjà active', { releases: { 'r-1': {}, 'r-2': {} }, current: 'r-2' }, { releaseId: 'r-2' }, 'ROLLBACK_ALREADY_ACTIVE'],
    ['release corrompue', { releases: { 'r-1': { complete: false }, 'r-2': {} }, current: 'r-2' }, { releaseId: 'r-1' }, 'ROLLBACK_RELEASE_CORRUPT'],
  ];
  for (const [label, setup, extra, code] of cases) {
    const { tx } = makeTransport(setup);
    let got = null;
    try { await rollbackToRelease({ transport: tx, ...ARGS, ...extra }); } catch (err) { got = err.code; }
    check(`${label} → ${code}`, got === code);
  }

  // Une release corrompue ne doit RIEN avoir modifié.
  const { tx, state } = makeTransport({ releases: { 'r-1': { complete: false }, 'r-2': {} }, current: 'r-2' });
  try { await rollbackToRelease({ transport: tx, ...ARGS, releaseId: 'r-1' }); } catch { /* attendu */ }
  check('release corrompue : le lien current n’a PAS bougé', state.current === 'r-2');
  check('release corrompue : aucun redémarrage de service', state.restarts.length === 0);
}

section('Rollback en échec : la release d’origine est restaurée');
{
  // La cible est intègre mais son backend ne répond pas au health check.
  const { tx, state } = makeTransport({
    releases: { 'r-001': {}, 'r-002': {} },
    current: 'r-002',
    healthyReleases: ['r-002'], // seule l'ancienne répond
  });
  let code = null;
  try { await rollbackToRelease({ transport: tx, ...ARGS }); } catch (err) { code = err.code; }
  check('échec signalé avec restauration', code === 'ROLLBACK_FAILED_RESTORED');
  check('le site est revenu sur la release qui fonctionnait', state.current === 'r-002');
  check('le service a été relancé sur la release restaurée',
    state.restarts[state.restarts.length - 1] === 'r-002');
}

section('Échec de la bascule elle-même');
{
  const { tx, state } = makeTransport({
    releases: { 'r-001': {}, 'r-002': {} }, current: 'r-002', failSwitch: true,
  });
  let code = null;
  try { await rollbackToRelease({ transport: tx, ...ARGS }); } catch (err) { code = err.code; }
  check('échec de repointage signalé', code === 'ROLLBACK_SWITCH_FAILED' || code === 'ROLLBACK_FAILED_RESTORED');
  check('aucune release fantôme activée', state.current === 'r-002');
}

console.log(`\n${pass} réussis, ${fail} échoués`);
process.exit(fail === 0 ? 0 : 1);
