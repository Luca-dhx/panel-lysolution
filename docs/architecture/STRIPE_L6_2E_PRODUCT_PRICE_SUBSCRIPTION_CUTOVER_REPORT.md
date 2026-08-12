# L6.2E — Product / Price + Subscription Checkout Cutover

**Date** 2026-08-12 · **Périmètre** `billing.price.ensure` et le checkout d'abonnement.
Ni Finances, ni remboursements, ni résiliations.

> **La découverte qui a changé la clé.**
> Le code historique clé ses Product et Price sur `signatureConfiguration.version`.
> Or cette version s'incrémente à **chaque sauvegarde des zones de signature**
> (`contract.service.js:218`) : elle mesure un document, pas un engagement commercial.
> La clé retenue porte donc les **termes** — périodicité, montant, devise.

---

## A. Baseline réelle

| | Panel | SB Auto 06 |
|---|---|---|
| HEAD constaté | `cb31729` | `4aff8a3` |
| `git status` au départ | **propre** | **propre** |

Conforme aux baselines annoncées. Aucun `reset`, `checkout`, `restore`, `clean`, `stash`.

## B. Travaux parallèles détectés

Les deux arbres étaient propres au départ. **Le chantier Finances L10.1 est apparu pendant
le lot** et a produit, dans le Panel :

*Nouveaux* — `controllers/finances.controller.js`, `models/PanelFinancialTransaction.model.js`,
`routes/finances.routes.js`, `services/finance/`, `frontend/src/components/finance/`,
`frontend/src/lib/{money,useFinances}.ts`, `frontend/src/types.finance.ts`,
`tests/finance-core.test.js`.
*Modifiés* — `backend/src/app.js`, `backend/src/models/PanelSupervision.model.js`,
`frontend/src/lib/api.ts`.

**Aucune collision.** Aucun de ces fichiers n'est touché par L6.2E, et aucun des miens ne
l'est par eux. Point vérifié explicitement : `tests/run-all.js` ne contient **aucune** entrée
Finances — ils n'y ont pas inscrit `finance-core.test.js`, le fichier reste à moi seul.

Aucun fichier Finances n'est stagé (§Z), et aucun n'a été modifié — y compris pour réparer
ce qu'ils cassent (§X).

## C. Call graph Product — avant / après

**Avant** — un seul appelant runtime :
```
createOrReuseSubscriptionCheckout (:430)
  → ensureProductAndPrice(contract, mode, provider) (:123)
    → provider.createProduct({name, metadata}, `product-<id>-v<version>-<mode>`) [CLÉ PROJET]
```
**Après** — `ensureProductAndPrice` est **supprimée**. Le Product est garanti par le Panel,
avec sa clé, et **lié** avant d'être utilisable.

## D. Call graph Price — avant / après

**Avant** : `provider.createPrice({product, unitAmount, currency, interval, metadata},
`price-<id>-v<version>-<interval>-<amount>-<mode>`)`, stocké dans
`contract.stripe.subscription.{priceId, priceContractVersion, priceInterval, priceAmount}`.
Relu par `createSubscriptionCheckout` et par la vue de support DEV.

**Après** : `billing.price.ensure` — le Panel lit les termes dans **sa** projection, crée
Product puis Price, et lie les deux.

## E. Call graph subscription checkout — avant / après

```
AVANT                                    APRÈS
createOrReuseSubscriptionCheckout        createOrReuseSubscriptionCheckout
 ├ provider.retrieveCheckoutSession       ├ readCheckoutViaPanel        (L6.2C)
 ├ ensureCustomer        [clé projet]     └ createSubscriptionCheckoutViaPanel
 ├ ensureProductAndPrice [clé projet]         → Panel : customer.ensure
 └ createSubscriptionCheckout [clé projet]              price.ensure
                                                        checkout create  [clé PANEL]
                                                        binding session
```

Le Panel **compose** les trois actes ; chacun garde **sa propre** identité dérivée, donc sa
propre convergence — un client déjà garanti n'est pas recréé parce qu'un tarif manquait.

**Défaut corrigé au passage** : la relecture de la session en cours utilisait la clé du
projet, et son `catch` ouvrait une **nouvelle tentative** — donc une seconde session
d'abonnement pendant que la première restait ouverte. Même défaut que sur les frais
(L6.2C), corrigé de la même façon.

