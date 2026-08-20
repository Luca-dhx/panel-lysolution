/**
 * ISOLATION DES BASES DE TEST — le garde qui empêche une suite de polluer le parc.
 *
 * ══ CE QUE CETTE SUITE VERROUILLE ═══════════════════════════════════════════
 *
 * Sept projets de recette ont vécu dans la base Atlas `panel_test` : ils y sont
 * apparus le 15 août en une poignée de secondes, et personne ne les a vus
 * pendant quatre jours. Dans le registre du Panel, ils ressemblaient à des
 * projets ordinaires.
 *
 * Ce n'était pas une erreur de nettoyage : c'était une erreur d'ADRESSE. La
 * suite avait le droit de joindre la base partagée. Un cleanup n'aurait donc
 * rien réglé — il aurait fallu le refaire au run suivant.
 *
 * ══ CE QUI EST ÉPROUVÉ, ET DANS QUEL ORDRE ══════════════════════════════════
 *
 *   A. suite ordinaire → base isolée               → AUTORISÉ
 *   B. suite ordinaire → base partagée             → REFUS
 *   C. recette live sans opt-in                    → REFUS
 *   D. recette live + opt-in + ENV=TEST            → AUTORISÉ
 *   E. recette live + opt-in + ENV=PROD            → REFUS ABSOLU
 *   F. absence de variable de base                 → aucun repli silencieux
 *
 * On éprouve la DÉCISION plutôt qu'une connexion réelle : ouvrir une session
 * vers Atlas pour vérifier qu'on la refuse serait absurde, et ouvrir celle qui
 * doit être refusée serait exactement la faute qu'on corrige.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  GUARD_CODES,
  LIVE_RECIPE_TOKEN,
  LIVE_RECIPE_VARIABLE,
  TEST_PROCESS_VARIABLE,
  assertDatabaseAllowedForThisProcess,
  isAutomatedTestProcess,
  isLoopbackHost,
  liveRecipeRequested,
} from '../backend/src/config/testDatabaseGuard.js';

let pass = 0;
let fail = 0;
const check = (nom, cond) => {
  if (cond) { pass += 1; console.log(`  ✓ ${nom}`); } else { fail += 1; console.error(`  ✗ ${nom}`); }
};
const section = (t) => console.log(`\n${t}`);

const ici = path.dirname(fileURLToPath(import.meta.url));
const racine = path.resolve(ici, '..');

/** Une tentative de connexion, sans connexion : on interroge la DÉCISION. */
function tenter(cible) {
  try {
    return { ok: true, resultat: assertDatabaseAllowedForThisProcess(cible) };
  } catch (err) {
    return { ok: false, code: err.code, message: err.message };
  }
}

const ATLAS = { mongoHost: 'cluster0.exemple.mongodb.net', dbName: 'panel_test', env: 'TEST', isProd: false };
const MEMOIRE = { mongoHost: '127.0.0.1:51234', dbName: 'panel_test', env: 'TEST', isProd: false };
const SUITE = { isTestProcess: true, liveRecipe: false };
const RUNTIME = { isTestProcess: false, liveRecipe: false };
const AVEC_OPT_IN = { isTestProcess: true, liveRecipe: true };

