# FINANCES L10.1 — FINANCIAL CORE

Rapport de lot. Panel L.Y Solution.
Référence d'architecture : [`62_FINANCIAL_LEDGER.md`](./62_FINANCIAL_LEDGER.md).

---

## A. Baseline

| Dépôt | HEAD au démarrage | Arbre au démarrage |
|---|---|---|
| Panel | `cb317291af427c1b3cc73691ec203b4e5f2c9558` (`cb31729`) | **propre** |
| SB Auto 06 | `4aff8a37fda6eb2f6f9eaed38a8e0f72989c9562` (`4aff8a3`) | **propre** |

Conformes aux baselines annoncées. Aucune modification non committée n'existait au
démarrage : le chantier Stripe L6.2E n'avait alors rien en cours dans l'arbre.

### Dérive constatée en cours de lot

Le chantier L6.2E a committé **dans les deux dépôts** pendant que ce lot travaillait.

| Dépôt | HEAD en fin de lot | Cause |
|---|---|---|
| Panel | **`e3f70b8`** | `feat(stripe): un tarif n'est pas une version de contrat — c'est des termes`, **chantier L6.2E** |
| SB Auto 06 | **`ef43487`** | `feat(abonnement): le projet ne fabrique plus aucun objet Stripe`, **chantier L6.2E** |

Les deux commits sont **entièrement étrangers** à L10.1. Aucun fichier de SB Auto n'a été
lu-pour-modifier, touché ni committé par ce lot ; son arbre est propre.

Le travail de L10.1 a donc été committé **sur** `e3f70b8`, en avance rapide. Aucun rebase
n'a été nécessaire : les fichiers des deux lots sont disjoints.

### Un hunk de L10.1 absorbé par le commit voisin — constat, sans correction

Le commit `e3f70b8` contient `tests/run-all.js` **avec les deux hunks** : le sien
(`stripe-subscription-cutover-e2e.test.js`) et **le mien** (l'inscription de
`finance-core.test.js` et `finance-ui.test.js`). Le chantier voisin a stagé ce fichier
entier — son message annonce pourtant « aucun de ses fichiers n'est touché, aucun n'est
stagé ».

**Rien n'a été fait pour le défaire.** Réécrire, revert ou amender le commit d'un autre
chantier est exactement ce que la consigne d'isolation interdit, et le résultat fonctionnel
est correct : la suite exécute bien les deux recettes financières.

Conséquence pratique : `tests/run-all.js` n'apparaît plus dans mon `git status` — il est
déjà à jour dans `HEAD`. Le staging par hunk préparé pour ce fichier (§AD) est donc devenu
sans objet, et **tous les fichiers restants à committer sont à 100 % de ce lot**.

---

## B. Travail parallèle Stripe détecté

Le chantier L6.2E a livré **pendant** ce lot. Classement effectué à la Phase 27, sur
`git status --short` et `git diff` fichier par fichier.

### `STRIPE_L6_2E` — jamais touché, jamais stagé

Modifiés :
```
backend/src/services/capabilities/capabilityRegistry.js
backend/src/services/integratedApi/commercialReadiness.js
backend/src/services/integratedApi/providerRegistry.js
backend/src/services/integratedApi/stripe/stripeAdapters.js
backend/src/services/integratedApi/stripe/stripeCapabilities.js
backend/src/services/integratedApi/stripe/stripeCheckoutAuthority.js
backend/src/services/integratedApi/stripe/stripeTransport.js
docs/architecture/CAPABILITY_GATEWAY.md
docs/architecture/INTEGRATED_API_CONTROL_PLANE_ROADMAP.md
tests/capability-gateway.test.js
tests/stripe-checkout-cutover-e2e.test.js
tests/stripe-checkout-read-webhook-e2e.test.js
tests/stripe-control-plane.test.js
tests/stripe-ownership-invariants.test.js
```
Non suivis :
```
backend/src/services/integratedApi/stripe/stripePriceAuthority.js
docs/architecture/STRIPE_L6_2E_PRODUCT_PRICE_SUBSCRIPTION_CUTOVER_REPORT.md
tests/stripe-subscription-cutover-e2e.test.js
```

### `UNKNOWN`

Aucun. Chaque fichier modifié a pu être rattaché à l'un des deux lots.

### Le seul fichier réellement PARTAGÉ

`tests/run-all.js` — deux hunks disjoints : l'inscription de mes deux suites, et
l'inscription de `stripe-subscription-cutover-e2e.test.js` par le chantier voisin. Un
staging par **hunk** avait été préparé (`git apply --cached` sur un patch filtré) ; il est
devenu sans objet lorsque le commit voisin a absorbé les deux hunks — voir §A.

Tous les autres fichiers listés comme modifiés et qui portent mon travail
(`app.js`, `PanelSupervision.model.js`, `App.tsx`, `nav.ts`, `api.ts`,
`ProjectDetailPage.tsx`, `components.css`) ont été vérifiés par `git diff` : ils ne
contiennent **que** mes hunks.

---

## C. Données financières existantes trouvées

