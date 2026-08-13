# FINANCES L10.6B-3 — L'INCIDENT EXISTE AVANT LA SUSPENSION

> **Un incident de paiement et une cause de suspension sont deux concepts
> distincts. Pendant la période de grâce, l'incident existe alors que la cause
> `PAYMENT_DEFAULT` n'est pas encore active.**
>
> `active` dans la projection de cause, s'il est conservé, décrit exclusivement
> l'application de la cause `PAYMENT_DEFAULT` au moteur `SiteStatus`. Il ne
> signifie ni « incident existant » ni « facture impayée ».
>
> Le Manager reçoit l'état financier nécessaire à la présentation **sans devenir
> autorité** du `PaymentDefault`.
>
> **Stripe reste l'unique ordonnanceur des tentatives de prélèvement.**
>
> `RESOLVED` ne signifie pas nécessairement que le site est accessible.

---

## 1. Le défaut que ce lot corrige

Avant B-3, le Panel ne publiait vers le projet qu'aux transitions où la **cause
de suspension** devenait pertinente :

```
 GRACE_EXPIRED        →  PAYMENT_DEFAULT_CAUSE { active: true }
 RESOLVED / retrait   →  PAYMENT_DEFAULT_CAUSE { active: false }
```

Un client dont la carte venait d'être refusée n'apprenait donc **rien** :

```
 invoice.payment_failed
   → incident Panel ouvert
   → grâce active (7 jours)
   → le Manager ne sait rien
```

Il découvrait l'incident **et** la sanction dans le même écran, le jour où son
site fermait — après avoir eu une semaine pour l'éviter.

---

## 2. L'audit préalable : que signifie `active` ?

La question a été tranchée **depuis le code**, pas depuis l'intention.

### Question A — que signifie `{ active: true }` ?

`paymentDefaults.service.js` :

```js
const actif = demandsSuspension(incident.status);   // status === GRACE_EXPIRED
```

`paymentDefaultCause.applier.js`, côté projet :

```js
site.paymentDefault = { active, … };
await site.save();
const apres = await reconcileSiteStatus({ actor: 'PANEL' });
```

et `siteEnforcement.service.js` :

```js
const accessible = !technicalActive && contractHonoured && !paymentDefaultActive;
```

**Réponse : « la cause `PAYMENT_DEFAULT` est actuellement appliquée au moteur de
suspension du projet ».** C'est une *entrée de moteur*, et la seule chose que
cette valeur produise est un recalcul d'accessibilité.

### Question B — que signifie `{ active: false }` ?

« La cause n'est pas appliquée. » Rien d'autre. En particulier **pas** « aucun
incident » : un incident `OPEN` en pleine grâce n'émettait aucune cause du tout,
et un incident `RESOLVED` en émet une à `false`. Les deux états publient — ou ne
publient pas — la même valeur pour des raisons opposées.

### Question C — que représente `PAYMENT_DEFAULT_CAUSE` ?

**L'état de la CAUSE `PAYMENT_DEFAULT` appliquée au moteur `SiteStatus`.**
Pas un incident financier.

---

## 3. Pourquoi l'option A a été écartée

Enrichir `PAYMENT_DEFAULT_CAUSE` menait à deux impasses, et il n'y en avait pas
de troisième :

| Choix pendant la grâce | Conséquence |
|---|---|
| `active: true` | **ferme le site pendant la grâce** — soit exactement ce que la grâce existe pour empêcher |
| `active: false` + contexte | correct pour le moteur, mais l'applicateur de cause **remet à néant** tout le contexte dans ce cas (`since: null`, `paymentDefaultId: null`, `amountDueCents: 0`). L'incident arriverait et disparaîtrait dans la même écriture |

Et un argument **structurel**, décisif à lui seul :

> `SiteStatus` est un **singleton** portant **un** sous-document `paymentDefault`.
> Un projet peut connaître **plusieurs incidents successifs** — deux périodes
> d'abonnement impayées sont deux factures, donc deux incidents.
> Un singleton n'héberge pas un historique.

---

## 4. La solution retenue — option B, minimale

Un second `entityType` : **`PAYMENT_DEFAULT_INCIDENT`**.

```
 PAYMENT_DEFAULT_CAUSE      « faut-il fermer ? »
                            → entrée du moteur, cible SINGLETON
                            → émise aux transitions de cause seulement

 PAYMENT_DEFAULT_INCIDENT   « que se passe-t-il ? »
                            → observation en lecture seule, cible COLLECTION
                            → émise à CHAQUE évolution, dès le premier échec
                            → ne touche JAMAIS SiteStatus
```

### Pourquoi c'est la plus petite extension correcte

