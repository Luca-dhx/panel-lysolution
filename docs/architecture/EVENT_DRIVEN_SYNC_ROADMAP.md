# Synchronisation événementielle temps réel — audit et feuille de route

> **Statut : L0 ✅ · L1 ✅ · L2 ✅ · L4 ✅ · L8 ✅ — les deux sens sont
> événementiels, et le dernier état métier lu à distance est devenu une
> projection.**
>
> Ce document est le constat, pas la promesse. Chaque affirmation renvoie au
> fichier qui la porte, et les chiffres viennent d'une exécution réelle —
> `Panel/tests/event-driven-sync-baseline.test.js`, deux backends réels, aucun
> appel manuel à `flushOutbox`, `applyIncoming`, `syncNow` ou `scheduleProjection`.

## Journal des lots

| Lot | Statut | Ce qui a changé |
|---|---|---|
| **L0** | ✅ | Reproduction et instrumentation. La cause isolée : `logo`/`favicon` refusés par un schéma fermé. |
| **L1** | ✅ | Le descripteur média entre au contrat de `PROJECT_PRESENTATION`, est persisté et exposé. Payload d'une instance réelle : **accepté en 352–562 ms**. |
| **L2** | ✅ | Un refus n'est plus un ACK : il est classé, conservé, publié au Panel, et **réaffirmé jusqu'à convergence sans aucun geste**. |
| **L4** | ✅ | Le Panel LIVRE au lieu d'attendre. `saveCompany` → journal → push immédiat. **T0→T5 médiane 35 ms, pire 103 ms** ; la sauvegarde rend la main en 20 ms devant un projet à 5 s. |
| **L8** | ✅ | `PROJECT_SITE_STATUS` : l'accessibilité du site et la protection contractuelle deviennent une projection. Le **troisième motif** (lecture métier synchrone depuis un écran) disparaît du produit. Aller-retour commande Panel → projet → Panel : **622 ms**. |
| L3, L5 → L7, L9 → L17 | ⏸ | Voir §T. |

---

## 0. Le résultat qui change la question

Le symptôme rapporté était : « je renomme l'entreprise dans le Manager,
j'enregistre, et deux minutes plus tard le Panel affiche encore l'ancien nom ».

L'hypothèse de travail était une **latence** : une poussée qui attend un tic
périodique. Elle est fausse.

**Sur un projet SANS logo, la chaîne montante est déjà événementielle et rapide.**
Mesures réelles, ordonnanceur allumé à une cadence agressive (sync 150 ms,
heartbeat 200 ms) pour maximiser l'entrelacement :

```
T0  commit métier            0 ms
T1  outbox durable créée   528 ms   ← dont 500 ms de fenêtre de regroupement
T2  requête HTTP partie    532 ms
T3  reçue par le Panel     554 ms
T4  projection écrite      ~554 ms
T5  API Panel expose       564 ms
    tentatives : 1 · statut final : ACKNOWLEDGED
```

Six enregistrements successifs : 549 / 547 / 543 / 544 / 543 / 542 ms, alors
que 22 cycles périodiques tournaient en parallèle. Aucune livraison n'a attendu
un tic.

**Sur un projet AVEC un logo — c'est-à-dire toute instance de production — la
chaîne montante ne livre RIEN. Jamais.**

```
[sync-incident] code=OUTBOX_WRITE_REJECTED step=push
  entityType=PROJECT_PRESENTATION reason=ENTITY_PAYLOAD_INVALID
statut de l'écriture : REJECTED · tentatives 1
la fiche affiche encore : « … » (valeur précédente)
```

Ce n'est pas « lent ». C'est **définitif et silencieux**. Réenregistrer ne
répare rien : le payload est le même, donc le refus aussi.

> **Le correctif `runPushCycle` annoncé précédemment est RÉEL et il TIENT.**
> Le harnais l'exerce désormais sous concurrence permanente et la poussée
> immédiate n'est jamais affamée. Il corrigeait une intermittence de ≤ 2 min ;
> il ne pouvait pas corriger le défaut qui restait, parce que ce défaut n'est
> pas un problème d'ordonnancement.

---

## A. Architecture actuelle réellement observée

### A.1 — SB Auto → Panel (montant)

| # | Maillon | Fichier · fonction | Sync/async | Durable | Déclenchement | Skip possible | Retry | Erreur visible |
|---|---|---|---|---|---|---|---|---|
| 1 | mutation | `manager/src/pages/CompanyPage.tsx` → `PUT /api/company` | sync | oui (Mongo) | geste utilisateur | non | — | 4xx/5xx à l'écran |
| 2 | écriture | `backend/src/utils/singletonFactory.js` `saveWithRetry` → `doc.save()` | async | oui | immédiat | non | 1 reprise sur `VersionError` | oui |
| 3 | hook | `models/Company.model.js` `pre/post('save')` | sync | non | immédiat | non | — | non (ne lève jamais) |
| 4 | annonce | `utils/syncNotifier.js` `notifyEntitySaved` | sync | non | immédiat | non | — | non |
| 5 | décision | `services/projectBridge/syncTriggers.js` `trigger` | sync | non | immédiat | **oui** — si `isSyncWired()` faux, ou chemin non surveillé | — | incident `TRIGGER_FAILED` |
| 6 | regroupement | `projectSync.service.js` `scheduleProjection` | async | **non** | `setTimeout(500 ms)` | oui (rafale absorbée — voulu) | — | non |
| 7 | construction | `projectSync.service.js` `buildPresentationProjection` | async | non | après 500 ms | non | — | incident `PROJECTION_BUILD_FAILED` |
| 8 | mise en file | `persistence/mongoOutboxAdapter.js` `enqueueProjection` | async | **oui** | immédiat | dédup par `writeId` (voulu) | — | incident `OUTBOX_ENQUEUE_FAILED` |
| 9 | demande de poussée | `projectSync.service.js` `requestFlush()` → `bridgeScheduler.runPushCycle` | async, non attendu | — | immédiat | non — garde + drapeau `pushDemandeeEnCours` | — | incident `CYCLE_FAILED` |
| 10 | réclamation | `mongoOutboxAdapter.claimBatch` | async | oui | immédiat | filtre `nextAttemptAt <= now` | — | — |
| 11 | transport | `panelBridge/PanelClient.js` `HttpPanelClient.pushChanges` | async | — | immédiat | non | timeout 10 s → `PANEL_UNREACHABLE` | incident |
| 12 | endpoint | `Panel/backend/src/routes/bridge.routes.js` `POST /bridge/v1/sync/push` | async | — | — | auth `requireBridgeAuth` | — | 4xx typé |
| 13 | validation | `Panel/.../bridge/bridgeContract.js` `syncPushRequestSchema` | sync | — | — | — | — | oui |
| 14 | idempotence | `services/sync/syncCore.service.js` `PanelSyncReceipt` + `needsRepair` | async | oui | — | `DUPLICATE` | — | — |
| 15 | LWW | `syncCore.applyIncoming` (comparaison `modifiedAt` + génération) | async | oui | — | `IGNORED` | — | — |
| 16 | **projection** | `services/sync/projectors.js` `applyProjectPresentation` | async | oui | — | **REJETÉ si payload non conforme** | **aucun** | incident côté projet uniquement |
| 17 | fraîcheur | `syncCore` → `registryStore.stampBusinessSync` | async | oui | si entité métier | — | — | — |
| 18 | lecture | `services/registry/registryStore.js` (`activePresentation`) + `projectRegistry.describeProject` | async | — | à la demande | — | — | — |
| 19 | écran | `frontend/src/lib/useProjects.ts` `useLiveQuery` **7 s** | — | — | **timer** | onglet caché | — | non |

