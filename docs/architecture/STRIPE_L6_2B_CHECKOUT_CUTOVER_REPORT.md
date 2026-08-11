# L6.2B — Stripe Checkout Control Plane Cutover

**Date** 2026-08-11 · **Panel** `9341177` → ce lot · **SB Auto 06** `1bfe4e8` → ce lot
**Périmètre** `billing.checkout.create`, frais de lancement. Une capacité, un chemin.

---

## A. Baseline

| | Panel | SB Auto 06 |
|---|---|---|
| Départ | `9341177` (L6.2A ownership, PASS) | `1bfe4e8` |
| Acquis | registre de liens, registre d'opérations, coffre, passerelle | pont, façade de capacités |

L6.2A avait rendu `GO L6.2B: YES` en recommandant l'ordre : *checkout.create, puis
convergence UNKNOWN, puis seulement les lectures*. C'est exactement l'ordre suivi.

## B. Travaux parallèles détectés, et isolation

Un chantier **Brevo L8.4C-BIS** était en vol dans les deux dépôts pendant tout le lot.
Fichiers relevés en fin de course, **aucun stagé, aucun restauré, aucun reformaté** :

*Panel* — `bridge/bridgeContract.js`, `services/webhooks/emailDeliveryDispatch.js`,
`docs/spec/PanelBridge.openapi.yaml`, `docs/spec/ProjectBridge.openapi.yaml`,
`tests/helpers/sbauto-instance.mjs`, `tests/helpers/sbauto-remote.js`,
`tests/brevo-send-delivery-convergence-e2e.test.js`.

*SB Auto* — `config/bootstrap.js`, `services/email/emailDelivery.service.js`,
`services/email/emailReadiness.service.js`, `services/email/emailDeliveryEvent.applier.js`,
`services/panelBridge/bridgeContract.js`, `docs/panelXvitrine/spec/*.yaml`,
`scripts/email-configuration.test.js`, `scripts/email-delivery.test.js`.

Aucun fichier partagé n'a été modifié par ce lot : les deux `bridgeContract.js` sont
restés intouchés, la capacité passant par la route générique `/bridge/v1/capabilities/…`
livrée en L3.

**Conséquence assumée** : `Panel/tests/bridge-conformity` échoue sur
« 14 entityTypes au miroir » — le lot Brevo a ajouté `EMAIL_DELIVERY_EVENT` au contrat
sans avoir encore mis à jour la spec miroir. Ce n'est pas notre échec et **il n'a pas
été réparé** : un chantier Stripe qui répare un test Brevo masque l'état réel de
l'autre chantier.

## C. Call graph `createCheckoutSession` — AVANT

Deux, et seulement deux, appels **runtime** :

```
POST /api/my-contract/create-launch-checkout
  → contract.admin.controller
    → payment.service.createOrReuseLaunchCheckout
      → stripe.service.createLaunchFeeCheckout            ← construit les params
        → stripe.provider.createCheckoutSession(clé PROJET)

POST /api/my-contract/create-subscription-checkout
  → contract.admin.controller.createSubscriptionCheckout
    → subscription.service.createOrReuseSubscriptionCheckout
      → ensureCustomer + ensureProductAndPrice             ← objets Stripe préalables
      → stripe.service.createSubscriptionCheckout
        → stripe.provider.createCheckoutSession(clé PROJET)
```

| | LAUNCH_FEE | SUBSCRIPTION |
|---|---|---|
| But métier | frais uniques, facture émise | abonnement récurrent |
| Idempotence | `launch-<id>-v<n>-a<k>-<mode>`, stable **par tentative**, persistée dans `Payment.idempotencyKey` | `checkout-sub-…-a<k>`, non persistée |
| Modèle local | `Payment` (source de vérité) + projection `contract.stripe.launchFee` | `contract.stripe.subscription` |
| Retry | double clic → relit la session, réutilise si ouverte | idem |
| Après timeout | **le `catch` ouvrait une NOUVELLE tentative** → seconde session | idem |
| Environnement | `resolveProviderEnvironment('STRIPE')`, côté projet | idem |
| Webhook | `checkout.session.*`, `payment_intent.*`, `invoice.*` sur l'endpoint du projet | idem |

**Point de coupure retenu** : `provider.createCheckoutSession`, remplacé par la capacité
au niveau du service métier. Le plus petit point qui migre l'acte entier sans dupliquer
la construction des paramètres — celle-ci passe intégralement côté Panel.

