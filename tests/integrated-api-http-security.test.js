// SURFACE HTTP DU PLAN DE CONTRÔLE — permissions et non-fuite.
//
// Serveur Express réel, requêtes réelles. Ce qui est vérifié ici ne peut pas
// l'être en appelant les services : une fuite se produit à la sérialisation,
// et c'est précisément l'étage que les tests unitaires sautent.
//
// Trois questions :
//   · qui peut lire, qui peut écrire ?
//   · une clé écrite ressort-elle par une route, une seule, n'importe laquelle ?
//   · l'ancien coffre est-il resté intact ? (compatibilité L1)
import {
  check, connectTestDatabase, finish, section, setTestEnv,
  startMemoryMongo, startServer, stopMemoryMongo,
} from './helpers/harness.js';
import { forme } from './helpers/secretShapes.js';

setTestEnv();
await startMemoryMongo();
await connectTestDatabase();

const SENTINEL = forme.stripeTest('SENTINEL0000000000AAAA1234');
const SENTINEL_TOKEN = 'SENTINEL0000000000CCCC9012';

const { createApp } = await import('../backend/src/app.js');
const { seedFromEnv, createUser } = await import('../backend/src/services/auth/panelUsers.service.js');
const { seedIntegratedApiCredentialSets } = await import(
  '../backend/src/services/integratedApi/seed.js'
);

await seedFromEnv();
await seedIntegratedApiCredentialSets();
await createUser({
  email: 'admin@panel.test',
  password: 'motdepasse-admin-test',
  displayName: 'Admin de recette',
  role: 'ADMIN',
});

const { call, close } = await startServer(createApp());

async function login(email, password) {
  const res = await call('POST', '/api/auth/login', { body: { email, password } });
  return res.json?.data?.token ?? null;
}

const devToken = await login('dev@panel.test', 'motdepasse-test');
const adminToken = await login('admin@panel.test', 'motdepasse-admin-test');
const dev = { authorization: `Bearer ${devToken}` };
const admin = { authorization: `Bearer ${adminToken}` };

section('Comptes de recette');
{
  check('un DEV est connecté', typeof devToken === 'string');
  check('un ADMIN est connecté', typeof adminToken === 'string');
}

section('Sans authentification — 401 partout, y compris en lecture');
{
  for (const [method, path] of [
    ['GET', '/api/integrated-apis'],
    ['GET', '/api/integrated-apis/availability'],
    ['GET', '/api/integrated-apis/STRIPE'],
    ['PUT', '/api/integrated-apis/STRIPE/credentials'],
    ['POST', '/api/integrated-apis/STRIPE/validate'],
  ]) {
    const res = await call(method, path, { body: method === 'GET' ? undefined : {} });
    check(`${method} ${path} → 401`, res.status === 401 && res.json?.code === 'PANEL_UNAUTHORIZED');
  }

  const faux = await call('GET', '/api/integrated-apis', {
    headers: { authorization: `Bearer ${'0'.repeat(64)}` },
  });
  check('un jeton inventé → 401', faux.status === 401);
}

section('ADMIN — il constate, il ne touche pas');
{
  const liste = await call('GET', '/api/integrated-apis', { headers: admin });
  check('lecture du catalogue autorisée', liste.status === 200 && liste.json.data.items.length === 5);

  const diag = await call('GET', '/api/integrated-apis/availability', { headers: admin });
  check('lecture du diagnostic autorisée', diag.status === 200);

  const detail = await call('GET', '/api/integrated-apis/BREVO', { headers: admin });
  check('lecture d’un fournisseur autorisée', detail.status === 200);

  // Un ADMIN doit pouvoir constater qu'un fournisseur est tombé sans dépendre
  // d'un DEV. Mais ces routes portent les accès de toute la plateforme :
  // l'écriture reste au DEV, comme dans company.routes.js.
  const ecriture = await call('PUT', '/api/integrated-apis/STRIPE/credentials', {
    headers: admin, body: { environment: 'TEST', values: { secretKey: SENTINEL } },
  });
  check('écriture refusée → 403',
    ecriture.status === 403 && ecriture.json?.code === 'PANEL_FORBIDDEN');

  // La validation SORT sur le réseau, consomme du quota et horodate le coffre.
  // C'est une écriture, pas une lecture.
  const validation = await call('POST', '/api/integrated-apis/STRIPE/validate', {
    headers: admin, body: { environment: 'TEST' },
  });
  check('validation refusée → 403 (elle écrit et appelle un tiers)',
    validation.status === 403 && validation.json?.code === 'PANEL_FORBIDDEN');
}

section('DEV — il configure');
{
  const ecriture = await call('PUT', '/api/integrated-apis/STRIPE/credentials', {
    headers: dev, body: { environment: 'TEST', values: { secretKey: SENTINEL } },
  });
  check('écriture acceptée → 200', ecriture.status === 200);
  check('le jeu est CONFIGURED', ecriture.json.data.status === 'CONFIGURED');

  const global = await call('PUT', '/api/integrated-apis/HOSTINGER/credentials', {
    headers: dev, body: { environment: null, values: { apiToken: SENTINEL_TOKEN } },
  });
  check('un fournisseur global s’écrit sans environnement', global.status === 200);
}

