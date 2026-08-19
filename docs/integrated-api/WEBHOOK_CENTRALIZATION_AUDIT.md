# Audit + correction — centralisation Brevo / Stripe / webhooks auto-gérés

Date d'audit : 2026-08-14
Périmètre : `Panel` uniquement, pour `L.Y Solution`

## ROOT CAUSE

Le symptôme Brevo `ACCEPTED + webhookStatus=PENDING` n'était pas causé par une
mauvaise route webhook ni par une mauvaise corrélation du `providerMessageId`.
Le chemin entrant centralisé existait déjà et était correctement monté avant
`express.json()`.

La cause racine prouvée en base réelle `panel_test` était :

1. le credential set `BREVO/TEST` a bien été enregistré le 2026-08-14T13:12:08.566Z ;
2. le binding webhook `BREVO/TEST` était resté figé au 2026-08-11T10:35:45.026Z ;
3. `saveCredentialSet()` n'appelait aucune réconciliation webhook ;
4. le binding gardait donc l'ancien diagnostic `WEBHOOK_CREDENTIALS_MISSING` ;
5. aucun webhook Brevo n'était provisionné, donc aucun callback ne pouvait
   revenir vers le Panel.

Une seconde panne d'héritage a été révélée pendant la recette réelle :

- l'ancien index Mongo `uniq_provider_environment` existait encore sur
  `PanelIntegratedApiWebhookBinding` ;
- un vieux binding sans `destination` cohabitait avec le binding `PANEL`
  explicite introduit plus tard ;
- la réconciliation réelle pouvait réussir côté fournisseur tout en laissant
  l'écran et l'ingest relire le document legacy.

## ARCHITECTURE BEFORE

### Avant migration SB Auto

Envoi :

`Panel/Manager` n'était pas la porte unique. SB Auto portait encore du runtime
Brevo local, notamment :

- `SB Auto 06/backend/src/services/brevo/brevoEmail.service.js`
- `SB Auto 06/backend/src/services/brevo/brevoWebhookConfig.service.js`

Webhook :

- route legacy locale `SB Auto 06/backend/src/routes/webhook.routes.js`
- callbacks historiques :
  - `/api/webhooks/stripe`
  - `/api/webhooks/brevo/transactional/:mode`

Le couple envoi + réception était donc pensé projet-localement.

### Dans le Panel avant ce correctif

L'architecture centralisée existait déjà :

Envoi Brevo :

- `backend/src/services/email/panelEmailSenderTest.service.js`
- `backend/src/services/capabilities/capabilityGateway.service.js`
- `backend/src/services/integratedApi/brevo/*`

Webhook centralisé :

- route publique `backend/src/app.js`
- `backend/src/routes/providerWebhooks.routes.js`
- `backend/src/services/webhooks/webhookCallback.js`
- `backend/src/services/webhooks/webhookIngest.js`
- `backend/src/services/webhooks/emailDeliveryDispatch.js`

Réconciliation :

- `backend/src/services/webhooks/webhookReconciler.js`
- `backend/src/services/webhooks/providerWebhookAdapters.js`
- `backend/src/services/webhooks/webhookSecrets.js`

Le défaut était donc un défaut de crochet et de migration, pas un défaut de
conception générale.

## SB AUTO MIGRATION IMPACT

Constat utile :

- les routes legacy SB Auto existent encore dans le dépôt SB Auto ;
- le runtime actif du Panel pour l'envoi de test Brevo n'en dépend plus ;
- le chemin actif du Panel était bien :
  `Panel Manager -> Panel Backend -> capability email.send_template -> driver Brevo Panel -> Brevo`
- le chemin attendu du callback était bien :
  `Brevo -> /webhooks/providers/brevo -> ingest -> dispatch livraison -> Panel UI`

Impact réel de la migration :

- l'ownership de l'envoi est bien passé au Panel ;
- l'ownership du webhook était conceptuellement passé au Panel ;
- mais le crochet "credential saisi -> provisioning relancé" manquait encore.

## BREVO FINDINGS

### Audit du test réel en échec

Opération auditée :

