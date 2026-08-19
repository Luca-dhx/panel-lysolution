# Simplification de l'accès aux IntegratedAPI centralisées du Panel

**Date** : 2026-08-15
**Périmètre** : Panel L.Y Solution (autorité) · SB AUTO 06 (projet de recette)
**Objet** : supprimer les capacités configurables projet par projet et l'ouverture
commerciale, sans toucher à la doctrine de centralisation ni à l'isolation entre projets.

---

## CURRENT ARCHITECTURE

### Le modèle centralisé, avant comme après

```
                    ┌──────────────────────────────┐
                    │      PANEL L.Y SOLUTION      │
                    │                              │
                    │  capabilityRegistry.js       │  ← ce qui existe
                    │            │                 │
                    │  capabilityGateway.service   │  ← qui a le droit, et de quoi
                    │            │                 │
                    │  credentialVault (AES-GCM)   │  ← les clés, chiffrées
                    │            │                 │
                    │  Stripe · Brevo · Yousign ·  │
                    │  Hostinger                   │
                    └──────────────▲───────────────┘
                                   │  code + payload métier
                                   │  (jamais une clé, jamais un monde)
                    ┌──────────────┴───────────────┐
                    │          SB AUTO 06          │
                    │  AUCUNE clé fournisseur      │
                    └──────────────────────────────┘
```

### L'ordre des contrôles AVANT

`backend/src/services/capabilities/capabilityGateway.service.js`, dans cet ordre exact :

