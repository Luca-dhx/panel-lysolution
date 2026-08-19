/**
 * DISPONIBILITÉ DU SERVICE — « vivant » n'est pas « prêt ».
 *
 * ══ CE QUE CETTE SUITE PROUVE, ET POURQUOI ELLE EXISTE ══════════════════════
 *
 * Le backend ouvrait son port APRÈS la connexion Mongo et une douzaine de
 * migrations. Pendant cette fenêtre, rien n'écoutait : nginx répondait `502`
 * avec une page HTML, que le frontend ne sait pas lire. L'erreur arrivait donc
 * sans code et sans message — indiscernable, pour le client, d'une session
 * invalide. C'est cette indiscernabilité qui renvoyait l'utilisateur au login
 * après un simple redémarrage.
 *
 * La suite éprouve la conception qui la remplace :
 *
 *   · le port répond DÈS LE DÉBUT — `/livez` est servi avant tout amorçage ;
 *   · `/readyz` ne MENT PAS — il refuse tant que les dépendances manquent ;
 *   · les routes métier refusent en `503` + code stable, jamais en `500`,
 *     jamais en `401`, jamais par une socket coupée ;
 *   · une fois prêt, tout redevient normal SANS redémarrage.
 *
 * Le dernier point est le critère du lot : le premier appel après un démarrage
 * ne doit avoir AUCUN comportement particulier.
 */
import {
  check, finish, section, setTestEnv, startMemoryMongo, stopMemoryMongo,
} from './helpers/harness.js';

setTestEnv();
await startMemoryMongo();

const { createApp } = await import('../backend/src/app.js');
const readiness = await import('../backend/src/services/health/readiness.service.js');

/**
 * Le serveur est lancé À LA MAIN, sans passer par `startServer` du harnais :
 * celui-ci déclare le service prêt, ce qui est exactement l'état qu'on veut
 * éprouver AVANT. Un helper qui « répare » la condition testée ne prouve rien.
 */
readiness.resetReadiness();
const app = createApp();
const server = await new Promise((resolve) => {
  const s = app.listen(0, () => resolve(s));
});
const base = `http://127.0.0.1:${server.address().port}`;

async function appel(chemin, options = {}) {
  const res = await fetch(`${base}${chemin}`, options);
  let json = null;
  try { json = await res.json(); } catch { json = null; }
  return { status: res.status, json, headers: res.headers };
}

/* ═══════════════════════════════════════════════════════════════════════════
   AMORÇAGE EN COURS — le port répond, le métier refuse proprement
   ═══════════════════════════════════════════════════════════════════════════ */

section('Amorçage en cours — le port écoute avant que le service ne soit prêt');
{
  const livez = await appel('/livez');
  check('/livez répond 200 pendant l’amorçage', livez.status === 200);
  check('/livez annonce « alive »', livez.json?.data?.status === 'alive');

  const readyz = await appel('/readyz');
  check('/readyz répond 503 tant que l’amorçage n’est pas terminé', readyz.status === 503);
  check('/readyz ne prétend pas être prêt', readyz.json?.data?.ready === false);
  check('/readyz nomme la phase STARTING', readyz.json?.data?.phase === 'STARTING');
  check('/readyz porte un Retry-After', readyz.headers.get('retry-after') === '2');

  /**
   * LE POINT CENTRAL DE TOUTE LA SUITE.
   *
   * Une route métier appelée trop tôt doit dire « je ne peux pas encore », et
   * surtout PAS « tu n'es pas authentifié ». Un 401 ici ferait effacer le jeton
   * du navigateur — c'est le bogue que ce lot ferme.
   */
  const metier = await appel('/api/deployment');
  check('une route métier refuse en 503 pendant l’amorçage', metier.status === 503);
  check('… avec le code stable PANEL_SERVICE_STARTING',
    metier.json?.code === 'PANEL_SERVICE_STARTING');
  check('… en affirmant que la session reste valide',
    metier.json?.details?.sessionValid === true);
  check('… et en se déclarant réessayable', metier.json?.details?.retryable === true);
  check('une route métier ne répond JAMAIS 401 pendant l’amorçage', metier.status !== 401);
  check('une route métier ne répond JAMAIS 500 pendant l’amorçage', metier.status !== 500);

  /**
   * `/api/auth/me` est la route que le frontend appelle au chargement. C'est
   * ELLE qui décidait de la déconnexion : son échec vidait l'identité. Elle doit
   * donc, plus que toute autre, ne jamais répondre 401 pour cause d'amorçage.
   */
  const me = await appel('/api/auth/me', { headers: { authorization: 'Bearer peu-importe' } });
  check('/api/auth/me refuse en 503, pas en 401, pendant l’amorçage', me.status === 503);
  check('… avec le code stable PANEL_SERVICE_STARTING',
    me.json?.code === 'PANEL_SERVICE_STARTING');
}

