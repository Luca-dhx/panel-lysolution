/**
 * LA RACINE DU PROJET SOURCE — une autorité, explicite et VÉRIFIÉE.
 *
 * ══ LE DÉFAUT QUE CE MODULE FERME ═══════════════════════════════════════════
 *
 * La racine des sources était DÉDUITE de l'emplacement du moteur lui-même :
 *
 *     const __dirname = path.dirname(fileURLToPath(import.meta.url));
 *     export const PROJECT_ROOT = path.resolve(__dirname, '../../..');
 *
 * Cette déduction n'est vraie qu'à un seul endroit au monde : un checkout de
 * développement, où le moteur vit dans `<racine>/backend/src/deployment-engine`
 * et où `vitrine/`, `manager/`, `backend/` sont ses frères.
 *
 * Or le backend est AUSSI déployé. Sur le serveur, il vit dans
 * `/var/www/<hôte>/backend`, à côté de `/var/www/<hôte>/vitrine` — qui ne
 * contient QUE le `dist` publié, jamais un `package.json`. La même remontée de
 * trois niveaux y désigne donc `/var/www/<hôte>` : une racine qui a exactement
 * la FORME attendue (les bons noms de dossiers, au bon endroit) sans en avoir
 * la substance. Rien ne le signalait. Le moteur partait déployer, traversait
 * DNS et SSH, et ne découvrait qu'à `artifact.build` — après les mutations —
 * que « vitrine/package.json » n'existait pas.
 *
 * Le défaut n'est pas le message d'erreur : c'est qu'une racine ait pu être
 * SUPPOSÉE. Ce module la rend explicite, ordonnée et contrôlée.
 *
 * ══ L'ORDRE D'AUTORITÉ, DU PLUS EXPLICITE AU PLUS IMPLICITE ═════════════════
 *
 *   1. `root` passé par l'appelant   — la décision d'un appelant qui sait ;
 *   2. `DEPLOY_PROJECT_ROOT`         — la décision d'un exploitant, pour les
 *                                      machines où le moteur ne cohabite pas
 *                                      avec les sources (worker, conteneur) ;
 *   3. l'emplacement du module       — le défaut du checkout de développement.
 *
 * Aucun de ces trois candidats n'est cru sur parole : `inspectProjectRoot()`
 * VÉRIFIE le disque contre le profil du projet. Un chemin explicite mais faux
 * échoue comme un chemin déduit mais faux — c'est le point : l'autorité dit
 * OÙ chercher, jamais QUE c'est bon.
 *
 * ══ CE QUE CE MODULE NE FAIT PAS ════════════════════════════════════════════
 *
 * Il ne cherche pas une racine « ailleurs », ne remonte pas l'arborescence à la
 * recherche d'un dossier plausible, et ne fabrique aucun fichier manquant. Une
 * machine qui ne détient pas les sources ne peut pas construire l'artefact :
 * c'est un fait, et le rôle de ce module est de l'établir TÔT et avec preuve —
 * pas de le contourner.
 *
 * Le cœur du moteur ne connaît toujours AUCUN nom d'application : la liste des
 * dossiers à vérifier vient du profil, et d'aucune autre source.
 */
import path from 'node:path';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { APPS } from './config/project.profile.js';
import { buildableApps } from './topology.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Racine DÉDUITE de l'emplacement du module — `…/backend/src/deployment-engine`
 * remonte de trois niveaux. C'est le défaut du checkout de développement, et
 * uniquement lui : ailleurs, il est faux sans le dire. Exporté pour que les
 * diagnostics puissent nommer d'où vient un candidat.
 */
export const MODULE_PROJECT_ROOT = path.resolve(__dirname, '../../..');

/** Variable d'environnement portant la racine, quand le moteur en est séparé. */
export const PROJECT_ROOT_ENV_VAR = 'DEPLOY_PROJECT_ROOT';

/** D'où vient la racine retenue — voyage jusque dans les rapports d'erreur. */
export const ROOT_SOURCES = Object.freeze({
  OPTION: 'option',
  ENV: PROJECT_ROOT_ENV_VAR,
  MODULE: 'module',
});

/** Libellé lisible d'une provenance — pour les messages d'opérateur. */
export function describeRootSource(source) {
  if (source === ROOT_SOURCES.OPTION) return 'transmise par l’appelant';
  if (source === ROOT_SOURCES.ENV) return `héritée de ${PROJECT_ROOT_ENV_VAR}`;
  return 'déduite de l’emplacement du moteur';
}

