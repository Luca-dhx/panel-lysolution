# 62 — REGISTRE FINANCIER

> Lots **L10.1** (fondation), **L10.2** (coûts récurrents, justificatifs privés),
> **L10.3** (projection des revenus Stripe) et **L10.4** (remboursements Stripe).
> Le registre est resté indépendant de tout fournisseur : Stripe est une ORIGINE, jamais
> une catégorie. Les deux lots fournisseur se sont branchés sur la fondation de L10.1 sans
> en modifier un seul axe.

---

## 0. Ce que L10.2 a ajouté — en une page

| | |
|---|---|
| **Une règle n'est pas un mouvement** | `PanelRecurringCost` décrit ce qui se répétera ; `PanelFinancialTransaction` enregistre ce qui a eu lieu. Rien n'est projeté à l'affichage. |
| **Calendrier ancré** | 31 janvier → 28 février → **31 mars**. Le jour d'ancrage est restauré, jamais perdu. |
| **Idempotence en base** | index unique `{sourceId, cycleKey}`. Huit matérialiseurs simultanés produisent une seule ligne. |
| **Convergence sans cron** | la matérialisation a lieu à chaque LECTURE financière. L'ordonnanceur n'est qu'une commodité. |
| **Trois modes de modification** | `NEXT`, `CURRENT`, `FROM_START` — chacun avec un cycle d'effet calculé, jamais un défaut. |
| **Deux modes d'arrêt** | `NEXT` garde le cycle courant, `CURRENT` le retire des totaux par suppression logique. |
| **Justificatif par occurrence** | attaché au mouvement, jamais à la règle. |
| **Média privé** | `visibility: PRIVATE` ajouté au protocole Media existant. Stockage sous `storage/media/`, servi par personne, lu par une route authentifiée. |

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

## 8. Remboursements — la doctrine

> Posée en L10.1, **implémentée en L10.4**. Elle n'a pas eu à bouger d'une ligne : c'est le
> meilleur signe que les deux axes de la taxonomie étaient les bons. Voir § 13 quinquies
> pour le mécanisme.

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

L10.1 n'appelait pas Stripe et n'implémentait aucun bouton « Rembourser ». Il garantissait
seulement que la doctrine resterait possible. **L10.4 l'a exercée telle quelle** : le bouton
existe, il produit exactement ces deux lignes, et l'encaissement d'origine n'est jamais
touché.

L'état du paiement — non remboursé, partiellement, totalement — n'est **stocké nulle part**.
Il se calcule en sommant les enfants à la lecture. Un solde stocké se désynchronise à la
première écriture arrivée par une voie imprévue ; une somme d'écritures ne le peut pas,
puisqu'elle EST le registre.

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

## 13 bis. COÛTS RÉCURRENTS (L10.2)

### La doctrine, en trois lignes

```
RecurringCost  « Brevo, 49 €, tous les mois, depuis le 01/08 »   ← une RÈGLE
        ↓ génère, une fois par échéance
FinancialTransaction  01/08 −49 €   01/09 −49 €   01/10 −49 €    ← des MOUVEMENTS
```

Chaque ligne du bas existe **vraiment** dans le ledger. Aucune n'est recalculée à
l'affichage. Trois raisons, et une seule suffirait :

- un justificatif s'attache à une **occurrence** — une projection n'a pas d'identité à
  laquelle accrocher la facture d'août ;
- modifier le montant réécrirait le passé en silence : le bilan de l'an dernier changerait
  parce qu'un abonnement a augmenté aujourd'hui ;
- un cycle annulé n'aurait aucun endroit où être annulé.

### Le calendrier : ancrage, pas report

`1 MONTH ≠ 30 DAYS`. `1 YEAR ≠ 365 DAYS`. La progression est **calendaire**, dans
`Europe/Paris` — le même calendrier que les périodes, délibérément.

Chaque échéance est calculée **depuis l'ancre**, jamais depuis la précédente :

| | report (✗) | ancrage (✓) |
|---|---|---|
| 31 jan | 31 jan | 31 jan |
| +1 mois | 28 fév | 28 fév |
| +2 mois | **28 mars** | **31 mars** |
| +3 mois | 28 avril | 30 avril |

Le report perd le 31 pour toujours à cause d'un seul mois court. L'ancrage le restaure dès
que le mois le permet. Idem pour le 29 février : 2025, 2026, 2027 → 28 fév ; 2028 → **29 fév**.

Conséquence : `cycleDateAt(n)` ne dépend que de l'ancre et de `n`. Elle est rejouable à
l'identique après n'importe quelle interruption — c'est ce dont l'idempotence a besoin.

### L'identité d'une occurrence

```
cycleKey = AAAA-MM-JJ      le jour local de l'échéance
sourceId = recurringCostId la règle
```

Index **unique partiel** `{sourceId, cycleKey}` sur le ledger. La garantie est en base, pas
dans le code : un `findOne` suivi d'un `create` laisse passer deux requêtes qui se croisent
entre les deux instructions.

Le filtre partiel ne retient que les documents portant les deux champs — les saisies
manuelles (`null, null`) sont hors index, sinon elles entreraient toutes en collision.

