# L6.3 — CUTOVER FINAL : RENDRE LA CENTRALISATION IRRÉVERSIBLE

> **Verdict en tête, parce qu'il change la lecture de tout le reste :
> `BLOCKED`.** Le projet parle encore à Stripe, et il ne peut pas cesser de le
> faire dans ce lot. La raison n'est pas un oubli de migration : c'est que
> **SB Auto provisionne lui-même son endpoint webhook chez Stripe**, à chaque
> démarrage, avec sa propre clé secrète. Lui retirer cette clé ne romprait pas
> un paiement — cela romprait la façon dont le projet APPREND qu'un paiement a
> eu lieu. C'est la STOP CONDITION n°3, mot pour mot.

> **Ce que le lot a tout de même rendu irréversible.** Neuf verbes Stripe ont
> été supprimés physiquement des deux fichiers qui les portaient, et la surface
> résiduelle est désormais **gelée par une suite de gardes statiques** : elle ne
> peut plus que rétrécir. Trois fichiers, et trois seulement, ont le droit de
> lire la clé secrète ; en ajouter un quatrième fait rougir la suite.

---

## 0. Baseline et travail parallèle

| Dépôt | HEAD au démarrage | Arbre au démarrage |
|---|---|---|
| Panel | `3b6b509` | **propre** |
| SB Auto 06 | `7a6ea6e` | **propre** |

**L10.4 est apparu EN COURS DE LOT**, non committé, dans le Panel. Douze
fichiers, dont six que L6.3 aurait pu vouloir toucher :

```
 M backend/src/models/PanelProviderRevenueFact.model.js
 M backend/src/services/capabilities/capabilityGateway.service.js
 M backend/src/services/capabilities/capabilityRegistry.js        ← partagé
 M backend/src/services/capabilities/invocationContext.js
 M backend/src/services/finance/providerRevenue/revenueProjection.service.js
 M backend/src/services/finance/providerRevenue/stripeRevenueNormalizer.js
 M backend/src/services/integratedApi/stripe/stripeAdapters.js    ← partagé
 M backend/src/services/integratedApi/stripe/stripeCapabilities.js ← partagé
 M backend/src/services/integratedApi/stripe/stripeTransport.js   ← partagé
?? backend/src/models/PanelRefundRequest.model.js
?? backend/src/services/finance/refunds/
?? backend/src/services/integratedApi/stripe/stripeRefundAuthority.js
```

**Aucun de ces douze fichiers n'a été lu pour décision, modifié, restauré,
reformaté ni stagé.** L6.3 n'a touché qu'**un seul** fichier du Panel :
`tests/stripe-ownership-invariants.test.js`, absent de la liste ci-dessus.
`git add -A`, `git add .`, stash, reset et checkout globaux n'ont jamais été
employés.

---

## 1. Quels appels Stripe locaux existaient avant ?

Cartographie exhaustive du runtime SB Auto — recherche sur le SDK, le
constructeur, l'adresse `api.stripe.com`, les familles d'objets, les credentials
et les variables d'environnement, sans se limiter aux fichiers connus.

**Le pilote local exposait treize verbes.** Neuf n'avaient plus aucun appelant.

