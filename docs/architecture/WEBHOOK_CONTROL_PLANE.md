# Plan de contrôle des webhooks — la fondation (L5)

> Lot **L5** de [INTEGRATED_API_CONTROL_PLANE_ROADMAP.md](INTEGRATED_API_CONTROL_PLANE_ROADMAP.md)
> (§8, §13). Ce document décrit ce qui est **livré**, pas ce qui est prévu.

---

## 1. Ce que c'est — et les quatre choses que ce n'est pas

Le plan de contrôle des webhooks répond à **une** question :

> Ce que le Panel **veut** chez un fournisseur, et ce que ce fournisseur
> **expose réellement**, coïncident-ils — et depuis quand le sait-on ?

Quatre confusions valent d'être écartées d'emblée, parce que chacune conduit à
un système différent.

| Ce n'est pas… | Différence |
|---|---|
| **un bus métier** | Aucun événement n'est traduit en verbe métier (`PAYMENT_SUCCEEDED`…), aucun n'est dispatché vers un projet. L5 vérifie, déduplique, journalise. La traduction appartient à L6/L7/L8, qui possèdent les providers. |
| **le pont (Bridge)** | Le pont relie le **Panel et ses projets**, avec un `bridgeToken` et un contrat versionné. Le plan de contrôle webhook relie le **Panel et des tiers**, avec une signature du fournisseur. Deux frontières, deux mécanismes d'authentification, deux surfaces HTTP. |
| **du polling** | Rien n'interroge un fournisseur en boucle pour savoir « quoi de neuf ». La réconciliation est déclenchée au démarrage et à la demande ; elle ne lit que la configuration des endpoints, jamais des données métier. |
| **un registre de fournisseurs** | `providerRegistry.js` reste l'autorité sur ce qui existe. Le registre webhook décrit **comment** un webhook se gère, jamais **si** un fournisseur existe — et l'alignement des deux est vérifié à l'import. |

---

## 2. Le trajet complet

```
       ┌──────────────────────────── RÉCONCILIATION (sortante) ──────────────────┐
       │                                                                          │
   PANEL ── coffre (clé d'API) ──► FOURNISSEUR : liste / crée / met à jour        │
       │                             └── secret de signature capturé À LA CRÉATION │
       │                                                                          │
       └── binding : désiré vs observé, dates, dérive, diagnostic ◄───────────────┘


       ┌──────────────────────────── RÉCEPTION (entrante) ───────────────────────┐
       │                                                                          │
   FOURNISSEUR ──► POST /webhooks/providers/<slug>   (corps BRUT, hors de /api)   │
       │             1. le SEGMENT désigne le fournisseur                          │
       │             2. l'ENVIRONNEMENT est celui de l'instance                    │
       │             3. le BINDING autorise la suite  ← jamais le corps            │
       │             4. la SIGNATURE est vérifiée sur les octets                   │
       │             5. l'INDEX UNIQUE tranche l'idempotence                       │
       │             6. l'événement est journalisé                                 │
       │                                                                          │
       └── FIN DE L5. Le dispatch vers une capacité projet est le point d'accroche │
           de L6/L7/L8, et il est volontairement vide.                             │
```

---

## 3. Pourquoi centraliser — l'argument Stripe

Stripe plafonne à **16 endpoints webhook par compte**. Aujourd'hui, chaque
instance de projet enregistre le sien sur le compte partagé : au-delà de
~16 instances, la création échoue, et elle échoue au pire moment — pendant un
déploiement.

La centralisation supprime le problème plutôt que de le repousser :

> **un endpoint Panel par compte fournisseur et par environnement**,
> quel que soit le nombre de projets.

Cette règle n'est pas une intention, c'est un **index unique** sur
`(provider, environment)` dans `PanelIntegratedApiWebhookBinding`. Deux
réconciliations concurrentes ne peuvent donc pas produire deux endpoints.

Le plafond est par ailleurs **déclaré** dans le registre
(`remoteEndpointLimit: 16`) et vérifié en **préflight** : si le compte est déjà
saturé, la création est refusée *avant* d'être tentée, avec le code
`WEBHOOK_REMOTE_LIMIT_REACHED` — pas une erreur opaque du fournisseur.

---

## 4. Le registre — capacités, pas `if/else`

`services/webhooks/webhookRegistry.js` décrit chaque fournisseur par des
**champs**, consommés à l'identique par le réconciliateur, l'endpoint entrant
et l'écran :

| Fournisseur | Webhook | Signature | Secret | Environnements |
|---|---|---|---|---|
| **Stripe** | oui | HMAC-SHA256 (`Stripe-Signature`, horodatage signé) | rendu **à la création seulement** | cloisonnés par la clé (`sk_test_`/`sk_live_`) |
| **Brevo** | oui | **aucune** — jeton partagé `Authorization: Bearer` | **posé par nous** | deux comptes distincts |
| **Yousign** | oui | HMAC-SHA256 du corps | rendu **à la création seulement** | deux hôtes, deux clés, drapeau `sandbox` |
| **Hostinger** | **non** | — | — | — |

Trois conséquences directes de ce tableau :

1. **Brevo n'est jamais « prouvé ».** Le jeton authentifie le porteur, il ne
   dit rien du corps reçu. Le code porte cette nuance jusqu'en base
   (`signatureVerified`) et jusqu'à l'écran. Prétendre à une garantie qu'on n'a
   pas est pire que ne pas l'avoir.
