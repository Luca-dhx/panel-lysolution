# FINANCES L10.6 FINAL — IMPAYÉ, GRÂCE, ET SUSPENSION CONDITIONNELLE

> **Une suspension — automatique ou manuelle — est une CAUSE, jamais une
> autorité sur le résultat.** L'accessibilité est la conjonction de toutes les
> causes, calculée à un seul endroit.
>
> **Retirer une cause ne rouvre rien.** Elle rend la main au moteur, qui
> recalcule. Il n'existe nulle part de `status = ACTIVE` écrit à la main.
>
> **L'e-mail est une conséquence, jamais une condition.** Une panne de Brevo ne
> défait aucune suspension.
>
> **Stripe reste l'unique ordonnanceur des tentatives de prélèvement.**

---

## 1. Les autorités, et ce que chacune décide

| Autorité | Décide | Ne décide pas |
|---|---|---|
| **Stripe** | le fait de paiement, et l'ordonnancement des tentatives | la politique commerciale |
| **Panel** | la politique de grâce, l'ouverture/résolution de l'incident, la demande de fermeture | l'accessibilité du site |
| **SB Auto** | l'accessibilité de SON site, par conjonction de ses causes | qu'un paiement manque |

Le Panel dit « la cause `PAYMENT_DEFAULT` est active » ; SB Auto l'ajoute aux
siennes et tranche seul. Un ordre `status: SUSPENDED` aurait créé un second
maître — et une régularisation aurait pu rouvrir un site en maintenance.

---

## 2. Les causes de suspension, et leur conjonction

```
 accessible = !technical && contractHonoured && !paymentDefault
```

Trois conditions **indépendantes**, toutes nécessaires, évaluées dans
`reconcileSiteStatus()` — le seul endroit du dépôt qui écrive `site.status`.

`suspensionSource` n'est **que l'étiquette de la cause dominante**, recalculée à
chaque réconciliation pour l'affichage. Ce n'est jamais une preuve :

```
 technical = true          →  suspensionSource = TECHNICAL
 paymentDefault = true         et pourtant la cause financière EST appliquée
```

La preuve est l'instantané `causes.{technical,contract,paymentDefault}`, publié
tel qu'il vient d'être évalué. Des tests statiques interdisent
`suspensionSource === …` comme preuve dans le Panel comme dans le Manager.

### Pourquoi il n'y a pas de quatrième cause `MANUAL`

Le cahier des charges demande une « suspension manuelle ». Le levier existait
déjà, sous le nom `technicalSuspension` — et l'audit a montré qu'il **est** la
suspension manuelle :

| Exigence | État avant ce lot |
|---|---|
| déclenchée par un humain (DEV) | ✅ `POST /site-status/suspend`, garde `authorize(DEV)` |
| motif libre facultatif | ✅ `technicalSuspension.reason` |
| auteur et date conservés | ✅ `suspendedBy`, `suspendedAt` |
| c'est une cause, pas une autorité | ✅ alimente la conjonction, n'écrit aucun statut |
| la reprise ne retire que cette cause | ✅ puis réconciliation |
| survit aux réconciliations | ✅ la source est le sous-document, `site.reason` est dérivé |

Ajouter `MANUAL` aurait donc introduit une condition de plus au moteur **sans
introduire aucune décision de plus**, et migré un champ vivant sur toutes les
instances du parc pour une différence de vocabulaire. « Technique » nomme le
motif habituel de ce levier, pas sa nature.

Le critère du CDC — « ne pas détourner `TECHNICAL` si cela empêche de
distinguer motif, auteur ou origine » — est satisfait : les trois sont portés,
et distinctement.

---

## 3. Ce que L10.6 FINAL a réellement ajouté

Le reliquat était la **notification**, pas la cause :

1. `notifyAdmins` — une case à cocher, **décochée par défaut** ;
2. le modèle `SITE_SUSPENDED_MANUAL_ADMIN`, déclaré dans les **deux** registres ;
3. l'envoi **non bloquant**, par le plan de contrôle ;
4. la **preuve durable** de l'acte : qui, quand, motif, intention de prévenir —
   et qui a levé la cause, et quand.

### La trace qui manquait

