# 02 — Le registre des projets

> Prérequis : [00_VISION.md](00_VISION.md).
> Le registre est LA donnée fondatrice du Panel : la liste des projets qu'il
> administre. C'est une donnée **exclusivement Panel** (catégorie 3) — elle ne
> transite jamais vers un projet.

---

## 1. Rôle

Le registre répond à quatre questions, pour chaque projet du parc :

1. **Qui es-tu ?** — identité (`projectKey`, nom, `projectId` UUID).
2. **Sommes-nous appairés ?** — état d'appairage, credentials, historique.
3. **Que sais-tu faire ?** — Manifest et Capabilities
   ([20](20_MANAGER_STANDARD.md), [21](21_PROJECT_CAPABILITIES.md)).
4. **Comment vas-tu ?** — dernier heartbeat, santé, versions, joignabilité.

Il ne répond **jamais** à « que contiens-tu ? » : aucune donnée métier d'un
projet (catégorie 1) n'entre dans le registre.

## 2. La fiche projet

```
ProjectRecord
├── projectId            UUID, identité du projet dans le Panel (délivrée à la
│                        déclaration, renvoyée au bootstrap)
├── projectKey           identifiant stable et lisible (« sb-auto-06 »),
│                        unique dans le registre
├── projectName          nom d'affichage (« SB Auto 06 »)
├── createdAt / updatedAt
├── pairing
│   ├── status           DECLARED | PAIRED | REVOKED
│   ├── pairingCodeHash  SHA-256 du code à usage unique (jamais le code)
│   ├── pairingCodeExpiresAt
│   ├── bridgeTokenHash  SHA-256 du bridgeToken — vérifie les requêtes
│   │                    ENTRANTES du projet (comparaison temps constant)
│   ├── bridgeTokenEncrypted  copie AES-256-GCM du token — permet les appels
│   │                    SORTANTS du ProjectBridgeClient (un seul secret
│   │                    d'appairage pour les deux sens) ; jamais exposée
│   ├── pairedAt / revokedAt
├── runtime              ce que le projet a déclaré de lui-même
│   ├── environment      TEST | PROD (ENV applicatif du backend appairé)
│   ├── softwareVersion  version déployée
│   ├── contractVersion  version de contrat parlée par son PanelBridge
│   ├── publicBackendUrl URL du ProjectBridge, ou null (projet en local
│   │                    → le Panel fonctionne en pull-only avec lui)
│   ├── lastHeartbeatAt / lastHealth { status, details }
│   └── bridgeStats      { outboxSize, lastSyncAt } (observabilité du pont)
└── manifest             Manifest « Manager Standard » déclaré, ou null
                         (capabilities dérivées : voir 21 §4)
```

### Règles sur la fiche

1. Aucun secret en clair au repos : le code d'appairage n'existe qu'en hash
   (affiché une seule fois à sa génération) ; le bridgeToken n'est retourné
   qu'une seule fois, au bootstrap, au projet lui-même — le Panel n'en garde
   que le hash (vérification entrante) et une copie chiffrée réservée au
   `ProjectBridgeClient` (appel sortant). Aucune API ne peut les réafficher —
   c'est volontaire.
2. `runtime` est **déclaratif** : c'est ce que le projet a dit de lui (au
   bootstrap puis à chaque heartbeat). Le Panel l'horodate et le restitue ; il
   ne l'invente jamais.
3. `manifest` peut être `null` : un projet sans Manifest est un projet valide
   (capacités inconnues → le Panel n'affiche que le socle commun).

## 3. Cycle de vie dans le registre

```
  déclaration          bootstrap réussi            révocation
  (API interne)        (POST /bridge/v1/pairings)  (Panel ou projet)
      │                        │                        │
      ▼                        ▼                        ▼
 ┌──────────┐  code émis  ┌──────────┐            ┌──────────┐  nouveau code
 │ DECLARED │────────────▶│  PAIRED  │───────────▶│ REVOKED  │──────────────┐
 └──────────┘             └──────────┘            └──────────┘              │
      ▲                                                                     │
      └─────────────────────────────────────────────────────────────────────┘
                        ré-appairage : REVOKED → DECLARED (nouveau code)
```

Le détail des transitions : [05_PAIRING.md](05_PAIRING.md) et
[06_PROJECT_LIFECYCLE.md](06_PROJECT_LIFECYCLE.md). La **joignabilité**
(ONLINE/STALE/OFFLINE) est un axe séparé, dérivé des heartbeats — voir 06 §3.

## 4. API interne du registre

Surface `/api` (utilisateurs du Panel uniquement — [04](04_AUTHENTICATION.md)) :

| Route | Rôle | Garde |
|---|---|---|
| `GET /api/projects` | liste du parc, avec états dérivés | utilisateur |
| `GET /api/projects/:projectId` | fiche détaillée | utilisateur |
| `POST /api/projects` | **déclarer** un projet (`projectKey`, `projectName`, `manifest?`) → fiche + code d'appairage (affiché une seule fois) | DEV |
| `POST /api/projects/:projectId/pairing-code` | regénérer un code (DECLARED/REVOKED uniquement) | DEV |
| `DELETE /api/projects/:projectId/pairing` | révoquer l'appairage côté Panel | DEV |
| `PUT /api/projects/:projectId/manifest` | déclarer/mettre à jour le Manifest (canal Phase 2B — voir [20](20_MANAGER_STANDARD.md) §6) | DEV |
| `DELETE /api/projects/:projectId` | retirer un projet du registre (vente, erreur de saisie) — n'affecte en RIEN le projet lui-même | DEV |

## 5. Ce que le registre interdit

1. ❌ Stocker une donnée métier d'un projet, une URI Mongo, un secret en clair.
2. ❌ Deux fiches pour un même `projectKey` (unicité).
3. ❌ Une écriture du registre déclenchée par un projet **hors des chemins du
   contrat** (bootstrap, heartbeat, sync) : le registre appartient au Panel.
4. ❌ Exposer le registre sur la surface `/bridge/v1` : un projet ne voit
   jamais la liste des autres projets.

## 6. Persistance

Phase 2B : store en mémoire (`registryStore.js`) derrière une interface
stable (get/list/insert/update/remove). Phase 3 : adaptateur Mongo (bases
TEST/PROD du Panel) branché sur la même interface — même démarche que la
persistance d'appairage du projet modèle (`pairingStore.js` → adaptateur
Mongo, API inchangée).
