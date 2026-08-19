# LOT 1 — PLAN DE CONTRÔLE MULTI-PROJETS DES MODÈLES E-MAIL (L11.1)

> Rapport d'implémentation. Il fait suite à
> [`EMAIL_TEMPLATE_OWNERSHIP_ARCHITECTURE_AUDIT.md`](./EMAIL_TEMPLATE_OWNERSHIP_ARCHITECTURE_AUDIT.md),
> dont il applique les décisions. Chaque affirmation renvoie à un fichier ou à
> un contrôle exécuté. Ce qui n'a pas été fait est nommé, avec sa raison.

---

## EN UNE PHRASE

Le repli `own ?? platform` a été supprimé : le contenu des e-mails est désormais
porté par des documents **scopés** — `PANEL` pour L.Y Solution, `PROJECT/<id>`
pour chaque projet — un même code peut exister dans plusieurs portées avec des
HTML entièrement différents, l'absence d'une instance projet est un **refus
d'envoi** et jamais un emprunt au Panel, et la portée n'est plus jamais lue
depuis un corps de requête.

---

## FINAL ARCHITECTURE

```text
┌──────────────────────── PROJETS (N) ─────────────────────────┐
│  événement métier · destinataires · VALEURS des variables     │
│  éditeur du manager ──▶ /bridge/v1/email-templates (SA portée) │
└───────────────────────────┬──────────────────────────────────┘
                            │  invoke('email.send_template')
                            │  { templateRef, recipient, variables, operationId }
                            │  ⚠ AUCUN champ de portée sur le fil — un CODE NU
                            ▼
┌─────────────────── PANEL — EMAIL CONTROL PLANE ──────────────────────────┐
│  jeton de pont ──▶ context.projectId   (PROUVÉ, jamais lu de la charge)   │
│                          │                                                │
│      scopeOfInvocationContext(context)                                    │
│                          ▼                                                │
│  ┌──────────────────┐        ┌────────────────────────┐                   │
│  │ scopeType=PANEL  │        │ scopeType=PROJECT      │                   │
│  │ projectId=null   │        │ projectId=<projet>     │                   │
│  │ PAYMENT_REQUEST_*│        │ PASSWORD_RESET_REQUEST │                   │
│  │ SITE_SUSPENDED_* │        │ CONTACT_ADMIN_*        │                   │
│  │ PANEL_SENDER_TEST│        │ SITE_SUSPENDED_MANUAL_*│                   │
│  │ CONTRACT_…_DEV   │        │ CONTRACT_…_ADMIN       │                   │
│  │ PASSWORD_RESET_… │        │ EMAIL_SENDER_VERIF_…   │                   │
│  └────────┬─────────┘        └────────────┬───────────┘                   │
│           └──────────────┬────────────────┘                               │
│                          ▼                                                │
│      RESOLVER DÉTERMINISTE — fail-closed                                  │
│        PANEL   : (PANEL, null, code) sinon défaut du registre, source dite │
│        PROJECT : (PROJECT, id, code) sinon EMAIL_TEMPLATE_NOT_CONFIGURED   │
│        ✗ AUCUN repli PROJECT → PANEL, sous aucune condition                │
│                          ▼                                                │
│      VALIDATOR (contrat de variables PLATEFORME, par code)                │
│                          ▼                                                │
│      RENDERER  ──▶ rend subject + html + { scopeType, scopeId, version }   │
│                          ▼                                                │
│      SENDER — `From` GLOBAL, identique pour tout le parc                   │
│               `Reply-To` projet, inchangé                                  │
│                          ▼                                                │
│      INTEGRATED API ──▶ BREVO (clé du coffre du Panel)                     │
│                          ▼                                                │
│      JOURNAL : code · portée · scopeId · version · source · operationId    │
└──────────────────────────────────────────────────────────────────────────┘
```

---

## DATA MODEL

### `PanelEmailTemplate`

```text
templateCode : String   (doit exister au registre)
scopeType    : 'PANEL' | 'PROJECT'   ← AJOUTÉ, requis, default 'PANEL'
projectId    : String|null           ← null ⇔ PANEL (invariant vérifié)
name, description, subject, html, enabled, version
updatedBy, createdAt, updatedAt

INDEX UNIQUE  (templateCode, projectId)   « uniq_template_project »
INDEX LISTE   (scopeType, projectId)      « scope_catalogue »   ← AJOUTÉ
```

`PanelEmailTemplateVersion` porte les **mêmes** colonnes de portée : c'est ce
qui rend l'historique étanche.

### Deux décisions de schéma, et leurs raisons

**`projectId` n'a PAS été renommé en `scopeId`.** La correspondance est totale
et déterministe (`PANEL ⇔ null`), le renommage aurait imposé une migration de
deux collections et de deux index uniques pour gagner un mot. La traduction
portée → colonnes vit en **un seul endroit**
([`panelEmailTemplateScope.js` · `scopeFilter`](../../backend/src/services/email/panelEmailTemplateScope.js)),
prêt pour ce renommage le jour où il paiera.