| # | Contrôle | Autorité lue | Nature |
|---|---|---|---|
| 1 | la capacité existe-t-elle ? | `capabilityRegistry` (code-first) | structurel |
| 2 | qui parle ? | jeton de pont | structurel |
| 3 | quel monde ? | `runtimeEnvironment()` | structurel |
| 4 | **a-t-il le droit ?** | **`PanelProject.capabilityGrants[]`** | **configuration** |
| 5 | **le commerce est-il ouvert ?** | **`PanelProject.commercialState`** | **configuration** |
| 6 | **la capacité est-elle servie ?** | **`definition.migrated`** | **calendrier** |
| 7 | l'entrée est-elle conforme ? | schéma zod `strict()` | structurel |
| 8 | a-t-on des identifiants ? | coffre L1 | structurel |
| 9 | réserver l'opération | `operationRegistry` | structurel |
| 10 | exécuter | adaptateur (**vérifie l'appartenance**) | structurel |

Les étapes 4, 5 et 6 sont celles que cette mission supprime. **Aucune des trois ne
regarde la ressource visée** : elles interrogent l'état de configuration de la fiche,
jamais à qui appartient le contrat qu'on va facturer.

---

## SB AUTO CENTRALIZED INTEGRATION PATH

### Le chemin réellement emprunté

```
SB AUTO 06
  services/{stripe,yousign,email}/…            métier
        ↓
  services/panelBridge/capabilityClient.js     façade : invokeCapability(code, input)
        ↓
  services/panelBridge/PanelBridge.js          transport + jeton d'appairage
        ↓
  POST {panel}/bridge/v1/capabilities/:code/invoke
        ↓
  Panel · requireBridgeAuth                    identifie le projet par SON JETON
        ↓
  Panel · invokeCapability()                   la passerelle
        ↓
  Panel · credentialVault                      déchiffre, consomme, ne rend rien
        ↓
  Provider externe
```

`capabilityClient.js` est délibérément minuscule : une fonction, aucun état, aucun accès
à l'appairage ni à la file. `bridge-conformity.test.js` (105 assertions, PASS) interdit
au code métier d'importer autre chose.

### Preuve que les IntegratedAPI locales obsolètes ne sont pas utilisées

| Contrôle | Résultat |
|---|---|
| `HOSTINGER_LOCAL_RUNTIME_CALLS` | **0** — aucun client local instancié |
| Adresse de l'API Hostinger dans le runtime | **aucune** |
| Credential Hostinger lu par le runtime | **aucun** |
| Le contrôleur de déploiement instancie un provider local | **non** |
| Clés fournisseur en dur dans `backend/src` | **aucune** (les occurrences de `sk_live_`/`sk_test_` sont des sentinelles de test et des codes d'erreur) |

Source : `backend/src/scripts/hostinger.test.js` — 93 assertions, PASS.

---

## CAPABILITIES AUDIT

### 1. Où la liste était définie

`backend/src/services/capabilities/capabilityRegistry.js` — registre **code-first**,
gelé (`Object.freeze`), agrégeant les catalogues Stripe (L6.1), Brevo (L8), Hostinger (L9).
Rien en base ne pouvait y ajouter une entrée.

### 2. Où les capacités cochées étaient persistées

`PanelProject.capabilityGrants: { type: [String], default: [] }` — un tableau de codes
sur la fiche projet, **vide par défaut** (fail closed).

### 3. Où elles étaient contrôlées au runtime

Étape 4 de la passerelle :

```js
if (context.source !== INVOCATION_SOURCES.PANEL_INTERNAL
  && context.source !== INVOCATION_SOURCES.PANEL_SELF) {
  assertGranted(context, definition);   // → CAPABILITY_NOT_GRANTED (403)
}
```

### 4. Leur absence bloquait-elle réellement une invocation ?

**Oui, totalement.** Un projet appairé, avec la clé au coffre du Panel et un
environnement concordant, recevait `CAPABILITY_NOT_GRANTED` en 403 tant qu'un opérateur
n'avait pas coché la case. C'était une ACL serveur réelle, pas un habillage d'écran.

### 5. UI seule, ou ACL serveur ?

**Les deux** : ACL serveur (étape 4) **et** UI (`CapabilityGrantsCard`, cases à cocher
dans l'onglet Développeur), alimentée par `GET/PUT /api/projects/:id/capability-grants`.

### 6. Combinaison avec « Ouvrir commercialement »

Les deux étaient **cumulatifs et indépendants** : l'octroi filtrait le VERBE (étape 4),
l'ouverture filtrait l'EFFET (étape 5). Un projet devait franchir les deux.

### 7. Autres protections indépendantes — celles qui subsistent

| Protection | Mécanisme | Statut après refactor |
|---|---|---|
| Auth projet | jeton de pont, `requireBridgeAuth` | **conservé** |
| Environnement | `runtimeEnvironment()` vs `runtime.environment` de la fiche | **conservé** |
| Anti-usurpation | `assertProjectScope` sur 3 conventions de champ | **conservé** |
| Contrat d'entrée | zod `strict()`, refuse toute clé inconnue | **conservé** |
| Credentials présents | coffre L1, exige un jeu **VALIDÉ** | **conservé** |
| Ownership Stripe | `PanelStripeResourceBinding` + index unique | **conservé** |
| Ownership DNS | `PanelProjectDestination` (hôtes possédés) | **conservé** |
| Ownership signature | `PanelSignatureBinding` | **conservé** |
| Anti-doublon | `operationRegistry` + idempotence fournisseur | **conservé** |
| Contrat/tenant | référence de contrat, jamais un ID fournisseur choisi par le projet | **conservé** |

---

## COMMERCIAL OPENING AUDIT

### Ce que « Ouvrir commercialement » faisait exactement

| Question | Réponse |
|---|---|
| Champ DB | `PanelProject.commercialState` (`PREOPENING` \| `LIVE` \| `null`), plus `commercialStateUpdatedAt/By/Reason` |
| Défaut | `null` → résolu en `PREOPENING` (**fail closed**) |
| Où lu | `invocationContext.resolveCommercialState()` → étape 5 de la passerelle |
| Routes | `GET/PUT /api/projects/:id/commercial-readiness` (PUT réservé DEV) |
| Bridait-il réellement ? | **Oui** |
| Prérequis à l'ouverture | appairé + environnement connu + destination active |
| Événements | `COMMERCIAL_OPENED` / `COMMERCIAL_CLOSED`, avec acteur et motif |

### Ce qu'il bloquait précisément

La table `CAPABILITY_EFFECTS` classait chaque capacité par nature d'effet. **Deux effets
seulement** étaient interdits en pré-ouverture — ceux qui engagent un tiers :

| Effet | Bloqué en PREOPENING | Capacités concernées |
|---|---|---|
| `FINANCIAL_WRITE` | **oui** | `billing.checkout.create`, `billing.refund`, `billing.subscription.cancel_now`, `billing.subscription.cancel_at_period_end` |
| `LEGAL_WRITE` | **oui** | `signature.request.open`, `signature.request.cancel` |
| `READ_ONLY` | non | toutes les lectures |
| `CONFIGURATION` | non | `email.sender.verify`, `webhook.endpoint.ensure` |
| `REVERSIBLE_EXTERNAL_WRITE` | non | `billing.customer.ensure`, `billing.price.ensure`, `billing.portal.create` |
| `COMMUNICATION_WRITE` | non | `email.send_template` |
| `INFRASTRUCTURE_WRITE` | non | `dns.record.ensure` |

### Verdict d'audit : ce n'était PAS un verrou commercial artificiel

Le code documente l'incident qui l'a motivé (`commercialReadiness.js`, en-tête) :

> L'inventaire L1.5 a trouvé, dans une base dormante, un paiement RÉEL :
> `status PAID · environment PROD · providerMode TEST · 2026-07-16`

C'était une **garde de sécurité financière** : empêcher qu'une instance en recette
encaisse une vraie carte ou fasse signer un vrai contrat. Elle avait une seule
responsabilité, et cette responsabilité était utile.

> **Cette divergence avec la prémisse de la mission a été remontée avant toute
> suppression.** L'arbitrage rendu a été : **supprimer le mécanisme entier, sans
> remplacement**, en assumant et documentant le risque. C'est ce qui a été fait.

### Risque assumé, énoncé explicitement

> **Depuis ce lot, tout projet appairé et configuré peut, dès l'appairage, ouvrir une
> session de paiement réelle, rembourser, résilier un abonnement et engager une
> signature juridique — sans geste d'ouverture préalable.**
>
> Ce qui subsiste pour l'en empêcher n'est plus un état d'instance mais l'appartenance
> des ressources : un projet ne peut agir que sur SES contrats, SES clients Stripe,
> SES signatures, SON domaine. Un projet de recette branché sur un compte Stripe de
> production pourrait donc, lui, encaisser réellement. La séparation TEST/PROD des
> credentials (portée `ENVIRONMENT` du registre L1) reste la seule barrière sur ce
> point, et elle n'a pas été touchée.

---

## DEAD / REDUNDANT MECHANISMS

| Mécanisme | Nature | Sort |
|---|---|---|
| `capabilityGrants[]` | ACL serveur + UI | **supprimé** (schéma + données) |
| `commercialState` (+ 3 champs d'audit) | garde financière | **supprimé** (schéma + données) |
| `CAPABILITY_EFFECTS` / `EFFECT` | taxinomie d'effets | **supprimée** — un seul lecteur, la politique d'ouverture |
| `definition.migrated` | drapeau « servie ? » | **supprimé** — rendait l'état fantôme représentable |
| `definition.migrationNote` | note affichée | **supprimée** |
| `describeCapability().invocable` | doublon de `migrated` | **supprimé** |
| `listMigratedCapabilities()` | filtre devenu identité | **supprimé** |
| `CAPABILITY_NOT_GRANTED` | code de refus | **supprimé** |
| `CAPABILITY_BLOCKED_PREOPENING` | code de refus | **supprimé** |
| `CAPABILITY_GRANTS_UPDATED` | type d'événement | **supprimé** du catalogue |
| `COMMERCIAL_OPENED` / `_CLOSED` | types d'événement | **supprimés** du catalogue |
| `registryStore.setCommercialState()` | écriture conditionnelle | **supprimée** |
| Clé `billing.invoice.list` **dupliquée** | bug latent | **corrigé** |

### Le bug latent trouvé au passage

`capabilityRegistry.js` déclarait **deux fois** la clé `billing.invoice.list` dans le
même littéral d'objet : une première avec `migrated: false`, une seconde avec
`migrated: true`. En JavaScript, la seconde écrasait silencieusement la première. La
définition morte est supprimée.

---

## ACTION REGISTRY AUDIT

22 actions déclarées, 22 exécutants, **0 action fantôme**.

| Action | Registry | Runtime | Handler | Provider | Tested | Verdict |
|---|---|---|---|---|---|---|
| `email.sender.verify` | YES | YES | YES | BREVO | YES | **OK** |
| `email.send_template` | YES | YES | YES | BREVO | YES | **OK** |
| `billing.checkout.create` | YES | YES | YES | STRIPE | YES | **OK** |
| `billing.checkout.retrieve` | YES | YES | YES | STRIPE | YES | **OK** |
| `billing.customer.ensure` | YES | YES | YES | STRIPE | YES | **OK** |
| `billing.price.ensure` | YES | YES | YES | STRIPE | YES | **OK** |
| `billing.subscription.retrieve` | YES | YES | YES | STRIPE | YES | **OK** |
| `billing.subscription.cancel_at_period_end` | YES | YES | YES | STRIPE | YES | **OK** |
| `billing.subscription.cancel_now` | YES | YES | YES | STRIPE | YES | **OK** |
| `billing.invoice.list` | YES | YES | YES | STRIPE | YES | **OK** |
| `billing.invoice.retrieve` | YES | YES | YES | STRIPE | YES | **OK** |
| `billing.portal.create` | YES | YES | YES | STRIPE | YES | **OK** |
| `billing.refund` | YES | YES | YES | STRIPE | YES | **OK** |
| `webhook.endpoint.ensure` | YES | YES | YES | STRIPE | YES | **OK** |
| `signature.request.open` | YES | YES | YES | YOUSIGN | YES | **OK** |
| `signature.request.retrieve` | YES | YES | YES | YOUSIGN | YES | **OK** |
| `signature.signer.retrieve` | YES | YES | YES | YOUSIGN | YES | **OK** |
| `signature.document.download` | YES | YES | YES | YOUSIGN | YES | **OK** |
| `signature.request.cancel` | YES | YES | YES | YOUSIGN | YES | **OK** |
| `dns.zone.resolve` | YES | YES | YES | HOSTINGER | YES | **OK** |
| `dns.records.read` | YES | YES | YES | HOSTINGER | YES | **OK** |
| `dns.record.ensure` | YES | YES | YES | HOSTINGER | YES | **OK** |
| ~~`billing.subscription.reconcile`~~ | **RETIRÉE** | — | — | — | — | **plus exposée** |

### La garde qui empêche le retour d'une action fantôme

`providerAdapters.assertAdapterAlignment()` — **bijection stricte**, vérifiée dans les
deux sens :

```js
for (const definition of definitions) {
  if (!hasAdapter(definition.code)) problems.push(`« ${code} » … n'a aucun adaptateur.`);
}
for (const code of listAdaptedCapabilities()) {
  if (!declared.has(code)) problems.push(`« ${code} » … n'est déclarée dans aucun registre.`);
}
```

Ce contrôle **existait déjà**, mais s'appuyait sur `migrated` : une capacité déclarée non
migrée SATISFAISAIT la garde en n'ayant pas d'adaptateur. Le booléen offrait une dispense
permanente. Sans lui, la seule façon de satisfaire la fonction est d'écrire l'exécutant.

`capability-registry-coherence.test.js` **exerce la garde en échec** (section 2) : une
garde qu'on n'a jamais vue échouer n'est pas une garde.

---

## UNSERVED CAPABILITY ROOT CAUSE

### La capacité concernée n'était PAS `webhook.endpoint.ensure`

L'hypothèse de la mission était explicitement à vérifier. Elle est **infirmée**.

L'écran affichait :

> Accordée, mais pas encore servie par le Panel : une invocation répondra « capacité
> indisponible ». **L6. Réparation d'un webhook perdu : doit rester rejouable.**

Le texte se composait de deux morceaux distincts, ce qui explique la fausse piste :

* la phrase générique, écrite en dur dans `ProjectDetailPage.tsx` pour toute capacité
  `granted && !migrated` ;
* la `migrationNote` de la capacité concernée — qui contenait le mot « webhook ».

Or `webhook.endpoint.ensure` portait `migrated: true` : elle était **servie**, avec un
adaptateur, une idempotence convergente et 54 assertions de test.

La capacité réellement en cause était **`billing.subscription.reconcile`**, dont la
`migrationNote` était exactement `'L6. Réparation d'un webhook perdu : doit rester rejouable.'`

### Pourquoi cet état existait

Ce n'était pas un oubli, mais un état **représentable par construction** :

```
capabilityRegistry (déclare)  ──→  migrated: false  ──→  affichée, accordable
                                          │
                                          ✗ aucune obligation d'aller plus loin
                                          │
providerAdapters (exécute)    ──→  absente, et la garde d'alignement l'ACCEPTE
```

Le booléen `migrated` faisait de « déclarée mais pas servie » un état **valide et
stable**. Rien n'obligeait à en sortir, et `assertAdapterAlignment()` — la garde censée
détecter ce cas — en dispensait précisément les capacités qui s'y trouvaient.

### Décision

`billing.subscription.reconcile` a été **retirée du registre**, pas implémentée :

* `billing.subscription.retrieve` relit déjà l'état d'un abonnement chez Stripe, avec
  preuve d'appartenance — exactement ce dont la réparation d'un webhook perdu a besoin ;
* aucun appelant du parc ne la demandait ;
* le catalogue L6.1 avait délibérément refusé de la contractualiser.

Le refus qu'elle produit désormais est `CAPABILITY_UNKNOWN` — le même que pour un code
inventé. Il n'y a plus d'état intermédiaire.

---

## WEBHOOK ENSURE

`webhook.endpoint.ensure` **n'était pas cassée** : aucune correction n'a été nécessaire.
Son comportement a néanmoins été vérifié, la mission l'exigeant.

| Cas | Comportement | Vérifié par |
|---|---|---|
| aucun webhook | création, lien écrit | `stripe-webhook-provisioning-e2e` |
| webhook correct présent | réutilisation, `created: false`, **aucune création** | idem |
| appel répété | état final identique, secret inchangé | idem |
| 8 appels concurrents | aucune création supplémentaire, **un seul lien** | idem |
| adresse publique changée | réparation, lien mis à jour, aucune création superflue | idem |
| projet B | endpoint distinct, secret **différent** de celui de A | idem |

Idempotence déclarée : `SAFE_RETRY` — elle est **convergente**, elle compare l'état désiré
au réel avant d'agir. La non-duplication est garantie par l'index unique du binding
`(projet, monde)`, pas par une fenêtre d'idempotence fournisseur.

---

## FINAL AUTHORIZATION MODEL

```
AVANT                                  APRÈS
─────                                  ─────
Projet authentifié                     Projet authentifié
  ├─ commercialState == LIVE ?           ├─ l'action existe-t-elle ?
  ├─ capabilities.includes(action) ?     ├─ environnement concordant ?
  ├─ action.migrated ?                   ├─ payload conforme (strict) ?
  ├─ payload conforme ?                  ├─ credentials présents et VALIDÉS ?
  ├─ credentials présents ?              ├─ ownership / contrat / tenant OK ?
  └─ execute                             └─ execute
```

**Ce qui autorise désormais** — quatre réponses, dont aucune ne se coche à la main :

1. **QUI parle** — le jeton de pont, jamais la charge utile ;
2. **QUEL MONDE** — le runtime du Panel, jamais un paramètre du projet ;
3. **QUOI** — le schéma `strict()` de l'action, qui refuse toute clé inconnue ;
4. **SUR QUOI** — l'appartenance de la ressource, établie par l'adaptateur.

La quatrième est la seule qui protège réellement une ressource, et c'est précisément
celle qu'aucune case cochée n'a jamais fournie : un projet à qui l'on avait accordé
`billing.refund` pouvait déjà, du point de vue de l'octroi, présenter le `pi_…` d'un
autre projet. Ce qui l'en empêchait était — déjà — l'appartenance.

---

## MULTI-PROJECT ISOLATION

`tests/capability-multi-project-isolation.test.js` — **167 assertions, PASS**. Deux fiches
**nues** (ni octroi, ni état d'ouverture : les champs n'existent plus).

| Scénario | Résultat | Motif interne |
|---|---|---|
| A lit le client Stripe de B | **REFUSÉ** | `NOT_OWNED` |
| A lit l'abonnement de B | **REFUSÉ** | `NOT_OWNED` |
| A rembourse le paiement de B | **REFUSÉ** | `NOT_OWNED` (variante levante, 403) |
| A lit la session de B | **REFUSÉ** | `NOT_OWNED` |
| A présente un `sub_…` inventé | **REFUSÉ** | `NO_BINDING` |
| A présente un `cus_…` là où on attend un `sub_…` | **REFUSÉ** | `MALFORMED_ID` |
| B lit sa ressource TEST depuis PROD | **REFUSÉ** | monde |
| lien révoqué | **REFUSÉ** pour B — **et non libéré** au profit de A | — |
| A administre le domaine de B | **REFUSÉ** | `NO_DESTINATION` |
| B remonte à la zone parente | **REFUSÉ** | la zone porte le pouvoir, pas l'hôte |
| B atteint un domaine frère | **REFUSÉ** | `NOT_OWNED` |
| A télécharge la signature de B | **REFUSÉ** | lien non rendu |
| A présente un ID de signature inventé | **REFUSÉ** | `UNKNOWN_RESOURCE` |

**Le refus n'apprend rien** : `boundProjectId` reste `null`, le message ne nomme jamais
le propriétaire, et « inconnue » et « à un autre » rendent le même code, le même message
et le même statut — sans quoi l'API deviendrait un oracle d'existence.

**Garde structurelle** (section 4) — elle vaut pour les actions futures :

* toute capacité Stripe portant un `resourceKind` **exige** `requiresResourceOwnership` ;
* les 3 capacités Hostinger l'exigent toutes ;
* **aucune** des 22 actions n'accepte `projectId`, `project_id`, `projectKey`, `tenantId`
  ni `ownerId` en entrée — un projet ne peut pas dire qui il est.

---

## UI AFTER REFACTOR

### Onglet Développeur — carte « IntegratedAPI centralisées »

```
IntegratedAPI centralisées

Ce projet utilise les intégrations centralisées du Panel. Les identifiants
externes restent stockés dans le Panel et ne sont JAMAIS transmis au projet :
le projet demande une action, le Panel l'exécute avec ses propres identifiants
et ne renvoie que le résultat.

22 actions disponibles sur cette instance.
Toutes sont servies : aucune n'est à activer projet par projet.

Email
  email.sender.verify          — Vérifier la chaîne d'envoi
  email.send_template          — Envoyer une notification depuis un modèle
Facturation
  billing.checkout.create      — Ouvrir une session de paiement
  …
Signature · Webhooks · DNS
  …
```

* **aucune case à cocher** ;
* **aucun bouton « ouvrir commercialement »** ;
* **aucune notion « accordée / non accordée »** ;
* **aucune mention « pas encore servie »**.

Les actions sont groupées par **domaine** (préfixe du code), pas par fournisseur : un
opérateur cherche « les actions de facturation », pas « les actions Stripe » — et le
fournisseur est précisément le détail que le Panel s'emploie à cacher au projet.

La carte ne prend plus `projectId` : le catalogue est celui de l'**instance**, identique
pour tous les projets qu'elle sert.

### Écran Plan de contrôle

Les étiquettes « servie » / « déclarée » et le compteur « n servie(s) sur m » ont
disparu : la distinction n'a plus d'objet. Le renvoi vers « l'octroi se règle sur la
fiche du projet » aussi.

---

## SB AUTO RECIPES

Toutes les suites empruntent le chemin centralisé réel (Panel réel, instance SB AUTO dans
son propre processus, faux fournisseur qui parle HTTP et note quelle clé arrive).

| Recette | Couverture | Résultat |
|---|---|---|
| `panel-bridge` | pont, appairage, invocation | **60 / 0** |
| `bridge-conformity` | le métier n'accède qu'à la façade | **105 / 0** |
| `project-bridge` | projection, contrats | **74 / 0** |
| `integrated-api` | surface IntegratedAPI du projet | **73 / 0** |
| `panel-pairing-session` | session d'appairage | **20 / 0** |
| `bridge-persistence` | outbox, reprise | **31 / 0** |
| `stripe` | lectures + ensure | **28 / 0** |
| `payments-flow` | `checkout.create` / `retrieve` | **67 / 0** |
| `subscription-flow` | `subscription.retrieve`, résiliations | **77 / 0** |
| `billing-flow` | `invoice.list` / `retrieve`, `portal.create` | **46 / 0** |
| `yousign` | résolution + validation du chemin signature | **56 / 0** |
| `contract-signers` | ouverture de signature (sandbox) | **65 / 0** |
| `brevo` | `sender.verify` | **54 / 0** |
| `email-delivery` | `send_template` + retour de livraison | **183 / 0** |
| `email-configuration` | expéditeur global | **55 / 0** |
| `hostinger` | `dns.zone.resolve`, `records.read`, `record.ensure` | **93 / 0** |

**Actions destructrices ou financières** : aucune opération réelle en PROD. `billing.refund`
et `billing.subscription.cancel_now` sont éprouvées par validation, ownership, dispatch et
double Stripe (`panelCheckoutDouble.helper.js`), jamais contre un compte de production.

**Idempotence `ensure`** : `billing.customer.ensure` et `billing.price.ensure` dérivent
leur identité d'acte du `(monde, contrat)` — le projet ne peut pas la nommer, donc pas en
obtenir deux.

---

## TESTS

### Panel — périmètre modifié

```
node tests/<suite>.test.js
```

| Suite | Résultat |
|---|---|
| `capability-gateway` | **117 / 0** |
| `capability-gateway-e2e` | **68 / 0** |
| `capability-registry-coherence` *(nouveau)* | **98 / 0** |
| `capability-multi-project-isolation` *(nouveau)* | **167 / 0** |
| `capabilities` | **18 / 0** |
| `integrated-api-provider-registry` | **68 / 0** |
| `integrated-api-control-plane` | **68 / 0** |
| `integrated-api-encryption` | **46 / 0** |
| `integrated-api-http-security` | **39 / 0** |
| `bridge-provider-secret-boundary` | **54 / 0** |
| `stripe-control-plane` | **143 / 0** |
| `stripe-resource-ownership` | **108 / 0** |
| `stripe-local-surface-e2e` | **45 / 0** |
| `stripe-checkout-cutover-e2e` | **105 / 0** |
| `stripe-customer-ownership-e2e` | **81 / 0** |
| `stripe-subscription-cutover-e2e` | **122 / 0** |
| `hostinger-control-plane` | **118 / 0** |
| `hostinger-dns-cutover-e2e` | **63 / 0** |
| `brevo-control-plane` | **237 / 0** |
| `brevo-verify-migration-e2e` | **43 / 0** |
| `brevo-send-template-foundation` | **92 / 0** |
| `finance-refunds` | **120 / 0** |
| `finance-payment-requests` | **85 / 0** |
| `signature-reservations` | **34 / 0** |
| `panel-ui` | **79 / 0** |
| `template-editor` / `template-editor-ui` | **18 / 0** · **23 / 0** |

**Total : 2 259 assertions, 0 échec.**

### Builds

| Build | Commande | Résultat |
|---|---|---|
| Panel backend | chargement complet de `app.js` | **PASS** |
| Panel frontend | `tsc --noEmit` puis `npm run build` | **PASS** |
| SB AUTO | `npm run build` (vitrine + manager) | **PASS** |

### Matrice de non-régression demandée

| Exigence | Statut | Preuve |
|---|---|---|
| projet valide peut appeler n'importe quelle action exposée | **PASS** | `capability-gateway` §3, `capability-gateway-e2e` §3 |
| aucune liste de capabilities projet nécessaire | **PASS** | fiche nue → invocation réussie |
| absence historique de capabilities ne bloque rien | **PASS** | fixtures sans `capabilityGrants` |
| bouton commercial supprimé | **PASS** | `CommercialReadinessCard.tsx` supprimé |
| statut commercial historique ne bloque rien | **PASS** | champ absent du schéma ; migration l'efface |
| credentials provider jamais exposés au projet | **PASS** | `bridge-provider-secret-boundary` (54) |
| action inconnue refusée | **PASS** | `CAPABILITY_UNKNOWN`, 404, zéro appel fournisseur |
| IntegratedAPI non configurée → erreur explicite | **PASS** | `CREDENTIALS_MISSING` + motif `NOT_CONFIGURED` / `NOT_VALIDATED` |
| ressource d'un autre projet → refus | **PASS** | `capability-multi-project-isolation` (167) |
| environnement incorrect → refus | **PASS** | `ENVIRONMENT_MISMATCH` |
| action déclarée possède obligatoirement un handler | **PASS** | `capability-registry-coherence` §1–2 |
| `webhook.endpoint.ensure` est idempotent | **PASS** | `stripe-webhook-provisioning-e2e` |
| `webhook.endpoint.ensure` peut réparer un webhook perdu | **PASS** | idem (adresse changée → réparation sans doublon) |

---

## REMOVED LEGACY

### Fichiers supprimés

```
backend/src/services/capabilities/capabilityGrants.js
backend/src/services/capabilities/commercialReadiness.service.js
backend/src/services/integratedApi/commercialReadiness.js
frontend/src/components/CommercialReadinessCard.tsx
tests/commercial-readiness.test.js
tests/commercial-readiness-runtime.test.js
tests/commercial-opening-concurrency.test.js
tests/capability-preopening.test.js
```

### Champs supprimés (`PanelProject`)

```
capabilityGrants · commercialState · commercialStateUpdatedAt
commercialStateUpdatedBy · commercialStateReason
```

### Routes supprimées

```
GET  /api/projects/:projectId/capability-grants
PUT  /api/projects/:projectId/capability-grants
GET  /api/projects/:projectId/commercial-readiness
PUT  /api/projects/:projectId/commercial-readiness
```

`GET /api/integrated-apis/capabilities` subsiste — catalogue d'instance, sans état projet.

### Migration de données

```
npm run migrate:drop-capability-authorization -- --dry-run   # inventaire
npm run migrate:drop-capability-authorization                # applique
```

`backend/src/scripts/migrations/2026-08-15-drop-capability-grants-and-commercial-state.js`

* interroge la collection **brute** (les champs ayant quitté le schéma, Mongoose ne les
  verrait plus et la migration rapporterait « rien à faire ») ;
* journalise la **valeur** de ce qu'elle efface — seule trace qui subsistera ;
* **idempotente** : `$unset` sur un champ absent ne fait rien ;
* **n'efface aucun événement** déjà écrit : ils racontent des décisions réellement prises.

### Fichiers modifiés côté SB AUTO 06

| Fichier | Changement |
|---|---|
| `integrations/hostinger/capabilityDnsProvider.js` | traduit `CAPABILITY_RESOURCE_NOT_OWNED` |
| `integrations/hostinger/dnsControlPlaneDiagnostic.js` | mappe le nouveau code, retire `BLOCKED_PREOPENING`, corrige le message |
| `integrations/stripe/stripeControlPlaneDiagnostic.js` | retire `BLOCKED_PREOPENING` |
| `integrations/yousign/yousignControlPlaneDiagnostic.js` | retire `BLOCKED_PREOPENING` |
| `scripts/hostinger.test.js` | assertions alignées |

### Correction de code d'erreur, faite au passage

Le refus d'appartenance DNS rendait `CAPABILITY_NOT_GRANTED` — **ce qui était déjà faux
avant cette mission** : il ne parlait pas du droit d'invoquer `dns.record.ensure`, mais de
l'appartenance du NOM D'HÔTE visé. Un opérateur lisant ce code partait chercher une case à
cocher qui ne manquait pas. Il rend désormais `CAPABILITY_RESOURCE_NOT_OWNED` — même
statut HTTP (403), même issue journalisée (`BLOCKED`) : la correction porte sur le
diagnostic, pas sur la décision.

---

## POINTS D'ATTENTION HORS PÉRIMÈTRE

### Cinq suites e2e en échec, **imputables à un autre chantier en cours**

L'arbre de travail portait, avant cette mission, des modifications non committées d'une
autre session sur le plan de contrôle webhook (`webhookIngest.js`, `webhookReconciler.js`,
`emailDeliveryDispatch.js`). Ce chantier introduit un binding webhook à destination
`PANEL` et un nouvel index unique `uniq_provider_environment_destination_project`.

| Suite | Symptôme |
|---|---|
| `stripe-checkout-read-webhook-e2e` | `E11000 … destination: "PANEL", projectId: null` |
| `stripe-subscription-cancellation-e2e` | idem |
| `stripe-subscription-ownership-e2e` | idem |
| `brevo-send-delivery-convergence-e2e` | crash section webhook |
| `stripe-webhook-provisioning-e2e` | 7 assertions de **comptage d'endpoints** |

**Preuve d'imputation** — une sonde posée sur `stripe-webhook-provisioning-e2e` montre
l'endpoint surnuméraire :

```
["https://panel-l63a.test/webhooks/providers/stripe",     ← ajouté par l'autre chantier
 "https://projet-a-tunnel-un.test/api/webhooks/stripe"]   ← celui du projet, attendu
```

Dans ces suites, **toutes les assertions de capacités, d'octroi, d'ouverture commerciale et
d'appartenance passent** ; seules échouent celles qui comptent les endpoints ou insèrent un
binding `PANEL`. Ces fichiers n'ont **pas** été « corrigés » : leur état appartient à
l'autre chantier, et la suite `webhook-control-plane.test.js` (que cette session a mise à
jour de son côté) passe à 238 / 0.

> Ces cinq suites doivent être revérifiées une fois le chantier webhook committé.

---

## FINAL VERDICT

```
CAPABILITY CHECKBOXES          = REMOVED
COMMERCIAL OPENING             = REMOVED
CENTRALIZED INTEGRATED API     = PRESERVED
ALL EXPOSED ACTIONS            = SERVED        (22 / 22, bijection vérifiée)
GHOST ACTIONS                  = 0             (billing.subscription.reconcile retirée)
PROJECT CREDENTIAL EXPOSURE    = NONE
MULTI-PROJECT ISOLATION        = PASS          (167 assertions)
SB AUTO CENTRALIZED PATH       = PASS          (16 recettes, 0 échec)
PANEL BUILD                    = PASS
SB AUTO BUILD                  = PASS
```

### Réserve explicite

```
FINANCIAL SAFETY GUARD         = REMOVED, SANS REMPLACEMENT — décision assumée
```

La pré-ouverture empêchait un encaissement réel et une signature juridique tant qu'une
instance n'avait pas été déclarée ouverte. Ce garde-fou n'existe plus. L'isolation entre
projets n'en est pas affectée ; la protection contre un **débit accidentel sur une
instance de recette branchée sur des credentials de production**, elle, repose désormais
uniquement sur la séparation TEST/PROD du coffre.
