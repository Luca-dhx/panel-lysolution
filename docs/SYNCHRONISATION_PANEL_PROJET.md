# SYNCHRONISATION PANEL ↔ PROJET — ARCHITECTURE FINALE

> Ce document décrit le CODE RÉEL, pas une intention. Il est écrit pour être lu
> sans avoir suivi les lots précédents, et pour permettre de localiser une panne
> **sans deviner**.
>
> Il est identique dans les deux dépôts. Une divergence entre les deux copies
> est un défaut en soi : c'est le même système qu'elles décrivent.

---

## 1. CARDINALITÉ — ce qu'est « un projet », des deux côtés

Les deux dépôts n'emploient pas le mot dans le même sens, et c'est la première
source de confusion possible.

**Côté Manager (SB Auto)** — un projet est un LOGICIEL. Il peut techniquement
gérer plusieurs destinations : une recette et une production, un domaine qui
déménage.

**Côté Panel** — une fiche est une INSTANCE, et rien de plus :

```
1 PanelProject = 1 instance = 1 environnement = 1 appairage = 1 destination
```

Le Panel a porté l'autre modèle. Une fiche regroupait des « sœurs » par
`logicalProjectKey`, et l'écran présentait un projet avec deux environnements
sous une seule ligne — dont un seul répondait. On lisait un CONSTAT là où il n'y
avait qu'un rapprochement de noms.

**`projectId` est l'autorité absolue du périmètre métier.** Aucune donnée métier
n'est scopée par `logicalProjectKey` : le champ subsiste, nullable et inerte, sur
des fiches antérieures, et l'API publique ne le transporte plus. Aucune écriture
ne le renseigne, aucune lecture ne s'en sert.

---

## 2. PROJET → PANEL

```
mutation métier          Company / Contract / SiteStatus / User
   ↓ post('save')        le modèle ANNONCE, il ne décide de rien
notifyEntitySaved        avec les chemins réellement modifiés
   ↓
syncTriggers             un champ SURVEILLÉ a-t-il bougé ?
   ↓
scheduleProjection       coalescence 500 ms — une rafale, une projection
   ↓
buildXxxProjection       la photographie de l'ÉTAT, jamais un delta
   ↓
outbox DURABLE           writeId déterministe, idempotence, tombstones
   ↓
runPushCycle             poussée IMMÉDIATE, gardée contre le chevauchement
   ↓ HTTP
validation de contrat    schéma Zod STRICT — un payload non conforme est REJETÉ
   ↓
projecteur               écriture dans la collection de projection du Panel
   ↓
lastBusinessSyncAt       l'OBSERVATION, par le Panel, d'une réception métier
   ↓
API → écran
```

**Règle qui vaut pour tout ajout :** *tout champ LU par une projection doit être
SURVEILLÉ par son déclencheur.* Un test compare les deux listes. Le symptôme
d'un oubli est parlant : déposer un PDF dans le Manager n'écrivait que
`document.originalFilename`, aucun chemin surveillé ne bougeait, rien ne partait
— et le Panel affichait « non généré » sur un contrat qui avait son document.

Les quatre projections : `PROJECT_PRESENTATION`, `CONTRACT`, `TEAM_MEMBER`,
`PROJECT_SITE_STATUS`. L'équipe n'est pas regroupée : chaque membre est une
entité, un départ est un **tombstone**, jamais une absence.

---

## 3. PANEL → PROJET

```
mutation Panel           PanelCompany, thème, configuration
   ↓
journal DURABLE          PanelSyncJournalEntry — LA source de vérité
   ↓
dispatcher
   ↓
deliverChanges           livraison IMMÉDIATE, concurrence bornée, délai borné
   ↓ HTTP
application projet       applicateurs réels, gardes d'environnement et de version
   ↓
invalidation live UI     le nom de la ressource, jamais son contenu
   ↓
relecture API            l'écran redemande, l'API répond
```

**Le PUSH n'est PAS la source de vérité.** C'est un accélérateur. Une
sauvegarde métier ne dépend jamais de la disponibilité réseau du projet : elle
écrit le journal et rend la main. Mesuré : 6 à 57 ms même projet éteint.

**Le PULL est un filet de convergence, pas le chemin nominal.** L'ordonnanceur
du projet tire périodiquement (30 s). Il ne sert qu'à rattraper ce qu'une
poussée n'a pas pu livrer — projet éteint, redéploiement en cours, coupure
réseau. Si un chemin nominal se met à dépendre de lui, la latence saute de
quelques dizaines de millisecondes à trente secondes : c'est ce que les
invariants de latence surveillent.

