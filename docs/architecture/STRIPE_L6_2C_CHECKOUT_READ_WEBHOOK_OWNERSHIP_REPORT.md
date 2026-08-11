# L6.2C — Checkout Retrieve + Webhook Ownership Routing

**Date** 2026-08-12 · **Périmètre** `billing.checkout.retrieve` + routage des webhooks
par appartenance. Aucune écriture supplémentaire migrée.

> **La doctrine du lot, en deux phrases.**
> Posséder un identifiant Stripe n'est pas être autorisé.
> Stripe prouve l'événement par sa signature ; notre registre de liens prouve à qui
> appartient la ressource. Ce sont deux responsabilités distinctes, et rien ne doit
> les confondre.

---

## A. Baseline

| | Panel | SB Auto 06 |
|---|---|---|
| HEAD constaté | `20d200d` | `6a7123a` |
| `git status` | **propre** | **propre** |
| Ascendance vérifiée | `a11f8c3` (L6.2B) → `20d200d` (L8.4C) | `1b13268` (L6.2B) → `6a7123a` (L8.4C) |

Les baselines documentaires du brief correspondent aux HEAD réels. Aucun `reset`,
`checkout`, `restore`, `clean` ni `stash` n'a été utilisé.

## B. Travaux parallèles détectés

**Aucun.** Les deux arbres étaient propres au départ et le sont restés hors de mes
fichiers — c'est la première fois de ce programme. Le chantier Brevo L8.4C est
committé et a refermé sa propre dérive : `bridge-conformity` (Panel), rouge au lot
précédent à cause de `EMAIL_DELIVERY_EVENT`, est **vert** (59/0) sans intervention.

## C. Call graph `retrieveCheckoutSession` — AVANT

Cinq occurrences, dont **trois appels runtime** :

| # | Site | Parcours | Identifiant disponible | Classe |
|---|---|---|---|---|
| 1 | `payment.service.js:480` (`reconcileLaunchFeePayment`) | **frais** | `Payment.stripe.checkoutSessionId` + `Payment.idempotencyKey` | migrable |
| 2 | `subscription.service.js:374` (`createOrReuseSubscriptionCheckout`) | abonnement | `contract.stripe.subscription.checkoutSessionId` | bloqué |
| 3 | `subscription.service.js:433` (`retrouverSubscriptionId`) | abonnement | idem | bloqué |

Les deux autres sont la définition du provider (`stripe.provider.js:104`) et le stub.

**Environnement** : `resolveProviderEnvironment('STRIPE')`, résolu côté projet.
**Clé lue** : `getCredential('STRIPE','secretKey')` dans le coffre local du projet.
**Portée réelle** : le projet pouvait lire **n'importe quel** `cs_…` accessible à son
compte Stripe — aucune notion d'appartenance n'existait de son côté.

**Bindings disponibles** : depuis L6.2B, toute session de frais créée par le Panel est
liée à la création. Les sessions antérieures ne le sont pas.

## D. Call graph — APRÈS

```
reconcileLaunchFeePayment
  → checkoutCapability.readCheckoutViaPanel
    → capabilityClient.invokeCapability('billing.checkout.retrieve')
      → HTTP /bridge/v1/capabilities/…/invoke
        ↓ PANEL
        passerelle (capacité → projet → monde → droit → politique → entrée → coffre)
        → stripeAdapters.checkoutRetrieve
           ├ assertOwnedResource(CHECKOUT_SESSION, cs_…)   ← AVANT tout contact
           └ stripeTransport.retrieveCheckoutSession(clé PANEL)
        → DTO minimisé
```

## E. Appels migrés

Le **1** — la réconciliation des frais de lancement. C'était le dernier appel du
parcours de frais qui touchait Stripe avec la clé du projet, et le plus trompeur :
une lecture paraît inoffensive, alors qu'elle interrogeait potentiellement un compte
qui n'est plus celui où la session a été créée. **Ne rien y trouver ne dit pas que la
session n'existe pas ; cela dit qu'on a demandé au mauvais endroit.**

## F. Appels restés locaux, et pourquoi

