# L6.2G — RÉSILIATION D'ABONNEMENT : CUTOVER VERS LE PLAN DE CONTRÔLE

> **Ce que ce lot ferme.** `cancelSubscriptionNow` partait chez Stripe **sans
> aucune clé d'idempotence**, et possédait quatre appelants. Le défaut était
> relevé depuis L6.1 et re-confirmé à chaque lot depuis. Un double clic produisait
> deux `DELETE` réels — dont le second échouait, puisque Stripe refuse de résilier
> deux fois. Il est fermé.

> **Ce que ce lot découvre.** Une résiliation n'est pas un paiement. Elle laisse
> une **trace d'état non ambiguë**, donc relire l'abonnement répond exactement à
> « l'acte a-t-il eu lieu ? ». C'est la première fois que la convergence se fait
> par l'ÉTAT plutôt que par la seule fenêtre d'idempotence du fournisseur.

---

## 1. HEAD de départ Panel / SB Auto ?

| Dépôt | HEAD au démarrage du lot | HEAD au moment de la livraison |
|---|---|---|
| Panel | `a90592a` | `70e069c` (deux commits **étrangers**, cf. Q2) |
| SB Auto 06 | `dc9e25f` (mon commit L6.2F) | `dc9e25f` — inchangé |

Le HEAD du Panel a **bougé sous mes pieds** pendant le lot : le chantier Finances
a livré L10.3 (`141bfde`, puis `70e069c`). Mon travail a donc été construit,
testé et livré **par-dessus** ces commits, jamais à côté.

## 2. Travaux parallèles présents ?

Oui — le chantier **FINANCES L10.3** (« les revenus Stripe entrent dans le ledger
générique »), livré en cours de lot. Ses 22 fichiers :

```
backend/package.json
backend/src/controllers/finances.controller.js
backend/src/models/PanelFinancialTransaction.model.js
backend/src/models/PanelProviderRevenueFact.model.js
backend/src/routes/finances.routes.js
backend/src/services/finance/providerRevenue/revenueProjection.service.js
backend/src/services/finance/providerRevenue/stripeRevenueNormalizer.js
backend/src/services/finance/recurringCostScheduler.js
backend/src/services/webhooks/webhookIngest.js          ← contact
docs/architecture/62_FINANCIAL_LEDGER.md
docs/architecture/FINANCES_L10_3_STRIPE_REVENUE_PROJECTION_REPORT.md
frontend/…  (5 fichiers)
tests/finance-core.test.js
tests/finance-stripe-revenue.test.js
tests/finance-ui.test.js
tests/run-all.js                                        ← contact
```

**Deux points de contact réels**, tous deux traités sans toucher au travail
d'autrui :

- `webhookIngest.js` — L10.3 le modifie, moi **pas du tout**. Ma section E2E de
  routage webhook s'exécute donc sur LEUR version, et passe. C'est la meilleure
  preuve de non-collision que je puisse produire : je n'ai pas contourné le
  fichier, je l'ai éprouvé tel qu'ils l'ont laissé.
- `tests/run-all.js` — édité par les deux chantiers. Le leur est **committé** ;
  mon diff ne fait qu'**ajouter une ligne** (plus son commentaire) au-dessus de
  leur version. Aucun conflit, aucune ligne d'autrui déplacée ou reformatée.

Aucun fichier Finances n'a été restauré, stagé, reformaté, ni « réparé ».
`git add -A`, `git add .`, stash, reset et checkout globaux n'ont jamais été
employés : chaque fichier stagé est nommé un par un.

## 3. Combien de chemins de résiliation existaient ?

**Quatre appelants**, répartis sur deux verbes et deux fichiers :

| # | Site | Verbe | Contexte |
|---|---|---|---|
| 1 | `contract.service.js:651` | à échéance | résiliation client en PROD |
| 2 | `contract.service.js:774` | immédiate | résiliation client en TEST |
| 3 | `contractTestTools.service.js:66` | immédiate | outil « couper maintenant » |
| 4 | `contractTestTools.service.js:117` | immédiate | outil de remise à zéro |

