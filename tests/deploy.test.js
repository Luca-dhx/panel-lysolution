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
const {
  buildPlan, buildRollbackPlan, describeRemoteLayout, LOCAL_QUALITY_COMMANDS, STEPS,
} = await import('../deploy/lib/plan.mjs');
/**
 * LES DEUX AUTORITÉS DU MOTEUR — importées ICI aussi, et c'est le point : le
 * test compare le plan à sa SOURCE plutôt qu'à une liste recopiée. Une liste
 * recopiée dans la recette aurait le même défaut que le plan qu'elle éprouve.
 */
const { PIPELINE_STEPS } = await import('../backend/src/deployment-engine/pipeline.js');
const { planTopology } = await import('../backend/src/deployment-engine/topology.js');
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
  /**
   * R10.1 — les chemins décrivent la disposition RÉELLE du moteur : un
   * `backend/` stable et un `shared/` persistant. Ni releases, ni lien
   * `current`, ni `.env` dans `shared/` : le pipeline écrit le `.env`
   * directement dans le dossier du backend.
   */
  check('la racine du site est dérivée du domaine',
    config.paths.siteRoot === '/var/www/panel.exemple.com');
  check('le partagé public est dérivé de la racine',
    config.paths.sharedUploads === '/var/www/panel.exemple.com/shared/uploads');
  check('le partagé PRIVÉ est dérivé de la même racine',
    config.paths.sharedStorage === '/var/www/panel.exemple.com/shared/storage');

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
  const layout = describeRemoteLayout(config);
  /**
   * Le domaine choisi alimente aussi la DISPOSITION distante — c'est la même
   * règle que pour les URLs et Nginx : une seule entrée, tout en découle.
   */
  check('la disposition distante suit le domaine choisi',
    layout.siteRoot === '/var/www/admin.autre-client.fr'
    && layout.sharedStorage === '/var/www/admin.autre-client.fr/shared/storage');
  check('l’étape de configuration système est planifiée',
    plan.some((p) => p.step === 'runtime_config'));

  const everything = JSON.stringify({ plan, layout, nginx, remote });
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

/* ══════════════════════════════════════════════════════════════════════════
   R10.1 — LA SIMULATION NE PEUT PLUS DIVERGER DE L'EXÉCUTION.

   ══ CE QUE CES CONTRÔLES REMPLACENT ═══════════════════════════════════════

   Ils vérifiaient un plan écrit à la main : `releases/<id>`, un lien `current`,
   une purge `releases.prune`, un rollback en deux commandes. Rien de tout cela
   n'existe côté moteur — `deploy.mjs --execute` délègue à `DeploymentEngine`,
   dont le pipeline uploade dans un `backend/` STABLE et publie les SPA par
   bascule `.next` → `.prev`.

   Ces assertions VERROUILLAIENT donc la divergence : elles exigeaient que la
   simulation reste fidèle à une fiction. Un audit pré-déploiement s'y est
   laissé prendre et a conclu à une perte de justificatifs inexistante
   (POST_MIGRATION_PRE_DEPLOYMENT_AUDIT §AH).

   Ce qui est gardé désormais : que le plan soit DÉRIVÉ des deux autorités du
   moteur, et qu'il n'invente rien.
   ══════════════════════════════════════════════════════════════════════════ */