/** Liste d'applications d'un profil (objet complet, tableau, ou défaut du dépôt). */
function profileApps(profile) {
  if (!profile) return APPS;
  return Array.isArray(profile) ? profile : (profile.APPS ?? APPS);
}

/**
 * Le CANDIDAT retenu, et sa provenance — sans aucun accès disque.
 *
 * `path.resolve` normalise séparateurs, `.` et `..`, et absolutise un chemin
 * relatif contre le répertoire courant. C'est le SEUL endroit où `process.cwd()`
 * peut intervenir, et seulement pour un chemin explicitement fourni en relatif :
 * une racine déduite ou absolue n'en dépend jamais.
 */
export function projectRootCandidate({ root = null, env = process.env } = {}) {
  const explicite = typeof root === 'string' ? root.trim() : root;
  if (explicite) return { root: path.resolve(explicite), source: ROOT_SOURCES.OPTION };

  const depuisEnv = typeof env?.[PROJECT_ROOT_ENV_VAR] === 'string'
    ? env[PROJECT_ROOT_ENV_VAR].trim()
    : '';
  if (depuisEnv) return { root: path.resolve(depuisEnv), source: ROOT_SOURCES.ENV };

  return { root: MODULE_PROJECT_ROOT, source: ROOT_SOURCES.MODULE };
}

async function pathExists(p, fsMod) {
  try {
    await fsMod.access(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * CONFRONTE la racine candidate au profil, sur le disque réel.
 *
 * Deux exigences, et elles ne portent pas sur les mêmes applications :
 *   · `package.json` pour CHAQUE application déclarée — c'est ce qui fait
 *     d'un dossier une application plutôt qu'un dossier du même nom ;
 *   · `package-lock.json` pour les seules applications CONSTRUITES — `npm ci`
 *     l'exige, et lui seul. Le rôle le dit, jamais le nom.
 *
 * @returns {Promise<{root:string, source:string, apps:Record<string,string>,
 *                    missing:Array<object>, ok:boolean}>}
 *   `missing` est EXHAUSTIF : on rend l'inventaire complet de ce qui manque,
 *   pas seulement le premier manquant. Une racine erronée fait échouer les
 *   trois applications à la fois — le dire d'un coup désigne la racine ; le
 *   dire une par une désignerait, à tort, une application.
 */
export async function inspectProjectRoot({
  root = null, profile, env = process.env, fsMod = fs,
} = {}) {
  const { root: resolved, source } = projectRootCandidate({ root, env });
  const appList = profileApps(profile);
  const constructibles = new Set(buildableApps(appList).map((app) => app.id));

  const apps = {};
  const missing = [];

  for (const app of appList) {
    const dir = path.join(resolved, app.dir);
    apps[app.id] = dir;

    const manifeste = path.join(dir, 'package.json');
    if (!(await pathExists(manifeste, fsMod))) {
      missing.push({
        appId: app.id, dir: app.dir, role: app.role ?? null,
        requires: 'package.json', path: manifeste,
      });
      // Sans `package.json`, exiger en plus le lockfile n'apprendrait rien :
      // le dossier n'est pas une application, la cause est déjà nommée.
      continue;
    }

    if (constructibles.has(app.id)) {
      const lockfile = path.join(dir, 'package-lock.json');
      if (!(await pathExists(lockfile, fsMod))) {
        missing.push({
          appId: app.id, dir: app.dir, role: app.role ?? null,
          requires: 'package-lock.json', path: lockfile,
        });
      }
    }
  }

  return { root: resolved, source, apps, missing, ok: missing.length === 0 };
}

/**
 * Résumé d'une inspection en une phrase d'opérateur, sans jargon de chemin
 * relatif : la racine RÉELLE y figure en absolu, parce que c'est elle le sujet.
 */
export function describeMissing(inspection) {
  const quoi = inspection.missing
    .map((m) => `${m.dir}/${m.requires}`)
    .join(', ');
  return `${quoi} introuvable(s) sous ${inspection.root} `
    + `(racine ${describeRootSource(inspection.source)}).`;
}

export default {
  MODULE_PROJECT_ROOT,
  PROJECT_ROOT_ENV_VAR,
  ROOT_SOURCES,
  projectRootCandidate,
  inspectProjectRoot,
  describeRootSource,
  describeMissing,
};
