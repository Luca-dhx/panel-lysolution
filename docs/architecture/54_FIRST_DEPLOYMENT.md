# 54 — Première installation, de zéro à un écosystème vivant

> **Guide de reproduction.** Phase 4.
> Objectif : qu'un développeur qui n'a jamais vu ce code obtienne un Panel et
> un projet qui se parlent réellement.

---

## 1. Ce que vous obtiendrez

À la fin de ce guide :

- le Panel tourne et sait quelle entreprise il représente ;
- SB Auto 06 tourne, est appairé, et affiche l'identité de cette entreprise ;
- le Panel voit le projet **en ligne** grâce à des heartbeats réels ;
- une modification de configuration faite dans le Panel **arrive** au projet ;
- un accès à un service tiers accordé dans le Panel **arrive** au projet, en
  mode TEST, restreint aux clés autorisées.

Aucune de ces étapes n'est simulée.

## 2. Prérequis

| | |
|---|---|
| Node.js | ≥ 20 |
| MongoDB | une instance joignable (locale ou distante) |
| Les deux dépôts | clonés **côte à côte** |

```text
<WORKSPACE>/
├── Panel/          https://github.com/Luca-dhx/panel-lysolution.git
└── SB Auto 06/     https://github.com/Luca-dhx/sbauto06.git
```

Les deux dépôts sont **indépendants** : aucune dépendance de chemin, aucun
paquet partagé, deux `.env`, deux déploiements. Ils sont côte à côte par
commodité d'atelier, pas par nécessité technique.

## 3. Le Panel

### 3.1 Configuration

`Panel/backend/.env` — copiez `.env.example` et renseignez :

```dotenv
ENV=TEST
PORT=4100
MONGODB_URI=mongodb://127.0.0.1:27017
DB_TEST=panel_test
DB_PROD=panel_prod

# 32+ caractères aléatoires. JAMAIS la même valeur que le projet.
JWT_SECRET=<aléatoire>
JWT_EXPIRES_IN=12h

# 64 caractères hexadécimaux. Chiffre les bridgeTokens et les identifiants
# d'API. La perdre rend TOUS les projets à ré-appairer.
BRIDGE_ENCRYPTION_KEY=<64 hex>

PANEL_NAME=Panel L.Y Solution
SEED_DEV_EMAIL=dev@exemple.test
SEED_DEV_PASSWORD=<12+ caractères>
CORS_ORIGINS=http://localhost:5174
```

Générer les secrets :

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

`config/env.js` est **fail-closed** : une variable obligatoire manquante
arrête le démarrage avec un message qui la nomme. C'est voulu — un Panel qui
démarre à moitié configuré est plus dangereux qu'un Panel qui refuse.

### 3.2 Démarrage

```bash
cd Panel/backend && npm install && npm run dev     # → http://localhost:4100
cd Panel/frontend && npm install && npm run dev    # → http://localhost:5174
```

Connectez-vous avec `SEED_DEV_EMAIL` / `SEED_DEV_PASSWORD`.

### 3.3 Vérification

```bash
curl http://localhost:4100/health
curl -H "x-bridge-contract-version: 1.3.0" http://localhost:4100/bridge/v1/ping
```

Le second appel est celui que fera le projet. S'il échoue, l'appairage
échouera aussi.

## 4. L'entreprise

**Avant toute chose.** Le Panel ne peut pas se présenter aux projets tant
qu'il ne sait pas qui il représente — et un projet appairé avant qu'une
configuration existe repartira sans identité.

Interface → **Entreprise** → renseigner nom, identifiant, environnement, puis
la marque et les mentions légales. Voir `57_COMPANY_CONFIGURATION.md`.

Puis **publier** avec une raison. Saisir ne diffuse rien ; publier diffuse.

## 5. Le projet

### 5.1 Configuration

`SB Auto 06/backend/.env` :

```dotenv
ENV=TEST
PORT=4000
MONGODB_URI=mongodb://127.0.0.1:27017
DB_TEST=sbauto_test
DB_PROD=sbauto_prod

# DIFFÉRENTS de ceux du Panel. Deux applications, deux jeux de secrets.
JWT_SECRET=<aléatoire>
INTEGRATED_API_ENCRYPTION_KEY=<64 hex>

PROJECT_NAME=SB Auto 06
SEED_DEV_EMAIL=dev@exemple.test
SEED_DEV_PASSWORD=<12+ caractères>

# ── PONT VERS LE PANEL (Phase 4) ─────────────────────────────────────────
# Tout est optionnel : sans ces lignes le projet démarre et sert son site
# exactement comme avant.
PANEL_URL=http://localhost:4100
PUBLIC_BACKEND_URL=http://localhost:4000
PANEL_HEARTBEAT_INTERVAL_S=60
PANEL_SYNC_INTERVAL_S=120
```

`PUBLIC_BACKEND_URL` mérite une insistance : c'est l'adresse par laquelle le
**Panel** joindra le projet. Sans elle, le Panel connaît le projet mais ne
peut ni contrôler sa santé, ni relire son Manifest, ni le piloter.

### 5.2 Démarrage

```bash
cd "SB Auto 06/backend" && npm install && npm run dev
```

## 6. L'appairage

Voir `55_PAIRING_GUIDE.md` pour le détail et les cas d'échec.

En résumé : le Panel crée le projet et délivre un code à usage unique ; le
projet appelle le Panel avec ce code. **C'est toujours le projet qui
initie** — un Panel ne s'invite pas dans un projet.

## 7. Vérifier que l'écosystème est vivant

Cinq contrôles, dans cet ordre :

| # | Où | Ce qu'on doit voir |
|---|---|---|
| 1 | Panel → Parc | le projet, **En ligne** |
| 2 | Panel → fiche projet | Manifest « reçu par le pont », moteurs 1.1.0 |
| 3 | Panel → fiche projet → Configuration d'entreprise | version publiée = version appliquée |
| 4 | Projet → `/api/panel-connection/status` | l'entreprise, sa marque, sa version |
| 5 | Panel → Actions | l'exécution `DISCOVER_PROJECT` réussie |

Si le point 1 échoue mais que le projet tourne, l'ordonnanceur est en cause :
vérifiez `PANEL_SCHEDULER_ENABLED` et les journaux `[panel-bridge]`.

Si le point 3 dit « version 1 appliquée, version 2 publiée », le projet n'a
pas encore rattrapé : attendez `PANEL_SYNC_INTERVAL_S`, ou forcez avec
`POST /api/panel-connection/sync-now`.

## 8. Reproduire automatiquement

Tout ce guide est exécuté par un test :

```bash
cd Panel && node tests/ecosystem-e2e.test.js
```

Il démarre les deux backends sur deux bases distinctes, les fait s'appairer,
publier, synchroniser, diverger, converger, et se reconnecter après une
coupure — 75 assertions, uniquement par HTTP. Voir `58_END_TO_END_TESTS.md`.

Si ce test passe et que votre installation manuelle échoue, la différence est
dans votre `.env`, pas dans le code.

## 9. Mise en ligne sur un serveur

Ce guide couvre une installation **locale**. La mise en ligne réelle (DNS,
TLS, nginx, PM2, pare-feu) relève du moteur de déploiement et de sa recette :
`33_VPS_ACCEPTANCE.md`.

**État au terme de la Phase 4 : cette recette n'a pas été exécutée.** Aucune
cible réelle n'a été fournie. Le protocole est prouvé de bout en bout ;
l'hébergement ne l'est pas. Ne présumez pas que ce qui marche sur
`127.0.0.1` marchera derrière un reverse proxy sans l'avoir vérifié.
