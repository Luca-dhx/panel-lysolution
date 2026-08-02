/**
 * TOPOLOGIE DE DÉPLOIEMENT — source unique de vérité dérivée du PROFIL.
 *
 * Le cœur du moteur ne connaît AUCUN nom d'application. Il ne connaît que des
 * RÔLES, déclarés par `config/project.profile.js` :
 *
 *   `web`         application front servie sur l'hôte principal ;
 *   `web-sub`     application front servie sur `<subdomain>.<hôte>` ;
 *   `static`      contenu statique (sous-domaine, ou hôte principal) ;
 *   `proxy`       hôte dédié proxifié vers le backend ;
 *   `server`      backend Node — jamais buildé, jamais servi en statique ;
 *   `worker`      processus sans HTTP : ni build front, ni bloc Nginx, ni hôte.
 *
 * Toute étape du pipeline (build, upload, Nginx, certificats, DNS, healthcheck,
 * empreintes, rollback) itère la topologie produite ici. Ajouter une
 * application à un projet = une entrée de plus dans son profil, zéro ligne de
 * moteur.
 *
 * `planTopology()` est une fonction PURE d'un profil explicite : c'est ce qui
 * permet de la vérifier sur des profils de test arbitraires, sans toucher au
 * profil réel du dépôt.
 */
import {
  API_SUBDOMAIN as PROFILE_API_SUBDOMAIN,
  APPS as PROFILE_APPS,
  DEFAULT_REMOTE_ROOT,
  RUNTIME_NETWORK_URLS as PROFILE_RUNTIME_NETWORK_URLS,
} from './config/project.profile.js';

/** Profil par défaut : celui du dépôt courant. Injectable pour les tests. */
export const DEFAULT_PROFILE = Object.freeze({
  APPS: PROFILE_APPS,
  API_SUBDOMAIN: PROFILE_API_SUBDOMAIN,
  RUNTIME_NETWORK_URLS: PROFILE_RUNTIME_NETWORK_URLS,
});

/** Normalise l'argument `profile` (objet complet, ou tableau d'applications). */
function asProfile(profile) {
  if (!profile) return DEFAULT_PROFILE;
  if (Array.isArray(profile)) return { ...DEFAULT_PROFILE, APPS: profile };
  return {
    APPS: profile.APPS ?? PROFILE_APPS,
    API_SUBDOMAIN: profile.API_SUBDOMAIN ?? PROFILE_API_SUBDOMAIN,
    RUNTIME_NETWORK_URLS: profile.RUNTIME_NETWORK_URLS ?? PROFILE_RUNTIME_NETWORK_URLS,
  };
}

/**
 * Rôle Nginx d'une application. `nginxRole` explicite s'il est déclaré, sinon
 * déduit de `role` (profils antérieurs à la Phase 2E).
 */
export function nginxRoleOf(app) {
  if (app.nginxRole) return app.nginxRole;
  if (app.role === 'web') return 'web';
  if (app.role === 'web-sub') return 'web-subdomain';
  if (app.role === 'static') return 'static';
  if (app.role === 'proxy') return 'proxy';
  if (app.role === 'api') return 'api';
  return 'server';
}

/** Le backend Node du projet (rôle `server`). */
export function serverAppOf(profile) {
  return asProfile(profile).APPS.find((app) => app.role === 'server') ?? null;
}

/**
 * Applications CONSTRUITES : celles qui produisent un `dist` à publier.
 * Un `server` n'est pas construit ; un `worker` non plus ; un `proxy` n'a pas
 * de source front ; un `static` déclaré `prebuilt` est copié tel quel.
 */
export function buildableApps(profile) {
  return asProfile(profile).APPS.filter(
    (app) => (app.role === 'web' || app.role === 'web-sub' || app.role === 'static') && app.prebuilt !== true,
  );
}

/** Applications publiées sous forme de dossier statique sur le VPS. */
export function publishableApps(profile) {
  return asProfile(profile).APPS.filter((app) => app.role === 'web' || app.role === 'web-sub' || app.role === 'static');
}

/** Hostname dérivé pour un sous-domaine donné. */
export function deriveSubHost(siteHost, subdomain) {
  if (!siteHost || typeof siteHost !== 'string' || !subdomain) return null;
  return `${subdomain}.${siteHost.toLowerCase()}`;
}

/** Répertoire distant d'une application (`remoteDir` du profil, sinon son id). */
export function remoteDirOf(app) {
  return app.remoteDir ?? app.dir ?? app.id;
}

