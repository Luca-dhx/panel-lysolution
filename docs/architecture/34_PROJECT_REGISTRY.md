# 34 — Le registre des projets (supervision)

> **Référence officielle.** Phase 3A. Complète
> [02_PROJECT_REGISTRY.md](02_PROJECT_REGISTRY.md), qui décrit le registre
> comme donnée fondatrice ; ce document décrit ce que la SUPERVISION en tire.
> Code : `services/registry/projectRegistry.service.js` (`describeProject`).

---

## 1. Le principe : dérivé, jamais ressaisi

> **Le Manifest est l'autorité.** Tout ce que le Panel affiche d'un projet
> vient du Manifest qu'il a publié ou de ses heartbeats. Rien n'est saisi à
> la main dans le Panel.

Deux exceptions, toutes deux explicites :

| Donnée | Origine | Pourquoi |
|---|---|---|
| `projectKey`, `projectName` | saisis à la déclaration | ils existent **avant** le premier appairage — sans eux, on ne pourrait pas générer un code |
| `note` | saisie côté Panel | note de supervision interne ; jamais transmise au projet, n'influence aucun calcul |

Le nom saisi sert de **repli** : dès qu'un Manifest arrive, c'est lui qui
s'affiche.

## 2. Le descripteur de supervision

`describeProject(record)` produit la carte de visite affichée partout :

| Champ | Source | Absent si… |
|---|---|---|
| `slug` | `projectKey` du registre | jamais |
| `name` | `manifest.project.name` → repli `projectName` | jamais |
| `type` | `manifest.descriptor.type` | contrat < 1.2.0 |
| `description` | `manifest.descriptor.description` | contrat < 1.2.0 |
| `layout` | `manifest.descriptor.layout` | contrat < 1.2.0 |
| `environment` | `runtime.environment` → repli `manifest.project.environment` | jamais appairé |
| `primaryDomain` | `manifest.network.primaryDomain` → repli : hôte de `publicBackendUrl` | ni l'un ni l'autre publié |
| `urls` | `manifest.network.urls` → repli `{ backend }` | idem |
| `versions.software` | `runtime.softwareVersion` | jamais appairé |
| `versions.contract` | `runtime.contractVersion` | jamais appairé |
| `versions.manifestFormat` | `manifest.manifestVersion` | pas de Manifest |
| `versions.deploymentEngine` | `runtime.engines.deployment` → repli manifeste | contrat < 1.2.0 |
| `versions.duplicationEngine` | `runtime.engines.duplication` → repli manifeste | contrat < 1.2.0 |
| `dates.createdAt` | registre | jamais |
| `dates.pairedAt` | `pairing.pairedAt` | jamais appairé |
| `dates.lastHeartbeatAt` | `runtime.lastHeartbeatAt` | jamais vu |
| `dates.lastActivityAt` | dernier heartbeat → repli `updatedAt` | jamais |
| `dates.manifestUpdatedAt` | horodatage de réception du Manifest | pas de Manifest |

Un champ absent vaut **`null`**, et l'interface affiche « inconnu » — jamais
une valeur inventée, jamais un blanc muet.

## 3. Le registre ne dépend d'aucun projet particulier

Aucune règle du registre ne mentionne un projet nommé. Un projet est décrit
par ce qu'il déclare, pas par ce qu'on sait de lui. C'est vérifié
mécaniquement par `tests/architecture.test.js` (aucune logique spécifique à
un projet dans le code du Panel).

Conséquences :

- un projet **sans Manifest** est un projet valide : il apparaît avec des
  champs inconnus, et rien ne casse ;
- un projet **plus récent** que le Panel peut déclarer des champs inconnus :
  ils sont tolérés et ignorés (lecteur tolérant) ;
- un projet **jamais appairé** figure au registre, en `NOT_PAIRED`.

## 4. Autorité du Manifest

Rappel de la règle posée en Phase 2C
([20_MANAGER_STANDARD.md](20_MANAGER_STANDARD.md) §4) :

| Source | Autorité | Conséquence |
|---|---|---|
| `BRIDGE` (bootstrap ou `GET /manifest`) | **fait foi** | la saisie manuelle est ensuite refusée |
| `MANUAL` (`PUT /api/projects/:id/manifest`) | secours | remplacée dès qu'un Manifest arrive par le pont |

`manifestSource` est exposé sur la fiche : un opérateur voit d'où vient ce
qu'il lit.

## 5. Ce que le registre ne contient jamais

1. ❌ une donnée métier d'un projet (catégorie 1) ;
2. ❌ une URI Mongo, un secret en clair, un hash exposé par une API ;
3. ❌ une valeur déduite d'une convention de nommage ;
4. ❌ un état calculé matérialisé — la vivacité et les capacités interprétées
   sont des **fonctions pures**, recalculées à chaque lecture.
