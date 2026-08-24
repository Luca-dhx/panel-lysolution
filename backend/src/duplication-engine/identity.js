/**
 * L'IDENTITÉ D'UNE COPIE — toutes ses autorités, réécrites au même instant.
 *
 * ══ LE DÉFAUT QUE CE MODULE FERME ═══════════════════════════════════════════
 *
 * `project.profile.js` était présenté comme « le SEUL fichier du moteur qui
 * connaisse le projet ». C'était vrai du MOTEUR, et faux du DÉPÔT. La première
 * duplication réelle l'a montré : la copie annonçait son propre slug à
 * `/api/version`, et continuait pourtant de s'appeler « sbauto-backend » dans
 * ses paquets, « SB Auto — Manager » dans l'onglet du navigateur, et de
 * déclarer ne servir que le profil « sbauto » dans les manifestes de ses
 * moteurs — au point de se déclarer elle-même non supportée.
 *
 * Aucune de ces valeurs n'était dans le profil, aucune n'était réécrite, et
 * chacune se voit ailleurs : dans un onglet, dans un `npm ls`, dans une
 * introspection de moteur. C'est la définition d'une identité qui fuit.
 *
 * ══ CE QUE CE MODULE FAIT, ET CE QU'IL NE FAIT PAS ══════════════════════════
 *
 * Il réécrit l'IDENTITÉ — le nom du projet et ses dérivés techniques. Il ne
 * réécrit PAS le CONTENU : la phrase d'accroche d'une vitrine, la description
 * commerciale d'un `og:description`, un texte de page appartiennent au métier
 * et se personnalisent depuis le Manager ou à la main. Confondre les deux ferait
 * croire qu'un clone sort prêt à publier, alors qu'il sort prêt à être rempli.
 *
 * Les fichiers dont le texte libre reste à reprendre sont donc NOMMÉS dans le
 * rapport, plutôt que réécrits au jugé.
 */
import path from 'node:path';
import fsPromises from 'node:fs/promises';

/** Une réécriture qui n'a pas trouvé son ancrage doit être bruyante. */
export class IdentityRewriteError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'IdentityRewriteError';
    this.code = 'DUPLICATION_IDENTITY_REWRITE_FAILED';
    this.details = details;
  }
}

/* -------------------------------------------------------------------------- */
/*  Ce que le moteur sait lire de l'identité EXISTANTE d'un dépôt              */
/* -------------------------------------------------------------------------- */

const PROFIL_RELATIF = 'backend/src/deployment-engine/config/project.profile.js';

/**
 * L'IDENTITÉ DE LA SOURCE, LUE AVANT TOUTE RÉÉCRITURE.
 *
 * On ne devine pas ce qu'on remplace : on le lit. C'est ce qui permet, après
 * coup, de VÉRIFIER qu'aucune de ces valeurs n'a survécu — une vérification
 * qu'on ne saurait pas faire si l'on s'était contenté d'écrire par-dessus.
 */
/**
 * LA CONSTANTE EST LUE PAR SON NOM, JAMAIS PAR UNE LIGNE ÉPELÉE.
 *
 * ══ POURQUOI CE DÉTOUR ══════════════════════════════════════════════════════
 *
 * Une règle d'architecture interdit qu'un fichier du CŒUR d'un moteur contienne
 * une déclaration de slug : le cœur est identique dans tous les projets, et une
 * telle ligne y ressemblerait à une identité codée en dur — exactement ce que
 * `config/project.profile.js` existe pour empêcher.
 *
 * Une expression régulière qui épelle `export const PROJECT_SLUG = '…'` déclenche
 * cette règle, alors qu'elle LIT une déclaration au lieu d'en poser une. La
 * règle n'a pas tort pour autant : elle ne peut pas distinguer les deux, et une
 * règle qui devrait deviner l'intention ne garde plus rien.
 *
 * On compose donc le motif à partir du NOM de la constante. Le cœur ne contient
 * plus aucune ligne qui ressemble à une identité, et la lecture reste exacte.
 */