Les **2** et **3**, tous deux sur l'abonnement. Ils lisent une session
`mode: subscription` créée localement, qui référence un Customer et un Price créés
localement. Ces ressources n'ont **aucun binding** — le Panel n'en a jamais créé.
Les migrer donnerait une lecture qui refuserait systématiquement, ou pire, qui
accepterait sans preuve. Classés `BLOCKED_BY_CUSTOMER_OWNERSHIP` (§U), pas oubliés :
un test statique vérifie qu'ils sont **toujours** là, pour que leur disparition
silencieuse soit impossible.

## G. L'appartenance précède-t-elle l'appel Stripe ?

**Oui, et c'est vérifié sur le code, pas seulement sur le comportement.** Le contrôle
statique compare les *positions* de `assertOwnedResource` et de
`retrieveCheckoutSession` dans le corps de la fonction, et vérifie que la première est
bien **attendue** (`await`) — un `assertOwnedResource(...)` sans `await` laisserait
partir l'appel Stripe pendant que la vérification court encore. C'est le défaut le
plus facile à introduire et le plus invisible.

## H. Peut-on lire la session d'un autre ?

Non. Le projet B, réel, appairé, avec l'octroi `billing.checkout.retrieve`, présentant
le **vrai** identifiant de session de A : refusé.

## I. Les trois refus sont-ils indistinguables ?

Oui — même code (`CAPABILITY_RESOURCE_NOT_OWNED`), même message, même statut (403),
même structure. Vérifié champ par champ pour *inconnue*, *à un autre*, *révoquée*.
Aucun ne nomme un projet ni ne cite l'identifiant présenté.

**Et surtout** : sur les trois, le compteur du faux Stripe ne bouge pas d'une unité.
Le Panel ne demande même pas au fournisseur si la ressource existe — la durée de
réponse elle-même ne doit rien trahir.

## J. Quelle clé atteint le fournisseur ?

Une seule, sur **tous** les appels de la suite : celle du coffre du Panel. La
sentinelle projet n'apparaît nulle part — ni dans les appels, ni dans les bases des
deux instances.

## K. Le DTO

Sept champs, **exactement** :

```
checkoutSessionId · status · paymentStatus · url · expiresAt
paymentIntentId · customerId
```

Établis sur ce que `settleFromSession` lit réellement côté projet, plus l'identifiant
et l'URL du parcours de retour, plus l'échéance. `paymentIntentId` et `customerId`
s'ajoutent au contrat L6.1 parce que sans eux la réconciliation marquerait un paiement
PAYÉ sans savoir quelle transaction l'a payé.

Ne traversent pas : ligne d'articles, adresse client, moyens de paiement, montant
total, compte, objet brut — et **pas les metadata**, corroboratives par nature, dont
la présence inviterait un appelant à s'en servir comme d'une autorité.

## L / M. Endpoint et secret webhook

