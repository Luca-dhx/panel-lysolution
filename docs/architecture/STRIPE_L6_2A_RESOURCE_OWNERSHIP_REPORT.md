# Stripe — appartenance des ressources (L6.2A)

> **Le blocage de L6.1 est fermé.** Le Panel sait désormais répondre, sans
> ambiguïté et sans croire le projet sur parole : *« cette ressource Stripe
> appartient-elle à ce projet, dans ce monde ? »*
>
> **Aucune capacité Stripe n'est migrée.** Aucun paiement, aucune résiliation,
> aucun webhook déplacé.

---

## A. Baseline

| | Départ | Arrivée |
|---|---|---|
| Panel | `0fd3689` | commit L6.2A |
| SB Auto | `1bfe4e8` | **inchangé** — aucun fichier touché |

Un chantier parallèle modifiait `bridgeContract.js` dans les deux dépôts au
moment du travail. Ces fichiers n'ont pas été stagés.

---

## B. Inventaire des identifiants Stripe réels

Recherche sur les deux dépôts. **Douze champs**, trois modèles, tous côté
projet.

| Modèle | Champ | Env. porté | Créé par | Durable | Preuve d'appartenance ? |
|---|---|---|---|---|---|
| `Payment` | `stripe.checkoutSessionId` | `providerMode` + `environment` | projet | **oui** (index unique partiel) | via `contractId`, indirecte |
| `Payment` | `stripe.paymentIntentId` | idem | projet | oui | indirecte |
| `Payment` | `stripe.customerId` | idem | projet | oui | indirecte |
| `Payment` | `externalPaymentId`, `externalInvoiceId` | idem | projet | oui | indirecte |
| `Payment` | `idempotencyKey`, `attempt` | idem | projet | oui | non (identité d'acte) |
| `Contract` | `stripe.customerId` | — | projet | oui | indirecte |
| `Contract` | `stripe.launchFee.{checkoutSessionId,paymentIntentId}` | — | projet | **projection** | non |
| `Contract` | `stripe.subscription.{checkoutSessionId,subscriptionId,productId,priceId,latestInvoiceId}` | — | projet | **projection** | non |
| `Invoice` | `externalInvoiceId` + `provider` | `environment` | projet (sync) | oui (index unique) | indirecte |

**Aucun de ces champs n'atteint le Panel.** `PAYMENT` et `INVOICE` figurent au
vocabulaire du contrat de pont (`SYNC_ENTITY_TYPES`) mais **n'ont aucun
projecteur** côté Panel et ne sont poussés par personne : les projecteurs réels
sont `DIAGNOSTIC`, `PROJECT_PRESENTATION`, `CONTRACT`, `TEAM_MEMBER`,
`PROJECT_SITE_STATUS`.

Le Panel partait donc de zéro — d'où un registre, et non une lecture.

### B.1 Une corrélation existe, et elle est mécanique

`stripe.service.metadataFor()` écrit `metadata.contractId = String(contract._id)`
sur **tous** les objets créés. Et `projectSync` projette
`sourceContractId: String(contract._id)` vers le Panel.

C'est **exactement la même valeur**. Une chaîne
`objet Stripe → metadata.contractId → projection → projectId` est donc possible.
Elle sert de **preuve d'adoption**, jamais d'autorité — §F.

---

## C. Le modèle retenu

`PanelStripeResourceBinding` — `projectId`, `environment`, `resourceType`,
`resourceId`, `source`, `createdByOperationId`, `proof`, `revokedAt`.

**L'index porte toute la garantie :**

```
unique(environment, resourceType, resourceId)        ← SANS projectId
```

Retirer `projectId` de l'index est le cœur du lot. L'y inclure autoriserait deux
lignes pour la même ressource et deux propriétaires — précisément ce qu'on rend
impossible. L'unicité est arbitrée **par la base**, pas par une lecture suivie
d'une écriture : deux créations concurrentes ne peuvent pas gagner toutes les
deux.

**Immuable.** Aucune réassignation de `projectId`, aucune suppression. Une
ressource appartient définitivement au projet pour lequel elle a été créée : un
client Stripe ne change pas de propriétaire parce qu'on s'est trompé. Le seul
état terminal est `revokedAt`, qui **neutralise sans libérer l'identifiant** —
personne ne peut révoquer puis rebinder vers un autre projet.

**Types code-first, fermés** : `CUSTOMER`, `CHECKOUT_SESSION`, `SUBSCRIPTION`,
`PAYMENT_INTENT`, `INVOICE`, `PRODUCT`, `PRICE`. Les deux derniers n'ont aucune
capacité exposée mais seront créés par le Panel pour figer un tarif : un objet
créé sans lien serait un orphelin qu'aucun inventaire ne rattacherait.

> **Défaut trouvé en cours de route.** L'index unique n'existe pas encore quand
> Mongoose vient de se connecter — il se construit en tâche de fond. Une liaison
> écrite dans les premières secondes passait donc **sans** garantie d'unicité,
> et l'index refusait ensuite de se construire, en silence. `bindResource`
> attend désormais `Model.init()`, une fois. C'est la seconde fois que ce piège
> se présente dans ce parc (la première sur l'idempotence des webhooks Brevo).

---

## D. Règles d'ownership

Quatre verbes : `bindResource`, `assertOwnedResource`, `findBinding`,
`listOwnedResourceIds`.

- **Le `projectId` vient du contexte de la passerelle.** L'API n'a aucun
  paramètre par lequel proposer un propriétaire — vérifié sur le *source* du
  service, pas seulement sur son usage.
- **L'environnement vient du runtime.** Un même identifiant peut exister dans
  les deux mondes : ce sont deux objets, et les lectures sont cloisonnées.
- **Fail closed.** Pas de lien ⇒ refus.
- **Le refus ne renseigne pas.** « inconnue », « à un autre » et « révoquée »
  rendent le **même** code, le **même** message et le **même** statut. Les
  distinguer donnerait un oracle d'existence : on présente `cus_X`, et la nuance
  du refus dit s'il existe chez nous. Le motif réel part au journal, où il sert
  au diagnostic sans servir de sonde.

---

## E. Créations futures

```
Stripe rend cus_x → bindResource(projet, env, CUSTOMER, cus_x, operationId)
```

**La fenêtre entre les deux est irréductible** : Mongo et Stripe n'ont pas de
transaction commune. Elle est nommée plutôt que masquée, et rendue bénigne :

1. l'orphelin n'est accessible à **personne** — aucun projet ne peut s'en
   emparer ;
2. l'opération reste non résolue au registre d'idempotence et porte la même
   `Idempotency-Key` : la rejouer rend **le même** objet Stripe, et cette
   seconde tentative écrit le lien manquant ;
3. sans rejeu, l'orphelin reste inerte — un client Stripe sans abonnement ne
   coûte rien.

La récupération est donc **le rejeu de la même opération**, jamais une adoption
a posteriori sur foi d'un identifiant présenté. Prouvé par test.

---

## F. Historique — **doctrine C, puis B sous preuve**

**Refus du backfill automatique (A).** La seule corrélation disponible passe par
`metadata.contractId`, **modifiable depuis le tableau de bord Stripe**. En faire
une autorité reviendrait à laisser un champ éditable décider de qui possède un
abonnement.

**Retenu : aucune adoption automatique.** Les ressources créées avant la
migration restent sur le chemin local du projet — ce qu'un cutover progressif
suppose de toute façon.

Le modèle porte déjà `source: IMPORTED_WITH_PROOF` et un bloc `proof`
(`stripeMetadataContractId`, `matchedProjectionContractId`, `approvedBy`) pour
une adoption **explicite, vérifiée et imputable** : la métadonnée doit
correspondre à une projection de contrat que le Panel détient pour **exactement
un** projet, dans le bon monde, et un opérateur valide. Aucune commande
d'import n'est livrée ici : elle appartient au lot qui migrera une capacité,
parce qu'avant cela elle n'aurait rien à servir.

---

## G. Listes — doctrine

```
CONTRAINDRE la requête sortante      ✔  demander les factures d'un client possédé
FILTRER une réponse déjà obtenue     ✘  suppose qu'on a demandé plus que son dû
```

`listOwnedResourceIds` existe pour **contraindre**. Un filtre a posteriori
suppose qu'on a d'abord listé le compte entier, et il suffit d'un oubli dans le
filtre pour que le surplus traverse.

Conséquence pour `billing.invoice.list` : elle reste `migrated: false`, et son
contrat exige déjà **exactement un** `customerId` ou `subscriptionId` — jamais
une liste ouverte. `listSubscriptions` n'est pas contractualisée du tout : une
liste par compte n'a pas de forme sûre avec l'API actuelle.

---

## H. Metadata Stripe

**Retenu pour les créations futures**, comme aide de corrélation :

| Clé | Valeur | Pourquoi |
|---|---|---|
| `panelProjectId` | identifiant opaque du projet | rattachement d'un événement |
| `panelOperationId` | identité de l'acte | rapprochement avec le registre |
| `panelEnvironment` | `TEST` \| `PROD` | lever une ambiguïté de monde |

**Jamais une autorité** : la métadonnée est modifiable. Elle corrobore le
registre, elle ne le remplace pas. Aucune donnée personnelle, aucun montant,
aucun nom de client.

---

## I. Routage webhook futur

```
événement → resourceId → findBinding(env, type, id) → projectId
```

Prouvé par test : un événement portant l'abonnement de A désigne A, celui portant
le client de B désigne B, une ressource inconnue ne désigne **personne**, et un
événement de l'autre monde non plus.

Le routage part de **l'identifiant**, pas de la métadonnée. **Aucun endpoint n'a
été créé, aucun secret changé.**

---

## J. Environnement et ouverture commerciale

Deux questions distinctes : *« à qui est-ce ? »* et *« a-t-on le droit d'agir ? »*.

Prouvé : bloquer une écriture financière en `PREOPENING` **ne change rien** au
lien — ni son existence, ni sa source. Et le registre ne lit jamais
`commercialState` ni `activeMode` — vérifié sur son source.

---

## K. E2E A/B et attaques

`tests/stripe-resource-ownership.test.js` — **85 assertions**, deux projets, un
compte Stripe.

| Scénario | Résultat |
|---|---|
| A possède `cus_A`, B possède `cus_B` | liens distincts |
| B tente de lier `cus_A` | `STRIPE_RESOURCE_ALREADY_BOUND` (409), une seule ligne |
| A lit `cus_B` / B lit `cus_A` | refusés |
| **attaque** : identifiant Stripe valide non possédé | 403, message indistinguable |
| `projectId` / `environment` en entrée de capacité | refusés par le contrat |
| même identifiant dans les deux mondes | deux liens, aucune fuite entre eux |
| ressource révoquée récupérée par un autre | refusée |
| inventaire de diagnostic | des nombres, **aucun identifiant** |

---

## L. Idempotence et concurrence

Le registre générique existant (`operationRegistry`) **n'est pas dupliqué** :
`createdByOperationId` fait la jonction, et un lien se retrouve par son
opération sans connaître la ressource.

- rejeu de la même liaison → `ALREADY_BOUND`, jamais un doublon ;
- **8 liaisons concurrentes** de la même ressource → 8 succès, **une** création,
  **une** ligne ;
- **deux projets en course** sur la même ressource → un gagne, l'autre reçoit un
  conflit explicite, jamais un silence.

---

## M. Fichiers

**Panel** — `models/PanelStripeResourceBinding.model.js`,
`services/integratedApi/stripe/stripeResourceBinding.js`,
`tests/stripe-resource-ownership.test.js` *(nouveaux)* ·
`stripeResourceOwnership.js`, `tests/stripe-control-plane.test.js` *(rebranchés
sur le registre)* · ce document.

**SB Auto** — aucun fichier.

---

## N. Réserves

1. **Aucune capacité n'est servie.** Le registre existe ; les adaptateurs qui
   l'appelleront appartiennent à L6.2B.
2. **Aucun lien n'est peuplé.** Le premier naîtra de la première création par le
   Panel. Tant qu'il n'y en a pas, tout est refusé — comportement voulu.
3. **La fenêtre Stripe/lien reste ouverte** (§E). Elle est bornée et réparable,
   pas supprimée.
4. **L'adoption des ressources historiques n'est pas outillée.** Le modèle la
   prévoit ; la commande viendra avec le lot qui en aura besoin.
5. **Le registre ne se purge pas.** Un lien vit aussi longtemps que le projet.
   Une politique de rétention n'a pas lieu d'être tant qu'aucune ressource n'est
   créée par le Panel.

---

## O. Verdict

**STRIPE RESOURCE OWNERSHIP: PASS**

- source de vérité unique ✔
- accès inter-projets mécaniquement impossible (index, pas discipline) ✔
- environnement strict ✔
- doctrine de création définie, adoption refusée sous sa forme automatique ✔
- listes : contrainte à la source, sinon bloquées ✔
- routage webhook futur adossé au binding ✔
- aucune capacité financière activée ✔
- tests A/B verts, périmètre vert ✔

**GO L6.2B: YES**

Le prérequis n°1 de L6.2B est levé. Ce que L6.2B devra faire, dans l'ordre :
brancher `billing.checkout.create` sur le registre (créer, puis lier), prouver
la convergence après un `UNKNOWN`, et seulement ensuite ouvrir les lectures.
