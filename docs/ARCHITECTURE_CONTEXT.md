# Contexte d'architecture — Panel

> Le document d'entrée. Il décrit le système **tel qu'il est implémenté
> aujourd'hui**, pas l'architecture visée à l'origine. Chaque affirmation
> renvoie au code qui la porte.
>
> Les documents numérotés (`00_` à `61_`) restent la référence détaillée de
> chaque sujet. Celui-ci répond vite aux questions qu'on se pose en arrivant.

---

## 1. Les cinq mots qu'il ne faut pas confondre

C'est la source de la plupart des malentendus. Ils désignent cinq choses
différentes, et aucun n'est synonyme d'un autre.

| Mot | Ce que c'est | Combien |
|---|---|---|
| **Environnement** | `TEST` ou `PROD`. Une dimension fonctionnelle. | 2 |
| **Instance de Panel** | Une installation déployée du Panel : un domaine, un backend, une base, un `ENV`. | 1 par environnement |
| **Projet logiciel** | Le projet côté SB Auto / Manager. Il possède N **destinations** de déploiement. | notion du Manager, **pas du Panel** |
| **Fiche Panel** (`PanelProject`) | **Une instance appairée observée.** « SB Auto 06, TEST, demo-sbauto06.ly-solution.com ». | 1 par instance |
| **Destination** | L'endroit où une instance est publiée : `demo-sbauto06.ly-solution.com`. | 1 ACTIVE + N historiques |

### La doctrine, en une phrase