| Critère | Réponse |
|---|---|
| ne change pas la signification de `active` | `active` reste le mot de la cause. L'incident dit `causeActive`, et ce n'est pas le même champ |
| ne crée pas un second moteur `SiteStatus` | l'applicateur d'incident n'importe ni `SiteStatus` ni `reconcileSiteStatus` — un test statique l'interdit |
| pas deux projections concurrentes d'un même fait | l'une est une **entrée** de décision, l'autre une **observation** d'affichage. Aucune des deux ne peut se substituer à l'autre |
| push **et** pull hors ligne | applicateur branché sur `changeAppliers` **et** `applyHandlers` — un test compte les deux |
| idempotente | remplacement d'état complet, `upsert` sur `paymentDefaultId` |
| état complet, pas un delta | 23 champs, aucun « incrémente » |
| incident visible dès le premier échec | publié depuis `recordInvoiceFailure` |
| résolution visible | publié depuis `resolveInvoiceDefault` et `confirmFromSiteStatus` |
| aucune suspension pendant la grâce | prouvé côté projet : le site reste `ACTIVE` après réception |
| React ne reconstruit rien | la mise en mots est faite par un mapper **pur côté serveur** |

`causeActive` est **redondant à dessein** avec `PAYMENT_DEFAULT_CAUSE.active` :
les deux dérivent de la **même** fonction `demandsSuspension()`, si bien
qu'aucune ne peut dériver de l'autre. La première explique un écran ; la seconde
décide d'un site. Seule la seconde atteint le moteur.

---

## 5. La chaîne complète

```
 invoice.payment_failed  (1er)
        │
        ├──▶ PaymentDefault ouvert, politique de grâce FIGÉE      (L10.6B-1)
        │
        └──▶ PAYMENT_DEFAULT_INCIDENT { status: OPEN, causeActive: false }
                    │
                    ▼
             le Manager AFFICHE l'incident, le site reste OUVERT
                                          ▲
                                          └── aucune cause n'a été émise

 invoice.payment_failed  (2e, 3e…)
        └──▶ PAYMENT_DEFAULT_INCIDENT { attemptCount: 2, nextPaymentAttemptAt: … }
                    │
                    └── firstFailedAt, graceDaysSnapshot, graceDeadlineAt
                        NE BOUGENT PAS

 l'échéance tombe
        ├──▶ PAYMENT_DEFAULT_CAUSE    { active: true }        → le moteur ferme
        └──▶ PAYMENT_DEFAULT_INCIDENT { GRACE_EXPIRED,
                                        suspensionRequestedAt: …,
                                        suspensionConfirmedAt: null }
                    │
                    └── « Suspension en cours d'application »
                        et surtout PAS « Site suspendu »

 PROJECT_SITE_STATUS revient, causes.paymentDefault = true
        ├──▶ suspensionConfirmedAt écrite                       (L10.6A)
        ├──▶ annonces                                           (L10.6B-2)
        └──▶ PAYMENT_DEFAULT_INCIDENT republié, CONFIRMÉ        (L10.6B-3)
                    │
                    └── « Site suspendu pour défaut de paiement »

 invoice.paid
        ├──▶ revenu canonique                                   (L10.3)
        ├──▶ PAYMENT_DEFAULT_CAUSE    { active: false }         → le moteur recalcule
        └──▶ PAYMENT_DEFAULT_INCIDENT { RESOLVED, causeActive: false }
```

---

## 6. `RESOLVED` ne veut pas dire « accessible »

Le cas obligatoire, et celui qu'aucun badge unique ne sait dire :

```
 paymentDefault = false        ← notre cause est retirée
 technical      = true         ← une maintenance subsiste
 accessible     = false        ← le site reste fermé
```

L'écran doit afficher **les quatre affirmations ensemble** :

```
 Paiement régularisé
 Défaut de paiement retiré
 Site toujours suspendu
 Cause : maintenance technique
```

Un badge vert « tout va bien » y est un mensonge ; un badge rouge « impayé »
aussi. C'est la raison d'être des **quatre dimensions** du mapper de
présentation — `PAYMENT`, `GRACE`, `PAYMENT_DEFAULT_CAUSE`, `SITE_ACCESSIBILITY`
— qu'on ne fusionne jamais.

De même, la preuve d'application d'une cause est **`causes.paymentDefault`**,
jamais `suspensionSource` : sous maintenance, la dominante affichée reste
`TECHNICAL` alors que notre cause **est** appliquée. Un test statique interdit
`suspensionSource === 'PAYMENT_DEFAULT'` comme preuve, dans le Panel comme dans
le Manager.

---

## 7. `null` ≠ `0`, sur toute la chaîne

