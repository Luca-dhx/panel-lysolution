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

/** Un contrôle, au même format que ceux du préflight distant. */
function check(id, label, ok, { required = true, detail = null, scope = 'local' } = {}) {
  return { id, label, ok, required, detail, scope };
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
export async function runLocalPreflight({ env = 'PROD', root = PROJECT_ROOT, exec = localExec } = {}) {
  const checks = [];
  const git = await getGitSourceInfo(root, exec);

  if (!git.isGit) {
    // Hors dépôt Git, il n'y a rien à exiger : on le DIT plutôt que de laisser
    // croire qu'un contrôle a été passé.
    checks.push(check('source.git', 'Source versionnée (Git)', true, {
      required: false,
      detail: 'Aucun dépôt Git détecté — contrôle de source non applicable.',
    }));
  } else {
    const mustBeClean = requiresCleanSource(env);
    const dirty = git.isDirty ? await listDirtyFiles(root, exec) : { files: [], total: 0 };
    const ok = !git.isDirty || !mustBeClean;

    checks.push(check('source.clean', 'Source Git commitée', ok, {
      // En TEST le contrôle est informatif : il signale sans bloquer.
      required: mustBeClean,
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
  return { ok: failedChecks.length === 0, checks, failedChecks, git };
}

export default { runLocalPreflight, listDirtyFiles, requiresCleanSource };