**Il couvre aussi les occurrences supprimées.** Un cycle annulé garde sa clé occupée : le
matérialiseur ne peut pas le recréer. Filtrer sur les vivants aurait fait ressusciter, à la
première relecture, le coût que l'utilisateur venait de retirer.

### Rattrapage

`dueCycles({ startAt, recurrence, now, fromCycleKey, untilCycleKey })` rend **tous** les
cycles échus, du plus ancien au plus récent, chacun à sa vraie date. Quatre mois d'arrêt
produisent **quatre lignes**, jamais une seule compressée.

Borne : `MAX_CATCHUP_CYCLES = 600`. Au-delà, on s'arrête et l'on rend `overflow: true` avec
le nombre restant — **jamais un abandon silencieux**. Les cycles restants sont matérialisés
au passage suivant, et le journal du serveur le dit.

### Convergence — et pourquoi il n'y a pas de cron obligatoire

La matérialisation est déclenchée à **trois** endroits, dont un seul est la garantie :

1. **à chaque lecture financière** (`/summary`, `/transactions`, `/by-project`,
   `/recurring-costs`) — ce que quelqu'un regarde est à jour au moment où il le regarde ;
2. au **démarrage** du serveur, puis toutes les heures (`recurringCostScheduler`) ;
3. explicitement, par la recette.

Un ordonnanceur qui serait la seule source transformerait une minute d'indisponibilité à
minuit en un mois manquant. Ici, il n'écrit rien que la première lecture n'aurait écrit.

### Versions effectives

`amountCents` **n'est pas** un champ de la règle. La règle porte une suite de révisions
**append-only** :

```
révision 1 · à partir de 2026-08-01 · 49 €
révision 2 · à partir de 2026-10-01 · 59 €
```

`resolveEffectiveRevision(def, cycleKey)` est une fonction **pure** : « quel montant pour
octobre ? » a une réponse unique, calculable, identique pour tout le monde et six mois plus
tard.

### Les trois modes de modification

Exemple : mensuel ancré au 1er août, nous sommes le 15 septembre, août et septembre existent.

| Mode | Cycle d'effet | août | sept. | oct. + | Occurrences touchées |
|---|---|---|---|---|---|
| `NEXT` — « prochaine récurrence » | 2026-10-01 | 49 | 49 | **59** | aucune |
| `CURRENT` — « récurrence précédente » | 2026-09-01 | 49 | **59** | **59** | septembre |
| `FROM_START` — « depuis le début » | 2026-08-01 | **59** | **59** | **59** | toutes les vivantes |

> **« Précédente » désigne le cycle COURANT.** Le 15 septembre, la « récurrence précédente »
> est la dernière ligne apparue dans le livret — celle du 1er septembre. Le mot invite à
> comprendre l'inverse ; l'écran l'explicite.

**La révision d'une occurrence est une MISE À JOUR**, jamais un supprimer/recréer. Sont
conservés : l'identifiant, la date de cycle, la date de création, l'auteur d'origine, et
**le justificatif**. C'est le point qu'un supprimer/recréer aurait détruit sans bruit.

Les occurrences **annulées** ne sont pas révisées : elles constatent ce qui a été retiré, à
la valeur qu'il avait alors.

Une révision qui ne change rien n'est pas écrite — elle polluerait l'historique d'une
décision qui n'en est pas une.

### Les deux modes d'arrêt

| Mode | Borne | Cycle courant | Cycles suivants |
|---|---|---|---|
| `NEXT` — « prochaine » | cycle courant | **reste** dans les totaux | jamais produits |
| `CURRENT` — « actuelle » | cycle courant | **retiré** des totaux (suppression logique) | jamais produits |

Dans les deux cas la borne est inscrite dans `effectiveUntilCycleKey`, **à la source** : le
matérialiseur ne calcule même plus les cycles au-delà. Une borne appliquée seulement à
l'affichage aurait laissé la génération continuer, et une reprise après panne aurait
ressuscité ce qu'on croyait arrêté.

Un arrêt demandé avant la première échéance pose la sentinelle `NO_CYCLE` (`0000-00-00`) :
la règle ne produira jamais rien.

### Une règle arrêtée est immuable

Décision **énoncée**, pas subie. Rouvrir une règle arrêtée obligerait à décider ce que
deviennent les cycles écoulés depuis l'arrêt — des trous ? un rattrapage rétroactif ? — et
toute réponse implicite serait une surprise. Pour reprendre un abonnement, on en crée un
nouveau, avec sa propre ancre. Rien n'est perdu, tout reste lisible.

### « Tout supprimer » n'arrête aucune récurrence

Vider le ledger ne touche pas aux règles. La conséquence est contre-intuitive — les règles
actives continueront de produire — donc elle est **annoncée avant le clic** :
`countBulkScope` rend `activeRecurringCosts`, et la modale le dit.

Les occurrences passées ne ressuscitent pas : leur clé de cycle reste occupée.

---

## 13 ter. JUSTIFICATIFS PRIVÉS (L10.2)

### Ce qui manquait n'était pas un service de fichiers — c'était un champ

