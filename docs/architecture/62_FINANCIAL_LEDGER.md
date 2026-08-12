# 62 — REGISTRE FINANCIER

> Lot **L10.1**. Fondation indépendante de tout fournisseur.
> Le branchement Stripe arrive au lot L10.3, sur cette fondation, sans la modifier.

---

## 1. Ce que le registre est

Un **mouvement financier** est un FAIT daté : de l'argent est entré, ou de l'argent est
sorti. Ni un solde, ni une facture, ni un abonnement, ni un paiement Stripe. Ces
choses-là *produiront* des mouvements ; elles ne sont pas des mouvements.

Une seule collection : `panelfinancialtransactions`.
Un seul agrégateur : `services/finance/financialSummary.service.js`.
Un seul écran-moteur : `components/finance/FinanceWorkspace.tsx`.

La fiche projet et la page Finances globale montent **le même** moteur, avec une portée
différente. Il n'existe pas de « registre projet » et de « registre global ».

---

## 2. Il n'y a pas de champ `profit`

Le bénéfice se **calcule** depuis les mouvements actifs, à la demande, pour une période
donnée :

```
net = Σ(INFLOW) − Σ(OUTFLOW)
```

Un champ modifiable qui porterait le résultat serait une seconde vérité. Le jour où il
diverge de la somme des lignes — et il diverge toujours — plus personne ne sait laquelle
croire. Aucune écriture du Panel ne mute un total.

---

## 3. Taxonomie : deux axes orthogonaux

C'est la décision structurante du lot.

| Axe | Valeurs | Ce qu'il décide |
|---|---|---|
| `flow` | `INFLOW` · `OUTFLOW` | le **signe** dans le net (trésorerie) |
| `category` | `REVENUE` · `COST` · `REFUND` · `ADJUSTMENT` | le **total** dans lequel la ligne est comptée (nature comptable) |

### Pourquoi pas un seul axe `direction = REVENUE | COST`

Il suffit aujourd'hui, et il condamne le lot L10.4.

Un paiement de 249 € remboursé de 100 € doit produire un net de **+149 €**. Avec un seul
axe, le remboursement devrait être enregistré en `COST` — et le tableau « coûts
d'exploitation » afficherait alors 100 € de charges que l'entreprise n'a jamais
supportées. Rendre un acompte n'est pas une dépense : c'est du chiffre d'affaires qui
s'annule.

Un tel modèle ne ment pas sur le net ; il ment sur la marge, sur le compte de résultat, et
sur tout ce qu'on voudra en tirer.

### Combinaisons valides

| `category` | `flow` imposé | Exemple |
|---|---|---|
| `REVENUE` | `INFLOW` | une vente, un abonnement encaissé |
| `COST` | `OUTFLOW` | hébergement, licence, prestataire |
| `REFUND` | `OUTFLOW` | remboursement — **n'est pas un coût** |
| `ADJUSTMENT` | libre | correction assumée |

La contrainte croisée est vérifiée à l'écriture (`resolveTaxonomy`) : le schéma Mongoose
sait valider chaque champ isolément, il ne sait pas dire qu'un `REVENUE` en `OUTFLOW` est
absurde.

### L'utilisateur ne voit que deux choix

L'écran propose « Revenu » et « Coût ». Le second axe n'apparaît nulle part : il n'a rien
à demander tant qu'aucune source automatique n'écrit dans le registre. La robustesse est
dans le modèle, la simplicité dans la saisie.

`REFUND` et `ADJUSTMENT` sont **refusés à la saisie manuelle** — un remboursement se
rattache à un paiement, et ce paiement n'existe pas encore dans le registre.

---

## 4. Monnaie : centimes entiers

Aucune primitive monétaire n'existait dans le Panel avant ce lot. Les seuls montants du
code sont ceux que Stripe *décrit* dans ses contrats de lecture (`amountDue`,
`unit_amount`) : des champs de fournisseur validés à la frontière, jamais une convention
du Panel. Il n'y avait donc rien à réutiliser.

**Un montant persisté est un entier de centimes.** Jamais un flottant.

```
0,10 € + 0,20 €  →  10 + 20 = 30 centimes
```

et non `0.1 + 0.2 === 0.30000000000000004`.

### Pourquoi les centimes et non les micros

Rien ici ne se divise : on enregistre des mouvements de trésorerie, chacun égal à ce qui a
réellement quitté ou rejoint un compte. Et une transaction Stripe arrivera **déjà** en
unités mineures : la correspondance sera l'identité, sans division, donc sans arrondi.

### La saisie n'est pas un calcul