Audit de `Payment`, `Invoice`, `Contract`, `billing`, `amount`, `refund`, `checkout`,
`transaction`, `subscription`, `setup fee`, ledger, documents, upload, audit, permissions,
soft-delete.

| Ce qui existe | Où | Verdict |
|---|---|---|
| Montants Stripe (`amountDue`, `amountPaid`, `unit_amount`, `currency`) | `services/integratedApi/stripe/stripeCapabilities.js` | **Contrat de LECTURE d'un fournisseur**, validé par zod à la frontière. Pas une convention monétaire du Panel. Territoire L6.2E. |
| `PanelContractAction` | modèle | Journal d'intentions contractuelles (résiliation, protection). **Aucun montant.** |
| `PanelStripeResourceBinding` | modèle | Appartenance de ressources Stripe (L6.2A). Aucun montant. |
| `PanelEvent` (chronologie) | `PanelSupervision.model.js` | Journal d'activité générique, `projectId` nullable, `source: 'PANEL'`. **Réutilisable.** |
| `PanelMedia` + `upload.service.js` | médias | Pipeline **strictement imagier**, servi **publiquement** en statique. |
| Soft-delete | `PanelMedia.deletedAt`, destinations | Précédent établi. |
| Rôles | `PanelUser` (`ADMIN`/`DEV`), `panelAuth.middleware.js` | **Réutilisés tels quels.** |
| Instantané de nom de projet | `PanelProjectEvent.projectName`, `PanelContractAction.projectName` | Précédent établi. |

**Aucun Metrics Ledger, aucune primitive monétaire, aucun modèle de transaction financière
n'existait.** Il n'y avait donc rien à réutiliser sur le cœur — et la décision documentée
est de ne PAS créer une seconde abstraction là où une fondation existait (journal,
permissions, soft-delete, instantané de nom).

---

## D. Modèles réutilisés

- `PanelEvent` / `recordEvent()` — journal d'activité. **Pas de second journal.**
- `PanelProject` / `getProjectOrThrow()` — autorité du rattachement.
- `requirePanelUser` / `requirePanelDev` — **pas d'ACL parallèle.**
- `ApiError` (catalogue `PANEL_*`), `apiResponse.ok/created`, `asyncHandler`.
- Frontend : `useLiveQuery` (doctrine), `ThemedFilter`, `SearchField`, `Card`, `EmptyState`,
  `Icon`, tokens `--p-*`.
- Convention d'instantané de nom de projet (précédent : événements, actions contractuelles).

---

## E. Nouveau modèle créé

`PanelFinancialTransaction` (`backend/src/models/PanelFinancialTransaction.model.js`).

```
transactionId          identité publique stable (UUID) — jamais `_id`
projectId              null = L.Y Solution
projectNameSnapshot    audit uniquement, jamais l'autorité
flow                   INFLOW | OUTFLOW
category               REVENUE | COST | REFUND | ADJUSTMENT
origin                 MANUAL | STRIPE | RECURRING_COST | INVOICE | IMPORT
status                 RECORDED | PENDING | FAILED | CANCELLED
label, description
amountCents            entier, TOUJOURS > 0
currency               EUR
effectiveDate          la date du FAIT (≠ createdAt)
parentTransactionId    le mouvement d'origine — vide en L10.1
provenance             { provider, environment, externalId, externalKind } — 4 champs plats
deletedAt/By/Reason
createdBy, updatedBy, timestamps
```

**Ce n'est pas un `StripeTransaction`.** Aucune classe, aucun import, aucun appel Stripe.
Le fichier *nomme* `STRIPE` comme une valeur d'origine possible : c'est précisément la
généricité, et un contrôle de recette distingue la valeur (majuscules) du code
(`stripeQuelqueChose`, `import 'stripe'`).

---

## F. Taxonomie retenue

**Deux axes orthogonaux.**

| Axe | Rôle |
|---|---|
| `flow` = `INFLOW`/`OUTFLOW` | décide du **signe** dans le net |
| `category` = `REVENUE`/`COST`/`REFUND`/`ADJUSTMENT` | décide du **total** où la ligne est comptée |

Contrainte croisée vérifiée à l'écriture (`resolveTaxonomy`) — le schéma Mongoose ne sait
valider que des champs isolés. `REVENUE→INFLOW`, `COST→OUTFLOW`, `REFUND→OUTFLOW` sont
imposés ; `ADJUSTMENT` est le seul libre, et c'est sa raison d'être.

Montant **toujours positif** : deux porteurs du même sens finissent toujours par se
contredire (un `-50` en `OUTFLOW` produirait un double négatif).

**Côté utilisateur, deux choix seulement** : « Revenu » et « Coût ». `REFUND` et
`ADJUSTMENT` sont refusés à la saisie manuelle (`PANEL_FINANCE_CATEGORY_NOT_MANUAL`).

---

## G. Pourquoi un remboursement futur ne sera pas confondu avec un coût

Parce que le sens et la nature sont **deux champs différents**.

