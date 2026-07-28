# 29 — Gouvernance des moteurs

> **Référence officielle de l'écosystème L.Y Solution.** Ce document définit
> qui décide quoi sur les deux moteurs standards, et comment ils évoluent
> indépendamment des projets qui les embarquent.
> Établi en Phase 2E (clôture de l'infrastructure).

---

## 1. La philosophie

Les deux moteurs — `deployment-engine` et `duplication-engine` — sont des
**composants standards embarqués**. Ils ne sont ni externalisés, ni installés
comme dépendance : ils vivent dans chaque projet et se dupliquent avec lui.

Cela crée une tension que toute la gouvernance sert à résoudre :

| Exigence | Conséquence |
|---|---|
| Un projet vendu doit rester **autonome** | le moteur est copié, pas référencé |
| Le standard doit pouvoir **évoluer** | un correctif doit pouvoir atteindre N copies |
| Un projet livré ne doit **jamais casser** | aucune évolution n'est imposée à distance |

La résolution : **un cœur identique, versionné, migrable**. Le cœur ne
diverge jamais ; sa version est déclarée ; un projet en retard sait ce qui
lui manque et décide s'il se met à jour.

## 2. La règle d'or

> **Le cœur des moteurs est identique dans tous les projets.**
> Toute divergence passe exclusivement par `config/` et
> `engine.manifest.json`. Toute autre divergence est un **défaut de
> standardisation**.

Concrètement :

| Chemin | Statut | Divergence |
|---|---|---|
| `deployment-engine/*.js` (racine), `dns/`, `report/`, `transport/`, `migrations/` | **CŒUR** | ❌ interdite |
| `deployment-engine/config/project.profile.js` | personnalisation | ✅ attendue |
| `deployment-engine/engine.manifest.json` | identité | ✅ attendue (description, projets) |
| `duplication-engine/duplication.js`, `index.js` | **CŒUR** | ❌ interdite |
| `duplication-engine/config/duplication.profile.js` | personnalisation | ✅ attendue |
| `duplication-engine/engine.manifest.json` | identité | ✅ attendue |

Cette règle est **vérifiée mécaniquement**, pas seulement écrite :
`tests/engine-drift.check.mjs` compare inventaire et contenu octet par octet.
Un profil identique à la référence est d'ailleurs signalé comme une anomalie —
il signifierait que le projet n'a pas été adapté.

## 3. Qui décide quoi

| Décision | Où elle se prend | Qui l'applique |
|---|---|---|
| Faire évoluer le **cœur** | dans le projet de référence | portée ensuite dans chaque projet maintenu |
| Adapter un **profil** | dans le projet concerné, seul | ce projet uniquement |
| Créer un **rôle d'application** (`nginxRole`) | dans le cœur (le générateur doit le comprendre) | tous les projets |
| Ajouter une **capacité** | dans le cœur + `capabilities` du manifeste | tous les projets |
| Décider de **migrer** un projet ancien | par le mainteneur de ce projet | ce projet, quand il le décide |

Un projet livré à un client n'est **jamais** mis à jour à distance. Il
embarque la version qu'il embarque, et continue de fonctionner.

## 4. Ce qu'un moteur sait de lui-même

Un moteur répond à trois questions, sans qu'on lise son code
(`deployment-engine/engineInfo.js`) :

| Question | Fonction | Réponse |
|---|---|---|
| « Qui suis-je ? » | `describeEngine()` | nom, version, version d'API, version de contrat, version minimale compatible, version de layout, date de publication, profil actif |
| « Quelles capacités ai-je ? » | `hasCapability(nom)` | oui/non, d'après `capabilities` |
| « Avec quoi suis-je compatible ? » | `isEngineCompatible(version)`, `isProfileSupported(profil)` | compatible, ou raison du refus (`MAJOR_MISMATCH`, `TOO_OLD`, `TOO_RECENT`, `VERSION_INVALID`) |

C'est ce qui permet à un outil — ou à un développeur devant un projet livré
il y a deux ans — de savoir immédiatement de quoi il dispose.

## 5. Interdits de gouvernance

1. ❌ **Un moteur sans version.** Le manifeste est obligatoire et validé
   (`validateManifest`) ; un champ requis manquant est un échec de test.
2. ❌ **Forker le cœur** pour résoudre un besoin projet. Si le besoin ne
   passe pas par le profil, c'est le profil qu'il faut étendre — dans le
   cœur, pour tous.
3. ❌ **Corriger le cœur dans un seul projet.** Un correctif de cœur est
   porté partout, et la version est incrémentée.
4. ❌ **Externaliser les moteurs** dans un dépôt commun ou un paquet npm
   partagé : cela romprait l'autonomie et la revente.
5. ❌ **Réécrire un profil automatiquement.** Une migration explique, propose,
   et n'écrase jamais une personnalisation (voir
   [31_ENGINE_MIGRATIONS.md](31_ENGINE_MIGRATIONS.md)).
6. ❌ **Faire dépendre un moteur d'un service du projet hôte** : il ne serait
   plus duplicable tel quel.

## 6. Cycle de vie

```text
   besoin ──▶ ratifié dans le projet de référence ──▶ cœur modifié
                                                           │
   version incrémentée ◀── migration écrite (si nécessaire)┘
          │
          ▼
   porté dans les projets maintenus ──▶ contrôle de dérive vert
          │
          ▼
   projets livrés : inchangés, jusqu'à décision de migration
```

Les projets ne sont pas des clients d'un service : ce sont des **porteurs**
d'une version du standard. Le standard avance ; chaque porteur décide quand
il suit.

## 7. Contrôle de dérive

`tests/engine-drift.check.mjs`, exécuté à chaque `npm test` :

1. **inventaire identique** — un fichier en trop ou manquant est une dérive
   structurelle ;
2. **cœur identique** — comparaison octet, fins de ligne normalisées ;
3. **personnalisations présentes et différentes** ;
4. **versions de moteur alignées** entre projets.

C'est un **outil d'atelier** : il compare les projets présents dans le même
workspace de développement et se retire proprement (SKIP) sinon. Il ne crée
aucune dépendance runtime — vérifié par `tests/architecture.test.js`.

## 8. Documents liés

| Document | Sujet |
|---|---|
| [27_DEPLOYMENT_ENGINE_STANDARD.md](27_DEPLOYMENT_ENGINE_STANDARD.md) | le moteur de déploiement |
| [28_DUPLICATION_ENGINE_STANDARD.md](28_DUPLICATION_ENGINE_STANDARD.md) | le moteur de duplication |
| [30_ENGINE_VERSIONING.md](30_ENGINE_VERSIONING.md) | quand incrémenter PATCH, MINOR, MAJOR |
| [31_ENGINE_MIGRATIONS.md](31_ENGINE_MIGRATIONS.md) | passer un projet d'une version à la suivante |
| [32_ENGINE_RELEASE_PROCESS.md](32_ENGINE_RELEASE_PROCESS.md) | publier une version de moteur |
