/**
 * Génération & application de la configuration Nginx d'une cible.
 *
 * ── ENTIÈREMENT PILOTÉ PAR LE PROFIL (Phase 2E) ────────────────────────────
 * Ce fichier ne connaît AUCUN nom d'application : ni « vitrine », ni
 * une application nommée. Il ne connaît que `APPS` et le
 * `nginxRole` que chaque application déclare dans
 * `config/project.profile.js`.
 *
 * Rôles reconnus :
 *   web            application statique servie sur l'hôte PRINCIPAL
 *   web-subdomain  application statique servie sur `<subdomain>.<host>`
 *   api            reverse proxy PUR vers le backend, sur un hôte dédié
 *   static         contenu statique seul (aucun proxy backend)
 *   proxy          reverse proxy seul, sans racine statique
 *   server         backend Node : fournit le port ; N'A PAS de bloc serveur
 *
 * Un projet à 3 applications et un projet à 2 produisent donc la même
 * configuration par le même code : seule la liste `APPS` change.
 *
 * Le certificat TLS est référencé selon le cas (wildcard partagé pour un
 * sous-domaine géré, ou certificat dédié Let's Encrypt) — voir certbot.js.
 */
import { API_SUBDOMAIN, APPS } from './config/project.profile.js';

/** Chemin du fichier de conf sites-available pour un hôte. */
export function nginxConfigPath(host) {
  return `/etc/nginx/sites-available/${host}.conf`;
}

/** Chemin du lien sites-enabled. */
export function nginxEnabledPath(host) {
  return `/etc/nginx/sites-enabled/${host}.conf`;
}

/**
 * Emplacement du certificat selon le type de cible.
 * - subdomain (wildcard) : certificat *.base partagé.
 * - domain (client)      : certificat dédié Let's Encrypt au nom de l'hôte.
 */
export function certPaths(target) {
  if (target.type === 'subdomain') {
    return {
      fullchain: `/etc/letsencrypt/live/${target.wildcardBase}/fullchain.pem`,
      privkey: `/etc/letsencrypt/live/${target.wildcardBase}/privkey.pem`,
      certName: target.wildcardBase,
      shared: true,
    };
  }
  return {
    fullchain: `/etc/letsencrypt/live/${target.host}/fullchain.pem`,
    privkey: `/etc/letsencrypt/live/${target.host}/privkey.pem`,
    certName: target.host,
    shared: false,
  };
}

/**
 * Emplacement d'un certificat DÉDIÉ pour un hôte dérivé.
 * Un wildcard `*.base` ne couvrant qu'UN niveau, tout hôte dérivé
 * (`<sub>.<host>`) exige son propre certificat.
 */
export function dedicatedCertPaths(host) {
  return {
    fullchain: `/etc/letsencrypt/live/${host}/fullchain.pem`,
    privkey: `/etc/letsencrypt/live/${host}/privkey.pem`,
    certName: host,
    shared: false,
  };
}

/**
 * Alias de compatibilité — ancien nom de `dedicatedCertPaths`, conservé pour
 * les appelants antérieurs à la Phase 2E. Ne PAS utiliser dans du code neuf.
 */
export const legacyDedicatedCertPaths = dedicatedCertPaths;

/**
 * Bloc proxy commun (API + PONT + uploads + health) vers le backend PM2.
 *
 * `/bridge/` est la surface que les PROJETS appellent (bootstrap d'appairage,
 * heartbeats, synchronisation) : elle n'est pas sous `/api/`, et sans son
 * propre bloc elle retombait dans le repli SPA `try_files … /index.html`.
 * nginx la servait alors par son module statique, qui accepte GET/HEAD et
 * refuse le reste — un `POST /bridge/v1/pairings` recevait donc un
 * 405 Not Allowed d'nginx sans jamais atteindre Express.
 */
function backendProxy(backendPort) {
  return `    location /api/ {
        proxy_pass http://127.0.0.1:${backendPort};
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
    location /bridge/ {
        proxy_pass http://127.0.0.1:${backendPort};
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
    location /uploads/ { proxy_pass http://127.0.0.1:${backendPort}; }
    location = /health { proxy_pass http://127.0.0.1:${backendPort}; }`;
}

/** Bloc proxy PUR (tout `/`) vers le backend — pour le domaine API dédié. */
function apiProxyAll(backendPort) {
  return `    location / {
        proxy_pass http://127.0.0.1:${backendPort};
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }`;
}