**`scopeType` n'est PAS dans l'index unique.** Il serait redondant : c'est une
fonction de `projectId`. L'index actuel EST déjà, terme pour terme, l'index
cible `unique(scopeType, scopeId, templateCode)` du lot.

### Migration

`backfillScopeTypes()` — déterministe, idempotente, sans heuristique :

```text
scopeType absent + projectId null      → PANEL
scopeType absent + projectId non null  → PROJECT
```

Aucun motif de nom, aucune décision. Les documents déjà porteurs d'une portée ne
sont pas touchés.

---

## TEMPLATE DEFINITIONS

Nouveau module
[`panelEmailTemplateDefinitions.js`](../../backend/src/services/email/panelEmailTemplateDefinitions.js).
Il sépare deux choses jusqu'ici confondues :

| | vit dans | unicité | contenu |
|---|---|---|---|
| **TemplateDefinition** | le CODE | une par code, pour tout le parc | variables autorisées, variables requises, catégorie, portées permises |
| **TemplateInstance** | la BASE | une par (portée, code) | sujet, HTML, activation, version, historique |

`templateDefinition(code)` rend le contrat sans une ligne de HTML.
`assertScopeAllowedForCode(code, scope)` refuse une instance dans une portée qui
n'appartient pas à ce code.

### Contrat de variables — option A, assumée

