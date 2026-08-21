/* AUCUN IDENTIFIANT NON DÉCLARÉ DANS LE RUNTIME — la garde qui manquait.
 *
 * ══ POURQUOI CETTE SUITE EXISTE ════════════════════════════════════════════
 *
 * Le dépôt PROJET a mis deux fois en production une `ReferenceError` :
 *
 *   · `erreurFinalisation is not defined` — une variable déclarée dans un bloc
 *     `if`, lue en dehors. Un préflight de déploiement échouait toujours ;
 *
 *   · `provider is not defined` — un troisième argument résiduel d'un refactor.
 *     Le bouton « Vérifier le paiement » rendait 500 à tous les coups, et la
 *     seule réparation manuelle d'un abonnement bloqué était morte depuis le
 *     jour du refactor.
 *
 * Le Panel n'en a connu aucune, et ce n'est pas une raison de s'en dispenser :
 * il porte le plan de contrôle, les webhooks et le registre financier. Une
 * `ReferenceError` sur un chemin de webhook y produirait une 500, donc un rejeu
 * du fournisseur en boucle, sur un paiement réel.
 *
 * Les deux ont la même forme, et surtout la même signature : le code se CHARGE
 * parfaitement, il ne casse qu'à l'exécution de la ligne fautive. Aucun test
 * unitaire ne les attrape s'il n'exerce pas précisément ce chemin, et aucune
 * relecture ne les voit — un identifiant qui n'existe pas ressemble en tout
 * point à un identifiant qui existe.
 *
 * ══ CE QU'ON MESURE, ET AVEC QUOI ═══════════════════════════════════════════
 *
 * Le compilateur TypeScript en mode `checkJs`, dont on ne retient QU'UNE
 * famille de diagnostics : `TS2304 — Cannot find name`. C'est exactement
 * `no-undef`, sans installer de linter et sans discuter de style : on ne juge
 * pas le code, on constate qu'un nom n'est lié à rien.
 *
 * Les globales de la plateforme sont exclues nominativement plutôt que par un
 * fichier de types : la liste est courte, elle se lit, et elle ne dépend
 * d'aucun paquet à installer.
 *
 * ══ ELLE SE RETIRE PROPREMENT ═══════════════════════════════════════════════
 *
 * `typescript` n'est pas une dépendance du backend — il vit dans les
 * node_modules du Manager. Absent, cette suite ne rougit PAS : elle annonce
 * qu'elle n'a rien pu vérifier et sort en succès. Une garde qui casse la chaîne
 * parce qu'un dossier voisin n'est pas installé finit par être désactivée, et
 * c'est le pire des résultats. */
import { spawnSync } from 'node:child_process';
import {
  existsSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ici = path.dirname(fileURLToPath(import.meta.url));
const racineBackend = path.resolve(ici, '..', 'backend');
const src = path.join(racineBackend, 'src');

let pass = 0;
let fail = 0;
function check(name, cond) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.error(`  ✗ ${name}`); }
}

/**
 * LES NOMS FOURNIS PAR LA PLATEFORME — Node, le Web, les temporisateurs.
 *
 * Ils ne sont pas « autorisés » : ils sont RÉELLEMENT définis à l'exécution.
 * Sans `@types/node`, le compilateur ne le sait pas et les signale tous. Les
 * exclure ici est donc une correction de son ignorance, pas une exemption.
 */
const GLOBALES = new Set([
  'Buffer', 'process', 'console', '__dirname', '__filename', 'require', 'module', 'exports',
  'global', 'globalThis', 'setTimeout', 'setInterval', 'setImmediate', 'clearTimeout',
  'clearInterval', 'clearImmediate', 'URL', 'URLSearchParams', 'TextEncoder', 'TextDecoder',
  'fetch', 'AbortController', 'AbortSignal', 'structuredClone', 'queueMicrotask', 'crypto',
  'Blob', 'File', 'FormData', 'Headers', 'Request', 'Response', 'ReadableStream',
  'WritableStream', 'TransformStream', 'performance', 'NodeJS', 'BufferEncoding',
]);

function fichiersJs(dossier) {
  const sortie = [];
  for (const entree of readdirSync(dossier)) {
    const complet = path.join(dossier, entree);
    if (statSync(complet).isDirectory()) sortie.push(...fichiersJs(complet));
    else if (entree.endsWith('.js')) sortie.push(complet);
  }
  return sortie;
}

function trouverTsc() {
  const candidats = [
    path.join(racineBackend, 'node_modules', 'typescript', 'bin', 'tsc'),
    path.join(racineBackend, '..', 'frontend', 'node_modules', 'typescript', 'bin', 'tsc'),
  ];
  return candidats.find((c) => existsSync(c)) ?? null;
}

console.log('\nAUCUN IDENTIFIANT NON DÉCLARÉ');