| Verbe | R/W | Appelants runtime avant L6.3 | Classe | Décision |
|---|---|---|---|---|
| `createCustomer` | W | 0 | **E — DEAD** | supprimé |
| `createProduct` | W | 0 | **E — DEAD** | supprimé |
| `createPrice` | W | 0 | **E — DEAD** | supprimé |
| `createCheckoutSession` | W | 0 | **E — DEAD** | supprimé |
| `retrieveCheckoutSession` | R | 0 | **E — DEAD** | supprimé |
| `retrieveSubscription` | R | 0 | **E — DEAD** | supprimé |
| `listSubscriptions` | R | 0 | **E — DEAD** | supprimé |
| `cancelSubscriptionAtPeriodEnd` | W | 0 | **E — DEAD** | supprimé |
| `cancelSubscriptionNow` | W | 0 | **E — DEAD** | supprimé |
| `createBillingPortalSession` | **W** | 1 (`contract.admin.controller:132`) | **A — CONTROL_PLANE** | **subsiste — aucune capacité** |
| `retrievePaymentIntent` | R | 1 (`payment.service:512`) | **A — CONTROL_PLANE** | **subsiste — aucune capacité** |
| `retrieveInvoice` | R | 2 (`billing.service:263`, `subscription.service:603`) | **A — CONTROL_PLANE** | **subsiste — aucune capacité** |
| `listInvoices` | R | 2 (`billing.service:169`, `:298`) | **A — CONTROL_PLANE** | **subsiste — capacité FERMÉE** |

**Hors pilote**, deux chemins supplémentaires atteignent Stripe :

| Site | Opération | R/W | Classe | Décision |
|---|---|---|---|---|
| `webhooks/remoteWebhookAdapters.js` | `/v1/webhook_endpoints` CRUD | **W** | **B — WEBHOOK_INGRESS** | **subsiste — blocage structurel** |
| `providerConnectionTest.service.js` | `GET /v1/account` | R | **C — DIAGNOSTIC** | **subsiste — dépend de la clé** |

Et un champ de credential **jamais lu par aucun code** :

| Champ | Lecteurs | Classe | Décision |
|---|---|---|---|
| `publishableKey` | **0** | **E — DEAD** | **supprimé du catalogue** |

## 2. Lesquels étaient runtime ?

Tous ceux marqués « subsiste » : chacun est atteignable depuis une route réelle,
et je l'ai vérifié en remontant la chaîne d'appel, pas en lisant un nom.

- `createBillingPortalSession` ← `POST /api/my-contract/payment-method/portal`
- `retrievePaymentIntent` ← `reconcileLaunchFeePayment` ← route dev **et**
  `reconciliation.service` (tâche périodique)
- `retrieveInvoice` / `listInvoices` ← `syncContractInvoices`,
  `attachInvoiceFromUrl` ← routes dev et réconciliation
- `remoteWebhookAdapters` ← **`bootstrap.js:557`**, à chaque démarrage, plus une
  veille ngrok toutes les 60 s en TEST
- `providerConnectionTest` ← `POST /api/integrated-apis/:provider/modes/:mode/test`

Les neuf autres avaient **zéro** appelant. C'est ce qui a rendu leur suppression
sûre — et c'est aussi ce qui la rendait nécessaire : un verbe sans appelant n'est
pas inoffensif, c'est un verbe qui attend le sien.

## 3. Lesquels ont été supprimés ?

**Neuf méthodes du pilote**, retirées de `stripe.provider.js` **et** de
`stripe.stub.js` le même jour. Supprimées physiquement, jamais désactivées : une
méthode qui existe finit par être appelée, et un commentaire « ne plus utiliser »
n'a jamais arrêté personne.

Le **stub** comptait autant que le pilote. Tant qu'il exposait
`createCheckoutSession`, il restait possible d'écrire un test pour un geste qui
n'existe plus — et un test qui passe réclame ensuite son implémentation. Les deux
fichiers sont désormais miroirs, et une garde le vérifie.

**Plus `publishableKey`**, retirée du catalogue IntegratedAPI. Aucun code ne l'a
jamais lue : elle n'existait que comme **champ de saisie** dans le Manager. Un
endroit de plus où coller une clé Stripe, sans qu'un seul geste n'en dépende.

## 4. Reste-t-il un appel Stripe API sortant depuis SB Auto ?

**Oui. `LOCAL_RUNTIME_STRIPE_API_CALLS = 6.`**

