# L6.2F — Stripe Subscription Ownership

**Date** 2026-08-12 · **Périmètre** l'adoption des abonnements et leur lecture.
Aucune résiliation migrée.

> **Ce que ce lot change dans la doctrine.**
> Depuis L6.2A, une ressource n'appartient à un projet que parce que le Panel l'a
> **créée**. L'abonnement ne peut pas suivre cette règle : Stripe le fabrique lui-même
> au moment du paiement. La **filiation** remplace la création — et reste une preuve.

---

## 1. Baseline réelle

| | HEAD constaté | Attendu au brief | Écart |
|---|---|---|---|
| Panel | `ca9a68c` | `e3f70b8` | **+2 commits Finances L10.1** |
| SB Auto | `ef43487` | `ef43487` | conforme |

Les deux arbres étaient **propres**. L'écart Panel est expliqué et sans danger :
`e3f70b8` (mon L6.2E) est bien un **ancêtre** de `ca9a68c`, et les deux commits
intercalés (`7bde5d0`, `ca9a68c`) touchent 31 fichiers dont **aucun** Stripe, capacité
ou webhook. Ils ont d'ailleurs réparé `tests/panel-ux.test.js` — le rouge que L6.2E avait
documenté et refusé de corriger, puisqu'il leur appartenait.

Acquis L6.2A–E vérifiés par exécution : ownership générique, checkout de frais, retrieve
et routage webhook, client contract-scoped, tarif par termes, `LOCAL_RUNTIME_
SUBSCRIPTION_CHECKOUT_WRITES = 0`.

## 2. Call graph Subscription — avant

Une Subscription apparaît pour la **première fois** dans
`settleFromCheckoutSession` (`subscription.service.js:180`), lue sur
`session.subscription`. Aucun code du parc n'appelle `subscriptions.create` : il n'y a
rien à contrôler à la création.

| Appel | Nature | Sites |
|---|---|---|
| `retrieveSubscription` | READ | 2 (`settleFromCheckoutSession`, réconciliation) |
| `listSubscriptions` | READ large | 1 (`retrouverSubscriptionId`) |
| `cancelSubscriptionAtPeriodEnd` | WRITE financière | 1 (`contract.service.js:644`) |
| `cancelSubscriptionNow` | WRITE financière | 3 (dont 2 outils de recette) |

`subscriptionId` est stocké sur `Contract.stripe.subscription`, et relu par la
facturation (`billing.service.js:103`), la vue DEV, la réconciliation et le webhook.

## 3. Quel objet est l'autorité de l'adoption

**La Checkout Session**, et elle seule :

```
Session possédée (lien L6.2B, appartenance déjà prouvée)
        ↓  Stripe, sur l'objet lui-même
session.subscription
        ↓
Subscription adoptée pour CE projet
```

## 4. Pourquoi cette filiation suffit

Parce que ce n'est pas une déclaration. Le fournisseur lui-même, **sur un objet dont nous
possédons déjà le lien**, désigne la ressource comme issue de cet objet. Un tiers ne peut
pas fabriquer cette désignation sans compromettre le compte Stripe — auquel cas
l'appartenance n'est plus notre problème le plus urgent.

Conséquence structurelle, et c'est le cœur du lot : **la fonction d'adoption n'accepte
aucun identifiant d'abonnement**. Elle reçoit l'objet Session tel que Stripe l'a rendu et
en extrait elle-même la filiation. La question « et si l'appelant mentait ? » ne se pose
jamais — un test statique vérifie cette signature, précisément pour qu'un futur endpoint
d'administration ne puisse pas la contourner.

**Preuves vs corroborations**, explicitement :

| | Rôle |
|---|---|
| lien de la session | **PREUVE** — sans lui, aucune adoption |
| `session.subscription` | **PREUVE** — la désignation vient de Stripe |
| `mode: subscription` | garde-fou de forme |
| `metadata.panelProjectId` | **corroboration** — divergence journalisée, jamais suivie |
| `metadata.contractId` | **corroboration** — conservée dans `proof` |
| client de la session lié au même projet | **corroboration** — `customerCorroborated`, n'empêche pas |

## 5. Si les metadata mentent

Le lien gagne. Une session **réellement** possédée par A dont les metadata désignent B
produit une adoption **vers A**, et `claimMismatch` est levé et journalisé. Prouvé en E2E
§6c, et de nouveau côté webhook §8.