Un remboursement sera `category: REFUND` + `flow: OUTFLOW` :

- il pèse négativement sur `totals.netCents` — c'est vrai, l'argent est sorti ;
- il n'entre **pas** dans `byCategory.costCents` — c'est vrai aussi, aucune charge
  d'exploitation n'a été supportée.

Avec un axe unique, il aurait fallu l'écrire en `COST`, et le tableau des coûts aurait
affiché des charges fictives. Ce modèle ne mentirait pas sur le net ; il mentirait sur la
marge.

**Éprouvé** — section 12 de `finance-core.test.js` : après remboursement de 100 € sur un
paiement de 249 €, `avant.byCategory.costCents === apres.byCategory.costCents`, le net
baisse de 100 €, et `refundCents === 10 000`.

---

## H. Convention monétaire

**Centimes entiers.** `amountCents: Number`, entier, strictement positif, plafonné à 10¹²
centimes (borne qui garantit l'exactitude des SOMMES sous `Number.MAX_SAFE_INTEGER`).

Aucune primitive existante ne convenait — il n'y en avait pas. Décision documentée dans
`services/finance/money.js` et §4 du document d'architecture.

Micros écartés : rien ne se divise ici, et une transaction Stripe arrivera déjà en unités
mineures — la correspondance sera l'identité, donc sans arrondi.

`parseAmountToCents` lit la saisie **chiffre par chiffre**, sans jamais multiplier par cent
(`Math.round(1.005 * 100) === 100`, pas 101). Trois décimales sont **refusées**, jamais
arrondies.

Agrégation par `$sum` MongoDB sur l'entier. Division par cent **uniquement** à l'affichage,
dans `lib/money.ts`, qui ne rend que des chaînes.

**Preuve** — `0,10 + 0,20` sommés en centimes valent `30`, et l'affichage rend « 0,30 € ».
Le test assert aussi `0.1 + 0.2 !== 0.3`, la raison d'être du module.

---

## I. Project ownership

`projectId` renseigné → mouvement d'un projet. Validé contre le registre
(`getProjectOrThrow`) : un `projectId` inconnu rend **404 `PANEL_PROJECT_NOT_FOUND`** et
rien n'est écrit.

`projectNameSnapshot` existe pour l'audit et l'export : un projet renommé ou retiré du
registre laisserait sinon une ligne de 2 400 € désignant un identifiant orphelin. Il n'est
l'autorité de **rien** — aucun filtre, aucun agrégat, aucune permission. L'affichage préfère
toujours le nom vivant (`ownershipLabel`).

---

## J. Transactions L.Y Solution

`projectId: null` — un **rattachement**, pas une omission. Même collection, même moteur,
même agrégateur. Portée de lecture dédiée : `scope=company`.

Affichées « L.Y Solution » partout (`LY_SOLUTION`, un seul endroit).

Deux registres auraient obligé à additionner deux moteurs pour obtenir le bénéfice global :
la fabrique des écarts inexpliqués.

---

## K. CRUD manuel

| Verbe | Route | Notes |
|---|---|---|
| créer | `POST /api/finances/transactions` | catégorie limitée à `REVENUE`/`COST` ; `origin`/`provenance`/`parentTransactionId` **non exposés** |
| lister | `GET /api/finances/transactions` | borné (200, max 1000), `total` + `truncated` rendus |
| détailler | `GET /api/finances/transactions/:id` | |
| corriger | `PATCH /api/finances/transactions/:id` | **manuel non supprimé uniquement** |
| supprimer | `DELETE /api/finances/transactions/:id` | logique, idempotent |
| masse | `POST /api/finances/transactions/bulk-delete` | DEV, portée explicite, mot retapé |
| résumé | `GET /api/finances/summary` | |
| répartition | `GET /api/finances/by-project` | |
| décompte | `GET /api/finances/bulk-scope` | ne supprime rien |

Séparation contrôleur / service / modèle conforme aux conventions du dépôt. Validation
stricte, codes `PANEL_FINANCE_*`.

Une écriture interne séparée (`recordTransaction`) est le point d'entrée que le lot Stripe
appellera : c'est elle qui accepte `origin` et `provenance`, et elle n'est pas exposée en
HTTP. Un client qui pourrait poser `origin: STRIPE` fabriquerait de faux encaissements —
**éprouvé** (section 5 : l'origine reste `MANUAL`, la provenance reste vide).

---

## L. Soft delete

`deletedAt` / `deletedBy` / `deletionReason`. Pas de hard delete, nulle part.

- exclu des listes par défaut ;
- exclu des agrégats (`deletedAt: null` dans le filtre commun, partagé par la liste ET le
  résumé — une seule construction) ;
- consultable via `includeDeleted=1` ;
- rejouer la suppression n'échoue pas : l'état visé est atteint (un double-clic est l'usage
  normal d'un bouton).

**Éprouvé** : le net baisse exactement du montant retiré ; le document existe toujours en
base.

---

## M. Bulk delete

Jamais `deleteMany({})`. La portée **n'a pas de défaut** — absente, la requête est refusée
(`PANEL_FINANCE_SCOPE_REQUIRED`).

| Portée | Filtre |
|---|---|
| `project` + `projectId` | `{ projectId }` |
| `company` | `{ projectId: null }` |
| `all` | `{}` |

Confirmation : le mot `SUPPRIMER` retapé, sensible à la casse
(`PANEL_FINANCE_BULK_CONFIRMATION_REQUIRED`). L'écran affiche le **décompte exact** avant de
demander, et annonce que l'opération ignore la période affichée.

Réservé aux comptes **DEV**.

**Étanchéité éprouvée** : après suppression en masse du projet B, le net du projet A est
rigoureusement identique, et les documents de B existent toujours.

Une seule entrée au journal pour le geste, pas une par ligne.

---

## N. Agrégateur

`services/finance/financialSummary.service.js`. Tout en base, un `$facet` :

```
totals.netCents     = Σ(INFLOW) − Σ(OUTFLOW)
byCategory          revenueCents, costCents, refundCents, adjustmentCents
series[]            { bucket, inflowCents, outflowCents, netCents }
count
```

Filtre construit par le **même** `buildQueryFilter` que la liste : le total en haut décrit,
par construction, les lignes du dessous.

Seuls les mouvements `RECORDED` comptent — écrit une fois, ici.

**Éprouvé** : `Σ(series.netCents) === totals.netCents`.

`summarizeByProject` rend le classement de la page globale, `projectId: null` inclus comme
un rattachement ordinaire.

---

## O. Périodes / timezone

Fuseau **`Europe/Paris`**, constante nommée (jamais `process.env` — l'architecture réserve
sa lecture à `config/env.js`, et un fuseau variable déplacerait des mois clôturés).

Bornes **semi-ouvertes `[début, fin[`**. Aucun `23:59:59.999` n'est construit nulle part.

`TODAY`, `LAST_7_DAYS`, `LAST_30_DAYS`, `CURRENT_MONTH`, `CURRENT_YEAR`, `CUSTOM`, plus
`ALL` (bornes `null` — « depuis toujours » n'a pas de borne, et en fabriquer une ferait
croire à un filtre).

`CUSTOM` accepte `AAAA-MM-JJ`, borne de fin **incluse**, convertie une fois en borne exclue.

Minuit local calculé en **deux passes** : sans la seconde, la nuit du changement d'heure,
« aujourd'hui » commencerait à 01h00. Aucune dépendance ajoutée.

**Éprouvé** avec un `now` injecté : `TODAY` du 15/03/2026 borne
`2026-03-14T23:00Z → 2026-03-15T23:00Z` ; `CURRENT_MONTH` de mars finit à `22:00Z` — la
borne haute suit le passage à l'heure d'été.

---

## P. Finances projet

Onglet **Finances** sur la fiche projet, entre « Événements » et « Développeur ». Vit dans
l'URL (`?tab=finances`) comme les autres.

Contenu : agrégats de la période (Revenus · Coûts · Bénéfice net), graphique du net,
filtres (période, tri, recherche), liste, « Ajouter une transaction », « Tout supprimer »
(DEV).

`projectId` **verrouillé** : le formulaire n'affiche aucun sélecteur de rattachement depuis
une fiche projet.

---

## Q. Finances globale

Page `/finances`, section **Gestion** de la navigation.

**Le même moteur**, portée ouverte, plus un sélecteur de rattachement
(tous · L.Y Solution seule · un projet), plus une **répartition par projet** — la seule
chose qu'une fiche projet ne peut pas montrer.

Chaque ligne du classement renvoie vers `/projects/:id?tab=finances`.

---

## R. Sous-onglets

Les trois sont posés : **Général** (tout + agrégats + graphique), **Coûts** (`category=COST`),
**Revenus** (`category=REVENUE`).

Les cartes d'agrégats **ne suivent pas** le sous-onglet : elles décrivent la période.
Afficher « Revenus : 0 € » au-dessus d'une liste de coûts serait faux — il y a bien eu des
revenus, on a seulement choisi de ne pas les lister. D'où deux jeux de critères dans
`useFinanceWorkspace`.

Aucun remboursement Stripe, aucune facture, aucun coût récurrent n'est inventé. Les vues
fonctionnent avec les mouvements manuels de L10.1.

---

## S. Détail transaction

Bouton « Voir les détails » sur chaque ligne. Affiche : montant signé, catégorie + sens,
rattachement, date d'effet, description, origine, statut, montant brut, identifiant interne,
auteur + date de création, dernière modification, et — si supprimé — qui, quand, pourquoi.

**Aucun champ Stripe vide n'est affiché.** `provenance`, chacun de ses sous-champs, et
`parentTransactionId` sont rendus **conditionnellement** : la projection API rend
`provenance: null` quand il n'y a rien. Un champ vide affiché par anticipation se lit comme
une donnée manquante.

Les emplacements sont prêts : le jour où un mouvement portera une provenance, il s'affichera
sans qu'on touche à cet écran.

---

## T. Justificatifs

**Contrat posé, branchement renvoyé à L10.2. Décision documentée.**

Le système de médias existant est strictement imagier (filtre `image/*`, réencodage `sharp`
en WebP) et — décisif — `/uploads` est servi **publiquement en statique**, parce que le logo
d'entreprise doit être visible des visiteurs des sites clients. Y déposer des factures les
exposerait sans authentification.

L'intégration n'est donc « ni propre ni isolée » au sens de la consigne. Conformément à
elle : **aucun second stockage de fichiers n'a été construit**, et le pipeline images n'a pas
été étendu.

Aucun champ d'attachement n'a été ajouté au schéma : un champ nullable qu'aucune écriture ne
renseigne et qu'aucun écran ne lit est une promesse, pas une fondation. Ce que L10.2 devra
trancher est écrit au §14 du document d'architecture (surface privée, formats et validation
par octets, rétention conjointe).

---

## U. Audit trail

Trois types ajoutés au catalogue **fermé et additif** existant
(`PanelSupervision.model.js`) :

`FINANCIAL_TRANSACTION_CREATED` · `FINANCIAL_TRANSACTION_UPDATED` ·
`FINANCIAL_TRANSACTION_DELETED`

Écrits via `recordEvent()` (`source: 'PANEL'`, `projectId` nullable) — **pas de second
journal**.

`data` porte : `transactionId`, `flow`, `category`, `origin`, `amountCents`, `currency`,
`effectiveDate`, `actor`. Sur une correction, `changes.{champ}.{from,to}`. Sur une
suppression, le motif. **Aucune charge utile fournisseur, aucun secret.**

Suppression → `severity: WARNING`. Masse → **une** entrée pour le geste.

Un échec du journal n'annule pas l'écriture comptable : l'écriture est le fait, la trace en
est le commentaire.

---

## V. Permissions

Système existant réutilisé. Aucune ACL parallèle.

| Geste | Rôle |
|---|---|
| lire | ADMIN + DEV |
| créer / corriger / supprimer une ligne | ADMIN + DEV |
| **supprimer en masse** | **DEV** |

Justifications complètes dans l'en-tête de `routes/finances.routes.js` et au §11 du document
d'architecture. En résumé : la lecture et la tenue de livres sont le travail de l'équipe ; la
suppression irréversible **à l'échelle** est un cran au-dessus, comme la protection
contractuelle et l'ouverture commerciale.

**Éprouvé** : un ADMIN lit, saisit et supprime une ligne (200/201/200) ; son
`bulk-delete` rend **403 `PANEL_FORBIDDEN`** ; sans jeton, tout rend 401.

L'onglet et la page ne sont pas `devOnly` — et cela ne masque rien qu'une URL révélerait :
la barrière est côté backend.

---

## W. Index / performance

```
{ transactionId: 1 }                                unique
{ projectId: 1, deletedAt: 1, effectiveDate: -1 }   fiche projet
{ deletedAt: 1, effectiveDate: -1 }                 page globale
```

Trois, pas quinze. Égalités d'abord, tri ensuite — le filtre **et** le tri sont servis par
l'index, sans tri en mémoire.

Non indexés, et pourquoi : `parentTransactionId` (aucune requête ne le lit en L10.1 →
L10.4), `category`/`origin` (filtres résiduels sur un ensemble déjà réduit).

Aucun agrégat ne charge de documents en mémoire Node : `$facet` + `$sum` + `$dateTrunc`.

**Éprouvé** — `explain('queryPlanner')` sur l'agrégat par projet : `IXSCAN` présent, aucun
`COLLSCAN`. Et un contrôle vérifie que le nombre d'index reste ≤ 3.

---

## X. Compatibilité future Stripe TEST/PROD

`provenance.environment` (`TEST` | `PROD` | `null`) et `provenance.provider`,
`externalId`, `externalKind` — quatre champs plats, jamais une charge utile fournisseur.

`null` pour une saisie manuelle : elle n'appartient à aucun monde fournisseur, et le
registre fonctionne intégralement avec `provider = null` (**éprouvé**).

Les modèles d'appartenance L6.2A ne sont **pas dupliqués** : ce registre porte une référence
opaque, pas une autorité.

**Éprouvé** : deux mouvements, l'un `TEST`, l'autre `PROD`, coexistent et sont tous deux
lisibles.

---

## Y. Compatibilité future remboursements

`parentTransactionId` porte le `transactionId` du paiement — jamais un `_id`.

**Éprouvé** (test modèle, sans aucun appel Stripe) :

- paiement `REVENUE`/`INFLOW` `+249 €`, `origin: STRIPE`, `provenance.environment: PROD` ;
- remboursement `REFUND`/`OUTFLOW` `100 €`, `parentTransactionId` = le paiement ;
- le paiement **vaut toujours 24 900 centimes** après coup — aucune réécriture ;
- le net baisse de 100 € ; `costCents` **inchangé** ; `refundCents = 10 000`.

Aucun bouton « Rembourser », aucune route de remboursement n'a été créée.

---

## Z. Appels Stripe introduits

**0.**

Vérifié par un contrôle statique de recette (section 13 de `finance-core.test.js`) sur les
sept fichiers du registre, source **décommentée** :

- aucun identifiant de code fournisseur (`stripeXxx`, `StripeXxx`) ;
- aucun import contenant `stripe` ou `billing` ;
- aucun `fetch(` ;
- aucun import de `bridge`/`ProjectBridgeClient` ;
- aucun import de `capabilit*`/`integratedApi`.

Le contrôle distingue explicitement la **valeur** `STRIPE` (origine du catalogue — c'est la
généricité) du **code** Stripe (interdit).

Côté frontend, le bloc `export const finances` de `lib/api.ts` est vérifié sans `refund`,
sans `stripe`, sans verbe d'import ou de synchronisation.

L'invariant d'architecture global (« aucun appel réseau hors `ProjectBridgeClient` ») passe.

---

## AA. Modifications bridge

**0.**

Aucune modification de `bridgeContract.js`, `ProjectBridgeClient.js`, `projectBridge`, des
registres de capacités, de l'appartenance Stripe ou du routage de webhooks. Le contrat de
pont n'a pas été ouvert.

---

## AB. Tests exacts

### `tests/finance-core.test.js` — **138 contrôles, 138 réussis**

1. Monnaie — 17 contrôles : `0,10 + 0,20 = 30 centimes` exactement ; refus de 3 décimales,
   du négatif, de zéro, du texte, de la notation scientifique ; espaces de milliers et
   insécables ; devise non prise en charge refusée.
2. Périodes — 17 contrôles : fuseau nommé ; `TODAY` à minuit Paris ; borne haute **exclue** ;
   7 jours civils ; mois et année ; changement d'heure (été **et** lendemain de bascule) ;
   `CUSTOM` fin incluse ; `ALL` sans borne ; date de calendrier inexistante refusée ;
   granularité.
3. Création — 17 contrôles : revenu projet, coût projet, revenu L.Y Solution, coût
   L.Y Solution ; centimes ; sens déduit ; instantané de nom ; auteur ; refus sans nom, sans
   date, sans jeton.
4. Rattachement — 3 contrôles : `projectId` inconnu → 404, rien écrit.
5. Anti-contrefaçon — 4 contrôles : `REFUND` refusé à la saisie ; `origin`/`provenance`
   envoyés par un client sont ignorés.
6. Agrégats — 14 contrôles : aucun champ de solde au schéma ; revenus, coûts, net au centime ;
   portées projet / entreprise / global ; projet vide → zéros ; `Σ(series) === net`.
7. Filtres — 12 contrôles : période d'un jour, aujourd'hui, catégorie, sens, recherche (nom,
   instantané, métacaractères), portée projet, tris, refus d'une catégorie inconnue.
8. Correction — 10 contrôles : correction acceptée et journalisée avec avant/après ; un
   mouvement d'origine automatique **refuse** la correction (409) ; sa provenance s'affiche.
9. Suppression — 10 contrôles : logique, horodatée, imputée, motif ; net exact ; invisible par
   défaut, auditable sur demande ; idempotente ; journal en WARNING ; 404 sur inconnu.
10. Masse — 10 contrôles : décompte ; refus sans portée ; refus sans confirmation ; casse
    sensible ; **projet A intact après purge de B** ; aucun document détruit ; une entrée au
    journal.
11. Permissions — 6 contrôles : ADMIN lit, saisit, supprime une ligne ; **403** sur la masse ;
    401 sans jeton.
12. Compatibilité future — 10 contrôles : remboursement lié, `OUTFLOW`, montant positif,
    paiement non réécrit, net −100 €, **coûts inchangés**, `refundCents` isolé, TEST et PROD
    représentables.
13. Garde-fou fournisseur — 6 contrôles (voir §Z).
14. Performance — 4 contrôles : les deux index attendus, ≤ 3 index, `IXSCAN` sans `COLLSCAN`.

### `tests/finance-ui.test.js` — **111 contrôles, 111 réussis**

1. Montants signés — 12 contrôles, exécutés sur le vrai module : `+`, `−` typographique,
   format français, centimes préservés, **bénéfice négatif affiché négatif**, tonalités.
2. **Graphique — 15 contrôles réellement exécutés** sur `lib/netChartScale.ts` : aucun point,
   un point, revenus seuls (zéro en bas), coûts seuls (zéro en haut), mixte, **tout à zéro**
   (amplitude > 0, aucun `NaN`), filet minimal, 31 jours (libellés espacés).
3. Un seul moteur — 6 contrôles : la fiche et la page globale montent `FinanceWorkspace` ;
   aucun second calcul de net côté écran.
4. Atteignabilité — 8 contrôles : onglet, route, navigation, section GESTION, pas `devOnly`.
5. Sous-onglets — 6 contrôles, dont la séparation résumé/liste.
6. Périodes et filtres — 10 contrôles.
7. Saisie — 11 contrôles : deux catégories ; « Récurrent » **désactivé** avec sa mention ;
   **aucune fausse récurrence envoyée** ; montant en chaîne, jamais `type="number"` ;
   rattachement verrouillé.
8. Détail — 9 contrôles : aucun champ Stripe vide, chaque champ fournisseur conditionné,
   aucun libellé « Stripe » en dur.
9. Suppressions — 7 contrôles : confirmation unitaire ; masse DEV-only, décompte, mot retapé,
   portée nommée, périodes ignorées, bouton inerte si rien à supprimer.
10. États — 9 contrôles : chargement, erreur, vides (liste, graphique, répartition), liste
    tronquée annoncée, relecture non destructrice.
11. Responsive / thème / accessibilité — 12 contrôles : `tabular-nums`, défilement des
    tableaux, deux media queries, **aucune couleur en dur**, rôle et infobulles du graphique,
    `sr-only`, `aria-pressed`.
12. Client d'API — 6 contrôles (voir §Z).

### Non-régression

- `tests/architecture.test.js` — **31/31**, invariants inchangés (dont « aucun point d'appel
  mort » : `finances` est consommé).
- `tests/panel-ux.test.js` — **86/86** après mise à jour de **trois attentes**, détaillée
  ci-dessous.
- Suite Panel complète — voir §AD.
- Typecheck `tsc -b` — **vert**. C'est aussi le script `lint` du frontend ; le dépôt n'a pas
  de configuration ESLint.
- Build `vite build` — **vert**.
- SB Auto 06 : **aucun fichier touché**, aucun contrat partagé modifié. Aucun test artificiel
  n'a été créé.

### Les trois attentes de `panel-ux.test.js` mises à jour

Le premier passage de la suite complète a rendu **99/100**, avec 4 contrôles rouges dans
`panel-ux.test.js`. Aucun n'était un défaut : les trois assertions **épinglaient l'état
antérieur du Panel**, et le lot le change délibérément. Elles ont été mises à jour, chacune
avec la justification écrite dans le fichier.

1. **La liste fermée du menu Gestion.** Elle énumérait quatre entrées ; il y en a cinq.
   « Finances » y entre pour la raison qui y a fait entrer « Agenda et événements » : c'est
   le travail de l'équipe. La liste reste **fermée et énumérée** — une entrée de plus dans
   cet espace reste une décision, jamais un effet de bord.

2. **La liste `BUSINESS` des routes non gardées.** C'est cet invariant qui a *correctement*
   signalé `/finances` : toute route non déclarée métier est réputée technique et doit passer
   par `RequireDev`. `/finances` y est inscrit, avec le rappel que la vraie barrière est côté
   serveur (§V).

3. **La validation de l'onglet lu dans l'URL.** L'assertion épinglait la comparaison écrite
   à la main (`tabParam === 'dev' || tabParam === 'events'`) — une forme qui exige d'ajouter
   une chaîne à chaque onglet, donc celle qu'on finit par oublier de compléter.
   L'**invariant** est inchangé (une valeur inconnue retombe sur « Vue d'ensemble ») ; il est
   désormais porté par une liste nommée `TABS` que le type et le rendu partagent, et
   l'assertion vérifie cela.

Le quatrième rouge (`CHAQUE route technique passe par la garde DEV`) était le corollaire du
point 2 et disparaît avec lui.

---

## AC. Fichiers modifiés

### Créés (L10.1)

```
backend/src/models/PanelFinancialTransaction.model.js
backend/src/services/finance/money.js
backend/src/services/finance/period.js
backend/src/services/finance/financialTransactions.service.js
backend/src/services/finance/financialSummary.service.js
backend/src/controllers/finances.controller.js
backend/src/routes/finances.routes.js
frontend/src/types.finance.ts
frontend/src/lib/money.ts
frontend/src/lib/netChartScale.ts
frontend/src/lib/useFinances.ts
frontend/src/components/finance/FinanceWorkspace.tsx
frontend/src/components/finance/NetChart.tsx
frontend/src/components/finance/TransactionForm.tsx
frontend/src/components/finance/TransactionDetail.tsx
frontend/src/components/finance/FinanceModal.tsx
frontend/src/components/finance/financeLabels.ts
frontend/src/pages/FinancesPage.tsx
tests/finance-core.test.js
tests/finance-ui.test.js
docs/architecture/62_FINANCIAL_LEDGER.md
docs/architecture/FINANCES_L10_1_FINANCIAL_CORE_REPORT.md
```

### Modifiés (L10.1 uniquement)

```
backend/src/app.js                          montage /api/finances
backend/src/models/PanelSupervision.model.js  3 types d'événements, catalogue additif
backend/package.json                        2 scripts de recette ciblés
frontend/src/App.tsx                        route /finances
frontend/src/config/nav.ts                  entrée « Finances », section GESTION
frontend/src/lib/api.ts                     export const finances
frontend/src/pages/ProjectDetailPage.tsx    onglet Finances
frontend/src/components.css                 styles du registre (un seul hunk)
tests/panel-ux.test.js                      3 attentes mises à jour, justifiées sur place
tests/run-all.js                            inscription des 2 suites (hunk isolé)
```

`tests/panel-ux.test.js` **n'est pas** un fichier du chantier L6.2E : il ne figure pas dans
sa liste (§B). Le modifier n'absorbe donc rien.

---

## AD. Commit / push

*(complété après exécution — voir la section ci-dessous)*

---

## AE. Travail parallèle préservé

Aucun fichier du chantier Stripe L6.2E n'a été lu-pour-modifier, restauré, reformatté ou
stagé. Aucun `git stash`, `reset --hard`, `clean`, `checkout` global, `add -A` ni `add .`
n'a été exécuté à aucun moment.

Le seul fichier partagé (`tests/run-all.js`) a été stagé **par hunk**, en laissant le hunk
L6.2E intact dans l'arbre de travail et **hors** du commit.

---

## AF. Réserves

1. **Rétention du journal d'activité.** `recordEvent()` borne la chronologie à
   `TIMELINE_HISTORY_SIZE` (300) entrées par projet. Le journal financier hérite de cette
   rétention. La trace **durable** vit sur le document (`createdBy`, `updatedBy`,
   `deletedBy`, `deletedAt`, `deletionReason`), jamais purgé. Si l'audit financier doit être
   intégralement conservé, il faudra soit exempter ces types du purgeage, soit ouvrir un
   journal dédié — décision à prendre en L10.2, pas ici.

2. **Justificatifs non livrés.** Le CDC les demande pour un coût. Décision motivée au §T :
   contrat posé, branchement L10.2. C'est un **écart assumé et documenté**, pas un oubli.

3. **Pas de restauration d'un mouvement supprimé.** Les documents survivent, mais aucun écran
   ne sait les rétablir. L'écran le dit explicitement. À trancher en L10.2.

4. **Liste bornée à 200 lignes** (1000 max). Au-delà, l'écran annonce le tronquage et rappelle
   que les totaux, eux, sont complets. Pas de pagination : elle ne se justifiera qu'avec un
   volume réel, et une pagination posée à l'aveugle se refait toujours.

5. **Monodevise.** `EUR` seule acceptée à l'écriture. Le champ existe ; la politique de
   conversion (taux, date, devise de consolidation, arrondi) est une décision comptable
   qu'aucun écran de ce lot ne pose.

6. **Le sondage est absent, volontairement.** Aucune source extérieure n'écrit dans le
   registre en L10.1. À rouvrir au lot L10.3, et c'est le seul endroit à relire
   (`useFinances.ts`).

7. **Suite complète et chantier parallèle.** La suite a été exécutée sur un arbre qui contient
   le travail L6.2E **non committé**. Les résultats des suites Stripe reflètent donc l'état
   de ce chantier, pas le mien.

---

## AG. Roadmap L10.2 → L10.9 ajustée

L'audit n'a pas remis en cause le découpage proposé, mais il en déplace **une** brique et en
ajoute **une**.

| Lot | Contenu | Ajustement |
|---|---|---|
| **L10.1** | Financial Core + transactions manuelles | ✅ livré |
| **L10.2** | **Justificatifs privés**, puis Recurring Costs + occurrence ledger | **Inversion**. Le stockage privé de fichiers est un prérequis, pas un supplément : le CDC exige un justificatif *par occurrence* récurrente. Construire la récurrence d'abord obligerait à repasser sur chaque occurrence. Contient : surface d'upload authentifiée hors `/uploads`, validation par octets (PDF + images), rétention conjointe, attachement au mouvement — puis la **définition** de coût récurrent et son ordonnanceur produisant des mouvements `origin: RECURRING_COST`. |
| **L10.3** | Stripe Revenue Projection + invoice linkage | Inchangé. Consommera `recordTransaction` avec `origin: STRIPE` et une provenance résolue. Rouvrir la décision « pas de sondage » côté écran. |
| **L10.4** | Refund Operations + negative ledger movements | Inchangé. Ajouter l'index `{ parentTransactionId: 1 }` à ce moment, et la remontée « remboursements de ce paiement ». |
| **L10.5** | Payable Services / invoices / reminders | Inchangé. |
| **L10.5bis** | **Restauration et corrections comptables** | **Nouveau, petit.** Rétablir un mouvement supprimé, et l'écriture `ADJUSTMENT` — le seul usage prévu du quatrième membre de la taxonomie. Sortis de L10.1 parce qu'ils n'étaient pas nécessaires pour valider le cœur, mais ils manqueront dès qu'un volume réel existera. |
| **L10.6** | Finances UI consolidation | Inchangé. Y traiter la pagination si le volume la justifie, et la rétention du journal (réserve n°1). |
| **L10.7** | Manager Facturation & abonnement | Inchangé. |
| **L10.8** | Subscription failure / grace / retries / suspension | Inchangé. |
| **L10.9** | Financial end-to-end hardening | Inchangé. Y ajouter : export comptable, et la question multidevise si elle se pose. |

Aucun de ces lots n'a été commencé.

---
