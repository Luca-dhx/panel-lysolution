/**
 * L'ARBORESCENCE D'UN PROJET, ET CE QU'UNE COPIE A LE DROIT D'EN HÉRITER.
 *
 * ══ LE DÉFAUT QUE CE MODULE FERME ═══════════════════════════════════════════
 *
 * La règle vivait dans deux ensembles nus — `COPY_DENYLIST` et
 * `COPY_EMPTY_ONLY` — posés en tête du moteur, sans dire POURQUOI un nom y
 * figurait ni, surtout, pourquoi un autre n'y figurait pas. `uploads` y était,
 * avec un commentaire remarquable expliquant qu'un clone ne doit pas hériter
 * des photos d'un autre garage. `backend/storage` n'y était pas, alors que le
 * raisonnement s'y appliquait mot pour mot.
 *
 * La première duplication faite depuis un poste ayant réellement exploité le
 * projet source a donc recopié **7 006 fichiers** : les documents contractuels
 * signés du client source, PDF compris, 41 Mo, dans le dossier d'un autre
 * client. Le défaut était invisible pour la même raison exactement que celui
 * qu'`uploads` avait déjà coûté : ces dossiers sont VIDES dans le dépôt. Une
 * duplication faite depuis un checkout neuf ne l'aurait jamais montré — et
 * `docs/DUPLICATION.md` affirmait même déjà, à tort, que ces documents « ne
 * sont JAMAIS copiés vers un duplicata ».
 *
 * ══ CE QUE CE MODULE ÉTABLIT ════════════════════════════════════════════════
 *
 * Un dossier mutable n'est plus absent ou présent d'une liste : il porte un
 * VERDICT EXPLICITE, avec son motif. Ajouter un dossier au projet sans décider
 * de son sort devient une omission visible, et non plus un défaut silencieux.
 *
 * Les quatre verdicts, et ils suffisent :
 *
 *   COPY        le défaut implicite — tout ce qui n'est pas nommé ici. Du code,
 *               de la configuration, de la documentation : ce qui fait le
 *               LOGICIEL, et qu'une copie doit évidemment recevoir.
 *   COPY_EMPTY  le DOSSIER, jamais son contenu. Il doit exister — le runtime y
 *               écrit dès la première seconde — mais ce qu'il contient
 *               appartient au client de la source.
 *   IGNORE      ni copié, ni recréé. Il n'a pas de sens hors de l'instance qui
 *               l'a produit.
 *   REGENERATE  ni copié, mais reconstruit par une phase ultérieure de la
 *               duplication (installation des dépendances) ou par un build.
 *
 * ══ ET UNE VÉRIFICATION, PARCE QU'UNE RÈGLE NON VÉRIFIÉE N'EN EST PAS UNE ═══
 *
 * `assertCleanTree()` relit la copie APRÈS coup. Une exclusion qui échoue en
 * silence produit exactement le dommage qu'elle prétendait empêcher ; ici, une
 * duplication qui aurait laissé passer un document du client source ÉCHOUE, et
 * le clone n'est jamais déclaré prêt.
 */
import path from 'node:path';
import fsPromises from 'node:fs/promises';

/** Les verdicts. Fermés : un dossier n'a pas de cinquième sort possible. */
export const TREE_POLICY = Object.freeze({
  COPY: 'COPY',
  COPY_EMPTY: 'COPY_EMPTY',
  IGNORE: 'IGNORE',
  REGENERATE: 'REGENERATE',
});

/**
 * ══ LE REGISTRE ═════════════════════════════════════════════════════════════
 *
 * `match` vaut `name` (le nom du dossier, où qu'il soit dans l'arborescence) ou
 * `path` (un chemin précis, relatif à la racine du projet). La distinction
 * compte : `node_modules` doit disparaître partout, `backend/storage` désigne
 * un dossier et un seul.
 */
