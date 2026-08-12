# L6.2D — Stripe Customer Ownership / `billing.customer.ensure`

**Date** 2026-08-12 · **Périmètre** le client Stripe d'un contrat. Ni Product, ni Price,
ni checkout d'abonnement.

> **La découverte qui détermine tout le lot.**
> Le client Stripe n'est **pas** global au projet. Il appartient au **contrat**.
> Un projet ayant eu trois contrats a trois clients — et c'est correct.

```
     Projet A                          et NON PAS :      Projet A
      ├── Contrat 1 → cus_111                             └── cus_unique
      ├── Contrat 2 → cus_222
      └── Contrat 3 → cus_333
```

---

## 1. Call graph Customer — AVANT

```
contract.admin.controller.createSubscriptionCheckout
  → subscription.service.createOrReuseSubscriptionCheckout        (:395)
    → ensureCustomer(contract, mode, provider)                     (:70)
      → if (contract.stripe.customerId) return …                   ← court-circuit local
      → stripe.provider.createCustomer({email, name, metadata},
                                       `customer-${contract._id}-${mode}`)   (:57)
        → Stripe POST /v1/customers            [CLÉ DU PROJET]
    → contract.stripe.customerId = customer.id
```

**Un seul appelant runtime.** `createCustomer` n'apparaît nulle part ailleurs
(hors provider, stub et tests).

## 2. La cardinalité réelle — prouvée, pas supposée

Trois faits **indépendants**, tous mécaniques :

| Preuve | Ce qu'elle établit |
|---|---|
| Clé d'idempotence `customer-<contractId>-<mode>` | l'unicité est portée par le **contrat** et le **monde** |
| `Contract.stripe.customerId` — champ du contrat, **sans index unique** | rien n'impose un client par projet |
| `Contract.findOne({'stripe.customerId': …})` (`billing.service.js:108`) | la facturation suppose **au plus un contrat par client** |

**Customer est Contract-scoped.** Une implémentation `projectId → customerId`
fusionnerait les historiques de facturation de contrats distincts : au mieux des
factures mélangées, au pire un prélèvement rattaché au mauvais engagement.

Un test statique nommé `CUSTOMER_OWNERSHIP_IS_NOT_PROJECT_SINGLETON` et une section
E2E entière défendent cette cardinalité.

## 3–4. Clé métier et identité d'acte

**Clé métier** : `(environment, contractId)`. Le projet n'y figure pas — il est déjà
porté par la clé du registre d'opérations `(projectId, capability, operationId)` et par
le filtre du registre de liens ; l'y ajouter laisserait croire qu'un contrat pourrait
appartenir à deux projets.

**`operationId` = `stripe-customer:<environment>:<contractId>`**, et il est **DÉRIVÉ par
le Panel**, pas fourni par le projet. C'est la seule capacité du registre dans ce cas, et
la raison tient en une phrase :

> Partout ailleurs, le projet nomme son acte : lui seul sait que deux clics sont la même
> intention. `ensure` ne pose pas cette question — elle affirme « converge vers l'unique
> client de ce contrat ». Laisser le projet nommer l'acte lui permettrait d'appeler deux
> fois sous deux noms et d'obtenir **deux clients** : exactement ce que le verbe promet
> d'empêcher.

Le contrat d'entrée **refuse** donc `operationId` — vérifié en E2E. La dérivation est une
fonction **pure** `(context, input)` évaluée par la passerelle avant toute réservation :
une dérivation qui lirait la base serait faite deux fois — ici et dans l'adaptateur — et
les deux pourraient diverger.

Le lien `Contract ↔ Customer` est préservé **sans nouveau modèle** : `createdByOperationId`
du binding L6.2A porte l'identité dérivée, donc le contrat. `findBindingByOperation()`
répond exactement à « pour ce contrat, quel client ? ».

## 5. Idempotency-Key Stripe

Le mécanisme de L6.2B, inchangé :