**Inchangés, tous les deux.** Aucune écriture ni lecture sur `/v1/webhook_endpoints`,
aucun secret stocké ou tourné — vérifié dynamiquement (compteur du faux Stripe) et
statiquement (le routage et la réception n'importent aucune de ces primitives).

Le Panel expose depuis L5 `/webhooks/providers/stripe` et souscrit les 13 événements ;
SB Auto conserve son propre endpoint. Le lot travaille **après** la vérification
cryptographique, dans le routage — pas dans la configuration du fournisseur. Aucune
fenêtre de perte n'est ouverte.

## N. Comment `projectId` est-il déterminé ?

```
event.data.object.id  →  findBinding(environment, resourceType, resourceId)  →  projectId
```

L'environnement vient du **runtime**, jamais de `livemode` : laisser le corps choisir
le monde permettrait à un événement de recette de désigner un lien de production.

## O. Les metadata peuvent-elles décider ?

**Non.** Elles sont lues — il le faut, pour détecter une divergence — et isolées dans
une fonction dédiée dont le résultat ne sert **qu'à comparer**. Le contrôle statique
vérifie que tout `projectId` rendu vient d'un `binding.` ou vaut `null`.

Quand elles contredisent le lien : le lien gagne, l'événement part vers son vrai
propriétaire, et la divergence est consignée (`claimMismatch`). C'est un signal de
sécurité, pas une erreur à réparer en silence.

## P. Ressource sans binding

`UNOWNED` — attribuée à personne, y compris quand les metadata la réclament. Aucun
balayage des projets, aucune seconde requête chez Stripe, aucun « premier qui
correspond », aucun binding créé à la volée depuis une donnée fournisseur.

L'événement reste **traçable** : enregistré, vérifié, daté, avec son motif. Ni perdu,
ni silencieux, et investigable par un index dédié.

Trois verdicts négatifs distincts en base — `UNOWNED`, `REVOKED`, `NOT_ROUTABLE` —
parce qu'un diagnostic interne doit distinguer ce qu'un refus externe doit confondre.

## Q. Un webhook de A peut-il muter B ?

Non, et pour une raison plus forte qu'un contrôle : **ce lot ne mute aucun projet.**
Le routage résout et enregistre ; il n'émet aucun changement dans le journal durable
et n'écrit dans aucune collection métier (vérifié statiquement).

C'est délibéré. Pendant la coexistence, SB Auto reçoit les mêmes événements sur son
propre endpoint et y règle ses paiements. Projeter ici le même fait appliquerait la
même vérité **deux fois par deux chemins** — exactement ce que §14 interdit. Le jour
où l'endpoint du projet sera retiré, il restera à brancher une projection sur un
destinataire déjà connu et éprouvé.

## R. Doublons webhook

L'idempotence de L5 est **réutilisée telle quelle** : index unique
`(provider, environment, providerEventId)`, et c'est l'index qui tranche.

Une correction a été faite : la résolution d'appartenance est désormais **sautée sur
un rejeu**, comme l'acheminement Brevo. Recalculer réécrirait les mêmes champs pour
rien et romprait la règle du fichier — après l'idempotence, un rejeu ne produit plus
aucun effet, pas même un effet inoffensif.

## S. TEST / PROD

Strictement séparés. Un lien TEST n'ouvre rien en PROD (`NO_BINDING`), et le **même**
identifiant lié à deux projets différents dans les deux mondes reste deux objets
distincts avec deux propriétaires distincts — prouvé.

## T. `billing.checkout.create` reste-t-elle conforme ?

Oui. Les 106 assertions de L6.2B rejouées intégralement : crash avant binding, réponse
perdue, UNKNOWN, au-delà de 23 h, concurrence 8-way, cross-tenant, adoption, clé
d'idempotence, une seule session. Plus, dans l'E2E de ce lot, la reprise et le refus
explicite de l'abonnement.

## U. Résidus Stripe locaux

| Méthode | Classe | Appels runtime |
|---|---|---|
| `createCheckoutSession` (frais) | **MIGRATED** (L6.2B) | 0 |
| `retrieveCheckoutSession` (frais) | **MIGRATED** (L6.2C) | 0 |
| `createCheckoutSession` (abonnement) | BLOCKED_BY_CUSTOMER_OWNERSHIP | 1 |
| `retrieveCheckoutSession` (abonnement) | BLOCKED_BY_CUSTOMER_OWNERSHIP | 2 |
| `createCustomer` | BLOCKED_BY_CUSTOMER_OWNERSHIP | 1 |
| `createProduct` · `createPrice` | BLOCKED_BY_CUSTOMER_OWNERSHIP | 1 · 1 |
| `retrievePaymentIntent` | STILL_REQUIRED — aucun binding PAYMENT_INTENT | 2 |
| `retrieveSubscription` · `listSubscriptions` | BLOCKED_BY_OTHER_RESOURCE_OWNERSHIP | 2 · 1 |
| `retrieveInvoice` · `listInvoices` | BLOCKED_BY_OTHER_RESOURCE_OWNERSHIP | 1 · 1 |
| `createBillingPortalSession` | STILL_REQUIRED — hors périmètre | 1 |
| `cancelSubscriptionAtPeriodEnd` · `cancelSubscriptionNow` | STILL_REQUIRED — lot dédié | 1 · 1 |

Aucun pilote encore requis n'a été supprimé.

## V. Architecture proposée pour `customer.ensure` — *audit seul, non implémenté*

**Ce que le code dit aujourd'hui** (`subscription.service.js:70`) :

```js
if (contract.stripe.customerId) return contract.stripe.customerId;
await provider.createCustomer({…}, `customer-${contract._id}-${mode}`);
```

1. **Quelle entité possède le Customer ?** Aujourd'hui le **contrat** — `customerId`
   est stocké dans `Contract.stripe`, et la clé d'idempotence porte `contract._id`.
2. **Un Customer par projet et par monde ?** Non, et c'est le point central : un
   projet ayant eu trois contrats successifs a **trois Customers Stripe**. La
   projection du Panel porte d'ailleurs `previousContracts`.
3. **Plusieurs Customers pour un même projet existent-ils déjà ?** Oui, par
   construction. Toute conception qui supposerait l'unicité est fausse dès le départ.
4. **Quel `operationId` ?** `customer-${contract._id}-${mode}` existe déjà, est stable
   et persistant. Le réutiliser — comme L6.2B a réutilisé `Payment.idempotencyKey` —
   fait que les Customers créés avant la bascule restent nommables.
5. **Adopter un Customer existant sans croire les metadata ?** La seule preuve non
   falsifiable est que le Panel l'ait créé. Pour l'existant, `IMPORTED_WITH_PROOF`
   (L6.2A) avec vérification explicite et imputable — **jamais** un backfill
   automatique sur `metadata.contractId`, éditable depuis le tableau de bord.
6. **Un binding CUSTOMER ?** Oui : `CUSTOMER` figure déjà dans les sept types de
   L6.2A, l'index unique s'y applique tel quel. Aucun modèle nouveau.
7. **Ce que cela débloque** : `billing.checkout.create` en `SUBSCRIPTION` (via Price),
   `billing.invoice.list`, `billing.subscription.retrieve`, et le routage des
   événements `invoice.*` et `customer.subscription.*`.
8. **Price** : **par contrat et par version**, jamais global —
   `ensureProductAndPrice` invalide son cache sur (version, périodicité, montant)
   parce qu'un Price Stripe est immuable. Un Price global mélangerait les tarifs de
   plusieurs clients.
9. **Risques cross-tenant** : le Customer porte l'adresse et les moyens de paiement
   d'une personne réelle — une erreur d'appartenance y coûte plus cher que sur une
   session. Et une Subscription mal attribuée prélève de l'argent sur la mauvaise
   carte. `listInvoices` devra **contraindre** la requête sortante par un identifiant
   possédé, jamais filtrer une réponse déjà obtenue (doctrine L6.2A §listes).

**Ordre proposé pour L6.2D** : binding CUSTOMER → `billing.customer.ensure` →
adoption explicite de l'existant → puis seulement Price/abonnement.

## W. Ce qui bloque encore l'abonnement

Une session `mode: subscription` référence un **Customer** et un **Price** créés avant
elle. Tant que ces deux familles n'ont pas de binding, migrer la session produirait une
session référençant les objets d'un autre compte — et l'échec surviendrait devant un
client qui paie. Le refus reste explicite et testé.

## X. Tests ciblés

| Suite | Résultat |
|---|---|
| `stripe-checkout-read-webhook-e2e` *(nouveau, 15 sections)* | **85 / 0**, stable ×3 |
| `stripe-ownership-invariants` *(nouveau, 7 contrôles statiques)* | **26 / 0** |
| `stripe-checkout-cutover-e2e` (L6.2B, non-régression) | 106 / 0 |
| `stripe-control-plane` · `stripe-resource-ownership` | 101 / 0 · 89 / 0 |
| `capability-gateway` · `capability-gateway-e2e` · `capability-preopening` | 113 / 0 · 66 / 0 · 27 / 0 |
| `commercial-readiness` · `commercial-readiness-runtime` | 74 / 0 · 75 / 0 |
| `webhook-control-plane` | 230 / 0 |
| `integrated-api-provider-registry` · `integrated-api-control-plane` | 67 / 0 · 65 / 0 |
| `bridge-conformity` · `architecture` | 59 / 0 · 31 / 0 |

**SB Auto** — `payments-flow` 70/0 · `billing-flow` 46/0 · `stripe` 29/0 ·
`subscription-flow` 73/0 · `subscription-reconcile` 48/0 ·
`contract-billing-signature` 31/0 · `contract-lifecycle` 46/0.

## Y. Suites complètes

| Dépôt | Résultat |
|---|---|
| **Panel** — `tests/run-all.js` | **96/96 fichiers OK**, zéro échec |
| **SB Auto** — `npm test` (79 suites) | **exit 0**, zéro échec |

### Un rouge transitoire, et son explication complète

Le **premier** passage complet de SB Auto a rendu 2 échecs dans
`contracts.test.js` : « WebhookEvent dupliqué rejeté (E11000) » et « Invoice
dupliquée rejetée (E11000) ». Je ne les ai ni ignorés ni réparés — je les ai
expliqués, parce qu'un rouge non expliqué invalide un PASS.

**Ce que c'est.** Le troisième cas dans ce programme du même piège Mongoose :
`webhookEventSchema.index({…}, { unique: true })` est construit EN TÂCHE DE FOND,
et le test insère deux fois sans avoir attendu `Model.init()`. Sous charge, la
seconde insertion passe avant que l'index n'existe.

**Pourquoi ce n'est pas L6.2C**, par trois preuves indépendantes :

1. `contracts.test.js` et les quatre modèles qu'il exerce (`WebhookEvent`,
   `Invoice`, `Contract`, `Payment`) sont **byte-identiques** au baseline
   `6a7123a` — vérifié par `diff` contre un worktree détaché ;
