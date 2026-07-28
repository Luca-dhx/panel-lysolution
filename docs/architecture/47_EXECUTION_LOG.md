# 47 — Journal d'exécution et audit

> **Référence officielle.** Phase 3C.
> Code : `execution-log.service.js`, `models/PanelExecution.model.js`.

---

## 1. Ce que le journal doit permettre

Le journal n'est pas un confort de débogage. C'est la **pièce d'audit** : il
doit permettre de répondre, des mois plus tard, à

> qui a fait quoi, quand, pourquoi, et avec quel résultat ?

Une exécution dont le journal est incomplet est une exécution non auditable
— donc un défaut, détecté par test.

## 2. Neuf phases

`CREATION` · `VALIDATION` · `CONFIRMATION` · `QUEUE` · `START` · `STEP` ·
`RESULT` · `COMPENSATION` · `END`

`auditLog()` vérifie qu'un journal raconte une histoire complète :

- création et validation toujours présentes ;
- un démarrage journalisé implique une fin journalisée ;
- tout état arrêté se termine par `END` ;
- ordre chronologique strict ;
- aucune entrée incomplète, aucune phase inconnue.

Cette fonction sert aux tests **et** à l'écran d'audit : un journal incomplet
signale un chemin de code qui a oublié de se déclarer.

## 3. Masquage des secrets

Aucun secret ne doit atterrir dans un journal qu'on relira dans six mois.
Toute donnée jointe passe par un masquage systématique, sur deux critères :

**Par le nom de la clé** — plus sûr que de reconnaître un secret à sa forme :

```text
secret · password · token · key · credential · passphrase
mongodb_uri · authorization
```

**Par la forme de la valeur** — pour ce qui se cache sous une clé anodine :

- URI Mongo contenant des identifiants ;
- JWT (`eyJ….….…`) ;
- en-têtes `Bearer …` ;
- chaînes hexadécimales longues (clés, empreintes).

Le masquage est **récursif** (objets, tableaux, 8 niveaux) et remplace par
`«redacted»`. Ce qui n'est pas secret reste lisible : un journal illisible
n'aurait aucune valeur d'audit.

Conséquence pratique : **le journal peut être exporté tel quel.**

## 4. Le document d'exécution

Le journal est embarqué dans le document plutôt que dans une collection
séparée : une entrée n'a aucun sens hors de son exécution, et on veut
pouvoir tout lire d'un coup.

| Champ | Rôle |
|---|---|
| `executionId` | identifiant stable |
| `type`, `projectId`, `environment` | quoi, sur quoi, où |
| `mode` | `SIMULATION` (défaut) ou `EXECUTION` |
| `parameters` | ce qui a été demandé |
| `initiator` | **qui** — sans lui, pas d'audit |
| `state` + `stateHistory[]` | l'état et **tout** son parcours, avec raisons |
| `validation` | contrôles, refus, résumé |
| `confirmations[]` | décisions, auteurs, commentaires |
| `createdAt` / `startedAt` / `finishedAt` / `durationMs` | chronologie |
| `result` / `error` | dénouement |
| `log[]` | le journal masqué |
| `correlationId`, `parentExecutionId` | campagnes, compensations |
| `timeoutMs`, `cancellationRequested` | pilotage du cycle |

## 5. Le journal ne s'écrit pas seul

`createLog()` est volontairement **passif** : il accumule en mémoire et
n'écrit jamais en base. C'est le service d'exécution qui décide quand
persister.

Conséquence : une entrée de journal ne peut pas exister sans que l'exécution
correspondante soit écrite elle aussi. Pas de trace orpheline, pas
d'exécution muette.

## 6. L'historique d'états

Distinct du journal, et complémentaire. Chaque transition y enregistre son
horodatage, l'état source, l'état cible, et la **raison déclarée dans la
table de transitions** (`45 §2`).

C'est ce qui permet de relire une exécution comme un récit :

```text
        → CREATED               Exécution créée.
CREATED → WAITING_CONFIRMATION  La politique de l'action exige une confirmation explicite.
WAITING… → QUEUED               Confirmation obtenue.
QUEUED  → RUNNING               Prise en charge par l'exécuteur.
RUNNING → FAILED                Exécution terminée en erreur.
```

## 7. Ce qui n'est pas encore fait

- **Pas de purge ni de rétention.** L'historique croît indéfiniment. Une
  politique de conservation devra être décidée — c'est une question de
  gouvernance, pas de code.
- **Pas d'export.** `renderLog()` produit un rendu texte lisible, mais
  aucune route ne l'expose encore.
- **Pas de corrélation exploitée.** `correlationId` et `parentExecutionId`
  sont posés et persistés ; rien ne les regroupe encore à l'écran.