---

## 4. SYNC MÉTIER ≠ LIVE UI — deux primitives, et pourquoi les deux

Ce sont deux problèmes différents, et les confondre coûte cher dans les deux
sens.

| | SYNC MÉTIER | LIVE UI |
|---|---|---|
| transporte | l'ÉTAT | le NOM d'une ressource |
| durable | oui — outbox / journal | non |
| perte tolérée | jamais | oui, sans conséquence |
| portée | entre deux applications | dans UN navigateur ouvert |
| autorité | la donnée transportée | l'API relue ensuite |

> **FLUX PERDU ≠ DONNÉE PERDUE.**

Si le flux d'interface tombe, si le backend redémarre, si personne n'écoute : la
donnée est déjà persistée, et un rechargement de page la montre. Le canal live
évite d'avoir à recharger — c'est tout ce qu'il fait, et c'est pour cela qu'il ne
transporte aucun objet métier. S'il en portait, il deviendrait une seconde
vérité que le navigateur pourrait afficher sans l'avoir demandée, et il
répandrait du contenu que l'API n'aurait pas forcément autorisé à ce lecteur.

**Transport :** NDJSON authentifié (`GET /api/live/events`), lu par `fetch` +
reader. Pas `EventSource` : il ne porte pas d'en-tête `Authorization`, et le
jeton n'a rien à faire dans une URL — journaux d'accès, historique, référents.

**Catalogue fermé** — `panel-company`, `site-status`, `contract`. Chaque entrée a
un producteur ET un consommateur, et un test l'exige : un scope déclaré que
personne n'émet ni n'écoute donne l'impression qu'un écran est vivant alors
qu'il ne l'est pas, et survit aux relectures parce qu'il « existe déjà ».

---

## 5. HEARTBEAT ≠ FRESHNESS — trois horodatages, jamais confondus

| horodatage | répond à | ne dit RIEN de |
|---|---|---|
| `lastHeartbeatAt` | cette instance répond-elle ? | ses données |
| `lastBusinessSyncAt` | quand le Panel a-t-il REÇU un état métier ? | l'âge de la donnée à la source |
| `sourceModifiedAt` | quand l'ÉMETTEUR a-t-il modifié cet état ? | quand on l'a reçu |

Un projet peut battre depuis trois jours sans avoir jamais rien projeté.
`lastBusinessSyncAt` à `null` se lit **« jamais reçu »** — ce qui n'est ni
« ancien » ni, surtout, « à jour ».

`sourceModifiedAt` est ce qui **arbitre** (dernier écrit gagne), jamais l'heure
de réception : deux instances dont les horloges divergeraient produiraient
sinon un vainqueur arbitraire.

---

## 6. COMMANDE ≠ PROJECTION CONFIRMÉE

Une commande exprime une INTENTION. Une projection constate un ÉTAT.

```
POST /site-status/contract-protection { enabled: true }     ← commande
PROJECT_SITE_STATUS { contractProtectionEnabled: true }     ← état confirmé
```

L'interrupteur du Panel reste donc en attente (`pending`) jusqu'à ce que la
**projection reçue** close l'intention. Il ne bascule pas sur la réponse HTTP :
un `200` dit « la commande est acceptée », pas « l'état est appliqué ». Les
confondre ferait afficher un site protégé alors que la protection n'a jamais
pris effet.

---

## 7. CONNEXION ≠ VITRINE

Deux axes indépendants, et un seul écran les fondait :

- **Connexion projet** — `lastHeartbeatAt`, le pont. « Le Panel arrive-t-il à
  parler à cette instance ? »
- **État de la vitrine** — `PROJECT_SITE_STATUS`, la vérité persistée. « Le site
  du client est-il accessible à ses visiteurs ? »

Un projet parfaitement connecté peut servir une vitrine suspendue ; une vitrine
en ligne peut appartenir à une instance dont le pont est coupé. L'en-tête
affichait le battement du pont sous l'intitulé « État du site » — c'est-à-dire
une information exacte sous une question à laquelle elle ne répondait pas.

Et une suspension **CONTRACT** n'est pas une suspension **TECHNICAL**. Les mêler
ferait arriver une maintenance sous l'étiquette « contrat », et rendrait la fiche
incapable de dire pourquoi un site est coupé — la seule information utile.

---

## 8. MÉDIAS