export const TREE_ENTRIES = Object.freeze([
  /* ── DONNÉES DU CLIENT — le dossier, jamais le contenu ─────────────────── */
  {
    match: 'path',
    target: 'backend/uploads',
    policy: TREE_POLICY.COPY_EMPTY,
    why: 'médias du client : logo, photos de véhicules, avant/après. Ils appartiennent au client de la source.',
  },
  {
    match: 'path',
    target: 'backend/storage',
    policy: TREE_POLICY.COPY_EMPTY,
    why: 'documents contractuels signés — PDF. La copie de 7 006 d’entre eux, lors de la première duplication réelle, est ce qui a fait naître ce registre.',
  },
  {
    match: 'path',
    target: 'backend/logs',
    policy: TREE_POLICY.COPY_EMPTY,
    why: 'journaux de diagnostic et forensiques : ils nomment les destinataires e-mail et les incidents de la source.',
  },
  {
    match: 'path',
    target: 'backend/migration-reports',
    policy: TREE_POLICY.COPY_EMPTY,
    why: 'rapports de migration : ils contiennent des données métier et des sauvegardes de la source.',
  },

  /* ── PROPRE À L'INSTANCE — ni copié, ni recréé ─────────────────────────── */
  {
    match: 'name',
    target: '.git',
    policy: TREE_POLICY.IGNORE,
    why: 'une copie a son propre dépôt et sa propre histoire ; hériter de celle de la source la rendrait indissociable d’elle.',
  },
  {
    match: 'name',
    target: '.agents',
    policy: TREE_POLICY.IGNORE,
    why: 'outillage local de l’agent : documentation vendorisée et liens symboliques propres à la MACHINE. Copiés, ils suivent des chemins qui n’existent pas ailleurs.',
  },
  {
    match: 'name',
    target: '.claude',
    policy: TREE_POLICY.IGNORE,
    why: 'même nature que `.agents` : réglages et compétences locaux, jamais une propriété du projet.',
  },
  {
    match: 'name',
    target: '.recette',
    policy: TREE_POLICY.IGNORE,
    why: 'artefacts de recette locale — captures, traces, états intermédiaires.',
  },
  {
    match: 'name',
    target: 'one-off',
    policy: TREE_POLICY.IGNORE,
    why: 'réparations et recettes PONCTUELLES, câblées sur les hôtes, les bases et les incidents d’UN projet. Utiles là où elles sont nées, dangereuses partout ailleurs : lancées depuis un clone, elles visent les données d’un autre client.',
  },

  /* ── RECONSTRUIT PLUS TARD ─────────────────────────────────────────────── */
  {
    match: 'name',
    target: 'node_modules',
    policy: TREE_POLICY.REGENERATE,
    why: 'réinstallé par la phase `dependencies`, depuis le lockfile de la copie.',
  },
  { match: 'name', target: 'dist', policy: TREE_POLICY.REGENERATE, why: 'produit par le build.' },
  { match: 'name', target: 'build', policy: TREE_POLICY.REGENERATE, why: 'produit par le build.' },
  { match: 'name', target: 'coverage', policy: TREE_POLICY.REGENERATE, why: 'produit par les tests.' },
  { match: 'name', target: '.cache', policy: TREE_POLICY.REGENERATE, why: 'cache d’outil.' },
  { match: 'name', target: '.vite', policy: TREE_POLICY.REGENERATE, why: 'cache d’outil.' },
  { match: 'name', target: '.turbo', policy: TREE_POLICY.REGENERATE, why: 'cache d’outil.' },
  { match: 'name', target: '.next', policy: TREE_POLICY.REGENERATE, why: 'cache d’outil.' },
]);

const parNom = (policy) => TREE_ENTRIES
  .filter((e) => e.match === 'name' && e.policy === policy)
  .map((e) => e.target);
const parChemin = (policy) => TREE_ENTRIES
  .filter((e) => e.match === 'path' && e.policy === policy)
  .map((e) => e.target);

/**
 * Noms de dossiers jamais copiés, quel que soit leur emplacement.
 * DÉRIVÉ du registre : la liste ne se maintient plus à deux endroits.
 */
export const DENIED_DIRECTORY_NAMES = Object.freeze(new Set([
  ...parNom(TREE_POLICY.IGNORE),
  ...parNom(TREE_POLICY.REGENERATE),
]));

/** Chemins recréés VIDES : la structure, jamais le contenu. */
export const EMPTY_ONLY_PATHS = Object.freeze(parChemin(TREE_POLICY.COPY_EMPTY));

