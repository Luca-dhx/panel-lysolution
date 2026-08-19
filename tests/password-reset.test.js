import {
  check,
  connectTestDatabase,
  finish,
  section,
  setTestEnv,
  startMemoryMongo,
  startServer,
  stopMemoryMongo,
} from './helpers/harness.js';

setTestEnv();
await startMemoryMongo();
await connectTestDatabase();

const users = await import('../backend/src/services/auth/panelUsers.service.js');
const resetService = await import('../backend/src/services/auth/panelPasswordReset.service.js');
const PanelUser = (await import('../backend/src/models/PanelUser.model.js')).default;
const PanelPasswordResetRequest = (await import('../backend/src/models/PanelPasswordResetRequest.model.js')).default;
const { createApp } = await import('../backend/src/app.js');

const capturedEmails = [];

function acceptedEmailStub() {
  return async ({ payload }) => {
    capturedEmails.push({
      operationId: payload.operationId,
      recipient: payload.recipient?.email ?? null,
      templateRef: payload.templateRef,
      resetUrl: payload.variables?.['auth.resetUrl'] ?? null,
      expiresMinutes: payload.variables?.['auth.expiresMinutes'] ?? null,
    });
    return {
      result: {
        providerMessageId: `msg-${capturedEmails.length.toString().padStart(4, '0')}`,
      },
    };
  };
}

resetService.__setPasswordResetTestDeps({
  invokeCapabilityImpl: acceptedEmailStub(),
  resolveFrontendUrlImpl: async () => ({ url: 'https://panel.ly-solution.test' }),
});

async function cleanState() {
  capturedEmails.length = 0;
  await PanelPasswordResetRequest.deleteMany({});
  await users.resetUsers();
}

async function seedUser(email = 'admin@panel.test', password = 'motdepasse-admin') {
  await cleanState();
  await users.createUser({
    email,
    password,
    displayName: 'Gestion',
    role: users.PANEL_ROLES.ADMIN,
  });
}

async function captureCode(fn) {
  try {
    await fn();
    return null;
  } catch (error) {
    return error?.code ?? null;
  }
}

function latestEmail() {
  return capturedEmails[capturedEmails.length - 1] ?? null;
}

section('Réponse HTTP générique, avec et sans compte');
{
  await seedUser();
  const { call, close } = await startServer(createApp());

  const existing = await call('POST', '/api/auth/forgot-password', {
    body: { email: '  ADMIN@PANEL.TEST ' },
  });
  const unknown = await call('POST', '/api/auth/forgot-password', {
    body: { email: 'inconnu@panel.test' },
  });

  check('email existant → 200', existing.status === 200);
  check('email inconnu → même statut', unknown.status === 200);
  check('…et même message générique',
    existing.json?.data?.message === unknown.json?.data?.message
    && /Si un compte correspond/i.test(existing.json?.data?.message ?? ''));

  await close();
}

section('Le token est généré aléatoirement, hashé en base et lié au bon domaine frontend');
{
  await seedUser();

  await resetService.requestPasswordReset({ email: ' Admin@Panel.test ', ip: '203.0.113.10' });

  const sent = latestEmail();
  const storedUser = await PanelUser.findOne({ email: 'admin@panel.test' }).lean();
  const audit = await PanelPasswordResetRequest.findOne({ userId: storedUser.userId }).lean();
  const resetUrl = new URL(sent.resetUrl);
  const rawToken = resetUrl.searchParams.get('token');

  check('un e-mail réel est préparé via le template dédié',
    sent?.templateRef === resetService.PASSWORD_RESET_TEMPLATE_CODE);
  check('le lien pointe vers la route officielle de reset',
    resetUrl.origin === 'https://panel.ly-solution.test'
    && resetUrl.pathname === resetService.PASSWORD_RESET_ROUTE);
  check('un token brut est présent dans le lien', typeof rawToken === 'string' && rawToken.length >= 32);
  check('…mais jamais stocké brut en base',
    storedUser.passwordResetTokenHash !== rawToken && !JSON.stringify(storedUser).includes(rawToken));
  check('le hash stocké correspond au token envoyé',
    storedUser.passwordResetTokenHash === resetService.hashPasswordResetToken(rawToken));
  check('le TTL est explicite et loggé',
    audit.tokenTtlMinutes === resetService.PASSWORD_RESET_TOKEN_TTL_MINUTES
    && sent.expiresMinutes === String(resetService.PASSWORD_RESET_TOKEN_TTL_MINUTES));
  check('la demande porte operationId/deliveryId/providerMessageId',
    audit.requestId === storedUser.passwordResetRequestId
    && audit.providerMessageId === 'msg-0001');
  check('le domaine frontend utilisé est persisté pour audit',
    audit.frontendUrl === 'https://panel.ly-solution.test'
    && audit.resetRoute === resetService.PASSWORD_RESET_ROUTE);
}