2. **Stripe et Yousign : un secret perdu ne se récupère pas.** La seule
   réparation honnête est de recréer *notre* endpoint pour en obtenir un neuf —
   dans l'ordre créer → vérifier → retirer, pour ne jamais laisser de fenêtre
   sans écoute.
3. **Hostinger est déclaré `supported: false`**, avec sa raison. Il n'a ni
   binding, ni segment de callback, ni code mort. Une absence se confondrait
   avec un oubli.

L'alignement avec `providerRegistry.js` (`supportsWebhookReconciliation`,
`webhookSecretReturnedAtCreationOnly`, existence des rôles de credentials) est
vérifié **à l'import** : une contradiction arrête le processus au démarrage,
là où elle est lisible.

---

## 5. La callback

Une seule fabrique : `services/webhooks/webhookCallback.js`, qui dérive
l'adresse de `resolveBackendUrl()` — la configuration canonique du Panel, déjà
soumise à la règle de priorité (configuration système → `PUBLIC_URL` → défaut
local) et au refus des adresses locales en PROD.

```
<backendUrl canonique>/webhooks/providers/<slug>
```

**Jamais** : un domaine codé en dur, un `req.headers.host`, une URL dérivée du
nom d'un projet. Une callback est une adresse qu'on **donne** à un tiers : s'il
l'apprend fausse, il l'appellera fausse pendant des mois, et l'erreur ne se
verra que dans le silence — la panne la plus longue à diagnostiquer.

**Fail closed sur l'environnement.** Une instance TEST ne peut pas fabriquer la
callback PROD : elle n'a pas l'adresse publique de l'autre instance, et
l'inventer livrerait des événements de production à une recette. La demande est
**refusée** (`WEBHOOK_CALLBACK_ENVIRONMENT_MISMATCH`, 409), jamais approximée.

---

## 6. Appartenance — la règle qui protège les autres systèmes

Un compte fournisseur est **partagé**. Le même compte Stripe sert le Panel, les
projets déployés, peut-être un outil comptable, peut-être une intégration posée
à la main il y a deux ans.

> **On ne supprime que ce qu'on peut prouver avoir créé.**

Trois degrés, un seul donne le droit de supprimer :

| Degré | Reconnaissance | Suppression |
|---|---|---|
| `OWNED` | la description porte **notre jeton**, ou l'identifiant est celui qu'on a persisté | autorisée |
| `PANEL_PEER` | préfixe canonique d'un Panel, **autre** jeton (recette, autre client, ancienne installation) | **jamais** |
| `FOREIGN` | rien ne le rattache à nous | **jamais** |

Le préfixe `PANEL_CONTROL_PLANE_<PROVIDER>_<ENV>` **déclare** une intention ; il
ne prouve rien — un autre Panel écrirait le même. C'est le `ownershipToken`
(UUID frappé par nous, persisté dans le binding, posé dans la description) qui
**prouve**.

Ce jeton est écrit **avant** le premier appel de création. Un processus tué
entre les deux laisse un endpoint que le passage suivant reconnaît comme le
sien — au lieu de le prendre pour un endpoint tiers et d'en créer un second à
côté.

---

## 7. États