### A.2 — Panel → SB Auto (descendant)

| # | Maillon | Fichier · fonction | Nature | Déclenchement |
|---|---|---|---|---|
| 1 | mutation | `Panel/frontend` · Mon entreprise → `saveCompany` | — | geste utilisateur |
| 2 | écriture + version | `services/company/company.service.js` | durable | immédiat |
| 3 | journal | `syncCore.emitChange({ entityType: 'DEV_COMPANY', audience: null })` | **durable** | immédiat |
| 4 | — | **RIEN** | — | **le Panel s'arrête ici** |
| 5 | tirage | `SB Auto · bridgeScheduler.runSyncCycle` → `PanelBridge.pullUpdates` | **timer 30 s** | `PANEL_SYNC_INTERVAL_S` |
| 6 | application | `panelConfiguration.service.js` `applyCompanyChange` → `applyCompanyProfile` | durable | — |
| 7 | ACK | `Identity.appliedConfiguration.companyVersion`, relu au heartbeat | déclaratif | 60 s |
| 8 | écran | `manager/src/pages/SupportInfoPage.tsx` `useResource` | **chargement unique** | **F5 requis** |

**Le sens descendant n'a aucun maillon événementiel.** Le journal est durable,
la livraison est un sondage.

---

## B. Cause reproduite du délai SB Auto → Panel

**Ce n'est pas un délai. C'est un refus permanent, et il est structurel.**

Le projet publie, « en additif », le **descripteur complet** du média à côté de
l'URL historique :

```js
// SB Auto 06/backend/src/services/projectBridge/projectPresentation.service.js:126
// ADDITIF : le descripteur complet, à côté de l'URL historique.
...(logo ? { logo } : {}),
...(favicon ? { favicon } : {}),
```

Le Panel valide ce payload avec un schéma **fermé** :

```js
// Panel/backend/src/bridge/bridgeContract.js:432
export const projectPresentationPayloadSchema = z
  .object({ companyName, tagline, logoUrl, faviconUrl, contacts, project, network })
  .strict();          // ← `logo` et `favicon` sont des clés INCONNUES
```

Chaîne d'exécution constatée, et non déduite :

```
company.save()
 → scheduleProjection(PROJECT_PRESENTATION)
 → buildPresentationProjection()  payload = {companyName, logoUrl, logo, contacts, project, network}
 → outbox PENDING
 → runPushCycle → flushOutbox → POST /bridge/v1/sync/push          (532 ms)
 → syncCore.applyIncoming
 → PROJECTORS.PROJECT_PRESENTATION → parsePayload(…strict…)  ✗ ENTITY_PAYLOAD_INVALID
 → ACK = REJECTED
 → mongoOutboxAdapter.acknowledge(writeId, 'REJECTED')
 → l'entrée SORT de la file · attempts = 1 · plus AUCUN rejeu
```

Trois propriétés en font un défaut invisible plutôt qu'une panne :

1. **rien ne le rejoue** — `deferAfterFailure` ne concerne que le transport ;
   un refus passe par `acknowledge`, et la file se vide ;
2. **réenregistrer ne répare rien** — la source reproduit le même payload, donc
   le même refus (vérifié : `réenregistrer ne répare rien`) ;
3. **l'incident n'existe que côté projet** — `OUTBOX_WRITE_REJECTED` dans les
   journaux de SB Auto. Le Panel, lui, n'affiche rien : la fiche n'est pas
   « en erreur », elle est simplement figée.

### B.2 — Pourquoi les tests existants ne l'ont pas vu

- `project-company-live-e2e.test.js` : instance de test **sans logo** —
  `publishableProjectDescriptor` rend `null`, les clés `logo`/`favicon` sont
  omises, le payload est conforme. Le test est juste ; sa fixture ne ressemble
  pas à une production.
- Le même fichier appelle `inst.syncNow()` dans `laisserConverger()`. Il
  n'aurait donc pas non plus détecté une poussée immédiate cassée — sauf sur le
  seul contrôle `le projet a poussé de lui-même`.
- `spec-drift.check.mjs` compare les specs OpenAPI entre dépôts. Les deux specs
  sont **identiques et toutes deux incomplètes** : ni l'une ni l'autre ne décrit
  `logo`/`favicon`. Le contrôle est donc vert. Personne ne compare le **code
  émetteur** à la **spec**.

### B.3 — Le même risque, un champ plus loin

`logoUrl: z.string().url()`. Le projet le construit par
`logo?.url ?? resolvePublicAssetUrl(company?.logos?.header, backendUrl)`. Une
instance sans `network.backendUrl` configuré peut produire un chemin **relatif**
— refusé par `.url()`, avec exactement les mêmes conséquences. Non observé en
production à ce jour, mais du même genre et de la même gravité.

---

## C. Cause du délai Panel → SB Auto

Aucun défaut : une **absence**. Le Panel écrit son journal et n'appelle personne.

- `Panel/backend/src/bridge/ProjectBridgeClient.js:161` expose
  `pushChanges({ changes })` vers `POST /api/project-bridge/v1/sync/push` ;
- côté projet, `controllers/projectBridge.controller.js:64` `syncPush` applique
  réellement (`acknowledgePanelChanges`) ;
- **aucun appelant** : `grep -rn "pushChanges" Panel/backend/src` ne rend que la
  définition.

Le délai nominal est donc `PANEL_SYNC_INTERVAL_S` = **30 s** (120 s avant le
dernier correctif), auquel s'ajoute **un F5 manuel** sur la page Aide.

> **La primitive de livraison descendante existe déjà, complète des deux côtés,
> et n'est pas branchée.** C'est le point le moins coûteux de toute la feuille
> de route.

---

## D. Timers actuels et classification