## F / G. Cardinalités retenues

| | Clé | Ce qu'elle exclut délibérément |
|---|---|---|
| **Product** | `(environment, contractId)` | les termes — un Product ne porte aucun montant, il **nomme** ce qu'on vend |
| **Price** | `(environment, contractId, interval, amount, currency)` | la version du contrat — voir ci-dessous |

## H. Pourquoi ces cardinalités sont correctes

**Ce que le brief proposait** incluait `contractVersion` dans les deux clés. L'audit du
code montre que ce serait une erreur :

`signatureConfiguration.version` s'incrémente dans `setSignatureConfiguration` — à chaque
sauvegarde des zones de signature. Déplacer une zone de trois pixels la fait passer de 2 à
3, sans qu'aucun terme commercial n'ait bougé. Y adosser l'identité d'un tarif produit des
Price **rigoureusement identiques** en montant, devise et périodicité, mais démultipliés :
catalogue Stripe pollué, comptabilité plus difficile à lire.

**Et un défaut dans l'autre sens.** La garde de cache locale comparait version, périodicité
et montant — **mais pas la devise** (`subscription.service.js:128`). Un passage EUR → CHF à
montant identique réutilisait le Price existant, avec la mauvaise devise. La clé retenue
inclut la devise, et l'E2E §4d le prouve.

La sémantique métier exigée est intégralement préservée :

| Exigence | Comment la clé la garantit |
|---|---|
| jamais un Price réutilisé pour un autre montant | le montant est **dans** la clé |
| jamais un Price historique muté | on ne fait que **créer** — et le transport n'expose aucune mise à jour |
| jamais TEST et PROD confondus | l'environnement est dans la clé |
| jamais deux contrats mélangés | le contrat est dans la clé |
| un abonnement ancien garde son tarif | rien n'est jamais supprimé |

`contractVersion` reste écrite dans les **metadata** — précieuse au support, sans décider
de rien.

## I. Autorité montant / devise / périodicité

Le Panel, et lui seul. `resolvePriceIntent` charge la projection, vérifie l'appartenance du
contrat, puis lit `pricing.subscription.{amountIncludingTax, currency, interval}`.

L'entrée de `billing.price.ensure` porte **uniquement** `contractRef` : ni `amount`, ni
`currency`, ni `interval`, ni `priceId`, ni `productId`, ni `operationId`. Un montant
transmis puis comparé resterait un montant transmis — et le jour où la comparaison devient
une tolérance, l'autorité a changé de camp sans qu'aucune ligne ne le dise.

L'E2E vérifie que le montant **envoyé à Stripe** est celui de la projection, en centimes,
et que chacun de ces champs est refusé par le schéma.

## J. Identité métier / `operationId`

**Dérivée par le Panel**, comme `customer.ensure` (L6.2D) — et la décision est prouvée, pas
copiée : « ce contrat a-t-il son tarif ? » n'a qu'une réponse correcte, et laisser le projet
nommer l'acte lui permettrait d'en obtenir deux.

```
stripe-product:<env>:<contractId>
stripe-price:<env>:<contractId>:<interval>:<amount>:<currency>
```

La capacité déclare l'identité du **Product** au registre d'opérations : elle est stable
pour un contrat, ce qui sérialise deux changements de tarif concurrents plutôt que de les
laisser courir ensemble. L'identité du Price est dérivée dans l'adaptateur, à partir des
termes que la passerelle n'a pas à connaître.

**Défaut évité, et il aurait été coûteux** : lorsqu'un checkout d'abonnement compose
`customer.ensure`, il doit lui passer **la définition de cette capacité**, pas la sienne.
La clé d'idempotence Stripe dérive du code de capacité : la laisser hériter du checkout
aurait produit une clé différente de celle d'un appel direct — donc un **second client**
pour le même contrat. Invisible en test nominal, coûteux en production.

## K / L. Ownership Product et Price

Le modèle de L6.2A, sans second système. Chaque ressource est **liée avant d'être
utilisable**, par une fonction générique commune aux deux — écrire deux fois la même
séquence de trois barrières donnerait deux occasions de diverger.

Refus indistinguable pour inconnu / autre projet / révoqué (doctrine L6.2A, déjà éprouvée).

