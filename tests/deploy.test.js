// Socle de déploiement : la configuration est validée, le domaine choisi se
// propage partout, aucun secret ne fuit, le plan est cohérent.
// Tout est vérifiable hors serveur (le plan est une donnée).
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { check, finish, section } from './helpers/harness.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const { loadDeployConfig, deriveUrls, REQUIRED_REMOTE_ENV } = await import('../deploy/lib/config.mjs');
const { buildPlan, buildRollbackPlan, LOCAL_QUALITY_COMMANDS, STEPS } = await import('../deploy/lib/plan.mjs');
const { buildRemoteEnv, parseEnvFile, serializeEnv, validateRemoteEnv } = await import('../deploy/lib/remoteEnv.mjs');
const { renderNginxConfig, renderNginxHttpOnly } = await import('../deploy/lib/nginx.mjs');

const BASE = {
  host: 'panel.exemple.com',
  environment: 'PROD',
  sshHost: '203.0.113.10',
  backendPort: 4100,
};

section('Configuration : validée avant toute action');
{
  const config = loadDeployConfig(null, BASE);
  check('configuration valide acceptée', config.host === 'panel.exemple.com');
  check('valeurs par défaut posées', config.sshUser === 'root' && config.keepReleases === 5);
  check('chemins de release dérivés',
    config.paths.currentLink === '/var/www/panel.exemple.com/current'
    && config.paths.releasesDir === '/var/www/panel.exemple.com/releases');
  check('le .env distant vit dans shared (jamais dans une release)',
    config.paths.envFile === '/var/www/panel.exemple.com/shared/.env');

  const refusals = [
    ['host manquant', { ...BASE, host: undefined }],
    ['host avec protocole', { ...BASE, host: 'https://panel.exemple.com' }],
    ['host avec port', { ...BASE, host: 'panel.exemple.com:443' }],
    ['host avec chemin', { ...BASE, host: 'panel.exemple.com/admin' }],
    ['environment invalide', { ...BASE, environment: 'STAGING' }],
    ['sshHost manquant', { ...BASE, sshHost: undefined }],
    ['port non entier', { ...BASE, backendPort: 'abc' }],
    ['keepReleases nul', { ...BASE, keepReleases: 0 }],
  ];
  for (const [label, input] of refusals) {
    let refused = false;
    try { loadDeployConfig(null, input); } catch { refused = true; }
    check(`${label} refusé`, refused);
  }
}

section('Le domaine choisi alimente TOUT — aucune valeur figée');
{
  const config = loadDeployConfig(null, { ...BASE, host: 'admin.autre-client.fr' });
  const urls = deriveUrls('admin.autre-client.fr');
  // Le backend est TOUJOURS `api.<frontend>` — c'est la règle unifiée avec
  // SB Auto : un seul domaine saisi, un sous-domaine API dérivé.
  check('URLs dérivées du domaine',
    urls.frontendUrl === 'https://admin.autre-client.fr'
    && urls.backendUrl === 'https://api.admin.autre-client.fr');

  const remote = buildRemoteEnv({ ENV: 'TEST', PORT: '9999', MONGODB_URI: 'mongodb://x' }, config);
  check('ENV imposé par le déploiement', remote.ENV === 'PROD');
  check('PORT imposé par le déploiement', remote.PORT === '4100');
  check('PUBLIC_URL dérivée du domaine', remote.PUBLIC_URL === 'https://api.admin.autre-client.fr');
  // Les DEUX origines sont autorisées : le frontend appelle encore ses chemins
  // relatifs, et le backend canonique répond aussi directement.
  check('CORS_ORIGINS couvrent les deux origines',
    remote.CORS_ORIGINS === 'https://admin.autre-client.fr,https://api.admin.autre-client.fr');

  const nginx = renderNginxConfig(config);
  check('Nginx : server_name = domaine choisi', nginx.includes('server_name admin.autre-client.fr;'));
  check('Nginx : certificat au chemin du domaine',
    nginx.includes('/etc/letsencrypt/live/admin.autre-client.fr/fullchain.pem'));
  check('Nginx : proxy vers le port configuré', nginx.includes('proxy_pass http://127.0.0.1:4100;'));

  const plan = buildPlan(config, { releaseId: 'r1' });
  const runtime = plan.find((p) => p.step === 'runtime.network');
  check('la configuration système reçoit le domaine',
    runtime.commands[0].includes('--backend-url https://api.admin.autre-client.fr')
    && runtime.commands[0].includes('--frontend-url https://admin.autre-client.fr'));

  const everything = JSON.stringify({ plan, nginx, remote });
  check('aucun domaine du projet modèle ne subsiste',
    !/ly-solution\.com|sbauto|sb-auto/i.test(everything));
  check('aucun domaine d’exemple ne subsiste', !everything.includes('panel.exemple.com'));
}

