/**
 * POINT DE TERMINAISON DE HARNAIS ≠ DESTINATION PUBLIQUE D'UN PROJET.
 *
 * ══ LE CONFLIT QUE CE FICHIER ARBITRE ═══════════════════════════════════════
 *
 * Une garde de production refuse qu'une destination de projet soit une adresse
 * privée : un Panel qui retiendrait `http://127.0.0.1:4000` comme adresse
 * publique enregistrerait une adresse qui ne désigne rien hors de la machine
 * où elle a été saisie. C'est un vrai invariant, et il ne se négocie pas.
 *
 * Mais les recettes de bout en bout du Panel démarrent de VRAIS projets, sur
 * des ports éphémères de la boucle locale — c'est précisément ce qui fait
 * qu'elles éprouvent le produit plutôt qu'une maquette. La garde les a donc
 * cassées en bloc.
 *
 * ══ LES DEUX RÉPONSES REFUSÉES ══════════════════════════════════════════════
 *
 *   rendre `127.0.0.1` acceptable en production  → c'est retirer la garde
 *   sauter les recettes concernées               → c'est cesser d'éprouver
 *
 * ══ CE QUI EST FAIT À LA PLACE, ET CE QUE CE FICHIER PROUVE ═════════════════
 *
 * La distinction ne porte pas sur l'adresse : elle porte sur le RUNTIME qui la
 * reçoit. Un Panel lancé par une suite de test n'est pas le même programme
 * qu'un Panel de production.
 *
 * Trois propriétés, et ce fichier n'existe que pour elles :
 *
 *   1. la marque vient de `process.env`, JAMAIS d'une requête — inforgeable
 *      depuis un corps, un en-tête ou un paramètre d'écran ;
 *   2. elle n'ouvre QUE la boucle locale — pas le réseau privé, pas `.internal` ;
 *   3. `ENV=PROD` refuse malgré la marque. Il n'existe aucune combinaison de
 *      variables qui autorise une adresse locale sur une production.
 */
import { check, finish, section, setTestEnv } from './helpers/harness.js';

setTestEnv();

const { TEST_PROCESS_VARIABLE } = await import(
  '../backend/src/config/testDatabaseGuard.js');
const {
  isTestHarnessRuntime, isLoopbackUrl, isTestHarnessEndpoint,
} = await import('../backend/src/config/testHarnessRuntime.js');
const { isPubliclyRoutableBackendUrl } = await import(
  '../backend/src/services/registry/projectNetworkDeclaration.js');