## M. Fenêtres de crash

Deux, et la seconde est propre au lot :

1. **Product créé → Price pas encore.** Structurelle : un Price référence son Product. La
   barrière 1 la referme — au passage suivant le Product est retrouvé par son lien, et seul
   le Price manquant est créé. Prouvé §6a : aucun Product de plus.
2. **Price créé → lien pas encore.** Lien supprimé, opération vieillie de dix minutes → la
   reprise rend **le même** Price, Stripe n'en crée aucun autre, le lien est réparé.

## N. UNKNOWN / réponse perdue

Doctrine L6.2B, inchangée : `outcome: UNKNOWN` → `CAPABILITY_TIMEOUT` (504), opération
`UNKNOWN` et non `FAILED`, convergence par la même clé, bornée par `staleAfterMs` (90 s) et
`replayWindowMs` (23 h). Prouvé §6a.

## O. Concurrence

8 appels simultanés sur la même clé métier → **1 Product, 1 Price**, un succès, sept
`OPERATION_IN_FLIGHT`. Idem pour le checkout d'abonnement : **1 session**.

## P. TEST / PROD

Les deux identités d'acte portent le monde ; un lien TEST n'existe pas en PROD
(`NO_BINDING`). Une seule clé atteint le fournisseur : celle du coffre du monde résolu.

## Q. Cross-tenant

B présentant le contrat de A → `CONTRACT_NOT_OWNED`, **zéro tarif créé**. Une référence
inventée rend **exactement** le même code, le même motif et le même message. B adoptant le
Price de A → conflit, propriétaire inchangé. B obtient son propre tarif, à **son** montant.

## R. Immutabilité du Price

L'invariant du lot, prouvé point par point (§4) :

| Changement | Résultat |
|---|---|
| version du contrat, **mêmes termes** | **le même** Price — aucune création |
| montant 118,80 € → 299 € | un **autre** Price ; P1 intact, à son montant d'origine, lien conservé |
| mensuel → annuel | encore un autre ; les trois coexistent |
| EUR → CHF à montant identique | un **autre** — le défaut que la garde locale ne voyait pas |
| Product | **réutilisé** dans tous les cas |

**Aucune mutation n'est possible** : le transport n'expose aucune mise à jour de Price, et
le faux Stripe de l'E2E répond `400` à toute tentative — un test vert ne peut pas masquer
une réécriture de l'histoire.

## S. Customer linkage

La session d'abonnement référence le client issu de `customer.ensure`, et l'E2E vérifie que
ce client est **lié au projet demandeur**. Le contrat de A ne peut pas utiliser le client de
B : chaque `ensure` dérive son acte du contrat vérifié.

## T. Checkout abonnement

**Migré.** `mode: subscription`, `line_items[0].price` référence le tarif du contrat, aucun
montant inline, metadata recopiées sur `subscription_data`. Double clic → `REUSED` ;
8 concurrents → une session.

## U. Appels Stripe locaux restants

```
LOCAL_RUNTIME_SUBSCRIPTION_CHECKOUT_WRITES = 0
```

| Méthode | Classe | Runtime |
|---|---|---|
| `createCustomer` · `createProduct` · `createPrice` | **MIGRATED** | **0** |
| `createCheckoutSession` (frais + abonnement) | **MIGRATED** | **0** |
| `retrieveCheckoutSession` (frais + abonnement) | **MIGRATED** | **0** |
| `retrieveSubscription` | STILL_REQUIRED — aucun binding SUBSCRIPTION | 2 |
| `retrieveInvoice` · `listSubscriptions` | STILL_REQUIRED — même raison | 1 · 1 |
| `retrievePaymentIntent` | STILL_REQUIRED — aucun binding PAYMENT_INTENT | 2 |
| `createBillingPortalSession` | STILL_REQUIRED — hors périmètre | 1 |
| `cancelSubscriptionAtPeriodEnd` · `cancelSubscriptionNow` | STILL_REQUIRED — lot dédié | 1 · 1 |

Trois constructeurs sont **supprimés** (`ensureCustomer`, `ensureProductAndPrice`,
`createSubscriptionCheckout`) plutôt que laissés inertes : un constructeur inutilisé est le
repli du prochain incident. Le **pilote** garde `createCheckoutSession` — plus aucun
parcours ne l'appelle, mais on ne retire pas un pilote encore requis par d'autres verbes.

