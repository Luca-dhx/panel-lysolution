# 01 — Architecture technique du Panel

> Prérequis : [00_VISION.md](00_VISION.md).
> Ce document décrit l'architecture livrée en Phase 2C — chaque dossier cité
> existe dans ce dépôt. Voir aussi [23_PANEL_STANDARD.md](23_PANEL_STANDARD.md).

---

## 1. Le Panel est un projet standard

Le Panel suit les conventions des projets de l'écosystème : backend Express
(ESM) + interface React/Vite, variables d'environnement dans `.env`, `ENV`
applicatif `TEST`/`PROD`, endpoints `/health` et `/api/version`, tests en
scripts node sans framework. Ce n'est pas un mimétisme gratuit : le moteur de
déploiement, la supervision et l'outillage sont partagés avec les projets —
une seule architecture à maintenir.

## 2. Les deux surfaces HTTP

Le backend expose deux surfaces strictement séparées :

```
                        BACKEND DU PANEL (port 4100)
   ┌──────────────────────────────────────────────────────────────────┐
   │                                                                  │
   │  /bridge/v1/*            SURFACE PUBLIQUE DE PONT                │
   │  ─────────────           consommée par le PanelBridge des        │
   │  ping · pairings ·       projets. Contrat OpenAPI v1.1.0,        │
   │  heartbeats ·            auth par bridgeToken, erreurs BRIDGE_*  │
   │  sync/push · sync/pull                                           │
   │                                                                  │
   │  /api/*                  SURFACE INTERNE                         │
   │  ──────                  consommée par le frontend du Panel.     │
   │  auth · projects ·       Catégorie 3, jamais exposée aux         │
   │  version                 projets. Auth par JWT utilisateur,      │
   │                          erreurs PANEL_*                         │
   │                                                                  │
   │  /health                 vivacité (public, sans auth)            │
   └──────────────────────────────────────────────────────────────────┘
```

Règles de séparation :

1. La surface `/bridge/v1` n'accepte **que** le bridgeToken d'un projet
   appairé (sauf `ping` et `pairings`, définis sans auth par le contrat).
   Un JWT utilisateur n'y ouvre rien.
2. La surface `/api` n'accepte **que** les utilisateurs du Panel. Un
   bridgeToken n'y ouvre rien.
3. Les deux surfaces partagent l'enveloppe de réponse (`{success, data}` /
   `{success, code, message, details?}`) mais pas leurs catalogues d'erreurs.

## 3. Arborescence du backend

```
backend/src/
├── server.js                  démarrage : Mongo, seed, CORS, écoute, arrêt propre
├── app.js                     assemblage Express (CORS, routes, erreurs, 404)
├── ecosystem.config.cjs       PM2 (aucun domaine ni port figé)
├── scripts/
│   └── set-network-configuration.mjs  propagation du domaine (déploiement)
├── config/
│   ├── env.js                 lecture .env — SEUL fichier qui lit process.env
│   └── db.js                  connexion Mongoose (dbName selon ENV)
├── models/                    schémas Mongoose (projets, utilisateurs,
│                              configuration système, état de synchronisation)
├── bridge/
│   ├── bridgeContract.js      MIROIR EXÉCUTABLE des deux specs OpenAPI :
│   │                          version, routes, codes d'erreur, entityTypes,
│   │                          schémas zod des DTO — verrouillé par
│   │                          tests/bridge-conformity.test.js
│   └── ProjectBridgeClient.js SEUL fichier qui parle réseau aux projets
│                              (côté client du contrat ProjectBridge)
├── services/
│   ├── registry/              registre des projets (catégorie 3)
│   │   ├── registryStore.js   persistance MongoDB, interface stable
│   │   └── projectRegistry.service.js
│   ├── pairing/
│   │   └── pairing.service.js codes d'appairage, bootstrap, révocation
│   ├── sync/
│   │   └── syncCore.service.js  idempotence, LWW, anti-écho, journal, acks
│   ├── manifest/
│   │   ├── capabilities.catalog.js  catalogue officiel des features
│   │   ├── manifest.schema.js       validation du ProjectManifest (zod)
│   │   └── capabilities.service.js  interprétation → modules d'interface
│   ├── network/
│   │   └── networkConfig.service.js  SEUL résolveur d'URL (domaines, CORS)
│   ├── versioning/
│   │   └── versionCompatibility.js  semver, compatibilité de contrat, dérive
│   ├── auth/
│   │   ├── panelUsers.service.js    utilisateurs v1 (seed, scrypt)
│   │   └── panelToken.service.js    JWT du Panel
│   └── health/
│       └── health.service.js        santé/version du Panel lui-même
├── utils/
│   ├── ApiError.js            erreurs de la surface interne (PANEL_*)
│   ├── apiResponse.js         enveloppes ok()/created()
│   ├── asyncHandler.js
│   ├── logger.js              journalisation sans dépendance
│   ├── normalizeAppUrl.js     une URL d'app est une ORIGINE
│   └── panelCrypto.js         AES-256-GCM (BRIDGE_ENCRYPTION_KEY) + SHA-256
├── middlewares/
│   ├── bridgeContractVersion.middleware.js  X-Bridge-Contract-Version
│   ├── bridgeAuth.middleware.js             bridgeToken → projet appairé
│   ├── panelAuth.middleware.js              JWT → utilisateur du Panel
│   ├── cors.middleware.js                   origines dérivées des URLs
│   └── error.middleware.js                  enveloppes d'erreur, 404
├── controllers/
│   ├── bridge.controller.js
│   ├── auth.controller.js
│   ├── projects.controller.js
│   ├── network.controller.js
│   └── meta.controller.js
└── routes/
    ├── bridge.routes.js       /bridge/v1
    ├── auth.routes.js         /api/auth
    ├── projects.routes.js     /api/projects
    ├── network.routes.js      /api/system-configuration
    └── meta.routes.js         /health, /api/version
```