## 6. Comment l'abonnement est lié au projet, et au contrat

**Au projet** : `bindResource(SUBSCRIPTION, sub_…, projectId)` — le modèle générique de
L6.2A, sans seconde table. L'unicité `(environment, resourceType, resourceId)` rend un
second propriétaire impossible.

**Au contrat** : par la provenance. `createdByOperationId` porte
`stripe-subscription-from-session:<env>:<sessionId>`, et le lien de cette session porte
lui-même `checkout-sub-<contractId>-…`. Le contrat se retrouve donc en remontant la
chaîne, sans nouveau champ et sans dupliquer une information dont un autre lien est déjà
l'autorité.

`proof` gagne trois champs — `derivedFromResourceType`, `derivedFromResourceId`,
`customerCorroborated` — recopiés **champ par champ** dans `bindResource`, jamais étalés :
ce registre doit rester lisible par n'importe quel opérateur sans précaution.

## 7. Clé métier et idempotence

La provenance **est** la clé : deux adoptions de la même session retombent sur la même
ligne. L'adoption est donc idempotente par construction, et l'index unique tranche les
concurrents.

| Scénario | Résultat prouvé |
|---|---|
| adopter deux fois | `ALREADY_ADOPTED`, une seule ligne |
| 8 adoptions concurrentes | aucune n'échoue, une seule ligne |
| crash après validation, avant lien | le rejeu ré-adopte, **même provenance** |
| session possédée non payée | `NOT_ELIGIBLE` — pas une erreur, le cas normal |

## 8. Arrivées dans le désordre

C'est la partie que Stripe ne garantit pas, et le lot ne suppose aucun ordre.

| Cas | Comportement |
|---|---|
| **B — abonnement AVANT sa session** | `UNOWNED`. Non routé, **enregistré**, traçable. Aucune attribution par metadata |
| **A — session ensuite** | adoption ; l'événement suivant du même abonnement est routé |
| **Tardif** | converge sans **aucun acte financier** — vérifié : zéro `POST /v1/subscriptions` |
| **Duplicata** | absorbé par l'index de L5, une seule ligne |
| **Projet hors ligne** | sans effet : l'adoption est côté Panel, et le routage ne mute aucun projet (doctrine L6.2C) |

Deux voies d'adoption existent, et c'est délibéré : le **webhook**, et la **lecture** de
session par le projet. Un webhook perdu ne laisse donc pas la ressource orpheline pour
toujours — le prochain retour de parcours l'adopte.

## 9. Cross-tenant

B présentant l'abonnement de A → `CAPABILITY_RESOURCE_NOT_OWNED`. Un abonnement inconnu →
**même code, même message, même statut**, et **zéro appel Stripe** sur les deux. Un lien
révoqué → même refus encore. B tentant de lier l'abonnement de A par le registre →
conflit, propriétaire inchangé.

Aucun oracle : les trois cas restent indistinguables, conformément à L6.2A.

## 10. TEST / PROD

La provenance porte le monde ; un abonnement TEST n'existe pas en PROD (`NO_BINDING`).
Le credential est celui du monde résolu, et une seule clé a parlé à Stripe sur toute la
suite.

## 11. Webhooks

**Endpoint et secret inchangés.** L'adoption s'insère dans le pipeline existant, **après**
la résolution d'appartenance de la session — jamais avant : un abonnement ne doit à aucun
moment être routé vers un projet dont on n'aurait pas d'abord prouvé qu'il possède la
session qui l'a produit.

La matrice gagne trois événements : `customer.subscription.{created,updated,deleted}`,
routables **si et seulement si** le lien existe. Restent hors de portée `payment_intent`,
`invoice` et `charge` — remonter de la facture à l'abonnement demanderait d'interroger
Stripe pour découvrir à qui appartient quelque chose, l'ordre inverse de la doctrine.

## 12. Adoption historique — auditée, non implémentée

Il existe potentiellement des abonnements antérieurs, créés par des sessions elles-mêmes
antérieures à L6.2B et donc **sans lien**. Leur filiation n'est pas reconstituable : la
seule corrélation disponible passe par `metadata.contractId` ou par un listing de client,
c'est-à-dire exactement les deux voies que ce lot retire.