```
politique canonique      mediaPolicy — UNE table, par type métier
   ↓
upload                   magic bytes → sharp → dimensions → refus TYPÉ
   ↓
remplacement atomique
   ↓
descripteur              mediaId, sha256, dimensions — jamais une URL nue
   ↓
projection               le descripteur voyage, pas le fichier
   ↓
autorité                 le projet SERT ses médias ; le Panel les référence
```

**Les limites étaient à quatre endroits qui ne se parlaient pas** : multer
(12 Mo), le générateur Nginx (rien, donc 1 Mo par défaut), le frontend (aucune),
le traitement d'image (au cas par cas). Un logo de 3 Mo passait en local et
repartait en **413 derrière Nginx** — et l'écart de 12× n'était écrit nulle part.

Aujourd'hui : `MAX_INPUT_BYTES` borne multer, `HTTP_BODY_LIMIT_MB` borne Nginx
avec une marge délibérée (le multipart transporte plus que le fichier), et le
refus par type arrive ensuite — proprement, avec sa raison et sa limite.

**Le backend reste le SEUL arbitre.** Aucune limite n'est recopiée côté client :
le refus voyage avec la sienne (`details.maxBytes`). Les deux phrases d'aide qui
citent un plafond sont vérifiées par un contrôle de dérive contre la table.

---

## 9. INCIDENTS / ACK / RETRY — la classification décide du sort

| classe | signification | sort de l'entrée |
|---|---|---|
| `TRANSIENT` | le réseau, l'instant | reprise avec report croissant |
| `COMPATIBILITY` | le destinataire ne SAIT pas encore lire | **conservée**, réaffirmée, réparée par un déploiement |
| `SECURITY` | l'appairage, l'environnement | conservée, jamais rejouée en boucle |
| `BUSINESS` | la donnée elle-même est refusée | conservée et signalée |
| `IDEMPOTENT` | déjà appliquée | acquittée, sans seconde écriture |

**C'est ici que le défaut le plus coûteux du système a vécu.** Un refus
`COMPATIBILITY` sortait de la file, et plus rien ne le rejouait : le Panel
affichait indéfiniment un ancien nom d'entreprise, sans qu'aucun écran ne
signale quoi que ce soit. La donnée était juste à la source, refusée en vol, et
le silence était total.

Un refus est donc désormais **durable, visible, classé et auto-réparable** : il
se réaffirme, et le jour où le destinataire sait le lire, il passe — **sans
second enregistrement**.

---

## 10. SHUTDOWN — RUNNING → DRAINING → STOPPED

```
SIGTERM / SIGINT
   ↓
beginDraining()          l'état bascule AVANT la vidange
   ├─ projections en attente : construites et mises en file MAINTENANT,
   │                           tant que la base est encore ouverte
   ├─ ordonnanceur du pont  : arrêté (chacun de ses tics lit la base)
   └─ flux d'interface      : fermés, après un `live.closing`
   ↓
server.close()           cesse d'accepter
server.closeIdleConnections()   les sockets keep-alive au repos partent
   ↓ (délai de grâce : 10 s)
disconnectDatabase()     en DERNIER, quand plus personne ne lit
```

Chaque composant **inscrit lui-même** sa fermeture (`onDrain`). Le point
d'entrée n'a pas à les connaître : un ordre d'extinction écrit ailleurs que
près du travail qu'il ferme devient faux au premier ajout.

**Deux défauts réels que cette séquence ferme :**

1. `PROJECTION_BUILD_FAILED` était écrit à chaque arrêt survenu dans la fenêtre
   de coalescence — le minuteur arrivait à échéance après la fermeture de la
   base. Le système n'était pas en panne : il s'arrêtait. Confondre les deux
   apprend à ignorer une catégorie d'incidents, et le jour où l'un d'eux est
   vrai, personne ne le lit. *La condition porte sur l'ÉTAT DU RUNTIME, jamais
   sur l'environnement : un `SIGTERM` de production traverse le même chemin.*

2. `server.close()` n'appelle son rappel qu'à la fermeture de la dernière
   connexion. Un flux NDJSON ne se ferme jamais seul, et les connexions
   keep-alive au repos non plus. **Un seul Manager ouvert suffisait à épuiser le
   délai de grâce** : sortie forcée en code 1, base jamais refermée proprement,
   `reload` PM2 soldé par une erreur sur un arrêt normal.

**Rien n'est perdu.** L'écriture métier est persistée avant toute projection, la
file est durable, et `reconcileAll()` reconstruit la photographie complète au
démarrage suivant. L'arrêt DIFFÈRE, il n'annule pas.

---

## 11. PLAYBOOK DE DIAGNOSTIC

