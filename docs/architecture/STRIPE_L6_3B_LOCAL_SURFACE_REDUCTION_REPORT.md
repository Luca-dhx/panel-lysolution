# L6.3B — LES DERNIÈRES LECTURES, ET LE PORTAIL

> **Le verbe qui comptait vraiment.** Le portail client ne déplace pas d'argent,
> et c'est pour cela qu'il avait survécu à sept lots de migration financière. Il
> ouvre pourtant au client ses moyens de paiement, ses factures et ses
> abonnements — et le projet y passait le `customerId` de sa fiche locale. Une
> reprise de données, une copie de contrat, un identifiant hérité : l'écran
> s'ouvrait sur le dossier de quelqu'un d'autre, l'appel réussissait, et rien ne
> le signalait. C'est la seule fuite du parc qui n'aurait ressemblé à aucune
> effraction.

> **Ce que ce lot obtient.** Le pilote Stripe local passe de **quatre méthodes à
> une**. `API_CALLS` de 5 à 2 ; `SECRET_READS` inchangé à 2, et le rapport dit
> exactement pourquoi.

---

## 1. Combien d'appels Stripe locaux existaient au début ?

**Cinq**, hérités de L6.3A.

## 2. Lesquels ?

| # | Site | Verbe | R/W | Migré ? |
|---|---|---|---|---|
| 1 | `subscription.service.js:556` | `createBillingPortalSession` | **W** | **oui** → `billing.portal.create` |
| 2 | `billing.service.js:169` | `listInvoices` (backfill) | R | **oui** → `billing.invoice.list` |
| 3 | `billing.service.js:298` | `listInvoices` (recherche par URL) | R | **oui** → `billing.invoice.list` |
| 4 | `billing.service.js:263` | `retrieveInvoice` (rattachement DEV) | R | **oui** → `billing.invoice.list` |
| 5 | `subscription.service.js:603` | `retrieveInvoice` (enrichissement) | R | **oui** → `billing.invoice.retrieve` |
| — | `payment.service.js:512` | `retrievePaymentIntent` | R | **non** (Q4) |
| — | `providerConnectionTest.service.js` | `GET /v1/account` | R | **non** (Q4) |

Le site n°4 mérite un mot : il lisait une facture par un `in_…` **tapé à la
main** dans un outil d'administration. C'était le seul endroit du parc où un
identifiant saisi valait autorisation — le compte répondait, y compris pour une
facture qui n'était à aucun contrat du projet.

## 3. Combien restent ?

**Deux.**

## 4. Lesquels ?