const tsc = trouverTsc();
if (!tsc) {
  console.log('  · typescript introuvable — contrôle non exécuté, aucune conclusion tirée.');
  console.log('\n0 réussis, 0 échoués');
  process.exit(0);
}

const fichiers = fichiersJs(src);
check(`le périmètre n'est pas vide (${fichiers.length} fichier(s))`, fichiers.length > 50);

/**
 * LES CINQ CENTS CHEMINS PASSENT PAR UN FICHIER, PAS PAR LA LIGNE DE COMMANDE.
 *
 * ══ LE PIÈGE QUE CELA FERME ═════════════════════════════════════════════════
 *
 * Windows plafonne une ligne de commande à environ 32 000 caractères. Passer
 * les fichiers en arguments dépassait ce plafond dès la première exécution
 * réelle : le processus ne démarrait pas, `status` valait `null`, la sortie
 * était VIDE — et une sortie vide se lit « aucune faute trouvée ».
 *
 * La garde passait donc au vert en n'ayant rien vérifié du tout. C'est le pire
 * mode de défaillance qu'un contrôle puisse avoir, et c'est exactement pour ce
 * genre de silence que cette suite existe. On utilise donc le fichier de
 * réponse de `tsc` (`@fichier`), et l'on VÉRIFIE que le processus a bien tourné.
 */
const atelier = mkdtempSync(path.join(os.tmpdir(), 'no-undef-'));
const reponse = path.join(atelier, 'args.txt');
writeFileSync(
  reponse,
  [
    '--allowJs', '--checkJs', '--noEmit',
    '--module', 'esnext', '--target', 'es2022',
    '--moduleResolution', 'bundler', '--skipLibCheck',
    // Guillemets : les chemins du parc contiennent des espaces (« Dev Web »).
    ...fichiers.map((f) => `"${f.split(path.sep).join('/')}"`),
  ].join('\n'),
  'utf8',
);

const resultat = spawnSync(
  process.execPath,
  [tsc, `@${reponse}`],
  { encoding: 'utf8', cwd: racineBackend, maxBuffer: 64 * 1024 * 1024 },
);
rmSync(atelier, { recursive: true, force: true });

const sortie = `${resultat.stdout ?? ''}${resultat.stderr ?? ''}`;

/**
 * LE CONTRÔLE A-T-IL RÉELLEMENT EU LIEU ?
 *
 * `status: 0` signifie « aucun diagnostic », `status: 2` signifie « des
 * diagnostics » — les deux sont des exécutions valides. Tout le reste (un
 * `null` de processus non démarré, un `error` de spawn) signifie qu'on n'a
 * rien mesuré, et cela doit ROUGIR plutôt que de passer pour un succès.
 */
check(
  'le compilateur a réellement tourné',
  !resultat.error && [0, 1, 2].includes(resultat.status) && sortie.length > 0,
);

/**
 * `TS2304` et `TS2580` disent la même chose : « ce nom n'est lié à rien ». Le
 * second est le message aimable réservé aux globales Node quand les types ne
 * sont pas installés — on le lit donc AUSSI, sans quoi une vraie faute portant
 * un nom proche d'une globale passerait au travers.
 */
const LIGNE = /^(.+?)\((\d+),(\d+)\): error TS(2304|2580): Cannot find name '([^']+)'/gm;

const fautes = [];
for (const m of sortie.matchAll(LIGNE)) {
  const [, fichier, ligne, colonne, , nom] = m;
  if (GLOBALES.has(nom)) continue;
  fautes.push({ fichier: path.relative(racineBackend, fichier), ligne, colonne, nom });
}

/**
 * AUCUNE REPRODUCTION VOLONTAIRE DANS CE DÉPÔT — la liste est vide, et elle
 * existe quand même.
 *
 * Le dépôt projet, lui, garde une `ReferenceError` délibérée dans
 * `first-preflight.test.js` : elle rejoue un défaut de production pour prouver
 * qu'il levait bien. Le jour où le Panel en écrira une, c'est ici qu'elle
 * s'inscrira — nommément, jamais par un motif « les tests ne comptent pas »,
 * qui aveuglerait la garde sur toutes les autres suites.
 */
const REPRODUCTIONS_VOLONTAIRES = new Set([]);

const reelles = fautes.filter((f) => !REPRODUCTIONS_VOLONTAIRES.has(f.fichier));

for (const f of reelles) {
  console.error(`      ${f.fichier}:${f.ligne}:${f.colonne} — « ${f.nom} » n'est lié à rien`);
}

check('aucun identifiant non déclaré dans le code', reelles.length === 0);
check('aucune exemption n’a été posée sans reproduction correspondante',
  [...REPRODUCTIONS_VOLONTAIRES].every((f) => fautes.some((x) => x.fichier === f)));

console.log(`\n${pass} réussis, ${fail} échoués`);
process.exit(fail === 0 ? 0 : 1);