Plus **un wrapper mort** : `stripe.service.js#cancelSubscriptionAtPeriodEnd`,
sans aucun appelant.

Trois des quatre visaient la coupure immédiate — c'est exactement ce qui rendait
le défaut d'idempotence coûteux : le chemin le plus emprunté était le seul
totalement non protégé.

## 4. Quels appels ont été migrés ?

**Les quatre**, sans exception et sans repli :

```
contract.service.js:651          → cancelSubscriptionViaPanel({ …, mode: 'AT_PERIOD_END' })
contract.service.js:774          → cancelSubscriptionViaPanel({ …, mode: 'NOW' })
contractTestTools.service.js:66  → cancelSubscriptionViaPanel({ …, mode: 'NOW' })
contractTestTools.service.js:117 → cancelSubscriptionViaPanel({ …, mode: 'NOW' })
```

Le wrapper mort a été **supprimé**, pas contourné : le laisser en place aurait
été une invitation à rouvrir le chemin local sans que rien n'avertisse. Un
commentaire explicatif occupe sa place.

Il n'existe **aucun `try capability catch local`**. Si le Panel refuse ou est
injoignable, la résiliation ne se fait pas — et c'est le comportement voulu :
un repli local rouvrirait précisément le trou que ce lot referme.

## 5. Que signifie exactement « cancel at period end » ?

`POST /v1/subscriptions/{id}` avec `cancel_at_period_end=true`.

C'est un **drapeau**, pas une fin. L'abonnement reste `active`, l'accès reste
ouvert, la période en cours reste due, et Stripe cessera de renouveler à
l'échéance. Il est **réversible** jusque-là.

Propriété qui compte pour ce lot : le poser deux fois donne le même état. Il est
donc **convergent par nature**.

## 6. Que signifie exactement « cancel now » ?

`DELETE /v1/subscriptions/{id}`.

C'est un acte **terminal** : `status` passe à `canceled`, l'accès cesse, il n'y
a pas de retour en arrière. Et surtout — **Stripe refuse de le rejouer** :
résilier un abonnement déjà `canceled` rend une erreur
`subscription_already_canceled`.

C'est cette asymétrie qui rend la relecture d'état indispensable. Sans elle, un
rejeu parfaitement légitime — un second clic, une reprise après timeout —
ressemblerait à un échec fournisseur. C'est ce que produisait le chemin local.

**La politique commerciale n'a pas été touchée.** SB Auto coupe immédiatement en
TEST et à échéance en PROD ; le `catch` qui entoure la coupure immédiate dans
`contract.service.js` a été **délibérément conservé**. Ce lot déplace la porte,
il n'invente pas un comportement métier.

## 7. Quelle ressource prouve l'ownership ?

La **Subscription elle-même**, dans le registre de liens de L6.2A :

```
unique(environment, resourceType='SUBSCRIPTION', resourceId)
```

Et ce lien n'a pu naître que d'une seule façon — l'**adoption par filiation** de
L6.2F : une session de paiement dont l'appartenance était déjà prouvée désigne
l'abonnement, et c'est Stripe qui désigne cette filiation.

**Rien n'a été assoupli pour ce lot.** Les résiliations n'ouvrent aucune voie
d'ancrage nouvelle : elles mutent un abonnement déjà adopté. L'identifiant que le
projet présente ne vaut toujours rien par lui-même.

## 8. Où naît `operationId` ?

**Dans le Panel**, par dérivation pure — le projet ne le fournit pas et ne peut
pas le fournir :

```js
cancellationOperationId({ environment, subscriptionId })
  → `stripe-subscription-cancel:${environment}:${subscriptionId}`
```

Le contrat d'entrée est `z.object({ subscriptionId }).strict()` : y glisser
`operationId`, `environment`, `mode`, `apiKey` ou `idempotencyKey` est refusé en
`CAPABILITY_INPUT_INVALID` — les cinq cas sont éprouvés.