section('Refus argumentés — jamais un 500 opaque');
{
  const inconnu = await call('GET', '/api/integrated-apis/MAILCHIMP', { headers: dev });
  check('fournisseur hors registre → 404',
    inconnu.status === 404 && inconnu.json.code === 'PANEL_INTEGRATED_API_UNKNOWN_PROVIDER');

  const sansEnv = await call('PUT', '/api/integrated-apis/STRIPE/credentials', {
    headers: dev, body: { values: { secretKey: SENTINEL } },
  });
  check('Stripe sans environnement → 400',
    sansEnv.status === 400 && sansEnv.json.code === 'PANEL_INTEGRATED_API_ENVIRONMENT_REQUIRED');

  const envSurGlobal = await call('PUT', '/api/integrated-apis/HOSTINGER/credentials', {
    headers: dev, body: { environment: 'TEST', values: { apiToken: 'x' } },
  });
  check('Hostinger avec environnement → 400',
    envSurGlobal.status === 400
    && envSurGlobal.json.code === 'PANEL_INTEGRATED_API_ENVIRONMENT_UNEXPECTED');

  const liveEnTest = await call('PUT', '/api/integrated-apis/STRIPE/credentials', {
    headers: dev, body: { environment: 'TEST', values: { secretKey: forme.stripeLive('SENTINELLIVE') } },
  });
  check('une clé LIVE saisie en TEST → 400, et le motif est nommé',
    liveEnTest.status === 400
    && liveEnTest.json.code === 'PANEL_INTEGRATED_API_PREFIX_WRONG_ENVIRONMENT');

  const roleInconnu = await call('PUT', '/api/integrated-apis/STRIPE/credentials', {
    headers: dev, body: { environment: 'TEST', values: { motDePasse: 'x' } },
  });
  check('un rôle hors registre → 400',
    roleInconnu.status === 400 && roleInconnu.json.code === 'PANEL_INTEGRATED_API_ROLE_UNKNOWN');

  const valuesInvalide = await call('PUT', '/api/integrated-apis/STRIPE/credentials', {
    headers: dev, body: { environment: 'TEST', values: 'pas-un-objet' },
  });
  check('« values » mal typé → 400',
    valuesInvalide.status === 400 && valuesInvalide.json.code === 'PANEL_INTEGRATED_API_VALUES_INVALID');

  const removeInvalide = await call('PUT', '/api/integrated-apis/STRIPE/credentials', {
    headers: dev, body: { environment: 'TEST', remove: 'secretKey' },
  });
  check('« remove » mal typé → 400',
    removeInvalide.status === 400 && removeInvalide.json.code === 'PANEL_INTEGRATED_API_REMOVE_INVALID');
}

section('CREDENTIALS_NEVER_LEAVE_CONTROL_PLANE — aucune route ne rend la clé');
{
  const routes = [
    ['GET', '/api/integrated-apis'],
    ['GET', '/api/integrated-apis/availability'],
    ['GET', '/api/integrated-apis/STRIPE'],
    ['GET', '/api/integrated-apis/HOSTINGER'],
  ];
  for (const [method, path] of routes) {
    for (const [nom, headers] of [['DEV', dev], ['ADMIN', admin]]) {
      const res = await call(method, path, { headers });
      const corps = JSON.stringify(res.json);
      check(`${method} ${path} (${nom}) ne contient AUCUNE sentinelle`,
        !corps.includes(SENTINEL) && !corps.includes(SENTINEL_TOKEN));
    }
  }

  // La réponse à l'ÉCRITURE elle-même : le piège le plus courant, puisqu'on
  // vient de recevoir la valeur en clair dans la requête.
  const ecriture = await call('PUT', '/api/integrated-apis/STRIPE/credentials', {
    headers: dev, body: { environment: 'TEST', values: { secretKey: SENTINEL } },
  });
  check('la réponse à l’écriture ne renvoie pas la clé',
    !JSON.stringify(ecriture.json).includes(SENTINEL));
  check('…mais elle confirme que la clé est là',
    ecriture.json.data.credentials.secretKey.configured === true);
  check('…avec un masque et une empreinte, et rien d’autre',
    ecriture.json.data.credentials.secretKey.value === null
    && ecriture.json.data.credentials.secretKey.maskedValue.endsWith('1234')
    && typeof ecriture.json.data.credentials.secretKey.fingerprint === 'string');

  // Une clé publiable, elle, DOIT sortir en clair : c'est sa raison d'être.
  const publiable = await call('PUT', '/api/integrated-apis/STRIPE/credentials', {
    headers: dev, body: { environment: 'TEST', values: { publishableKey: 'pk_test_VISIBLE' } },
  });
  check('la clé publiable, elle, est rendue en clair',
    publiable.json.data.credentials.publishableKey.value === 'pk_test_VISIBLE');
}

section('Les réponses ne se mettent pas en cache');
{
  const res = await call('GET', '/api/integrated-apis', { headers: dev });
  check('Cache-Control: no-store',
    (res.headers.get('cache-control') ?? '').includes('no-store'));
}

section('Compatibilité L1 — l’ancien coffre est intact');
{
  // L4 le démontera. L1 ne doit RIEN lui prendre : un projet appairé continue
  // de recevoir exactement ce qu'il recevait hier.
  const ancien = await call('GET', '/api/company/integrated-apis', { headers: dev });
  // Sans entreprise configurée, l'ancienne route répond déjà
  // PANEL_COMPANY_NOT_CONFIGURED — c'est son comportement d'avant L1, et il
  // n'a pas changé. Ce qu'on vérifie ici, c'est qu'elle est TOUJOURS ROUTÉE :
  // un « NOT_FOUND » générique signifierait que le nouveau plan de contrôle
  // l'a masquée.
  check('GET /api/company/integrated-apis est toujours routée',
    ancien.json?.code !== 'NOT_FOUND');
  check('…et répond sur ses propres termes',
    ancien.status === 200 || ancien.json?.code === 'PANEL_COMPANY_NOT_CONFIGURED');

  const nouveau = await call('GET', '/api/integrated-apis', { headers: dev });
  check('les deux surfaces coexistent, sur des chemins distincts',
    nouveau.status === 200 && nouveau.json.data.items.length === 5);
}

await close();
await stopMemoryMongo();
finish();
