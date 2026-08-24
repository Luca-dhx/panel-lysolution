/**
 * MOTEUR DE DUPLICATION (cahier des charges §1).
 *
 * Duplique LE PROJET ACTUEL (il n'existe pas de projet maître) :
 *   1. teste la connexion Mongo ;
 *   2. crée DB TEST si absente ;
 *   3. crée DB PROD si absente ;
 *   4. valide les connexions ;
 *   5. duplique physiquement le dossier courant (copie complète) ;
 *   6. réécrit .env (nom projet, DB TEST, DB PROD) ;
 *   7. découvre / installe / valide les sous-projets Node ;
 *   8. retourne { projet, chemin, état, temps }.
 *
 * Les transformations pures (validation, réécriture .env, nom de dossier) sont
 * exportées et testées unitairement. La copie physique, Mongo et l'installation
 * réels mais isolés derrière des fonctions injectables pour rester testables.
 */
import crypto from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs/promises';
import { MongoClient } from 'mongodb';
import mongoose from 'mongoose';
import { ValidationError } from '../deployment-engine/errors.js';
import { PROJECT_ROOT, localExec } from '../deployment-engine/build.js';
import { normalizeGithubRepositoryUrl } from '../utils/githubRepositoryUrl.js';
import { NETWORK_DEFAULTS } from '../utils/constants.js';
import { isDerivedFromEmail, isUniversalSecret } from '../utils/universalSecrets.js';
import { ENV_KEYS, ENV_KEYS_TO_STRIP, FIRST_ADMIN, SECRETS_TO_GENERATE } from './config/duplication.profile.js';
import {
  DENIED_DIRECTORY_NAMES,
  EMPTY_ONLY_PATHS,
  assertCleanTree,
  isEmptyOnlyPath,
} from './config/duplication.tree.js';
import { readProjectIdentity, rewriteProjectIdentity, scanResidualSourceIdentity } from './identity.js';
import { createPhaseTracker } from './phaseTracker.js';

/**
 * ══ CE QU'UNE COPIE HÉRITE — DÉCLARÉ AILLEURS, ET UNE SEULE FOIS ════════════
 *
 * Ces deux ensembles étaient écrits ici, à la main, sans motif. Ils sont
 * désormais DÉRIVÉS du registre d'arborescence, où chaque dossier porte un
 * verdict explicite et la raison qui l'a fait choisir. Le moteur ne décide plus
 * de ce qu'est `storage` ou `uploads` : il applique une politique qui se lit.
 *
 * Ils restent exportés sous leur nom d'origine — le moteur, ses tests et les
 * appelants les connaissent ainsi.
 */
export const COPY_DENYLIST = new Set(DENIED_DIRECTORY_NAMES);

/**
 * LES CHEMINS RECRÉÉS VIDES — la structure, jamais le contenu.
 *
 * Ils sont désormais désignés par CHEMIN (`backend/storage`) et non par NOM
 * (`storage`). La nuance a compté : un nom vide tout dossier qui le porte, où
 * qu'il soit — y compris un `logs` légitime au milieu du code d'une
 * bibliothèque. Le registre nomme les quatre dossiers du projet, et eux seuls.
 *
 * Le motif de chacun se lit dans `config/duplication.tree.js`.
 */
export const COPY_EMPTY_ONLY = new Set(EMPTY_ONLY_PATHS);

/** Dossiers ignorés lors de la découverte des sous-projets Node. */
export const NODE_PROJECT_DISCOVERY_DENYLIST = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'coverage',
  '.cache',
  '.vite',
  '.next',
  '.turbo',
]);

/**
 * LONGUEUR MINIMALE DU MOT DE PASSE ADMINISTRATEUR — celle du projet, pas une
 * autre.
 *
 * La tentation était d'exiger davantage ici : c'est le compte le plus
 * privilégié, et il est saisi une seule fois. Mais une SECONDE politique de mot
 * de passe dans le dépôt finit toujours de la même façon — les deux dérivent,
 * et c'est la plus permissive qui gagne, parce que c'est celle qu'on emprunte
 * quand l'autre refuse.
 *
 * Une seule politique, donc, et la vraie garde ailleurs : la liste noire des
 * secrets diffusés du parc, qui refuse `123admin` quelle que soit sa longueur.
 */
const ADMIN_PASSWORD_MIN_LENGTH = 6;

/**
 * Une adresse rendue lisible sans être exploitable : `c***@garage.fr`.
 *
 * Le moteur ne dépend d'aucune couche métier (c'est sa règle), il ne peut donc
 * pas emprunter le masqueur du module d'événements. Trois lignes valent mieux
 * qu'une dépendance qui casserait l'isolation du moteur.
 */
export function maskEmailForLog(email) {
  const [local = '', domaine = ''] = String(email || '').split('@');
  if (!domaine) return '***';
  return `${local.slice(0, 1)}***@${domaine}`;
}

const DB_NAME_RE = /^[a-zA-Z0-9_-]{1,63}$/;
const PROJECT_NAME_RE = /^[\w .()-]{1,80}$/u;
const GLOBAL_SCRIPT_RUNNERS = new Set(['node', 'npm', 'pnpm', 'yarn', 'npx', 'bun']);

async function pathExists(targetPath, fsMod = fs) {
  try {
    await fsMod.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

function normalizeRelativePath(root, target) {
  const rel = path.relative(root, target);
  return rel ? rel.split(path.sep).join('/') : '.';
}

function isSameOrInsidePath(parentPath, childPath) {
  const rel = path.relative(parentPath, childPath);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function dependencyCount(pkg, field) {
  return Object.keys(pkg?.[field] || {}).length;
}

function hasInstallableDependencies(pkg) {
  return ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']
    .some((field) => dependencyCount(pkg, field) > 0);
}

function parsePackageManagerField(value) {
  if (!value || typeof value !== 'string') return { name: null, version: null };
  const [name, version = null] = value.split('@');
  return { name: name || null, version };
}

function workspacePatternsOf(pkg) {
  if (Array.isArray(pkg?.workspaces)) return pkg.workspaces;
  if (Array.isArray(pkg?.workspaces?.packages)) return pkg.workspaces.packages;
  return [];
}

function escapeRegex(source) {
  return source.replace(/[|\\{}()[\]^$+?.]/g, '\\$&');
}

function workspacePatternToRegExp(pattern) {
  const normalized = String(pattern || '').replace(/\\/g, '/').replace(/\/+$/g, '');
  const sentinel = '\u0000';
  const escaped = escapeRegex(normalized)
    .replace(/\*\*/g, sentinel)
    .replace(/\*/g, '[^/]+')
    .replace(new RegExp(sentinel, 'g'), '.*');
  return new RegExp(`^${escaped}$`);
}

function isWorkspaceMember(relativePath, patterns) {
  return patterns.some((pattern) => workspacePatternToRegExp(pattern).test(relativePath));
}

async function detectLockfile(dir, fsMod = fs) {
  for (const [file, packageManager] of [
    ['package-lock.json', 'npm'],
    ['pnpm-lock.yaml', 'pnpm'],
    ['yarn.lock', 'yarn'],
  ]) {
    if (await pathExists(path.join(dir, file), fsMod)) return { file, packageManager };
  }
  return { file: null, packageManager: null };
}

function detectDevCommandToken(script) {
  const value = String(script || '').trim();
  if (!value) return null;
  const match = value.match(/^[^\s&|;]+/);
  return match ? match[0] : null;
}

function requiresLocalBinary(token) {
  if (!token) return false;
  if (GLOBAL_SCRIPT_RUNNERS.has(token)) return false;
  if (token.startsWith('.') || token.includes('/') || token.includes('\\')) return false;
  return true;
}

function localBinaryCandidates(projectDir, token) {
  const binDir = path.join(projectDir, 'node_modules', '.bin');
  return process.platform === 'win32'
    ? [
      path.join(binDir, `${token}.cmd`),
      path.join(binDir, `${token}.ps1`),
      path.join(binDir, token),
    ]
    : [
      path.join(binDir, token),
      path.join(binDir, `${token}.cmd`),
    ];
}

function declaredPackageManifestCandidates(project, token) {
  const packageFields = [
    project.packageJson?.dependencies,
    project.packageJson?.devDependencies,
    project.packageJson?.optionalDependencies,
    project.packageJson?.peerDependencies,
  ];
  const declared = packageFields.some((field) => Object.prototype.hasOwnProperty.call(field || {}, token));
  if (!declared) return [];
  return [path.join(project.dir, 'node_modules', token, 'package.json')];
}

function commandToString(command, args) {
  return [command, ...args].join(' ').trim();
}

function installEnvironment(baseEnv = process.env) {
  const env = { ...baseEnv };
  delete env.NODE_ENV;
  delete env.NPM_CONFIG_PRODUCTION;
  delete env.npm_config_production;
  delete env.NPM_CONFIG_OMIT;
  delete env.npm_config_omit;
  env.NPM_CONFIG_PRODUCTION = 'false';
  env.npm_config_production = 'false';
  env.NPM_CONFIG_OMIT = '';
  env.npm_config_omit = '';
  return env;
}

function installCommandFor(project) {
  if (project.packageManager === 'pnpm') {
    return project.lockfile === 'pnpm-lock.yaml'
      ? { command: 'pnpm', args: ['install', '--frozen-lockfile'] }
      : { command: 'pnpm', args: ['install'] };
  }
  if (project.packageManager === 'yarn') {
    const isBerry = project.packageManagerField.version && !project.packageManagerField.version.startsWith('1.');
    return project.lockfile === 'yarn.lock'
      ? { command: 'yarn', args: ['install', ...(isBerry ? ['--immutable'] : ['--frozen-lockfile'])] }
      : { command: 'yarn', args: ['install'] };
  }
  return project.lockfile === 'package-lock.json'
    ? { command: 'npm', args: ['ci', '--include=dev'] }
    : { command: 'npm', args: ['install'] };
}

function emitStructuredDuplicateLog(onLog, record) {
  onLog(`[duplicate] ${JSON.stringify(record)}`);
}

function summarizeNodeProject(project) {
  return {
    name: project.name,
    path: project.relativePath,
    packageManager: project.packageManager,
    packageManagerField: project.packageManagerField.raw,
    lockfile: project.lockfile,
    hasDevScript: project.hasDevScript,
    hasBuildScript: project.hasBuildScript,
    hasTypecheckScript: project.hasTypecheckScript,
    installNeeded: project.installNeeded,
    installReason: project.installReason,
    workspaceRoot: project.workspaceRoot,
    dependencyCounts: {
      dependencies: project.dependencyCounts.dependencies,
      devDependencies: project.dependencyCounts.devDependencies,
      optionalDependencies: project.dependencyCounts.optionalDependencies,
      peerDependencies: project.dependencyCounts.peerDependencies,
    },
    validation: {
      localBinary: project.validation.localBinary,
      requiresLocalBinary: project.validation.requiresLocalBinary,
    },
  };
}

/** Erreur structurée pour les sous-projets Node dupliqués. */
export class NodeProjectInitializationError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'NodeProjectInitializationError';
    this.code = code;
    this.details = details;
  }
}

/** Nettoie un nom en nom de dossier sûr (sans casser l'unicité voulue). */
export function sanitizeFolderName(name) {
  return String(name)
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 100);
}

