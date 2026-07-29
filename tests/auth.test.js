// AUTHENTIFICATION DU PANEL — audit de la Phase 4.
//
// La question à laquelle ce fichier répond : **un développeur qui clone ce
// dépôt peut-il se connecter ?**
//
// Ce n'est pas une question théorique. Avant cette phase, `.env.example`
// livrait `SEED_DEV_EMAIL=` et `SEED_DEV_PASSWORD=` vides : le serveur
// démarrait, écrivait un avertissement dans les journaux, et n'offrait aucun
// moyen d'entrer. Un outil d'administration qu'on ne peut pas ouvrir n'est
// pas utilisable.
//
// On vérifie donc le chemin RÉEL, en HTTP : seed → login → jeton → route
// protégée. Pas les fonctions prises isolément.
import {
  check, connectTestDatabase, finish, section, setTestEnv,
  startMemoryMongo, startServer, stopMemoryMongo,
} from './helpers/harness.js';

// On pose l'environnement de test SANS identifiants de seed : c'est
// exactement la situation d'un clone neuf.
setTestEnv();
delete process.env.SEED_DEV_EMAIL;
delete process.env.SEED_DEV_PASSWORD;

await startMemoryMongo();
await connectTestDatabase();

const config = (await import('../backend/src/config/env.js')).default;
const users = await import('../backend/src/services/auth/panelUsers.service.js');
const { createApp } = await import('../backend/src/app.js');

