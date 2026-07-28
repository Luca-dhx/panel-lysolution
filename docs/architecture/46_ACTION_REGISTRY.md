# 46 — Le registre d'actions et le contrat d'extensibilité

> **Référence officielle.** Phase 3C.
> Code : `services/execution/actions/registry.js`, `services/execution/executors/`.

---

## 1. Le contrat d'extensibilité

> **Ajouter une action ne doit demander QUE trois choses :**
> son **descripteur**, son **exécuteur**, ses **politiques**.
> **Aucune modification du cœur.**

C'est vérifié mécaniquement : sept fichiers du cœur ne doivent citer aucun
identifiant d'action (`44 §8`). Si un `if (type === 'MA_NOUVELLE_ACTION')`
apparaît quelque part, le test échoue.

## 2. Forme d'un descripteur

```js
{
  type            // identifiant stable, jamais réutilisé
  label           // libellé lisible
  description     // ce que l'action fait, en une phrase
  category        // regroupement d'interface
  target          // 'PROJECT' | 'PANEL'
  executor        // identifiant du module d'exécution
  simulatable     // sait-elle produire un plan sans agir ?
  futureActions[] // étiquettes 3B qui mènent à cette action
  parameters      // { nom: { required, type, values?, description } }

  policy: {
    requiresConfirmation   // bool
    confirmationsRequired  // 1 aujourd'hui, ≥2 possible sans code
    allowedEnvironments    // ['TEST','PROD']
    risk                   // NONE | LOW | MEDIUM | HIGH | CRITICAL
    rollbackable           // bool
    timeoutMs              // délai maximal
    exclusive              // une seule à la fois sur la cible
    exclusivityScope       // 'PROJECT' | 'GLOBAL'
    requiredReadiness      // score 3B minimal, ou null
    blockOnDiagnostics[]   // règles 3B qui interdisent l'action
    prerequisites[]        // { id, label, check(ctx) → {ok, reason} }
  }
}
```

