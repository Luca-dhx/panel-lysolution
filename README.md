# Panel L.Y Solution

> Le point d'administration central de l'écosystème L.Y Solution. Outil
> **interne**, jamais vendu, jamais obligatoire pour les projets qu'il
> administre.

Le Panel est le **second point d'administration** des projets (le projet
vitrine de référence, puis un nombre illimité de projets issus de la
duplication). Il centralise, supervise et administrera — mais un projet doit
**toujours** pouvoir vivre sans lui. Cette promesse gouverne chaque ligne de
ce dépôt.

Le Panel est aussi **un projet standard de l'écosystème** : même stack, mêmes
conventions, même façon de se configurer et de se déployer que les projets
vitrines. Ce qui les distingue, ce sont leurs modules métier — pas leurs
fondations. Voir
[23_PANEL_STANDARD.md](docs/architecture/23_PANEL_STANDARD.md).

---

## État du dépôt — Phase 2C : fondations normalisées

Le squelette de la Phase 2B a été audité par comparaison au projet vitrine de
référence, puis normalisé.

Ce dépôt contient :

- l'implémentation **serveur** du contrat PanelBridge **v1.1.0** (appairage
  avec Manifest joint, heartbeat, sync push/pull) et le **client** du contrat
  ProjectBridge ;
- le **registre des projets**, l'**appairage** (codes à usage unique,
  bridgeToken haché et chiffré) et l'**authentification** (ADMIN/DEV) —
  intégralement **persistés en MongoDB** ;
- le **Manifest officiel** et l'interprétation des **capacités** (le Panel ne
  devine jamais la structure d'un projet) ;
- la **configuration système des domaines** : une source de vérité, un
  résolveur canonique, un CORS dérivé ;
- un **socle de déploiement** : releases versionnées, bascule atomique,
  Nginx généré, health checks, rollback, simulation ;
- la **santé/version** du Panel lui-même ;
- un frontend minimal : connexion, dashboard, liste des projets, états des
  bridges / versions / appairages.

**Aucun métier** : pas de contrats, pas de factures, pas de paiements, pas de
CRM, pas de supervision avancée, pas d'IntegratedAPI. Voir
[PHASE_3_PREPARATION.md](docs/architecture/PHASE_3_PREPARATION.md).

## Structure

```text
Panel/
├── backend/     API Express (ESM) — pont /bridge/v1 + API interne /api
├── frontend/    Interface React + TypeScript + Vite
├── deploy/      Moteur de déploiement (plan, Nginx, .env distant)
├── docs/
│   ├── architecture/   la documentation de référence du Panel
│   └── spec/           copies des deux contrats OpenAPI officiels (v1.1.0)
└── tests/       suite de tests (node, sans framework) — `npm test` depuis backend/
```

## Démarrage rapide

```bash
# Backend (port 4100) — MongoDB requise
cd backend
npm install
cp .env.example .env
# puis renseigner au minimum :
#   MONGODB_URI, DB_TEST
#   JWT_SECRET          → node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"
#   BRIDGE_ENCRYPTION_KEY → node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
#   SEED_DEV_EMAIL / SEED_DEV_PASSWORD
npm run dev

# Frontend (port 5273, proxy vers le backend)
cd frontend
npm install
npm run dev

# Tests — aucun service externe requis (MongoDB en mémoire)
cd backend
npm test

# Typecheck et build du frontend
cd frontend
npm run typecheck && npm run build

# Simulation de déploiement (n'exécute rien)
node deploy/deploy.mjs --host panel-recette.exemple.net --env TEST
```

Le backend **refuse de démarrer** si une variable critique est absente ou
faible (secret trop court, placeholder, identifiants seed par défaut en
PROD). C'est délibéré : voir
[24_ENVIRONMENT_AND_DOMAINS.md](docs/architecture/24_ENVIRONMENT_AND_DOMAINS.md).

## Documentation

| Document | Sujet |
|---|---|
| [00_VISION.md](docs/architecture/00_VISION.md) | Ce que le Panel est — et n'est pas |
| [01_PANEL_ARCHITECTURE.md](docs/architecture/01_PANEL_ARCHITECTURE.md) | Architecture technique |
| [02_PROJECT_REGISTRY.md](docs/architecture/02_PROJECT_REGISTRY.md) | Le registre des projets |
| [03_PANEL_BRIDGE.md](docs/architecture/03_PANEL_BRIDGE.md) | Les deux contrats de pont, côté Panel |
| [04_AUTHENTICATION.md](docs/architecture/04_AUTHENTICATION.md) | Les trois plans d'authentification |
| [05_PAIRING.md](docs/architecture/05_PAIRING.md) | L'appairage, de bout en bout |
| [06_PROJECT_LIFECYCLE.md](docs/architecture/06_PROJECT_LIFECYCLE.md) | La vie d'un projet vue du Panel |
| [07_DEPLOYMENT.md](docs/architecture/07_DEPLOYMENT.md) | Le Panel se déploie comme un projet |
| [20_MANAGER_STANDARD.md](docs/architecture/20_MANAGER_STANDARD.md) | **Le squelette officiel d'un projet compatible** |
| [21_PROJECT_CAPABILITIES.md](docs/architecture/21_PROJECT_CAPABILITIES.md) | Features, modules et interprétation |
| [22_DATA_MODEL.md](docs/architecture/22_DATA_MODEL.md) | Données locales, synchronisées, Panel |
| [23_PANEL_STANDARD.md](docs/architecture/23_PANEL_STANDARD.md) | **Le Panel comme projet standard de l'écosystème** |
| [24_ENVIRONMENT_AND_DOMAINS.md](docs/architecture/24_ENVIRONMENT_AND_DOMAINS.md) | **Variables, secrets, domaines, rotation** |
| [spec/README.md](docs/spec/README.md) | Gouvernance des contrats OpenAPI |
| [PHASE_3_PREPARATION.md](docs/architecture/PHASE_3_PREPARATION.md) | Ce qui reste volontairement à faire |

La documentation fondatrice de l'écosystème (philosophie, classification des
données, standards par domaine) vit dans le projet vitrine de référence. Ce
dépôt ne la répète pas — il l'applique, du point de vue du Panel, et
[20_MANAGER_STANDARD.md](docs/architecture/20_MANAGER_STANDARD.md) en est le
résumé autoporteur.

## Indépendance

Ce dépôt est **autonome** : il ne dépend d'aucun chemin local, d'aucun import
ni d'aucune hypothèse sur le dépôt d'un projet. Le seul outil qui regarde le
dépôt voisin est le contrôle de dérive des contrats
(`tests/spec-drift.check.mjs`), qui se retire proprement si ce dépôt n'est
pas présent. C'est vérifié mécaniquement par `tests/architecture.test.js`.