/** Le chemin relatif, normalisé en séparateurs `/` — la forme du registre. */
export function toPosix(relatif) {
  return String(relatif).split(path.sep).join('/');
}

/** Ce chemin relatif désigne-t-il un dossier à recréer vide ? */
export function isEmptyOnlyPath(relatif) {
  return EMPTY_ONLY_PATHS.includes(toPosix(relatif));
}

/** Ce nom de dossier est-il exclu partout ? */
export function isDeniedDirectoryName(name) {
  return DENIED_DIRECTORY_NAMES.has(name);
}

/**
 * ══ LA VÉRIFICATION D'APRÈS-COPIE ═══════════════════════════════════════════
 *
 * Elle relit la COPIE, pas l'intention. Trois questions, et elles ne se
 * déduisent pas l'une de l'autre :
 *
 *   1. chaque dossier déclaré vierge existe-t-il ? (le runtime y écrit tôt) ;
 *   2. est-il RÉELLEMENT vide ? ;
 *   3. un dossier exclu a-t-il malgré tout survécu ?
 *
 * Un `.gitkeep` est toléré, et lui seul : il ne porte aucune donnée, et il est
 * la façon dont le dépôt conserve un dossier vide.
 *
 * @returns {Promise<{ok: true, checked: string[]}>}
 * @throws  si la copie a hérité de quoi que ce soit qu'elle ne devait pas.
 */
const TOLERES = new Set(['.gitkeep', '.gitignore']);

export async function assertCleanTree(destRoot, { fsMod = fsPromises } = {}) {
  const checked = [];
  const fautes = [];

  for (const relatif of EMPTY_ONLY_PATHS) {
    const absolu = path.join(destRoot, ...relatif.split('/'));
    let entrees;
    try {
      entrees = await fsMod.readdir(absolu);
    } catch {
      fautes.push(`« ${relatif} » est absent de la copie : le runtime y écrit dès son premier démarrage.`);
      continue;
    }
    checked.push(relatif);
    const intrus = entrees.filter((e) => !TOLERES.has(e));
    if (intrus.length) {
      fautes.push(
        `« ${relatif} » devait être vierge et contient ${intrus.length} entrée(s) `
        + `(${intrus.slice(0, 5).join(', ')}${intrus.length > 5 ? '…' : ''}) — `
        + 'ce sont les données opérationnelles du projet source.',
      );
    }
  }

  const survivants = [];
  await (async function walk(dir) {
    let entrees;
    try { entrees = await fsMod.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entrees) {
      if (!e.isDirectory()) continue;
      if (isDeniedDirectoryName(e.name)) {
        // `node_modules` est RÉGÉNÉRÉ par la phase suivante : sa présence après
        // installation est normale. Seuls les IGNORE sont des survivants.
        const entree = TREE_ENTRIES.find((x) => x.match === 'name' && x.target === e.name);
        if (entree?.policy === TREE_POLICY.IGNORE) {
          survivants.push(toPosix(path.relative(destRoot, path.join(dir, e.name))));
        }
        continue;
      }
      await walk(path.join(dir, e.name));
    }
  })(destRoot);

  if (survivants.length) {
    fautes.push(
      `${survivants.length} dossier(s) exclu(s) ont pourtant été copiés : `
      + `${survivants.slice(0, 5).join(', ')}${survivants.length > 5 ? '…' : ''}.`,
    );
  }

  if (fautes.length) {
    const err = new Error(
      `La copie a hérité de ce qu'elle ne devait pas :\n  · ${fautes.join('\n  · ')}`,
    );
    err.code = 'DUPLICATION_TREE_NOT_CLEAN';
    err.details = { fautes };
    throw err;
  }
  return { ok: true, checked };
}

/** Projection lisible du registre — pour la documentation et les rapports. */
export function describeTreePolicy() {
  return TREE_ENTRIES.map(({ match, target, policy, why }) => ({ match, target, policy, why }));
}

export default {
  TREE_POLICY,
  TREE_ENTRIES,
  DENIED_DIRECTORY_NAMES,
  EMPTY_ONLY_PATHS,
  isEmptyOnlyPath,
  isDeniedDirectoryName,
  assertCleanTree,
  describeTreePolicy,
};