/**
 * ══ L'IDENTITÉ TECHNIQUE D'UNE COPIE — DÉRIVÉE, JAMAIS HÉRITÉE ══════════════
 *
 * `project.profile.js` est le SEUL fichier du moteur de déploiement qui
 * connaisse le projet : son slug (préfixe des processus PM2, des dossiers de
 * staging et de l'arborescence de sauvegardes) et son identifiant de build
 * (celui que `/api/version` publie).
 *
 * La duplication réécrivait le `.env` et oubliait ce fichier. Toute copie
 * repartait donc en `sbauto` / `sbauto06` : dix projets clients auraient tous
 * annoncé `sbauto06` à `/api/version`, et déposé leurs sauvegardes dans le même
 * `/var/backups/sbauto`. Rien n'aurait cassé — c'est le pire des cas : chaque
 * projet aurait menti sur son identité, en silence, dès le premier clone.
 *
 * ── POURQUOI DÉRIVER, ET NE PAS DEMANDER ─────────────────────────────────
 *
 * Un champ de plus à saisir est un champ de plus à saisir FAUX, et deux projets
 * finiraient par partager un slug par distraction. Le nom du projet est déjà
 * saisi, déjà validé, déjà unique par construction (le dossier cible ne doit
 * pas exister). Le slug en découle mécaniquement.
 */
