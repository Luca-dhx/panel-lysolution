# 59 — Lancer, se connecter, déployer le Panel

> **Manuel d'exploitation.** Phase 4.
> Objectif : lancer le Panel, s'y connecter et le déployer **sans lire le
> code**.

---

## 1. Authentification — état des lieux

| Question | Réponse |
|---|---|
| Le Panel est-il protégé par un login ? | **Oui.** JWT HS256, mots de passe scrypt. Toute la surface `/api` est fermée. |
| Un compte est-il seedé automatiquement ? | **Oui**, au démarrage, **si la base ne contient aucun utilisateur**. |
| Un compte existant peut-il être écrasé ? | **Jamais.** Le seed ne s'exécute que sur une base vierge. |

Deux surfaces échappent au JWT, et c'est voulu :

- `GET /health` — vivacité publique ;
- `/bridge/v1/*` — le pont, qui a sa **propre** authentification par
  `bridgeToken`. S'il dépendait du JWT utilisateur, aucun projet ne pourrait
  jamais parler au Panel.

## 2. Les identifiants

### 2.1 En développement (`ENV=TEST`)

`SEED_DEV_EMAIL` et `SEED_DEV_PASSWORD` sont **facultatifs**. Non renseignés,
le Panel crée un compte de développement par défaut :

```text
e-mail        dev@panel.local
mot de passe  panel-dev-local
rôle          DEV
```

Ces identifiants sont **publics** — ils figurent dans ce dépôt. Ils
n'existent qu'en `ENV=TEST`, et le démarrage en `ENV=PROD` les **refuse**
explicitement s'ils y étaient recopiés.

Le Panel les annonce dans ses journaux au premier démarrage :

```text
[warn] Compte DEV de développement créé — dev@panel.local / panel-dev-local.
       Identifiants PUBLICS, valables en ENV=TEST uniquement.
```

Pour utiliser les vôtres, renseignez les deux variables dans
`backend/.env` **avant** le premier démarrage.

> **Sur cette machine**, un `.env` existe déjà avec
> `SEED_DEV_EMAIL=luca.duhoux@gmail.com`. Le mot de passe est la valeur de
> `SEED_DEV_PASSWORD` dans `Panel/backend/.env` — il n'est pas reproduit ici,
> et ne devrait figurer dans aucun compte-rendu. En cas d'oubli, voir §2.3.

### 2.2 En production (`ENV=PROD`)

Les deux variables deviennent **obligatoires** pour obtenir un compte
initial. Le démarrage est refusé si :

- l'adresse est un identifiant de développement connu ;
- le mot de passe est un mot de passe connu, ou fait moins de 12 caractères.

Aucun compte par défaut n'existe jamais en production.

### 2.3 Mot de passe perdu

Le seed ne s'exécute plus dès qu'un utilisateur existe — c'est ce qui
protège les comptes réels, et cela peut vous enfermer dehors.

```bash
cd Panel/backend
npm run dev:account                                   # compte par défaut
npm run dev:account -- moi@exemple.test monMotDePasse  # le vôtre
```

La commande crée le compte, ou **réinitialise** son mot de passe, puis
affiche comment se connecter. Elle **refuse de s'exécuter en `ENV=PROD`** :
réinitialiser un mot de passe par une commande locale y serait une porte
dérobée.

---

## 3. Lancer le Panel en local

### 3.1 Prérequis

Node.js ≥ 20 et une instance MongoDB joignable.

### 3.2 Configuration

```bash
cd Panel/backend
cp .env.example .env
```

Trois valeurs à générer :

```bash
node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"  # JWT_SECRET
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"  # BRIDGE_ENCRYPTION_KEY
```

```dotenv
ENV=TEST
PORT=4100
MONGODB_URI=mongodb://127.0.0.1:27017
DB_TEST=panel_test
JWT_SECRET=<64 hex>
JWT_EXPIRES_IN=12h
BRIDGE_ENCRYPTION_KEY=<64 hex>
PANEL_NAME=Panel L.Y Solution
# SEED_DEV_EMAIL / SEED_DEV_PASSWORD : laissez vides pour dev@panel.local
```

`config/env.js` est **fail-closed** : une variable obligatoire manquante
arrête le démarrage avec un message qui la nomme.

