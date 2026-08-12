# L6.3C — LE DERNIER APPEL, ET CE QU'IL A EMPORTÉ AVEC LUI

> **Le résultat en une ligne.** Il n'existe plus, dans tout le runtime SB Auto,
> un seul fichier qui importe le SDK Stripe. Le pilote et son double ont été
> supprimés avec le dernier appel qui les justifiait.

> **La décision qui compte.** Le read n'a **pas** été remplacé par une capacité.
> Ce n'était pas de la commodité : un `pi_…` seul ne prouve rien, le Panel ne
> possède une intention que par filiation depuis une session — et ce chemin-ci
> partait précisément d'un paiement **sans session**. Une capacité construite
> là-dessus aurait refusé exactement au moment où on l'appelle.

---

## 0. Baseline et travail parallèle

| Dépôt | HEAD au démarrage | Arbre |
|---|---|---|
| Panel | `db283f1` (descendant FF de `34c2537`, contient L10.5) | **propre** |
| SB Auto 06 | `7c394c5` | **propre** |

**L10.6 n'a pas encore commencé** : aucun fichier non committé dans l'un ou
l'autre dépôt au démarrage, et aucun n'est apparu pendant le lot. La
classification demandée est donc entièrement `STRIPE_L6_3C` — zéro
`FINANCES_L10_6`, zéro `SHARED`, zéro `UNKNOWN`.

C'est le premier lot depuis L6.2E sans collision, et cela se voit dans la
livraison : aucun staging par hunk n'a été nécessaire.

## 1. Quel était le dernier appel Stripe local ?

```
services/payment.service.js:512
  } else if (payment.stripe?.paymentIntentId) {
      const pi = await provider.retrievePaymentIntent(payment.stripe.paymentIntentId);
```

Une **branche `else`** dans `reconcileLaunchFeePayment`, atteinte quand un
paiement de frais n'est connu que par un `pi_…`, sans session exploitable.

## 2. Pourquoi existait-il ?

Le call graph complet :

```
POST /api/contracts/:id/sync-payment          (route DEV)
reconciliation.service.js:87 / :153           (filet périodique)
        └→ reconcileLaunchFeePayment(contract)
              ├─ payment.stripe.checkoutSessionId ?  → readCheckoutViaPanel   (L6.2C)
              └─ payment.stripe.paymentIntentId  ?  → provider.retrievePaymentIntent  ← ICI
                      └→ settleFromPaymentIntent(contract, payment, pi)
```

Un paiement sans session ne peut naître que d'un endroit : `backfillLaunchPayment`,
appelé par `contractWebhook.service.js` quand un événement `payment_intent.*`
arrive pour un contrat dont aucun paiement local ne correspond. Il crée alors un
`Payment` avec `checkoutSessionId: null` et `paymentIntentId: obj.id`.

`settleFromPaymentIntent` consomme exactement quatre champs : `pi.id`,
`pi.status`, `pi.customer`, `pi.last_payment_error.message`.

## 3. Était-il encore nécessaire ?

**Non, et l'audit le montre en deux temps.**

**Premièrement, l'information arrive déjà.** Un paiement sans session n'existe
que parce qu'un événement `payment_intent.*` l'a révélé — et cet événement
**porte l'objet complet**, que le contrôleur de webhook applique immédiatement :

```
case 'payment_intent.succeeded':
  await paymentSvc.settleFromPaymentIntent(contract, payment, obj);
```

Relire ensuite ne servait donc qu'au cas où ce **même** événement aurait été
perdu — sur un paiement qui n'existe que grâce à lui.

**Deuxièmement, et c'est décisif, il n'était plus autorisable.** Voir Q5/Q6.

## 4. Quelle solution a été retenue ?

**OPTION B — suppression, sans remplacement.**

L'option A (une capacité `billing.payment_intent.retrieve`) a été écartée sur
un argument de fond, pas de coût : elle aurait refusé précisément dans le cas
qu'elle prétendait servir. Créer une capacité pour préserver un ancien filet,
en sachant qu'elle refusera, aurait produit une centralisation d'apparence — la
capacité serait au catalogue, le compteur tomberait à zéro, et le parcours ne
fonctionnerait pas davantage.

**Et la suppression a emporté bien plus que la branche :**

