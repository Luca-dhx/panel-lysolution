import fs from 'node:fs';
import path from 'node:path';
import {
  LIVE_RECIPE_VARIABLE, TEST_PROCESS_VARIABLE, liveRecipeRequested,
} from '../../backend/src/config/testDatabaseGuard.js';
// Harnais de test commun — même philosophie que le projet modèle : runners
// node autonomes, compteur pass/fail, aucun framework.
// IMPORTANT : appeler setTestEnv() AVANT tout import dynamique du backend
// (config/env.js est fail-closed).
let pass = 0;
let fail = 0;

export function check(name, cond) {
  if (cond) {
    pass += 1;
    console.log(`  ✓ ${name}`);
  } else {
    fail += 1;
    console.error(`  ✗ ${name}`);
  }
}

export function section(title) {
  console.log(`\n${title}`);
}

export function finish() {
  console.log(`\n${pass} réussis, ${fail} échoués`);
  process.exit(fail === 0 ? 0 : 1);
}

export function setTestEnv() {
  process.env.PANEL_SKIP_DOTENV = '1'; // jamais le .env local dans les tests
  process.env.ENV = 'TEST';
  // Les processus que la suite démarre en enfant héritent de l'interdit :
  // sans cette marque, un simple `spawn` contournerait le garde.
  process.env[TEST_PROCESS_VARIABLE] = '1';
  /**
   * L'URI AMBIANTE N'EST PAS HÉRITÉE — c'est la faille qui a pollué Atlas.
   *
   * `PANEL_SKIP_DOTENV` empêche de LIRE le fichier `.env`, mais ne fait rien
   * contre une `MONGODB_URI` déjà exportée par le shell ou héritée d'un
   * processus parent qui, lui, avait chargé ce fichier. Le nom de base étant
   * écrit en dur juste en dessous — `panel_test`, celui de la base partagée —
   * il suffisait de cette fuite pour écrire chez tout le monde.
   *
   * On écrase donc systématiquement. Une recette qui doit VRAIMENT viser la
   * base partagée le déclare, et sa déclaration est difficile à poser par
   * accident.
   */
  if (!liveRecipeRequested(process.env[LIVE_RECIPE_VARIABLE])) {
    process.env.MONGODB_URI = 'mongodb://127.0.0.1:27017';
  }
  process.env.DB_TEST = 'panel_test';
  process.env.DB_PROD = 'panel_prod';
  process.env.JWT_SECRET = 'panel-test-jwt-secret-0123456789abcdef0123456789abcdef';
  process.env.JWT_EXPIRES_IN = '12h';
  process.env.BRIDGE_ENCRYPTION_KEY = 'a'.repeat(64);
  process.env.SEED_DEV_EMAIL = 'dev@panel.test';
  process.env.SEED_DEV_PASSWORD = 'motdepasse-test';
  process.env.PANEL_NAME = 'Panel L.Y Solution (test)';
}

// MongoDB éphémère en mémoire — aucun service externe requis pour la suite.
// À appeler APRÈS setTestEnv() et AVANT tout import du backend : l'URI doit
// être en place quand config/env.js est évalué.
let memoryServer = null;

export async function startMemoryMongo() {
  // Les tests vivent hors de backend/ : on résout la dépendance depuis
  // backend/node_modules explicitement.
  const { createRequire } = await import('node:module');
  const { pathToFileURL } = await import('node:url');
  const require = createRequire(new URL('../../backend/package.json', import.meta.url));
  const { MongoMemoryServer } = await import(
    pathToFileURL(require.resolve('mongodb-memory-server')).href
  );
  memoryServer = await MongoMemoryServer.create();
  armerLeNettoyage(memoryServer);
  process.env.MONGODB_URI = memoryServer.getUri();
  return process.env.MONGODB_URI;
}