/**
 * Blocs `location` d'un site statique (SPA) avec politique de cache CORRECTE.
 *
 * Sans cela, `index.html` serait servi SANS `Cache-Control` : le navigateur lui
 * appliquerait un cache heuristique et continuerait d'afficher un ANCIEN
 * index.html (pointant vers d'anciens hash d'assets) même après un déploiement
 * réussi.
 *
 * Règles :
 *  - `index.html` + manifestes de version → `no-cache` : TOUJOURS revalider, donc
 *    le nouveau build est pris en compte immédiatement (les assets étant
 *    fingerprintés, aucun risque de mélange de versions).
 *  - `/assets/*` (nom = hash du contenu) → `immutable`, cache 1 an, et `=404` si
 *    absent (ne PAS retomber sur index.html : évite de servir du HTML pour un .js).
 */
function staticSiteLocations() {
  return `    location = /index.html { add_header Cache-Control "no-cache"; }
    location = /version.json { add_header Cache-Control "no-cache"; }
    location = /build-manifest.json { add_header Cache-Control "no-cache"; }

    location /assets/ {
        expires 1y;
        add_header Cache-Control "public, immutable";
        try_files $uri =404;
    }

    location / {
        try_files $uri $uri/ /index.html;
    }`;
}

/** Hostname API dédié dérivé de l'hôte du site (sauf fourni explicitement). */
export function deriveApiHost(host, apiHost) {
  return (apiHost || `${API_SUBDOMAIN}.${host}`).toLowerCase();
}

/**
 * Rôle Nginx d'une application, dérivé du profil.
 * `nginxRole` explicite s'il est déclaré ; sinon déduit de `role` (les profils
 * antérieurs à la Phase 2E ne déclarent que `role`).
 */
function nginxRoleOf(app) {
  if (app.nginxRole) return app.nginxRole;
  if (app.role === 'web') return 'web';
  if (app.role === 'web-sub') return 'web-subdomain';
  return 'server';
}

/**
 * PLAN DES SITES à servir, dérivé du profil et de la cible.
 *
 * Retourne une liste de descripteurs, dans l'ordre de rendu :
 *   { id, host, kind: 'static'|'proxy', root|null, withBackendProxy, cert, dedicatedCert }
 *
 * C'est LA fonction qui remplace les anciens blocs codés en dur. Elle est
 * exportée : les tests la vérifient directement, sans lire du texte Nginx.
 *
 * @param {object} target  Résultat de parseTargetUrl.
 * @param {object} opts
 * @param {Record<string,string>} [opts.roots]  racine statique par identifiant d'application
 * @param {string} [opts.webRoot]     compat : racine de l'application `web`
 * @param {string} [opts.subRoot]     compat : racine de la première `web-subdomain`
 * @param {string} [opts.apiHost]     hôte API explicite
 * @param {Record<string,string>} [opts.hosts] hôte explicite par identifiant d'application
 */
export function planSites(target, opts = {}) {
  const host = target.host;
  const roots = { ...(opts.roots ?? {}) };
  const sites = [];
  // La composition vient du profil — injectable pour vérifier des topologies
  // arbitraires sans toucher au profil du dépôt.
  const APP_LIST = Array.isArray(opts.profile) ? opts.profile : (opts.profile?.APPS ?? APPS);

  const webApps = APP_LIST.filter((app) => nginxRoleOf(app) === 'web');
  const subApps = APP_LIST.filter((app) => nginxRoleOf(app) === 'web-subdomain');

  // `webRoot` / `subRoot` : raccourcis positionnels (première application `web`,
  // première `web-subdomain`) pour les appels qui ne construisent pas `roots`.
  if (opts.webRoot && webApps[0] && roots[webApps[0].id] === undefined) roots[webApps[0].id] = opts.webRoot;
  if (opts.subRoot && subApps[0] && roots[subApps[0].id] === undefined) roots[subApps[0].id] = opts.subRoot;

  for (const app of APP_LIST) {
    const role = nginxRoleOf(app);
    if (role === 'server') continue; // le backend ne produit pas de bloc serveur

    const explicitHost = opts.hosts?.[app.id];
    if (role === 'web') {
      sites.push({
        id: app.id,
        host: explicitHost ?? host,
        kind: 'static',
        root: roots[app.id] ?? null,
        withBackendProxy: app.backendProxy !== false,
        cert: certPaths(target),
      });
    } else if (role === 'web-subdomain') {
      const subHost = (explicitHost ?? `${app.subdomain}.${host}`).toLowerCase();
      sites.push({
        id: app.id,
        host: subHost,
        kind: 'static',
        root: roots[app.id] ?? null,
        withBackendProxy: app.backendProxy !== false,
        // Un hôte dérivé n'est jamais couvert par un wildcard à un niveau.
        cert: dedicatedCertPaths(subHost),
      });
    } else if (role === 'static') {
      const subHost = (explicitHost ?? (app.subdomain ? `${app.subdomain}.${host}` : host)).toLowerCase();
      sites.push({
        id: app.id,
        host: subHost,
        kind: 'static',
        root: roots[app.id] ?? null,
        withBackendProxy: false,
        cert: subHost === host ? certPaths(target) : dedicatedCertPaths(subHost),
      });
    } else if (role === 'proxy') {
      const subHost = (explicitHost ?? `${app.subdomain}.${host}`).toLowerCase();
      sites.push({
        id: app.id, host: subHost, kind: 'proxy', root: null,
        withBackendProxy: true, cert: dedicatedCertPaths(subHost),
      });
    }
  }

  // Hôte API dédié : déclaré par une application de rôle `api`, sinon dérivé
  // du sous-domaine d'API du profil (comportement historique).
  const apiApp = APP_LIST.find((app) => nginxRoleOf(app) === 'api');
  const apiHost = deriveApiHost(host, opts.apiHost ?? (apiApp?.subdomain ? `${apiApp.subdomain}.${host}` : undefined));
  sites.push({
    id: apiApp?.id ?? 'api',
    host: apiHost,
    kind: 'proxy',
    root: null,
    withBackendProxy: true,
    cert: dedicatedCertPaths(apiHost),
  });

  return sites;
}