`reconcileSiteStatus` journalise `SITE_SUSPENDED` / `SITE_ACTIVATED` quand
l'accessibilité **bascule**. C'est insuffisant : poser une suspension manuelle
sur un site déjà fermé pour impayé ne fait basculer aucun statut — l'acte
n'aurait laissé **aucune trace**, et le retirer plus tard aurait laissé le site
fermé sans qu'on sache qui l'avait posé ni pourquoi.

D'où deux actions d'audit distinctes, sur l'ACTE et non sur son résultat :
`SITE_MANUAL_SUSPENSION_APPLIED` et `SITE_MANUAL_SUSPENSION_LIFTED`. Le journal
d'audit n'a ni TTL ni plafond et ne porte aucun secret ; l'activité
d'exploitation, elle, reste bornée.

La reprise remettait par ailleurs le sous-document à zéro, effaçant motif,
auteur et date. L'état **courant** reste nettoyé — un motif sur un site ouvert
se lirait comme une fermeture en cours — mais `liftedAt` / `liftedBy` gardent la
dernière levée à portée d'écran.

---

## 4. Le motif : « Aucun » est un rendu, pas une donnée

```
 saisie vide      →  base : ""            →  e-mail : « Aucun »
 saisie « M »     →  base : "M"           →  e-mail : « M »
 saisie «    »    →  base : ""            →  e-mail : « Aucun »
```

Persister la chaîne « Aucun » aurait inscrit une phrase d'affichage dans une
donnée métier : la base aurait affirmé qu'un motif « Aucun » avait été saisi, ce
qui est faux — et le jour où l'écran se traduit, ou bien la base ment, ou bien
il faut la migrer. La conversion vit dans `motifPourAffichage()`, exportée pour
que la recette éprouve la règle plutôt que sa recopie.

Le journal d'audit enregistre `reason: null` quand il n'y en a pas, jamais
« Aucun ». L'écran prévient l'opérateur : laisser le motif vide affichera
« Aucun » au client — le lui cacher lui ferait croire à une discrétion qu'il n'a
pas.

---

## 5. La notification ne peut pas défaire une suspension

```
 1. la cause est persistée          ← le métier
 2. reconcileSiteStatus()           ← le métier
 3. le journal d'audit              ← ne lève jamais
 ─────────────────────────────────────────────────
 4. l'annonce                       ← une CONSÉQUENCE
```

C'est structurel, pas conventionnel :

- `siteEnforcement.service.js` **n'importe pas** le module d'annonce — un test
  statique le vérifie. Un `await` malheureux ne peut donc pas s'y glisser ;
- `announceManualSuspension()` **ne lève jamais**, n'écrit ni sur le site ni sur
  sa cause, et ne rend rien dont l'appelant ait besoin pour conclure ;
- le contrôleur appelle l'annonce **après** la suspension, et l'ordre est
  vérifié statiquement.

Cinq pannes sont éprouvées : plan de contrôle injoignable, échec par
destinataire, aucun destinataire, résolution impossible, case décochée. Dans les
cinq, le site reste suspendu, la cause intacte, le motif conservé.

Le rapport d'envoi remonte tout de même à l'écran : « suspendu, mais les
administrateurs n'ont pas pu être prévenus » vaut mieux qu'un silence qui
laisserait croire à un envoi.

---

## 6. Le chemin de l'e-mail

```
 DEV suspend (Manager)
   → SB Auto : cause posée, site réconcilié
   → sendTemplate('SITE_SUSPENDED_MANUAL_ADMIN')
   → capacité email.send_template
   → PANEL : modèle Panel · expéditeur Panel · credential Panel
   → Brevo
```

Aucun driver Brevo, aucune clé, aucun repli, aucun rendu HTML métier côté SB
Auto : le HTML expédié est celui du Panel, et le rendu local n'est qu'une
validation précoce des variables (doctrine L8.4C). Des gardes statiques
interdisent `fetch`, `apiKey` et tout driver dans les deux modules concernés.

**Destinataires** : le résolveur `ADMIN_EMAILS` — les comptes de rôle `ADMIN`,
**jamais** les comptes `DEV`. Recalculés à chaque envoi : un administrateur
ajouté hier reçoit le message d'aujourd'hui. Le dédoublonnage porte sur
l'adresse normalisée, **avant** que les actes d'envoi ne soient fabriqués — deux
identités d'acte pour une même adresse ne pourraient plus être rapprochées après
coup.

