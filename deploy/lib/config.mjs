// Configuration d'un déploiement du Panel — validée avant toute action.
// Le domaine n'est JAMAIS codé en dur : il vient d'ici (fichier ou options
// de ligne de commande), et c'est lui qui alimente ensuite Nginx, le .env
// distant, le CORS et la configuration système en base.
import fs from 'node:fs';
import path from 'node:path';

export const DEPLOY_ENVIRONMENTS = ['TEST', 'PROD'];

// Une variable listée ici doit être présente et non vide dans le .env
// distant : le déploiement échoue avant de démarrer le service plutôt que de
// laisser tourner un Panel mal configuré.
export const REQUIRED_REMOTE_ENV = Object.freeze([
  'ENV',
  'PORT',
  'MONGODB_URI',
  'JWT_SECRET',
  'JWT_EXPIRES_IN',
  'BRIDGE_ENCRYPTION_KEY',
]);

// Jamais transportées vers le serveur : purement locales.
export const LOCAL_ONLY_ENV_KEYS = Object.freeze(['PANEL_SKIP_DOTENV', 'PANEL_DEBUG']);

const HOST_RE = /^(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))+$/;

export function assertValidHost(host, label = 'domaine') {
  if (typeof host !== 'string' || !HOST_RE.test(host)) {
    throw new Error(`${label} invalide : « ${host} » (nom d'hôte pleinement qualifié attendu, sans port ni protocole).`);
  }
  return host;
}

// Un seul domaine saisi suffit : les URLs publiques en découlent.
export function deriveUrls(host) {
  return {
    frontendUrl: `https://${host}`,
    backendUrl: `https://${host}`,
  };
}

/**
 * @param {string|null} configPath  chemin du fichier de configuration
 * @param {object} overrides        valeurs de ligne de commande (prioritaires)
 * @param {boolean} [required]      `true` quand le chemin a été demandé
 *   explicitement (`--config`) : son absence est alors une erreur. Le fichier
 *   PAR DÉFAUT (`deploy/deploy.config.json`) n'est pas versionné — son
 *   absence est normale tant que tout est fourni en ligne de commande.
 */
export function loadDeployConfig(configPath, overrides = {}, required = false) {
  let fromFile = {};
  if (configPath) {
    const resolved = path.resolve(configPath);
    if (!fs.existsSync(resolved)) {
      if (required) throw new Error(`Fichier de configuration introuvable : ${resolved}`);
    } else {
      fromFile = JSON.parse(fs.readFileSync(resolved, 'utf8'));
    }
  }
  const merged = { ...fromFile, ...Object.fromEntries(
    Object.entries(overrides).filter(([, value]) => value !== undefined),
  ) };

  const errors = [];
  if (!merged.host) errors.push('host est requis (ex. panel.exemple.com).');
  else {
    try { assertValidHost(merged.host); } catch (err) { errors.push(err.message); }
  }
  if (!DEPLOY_ENVIRONMENTS.includes(merged.environment)) {
    errors.push(`environment doit valoir ${DEPLOY_ENVIRONMENTS.join(' ou ')}.`);
  }
  if (!merged.sshHost) errors.push('sshHost est requis (adresse du serveur).');
  if (!Number.isInteger(merged.backendPort) || merged.backendPort <= 0) {
    errors.push('backendPort doit être un entier positif.');
  }
  if (merged.keepReleases !== undefined
      && (!Number.isInteger(merged.keepReleases) || merged.keepReleases < 1)) {
    errors.push('keepReleases doit être un entier ≥ 1.');
  }
  if (errors.length > 0) {
    throw new Error(`Configuration de déploiement invalide :\n  - ${errors.join('\n  - ')}`);
  }

  const remoteRoot = merged.remoteRoot ?? '/var/www';
  const siteRoot = `${remoteRoot}/${merged.host}`;
  return {
    host: merged.host,
    environment: merged.environment,
    sshHost: merged.sshHost,
    sshUser: merged.sshUser ?? 'root',
    backendPort: merged.backendPort,
    remoteRoot,
    keepReleases: merged.keepReleases ?? 5,
    serviceName: merged.serviceName ?? `panel-${merged.host.replace(/[^a-z0-9.-]/gi, '-')}`,
    paths: {
      siteRoot,
      releasesDir: `${siteRoot}/releases`,
      currentLink: `${siteRoot}/current`,
      sharedDir: `${siteRoot}/shared`,
      envFile: `${siteRoot}/shared/.env`,
      /**
       * MÉDIAS IMPORTÉS — hors des releases, comme le stockage des projets.
       *
       * Une release est un dossier jetable : y écrire les logos les ferait
       * disparaître à la mise en production suivante. Ils vivent donc dans
       * `shared/`, et chaque release y pointe par un lien symbolique refait à
       * chaque déploiement. Aucune opération manuelle, jamais.
       */
      sharedUploads: `${siteRoot}/shared/uploads`,
    },
    urls: deriveUrls(merged.host),
  };
}
