CURRENT ARCHITECTURE

- Backend auth public routes:
  - `POST /api/auth/login`
  - `POST /api/auth/forgot-password`
  - `POST /api/auth/reset-password`
  - `GET /api/auth/me`
- User persistence:
  - `PanelUser`
  - password hash: `scrypt`
  - reset fields: `passwordResetRequestId`, `passwordResetTokenHash`, `passwordResetExpiresAt`, `passwordResetRequestedAt`
  - session invalidation field: `tokenVersion`
- Password reset orchestration:
  - `backend/src/services/auth/panelPasswordReset.service.js`
  - token source: `crypto.randomBytes(32)`
  - persistence: `SHA-256(raw token)` only
  - TTL: `30 minutes`
  - mail path: `Panel backend -> capability gateway -> email.send_template -> Brevo`
  - template code: `PASSWORD_RESET_REQUEST`
  - frontend URL source: `resolveFrontendUrl()`
- Audit/rate-limit persistence:
  - `PanelPasswordResetRequest`
  - requestId / deliveryId / providerMessageId
  - per-email cooldown + per-IP throttle
- Frontend public flow:
  - `/login`
  - `/forgot-password`
  - `/reset-password?token=...`
  - toast provider + success view

FINDINGS

- No forgot/reset flow existed before this change.
- The backend exposed only `login` and `me`.
- The frontend login page had no `Mot de passe oublié ?` link.
- No reset token generation, no reset storage, no expiry, no invalidation, no reset pages.
- A centralized email template already existed and was coherent:
  - `PASSWORD_RESET_REQUEST`
- The official frontend URL resolver already existed and was the correct source of truth.
- No reusable toast system existed in the frontend.
- No auth rate limiting existed for password reset.
- Existing JWTs could not be invalidated after password change.

ROOT CAUSES

- The auth stack stopped at login-only.
- The email control plane had already been centralized, but auth had never been wired into it.
- Session invalidation had no auth-version mechanism.
- The frontend had no public password-reset routes or UX states for this flow.

EMAIL TEMPLATE

- Reused canonical template: `PASSWORD_RESET_REQUEST`
- Subject observed in live mail:
  - `Réinitialisation de votre mot de passe — L.Y Solution`
- Button and plain fallback link point to the same reset URL.
- Variables used:
  - `company.name`
  - `user.name`
  - `auth.resetUrl`
  - `auth.expiresMinutes`

TOKEN SECURITY

- Raw token generation:
  - `crypto.randomBytes(32).toString('hex')`
- Persistence:
  - raw token sent only by email
  - stored value: `SHA-256(raw token)`
- Token properties:
  - single-use
  - 30-minute TTL
  - replaced on new request
  - cleared on successful reset
- Backend error codes:
  - `PASSWORD_RESET_TOKEN_REQUIRED`
  - `PASSWORD_RESET_TOKEN_INVALID`
  - `PASSWORD_RESET_TOKEN_EXPIRED`
  - `PASSWORD_RESET_PASSWORD_MISMATCH`
  - `PASSWORD_RESET_PASSWORD_POLICY`

BACKEND FLOW

- `POST /api/auth/forgot-password`
  - trims/lowercases email
  - applies per-email cooldown and per-IP throttle
  - returns the same generic success for existing and unknown emails
  - for known user:
    - generates token
    - stores only token hash + TTL
    - logs a `PanelPasswordResetRequest`
    - sends mail through `email.send_template`
- `POST /api/auth/reset-password`
  - validates token presence
  - validates optional confirmation match
  - validates backend password policy
  - finds user by token hash
  - rejects expired/used/unknown tokens deterministically
  - hashes new password with `scrypt`
  - clears reset fields atomically
  - increments `tokenVersion`
- `requirePanelUser`
  - now compares JWT `ver` against `PanelUser.tokenVersion`
  - old JWTs become invalid after password reset

FRONTEND FLOW

- Login page now links to `/forgot-password`.
- Forgot page:
  - email input
  - loading state
  - generic success state
  - back-to-login link
- Reset page:
  - reads token from query string
  - requires two password inputs
  - local validation before API call
  - toast on mismatch / policy / backend error
  - success toast, then success view
  - explicit CTA back to `/login`

CHANGES

