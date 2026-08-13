# R10.4 — Ouverture commerciale, expéditeur e-mail global, plan de contrôle Yousign

**Date** : 2026-08-13
**Périmètre livré** : sections A (ouverture commerciale) et B (expéditeur global) — côté **Panel**.
**Périmètre reporté** : sections C/D/E (Yousign) et la purge de la surface `From` de SB Auto.

> **Verdict global : R10.4 PARTIEL — GO DEPLOYMENT TEST : NON.**
> Le détail, les preuves et les raisons figurent en §9. Aucun PASS n'est annoncé
> pour une section incomplète.

---

## 1. Isolation (§0)

Relevé **avant** toute modification :

| Dépôt | HEAD | Branche | upstream | ahead/behind | Arbre |
|---|---|---|---|---|---|
| Panel | `65aec6d45fc149dc1fb6264cc39425ae45e12c32` | `feat/generic-deployment-engine` | `origin/feat/generic-deployment-engine` | 0 / 0 | propre |
| SB Auto 06 | `f4e30f351d3afd60c19a507516d354d5c2752142` | `feat/unified-production-baseline` | `origin/feat/unified-production-baseline` | 0 / 0 | propre |

Les deux HEAD correspondent exactement aux baselines attendues. `git status --porcelain`
était **vide** dans les deux dépôts : aucun fichier à classifier, donc aucun
`PARALLEL_KNOWN`, aucun `UNKNOWN`, aucune condition STOP d'isolation.

Aucun `reset --hard`, aucun `stash`, aucun `rebase`, aucun `git add -A` n'a été
employé. Un seul `git checkout --` a été utilisé, sur SB Auto, pour revenir à la
baseline (§8) ; il n'a touché aucun travail parallèle, l'arbre étant vide.

Encodage : toutes les éditions passent par les outils d'édition directe. Aucun
fichier n'a été réécrit via `Get-Content`/`Set-Content`/`Out-File` — UTF-8 sans
BOM et LF préservés.

---

## 2. A — « Ouvrir commercialement » : ce que c'est réellement

### 2.1 Call graph réel

```
Clic « Ouvrir commercialement »
  frontend/src/components/CommercialReadinessCard.tsx
    → PUT /api/projects/:projectId/commercial-readiness      (requirePanelDev)
      backend/src/routes/projects.routes.js
    → controllers/capabilities.controller.js :: putCommercialReadiness
    → services/capabilities/commercialReadiness.service.js :: setCommercialReadiness
        · getProjectOrThrow(projectId)                        lecture fiche
        · vocabulaire fermé + table de transitions            refus si invalide
        · describeReadinessChecks(record)                     3 prérequis
        · registryStore.setCommercialState(... expected)      écriture CONDITIONNELLE
        · recordEvent(COMMERCIAL_OPENED | COMMERCIAL_CLOSED)  chronologie
    → mutations : PanelProject.commercialState
                  commercialStateUpdatedAt / UpdatedBy / Reason
    → side effects : AUCUN appel fournisseur, AUCUN débit, AUCUN envoi
    → conséquence runtime : capabilityGateway.service.js, étape 5
```

### 2.2 La vraie nature de l'ouverture

**Autorisation d'écritures externes engageantes. Rien d'autre.**

Ce n'est pas une readiness (elle n'a que 3 contrôles, et ils gardent
uniquement l'ouverture), pas une activation client, pas un verrou de
facturation, pas une mise en production, pas une activation de contrat.
Aucune ambiguïté historique n'a été trouvée : la responsabilité est déjà
unique dans le code, et `commercialReadiness.js` la documente explicitement
(`PREOPENING ≠ TEST`).

L'enforcement est **unique** et vit à l'étape 5 de la passerelle, *avant* la
disponibilité de l'adaptateur et *avant* l'ouverture du coffre — ce qui rend
« zéro contact fournisseur » vrai **par construction** et non par accident de
calendrier.

### 2.3 Matrice AVANT / APRÈS ouverture

Établie par lecture du code, pas du libellé du bouton. `CAPABILITY_EFFECTS`
(table L1.75) est la seule autorité ; `FORBIDDEN_IN_PREOPENING` ne contient que
`FINANCIAL_WRITE` et `LEGAL_WRITE`.

