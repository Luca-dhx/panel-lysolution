# FINANCES L10.6B-1 — LA POLITIQUE DE GRÂCE APPARTIENT AU CONTRAT

> Sous-lot étroit. Il déplace **une** décision : combien de jours s'écoulent
> entre un paiement refusé et le droit de fermer un site — et il la place là où
> elle se négocie, sur le contrat.
>
> Ni notification, ni écran d'incident, ni suspension manuelle : L10.6B-2 et
> L10.6B-3.

---

## 1. La matrice d'autorité

Une question, un maître. C'est la règle que ce lot fait tenir sur un point
précis : le délai de grâce.

| Qui | De quoi il est l'autorité |
|---|---|
| **Stripe** | Les échecs, **les tentatives de collecte**, `next_payment_attempt`, `attempt_count` |
| **Contract** | `paymentGraceDays` — la clémence commerciale accordée au client |
| **PaymentDefault** | `graceDaysSnapshot` (instantané) et `graceDeadlineAt` (dérivé, **figé**) |
| **SB Auto** | L'accessibilité RÉELLE du site |

Le Panel n'ordonnance aucune tentative de paiement et ne recalcule aucune
accessibilité. Il décide d'une seule chose : **quand il a le droit d'agir**.

```
 Contrat  paymentGraceDays = 7
    │
    ▼  projection contractuelle (voie unique du pont)
 Panel    lit 7 au moment du PREMIER refus
    │
    ▼  instantané
 PaymentDefault  graceDaysSnapshot = 7
                 graceDeadlineAt   = T0 + 7 jours     ← figé, jamais recalculé
    │
    ▼  à l'échéance
 demande de fermeture → SB Auto → reconcileSiteStatus() → confirmation (L10.6A)
```

---

## 2. Pourquoi la politique est **snapshotée**

Parce que le contrat est **mutable** et que l'incident, lui, est un **fait
daté**. Les lire tous les deux au moment d'agir revient à laisser le présent
réécrire le passé.

### L'exemple qui tranche : 7 → 15 jours pendant un incident

```
1er septembre, 10h00   facture refusée
                       Contract.paymentGraceDays = 7
                       → incident OUVERT
                         graceDaysSnapshot = 7
                         graceDeadlineAt   = 8 septembre, 10h00

3 septembre            Stripe retente. Échec.
                       → firstFailedAt   INCHANGÉ
                         graceDaysSnapshot INCHANGÉ
                         graceDeadlineAt   INCHANGÉE
                         attemptCount      2          ← observation Stripe
                         nextPaymentAttemptAt  6 sept ← observation Stripe

5 septembre            accord commercial : le contrat passe à 15 jours

8 septembre, 10h00     L'ÉCHÉANCE TOMBE. Sur 7 jours.
```

Le client a-t-il été lésé ? Non — et c'est le point. Le passage à 15 jours vaut
pour les impayés **à venir** ; s'il fallait prolonger celui-ci, l'incident se
résout ou se ferme explicitement, ce qui laisse une trace. Ce que le snapshot
interdit, c'est le glissement **silencieux** : une échéance qui bouge sans que
personne n'ait décidé qu'elle bouge.

Sans snapshot, deux dérives, l'une et l'autre réelles :

- **l'échéance recule sans fin.** Chaque tentative de Stripe rouvre le calcul,
  la grâce se réamorce, et un impayé de six mois n'atteint jamais son terme ;
- **l'échéance recule dans le passé.** Une politique ramenée de 15 à 3 jours
  ferme rétroactivement un site dont l'échéance annoncée n'était pas encore
  atteinte.

Un garde-fou statique vérifie que `graceDaysSnapshot` et `graceDeadlineAt` ne
vivent que dans le `$setOnInsert` — jamais dans un `$set`.

### Le nouvel incident, lui, prend la valeur du jour

```
incident précédent RÉSOLU
nouvel échec, Contract = 15
→ nouvel incident, graceDaysSnapshot = 15
```

La politique n'est pas gelée : c'est **l'incident** qui l'est.

---

## 3. Pourquoi il n'existe aucun `retryInterval` local

Parce que **Stripe reste l'unique ordonnanceur des tentatives de collecte**.

Un `retryInterval` côté Panel serait une configuration menteuse : elle
donnerait l'impression de piloter les relances alors que Stripe continuerait
les siennes selon **sa** grille. Deux calendriers, dont un seul débite
réellement — et personne, six mois plus tard, ne saurait plus lequel lisait
quoi.

La séparation est nette :

```
Stripe décide QUAND on retente de prélever.
Le Panel décide QUAND il a le droit d'agir sur le site.
```

Le Panel **observe** `next_payment_attempt` et `attempt_count` et les persiste
pour l'affichage et l'audit. Il ne les produit pas, ne les corrige pas, et ne
s'en sert jamais pour recalculer une échéance.

`billing.invoice.pay` n'est **pas** appelé, et aucun `setInterval` de
prélèvement n'existe. Ce serait un autre lot, avec une autre décision : couper
les relances automatiques de Stripe pour transférer l'autorité de collecte à
LYCARZ. Cette décision n'a pas été prise.

Deux garde-fous statiques l'interdisent, dans les deux dépôts.

---

## 4. `null` et `0` sont deux décisions opposées

C'est la distinction la plus fragile du lot, et la plus coûteuse à perdre.

```
paymentGraceDays = null    aucune politique configurée
                           → l'incident s'OUVRE, la dette est visible
                           → AUCUNE échéance n'est fixée
                           → le site n'est JAMAIS fermé automatiquement

paymentGraceDays = 0       aucune clémence
                           → l'échéance tombe AU PREMIER refus
```