```
services/stripe/stripe.provider.js   SUPPRIMÉ   (dernier import du SDK, dernier `new Stripe(`)
services/stripe/stripe.stub.js       SUPPRIMÉ   (son miroir de test)
stripe.service.js                    −getStripeProvider()
payment.service.js                   −la branche, −le paramètre `provider`
subscription.service.js              −4 paramètres `provider` vestigiaux
contract.service.js                  −import mort
contractTestTools.service.js         −import mort
```

Ces paramètres `provider = getStripeProvider()` étaient devenus **vestigiaux**
au fil des lots : plus aucune de ces fonctions n'appelait le pilote, mais toutes
continuaient de l'instancier par défaut. C'est ce qui maintenait l'import vivant.

## 5. Comment PAYMENT_INTENT ownership est-il prouvé ?

**Il ne l'est pas — pour ce chemin-là — et c'est la raison de la suppression.**

L'audit de l'état réel après L10.4/L10.5 : `PAYMENT_INTENT` est bien une famille
liable côté Panel, et L10.4 l'adopte — mais **par filiation, à la projection du
revenu**, depuis une session ou un abonnement déjà possédé.

Les quatre voies envisagées par la mission :

| Voie | Disponible ici ? |
|---|---|
| A — depuis une Checkout Session possédée | **non** : ce chemin part d'un paiement sans session |
| B — depuis une Invoice possédée | **non** : un frais de lancement n'a pas de facture d'abonnement |
| C — depuis un Refund relié à un revenu possédé | **non** : aucun remboursement en jeu |
| D — depuis un événement dont la filiation remonte à une ressource possédée | **non** : c'est justement un événement orphelin |

Le `pi_…` de ce chemin est, par construction, celui que le Panel **ne peut pas**
rattacher. Une capacité l'aurait refusé.

## 6. Un `pi_…` seul peut-il autoriser une lecture ?

**Non, et rien n'a été introduit qui le permettrait.**

La conception explicitement interdite par la mission —
`project → paymentIntentId → Stripe retrieve → metadata.projectId → autorisé` —
n'existe nulle part : aucune capacité `payment_intent` n'a été créée, et les
metadata restent corroboratives partout où elles apparaissent.

La garde statique interdit désormais `paymentIntents.retrieve` dans tout le
runtime, au même titre que les douze autres primitives déjà fermées.

## 7. Quels appels Stripe restent côté projet ?

**Un seul, et ce n'est pas du métier.**

```
services/providerConnectionTest.service.js   GET /v1/account   DIAGNOSTIC
```

`LOCAL_STRIPE_RUNTIME_BUSINESS_CALLS = 0.`

## 8. Quels lecteurs de secret restent ?

**Un.** `SECRET_READS : 2 → 1.`

```
services/providerConnectionTest.service.js:59   readStoredCredential(doc, mode, 'secretKey')
```

Classification demandée en phase 8 :

| Résidu | Classe |
|---|---|
| `providerConnectionTest.service.js` — `GET /v1/account` | **DIAGNOSTIC** |
| `stripe.service.js` — `tryGetCredential('STRIPE','webhookSecret')` | **WEBHOOK_VERIFICATION_ONLY** |
| `integratedApiCatalog.js` — `STRIPE_BASE_URL` | **DEAD** (déclarative ; plus aucun appelant) |
| `Contract.stripe.*`, `Payment.stripe.*`, `Invoice.*` | **HISTORICAL_DATA_ONLY** |
| — | **RUNTIME_REQUIRED : aucun** |

## 9. Quels writers de secret restent ?

La route `PUT /api/integrated-apis/STRIPE/modes/:mode` accepte toujours
`secretKey`, et le Manager affiche toujours le champ. **Rien n'a été fermé**,
conformément à la phase 11 : cette fermeture appartient à L6.3 FINAL.

## 10. Le projet fonctionne-t-il sans clé Stripe locale ?

**Oui pour tout le métier.** La matrice, mesurée plutôt qu'affirmée — chaque
ligne correspond à un chemin dont le code ne contient plus aucune lecture de
`secretKey` :

| Geste | Sans `sk_` local ? | Par où |
|---|---|---|
| payer des frais | **oui** | `billing.checkout.create` (L6.2B) |
| payer un abonnement | **oui** | `billing.checkout.create` + `customer.ensure` + `price.ensure` |
| ouvrir le portail | **oui** | `billing.portal.create` (L6.3B) |
| voir ses factures | **oui** | `billing.invoice.list` / `.retrieve` (L6.3B) |
| recevoir les webhooks | **oui** | endpoint provisionné par le Panel, vérifié par `whsec_` (L6.3A) |
| rembourser | **oui** | `billing.refund`, déclenché **depuis le Panel** (L10.4) |
| résilier | **oui** | `billing.subscription.cancel_*` (L6.2G) |
| réconcilier ses paiements | **oui, par la session** | `billing.checkout.retrieve` (L6.2C) |
| — réconcilier un paiement **sans session** | **non** | supprimé (Q3, réserve 1) |

Le démarrage n'exige plus la clé non plus : `ensureAllWebhooks` saute
proprement en `PANEL_NOT_PAIRED` depuis L6.3A, et plus rien d'autre ne la lit au
bootstrap.

## 11. Le `whsec_` est-il correctement distingué du `sk_` ?

**Oui, et à quatre niveaux :**

1. **Au registre du Panel** — le rôle `webhookSecret` porte `verificationOnly:
   true` depuis L6.3A ; `secretKey` ne le porte pas.
2. **Au transport** — `stripe.service.js` ne lit que `webhookSecret`, et la
   garde statique vérifie qu'aucun appel sortant ne le lit.
3. **Au pont** — `assertVerificationSecretOnly` n'accepte qu'un champ, dont le
   rôle est déclaré `verificationOnly` **au registre**, et dont la valeur a la
   forme d'un secret de signature. La garde générale, elle, n'a pas bougé.
4. **Dans les faits** — un `whsec_` ne permet aucun appel : il ne sait que
   constater qu'un message reçu vient de Stripe.

Le second reste donc légitimement local tant que Stripe écrit directement au
projet, **sans invalider** la centralisation des appels.

## 12. Quels fallbacks locaux restent ?

**`LOCAL_STRIPE_FALLBACKS = 0`**, inchangé et re-vérifié.

La garde cherche le motif `catch { provider.… }` dans le corps des `catch` des
services migrés. Il ne peut d'ailleurs plus exister : **il n'y a plus de
`provider` à appeler.**

## 13. Quels tests cross-tenant ont été faits ?

Les E2E des lots précédents sont rejoués intégralement et restent verts :

- `stripe-local-surface-e2e` (**45/0**) — B ouvrant le portail, listant ou
  lisant une facture du contrat de A : même code, même message, **zéro contact
  fournisseur** ;
- `stripe-webhook-provisioning-e2e` (**61/0**) — le secret de A inaccessible à B ;
- `stripe-subscription-cancellation-e2e`, `stripe-subscription-ownership-e2e`,
  `stripe-customer-ownership-e2e`, `stripe-checkout-read-webhook-e2e` — verts.

Ce lot **n'ajoute aucune surface** à éprouver en cross-tenant : il en retire.
C'est pourquoi il ne crée pas d'E2E supplémentaire — il renforce les gardes
statiques, qui sont la forme de preuve adaptée à une suppression.

## 14. Quels tests de non-régression ont été faits ?

| Suite | Résultat |
|---|---|
| **`stripe-local-surface`** (SB Auto, étendue) | **71 / 0** |
| `stripe-ownership-invariants` (Panel) | **106 / 0** |
| L6.2B/C/D/E/F/G — les six E2E Stripe du Panel | verts |
| L6.3A `stripe-webhook-provisioning-e2e` | **61 / 0** |
| L6.3B `stripe-local-surface-e2e` | **45 / 0** |
| L10.3 `finance-stripe-revenue` · L10.4 `finance-refunds` · L10.5 `finance-payment-requests` | verts |
| SB Auto — `payments-flow` · `subscription-flow` · `billing-flow` | 67/0 · 77/0 · 46/0 |
| SB Auto — `billing-portal` (**réactivée**, cf. ci-dessous) | **33 / 0** |
| SB Auto — `npm test` | **1 échec, préexistant** |
| Panel — `tests/run-all.js` | **107 / 109** — 2 rouges préexistants |
| Panel frontend · manager · vitrine — `tsc` + build | OK · OK · OK |

**Une suite dormante réactivée.** `billing-portal.test.js` existait mais n'était
**inscrite dans aucune chaîne** : livrée, jamais exécutée. C'est le même défaut
que le parc a connu aux lots L8 et L9. Elle testait encore le portail *local*
— donc un chemin supprimé en L6.3B, sans que rien ne rougisse. Elle a été
modernisée (le portail passe par le Panel, le projet ne désigne plus le client)
et **inscrite dans `npm test`**.

**Les rouges, prouvés préexistants et non réparés :**

- SB Auto, `contract-operations` — « aucun champ du document n'est lu sans être
  surveillé (**taxRate**) ». `git log -S taxRate` désigne `7c394c5`, le commit
  L10.5, sur `projectSync.service.js`. Ni ce fichier ni ce test ne figurent dans
  mon diff : le rouge existait **au commit de baseline**.
- Panel, `brevo-send-template-foundation` (×5) et `architecture` (×1) — les deux
  nomment `panelEmailTemplateRegistry.js`, modifié par L10.5 et absent de mon
  diff.

## 15. Quels fichiers L10.6 étaient parallèles ?

**Aucun.** L10.6 n'avait pas démarré au lancement du lot, et rien n'est apparu
pendant. Les rouges ci-dessus viennent de **L10.5, déjà committé**, pas de L10.6.

## 16. Une collision a-t-elle eu lieu ?

**Non.** Aucun fichier partagé, aucun staging par hunk nécessaire, aucun hunk
étranger dans les commits.

## 17–18. Fichiers et commits

Voir la livraison en fin de rapport.

## 19. Peut-on lancer L6.3 FINAL ?

**Oui.** La condition posée par la mission — « le runtime métier n'a plus besoin
d'un appel Stripe direct local » — est atteinte et prouvée statiquement.

### Plan L6.3 FINAL, dans cet ordre

L'ordre n'est pas cosmétique : chaque étape rend la suivante sûre.

1. **Faire pointer le test de connexion sur le Panel.** C'est le seul lecteur
   restant. Tant qu'il lit la clé locale, fermer l'écriture casserait le
   diagnostic — et le rendrait faux avant de le rendre absent.
2. **Fermer la route d'écriture** `PUT …/STRIPE/modes/:mode` pour `secretKey` :
   refus explicite côté API, pas seulement un champ masqué. **Tester la vraie
   route HTTP.**
3. **Retirer le champ du Manager** et du catalogue `integratedApiCatalog`.
4. **Retirer `STRIPE_BASE_URL`** (déclaratif, sans appelant).
5. **Retirer `stripe` du `package.json`** — impossible avant, possible désormais :
   plus aucun fichier ne l'importe.
6. **Déprécier puis purger les credentials chiffrés**, avec migration dédiée,
   comptage avant/après, et preuve que `READERS = 0`. Jamais dans le même lot
   que le reste.
7. **Garde statique** : `secretKey` n'apparaît plus dans le catalogue, la route
   refuse, aucun lecteur.
8. **E2E « projet neuf sans credential »** : appairage, frais, abonnement,
   portail, factures, webhook, résiliation — de bout en bout, sans qu'aucun
   `sk_` n'ait jamais été saisi.

Les données historiques (`Contract.stripe.*`, `Payment.stripe.*`, `Invoice.*`)
ne sont **pas** concernées : le projet peut cesser de posséder Stripe sans
perdre la mémoire des actes passés, et Finances s'en sert.

## Réserves

1. **Un scénario est perdu, et il faut le dire.** Un paiement de frais **sans
   session** dont l'événement Stripe se perdrait définitivement ne se réconcilie
   plus seul. Stripe rejoue ses webhooks pendant trois jours ; au-delà, il faut
   un arbitrage humain. J'ai préféré cette perte, nommée, à une clé d'API
   conservée pour un cas que plus rien ne peut autoriser proprement.

   Sa probabilité est faible : il faut qu'un `pi_…` existe pour un contrat sans
   qu'aucun `Payment` local ne le connaisse — donc un paiement né hors du
   parcours actuel — **et** que l'événement se perde.

2. **Le diagnostic de connexion reste trompeur.** Il éprouve la clé locale alors
   que plus rien d'autre ne s'en sert. Le Manager le dit depuis L6.3, mais un
   opérateur pressé lira « connexion Stripe réussie » et en conclura que les
   paiements fonctionnent. C'est l'étape 1 du plan ci-dessus, et elle devrait
   être la première précisément pour cette raison.

3. **`STRIPE_BASE_URL` survit sans appelant.** Purement déclaratif, mais c'est
   le genre de constante qu'un futur helper reprendrait « puisqu'elle est là ».

4. **La suite `billing-portal` a dormi deux lots.** Elle testait le portail local
   après sa migration, sans que rien ne le signale, parce qu'aucune chaîne ne
   l'exécutait. Elle est réactivée — mais rien ne garantit qu'elle soit la
   dernière dans ce cas. Un contrôle « tout fichier `*.test.js` est inscrit
   quelque part » serait un bon lot d'hygiène.

---

## Compteurs — L6.3B → L6.3C

```
LOCAL_STRIPE_RUNTIME_BUSINESS_CALLS   1  →  0      ✔ objectif du lot
LOCAL_STRIPE_PROVIDER_METHODS         1  →  0      ✔ le fichier a disparu
IMPORTS DU SDK STRIPE (runtime)       1  →  0      ✔
LOCAL_RUNTIME_STRIPE_API_CALLS        2  →  1      (le diagnostic)
LOCAL_RUNTIME_STRIPE_SECRET_READS     2  →  1      (le diagnostic)
LOCAL_STRIPE_FALLBACKS                0  →  0      ✔
PROJECT_STRIPE_SECRET_WRITES         ≠0  → ≠0      (phase 11 : rien de fermé)
```

Aucun compteur n'a augmenté. Les trois qui tombent à zéro sont prouvés par
recherche statique **et** par test d'architecture, pas annoncés.

---

STRIPE LAST LOCAL READ ELIMINATION: PASS

GO L6.3 FINAL: YES
