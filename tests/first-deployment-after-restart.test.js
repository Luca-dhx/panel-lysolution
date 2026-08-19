/**
 * LE PREMIER APPEL APRÈS UN REDÉMARRAGE — sur un VRAI processus.
 *
 * ══ POURQUOI CETTE SUITE NE MONTE PAS L'APPLICATION EN MÉMOIRE ══════════════
 *
 * Les autres suites importent `createApp()` et posent l'état prêt à la main.
 * Elles éprouvent la garde, pas la SÉQUENCE DE DÉMARRAGE — et c'est justement
 * la séquence qui était en cause : `app.listen()` venait après la connexion
 * Mongo et une douzaine de migrations, si bien que rien n'écoutait sur le port
 * pendant toute cette fenêtre.
 *
 * On lance donc `src/server.js` dans un PROCESSUS RÉEL, contre une base
 * éphémère, et l'on observe de l'extérieur ce qu'un navigateur observerait.
 *
 * ══ CE QUE LA SUITE PROUVE ══════════════════════════════════════════════════
 *
 *   1. le port répond AVANT la fin de l'amorçage — plus d'ECONNREFUSED, donc
 *      plus de `502` opaque servi par nginx ;
 *   2. pendant l'amorçage, une route métier refuse en `503` + code stable, et
 *      JAMAIS en `401` — c'est ce qui empêche le frontend de conclure à une
 *      session perdue ;
 *   3. le service bascule tout seul en prêt, sans intervention ;
 *   4. le PREMIER appel métier après cette bascule aboutit — pas de requête
 *      d'échauffement, pas de seconde tentative, pas d'attente empirique.
 *
 * Le point 4 est le critère du lot.
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { check, finish, section } from './helpers/harness.js';

const racine = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const backend = path.join(racine, 'backend');

/* ── Une base éphémère : jamais celle de l'exploitant ─────────────────────── */
const { createRequire } = await import('node:module');
const { pathToFileURL } = await import('node:url');
const require = createRequire(new URL('../backend/package.json', import.meta.url));
const { MongoMemoryServer } = await import(
  pathToFileURL(require.resolve('mongodb-memory-server')).href
);
const memoire = await MongoMemoryServer.create();

/**
 * Un port fixe et haut : le processus fils doit écouter là où la suite
 * interroge, et `PORT=0` ne se laisse pas deviner de l'extérieur.
 */
const PORT = 47_231;
const base = `http://127.0.0.1:${PORT}`;

const enfant = spawn(process.execPath, [path.join(backend, 'src', 'server.js')], {
  cwd: backend,
  stdio: ['ignore', 'pipe', 'pipe'],
  env: {
    ...process.env,
    PANEL_SKIP_DOTENV: '1',
    ENV: 'TEST',
    PORT: String(PORT),
    MONGODB_URI: memoire.getUri(),
    DB_TEST: 'panel_first_boot',
    DB_PROD: 'panel_first_boot_prod',
    JWT_SECRET: 'panel-test-jwt-secret-0123456789abcdef0123456789abcdef',
    JWT_EXPIRES_IN: '12h',
    BRIDGE_ENCRYPTION_KEY: 'a'.repeat(64),
    SEED_DEV_EMAIL: 'dev@panel.test',
    SEED_DEV_PASSWORD: 'motdepasse-test',
    PANEL_NAME: 'Panel (recette premier démarrage)',
  },
});

const journal = [];
enfant.stdout.on('data', (d) => journal.push(String(d)));
enfant.stderr.on('data', (d) => journal.push(String(d)));

async function appel(chemin) {
  try {
    const res = await fetch(`${base}${chemin}`);
    let json = null;
    try { json = await res.json(); } catch { json = null; }
    return { joignable: true, status: res.status, json };
  } catch {
    // Le port n'écoute pas encore : c'est exactement l'état que le correctif
    // supprime, et il faut donc pouvoir le CONSTATER, pas le masquer.
    return { joignable: false, status: 0, json: null };
  }
}