- `operationId/testId`: `73f8513e-49f3-4ff9-838d-1f7b6af84f22`
- `providerMessageId`: `202608141317.96952397736@smtp-relay.mailin.fr`

Persistance constatée avant correction :

- `PanelEmailSenderTest.status = ACCEPTED`
- `PanelEmailSenderTest.webhookStatus = PENDING`
- `PanelCapabilityOperation.status = SUCCEEDED`
- aucun `PanelProviderWebhookEvent` Brevo
- binding `BREVO/TEST` en `PENDING`, sans `remoteWebhookId`, sans secret, avec
  `WEBHOOK_CREDENTIALS_MISSING`

### Audit de la corrélation

La corrélation Brevo était déjà présente :

- mapping des événements :
  `backend/src/services/integratedApi/brevo/brevoEventMapping.js`
- normalisation du `message-id` :
  `backend/src/services/integratedApi/brevo/brevoTransport.js`
- projection Panel :
  `backend/src/services/webhooks/emailDeliveryDispatch.js`

Le défaut n'était donc ni la normalisation du `message-id`, ni une confusion
entre `operationId` et `providerMessageId`.

### Provisioning réel après correction

Réconciliation Brevo TEST exécutée le 2026-08-14 :

- callback attendue :
  `https://api.panel.ly-solution.com/webhooks/providers/brevo`
- webhook Brevo réel :
  `2133651`
- binding final :
  `status=READY`
- `secretConfigured=true`
- `lastReconciledAt=2026-08-14T13:46:58.072Z`

Le binding legacy sans `destination` a été retiré pendant cette recette.

## STRIPE FINDINGS

### Architecture

Le receiver Stripe était déjà correctement fondé :

- route publique montée avant `express.json()`
- vérification sur raw body dans
  `backend/src/services/webhooks/webhookSignature.js`
- utilisation du `whsec_*` stocké au coffre

Le défaut demandé par le brief "attention au raw body" n'a pas été trouvé :
la base technique était déjà correcte.

### Audit réel non destructif

Lecture Stripe TEST réalisée le 2026-08-14, sans aucune écriture :

- un seul binding `STRIPE/TEST`
- un seul endpoint distant :
  `we_1U4LOWGlI6vEcGH1EQw5AC0Z`
- URL :
  `https://api.panel.ly-solution.com/webhooks/providers/stripe`
- statut :
  `enabled=true`
- ownership probable :
  `OWNED`
- description :
  `PANEL_CONTROL_PLANE_STRIPE_TEST#81d0caa5-cec1-4967-9251-2a68b65d26f4`

Événements activés :

- `checkout.session.completed`
- `checkout.session.async_payment_succeeded`
- `checkout.session.async_payment_failed`
- `checkout.session.expired`
- `payment_intent.succeeded`
- `payment_intent.payment_failed`
- `charge.refunded`
- `invoice.finalized`
- `invoice.paid`
- `invoice.payment_failed`
- `customer.subscription.created`
- `customer.subscription.updated`
- `customer.subscription.deleted`

Constat PROD :

- aucun credential set Stripe PROD exploitable n'était configuré ;
- aucune action réelle Stripe PROD n'a donc été tentée.

## DOMAIN RECONCILIATION

Source de vérité du domaine backend :

- `backend/src/services/network/networkConfig.service.js`
- lecture via `resolveBackendUrl()`
- composition via `backend/src/services/webhooks/webhookCallback.js`

Déclencheurs désormais actifs :

1. au boot ;
2. lors d'un changement réel de `backendUrl` ;
3. lors d'un `saveCredentialSet()` sur un rôle humain d'un provider à webhook,
   pour l'environnement servi par l'instance.

## CHANGES

Fichiers modifiés :

- `backend/src/services/integratedApi/controlPlane.service.js`
- `backend/src/services/integratedApi/providerRegistry.js`
- `backend/src/services/webhooks/webhookReconciler.js`
- `backend/src/services/webhooks/webhookIngest.js`
- `frontend/src/pages/IntegratedApiControlPlanePage.tsx`
- `tests/integrated-api-control-plane.test.js`
- `tests/integrated-api-provider-registry.test.js`
- `tests/webhook-control-plane.test.js`
- `docs/architecture/WEBHOOK_CONTROL_PLANE.md`
- `docs/integrated-api/WEBHOOK_CENTRALIZATION_AUDIT.md`

