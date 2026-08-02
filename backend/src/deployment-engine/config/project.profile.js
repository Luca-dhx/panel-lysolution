/**
 * PROFIL DE PROJET — le SEUL fichier du moteur de déploiement qui connaisse
 * ce projet précis.
 *
 * Règle d'architecture de l'écosystème L.Y Solution (Phase 2D) : le cœur du
 * moteur est strictement générique et identique dans tous les projets ; ce
 * qui distingue un projet d'un autre passe par ce profil, par les templates
 * et par les adapters — jamais par un fork du moteur.
 *
 * ── Profil du PANEL ─────────────────────────────────────────────────────────
 * Le Panel est une application à DEUX composants (un frontend, un backend),
 * là où un projet vitrine en a trois (vitrine, Manager, backend). C'est la
 * seule différence de topologie, et elle est entièrement décrite ici : le
 * cœur du moteur reste identique.
 */

/** Slug technique du projet — préfixe des ressources serveur. */
export const PROJECT_SLUG = 'panel';

/** Identifiant inscrit dans le manifeste de build (`/api/version`). */
export const PROJECT_ID = 'panel-lysolution';

/**
 * Applications construites et publiées par le déploiement.
 *
 * `role` :
 *   - `web`      application front servie en statique sur l'hôte principal ;
 *   - `web-sub`  application front servie sur un sous-domaine dérivé ;
 *   - `server`   backend Node (jamais buildé, jamais servi en statique).
 *
 * `nginxRole` décrit, lui, ce que le moteur Nginx doit produire :
 *   `web` · `web-subdomain` · `api` · `static` · `proxy` · `server`.
 * Le générateur Nginx ne connaît QUE ces rôles — jamais un nom d'application.
 *
 * Le Panel n'a AUCUNE application `web-sub` : son interface est servie à la
 * racine de son domaine. Aucun sous-domaine `manager.` n'est donc dérivé.
 */
export const APPS = Object.freeze([
  Object.freeze({
    id: 'frontend',
    dir: 'frontend',
    role: 'web',
    nginxRole: 'web',
    remoteDir: 'frontend',
    installPhase: 'install_frontend',
    buildPhase: 'build_frontend',
    installLabel: 'installation des dépendances du frontend',
    buildLabel: 'construction du frontend',
    installFailedCode: 'ARTIFACT_INSTALL_FRONTEND_FAILED',
    buildFailedCode: 'ARTIFACT_BUILD_FRONTEND_FAILED',
    missingArtifactCode: 'ARTIFACT_BUILD_FRONTEND_MISSING',
  }),
  Object.freeze({
    id: 'backend',
    dir: 'backend',
    role: 'server',
    nginxRole: 'server',
    remoteDir: 'backend',
  }),
]);

/**
 * Sous-domaine réservé à l'API. Le backend du Panel est joignable sur l'hôte
 * principal (chemins `/api/`, `/bridge/`, `/health`) ET sur ce sous-domaine
 * dédié — c'est cette adresse que les projets appairés peuvent utiliser.
 */
export const API_SUBDOMAIN = 'api';

/**
 * SCHÉMA RÉSEAU de la destination : quelles clés de son `SystemConfiguration`
 * le déploiement renseigne, et depuis quelle application.
 *
 * C'est une donnée de PROJET, pas de moteur : le schéma appartient à
 * l'application déployée. Le Panel n'a pas d'espace de gestion distinct — il
 * n'écrit donc aucune `managerUrl`, là où un projet vitrine en déclare une.
 */
// Les clés sont celles du schéma `SystemConfiguration.network` du Panel
// (`backendUrl`, `frontendUrl`) — pas celles d'un autre projet.
export const RUNTIME_NETWORK_URLS = Object.freeze({
  frontendUrl: Object.freeze({ app: 'frontend' }),
  backendUrl: Object.freeze({ api: true }),
});

/**
 * Bases wildcard gérées par l'infrastructure : un certificat `*.base` unique
 * couvre toutes les cibles d'un seul niveau sous cette base.
 * Surchargeable par la variable d'environnement `DEPLOY_WILDCARD_BASES`.
 */
export const DEFAULT_WILDCARD_BASES = Object.freeze(['ly-solution.com']);

/** Racine des sauvegardes sur le serveur. */
export const BACKUP_ROOT = `/var/backups/${PROJECT_SLUG}`;

/** Racine par défaut des déploiements sur le serveur. */
export const DEFAULT_REMOTE_ROOT = '/var/www';

/**
 * Variables devant impérativement être présentes et non vides dans le `.env`
 * distant : le déploiement relit le fichier écrit et refuse de démarrer le
 * service si l'une manque. `__DB_FOR_ENV__` est remplacée à la volée par
 * `DB_TEST` ou `DB_PROD` selon l'ENV déployé.
 *
 * Différence assumée avec un projet vitrine : le Panel exige
 * `BRIDGE_ENCRYPTION_KEY` (chiffrement au repos des bridgeTokens) et
 * `JWT_EXPIRES_IN`, et n'a pas d'`INTEGRATED_API_ENCRYPTION_KEY` (il n'a pas
 * d'IntegratedAPI).
 */
export const REQUIRED_REMOTE_ENV = Object.freeze([
  'ENV',
  'PORT',
  'MONGODB_URI',
  '__DB_FOR_ENV__',
  'JWT_SECRET',
  'JWT_EXPIRES_IN',
  'BRIDGE_ENCRYPTION_KEY',
]);

/**
 * Sonde publique servant au contrôle FONCTIONNEL des médias après déploiement.
 * Le Panel n'expose aucun catalogue public de médias : il n'a pas de sonde, et
 * le rapport doit le dire plutôt que d'annoncer un contrôle réussi.
 */
export const PUBLIC_MEDIA_PROBE_PATH = null;

/** Préfixe des processus PM2 : `<slug>-<host>`. */
export function serviceName(host) {
  return `${PROJECT_SLUG}-${String(host).replace(/[^a-z0-9.-]/gi, '-')}`;
}

/** Préfixe des dossiers temporaires locaux de build. */
export const BUILD_STAGING_PREFIX = `${PROJECT_SLUG}-build-`;

export default {
  PROJECT_SLUG,
  PROJECT_ID,
  APPS,
  API_SUBDOMAIN,
  RUNTIME_NETWORK_URLS,
  PUBLIC_MEDIA_PROBE_PATH,
  DEFAULT_WILDCARD_BASES,
  BACKUP_ROOT,
  DEFAULT_REMOTE_ROOT,
  REQUIRED_REMOTE_ENV,
  serviceName,
  BUILD_STAGING_PREFIX,
};
