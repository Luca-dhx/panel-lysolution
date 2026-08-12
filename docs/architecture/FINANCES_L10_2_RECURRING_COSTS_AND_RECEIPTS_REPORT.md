# FINANCES L10.2 — COÛTS RÉCURRENTS ET JUSTIFICATIFS PRIVÉS

Rapport de lot. Panel L.Y Solution.
Doctrine : [`62_FINANCIAL_LEDGER.md`](./62_FINANCIAL_LEDGER.md) §§ 13 bis et 13 ter.
Lot précédent : [`FINANCES_L10_1_FINANCIAL_CORE_REPORT.md`](./FINANCES_L10_1_FINANCIAL_CORE_REPORT.md).

---

## Baseline et isolation

| Dépôt | HEAD au démarrage | Arbre |
|---|---|---|
| Panel | `ca9a68c` (rapport L10.1, sur `7bde5d0`) | propre |
| SB Auto 06 | `ef43487` | propre |

Le chantier **Stripe L6.2F** a démarré et committé pendant ce lot :
`209d137 feat(stripe): la première adoption — et elle reste une preuve`.

Aucun de ses fichiers n'a été lu-pour-modifier, restauré, reformatté ni stagé. Aucun
`git add -A`, aucun `git add .`, aucun `stash`, `reset`, `clean` ni `checkout` global.

`tests/run-all.js` est le seul fichier partagé. Le chantier voisin y avait inscrit
`stripe-subscription-ownership-e2e.test.js` **et l'a committé** avant mon staging : le
fichier était donc propre au moment où j'y ai ajouté mes deux suites. Aucun hunk étranger
n'est dans mon commit.

---

## Les trente questions

### 1. Quel modèle représente une récurrence ?

`PanelRecurringCost` (`backend/src/models/PanelRecurringCost.model.js`).

