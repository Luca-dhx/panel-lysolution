# Brevo — plan de contrôle

> **Lot L8 — audit et fondations.** Document dédié, volontairement séparé de
> `ARCHITECTURE_CONTEXT.md` et de `INTEGRATED_API_CONTROL_PLANE_ROADMAP.md` :
> deux autres chantiers écrivaient dans ces fichiers pendant la rédaction.
>
> **État : fondations posées, aucun runtime migré.** Aucune capacité n'est
> invocable, aucun credential projet n'est supprimé, aucun webhook n'est créé.

---

## 0. L'invariant

Cinq objets sont régulièrement confondus, et chaque confusion produit une classe
d'incident différente. Ils sont distincts, et ce document existe surtout pour
qu'ils le restent.

```
CREDENTIAL BREVO      « avec quel compte parle-t-on ? »
                      un par ENVIRONNEMENT · chiffré · Panel · invisible du projet
        ≠
IDENTITÉ EXPÉDITRICE  « au nom de qui écrit-on ? »
                      une par PROJET · aucun secret · lisible · métier
        ≠
MODÈLE                « que dit le message ? »
                      versionné · autorité Panel · jamais chez Brevo
        ≠
COMMUNICATION         « qu'a-t-on envoyé, à qui, et l'a-t-il lu ? »
                      historique MÉTIER · reste chez le projet
        ≠
ÉVÉNEMENT WEBHOOK     « qu'en dit le fournisseur ? »
                      fait technique · authentifié, jamais prouvé
```

Centraliser la clé n'oblige à rien uniformiser d'autre. Un compte Brevo unique
peut porter dix identités expéditrices : chaque garage écrit sous son nom. Le
jour où l'on écrira « credential centralisé donc expéditeur global », tous les
e-mails de tous les projets partiront de la même adresse — techniquement propre,
commercialement absurde.

---

## 1. Ce que Brevo fait réellement dans le parc

Recherche exhaustive sur les deux dépôts (`brevo`, `sendinblue`, `email`,
`mailer`, `transactional`, `template`, `sender`, `replyTo`, `sms`, `whatsapp`,
`contact`, `list`, `campaign`, `webhook`, `inbound`, `messageId`) — 81 fichiers
touchés côté SB Auto, 13 côté Panel.

**Trois endpoints Brevo sont appelés, et seulement trois :**

| Endpoint | Appelant | Rôle |
|---|---|---|
| `POST /v3/smtp/email` | `services/brevo/brevoEmail.service.js` | Le seul envoi. |
| `GET /v3/account` | `providerConnectionTest.service.js` · Panel `providerValidation.js` | Prouver la clé, sans rien créer. |
| `GET/POST/PUT/DELETE /v3/webhooks` | `services/brevo/brevoWebhookConfig.service.js` | Suivi de livraison. |

**Ce qui n'existe nulle part :** aucun SMS, aucun WhatsApp, aucune liste de
contacts, aucune campagne marketing, aucun `templateId` Brevo, aucun webhook
`inbound`, aucune pièce jointe sur le chemin e-mail. Les deux seules mentions de
« whatsapp » du parc sont un libellé de coordonnées de garage
(`utils/constants.js`), sans rapport avec Brevo.

> **Conséquence directe :** le catalogue de capacités ne déclare que deux
> intentions. Déclarer `sms.send` ferait apparaître à l'écran une capacité sans
> driver, sans test et sans usage.

### 1.1 Le graphe d'appel complet

```
auth.service.js  (mot de passe oublié)
    └─▶ sendTemplate(PASSWORD_RESET_REQUEST)          direct, hors dispatcher

contact.submitted  (événement métier)                 ACTIVÉ
    └─▶ dispatcher → SEND_EMAIL
          └─▶ sendEmailHandler → sendTemplate(CONTACT_ADMIN_NOTIFICATION)
                                  reply-to = le visiteur

contract.cancel_at_period_end                         DÉSACTIVÉ (enabled: false)
    ├─▶ CONTRACT_CANCELLATION_ADMIN_CONFIRMATION
    └─▶ CONTRACT_CANCELLATION_DEV_NOTIFICATION

emailTemplate.controller.js  (aperçu DEV)
    └─▶ sendTemplate(<au choix>, EXPLICIT_TEST_RECIPIENT)

emailConfiguration.service.js  (« Envoyer un test »)
    └─▶ sendTransactionalEmail  ← contenu ad hoc, PAS un modèle

                    tous convergent vers
                    ▼
    brevoEmail.service.sendTransactionalEmail(mode, …)
                    │  getCredential('BREVO','apiKey',{mode})
                    ▼
              POST /v3/smtp/email
```

