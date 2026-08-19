# PASSWORD RESET AND TEMPLATE EDITOR FINAL AUDIT

Date d'audit: 2026-08-14

## TEMPLATE EDITOR

- `SB Auto 06` possède déjà un éditeur DEV complet de templates e-mail: catalogue, édition HTML, preview, variables, readiness, test-send, historique et restauration.
- `Panel` possédait le moteur canonique de templates et le versionnement, mais pas la surface équivalente.
- Le lot ajoute sur `Panel`:
  - API `/api/email-templates`
  - service d'édition `panelEmailTemplateEditor.service.js`
  - page frontend `EmailTemplatesPage.tsx`
  - navigation DEV vers `Templates e-mail`
  - tests backend/UI dédiés
- Conclusion: l'autorité templates du Panel est maintenant exposée avec une surface proche de `SB Auto 06`, y compris pour `PASSWORD_RESET_REQUEST`.

## PANEL RESET ROUTING ROOT CAUSE

- Le bug `/reset-password -> /login` ne venait pas de `RequireAuth`.
- Les routes publiques `/login`, `/forgot-password`, `/reset-password` étaient déjà hors garde d'authentification.
- La vraie cause était le bootstrap global d'auth:
  - `AuthContext` appelait `api.me()` si un jeton existait en `localStorage`.
  - le client API redirigeait globalement vers `/login` sur tout `401` hors `/api/auth/login`.
  - un jeton local expiré suffisait donc à forcer `/login` avant affichage stable de la page publique.
- Correction appliquée:
  - `api.me()` désactive explicitement la redirection forcée sur `401`
  - la page publique de reset reste donc rendable même si le stockage local contient une vieille session.

## PANEL CHANGES

- Backend:
  - `backend/src/services/auth/panelPasswordReset.service.js`
  - `backend/src/models/PanelPasswordResetRequest.model.js`
  - `backend/src/controllers/emailTemplates.controller.js`
  - `backend/src/routes/emailTemplates.routes.js`
  - `backend/src/services/email/panelEmailTemplateEditor.service.js`
- Frontend:
  - `frontend/src/pages/ForgotPasswordPage.tsx`
  - `frontend/src/pages/ResetPasswordPage.tsx`
  - `frontend/src/pages/EmailTemplatesPage.tsx`
  - `frontend/src/components/ToastProvider.tsx`
  - `frontend/src/lib/api.ts`
  - `frontend/src/lib/emailTemplates.ts`
  - `frontend/src/lib/passwordPolicy.ts`
  - `frontend/src/types.emailTemplates.ts`
  - `frontend/src/App.tsx`
  - `frontend/src/config/nav.ts`
  - `frontend/src/styles.css`
- Tests:
  - `tests/password-reset.test.js`
  - `tests/password-reset-ui.test.js`
  - `tests/template-editor.test.js`
  - `tests/template-editor-ui.test.js`

## PANEL BROWSER RECIPE

- Recette navigateur locale rejouée le 2026-08-14 sur:
  - frontend: `http://127.0.0.1:5273`
  - backend local déjà exposé sur `http://127.0.0.1:4100`
- Preuve obtenue:
  - ouverture directe de `http://127.0.0.1:5273/reset-password?token=browser-reset-token-2026`
  - `localStorage.panel_token` forcé à une valeur périmée avant le chargement
  - la page reste sur `/reset-password?...`, sans redirection vers `/login`
  - le formulaire de reset s'affiche
  - la soumission réussit et rend l'écran succès `Mot de passe modifié`
- Ce point prouve le correctif du bug public.
- La page `/login` n'a pas été requalifiée jusqu'au bout dans ce même harness navigateur ad hoc; la reconnexion avec le nouveau mot de passe reste déjà prouvée par les suites automatisées backend.

## SB AUTO IMPLEMENTATION

- `SB Auto 06` implémentait déjà le flux oublié/reset côté backend et manager.
- L'audit confirme que ce flux passe bien par l'architecture centralisée:
  - `backend/src/services/auth.service.js`
  - appel à `sendTemplate(...)`
  - puis chaîne canonique du projet vers le Panel, pas d'appel Brevo local depuis le parcours reset.
- Le manager expose déjà:
  - `/mot-de-passe-oublie`
  - `/reinitialiser-mot-de-passe?token=...`
- Le garde `401` du manager est plus strict qu'un purgeur global aveugle:
  - seul un refus confirmé par `/auth/me` invalide la session
  - un `401` applicatif ou un backend momentanément injoignable ne déconnecte pas arbitrairement.

## SB AUTO TEMPLATE

- Le template métier utilisé reste `PASSWORD_RESET_REQUEST`.
- Le code `SB Auto 06` ne détient pas Brevo pour ce parcours:
  - il désigne le template
  - fournit `company.name`, `user.name`, `auth.resetUrl`, `auth.expiresMinutes`
  - laisse le Panel rendre et expédier selon son autorité canonique.
- Aucun template local Brevo à rebrancher ou maintenir dans `SB Auto 06`.

## SECURITY

- Panel:
  - réponse générique anti-énumération
  - rate limits dédiées e-mail/IP
  - token hashé en SHA-256, jamais stocké brut
  - usage unique
  - expiration bornée
  - policy mot de passe alignée backend/frontend
  - redirection `401` neutralisée pour le bootstrap public de reset
