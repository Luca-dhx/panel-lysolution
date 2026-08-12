# FINANCES L10.3 — PROJECTION DES REVENUS STRIPE

Rapport de lot. Panel L.Y Solution.
Doctrine : [`62_FINANCIAL_LEDGER.md`](./62_FINANCIAL_LEDGER.md) § 13 quater.
Lots précédents : [L10.1](./FINANCES_L10_1_FINANCIAL_CORE_REPORT.md) ·
[L10.2](./FINANCES_L10_2_RECURRING_COSTS_AND_RECEIPTS_REPORT.md).

---

## 1. Baseline réelle

| Dépôt | HEAD au démarrage | Arbre |
|---|---|---|
| Panel | `a90592a` | propre |
| SB Auto 06 | `dc9e25f` | propre |

Acquis L10.1/L10.2 **audités dans le code**, pas déduits des rapports :
`PanelFinancialTransaction` (avec `provenance`, `sourceId`/`cycleKey` et leur index unique
partiel), `financialSummary.service.js`, `PanelRecurringCost`, `PanelMedia.visibility`,
`privateMedia.service.js`, `mediaPolicy.js` étendu, `FinanceWorkspace.tsx`, `FinancesPage.tsx`,
suites `finance-core` / `finance-recurring` / `finance-receipts` / `finance-ui`.

**SB Auto n'a pas été modifié** par ce lot.

## 2. Travail L6.2G parallèle détecté

Oui, et il est **actif dans l'arbre de travail** (non committé au moment du staging).

Fichiers L6.2G, jamais touchés ni stagés :

```
backend/src/services/capabilities/capabilityRegistry.js
backend/src/services/integratedApi/commercialReadiness.js
backend/src/services/integratedApi/providerRegistry.js
backend/src/services/integratedApi/stripe/stripeAdapters.js
backend/src/services/integratedApi/stripe/stripeCapabilities.js
backend/src/services/integratedApi/stripe/stripeTransport.js
backend/src/services/integratedApi/stripe/stripeSubscriptionCancellation.js   (nouveau)
tests/stripe-ownership-invariants.test.js
tests/stripe-subscription-cancellation-e2e.test.js                            (nouveau)
README.md
```

Fichier **partagé** : `tests/run-all.js` — leur inscription
(`stripe-subscription-cancellation-e2e.test.js`) et la mienne
(`finance-stripe-revenue.test.js`) y coexistent. Traité par staging de **hunk**.

**Aucune collision de fichier de code.** Mon seul point de contact avec la couche webhook est
`webhookIngest.js`, que L6.2G n'a pas modifié.

## 3. Quels événements Stripe peuvent représenter de l'argent ?

Inventaire des treize événements souscrits, classés :

| Événement | Argent ? | Routable aujourd'hui ? |
|---|---|---|
| `checkout.session.completed` | **oui** si `payment_status: paid` | oui — lien CHECKOUT_SESSION (L6.2B) |
| `checkout.session.async_payment_succeeded` | **oui** | oui — même lien |
| `invoice.paid` | **oui** si `amount_paid > 0` | oui — par filiation vers l'ABONNEMENT |
| `invoice.payment_succeeded` | oui, mais redondant | corroboratif |
| `payment_intent.succeeded` | oui, mais redondant | **non** — aucun lien sur `pi_` |
| `charge.succeeded` | oui, mais redondant | non |
| `checkout.session.expired`, `async_payment_failed` | non — intention | — |
| `invoice.finalized`, `invoice.payment_failed` | non — intention/échec | — |
| `payment_intent.payment_failed` | non | — |
| `charge.refunded` | **mouvement inverse** | reconnu, différé L10.4 |
| `customer.subscription.*` | non — un abonnement n'est pas un paiement | — |

Détectés et documentés pour L10.4 : `charge.refunded`, `charge.dispute.created`,
`credit_note.created`.

## 4. Quel fait est canonique pour un revenu ?

- paiement **facturé** → la **FACTURE** (`in_…`) ;
- paiement **non facturé** → la **SESSION** (`cs_…`).

