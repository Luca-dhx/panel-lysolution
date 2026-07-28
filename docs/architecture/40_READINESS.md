# 40 — Le score de préparation (readiness)

> **Référence officielle.** Phase 3B.
> Code : `services/diagnostic/readiness.service.js`.

---

## 1. Ce que le score dit — et ne dit pas

Le score répond à : **« ce projet est-il prêt pour la production ? »**

Il ne dit pas si le projet est *bon*, ni si son métier est correct. Il dit si
les conditions techniques d'une exploitation sereine sont réunies : pont
établi, signal reçu, versions alignées, composants sains, certificat valide.

## 2. La formule

```text
score = Σ(poids × facteur(état)) / Σ(poids des critères ÉVALUABLES) × 100
```

| État | Facteur | Sens |
|---|---|---|
| `PASS` | 1 | critère satisfait |
| `WARN` | 0,5 | satisfait avec réserve |
| `UNKNOWN` | **0,25** | personne ne sait |
| `FAIL` | 0 | critère non satisfait |
| `SKIP` | — | non applicable : **sort du dénominateur** |

### Deux décisions structurantes, assumées

**1. `UNKNOWN` vaut 0,25 et non 0.**
Ne pas savoir n'est pas équivalent à être en panne. Mais ce n'est pas neutre
non plus : un projet non instrumenté ne peut pas prétendre au même score
qu'un projet vérifié. Le quart est un compromis — il pénalise sans
condamner.

**2. `SKIP` sort du dénominateur.**
Sans cela, un projet non appairé serait pénalisé pour un critère de heartbeat
qui ne le concerne pas, et le score cesserait de vouloir dire quelque chose.
Les critères écartés sont listés dans `formula.skipped`.

## 3. Le plafond bloquant

Trois critères sont **bloquants** : `bridge`, `compatibility`, `heartbeat`.
Si l'un d'eux échoue, le score est **plafonné à 40 %**.

Raison : on ne peut pas être « prêt à 90 % » quand le pont est incompatible.
Un score élevé obtenu malgré un blocage serait un mensonge confortable.

Le plafond est explicite (`formula.ceilingApplied`) et la cause est nommée
(`blockedBy`).

## 4. Les critères

| Critère | Poids | Bloquant | Ce qu'il évalue |
|---|---:|:---:|---|
| `bridge` | 10 | ✅ | appairage actif |
| `compatibility` | 10 | ✅ | verdict de compatibilité global |
| `heartbeat` | 9 | ✅ | vivacité (ONLINE / STALE / OFFLINE) |
| `backend` | 8 | — | santé déclarée par le projet |
| `ssl` | 8 | — | expiration du certificat, ou état publié |
| `mongo` | 8 | — | état de la base publié |
| `manifest` | 7 | — | présence et autorité du Manifest |
| `engines` | 7 | — | alignement des moteurs standards |
| `dns` | 5 | — | état DNS publié |
| `frontend` | 5 | — | état frontend publié |
| `components` | 4 | — | degré d'instrumentation |
| `network` | 3 | — | domaine public déclaré |

Seuls les **rapports** entre poids comptent, pas leur valeur absolue.

## 5. Les niveaux

| Niveau | Condition |
|---|---|
| `READY` | ≥ 90 % |
| `NEARLY_READY` | 70 – 89 % |
| `PARTIAL` | 50 – 69 % |
| `NOT_READY` | < 50 % |
| `BLOCKED` | un critère bloquant en échec (quel que soit le score) |

## 6. Auditabilité

Chaque critère expose son **poids**, son **état**, sa **raison** et sa
**contribution** exacte. Le score se recalcule à la main à partir de ces
valeurs — un test le vérifie en refaisant le calcul indépendamment.

`formula` expose la description, les facteurs, le poids obtenu, le poids
total, les critères écartés et le plafond éventuel.

## 7. Readiness du parc

Moyenne **simple** des scores : chaque projet compte autant. Un parc n'est
pas plus sain parce que ses gros projets vont bien.

La distribution par niveau et le nombre de projets bloqués sont exposés
séparément — la moyenne seule masquerait un projet bloqué parmi dix sains.

Un parc vide ne produit **aucun score** (`null`), jamais un 0 ou un 100
inventé.

## 8. Interdits

1. ❌ Fixer un score en dur.
2. ❌ Compter `UNKNOWN` comme `PASS` (score flatteur) ou comme `FAIL` (score
   punitif).
3. ❌ Faire entrer un critère non applicable dans le dénominateur.
4. ❌ Afficher un score élevé alors qu'un critère bloquant échoue.
5. ❌ Ajouter un critère sans poids ni raison explicite.