| Timer | Lieu | Cadence | Classe | Cible |
|---|---|---|---|---|
| `scheduleProjection` | SB `projectSync.service.js:347` | 500 ms | **COALESCE** | conservé |
| `heartbeatTimer` | SB `bridgeScheduler.js:260` | 60 s | HEARTBEAT | conservé |
| `syncTimer` → `runSyncCycle` | SB `bridgeScheduler.js:261` | 30 s | **LIVE_DELIVERY (descendant)** + RETRY (montant) | **doit devenir RETRY/RECONCILIATION seul** |
| ngrok watcher | SB `bootstrap.js:558` | dev | OTHER | hors sujet |
| `eventScheduler` | Panel `services/events/eventScheduler.js:52` | configurable | OTHER (métier événements) | hors sujet |
| deploy-worker heartbeat | Panel `scripts/deploy-worker.js:96` | 5 s | OTHER (déploiement) | hors sujet |
| `useLiveQuery` projets | Panel `lib/useProjects.ts:26` | **7 s** | **UI_REFRESH (LIVE_DELIVERY de fait)** | à compléter par SSE |
| `useLiveQuery` événements | Panel `lib/useEvents.ts` | 7 s | UI_REFRESH | idem |
| `useResource` Aide | SB `SupportInfoPage.tsx:44` | **aucun** | **absent** | à créer |

**Après refonte, un seul élément doit rester classé `LIVE_DELIVERY` sur timer :
aucun.**

---

## E. Primitives existantes réutilisables — et il y en a beaucoup

| Primitive | Où | Verdict |
|---|---|---|
| outbox durable + `writeId` déterministe + backoff borné | `mongoOutboxAdapter.js` | **c'est LE bus durable montant. Le garder.** |
| garde + coalescence de poussée | `bridgeScheduler.runPushCycle` | **correct, mesuré sous concurrence. Le garder.** |
| journal de synchronisation Panel (`seq`, curseur, audience, anti-écho) | `syncCore.emitChange` / `pullForProject` | **c'est LE bus durable descendant. Le garder.** |
| client Panel → projet | `ProjectBridgeClient.pushChanges` | **existe, non branché** |
| endpoint projet | `POST /api/project-bridge/v1/sync/push` | **existe, fonctionne** |
| idempotence de réception | `PanelSyncReceipt` + `needsRepair` | garder |
| LWW + génération d'instance | `syncCore` + `projectGeneration.js` | garder |
| incidents typés | `syncIncidents.js` | garder, à étendre |
| `useLiveQuery` (sondage invisible) | Panel frontend | garder comme **filet**, pas comme livraison |

> **Aucun EventBus, DomainEventBus, SyncBus, EventDispatcher, nouvelle queue ni
> nouveau journal n'est nécessaire.** Les deux bus durables existent, dans les
> deux sens. Ce qui manque est un **appelant** dans le sens descendant, une
> **politique de rejeu** pour les refus, et un **canal d'écran**.

---

## F. Primitives à supprimer / déprécier

| Élément | Verdict | Motif |
|---|---|---|
| `PANEL_SYNC_INTERVAL_S` comme chemin nominal descendant | **DÉPRÉCIER ce rôle** | devient réparation ; la valeur peut remonter à 60–120 s |
| `POST /api/company/republish` | **CONSERVER** en diagnostic | déjà sans écran ; ne rien changer |
| clé `logoUrl`/`faviconUrl` | **CONSERVER** | compatibilité ascendante avec un Panel ancien |
| `useResource` sur la page Aide | **REMPLACER** | ne peut pas être live |
| rien d'autre | | |

---

## G. Contrat d'événement — actuel vs cible

Le contrat transporte déjà : `writeId`, `entityType`, `entityId`, `deleted`,
`payload`, `modifiedAt`, `emitter`. Le `projectId` est **implicite** (porté par
le jeton de pont) et l'`environment` est vérifié à l'appairage puis à
l'application.

| Champ visé | État | Action |
|---|---|---|
| `writeId` | présent, déterministe | rien |
| `entityType` / `entityId` | présents | rien |
| `projectId` | implicite (jeton) | **rien** — le rendre explicite ouvrirait une usurpation |
| `environment` | vérifié en amont | **rien** |
| `revision`/`version` | `modifiedAt` + génération | rien |
| `operation` | `deleted: true/false` | rien |
| `changedAt` | `modifiedAt` | rien |
| `payload` | présent | **corriger le schéma (§B)** |

> **Le contrat n'a pas besoin d'évoluer.** Ce qui manque n'est pas un champ,
> c'est l'accord entre l'émetteur et le validateur sur un champ **déjà émis**.

---

## H. Catalogue des données live

### PROJET → PANEL

| Donnée | Autorité | entityType | Trigger | Durable | Push immédiat | ACK | Fallback | État |
|---|---|---|---|---|---|---|---|---|
| nom, slogan, contacts | PROJET | `PROJECT_PRESENTATION` | `COMPANY_PATHS` | oui | oui | APPLIED | reconcile démarrage | **CASSÉ (§B)** |
| logo / favicon (descripteur) | PROJET | idem | `logos`,`media` | oui | oui | REJECTED | aucun | **CASSÉ (§B)** |
| URLs réseau | PROJET | idem | `NETWORK_PATHS` | oui | oui | APPLIED | idem | cassé par ricochet |
| contrat, document, tarifs | PROJET | `CONTRACT` | `CONTRACT_PATHS` | oui | oui | APPLIED | idem | **OK** |
| équipe | PROJET | `TEAM_MEMBER` | par membre | oui | oui | APPLIED | `reconcileTeam` | **OK** |
| `siteStatus` / protection | PROJET | — | — | — | — | — | — | **ABSENT du bus** |
| destination / environnement | PROJET | via `network` de la présentation | — | oui | oui | — | manifeste | cassé par ricochet |
| médias projet | PROJET | descripteur dans la présentation | `media` | oui | oui | — | `logoUrl` | **CASSÉ (§B)** |
| versions / `appliedConfiguration` | PROJET | heartbeat | 60 s | non | non | déclaratif | — | **timer** |

### PANEL → PROJET

| Donnée | Autorité | entityType | Durable | Push immédiat | ACK | État |
|---|---|---|---|---|---|---|
| entreprise développeur, branding, contacts, médias | PANEL | `DEV_COMPANY` | oui (journal) | **non** | `appliedConfiguration.companyVersion` | **pull 30 s** |
| configuration API intégrée | PANEL | `INTEGRATED_API_CONFIG` | oui | **non** | idem | **pull 30 s** |

`siteStatus` / protection contractuelle passe par l'invocation d'opérations
(`/operations/:id/invoke`), pas par le bus. C'est un **appel de commande**, pas
une projection — la distinction est saine et doit être conservée ; ce qui manque
est la **projection de l'état résultant** vers le Panel.

---

## I. Sémantique ACK

Elle est **déjà correcte** et ne doit pas être affaiblie.

| État | Signification aujourd'hui |
|---|---|
| `SENT` | `PanelOutboxEntry.status = SENDING`, `lastAttemptAt` posé |
| `RECEIVED` | HTTP 200 — **jamais compté comme appliqué** |
| `APPLIED` | `ACK_STATUS.APPLIED` — le projecteur a écrit |
| `ACKNOWLEDGED` | `PanelOutboxEntry.status = ACKNOWLEDGED` |
| `FAILED` | `REJECTED` + `OUTBOX_WRITE_REJECTED` |
| `RETRY_PENDING` | `PENDING` + `nextAttemptAt` futur |

