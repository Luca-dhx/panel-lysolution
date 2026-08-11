# Stripe — fondation du plan de contrôle (L6.1)

> **Lot FOUNDATION.** Aucun paiement n'a été migré. Aucune capacité Stripe n'est
> servie. Ce qui est livré : l'inventaire réel, les contrats, le transport, et
> **le verrou qui manque** — sans lequel aucun cutover ne peut commencer.

---

## 1. Inventaire — le code, pas les rapports

Trois fichiers portent tout Stripe côté projet :
`services/stripe/stripe.provider.js` (client), `stripe.service.js`
(orchestration, signature webhook), `stripe.stub.js` (tests).

**Treize méthodes** exposées par le provider, **31 sites d'appel** répartis sur
six services métier.

| # | Méthode provider | Objet Stripe | R/W | Appelant réel | Idempotence actuelle | Criticité |
|---|---|---|---|---|---|---|
| 1 | `createCustomer` | Customer | W réversible | `subscription.ensureCustomer` | clé fournie | moyenne |
| 2 | `createProduct` | Product | W réversible | `ensureProductAndPrice` | clé fournie | faible |
| 3 | `createPrice` | Price | W réversible | `ensureProductAndPrice` | clé fournie | faible |
| 4 | `createBillingPortalSession` | BillingPortal | W réversible | `subscription.js:525` | clé fournie | faible |
| 5 | `createCheckoutSession` | CheckoutSession | **W FINANCIER** | `payment.createOrReuseLaunchCheckout`, `subscription.createOrReuseSubscriptionCheckout` | `launch-{id}-v{n}-a{n}-{mode}`, persistée sur `Payment` | **haute** |
| 6 | `cancelSubscriptionAtPeriodEnd` | Subscription | **W FINANCIER** | `stripe.service:128` | `cancel-{subId}` | **haute** |
| 7 | `cancelSubscriptionNow` | Subscription | **W FINANCIER** | `contract.service:755`, `contractTestTools` ×2 | **aucune** | **haute** |
| 8 | `retrieveCheckoutSession` | CheckoutSession | R | `payment` ×2, `subscription` ×2 | sans objet | moyenne |
| 9 | `retrievePaymentIntent` | PaymentIntent | R | `payment.reconcileLaunchFeePayment` | sans objet | moyenne |
| 10 | `retrieveSubscription` | Subscription | R | `subscription` ×2 | sans objet | moyenne |
| 11 | `listSubscriptions` | Subscription | R | `subscription.js:444` | sans objet | faible |
| 12 | `retrieveInvoice` | Invoice | R | `billing` ×1, `subscription` ×1 | sans objet | faible |
| 13 | `listInvoices` | Invoice | R | `billing` ×2 | sans objet | faible |

### 1.1 Ce que l'inventaire dément

- **Aucun remboursement n'est jamais émis.** `refunds.create` n'existe nulle
  part. L'événement `charge.refunded` est *consommé*, donc un remboursement peut
  arriver — mais toujours depuis le tableau de bord Stripe. Contractualiser
  `billing.refund` créerait la capacité la plus dangereuse du système pour un
  usage qui n'existe pas. **Elle n'est pas déclarée.**
- **`cancelSubscriptionNow` n'a aucune clé d'idempotence.** Trois appelants, une
  écriture financière irréversible. C'est le trou le plus net de l'état actuel.
- **Aucun `PaymentIntent` n'est confirmé côté serveur** : tout passe par Checkout
  hébergé.

---

## 2. Clés — où elles sont, et ce qui touche le navigateur

| Rôle | Projet | Panel | Runtime | Navigateur |
|---|---|---|---|---|
| `secretKey` | **présente** (chiffrée, `IntegratedApi`) | **présente** (chiffrée, `PanelIntegratedApiCredentialSet`) | oui | jamais |
| `webhookSecret` | **présente** | **présente** | oui (vérification) | jamais |
| `publishableKey` | déclarée au catalogue, **jamais lue** | déclarée, non requise | **non** | **non** |
| `baseUrl` | présente (éditable) | présente | oui | non |

**Aucune valeur n'est reproduite ici.**

### 2.1 Stripe.js : rien à préserver

Recherche `loadStripe`, `@stripe/`, `stripe.js`, `pk_test`, `pk_live` sur le
backend, le Manager et la vitrine : **zéro occurrence**. Le parcours entier est
un **Checkout hébergé** — le navigateur reçoit une URL Stripe et s'y rend.