export function deriveProjectIdentity(projectName) {
  const base = String(projectName ?? '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!base) throw new ValidationError('Nom de projet inexploitable pour dériver une identité technique.');
  /**
   * Le slug sert de préfixe à des noms de processus et de chemins : on le borne
   * court, et on garantit qu'il commence par une lettre — un nom de service qui
   * commence par un chiffre se comporte mal dans plus d'un outil.
   */
  const slug = (/^[a-z]/.test(base) ? base : `p-${base}`).slice(0, 32).replace(/-+$/g, '');
  return { slug, projectId: slug };
}

/**
 * RÉÉCRIT le profil de projet de la COPIE.
 *
 * Deux constantes, remplacées par ancrage sur leur déclaration exacte. Si l'une
 * des deux n'est pas trouvée, on LÈVE : une copie qui repartirait avec
 * l'identité de sa source est précisément ce que cette fonction existe pour
 * empêcher, et un remplacement silencieusement raté serait pire que pas de
 * remplacement du tout.
 */
export function rewriteProjectProfile(content, { slug, projectId }) {
  let out = String(content);
  const remplacer = (cle, valeur) => {
    const re = new RegExp(`(export const ${cle} = )'[^']*'`);
    if (!re.test(out)) {
      throw new ValidationError(
        `Profil de projet illisible : \`export const ${cle}\` introuvable. `
        + 'La copie porterait l’identité technique de sa source.'
      );
    }
    out = out.replace(re, `$1'${valeur}'`);
  };
  remplacer('PROJECT_SLUG', slug);
  remplacer('PROJECT_ID', projectId);
  return out;
}

/**
 * Refuse toute destination ambiguë ou dangereuse.
 * - jamais la source elle-même ;
 * - jamais dans la source ;
 * - jamais contenant la source.
 */
export function assertSafeDuplicationDestination(sourceRoot, destParent, destRoot) {
  const source = path.resolve(sourceRoot);
  const parent = path.resolve(destParent);
  const dest = path.resolve(destRoot);
  if (source === dest) {
    throw new ValidationError(`Le dossier cible est identique à la source : ${dest}`);
  }
  if (isSameOrInsidePath(source, dest)) {
    throw new ValidationError(`Le dossier cible ne peut pas être créé dans la source : ${dest}`);
  }
  if (isSameOrInsidePath(dest, source)) {
    throw new ValidationError(`Le dossier cible ne peut pas contenir la source : ${dest}`);
  }
  return { sourceRoot: source, destParent: parent, destRoot: dest };
}

/**
 * Valide les entrées de l'assistant de duplication.
 *
 * ══ CE QUE LE LOT 2C A RETIRÉ D'ICI, ET CE QU'IL A MIS À LA PLACE ═══════════
 *
 * `devPassword` a disparu. L'assistant demandait un mot de passe, le moteur
 * l'écrivait en clair dans le `.env` de la copie, et le premier démarrage en
 * faisait un compte. Trois endroits détenaient donc le secret d'administration
 * du nouveau projet — le formulaire, le fichier, la base — avant même que son
 * titulaire l'ait vu.
 *
 * `devName` l'a remplacé. Ce n'est pas un échange à valeur égale : on a
 * remplacé un SECRET par une IDENTITÉ. Le moteur sait désormais à QUI il ouvre
 * l'accès, et ignore avec quoi cette personne s'authentifiera — ce qui n'est
 * pas son affaire.
 *
 * `devEmail` reste OBLIGATOIRE, et c'est le blocage `FIRST_DEV_REQUIRED` : sans
 * destinataire, il n'y a personne à qui envoyer le lien d'activation, donc
 * aucun projet administrable. Refuser est la seule réponse honnête — inventer
 * une adresse par défaut est exactement ce qui a produit `dev@mail.com`.
 *
 * ══ ET POURQUOI L'ADMIN, LUI, PORTE UN MOT DE PASSE ICI ════════════════════
 *
 * Les deux comptes ne se ressemblent pas, et les traiter pareil serait une
 * fausse symétrie :
 *
 *   · le DÉVELOPPEUR est une personne identifiée qui relève sa boîte. Un lien
 *     d'activation lui coûte trente secondes et ne laisse aucun secret nulle
 *     part ;
 *   · l'ADMINISTRATEUR est le compte que l'exploitant remet au client, souvent
 *     de vive voix, à l'instant de la livraison. Sa boîte n'est parfois même
 *     pas encore créée. Un lien envoyé à une adresse qui ne relève rien
 *     produirait un projet livré sans accès — et l'on retomberait sur un
 *     dépannage manuel en base.
 *
 * Le défaut réparé par le lot 2C n'était pas « un mot de passe existe » :
 * c'était « le MÊME mot de passe existe partout ». Ici, il est saisi par
 * l'exploitant, propre à CETTE duplication, refusé s'il appartient aux secrets
 * diffusés du parc, et n'est jamais écrit ailleurs que haché en base.
 *
 * @param {object} input { projectName, folderName, dbTest, dbProd, devEmail,
 *                         devName, adminEmail, adminPassword,
 *                         adminPasswordConfirmation }
 * @returns {object} input normalisé (folderName nettoyé)
 */
export function validateDuplicationInput(input) {
  const {
    projectName, folderName, dbTest, dbProd, devEmail, devName, githubRepositoryUrl,
    adminEmail, adminPassword, adminPasswordConfirmation,
  } = input || {};
  if (!projectName || !PROJECT_NAME_RE.test(projectName)) {
    throw new ValidationError('Nom de projet invalide.');
  }
  const folder = sanitizeFolderName(folderName || projectName);
  if (!folder) throw new ValidationError('Nom de dossier invalide.');
  if (!dbTest || !DB_NAME_RE.test(dbTest)) throw new ValidationError('Nom de base TEST invalide.');
  if (!dbProd || !DB_NAME_RE.test(dbProd)) throw new ValidationError('Nom de base PROD invalide.');
  if (dbTest === dbProd) throw new ValidationError('DB TEST et DB PROD doivent être différentes.');
  if (!devEmail || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(devEmail)) {
    throw new ValidationError(
      "Adresse du premier développeur local requise : c'est elle qui recevra le lien d'activation.",
      { blocker: 'FIRST_DEV_REQUIRED' }
    );
  }
  const prenomNom = String(devName ?? '').trim();
  if (prenomNom.length > 80) throw new ValidationError('Nom du premier développeur trop long (80 caractères max).');
  /**
   * AUCUN MOT DE PASSE N'EST ACCEPTÉ, MÊME S'IL EST ENVOYÉ.
   *
   * Un client d'API antérieur au lot continuerait de poster `devPassword`. Le
   * laisser passer en silence, c'est le laisser croire qu'il a fonctionné —
   * pendant que le compte réel s'active par un tout autre chemin. On le refuse,
   * en nommant le remplaçant.
   */
  if (input && Object.prototype.hasOwnProperty.call(input, 'devPassword')) {
    throw new ValidationError(
      "Le mot de passe du premier développeur n'est plus accepté : il choisit lui-même le sien "
        + "par le lien d'activation envoyé à son adresse.",
      { blocker: 'FIRST_DEV_PASSWORD_REFUSED' }
    );
  }
  /* ── LE PREMIER ADMINISTRATEUR — identité ET secret, tous deux exigés ───── */
  const adresseAdmin = String(adminEmail ?? '').trim().toLowerCase();
  if (!adresseAdmin || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(adresseAdmin)) {
    throw new ValidationError(
      "Adresse du premier administrateur requise : c'est le compte que vous remettrez au client.",
      { blocker: 'FIRST_ADMIN_REQUIRED' }
    );
  }
  const mdpAdmin = String(adminPassword ?? '');
  if (!mdpAdmin) {
    throw new ValidationError(
      'Mot de passe du premier administrateur requis.',
      { blocker: 'FIRST_ADMIN_REQUIRED' }
    );
  }
  /**
   * LA CONFIRMATION EST VÉRIFIÉE ICI AUSSI, ET CE N'EST PAS REDONDANT.
   *
   * L'écran la vérifie déjà — mais l'écran n'est pas l'autorité, et une faute
   * de frappe non détectée produirait un compte dont PERSONNE ne connaît le
   * mot de passe : ni l'exploitant, qui croit l'avoir choisi, ni le client, à
   * qui on l'aura dicté. Un compte irrécupérable, sur le projet le plus neuf.
   */
  if (adminPasswordConfirmation !== undefined && mdpAdmin !== String(adminPasswordConfirmation)) {
    throw new ValidationError(
      'Les deux mots de passe administrateur ne correspondent pas.',
      { blocker: 'FIRST_ADMIN_PASSWORD_INVALID' }
    );
  }
  if (mdpAdmin.length < ADMIN_PASSWORD_MIN_LENGTH) {
    throw new ValidationError(
      `Mot de passe administrateur trop court (${ADMIN_PASSWORD_MIN_LENGTH} caractères minimum).`,
      { blocker: 'FIRST_ADMIN_PASSWORD_INVALID' }
    );
  }
  /**
   * ══ LA GARDE QUI EMPÊCHE LE DÉFAUT DE REVENIR PAR LA PORTE D'À CÔTÉ ══════
   *
   * Rien n'empêcherait un exploitant pressé de retaper `123admin` dans le
   * formulaire — et le parc se retrouverait, projet après projet, avec le
   * secret universel qu'on vient de supprimer, cette fois posé « à la main »
   * et donc invisible à toute recherche dans le code.
   *
   * Ce qui rend ces valeurs dangereuses n'est pas leur forme mais leur
   * DIFFUSION : seule une liste peut les refuser.
   */
  if (isUniversalSecret(mdpAdmin)) {
    throw new ValidationError(
      'Ce mot de passe est un identifiant historique du parc : il est connu et refusé. '
        + 'Choisissez un mot de passe propre à ce projet.',
      { blocker: 'FIRST_ADMIN_PASSWORD_INVALID' }
    );
  }
  if (isDerivedFromEmail(mdpAdmin, adresseAdmin)) {
    throw new ValidationError(
      "Ce mot de passe se déduit de l'adresse du compte : choisissez-en un autre.",
      { blocker: 'FIRST_ADMIN_PASSWORD_INVALID' }
    );
  }

  // URL du dépôt GitHub de la COPIE (jamais celle du projet source) —
  // obligatoire pour toute nouvelle duplication, normalisée vers la forme
  // canonique `https://github.com/<owner>/<repo>.git`.
  let repoUrl;
  try {
    repoUrl = normalizeGithubRepositoryUrl(githubRepositoryUrl);
  } catch (err) {
    throw new ValidationError(`URL du dépôt GitHub cible : ${err.message}`);
  }
  return {
    projectName,
    folderName: folder,
    dbTest,
    dbProd,
    devEmail: String(devEmail).trim().toLowerCase(),
    devName: prenomNom,
    adminEmail: adresseAdmin,
    adminPassword: mdpAdmin,
    githubRepositoryUrl: repoUrl,
  };
}

/**
 * Met en forme une valeur de .env : brute si elle est sans ambiguïté pour
 * dotenv, sinon entre guillemets doubles (backslash et guillemets échappés).
 * Un mot de passe contenant espace ou `#` ne doit JAMAIS être tronqué.
 */
export function quoteEnvValue(value) {
  const v = String(value ?? '');
  if (/^[A-Za-z0-9@._/:+-]*$/.test(v)) return v;
  return `"${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/**
 * Réécrit le contenu d'un .env pour le projet dupliqué (fonction PURE).
 * Remplace/insère DB_TEST, DB_PROD ; conserve toutes les autres lignes.
 * @param {string} envContent Contenu du .env source.
 * @param {object} values { dbTest, dbProd, projectName, firstDevEmail, firstDevName }
 * @returns {string} nouveau contenu
 */
export function rewriteEnv(envContent, {
  dbTest, dbProd, projectName, githubRepositoryUrl, firstDevEmail, firstDevName,
  secrets = generateProjectSecrets(),
}) {
  const lines = String(envContent || '').split(/\r?\n/);
  const setKeys = { [ENV_KEYS.dbTest]: dbTest, [ENV_KEYS.dbProd]: dbProd };
  // SÉCURITÉ : chaque copie reçoit des secrets NEUFS. Sans cela, un projet
  // dupliqué hériterait du JWT_SECRET et des clés de chiffrement de sa
  // source — la compromission de l'un compromettrait tous les autres.
  for (const [key, value] of Object.entries(secrets ?? {})) setKeys[key] = value;
  if (projectName) setKeys[ENV_KEYS.projectName] = projectName;
  // URL du dépôt de la COPIE : remplace toute valeur héritée du template
  // source — le moteur ne recopie JAMAIS l'URL du dépôt source.
  if (githubRepositoryUrl) setKeys[ENV_KEYS.githubRepositoryUrl] = githubRepositoryUrl;
  /**
   * L'IDENTITÉ du premier développeur de la copie — jamais son secret (LOT 2C).
   * Consommée par l'amorçage au premier lancement, qui crée un compte SANS mot
   * de passe et lui envoie un lien d'activation. Remplace toute valeur héritée
   * du projet source : une copie n'hérite pas de l'administrateur de sa source.
   */
  if (firstDevEmail) setKeys[ENV_KEYS.firstDevEmail] = firstDevEmail;
  if (firstDevName) setKeys[ENV_KEYS.firstDevName] = quoteEnvValue(firstDevName);
  const seen = new Set();

  const out = lines
    /**
     * LES SECRETS D'AMORÇAGE HÉRITÉS SONT SUPPRIMÉS, PAS RÉÉCRITS.
     *
     * Une ligne `SEED_DEV_PASSWORD=…` héritée de la source n'a plus de lecteur.
     * La laisser serait pourtant tout sauf neutre : elle documenterait une
     * pratique abandonnée, dans le fichier même où quelqu'un ira chercher
     * comment ouvrir un accès.
     */
    .filter((line) => {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=/);
      return !(m && ENV_KEYS_TO_STRIP.includes(m[1]));
    })
    .map((line) => {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=/);
      if (m && Object.prototype.hasOwnProperty.call(setKeys, m[1])) {
        seen.add(m[1]);
        return `${m[1]}=${setKeys[m[1]]}`;
      }
      return line;
    });

  // Ajoute les clés manquantes à la fin.
  for (const [key, val] of Object.entries(setKeys)) {
    if (!seen.has(key)) out.push(`${key}=${val}`);
  }
  return out.join('\n');
}

/**
 * Génère un jeu de secrets NEUFS pour une copie, d'après le profil de
 * duplication. Source cryptographique sûre ; les valeurs ne sont jamais
 * journalisées ni retournées par une API — elles ne servent qu'à écrire le
 * `.env` de la copie.
 * @returns {Record<string,string>} { NOM_VARIABLE: valeur }
 */
export function generateProjectSecrets(specs = SECRETS_TO_GENERATE) {
  const secrets = {};
  for (const spec of specs) {
    secrets[spec.key] = crypto.randomBytes(spec.bytes).toString(spec.encoding);
  }
  return secrets;
}

/** Teste la connexion Mongo et retourne la liste des bases existantes. */
export async function testMongoConnection(mongoUri) {
  const client = new MongoClient(mongoUri, { serverSelectionTimeoutMS: 8000 });
  await client.connect();
  try {
    const admin = client.db().admin();
    const { databases } = await admin.listDatabases();
    return { ok: true, databases: databases.map((d) => d.name) };
  } finally {
    await client.close();
  }
}

/** Masque les credentials d'une URI Mongo — JAMAIS d'URI complète en clair. */
export function maskMongoUri(uri) {
  return String(uri || '').replace(/\/\/([^@/]+)@/, '//***@');
}

/** Erreur structurée d'initialisation de base (codes stables, message sûr). */
export class DatabaseInitializationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'DatabaseInitializationError';
    this.code = code;
  }
}

function isAuthMongoError(err) {
  return err?.code === 18 || err?.codeName === 'AuthenticationFailed' || /auth/i.test(String(err?.message || ''));
}

/**
 * INITIALISATION CANONIQUE d'une base logique — idempotente.
 *
 * Doctrine : dans un cluster existant, l'URI + les droits d'écriture du
 * database user SUFFISENT — une base logique se matérialise à la première
 * écriture réelle. AUCUNE Atlas Administration API n'est nécessaire pour cela.
 *
 * La matérialisation utilise les mécanismes DÉJÀ canoniques de l'application,
 * jamais un document factice :
 *  1. création des INDEX Mongoose de tous les modèles connus (crée les
 *     collections réelles avec leurs index — exactement ce que ferait l'app) ;
 *  2. insertion `$setOnInsert` du singleton SystemConfiguration (vrai document
 *     de configuration attendu par le bootstrap, valeurs par défaut) ;
 *  3. suppression du marqueur artificiel historique `_deployment_marker` ;
 *  4. vérification RÉELLE de la présence de la base après coup.
 *
 * @param {string} mongoUri
 * @param {string} dbName
 * @param {{models?:object}} [opts]  Registre de modèles (déf. mongoose.models).
 * @returns {Promise<{name:string, created:boolean, collectionsInitialized:number, indexesEnsured:number}>}
 */
export async function initializeDatabase(mongoUri, dbName, { models } = {}) {
  if (!dbName || !DB_NAME_RE.test(dbName)) {
    throw new DatabaseInitializationError('MONGO_DATABASE_NAME_INVALID', `Nom de base invalide : ${dbName}`);
  }
  let client;
  try {
    client = new MongoClient(mongoUri, { serverSelectionTimeoutMS: 8000 });
    await client.connect();
  } catch (err) {
    const code = isAuthMongoError(err) ? 'MONGO_AUTHENTICATION_FAILED' : 'MONGO_CONNECTION_FAILED';
    throw new DatabaseInitializationError(code, `Connexion Mongo impossible (${maskMongoUri(mongoUri)}).`);
  }
  try {
    const admin = client.db().admin();
    let databases;
    try {
      ({ databases } = await admin.listDatabases());
    } catch (err) {
      const code = isAuthMongoError(err) ? 'MONGO_AUTHENTICATION_FAILED' : 'MONGO_CONNECTION_FAILED';
      throw new DatabaseInitializationError(code, `Lecture des bases impossible (${maskMongoUri(mongoUri)}).`);
    }
    const existed = databases.some((d) => d.name === dbName);
    const db = client.db(dbName);

    // 1. Index Mongoose de tous les modèles du registre.
    const registry = models || mongoose.models;
    let collectionsInitialized = 0;
    let indexesEnsured = 0;
    try {
      for (const model of Object.values(registry)) {
        const collName = model?.collection?.collectionName;
        const specs = typeof model?.schema?.indexes === 'function' ? model.schema.indexes() : [];
        if (!collName || !specs.length) continue;
        for (const [fields, options] of specs) {
          await db.collection(collName).createIndex(fields, options || {});
          indexesEnsured += 1;
        }
        collectionsInitialized += 1;
      }
    } catch (err) {
      throw new DatabaseInitializationError(
        'MONGO_INDEX_INITIALIZATION_FAILED',
        `Création des index échouée sur ${dbName} : ${err?.message || 'erreur inconnue'}`
      );
    }

    // 2. Document canonique : le singleton SystemConfiguration (jamais un faux
    //    document métier). Idempotent par $setOnInsert.
    try {
      await db.collection('systemconfigurations').updateOne(
        {},
        { $setOnInsert: { network: { ...NETWORK_DEFAULTS }, updatedBy: null } },
        { upsert: true }
      );
      // 3. Le marqueur artificiel historique n'a plus de raison d'être.
      await db.collection('_deployment_marker').drop().catch(() => {});
    } catch (err) {
      throw new DatabaseInitializationError(
        'MONGO_DATABASE_INITIALIZATION_FAILED',
        `Initialisation de ${dbName} échouée : ${err?.message || 'erreur inconnue'}`
      );
    }

    // 4. Vérification réelle.
    const after = await admin.listDatabases();
    if (!after.databases.some((d) => d.name === dbName)) {
      throw new DatabaseInitializationError('MONGO_DATABASE_INITIALIZATION_FAILED', `La base ${dbName} n'existe pas après initialisation.`);
    }
    return { name: dbName, created: !existed, collectionsInitialized, indexesEnsured };
  } finally {
    await client.close().catch(() => {});
  }
}

