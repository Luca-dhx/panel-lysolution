# 22 — Modèle de données du Panel

> Prérequis : [00_VISION.md](00_VISION.md) §4 (classification),
> [02_PROJECT_REGISTRY.md](02_PROJECT_REGISTRY.md).
> Ce document décrit TOUTES les données que le Panel manipule : les siennes,
> celles qu'il synchronisera, et celles qu'il ne touchera jamais.

---

## 1. La carte

```
┌─────────────────────────── PANEL ────────────────────────────┐
│                                                              │
│  DONNÉES EXCLUSIVEMENT PANEL (catégorie 3) — n'existent      │
│  qu'ici, ne transitent jamais vers un projet :               │
│    PanelUser · ProjectRecord (registre) · codes d'appairage  │
│    heartbeats · journal de sync · écritures reçues           │
│                                                              │
│  COPIES PANEL DES DONNÉES SYNCHRONISÉES (catégorie 2) —      │
│  Phase 3+ : contrats, factures, société développeur,         │
│  templates, configs IntegratedAPI, événements, réunions      │
│  (vides en Phase 2B — seul DIAGNOSTIC transite)              │
└──────────────────────────────────────────────────────────────┘
                             ▲
                             │ SyncChange (writeId, LWW, tombstones,
                             │ anti-écho, idempotence) — les 5 règles,
                             │ rien au-delà
                             ▼
┌────────────────────────── PROJET ────────────────────────────┐
│  copies projet des données synchronisées (cat. 2)            │
│  données locales (cat. 1) — INVISIBLES pour le Panel :       │
│    services, réservations, clients, thème, comptes locaux,   │
│    moteurs (contrats, facturation, duplication, déploiement) │
└──────────────────────────────────────────────────────────────┘
```

## 2. Les entités exclusivement Panel (catégorie 3)

### 2.1 `PanelUser`

| Champ | Notes |
|---|---|
| `userId` (uuid), `email` (unique), `displayName` | |
| `role` | `ADMIN` \| `DEV` (v1 — le RBAC futur remplacera ce champ sans toucher au reste) |
| `passwordHash` | scrypt `N=16384,r=8,p=1`, sel par utilisateur — jamais réversible |
| `createdAt` | |

Cycle de vie : seed au démarrage (compte DEV) ; gestion complète des
collaborateurs en Phase 3. Jamais exporté hors du Panel.

### 2.2 `ProjectRecord` (le registre)

Décrit en détail dans [02_PROJECT_REGISTRY.md](02_PROJECT_REGISTRY.md) §2 :
identité (`projectId`, `projectKey`, `projectName`), bloc `pairing` (statut,
hashes, dates), bloc `runtime` (déclaratif : versions, ENV, santé, URL
publique, bridgeStats), `manifest`.

Cycle de vie : créé à la déclaration → enrichi au bootstrap et à chaque
heartbeat → figé à la révocation → supprimé à la sortie du parc. La
suppression n'émet **rien** vers le projet : elle n'efface que la mémoire du
Panel.

### 2.3 Codes d'appairage

Portés par la fiche projet (`pairingCodeHash`, `pairingCodeExpiresAt`).
Cycle de vie : générés à la déclaration ou à la demande, consommés au
bootstrap (succès comme échec aval), expirés par TTL. Un seul code actif par
fiche.

### 2.4 Heartbeats

Le dernier heartbeat est dénormalisé sur la fiche (`runtime.lastHeartbeatAt`,
`runtime.lastHealth`…). La vivacité (ONLINE/STALE/OFFLINE) est **dérivée à la
lecture**, jamais stockée ([06](06_PROJECT_LIFECYCLE.md) §3). Un historique
borné (durée de rétention à fixer) arrivera avec la supervision de Phase 3.

### 2.5 Journal de synchronisation (côté émission)

`SyncJournalEntry` : `{ seq, writeId, entityType, entityId, deleted, payload,
modifiedAt, emitter: 'PANEL', originProjectId | null }` — la file ordonnée
que les projets consomment via `GET /bridge/v1/sync/pull`.

- `seq` (monotone) fonde le **curseur opaque** (encodage base64url de la
  position — le projet le stocke tel quel et le renvoie).
- `originProjectId` permet l'**anti-écho** : une écriture arrivée du projet A
  et rediffusée par le Panel ne doit jamais revenir vers A.
- Tombstones conservés (rétention N jours, à fixer en Phase 3 avec la
  persistance).
- **Vide en Phase 2B** : aucun domaine n'est synchronisé ; le mécanisme est
  testé avec des écritures DIAGNOSTIC.

