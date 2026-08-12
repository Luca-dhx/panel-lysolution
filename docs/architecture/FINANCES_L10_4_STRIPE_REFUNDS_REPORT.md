# FINANCES L10.4 — REMBOURSEMENTS STRIPE

> Rapport de lot. Le mécanisme durable est documenté dans
> [`62_FINANCIAL_LEDGER.md`](./62_FINANCIAL_LEDGER.md) § 8 et § 13 quinquies — ce fichier-ci
> rend compte des **décisions**, de ce qui a été **audité avant** d'être écrit, et de ce qui
> a été **trouvé en recette**.

---

## 0. Baselines réelles

| | Au démarrage | À la livraison |
|---|---|---|
| Panel | `3b6b509` | `b70051a` + ce lot |
| SB Auto 06 | `7a6ea6e` | `8417084` — **inchangé par L10.4** |

Les HEAD ont été **résolus, pas repris de l'énoncé**. Deux écarts constatés :

- l'énoncé annonçait « L10.3 a livré : Panel `141bfde`, SB Auto `70e069c` ». `70e069c` est en
  réalité un commit **du Panel** : L10.3 n'a jamais touché SB Auto ;
- pendant le lot, le chantier **L6.3** a committé des deux côtés (`b70051a` côté Panel,
  `8417084` côté SB Auto). Ses fichiers ont été identifiés et **jamais absorbés** — voir § 12.

---

## 1. L'audit avant d'écrire

### 1.1 Le registre des capacités disait déjà le nom

`billing.refund` **existait** au registre depuis L6, `migrated: false`, avec cette note :

> « L6. Premier usage NEUF du plan de contrôle : aucun code projet ne le fait. »

Le nommage était donc **déjà tranché**. Aucun `billing.refund.create` n'a été inventé.
`commercialReadiness.js` la déclarait déjà `FINANCIAL_WRITE`, `providerRegistry.js` la
listait déjà. Il manquait : le contrat, la primitive de transport, l'adaptateur, l'appelant.

### 1.2 `PANEL_INTERNAL` attendait son premier usage

`INVOCATION_SOURCES.PANEL_INTERNAL` existait, documenté « prévue, pas encore servie ». Un
remboursement est initié par un **opérateur**, pas par un projet : c'est exactement son cas
d'emploi. Aucune source nouvelle n'a été créée.

### 1.3 `PAYMENT_INTENT` était déjà une famille liable

Le modèle `PanelStripeResourceBinding` connaissait `PAYMENT_INTENT` et son préfixe `pi_`
depuis L6.2A — aucun lien n'en avait jamais été écrit. Cette découverte a **changé la
conception** : l'appartenance s'asserte directement sur la ressource mutée, sans filiation
ad hoc dans l'adaptateur.

### 1.4 Ce que Stripe produit comme document — les quatre cas

| Cas | Document Stripe pour le remboursement |
|---|---|
| **A.** Abonnement avec facture | **Aucun.** Une facture finalisée est immuable. Un avoir (`cn_…`) est un objet séparé, à créer explicitement |
| **B.** Checkout non facturé | **Aucun.** Il n'y a pas de facture à créditer |
| **C.** Remboursement partiel | **Aucun.** L'objet `Refund` n'a ni PDF ni page hébergée |
| **D.** Remboursement total | **Aucun** non plus. Aucune différence avec le partiel |

Le seul document réel est le **reçu de la charge** (`charge.receipt_url`), que Stripe réédite
en y portant les sommes rendues.