**Aucun backfill.** Ils restent `LEGACY/UNOWNED` : ni lisibles par capacité, ni routables.
Une adoption outillée resterait possible plus tard, à condition d'exiger une **preuve
équivalente** — par exemple retrouver la session d'origine chez Stripe et constater
qu'elle désigne l'abonnement — et non un rapprochement de metadata.

## 13. `retrieveSubscription` — migré

Oui, et c'était le bon moment : sans lecture, une adoption ne se constate pas.
`billing.subscription.retrieve` applique l'ordre `appartenance → fournisseur`, et son DTO
porte les **sept** champs que `projectSubscription()` lit réellement. `currency` disparaît
du contrat L6.1 : personne ne la lisait, et un champ rendu « au cas où » finit par être
utilisé comme une autorité.

Côté projet, les **deux** lectures locales sont migrées, et le repli par
`listSubscriptions` + `metadata.contractId` est **supprimé** — il faisait décider
l'appartenance par un champ éditable, sur une liste demandée plus large que son dû.

## 14. Résiliations — **non migrées**, délibérément

`cancelSubscriptionAtPeriodEnd` (1 site) et `cancelSubscriptionNow` (3 sites) restent
locaux. Le risque de L6.1 est **re-vérifié et confirmé** :
`stripe.provider.js:143` appelle `subscriptions.cancel(subscriptionId)` **sans clé
d'idempotence**.

Les conditions de §14 ne sont pas toutes réunies : l'ownership l'est désormais, mais
l'`operationId`, la stratégie d'idempotence et la convergence sur `UNKNOWN` d'une
résiliation restent à définir. Un test statique vérifie que le transport du Panel ne sait
**pas** muter un abonnement, hors la résiliation différée contractualisée en L6.1 et non
servie.

Prérequis du futur cutover, à traiter en L6.2G :
`operationId` → registre d'opérations → ownership Subscription → transport → convergence.

## 15. Appels Stripe directs restants dans SB Auto

| Méthode | Classe | Runtime |
|---|---|---|
| `createCustomer` · `createProduct` · `createPrice` | MIGRATED | 0 |
| `createCheckoutSession` (frais + abonnement) | MIGRATED | 0 |
| `retrieveCheckoutSession` (frais + abonnement) | MIGRATED | 0 |
| `retrieveSubscription` | **MIGRATED** (L6.2F) | **0** |
| `listSubscriptions` | **SUPPRIMÉ** — repli par metadata | **0** |
| `cancelSubscriptionAtPeriodEnd` | STILL_REQUIRED — L6.2G | 1 |
| `cancelSubscriptionNow` | STILL_REQUIRED — L6.2G, sans idempotence | 3 |
| `retrievePaymentIntent` | STILL_REQUIRED — aucun binding PAYMENT_INTENT | 2 |
| `retrieveInvoice` · `listInvoices` | STILL_REQUIRED — aucun binding INVOICE | 1 · 1 |
| `createBillingPortalSession` | STILL_REQUIRED — hors périmètre | 1 |

## 16. Credentials

Sentinelles distinctes. Une seule clé a atteint le fournisseur sur toute la suite : celle
du coffre du Panel. La sentinelle projet n'apparaît nulle part — ni dans les appels, ni
dans les bases des deux instances. Aucun secret journalisé.

## 17. Tests

| Suite | Résultat |
|---|---|
| `stripe-subscription-ownership-e2e` *(nouveau, 10 sections)* | **79 / 0**, stable ×3 |
| `stripe-ownership-invariants` *(+3 sections L6.2F)* | **87 / 0** |
| `stripe-control-plane` · `capability-gateway` · `stripe-resource-ownership` | 111 / 0 · 119 / 0 · 95 / 0 |
| L6.2B · L6.2C · L6.2D · L6.2E (E2E rejoués) | 106 / 0 · 85 / 0 · 81 / 0 · 122 / 0 |
| `webhook-control-plane` · `capability-gateway-e2e` · `capability-preopening` | 230 / 0 · 66 / 0 · 27 / 0 |
| `commercial-readiness*` · `architecture` · `bridge-conformity` | 76 + 75 / 0 · 31 / 0 · 59 / 0 |

**SB Auto** — `subscription-reconcile` 52/0 · `subscription-flow` 79/0 · `payments-flow`
70/0 · `billing-flow` 46/0 · `stripe` 29/0 · `contract-lifecycle` 46/0 ·
`contract-billing-signature` 31/0 · `bridge-conformity` 97/0 · `panel-bridge` 60/0 ·
`control-plane` 29/0.

