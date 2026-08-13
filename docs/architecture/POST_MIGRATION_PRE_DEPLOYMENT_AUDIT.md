# R10.0 — POST-MIGRATION PRE-DEPLOYMENT AUDIT

> Audit **uniquement**. Aucun déploiement, aucun redémarrage, aucune donnée de
> production touchée, aucune correction appliquée.
>
> **Révision 2** — la révision 1 concluait `BLOCKED` sur un faux positif
> (« `shared/storage` non persistant côté Panel »). Ce blocker est **retiré** :
> réfutation au §P, cause de l'erreur au §AH. Verdict recalculé au §AG.

---

## A. HEAD / upstream / worktrees

| dépôt | HEAD | upstream | clean | ahead/behind | verdict |
|---|---|---|---|---|---|
| Panel | `6184e37` | `6184e37` | ✅ | 0 / 0 | **OK** |
| SB Auto | `9ae2c50` | `9ae2c50` | ✅ | 0 / 0 | **OK** |

Les deux HEAD correspondent aux baselines annoncées. Aucun fichier modifié,
aucun fichier non suivi, aucun travail parallèle. **Aucun UNKNOWN.**

---

## B. Matrice des responsabilités

| domaine | autorité | runtime autorisé côté projet | constaté |
|---|---|---|---|
| Stripe | **Panel** | vérification de signature webhook (`whsec_`) | ✅ conforme |
| Hostinger | **Panel** | aucun | ✅ conforme |
| Brevo — **envoi métier** | **Panel** | aucun transport local | ✅ conforme |
| Brevo — test admin / quota / webhook local | **projet** | clé locale `apiKey` | ⚠️ voir §E |
| Yousign | **projet** | `apiKey` + `webhookSecret` | ✅ inchangé, hors périmètre migration |
| Médias publics | protocole Media | `uploads/`, servis | ✅ |
| Médias privés | protocole Media privé | `storage/`, jamais servis | ✅ code / ❌ persistance Panel (§P) |
| Finances | **Panel** | projection/lecture | ✅ |

**Réponses explicites**

1. **Providers encore consommés directement par SB Auto** : Yousign (signature),
   Brevo (test admin, quota opérationnel, configuration webhook local).
   **Ni Stripe, ni Hostinger.**
2. **Credentials locaux légitimement requis** : `YOUSIGN.apiKey`,
   `YOUSIGN.webhookSecret`, `BREVO.apiKey` (chemins non métier), 
   `BREVO.webhookSecret` (facultatif, en-tête partagé).
3. **Credentials qui doivent être absents** : `STRIPE.secretKey` (retirée du
   catalogue, `authority: PANEL`, `fields: []`), tout credential Hostinger
   (`fields: []`).
4. **Secrets de vérification, jamais d'appel** : `STRIPE.webhookSecret` — hors
   catalogue de saisie, alimenté uniquement par le provisioning du Panel, lu par
   `verifyStripeWebhookAnyMode`, ne permet aucun appel.
5. **Providers absents du dépôt** : aucun SDK Stripe (`package.json` et
   lockfile), aucun client Hostinger local.

---

## C. Surface Stripe locale (SB Auto)

| compteur | valeur |
|---|---|
| `STRIPE_SDK_RUNTIME_IMPORTS` | **0** — absent de tous les `package.json` et du lockfile |
| `LOCAL_STRIPE_BUSINESS_CALLS` | **0** |
| `LOCAL_STRIPE_PROVIDER_METHODS` | **0** — pilote supprimé en L6.3C |
| `LOCAL_STRIPE_FALLBACKS` | **0** |
| `LOCAL_STRIPE_API_ENDPOINT_REFERENCES` | **0** en runtime |
| `LOCAL_STRIPE_CALL_SECRET_READS` | **0** |
| `LOCAL_STRIPE_CALL_SECRET_WRITES` | **0** — `authority: PANEL` refuse l'écriture |
| `LOCAL_STRIPE_CREDENTIAL_UI_INPUTS` | **0** — `fields: []` |

Toutes les occurrences `sk_test_` / `sk_live_` restantes sont des **sentinelles
de test** (fixtures prouvant qu'une clé est refusée, masquée ou non exposée).

`stripe.service.js` ne conserve que : vérification HMAC du webhook, mapping de
statuts, metadata d'audit. Aucun repli sur l'autre monde.

**Diagnostic / readiness** : passe par le plan de contrôle, ne demande aucune
clé locale, ne traite pas son absence comme une erreur.

Preuves : `stripe-local-surface` 71/71, `stripe-final-control-plane-cutover`
49/49, `dead-provider-credentials-purge` 61/61.

### ⚠️ Défaut mineur relevé

`backend/src/services/stripe/stripe.service.js:228-230` :

```js
export function _resetStub() { stubSingleton = null; }
```

`stubSingleton` **n'est déclaré nulle part** dans ce fichier — vestige du double
de test supprimé en L6.3C. En module ES (mode strict), un appel lèverait
`ReferenceError`. **Aucun appelant n'existe** (seul `yousign.service.js`, qui a
sa propre déclaration valide, est appelé par sa recette).

