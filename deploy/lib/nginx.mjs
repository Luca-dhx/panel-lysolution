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

export function renderNginxHttpOnly({ host, paths }) {
  return `${BANNER}
server {
    listen 80;
    listen [::]:80;
    server_name ${host};

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

export function renderNginxConfig({ host, backendPort, paths }) {
  const cert = certPaths(host);
  return `${BANNER}
server {
    listen 80;
    listen [::]:80;
    server_name ${host};

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
        proxy_pass http://127.0.0.1:${backendPort};
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
`;
}
