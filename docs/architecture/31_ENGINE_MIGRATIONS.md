# 31 — Migrations des moteurs

> **Référence officielle.** Comment un projet embarquant un moteur ancien
> passe à une version plus récente, sans rien perdre.
> Code : `deployment-engine/migrations/`.
> Établi en Phase 2E.

---

## 1. Le problème

Un projet livré en 2026 embarque le moteur **1.0.0**. Le standard passe en
**1.1.0**. Recopier le nouveau cœur ne suffit pas si le **profil** du projet
doit gagner un champ, ou si un fichier du moteur doit être ajouté.

Il faut donc savoir, pour un projet donné :

1. quelle version il embarque ;
2. quelles migrations existent entre cette version et la cible ;
3. lesquelles sont **déjà** satisfaites ;
4. lesquelles restent à faire, et comment ;
5. ce qui a effectivement été fait.

## 2. Les trois règles absolues

### 1. Ne jamais réécrire aveuglément un profil

Le profil d'un projet contient des décisions **humaines** : ports, domaines,
topologie, variables vitales. Une migration décrit un changement **précis et
vérifiable**. Si le projet a déjà la valeur voulue, la migration est « déjà
appliquée » et ne touche à rien.

C'est pourquoi la migration du profil (`nginx-profile-driven`) n'a
**délibérément pas** de fonction `apply` : elle explique quoi ajouter, et
laisse la main. Un test verrouille cette absence.

### 2. Ne jamais écraser une personnalisation

Une migration **ajoute** ce qui manque. Elle ne remplace une valeur existante
que si celle-ci est formellement invalide — et le signale alors dans son
rapport.

Exemple : `extended-engine-manifest` ajoute les champs absents du manifeste
avec des valeurs sûres, et **conserve la version d'origine** du projet. Un
test le vérifie explicitement.

### 3. Toujours produire un rapport

Ce qui a été fait, ce qui ne l'a pas été, et pourquoi. Une migration
silencieuse est une migration qu'on ne peut pas auditer.

## 3. Anatomie d'une migration

```js
{
  id: 'nginx-profile-driven',
  from: '1.0.0',
  to: '1.1.0',
  title: 'Nginx piloté par le profil',
  description: '…',
  required: false,            // bloquante si non appliquée ?
  detect(ctx) { … },          // → { applied: bool, reason?: string }
  apply(ctx) { … },           // optionnelle → { changed, notes, … }
  manualSteps: ['…'],         // si pas d'apply
}
```

`ctx` fournit `{ profile, manifest, engineFiles }` — tout est **injecté**, ce
qui rend chaque migration testable sans toucher un vrai projet.

## 4. Les deux temps : planifier, puis exécuter

### `planMigration()` — ce qui serait fait, sans rien faire

```js
const plan = planMigration({
  fromVersion: '1.0.0',
  toVersion: '1.1.0',
  context: { profile, manifest, engineFiles },
});
// → { migrations, pending, blocked }
```

`blocked` vaut `true` si une migration **requise** reste non appliquée. C'est
le signal qu'un projet ne devrait pas être considéré comme à jour.

### `runMigrations()` — exécute uniquement le nécessaire

- une migration déjà appliquée est **ignorée** (`skipped`) ;
- une migration automatique est **appliquée** (`applied`) ;
- une migration sans `apply` est reportée comme **manuelle** (`manual`),
  avec ses étapes ;
- une erreur est capturée et reportée (`failed`) — jamais une exception qui
  interrompt tout.

`renderMigrationReport()` produit un rapport lisible :

```text
Migration du moteur 1.0.0 → 1.1.0
──────────────────────────────────────────────────
✓ [applied] Manifeste de moteur étendu (requise)
    constat : champs manquants : engineApiVersion, layoutVersion…
    résultat : ajout de engineApiVersion, ajout de layoutVersion…
! [manual] Rollback porté par le moteur (requise)
    constat : rollback.js absent du moteur
      → Copier deployment-engine/rollback.js depuis le moteur de référence
      → Vérifier que la façade réexporte rollback / listReleases / verifyRelease
      → Retirer toute logique de rollback des assistants (CLI, Manager)
! [manual] Nginx piloté par le profil
    constat : nginxRole absent pour : vitrine, backend
      → Ouvrir config/project.profile.js
      → Ajouter `nginxRole` à chaque entrée de APPS : …
──────────────────────────────────────────────────
2 migration(s) à traiter manuellement.
```

## 5. Catalogue actuel (1.0.0 → 1.1.0)

| Migration | Requise | Automatique | Ce qu'elle vérifie |
|---|:--:|:--:|---|
| `extended-engine-manifest` | ✅ | ✅ | le manifeste porte `engineApiVersion`, `minimumCompatibleVersion`, `layoutVersion`, `releaseDate`, `supportedProfiles`, `breakingChanges` |
| `engine-owned-rollback` | ✅ | ❌ | `rollback.js` est présent dans le moteur, et les assistants n'ont plus de logique de rollback |
| `nginx-profile-driven` | ❌ | ❌ | chaque application du profil déclare son `nginxRole` |

`nginx-profile-driven` n'est **pas requise** : en son absence, le générateur
déduit le rôle de `role`. Le déploiement fonctionne ; seul le profil reste
implicite.

## 6. Migrer un projet ancien — la procédure

1. **Constater** la version embarquée : lire `engine.manifest.json`, ou
   appeler `describeEngine()`.
2. **Planifier** : `planMigration({ fromVersion, toVersion, context })`.
   Lire le rapport avant d'agir.
3. **Copier le cœur** du moteur de référence — jamais les fichiers de
   `config/`.
4. **Exécuter** : `runMigrations(...)` pour ce qui est automatisable.
5. **Traiter les étapes manuelles** listées par le rapport.
6. **Vérifier** : suite de tests du projet + contrôle de dérive
   (`engine-drift.check.mjs`) vert.
7. **Mettre à jour** la version dans le manifeste du projet.

## 7. Ce que les migrations ne font pas

| Hors périmètre | Pourquoi |
|---|---|
| Migrer des **données** Mongo | ce sont les migrations applicatives du projet, pas celles du moteur |
| Mettre à jour un projet **à distance** | un projet livré n'est jamais touché sans décision de son mainteneur |
| Deviner une intention | une migration vérifie un fait ; elle ne suppose pas |
| Revenir en arrière | il n'existe pas de migration descendante : on repart d'une copie du cœur de la version voulue |

## 8. Ajouter une migration

1. l'écrire dans `deployment-engine/migrations/index.js` avec `detect` et,
   si et seulement si le changement est **mécanique et sans ambiguïté**, un
   `apply` ;
2. sinon, fournir des `manualSteps` **précises et exécutables** ;
3. l'ajouter au catalogue `MIGRATIONS` ;
4. incrémenter la MINOR du moteur ;
5. couvrir les deux cas dans les tests : projet à jour (rien à faire) et
   projet ancien (plan précis, rien d'écrasé).
