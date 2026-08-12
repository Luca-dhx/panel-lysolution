# FINANCES L10.6A — INSTANTANÉ DES CAUSES ET BOUCLE DE CONFIRMATION

> Sous-lot volontairement étroit. Il ferme **une** frontière : le Panel demande une
> cause de suspension, SB Auto recalcule l'état réel, et le retour prouve sans
> ambiguïté quelles causes sont actives.
>
> Ni notification, ni interface, ni politique de grâce — ce sont les objets de L10.6B.

---

## 1. Pourquoi `suspensionSource` était insuffisant

Le contrat `PROJECT_SITE_STATUS` transportait le verdict et **la cause dominante**.
Cela suffit à un écran. Cela ne prouve rien.

Le cas qui l'établit :

```
technicalActive      = true        accessible       = false
paymentDefaultActive = true        suspensionSource = TECHNICAL
```

Notre cause financière **est** appliquée. Elle n'est simplement pas celle qu'on
affiche, parce que la maintenance prime. Un Panel qui aurait conclu de
`suspensionSource !== 'PAYMENT_DEFAULT'` que le projet l'avait ignorée se serait
trompé — et aurait relancé indéfiniment une demande déjà honorée.

La cause dominante n'est pas l'ensemble des causes.

---

## 2. Où vivent les trois causes

Dans **`SiteStatus.causes`**, côté SB Auto, écrit par `reconcileSiteStatus()` — le
seul endroit qui les évalue :

```js
site.causes = {
  technical:      technicalActive,
  contract:       !contractHonoured,
  paymentDefault: paymentDefaultActive,
};
```

`buildSiteStatusProjection()` ne **dérive rien** : il reflète.

Une première version calculait la cause contractuelle dans la projection, à partir
de `suspensionSource` et `relatedContractId`. C'était fragile, et c'était surtout
une **seconde formule** — deux formules d'accessibilité finissent par diverger. Le
moteur évalue, la projection publie.

---

## 3. Qui calcule l'accessibilité

SB Auto, et lui seul :

```js
accessible = !technicalActive && contractHonoured && !paymentDefaultActive;
```

Le Panel ne la recalcule jamais. Un garde-fou statique le vérifie.

`suspensionSource` reste ce qu'il a toujours été : **l'étiquette de la cause
dominante**, dans l'ordre `TECHNICAL → CONTRACT → PAYMENT_DEFAULT`. Le défaut de
paiement vient en dernier délibérément — le client doit lire en dernier la cause
sur laquelle il peut agir.

---

## 4. Comment le Panel confirme

Trois affirmations distinctes, jamais confondues :

| Affirmation | Preuve |
|---|---|
| La cause est appliquée | `causes.paymentDefault === true` |
| Le site est réellement fermé | `accessible === false` |
| La cause est retirée | `causes.paymentDefault === false` |

**Confirmation de fermeture** = les deux premières. Jamais
`suspensionSource === 'PAYMENT_DEFAULT'`.

**Confirmation de retrait** = la troisième **seule**. Exiger `accessible === true`
refuserait de constater un retrait parfaitement réel quand une maintenance
subsiste — et ferait attendre éternellement une réactivation qui ne nous concerne
pas.

Un snapshot **sans** `causes` — projection antérieure au lot — ne fait conclure à
rien : `NO_CAUSE_SNAPSHOT`. On refuse de supposer.

### Deux dates, deux sens

```
suspensionRequestedAt      le Panel a DEMANDÉ la fermeture
suspensionConfirmedAt      le projet l'a réellement APPLIQUÉE, site inaccessible
causeRemovalConfirmedAt    notre cause est retirée — pas « le site est rouvert »
```

La **première** confirmation fait foi. Un snapshot rejoué ne la fait pas rajeunir,
sans quoi l'écran afficherait une fermeture qui rajeunit à chaque livraison.

---

## 5. Push et pull — une seule voie

La confirmation est branchée dans **`applySiteStatus`**, le projecteur unique. Le
cœur de synchronisation l'emprunte dans les deux cas : livraison immédiate quand le
projet pousse, rattrapage quand le Panel tire après une absence.

Il n'existe aucune branche « si hors ligne ». Un garde-fou le vérifie.

Le désordre est traité par le cœur, pas par nous : le dernier-écrit-gagne écarte les
snapshots retardataires avant qu'ils n'atteignent le projecteur. Aucune horloge
concurrente n'a été introduite.

---

## 6. Ce que les suites prouvent

**Panel — `finance-payment-default-confirmation.test.js`, 44 contrôles**

Contrat de pont, confirmation simple, `TECHNICAL + PAYMENT_DEFAULT`, site accessible
ne confirmant rien, retrait sans réactivation, absence d'instantané, idempotence,
incident résolu non rouvert, garde-fous — et le **rattrapage offline par
`applyIncoming`**, la voie réelle du pont : le Panel n'invente aucune confirmation
avant le retour, converge après, et la date ne bouge plus.

**SB Auto — `site-status-payment-default.test.js`, 34 contrôles**

La conjonction des trois causes, la matrice complète, l'idempotence de la cause, la
projection qui publie les trois, et l'absence de tout statut forcé.

**Non-régression** : `bridge-conformity` 60/60 et 101/101, `finance-stripe-revenue`
142/142, `finance-payment-requests` 85/85, `finance-core` 138/138, `project-bridge`
74/74, `contract-immediate-cancel` 55/55, typecheck Panel.

---

## 7. Ce qui reste pour L10.6B

`graceDays` sur le Contract, les notifications projet et équipe, l'événement
d'activité, les interfaces Panel et Manager, la suspension manuelle.

L10.6A ne produit aucune de ces choses. Il produit la **vérité fiable** sur laquelle
elles pourront se brancher — savoir si la cause financière a réellement fermé le
site, ou non.
