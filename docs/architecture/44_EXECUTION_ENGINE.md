# 44 — Le moteur d'exécution

> **Référence officielle.** Phase 3C — le Panel ne se contente plus de
> comprendre : il pilote.
> Code : `backend/src/services/execution/`.

---

## 1. La règle de la phase

> **Le Panel n'exécute JAMAIS une action métier directement.**
> Il prépare, valide, confirme, planifie, exécute, suit, historise.
> Toutes les actions passent par un moteur unique. Aucune action ne peut le
> contourner.

Les phases précédentes n'écrivaient rien :

| Phase | Verbe | Écriture distante |
|---|---|---|
| 3A — Supervision | observer | non |
| 3B — Diagnostic | comprendre | non |
| **3C — Exécution** | **piloter** | **oui, par le moteur seul** |

La Phase 3C ouvre la première surface d'écriture. Elle est donc étroite,
gardée, et entièrement tracée.

## 2. Ce que le moteur garantit

Quatre garanties, chacune impossible à obtenir sans passage par le moteur :

1. **Un état ne change que par une transition déclarée.**
   Le moteur n'écrit jamais `state = X` : il *applique une transition*, et
   refuse celles qui ne figurent pas dans la table (→ `45`).
2. **Aucune exécution ne démarre sans politiques satisfaites.**
   Et les politiques sont réévaluées **au démarrage**, pas seulement à la
   création : un projet peut tomber entre les deux.
3. **Aucune action à risque ne part sans confirmation explicite.**
   Le nombre de confirmations vient de la politique de l'action.
4. **Tout est journalisé**, secrets masqués, dans le même document que
   l'exécution (→ `47`).

## 3. Architecture

```text
services/execution/
├── execution.service.js         ORCHESTRATEUR — le cœur
├── execution-state.service.js   machine à états (pur)
├── execution-policy.service.js  moteur de politiques (pur)
├── execution-log.service.js     journal + masquage (pur)
├── execution-plan.service.js    plans dérivés des moteurs réels
├── executor.service.js          dispatcher — charge l'exécuteur déclaré
├── actions/registry.js          LE registre déclaratif (→ 46)
└── executors/                   un module par comportement (→ 46)
```

Les quatre services marqués « pur » n'ont **aucune E/S** : ni base, ni
réseau, ni horloge implicite. Ils sont testables intégralement en mémoire —
c'est ce qui permet aux 190 assertions de la phase de tourner sans jamais
contacter un serveur.

Seul `execution.service.js` touche MongoDB et fabrique le client de pont.

## 4. Le cycle de vie

```text
  prepareAction()          ← évalue et explique, ne crée RIEN
        │
  createExecution()        ← CREATED
        │
     validation            ← politiques + paramètres
        │
   ┌────┴────┐
refus     accepté
   │         │
 FAILED   confirmation requise ?
              │
       ┌──────┴──────┐
      oui            non
       │              │
  WAITING_CONFIRMATION│
       │              │
  confirmExecution()  │
       │              │
       └──────► QUEUED ◄──┘
                 │
            runQueued()   ← RE-valide, puis RUNNING
                 │
      ┌──────────┼──────────┐
  SUCCEEDED   FAILED     TIMEOUT
                 │           │
                 └─► ROLLED_BACK ◄┘
```

`prepareAction()` mérite une mention : c'est ce qui permet à l'interface
d'expliquer un refus **avant** de proposer le moindre bouton. Sans elle, un
opérateur découvrirait le refus après avoir cliqué.

## 5. Simulation par défaut

`mode` vaut `SIMULATION` sauf demande explicite — dans le service, dans le
contrôleur, et dans le client du navigateur. Un test vérifie que les trois
défauts coïncident : deux défauts divergents et la promesse ne veut plus
rien dire.

En simulation, le moteur n'injecte **ni client de pont, ni identifiants**.
L'impossibilité d'agir est structurelle, pas une promesse de bonne conduite.

Deux nuances assumées :

- les politiques d'exécution **ne bloquent pas** une simulation : comprendre
  ce qu'une action ferait aide à lever ce qui la bloque. Le refus reste
  affiché ;
- les **paramètres**, eux, restent exigés : sans eux, il n'y a pas de plan à
  calculer.

## 6. Le client de pont est fabriqué par le moteur

C'est l'inversion qui protège l'écosystème. Un exécuteur **reçoit** son
client ; il ne l'instancie jamais, ne détient jamais le `bridgeToken`. Sans
cela, une action pourrait joindre un projet sans être validée ni tracée.

Vérifié par deux tests d'architecture : la liste des détenteurs légitimes du
client est courte et explicite, et aucun fichier de `executors/` n'y figure.

## 7. Délais et annulation

Le délai vient de `policy.timeoutMs` de **l'action**, jamais d'une constante
du moteur : un contrôle de santé (30 s) et un déploiement (30 min) ne se
surveillent pas pareil. Le dépassement mène à `TIMEOUT`, distinct de
`FAILED` — la cause n'est pas la même, le message non plus.

L'annulation d'une exécution **en cours** ne l'interrompt pas : elle pose
`cancellationRequested`, qui prend effet à la prochaine étape. C'est le
choix de conception le plus discutable de la phase, donc verrouillé par un
test : la transition `RUNNING → CANCELLED` n'existe pas. On n'interrompt pas
une opération distante en vol — on risquerait de laisser la cible dans un
état à moitié modifié.

## 8. Ce que le moteur ne sait pas

Aucun identifiant d'action n'apparaît dans le cœur. Pas de `switch (type)`,
pas de `if (action === 'DEPLOY')`. Sept fichiers sont vérifiés par test :

```text
execution.service.js · executor.service.js · execution-policy.service.js
execution-state.service.js · execution-log.service.js
execution.controller.js · execution.routes.js
```

C'est ce qui rend l'ajout d'une action possible sans toucher au cœur (→ `46`).

## 9. Surface HTTP

`/api/executions`, authentifiée par JWT utilisateur.

| Méthode | Route | Effet |
|---|---|---|
| GET | `/actions` | catalogue |
| GET | `/stats` | compteurs |
| GET | `/queue` | ce qui attend ou tourne |
| GET | `/` | historique filtrable |
| GET | `/:id` | fiche complète, journal compris |
| POST | `/prepare` | évalue **sans créer** |
| POST | `/` | crée une exécution |
| POST | `/:id/confirm` | enregistre une décision |
| POST | `/:id/cancel` | annule ou demande l'annulation |

Il n'existe **aucune** route qui exécute une action sans créer d'exécution.
C'est ce qui rend le contournement impossible par construction.

L'initiateur est toujours dérivé du porteur du jeton, jamais du corps de la
requête : une exécution sans auteur identifié ne serait pas auditable, et le
moteur la refuse.

## 10. Limites connues

- L'exécution **réelle** des actions d'infrastructure (déploiement,
  rollback, portage de moteur, rotation de secrets) **refuse** de partir :
  le Panel ne détient pas d'identifiants SSH, et la recette VPS
  (`33_VPS_ACCEPTANCE.md`) reste ouverte. Le refus nomme précisément ce qui
  manque plutôt que de laisser croire à une capacité inexistante.
- La file est immédiate : une exécution mise en file démarre aussitôt. La
  file est la *sémantique* du cycle de vie, pas encore un ordonnanceur.
- La compensation (`ROLLED_BACK`) est déclarée dans le graphe mais aucune
  action ne la déclenche automatiquement : elle se décide, elle ne
  s'improvise pas.
