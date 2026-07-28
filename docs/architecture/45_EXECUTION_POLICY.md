# 45 — États et politiques d'exécution

> **Référence officielle.** Phase 3C.
> Code : `execution-state.service.js`, `execution-policy.service.js`.

---

## 1. Les neuf états

| État | Signification |
|---|---|
| `CREATED` | demandée, pas encore validée |
| `WAITING_CONFIRMATION` | validée, attend une décision humaine |
| `QUEUED` | autorisée, en file |
| `RUNNING` | prise en charge par l'exécuteur |
| `SUCCEEDED` | terminée avec succès |
| `FAILED` | terminée en erreur |
| `CANCELLED` | abandonnée avant d'agir |
| `ROLLED_BACK` | compensée après échec |
| `TIMEOUT` | délai maximal dépassé |

Trois catégories transverses :

- **terminaux** — plus aucune transition n'en part : `SUCCEEDED`,
  `CANCELLED`, `ROLLED_BACK` ;
- **arrêtés** (*settled*) — l'exécution ne progressera plus d'elle-même ; y
  ajoute `FAILED` et `TIMEOUT`, dont la compensation reste possible mais
  **décidée**, jamais automatique ;
- **actifs** — occupent un verrou d'exclusivité : `WAITING_CONFIRMATION`,
  `QUEUED`, `RUNNING`.

## 2. La table des transitions

Chaque arête du graphe porte une **raison déclarée**. Ce n'est pas
décoratif : la raison apparaît dans l'historique d'états et dans le journal
d'audit, et elle oblige à justifier l'arête au moment où on l'ajoute.

```text
CREATED ──▶ WAITING_CONFIRMATION ──▶ QUEUED ──▶ RUNNING ──▶ SUCCEEDED
   │                 │                 │           │    └──▶ FAILED ──▶ ROLLED_BACK
   │                 │                 │           └──▶ TIMEOUT ──▶ ROLLED_BACK
   ├──▶ QUEUED       ├──▶ CANCELLED    ├──▶ CANCELLED
   ├──▶ CANCELLED    └──▶ TIMEOUT      └──▶ FAILED
   └──▶ FAILED
```

Deux absences volontaires :

- **`CREATED → RUNNING` n'existe pas.** On ne saute pas la file, même quand
  aucune confirmation n'est requise : le chemin est plus court, jamais
  différent.
- **`RUNNING → CANCELLED` n'existe pas.** Voir `44 §7`.

## 3. Refuser en expliquant

Un refus de transition ne dit jamais « transition invalide » :

```text
Transition FAILED → CANCELLED non déclarée.
Depuis FAILED, seuls ROLLED_BACK sont atteignables.
```

Le refus nomme l'état courant, l'état visé, et **les transitions qui
seraient possibles**. Un état terminal produit un message distinct, parce
que la cause l'est aussi.

## 4. Intégrité du graphe

`validateGraph()` vérifie qu'aucun état n'est inconnu, dupliqué, sans issue,
ou inatteignable depuis `CREATED`. Un graphe mal formé est un **défaut**,
détecté par les tests — pas une surprise de production.

---

## 5. Les politiques

Le moteur de politiques est le **gardien**. Il ne connaît aucune action en
particulier : il lit le descripteur et applique.

Huit contrôles, dans l'ordre :

| # | Contrôle | Refus si |
|---|---|---|
| 1 | Action connue | absente du registre |
| 2 | Projet cible | action `PROJECT` sans projet |
| 3 | Environnement | hors `allowedEnvironments`, **ou inconnu** |
| 4 | Prérequis | un `check(ctx)` renvoie `ok: false` |
| 5 | Préparation | score 3B < `requiredReadiness` |
| 6 | Compatibilité | incompatibilité bloquante (3B) |
| 7 | Diagnostics | une règle de `blockOnDiagnostics` est active |
| 8 | Exclusivité | une autre exécution occupe la cible |

Le contrôle 3 mérite un mot : un environnement **inconnu** est un refus, pas
une autorisation par défaut. On ne suppose pas qu'un projet est en TEST.

## 6. La règle d'explication

> Jamais « Action refusée. »
> Toujours « Action refusée parce que… », avec le fait constaté.

C'est la même exigence qu'en Phase 3B, appliquée au pilotage. Chaque refus
porte :

- un **code stable** (`EXEC_READINESS_TOO_LOW`, `EXEC_ENVIRONMENT_FORBIDDEN`…)
  réutilisable par l'interface et les tests ;
- un **message** qui nomme la cause ;
- les **valeurs observées** dans `facts`.

Exemples produits par le moteur, tels quels :

```text
Action refusée parce que la préparation du projet est de 42 %,
en dessous du minimum de 70 % exigé par cette action.

Action refusée parce qu'elle n'est autorisée qu'en TEST,
et que ce projet est en PROD.

Action refusée parce qu'une autre exécution est déjà en cours sur cette
cible : « DEPLOY » (RUNNING, démarrée le 2026-08-01T12:00:00.000Z).
```

Un test vérifie que **tout** message de refus contient « refusée parce qu ».

## 7. Toutes les causes, pas la première

Le résumé énonce **l'ensemble** des refus, pas seulement le premier. Un
opérateur qui corrige un point ne doit pas découvrir le suivant après coup.
La liste complète des contrôles — y compris ceux qui passent — reste
consultable, pour comprendre *pourquoi* ça passe autant que pourquoi ça
bloque.

## 8. Codes de refus

| Code | Cause |
|---|---|
| `EXEC_UNKNOWN_ACTION` | action absente du registre |
| `EXEC_PARAMETERS_INVALID` | paramètres manquants, mal typés ou inconnus |
| `EXEC_ENVIRONMENT_FORBIDDEN` | environnement non autorisé ou inconnu |
| `EXEC_PREREQUISITE_UNMET` | prérequis déclaré non satisfait |
| `EXEC_READINESS_TOO_LOW` | préparation insuffisante |
| `EXEC_BLOCKING_DIAGNOSTIC` | un diagnostic 3B interdit l'action |
| `EXEC_COMPATIBILITY_BLOCKING` | incompatibilité bloquante |
| `EXEC_EXCLUSIVITY_CONFLICT` | verrou occupé |
| `EXEC_PROJECT_UNKNOWN` | aucun projet cible |

Ces codes sont **stables** : ils entrent dans le contrat avec l'interface.
