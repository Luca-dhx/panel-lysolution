# IntegratedAPI — Panel comme plan de contrôle des intégrations

> **Statut : L1 et L4 LIVRÉS. Aucun provider migré.**
>
> | | |
> |---|---|
> | Plan de contrôle Panel | **✅ opérationnel** — registre, coffre, validation, écran |
> | Diffusion de secrets sur le pont | **✅ SUPPRIMÉE** — garde structurelle en place |
> | Runtime métier des projets | **inchangé** — SB Auto appelle toujours les fournisseurs directement |
> | Migration des providers | **non commencée** |
> | Doctrine `activeMode` côté projet | **toujours en place** — L2 la révoquera |
>
> ### La doctrine, désormais tenue par le code
>
> ```
> PROVIDER SECRETS NEVER CROSS THE PANEL ↔ PROJECT BRIDGE
>
>   secrets du plan de contrôle   →  restent dans le Panel
>   secrets legacy des projets    →  restent dans le projet, jusqu'à sa migration
>   le pont                       →  données métier, capacités, état — rien d'autre
> ```
>
> Ce document décrit ce qui EXISTE (prouvé par le code, référence à l'appui),
> ce qui est VISÉ, et la route entre les deux. Les sections §1 à §12 décrivent
> l'état AVANT L1 et restent la référence de l'audit ; §13 porte l'avancement
> réel, lot par lot.

---

## 0. Baseline

Relevé au moment de l'audit — les deux dépôts ont des modifications non
committées, sans rapport avec ce chantier.

| Dépôt | Branche | HEAD | Arbre de travail |
|---|---|---|---|
| `Panel` | `feat/generic-deployment-engine` | `518ac79` | 4 fichiers modifiés (`tests/helpers/*`, `tests/payload-drift.check.mjs`), 1 non suivi (`tests/event-driven-system-e2e.test.js`) |
| `SB Auto 06` | `feat/unified-production-baseline` | `ab85e8b` | 12 fichiers modifiés (contrat, uiLive, bridge), 3 non suivis (`services/lifecycle/`, 2 tests) |

Aucun autre dépôt n'entre dans le périmètre : `LYCARZ`,
`ly-solution-carvertical`, `SITE RAUL` et les autres dossiers voisins ne sont
ni appairés ni référencés par le Panel.

---

## 1. Architecture actuelle — ce que le code dit

### 1.1 Il y a DEUX systèmes IntegratedAPI, et ils ne se parlent pas

C'est le fait central de cet audit, et il n'était pas attendu.

```
┌─ PANEL ─────────────────────────────┐      ┌─ SB AUTO 06 ────────────────────────┐
│                                     │      │                                      │
│  PanelIntegratedApi                 │      │  PanelProvidedApi                    │
│  ├── apiId, key, provider (libres)  │      │  ├── credentials rechiffrées         │
│  ├── credentials.TEST / .PROD       │─────▶│  └── LU PAR PERSONNE ✗               │
│  ├── grants[] par projet            │ pont │                                      │
│  └── mode TEST|PROD                 │      │  ────────────────────────────────    │
│                                     │      │                                      │
│  ✗ aucun driver fournisseur         │      │  IntegratedApi  ← LE SYSTÈME RÉEL    │
│  ✗ aucun webhook                    │      │  ├── 4 providers catalogués          │
│  ✗ aucune dépendance Stripe/Brevo   │      │  ├── activeMode choisi par un DEV    │
│                                     │      │  ├── drivers + tests de connexion    │
│                                     │      │  ├── réconciliateur de webhooks      │
│                                     │      │  └── page Manager DEV → Intégrations │
└─────────────────────────────────────┘      └──────────────────────────────────────┘
```

**Preuve que la branche Panel est morte.** `PanelIntegratedApi` déchiffre des
secrets et les pousse sur le pont
([integratedApi.service.js:294-324](../../backend/src/services/company/integratedApi.service.js#L294-L324)).
SB Auto les reçoit, les rechiffre, les range dans `PanelProvidedApi`
([panelConfiguration.service.js:156-204](../../../SB%20Auto%2006/backend/src/services/panelConfiguration/panelConfiguration.service.js#L156-L204))
et expose un lecteur déchiffrant, `getProvidedApiCredentials(key)`. Une
recherche exhaustive sur les deux dépôts montre que **ce lecteur n'a aucun
appelant**. Le seul consommateur de `PanelProvidedApi` est
`listProvidedApis()`, appelé par
[panelBridge.controller.js:65](../../../SB%20Auto%2006/backend/src/controllers/panelBridge.controller.js#L65)
— un inventaire d'affichage, sans valeurs.

> Des secrets fournisseurs traversent aujourd'hui le pont en clair, sont
> persistés côté projet, et **aucun code ne les utilise**. Le risque est réel,
> le bénéfice est nul. C'est le premier point à traiter, et il ne dépend
> d'aucune migration.

### 1.2 Le système réel : `IntegratedApi` côté projet

Un document par fournisseur, deux jeux de credentials chiffrés AES-256-GCM
(`modes.TEST` / `modes.PROD`), un `activeMode`, un état de webhook par mode
([IntegratedApi.model.js](../../../SB%20Auto%2006/backend/src/models/IntegratedApi.model.js)).

La couche de consommation
([integratedApi.service.js](../../../SB%20Auto%2006/backend/src/services/integratedApi.service.js))
est propre : erreurs typées, fail-loud, empreinte de vérification pour prouver
que « vérifié » concerne la clé courante, jamais de secret journalisé.

### 1.3 Ce que le Panel sait déjà faire, et qu'on croyait à construire

Trois briques de la cible existent déjà, testées.

| Brique | État | Preuve |
|---|---|---|
| **Autorité d'environnement** | Livrée | `pairing.bootstrap` refuse `BRIDGE_ENVIRONMENT_MISMATCH` ([pairing.service.js:134](../../backend/src/services/pairing/pairing.service.js#L134)) ; la livraison de sync refuse aussi ([syncDelivery.service.js:211-224](../../backend/src/services/sync/syncDelivery.service.js#L211-L224)) ; couvert par `tests/panel-instance-environment.test.js` |
| **URLs runtime frontend/backend** | Livrée | `frontendUrl` + `backendUrl` dans `SystemConfiguration`, écrites par le déploiement avec relecture de validation ([runtimeConfig.js](../../backend/src/deployment-engine/runtimeConfig.js)), résolues par [networkConfig.service.js](../../backend/src/services/network/networkConfig.service.js), `api.<domaine>` dérivé par `API_SUBDOMAIN` |
| **Coffre chiffré** | Livrée | `panelCrypto` AES-256-GCM, `BRIDGE_ENCRYPTION_KEY` validée au boot, refus de réutiliser `JWT_SECRET` ([env.js](../../backend/src/config/env.js)) |

La **Phase 10** de la mission est donc déjà satisfaite. Rien à concevoir : il
faudra seulement documenter que `backendUrl` est la racine des webhooks.

---

## 2. Inventaire des IntegratedAPI

### 2.1 Providers réellement présents

Quatre, tous côté SB Auto, catalogués dans
[integratedApiCatalog.js](../../../SB%20Auto%2006/backend/src/utils/integratedApiCatalog.js).

| | **STRIPE** | **BREVO** | **YOUSIGN** | **HOSTINGER** |
|---|---|---|---|---|
| **Fonction** | Paiement, abonnement, facturation | E-mail transactionnel | Signature électronique | DNS / domaines au déploiement |
| **Configuré où** | Manager SB Auto → DEV → Intégrations API | idem | idem | idem |
| **Credentials vivent où** | Mongo de l'instance, chiffrés | idem | idem | idem |
| **Champs** | `secretKey`*, `webhookSecret` (auto), `publishableKey` | `apiKey`*, `webhookSecret` | `apiKey`*, `webhookSecret`* | `apiToken`* |
| **TEST/PROD** | `sk_test_` / `sk_live_`, même hôte | Deux **comptes** distincts, aucun préfixe | Deux **hôtes** : `api-sandbox` / `api` | Un seul compte, pas de sandbox |
| **Refresh de token** | Aucun (clé statique) | Aucun | Aucun | Aucun |
| **Webhooks** | `/api/webhooks/stripe`, HMAC | `/api/webhooks/brevo/transactional/:mode`, Bearer | `/api/webhooks/yousign`, HMAC | Aucun |
| **Appels entrants** | `checkout.session.*`, `invoice.*`, `customer.subscription.*` | `delivered`, `hardBounce`, `blocked`… | `signature_request.done`… | — |
| **Appels sortants** | Checkout, Customer, Subscription, Invoice, Price, `webhook_endpoints` | `POST /smtp/email`, `/v3/webhooks` | `/v3/signature_requests`, `/v3/webhooks` | Zones + records DNS |
| **Consommateurs métier** | `payment`, `subscription`, `billing`, `contract*`, `reconciliation` | `email/*`, `contact`, `emailConfiguration` | `contract*`, `contractDocument` | `deployment-engine/dns` |
| **Secrets** | 3 (dont 1 auto-géré) | 2 | 2 | 1 |
| **Coût** | Commission par transaction | Volume d'e-mails | Par signature | Inclus hébergement |
| **État migration** | Non commencé | Non commencé | Non commencé | Non commencé |

`*` = requis pour que le mode soit « configuré ».

### 2.2 Providers ABSENTS — à ne pas planifier

La mission cite Ubiflow, AssuCarteGrise, CarVertical, Car Studio AI, Autoviza.
**Aucun n'existe dans le code.** Recherche exhaustive sur les deux dépôts
(`*.js`, `*.ts`, `*.tsx`, `*.json`, `*.md`, hors `node_modules`) : deux
occurrences, toutes deux rhétoriques.

- `SB Auto 06/docs/BREVO_MODULE.md:8` — « (… Ubiflow, CarVertical…) » dans une
  phrase sur les intégrations futures.
- `SB Auto 06/docs/yousign/YOUSIGN_TECHNICAL_AUDIT.md:57` — une colonne
  « CarVertical 🟡 » dans un tableau comparatif, marquée non implémentée.

AssuCarteGrise, Car Studio AI et Autoviza : **zéro occurrence**, y compris dans
les docs. Ils ne sont pas au périmètre de cette roadmap.

### 2.3 Les secrets ne sont dans AUCUN `.env`

Vérifié sur les `.env` réels et les `.env.example` des deux dépôts. Aucune
variable `STRIPE_*`, `BREVO_*`, `YOUSIGN_*`, `HOSTINGER_*`. La seule variable
liée est `INTEGRATED_API_ENCRYPTION_KEY` (SB Auto), qui chiffre le coffre —
elle n'est pas un secret fournisseur.

**Conséquence pour la migration :** il n'y a rien à retirer d'un fichier de
configuration. La migration est une migration de **base de données** et de
**chemin d'appel**, pas de variables d'environnement.

---

## 3. Classification des scopes

Le scope naturel se déduit d'un seul critère : *combien de comptes fournisseur
l'entreprise détient-elle réellement ?*

| Provider | Scope | Pourquoi, et ce qui le prouve |
|---|---|---|
| **BREVO** | `ENVIRONMENT` | Le catalogue dit qu'un compte TEST et un compte PROD sont **deux comptes distincts** (`integratedApiCatalog.js:99-101`), avec deux expéditeurs vérifiés et deux quotas. Ce n'est donc pas `PANEL_GLOBAL`. Une seule identité support par environnement suffit à tous les projets. |
| **STRIPE** | `ENVIRONMENT` | Un compte Stripe porte nativement les deux mondes (`sk_test_` / `sk_live_`), mais ce sont deux jeux de données, deux jeux de webhooks, deux jeux d'objets. Les traiter comme deux credential sets est la seule lecture qui ne mélange rien. |
| **YOUSIGN** | `ENVIRONMENT` | Deux **hôtes** distincts (`api-sandbox.yousign.app` / `api.yousign.app`) et deux clés. La séparation est imposée par le fournisseur. |
| **HOSTINGER** | `PANEL_GLOBAL` | Un seul portefeuille de domaines, une seule clé, aucun sandbox documenté. Le DNS d'un domaine de recette et celui d'un domaine de production vivent dans le même compte — les séparer serait inventer une distinction que le fournisseur n'a pas. |

**`PROJECT` et `PROJECT_ENVIRONMENT` : aucun provider n'en relève aujourd'hui.**
Aucun des quatre n'impose un compte par client. On ne crée donc pas ces
catégories dans le modèle « au cas où » — mais le champ `scope` doit les
admettre comme valeurs, pour qu'un provider futur (une API de données
véhicule facturée au client, typiquement) n'oblige pas à une migration de
schéma.

**Conséquence pour l'instance de Panel.** Une instance de Panel ne sert qu'un
environnement (§1.3). Un credential set `ENVIRONMENT` est donc, du point de vue
d'**une** instance, un singleton : le Panel TEST ne détient que les credentials
TEST. Cela simplifie beaucoup le modèle — mais impose que le Panel PROD et le
Panel TEST soient **provisionnés séparément** (§9.4).

---

## 4. Architecture cible du modèle

### 4.1 Ce qui ne va pas dans le modèle actuel du Panel

`PanelIntegratedApi` a été conçu comme un **coffre générique de clés**, pas
comme un plan de contrôle :

- `provider` et `key` sont des chaînes libres. Rien n'empêche
  `provider: "Stripe"` et `provider: "STRIPE"` de coexister.
- Aucun catalogue de champs : `credentials.TEST.values` est une `Map` ouverte.
  Le Panel ne sait pas qu'il manque `secretKey`.
- `mode` est un champ du document, pas une conséquence de l'environnement.
- Aucune notion de capacité, de webhook, ni de vérification.
- Le seul comportement métier est *distribuer les secrets*, qui est précisément
  ce que la cible interdit.

### 4.2 Migration minimale compatible

On ne repart pas de zéro : `apiId`, `companyId`, `credentials.{TEST,PROD}`,
le chiffrement et l'API d'administration sont réutilisables. Quatre entités
cibles, dont **deux sont des évolutions** du modèle existant.

```
IntegratedApiDefinition                       ← NOUVEAU (code-first, pas en base)
  provider          STRIPE | BREVO | YOUSIGN | HOSTINGER
  scope             PANEL_GLOBAL | ENVIRONMENT | PROJECT | PROJECT_ENVIRONMENT
  capabilities[]    billing.refund, email.send_template, …
  fields[]          { key, required, secret, prefixByMode }
  defaultBaseUrl(environment)
  webhook           { supported, remoteSync, secretAtCreationOnly, … }

IntegratedApiCredentialSet                    ← ÉVOLUTION de PanelIntegratedApi
  provider          (enum, remplace la chaîne libre)
  environment       TEST | PROD                (remplace `mode`)
  scope             (dénormalisé depuis la définition, pour l'index)
  encryptedCredentials  (= credentials.<env>.values, inchangé)
  fingerprints          (déjà là)
  status            UNCONFIGURED | CONFIGURED | VERIFIED | FAILED
  lastValidatedAt
  ✗ grants[]        ← RETIRÉ (§5)

IntegratedApiWebhook                          ← NOUVEAU
  provider, environment
  remoteWebhookId, endpointUrl
  secretRef         (nom du credential, jamais la valeur)
  subscribedEvents[]
  status, lastReconciledAt, lastError
  ← calqué sur webhookConfigSchema de SB Auto, qui a déjà la bonne forme

ExternalProviderEvent                         ← NOUVEAU (§8)
```

**`IntegratedApiRuntime` (token, expiresAt, refreshState) n'est PAS retenu.**
Les quatre providers utilisent une clé statique ; aucun n'a d'OAuth, aucun n'a
de token à rafraîchir. Créer cette entité serait porter une complexité sans
usage. Le jour où un provider OAuth arrive, elle s'ajoutera — la définition
porte déjà `runtimeModel` implicitement via `fields[]`.

**`environment` remplace `mode`, et ce n'est pas cosmétique.** Le mot `mode`
porte l'idée d'un choix ; `environment` porte celle d'un fait. Le renommage est
la première marque, dans le code, du changement de doctrine.

---

## 5. Centralisation des secrets

### 5.1 Matrice

| Secret | Avant | Après | Migration | Risque |
|---|---|---|---|---|
| `STRIPE.secretKey` | Mongo instance (chiffré) | Mongo Panel de l'env (chiffré) | Ressaisie dans le Panel, puis bascule de capacité | **Élevé** — coupe les paiements si mal fait. Dual-path obligatoire. |
| `STRIPE.webhookSecret` | Mongo instance, auto-capturé | Mongo Panel, auto-capturé | Recréation de l'endpoint côté Panel (le secret n'est jamais relisible) | Moyen — un endpoint orphelin subsiste chez Stripe |
| `STRIPE.publishableKey` | Mongo instance | Mongo Panel | Idem | Faible — clé publique |
| `BREVO.apiKey` | Mongo instance | Mongo Panel | Ressaisie | Moyen — coupe les e-mails |
| `BREVO.webhookSecret` | Mongo instance | Mongo Panel | Regénéré (c'est NOUS qui le choisissons) | Faible |
| `YOUSIGN.apiKey` | Mongo instance | Mongo Panel | Ressaisie | **Élevé** — bloque la signature de contrat |
| `YOUSIGN.webhookSecret` | Mongo instance | Mongo Panel | Recréation de l'endpoint | Moyen |
| `HOSTINGER.apiToken` | Mongo instance | Mongo Panel | Ressaisie | Moyen — bloque le DNS automatique au déploiement |
| `INTEGRATED_API_ENCRYPTION_KEY` | `.env` instance | **reste local** | Aucune | — |
| `BRIDGE_ENCRYPTION_KEY` | `.env` Panel | **reste local** | Aucune | — |

Les deux dernières lignes sont importantes : ce sont des clés d'infrastructure,
pas des credentials fournisseurs. Elles ne migrent jamais.

### 5.2 Ce qui reste projet-scoped

Rien, côté credentials. Mais deux choses **ressemblent** à des credentials et
n'en sont pas :

- **L'identité expéditrice** (`EmailConfiguration.modes[].sender`) — c'est une
  donnée métier de l'entreprise, pas un secret. Elle migre vers le Panel comme
  configuration, pas comme credential (§10).
- **Les identifiants externes** (`customerId` Stripe, `signatureRequestId`
  Yousign) — ils appartiennent au projet, ils restent dans le projet. Un
  `Payment` doit continuer de porter son `externalPaymentId`.

### 5.3 La règle, en une phrase

> Le Panel exécute. Le projet demande. **Aucun secret ne traverse le pont.**

Cela invalide `buildApiPayloadFor()` et `grants[]` dans leur forme actuelle.
Le grant ne disparaît pas — il devient une **autorisation de capacité**, pas
une autorisation de clé.

---

## 6. Modèle de capacités

### 6.1 Pourquoi pas une API brute

Si un projet peut appeler `POST /panel/proxy/stripe/v1/refunds`, le Panel n'est
plus un plan de contrôle : c'est un relais avec un problème d'authentification
en plus. Le contrôle d'environnement deviendrait décoratif — le projet
choisirait l'objet Stripe à toucher, donc le monde.

Une capacité est **une intention métier nommée**, dont le Panel dérive tout le
reste.

### 6.2 Catalogue initial, dérivé des appels réels

Chaque capacité ci-dessous correspond à un appel qui existe aujourd'hui dans SB
Auto. Aucune n'est spéculative.

| Capacité | Provider | Remplace, côté projet |
|---|---|---|
| `billing.customer.ensure` | STRIPE | `payment.service` / `subscription.service` |
| `billing.checkout.create` | STRIPE | `stripe.service.createLaunchFeeCheckout` / `createSubscriptionCheckout` |
| `billing.subscription.cancel_at_period_end` | STRIPE | `stripe.service.cancelSubscriptionAtPeriodEnd` |
| `billing.subscription.reconcile` | STRIPE | `subscription.service.reconcileAndDescribe` |
| `billing.refund` | STRIPE | *n'existe pas encore* — c'est le cas d'usage cible du bouton « Rembourser » |
| `billing.invoice.list` | STRIPE | `Invoice` + `hosted_invoice_url` |
| `email.send_template` | BREVO | `brevoEmail.service.sendTransactional` |
| `email.sender.verify` | BREVO | `emailConfiguration.service` (envoi de test) |
| `signature.request.create` | YOUSIGN | `yousign.service` |
| `signature.document.download` | YOUSIGN | `contractDocument.service` |
| `dns.record.ensure` | HOSTINGER | `deployment-engine/dns/ensureDns` |

### 6.3 Ce que le Panel décide, que le projet ne décide plus

```
Projet ──▶ POST /bridge/capabilities/billing.checkout.create
           { contractRef, amountIncludingTax, currency, successUrl, cancelUrl }
                    │
                    ▼
           Panel résout, dans cet ordre :
             1. l'INSTANCE (via le bridgeToken)          → projectId
             2. l'ENVIRONNEMENT de l'instance            → TEST
             3. la capacité autorisée pour ce projet ?   → sinon 403
             4. le credential set (provider, TEST)       → sinon 409
             5. l'appel fournisseur, retry, idempotence
             6. l'audit (§12)
                    │
                    ▼
           { checkoutUrl, externalId, environment: "TEST" }
```

Le projet ne transmet **jamais** `provider`, `mode`, `environment`, ni aucune
clé. Il n'a pas le vocabulaire pour le faire.

### 6.4 Écart avec les drivers actuels

Les drivers SB Auto sont déjà des fonctions à intention métier
(`createLaunchFeeCheckout`, pas `postToStripe`). La transformation en capacité
est donc surtout un **déplacement**, pas une réécriture : le corps de la
fonction part au Panel, l'appelant devient un appel de pont. Les schémas
d'entrée/sortie existent déjà implicitement.

Deux exceptions demandent un vrai travail :
- `verifyStripeWebhookAnyMode` et l'ingestion de webhooks : elles ne sont pas
  des capacités mais leur miroir (§7, §8).
- `dns.record.ensure` : appelé par le **moteur de déploiement du Panel**
  lui-même, pas par un projet. C'est un cas §9.

---

## 7. Routage d'environnement

### 7.1 L'autorité existe déjà

Le Panel n'a pas à inventer comment connaître l'environnement d'une instance :
il le sait depuis l'appairage, il le refuse s'il ne concorde pas, et il ne
livre pas si la fiche diverge.

```
pairing.bootstrap                 syncDelivery.deliverToProject
  dto.environment !== config.env    record.runtime.environment !== config.env
        │                                   │
        ▼                                   ▼
  BRIDGE_ENVIRONMENT_MISMATCH (409)   outcome ENVIRONMENT_MISMATCH, rien livré
```

Sources : [pairing.service.js:134](../../backend/src/services/pairing/pairing.service.js#L134),
[syncDelivery.service.js:211](../../backend/src/services/sync/syncDelivery.service.js#L211).
Couvert par `tests/panel-instance-environment.test.js` et
`tests/project-connections.test.js`.

### 7.2 La règle pour les capacités

```
environnement effectif d'un appel = config.env de l'instance de Panel
```

Et rien d'autre. Pas le domaine, pas un paramètre de la requête, pas un
en-tête, pas un réglage d'écran. Le `config.env` du processus Panel est déjà la
valeur contre laquelle l'appairage a été validé : la réutiliser ferme la boucle
sans introduire de seconde vérité.

Une conséquence agréable : **le contrôle est gratuit**. Si le Panel TEST ne
détient que les credentials TEST, un appel PROD est impossible par construction,
pas par vérification. La vérification explicite reste, en défense en
profondeur :

```
INTEGRATED_API_ENVIRONMENT_MISMATCH   409
  « Capacité refusée : cette instance de Panel sert TEST,
    le credential set demandé est PROD. »
```

**Fail closed.** Aucun repli sur l'autre environnement, aucun défaut. Si le
credential set de l'environnement courant est absent, la réponse est
`INTEGRATED_API_NOT_CONFIGURED` (409), jamais un basculement silencieux.

### 7.3 Le point dur : la doctrine actuelle dit l'inverse

C'est **la contradiction majeure de cet audit**, et elle est explicite,
documentée et testée.

> « MODE FOURNISSEUR ≠ ENVIRONNEMENT APPLICATIF. Chaque fournisseur possède son
> propre `activeMode` (TEST | PROD), choisi par un DEV depuis le Manager,
> **INDÉPENDAMMENT de `config.env`**. »
> — [integratedApiCatalog.js:7-11](../../../SB%20Auto%2006/backend/src/utils/integratedApiCatalog.js#L7-L11)

Et le tableau de `docs/INTEGRATED_API.md` §0 déclare les **quatre**
combinaisons possibles, dont `App TEST × Stripe PROD`, « techniquement permis
mais alerté ». Cette combinaison a une implémentation dédiée :
`crossModeRisk` ([integratedApi.controller.js:88](../../../SB%20Auto%2006/backend/src/controllers/integratedApi.controller.js#L88)),
une bannière dans le Manager
([DevIntegrationsPage.tsx:297-302](../../../SB%20Auto%2006/manager/src/pages/dev/DevIntegrationsPage.tsx#L297-L302)),
et deux assertions de test
(`integrated-api.test.js:193` et `:246`).

**Ce n'est pas un oubli, c'est un choix produit qu'il faut révoquer
explicitement.** Cinq artefacts au moins tombent avec lui :

1. `IntegratedApi.activeMode` et son API `POST /:provider/active-mode`
2. `confirmVerb` (« ACTIVER STRIPE PROD ») et son garde-fou de confirmation
3. `crossModeRisk` et sa bannière
4. Le tableau à quatre lignes de `docs/INTEGRATED_API.md`
5. Les deux tests qui affirment que `crossModeRisk` peut valoir `true`

**Il faut trancher avant L1.** Voir §21, décision D1.

### 7.4 Un cas légitime que la nouvelle doctrine casse

La combinaison `App PROD × Stripe TEST` est marquée « Sûr » dans la doctrine
actuelle, et elle a un usage réel : **une recette sur l'instance de
production**, avant d'ouvrir les paiements réels. La doctrine cible l'interdit.

Ce n'est pas une raison de renoncer — c'en est une de prévoir le remplacement :
un **mode « pré-ouverture »** au niveau du contrat, ou une instance PROD dont
l'ouverture des paiements est un état métier explicite, pas un réglage de
credential. À décider (§21, D2), pas à improviser au moment de la bascule.

---

## 8. Webhooks

### 8.1 Ce qui existe aujourd'hui — et c'est beaucoup

SB Auto possède déjà un plan de contrôle de webhooks complet, générique et
testé. **Il ne faut pas le réécrire, il faut le déplacer.**

- **Registre code-first** —
  [managedWebhookRegistry.js](../../../SB%20Auto%2006/backend/src/services/webhooks/managedWebhookRegistry.js) :
  provider × category → route, événements attendus, référence du secret. Un
  seul fabricant d'URL, `buildWebhookUrl()`, calculé depuis la racine publique.
  La configuration ne stocke jamais une route complète.
- **Contrat de driver uniforme** —
  [integrationWebhookProviders.js](../../../SB%20Auto%2006/backend/src/services/webhooks/integrationWebhookProviders.js) :
  `listManagedWebhooks / ensureWebhooks / repairWebhooks / getWebhookHealth /
  testWebhooks`, plus un objet `capabilities()` que l'UI consomme au lieu d'un
  `if (provider === …)`.
- **Adaptateurs distants** —
  [remoteWebhookAdapters.js](../../../SB%20Auto%2006/backend/src/services/webhooks/remoteWebhookAdapters.js) :
  `fetch` nu, CRUD Stripe et Yousign, capture du secret à la création.
- **Identification par description canonique** —
  `SB_AUTO_06_MANAGED_<PROVIDER>_<CATEGORY>_<MODE>#<installationId>`, avec
  reconnaissance des descriptions historiques pour l'adoption. C'est ce qui
  rend le dédoublonnage sûr sans se fier à l'URL.
- **Déclenchement** — au **boot**
  ([bootstrap.js:537-578](../../../SB%20Auto%2006/backend/src/config/bootstrap.js#L537-L578)),
  best-effort, timeout 20 s, jamais bloquant ; plus une veille ngrok de 60 s en
  développement.

### 8.2 Capacité réelle de création automatique — vérifié en doc officielle

| Provider | CRUD API | Endpoints multiples | Secret de signature | Secret relisible ? | TEST/PROD | Retry fournisseur |
|---|---|---|---|---|---|---|
| **Stripe** | Oui — `POST/GET/DELETE /v1/webhook_endpoints`, update par `POST /v1/webhook_endpoints/:id` | Oui, **plafond documenté à 16 par compte** | HMAC-SHA256, en-tête `Stripe-Signature` | **Non** — `secret` n'est renvoyé qu'à la création | Séparés par la clé (`sk_test_` / `sk_live_`) ; `livemode` sur l'objet | Oui, avec backoff |
| **Brevo** | Oui — `POST/GET/PUT/DELETE /v3/webhooks`, filtrables par `type` (`transactional`, `marketing`, `inbound`) | Oui, plafond non documenté publiquement (l'UI parle de « supprimer des webhooks existants ») | **Aucun HMAC** — en-têtes personnalisés ou `auth.token`, plus allowlist d'IP | Oui, c'est nous qui le posons | **Aucun sandbox** — deux comptes distincts | Oui |
| **Yousign / Youtrust** | Oui — endpoints dédiés v3, champ `sandbox` sur la souscription | Oui | `secret_key` « utilisée pour signer les charges utiles » | **Non documenté explicitement** — le code actuel suppose « à la création seulement » | Sandbox et production, **hôtes distincts** et clés distinctes | `auto_retry` booléen, politique non documentée |
| **Hostinger** | **Aucun webhook** | — | — | — | Un seul compte | — |

Trois précisions qui changent la conception :

1. **Le plafond Stripe de 16 endpoints est une contrainte de capacité réelle.**
   Aujourd'hui, chaque instance SB Auto enregistre son propre endpoint sur le
   compte Stripe partagé. Au-delà de ~16 instances, la création échoue. La
   centralisation **résout** ce problème : un endpoint Panel par environnement,
   quel que soit le nombre de projets. C'est un argument fort en faveur de L5.

2. **Brevo n'a pas de signature cryptographique.** Un webhook Brevo n'est
   jamais *prouvé*, seulement *authentifié* par secret partagé et IP. Le code
   SB Auto le dit déjà explicitement
   ([integratedApiCatalog.js:102-106](../../../SB%20Auto%2006/backend/src/utils/integratedApiCatalog.js#L102-L106)).
   Le handler Panel doit conserver cette nuance — pas prétendre à une garantie
   qu'il n'a pas.

3. **Yousign est devenu Youtrust (juillet 2026).** `developers.yousign.com`
   redirige en 301 vers `developers.youtrust.com`. Les hôtes d'API
   `api.yousign.app` / `api-sandbox.yousign.app` codés en défaut dans
   [integratedApiCatalog.js:126-129](../../../SB%20Auto%2006/backend/src/utils/integratedApiCatalog.js#L126-L129)
   **ne sont pas confirmés stables**. Le modèle stocke une `baseUrl` éditable —
   le risque est donc contenu, mais la vérification est un prérequis de L6.

### 8.3 Réconciliateur cible

```
Déploiement du Panel terminé
        │
        ▼
Backend public en bonne santé  (health check déjà dans le pipeline)
        │
        ▼
URLs runtime committées        (runtimeConfig.js, avec relecture — déjà là)
        │
        ▼
reconcileProviderWebhooks(environment = config.env)
        │
        └── pour chaque provider dont webhook.supported :
              endpoint souhaité = `${backendUrl}/webhooks/${provider}`
              vs endpoints distants portant NOTRE description canonique
```

| Situation | Action |
|---|---|
| Déjà conforme (URL + événements) | No-op, `lastReconciledAt` avancé |
| Absent | Créer, **capturer le secret immédiatement**, persister chiffré |
| URL périmée, même id | `update` en place — préserve le secret, c'est le chemin sûr |
| Doublons portant notre description | Garder le plus récent conforme, **vérifier**, puis seulement désactiver les autres |
| Endpoint inconnu (pas notre description) | **Ne jamais toucher.** Journaliser. |
| Erreur fournisseur | Voir §8.4 |

L'ordre « créer → vérifier → retirer l'ancien » n'est pas négociable : retirer
d'abord ouvre une fenêtre où aucun endpoint n'écoute, et les événements de
cette fenêtre sont perdus définitivement.

### 8.4 Un échec de webhook doit-il casser un déploiement ?

**Non, par défaut** — et la recommandation de la mission est la bonne. Un
provider externe momentanément indisponible ne doit pas empêcher une release
valide d'aller en production ; le réconciliateur est idempotent et repassera au
prochain boot.

Mais « par défaut » n'est pas « toujours ». Provider par provider :

| Provider | Politique | Pourquoi |
|---|---|---|
| **Stripe** | `DEPLOYED_WITH_WARNING` | Un paiement dont le webhook est perdu laisse un contrat non activé et un client débité. C'est grave — mais réparable par `billing.subscription.reconcile`, qui existe déjà. Le déploiement passe, l'alerte est forte. |
| **Yousign** | `DEPLOYED_WITH_WARNING` | Une signature dont l'événement se perd bloque le contrat sans trace. Réparable par polling manuel. Même arbitrage. |
| **Brevo** | Avertissement simple | Perdre un événement de délivrabilité dégrade le suivi, jamais un état métier. |
| **Hostinger** | Sans objet | Pas de webhook. |

Aucun provider ne justifie de **bloquer** un déploiement. `DEPLOYED_WITH_WARNING`
doit être un état visible dans le rapport de déploiement et dans la supervision,
pas une ligne de log.

### 8.5 Routes Panel

```
POST /webhooks/stripe          raw body, HMAC Stripe-Signature
POST /webhooks/brevo           raw body, Bearer partagé + allowlist IP
POST /webhooks/yousign         raw body, HMAC
GET  /webhooks/<provider>/health   sonde anonyme, sans effet de bord
```

Pas de segment `:mode` dans l'URL : l'instance de Panel **est** l'environnement.
C'est plus simple que le schéma SB Auto actuel (`/brevo/transactional/:mode`),
et cohérent avec la doctrine. Le routeur doit être monté **avant**
`express.json()` — la vérification de signature exige le corps brut. C'est le
piège classique, et SB Auto le documente déjà
([webhook.routes.js:5-9](../../../SB%20Auto%2006/backend/src/routes/webhook.routes.js#L5-L9)).

Chaque handler, dans l'ordre : vérifier la signature → déterminer
l'environnement (= le sien) → contrôler l'idempotence → journaliser →
normaliser (§8.6) → router vers le projet concerné.

**Aucun projet ne reçoit jamais un webhook fournisseur.** Le Panel reçoit,
normalise, et pousse un événement métier sur le pont existant.

### 8.6 Normalisation des événements

```
ExternalProviderEvent
  provider, environment
  externalEventId          ← clé d'idempotence, index unique
  eventType                ← brut, conservé pour le forensic
  receivedAt, status, payloadHash

        │  mapping, une seule fois, à la passerelle
        ▼

PAYMENT_SUCCEEDED · PAYMENT_FAILED · REFUND_SUCCEEDED · INVOICE_PAID
EMAIL_DELIVERED · EMAIL_BOUNCED · SIGNATURE_COMPLETED · SIGNATURE_DECLINED
```

Au-delà de la passerelle, plus aucun code ne connaît le mot
`checkout.session.completed`. C'est ce qui rend un changement de provider
possible sans toucher au métier — et c'est aussi ce qui rend le mapping
testable isolément.

SB Auto a déjà les registres de correspondance
(`stripeEventRegistry.js`, `brevoTransactionalEventRegistry.js`) : ils
deviennent la table de mapping du Panel.

---

## 9. Le Panel lui-même

### 9.1 Ce qu'il consomme aujourd'hui

**Presque rien.** `Panel/backend/package.json` ne contient aucune dépendance
fournisseur. Le seul appel externe est le DNS au déploiement, via l'interface
`DnsProvider` — et **il n'existe aucune implémentation Hostinger dans le
Panel** : seulement `MockDnsProvider`. Les messages d'erreur du moteur
renvoient l'opérateur vers « DEV → Intégrations API », qui est l'écran du
Manager SB Auto
([DeploymentEngine.js:806](../../backend/src/deployment-engine/DeploymentEngine.js#L806)).

Un commentaire de `env.js` affirme même : « le Panel n'a pas d'IntegratedAPI ».
C'est vrai au sens de la consommation, faux au sens du stockage — cette
ambiguïté doit disparaître avec L1.

### 9.2 Ce qu'il consommera

| Usage Panel | Provider | Capacité |
|---|---|---|
| DNS au déploiement | HOSTINGER | `dns.record.ensure` |
| E-mails de support et de notification | BREVO | `email.send_template` |
| Facturation des projets, remboursements | STRIPE | `billing.*` |
| Réconciliation d'abonnement | STRIPE | `billing.subscription.reconcile` |

### 9.3 La même règle, sans exception

```
Panel TEST  →  credential set TEST   →  Stripe test, Brevo compte test, Yousign sandbox
Panel PROD  →  credential set PROD   →  Stripe live, Brevo compte prod, Yousign production
```

Le Panel n'a **pas** de sélecteur d'environnement. `config.env` du runtime
choisit le credential set, point. Aucune action d'administration ne doit
proposer « exécuter en PROD depuis le Panel TEST ».

### 9.4 Provisionnement séparé — la conséquence à ne pas manquer

Une instance de Panel ne détenant que les credentials de son environnement, il
faut **saisir les credentials deux fois** : une dans le Panel TEST, une dans le
Panel PROD. Ce n'est pas une régression, c'est la doctrine appliquée — mais
c'est un pas d'exploitation à écrire dans le runbook (§13, L1).

Corollaire : le Panel TEST ne peut pas vérifier les clés PROD, ni réconcilier
les webhooks PROD. Chaque instance ne voit que son monde. C'est exactement ce
qu'on veut, et c'est aussi ce qui empêchera de tout tester depuis un poste de
développement.

---

## 10. Brevo, support et templates

### 10.1 Ce qui existe côté SB Auto

Un module e-mail mature, à migrer **à l'identique fonctionnellement** :

| Brique | Fichier | Rôle |
|---|---|---|
| Templates persistés | `EmailTemplate.model.js` + `EmailTemplateVersion` | HTML éditable, versionné, `enabled`, **jamais de destinataire dans le template** |
| Registre code-first | `utils/emailTemplateRegistry.js` | 5 templates : `PASSWORD_RESET_REQUEST`, `CONTACT_ADMIN_NOTIFICATION`, `CONTRACT_CANCELLATION_ADMIN_CONFIRMATION`, `CONTRACT_CANCELLATION_DEV_NOTIFICATION`, `EMAIL_SENDER_VERIFICATION_TEST` |
| Identité expéditrice | `EmailConfiguration.model.js` | Par mode : nom d'expéditeur, adresse support, issue du dernier test |
| Résolution du destinataire | `emailRecipientResolvers.js` | À l'exécution, jamais dans le contenu |
| Suivi de livraison | `EmailDelivery` + `EmailDeliveryEvent` + `brevoDeliveryTransitions.js` | Machine à états alimentée par les webhooks |
| Diagnostic | `emailDiagnostics.service.js`, `emailReadiness.service.js` | Pourquoi un envoi n'est pas possible |

Le modèle a une propriété qu'il faut préserver : **le destinataire n'est jamais
dans le template**. Le mettre là rendrait une adresse éditable depuis une
interface web. La cible doit garder cette séparation.

### 10.2 Cible

```
Panel
├── UNE IntegratedApi BREVO par environnement
├── UNE identité support (nom + adresse), configurée dans le Panel
├── Les templates, versionnés, édités dans le Panel
├── EmailDelivery + événements normalisés (EMAIL_DELIVERED, EMAIL_BOUNCED)
└── Capacité email.send_template
        ▲
        │  { templateId, recipientRef, variables }
        │
    Projet — ne connaît ni la clé Brevo, ni l'expéditeur, ni l'URL de l'API
```

Le projet demande une notification. Il ne sait pas qu'elle passe par Brevo.

### 10.3 Le point délicat

`EmailConfiguration` est **par mode** parce que « la clé API Brevo appartient à
UN compte, TEST et PROD portent deux clés, donc potentiellement deux comptes
distincts, deux expéditeurs autorisés, deux quotas »
([EmailConfiguration.model.js:16-21](../../../SB%20Auto%2006/backend/src/models/EmailConfiguration.model.js#L16-L21)).

Cette analyse reste juste dans la cible — elle se traduit simplement par « une
identité par instance de Panel » au lieu de « deux identités par instance de
projet ». C'est une simplification, pas une perte.

**Rien de tout cela ne migre dans ce lot.** C'est L8, et c'est le plus gros lot
fonctionnel de la roadmap.

---

## 11. Stripe en détail

### 11.1 Ce qui est déjà bon

L'exigence de la mission — « toute transaction financière doit porter
environment, provider, credential scope, external IDs » — **est déjà
satisfaite** :

| Modèle | Champs |
|---|---|
| `Payment` | `providerMode` (TEST\|PROD, requis), `environment` (requis), `externalPaymentId`, `externalInvoiceId`, index unique sur `stripe.checkoutSessionId` |
| `Invoice` | `environment` (requis), `provider` + `externalInvoiceId` en index unique |
| `Contract` | `environment` (requis), projection `stripe.*` marquée comme projection, pas comme vérité |

Et les métadonnées Stripe portent déjà `providerMode` et
`applicationEnvironment`
([stripe.service.js:33-41](../../../SB%20Auto%2006/backend/src/services/stripe/stripe.service.js#L33-L41)).

> Le futur bouton « Rembourser » a donc déjà tout ce qu'il lui faut : il lit
> `payment.environment`, en déduit le credential set, et n'a **jamais** à
> demander à l'utilisateur quel Stripe utiliser. C'est le meilleur signal de
> l'audit : la donnée est prête, seul le chemin d'appel manque.

### 11.2 Ce qui bouge

- `providerMode` et `environment` deviennent **toujours égaux**. Garder les deux
  champs reste utile : l'historique contient des lignes où ils diffèrent, et les
  effacer serait détruire la preuve d'une exécution passée. On ajoute un
  invariant à l'écriture, on ne réécrit pas le passé.
- `verifyStripeWebhookAnyMode` disparaît : avec un seul credential set par
  instance, il n'y a plus d'« autre mode » à essayer. Le repli devient un refus.
- Le webhook secret n'est plus relisible après création : la recréation
  d'endpoint côté Panel **invalide** le secret côté projet. D'où l'ordre imposé
  en L5 (créer côté Panel, vérifier, puis seulement retirer côté projet).

### 11.3 Objets à couvrir

`Customer`, `Subscription`, `Invoice`, `PaymentIntent`, `Charge`, `Refund`,
`Checkout Session`, `Hosted Invoice Page`, `Price`. Tous sont déjà manipulés
par SB Auto sauf `Refund`, qui est le premier cas d'usage neuf du plan de
contrôle.

---

## 12. Sécurité et observabilité

### 12.1 Sécurité

| Point | Aujourd'hui | Cible |
|---|---|---|
| Chiffrement au repos | AES-256-GCM des deux côtés | Inchangé, Panel seul détenteur |
| Rotation | `rotate-secrets` déclare la conséquence (« les credentials chiffrés deviennent illisibles ») | Idem, plus rotation *par credential* sans re-chiffrer le coffre |
| Affichage UI | Masqué (`lastFour`) côté SB Auto, empreinte 8 caractères côté Panel | Inchangé |
| Permissions | Rôle DEV côté SB Auto, admin côté Panel | Inchangé |
| Logs | Jamais de valeur ; noms de clés seulement | Inchangé — invariant à retester |
| Erreurs | Messages sûrs, codes stables | Inchangé |
| Secrets de webhook | Chiffrés, `secretRef` dans les descripteurs | Inchangé |
| **Secrets sur le pont** | **En clair vers les projets** ✗ | **Jamais** ✓ |

La dernière ligne est le seul vrai changement — et c'est le plus important.

### 12.2 Observabilité

Un enregistrement par invocation de capacité, sans aucun secret :

```
provider · environment · capability · projectId · requestId
status · durationMs · externalRequestId · retryCount · errorCode
```

`externalRequestId` mérite d'être capté dès L3 : c'est le `Request-Id` de
Stripe, et c'est la seule chose qui permet à un support fournisseur de
retrouver un appel. On ne peut pas le reconstituer après coup.

Le tableau de bord vient plus tard. Le journal, non : sans lui, la migration
progressive du §13 n'est pas vérifiable.

---

## 13. Roadmap

Chaque lot est petit, indépendamment livrable, et se termine sur un critère
observable. La roadmap dérive de l'audit : **L2 vient tôt** parce que la
contradiction de doctrine bloque tout le reste, et **L5 vient avant les
migrations** parce que le plafond Stripe de 16 endpoints est déjà une contrainte
de capacité.

---

### L0 — Audit et doctrine · *ce document*

- **Objectif** — établir les faits, trancher les contradictions.
- **Dépendances** — aucune.
- **Livrables** — ce document ; mise à jour de `ARCHITECTURE_CONTEXT.md` (renvoi).
- **Tests** — aucun (documentaire).
- **Risque** — nul.
- **GO** — les décisions D1 à D5 (§21) sont tranchées par écrit.

---

### L1 — Fondation IntegratedAPI du Panel · ✅ **LIVRÉ**

- **Objectif** — le Panel sait décrire, stocker et vérifier des credentials
  fournisseurs typés. Les projets ne changent pas.
- **Dépendances** — L0.
- **Risque** — **faible.** Additif, sans consommateur.

**Ce qui a été livré**

| Brique | Fichier |
|---|---|
| Registre code-first | [`services/integratedApi/providerRegistry.js`](../../backend/src/services/integratedApi/providerRegistry.js) |
| Résolveur d'environnement | [`services/integratedApi/environment.js`](../../backend/src/services/integratedApi/environment.js) |
| Coffre (chiffrer / masquer / déchiffrer) | [`services/integratedApi/credentialVault.js`](../../backend/src/services/integratedApi/credentialVault.js) |
| Validation fournisseur, lecture seule | [`services/integratedApi/providerValidation.js`](../../backend/src/services/integratedApi/providerValidation.js) |
| Service métier unique | [`services/integratedApi/controlPlane.service.js`](../../backend/src/services/integratedApi/controlPlane.service.js) |
| Amorçage idempotent | [`services/integratedApi/seed.js`](../../backend/src/services/integratedApi/seed.js) |
| Modèle | [`models/PanelIntegratedApiCredentialSet.model.js`](../../backend/src/models/PanelIntegratedApiCredentialSet.model.js) |
| Surface `/api/integrated-apis` | [`routes/integratedApi.routes.js`](../../backend/src/routes/integratedApi.routes.js) · [`controllers/integratedApi.controller.js`](../../backend/src/controllers/integratedApi.controller.js) |
| Écran | [`pages/IntegratedApiControlPlanePage.tsx`](../../frontend/src/pages/IntegratedApiControlPlanePage.tsx) |

**Décisions prises pendant le lot**

- **Un modèle NEUF, pas une extension.** `PanelIntegratedApi` porte `grants[]`
  et la diffusion de secrets — bâtir la fondation dessus reviendrait à
  l'appuyer sur ce que L4 doit démolir. Les deux collections coexistent
  volontairement ; l'ancienne est intacte.
- **`IntegratedApiRuntime` : NOT_NEEDED_L1.** Les quatre fournisseurs sont à
  clé statique (`tokenStrategy: STATIC_KEY`) : aucun jeton à rafraîchir, aucun
  état runtime à persister. Créer une table vide serait de l'anticipation
  spéculative. Un test verrouille la justification — il tombera le jour où un
  fournisseur OAuth arrivera.
- **`baseUrl` est un rôle de credential**, non confidentiel, avec défaut issu
  du registre (et un défaut PAR ENVIRONNEMENT pour Yousign, dont les hôtes
  diffèrent). Aucun driver ne codera jamais une URL.
- **`publishableKey` n'est pas confidentielle.** Elle est faite pour partir
  dans un navigateur : la masquer n'apporterait aucune sécurité et
  empêcherait de la relire. Elle est la seule valeur que l'API rend en clair.
- **La validation est une ÉCRITURE.** Elle sort sur le réseau, consomme du
  quota et horodate le coffre — donc DEV, pas ADMIN.
- **`INVALID` ≠ `ERROR`.** Un 401 signifie « le fournisseur refuse la clé » ;
  une coupure réseau signifie « on n'a pas pu savoir ». Les confondre enverrait
  un opérateur régénérer une clé parfaitement valide.

**Ce que L1 n'a PAS fait** — aucun appel métier redirigé, aucun credential
projet supprimé, aucun webhook touché, aucun driver retiré, aucune page Manager
modifiée, aucun secret copié depuis une base de projet.

**Tests** — 5 suites, 247 assertions, dans `run-all.js` :
`integrated-api-provider-registry` · `integrated-api-environment-routing` ·
`integrated-api-encryption` · `integrated-api-control-plane` ·
`integrated-api-http-security`.

**GO atteint** — les quatre fournisseurs se configurent et se testent depuis le
Panel, dans les deux jeux, sans qu'aucun projet ne bouge.

---

### L1.5 — Inventaire du parc réel · ✅ **LIVRÉ** (audit, read-only)

Prérequis de L2 : on ne révoque pas une doctrine sans savoir ce que la nouvelle
casserait. Photographie prise le **2026-08-10** sur le cluster réel, sans
aucune écriture.

**Outil** —
[`backend/scripts/audit-integrated-api-environment-readiness.mjs`](../../backend/scripts/audit-integrated-api-environment-readiness.mjs).
Lecture seule vérifiable (`find`, `countDocuments`, `distinct`,
`listCollections`, `listDatabases` — rien d'autre), n'importe aucun modèle
mongoose (donc aucun hook, aucune migration, aucun seed), ne déchiffre aucun
credential, sort en **0 même s'il trouve des écarts**. Rejouable avant L2 et
après chaque migration.

**Le parc, en une ligne : un Panel, une instance, tous deux en TEST.**

| | Hôte | ENV | État |
|---|---|---|---|
| Panel | `panel.ly-solution.com` | **TEST** | vivant (`/health` : `env: TEST`, base connectée) |
| Panel PROD | — | — | **n'existe pas** : la base `panel_prod` est absente du cluster |
| Instance | `api.demo-sbauto06.ly-solution.com` | **TEST** | vivante, appairée, battement continu |
| Ancien Panel | `panel.lycarz.com` | — | **410 Gone** — déclassé |
| Ancienne instance | `api.demo-sbauto.lycarz.com` | — | injoignable — déclassée |

**Matrice** — 8 couples instance × fournisseur, **0 bloquant** :

| Base | Vie | ENV | Fournisseur | activeMode | TEST | PROD | Écart | Bloquant |
|---|---|---|---|---|---|---|---|---|
| `sbauto06_test` | LIVE | TEST | STRIPE | TEST | 3 | — | CLEAN | non |
| `sbauto06_test` | LIVE | TEST | YOUSIGN | TEST | 2 | — | CLEAN | non |
| `sbauto06_test` | LIVE | TEST | BREVO | TEST | 2 | — | CLEAN | non |
| `sbauto06_test` | LIVE | TEST | HOSTINGER | TEST | 1 | — | N/A global | non |
| `sbauto06_prod` | DORMANT | PROD | STRIPE | **TEST** | 3 | — | LEGACY_MISMATCH | non |
| `sbauto06_prod` | DORMANT | PROD | YOUSIGN | **TEST** | 2 | — | LEGACY_MISMATCH | non |
| `sbauto06_prod` | DORMANT | PROD | BREVO | TEST | 1 | — | PROVIDER_NOT_CONFIGURED | non |
| `sbauto06_prod` | DORMANT | PROD | HOSTINGER | TEST | — | — | N/A global | non |

**Le seul vrai croisement du parc est historique, et il est daté.** La base
`sbauto06_prod` a servi un déploiement PROD sur `demo-sbauto.lycarz.com`,
remplacé le **2026-08-04** par un déploiement TEST sur le même hôte. Elle porte
2 contrats en `environment: PROD` et **un paiement `providerMode: TEST`,
`environment: PROD`, statut PAID, du 2026-07-16** : la preuve, dans les données,
que la combinaison « application PROD × Stripe TEST » a réellement été utilisée
— exactement le cas légitime que la décision **D2** doit remplacer avant L2.

Plus aucune instance ne sert cette base (dernière écriture : 2026-08-04). Ses
écarts sont donc **rapportés mais non bloquants** : ils redeviendraient vrais si
on la ressuscitait, et le script continuera de le dire.

**Aucune instance inconnue.** Le cluster porte trois bases hors parc déclaré :
`sample_mflix` (jeu de démonstration Atlas), `test` (vide, une collection),
`sbauto06_control` (plan de contrôle des déploiements du projet — 3 cibles, 20
releases, cohérent avec l'historique ci-dessus). Aucune ne porte d'IntegratedAPI.

**Ce que L2 casserait aujourd'hui : rien.** La seule instance vivante est en
TEST, avec `activeMode = TEST` sur les quatre fournisseurs et les identifiants
TEST présents et vérifiés. La règle `runtime ENV = provider ENV` lui est déjà
appliquée de fait.

**Le plan de contrôle du Panel est vide (7 jeux `EMPTY`) — et ce n'est pas un
blocage pour L2.** L2 ne déplace aucun appel : il retire le choix manuel, les
projets continuent d'utiliser leurs identifiants locaux. Le remplissage du
coffre du Panel conditionne **L6**, pas L2.

**Constat incident — RECTIFIÉ par le lot L1.75.** La fiche du Panel annonce
`runtime.publicBackendUrl = https://api.demo-sbauto.lycarz.com`, une adresse
injoignable. Ce rapport en concluait qu'une livraison descendante viserait un
hôte mort : **c'était faux.** Vérification faite en L1.75, la destination avait
convergé (ACTIVE = `demo-sbauto06.ly-solution.com`, ancienne RETIRED le
2026-08-06) et `outboundBaseUrl()` lit la destination active, jamais ce champ.
`runtime.publicBackendUrl` est une photographie d'appairage, volontairement
figée et volontairement ignorée. Le seul lecteur résiduel — la détection de
doublon du `ProjectWizard` — a été corrigé en L1.75.

---

### L1.75 — Ouverture commerciale · ✅ **LIVRÉ** (primitive + doctrine)

Réponse à la décision **D2**, ouverte depuis l'audit et rendue concrète par
l'inventaire L1.5.

#### Le besoin, et sa preuve

`sbauto06_prod` contient un `Payment` **PAID · environment PROD · providerMode
TEST · 2026-07-16**. Une instance techniquement en production avait été validée
de bout en bout avec un Stripe de test. C'était utile — personne ne veut débiter
une vraie carte pour vérifier qu'un déploiement fonctionne — et ce n'était
possible que parce qu'`activeMode` laissait choisir le monde à la main.

L2 supprimera ce choix. Sans remplaçant, il supprimerait aussi la capacité.

#### La doctrine

```
ENVIRONNEMENT TECHNIQUE   ≠   OUVERTURE COMMERCIALE
      environment.js              commercialReadiness.js
   « quel monde fournisseur ? »   « l'action réelle est-elle autorisée ? »

PREOPENING ≠ TEST
PREOPENING NEVER SELECTS PROVIDER SANDBOX
```

Une instance en pré-ouverture **est** en PROD : elle utiliserait les
identifiants PROD. On lui refuse simplement de capturer de l'argent. Confondre
les deux recréerait `activeMode` sous un autre nom.

#### Deux états, pas trois — et l'argument est un interblocage

`SUSPENDED` a été écarté. `SiteStatus` porte déjà la suspension, avec ses deux
sources (`TECHNICAL`, `CONTRACT`). Surtout : `SiteStatus` passe à `SUSPENDED`
avec la source `CONTRACT` précisément quand aucun contrat n'est honoré, et l'on
en sort **en payant**. Un `SUSPENDED` commercial qui refléterait cet état
bloquerait le paiement censé le lever — le site ne pourrait plus jamais revenir.

Une machine à états répond à une question. « Le site doit-il être servi ? » a
déjà la sienne.

#### Ce qui a été écarté, et pourquoi

**`Contract.status` ne peut pas porter l'ouverture** : la transition
`INACTIVE → ACTIVE` exige de payer les frais de lancement. Une porte doit
précéder l'action qu'elle garde ; ici elle en serait le résultat. Circulaire.

#### La politique — table code-first fermée

La décision ne se prend pas capacité par capacité, au jugé : elle découle de la
**nature de l'effet**.

| Capacité | Effet | Pré-ouverture |
|---|---|---|
| `billing.invoice.list` | READ_ONLY | ✅ |
| `billing.subscription.reconcile` | READ_ONLY | ✅ |
| `billing.customer.ensure` | REVERSIBLE_EXTERNAL_WRITE | ✅ |
| `billing.checkout.create` | **FINANCIAL_WRITE** | ❌ |
| `billing.subscription.cancel_at_period_end` | **FINANCIAL_WRITE** | ❌ |
| `billing.refund` | **FINANCIAL_WRITE** | ❌ |
| `signature.request.create` | **LEGAL_WRITE** | ❌ |
| `signature.document.download` | READ_ONLY | ✅ |
| `email.sender.verify` | CONFIGURATION | ✅ |
| `email.send_template` | COMMUNICATION_WRITE | ✅ |
| `dns.record.ensure` | INFRASTRUCTURE_WRITE | ✅ |

Deux effets seulement sont interdits — ceux qui **engagent quelqu'un d'autre que
nous** : l'argent d'un client, et sa signature.

**La pré-ouverture n'est pas une coupure réseau.** Une instance qu'on ne peut ni
déployer, ni configurer, ni dont l'administrateur ne peut recevoir sa
réinitialisation de mot de passe serait contournée — et la pré-ouverture
deviendrait décorative. D'où `COMMUNICATION_WRITE` et `INFRASTRUCTURE_WRITE`
autorisés.

**Conséquence assumée** : `signature.request.create` étant bloquée, le parcours
d'activation d'un contrat n'est pas praticable en pré-ouverture. C'est cohérent —
on ouvre, **puis** on contractualise.

#### « Tester une production » — le parcours retenu

| | Option | Verdict |
|---|---|---|
| **A** | PROD + PREOPENING → simulation, aucun appel fournisseur | **Retenue** comme filet. Le stub existe déjà (`stripe.stub.js`, `STRIPE_PROVIDER=stub`). |
| **B** | Instance TEST miroir → parcours complet en Stripe TEST | **Recommandée** comme parcours principal : c'est le seul qui exerce le chemin réel de bout en bout. |
| **C** | PROD + PREOPENING → Stripe TEST | **Rejetée.** Elle réintroduit `ENV PROD × provider TEST`, c'est-à-dire exactement ce que L2 supprime. |

Recommandation : **B pour valider le parcours, A pour protéger la production.**

#### Transition PREOPENING → LIVE

L'état ne devient pas un sac de conditions. Les prérequis sont des **contrôles
séparés**, dérivés de ce qui existe déjà (`getProviderReadiness`, destination
active, entreprise configurée, webhook réconcilié). L'état reste un fait
déclaré ; les contrôles ne font que le recommander ou l'avertir.

Retour `LIVE → PREOPENING` : à autoriser, réservé au DEV, avec confirmation —
c'est un frein d'urgence, pas un réglage.

#### Contrat avec L2 — deux décisions indépendantes

```
environmentResolver.resolve()            →  PROD
commercialPolicy.canExecute('billing.checkout.create')
                                         →  BLOCKED_PREOPENING
```

La seconde ne modifie **jamais** le résultat de la première. Vérifié par test :
la résolution du monde est relue après le refus et vaut toujours `PROD`.

Comportement futur, fail closed :

```
ENV=PROD · PREOPENING · billing.capture   →  COMMERCIAL_PREOPENING, aucun appel
ENV=PROD · LIVE · credential PROD absente →  INTEGRATED_API_NOT_CONFIGURED
                                             JAMAIS de repli sur TEST
```

#### Ce qui est livré, et ce qui ne l'est pas

**Livré** —
[`services/integratedApi/commercialReadiness.js`](../../backend/src/services/integratedApi/commercialReadiness.js) :
vocabulaire fermé, table de politique, `canExecute()`. Plus 71 assertions
d'invariants.

**Volontairement NON livré** — aucune persistance, ni côté Panel ni côté projet ;
aucun écran ; aucun branchement fournisseur. Même règle qu'au lot L1
(`IntegratedApiRuntime : NOT_NEEDED_L1`) : on ne crée pas une structure de
données qu'aucun code n'écrit, ni un écran qui afficherait une constante. Le
parc ne compte **aucune instance PROD vivante** — la notion n'a personne à
protéger aujourd'hui.

> ⚠️ **CETTE ANNONCE ÉTAIT FAUSSE — corrigée en L3.1.**
>
> Elle disait : « stockée **côté instance** (autorité locale, pour que
> l'enforcement survive à une panne du Panel) et projetée vers le Panel ».
>
> L3 a tranché l'inverse, et l'argument est plus fort :
>
> 1. **L'enforcement a changé de camp.** La passerelle de capacités vit dans le
>    Panel. Si le Panel est indisponible, la capacité n'est pas exécutée du
>    tout : il n'y a rien à faire respecter localement.
> 2. **Et surtout : un projet ne doit pas pouvoir DÉCLARER son propre droit de
>    dépenser.** Sous l'autorité locale + projection, le Panel arbitrerait sur
>    une valeur envoyée par le projet — exactement ce que la doctrine
>    d'environnement interdit depuis L2. Un projet compromis, ou simplement mal
>    déployé, s'ouvrirait lui-même.
>
> **Autorité retenue : le Panel** (`PanelProject.commercialState`). L'instance
> ne la connaît pas et n'a pas à la connaître : elle demande une capacité, le
> Panel décide. Voir §L3.1.

Son seul appelant est la passerelle de capacités (L3).

#### UX cible (conçue, non implémentée)

Deux badges, jamais fusionnés :

```
Environnement technique : PRODUCTION
Ouverture commerciale   : PRÉ-OUVERTURE
```

Jamais « TEST » pour désigner une pré-ouverture. Modification réservée au DEV,
confirmation explicite pour passer LIVE, acteur et date journalisés.

#### Correction incidente — l'URL figée

L'inventaire L1.5 signalait que la fiche du Panel annonçait encore
`api.demo-sbauto.lycarz.com`. **Vérification faite : la livraison n'était pas en
cause.** La destination avait convergé (ACTIVE = `demo-sbauto06.ly-solution.com`,
ancienne RETIRED le 2026-08-06), et `outboundBaseUrl()` lit la destination
active, jamais le champ d'appairage — corrigé et documenté de longue date.

Restait **un seul lecteur** du champ figé : la détection de doublon du
`ProjectWizard`, qui se trompait deux fois — la nouvelle adresse d'un projet
déjà déclaré ne déclenchait aucun avertissement, et l'ancienne, morte, le
faisait croire encore en service. Corrigé. Invariant ajouté :
`PROJECT_RUNTIME_URL_CONVERGES_AFTER_DESTINATION_CHANGE`.

---

### L2 — Doctrine d'environnement · **lot de rupture**

- **Objectif** — supprimer le choix manuel de mode. `environment = config.env`,
  partout, des deux côtés.
- **Dépendances** — L1, et la décision D1.
- **Fichiers probables** — Panel : garde `INTEGRATED_API_ENVIRONMENT_MISMATCH`.
  SB Auto : `integratedApiCatalog.js` · `IntegratedApi.model.js` *(retrait de
  `activeMode`)* · `integratedApi.controller.js` *(retrait de `setActiveMode`,
  `crossModeRisk`, `confirmVerb`)* · `routes/integratedApi.routes.js` ·
  `manager/src/pages/dev/DevIntegrationsPage.tsx` · `docs/INTEGRATED_API.md`
- **Tests** — `INTEGRATED_API_ENVIRONMENT_MISMATCH` est bien un 409 ·
  aucune clé LIVE atteignable depuis une instance TEST · **retrait** des deux
  assertions `crossModeRisk === true` · un `activeMode` résiduel en base est
  ignoré, pas honoré.
- **Migration** — `activeMode` reste en base (donnée historique, comme
  `logicalProjectKey`) mais n'est plus lu. Une instance dont
  `activeMode !== config.env` doit **journaliser un avertissement au boot** :
  c'est la seule façon de repérer les instances en configuration croisée avant
  qu'elles ne changent de comportement.
- **Rollback** — remettre la lecture d'`activeMode`. Réversible tant que L3
  n'est pas livré.
- **Risque** — **ÉLEVÉ.** Toute instance en configuration croisée change de
  comportement. Il faut **inventorier les instances réelles avant de livrer**.
- **GO** — l'inventaire des instances est fait, aucune n'est en croisement, ou
  celles qui le sont ont été migrées d'abord.

---

### L3 — Passerelle de capacités  ✅ **LIVRÉ**

> Document dédié : [CAPABILITY_GATEWAY.md](CAPABILITY_GATEWAY.md).
>
> **Écart assumé avec le GO prévu ci-dessous.** Le critère annonçait
> `billing.invoice.list` ; la capacité migrée est `email.sender.verify`. La
> raison est celle de l'audit L8 §13 : c'est la seule capacité dont l'échec ne
> prive personne d'une notification attendue et dont le rejeu ne peut produire
> aucun doublon. Migrer une lecture Stripe d'abord aurait exigé d'ouvrir le
> chemin Stripe (L6) avant d'avoir éprouvé la passerelle elle-même.
>
> Livré : registre code-first de 11 capacités agrégeant L1, L1.75 et L8 · contexte
> d'invocation dont l'autorité vient du seul bridgeToken · octrois **par
> capacité** remplaçant conceptuellement `PanelIntegratedApi.grants[]` ·
> résolution de credentials sur le coffre L1 · contrat d'adaptateur (table, pas
> de `switch`) · `POST /bridge/v1/capabilities/{code}/invoke` (contrat **1.5.0**,
> additif) · catalogue d'erreurs `CAPABILITY_*` distinguant `FAILED` de
> `UNKNOWN` · journal sans secret · UI de diagnostic et d'octroi.
>
> Non fait, volontairement : aucune migration de provider métier, aucun
> credential projet supprimé, Manager de SB Auto laissé sur son chemin local.
>
> Preuve : 189 assertions sur trois suites, dont un E2E qui entre par le pont
> réel avec un fournisseur HTTP local, et une suite qui tourne en `ENV=PROD`
> pour éprouver la pré-ouverture.

- **Objectif** — un projet peut invoquer une capacité. Aucune n'est encore
  branchée sur un chemin de production.
- **Dépendances** — L1, L2.
- **Fichiers probables** —
  `backend/src/services/capabilities/registry.js` ·
  `.../capability.service.js` (résolution, retry, idempotence) ·
  `backend/src/routes/bridge.routes.js` ·
  `backend/src/bridge/bridgeContract.js` *(nouvelle version de contrat)* ·
  `backend/src/services/capabilities/invocation-log.service.js`
- **Modèles** — `PanelCapabilityInvocation` (§12.2).
- **Tests** — capacité inconnue → 404 · projet non autorisé → 403 · credential
  absent → 409 · idempotence sur rejeu · **aucun secret dans la réponse** ·
  journal complet et sans secret.
- **Migration** — additive, version de contrat de pont incrémentée.
- **Rollback** — retirer la route.
- **Risque** — **moyen** (surface d'API nouvelle, authentifiée par bridgeToken
  existant).
- **GO** — une capacité de lecture (`billing.invoice.list`) fonctionne de bout
  en bout depuis SB Auto TEST, journalisée, sans secret transmis.

---

### L3.1 — Le geste d'ouverture commerciale · ✅ **LIVRÉ**

L1.75 a défini la doctrine. L3 a branché la passerelle dessus. Mais **personne
n'écrivait jamais l'état** : le champ existait, la passerelle le lisait, il
valait éternellement `null` — donc `PREOPENING`, donc refus. Une porte fermée
dont on n'avait pas fabriqué la clé.

#### A. L'autorité — une inversion assumée de la note L1.75

L1.75 annonçait « stocké côté instance, projeté vers le Panel », au nom de
l'autonomie. Cet argument ne tient plus depuis L3 :

1. **L'enforcement a changé de camp.** La passerelle vit dans le Panel. Panel
   indisponible = capacité non exécutée : il n'y a rien à faire respecter
   localement.
2. **Un projet ne doit pas pouvoir DÉCLARER son propre droit de dépenser.** Sous
   autorité locale + projection, le Panel arbitrerait sur une valeur envoyée par
   le projet — exactement ce que la doctrine d'environnement interdit depuis L2.
   Un projet compromis, ou simplement mal déployé, s'ouvrirait lui-même.

**Autorité : le Panel.** L'instance ne connaît pas son état d'ouverture ; elle
demande un verbe, le Panel décide. Conséquence directe sur les phases d'UX :
**il n'y a pas de bouton d'ouverture dans le Manager**, et il ne peut pas y en
avoir — ce serait le projet demandant sa propre ouverture. L'instance apprend la
réponse au seul moment où elle compte : `CAPABILITY_BLOCKED_PREOPENING`, au
refus, avec son motif.

**Conséquence sur la projection.** Il n'y a rien à projeter : la valeur naît
déjà dans la base du Panel. `lastBusinessSyncAt` n'est donc pas concerné — il
observe une réception métier venue du projet, et aucune n'a lieu ici. Fabriquer
une projection aurait créé, dans l'instance, une copie périmée d'une valeur que
personne n'y lit.

#### B. La persistance — quatre champs, une écriture ciblée

`PanelProject.commercialState` (créé en L3, jamais écrit) rejoint
`commercialStateUpdatedAt / UpdatedBy / Reason`. `registryStore.setCommercialState()`
écrit **ces quatre champs et rien d'autre** : `save()` réécrit la fiche entière
depuis un instantané lu plus tôt, et écraserait ce qu'un battement de cœur ou une
projection vient de poser entre la lecture et la décision.

`null` se lit « jamais décidée » et se résout vers `PREOPENING`. La vue
distingue les deux (`neverDecided`) : « personne n'a tranché » et « quelqu'un a
choisi la pré-ouverture » se réparent différemment.

#### C. Les transitions — deux, et aucune automatique

```
PREOPENING → LIVE        geste DEV, contrôles exigés, confirmation
LIVE → PREOPENING        geste DEV, aucun contrôle exigé — frein d'urgence
```

Rien n'ouvre une instance tout seul : ni un contrat signé, ni un déploiement
réussi, ni un fournisseur validé. Réaffirmer un état est **idempotent** et ne
produit aucune trace — une chronologie remplie de « toujours ouvert » se lit
moins bien qu'une chronologie des changements. Chaque changement produit
`COMMERCIAL_OPENED` / `COMMERCIAL_CLOSED` avec acteur, état précédent, état
suivant, motif, et l'environnement **rappelé** — jamais modifié.

#### D. Les contrôles — trois, et pas vingt-cinq

`describeReadinessChecks()` est **séparé** de l'état : l'état reste un champ
simple.

| Contrôle | Pourquoi il rendrait l'ouverture absurde |
|---|---|
| `PAIRED` | aucune instance appairée : il n'y a rien à ouvrir |
| `ENVIRONMENT_KNOWN` | une instance dont on ignore le monde ne peut être qualifiée |
| `REACHABLE_DESTINATION` | sans destination active, elle n'est joignable par personne |

Tout le reste — Stripe mal configuré, contrat absent — se manifeste **à
l'action**, avec un message précis, par la passerelle. L'anticiper ici dirait
« impossible d'ouvrir » là où la vérité est « ouvrable, mais Stripe n'est pas
prêt ». La vingt-cinquième condition bloque un jour une ouverture légitime pour
un motif que personne ne comprend, après quoi on ajoute une dérogation — et le
contrôle ne veut plus rien dire.

Les contrôles gardent **l'ouverture seulement**. Exiger la bonne santé pour
cesser de facturer serait exactement le mauvais sens.

#### E. TEST/PROD — le champ existe dans les deux mondes

Décision explicite : `commercialState` a un sens en TEST, et il y garde le même.
Il ne sélectionne aucun monde, dans aucun sens :

```
TEST + PREOPENING → provider TEST, capacité financière bloquée
TEST + LIVE       → provider TEST                       (jamais PROD)
PROD + PREOPENING → provider PROD, capacité financière bloquée (jamais TEST)
PROD + LIVE       → provider PROD
```

Preuve mécanique : `resolveIntegratedApiEnvironment.toString()` ne contient ni
`commercial`, ni `preopening`, ni `live`, ni `activeMode`.

#### F. L'API et les écrans

```
GET /api/projects/:id/commercial-readiness   tout compte du Panel
PUT /api/projects/:id/commercial-readiness   requirePanelDev
```

Lecture ouverte : « cette instance est-elle ouverte ? » est la deuxième question
quand un paiement est refusé, et ce n'est pas un secret. `PUT` et non `POST` :
le corps porte l'**état visé**, pas un verbe — un rejeu arrive au même endroit,
jamais à l'état inverse.

La carte vit sur l'onglet **Vue d'ensemble** de la fiche, pas dans l'onglet
développeur : « cette instance peut-elle encaisser ? » est la question d'un
gestionnaire. Deux badges, jamais fondus :

```
Environnement technique : PRODUCTION
Ouverture commerciale   : PRÉ-OUVERTURE
```

Le bouton dit **« Ouvrir commercialement »**, jamais « Passer en PROD » :
l'environnement ne se choisit pas (L2), et suggérer le contraire ressusciterait
la doctrine révoquée. Confirmation explicite, motif facultatif conservé dans la
chronologie. La lecture est vivante (`useLiveQuery`, 7 s) — un second DEV, page
ouverte pendant qu'un premier ouvre l'instance, ne reste pas devant une valeur
périmée.

#### G. La preuve

75 assertions (`tests/commercial-readiness-runtime.test.js`), en **`ENV=PROD`**,
sur les vrais services et le **vrai routeur** : un service appelé directement n'a
ni garde d'accès, ni contrôleur — or c'est là que l'ouverture peut fuir. Le
défaut trouvé par cette exigence était réel : **le contrôleur existait, les
routes n'étaient pas montées.**

```
ADMIN lit → 200 · ADMIN ouvre → 403 · rien écrit
PROD + PREOPENING + billing.checkout.create → BLOCKED · adapter calls = 0
PUT DEV { state: LIVE } → 200 → fiche LIVE
même capacité → CAPABILITY_NOT_AVAILABLE (étape ultérieure), plus BLOCKED
PUT DEV { state: PREOPENING } → la passerelle refuse de nouveau, 0 appel
fiche non appairée → 409 PANEL_COMMERCIAL_READINESS_INCOMPLETE, contrôles nommés
environnement : PROD avant, PROD après
```

`signature.request.create` (LEGAL_WRITE, Yousign) est bloquée en pré-ouverture et
autorisée LIVE — **aucune capacité Yousign n'est migrée ici**, seule la jonction
de politique est prouvée.

Invariant retourné : là où la mission demandait `PANEL_OBSERVES_PROJECTED_STATE`,
c'est `PANEL_IS_AUTHORITY` qui est verrouillé — aucune surface tournée vers le
projet (`bridge.routes.js`, `public.routes.js`) n'accepte cet état, et le
contexte d'invocation ne le lit que sur la fiche du Panel.

- **Fichiers** — `services/capabilities/commercialReadiness.service.js` *(nouveau)* ·
  `controllers/capabilities.controller.js` · `routes/projects.routes.js` ·
  `models/PanelProject.model.js` · `models/PanelSupervision.model.js` ·
  `services/registry/registryStore.js` ·
  `frontend/src/components/CommercialReadinessCard.tsx` *(nouveau)* ·
  `frontend/src/pages/ProjectDetailPage.tsx` · `frontend/src/lib/api.ts` ·
  `frontend/src/types.integratedApi.ts`
- **Migration** — additive. Aucune fiche existante n'est touchée : `null` était
  déjà lu `PREOPENING`.
- **Rollback** — démonter les deux routes. La passerelle retombe sur le défaut
  fermé, qui est le comportement d'avant L3.1.
- **Risque** — **faible** en écriture (quatre champs, DEV, additif) ; **élevé en
  conséquence** — c'est le geste qui autorise l'argent réel. D'où la trace
  imputable et la confirmation explicite.

---

### L4 — Arrêt de la diffusion de secrets · ✅ **LIVRÉ**

- **Objectif** — plus aucun secret ne traverse le pont.
- **Dépendances** — L1. Livré juste après, avant L2 et L3, parce qu'il fermait
  une exposition réelle et ne dépendait d'aucune décision produit.

**Chaîne de propagation — inventaire EXHAUSTIF relevé pendant L1.**
C'est la liste de travail de L4 ; aucun de ces fichiers n'a été modifié.

*Côté Panel — production du secret en clair*

| Fichier | Ce qu'il fait |
|---|---|
| `services/company/integratedApi.service.js:294` | `buildApiPayloadFor()` — **le seul point qui déchiffre pour envoyer ailleurs** |
| `…:327` | `publishToProject()` — pousse la charge sur le pont, `audience` = projet |
| `…:355` | `republishToGrantees()` — rediffuse à chaque écriture de clé |
| `…:380` | `apisForProject()` — la charge du bootstrap |
| `…:344` | `emitRevocation()` — tombstone (à CONSERVER : il faut bien révoquer) |
| `services/pairing/pairing.service.js:340-352` | injecte `integratedApis` dans la réponse de bootstrap |
| `bridge/bridgeContract.js:749-762` | `integratedApiConfigSchema` — champ `credentials` |
| `bridge/bridgeContract.js:159` | `INTEGRATED_API_CONFIG` dans les types d'entité |
| `models/PanelIntegratedApi.model.js:43-54` | `grantSchema` — devient un grant de CAPACITÉ |
| `controllers/company.controller.js:227` | `grantsForProject()` — sans secret, peut rester |
| `frontend/src/pages/IntegratedApisPage.tsx` | l'écran de l'ancien coffre (déjà signalé « en remplacement ») |

*Côté SB Auto — réception et stockage*

| Fichier | Ce qu'il fait |
|---|---|
| `services/panelConfiguration/panelConfiguration.service.js:156` | `applyIntegratedApi()` — rechiffre et persiste |
| `…:207` | `applyIntegratedApiChange()` — handler de sync |
| `…:250` | `getProvidedApiCredentials()` — **déchiffre, et n'a AUCUN appelant** |
| `models/PanelConfiguration.model.js:92` | modèle `PanelProvidedApi` |
| `services/panelBridge/bridgeContract.js:491` | `integratedApiConfigSchema` (miroir) |
| `config/bootstrap.js:623, 717, 723` | branchement des handlers + application au bootstrap |
| `controllers/panelBridge.controller.js:65` | `listProvidedApis()` — affichage, **sans valeurs** : peut rester |

**Constat qui rend L4 peu risqué** — `getProvidedApiCredentials()` est le seul
lecteur des secrets reçus, et il n'est appelé par aucun code. Les supprimer ne
casse aucun chemin en service.

**Migration** — purger `PanelProvidedApi.credentials` au premier boot suivant.
**Ce qui a été livré**

*Panel — la source*

| Changement | Fichier |
|---|---|
| **La frontière**, dérivée du registre | [`bridge/providerSecretGuard.js`](../../backend/src/bridge/providerSecretGuard.js) *(nouveau)* |
| Garde posée à l'unique point d'émission, **avant** le journal | [`services/sync/syncCore.service.js`](../../backend/src/services/sync/syncCore.service.js) |
| `integratedApis` retiré de la réponse d'appairage | [`services/pairing/pairing.service.js`](../../backend/src/services/pairing/pairing.service.js) |
| `buildApiPayloadFor` · `publishToProject` · `republishToGrantees` · `emitRevocation` · `apisForProject` **supprimées** ; `decryptSecret` n'y est plus importé | [`services/company/integratedApi.service.js`](../../backend/src/services/company/integratedApi.service.js) |
| `INTEGRATED_API_PUBLISHED` marqué retiré (conservé : des chronologies le portent) | [`models/PanelSupervision.model.js`](../../backend/src/models/PanelSupervision.model.js) |

*SB Auto — la destination*

| Changement | Fichier |
|---|---|
| Modèle `PanelProvidedApi` **supprimé** | `models/PanelConfiguration.model.js` |
| `getProvidedApiCredentials()` **supprimée** (le lecteur déchiffrant sans appelant) | `services/panelConfiguration/panelConfiguration.service.js` |
| `listProvidedApis()` supprimée ; le handler devient `refuseIntegratedApi()` | idem |
| `purgePanelProvidedApis()` — purge idempotente au démarrage | idem + `config/bootstrap.js` |
| `integratedApis` retiré de `/panel-connection/status` ; l'appairage rend `integratedApisRefused` | `controllers/panelBridge.controller.js`, `manager/src/types/index.ts` |

**La garde survit au fournisseur suivant.** Elle ne lit pas une liste de mots :
elle dérive son vocabulaire de `credentialRoles.secret` du registre. Un
cinquième fournisseur déclarant `{ code: 'privateToken', secret: true }` est
couvert sans qu'on touche à la frontière — et `publishableKey`, déclarée
`secret: false`, continue de passer. Un filet supplémentaire reconnaît les
clés à leur **forme** (`sk_live_…`, `whsec_…`, `xkeysib-…`), au cas où l'une
voyagerait sous un nom innocent.

**Rolling deployment** — voir §14 ci-dessous.

- **Migration** — la collection `panelprovidedapis` est **purgée au démarrage**
  du projet. Elle ne dépend d'aucun Panel : une instance hors ligne se nettoie
  elle-même.
- **Rollback** — aucun. On ne remet pas une fuite en place.
- **Risque constaté** — **nul fonctionnellement** : l'audit avait établi que
  ces secrets n'étaient lus par aucun code, et les suites des deux dépôts le
  confirment.
- **GO atteint** — quatre sentinelles dans le coffre du Panel, **zéro
  occurrence** dans le journal de synchronisation, dans toute la base d'un
  projet réel, dans son identité et dans ses écrans.

**Tests** — 2 suites, 76 assertions :
`bridge-provider-secret-boundary` (la frontière, dont l'invariant générique) ·
`provider-secret-sentinel-e2e` (la preuve, avec une instance SB Auto réelle).

#### §14 — La fenêtre de transition, et quand la refermer

Le vocabulaire du pont conserve `INTEGRATED_API_CONFIG`. C'est délibéré : le
retirer serait un changement de **contrat**, mirroité dans les deux dépôts et
dans les spécifications OpenAPI — un lot à lui seul, et surtout un lot qui
casserait le déploiement progressif.

| Combinaison | Comportement | Pourquoi |
|---|---|---|
| **Panel L4 → projet L4** | Aucune entité émise, rien à refuser. | Le cas nominal. |
| **Panel L4 → projet antérieur** | Le champ `integratedApis` de l'appairage est `optional` : le projet ne le voit pas arriver et continue avec ses identifiants **locaux**, qui n'ont pas bougé. | Aucune rupture. |
| **Panel antérieur → projet L4** | L'entité arrive, le projet la **REFUSE** : un avertissement nomme le fournisseur, rien n'est persisté, et l'écriture est acquittée. | Faire échouer le lot bloquerait l'entreprise, les contrats et les médias qui voyagent avec. |
| **Panel antérieur → projet antérieur** | Comportement d'avant L4, inchangé. | Rien n'a été déployé. |

**Quand retirer la tolérance** — quand plus aucune instance de Panel antérieure
à L4 ne tourne, ET que le journal des projets n'a plus produit d'avertissement
`CREDENTIALS_REFUSED` sur un cycle de déploiement complet. Le retrait se fera
avec la suppression de `INTEGRATED_API_CONFIG` du vocabulaire — donc dans un lot
de contrat, pas en passant.

---

### L5 — Registre et réconciliateur de webhooks · ✅ **LIVRÉ** (fondation)

Détail complet : **[WEBHOOK_CONTROL_PLANE.md](WEBHOOK_CONTROL_PLANE.md)**.

- **Objectif** — le Panel possède ses endpoints chez les fournisseurs, sait ce
  qu'ils exposent réellement, et réconcilie l'écart. **Atteint.**
- **Dépendances** — L1 (livré). **L2 n'a PAS été requis** : la doctrine
  d'environnement n'est pas consommée, elle est *appliquée* localement —
  `assertCallbackEnvironment()` refuse une callback d'un autre monde
  (`WEBHOOK_CALLBACK_ENVIRONMENT_MISMATCH`, 409). Rien d'`activeMode` n'a été
  touché : L2 reste entier.
- **Ce qui a été RÉUTILISÉ plutôt que réécrit** — la doctrine du plan de
  contrôle de SB Auto (registre code-first, identification par description,
  dédoublonnage limité au possédé, capture du secret à la création, ordre
  créer → vérifier → retirer) est **portée**, pas copiée : elle est réécrite
  sur les primitives du Panel (coffre chiffré, `resolveBackendUrl()`,
  `runtimeEnvironment()`). **Le dépôt SB Auto n'a pas été modifié.**
- **Fichiers livrés** — `backend/src/services/webhooks/` (registre, callback,
  appartenance, pilotes, secrets, signature, réconciliateur, réception,
  diagnostic) · `routes/providerWebhooks.routes.js` *(public, corps brut, monté
  avant `express.json()`)* · `routes/webhookControlPlane.routes.js` *(interne)*
  · `models/PanelIntegratedApiWebhookBinding.model.js` ·
  `models/PanelProviderWebhookEvent.model.js` · crochet de démarrage dans
  `server.js`, **après** l'ouverture du port et détaché.
- **Modèles** — `PanelIntegratedApiWebhookBinding` (désiré vs observé, index
  unique `(provider, environment)`) et `PanelProviderWebhookEvent` (index
  unique d'idempotence). Aucun corps d'événement n'est conservé.
- **Écart assumé avec §8.5** — la route est
  `/webhooks/providers/<slug>` et non `/webhooks/<provider>` : le préfixe
  distingue une surface *publique appelée par des tiers* des routes du Panel,
  et rend le montage avant `express.json()` lisible dans `app.js`.
- **Écart assumé avec §8.6** — `ExternalProviderEvent` est livré comme
  **registre de réception**, pas comme passerelle de normalisation. La table
  `checkout.session.completed → PAYMENT_SUCCEEDED` appartient à L6 : l'écrire
  ici aurait été faire L6 sous un autre nom.
- **Appartenance** — au-delà de la description canonique, chaque binding frappe
  un `ownershipToken` (UUID) **avant** le premier appel de création. Un endpoint
  n'est supprimable que si ce jeton, ou l'identifiant persisté, le désigne. Un
  autre Panel partageant le compte est reconnu (`PANEL_PEER`) et **jamais
  touché** — sans quoi une recette effacerait l'endpoint de la production.
- **Plafond Stripe** — déclaré (`remoteEndpointLimit: 16`) et vérifié en
  **préflight** : compte saturé → `WEBHOOK_REMOTE_LIMIT_REACHED`, et **aucune
  création tentée**. L'index unique garantit *un* endpoint par compte et par
  monde, quel que soit le nombre de projets — c'est la réponse au risque.
- **Brevo** — le lot L8 a publié `brevo/brevoEventMapping.js` **pour** L5 ;
  ce lot le **consomme** (liste d'événements, comparaison canonique, clé
  d'idempotence composite, réponses « liste vide » déguisées en 404). Aucun
  fichier métier Brevo n'a été modifié.
- **Tests** — `tests/webhook-control-plane.test.js`, 180 assertions, aucun
  appel réseau (`fetchImpl` injecté).
- **Migration** — les endpoints SB Auto restent en place et continuent de
  recevoir. Deux endpoints coexistent volontairement pendant L6/L7/L8.
- **Rollback** — désactiver l'endpoint Panel chez le fournisseur ; SB Auto
  continue de recevoir. Aucun chemin métier n'a bougé.
- **RESTE À FAIRE pour clore le GO** — un événement Stripe **réel** de test
  atteignant un Panel déployé (impossible sans compte et sans domaine public en
  recette). Le chemin complet est éprouvé en simulation fidèle, de la signature
  jusqu'à l'index d'idempotence, y compris par la vraie route HTTP.

---

### L6 — Migration du provider #1 : **Stripe**

Stripe d'abord, parce que c'est le provider dont le plafond d'endpoints est le
plus contraignant et dont la donnée est déjà prête (§11.1).

- **Objectif** — SB Auto n'appelle plus Stripe directement.
- **Dépendances** — L3, L5.
- **Étapes** — dual-read (le projet appelle la capacité, retombe sur le chemin
  local en cas d'échec) → capacité seule → retrait du chemin local → retrait
  des credentials.
- **Tests** — E2E `SB Auto TEST → capacité → Panel TEST → Stripe sandbox` ·
  **preuve qu'aucune clé LIVE n'est atteignable** · Panel indisponible → le
  projet dégrade proprement, sans perte de contrat.
- **Rollback** — repasser le drapeau de dual-read. Possible **tant que les
  credentials locaux ne sont pas supprimés**.
- **Risque** — **ÉLEVÉ** (paiements).
- **GO** — sept jours sans appel Stripe local en journal, et sans incident.

---

### L7 — Migration du provider #2 : **Yousign / Youtrust**

- **Prérequis spécifique** — vérifier les hôtes d'API après le rebranding
  (§8.2, note 3) avant toute écriture.
- **Risque** — **élevé** (blocage de signature de contrat).
- **GO** — même critère que L6, sur un cycle de signature complet.

---

### L8 — Migration du provider #3 : **Brevo**, support et templates

Le plus gros lot fonctionnel (§10) : identité support, templates, résolveurs de
destinataires, suivi de livraison.

- **Risque** — **moyen** (dégrade la notification, jamais un état métier).

#### L8.2 — Migration du runtime : `email.sender.verify` · ✅ **LIVRÉ**

Première capacité Brevo **réellement basculée**. Détail :
[BREVO_CONTROL_PLANE.md](BREVO_CONTROL_PLANE.md) §9.

- **Ce qui a basculé** — le diagnostic « Connexion Brevo » du Manager. Il
  n'interroge plus Brevo avec la clé du projet : il demande
  `email.sender.verify` au Panel, qui choisit le monde, ouvre son coffre et
  parle au fournisseur.
- **Ce qui n'a PAS bougé** — `email.send_template` reste sur le chemin local du
  projet. Voir « le partage temporaire » ci-dessous.
- **Aucun repli** — si le Panel est injoignable, non appairé, ou si l'octroi
  manque, le diagnostic est **indisponible**. Il ne retombe pas sur la clé
  locale : un repli afficherait « connexion réussie » en ayant éprouvé une clé
  qui ne sert plus à rien, pendant que la vraie reste inconnue. Deux autorités,
  et c'est toujours la mauvaise qui répond.
- **Le pilote local a été RETIRÉ, pas contourné** — `testBrevo` local,
  `safeProviderMessage`, `describeBrevoPlan` sont supprimés du projet, et une
  garde statique vérifie qu'aucun `api-key` Brevo ne subsiste dans le testeur
  de connexion. Tant que le code existe, quelqu'un le rebranche « le temps de
  dépanner ».
- **L'état local n'est plus estampillé** — un test délégué n'écrit plus
  `verified: true` sur le credential du projet. Ce serait un mensonge daté :
  une clé déclarée prouvée que personne n'a essayée, et qu'un opérateur
  garderait sur cette foi. L'état reste **intact** — ni confirmé, ni infirmé.
- **Preuve** — `tests/brevo-verify-migration-e2e.test.js` (41 assertions) :
  vrai Panel, vraie instance SB Auto, vrai appairage, appel HTTP sur **la route
  du Manager** avec un vrai jeton DEV, faux Brevo qui note quelle clé arrive.
  Trois sentinelles : clé Panel TEST, clé Panel PROD, clé legacy du projet.
  Seule la première atteint le fournisseur, jamais les deux autres.

##### Le partage temporaire, et pourquoi il est assumé

| Geste | Autorité | Raison |
|---|---|---|
| « Connexion Brevo » (diagnostic) | **Panel** | lecture pure, rejouable, sans destinataire — aucun utilisateur ne perd de message si elle se trompe |
| Envoi transactionnel (`send_template`) | **projet** | exige le magasin de modèles et d'identités expéditrices du Panel, qui n'existe pas encore |

Ce partage est visible à l'écran : la carte Brevo du Manager dit que la clé
appartient à la plateforme, et le bouton s'appelle « Connexion plateforme
Brevo ». Un libellé resté générique aurait laissé croire qu'il testait le
credential affiché juste au-dessus.

##### Ce qui reste avant `email.send_template`

`capabilityRegistry` la déclare `migrated: false`, et ce n'est pas un oubli de
calendrier : trois briques manquent, chacune structurante.

1. **Magasin de modèles du Panel.** L8 a tranché `TEMPLATE_AUTHORITIES.PANEL` :
   le contenu vit chez nous, versionné, et `templateId` est interdit dans le
   corps envoyé à Brevo. Or les cinq modèles du parc vivent aujourd'hui dans
   `EmailTemplate` / `EmailTemplateVersion` **côté projet**, avec un éditeur.
   Déplacer l'autorité sans déplacer l'éditeur retirerait une fonction à
   l'exploitant — « migrer sans perte fonctionnelle » l'interdit.
2. **Magasin d'identités expéditrices par projet.** `brevoSenderIdentity.js`
   fixe le contrat (forme, validation, portée) et **ne persiste rien** :
   `lookup` est injecté. Le stockage reste à écrire.
3. **Registre d'idempotence des envois.** Brevo n'offre aucune clé
   d'idempotence sur `/smtp/email` : la déduplication est entièrement la nôtre,
   sur `operationId`, avec un index unique côté Panel.

Tant que ces trois briques n'existent pas, `email.send_template` refuse par
`CAPABILITY_NOT_AVAILABLE` — un refus honnête, pas un chemin à moitié branché.

---

### L9 — Migration du provider #4 : **Hostinger** · ✅ **LIVRÉ**

> Document dédié : [HOSTINGER_CONTROL_PLANE.md](HOSTINGER_CONTROL_PLANE.md).

**L'annonce ci-dessous était fausse, et l'audit L9 l'a établi :**

> ~~Le seul consommateur est le moteur de déploiement du Panel lui-même (§9.1) :
> c'est en réalité une **implémentation**, pas une migration.~~

Le Panel n'injecte **aucun** `dnsProvider` — sa phase DNS existe mais n'est
câblée nulle part. Le seul appelant réel d'Hostinger est le contrôleur de
déploiement de **SB Auto**, avec la clé **du projet**. L9 est donc une vraie
migration — et la seule qui retire réellement un credential d'un projet.

#### L9 — fondation

Trois verbes (`dns.zone.resolve`, `dns.records.read`, `dns.record.ensure`),
leur transport, leurs adaptateurs, et le contrôle d'appartenance :

```
UN CREDENTIAL GLOBAL N'EST PAS UN ACCÈS GLOBAL.
```

Le compte Hostinger du Panel détient le portefeuille de **tous** les clients.
Sans ce contrôle, centraliser aurait **aggravé** la situation d'origine, où
chaque projet détenait au moins une clé n'ouvrant que son propre compte.
L'appartenance vient de `PanelProjectDestination` — la relation canonique
`projectId → hôte`, que le projet ne peut pas écrire lui-même.

#### L9.1 — câblage et bascule · ✅ **LIVRÉ**

- **Les trois verbes sont servis** — au registre de la passerelle, adaptateurs
  branchés, alignement **bidirectionnel** (registre ↔ catalogue L9 ↔ registre
  L1 ↔ table d'effets). L'entrée locale `dns.record.ensure` qui préexistait a
  été retirée : elle annonçait `SAFE_RETRY` sur une écriture qu'aucune clé
  d'idempotence ne protège.
- **Le repli est devenu une liste blanche** — seul « ce Panel ignore le verbe »
  autorise encore la clé locale. Un délai dépassé, une panne, un refus ferment
  le chemin. L'ancienne liste noire laissait tout le reste retomber sur le
  secret qu'on est précisément en train de retirer.
- **Le diagnostic suit le chemin réel** — le bouton « Tester Hostinger » du
  Manager passe par la capacité dès qu'un Panel est appairé, et n'estampille
  plus la clé locale. Même doctrine qu'en L8.2.
- **Preuve** — `hostinger-control-plane.test.js` (118 assertions) et
  `hostinger-dns-cutover-e2e.test.js` (62 assertions, chaîne réelle de bout en
  bout, `PUT` laissé sans réponse compris).
- **Incident de recette corrigé au passage** — la suite L9 existait mais
  **n'était inscrite dans aucun runner** : la suite complète annonçait « tout
  vert » sans l'avoir jouée. Même incident qu'au lot L8.

- **Reste ouvert** — la fenêtre de déploiement progressif, et donc la clé
  `apiToken` du projet. `NO_LOCAL_HOSTINGER_RUNTIME_CALL_AFTER_CUTOVER` n'est
  pas encore vrai : trois sorties locales subsistent, nommées, et un test
  échoue si une quatrième apparaît.
- **Risque** — **faible** en écriture (aucune orchestration déplacée) ;
  **réel en exploitation** — un projet sans octroi ni destination `ACTIVE` perd
  son DNS automatique, et le rapport le dit.

---

### L10 — Retrait des credentials projet

- **Objectif** — `IntegratedApi` disparaît de SB Auto ; la page Manager devient
  un diagnostic (§14).
- **Dépendances** — L6 à L9 tous en GO.
- **Critère absolu** — **zéro appel fournisseur local en journal sur 30 jours**
  avant toute suppression.
- **Rollback** — aucun. C'est le point de non-retour, et il doit être franchi
  en connaissance de cause.

---

## 14. La page Manager cible

Aujourd'hui, `DevIntegrationsPage.tsx` (376 lignes) contient des champs de
saisie de secrets, un sélecteur TEST/PROD, un verbe de confirmation, et une
bannière de risque croisé.

Après L10, elle ne contient plus rien de tout cela.

```
Environnement de cette instance : TEST
Toutes les intégrations sont fournies par le Panel.

  Stripe      Mode : TEST    ● Disponible     vérifié il y a 4 min
  Brevo       Mode : TEST    ● Disponible     vérifié il y a 4 min
  Yousign     Mode : TEST    ○ Indisponible   credential absent côté Panel
  Hostinger   Mode : TEST    ● Disponible     vérifié il y a 12 min

  Capacités disponibles pour ce projet : 9
  [Diagnostic]  [Contacter le support]
```

Ce qui reste : l'environnement (constaté, non modifiable), l'état par provider,
la date de dernière vérification, la liste des capacités accordées, un
diagnostic, un contact support.

Ce qui disparaît : tout champ secret, tout sélecteur d'environnement, tout
jeton, tout bouton « Tester la connexion » (le test appartient au Panel), la
bannière de risque croisé.

L'information vient d'une capacité de lecture — `integrations.describe` — que
le projet interroge. Il n'a **aucune** connaissance locale à afficher.

---

## 15. Stratégie de test

| Suite | Ce qu'elle prouve | Lot |
|---|---|---|
| `integrated-api-catalog` | Catalogue conforme, providers typés | L1 |
| `integrated-api-vault` | Chiffrement au repos, aucun secret dans `/api` | L1 |
| `environment-routing` | `config.env` seul décide ; `INTEGRATED_API_ENVIRONMENT_MISMATCH` = 409 | L2 |
| `credential-isolation` | Une instance TEST **ne peut pas** atteindre une clé LIVE | L2 |
| `no-secret-leakage` | **Aucune** charge utile de pont ne contient de valeur | **L4, en premier** |
| `capability-invocation` | Autorisation, idempotence, retry, journal | L3 |
| `webhook-signature` | Valide / invalide / rejeu / horodatage hors tolérance | L5 |
| `webhook-reconciliation` | No-op / création / URL changée / doublon / endpoint étranger intact | L5 |
| `deployment-domain-changed` | Changement de domaine → réconciliation, ancien retiré après vérification | L5 |
| `provider-unavailable` | 5xx fournisseur → dégradation propre, jamais de corruption | L3, L5 |
| `credential-rotation` | Rotation sans interruption d'appel | L1 |
| `project-offline` / `panel-offline` | Chacun dégrade sans perte d'état métier | L6 |
| `rollback` | Le retour au chemin local fonctionne à chaque étape | L6-L9 |

### L'E2E indispensable

```
SB Auto TEST
  └─▶ capability billing.checkout.create
        └─▶ Panel TEST
              └─▶ Stripe sandbox                        ✓ attendu

SB Auto TEST
  └─▶ capability billing.checkout.create
        └─▶ Panel PROD                                  ✗ BRIDGE_ENVIRONMENT_MISMATCH

Panel TEST, credential set PROD demandé
        └─▶ ✗ INTEGRATED_API_ENVIRONMENT_MISMATCH
```

Il ne suffit pas de prouver que le chemin nominal marche. Il faut prouver
qu'**aucune clé LIVE n'est atteignable** depuis une instance TEST — c'est
l'assertion qui justifie tout le chantier, et elle doit être écrite avant L6.

Le harnais existe : `Panel/tests/helpers/sbauto-instance.mjs` et
`sbauto-remote.js` savent déjà lancer une instance SB Auto réelle contre un
Panel réel.

---

## 16. Risques

| # | Risque | Gravité | Atténuation |
|---|---|---|---|
| R1 | La doctrine actuelle (`activeMode` libre) est documentée, implémentée **et testée**. La révoquer casse des tests verts. | **Haute** | Décision écrite D1 avant tout code. L2 retire les assertions en même temps que le comportement. |
| R2 | Une instance réelle est peut-être en croisement (`ENV=TEST` × `Stripe PROD`). | **Haute** | Inventaire des instances avant L2. Avertissement au boot pendant toute la durée de L2. |
| R3 | Plafond Stripe de **16 endpoints** par compte et par mode. | Moyenne | Inventaire en préflight de L5. La centralisation résout le problème de fond. |
| R4 | Les secrets de webhook Stripe et Yousign ne sont **pas relisibles** : recréer un endpoint invalide l'ancien secret. | Moyenne | Ordre imposé en L5 : créer → vérifier → retirer. Jamais l'inverse. |
| R5 | Yousign devenu **Youtrust** ; hôtes d'API non confirmés. | Moyenne | `baseUrl` déjà éditable en base. Vérification en prérequis de L7. |
| R6 | Le Panel devient un point de défaillance unique pour les paiements et la signature. | **Haute** | Dual-read en L6/L7. Aucune suppression de credential local avant 30 jours de preuve. |
| R7 | Brevo n'offre **aucune signature cryptographique**. | Moyenne | Secret partagé + allowlist d'IP, comme aujourd'hui. Ne jamais présenter un webhook Brevo comme prouvé. |
| R8 | Provisionnement double (Panel TEST et Panel PROD) oublié. | Faible | Runbook en L1, health check qui signale un credential set absent. |
| R9 | Perte du cas légitime `App PROD × Stripe TEST` (recette avant ouverture). | Moyenne | Décision D2 : concevoir un remplacement métier avant L2. |

---

## 17. Décisions à prendre

Aucune ne peut être tranchée par l'audit : ce sont des choix de produit.

| # | Décision | Recommandation |
|---|---|---|
| **D1** | Révoque-t-on la doctrine « mode fournisseur ≠ environnement applicatif » ? | **Oui.** C'est le prérequis de tout le chantier. Sans elle, la centralisation n'apporte aucune garantie. |
| **D2** | Que devient le cas légitime `App PROD × Stripe TEST` ? | Un **état métier de contrat** (« pré-ouverture ») plutôt qu'un réglage de credential. À concevoir avant L2. |
| **D3** | Livre-t-on L4 (arrêt de la fuite de secrets) **avant** L2 et L3 ? | **Oui.** Il est indépendant, à faible risque, et supprime une exposition réelle immédiatement. |
| **D4** | Le Panel devient-il un point de défaillance dur pour les paiements ? | Accepter, avec dual-read prolongé et un mode dégradé documenté. L'alternative — un cache de credentials côté projet — annulerait le bénéfice. |
| **D5** | `PROJECT` et `PROJECT_ENVIRONMENT` : valeurs admises dès L1 ? | **Oui pour l'enum, non pour l'implémentation.** Aucun provider actuel n'en relève ; réserver la valeur évite une migration de schéma plus tard. |

---

## 18. Documents

**Créé** — ce fichier.

**À modifier en L0** — `Panel/docs/ARCHITECTURE_CONTEXT.md` : un renvoi vers ce
document, présenté comme un **cadrage**, pas comme un état livré.

**À modifier plus tard, lot par lot** —
`Panel/docs/architecture/22_DATA_MODEL.md` (§C4) ·
`Panel/docs/architecture/21_PROJECT_CAPABILITIES.md` ·
`Panel/docs/architecture/24_ENVIRONMENT_AND_DOMAINS.md` ·
`SB Auto 06/docs/INTEGRATED_API.md` (§0, à réécrire en L2) ·
`SB Auto 06/docs/ARCHITECTURE_CONTEXT.md`.

---

## 19. Sources

Documentation officielle consultée pour §8.2 :

- [Stripe — Webhook Endpoints API](https://docs.stripe.com/api/webhook_endpoints)
- [Stripe — Create a webhook endpoint](https://docs.stripe.com/api/webhook_endpoints/create)
- [Brevo — Create a webhook](https://developers.brevo.com/reference/createwebhook)
- [Brevo — Get all webhooks](https://developers.brevo.com/reference/getwebhooks-1)
- [Brevo — How to use webhooks](https://developers.brevo.com/docs/how-to-use-webhooks)
- [Yousign / Youtrust — Managing webhooks](https://developers.youtrust.com/docs/webhooks)
- [Yousign / Youtrust — Webhook subscriptions](https://developers.youtrust.com/docs/subscription)
- [Yousign becomes Youtrust](https://youtrust.com/yousign-becomes-youtrust)

Points **non confirmés** par la documentation officielle, à vérifier avant le
lot concerné :

- Plafond de webhooks Brevo par compte (l'UI l'évoque, la doc ne le chiffre pas).
- Politique de retry exacte de Yousign (`auto_retry` existe, le détail n'est pas publié).
- Persistance de la `secret_key` Yousign après création (le code suppose « création seulement » ; à confirmer).
- Stabilité des hôtes `api.yousign.app` / `api-sandbox.yousign.app` après le rebranding.

---

## 20. GO / STOP

**Recommandation : GO conditionnel sur L1.**

Ce qui le justifie :

- L'architecture cible est **compatible** avec le code existant. Les trois
  briques les plus délicates — autorité d'environnement, URLs runtime,
  coffre chiffré — sont déjà livrées et testées côté Panel.
- Le réconciliateur de webhooks, le registre code-first et les adaptateurs
  distants existent déjà côté SB Auto, sous une forme générique. Ils se
  **déplacent**, ils ne se réécrivent pas.
- La donnée financière porte déjà `environment`, `providerMode` et les
  identifiants externes. Le bouton « Rembourser » n'attend qu'un chemin d'appel.
- L1 est additif, sans consommateur, et intégralement réversible.

Ce qui conditionne le GO :

1. **D1 tranchée par écrit.** Sans elle, L2 est impossible et L1 construit une
   fondation dont on ignore la doctrine.
2. **Inventaire des instances réelles** — combien tournent, dans quel
   environnement, avec quel `activeMode` par provider. Sans cet inventaire, R2
   n'est pas atténué.
3. **D3 tranchée.** Si L4 passe avant L2, l'ordre des lots change.

**Ce qui appellerait un STOP** : si D1 est refusée. Un Panel qui centralise les
credentials tout en laissant chaque projet choisir son monde n'apporte aucune
garantie nouvelle — il ajoute seulement un intermédiaire. Mieux vaudrait alors
ne rien centraliser du tout.

**L1 n'est pas commencé.**