### 2.6 Écritures reçues (côté réception)

`ReceivedWrite` : par projet, l'ensemble des `writeId` déjà traités (fonde
l'ack `DUPLICATE`) et, par `(entityType, entityId)`, le dernier `modifiedAt`
appliqué (fonde l'ack `IGNORED` du dernier-écrit-gagne). C'est la mémoire
d'idempotence du Panel — équivalent central du `WebhookEvent` local des
projets.

## 3. Les données synchronisées (catégorie 2) — cadre pour la Phase 3

Aucune n'est synchronisée en Phase 2B. Le cadre, figé dès maintenant :

| `entityType` (contrat v1) | Domaine | Lot |
|---|---|---|
| `DIAGNOSTIC` | échange de test sans effet métier — **seul type appliqué en 2B** | — |
| `CONTRACT`, `INVOICE`, `PAYMENT`, `CONTRACT_DOCUMENT` | contrats & facturation | D2 |
| `DEV_COMPANY`, `TEAM_MEMBER` | société développeur, équipe | C1 |
| `EMAIL_TEMPLATE` | templates e-mails | C3 |
| `INTEGRATED_API_CONFIG`, `INTEGRATED_API_MODE` | IntegratedAPI (configs communes, mode par projet) | C4 |
| `EVENT`, `MEETING` | événements & réunions | D3 |

Règles valables pour tous, sans exception :

1. **Identité UUID** (`entityId`) posée par le côté créateur, stable à vie.
2. **Dernier écrit gagne** au niveau du document entier (`modifiedAt` posé
   par l'émetteur). Pas de fusion par champ, pas d'arbitrage.
3. **Tombstones** pour les suppressions (`deleted: true`, `payload: null`).
4. **Anti-écho** : une écriture ne revient jamais vers son émetteur d'origine.
5. **Idempotence** par `writeId` : toute relivraison est un non-événement.

Et rien au-delà : pas de source of truth, pas de verrous, pas de résolution
de conflits. Le jour où cela ne suffit plus, la décision sera revue
explicitement — pas contournée.

Le **payload** de chaque `entityType` sera spécifié lot par lot en Phase 3
(schéma zod ajouté au miroir de contrat, des deux côtés). Un type dont le lot
n'est pas livré répond `REJECTED` / `BRIDGE_ENTITY_TYPE_UNSUPPORTED` — des
deux côtés du pont.

## 4. Les données locales des projets (catégorie 1) — le négatif

Par construction, le Panel n'a **aucune** entité pour : services,
prestations, tarifs, horaires, réservations, clients finaux, avis, galerie,
thème, entreprise cliente, demandes de contact, comptes locaux, moteurs
(contrats, facturation, duplication, déploiement), bases Mongo des projets.

Si un module futur du Panel semble avoir besoin d'une de ces données, c'est
que la donnée était mal classée : la faire passer en catégorie 2 est une
décision d'architecture explicite (nouveau lot), jamais un raccourci
technique.

## 5. Relations

```
PanelUser ──(agit sur, via l'API interne)──▶ ProjectRecord
ProjectRecord 1──1 pairing (statut, hashes)
ProjectRecord 1──1 runtime (déclaratif, heartbeats)
ProjectRecord 1──0..1 manifest ──▶ capabilities (interprétées, jamais stockées
                                   sous forme dérivée : recalculées à la lecture)
ProjectRecord 1──n ReceivedWrite (idempotence par projet)
SyncJournalEntry n──0..1 ProjectRecord (originProjectId, anti-écho)
```

Deux choix à remarquer :

- les **capabilities interprétées ne sont jamais stockées** (fonction pure du
  Manifest — pas de cache à invalider) ;
- la **vivacité n'est jamais stockée** (fonction pure du dernier heartbeat et
  de l'horloge).

## 6. Persistance et rétention

| Donnée | Phase 2B | Phase 3 |
|---|---|---|
| Registre, utilisateurs, journal, écritures reçues | RAM (stores à interface stable) | Mongo du Panel (bases TEST/PROD), adaptateurs sans changement d'API |
| Tombstones du journal | conservés sans limite (volume nul) | rétention N jours |
| Historique de heartbeats | dernier seul | historique borné pour la supervision |
| Secrets (hashes de codes, hashes scrypt, hash + copie AES-256-GCM du bridgeToken) | RAM | Mongo — jamais de valeur en clair ; la seule forme réversible est la copie chiffrée du bridgeToken, déchiffrée exclusivement par `ProjectBridgeClient` |
