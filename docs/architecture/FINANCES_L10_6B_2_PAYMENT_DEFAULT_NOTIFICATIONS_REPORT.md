# FINANCES L10.6B-2 — CE QU'ON ANNONCE, ET QUAND ON A LE DROIT DE L'ANNONCER

> Les notifications et l'activité sont des **conséquences** de la confirmation,
> jamais des conditions de la suspension.
>
> Un échec de notification ne doit jamais rouvrir, retarder ou annuler une
> suspension.
>
> `suspensionRequestedAt` ≠ `suspensionConfirmedAt`

---

## 1. La chaîne complète

```
 Stripe : le prélèvement échoue          (et Stripe seul gère ses tentatives)
        │
        ▼
 PaymentDefault ouvert, politique de grâce FIGÉE       (L10.6B-1)
        │
        ▼
 l'échéance tombe  →  GRACE_EXPIRED  →  suspensionRequestedAt
        │                                    │
        │                                    └── ce n'est qu'une DEMANDE.
        ▼                                        On n'annonce RIEN.
 PAYMENT_DEFAULT_CAUSE  →  SB Auto
        │
        ▼
 reconcileSiteStatus()   accessible = !technical && contractHonoured && !paymentDefault
        │
        ▼
 PROJECT_SITE_STATUS revient, portant l'instantané des trois causes
        │
        ▼
 suspensionConfirmedAt   ← LA TRANSITION. Gagnée atomiquement, une seule fois.
        │
        ├──▶ activité PROJECT_SITE_SUSPENDED_PAYMENT_DEFAULT
        ├──▶ notification aux administrateurs du projet
        └──▶ notification à l'équipe L.Y Solution
```

---

## 2. Pourquoi la demande ne suffit pas

`suspensionRequestedAt` dit ce que le Panel a **réclamé**. Rien de plus.

Entre la demande et la réalité, il y a un projet qui peut être hors ligne,
en cours de déploiement, ou simplement lent. Annoncer à un client que son site
est suspendu alors qu'il répond encore parfaitement, c'est produire un mensonge
daté et signé — et l'obliger à nous écrire pour nous le dire.

`suspensionConfirmedAt` dit ce qui **s'est produit**, parce que le site
lui-même l'a publié.

Quatre déclencheurs sont explicitement écartés : `invoice.payment_failed`,
`GRACE_EXPIRED`, `suspensionRequestedAt`, et l'émission de la cause. Aucun ne
prouve qu'un site est fermé.

---

## 3. Pourquoi `suspensionSource` n'est pas une preuve

C'est l'acquis de L10.6A, et B-2 en dépend entièrement.

```
 technicalActive      = true      accessible       = false
 paymentDefaultActive = true      suspensionSource = TECHNICAL
```

La cause dominante affichée est la maintenance. Notre cause financière est
pourtant **appliquée** : le site est bien fermé, et l'impayé y contribue. Un
code qui aurait écrit `if (suspensionSource === 'PAYMENT_DEFAULT')` n'aurait
rien annoncé du tout dans ce cas — le client n'aurait jamais su pourquoi son
site ne revenait pas après la maintenance.

La preuve est `causes.paymentDefault`, et rien d'autre. Un garde-fou statique
vérifie que le mot `suspensionSource` n'apparaît nulle part dans le module
d'annonce.

---

## 4. Exactement une fois — deux verrous, aucune primitive nouvelle

### Le premier verrou : la transition

L10.6A confirmait par un `updateMany` et rendait un compteur. Un nombre suffit
à dire « c'est confirmé » ; il ne suffit pas à dire **lequel vient de basculer**.
En relisant ensuite les incidents confirmés, on ne saurait pas distinguer ceux
que cet appel a fait basculer de ceux qu'un appel concurrent avait déjà
confirmés — et on enverrait deux fois le même e-mail.

La confirmation se fait donc incident par incident :

```js
findOneAndUpdate({ _id, suspensionConfirmedAt: null }, { $set: { suspensionConfirmedAt: vu } })
```

C'est l'écriture atomique qui arbitre. Un seul appelant obtient le document ;
celui-là seul annonce.

### Le second verrou : l'acte d'envoi

`PanelCapabilityOperation` porte déjà un index unique
`(projectId, capability, operationId)`. On ne crée rien : on **nomme** l'acte.

```
pd-susp-<paymentDefaultId>-<audience>-<index>
   │            │              │          └── destinataire
   │            │              └───────────── public (client | team)
   │            └──────────────────────────── incident
   └───────────────────────────────────────── transition
```