/**
 * Initialise les DEUX bases d'un projet dupliqué (contrat du LOT MongoDB).
 * @returns {Promise<{test:object, prod:object}>}
 */
export async function initializeDuplicatedProjectDatabases({ mongoUri, testDatabaseName, productionDatabaseName, models } = {}) {
  if (!mongoUri) throw new DatabaseInitializationError('MONGO_CONNECTION_FAILED', 'MONGODB_URI requis.');
  const test = await initializeDatabase(mongoUri, testDatabaseName, { models });
  const prod = await initializeDatabase(mongoUri, productionDatabaseName, { models });
  return { test, prod };
}

/**
 * Compat historique : crée/initialise une base si absente. Délègue désormais à
 * l'initialisation CANONIQUE (index + singleton), plus de marqueur artificiel.
 * @returns {Promise<{created:boolean}>}
 */
export async function ensureDatabase(mongoUri, dbName, _stamp = 'init') {
  const r = await initializeDatabase(mongoUri, dbName);
  return { created: r.created, collectionsInitialized: r.collectionsInitialized, indexesEnsured: r.indexesEnsured };
}

/**
 * ══ LE PREMIER ADMINISTRATEUR LOCAL — écrit DIRECTEMENT dans la base cible ══
 *
 * ── POURQUOI PAS PAR LE `.env`, COMME LE DÉVELOPPEUR ────────────────────────
 *
 * L'autre voie possible était d'écrire `FIRST_ADMIN_PASSWORD` dans le `.env` de
 * la copie et de laisser l'amorçage le consommer au premier démarrage. Elle
 * fonctionne — et elle recrée exactement le défaut que le lot 2C a supprimé :
 * un mot de passe en clair, sur un disque, dans un fichier que personne ne
 * nettoie et que tout le monde relit.
 *
 * Le compte est donc créé ICI, pendant la duplication, à l'instant où le secret
 * est en mémoire et nulle part ailleurs. Il n'atteint jamais un fichier.
 *
 * ── POURQUOI LE DRIVER NATIF, ET NON LE MODÈLE MONGOOSE ────────────────────
 *
 * Le schéma `User` porte des hooks de SYNCHRONISATION : chaque `save()` annonce
 * un changement d'équipe au Panel. Ces hooks sont attachés à la connexion du
 * projet COURANT — celui qui exécute la duplication. Créer le compte par le
 * modèle ferait donc annoncer, au Panel, l'arrivée d'un membre d'équipe dans le
 * projet SOURCE, pour un document qui appartient à un AUTRE projet.
 *
 * On écrit donc le document tel que Mongoose l'écrirait — sa forme et son
 * hachage venant du PROFIL, seul endroit du moteur qui connaisse ce projet. La
 * recette de connexion prouve que la forme est bonne : elle se connecte
 * réellement avec ce compte.
 *
 * ── UNIQUEMENT DANS LA BASE TEST, ET C'EST VOULU ───────────────────────────
 *
 * Un projet neuf démarre en TEST ; sa base PROD est peuplée par la promotion
 * contrôlée TEST → PROD, qui recopie les comptes. Poser l'administrateur des
 * deux côtés créerait deux comptes de même adresse dont l'un ne serait jamais
 * relu — et dont le mot de passe divergerait au premier changement.
 *
 * ── IDEMPOTENT PAR CONSTRUCTION ────────────────────────────────────────────
 *
 * `$setOnInsert` sur un `upsert` : un document existant n'est pas touché. Et un
 * ADMIN déjà présent, quelle que soit son adresse, fait renoncer purement et
 * simplement. Une duplication rejouée ne réinitialise donc jamais un mot de
 * passe — le seed ne doit pas devenir un mécanisme de réinitialisation.
 *
 * @returns {Promise<{created:boolean, email:string, reason?:string}>}
 */
