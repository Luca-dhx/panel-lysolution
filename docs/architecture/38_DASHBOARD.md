# 38 — Tableau de bord, recherche et chronologie

> **Référence officielle.** Phase 3A.
> Code : `services/supervision/fleet.service.js`,
> `services/supervision/timeline.service.js`,
> `frontend/src/pages/{OverviewPage,FleetPage,ProjectSupervisionPage}.tsx`.

---

## 1. La contrainte de conception

> Le Panel doit rester **agréable à utiliser avec plusieurs dizaines ou
> centaines de projets**.

Un tableau de bord qui liste tout le parc est confortable à 3 projets et
inutilisable à 300. La solution retenue est la **divulgation progressive** :
chaque écran ne montre que ce qui aide à décider où aller ensuite.

## 2. Les quatre niveaux

| Niveau | Écran | Route API | Ce qu'il montre | Ce qu'il ne montre PAS |
|---|---|---|---|---|
| **0** | Supervision (accueil) | `GET /dashboard` | ~10 nombres, alertes (≤ 20), « à regarder » (≤ 10), activité récente | aucune liste du parc |
| **1** | Parc | `GET /fleet` | une ligne par projet : identité, état, versions | manifeste, composants, historique |
| **2** | Fiche projet | `GET /projects/:id` | général, réseau, versions, santé par composant, capacités, 5 derniers événements | manifeste brut, historique complet |
| **3** | Blocs dépliés | `/technical`, `/heartbeats`, `/events` | manifeste, runtime brut, historique, chronologie | — |

**Le niveau 3 n'est chargé qu'à l'ouverture du bloc.** Les blocs sont repliés
par défaut ; leur contenu est requêté à la première expansion, jamais avant.

## 3. Niveau 0 — le tableau de bord

### Indicateurs

Ligne principale : `Projets` · `En ligne` · `Signal périmé` · `Hors ligne` ·
`Alertes critiques`.
Ligne secondaire : `PROD` · `TEST` · `Appairés` · `État inconnu`.

**La couleur n'apparaît que si la valeur mérite l'attention.** Un parc sain
reste visuellement calme — ce qui rend une anomalie immédiatement visible.

### Répartitions de versions

Trois cartes : contrat de pont, moteur de déploiement, moteur de duplication.
Sous forme `{ version: nombre }` — on voit d'un coup si le parc est homogène
ou fragmenté.

### « À regarder en priorité »

Les projets ayant au moins une anomalie (`issues > 0`), triés par nombre
d'anomalies, **limités à 10**. C'est la porte d'entrée réelle du Panel : un
opérateur l'ouvre pour savoir ce qui va mal.

### Ce que le tableau de bord ne renvoie jamais

Aucune liste complète du parc. C'est **vérifié par test** — la réponse ne
contient ni `projects` ni `items` au niveau racine.

## 4. Niveau 1 — le parc et la recherche

### Critères (combinables, ET logique)

| Critère | Type |
|---|---|
| `q` | libre : nom, slug, domaine, type, versions |
| `name`, `slug`, `domain` | « contient » |
| `type`, `environment`, `liveness`, `health`, `pairing` | exact |
| `softwareVersion`, `contractVersion`, `deploymentEngine`, `duplicationEngine` | exact |
| `module`, `feature` | appartenance (actifs **ou** réservés) |

### Facettes

`GET /facets` renvoie les valeurs **réellement présentes** dans le parc.
L'interface ne propose donc jamais un filtre qui ne donnerait aucun résultat,
et n'invente aucune valeur.

### Tri

Par nombre d'anomalies décroissant, puis par nom. Ce qui va mal remonte tout
seul.

### Une ligne reste pauvre

Volontairement : identité, état, versions, dernier signal, compteur
d'anomalies. Pas de manifeste, pas de composants, pas d'historique. C'est ce
qui rend la page tenable sur un grand parc.

## 5. Niveau 2 — la fiche projet

Quatre cartes immédiates : **Général** (nom, slug, type, layout, source du
Manifest), **Réseau** (domaine, URLs), **Versions** (applicative, contrat,
format de manifeste, moteurs), **Chronologie clé** (déclaré, appairé, dernier
signal).

Puis **Santé par composant** — chaque composant avec son statut, son détail
et **sa source** — et **Capacités déclarées** (modules actifs/optionnels,
fonctionnalités actives/réservées, types synchronisés).

Les fonctionnalités inconnues du Panel sont signalées explicitement : elles
sont tolérées et ignorées, jamais une erreur.

## 6. Chronologie

> **Le Panel ne crée aucun événement métier.** Il enregistre ce qu'un projet
> déclare, ou un **constat** de changement entre deux publications.

Chaque entrée porte sa `source` :

| Source | Sens |
|---|---|
| `PROJECT` | le projet l'a déclaré (appairage, Manifest transmis) |
| `PANEL_OBSERVATION` | le Panel l'a remarqué en comparant deux publications |

Il n'existe **pas** de source `PANEL_ACTION` : le Panel n'agit pas sur les
projets dans cette phase. C'est vérifié par test.

### Événements du catalogue

`PROJECT_DECLARED` · `PROJECT_PAIRED` · `PROJECT_UNPAIRED` ·
`HEARTBEAT_RECEIVED` · `VERSION_CHANGED` · `ENGINE_VERSION_CHANGED` ·
`DEPLOYMENT_DETECTED` · `BRIDGE_RECONNECTED` · `HEALTH_CHANGED` ·
`MANIFEST_UPDATED` · `ENVIRONMENT_CHANGED`

### Les constats déduits

`diffObservations()` compare l'état connu au heartbeat entrant :

| Changement observé | Événement | Lecture |
|---|---|---|
| version applicative différente | `VERSION_CHANGED` + `DEPLOYMENT_DETECTED` | le projet a été déployé |
| environnement différent | `ENVIRONMENT_CHANGED` (WARNING) | TEST ↔ PROD : fait majeur |
| santé déclarée différente | `HEALTH_CHANGED` | dégradation ou rétablissement |
| version de moteur différente | `ENGINE_VERSION_CHANGED` | le projet a migré son moteur |
| `uptime` inférieur au précédent | `BRIDGE_RECONNECTED` | le projet a redémarré |

Le Panel **date** ces changements ; il ne les interprète pas davantage.

Rétention bornée par `TIMELINE_HISTORY_SIZE` (défaut 300, par projet).

## 7. Réglages

| Variable | Défaut | Effet |
|---|---|---|
| `HEARTBEAT_INTERVAL_S` | `300` | cadence attendue |
| `LIVENESS_STALE_FACTOR` | `2` | seuil `STALE` |
| `LIVENESS_OFFLINE_FACTOR` | `6` | seuil `OFFLINE` |
| `HEARTBEAT_HISTORY_SIZE` | `200` | signaux conservés par projet |
| `TIMELINE_HISTORY_SIZE` | `300` | événements conservés par projet |
| `CERTIFICATE_WARNING_DAYS` | `21` | alerte avant expiration |

## 8. Interdits

1. ❌ Ajouter une liste complète du parc au niveau 0.
2. ❌ Charger le niveau 3 avant que l'utilisateur ne déplie.
3. ❌ Colorer un indicateur qui n'appelle pas d'attention.
4. ❌ Créer un événement que personne n'a déclaré ni observé.
5. ❌ Ajouter un bouton d'action sur un écran de supervision.
