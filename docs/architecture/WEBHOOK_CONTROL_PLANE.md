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

La réconciliation est déclenchée **après** l'ouverture du port d'écoute, et
**détachée** : enregistrer une callback avant d'écouter publierait une adresse
morte, et certains fournisseurs désactivent un endpoint qui échoue trop souvent.

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

**L'idempotence est portée par l'index unique**, pas par un `findOne`
préalable : deux livraisons concurrentes du même événement passeraient toutes
deux un test d'existence. Seule la contrainte `(provider, environment,
providerEventId)` tranche, et son refus **est** la preuve du doublon.

Un doublon répond **200**. Le fournisseur a fait son travail, nous aussi ;
répondre autre chose déclencherait un rejeu en boucle.

**Aucun corps d'événement n'est conservé** — seulement son empreinte. Un
webhook porte des données personnelles ; les garder exigerait une durée de
rétention, une politique d'effacement et une raison. Nous n'en avons pas.

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

**Rotation.** `verifyWebhookSignature()` accepte une **liste** de secrets
candidats. Elle en contient un aujourd'hui ; la forme prépare la fenêtre de
rotation (accepter l'ancien secret le temps que les événements en vol se
vident) sans changer de signature le jour où on l'ouvrira. Voir §12.

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
- **Rotation de secret** — `loadVerificationSecrets()` rend une liste ; il
  suffira d'y ajouter le secret retiré et sa date de péremption, avec un rôle
  `webhookSecretPrevious` au registre fournisseur.
- **Crochet de déploiement** — `reconcileAllProviderWebhooks()` est appelée au
  démarrage. L'appeler aussi après un déploiement (§8.3 de la roadmap) est une
  ligne à ajouter dans le pipeline, sans changement de contrat.
- **Coexistence** — les endpoints de SB Auto restent en place et continuent de
  recevoir. Deux endpoints coexistent **volontairement** pendant L6/L7/L8. Le
  retrait de celui du projet est la dernière étape de son lot, pas de celui-ci.