`NO_LOCAL_STRIPE_RUNTIME_CALL` n'est **pas** atteint, et le rapport ne le prétend pas.

## V. Webhooks

**Rien touché** : ni endpoint, ni secret, ni routage. Le routage par appartenance de L6.2C
est réutilisé tel quel.

Ce lot **améliore** sa portée future sans y toucher : Product, Price, Customer et les
sessions d'abonnement ont désormais des liens. Restent non routables les événements portant
un `subscription`, un `invoice`, un `payment_intent` ou un `charge` — leurs familles n'ont
pas encore de lien. `customer.subscription.*` deviendra routable dès qu'un binding
SUBSCRIPTION existera : c'est le prochain jalon naturel (§AB).

## W. Pré-ouverture

**La table de L1.75 n'a pas été modifiée pour faire passer un test.** `billing.price.ensure`
y est ajoutée comme `REVERSIBLE_EXTERNAL_WRITE`, au même titre que `customer.ensure` : créer
un catalogue et un tarif ne débite personne. Ce qui engage, c'est la session — et elle reste
`FINANCIAL_WRITE`, donc bloquée en pré-ouverture.

Une contrainte structurelle a été respectée au passage : `commercialReadiness.js` ne doit
**nommer aucun fournisseur**, y compris en commentaire. Mon premier commentaire citait
Stripe ; la suite `commercial-readiness` l'a refusé, et il a été reformulé.

## X. Tests exacts

| Suite | Résultat |
|---|---|
| `stripe-subscription-cutover-e2e` *(nouveau, 12 sections)* | **122 / 0**, stable ×3 |
| `stripe-ownership-invariants` *(+4 sections L6.2E)* | **71 / 0** |
| `stripe-control-plane` · `capability-gateway` | 109 / 0 · 119 / 0 |
| `stripe-checkout-cutover-e2e` (L6.2B) · `-read-webhook-e2e` (L6.2C) | 106 / 0 · 85 / 0 |
| `stripe-customer-ownership-e2e` (L6.2D) · `stripe-resource-ownership` | 81 / 0 · 93 / 0 |
| `capability-gateway-e2e` · `capability-preopening` | 66 / 0 · 27 / 0 |
| `commercial-readiness` · `-runtime` · `webhook-control-plane` | 75 / 0 · 75 / 0 · 230 / 0 |
| `architecture` · `bridge-conformity` | 31 / 0 · 59 / 0 |

**SB Auto** — `subscription-flow` 79/0 · `subscription-reconcile` 50/0 · `stripe` 29/0 ·
`payments-flow` 70/0 · `billing-flow` 46/0 · `contract-lifecycle` 46/0 ·
`contract-billing-signature` 31/0 · `bridge-conformity` 97/0 · `panel-bridge` 60/0.

### Suites complètes

| Dépôt | Résultat |
|---|---|
| **Panel** — `tests/run-all.js` | **97/98 fichiers OK** |
| **SB Auto** — `npm test` | 1 fichier rouge |

Exécutées **séquentiellement** (leçon L6.2D). Les deux rouges sont ÉTRANGERS au lot, et je
les documente plutôt que de les réparer.

**Panel — `panel-ux.test.js`, 4 échecs.** Les quatre nomment `Finances` :

```
✗ Gestion = … — Tableau de bord, Projets clients, Agenda et événements, Finances, Mon entreprise
✗ CHAQUE route technique passe par la garde DEV
✗ aucune route technique laissée ouverte — /finances
✗ …et une valeur inattendue ne devient jamais un onglet
```

Le chantier L10.1 a ajouté un onglet et une route `/finances` sans mettre à jour cette
suite. `tests/panel-ux.test.js` est **intact depuis le baseline** dans mon arbre — vérifié
par `git status`. Ce n'est pas mon échec, et §19 interdit de le réparer.

**SB Auto — `contracts.test.js`, 1 échec** : « WebhookEvent dupliqué rejeté (E11000) ».
C'est la course d'index Mongoose déjà documentée en L6.2C et L6.2D. Relancé seul :
**44 / 0**.