`HTTP 200 = appliqué` n'existe nulle part : `flushOutbox` lit `results[].status`
par `writeId`, pas le code HTTP. **Ce qui manque n'est pas la sémantique, c'est
la conséquence du `FAILED` : rien ne le rejoue et personne ne le voit.**

---

## J. Stratégie offline

Vérifiée et correcte dans le sens montant : `OFFLINE A → B → C` converge sur C,
sans rejouer B, avec `lastBusinessSyncAt` daté de la réception de C.

La distinction demandée entre **projection d'état** et **événement non
coalescible** est déjà portée par le modèle :

- `PROJECT_PRESENTATION`, `CONTRACT` = **snapshots**, coalescés par `writeId`
  déterministe (état identique → même identifiant) — LWW légitime ;
- `TEAM_MEMBER` = **collection**, une ligne par `entityId`, tombstone explicite
  pour un départ — jamais coalescé entre membres.

> Ne pas uniformiser. Le seul point à ne pas perdre de vue : un refus (§B) sort
> l'écriture de la file, ce qui casse la convergence offline pour cette entité.
> Corriger §B rétablit aussi celle-ci.

---

## K. Stratégie crash / restart

| Fenêtre | Couverture actuelle |
|---|---|
| `save()` réussi, crash avant `enqueue` (≤ 500 ms de coalescence + build) | **`reconcileAll()` au démarrage** — répare |
| `enqueue` réussi, crash avant push | `PENDING` en base — repart |
| `SENDING`, crash avant ACK | `releaseOrphans()` après 2 min |
| ACK perdu en vol | relivraison → `DUPLICATE` côté Panel |
| projection écrite, crash avant `PanelSyncReceipt` | relivraison → `needsRepair` applique |

**Une fenêtre de perte existe et doit être nommée** : `Company.save()` et
`PanelOutboxEntry` ne sont **pas** atomiques, et il n'y a pas de transaction
distribuée. Le filet est `reconcileAll()` au démarrage — il est réel et
suffisant pour les snapshots (l'état courant est reconstruit), mais **il ne
reconstruit pas un événement non coalescible** : un `TEAM_MEMBER_REMOVED` perdu
dans cette fenêtre est rattrapé par `reconcileTeam()`, pas par le rejeu de
l'événement. C'est acceptable ; ce n'est pas gratuit, et ce n'est pas caché.

---

## L. Stratégie frontend live

| Canal existant | Verdict |
|---|---|
| WebSocket | **aucun** dans les deux dépôts |
| SSE / EventSource | **aucun** |
| `useLiveQuery` 7 s | présent, invisible, robuste |
| page Aide SB Auto | **chargement unique** |

**Décision, après audit : SSE.** Le besoin est strictement descendant
serveur → navigateur, il n'y a aucune infrastructure temps réel à préserver, et
`bridge-conformity` interdit déjà toute nouvelle socket sortante — un SSE est un
flux **entrant** servi par le backend, il ne touche pas cette table.

Pipeline cible :

```
SB Auto save → Panel applyIncoming → projection écrite
                                   → emitUiEvent(projectId)
                                   → GET /api/projects/stream (SSE)
                                   → le navigateur invalide et refait UN GET
                                   → l'écran change
```

Le backend reste la source de vérité : l'événement SSE ne transporte **aucun
payload métier**, seulement `{ projectId, entityType }`. `useLiveQuery` reste en
place comme filet (cadence pouvant remonter à 30 s).

---

## M. TEST / PROD

Aucune régression constatée. Les gardes sont en place et vérifiées :
concordance à l'appairage (`BRIDGE_ENVIRONMENT_MISMATCH`), refus à
l'application (`ENVIRONMENT_MISMATCH`), `projectId` scellé par le jeton,
génération d'instance dans le `writeId`.

**Point de vigilance pour L4** : une livraison descendante immédiate devra
parcourir les instances appairées et pousser **par `projectId`**, avec le jeton
de CETTE instance et l'`audience` du journal. Ne jamais diffuser en bloc sur une
liste construite depuis `projectKey` ou `logicalProjectKey`.

---

## N. Médias

L'autorité (`PANEL` / `PROJECT`) est correcte et ne doit pas bouger. Le
descripteur est déjà la bonne unité de transport : il porte `authority`, `url`,
`sha256`, `version`, dimensions — de quoi invalider un cache sans recopier le
fichier.

**Le défaut §B est précisément un défaut de média** : le projet transporte son
descripteur, le Panel ne l'accepte pas. Le corriger, c'est ouvrir le
cache-busting et la détection de remplacement côté Panel — pas seulement
débloquer le nom.

---

## O. Utilisateurs / équipe

Déjà tranché dans le code : **`TEAM_MEMBER` par membre**, avec tombstone, plus
`reconcileTeam()` comme réparation. Ne pas construire de snapshot `TEAM`
concurrent.

---

## P. Contrat / protection

`CONTRACT` circule correctement. `siteStatus` et la protection contractuelle
**ne circulent pas** : le Panel les pilote par invocation d'opération et relit
l'état. C'est un trou de fraîcheur — pas de correction, mais pas de live non
plus. À traiter en L8, en ajoutant une **projection d'état** (le projet pousse
son `siteStatus` après changement), sans toucher au canal de commande.

---

## Q. Forensics

Reconstructible aujourd'hui : `writeId`, `entityType`, `entityId`, `createdAt`,
`lastAttemptAt`, `attempts`, `nextAttemptAt`, `lastError`, `status`
(`PanelOutboxEntry`) ; `receivedAt` (`PanelSyncReceipt`).

Manque : `appliedAt` et `ackedAt` distincts côté projet (`acknowledgedAt`
existe), et **la trace d'un refus n'existe que dans les journaux du projet**.

**Défaut mineur constaté** : l'incident `OUTBOX_WRITE_REJECTED` rapporte
`attempt=0` alors que la base porte `attempts=1` — `entry.attempts` est lu sur
le document `lean()` d'avant l'incrément de `claimBatch`. À corriger en L14.

---

## R. E2E requis