**Une intention par destinataire** : `actionExecutionId` dérive de l'instant de
la suspension et de la clé du destinataire. Aucune horloge courante — un
`Date.now()` fabriquerait une identité neuve à chaque appel, et le rejeu
enverrait un doublon.

---

## 7. Concurrence

L'écriture de la cause est un **remplacement d'état**, pas une bascule. Huit
clics posent huit fois la même cause ; seul le premier franchit
`wasActive !== next`, et c'est lui seul qui journalise et qui notifie.

Éprouvé : **8 appels → 1 transition → 1 annonce**.

---

## 8. Matrice E2E — L10.6 complet

| # | Scénario | Suite | Résultat |
|---|---|---|---|
| A | premier échec avec grâce | projection + incident | ✅ |
| B | second échec : observations évoluent, échéance non | projection + incident | ✅ |
| C | politique 7 → 15 pendant l'incident | projection (dérive) | ✅ |
| D | `graceDays = null` | projection + incident | ✅ |
| E | `graceDays = 0` | projection + incident | ✅ |
| F | expiration → cause → fermeture → confirmation | confirmation + projection | ✅ |
| G | `TECHNICAL` + `PAYMENT_DEFAULT` | confirmation + manual-suspension | ✅ |
| H | paiement pendant la grâce | confirmation | ✅ |
| I | paiement après suspension | incident + site-status | ✅ |
| J | paiement + maintenance → reste fermé | incident | ✅ |
| K | prestation L10.5 impayée → aucun `PaymentDefault` | payment-requests | ✅ |
| L | notification B-2, une seule après confirmation réelle | notifications | ✅ |
| M | projet offline → rattrapage cause + confirmation | confirmation | ✅ |
| N | incident offline → convergence | incident | ✅ |
| O | doublons Stripe → une seule réalité | projection | ✅ |
| P | désordre → un état terminal ne recule pas | incident (garde d'ordre) | ✅ |
| Q | lectures ×8 → 0 Stripe, 0 mail, 0 mutation, 0 expiration | projection + incident | ✅ |
| R | suspension manuelle simple | manual-suspension | ✅ |
| S | motif renseigné | manual-suspension | ✅ |
| T | motif absent → « Aucun » au rendu, `""` en base | manual-suspension | ✅ |
| U | notification décochée → 0 mail | manual-suspension | ✅ |
| V | notification cochée → une intention par destinataire | manual-suspension | ✅ |
| W | Brevo en panne → suspension effective | manual-suspension | ✅ |
| X | double clic ×8 → une transition | manual-suspension | ✅ |
| Y | reprise manuelle seule → accessible | manual-suspension | ✅ |
| Z | reprise + impayé → reste inaccessible | manual-suspension | ✅ |
| AA | reprise + autre cause (le moteur n'en connaît que trois) | manual-suspension | ✅ |
| AB | reprise + contrat non honoré → reste inaccessible | manual-suspension | ✅ |
| AC | combinaison maximale, retirées une à une | manual-suspension | ✅ |
| AD | ce que le Panel reçoit (projection + causes) | manual-suspension | ✅ |
| AE | rejeu de confirmation : la date ne rajeunit pas | confirmation (L10.6A) | ✅ |

---

## 9. Matrice du CDC L10.6

| Exigence | Lot | Implémentation | Preuve | Statut |
|---|---|---|---|---|
| délai de grâce au contrat | B-1 | `Contract.paymentGraceDays`, snapshot à l'ouverture | `contract-payment-grace-policy` 34/34 | **PASS** |
| retry configurable localement | — | **remplacé** : Stripe seul ordonnanceur | gardes statiques (2 dépôts) | **N/A — remplacé** |
| prochaine tentative observée | B-1 / B-3 | `nextPaymentAttemptAt` recopié | projection + incident | **PASS** |
| échec d'abonnement → incident unique | A | index `(environment, invoiceId)` | confirmation 86/86 | **PASS** |
| suspension automatique à l'échéance | A / B-1 | `expireDueGracePeriods` → `PAYMENT_DEFAULT_CAUSE` | confirmation | **PASS** |
| motif automatique « Défaut de paiement » | A | motif canonique, jamais reformulé | confirmation + presentation | **PASS** |
| confirmation par le projet | A | `causes.paymentDefault`, jamais la dominante | confirmation | **PASS** |
| notification admins (impayé) | B-2 | `SITE_SUSPENDED_PAYMENT_DEFAULT_CLIENT` | notifications 77/77 | **PASS** |
| notification équipe (impayé) | B-2 | `SITE_SUSPENDED_PAYMENT_DEFAULT_TEAM` | notifications | **PASS** |
| activité d'exploitation | B-2 | `PROJECT_SITE_SUSPENDED_PAYMENT_DEFAULT` | notifications | **PASS** |
| réactivation conditionnelle | A | retrait de cause + réconciliation | site-status + manual-suspension | **PASS** |
| multi-causes | A / B-3 / FINAL | instantané des trois causes | manual-suspension (AC) | **PASS** |
| facture à payer visible | B-3 | `PAYMENT_DEFAULT_INCIDENT` + Manager | incident 99/99 | **PASS** |
| UI Panel (Projet → Finances) | B-3 | `PaymentDefaultPanel` | projection 154/154 | **PASS** |
| UI Manager (Facturation) | B-3 | `SubscriptionIncidentCard` | incident | **PASS** |
| historique des incidents | B-3 | identité = `paymentDefaultId` | projection + incident | **PASS** |
| **suspension manuelle** | **FINAL** | `setTechnicalSuspension`, cause du moteur | manual-suspension 118/118 | **PASS** |
| **motif facultatif** | **FINAL** | `reason` libre, vide autorisé | manual-suspension (S, T) | **PASS** |
| **motif absent → « Aucun »** | **FINAL** | `motifPourAffichage()`, jamais persisté | manual-suspension (T) | **PASS** |
| **checkbox notifier admins** | **FINAL** | `notifyAdmins`, décochée par défaut | manual-suspension (U, V) | **PASS** |
| **e-mail non bloquant** | **FINAL** | annonce hors chemin critique | manual-suspension (W) + gardes | **PASS** |

---

## 10. Hors périmètre — et pourquoi

Deux propositions issues de B-3 ont été relues contre le CDC L10.6 et
**classées hors périmètre** :

1. **Relances e-mail pendant la grâce.** Le CDC ne les demande pas. À ne
   surtout pas confondre avec un *retry de paiement* : Stripe reste l'unique
   ordonnanceur des prélèvements, et une relance est un message, pas un débit.
   L'ajouter « tant qu'on y est » créerait une cadence de communication que
   personne n'a arbitrée. → **FUTURE LOT**
2. **Vue parc des impayés.** La surface est bornée au projet (`projectId`
   obligatoire), délibérément. Une vue « qui ne paie pas ? » à l'échelle du parc
   est un besoin d'exploitation distinct, qui mérite sa propre décision
   d'affichage plutôt qu'un élargissement discret d'une route existante.
   → **FUTURE LOT**

**Aucune notification à la reprise manuelle** : le CDC n'en demande qu'à la
suspension. En inventer une enverrait un message que personne n'a demandé, sans
case pour le refuser.

---

## 11. Réserves honnêtes

- La suspension manuelle conserve le nom `technicalSuspension` en base et
  `TECHNICAL` comme étiquette dominante. C'est un choix documenté (§2), pas un
  oubli : le renommer aurait migré un champ vivant du parc pour un synonyme.
  Un lecteur qui cherche « manual » dans le schéma ne le trouvera pas — d'où ce
  paragraphe, et l'en-tête du sous-document.
- Le rapport d'envoi (`notification`) accompagne la réponse de suspension. Ce
  n'est **pas** un état du site et il ne doit jamais être persisté comme tel :
  il décrit un envoi, à un instant, pour un appel précis.
- `SITE_SUSPENDED_MANUAL_ADMIN` est déclaré dans les deux registres. Les compter
  reste un cliquet volontaire (5 → 6 côté projet) : ajouter un modèle engage le
  contenu, l'expéditeur et la clé du Panel, et ne doit pas pouvoir se faire par
  inadvertance.