/** Exécute `fn` sous un environnement de processus donné, puis restaure. */
function sous({ marque, env }, fn) {
  const memoireMarque = process.env[TEST_PROCESS_VARIABLE];
  const memoireEnv = process.env.ENV;
  if (marque === undefined) delete process.env[TEST_PROCESS_VARIABLE];
  else process.env[TEST_PROCESS_VARIABLE] = marque;
  if (env !== undefined) process.env.ENV = env;
  try { return fn(); } finally {
    if (memoireMarque === undefined) delete process.env[TEST_PROCESS_VARIABLE];
    else process.env[TEST_PROCESS_VARIABLE] = memoireMarque;
    process.env.ENV = memoireEnv;
  }
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('1 · La garde de production est INTACTE');
{
  /**
   * `isPubliclyRoutableBackendUrl` n'a pas bougé d'un caractère, et c'est elle
   * qui décide pour une vraie destination. On le vérifie explicitement, parce
   * qu'une garde qu'on entoure d'une exception mérite qu'on redise ce qu'elle
   * refuse toujours.
   */
  for (const url of [
    'http://127.0.0.1:4000', 'https://localhost', 'http://10.0.0.5',
    'http://192.168.1.20', 'http://172.16.4.4', 'http://169.254.1.1',
    'https://api.local', 'https://api.internal', 'http://machine',
  ]) {
    check(`refusée comme destination publique : ${url}`, !isPubliclyRoutableBackendUrl(url));
  }
  for (const url of ['https://api.exemple.fr', 'https://demo-projet.exemple.com']) {
    check(`acceptée comme destination publique : ${url}`, isPubliclyRoutableBackendUrl(url));
  }
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('2 · La marque ne vient QUE du processus');
{
  check('sous la marque, ce runtime est un harnais',
    sous({ marque: '1', env: 'TEST' }, isTestHarnessRuntime) === true);
  check('sans la marque, il ne l’est pas',
    sous({ marque: undefined, env: 'TEST' }, isTestHarnessRuntime) === false);
  check('une valeur approchante ne suffit pas',
    sous({ marque: 'true', env: 'TEST' }, isTestHarnessRuntime) === false);
  check('une chaîne vide non plus',
    sous({ marque: '', env: 'TEST' }, isTestHarnessRuntime) === false);

  /**
   * ══ L'INFORGEABILITÉ, ÉPROUVÉE PLUTÔT QU'AFFIRMÉE ═══════════════════════
   *
   * La fonction ne prend AUCUN argument. Il n'existe donc pas de paramètre par
   * lequel un appelant — contrôleur, service, middleware — pourrait la faire
   * mentir : il faudrait déjà pouvoir choisir l'environnement du processus,
   * c'est-à-dire être celui qui le démarre.
   *
   * C'est plus fort qu'une validation d'entrée : il n'y a pas d'entrée.
   */
  check('la décision ne prend aucun paramètre', isTestHarnessRuntime.length === 0);

  const source = (await import('node:fs')).readFileSync(
    new URL('../backend/src/config/testHarnessRuntime.js', import.meta.url), 'utf8',
  ).replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\r\n]*/g, ' ');
  check('…et ne lit ni corps, ni en-tête, ni requête',
    !/\breq\b|\bheaders?\b|\bbody\b|\bquery\b|\bparams\b/i.test(source));
  /**
   * La LECTURE de l'environnement a déménagé dans `config/env.js`, seul lecteur
   * autorisé — la règle d'architecture du Panel, et elle vaut aussi pour cette
   * garde-ci. Ce module porte la règle, pas l'accès.
   */
  check('…et délègue la lecture au seul lecteur autorisé',
    /testHarnessRuntimeRequested/.test(source) && !/process\.env/.test(source));
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('3 · Elle n’ouvre que la BOUCLE LOCALE');
{
  for (const url of ['http://127.0.0.1:6100', 'http://127.0.0.5:80', 'http://localhost:4000', 'http://[::1]:9000']) {
    check(`boucle locale reconnue : ${url}`, isLoopbackUrl(url));
    check(`…et admise sous la marque : ${url}`,
      sous({ marque: '1', env: 'TEST' }, () => isTestHarnessEndpoint(url)));
  }

  /**
   * ── CE QUE LA MARQUE N'OUVRE PAS ────────────────────────────────────────
   *
   * Un réseau privé n'est pas une boucle locale. Une suite ne parle qu'à
   * elle-même ; élargir au `10.0.0.0/8` autoriserait une destination sur le
   * réseau interne d'un bureau — précisément le genre d'adresse qui se retrouve
   * en base et n'y désigne plus rien six mois plus tard.
   */
  for (const url of ['http://10.0.0.5:80', 'http://192.168.1.20', 'http://172.16.4.4',
    'https://api.internal', 'https://api.local', 'https://api.exemple.fr']) {
    check(`hors boucle locale, refusée même sous la marque : ${url}`,
      !sous({ marque: '1', env: 'TEST' }, () => isTestHarnessEndpoint(url)));
  }
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('4 · LA PRODUCTION RESTE HORS D’ATTEINTE');
{
  /**
   * Le contrôle le plus important du fichier. Si celui-ci tombe, tout le reste
   * n'était qu'une façon élégante de retirer la garde.
   */
  check('en PROD, la marque ne fait pas d’un runtime un harnais',
    sous({ marque: '1', env: 'PROD' }, isTestHarnessRuntime) === false);
  for (const url of ['http://127.0.0.1:6100', 'http://localhost:4000', 'http://[::1]:9000']) {
    check(`en PROD, ${url} reste refusée malgré la marque`,
      !sous({ marque: '1', env: 'PROD' }, () => isTestHarnessEndpoint(url)));
  }
  check('…et un `ENV` en minuscules ne contourne rien',
    sous({ marque: '1', env: 'prod' }, isTestHarnessRuntime) === false);
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('5 · Un seul marqueur, un seul endroit où il est défini');
{
  /**
   * La marque est CELLE de l'isolation des bases. Deux marqueurs distincts
   * finiraient par diverger : un processus reconnu comme harnais par l'une et
   * pas par l'autre est exactement l'état dont personne ne saurait raisonner.
   */
  const lecteur = (await import('node:fs')).readFileSync(
    new URL('../backend/src/config/env.js', import.meta.url), 'utf8',
  );
  check('le lecteur unique IMPORTE le marqueur de la garde des bases',
    /TEST_PROCESS_VARIABLE/.test(lecteur)
    && /from '\.\/testDatabaseGuard\.js'/.test(lecteur));
  check('…et sa valeur est bien celle-là', TEST_PROCESS_VARIABLE === 'PANEL_TEST_PROCESS');
  check('…le marqueur n’est déclaré qu’à un seul endroit',
    (lecteur.match(/TEST_PROCESS_VARIABLE\s*=/g) ?? []).length === 0);
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('6 · LE HARNAIS REND SON DISQUE, MÊME QUAND UNE SUITE TOMBE');
{
  /**
   * ══ 133 Go, ET ONZE SUITES ROUGES QUI NE L'ÉTAIENT PAS ══════════════════
   *
   * `MongoMemoryServer` alloue ~200 Mo de données WiredTiger et ne les rend
   * qu'à `stop()`. Une suite qui lève avant d'y arriver les laisse derrière
   * elle ; `finish()` n'aide pas, il appelle `process.exit()`.
   *
   * 658 répertoires abandonnés ont rempli le disque. mongod ne démarrait alors
   * plus DU TOUT : onze suites échouaient d'un coup sur un `fassert() failure`
   * illisible, sans exécuter un seul contrôle — et ont été comptées « rouges
   * préexistantes » pendant des semaines. Aucune ne l'était.
   *
   * ══ ET LE PREMIER CORRECTIF NE FAISAIT RIEN ═════════════════════════════
   *
   * Il lisait `serveur.instance.dbPath`. Cette propriété n'existe pas :
   * `instance` n'a aucune propriété énumérable, la lecture rendait `undefined`,
   * l'effacement ne portait sur rien — et aucune erreur ne le disait. Un filet
   * qui ne rattrape rien est pire qu'un filet absent : on cesse de regarder.
   *
   * Le chemin vit sur `instanceInfo`. Ce contrôle éprouve la LECTURE et les
   * FILETS, sans démarrer de mongod : la preuve d'exécution a été faite une
   * fois, en provoquant une panne ; celle-ci protège la ligne qui la rend
   * possible.
   */
  const harnais = (await import('node:fs')).readFileSync(
    new URL('./helpers/harness.js', import.meta.url), 'utf8',
  );
  const code = harnais.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\r\n]*/g, ' ');

  check('le chemin des données est lu sur `instanceInfo`',
    /instanceInfo\s*\?\?/.test(code) && /dbPath/.test(code));
  check('…et jamais sur `instance.dbPath`, qui n’existe pas',
    !/instance\s*\?\.\s*dbPath/.test(code));
  check('un filet est armé sur la SORTIE du processus', /process\.on\('exit'/.test(code));
  check('…un autre sur une exception non rattrapée', /'uncaughtException'/.test(code));
  check('…un autre sur un rejet non rattrapé', /'unhandledRejection'/.test(code));
  /**
   * ── ET CES DEUX-LÀ SAVENT SE TAIRE ──────────────────────────────────────
   *
   * Deux suites provoquent EXPRÈS un rejet orphelin, pour vérifier qu'il laisse
   * une trace dans le run de déploiement. Un harnais qui s'en saisit et sort en
   * `1` leur vole leur sujet et rend rouges deux suites vertes. Il ne prend donc
   * la main que si personne d'autre n'écoute.
   */
  check('…et ils cèdent le pas à qui écoute déjà', /listenerCount\(/.test(code));
  check('…le processus mongod est tué avant l’effacement',
    /mongodProcess/.test(code) && code.indexOf('mongodProcess') < code.indexOf('fs.rmSync'));
  check('…et sur les interruptions', /SIGINT/.test(code) && /SIGTERM/.test(code));
  check('l’effacement est SYNCHRONE sur la sortie — rien ne peut être attendu là',
    /fs\.rmSync\(/.test(code));
  check('les filets sont armés au DÉMARRAGE, pas au démontage',
    code.indexOf('armerLeNettoyage(memoryServer)') > 0
    && code.indexOf('armerLeNettoyage(memoryServer)') < code.indexOf('export async function stopMemoryMongo'));
}

finish();