Aucune horloge n'entre dans cette clé. Un `Date.now()` produirait un acte neuf
à chaque projection, et huit livraisons enverraient huit e-mails. Rejoué, le
même identifiant rend `ALREADY_SENT` sans que rien ne reparte.

---

## 5. L'e-mail ne bloque jamais l'action

L'ordre est délibéré : **l'activité d'abord, les notifications ensuite**. Le
journal d'exploitation est ce que l'opérateur relira ; il ne doit pas dépendre
de la disponibilité d'un fournisseur d'e-mails.

Le module d'annonce **n'écrit jamais** sur `PanelPaymentDefault`. Ce n'est pas
une consigne, c'est vérifié : un garde-fou statique refuse la seule mention du
modèle dans ce fichier. Il ne peut donc, par construction, ni annuler une
confirmation, ni remettre un incident en `GRACE_EXPIRED`, ni rejouer une
transition métier pour forcer le départ d'un message.

### Les deux issues d'échec, et pourquoi on ne les confond pas

```
PROVIDER_UNAVAILABLE   502   le fournisseur a répondu NON
                             rien n'est parti — l'acte est FAILED, rejouable

TIMEOUT                504   l'issue est INDÉCIDABLE
                             le message a peut-être été accepté
                             l'acte est UNKNOWN — JAMAIS rejoué automatiquement
```

