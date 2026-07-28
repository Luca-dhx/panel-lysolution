# 48 — Le parcours d'exécution vu de l'interface

> **Référence officielle.** Phase 3C, LOT 8.
> Code : `frontend/src/pages/{ActionsPage,ProjectActionsPage,ExecutionPage}.tsx`,
> `frontend/src/components/execution.tsx`.

---

## 1. Deux principes

**Aucun refus muet.** Un bouton grisé sans explication serait un « Action
refusée. » déguisé. Un refus s'accompagne toujours de ses causes, énoncées
avec les mots du moteur — qui contiennent déjà le « parce que… ».

**Aucune décision côté navigateur.** L'interface n'évalue aucune politique,
ne devine aucun état, ne code aucune action en dur. Elle affiche ce que le
moteur renvoie. Deux interfaces différentes montreraient exactement la même
chose.

Un test vérifie que le workflow ne cite aucun identifiant d'action : le
catalogue vient de `GET /api/executions/actions`.

## 2. Le parcours

```text
Fiche projet ──▶ « Piloter ce projet »
                        │
Diagnostic ──▶ « Préparer cette action » (depuis une recommandation)
                        │
                        ▼
        ┌───────────────────────────────┐
        │ 1. CHOISIR l'action           │  catalogue servi par le backend
        │ 2. RENSEIGNER les paramètres  │  formulaire issu du descripteur
        │ 3. VÉRIFIER LES CONDITIONS    │  POST /prepare — ne crée rien
        │ 4. SIMULER                    │  mode par défaut
        │ 5. EXÉCUTER RÉELLEMENT        │  si et seulement si permis
        └───────────────────────────────┘
                        │
              confirmation requise ?
                        │
                        ▼
              Fiche d'exécution  ──▶ approuver / refuser / annuler
```

Il n'existe **aucun bouton** qui lance une action sans passer par l'étape 3.
L'écran ne peut pas court-circuiter le moteur, parce que le moteur est le
seul à savoir si l'action est permise.

## 3. Les recommandations ne déclenchent rien

La Phase 3B recommandait sans jamais proposer « Corriger ». La 3C ne revient
pas là-dessus : une recommandation porte désormais un lien
**« Préparer cette action → »** qui ouvre le workflow avec l'action
pré-sélectionnée, via son étiquette `futureAction`.

Le lien mène à un écran qui **vérifie**, il ne mène pas à une exécution. Un
test vérifie que la page de diagnostic n'appelle jamais `create`.

## 4. Divulgation progressive

Comme partout dans le Panel :

| Niveau | Écran | Contenu |
|---|---|---|
| 0 | **Actions** | quatre compteurs |
| 1 | **Actions** | ce qui tourne, puis l'historique filtrable |
| 2 | **Fiche d'exécution** | demande, validation, confirmations, résultat |
| 3 | **Fiche d'exécution** | parcours d'états et journal complet, dépliés à la demande |

La page *Actions* n'a **aucun bouton de lancement** : une action se prépare
depuis un projet, jamais depuis une liste. Cette page observe le pilotage,
elle ne le déclenche pas.

## 5. Le mode reste visible en permanence

Un bandeau annonce le mode de chaque exécution :

> *Mode simulation : rien ne sera modifié sur la cible.*
> *Exécution réelle : cette action agira sur la cible.*

Le bouton « Simuler » reste actif même quand l'exécution réelle est refusée
— comprendre ce qui *serait* fait aide à lever le blocage. Le client impose
`SIMULATION` par défaut, comme le backend ; un test vérifie que les deux
défauts coïncident.

## 6. La confirmation est un acte distinct

Une exécution qui attend une décision **quitte le formulaire** et se
poursuit sur sa propre fiche. La confirmation y a son commentaire, conservé
dans l'audit, et son auteur, tracé.

L'écran affiche `approbations / requises` : le jour où une action exigera
deux validations, il n'y aura rien à changer.

## 7. Ce qu'un opérateur voit d'un refus

```text
┌─ Cette action est refusée — 2 causes ─────────────────────────────┐
│ Action refusée parce que la préparation du projet est de 42 %,    │
│ en dessous du minimum de 70 % exigé par cette action.             │
│                                    EXEC_READINESS_TOO_LOW         │
│ Action refusée parce que le prérequis « Manifest connu » n'est    │
│ pas satisfait : Aucun Manifest publié.                            │
│                                    EXEC_PREREQUISITE_UNMET        │
└───────────────────────────────────────────────────────────────────┘

▸ Détail des contrôles (7)
```

Le détail déplié montre **tous** les contrôles, y compris ceux qui passent :
comprendre pourquoi ça marche vaut autant que comprendre pourquoi ça bloque.

## 8. Les conséquences avant la décision

`ROTATE_SECRETS` déclare, en simulation et donc **avant toute
confirmation**, ce que chaque secret entraîne :

> `BRIDGE_ENCRYPTION_KEY` — Les bridgeTokens chiffrés deviennent illisibles :
> TOUS les projets appairés devront être ré-appairés.

Aucune valeur de secret n'apparaît jamais, même en simulation.

## 9. Limites de l'interface

- **Pas de rafraîchissement automatique.** Une exécution en cours ne se met
  pas à jour toute seule ; il faut recharger la fiche. Les exécutions étant
  aujourd'hui quasi instantanées (simulation, ou refus immédiat), le manque
  ne se voit pas encore — il se verra dès la première exécution réelle
  longue.
- **Pas de vue par campagne.** `correlationId` existe côté données, pas
  côté écran.
- **Pas d'export du journal** depuis l'interface.