section('Validation du .env distant : fail-closed');
{
  const config = loadDeployConfig(null, BASE);
  const complete = buildRemoteEnv({
    MONGODB_URI: 'mongodb://127.0.0.1:27017',
    DB_TEST: 'panel_test',
    DB_PROD: 'panel_prod',
    JWT_SECRET: 'x'.repeat(64),
    JWT_EXPIRES_IN: '12h',
    BRIDGE_ENCRYPTION_KEY: 'a'.repeat(64),
  }, config);
  check('.env complet validé', validateRemoteEnv(complete).valid);

  for (const key of REQUIRED_REMOTE_ENV) {
    const broken = { ...complete, [key]: '' };
    const result = validateRemoteEnv(broken);
    check(`${key} vide → déploiement refusé`, !result.valid && result.missing.includes(key));
  }

  const missingProdDb = { ...complete };
  delete missingProdDb.DB_PROD;
  check('DB_PROD absente en PROD → refusé', !validateRemoteEnv(missingProdDb).valid);

  const testEnv = { ...complete, ENV: 'TEST' };
  delete testEnv.DB_TEST;
  check('DB_TEST absente en TEST → refusé', !validateRemoteEnv(testEnv).valid);

  check('variables locales non transportées',
    buildRemoteEnv({ PANEL_SKIP_DOTENV: '1', PANEL_DEBUG: '1' }, config).PANEL_SKIP_DOTENV === undefined);
}

section('Aller-retour du .env : écriture puis relecture');
{
  const original = {
    ENV: 'PROD', PORT: '4100', MONGODB_URI: 'mongodb://user:pass@h/db',
    JWT_SECRET: 'x'.repeat(64), JWT_EXPIRES_IN: '12h',
    BRIDGE_ENCRYPTION_KEY: 'a'.repeat(64), DB_PROD: 'panel_prod',
  };
  const reread = parseEnvFile(serializeEnv(original));
  check('relecture fidèle', Object.entries(original).every(([k, v]) => reread[k] === v));
  check('commentaires et lignes vides ignorés',
    Object.keys(parseEnvFile('# titre\n\nA=1\n')).length === 1);
  check('les « = » de la valeur sont préservés',
    parseEnvFile('MONGODB_URI=mongodb://a?b=c&d=e').MONGODB_URI === 'mongodb://a?b=c&d=e');
}

section('Plan : ordre, atomicité, rollback, rétention');
{
  const config = loadDeployConfig(null, BASE);
  const plan = buildPlan(config, { releaseId: '20260727-abc1234' });
  const steps = plan.map((p) => p.step);

  check('la santé locale précède l’exposition publique',
    steps.indexOf('health.local') < steps.indexOf('health.public'));
  check('le certificat précède la configuration HTTPS',
    steps.indexOf('https.certificate') < steps.indexOf('nginx.https'));
  check('le domaine est écrit en base avant le contrôle public',
    steps.indexOf('runtime.network') < steps.indexOf('health.public'));
  check('la purge des anciennes releases arrive en dernier',
    steps[steps.length - 1] === 'releases.prune');

  const start = plan.find((p) => p.step === 'service.start');
  check('bascule atomique par lien symbolique',
    start.commands[0].startsWith('ln -sfn /var/www/panel.exemple.com/releases/20260727-abc1234'));

  const prune = plan.find((p) => p.step === 'releases.prune');
  check('rétention limitée aux 5 dernières', prune.commands[0].includes('tail -n +6'));

  const rollback = buildRollbackPlan(config, { targetReleaseId: 'r-precedente' });
  check('le rollback vérifie que la release existe AVANT de basculer',
    rollback[0].commands[0].startsWith('test -d '));
  check('le rollback repointe le lien', rollback[0].commands[1].includes('ln -sfn'));
  check('le rollback est suivi d’un contrôle de santé',
    rollback[1].healthCheck?.url.endsWith('/health'));

  check('la chaîne de qualité couvre lint, typecheck, tests et build',
    ['quality.lint', 'quality.typecheck', 'quality.tests', 'artifact.build']
      .every((step) => step in LOCAL_QUALITY_COMMANDS));
  check('le catalogue d’étapes est complet', STEPS.length === 15);
}

