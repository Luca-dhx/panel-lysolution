# AUDIT — PROPRIÉTÉ DES TEMPLATES E-MAIL : PANEL VS PROJETS

> **⚠ CET AUDIT DÉCRIT L'ÉTAT *AVANT* LE LOT L11.1. IL EST CONSERVÉ TEL QUEL.**
>
> Il n'est pas réécrit, et c'est délibéré : un audit réécrit après coup perd sa
> valeur de constat daté, et l'on ne peut plus vérifier ce qui a été corrigé ni
> pourquoi. Les décisions prises, ce qui a été implémenté et ce qui ne l'a pas
> été sont dans
> [`EMAIL_TEMPLATE_MULTI_PROJECT_IMPLEMENTATION_REPORT.md`](./EMAIL_TEMPLATE_MULTI_PROJECT_IMPLEMENTATION_REPORT.md).
>
> **Résolution des questions ouvertes** (§OPEN QUESTIONS, en bas de ce document) :
>
> | # | question | décision |
> |---|---|---|
> | 1 | contrat de variables : A ou B ? | **A** — contrat plateforme, texte scopé |
> | 2 | `From` par projet ? | **non** — hors périmètre, `From` reste global |
> | 3 | `SHARED` nécessaire ? | **non** — les 2 candidats sont tranchés (PANEL / PROJECT) |
> | 4 | que devient le HTML local du projet ? | **repris** — import par le pont, script de migration, rien n'est supprimé |
> | 5 | qui peut créer un code `PROJECT` ? | **le Panel seul** — le registre reste code-first |
> | 6 | le fail-closed casse-t-il des envois ? | **oui, par construction** — d'où le séquencement de migration du rapport |
> | 7 | rétention | **non traitée** — hors périmètre, listée aux risques restants |
>
> **État des 19 tests du §TEST PLAN** : 1-5, 9, 13-17 étaient rouges et sont
> désormais couverts par `tests/email-template-multi-project.test.js` ;
> 19 (orphelins à la suppression) reste **non couvert**, par décision assumée.

> Audit en lecture seule. Aucune correction n'a été appliquée. Chaque affirmation
> est rattachée à un fichier et une ligne. Rien n'est déduit d'un nom.
>
> Périmètre tracé : `Panel/backend`, `Panel/frontend`, `SB Auto 06/backend`,
> `SB Auto 06/manager`.

---

## EXECUTIVE VERDICT

**La doctrine visée n'est pas respectée. Elle n'est pas partiellement respectée :
elle est absente du chemin d'exécution.**

Le Panel détient aujourd'hui **100 % du contenu, 100 % des variables, 100 % du
rendu, 100 % de l'expéditeur et 100 % du transport**. Aucun projet du parc ne
possède un seul octet de HTML qui soit réellement expédié.

Trois constats portent tout le rapport :