**Défaut trouvé au passage** (non théorique) : le `catch` du bloc de réutilisation
portait le commentaire *« on ne recrée pas à l'aveugle »* alors que le code retombait
sur la création d'une nouvelle tentative. Une API indisponible produisait donc **deux
sessions ouvertes** pour un même contrat. Corrigé au §D.

## D. Call graph — APRÈS

```
POST /api/my-contract/create-launch-checkout
  → payment.service.createOrReuseLaunchCheckout
    → stripe/checkoutCapability.createLaunchCheckoutViaPanel
      → panelBridge/capabilityClient.invokeCapability('billing.checkout.create')
        → HTTP  POST /bridge/v1/capabilities/billing.checkout.create/invoke
          ↓ PANEL
          capabilityGateway  (capacité → projet → monde → droit → politique
                              → servie → entrée → coffre → réservation)
          → stripeAdapters.checkoutCreate
             ├ stripeCheckoutAuthority   contrat + MONTANT, lus dans la projection
             ├ findBindingByOperation    barrière 1 — l'acte a-t-il déjà produit ?
             ├ stripeTransport.createCheckoutSession(clé PANEL, Idempotency-Key)
             └ bindResource              lien session → projet, immédiat
```

L'ouverture **et** la reprise sont le même appel : `operationId` identifie l'acte, et
le Panel décide s'il crée ou s'il retrouve. Le projet n'arbitre plus.

`createOrReuseSubscriptionCheckout` est **inchangé** : voir §U.

## E. Contrat `billing.checkout.create`

Le contrat de L6.1 a été **repris, pas remplacé** — aucune seconde capacité n'a été créée.
Trois amendements, chacun rendu nécessaire par le service réel :

| Champ | Sens |
|---|---|
| `contractRef` | référence du contrat, **confrontée** à la projection du Panel |
| `paymentType` | `LAUNCH_FEE` servi ; `SUBSCRIPTION` refusé explicitement |
| `successUrl` / `cancelUrl` | où revenir |
| `correlation.paymentRef` *(ajouté)* | recopié dans `metadata.paymentId` — **corroboratif** |
| `operationId` | identité de l'acte, ≥ 16 caractères |

Refusés par le schéma `strict()`, et vérifiés en E2E : `amount`, `unitAmount`, `price`,
`currency`, `mode`, `environment`, `livemode`, `secretKey`, `apiKey`, `account`, `baseUrl`.

Sortie : `url` devient **nullable** (Stripe n'en rend plus dès qu'une session est
complétée ou expirée : la promettre aurait obligé à en inventer une), et gagne `status`,
`paymentStatus`, `paymentIntentId`, `customerId` — les sous-produits de l'acte demandé,
sans lesquels la réparation d'un webhook perdu marquerait un paiement PAYÉ sans savoir
quelle transaction l'a payé.

**Metadata préservées à l'identique** : `contractId`, `paymentType`, `paymentId`,
`providerMode`, `applicationEnvironment`. `contractId` est écrit depuis la **projection
vérifiée**, jamais depuis la charge utile — c'est ce qui empêche d'étiqueter une session
au contrat d'un autre. Elles restent corroboratives : les metadata Stripe s'éditent
depuis le tableau de bord, et l'autorité d'appartenance demeure le registre de liens.

## F. `operationId`

C'est **`Payment.idempotencyKey`**, tel quel — la valeur que le projet utilisait déjà
comme clé Stripe : `launch-<contractId>-v<version>-a<attempt>-<mode>`.

Aucun concept nouveau, et deux conséquences qui comptent : elle est **persistée** (donc
disponible après un redémarrage, au moment précis où une reprise en a besoin), et elle
est **stable par tentative** (donc un double clic est le même acte, tandis qu'une
tentative neuve — décidée sur un fait constaté — en est un autre).

## G. Clé d'idempotence Stripe

**Dérivée**, jamais stockée ni tirée au sort :

```
pcp_ + sha256(environment | projectId | capability | operationId)[0..48]
```

Reproductible sans lecture de base — indispensable : une clé qu'il faudrait relire
serait indisponible exactement quand on en a besoin. Elle porte le **monde** (TEST et
PROD sont deux comptes ; une clé qui les traverserait ferait converger un acte de
recette vers un acte de production), la **capacité**, et le **projet** (deux projets
peuvent légitimement choisir le même `operationId` — prouvé en E2E §10).

Le transport **refuse localement** toute écriture sans clé (`stripeTransport`), avant
Stripe : oublier l'en-tête est un comportement qu'on ne veut pas pouvoir obtenir.