/** Tous les hostnames servis par la configuration (ordre stable). */
export function servedHosts(target, opts = {}) {
  return [...new Set(planSites(target, opts).map((site) => site.host))];
}

/**
 * Rend la configuration Nginx HTTPS complète — un bloc serveur par site du
 * plan, plus la redirection HTTP → HTTPS commune.
 *
 * @param {object} target Résultat de parseTargetUrl.
 * @param {object} opts   Voir planSites().
 */
export function renderNginxConfig(target, opts) {
  const { backendPort } = opts;
  const sites = planSites(target, opts);
  const proxy = backendProxy(backendPort);
  const hosts = sites.map((site) => site.host);

  const blocks = sites.map((site) => {
    const header = `server {
    listen 443 ssl http2;
    listen [::]:443 ssl http2;
    server_name ${site.host};

    ssl_certificate ${site.cert.fullchain};
    ssl_certificate_key ${site.cert.privkey};`;

    if (site.kind === 'proxy') {
      return `# --- ${site.id} (reverse proxy pur vers le backend interne) ---
${header}

${apiProxyAll(backendPort)}
}`;
    }
    // Les blocs PROXY sont écrits AVANT le repli SPA. nginx choisit le préfixe
    // le plus LONG, pas le premier : l'ordre ne décide de rien pour lui. Il
    // décide en revanche de ce qu'on lit — voir d'abord ce qui part au backend,
    // puis le repli, est la seule lecture qui ne laisse pas croire que `/`
    // capture tout.
    return `# --- ${site.id} ---
${header}

    root ${site.root};
    index index.html;
${site.withBackendProxy ? `\n${proxy}\n` : ''}
${staticSiteLocations()}
}`;
  });

  return `# Généré par DeploymentEngine — cible ${target.host}
# Sites servis : ${hosts.join(', ')}
# NE PAS éditer à la main : régénéré à chaque déploiement.
#
# HTTP/2 activé SUR la directive listen (« listen … ssl http2 ») : compatible de
# nginx 1.9.5 à aujourd'hui. La directive autonome « http2 on; » n'existe qu'à
# partir de nginx 1.25.1 et fait échouer les serveurs plus anciens (Ubuntu 20.04/
# 22.04 → nginx 1.18) avec [emerg] unknown directive "http2". Sur 1.25.1+, la
# forme « listen … http2 » n'émet qu'un [warn] (nginx -t reste « successful »).
server {
    listen 80;
    listen [::]:80;
    server_name ${hosts.join(' ')};
    location /.well-known/acme-challenge/ { root /var/www/certbot; }
    location / { return 301 https://$host$request_uri; }
}

${blocks.join('\n\n')}
`;
}

/**
 * Rend une configuration HTTP-ONLY (PHASE 1, AVANT certbot).
 *
 * Indispensable : la config HTTPS complète référence des `ssl_certificate` qui
 * N'EXISTENT PAS encore au premier déploiement (émis par certbot juste après).
 * Appliquer d'emblée la config HTTPS ferait échouer `nginx -t` (« cannot load
 * certificate »), et le challenge ACME HTTP-01 ne serait jamais servi (Nginx ne
 * démarrant pas). On sert donc d'abord les sites + le challenge en HTTP, on émet
 * les certificats, PUIS on bascule sur la config HTTPS complète.
 */