```
createBillingPortalSession   WRITE   parcours « modifier mon moyen de paiement »
retrievePaymentIntent        READ    réconciliation des frais de lancement
retrieveInvoice              READ    ×2 — rattachement et enrichissement facture
listInvoices                 READ    ×2 — backfill et recherche par URL hébergée
/v1/webhook_endpoints        WRITE   provisionnement de l'endpoint du projet
GET /v1/account              READ    diagnostic « la clé répond-elle ? »
```

## 5. Reste-t-il une API secret key Stripe utilisée au runtime projet ?

**Oui. `LOCAL_RUNTIME_STRIPE_SECRET_READS = 3.`**

```
services/stripe/stripe.provider.js            les 4 appels métier ci-dessus
services/webhooks/remoteWebhookAdapters.js    l'endpoint webhook du projet
services/providerConnectionTest.service.js    le diagnostic de connexion
```

Un point vaut d'être noté, parce qu'il mesure ce que les lots précédents ont
réellement obtenu : **aucun service métier ne lit la clé.** Pas un seul fichier
de `contract`, `payment`, `subscription`, `billing` ou `reconciliation`. Les
trois lecteurs sont un adaptateur de transport, un gestionnaire de webhook et un
diagnostic. Une garde statique le vérifie explicitement.

## 6. Reste-t-il un fallback ?

**Non. `LOCAL_STRIPE_FALLBACKS = 0`**, et c'est vérifié structurellement plutôt
que déclaré.

La garde cherche le motif exact `try { capacité } catch { Stripe local }` dans
les six services migrés, en inspectant le **corps** de chaque `catch` — pas
seulement la présence des deux mots dans le fichier. Zéro occurrence.

C'est le motif le plus dangereux du parc, parce qu'il se présente comme une
qualité : « rendre le système robuste ». Il réactive la clé du projet exactement
le jour où le Panel est indisponible — c'est-à-dire le jour où personne ne
regarde le journal.

## 7. Pourquoi les éventuels webhook secrets restent-ils ?

C'est la question centrale du lot, et elle a fallu la trancher sur
l'architecture réelle plutôt que sur l'intention.

**Stripe appelle-t-il le Panel ?** Oui — `POST /webhooks/providers/stripe`, avec
le secret du coffre du Panel, vérifié par lui, routé par appartenance (L6.2C),
projeté en faits financiers (L10.3).

**Stripe appelle-t-il SB Auto ?** Oui, aussi — `POST /api/webhooks/stripe`, avec
le `webhookSecret` du projet, vérifié par lui.

**Les deux, donc.** Deux endpoints distincts, deux secrets distincts, deux
vérifications de signature indépendantes.

**Le Panel relaie-t-il l'événement au projet ?** **Non**, et c'est le fait
décisif. La fonction d'acheminement du Panel (`dispatchDeliveryEvent`) sort
immédiatement pour tout fournisseur autre que Brevo. Il n'existe aucun chemin
Panel → projet pour un événement Stripe métier.

**Conséquence :** l'endpoint de SB Auto est le **seul** moyen par lequel le
projet apprend qu'un paiement a abouti. Supprimer son `webhookSecret` ferait
perdre des événements — pas « peut-être » : mécaniquement.

Le secret de signature reste donc, et il reste **légitimement** :

> Un secret de vérification webhook ne permet **pas** d'appeler Stripe. Il ne
> permet que de constater qu'un message reçu vient bien de Stripe. Le confondre
> avec une clé secrète d'API serait l'erreur la plus coûteuse de ce lot : dans
> un sens on ferme une porte de sortie, dans l'autre on se rend sourd.

Il est d'ailleurs **auto-géré** : capturé à la création de l'endpoint distant —
la seule fois où Stripe le renvoie — puis chiffré. Il n'est jamais saisi à la
main, et le Manager l'affiche en lecture seule. Une garde vérifie qu'il conserve
ce statut.

## 8. Le Manager permet-il encore de saisir une clé ?

**Oui, `secretKey` — et il le doit, puisque trois fichiers la lisent encore.**