Une précision honnête sur mon explication de L6.2D : j'y avais attribué cette course au fait
d'avoir lancé les deux suites *en parallèle*. Cette fois elles ont tourné **séquentiellement**
et la course s'est produite quand même. La cause reste la même — `WebhookEvent.create()` est
appelé sans avoir attendu `Model.init()`, et l'index unique se construit en tâche de fond —
mais elle se déclenche sous simple charge cumulée, pas seulement sous parallélisme. Le
défaut est donc **plus intermittent** que je ne l'avais écrit. Il reste hors chantier
Stripe : `contracts.test.js` et les modèles qu'il exerce sont byte-identiques au baseline,
et il s'exécute avant toute suite que j'ai modifiée, dans son propre processus.

## Y. Fichiers modifiés

**Panel** — nouveaux : `stripePriceAuthority.js`,
`tests/stripe-subscription-cutover-e2e.test.js`, ce rapport. Modifiés :
`stripeTransport.js`, `stripeAdapters.js`, `stripeCapabilities.js`,
`stripeCheckoutAuthority.js`, `capabilityRegistry.js`, `commercialReadiness.js`,
`providerRegistry.js`, `tests/{run-all, stripe-control-plane, capability-gateway,
stripe-ownership-invariants, stripe-checkout-cutover-e2e,
stripe-checkout-read-webhook-e2e}.test.js`, docs.

**SB Auto** — modifiés : `subscription.service.js`, `stripe/stripe.service.js`,
`stripe/checkoutCapability.js`, `scripts/helpers/panelCheckoutDouble.helper.js`,
`scripts/{subscription-flow, subscription-reconcile, stripe,
contract-billing-signature}.test.js`.

## AA. Réserves

1. **`productId` / `priceId` ne sont plus écrits côté projet.** Le projet ne possède plus
   ces ressources. Les valeurs existantes **ne sont pas effacées**, et la vue de support DEV
   continue de les afficher pour les contrats antérieurs ; elle sera vide pour les nouveaux.
2. **Aucune adoption des Product/Price historiques**, comme pour le client en L6.2D. Un
   contrat migré obtient un tarif neuf. Duplication côté Stripe, appartenance prouvée côté
   Panel.
3. **Une session d'abonnement antérieure au lot** n'a pas de lien : sa relecture est refusée
   (`RESOURCE_NOT_OWNED`) et le parcours ouvre une tentative neuve. C'est le geste correct —
   l'ancienne session n'est pas la nôtre — mais elle reste ouverte chez Stripe jusqu'à son
   expiration.
4. **`retrieveSubscription` reste local** et référence un abonnement créé par le Panel. Si
   les comptes divergeaient, cette lecture échouerait — son `catch` la rend inoffensive, et
   l'inférence « même compte » reste celle énoncée en L6.2D §16.
5. **`cancelSubscriptionNow` sans idempotence** : risque connu de L6.1, toujours ouvert.
6. **Course d'index Mongoose dans `contracts.test.js` (SB Auto)** — latente, et plus
   intermittente que L6.2D ne le disait : elle se produit aussi hors parallélisme (§X).
   Hors chantier Stripe, non corrigée.
7. **`panel-ux.test.js` est rouge du fait du chantier Finances L10.1** (§X). Non réparé.

## AB. Prochain lot recommandé — *non implémenté*

**L6.2F — ownership Subscription, puis résiliations.** Dans cet ordre :

1. **binding SUBSCRIPTION** — la famille existe déjà dans les sept types de L6.2A. La
   ressource est créée par Stripe au paiement, pas par le Panel : elle s'adopte donc depuis
   la **session qui l'a produite**, dont l'appartenance est déjà prouvée. C'est la première
   adoption légitime du chantier — une preuve, pas une déclaration.
2. `billing.subscription.retrieve` — servie dès que le lien existe.
3. Le routage webhook de `customer.subscription.*` et `invoice.*` devient mécanique.
4. **Seulement ensuite** les résiliations, dont `cancelSubscriptionNow` et son défaut
   d'idempotence.

Ne pas commencer par les résiliations : elles agissent sur une ressource dont
l'appartenance n'est pas encore prouvée.

---

**STRIPE PRODUCT/PRICE + SUBSCRIPTION CHECKOUT CUTOVER: PASS**
