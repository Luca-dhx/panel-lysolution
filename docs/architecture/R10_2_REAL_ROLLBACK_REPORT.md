# R10.2 — LE RETOUR ARRIÈRE EXISTE VRAIMENT

> Le rollback repointait un lien `current` vers un dossier `releases/<id>`.
> Aucun des deux n'a jamais existé sur une destination déployée par ce
> pipeline. Il est désormais aligné sur le mécanisme réel — l'échange des
> `.prev` — et l'aller-retour est prouvé sur les octets servis.

---

## 1. Baseline et isolation

| dépôt | HEAD au démarrage | upstream | arbre |
|---|---|---|---|
| Panel | `d1e05f0` | `d1e05f0` | propre |
| SB Auto | `9ae2c50` | `9ae2c50` | propre |

Aucun `UNKNOWN`. Le moteur de déploiement est un **miroir strict** entre les
deux dépôts (contrôle dans `deployment-transactionality`) : ce lot touche donc
les deux, à l'octet près.

---

## 2. Cause racine

`rollback.js` s'appuyait sur :

```
 <siteRoot>/releases/<id>     ← listés par `ls -1`
 <siteRoot>/current           ← lu par `readlink -f`, repointé par `ln -sfn`
```

`pipeline.js` ne crée **ni l'un ni l'autre** — il ne contient aucune occurrence
de `releases`, `current` ou `prune`. Sur toute destination réelle :

- `listReleases()` rendait `[]` ;
- `currentRelease()` rendait `null` ;
- `rollbackToRelease()` échouait sur `ROLLBACK_NO_RELEASE`.

Le filet de sécurité n'aurait pas retenu, et la recette l'affirmait pourtant :
son double simulait `ls -1 …/releases` et `readlink -f …/current`, c'est-à-dire
un serveur qui n'existe pas. **Les contrôles validaient un mécanisme fictif.**

### Le vrai défaut, plus profond

Le pipeline donnait aux SPA une bascule `.next` → `.prev`, mais **pas au
backend** : il était uploadé directement par-dessus la version en place.

```js
const b = await transport.uploadDir(artifact.backendDir, backendDir);
```

Il n'existait donc **aucune version précédente du backend** sur le serveur.
Même un rollback correctement écrit n'aurait rien eu vers quoi revenir.

Effet de bord du même défaut : `uploadDir` écrase fichier par fichier **sans
jamais supprimer**. Un module retiré du dépôt survivait indéfiniment côté
serveur — exactement ce que `.next` avait fermé pour les SPA.

---

## 3. Le correctif

### 3.1 Le backend rejoint la discipline `.next` / `.prev`

```js
const backendNext = `${backendDir}.next`;
const backendPrev = `${backendDir}.prev`;
…
const b = await transport.uploadDir(artifact.backendDir, backendNext);
const slots = [...publications, { target: backendDir, next: backendNext, prev: backendPrev }];
```

Coût : **nul**. `npm ci` (étape `dirs`) efface de toute façon `node_modules`
avant de réinstaller, et le `.prev` conserve le sien — une version précédente
reste donc démarrable telle quelle, sans réinstallation.

### 3.2 Le rollback devient un échange

```
 rm -rf <tmp> && mv <cible> <tmp> && mv <prev> <cible> && mv <tmp> <prev>
```

**L'échange est son propre inverse.** Deux propriétés en découlent :

- un rollback raté se **défait par la même opération** — la restauration n'est
  pas un second chemin de code qu'il faudrait maintenir en parallèle ;
- **rejouer un rollback ramène au point de départ**, ce qu'un opérateur attend
  d'un interrupteur.

### 3.3 Ce qui est refusé, et pourquoi

| refus | code | raison |
|---|---|---|
| aucun `.prev` | `ROLLBACK_NO_PREVIOUS_VERSION` | un seul déploiement reçu |
| un `.prev` manque | `ROLLBACK_NO_PREVIOUS_VERSION` | un retour **partiel** servirait l'interface d'hier à l'API d'aujourd'hui |
| `.prev` incomplet | `ROLLBACK_PREVIOUS_CORRUPT` | un backend sans `node_modules` ne démarre pas |
| `mv` impossible | `ROLLBACK_FAILED_RESTORED` | rétabli par le même échange |
| santé rouge | `ROLLBACK_FAILED_RESTORED` | rétabli, puis relancé |

Les emplacements sont **dérivés de `planTopology()`** : un projet qui gagnerait
une SPA la verrait basculer sans qu'on touche à `rollback.js`.

### 3.4 Ce qu'un rollback ne touche jamais

Les **données**. `uploads/` et `storage/` sont des liens vers le partagé
persistant : ils suivent le dossier échangé et pointent toujours au même
endroit. Aucun média, aucun justificatif ne devient invisible.

Les **migrations Mongo** restent la responsabilité de leur lot : revenir au code
d'hier ne défait pas un schéma d'aujourd'hui. C'est une limite réelle, et elle
est écrite dans l'en-tête du module.

---

## 4. Surface publique

| avant | après |
|---|---|
| `rollbackToRelease({releaseId})` | `rollbackToPrevious()` — `releaseId` ignoré |
| `listReleases()` → `[]` | `describeRollbackState()` → état complet |
| `currentRelease()` → `null` | version réellement servie |
| `verifyReleaseIntegrity(releaseId)` | `verifyPreviousIntegrity()` |

Les quatre noms historiques sont **conservés comme adaptateurs** : ils sont
consommés par la façade, le service d'exécution, un contrôle de migration et le
CLI. Les renommer partout aurait mêlé une correction de comportement à un
renommage de surface — deux revues en une. Ce qu'ils **rendent** a changé, et
c'est le point : ils rendaient du vide sur toute destination réelle.