**Pourquoi déroger à la règle habituelle.** Partout ailleurs le projet nomme son
acte, parce que lui seul sait que deux clics sont la même intention. Un paiement
peut légitimement être retenté : une session expire, une carte est refusée, et la
tentative suivante est un acte NOUVEAU. Une résiliation n'a pas cette propriété.
« Résilier cet abonnement de cette façon » est terminal et unique : il n'existe
pas de seconde tentative légitime, seulement des rejeux de la même intention.
Laisser le projet nommer l'acte lui permettrait d'en fabriquer deux — c'est-à-dire
de couper deux fois ce qui ne se coupe qu'une.

L6.2G étend donc aux actes TERMINAUX la règle que L6.2D/E avaient posée pour les
verbes `ensure`. **Quatre** capacités dérivent désormais leur identité d'acte.

La capacité ne figure pas dans l'`operationId` : elle est déjà dans la clé du
registre `(projectId, capability, operationId)` et dans la dérivation de la clé
Stripe. Les deux verbes restent donc des actes distincts sans que la chaîne le
répète.

## 9. Comment l'idempotency Stripe est-elle dérivée ?

Inchangée depuis L6.2B, et c'est voulu — une seule chaîne pour tout le plan de
contrôle :

```
pcp_ + sha256(environment | projectId | capability | operationId)[0..48]
```

Le matériel incomplet lève `IDEMPOTENCY_MATERIAL_INCOMPLETE` **avant** tout
appel. Les deux verbes portant une `capability` différente, ils ne peuvent pas
partager une clé même sur le même abonnement.

`cancelSubscriptionNow` transmet désormais cette clé au transport, qui en fait
l'en-tête `Idempotency-Key`. C'est le maillon qui manquait depuis l'origine, et
une garde structurelle vérifie les trois étages de la chaîne.

## 10. Que se passe-t-il après une réponse perdue ?

L'opération est enregistrée **`UNKNOWN`**, jamais `FAILED`, et **rien n'est
rejoué automatiquement**.