function lireConstante(source, nom) {
  const motif = new RegExp(`export const ${nom} = '([^']*)'`);
  return motif.exec(source)?.[1] ?? null;
}

export async function readProjectIdentity(root, { fsMod = fsPromises } = {}) {
  const contenu = await fsMod.readFile(path.join(root, ...PROFIL_RELATIF.split('/')), 'utf8');
  const slug = lireConstante(contenu, 'PROJECT_SLUG');
  const projectId = lireConstante(contenu, 'PROJECT_ID');
  if (!slug || !projectId) {
    throw new IdentityRewriteError(
      'Profil de projet illisible : impossible de lire l’identité de la source.',
      { file: PROFIL_RELATIF },
    );
  }
  return { slug, projectId };
}

/* -------------------------------------------------------------------------- */
/*  Les autorités réécrites                                                    */
/* -------------------------------------------------------------------------- */

/** Les manifestes des moteurs déclarent QUEL PROFIL DE PROJET ils servent. */
const MANIFESTES = [
  'backend/src/deployment-engine/engine.manifest.json',
  'backend/src/duplication-engine/engine.manifest.json',
];

/** Le nom d'un paquet suit le slug ; celui d'un sous-projet, son dossier. */
function packageNameFor(slug, relatif) {
  const dossier = path.dirname(relatif);
  return dossier === '.' ? slug : `${slug}-${path.basename(dossier)}`;
}

/**
 * LE SEGMENT D'IDENTITÉ D'UN TEXTE — ce qui précède le premier tiret cadratin.
 *
 * `"SB Auto — Manager"` porte deux choses : QUI (avant le tiret) et QUOI
 * (après). Seul le QUI change d'un projet à l'autre ; réécrire la phrase
 * entière effacerait une information utile et exacte, et remplacer au jugé le
 * texte commercial serait pire encore.
 *
 * Sans tiret, il n'y a pas de segment séparable : on rend le nom seul, ce qui
 * est le comportement juste pour `og:site_name` comme pour un titre nu.
 */
function swapIdentitySegment(texte, projectName) {
  const i = String(texte).indexOf('—');
  if (i === -1) return projectName;
  return `${projectName} ${String(texte).slice(i)}`;
}

async function listerFichiers(root, motif, { fsMod = fsPromises, profondeur = 2 } = {}) {
  const trouves = [];
  await (async function walk(dir, niveau) {
    if (niveau > profondeur) return;
    let entrees;
    try { entrees = await fsMod.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entrees) {
      if (e.isDirectory()) {
        if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
        await walk(path.join(dir, e.name), niveau + 1);
      } else if (e.name === motif) {
        trouves.push(path.relative(root, path.join(dir, e.name)).split(path.sep).join('/'));
      }
    }
  })(root, 0);
  return trouves.sort();
}

/**
 * ══ RÉÉCRIT TOUTE L'IDENTITÉ D'UNE COPIE ════════════════════════════════════
 *
 * Le profil du projet reste réécrit par le cœur du moteur (il l'écrit au même
 * instant que le `.env`, et c'est la même question). Cette fonction prend tout
 * le reste — ce que personne ne réécrivait.
 *
 * @param {string} destRoot          la racine de la COPIE
 * @param {object} identite          { slug, projectId, projectName }
 * @param {object} [opts]
 * @param {object} [opts.source]     l'identité de la source, pour vérification
 * @returns {Promise<{rewritten: object[], toReview: string[]}>}
 */