`parseAmountToCents` lit une chaîne, chiffre par chiffre. Elle ne multiplie jamais par
cent — `Math.round(1.005 * 100)` vaut 100, pas 101. Une saisie à trois décimales est
**refusée**, jamais arrondie en silence.

Le montant est **toujours positif**. Le sens est porté par `flow`. Deux porteurs du même
sens finissent toujours par se contredire.

### Devise

`EUR` canonique. Le champ `currency` existe pour que la question puisse être rouverte sans
migration, mais une seule valeur est acceptée à l'écriture, et les agrégats ne somment
jamais deux devises.

---

## 5. Périodes : fuseau nommé, bornes semi-ouvertes

Fuseau comptable : **`Europe/Paris`**, constante nommée. Ni celui du serveur, ni celui du
navigateur. Déplacer le VPS ne déplacera jamais un mois comptable.

Bornes **semi-ouvertes** `[début, fin[`. Aucun `23:59:59.999` n'est construit nulle part :
c'est la source classique de deux défauts opposés — une transaction qui disparaît d'un
mois sans apparaître dans l'autre, et une borne recopiée en `<=` qui compte le premier jour
du mois suivant. Avec `début <= t < fin`, chaque instant appartient à exactement une
période, **par construction et non par vigilance**.

| Période | Bornes |
|---|---|
| `TODAY` | `[minuit local, minuit suivant[` |
| `LAST_7_DAYS` | 7 jours civils, aujourd'hui compris |
| `LAST_30_DAYS` | 30 jours civils, aujourd'hui compris |
| `CURRENT_MONTH` | du 1er au 1er suivant |
| `CURRENT_YEAR` | du 1er janvier au 1er janvier suivant |
| `CUSTOM` | `start` .. `end` **inclus** (converti en borne exclue) |
| `ALL` | aucune borne (`null` / `null`) |

Le calcul de minuit local se fait en **deux passes** (`startOfLocalDay`) : le décalage à
retirer est celui qui règne au moment cible, pas au moment de départ. Sans la seconde
passe, la nuit du passage à l'heure d'hiver, « aujourd'hui » commencerait à 01h00.

Aucune dépendance : `Intl.DateTimeFormat` connaît la base IANA embarquée dans Node.

---

## 6. Rattachement

```
projectId renseigné  →  mouvement d'un projet client
projectId = null     →  mouvement propre à L.Y Solution
```

`null` n'est pas un défaut ni un oubli : c'est le rattachement à l'entreprise elle-même.
Frais de structure, abonnements outils, revenus hors projet vivent là — et dans le **même**
registre, sinon le bénéfice global exigerait d'additionner deux moteurs.

Un `projectId` renseigné **doit exister au registre des projets**. Sans ce contrôle, une
faute de frappe créerait un mouvement rattaché à un projet fantôme : invisible sur toutes
les fiches, et pourtant compté dans le bénéfice global.

### `projectNameSnapshot`

Instantané du nom au moment de la saisie, **pour l'audit, jamais pour la jointure**. Un
projet est renommé, ou retiré du registre. Sans instantané, une ligne de 2 400 € désignerait
un identifiant dont plus rien ne dit à qui il correspondait.

Précédent dans le Panel : `PanelProjectEvent.projectName`, `PanelContractAction.projectName`.

`projectId` reste la **seule** autorité : aucun filtre, aucun agrégat, aucune permission ne
s'appuie sur l'instantané. L'affichage préfère toujours le nom vivant du registre et ne
retombe sur l'instantané que si la fiche a disparu.

---

## 7. Provenance et origines

`origin` dit **quel mécanisme** a produit le mouvement :

`MANUAL` · `STRIPE` · `RECURRING_COST` · `INVOICE` · `IMPORT`

Seul `MANUAL` est écrit par L10.1 — le service **refuse** toute autre origine venant d'un
client HTTP. Un navigateur qui pourrait poser `origin: STRIPE` fabriquerait des revenus
indiscernables de vrais encaissements.

`provenance` est volontairement **maigre** : quatre champs plats
(`provider`, `environment`, `externalId`, `externalKind`), tous nuls pour un mouvement
manuel. Aucune charge utile fournisseur, aucun objet Stripe recopié, aucun secret. Une
structure non validée qui s'installe dans un modèle métier devient, en deux lots, le schéma
de fait.

`environment` (`TEST` | `PROD`) est présent dès maintenant : un registre financier se relit
des années plus tard, parfois après une reprise de base, et un mouvement qui ne dit pas
d'où il vient n'est plus auditable.

**Aucun modèle d'appartenance n'est dupliqué.** Le lien « cette ressource Stripe appartient
à ce projet » existe déjà (L6.2A) et appartient au chantier Stripe. Ce registre porte une
référence *opaque*, pas une autorité.