## H. Resource binding

À la création, immédiatement :

```
{ environment, resourceType: CHECKOUT_SESSION, resourceId: cs_…,
  projectId, source: PANEL_CREATED, createdByOperationId }
```

L'unicité `(environment, resourceType, resourceId)` de L6.2A — **sans `projectId`** —
garantit qu'une session n'a qu'un propriétaire. `findBindingByOperation` (ajouté ici)
répond à « cet acte a-t-il déjà produit une ressource ? » : le filtre porte le projet,
sans quoi la reprise de l'un convergerait vers la session de l'autre.

## I. Fenêtre Stripe → binding

Elle est **irréductible** — Stripe et Mongo n'ont pas de transaction commune — et ce
lot ne prétend pas la fermer. Il la rend **reprenable**, par trois barrières ordonnées :

1. **le lien** — définitif, vaut un an après ;
2. **la clé d'idempotence** — Stripe rend sa réponse d'origine, dans sa fenêtre ;
3. **le registre d'opérations** — décide qui a le droit de tenter, et jusqu'à quand.

Inverser 1 et 2 reviendrait à interroger le fournisseur pour découvrir ce qu'on savait
déjà, et à dépendre de 24 heures là où une lecture locale répond toujours.

## J. Reprise après crash — le scénario T0→T9

Reproduit **exactement** en E2E §6 : lien supprimé, opération remise en `PENDING`,
`startedAt` vieilli de dix minutes.

| | |
|---|---|
| T0 | `OP_A2` réservée |
| T1–T2 | Stripe crée `cs_test_2` |
| T3 | crash : **aucun lien**, opération non conclue |
| T4 | rejeu du **même** `operationId` |
| T5 | le Panel rejoue **la même clé** — vérifié octet pour octet |
| T6–T7 | Stripe rend `cs_test_2`, **sans créer de session** (`parId.size` inchangé) |
| T8 | lien réparé, `createdByOperationId` intact |
| T9 | résultat rendu au projet |

**Une seule Checkout Session.** Critère de PASS rempli.

## K. UNKNOWN

`FAILED` et `UNKNOWN` restent distincts jusqu'au bout de la chaîne :

- transport : `outcome: UNKNOWN` sur toute écriture interrompue ;
- adaptateur : `CAPABILITY_TIMEOUT` (504), jamais `PROVIDER_UNAVAILABLE` — c'est la
  leçon de L9, et elle coûte plus cher encore chez un fournisseur financier ;
- registre : `OPERATION_STATUS.UNKNOWN`, jamais `FAILED` ;
- passerelle : `CAPABILITY_OUTCOMES.UNKNOWN`, journalisé en `ERROR`.

**La convergence n'est pas un retry aveugle.** Elle est bornée deux fois :

| Borne | Valeur | Ce qu'elle empêche |
|---|---|---|
| `staleAfterMs` | 90 s | qu'un concurrent légitime soit pris pour un survivant de crash |
| `replayWindowMs` | 23 h | qu'un rejeu passé la fenêtre Stripe devienne une **seconde création** |

Au-delà, le Panel refuse (`CAPABILITY_OPERATION_UNRESOLVED`) et l'arbitrage redevient
humain — prouvé en E2E §8 : **rien** ne repart chez Stripe.

La doctrine générale de L8.3 est **inchangée** pour Brevo : sans option de convergence,
`claimOperation` se comporte mot pour mot comme avant.

## L. Concurrence

| Cas | Résultat prouvé |
|---|---|
| 8 appels simultanés, même `operationId` | 1 succès, 7 `OPERATION_IN_FLIGHT`, **1 session**, 1 lien |
| 2 `operationId` différents, même contrat | **2 actes distincts**, assumés — un contrat peut légitimement connaître plusieurs tentatives, et les confondre priverait un client de repayer après expiration |
| même session, 2 projets | un gagnant, `STRIPE_RESOURCE_ALREADY_BOUND`, propriétaire inchangé |

L'arbitrage vient de l'**index unique**, jamais d'une lecture préalable — et le registre
d'opérations attend désormais `Model.init()` avant sa première écriture (troisième
occurrence de ce piège Mongoose dans le parc).

## M. Sécurité cross-project

Projet B, **réel**, appairé, avec la capacité accordée :

- facturer le contrat de A → `CAPABILITY_NOT_AVAILABLE / CONTRACT_NOT_OWNED` ;
- une référence **inventée** → **exactement le même code, le même motif, le même
  message** : le refus n'est pas un oracle d'existence ;