Deux appelants directs du driver, trois de `sendTemplate`. Le module est **mûr
et bien tenu** : garde-fou d'envoi unique (`getBrevoOperationalReadiness`),
idempotence par index unique, aucun secret journalisé, erreurs typées avec
décision de reprise. **L8 n'a rien trouvé à corriger côté projet.**

### 1.2 Table des sites d'appel

| Site | Fonction métier | Driver | Endpoint | Credential | TEST/PROD | Sync | Persistance | Retry | Idempotence | Déclencheur |
|---|---|---|---|---|---|---|---|---|---|---|
| `auth.service.js:100` | Mot de passe oublié | `emailDelivery.sendTemplate` | `/smtp/email` | `BREVO.apiKey` | `activeMode` | sync | `EmailDelivery` | non (best-effort) | aucune (pas d'`actionExecutionId`) | Visiteur du Manager |
| `sendEmailHandler.js:147` | Notification de contact | idem | `/smtp/email` | idem | `activeMode` | async (dispatcher) | `EmailDelivery` + `EventActionExecution` | oui, borné | **forte** — index unique sur `actionExecutionId` | Formulaire public |
| `emailTemplate.controller.js:180` | Aperçu DEV | idem | `/smtp/email` | idem | `activeMode` | sync | `EmailDelivery` | non | aucune (voulu : un test se répète) | DEV, écran modèles |
| `emailConfiguration.service.js:275` | Test de configuration | `brevoEmail` **direct** | `/smtp/email` | idem | mode explicite | sync | `EmailDelivery` + `EmailConfiguration.test` | non | aucune | DEV, carte e-mail |
| `providerConnectionTest.service.js` | Test de connexion | fetch dédié | `/account` | idem | mode explicite | sync | `IntegratedApi.modes[].verification` | non | sans objet | DEV, écran intégrations |
| `brevoWebhookConfig.service.js` | Suivi de livraison | fetch dédié | `/webhooks` | idem | mode explicite | sync | `IntegratedApi.modes[].webhook` | non | sérialisé par mode | Boot · DEV · déploiement |

---

## 2. Capacités

`backend/src/services/integratedApi/brevo/brevoCapabilities.js` — **déclaratif**.
La passerelle d'invocation appartient à L3 ; ce fichier fixe le contrat qu'elle
devra honorer, et un test le vérifie.

| Capacité | Intention | Entrées | Idempotence | Délai |
|---|---|---|---|---|
| `email.send_template` | Remettre une notification à partir d'un modèle du Panel | `templateRef`, `recipient`, `variables?`, `replyTo?`, `operationId` | `operationId`, tenue par l'appelant | 15 s |
| `email.sender.verify` | Constater par un envoi réel que ce projet peut écrire | `recipient`, `operationId` | idem | 15 s |

Les deux codes sont **exactement** ceux que `providerRegistry.BREVO.capabilities`
déclare depuis L1 ; `capabilityRegistryDrift()` casse le test si les deux
registres divergent — sinon l'interface promettrait une capacité que la
passerelle ne connaît pas.

**Ce qui n'est PAS une entrée, et le restera :**

- `sender` — sinon un projet écrit au nom d'un autre ;
- `environment` / `mode` — la doctrine appartient au Panel (L1/L2) ;
- `apiKey`, `baseUrl`, un client Brevo brut — le projet demande une intention.

**Erreurs** — codes stables, indépendants de Brevo : un projet n'a pas à
apprendre l'existence d'un `402` pour comprendre qu'un compte n'a plus de
crédits. `PROVIDER_OUTCOME_UNKNOWN` est de première classe (§5).

---

## 3. Modèles — l'autorité, et une seule

**Décision : l'autorité du contenu reste au Panel. `templateId` est interdit dans
le corps envoyé à Brevo.**

L'audit répond à toutes les questions obligatoires :

| Question | Réponse constatée |
|---|---|
| Stocké chez Brevo ? | **Non**, jamais. Le driver le documente explicitement. |
| Stocké en base ? | Oui — `EmailTemplate` + `EmailTemplateVersion`, HTML éditable, versionné, `enabled`. |
| HTML local ? | Oui, comme **défaut** : `utils/emailTemplateRegistry.js`, 5 modèles. |
| `templateId` en dur ? | Oui, dans le registre code-first — c'est voulu : la base n'invente pas d'identifiant. |
| Variables dynamiques ? | Oui, **déclarées** par modèle, typées, requises ou non. Une clé non déclarée n'est pas rendue. |
| Repli ? | `sampleVariables` pour l'aperçu seulement. Une variable requise absente **fait échouer le rendu**. |
| Versionnement ? | Oui, `EmailTemplateVersion`, et la version est gravée sur la livraison. |
| Environnement ? | Non — le contenu ne dépend pas du monde. Seul l'expéditeur en dépend. |
| Expéditeur associé ? | **Non**, et c'est un invariant : le modèle ne porte ni expéditeur ni destinataire. |
| Traduction ? | Aucune. Français uniquement. |

La chaîne d'autorité cible, unique :

```
registre code-first (défauts, variables autorisées, types)
        │
        ▼
EmailTemplate + EmailTemplateVersion   ← le DEV édite ici, versionné
        │
        ▼
rendu par le Panel  →  subject + htmlContent
        │
        ▼
POST /v3/smtp/email                    ← jamais de templateId
```

Le scénario redouté — « SB Auto croit A, Panel croit B, Brevo exécute C » — est
structurellement impossible tant que Brevo n'héberge aucun contenu.

> **Aucune donnée n'a été migrée.** Le déplacement du magasin de modèles vers le
> Panel est une opération de données à part entière, avec sa reprise et sa
> réversibilité. Elle n'appartient pas à un lot d'audit.

---

## 4. Expéditeurs

`brevoSenderIdentity.js` — contrat, validation, garde de portée. **Aucun schéma
persistant n'est déclaré** : le stockage est une décision de modèle, et la poser
pendant que L5 écrit les siens créerait un conflit pour rien.

| Aujourd'hui (SB Auto) | Cible |
|---|---|
| `EmailConfiguration` singleton, **par mode** | Une identité **par projet et par environnement** |
| nom + adresse + issue du dernier test | nom + adresse + reply-to |
| Aucun appel à `/senders` ni `/domains` | Idem — décision maintenue |

L'analyse de `EmailConfiguration.model.js:16-21` — « la clé appartient à UN
compte, deux clés donc deux comptes possibles, deux expéditeurs autorisés » —
reste juste. Elle se traduit dans la cible par « une identité par projet et par
environnement », pas par « une identité globale ».

### 4.1 Expéditeur ≠ contact public

Deux adresses vivent sur le même écran (« Expéditeur e-mail »), et c'est
délibéré : c'est là qu'on les confond.

| | Expéditeur (`From`) | Contact public |
|---|---|---|
| Autorité | `SystemConfiguration` (`panelGlobalSender.service.js`) | `PanelCompany.contacts.publicContactEmail` |
| Rôle | l'en-tête sous lequel tout le parc écrit | l'adresse que le client est invité à écrire |
| Peut être technique ? | **oui** — une boîte que personne ne relève | **non** — elle doit aboutir à un humain |
| Route d'écriture | `PUT /api/email-sender` | `PUT /api/email-sender/public-contact` |
| Propagation | aucune — le Panel expédie lui-même | publiée aux projets dans `DEV_COMPANY.contacts` |

La route du contact public **n'écrit pas en base** : elle appelle `saveCompany`,
qui valide la fiche entière puis publie une version. Une écriture directe aurait
laissé les projets servir l'ancienne adresse jusqu'à la prochaine sauvegarde de
l'écran « Mon entreprise » — c'est-à-dire peut-être jamais.

Aucun `templateCode` n'a été créé pour elle : les modèles consomment déjà
`developer.supportEmail`, et c'est le RÉSOLVEUR du projet qui a changé de
source. Un modèle nouveau aurait exigé un déploiement du Panel puis une
déclaration par projet, pour transporter une donnée que le canal existant
transportait déjà.

**Répliques interdites** comme repli du contact public : l'expéditeur du parc,
`contacts.email`, `contacts.supportEmail` (Let's Encrypt), l'adresse d'un compte
SUPER_ADMIN, une variable d'environnement de projet, un réglage local de
Manager. Absente, elle vaut `null` et l'envoi est REFUSÉ.

---

**`/senders` et `/domains` restent hors périmètre.** Reproduire l'état Brevo
coûtait des centaines de lignes, une demi-douzaine de statuts distants et une
dépendance à des endpoints indisponibles sur certains comptes — pour une
information dont le commerçant ne fait rien. La seule question utile est « les
e-mails partent-ils ? », et un envoi réel y répond mieux qu'un état recopié.

---

## 5. Multi-projet et environnement

```
assertProjectScope({ authenticatedProjectId, requestedProjectId })
```

Le `projectId` du **contexte authentifié** est la seule autorité. Un `projectId`
dans la charge utile n'est pas une information, c'est une proposition : s'il
diverge, on **refuse en 403** plutôt que de choisir. Ignorer silencieusement
serait presque aussi mauvais — un projet qui envoie un identifiant étranger a un
bug ou une intention, et les deux méritent une trace.

L'environnement est **injecté**, jamais deviné. `resolveSenderIdentity` refuse un
appel sans environnement au lieu de retomber sur `TEST` : un repli enverrait un
jour un e-mail de production sous une identité de recette.

**L8 ne touche pas à la doctrine d'environnement.** Aucun second sélecteur, aucun
`activeMode`, aucune politique concurrente — un test le vérifie. La primitive
consommée est `integratedApi/environment.js` (L1) ; sa révocation d'`activeMode`
appartient à L2, qui y travaille en parallèle.

---

## 6. Adaptateur

`brevoTransport.js` — la seule porte du Panel vers l'API de Brevo.

Le driver existant du projet a été **audité avant d'écrire** : il est bon, et la
frontière du Panel en reprend les décisions éprouvées (`api-key` et non Bearer,
`charset=utf-8` explicite, journal pauvre, classement des refus). Elle en
diffère sur trois points :

1. **Aucun accès au coffre, aux modèles ni à l'environnement.** Tout est résolu
   en amont et injecté — la frontière se teste sans base, sans réseau, sans
   secret.
2. **`fetchImpl` injectable** plutôt qu'un `globalThis.fetch` remplacé : un test
   qui monkey-patche le `fetch` global contamine les suivants.
3. **`outcome` séparé de `retryable`** (§7).

**Surface volontairement minimale : deux opérations.** Ajouter `listContacts()`
« au cas où » ouvrirait une surface que personne n'a demandée et que tout le
monde finirait par utiliser. Un test refuse toute exportation nommée `contact`,
`list`, `campaign`, `sms` ou `whatsapp`.

Ce qui ne sort jamais : la clé, l'adresse en clair, le sujet, le HTML, le corps
d'erreur du fournisseur. Un 500 renvoyant une page de proxy interne ne propage
rien de son contenu.

---

## 7. Idempotence — et la fenêtre qu'on ne referme pas

**Brevo n'expose aucune clé d'idempotence sur `POST /v3/smtp/email`**,
contrairement à Stripe et son en-tête `Idempotency-Key`. La déduplication est
donc entièrement la nôtre : `operationId`, index unique, refus du second envoi.

La distinction centrale du lot :

| | Question | Exemple |
|---|---|---|
| `retryable` | Une nouvelle tentative a-t-elle une **chance** ? | 429 : oui |
| `replaySafe` | Une nouvelle tentative risque-t-elle de **doubler** ? | 429 : non, Brevo a répondu |

Une reprise **automatique** exige les deux. Sinon, un humain tranche.

```
Brevo a RÉPONDU (4xx/5xx)   → FAILED   → rien n'est parti → rejeu sûr
Brevo n'a PAS répondu       → UNKNOWN  → peut-être parti  → JAMAIS de rejeu auto
2xx sans messageId          → UNKNOWN  → probablement parti, plus suivable
```

> **« Délai dépassé » n'est pas « non envoyé ».** C'est la règle la plus
> importante de ce lot. La requête a pu atteindre Brevo, l'e-mail être accepté,
> et seule la réponse se perdre. Traiter ce cas comme un échec conduit tôt ou
> tard à un rejeu, donc à un doublon chez un vrai client. Un doublon est
> irréversible ; une notification manquante est réparable d'un clic — **et
> signalée**.

Côté projet, la même règle est déjà appliquée sous le nom `SEND_INTERRUPTED` :
une livraison trouvée en `SENDING` passe en `FAILED` non retryable, visible en
`DEAD_LETTER`. Elle n'est pas renvoyée automatiquement. **Cette décision doit
être préservée telle quelle à la migration.**

---

## 8. Persistance — la frontière

Le plan de contrôle est un **transport**. Il ne devient pas le CRM.

| Le Panel garde | Le projet garde |
|---|---|
| Issue technique datée | Communication métier |
| `providerMessageId` | Destinataire |
| Statut HTTP, durée, code d'erreur | Contenu rendu / référence de modèle |
| `operationId`, environnement, projet | Statut lu par l'utilisateur |

SB Auto possède déjà `EmailDelivery`, `EmailDeliveryEvent` et
`BrevoWebhookEvent` : **ne pas créer un second historique.** Deux historiques
qui divergent valent moins qu'un seul. Le journal du Panel ne porte ni adresse,
ni sujet, ni variables — un test refuse tout champ d'audit dont le nom évoque une
donnée personnelle.

---

## 9. Webhooks — ce dont L5 a besoin

**L5 possède l'architecture webhook générique.** L8 n'a créé aucun registre,
aucun réconciliateur, aucun modèle, aucun endpoint, aucune idempotence
générique. `brevoEventMapping.js` est de la **connaissance Brevo** : importable
par L5, il n'importe rien de L5.

Vérification faite le 2026-08-10 : L5 a déjà déclaré la capacité Brevo dans
`services/webhooks/webhookRegistry.js`, correctement — `SHARED_SECRET_BEARER`,
`CALLER_SUPPLIED`, `environmentAware: false`, aucune preuve cryptographique.
Le mécanisme est confirmé par la documentation officielle : Brevo propose une
allowlist d'IP, des identifiants dans l'URL, un `auth: {type:'bearer', token}` et
des en-têtes libres — **et aucune signature**
([developers.brevo.com](https://developers.brevo.com/docs/username-and-password-authentication)).

### 9.1 « L5 integration requirements »

Ce que L8 demande à L5, par ordre de gravité. Chacun est issu d'un incident réel
côté projet, pas d'une préférence.

| # | Exigence | Ce qui casse sans elle |
|---|---|---|
| **1** | **Comparer les événements par forme canonique, en INCLUSION** — appeler `compareSubscribedEvents()`, pas une égalité de tableaux ni de tailles. | Brevo renvoie sa propre graphie (`hard_bounce` vs `hardBounce`) et ajoute des événements de lui-même. Une égalité stricte déclare « désynchronisé » un webhook sain : mise à jour → Brevo re-normalise → divergence. **La boucle ne s'arrête jamais.** |
| **2** | **Ne JAMAIS souscrire `sent`.** | Brevo le renvoie collapsé en `request`. L'événement souscrit paraît éternellement manquant : même boucle infinie. |
| **3** | **Souscrire les 13 événements de `SUBSCRIBED_EVENTS`.** La liste actuelle de L5 en compte 9 : il manque `request`, `opened`, `uniqueOpened`, `click`. | Sans `request`, aucune trace d'acceptation côté suivi. Sans les trois autres, aucun suivi d'engagement — c'est la moitié de la valeur du webhook. |
| **4** | **Tolérer la liste vide.** Un compte sans webhook répond **400/404 « Webhook record does not exist »**. Signaux dans `BREVO_WEBHOOK_FACTS.emptyListSignals`. | Le réconciliateur croit le fournisseur en panne et n'ose rien créer : **la première configuration devient impossible.** |
| **5** | **Filtrer `?type=transactional` à la lecture.** | Les webhooks marketing et inbound du compte passent pour des endpoints étrangers — ou pire, pour des doublons à supprimer. |
| **6** | **Fenêtre de tolérance à la rotation** (~15 min) : accepter l'ancien jeton en plus du nouveau. Exige un rôle de coffre `webhookSecretPrevious` — **absent de `providerRegistry.BREVO`**. | Les appels déjà en vol au moment de la rotation portent l'ancien jeton, sont rejetés en 401, et **leurs événements sont perdus définitivement.** |
| **7** | **Clé d'idempotence composée**, pas seulement une empreinte : `environment \| providerMessageId \| canonicalEvent \| occurredAtMs \| recipientHash` (`buildEventIdentity()`). Empreinte du corps **brut** en repli. | Brevo ne fournit aucun identifiant d'événement. Une empreinte calculée sur le corps *parsé* change avec l'ordre des clés — le même fait produit deux clés. |
| **8** | **Dates : quatre champs, deux unités** — `ts_epoch` en ms, `ts`/`ts_event` en s, `date` en ISO (`parseEventDate()`). | Multiplier des millisecondes par mille place l'événement en l'an 56000 et casse tout tri chronologique, silencieusement. |
| **9** | **Ne jamais présenter un webhook Brevo comme « vérifié »** — seulement « authentifié ». | Une garantie qu'on n'a pas, affichée comme acquise. |
| **10** | **Sonde de joignabilité sur notre propre URL publique.** Brevo n'a **aucune** API d'événement de test. | Sans elle, « aucun événement reçu » est indiscernable de « le tunnel est tombé », et le diagnostic tourne en rond. |
| **11** | **Corréler par `providerMessageId` sous ses DEUX graphies** (`providerMessageIdVariants()`) : Brevo renvoie parfois `<id>`, parfois `id`. | Aucun rapprochement : le suivi « reste bloqué » sans que personne ne comprenne pourquoi. |
| **12** | **Ne jamais mettre le secret dans l'URL**, bien que Brevo le documente. | Le secret finit dans les journaux d'accès du reverse-proxy. |

Aucune de ces exigences ne demande à L5 de changer d'architecture. Ce sont des
paramètres et des fonctions de comparaison — toutes fournies par
`brevoEventMapping.js`.

---

## 9 bis. Migration du runtime — état au 2026-08-10 (L8.2)

### Ce qui est basculé

`email.sender.verify` est **servi par le Panel**. Le diagnostic « Connexion
Brevo » du Manager passe désormais par
`capabilityClient.invokeCapability('email.sender.verify')` → pont →
passerelle L3 → coffre L1 → Brevo.

| | Avant | Après |
|---|---|---|
| clé utilisée | celle du projet, en base locale | celle du **Panel**, chiffrée |
| monde | `mode` demandé par l'écran | celui de **l'instance de Panel** (L2) |
| appel réseau depuis le projet | `GET /v3/account` | **aucun** |
| repli si Panel absent | — | **aucun**, par décision |
| `verified` local après test | estampillé | **laissé intact** |

### Divergence assumée avec le contrat §« sender.verify »

Ce document décrit `email.sender.verify` comme un **envoi réel** de contrôle
(`POST /smtp/email`, sortie `ACCEPTED | UNKNOWN`, `providerMessageId`). L3 l'a
implémentée en **lecture seule** (`GET /v3/account`, sortie `reachable` +
`accountLabel`).

C'est la sémantique en lecture qui est servie aujourd'hui, et L8.2 l'a
conservée délibérément :

- elle correspond exactement à l'écran migré — le diagnostic de **connexion**,
  pas l'envoi de test de la page « Configuration e-mail » ;
- elle n'a pas de destinataire, donc pas de donnée personnelle en entrée, donc
  pas d'e-mail réel envoyé à chaque clic sur un bouton de diagnostic ;
- son rejeu est gratuit, ce qui la rendait éligible comme **première**
  migration — un envoi ne l'aurait pas été.

`recipient` est devenu **facultatif** dans le schéma d'entrée pour cette raison,
tout en restant validé s'il est fourni : le jour où un envoi de contrôle sera
servi, l'entrée n'aura pas à changer de forme.

**Conséquence à retenir** : l'« envoi de test » de la page Configuration e-mail
reste **local**. Il relève de `email.send_template`, pas de cette capacité.

### Ce qui n'est pas basculé, et ce qu'il faudrait

`email.send_template` reste `migrated: false`. Trois briques manquent —
magasin de modèles du Panel, magasin d'identités expéditrices par projet,
registre d'idempotence sur `operationId`. Détail et justification :
[INTEGRATED_API_CONTROL_PLANE_ROADMAP.md](INTEGRATED_API_CONTROL_PLANE_ROADMAP.md)
§L8.2.

### Inventaire des appels Brevo locaux restants

| Fichier | Classement | Motif |
|---|---|---|
| `services/providerConnectionTest.service.js` | **MIGRATED** | le pilote local est supprimé, pas contourné |
| `services/brevo/brevoEmail.service.js` | **STILL_REQUIRED** | transport de `/smtp/email` — bascule avec `send_template` |
| `services/email/emailDelivery.service.js` | **STILL_REQUIRED** | pipeline d'envoi métier |
| `services/emailConfiguration.service.js` | **STILL_REQUIRED** | envoi de test du Manager — même dépendance |
| `services/email/brevoOperational.service.js` | **STILL_REQUIRED** | garde opérationnelle du driver |
| `services/brevo/brevoWebhookConfig.service.js` | **DIAGNOSTIC** | webhooks du projet, coexistants par décision (L5 §« Migration ») |
| `utils/emailDebug.js` | **DIAGNOSTIC** | journal, aucun appel sortant |

Aucun **DEAD** ne subsiste : ce qui est devenu mort dans ce lot a été retiré.

Les credentials Brevo du projet restent en place et **ne sont pas** marqués
`LEGACY_UNUSED` : le critère est « plus aucun appel métier local », et l'envoi
en est encore un.

---

## 10. Communication Center

**Elle n'existe pas.** Recherche sur les deux dépôts (`communication center`,
`centre de communication`, `communicationCenter`, code et documentation) :
**zéro occurrence**. Il n'y a ni inbound, ni SMS, ni WhatsApp, ni participants,
ni rôles de destinataires, ni rattachement à un dossier.

Ce qui existe est un **module de notification transactionnelle**, mûr et bien
délimité. L8 ne construit pas le CRM.

Les primitives à ne pas casser, pour qu'un adaptateur ne devienne pas
incompatible avec une cible métier plus riche :

- le destinataire est **résolu à l'exécution**, jamais figé dans un contenu ;
- une exécution **par destinataire** — les administrateurs ne voient jamais les
  adresses les uns des autres ;
- `replyTo` est déjà distinct du `sender` : une réponse à une notification de
  contact écrit au visiteur, pas à nous. C'est la brique d'un futur fil de
  conversation ;
- `providerMessageId` est conservé sous forme canonique : la poignée de
  corrélation d'un futur fil existe déjà.

---

## 11. Pièces jointes

Aucune capacité n'en accepte, et l'inventaire n'en trouve aucune sur le chemin
e-mail (les seules du parc sont des documents de signature Yousign).

Le contrat **futur** est fixé maintenant plutôt que découvert sous pression :

```
INTERDIT   { path: '/var/www/panel/uploads/…' }   lecture arbitraire du disque
ADMIS      { mediaRef: '<identifiant opaque>' }   appartenance vérifiée avant lecture
```

Un chemin fourni par un projet est une faille, et aucune validation de chaîne ne
la referme durablement. Bornes : 5 Mo, `application/pdf`, `image/png`,
`image/jpeg`. `validateBrevoCapabilities()` refuse toute entrée dont le nom
évoque un chemin.

---

## 12. Page IntegratedAPI

Ce que la page doit savoir dire de Brevo — et rien de plus :

```
Brevo    Environnement : TEST    ● Disponible    vérifié il y a 4 min
         Capacités : email.send_template, email.sender.verify   (non invocables)
         Webhook : configuré · dernier événement il y a 2 min          [L5]
```

`describeAvailability('BREVO')` (L1) répond déjà à tout : présence, validité,
fraîcheur de la preuve, environnement, motif d'indisponibilité.

**La configuration métier n'a pas sa place ici.** Identité expéditrice et
modèles sont des données de projet, pas de fournisseur : les poser sur l'écran
des intégrations mélangerait « avec quel compte parle-t-on ? » et « au nom de qui
écrit-on ? » — exactement la confusion du §0. Elles appartiennent à la fiche du
projet. **Décision prise après audit, comme demandé.**

---

## 13. Migration — sans big bang

| Étape | Contenu | État |
|---|---|---|
| 1 | Credentials Brevo configurés dans le Panel, **non utilisés** | **fait** (L1) |
| 2 | Fondations : capacités, transport, événements, identité | **fait** (L8, ce lot) |
| 3 | Passerelle d'invocation + magasin d'identités et de modèles | **à faire** — dépend de L3 |
| 4 | Diagnostic en observation : le Panel valide, le projet envoie | à faire |
| 5 | **Une** capacité bascule : `email.sender.verify`, avec repli local | à faire |
| 6 | Vérification sur une instance réelle, puis `email.send_template` | à faire |
| 7 | Les credentials projet deviennent inutiles | à faire |
| 8 | Suppression — **lot dédié, jamais celui-ci** | L10 |

L'étape 5 commence par `email.sender.verify` et non par `send_template` : c'est
la seule capacité dont l'échec ne prive personne d'une notification attendue.

**Aucun repli n'est retiré tant qu'une capacité n'est pas éprouvée de bout en
bout.** Les credentials Brevo de SB Auto restent en place.

---

## 14. Tests

`Panel/tests/brevo-control-plane.test.js` — **236 assertions, 0 échec**, aucun
réseau, aucune base.

| # exigé | Prouvé par |
|---|---|
| 1 · credentials jamais exposés | §4 — journal, résultat et message d'erreur inspectés |
| 2 · validation Brevo Panel | §8 — `GET /account`, lecture seule, 401 typé |
| 3 · registre de capacités | §1 — deux capacités, gelé, aucune dérive avec L1 |
| 4 · projet A ≠ projet B | §9 — 403 sur `projectId` étranger |
| 5 · isolation d'expéditeur | §9 — identités distinctes, aucun emprunt de reply-to |
| 6 · isolation de modèle | §2 — `templateId` interdit, autorité Panel |
| 7 · environnement injecté | §10 — aucun repli, refus si absent, pas d'entrée `mode` |
| 8 · timeout | §6 — `TIMEOUT` → `UNKNOWN` |
| 9 · auth invalide | §5 — 401/403 → `UNAUTHORIZED`, non retryable |
| 10 · 4xx fournisseur | §5 — 400/402/429 distingués |
| 11 · 5xx fournisseur | §5 — 500/503 retryables |
| 12 · réponse malformée | §6 — 2xx sans `messageId` → `UNKNOWN` |
| 13 · aucun secret en journal | §4 |
| 14 · aucun secret sur le pont | §15 — garde L4 rejouée |
| 15 · `providerMessageId` conservé | §3, §8 — forme canonique et variantes |
| 16 · politique de reprise | §5 — `describeRetryDecision` |
| 17 · timeout ambigu | §6 — aucune reprise automatique |
| 18 · appartenance des pièces jointes | §2 — politique bornée, chemin interdit |
| 19 · capacité non supportée | §1, §2 — `null`, jamais une devinette |
| 20 · Manager/SB Auto non régressé | §15 + rejeu des suites du projet |

---

## 15. Réserves

1. **Rien n'est branché.** Les quatre modules sont testés et cohérents, mais
   aucun code de production ne les importe encore : la passerelle appartient à
   L3. Leur valeur est un contrat vérifié, pas un runtime.
2. **Le magasin d'identités et de modèles n'existe pas.** Deux décisions de
   schéma restent ouvertes, volontairement, tant que L5 écrit ses modèles.
3. **`webhookSecretPrevious` manque au registre L1.** Sans lui, toute rotation
   de secret perd les événements en vol. La décision appartient à L5/L1 —
   `providerRegistry.js` n'a pas été modifié pour éviter un conflit.
4. **`tests/brevo-control-plane.test.js` n'est pas dans `run-all.js`.** Ce
   fichier portait au moment du commit des modifications d'une autre session ;
   le stager aurait committé leur travail. **À ajouter après leur commit** —
   c'est la seule dette de ce lot.
5. **Deux tests SB Auto sont rouges, et ce n'est pas L8.**
   `brevo.test.js` et `integrated-api.test.js` échouent sur
   « `activeMode` indépendant d'`ENV` » et « aucun repli PROD→TEST ». Ces
   assertions sont exactement celles que le chantier L2 révoque : son travail
   est en vol dans l'arbre (`integratedApi.service.js` modifié,
   `integratedApiEnvironment.js` créé). L'arbre SB Auto était **propre** au
   début de cette session ; aucun fichier n'y a été touché par L8.

---

## 16. GO / STOP

**GO pour préparer la migration. STOP pour l'exécuter dans ce lot.**

Ce qui est acquis :

- l'inventaire est complet, et il est plus petit qu'attendu — de l'e-mail
  transactionnel, rien d'autre ;
- les cinq objets du §0 sont séparés, nommés, et la séparation est testée ;
- l'adaptateur sait dire « je ne sais pas », et ne rejoue jamais seul ;
- L5 a une liste d'exigences précise, chacune adossée à un incident réel.

Ce qui bloque encore, et qui n'appartient pas à L8 :

- la passerelle d'invocation (**L3**) ;
- la doctrine d'environnement en cours de révocation (**L2**) ;
- le réconciliateur de webhooks (**L5**).

Le succès de ce lot n'est pas « Brevo est migré ». C'est qu'on **peut** le
migrer : sans secret côté projet, sans ambiguïté TEST/PROD, sans confondre
credential, expéditeur et modèle, et sans avoir marché sur les pieds de
personne.