/**
 * ══ UNE SUITE QUI TOMBE DOIT QUAND MÊME RENDRE SON DISQUE ═══════════════════
 *
 * `MongoMemoryServer` alloue un répertoire de données WiredTiger — environ
 * 200 Mo, journal préalloué compris — et ne le rend qu'à `stop()`. Une suite
 * qui lève avant d'y arriver le laisse derrière elle. `finish()` n'aide pas :
 * il appelle `process.exit()`, ce qui coupe court à tout `stop()` en vol.
 *
 * ── CE QUE CELA A PRODUIT ──────────────────────────────────────────────────
 *
 * 658 répertoires abandonnés, ~133 Go, et un disque à 100 %. mongod ne
 * démarrait alors plus DU TOUT : onze suites du Panel échouaient d'un coup
 * avec un `fassert() failure` illisible, sans exécuter un seul contrôle.
 * Elles ont été comptées « rouges préexistantes » pendant des semaines. Aucune
 * ne l'était : c'était le harnais qui remplissait le disque, une exécution
 * après l'autre, jusqu'à s'empêcher lui-même de tourner.
 *
 * ── POURQUOI DEUX FILETS, ET PAS UN ────────────────────────────────────────
 *
 * `stop()` est asynchrone et fait le travail proprement — c'est le filet
 * normal, posé sur les fins anormales (exception, rejet, interruption).
 *
 * `exit` ne peut rien attendre : on y efface le répertoire à la main, en
 * synchrone. C'est brutal, et c'est le seul geste qui reste quand quelqu'un
 * appelle `process.exit()` — ce que fait `finish()` à chaque suite.
 */
function armerLeNettoyage(serveur) {
  /**
   * ── LE CHEMIN ET LE PROCESSUS SE LISENT SUR `instanceInfo` ──────────────
   *
   * `serveur.instance.dbPath` semble les porter — il n'en est rien : l'objet
   * n'a aucune propriété énumérable et la lecture rend `undefined`. Un filet
   * écrit dessus s'exécute sans rien effacer, et l'on croit le problème réglé
   * parce qu'aucune erreur n'apparaît. Vérifié en interrogeant l'objet.
   */
  const info = serveur.instanceInfo ?? serveur._instanceInfo ?? null;
  const chemin = info?.dbPath ?? info?.tmpDir ?? null;

  /**
   * L'EFFACEMENT SYNCHRONE — le dernier geste possible.
   *
   * Sur Windows, un répertoire de données n'est libéré qu'une fois mongod mort :
   * `rmSync` échoue tant que le processus tient ses fichiers ouverts. On le tue
   * d'abord, puis on réessaie brièvement — quelques dizaines de millisecondes
   * suffisent, et c'est tout ce qu'un gestionnaire de sortie peut s'offrir.
   */
  const effacerEnSynchrone = () => {
    for (const proc of [info?.instance?.mongodProcess, info?.instance?.killerProcess]) {
      try { proc?.kill(); } catch { /* déjà mort */ }
    }
    if (!chemin) return;
    for (let essai = 0; essai < 40; essai += 1) {
      try { fs.rmSync(chemin, { recursive: true, force: true }); return; } catch { /* pas encore libéré */ }
      const jusqua = Date.now() + 5;
      while (Date.now() < jusqua) { /* attente active : rien d'autre n'est possible ici */ }
    }
  };

  const arreterPuisSortir = async (code) => {
    try { await serveur.stop(); } catch { effacerEnSynchrone(); }
    process.exit(code);
  };

  /**
   * ══ DEUX FILETS, ET UN QUI SAIT SE TAIRE ═══════════════════════════════
   *
   * `exit` est le filet certain : Node l'émet quelle que soit la sortie — fin
   * normale, `process.exit()` de `finish()`, ou exception non rattrapée dont il
   * vient d'imprimer la pile. Mais il ne peut RIEN attendre, d'où l'effacement
   * synchrone ci-dessus, avec ce qu'il a de brutal.
   *
   * Les filets sur les fins ANORMALES font mieux : ils rendent la main à
   * `stop()`, qui démonte proprement. Ils ne s'en saisissent toutefois QUE si
   * personne d'autre n'écoute.
   *
   * ── POURQUOI CETTE RÉSERVE ────────────────────────────────────────────
   *
   * DEUX SUITES PROVOQUENT CES ÉVÉNEMENTS EXPRÈS : la forensique de déploiement
   * vérifie qu'un rejet orphelin laisse une trace dans le run. Un harnais qui
   * attrape l'événement et sort en `1` leur vole leur sujet, et transforme deux
   * suites parfaitement vertes en fichiers en échec. Un filet posé pour ramasser
   * du disque n'a pas à décider du sort d'une exception qui ne lui appartient pas.
   */
  const seulEcouteur = (evenement) => process.listenerCount(evenement) <= 1;
  const filetDeFin = (evenement) => {
    process.on(evenement, (e) => {
      if (!seulEcouteur(evenement)) return;
      console.error(e);
      arreterPuisSortir(1);
    });
  };

  process.on('exit', effacerEnSynchrone);
  filetDeFin('uncaughtException');
  filetDeFin('unhandledRejection');
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => arreterPuisSortir(130));
}