Effets fonctionnels :

1. un credential API fraîchement saisi relance automatiquement la
   réconciliation webhook ;
2. `BREVO.webhookSecret` est officiellement `autoManaged` ;
3. l'UI n'affiche plus les rôles `autoManaged` comme des champs éditables ;
4. la réconciliation sait maintenant :
   - retirer l'ancien index `uniq_provider_environment`
   - migrer un binding legacy vers `destination=PANEL`
   - supprimer un binding legacy doublon ;
5. l'ingest et l'écran relisent explicitement le binding `PANEL`.

## TESTS

Suites exécutées après correctif :

- `node tests/integrated-api-control-plane.test.js`
- `node tests/integrated-api-provider-registry.test.js`
- `node tests/webhook-control-plane.test.js`

Résultats :

- `integrated-api-control-plane`: 68/68
- `integrated-api-provider-registry`: 68/68
- `webhook-control-plane`: 238/238

Nouveaux garde-fous ajoutés :

- post-save webhook reconcile sur l'environnement servi ;
- non-déclenchement sur environnement non servi ;
- non-déclenchement sur rôle `autoManaged` ;
- retrait de l'ancien index legacy ;
- persistance de l'index composite de binding.

## REAL BREVO RECIPE

Recette réelle exécutée une seule fois après provisioning réel :

- destinataire :
  `luca.duhoux@gmail.com`
- expéditeur :
  `L.Y Solution <support@ly-solution.com>`
- template :
  `PANEL_EMAIL_SENDER_TEST`
- `testId` :
  `fafcd273-6e37-4dfa-bcc8-0b0852669368`
- `providerMessageId` :
  `202608141347.68322252260@smtp-relay.mailin.fr`
- webhook Brevo :
  `2133651`

Timestamps :

- `requestedAt = 2026-08-14T13:47:20.653Z`
- `acceptedAt = 2026-08-14T13:47:22.271Z`
- `lastWebhookAt = 2026-08-14T13:47:23.000Z`
- événement `request` reçu à `2026-08-14T13:47:25.326Z`
- événement `delivered` reçu à `2026-08-14T13:47:27.127Z`

Verdict recette :

- `SEND` -> PASS
- `PROVIDER ACCEPTED` -> PASS
- `WEBHOOK RECEIVED` -> PASS
- `WEBHOOK AUTHENTICATED` -> PASS
- `CORRELATION` -> PASS
- `DELIVERY = DELIVERED` -> PASS

État final du test :

- `status = DELIVERED`
- `webhookStatus = RECEIVED`
- `lastWebhookEvent = DELIVERED`

## REMAINING RISKS

1. le journal utilisateur du test d'e-mail ne distingue pas encore tous les
   états demandés (`WEBHOOK_NOT_CONFIGURED`, `WEBHOOK_AUTH_FAILED`, etc.) ;
2. la suite n'a pas exécuté de recette Stripe PROD réelle, faute de credential
   PROD présent ;
3. la réconciliation post-save est détachée : elle répare le nominal sans
   bloquer l'admin, mais l'observabilité repose toujours sur l'état webhook et
   les logs, pas sur une transaction utilisateur synchrone ;
4. l'UI affiche maintenant correctement les rôles auto-gérés, mais n'a pas
   encore de test frontend dédié.

## FINAL VERDICT

Le problème Brevo observé le 2026-08-14 n'était pas un défaut de transport
Brevo ni un héritage runtime SB Auto encore actif sur l'envoi. C'était un
défaut d'orchestration dans le Panel :

- pas de réconciliation automatique après saisie du credential ;
- migration incomplète du modèle de binding webhook.

Après correctif :

- Brevo TEST est réellement provisionné ;
- le binding Panel Brevo est `READY` ;
- la vraie recette d'envoi revient `DELIVERED` avec callback reçu ;
- Stripe TEST est déjà centralisé et owned côté Panel ;
- le parcours nominal redevient :

`credential racine -> réconciliation auto -> webhook provider -> validation -> corrélation -> état UI`