**`retrievePaymentIntent`** — branche de repli de `reconcileLaunchFeePayment`,
pour un paiement ne portant qu'un `pi_…` sans session. Aucune capacité ne la
sert, et ce n'est pas un oubli : l'appartenance d'une intention se prouve par
filiation **depuis la session** (L10.4 l'adopte à la projection du revenu), or ce
chemin-ci part justement d'un paiement *sans* session. La migrer demanderait
soit une adoption d'un autre genre, soit de renoncer à ce filet.

**`GET /v1/account`** — le test de connexion du Manager. Il éprouve la clé
locale, alors que les paiements passent par celle du Panel : il est déjà
trompeur, et le Manager le dit depuis L6.3. Il disparaîtra avec la clé.

## 5. Customer Portal est-il centralisé ?

**Oui.** `billing.portal.create`, servie, avec appartenance vérifiée avant tout
contact fournisseur.

## 6. Qui choisit le Customer ?

**Le Panel, et lui seul.** Le contrat d'entrée est
`{ contractRef, returnUrl, operationId }.strict()` — il n'existe aucun champ par
lequel le projet pourrait désigner un client. Le Panel remonte au client par le
lien d'appartenance qu'il a lui-même écrit en L6.2D, via l'identité **dérivée**
du contrat : on ne cherche pas « un client de ce projet » mais « LE client de CE
contrat ». La nuance compte — un projet a plusieurs contrats, et servir le
mauvais client ouvrirait un dossier voisin au même projet.

Une garde de contrat le vérifie explicitement : un `customerId` glissé dans la
charge utile est refusé en `CAPABILITY_INPUT_INVALID`.

## 7. Cross-tenant prouvé ?

**Oui, et avec le compteur du fournisseur à l'appui.**

| Cas | Résultat |
|---|---|
| B ouvre le portail du contrat de A | refusé |
| contrat inexistant | **même code, même message** |
| B liste les factures de A | refusé |
| B lit une facture de A | refusé |

Et sur les quatre refus : **zéro contact avec Stripe**. C'est l'invariant de la
phase 6 — sans lui, la durée de réponse suffirait à apprendre quels contrats
existent chez les autres.

## 8. Les reads invoice sont-ils capacités ou projections ?

**Capacités.** La phase 4 demandait de préférer la projection ; l'audit montre
qu'elle ne pouvait pas servir ici, et la raison est directionnelle.

`INVOICE` est un type de synchronisation **projet → Panel** : c'est le projet qui
pousse ses factures, alimenté par ses propres webhooks Stripe. La projection du
Panel est donc un *reflet* de ce que le projet sait déjà — s'en servir pour
réparer un webhook manqué reviendrait à demander à l'écho de rappeler ce qu'on
n'a jamais dit.

Or ces trois lectures existent précisément comme **filet pour un webhook
manqué** : le backfill, la recherche par URL, l'enrichissement « payée ». Elles
ont besoin d'une lecture live.

Faire descendre les factures du Panel vers le projet serait possible — le Panel
les connaît depuis L10.3 — mais c'est un renversement de sens de
synchronisation, donc un lot à part entière, pas un effet de bord de celui-ci.

## 9. Pourquoi ?

Résumé de Q8 : la projection existe, mais elle va dans l'autre sens. Une lecture
live était nécessaire ; elle est donc étroite, et son appartenance est vérifiée
avant le fournisseur.

Un mot sur `billing.invoice.retrieve`, dont l'ordre diffère : seul Stripe sait à
quel client appartient une facture, donc la **filiation** se vérifie après
l'appel. Mais l'appartenance du **client** a été prouvée avant — le projet ne
peut donc sonder que dans le périmètre d'un contrat qui est déjà le sien. Une
facture d'un autre client est refusée du **même refus** qu'une facture
inexistante : distinguer les deux transformerait ce verbe en oracle.

## 10. Combien de SECRET_READS avant/après ?

**2 → 2.** Inchangé, et il faut le dire franchement : ce lot n'a pas réduit ce
compteur-là. Il a réduit ce qui le rendait *nécessaire*.

## 11. Quels fichiers lisent encore le secret ?

```
services/stripe/stripe.provider.js            → retrievePaymentIntent
services/providerConnectionTest.service.js    → GET /v1/account
```

## 12. Pourquoi ?

Voir Q4. Aucun service métier ne lit la clé — pas un fichier de `contract`,
`payment`, `subscription`, `billing` ou `reconciliation`. Les deux lecteurs sont
un adaptateur de transport réduit à une méthode, et un diagnostic.

## 13. Y a-t-il un fallback local ?

**Non. `LOCAL_STRIPE_FALLBACKS = 0`**, inchangé et re-vérifié.

Deux `catch` subsistent sur les chemins migrés, et ni l'un ni l'autre n'est un
repli :

- `syncContractInvoices` — Panel injoignable ⇒ on ne synchronise pas, et on ne
  retombe sur **rien**. La synchronisation est un filet ; un filet qui
  s'ouvrirait tout seul sur la clé locale ne serait plus un filet.
- `reconcileAndDescribe` — la lecture de facture est un **enrichissement**.
  « Payée » précise ce que l'abonnement dit déjà ; ne pas l'obtenir laisse la
  souscription comme source, sans fabriquer aucun état faux.

La garde statique cherche le motif `catch { provider.… }` dans le corps des
`catch` des six services migrés : zéro occurrence.

## 14. L6.3A webhook est-il intact ?

**Oui.** Aucun fichier de provisionnement n'a été touché. La garde vérifie
toujours qu'aucun code ne nomme `/v1/webhook_endpoints`, que `stripeWebhookAdapter`
reste supprimé, et que le driver n'exige aucun credential local. Les suites
`webhook-orchestrator`, `webhook-providers-uniformity`, `webhook-url-resolution`
et `webhook-run-report` sont vertes, et l'E2E L6.3A (61/0) l'est aussi.

## 15. Quel est le prochain verrou avant suppression du credential ?

**`retrievePaymentIntent`**, et lui seul pour le runtime métier.

La condition exacte : soit une capacité qui prouve l'appartenance d'une
intention **sans** partir d'une session — ce qui demande une voie d'adoption
nouvelle — soit la décision assumée de supprimer ce filet, en acceptant qu'un
paiement historique ne portant qu'un `pi_…` ne se réconcilie plus.

Ensuite seulement viennent, ensemble et non séparément :

1. retirer `retrievePaymentIntent` et le pilote entier ;
2. retirer `stripe` du `package.json` ;
3. faire pointer le test de connexion sur le Panel plutôt que sur la clé locale ;
4. **puis** fermer la route d'écriture du credential et masquer le champ dans le
   Manager.

L'ordre compte : fermer l'écriture avant que le runtime ait cessé d'en dépendre
casserait un projet neuf sans que rien ne l'explique.

## 16. Tests exacts

| Suite | Résultat |
|---|---|
| **`stripe-local-surface-e2e`** (nouvelle, Panel) | **45 / 0** |
| `stripe-local-surface` (SB Auto, étendue) | **70 / 0** |
| Panel — `stripe-control-plane` · `capability-gateway` | 138 / 0 · 120 / 0 |
| Panel — `stripe-resource-ownership` | 109 / 0 |
| Panel — `stripe-webhook-provisioning-e2e` (L6.3A) | 61 / 0 |
| SB Auto — `billing-flow` · `subscription-flow` | 46 / 0 · 80 / 0 |
| SB Auto — `npm test` | **1 échec, prouvé L10.5** |
| Panel — `tests/run-all.js` | **107 / 109** — les 2 rouges sont L10.5 |
| Panel frontend · manager · vitrine — `tsc` + build | OK · OK · OK |

L'E2E couvre les scénarios demandés : portail nominal (A), cross-tenant et
contrat inconnu avec **zéro appel** (B/C), isolation TEST/PROD (D), factures du
projet rendues entières (E), facture d'un autre client refusée (F), Panel muet
sans repli (H/I), surface locale (J), bilan des clés (K).

**Les rouges étrangers, prouvés plutôt qu'affirmés :**

- SB Auto, `contract-operations` — « aucun champ du document n'est lu sans être
  surveillé (**taxRate**) ». `taxRate` est ajouté à la projection par le diff
  **non committé** de L10.5 dans `projectSync.service.js`. Mon unique changement
  dans cette zone est le renommage d'une ligne dans `contract.admin.controller.js`.
- Panel, `brevo-send-template-foundation` (×5) et `architecture` (×1) — les deux
  nomment `panelEmailTemplateRegistry.js`, modifié uniquement par L10.5.

**Un rouge était le mien, et il a été corrigé.** Mon E2E importait
`stripe.provider.js` depuis le dépôt voisin pour constater sa surface. La suite
`architecture` l'a refusé, et elle avait raison : seuls trois outils d'atelier
déclarés franchissent la frontière entre dépôts, sans quoi elle s'effacerait un
import à la fois. L'invariant de surface vit désormais uniquement là où il
s'applique — dans `stripe-local-surface.test.js` de SB Auto.

## 17. Commits exacts

Voir la livraison ci-dessous.

## 18. Travaux parallèles préservés

**L10.5 est actif dans les DEUX dépôts**, non committé, et il a modifié des
fichiers que ce lot touche également.

**Fichiers réellement partagés — stagés par hunk :**

| Fichier | Mes hunks | Hunks L10.5 | Mixtes |
|---|---|---|---|
| `stripe/stripeCapabilities.js` | 5 | 2 (`paymentRequestId`) | **0** |
| `stripe/stripeAdapters.js` | 2 | 2 | **0** |

Aucun hunk mixte. Ils ont été stagés en reconstruisant « HEAD + mes hunks
seulement » dans l'index, jamais en stageant le fichier entier.

**Fichiers exclusivement L10.5**, ni lus pour décision, ni modifiés, ni
restaurés, ni stagés — Panel : `bridgeContract.js`, `finances.controller.js`,
`finances.routes.js`, `PanelProjectProjection.model.js`,
`PanelProviderRevenueFact.model.js`, `PanelSupervision.model.js`,
`panelEmailTemplateRegistry.js`, `finance/money.js`, `revenueProjection.service.js`,
`stripeRevenueNormalizer.js`, `recurringCostScheduler.js`,
`stripeCheckoutAuthority.js`, `projectors.js`, les deux specs, plus
`PanelPaymentRequest.model.js`, `finance/paymentRequests/` et
`finance-payment-requests.test.js`. SB Auto : `bootstrap.js`,
`billing.controller.js`, `billing.routes.js`, `panelBridge/bridgeContract.js`,
`projectSync.service.js`, les deux specs, `PaymentRequest.model.js`,
`services/billing/`.

`git add -A`, `git add .`, stash, reset et checkout globaux n'ont jamais été
employés.

---

## Compteurs — L6.3A → L6.3B

```
LOCAL_RUNTIME_STRIPE_API_CALLS       5  →  2      ↓
LOCAL_RUNTIME_STRIPE_SECRET_READS    2  →  2      =   (Q10)
LOCAL_STRIPE_FALLBACKS               0  →  0      =   ✔
PROJECT_STRIPE_SECRET_WRITES        ≠0  → ≠0      =   (phase 10 : aucune fermeture prématurée)

SURFACE DU PILOTE STRIPE             4  →  1      ↓
CAPACITÉS STRIPE SERVIES             9  → 12      ↑
LECTEURS DE LA CLÉ, SERVICES MÉTIER  0  →  0      =   ✔
```

## Décisions à relire

1. **Le portail n'a pas de clé d'idempotence, et c'est délibéré** (phase 3). Une
   session de portail est à usage unique et expire : lui poser une clé rendrait
   à un client revenu deux heures plus tard la **même URL**, c'est-à-dire une URL
   morte. La « protection » produirait la panne. Le transport refuse pourtant
   toute écriture sans clé depuis L6.1 — la dérogation est donc **explicite et
   demandée** (`nonDurableWrite: true`), jamais obtenue par omission, et un seul
   verbe la réclame. Le double clic se traite là où il se produit, pas ici.
   C'est l'option B de la phase 3.

2. **`billing.invoice.list` n'a pas été « ouverte » : elle a cessé d'exiger
   l'impossible.** Sa note disait vrai depuis L6.1 — « bloquée par l'absence de
   lien projet ↔ client » — mais L6.2D avait créé ce lien. Ce qui restait
   bloquant était son **contrat d'entrée**, qui demandait un `customerId` au
   projet. Il prend désormais le contrat.

3. **`CUSTOMER` entre dans les familles ancrables**, et il aurait pu dès L6.2D.
   L'oubli n'a rien coûté tant qu'aucune capacité n'exigeait cette famille.

4. **La vue de facture a gagné six champs** — total, taxe, échéance, date de
   paiement effectif, motif, abonnement — parce que `upsertInvoiceFromStripe`
   les **écrit**. Sans eux, migrer la lecture aurait appauvri la facture locale
   (montant hors taxe faux, dates vides) et personne ne l'aurait vu avant la
   première déclaration.

5. **`createBillingPortalSession` a été renommée `openBillingPortal`** côté
   projet. Le nom disait « crée une session Stripe » ; la fonction demande
   désormais au Panel. La garde statique a d'ailleurs signalé l'ambiguïté avant
   moi.

## Réserves

1. **`attachInvoiceFromUrl` est devenu plus coûteux.** Il lisait une facture en
   un appel ; il parcourt maintenant les contrats ayant un client, en demandant
   la liste de chacun. C'est un outil d'administration, pas un chemin
   utilisateur, et le parcours reste borné — mais sur un parc de plusieurs
   centaines de contrats, cela se sentira. En échange, une facture qui
   n'appartient à aucun contrat n'est plus trouvable, ce qui est la bonne
   réponse et non une limitation.

2. **`upsertInvoiceFromStripe` lit désormais deux formes** — l'objet brut des
   webhooks et la vue du Panel. Une normalisation unique les réconcilie, mais
   deux vocabulaires pour un même document restent une dette : le jour où un
   champ divergera, c'est le montant qui en souffrira.

3. **`SECRET_READS` n'a pas bougé.** Ce lot réduit les *appels*, pas les
   *lecteurs* : le pilote existe encore pour une seule méthode. Le compteur ne
   tombera qu'avec elle.

4. **Le double de test du projet ne rejoue pas l'appartenance.** Il sert les
   trois nouveaux verbes par contrat, ce qui suffit à prouver que le projet
   *demande* au lieu de lire ; l'appartenance elle-même est éprouvée côté Panel,
   dans l'E2E, avec deux projets réels.

---

STRIPE LOCAL SURFACE REDUCTION: PASS

GO L6.3C: YES
