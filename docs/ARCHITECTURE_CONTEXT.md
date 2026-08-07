# Contexte d'architecture — Panel

> Le document d'entrée. Il décrit le système **tel qu'il est implémenté
> aujourd'hui**, pas l'architecture visée à l'origine. Chaque affirmation
> renvoie au code qui la porte.
>
> Les documents numérotés (`00_` à `61_`) restent la référence détaillée de
> chaque sujet. Celui-ci répond vite aux questions qu'on se pose en arrivant.

---

## 1. Les cinq mots qu'il ne faut pas confondre

C'est la source de la plupart des malentendus. Ils désignent cinq choses
différentes, et aucun n'est synonyme d'un autre.

| Mot | Ce que c'est | Combien |
|---|---|---|
| **Environnement** | `TEST` ou `PROD`. Une dimension fonctionnelle. | 2 |
| **Instance de Panel** | Une installation déployée du Panel : un domaine, un backend, une base, un `ENV`. | 1 par environnement |
| **Projet logique** | Le client. « SB Auto ». Identifié par `logicalProjectKey`. | 1 par client |
| **Instance de projet** | Le projet déployé dans un environnement. « SB Auto TEST ». **1 instance = 1 `PanelProject`.** | ≤ 1 par environnement |
| **Destination** | L'endroit où une instance est publiée : `demo-sbauto06.ly-solution.com`. | 1 ACTIVE + N historiques |

```
                         PROJET LOGIQUE
                            SB Auto
                               │
                ┌──────────────┴──────────────┐
                │                             │
         SB AUTO TEST                  SB AUTO PROD
         ENV = TEST                    ENV = PROD
         1 PanelProject                1 PanelProject
                │                             │
            pairing A                     pairing B
            jeton A                       jeton B
                │                             │
                ▼                             ▼
          PANEL TEST                     PANEL PROD
          panel-test.…                   panel.…
          ENV = TEST                     ENV = PROD
```

Et sous une instance de projet :

```
SB AUTO TEST
 ├─ destination ACTIVE   demo-sbauto06.ly-solution.com   (canonique)
 └─ destination RETIRED  demo-sbauto.lycarz.com          (encore sur le serveur)
```

**Il n'y a jamais un seul jeton pour deux environnements.** Le jeton de pont
authentifie une INSTANCE ; deux instances, deux appairages, deux jetons.

---

## 2. Comment un projet choisit son Panel

**Par l'URL** qu'il appelle. C'est le mécanisme, et il est correct : deux
instances déployées, deux domaines, deux bases.

```
projet TEST  →  panelUrl = https://panel-test.exemple.com
projet PROD  →  panelUrl = https://panel.exemple.com
```

**Mais le domaine ne prouve pas l'environnement.** Une URL est une chaîne
saisie dans un `.env` : elle dit quelle machine répond, jamais à quel monde
elle appartient. Une adresse recopiée d'un projet à l'autre, une variable
oubliée lors d'une promotion, et la production d'un client s'appaire au Panel
de recette — sans qu'aucune erreur ne se produise.

Le protocole vérifie donc **en plus** :

```
PROJET déclare       environment = TEST
PANEL sert           config.env  = TEST
                     ─────────────────
                     concordance → appairage accepté
```

| Projet | Instance de Panel | Résultat |
|---|---|---|
| TEST | Panel TEST | ✅ appairé |
| PROD | Panel PROD | ✅ appairé |
| TEST | Panel PROD | ❌ `BRIDGE_ENVIRONMENT_MISMATCH` |
| PROD | Panel TEST | ❌ `BRIDGE_ENVIRONMENT_MISMATCH` |

**Fail closed, dans les deux sens.** Aucune correction automatique : rapprocher
TEST de PROD « pour que ça marche » produirait précisément l'accident visé.
Le refus arrive **avant** la consommation du code d'appairage — l'opérateur
corrige son `.env` et rejoue le même code.

**On ne devine jamais l'environnement depuis un nom de domaine.**
`hostname.includes('test')` classerait la production de « Garage Test SARL »
en recette. Les deux côtés le **déclarent**.

→ `backend/src/services/pairing/pairing.service.js` · `tests/panel-instance-environment.test.js`

---

## 3. Le regroupement TEST + PROD à l'écran

Le registre raisonne en instances ; l'opérateur raisonne en projets clients.
`logicalProjectKey` fait le pont.