export async function createFirstAdmin(mongoUri, dbName, { email, password, name = 'Administrateur' } = {}) {
  if (!email || !password) {
    throw new ValidationError(
      'Création du premier administrateur impossible : identité ou mot de passe manquant.',
      { blocker: 'FIRST_ADMIN_REQUIRED' }
    );
  }
  const collection = mongoose.models?.[FIRST_ADMIN.modelName]?.collection?.collectionName
    || FIRST_ADMIN.collection;
  let client;
  try {
    client = new MongoClient(mongoUri, { serverSelectionTimeoutMS: 8000 });
    await client.connect();
  } catch {
    throw new DatabaseInitializationError(
      'MONGO_CONNECTION_FAILED',
      `Connexion Mongo impossible pour créer le premier administrateur (${maskMongoUri(mongoUri)}).`
    );
  }
  try {
    const users = client.db(dbName).collection(collection);

    const dejaAdmin = await users.findOne({ ...FIRST_ADMIN.existingAdminFilter });
    if (dejaAdmin) return { created: false, email, reason: 'ADMIN_ALREADY_PRESENT' };
    const memeAdresse = await users.findOne({ [FIRST_ADMIN.emailField]: email });
    if (memeAdresse) return { created: false, email, reason: 'EMAIL_ALREADY_PRESENT' };

    /**
     * LA FORME DU COMPTE VIENT DU PROFIL — le cœur ne la connaît pas.
     *
     * Ce bloc hachait en dur avec `bcryptjs`, importé tardivement « parce que le
     * Panel ne l'embarque pas ». L'import tardif ne faisait que déplacer la
     * panne : le Panel échouait ici, module introuvable, les bases déjà
     * créées. Et le document lui-même n'était pas le sien — mauvaise
     * collection, mauvais champs.
     *
     * Le cœur reste donc générique : il sait qu'un premier administrateur doit
     * exister, il ne sait pas à quoi il ressemble. `config/duplication.profile`
     * le lui dit, et c'est le rôle exact de ce fichier.
     */
    const maintenant = new Date();
    const document = await FIRST_ADMIN.buildDocument({
      email, password, name, now: maintenant,
    });
    const resultat = await users.updateOne(
      { [FIRST_ADMIN.emailField]: email },
      { $setOnInsert: { ...document, __v: 0 } },
      { upsert: true }
    );
    return { created: resultat.upsertedCount === 1, email };
  } finally {
    await client.close().catch(() => {});
  }
}

/**
 * Copie récursivement un dossier en excluant la denylist.
 * @returns {Promise<{files:number, dirs:number}>}
 */
export async function copyProject(srcRoot, destRoot, { onLog = () => {} } = {}) {
  let files = 0;
  let dirs = 0;
  const walk = async (src, dest) => {
    await fs.mkdir(dest, { recursive: true });
    dirs += 1;
    const entries = await fs.readdir(src, { withFileTypes: true });
    for (const entry of entries) {
      if (COPY_DENYLIST.has(entry.name)) continue;
      /**
       * LE DOSSIER, PAS SON CONTENU. On le crée et on passe : la copie a la
       * structure dont son runtime a besoin, sans un seul fichier d'un autre
       * client.
       *
       * La reconnaissance se fait sur le CHEMIN relatif à la racine du projet,
       * jamais sur le seul nom : `backend/storage` désigne un dossier précis,
       * là où « storage » viderait n'importe quel dossier homonyme rencontré en
       * chemin — y compris dans du code tiers.
       */
      const relatif = path.relative(srcRoot, path.join(src, entry.name));
      if (entry.isDirectory() && isEmptyOnlyPath(relatif)) {
        await fs.mkdir(path.join(dest, entry.name), { recursive: true });
        dirs += 1;
        continue;
      }
      const s = path.join(src, entry.name);
      const d = path.join(dest, entry.name);
      if (entry.isDirectory()) {
        await walk(s, d);
      } else if (entry.isFile()) {
        await fs.copyFile(s, d);
        files += 1;
      }
    }
  };
  onLog(`[duplicate] copie ${srcRoot} -> ${destRoot}`);
  await walk(srcRoot, destRoot);

  /**
   * ══ LES DOSSIERS VIERGES EXISTENT, MÊME ABSENTS DE LA SOURCE ═════════════
   *
   * `backend/storage` et `backend/logs` sont intégralement ignorés par git :
   * un checkout FRAIS de la source ne les contient pas. Se contenter de les
   * vider quand on les rencontre laisserait donc une copie sans eux — et le
   * runtime, qui y écrit dès son premier démarrage, échouerait sur un dossier
   * manquant, pour la seule raison que la source avait été clonée proprement.
   *
   * On les crée donc TOUJOURS. C'est le sens du verdict : la structure est due,
   * le contenu ne l'est jamais.
   */
  for (const relatif of EMPTY_ONLY_PATHS) {
    await fs.mkdir(path.join(destRoot, ...relatif.split('/')), { recursive: true });
    dirs += 1;
  }
  return { files, dirs };
}

/**
 * Découvre tous les vrais sous-projets Node depuis les package.json.
 * Ignore les dossiers de build/cache et les dépendances réinstallables.
 */
export async function discoverNodeProjects(root, { fsMod = fs } = {}) {
  const discovered = [];

  const walk = async (dir) => {
    const entries = await fsMod.readdir(dir, { withFileTypes: true });
    const packageEntry = entries.find((entry) => entry.isFile() && entry.name === 'package.json');
    if (packageEntry) {
      const packageJsonPath = path.join(dir, packageEntry.name);
      const packageJson = JSON.parse(await fsMod.readFile(packageJsonPath, 'utf8'));
      const { file: lockfile, packageManager: lockPackageManager } = await detectLockfile(dir, fsMod);
      const packageManagerField = parsePackageManagerField(packageJson.packageManager);
      const devCommandToken = detectDevCommandToken(packageJson?.scripts?.dev);
      discovered.push({
        name: packageJson.name || path.basename(dir),
        dir,
        relativePath: normalizeRelativePath(root, dir),
        packageJsonPath,
        packageJson,
        scripts: packageJson.scripts || {},
        hasDevScript: Boolean(packageJson?.scripts?.dev),
        hasBuildScript: Boolean(packageJson?.scripts?.build),
        hasTypecheckScript: Boolean(packageJson?.scripts?.typecheck),
        packageManager: packageManagerField.name || lockPackageManager || 'npm',
        packageManagerField: {
          raw: packageJson.packageManager || null,
          name: packageManagerField.name,
          version: packageManagerField.version,
        },
        lockfile,
        dependencyCounts: {
          dependencies: dependencyCount(packageJson, 'dependencies'),
          devDependencies: dependencyCount(packageJson, 'devDependencies'),
          optionalDependencies: dependencyCount(packageJson, 'optionalDependencies'),
          peerDependencies: dependencyCount(packageJson, 'peerDependencies'),
        },
        workspacePatterns: workspacePatternsOf(packageJson),
        devCommandToken,
        validation: {
          localBinary: requiresLocalBinary(devCommandToken) ? devCommandToken : null,
          requiresLocalBinary: requiresLocalBinary(devCommandToken),
        },
      });
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (NODE_PROJECT_DISCOVERY_DENYLIST.has(entry.name)) continue;
      await walk(path.join(dir, entry.name));
    }
  };

  await walk(root);

  const workspaceRoots = discovered
    .filter((project) => project.workspacePatterns.length > 0)
    .sort((a, b) => b.relativePath.length - a.relativePath.length);

  const enriched = discovered
    .map((project) => {
      const workspaceRoot = workspaceRoots.find((candidate) => {
        if (candidate.dir === project.dir) return true;
        if (candidate.relativePath !== '.' && !project.relativePath.startsWith(`${candidate.relativePath}/`)) return false;
        const relFromWorkspace = normalizeRelativePath(candidate.dir, project.dir);
        return isWorkspaceMember(relFromWorkspace, candidate.workspacePatterns);
      });
      const installNeeded = workspaceRoot && workspaceRoot.dir !== project.dir
        ? false
        : Boolean(project.lockfile || hasInstallableDependencies(project.packageJson) || project.workspacePatterns.length > 0);
      const installReason = workspaceRoot && workspaceRoot.dir !== project.dir
        ? `géré par le workspace ${workspaceRoot.relativePath}`
        : project.lockfile
          ? `lockfile ${project.lockfile}`
          : hasInstallableDependencies(project.packageJson)
            ? 'dépendances déclarées sans lockfile'
            : project.workspacePatterns.length > 0
              ? 'racine de workspace'
              : 'aucune dépendance à installer';
      return {
        ...project,
        workspaceRoot: workspaceRoot ? workspaceRoot.relativePath : null,
        installNeeded,
        installReason,
      };
    })
    .sort((a, b) => {
      const depthA = a.relativePath === '.' ? 0 : a.relativePath.split('/').length;
      const depthB = b.relativePath === '.' ? 0 : b.relativePath.split('/').length;
      if (depthA !== depthB) return depthA - depthB;
      return a.relativePath.localeCompare(b.relativePath);
    });

  return enriched;
}

