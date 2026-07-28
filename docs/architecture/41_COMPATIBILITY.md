# 41 — Compatibilité avec l'écosystème

> **Référence officielle.** Phase 3B.
> Code : `services/diagnostic/compatibility.service.js`.

---

## 1. La question posée

**« Ce projet peut-il travailler avec le reste de l'écosystème ? »**

La réponse n'est jamais un simple oui/non : elle est un verdict par **axe**,
puis un verdict global qui est le pire des axes.

## 2. La règle semver de l'écosystème

> **Même majeure exigée. Mineure inférieure tolérée.**

Les évolutions de l'écosystème sont **additives** par contrat
([30_ENGINE_VERSIONING.md](30_ENGINE_VERSIONING.md)) : une mineure ajoute,
elle ne casse pas. Une majeure, par définition, casse.

## 3. Les sept verdicts

| Verdict | Condition | Bloquant |
|---|---|:---:|
| `COMPATIBLE` | version identique à la référence | — |
| `COMPATIBLE_WITH_WARNING` | correctif en retard | — |
| `MIGRATION_AVAILABLE` | mineure en retard | — |
| `VERSION_AHEAD` | projet **plus récent** que le Panel | — |
| `VERSION_TOO_OLD` | sous la version minimale supportée | ✅ |
| `INCOMPATIBLE` | majeure différente | ✅ |
| `UNKNOWN` | version non publiée ou non semver | — |

`VERSION_AHEAD` mérite une note : ce n'est pas le projet qui est en faute,
c'est **le Panel qui est en retard**. L'explication le dit explicitement.

## 4. Chaque verdict est expliqué

Aucun verdict n'est rendu nu. L'explication **cite les deux versions
comparées** et la règle appliquée :

> « Majeures différentes : projet 2.0.0, référence 1.2.0. Une majeure est une
> rupture par définition — l'interopérabilité n'est pas garantie. »

Un test vérifie que chaque explication contient bien les valeurs comparées.

## 5. Les axes évalués

| Axe | Référence |
|---|---|
| `bridge` | version de contrat servie par le Panel |
| `deploymentEngine` | version embarquée par le Panel |
| `duplicationEngine` | version embarquée par le Panel |
| `manifestFormat` | format de Manifest supporté |
| `manifest` | présence et **autorité** (pont vs saisie manuelle) |
| `layout` | topologie déclarée |

Le Panel se compare **à lui-même** : ce qu'il embarque définit le standard
courant. Il ne l'impose à personne — il constate un écart.

Le verdict global nomme l'axe responsable :

> « Incompatibilité bloquante sur : Contrat de pont. »

## 6. Compatibilité croisée du parc

Un parc où chaque projet est compatible avec le Panel peut être **fragmenté** :
trois versions de moteur coexistent, et aucune procédure ne s'applique
uniformément.

Le service détecte deux situations distinctes :

| Situation | Sens |
|---|---|
| `fragmented` | plusieurs mineures coexistent sur un axe |
| `majorSplits` | plusieurs **majeures** coexistent — les procédures standards ne s'appliquent plus uniformément |

Une scission de majeure est bien plus grave qu'une hétérogénéité de mineure :
les deux sont distinguées et expliquées séparément.

## 7. Interdits

1. ❌ Rendre un verdict sans citer les versions comparées.
2. ❌ Traiter une mineure en retard comme une incompatibilité.
3. ❌ Traiter une majeure différente comme un simple avertissement.
4. ❌ Considérer `UNKNOWN` comme compatible.
5. ❌ Confondre fragmentation mineure et scission majeure.
