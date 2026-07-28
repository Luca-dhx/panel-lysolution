# 43 — Modèle de risque

> **Référence officielle.** Phase 3B.
> Code : `services/diagnostic/risk.service.js`.

---

## 1. Risque ≠ diagnostic

| | Répond à |
|---|---|
| **Diagnostic** | ce qui **est** |
| **Risque** | ce qui **peut arriver**, et ce que ça coûterait |

Un même diagnostic ne produit pas le même risque selon l'environnement et
l'imminence.

## 2. La cotation

```text
score = probabilité × impact
```

Les deux dimensions sont **calculées** et **justifiées** : un opérateur peut
refaire le calcul à la main.

### Probabilité

| Situation | Probabilité | Raison |
|---|---:|---|
| Fait **déjà constaté** (hors ligne, certificat expiré, majeure divergente…) | **1** | ce n'est plus une probabilité, c'est un fait |
| Certificat expirant à ≤ 3 j | 0,95 | l'échéance est imminente |
| … à ≤ 7 j | 0,80 | |
| … à ≤ 14 j | 0,60 | |
| … au-delà | 0,40 | |
| Signal périmé | 0,50 | peut se rétablir seul, ou basculer hors ligne |
| Défaut d'observabilité | 0,35 | ne cause pas la panne : il en retarde la détection |
| Autres | `0,2 + poids/20` | dérivée de la gravité |

### Impact

```text
impact = poids(gravité) × (PROD ? 1,5 : 1)
```

| Gravité | Poids |
|---|---:|
| `CRITICAL` | 12 |
| `HIGH` | 7 |
| `MEDIUM` | 3 |
| `LOW` | 1 |
| `INFO` | 0 |

L'environnement est la **seule** variable contextuelle du calcul, et elle est
explicite : un même défaut ne coûte pas la même chose en PROD et en TEST.

## 3. Les niveaux

| Niveau | Score |
|---|---|
| `CRITICAL` | ≥ 12 |
| `HIGH` | 7 – 11,99 |
| `MEDIUM` | 3 – 6,99 |
| `LOW` | 1 – 2,99 |
| `INFO` | < 1 |

## 4. Ce que porte un risque

| Champ | Contenu |
|---|---|
| `level`, `score` | la cotation |
| `probability`, `probabilityReason` | la probabilité **et pourquoi** |
| `impact`, `impactReason` | l'impact **et pourquoi** |
| `exposure` | ce qui se passe si rien n'est fait |
| `justification` | reprise du diagnostic d'origine |

Rien n'est opaque : chaque nombre est accompagné de sa raison.

## 5. Synthèse

| Mesure | Sens |
|---|---|
| `total` | nombre de risques |
| `highest` | niveau le plus élevé |
| `aggregate` | **somme des scores** |

`aggregate` distingue « un gros risque » de « dix petits » — deux situations
qui appellent des réponses différentes et que le seul `highest` confondrait.

Au niveau du parc, les dix risques les plus cotés sont exposés, chacun
rattaché à son projet.

## 6. Priorisation

La gravité dit **à quel point c'est grave**. La priorité dit **dans quel
ordre s'en occuper** — elle tient compte de l'environnement.

| Gravité | PROD | TEST |
|---|---|---|
| `CRITICAL` | `CRITICAL` | `URGENT` |
| `HIGH` | `URGENT` | `FIX` |
| `MEDIUM` bloquant | `FIX` | `WATCH` |
| `MEDIUM` non bloquant | `WATCH` | `WATCH` |
| `LOW` / `INFO` | `WATCH` | `WATCH` |

La **file de travail du parc** trie les projets par priorité, puis par risque
cumulé : c'est l'ordre dans lequel un opérateur devrait les traiter.

## 7. Interdits

1. ❌ Un risque listé en dur plutôt que calculé.
2. ❌ Un score sans probabilité ni impact justifiés.
3. ❌ Traiter un fait constaté comme une probabilité < 1.
4. ❌ Ignorer l'environnement dans le calcul d'impact.
5. ❌ Confondre gravité (nature) et priorité (ordre de traitement).