```
identité d'acte dérivée  →  registre d'opérations  →  pcp_ + sha256(env|projet|capacité|acte)
```

Déterministe, opaque, jamais choisie par le projet, jamais régénérée au rejeu.

## 6. La fenêtre Stripe → binding

Les **trois barrières** de L6.2B, reprises telles quelles — deux mécanismes de convergence
pour un même problème finiraient par diverger :

1. **le lien** (`createdByOperationId`), définitif ;
2. **la clé d'idempotence**, dans la fenêtre du fournisseur ;
3. **le registre d'opérations**, qui empêche huit appels de partir ensemble.

E2E §7 : client créé, lien supprimé, opération vieillie de dix minutes → la reprise rend
**le même** client, Stripe n'en crée aucun autre, le lien est réparé.

## 7–8. Le client historique — aucune adoption

**Politique retenue : A — pas d'adoption automatique**, et le champ n'existe même pas dans
le schéma d'entrée. Le projet ne peut donc pas proposer un `customerId` : la question ne
se pose jamais.

Trois raisons, dans l'ordre :

1. **Un identifiant présenté n'est pas une preuve de propriété.** Lier sur cette base
   transformerait le registre d'appartenance en registre de déclarations.
2. **L'adoption vérifiée (option B) n'est pas fiable ici.** Si la clé du Panel désigne un
   autre compte que la clé historique du projet, le client n'existe tout simplement pas
   dans ce monde — et « introuvable » ne prouve rien.
3. Le court-circuit `if (contract.stripe.customerId) return …` a **disparu** côté projet :
   il rendait un identifiant sans jamais vérifier qu'il existe encore ni à qui il
   appartient.

**Conséquence assumée** : un contrat qui portait un client historique en obtient un
**nouveau**, créé et lié par le Panel. Duplication côté Stripe, appartenance prouvée côté
Panel. Une migration outillée (option C) reste possible plus tard ; elle exigera une
vérification explicite et imputable, jamais un backfill silencieux.

## 9. Preuve d'ownership

`bindResource(projectId, environment, CUSTOMER, cus_…)` avec l'unicité
`(environment, resourceType, resourceId)` de L6.2A — **sans `projectId`**, ce qui rend un
second propriétaire impossible.

## 10–12. Sécurité, mondes, politique

| Question | Réponse prouvée |
|---|---|
| Deux contrats d'un projet → deux clients ? | **oui**, et chacun retrouve le sien |
| TEST et PROD distincts ? | **oui** — l'acte porte le monde, le lien TEST n'existe pas en PROD |
| Le projet choisit-il l'environnement ? | non — `environment`, `mode`, `apiKey`, `provider`, `baseUrl`, `projectId` refusés |
| Le projet fournit-il un client arbitraire ? | non — le champ n'existe pas |
| B peut-il sonder l'existence d'un client de A ? | non — `CONTRACT_NOT_OWNED` identique pour une référence réelle et une référence inventée, **zéro client créé** |
| Quelle clé atteint Stripe ? | une seule, celle du coffre du Panel |

**Pré-ouverture** : `billing.customer.ensure` est `REVERSIBLE_EXTERNAL_WRITE` dans la table
de L1.75 — créer un client ne débite rien et se supprime — donc **autorisée**. Ce n'est pas
une exception Stripe : c'est la politique générique appliquée à un effet réversible, et la
table n'a **pas** été modifiée. L'E2E le prouve par contraste : au même instant, pour le
même projet, l'écriture **financière** est refusée (`BLOCKED_PREOPENING`).

## 13. Appels Stripe locaux