- Risque : **NUL en exécution** (code mort inatteignable).
- Cause racine : suppression incomplète du pilote en L6.3C.
- Correctif minimal : supprimer les trois lignes. **Non bloquant.**

---

## D. Surface Hostinger locale (SB Auto)

| compteur | valeur |
|---|---|
| `HOSTINGER_LOCAL_RUNTIME_CALLS` | **0** |
| `HOSTINGER_LOCAL_CLIENTS` | **0** |
| `HOSTINGER_LOCAL_CREDENTIAL_READS` | **0** |
| `HOSTINGER_LOCAL_CREDENTIAL_WRITES` | **0** |
| `HOSTINGER_LOCAL_UI_SECRET_FIELDS` | **0** (`fields: []`) |

Ce qui subsiste : `capabilityDnsProvider.js` (client de **capacité**, pas de
fournisseur), la taxonomie d'erreurs, et deux URL de **documentation** dans le
catalogue. Le chemin `DeploymentEngine → capability → Panel → credential global
→ Hostinger` est le seul.

Preuve : `hostinger.test.js` vérifie statiquement l'absence de
`HostingerClient` / `HostingerDnsProvider` / `resolveHostingerProvider`.

---

## E. Cutover Brevo

| fichier / service | usage | statut |
|---|---|---|
| `emailDelivery.service.js` | **envoi métier** | ✅ **MIGRATED** |
| `emailReadiness.service.js` | readiness métier | ✅ **MIGRATED** — ne vérifie plus la clé locale |
| `emailConfiguration.service.js` | test admin DEV | ⚠️ **LOCAL** (par conception) |
| `brevoOperational.service.js` | quota / état | ⚠️ **LOCAL** |
| `brevoWebhookConfig.service.js` | config webhook du compte local | ⚠️ **LOCAL** |
| `brevoEmail.service.js` | driver transport | ⚠️ **LOCAL**, un seul consommateur runtime |

Le chemin **métier** est prouvé propre :

```
 sendTemplate() → controlPlane.invoke('email.send_template')
   → Panel : template Panel · sender Panel · credential Panel → Brevo
```

Aucun import du driver local, aucun `fetch`, aucune clé, aucun repli.
`operationId = deliveryId`, `providerMessageId` retourné, `EMAIL_DELIVERY_EVENT`
appliqué **sur push ET sur pull**, transitions centralisées (pas de régression
`DELIVERED → SENT`).

### ⚠️ Conséquence de déploiement à connaître

`emailConfiguration.service.js` lit encore `BREVO.apiKey` **locale**, et
`deriveStatus()` renvoie `NOT_CONFIGURED` quand elle est absente.

Sur une instance déployée **sans clé Brevo locale** :

- l'envoi **métier fonctionne** (il passe par le Panel) ;
- l'écran « Configuration e-mail » du Manager affiche **« Non configuré »** ;
- le bouton « Envoyer un e-mail de test » échoue en `API_KEY_MISSING`.