Deux décisions **opposées**, et le chemin les sépare de bout en bout :

| Valeur | Signification | Conséquence |
|---|---|---|
| `graceDaysSnapshot = null` | aucune politique n'a été fixée | le site **ne fermera jamais** automatiquement pour cet incident |
| `graceDaysSnapshot = 0` | aucune clémence | l'échéance tombe **dès l'échec** |

Un `?? 0` n'importe où sur le trajet transformerait la première en seconde, et
promettrait une suspension automatique que personne n'a décidée. Le chemin est
gardé :

- **publication** : `Number.isInteger(...) ? ... : null` ;
- **applicateur projet** : idem, et le modèle a `default: null`, jamais `0` ;
- **lecture projet** : un booléen `graceConfigured` accompagne la valeur, pour
  que React n'ait **pas** à écrire un test de vérité sur un nombre ;
- **UI Panel** : comparaison explicite `=== null`, vérifiée par un test statique.

---

## 8. Snapshot ≠ politique courante

```
 incident.graceDaysSnapshot = 7
 contract.paymentGraceDays  = 15
```

Les **deux** sont affichées, et l'écran dit laquelle s'applique :

```
 Incident actuel      : 7 jours
 Politique du contrat : 15 jours
 La modification s'appliquera aux prochains incidents.
```

L'échéance n'est **jamais** recalculée. La recalculer avec la politique courante
ferait glisser une date déjà annoncée au client — et fermerait son site à un
moment que personne ne lui a communiqué.

---

## 9. Stripe est observé, jamais piloté

`attemptCount` et `nextPaymentAttemptAt` sont **recopiés** de
`invoice.attempt_count` et `invoice.next_payment_attempt`.

L'écran écrit :

> Prochaine tentative prévue par Stripe le …

et **jamais** :

> Nous retenterons le …

Une date absente ne signifie pas « aucune tentative prévue » : elle signifie que
Stripe ne l'a pas communiquée. Le booléen `nextAttemptKnown` porte cette nuance
jusqu'à l'écran.

Il n'existe **aucun** `retryNow`, `retryInterval`, `invoice.pay` ni SDK Stripe
dans le périmètre B-3, et des tests statiques — qui lisent le **code** et non les
commentaires — l'interdisent dans les deux dépôts. Un `POST /v1/invoices/{id}/pay`
émis d'ici entrerait en course avec la tentative que Stripe a déjà programmée sur
la même facture : c'est-à-dire produirait le double débit.

Le seul geste offert au client est **la facture hébergée que Stripe a déjà
émise** (`hostedInvoiceUrl`) — sa page de paiement pour cette facture précise.
Aucun montant transmis, aucune session ouverte, aucune capacité nouvelle.

---

## 10. Les lectures ne déclenchent rien

`GET /api/finances/payment-defaults` (Panel) et
`GET /api/my-invoices/subscription-incidents` (Manager) sont des **lectures**, et
il n'existe aucun verbe d'écriture à côté d'elles.

Huit lectures consécutives produisent, et c'est éprouvé :

```
 STRIPE_CALLS               = 0
 EMAIL_SENDS                = 0
 LEDGER_WRITES              = 0
 PAYMENT_DEFAULT_MUTATIONS  = 0
 SITE_STATUS_MUTATIONS      = 0
 écritures émises vers le projet = 0
 grâces expirées du fait de la lecture = 0
```

Ce dernier point compte autant que les autres : un `GET` qui ferait basculer les
grâces échues **fermerait un site parce que quelqu'un a ouvert un écran**.
L'ordonnanceur financier reste seul à décider, sur son propre rythme.

---

## 11. Hors ligne, idempotence, désordre

Le push et le pull passent par le **même** applicateur — inscrit dans
`changeAppliers` (le Panel livre) **et** dans `applyHandlers` (le projet tire).
Un type inscrit dans un seul des deux fonctionne tant que le projet est en ligne,
puis disparaît silencieusement dès qu'il a été absent : soit exactement le cas
que le rattrapage existe pour couvrir.

Le rattrapage explicite republie désormais les incidents **VIVANTS**, `OPEN`
compris — et non plus seulement les causes `GRACE_EXPIRED`. Un projet qui revient
pendant une grâce doit retrouver son incident.

**Une garde d'ordre a dû être ajoutée**, et elle mérite d'être expliquée : le
pont dédoublonne par `writeId`, donc il reconnaît la **même** livraison rejouée.
Il ne reconnaît **pas** deux écritures distinctes arrivées à l'envers — cas banal
après un rattrapage, où le journal se rejoue pendant que le direct reprend. Sans
garde, la plus ancienne gagnerait : un incident résolu repasserait « en échec »
sous les yeux du client. L'applicateur compare donc `modifiedAt` à
`sourceModifiedAt` et refuse de reculer. À égalité, il applique — deux écritures
peuvent partager l'horodatage de leur source.