Il vient de **la clé que le projet annonce lui-même** au pont
(`bridgeIdentity.projectKey`). Deux instances d'un même projet la produisent
identique, puisque le déploiement embarque le `.env` du projet verbatim et ne
réécrit que ce qui est propre à l'hôte.

Ce n'est **ni une saisie, ni une ressemblance** de nom ou de domaine : c'est
une égalité exacte entre deux valeurs déclarées. Une clé issue d'une
dérivation locale (`NAME`, `URL`) ne regroupe rien — deux cartes séparées
valent mieux qu'un faux regroupement.

`null` est normal : les fiches antérieures restent seules de leur groupe, et
sont rattachées automatiquement à la déclaration d'une sœur.

**Invariant :** un projet logique a **au plus une instance TEST et une
instance PROD**.

→ `frontend/src/lib/projectConnections.ts` · `tests/project-connections.test.js`

---

## 4. Le pont : quatre notions, quatre horodatages

Aucune ne s'appelle « synchronisation » tout court.

| Notion | Qui l'établit | Ce que c'est |
|---|---|---|
| **heartbeat** | le Panel | le dernier battement **reçu**. Preuve de vie. |
| **synchronisation déclarée** | le projet | la date que le projet **affirme**, transportée par le battement. Sa parole. |
| **photographie (snapshot)** | le Panel | l'instant où il a **appliqué** une projection métier. Le seul des trois qu'il constate lui-même. |
| **runtime.sync** | le déploiement | l'étape qui publie les URL réseau canoniques. Sans rapport avec le pont. |

Les confondre a déjà coûté un écran entier : deux libellés presque identiques
pour deux nombres différents, sans moyen de savoir lequel faisait foi.

```
pairing → heartbeat → snapshot → projection → freshness → generation
```

→ `docs/architecture/03_PANEL_BRIDGE.md` · `35_HEARTBEATS.md`

---

## 5. Génération d'instance — « ces données sont-elles encore de ce monde ? »

La génération d'un projet est un triplet :

```
environnement | identité d'appairage | hôte de la destination active
```

| Changement | Effet |
|---|---|
| même env, même appairage, même hôte | **même instance** — rien ne bouge |
| changement de domaine | nouvelle génération |
| réappairage | nouvelle génération |
| changement d'environnement | nouvelle génération |

Deux valeurs sentinelles, et elles ne sont **pas** synonymes :

- `SANS-DESTINATION` — un **fait** : ce projet n'a aucune destination active ;
- `DESTINATION-INCONNUE` — une **ignorance** : l'appelant ne s'est pas prononcé.

Une ignorance ne périme rien. Comparer les clés entières comme deux chaînes
faisait passer l'ignorance pour un désaccord et déclarait périmé tout le parc.
La comparaison est donc faite case par case.

→ `backend/src/services/sync/projectGeneration.js` · `tests/instance-generation-freshness.test.js`

---

## 6. Destinations : le cycle de vie, et ce que `currentVersion` ne prouve pas

```
ACTIVE ──► DEPROVISIONING ──► EMPTY ──► DELETED
   │             │
   │             └──► DEPROVISION_FAILED ──┐
   │                        ▲              │
   └──► RETIRED ────────────┴──────────────┘
```

| État | Signification |
|---|---|
| `ACTIVE` | destination canonique de cet environnement. Une seule, garantie par index. |
| `DEPROVISIONING` | retrait en cours. |
| `DEPROVISION_FAILED` | retrait échoué, **reprenable**. |
| `RETIRED` | **n'est plus la destination canonique — sa présence physique n'a PAS été déclarée vide.** |
| `EMPTY` | le serveur a été **prouvé** vide par le workflow. |
| `DELETED` | suppression logique ; audit conservé. |

### `RETIRED` ne veut pas dire vidé

Une destination `RETIRED` peut encore avoir son PM2, son port, sa
configuration Nginx, son `siteRoot`, ses fichiers et ses médias. Elle **doit**
pouvoir être inspectée et déprovisionnée ; elle ne **doit pas** être
supprimable directement.

### `currentVersion` n'est pas une preuve d'existence

> `currentVersion` décrit une **version applicative connue**. Il ne constitue
> **ni une preuve de présence, ni une preuve d'absence** d'un déploiement
> physique.

Une destination reprise d'avant le registre n'a jamais eu de hash tout en
servant réellement un domaine. En déduire « rien de déployé » annonçait un
serveur vide devant un serveur plein, et masquait le seul bouton permettant de
le nettoyer.