**Conséquence, et elle est assumée** : rien n'est matérialisé d'office. Pas d'avoir créé (ce
serait un second acte financier chez le fournisseur), pas de « facture de remboursement »
(Stripe ne définit pas cet objet — l'appeler ainsi mentirait sur une pièce comptable), pas de
PDF interne généré (le dépôt n'a aucune bibliothèque PDF, et un tel document devrait être
nommé *document interne L.Y Solution*, jamais présenté comme une pièce Stripe).

Un justificatif reste **attachable à la main** par le protocole Media privé de L10.2.

---

## 2. Les réponses

### Le remboursement est-il un mouvement distinct ?

Oui. `flow: OUTFLOW`, `category: REFUND`, **montant positif**, `origin: STRIPE`,
`parentTransactionId` = l'encaissement. L'encaissement d'origine n'est **jamais** touché :
même montant, même catégorie, même sens, même date.

### Un remboursement peut-il apparaître en COÛT ?

Non, et par construction. `FLOW_IMPOSED_BY_CATEGORY` impose `REFUND → OUTFLOW` depuis L10.1 ;
`category` reste `REFUND` sur les deux écrans. Éprouvé : `+500` encaissé, `200` de coût,
`100` rendus → **les charges restent à 200**, le net descend de 100.

### D'où vient l'identité externe ?

`provenance.externalId = re_…`, `externalKind = REFUND`. Jamais le `pi_` du paiement : deux
remboursements partiels du même paiement se confondraient sous l'index unique de la
provenance, et le registre **perdrait de l'argent rendu**.

`{sourceId, cycleKey}` n'a **pas** été détourné : il appartient aux occurrences de coûts
récurrents et ne dit rien d'un remboursement.

### Comment l'état du paiement est-il représenté ?

`NON_REMBOURSE` / `PARTIELLEMENT_REMBOURSE` / `REMBOURSE`, **calculés** en sommant les
enfants à la lecture. Rien n'est stocké : un solde se désynchronise à la première écriture
arrivée par une voie imprévue, une somme d'écritures ne le peut pas.

### L'environnement est-il dérivé ?

Oui, du fait fournisseur du paiement d'origine. Il est affiché **en lecture seule** dans la
fenêtre. Aucun sélecteur TEST/PROD n'existe nulle part. Un paiement d'un autre monde est
refusé **avant** l'appel, avec un motif explicite — plutôt que de laisser tomber un refus
d'appartenance qu'un opérateur légitime prendrait pour une brèche.

### L'appartenance est-elle exigée ?

Oui, **avant tout contact fournisseur**, sur la ressource réellement mutée. L'intention de
paiement est adoptée à la projection du revenu, par filiation de la session ou de
l'abonnement possédé. Le refus croisé est **indistinct** du refus « inexistante » — vérifié
par comparaison littérale du code et du message.

### Un navigateur peut-il désigner la ressource ?

Non. La route ne lit que `transactionId`, `amountCents`, `reason`, `note`. Contrôlé
statiquement : le corps du contrôleur ne contient ni `paymentIntentId`, ni `chargeId`, ni
`invoiceId`, ni `environment`.

### Que se passe-t-il sur un double clic ?

Une demande, une identité d'acte, une clé d'idempotence. Le rejeu de la même demande ne crée
rien. Deux demandes distinctes sont **deux remboursements légitimes** — c'est voulu : un
paiement de 500 € accepte deux partiels de 100 €.

### Et si la réponse se perd ?

`UNKNOWN`, jamais `FAILED`. Le bouton se ferme, l'écran affiche « vérification du
remboursement en cours », et **aucun bouton « réessayer » n'est offert**. La reprise est
automatique, porte la **même** identité, et reconnaît l'acte chez Stripe s'il a abouti.

### Et un an plus tard, hors fenêtre d'idempotence ?

C'est le scénario le plus dangereux du lot, et il est éprouvé. Au-delà de 24 h, rejouer la
clé ne converge plus : elle créerait un second remboursement réel. L'adaptateur cherche donc
`metadata[ly_operation_id]` dans les remboursements du paiement. Le test coupe la mémoire des
clés du faux Stripe et vérifie qu'**aucune création n'est même tentée**.

### Réponse, webhook, rejeu : combien de lignes ?

Une. Les trois voies traversent le même normalisateur et produisent la même identité
canonique `re_…`. L'index unique de la provenance fait le reste. Éprouvé dans les deux
ordres — réponse puis webhook, et webhook seul (remboursement fait depuis le tableau de bord
Stripe, qui entre quand même au registre, rattaché au bon paiement et au bon projet).

### Les remboursements partiels concurrents ?

Le restant affiché est une **courtoisie d'interface**, jamais un verrou : entre la lecture et
l'écriture, un autre opérateur peut rembourser. La seule autorité atomique sur les sommes est
**Stripe**, qui refuse tout dépassement. Deux partiels concurrents produisent donc au pire un
refus propre, jamais un excédent. Le Panel refuse en amont ce qu'il sait déjà excessif —
avant tout contact fournisseur, et sans laisser de demande orpheline.

### Peut-on supprimer un encaissement remboursé ?

Non. Il laisserait la sortie seule, et le net afficherait une **perte de 100 €** sur une
opération qui a rapporté 400 — un chiffre faux **sans trace**. Refus nommé
(`PANEL_FINANCE_TRANSACTION_HAS_REFUNDS`), pas de cascade : effacer les enfants supprimerait
un mouvement d'argent réel sur une décision que personne n'a prise.

« Tout supprimer » n'a pas besoin de cette garde : un remboursement porte le même `projectId`
que son encaissement, et aucune portée ne retient l'un sans l'autre.

### Le remboursement se voit-il dans SB Auto Manager ?

Oui, **sans une ligne modifiée dans le projet**. SB Auto reçoit le `charge.refunded` que
Stripe émet pour le remboursement créé par le Panel, et sa chaîne existante le traite depuis
toujours : `markRefunded` → `status: REFUNDED` → `refundedAt` → projection contrat → badge
« Remboursé ». Vérifié en exécutant sa propre recette (`payments-flow.test.js`, 70/70).

Deux consommateurs indépendants d'un même fait fournisseur. Aucun couplage, aucune route
nouvelle, aucun refactor — ce que le cahier des charges demandait explicitement d'éviter.

Rien à télécharger côté Manager : un remboursement n'a pas de document (§ 1.4).

### Quelle trace durable ?

`PanelRefundRequest` — qui a demandé, quand, pour quel motif, avec quelle issue, y compris
les tentatives échouées. Elle ne s'efface pas.

La chronologie du projet reçoit **une** entrée, posée par la passerelle. Aucune seconde n'est
écrite : la chronologie est bornée à 300 entrées par projet, et deux lignes pour dire la même
chose consommeraient un budget qui n'est pas l'archive d'un remboursement.

---

## 3. Ce que la recette a trouvé

### 3.1 Un succès qui se concluait en échec

Le contrat de sortie est `strict()`. L'adaptateur rendait un champ de plus
(`operationId`, utile au diagnostic interne). Résultat : **Stripe remboursait**, la passerelle
rejetait la réponse à la validation, et la demande se concluait en `FAILED` — c'est-à-dire en
« l'argent n'est pas parti » sur un argent bel et bien parti. Le bouton se rouvrait.

Deux corrections, et la seconde compte plus que la première :

1. l'adaptateur projette explicitement la vue contractuelle ;
2. **une violation du contrat de sortie bascule désormais en `UNKNOWN`**, comme toute erreur
   non typée et toute erreur non `replaySafe`. On ne conclut « échec » que si le plan de
   contrôle l'affirme.

### 3.2 Une règle trop prudente qui masquait la bonne

La première version listait `TIMEOUT` et `PROVIDER_UNAVAILABLE` comme indécidables. Or
`PROVIDER_UNAVAILABLE` porte `outcome: FAILED` — Stripe a répondu. La liste écrasait le signal
propre du plan de contrôle et rendait un refus franc indécidable. Remplacée par `replaySafe`,
qui est la réponse du plan de contrôle à « le fournisseur a-t-il tranché ? ».

---

## 4. Frontières tenues

| Interdit par le cahier des charges | Constat |
|---|---|
| Réintroduire un credential projet | Aucun. Le coffre du Panel, par la passerelle |
| Réintroduire un provider local | Aucun. `refundOrchestration` ne contient ni `fetch(`, ni adresse Stripe, ni clé — contrôlé statiquement |
| Contourner L6.3 | Non. La capacité **entre** dans le plan de contrôle que L6.3 achève |
| Modifier la doctrine de centralisation | Non. Elle est appliquée, y compris pour un appelant qui n'est pas un projet |
| Nouveau `FinancialFileService` | Aucun |
| `/uploads` public, URL publique | Aucun document n'est matérialisé |
| Chemin spécial localhost, base64 Mongo, ré-implémentation SHA | Aucun |

L6.3 a supprimé neuf primitives de transport devenues sans appelant. L10.4 n'en a réintroduit
aucune : il en **ajoute trois** (`retrievePaymentIntent`, `listRefunds`, `createRefund`), qui
ont chacune un appelant réel — la règle même que L6.3 défend.

---

## 5. Recette

| Suite | Résultat |
|---|---|
| `finance-refunds.test.js` (**neuve**) | **120 / 120** |
| `finance-core` | 138 / 138 |
| `finance-recurring` | 105 / 105 |
| `finance-receipts` | 105 / 105 |
| `finance-stripe-revenue` | 142 / 142 |
| `finance-ui` | 187 / 187 |
| `stripe-control-plane` | 125 / 125 |
| `stripe-resource-ownership` | 103 / 103 |
| `stripe-ownership-invariants` | 106 / 106 |
| `stripe-checkout-cutover-e2e` | 106 / 106 |
| `stripe-subscription-cutover-e2e` | 122 / 122 |
| `stripe-subscription-cancellation-e2e` | 79 / 79 |
| `stripe-checkout-read-webhook-e2e` | 85 / 85 |
| `stripe-customer-ownership-e2e` | 81 / 81 |
| `stripe-subscription-ownership-e2e` | 79 / 79 |
| `capability-gateway` | 120 / 120 |
| `capability-gateway-e2e`, `capabilities`, `capability-preopening` | 66 / 30 / 18 |
| `commercial-readiness`, `-runtime` | 77 / 75 |
| `integrated-api-provider-registry` | 67 / 67 |
| `webhook-control-plane` | 230 / 230 |
| `panel-ui`, `panel-ux`, `architecture` | 79 / 86 / 31 |
| SB Auto `payments-flow` | 70 / 70 |

**Contrôles mis à jour, avec justification en fichier** — chacun épinglait un état que L10.4
change légitimement :

- `stripe-control-plane` : 8 → 9 contrats, 7 → 8 servies, `billing.refund` **est** déclarée
  (l'assertion inverse était juste tant qu'aucun appelant n'existait), `PAYMENT_INTENT`
  ancrable, 3 → 4 écritures financières ;
- `stripe-resource-ownership` : 5 → 6 exigeantes, 4 → 5 servies ;
- `capability-gateway` : liste des servies, 7 → 8 Stripe ;
- `finance-stripe-revenue` § 18 : « préparation de L10.4 » devient « ce que L10.3 tend à
  L10.4 » — le comportement du remboursement est éprouvé dans sa propre suite ;
- `finance-ui` : « Revenus » retient `REVENUE,REFUND` ; le client d'API a le droit d'avoir un
  verbe `refund`, l'interdiction porte désormais sur ce qui compte — adresse Stripe, clé,
  identifiant fournisseur construit côté navigateur.

Un libellé a été **corrigé plutôt qu'exempté** : « Refusé par Stripe » est devenu « Refusé par
le fournisseur ». Le registre est fournisseur-agnostique ; le nom du fournisseur vit dans le
panneau du fait, à côté des identifiants qu'il produit.

---

## 6. Critères de recette

| Critère | Valeur |
|---|---|
| `REFUND_PROVIDER_CALLS_FROM_PROJECT` | **0** |
| `REFUND_ENVIRONMENT_DERIVED_FROM_ORIGINAL` | **YES** |
| `REFUND_OWNERSHIP_REQUIRED` | **YES** |
| `REFUND_IDEMPOTENT` | **YES** |
| `REFUND_EXTERNAL_IDENTITY` | **refund.id** (`re_…`) |
| `REFUND_LEDGER_FLOW` | **OUTFLOW** |
| `REFUND_LEDGER_CATEGORY` | **REFUND** |
| `ORIGINAL_REVENUE_PRESERVED` | **YES** |
| `PARTIAL_REFUNDS_SAFE` | **YES** |
| `RESPONSE_WEBHOOK_REPLAY_CONVERGE` | **YES** |
| `PRIVATE_DOCUMENT_PROTOCOL` | **YES** (L10.2, réutilisé — rien de nouveau) |
| `PUBLIC_REFUND_DOCUMENTS` | **0** |

---

## 7. Réserves assumées

- **Aucun document de remboursement n'est produit.** C'est la conclusion de l'audit § 1.4, pas
  une omission. Si un justificatif devient nécessaire, deux voies existent et aucune n'est
  ouverte par défaut : créer un avoir Stripe (second acte financier, à décider
  explicitement), ou générer un document interne L.Y Solution (qui devrait être nommé comme
  tel).
- **Les litiges ne sont pas projetés.** Un litige gèle l'argent, il ne le rend pas.
- **Un remboursement supprimé ne se restaure pas** — le geste n'existe nulle part dans le
  registre, depuis L10.1.
- **`convergePendingRefunds` ne tourne qu'à l'ordonnanceur.** C'est délibéré : elle appelle
  réellement Stripe, et la brancher sur la lecture d'un écran ferait exactement ce que L10.3
  a interdit. L'écran, lui, dit « vérification en cours » — c'est ce qui protège l'argent, pas
  la fraîcheur de la réponse.

---

**FINANCES STRIPE REFUNDS: PASS**