- adopter la session de A → conflit, propriétaire inchangé ;
- interroger l'appartenance → refus **indistinguable** de « ressource inconnue », et
  qui ne nomme jamais A ;
- facturer SON contrat → succès, à SON montant, lié à LUI.

Aucune metadata Stripe ne participe à ces décisions.

## N. Credentials

Trois sentinelles, et un faux Stripe qui note chaque en-tête `Authorization` :

- `sk_test_…PANELTEST…` — la seule vue par le fournisseur, sur **tous** les appels ;
- `sk_live_…PANELPROD…` — jamais ;
- `sk_test_…PROJETJAMAISUTILISEE…` — jamais, nulle part, y compris dans le dump
  complet des bases des deux instances.

Aucune clé projet n'a été **retirée** : `createSubscriptionCheckout`, `createCustomer`,
`createProduct`, `createPrice`, `createBillingPortalSession` et les résiliations les
utilisent encore. Le lot ne casse pas ce qu'il ne migre pas.

## O. Appels locaux résiduels

```
LOCAL_RUNTIME_CREATE_CHECKOUT_CALLS (frais de lancement) = 0
```

Classification exhaustive des occurrences restantes :

| Occurrence | Classe |
|---|---|
| `stripe.provider.js:99` | **définition** du provider — conservée, l'abonnement s'en sert |
| `stripe.service.js:108` | **appel runtime — ABONNEMENT**, hors périmètre §17 |
| `stripe.service.js:50` | commentaire de la fonction supprimée |
| `stripe.stub.js:60-61` | stub de test |
| `scripts/*.test.js` | tests |

`createLaunchFeeCheckout` est **supprimée**, pas désactivée : un constructeur laissé en
place est le repli du prochain incident. Deux assertions gardent la porte fermée
(`stripe.test.js`).

## P. Webhooks

**Rien n'a été touché.** Aucun endpoint créé, supprimé ou reconfiguré ; aucun secret de
signature lu, écrit ou tourné ; aucun routage modifié ; le tableau de bord Stripe n'a
pas été approché. Le lien reste simplement compatible avec le routage futur
`resourceId → projectId`, et `PanelCapabilityOperation.providerMessageId` porte
désormais l'identifiant de session — la poignée dont ce routage aura besoin.

## Q. Vérification de paiement

Le verdict métier est **inchangé** : `markPaid`, `markProcessing`, `markExpired`,
`settleFromSession`, la projection `contract.stripe.launchFee` et `setupFeePaid`
convergent comme avant, par le webhook signé et la réconciliation.

Une seule chose a changé, et elle **réduit** le risque : la relecture de la tentative
ouverte ne passe plus par la clé locale. Elle interrogeait potentiellement un autre
compte, et son échec ouvrait une nouvelle tentative (§C). Elle passe désormais par le
même verbe, avec le même `operationId` — le Panel relit ce qui lui appartient et rend
`status` / `paymentStatus` / `paymentIntentId`, que le service traduit vers exactement
les mêmes états qu'avant.

Une réserve nommée : le Panel n'attache plus `customer` à la session des frais. Un
`cus_` créé avec la clé du projet n'existe pas nécessairement sur le compte du Panel, et
l'y référencer ferait échouer la session devant un client qui paie. Checkout collecte
l'adresse, et `invoice_creation` émet toujours la facture.

## R. Tests exacts

**Panel**

| Suite | Résultat |
|---|---|
| `stripe-checkout-cutover-e2e` *(nouveau, 12 sections)* | **106 / 0** |
| `stripe-control-plane` | 98 / 0 |
| `stripe-resource-ownership` | 86 / 0 |
| `capability-gateway` | 110 / 0 |
| `capability-preopening` | 27 / 0 |
| `capability-gateway-e2e` | 66 / 0 |
| `commercial-readiness` · `commercial-readiness-runtime` | 73 / 0 · 75 / 0 |
| `webhook-control-plane` | 230 / 0 |
| `integrated-api-provider-registry` · `-control-plane` · `-http-security` | 67 / 0 · 65 / 0 · 39 / 0 |
| `bridge-provider-secret-boundary` · `provider-secret-sentinel-e2e` | 54 / 0 · 25 / 0 |
| `brevo-send-template-foundation` · `brevo-verify-migration-e2e` | 70 / 0 · 41 / 0 |
| `hostinger-control-plane` · `hostinger-dns-cutover-e2e` | 118 / 0 · 63 / 0 |
| `architecture` · `spec-drift` | 31 / 0 · OK |
| `bridge-conformity` | 58 / 1 — **dérive du lot Brevo**, cf. §B |