Le protocole Media du Panel savait déjà : nommer un objet par son empreinte, mesurer un
fichier, le décrire (`PanelMedia`), l'attacher à un environnement, le transférer au
déploiement et le publier. Il ne savait qu'une chose : **tout média est public**.

Écrire un `FinancialFileService` aurait produit une seconde pile — deux façons de nommer,
deux façons d'empreinter, deux dossiers à sauvegarder — et une troisième le jour où un
contrat aurait eu le même besoin. On a donc ajouté à `PanelMedia` :

```
visibility        PUBLIC | PRIVATE     (défaut PUBLIC — aucune reprise nécessaire)
originalFilename  le nom déposé, pour le Content-Disposition — JAMAIS un chemin
```

et un module `privateMedia.service.js` qui réutilise `objectKeyFor`, `sha256Of`,
`registerMedia` et `config.paths`. Trois différences avec un média public, et trois seulement :

1. **pas de réencodage** — un logo est converti en WebP ; une facture est stockée octet pour
   octet, sinon son empreinte ne prouve plus rien ;
2. **un autre dossier** — `storage/media/`, jamais `uploads/` ;
3. **jamais publié** — exclu de `publishPanelMediaOnDestination`.

### Pourquoi `storage/` et pas `uploads/`

| | `uploads/` | `storage/` |
|---|---|---|
| `express.static` | **oui** | non |
| bloc `location` Nginx | **`/uploads/`** | aucun |
| lien persistant au déploiement | `shared/uploads` | `shared/storage` |
| exclu de l'artefact de build | oui | oui |

Cacher une facture dans `uploads/prive/` ne l'aurait protégée de rien : l'adresse serait
restée devinable. `shared/storage/contracts` était déjà le précédent des documents
contractuels — on suit le même chemin.

### Localhost et déployé : un seul chemin de code

`config.paths.privateMedia` vaut `<backend>/storage/media` **dans les deux cas**. Sur une
instance déployée, `<backend>/storage` est un lien symbolique vers `shared/storage`, posé à
chaque release par le pipeline.

Il n'existe **aucun** `if (localhost)` dans la couche Media ni dans le code financier — un
contrôle de recette l'interdit. La couche Media absorbe la différence ; le domaine métier ne
la voit jamais.

**Survie au redéploiement**, prouvée sur la configuration réelle (trois faits, il faut les
trois) :

1. `pipeline.js` : `ln -sfn ${sharedRoot}/storage ${backendDir}/storage` à chaque release ;
2. `build.js` : `storage` figure dans `BACKEND_EXCLUDE_DIRS` — rien ne l'écrase ;
3. `nginx.js` : aucun bloc `location /storage`.

> **Limite assumée.** Un justificatif déposé en local reste en local ; il n'est pas migré
> vers le serveur au déploiement. C'est cohérent : la transaction qu'il justifie vit dans la
> base de cette instance et ne voyage pas davantage. En exploitation, les pièces sont
> déposées depuis l'instance déployée.

### Validation : les octets, jamais l'extension

`documentValidation.js` lit les **signatures** : `%PDF-`, `\x89PNG\r\n\x1a\n`, `\xff\xd8\xff`,
`RIFF…WEBP`, `ftyp…heic`. Un exécutable ou du HTML renommé `.pdf` est refusé en **415**.

L'extension de **stockage** est déduite du type mesuré. Le nom déposé ne sert qu'au
`Content-Disposition` — jamais à écrire sur le disque.

**SVG est exclu** des justificatifs alors qu'il est accepté pour les images publiques : un
SVG est un document XML qui peut porter du script, et un justificatif se télécharge.

Deux défauts réels corrigés au passage :