Ce n'est **pas** une régression fonctionnelle du métier, et **pas** un credential
mort requis au boot (rien n'échoue au démarrage). C'est une **incohérence
d'affichage** : un opérateur pourrait conclure que l'e-mail est cassé alors qu'il
fonctionne.

- Risque : **MOYEN** (confusion opérateur, pas de perte).
- Correctif minimal recommandé : soit renseigner la clé Brevo locale du compte de
  test, soit un lot qui distingue « envoi métier (plateforme) » de « test local »
  dans `deriveStatus`. **Non bloquant.**

---

## F. Contrat de bridge

| contrôle | résultat |
|---|---|
| `PanelBridge.openapi.yaml` Panel ↔ SB Auto | **byte-identique** |
| `ProjectBridge.openapi.yaml` Panel ↔ SB Auto | **byte-identique** |
| `SYNC_ENTITY_TYPES` | **18 / 18, identiques dans le même ordre** |
| `CONTRACT_VERSION` | `1.5.0` des deux côtés |
| types appliqués absents du contrat | **aucun**, des deux côtés |

**Symétrie push / pull (SB Auto)** — aucun type enregistré d'un seul côté :

| type | `changeAppliers` (push) | `applyHandlers` (pull) |
|---|---|---|
| `DEV_COMPANY` | ✅ | ✅ |
| `INTEGRATED_API_CONFIG` | ✅ | ✅ |
| `EMAIL_DELIVERY_EVENT` | ✅ | ✅ |
| `PAYMENT_REQUEST` | ✅ | ✅ |
| `PAYMENT_DEFAULT_CAUSE` | ✅ | ✅ |
| `PAYMENT_DEFAULT_INCIDENT` | ✅ | ✅ |

`CONTRACT` et `PROJECT_SITE_STATUS` circulent en sens inverse (projet → Panel) et
sont appliqués côté Panel. **Aucun spec-drift.**

---

## G. Pairing / readiness / control plane

| question | réponse |
|---|---|
| preuve d'appairage | `capabilitiesAvailable()` — appairage hydraté depuis Mongo |
| monde sélectionné | `resolveProviderEnvironment(provider)`, une seule porte |
| Panel indisponible | refus **explicite** `PROVIDER_NOT_CONFIGURED` : « les e-mails sont envoyés par la plateforme, et elle est injoignable » |
| capacité manquante | `CAPABILITY_NOT_GRANTED`, refus franc |
| credential global absent | `CAPABILITY_CREDENTIALS_MISSING`, refus franc |
| message réclamant une clé locale morte | **non** pour Stripe/Hostinger ; **oui** pour Brevo (§E) |
| clé locale historique influençant la readiness | **non** sur le chemin métier |
| fallback local silencieux | **non** — aucun `try capability / catch local` |

---

## H. Catalogue IntegratedAPI (SB Auto)

| provider | authority | champs locaux | lus en runtime | écriture | pourquoi |
|---|---|---|---|---|---|
| STRIPE | **PANEL** | *(aucun)* | `webhookSecret` (hors catalogue, vérification seule) | **refusée** | encaissements centralisés |
| HOSTINGER | **PANEL** | *(aucun)* | aucun | **refusée** | DNS centralisé |
| BREVO | projet | `apiKey` (requis), `webhookSecret` (facultatif) | oui — chemins non métier | autorisée | test/quota/webhook local |
| YOUSIGN | projet | `apiKey`, `webhookSecret` | oui | autorisée | signature non migrée |

Purge des credentials morts confirmée par `dead-provider-credentials-purge`
61/61, recoupée avec les lecteurs runtime (pas seulement le catalogue).

---

## I. Séparation TEST / PROD

| domaine | où le monde est décidé | dérive possible ? |
|---|---|---|
| Stripe | Panel (runtime de l'instance) ; projet : `resolveProviderEnvironment` pour la seule vérification | non |
| Brevo | idem ; deux comptes distincts | non |
| Hostinger | Panel | non |
| Yousign | mode local | non |
| Finances | `environment` **persisté** sur chaque fait et chaque binding | non |
| Media | sans objet | — |
| Bridge | `environment` dans l'identité d'appairage | non |

- `activeMode` **révoqué** (`active-mode-revoked` 26/26) : plus de bascule.
- `verifyStripeWebhookAnyMode` **n'essaie plus l'autre monde** — un événement
  non vérifiable ici n'est pas à nous.
- L'unicité des bindings inclut `environment` : un `cus_` TEST ne peut pas être
  servi à une capacité PROD.
- Le ledger persiste `provenance.provider` + `provenance.environment`.

**Aucun fallback TEST↔PROD implicite.**

---

## J. Environnement SB Auto

Requis au boot : `ENV` (fail-closed, TEST|PROD), `MONGODB_URI`, `DB_TEST`/`DB_PROD`,
`JWT_SECRET`. **Aucun secret fournisseur requis au démarrage.**

- Variable morte : `STRIPE_PROVIDER` — présente **en commentaire** dans
  `.env.example` et dans deux documents. **Aucun lecteur runtime.** Dette
  documentaire, **non bloquante**.
- `SIGNATURE_PROVIDER=stub` reste **vivant** (Yousign non migré).

---

## K. Environnement / secrets Panel

Requis au boot : `ENV`, `MONGODB_URI`, `DB_*`, `JWT_SECRET` (≥ 32, placeholders
refusés), `JWT_EXPIRES_IN`, `BRIDGE_ENCRYPTION_KEY` (64 hex, **≠** `JWT_SECRET`),
et en PROD des identifiants seed forts.

**Aucun secret fournisseur en variable d'environnement** : les credentials
Stripe / Brevo / Hostinger vivent chiffrés en base (jeux d'identifiants), donc
rotables sans redéploiement.

Amorçages au boot, tous **non bloquants** avec repli documenté :
jeux d'identifiants, modèles d'e-mail, réconciliation des webhooks.

---

## L. Stripe ownership / bindings

Index unique `{ environment, resourceType, resourceId }` — arbitré par la base.
`revokedAt` **neutralise sans libérer** : aucune réattribution possible.
Aucun `projectId` mutable, aucune suppression douce.

| classe | contenu |
|---|---|
| `SAFE_EXISTING_DATA` | tout objet créé **par le Panel** depuis L6.2B (binding posé à la création) |
| `NEEDS_CONVERGENCE` | objets appris par webhook (`learned.derivedFrom*`, `customerCorroborated`) — convergence automatique |
| `NEEDS_MANUAL_ADOPTION` | Customers / Subscriptions **antérieurs** à la centralisation, sans binding : une capacité les refusera (`ownership`) tant qu'ils ne sont pas adoptés |
| `UNSUPPORTED_HISTORY` | aucun cas identifié |

⚠️ **À vérifier en recette** : le contrat de démonstration actuel a été créé
**avant** la centralisation. Son `customerId` / `subscriptionId` Stripe peut ne
pas avoir de binding — le portail de facturation et la résiliation seraient alors
refusés jusqu'à adoption. **Risque MOYEN, à confirmer sur données réelles.**

---

## M. Provisioning du webhook Stripe

Chaîne auditée sans créer d'endpoint : Panel provisionne → secret livré par le
**canal étroit** → stocké côté projet → `verify raw body` → ingestion.

- `/api/webhooks` monté **avant** `express.json()` — corps brut disponible. ✅
- Canal étroit : n'accepte **qu'un** rôle `verificationOnly` de forme `whsec_…`,
  un champ et un seul ; un `sk_` y est refusé. ✅
- Canal générique de capacités : `assertNoProviderSecrets` refuse tout secret. ✅
- Un seul monde essayé à la vérification. ✅

⚠️ **Plafond de webhooks par compte Stripe** : le provisioning crée un endpoint
par projet. Stripe limite le nombre d'endpoints par compte (16 en pratique).
Au-delà, le provisioning échouera. **Risque FAIBLE au parc actuel**, à surveiller.

---

## N. Financial ledger

- Montants **entiers**, stockés **positifs**, signe dérivé du `flow`.
- Taxonomie `INFLOW/OUTFLOW` × `REVENUE/COST/REFUND/ADJUSTMENT`.
- Index uniques **partiels** et disjoints :
  - `{ sourceId, cycleKey }` — occurrences récurrentes ;
  - `{ provenance.provider, provenance.environment, provenance.externalId }` —
    faits fournisseur.
  Les saisies manuelles ont ces champs à `null` et restent **hors index** : aucune
  collision `(null, null)`, aucun conflit entre familles.
- Un remboursement est une transaction **OUTFLOW / REFUND** distincte : elle
  diminue le net et **n'augmente pas** les coûts.

Preuves : `finance-core` 178/178, `finance-recurring` 138/138,
`finance-stripe-revenue` 105/105, `finance-refunds` 142/142.

---

## O. Médias privés

- `PUBLIC` → `uploads/`, servi par `express.static` + Nginx `location /uploads/`.
- `PRIVATE` → `storage/media`, **jamais** monté en statique, **aucun**
  `location` Nginx, téléchargement par route authentifiée uniquement.
- Pas de réencodage des documents, `originalFilename` conservé.

Le code **et** la persistance sont corrects des deux côtés — voir §P.

---

## P. Persistance de déploiement

> **RECTIFICATIF — cette section a été corrigée.** Une première rédaction y
> concluait à un blocker (« `shared/storage` non persistant côté Panel »). Ce
> blocker était un **FAUX POSITIF**, retiré ci-dessous avec sa réfutation. Voir
> §AH pour la cause de l'erreur d'audit.

### Le Panel et les projets partagent le MÊME moteur — ✅

`deploy/deploy.mjs:239-241` :

```js
if (executeMode) return execute(deployConfig, { mode });   // ← EXÉCUTION RÉELLE
printPlan(buildPlan(deployConfig, { releaseId: id }));      // ← SIMULATION seule
```

`execute()` (`deploy.mjs:86-147`) délègue **intégralement** au
`DeploymentEngine` — le même que pour les projets — via
`engine.deploy()` → `runPipeline()` → `pipeline.js`.

`buildPlan` / `buildRollbackPlan` (`deploy/lib/plan.mjs`) **ne servent qu'au
`--dry-run`**. Ils ne s'exécutent jamais sur un serveur.

### Le layout réellement déployé

`topology.js:116-179` — aucune notion de release :

```
 /var/www/<host>/
 ├── backend/                      chemin STABLE, uploadé en place
 │   ├── uploads -> ../shared/uploads
 │   └── storage -> ../shared/storage
 └── shared/
     ├── uploads/
     └── storage/contracts/
```

`pipeline.js` ne contient **aucune** occurrence de `releases`, `current` ou
`prune`. Le lien est reposé à chaque déploiement (`pipeline.js:177`) :

```
 rm -rf ${backendDir}/uploads ${backendDir}/storage
 && ln -sfn ${sharedUploads} ${backendDir}/uploads
 && ln -sfn ${sharedRoot}/storage ${backendDir}/storage
```

et le partagé est créé avant (`pipeline.js:142` et `:178`) :
`mkdir -p ${sharedRoot}/storage/contracts`.

`process.cwd()` sous PM2 vaut donc `/var/www/<host>/backend`, où `storage` est
un lien vers `shared/storage`. `config.paths.privateMedia` pointe bien dans le
partagé persistant, **sans que le code métier connaisse le lien**.

### L'invariant était déjà gardé par un test

`tests/finance-receipts.test.js:483-485`, livré avec **L10.2** :

```
 ✓ 1. le déploiement lie `backend/storage` au partagé persistant
 ✓ …et crée le dossier partagé
```

`finance-receipts` : **105/105**, dans la suite complète.

### Conclusion

| propriété | valeur |
|---|---|
| `PANEL_SHARED_UPLOADS_PERSISTENCE` | **YES** |
| `PANEL_SHARED_STORAGE_PERSISTENCE` | **YES** |
| `PRIVATE_MEDIA_RELEASE_COUPLED` | **NO** |
| `PRIVATE_MEDIA_PUBLICLY_SERVED` | **NO** |

Aucune perte possible : il n'y a ni release à laquelle coupler les fichiers, ni
prune susceptible de les supprimer. Le commentaire de
`privateMedia.service.js:44-47` — « `<backend>/storage` est un LIEN SYMBOLIQUE
vers `shared/storage`, posé à chaque release par le pipeline » — **dit vrai**.

**Aucun correctif de persistance n'est requis.**

---

## Q. Projection des revenus

Hiérarchie canonique respectée : facture d'abonnement → **invoice** ;
checkout non facturé → **session** ; `payment_intent` / `charge` →
corroboratifs. Un paiement = **une** transaction (index unique de provenance),
identifiants Stripe visibles dans « Détails », `invoiceId` / `hostedInvoiceUrl` /
PDF présents quand Stripe les fournit. Environnement et fournisseur persistés.
**Aucun quadruple comptage.**

Facture arrivant avant l'ownership : conservée comme fait non projeté, exposée
par `/provider-revenue/unprojected` (DEV), rejouée à la convergence horaire.

---

## R. Refunds

Le revenu original **n'est jamais muté** ; le remboursement est une transaction
`OUTFLOW/REFUND` distincte, liée au paiement qu'elle défait. Partiel et total
supportés, idempotence durable par identité `re_…`, `UNKNOWN` jamais rejoué
(« un doublon invisible est pire qu'un trou visible »).

Absence légitime de « facture de remboursement » automatique : Stripe n'en émet
pas pour un `refund` seul. **Toujours vraie.**

---

## S. Payment requests / prestations

Chaîne conforme : le Panel fige HT / taux / TVA / TTC à la création ; le projet
n'envoie **aucun montant** ; `taxRate` absent = refus explicite ; le snapshot
fiscal est immuable ; **aucune écriture au ledger avant `invoice.paid`** ; une
prestation ponctuelle **n'ouvre jamais** de `PaymentDefault`
(`NOT_A_SUBSCRIPTION` structurel).

**Réserve « session ouverte après annulation »** — classée
**`ACCEPTED_RISK`** : le cas est explicitement traité (`markPaidFromFact`), le
paiement tardif est projeté comme revenu réel et la demande passe `PAID` avec la
trace de l'incohérence. Aucune perte, aucun double comptage.

---

## T. Payment default (L10.6)

Prouvé depuis le code : grâce **snapshotée** au premier échec ; `graceDays`
`null` ≠ `0` sur toute la chaîne ; `graceDeadlineAt: null` **exclu** du
scheduler (`$ne: null` load-bearing) ; Stripe seul ordonnanceur des retries ;
`PROJECT_SITE_STATUS.causes` comme preuve ; `PAYMENT_DEFAULT_INCIDENT` ≠
`PAYMENT_DEFAULT_CAUSE` ; manuelle + impayé coexistent ; retrait d'une cause ⇒
réconciliation, **jamais** `ACTIVE` forcé ; L10.5 exclu.

---

## U. Schedulers

| scheduler | fréquence | autorité | effet fournisseur | requis au boot |
|---|---|---|---|---|
| `startEventScheduler` | interne | Panel | non | oui |
| `startRecurringCostScheduler` | **1 h** + passage immédiat au démarrage | Panel | oui (convergence) | **oui** |
| ↳ matérialisation des coûts récurrents | — | Panel | non | — |
| ↳ `convergePendingRevenue` | — | Panel | lecture Stripe | — |
| ↳ `convergePendingRefunds` | — | Panel | lecture Stripe | — |
| ↳ `sendDueReminders` (prestations) | — | Panel | e-mail | — |
| ↳ `expireDueGracePeriods` | — | Panel | non (émet une cause) | — |

Les **cinq** boucles financières vivent dans **un seul** ordonnanceur démarré au
boot, avec un premier passage immédiat qui rattrape une interruption longue.
Aucune échéance en mémoire : tout vit en base. **Aucun scheduler critique
manquant.** (SB Auto : `PANEL_SCHEDULER_ENABLED` pilote le sien, sans effet
financier.)

---

## V. Templates

Registre Panel : **9 modèles**, tous amorcés au boot (`seedPlatformTemplates`,
non bloquant, repli sur le registre) :
`PASSWORD_RESET_REQUEST`, `CONTACT_ADMIN_NOTIFICATION`,
`CONTRACT_CANCELLATION_ADMIN_CONFIRMATION`, `CONTRACT_CANCELLATION_DEV_NOTIFICATION`,
`EMAIL_SENDER_VERIFICATION_TEST`, `PAYMENT_REQUEST_CREATED`,
`PAYMENT_REQUEST_REMINDER`, `SITE_SUSPENDED_PAYMENT_DEFAULT_CLIENT`,
`SITE_SUSPENDED_PAYMENT_DEFAULT_TEAM`, `SITE_SUSPENDED_MANUAL_ADMIN`.

Aucun nom de client en fondation. Expéditeur résolu côté Panel, par projet et par
monde. **Aucun template attendu manquant.**

---

## W / X. UI Panel & Manager

**Panel** — Finances (Général / Coûts / Revenus), coûts récurrents,
justificatifs, remboursements, prestations, impayés (`PaymentDefaultPanel`),
suspension : toutes montées, aucun champ de credential Stripe/Hostinger, aucun
appel à une route supprimée.

**Manager** — Facturation & abonnement, prestations à payer, paiements, facture
PDF/lien, incident `PaymentDefault`, cause de suspension, action « Payer »
(facture hébergée Stripe), politique de grâce (DEV), IntegratedAPI **sans champ
Stripe ni Hostinger**.

⚠️ Écran « Configuration e-mail » : affichera `NOT_CONFIGURED` sans clé Brevo
locale (§E).

---

## Y. Schéma DB / migrations

| modèle | champ / index | anciens docs compatibles | default | backfill | risque |
|---|---|---|---|---|---|
| `PanelStripeResourceBinding` | collection neuve | s/o | — | non | historique sans binding (§L) |
| `PanelFinancialTransaction` | index partiels | ✅ hors index si `null` | — | non | nul |
| `PanelRecurringCost` | `{sourceId,cycleKey}` | ✅ | — | non | nul |
| `PanelMedia` (privé) | `visibility` | ✅ | `PUBLIC` | non | nul |
| `PanelPaymentRequest` | snapshot fiscal | collection neuve | — | non | nul |
| `PanelPaymentDefault` | `suspensionConfirmedAt`, `causeRemovalConfirmedAt` | ✅ | `null` | non | nul |
| `Contract` | `paymentGraceDays` | ✅ | `null` → **aucune suspension auto** | non | nul (sûr par défaut) |
| `SiteStatus` | `causes` | ✅ absent = « je ne sais pas » | `false` | non | nul |
| `SiteStatus` | `technicalSuspension.notifyAdminsRequested`, `liftedAt/By` | ✅ | `false`/`null` | non | nul |
| `PaymentDefaultIncident` | collection neuve | s/o | — | non | nul |
| `PanelProjectWebhookSecret` | — | ✅ | — | non | nul |

**Aucune migration obligatoire.** Tous les nouveaux champs ont un défaut sûr, et
le code traite l'absence comme « inconnu » plutôt que comme une valeur.

---

## Z. Compatibilité des données déjà déployées

| classe | contenu |
|---|---|
| `AUTO_COMPATIBLE` | contrats sans `paymentGraceDays` (aucune fermeture auto) ; `SiteStatus` sans `causes` (le Panel refuse de conclure) ; transactions manuelles ; descripteurs media déjà adoptés ; nouveaux champs `technicalSuspension` |
| `AUTO_CONVERGENCE` | revenus Stripe non projetés (convergence horaire) ; remboursements `PENDING` ; incidents republiés au rattrapage ; livraisons e-mail |
| `ONE_TIME_MIGRATION_REQUIRED` | **aucune en base** |
| `MANUAL_ACTION_REQUIRED` | ① adopter les ressources Stripe historiques si le portail/la résiliation sont refusés (§L) ; ② renseigner la clé Brevo locale si l'écran de config doit être vert (§E) |
| `BLOCKER` | **aucun** |

---

## AA. Tests

| suite | résultat |
|---|---|
| **Panel — suite complète** | **113/113 fichiers, 7994 contrôles, 0 rouge, exit 0** |
| **SB Auto — suite complète** | **86 blocs, 5090 contrôles, 0 rouge, exit 0** |
| Manager (unitaires) | 0 rouge |
| Vitrine | 68/68 |

Suites ciblées ré-exécutées : `stripe-local-surface` 71/71,
`stripe-final-control-plane-cutover` 49/49, `dead-provider-credentials-purge`
61/61, `integrated-api` 75/75, `integrated-api-environment-routing` 42/42,
`env-mode-independence` 12/12, `active-mode-revoked` 26/26,
`bridge-conformity` 102/102 (SB) et 60/60 (Panel), `spec-drift` OK.

**Aucun rouge. Aucun `UNKNOWN`.**

---

## AB. Builds / typechecks

| cible | typecheck | build |
|---|---|---|
| Panel frontend | ✅ | ✅ |
| Manager | ✅ | ✅ |
| Vitrine | — | ✅ |

---

## AC. Audit du DeploymentEngine

| point | constat |
|---|---|
| credential Hostinger local | **non** — capacité uniquement |
| `storage/` persistant (projets) | **oui** — symlink posé à chaque release |
| healthcheck exposant un document privé | **non** — `/health` seulement |
| `version.json` généré | oui, `no-cache` |
| `backendSourceHash` / hashes frontend | fiables (`uploads`/`storage`/`logs` exclus du hash) |
| DNS `manager.` / `api.` | couverts, un certificat par hôte (pas de wildcard TLS) |
| warnings MongoDB | portent sur la présence du binaire, pas la connexion — **non bloquants** |
| warnings Nginx « protocol options redefined » | **non bloquants** |

Le moteur n'a gardé aucune hypothèse devenue fausse **pour les projets**. Le trou
est dans le script de déploiement **du Panel lui-même** (§P), qui n'est pas ce
moteur.

---

## AD. Risques

| # | risque | gravité | classe |
|---|---|---|---|
| 1 | **`--dry-run` décrit un layout que le moteur n'utilise plus** (releases / current / prune) → l'opérateur relit une fiction avant de déployer | **MOYENNE** | lot **R10.1** |
| 2 | `.gitignore` ne couvre pas `backend/storage/` → un justificatif déposé en local serait committable | MOYENNE | lot **R10.1** |
| 3 | Ressources Stripe historiques sans binding → portail/résiliation refusés | MOYENNE | `MANUAL_ACTION_REQUIRED` |
| 4 | Écran config e-mail « Non configuré » sans clé Brevo locale | MOYENNE | cosmétique/opérateur |
| 5 | Plafond d'endpoints webhook Stripe par compte | FAIBLE | à surveiller |
| 6 | `_resetStub()` orphelin (`stripe.service.js`) | NULLE | nettoyage |
| 7 | `STRIPE_PROVIDER` mort dans `.env.example` | NULLE | dette documentaire |

Les risques 1 et 2 **n'interdisent pas le déploiement** : le premier trompe un
lecteur, il ne casse pas une exécution ; le second est une hygiène de dépôt sur
un dossier qui n'existe pas localement aujourd'hui.

---

## AE. Actions requises avant déploiement

**Aucune action bloquante.**

1. **[Recommandé, avant de se fier à un `--dry-run`]** Lot `R10.1` — aligner la
   simulation sur le moteur réel et couvrir `backend/storage/` dans
   `.gitignore`.
2. **[Recommandé]** Vérifier sur les données réelles si le contrat de
   démonstration possède ses bindings Stripe ; préparer l'adoption sinon.
3. **[Optionnel]** Clé Brevo locale, ou lot d'affichage (§E).
4. **[Optionnel]** Nettoyage `_resetStub()` + `STRIPE_PROVIDER`.

---

## AF. Plan de recette post-déploiement

Pour chaque étape : préconditions · action · preuve · Panel · SB Auto · PASS/FAIL.

| # | étape | preuve attendue | PASS si |
|---|---|---|---|
| 1 | déployer Panel | pipeline vert | `/health` ENV correct |
| 2 | Panel runtime | logs boot | 9 modèles amorcés, scheduler « toutes les 60 min » |
| 3 | **persistance Panel** | `ls -l /var/www/<host>/backend/storage` | **symlink vers `../shared/storage`** |
| 4 | déployer SB Auto | pipeline vert | `.next` → swap → `.prev` |
| 5 | `version.json` | `curl /version.json` | hash = release |
| 6 | pairing | fiche projet Panel | `PAIRED`, contrat `1.5.0` |
| 7 | Hostinger | DNS d'un sous-domaine | via capacité, 0 credential local |
| 8 | Stripe sans clé locale | catalogue Manager | Stripe affiché « plateforme », 0 champ |
| 9 | webhook Stripe | provisioning + événement test | signature vérifiée, monde correct |
| 10 | Brevo métier | e-mail réel | `providerMessageId`, `EMAIL_DELIVERY_EVENT` reçu |
| 11 | revenu Stripe | paiement TEST | 1 transaction, 0 doublon |
| 12 | facture | détail transaction | `invoiceId` + `hostedInvoiceUrl` |
| 13 | remboursement | partiel puis total | 2 lignes `OUTFLOW/REFUND`, net diminué, coûts inchangés |
| 14 | prestation | créer → payer | ledger vide avant paiement, `PAID` après |
| 15 | coût ponctuel | saisie | hors index de provenance |
| 16 | coût récurrent | 2 cycles | 1 occurrence/cycle |
| 17 | **justificatif privé** | dépôt + relecture | téléchargeable, **404 sur `/uploads/…`** |
| 18 | `PaymentDefault` | `invoice.payment_failed` TEST | incident visible **Panel ET Manager**, site accessible |
| 19 | suspension auto | expiration de grâce | cause émise, `causes.paymentDefault`, confirmation |
| 20 | suspension manuelle | modale + case cochée | site fermé, e-mail « Aucun » si motif vide |
| 21 | régularisation | `invoice.paid` | `RESOLVED`, cause retirée, accessible si seule cause |
| 22 | **second déploiement** | redéployer Panel **et** SB Auto | **justificatif de l'étape 17 toujours lisible**, aucun doublon de revenu, incident conservé |

Les étapes **3 et 22 restent les plus importantes** : elles confirment sur le
serveur réel ce que §P établit depuis le code. Un audit statique prouve qu'une
commande est écrite ; seul le serveur prouve qu'elle a produit le lien attendu.

---

## AG. Verdict

Les deux dépôts sont cohérents entre eux, construisibles, testés (**13 084
contrôles, zéro rouge**), compatibles avec les données déjà déployées, sans
migration obligatoire, sans credential mort requis au boot, sans appel
fournisseur local résiduel pour Stripe et Hostinger, sans drift de contrat de
pont, avec un stockage public et privé persistant des deux côtés et jamais
exposé publiquement.

Les conditions d'arrêt du §27 sont revues une à une : **aucune n'est remplie.**
En particulier « `shared/storage` n'est pas persistant » — l'unique blocker de la
première rédaction — est **réfuté** au §P.

Restent des risques connus, aucun bloquant : deux dettes de dépôt traitées par le
lot R10.1, une adoption Stripe à vérifier sur données réelles, et un affichage
Brevo à clarifier.

```
PRE-DEPLOYMENT AUDIT: PASS
GO DEPLOYMENT: YES
```

---

## AH. Rectificatif — pourquoi la première rédaction s'est trompée

La première version de ce rapport concluait `BLOCKED` sur un faux positif. La
cause mérite d'être écrite, parce qu'elle est reproductible.

**L'erreur** : avoir lu `deploy/lib/plan.mjs` comme s'il décrivait l'exécution.
Il décrit la **simulation**. `deploy.mjs:239-241` sépare les deux, et seule la
branche `--execute` atteint un serveur.

**Ce qui aurait dû l'attraper, et que je n'ai pas rapproché** :

1. `deploy.mjs:85` — le commentaire dit littéralement « Exécution réelle :
   délègue intégralement au moteur standard » ;
2. `tests/finance-receipts.test.js:483` — un garde-fou livré avec **L10.2**
   affirme l'invariant contraire, et il était **vert dans la suite complète que
   j'avais moi-même exécutée** ;
3. `privateMedia.service.js:44-47` — le commentaire que j'ai qualifié de
   mensonger était exact ; le contredire aurait dû déclencher une vérification
   plutôt qu'une conclusion.

**La leçon, applicable aux audits suivants** : quand un audit statique contredit
un test existant qui passe, c'est l'audit qu'il faut vérifier en premier. Un
garde-fou vert est une affirmation datée sur le code réel ; une lecture de
fichier est une hypothèse sur le chemin emprunté.

**Ce que l'erreur a tout de même révélé** : la divergence entre `--dry-run` et
le moteur est bien réelle, et c'est elle qui rendait la confusion possible. Elle
est traitée par le lot **R10.1**.