### 3.3 Démarrage

Deux terminaux :

```bash
cd Panel/backend  && npm install && npm run dev   # backend  → port 4100
cd Panel/frontend && npm install && npm run dev   # frontend → port 5273
```

## 4. À quelle URL accéder

| | URL |
|---|---|
| **Interface (c'est ici qu'on va)** | **http://localhost:5273** |
| API backend | http://localhost:4100 |
| Vivacité publique | http://localhost:4100/health |

Le frontend **proxifie** `/api` et `/health` vers le port 4100 : il n'y a
aucun CORS à configurer en développement, et `CORS_ORIGINS` reste vide.

## 5. Se connecter

Ouvrez **http://localhost:5273**, puis :

| Champ | Valeur |
|---|---|
| E-mail | `dev@panel.local` *(ou votre `SEED_DEV_EMAIL`)* |
| Mot de passe | `panel-dev-local` *(ou votre `SEED_DEV_PASSWORD`)* |

Vérification en ligne de commande, sans navigateur :

```bash
curl -X POST http://localhost:4100/api/auth/login \
  -H "content-type: application/json" \
  -d '{"email":"dev@panel.local","password":"panel-dev-local"}'
```

Réponse attendue : `{"success":true,"data":{"token":"…","user":{"role":"DEV"}}}`.

Puis, avec ce jeton :

```bash
curl http://localhost:4100/api/auth/me -H "authorization: Bearer <token>"
```

### Si la connexion échoue

| Symptôme | Cause | Correction |
|---|---|---|
| `PANEL_INVALID_CREDENTIALS` | mauvais mot de passe **ou** compte inexistant — la réponse est volontairement identique | `npm run dev:account` |
| journaux : « Aucun compte seed configuré » | la base contient déjà des utilisateurs | `npm run dev:account` |
| le backend ne démarre pas | variable manquante | lire le message, il nomme la variable |
| l'interface affiche « Impossible de contacter le serveur » | backend arrêté, ou port ≠ 4100 | démarrer le backend, ou ajuster le proxy Vite |

---

## 6. Déployer en production

### 6.1 Ce que le Panel est

Deux composants : un **frontend** statique servi à la racine du domaine, un
**backend** Node. Contrairement aux projets vitrines, le Panel n'a **aucun
sous-domaine** — son interface est à la racine.

### 6.2 Variables d'environnement de production

```dotenv
ENV=PROD
PORT=4100
MONGODB_URI=<URI joignable DEPUIS le serveur>
DB_PROD=panel_prod

JWT_SECRET=<64 hex, propre à CE déploiement>
JWT_EXPIRES_IN=12h
BRIDGE_ENCRYPTION_KEY=<64 hex, DIFFÉRENT de JWT_SECRET>

PANEL_NAME=Panel L.Y Solution
PUBLIC_URL=https://panel.exemple.com

# OBLIGATOIRES en PROD, et contrôlés au démarrage
SEED_DEV_EMAIL=admin@exemple.com
SEED_DEV_PASSWORD=<12 caractères minimum, jamais un mot de passe connu>
```

Deux avertissements qui coûtent cher si on les ignore :

- **`BRIDGE_ENCRYPTION_KEY` est irremplaçable.** La perdre ou la changer rend
  illisibles les `bridgeToken` chiffrés : **tous** les projets devront être
  ré-appairés.
- **`JWT_SECRET` ne se partage pas.** Un secret par déploiement. Le changer
  invalide toutes les sessions — c'est le geste de rotation.

### 6.3 Construire

```bash
cd Panel/frontend && npm ci && npm run build     # → frontend/dist
cd Panel/backend  && npm ci --omit=dev
```

### 6.4 Démarrer

Le backend est un processus Node ordinaire :

```bash
cd Panel/backend && node src/server.js
```

Sous PM2, comme le fait le moteur de déploiement :

```bash
pm2 start src/server.js --name panel-backend --cwd /var/www/panel.exemple.com/current/backend
pm2 save
```

Le backend **ne sert pas** le frontend : c'est nginx qui sert `dist/`.

### 6.5 Reverse proxy

Le moteur de déploiement génère cette configuration ; la voici pour une mise
en ligne manuelle.