export function renderNginxHttpOnly(target, opts) {
  const { backendPort } = opts;
  const sites = planSites(target, opts);
  const proxy = backendProxy(backendPort);

  const blocks = sites.map((site) => {
    const header = `server {
    listen 80;
    listen [::]:80;
    server_name ${site.host};

    location /.well-known/acme-challenge/ { root /var/www/certbot; }`;

    if (site.kind === 'proxy') {
      return `# --- ${site.id} (HTTP, pré-certificat) ---
${header}

${apiProxyAll(backendPort)}
}`;
    }
    return `# --- ${site.id} (HTTP, pré-certificat) ---
${header}

    root ${site.root};
    index index.html;
    location / {
        try_files $uri $uri/ /index.html;
    }
${site.withBackendProxy ? `\n${proxy}\n` : ''}}`;
  });

  return `# Généré par DeploymentEngine — cible ${target.host} — PHASE HTTP (pré-certificat)
# Sites servis : ${sites.map((s) => s.host).join(', ')}
# NE PAS éditer à la main : régénéré à chaque déploiement.
# Temporaire : sert le challenge ACME (HTTP-01) et les sites en HTTP le temps de
# l'émission des certificats. Remplacée juste après par la config HTTPS complète.
${blocks.join('\n\n')}
`;
}

/** Écrit + active + teste une configuration ; nettoie le lien si invalide. */
async function installConfig(transport, target, content) {
  const configPath = nginxConfigPath(target.host);
  const enabledPath = nginxEnabledPath(target.host);

  // Écriture dans un fichier temporaire puis déplacement en sudo (droits root).
  const tmp = `/tmp/${target.host}.nginx.conf`;
  await transport.writeFile(tmp, content);
  await transport.exec(`sudo mv ${tmp} ${configPath}`);
  await transport.exec(`sudo ln -sf ${configPath} ${enabledPath}`);

  const test = await transport.exec('sudo nginx -t 2>&1');
  const ok = /syntax is ok/i.test(test.stdout + test.stderr) && /test is successful/i.test(test.stdout + test.stderr);
  if (!ok) {
    // Atomicité : une conf invalide vient d'être ACTIVÉE (symlink sites-enabled).
    // Si on la laisse, le prochain « reload » de Nginx échoue et met à terre TOUS
    // les sites du serveur. On désactive donc immédiatement le lien : la conf
    // fautive reste dans sites-available (pour diagnostic) mais Nginx redevient
    // rechargeable. On ne recharge pas : l'ancienne conf active reste en place.
    await transport.exec(`sudo rm -f ${enabledPath}`).catch(() => {});
    const { DeploymentError } = await import('./errors.js');
    throw new DeploymentError('NGINX_CONFIG_INVALID', 'La configuration Nginx générée est invalide.', {
      step: 'nginx',
      details: { output: (test.stdout + test.stderr).slice(0, 500), disabledSymlink: enabledPath },
    });
  }
  return configPath;
}

async function reloadNginx(transport) {
  await transport.exec('sudo systemctl reload nginx || sudo nginx -s reload');
}

/**
 * PHASE 1 — applique la config HTTP-only (avant certbot), teste et recharge.
 * Écrase toute config précédente (y compris une config invalide laissée par un
 * déploiement interrompu). @returns {Promise<{configPath:string, mode:string, reloaded:boolean}>}
 */
export async function applyNginxHttpOnly(transport, target, opts) {
  const configPath = await installConfig(transport, target, renderNginxHttpOnly(target, opts));
  await reloadNginx(transport);
  return { configPath, mode: 'http', reloaded: true };
}

/**
 * PHASE 2 — applique la config HTTPS COMPLÈTE (certificats désormais présents),
 * teste puis recharge Nginx. @returns {Promise<{configPath:string, mode:string, reloaded:boolean}>}
 */
export async function applyNginxConfig(transport, target, opts) {
  const configPath = await installConfig(transport, target, renderNginxConfig(target, opts));
  await reloadNginx(transport);
  return { configPath, mode: 'https', reloaded: true };
}

export default {
  renderNginxConfig,
  renderNginxHttpOnly,
  applyNginxConfig,
  applyNginxHttpOnly,
  nginxConfigPath,
  certPaths,
  dedicatedCertPaths,
  planSites,
  servedHosts,
};