---

## 8. Remboursements futurs

`parentTransactionId` porte le `transactionId` du mouvement d'origine — jamais un `_id`,
pour qu'une reprise de base ne casse pas le lien.

Doctrine :

```
paiement       +249 €   REVENUE / INFLOW    reste +249 € POUR TOUJOURS
remboursement  −100 €   REFUND  / OUTFLOW   parentTransactionId = paiement
────────────────────────────────────────────────────────────────────────
net                                          +149 €
```

Le net tombe à 149 € **par addition, jamais par mutation**. Et `byCategory.costCents` ne
bouge pas d'un centime.

L10.1 n'appelle pas Stripe et n'implémente aucun bouton « Rembourser ». Il garantit
seulement que la doctrine restera possible.

---

## 9. Statuts et agrégation

`RECORDED` (défaut) · `PENDING` · `FAILED` · `CANCELLED`.

L10.1 ne produit que `RECORDED`. **Les agrégats ne comptent que `RECORDED`** — écrit une
fois, dans l'agrégateur. Un paiement Stripe autorisé mais non capturé ne gonflera jamais un
bénéfice, sans qu'aucun écran n'ait à s'en souvenir.

L'agrégation est faite **en base** (`$facet` : totaux par sens, totaux par catégorie, série
du graphique par `$dateTrunc` avec `timezone`). Un seul aller-retour, donc le même ensemble
de lignes pour le total et pour le graphique.

Lire les mouvements pour les additionner en Node rendrait le coût d'un écran d'accueil
proportionnel à l'ancienneté de l'entreprise.

---

## 10. Immutabilité et suppression

| Origine | Modifiable ? |
|---|---|
| `MANUAL` | oui, tant qu'il n'est pas supprimé |
| toute autre | **non** — il constate un fait externe |

La distinction est posée **maintenant**, avant qu'aucune source automatique n'existe : elle
serait impossible à introduire après coup sans casser des écrans.