Il n'y a donc **aucune** clé publiable à protéger, aucun `client_secret`
éphémère, aucun risque de « casser Stripe.js par dogmatisme ». La mise en garde
de la mission est levée par constat : `publishableKey` est du poids mort au
catalogue, et sa suppression sera un nettoyage sans effet fonctionnel — hors
périmètre L6.1.

---

## 3. Environnement : le projet choisit-il encore ?

**Non.** L2 a été appliqué : `resolveProviderEnvironment('STRIPE')` dérive du
runtime, `activeMode` subsiste en base comme **diagnostic** et n'est plus lu par
aucune décision. `verifyStripeWebhookAnyMode` n'essaie plus qu'un seul secret —
celui du monde servi ; son nom est un vestige.

Les contrats de L6.1 refusent en entrée `mode`, `environment`, `livemode`,
`stripeEnvironment`, `account`, `stripeAccount` et tout credential — vérifié par
test sur les cinq capacités.

`describeAccount` remonte le `livemode` **de Stripe** : c'est la seule source qui
dise avec certitude dans quel monde une clé place le Panel, et elle permettra de
détecter une clé LIVE saisie dans une instance TEST.

---

## 4. Données historiques à conserver

`Payment.providerMode`, `Payment.applicationEnvironment`, `Payment.environment`,
`Payment.idempotencyKey`, `Payment.attempt`, `Contract.stripe.*`.

> Une ligne disant « ce paiement a été encaissé en TEST » reste **vraie** et
> reste **utile** : c'est la preuve d'une exécution passée. Ce qui devait
> disparaître — « le projet choisit maintenant d'utiliser TEST » — a disparu en
> L2. **Rien ne doit être supprimé.**

