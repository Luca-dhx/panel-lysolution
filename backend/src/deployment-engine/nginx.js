/**
 * Génération & application de la configuration Nginx d'une cible.
 *
 * Le site déployé se compose de :
 *   - la vitrine (statique, servie à la racine) ;
 *   - le manager (statique, servi sous /manager) ;
 *   - le backend Node (proxy_pass sur le port PM2 local, sous /api, /uploads, /health).
 *
 * La config est générée de façon déterministe à partir de l'hôte et du port
 * backend local. Le certificat TLS est référencé selon le cas (wildcard partagé
 * ou cert dédié Let's Encrypt) — voir certbot.js.
 */

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

/** Emplacement du certificat DÉDIÉ du Manager (jamais couvert par un wildcard 1 niveau). */
export function managerCertPaths(managerHost) {
  return {
    fullchain: `/etc/letsencrypt/live/${managerHost}/fullchain.pem`,
    privkey: `/etc/letsencrypt/live/${managerHost}/privkey.pem`,
    certName: managerHost,
    shared: false,
  };
}

/** Bloc proxy commun (API + uploads + health) vers le backend PM2. */
function backendProxy(backendPort) {
  return `    location /api/ {
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
 * Sans cela, `index.html` était servi SANS `Cache-Control` : le navigateur lui
 * appliquait un cache heuristique et continuait d'afficher un ANCIEN index.html
 * (pointant vers d'anciens hash d'assets) même après un déploiement réussi —
 * exactement le symptôme « la vitrine affiche encore une ancienne version ».
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
  return (apiHost || `api.${host}`).toLowerCase();
}

/**
 * Rend le contenu Nginx : DEUX sites servis ensemble — la vitrine sur `host` et
 * le Manager sur `managerHost` (= manager.<host>). La vitrine réutilise le
 * certificat (wildcard pour un sous-domaine géré, ou dédié pour un domaine
 * client) ; le Manager a TOUJOURS un certificat dédié (un wildcard *.base à un
 * niveau ne couvre pas manager.<host>).
 *
 * @param {object} target   Résultat de parseTargetUrl.
 * @param {object} opts
 * @param {string} opts.webRoot     Racine statique de la vitrine.
 * @param {string} opts.managerRoot Racine statique du Manager.
 * @param {number} opts.backendPort Port local du backend Node (PM2).
 * @param {string} opts.managerHost Hostname du Manager (dérivé).
 */
export function renderNginxConfig(target, { webRoot, managerRoot, backendPort, managerHost, apiHost }) {
  const { fullchain, privkey } = certPaths(target);
  const host = target.host;
  const mHost = managerHost || `manager.${host}`;
  const aHost = deriveApiHost(host, apiHost);
  const mCert = managerCertPaths(mHost);
  const aCert = managerCertPaths(aHost); // API : certificat dédié
  const proxy = backendProxy(backendPort);
  return `# Généré par DeploymentEngine — cible ${host} (+ Manager ${mHost} + API ${aHost})
# NE PAS éditer à la main : régénéré à chaque déploiement.
server {
    listen 80;
    listen [::]:80;
    server_name ${host} ${mHost} ${aHost};
    location /.well-known/acme-challenge/ { root /var/www/certbot; }
    location / { return 301 https://$host$request_uri; }
}

# --- Vitrine ---
# HTTP/2 activé SUR la directive listen (« listen … ssl http2 ») : compatible de
# nginx 1.9.5 à aujourd'hui. La directive autonome « http2 on; » n'existe qu'à
# partir de nginx 1.25.1 et fait échouer les serveurs plus anciens (Ubuntu 20.04/
# 22.04 → nginx 1.18) avec [emerg] unknown directive "http2". Sur 1.25.1+, la
# forme « listen … http2 » n'émet qu'un [warn] (nginx -t reste « successful »).
server {
    listen 443 ssl http2;
    listen [::]:443 ssl http2;
    server_name ${host};

    ssl_certificate ${fullchain};
    ssl_certificate_key ${privkey};

    root ${webRoot};
    index index.html;

${staticSiteLocations()}

${proxy}
}

# --- Manager (hostname dédié) ---
server {
    listen 443 ssl http2;
    listen [::]:443 ssl http2;
    server_name ${mHost};

    ssl_certificate ${mCert.fullchain};
    ssl_certificate_key ${mCert.privkey};

    root ${managerRoot};
    index index.html;

${staticSiteLocations()}

${proxy}
}

# --- API (domaine dédié, reverse proxy pur vers le backend interne) ---
server {
    listen 443 ssl http2;
    listen [::]:443 ssl http2;
    server_name ${aHost};

    ssl_certificate ${aCert.fullchain};
    ssl_certificate_key ${aCert.privkey};

${apiProxyAll(backendPort)}
}
`;
}

/**
 * Rend une configuration HTTP-ONLY (PHASE 1, AVANT certbot).
 *
 * Indispensable : la config HTTPS complète référence des `ssl_certificate` qui
 * N'EXISTENT PAS encore au premier déploiement (émis par certbot juste après).
 * Appliquer d'emblée la config HTTPS ferait échouer `nginx -t` (« cannot load
 * certificate »), et le challenge ACME HTTP-01 ne serait jamais servi (Nginx ne
 * démarrant pas). On sert donc d'abord le site + le challenge en HTTP, on émet
 * les certificats, PUIS on bascule sur la config HTTPS complète.
 */
export function renderNginxHttpOnly(target, { webRoot, managerRoot, backendPort, managerHost, apiHost }) {
  const host = target.host;
  const mHost = managerHost || `manager.${host}`;
  const aHost = deriveApiHost(host, apiHost);
  const proxy = backendProxy(backendPort);
  const block = (serverName, root) => `server {
    listen 80;
    listen [::]:80;
    server_name ${serverName};

    location /.well-known/acme-challenge/ { root /var/www/certbot; }

    root ${root};
    index index.html;
    location / {
        try_files $uri $uri/ /index.html;
    }

${proxy}
}`;
  // Bloc API en HTTP : sert le challenge ACME + proxifie déjà le backend.
  const apiBlock = `server {
    listen 80;
    listen [::]:80;
    server_name ${aHost};

    location /.well-known/acme-challenge/ { root /var/www/certbot; }

${apiProxyAll(backendPort)}
}`;
  return `# Généré par DeploymentEngine — cible ${host} (+ Manager ${mHost} + API ${aHost}) — PHASE HTTP (pré-certificat)
# NE PAS éditer à la main : régénéré à chaque déploiement.
# Temporaire : sert le challenge ACME (HTTP-01) et le site en HTTP le temps de
# l'émission des certificats. Remplacée juste après par la config HTTPS complète.
${block(host, webRoot)}

${block(mHost, managerRoot)}

${apiBlock}
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

export default { renderNginxConfig, renderNginxHttpOnly, applyNginxConfig, applyNginxHttpOnly, nginxConfigPath, certPaths };
