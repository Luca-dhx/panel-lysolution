// LE SECRET DE VÉRIFICATION SUIT LE MONDE DE LA FICHE (2026-11-13).
//
// Le Panel en ligne tourne en TEST et administre aussi les productions. Le
// provisionnement de l'endpoint Stripe suivait le monde de la fiche (PROD) ;
// la livraison du secret suivait l'environnement d'EXÉCUTION du Panel (TEST).
// BeautySavage PROD n'a donc jamais reçu son secret : 28 webhooks refusés.
//
// Ici : un Panel qui tourne en TEST livre à une fiche PROD le secret PROD, à
// une fiche TEST le secret TEST, et une fiche ne peut jamais obtenir celui de
// l'autre monde (elle ne nomme ni le projet, ni le monde).
import {
  check,
  connectTestDatabase,
  finish,
  section,
  setTestEnv,
  startMemoryMongo,
  stopMemoryMongo,
} from './helpers/harness.js';

setTestEnv();
await startMemoryMongo();
await connectTestDatabase();

const { fetchVerificationSecret } = await import('../backend/src/controllers/webhookVerification.controller.js');
const { storeProjectVerificationSecret } = await import('../backend/src/services/webhooks/projectWebhookSecrets.js');
const { runtimeEnvironment } = await import('../backend/src/services/integratedApi/environment.js');

const SECRET_TEST = `whsec_${'t'.repeat(32)}`;
const SECRET_PROD = `whsec_${'p'.repeat(32)}`;

async function call(bridgeProject) {
  let body = null;
  let status = 200;
  const res = {
    status(code) { status = code; return this; },
    json(payload) { body = payload; return this; },
    set() { return this; },
    setHeader() { return this; },
  };
  try {
    await fetchVerificationSecret({ bridgeProject, params: { provider: 'stripe' } }, res);
  } catch (err) {
    return { status: err.statusCode || err.status || 500, code: err.code, secret: null };
  }
  const data = body?.data ?? body;
  return { status, secret: data ? Object.values(data).find((v) => typeof v === 'string' && v.startsWith('whsec_')) : null };
}

section('Contexte');
check('le Panel de ce test tourne en TEST (comme le Panel en ligne)', runtimeEnvironment() === 'TEST');

const prodId = crypto.randomUUID();
const testId = crypto.randomUUID();
for (const [projectId, environment, secret] of [[prodId, 'PROD', SECRET_PROD], [prodId, 'TEST', SECRET_TEST], [testId, 'TEST', SECRET_TEST]]) {
  await storeProjectVerificationSecret({ projectId, provider: 'STRIPE', environment, secret });
}

section('Une fiche PROD reçoit le secret PROD');
{
  const r = await call({ projectId: prodId, declaredEnvironment: 'PROD', panelWorld: 'PROD' });
  check('200', r.status === 200);
  check('secret PROD livré (pas celui du monde d’exécution TEST)', r.secret === SECRET_PROD);
}

section('Une fiche PROD sans rattachement explicite : son environnement déclaré');
{
  const r = await call({ projectId: prodId, declaredEnvironment: 'PROD', panelWorld: null });
  check('secret PROD livré', r.secret === SECRET_PROD);
}

section('Une fiche TEST reçoit le secret TEST');
{
  const r = await call({ projectId: testId, declaredEnvironment: 'TEST', panelWorld: 'TEST' });
  check('secret TEST livré', r.secret === SECRET_TEST);
}

section('Une fiche PROD rattachée aux comptes de recette : le secret TEST');
{
  const r = await call({ projectId: prodId, declaredEnvironment: 'PROD', panelWorld: 'TEST' });
  check('secret TEST livré', r.secret === SECRET_TEST);
}

section('Aucun secret dans le monde de la fiche : 404, jamais celui de l’autre monde');
{
  const r = await call({ projectId: testId, declaredEnvironment: 'TEST', panelWorld: 'PROD' });
  check('404 PANEL_WEBHOOK_VERIFICATION_SECRET_MISSING', r.status === 404 && r.code === 'PANEL_WEBHOOK_VERIFICATION_SECRET_MISSING');
}

await stopMemoryMongo();
finish();