| Méthode | Classe | Appels runtime |
|---|---|---|
| `createCustomer` | **MIGRATED** (L6.2D) | **0** |
| `createCheckoutSession` (frais) | MIGRATED (L6.2B) | 0 |
| `retrieveCheckoutSession` (frais) | MIGRATED (L6.2C) | 0 |
| `createProduct` · `createPrice` | STILL_REQUIRED — L6.2E | 1 · 1 |
| `createCheckoutSession` (abonnement) | BLOCKED_BY_PRICE_OWNERSHIP | 1 |
| `retrieveCheckoutSession` (abonnement) | BLOCKED_BY_PRICE_OWNERSHIP | 2 |
| `retrievePaymentIntent` | STILL_REQUIRED — aucun binding PAYMENT_INTENT | 2 |
| `retrieveSubscription` · `listSubscriptions` | BLOCKED_BY_OTHER_RESOURCE_OWNERSHIP | 2 · 1 |
| `retrieveInvoice` · `listInvoices` | BLOCKED_BY_OTHER_RESOURCE_OWNERSHIP | 1 · 1 |
| `createBillingPortalSession` | STILL_REQUIRED — hors périmètre | 1 |
| `cancelSubscriptionAtPeriodEnd` · `cancelSubscriptionNow` | STILL_REQUIRED — lot dédié | 1 · 1 |

`NO_LOCAL_STRIPE_RUNTIME_CALL` n'est **pas** atteint, et le rapport ne le prétend pas :
l'abonnement utilise encore Stripe localement.

## 14. Audit Product / Price — pour L6.2E, **non migrés**

| | Product | Price |
|---|---|---|
| Créé dans | `ensureProductAndPrice` (`subscription.service.js:123`) | idem |
| Clé d'idempotence | `product-<contractId>-v<version>-<mode>` | `price-<contractId>-v<version>-<interval>-<amount>-<mode>` |
| **Cardinalité réelle** | par **contrat** et par **version** | par contrat, version, **périodicité** et **montant** |
| Immuable ? | — | **oui** : le cache est invalidé si version, périodicité ou montant changent, et un nouveau Price est créé |
| Après changement de prix | un nouveau Product/Price | les anciens Price restent référencés par les abonnements existants (Stripe ne mute jamais un Price) |
| Stocké dans | `contract.stripe.subscription.productId` | `.priceId`, `.priceContractVersion`, `.priceInterval`, `.priceAmount` |
| Metadata | `contractId`, `contractReference`, `providerMode`, `applicationEnvironment`, `contractVersion` | idem |

L'hypothèse de L6.2C (« Price = per-contract / per-version ») est **confirmée**, et
affinée : aussi par périodicité et par montant.

**Ce que le Panel peut déjà dériver seul** — tout. Sa projection de contrat porte
`sourceContractId`, `document.version`, `pricing.subscription.{amountIncludingTax,
currency, interval}`. Aucune extension de projection n'est nécessaire, et **le montant ne
viendra pas du projet** (doctrine L6.2B).

**Capacité proposée : une seule, `billing.price.ensure`.** Product n'est jamais un but —
L6.1 l'avait déjà relevé : c'est l'une des deux étapes qu'un acte compose. La capacité
garantit le Product puis le Price, et lie les deux. `PRODUCT` et `PRICE` figurent déjà
parmi les sept familles de L6.2A : aucun modèle nouveau.

Identités d'acte dérivées, dans la même doctrine :

```
stripe-product:<env>:<contractId>:v<version>
stripe-price:<env>:<contractId>:v<version>:<interval>:<amount>
```

**Risques cross-tenant à traiter en L6.2E** : le Customer porte des données personnelles
et des moyens de paiement — une erreur d'appartenance y coûte plus cher que sur une
session ; une Subscription mal attribuée prélève sur la mauvaise carte ; `listInvoices`
devra **contraindre** sa requête sortante par un identifiant possédé, jamais filtrer une
réponse déjà obtenue.

## 15. Séquence minimale pour débloquer l'abonnement

1. **`billing.price.ensure`** — Product + Price, montant lu dans la projection, les deux liés.
2. **`billing.checkout.create` en `SUBSCRIPTION`** — le refus explicite
   (`SUBSCRIPTION_PREREQUISITES_NOT_MIGRATED`) tombe : le Panel possède alors le client
   *et* le tarif, et peut construire la session entière avec sa clé.

