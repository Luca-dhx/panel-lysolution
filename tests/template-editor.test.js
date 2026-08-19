import {
  check, connectTestDatabase, finish, section, setTestEnv,
  startMemoryMongo, startServer, stopMemoryMongo,
} from './helpers/harness.js';

setTestEnv();
await startMemoryMongo();
await connectTestDatabase();

const { createApp } = await import('../backend/src/app.js');
const users = await import('../backend/src/services/auth/panelUsers.service.js');
const templates = await import('../backend/src/services/email/panelEmailTemplate.service.js');

await users.resetUsers();
await users.seedFromEnv();
await templates.seedPlatformTemplates();

const { call, close } = await startServer(createApp());

async function login(email, password) {
  const response = await call('POST', '/api/auth/login', { body: { email, password } });
  return response.json?.data?.token ?? null;
}

const devToken = await login(process.env.SEED_DEV_EMAIL, process.env.SEED_DEV_PASSWORD);
await users.createUser({
  email: 'admin-template@panel.test',
  password: 'AdminTemplate-2026',
  displayName: 'Admin Template',
  role: 'ADMIN',
});
const adminToken = await login('admin-template@panel.test', 'AdminTemplate-2026');

section('Surface protegee');
{
  const anonymous = await call('GET', '/api/email-templates');
  check('liste refusee sans session', anonymous.status === 401);

  const admin = await call('GET', '/api/email-templates', {
    headers: { authorization: `Bearer ${adminToken}` },
  });
  check('liste refusee a un ADMIN', admin.status === 403);
}

section('Catalogue et detail');
{
  const list = await call('GET', '/api/email-templates', {
    headers: { authorization: `Bearer ${devToken}` },
  });
  check('liste rendue au compte DEV', list.status === 200);
  check('PASSWORD_RESET_REQUEST present dans le catalogue',
    list.json?.data?.some((item) => item.templateId === 'PASSWORD_RESET_REQUEST'));

  const detail = await call('GET', '/api/email-templates/PASSWORD_RESET_REQUEST', {
    headers: { authorization: `Bearer ${devToken}` },
  });
  check('detail rendu', detail.status === 200);
  check('les variables autorisees sont publiees',
    detail.json?.data?.variables?.some((variable) => variable.key === 'auth.resetUrl'));
  check('le HTML est bien editable', typeof detail.json?.data?.html === 'string');
}

section('Preview, readiness et historique');
{
  const preview = await call('POST', '/api/email-templates/PASSWORD_RESET_REQUEST/preview', {
    headers: { authorization: `Bearer ${devToken}` },
    body: {
      subject: 'Reset {{company.name}}',
      html: '<p>Bonjour {{user.name}}</p><p>Valable {{auth.expiresMinutes}} minutes</p><a href="{{auth.resetUrl}}">Reset</a>',
    },
  });
  check('preview calcule sans envoi reel', preview.status === 200);
  check('le rendu preview contient le lien de demonstration',
    typeof preview.json?.data?.html === 'string' && preview.json.data.html.includes('https://'));

  const readiness = await call('GET', '/api/email-templates/PASSWORD_RESET_REQUEST/readiness', {
    headers: { authorization: `Bearer ${devToken}` },
  });
  check('readiness rendu', readiness.status === 200);
  check('les blocages structurels attendus sont exposes',
    readiness.json?.data?.blockers?.some((item) => ['SENDER_NOT_CONFIGURED', 'PROVIDER_NOT_CONFIGURED', 'PROVIDER_NOT_VALIDATED'].includes(item.code)));

  const initial = await call('GET', '/api/email-templates/PASSWORD_RESET_REQUEST', {
    headers: { authorization: `Bearer ${devToken}` },
  });
  const version = initial.json?.data?.version;

  const update = await call('PUT', '/api/email-templates/PASSWORD_RESET_REQUEST', {
    headers: { authorization: `Bearer ${devToken}` },
    body: {
      expectedVersion: version,
      description: 'Template de reset mis a jour par le test',
    },
  });
  check('mise a jour acceptee', update.status === 200);
  check('la version est incrementee', update.json?.data?.version === version + 1);

  const versions = await call('GET', '/api/email-templates/PASSWORD_RESET_REQUEST/versions', {
    headers: { authorization: `Bearer ${devToken}` },
  });
  check('historique accessible', versions.status === 200);
  check('au moins une version d’edition figure dans l’historique',
    versions.json?.data?.some((item) => item.origin === 'EDIT'));

  const oldestVersion = versions.json?.data?.[versions.json.data.length - 1]?.version;
  const restored = await call('POST', `/api/email-templates/PASSWORD_RESET_REQUEST/versions/${oldestVersion}/restore`, {
    headers: { authorization: `Bearer ${devToken}` },
  });
  check('restauration accessible', restored.status === 200);
  check('la restauration produit une nouvelle version', restored.json?.data?.version > update.json?.data?.version);
}

section('Test send protege par la readiness');
{
  const rejected = await call('POST', '/api/email-templates/PASSWORD_RESET_REQUEST/test-send', {
    headers: { authorization: `Bearer ${devToken}` },
    body: { recipientEmail: 'destinataire@exemple.test' },
  });
  check('l’envoi de test est refuse tant que la readiness bloque', rejected.status === 409);
}

await close();
await stopMemoryMongo();
finish();