Identité `recurringCostId`, portée `PROJECT`/`COMPANY`, `recurrence {unit, interval}`,
`startAt` (l'ancre **et** la première échéance), `status`, `effectiveUntilCycleKey`,
`lastMaterializedCycleKey`, et une suite **append-only** de `revisions[]`.

Il ne porte **pas** de champ `amountCents` : le montant appartient à une révision, pas à la
règle. C'est ce qui rend les trois modes de modification distinguables (question 6-8).

### 2. Quel modèle représente une occurrence ?

`PanelFinancialTransaction` — **le modèle existant du L10.1**, pas un second ledger.

Une occurrence est une transaction ordinaire avec `origin: RECURRING_COST`,
`flow: OUTFLOW`, `category: COST`, plus trois champs de liaison : `sourceId`, `cycleKey`,
`sourceRevision`. Elle entre dans les mêmes agrégats, les mêmes filtres, les mêmes périodes
et la même suppression logique que n'importe quelle saisie manuelle.

### 3. Quelle est la clé d'idempotence d'une occurrence ?

```
{ sourceId, cycleKey }   index UNIQUE PARTIEL sur le ledger
```

`cycleKey` est le jour local de l'échéance au format `AAAA-MM-JJ`. La garantie est **dans la
base**, pas dans le code : l'écriture est un `updateOne(..., {$setOnInsert}, {upsert:true})`,
et une collision `E11000` est traitée comme « déjà fait ».

Un `findOne` suivi d'un `create` n'aurait rien garanti — deux requêtes qui se croisent entre
les deux instructions passent toutes les deux.

Le filtre partiel n'indexe que les documents portant réellement les deux champs : les
saisies manuelles (`null, null`) sont hors index, sinon elles entreraient toutes en
collision.

**Il couvre les occurrences supprimées.** Un cycle annulé garde sa clé occupée — sans quoi
la première relecture ressusciterait le coût que l'utilisateur venait de retirer.

**Éprouvé** : huit matérialiseurs simultanés sur six cycles dus → six occurrences, cinq
créations, zéro doublon ; et un doublon écrit à la main est refusé par la base.

### 4. Comment plusieurs cycles manqués sont-ils rattrapés ?

`dueCycles()` rend **tous** les cycles dont l'instant est passé, du plus ancien au plus
récent, chacun avec sa vraie date. Le matérialiseur les inscrit un par un.

Il repart du `lastMaterializedCycleKey` **inclus** — le recouvrement d'un cycle coûte une
écriture conditionnelle sans effet, et il répare le cas où le curseur a avancé sans que
l'écriture ait abouti. Repartir du suivant aurait laissé ce trou ouvert pour toujours.

Borne : `MAX_CATCHUP_CYCLES = 600`. Au-delà, `overflow: true` + le nombre restant, un
avertissement au journal, et le reste au passage suivant. **Aucun cycle n'est perdu en
silence** — une borne qui jette des données est pire que pas de borne.

**Éprouvé** : Panel éteint du 1er août au 5 décembre → **quatre** occurrences créées, aux
dates `2026-09-01`, `-10-01`, `-11-01`, `-12-01`, chacune au montant de la règle et non à
leur somme. Rejouer ne crée rien.

### 5. Quelle est la règle pour les mois de longueur différente ?

**ANCRAGE, pas report.** Chaque échéance est calculée depuis l'ancre, jamais depuis la
précédente. Si le jour n'existe pas dans le mois cible, il est ramené au dernier jour valide
— **pour ce cycle seulement**.

```
31 jan → 28 fév → 31 mars → 30 avril → 31 mai
```

Le report (`31 jan → 28 fév → 28 mars → …`) perdrait le 31 pour toujours à cause d'un seul
mois court. Même règle pour les années : 29 fév 2024 → 28 fév 2025/26/27 → **29 fév 2028**.

Conséquence structurelle : `cycleDateAt(n)` ne dépend que de l'ancre et de `n`, donc elle
est rejouable à l'identique après n'importe quelle interruption. C'est ce dont l'idempotence
a besoin.

Progression **calendaire** dans `Europe/Paris` — jamais en millisecondes. `1 MONTH ≠ 30 DAYS`.

### 6. Que signifie exactement « modification précédente » ?

Effet à partir du **cycle COURANT** — le dernier cycle échu, celui dont l'occurrence existe
déjà.

Le 15 septembre, sur un mensuel ancré au 1er août : effet au **1er septembre**.
août 49 · **septembre 59** · octobre 59 · suivantes 59.

L'occurrence de septembre est **révisée par une mise à jour** : identifiant, date de cycle,
date de création, auteur d'origine et **justificatif** conservés.

> Le libellé du cahier des charges invite à comprendre l'inverse. « Précédente » désigne ce
> que l'utilisateur voit : la dernière ligne apparue dans son livret. L'écran l'explicite en
> toutes lettres.

### 7. Que signifie « prochaine » ?

Effet à partir de la **prochaine échéance non encore matérialisée**.

Même exemple : effet au 1er octobre. août 49 · septembre 49 · **octobre 59** · suivantes 59.
**Aucune** occurrence matérialisée n'est touchée (`revisedOccurrences === 0`).

Si la règle n'a plus de prochaine échéance, la modification est refusée
(`PANEL_RECURRING_NO_NEXT_CYCLE`) plutôt qu'appliquée sans effet.

### 8. Que signifie « depuis le début » ?

Effet à partir du **tout premier cycle** (l'ancre). Toutes les occurrences **vivantes** sont
révisées.

Même exemple : **août 59 · septembre 59 · octobre 59**.

Ce qui est **conservé** : les identifiants, les dates, les auteurs d'origine, et surtout les
**justificatifs**. La révision est un `updateMany` sur les seuls champs financiers — jamais
un supprimer/recréer, qui aurait détaché les pièces sans bruit.

Les occurrences **annulées** ne sont pas révisées : elles constatent ce qui a été retiré, à
la valeur qu'il avait alors. Réécrire un fait clos n'aurait aucun sens.

### 9. Comment l'historique reste-t-il auditable ?

Par les **documents**, jamais par la chronologie (question 27).

- `revisions[]` sur la règle — **append-only** : rang, cycle d'effet, valeurs, mode
  d'application, motif, auteur, date. Jamais purgé, jamais réécrit ;
- `stoppedAt / stoppedBy / stopMode / stopReason` sur la règle ;
- sur chaque occurrence : `sourceRevision` (quelle révision est appliquée), `updatedBy`,
  `updatedAt`, `deletedAt / deletedBy / deletionReason` ;
- le descripteur `PanelMedia` du justificatif, qui survit à la suppression du fichier.

« Combien valait Brevo en août ? » se répond en lisant la suite des révisions ; « qui a
changé ça, quand et pourquoi ? » aussi. Sans ouvrir aucun journal externe.

### 10. Que fait Stop actuelle ?

Trois effets, et rien d'autre :

1. la règle passe `STOPPED`, bornée au cycle courant (`effectiveUntilCycleKey`) ;
2. l'occurrence du cycle courant est **retirée des totaux** par suppression logique
   (`deletedAt`, `deletedBy`, `deletionReason`) ;
3. aucun cycle postérieur ne sera jamais produit — la borne est à la **source**, pas à
   l'affichage.

Les cycles **antérieurs restent**. La ligne annulée reste en base, consultable, avec son
justificatif téléchargeable.

**Éprouvé** : le net remonte exactement du montant annulé ; août intact ; six mois plus
tard, la relecture ne ressuscite ni le cycle annulé ni aucun suivant.

### 11. Que fait Stop prochaine ?

La règle passe `STOPPED`, bornée au cycle courant. Le cycle courant **reste comptabilisé**.
Rien n'est annulé, rien de postérieur n'est produit.

### 12. Comment les justificatifs sont-ils liés ?

La transaction porte :

```
receipt: { mediaId, attachedAt, attachedBy }
```

Une **référence** au protocole Media, plus la date et l'auteur de l'ACTE de rattachement —
qui n'est pas l'import du fichier. Le nom, le type, le poids et l'empreinte vivent dans
`PanelMedia` et sont joints à la lecture (`withReceipts`, une seule requête `$in` par page).

Les recopier sur la transaction en aurait fait une seconde vérité, qui divergerait au
premier remplacement.

### 13. Pourquoi aucun justificatif sur la définition ?

Parce qu'un justificatif documente un **paiement**, et qu'une règle n'en est pas un. La
facture d'août et celle de septembre sont deux documents distincts. Un champ sur la
définition aurait forcément fini par désigner l'un des deux mois, en laissant croire qu'il
valait pour tous.

Le formulaire de définition n'a donc aucun champ fichier — vérifié par la recette d'écran.

### 14. Quelle abstraction Media est réellement utilisée ?

**Le protocole `PanelMedia` du Panel**, étendu — pas dupliqué.

Réutilisés tels quels : `PanelMedia` (le descripteur), `objectKeyFor()` (clé par empreinte),
`sha256Of()`, `config.paths` (résolution du stockage), la doctrine d'environnement
`TEST`/`PROD`, `mediaPolicy.js` (la politique et le plafond de transport).

Ajoutés au protocole, **génériquement** :

| Ajout | Où | Portée |
|---|---|---|
| `visibility: PUBLIC \| PRIVATE` | `PanelMedia.model.js` | tout média |
| `originalFilename` | `PanelMedia.model.js` | tout média |
| `config.paths.privateMedia` | `config/env.js` | tout média privé |
| `DOCUMENT_POLICIES`, `ACCEPTED_DOCUMENT_TYPES` | `mediaPolicy.js` | tout document |
| `documentValidation.js` | nouveau | tout document |
| `privateMedia.service.js` | nouveau | tout média privé |
| exclusion des privés à la publication | `mediaDescriptor.service.js` | tout média privé |
| refus d'adresse pour un privé | `resolvePanelMediaUrl` | tout média privé |

**Aucun `FinancialFileService`.** Le module financier (`receipts.service.js`) n'écrit aucun
fichier, ne calcule aucune empreinte et ne connaît aucun chemin — vérifié par la recette.

Une facture client ou un contrat réutilisera `storePrivateDocument` / `readPrivateMedia` en
posant sa propre route et sa propre autorisation.

### 15. Où le fichier vit-il en localhost ?

`<backend>/storage/media/<mediaId>-<empreinte>.<ext>` — un dossier ordinaire, créé à la
demande.

### 16. Où vit-il après déploiement ?

Au même chemin. Mais `<backend>/storage` est alors un **lien symbolique** vers
`<siteRoot>/shared/storage`, posé à chaque release par le pipeline.

**Il n'y a aucune branche `if (localhost)`** dans la couche Media ni dans le code financier
— la recette l'interdit explicitement. La couche Media absorbe la différence ; le domaine
métier ne la voit jamais.

### 17. Survit-il au redéploiement ?

Oui. Trois faits, prouvés sur la configuration réelle et non sur une intention :

1. `pipeline.js` — `ln -sfn ${sharedRoot}/storage ${backendDir}/storage`, à **chaque**
   release, plus `mkdir -p ${sharedRoot}/storage` ;
2. `build.js` — `storage` figure dans `BACKEND_EXCLUDE_DIRS` : l'artefact ne le contient
   pas, donc rien ne l'écrase ;
3. `nginx.js` — **aucun** bloc `location /storage`.

Il survit donc au rebuild du front, au remplacement du backend, au `npm ci`, au rechargement
PM2 et au redéploiement.

> **Limite assumée** : un justificatif déposé en local n'est pas migré vers le serveur. La
> transaction qu'il justifie ne l'est pas davantage — elle vit dans la base de cette
> instance.

### 18. Peut-il être obtenu via `/uploads/…` sans authentification ?

**Non.** Quatre barrières, dont deux structurelles :

- le fichier n'est **pas** dans `uploads/` — il est dans `storage/media/` ;
- `storage/` n'a **aucun** bloc `location` Nginx et n'est monté par aucun `express.static` ;
- `resolvePanelMediaUrl` — le point unique qui produit une adresse de média — **refuse** un
  média privé (`reason: MEDIA_PRIVE`). Aucun écran ne peut en obtenir une, même en la
  demandant ;
- `publishPanelMediaOnDestination` **exclut** les privés : un déploiement ne peut pas les
  copier dans le `shared/uploads` public.

**Éprouvé** : `GET /uploads/<clé>` → 404 · `GET /storage/media/<clé>` → 404 ·
`GET /<path du descripteur>` → 404 · tentative de traversée → refusée · descripteur publiable
→ `null`.

### 19. Quelle route autorise le téléchargement ?

```
GET /api/finances/transactions/:transactionId/receipt      (jeton du Panel exigé)
```

`Content-Disposition: attachment` (deux formes de nom, RFC 6266),
`X-Content-Type-Options: nosniff`, `Cache-Control: private, no-store`.

Aucun chemin disque, aucune clé d'objet, aucune URL dans la réponse.

### 20. Comment le cross-project est-il empêché ?

Par le **chemin**, pas par une liste.

Une route générique `/api/media/private/:mediaId` aurait exigé une table d'ACL parallèle :
un média, seul, ne sait pas à qui il appartient. Ici on charge la transaction, puis
`assertBelongsTo` vérifie que le média demandé est **le sien**. L'autorisation devient une
conséquence de l'objet métier.

**Éprouvé** : le `mediaId` d'une pièce du projet A, présenté sur la transaction du projet B,
rend 404 — par la route comme par le service.

### 21. Les justificatifs survivent-ils aux modifications rétroactives ?

**Oui.** La révision est un `updateMany` sur `label`, `description`, `amountCents`,
`sourceRevision` — le champ `receipt` n'est jamais touché.

**Éprouvé** : facture attachée à juin, révision `FROM_START` de 49 € à 59 €, puis juin
vaut 59 €, **porte toujours le même `mediaId`**, garde son `transactionId`, et la pièce se
retéléchargenote octet pour octet.

### 22. Survivent-ils à l'annulation du cycle actuel ?

**Oui.** Un « arrêt actuelle » pose `deletedAt` sur l'occurrence ; rien n'est appelé sur le
média.

**Éprouvé** : le cycle d'août est retiré des totaux, sa facture reste attachée, son
descripteur est intact, et le téléchargement rend les octets exacts. En revanche on
n'attache plus de **nouvelle** pièce à un mouvement supprimé (409) — documenter une ligne
qui ne compte plus n'aurait pas de sens.

### 23. Les coûts COMPANY fonctionnent-ils ?

Oui. `scope: COMPANY` → `projectId: null`, exactement le nul signifiant du L10.1. Les
occurrences apparaissent dans la portée « L.Y Solution seule » et dans la vue globale.

**Éprouvé** : domiciliation mensuelle en portée société → cinq occurrences, toutes à
`projectId: null`, comptées dans les agrégats société.

### 24. Les coûts PROJECT fonctionnent-ils ?

Oui. `scope: PROJECT` exige un `projectId` **existant au registre** — un projet inconnu rend
404 et rien n'est écrit. Les occurrences portent le `projectId` et l'instantané du nom.

### 25. Le graphique / net ne compte-t-il que les occurrences matérialisées ?

Oui, et par construction : l'agrégateur somme des `PanelFinancialTransaction` de statut
`RECORDED` et non supprimées. Il ne connaît pas les règles.

`nextOccurrenceAt` est calculée pour l'affichage, marquée « prévision — non comptabilisée »
dans le listing, et n'entre dans aucun total.

**Éprouvé** : une règle démarrant en 2099 ne matérialise rien, ne pèse ni sur les coûts, ni
sur le net, ni sur la série du graphique — tout en annonçant sa prochaine échéance.

### 26. Comportement de « Tout supprimer » vis-à-vis des récurrences ?

Il vide le **ledger** et ne touche **pas** aux règles. Arrêter un abonnement est une seconde
décision, que personne n'a prise en cliquant sur ce bouton.

La conséquence est contre-intuitive — les règles actives continueront de produire — donc
elle est **annoncée avant le clic** : `bulk-scope` rend `activeRecurringCosts`, la modale
affiche un avertissement nommant le nombre et indiquant où arrêter.

Les occurrences passées **ne ressuscitent pas** : leur clé de cycle reste occupée.

**Éprouvé** : après vidage du livret d'un projet, les règles restent actives et non
arrêtées, le livret est vide, et une relecture ne recrée aucune occurrence passée.

### 27. Le journal `PanelEvent` est-il nécessaire à la preuve financière durable ?

**Non, et c'était la réserve n°1 du lot L10.1.**

`recordEvent()` borne la chronologie à `TIMELINE_HISTORY_SIZE` (300) entrées par projet :
c'est un fil d'actualité, pas une archive. Une preuve qui n'y vivrait que là s'effacerait au
trois-centième événement.

Toute la preuve durable est **sur les documents** (question 9). La chronologie ajoute la
lisibilité et le contexte ; son échec d'écriture n'annule aucune opération, et c'est écrit
dans le code.

**Aucun journal financier append-only n'a été introduit** : il aurait fait doublon avec
`revisions[]` et les champs d'audit des occurrences, qui suffisent.

### 28. Quels tests ont été exécutés ?

| Suite | Contrôles | Objet |
|---|---|---|
| `finance-recurring.test.js` | **105** | calendrier, idempotence, rattrapage, 3 modes, 2 arrêts, immuabilité, futur non compté, garde-fou fournisseur |
| `finance-receipts.test.js` | **105** | signatures d'octets, upload/download, cross-project, aucune route publique, non-publication au déploiement, survie de la pièce, parité localhost/déployé, garde structurelle |
| `finance-ui.test.js` | **156** (+45) | listing des règles, modales des 3 modes et des 2 arrêts, cellule justificatif sans lien, avertissement « tout supprimer » |
| `finance-core.test.js` | 138 | non-régression L10.1 intégrale |
| `media-first-deployment.test.js` | **63** (+10) | un média privé n'est jamais transféré ni publié |
| `media-upload-limits` · `-validation` · `descriptor` · `canonical-save` · `cache-versioning` | 9 · 30 · 56 · 58 · 42 | non-régression du protocole Media |
| `architecture.test.js` | 31 | invariants structurels |
| `panel-ux.test.js` | 86 | non-régression d'écran |
| **Suite Panel complète** | **voir ci-dessous** | |

Détail des cas exigés :

- **récurrences** — quotidien, tous les 7 jours, mensuel, tous les 2 mois, annuel, 31
  janvier, 29 février, DST (nuit du 29 mars), Panel offline plusieurs cycles, double
  matérialisation, **concurrence à 8**, modification prochaine/précédente/depuis le début,
  stop actuelle/prochaine, justificatif conservé après modification, justificatif conservé
  après stop actuelle, scope PROJECT, scope COMPANY, agrégats recalculés ;
- **média** — PDF valide, image valide, type interdit (exécutable et HTML renommés),
  taille interdite, transaction inconnue, cross-project, non authentifié, propriétaire
  autorisé (ADMIN et DEV), fichier inexistant, descripteur sans objet (503 nommé),
  transaction supprimée (lecture oui, écriture non), `objectKey` stable, descripteur
  correct, environnement correct, chemin localhost, mapping déployé, aucune route statique,
  `/uploads/…` refusé, nom utilisateur non utilisé comme chemin, traversée impossible.

Deux **défauts réels** ont été trouvés et corrigés par ces recettes :

1. `busboy`/`multer` décode les noms multipart en **latin-1** : « Facture Août.pdf »
   arrivait « Facture AoÃ»t.pdf » — systématiquement, en français ;
2. un nom accentué **repartait** mangé dans `Content-Disposition`. Les deux formes de la
   RFC 6266 sont désormais émises.

### 29. Le chantier Stripe L6.2F a-t-il été intégralement préservé ?

Oui. Il a committé `209d137` pendant le lot ; ses suites passent (`stripe-control-plane`
109, `stripe-subscription-cutover-e2e` 122, `stripe-subscription-ownership-e2e` 79,
`stripe-ownership-invariants` 87, `capability-gateway` 119…).

Aucun fichier Stripe, capability, ownership, webhook ou bridge n'a été modifié. Un contrôle
statique de recette interdit à tout code fournisseur d'entrer dans les modules de
récurrence et de justificatifs.

### 30. Quels risques restent pour L10.3 ?

1. **La révision ne conserve pas la valeur antérieure de chaque occurrence.** Elle est
   reconstructible depuis `revisions[]` (append-only, datée), ce qui suffit à expliquer un
   écart. Si un jour il faut l'état exact d'une ligne à une date donnée sans dérivation, il
   faudra un journal de mouvements — décision à prendre alors, pas maintenant.
2. **Pas de purge des fichiers orphelins.** Un échec entre l'écriture du fichier et le
   rattachement laisse un objet non référencé : invisible, non servi, inoffensif. Une purge
   devra être conçue **explicitement**, avec la garantie de ne jamais toucher une pièce
   encore référencée par une transaction supprimée.
3. **Un justificatif local ne migre pas au déploiement** (question 17). Cohérent avec la
   base, mais à dire aux utilisateurs qui configurent en local.
4. **Monodevise.** Inchangé depuis L10.1.
5. **`MAX_CATCHUP_CYCLES = 600` par passage.** Une récurrence quotidienne abandonnée deux
   ans rattraperait en deux passages. Le journal le dit ; aucun cycle n'est perdu.
6. **Pour L10.3 précisément** : les revenus Stripe devront passer par `recordTransaction`
   avec `origin: STRIPE` et une provenance résolue. Le point d'attention est l'idempotence —
   l'index `{sourceId, cycleKey}` est *partiel* et taillé pour les récurrences ; une source
   Stripe devra soit le réutiliser (`sourceId` = identifiant d'abonnement, `cycleKey` =
   période facturée), soit poser le sien. **Ne pas réutiliser sans y penser** : deux
   familles de sources sur un même index unique se collisionneraient si leurs identifiants
   se croisaient.
7. **La décision « pas de sondage » côté écran** (L10.1) doit être rouverte en L10.3 :
   quand Stripe écrira dans le registre, l'écran devra se rafraîchir sans clic.

---

## Fichiers

### Créés

```
backend/src/models/PanelRecurringCost.model.js
backend/src/services/finance/recurrence.js
backend/src/services/finance/recurringCosts.service.js
backend/src/services/finance/recurringCostScheduler.js
backend/src/services/finance/receipts.service.js
backend/src/services/upload/documentValidation.js
backend/src/services/upload/privateMedia.service.js
frontend/src/components/finance/RecurringCostForm.tsx
frontend/src/components/finance/RecurringCostList.tsx
frontend/src/components/finance/ReceiptCell.tsx
tests/finance-recurring.test.js
tests/finance-receipts.test.js
docs/architecture/FINANCES_L10_2_RECURRING_COSTS_AND_RECEIPTS_REPORT.md
```

### Modifiés

```
backend/package.json                                  2 scripts de recette
backend/src/config/env.js                             paths.privateMedia
backend/src/server.js                                 démarrage/arrêt de l'ordonnanceur
backend/src/models/PanelMedia.model.js                visibility, originalFilename
backend/src/models/PanelFinancialTransaction.model.js sourceId, cycleKey, sourceRevision,
                                                      receipt, index unique partiel
backend/src/services/finance/period.js                localParts/startOfLocalDay exportés
backend/src/services/finance/financialTransactions.service.js  projection, withReceipts,
                                                      décompte des règles actives
backend/src/services/upload/mediaPolicy.js            DOCUMENT_POLICIES, plafond élargi
backend/src/services/upload/mediaDescriptor.service.js  exclusion des privés (×2)
backend/src/controllers/finances.controller.js        convergence, récurrences, justificatifs
backend/src/routes/finances.routes.js                 8 routes, réception multipart
frontend/src/types.finance.ts
frontend/src/lib/api.ts
frontend/src/components/finance/FinanceWorkspace.tsx
frontend/src/components/finance/TransactionDetail.tsx
frontend/src/components/finance/financeLabels.ts
frontend/src/components.css
tests/finance-ui.test.js                              +45 contrôles
tests/media-first-deployment.test.js                  +10 contrôles
tests/run-all.js                                      inscription de 2 suites
docs/architecture/62_FINANCIAL_LEDGER.md              §§ 13 bis, 13 ter, 14, 15
```

Aucune migration de données : `visibility` a `PUBLIC` pour défaut, donc les médias
antérieurs sont corrects sans être touchés ; aucune transaction existante ne porte de
justificatif, donc il n'y a rien à reprendre.

---