`engine.listReleases()` fait désormais **une seule lecture** au lieu de deux :
deux appels successifs interrogeaient le serveur deux fois pour la même
photographie, et pouvaient la voir changer entre les deux.

Le CLI affiche la version déployée, la précédente, l'état de chaque emplacement,
et **refuse tôt** avec la raison quand aucun retour n'est possible. `--to` est
annoncé comme ignoré plutôt que silencieusement écarté.

---

## 5. La recette a été refaite, pas rafistolée

L'ancien double répondait à `ls -1 …/releases` et `readlink -f …/current`. Le
nouveau tient un **vrai système de fichiers en mémoire** — `mkdir -p`, `rm -rf`,
`mv`, `test -d/-f`, `cat` — sur lequel les commandes du moteur **agissent
réellement**.

Un déploiement s'y rejoue avec la **commande d'échange exacte du pipeline**, et
le retour arrière est prouvé en relisant ce qui est servi :

```
 ✓ avant : la version B est servie
 ✓ APRÈS : la version A est servie
 ✓ la version quittée devient la précédente
 ✓ LES OCTETS SONT CEUX DU DÉPART   (après un second rollback)
```

Un double qui se contente de répondre « OK » prouve qu'on a posé la bonne
question, jamais qu'on obtient le bon résultat.

| suite | résultat |
|---|---|
| `deployment-rollback` (refaite, **miroir**) | **55/55** des deux côtés |
| `deploy` | **93/93** |
| `deployment-transactionality` (garde du miroir) | **12/12** |
| `engine-genericity-e2e` | 38/38 |
| `deployment-topology` | 131/131 |
| `deployment-ssh-restart` | 153/153 |
| `deployment-ui` | 210/210 |
| `media-first-deployment` | 63/63 |
| SB Auto `deployment-engine` | 109/109 |
| **Suite complète Panel** | **113/113 fichiers, 8051 contrôles, 0 rouge** |
| **Suite complète SB Auto** | **86 blocs, 5119 contrôles, 0 rouge** |

Le fichier de recette est lui-même **miroir** : il dérive la composition du
profil (`rollbackSlots`) au lieu de nommer une application. Une SPA côté Panel,
deux côté SB Auto — une liste écrite en dur y aurait été fausse d'un côté.

Trois contrôles ont dû être **corrigés parce qu'ils affirmaient l'ancien
comportement**, et c'est le signe que le changement porte :

- `engine-genericity-e2e` exigeait que le backend soit uploadé **directement**
  dans son dossier définitif. Il exige désormais l'inverse — un `.next`, et
  jamais d'écrasement en place ;
- `deploy` exigeait que la simulation **affiche la réserve** sur les `releases/`
  inexistantes. Cette réserve n'existe plus : R10.2 l'a supprimée en corrigeant
  le mécanisme ;
- `deployment-transactionality` a détecté que le miroir avait divergé — c'est
  exactement son rôle.

**Garde-fous ajoutés** — le défaut qui pourrait se rouvrir sans qu'on le voie :

- le backend est uploadé dans un `.next` **et** figure dans la bascule ;
- la bascule met bien l'ancienne version de côté ;
- `rollback.js` ne construit plus de chemin `releases/`, n'utilise plus
  `currentLink`, n'appelle plus `readlink -f` ;
- l'échange est bien son propre inverse ;
- les emplacements viennent de `planTopology()`, jamais codés en dur.

Ces gardes lisent le **code**, pas les commentaires : le module explique
longuement le mécanisme qu'il remplace, et une garde naïve rougirait sur la
documentation de l'interdit qu'elle défend.

---

## 6. Miroir

`DeploymentEngine.js`, `index.js`, `pipeline.js` et `rollback.js` étaient
**byte-identiques** entre les deux dépôts au démarrage — vérifié avant d'éditer.
Ils le restent : les quatre fichiers ont été recopiés à l'octet près côté SB
Auto, et `deployment-transactionality` le contrôle.

La recette du rollback est mirrorée elle aussi, aux chemins d'import près : le
moteur y est atteint par `../deployment-engine/` côté SB Auto, où le fichier vit
dans `backend/src/scripts/`.

`engine.manifest.json` différait **déjà** avant ce lot : hors périmètre, non
touché.

Ce lot touche donc **les deux dépôts**, et c'est la règle de gouvernance qui
l'impose — pas un élargissement de périmètre. Un moteur corrigé d'un seul côté
serait un moteur qui a divergé.

---

## 7. Réserves honnêtes

- **Ce lot ne prouve pas le rollback sur un serveur.** Il prouve que la logique
  fait ce qu'elle dit sur un système de fichiers fidèle. La vérification réelle
  est l'étape 22 de la recette R10.0 (redéployer deux fois, puis revenir).
- **Une seule génération** est conservée. Revenir deux versions en arrière n'est
  pas possible, et ne l'a jamais été — c'est désormais dit plutôt que suggéré.
- **Le `.env` suit le dossier.** Revenir en arrière restaure l'environnement de
  cette version-là. C'est correct pour un rollback ; si un secret a tourné
  entre-temps, il faudra le repasser.
- **Les migrations Mongo ne sont pas défaites** — hors périmètre du moteur.
- Le premier déploiement après ce lot **ne créera pas encore de `.prev`
  backend** utilisable : il faut deux déploiements pour qu'un retour arrière
  devienne possible. Le refus est explicite et nommé.

---

## 8. Verdict

```
R10.2 REAL ROLLBACK: PASS
GO PRE-DEPLOYMENT REVALIDATION (R10.3): YES
```

Le déploiement TEST reste **subordonné** à cette revalidation.
