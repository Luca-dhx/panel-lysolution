/**
 * PRÉREQUIS LOCAUX — ce qui doit être vrai sur la MACHINE QUI PILOTE, avant
 * que le déploiement n'existe.
 *
 * ── POURQUOI CE MODULE EXISTE ───────────────────────────────────────────────
 * Le contrôle de source Git vivait dans `buildArtifact`, donc à l'étape
 * `artifact.build` — c'est-à-dire APRÈS la création du run, le lancement du
 * worker, la connexion SSH, le préflight distant et, surtout, APRÈS les
 * mutations DNS réelles chez le fournisseur. Un dépôt non commité en
 * production faisait donc créer des enregistrements DNS avant d'être refusé.
 *
 * Un contrôle local est instantané et ne coûte rien : il n'a aucune raison
 * d'attendre. Il est désormais évalué AVANT toute action, et son échec
 * n'entraîne AUCUN effet de bord — ni run, ni worker, ni SSH, ni DNS, ni
 * backup, ni dossier distant.
 *
 * ── DEUX FAMILLES DE PRÉREQUIS ──────────────────────────────────────────────
 * `scope: 'local'`   dépend de la machine de l'opérateur (source Git…) ;
 * `scope: 'remote'`  dépend du serveur cible (Nginx, PM2, disque, DNS…).
 * La distinction est portée jusqu'à l'interface : l'opérateur sait
 * immédiatement s'il doit agir sur SA machine ou sur l'infrastructure.
 */
import { getGitSourceInfo, localExec, PROJECT_ROOT } from './build.js';
import { describeRootSource, inspectProjectRoot } from './projectRoot.js';

/**
 * Un contrôle, au même format que ceux du préflight distant.
 *
 * `summary` est la phrase qui nomme le PROBLÈME, à distinguer du `label` qui
 * nomme le contrôle. Les deux divergent nécessairement : un contrôle s'intitule
 * « Source Git commitée » et son échec se dit « Source Git non commitée ». Sans
 * cette distinction, l'appelant qui compose un refus à partir du `label`
 * annonce à l'opérateur l'exact contraire de ce qui s'est produit.
 */
function check(id, label, ok, { required = true, detail = null, scope = 'local', summary = null } = {}) {
  return { id, label, ok, required, detail, scope, summary: ok ? null : (summary ?? label) };
}

/**
 * Le déploiement exige-t-il une source Git commitée ?
 *
 * PRODUCTION : toujours, sans exception et sans mode « forcer ». Ce qui part
 * en production doit correspondre exactement à un commit identifiable, sans
 * quoi le manifeste embarqué annonce une version qu'on ne peut pas retrouver.
 * TEST : non — c'est l'environnement où l'on valide justement du travail en
 * cours.
 */
export function requiresCleanSource(env) {
  return String(env || 'PROD').toUpperCase() === 'PROD';
}

/**
 * Liste les fichiers qui rendent le dépôt « non commité », classés par nature
 * pour que l'opérateur sache quoi faire de chacun.
 *
 * @returns {Promise<{files:Array<{path:string, state:string}>, total:number}>}
 */
export async function listDirtyFiles(root = PROJECT_ROOT, exec = localExec) {
  const res = await exec('git', ['status', '--porcelain'], { cwd: root, timeoutMs: 10_000 })
    .catch(() => ({ code: 1, stdout: '' }));
  if (res.code !== 0) return { files: [], total: 0 };

  const files = [];
  for (const line of String(res.stdout).split(/\r?\n/)) {
    if (!line.trim()) continue;
    const code = line.slice(0, 2);
    const path = line.slice(3).trim();
    // `??` = non suivi ; sinon les deux colonnes disent index/arbre de travail.
    const state = code === '??' ? 'non suivi' : 'modifié';
    files.push({ path, state });
  }
  return { files, total: files.length };
}

/**
 * Évalue TOUS les prérequis locaux d'un déploiement.
 *
 * Aucun effet de bord : uniquement des lectures sur la machine locale.
 *
 * @param {object} args
 * @param {'TEST'|'PROD'} [args.env]  Environnement visé.
 * @param {string} [args.root]        Racine du dépôt à contrôler.
 * @param {Function} [args.exec]      Exécuteur (injectable pour les tests).
 * @returns {Promise<{ok:boolean, checks:object[], failedChecks:object[], git:object}>}
 */