Le contrat reste **plateforme**, pas scopé (§6 du lot, option A de l'audit).
Trois projets écrivent trois HTML entièrement différents ; aucun n'invente
`supportPhone`. La raison n'est pas la paresse : les **valeurs** sont produites
par le code métier du projet (`emailVariableResolvers`), et un contrat scopé
exigerait que ce code sache, projet par projet, quoi produire. L'option B se
posera sur `TemplateDefinition`, qui est l'endroit prévu pour la porter.

---

## PANEL TEMPLATES — classification par les APPELANTS

Recensement exhaustif des invocations réelles, jamais des noms.

| templateCode | owner avant | owner cible | appelants réels | motif | action |
|---|---|---|---|---|---|
| `PASSWORD_RESET_REQUEST` | PLATEFORME unique | **PANEL + PROJECT** | `Panel/services/auth/panelPasswordReset.service.js` **et** `PROJECT/services/auth.service.js` | deux communications distinctes portant le même contrat | instance PANEL conservée ; instance PROJECT à poser |
| `CONTACT_ADMIN_NOTIFICATION` | PLATEFORME | **PROJECT** | `PROJECT/utils/domainEventActionRegistry.js#notify-admins-contact-submitted` | un visiteur écrit au commerçant | instance PANEL **retirée du seed** ; posée par projet |
| `CONTRACT_CANCELLATION_ADMIN_CONFIRMATION` | PLATEFORME | **PROJECT** | idem `#notify-admins-cancellation` (déclarée, désactivée) | destinataire projet, ton projet | posée par projet |
| `CONTRACT_CANCELLATION_DEV_NOTIFICATION` | PLATEFORME | **PANEL** | idem `#notify-devs-cancellation` (déclarée, désactivée) | **cas d'école du §16** : événement projet, variables projet, communication L.Y Solution | reste PANEL |
| `EMAIL_SENDER_VERIFICATION_TEST` | PLATEFORME | **PROJECT** | `PROJECT/services/email/emailModule.js`, `…/emailVariableResolvers.js` | éprouve la chaîne d'UN projet, pour l'exploitant de ce projet | posée par projet |
| `SITE_SUSPENDED_MANUAL_ADMIN` | PLATEFORME | **PROJECT** | `PROJECT/services/siteSuspensionNotice.service.js` | le projet annonce à SES administrateurs | posée par projet |
| `PAYMENT_REQUEST_CREATED` | PLATEFORME | **PANEL** | `Panel/services/finance/paymentRequests/paymentRequestEmails.js` | facturation L.Y Solution | inchangé |
| `PAYMENT_REQUEST_REMINDER` | PLATEFORME | **PANEL** | idem | relance de facturation | inchangé |
| `SITE_SUSPENDED_PAYMENT_DEFAULT_CLIENT` | PLATEFORME | **PANEL** | `Panel/services/finance/paymentDefaults/paymentDefaultAnnouncements.js` | parole du prestataire, pas du site suspendu | inchangé |
| `SITE_SUSPENDED_PAYMENT_DEFAULT_TEAM` | PLATEFORME | **PANEL** | idem | notification interne | inchangé |
| `PANEL_EMAIL_SENDER_TEST` | PLATEFORME | **PANEL** | `Panel/services/email/panelEmailSenderTest.service.js` | test d'expéditeur, par et pour le Panel | inchangé |

**Bilan :** PANEL 7 · PROJECT 5 · dont 1 code (`PASSWORD_RESET_REQUEST`) dans les
deux. `SHARED` n'a **pas** été introduit — les deux candidats de l'audit sont
tranchés (l'un PANEL, l'autre PROJECT), et le §9 du lot interdit une portée sans
cas d'usage réel.

Conséquence directe du seed : `seedPanelTemplates()` ne pose plus que les **7**
codes dont la définition déclare la portée PANEL. Poser une instance PANEL de
`CONTACT_ADMIN_NOTIFICATION` créerait un document que le runtime ne consulterait
jamais, mais qu'un exploitant éditerait en croyant agir.

> **Note d'architecture.** Le registre du Panel nomme les appelants côté projet
> `PROJECT/…`, jamais par le nom d'un client : le Panel sert un parc, et la garde
> `architecture.test.js` refuse toute logique spécifique à un projet. Le
> recensement nominatif appartient à ce rapport, pas au code.

---

## PROJECT TEMPLATES

Les cinq codes `provisionForProjects` sont posés par
`provisionProjectTemplates(projectId, { codes?, contents?, actor })` :

- **idempotent** — une instance déjà posée n'est jamais réécrite ; rejouer une
  migration ne détruit pas le travail fait entre-temps ;
- **non destructif** — un contenu importé invalide **refuse sa ligne**, pas la
  migration entière (rendu dans `refused`, avec ses erreurs) ;
- **explicite** — la pose est un ACTE (ouverture, duplication, migration), pas
  un effet de bord du premier envoi. Créer à la volée ferait disparaître le refus
  qui donne son sens au lot.

### Reprise du contenu local (§5.1)

Deux chemins, aucun ne perd le HTML existant :

1. `POST /bridge/v1/email-templates/import`, sous le jeton du projet ;
2. le script à jouer une fois
   [`SB Auto 06/scripts/migrate-email-templates-to-panel.mjs`](../../../SB%20Auto%2006/scripts/migrate-email-templates-to-panel.mjs)
   — lit les `EmailTemplate` locaux, déchiffre le jeton d'appairage par la même
   fonction que le pont, pousse, affiche le rapport, et **ne supprime rien**.

`--dry-run` liste ce qui partirait sans rien envoyer.

---

## RESOLVER

[`panelEmailTemplate.service.js`](../../backend/src/services/email/panelEmailTemplate.service.js)

```js
resolveTemplate(templateCode, scope)   // scope = { scopeType, scopeId }
```

```text
PANEL   : (PANEL,  null, code)  →  source 'PANEL'
          absent                →  défaut du REGISTRE, source dite, configured:false
PROJECT : (PROJECT, id,  code)  →  source 'PROJECT'
          absent                →  ÉCHEC 409 EMAIL_TEMPLATE_NOT_CONFIGURED
```

**Le seul repli conservé est le défaut du registre, en portée PANEL, et il ne
ment pas** : c'est exactement le contenu que l'amorçage poserait. En portée
PROJECT le même geste mentirait — le défaut du registre est le contenu de
L.Y Solution — et reproduirait le repli qu'on vient de supprimer.

`draftTemplate()` est la variante **éditeur** : elle rend le défaut du registre
avec `configured: false` au lieu d'échouer. Deux fonctions au nom distinct, et
non un drapeau `{ allowMissing: true }` — un drapeau finirait par être passé
depuis le chemin d'envoi « pour que ça marche ».

`normalizeScope` et `assertScopeCoherent` **refusent bruyamment** l'ancienne
forme `{ projectId }` : la tolérer ferait retomber un appelant non migré sur le
défaut PANEL, donc écrire chez L.Y Solution en croyant écrire chez un client.

---

## GLOBAL SENDER

**Inchangé, et c'est une décision.** Le contenu est scopé ; l'identité
d'expédition ne l'est pas.

```text
From      GLOBAL — `panelGlobalSender.service.js`, identique pour le Panel,
                   pour SB Auto, pour tout projet. Absent ⇒ REFUS du parc entier.
Reply-To  PROJET — `PanelProjectSenderIdentity`, inchangé.
```

Le `From` est aussi l'adresse de **support** — celle qu'on surveille et qu'on
authentifie SPF/DKIM. Dispersée en N copies, elle ne serait plus administrable.

Prouvé par la recette : deux clients, deux HTML, **un seul `sender.email` dans
le corps posté à Brevo**, et la clé du Panel.

---

## PANEL RECIPIENT USE CASES

`PANEL` template + variables venues d'un projet + destinataires Panel.
C'est le §16, et il fonctionne sans rien de spécial : la portée du template est
indépendante de l'origine des valeurs.

```text
événement      PROJECT/<id> demande une résiliation
template       PANEL / CONTRACT_CANCELLATION_DEV_NOTIFICATION
variables      project.name, requester, reason, requestedAt   (venues du projet)
destinataires  audience Panel
expéditeur     global
```

Le principe est écrit dans la classification : **l'ownership suit la
communication, jamais l'origine des variables.**

## PROJECT RECIPIENT USE CASES

`PROJECT` template + destinataires du projet + expéditeur global.
C'est le cas nominal des cinq codes projet.

---

## PASSWORD RESET

| | Panel | Projet |
|---|---|---|
| déclencheur | `panelPasswordReset.service.js` | `PROJECT/services/auth.service.js` |
| source d'invocation | `PANEL_SELF` | `PROJECT_BRIDGE` |
| `context.projectId` | `null` | prouvé par le jeton |
| portée résolue | `PANEL` | `PROJECT/<id>` |
| document | `PANEL/PASSWORD_RESET_REQUEST` | `PROJECT/<id>/PASSWORD_RESET_REQUEST` |
| expéditeur | global | **le même** global |

**Recette automatisée** (section 4-5 de la suite) : trois portées, trois sujets,
trois documents Mongo d'identité distincte, et le corps posté au fournisseur
porte le texte du bon client. Réécrire le modèle du Panel ne change **rien**
chez un client — c'était exactement l'inverse avant ce lot.

---

## EDITOR PANEL

`GET|PUT /api/email-templates/...?scope=PROJECT&projectId=<id>` — `requirePanelUser`
+ `requirePanelDev` + `resolveTemplateScope`.

La portée arrive en **query**, jamais dans le corps, et le middleware
[`templateScope.middleware.js`](../../backend/src/middlewares/templateScope.middleware.js)
la construit puis la **valide contre le registre des projets**. Défaut : `PANEL`
— le seul défaut sûr.

Routes ajoutées : `GET /scopes` (les portées administrables, énumérées par le
serveur), `GET /ownership` (la table de classification), `GET /:code/scopes`
(le même code dans toutes ses portées).

L'écran ([`EmailTemplatesPage.tsx`](../../frontend/src/pages/EmailTemplatesPage.tsx))
porte un sélecteur, un badge de portée répété dans l'éditeur, et un badge
**« Non configuré »** qui passe avant « Valide » : un modèle syntaxiquement
irréprochable qui n'existe pas dans cette portée n'enverra rien, et afficher
« Valide » en premier rassurerait à tort.

## EDITOR PROJET

`/bridge/v1/email-templates/*` — monté **après** `requireBridgeAuth`, comme les
capacités.
[`bridgeEmailTemplates.controller.js`](../../backend/src/controllers/bridgeEmailTemplates.controller.js)
ne contient **aucun** identifiant de projet lu depuis l'URL, la query ou le
corps : `scopeOfRequest()` est le seul producteur de portée, à partir de
`req.bridgeProject.projectId`.

Verbes servis : `GET` liste · `GET` détail · `PUT` · `preview` · `readiness` ·
`test-send` · `versions` · `restore` · `import`.

Éditer ne passe **pas** par une capacité : une capacité désigne un acte chez un
fournisseur, ouvre le coffre et réserve une opération. Enregistrer du texte ne
doit pas faire déchiffrer une clé Brevo. `test-send`, lui, **est** un acte
fournisseur et redescend par la passerelle, sans exception.

---

## PREVIEW / TEST SEND

Même résolveur, même renderer, même portée, même version.
Contrôlé littéralement par la recette :

```text
apercu.subject === renderForSend(...).subject
apercu.html    === renderForSend(...).html
apercu.version === renderForSend(...).version
```

Le bug « aperçu correct, e-mail différent » n'est pas corrigé : il est devenu
**structurellement impossible** côté Panel, parce qu'il n'y a qu'un résolveur et
qu'un renderer, et que la portée traverse les deux.

Le test-send d'une portée projet emprunte la chaîne réelle via
`INVOCATION_SOURCES.PANEL_INTERNAL` : le projet reste le périmètre entier, et la
portée du modèle en découle par `scopeOfInvocationContext`.

---

## HISTORY / RESTORE

Versions et restaurations sont filtrées par `scopeFilter(scope)`. Restaurer la
v1 de `PROJECT/A/X` ne peut ni lire ni écrire la v1 de `PANEL/X` — même code,
même numéro, documents étrangers l'un à l'autre.

Corrigé au passage : `getEditableTemplateVersion` codait `projectId: null` en
dur et `restoreEditableTemplateVersion` passait `{}` littéral (incohérence n°10
de l'audit) — une portée projet, une fois créée, était **irrestaurable** depuis
l'IHM.

---

## OBSERVABILITY

| surface | champs ajoutés |
|---|---|
| sortie de capacité | `templateCode`, `templateScope`, `templateScopeId`, `templateVersion`, `templateSource` |
| journal `[capabilities]` + timeline | `artefact: { … }`, liste blanche nommée champ par champ |
| `PanelCapabilityOperation` | `templateScope`, `templateScopeId`, `templateVersion` (écrits à l'**aboutissement**, pas à la réservation) |
| `EmailDelivery` (projet) | `templateVersion` = celle du **Panel**, plus la locale |

Ligne réelle produite par la recette :

```json
{"capability":"email.send_template","projectId":"74b608…","outcome":"SUCCEEDED",
 "artefact":{"templateCode":"PASSWORD_RESET_REQUEST","templateScope":"PROJECT",
 "templateScopeId":"74b608…","templateVersion":1,"templateSource":"PROJECT"}}
```

La question « quel document exact est parti, pour quel projet, quelle version ? »
a désormais une réponse *a posteriori*.

**Pourquoi une liste blanche et pas `...result`** : une sortie de capacité peut
contenir un identifiant de message, demain autre chose. Recopier la sortie
entière dans un journal lu sans précaution ferait entrer, un jour, une donnée qui
n'a rien à y faire.

---

## EMAILDELIVERY (Phase 14)

`EmailDelivery.templateVersion` portait la version du document **local** du
projet — un numéro qui n'a jamais été expédié depuis L8.4C, affiché avec
l'assurance d'un champ nommé « version exacte utilisée ».

Corrigé : `0` à la création (« pas encore su »), puis la version rendue par le
Panel à l'acceptation. Un rejeu (`ALREADY_SENT`) ne l'écrase pas — la réponse
mémorisée ne porte pas de version, et la valeur du premier envoi est la vérité
de CE message.

Le contrôle de la suite projet a été **renforcé** : il vérifiait
`typeof doc.templateVersion === 'number'`, ce qui passait sur le mensonge. Il
vérifie désormais une valeur qu'aucun compteur local ne peut atteindre.

---

## SECURITY / TENANT ISOLATION

| opération | A → B | A → PANEL | garde |
|---|---|---|---|
| lire | **non** | **non** | `scopeOfRequest()` ne produit que la portée du jeton |
| écrire | **non** | **non** | idem |
| aperçu | **non** | **non** | idem |
| test-send | **non** | **non** | idem + passerelle |
| historique / restauration | **non** | **non** | `scopeFilter` dans la clé de recherche |
| forcer une portée par le corps | **non** | **non** | `assertNoScopeInBody` → 400 |
| code d'une autre portée | **non** | **non** | `assertScopeAllowedForCode` → 400 |

Le Panel DEV administre **toutes** les portées : c'est son rôle de dépannage du
parc, et le serveur lui **énumère** les portées plutôt que de le laisser les
inventer.

### La faille P1 de l'audit, refermée

`PUT /api/email-templates/:code { "projectId": "…" }` créait un document
invisible de l'IHM, hors historique, non restaurable — et servi en production.

Deux gestes, et il en fallait deux :

1. **le corps est refusé**, pas ignoré (`PANEL_EMAIL_TEMPLATE_SCOPE_IN_BODY`) —
   un corps ignoré en silence laisse l'appelant croire qu'il a agi, et invite le
   prochain développeur à rebrancher le champ ;
2. **la signature rend l'injection structurellement impossible** :
   `saveTemplate(code, scope, patch, actor)` — il n'y a plus de champ de portée
   dans le patch à déstructurer.

Sept champs sont refusés : `projectId`, `project_id`, `projectKey`, `scopeId`,
`scope_id`, `scopeType`, `scope_type`, `scope`.

---

## PROJECT TERMINATION

**Doctrine appliquée :**

```text
projet actif      → templates actifs, envoi permis
appairage révoqué → templates CONSERVÉS, historique CONSERVÉ, envoi BLOQUÉ
réactivation      → le projet retrouve SES modèles, pas ceux du moment
templates PANEL   → jamais touchés
```

Prouvé par la recette (section 9) : révoquer B bloque ses envois (zéro appel
fournisseur), conserve ses documents **à l'octet près** et son historique, et ne
touche ni `PANEL/*` ni `PROJECT/A/*`.

> **Écart assumé avec le §19 du lot.** Celui-ci demandait un état de cycle de vie
> lisible par la passerelle. Entre l'audit et ce lot, la passerelle a été
> **délibérément simplifiée** par une autre mission : octrois de capacité et
> ouverture commerciale en ont été retirés. Ajouter un troisième verrou aurait
> contredit cette décision le jour même. Le verrou d'exécution restant est
> l'**appairage** — et il suffit : un jeton révoqué n'ouvre plus rien. Ce qui
> compte pour CE lot est ailleurs et est tenu : la révocation ne détruit aucun
> contenu.

## PROJECT DELETION

`removeProject()` n'a **pas** été modifié : il exige toujours la révocation
préalable et ne touche que `PanelProject`. Aucune cascade destructrice n'a été
ajoutée — politique **archive / rétention**, conformément au §21.

Conséquence à connaître : supprimer une fiche laisse des templates scopés
orphelins. C'est **délibéré pour ce lot** (le contenu a été écrit par un humain)
et **listé dans les risques restants** : une purge doit être une décision, pas
un effet de bord.

## PROJECT DUPLICATION

Le moteur de duplication ne mentionne toujours pas les templates. Le geste
correct existe désormais et est éprouvé : `provisionProjectTemplates(nouveau)`
crée des **documents propres**, en version 1, sans historique cloné.

Contrôlé : aucun `_id` partagé entre deux projets, rejouer la pose ne crée rien
et n'écrase aucun contenu écrit entre-temps.

**Le brancher dans `duplication-engine/` reste à faire** — cf. risques restants.

---

## MIGRATION — dans quel ordre jouer

> ⚠️ **CE PLAN A ÉTÉ REMPLACÉ — voir « CYCLE DE VIE DES INSTANCES » en fin de
> document.** Il décrivait une migration MANUELLE en cinq étapes ; aucune n'a
> jamais été jouée, et le parc entier est resté sans instance PROJECT pendant
> toute la durée du lot. Les trois passages sont désormais AUTOMATIQUES au
> démarrage du Panel. Le plan ci-dessous est conservé pour l'histoire.

```text
1. déployer ce lot                    (le seed ne pose plus que les 7 codes PANEL)
2. backfillScopeTypes()                (déterministe, idempotente)
3. pour chaque projet du parc :
     a. import du HTML local           scripts/migrate-email-templates-to-panel.mjs
        ou provisionProjectTemplates() si aucun contenu propre n'existe
     b. relire chaque modèle dans l'écran Panel, portée du projet
4. vérifier qu'aucun code projet ne reste « Non configuré »
5. recette Brevo réelle (ci-dessous)
```

**L'étape 3 n'est pas facultative.** Le fail-closed est actif dès le déploiement :
un projet sans instance verra ses envois refusés — bruyamment, avec
`EMAIL_TEMPLATE_NOT_CONFIGURED`, ce qui est le but, mais il faut l'avoir voulu.

---

## FILES CHANGED

### Panel — créés

```text
backend/src/services/email/panelEmailTemplateScope.js        portée : construction, validation, traduction
backend/src/services/email/panelEmailTemplateDefinitions.js  contrat fonctionnel + classification d'ownership
backend/src/middlewares/templateScope.middleware.js          la portée d'une requête, seul point d'entrée réseau
backend/src/controllers/bridgeEmailTemplates.controller.js   surface d'édition scopée du projet
tests/email-template-multi-project.test.js                   recette du lot (90 contrôles)
docs/email/EMAIL_TEMPLATE_MULTI_PROJECT_IMPLEMENTATION_REPORT.md
```

### Panel — modifiés

```text
backend/src/models/PanelEmailTemplate.model.js          + scopeType, + index de catalogue
backend/src/models/PanelEmailTemplateVersion.model.js   + scopeType
backend/src/models/PanelCapabilityOperation.model.js    + templateScope/ScopeId/Version
backend/src/services/email/panelEmailTemplate.service.js        resolver fail-closed, écriture scopée, provisioning, backfill
backend/src/services/email/panelEmailTemplateEditor.service.js  toutes les opérations scopées
backend/src/services/capabilities/brevoSendAdapter.js           portée déduite du contexte, artefact rendu
backend/src/services/capabilities/capabilityRegistry.js         sortie enrichie (5 champs facultatifs)
backend/src/services/capabilities/capabilityGateway.service.js  describeArtefact + journal
backend/src/services/capabilities/operationRegistry.js          artefact persisté à l'aboutissement
backend/src/controllers/emailTemplates.controller.js            portée depuis req.templateScope
backend/src/routes/emailTemplates.routes.js                     garde de portée, routes méta
backend/src/routes/bridge.routes.js                             + surface email-templates
frontend/src/lib/api.ts                                         scopeQuery(), méthodes scopées
frontend/src/types.emailTemplates.ts                            types de portée
frontend/src/pages/EmailTemplatesPage.tsx                       sélecteur, badges, « non configuré »
frontend/src/styles.css                                         .template-scope-picker / -badge
tests/architecture.test.js                                      recette déclarée outil d'atelier
tests/brevo-send-template-foundation.test.js                    §3 retournée, appels scopés
tests/template-editor-ui.test.js                                contrôles de portée
tests/run-all.js                                                + recette du lot
```

### SB Auto — modifiés / créés

```text
backend/src/models/EmailDelivery.model.js               templateVersion = celle du Panel
backend/src/services/email/emailDelivery.service.js     persiste la version rendue, journal honnête
backend/src/scripts/email-delivery.test.js              contrôle de VALEUR, plus de type
scripts/migrate-email-templates-to-panel.mjs            migration unique du HTML local   (créé)
```

---

## AUTOMATED TESTS

`tests/email-template-multi-project.test.js` — **90 contrôles, 0 échec**, faux
Brevo qui parle vraiment HTTP, projets appairés par la **vraie** route de pont.

```text
1  parité STRICTE des 6 contrats communs des deux registres   (§0.2)
2  classification complète, appelants cités, §16 vérifié      (§2-3)
3  injection de portée par le corps : 7 champs refusés        (§0.1)
   portée d'un projet inconnu refusée · portée inventée refusée
4  même code, 3 portées, 3 documents, 3 sujets                (§25)
   réécrire PANEL ne change rien chez un client
5  corps réellement posté à Brevo : 3 contenus, 1 expéditeur  (§18)
   observabilité : portée + version dans l'opération          (§13)
6  fail-closed : projet sans instance → refus, ZÉRO appel     (§5)
7  isolation : A↛B, A↛PANEL, catalogue filtré, restore étanche (§24, §12)
8  aperçu === runtime, au caractère près                       (§10)
9  résiliation : envois bloqués, contenu conservé, réactivation (§19-20)
10 duplication : aucun document partagé, pose idempotente      (§22)
   import du contenu local, code PANEL refusé sans tout casser (§5.1)
11 aucun secret, aucune portée voisine ne traverse le pont
```

### Régression exécutée

| suite | résultat |
|---|---|
| `email-template-multi-project` | 90 / 0 |
| `brevo-send-template-foundation` | 92 / 0 |
| `template-editor` · `template-editor-ui` | 18 / 0 · 23 / 0 |
| `architecture` | 31 / 0 |
| `global-email-sender` | 92 / 0 |
| `capability-gateway` · `capabilities` | 117 / 0 · 18 / 0 |
| `bridge-http` · `bridge-conformity` | 92 / 0 · 60 / 0 |
| `password-reset` · `password-reset-ui` | 25 / 0 · 24 / 0 |
| `registry` · `project-creation` · `duplication-e2e` | 75 / 0 · 100 / 0 · 48 / 0 |
| `webhook-control-plane` · `brevo-control-plane` | 238 / 0 · 237 / 0 |
| `finance-payment-requests` · `…-default-notifications` | 85 / 0 · 77 / 0 |
| `supervision` · `panel-ui` | 128 / 0 · 79 / 0 |
| SB Auto `email-delivery` · `email-templates` | 183 / 0 · 223 / 0 |
| SB Auto `auth-password-reset` · `contact` · `brevo-webhook` | 25 / 0 · 269 / 0 · 147 / 0 |
| frontend `tsc --noEmit` | 0 erreur |

**Deux suites échouent, et pas à cause de ce lot :**
`capability-gateway-e2e.test.js` et `brevo-send-delivery-convergence-e2e.test.js`
importent `services/capabilities/capabilityGrants.js`, **supprimé** par la
mission de simplification de la passerelle en cours dans le même arbre de
travail (`git status` : `D capabilityGrants.js`, `D commercialReadiness.js`).
Elles échouent en `ERR_MODULE_NOT_FOUND` avant toute assertion. Réparation à la
charge de ce chantier-là.

---

## REAL BREVO RECIPES

**NON EXÉCUTÉE.** Je n'ai ni clé Brevo de production, ni boîte de réception pour
constater. La déclarer faite serait exactement le genre de « vert » qui fait
déployer.

Ce qui a été livré à la place : la recette **automatisée équivalente**, qui
emprunte la chaîne réelle jusqu'au corps HTTP posté au fournisseur — même
résolveur, même renderer, même expéditeur, même coffre, même transport, seul le
serveur Brevo est local.

### Procédure manuelle à jouer, une fois la migration faite

```text
A. PANEL
   1. Panel → Templates e-mail → portée « Panel — L.Y Solution »
   2. PASSWORD_RESET_REQUEST → onglet Éditeur → « Envoyer un test »
   3. relever : sujet reçu, expéditeur, et dans la réponse
      templateScope=PANEL, templateScopeId=null, templateVersion=N

B. PROJET
   4. même écran, portée « SB Auto 06 »
   5. même code, « Envoyer un test »
   6. relever : templateScope=PROJECT, templateScopeId=<id>, templateVersion=M

C. PREUVES ATTENDUES
   ✓ expéditeur IDENTIQUE dans les deux messages reçus
   ✓ HTML différent, sujet différent
   ✓ scope différent, version différente
   ✓ deux lignes PanelCapabilityOperation portant chacune sa portée
   ✓ deux événements de timeline portant `artefact`

Ne pas coller de token ni de mot de passe dans le compte rendu.
```

---

## REMAINING RISKS

| # | risque | gravité | note |
|---|---|---|---|
| 1 | ~~**La migration du contenu n'est pas jouée.**~~ **RÉALISÉ — le risque s'est produit.** Aucune étape n'a été jouée : 11 documents sans portée, 0 instance PROJECT sur 8 projets, aucun e-mail de projet possible. Fermé par la réconciliation au démarrage. | ~~élevée~~ **fermé** | voir « CYCLE DE VIE DES INSTANCES » |
| 2 | ~~Le moteur de duplication n'appelle pas `provisionProjectTemplates()`~~ | ~~moyenne~~ **fermé** | plus nécessaire : la réconciliation au démarrage sert tout projet du registre, quelle que soit son origine |
| 3 | La persistance locale SB Auto est **toujours là** et diverge silencieusement de ce qui part | moyenne | retrait conditionné par le §23 à une preuve de migration ; le script ne supprime rien |
| 4 | L'écran manager de SB Auto écrit **encore** en local | moyenne | la surface serveur dont il dépend existe (`/bridge/v1/email-templates`) ; sa réécriture reste à faire |
| 5 | Suppression de projet sans cascade → templates scopés orphelins | faible | délibéré (politique archive/rétention) ; une purge doit rester une décision |
| 6 | Deux registres de variables coexistent | faible | la **parité est désormais gardée** par un test qui échoue à la première divergence |
| 7 | Contrat de variables non scopé (option A) | faible | assumé ; l'endroit pour l'option B existe (`TemplateDefinition`) |
| 8 | `retentionClass` toujours déclarée et jamais lue | faible | hors périmètre de ce lot |
| 9 | Deux suites e2e rouges par effet de bord d'un autre chantier | faible | diagnostic établi ci-dessus, réparation hors périmètre |

---

## FINAL VERDICT

```text
PANEL
= plan de contrôle unique du transport ET du stockage technique

PANEL scope
= contenu de L.Y Solution — 7 codes, indépendants de tout projet

PROJECT scope
= contenu propre à chaque projet — 5 codes, un document par projet

PASSWORD_RESET_REQUEST
= le même contrat, DEUX instances distinctes, DEUX branding

GLOBAL SENDER
= inchangé, unique pour le parc

PROJECT
= aucune clé Brevo, aucun secret, aucune portée voisine
= demande l'envoi de SON template, par un CODE NU

PANEL
= déduit la portée du jeton — jamais de la charge utile
= valide les variables contre le contrat du code
= rend
= choisit le sender global
= envoie
= journalise le document EXACT qui est parti
```

**Verdict : les invariants structurels du lot sont tenus et prouvés en recette
automatisée. Le lot n'est pas `PASS` au sens strict du cahier des charges, pour
deux raisons nommées et non contournées : la recette Brevo réelle n'a pas pu être
jouée (aucun accès), et la migration du contenu SB Auto n'a pas été exécutée en
production — l'outil existe, la décision de le jouer appartient à l'exploitant.**

---

## CYCLE DE VIE DES INSTANCES — qui les pose, et quand

*Ajouté après l'incident « aucun modèle n'est configuré pour cette portée ».*

### Ce qui s'est réellement passé

Le lot L11.1 a livré une résolution fail-closed correcte et **deux** mécanismes
de pose — `backfillScopeTypes()` et `provisionProjectTemplates()`. Il n'en a
branché **aucun** : le seul appelant de production était le verbe d'import du
pont, que le PROJET doit déclencher lui-même, et qu'aucun projet n'a appelé.

Mesuré en base de recette, sept jours après le lot :

```text
panelemailtemplates       11 documents, TOUS sans scopeType
instances PROJECT          0, sur 8 projets au registre
conséquence               aucun projet du parc ne pouvait envoyer un e-mail
```

Le refus était **exact** — c'est la pose qui n'avait jamais eu lieu. Et le
défaut était doublement invisible :

* le contenu écrit à la main dans l'éditeur était introuvable pour le résolveur
  (`{ scopeType:'PANEL', projectId:null }` ne matche pas un document sans
  `scopeType`), donc le Panel servait le **défaut du registre** — le même texte,
  d'où l'absence de symptôme ;
* `seedPanelTemplates()` heurtait pour la même raison l'index unique
  `(templateCode, projectId)` à **chaque** démarrage, et son échec partait dans
  un `catch` non bloquant.

### Les trois passages, dans cet ordre, à chaque démarrage

`server.js`, juste avant les migrations d'agenda :

```text
1. backfillScopeTypes()          pose scopeType sur les documents hérités
2. seedPanelTemplates()          complète le contenu de portée PANEL
3. reconcileProjectTemplates()   pose, sur CHAQUE projet du registre, les
                                 instances des codes provisionForProjects
```

L'ordre n'est pas interchangeable : sans (1), (2) ne retrouve pas les documents
hérités et heurte l'index unique.

### Comment un modèle est attribué à un projet

**Il n'existe ni collection d'attribution, ni champ `projectIds[]`, ni notion
d'`assignment`.** Dans cette architecture, l'attribution EST l'existence du
document `(scopeType:PROJECT, projectId, templateCode)`. Provisionner, c'est
attribuer ; il n'y a rien d'autre à tenir à jour, et rien d'autre à regarder.

### Et un modèle ajouté demain ?

Une nouvelle `TemplateDefinition` en portée `PROJECT` avec
`provisionForProjects: true` atteint **tout le parc au démarrage suivant**, sans
intervention. C'est `reconcileProjectTemplates()` qui l'apporte, par le même
passage qui sert un projet créé la veille.

### Ce que la réconciliation ne peut pas faire

`ensureInstance()` lit avant d'écrire : une instance présente n'est **jamais**
réécrite. Survivent donc à un nombre quelconque de passages : un contenu
personnalisé, une version 7, un modèle désactivé à la main. Elle **complète**,
elle ne resynchronise pas.

### Réparer sans redémarrer

```bash
npm run migrate:email-template-provisioning -- --dry-run   # rapport seul
npm run migrate:email-template-provisioning                # applique
```

Mêmes fonctions, même ordre : deux chemins qui répareraient différemment
finiraient par diverger.

### La garde

`tests/email-template-provisioning-lifecycle.test.js` (44 assertions) couvre les
quatre moments de vie — base héritée, projet existant, projet nouveau, **modèle
nouveau** — plus la non-écrasement des personnalisations, le respect d'un modèle
désactivé, et l'absence d'instance PROJECT pour un code PANEL.

Aucune suite ne pouvait voir le défaut auparavant : chacune **posait elle-même**
ses instances avant d'éprouver la résolution. Elles vérifiaient que la mécanique
fonctionne quand on l'actionne ; personne ne vérifiait qu'on l'actionne.
