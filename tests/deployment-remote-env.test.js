// `.env` DISTANT : la chaîne complète, du `.env` local du Panel au fichier
// réellement écrit sur le VPS.
//
// Régression couverte : l'orchestrateur du Panel étalait l'ENVELOPPE retournée
// par `buildRemoteEnv()` — `{ remoteEnv, dbName, env, sourcePath }` — au lieu de
// son champ `.remoteEnv`. Le `.env` distant ne contenait donc aucune variable
// utile, seulement `remoteEnv=[object Object]`, et le déploiement échouait à
// `dependencies.install` en signalant ENV, MONGODB_URI, DB_TEST, JWT_SECRET…
// absents, alors que le Panel les possédait toutes localement.
//
// Second point couvert : la liste des variables exigées à la relecture vient du
// PROFIL (`REQUIRED_REMOTE_ENV`), jamais d'une constante — le Panel n'a pas
// d'INTEGRATED_API_ENCRYPTION_KEY et n'en aura jamais.
import path from 'node:path';
import { check, finish, section } from './helpers/harness.js';

const { buildRemoteEnv } = await import('../backend/src/deployment-engine/deployEnv.js');
const { parseTargetUrl } = await import('../backend/src/deployment-engine/url.js');
const { runPipeline } = await import('../backend/src/deployment-engine/pipeline.js');
const { FakeTransport } = await import('../backend/src/deployment-engine/transport/FakeTransport.js');
const { REQUIRED_REMOTE_ENV } = await import('../backend/src/deployment-engine/config/project.profile.js');

const HOST = 'panel-env.ly-solution.com';
const target = parseTargetUrl(`https://${HOST}`, { wildcardBases: ['ly-solution.com'] });

/** `.env` source minimal du Panel (aucune valeur réelle du dépôt). */
const SOURCE = {
  ENV: 'TEST',
  PORT: '6070',
  MONGODB_URI: 'mongodb+srv://u:p@cluster.mongodb.net',
  DB_TEST: 'panel_test',
  DB_PROD: 'panel_prod',
  JWT_SECRET: 'j'.repeat(64),
  JWT_EXPIRES_IN: '12h',
  BRIDGE_ENCRYPTION_KEY: 'b'.repeat(64),
  PANEL_NAME: 'Panel',
};

/** Variables dont l'absence casse le démarrage du backend distant. */
const dbKeyFor = (env) => (String(env).toUpperCase() === 'PROD' ? 'DB_PROD' : 'DB_TEST');
const requiredFor = (env) => REQUIRED_REMOTE_ENV.map((k) => (k === '__DB_FOR_ENV__' ? dbKeyFor(env) : k));

/* ────────────────────────────────────────────────────────────────────────── */
section('1. buildRemoteEnv() : une ENVELOPPE, dont seul `.remoteEnv` porte les variables');
{
  const built = buildRemoteEnv(target, { env: 'TEST', source: { ...SOURCE } });

  check('le retour est une enveloppe à 4 champs',
    Object.keys(built).sort().join(',') === 'dbName,env,remoteEnv,sourcePath');
  check('`.remoteEnv` porte les variables, pas l’enveloppe',
    typeof built.remoteEnv === 'object' && Object.keys(built.remoteEnv).length >= 8);

  // Le PIÈGE exact de la régression : étaler l'enveloppe ne produit AUCUNE variable.
  const etalementFautif = { ...built };
  check('étaler l’enveloppe ne produit aucune variable requise',
    requiredFor('TEST').every((k) => etalementFautif[k] === undefined));
  check('étaler l’enveloppe produit un champ `remoteEnv` non sérialisable en .env',
    String(etalementFautif.remoteEnv) === '[object Object]');

  // La forme CORRECTE.
  const correct = { ...built.remoteEnv, PORT: '4100' };
  const manquantes = requiredFor('TEST').filter((k) => !correct[k] || !String(correct[k]).trim());
  check('`.remoteEnv` fournit toutes les variables exigées par le profil', manquantes.length === 0);
  if (manquantes.length) console.error(`    → ${manquantes.join(', ')}`);
}

/* ────────────────────────────────────────────────────────────────────────── */
section('2. Contenu du .env distant : chaque variable du profil est renseignée');
{
  for (const env of ['TEST', 'PROD']) {
    const { remoteEnv } = buildRemoteEnv(target, { env, source: { ...SOURCE } });
    const vides = requiredFor(env).filter((k) => !remoteEnv[k] || !String(remoteEnv[k]).trim());
    check(`[${env}] aucune variable requise vide`, vides.length === 0);
    if (vides.length) console.error(`    → ${vides.join(', ')}`);
    check(`[${env}] ENV vaut bien l’environnement visé`, remoteEnv.ENV === env);
    check(`[${env}] la base correspond à l’ENV`, remoteEnv[dbKeyFor(env)] === SOURCE[dbKeyFor(env)]);
    check(`[${env}] les secrets sont repris VERBATIM du .env source`,
      remoteEnv.JWT_SECRET === SOURCE.JWT_SECRET && remoteEnv.BRIDGE_ENCRYPTION_KEY === SOURCE.BRIDGE_ENCRYPTION_KEY);
  }

  // Le Panel n'a pas d'IntegratedAPI : le moteur ne doit jamais la réclamer.
  check('le profil du Panel n’exige pas INTEGRATED_API_ENCRYPTION_KEY',
    !REQUIRED_REMOTE_ENV.includes('INTEGRATED_API_ENCRYPTION_KEY'));
  check('le profil du Panel exige bien BRIDGE_ENCRYPTION_KEY',
    REQUIRED_REMOTE_ENV.includes('BRIDGE_ENCRYPTION_KEY'));
}