## 18. Fichiers modifiés

**Panel** — nouveaux : `stripeSubscriptionAdoption.js`,
`tests/stripe-subscription-ownership-e2e.test.js`, ce rapport. Modifiés :
`PanelStripeResourceBinding.model.js`, `stripeResourceBinding.js`, `stripeAdapters.js`,
`stripeCapabilities.js`, `capabilityRegistry.js`, `commercialReadiness.js`,
`providerRegistry.js`, `webhooks/{stripeEventRouting,webhookIngest}.js`,
`tests/{run-all, stripe-control-plane, capability-gateway, stripe-resource-ownership,
stripe-ownership-invariants}.test.js`, docs.

**SB Auto** — modifiés : `subscription.service.js`, `stripe/checkoutCapability.js`,
`scripts/helpers/panelCheckoutDouble.helper.js`, `scripts/subscription-reconcile.test.js`.

### Suites complètes

| Dépôt | Résultat |
|---|---|
| **Panel** — `tests/run-all.js` | **100/101 fichiers OK** |
| **SB Auto** — `npm test` | **exit 0**, zéro échec |

Builds et typechecks verts : Panel (typecheck, lint, build), Manager, Vitrine.

**Le seul rouge est `finance-core.test.js`**, et il appartient au chantier L10.2 :

```
ReferenceError: withReceipts is not defined
```

`withReceipts` n'existe que dans `services/finance/financialTransactions.service.js`, un
fichier **modifié et non committé** par L10.2 — leur édition en cours référence une
fonction qu'ils n'ont pas encore définie, et qui casse leur propre suite déjà committée.
Aucun de mes fichiers n'est impliqué, et §19 interdit de réparer une suite Finances. Non
corrigé.

## 19. Chantier parallèle L10.2

**Oui, et il est apparu pendant le lot.** Deux temps :

*Avant mes modifications* — L10.1 avait committé (`7bde5d0`, `ca9a68c`), 31 fichiers, §1.

*Pendant* — L10.2 a produit, non committé : `config/env.js`, `finances.controller.js`,
`PanelFinancialTransaction.model.js`, `PanelMedia.model.js`,
`finance/{financialTransactions.service,period}.js`,
`upload/{mediaDescriptor.service,mediaPolicy}.js` (modifiés) et
`PanelRecurringCost.model.js`, `finance/{receipts.service,recurrence,recurringCosts.service}.js`,
`upload/{documentValidation,privateMedia.service}.js` (nouveaux) — coûts récurrents,
justificatifs, médias privés, exactement le périmètre annoncé.

**Zéro collision** : aucun fichier commun avec les miens, dans un sens ou dans l'autre.
Aucun n'est modifié, aucun n'est stagé, et leur rouge n'est pas réparé.

## 20. Réserves

1. **Les abonnements historiques ne sont pas adoptés** (§12) et resteront illisibles par
   capacité. Aucun backfill n'a été écrit, et aucun ne doit l'être sur la foi de metadata.
2. **Les résiliations restent locales**, dont `cancelSubscriptionNow` sans idempotence —
   risque connu, re-confirmé, reporté à L6.2G.
3. **`invoice.*` reste non routable** : la famille INVOICE n'a pas de lien.
4. **La corroboration client peut être `false`** sans empêcher l'adoption — c'est
   volontaire, mais cela signifie qu'une session possédée dont le client aurait été créé
   hors du plan de contrôle serait tout de même adoptée. Le fait est journalisé.
5. **Course d'index Mongoose dans `contracts.test.js` (SB Auto)** — latente, documentée
   depuis L6.2C, hors chantier.

## 21. Prochain lot recommandé — *non implémenté*

**L6.2G — les résiliations.** Toutes les conditions manquantes sont maintenant nommées :
ownership acquis, il reste à définir l'`operationId` d'une résiliation (probablement
dérivé, comme `ensure`), sa stratégie d'idempotence — `cancel_at_period_end` est
convergente, `cancel` ne l'est pas — et le sort d'un `UNKNOWN` sur un acte qui décide de
ne plus prélever.

Puis, séparément, la famille INVOICE, qui débloquera `billing.invoice.list` et le routage
des événements de facturation.

---

**STRIPE SUBSCRIPTION OWNERSHIP: PASS**

**GO L6.2G: YES**