Masquer le champ pendant que le code en dépend aurait été exactement ce que la
mission interdit : **simuler la centralisation**. Le premier développeur à
supprimer la clé « puisque le formulaire a disparu » aurait cassé
l'enregistrement du webhook, donc la remontée des paiements — silencieusement,
et sans qu'aucun paiement n'échoue pour autant.

Le Manager dit donc la **vérité**, qui est plus utile qu'un slogan :

> **Les paiements passent par la plateforme.** Encaissement, abonnement,
> résiliation : le Panel les exécute avec sa propre clé, et celle-ci n'y
> participe plus. Elle reste nécessaire pour deux choses seulement — enregistrer
> l'adresse de webhook de ce projet chez Stripe, et répondre au test de
> connexion. **Ne la supprimez pas** : les paiements continueraient, mais ce
> projet cesserait d'être averti qu'ils ont eu lieu.

Le champ `publishableKey`, lui, a disparu de l'écran — automatiquement, sans une
ligne de front : le Manager rend les champs déclarés par le catalogue backend.
La conception générique a payé.

## 9. L'API permet-elle encore de l'écrire ?

**Oui. `PROJECT_STRIPE_SECRET_WRITES ≠ 0`** — `PUT /api/integrated-apis/STRIPE/modes/:mode`
accepte toujours `secretKey`.

Verrouiller cette route est **impossible tant que le provisionnement du webhook
en dépend** : on interdirait d'écrire une clé dont le démarrage a besoin. Un
projet neuf ne pourrait plus enregistrer son endpoint, donc ne recevrait jamais
d'événement.

C'est le même blocage que la question 8, vu depuis l'autre bout. Il tombera dans
le même lot.

## 10. Les IDs Stripe historiques sont-ils préservés ?

**Oui, intégralement**, et une garde le vérifie champ par champ :

```
Contract.stripe.customerId          Contract.stripe.subscriptionId
Contract.stripe.checkoutSessionId   Payment.idempotencyKey
Payment.stripe.paymentIntentId      Invoice.stripe.*  +  Invoice.environment
```

Le principe : **le projet peut cesser de POSSÉDER Stripe tout en gardant la
mémoire des actes passés.** Ces identifiants ne sont pas des credentials, ce sont
des références comptables — et Finances (L10.3) s'en sert pour rattacher un
revenu à un contrat. Les effacer « puisque Stripe s'en va » romprait cette chaîne
sans rien sécuriser.

## 11. Que deviennent les credentials existants ?

**`secretKey` — CONSERVÉE, encore lue, encore écrite.** Aucune purge : trois
lecteurs actifs, dont un au démarrage. La purger serait une destruction de
donnée avec `READERS = 3`.

**`webhookSecret` — CONSERVÉE**, auto-gérée, et légitime tant que l'endpoint du
projet vit (question 7).

**`publishableKey` — SUPPRIMÉE DU CATALOGUE, PAS DE LA BASE.** Le champ ne peut
plus être saisi ni affiché, mais les valeurs déjà chiffrées en base ne sont pas
touchées. C'est délibéré : `READERS = 0` est prouvé, mais une purge reste une
destruction irréversible, et la mission demande pour cela une migration dédiée
avec comptage avant/après. Le champ est donc **deprecated** ; la purge appartient
à un lot de migration, pas à celui-ci.

## 12. L10.3 fonctionne-t-il toujours ?

**Oui.** Aucun fichier Finances n'a été modifié — ni logique, ni test, ni
modèle. L6.3 n'a touché aucun chemin de projection de revenu, de routage
webhook, de fait normalisé, de provenance ni de référence de facture.

Les suites Finances (`finance-core`, `finance-recurring`, `finance-receipts`,
`finance-stripe-revenue`, `finance-ui`) sont **vertes** dans le passage complet.

Le futur L10.4 (remboursement) est **en cours dans l'arbre**, et n'a pas été
perturbé : ses douze fichiers sont intacts.