| Test | État |
|---|---|
| `SB_AUTO_SAVE_PUSHES_IMMEDIATELY` | **livré** (L0) |
| `NO_POLLING_REQUIRED_FOR_NOMINAL_LIVE_SYNC` | **livré** (L0, ordonnanceur 150 ms) |
| `PUSH_IN_FLIGHT_DOES_NOT_DROP_NEW_CHANGE` | **livré** (L0, rafale A→D) |
| `HEARTBEAT_DOES_NOT_ADVANCE_BUSINESS_ACK` | **livré** (L0) |
| `PROJECT_MEDIA_AUTHORITY_IS_PRESERVED` (payload accepté) | **livré en négatif** (L0 : refus reproduit) |
| `PANEL_SAVE_PUSHES_IMMEDIATELY` | à écrire (L4) |
| `OFFLINE_CHANGES_CONVERGE_ON_RECONNECT` | partiel (`project-company-live-e2e`) |
| `ACK_MEANS_PERSISTED_NOT_SENT` | à écrire (L5) |
| `ACK_LOSS_IS_IDEMPOTENT` | à écrire (L5) |
| `PROCESS_CRASH_DOES_NOT_LOSE_DURABLE_EVENT` | à écrire (L13) |
| `TEST_EVENT_NEVER_TOUCHES_PROD` / inverse | partiel (`project-live-business-sync`) |
| `MANIFEST_DOES_NOT_OVERRIDE_LIVE_STATE` | existe |
| `USER_CHANGE_IS_LIVE` / `CONTRACT_CHANGE_IS_LIVE` / `COMPANY_CHANGE_IS_LIVE` | à écrire (L6–L8) |
| `FRONTEND_UPDATES_WITHOUT_MANUAL_REFRESH` | à écrire (L11–L12) |
| `PERIODIC_SYNC_IS_REPAIR_NOT_DELIVERY` | à écrire (L15) |

---

## S. Mesures de latence baseline

Machine de test : Windows 11, Node v22.19.0, `mongodb-memory-server`, deux
processus SB Auto + un Panel, tout en boucle locale.

| Cas | T0 → T5 |
|---|---|
| ordonnanceur éteint | **375–416 ms** |
| ordonnanceur 150 ms, 6 itérations | **542–603 ms** (pire cas 603) |
| rafale A→B→C→D | **563–579 ms** |
| projet avec logo | **jamais** (refus définitif) |

La fenêtre de regroupement de 500 ms domine le budget. **P95 < 2 s est
atteignable sans effort sur environnement sain**, mais ce chiffre n'est pas un
SLA tant qu'il n'est pas mesuré sur le VPS réel, avec HTTPS, nginx et latence
réseau.

---

## T. Roadmap par lots

### L0 — Reproduction / instrumentation ✅ LIVRÉ

- **Objectif** : produire la preuve par le chemin d'exécution réel.
- **Livré** : `Panel/tests/event-driven-sync-baseline.test.js` ; commandes
  additives du harnais (`startScheduler`, `stopScheduler`, `schedulerState`,
  `outboxDump`, `setCompanyLogo`, `buildPresentation`).
- **Invariant** : aucun appel manuel à `flushOutbox`, `applyIncoming`,
  `syncNow`, `scheduleProjection`, `recordAppliedConfiguration`.
- **GO/STOP** : ✅ le symptôme est reproduit et daté.

### L1 — Réparer le contrat de payload (LE défaut) ✅ LIVRÉ

**Ce qui a été fait**