/* ══════════════════════════════════════════════════════════════════════════ */
section('A · Suite ordinaire → base isolée : AUTORISÉ');
{
  const r = tenter({ ...MEMOIRE, ...SUITE });
  check('un serveur en mémoire (port éphémère de boucle locale) est accepté', r.ok);
  check('…et la raison le dit', r.resultat?.reason === 'BASE_ISOLEE');

  check('un mongod de poste est accepté', tenter({ ...MEMOIRE, mongoHost: 'localhost:27017', ...SUITE }).ok);
  check('127.0.0.2 est encore de la boucle locale', isLoopbackHost('127.0.0.2:27017'));
  check('l’IPv6 de boucle locale, bracketée avec port', isLoopbackHost('[::1]:27017'));
  check('…bracketée sans port', isLoopbackHost('[::1]'));
  check('…et nue', isLoopbackHost('::1'));

  /** Une IPv6 PUBLIQUE ne doit pas être prise pour de la boucle locale. */
  check('une IPv6 publique reste distante', !isLoopbackHost('[2001:db8:85a3::1]:27017'));
  check('un hôte sans port reste jugé sur son nom', !isLoopbackHost('cluster0.mongodb.net'));
  check('une chaîne vide n’est pas de la boucle locale', !isLoopbackHost(''));
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('B · Suite ordinaire → base PARTAGÉE : REFUS');
{
  const r = tenter({ ...ATLAS, ...SUITE });
  check('la connexion est REFUSÉE', !r.ok);
  check('le refus porte un code stable', r.code === GUARD_CODES.SHARED_DATABASE_FORBIDDEN_IN_TESTS);
  check('…et nomme l’hôte visé', /cluster0\.exemple\.mongodb\.net/.test(r.message ?? ''));
  check('…et indique comment faire une recette live', (r.message ?? '').includes(LIVE_RECIPE_VARIABLE));

  /**
   * LA RÈGLE EST GÉOGRAPHIQUE, PAS NOMINATIVE. Interdire nommément le cluster
   * d'aujourd'hui laisserait passer celui de demain.
   */
  const autre = tenter({ ...ATLAS, mongoHost: 'cluster-de-demain.exemple.net', ...SUITE });
  check('un cluster JAMAIS VU est refusé de la même façon',
    !autre.ok && autre.code === GUARD_CODES.SHARED_DATABASE_FORBIDDEN_IN_TESTS);

  /** Le runtime réel, lui, DOIT pouvoir joindre sa base. */
  const runtime = tenter({ ...ATLAS, ...RUNTIME });
  check('le backend réel n’est pas entravé', runtime.ok && runtime.resultat.reason === 'RUNTIME');
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('C · Recette live SANS opt-in : REFUS');
{
  check('une valeur approximative ne vaut pas autorisation', !liveRecipeRequested('oui'));
  check('une variable vide non plus', !liveRecipeRequested(''));
  check('une variable absente non plus', !liveRecipeRequested(undefined));
  check('la casse compte — le jeton doit être exact', !liveRecipeRequested(LIVE_RECIPE_TOKEN.toLowerCase()));
  check('un jeton approchant est refusé par le garde',
    !tenter({ ...ATLAS, isTestProcess: true, liveRecipe: liveRecipeRequested('true') }).ok);
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('D · Recette live + opt-in explicite + ENV=TEST : AUTORISÉ');
{
  const r = tenter({ ...ATLAS, ...AVEC_OPT_IN });
  check('la recette live explicite passe', r.ok);
  check('…et la raison est tracée', r.resultat?.reason === 'RECETTE_LIVE_EXPLICITE');
  check('le jeton exact est reconnu', liveRecipeRequested(LIVE_RECIPE_TOKEN));
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('E · Recette live + opt-in + PROD : REFUS ABSOLU');
{
  const PROD = { mongoHost: 'cluster0.exemple.mongodb.net', dbName: 'panel_prod' };

  const parIsProd = tenter({ ...PROD, env: 'PROD', isProd: true, ...AVEC_OPT_IN });
  check('PROD est refusée malgré l’opt-in', !parIsProd.ok);
  check('…avec son propre code', parIsProd.code === GUARD_CODES.LIVE_RECIPE_FORBIDDEN_IN_PROD);

  /** Même si le drapeau `isProd` a été mal calculé, l'étiquette suffit. */
  const parEtiquette = tenter({ ...PROD, env: 'PROD', isProd: false, ...AVEC_OPT_IN });
  check('ENV=PROD seul suffit à refuser',
    !parEtiquette.ok && parEtiquette.code === GUARD_CODES.LIVE_RECIPE_FORBIDDEN_IN_PROD);

  /** Et même hors suite : une recette live ne vise jamais la production. */
  const depuisRuntime = tenter({ ...PROD, env: 'PROD', isProd: true, isTestProcess: false, liveRecipe: true });
  check('le contrôle PROD précède la sortie « runtime »', !depuisRuntime.ok);

  /** Sans opt-in, le vrai Panel de production démarre normalement. */
  const prodNormale = tenter({ ...PROD, env: 'PROD', isProd: true, ...RUNTIME });
  check('un Panel de PRODUCTION ordinaire n’est pas entravé', prodNormale.ok);
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('F · Aucun repli silencieux vers la base partagée');
{
  /** `env.js` est fail-closed : sans URI, il refuse au lieu de deviner. */
  const envSource = fs.readFileSync(path.join(racine, 'backend/src/config/env.js'), 'utf8');
  check('MONGODB_URI n’a AUCUNE valeur par défaut dans la configuration',
    /MONGODB_URI est requise et n’a aucune valeur par défaut/.test(envSource));

  /**
   * LA FAILLE D'ORIGINE. Le harnais conservait une URI ambiante ; le nom de
   * base, lui, était celui de la base partagée. Il ne doit plus jamais hériter.
   */
  const harnais = fs.readFileSync(path.join(racine, 'tests/helpers/harness.js'), 'utf8');
  check('le harnais n’hérite plus d’une MONGODB_URI ambiante',
    !/process\.env\.MONGODB_URI\s*=\s*process\.env\.MONGODB_URI\s*\?\?/.test(harnais));
  check('…il l’écrase par une adresse de boucle locale',
    /process\.env\.MONGODB_URI\s*=\s*'mongodb:\/\/127\.0\.0\.1/.test(harnais));
  check('…sauf recette live explicitement déclarée',
    /liveRecipeRequested\(process\.env\[LIVE_RECIPE_VARIABLE\]\)/.test(harnais));
  check('le harnais marque ses processus enfants',
    /TEST_PROCESS_VARIABLE\]\s*=\s*'1'/.test(harnais));
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('G · Le garde est POSÉ sur le chemin de connexion, pas seulement écrit');
{
  const dbSource = fs.readFileSync(path.join(racine, 'backend/src/config/db.js'), 'utf8');
  check('connectDatabase() consulte le garde',
    /assertDatabaseAllowedForThisProcess\(/.test(dbSource));
  check('…en lui passant la nature du processus',
    /isTestProcess:\s*config\.isTestProcess/.test(dbSource) && /liveRecipe:\s*config\.liveRecipe/.test(dbSource));

  /** Avant `mongoose.connect` : refuser après avoir ouvert ne refuse rien. */
  const posGarde = dbSource.indexOf('assertDatabaseAllowedForThisProcess(');
  const posConnect = dbSource.indexOf('mongoose.connect(');
  check('…AVANT d’ouvrir la connexion', posGarde !== -1 && posConnect !== -1 && posGarde < posConnect);

  /**
   * UNE SEULE PORTE VERS L'ENVIRONNEMENT. Le garde ne lit rien lui-même :
   * `config/env.js` établit les signaux et les lui passe. Un module qui lirait
   * `process.env` de son côté rouvrirait une porte que l'architecture ferme.
   *
   * On juge le CODE, pas la prose : les commentaires du garde CITENT la ligne
   * fautive d'origine pour l'expliquer. Les compter comme des lectures
   * interdirait d'écrire pourquoi elles le sont.
   */
  const sansCommentaires = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const gardeCode = sansCommentaires(
    fs.readFileSync(path.join(racine, 'backend/src/config/testDatabaseGuard.js'), 'utf8'),
  );
  check('le garde ne lit JAMAIS process.env lui-même', !/process\.env/.test(gardeCode));
  check('…ni process.argv', !/process\.argv/.test(gardeCode));

  const configSource = fs.readFileSync(path.join(racine, 'backend/src/config/env.js'), 'utf8');
  check('c’est env.js qui établit la nature du processus',
    /isAutomatedTestProcess\(\{/.test(configSource)
    && /liveRecipeRequested\(process\.env\[/.test(configSource));
  check('…et il l’expose à la configuration',
    /isTestProcess,/.test(configSource) && /liveRecipe,/.test(configSource));
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('H · Reconnaissance d’un processus de test');
{
  const entree = (p, extra = {}) => isAutomatedTestProcess({ entryPath: p, ...extra });

  check('un fichier .test.js est un processus de test', entree('/p/tests/a.test.js'));
  check('un .check.mjs aussi', entree('/p/tests/spec-drift.check.mjs'));
  check('un fichier du dossier tests/ aussi', entree('/p/tests/helpers/boot.mjs'));
  check('un chemin Windows en antislash aussi', entree('D\\\\p\\\\tests\\\\a.test.js'));
  check('un enfant marqué par sa suite aussi',
    isAutomatedTestProcess({ entryPath: '/p/backend/src/server.js', testProcessFlag: '1' }));
  check('NODE_ENV=test aussi',
    isAutomatedTestProcess({ entryPath: '/p/backend/src/server.js', nodeEnv: 'test' }));

  /**
   * `src/scripts/` N'EST PAS UN CRITÈRE. On y trouve des suites, mais aussi des
   * migrations et des amorçages qui ont légitimement besoin de la vraie base.
   * C'est le suffixe du fichier qui tranche.
   */
  check('une migration n’est PAS un processus de test',
    !entree('/p/backend/src/scripts/migrations/2026-08-15-x.js'));
  check('un amorçage non plus', !entree('/p/backend/src/scripts/panel-accounts-bootstrap.js'));
  check('le serveur non plus', !entree('/p/backend/src/server.js'));
  check('un point d’entrée vide non plus', !entree(''));

  /**
   * ══ LE FAUX POSITIF QUI COUPERAIT LE SERVICE ══════════════════════════════
   *
   * Ce garde est fail-closed : un runtime classé « test » par erreur REFUSERAIT
   * sa propre base et le service ne démarrerait pas. Le risque se paie donc en
   * indisponibilité, pas en donnée abîmée — raison de plus pour le borner.
   *
   * Seul un segment de répertoire nommé EXACTEMENT `test` ou `tests` compte ;
   * jamais une sous-chaîne, fût-elle dans un nom de domaine.
   */
  const deploiements = [
    '/var/www/panel.ly-solution.com/backend/src/server.js',
    '/var/www/demo-sbauto06.ly-solution.com/backend/src/server.js',
    '/var/www/demo-test.exemple.com/backend/src/server.js',
    '/var/www/latest-release/backend/src/server.js',
    '/var/www/contest/backend/src/server.js',
    '/var/www/site.test.exemple.com/backend/src/server.js',
    '/srv/testament/backend/src/server.js',
  ];
  for (const d of deploiements) {
    check(`déploiement réel NON classé test : ${d.slice(0, 48)}`, !entree(d));
  }

  /** En revanche un vrai répertoire `tests/` reste bien reconnu. */
  check('un segment de répertoire exactement « tests » est reconnu', entree('/var/www/app/tests/boot.mjs'));
  check('…et « test » au singulier aussi', entree('/var/www/app/test/boot.mjs'));
}

console.log(`\n${pass} réussis, ${fail} échoués`);
process.exit(fail === 0 ? 0 : 1);