Ce verdict est produit par la passerelle (`replaySafe`, dérivé de l'issue). Le
module d'annonce le **relaie** sans jamais le recalculer — un garde-fou vérifie
qu'aucun `replaySafe = true|false` littéral n'existe dans ce chemin.

Rejouer aveuglément un envoi indécidable enverrait un second e-mail à un client
qui vient d'en recevoir un. On préfère un trou visible à un doublon invisible.

---

## 6. Le motif est canonique

```
reason      = PAYMENT_DEFAULT
reasonLabel = Défaut de paiement
```

Jamais un message brut du prestataire de paiement. « Your card was declined »
n'est ni du français, ni une information que le client peut exploiter, et il
peut porter des détails qui ne le regardent pas. Le motif est défini une fois,
exporté, et repris à l'identique dans l'activité et dans les deux messages.

---

## 7. Qui reçoit, et comment cette liste est construite

### Les administrateurs du projet

`PanelProjectMember`, rôle `ADMIN` — la projection en lecture seule de ce que
le projet publie. Un gérant qui part cesse de recevoir les messages sans que
personne n'ait à y penser. **Aucune liste parallèle n'est créée.**

Les comptes DEV sont exclus : ce sont des opérateurs techniques, souvent nous.
Repli sur l'adresse de contact publiée par le site, et si rien n'existe, on
refuse d'inventer.

### L'équipe L.Y Solution

`PanelUser`, les deux rôles. Un impayé qui ferme un site du parc est une
information d'exploitation, pas une information technique.

**Aucune adresse en dur.** Une adresse écrite dans le code survit à la
personne : elle continue de recevoir des alertes après son départ, et le
nouveau venu n'en reçoit aucune. La liste se recalcule à chaque envoi.

### La déduplication, qui manquait

`resolveRecipients` de L10.5 ne déduplique pas. Deux membres partageant une
adresse recevaient deux fois le même message, avec deux `operationId` distincts
— l'index d'unicité ne pouvait rien y faire, puisqu'il porte sur l'acte, pas
sur l'adresse. Il faut trancher **avant** de fabriquer les actes.

`normalizeRecipients` le fait : minuscules, espaces retirés, adresse invalide
traitée comme un **non-destinataire** plutôt que comme une erreur, doublon
fusionné. Une fiche mal remplie ne fait pas échouer une annonce.

### Sur les comptes « inactifs »

Ni `PanelUser` ni le `User` du projet ne portent `active`, `disabled` ou
`suspended` : un compte existe ou n'existe pas. Aucun filtre n'est appliqué, et
il ne faut pas en inventer un — un champ créé ici serait ignoré partout
ailleurs, authentification comprise, et ferait croire à une désactivation qui
n'existe pas. `activePanelUserFilter()` est le point unique où la règle se
posera le jour venu.

### Personne à prévenir

C'est un **état**, pas une erreur. La suspension reste confirmée, l'activité
reste écrite, l'équipe reste prévenue, et l'absence est tracée `NO_RECIPIENT`.

---

## 8. Pas de fausse réactivation

Une régularisation retire **une cause**. Elle ne rouvre pas un site.

```
 maintenance + impayé  →  le paiement est régularisé
 → causes.paymentDefault = false      la cause est retirée, et c'est constaté
 → technical = true, accessible = false
 → AUCUN message « site réactivé »
```

La confirmation de retrait n'exige pas `accessible === true` — exiger la
réactivation ferait attendre éternellement un événement qui ne nous concerne
pas. Mais elle n'autorise aucune annonce de réouverture : constater qu'une
cause a disparu n'est pas constater qu'un site répond.

---

## 9. Preuve durable et activité d'opérateur

Deux journaux, deux rôles, et il ne faut pas les confondre :

| | rôle | rétention |
|---|---|---|
| `PanelPaymentDefault` | la **preuve** de l'incident | jamais élagué |
| `PanelEvent` | l'**activité** de l'opérateur | borné (`timelineHistorySize`, 300) |

Un défaut de paiement de l'an dernier doit rester démontrable longtemps après
que son événement a quitté la chronologie. B-2 n'ouvre aucun chantier
d'archivage : il constate cette répartition et s'y conforme.

---

## 10. Les six rouges hérités

Ils bloquaient l'entrée du lot : on ne construit pas de nouveaux modèles sur un
registre déjà rouge.

Cause unique — **`db283f1` (L10.5)** a ajouté deux modèles au registre canonique
sans toucher aucun fichier de garde.

| Rouge | Invariant | État réel |
|---|---|---|
| `codes.length === 5` | le registre est exactement l'ensemble déclaré | 7 |
| `premier.created === 5` | l'amorçage pose tout le registre | 7 |
| `second.existing === 5` | rejeu non destructif | 7 |
| 5 documents en base | une ligne par modèle | 7 |
| 5 versions `BOOTSTRAP` | une version 1 par modèle | 7 |
| aucun projet nommé | le Panel reste générique | `'Garage Démonstration'` |

Le sixième est le plus parlant : le commit `19e048e` — *« le nom d'un client n'a
rien à faire dans la fondation du Panel »* — avait déjà corrigé cette classe de
faute. L10.5 l'a réintroduite, alors que les cinq autres modèles disaient déjà
« Entreprise Démonstration ».

**Correction, à la source, sans exclusion.** Échantillons réalignés. Le compte
reste **en dur** — c'est lui qui force à venir déclarer tout nouveau modèle —
mais il est désormais doublé d'une liste nominative vérifiée **dans les deux
sens** : un modèle non déclaré échoue aussi, ce qu'un simple compte ne disait
pas. Les modèles de B-2 y sont déclarés, jamais exclus.

---

## 11. Ce que les suites prouvent

**`finance-payment-default-notifications.test.js`, 77 contrôles** — scénarios
A à N : la demande qui n'annonce rien ; la confirmation réelle sous maintenance
dominante ; huit livraisons du même instantané pour une seule activité ; le
retour après absence par `applyIncoming`, la voie réelle du pont ; la panne
d'envoi qui ne défait rien ; l'absence de destinataire ; les doublons
d'adresses et le compte technique jamais destinataire ; la régularisation sous
maintenance sans fausse réouverture ; la prestation L10.5 exclue ; l'absence de
politique qui n'annonce rien ; le rendu avec accents, HTML hostile et champs
facultatifs ; et les onze garde-fous.

**`brevo-send-template-foundation.test.js`, 73 contrôles** et
**`architecture.test.js`, 31 contrôles** — verts, les six rouges fermés.

---

## 12. SB Auto n'a pas changé

Le §2 du cahier des charges attribue à SB Auto « la notification de ses
admins ». Le §3 interdit pourtant de déclencher sur l'émission de
`PAYMENT_DEFAULT_CAUSE` — précisément ce que SB Auto reçoit — et le §12 place
les notifications à l'étape 11, après la confirmation par le Panel.

Faire porter l'envoi par SB Auto aurait donc exigé qu'il déclenche sur
l'application de la cause, c'est-à-dire sur un déclencheur explicitement
interdit, et aurait créé un **second maître** de la question « quand a-t-on le
droit d'annoncer ? ».

Les administrateurs du projet sont donc une **audience**, pas un émetteur. SB
Auto reste l'autorité de l'accessibilité réelle — c'est son retour qui débloque
tout. C'est aussi le précédent de L10.5, où le Panel écrit déjà aux
administrateurs projet par `PanelProjectMember` et `email.send_template`.

Conséquence : ce lot ne modifie **aucun fichier** de SB Auto.
