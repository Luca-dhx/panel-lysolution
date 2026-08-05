// Génération de la configuration Nginx du Panel — déterministe, dérivée du
// seul domaine choisi. Deux rendus, comme dans le projet modèle :
//  1. HTTP seul, pour le challenge ACME (le certificat n'existe pas encore) ;
//  2. HTTPS complet, une fois le certificat émis.
// Le frontend est servi en statique, le backend est atteint par proxy.

const BANNER = '# Généré par le moteur de déploiement du Panel L.Y Solution — ne pas éditer à la main.';

export function certPaths(host) {
  return {
    fullchain: `/etc/letsencrypt/live/${host}/fullchain.pem`,
    privkey: `/etc/letsencrypt/live/${host}/privkey.pem`,
  };
}

/**
 * PHASE 1 — HTTP seul, le temps du challenge ACME.
 *
 * Les DEUX hôtes doivent y répondre : certbot valide `panel.…` et
 * `api.panel.…` séparément, chacun par un challenge servi sur son propre nom.
 * N'en déclarer qu'un ferait échouer l'émission du second certificat.
 */
export function renderNginxHttpOnly({ host, backendHost, paths }) {
  const hosts = backendHost && backendHost !== host ? `${host} ${backendHost}` : host;
  return `${BANNER}
server {
    listen 80;
    listen [::]:80;
    server_name ${hosts};

    location /.well-known/acme-challenge/ {
        root /var/www/certbot;
    }

    location / {
        root ${paths.currentLink}/frontend;
        try_files $uri $uri/ /index.html;
    }
}
`;
}

/** Proxy vers le backend interne — identique quel que soit l'hôte qui l'appelle. */
function backendProxy(backendPort) {
  return `        proxy_pass http://127.0.0.1:${backendPort};
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;`;
}

/**
 * PHASE 2 — HTTPS complet.
 *
 * Deux blocs, deux certificats :
 *   · `panel.…`     sert le frontend, ET conserve ses proxys `/api`,
 *     `/bridge`, `/health`. Le frontend continue donc d'appeler des chemins
 *     relatifs, sans une ligne de React à changer et sans CORS ;
 *   · `api.panel.…` sert le backend sur toute sa surface. C'est l'origine
 *     canonique, celle que reçoivent les projets, les webhooks et les médias.
 *
 * Les deux chemins fonctionnent — c'est ce qui rend la bascule sans rupture
 * pour un Panel déjà déployé.
 */
export function renderNginxConfig({ host, backendHost, backendPort, paths }) {
  const cert = certPaths(host);
  const apiHost = backendHost && backendHost !== host ? backendHost : null;
  const certApi = apiHost ? certPaths(apiHost) : null;
  const hosts = apiHost ? `${host} ${apiHost}` : host;

  const blocApi = apiHost ? `

# --- Origine CANONIQUE du backend : ${apiHost} ---
server {
    listen 443 ssl;
    listen [::]:443 ssl;
    http2 on;
    server_name ${apiHost};

    ssl_certificate     ${certApi.fullchain};
    ssl_certificate_key ${certApi.privkey};

    # Toute la surface part au backend : aucune ressource statique ici.
    location / {
${backendProxy(backendPort)}
    }
}` : '';

  return `${BANNER}
server {
    listen 80;
    listen [::]:80;
    server_name ${hosts};

    location /.well-known/acme-challenge/ {
        root /var/www/certbot;
    }

    location / {
        return 301 https://$host$request_uri;
    }
}

server {
    listen 443 ssl;
    listen [::]:443 ssl;
    http2 on;
    server_name ${host};

    ssl_certificate     ${cert.fullchain};
    ssl_certificate_key ${cert.privkey};

    root ${paths.currentLink}/frontend;
    index index.html;

    # Le shell de l'application ne doit jamais être servi depuis un cache :
    # sans cela, un navigateur continuerait de charger les assets de la
    # release précédente après un déploiement.
    location = /index.html {
        add_header Cache-Control "no-cache";
        try_files $uri =404;
    }

    location /assets/ {
        expires 1y;
        add_header Cache-Control "public, immutable";
        try_files $uri =404;
    }

    location / {
        try_files $uri $uri/ /index.html;
    }

    # Surface interne du Panel.
    location /api/ {
        proxy_pass http://127.0.0.1:${backendPort};
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    # Surface de pont : c'est l'adresse que les projets appairés appellent.
    location /bridge/ {
        proxy_pass http://127.0.0.1:${backendPort};
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    location = /health {
${backendProxy(backendPort)}
    }
}${blocApi}
`;
}