/**
 * Installe les dépendances de chaque sous-projet Node requis.
 */
export async function installNodeProjects(projects, {
  exec = localExec,
  onLog = () => {},
  tracker = createPhaseTracker(),
  env = process.env,
} = {}) {
  const records = [];
  /**
   * UNE CIBLE SANS DÉPENDANCE EST « PASSÉE », JAMAIS « RÉUSSIE ».
   *
   * Elle était simplement absente du flux : l'interface affichait alors une
   * ligne éternellement en attente, ou — pire, avec l'ancienne liste écrite à
   * la main — rien du tout. Dire `skipped` avec sa raison est la seule
   * description honnête d'un travail qui n'avait pas lieu d'être.
   */
  for (const project of projects.filter((entry) => !entry.installNeeded)) {
    tracker.skip('dependencies', project.installReason || 'aucune dépendance à installer', {
      target: project.relativePath,
    });
  }
  for (const project of projects.filter((entry) => entry.installNeeded)) {
    const { command, args } = installCommandFor(project);
    const startedAt = Date.now();
    const cwd = project.dir;
    const commandString = commandToString(command, args);
    tracker.phase('dependencies', 'running', {
      target: project.relativePath,
      packageManager: project.packageManager,
      command: commandString,
    });

    let execResult = { code: null, signal: null, stdout: '', stderr: '' };
    let spawnError = null;
    try {
      execResult = await exec(command, args, {
        cwd,
        timeoutMs: 600_000,
        env: installEnvironment(env),
      });
    } catch (err) {
      spawnError = err;
    }

    const record = {
      step: 'dependencies',
      project: project.relativePath,
      cwd,
      packageManager: project.packageManager,
      lockfile: project.lockfile,
      command: commandString,
      exitCode: execResult.code,
      durationMs: Date.now() - startedAt,
      status: spawnError || execResult.code !== 0 ? 'FAILED' : 'SUCCESS',
    };
    if (spawnError) record.error = String(spawnError.message || spawnError);
    emitStructuredDuplicateLog(onLog, record);

    if (spawnError || execResult.code !== 0) {
      tracker.phase('dependencies', 'error', {
        target: project.relativePath,
        exitCode: execResult.code,
        durationMs: record.durationMs,
      });
      throw new NodeProjectInitializationError(
        'DUPLICATION_DEPENDENCIES_INSTALL_FAILED',
        `Installation des dépendances échouée pour ${project.relativePath}.`,
        {
          ...record,
          stderr: execResult.stderr || '',
          stdout: execResult.stdout || '',
        }
      );
    }

    tracker.phase('dependencies', 'ok', {
      target: project.relativePath,
      durationMs: record.durationMs,
    });
    records.push(record);
  }
  return records;
}

/**
 * Vérifie qu'un projet dupliqué résout les binaires locaux requis pour `npm run dev`.
 */
export async function validateDuplicatedNodeProjects(projects, {
  fsMod = fs,
  onLog = () => {},
  tracker = createPhaseTracker(),
} = {}) {
  const records = [];
  for (const project of projects.filter((entry) => !entry.installNeeded)) {
    tracker.skip('validate', 'aucune dépendance installée à vérifier', {
      target: project.relativePath,
    });
  }
  for (const project of projects.filter((entry) => entry.installNeeded)) {
    tracker.phase('validate', 'running', { target: project.relativePath });
    const startedAt = Date.now();
    const nodeModulesPath = path.join(project.dir, 'node_modules');
    const nodeModulesPresent = await pathExists(nodeModulesPath, fsMod);
    const requiresLocalBinary = project.hasDevScript && project.validation.requiresLocalBinary;
    const candidates = requiresLocalBinary
      ? localBinaryCandidates(project.dir, project.validation.localBinary)
      : [];
    const resolvedPath = requiresLocalBinary
      ? (await Promise.all(candidates.map(async (candidate) => (
        (await pathExists(candidate, fsMod)) ? candidate : null
      )))).find(Boolean) || null
      : null;
    const manifestCandidates = requiresLocalBinary
      ? declaredPackageManifestCandidates(project, project.validation.localBinary)
      : [];
    const packageManifestPath = requiresLocalBinary
      ? (await Promise.all(manifestCandidates.map(async (candidate) => (
        (await pathExists(candidate, fsMod)) ? candidate : null
      )))).find(Boolean) || null
      : null;
    const binaryOk = !requiresLocalBinary || (resolvedPath && (!manifestCandidates.length || packageManifestPath));
    const ok = nodeModulesPresent && binaryOk;
    const record = {
      step: 'validation',
      project: project.relativePath,
      cwd: project.dir,
      packageManager: project.packageManager,
      command: requiresLocalBinary ? project.validation.localBinary : 'node_modules',
      exitCode: ok ? 0 : 1,
      durationMs: Date.now() - startedAt,
      status: ok ? 'SUCCESS' : 'FAILED',
      nodeModulesPath,
      nodeModulesPresent,
      requiresLocalBinary,
      resolvedPath,
      packageManifestPath,
    };
    emitStructuredDuplicateLog(onLog, record);
    if (!ok) {
      tracker.phase('validate', 'error', {
        target: project.relativePath,
        nodeModulesPresent,
        requiresLocalBinary,
      });
      throw new NodeProjectInitializationError(
        'DUPLICATION_NODE_PROJECT_VALIDATION_FAILED',
        requiresLocalBinary
          ? `Validation post-duplication échouée pour ${project.relativePath} : dépendances locales incomplètes (${project.validation.localBinary}).`
          : `Validation post-duplication échouée pour ${project.relativePath} : node_modules introuvable.`,
        record,
      );
    }
    tracker.phase('validate', 'ok', { target: project.relativePath, durationMs: record.durationMs });
    records.push(record);
  }
  return records;
}

/**
 * Orchestration complète de la duplication.
 * @param {object} input Entrées validées ou brutes (validées ici).
 * @param {object} [ctx]
 * @param {string} [ctx.sourceRoot]  Racine du projet source (déf. projet courant).
 * @param {string} [ctx.destParent]  Dossier parent où créer le projet (déf. parent du source).
 * @param {string} ctx.mongoUri      URI Mongo (obligatoire).
 * @param {string} ctx.stamp         Horodatage (fourni, pas de Date.now interne).
 * @param {(msg:string)=>void} [ctx.onLog]
 * @returns {Promise<{project:string, path:string, state:string, dbTest:object, dbProd:object, mongo:object, copy:object}>}
 */