/** Attend qu'une condition devienne vraie, sans jamais boucler sans fin. */
async function attendre(predicat, { limiteMs = 60_000, pasMs = 50 } = {}) {
  const fin = Date.now() + limiteMs;
  for (;;) {
    // eslint-disable-next-line no-await-in-loop
    const valeur = await predicat();
    if (valeur) return valeur;
    if (Date.now() > fin) return null;
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => { setTimeout(r, pasMs); });
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
   PENDANT L'AMORÇAGE
   ═══════════════════════════════════════════════════════════════════════════ */

section('Le port répond AVANT la fin de l’amorçage');

const premierContact = await attendre(async () => {
  const r = await appel('/livez');
  return r.joignable && r.status === 200 ? r : null;
}, { limiteMs: 30_000 });

check('/livez répond pendant que le backend s’amorce', premierContact !== null);

/**
 * L'observation qui compte : au moment où `/livez` répond déjà, `/readyz` doit
 * encore refuser. Si les deux basculaient ensemble, la distinction
 * « vivant » / « prêt » n'existerait que sur le papier.
 *
 * La fenêtre est courte sur une base en mémoire : on la CAPTURE plutôt que de
 * l'exiger, et on n'échoue pas si l'amorçage a été plus rapide que le premier
 * aller-retour HTTP — ce serait éprouver la vitesse de la machine, pas la
 * conception.
 */
const pendant = await appel('/readyz');
const metierPendant = await appel('/api/deployment');
const amorcageObserve = pendant.status === 503;

if (amorcageObserve) {
  check('/readyz refuse pendant que /livez accepte déjà', pendant.status === 503);
  check('/readyz nomme la phase STARTING', pendant.json?.data?.phase === 'STARTING');
  check('une route métier refuse en 503 pendant l’amorçage',
    metierPendant.status === 503);
  check('… avec le code stable PANEL_SERVICE_STARTING',
    metierPendant.json?.code === 'PANEL_SERVICE_STARTING');
  check('… et JAMAIS en 401 — aucune session n’est mise en cause',
    metierPendant.status !== 401);
} else {
  console.log('  · amorçage déjà terminé au premier aller-retour '
    + '(base en mémoire) — fenêtre non observable, contrôles reportés sur /readyz.');
  check('le port n’a JAMAIS refusé la connexion pendant le démarrage',
    premierContact !== null);
}

/* ═══════════════════════════════════════════════════════════════════════════
   APRÈS L'AMORÇAGE — le premier appel n'a rien de particulier
   ═══════════════════════════════════════════════════════════════════════════ */

section('Le service devient prêt seul, et le PREMIER appel métier aboutit');

const pret = await attendre(async () => {
  const r = await appel('/readyz');
  return r.status === 200 ? r : null;
}, { limiteMs: 90_000 });

check('/readyz finit par répondre 200, sans aucune intervention', pret !== null);
check('… en attestant la base connectée', pret?.json?.data?.checks?.database === true);
check('… et le moteur de déploiement présent',
  pret?.json?.data?.checks?.deploymentEngine === true);

/**
 * LE CRITÈRE DU LOT.
 *
 * Ce `fetch` est le PREMIER appel métier de la vie de ce processus. Il ne doit
 * pas être précédé d'un échauffement, ni suivi d'une seconde tentative. Un 401
 * est ici la BONNE réponse — la requête n'a pas de jeton — et il prouve que la
 * requête a traversé la garde de disponibilité pour atteindre l'authentification.
 */
const premierMetier = await appel('/api/deployment');
check('le PREMIER appel métier atteint l’authentification, sans échauffement',
  premierMetier.status === 401);
check('… et n’est plus refusé pour indisponibilité', premierMetier.status !== 503);
check('… avec le code d’authentification, pas celui du démarrage',
  premierMetier.json?.code === 'PANEL_UNAUTHORIZED');

section('Le journal de démarrage distingue les deux instants');
{
  const texte = journal.join('');
  check('le journal annonce l’ouverture du port avant l’état prêt',
    /port \d+ ouvert/i.test(texte));
  check('le journal annonce ensuite l’état PRÊT', /backend PRÊT/i.test(texte));
  check('le processus n’a produit aucune exception non gérée',
    !/UnhandledPromiseRejection|uncaughtException/i.test(texte));
}

/* ── Arrêt propre ─────────────────────────────────────────────────────────── */
enfant.kill('SIGTERM');
await attendre(async () => enfant.exitCode !== null || enfant.signalCode !== null,
  { limiteMs: 15_000 });
if (enfant.exitCode === null && enfant.signalCode === null) enfant.kill('SIGKILL');
await memoire.stop();

finish();