| Fichier | Changement |
|---|---|
| `Panel/backend/src/bridge/bridgeContract.js` | `projectPresentationPayloadSchema` accepte `logo` / `favicon` (`mediaDescriptorSchema`, nullable). Le schéma reste **`.strict()`**. |
| `Panel/backend/src/models/PanelProjectProjection.model.js` | la projection PERSISTE les deux descripteurs. |
| `Panel/backend/src/services/sync/projectors.js` | le projecteur les écrit (`?? null` — l'absence publie la suppression). |
| `Panel/backend/src/services/registry/registryStore.js` | `presentationOf` rend aussi `favicon` (il lisait déjà `logo`, qui valait toujours `null`). |
| specs OpenAPI (maître + miroir) | nouveaux composants `MediaDescriptor` et **`ProjectPresentationPayload`** — le payload qui a dérivé n'était documenté nulle part. |

**Doctrine média retenue** — le **descripteur fait autorité**, `logoUrl` /
`faviconUrl` sont sa projection **héritée**, conservées pour un Panel antérieur.
Aucune vérité concurrente : `logoUrl` est littéralement `logo.url`.

**Doctrine URL retenue — option B, et elle était DÉJÀ appliquée.** L'émetteur ne
publie une adresse que si elle est absolue et joignable ; sinon il omet le champ
(`resolvePublicAssetUrl` rend `null`, `publishableProjectDescriptor` refuse un
média non absolu). Aucune ligne n'a donc été changée côté émetteur : la règle a
été **verrouillée par un test** (`PROJECT_PRESENTATION_MEDIA_URL_POLICY_IS_CANONICAL`,
quatre configurations) plutôt que réécrite.

**Le contrôle qui manquait** — `Panel/tests/payload-drift.check.mjs` construit
la projection avec le **vrai constructeur** de SB Auto et la soumet au **vrai
schéma** du Panel, sur quatre configurations dont « entreprise avec logo ».
`spec-drift` comparait les deux specs entre elles ; elles étaient identiques
**et toutes deux muettes** sur ce payload. Personne ne comparait l'émetteur au
récepteur — c'est fait.

### L1 — spécification d'origine (conservée)

- **Objectif** : que la présentation d'un projet réel soit acceptée.
- **Problème corrigé** : §B — refus définitif et silencieux.
- **Fichiers** : `Panel/backend/src/bridge/bridgeContract.js`
  (`projectPresentationPayloadSchema`) ; `Panel/backend/src/services/sync/projectors.js`
  (persister le descripteur) ; `Panel/backend/src/models/PanelProjectProjection.model.js` ;
  les deux `spec/PanelBridge.openapi.yaml` + `ProjectBridge.openapi.yaml`
  (maître = SB Auto).
- **Décision** : ajouter `logo` / `favicon` au schéma comme objets **optionnels**
  et **fermés** (`authority`, `url`, `mime`, `size`, `width`, `height`,
  `sha256`, `version`, `updatedAt`, `role`, `publicationState`, `external`,
  `mediaId`). Ne PAS ouvrir le schéma avec `.passthrough()` : la fermeture est
  ce qui protège des fuites de champs (cf. `teamMemberPayloadSchema`).
- **Migration** : aucune. Champs additifs, nullables.
- **Compatibilité** : ascendante des deux côtés — un Panel ancien continue de
  refuser (statu quo), un projet ancien n'envoie pas les clés.
- **Tests** : `COMPANY_CHANGE_IS_LIVE` avec logo ; `PROJECT_MEDIA_AUTHORITY_IS_PRESERVED` ;
  retourner la section « avec logo » de L0 en positif ; garde anti-drift (voir L17).
- **Risque** : faible. **Impact : c'est le lot qui débloque le symptôme signalé.**
- **GO/STOP** : GO immédiat, indépendant de tout le reste.

### L2 — Un refus ne doit plus être définitif ni muet ✅ LIVRÉ

**La matrice d'échec**, tenue par `SB/services/panelBridge/rejectionPolicy.js` :

| Classe | Déclencheurs | Retenté | Cadence | ACK ? | Incident |
|---|---|---|---|---|---|
| `TRANSIENT` | `PANEL_UNREACHABLE`, timeout, `INTERNAL`, 5xx | oui | 15 s → 1 h (transport) | non | `OUTBOX_PUSH_FAILED` |
| `COMPATIBILITY` | `ENTITY_PAYLOAD_INVALID`, `INVALID_PAYLOAD`, `ENTITY_TYPE_UNSUPPORTED`, `CONTRACT_VERSION_UNSUPPORTED` | **oui** | 5 min → 6 h | **non** | `OUTBOX_WRITE_REJECTED` |
| `SECURITY` | `ENVIRONMENT_MISMATCH`, `UNAUTHORIZED`, `FORBIDDEN`, `NOT_PAIRED` | oui, très lentement | 1 h → 24 h | **non** | idem |
| `BUSINESS` | refus de fond | oui | 5 min → 6 h | **non** | idem |
| `IDEMPOTENT` | `APPLIED`, `DUPLICATE`, `IGNORED` | — | — | **oui, résolu** | — |

Un code inconnu tombe en `COMPATIBILITY` : on conserve, on montre, on réaffirme
lentement. « Inconnu donc on jette » est précisément le défaut fermé ici.

**Ce qui a changé**

- `acknowledge(writeId, status, code)` — un refus ne pose **plus**
  `acknowledgedAt`. C'était lui qui livrait l'entrée à l'index TTL : un refus
  s'effaçait donc au bout de sept jours, et la preuve disparaissait avec la
  donnée.
- L'entrée d'outbox **est** le dossier d'incident : `failureClass`,
  `lastErrorCode`, `firstRejectedAt`, `rejections`. Aucun modèle nouveau — un
  `SyncIncident` séparé aurait dupliqué l'identité de l'écriture.
- `reviveDueRejections()` — appelée au début de chaque vidange, comme
  `releaseOrphans`. **C'est le seul chemin de réparation, et il vit dans le
  cycle périodique : son rôle légitime.**
- `describeOutboxHealth()` → publié dans `bridgeStats` du battement → lu par le
  Panel (`businessSync`) → affiché.

**Réparation sans geste** : le destinataire redevient compatible, personne ne
réenregistre, la projection est appliquée. **Mesuré : 91 ms.**

**Visibilité** — une ligne, et seulement quand il y a quelque chose à dire :

```
Panel · fiche projet          Manager · Connexion Panel
Données métier  ✓ reçues      État du pont   CONNECTED
Livraison       ⚠ bloquée     Livraison      ⚠ 1 écriture refusée
                PROJECT_PRESENTATION refusé   — PROJECT_PRESENTATION
                depuis le …                     (ENTITY_PAYLOAD_INVALID)
```

`UNKNOWN` n'est **jamais** rendu comme `HEALTHY` : un projet antérieur au champ
ne publie pas `rejectedCount`, et son silence ne prouve rien.

### L2 — spécification d'origine (conservée)

- **Objectif** : `REJECTED` cesse d'être une perte silencieuse.
- **Fichiers** : `SB/persistence/mongoOutboxAdapter.js` (`acknowledge`),
  `SB/services/panelBridge/PanelBridge.js` (`#flushDurable`),
  `SB/services/panelBridge/syncIncidents.js`.
- **Contenu** : conserver l'entrée `REJECTED` avec son motif (déjà le cas), et
  **la faire remonter** : compteur exposé par `getStatus()`, visible sur l'écran
  « Connexion Panel » du Manager, et transporté dans `bridgeStats` du heartbeat
  pour que le Panel puisse dire « cette instance a N écritures refusées ».
- **Ne PAS faire** : rejouer un refus en boucle. Un payload invalide le reste.
- **Tests** : `ACK_MEANS_PERSISTED_NOT_SENT`, `REJECTED_WRITE_IS_VISIBLE`.
- **Dépendances** : aucune. **Risque** : faible.

### L3 — SB Auto → Panel immédiat : figer l'acquis

- **Objectif** : empêcher la régression de `runPushCycle`.
- **Contenu** : promouvoir L0 en test de non-régression obligatoire ; interdire
  par test d'architecture que `flush` soit recâblé sur `runSyncCycle`.
- **Dépendances** : L0. **Risque** : nul.

### L4 — Panel → SB Auto immédiat ✅ LIVRÉ

**Aucun endpoint, aucun contrat, aucun modèle nouveau.** Les deux bouts
existaient et n'avaient jamais été reliés : il manquait un appelant.

| Fichier | Rôle |
|---|---|
| `services/sync/syncDelivery.service.js` | **le dispatcher** — audience, garde d'environnement, concurrence bornée, timeout court, classification, traces |
| `services/sync/syncCore.js` `emitChange` | **une ligne** : `scheduleDelivery(entry)` après `PanelSyncJournalEntry.create` |
| `tests/architecture.test.js` | le dispatcher rejoint la table FERMÉE des détenteurs du client de pont |

**Le point de branchement est générique par construction.** `emitChange` est le
seul endroit où naît une écriture destinée à un projet : entreprise, API
intégrée, et tout type futur passent par là sans recâblage. Un
`pushProject(...)` recopié après chaque producteur se serait dégradé au premier
oubli — et cet oubli aurait été silencieux, la donnée arrivant simplement trente
secondes plus tard.

| Propriété | Valeur | Mesure |
|---|---|---|
| latence T0→T5 | médiane **35 ms**, p95 **96 ms** | 10 enregistrements consécutifs |
| sauvegarde non bloquante | **20 ms** devant un projet à 5 s | transport instrumenté |
| concurrence | **6** simultanées, jamais dépassée | 53 destinataires, 3 traînards |
| timeout | **4 s** (contre 10 s par défaut du client) | — |
| rafale A→D | **112 ms** jusqu'à D | 4 saves d'affilée |

**Le journal reste la source de vérité.** Le push est un accélérateur, et rien
d'autre : projet éteint, Panel interrompu avant la tentative, transport en
erreur — l'écriture reste au journal, le tirage la reprend, et l'utilisateur
n'a jamais rien vu. Éprouvé port fermé, transport en panne, et double
livraison.

**Trois tests existants ont dû être INVERSÉS, pas affaiblis.** Ils encodaient la
doctrine d'avant — « publier ne force pas le projet », « avant le rattrapage
l'instance n'est pas à jour ». Leur prémisse n'était pas une garantie : c'était
la conséquence de l'absence de livraison. Ils provoquent désormais une panne
RÉELLE (port fermé, base coupée) là où ils comptaient sur une lenteur, ce qui
rend chacun strictement plus fort qu'avant.

**Ce que L4 ne couvre pas, et pourquoi** — voir §L4bis.

### L4bis — Ce que le transport porte, et ce que le produit ne projette pas encore

Le dispatcher est générique ; le catalogue métier, lui, ne l'est pas encore.
L'état réel, sans extrapolation :

| Donnée | Panel → projet | État |
|---|---|---|
| entreprise développeur, branding, contacts, **médias** | `DEV_COMPANY` | ✅ **livré immédiatement** |
| configuration d'API intégrée | `INTEGRATED_API_CONFIG` (nominatif) | ✅ **livré immédiatement** |
| **contrat / protection contractuelle** | *aucun `emitChange`* | ⚠️ **passe par un autre canal** |
| **utilisateurs / équipe** | *aucune projection descendante* | ⚠️ **n'existe pas** |

**Contrat et protection** ne transitent pas par le journal : le Panel les pilote
par **invocation d'opération** (`contractActions.service.js` →
`POST /operations/:id/invoke`), un appel synchrone et déjà immédiat. C'est une
**commande**, pas une projection, et la distinction est saine — l'autorité de
`SiteStatus` reste chez le projet. Un test `CONTRACT_CHANGE_PUSHES_IMMEDIATELY`
au sens de L4 n'aurait donc rien à observer : il n'y a pas d'entrée de journal à
livrer. Ce qui manque est l'inverse — la projection de l'état RÉSULTANT du
projet vers le Panel — et c'est le lot **L8**.

