/**
 * TROIS TOPOLOGIES DE RÉFÉRENCE — la preuve que le moteur est générique.
 *
 * Le moteur ne doit connaître AUCUN de ces noms. Les trois profils sont
 * injectés tels quels dans `planTopology`, `buildArtifact`, `planSites` et
 * `runPipeline` : si une étape suppose un nom d'application, l'un des trois
 * échoue.
 *
 * 1. SB_AUTO   vitrine + manager + backend  (topologie historique)
 * 2. PANEL     frontend + backend           (front unique)
 * 3. ATYPIQUE  web + admin + api + docs + worker (cinq applications, rôles variés)
 */

/** Projet vitrine historique : un front principal, un front sur sous-domaine. */
export const SB_AUTO = Object.freeze({
  id: 'sb-auto',
  API_SUBDOMAIN: 'api',
  RUNTIME_NETWORK_URLS: Object.freeze({
    websiteUrl: { app: 'vitrine' },
    managerUrl: { app: 'manager' },
    backendUrl: { api: true },
  }),
  APPS: Object.freeze([
    Object.freeze({ id: 'vitrine', dir: 'vitrine', role: 'web', nginxRole: 'web', remoteDir: 'vitrine' }),
    Object.freeze({ id: 'manager', dir: 'manager', role: 'web-sub', nginxRole: 'web-subdomain', subdomain: 'manager', remoteDir: 'manager' }),
    Object.freeze({ id: 'backend', dir: 'backend', role: 'server', nginxRole: 'server', remoteDir: 'backend' }),
  ]),
});

/** Panel : une seule application front, servie à la racine du domaine. */
export const PANEL = Object.freeze({
  id: 'panel',
  API_SUBDOMAIN: 'api',
  RUNTIME_NETWORK_URLS: Object.freeze({
    websiteUrl: { app: 'frontend' },
    backendUrl: { api: true },
  }),
  APPS: Object.freeze([
    Object.freeze({ id: 'frontend', dir: 'frontend', role: 'web', nginxRole: 'web', remoteDir: 'frontend' }),
    Object.freeze({ id: 'backend', dir: 'backend', role: 'server', nginxRole: 'server', remoteDir: 'backend' }),
  ]),
});

/**
 * Projet VOLONTAIREMENT ATYPIQUE — aucun nom en commun avec les deux autres,
 * cinq applications, et deux rôles que le moteur n'avait jamais rencontrés
 * ensemble : un `static` (docs) et un `worker` (aucun HTTP, aucun bloc Nginx).
 */
export const ATYPIQUE = Object.freeze({
  id: 'atypique',
  API_SUBDOMAIN: 'api',
  RUNTIME_NETWORK_URLS: Object.freeze({
    websiteUrl: { app: 'web' },
    consoleUrl: { app: 'admin' },
    docsUrl: { app: 'docs' },
    backendUrl: { api: true },
  }),
  APPS: Object.freeze([
    Object.freeze({ id: 'web', dir: 'web', role: 'web', nginxRole: 'web', remoteDir: 'web' }),
    Object.freeze({ id: 'admin', dir: 'admin', role: 'web-sub', nginxRole: 'web-subdomain', subdomain: 'admin', remoteDir: 'admin' }),
    Object.freeze({ id: 'api', dir: 'api', role: 'server', nginxRole: 'server', remoteDir: 'api' }),
    Object.freeze({ id: 'docs', dir: 'docs', role: 'static', nginxRole: 'static', subdomain: 'docs', remoteDir: 'docs' }),
    Object.freeze({ id: 'worker', dir: 'worker', role: 'worker', remoteDir: 'worker' }),
  ]),
});

export const ALL_PROFILES = Object.freeze([SB_AUTO, PANEL, ATYPIQUE]);

/** Applications d'un profil qui produisent un `dist` (rôle, jamais nom). */
export const builtIds = (p) => p.APPS.filter((a) => ['web', 'web-sub', 'static'].includes(a.role)).map((a) => a.id);
/** Applications d'un profil publiées en statique. */
export const publishedIds = (p) => builtIds(p);

export default { SB_AUTO, PANEL, ATYPIQUE, ALL_PROFILES, builtIds, publishedIds };