> **Côté SB Auto / Manager :** un projet logiciel peut posséder N destinations
> de déploiement (TEST, PROD, et d'autres plus tard). C'est interne au projet.
>
> **Côté Panel :** une fiche représente **exactement une** instance appairée.
> Une fiche appairée possède exactement **un** environnement déclaré et **une**
> destination courante. Le Panel ne regroupe **jamais** TEST et PROD dans une
> même fiche.

```
MANAGER / SB AUTO                    PANEL (instance TEST)

Projet SB Auto                       ┌── PanelProject
├── destination TEST  ───────────────┤   projectId · TEST
├── destination PROD                 │   1 appairage · 1 destination
└── … d'autres                       │   1 état métier
                                     └── … et rien d'autre sur cette fiche
UN projet, N destinations.
                                     UNE fiche, UNE instance.
```

**Cardinalité, côté Panel :**

```
1 fiche Panel = 1 appairage = 1 projet distant observé
              = 1 environnement = 1 destination = 1 état métier
```

Il n'y a **pas**, dans une fiche : une destination TEST *et* une destination
PROD ; un sélecteur TEST/PROD ; deux connexions ; deux appairages ; une notion
de « sœur » à sélectionner ; une destination à « ajouter ».

Pour connecter la recette **et** la production d'un même logiciel : ce sont
simplement **deux fiches indépendantes**, dans deux instances de Panel.

### Avant appairage : rien n'est connu, et le Panel le dit

| | Avant appairage | Après appairage |
|---|---|---|
| Environnement | `null` — **« non connu »** | déclaré par le projet (`runtime.environment`) |
| Destination | `null` — **« non connue »** | annoncée par le projet (destination ACTIVE) |
| `networkSource` | `NON_APPAIRE` | `DESTINATION_ACTIVE` |

Aucune déduction : ni depuis le nom, ni depuis le domaine, ni depuis
l'intention saisie à la déclaration, ni depuis un manifeste de secours. Une
intention n'est pas un constat.

→ `backend/src/services/registry/projectRegistry.service.js`
(`declaredEnvironmentOf`, `describeProject`) ·
`tests/project-connections.test.js` (`UNPAIRED_PROJECT_HAS_NO_ENVIRONMENT`,
`UNPAIRED_PROJECT_HAS_NO_DESTINATION`,
`PAIRED_PROJECT_SHOWS_DECLARED_ENVIRONMENT`)

### Ce que `projectKey` et `logicalProjectKey` ne pilotent plus

| Clé | Ce qu'elle établit encore | Ce qu'elle ne fait **plus jamais** |
|---|---|---|
| `projectId` | l'**autorité absolue du périmètre métier**. Toute projection, toute lecture, tout état est indexé par lui. | regrouper. |
| `projectKey` | **anti-collision technique** : une fiche, une clé, un index unique. Réconciliée à l'appairage sur la valeur que le projet annonce. | déterminer un périmètre métier, un environnement, une destination, ou construire un écran. |
| `logicalProjectKey` | **rien.** Champ conservé, nullable, sur les fiches historiques — aucune écriture neuve, aucune lecture. | regrouper, naviguer, résoudre une donnée, apparaître dans l'API ou dans l'UI. |

**Pourquoi le regroupement a été supprimé, et non simplement masqué :** une
instance de Panel ne sert qu'un environnement (§2). Une carte « recette +
production » ne pouvait donc **jamais** porter deux fiches vivantes : la
seconde était toujours une fiche jamais appairée, présentée comme un constat,
avec un bouton « Appairer la production » qui menait à une impasse.

→ `tests/project-connections.test.js` (`ONE_ROW_EQUALS_ONE_PANEL_PROJECT`,
`NO_TEST_PROD_GROUPING`, `NO_PROJECT_KEY_IN_PAIRINGS_UI`,
`ONE_PANEL_SERVES_ONE_ENVIRONMENT`) ·
`tests/project-company-live-e2e.test.js` (`PROJECT_ID_IS_BUSINESS_DATA_AUTHORITY`)

```
         SB AUTO TEST                  SB AUTO PROD
         ENV = TEST                    ENV = PROD
         1 fiche Panel                 1 fiche Panel
                │                             │
            pairing A                     pairing B
            jeton A                       jeton B
                │                             │
                ▼                             ▼
          PANEL TEST                     PANEL PROD
          panel-test.…                   panel.…
          ENV = TEST                     ENV = PROD

     Deux fiches, dans DEUX Panels. Elles ne se croisent jamais.
```

Et sous une instance de projet :

```
SB AUTO TEST
 ├─ destination ACTIVE   demo-sbauto06.ly-solution.com   (canonique)
 └─ destination RETIRED  demo-sbauto.lycarz.com          (encore sur le serveur)
```

**Il n'y a jamais un seul jeton pour deux environnements.** Le jeton de pont
authentifie une INSTANCE ; deux instances, deux appairages, deux jetons.

---

## 2. Comment un projet choisit son Panel

**Par l'URL** qu'il appelle. C'est le mécanisme, et il est correct : deux
instances déployées, deux domaines, deux bases.

```
projet TEST  →  panelUrl = https://panel-test.exemple.com
projet PROD  →  panelUrl = https://panel.exemple.com
```

**Mais le domaine ne prouve pas l'environnement.** Une URL est une chaîne
saisie dans un `.env` : elle dit quelle machine répond, jamais à quel monde
elle appartient. Une adresse recopiée d'un projet à l'autre, une variable
oubliée lors d'une promotion, et la production d'un client s'appaire au Panel
de recette — sans qu'aucune erreur ne se produise.

Le protocole vérifie donc **en plus** :

```
PROJET déclare       environment = TEST
PANEL sert           config.env  = TEST
                     ─────────────────
                     concordance → appairage accepté
```

| Projet | Instance de Panel | Résultat |
|---|---|---|
| TEST | Panel TEST | ✅ appairé |
| PROD | Panel PROD | ✅ appairé |
| TEST | Panel PROD | ❌ `BRIDGE_ENVIRONMENT_MISMATCH` |
| PROD | Panel TEST | ❌ `BRIDGE_ENVIRONMENT_MISMATCH` |

**Fail closed, dans les deux sens.** Aucune correction automatique : rapprocher
TEST de PROD « pour que ça marche » produirait précisément l'accident visé.
Le refus arrive **avant** la consommation du code d'appairage — l'opérateur
corrige son `.env` et rejoue le même code.

**On ne devine jamais l'environnement depuis un nom de domaine.**
`hostname.includes('test')` classerait la production de « Garage Test SARL »
en recette. Les deux côtés le **déclarent**.

→ `backend/src/services/pairing/pairing.service.js` · `tests/panel-instance-environment.test.js`

---

## 3. La page Appairages, et la fiche projet

**Une liste verticale. Un item horizontal pleine largeur par fiche.** Aucun
regroupement, aucune grille de cartes, aucune table native, aucun `<select>`
natif pour filtrer, aucune largeur fixe (responsive vérifié de 320 à 1280 px).

**Avant appairage**, la ligne dit ce qui est réellement connu :

```
Garage du Nord                        ○ Non appairé
Environnement   — non connu —
Destination     — non connue —                       [ Appairer ]
```

**Après appairage**, elle dit ce que le projet déclare :

```
SB Auto 06                            ● Connecté
Environnement   TEST
Destination     demo-sbauto06.ly-solution.com
Dernier contact   il y a 12 secondes
Données métier    08/08/2026 10:00                   [ Gérer ]
```

Le nom affiché est le **nom courant poussé par le projet** (projection
`PROJECT_PRESENTATION`) ; le manifeste n'est qu'un repli, et il est nommé
comme tel (`presentationSource`).

**Les filtres portent sur l'état du lien** — Toutes / Appairées / À appairer /
Problème — jamais sur l'environnement : dans un Panel qui n'en sert qu'un, le
filtre de l'autre rendait toujours une liste vide.

**La fiche projet** suit la même règle : une carte « Connexion » (état,
environnement, destination, dernier contact, données métier), une carte
« Destination » au singulier, et **aucun** bouton qui ajouterait une seconde
destination ou appairerait « la production ».

→ `frontend/src/lib/projectConnections.ts` ·
`frontend/src/components/connections.tsx` ·
`frontend/src/pages/PairingsPage.tsx` ·
`frontend/src/pages/ProjectDetailPage.tsx` ·
`tests/project-connections.test.js` (`PAIRING_PAGE_FULL_WIDTH_LIST`,
`CUSTOM_SEARCH_IS_USED`, `PROJECT_DETAIL_IS_SINGLE_INSTANCE`,
`PROJECT_DETAIL_SHOWS_ONLY_ONE_ENVIRONMENT`,
`PROJECT_DETAIL_SHOWS_ONLY_ONE_DESTINATION`,
`NO_SECOND_DESTINATION_PAIRING_CTA`,
`UNPAIRED_PROJECT_ENVIRONMENT_IS_UNKNOWN`,
`LIVE_BUSINESS_NAME_USES_PROJECTION`, `MANIFEST_ONLY_AS_FALLBACK`)

---

## 4. Le pont : cinq notions, cinq horodatages

Aucune ne s'appelle « synchronisation » tout court.

| Notion | Champ | Qui l'établit | Ce que c'est |
|---|---|---|---|
| **heartbeat** | `runtime.lastHeartbeatAt` | le Panel | le dernier battement **reçu**. Preuve de vie, et rien d'autre. |
| **fraîcheur métier** | `runtime.lastBusinessSyncAt` | le Panel | l'instant où il a **appliqué** une entité métier pour cette instance. **La source canonique.** |
| **modification annoncée** | `presentationModifiedAt` (= `sourceModifiedAt`) | le projet | la date que le projet **pose sur son écriture**. Sa parole ; c'est elle qui arbitre le dernier-écrit-gagne. |
| **synchronisation déclarée** | `runtime.bridgeStats.lastSyncAt` | le projet | ce que le projet **affirme**, transporté par le battement. |
| **âge de la photographie** | `business.freshness.lastSyncAt` | le Panel | `max(receivedAt)` sur les projections **encore stockées**, recalculé à la lecture. Un âge d'affichage, pas une preuve de réception. |
| **runtime.sync** | — | le déploiement | l'étape qui publie les URL réseau canoniques. Sans rapport avec le pont. |

Les confondre a déjà coûté un écran entier : deux libellés presque identiques
pour deux nombres différents, sans moyen de savoir lequel faisait foi.

```
pairing → heartbeat → snapshot → projection → freshness → generation
```

→ `docs/architecture/03_PANEL_BRIDGE.md` · `35_HEARTBEATS.md`

---

## 4bis. L'état métier d'un projet est VIVANT

> **Le Panel est une vue de ce que chaque instance déclare aujourd'hui.**
> Un manifeste est une photographie d'appairage ; une projection est un flux.

### Trois niveaux, et ils ne se remplacent pas

| Niveau | Question | Source |
|---|---|---|
| **Vivacité** | le projet parle-t-il ? | `runtime.lastHeartbeatAt` |
| **État métier** | ai-je sa dernière photographie ? | `PanelProjectPresentation` (poussée) |
| **Écran** | l'onglet ouvert l'a-t-il reçue ? | `useLiveQuery` (sondage silencieux) |

**Un battement frais ne prouve JAMAIS que les données affichées sont**
**fraîches.** « Connecté » décrit la connexion, rien d'autre.

### Le nom affiché venait du manifeste — c'était le défaut

Renommer l'entreprise dans le Manager d'un projet ne touche pas son
manifeste : celui-ci n'est relu que sur action d'un opérateur
(`REFRESH_MANIFEST`, `DISCOVER_PROJECT`). Le projet poussait pourtant sa
nouvelle présentation en moins d'une seconde, le Panel la persistait — et
personne ne la lisait. La fiche affichait l'ancien nom indéfiniment.

C'est le défaut déjà corrigé sur les URLs, un champ plus loin : deux sources
pour une même vérité, dont une seule vivante.

```
Manager du projet : Company.name modifié
   │  post(save) → notifyEntitySaved(COMPANY, ["name"])
   ↓  syncTriggers : "name" ∈ COMPANY_PATHS → scheduleProjection
PROJECT_PRESENTATION → outbox durable → push Bridge
   ↓
Panel : applyIncoming → projecteur → PanelProjectPresentation
   ↓  registryStore attache activePresentation à CHAQUE fiche chargée
describeProject().name   ← la projection, PUIS le manifeste en repli
   ↓  useLiveQuery (sondage silencieux, liste ET fiche)
L'écran ouvert se met à jour sans reload
```

### Le pipeline live, de bout en bout

Aucun geste humain entre le premier et le dernier maillon.

```
SB AUTO                                    PANEL
Company.name = « SB Auto 07 »
company.save()
  └─ post('save')
     └─ notifyEntitySaved('COMPANY', ['name'])
        └─ syncTriggers  (COMPANY_PATHS)
           └─ scheduleProjection            regroupement 500 ms
              └─ outbox durable  (writeId déterministe)
                 └─ flushOutbox ──── HTTP Bridge ───►  applyIncoming
                                                        └─ PROJECTORS
                                                           PROJECT_PRESENTATION
                                                           └─ PanelProjectPresentation
                                                              (indexée par projectId)
                                                           └─ runtime.lastBusinessSyncAt
                                                        GET /api/projects/:projectId
                                                        └─ useLiveQuery (polling silencieux)
                                                           └─ l'écran ouvert change
```

Le nom **et** la date de fraîcheur évoluent seuls. Il n'y a **ni** bouton
« Synchroniser », **ni** bouton « Rafraîchir », **ni** rechargement de page,
**ni** réappairage, **ni** publication manuelle — et l'écran ne se vide jamais
pendant le polling.

→ `tests/project-company-live-e2e.test.js` — deux backends réels, un vrai
`Company.save()`, aucun `applyIncoming` appelé par le test.

### La priorité du nom, et son origine déclarée

| Rang | Source | `presentationSource` |
|---|---|---|
| 1 | projection poussée (`activePresentation.companyName`) | `PROJECTION` |
| 2 | manifeste d'appairage | `MANIFEST` |
| 3 | nom saisi à la déclaration | `REGISTRY` |

`presentationSource` et `presentationModifiedAt` accompagnent le nom : un
écran peut donc dire d'où vient ce qu'il montre, et depuis quand — sans
jamais inventer une fraîcheur. La même règle vaut pour la description
(`descriptorSource`).

**`PROJECTION > MANIFEST > REGISTRY`**, pour tout champ qui dispose d'une
projection. Le manifeste est un **bootstrap**, un **repli** et une
**compatibilité** — jamais une source live : il est figé à l'appairage et
n'est relu que sur action d'un opérateur (`REFRESH_MANIFEST`,
`DISCOVER_PROJECT`). Une projection reçue ne doit **jamais** être écrasée par
un manifeste relu.

Les champs sans projection assument le manifeste comme seule source, et le
disent : `type`, `layout`, `manifestFormat`, la validation de clé, et les
replis derrière `runtime` pour `environment` et `versions.*`. Ils décrivent la
**composition** du logiciel, qui ne change qu'entre deux versions.

### Ce qui est calculé, et ne se persiste jamais

`activeNetwork` et `activePresentation` sont attachés par `registryStore`,
seul point de chargement, et retirés par `save()`. Les laisser filtrer dans
`panelprojects` créerait une copie figée — exactement le défaut corrigé ici.

### Ce que le projet ne possède pas

| Classe | Exemples | Qui écrit |
|---|---|---|
| état du projet | nom, identité, contrat, réseau, version | **le projet** |
| état Panel | notes, métadonnées internes, configuration locale | **le Panel** |
| technique | battement, génération, appairage, horodatages | constaté |

Une écriture Panel sur une fiche ne touche aucune projection, et
réciproquement.

### TEST / PROD et convergence

Chaque instance a SA projection, indexée par `projectId` — la seule autorité
de périmètre. Et si le pont a été coupé pendant que le projet passait de A à B
puis C, la dernière écriture gagne : le Panel converge directement sur **C**,
sans rejouer B — et `lastBusinessSyncAt` date la réception de **C**, ni
l'écriture de B, ni le battement de reconnexion.

**TEST et PROD ne se croisent jamais.** Ils vivent dans deux instances de
Panel distinctes (§2), et n'ont rigoureusement rien en commun :

| Diffèrent toujours | |
|---|---|
| `projectId` | projection de présentation |
| runtime | contrat |
| battement de cœur | `siteStatus` / protection contractuelle |
| destination | fraîcheur métier |
| appairage | `appliedConfiguration` |

**Aucun repli inter-instance n'existe.** Si une fiche n'a pas de destination
active, elle affiche « aucune destination active » — elle n'emprunte jamais
celle d'une autre. Il en va de même pour le nom, le contrat et la protection :
« inconnu » est une réponse, une valeur empruntée n'en est pas une.

→ `backend/src/services/registry/registryStore.js`
→ `tests/project-live-business-sync.test.js`

---

## 4ter. Vivacité et fraîcheur métier — deux questions, jamais une seule

```
● Connecté                    ← « cette instance répond-elle ? »
  Dernier contact il y a 4 s     runtime.lastHeartbeatAt

✓ Données métier reçues       ← « quand le Panel a-t-il reçu son état ? »
  Dernière mise à jour il y a 6 s  runtime.lastBusinessSyncAt
```

### Pourquoi les séparer

Un projet dont l'entreprise ne change pas bat toutes les trente secondes
pendant des jours **sans rien projeter**. Sa fiche est vivante et n'a jamais
rien reçu — les deux à la fois, et c'est un état parfaitement normal. Déduire
la fraîcheur du battement, c'est afficher « à jour » devant une fiche vide.

Le badge **Connecté** reste donc calculé depuis la seule vivacité. Il n'est
jamais un `ET` entre les deux.

### Ce qui l'avance, et ce qui ne l'avance pas

`lastBusinessSyncAt` est écrit **au seul endroit où une entité métier est
appliquée** — `syncCore.applyIncoming`, après le projecteur, avec l'heure du
Panel. Sont métier : `PROJECT_PRESENTATION`, `CONTRACT`, `TEAM_MEMBER`
(`BUSINESS_ENTITY_TYPES`, dérivé de la table des projecteurs).

| N'avance **pas** la fraîcheur | Pourquoi |
|---|---|
| un battement de cœur | il ne transporte aucune donnée métier |
| une lecture de fiche, un `GET`, le polling de l'écran | lire ne fait rien arriver |
| le manifeste, relu ou non | photographie d'appairage, jamais un flux |
| une découverte sans nouvelle donnée | rien n'a été appliqué |
| une écriture `REJECTED` (payload non conforme) | rien n'a été projeté — il n'y a rien à dater |
| un `DIAGNOSTIC` | c'est un journal de sondes, pas un état |
| une écriture destinée à une autre instance | l'écriture est scellée par son `projectId` |

### Pourquoi elle est persistée, et non déduite

On savait la déduire : `max(receivedAt)` sur les projections stockées — c'est
ce que fait encore `freshness.lastSyncAt`. Mais cette déduction ment dans
trois cas : un tombstone efface la projection et fait **reculer** la date ; un
`TEAM_MEMBER` reçu ne compte pas ; une réception qui n'a rien changé n'y laisse
aucune trace. Une observation ne se recalcule pas — on l'inscrit à l'instant
où elle a lieu.

### Annoncée ≠ reçue

```
Projet modifié à      14:31:02   ← presentationModifiedAt (parole du projet)
Reçu par le Panel à   14:31:04   ← lastBusinessSyncAt   (constat du Panel)
```

Les fusionner supprimerait la seule information qui permet de diagnostiquer
une livraison en retard. L'onglet Développeur les affiche côte à côte.

### Ce que l'écran doit dire, cas par cas

| Situation | Vivacité | Données métier |
|---|---|---|
| tout fonctionne | ● Connecté — 3 s | ✓ reçues — 5 s |
| bat, n'a jamais rien projeté | ● Connecté — 2 s | **jamais reçues** (surtout pas « à jour ») |
| bat, données anciennes | ● Connecté — 3 s | ✓ reçues — il y a 27 min *(une date honnête, pas un diagnostic inventé)* |
| hors ligne | ○ Hors ligne — 18 min | ✓ reçues — il y a 19 min *(consultables)* |
| manifeste seul | selon le battement | **jamais reçues** — le nom vient du manifeste (`presentationSource: MANIFEST`) |

Aucun seuil de vieillissement n'est inventé ici : le produit n'en possède pas
de canonique pour la fraîcheur métier, et une date honnête vaut mieux qu'un
faux verdict.

→ `backend/src/services/sync/syncCore.service.js` · `sync/projectors.js`
→ `frontend/src/lib/projectFreshness.ts`
→ `tests/project-live-business-sync.test.js` — `HEARTBEAT_DOES_NOT_ADVANCE_BUSINESS_FRESHNESS`,
  `MANIFEST_DOES_NOT_ADVANCE_BUSINESS_FRESHNESS`, `MANIFEST_NEVER_OVERRIDES_LIVE_PROJECTION`,
  `TEST_INSTANCE_NEVER_READS_PROD_DATA`, `PROD_INSTANCE_NEVER_READS_TEST_DATA`

---

## 5. Génération d'instance — « ces données sont-elles encore de ce monde ? »

La génération d'un projet est un triplet :

```
environnement | identité d'appairage | hôte de la destination active
```

| Changement | Effet |
|---|---|
| même env, même appairage, même hôte | **même instance** — rien ne bouge |
| changement de domaine | nouvelle génération |
| réappairage | nouvelle génération |
| changement d'environnement | nouvelle génération |

Deux valeurs sentinelles, et elles ne sont **pas** synonymes :

- `SANS-DESTINATION` — un **fait** : ce projet n'a aucune destination active ;
- `DESTINATION-INCONNUE` — une **ignorance** : l'appelant ne s'est pas prononcé.

Une ignorance ne périme rien. Comparer les clés entières comme deux chaînes
faisait passer l'ignorance pour un désaccord et déclarait périmé tout le parc.
La comparaison est donc faite case par case.

→ `backend/src/services/sync/projectGeneration.js` · `tests/instance-generation-freshness.test.js`

---

## 6. Destinations : le cycle de vie, et ce que `currentVersion` ne prouve pas

```
ACTIVE ──► DEPROVISIONING ──► EMPTY ──► DELETED
   │             │
   │             └──► DEPROVISION_FAILED ──┐
   │                        ▲              │
   └──► RETIRED ────────────┴──────────────┘
```

| État | Signification |
|---|---|
| `ACTIVE` | destination canonique de cet environnement. Une seule, garantie par index. |
| `DEPROVISIONING` | retrait en cours. |
| `DEPROVISION_FAILED` | retrait échoué, **reprenable**. |
| `RETIRED` | **n'est plus la destination canonique — sa présence physique n'a PAS été déclarée vide.** |
| `EMPTY` | le serveur a été **prouvé** vide par le workflow. |
| `DELETED` | suppression logique ; audit conservé. |

### `RETIRED` ne veut pas dire vidé

Une destination `RETIRED` peut encore avoir son PM2, son port, sa
configuration Nginx, son `siteRoot`, ses fichiers et ses médias. Elle **doit**
pouvoir être inspectée et déprovisionnée ; elle ne **doit pas** être
supprimable directement.

### `currentVersion` n'est pas une preuve d'existence

> `currentVersion` décrit une **version applicative connue**. Il ne constitue
> **ni une preuve de présence, ni une preuve d'absence** d'un déploiement
> physique.

Une destination reprise d'avant le registre n'a jamais eu de hash tout en
servant réellement un domaine. En déduire « rien de déployé » annonçait un
serveur vide devant un serveur plein, et masquait le seul bouton permettant de
le nettoyer.

Le droit de retirer vient donc du **cycle de vie**, jamais d'un hash — et
l'exécution reste protégée par l'inspection, qui va constater sur le serveur :
PM2, PID, socket, Nginx, `siteRoot`, fichiers, uploads, taille.

→ `backend/src/services/deployment/destinationLifecycle.service.js`
→ `SB Auto 06/backend/src/scripts/destination-lifecycle.test.js`

### Trois opérations, et il a fallu les nommer

`DeploymentRun.operationType` distingue ce que trois boutons faisaient
autrefois sous un seul mot. Le vocabulaire est canonique : y ajouter une
valeur sans l'inscrire dans l'énumération faisait crasher le run à
l'enregistrement — c'est arrivé, et l'écran restait bloqué sur une checklist
qui ne finissait jamais.

| Opération | Ce qu'elle fait | Ce qu'elle **ne** fait **pas** |
|---|---|---|
| `DEPLOYMENT` | publie une version sur une destination | — |
| `DEPROVISION` | **vide physiquement** la destination : PM2, port, vhost Nginx, `siteRoot`, fichiers, uploads. La quarantaine 410 est **conservée**, la fiche reste présente en `EMPTY`. | supprimer la fiche, lever la quarantaine |
| `DESTINATION_DELETE` | **vérifie** que la destination est vide, **lève** la quarantaine, puis supprime/soft-delete la fiche. | vider quoi que ce soit — c'est le travail du `DEPROVISION` |

L'ordre est donc **retrait puis suppression**, jamais l'inverse. Le cul-de-sac
qui a précédé cette séparation — une destination `EMPTY` dont la quarantaine
rendait la suppression impossible — n'existe plus : `releaseQuarantine` est
appelée par le `DESTINATION_DELETE`, et c'est son seul appelant.

### Ce qui rend ces opérations observables

| Élément | Ce qu'il garantit |
|---|---|
| **run persistant** | l'exécution survit à la fermeture de l'onglet ; le `runId` est la seule source de reprise |
| **checklist streamée** (NDJSON) | chaque étape arrive en direct, protégée par la ceinture `fluxProtege` |
| **reconnexion par `runId`** | rouvrir la page raccroche au run en cours ; il n'existe **pas** de second système de stream, ni de polling infini, ni de relance |
| **forensics** | `requestId → runId → étapes → verdict`, plus `DeploymentAttempt` (trace HTTP **avant** le run) et `run.journal` (append-only) |

Une suppression réussie ne doit **jamais** faire crasher l'écran : la fiche
disparaît, et l'UI lit son instantané de run, pas une ressource qui n'existe
plus.

---

## 6bis. L'entreprise du Panel : enregistrer suffit

> **`PanelCompany` est la source de vérité de l'identité entreprise du Panel.
> Enregistrer une modification suffit. La distribution aux projets est
> automatique via le Bridge. Les versions sont un mécanisme interne de
> convergence et d'idempotence, pas un workflow de publication utilisateur.**

### Le chemin complet, et il n'a qu'un geste humain

```
Panel · Mon entreprise · [ Enregistrer ]
   │
   ├─ PanelCompany                 la vérité écrite
   ├─ PanelCompanyVersion (N)      un instantané immuable, daté, avec son diff
   └─ emitChange(DEV_COMPANY)      déposé dans le journal de synchronisation
        │
        ↓  le PROJET tire, à son rythme
   syncPull  →  applyCompanyProfile  →  PanelCompanyConfiguration
        │
        ↓
   SB Auto · Aide  →  logo, nom, coordonnées, équipe
```

L'utilisateur clique **une fois**. Rien d'autre ne lui est demandé, et rien ne
lui est présenté comme restant à faire.

### Ce qui a été RETIRÉ du produit, et pourquoi

Trois bandeaux se sont succédé sur cet écran, chacun corrigeant le précédent :
« il reste des modifications non publiées », puis « la dernière diffusion n'a
pas abouti — enregistrez de nouveau », puis « certaines instances n'ont pas
encore reçu la configuration » avec un bouton *Réessayer la diffusion*.

Tous les trois posaient la même question à la mauvaise personne. Celui qui
corrige un numéro de téléphone n'arbitre pas une stratégie de distribution, et
n'a aucun moyen d'agir sur un projet qui ne répond pas. Lui montrer un travail
en attente qu'il ne peut pas faire aboutir, c'est lui demander de surveiller le
pont à sa place.

N'existent donc plus **pour l'utilisateur** : publier, version à publier,
rediffuser, réessayer, « les projets utilisent encore la version N »,
« dernière diffusion ».

### Ce que les versions restent

Un mécanisme de protocole, et rien de plus :

| Sert à | Comment |
|---|---|
| ordonner | un numéro monotone par entreprise |
| idempotence | rejouer une version déjà appliquée est un non-événement |
| anti-régression | une version **antérieure** à celle déjà appliquée est ignorée |
| convergence | un projet absent rattrape la **dernière** vérité |
| diagnostic | savoir ce qu'une instance donnée a réellement appliqué |

### Convergence : le projet finit à la DERNIÈRE vérité

Si le Panel passe v10 → v11 → v12 pendant qu'un projet est absent, celui-ci ne
rejoue aucune expérience utilisateur : il tire ce qu'il a manqué et la garde
de version écarte tout ce qui est plus ancien que ce qu'il a déjà appliqué. Il
finit en **v12**, jamais bloqué sur v11 parce qu'une diffusion intermédiaire
n'aurait pas abouti.

> Aucun clic « rediffuser » n'est nécessaire. Le journal conserve la vérité ;
> le projet vient la chercher.

### Le diagnostic reste, replié et sans bouton

L'état par instance demeure consultable — *Synchronisation des projets*, dans
un repli de l'écran. Il **informe**, il ne demande rien.

Une fiche du registre est **une instance** : la recette et la production d'un
même projet en sont deux, avec deux jetons et deux runtimes.

| Champ | Où | Sens |
|---|---|---|
| `expectedVersion` | `PanelCompany.publishedVersion` | la version en vigueur |
| `appliedVersion` | `PanelProject.appliedConfiguration.companyVersion` | ce que **l'instance déclare** avoir appliqué |

**Seule une déclaration fait preuve.** Ne comptent pas comme accusé : une
écriture partie, un 200 de transport, un battement sans numéro, un horodatage
de tentative.

| État d'instance | Signification |
|---|---|
| `APPLIED` | l'instance a confirmé la version attendue |
| `PENDING` | reliée et vivante, mais pas encore à jour |
| `OFFLINE` | reliée, en retard, plus aucun signe de vie |
| `UNKNOWN` | reliée, mais n'a jamais déclaré de version |
| `NOT_PAIRED` | aucun lien — **ce n'est pas une erreur, c'est une absence** |

`POST /api/company/republish` subsiste comme **outil de diagnostic** : il
renvoie la version en vigueur aux seules instances qui ne l'ont pas confirmée,
sans rien écrire ni créer aucun numéro. Aucun écran ne l'offre.

### L'isolation TEST / PROD n'a pas d'exception

```
Panel TEST  ↔  Projets TEST
Panel PROD  ↔  Projets PROD
```

Deux gardes indépendantes, et jamais une déduction par nom d'hôte :

1. **à l'appairage** — un projet qui se déclare en `PROD` sur un Panel qui sert
   `TEST` est refusé (`BRIDGE_ENVIRONMENT_MISMATCH`) ;
2. **à l'application** — un projet refuse une configuration dont
   l'`environment` n'est pas le sien (`ENVIRONMENT_MISMATCH`).

→ `backend/src/services/company/company.service.js`
→ `tests/panel-company-save-to-help-e2e.test.js` (un save → la page Aide)
→ `tests/real-panel-sbauto-branding-ack-e2e.test.js` (l'accusé, par instance)

---

## 6ter. La session VPS : une seule, et elle se prouve

Une **seule** session ouverte à la fois, avec un TTL canonique **repoussé à
chaque utilisation** — travailler garde la session vivante, l'inactivité la
ferme.

Avant d'affirmer qu'une connexion est établie, une **sonde SSH réelle** est
exécutée. Sans elle, trois échecs distincts — hôte injoignable,
authentification refusée, commande en erreur — s'affichaient tous sous
« Serveur injoignable », et l'opérateur cherchait un problème réseau devant un
mot de passe erroné.

La case à cocher « Garder la session ouverte » **n'existe plus** : elle
demandait à l'utilisateur d'arbitrer une durée de vie qu'il n'avait aucun
moyen d'estimer.

---

## 7. Médias : l'autorité voyage avec le descripteur

```
authority = PANEL | PROJECT
```

| Autorité | Où vit le fichier | Comment l'adresse est produite |
|---|---|---|
| `PANEL` | sur le Panel | **son URL publiée, telle quelle**. Jamais recomposée. |
| `PROJECT` | sur la destination du projet | résolue contre la destination ACTIVE du moment |

Rien ne se déduit d'une clé d'objet, d'un hôte ou d'un type métier : l'émetteur
**déclare**. Autorité inconnue → refus, jamais un essai au hasard.

Cycle d'un média métier historique :

```
fichier legacy sur la destination
  → media.adopt (exécuté SUR la destination)
  → ProjectMedia LOCAL_ONLY
  → media.publish (empreinte vérifiée sur le serveur)
  → PUBLISHED
```

Et au retrait : `PUBLISHED → deprovision → LOCAL_ONLY`.

Le healthcheck teste **l'URL réellement exposée** : une adresse absolue est
sondée sur son propre hôte, seuls les chemins relatifs sont éprouvés contre
chaque origine servie.

---

## 8. Protection contractuelle

Source unique : `SiteStatus.contractProtectionEnabled`, **côté projet**. Le
Panel ne la détient pas ; il la demande par le pont et relit l'état.

| Protection | Contrat | Site |
|---|---|---|
| OFF | aucun | accessible |
| ON | aucun | suspendu `CONTRACT` |
| ON | `ACTIVE` | accessible |
| ON | `CANCEL_AT_PERIOD_END` | accessible |
| ON | terminé | suspendu `CONTRACT` |
| — | — | une suspension `TECHNICAL` est **toujours prioritaire** |

---

## 9. Les sources de vérité

| Question | Qui répond | Jamais |
|---|---|---|
| Quel est l'environnement d'une fiche ? | le projet appairé, à chaque battement | un nom de domaine, une intention de saisie, un manifeste |
| Où vit un projet ? | la destination `ACTIVE` d'une fiche **appairée** | `runtime.publicBackendUrl` (figée au bootstrap) |
| Que sait-on d'une fiche non appairée ? | **rien du projet** — environnement et destination sont `null` | une valeur devinée |
| Ce serveur est-il vide ? | l'inspection | l'absence de `currentVersion` |
| Ces données sont-elles à jour ? | la génération + la fraîcheur, calculées par le backend | une comparaison de dates seule |
| Qui détient ce média ? | `authority` dans le descripteur | l'hôte ou la clé d'objet |
| Le site est-il suspendu ? | le projet | une déduction depuis le contrat côté Panel |

### Sujet par sujet, le champ qui fait foi

| Sujet | Source canonique |
|---|---|
| instance du Panel | `PanelProject.projectId` |
| clé technique de fiche | `PanelProject.projectKey` — **anti-collision seule** |
| environnement | `runtime.environment`, et **uniquement si la fiche est appairée** |
| destination | `PanelProjectDestination` `ACTIVE` d'une fiche **appairée** |
| nom, présentation, description | `PanelProjectPresentation` (projection live) |
| manifeste | `PanelProject.manifest` — **bootstrap et repli** |
| vivacité | `runtime.lastHeartbeatAt` → `liveness` |
| fraîcheur métier | `runtime.lastBusinessSyncAt` — réception **observée** par le Panel |
| modification annoncée | `sourceModifiedAt` de la projection |
| contrat | `PanelProjectContract` de cette instance |
| protection / suspension | `siteStatus` de la projection de cette instance |
| équipe | `PanelProjectMember` (projectId, entityId) |
| média du Panel | descripteur `authority: PANEL` |
| média du projet | descripteur `authority: PROJECT` |
| déploiement | `DeploymentTarget` + moteur de déploiement |
| retrait | `DeploymentRun.operationType = DEPROVISION` |
| suppression de destination | `DeploymentRun.operationType = DESTINATION_DELETE` |

`contract`, `siteStatus` et la protection contractuelle sont
**instance-scoped**. Deux instances d'un même logiciel peuvent donc porter des
valeurs différentes — un contrat résilié en TEST et actif en PROD est un état
légal. Elles vivent de toute façon dans deux Panels distincts : rien ne peut
les fusionner, et rien n'en déduit quoi que ce soit pour l'autre.

---

## 9bis. Les frontières techniques — vérifiées, pas promises

Trois règles séparent le Panel de ce qui l'entoure. Chacune est tenue par un
contrôle qui échoue si le code s'en écarte : aucune ne repose sur la
discipline de celui qui écrit.

### Une socket par axe, et rien d'autre

Le Panel a **deux** axes réseau sortants. Chacun a exactement un fichier
autorisé à ouvrir une socket ; la décision vit ailleurs, le transport vit là.

| Axe | Client unique | Contrat |
|---|---|---|
| Panel → **projet** appairé | `bridge/ProjectBridgeClient.js` | ProjectBridge (OpenAPI) |
| Panel → **autre instance du Panel** | `bridge/MediaAuthorityClient.js` | relais des médias vers l'autorité |

Le relais média vivait dans `services/upload/mediaAuthority.js` : un service
métier qui ouvrait sa propre socket. Ce n'était pas du trafic de pont — donc
pas une violation du contrat projet — mais c'était une sortie réseau que rien
ne surveillait, et rien n'empêchait qu'une deuxième apparaisse ailleurs.

La table est **fermée** : `bridge-conformity` refuse toute autre sortie, et
détecte `fetch`, `axios`, `got`, `undici`, `http(s).request`, `XMLHttpRequest`
et `WebSocket` — pas seulement `fetch`.

### Une seule porte pour l'environnement

`config/env.js` est le **seul** lecteur de `process.env`. Une exception
nommée : `scripts/deploy-worker.js`, point d'entrée détaché qui lit ses
PARAMÈTRES D'INVOCATION — jamais sa configuration — dans l'environnement,
parce qu'`argv` exposerait le mot de passe SSH à `ps aux`.

Propager l'environnement à un processus enfant (`{ ...process.env }` au
lancement du worker) n'est pas une lecture : aucune décision n'en est tirée.

`runJournal.service.js` lisait `DEPLOYMENT_DIAGNOSTIC_STACKS` lui-même. Un
réglage qui vit hors de `config/env.js` n'est ni validé, ni documenté, ni
visible : le jour où l'on cherche ce qui pilote un comportement, on ne le
trouve pas. Il est devenu `config.deploymentDiagnostic.stacks`.

### Les moteurs sont des MIROIRS, et SB Auto fait référence

Le cœur des moteurs `deployment-engine` et `duplication-engine` est
**identique octet pour octet** entre les deux dépôts. Ce qui diffère
légitimement est sorti dans `config/project.profile.js` et
`engine.manifest.json`.

| Contrôle | Qui le porte | Ce qu'il compare |
|---|---|---|
| `engine-drift` | **Panel** | son cœur de moteur au cœur de SB Auto |
| `spec-drift` | **Panel** | `docs/spec/*.openapi.yaml` aux specs maîtresses de SB Auto |
| `engine-governance` | **SB Auto** | son propre moteur à ses règles de généricité |

Un correctif de moteur se porte donc **dans les deux dépôts** — jamais avec un
`if (IS_PANEL)` qui préserverait une copie commune au prix de sa généricité.

---

## 10. Ce que le Panel ne fait pas

- il ne déploie rien : le déploiement est piloté depuis le poste du projet ;
- il ne stocke aucune donnée métier d'un projet, aucune URI Mongo, aucun secret en clair ;
- il ne réaffiche jamais un code d'appairage ni un jeton ;
- il ne se connecte à aucun serveur de projet pour constater un état ;
- il n'invente pas un environnement, une identité ou une adresse.