- **le nom accentué arrivait mangé.** `busboy` décode les paramètres multipart en latin-1 ;
  « Facture Août.pdf » devenait « Facture AoÃ»t.pdf » — systématiquement, en français.
  `decodeUploadFilename` le remet dans son encodage, de façon conditionnelle (si le résultat
  n'est pas de l'UTF-8 valide, on garde l'original) ;
- **il repartait mangé.** Un en-tête HTTP transporte des octets latin-1. Le téléchargement
  émet donc les deux formes de la RFC 6266 : `filename` (repli ASCII) et
  `filename*=UTF-8''…`.

### Lecture : par la transaction, jamais par le média

```
GET /api/finances/transactions/:transactionId/receipt
```

On aurait pu exposer `/api/media/private/:mediaId`. Cette surface ne peut être autorisée que
par une table d'ACL parallèle : un média, seul, ne sait pas à qui il appartient.

Ici le **chemin porte le contexte**. On charge la transaction, on vérifie que le document
demandé est bien le sien (`assertBelongsTo`), et l'autorisation devient une conséquence de
l'objet métier. Un `mediaId` récupéré ailleurs ne mène nulle part.

La couche Media porte les **octets et le descripteur** ; le domaine propriétaire porte la
**route et l'autorisation**. C'est cette frontière qui permettra aux factures et aux contrats
de réutiliser le mécanisme sans hériter des règles d'accès des finances.

Réponse : `Content-Disposition: attachment`, `X-Content-Type-Options: nosniff`,
`Cache-Control: private, no-store`. Aucun chemin, aucune clé d'objet, aucune URL.

### Ce que le protocole refuse structurellement

`resolvePanelMediaUrl` — **le point unique** qui produit une adresse de média — rend `null`
avec la raison `MEDIA_PRIVE`. Aucun écran, aucune projection, aucun descripteur publié ne
peut obtenir l'adresse d'un document privé, même en la demandant.

### Cycle de vie de la pièce

| Événement | Le justificatif |
|---|---|
| révision `FROM_START` du montant | **conservé** — la révision est un `updateMany` sur les champs financiers |
| arrêt « actuelle » du cycle | **conservé et téléchargeable** — le cycle sort des totaux, la pièce reste l'audit |
| suppression logique du mouvement | **conservé et téléchargeable** ; on n'en attache plus de nouveau |
| remplacement | l'ancien fichier est retiré, **son descripteur survit** — on saura qu'il y a eu remplacement |
| retrait explicite | seul geste qui efface le fichier. Jamais appelé en cascade. |

---

## 13 quater. REVENUS FOURNISSEUR (L10.3)

### Stripe produit des faits, le Panel les projette

```
événement Stripe → fait normalisé → appartenance → transaction → écrans
```

Jamais l'inverse. **Aucun écran, aucun graphique, aucun agrégat n'interroge Stripe.** Une
fois projetée, la transaction vit dans le registre : le bilan reste lisible fournisseur
indisponible. C'est toute la différence entre *projeter un fait* et *consulter une API*.

### Le fait canonique — la décision structurante

Un seul paiement d'abonnement produit chez Stripe, en quelques secondes :

```
checkout.session.completed    la session est payée
invoice.paid                  la facture est réglée
payment_intent.succeeded      l'intention a abouti
charge.succeeded              la carte a été débitée
```

**Quatre annonces, un seul euro.** Projeter chacune produirait un quadruple comptage — le
défaut le plus coûteux possible, parce qu'il est silencieux.

La règle, lisible sur la charge utile seule :

| Cas | Objet canonique |
|---|---|
| le paiement est **facturé** | la **facture** (`in_…`) |
| le paiement n'est pas facturé | la **session** (`cs_…`) |

Une session d'abonnement porte `invoice` : elle s'efface devant la facture. Une session de
frais de lancement (`mode: payment`) n'en a pas : elle est canonique.

Conséquence : les deux chemins calculent **la même clé**. Ce n'est pas une déduplication a
posteriori, c'est la même identité.

`payment_intent.succeeded` et `charge.succeeded` sont **énumérés** comme corroboratifs — et
non simplement ignorés — pour que la recette puisse prouver qu'ils ont été vus et écartés.

### Intention ≠ encaissement

- facture : `amount_paid`, **jamais** `total` ni `amount_due`. Une facture de 249 € réglée
  à 0 € ne produit rien ;
- session : `amount_total`, et seulement si `payment_status === 'paid'`.

Date économique = celle du **règlement** (`status_transitions.paid_at`), pas de l'émission.
Une facture émise le 28 et payée le 2 appartient au mois du paiement.

### L'identité externe — et pourquoi `{sourceId, cycleKey}` n'a pas été détourné

L10.2 avait laissé la réserve. Cette clé-là est taillée pour les occurrences de coûts
récurrents : une règle interne, un cycle calendaire. Y faire entrer Stripe aurait fait
passer un identifiant d'abonnement pour un `sourceId` — deux familles sans rapport sur un
même index unique, qui se collisionneraient le jour où leurs identifiants se croiseraient.

**L'emplacement existait déjà** : `provenance`, posée en L10.1 pour exactement cela.

```
provenance.provider      STRIPE
provenance.environment   TEST | PROD
provenance.externalKind  INVOICE | CHECKOUT_SESSION
provenance.externalId    in_… | cs_…
```

Index **unique partiel** sur ces quatre champs (`uniq_provider_external_object`). Le filtre
partiel n'indexe que ce qui porte un `externalId` : saisies manuelles et occurrences
récurrentes restent dehors.

L'`environment` fait partie de la clé — un identifiant de recette et son homonyme de
production sont deux faits distincts, et jamais l'un n'empêche l'autre.

### L'inbox des faits — pas un second ledger

`PanelProviderRevenueFact` retient chaque fait normalisé. Trois raisons :

1. **le registre de webhooks ne garde pas le corps** (`payloadHash` seulement, par choix) :
   rien ne serait reprojetable ;
2. **l'appartenance n'est pas toujours résoluble à la réception** — Stripe n'ordonne pas ses
   livraisons ;
3. **un fait non projeté doit rester traçable** : ressource sans lien, devise non gérée, lien
   révoqué. Chaque cas porte son motif.

Rien n'y est sommé, filtré par période ni affiché dans un total. Le bénéfice se calcule
exclusivement sur `PanelFinancialTransaction`.

### L'appartenance — par le lien, jamais par les metadata

| Fait | Ressource porteuse | Lien |
|---|---|---|
| session payée | la session elle-même | L6.2B, `PANEL_CREATED` |
| facture payée | son **abonnement** (`invoice.subscription`) | L6.2F, adopté par filiation |

La filiation facture → abonnement est **désignée par Stripe sur l'objet lui-même**, dans la
charge utile déjà reçue : **aucun appel fournisseur**. C'est la même légitimité que
l'adoption L6.2F.

> L'abonnement d'une facture est lu à **trois** emplacements (`subscription`,
> `parent.subscription_details.subscription`, la ligne de facture). Stripe a déplacé ce
> champ ; n'en lire qu'un ferait cesser toute projection d'abonnement le jour d'une
> migration d'API du compte — en silence.

Les metadata **corroborent** et ne décident jamais. Une divergence est consignée
(`claimMismatch`) et affichée dans le détail : c'est un signal de sécurité.

Une ressource **non possédée** ne produit aucune transaction. Le fait est retenu, visible
dans `GET /api/finances/provider-revenue/unprojected` (DEV), avec son motif.

### Convergence — le désordre de livraison

```
invoice.paid                arrive d'abord — l'abonnement n'est pas adopté → PENDING
checkout.session.completed  arrive ensuite → adoption L6.2F
                            → convergence : le fait trouve son projet
```

Trois déclencheurs, dont un seul est la garantie :

1. **à la réception du webhook** — après idempotence, après adoption ;
2. à chaque **lecture financière** (filet) ;
3. au **tick horaire** du même ordonnanceur que les coûts récurrents (filet).

### Taxonomie — provider-agnostique

`flow: INFLOW` + `category: REVENUE`. **Pas** de `STRIPE_REVENUE`, pas de
`SUBSCRIPTION_REVENUE` : Stripe est une **origine** (`origin: STRIPE`), pas une nature
économique. Inventer une catégorie par fournisseur ferait éclater le compte de résultat en
autant de colonnes que d'intégrations.

### Immuable / enrichissable

| | |
|---|---|
| **Immuable** (`$setOnInsert`) | montant, devise, date, sens, catégorie, projet, identité externe |
| **Enrichissable** | document de facture, identités secondaires, libellé de ligne — sur le **fait**, jamais sur la transaction |
| **Jamais touché** | `receipt` — le justificatif manuel survit à tous les rejeux |

Une seconde annonce ne réécrit aucun chiffre : un total affiché ne doit pas changer parce
qu'un webhook a été rejoué.

### Suppression et rejeu — la pierre tombale

Un revenu supprimé **ne ressuscite pas**. La suppression est logique (L10.1) : le document
reste, `deletedAt` le sort des totaux, et sa clé d'identité externe **reste occupée**. La
recherche d'une transaction existante ne filtre donc pas sur `deletedAt` — c'est portant.

### La facture Stripe — une adresse, pas un fichier

Stripe expose `hosted_invoice_url` et `invoice_pdf`. Le Panel les **conserve et les
affiche** ; il n'en matérialise **aucune copie d'office**.

Pourquoi : télécharger systématiquement chaque facture ferait entrer des documents dans le
stockage privé sans que personne l'ait demandé, avec une rétention à définir et un coût de
transfert à chaque paiement. La copie durable existe déjà — c'est le **justificatif privé de
L10.2**, que l'opérateur attache quand il le décide.

Un revenu Stripe **sans** facture (frais de lancement) accepte donc un justificatif manuel
par le mécanisme L10.2, sans une ligne de code nouvelle. Un rejeu de webhook ne le détruit
jamais.

### TEST / PROD

Une instance de Panel sert **un** monde, et sa base est par environnement. L'environnement
vient du **runtime**, jamais de `livemode` — laisser le corps choisir permettrait à un
événement de recette de désigner un lien de production.

Il est porté par le fait, par la transaction, affiché en pastille dans le détail et dans la
ligne (`TEST`), et **jamais perdu**. Dans un Panel de recette, les montants de recette sont
la réalité de ce Panel : ils comptent dans ses totaux — et sa base n'est pas celle de la
production.

### Ce que L10.3 a tendu à L10.4

`payment_intent` et `charge` sont conservés sur le **fait** — pas sur la transaction, dont
L10.1 exige que la provenance reste maigre. Le remboursement les y a trouvés, exactement là
où ils avaient été posés.

`charge.dispute.created` et `credit_note.created` restent **reconnus et non projetés**, et
ce n'est pas une dette : voir § 13 quinquies, « Ce qui n'est pas un remboursement ».

---

## 13 quinquies. REMBOURSEMENTS STRIPE (L10.4)

### Le seul chemin du parc qui rende de l'argent

```
Panel · Projet · Finances · Revenus
        │  « Rembourser » — l'écran n'envoie qu'un transactionId et un montant
        ▼
refundOrchestration          éligibilité → DEMANDE DURABLE → appel → projection
        │
        ▼
capabilityGateway            source PANEL_INTERNAL · politique · coffre · réservation
        │
        ▼
stripeAdapters.refundCreate  APPARTENANCE → état → mutation
        │
        ▼
Stripe   POST /v1/refunds    Idempotency-Key + metadata[ly_operation_id]
        │
        ├─ réponse ─────────► fait « re_… » → ledger
        └─ webhook ─────────► MÊME fait « re_… » → converge, n'insère pas
```

Aucun écran financier n'appelle Stripe. La lecture du livret, le calcul du restant
remboursable et l'affichage de l'état ne lisent que la base.

### Ce que le navigateur peut dire, et ce qu'il ne peut pas

Il envoie un `transactionId` — une identité **interne**, sans valeur chez Stripe — un
montant, un motif et une note. C'est tout.

Il n'envoie **jamais** `pi_…`, `ch_…`, `in_…`, ni `TEST`/`PROD`. Les accepter reviendrait à
laisser un client désigner la ressource à muter chez le fournisseur : un champ modifié, et
le projet B rembourse le paiement du projet A. Le serveur les résout depuis le fait
fournisseur, né d'un webhook signé.

### L'appartenance — l'intention de paiement devient une ressource possédée

Rembourser mute un `payment_intent`. Prouver l'appartenance d'une ressource *cousine* — la
session, l'abonnement — aurait été un raisonnement d'adaptateur, donc une exception à
maintenir.

`PAYMENT_INTENT` est donc **adopté**, par la filiation de L6.2F appliquée d'un cran plus
bas. Le lien est posé à la **projection du revenu**, l'instant précis où trois preuves
coexistent :

1. la session ou l'abonnement porteur est déjà **possédé** ;
2. le fait vient d'un **webhook signé** ;
3. la filiation est désignée par **Stripe lui-même** sur la charge utile.

Aucune n'est une métadonnée éditable, aucune ne vient d'un navigateur. Les revenus projetés
avant L10.4 sont rattrapés par `adoptMissingPaymentIntents()`, à chaque convergence — pas
par une migration, qui s'exécuterait une fois et laisserait manquant tout lien manqué après
elle.

### L'idempotence — pourquoi la clé ne suffit pas

C'est la différence structurante avec la résiliation (L6.2G).

| | Résiliation | Remboursement |
|---|---|---|
| Deux actes légitimes ? | Non — on ne coupe qu'une fois | **Oui** — deux partiels de 100 € sur 500 € |
| L'état tranche ? | Oui, `status: canceled` | **Non** — 200 € rendus = un acte de 200 ou deux de 100 |
| Stripe refuse le doublon ? | Oui | **Non**, il l'accepte : c'est parfois voulu |

L'identité de l'acte ne peut donc pas être dérivée de la ressource. Elle vient de la
**demande** :

```
PanelRefundRequest  écrite AVANT tout appel   → refundRequestId
                                              → operationId = stripe-refund:<monde>:<id>
                                              → clé d'idempotence Stripe
                                              → metadata[ly_operation_id] sur le remboursement
```

Deux clics sur la même demande la rejouent ; deux demandes sont deux actes.

La métadonnée est ce qui rend un rejeu sûr **hors de la fenêtre d'idempotence de Stripe**,
qui est bornée à 24 h. Au-delà, rejouer la même clé ne converge plus : elle créerait un
second remboursement bien réel. L'adaptateur commence donc par lister les remboursements du
paiement et y chercher **sa propre identité**. S'il la trouve, il conclut sans rien émettre.

> La doctrine L6.2A interdit à une métadonnée de décider de l'**appartenance**, parce qu'un
> tiers peut en écrire une. Elle ne dit rien de l'identité d'un acte qu'on a soi-même émis,
> sur une ressource dont l'appartenance est **déjà** prouvée. On ne demande pas « à qui
> est-ce » mais « est-ce moi qui l'ai fait ». La première question a été tranchée avant.

### INCONNU n'est pas ÉCHEC

La distinction la plus importante du lot.

| État | Ce qu'il affirme | Ce que l'écran fait |
|---|---|---|
| `FAILED` | Stripe a tranché : **rien n'est parti** | rouvre le bouton |
| `UNKNOWN` | **on ne sait pas** | ferme le bouton, dit « vérification en cours » |

Les confondre ferait proposer un second remboursement pour un premier peut-être abouti.

On ne conclut `FAILED` que si le plan de contrôle l'affirme (`replaySafe`). Trois cas
basculent en `UNKNOWN` :

- un **timeout** — le silence ne dit rien ;
- une **erreur non typée** — on ignore si elle précède ou suit l'appel ;
- une **violation du contrat de sortie** — Stripe a remboursé, c'est notre lecture de sa
  réponse qui a échoué. Ce cas a été trouvé en recette, et il est le plus insidieux : l'acte
  réussit, la passerelle le rejette, et sans cette règle la demande se conclurait en échec
  sur un argent bel et bien parti.

La reprise est **automatique**, à l'ordonnanceur — jamais à la lecture d'un écran, car elle
appelle réellement Stripe. Un livret consulté ne doit pas déclencher d'appel fournisseur.

### Le document — ce que Stripe fournit vraiment

Audit avant implémentation, cas par cas :

| Cas | Ce que Stripe produit pour le remboursement |
|---|---|
| Abonnement facturé | **rien**. Une facture finalisée est immuable ; un avoir (`cn_…`) est un objet SÉPARÉ, à créer explicitement — un second acte financier |
| Checkout non facturé | **rien** non plus |
| Partiel / total | aucune différence : l'objet `Refund` n'a **ni PDF ni page hébergée** |

Le seul document réel est le **reçu de la charge** (`charge.receipt_url`), que Stripe réédite
en y portant les sommes rendues. Il est conservé sur le fait, sous `chargeReceiptUrl`.

Ce que L10.4 ne fait **pas**, et pourquoi :

- **aucun avoir créé** — ce serait un second acte financier chez le fournisseur, non demandé,
  et impossible hors facture ;
- **aucune « facture de remboursement »** — Stripe ne définit pas cet objet. L'appeler ainsi
  serait un mensonge sur une pièce comptable ;
- **aucun PDF interne généré** — s'il en fallait un, il serait nommé *document interne
  L.Y Solution* et jamais présenté comme une pièce Stripe.

Un justificatif peut toujours être **attaché à la main**, par le protocole Media privé de
L10.2. Aucun stockage parallèle n'a été créé.

### Ce qui n'est pas un remboursement

`charge.dispute.created` — un litige **gèle** l'argent le temps d'une contestation qui peut
se conclure dans les deux sens. Le projeter en sortie inventerait une perte qui n'existe pas
encore, et la rétablir demanderait un mouvement inverse d'un mouvement inverse.

`credit_note.created` — un avoir est un acte **comptable** sur une facture, pas un mouvement
de trésorerie. Quand il accompagne un remboursement, celui-ci a son propre `re_…` et entre
par la porte normale. Le projeter aussi compterait l'argent rendu deux fois.

Un débit annonçant `amount_refunded: 10000` **sans** détail des remboursements ne produit
rien : une somme ne porte aucune identité, donc aucun moyen de distinguer un remboursement
neuf d'un rejeu du précédent.

### Suppression — la falsification que la garde ferme

Retirer un encaissement de 500 € qui porte un remboursement de 100 € ne produirait pas
« rien » : il laisserait le −100 € seul, et le net afficherait une **perte de 100 €** sur une
opération qui a rapporté 400. Pire qu'un chiffre faux — un chiffre faux **sans trace**.

La suppression unitaire est donc **refusée** tant qu'un remboursement vivant s'y rattache.
Pas de cascade : effacer automatiquement les enfants supprimerait un mouvement d'argent réel
sur une décision que personne n'a prise.

« Tout supprimer » n'a pas besoin de cette garde — un remboursement porte le **même
`projectId`** que son encaissement, et aucune portée ne retient l'un sans l'autre. Il ne
rembourse rien, n'annule rien chez Stripe, et ne détruit aucun fait fournisseur : les clés
d'identité externe restent occupées par les pierres tombales, ce qui empêche un rejeu de
webhook de ressusciter demain ce qu'on vient d'effacer.

### Où le remboursement se voit

| Écran | Ce qu'il montre |
|---|---|
| Projet · Finances · **Revenus** | l'encaissement **et** ses remboursements |
| Projet · Finances · **Coûts** | **jamais**. Rendre de l'argent n'est pas une charge |
| Général | net et graphique, remboursement compris |
| Détail d'un mouvement | déjà rendu, restant, et l'historique des demandes — auteur, motif, tentatives échouées |
| **SB Auto Manager** | le paiement passe « Remboursé », **sans aucune modification du projet** |

Le dernier point mérite une phrase. SB Auto reçoit le webhook `charge.refunded` que Stripe
émet pour le remboursement créé par le Panel, et sa chaîne existante — `markRefunded` →
`status: REFUNDED` → badge — le traite depuis toujours. Deux consommateurs indépendants d'un
même fait fournisseur : aucun couplage, aucune route nouvelle, aucun refactor.

### La capacité

`billing.refund` était **déclarée depuis L6** avec la note « premier usage NEUF du plan de
contrôle : aucun code projet ne le fait ». C'est toujours vrai, et ce n'est plus un obstacle :
l'appelant n'est pas un projet mais le **Panel lui-même**, en source `PANEL_INTERNAL`.

Cette source ne relâche qu'**une** étape : l'octroi, qui répond à « ce projet peut-il
demander ceci » — question sans objet quand aucun projet ne demande. Exiger l'octroi aurait
obligé un opérateur à s'accorder à lui-même, sur la fiche du client, le droit d'utiliser son
propre outil — puis à laisser ce droit ouvert, où il serait devenu exactement ce qu'il
prétendait empêcher : un pont projet capable d'appeler `billing.refund`.

Tout le reste s'applique à l'identique : politique commerciale, contrat d'entrée et de
sortie, coffre, réservation d'opération, appartenance, journal.

---

## 14. Ce que ces lots n'ont PAS fait

**Aucun second stockage de fichiers** : le protocole Media existant a été étendu, pas
dupliqué — et cela vaut toujours après L10.4.

L10.1 et L10.2 n'ont touché ni `bridgeContract`, ni `projectBridge`, ni les registres de
capacités, ni l'appartenance Stripe, ni le routage de webhooks. L10.3 a ajouté une seule
prise à la réception des webhooks. **L10.4 est le premier lot financier à écrire dans le plan
de contrôle** — une capacité, un adaptateur, une primitive de transport, et deux gestes
délimités dans la passerelle (accepter une source, exempter l'octroi pour `PANEL_INTERNAL`).
Aucun credential projet, aucun provider local, aucun contournement du plan de contrôle.

Hors périmètre, explicitement : import Stripe de l'historique, prestations facturées,
relances, délai de grâce, retries et suspension d'abonnement, création d'avoirs, génération
de documents internes, restauration d'un mouvement supprimé, et le refactor de la
facturation du Manager.

### Justificatifs — la réserve de L10.1 est levée

L10.1 avait refusé de les livrer, et la raison était bonne : `/uploads` est servi en
**statique et publiquement** (le logo d'entreprise doit être visible des visiteurs des sites
clients). Y déposer des factures les aurait exposées sans authentification.

L10.2 ne contourne pas cette réserve, il la traite : le protocole Media reçoit une notion
générique de **visibilité**, et les documents privés vivent sous `storage/`, que rien ne
sert. Voir § 13 ter.

Ce qui reste ouvert, et qui est assumé :

- un justificatif déposé en local n'est pas migré vers le serveur au déploiement — comme la
  transaction qu'il justifie, qui vit dans la base de cette instance ;
- il n'existe pas de purge des fichiers orphelins (un remplacement retire l'ancien fichier ;
  un échec en cours de route peut laisser un objet non référencé, invisible et inoffensif) ;
- un mouvement supprimé conserve sa pièce indéfiniment. C'est délibéré : la purge d'une
  pièce encore utile à l'audit serait un défaut bien plus grave qu'un octet de trop.

---
## 15. Fichiers

**Backend**

```
models/PanelFinancialTransaction.model.js       le modèle canonique
services/finance/money.js                       centimes entiers, saisie refusée plutôt qu'arrondie
services/finance/period.js                      bornes semi-ouvertes, Europe/Paris, deux passes
services/finance/financialTransactions.service.js  CRUD, portées, journal
services/finance/financialSummary.service.js    agrégats et série, en base
models/PanelRecurringCost.model.js              la RÈGLE et ses révisions append-only
services/finance/recurrence.js                  calendrier PUR — ancrage, cycles, rattrapage
services/finance/recurringCosts.service.js      matérialisation, révisions, arrêt
services/finance/recurringCostScheduler.js      commodité horaire — jamais la garantie
services/finance/receipts.service.js            rattachement et autorisation d'une pièce
services/upload/documentValidation.js           signatures d'octets, noms de fichiers
services/upload/privateMedia.service.js         le média PRIVÉ — extension du protocole
models/PanelProviderRevenueFact.model.js        l'inbox des faits fournisseur (L10.3)
services/finance/providerRevenue/stripeRevenueNormalizer.js  PUR — l'objet canonique, revenus ET remboursements
services/finance/providerRevenue/revenueProjection.service.js  fait → ledger, convergence, adoption du pi_
models/PanelRefundRequest.model.js              l'INTENTION de rembourser — durable, écrite avant l'appel
services/finance/refunds/refundOrchestration.service.js  éligibilité, état dérivé, issues, reprise
services/integratedApi/stripe/stripeRefundAuthority.js   PUR — identité de l'acte, restant, convergence
controllers/finances.controller.js
routes/finances.routes.js                       montée sur /api/finances
```

**Plan de contrôle touché par L10.4** — délimité, et rien de plus

```
capabilities/capabilityRegistry.js     billing.refund passe migrated: true
capabilities/capabilityGateway.service.js  accepte `source` ; exempte l'octroi pour PANEL_INTERNAL
capabilities/invocationContext.js      PANEL_INTERNAL : de « prévue » à « servie »
integratedApi/stripe/stripeCapabilities.js  le contrat d'entrée et de sortie
integratedApi/stripe/stripeAdapters.js      appartenance → état → mutation
integratedApi/stripe/stripeTransport.js     retrievePaymentIntent, listRefunds, createRefund
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
components/finance/RecurringCostForm.tsx        création, révision, arrêt — et leurs modales
components/finance/RecurringCostList.tsx        le listing des RÈGLES, à côté du livret
components/finance/ReceiptCell.tsx              déposer, télécharger, remplacer, retirer
components/finance/ProviderFactPanel.tsx        le fait Stripe — écran de DÉTAIL seulement
components/finance/RefundModal.tsx              rembourser : montants lus, monde en lecture seule
pages/FinancesPage.tsx                          la page globale
```

**Recette**

```
tests/finance-core.test.js       138 contrôles — noyau, monnaie, périodes, portées, garde-fou
tests/finance-recurring.test.js  105 contrôles — calendrier, idempotence, rattrapage, 3 modes, 2 arrêts
tests/finance-receipts.test.js   105 contrôles — média privé, sécurité, survie de la pièce, persistance
tests/finance-stripe-revenue.test.js  142 contrôles — un paiement, une transaction, quatre annonces
tests/finance-refunds.test.js    120 contrôles — double clic, réponse perdue, rejeu hors fenêtre, cloisonnement
tests/finance-ui.test.js         187 contrôles — interface, dont les 5 états dégénérés du graphique
tests/media-first-deployment.test.js  + 10 contrôles — un média privé n'est jamais publié
```