/* ────────────────────────────────────────────────────────────────────────── */
section('3. Pipeline : le .env écrit sur le VPS est relu et validé');
{
  /** VPS simulé : `writeFile` puis `readFile` sur le même FS virtuel. */
  const vps = () => new FakeTransport()
    .on('npm ci', { stdout: 'ok' })
    .on(/curl|health/, { stdout: '200' });

  const artifact = {
    dists: { frontend: '/local/frontend/dist' },
    backendDir: '/local/backend',
    web: { frontend: { indexHash: 'h', mainJs: null } },
    manifest: {},
  };

  // (a) Forme CORRECTE : l'étape `dirs` passe.
  {
    const tx = vps();
    const { remoteEnv } = buildRemoteEnv(target, { env: 'TEST', source: { ...SOURCE } });
    const res = await runPipeline({
      transport: tx, target, artifact, version: 'v',
      options: { backendPort: 4100, env: 'TEST', remoteEnv: { ...remoteEnv, PORT: '4100' }, health: { localRetries: 1, localDelayMs: 0, publicRetries: 1, publicDelayMs: 0 } },
    });
    const dirs = res.steps.find((s) => s.step === 'dirs');
    check('.env complet → étape `dirs` réussie', dirs?.status === 'ok');
    check('.env complet → aucune erreur ENV_WRITE_INCOMPLETE', res.error?.code !== 'ENV_WRITE_INCOMPLETE');

    const ecrit = tx.files.get('/var/www/panel-env.ly-solution.com/backend/.env') ?? '';
    const relu = {};
    for (const l of ecrit.split(/\r?\n/)) { const m = l.match(/^\s*([A-Z0-9_]+)\s*=(.*)$/); if (m) relu[m[1]] = m[2]; }
    const vides = requiredFor('TEST').filter((k) => !relu[k] || !relu[k].trim());
    check('le fichier RÉELLEMENT écrit contient chaque variable du profil, non vide', vides.length === 0);
    if (vides.length) console.error(`    → ${vides.join(', ')}`);
    check('le fichier écrit ne contient aucun « [object Object] »', !ecrit.includes('[object Object]'));
    check('le fichier écrit ne contient pas les champs de l’enveloppe',
      !/^\s*(remoteEnv|dbName|sourcePath)\s*=/m.test(ecrit));
  }

  // (b) Forme FAUTIVE (l'enveloppe étalée) : l'étape `dirs` DOIT échouer.
  {
    const tx = vps();
    const enveloppe = buildRemoteEnv(target, { env: 'TEST', source: { ...SOURCE } });
    const res = await runPipeline({
      transport: tx, target, artifact, version: 'v',
      options: { backendPort: 4100, env: 'TEST', remoteEnv: { ...enveloppe, PORT: '4100' }, health: { localRetries: 1, localDelayMs: 0, publicRetries: 1, publicDelayMs: 0 } },
    });
    check('enveloppe étalée → échec explicite à `dirs`', res.ok === false && res.failedStep === 'dirs');
    check('enveloppe étalée → code ENV_WRITE_INCOMPLETE', res.error?.code === 'ENV_WRITE_INCOMPLETE');
  }
}

/* ────────────────────────────────────────────────────────────────────────── */
section('4. Aucune donnée technique n’est demandée à l’utilisateur');
{
  // Toutes les variables requises proviennent du `.env` du Panel — aucune n'est
  // saisie par l'opérateur ni portée par la destination.
  const { remoteEnv } = buildRemoteEnv(target, { env: 'TEST', source: { ...SOURCE } });
  const fournieParLaSource = requiredFor('TEST').filter((k) => k !== 'ENV' && k !== 'PORT');
  check('chaque secret/URI vient du .env du projet, jamais d’une saisie',
    fournieParLaSource.every((k) => remoteEnv[k] === SOURCE[k]));
  check('ENV et PORT sont posés par le moteur lui-même',
    remoteEnv.ENV === 'TEST' && typeof remoteEnv.PORT === 'string');

  // Une destination NOUVELLE (aucun extraEnv) est immédiatement déployable.
  const nouvelle = { ...remoteEnv, PORT: '4321' };
  const vides = requiredFor('TEST').filter((k) => !nouvelle[k] || !String(nouvelle[k]).trim());
  check('une destination neuve dispose immédiatement de tout le nécessaire', vides.length === 0);
}

finish();