La règle se lit sur la charge utile seule : une session d'abonnement porte `invoice`, donc
elle s'efface ; une session `mode: payment` n'en a pas, donc elle est canonique.

## 5. Comment évites-tu Invoice + PaymentIntent + Checkout en triple ?

Par la **clé**, pas par un filtre a posteriori.

Les deux chemins qui décrivent le premier paiement d'un abonnement calculent la **même
identité canonique** — la facture. `checkout.session.completed` rend
`CORROBORATING_ONLY` dès qu'elle porte un `invoice`. `payment_intent.succeeded` et
`charge.succeeded` sont **énumérés** comme corroboratifs (`CORROBORATING_EVENTS`), pour que
la recette prouve qu'ils ont été vus et écartés — un événement ignoré par omission est
indiscernable d'un événement écarté à dessein.

**Éprouvé** : quatre annonces du même paiement → une transaction, comptée.

## 6. Quelle est l'identité externe d'une transaction provider ?

```
provenance.provider      STRIPE
provenance.environment   TEST | PROD
provenance.externalKind  INVOICE | CHECKOUT_SESSION
provenance.externalId    in_… | cs_…
```

Index **unique partiel** `uniq_provider_external_object`. Le filtre partiel n'indexe que les
mouvements portant un `externalId`.

## 7. Pourquoi `{sourceId, cycleKey}` n'a-t-il pas été détourné ?

Parce que **l'emplacement existait déjà**. `provenance` a été posée en L10.1 pour exactement
cela : fournisseur, monde, type d'objet, identifiant. Il n'y avait rien à inventer, seulement
à rendre cette identité contraignante.

Et parce que détourner l'autre aurait été faux : `{sourceId, cycleKey}` est taillé pour une
règle interne et un cycle calendaire. Deux familles sans rapport sur un même index unique se
collisionneraient le jour où leurs identifiants se croiseraient — un défaut silencieux, qui
se manifesterait par un revenu manquant.

**Éprouvé** : une occurrence récurrente et un revenu Stripe coexistent ; l'occurrence porte
`sourceId`+`cycleKey` et **aucune** provenance externe, le revenu l'inverse.

## 8. Comment TEST/PROD sont-ils séparés ?

L'environnement vient du **runtime** (doctrine L2), jamais de `livemode` — laisser le corps
choisir permettrait à un événement de recette de désigner un lien de production. Un contrôle
vérifie qu'aucune branche du code ne lit `livemode`.

Il fait partie de la clé d'unicité du fait **et** de celle de la transaction.

**Éprouvé** : le même identifiant `in_homonyme` en TEST et en PROD produit **deux** faits et
**deux** transactions, chacune portant son monde. Jamais l'une n'écrase l'autre.