**SB Auto 06** — `payments-flow` 70/0 · `billing-flow` 46/0 · `stripe` 29/0 ·
`subscription-flow` 73/0 · `subscription-reconcile` 48/0 · `billing-portal` 31/0 ·
`contract-billing-signature` 31/0 · `contract-lifecycle` 46/0 · `control-plane` 29/0 ·
`bridge-conformity` 97/0 · `panel-bridge` 60/0.

**Builds** — Panel frontend : typecheck, lint, build OK. SB Auto `manager` et `vitrine` : build OK.

Les vingt preuves exigées sont couvertes : 1 par `payments-flow` (appel métier réel,
`operationId` relevé au passage du pont) et 20 par les suites de facturation ; 2 à 19
par l'E2E vertical.

## S. Fichiers

**Panel** — nouveaux : `stripeCheckoutAuthority.js`, `stripeAdapters.js`,
`tests/stripe-checkout-cutover-e2e.test.js`, ce rapport. Modifiés :
`capabilityGateway.service.js`, `capabilityRegistry.js`, `operationRegistry.js`,
`providerAdapters.js`, `stripeCapabilities.js`, `stripeResourceBinding.js`,
`tests/{capability-gateway,capability-preopening,commercial-readiness-runtime,stripe-control-plane,stripe-resource-ownership}.test.js`,
`tests/run-all.js`.

**SB Auto** — nouveaux : `services/stripe/checkoutCapability.js`,
`scripts/helpers/panelCheckoutDouble.helper.js`. Modifiés : `services/payment.service.js`,
`services/stripe/stripe.service.js`,
`scripts/{payments-flow,billing-flow,stripe,contract-billing-signature,contract-lifecycle}.test.js`.

## T. Commit / push

Deux commits dédiés, stagés **fichier par fichier**. Aucun `add .`, aucun `add -A`,
aucun `reset`, aucun `checkout`, aucun `restore`, aucun `stash`. Aucun fichier Brevo
dans l'index. Push fast-forward.

## U. Réserves

1. **L'abonnement n'est pas migré, et le refus est structurel.** Une session
   `mode: subscription` référence un Customer et un Price créés avant elle ; ces trois
   créations sont hors périmètre (§17). Migrer la session seule produirait une session
   référençant les objets d'un **autre compte**, et l'échec surviendrait devant un
   client qui paie. Le refus tombe donc côté Panel, nommé
   (`SUBSCRIPTION_PREREQUISITES_NOT_MIGRATED`), et `createOrReuseSubscriptionCheckout`
   reste intégralement sur le chemin local. C'est la seule migration partielle du lot,
   elle est **explicite, testée et gardée** — jamais silencieuse.
2. **`cancelSubscriptionNow` sans clé d'idempotence** reste un risque connu de L6.1.
   Documenté, non corrigé ici (§17).
3. **Le client n'est plus attaché** à la session des frais (§Q).
4. **Aucune reprise au-delà de 23 h** : c'est un refus, pas une panne, et il exige un
   geste humain. Aucun écran ne le présente encore.
5. **`bridge-conformity` (Panel) est rouge** du fait du chantier Brevo (§B).
6. Le lien n'est écrit que pour les sessions **créées par le Panel** : les sessions
   antérieures au lot n'en ont pas, et une tentative ouverte sans `idempotencyKey`
   n'est pas reprenable — elle est refusée plutôt que dupliquée.

## V. Prochain lot recommandé — *non implémenté*

**L6.2C — la convergence des lectures de paiement.** Dans cet ordre :

1. `billing.checkout.retrieve`, servie **uniquement** sur une session liée — le premier
   verbe de lecture qui a un propriétaire prouvé, puisque L6.2B en crée désormais ;
2. le routage webhook `resourceId → binding → projectId`, à endpoint **inchangé**, pour
   éprouver le chemin avant de déplacer quoi que ce soit ;
3. `billing.customer.ensure`, qui débloquera ensuite l'abonnement (§U.1) — et lui seul
   ouvre `billing.invoice.list` et `billing.subscription.retrieve`.

Ne pas commencer par les listes : elles exigent un lien vers un client, et ce lien
n'existera qu'après (3).

---

**STRIPE CHECKOUT CONTROL PLANE CUTOVER: PASS**