## 13. Quels garde-fous empêchent une réintroduction ?

Une suite dédiée, `backend/src/scripts/stripe-local-surface.test.js` — **58
assertions, 0 échec**, enregistrée dans `npm test`. Elle ne cherche pas des noms
de fichiers : elle cherche des **capacités**.

1. **Un seul client Stripe.** Le SDK est importé par un fichier, `new Stripe(` y
   apparaît une fois. Un second fait rougir.
2. **La surface exacte.** Le pilote expose quatre méthodes, nommées une par une.
   Une cinquième — même utile, même bien écrite — échoue.
3. **Les neuf retirées ne reviennent pas.** Ni par leur nom, ni par les
   primitives du SDK correspondantes (`customers.create`, `subscriptions.cancel`,
   `checkout.sessions.retrieve`…), cherchées dans **tout** le runtime. Retirer nos
   noms sans interdire ceux du SDK n'aurait rien fermé.
4. **Le stub ne prend pas d'avance.** Aucun geste que le pilote n'a plus.
5. **La liste des lecteurs de la clé est gelée à trois.** C'est la garde la plus
   utile du lot : une adresse en dur se contourne, la lecture du secret non —
   sans elle, aucun appel sortant n'est possible.
6. **Aucun service métier ne lit la clé.**
7. **Aucun repli local**, cherché dans le corps des `catch` des six services
   migrés.
8. **Aucun champ de saisie inutile**, et les deux secrets restants restent
   distincts par nature.
9. **Les références historiques sont là.**

Plus, côté Panel, trois invariants mis à jour dans
`stripe-ownership-invariants.test.js` : le pilote n'expose plus
`createCheckoutSession`, `retrieveCheckoutSession` ni `createCustomer`.

**Ce que ces gardes obtiennent réellement** : la surface résiduelle ne peut plus
que **rétrécir**. C'est un cran en dessous de l'objectif — mais c'est un cran
qui, lui, est acquis, et qui tient pendant que les capacités manquantes
s'écrivent.

## 14. Quels fichiers ont été supprimés ?

**Aucun fichier entier**, et c'est volontaire : chacun des fichiers touchés
contient encore des fonctions légitimes. Ce sont des **fragments** qui ont
disparu.

```
services/stripe/stripe.provider.js   −9 méthodes  (13 → 4)
services/stripe/stripe.stub.js       −9 méthodes + 2 helpers morts + 1 map morte
utils/integratedApiCatalog.js        −1 champ de credential (publishableKey)
```

## 15. Quelles réserves restent ?

1. **L'objectif du lot n'est pas atteint, et il ne pouvait pas l'être.** Six
   appels sortants subsistent. Ce n'est pas une exécution partielle : c'est un
   blocage architectural que l'audit a mis au jour — le projet provisionne son
   propre endpoint webhook. Aucune quantité de nettoyage ne l'aurait levé.

2. **Le blocage a une forme précise, donc une solution précise.** Il faut que le
   Panel puisse enregistrer, chez Stripe et avec SA clé, un endpoint pointant
   vers l'URL publique du PROJET, puis lui rendre le secret de signature. Le
   Panel sait déjà faire les deux tiers du chemin
   (`providerWebhookAdapters.js` pilote `/v1/webhook_endpoints`), mais son
   réconciliateur suppose que l'URL est la sienne, et son modèle de lien n'a pas
   de place pour une adresse étrangère. C'est un lot, pas un correctif.

3. **Un secret traverserait le pont.** La solution ci-dessus rendrait un
   `whsec_` au projet, ce que la frontière L4 interdit pour les identifiants
   fournisseur. La mission tranche explicitement en faveur de cette exception —
   un secret de vérification n'est pas une clé d'appel — mais la garde de
   frontière devra apprendre à distinguer les deux, sans quoi elle refusera le
   transfert ou, pire, sera assouplie en bloc.