Un `graceDays || 7` aurait inventé une clémence que personne n'a négociée. Un
`graceDays || 0` aurait fermé, dès le premier refus, les sites de tous les
contrats historiques. Les deux sont écartés par un garde-fou, dans les deux
dépôts.

### Les contrats historiques

Ils valent `null`. **Aucun backfill** n'a été fait : il n'existe aucune valeur
que l'on puisse déduire sans l'inventer. Le comportement est explicite et il
est prouvé — l'impayé est suivi, la fermeture reste une décision humaine.

### Le défaut que cette décision a révélé

En BSON, `null` précède les dates dans l'ordre de comparaison. La requête de
l'ordonnanceur était :

```js
graceDeadlineAt: { $lte: now }
```

Elle sélectionnait donc **aussi** les incidents sans échéance. Un contrat sans
politique aurait vu son site fermé au premier refus de paiement — exactement
l'inverse de ce qui vient d'être décidé, et sur le chemin le plus automatique
qui soit. Corrigé aux deux endroits, la sélection et la réservation atomique :

```js
graceDeadlineAt: { $ne: null, $lte: now }
```

Un contrôle laisse passer un an de temps simulé sur un incident non configuré
et vérifie qu'il est toujours ouvert.

---

## 5. Qui peut changer la politique, et comment

`PUT /contracts/:id/payment-grace-policy`, rôle **DEV**, volontairement **hors**
du parcours de brouillon.

`updateDraft` exige un brouillon, et c'est juste : on ne retouche pas la
tarification d'un contrat signé. Mais un délai de grâce ne sert à rien tant
qu'il n'y a pas d'abonnement — c'est-à-dire tant que le contrat est un
brouillon. Le cas réel est celui d'une facture déjà refusée, sur un contrat déjà
signé. Derrière `assertMutable`, le réglage aurait été inutilisable au seul
moment où il compte.

C'est le **seul** réglage du contrat qui reste ouvert après validation, parce
qu'il ne décrit pas un engagement signé mais la clémence appliquée avant
d'agir. Chaque changement est journalisé — action
`PAYMENT_GRACE_POLICY_CHANGED`, avec l'ancienne et la nouvelle valeur. Réécrire
la même valeur ne produit aucune trace.

Validation, en front comme en back : entier, `0 ≤ n ≤ 365`, ou `null`. Le champ
est **obligatoire** dans le corps et `null` y est licite — rendre le champ
optionnel aurait confondu « je retire la politique » avec « je n'ai rien
envoyé ».

Côté Manager, un interrupteur plutôt qu'un simple champ numérique : effacer un
nombre ne doit pas pouvoir signifier accidentellement son contraire.

---

## 6. Un défaut adjacent, réel, corrigé

Le déclencheur de projection ne surveillait ni `paymentGraceDays` **ni
`taxRate`** — alors que la projection lit ce dernier depuis L10.5.

Conséquence : changer le taux de TVA dans le Manager n'atteignait le Panel
qu'au redémarrage suivant, ou par raccroc quand un autre champ surveillé
bougeait. Le garde-fou qui l'aurait dit existait déjà et échouait
(`aucun champ lu par la projection n'échappe à un déclencheur (taxRate)`) —
mais sa suite n'était pas dans la chaîne `npm test`. Elle y est désormais, avec
la nouvelle.

Pour une politique qu'on corrige **pendant** un impayé, l'écart aurait été le
lot entier.

---

## 7. Ce que les suites prouvent

**Panel — `finance-payment-default-confirmation.test.js`, 86 contrôles**
(44 de L10.6A, 42 ajoutés)

La politique lue au contrat et suivie quand elle change ; le contrat sans
politique qui rend `null` ; le snapshot au premier échec ; le second échec qui
ne déplace ni l'ancre ni l'échéance mais fait bien évoluer les observations
Stripe ; le contrat passé à 15 pendant un incident figé à 7 ; l'incident
suivant qui prend 15 ; `0` dont l'échéance tombe au premier refus et expire une
seconde plus tard ; l'incident non configuré toujours ouvert un an après ; la
convergence de la politique par `applyIncoming`, la voie réelle du pont, dans
les deux sens (pose et retrait) ; la prestation L10.5 toujours exclue par
`NOT_A_SUBSCRIPTION`, filtrée en amont de tout enregistrement ; et les
garde-fous — échéance calculée à un seul endroit, jamais dans un `$set`,
contrat lu uniquement à l'ouverture, aucune relance locale.

**SB Auto — `contract-payment-grace-policy.test.js`, 34 contrôles**

Le contrat qui naît sans politique ; poser, modifier, retirer ; `0` qui survit
à l'aller-retour en base ; les saisies impossibles refusées sans rien écrire ;
la modification sur un contrat ACTIF verrouillé, alors que la tarification y
reste verrouillée ; l'audit et son absence quand rien ne change ; la politique
dans la projection, `null` compris ; le départ immédiat vers le Panel pour la
politique **et** pour le taux de TVA ; les garde-fous statiques.

**SB Auto — `deployment-env.test.js`, 28 contrôles** : l'ancienne variable
globale ne peut plus revenir, ni dans `.env.example`, ni dans la configuration.

---

## 8. Ce qui reste pour la suite de L10.6B

Les notifications projet et équipe, l'événement d'activité, l'écran d'incident
côté Panel et côté Manager, la suspension manuelle.

L10.6B-1 ne produit aucune de ces choses. Il produit la **date** sur laquelle
elles se brancheront — et la garantie qu'elle ne bougera pas toute seule.