| Sujet | AVANT (PREOPENING) | APRÈS (LIVE) | Preuve |
|---|---|---|---|
| Accès Manager / vitrine / API / login | OUI | OUI (inchangé) | aucune lecture de `commercialState` hors passerelle |
| Configuration contrat | OUI | OUI (inchangé) | aucune capacité contrat dans la table |
| Checkout / paiement Stripe | **NON** | **OUI** | `billing.checkout.create` = `FINANCIAL_WRITE` |
| Abonnement (résiliation) | **NON** | **OUI** | `billing.subscription.cancel_*` = `FINANCIAL_WRITE` |
| Remboursement | **NON** | **OUI** | `billing.refund` = `FINANCIAL_WRITE` |
| Client / tarif / portail Stripe | OUI | OUI | `REVERSIBLE_EXTERNAL_WRITE`, autorisé |
| Lectures Stripe (facture, session, abonnement) | OUI | OUI | `READ_ONLY` |
| Prestation L10.5 | OUI | OUI | passe par les capacités ci-dessus |
| Brevo (envoi d'e-mail) | OUI | OUI | `COMMUNICATION_WRITE`, **non** interdit |
| Yousign — demande de signature | **NON** | **OUI** | `signature.request.create` = `LEGAL_WRITE` |
| Yousign — document signé | OUI | OUI | `signature.document.download` = `READ_ONLY` |
| Réception webhooks | OUI | OUI | route publique, aucune lecture d'ouverture |
| Provisionnement webhook | OUI | OUI | `webhook.endpoint.ensure` = `CONFIGURATION` |
| Schedulers | OUI | OUI | aucun scheduler ne lit `commercialState` |
| Bridge (appairage, sync, heartbeat) | OUI | OUI | contrôlé par l'appairage, pas par l'ouverture |
| Projection Finances | OUI | OUI | projection locale, aucune capacité |
| Coûts récurrents | OUI | OUI | registre local |
| Payment Default / suspension | OUI | OUI | `SiteStatus`, autorité distincte et volontairement disjointe |
| Suspension manuelle | OUI | OUI | idem |
| Diagnostics providers | OUI | OUI | `READ_ONLY` / `CONFIGURATION` |
| Opérations DEV internes | OUI | OUI | hors passerelle |
| DNS / déploiement | OUI | OUI | `dns.record.ensure` = `INFRASTRUCTURE_WRITE`, autorisé (« on déploie AVANT d'ouvrir ») |

**Aucun acte financier caché.** L'ouverture ne déclenche rien : elle lève une
interdiction. Le test `commercial-opening-concurrency.test.js` compte les
sorties réseau sur l'ensemble du fichier et exige `0`.

### 2.4 Readiness (§A4)

Trois prérequis, et ils sont **structurels**, jamais des credentials :

| Code | Question | Credential requis ? |
|---|---|---|
| `PAIRED` | une instance est-elle appairée ? | non |
| `ENVIRONMENT_KNOWN` | son monde est-il déclaré ? | non |
| `REACHABLE_DESTINATION` | a-t-elle une destination active ? | non |

**La readiness ne demande aucune clé locale Stripe, Hostinger, Brevo ou
Yousign** — vérifié par lecture de `describeReadinessChecks`. Côté projet,
`panelAuthorityReadiness.js` route déjà Stripe vers le Panel. Voir §9 pour la
réserve Yousign.

### 2.5 Défauts trouvés et corrigés

**Défaut 1 — doublon de chronologie sous concurrence (corrigé).**
`setCommercialReadiness` lisait la fiche, validait la transition et les
prérequis, puis écrivait via un `$set` **inconditionnel**. Deux requêtes
simultanées franchissaient toutes les deux le raisonnement et écrivaient toutes
les deux : l'état final était juste, mais la chronologie contenait **deux
`COMMERCIAL_OPENED` pour un seul geste** — c'est-à-dire précisément à l'endroit
où l'on vient lire « quand cette instance a-t-elle été ouverte, et par qui ».

*Correction* : `registryStore.setCommercialState` accepte désormais `expected` et
filtre dessus (comparaison-et-échange). Le perdant n'écrit rien ; s'il visait le
même état, il converge sans second événement ; s'il visait l'état inverse, il
reçoit `PANEL_COMMERCIAL_STATE_CONCURRENT_CHANGE`.
Subtilité verrouillée par test : le filtre porte sur l'état **stocké**
(`null` = « jamais décidée »), pas sur l'état **effectif** (`PREOPENING`) —
filtrer sur le second aurait fait échouer silencieusement l'ouverture de toutes
les fiches neuves.

**Défaut 2 — réponse périmée sur le chemin idempotent (corrigé).**
La branche « déjà dans cet état » rendait l'instantané lu quelques instructions
plus tôt. Sous concurrence, elle pouvait annoncer un état qu'un geste voisin
venait de remplacer. Elle **relit** désormais avant de répondre, comme le fait
le chemin qui écrit.

**Défaut 3 — clé dupliquée dans la table des effets (corrigé).**
`'billing.invoice.list'` était déclarée deux fois dans `CAPABILITY_EFFECTS`
(même valeur, la seconde écrasant silencieusement la première). Un littéral
d'objet JavaScript avale ce doublon sans bruit ; sur une table qui décide si de
l'argent réel bouge, c'est un mode de défaillance à ne pas laisser. La
déclaration redondante a été retirée ; les 20 entrées restent alignées avec le
registre (vérifié par script).

### 2.6 Impact UI (§A3)

La confirmation énumérait « les opérations commerciales réelles autorisées » —
un résumé qui ne dit ni lesquelles, ni ce qui reste intact. Elle affiche
désormais, dans les deux sens :

- **« Cette action autorisera… »** — la liste exacte des capacités, **rendue par
  le serveur** (`blockedInPreopening`, dérivé de la table des effets). L'écran ne
  peut donc pas se désynchroniser de la politique qu'il annonce, et l'ajout d'un
  verbe financier y apparaît sans qu'on y touche.
- **« Elle ne modifiera pas… »** — environnement technique, identifiants
  fournisseurs, contrat, état du site et suspension, planificateurs,
  déploiement ; et le fait qu'elle **lève une interdiction sans agir**.
- **« Prérequis vérifiés… »** — les trois contrôles, nommés.
- **Réversibilité** — « Repasser en pré-ouverture » referme **sans condition**
  (frein d'urgence) ; et la part **partiellement irréversible** est dite
  explicitement : les paiements encaissés et les signatures demandées entre-temps
  restent acquis.

### 2.7 Recette exécutée (A)

`tests/commercial-opening-concurrency.test.js` — **29 contrôles, 0 échec** :

| Scénario | Résultat |
|---|---|
| Double clic ×8 (concurrent) | 1 seul `COMMERCIAL_OPENED` |
| Rejeu sériel ×4 après coup | aucun second événement, date et motif d'origine intacts |
| Course inverse (ouvrir ‖ fermer) | aucun état inventé, perdant refusé explicitement |
| Cycle ouvrir → 8× fermer → ouvrir | 2 ouvertures, 1 fermeture |
| Écriture conditionnelle sur état périmé | refusée, auteur gagnant préservé |
| Fiche jamais décidée (`null`) | s'ouvre, une seule fois |
| Sorties fournisseur | **0** sur tout le fichier |

Non-régression ciblée : `commercial-readiness.test.js` (80/80),
`commercial-readiness-runtime.test.js` (75/75), `capability-preopening.test.js`
(30/30).

---

## 3. B — Expéditeur e-mail global (Panel)

### 3.1 Doctrine retenue, et ce qu'elle corrige

**Une seule source de vérité globale**, dans `SystemConfiguration.email` :
`senderEmail` (From / support) et `senderName` (From name), plus
`updatedAt` / `updatedBy`.

L8.3 donnait à chaque projet son identité expéditrice, avec un argument
sérieux — « chaque garage écrit à ses clients sous son propre nom ». Ce que
l'argument ratait : l'adresse d'expédition est aussi l'adresse de **support**,
celle qu'on surveille, qu'on authentifie SPF/DKIM sur un domaine qu'on possède,
et qu'on doit pouvoir changer d'un seul geste. Dispersée en N copies, elle
n'était plus administrable.

Le besoin que L8.3 protégeait **n'est pas abandonné : il change de champ**. Le
`Reply-To` reste par projet et par environnement. Le message part du support de
la plateforme, la réponse arrive chez le garage — la séparation que l'en-tête
`Reply-To` existe exactement pour exprimer.

### 3.2 Call graph e-mail

```
événement métier (projet)
  → controlPlane.invoke('email.send_template', { templateRef, recipient,
                                                 variables, replyTo?, operationId })
  → PONT → capabilityGateway.service.js  (9 étapes, dont ouverture commerciale)
  → capabilities/brevoSendAdapter.js
      · sender = resolveForProject({ authenticatedProjectId, environment })
          ├── From      ← panelGlobalSender.resolveGlobalSender()      GLOBAL
          └── Reply-To  ← panelSenderIdentity.resolveReplyTo()          PROJET
      · rendered = renderForSend({ templateCode, projectId, variables })
      · sendTransactionalEmail(... credentials du COFFRE ...)
  → providerMessageId
  → settleSucceeded(operation, { providerMessageId })
  → webhook Brevo → /webhooks/providers/brevo
  → emailDeliveryDispatch.dispatchDeliveryEvent
      · findByProviderMessageId → opération
      · si operation.projectId === PANEL_SELF_SCOPE → test du Panel (§3.5)
      · sinon → emitChange(EMAIL_DELIVERY_EVENT, audience: projectId)
  → projet : EmailDelivery.status DELIVERED | BOUNCED
```

Pour le **Panel lui-même**, le chemin est identique, à une étape près :
`resolveForPanel()` au lieu de `resolveForProject()` — même `From`, pas de
`Reply-To`.

### 3.3 Interdits, et comment ils sont tenus

| Interdit | Tenu par |
|---|---|
| `From` codé en dur dans un modèle | aucun modèle ne porte de `From` ; le rendu ne produit que sujet + HTML |
| `From` par projet | `saveSenderIdentity` **refuse** `fromEmail`, `fromName`, `senderEmail`, `senderName` avec `PANEL_PROJECT_FROM_NOT_CONFIGURABLE` |
| Repli silencieux `.env` | `resolveGlobalSender()` **lève** si non configuré ; test avec `EMAIL_SENDER` / `SENDER_EMAIL` posées : toujours refusé |
| Expéditeur dérivé du credential Brevo | le coffre n'est lu que par `credentialResolver`, et l'adaptateur ne dérive rien de `credentials` |
| Secret dans la configuration | `FORBIDDEN_FIELDS` refuse `apiKey`, `webhookSecret`, `secretKey`, `apiToken`, `password` |

**Compteurs (côté Panel)** :

```
GLOBAL_PANEL_EMAIL_FROM_CONFIGURATION = 1     (SystemConfiguration.email)
PROJECT_EMAIL_FROM_CONFIGURATION      = 0     (PanelProjectSenderIdentity ne porte plus de From)
```

### 3.4 Suppressions et requalifications

| Élément | Avant | Après |
|---|---|---|
| `PanelProjectSenderIdentity.fromEmail/fromName` | requis | **retirés** du schéma (documents anciens inertes, non lus) |
| `panelSenderIdentity.resolveForProject` | rendait l'identité du projet | rend le `From` global + le `Reply-To` du projet |
| `panelSenderIdentity.markVerifiedAtProvider` | marquait l'adresse projet vérifiée | **retiré** — il n'y a plus d'adresse par projet à vérifier |
| `describeForProject` | vue de l'identité projet | vue du `Reply-To` + rappel du `From` global (`fromSource: 'GLOBAL'`) |
| `email.send_template` (sortie) | `{status, providerMessageId, operationId}` | + `sender: {email, name}` (facultatif : absent au rejeu) |

Le champ `sender` ajouté à la sortie répond à un besoin précis : le projet
affiche un suivi de ses envois, et depuis que le `From` est global, une copie
locale serait une **devinette** — juste tant que personne ne change l'adresse,
fausse pour tous les envois passés dès qu'on la change.

### 3.5 Le test d'expédition réel (§B4/B5)

Nouvelle source d'invocation **`PANEL_SELF`** : le Panel écrivant à ses propres
exploitants, sans fiche projet. Lui prêter la fiche d'un client aurait fait
décider de cet envoi par l'ouverture commerciale et les octrois d'un projet qui
n'y est pour rien.

Ce que `PANEL_SELF` **ne relâche pas** : l'état d'ouverture vaut
`DEFAULT_COMMERCIAL_STATE` (= `PREOPENING`, le défaut fermé). On aurait pu
écrire `LIVE` en arguant que le Panel n'est pas une instance cliente ; la
conséquence aurait été un chemin d'exécution ignorant la politique commerciale,
c'est-à-dire la classe de contournement que L1.75 existe pour empêcher. Cela ne
change rien aujourd'hui (`email.send_template` est `COMMUNICATION_WRITE`,
autorisée en pré-ouverture) et arrêterait les e-mails du Panel si l'effet était
un jour interdit — ce qui serait la bonne réponse, immédiatement visible.

Le seul assouplissement est l'**octroi**, sauté comme pour `PANEL_INTERNAL` : un
octroi répond à « ce projet peut-il demander ceci », question sans sujet ici.
Politique commerciale, migration, schéma d'entrée, coffre, réservation
d'opération et journal s'appliquent à l'identique.

Le registre d'opérations est partitionné sur `PANEL_SELF_SCOPE`
(`__panel_self__`), jamais utilisé pour chercher une fiche.

**Modèle dédié** : `PANEL_EMAIL_SENDER_TEST`, vrai modèle du registre — un corps
fabriqué à la volée aurait contourné résolution, rendu, validation des variables
et versionnement, c'est-à-dire quatre étapes qui peuvent casser un envoi réel.

**Observabilité** : `PanelEmailSenderTest` porte l'issue et le retour. Le
webhook Brevo, reconnu par `providerMessageId`, est rattaché au test au lieu
d'être poussé vers un projet inexistant — sans quoi l'écran serait resté
éternellement sur « accepté », la moitié de la réponse qui ne prouve rien.

**États distingués** : `REQUESTED`, `ACCEPTED`, `REFUSED`, `UNKNOWN`,
`DELIVERED`, `BOUNCED`, et `webhookStatus` ∈ {`NOT_APPLICABLE`, `PENDING`,
`RECEIVED`}. `UNKNOWN` (timeout) n'est **jamais** rangé avec « rien n'est
parti » : le confondre ferait renvoyer un message peut-être déjà arrivé.

`GET /api/email-sender/test/:testId` **relit sans renvoyer** — vérifié par test
(compteur d'appels Brevo inchangé).

### 3.6 Exemple de rapport copiable (sans secret)

```
=== TEST D’EXPÉDITION — PANEL ===
status                DELIVERED
environment           TEST
recipient             exploitant@ly-solution.fr
sender name           L.Y Solution
sender email          support@ly-solution.fr
template code         PANEL_EMAIL_SENDER_TEST
operationId           ea64468e-ea1b-4777-a007-4c230b6645d4
deliveryId            ea64468e-ea1b-4777-a007-4c230b6645d4
provider              BREVO
providerMessageId     msg-1@brevo
requested at          2026-08-13T18:33:35.912Z
accepted at           2026-08-13T18:33:36.004Z
last webhook          2026-08-13T18:00:00.000Z (DELIVERED)
delivery status       DELIVERED
webhook status        RECEIVED
error code            —
error message         —

--- journal ---
[PASS] Configuration résolue — L.Y Solution <support@ly-solution.fr>
[PASS] Template résolu — PANEL_EMAIL_SENDER_TEST
[PASS] Capability autorisée — email.send_template
[PASS] Credential Brevo résolu côté Panel — Coffre du Panel
[PASS] Provider accepté — Message pris en charge
[PASS] providerMessageId enregistré — msg-1@brevo
[PASS] Webhook — DELIVERED — 2026-08-13T18:00:00.000Z
[PASS] Livraison confirmée — Remis au destinataire
```

Le rapport est **assemblé par le backend**, jamais recomposé par l'écran : deux
versions du Panel produiraient sinon deux rapports différents pour le même
incident.

### 3.7 Surface HTTP et UI

| Route | Accès | Effet |
|---|---|---|
| `GET /api/email-sender` | tout compte Panel | configuration + environnement + dernier test |
| `PUT /api/email-sender` | **DEV** | enregistre l'expéditeur du parc entier |
| `POST /api/email-sender/test` | **DEV** | envoie un e-mail **réel** |
| `GET /api/email-sender/test/:testId` | tout compte Panel | **relit**, n'envoie rien |

UI unique : `/email-sender` (« Expéditeur e-mail », section Développeur),
sous garde `RequireDev`. Elle affiche la configuration, le bouton d'envoi de
test, le journal `[PASS]/[FAIL]/[PENDING]`, un bouton « Actualiser (n'envoie
rien) », un bouton « Copier le rapport », et le rapport brut sélectionnable —
le `<pre>` reste visible même si le presse-papiers est refusé.

### 3.8 Recette exécutée (B)

`tests/global-email-sender.test.js` — **92 contrôles, 0 échec** :

| Section | Contenu |
|---|---|
| 1 | absence = refus ; aucun repli `.env` (même avec variables posées) ; validations ; secret refusé ; normalisation trim/minuscules |
| 2 | `PROJECT_EMAIL_FROM_CONFIGURATION = 0` (4 champs refusés) ; A, B et le Panel partagent le même `From` ; chacun garde son `Reply-To` ; propagation en un geste |
| 3 | chaîne réelle : clé **du Panel**, `/smtp/email`, aucun `templateId` Brevo, expéditeur global dans le corps, `providerMessageId`, opération partitionnée sur `PANEL_SELF_SCOPE` |
| 4 | webhook `delivered` sur la vraie route publique → `DELIVERED` ; rejeu sans effet ; relecture sans renvoi |
| 5 | rebond `hard_bounce` → `BOUNCED` + motif |
| 6 | refus fournisseur → `REFUSED`, aucun `providerMessageId`, aucun webhook attendu ; destinataires illisibles refusés |
| 7 | aucun secret en base ni dans le rapport (clé, `xkeysib`, en-tête d'autorisation, secret de vérification webhook) ; 17 champs exigés présents |
| 8 | surface HTTP conforme (GET/PUT/POST/GET distincts) |

Non-régression ciblée : `brevo-send-template-foundation.test.js` (81/81),
`brevo-send-delivery-convergence-e2e.test.js` (41/41).

---

## 4. C — Inventaire Yousign (audit livré, migration reportée)

Mesuré sur la baseline, sans modification.

### 4.1 Compteurs AVANT

```
YOUSIGN_LOCAL_RUNTIME_CALLS         4 modules métier importent les services locaux
                                    → 11 méthodes provider / 10 endpoints distincts
YOUSIGN_LOCAL_SECRET_READS          6  (apiKey ×2, baseUrl ×3, webhookSecret ×1)
YOUSIGN_LOCAL_SECRET_WRITES         1  (route générique d'écriture des credentials)
YOUSIGN_LOCAL_CREDENTIAL_UI_INPUTS  2  (apiKey, webhookSecret — formulaire du catalogue)
YOUSIGN_LOCAL_FALLBACKS             2  (SIGNATURE_PROVIDER=stub, deriveYousignBaseUrl)
YOUSIGN_PANEL_CAPABILITIES          2 déclarées, 0 migrées, 0 adaptateurs
YOUSIGN_WEBHOOK_PATHS               2 côté projet (POST /webhooks/yousign, GET .../health)
```

### 4.2 Surface locale (SB Auto)

| Fichier | Rôle |
|---|---|
| `services/yousign/yousign.provider.js` | client HTTP v3, lit `apiKey` + `baseUrl` locaux |
| `services/yousign/yousign.service.js` | orchestration, statuts, vérification webhook HMAC |
| `services/yousign/yousign.stub.js` | provider simulé (`SIGNATURE_PROVIDER=stub`) |
| `services/yousign/yousignCoordinates.js` | mapping zones → champs |
| `services/yousign/yousign.errors.js` | erreurs typées |

Importateurs métier : `contract.service.js`, `contractWebhook.service.js`,
`reconciliation.service.js`, `contractTestTools.service.js`.

Verbes provider : `createSignatureRequest`, `uploadDocumentToSignatureRequest`,
`uploadDocument` (déprécié), `addSigner`, `addField`, `activate`,
`getSignatureRequest`, `getSigner`, `cancelSignatureRequest`,
`deleteSignatureRequest`, `downloadSignedDocument`.

Catalogue : `YOUSIGN` déclare encore `fields: [apiKey, webhookSecret]` — forme
**pré-migration**. Comparaison directe avec Stripe, déjà migré, qui déclare
`authority: 'PANEL', fields: []`.

### 4.3 Ce qui existe déjà côté Panel

- `providerRegistry.YOUSIGN` — définition et portée.
- `webhookRegistry.YOUSIGN` + `providerWebhookAdapters.yousignWebhookAdapter` —
  provisionnement d'endpoint côté plan de contrôle **déjà en place**.
- `capabilityRegistry` : `signature.request.create` (LEGAL_WRITE) et
  `signature.document.download` (READ_ONLY), toutes deux `migrated: false`,
  sans schémas ni adaptateurs.

La migration D consiste donc à **compléter** un plan de contrôle déjà amorcé,
pas à en créer un.

---

## 5. Non-régression exécutée

| Suite | Résultat |
|---|---|
| Panel — suite complète (`tests/run-all.js`) | **115 / 115 fichiers OK**, 0 assertion en échec, sortie 0 |
| Panel — typecheck frontend (`tsc --noEmit`) | **vert** |
| Panel — build frontend (`vite build`) | **vert** |
| Panel — `git diff --check` | **propre** (aucun espace parasite) |
| SB Auto | **non exécutée** — arbre revenu à la baseline, aucune modification |

Deux régressions ont été introduites puis corrigées en cours de lot, toutes deux
dues à des listes de référence qui devaient suivre le code :

1. `brevo-send-template-foundation.test.js` tenait la liste fermée des modèles du
   parc et refusait tout modèle « non déclaré ». L'ajout de
   `PANEL_EMAIL_SENDER_TEST` la faisait échouer — ce qui est exactement le
   travail de ce contrôle. La liste a été mise à jour, pas assouplie.
2. `capability-gateway-e2e.test.js` attendait `SENDER_IDENTITY_MISSING` comme
   motif de refus. La cause a changé de nature : ce n'est plus « ce projet n'a
   pas d'identité » mais « le parc n'a pas d'expéditeur »
   (`PANEL_GLOBAL_SENDER_NOT_CONFIGURED`). L'attente a été corrigée vers le
   nouveau motif, qui est aussi le plus actionnable.

---

## 6. Fichiers modifiés (Panel uniquement)

**Backend**
- `src/models/SystemConfiguration.model.js` — sous-document `email`
- `src/models/PanelProjectSenderIdentity.model.js` — `From` retiré, `Reply-To` conservé
- `src/models/PanelEmailSenderTest.model.js` — **nouveau**
- `src/services/email/panelGlobalSender.service.js` — **nouveau**
- `src/services/email/panelEmailSenderTest.service.js` — **nouveau**
- `src/services/email/panelSenderIdentity.service.js` — résolution `From` global / `Reply-To` projet
- `src/services/email/panelEmailTemplateRegistry.js` — modèle `PANEL_EMAIL_SENDER_TEST`
- `src/services/capabilities/brevoSendAdapter.js` — expéditeur global, `PANEL_SELF`, refus nommés
- `src/services/capabilities/capabilityRegistry.js` — `sender` en sortie de `email.send_template`
- `src/services/capabilities/capabilityGateway.service.js` — source `PANEL_SELF`, partition
- `src/services/capabilities/invocationContext.js` — `PANEL_SELF`, `PANEL_SELF_SCOPE`, `partitionKey`
- `src/services/capabilities/commercialReadiness.service.js` — réclamation, relecture idempotente
- `src/services/integratedApi/commercialReadiness.js` — clé dupliquée retirée
- `src/services/registry/registryStore.js` — écriture conditionnelle
- `src/services/webhooks/emailDeliveryDispatch.js` — routage `PANEL_SELF`
- `src/controllers/emailSender.controller.js` — **nouveau**
- `src/routes/emailSender.routes.js` — **nouveau**
- `src/app.js` — montage `/api/email-sender`

**Frontend**
- `src/pages/EmailSenderPage.tsx` — **nouveau**
- `src/types.emailSender.ts` — **nouveau**
- `src/components/CommercialReadinessCard.tsx` — confirmation par effets prouvés
- `src/lib/api.ts`, `src/App.tsx`, `src/config/nav.ts`, `src/styles.css`

**Tests**
- `tests/commercial-opening-concurrency.test.js` — **nouveau** (29)
- `tests/global-email-sender.test.js` — **nouveau** (92)
- `tests/brevo-send-template-foundation.test.js` — doctrine mise à jour + `PANEL_EMAIL_SENDER_TEST` déclaré dans la liste de référence des modèles
- `tests/brevo-send-delivery-convergence-e2e.test.js` — doctrine mise à jour
- `tests/capability-gateway-e2e.test.js` — le refus « expéditeur manquant » nomme désormais la configuration **globale** (`PANEL_GLOBAL_SENDER_NOT_CONFIGURED`) au lieu de l'identité du projet appelant, qui n'y peut plus rien
- `tests/run-all.js`, `backend/package.json`

---

## 7. Découverte non traitée : le test d'expédition local de SB Auto

**Constat** (baseline, non modifié) :
`backend/src/services/emailConfiguration.service.js :: sendTestEmail` appelle
Brevo **directement** via `sendTransactionalEmail(mode, …)` en lisant une
**clé locale** (`tryGetCredential('BREVO', 'apiKey')`). Ce chemin ne passe ni
par la capacité `email.send_template`, ni par la passerelle, ni par le coffre du
Panel, ni par le registre d'opérations.

C'est le dernier chemin d'envoi du projet qui contourne le plan de contrôle, et
il tombe sous la condition STOP « test mail contourne IntegratedAPI ».

Il est exposé par `POST /email-configuration/test-send`, consommé par
`EmailConfigurationSection.tsx` (Manager) et par la branche `liveTest` de
`emailDiagnostics.service.js`. Son retrait est **couplé à 79 références de
tests** réparties sur 4 suites (`email-configuration.test.js` à lui seul en
porte 62). Il n'a pas été traité dans ce lot — voir §8.

---

## 8. Ce qui a été tenté puis annulé sur SB Auto, et pourquoi

La suppression de la surface `From` de SB Auto a été engagée puis **entièrement
annulée** (`git checkout -- backend/src/`, arbre revenu à `f4e30f3`).

Raison : retirer le `From` local prive `sendTestEmail` (§7) de l'expéditeur qu'il
présente, ce qui le fait échouer systématiquement sur les installations neuves.
Le corriger proprement impose de retirer aussi le test d'expédition local et de
réécrire les suites qui l'éprouvent. Ce chantier ne pouvait pas être mené à son
terme dans ce lot ; le laisser à mi-chemin aurait livré un Manager dont le
bouton « Envoyer un test » échoue toujours.

**Conséquence à connaître** : le Manager de SB Auto expose encore un formulaire
d'expéditeur. Il n'a **plus aucun effet sur le `From` réellement expédié** —
depuis ce lot, le Panel résout l'expéditeur globalement et ignore ce que le
projet stocke. La surface est donc **décorative et trompeuse**, mais elle est
toujours là : l'invariant « aucun Manager ne configure le From » est vrai
**en effet** et faux **en forme**.

---

## 9. Verdict

### 9.1 État des suites

| Suite | Verdict |
|---|---|
| `commercial-opening-concurrency.test.js` | 29 / 29 |
| `global-email-sender.test.js` | 92 / 92 |
| `commercial-readiness.test.js` | 80 / 80 |
| `commercial-readiness-runtime.test.js` | 75 / 75 |
| `capability-preopening.test.js` | 30 / 30 |
| `brevo-send-template-foundation.test.js` | 81 / 81 |
| `brevo-send-delivery-convergence-e2e.test.js` | 41 / 41 |
| `capability-gateway-e2e.test.js` | 66 / 66 |
| **Suite Panel complète** | **115 / 115 fichiers, 0 échec** |
| Typecheck frontend / build frontend | vert / vert |

### 9.2 Réserves

1. **Yousign non migré** (§C/D/E reportés). En conséquence, l'exigence §A4
   « readiness ne doit jamais demander de clé locale Yousign » **n'est pas
   satisfaite côté projet** : `contract.service.js` appelle encore
   `assertProviderReady('YOUSIGN')` sur une clé locale.
2. **Surface `From` de SB Auto non purgée** (§8) — sans effet réel, mais
   présente.
3. **Test d'expédition local de SB Auto** contournant IntegratedAPI (§7).
4. **Code devenu inerte, volontairement conservé.**
   `services/integratedApi/brevo/brevoSenderIdentity.js` exporte encore
   `resolveSenderIdentity`, `describeSenderIdentity` et `validateSenderIdentity`.
   Depuis que le `From` est global, plus aucun appelant d'exécution ne les
   utilise : seul `brevo-control-plane.test.js` les couvre. Ils ne sont **pas**
   supprimés dans ce lot — `assertProjectScope`, du même module, reste la garde
   de portée réellement employée, et la doctrine de purge exige une preuve
   cumulative (aucun lecteur, route, écran, scheduler ni migration dépendante)
   qui n'a pas été établie ici. À trancher en R10.5, avec la suite qui les
   couvre.

### 9.3 Verdict formel

```
R10.4 COMMERCIAL OPENING + GLOBAL EMAIL SENDER + YOUSIGN CONTROL PLANE: PARTIEL
  COMMERCIAL OPENING:                PASS
  GLOBAL EMAIL SENDER CONTROL:       PASS (Panel) / INCOMPLET (purge SB Auto)
  EMAIL TEST + WEBHOOK OBSERVABILITY: PASS
  YOUSIGN CONTROL PLANE MIGRATION:   NON ENTREPRIS (reporté R10.5)
  GO DEPLOYMENT TEST:                NO
  GO DEPLOYMENT PROD:                NOT YET
```

### 9.4 Reste à faire — R10.5

1. Purge de la surface `From` de SB Auto : route `PUT /email-configuration/sender`,
   contrôleur, service, validateur, section Manager, et les suites associées.
2. Retrait du test d'expédition local (§7) au profit du test du Panel, ou son
   passage par `email.send_template`.
3. Migration Yousign complète (C/D/E) : capacités, DTO, ownership avant appel
   fournisseur, idempotence, TEST/PROD, webhooks control plane, documents privés,
   Smart Anchors, diagnostic Panel, purge des credentials morts.