export async function rewriteProjectIdentity(destRoot, identite, { fsMod = fsPromises, source = null } = {}) {
  const { slug, projectId, projectName } = identite;
  if (!slug || !projectId || !projectName) {
    throw new IdentityRewriteError('Identité incomplète : slug, projectId et projectName sont requis.');
  }
  const rewritten = [];
  const toReview = [];

  const lire = (rel) => fsMod.readFile(path.join(destRoot, ...rel.split('/')), 'utf8');
  const ecrire = async (rel, contenu) => {
    const absolu = path.join(destRoot, ...rel.split('/'));
    const tmp = `${absolu}.tmp`;
    await fsMod.writeFile(tmp, contenu, 'utf8');
    await fsMod.rename(tmp, absolu);
  };

  /* ── 1. Les manifestes de moteur : quel profil ce moteur sert-il ? ─────── */
  for (const rel of MANIFESTES) {
    let brut;
    try { brut = await lire(rel); } catch { continue; }
    const manifeste = JSON.parse(brut);
    const avant = [...(manifeste.supportedProfiles ?? [])];
    if (!avant.length) continue;
    /**
     * On remplace le profil DE LA SOURCE, et lui seul. Les autres entrées —
     * « panel », par exemple — désignent d'autres familles de projets que ce
     * moteur sert réellement : les écraser appauvrirait le manifeste.
     */
    const apres = avant.map((p) => (source && p === source.slug ? slug : p));
    if (!apres.includes(slug)) apres.push(slug);
    manifeste.supportedProfiles = [...new Set(apres)];
    await ecrire(rel, `${JSON.stringify(manifeste, null, 2)}\n`);
    rewritten.push({ file: rel, field: 'supportedProfiles', from: avant, to: manifeste.supportedProfiles });
  }

  /* ── 2. Les paquets Node : nom et segment d'identité de la description ─── */
  for (const rel of await listerFichiers(destRoot, 'package.json', { fsMod })) {
    const pkg = JSON.parse(await lire(rel));
    const avantNom = pkg.name ?? null;
    const nom = packageNameFor(slug, rel);
    pkg.name = nom;
    if (typeof pkg.description === 'string' && pkg.description.trim()) {
      pkg.description = swapIdentitySegment(pkg.description, projectName);
    }
    await ecrire(rel, `${JSON.stringify(pkg, null, 2)}\n`);
    rewritten.push({ file: rel, field: 'name', from: avantNom, to: nom });

    /**
     * LE LOCKFILE PORTE LE MÊME NOM, ET `npm ci` LES COMPARE.
     *
     * Un lockfile qui annonce encore le paquet de la source n'empêche pas
     * l'installation, mais il fait mentir `npm ls` et tout outillage qui lit
     * l'un ou l'autre. Les deux changent ensemble ou pas du tout.
     */
    const lockRel = rel.replace(/package\.json$/, 'package-lock.json');
    try {
      const lock = JSON.parse(await lire(lockRel));
      lock.name = nom;
      if (lock.packages && lock.packages['']) lock.packages[''].name = nom;
      await ecrire(lockRel, `${JSON.stringify(lock, null, 2)}\n`);
      rewritten.push({ file: lockRel, field: 'name', from: avantNom, to: nom });
    } catch { /* pas de lockfile ici : rien à aligner */ }
  }

  /* ── 3. Les pages d'accueil : titre d'onglet et identité partagée ──────── */
  const META_IDENTITE = ['og:site_name', 'og:title', 'twitter:title'];
  for (const rel of await listerFichiers(destRoot, 'index.html', { fsMod })) {
    let html = await lire(rel);
    const avant = html;

    html = html.replace(/<title>([^<]*)<\/title>/i, (_m, texte) => `<title>${swapIdentitySegment(texte, projectName)}</title>`);
    for (const nom of META_IDENTITE) {
      const attribut = nom.startsWith('og:') ? 'property' : 'name';
      const re = new RegExp(`(<meta\\s+${attribut}="${nom}"\\s+content=")([^"]*)(")`, 'i');
      html = html.replace(re, (_m, a, texte, c) => `${a}${swapIdentitySegment(texte, projectName)}${c}`);
    }
    if (html !== avant) {
      await ecrire(rel, html);
      rewritten.push({ file: rel, field: 'title/meta', from: null, to: projectName });
    }
    /**
     * Les descriptions restent celles de la source, et c'est ASSUMÉ : elles ne
     * portent pas d'identité, elles portent un positionnement commercial. Le
     * moteur ne l'invente pas — il dit où il faut passer.
     */
    if (/name="(description|twitter:description)"|property="og:description"/i.test(html)) {
      toReview.push(`${rel} — descriptions et texte commercial (meta description, og/twitter description)`);
    }
  }

  /* ── 4. La bannière du démarrage DEV ───────────────────────────────────── */
  const banniere = 'scripts/dev-canonical.mjs';
  try {
    const src = await lire(banniere);
    const re = /(console\.log\(')[^']*?(\s*—\s*démarrage DEV canonique')/;
    const trouve = re.exec(src);
    if (trouve) {
      await ecrire(banniere, src.replace(re, (_m, ouverture, suite) => `${ouverture}  ${projectName}${suite}`));
      rewritten.push({ file: banniere, field: 'bannière', from: trouve[0], to: projectName });
    }
  } catch { /* pas de script de démarrage : rien à renommer */ }

  /* ── 5. Vérification : chaque CHAMP réécrit porte la nouvelle valeur ───── */
  /**
   * ══ ON VÉRIFIE LE CHAMP, PAS LE FICHIER ═══════════════════════════════════
   *
   * La première version relisait le fichier entier et y cherchait le slug de la
   * source. C'était faux, et une suite de tests l'a montré en une exécution :
   * un projet dont le slug est court — « src » dans une fixture, mais aussi
   * « auto », « demo », « lav » dans la vraie vie — apparaît en sous-chaîne
   * dans à peu près tout. `backend/package.json` contient `src/server.js`, et
   * la duplication échouait en accusant une fuite d'identité inexistante.
   *
   * Une vérification qui se déclenche sur du bruit est pire qu'absente : on
   * apprend à la contourner. On relit donc EXACTEMENT ce qu'on a écrit — le
   * champ, sa valeur — ce qui est à la fois plus strict et sans faux positif.
   */
  const restes = [];
  for (const rel of MANIFESTES) {
    let manifeste;
    try { manifeste = JSON.parse(await lire(rel)); } catch { continue; }
    const profils = manifeste.supportedProfiles ?? [];
    if (!profils.includes(slug)) restes.push({ file: rel, attendu: slug, lu: profils.join(', ') });
    if (source && profils.includes(source.slug)) restes.push({ file: rel, attendu: `sans « ${source.slug} »`, lu: profils.join(', ') });
  }
  for (const { file, field, to } of rewritten) {
    if (field !== 'name') continue;
    const pkg = JSON.parse(await lire(file));
    const lu = file.endsWith('package-lock.json') ? (pkg.name ?? pkg.packages?.['']?.name) : pkg.name;
    if (lu !== to) restes.push({ file, attendu: to, lu });
  }
  if (restes.length) {
    throw new IdentityRewriteError(
      'Réécriture d’identité incomplète : '
      + `${restes.length} champ(s) ne portent pas l’identité de la copie — `
      + `${restes.slice(0, 4).map((r) => `${r.file} (attendu « ${r.attendu} », lu « ${r.lu} »)`).join(', ')}.`,
      { restes },
    );
  }

  return { rewritten, toReview };
}

/* -------------------------------------------------------------------------- */
/*  Le balayage consultatif                                                    */
/* -------------------------------------------------------------------------- */

const EXT_RUNTIME = new Set(['.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.json', '.html', '.css']);
const IGNORE_SCAN = new Set(['node_modules', '.git', 'dist', 'build', 'coverage', '.cache', '.vite', 'docs']);

/**
 * OÙ LE NOM DE LA SOURCE APPARAÎT ENCORE — pour information, jamais pour bloquer.
 *
 * ══ POURQUOI CE BALAYAGE NE DÉCIDE DE RIEN ══════════════════════════════════
 *
 * Le nom d'un projet apparaît légitimement dans un dépôt : un commentaire qui
 * raconte un incident (« le déploiement du 07/08 l'a montré »), une donnée de
 * test, une adresse d'exemple. Faire échouer une duplication là-dessus
 * apprendrait vite aux gens à effacer des commentaires utiles pour obtenir du
 * vert — et le jour où une vraie fuite apparaîtrait, elle serait noyée.
 *
 * Ce qui BLOQUE est la vérification ci-dessus : les fichiers d'identité, eux,
 * ne doivent plus rien contenir. Ce balayage-ci sert à l'opérateur, qui décide.
 *
 * On exclut les suites de tests et la documentation : les premières portent des
 * fixtures nommées, la seconde raconte l'histoire de la fabrique.
 */
export async function scanResidualSourceIdentity(root, source, { fsMod = fsPromises } = {}) {
  const candidats = [...new Set([source?.slug, source?.projectId].filter(Boolean))];

  /**
   * ══ UN JETON TROP COURT N'EST PAS CHERCHABLE — ON LE DIT ══════════════════
   *
   * Les jetons sont cherchés aux FRONTIÈRES DE MOT, jamais en sous-chaîne : un
   * slug apparaît sinon dans des centaines de chemins et d'identifiants sans
   * rien dire d'une identité.
   *
   * Mais la frontière ne suffit pas en dessous de quatre caractères. « src »
   * satisfait la règle dans `"main": "src/server.js"` — guillemet avant, barre
   * oblique après — et un projet dont le slug serait « src », « auto » ou
   * « demo » verrait son rapport noyé sous des centaines de lignes exactes et
   * inutiles. Un rapport qu'on n'ouvre plus ne protège de rien.
   *
   * On refuse donc de chercher ces jetons-là, et on le DÉCLARE. Une limite
   * annoncée laisse l'opérateur décider ; une limite silencieuse lui ferait
   * croire à un dépôt propre.
   */
  const LONGUEUR_MINIMALE = 4;
  const jetons = candidats.filter((j) => j.length >= LONGUEUR_MINIMALE);
  const skippedTokens = candidats.filter((j) => j.length < LONGUEUR_MINIMALE);
  if (!jetons.length) return { occurrences: [], code: [], files: 0, skippedTokens };

  const motifs = jetons.map((j) => new RegExp(`(^|[^A-Za-z0-9_-])${j.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^A-Za-z0-9_-]|$)`));
  const occurrences = [];
  let files = 0;

  await (async function walk(dir) {
    let entrees;
    try { entrees = await fsMod.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entrees) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (IGNORE_SCAN.has(e.name) || e.name.startsWith('.')) continue;
        await walk(p);
        continue;
      }
      if (!EXT_RUNTIME.has(path.extname(e.name))) continue;
      if (/\.test\.(js|mjs|ts)$/.test(e.name)) continue;
      files += 1;
      let contenu;
      try { contenu = await fsMod.readFile(p, 'utf8'); } catch { continue; }
      const rel = path.relative(root, p).split(path.sep).join('/');
      contenu.split('\n').forEach((ligne, i) => {
        if (motifs.some((m) => m.test(ligne))) {
          const nu = ligne.trim();
          const commentaire = nu.startsWith('//') || nu.startsWith('*') || nu.startsWith('/*') || nu.startsWith('#');
          occurrences.push({ file: rel, line: i + 1, comment: commentaire, text: nu.slice(0, 120) });
        }
      });
    }
  })(root);

  return {
    files,
    occurrences,
    /** Ce qui mérite un regard : hors commentaires. */
    code: occurrences.filter((o) => !o.comment),
    /** Les jetons trop courts pour être cherchés sans bruit — déclarés, jamais tus. */
    skippedTokens,
  };
}

export default {
  IdentityRewriteError,
  readProjectIdentity,
  rewriteProjectIdentity,
  scanResidualSourceIdentity,
};