Rien d'autre n'est requis. `retrieveCheckoutSession` de l'abonnement suivra
mécaniquement, la famille `CHECKOUT_SESSION` étant déjà liable.

## 16. Une inférence à énoncer clairement

Migrer le client alors que le Price reste local suppose que la clé du Panel et la clé
historique du projet désignent **le même compte Stripe**. L'argument est le suivant, et
c'est une inférence, pas une mesure :

> Depuis L6.2B, les sessions de frais sont créées avec la clé du **Panel**, et c'est
> l'endpoint webhook de **SB Auto** qui reçoit `checkout.session.completed` pour les
> régler. Cela n'est possible que si l'endpoint du projet est enregistré sur le compte de
> la clé du Panel. Si les comptes différaient, L6.2B serait déjà cassé en production —
> les frais seraient encaissés sans jamais être constatés.

Si cette prémisse était fausse, le parcours d'abonnement échouerait à la création de la
session (`No such customer`) — bruyamment, jamais silencieusement.

## 17. Tests

| Suite | Résultat |
|---|---|
| `stripe-customer-ownership-e2e` *(nouveau, 11 sections)* | **81 / 0**, stable ×3 |
| `stripe-ownership-invariants` *(+3 sections L6.2D)* | **43 / 0** |
| `stripe-control-plane` | 105 / 0 |
| `stripe-resource-ownership` | 91 / 0 |
| `capability-gateway` · `capability-gateway-e2e` · `capability-preopening` | 117 / 0 · 66 / 0 · 27 / 0 |
| `stripe-checkout-cutover-e2e` (L6.2B) · `stripe-checkout-read-webhook-e2e` (L6.2C) | 106 / 0 · 85 / 0 |
| `webhook-control-plane` · `commercial-readiness*` · `architecture` · `bridge-conformity` | 230 / 0 · 74 + 75 / 0 · 31 / 0 · 59 / 0 |

**SB Auto** — `subscription-flow` 77/0 · `subscription-reconcile` 48/0 · `payments-flow` 70/0 ·
`billing-flow` 46/0 · `stripe` 29/0 · `contract-lifecycle` 46/0 ·
`contract-billing-signature` 31/0 · `bridge-conformity` 97/0.

## 18. Un incident d'outillage, de mon fait

En vérifiant une hypothèse de L6.2C, j'avais créé un worktree jetable avec une **jonction**
vers `node_modules`. En le nettoyant, `rmdir /S /Q` a suivi la jonction et supprimé une
partie de `node_modules` du dépôt **principal** de SB Auto.

Aucun fichier suivi par git n'a été touché — `git status` l'a confirmé immédiatement. La
réparation a été `npm ci` depuis `package-lock.json` (189 paquets restaurés), et les suites
sont reparties vertes. Je le consigne parce qu'un incident d'outillage non écrit ressemble,
plus tard, à une cause inexpliquée.

**Leçon** : ne jamais nettoyer une jonction Windows avec `rmdir /S`. `git worktree remove`,
ou la suppression du lien seul.

## 19. Réserves

1. **Le client historique n'est pas adopté** (§7–8). Un contrat qui en portait un en
   obtient un nouveau. Duplication côté Stripe, assumée et documentée.
2. **L'abonnement reste local** et le restera jusqu'à L6.2E — son Price n'a pas de lien.
3. **L'inférence « même compte »** (§16) n'est pas mesurée. Sa fausseté produirait un
   échec bruyant à la création de session, jamais un débit silencieux.
4. **`cancelSubscriptionNow` sans idempotence** : risque connu de L6.1, toujours ouvert.
5. **Course d'index Mongoose dans `contracts.test.js` (SB Auto)** — latente, documentée en
   L6.2C, toujours non corrigée : elle n'appartient pas au chantier Stripe.

---

**STRIPE CUSTOMER CONTROL PLANE CUTOVER: PASS**

**GO L6.2E: YES**