2. le fichier n'importe **aucun** de mes modules modifiés ;
3. il occupe la position **15** de la chaîne `npm test`, mes suites modifiées
   les positions 19, 20 et 22 — et chaque suite tourne dans **son propre
   processus**. Il s'exécute donc avant elles, sans lien possible.

**Ce qui l'a déclenché** : j'avais lancé les deux suites complètes *en parallèle*
pour gagner du temps. Relancée **seule**, la suite SB Auto rend exit 0 et zéro
échec ; le baseline, lancé seul lui aussi, était vert. La variable était la
charge machine, pas le code.

**Non corrigé, délibérément.** Le défaut latent est réel et mérite un correctif
(attendre `Model.init()` avant la première écriture, comme en L6.2A et L6.2B),
mais il appartient au parc de tests SB Auto, pas au chantier Stripe. §21 interdit
de réparer un test étranger sans autorisation — et un lot Stripe qui verdit un
test de contrats masque l'état réel de l'autre chantier.

## Z. Fichiers

**Panel** — nouveaux : `services/webhooks/stripeEventRouting.js`,
`tests/stripe-checkout-read-webhook-e2e.test.js`,
`tests/stripe-ownership-invariants.test.js`, ce rapport. Modifiés :
`capabilityErrors.js`, `capabilityRegistry.js`, `stripeAdapters.js`,
`stripeCapabilities.js`, `commercialReadiness.js`, `providerRegistry.js`,
`webhookIngest.js`, `PanelProviderWebhookEvent.model.js`, `tests/run-all.js`,
`tests/{stripe-control-plane,stripe-resource-ownership,capability-gateway}.test.js`.