/* ══════════════════════════════════════════════════════════════════════════ */
section('Un clone neuf, sans SEED_* : la connexion doit rester possible');
{
  check('un compte de développement par défaut est prévu',
    typeof config.seedDevEmail === 'string' && config.seedDevEmail.length > 0);
  check('…avec un mot de passe', typeof config.seedDevPassword === 'string' && config.seedDevPassword.length > 0);
  check('…et le Panel signale que ce sont des identifiants de repli',
    config.seedDevIsDefault === true);

  await users.resetUsers();
  await users.seedFromEnv();
  const created = await users.authenticate(config.seedDevEmail, config.seedDevPassword);
  check('le compte est réellement créé et authentifiable', created !== null);
  check('…avec le rôle DEV', created?.role === 'DEV');
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('Le seed ne remplace JAMAIS un compte existant');
{
  await users.resetUsers();
  await users.createUser({
    email: 'vrai@exemple.test', password: 'un-mot-de-passe-reel', displayName: 'Réel', role: 'ADMIN',
  });
  await users.seedFromEnv();

  const real = await users.authenticate('vrai@exemple.test', 'un-mot-de-passe-reel');
  check('le compte réel survit au seed', real !== null && real.role === 'ADMIN');
  const seeded = await users.authenticate(config.seedDevEmail, config.seedDevPassword);
  check('…et aucun compte de développement n’a été ajouté', seeded === null);
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('Se déverrouiller quand la base existe déjà (dev:account)');
{
  // Le cas que le seed ne couvre pas : des utilisateurs existent, donc
  // `seedFromEnv()` ne fait rien, et le mot de passe est perdu.
  const created = await users.ensureDevAccount();
  check('un compte de développement est créé malgré une base non vierge', created.created === true);
  check('…et il fonctionne',
    (await users.authenticate(config.seedDevEmail, config.seedDevPassword)) !== null);

  const reset = await users.ensureDevAccount({ password: 'nouveau-mot-de-passe' });
  check('un second appel RÉINITIALISE au lieu d’échouer', reset.reset === true);
  check('…l’ancien mot de passe ne fonctionne plus',
    (await users.authenticate(config.seedDevEmail, config.seedDevPassword)) === null);
  check('…le nouveau fonctionne',
    (await users.authenticate(config.seedDevEmail, 'nouveau-mot-de-passe')) !== null);

  // Remise en état pour la suite du fichier.
  await users.ensureDevAccount();
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('Le chemin réel : login HTTP, jeton, route protégée');
{
  const { call, close } = await startServer(createApp());

  const anonymous = await call('GET', '/api/projects');
  check('sans jeton, la surface interne répond 401', anonymous.status === 401);

  const wrong = await call('POST', '/api/auth/login', {
    body: { email: config.seedDevEmail, password: 'mauvais' },
  });
  check('un mauvais mot de passe est refusé', wrong.status === 401);
  check('…sans dire lequel des deux est faux',
    wrong.json?.code === 'PANEL_INVALID_CREDENTIALS' && !/email|utilisateur/i.test(wrong.json?.message ?? ''));

  const unknown = await call('POST', '/api/auth/login', {
    body: { email: 'inconnu@exemple.test', password: config.seedDevPassword },
  });
  check('un compte inconnu donne EXACTEMENT la même réponse',
    unknown.status === 401 && unknown.json?.code === wrong.json?.code);

  const login = await call('POST', '/api/auth/login', {
    body: { email: config.seedDevEmail, password: config.seedDevPassword },
  });
  check('les identifiants de développement ouvrent une session', login.status === 200);
  check('…un jeton est délivré', typeof login.json?.data?.token === 'string');
  check('…le mot de passe ne figure pas dans la réponse',
    !JSON.stringify(login.json).includes(config.seedDevPassword));
  check('…ni aucune empreinte de mot de passe',
    !JSON.stringify(login.json).toLowerCase().includes('passwordhash'));

  const auth = { authorization: `Bearer ${login.json.data.token}` };

  const me = await call('GET', '/api/auth/me', { headers: auth });
  check('GET /api/auth/me renvoie l’utilisateur', me.status === 200 && me.json?.data?.user?.role === 'DEV');

  const projects = await call('GET', '/api/projects', { headers: auth });
  check('le jeton ouvre la surface interne', projects.status === 200);

  // Le rôle DEV est un superset : il doit ouvrir les écritures réservées.
  const company = await call('GET', '/api/company', { headers: auth });
  check('…y compris la surface Entreprise', company.status === 200);

  const forged = await call('GET', '/api/projects', { headers: { authorization: 'Bearer faux.jeton.forge' } });
  check('un jeton forgé est refusé', forged.status === 401);

  await close();
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('Toutes les surfaces internes sont gardées');
{
  const { call, close } = await startServer(createApp());
  const routes = [
    '/api/projects', '/api/supervision/dashboard', '/api/diagnostic/fleet',
    '/api/executions', '/api/company', '/api/system-configuration',
  ];
  for (const route of routes) {
    const res = await call('GET', route);
    check(`${route} exige une authentification`, res.status === 401);
  }

  // Le pont, lui, a sa PROPRE authentification (bridgeToken) : il ne doit pas
  // dépendre du JWT utilisateur, sinon un projet ne pourrait jamais parler.
  const ping = await call('GET', '/bridge/v1/ping', {
    headers: { 'x-bridge-contract-version': '1.3.0' },
  });
  check('le pont reste ouvert au ping (authentification distincte)', ping.status === 200);

  const health = await call('GET', '/health');
  check('la vivacité publique reste ouverte', health.status === 200);

  await close();
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('PROD : aucun identifiant de développement ne peut passer');
{
  // On ne teste pas `config` (déjà évalué) mais les LISTES de refus, qui
  // sont ce qui protège réellement une mise en production.
  const source = (await import('node:fs')).readFileSync(
    new URL('../backend/src/config/env.js', import.meta.url), 'utf8',
  );
  check('le repli de développement est explicitement refusé en PROD',
    /KNOWN_SEED_EMAILS\.add\(DEV_FALLBACK_EMAIL\)/.test(source)
    && /KNOWN_SEED_PASSWORDS\.add\(DEV_FALLBACK_PASSWORD\)/.test(source));
  check('le repli n’est appliqué que hors PROD',
    /isProd \? null : DEV_FALLBACK_EMAIL/.test(source)
    && /isProd \? null : DEV_FALLBACK_PASSWORD/.test(source));
  check('un mot de passe court reste refusé en PROD',
    /SEED_DEV_PASSWORD en PROD : 12 caractères minimum/.test(source));

  check('la réinitialisation locale est interdite en PROD',
    await rejects(async () => {
      const svc = await import('../backend/src/services/auth/panelUsers.service.js');
      const original = config.isProd;
      config.isProd = true;
      try {
        await svc.ensureDevAccount();
      } finally {
        config.isProd = original;
      }
    }, /ENV=PROD/));
}

async function rejects(fn, pattern) {
  try {
    await fn();
    return false;
  } catch (err) {
    return pattern.test(err.message);
  }
}

await stopMemoryMongo();
finish();