**Politique retenue** (aucune n'existait) : une instance de Panel sert un monde et sa base est
par environnement ; les montants de recette sont donc la réalité **de ce Panel** et comptent
dans ses totaux. L'information n'est jamais perdue : elle est affichée en pastille dans le
détail, et en `TEST` sur la ligne du livret.

## 9. Comment le projectId est-il déterminé ?

Par le **registre d'appartenance** (L6.2A), et lui seul :

| Fait | Ressource porteuse | Lien |
|---|---|---|
| session payée | la session | `PANEL_CREATED` (L6.2B) |
| facture payée | son **abonnement** | adopté par filiation (L6.2F) |

La filiation facture → abonnement est désignée par Stripe **sur l'objet reçu** : aucun appel
fournisseur. L'abonnement y est lu à **trois emplacements** selon la version d'API — n'en lire
qu'un ferait cesser toute projection d'abonnement, en silence, le jour d'une migration de
compte.

## 10. Metadata a-t-elle une autorité ?

**Non.** Elle corrobore. Une divergence est journalisée, stockée (`claimMismatch`) et affichée
dans le détail comme un signal de sécurité.

Seule exception assumée et bornée : le **libellé** d'un paiement de frais peut venir de
`metadata.paymentType`. Un nom faux est cosmétique ; un propriétaire faux est une brèche.

**Éprouvé** : une facture dont les metadata désignent le projet B, mais dont l'abonnement est
lié au projet A, produit un revenu **au projet A** ; B ne le voit pas.

## 11. Quel montant est projeté ?

- facture : `amount_paid` — **jamais** `total` ni `amount_due` ;
- session : `amount_total`, et seulement si `payment_status === 'paid'`.

**Éprouvé** : une facture de 249 € encaissée à 0 € ne produit aucun revenu ; une facture de
249 € réglée à 100 € produit 100 €.

Centimes entiers, aucun flottant — un contrôle interdit toute division par cent et tout
`parseFloat` dans la projection.

## 12. Quelle date est retenue ?

Celle du **règlement** : `status_transitions.paid_at` pour une facture, l'instant de
l'événement pour une session (la session a pu être ouverte des heures plus tôt).

Une facture émise le 28 et payée le 2 appartient au mois du paiement — c'est ce mois-là qui a
vu l'argent arriver.

## 13. Comment nom/description sont-ils déterminés ?

1. la **ligne de facture** (`lines.data[0].description`) — le libellé que le client a vu ;
2. le **type de paiement** inscrit par le Panel (`metadata.paymentType`) → « Abonnement » ou
   « Frais de mise en service » ;
3. un repli explicite : « Facture Stripe » / « Paiement Stripe ».

`pi_3Q7x…` n'apparaît **jamais** comme nom. Description = la période couverte quand elle
existe, sinon le numéro de facture, sinon rien — on n'invente pas de phrase.

## 14 / 15. Comment une facture Stripe est-elle associée ? Distante ou matérialisée ?

**Distante, et c'est une décision explicite.**

Stripe expose `hosted_invoice_url` et `invoice_pdf`. Le Panel les conserve sur le **fait** et
les affiche dans le détail, avec la mention qu'ils peuvent expirer. **Aucune copie n'est
matérialisée d'office.**

Pourquoi : télécharger systématiquement chaque facture ferait entrer des documents dans le
stockage privé sans que personne l'ait demandé, avec une rétention à définir et un transfert
à chaque paiement. La consigne était d'ailleurs explicite — « ne télécharge pas
automatiquement des documents juste par principe ».

La copie durable existe déjà : le **justificatif privé de L10.2**, attaché quand l'opérateur
le décide. L'écran le dit.

**Éprouvé** : aucun `PanelMedia` de portée `FINANCIAL_RECEIPT` n'est créé par une projection.

## 16. Que se passe-t-il sans facture ?

Un paiement de frais (`mode: payment`) n'a pas de facture Stripe : `invoiceDocument` est
`null`, et le détail n'affiche aucun bloc vide.

## 17. Peut-on uploader un justificatif plus tard ?

Oui, par le mécanisme **L10.2 inchangé** — aucune ligne de code nouvelle. Le revenu Stripe est
une transaction comme une autre : la cellule « Justificatif » y est déjà.

**Éprouvé** : un PDF est attaché à un revenu Stripe, puis un rejeu du webhook **ne le détruit
pas** — `receipt` n'apparaît dans aucun `$set` ni `$setOnInsert` de mise à jour.

## 18 / 19 / 20. Idempotence

| Scénario | Résultat |
|---|---|
| même webhook ×2 | une transaction — le registre de réception absorbe le rejeu **avant** la projection |
| 4 événements différents, même paiement | une transaction — même identité canonique |
| 8 projections **simultanées** | une transaction, un fait |
| doublon écrit à la main | refusé par la base (E11000) |
| redémarrage / rejeu tardif | rien de neuf |

La garantie est **en base** : index unique sur le fait, index unique partiel sur la
transaction. Un `findOne` suivi d'un `create` laisserait passer deux écrivains qui se croisent.

## 21. Un abonnement produit-il exactement un revenu par échéance encaissée ?

Oui. Chaque facture payée est un fait distinct ; deux mois consécutifs produisent deux
transactions avec deux `externalId` différents.

**Éprouvé** : septembre et octobre → deux revenus, deux périodes, aucune collision.

## 22. Un paiement ponctuel produit-il un revenu ?

Oui — 990 € de frais de mise en service → une transaction `INFLOW`/`REVENUE`, libellée
« Frais de mise en service ».

## 23. Un projet B peut-il voir le revenu de A ?

Non. La portée `project` filtre sur `projectId`, qui vient du lien. **Éprouvé** avec la
facture aux metadata détournées.

## 24. Que devient une ressource UNOWNED ?

Elle est **retenue, jamais attribuée**. Le fait est enregistré (un revenu réel ne se jette
pas), la transaction n'est **pas** créée, et le motif est nommé (`NO_BINDING`).

Visible dans `GET /api/finances/provider-revenue/unprojected` — réservé DEV, parce que ce sont
des identités techniques.

## 25. Comment une transaction est-elle enrichie ultérieurement ?

| | |
|---|---|
| **Immuable** | montant, devise, date, sens, catégorie, projet, identité externe |
| **Enrichissable** | document de facture, identités secondaires, libellé — **sur le fait** |
| **Jamais touché** | `receipt` |

Les champs enrichissables vivent sur le fait plutôt que sur la transaction : c'est ce qui garde
la `provenance` du registre comptable maigre, comme L10.1 l'exigeait, tout en laissant les
informations arriver en retard.

## 26. Que se passe-t-il après suppression puis replay Stripe ?

**Aucune résurrection.** La suppression est logique (L10.1) : le document reste, `deletedAt`
le sort des totaux, sa clé d'identité externe **reste occupée**. La recherche d'une
transaction existante ne filtre pas sur `deletedAt` — c'est portant, et commenté comme tel.

**Éprouvé** : suppression d'un revenu Stripe, puis rejeu du webhook → une seule transaction,
toujours supprimée.

## 27 / 28. Graphique et page globale

Oui, tous deux utilisent le moteur générique. Aucun calcul parallèle : l'agrégateur somme des
`PanelFinancialTransaction` et ne connaît ni Stripe, ni les faits fournisseur.

**Éprouvé** : revenu manuel + revenu Stripe + coût ponctuel + coût récurrent →
`net === revenus − coûts`, et la somme des points du graphique égale le net.

## 29. Le renommage projet fonctionne-t-il ?

Oui. La relation repose sur `projectId` ; `projectNameSnapshot` n'est pas renseigné par la
projection, et le nom affiché est résolu depuis le registre vivant.

**Éprouvé** : après renommage, la répartition suit toujours le projet.

## 30. Les IDs Stripe sont-ils cachés de la ligne mais visibles dans les détails ?

Oui. La ligne montre montant, nom, date, justificatif, et une mention discrète « Encaissé via
Stripe » (+ pastille `TEST`). **Aucun identifiant.**

Le détail charge le fait à l'ouverture — jamais la liste — et range les identifiants
techniques dans un `<details>` **replié par défaut**.

## 31. Le modèle est-il prêt pour L10.4 ?

Oui. `payment_intent`, `charge`, `subscription`, `customer` et le numéro de facture sont
conservés sur le fait. Un remboursement les y trouvera sans que le registre comptable ait eu à
porter une structure fournisseur.

`charge.refunded` est **reconnu et journalisé**, jamais projeté. À l'issue du lot :
**0** transaction `REFUND`, **0** `COST` d'origine `STRIPE`, et la taxonomie ne contient que
`REVENUE`/`COST`/`REFUND`/`ADJUSTMENT`.

## 32. Existe-t-il un appel Stripe live depuis Finance ?

**Non.** Contrôles statiques :

- le **noyau financier** (7 modules) ne contient aucun code Stripe ;
- la **couche de projection** ne fait aucun `fetch` et n'importe ni transport, ni adaptateur,
  ni capacité ; sa seule dépendance à `integratedApi/stripe/` est le **registre
  d'appartenance** ;
- aucune **vue financière** n'importe un module Stripe, n'appelle un domaine du fournisseur ni
  ne fait de `fetch` ;
- la projection ne fabrique aucun chemin `/uploads` et n'appelle jamais
  `resolvePanelMediaUrl`.

## 33. Les documents privés restent-ils privés ?

Oui — invariants L10.2 **rejoués**, pas réécrits : `finance-receipts` 105/105 et
`media-first-deployment` 63/63 passent, y compris la non-publication d'un média privé au
déploiement et l'absence de toute URL publique.

## 34. Tests dédiés

`tests/finance-stripe-revenue.test.js` — **142 contrôles**, 22 sections :

normalisation et objet canonique · intention ≠ encaissement · les trois emplacements de
`subscription` · paiement ponctuel · abonnement (une échéance = un revenu) · idempotence
(rejeu, 4 événements, **8 projections concurrentes**, doublon manuel refusé) · non-détournement
de `{sourceId, cycleKey}` · appartenance par le lien contre metadata détournées ·
ressource UNOWNED · **convergence du désordre de livraison** · TEST/PROD homonymes ·
moteur générique et net mixte · identifiants dans le détail seulement · facture distante ·
justificatif manuel ultérieur et survie au rejeu · **suppression puis rejeu** · vue globale
et renommage · préparation L10.4 · garde-fous statiques · environnement jamais deviné ·
**parcours réel depuis un webhook signé** (accepté, rejeu = doublon, signature fausse
refusée) · **désordre de livraison par le chemin réel**.

`tests/finance-ui.test.js` — **+22 contrôles** (183 au total) : origine discrète sans
identifiant, pastille TEST, panneau de détail, identifiants repliés, facture en lien sécurisé,
client d'API sans Stripe.

## 35. Suite complète

Voir la section « Recette et livraison » ci-dessous.

## 36. Fichiers modifiés

### Créés

```
backend/src/models/PanelProviderRevenueFact.model.js
backend/src/services/finance/providerRevenue/stripeRevenueNormalizer.js
backend/src/services/finance/providerRevenue/revenueProjection.service.js
frontend/src/components/finance/ProviderFactPanel.tsx
tests/finance-stripe-revenue.test.js
docs/architecture/FINANCES_L10_3_STRIPE_REVENUE_PROJECTION_REPORT.md
```

### Modifiés

```
backend/package.json                                   1 script de recette
backend/src/models/PanelFinancialTransaction.model.js  index unique de provenance
backend/src/services/webhooks/webhookIngest.js         le hook de projection (1 bloc)
backend/src/services/finance/recurringCostScheduler.js convergence des revenus au tick
backend/src/controllers/finances.controller.js         convergence, détail enrichi, file
backend/src/routes/finances.routes.js                  1 route DEV de diagnostic
frontend/src/types.finance.ts
frontend/src/lib/api.ts
frontend/src/components/finance/FinanceWorkspace.tsx   mention d'origine discrète
frontend/src/components/finance/TransactionDetail.tsx  chargement du fait
frontend/src/components.css
tests/finance-core.test.js                             inventaire d'index à jour
tests/finance-ui.test.js                               +22 contrôles
tests/run-all.js                                       inscription de la suite (hunk isolé)
docs/architecture/62_FINANCIAL_LEDGER.md               § 13 quater
```

Aucune migration de données : aucune transaction existante ne porte de `provenance.externalId`,
donc l'index partiel est vide au démarrage.

## 38. Réserves honnêtes

1. **`payment_intent.succeeded` reste non projeté.** C'est correct aujourd'hui — il double une
   facture ou une session. Mais un paiement créé **hors du Panel** (lien de paiement Stripe,
   facture émise à la main dans le tableau de bord) n'a ni session ni abonnement lié : il
   n'entrera pas. Le fait n'est même pas retenu, puisqu'il est classé corroboratif. Si ce
   cas devient réel, il faudra une famille de liens `PAYMENT_INTENT` — pas un contournement.
2. **Devise unique.** Un encaissement hors EUR est retenu et non projeté
   (`CURRENCY_UNSUPPORTED`), visible dans la file de diagnostic. Aucune conversion n'est
   inventée.
3. **La file `unprojected` n'a pas d'écran.** Elle est servie par une route DEV. Un exploitant
   doit aujourd'hui l'appeler à la main ; un écran serait utile en L10.6.
4. **Pas de rapprochement inverse.** Le Panel ne demande jamais à Stripe « ai-je tout reçu ? ».
   Un webhook définitivement perdu resterait invisible. Une réconciliation périodique serait
   un lot en soi — et elle romprait la règle « aucune lecture live » si elle était branchée
   sur l'affichage.
5. **`convergePendingRevenue` est bornée à 200 faits par passage** et tourne à chaque lecture
   financière. Sur un incident de masse, la convergence prendrait plusieurs passages ; c'est
   volontaire, mais aucun journal ne le signale encore.
6. **Aucune facture Stripe n'est archivée.** Les liens `hosted_invoice_url` expirent. Un
   justificatif durable reste un geste manuel.

## 39. Quel lot Finances doit suivre ?

**L10.4 — Refund Operations.** Tout est prêt : identités conservées, taxonomie `REFUND`
disponible, `parentTransactionId` posé depuis L10.1, événements de remboursement déjà
reconnus et classés.

Trois points d'attention pour L10.4 :

- un remboursement est `REFUND`/`OUTFLOW`, **jamais** `COST` ;
- son identité externe devra être celle du **refund Stripe** (`re_…`), pas celle du paiement —
  sinon il entrerait en collision avec le revenu sur l'index de provenance ;
- le paiement d'origine reste historiquement `+X` ; il doit recevoir un statut/badge, pas une
  réécriture de montant.

---

## 35 / 37. Recette et livraison

### Suites ciblées — toutes vertes

| Suite | Contrôles |
|---|---|
| `finance-stripe-revenue` | **142 / 142** |
| `finance-core` | 138 / 138 |
| `finance-recurring` | 105 / 105 |
| `finance-receipts` | 105 / 105 |
| `finance-ui` | **183 / 183** |
| `media-first-deployment` | 63 / 63 |
| `architecture` | 31 / 31 |
| `panel-ux` | 86 / 86 |

Typecheck `tsc -b` (aussi le `lint` du frontend) : **vert**. Build `vite build` : **vert**.

### Suite Panel complète : `99 / 105 fichiers`

**Les six rouges sont étrangers à ce lot.** Ils appartiennent au chantier **Stripe L6.2G**,
actif dans l'arbre au moment de l'exécution, et ils sont **prouvés** tels :

| Suite en échec | Assertions rouges |
|---|---|
| `stripe-control-plane` | « sept capacités contractualisées », « cinq capacités servies », **« billing.subscription.cancel_now : l'entrée nominale est acceptée »**, **« cancel_at_period_end … »**, « deux écritures financières », « quatre capacités exigent une ressource » |
| `capability-gateway` | « les capacités servies sont EXACTEMENT les 10 attendues », « cinq capacités Stripe sont servies », « deux capacités dérivent leur identité d'acte » |
| `stripe-resource-ownership` | « quatre capacités exigent une ressource préexistante », « deux d'elles sont servies », « les deux autres restent fermées » |
| `commercial-readiness` | « 4 capacités sont bloquées en pré-ouverture », « la vue nomme ce que la pré-ouverture interdit » |
| `commercial-readiness-runtime` | idem |

**La preuve, en deux faits :**

1. toutes ces assertions comptent des **capacités** ou nomment directement
   `billing.subscription.cancel_now` / `cancel_at_period_end` ;
2. `git diff` montre que ces capacités sont **ajoutées en ce moment** par L6.2G dans
   `capabilityRegistry.js` (`+ 'billing.subscription.cancel_now': capability(…)`,
   `+ import { cancellationOperationId } from '…/stripeSubscriptionCancellation.js'`) et dans
   `commercialReadiness.js` (`+ 'billing.subscription.cancel_now': EFFECT.FINANCIAL_WRITE`).

Ce lot ne touche **aucun** fichier de capacité. Ces suites n'ont **pas** été réparées —
c'est au chantier L6.2G de mettre ses compteurs à jour quand il livrera.

> Un rouge de ce lot a bien existé, et il était à moi : `finance-core` refusait le cinquième
> index. L'inventaire nommé posé en L10.2 a été complété avec
> `uniq_provider_external_object` — ce que ce contrôle est fait pour exiger.
>
> Un second, aussi à moi : mon propre garde-fou refusait le **mot** « Stripe » dans les vues
> financières, et rendait donc rouge le libellé « Encaissé via Stripe ». Il mesurait un mot,
> pas une dépendance. Il mesure désormais les imports, les domaines et les `fetch`.

### Isolation avant commit

`git status`, puis `git diff` **fichier par fichier**. Aucun `UNKNOWN`.

Fichiers ambigus levés par inspection :

- `backend/package.json` → une seule ligne ajoutée, la mienne ;
- `backend/src/services/webhooks/webhookIngest.js` → 58 insertions, **aucune** mention de
  résiliation : 100 % de ce lot ;
- `tests/run-all.js` → **deux hunks**, un de chaque chantier.

Staging **nommé fichier par fichier**, jamais `git add -A`. Pour le fichier partagé, staging
de **hunk** :

```
git apply --cached run-all-l103.patch      # uniquement l'inscription de finance-stripe-revenue
```

`tests/run-all.js` apparaît alors en `MM` : mon hunk indexé, le leur laissé dans l'arbre.

### Contrôle du diff stagé

Recherche de fichiers L6.2G stagés : **aucun**. Recherche de lignes ajoutées citant
`cancel_now`, `cancel_at_period_end`, `cancellationOperationId` : **deux occurrences, toutes
deux dans la prose de ce rapport**, qui documente leurs fichiers. Aucun code.

### Commit et push

*(complétés ci-dessous)*

---

## Critères de passage

| Critère | État |
|---|---|
| revenus Stripe encaissés projetés dans le ledger générique | ✅ |
| aucun second ledger, aucun calcul Stripe parallèle | ✅ |
| un paiement = une transaction (4 annonces, 8 concurrents, rejeu) | ✅ |
| intention non encaissée jamais projetée | ✅ |
| `{sourceId, cycleKey}` non détourné | ✅ identité externe sur `provenance` |
| TEST/PROD séparés, jamais perdus | ✅ deux mondes, deux faits |
| appartenance par le lien, metadata corroborative | ✅ |
| ressource UNOWNED retenue, jamais attribuée | ✅ + file de diagnostic |
| convergence du désordre de livraison | ✅ éprouvée par le chemin réel |
| suppression puis rejeu sans résurrection | ✅ |
| IDs Stripe hors de la ligne, présents au détail | ✅ repliés |
| facture Stripe associée, justificatif manuel possible | ✅ lien distant + L10.2 |
| aucun appel Stripe depuis Finance ni depuis l'UI | ✅ contrôles statiques |
| documents privés toujours privés | ✅ invariants L10.2 rejoués |
| aucun remboursement implémenté | ✅ reconnu, différé |
| chantier L6.2G intégralement préservé | ✅ 0 fichier touché |
| tests dédiés | ✅ 142 + 22 |
| build / typecheck | ✅ |

---

FINANCES STRIPE REVENUE PROJECTION: PASS

GO L10.4 REFUNDS: YES

> Trois points à traiter **au début** de L10.4, pas après :
> le remboursement est `REFUND`/`OUTFLOW` et **jamais** `COST` ; son identité externe doit être
> celle du **refund Stripe** (`re_…`) et non celle du paiement, sinon il entre en collision
> avec le revenu sur l'index de provenance ; et le paiement d'origine reçoit un **badge**, pas
> une réécriture de montant.
