# 42 — Recommandations

> **Référence officielle.** Phase 3B.
> Code : `services/diagnostic/recommendation.service.js`.

---

## 1. La règle

> **Le Panel ne dit jamais « corriger ».**

« Corriger » n'est pas une recommandation, c'est un constat déguisé. Une
recommandation utile nomme l'action :

| ❌ Inutile | ✅ Actionnable |
|---|---|
| Corriger le Bridge | Mettre à jour le miroir de contrat du projet en 1.2.0 |
| Vérifier le certificat | Renouveler le certificat du domaine |
| Réparer le Manifest | Faire publier son Manifest au projet (contrat ≥ 1.1.0) |

Un test refuse toute action réduite à un verbe seul, et exige au moins trois
mots.

## 2. Les cinq questions

Toute recommandation répond à :

| Question | Champ |
|---|---|
| Quoi ? | `action` |
| Pourquoi ? | `reasons[]` — les justifications des diagnostics qui l'ont produite |
| Pour quoi faire ? | `benefit` |
| À quel prix ? | `risk` |
| Et avant ? | `prerequisites[]` |

## 3. Ce que ce service ne fait PAS

> **Il n'exécute rien.**

`futureAction` est une **étiquette**, pas un point d'entrée. Elle existe pour
que la Phase 3C (pilotage) sache à quoi rattacher chaque recommandation, sans
avoir à réinterpréter du texte libre.

Catalogue des actions futures : `DIAGNOSE_REMOTE`, `ISSUE_PAIRING_CODE`,
`FETCH_MANIFEST`, `PLAN_CONTRACT_UPGRADE`, `PLAN_CONTRACT_MIGRATION`,
`PLAN_PANEL_UPGRADE`, `PLAN_ENGINE_UPGRADE`, `PLAN_ENGINE_MIGRATION`,
`PLAN_INSTRUMENTATION`, `RENEW_CERTIFICATE`.

Une recommandation renvoyant vers une action hors catalogue est détectée
(`validateFutureActions`).

## 4. Fusion par intention

Plusieurs diagnostics mènent souvent à la **même** action. Sans fusion, une
fiche projet afficherait cinq fois « mettre à jour le contrat ».

Les recommandations sont donc regroupées par `futureAction + action` :

- une seule entrée par action ;
- **tous** les motifs conservés dans `reasons[]` ;
- la priorité retenue est **la plus haute** des motifs — on ne dilue jamais
  une urgence dans une moyenne.

## 5. Effort et levier

L'effort est estimé grossièrement — et c'est assumé : il sert à **ordonner**,
pas à planifier.

| Effort | Poids | Exemples |
|---|---:|---|
| `TRIVIAL` | 1 | renouveler un certificat, générer un code |
| `SMALL` | 2 | diagnostiquer à distance, instrumenter |
| `MEDIUM` | 4 | monter une mineure de contrat ou de moteur |
| `LARGE` | 8 | migrer une majeure |

```text
levier = poids des motifs / poids de l'effort
```

Ce qui rapporte le plus pour le moins de travail remonte en tête. C'est ce
qui rend une liste de quinze recommandations exploitable au lieu d'être
décourageante.

Tri final : **priorité**, puis **levier**, puis identifiant (déterminisme).

## 6. Recommandations du parc

Une même action sur douze projets est **une ligne**, pas douze : c'est ce qui
permet de planifier une campagne.

Au niveau du parc, le levier tient compte du nombre de projets concernés —
une action qui débloque douze projets vaut plus qu'une action isolée.

Chaque ligne porte `projectCount` et la liste nommée des projets.

## 7. Interdits

1. ❌ Une action vague (« corriger », « vérifier », « réparer »).
2. ❌ Une recommandation sans justification issue d'un diagnostic.
3. ❌ Une recommandation sans bénéfice ni risque énoncés.
4. ❌ Deux entrées pour la même action.
5. ❌ Une `futureAction` hors catalogue.
6. ❌ **Exécuter** une recommandation — c'est la Phase 3C.