## 4. Choix techniques

| Sujet | Choix | Pourquoi |
|---|---|---|
| Runtime | Node ≥ 20, ESM, `fetch` natif | conventions de l'écosystème, zéro dépendance de transport |
| Serveur | Express 4 | convention des projets |
| Base de données | MongoDB + Mongoose 8, `ENV` sélectionne `DB_TEST`/`DB_PROD` | convention des projets ([24](24_ENVIRONMENT_AND_DOMAINS.md)) |
| Configuration | `config/env.js`, seul lecteur de `process.env`, fail-closed | convention des projets, verrouillée par test |
| Validation | zod — schémas stricts dans `bridgeContract.js` et `manifest.schema.js` | même patron que le miroir exécutable du projet modèle |
| Auth interne | JWT (`jsonwebtoken`), mots de passe scrypt (crypto natif) | pas de dépendance native, discipline standard |
| Secrets de pont | bridgeToken aléatoire 256 bits ; **hash SHA-256** pour vérifier les requêtes entrantes (comparaison en temps constant) + **copie chiffrée AES-256-GCM** (`BRIDGE_ENCRYPTION_KEY`) pour les appels sortants du `ProjectBridgeClient` ; jamais exposé par une API | le même secret authentifie les deux sens du pont ; un projet compromis ne compromet pas les autres |
| Persistance | **MongoDB** derrière des interfaces de store stables (`registryStore.js`) : registre, utilisateurs, appairages, manifestes, idempotence et journal de synchronisation | tout état nécessaire après redémarrage est persisté ; les services ne connaissent pas Mongoose — même démarche que la persistance d'appairage du projet modèle |
| Journalisation | jamais un secret en clair (token, code d'appairage, mot de passe) | discipline de masquage de l'écosystème |

## 5. Frontend

```
frontend/src/
├── main.tsx / App.tsx        routage (react-router), gardes d'accès
├── lib/api.ts                client HTTP unique vers /api (JWT en mémoire)
├── auth/                     AuthContext + RequireAuth
├── config/nav.ts             navigation déclarative (même patron que le Manager)
└── pages/
    ├── LoginPage.tsx         connexion
    ├── DashboardPage.tsx     dashboard volontairement vide (compteurs de base)
    ├── ProjectsPage.tsx      liste des projets + déclaration d'un projet
    ├── BridgesPage.tsx       état des ponts (joignabilité, dernier heartbeat)
    ├── VersionsPage.tsx      versions logicielles et de contrat du parc
    └── PairingsPage.tsx      états d'appairage, génération de codes
```

Le frontend ne parle **qu'à la surface interne** `/api`. Il ne parle jamais à
un projet : quand une page affiche l'état d'un pont, c'est le backend du Panel
qui a interrogé le projet (via `ProjectBridgeClient`) ou qui restitue les
heartbeats reçus.

## 6. Observabilité et robustesse

- Tout appel sortant vers un projet a un **timeout court** (10 s), ne lève
  jamais d'exception brute et n'est jamais dans le chemin critique d'une
  requête utilisateur autre que les écrans de supervision.
- Le démarrage du serveur n'attend rien de bloquant : pas de réseau, pas de
  base — un `npm run dev` démarre toujours.
- Chaque projet du registre expose : dernier heartbeat, dernière santé,
  versions parlées, état d'appairage — la matière première des écrans du
  frontend et de la supervision Phase 3.

## 7. Ce que l'architecture interdit

1. ❌ Un service qui appelle un projet sans passer par `ProjectBridgeClient`.
2. ❌ Un contrôleur qui lit `process.env` (tout passe par `config/env.js`).
3. ❌ Une route `/bridge/v1` qui ne valide pas ses DTO par le miroir
   `bridgeContract.js`.
4. ❌ Un store qui fuit dans les contrôleurs : l'accès aux données passe par
   les services.
5. ❌ Du métier dans ce squelette : un module métier de Phase 3 s'AJOUTE
   (nouveau service + nouvelles routes) sans modifier les fondations.