`validateRegistry()` refuse les descripteurs incohérents : champ manquant,
type dupliqué, `allowedEnvironments` vide (l'action serait inexécutable),
confirmation exigée avec `confirmationsRequired < 1`, délai non positif,
paramètre incomplet.

## 3. Les huit actions

| Type | Risque | Env. | Conf. | Prépa. min | Exclusive |
|---|---|---|---|---|---|
| `CHECK_HEALTH` | NONE | TEST, PROD | — | — | non |
| `REFRESH_MANIFEST` | LOW | TEST, PROD | — | — | non |
| `DEPLOY` | HIGH | TEST, PROD | 1 | 70 % | oui |
| `ROLLBACK` | HIGH | TEST, PROD | 1 | — | oui |
| `UPDATE_BRIDGE` | MEDIUM | TEST, PROD | 1 | 50 % | oui |
| `UPDATE_DEPLOYMENT_ENGINE` | MEDIUM | TEST, PROD | 1 | 50 % | oui |
| `UPDATE_DUPLICATION_ENGINE` | MEDIUM | TEST, PROD | 1 | 50 % | oui |
| `ROTATE_SECRETS` | CRITICAL | **TEST seul** | 1 | 70 % | oui |

Quelques choix explicites :

- **`ROLLBACK` n'exige aucune préparation minimale.** On doit pouvoir
  revenir en arrière *depuis* un état dégradé — c'est précisément là qu'on
  en a besoin.
- **`ROLLBACK` n'est pas `rollbackable`.** Un rollback ne se rollback pas :
  on redéploie.
- **`ROTATE_SECRETS` est limité à TEST** tant qu'aucune recette PROD n'a eu
  lieu. Une rotation de clé de chiffrement rend illisibles les données déjà
  chiffrées et impose un ré-appairage du parc.
- **`DEPLOY` bloque sur `CONTRACT_MAJOR_MISMATCH` et
  `DEPLOYMENT_ENGINE_MAJOR_DRIFT`** : déployer par-dessus une incompatibilité
  majeure aggrave la situation.

## 4. Prérequis réutilisables

Déclarés une fois, référencés partout :

| Prérequis | Vérifie |
|---|---|
| `PAIRED` | le projet est appairé |
| `REACHABLE` | une URL publique est connue |
| `ONLINE` | le projet émet un signal récent |
| `COMPATIBLE_BRIDGE` | l'axe « pont » n'est ni incompatible ni trop ancien |
| `MANIFEST_PRESENT` | un Manifest a été publié |
| `HAS_PREVIOUS_RELEASE` | une release cible est indiquée |

Un prérequis est une fonction pure `check(ctx) → { ok, reason }`. La
`reason` entre directement dans le message de refus.

## 5. Le contrat d'un exécuteur

```js
simulate(ctx) → { plan[], summary, ...extra }   // décrit, n'agit pas
execute(ctx)  → { result, summary }             // agit réellement
```

`ctx` fournit :

| Clé | Contenu |
|---|---|
| `action` | le descripteur **appelant** |
| `record` | la fiche projet |
| `project` | descripteur de supervision |
| `parameters` | paramètres validés |
| `log` | le journal, append-only |
| `services` | capacités injectées (plans, validation de Manifest…) |
| `client` | `ProjectBridgeClient` — **`null` en simulation** |
| `credentials` | identifiants d'infrastructure — `null` aujourd'hui |
| `signal` | `AbortSignal` du délai |

`ctx.action` est le descripteur *appelant*, pas une constante : c'est ce qui
permet à un exécuteur de servir plusieurs actions.

## 6. Un exécuteur ne fabrique jamais son canal

Le moteur construit `client` et l'injecte. Un exécuteur ne détient jamais le
`bridgeToken`, ne fait jamais `new ProjectBridgeClient(…)`, ne fait jamais
`fetch(…)`. Deux tests d'architecture le vérifient sur chaque fichier de
`executors/`.

Sans cette règle, une action pourrait joindre un projet sans validation ni
trace — le moteur serait contournable de l'intérieur.

## 7. Un exécuteur pour deux actions

`UPDATE_DEPLOYMENT_ENGINE` et `UPDATE_DUPLICATION_ENGINE` partagent
`update-engine.js`. Elles ne diffèrent que par leur paramètre `engine`, que
l'exécuteur lit dans **le descripteur appelant** :

```js
const engine = parameters.engine ?? action.parameters?.engine?.values?.[0];
```

C'est la démonstration du contrat : deux descripteurs, un exécuteur, zéro
ligne de cœur modifiée.

## 8. Ajouter une action — la recette

1. **Écrire le descripteur** dans `ACTIONS`, avec ses politiques.
2. **Écrire l'exécuteur** `executors/<nom>.js`, exportant `simulate` et
   `execute`.
3. **Rien d'autre.** L'interface découvre l'action par `GET /actions`, le
   moteur la charge par son champ `executor`, les politiques s'appliquent
   seules.

Les tests existants la couvrent immédiatement : validation du registre,
existence de l'exécuteur, conformité du contrat, absence de citation dans le
cœur, absence de client réseau.

Si la nouvelle action réutilise un comportement existant, l'étape 2 disparaît
aussi — comme pour les deux actions de portage de moteur.

## 9. État réel des exécuteurs

| Exécuteur | Simulation | Exécution réelle |
|---|---|---|
| `check-health` | plan | **oui** — lecture via le pont |
| `refresh-manifest` | plan | **oui** — écrit dans la base du **Panel** seul |
| `deploy` | plan réel du moteur de déploiement | refuse : pas d'identifiants SSH |
| `rollback` | plan réel de la procédure de rollback | refuse : pas d'identifiants SSH |
| `update-bridge` | plan | refuse : pas d'accès en écriture au dépôt |
| `update-engine` | plan + migrations réelles | refuse : pas d'accès en écriture au dépôt |
| `rotate-secrets` | plan + **conséquences** | refuse : dépend de la recette VPS |

Les refus sont formulés comme les refus de politique : « impossible parce
que… », avec ce qui manque nommément et le document qui suit le sujet. Ils
sont regroupés dans `executors/_infrastructure.js` — le jour où un coffre
d'identifiants existe, **seul ce fichier change**.

`refresh-manifest` mérite d'être souligné : c'est la première action du
registre qui écrit, et elle n'écrit que dans la base du Panel. Piloter, ce
n'est pas encore modifier le projet.
