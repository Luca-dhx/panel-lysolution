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
├── fleet.service.js      agrégation du parc, tableau de bord, recherche
├── bridgeConsumption.service.js  ce qu'un projet CONSOMME : retard, âge, seuils
└── bridgeAlerting.service.js     ouverture, refroidissement, rétablissement
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

## 6 bis. Le QUATRIÈME fait : ce qu'un projet CONSOMME

### L'angle mort

Trois faits étaient déjà séparés, et les trois décrivent la **montée** :

```text
lastHeartbeatAt      « cette instance répond-elle ? »
lastBusinessSyncAt   « quand ai-je reçu son état métier ? »
businessSync         « ses écritures PASSENT-elles ? »
```

Aucun ne décrit la **descente**. Un projet du parc a tourné 91 cycles
consécutifs avec `applied: 0`, `lastError: null` et un état interne `DEGRADED`
que rien ne lisait : son tirage était mort depuis la deuxième écriture du
journal. Les trois indicateurs étaient au vert pendant que plus rien
n'arrivait. Un tableau de bord honnête ne pouvait pas rester comme ça.

### Le signal juste : l'ÂGE DU RETARD

« Le curseur n'avance plus » est le premier réflexe, et il est **faux** : c'est
l'état NORMAL et majoritaire d'un projet à jour dont rien n'a changé. Alerter
là-dessus produirait un signal permanent que tout le monde apprendrait à
ignorer — c'est-à-dire pire que pas d'alerte.

Le Panel sait deux choses que le projet ignore :

```text
ce qu'il a ÉMIS pour ce projet     son journal, filtré par audience
ce que le projet a CONSOMMÉ        son curseur, déclaré au battement
```

La différence est un RETARD, et ce retard a un ÂGE — la date de la plus
ancienne écriture non consommée. Quelques secondes : fonctionnement normal.
Une heure sur une écriture republiée dix fois : une panne.

Le calcul du retard **rejoue exactement le filtre du tirage** (audience,
anti-écho, curseur). Un filtre approximatif compterait comme retard des
écritures que le projet ne recevra jamais, et le tableau de bord signalerait
en permanence une panne qui n'existe pas.

### Les seuils, et leur justification

| Seuil | Valeur | Pourquoi celle-là |
|---|---|---|
| échecs de tirage consécutifs | 3 | le tirage tourne toutes les 2 min : ~6 min absorbent un redémarrage ou une release, pas une panne |
| écritures illisibles consécutives | 2 | chacune est une PERTE DÉFINITIVE — le curseur avance, le Panel ne relivre pas |
| âge du retard | 30 min | ~15 cycles manqués ; en dessous, on décrirait comme une panne un projet éteint le temps d'une release |

`UNKNOWN` n'est **jamais** `HEALTHY` : un projet antérieur à 1.10.0 ne déclare
rien, et déduire sa santé de ce silence serait exactement l'erreur que ce lot
répare. La règle du §3 s'applique telle quelle.

### L'alerte — une fois, puis silence

`bridgeAlerting.service.js`, déclenché **au battement** — le seul instant où le
Panel apprend quelque chose de neuf. L'évaluer à l'ouverture d'un écran
enverrait un message parce que quelqu'un a regardé.

```text
ouverture        événement PROJECT_BRIDGE_DEGRADED, UNE fois, + état mémorisé
notification     e-mail aux SUPER_ADMIN, via le système de modèles du Panel
refroidissement  6 h — 4 rappels par jour au pire, jamais 1 440
rétablissement   PROJECT_BRIDGE_RECOVERED + e-mail, SI une alerte est partie
```

L'état vit sur la fiche projet (`runtime.bridgeAlert`) et non en mémoire : sans
cela, chaque redémarrage du Panel rouvrirait toutes les alertes du parc et
réexpédierait tout — c'est-à-dire la panne d'alerting que ce module existe pour
éviter.

L'identité d'un envoi est dérivée de l'instant d'**ouverture**, jamais d'une
horloge courante : un rejeu après incident retombe sur la même clé et
n'expédie rien.

Un rétablissement n'est annoncé que si une alerte a réellement été **expédiée**.
Une dégradation ouverte, puis résolue avant le premier envoi, n'a atteint
personne : annoncer sa réparation apprendrait une panne au moment exact où elle
n'existe plus.

Ce module **ne fait jamais échouer un battement** : un projet qui bat
correctement ne doit pas être déclaré hors ligne parce qu'un fournisseur
d'e-mails était à terre. Toute erreur d'évaluation est avalée et journalisée.

### Pourquoi ceci n'est pas de l'administration distante

La supervision reste **passive au sens du §2** : elle n'interroge aucun projet,
n'écrit dans aucun projet, ne déclenche aucune action à distance. Elle
**décrit** un fait qu'elle a reçu, et prévient un humain. La seule sortie est
un e-mail vers les administrateurs du Panel — jamais vers un projet, jamais
vers un client.

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
| [03_PANEL_BRIDGE.md](03_PANEL_BRIDGE.md) | le pont : audiences, curseur, `bridgeStats.consumption` |
| [63_CLIENT_COMPANY.md](63_CLIENT_COMPANY.md) | l'entreprise cliente, publiée par le pont vers un projet |