**Utilisateurs** : `TEAM_MEMBER` circule projet → Panel uniquement. Il n'existe
aucune projection d'utilisateurs du Panel vers un projet. Le transport est prêt
à la porter le jour où le produit la définira ; l'inventer dans L4 aurait été
fabriquer un contrat métier sous couvert d'infrastructure.

### L4 — spécification d'origine (conservée)

- **Objectif** : supprimer le sondage descendant du chemin nominal.
- **Fichiers** : `Panel/backend/src/services/sync/syncCore.service.js`
  (`emitChange` → notifier), un nouveau
  `Panel/backend/src/services/sync/syncDelivery.service.js`,
  `Panel/backend/src/bridge/ProjectBridgeClient.js` (déjà prêt).
- **Contenu** : après `emitChange`, livrer immédiatement aux instances
  concernées via `pushChanges`, **en respectant** `audience`, `originProjectId`
  (anti-écho), le jeton de CETTE instance, l'environnement et la version de
  contrat. Échec → rien : le curseur du projet rattrapera au cycle suivant. La
  livraison immédiate est un **accélérateur**, jamais la garantie.
- **Endpoints** : aucun nouveau. `POST /api/project-bridge/v1/sync/push` existe.
- **Tests** : `PANEL_SAVE_PUSHES_IMMEDIATELY`, `TEST_EVENT_NEVER_TOUCHES_PROD`,
  `PANEL_PUSH_FAILURE_FALLS_BACK_TO_PULL`.
- **Risque** : moyen — c'est la première sortie réseau du Panel vers N projets.
  Borner la concurrence, timeout court, jamais bloquant pour `saveCompany`.
- **GO/STOP** : GO après L1 (pour ne pas mélanger deux chantiers de contrat).

### L5 — ACK / retry / idempotence

- Formaliser les six états (§I) dans un seul vocabulaire partagé, exposer
  `describeWriteTrace(writeId)`. Tests `ACK_LOSS_IS_IDEMPOTENT`.
- **Dépendances** : L2, L4.

### L6 — Company / présentation
Fermeture de la boucle : test `COMPANY_CHANGE_IS_LIVE` de bout en bout avec
logo, sur les deux sens. **Dépend de L1.**

### L7 — Users / team
`USER_CHANGE_IS_LIVE`. Rien à construire : vérifier et figer. **Dépend de L3.**

### L8 — Contract / protection ✅ LIVRÉ

**Ce que l'audit a démontré avant toute ligne de code**

`SiteStatus` n'avait ni hook, ni projection, ni projecteur, ni modèle côté
Panel. La carte du Panel appelait le PROJET **en direct**, à chaque affichage
(`api.getContractOperations`). Ce n'était ni une commande, ni une projection :
un **troisième motif architectural**, et le seul du produit.

La documentation affirmait pourtant que la protection venait « de la projection
de cette instance ». **C'était faux** — la phrase est corrigée.

**Le catalogue retenu : un seul type nouveau**

| | |
|---|---|
| `PROJECT_SITE_STATUS` | agrégat `SiteStatus`, **SNAPSHOT** |
| champs | `accessible`, `status`, `suspensionSource`, `reason`, `suspendedAt`, `contractProtectionEnabled`, `technicalSuspension` |
| déclencheur | `post('save')` du modèle → `SITE_STATUS` → `scheduleProjection` |
| pourquoi PAS dans `CONTRACT` | une suspension **technique** n'est pas un fait contractuel |
| pourquoi PAS `CONTRACT_PROTECTION_TOGGLED` | micro-événement ; le snapshot résultant suffit |

**Le point de branchement existait déjà.** Les **3 seuls** `site.save()` du
dépôt vivent dans `siteEnforcement.service.js`, et les **9 chemins** de mutation
convergent vers `reconcileSiteStatus()`. Aucune centralisation à construire.

**L'invariant, éprouvé de bout en bout**

```
commande Panel → mutation projet → reconcileSiteStatus → persistance
→ PROJECT_SITE_STATUS → outbox durable → push immédiat → projecteur Panel
→ projection persistée → interrupteur
```

L'interrupteur **n'adopte jamais** la réponse de la commande — pas même la
valeur « constatée » qu'elle rapporte. Tant qu'il la croyait, il affichait un
état que rien n'avait persisté et qu'un rechargement contredisait.

| Mesure | ms |
|---|---|
| projection livrée dès l'appairage | 52 |
| protection basculée depuis le Manager | 434 |
| **aller-retour complet commande Panel** | **622** |
| suspension technique | 555 |

Le plancher est la fenêtre de regroupement de 500 ms — délibérée, et conservée :
un formulaire qui écrit trois champs ne doit produire qu'une photographie. La
cible « médiane < 250 ms » de la spécification est donc **incompatible** avec
cette protection ; ce qui compte est acquis — plus aucun cycle de 30 s.

**Le troisième motif a disparu, et l'audit le prouve.** Tous les écrans ont été
passés en revue : il ne restait que celui-ci. La sonde d'URL du wizard
s'exécute avant qu'un projet existe (découverte) ; le catalogue d'opérations
répond à « que puis-je DEMANDER maintenant ? » — une **capacité**, pas un état.

**TEAM_MEMBER : rien à inventer.** L'audit montre qu'il est déjà projeté,
déclenché par les hooks de `User`, exposé par `loadProjectTeam` et **rendu**
par `<TeamCard>` sur la fiche. Complet de bout en bout.

### L8 — spécification d'origine (conservée)
`CONTRACT_CHANGE_IS_LIVE` (existe presque) + **nouvelle projection de
`siteStatus`/protection** projet → Panel (§P). **Dépend de L1, L5.**