export async function duplicateProject(input, ctx = {}) {
  const {
    sourceRoot = PROJECT_ROOT,
    mongoUri,
    stamp = 'init',
    onLog = () => {},
    onPhase = () => {},
    exec = localExec,
  } = ctx;
  /**
   * TOUTES LES ÉMISSIONS PASSENT PAR LE TRACEUR.
   *
   * `onPhase` reste le point de sortie — le contrôleur y branche le flux
   * NDJSON — mais il n'est plus appelé DIRECTEMENT par le pipeline. Le traceur
   * s'interpose pour refuser une phase hors registre, un statut hors
   * vocabulaire ou une transition impossible, et pour mémoriser l'état de
   * chacune. C'est ce qui rend calculable, à la fin, la question « a-t-on
   * vraiment fait tout ce qu'on devait ? ».
   */
  const tracker = createPhaseTracker(onPhase);
  const clean = validateDuplicationInput(input);
  if (!mongoUri) throw new ValidationError('MONGODB_URI requis pour la duplication.');

  const destParent = ctx.destParent || path.dirname(sourceRoot);
  const destRoot = path.join(destParent, clean.folderName);
  const safePaths = assertSafeDuplicationDestination(sourceRoot, destParent, destRoot);

  // Refus si la cible existe déjà (jamais d'écrasement silencieux).
  try {
    await fs.access(safePaths.destRoot);
    throw new ValidationError(`Le dossier cible existe déjà : ${safePaths.destRoot}`);
  } catch (err) {
    if (err instanceof ValidationError) throw err;
    /* n'existe pas : OK */
  }

  /**
   * L'IDENTITÉ DE LA SOURCE, LUE AVANT TOUT — et avant la moindre écriture.
   *
   * Elle ne sert pas à écrire : elle sert à VÉRIFIER. Sans elle, on saurait
   * poser la nouvelle identité sur la copie, mais pas démontrer que l'ancienne
   * a disparu — et c'est exactement la démonstration qui manquait quand le
   * premier clone réel a continué de s'appeler « sbauto » dans ses paquets et
   * dans ses manifestes.
   *
   * Lue ici, en tête : un profil illisible doit coûter une seconde, pas trois
   * minutes d'installation sur un dossier qu'il faudra supprimer.
   */
  const sourceIdentity = await readProjectIdentity(safePaths.sourceRoot);
  onLog(`[duplicate] identité de la source : ${sourceIdentity.slug} / ${sourceIdentity.projectId}`);

  // 1. Connexion Mongo.
  tracker.phase('mongo', 'running');
  onLog('[duplicate] test connexion Mongo…');
  const mongo = await testMongoConnection(mongoUri);
  tracker.phase('mongo', 'ok');

  // 2 & 3. Création DB TEST / PROD si absentes.
  tracker.phase('databases', 'running');
  const dbTest = await ensureDatabase(mongoUri, clean.dbTest, stamp);
  const dbProd = await ensureDatabase(mongoUri, clean.dbProd, stamp);

  // 4. Validation connexions (re-liste : les bases doivent désormais exister).
  const after = await testMongoConnection(mongoUri);
  const testOk = after.databases.includes(clean.dbTest);
  const prodOk = after.databases.includes(clean.dbProd);
  if (!testOk || !prodOk) {
    throw new ValidationError('Validation des bases échouée après création.');
  }
  tracker.phase('databases', 'ok');

  /* ══════════════════════════════════════════════════════════════════════════
     4 bis. LE PREMIER ADMINISTRATEUR LOCAL — étape BLOQUANTE.

     ══ POURQUOI ICI, ET NON APRÈS L'INSTALLATION DES DÉPENDANCES ════════════

     C'est le premier instant POSSIBLE : la base cible vient d'être créée et
     validée. C'est aussi le meilleur — un mot de passe refusé ou une base
     injoignable coûte alors quelques secondes, au lieu de se découvrir après
     trois minutes d'installation npm, sur un dossier qu'il faudra supprimer.

     ══ POURQUOI ELLE EST BLOQUANTE ═══════════════════════════════════════════

     Un projet livré sans administrateur n'est pas « presque prêt » : il est
     inutilisable par son client, et le dépannage passe par une écriture
     manuelle en base. Mieux vaut une duplication qui échoue franchement, sur
     un code typé, qu'un dossier complet dont personne ne peut ouvrir le
     manager.
     ══════════════════════════════════════════════════════════════════════════ */
  tracker.phase('first_admin', 'running');
  let admin;
  try {
    admin = await createFirstAdmin(mongoUri, clean.dbTest, {
      email: clean.adminEmail,
      password: clean.adminPassword,
    });
  } catch (err) {
    tracker.phase('first_admin', 'error');
    // Le message d'origine peut nommer la base ou la connexion — jamais le
    // secret, qui n'entre dans aucune chaîne de ce module.
    throw new ValidationError(
      `Création du premier administrateur impossible : ${err.message}`,
      { blocker: err.details?.blocker || 'FIRST_ADMIN_CREATION_FAILED' }
    );
  }
  if (!admin.created) {
    tracker.phase('first_admin', 'error');
    throw new ValidationError(
      'Un compte administrateur existe déjà dans la base cible : la duplication est interrompue '
        + 'plutôt que d’écraser un accès existant.',
      { blocker: 'FIRST_ADMIN_ALREADY_PRESENT' }
    );
  }
  // Adresse MASQUÉE dans le journal — le compte est nommé, jamais son secret.
  onLog(`[duplicate] premier administrateur créé (${maskEmailForLog(clean.adminEmail)}, role=ADMIN, status=ACTIVE)`);
  tracker.phase('first_admin', 'ok');

  // 5. Copie physique du dossier.
  tracker.phase('copy', 'running');
  const copy = await copyProject(safePaths.sourceRoot, safePaths.destRoot, { onLog });
  tracker.phase('copy', 'ok');

  // 6. Réécriture du .env (à partir du .env.example si pas de .env source).
  const srcEnvPath = path.join(safePaths.sourceRoot, 'backend', '.env');
  const exampleEnvPath = path.join(safePaths.sourceRoot, 'backend', '.env.example');
  let baseEnv = '';
  try {
    baseEnv = await fs.readFile(srcEnvPath, 'utf8');
  } catch {
    baseEnv = await fs.readFile(exampleEnvPath, 'utf8').catch(() => '');
  }
  tracker.phase('config', 'running');
  const newEnv = rewriteEnv(baseEnv, {
    dbTest: clean.dbTest,
    dbProd: clean.dbProd,
    projectName: clean.projectName,
    githubRepositoryUrl: clean.githubRepositoryUrl,
    firstDevEmail: clean.devEmail,
    firstDevName: clean.devName,
  });
  // Écriture ATOMIQUE : fichier temporaire puis rename — jamais un .env tronqué.
  const envPath = path.join(safePaths.destRoot, 'backend', '.env');
  const tmpPath = `${envPath}.tmp`;
  await fs.writeFile(tmpPath, `${newEnv}\n`, 'utf8');
  await fs.rename(tmpPath, envPath);

  // Vérification POST-ÉCRITURE : la clé est présente EXACTEMENT une fois, avec
  // la valeur normalisée saisie — sinon échec explicite, jamais silencieux.
  const written = await fs.readFile(envPath, 'utf8');
  const occurrences = written.split(/\r?\n/).filter((l) => /^PROJECT_GITHUB_REPOSITORY_URL=/.test(l));
  if (occurrences.length !== 1 || occurrences[0] !== `PROJECT_GITHUB_REPOSITORY_URL=${clean.githubRepositoryUrl}`) {
    throw new ValidationError('Vérification du .env dupliqué échouée : PROJECT_GITHUB_REPOSITORY_URL absente, dupliquée ou altérée.');
  }
  /**
   * ══ CE QUE LA VÉRIFICATION POST-ÉCRITURE CONTRÔLE DÉSORMAIS (LOT 2C) ══════
   *
   * Elle contrôlait deux PRÉSENCES : l'adresse et le mot de passe du premier
   * développeur. Elle en contrôle une, et une ABSENCE — et l'absence est la
   * plus importante des deux.
   *
   * Une copie qui repartirait avec `SEED_DEV_PASSWORD` hérité de sa source
   * ressusciterait le défaut entier : mot de passe partagé, en clair, sur
   * disque. Le filtre de `rewriteEnv` l'enlève ; ce contrôle prouve qu'il l'a
   * fait, sur le fichier RÉELLEMENT écrit.
   */
  const writtenLines = written.split(/\r?\n/);
  const emailLines = writtenLines.filter((l) => /^FIRST_DEV_EMAIL=/.test(l));
  if (emailLines.length !== 1 || emailLines[0] !== `FIRST_DEV_EMAIL=${clean.devEmail}`) {
    throw new ValidationError('Vérification du .env dupliqué échouée : FIRST_DEV_EMAIL absente, dupliquée ou altérée.');
  }
  const secretsResiduels = writtenLines.filter((l) => ENV_KEYS_TO_STRIP.some((k) => new RegExp(`^${k}=`).test(l)));
  if (secretsResiduels.length > 0) {
    throw new ValidationError(
      'Vérification du .env dupliqué échouée : un secret d’amorçage hérité subsiste '
        + `(${secretsResiduels.length} ligne(s)). Aucune copie ne doit naître avec un mot de passe partagé.`
    );
  }
  /**
   * ── L'IDENTITÉ TECHNIQUE DE LA COPIE, ÉCRITE AU MÊME MOMENT QUE SON .env ──
   *
   * Même phase, parce que c'est la même question : « qui est ce projet ? ». La
   * séparer aurait créé un instant où la copie a ses bases et son dépôt, mais
   * annonce encore le nom de sa source.
   */
  const profilPath = path.join(
    safePaths.destRoot, 'backend', 'src', 'deployment-engine', 'config', 'project.profile.js',
  );
  const identite = deriveProjectIdentity(clean.projectName);
  const profilSource = await fs.readFile(profilPath, 'utf8');
  const profilReecrit = rewriteProjectProfile(profilSource, identite);
  const profilTmp = `${profilPath}.tmp`;
  await fs.writeFile(profilTmp, profilReecrit, 'utf8');
  await fs.rename(profilTmp, profilPath);

  /** Vérification POST-ÉCRITURE, sur le fichier réellement écrit. */
  const profilEcrit = await fs.readFile(profilPath, 'utf8');
  /**
   * La déclaration attendue est COMPOSÉE à partir du nom de la constante, et
   * non épelée : le cœur d'un moteur ne doit contenir aucune ligne ressemblant
   * à une identité en dur — voir `identity.js`, `lireConstante`.
   */
  const declaration = (nom, valeur) => `export const ${nom} = '${valeur}'`;
  if (!profilEcrit.includes(declaration('PROJECT_SLUG', identite.slug))
    || !profilEcrit.includes(declaration('PROJECT_ID', identite.projectId))) {
    throw new ValidationError(
      'Vérification du profil dupliqué échouée : la copie porte encore une autre identité technique.',
    );
  }
  /**
   * ══ ET TOUTES LES AUTRES AUTORITÉS D'IDENTITÉ, AU MÊME INSTANT ═══════════
   *
   * Le profil n'était pas le seul endroit à porter le nom du projet — il était
   * seulement le seul qu'on réécrivait. Manifestes de moteur, noms de paquets
   * et de lockfiles, titres d'onglet, bannière de démarrage : tout cela
   * annonçait encore la source dans le premier clone réel.
   *
   * `identite.source` est lue AVANT la copie : sans elle, on saurait écrire la
   * nouvelle identité mais pas VÉRIFIER que l'ancienne a disparu.
   */
  const identiteEtendue = await rewriteProjectIdentity(
    safePaths.destRoot,
    { ...identite, projectName: clean.projectName },
    { source: sourceIdentity },
  );

  emitStructuredDuplicateLog(onLog, {
    step: 'identity',
    slug: identite.slug,
    projectId: identite.projectId,
    rewritten: identiteEtendue.rewritten.map((r) => r.file),
    toReview: identiteEtendue.toReview,
  });
  for (const r of identiteEtendue.rewritten) onLog(`[duplicate] identité réécrite — ${r.file} (${r.field})`);
  for (const t of identiteEtendue.toReview) onLog(`[duplicate] à personnaliser — ${t}`);

  tracker.phase('config', 'ok');

  /* ══════════════════════════════════════════════════════════════════════════
     LA COPIE EST-ELLE PROPRE ? — on relit, on ne suppose pas.
     ══════════════════════════════════════════════════════════════════════════ */
  tracker.phase('cleanliness', 'running');
  let proprete;
  try {
    proprete = await assertCleanTree(safePaths.destRoot);
  } catch (err) {
    tracker.phase('cleanliness', 'error');
    throw new ValidationError(
      `Duplication interrompue — le clone n’est pas propre. ${err.message}`,
      { blocker: err.code ?? 'DUPLICATION_TREE_NOT_CLEAN', ...(err.details ?? {}) },
    );
  }
  /**
   * LE BALAYAGE RÉSIDUEL NE BLOQUE PAS, ET C'EST RAISONNÉ.
   *
   * Le nom d'un projet apparaît légitimement dans un dépôt : un commentaire qui
   * raconte un incident, une fixture de test, une adresse d'exemple. Bloquer
   * là-dessus apprendrait à effacer des commentaires utiles pour obtenir du
   * vert. Ce qui bloque est la vérification des fichiers d'identité, faite
   * juste au-dessus ; ceci informe l'opérateur, qui décide.
   */
  const residuel = await scanResidualSourceIdentity(safePaths.destRoot, sourceIdentity);
  onLog(
    `[duplicate] propreté — ${proprete.checked.length} dossier(s) vierge(s) vérifié(s) ; `
    + `identité de la source : ${residuel.code.length} occurrence(s) hors commentaires `
    + `sur ${residuel.occurrences.length} au total (${residuel.files} fichiers balayés).`,
  );
  emitStructuredDuplicateLog(onLog, {
    step: 'cleanliness',
    emptyDirectories: proprete.checked,
    residualIdentity: { total: residuel.occurrences.length, inCode: residuel.code.length },
  });
  tracker.phase('cleanliness', 'ok', {
    emptyDirectories: proprete.checked.length,
    residualIdentityInCode: residuel.code.length,
  });

  tracker.phase('discover', 'running');
  const nodeProjects = await discoverNodeProjects(safePaths.destRoot);
  emitStructuredDuplicateLog(onLog, {
    step: 'discover',
    projectCount: nodeProjects.length,
    projects: nodeProjects.map((project) => ({
      path: project.relativePath,
      packageManager: project.packageManager,
      lockfile: project.lockfile,
      installNeeded: project.installNeeded,
      workspaceRoot: project.workspaceRoot,
    })),
  });
  /**
   * LA DÉTECTION EST UNE PHASE STATIQUE, ET C'EST DÉLIBÉRÉ.
   *
   * Elle s'exécute UNE fois et PRODUIT la liste des cibles. Émettre un
   * `discover` par sous-projet — ce que faisait l'ancien moteur — racontait
   * l'inverse de ce qui se passe : on aurait « détecté le backend » avant de
   * savoir qu'il existait. Les cibles trouvées sont un DÉTAIL de la phase, pas
   * autant de phases.
   */
  tracker.phase('discover', 'ok', {
    projectCount: nodeProjects.length,
    targets: nodeProjects.map((project) => project.relativePath),
  });

  /**
   * AUCUN SOUS-PROJET : les deux familles dynamiques sont PASSÉES, avec leur
   * raison. Les laisser muettes ferait une checklist incomplète sur une
   * duplication pourtant réussie — et c'est exactement la situation où l'on
   * doute d'un outil.
   */
  if (nodeProjects.length === 0) {
    tracker.skip('dependencies', 'aucun sous-projet Node découvert');
    tracker.skip('validate', 'aucun sous-projet Node découvert');
  }

  const dependencyInstalls = await installNodeProjects(nodeProjects, {
    exec,
    onLog,
    tracker,
    env: process.env,
  });

  const validation = await validateDuplicatedNodeProjects(nodeProjects, { onLog, tracker });

  /**
   * ══ ON NE DÉCLARE PAS « PRÊT » CE QU'ON N'A PAS FAIT ══════════════════════
   *
   * Avant de conclure, on demande au traceur si une phase OBLIGATOIRE est
   * restée en attente ou en cours. C'est la garantie que la checklist ne peut
   * pas afficher une duplication complète alors qu'une étape a été sautée par
   * un chemin de code oublié — le défaut est alors dans le MOTEUR, et il se
   * signale ici plutôt que six mois plus tard, sur un projet livré.
   */
  const manquantes = tracker.missingRequired().filter((id) => id !== 'done');
  if (manquantes.length > 0) {
    throw new ValidationError(
      `Duplication incomplète : phase(s) obligatoire(s) non abouties — ${manquantes.join(', ')}.`,
      { blocker: 'DUPLICATION_PHASE_MISSING', phases: manquantes }
    );
  }

  tracker.phase('done', 'running');
  tracker.phase('done', 'ok');

  // 8. Retour.
  return {
    project: clean.projectName,
    path: safePaths.destRoot,
    state: 'created',
    mongo,
    dbTest: { name: clean.dbTest, ...dbTest },
    dbProd: { name: clean.dbProd, ...dbProd },
    copy,
    /**
     * L'IDENTITÉ EFFECTIVEMENT POSÉE — et celle qu'on a remplacée.
     *
     * Le rapport disait ce qui avait été copié et installé, jamais QUI la copie
     * est devenue. Un opérateur devait ouvrir un fichier pour le savoir, et une
     * recette ne pouvait rien en affirmer.
     */
    identity: { ...identite, projectName: clean.projectName, replaced: sourceIdentity },
    /** Ce que la réécriture d'identité a touché, et ce qui reste à un humain. */
    identityRewrite: identiteEtendue,
    /** Ce que le contrôle de propreté a réellement constaté sur la copie. */
    cleanliness: {
      emptyDirectories: proprete.checked,
      residualIdentity: {
        total: residuel.occurrences.length,
        inCode: residuel.code.length,
        skippedTokens: residuel.skippedTokens ?? [],
      },
    },
    nodeProjects: nodeProjects.map(summarizeNodeProject),
    dependencyInstalls,
    validation,
    githubRepositoryUrl: clean.githubRepositoryUrl,
    /**
     * IL N'Y A PLUS DE MOT DE PASSE À TAIRE (LOT 2C).
     *
     * Le rapport prenait soin de ne pas afficher le mot de passe du compte
     * créé. Il n'en existe plus : le compte naît en attente d'activation, et
     * son titulaire choisira son secret. Le rapport dit donc l'état réel —
     * ce qui reste à faire pour que le projet soit administrable.
     */
    devAccount: { email: clean.devEmail, name: clean.devName, status: 'PENDING_ACTIVATION' },
    /**
     * L'ADMINISTRATEUR EST NOMMÉ PAR UNE ADRESSE MASQUÉE.
     *
     * Le rapport est écrit dans un flux, relu à l'écran, parfois recopié dans
     * un ticket. Le compte doit s'y reconnaître — sinon l'exploitant ne peut
     * pas vérifier qu'il a livré le bon — sans que le document devienne un
     * annuaire d'accès d'administration. Le mot de passe, lui, n'existe dans
     * aucune structure retournée : il ne quitte jamais la mémoire du moteur.
     */
    adminAccount: {
      email: maskEmailForLog(clean.adminEmail),
      role: 'ADMIN',
      status: 'ACTIVE',
    },
    /**
     * LA CHECKLIST DU RAPPORT DÉRIVE DU REGISTRE ET DE L'EXÉCUTION.
     *
     * Elle n'est pas une TROISIÈME liste écrite à la main : le traceur rend
     * l'état réel de chaque instance, et le libellé vient du registre. Un
     * rapport ne peut donc plus affirmer qu'une étape s'est bien passée
     * autrement qu'en la citant telle qu'elle a été observée.
     */
    checklist: tracker.checklist(),
    envCheck: {
      githubRepositoryUrl: 'present-unique-normalized',
      firstDevEmail: 'present-unique',
      legacySeedPasswords: 'absent',
    },
  };
}

export default {
  duplicateProject,
  validateDuplicationInput,
  rewriteEnv,
  quoteEnvValue,
  sanitizeFolderName,
  assertSafeDuplicationDestination,
  testMongoConnection,
  ensureDatabase,
  initializeDatabase,
  initializeDuplicatedProjectDatabases,
  maskMongoUri,
  copyProject,
  discoverNodeProjects,
  installNodeProjects,
  validateDuplicatedNodeProjects,
  COPY_DENYLIST,
  NODE_PROJECT_DISCOVERY_DENYLIST,
};
