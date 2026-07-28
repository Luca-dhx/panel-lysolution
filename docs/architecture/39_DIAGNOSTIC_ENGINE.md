# 39 — Le moteur de diagnostic

> **Référence officielle.** Phase 3B — le Panel ne se contente plus
> d'afficher : il comprend et explique.
> Code : `backend/src/services/diagnostic/`.

---

## 1. La règle de la phase

> **Analyser, diagnostiquer, expliquer, recommander. Rien d'autre.**
> Aucune écriture distante, aucune synchronisation, aucun déploiement,
> aucune modification d'un projet.

La Phase 3A **observe**, la Phase 3B **comprend**. Aucune des deux n'agit.

Trois invariants garantissent cette frontière, **vérifiés par test** :

1. aucun fichier du moteur ne contient `fetch` ni `ProjectBridgeClient` ;
2. aucun fichier du moteur n'écrit en base (`create`, `updateOne`, `save`…) ;
3. le routeur `/api/diagnostic` ne déclare que des `GET`.

## 2. Pureté et déterminisme

Le moteur est un **calculateur pur** : il reçoit un contexte déjà chargé et
rend un objet. Aucune E/S, aucune horloge implicite — `now` est toujours
injecté.

Conséquence directe : **deux évaluations du même contexte produisent
exactement le même résultat**, jusqu'à l'ordre des listes. Les tris sont
tous déterministes (priorité, puis gravité, puis identifiant). C'est ce qui
rend la totalité du moteur testable sans base ni réseau.

Un test compare deux exécutions successives champ par champ.

## 3. Architecture

```text
services/diagnostic/
├── rules/
│   ├── engine.js       mécanique d'évaluation — ne sait RIEN du métier
│   └── catalog.js      LE catalogue déclaratif — toute la connaissance
├── compatibility.service.js  verdicts par axe + compatibilité croisée
├── readiness.service.js      score pondéré, formule auditable
├── risk.service.js           probabilité × impact
├── recommendation.service.js actions, fusionnées par intention
└── diagnostic.service.js     orchestrateur
```

L'ordre d'exécution compte : la **compatibilité** est calculée avant les
règles, parce que certaines s'y adossent et que la readiness en dépend.

```text
contexte → compatibilité → règles → diagnostics
                                       ├→ readiness
                                       ├→ risques
                                       └→ recommandations → priorité globale
```

## 4. Le catalogue déclaratif

> **Ajouter un diagnostic = ajouter une entrée au catalogue.**
> Il n'existe aucun `if` de diagnostic ailleurs dans le code.

Une règle déclare :

| Champ | Rôle |
|---|---|
| `id` | identifiant stable, jamais réutilisé après suppression |
| `category` | `CONNECTIVITY` · `COMPATIBILITY` · `SECURITY` · `CONFIGURATION` · `OBSERVABILITY` · `LIFECYCLE` |
| `component` | composant concerné |
| `severity` | gravité **nominale** (`INFO` → `CRITICAL`) |
| `title`, `description`, `impact` | libellés lisibles |
| `when(ctx)` | `false`, `true`, ou `{ severity?, facts? }` pour ajuster selon la situation |
| `explain(ctx, facts)` | **POURQUOI** ce diagnostic existe, avec les valeurs constatées |
| `recommendation(ctx, facts)` | action, bénéfice, risque, prérequis, action future |
| `readiness` | `{ criterion, blocks }` — lien avec le score de préparation |

Le catalogue est **validé** : champs obligatoires, gravités et catégories
connues, identifiants uniques. Un catalogue mal formé fait échouer les tests.

État actuel : **26 règles**, toutes porteuses d'une recommandation.

## 5. « Aucun diagnostic magique »

C'est l'exigence centrale de la phase. Chaque diagnostic porte une
`justification` **construite à partir des valeurs réellement constatées** —
jamais une phrase générique :

> « Le projet annonce le contrat 1.0.0, le Panel sert 1.2.0. Les évolutions
> étant additives, les échanges fonctionnent, mais les champs récents ne sont
> pas publiés. »

Chaque diagnostic porte aussi son `origin` :

| Origine | Sens |
|---|---|
| `PROJECT_DECLARATION` | le projet l'a déclaré |
| `PANEL_OBSERVATION` | le Panel l'a constaté (silence, absence) |
| `PANEL_ANALYSIS` | le Panel l'a déduit (comparaison de versions) |
| `PANEL_RULE_ENGINE` | une règle du catalogue a échoué |

## 6. Résilience du moteur

Une règle qui lève une exception **ne fait pas tomber le diagnostic** : elle
produit un diagnostic `RULE_FAILURE_<id>` explicite, et l'évaluation
continue. Un défaut du catalogue est un défaut du Panel, pas du projet
observé — et il doit se voir.

## 7. L'API

Toutes les routes sont des `GET`, sous `/api/diagnostic` :

| Route | Contenu |
|---|---|
| `/fleet` | analyse du parc : readiness moyenne, compatibilité croisée, top risques, file de travail |
| `/catalog` | **le catalogue lui-même** — rend le moteur auditable sans lire le code |
| `/projects/:id` | analyse complète d'un projet |
| `/projects/:id/compatibility` | verdicts par axe |
| `/projects/:id/readiness` | score et détail des critères |
| `/projects/:id/risks` | risques cotés |
| `/projects/:id/recommendations` | actions recommandées |

**Aucun résultat n'est mis en cache ni matérialisé.** Un diagnostic reflète
l'instant, jamais un souvenir. Le coût est assumé : le calcul est pur et
rapide.

## 8. Ajouter une règle

1. ajouter une entrée à `rules/catalog.js` ;
2. écrire `when` (quand ça s'applique) et `explain` (pourquoi, avec les
   valeurs constatées) ;
3. écrire `recommendation` si une action existe — l'action future doit
   figurer dans `FUTURE_ACTIONS` ;
4. déclarer `readiness` si la règle touche un critère de préparation ;
5. ajouter un cas au tableau de `diagnostic.test.js` (« telle situation →
   telle règle »).

Aucune autre modification n'est nécessaire : ni dans les services, ni dans
l'API, ni dans l'interface.

## 9. Interdits

1. ❌ Un diagnostic sans justification citant des valeurs constatées.
2. ❌ Une règle écrite hors du catalogue.
3. ❌ Un appel réseau ou une écriture dans le moteur.
4. ❌ Une horloge implicite (`Date.now()` hors valeur par défaut injectable).
5. ❌ Un résultat non déterministe (tri instable, itération non ordonnée).
6. ❌ Exécuter une recommandation — c'est la Phase 3C.

## 10. Documents liés

| Document | Sujet |
|---|---|
| [40_READINESS.md](40_READINESS.md) | score de préparation, pondérations, formule |
| [41_COMPATIBILITY.md](41_COMPATIBILITY.md) | verdicts, axes, compatibilité croisée |
| [42_RECOMMENDATIONS.md](42_RECOMMENDATIONS.md) | recommandations actionnables |
| [43_RISK_MODEL.md](43_RISK_MODEL.md) | probabilité, impact, cotation |
| [36_SUPERVISION.md](36_SUPERVISION.md) | la couche d'observation dont ceci dépend |
