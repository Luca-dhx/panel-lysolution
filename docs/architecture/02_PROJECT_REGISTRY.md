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
4. **La version de contrat est un état RUNTIME, pas un état d'appairage.**
   `pairing` fige ce qui a été observé le jour de l'appairage ;
   `runtime.contractVersion` dit ce qui est **parlé maintenant**. Elle voyage
   dans l'en-tête `x-bridge-contract-version` de **chaque** requête, où la garde
   de compatibilité la lit déjà — aucun champ n'a été ajouté au corps du
   battement, ce qui aurait créé une seconde source de vérité. Un projet monté
   de 1.12 à 1.13 converge donc au premier battement : sans réappairage, sans
   intervention en base, sans redémarrage du Panel. `null` ne remplace jamais
   une valeur connue : l'absence d'information n'est pas l'information
   « aucune version ». **La supervision décrit le vivant : elle lit
   `runtime.contractVersion`.**

### Deux runtimes pour un seul projet

Le jeton de pont **est** l'identité. Deux processus qui le détiennent sont, pour
le Panel, le même projet — et c'est voulu : c'est ce qui permet de redéployer
sans réappairer.

Conséquence observée en recette : une instance locale oubliée, sur du code
périmé, battait vers le Panel de recette une fois par minute avec le jeton du
projet déployé. La fiche affichait donc, **en alternance et sans le dire**,
l'état de deux logiciels différents — elle annonçait un contrat 1.10.0 pendant
que l'instance déployée parlait 1.13.0, et le mécanisme de convergence était
pourtant correct. Chaque battement, pris isolément, était parfaitement valide :
aucun écran ne pouvait révéler le problème.

Le Panel **n'en élit aucun** — il lui faudrait un critère qu'il n'a pas, et le
mauvais choix couperait un projet légitime. Il **détecte et nomme** ; un humain
tranche. Même doctrine que l'enlisement d'un rejeu.

**Comment on distingue un redémarrage d'une rivalité** — par la monotonie. Le
temps de fonctionnement d'un runtime ne fait que croître ; un redémarrage le
remet près de zéro et il recroît depuis là, et **une lignée abandonnée ne revient
jamais**. Deux instances qui alternent font l'inverse : la lignée qu'on croyait
morte **ressuscite** au battement suivant, avec un temps de fonctionnement
cohérent avec sa propre histoire. C'est cette résurrection — et elle seule — qui
prouve que deux logiciels vivent en même temps.

Aucun champ n'a été ajouté au contrat : `softwareVersion` et
`runtime.uptimeSeconds` sont déjà déclarés et suffisent. Un projet qui ne déclare
pas son temps de fonctionnement ne déclenche **aucune** alerte — deviner à partir
du seul numéro de version inventerait une rivalité à chaque redéploiement, et une
alerte qui se trompe est une alerte qu'on apprend à ignorer.

Le constat vit sur `runtime.rivalRuntime`, remonte à la projection publique et
s'affiche en tête de l'onglet développeur. Il se referme seul lorsque la rivale
n'est plus revenue depuis dix minutes.

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
| `PUT /api/projects/:projectId/manifest` | déclarer/mettre à jour le Manifest — **canal de secours** : refusé dès qu'un Manifest est arrivé par le pont (voir [20](20_MANAGER_STANDARD.md) §4) | DEV |
| `DELETE /api/projects/:projectId` | retirer un projet du registre (vente, erreur de saisie) — n'affecte en RIEN le projet lui-même | DEV |

## 5. Ce que le registre interdit

1. ❌ Stocker une donnée métier d'un projet, une URI Mongo, un secret en clair.
2. ❌ Deux fiches pour un même `projectKey` (unicité).
3. ❌ Une écriture du registre déclenchée par un projet **hors des chemins du
   contrat** (bootstrap, heartbeat, sync) : le registre appartient au Panel.
4. ❌ Exposer le registre sur la surface `/bridge/v1` : un projet ne voit
   jamais la liste des autres projets.

## 6. Persistance

**MongoDB** (collection `panelprojects`, base sélectionnée par `ENV`), via
`registryStore.js` qui conserve son interface stable
(get/list/insert/save/remove) : les services ne connaissent pas Mongoose.

Ce qui survit à un redémarrage : la fiche, son statut d'appairage, les hashs
et la copie chiffrée du bridgeToken, le Manifest et sa source, le dernier
heartbeat. Une suppression et une révocation sont définitives. Vérifié par un
test de redémarrage simulé (`tests/persistence.test.js`).

Ce qui n'est **jamais** stocké : la vivacité et les capacités interprétées —
ce sont des fonctions pures, recalculées à la lecture.