```nginx
server {
    listen 443 ssl http2;
    server_name panel.exemple.com;

    ssl_certificate     /etc/letsencrypt/live/panel.exemple.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/panel.exemple.com/privkey.pem;

    # Frontend statique
    root /var/www/panel.exemple.com/current/frontend/dist;
    index index.html;

    # Application à page unique : toute route inconnue rend index.html
    location / {
        try_files $uri $uri/ /index.html;
    }

    # API interne
    location /api/ {
        proxy_pass http://127.0.0.1:4100;
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    # PONT — c'est par ici que les projets parlent au Panel.
    # L'oublier donne un Panel qui s'ouvre mais qu'aucun projet ne peut joindre.
    location /bridge/ {
        proxy_pass http://127.0.0.1:4100;
        proxy_set_header Host              $host;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    location /health {
        proxy_pass http://127.0.0.1:4100;
    }
}

server {
    listen 80;
    server_name panel.exemple.com;
    return 301 https://$host$request_uri;
}
```

Certificat :

```bash
sudo certbot --nginx -d panel.exemple.com
```

### 6.6 Après le premier démarrage

Renseignez l'**URL publique** dans la configuration système (interface →
Panel), et non seulement dans `PUBLIC_URL` : la valeur en base fait
autorité, et alimente les origines CORS
(`24_ENVIRONMENT_AND_DOMAINS.md`).

`app.set('trust proxy', 1)` est déjà en place : le backend lit correctement
`X-Forwarded-Proto` derrière nginx.

---

## 7. Vérifier après déploiement

Dans cet ordre — chaque étape suppose la précédente.

### 7.1 Le service répond

```bash
curl -i https://panel.exemple.com/health
```

Attendu : `200`. Sinon → PM2 (`pm2 logs panel-backend`) ou nginx.

### 7.2 Le certificat est valide

```bash
curl -sI https://panel.exemple.com | head -1
echo | openssl s_client -connect panel.exemple.com:443 2>/dev/null \
  | openssl x509 -noout -dates
```

### 7.3 L'interface se charge

Ouvrez `https://panel.exemple.com`. Un **404 sur une sous-route** après
rechargement signifie que `try_files … /index.html` manque.

### 7.4 La connexion fonctionne

```bash
curl -X POST https://panel.exemple.com/api/auth/login \
  -H "content-type: application/json" \
  -d '{"email":"admin@exemple.com","password":"<le vôtre>"}'
```

`401` → le compte n'a pas été seedé : la base n'était pas vierge, ou les
variables manquaient au premier démarrage. **`npm run dev:account` ne
fonctionne pas en PROD** : créez le compte via une base vierge, ou par une
insertion contrôlée.

### 7.5 Le pont est joignable — l'étape qu'on oublie

```bash
curl -H "x-bridge-contract-version: 1.3.0" \
  https://panel.exemple.com/bridge/v1/ping
```

Attendu : `{"success":true,"data":{"status":"ok","service":"panel-bridge-api",…}}`

C'est **cet** appel que fera chaque projet. S'il échoue, le Panel s'ouvre
normalement dans un navigateur et **aucun projet ne pourra jamais
s'appairer** — la cause est presque toujours un `location /bridge/` absent
de nginx.

### 7.6 La base est bien la base de production

Interface → **Panel** : l'environnement affiché doit être `PROD`. Un Panel
de production pointant sur `DB_TEST` est un incident silencieux.

### 7.7 Récapitulatif

| # | Contrôle | Commande |
|---|---|---|
| 1 | service | `curl -i https://…/health` |
| 2 | TLS | `openssl s_client … -dates` |
| 3 | interface | navigateur, avec rechargement d'une sous-route |
| 4 | connexion | `POST /api/auth/login` |
| 5 | **pont** | `GET /bridge/v1/ping` |
| 6 | environnement | interface → Panel |

---

## 8. Ce qui reste non prouvé

Les sections 6 et 7 décrivent une procédure **qui n'a pas été exécutée** :
aucune cible réelle n'a été fournie. Le protocole applicatif est prouvé de
bout en bout (`58_END_TO_END_TESTS.md`), mais sur `127.0.0.1`.

DNS, TLS, nginx, PM2 et pare-feu restent à éprouver — c'est l'objet de
`33_VPS_ACCEPTANCE.md`, toujours ouverte.