| État | Sens |
|---|---|
| `UNSUPPORTED` | le fournisseur n'a pas de webhook. Aucun binding. |
| `PENDING` | un prérequis manque (clé d'API, adresse publique). **Ce n'est pas une panne** : peindre en rouge un Panel qu'on vient d'installer apprend à ignorer le rouge. |
| `RECONCILING` | persisté **avant** les appels distants. Le lire au repos signale une réconciliation interrompue. |
| `READY` | l'observé correspond au désiré, et le secret est en place. |
| `DRIFTED` | l'endpoint existe mais diverge (URL, événements, désactivé, absent). |
| `WARNING` | utilisable, mais quelque chose mérite un regard (secret absent). |
| `ERROR` | on n'a **pas pu savoir** : fournisseur injoignable, clé refusée, plafond. |

Un identifiant de webhook présent en base **ne vaut jamais** `READY`. Il prouve
qu'on a créé un endpoint un jour ; pas qu'il existe encore, ni qu'il pointe où
il faut, ni qu'on sait vérifier ce qu'il envoie.

### Codes de diagnostic

`WEBHOOK_UNSUPPORTED` · `WEBHOOK_CREDENTIALS_MISSING` ·
`WEBHOOK_CALLBACK_NOT_PUBLIC` · `WEBHOOK_CALLBACK_ENVIRONMENT_MISMATCH` ·
`WEBHOOK_CALLBACK_MISMATCH` · `WEBHOOK_REMOTE_UNREACHABLE` ·
`WEBHOOK_AUTH_INVALID` · `WEBHOOK_REMOTE_ERROR` ·
`WEBHOOK_REMOTE_LIMIT_REACHED` · `WEBHOOK_DRIFT` ·
`WEBHOOK_SIGNATURE_CONFIGURATION_INVALID` · `WEBHOOK_SIGNATURE_REJECTED` ·
`WEBHOOK_BINDING_UNKNOWN` · `WEBHOOK_PROVIDER_UNKNOWN` ·
`WEBHOOK_RECONCILE_INTERRUPTED`

`WEBHOOK_REMOTE_UNREACHABLE` et `WEBHOOK_AUTH_INVALID` sont distincts et le
resteront : le premier se répare en attendant, le second en changeant une clé.
Les confondre envoie un exploitant régénérer une clé qui n'avait rien.

---

## 8. Politique d'échec

> **Un webhook ne fait jamais échouer un déploiement.** `blocksDeployment()`
> rend `false`, et un test le vérifie.

Un fournisseur momentanément indisponible ne doit pas empêcher une release
valide ; la réconciliation est idempotente et repassera. Mais « ne bloque pas »
n'est pas « on s'en fiche » — la **gravité** module l'alerte :

| Fournisseur | Gravité en échec | Pourquoi |
|---|---|---|
| **Stripe** | `DEPLOYED_WITH_WARNING` | un paiement dont le webhook se perd laisse un contrat non activé et un client débité. |
| **Yousign** | `DEPLOYED_WITH_WARNING` | une signature dont l'événement se perd bloque un contrat sans trace. |
| **Brevo** | `WARNING` | perdre un événement de délivrabilité dégrade le suivi, jamais un état métier. |
| **Hostinger** | — | sans objet. |

### 8.1 Quand la réconciliation se déclenche — et pourquoi pas ailleurs

Trois déclencheurs, et chacun correspond à une dérive réelle :

1. **Au démarrage**, après l'ouverture du port et détachée. Enregistrer une
   callback avant d'écouter publierait une adresse morte, et certains
   fournisseurs désactivent un endpoint qui échoue trop souvent.
2. **Quand l'adresse publique du Panel change** — `PUT /api/system-configuration/network`,
   et uniquement si `backendUrl` a réellement changé.
3. **Quand un identifiant humain change pour un fournisseur à webhook** —
   `saveCredentialSet()`, mais seulement pour le monde que sert cette
   instance, et jamais pour un rôle `autoManaged`.

Le second existe parce que c'est le cas où la callback devient obsolète sans
redémarrage. Le troisième existe pour l'incident symétrique : une clé d'API
nouvellement saisie rend soudain le provisioning possible, mais aucun boot ni
changement d'adresse ne viendra forcément relancer la réconciliation. Sans ce
crochet, l'état reste `PENDING` sur une preuve périmée — exactement le faux
diagnostic qui a bloqué Brevo en août 2026.

**Pourquoi PAS de crochet dans le pipeline de déploiement.** Ce pipeline
déploie des *projets* ; son étape `runtimeConfig` écrit les URLs de la
*destination*, qui n'ont aucun rapport avec la callback du Panel. Un crochet
posé là se serait déclenché à chaque mise en ligne de projet, sans raison. Et
lorsque le Panel se déploie **lui-même**, il redémarre : le déclencheur nº1
couvre déjà ce cas. Ajouter une troisième exécution n'aurait rien couvert de
plus, tout en donnant l'illusion d'une garantie supplémentaire.

Les crochets nº2 et nº3 sont détachés : un fournisseur indisponible ne doit
pas empêcher un opérateur de corriger l'adresse de son Panel, ni d'enregistrer
une clé d'API valide — ce serait refuser la réparation à cause de la panne
qu'elle répare.

### 8.1 bis Migration de binding — l’héritage L6.3A

Le lot L6.3A a élargi l'unicité du binding à
`(provider, environment, destination, projectId)`. Une base déjà créée avec
l'ancien index `uniq_provider_environment` peut donc porter deux traces du même
monde :

- un binding legacy sans `destination`, hérité d'avant L6.3A ;
- un binding `PANEL` explicite, créé par le moteur actuel.

La première réconciliation retire l'ancien index, migre un binding legacy vers
`destination=PANEL` s'il est seul, ou le supprime s'il double déjà un binding
explicite. Sans cette étape, une base historique peut accepter le provisioning
réel tout en laissant l'écran et l'ingest relire le document périmé.

### 8.2 Joignabilité — le seul test possible

Aucun des trois fournisseurs n'offre d'API d'événement de test. La seule sonde
disponible est **la nôtre** : le réconciliateur appelle
`<callback>/health` et enregistre `callbackReachable`.

C'est un **constat, jamais un verdict** : il ne change pas le statut du
binding. Un réseau qui hoquette n'est pas une dérive de configuration, et
confondre les deux ferait chercher au mauvais endroit. Mais sans lui, « aucun
événement reçu » et « le tunnel est tombé » se ressemblent trop.

---

## 9. Réception et idempotence

L'endpoint entrant est monté **avant `express.json()`**, avec `express.raw()`.
Ce n'est pas un détail d'implémentation : une signature HMAC porte sur les
**octets** reçus, et un corps parsé puis re-sérialisé diffère dès le premier
espace. La vérification échouerait sur des messages authentiques — et l'issue
de ce genre d'histoire est toujours « on désactive la vérification en
attendant ».

**Le corps ne décide de rien.** Ni le projet destinataire, ni l'environnement,
ni le fournisseur. Un `projectId` glissé dans une charge utile ne désigne
personne : ce serait le chemin par lequel un tiers ferait router ses événements
vers le projet de son choix. Le routage vient du **binding**, c'est-à-dire d'un
enregistrement que le Panel a écrit lui-même en réconciliant.

**L'unicité est portée par l'index**, pas par un `findOne` préalable : deux
livraisons concurrentes du même événement passeraient toutes deux un test
d'existence. Seule la contrainte `(provider, environment, providerEventId)`
tranche, et son refus **est** la preuve du doublon.

Mais l'unicité n'est pas l'idempotence, et les confondre a coûté cher — voir
§9 bis.

Un doublon répond **200**. Le fournisseur a fait son travail, nous aussi ;
répondre autre chose déclencherait un rejeu en boucle.

**Aucun corps d'événement n'est conservé** — seulement son empreinte. Un
webhook porte des données personnelles ; les garder exigerait une durée de
rétention, une politique d'effacement et une raison. Nous n'en avons pas.

---

## 9 bis. UNE LIGNE QUI EXISTE N'EST PAS UN TRAVAIL FAIT

### Le défaut, et il ne se voyait nulle part

La ligne était écrite **avant** les effets métier, et son refus en `E11000`
valait « doublon ». La séquence tenait alors en cinq flèches :

```
webhook  →  ligne RECEIVED écrite  →  CRASH du process
         →  Stripe rejoue          →  E11000  →  « doublon », HTTP 200
         →  l'effet métier n'existera JAMAIS
```

La ligne prouvait qu'on avait **vu** l'événement, pas qu'on l'avait
**appliqué**. Et le rejeu du fournisseur — la seule réparation qui existe, et
elle est gratuite — était refusé au nom d'une idempotence qui ne protégeait
plus rien. Pire : refusé **en silence**, avec un 200.

    ROW EXISTS  ≠  EVENT PROCESSED

### La machine d'état

```
             ┌──────────── réclamation atomique ────────────┐
             ▼                                              │
RECEIVED ──────────▶ PROCESSING (sous bail) ──────▶ PROCESSED    terminal
 (hérité)                    │              ──────▶ IGNORED      terminal
                             │              ──────▶ FAILED       reprenable
                             │              ──────▶ DEAD_LETTER  terminal, supervisé
                             │
                             └── bail EXPIRÉ ──▶ reprenable
```

Une ligne **naît `PROCESSING`** : il n'existe aucune fenêtre où elle existe sans
bail. `RECEIVED` ne subsiste que pour les documents antérieurs à ce lot, et le
balayage les traite comme abandonnés dès qu'ils ont vieilli.

| état | un rejeu fait quoi ? |
|---|---|
| `PROCESSED` | rien — **le seul doublon terminal** |
| `IGNORED` | rien — il n'y avait rien à faire |
| `DEAD_LETTER` | rien — on a renoncé, et on l'a dit |
| `PROCESSING`, bail **valide** | rien — quelqu'un travaille (`IN_FLIGHT`) |
| `PROCESSING`, bail **expiré** | **reprend** |
| `RECEIVED` ancien | **reprend** |
| `FAILED` reprenable | **reprend** |

`IN_FLIGHT` et « déjà traité » se ressemblent en HTTP et ne se ressemblent pas
du tout dans un incident : le premier peut encore échouer. Les deux sont donc
nommés séparément.

### Le bail

```
leaseOwner          hôte:pid:NONCE-DE-DÉMARRAGE
processingStartedAt depuis quand
leaseExpiresAt      au-delà, le travail est réputé ABANDONNÉ
processingAttempts  nombre de RÉCLAMATIONS, jamais de livraisons
lastError           code · message tronqué · retryable · instant
```

Le **nonce de démarrage** est la seule partie sérieuse de l'identité : un
processus redémarré peut réutiliser un pid sur le même hôte, et se croirait
alors titulaire d'un bail qu'il a perdu en mourant.

**Aucun verrou mémoire.** Un `Set` de clés en cours n'aurait protégé qu'à
l'intérieur d'un processus, tout en donnant l'illusion d'une garantie
multi-processus. Le Panel tourne derrière une API, un ordonnanceur et un worker
détaché : la réclamation est une écriture conditionnelle en base, et rien
d'autre.

### La réclamation est atomique

```js
create({...clé, status: PROCESSING, bail, attempts: 1})   // E11000 → c'est un rejeu
findOneAndUpdate(                                          // …alors on tente la REPRISE
  {...clé, $or: [RECEIVED ancien, FAILED reprenable, PROCESSING bail expiré]},
  {$set: {status: PROCESSING, bail}, $inc: {attempts: 1}},
)
```

Deux écritures, pas un `upsert` : un `upsert` ne peut pas porter un filtre
d'état — le filtre doit aussi décrire le document à créer — et aurait donc
écrasé le bail d'un processus au travail. La seconde écriture ne coûte que sur
le chemin du rejeu.

Si le `findOneAndUpdate` ne rend rien, **c'est la décision** : l'événement est
conclu, ou un bail court. La lecture qui suit ne sert qu'à dire *lequel des
deux*, pour le diagnostic — jamais à décider.

La conclusion est gardée par `leaseOwner` : un traitement qui a dépassé son bail
et dont l'événement a été repris ailleurs **n'écrit rien**. Sans ce garde, il
effacerait le travail de son successeur et rendrait terminal un événement que
personne n'a fini.

### Les seuils, et pourquoi ceux-là

| réglage | défaut | variable |
|---|---|---|
| durée du bail | 120 s | `WEBHOOK_LEASE_TTL_MS` |
| âge d'un `RECEIVED` réputé abandonné | 120 s | `WEBHOOK_STALE_RECEIVED_MS` |
| tentatives avant `DEAD_LETTER` | 5 | `WEBHOOK_MAX_ATTEMPTS` |

Mesure des traitements légitimes : un `invoice.paid` enchaîne appartenance,
adoption éventuelle, normalisation, un aller-retour Stripe pour la
`balance_transaction` (les frais réels, jamais calculés), l'écriture du fait
puis celle du mouvement. Les invocations de capacité mesurées en base tiennent
entre **150 et 250 ms** ; le pire cas plausible reste sous la seconde.

120 s, c'est donc environ **deux ordres de grandeur** au-dessus du pire cas
observé, et bien en dessous du premier rejeu utile de Stripe. Les deux bornes
comptent :

- **trop court** → on reprend un travail qui tourne encore ; l'idempotence
  métier tiendrait, mais on l'aurait sollicitée pour rien ;
- **trop long** → un `subscription.deleted` abandonné reste invisible des
  minutes durant : un site servi alors que le contrat est fini.

### Reprenable ou terminal

Une seule question : **une nouvelle tentative a-t-elle une chance de donner un
résultat différent ?**

| REPRENABLE | TERMINAL |
|---|---|
| panne de base, dépendance injoignable | corps illisible, schéma incompatible |
| délai dépassé, redémarrage | signature refusée |
| erreur de transport marquée `retryable` | appartenance définitivement impossible |
| **erreur inconnue** (défaut) | événement purgé chez le fournisseur (404) |

Le défaut est « reprenable », et c'est délibéré : une erreur inconnue est plus
souvent une panne qu'un vice de forme. Se tromper vers la reprise coûte quelques
tentatives et finit en `DEAD_LETTER` supervisé ; se tromper vers le terminal
perd un fait financier en silence. Les deux erreurs n'ont pas le même prix.

### Ce qui a échoué n'est plus absorbé

Les effets métier restent **best-effort vis-à-vis d'HTTP** — répondre 500 à
Stripe déclencherait une tempête de rejeux, et c'est toujours vrai. Mais « ne
pas répondre 500 » ne veut pas dire « oublier » : les échecs étaient absorbés
dans un `.catch` qui rendait `null`, et l'événement finissait comme s'il avait
été traité. Ils sont désormais **retenus**, et l'événement se conclut en
`FAILED` — donc reprenable, au prochain rejeu comme au prochain démarrage.

### La reprise au démarrage, et d'où vient le corps

Deux filets, et il en faut deux :

1. **le rejeu du fournisseur** — un processus tué n'a répondu à personne, Stripe
   voit un échec et rejoue. C'est le filet principal, il est gratuit, il apporte
   le corps, et il couvre le cas nominal du crash ;
2. **le balayage d'amorçage** — il couvre ce que le rejeu ne couvre pas : les
   événements pour lesquels nous avions déjà répondu 200 avant de perdre
   l'effet. Stripe ne les rejouera jamais.

Le corps n'étant pas conservé, la reprise **relit l'événement à la source**
(`GET /v1/events/{id}`, conservé 30 jours par Stripe). Ce qui est rejoué est ce
que Stripe a émis, pas une reconstitution à partir de nos notes — et la
décision de ne rien conserver reste intacte. Au-delà de 30 jours, la réponse est
un 404 : c'est **terminal**, et le dire vaut mieux que réessayer un identifiant
qui ne reviendra jamais.

Le balayage tourne **avant les ordonnanceurs de fond**. `startRecurringCostScheduler()`
lit le registre financier : le laisser partir avant la reprise lui ferait
calculer des totaux sur un livret dont il manque des revenus, et ce calcul-là ne
se refait pas tout seul.

**Un seul parcours métier.** `applyProviderEventEffects` est la fonction que la
réception appelle *aussi*. Une seconde implémentation « pour la reprise » aurait
divergé en silence, et c'est celle qu'on ne relit jamais qui aurait vieilli.

### La barrière finale reste l'idempotence métier

Le bail réduit les retraitements ; il ne les supprime pas. Une reprise rejoue
par construction ce qui a peut-être déjà été appliqué. La dernière ligne de
défense n'est donc pas l'ordonnancement, c'est **l'identité canonique contrainte
en base** :

```
PanelProviderRevenueFact     uniq(provider, environment, objectType, objectId)
PanelFinancialTransaction    uniq(provenance.provider, .environment,
                                  .externalKind, .externalId)
```

Un même objet Stripe ne peut produire qu'un fait et qu'un mouvement, quel que
soit le nombre d'événements qui l'annoncent, de rejeux, de processus concurrents
ou de redémarrages. Le second écrivain reçoit un `E11000`, et ce refus **est**
la garantie.

### Les lignes écrites avant le bail — classées, jamais rejouées en masse

La machine dit : « un `RECEIVED` ancien n'a jamais été réclamé, donc il est
reprenable ». C'est vrai d'une ligne qu'elle a écrite — une telle ligne naît
`PROCESSING`. **C'est faux de l'historique** : sous l'ancien contrat, `RECEIVED`
était l'état de FIN.

Mesuré au premier démarrage après déploiement — le balayage a déclaré abandonné
tout l'historique et est parti le rejouer :

```
BREVO/WEBHOOK_REPLAY_UNSUPPORTED    = 30   (déjà 4 tentatives)
OPENSIGN/WEBHOOK_REPLAY_UNSUPPORTED =  9
```

Trente-neuf événements parfaitement traités marchaient vers `DEAD_LETTER`, et la
supervision allait annoncer trente-neuf incidents qui n'existaient pas. Une file
d'alerte qu'on apprend à ignorer ne protège plus de rien.

**Deux corrections, et elles sont distinctes.**

1. **Le balayage ne réclame que ce qu'il peut rejouer.** Brevo et OpenSign
   n'exposent pas leurs événements en lecture : pour eux, une ligne abandonnée
   n'appelle aucun geste de notre part, et leur propre mécanique de rejeu est la
   seule réparation qui existe. Le filtre est posé sur le balayage lui-même — on
   ne réclame pas un travail qu'on ne peut pas faire.

2. **Une migration additive classe les lignes héritées**, une fois
   (`webhookEventMigration.js`, avant le balayage au démarrage) :

| ligne héritée | classée |
|---|---|
| `RECEIVED`, sans compteur ni bail | → `PROCESSED`, marquée `LEGACY_RECEIVED_BEFORE_LEASE` |
| `PROCESSED` | inchangée — reste terminale |
| `FAILED` avec `WEBHOOK_REPLAY_UNSUPPORTED` | → `PROCESSED` (réclamée à tort par le balayage fautif) |

**Pourquoi classer plutôt que rejouer** — parce qu'on n'a aucune preuve dans un
sens ni dans l'autre, et que les deux erreurs n'ont pas le même prix :

- *les rejouer* → réexécuter des mois d'événements, réécrire des appartenances,
  réémettre des acheminements vers les projets. Un rattrapage dont personne ne
  peut prédire la portée n'est pas un rattrapage, c'est un incident ;
- *les classer* → on honore la sémantique sous laquelle elles ont été écrites, et
  **on l'écrit** : le marqueur reste en base. La garantie neuve s'applique à
  partir de là.

Aucune ligne n'est supprimée. La migration est idempotente : un second passage
n'en trouve aucune, puisque celles qu'elle a traitées ne sont plus `RECEIVED`.

Côté **SB Auto**, la question ne se pose pas : ses lignes héritées portent
`PROCESSED` ou `IGNORED` — terminales dans la machine neuve — et son ancien
`PENDING` signifiait déjà « commencé, pas fini ». Le reprendre est donc exact,
pas une réinterprétation.

### ACCUSER STRIPE N'EST PAS AVOIR LIVRÉ LE PROJET

C'est la phrase la plus importante de tout ce chapitre, et elle tient en deux
lignes :

```
Panel répond 200 à Stripe   =  « le Panel prend la RESPONSABILITÉ du fait »
                            ≠  « le projet l'a déjà appliqué »
```

Le trajet complet compte donc **deux accusés**, et ils n'ont ni le même
émetteur, ni la même signification :

```
Stripe  ──webhook──▶  Panel   ──200──▶  Stripe      1er accusé : je le prends
                        │
                        ▼
                 fait canonique durable  (journal, seq ordonnée)
                        │
                        ▼
Panel   ──livraison──▶  Projet  ──curseur──▶  Panel  2e accusé : je l'ai appliqué
```

Entre les deux, **le Panel reste responsable**. Un projet éteint, un réseau
coupé, un Panel redémarré : l'écriture est au journal, elle y reste, et le
projet la reprendra. Le fournisseur, lui, n'a plus rien à rejouer — et n'a plus
à le faire.

### Le curseur EST l'accusé — à condition qu'il ne mente pas

Le projet tire les écritures du journal par pages et persiste sa position. Il
déclare cette position au Panel à chaque battement (`bridgeStats.consumption`).
Le Panel compare sa propre séquence à ce curseur : la différence est le
**retard**, et ce retard a un âge.

Tout repose donc sur une propriété du curseur : **il ne dépasse jamais une
écriture non appliquée.**

Elle n'était pas tenue. Le projet appliquait une page et écrivait le curseur à
la fin, quoi qu'il arrive — une écriture dont l'applicateur échouait était
comptée `skipped`, un incident était journalisé, et le curseur passait
par-dessus. Le commentaire d'origine le disait sans détour : *« cette écriture
ne sera PAS relivrée par le Panel »*.

Ce n'était donc pas seulement une perte : c'était un **accusé mensonger**. Le
Panel voyait un retard nul, sa fiche restait verte, et le fait n'existait nulle
part. Toute la mesure de retard ci-dessus s'appuyait sur une valeur fausse.

Depuis, le curseur est **retenu** sur la première écriture non appliquée. La
page entière est retirée au cycle suivant ; les écritures déjà appliquées de
cette page sont écartées par la fenêtre d'idempotence, qui existe exactement
pour ce cas.

### Et l'écriture qu'aucune tentative ne passera ?

Elle bloquerait le flux à vie, et tout ce qui la suit avec elle. Après cinq
tentatives (`BRIDGE_MAX_APPLY_ATTEMPTS`), elle est **garée** en lettre morte
durable — type, identifiant, motif, tentatives, date, **jamais la charge
utile** — et le curseur passe.

Renoncer en le disant n'est pas perdre en silence. Une écriture garée est
passée SOUS le curseur : le calcul de retard ne la verra plus jamais. Le projet
déclare donc son compte au battement (`parkedChanges`, contrat 1.12.0), et le
Panel en fait un signal de supervision à part entière — seuil **1**, parce
qu'un renoncement n'a aucun état normal.

Une écriture **illisible** est garée immédiatement : aucune tentative ne la
rendra conforme, et cinq cycles perdus à le prouver ne servent personne.

### Ce qui est durable de bout en bout, et ce qui ne l'est pas

| | durable | pourquoi |
|---|---|---|
| journal du Panel (`PanelSyncJournalEntry`) | **oui** | la source de vérité, ordonnée et rejouable |
| curseur du projet | **oui** | après un arrêt, le tirage reprend où il s'était arrêté |
| compteurs d'échec par écriture | **oui** | sinon le plafond se remet à zéro à chaque redémarrage, et une écriture toxique bloque à vie |
| lettre morte | **oui** | un incident se relit |
| livraison immédiate (push) | **non, et c'est voulu** | un accélérateur, jamais la garantie — le journal est le filet |
| idempotence des livraisons poussées | **oui** depuis ce lot | c'était une `Map` mémoire ; un redémarrage la vidait, et la relivraison rendait `APPLIED` au lieu de `DUPLICATE` |

### Le projet ne détient aucune clé de fournisseur

Il ne reçoit ni identifiant Stripe, ni autorité fournisseur, ni droit de relire
Stripe. Il reçoit un **fait canonique métier** — jamais la charge utile brute du
webhook. C'est aussi pourquoi la reprise d'un événement abandonné est le travail
du Panel, et de lui seul : c'est lui qui détient la clé, et lui qui peut relire
l'événement à la source.

### La supervision, parce qu'un abandon silencieux est le même défaut

| type | quand | sévérité |
|---|---|---|
| `WEBHOOK_PROCESSING_FAILED` | une tentative a échoué, une reprise viendra | WARNING |
| `WEBHOOK_PROCESSING_STUCK` | `DEAD_LETTER` — on a renoncé | ERROR |

Deux types plutôt qu'un seul avec deux sévérités : on ne les relit pas pour la
même raison. Le premier documente une turbulence ; le second est une **file de
travail humaine**, et devoir la reconstituer en filtrant sur une sévérité
revient à ne pas l'avoir.

Ni corps, ni secret : identifiant, type, tentatives, âge, motif tronqué — de
quoi agir, rien de plus.

---

## 10. Secrets

Le secret vit dans le **coffre du Panel**
(`PanelIntegratedApiCredentialSet`, rôle `webhookSecret`, chiffré AES-256-GCM),
et nulle part ailleurs. Jamais dans un journal, une réponse d'API, le pont, un
diagnostic, ni le binding — qui n'en porte qu'un **booléen**.

L'écriture d'un secret de webhook ne passe pas par `saveCredentialSet()` : ce
rôle est `autoManaged` (rempli par la machine), et la porte des humains remet à
zéro la preuve de validation à chaque passage. Capturer un `whsec_…` ne dit rien
sur la validité de la `sk_live_…` qui l'a créé ; faire retomber au rouge un
fournisseur valide à chaque réconciliation serait faux.

`safeMessage()` est une **seconde** barrière : elle retire les motifs de clés
connus (`sk_*`, `whsec_*`, `pk_*`, `xkeysib-*`, `Bearer …`) de tout message
avant journalisation. La première barrière reste de ne jamais y mettre un
secret.

### 10.1 Rotation — changer de secret sans perdre un événement

Le jour où le secret change, des événements sont **déjà en vol** : produits par
le fournisseur avant la rotation, livrés après, signés de l'ancien secret. Les
refuser en 401 les perd **définitivement** — aucun fournisseur ne rejoue un
événement qu'il croit livré-et-refusé pour de bon.

D'où un mécanisme **générique**, et non un cas Brevo :

| Élément | Où il vit | Pourquoi là |
|---|---|---|
| secret courant | coffre, rôle `webhookSecret` | inchangé depuis L1 |
| secret retiré | coffre, rôle `webhookSecretPrevious` (**`internal`**) | même protection que le courant ; `internal` = il n'apparaît dans aucun formulaire ni aucune réponse d'API — pas même comme « non configuré » |
| date de rotation | **binding**, `secretRotatedAt` | c'est une date, pas un secret : la mêler au coffre obligerait à déchiffrer pour lire un horodatage |
| durée de la fenêtre | **capacité**, `secretRotationWindowMs` | Brevo : la valeur de l'audit L8 (15 min). Défaut identique ailleurs, pour la même raison |

`loadVerificationSecrets()` rend `[courant]`, ou `[courant, retiré]` tant que
`now - secretRotatedAt < secretRotationWindowMs`. **Fenêtre fermée par
défaut** : sans horodatage, un seul secret est accepté.

Deux chemins de rotation, dictés par le fournisseur :

- **`CALLER_SUPPLIED` (Brevo)** — on pose un jeton neuf par un `update`, sans
  recréer l'endpoint. L'ordre est imposé par ce qu'on ne veut pas perdre : le
  fournisseur accepte d'abord, le coffre bascule ensuite. Si l'appel échoue,
  rien n'a bougé et l'ancien jeton continue de vérifier.
- **`AT_CREATION_ONLY` (Stripe, Yousign)** — le secret change en recréant
  l'endpoint. Le nouveau et l'ancien portent **la même URL** : entre la mise en
  coffre du nouveau secret et la disparition de l'ancien endpoint, des
  événements signés de l'ancien secret arrivent encore. La fenêtre les sauve.

Le secret retiré est **effacé** dès la fenêtre close, par le passage régulier du
réconciliateur — pas par une tâche planifiée de plus. Ce qu'on n'accepte plus
n'a aucune raison de rester en base. Voir §12.

---

## 11. Fichiers

| Fichier | Rôle |
|---|---|
| `services/webhooks/webhookRegistry.js` | capacités code-first, alignées sur `providerRegistry` |
| `services/webhooks/webhookCallback.js` | fabrique unique d'URL, fail closed sur l'environnement |
| `services/webhooks/webhookOwnership.js` | preuve d'appartenance, droit de suppression |
| `services/webhooks/providerWebhookAdapters.js` | pilotes Stripe / Brevo / Yousign — **CRUD d'endpoint uniquement** |
| `services/webhooks/webhookSecrets.js` | coffre, capture, génération de jeton partagé |
| `services/webhooks/webhookSignature.js` | vérification par schéma, identité d'événement |
| `services/webhooks/webhookReconciler.js` | désiré vs observé, dérive, convergence |
| `services/webhooks/webhookIngest.js` | réception, idempotence |
services/webhooks/webhookLease.js                le BAIL — réclamation atomique, classification, plafond
services/webhooks/webhookRecovery.js             la REPRISE — relit l’événement à la source, rejoue les mêmes effets
services/webhooks/webhookSupervision.js          ce qu’on DIT quand un événement ne s’applique pas
services/webhooks/webhookEventMigration.js       les lignes d’avant le bail, classées une fois
| `services/webhooks/webhookDiagnostics.js` | états, codes, gravité, masquage |
| `models/PanelIntegratedApiWebhookBinding.model.js` | état du webhook, index unique `(provider, environment)` |
| `models/PanelProviderWebhookEvent.model.js` | registre de réception, index unique d'idempotence |
| `routes/providerWebhooks.routes.js` | surface **publique**, corps brut |
| `routes/webhookControlPlane.routes.js` | surface **interne** : lecture ouverte, écriture DEV |

---

## 12. Ce que L5 ne fait pas — et ce que les lots suivants trouveront

L5 est une **fondation**. Rien du métier Stripe, Brevo ou Yousign n'a été migré
au passage, et un test le vérifie (`22b`).

Points d'accroche laissés explicitement vides :

- **Dispatch** — `webhookIngest.js`, après l'étape 6. Un événement vérifié,
  unique et daté attend un consommateur. La table de correspondance
  (`checkout.session.completed → PAYMENT_SUCCEEDED`) appartient à L6.
- **Coexistence** — les endpoints de SB Auto restent en place et continuent de
  recevoir. Deux endpoints coexistent **volontairement** pendant L6/L7/L8. Le
  retrait de celui du projet est la dernière étape de son lot, pas de celui-ci.

---

## 13. Le contrat avec le lot Brevo (L8)

L8 possède le fournisseur, L5 possède le moteur. La frontière est un module
déclaratif publié par L8 — `integratedApi/brevo/brevoEventMapping.js` — que L5
**importe** et ne recopie jamais. Redéclarer ces valeurs créerait deux vérités
destinées à diverger, et c'est le webhook qui en paierait le prix.

Les douze exigences de `BREVO_CONTROL_PLANE.md §9.1`, et où elles sont tenues :

| # | Exigence | Où |
|---|---|---|
| 1 | comparaison canonique par inclusion | capacité `compareEvents` → `compareSubscribedEvents()` |
| 2 | `sent` jamais souscrit | `desiredEvents` = `SUBSCRIBED_EVENTS` (L8) |
| 3 | les 13 événements | idem — aucune liste retapée |
| 4 | liste vide déguisée en 404 | capacité `emptyListSignals`, consommée par le pilote |
| 5 | filtre `?type=transactional` | pilote Brevo |
| 6 | fenêtre de rotation | §10.1, fenêtre = `BREVO_WEBHOOK_FACTS.rotationWindowMs` |
| 7 | clé d'idempotence composée | capacité `eventIdentity` → `buildEventIdentity()` |
| 8 | quatre champs de date, deux unités | `parseEventDate()` (L8) |
| 9 | « authentifié », jamais « vérifié » | `signatureProves: false`, repris tel quel à l'écran |
| 10 | sonde de joignabilité | §8.2 |
| 11 | `message-id` sous ses deux graphies | `normalizeProviderMessageId()` (L8), dans la clé |
| 12 | jamais le secret dans l'URL | `auth: {type:'bearer'}`, jamais d'identifiants d'URL |

L'exigence nº11 méritait mieux qu'une case cochée : composer la clé sur la
graphie **brute** faisait qu'un rejeu écrit `abc@bar` au lieu de `<abc@bar>`
produisait une clé différente — donc un événement « neuf », donc l'effet
appliqué deux fois. Toute l'idempotence Brevo tenait à ce détail de format.
