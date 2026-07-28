# 32 — Processus de publication d'une version de moteur

> **Référence officielle.** La suite d'opérations à exécuter pour publier une
> nouvelle version d'un moteur standard, et la propager.
> Établi en Phase 2E.

---

## 1. Principe

Publier une version de moteur, ce n'est pas pousser un paquet : c'est
**faire évoluer un standard embarqué dans N projets indépendants**. Le
processus doit donc garantir trois choses :

1. le cœur reste identique partout où il est porté ;
2. aucun projet n'est cassé sans l'avoir décidé ;
3. la version publiée est traçable, des années plus tard.

## 2. Le projet de référence

Toute évolution du cœur est **ratifiée dans le projet de référence** — jamais
inventée dans un projet dérivé. C'est la même règle que pour les contrats
Bridge ([spec/README.md](../spec/README.md)).

Un correctif trouvé dans un projet dérivé remonte d'abord au projet de
référence, puis redescend.

## 3. La séquence de publication

### Étape 1 — Ratifier le changement

- décrire le besoin et la solution ;
- déterminer le **type** de version (PATCH / MINOR / MAJOR) d'après
  [30_ENGINE_VERSIONING.md](30_ENGINE_VERSIONING.md) ;
- si c'est une MAJOR : lister les ruptures avant d'écrire une ligne de code.

### Étape 2 — Modifier le cœur

- modifier uniquement les fichiers du **cœur** ;
- si le besoin est propre à un projet, il ne relève pas du cœur : étendre le
  **profil** (ce qui est, en soi, une MINOR du cœur).

### Étape 3 — Écrire la migration si nécessaire

Une migration est nécessaire dès qu'un projet existant devrait changer
quelque chose pour bénéficier de la nouvelle version — profil, fichier
ajouté, manifeste. Voir [31_ENGINE_MIGRATIONS.md](31_ENGINE_MIGRATIONS.md).

### Étape 4 — Mettre à jour le manifeste

| Champ | Action |
|---|---|
| `version` | incrémentée selon le type |
| `releaseDate` | date du jour |
| `capabilities` | ajouter les nouvelles capacités |
| `breakingChanges` | remplir si MAJOR |
| `minimumCompatibleVersion` | relever si on cesse de supporter une ancienne |
| `layoutVersion` | incrémenter si l'arborescence change |
| `history` | ajouter une entrée : version, date, type, résumé, `breaking` |

Le manifeste est validé par `validateManifest()` — un champ manquant fait
échouer les tests.

### Étape 5 — Tester dans le projet de référence

```bash
cd backend
npm run test:engine-governance   # introspection, versions, migrations, nginx
npm run test:rollback            # rollback et restauration
npm test                         # suite complète
```

### Étape 6 — Porter dans les projets maintenus

Pour chaque projet maintenu :

1. copier le **cœur** (jamais `config/`) ;
2. adapter le manifeste : mêmes champs de version, description et
   `compatibleProjects` propres au projet ;
3. exécuter le plan de migration et traiter les étapes manuelles ;
4. lancer la suite du projet **et** le contrôle de dérive.

```bash
npm run test:engine-drift   # doit dire : « Aucun écart »
npm test
```

### Étape 7 — Livrer

- **un commit par dépôt**, jamais un commit mixte ;
- message décrivant la version publiée, son type et son contenu ;
- push sur la branche active de chaque dépôt ;
- vérifier `HEAD local == HEAD distant`.

## 4. Liste de contrôle avant publication

| # | Contrôle | Comment |
|---|---|---|
| 1 | Le cœur est identique dans tous les projets portés | `engine-drift.check.mjs` |
| 2 | Aucune divergence hors `config/` et manifeste | idem |
| 3 | Le manifeste est complet et valide | `validateManifest()` |
| 4 | La version suit la règle PATCH/MINOR/MAJOR | revue humaine |
| 5 | `history` contient la nouvelle entrée | revue humaine |
| 6 | Les capacités nouvelles sont déclarées | test de gouvernance |
| 7 | Une migration existe pour tout changement impactant | test de migration |
| 8 | Un projet à jour ne déclenche aucune migration | test de migration |
| 9 | Un projet ancien obtient un plan précis | test de migration |
| 10 | Aucun profil n'est écrasé | test de migration |
| 11 | Suites complètes vertes dans tous les projets | `npm test` |
| 12 | Aucun secret dans le diff | revue du diff |

## 5. Projets livrés à des tiers

Un projet vendu **n'est jamais mis à jour à distance**. Il embarque sa
version et continue de fonctionner indéfiniment.

Si son propriétaire souhaite en bénéficier :

1. il compare la version de son manifeste à la version publiée ;
2. il applique la procédure de migration ([31](31_ENGINE_MIGRATIONS.md)) ;
3. il valide avec ses propres tests.

C'est lui qui décide, et lui seul. C'est le prix — et la valeur — de
l'autonomie.

## 6. Interdits de publication

1. ❌ Publier une version sans incrémenter le manifeste.
2. ❌ Publier une MINOR qui casse un projet existant (par définition, c'est
   une MAJOR).
3. ❌ Porter le cœur dans un projet sans lancer son contrôle de dérive.
4. ❌ Modifier un `config/project.profile.js` lors d'un portage de cœur.
5. ❌ Un commit contenant des fichiers de deux dépôts.
6. ❌ Un force-push sur un dépôt de projet.