- Added reset token persistence and JWT versioning to `PanelUser`.
- Added `PanelPasswordResetRequest` audit model.
- Added centralized password reset service.
- Added public auth routes and controllers.
- Added webhook-side projection for `PANEL_SELF` password reset deliveries.
- Added frontend public routes/pages for forgot/reset.
- Added minimal global toast provider.
- Added automated backend and UI coverage.

AUTOMATED TESTS

- Existing regression re-run:
  - `node tests/auth.test.js`
- New backend suite:
  - `node tests/password-reset.test.js`
- New frontend source-level suite:
  - `node tests/password-reset-ui.test.js`
- Frontend build:
  - `npm run build` in `frontend/`
- New backend assertions cover:
  - generic response existing/unknown email
  - email normalization
  - token hash persistence
  - TTL
  - route/domain construction from `resolveFrontendUrl()`
  - new request invalidates old token
  - expired token
  - mismatch
  - password policy
  - real password change
  - old password rejected
  - new password accepted
  - single-use token
  - cooldown per email
  - rate limit per IP

REAL E2E RECIPE

- Environment used on August 14, 2026:
  - runtime environment: `TEST`
  - DB: `panel_test`
  - frontend URL source: `SYSTEM_CONFIGURATION`
  - frontend URL resolved: `https://panel.ly-solution.com`
- Controlled mailbox confirmed:
  - Gmail profile connected: `luca.duhoux@gmail.com`
- Temporary test account used:
  - `luca.duhoux+panel-reset-e2e@gmail.com`
  - deleted after recipe
- Live request observed:
  - request date: August 14, 2026
  - template code: `PASSWORD_RESET_REQUEST`
  - operationId / deliveryId: `password-reset-913d7656-0ba1-4c53-97ae-6dfa76d93141`
  - providerMessageId: `202608141423.21949781934@smtp-relay.mailin.fr`
- Live results actually proved:
  - forgot password API: PASS
  - true Gmail receipt: PASS
  - mail subject/template content: PASS
  - reset URL built from official frontend URL: PASS
  - mismatch refusal: PASS
  - successful reset API with true token from received email: PASS
  - old password rejected after reset: PASS
  - new password accepted after reset: PASS
  - same reset link rejected on second use: PASS
- Live results not fully proved:
  - frontend reset page rendered live in a browser from the received link: NOT PROVED
  - toast display in a live browser session: NOT PROVED
  - Brevo delivery webhook `DELIVERED` back into the Panel for this mail: NOT OBSERVED as of August 14, 2026

BREVO DELIVERY

- Provider availability before recipe:
  - Brevo `TEST`: `VALID`
- Real provider acceptance observed in logs:
  - capability: `email.send_template`
  - source: `PANEL_SELF`
  - outcome: `SUCCEEDED`
- Real email receipt observed in Gmail:
  - From: `L.Y Solution <support@ly-solution.com>`
  - To: `luca.duhoux+panel-reset-e2e@gmail.com`
- Request log at last observation:
  - requestId: `password-reset-913d7656-0ba1-4c53-97ae-6dfa76d93141`
  - status: `COMPLETED`
  - providerMessageId present
  - `lastWebhookAt`: `null`
  - `lastWebhookEvent`: `null`

SECURITY CHECKS

- Anti-enumeration:
  - same 200 + same message for existing/unknown email
- Rate limit:
  - per-email cooldown
  - per-IP cap
- Password policy:
  - unified frontend/backend minimum: `10` characters
- Sensitive data handling:
  - no raw token persistence
  - no password persistence
  - no raw token in application logs
- Session invalidation:
  - `tokenVersion` increment on successful reset
- URL authority:
  - reset URL always derived from `resolveFrontendUrl()`

REMAINING RISKS

- The live browser part of the recipe is not yet proven on the published frontend.
- The live delivery webhook for the observed real mail was not yet correlated back into the Panel at the observation time.
- `company.name` currently derives from `config.panelName`; if brand naming later moves entirely into another public-company source, auth mail branding should align to that same source.
- The current frontend toast layer is intentionally minimal; it is sufficient for this flow but not yet a broader design-system primitive.

FINAL VERDICT

- Backend architecture, security model, centralized Brevo wiring, automated coverage, and true email-based reset execution: PASS
- Full end-to-end UX as demanded in the brief:
  - not yet eligible for global `PASS`
  - reason: no live browser proof for `mail link -> reset page -> toast sequence -> success page`, and no observed `DELIVERED` webhook for the real run at the observation time
- Operational verdict on August 14, 2026:
  - `PARTIAL PASS`