/* ═══════════════════════════════════════════════════════════════════════════
   SERVICE PRÊT — le premier appel n'a aucun comportement particulier
   ═══════════════════════════════════════════════════════════════════════════ */

section('Service prêt — aucun échauffement, aucune seconde tentative');
{
  const { connectDatabase } = await import('../backend/src/config/db.js');
  await connectDatabase();
  readiness.markReady();

  const readyz = await appel('/readyz');
  check('/readyz répond 200 une fois prêt', readyz.status === 200);
  check('/readyz confirme l’aptitude', readyz.json?.data?.ready === true);
  check('/readyz atteste la base connectée', readyz.json?.data?.checks?.database === true);
  check('/readyz atteste le moteur de déploiement présent',
    readyz.json?.data?.checks?.deploymentEngine === true);

  /**
   * La garde de disponibilité ne refuse plus : la route est atteinte, et c'est
   * l'authentification qui tranche. Un 401 ICI est LÉGITIME — il vient d'un
   * jeton absent, pas d'un service qui démarre. C'est toute la différence que
   * la suite établit.
   */
  const metier = await appel('/api/deployment');
  check('une route métier n’est plus bloquée par la disponibilité',
    metier.status !== 503);
  check('… et c’est désormais l’authentification qui tranche', metier.status === 401);
  check('… avec le code d’authentification, pas celui du démarrage',
    metier.json?.code === 'PANEL_UNAUTHORIZED');
}

/* ═══════════════════════════════════════════════════════════════════════════
   BASE PERDUE APRÈS COUP — le service redevient indisponible, sans mentir
   ═══════════════════════════════════════════════════════════════════════════ */

section('Base perdue en cours de service — 503, jamais un 401 ni un 500');
{
  const { disconnectDatabase, connectDatabase } = await import('../backend/src/config/db.js');
  await disconnectDatabase();

  // L'état est lu par le module de disponibilité lui-même : il n'y a qu'une
  // source de vérité sur « la base répond-elle », et la recette l'interroge au
  // lieu d'en tenir une seconde.
  check('la connexion est effectivement rompue', readiness.isDatabaseReady() === false);

  const readyz = await appel('/readyz');
  check('/readyz redevient 503 quand la base tombe', readyz.status === 503);
  check('… en désignant la base comme la dépendance manquante',
    readyz.json?.data?.checks?.database === false);

  const metier = await appel('/api/deployment');
  check('une route métier refuse en 503 quand la base est absente', metier.status === 503);
  check('… avec le code stable PANEL_DATABASE_UNAVAILABLE',
    metier.json?.code === 'PANEL_DATABASE_UNAVAILABLE');
  check('… sans jamais accuser la session', metier.status !== 401);
  check('… et en affirmant que la session reste valide',
    metier.json?.details?.sessionValid === true);

  /**
   * `/livez` reste vert : le process va bien, c'est sa base qui manque. Un
   * `/livez` qui échouerait ici ferait redémarrer en boucle un backend sain —
   * et le redémarrage ne répare pas une base absente. On transformerait une
   * panne passagère en panne permanente.
   */
  const livez = await appel('/livez');
  check('/livez reste 200 : le process vit, c’est sa base qui manque',
    livez.status === 200);

  /* Le service revient sans redémarrage — la reprise est une propriété. */
  await connectDatabase();
  const reprise = await appel('/readyz');
  check('/readyz redevient 200 dès que la base revient, sans redémarrage',
    reprise.status === 200);
}

await new Promise((resolve) => { server.close(resolve); });
await stopMemoryMongo();
finish();