Le droit de retirer vient donc du **cycle de vie**, jamais d'un hash — et
l'exécution reste protégée par l'inspection, qui va constater sur le serveur :
PM2, PID, socket, Nginx, `siteRoot`, fichiers, uploads, taille.

→ `backend/src/services/deployment/destinationLifecycle.service.js`
→ `SB Auto 06/backend/src/scripts/destination-lifecycle.test.js`

---

## 6bis. L'entreprise du Panel : enregistrer suffit

> **`PanelCompany` est la source de vérité de l'identité entreprise du Panel.
> Enregistrer une modification suffit. La distribution aux projets est
> automatique via le Bridge. Les versions sont un mécanisme interne de
> convergence et d'idempotence, pas un workflow de publication utilisateur.**

### Le chemin complet, et il n'a qu'un geste humain

```
Panel · Mon entreprise · [ Enregistrer ]
   │
   ├─ PanelCompany                 la vérité écrite
   ├─ PanelCompanyVersion (N)      un instantané immuable, daté, avec son diff
   └─ emitChange(DEV_COMPANY)      déposé dans le journal de synchronisation
        │
        ↓  le PROJET tire, à son rythme
   syncPull  →  applyCompanyProfile  →  PanelCompanyConfiguration
        │
        ↓
   SB Auto · Aide  →  logo, nom, coordonnées, équipe
```

L'utilisateur clique **une fois**. Rien d'autre ne lui est demandé, et rien ne
lui est présenté comme restant à faire.

### Ce qui a été RETIRÉ du produit, et pourquoi

Trois bandeaux se sont succédé sur cet écran, chacun corrigeant le précédent :
« il reste des modifications non publiées », puis « la dernière diffusion n'a
pas abouti — enregistrez de nouveau », puis « certaines instances n'ont pas
encore reçu la configuration » avec un bouton *Réessayer la diffusion*.

Tous les trois posaient la même question à la mauvaise personne. Celui qui
corrige un numéro de téléphone n'arbitre pas une stratégie de distribution, et
n'a aucun moyen d'agir sur un projet qui ne répond pas. Lui montrer un travail
en attente qu'il ne peut pas faire aboutir, c'est lui demander de surveiller le
pont à sa place.

N'existent donc plus **pour l'utilisateur** : publier, version à publier,
rediffuser, réessayer, « les projets utilisent encore la version N »,
« dernière diffusion ».

### Ce que les versions restent

Un mécanisme de protocole, et rien de plus :

| Sert à | Comment |
|---|---|
| ordonner | un numéro monotone par entreprise |
| idempotence | rejouer une version déjà appliquée est un non-événement |
| anti-régression | une version **antérieure** à celle déjà appliquée est ignorée |
| convergence | un projet absent rattrape la **dernière** vérité |
| diagnostic | savoir ce qu'une instance donnée a réellement appliqué |

### Convergence : le projet finit à la DERNIÈRE vérité

Si le Panel passe v10 → v11 → v12 pendant qu'un projet est absent, celui-ci ne
rejoue aucune expérience utilisateur : il tire ce qu'il a manqué et la garde
de version écarte tout ce qui est plus ancien que ce qu'il a déjà appliqué. Il
finit en **v12**, jamais bloqué sur v11 parce qu'une diffusion intermédiaire
n'aurait pas abouti.

> Aucun clic « rediffuser » n'est nécessaire. Le journal conserve la vérité ;
> le projet vient la chercher.

### Le diagnostic reste, replié et sans bouton

L'état par instance demeure consultable — *Synchronisation des projets*, dans
un repli de l'écran. Il **informe**, il ne demande rien.

Une fiche du registre est **une instance** : la recette et la production d'un
même projet en sont deux, avec deux jetons et deux runtimes.

| Champ | Où | Sens |
|---|---|---|
| `expectedVersion` | `PanelCompany.publishedVersion` | la version en vigueur |
| `appliedVersion` | `PanelProject.appliedConfiguration.companyVersion` | ce que **l'instance déclare** avoir appliqué |

**Seule une déclaration fait preuve.** Ne comptent pas comme accusé : une
écriture partie, un 200 de transport, un battement sans numéro, un horodatage
de tentative.