---

## 12. Ce que B-3 n'a pas fait

- **Aucun revenu** n'est écrit avant `invoice.paid` : l'incident reste
  l'**absence** d'un encaissement, et une absence ne s'inscrit à aucun livret.
- Une **prestation L10.5** peut être « à payer », mais n'ouvre aucun incident
  d'abonnement, ne déclenche aucune échéance de grâce et ne suspend aucun site.
  Les deux surfaces restent séparées pour que la frontière soit *structurelle*.
- **La suspension manuelle** (modal motif facultatif, case « notifier les
  administrateurs », gabarit avec motif ou « aucun ») n'est **pas** implémentée :
  elle n'est nécessaire à aucune des interfaces `PaymentDefault` de ce lot. Le
  levier technique existe (`POST /site-status/suspend`, réservé DEV, avec motif),
  mais ni la case de notification ni le gabarit correspondant. À reprendre en
  L10.6 FINAL.

---

## 13. Matrice du CDC L10.6

| Exigence | Lot | Preuve | Statut |
|---|---|---|---|
| `graceDays` au contrat, figé à l'ouverture | L10.6B-1 | `contract-payment-grace-policy.test.js`, `finance-payment-default-confirmation.test.js` | ✅ |
| Échec d'abonnement → incident unique par facture | L10.6A | index `(environment, invoiceId)`, `finance-payment-default-confirmation.test.js` | ✅ |
| Retry **observé** de Stripe (jamais piloté) | L10.6A / B-3 | `attemptCount`, `nextPaymentAttemptAt` recopiés ; gardes statiques dans les 2 dépôts | ✅ |
| Facture à payer visible après le 1er échec | **L10.6B-3** | `PAYMENT_DEFAULT_INCIDENT` + `SubscriptionIncidentCard`, `hostedInvoiceUrl` | ✅ |
| Suspension automatique à l'expiration | L10.6A | `expireDueGracePeriods` + `PAYMENT_DEFAULT_CAUSE` | ✅ |
| Confirmation par le projet (jamais déduite) | L10.6A | `confirmFromSiteStatus`, preuve = `causes.paymentDefault` | ✅ |
| Notification aux administrateurs du projet | L10.6B-2 | `announceConfirmedSuspensions`, gabarit `CLIENT` | ✅ |
| Notification à l'équipe L.Y Solution | L10.6B-2 | gabarit `TEAM`, `resolvePanelTeam()` | ✅ |
| Activité d'exploitation | L10.6B-2 | `PROJECT_SITE_SUSPENDED_PAYMENT_DEFAULT` | ✅ |
| Réactivation **conditionnelle** (jamais forcée) | L10.6A | retrait de cause seul ; `reconcileSiteStatus` tranche | ✅ |
| Multi-causes (`TECHNICAL` + `PAYMENT_DEFAULT`) | L10.6A / B-3 | instantané des 3 causes ; UI des deux côtés | ✅ |
| **UI Panel** (Projet → Finances) | **L10.6B-3** | `PaymentDefaultPanel.tsx`, `GET /api/finances/payment-defaults` | ✅ |
| **UI Manager** (Facturation & abonnement) | **L10.6B-3** | `SubscriptionIncidentCard.tsx`, `GET /my-invoices/subscription-incidents` | ✅ |
| **Historique des incidents** | **L10.6B-3** | historique repliable des deux côtés ; identité = `paymentDefaultId` | ✅ |
| Suspension **manuelle** + modal motif + case notifier | — | levier DEV existant sans modal ni notification | ⚠️ **reliquat** |

### Reliquats pour L10.6 FINAL

1. **Suspension manuelle complète** — modal avec motif facultatif, case
   « notifier les administrateurs », gabarit e-mail acceptant un motif *ou*
   « aucun motif communiqué ». Le levier technique existe déjà côté DEV ; il lui
   manque son parcours humain et son annonce.
2. **Relances pendant la grâce** — le CDC ne les demande pas explicitement, mais
   l'incident est aujourd'hui silencieux entre le premier échec et la
   confirmation de suspension. À arbitrer : notifier, ou laisser Stripe le faire.
3. **Vue parc des impayés** — la surface est volontairement bornée au projet
   (`projectId` obligatoire). Une vue « qui ne paie pas ? » à l'échelle du parc
   est un besoin d'exploitation distinct, et elle mérite sa propre décision
   d'affichage plutôt qu'un élargissement discret de cette route.