L'inventaire L1.5 avait trouvé un paiement `PAID · environment PROD ·
providerMode TEST` : c'est exactement la ligne qu'il ne faut pas réécrire.

---

## 5. Le verrou manquant — résultat principal du lot

Pour Hostinger (L9), l'appartenance venait d'une relation que le Panel tenait
déjà : `PanelProjectDestination` dit quel projet possède quel nom d'hôte.

**Pour Stripe, cette relation n'existe pas.** Vérifié dans
`bridgeContract.contractPayloadSchema` : la projection de contrat transporte le
statut, la référence, le document et les tarifs — **aucun identifiant Stripe**.
Le Panel ne sait pas quel `cus_…`, `sub_…` ou `cs_…` appartient à quel projet.

```
CONSÉQUENCE : aucune capacité Stripe acceptant un identifiant de ressource
ne peut être servie tant que ce lien n'existe pas côté Panel.
```

Sans lui, un projet appairé lirait les factures — ou résilierait l'abonnement —
d'un autre client du même compte Stripe. Ce serait **pire** que l'état actuel,
où chaque projet détient une clé qui n'ouvre que son propre compte.

`stripeResourceOwnership.js` pose le contrat du lien, et nomme les deux routes
possibles pour le peupler :

| Route | Sûreté | Commentaire |
|---|---|---|
| `CREATED_BY_PANEL` | **sûre** | Le lien naît d'un acte que le Panel a exécuté. Amorçage : les ressources antérieures restent sur le chemin local. **Route retenue.** |
| `LEARNED_FROM_WEBHOOK` | plausible | `metadata.contractId` + projection `sourceContractId`. Fiable seulement sur les objets *que nous avons créés*. |
| `DECLARED_BY_PROJECT` | **refusée** | Ferait de la demande sa propre preuve — ce que L2 interdit. Nommée pour ne pas être redécouverte comme une bonne idée. |

Sans résolveur, `describeResourceOwnership` rend `NO_BINDING` et refuse. **Fail
closed** : une fondation qui autoriserait « faute de mieux » serait une porte
ouverte déguisée en valeur par défaut.

---

## 6. Capacités contractualisées

Cinq, toutes `migrated: false`.

| Capacité | Effet | Idempotence | Ressource à posséder |
|---|---|---|---|
| `billing.invoice.list` | READ_ONLY | `SAFE_RETRY` | CUSTOMER |
| `billing.subscription.retrieve` | READ_ONLY *(proposé)* | `SAFE_RETRY` | SUBSCRIPTION |
| `billing.checkout.retrieve` | READ_ONLY *(proposé)* | `SAFE_RETRY` | CHECKOUT_SESSION |
| `billing.checkout.create` | FINANCIAL_WRITE | `PROVIDER_IDEMPOTENT` | — (elle *crée*) |
| `billing.subscription.cancel_at_period_end` | FINANCIAL_WRITE | `PROVIDER_IDEMPOTENT` | SUBSCRIPTION |

**Ce qui n'est pas contractualisé, et pourquoi :** `createProduct` et
`createPrice` ne sont jamais un but — seulement deux étapes que
`ensureProductAndPrice` traverse ; les exposer donnerait au projet le pouvoir de
créer des produits arbitraires sur le compte de la plateforme.
`createBillingPortalSession` et `cancelSubscriptionNow` attendent L6.2 (la
seconde exige d'abord une clé d'idempotence, qu'elle n'a pas aujourd'hui).

**Le montant ne vient jamais du projet.** `billing.checkout.create` accepte une
*référence de contrat* et un *type de paiement* ; le prix sera lu dans la
projection que le Panel détient déjà. Laisser le projet l'annoncer permettrait de
facturer un euro un contrat à mille — un test refuse `amount`, `unitAmount`,
`price` et `currency` sur les cinq capacités.

---

## 7. Idempotence financière — défense en profondeur

```
PROJET   operationId          l'identité de l'ACTE MÉTIER (≥ 16 caractères)
PANEL    registre d'opérations   PanelCapabilityOperation, index unique
STRIPE   Idempotency-Key      dérivée de l'operationId, JAMAIS régénérée
```

Le registre existe déjà (`operationRegistry.js`, livré par L8.4) avec
`claimOperation` / `settleSucceeded` / `settleFailure(resolved)` et un état
`UNKNOWN`. **L6.1 le réutilise ; il n'en crée pas un second.**

Deux règles du transport, imposées par le code :

1. **Une écriture sans clé d'idempotence est refusée ici, pas chez Stripe.**
   Stripe accepte un POST sans en-tête et crée alors un nouvel objet à chaque
   appel — précisément le comportement qu'on ne veut jamais obtenir par oubli.
2. **La clé vient de l'appelant, jamais du transport.** La générer au moment de
   l'appel la rendrait différente à chaque tentative : la façon exacte de créer
   deux paiements pour un seul acte.

> **Réserve sur l'existant.** La clé actuelle du projet inclut `attempt`, qui
> s'incrémente. Deux tentatives du même acte métier portent donc deux clés — ce
> qui est voulu ici (une nouvelle tentative *est* une nouvelle intention après
> expiration), mais signifie que la protection Stripe ne couvre pas le rejeu
> d'une tentative interrompue. C'est le registre du Panel qui devra le couvrir.

---

## 8. UNKNOWN — le cas qui justifie le lot

```
écriture, Stripe a RÉPONDU (4xx/5xx)   → FAILED   → rien n'a été encaissé
écriture, SILENCE (timeout, réseau)    → UNKNOWN  → l'argent a PEUT-ÊTRE bougé
écriture, 2xx illisible                → UNKNOWN  → objet créé, non identifiable
idempotency_key_in_use (409)           → UNKNOWN  → un autre appel est en cours
idempotency_error (clé, params ≠)      → FAILED   → défaut de construction chez nous
```

`describeRetryDecision` rend `ISSUE_INCONNUE_CONVERGENCE_PAR_CLÉ` : la sortie
d'un `UNKNOWN` passe par **le rejeu de la même clé** — qui rend l'objet déjà créé
— ou par une interrogation de Stripe. **Jamais par un nouvel acte financier.**

`idempotency_key_in_use` mérite son traitement à part : Stripe traite déjà une
requête portant cette clé, et le second appelant ne sait pas si elle aboutira. Le
ranger dans `FAILED` inviterait à recréer avec une clé neuve — c'est-à-dire à
doubler le paiement que la clé devait empêcher.

**Aucune reprise automatique sur une écriture, jamais** — même sur 5xx, même sur
429. Les lectures, elles, sont réessayées avec back-off.

---

## 9. Commercial Readiness

La table de L1.75 connaît déjà `billing.checkout.create` et
`billing.subscription.cancel_at_period_end` en `FINANCIAL_WRITE` : elles sont
**bloquées en `PREOPENING`**, migrées ou non. Vérifié par test.

**Les lectures ne sont pas bloquées**, et c'est délibéré : diagnostiquer et
réconcilier sont précisément ce qu'on fait *avant* d'ouvrir. Une instance en
pré-ouverture doit pouvoir constater l'état de ses abonnements sans avoir le
droit d'encaisser.

`billing.subscription.retrieve` et `billing.checkout.retrieve` ne sont pas encore
dans la table L1.75 : elles portent un effet **proposé** `READ_ONLY`, et la table
officielle l'emporte dès qu'elle les connaîtra (même dispositif qu'en L9).

---

## 10. Webhooks — décision : **on ne touche à rien**

L'existant côté projet est mature : endpoint monté avant `express.json()`,
signature HMAC vérifiée sur le corps brut avec tolérance, déduplication par
`event.id` (`ingest`), refus des événements d'un autre monde, `finalize` avec
statut, treize types consommés.

Les cinq questions de la mission, et les réponses **pour L6.2** :

1. **Le webhook doit-il finir dans le Panel ?** À terme oui — le plafond de 16
   endpoints par compte Stripe est l'argument de fond, et L5 a déjà bâti le
   registre, le réconciliateur et l'ingestion côté Panel.
2. **Quelles données dispatcher au projet ?** Des événements *normalisés*
   (`PAYMENT_SUCCEEDED`, `INVOICE_PAID`…), jamais l'objet Stripe brut.
3. **Un bridge durable existe-t-il ?** Oui : le journal de synchronisation, déjà
   idempotent par `writeId`.
4. **Comment éviter les doubles traitements ?** Les deux endpoints coexisteraient
   pendant la bascule ; la déduplication par `event.id` existe **des deux côtés**,
   ce qui rend la coexistence sûre.
5. **Comment distinguer TEST/PROD sans faire confiance au projet ?** L'instance
   de Panel *est* l'environnement, et la clé Stripe porte son monde
   (`sk_test_`/`sk_live_`). Le projet n'entre pas dans la décision.

**Le cutover webhook est explicitement laissé à L6.2.** Le déplacer dans un lot
de fondation, alors que le remplacement d'un endpoint invalide le secret de
l'ancien, exposerait une fenêtre où des événements de paiement se perdent
définitivement.

---

## 11. Matrice de cutover

| Flux Stripe | Fondation prête | Cutover réalisé | Lot recommandé |
|---|:---:|:---:|---|
| Checkout frais de lancement | contrat ✓ | **non** | L6.2 — après le lien d'appartenance |
| Checkout abonnement | contrat ✓ | **non** | L6.2 |
| Lecture session de paiement | contrat ✓ | **non** | L6.2 — sans toucher à la cadence du parcours de retour |
| Lecture abonnement | contrat ✓ | **non** | L6.2 |
| Liste des factures | contrat ✓ | **non** | L6.2 — la plus simple |
| Résiliation fin de période | contrat ✓ | **non** | L6.3 |
| Résiliation immédiate | **non** | non | L6.3 — exige d'abord une clé d'idempotence |
| Customer / Product / Price | non (non exposées) | non | interne au Panel en L6.2 |
| Billing portal | non | non | L6.3 |
| Remboursement | non (aucun usage) | non | à la demande, jamais « par symétrie » |
| Webhooks | contrats posés | **non** | L6.2 |

**Aucune migration n'a été faite, y compris pour les lectures.** Un READ paraît
inoffensif ; sans lien d'appartenance, `billing.invoice.list` livrerait les
factures d'un client à un autre. La preuve par un petit READ, proposée par la
mission, est donc **refusée en connaissance de cause**.

---

## 12. Tests

`tests/stripe-control-plane.test.js` — **96 assertions**, aucun réseau.

| Exigé | Prouvé |
|---|---|
| contrats | entrées invalides refusées ; 14 champs interdits sur les 5 capacités |
| credential ownership | aucune clé en entrée ; jamais en sortie ni en journal |
| environment ownership | `mode`/`environment`/`livemode` refusés ; PROD refusé depuis TEST |
| commercial readiness | les 2 écritures bloquées en `PREOPENING`, permises en `LIVE` |
| idempotence | écriture sans clé refusée **avant l'appel** ; même clé sur deux appels |
| UNKNOWN | timeout/2xx illisible → `UNKNOWN` ; aucune reprise auto ; lecture ≠ écriture |
| erreurs fournisseur | 401/403/404/400/402/422/429 normalisés ; `request-id` conservé |
| secrets | clé caviardée jusque dans le message d'erreur de Stripe |
| isolation TEST | le monde vient du runtime, jamais d'une charge utile |
| resource ownership | `NO_BINDING` par défaut ; `NOT_OWNED` ne révèle pas le propriétaire |

**Non-régression** — SB Auto : `stripe` 34, `payments-flow` 69,
`subscription-flow` 73, `billing-flow` 46, `contract-lifecycle` 46,
`billing-portal` 31, `subscription-reconcile` 48,
`contract-billing-signature` 31, `webhook-orchestrator` 35,
`contract-immediate-cancel` 55, `cancellation-mode` 15,
`env-mode-independence` 12, `active-mode-revoked` 26,
`integrated-api-environment-routing` 36. Panel : `hostinger-control-plane` 118,
`capability-gateway` 105, `integrated-api-provider-registry` 67,
`commercial-readiness` 73. **Tous verts.**

Le parcours de vérification de paiement côté UI n'a **pas** été touché.

---

## 13. Deux défauts trouvés dans mon propre code, et corrigés

1. **Le minuteur de back-off était `unref`** — dans le transport Stripe *et*
   dans celui d'Hostinger (L9). On attendait un minuteur qu'on avait détaché :
   dans une boucle d'événements au repos, la reprise ne partait jamais.
   Silencieux en production (un serveur tient la boucle), bloquant en test — la
   pire des combinaisons.
2. **Le message d'erreur de Stripe était relayé tel quel.** Un message peut
   contenir la clé (`Invalid API Key provided: sk_live_…`). Les messages
   fournisseur sont désormais caviardés à la forme, comme le fait la garde de
   pont L4.

---

## 14. Risque de double paiement / double remboursement

| Risque | État |
|---|---|
| Double paiement par la fondation | **nul** — aucune écriture n'est servie |
| Double paiement par l'existant | inchangé : réutilisation de session ouverte + clé persistée |
| Double remboursement | **impossible** — aucun code n'émet de remboursement |
| Rejeu aveugle d'un `UNKNOWN` | interdit par construction (`replaySafe: false`) |
| Écriture sans clé d'idempotence | refusée par le transport |

**Point d'attention pour L6.2** : `cancelSubscriptionNow` n'a aujourd'hui aucune
clé d'idempotence, et trois appelants. C'est le seul endroit du parc où une
écriture financière peut être rejouée sans garde-fou.

---

## 15. Réponses aux vingt questions

1. **31 sites d'appel**, 13 méthodes provider.
2. Customer, Product, Price, CheckoutSession, PaymentIntent, Subscription,
   Invoice, BillingPortalSession.
3. **READ** : `retrieveCheckoutSession`, `retrievePaymentIntent`,
   `retrieveSubscription`, `listSubscriptions`, `retrieveInvoice`,
   `listInvoices`.
4. **WRITE** : `createCustomer`, `createProduct`, `createPrice`,
   `createBillingPortalSession`, `createCheckoutSession`,
   `cancelSubscriptionAtPeriodEnd`, `cancelSubscriptionNow`.
5. **Financièrement critiques** : `createCheckoutSession`,
   `cancelSubscriptionAtPeriodEnd`, `cancelSubscriptionNow`.
6. Chiffrées des deux côtés : `IntegratedApi` (projet), `PanelIntegratedApiCredentialSet` (Panel).
7. **Non** — L2 appliqué ; `activeMode` ne subsiste qu'en diagnostic.
8. `Payment.providerMode`, `.applicationEnvironment`, `.environment`,
   `.idempotencyKey`, `.attempt`, `Contract.stripe.*`.
9. Cinq (§6), aucune servie.
10. Schémas `strict()` d'entrée et de sortie pour les cinq.
11. Blocage des deux `FINANCIAL_WRITE` en `PREOPENING` ; lectures permises.
12. `operationId` projet → registre Panel → `Idempotency-Key` Stripe.
13. `UNKNOWN` distinct de `FAILED` ; convergence par la clé, jamais par un
    nouvel acte.
14. Endpoint Panel à terme, coexistence pendant la bascule, événements
    normalisés — **en L6.2**.
15. **Rien.** Aucun appel Stripe n'a changé de chemin.
16. Toute la matrice du §11.
17. §12.
18. 96 assertions L6.1 + 18 suites de non-régression, **0 échec**.
19. §16.
20. §14 — nul pour la fondation ; un point d'attention hérité.

---

## 16. Fichiers

**Panel** — `services/integratedApi/stripe/stripeTransport.js`,
`stripeCapabilities.js`, `stripeResourceOwnership.js` *(nouveaux)* ·
`services/integratedApi/hostinger/hostingerTransport.js` *(correctif back-off)* ·
`tests/stripe-control-plane.test.js` *(nouveau)* · ce document.

**SB Auto** — aucun fichier modifié.

---

**STRIPE CONTROL PLANE FOUNDATION: READY WITH BLOCKERS**

Les contrats, l'ownership d'environnement et de credentials, et la stratégie
d'idempotence financière sont solides. Le cutover ne peut pas commencer tant que
le **lien projet ↔ ressource Stripe** n'existe pas côté Panel : c'est le
prérequis n°1 de L6.2, et il est mécanique — le Panel enregistre le lien au
moment où il crée l'objet.