export async function runLocalPreflight({
  env = 'PROD', root = null, exec = localExec, profile, fsMod, processEnv = process.env,
} = {}) {
  const checks = [];

  /**
   * ══ LES SOURCES SONT-ELLES SEULEMENT LÀ ? ═════════════════════════════════
   *
   * ── LE DÉFAUT CORRIGÉ ─────────────────────────────────────────────────────
   * Ce préflight ne contrôlait QUE la propreté Git. Une machine qui ne détient
   * pas les sources du projet le passait donc intégralement — mieux : hors
   * dépôt Git, il déclarait explicitement « contrôle non applicable » et
   * rendait `ok: true`. Le déploiement démarrait, créait son run, ouvrait SSH,
   * traversait le préflight serveur et les phases DNS, puis échouait à
   * `artifact.build` sur « vitrine/package.json manquant ».
   *
   * C'est précisément la faute que ce module existe pour interdire : un fait
   * LOCAL, connaissable instantanément et sans rien toucher, découvert APRÈS
   * des mutations distantes. La présence des sources est un prérequis local au
   * même titre que la propreté du dépôt — elle est donc contrôlée ICI.
   *
   * Ce contrôle ne remplace pas celui de `buildArtifact` : le build reste seul
   * juge au moment de construire. Il le DEVANCE, ce qui n'est pas la même
   * chose — et c'est toute la différence entre un refus sans trace et un
   * échec après DNS.
   */
  const inspection = await inspectProjectRoot({
    root, profile, env: processEnv, ...(fsMod ? { fsMod } : {}),
  });
  const racine = inspection.root;

  checks.push(check('source.layout', 'Sources du projet présentes', inspection.ok, {
    required: true,
    scope: 'local',
    summary: 'Sources du projet introuvables sur cette machine',
    detail: inspection.ok
      ? `${Object.keys(inspection.apps).length} application(s) trouvée(s) sous ${racine} `
        + `(racine ${describeRootSource(inspection.source)}).`
      : `${inspection.missing.map((m) => `${m.dir}/${m.requires}`).join(', ')} introuvable(s) sous `
        + `${racine} (racine ${describeRootSource(inspection.source)}). `
        + 'Cette machine ne détient pas les sources du projet : le déploiement ne peut pas '
        + 'construire l’artefact depuis ici.',
  }));
  // Les absents voyagent avec le contrôle, comme les fichiers non commités :
  // l'interface les affiche sans avoir à relancer quoi que ce soit.
  if (!inspection.ok) {
    checks[checks.length - 1].files = inspection.missing.map((m) => ({
      path: `${m.dir}/${m.requires}`, state: 'absent',
    }));
    checks[checks.length - 1].projectRoot = racine;
    checks[checks.length - 1].projectRootSource = inspection.source;
  }

  // Le contrôle Git porte sur la racine RETENUE — pas sur une autre. Deux
  // autorités de racine dans le même préflight en feraient un préflight qui
  // parle de deux projets.
  const git = await getGitSourceInfo(racine, exec);

  if (!git.isGit) {
    // Hors dépôt Git, il n'y a rien à exiger : on le DIT plutôt que de laisser
    // croire qu'un contrôle a été passé.
    checks.push(check('source.git', 'Source versionnée (Git)', true, {
      required: false,
      detail: 'Aucun dépôt Git détecté — contrôle de source non applicable.',
    }));
  } else {
    const mustBeClean = requiresCleanSource(env);
    const dirty = git.isDirty ? await listDirtyFiles(racine, exec) : { files: [], total: 0 };
    const ok = !git.isDirty || !mustBeClean;

    checks.push(check('source.clean', 'Source Git commitée', ok, {
      // En TEST le contrôle est informatif : il signale sans bloquer.
      required: mustBeClean,
      summary: 'Source Git non commitée',
      detail: git.isDirty
        ? `${dirty.total} fichier(s) non commité(s) sur ${git.branch || 'branche inconnue'}.`
        : `Commit ${git.shortCommit || 'inconnu'} sur ${git.branch || 'branche inconnue'}.`,
      scope: 'local',
    }));
    // Les fichiers fautifs voyagent avec le contrôle : l'interface les affiche
    // sans avoir à relancer quoi que ce soit.
    if (git.isDirty) checks[checks.length - 1].files = dirty.files;
  }

  const failedChecks = checks.filter((c) => !c.ok && c.required !== false);
  // La racine retenue voyage avec le résultat : un refus doit pouvoir NOMMER
  // l'endroit qu'il a regardé, sinon l'opérateur ne peut rien en faire.
  return {
    ok: failedChecks.length === 0,
    checks,
    failedChecks,
    git,
    projectRoot: racine,
    projectRootSource: inspection.source,
  };
}

export default { runLocalPreflight, listDirtyFiles, requiresCleanSource };