Chaque correction sensible (montant, catégorie, date d'effet, rattachement) part au journal
avec son **avant** et son **après**.

### Suppression logique

`deletedAt` · `deletedBy` · `deletionReason`. La ligne quitte les listes et les agrégats ;
le document reste. Une pièce comptable supprimée reste une pièce comptable.

### « Tout supprimer »

Jamais `deleteMany({})`. La portée **n'a pas de valeur par défaut** : une requête qui ne la
précise pas est refusée.

| Portée | Filtre |
|---|---|
| `project` + `projectId` | `{ projectId }` — et rien d'autre |
| `company` | `{ projectId: null }` |
| `all` | tout le registre |

Depuis la fiche du projet A, aucune combinaison de paramètres n'atteint le projet B : ce
n'est pas un contrôle *ajouté* au filtre, c'est **le** filtre.

La confirmation est un mot retapé (`SUPPRIMER`, sensible à la casse), et l'écran annonce le
**décompte exact** avant de la demander. L'opération ignore la période affichée — effacer
« ce qu'on voit » ferait dépendre le résultat du filtre en cours — et la phrase le dit.

---

## 11. Permissions

Le Panel a deux rôles, `ADMIN` et `DEV` (surensemble). Aucune ACL parallèle n'est créée.

| Geste | Qui |
|---|---|
| lire (liste, détail, résumé, répartition) | tout compte du Panel |
| créer, corriger, supprimer une ligne | tout compte du Panel |
| **supprimer en masse** | **DEV uniquement** |

**Lecture ouverte** : les finances d'un projet sont la donnée de gestion par excellence. La
réserver aux DEV ferait de la personne qui écrit le code la seule à pouvoir lire le chiffre
d'affaires.

**Écriture unitaire ouverte** : saisir un coût est une écriture de tenue de livres. La
réserver aux DEV obligerait à passer par un développeur pour enregistrer une facture
d'hébergement, et le registre finirait tenu dans un tableur.

**Masse réservée** : c'est le seul geste irréversible *à l'échelle*. Une suppression
unitaire se rattrape en resaisissant ; « tout supprimer » retire des centaines de mouvements
que personne ne reconstituera de mémoire.

Chaque écriture porte son auteur et part au journal : l'ouverture s'accompagne d'une
imputabilité, elle ne s'y substitue pas.

---

## 12. Journal d'activité

Les trois événements sont écrits dans la chronologie **existante** (`PanelEvent`,
`source: 'PANEL'`, `projectId` nullable) — pas dans un second journal que personne
n'ouvrirait :

- `FINANCIAL_TRANSACTION_CREATED`
- `FINANCIAL_TRANSACTION_UPDATED` (avec `changes.{champ}.{from,to}`)
- `FINANCIAL_TRANSACTION_DELETED` (`severity: WARNING`)

Leur `data` porte : identifiant, taxonomie, montant en centimes, origine, acteur. **Jamais**
de charge utile fournisseur, jamais de secret.

Une suppression en masse laisse **une** entrée pour le geste, pas une par ligne : c'est la
décision qui est imputable.

Si le journal échoue, le mouvement reste écrit : l'écriture est le fait, la trace en est le
commentaire.

> **Réserve** — `recordEvent` borne la chronologie à `TIMELINE_HISTORY_SIZE` (300) entrées
> par projet. Le journal financier hérite donc de cette rétention. La trace *durable* d'un
> mouvement vit sur le document lui-même (`createdBy`, `updatedBy`, `deletedBy`,
> `deletedAt`, `deletionReason`), qui n'est jamais purgé.

---

## 13. Index

Trois, et chacun sert une requête réellement écrite.

```
{ transactionId: 1 }                              unique — identité publique
{ projectId: 1, deletedAt: 1, effectiveDate: -1 } la fiche projet
{ deletedAt: 1, effectiveDate: -1 }               la page globale
```

Égalités d'abord, tri ensuite : c'est ce qui permet de servir le filtre **et** le tri sans
tri en mémoire.

Ce qui n'est **pas** indexé, et pourquoi :

- `parentTransactionId` — aucune requête ne le lit en L10.1. L'index viendra avec le lot qui
  remonte les remboursements d'un paiement (L10.4).
- `category` / `origin` — filtres résiduels sur un ensemble déjà réduit par le projet et la
  période. Les indexer coûterait à chaque écriture pour un gain nul à cette échelle.

---

## 14. Ce que ce lot n'a PAS fait

Aucun appel Stripe. Aucune modification de `bridgeContract`, `projectBridge`, des registres
de capacités, de l'appartenance Stripe ou du routage de webhooks. Aucun second stockage de
fichiers.

Hors lot, explicitement : coûts récurrents et leur ordonnanceur, import Stripe,
remboursements, factures, prestations facturées, relances, page Manager, délai de grâce,
retries et suspension d'abonnement.

### Justificatifs — décision

Le système de médias du Panel (`PanelMedia`, `upload.service.js`) est **strictement
imagier** : filtre `image/*`, réencodage `sharp` en WebP, politique de dimensions,
publication vers le parc. Un justificatif de coût est typiquement un **PDF de facture**.

Décisif : `/uploads` est servi en **statique et publiquement** (le logo d'entreprise doit
être visible des visiteurs des sites clients). Y déposer des factures les exposerait sans
authentification.

Réutiliser ce système n'est donc ni propre ni isolé. Conformément à la consigne, L10.1
**ne construit pas un second stockage** et **n'étend pas** le pipeline images. Le contrat est
posé côté modèle — un justificatif sera une référence d'attachement portée par le mouvement —
et le branchement est renvoyé au lot **L10.2**, qui devra d'abord trancher :

1. une surface d'upload **privée** (authentifiée, hors `/uploads`) ;
2. le format accepté (PDF, images) et sa validation par octets ;
3. la rétention et la suppression conjointe avec le mouvement.

Aucun champ d'attachement n'a été ajouté au schéma : un champ nullable qu'aucune écriture ne
renseigne et qu'aucun écran ne lit est une promesse, pas une fondation.

---

## 15. Fichiers

**Backend**

```
models/PanelFinancialTransaction.model.js       le modèle canonique
services/finance/money.js                       centimes entiers, saisie refusée plutôt qu'arrondie
services/finance/period.js                      bornes semi-ouvertes, Europe/Paris, deux passes
services/finance/financialTransactions.service.js  CRUD, portées, journal
services/finance/financialSummary.service.js    agrégats et série, en base
controllers/finances.controller.js
routes/finances.routes.js                       montée sur /api/finances
```

**Frontend**

```
types.finance.ts
lib/money.ts                                    le SEUL endroit qui divise par cent
lib/netChartScale.ts                            l'échelle du graphique — module PUR, testé
lib/useFinances.ts                              résumé + liste, ensemble ou jamais
components/finance/FinanceWorkspace.tsx         LE moteur, monté deux fois
components/finance/NetChart.tsx
components/finance/TransactionForm.tsx
components/finance/TransactionDetail.tsx
components/finance/FinanceModal.tsx
components/finance/financeLabels.ts
pages/FinancesPage.tsx                          la page globale
```

**Recette**

```
tests/finance-core.test.js    138 contrôles — noyau, monnaie, périodes, portées, garde-fou
tests/finance-ui.test.js      111 contrôles — interface, dont les 5 états dégénérés du graphique
```