/**
 * TOPOLOGIE COMPLÈTE d'un déploiement.
 *
 * @param {object} args
 * @param {string} args.host              Hôte principal de la cible.
 * @param {string} [args.remoteRoot]      Racine de déploiement sur le VPS.
 * @param {object|Array} [args.profile]   Profil (défaut : celui du dépôt).
 * @param {Record<string,string>} [args.hostOverrides] Hôte explicite par application.
 * @returns {{
 *   host:string, siteRoot:string, sharedRoot:string, sharedUploads:string,
 *   backendDir:string, apiHost:string, serverApp:object|null,
 *   apps:Array<object>, publishable:Array<object>, buildable:Array<object>,
 *   roots:Record<string,string>, hosts:Record<string,string>, servedHosts:Array<string>,
 *   dedicatedCertHosts:Array<string>, dnsHosts:Array<{appId:string|null, host:string, label:string}>
 * }}
 */
export function planTopology({ host, remoteRoot = DEFAULT_REMOTE_ROOT, profile, hostOverrides = {} } = {}) {
  const p = asProfile(profile);
  if (!host || typeof host !== 'string') {
    throw new TypeError('planTopology : hôte de destination requis (chaîne non vide).');
  }
  const siteHost = host.toLowerCase();
  const siteRoot = `${remoteRoot}/${siteHost}`;
  const sharedRoot = `${siteRoot}/shared`;
  const server = p.APPS.find((app) => app.role === 'server') ?? null;
  const apiHost = deriveSubHost(siteHost, p.API_SUBDOMAIN);

  const roots = {};
  const hosts = {};
  const apps = [];

  for (const app of p.APPS) {
    const role = app.role;
    const nginxRole = nginxRoleOf(app);
    const dir = remoteDirOf(app);

    // Un `worker` ne sert rien en HTTP : aucun hôte, aucun bloc Nginx.
    if (role === 'server' || role === 'worker') {
      if (role === 'server') roots[app.id] = `${siteRoot}/${dir}`;
      continue;
    }

    // Hôte de l'application : principal pour `web`, dérivé pour tout ce qui
    // déclare un `subdomain`.
    const appHost = (hostOverrides[app.id]
      ?? (role === 'web' ? siteHost : (app.subdomain ? deriveSubHost(siteHost, app.subdomain) : siteHost))).toLowerCase();

    roots[app.id] = `${siteRoot}/${dir}`;
    hosts[app.id] = appHost;
    apps.push({
      id: app.id,
      role,
      nginxRole,
      host: appHost,
      remoteRoot: `${siteRoot}/${dir}`,
      remoteDir: dir,
      isPrimaryHost: appHost === siteHost,
      publishable: role === 'web' || role === 'web-sub' || role === 'static',
      buildable: (role === 'web' || role === 'web-sub' || role === 'static') && app.prebuilt !== true,
      label: app.label ?? app.id,
    });
  }

  const publishable = apps.filter((a) => a.publishable);
  const buildable = apps.filter((a) => a.buildable);

  // Hôtes servis : ceux des applications + l'hôte API dédié (le backend est
  // toujours joignable sur son propre domaine).
  const servedHosts = [...new Set([...apps.map((a) => a.host), apiHost].filter(Boolean))];

  // Un certificat wildcard `*.base` ne couvre qu'UN niveau : tout hôte dérivé
  // (sous-domaine d'un hôte déjà sous la base) exige un certificat dédié.
  const dedicatedCertHosts = [...new Set([...apps.filter((a) => !a.isPrimaryHost).map((a) => a.host), apiHost].filter(Boolean))];

  // Enregistrements DNS à poser : l'hôte du site + chaque hôte dérivé.
  const dnsHosts = [
    { appId: null, host: siteHost, label: 'site' },
    ...apps.filter((a) => !a.isPrimaryHost).map((a) => ({ appId: a.id, host: a.host, label: a.label })),
  ];

  return {
    host: siteHost,
    siteRoot,
    sharedRoot,
    sharedUploads: `${sharedRoot}/uploads`,
    backendDir: server ? `${siteRoot}/${remoteDirOf(server)}` : null,
    apiHost,
    serverApp: server,
    apps,
    publishable,
    buildable,
    roots,
    hosts,
    servedHosts,
    dedicatedCertHosts,
    dnsHosts,
    // Schéma réseau de la DESTINATION (clés de son SystemConfiguration).
    runtimeNetworkUrls: p.RUNTIME_NETWORK_URLS ?? null,
  };
}

export default { planTopology, nginxRoleOf, serverAppOf, buildableApps, publishableApps, deriveSubHost, remoteDirOf, DEFAULT_PROFILE };