section('Nginx : configuration en deux temps et cache correct');
{
  const config = loadDeployConfig(null, BASE);
  const httpOnly = renderNginxHttpOnly(config);
  check('phase 1 : HTTP seul (aucun certificat référencé)',
    httpOnly.includes('listen 80;') && !httpOnly.includes('ssl_certificate'));
  check('phase 1 : challenge ACME servi', httpOnly.includes('/.well-known/acme-challenge/'));

  const full = renderNginxConfig(config);
  check('phase 2 : redirection HTTP → HTTPS', full.includes('return 301 https://$host$request_uri;'));
  check('phase 2 : HTTPS actif', full.includes('listen 443 ssl;'));
  check('la surface de pont est exposée', full.includes('location /bridge/'));
  check('index.html jamais mis en cache', full.includes('add_header Cache-Control "no-cache"'));
  check('les assets versionnés sont immuables', full.includes('public, immutable'));
  check('repli SPA', full.includes('try_files $uri $uri/ /index.html'));
  check('les fichiers générés sont signés', full.startsWith('# Généré par le moteur de déploiement'));
}

section('Simulation : le plan s’affiche, rien ne s’exécute, aucun secret ne fuit');
{
  const output = execFileSync(process.execPath, [
    path.join(root, 'deploy', 'deploy.mjs'),
    '--config', path.join(root, 'deploy', 'deploy.config.example.json'),
    '--host', 'panel-recette.exemple.net',
  ], { encoding: 'utf8', cwd: root });

  check('la simulation aboutit', output.includes('Simulation terminée'));
  check('mode simulation annoncé', output.includes('SIMULATION'));
  check('le domaine passé en option prime sur le fichier',
    output.includes('panel-recette.exemple.net'));
  check('la validation du .env est passée', output.includes('variables prêtes'));

  const localEnv = parseEnvFile(fs.readFileSync(path.join(root, 'backend', '.env'), 'utf8'));
  check('le JWT_SECRET local n’apparaît jamais dans la sortie',
    localEnv.JWT_SECRET.length > 0 && !output.includes(localEnv.JWT_SECRET));
  check('la clé de chiffrement n’apparaît jamais dans la sortie',
    localEnv.BRIDGE_ENCRYPTION_KEY.length > 0 && !output.includes(localEnv.BRIDGE_ENCRYPTION_KEY));
  check('l’URI Mongo n’apparaît jamais dans la sortie',
    !output.includes(localEnv.MONGODB_URI));
  check('les valeurs sensibles sont marquées « redacted » si affichées',
    !/JWT_SECRET=(?!«redacted»)/.test(output));
}

section('Aucun secret dans le dépôt');
{
  const tracked = execFileSync('git', ['ls-files'], { encoding: 'utf8', cwd: root })
    .split('\n').filter(Boolean);
  check('backend/.env n’est pas suivi par Git', !tracked.includes('backend/.env'));
  check('aucun fichier .env réel suivi',
    !tracked.some((file) => /(^|\/)\.env$/.test(file)));
  check('deploy.config.json (secrets d’infra) n’est pas suivi',
    !tracked.includes('deploy/deploy.config.json'));
  check('seul l’exemple de configuration est versionné',
    tracked.includes('deploy/deploy.config.example.json'));
}

finish();