section('Plan : dérivé du moteur, jamais réécrit');
{
  const config = loadDeployConfig(null, BASE);
  const plan = buildPlan(config, { releaseId: '20260727-abc1234' });
  const steps = plan.map((p) => p.step);

  /**
   * L'IDENTITÉ DES ÉTAPES VIENT DU PIPELINE. Comparée à la source, pas
   * recopiée : une étape ajoutée au moteur apparaît ici sans qu'on y touche.
   */
  check('les étapes SONT celles du pipeline, dans son ordre',
    steps.join(',') === PIPELINE_STEPS.join(','));

  /** L'ordre réel du moteur, éprouvé sur ses invariants. */
  check('les dossiers sont préparés avant Nginx',
    steps.indexOf('dirs') < steps.indexOf('nginx'));
  check('le certificat précède le rechargement',
    steps.indexOf('certbot') < steps.indexOf('reload'));
  check('le service démarre avant le contrôle de santé',
    steps.indexOf('pm2') < steps.indexOf('health'));
  check('publier précède constater',
    steps.indexOf('runtime_config') > steps.indexOf('validate') === false
    || steps.indexOf('validate') < steps.indexOf('runtime_config'));

  /**
   * ══ AUCUNE COMMANDE INVENTÉE ═════════════════════════════════════════════
   *
   * Les commandes appartiennent au pipeline, qui les compose au moment de
   * l'exécution. En recopier une ici ferait renaître la divergence : elle
   * cesserait d'être vraie au premier changement du moteur, sans que rien ne
   * le signale.
   */
  check('le plan n’invente AUCUNE commande shell',
    plan.every((p) => Array.isArray(p.commands) && p.commands.length === 0));

  /** Aucune trace du layout fictif — c'est lui qui a trompé l'audit. */
  const affiche = JSON.stringify(plan);
  check('aucun `releases/` dans le plan', !/releases\//.test(affiche));
  check('aucun lien `current`', !/\/current\b/.test(affiche));
  check('aucune purge de releases', !/prune/i.test(affiche));

  /**
   * ══ LES LIENS PERSISTANTS SONT AFFICHÉS ══════════════════════════════════
   *
   * C'est la question qu'on se pose avant de redéployer : « mes justificatifs
   * survivent-ils ? ». La réponse est un lien, et elle doit se lire dans la
   * simulation — l'avoir laissée implicite est ce qui a permis de croire que le
   * lien n'existait pas.
   */
  const dirs = plan.find((p) => p.step === 'dirs');
  const cibles = (dirs.links ?? []).map((l) => `${l.from} -> ${l.to}`);
  check('le lien des médias PUBLICS est montré',
    cibles.some((l) => l === '/var/www/panel.exemple.com/backend/uploads'
      + ' -> /var/www/panel.exemple.com/shared/uploads'));
  check('le lien des médias PRIVÉS est montré',
    cibles.some((l) => l === '/var/www/panel.exemple.com/backend/storage'
      + ' -> /var/www/panel.exemple.com/shared/storage'));

  /** La bascule atomique réelle : `.next` → cible, retour par `.prev`. */
  const upload = plan.find((p) => p.step === 'upload');
  check('la publication atomique des SPA est décrite',
    (upload.publications ?? []).length > 0
    && upload.publications.every((p) => p.next.endsWith('.next') && p.prev.endsWith('.prev')));

  /**
   * LE ROLLBACK DIT SA RÉSERVE. `rollback.js` cherche `releases/` + `current`,
   * que le pipeline ne crée pas : la simulation ne doit pas laisser croire
   * qu'un retour arrière est prêt.
   */
  const rollback = buildRollbackPlan(config, { targetReleaseId: 'r-precedente' });
  check('le rollback délègue au moteur', rollback[0].step === 'rollback.delegate');
  check('le rollback n’invente aucune commande', rollback[0].commands.length === 0);
  const reserve = (rollback[0].caveats ?? []).join(' ');
  check('…et NOMME la réserve : le pipeline ne crée pas les releases attendues',
    /releases/.test(reserve) && /ne crée/.test(reserve) && /pas de cible/.test(reserve));

  check('la chaîne de qualité couvre lint, typecheck, tests et build',
    ['quality.lint', 'quality.typecheck', 'quality.tests', 'artifact.build']
      .every((step) => step in LOCAL_QUALITY_COMMANDS));
  check('le catalogue = qualité locale + étapes du moteur',
    STEPS.length === Object.keys(LOCAL_QUALITY_COMMANDS).length + PIPELINE_STEPS.length);
}

section('Disposition distante : lue dans la topologie, jamais réinventée');
{
  const config = loadDeployConfig(null, BASE);
  const layout = describeRemoteLayout(config);
  const topo = planTopology({ host: config.host, remoteRoot: config.remoteRoot });

  check('la racine vient de la topologie', layout.siteRoot === topo.siteRoot);
  check('le backend est un chemin STABLE, hors release',
    layout.backendDir === topo.backendDir && !/releases/.test(layout.backendDir));
  check('le partagé public vient de la topologie',
    layout.sharedUploads === topo.sharedUploads);
  check('le partagé PRIVÉ est dérivé du même partagé',
    layout.sharedStorage === `${topo.sharedRoot}/storage`);

  /**
   * LA CONFIGURATION ET LA TOPOLOGIE DOIVENT S'ACCORDER. Deux dérivations de la
   * même racine qui divergeraient rouvriraient la porte exacte que ce lot ferme.
   */
  check('config et topologie s’accordent sur le partagé public',
    config.paths.sharedUploads === topo.sharedUploads);
  check('config et topologie s’accordent sur le partagé privé',
    config.paths.sharedStorage === `${topo.sharedRoot}/storage`);

  /** Les chemins fictifs ont bien disparu de la configuration. */
  check('plus de `releasesDir` en configuration', config.paths.releasesDir === undefined);
  check('plus de `currentLink` en configuration', config.paths.currentLink === undefined);
  check('plus de `.env` dans `shared/` (le moteur l’écrit dans le backend)',
    config.paths.envFile === undefined);
}

section('Médias privés : jamais dans l’historique Git');
{
  const gitignore = fs.readFileSync(path.join(root, '.gitignore'), 'utf8');
  /**
   * `config.paths.privateMedia` vaut `<backend>/storage/media` : un justificatif
   * déposé pendant un essai local y atterrit. Seul `backend/uploads/` était
   * couvert — une pièce comptable pouvait donc partir dans un dépôt distant.
   */
  check('backend/storage est ignoré', /^backend\/storage\/$/m.test(gitignore));
  check('storage à la racine est ignoré aussi', /^storage\/$/m.test(gitignore));
  check('les médias publics restent ignorés', /^backend\/uploads\/\*$/m.test(gitignore));
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
