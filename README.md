# Panel L.Y Solution

> Le point d'administration central de l'écosystème L.Y Solution —
> `panel.ly-solution.com`. Outil **interne**, jamais vendu, jamais obligatoire
> pour les projets qu'il administre.

Le Panel est le **second point d'administration** des projets (SB Auto 06, puis
un nombre illimité de projets issus de la duplication). Il centralise,
supervise et administrera — mais un projet doit **toujours** pouvoir vivre sans
lui. Cette promesse gouverne chaque ligne de ce dépôt.

---

## État du dépôt — Phase 2B : le squelette

Ce dépôt contient **uniquement les fondations** :

- l'implémentation **serveur** du contrat PanelBridge (appairage, heartbeat,
  sync push/pull) ;
- le **registre des projets** (donnée exclusivement Panel) ;
- le système d'**appairage** (codes à usage unique, bridgeToken) ;
- le **Manifest** et les **Capabilities** (le Panel ne devine jamais la
  structure d'un projet) ;
- l'**authentification** des utilisateurs du Panel (v1 : ADMIN/DEV) ;
- la **santé/version** du Panel lui-même (le Panel est un projet standard) ;
- un frontend minimal : connexion, dashboard, liste des projets, états des
  bridges / versions / appairages.

**Aucun métier** : pas de contrats, pas de factures, pas de paiements, pas de
CRM, pas de supervision avancée, pas d'IntegratedAPI. Voir
[docs/architecture/PHASE_3_PREPARATION.md](docs/architecture/PHASE_3_PREPARATION.md).

## Structure

```
Panel/
├── backend/     API Express (ESM) — bridge public /bridge/v1 + API interne /api
├── frontend/    Interface React + Vite + TypeScript
├── docs/
│   ├── architecture/   la documentation de référence du Panel
│   └── spec/           copie des deux contrats OpenAPI officiels (v1.0.0)
└── tests/       suite de tests (node, sans framework) — `npm test` depuis backend/
```

## Démarrage rapide

```bash
# Backend (port 4100)
cd backend
npm install
cp .env.example .env     # renseigner PANEL_JWT_SECRET et le compte seed
npm run dev

# Frontend (port 5273, proxy vers le backend)
cd frontend
npm install
npm run dev

# Tests
cd backend
npm test
```

## Documentation

| Document | Sujet |
|---|---|
| [00_VISION.md](docs/architecture/00_VISION.md) | Ce que le Panel est — et n'est pas |
| [01_PANEL_ARCHITECTURE.md](docs/architecture/01_PANEL_ARCHITECTURE.md) | Architecture technique du squelette |
| [02_PROJECT_REGISTRY.md](docs/architecture/02_PROJECT_REGISTRY.md) | Le registre des projets |
| [03_PANEL_BRIDGE.md](docs/architecture/03_PANEL_BRIDGE.md) | Les deux contrats de pont, côté Panel |
| [04_AUTHENTICATION.md](docs/architecture/04_AUTHENTICATION.md) | Les trois plans d'authentification |
| [05_PAIRING.md](docs/architecture/05_PAIRING.md) | L'appairage, de bout en bout |
| [06_PROJECT_LIFECYCLE.md](docs/architecture/06_PROJECT_LIFECYCLE.md) | La vie d'un projet vue du Panel |
| [07_DEPLOYMENT.md](docs/architecture/07_DEPLOYMENT.md) | Le Panel se déploie comme un projet |
| [20_MANAGER_STANDARD.md](docs/architecture/20_MANAGER_STANDARD.md) | **Le squelette officiel d'un projet compatible** |
| [21_PROJECT_CAPABILITIES.md](docs/architecture/21_PROJECT_CAPABILITIES.md) | Le système de capacités |
| [22_DATA_MODEL.md](docs/architecture/22_DATA_MODEL.md) | Modèle de données : locales, synchronisées, Panel |
| [PHASE_3_PREPARATION.md](docs/architecture/PHASE_3_PREPARATION.md) | Ce qui est volontairement laissé à la Phase 3 |

La documentation fondatrice de l'écosystème (philosophie, classification des
données, standards par domaine) vit dans le projet modèle :
`SB Auto 06/docs/panelXvitrine/`. Ce dépôt ne la répète pas — il l'applique,
du point de vue du Panel.