### L9 — Media
Exploiter le descripteur enfin reçu : cache-busting par `version`/`sha256` côté
Panel. **Dépend de L1.**

### L10 — Autres projections métier
`appliedConfiguration` hors du heartbeat, vers une projection dédiée.

### L11 — Live frontend Panel (SSE)
`GET /api/projects/stream`, émission depuis `applyIncoming` après écriture,
invalidation côté `useLiveQuery`. `FRONTEND_UPDATES_WITHOUT_MANUAL_REFRESH`.
**Dépend de L1, L3.**

### L12 — Live frontend SB Auto
Même canal pour la page Aide (aujourd'hui `useResource`, sans rafraîchissement).
**Dépend de L4.**

### L13 — Offline / crash recovery
`PROCESS_CRASH_DOES_NOT_LOSE_DURABLE_EVENT`, `OFFLINE_CHANGES_CONVERGE_ON_RECONNECT`
sous ordonnanceur réel. Documenter la fenêtre non atomique (§K).

### L14 — Forensics / observabilité
Vue développeur (§19 de la mission) ; correction du `attempt=0` (§Q).

### L15 — Suppression du faux live
Reclasser `syncTimer` en réparation, remonter `PANEL_SYNC_INTERVAL_S`,
`useLiveQuery` à 30 s. Test `PERIODIC_SYNC_IS_REPAIR_NOT_DELIVERY` :
ordonnanceur **coupé**, la livraison doit quand même arriver dans les deux sens.
**Dépend de L4, L11, L12.**

### L16 — E2E inter-dépôts
Un seul scénario, deux backends réels, les deux sens, avec logo, sans aucun
appel interne.

### L17 — Documentation / drift / recette
`EVENT_DRIVEN_SYNC.md` canonique ; mise à jour des `ARCHITECTURE_CONTEXT.md` ;
**et surtout un contrôle `payload-drift`** : comparer les clés réellement
produites par les constructeurs de projection du projet aux schémas du Panel.
C'est le contrôle dont l'absence a laissé passer §B pendant tout ce temps.

---

## U. Graphe de dépendances

```
L0 ✅
 │
 ├─────────────► L1 (schéma payload)  ◄── LE LOT CRITIQUE
 │                │
 │                ├──► L6 Company
 │                ├──► L9 Media
 │                └──► L8 Contract/protection ──┐
 │                                              │
 ├─► L2 (refus visible) ──┐                     │
 │                        ├──► L5 ACK/retry ────┤
 ├─► L3 (figer montant) ──┤                     │
 │        └──► L7 Team    │                     │
 │                        │                     │
 └─► L4 (descendant immédiat) ───────────────────┤
          │                                     │
          ├──► L12 live front SB Auto           │
          │                                     │
     L11 live front Panel ◄── L3                │
          │                                     │
          └──────────► L15 suppression du faux live
                              │
                        L13 crash/offline
                              │
                        L14 forensics
                              │
                        L16 E2E · L17 doc/drift
```

**L1 est sur le chemin critique et n'a aucune dépendance.**

---

## V. Compatibilité / ordre de déploiement

| Combinaison | Comportement |
|---|---|
| ancien SB Auto + **nouveau Panel (L1)** | ✅ le Panel accepte `logo`/`favicon` ; un projet qui ne les envoie pas reste conforme |
| **nouveau SB Auto** + ancien Panel | ⚠️ statu quo : refus, comme aujourd'hui. Aucune régression |
| ancien SB Auto + nouveau Panel (L4) | ✅ le projet expose déjà `POST /sync/push` |
| nouveau Panel (L4) + projet injoignable | ✅ échec silencieux, rattrapage par pull |

> **Ordre imposé : le PANEL d'abord pour L1.** Déployer le Panel corrigé
> débloque immédiatement tout le parc SB Auto existant, sans redéployer un seul
> projet. C'est la propriété la plus intéressante de ce défaut.
>
> Pour L4, l'ordre est libre : la surface projet existe déjà.

Aucune fenêtre de déploiement synchronisé n'est requise. Aucun `fail closed`
nouveau n'est introduit.

---

## W. Documentation à mettre à jour

| Dépôt | Document | Nature |
|---|---|---|
| Panel | `docs/ARCHITECTURE_CONTEXT.md` §4bis | le pipeline live décrit est **exact mais optimiste** : il ne dit pas qu'un refus le coupe définitivement |
| Panel | `docs/architecture/03_PANEL_BRIDGE.md` | schéma de payload, descripteur média |
| Panel | `docs/architecture/61_BUSINESS_PROJECTION.md` | catalogue §H |
| Panel | `docs/spec/PanelBridge.openapi.yaml` | miroir |
| SB Auto | `docs/ARCHITECTURE_CONTEXT.md` §8ter | idem ; corriger « la synchronisation n'était pas cassée : elle était lente » — elle l'était aussi |
| SB Auto | `docs/panelXvitrine/spec/*.openapi.yaml` | **maître** |
| **nouveau** | `docs/architecture/EVENT_DRIVEN_SYNC.md` | doctrine canonique (14 points de la mission §31) |

---

## X. Risques

| Risque | Gravité | Traitement |
|---|---|---|
| D'autres refus silencieux existent aujourd'hui sur des instances de production | **élevée** | L2 les rend visibles ; à faire tôt |
| `logoUrl` relatif refusé par `.url()` (§B.3) | moyenne | traité dans L1 |
| L4 : le Panel ouvre une sortie réseau vers N projets | moyenne | borner la concurrence, timeout court, jamais bloquant ; `bridge-conformity` surveille déjà la table des sockets |
| SSE derrière nginx (buffering, timeouts) | moyenne | `X-Accel-Buffering: no`, heartbeat de flux, repli sur `useLiveQuery` |
| Fenêtre non atomique `save()` / `enqueue` | faible | déjà couverte par `reconcileAll` ; documenter, ne pas prétendre l'inverse |
| Baisser `PANEL_SYNC_INTERVAL_S` pour « faire du live » | **doctrinale** | interdit par `PERIODIC_SYNC_IS_REPAIR_NOT_DELIVERY` (L15) |

---

## Y. GO / STOP

| Lot | Verdict |
|---|---|
| **L0** | ✅ **FAIT** — symptôme reproduit, chaîne datée, cause isolée |
| **L1** | ✅ **GO immédiat** — aucune dépendance, déploiement Panel seul, débloque tout le parc |
| **L2** | ✅ GO en parallèle de L1 |
| **L3** | ✅ GO |
| **L4** | 🟡 GO après L1 |
| L5 → L17 | ⏸ après validation de L1 en production réelle |

**Critère de sortie de L1** : sur le VPS, renommer l'entreprise d'un projet
disposant d'un logo, et voir la fiche du Panel changer en moins de 10 s sans
aucun geste — puis le mesurer, et remplacer les chiffres de §S par ceux-là.