4. **Quatre appels métier restent sans capacité**, et ils ne sont pas de même
   difficulté. `billing.portal.create` est simple : le client est possédé depuis
   L6.2D, l'ownership est prouvable, c'est une session à usage unique. Les trois
   lectures de facture sont plus dures : l'appartenance d'une facture n'est pas
   établie, et `billing.invoice.list` est restée fermée pour cette raison exacte.
   Il faudra soit une adoption par filiation (l'abonnement désigne sa dernière
   facture, comme la session désignait l'abonnement en L6.2F), soit accepter que
   la liste passe par le client possédé.

5. **Le diagnostic de connexion teste la mauvaise clé.** `POST …/modes/TEST/test`
   éprouve la clé du projet, alors que les paiements passent par celle du Panel.
   Le Manager le dit maintenant en toutes lettres, mais le bouton reste
   trompeur — c'est exactement le défaut que L8.2 avait corrigé pour Brevo, et il
   se corrigera de la même façon, quand la clé locale disparaîtra.

6. **Trois suites du Panel sont rouges, et ce n'est pas L6.3.** Dix assertions
   dans `capability-gateway`, `stripe-control-plane` et
   `stripe-resource-ownership` comptent ou nomment les capacités du catalogue.
   Elles échouent parce que **L10.4 ajoute `billing.refund`** dans son diff non
   committé. Preuve : mon arbre Panel était propre au démarrage ; je n'ai modifié
   qu'un fichier du Panel, absent de leur liste ; et chacune des dix assertions
   nomme `billing.refund` ou compte un catalogue que leur diff modifie. Elles
   n'ont **pas** été touchées — c'est à L10.4 de les mettre à jour, comme L6.2G
   l'avait fait pour les siennes.

7. **`stripe` reste une dépendance du `package.json` de SB Auto.** La retirer
   était tentant et aurait été un beau signal — mais le pilote l'importe encore
   pour ses quatre appels. Un `npm remove` aujourd'hui casserait le démarrage.

---

## Compteurs finaux

```
LOCAL_RUNTIME_STRIPE_API_CALLS       = 6     (cible : 0)
LOCAL_RUNTIME_STRIPE_SECRET_READS    = 3     (cible : 0)
LOCAL_STRIPE_FALLBACKS               = 0     ✔ atteint
PROJECT_STRIPE_SECRET_WRITES         ≠ 0     (cible : 0)

LOCAL_RUNTIME_STRIPE_WRITES (métier) = 1     createBillingPortalSession
SURFACE DU PILOTE                    = 4     (était 13)
```

## Suites

| Suite | Résultat |
|---|---|
| SB Auto — `npm test` (80 fichiers chaînés) | **exit 0, zéro échec** |
| SB Auto — `stripe-local-surface` (nouvelle) | **58 / 0** |
| Panel — `stripe-ownership-invariants` | **106 / 0** |
| Panel — `tests/run-all.js` | **101 / 105** — 4 fichiers rouges, **tous L10.4** (réserve 6) |
| Panel frontend — `tsc` + build | OK |
| SB Auto `manager` — `tsc` + build | OK |
| SB Auto `vitrine` — `tsc` + build | OK |

---

STRIPE FINAL CONTROL PLANE CUTOVER: BLOCKED

**Raison exacte :** `SB Auto` provisionne son propre endpoint webhook chez
Stripe (`/v1/webhook_endpoints`, appelé depuis `bootstrap.js` à chaque
démarrage) et cette opération exige sa clé secrète d'API. Le Panel ne relaie
aucun événement Stripe métier vers le projet — l'endpoint du projet est donc
porteur, pas décoratif. Supprimer la clé, ou verrouiller sa route d'écriture,
ferait perdre des événements de paiement : **STOP CONDITION n°3**. S'y ajoutent
quatre appels métier (un portail, trois lectures de facture) pour lesquels
aucune capacité Panel n'existe : **STOP CONDITION n°1**.