export async function connectTestDatabase() {
  const { connectDatabase } = await import('../../backend/src/config/db.js');
  await connectDatabase();
}

export async function stopMemoryMongo() {
  const { disconnectDatabase } = await import('../../backend/src/config/db.js');
  await disconnectDatabase();
  if (memoryServer) await memoryServer.stop();
  memoryServer = null;
}

/**
 * ══ REMETTRE À ZÉRO LE COMPTEUR DE TENTATIVES D'AUTHENTIFICATION ═══════════
 *
 * La limitation de tentatives est une VRAIE garde de production, et elle n'est
 * pas assouplie d'un iota ici : ni plafond relevé, ni fenêtre raccourcie, ni
 * dérogation pour un « runtime de test ».
 *
 * Mais une recette de bout en bout qui éprouve la fédération enchaîne des
 * dizaines d'ouvertures de session légitimes, en quelques secondes. Elle finit
 * donc par se faire refuser — non pas parce que le produit va mal, mais parce
 * qu'elle ressemble, vue du seau, à une attaque par force brute. Le symptôme
 * était un `429` au milieu d'une suite, et un contrôle rouge qui accusait la
 * fonctionnalité qu'il venait de valider vingt fois.
 *
 * L'état du limiteur vit dans une collection : la suite l'efface, comme une
 * connexion réussie le fait déjà pour un seul compte. Le middleware, lui, n'est
 * au courant de rien — et c'est la propriété qui compte.
 */
export async function viderLimitesAuth({ basesProjet = [] } = {}) {
  const { default: PanelAuthAttempt } = await import(
    '../../backend/src/models/PanelAuthAttempt.model.js');
  await PanelAuthAttempt.deleteMany({}).catch(() => null);

  /**
   * ── LES SEAUX DES PROJETS, QUAND LE PARCOURS LES TRAVERSE ────────────────
   *
   * Une recette fédérée franchit DEUX programmes : le Panel, et le projet qui
   * sert `/auth/federated/panel/start`. Chacun tient son propre compteur, dans
   * sa propre base. Ne vider que celui du Panel donnait la satisfaction d'avoir
   * agi et le même `429` — la leçon coûte une base de données de distance.
   *
   * On passe par le client de la connexion en cours plutôt que par `mongoose` :
   * les suites vivent hors de `backend/`, où le paquet n'est pas résoluble.
   */
  if (!basesProjet.length) return;
  const client = PanelAuthAttempt.db?.getClient?.();
  if (!client) return;
  for (const base of basesProjet) {
    await client.db(base).collection('authattempts').deleteMany({}).catch(() => null);
  }
}

/**
 * ══ ÉPROUVER LE RUNTIME DE PRODUCTION DEPUIS UNE SUITE ═════════════════════
 *
 * Une suite tourne sous la marque `PANEL_TEST_PROCESS` — c'est elle qui autorise
 * les recettes de bout en bout à observer de vrais projets sur la boucle locale
 * (`config/testHarnessRuntime.js`).
 *
 * Mais certaines suites ont exactement le travail INVERSE : prouver qu'une
 * adresse locale est refusée. Sous la marque, elles éprouveraient le runtime de
 * harnais et concluraient que la garde a disparu — alors qu'elle est intacte,
 * simplement pas celle qu'elles interrogeaient.
 *
 * `horsHarnais` retire la marque le temps d'un appel. Ce n'est pas un
 * contournement : c'est la seule façon d'interroger, depuis une suite, le
 * programme qui n'en est pas une.
 */
export async function horsHarnais(fn) {
  const memoire = process.env[TEST_PROCESS_VARIABLE];
  delete process.env[TEST_PROCESS_VARIABLE];
  try {
    return await fn();
  } finally {
    if (memoire === undefined) delete process.env[TEST_PROCESS_VARIABLE];
    else process.env[TEST_PROCESS_VARIABLE] = memoire;
  }
}

// Redémarrage simulé : on coupe la connexion applicative et on la rétablit
// sur la MÊME base — ce qui survit est ce qui est réellement persisté.
export async function simulateRestart() {
  const { connectDatabase, disconnectDatabase } = await import('../../backend/src/config/db.js');
  await disconnectDatabase();
  await connectDatabase();
}

