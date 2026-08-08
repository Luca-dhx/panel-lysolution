# 61 — Projection métier : identité et contrat

> **Référence officielle.** Contrat ≥ 1.4.0.
> Code : `services/sync/projectors.js`,
> `models/PanelProjectProjection.model.js`,
> `services/registry/projectRegistry.service.js`.

---

## 1. Le Panel ne détient rien, il projette

Un projet est **propriétaire** de son identité commerciale et de son contrat.
Le Panel en garde une **projection** : une copie faite pour être affichée,
cherchée et agrégée sur un parc entier.

Conséquence directe, et elle est structurante : **le Panel n'écrit jamais** ces
données. Aucun écran ne les modifie, aucune route ne les accepte du frontend.
Un formulaire qui les éditerait ici ferait diverger deux systèmes en silence,
sans que personne ne sache lequel a raison.

## 2. Ce qui arrive, et par où

Les projections entrent par la **seule** porte existante :
`POST /bridge/v1/sync/push`. Il n'y a ni route dédiée, ni WebSocket, ni
canal parallèle — déduplication, dernier-écrit-gagne, anti-écho, accusés et
journal sont déjà écrits une fois pour toutes dans le cœur de synchronisation.

| Type d'entité | Contrat | Projeté dans |
|---|---|---|
| `DIAGNOSTIC` | 1.0.0 | `PanelDiagnostic` |
| `PROJECT_PRESENTATION` | **1.4.0** | `PanelProjectPresentation` |
| `CONTRACT` | 1.0.0 (projeté en **1.4.0**) | `PanelProjectContract` |
| `TEAM_MEMBER` | 1.4.0 | `PanelProjectMember` (clé `projectId` + `entityId`) |

Tout autre type reste **réservé** : accepté par le contrat, refusé à
l'application tant qu'aucun projecteur ne le réclame. La table `PROJECTORS`
est la définition unique de « ce que le Panel sait appliquer » ; un test de
conformité vérifie qu'elle et `APPLIED_ENTITY_TYPES` ne peuvent pas diverger.

## 3. Validation stricte, sans écriture partielle

Chaque payload passe par un schéma **fermé** (`.strict()`) avant toute
écriture. Un champ inconnu, une URL relative, un montant en euros au lieu de
centimes : refus immédiat, `REJECTED` + `ENTITY_PAYLOAD_INVALID`, **rien** n'est
écrit. L'accusé part quand même — une écriture invalide ne doit jamais boucher
la file d'un projet.

Les montants sont des **entiers en centimes**, avec leur devise. Un flottant
d'euros finit toujours par produire un « 49,00000000001 € » sur un écran client.

## 4. Fraîcheur

### Sur la projection : deux dates, deux propriétaires

- `sourceModifiedAt` — quand le **projet** a changé. C'est elle qui arbitre le
  dernier-écrit-gagne ; une écriture plus ancienne que l'état courant est
  ignorée, même si elle arrive après.
- `receivedAt` — quand le **Panel** l'a reçue.

### Sur la fiche : `runtime.lastBusinessSyncAt`, et c'est la source canonique

Écrite par `syncCore.applyIncoming` **après** qu'un projecteur métier a
réussi, avec l'heure du Panel. Sont métier `PROJECT_PRESENTATION`, `CONTRACT`
et `TEAM_MEMBER` (`BUSINESS_ENTITY_TYPES`, dérivé de la table des
projecteurs) ; `DIAGNOSTIC` en est exclu — c'est un journal de sondes, et le
laisser dater la fraîcheur ferait paraître « à jour » une fiche dont on n'a
reçu qu'un ping de test.

N'avancent **pas** cette date : un battement de cœur, une lecture de fiche, le
polling de l'écran, le manifeste, une découverte sans donnée nouvelle, une
écriture `REJECTED`, une écriture destinée à une autre instance.

> **Pourquoi persistée et non déduite.** On savait la déduire —
> `max(receivedAt)` sur les projections stockées, ce que fait encore
> `business.freshness.lastSyncAt`. Cette déduction ment dans trois cas : un
> tombstone efface la projection et fait **reculer** la date ; un
> `TEAM_MEMBER` reçu ne compte pas ; une réception qui n'a rien changé n'y
> laisse aucune trace. Une observation ne se recalcule pas.

`business.freshness.lastSyncAt` reste publié : c'est l'**âge de la
photographie affichée**, pas une preuve de réception. Les deux ne doivent pas
être lus l'un pour l'autre.

### Le battement de cœur ne prouve rien de tout cela

`lastHeartbeatAt` répond à « cette instance répond-elle ? ».
`lastBusinessSyncAt` répond à « quand ai-je reçu son état métier ? ». Un
projet dont l'entreprise ne change pas bat pendant des jours sans rien
projeter : sa fiche est vivante **et** n'a jamais rien reçu. L'écran écrit
« jamais reçues » — jamais « à jour ».

Un contrat qui disparaît (aucun contrat pertinent côté projet) arrive en
**tombstone** : `deleted: true`, `payload: null`. La projection est supprimée,
et l'écran affiche honnêtement « aucun contrat actif synchronisé » plutôt qu'un
état périmé.

## 5. Lecture

`GET /api/projects` et `/api/projects/:id` exposent les projections sous
`project.business.presentation` et `project.business.contract`. Le chargement
est groupé — deux requêtes pour tout le parc, jamais une par projet.

Le frontend fait **primer la projection poussée** sur le manifeste : le
manifeste est une photographie prise à la demande, la projection est un flux.
En l'absence des deux, l'écran le dit ; il n'invente pas de valeur par défaut.

## 6. Rafraîchissement de l'écran

La liste et la fiche se rafraîchissent seules toutes les **7 secondes**, en se
taisant quand l'onglet est caché et en repartant au retour sur la fenêtre.
Aucun WebSocket n'a été ajouté : à cette cadence et à cette échelle, il
coûterait une infrastructure permanente pour gagner quelques secondes.

## 7. « Rafraîchir le Manifest » — secours uniquement

L'action reste disponible dans l'espace Développeur. Ce **n'est plus le
parcours normal** : elle ne sert qu'à réconcilier après un incident, ou à
vérifier ce qu'un projet publie réellement. Le parcours normal est passif : le
projet pousse, le Panel affiche.
