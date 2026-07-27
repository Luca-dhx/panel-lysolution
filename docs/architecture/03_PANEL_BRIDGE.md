# 03 — Les ponts, côté Panel

> Prérequis : [00_VISION.md](00_VISION.md) §2, [02_PROJECT_REGISTRY.md](02_PROJECT_REGISTRY.md).
> Les contrats officiels : [../spec/PanelBridge.openapi.yaml](../spec/PanelBridge.openapi.yaml)
> et [../spec/ProjectBridge.openapi.yaml](../spec/ProjectBridge.openapi.yaml).

Le Panel se tient aux deux bouts d'une même frontière : il **sert** le contrat
PanelBridge (les projets l'appellent) et il **consomme** le contrat
ProjectBridge (il appelle les projets). Ce document décrit les deux rôles.

---

## 1. Vue d'ensemble

```
        PROJET                                        PANEL
┌───────────────────────┐                 ┌───────────────────────────────┐
│  PanelBridge          │  HTTPS sortant  │  /bridge/v1/*  (serveur)      │
│  (façade sortante) ───┼────────────────▶│  ping · pairings · heartbeats │
│                       │                 │  sync/push · sync/pull        │
│                       │                 │            │                  │
│  /api/project-bridge/ │                 │            ▼ services         │
│  v1/* (surface)   ◀───┼─────────────────┼── ProjectBridgeClient         │
│                       │  HTTPS entrant  │   (driver unique sortant)     │
└───────────────────────┘                 └───────────────────────────────┘
```

Un seul secret d'appairage — le **bridgeToken** — authentifie les deux sens.
Le révoquer ferme tout, d'un coup.

## 2. Le serveur `/bridge/v1` (contrat PanelBridge, v1.0.0)

### 2.1 Chaîne de gardes

Dans l'ordre, sur tout le routeur :

1. **Version de contrat** (`bridgeContractVersion.middleware.js`) : l'en-tête
   `X-Bridge-Contract-Version` est obligatoire sur toutes les routes, ping
   compris. Le middleware pose l'en-tête de réponse (version du Panel) avant
   toute validation, puis vérifie la compatibilité : **même majeure exigée** ;
   absence d'en-tête = incompatible. Refus → `409
   BRIDGE_CONTRACT_VERSION_UNSUPPORTED`. (Comportement identique au
   ProjectBridge du projet modèle — les deux bouts se refusent de la même
   façon.)
2. **Routes publiques** : `GET /ping` (découverte) et `POST /pairings`
   (bootstrap, authentifié par le code d'appairage lui-même).
3. **bridgeToken** (`bridgeAuth.middleware.js`) pour tout le reste : Bearer →
   SHA-256 → fiche projet du registre, comparaison en temps constant. Token
   inconnu ou révoqué → `401 BRIDGE_UNAUTHORIZED`.

### 2.2 Comportement par endpoint

| Endpoint | Comportement Panel |
|---|---|
| `GET /ping` | `{status:'ok', service:'panel-bridge-api', time}` — ne divulgue rien (ni le nombre de projets, ni les versions du parc) |
| `POST /pairings` | bootstrap — voir [05_PAIRING.md](05_PAIRING.md) |
| `DELETE /pairings/current` | révoque le token du projet appelant, `pairing.status → REVOKED`, répond `{unpaired:true}` ; l'ancien token répond ensuite 401 |
| `POST /heartbeats` | enregistre `runtime` (version, ENV, santé, bridgeStats) + horodate `lastHeartbeatAt` ; répond `{acknowledged:true, panelTime}` |
| `POST /sync/push` | accusé **par écriture** via le noyau de synchronisation (§4) — jamais d'échec global silencieux |
| `GET /sync/pull` | page ordonnée des écritures émises côté Panel, curseur opaque, **anti-écho** (exclut les écritures dont le projet appelant est l'émetteur d'origine) |

### 2.3 Le miroir exécutable

`backend/src/bridge/bridgeContract.js` est le miroir code des deux specs :
version (`CONTRACT_VERSION = '1.0.0'`), en-tête, routes, catalogues d'erreurs
`BRIDGE_*`, `entityTypes`, statuts d'accusé, schémas zod `.strict()` de chaque
DTO. Toute requête entrante est validée par ce miroir ; toute réponse sortante
est construite par lui. `tests/bridge-conformity.test.js` vérifie que miroir
et specs YAML racontent la même chose — le contrat ne peut pas dériver
silencieusement.

## 3. Le client `ProjectBridgeClient` (contrat ProjectBridge)

`backend/src/bridge/ProjectBridgeClient.js` est le **seul fichier du Panel
qui parle réseau à un projet** — le symétrique exact du `PanelClient.js` du
projet modèle.

- Une méthode par opération du contrat : `ping`, `getIdentity`, `getHealth`,
  `deliverChanges`, `readLocalChanges`, `listOperations`, `invokeOperation`,
  `notifyUnpair`.
- Chaque appel : en-tête de version de contrat + Bearer bridgeToken, timeout
  10 s (AbortController), déballage de l'enveloppe `{success, data}`, erreurs
  mappées vers `BridgeError` (dont `PANEL_LOCAL_ERROR` `PROJECT_UNREACHABLE`
  quand le projet ne répond pas — un projet injoignable n'est **pas** une
  exception qui remonte à l'utilisateur, c'est un état restitué).
- Jamais dans le chemin critique : les écrans du frontend lisent d'abord le
  registre (heartbeats reçus) ; l'interrogation directe d'un projet est une
  action explicite de supervision.

En Phase 2B, ce client sert au ping/identité/santé à la demande. La livraison
temps réel (`deliverChanges`) et le catalogue d'opérations attendront la
Phase 3 — les méthodes existent, conformes au contrat, mais rien ne les
appelle en tâche de fond.

## 4. Le noyau de synchronisation (`syncCore.service.js`)

Le Panel applique les cinq règles minimales de l'écosystème — et rien au-delà :

| Règle | Implémentation Panel |
|---|---|
| **Idempotence** | `writeId` déjà vu (par projet) → ack `DUPLICATE`, sans effet |
| **Dernier écrit gagne** | `modifiedAt` de l'écriture entrante ≤ état connu → ack `IGNORED` |
| **Tombstones** | `deleted:true` + `payload:null` = suppression, conservée comme les autres écritures |
| **Anti-écho** | le pull exclut les écritures dont le projet appelant est l'émetteur d'origine |
| **Identités UUID** | `entityId` généré par le côté créateur, jamais réattribué |

En Phase 2B, seul le type `DIAGNOSTIC` est appliqué (échange de test sans
effet métier). Tout autre `entityType` — réservé aux lots de la Phase 3 —
reçoit un ack `REJECTED` avec le code `BRIDGE_ENTITY_TYPE_UNSUPPORTED` :
propre, jamais un 500. Le journal des écritures émises côté Panel existe (il
alimente `sync/pull`) mais reste vide tant qu'aucun domaine n'est synchronisé.

## 5. Ce que les ponts s'interdisent côté Panel

1. ❌ Un appel sortant vers un projet hors de `ProjectBridgeClient`.
2. ❌ Une réponse `/bridge/v1` non validée par le miroir `bridgeContract.js`.
3. ❌ Un secret (token, code) dans un log ou une réponse d'API.
4. ❌ Trancher un conflit autrement que par « dernier écrit gagne » — pas de
   source of truth, pas de verrou, pas d'arbitrage.
5. ❌ Bloquer une requête du frontend sur un appel réseau vers un projet sans
   timeout court et sans état de repli.