- SB Auto 06:
  - réponse générique
  - token hashé
  - usage unique
  - reset URL construite depuis `network.managerUrl`
  - aucun envoi direct Brevo local dans le parcours reset

## AUTOMATED TESTS

- Panel exécuté avec succès:
  - `node tests/password-reset-ui.test.js`
  - `node tests/template-editor-ui.test.js`
  - `node tests/template-editor.test.js`
  - `npm run build` dans `Panel/frontend`
- SB Auto 06 exécuté avec succès:
  - `node backend/src/scripts/auth-password-reset.test.js`
  - `node --experimental-strip-types --disable-warning=ExperimentalWarning --import ./scripts/alias-loader-register.mjs src/lib/passwordResetPages.test.mjs` dans `SB Auto 06/manager`
  - `npm run build` dans `SB Auto 06/manager`

## REAL E2E RECIPES

- Panel, déjà prouvé avant ce lot:
  - demande réelle oubli mot de passe
  - réception Gmail réelle
  - lien réel `https://panel.ly-solution.com/reset-password?token=...`
  - changement réel du mot de passe
  - ancien mot de passe refusé
  - nouveau mot de passe accepté
  - token réutilisé refusé
- Panel, prouvé aujourd'hui en navigateur local:
  - route publique `/reset-password` stable malgré jeton local expiré
  - formulaire navigateur réellement soumis jusqu'à l'écran succès
- SB Auto 06:
  - E2E réel réseau non rejoué aujourd'hui sur instance publique
  - E2E backend complet rejoué sur environnement de test avec stub Panel appairé

## DEPLOYMENT REQUIREMENTS

- Panel:
  - déployer backend et frontend ensemble
  - vérifier que le frontend publié contient la version de `api.me()` sans redirection forcée
  - conserver une URL frontend canonique valide pour la construction des liens de reset
  - garder la configuration e-mail globale et Brevo opérationnelles si l'on veut l'envoi réel/test-send
- SB Auto 06:
  - garder l'appairage Panel actif
  - garder `network.managerUrl` cohérent avec le domaine réellement servi
  - ne pas réintroduire d'envoi Brevo local pour le reset
  - publier le manager avec les routes publiques de reset

## FILES CHANGED

- Panel
  - `backend/src/app.js`
  - `backend/src/controllers/auth.controller.js`
  - `backend/src/middlewares/panelAuth.middleware.js`
  - `backend/src/models/PanelUser.model.js`
  - `backend/src/routes/auth.routes.js`
  - `backend/src/services/auth/panelToken.service.js`
  - `backend/src/services/auth/panelUsers.service.js`
  - `backend/src/controllers/emailTemplates.controller.js`
  - `backend/src/routes/emailTemplates.routes.js`
  - `backend/src/services/auth/panelPasswordReset.service.js`
  - `backend/src/services/email/panelEmailTemplateEditor.service.js`
  - `backend/src/models/PanelPasswordResetRequest.model.js`
  - `frontend/src/App.tsx`
  - `frontend/src/config/nav.ts`
  - `frontend/src/lib/api.ts`
  - `frontend/src/main.tsx`
  - `frontend/src/pages/LoginPage.tsx`
  - `frontend/src/pages/ForgotPasswordPage.tsx`
  - `frontend/src/pages/ResetPasswordPage.tsx`
  - `frontend/src/pages/EmailTemplatesPage.tsx`
  - `frontend/src/components/ToastProvider.tsx`
  - `frontend/src/lib/emailTemplates.ts`
  - `frontend/src/lib/passwordPolicy.ts`
  - `frontend/src/types.emailTemplates.ts`
  - `frontend/src/styles.css`
  - `tests/run-all.js`
  - `tests/password-reset.test.js`
  - `tests/password-reset-ui.test.js`
  - `tests/template-editor.test.js`
  - `tests/template-editor-ui.test.js`
  - `docs/auth/PASSWORD_RESET_AND_TEMPLATE_EDITOR_FINAL_AUDIT.md`
- SB Auto 06
  - `manager/package.json`
  - `manager/src/lib/passwordResetPages.test.mjs`

## REMAINING RISKS

- Les fichiers webhook/control-plane déjà dirty dans `Panel` n'ont pas été modifiés par ce lot; ils restent hors périmètre de ce rapport.
- La preuve navigateur publiée sur `https://panel.ly-solution.com` n'a pas été rejouée aujourd'hui; la preuve navigateur obtenue est locale, sur build/dev local.
- L'écran `/login` du harness navigateur local n'a pas été qualifié jusqu'au bout dans le même run Playwright ad hoc; ce n'est pas le point litigieux principal, et la validité du nouveau mot de passe reste couverte par les tests backend.

## FINAL VERDICT

- `Panel` est corrigé sur le vrai root cause `/reset-password -> /login`, et il dispose maintenant d'une surface d'édition de templates cohérente avec l'autorité canonique des templates.
- `SB Auto 06` est conforme au modèle centralisé pour le reset password; aucune dépendance Brevo locale ne doit être réintroduite.
- Le lot est techniquement validé pour déploiement, sous réserve de publier le frontend `Panel` corrigé et de conserver les prérequis d'URL/frontend/appairage/e-mail en place.
