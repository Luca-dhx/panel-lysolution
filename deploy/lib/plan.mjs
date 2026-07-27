// Le PLAN de déploiement : la liste ordonnée des étapes et, pour chacune,
// les commandes distantes exactes. Séparer le plan de son exécution permet
// de le vérifier entièrement en mode simulation (--dry-run) et de le
// tester sans serveur.
import { renderNginxConfig, renderNginxHttpOnly } from './nginx.mjs';

export const STEPS = Object.freeze([
  'validate.env',
  'quality.lint',
  'quality.typecheck',
  'quality.tests',
  'artifact.build',
  'artifact.upload',
  'release.install',
  'nginx.http',
  'https.certificate',
  'nginx.https',
  'service.start',
  'health.local',
  'runtime.network',
  'health.public',
  'releases.prune',
]);

// Commandes locales de qualité — exécutées AVANT toute action distante :
// on ne déploie jamais un artefact qui n'a pas passé la chaîne complète.
export const LOCAL_QUALITY_COMMANDS = Object.freeze({
  'quality.lint': { cwd: 'frontend', command: 'npm run lint' },
  'quality.typecheck': { cwd: 'frontend', command: 'npm run typecheck' },
  'quality.tests': { cwd: 'backend', command: 'npm test' },
  'artifact.build': { cwd: 'frontend', command: 'npm run build' },
});

export function buildPlan(deployConfig, { releaseId }) {
  const { host, paths, backendPort, serviceName, keepReleases, environment, urls } = deployConfig;
  const releaseDir = `${paths.releasesDir}/${releaseId}`;
  const nginxAvailable = `/etc/nginx/sites-available/${host}.conf`;
  const nginxEnabled = `/etc/nginx/sites-enabled/${host}.conf`;

  return [
    {
      step: 'release.install',
      description: 'Préparer les dossiers, lier les ressources partagées et installer les dépendances',
      commands: [
        `mkdir -p ${paths.releasesDir} ${paths.sharedDir}`,
        `mkdir -p ${releaseDir}`,
        `ln -sfn ${paths.envFile} ${releaseDir}/backend/.env`,
        `cd ${releaseDir}/backend && npm ci --omit=dev`,
      ],
    },
    {
      step: 'nginx.http',
      description: 'Installer la configuration Nginx HTTP (challenge ACME)',
      writeFiles: [{ path: `/tmp/${host}.http.conf`, content: renderNginxHttpOnly(deployConfig) }],
      commands: [
        `mv /tmp/${host}.http.conf ${nginxAvailable}`,
        `ln -sfn ${nginxAvailable} ${nginxEnabled}`,
        'nginx -t',
        'systemctl reload nginx',
      ],
    },
    {
      step: 'https.certificate',
      description: 'Obtenir ou renouveler le certificat Let’s Encrypt',
      commands: [
        `mkdir -p /var/www/certbot`,
        `certbot certonly --webroot -w /var/www/certbot -d ${host} --agree-tos --non-interactive --keep-until-expiring`,
      ],
    },
    {
      step: 'nginx.https',
      description: 'Installer la configuration Nginx HTTPS complète',
      writeFiles: [{ path: `/tmp/${host}.conf`, content: renderNginxConfig(deployConfig) }],
      commands: [
        `mv /tmp/${host}.conf ${nginxAvailable}`,
        'nginx -t',
        'systemctl reload nginx',
      ],
    },
    {
      step: 'service.start',
      description: 'Basculer le lien « current » puis (re)démarrer le service',
      commands: [
        // La bascule du lien symbolique est le point de non-retour : tout ce
        // qui précède est réversible sans toucher à la release active.
        `ln -sfn ${releaseDir} ${paths.currentLink}`,
        `cd ${paths.currentLink}/backend && PORT=${backendPort} ENV=${environment} pm2 startOrReload ecosystem.config.cjs --update-env || pm2 start src/server.js --name ${serviceName} --update-env`,
        'pm2 save',
      ],
    },
    {
      step: 'health.local',
      description: 'Vérifier la santé du backend en local (avant exposition)',
      healthCheck: { url: `http://127.0.0.1:${backendPort}/health`, expectEnv: environment },
      commands: [
        `curl -fsS --retry 8 --retry-delay 2 http://127.0.0.1:${backendPort}/health`,
      ],
    },
    {
      step: 'runtime.network',
      description: 'Écrire le domaine choisi dans la configuration système du Panel',
      commands: [
        `cd ${paths.currentLink}/backend && node scripts/set-network-configuration.mjs --backend-url ${urls.backendUrl} --frontend-url ${urls.frontendUrl}`,
      ],
    },
    {
      step: 'health.public',
      description: 'Vérifier la santé publique et la version publiée',
      healthCheck: { url: `${urls.backendUrl}/health`, expectEnv: environment },
      commands: [
        `curl -fsS --retry 5 --retry-delay 3 ${urls.backendUrl}/health`,
        `curl -fsS ${urls.backendUrl}/api/version`,
      ],
    },
    {
      step: 'releases.prune',
      description: `Conserver les ${keepReleases} dernières releases`,
      commands: [
        `cd ${paths.releasesDir} && ls -1t | tail -n +${keepReleases + 1} | xargs -r rm -rf`,
      ],
    },
  ];
}

// Rollback : on repointe « current » vers la release précédente et on
// redémarre. Aucune donnée n'est touchée — les migrations Mongo restent la
// responsabilité de leur lot.
export function buildRollbackPlan(deployConfig, { targetReleaseId }) {
  const { paths, backendPort, environment, serviceName, urls } = deployConfig;
  return [
    {
      step: 'rollback.switch',
      description: `Repointer « current » vers la release ${targetReleaseId}`,
      commands: [
        `test -d ${paths.releasesDir}/${targetReleaseId}`,
        `ln -sfn ${paths.releasesDir}/${targetReleaseId} ${paths.currentLink}`,
        `cd ${paths.currentLink}/backend && PORT=${backendPort} ENV=${environment} pm2 startOrReload ecosystem.config.cjs --update-env || pm2 restart ${serviceName} --update-env`,
      ],
    },
    {
      step: 'rollback.health',
      description: 'Vérifier la santé après rollback',
      healthCheck: { url: `${urls.backendUrl}/health`, expectEnv: environment },
      commands: [
        `curl -fsS --retry 8 --retry-delay 2 http://127.0.0.1:${backendPort}/health`,
      ],
    },
  ];
}