Éprouvé en conditions réelles (section 5 de l'E2E) : le faux Stripe exécute la
mutation puis **détruit la socket**. L'appel remonte `CAPABILITY_TIMEOUT`, la
mutation a bel et bien eu lieu, l'état de l'abonnement la porte, et
`PanelCapabilityOperation` est en `UNKNOWN`.

## 11. Peut-on rejouer aveuglément ? Pourquoi ?

**Non** — et c'est précisément ce que faisait le chemin local.

Rejouer un `DELETE` sur un abonnement déjà `canceled` rend une **erreur** Stripe.
Un rejeu aveugle transforme donc un succès en échec apparent, et pousse
l'appelant à recommencer.

L'ordre est donc, et une garde structurelle vérifie les **positions** et pas
seulement les présences :

```
1. appartenance prouvée   ← sinon la durée de réponse trahit l'existence
2. relecture de l'état    ← sinon on rejoue ce que Stripe refusera
3. mutation SI ET SEULEMENT SI l'état prouve qu'elle manque
```

Et si l'état est **illisible**, on ne mute pas : la capacité refuse en
`PROVIDER_UNAVAILABLE` / `SUBSCRIPTION_STATE_UNREADABLE`, zéro mutation émise,
l'abonnement intact. **On ne transforme jamais l'incertitude en nouvelle
mutation.**

## 12. Comment une opération UNKNOWN converge-t-elle ?

**Par l'état**, et c'est la nouveauté doctrinale du lot.

Pour un paiement (L6.2B), l'état ne tranche pas : une session absente peut
signifier « jamais créée » comme « créée puis perdue ». La convergence passait
donc par la clé, bornée par la fenêtre d'idempotence de Stripe.

Une résiliation laisse une trace **non ambiguë** :

```
cancel_at_period_end  vaut true, ou il ne le vaut pas
status                vaut 'canceled', ou il ne le vaut pas
```

Aucun état intermédiaire, aucune course, aucun délai de propagation. La reprise
relit, constate, et rend `outcome: 'ALREADY_CANCELLED'` — **un succès**, pas une
erreur. L'opération passe `UNKNOWN → SUCCEEDED` **sans seconde mutation**.

Ce fait est vérifié avant d'agir, jamais supposé : c'est la lecture qui décide,
pas le calendrier.

## 13. Résultat de 8 appels concurrents ?

**Une seule coupure émise chez Stripe.** Au moins un appel aboutit ; les autres
sont refusés en `CAPABILITY_OPERATION_IN_FLIGHT` — jamais servis en double, jamais
mis en file pour muter plus tard. L'abonnement est clos exactement une fois.

La protection tient à l'index unique `(projectId, capability, operationId)` du
registre d'opérations, et l'`operationId` étant dérivé, huit clics produisent
mécaniquement le même.

## 14. Que se passe-t-il si `cancel_now` et `cancel_at_period_end` courent ensemble ?

Trois situations, toutes éprouvées :

- **drapeau puis coupure** — la coupure **passe** et mute. C'est correct : passer
  d'une fin différée à une fin immédiate est un acte réel et légitime.
- **coupure puis drapeau** — l'abonnement est déjà clos, donc ce que la demande
  visait est **acquis**. On le CONSTATE (`ALREADY_CANCELLED`), zéro mutation.
  Muter aurait produit une erreur Stripe et un état incohérent.
- **les deux en course** — chacun aboutit ou se refuse proprement en
  `CAPABILITY_OPERATION_IN_FLIGHT`. Au plus une coupure, au plus un drapeau, et
  l'état final est **toujours cohérent** quel que soit l'ordre : soit `canceled`,
  soit marqué pour l'échéance — jamais un état que Stripe aurait refusé de
  produire.

Le choix « un abonnement déjà clos satisfait les deux verbes » est délibéré :
refuser obligerait l'appelant à distinguer deux formes de « c'est déjà fait »,
pour aucun gain.

## 15. Un projet B peut-il muter l'abonnement de A ?

**Non**, et le refus est **indistinguable** des deux autres :

| Cas | Code | Message | Statut |
|---|---|---|---|
| abonnement d'un autre projet | `CAPABILITY_RESOURCE_NOT_OWNED` | identique | identique |
| abonnement inexistant | `CAPABILITY_RESOURCE_NOT_OWNED` | identique | identique |
| lien révoqué | `CAPABILITY_RESOURCE_NOT_OWNED` | identique | identique |

Sur les trois refus : **zéro mutation, et zéro lecture**. C'est le point qui
compte — l'appartenance est vérifiée **avant** tout contact fournisseur. Sans
cela, le temps de réponse trahirait l'existence de l'abonnement, et le refus
cesserait d'être indistinguable.

## 16. Une metadata mensongère peut-elle influencer l'autorité ?

**Non.** Éprouvé sur le chemin le plus tentant qui soit : un événement
`customer.subscription.deleted` **correctement signé**, dont les metadata
réclament le projet B alors que le lien désigne A.

L'événement est accepté (la signature est vraie), et **routé vers A**. Une trace
`REVENDICATION DIVERGENTE` est journalisée — la contradiction est un signal, pas
un silence.

Stripe prouve l'**événement** par sa signature ; notre registre prouve
l'**appartenance**. Les metadata corroborent, et perdent quand elles contredisent.

## 17. Quelle clé Stripe atteint le fournisseur ?

**Exactement une : celle du coffre du Panel, en TEST.** Le bilan de l'E2E
l'affirme sur la totalité des appels HTTP capturés, tous verbes confondus.

La sentinelle de clé « projet » n'apparaît **nulle part** dans le trafic, et les
bases des deux projets voisins n'en contiennent aucune trace. La clé PROD du
coffre n'a jamais parlé — les mondes ne se croisent pas.

Aucune valeur de clé ne figure dans ce rapport : seulement `présent`/`absent` et
des sentinelles composées à l'exécution.

## 18. Existe-t-il encore un runtime local de résiliation ?

**Non. `LOCAL_RUNTIME_SUBSCRIPTION_CANCELLATION_WRITES = 0`.**

Vérifié sur les deux faces par une garde structurelle : aucune expression
`(provider|stripeSvc|stripe).cancelSubscription(Now|AtPeriodEnd)` dans
`contract.service.js` ni `contractTestTools.service.js`, et `cancelSubscriptionViaPanel`
effectivement présent dans les deux. Le wrapper mort est **supprimé**.

Côté Panel, le transport ne connaît que **deux** écritures visant un abonnement —
les deux résiliations — et le compte exact est lui-même un invariant : toute
écriture ajoutée sans stratégie de convergence ferait rougir la garde.

## 19. Quels appels Stripe locaux subsistent ?

Je ne prétends **pas** à un zéro global — d'autres appels Stripe légitimes
subsistent, hors du périmètre de ce lot :

| Fichier | Appel | Statut |
|---|---|---|
| `billing.service.js` | `listInvoices`, `retrieveInvoice` | non migré — `billing.invoice.list` reste fermée |
| `subscription.service.js` | `createBillingPortalSession` | non migré — portail client, hors lot |
| `subscription.service.js` | `retrieveInvoice` | non migré |
| `payment.service.js` | `retrievePaymentIntent` | non migré |
| `webhookRunReport.service.js` | `listManagedWebhooks` | administration webhook, L6.3 |

Le zéro que j'affirme est **précis et borné** : zéro écriture locale de
**résiliation d'abonnement**.

## 20. TEST / PROD sont-ils hermétiques ?

**Oui.**

- l'identité de l'acte **porte le monde** : `stripe-subscription-cancel:TEST:sub_x`
  ≠ `…:PROD:sub_x`, donc la clé Stripe dérivée diffère ;
- l'appartenance est enregistrée **par monde** : un abonnement TEST interrogé en
  PROD rend `NO_BINDING` ;
- la clé PROD du coffre n'a émis **aucun appel** sur l'ensemble du scénario.

## 21. Webhooks inchangés ?

**Oui — aucun endpoint créé, aucune route ajoutée, `webhookIngest.js` non
modifié.** Le routage par appartenance de L6.2C est réutilisé tel quel, y compris
sur la version que le chantier Finances vient de livrer.

L'événement de fin d'abonnement trouve son destinataire dans le registre de
liens ; les metadata ne décident de rien.

## 22. Tests dédiés ?

`Panel/tests/stripe-subscription-cancellation-e2e.test.js` — **79 assertions,
0 échec**, sur **deux instances SB Auto réelles** dans des processus voisins,
face à un faux Stripe qui reproduit le comportement qui compte : `DELETE` sur un
abonnement déjà `canceled` **rend une erreur**, comme le vrai.

Les 18 scénarios exigés, tous couverts :

| # | Scénario | Section |
|---|---|---|
| 1 | résiliation à échéance nominale | 3 |
| 2 | résiliation immédiate nominale | 4 |
| 3 | rejeu à échéance | 3 |
| 4 | rejeu immédiat | 4 |
| 5 | réponse perdue | 5 |
| 6 | reprise / convergence | 5 |
| 7 | UNKNOWN non résoluble (état illisible) | 6 |
| 8 | ownership inconnu | 9 |
| 9 | ownership autre projet | 9 |
| 10 | lien révoqué | 9 |
| 11 | TEST | 1–8 |
| 12 | PROD | 10 |
| 13 | aucun credential projet envoyé | 12 |
| 14 | seule la clé Panel atteint Stripe | 12 |
| 15 | webhook après résiliation | 11 |
| 16 | webhook avant réponse | 11 (voir réserve 3) |
| 17 | conflit `cancel_now` / `cancel_at_period_end` | 8 |
| 18 | absence de fallback local | 18–19 (invariants) |

Plus **18 nouvelles gardes structurelles** dans
`stripe-ownership-invariants.test.js` (104/0). Elles vérifient des **positions**,
pas des présences : une vérification d'appartenance placée après la lecture ne
protégerait plus de rien.

## 23. Suites complètes ?

Rejouées **séquentiellement**, après les commits Finances :

| Suite | Résultat |
|---|---|
| Panel — `tests/run-all.js` | **105 / 105 fichiers OK** |
| SB Auto — `npm test` (79 fichiers chaînés) | **exit 0, zéro échec** |
| Panel frontend — `tsc --noEmit` + `vite build` | OK |
| SB Auto `manager` — `tsc` + build | OK |
| SB Auto `vitrine` — `tsc` + build | OK |

**Un incident transitoire, honnêtement rapporté.** Au premier passage complet,
`integrated-api-control-plane.test.js` a rendu 2 échecs (`un second jeu
STRIPE/TEST est refusé par la base`) : la course d'index Mongoose déjà documentée
aux lots précédents. Causalité écartée par un fait vérifiable — **ce fichier
s'exécute en position 2984 du journal, mon nouvel E2E en position 4923** : un
test qui n'a pas encore tourné ne peut pas avoir causé l'échec d'un test
antérieur. Le fichier passe seul (65/0) et n'a plus rouge au passage suivant
(105/105). Il n'a **pas** été « réparé » dans ce lot.

**Treize assertions de comptage** ont été mises à jour dans cinq suites du Panel
(`stripe-control-plane`, `capability-gateway`, `commercial-readiness`,
`commercial-readiness-runtime`, `stripe-resource-ownership`). Ce ne sont pas des
tests affaiblis : ce sont des invariants qui **comptent** l'état du catalogue, et
le catalogue a changé. J'ai partout **remplacé** le compte par le nouveau et
**ajouté** l'assertion nominative correspondante — le comptage seul ne dirait pas
lesquelles. Aucune suite Finances n'a été modifiée.

## 24. Fichiers modifiés ?

**Panel — 17 fichiers, dont 2 créés :**

```
CRÉÉ    backend/src/services/integratedApi/stripe/stripeSubscriptionCancellation.js
CRÉÉ    tests/stripe-subscription-cancellation-e2e.test.js
        backend/src/services/capabilities/capabilityRegistry.js
        backend/src/services/integratedApi/commercialReadiness.js
        backend/src/services/integratedApi/providerRegistry.js
        backend/src/services/integratedApi/stripe/stripeAdapters.js
        backend/src/services/integratedApi/stripe/stripeCapabilities.js
        backend/src/services/integratedApi/stripe/stripeTransport.js
        docs/architecture/CAPABILITY_GATEWAY.md
        docs/architecture/INTEGRATED_API_CONTROL_PLANE_ROADMAP.md
        tests/capability-gateway.test.js
        tests/commercial-readiness-runtime.test.js
        tests/commercial-readiness.test.js
        tests/run-all.js
        tests/stripe-control-plane.test.js
        tests/stripe-ownership-invariants.test.js
        tests/stripe-resource-ownership.test.js
```

*(plus ce rapport)*

**SB Auto 06 — 9 fichiers, aucun créé :**

```
        backend/src/services/contract.service.js
        backend/src/services/contractTestTools.service.js
        backend/src/services/stripe/checkoutCapability.js
        backend/src/services/stripe/stripe.service.js
        backend/src/scripts/helpers/panelCheckoutDouble.helper.js
        backend/src/scripts/cancellation-mode.test.js
        backend/src/scripts/contract-billing-signature.test.js
        backend/src/scripts/stripe.test.js
        backend/src/scripts/subscription-flow.test.js
```

Aucun fichier Finances. Aucun fichier Brevo. Aucun reformatage massif.

## 25. Commits / push ?

Voir la section « Livraison » en fin de rapport — staging nommé fichier par
fichier, diff staged relu, deux commits, push fast-forward.

## 26. Réserves honnêtes ?

1. **La convergence par l'état repose sur une propriété de Stripe, pas sur une
   garantie contractuelle.** J'affirme qu'un abonnement est `canceled` ou ne
   l'est pas, sans état intermédiaire. C'est vrai du modèle documenté et du
   comportement observé, mais ce n'est pas une promesse d'API. Le jour où Stripe
   introduirait un état transitoire (« annulation programmée en cours de
   traitement »), la relecture pourrait conclure « pas fait » sur un acte en
   train de se faire — et rejouer. Le garde-fou existe déjà : `INDETERMINATE`
   refuse plutôt que de supposer. Mais il faudrait y ranger le nouvel état à la
   main.

2. **`billing.subscription.retrieve` est relue à chaque résiliation.** Deux
   appels HTTP là où le chemin local en faisait un. C'est le prix de la
   convergence par l'état, et je le juge très bon marché face à une double
   coupure — mais c'est un coût réel, non nul, sur un chemin utilisateur.

3. **Le scénario 16 « webhook avant réponse » n'est pas isolé comme les autres.**
   L'ingestion étant synchrone dans le harnais, je ne peux pas faire arriver un
   événement pendant qu'une mutation est en vol sans fabriquer un ordonnancement
   qui n'existerait que dans le test. Ce que je prouve à la place — et qui
   couvre le risque réel — c'est que le routage ne dépend **d'aucun état
   d'opération en cours** : il lit le registre de liens, immuable, et rend le
   même verdict quel que soit le moment. Un événement arrivé « trop tôt » ne
   peut donc pas être mal attribué.

4. **`git status` du Panel ne montre aucun fichier Finances non committé au
   moment de la livraison**, mais le chantier parallèle est actif : il a livré
   deux fois pendant ce lot. Mes suites vertes datent d'**après** son dernier
   commit ; elles ne préjugent pas du suivant.

5. **La politique commerciale reste celle d'avant.** Le `catch` autour de la
   coupure immédiate dans `contract.service.js` avale toujours l'erreur. C'est
   délibéré — reproduire avant d'inventer — mais cela signifie qu'un refus du
   Panel (`RESOURCE_NOT_OWNED`, `PROVIDER_UNAVAILABLE`) reste silencieux pour le
   parcours métier. Le journal du Panel le voit ; l'écran, non. C'est un candidat
   naturel pour le lot suivant, et je ne l'ai pas traité ici parce qu'il change
   un comportement produit.

6. **Aucune convergence différée n'existe pour une opération `UNKNOWN` que
   personne ne rejoue.** Elle converge quand un appelant redemande. Si plus
   personne ne redemande, elle reste `UNKNOWN` jusqu'à un arbitrage humain —
   ce qui est le comportement voulu, mais n'est pas une réconciliation.

## 27. Quel est le prochain lot Stripe recommandé ?

**L6.3 — cutover de l'endpoint webhook et retrait des credentials projet.**

Le raisonnement : le cycle de vie d'un abonnement est désormais **complet** côté
Panel — client, tarif, session, adoption, lecture, et les deux façons d'y mettre
fin. Ce qui reste local (portail client, listes de factures) est de la **lecture
confortable**, sans risque d'argent doublé.

En revanche, tant que le projet détient encore des credentials Stripe et reçoit
encore des webhooks en direct, la centralisation reste **réversible par
accident** : un développeur peut rouvrir un chemin local sans que la structure
s'y oppose. Fermer la porte vaut mieux qu'ajouter une pièce.

Un `billing.portal.create` (L6.2H) serait plus simple, mais il ne ferme aucun
risque : c'est une session de lecture, sans mutation financière. Je le
recommanderais **après** L6.3, pas avant.

**Conditions d'entrée en L6.3**, telles que la feuille de route les pose : sept
jours sans appel Stripe local en journal sur les parcours migrés, et zéro
événement `UNOWNED` non expliqué.

---

STRIPE SUBSCRIPTION CANCELLATION CONTROL PLANE CUTOVER: PASS

GO L6.2H: NO
