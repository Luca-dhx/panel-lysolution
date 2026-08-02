// VÉRACITÉ DU RAPPORT DE DÉPLOIEMENT.
//
// Le catalogue d'étapes pose la règle : « chaque étape correspond à une action
// RÉELLEMENT exécutée — aucune étape fictive marquée réussie sans action ».
// Un déploiement réel du Panel a pourtant produit trois affirmations fausses :
//
//   1. `https.configure` : 20 s réels affichés « 1 s » — la durée de la dernière
//      sous-étape (`reload`) écrasait l'intervalle de l'étape canonique, qui
//      agrège `certbot` + `reload` ;
//   2. `runtime.sync` : marquée ✓ alors qu'elle ne faisait RIEN, le Panel
//      n'injectant jamais la capacité de synchronisation ;
//   3. `mediaOk: true` sans qu'aucun média n'ait été vérifié, la sonde
//      `/api/public/bootstrap` (endpoint d'un autre projet) répondant 404.
import { check, finish, section } from './helpers/harness.js';

const { RunRecorder } = await import('../backend/src/deployment-engine/report/RunRecorder.js');
const { createRedactor } = await import('../backend/src/deployment-engine/report/sanitize.js');
const { checkPublicMedia } = await import('../backend/src/deployment-engine/health.js');
const { PUBLIC_MEDIA_PROBE_PATH, RUNTIME_NETWORK_URLS } = await import('../backend/src/deployment-engine/config/project.profile.js');
const { FakeTransport } = await import('../backend/src/deployment-engine/transport/FakeTransport.js');

const recorder = () => new RunRecorder({ redactor: createRedactor([]), identification: {} });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ────────────────────────────────────────────────────────────────────────── */
section('1. Durée d’une étape canonique alimentée par PLUSIEURS étapes brutes');
{
  // `certbot` (long) puis `reload` (court) se projettent tous deux sur
  // `https.configure` : la durée affichée doit couvrir les DEUX.
  const r = recorder();
  r.markStep('https.configure', { status: 'running' });
  await sleep(120);
  r.markStep('https.configure', { status: 'ok', durationMs: 5 });   // fin de `certbot`
  r.markStep('https.configure', { status: 'ok', durationMs: 5 });   // fin de `reload`, très courte

  const step = r.orderedSteps().find((s) => s.id === 'https.configure');
  check('la durée reflète l’intervalle réel début→fin, pas la dernière sous-étape',
    step.durationMs >= 100);
  check('la durée n’est pas celle de la dernière sous-étape (5 ms)', step.durationMs !== 5);
  if (step.durationMs < 100) console.error(`    → durée relevée : ${step.durationMs} ms`);

  // Repli : sans intervalle mesurable, la durée fournie reste utilisée.
  const r2 = recorder();
  r2.markStep('services.start', { status: 'ok', durationMs: 42 });
  check('sans étape « running », la durée fournie sert de repli',
    r2.orderedSteps().find((s) => s.id === 'services.start').durationMs === 42);
}

/* ────────────────────────────────────────────────────────────────────────── */
section('2. `runtime.sync` : la capacité est réellement injectée par le Panel');
{
  const src = await import('node:fs').then((m) => m.readFileSync(
    new URL('../backend/src/services/deployment/deploymentExecutor.service.js', import.meta.url), 'utf8'));

  check('l’orchestrateur importe la synchronisation réseau du moteur',
    src.includes("import { syncRuntimeNetworkConfiguration }"));
  check('l’orchestrateur la passe au moteur (sinon l’étape est un faux vert)',
    /runtimeConfigSync:\s*syncRuntimeNetworkConfiguration/.test(src));
}

/* ────────────────────────────────────────────────────────────────────────── */
section('3. Les clés réseau écrites existent dans le schéma du Panel');
{
  const modele = await import('node:fs').then((m) => m.readFileSync(
    new URL('../backend/src/models/SystemConfiguration.model.js', import.meta.url), 'utf8'));

  // Chaque clé déclarée au profil DOIT exister dans le SystemConfiguration du
  // projet : sinon le déploiement écrit un champ que l'application ne lit jamais.
  const inconnues = Object.keys(RUNTIME_NETWORK_URLS)
    .filter((k) => !new RegExp(`\\b${k}\\s*:`).test(modele));
  check('chaque clé de RUNTIME_NETWORK_URLS existe dans SystemConfiguration.network',
    inconnues.length === 0);
  if (inconnues.length) console.error(`    → absentes du schéma : ${inconnues.join(', ')}`);

  check('le Panel publie bien frontendUrl (et non websiteUrl, qu’il n’a pas)',
    'frontendUrl' in RUNTIME_NETWORK_URLS && !('websiteUrl' in RUNTIME_NETWORK_URLS));
}

/* ────────────────────────────────────────────────────────────────────────── */
section('4. Contrôle des médias : « ok » seulement si une sonde a été exécutée');
{
  // Le Panel n'expose aucune sonde publique : le profil le déclare.
  check('le profil du Panel ne déclare aucune sonde de médias', PUBLIC_MEDIA_PROBE_PATH === null);

  // (a) Aucune sonde déclarée → on le DIT, on ne prétend pas avoir vérifié.
  const tx = new FakeTransport();
  const sansSonde = await checkPublicMedia(tx, 'panel.exemple.com', { path: PUBLIC_MEDIA_PROBE_PATH });
  check('sans sonde : probed=false', sansSonde.probed === false);
  check('sans sonde : aucune requête HTTP n’est émise', tx.commands.length === 0);

  // (b) Sonde déclarée mais injoignable (404) → probed=true, reachable=false.
  const tx404 = new FakeTransport().on('curl -fsS -m 8', { stdout: '__ERR__' });
  const injoignable = await checkPublicMedia(tx404, 'panel.exemple.com', { path: '/api/public/bootstrap' });
  check('sonde 404 : probed=true mais reachable=false',
    injoignable.probed === true && injoignable.reachable === false);

  // (c) Sonde exploitable → contrôle réel.
  const body = JSON.stringify({ logo: '/uploads/logo.png' });
  const txOk = new FakeTransport()
    .on('curl -fsS -m 8', { stdout: body })
    .on('content_type', { stdout: '200 image/png' });
  const verifie = await checkPublicMedia(txOk, 'panel.exemple.com', {
    path: '/api/public/bootstrap', origins: [{ label: 'frontend', host: 'panel.exemple.com' }],
  });
  check('sonde exploitable : probed=true, reachable=true, contrôle effectif',
    verifie.probed === true && verifie.reachable === true && verifie.checked.length === 1);
}

finish();