section('Changer la frontendUrl change les mails suivants, sans changer le code');
{
  await seedUser();

  resetService.__setPasswordResetTestDeps({
    resolveFrontendUrlImpl: async () => ({ url: 'https://panel-a.ly-solution.test' }),
  });
  await resetService.requestPasswordReset({ email: 'admin@panel.test', ip: '203.0.113.11' });
  const firstToken = new URL(latestEmail().resetUrl).searchParams.get('token');

  resetService.__setPasswordResetTestDeps({
    resolveFrontendUrlImpl: async () => ({ url: 'https://panel-b.ly-solution.test/app' }),
  });
  await PanelPasswordResetRequest.updateMany({}, { $set: { requestedAt: '2026-08-14T13:00:00.000Z' } });
  await resetService.requestPasswordReset({ email: 'admin@panel.test', ip: '203.0.113.11' });
  const secondUrl = new URL(latestEmail().resetUrl);
  const secondToken = secondUrl.searchParams.get('token');

  check('le deuxième mail suit immédiatement la nouvelle frontendUrl',
    secondUrl.origin === 'https://panel-b.ly-solution.test'
    && secondUrl.pathname === '/app/reset-password');
  check('l’ancien lien est invalidé dès qu’un nouveau est demandé',
    await captureCode(() => resetService.resetPasswordWithToken({
      token: firstToken,
      password: 'motdepasse-reset-2026',
      passwordConfirmation: 'motdepasse-reset-2026',
    })) === 'PASSWORD_RESET_TOKEN_INVALID');

  const user = await PanelUser.findOne({ email: 'admin@panel.test' }).lean();
  check('le nouveau lien devient le seul valable', user.passwordResetTokenHash === resetService.hashPasswordResetToken(secondToken));
}

section('Le backend refuse mismatch, token expiré, token réutilisé et mot de passe trop court');
{
  await seedUser();

  resetService.__setPasswordResetTestDeps({
    resolveFrontendUrlImpl: async () => ({ url: 'https://panel.ly-solution.test' }),
  });
  await resetService.requestPasswordReset({ email: 'admin@panel.test', ip: '203.0.113.12' });
  const token = new URL(latestEmail().resetUrl).searchParams.get('token');

  check('confirmation différente → refus métier',
    await captureCode(() => resetService.resetPasswordWithToken({
      token,
      password: 'motdepasse-reset-2026',
      passwordConfirmation: 'motdepasse-different-2026',
    })) === 'PASSWORD_RESET_PASSWORD_MISMATCH');

  check('mot de passe trop court → policy backend',
    await captureCode(() => resetService.resetPasswordWithToken({
      token,
      password: 'tropcourt',
      passwordConfirmation: 'tropcourt',
    })) === 'PASSWORD_RESET_PASSWORD_POLICY');

  await PanelUser.updateOne(
    { email: 'admin@panel.test' },
    { $set: { passwordResetExpiresAt: '2026-08-14T12:00:00.000Z' } },
  );
  check('token expiré → code déterministe',
    await captureCode(() => resetService.resetPasswordWithToken({
      token,
      password: 'motdepasse-reset-2026',
      passwordConfirmation: 'motdepasse-reset-2026',
    })) === 'PASSWORD_RESET_TOKEN_EXPIRED');
}

section('Le reset modifie réellement le mot de passe, invalide les sessions et rend le lien à usage unique');
{
  await seedUser('admin@panel.test', 'motdepasse-admin');

  await resetService.requestPasswordReset({ email: 'admin@panel.test', ip: '203.0.113.13' });
  const token = new URL(latestEmail().resetUrl).searchParams.get('token');

  check('ancien mot de passe valide avant reset',
    (await users.authenticate('admin@panel.test', 'motdepasse-admin')) !== null);

  await resetService.resetPasswordWithToken({
    token,
    password: 'motdepasse-reset-2026',
    passwordConfirmation: 'motdepasse-reset-2026',
  });

  const user = await PanelUser.findOne({ email: 'admin@panel.test' }).lean();
  const audit = await resetService.describePasswordResetRequest(user?.passwordResetRequestId ?? latestEmail()?.operationId ?? '');

  check('l’ancien mot de passe est rejeté après reset',
    (await users.authenticate('admin@panel.test', 'motdepasse-admin')) === null);
  check('le nouveau mot de passe est accepté',
    (await users.authenticate('admin@panel.test', 'motdepasse-reset-2026')) !== null);
  check('le token est consommé et les sessions existantes sont invalidées',
    !user.passwordResetTokenHash && user.tokenVersion === 1);
  check('la demande est marquée COMPLETED',
    (await PanelPasswordResetRequest.findOne({ requestId: latestEmail().operationId }).lean())?.status === 'COMPLETED');
  check('le même lien devient immédiatement invalide',
    await captureCode(() => resetService.resetPasswordWithToken({
      token,
      password: 'motdepasse-reset-2026-bis',
      passwordConfirmation: 'motdepasse-reset-2026-bis',
    })) === 'PASSWORD_RESET_TOKEN_INVALID');

  void audit;
}

section('Rate limiting: cooldown par email et plafond par IP');
{
  await seedUser();

  await resetService.requestPasswordReset({ email: 'admin@panel.test', ip: '203.0.113.14' });
  check('deux demandes immédiates sur le même email → 429',
    await captureCode(() => resetService.requestPasswordReset({
      email: 'admin@panel.test',
      ip: '203.0.113.14',
    })) === 'PASSWORD_RESET_RATE_LIMITED');

  await PanelPasswordResetRequest.deleteMany({});
  for (let index = 0; index < resetService.PASSWORD_RESET_IP_MAX; index += 1) {
    await resetService.requestPasswordReset({
      email: `personne-${index}@panel.test`,
      ip: '203.0.113.15',
    });
  }
  check('au-delà du plafond IP → 429',
    await captureCode(() => resetService.requestPasswordReset({
      email: 'encore@panel.test',
      ip: '203.0.113.15',
    })) === 'PASSWORD_RESET_RATE_LIMITED');
}

await stopMemoryMongo();
resetService.__resetPasswordResetTestDeps();
finish();