export async function rejectsWith(fn, code) {
  try {
    await fn();
    return false;
  } catch (err) {
    return err?.code === code || err?.details?.code === code;
  }
}

// Serveur Express éphémère + client fetch minimal.
/**
 * Démarre le serveur du Panel sur un port LIBRE — ou sur un port IMPOSÉ.
 *
 * ── POURQUOI LE PORT IMPOSÉ EXISTE ────────────────────────────────────────
 *
 * Un projet appairé mémorise l'ADRESSE de son Panel. Éprouver « le Panel
 * revient » en le relançant sur un autre port n'éprouverait rien : le projet
 * parlerait à une adresse morte, et l'on prendrait une panne d'appairage pour
 * une panne de convergence. Le retour se fait donc sur LE MÊME port.
 */
export async function startServer(app, { port = 0 } = {}) {
  /**
   * ══ LE SERVICE EST DÉCLARÉ PRÊT — UNE SUITE QUI DÉMARRE A FINI DE DÉMARRER ═
   *
   * Le backend distingue désormais « vivant » et « prêt » : il ouvre son port
   * immédiatement et REFUSE les routes métier en `503 PANEL_SERVICE_STARTING`
   * tant que l'amorçage n'est pas terminé. C'est la bonne conception — un
   * frontend doit pouvoir distinguer « ça démarre » de « c'est cassé ».
   *
   * Mais une suite de test a déjà fait, à la main et dans l'ordre, tout ce que
   * l'amorçage fait : base montée, connexion établie, comptes semés. Sans cette
   * ligne, chaque appel HTTP de chaque suite reçoit un 503, et l'on croit lire
   * un défaut d'autorisation là où il n'y a qu'un service qui s'estime encore
   * en train de naître.
   *
   * L'import est PARESSEUX et l'échec TOLÉRÉ : le harnais ne doit pas exiger
   * l'existence d'un module de disponibilité pour démarrer un serveur.
   */
  try {
    const { markReady } = await import('../../backend/src/services/health/readiness.service.js');
    markReady();
  } catch { /* pas de garde de disponibilité dans cette version — rien à faire */ }

  const server = await new Promise((resolve) => {
    const s = app.listen(port, () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, path, { headers = {}, body } = {}) => {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: body !== undefined ? { 'content-type': 'application/json', ...headers } : headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    let json = null;
    try {
      json = await res.json();
    } catch {
      json = null;
    }
    return { status: res.status, json, headers: res.headers };
  };
  const close = () => new Promise((resolve) => server.close(resolve));
  return { base, call, close };
}

/**
 * LES MÉDIAS ÉCRITS PAR UNE RECETTE NE SURVIVENT PAS À LA RECETTE.
 *
 * ══ CE QUE CE GARDE-FOU FERME ═══════════════════════════════════════════════
 *
 * Les suites qui éprouvent le pipeline d'import écrivent de VRAIS fichiers dans
 * `uploads/` — c'est justement ce qui rend la preuve valable : aucun étage n'est
 * doublé. Mais elles n'en retiraient aucun. Trente-cinq `.webp` s'étaient
 * accumulés dans le dossier que le runtime SERT, laissés par des exécutions
 * successives.
 *
 * Ils n'ont jamais pu être commités (`uploads/` est ignoré depuis le lot B),
 * donc le dépôt n'a rien risqué. Mais un dossier de médias qui grossit à chaque
 * `npm test` finit par ressembler à des données de production, et c'est
 * exactement le genre de résidu qu'on ne distingue plus le jour où il compte.
 *
 * On ne supprime QUE ce que la recette a créé : l'inventaire est pris avant,
 * comparé après. Un fichier antérieur — un vrai média local — n'est jamais
 * touché.
 */
export function guardUploads(dossier = path.resolve(process.cwd(), 'uploads')) {
  const avant = new Set(fs.existsSync(dossier) ? fs.readdirSync(dossier) : []);
  return {
    /** Retire les fichiers apparus depuis l'inventaire. Ne lève jamais. */
    cleanup() {
      if (!fs.existsSync(dossier)) return { removed: 0 };
      let removed = 0;
      for (const nom of fs.readdirSync(dossier)) {
        if (avant.has(nom)) continue;
        try {
          fs.rmSync(path.join(dossier, nom), { force: true });
          removed += 1;
        } catch {
          // Un fichier verrouillé n'est pas une raison de faire échouer une
          // suite verte : le nettoyage est une hygiène, pas une assertion.
        }
      }
      return { removed };
    },
  };
}