1. **Le champ de portée existe, le chemin qui l'alimente n'existe pas.**
   `PanelEmailTemplate` porte bien un `projectId`
   ([modèle L62](../../backend/src/models/PanelEmailTemplate.model.js#L62)) et
   `resolveTemplate()` sait bien lire « le contenu du projet, sinon celui de la
   plateforme »
   ([service L121-L162](../../backend/src/services/email/panelEmailTemplate.service.js#L121)).
   Mais **aucun code, nulle part, n'écrit une ligne dont le `projectId` ne soit
   pas `null`**. Vérifié par recensement exhaustif des écrivains : seuls
   `seedPlatformTemplates()` (qui écrit `projectId: null` en dur, L81/L93) et
   `saveTemplate()` (dont l'unique appelant ne transmet jamais de projet,
   [éditeur L123](../../backend/src/services/email/panelEmailTemplateEditor.service.js#L123)).
   La branche « projet » du résolveur est **du code mort atteignable par
   personne**.

2. **Conséquence directe et vérifiable : le mot de passe oublié du Panel et le
   mot de passe oublié du manager SB Auto rendent le MÊME document.** Les deux
   passent par `PASSWORD_RESET_REQUEST` ; le premier avec `projectId: null`, le
   second avec `projectId: "sb-auto…"` qui ne trouve rien et retombe sur la même
   ligne plateforme. Seule la valeur de `{{company.name}}` diffère. Un DEV qui
   édite ce modèle dans le Panel réécrit simultanément l'e-mail de tous les
   clients du parc, présents et à venir.

3. **L'éditeur de templates de SB Auto est une surface fantôme.** Il écrit
   réellement dans la base SB Auto
   ([service projet L270](../../../SB%20Auto%2006/backend/src/services/email/emailTemplate.service.js#L270)),
   son aperçu rend réellement ce qu'on tape — et **rien de tout cela n'est jamais
   expédié**. L'envoi traverse le pont et le Panel rend son propre document
   ([delivery L331-L341](../../../SB%20Auto%2006/backend/src/services/email/emailDelivery.service.js#L331)).
   Un développeur peut passer une heure à soigner un e-mail client, l'aperçu lui
   donnera raison, le test lui donnera tort sans le dire, et la production
   enverra autre chose.

Le système actuel est un **plan de contrôle du transport ET du contenu**, alors
que la doctrine souhaitée n'en veut qu'un du transport. Le modèle de données
supporterait le changement (l'index unique est déjà `(templateCode, projectId)`),
mais **le registre de variables, l'éditeur, l'API et la doctrine de repli
devront tous changer** : ce n'est pas un backfill, c'est un lot.

**Prêt pour des dizaines de projets ? Pour l'acheminement, oui. Pour du contenu
différencié, non — et pas « pas encore » : la seule chose qui différencie
aujourd'hui deux projets est la valeur d'une variable.**

---

## CURRENT PANEL ARCHITECTURE

### Composants réels

| Rôle | Fichier | Nature |
|---|---|---|
| Registre canonique (codes + variables + défauts HTML) | `services/email/panelEmailTemplateRegistry.js` | code-first, `Object.freeze`, 11 codes |
| Persistance du contenu | `models/PanelEmailTemplate.model.js` | Mongo, `unique(templateCode, projectId)` |
| Historique | `models/PanelEmailTemplateVersion.model.js` | Mongo, `unique(templateCode, projectId, version)` |
| Autorité (résolution, rendu, écriture, restauration) | `services/email/panelEmailTemplate.service.js` | 405 l. |
| Façade éditeur (catalogue, aperçu, readiness, test) | `services/email/panelEmailTemplateEditor.service.js` | 352 l. |
| Rendu | `services/email/panelEmailTemplateRenderer.js` | substitution `{{clé}}` typée |
| Validation contenu | `services/email/panelEmailTemplateValidator.js` | sécurité HTML + variables |
| Contrôleur | `controllers/emailTemplates.controller.js` | 9 routes |
| Routes | `routes/emailTemplates.routes.js` | `requirePanelUser` + `requirePanelDev` |
| Écran | `frontend/src/pages/EmailTemplatesPage.tsx` | — |
| Exécutant de l'envoi | `services/capabilities/brevoSendAdapter.js` | capacité `email.send_template` |
| Transport | `services/integratedApi/brevo/brevoTransport.js` | `POST /v3/smtp/email` |
| Expéditeur | `services/email/panelSenderIdentity.service.js` + `panelGlobalSender.service.js` | `From` global, `Reply-To` projet |
| Journal d'opérations | `models/PanelCapabilityOperation.model.js` | `unique(projectId, capability, operationId)` |

### Ce que le code détient, ce que la base détient

Découpage explicite et respecté
([registre L23-L36](../../backend/src/services/email/panelEmailTemplateRegistry.js#L23)) :

```text
CODE (registre, non modifiable en base)   BASE (PanelEmailTemplate)
──────────────────────────────────────    ─────────────────────────
templateCode                              name
variables autorisées                      description
types des variables                       subject
caractère obligatoire (required)          html
valeurs d'exemple (sampleVariables)       enabled / version
```

`assertKnownTemplate()` refuse tout code absent du registre
([service L40](../../backend/src/services/email/panelEmailTemplate.service.js#L40)).
**La base ne peut pas inventer un code ; le registre ne peut pas être enrichi
depuis une interface.** C'est une bonne propriété — mais elle est aujourd'hui
appliquée à un registre **unique et global**, ce qui est précisément le point
qui bloque la doctrine cible (cf. *VARIABLE OWNERSHIP*).

---

## CURRENT SB AUTO ARCHITECTURE

SB Auto possède **une pile complète et autonome** — modèles, registre, service,
validateur, renderer, contrôleur, routes, écran manager, tests :

| Objet | Fichier | Vivant ? |
|---|---|---|
| `EmailTemplate` (`unique(templateId)`) | `models/EmailTemplate.model.js` | oui, écrit |
| `EmailTemplateVersion` | `models/EmailTemplateVersion.model.js` | oui, écrit |
| Registre local, 6 codes | `utils/emailTemplateRegistry.js` | oui, lu |
| Service éditeur complet | `services/email/emailTemplate.service.js` | oui |
| Renderer local | `services/email/emailTemplateRenderer.js` | oui, mais **pas pour l'envoi** |
| Contrôleur (CRUD, aperçu, test, historique, restore) | `controllers/emailTemplate.controller.js` | oui |
| Écran DEV | `manager/src/pages/dev/DevEmailTemplatesPage.tsx` | oui |

**Mais l'envoi ne s'en sert plus.** Le service de livraison est explicite
([delivery L234-L254](../../../SB%20Auto%2006/backend/src/services/email/emailDelivery.service.js#L234)) :

> « LE RENDU LOCAL EST UNE COMMODITÉ, PLUS UNE CONDITION (L8.4C). […] Le sujet et
> le HTML expédiés sont ceux que le PANEL rend, depuis son propre modèle. »

Le rendu local ne sert plus qu'à deux choses, toutes deux internes :

1. **valider les variables avant de traverser le pont** (diagnostic local plutôt
   que refus générique après aller-retour) ;
2. **alimenter `subjectSnapshot` et `templateVersion`** sur la livraison locale
   ([L285-L296](../../../SB%20Auto%2006/backend/src/services/email/emailDelivery.service.js#L285)).

Et son absence ne bloque plus rien : `if (template)` — un projet sans copie
locale envoie quand même ([L255-L267](../../../SB%20Auto%2006/backend/src/services/email/emailDelivery.service.js#L255)).

> **Verdict SB Auto : persistance propre = OUI. Éditeur propre = OUI. HTML
> propre = OUI en base, NON en production. Variables propres = NON (le Panel
> tranche). Versions propres = OUI mais sans effet. Historique propre = OUI mais
> sans effet.**

---

## CURRENT DATA MODEL

### `PanelEmailTemplate` (Panel — source de vérité réelle)

```text
templateCode : String  (doit exister au registre)
projectId    : String|null   ← null = DÉFAUT DE PLATEFORME
name, description, subject, html
enabled : Boolean       (désactivé ⇒ envoi REFUSÉ, jamais ignoré)
version : Number        (jeton d'édition optimiste)
updatedBy, createdAt, updatedAt : String ISO

INDEX UNIQUE : (templateCode, projectId)   nom « uniq_template_project »
```

> Mongo traite deux `null` comme égaux dans un index unique : il ne peut exister
> qu'un seul défaut de plateforme par code. La garantie est correcte.

### `EmailTemplate` (SB Auto — source de vérité locale, non expédiée)

```text
templateId : String  UNIQUE GLOBAL   ← pas de portée : la base EST la portée
name, description, subject, html, enabled, version
updatedBy : { actorType, actorId }
timestamps
```

L'isolation entre projets côté projet est assurée **par la séparation physique
des bases**, pas par un champ. C'est structurellement sain — mais sans objet,
puisque ces documents ne partent pas.

### `PanelProject` — ce qu'il ne porte PAS

```text
projectId, projectKey, projectName
pairing.status   : DECLARED | PAIRED | REVOKED
commercialState  : PREOPENING | LIVE | null
capabilityGrants : [String]
runtime, manifest, appliedConfiguration, note
```

**Aucun champ de cycle de vie commercial** : pas de `ACTIVE`, pas de
`SUSPENDED`, pas de `TERMINATED`, pas de `ARCHIVED`, pas de `DELETED`. Ce point
gouverne toute la section *PROJECT TERMINATION*.

---

## TEMPLATE INVENTORY

Onze codes au registre Panel, six au registre SB Auto. Colonnes :
**SoT** = source de vérité réellement expédiée. **Éditeur** = où un humain écrit.
**Résil.** = effet d'une résiliation.

| CODE | Scope réel | Owner réel | SoT | Éditeur | Renderer | Variables | Sender | Consommateur(s) | Fallback | Résil. | Verdict |
|---|---|---|---|---|---|---|---|---|---|---|---|
| `PASSWORD_RESET_REQUEST` | **PLATEFORME unique** | PANEL | `PanelEmailTemplate(projectId:null)` | Panel DEV (+ SB Auto, **sans effet**) | Panel | registre Panel | `From` global | Panel `panelPasswordReset.service.js:244` **ET** SB Auto `auth.service.js:101` | projet→plateforme (inatteignable) | aucun | **AMBIGUOUS — P0** |
| `CONTACT_ADMIN_NOTIFICATION` | PLATEFORME unique | PANEL | idem | idem | Panel | registre Panel | `From` global | SB Auto (dispatcher) | idem | aucun | **PROJECT attendu → P0** |
| `CONTRACT_CANCELLATION_ADMIN_CONFIRMATION` | PLATEFORME unique | PANEL | idem | idem | Panel | registre Panel | `From` global | SB Auto (métier contrat) | idem | aucun | AMBIGUOUS |
| `CONTRACT_CANCELLATION_DEV_NOTIFICATION` | PLATEFORME unique | PANEL | idem | idem | Panel | registre Panel | `From` global | SB Auto | idem | aucun | SHARED plausible |
| `EMAIL_SENDER_VERIFICATION_TEST` | PLATEFORME unique | PANEL | idem | idem | Panel | registre Panel | `From` global | SB Auto (test DEV) | idem | aucun | SHARED (technique) |
| `SITE_SUSPENDED_MANUAL_ADMIN` | PLATEFORME unique | PANEL | idem | Panel DEV (+ SB Auto) | Panel | registre Panel | `From` global | SB Auto (suspension manuelle) | idem | aucun | AMBIGUOUS |
| `PAYMENT_REQUEST_CREATED` | PLATEFORME | **PANEL (légitime)** | idem | Panel DEV | Panel | registre Panel | `From` global | Panel `paymentRequestEmails.js` | s.o. | s.o. | **PANEL ✓** |
| `PAYMENT_REQUEST_REMINDER` | PLATEFORME | **PANEL (légitime)** | idem | Panel DEV | Panel | registre Panel | `From` global | Panel (relance auto) | s.o. | s.o. | **PANEL ✓** |
| `SITE_SUSPENDED_PAYMENT_DEFAULT_CLIENT` | PLATEFORME | **PANEL (légitime)** | idem | Panel DEV | Panel | registre Panel | `From` global | Panel `paymentDefaultAnnouncements.js` | s.o. | s.o. | **PANEL ✓** |
| `SITE_SUSPENDED_PAYMENT_DEFAULT_TEAM` | PLATEFORME | **PANEL (légitime)** | idem | Panel DEV | Panel | registre Panel | `From` global | Panel (interne) | s.o. | s.o. | **PANEL ✓** |
| `PANEL_EMAIL_SENDER_TEST` | PLATEFORME | **PANEL (légitime)** | idem | Panel DEV | Panel | registre Panel | `From` global | Panel `panelEmailSenderTest.service.js:122` | s.o. | s.o. | **PANEL ✓** |

### Classement

```text
PANEL      (5)  PAYMENT_REQUEST_CREATED, PAYMENT_REQUEST_REMINDER,
                SITE_SUSPENDED_PAYMENT_DEFAULT_CLIENT,
                SITE_SUSPENDED_PAYMENT_DEFAULT_TEAM, PANEL_EMAIL_SENDER_TEST
                → ownership correct, rien à changer

PROJECT    (0)  aucun. C'est LE constat du rapport.

SHARED     (2)  EMAIL_SENDER_VERIFICATION_TEST, CONTRACT_CANCELLATION_DEV_NOTIFICATION
                → partage plausible mais JAMAIS déclaré comme tel

AMBIGUOUS  (4)  PASSWORD_RESET_REQUEST, CONTACT_ADMIN_NOTIFICATION,
                CONTRACT_CANCELLATION_ADMIN_CONFIRMATION, SITE_SUSPENDED_MANUAL_ADMIN
                → devraient être PROJECT, sont PLATEFORME

DEAD       (0)  côté Panel.
                Côté SB Auto : les 6 documents EmailTemplate locaux sont
                MORTS À L'ENVOI tout en restant vivants à l'écriture.
```

---

## PANEL TEMPLATE FLOW

Cas réel : `PANEL_EMAIL_SENDER_TEST` (écran « Expéditeur e-mail »).

```text
ÉTAPE            FICHIER                                    FONCTION                  MODÈLE                  DATA OWNER
─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
déclencheur      frontend/pages/EmailSenderPage.tsx         (clic opérateur)          —                       PANEL
service          services/email/panelEmailSenderTest…:122   invokeCapability          PanelEmailSenderTest    PANEL
contexte         capabilities/invocationContext.js          buildPanelSelfContext     —                       PANEL
                                                            → projectId = null
octroi           capabilityGateway.service.js:160-166       SAUTÉ (PANEL_SELF)        —                       PANEL
ouverture        commercialReadiness.js:289                 canExecute                —                       PANEL
                                                            COMMUNICATION_WRITE → OK
expéditeur       email/panelSenderIdentity.service.js:75    resolveForPanel()         (config globale)        PANEL
résolution       email/panelEmailTemplate.service.js:121    resolveTemplate(code,     PanelEmailTemplate      PANEL
                                                            {projectId:null})         (projectId:null)
rendu            email/panelEmailTemplateRenderer.js        renderTemplate            —                       PANEL
transport        integratedApi/brevo/brevoTransport.js      sendTransactionalEmail    (clé du coffre)         PANEL
journal          models/PanelCapabilityOperation.model.js   —                         PanelCapabilityOperation PANEL
```

Chaîne **cohérente de bout en bout**. Aucune réserve : un e-mail du Panel,
détenu par le Panel, envoyé par le Panel. C'est le cas nominal.

---

## PROJECT TEMPLATE FLOW

Cas réel : `CONTACT_ADMIN_NOTIFICATION` (un visiteur remplit le formulaire du
site SB Auto).

```text
ÉTAPE            FICHIER                                       FONCTION              MODÈLE                DATA OWNER
────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
événement        SB/services/events/…                          dispatcher            DomainEvent           PROJET
handler          SB/services/email/sendEmailHandler.js         sendEmailHandler      —                     PROJET
destinataires    SB/services/email/emailRecipientResolvers.js  resolveRecipients     User                  PROJET   ✓
variables        SB/services/email/emailVariableResolvers.js   resolveVariables      Company, Contact      PROJET   ✓ (valeurs)
readiness        SB/services/email/emailReadiness.service.js   getEmailReadiness     —                     PROJET
« rendu »        SB/services/email/emailDelivery.service:255   renderTemplate        EmailTemplate (local) PROJET   ✗ JETÉ
livraison        SB/models/EmailDelivery.model.js              createOrGetDelivery   EmailDelivery         PROJET   ✓ (journal)
                 ↑ enregistre templateVersion = version LOCALE — pas celle qui partira
─────────────────────────────────  FRANCHISSEMENT DU PONT  ────────────────────────────────────────────────────────
appel            SB/services/panelBridge/capabilityClient.js   invokeCapability      —                     PROJET
                 payload = { templateRef, recipient, variables, replyTo?, operationId }
                 ⚠ AUCUN champ de portée. Aucun scope. Aucun projectId. Un CODE NU.
─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
authentif.       Panel/bridge (bridgeToken)                    requireBridgeAuth     PanelProject          PANEL
contexte         capabilities/invocationContext.js:100         buildInvocationContext —                    PANEL
                 → context.projectId PROUVÉ par le jeton (assertProjectScope)         ✓ solide
octroi           capabilityGrants.js:38                        assertGranted         PanelProject.grants   PANEL
ouverture        commercialReadiness.js:222                    COMMUNICATION_WRITE   —                     PANEL
expéditeur       email/panelSenderIdentity.service.js:63       resolveForProject     PanelProjectSender…   PANEL (From) / projet (Reply-To)
RÉSOLUTION       email/panelEmailTemplate.service.js:121       resolveTemplate       PanelEmailTemplate    ★ PANEL
                 own = findOne({templateCode, projectId:'sb-auto…'})  →  TOUJOURS null
                 platform = findOne({templateCode, projectId:null})   →  TOUJOURS servi
RENDU            email/panelEmailTemplateRenderer.js           renderTemplate        —                     ★ PANEL
transport        integratedApi/brevo/brevoTransport.js         sendTransactional…    (coffre Panel)        PANEL
```

**Le point ★ est le cœur du rapport.** Le projet fournit un code et des valeurs.
Le Panel fournit le document. L'ownership du contenu est intégralement plateforme.

---

## PASSWORD RESET CASE STUDY

C'est le cas qui prouve le problème sans ambiguïté possible, parce que les deux
chemins existent réellement et se rejoignent sur la même ligne de base.

```text
                    PANEL — « mot de passe oublié »
                    services/auth/panelPasswordReset.service.js:244
                    invokeCapability({ source: PANEL_SELF })
                    templateRef = 'PASSWORD_RESET_REQUEST'
                                     │
                                     │  context.projectId = null
                                     ▼
                    resolveTemplate('PASSWORD_RESET_REQUEST', { projectId: null })
                                     │
                                     ▼
                    ┌────────────────────────────────────────────┐
                    │  PanelEmailTemplate                        │
                    │  { templateCode:'PASSWORD_RESET_REQUEST',  │  ◀── LA MÊME LIGNE
                    │    projectId: null }                       │
                    └────────────────────────────────────────────┘
                                     ▲
                                     │  own = null  →  repli plateforme
                                     │
                    resolveTemplate('PASSWORD_RESET_REQUEST', { projectId:'sb-auto…' })
                                     ▲
                                     │  context.projectId = 'sb-auto…'
                    SB AUTO — « mot de passe oublié » du manager
                    services/auth.service.js:101 → sendTemplate({templateId})
                    → emailDelivery.service.js:332 → controlPlane.invoke
```

**Preuve du repli.** `resolveTemplate`
([L124-L128](../../backend/src/services/email/panelEmailTemplate.service.js#L124)) :

```js
const own = projectId
  ? await PanelEmailTemplate.findOne({ templateCode, projectId }).lean()
  : null;
const platform = await PanelEmailTemplate.findOne({ templateCode, projectId: null }).lean();
const stored = own ?? platform;
```

**Preuve que `own` est structurellement toujours `null`.** Recensement complet
des écritures de la collection :

| Écrivain | Fichier:ligne | `projectId` écrit |
|---|---|---|
| `seedPlatformTemplates()` | `panelEmailTemplate.service.js:79` | `null` **en dur** |
| `saveTemplate()` | `panelEmailTemplate.service.js:266` | paramètre, **défaut `null`** |
| `restoreVersion()` | `panelEmailTemplate.service.js:317` | paramètre, **défaut `null`** |

…et recensement complet des **appelants** de ces deux derniers :

| Appelant | Fichier:ligne | Transmet un projet ? |
|---|---|---|
| `updateEditableTemplate()` | `panelEmailTemplateEditor.service.js:123` | non (relaie `req.body`) |
| `restoreEditableTemplateVersion()` | `panelEmailTemplateEditor.service.js:337` | **non — `{}` littéral** |

Aucun autre appelant dans tout le dépôt. **Il n'existe donc aujourd'hui aucune
ligne `PanelEmailTemplate` avec un `projectId` non nul, et aucun moyen prévu
d'en créer une.**

Différence effective entre les deux e-mails : la valeur de `{{company.name}}`
et un `Reply-To`. Le sujet, la mise en page, le ton, le pied de page, la charte :
**identiques**.

---

## TEMPLATE RESOLUTION RULES

La résolution est **déterministe**, en trois niveaux, dans une fonction unique
([L121-L162](../../backend/src/services/email/panelEmailTemplate.service.js#L121)) :

```text
1. PanelEmailTemplate(templateCode, projectId)   → source = 'PROJECT'            [jamais atteint]
2. PanelEmailTemplate(templateCode, null)        → source = 'PLATFORM'           [toujours servi]
3. EMAIL_TEMPLATE_REGISTRY[code].defaultHtml     → source = 'REGISTRY_DEFAULT'   [base vide]
```

Points à porter au crédit de l'implémentation :

- **une seule fonction de résolution** pour l'aperçu, l'envoi, l'écriture et
  l'affichage du catalogue — aucune divergence possible *à l'intérieur du Panel* ;
- **le `projectId` n'est jamais lu de la charge utile** ; il vient du contexte
  prouvé par le jeton de pont
  ([`assertProjectScope`, invocationContext.js:107](../../backend/src/services/capabilities/invocationContext.js#L107)),
  qui accepte la redondance et refuse la divergence. C'est correct et robuste ;
- le champ `source` est calculé et remonté — l'infrastructure d'observabilité
  existe déjà, elle n'est simplement pas exploitée (cf. *OBSERVABILITY*).

Le défaut n'est pas dans le résolveur. **Il est dans le fait que la clé de
lookup, côté fil, est un `templateRef` NU** : le contrat de la capacité ne
transporte ni `scope`, ni `scopeType`. Le Panel le reconstitue à partir du jeton
— ce qui est plus sûr que de le recevoir, mais interdit d'exprimer « ce code-ci
est un modèle de plateforme partagé » vs « ce code-ci est le mien ».

---

## OWNERSHIP / SCOPE

### Concepts de portée présents dans le dépôt

| Concept | Existe ? | Où | Robustesse |
|---|---|---|---|
| `projectId` sur le template | **oui** | `PanelEmailTemplate.projectId` | schéma bon, **sans écrivain** |
| `scopeType` / `scopeId` | non | — | — |
| `tenantId` / `organizationId` | non | — | — |
| `namespace` | non | — | — |
| `environment` sur le template | **non, délibérément** | commenté au modèle L24-L29 | choix assumé |
| Portée de l'expéditeur | oui | `PanelProjectSenderIdentity(projectId, environment)` | **solide** |
| Portée du transport | oui | contexte de capacité, jeton de pont | **solide** |

### Verdict de portée

L'ownership est **implicite et binaire** : `projectId === null` ⇒ plateforme,
sinon projet. Il n'y a pas de troisième valeur possible, donc **aucun moyen de
déclarer un partage intentionnel**. Un modèle réellement plateforme
(`PAYMENT_REQUEST_CREATED`) et un modèle qui n'est plateforme que faute de mieux
(`PASSWORD_RESET_REQUEST`) sont **rigoureusement indiscernables en base**.

C'est le point qui rend un backfill par nom impossible, et le point qui rend
l'architecture cible nécessaire.

---

## VARIABLE OWNERSHIP

**C'est le verrou le plus dur du dossier, et il n'est pas dans la base.**

Les variables sont définies **dans le code, par code de template, globalement** :

```js
// panelEmailTemplateRegistry.js:829
export function variablesFor(templateId) {
  return getTemplateDefinition(templateId)?.variables || [];
}
```

Aucun paramètre de projet. Le validateur
([`panelEmailTemplateValidator.js`](../../backend/src/services/email/panelEmailTemplateValidator.js))
et le renderer s'appuient sur cette même liste. Conséquence formelle :

> **Le scénario du §10 du cahier des charges est aujourd'hui IMPOSSIBLE, même si
> l'on ajoutait demain la portée projet sur le contenu.**
>
> ```text
> Project A / PASSWORD_RESET_REQUEST → resetUrl, firstName, companyName
> Project B / PASSWORD_RESET_REQUEST → resetUrl, displayName, supportPhone
> ```
>
> Le Panel refuserait le HTML de B à la sauvegarde (`PANEL_EMAIL_TEMPLATE_INVALID`,
> variable inconnue) et refuserait l'envoi de B au rendu (variable requise
> `user.name` absente).

Ajouter `scopeType`/`scopeId` sur le contenu **ne suffira pas**. Il faudra
décider si le contrat de variables reste plateforme (option prudente : un code
= un contrat, chaque projet réécrit le texte mais pas les données) ou devient
scopé (option complète, plus coûteuse). Cette décision est le principal arbitrage
ouvert du lot — cf. *OPEN QUESTIONS*.

### Duplication du registre

Deux registres coexistent : 11 codes côté Panel, 6 côté SB Auto. J'ai comparé
**clé par clé** les variables des 6 codes communs : **elles sont aujourd'hui
strictement identiques** (même ordre, mêmes `required`, mêmes types).

Mais **aucun test ne garantit cette parité**. Les deux fichiers sont des copies
manuelles ; le registre Panel se déclare lui-même comme un déplacement d'autorité
(« Ce module vient du dépôt PROJET […] Le jour où l'envoi projet sera retiré
(L10), l'exemplaire d'origine partira avec lui »,
[registre L10-L13](../../backend/src/services/email/panelEmailTemplateRegistry.js#L10)).
Ce jour n'est pas venu. La dérive est une question de temps, et son symptôme
sera un refus d'envoi en production sur une variable requise ajoutée d'un seul
côté.

---

## SENDER OWNERSHIP

Le sender est **résolu par capacité**, jamais stocké dans le template
(aucun champ d'adresse dans les deux modèles — invariant explicite et respecté).

```text
From      →  GLOBAL, UNIQUE POUR TOUT LE PARC
             panelGlobalSender.service.js → resolveGlobalSender()
             identique pour le Panel et pour tous les projets
             absent ⇒ REFUS de tout envoi du parc entier

Reply-To  →  PAR PROJET, facultatif
             PanelProjectSenderIdentity(projectId, environment)
             absent ⇒ null (les réponses arrivent au support plateforme)
```

Preuve ([panelSenderIdentity.service.js:63-72](../../backend/src/services/email/panelSenderIdentity.service.js#L63)) :
`resolveForProject()` renvoie `fromEmail: global.senderEmail` — la fiche projet
n'est consultée que pour le `Reply-To`.

**Conséquence produit à trancher explicitement :** un e-mail de réinitialisation
de mot de passe destiné au client d'un garage part sous l'identité
**L.Y Solution**, pas sous celle du garage. Ce n'est **pas un bug** — c'est une
décision documentée (R10.4), motivée par le fait qu'un `From` de repli enverrait
sous une adresse que personne n'a choisie. Mais c'est incompatible avec la
doctrine « chaque projet écrit à ses destinataires sous son propre ton », et
**la garde de portée protège aujourd'hui le `Reply-To`, plus le `From`** — car
il n'y a plus de `From` à protéger.

---

## EDITOR OWNERSHIP

### Panel

- Routes : `PUT /:templateId`, protégées `requirePanelUser` + `requirePanelDev`
  ([routes L19-L20](../../backend/src/routes/emailTemplates.routes.js#L19)).
- **Aucun paramètre de projet nulle part** : ni en route, ni en contrôleur, ni
  en service, ni dans l'écran (`EmailTemplatesPage.tsx` ne contient ni
  `project`, ni `scope`, ni `source` — vérifié).
- `getEditableTemplateVersion()` code même `projectId: null` en dur
  ([éditeur L305](../../backend/src/services/email/panelEmailTemplateEditor.service.js#L305)).

**⚠ Asymétrie exploitable (P1).** `putEmailTemplate` relaie `req.body` tel quel
([contrôleur L30](../../backend/src/controllers/emailTemplates.controller.js#L30)),
et `saveTemplate` **déstructure `projectId` de cet objet**
([service L232](../../backend/src/services/email/panelEmailTemplate.service.js#L232)) :

```js
export async function saveTemplate(templateCode,
  { projectId = null, subject, html, name, description, enabled, expectedVersion }, actor)
```

Il n'existe **aucun validateur de corps** (le dossier `src/validators/` n'existe
pas côté Panel). Un DEV du Panel peut donc envoyer
`PUT /email-templates/PASSWORD_RESET_REQUEST { "projectId": "sb-auto", "html": "…" }`
et **créer une ligne de portée projet** que :

- l'éditeur ne montrera **jamais** (il lit toujours la plateforme) ;
- l'historique ne montrera **jamais** (`projectId: null` en dur) ;
- la restauration ne pourra **jamais** annuler (`{}` littéral) ;
- **mais que le runtime servira à ce projet, en priorité, indéfiniment.**

Ce n'est pas une brèche multi-tenant (la route est DEV-only), mais c'est un
**vecteur de divergence silencieuse et irréversible depuis l'IHM**. C'est la
seule correction que je recommanderais d'appliquer avant la refonte.

### SB Auto

Éditeur complet, écrivant réellement dans la base du projet, **sans aucun effet
sur ce qui est expédié**. Cf. *CURRENT SB AUTO ARCHITECTURE*.

---

## PREVIEW / TEST SEND / HISTORY

| Surface | Contenu rendu | Contenu réellement envoyé | Cohérent ? |
|---|---|---|---|
| Aperçu Panel | plateforme | plateforme | **✓** |
| Test-send Panel | plateforme (via `email.send_template`, `PANEL_SELF`) | plateforme | **✓ exemplaire** |
| Historique Panel | plateforme | plateforme | **✓** |
| **Aperçu SB Auto** | **local SB Auto** | — | **✗ P0** |
| **Test-send SB Auto** | annoncé « même pipeline » | **plateforme Panel** | **✗ P0** |
| **Historique SB Auto** | local SB Auto | sans rapport | **✗ P0** |
| **Restauration SB Auto** | local SB Auto | sans effet | **✗ P0** |

**Le test-send du Panel est irréprochable et mérite d'être cité comme modèle.**
`sendTemplateTestEmail()` passe par `invokeCapability('email.send_template')`
([éditeur L248](../../backend/src/services/email/panelEmailTemplateEditor.service.js#L248)) —
donc par la résolution, le rendu, la validation des variables, l'expéditeur et
le coffre réels. Le commentaire du registre l'explique
([L749-L757](../../backend/src/services/email/panelEmailTemplateRegistry.js#L749)) :
un corps fabriqué à la volée « réussirait là où un envoi réel échouerait ».
C'est exactement la bonne doctrine.

**Le test-send de SB Auto la viole**, et son commentaire l'affirme pourtant
([contrôleur L148-L150](../../../SB%20Auto%2006/backend/src/controllers/emailTemplate.controller.js#L148)) :

> « MÊME PIPELINE QUE LES ÉVÉNEMENTS : demoVariables → EmailDeliveryService →
> readiness → BrevoEmailProvider → EmailDelivery »

C'était vrai avant L8.4C. Depuis, `BrevoEmailProvider` a été remplacé par le
pont, et le pipeline rend le document du Panel. **Le commentaire est devenu
faux, et il est rassurant** — la pire combinaison possible pour un lecteur qui
cherche à comprendre pourquoi son e-mail ne ressemble pas à son aperçu.

---

## MULTI-PROJECT ISOLATION

| Dimension | Isolée ? | Mécanisme | Solidité |
|---|---|---|---|
| Identité de l'appelant | **oui** | `bridgeToken` → `context.projectId`, `assertProjectScope` | **forte** |
| Autorisation | **oui** | `capabilityGrants[]` par fiche | forte |
| Coffre / identifiants | **oui** | jamais diffusés, résolus par contexte | forte |
| `Reply-To` | **oui** | `PanelProjectSenderIdentity(projectId, env)`, aucun repli | forte |
| Journal d'opérations | **oui** | `unique(projectId, capability, operationId)` | forte |
| **Contenu du template** | **NON** | — | **inexistante** |
| **Variables** | **NON** | registre global par code | **inexistante** |
| **`From`** | **NON** | global unique, par conception | assumée |

L'isolation **du transport** est de bonne facture. L'isolation **du contenu** est
nulle — non pas franchie, mais absente : il n'y a rien à franchir puisqu'il n'y
a qu'un seul document par code pour tout le parc.

**Un projet A ne peut pas lire ni modifier le template d'un projet B** — mais
uniquement parce qu'aucun projet ne peut lire ni modifier de template du tout via
le pont. La capacité `email.send_template` est la seule surface ; elle ne permet
que d'envoyer. Il n'existe pas de capacité `email.template.write`. **L'absence de
brèche est donc un effet de l'absence de fonctionnalité, pas d'une garde.**

---

## PROJECT TERMINATION

**Aucun mécanisme de résiliation ne touche aux e-mails, ni au contenu, ni à
l'envoi.**

### Ce qui existe

`POST /:projectId/contract/cancel`
([contrôleur L233](../../backend/src/controllers/projects.controller.js#L233)) crée
une `PanelContractAction` et **demande au projet** d'appliquer la résiliation. Le
commentaire est explicite : « Le Panel ne touche pas à sa projection : la
nouvelle vérité lui reviendra par la synchronisation. »

### Ce qui est vérifié à chaque envoi

La séquence de la passerelle
([capabilityGateway.service.js:100-200](../../backend/src/services/capabilities/capabilityGateway.service.js#L100)) :

```text
1. authentification du pont       → pairing.status doit être PAIRED
2. contexte / portée              → assertProjectScope
3. octroi                         → capabilityGrants.includes('email.send_template')
4. ouverture commerciale          → canExecute()
5. capacité servie                → definition.migrated
6. schéma d'entrée                → parseInput()
7. identifiants                   → coffre
```

**Aucune de ces sept étapes ne consulte l'état contractuel du projet.**

Et l'étape 4 ne bloque pas non plus :
`'email.send_template': EFFECT.COMMUNICATION_WRITE`
([commercialReadiness.js:222](../../backend/src/services/integratedApi/commercialReadiness.js#L222)),
or `FORBIDDEN_IN_PREOPENING = [FINANCIAL_WRITE, LEGAL_WRITE]` (L133-L136). La
communication **n'est bloquée dans aucun état commercial**.

### Réponses aux questions du §14

| Question | Réponse factuelle |
|---|---|
| Templates projet supprimés / archivés / conservés ? | **Sans objet — il n'en existe pas.** |
| Un projet résilié peut-il encore appeler `sendTemplate()` ? | **OUI**, tant que `pairing.status === 'PAIRED'` et que l'octroi est présent. Les deux se retirent **à la main**. |
| Historique conservé ? | `EmailDelivery` (projet) et `PanelCapabilityOperation` (Panel) restent. Aucune purge, aucune politique de rétention n'est câblée sur la résiliation. |
| Réactivation après 6 mois ? | Le projet retrouve **le template plateforme du moment** — pas « ses » anciens templates : il n'en a jamais eu. Le contenu aura pu changer entre-temps sans qu'il en soit informé. |

Une `retentionClass` (`OPERATIONAL` / `TRANSIENT`) est bien déclarée par template
au registre, mais **aucun code ne la lit** pour purger quoi que ce soit : elle
n'est aujourd'hui qu'une étiquette descriptive.

---

## PROJECT DELETION

`removeProject()`
([projectRegistry.service.js:389](../../backend/src/services/registry/projectRegistry.service.js#L389)) :

```js
export async function removeProject(projectId) {
  const record = await getProjectOrThrow(projectId);
  if (record.pairing.status === 'PAIRED') {
    throw ApiError.conflict('PANEL_PROJECT_STILL_PAIRED', '…révoquez l’appairage avant…');
  }
  await registryStore.remove(projectId);   // ← PanelProject.deleteOne({ projectId })
  return { removed: true };
}
```

**Une seule collection est touchée : `PanelProject`.** Aucune cascade.

Statuts distingués : `DECLARED | PAIRED | REVOKED` (appairage) et
`PREOPENING | LIVE` (commerce). **`SUSPENDED`, `TERMINATED`, `ARCHIVED`,
`DELETED` n'existent pas** comme états de projet.

### Risques du §15 — évalués

| Risque envisagé | Réel ? | Détail |
|---|---|---|
| Supprimer un projet supprime un template plateforme | **NON** | aucune cascade ; les lignes `projectId:null` sont hors d'atteinte |
| Supprimer un projet laisse un template orphelin | **pas aujourd'hui** | aucun template scopé n'existe. **Deviendra vrai le jour même où la portée projet sera activée**, puisque la suppression ne cascade pas |
| Autres orphelins | **OUI, déjà** | `PanelProjectSenderIdentity`, `PanelCapabilityOperation`, `PanelProjectSenderIdentity` survivent à la suppression de la fiche |

**Les templates Panel survivent-ils à tout ? Oui, sans réserve.** Ils ne portent
aucune référence à un projet, ils sont réamorcés au démarrage
([server.js:196](../../backend/src/server.js#L196)) et le seed est explicitement
non destructif (« un contenu déjà écrit n'est jamais réécrit »,
[service L64-L68](../../backend/src/services/email/panelEmailTemplate.service.js#L64)).

---

## PROJECT REACTIVATION

Aucun mécanisme dédié. Réappairer un projet lui rend l'accès à la capacité (si
l'octroi est reposé), et il consommera **le template plateforme dans son état du
jour**. Il n'y a ni gel, ni archivage, ni restauration d'un contenu qui lui
serait propre — faute d'un tel contenu.

---

## PROJECT DUPLICATION

Le moteur de duplication (`backend/src/duplication-engine/`, 4 fichiers) **ne
mentionne les templates e-mail nulle part**. Recherche exhaustive : une seule
occurrence du mot « template », et elle désigne le dépôt Git source
([duplication.js:114](../../backend/src/duplication-engine/duplication.js#L114)).

Réponses au §17 :

| Question | Réponse |
|---|---|
| Templates clonés ? | non |
| Codes seulement ? | oui, par le registre code-first partagé |
| HTML cloné ? | non — hérité du défaut plateforme, par repli |
| Historique cloné ? | non |
| IDs régénérés ? | sans objet |
| Branding remplacé ? | non — le HTML est le même document |
| Variables conservées ? | oui, elles sont globales |

**L'interdit du §17 est-il violé ?**

> « Interdit : Project B pointe vers les mêmes documents templates Mongo que
> Project A »

**Techniquement oui, et pour tous les projets à la fois** : A, B et tous les
suivants lisent le **même document Mongo**. Ce n'est pas un défaut de la
duplication — c'est la conséquence de l'absence de portée. La duplication est
d'ailleurs le scénario qui rendra le problème visible le plus vite : deux
garages issus de la même recette enverront le mot de passe oublié avec le même
texte, et le second client remarquera.

---

## FALLBACKS

| # | Repli | Fichier:ligne | Déclenchement | Classement |
|---|---|---|---|---|
| 1 | **projet absent → plateforme** | `panelEmailTemplate.service.js:128` | **systématique** | **DANGEROUS** |
| 2 | base vide → défaut du registre | `panelEmailTemplate.service.js:151` | premier démarrage | **SAFE** |
| 3 | `Reply-To` absent → aucun | `panelSenderIdentity.service.js:105` | projet sans adresse | **SAFE** |
| 4 | `From` absent → **refus** | `brevoSendAdapter.js:139` | config globale manquante | **SAFE** (fail-closed exemplaire) |
| 5 | template local SB Auto absent → envoi quand même | `emailDelivery.service.js:257` | projet sans copie | **QUESTIONABLE** |
| 6 | `commercialState` inconnu → `PREOPENING` | `commercialReadiness.js:290` | fiche jamais décidée | **SAFE** (fail-closed) |
| 7 | capacité hors table → refus | `commercialReadiness.js:305` | oubli de déclaration | **SAFE** (fail-closed) |

### Repli n°1 — analyse

`const stored = own ?? platform;`

C'est très exactement le comportement que le §8 du cahier des charges décrit
comme « extrêmement dangereux » :

> « template projet absent → template Panel portant le même code […] peut
> provoquer : mail SB Auto → branding L.Y Solution »

**Et ce n'est pas une hypothèse : c'est l'état permanent du système**, puisque le
membre gauche du `??` est structurellement toujours `null`.

Nuance importante à porter au dossier : **ce repli est documenté et assumé**, pas
accidentel. Le modèle le décrit comme un héritage voulu (« `projectId: null`
porte le défaut, dont chaque projet hérite tant qu'il n'a rien réécrit »,
[modèle L16-L22](../../backend/src/models/PanelEmailTemplate.model.js#L16)). Le
défaut n'est donc pas d'avoir conçu un héritage — c'est d'avoir livré
**l'héritage sans jamais livrer la surface permettant de le rompre**. Un héritage
qu'aucune interface ne permet de surcharger n'est pas un héritage : c'est une
valeur unique.

**Repli n°5** est plus subtil et mérite attention : côté SB Auto, `if (template)`
saute la validation locale des variables quand la copie locale manque. L'envoi
part alors sans filet local et sera refusé par le Panel — refus correct, mais
diagnostic dégradé et à distance.

---

## INCONSISTENCIES

| # | Incohérence | Impact réel | Preuve | Prio |
|---|---|---|---|---|
| 1 | **Aucun contenu de portée projet n'est atteignable** ; le repli plateforme est permanent | Tous les clients du parc reçoivent le même HTML. Éditer un modèle réécrit l'e-mail de tout le monde | `panelEmailTemplate.service.js:124-128` + absence d'écrivain | **P0** |
| 2 | **L'éditeur SB Auto écrit ce qui ne part jamais** ; aperçu ≠ test ≠ envoi | Un DEV croit avoir modifié l'e-mail client. Il ne l'a pas fait. Aucun message ne le lui dit | `emailTemplate.controller.js:94` vs `emailDelivery.service.js:332` | **P0** |
| 3 | **Variables globales par code** | Deux projets ne peuvent pas diverger, même après ajout d'une portée sur le contenu | `panelEmailTemplateRegistry.js:829` | **P0** |
| 4 | Commentaire « MÊME PIPELINE » devenu faux et rassurant | Induit activement en erreur le lecteur qui enquête | `emailTemplate.controller.js:148-150` | **P0** |
| 5 | **`projectId` injectable via le corps du `PUT`**, sans validateur | Crée un template invisible de l'IHM, non restaurable, mais servi en production | `emailTemplates.controller.js:30` → `panelEmailTemplate.service.js:232` | **P1** |
| 6 | **Résiliation ne bloque aucun envoi** | Un client résilié continue d'envoyer sous l'identité et la clé de la plateforme | passerelle L100-L200, aucune lecture d'état contractuel | **P1** |
| 7 | Le journal Panel n'enregistre ni version, ni portée, ni source du modèle rendu | Impossible de dire *a posteriori* quel document est parti | `capabilityGateway.service.js:426` (`templateCode` seul) | **P1** |
| 8 | `EmailDelivery.templateVersion` (SB Auto) enregistre la version **locale** | Le suivi projet affiche un numéro de version qui n'a jamais été expédié | `emailDelivery.service.js:287,307` | **P1** |
| 9 | Deux registres dupliqués, aucun test de parité | Une variable ajoutée d'un seul côté casse la production sans avertissement | `panelEmailTemplateRegistry.js` vs `utils/emailTemplateRegistry.js` | **P1** |
| 10 | `restoreEditableTemplateVersion` passe `{}` en dur | Une portée projet, une fois créée, est irrestaurable depuis l'IHM | `panelEmailTemplateEditor.service.js:337` | **P2** |
| 11 | Suppression de projet sans cascade | Identités d'expéditeur et opérations orphelines. Deviendra critique avec des templates scopés | `projectRegistry.service.js:389` | **P2** |
| 12 | Aucune notion de partage **intentionnel** | `PAYMENT_REQUEST_CREATED` (vraiment plateforme) et `PASSWORD_RESET_REQUEST` (plateforme par défaut) sont indiscernables | modèle : `projectId` binaire | **P2** |
| 13 | `retentionClass` déclarée, jamais lue | Politique de rétention affichée mais inexistante | registre, aucun lecteur | **P3** |
| 14 | `From` unique pour tout le parc | Un e-mail client part sous l'identité L.Y Solution | `panelSenderIdentity.service.js:68` | **P3** (assumé) |
| 15 | Pile template SB Auto entièrement morte à l'envoi | ~1 500 lignes entretenues et testées sans effet en production | 7 fichiers + écran + tests | **P3** |

---

## SECURITY / TENANT ISOLATION

| Opération | Un projet A peut-il atteindre B ? | Garde |
|---|---|---|
| **Lecture** d'un template | **non** | aucune capacité de lecture n'existe sur le pont |
| **Modification** | **non** | aucune capacité d'écriture n'existe sur le pont |
| **Aperçu** | **non** | non exposé au pont |
| **Test-send** | **non** | `context.projectId` prouvé par le jeton |
| **Historique** | **non** | non exposé au pont |
| **Restauration** | **non** | non exposé au pont |
| **`Reply-To` d'un autre** | **non** | `assertProjectScope`, refus explicite → `SENDER_IDENTITY_SCOPE_VIOLATION` |
| **Usurper un `projectId`** | **non** | contexte bâti sur le jeton ; la charge utile n'est pas lue |

**L'isolation multi-tenant est correcte** — mais, comme dit plus haut, parce que
la surface est réduite à un unique verbe d'envoi. La question redeviendra ouverte
au moment d'exposer l'édition scopée.

Un point de vigilance pour la cible : `PUT /email-templates/:code` est protégée
par `requirePanelDev`. Le jour où elle acceptera un `scopeId`, **elle devra le
valider contre le registre des projets** et non le croire — l'incohérence n°5
montre que le réflexe « le corps n'est pas une autorité » n'est pas encore câblé
sur cette route.

---

## SCALABILITY TO MANY PROJECTS

| Dimension | 1 projet | 10 | 100 | 1000 |
|---|---|---|---|---|
| Transport / coffre / octrois | ✓ | ✓ | ✓ | ✓ |
| Journal d'opérations (indexé par projet) | ✓ | ✓ | ✓ | ✓ |
| Identités d'expéditeur | ✓ | ✓ | ✓ | ✓ |
| **Contenu différencié** | ✗ | ✗ | ✗ | ✗ |
| **Collision de codes** | s.o. | **garantie** | garantie | garantie |
| **Éditeur lisible** | ✓ | ✓ (11 lignes) | ✗ (aucun filtre) | ✗ |
| **Templates orphelins** | ✓ | ✓ | ✗ (pas de cascade) | ✗ |

La **collision de codes du §5 n'est pas un risque futur : c'est le mode de
fonctionnement actuel.** Trois projets qui demandent `PASSWORD_RESET_REQUEST`
obtiennent le même document — non pas parce que l'index les y force (il ne le
ferait pas : `unique(templateCode, projectId)` autorise parfaitement trois
lignes), mais parce que **rien ne peut créer les deux autres lignes**.

Bonne nouvelle pour la migration : **l'index n'a pas à changer.** Il est déjà
conforme à la forme cible `unique(scope, ownerId, code)`, à un renommage près.

---

## TARGET ARCHITECTURE

### Schéma ACTUEL — qui possède quoi

```text
┌──────────────────────────────── SB AUTO 06 (projet) ────────────────────────────────┐
│                                                                                     │
│  ÉVÉNEMENT MÉTIER ──▶ destinataires ✓ PROJET ──▶ valeurs de variables ✓ PROJET      │
│                                                                                     │
│  ┌───────────────────────────────────────────────────────────┐                      │
│  │  EmailTemplate + EmailTemplateVersion  (base SB Auto)     │                      │
│  │  éditeur DEV · aperçu · historique · restauration         │   ✗ JAMAIS EXPÉDIÉ   │
│  │  HTML ────────────────────────────────────────────────────┼──▶ (jeté)            │
│  └───────────────────────────────────────────────────────────┘                      │
│                                                                                     │
│  EmailDelivery (journal local) ✓ PROJET  — mais templateVersion = version LOCALE ✗   │
└───────────────────────────────────────┬─────────────────────────────────────────────┘
                                        │  invoke('email.send_template')
                                        │  { templateRef, recipient, variables, operationId }
                                        │  ⚠ aucun scope sur le fil — un CODE NU
                                        ▼
┌──────────────────────────────────── PANEL ──────────────────────────────────────────┐
│  jeton de pont ──▶ context.projectId  (prouvé, jamais lu de la charge utile)  ✓      │
│  octroi ✓ · ouverture ✓ · coffre ✓                                                  │
│                                                                                     │
│  ┌─────────────────────── resolveTemplate(code, projectId) ────────────────────────┐│
│  │   own      = findOne({ code, projectId })   ──▶  TOUJOURS null                  ││
│  │                                                  (aucun écrivain n'existe)      ││
│  │   platform = findOne({ code, projectId:null })──▶  TOUJOURS SERVI  ★            ││
│  └─────────────────────────────────────────────────────────────────────────────────┘│
│                                                                                     │
│  QUI POSSÈDE LE HTML ?         ★ PANEL, une seule ligne pour tout le parc            │
│  QUI POSSÈDE LES VARIABLES ?   ★ PANEL, registre code-first GLOBAL                   │
│  QUI REND ?                    ★ PANEL, panelEmailTemplateRenderer                   │
│  QUI CHOISIT L'EXPÉDITEUR ?    ★ PANEL, From global unique  (Reply-To : projet)      │
│  QUI ENVOIE ?                  ★ PANEL, brevoTransport + clé du coffre               │
│  QUI STOCKE L'HISTORIQUE ?     ★ PANEL (contenu) · projet (livraisons)               │
│                                                                                     │
│  ÉDITEUR PANEL ──▶ toujours (code, projectId:null). Aucun sélecteur de projet.       │
└─────────────────────────────────────────┬───────────────────────────────────────────┘
                                          ▼
                                        BREVO   (subject + htmlContent, jamais un templateId Brevo ✓)
```

### Schéma CIBLE

```text
┌───────────────────────────────── PROJETS (N) ───────────────────────────────────────┐
│  SB Auto ─┐    Projet B ─┐    Projet C ─┐                                            │
│           │              │              │   événement · destinataires · VALEURS      │
└───────────┼──────────────┼──────────────┼────────────────────────────────────────────┘
            │              │              │
            └──────────────┴──────────────┴──▶  projectEmail.sendTemplate({
                                                  templateCode, recipient, variables })
                                                scope + scopeId INJECTÉS par l'appairage,
                                                jamais fournis par l'appelant
                                                          │
┌─────────────────────────────────────────────────────────▼───────────────────────────┐
│                          PANEL — EMAIL CONTROL PLANE                                 │
│                                                                                      │
│   ┌──────────────────┐   ┌──────────────────┐   ┌──────────────────────────────┐     │
│   │  scope = PANEL   │   │ scope = PROJECT  │   │  scope = SHARED              │     │
│   │  scopeId = null  │   │ scopeId = projet │   │  scopeId = null              │     │
│   │                  │   │                  │   │  partage DÉCLARÉ, pas subi   │     │
│   │ PAYMENT_REQUEST_*│   │ PASSWORD_RESET_* │   │ EMAIL_SENDER_VERIF_TEST      │     │
│   │ SITE_SUSPENDED_* │   │ CONTACT_ADMIN_*  │   │                              │     │
│   │ PANEL_SENDER_TEST│   │ BOOKING_CONFIRM  │   │                              │     │
│   └────────┬─────────┘   └────────┬─────────┘   └───────────┬──────────────────┘     │
│            └──────────────────────┴─────────────────────────┘                        │
│                                   ▼                                                  │
│                    TEMPLATE RESOLVER   —   DÉTERMINISTE                              │
│                    PANEL   : (PANEL,  null,    code)   sinon ÉCHEC                   │
│                    PROJECT : (PROJECT, projet, code)   sinon ÉCHEC  ◀── FAIL-CLOSED   │
│                    SHARED  : (SHARED, null,    code)   sinon ÉCHEC                   │
│                    ✗ AUCUN repli PROJECT → PANEL, jamais, sous aucune condition       │
│                                   ▼                                                  │
│                    VARIABLE VALIDATOR   (contrat de variables résolu AVEC la portée)  │
│                                   ▼                                                  │
│                    RENDERER                                                          │
│                                   ▼                                                  │
│                    SENDER RESOLVER                                                   │
│                    From : identité du PROJET si déclarée, sinon plateforme (explicite)│
│                    Reply-To : projet                                                  │
│                                   ▼                                                  │
│                    INTEGRATED API ──▶ BREVO                                          │
│                                                                                      │
│   ÉDITEUR PANEL (DEV)     ──▶ tous les scopes, avec sélecteur de projet + badges      │
│   ÉDITEUR MANAGER (projet)──▶ scope PROJECT de SON projet UNIQUEMENT (proxy vers      │
│                               l'API scopée du Panel — plus AUCUNE persistance locale) │
│   OBSERVABILITÉ           ──▶ chaque envoi journalise : code · scope · scopeId ·       │
│                               templateVersion · sender · provider · operationId       │
└──────────────────────────────────────────────────────────────────────────────────────┘
```

Les trois projets peuvent alors porter `PASSWORD_RESET_REQUEST` avec **trois HTML
entièrement différents**, et l'absence d'un template `PROJECT` est une **erreur
bruyante**, jamais un e-mail plateforme envoyé sous le nom d'un client.

### Doctrine d'éditeur recommandée

La préférence exprimée au §23 est la bonne, et je la confirme :

```text
Panel DEV        → administre TOUS les scopes (dépannage du parc)
Manager projet   → administre UNIQUEMENT scope=PROJECT, scopeId=le sien
Runtime          → une seule source de vérité, scopée
```

Corollaire non négociable : **le manager projet ne doit plus rien persister
localement.** L'éditeur SB Auto doit devenir un **proxy** vers l'API scopée du
Panel. Conserver deux persistances, c'est reproduire exactement l'incohérence
n°2 sous un autre nom.

---

## MIGRATION PLAN

**Aucune étape de ce plan n'est appliquée. Il est soumis au débat.**

### Étape 0 — correctif isolé, avant tout débat (P1, ~10 lignes)

Fermer l'injection de `projectId` par le corps du `PUT` (incohérence n°5) :
valider explicitement le corps et rejeter tout champ non prévu. C'est une
correction locale, sans effet sur l'architecture, qui empêche de créer d'ici la
refonte des lignes fantômes qu'il faudra ensuite retrouver.

### Étape 1 — classer, à partir des USAGES (jamais des noms)

Le §26 l'exige et c'est indispensable : la classification se fait par
**appelant réel**, déjà établi dans *TEMPLATE INVENTORY*.

```text
appelé UNIQUEMENT par du code Panel          → PANEL   (5 codes)
appelé par au moins un projet                → PROJECT (4 codes)
technique, sans destinataire client          → SHARED  (2 codes, à valider)
```

Les quatre `AMBIGUOUS` sont ceux qui portent la valeur du lot.

### Étape 2 — trancher le contrat de variables

**Décision structurante, à prendre avant d'écrire une ligne.** Deux options :

| Option | Description | Coût | Conséquence |
|---|---|---|---|
| **A — contrat plateforme, texte projet** | le code fixe les variables ; chaque projet réécrit sujet/HTML | faible | Project B ne peut pas avoir `supportPhone`. Le §10 n'est pas satisfait |
| **B — contrat scopé** | `variablesSchema` persisté par `(scope, scopeId, code)` | élevé | §10 satisfait ; le validateur, le renderer et les résolveurs de valeurs côté projet doivent suivre |

Recommandation : **A d'abord, B ensuite si le besoin se confirme.** A débloque
90 % de la valeur (chaque client son branding et son ton) pour une fraction du
coût, et n'interdit pas B. B sans A n'aurait aucun intérêt.

### Étape 3 — schéma

```text
PanelEmailTemplate :
  + scopeType : 'PANEL' | 'PROJECT' | 'SHARED'   (requis)
  ~ projectId → scopeId                          (null pour PANEL et SHARED)
  index : unique(scopeType, scopeId, templateCode)   ← l'index actuel est déjà de cette forme
```

Backfill : toutes les lignes existantes ont `projectId: null` → `scopeType`
attribué **par la classification de l'étape 1**, code par code, jamais par
motif de nom.

### Étape 4 — résolveur fail-closed

Supprimer `own ?? platform`. Trois résolutions strictes, une par scope, chacune
échouant explicitement si le document manque. **C'est le changement de
comportement le plus visible du lot** : des envois qui « marchaient » vont
échouer — ce qui est le but, puisqu'ils envoyaient le mauvais document.

Séquencement : livrer l'étape 5 (éditeur scopé) **avant** l'étape 4, pour que
les templates PROJECT existent quand le repli disparaît.

### Étape 5 — API et éditeur scopés

`GET|PUT /email-templates/:scope/:scopeId?/:code`, `scopeId` **validé contre le
registre des projets côté serveur**. Sélecteur de projet et badges de portée
dans `EmailTemplatesPage.tsx`.

### Étape 6 — retirer la pile locale SB Auto

Éditeur → proxy. `EmailTemplate` / `EmailTemplateVersion` locaux :
supprimer **après** migration du contenu qui mérite d'être repris comme base des
templates `PROJECT/SB_AUTO`. C'est le seul endroit où le HTML « propre » de
SB Auto existe encore — **à ne pas perdre**.

### Étape 7 — cycle de vie

Introduire un état de projet lisible par la passerelle
(`ACTIVE | SUSPENDED | TERMINATED | ARCHIVED`), et une politique explicite :

```text
ACTIVE      → templates actifs, envoi permis
SUSPENDED   → templates conservés et éditables, envoi BLOQUÉ
TERMINATED  → templates archivés, envoi bloqué, édition bloquée
ARCHIVED    → lecture seule, conservé selon rétention
DELETED     → purge cascadée, selon la politique de rétention seulement
```

Et une cascade de suppression : templates scopés, identités d'expéditeur,
opérations.

### Étape 8 — observabilité

Journaliser `scope`, `scopeId`, `templateVersion` et `source` sur
`PanelCapabilityOperation`, et faire remonter la **version réellement rendue**
au projet pour son `EmailDelivery`.

---

## TEST PLAN

Aucun de ces tests n'existe aujourd'hui. Les cinq premiers **échoueraient** sur
le code actuel — c'est précisément ce qui en fait la spécification du lot.

| # | Test | Aujourd'hui |
|---|---|---|
| 1 | `PANEL/X` rend le template PANEL | ✓ passe |
| 2 | `PROJECT/A/X` rend le template de A | ✗ **échoue** (rend la plateforme) |
| 3 | `PROJECT/B/X` rend le template de B | ✗ **échoue** |
| 4 | même code, 3 scopes, 3 HTML distincts | ✗ **échoue** |
| 5 | template `PROJECT` absent ⇒ **erreur**, jamais un repli PANEL | ✗ **échoue** (repli silencieux) |
| 6 | A ne peut pas lire les templates de B | ✓ passe (aucune surface) |
| 7 | A ne peut pas éditer B | ✓ passe |
| 8 | A ne peut pas éditer un template PANEL | ✓ passe |
| 9 | le `scopeId` du corps est **ignoré/rejeté**, jamais honoré | ✗ **échoue** (incohérence n°5) |
| 10 | projet `TERMINATED` ⇒ envoi refusé | ✗ **échoue** (aucun état) |
| 11 | projet `TERMINATED` ⇒ les envois PANEL continuent | ✓ passe |
| 12 | réactivation ⇒ templates retrouvés selon politique | s.o. |
| 13 | duplication ⇒ templates **isolés** (documents distincts) | ✗ **échoue** |
| 14 | aperçu = même résolveur, même version que l'envoi | ✓ Panel / ✗ **SB Auto** |
| 15 | test-send = même résolveur que l'envoi réel | ✓ Panel / ✗ **SB Auto** |
| 16 | restauration ne peut pas restaurer hors de sa portée | ✗ **non couvert** |
| 17 | **parité des deux registres** (tant qu'ils coexistent) | ✗ **absent** |
| 18 | suppression de projet ⇒ aucun template PANEL touché | ✓ passe |
| 19 | suppression de projet ⇒ aucun orphelin scopé | ✗ **échoue** (aucune cascade) |

Le test n°17 est le seul que je recommanderais d'ajouter **immédiatement**, avant
toute refonte : il est trivial à écrire, il ne change aucun comportement, et il
protège la production d'une dérive silencieuse en attendant le lot.

---

## OPEN QUESTIONS

1. **Contrat de variables : option A ou B ?** (cf. étape 2). C'est l'arbitrage
   qui décide de la taille du lot. Ma recommandation : A.
2. **`From` par projet ?** R10.4 a délibérément unifié le `From` sur tout le
   parc. Un e-mail client sous l'identité du client demande de revenir sur cette
   décision — avec les conséquences Brevo qui vont avec (vérification d'expéditeur
   par domaine, SPF/DKIM par client). Est-ce dans le périmètre ?
3. **`SHARED` : nécessaire, ou complexité gratuite ?** Deux candidats seulement
   (`EMAIL_SENDER_VERIFICATION_TEST`, `CONTRACT_CANCELLATION_DEV_NOTIFICATION`).
   On pourrait les classer `PANEL` et s'en tenir à deux scopes. Le §9 invite
   justement à ne pas complexifier sans cas réel.
4. **Que devient le HTML local de SB Auto ?** C'est aujourd'hui le seul contenu
   « propre au projet » qui existe. Il doit devenir la base des templates
   `PROJECT/SB_AUTO` — ou être abandonné, mais ce doit être une décision.
5. **Qui peut créer un code `PROJECT` ?** Le registre est code-first : un projet
   ne peut pas inventer `BOOKING_CONFIRMATION`. Un projet doit-il pouvoir déclarer
   ses propres codes (registre par projet), ou tous les codes restent-ils déclarés
   côté Panel ?
6. **Le repli fail-closed casse-t-il des envois en production ?** Oui, par
   construction, si l'étape 5 ne précède pas l'étape 4. Le séquencement proposé
   l'évite, mais il faut le valider.
7. **Rétention.** `retentionClass` est déclarée et jamais lue. Politique réelle
   à définir en même temps que le cycle de vie.

---

## FINAL VERDICT

### Les dix questions, tranchées par le code

| # | Question | Réponse | Preuve |
|---|---|---|---|
| 1 | Avons-nous de vrais templates Panel séparés des templates projets ? | **NON.** Un seul catalogue, une seule portée effective. 5 codes sur 11 sont légitimement PANEL ; les 6 autres sont plateforme faute de mieux | absence totale d'écrivain avec `projectId ≠ null` |
| 2 | Un projet peut-il avoir le même code qu'un autre avec un HTML différent ? | **NON.** Le schéma le permettrait (`unique(templateCode, projectId)`), le code ne le peut pas | `panelEmailTemplate.service.js:266,317` |
| 3 | Le HTML d'un mail SB Auto appartient-il à SB Auto ou au Panel ? | **AU PANEL.** Celui de SB Auto existe, est édité, versionné — et jeté | `emailDelivery.service.js:234-267` |
| 4 | Quel composant choisit le template ? | `resolveTemplate()` — `panelEmailTemplate.service.js:121`, clé `(code, projectId du jeton)` | — |
| 5 | Quel composant effectue le rendu ? | `renderTemplate()` — `panelEmailTemplateRenderer.js`, **Panel** | — |
| 6 | Quel composant effectue l'envoi Brevo ? | `sendTransactionalEmail()` — `brevoTransport.js`, **Panel**, clé du coffre. Aucun projet ne parle à Brevo | — |
| 7 | Un projet peut-il accidentellement consommer un template Panel ? | **Il ne le peut pas accidentellement : il le fait TOUJOURS.** C'est le seul chemin | `const stored = own ?? platform` |
| 8 | Que deviennent ses templates à la résiliation ? | **Rien.** Il n'en a pas. Et il continue d'envoyer : aucune étape de la passerelle ne lit l'état contractuel | passerelle L100-L200 |
| 9 | Les templates Panel survivent-ils indépendamment de tout projet ? | **OUI, sans réserve.** Aucune référence à un projet, réamorçage non destructif au démarrage | `server.js:196`, service L64-L68 |
| 10 | Prêt pour des dizaines/centaines de projets ? | **Transport : OUI.** Contenu : **NON** — et pas « pas encore » : la seule chose qui différencie deux projets est la valeur d'une variable | *SCALABILITY* |

### En une phrase

> Le Panel a réussi la **centralisation du transport** — jeton prouvé, coffre
> jamais diffusé, portée d'expéditeur gardée, idempotence, journal par projet.
> Il a, **par le même mouvement et sans que ce soit décidé, centralisé le
> contenu** : la portée par projet a été modélisée mais jamais câblée, et le
> repli conçu comme un héritage est devenu la valeur unique du parc. La
> distinction du §« DISTINCTION FONDAMENTALE » n'a pas été franchie de force —
> elle n'a jamais été construite.

**Aucune correction n'a été appliquée. Le débat sur l'architecture cible peut
s'ouvrir sur ces faits.**

---

## SUITE DONNÉE — LOT L11.1

Le débat a eu lieu, les décisions sont figées, et le lot a été implémenté.

Les dix questions ci-dessus se répondent désormais autrement :

| # | réponse au moment de l'audit | réponse aujourd'hui |
|---|---|---|
| 1 | NON — un seul catalogue, une seule portée effective | **OUI** — 7 codes PANEL, 5 codes PROJECT, dont 1 dans les deux portées |
| 2 | NON — le code ne le pouvait pas | **OUI** — prouvé sur trois portées, trois documents Mongo distincts |
| 3 | au PANEL | **au projet**, pour les codes qui lui appartiennent |
| 4 | `resolveTemplate(code, projectId du jeton)` | `resolveTemplate(code, scope)` — scope déduit du jeton, **fail-closed** |
| 5 | inchangé — le Panel rend | inchangé |
| 6 | inchangé — le Panel envoie, clé du coffre | inchangé |
| 7 | il le fait TOUJOURS — `own ?? platform` | **il ne le peut plus** — le repli est supprimé, l'absence est un refus |
| 8 | rien — il n'en a pas, et il continue d'envoyer | **conservés**, envoi bloqué par la révocation d'appairage |
| 9 | OUI, sans réserve | inchangé — et désormais vérifié par recette |
| 10 | transport OUI, contenu NON | **contenu OUI** — sous réserve d'avoir joué la migration |

Détail, écarts assumés et risques restants :
[`EMAIL_TEMPLATE_MULTI_PROJECT_IMPLEMENTATION_REPORT.md`](./EMAIL_TEMPLATE_MULTI_PROJECT_IMPLEMENTATION_REPORT.md).