| État d'instance | Signification |
|---|---|
| `APPLIED` | l'instance a confirmé la version attendue |
| `PENDING` | reliée et vivante, mais pas encore à jour |
| `OFFLINE` | reliée, en retard, plus aucun signe de vie |
| `UNKNOWN` | reliée, mais n'a jamais déclaré de version |
| `NOT_PAIRED` | aucun lien — **ce n'est pas une erreur, c'est une absence** |

`POST /api/company/republish` subsiste comme **outil de diagnostic** : il
renvoie la version en vigueur aux seules instances qui ne l'ont pas confirmée,
sans rien écrire ni créer aucun numéro. Aucun écran ne l'offre.

### L'isolation TEST / PROD n'a pas d'exception

```
Panel TEST  ↔  Projets TEST
Panel PROD  ↔  Projets PROD
```

Deux gardes indépendantes, et jamais une déduction par nom d'hôte :

1. **à l'appairage** — un projet qui se déclare en `PROD` sur un Panel qui sert
   `TEST` est refusé (`BRIDGE_ENVIRONMENT_MISMATCH`) ;
2. **à l'application** — un projet refuse une configuration dont
   l'`environment` n'est pas le sien (`ENVIRONMENT_MISMATCH`).

→ `backend/src/services/company/company.service.js`
→ `tests/panel-company-save-to-help-e2e.test.js` (un save → la page Aide)
→ `tests/real-panel-sbauto-branding-ack-e2e.test.js` (l'accusé, par instance)

---

## 7. Médias : l'autorité voyage avec le descripteur

```
authority = PANEL | PROJECT
```

| Autorité | Où vit le fichier | Comment l'adresse est produite |
|---|---|---|
| `PANEL` | sur le Panel | **son URL publiée, telle quelle**. Jamais recomposée. |
| `PROJECT` | sur la destination du projet | résolue contre la destination ACTIVE du moment |

Rien ne se déduit d'une clé d'objet, d'un hôte ou d'un type métier : l'émetteur
**déclare**. Autorité inconnue → refus, jamais un essai au hasard.

Cycle d'un média métier historique :

```
fichier legacy sur la destination
  → media.adopt (exécuté SUR la destination)
  → ProjectMedia LOCAL_ONLY
  → media.publish (empreinte vérifiée sur le serveur)
  → PUBLISHED
```

Et au retrait : `PUBLISHED → deprovision → LOCAL_ONLY`.

Le healthcheck teste **l'URL réellement exposée** : une adresse absolue est
sondée sur son propre hôte, seuls les chemins relatifs sont éprouvés contre
chaque origine servie.

---

## 8. Protection contractuelle

Source unique : `SiteStatus.contractProtectionEnabled`, **côté projet**. Le
Panel ne la détient pas ; il la demande par le pont et relit l'état.

| Protection | Contrat | Site |
|---|---|---|
| OFF | aucun | accessible |
| ON | aucun | suspendu `CONTRACT` |
| ON | `ACTIVE` | accessible |
| ON | `CANCEL_AT_PERIOD_END` | accessible |
| ON | terminé | suspendu `CONTRACT` |
| — | — | une suspension `TECHNICAL` est **toujours prioritaire** |

---

## 9. Les sources de vérité

| Question | Qui répond | Jamais |
|---|---|---|
| Quel est l'environnement d'un projet ? | le projet, à chaque battement | un nom de domaine |
| Où vit un projet ? | la destination `ACTIVE` | `runtime.publicBackendUrl` (figée au bootstrap) |
| Deux fiches sont-elles le même projet ? | `logicalProjectKey` déclaré | une ressemblance de nom |
| Ce serveur est-il vide ? | l'inspection | l'absence de `currentVersion` |
| Ces données sont-elles à jour ? | la génération + la fraîcheur, calculées par le backend | une comparaison de dates seule |
| Qui détient ce média ? | `authority` dans le descripteur | l'hôte ou la clé d'objet |
| Le site est-il suspendu ? | le projet | une déduction depuis le contrat côté Panel |

---

## 10. Ce que le Panel ne fait pas

- il ne déploie rien : le déploiement est piloté depuis le poste du projet ;
- il ne stocke aucune donnée métier d'un projet, aucune URI Mongo, aucun secret en clair ;
- il ne réaffiche jamais un code d'appairage ni un jeton ;
- il ne se connecte à aucun serveur de projet pour constater un état ;
- il n'invente pas un environnement, une identité ou une adresse.