Le but est de **localiser** la panne, pas de la deviner. Chaque étape a un
endroit où regarder et un verdict franc.

### « Une modification ne remonte pas PROJET → PANEL »

| # | vérifier | où | verdict si faux |
|---|---|---|---|
| 1 | le hook a-t-il annoncé ? | le champ est-il dans `*_PATHS` de `syncTriggers` ? | **champ non surveillé** — c'est la cause la plus fréquente |
| 2 | le module est-il branché ? | `isSyncWired()` | seeds/migrations : normal ; runtime : bootstrap incomplet |
| 3 | la projection est-elle construite ? | `buildXxxProjection()` à la main | erreur de construction — voir les incidents |
| 4 | est-elle en file ? | `outboxDump()` | le déclencheur n'a rien programmé → retour au 1 |
| 5 | une tentative a-t-elle eu lieu ? | `attempts`, `lastAttemptAt` | 0 → la poussée n'est pas demandée |
| 6 | acquittée ou REFUSÉE ? | `status`, `failureClass`, `lastErrorCode` | `COMPATIBILITY` → le Panel ne sait pas lire ce payload |
| 7 | le projecteur a-t-il écrit ? | la collection de projection du Panel | payload accepté mais non projeté |
| 8 | `lastBusinessSyncAt` a-t-il avancé ? | la fiche | non → rien n'est jamais arrivé |
| 9 | l'API l'expose-t-elle ? | `GET /api/projects/:id` | oui aux 1→8 et non ici → défaut d'affichage |

> **Le pire cas est le 6 muet.** C'est le défaut historique : un refus qui ne
> laissait aucune trace. Il en laisse désormais une, durable et classée.

### « Une modification du Panel ne se voit pas dans le Manager »

| # | vérifier | où | verdict si faux |
|---|---|---|---|
| 1 | le journal a-t-il une entrée ? | `PanelSyncJournalEntry` | la mutation n'a pas produit d'écriture → défaut côté service |
| 2 | une livraison a-t-elle été tentée ? | `describeDeliveries()` | non → le dispatcher n'a pas été sollicité |
| 3 | a-t-elle abouti ? | statut de la tentative | refus de connexion → projet éteint ; le PULL rattrapera |
| 4 | le projet a-t-il appliqué ? | son état de configuration appliquée | refus d'environnement / de version |
| 5 | l'API du projet expose-t-elle la valeur ? | son contrôleur, pas son modèle | appliqué mais non servi |
| 6 | l'invalidation est-elle partie ? | `describeUiLive().eventsEmitted` | 0 abonné : normal, l'écran n'est pas ouvert |
| 7 | l'écran écoute-t-il ? | `useResource(..., { live: '<scope>' })` | scope absent → l'écran ne se revalide jamais |
| 8 | la relecture répond-elle juste ? | l'appel réseau | oui aux 1→7 et non ici → cache navigateur |

> **Le 3 est le point de bascule.** Une livraison qui échoue n'est PAS une perte :
> le journal reste, et le filet de convergence rattrape. Ce qui serait grave
> serait une entrée absente au 1.

---

## 12. CE QUE LA RECETTE PROUVE

`Panel/tests/event-driven-system-e2e.test.js` — un Panel réel, un SB Auto réel
dans son processus, sa base et son port. Aucune vidange manuelle, aucun
`applyIncoming`, aucun `syncNow` sur les chemins nominaux.

| scénario | ce qu'il prouve |
|---|---|
| A | projet → Panel, une écriture ordinaire suffit, pour les 4 familles |
| B | Panel → projet, jusqu'à l'invalidation de l'écran ouvert |
| C | projet absent : le Panel écrit vite, et ça converge au retour |
| D | Panel absent : le projet écrit vite, la file garde, et ça converge |
| E | payload d'un autre monde : refusé, sans écriture partielle |
| F | flux d'interface coupé : la donnée arrive quand même |

**Latences mesurées** (médiane / p95 / pire, 5 itérations) :

| sens | médiane | p95 | pire |
|---|---|---|---|
| projet → Panel | ~570 ms | ~575 ms | ~575 ms |
| Panel → projet | ~31 ms | ~75 ms | ~75 ms |

Le seuil de recette est **5 s**, et il n'est pas choisi contre la machine : il
est choisi **contre le polling**. La fenêtre de coalescence (500 ms) est la
seule latence structurelle du sens montant ; le premier tic périodique est à
30 s. Un échec ici ne dit pas « c'est lent » — il dit *« on est retombé sur du
polling »*.