**SB Auto** — modifiés : `services/stripe/checkoutCapability.js`,
`services/payment.service.js`, `scripts/helpers/panelCheckoutDouble.helper.js`,
`scripts/payments-flow.test.js`.

## AB. Réserves

1. **Sessions antérieures à L6.2B** : sans binding, donc illisibles par la capacité.
   Elles restent `LEGACY/UNOWNED`. Aucun backfill automatique n'a été écrit, et aucun
   ne doit l'être sur la seule foi des metadata.
2. **Neuf des treize événements souscrits restent `NOT_ROUTABLE`** — `payment_intent`,
   `invoice`, `charge`, `customer.subscription`. Ce n'est pas un oubli : leurs familles
   n'ont pas encore de binding, et les router exigerait d'interroger Stripe pour
   découvrir à qui appartient quelque chose. La matrice se lit comme une dette.
3. **Aucune projection métier** n'est émise depuis le webhook (§Q). Le routage est
   prouvé ; son branchement attendra le retrait de l'endpoint projet.
4. **`resource_missing` après appartenance valide** ne révoque pas le lien : c'est une
   incohérence à diagnostiquer, pas une preuve de révocation. Refus typé, lien
   conservé, journal explicite. Aucun écran ne présente encore cette anomalie.
5. **`cancelSubscriptionNow` sans idempotence** : risque connu de L6.1, toujours
   ouvert, hors périmètre.
6. **Course d'index latente dans `contracts.test.js` (SB Auto)** — voir §Y.
   Reproductible sous charge, indépendante de ce lot, **non corrigée** faute
   d'autorisation. Elle rendra la suite complète intermittente tant qu'elle
   tient.

---

**STRIPE CHECKOUT READ + WEBHOOK OWNERSHIP ROUTING: PASS**
