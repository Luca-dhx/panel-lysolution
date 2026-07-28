# 36 — Supervision : le Panel comme NOC de l'écosystème

> **Référence officielle.** Phase 3A — première couche métier du Panel.
> Code : `backend/src/services/supervision/`, `routes/supervision.routes.js`.

---

## 1. La règle de la phase

> **La supervision est STRICTEMENT en lecture seule.**
> Le Panel observe. Il ne déploie pas, ne synchronise pas, ne migre pas, ne
> modifie aucune configuration, n'écrit dans aucun projet.

Cette contrainte n'est pas une limitation temporaire : c'est ce qui rend la
supervision **sûre à activer sur un parc de production**. Un outil qui ne
peut rien casser peut être branché partout, tout de suite.

Trois invariants la garantissent, tous **vérifiés par les tests** :

1. le routeur `/api/supervision` ne déclare **que des GET** ;
2. aucun module de supervision n'importe `ProjectBridgeClient` ;
3. aucun module de supervision n'appelle `fetch`.

## 2. Passif, pas actif

Le Panel ne **sonde** jamais un projet. Il attend que le projet parle.

| Approche | Ce que ça implique | Choix |
|---|---|---|
| **Actif** (le Panel interroge) | le Panel doit joindre chaque projet, gérer N timeouts, et devient un point de charge | ❌ |
| **Passif** (le projet publie) | le projet garde l'initiative ; un silence est une information ; le coût est constant quel que soit le parc | ✅ |

Conséquence directe : **un projet injoignable n'est pas une erreur du Panel**,
c'est une observation. Et un parc de 300 projets ne coûte pas plus cher à
superviser qu'un parc de 3.

## 3. Ce que le Panel sait, et d'où il le tient

| Information | Source | Jamais |
|---|---|---|
| Identité, type, description, layout | `ProjectManifest.descriptor` | ressaisi dans le Panel |
| Domaine, URLs | `ProjectManifest.network` | deviné depuis une convention |
| Versions applicative et de contrat | bootstrap + heartbeats | supposé |
| Versions des moteurs | `Heartbeat.engines` / `ProjectManifest.engines` | lu dans le code du projet |
| Modules et fonctionnalités | `ProjectManifest.modules` / `.features` | inféré d'un comportement |
| Santé des composants | `Heartbeat.runtime.components` | sondé par le Panel |
| Uptime, charge | `Heartbeat.runtime` | mesuré à distance |
| Vivacité | calculée sur l'horloge du Panel | stockée |

**Ce qu'un projet ne publie pas vaut `UNKNOWN`** — jamais `OK` (un silence
n'est pas une bonne nouvelle), jamais `ERROR` (un silence n'est pas une
panne). C'est la différence entre un tableau de bord honnête et un tableau
de bord rassurant.

## 4. Le contrat 1.2.0

La supervision a exigé une extension du contrat de pont, **additive** et
ratifiée dans le projet de référence avant d'être portée
([32_ENGINE_RELEASE_PROCESS.md](32_ENGINE_RELEASE_PROCESS.md)) :

| Ajout | Où | Optionnel |
|---|---|---|
| `runtime.uptimeSeconds`, `runtime.startedAt` | `Heartbeat` | ✅ |
| `runtime.load` (cpu, mémoire) | `Heartbeat` | ✅ |
| `runtime.components` (états OK/WARNING/ERROR/UNKNOWN) | `Heartbeat` | ✅ |
| `engines` (versions des moteurs) | `Heartbeat` et `ProjectManifest` | ✅ |
| `network` (domaine, URLs) | `ProjectManifest` | ✅ |
| `descriptor` (type, description, layout) | `ProjectManifest` | ✅ |

**Tous optionnels** : un projet parlant encore 1.0.x ou 1.1.x reste
pleinement conforme. Il apparaît simplement avec davantage d'`UNKNOWN`. La
supervision ne pénalise jamais un projet ancien.

## 5. Architecture

```text
backend/src/services/supervision/
├── liveness.service.js   ONLINE / STALE / OFFLINE — fonction pure, seuils configurables
├── health.service.js     santé par composant + statut global + alertes
├── heartbeat.service.js  archivage passif, historique borné, statistiques
├── timeline.service.js   événements reçus et constats de changement
└── fleet.service.js      agrégation du parc, tableau de bord, recherche
```

Chaque service a une responsabilité unique et **aucun ne dépend du réseau**.
Le contrôleur n'orchestre que des lectures.

## 6. Divulgation progressive

L'interface — et l'API — sont organisées en **quatre niveaux**. C'est ce qui
garde le Panel utilisable à 300 projets.

| Niveau | Écran | Route API | Contenu | Coût |
|---|---|---|---|---|
| **0** | Supervision | `GET /dashboard` | quelques nombres, alertes bornées, ce qui demande attention (≤ 10) | constant |
| **1** | Parc | `GET /fleet` | une ligne par projet : identité, état, versions | linéaire, filtrable |
| **2** | Fiche projet | `GET /projects/:id` | général, réseau, versions, santé par composant, capacités | un projet |
| **3** | Blocs dépliés | `/technical`, `/heartbeats`, `/events` | manifeste brut, historique, chronologie complète | **chargé seulement si on déplie** |

Règles de conception appliquées :

- le tableau de bord ne renvoie **aucune liste complète** du parc (vérifié
  par test) ;
- une ligne de parc est volontairement **pauvre** : pas de manifeste, pas de
  composants, pas d'historique ;
- les blocs de niveau 3 sont **repliés par défaut** et leur contenu n'est
  requêté qu'à la **première ouverture** ;
- le tri place d'office en tête ce qui va mal (`issues`), parce qu'un
  opérateur ouvre le Panel pour ça.

## 7. Ce que la supervision ne fera jamais

1. ❌ Déclencher un déploiement, un rollback ou une duplication.
2. ❌ Écrire dans la base ou la configuration d'un projet.
3. ❌ Interroger un projet pour « rafraîchir » son état.
4. ❌ Inventer une donnée absente (un `UNKNOWN` reste un `UNKNOWN`).
5. ❌ Pénaliser un projet parlant un contrat plus ancien.
6. ❌ Exposer un secret : la projection publique ne contient ni hash ni
   valeur chiffrée (vérifié par test).

L'administration distante est un chantier ultérieur, avec ses propres
garanties. Elle ne se glissera pas dans la supervision par petites touches.

## 8. Documents liés

| Document | Sujet |
|---|---|
| [34_PROJECT_REGISTRY.md](34_PROJECT_REGISTRY.md) | le registre : champs, sources, autorité |
| [35_HEARTBEATS.md](35_HEARTBEATS.md) | signal passif, seuils, historique |
| [37_PROJECT_HEALTH.md](37_PROJECT_HEALTH.md) | modèle de santé et calcul du statut global |
| [38_DASHBOARD.md](38_DASHBOARD.md) | tableau de bord, alertes, recherche |
