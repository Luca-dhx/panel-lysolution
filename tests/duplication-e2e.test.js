// DUPLICATION COMPLÈTE — exécutée pour de vrai (Phase 2E, LOT 6).
//
// Ce test ne simule rien : il duplique RÉELLEMENT ce projet dans un dossier
// temporaire, contre une MongoDB réelle (en mémoire), puis vérifie que la
// copie est un projet autonome et distinct. Le dossier est supprimé à la fin.
//
// Ce qu'il prouve :
//   · les secrets de la copie sont NEUFS (jamais ceux de la source) ;
//   · les bases sont distinctes et réellement créées ;
//   · les deux moteurs sont présents dans la copie ;
//   · les profils et manifestes ont suivi ;
//   · la copie est syntaxiquement valide et sa configuration démarre.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { check, finish, section, setTestEnv, startMemoryMongo, stopMemoryMongo } from './helpers/harness.js';

setTestEnv();
const mongoUri = await startMemoryMongo();

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { duplicateProject, generateProjectSecrets } = await import(
  '../backend/src/duplication-engine/index.js'
);
const { SECRETS_TO_GENERATE } = await import(
  '../backend/src/duplication-engine/config/duplication.profile.js'
);

// Dossier de travail JAMAIS dans le dépôt : la copie ne doit pas polluer Git.
const workDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'panel-dup-e2e-'));
const folderName = 'panel-copie-recette';
const destRoot = path.join(workDir, folderName);

const readEnv = (file) => Object.fromEntries(
  fs.readFileSync(file, 'utf8').split(/\r?\n/)
    .map((l) => l.trim()).filter((l) => l && !l.startsWith('#'))
    .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
);

const sourceEnv = readEnv(path.join(projectRoot, 'backend', '.env'));

/**
 * LA SENTINELLE DE NON-COPIE — déposée dans les `node_modules` de la SOURCE.
 *
 * Aucune installation ne peut la produire : sa présence dans la copie ne
 * pourrait signifier qu'une chose, et c'est exactement ce qu'on interdit.
 * Elle est retirée au nettoyage, quoi qu'il arrive.
 */
const SENTINELLE = '.duplication-e2e-sentinelle';
const sentinellePath = path.join(projectRoot, 'backend', 'node_modules', SENTINELLE);
fs.writeFileSync(sentinellePath, 'recette de duplication : ce fichier ne doit jamais être copié');
const logs = [];
const phases = [];

let result = null;
let duplicationError = null;
try {
  result = await duplicateProject(
    {
      projectName: 'Panel Copie Recette',
      folderName,
      dbTest: 'panel_copie_test',
      dbProd: 'panel_copie_prod',
      /**
       * ══ LE PREMIER DÉVELOPPEUR : UNE IDENTITÉ, PAS UN SECRET (lot 2C) ═════
       *
       * Cet appel postait `devPassword`. Le moteur ne l'accepte plus — et pas
       * par oubli : il le REFUSE bruyamment, parce qu'un client qui continue de
       * l'envoyer croirait avoir choisi un mot de passe pendant que le compte
       * réel s'active par un tout autre chemin. On se conforme donc au contrat
       * actuel — nom et adresse — et le refus lui-même est éprouvé plus bas,
       * là où il devient un invariant plutôt qu'une panne de recette.
       */
      devEmail: 'dev@copie.test',
      devName: 'Developpeuse de recette',
      adminEmail: 'admin@copie.test',
      adminPassword: 'RecetteCopie!2026#panel',
      githubRepositoryUrl: 'https://github.com/exemple/panel-copie.git',
    },
    {
      sourceRoot: projectRoot,
      destParent: workDir,
      mongoUri,
      stamp: 'recette',
      runSeed: false, // le seed exige un serveur applicatif : hors périmètre ici
      onLog: (m) => logs.push(String(m)),
      onPhase: (p) => phases.push(p),
    },
  );
} catch (err) {
  duplicationError = err;
}

section('Le contrat périmé du premier développeur est REFUSÉ');
{
  /**
   * Un client d'API antérieur au lot 2C poste encore `devPassword`. Le laisser
   * passer en silence serait le pire des deux mondes : il croirait avoir fixé
   * le secret d'un compte qui, lui, s'activera par courriel. On vérifie donc
   * que le moteur refuse, et qu'il refuse AVANT de toucher au disque — un
   * dossier à demi copié serait à nettoyer à la main.
   */
  let refus = null;
  try {
    await duplicateProject(
      {
        projectName: 'Panel Copie Perimee', folderName: `${folderName}-perime`,
        dbTest: 'panel_perime_test', dbProd: 'panel_perime_prod',
        devEmail: 'dev@copie.test', devName: 'Developpeuse de recette',
        adminEmail: 'admin@copie.test', adminPassword: 'RecetteCopie!2026#panel',
        devPassword: 'MotDePasseCopie!42',
      },
      { sourceRoot: projectRoot, destParent: workDir, mongoUri, stamp: 'recette', runSeed: false },
    );
  } catch (err) { refus = err; }

  check('le moteur refuse `devPassword`', refus !== null);
  check('…en nommant le blocage', refus?.details?.blocker === 'FIRST_DEV_PASSWORD_REFUSED');
  check('…et en disant par où le secret se choisit désormais',
    /lien d’activation|lien d'activation/.test(refus?.message ?? ''));
  check('…sans avoir rien écrit sur le disque',
    !fs.existsSync(path.join(workDir, `${folderName}-perime`)));
}

section('La duplication s’exécute réellement');
{
  check(`duplication aboutie${duplicationError ? ` — ${duplicationError.message}` : ''}`, duplicationError === null);
  check('dossier de destination créé', fs.existsSync(destRoot));
  check('phases émises dans l’ordre (mongo avant copie)',
    phases.findIndex((p) => p.phase === 'mongo') < phases.findIndex((p) => p.phase === 'copy'));
}

section('Structure : la copie est un projet complet');
{
  for (const entry of ['backend', 'frontend', 'docs', 'tests', 'deploy', 'README.md']) {
    check(`${entry} présent dans la copie`, fs.existsSync(path.join(destRoot, entry)));
  }
  /**
   * ══ « NON COPIÉ » NE SE PROUVE PLUS PAR L'ABSENCE ═══════════════════════
   *
   * Ce contrôle vérifiait que `backend/node_modules` n'existait pas dans la
   * copie. Il ne le peut plus : la duplication INSTALLE désormais les
   * dépendances depuis le lockfile de la copie — c'est même la section
   * suivante qui l'exige. Le dossier existe donc, et pour une bonne raison.
   *
   * Ce que la section veut dire reste vrai et reste vérifiable : le contenu
   * de la copie n'est pas un décalque de celui de la source. On dépose donc
   * une sentinelle dans les `node_modules` SOURCE avant la duplication ; si
   * elle réapparaît dans la copie, c'est qu'elle a été copiée — une
   * installation propre ne l'inventerait jamais.
   */
  check('node_modules NON copié — la sentinelle de la source ne s’y trouve pas',
    !fs.existsSync(path.join(destRoot, 'backend', 'node_modules', SENTINELLE)));
  check('…et la copie a bien SES dépendances, installées et non décalquées',
    fs.existsSync(path.join(destRoot, 'backend', 'node_modules')));
  check('.git NON copié (la copie est un projet neuf)', !fs.existsSync(path.join(destRoot, '.git')));
}

section('Les deux moteurs sont embarqués dans la copie');
{
  for (const engine of ['deployment-engine', 'duplication-engine']) {
    const dir = path.join(destRoot, 'backend', 'src', engine);
    check(`${engine} présent`, fs.existsSync(dir));
    check(`${engine} : manifeste présent`, fs.existsSync(path.join(dir, 'engine.manifest.json')));
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'engine.manifest.json'), 'utf8'));
    check(`${engine} : versionné (${manifest.version})`, /^\d+\.\d+\.\d+$/.test(manifest.version));
    check(`${engine} : profil de configuration présent`, fs.existsSync(path.join(dir, 'config')));
  }
  check('deployment-engine : cœur complet',
    ['nginx.js', 'rollback.js', 'pipeline.js', 'engineInfo.js', 'migrations']
      .every((f) => fs.existsSync(path.join(destRoot, 'backend', 'src', 'deployment-engine', f))));

  // Le cœur de la copie doit être IDENTIQUE à celui de la source.
  const coreFile = path.join('backend', 'src', 'deployment-engine', 'nginx.js');
  check('cœur du moteur identique à la source (aucune dérive à la duplication)',
    fs.readFileSync(path.join(destRoot, coreFile), 'utf8')
      === fs.readFileSync(path.join(projectRoot, coreFile), 'utf8'));
}

section('Secrets : la copie n’hérite RIEN de sa source');
{
  const copyEnv = readEnv(path.join(destRoot, 'backend', '.env'));
  for (const spec of SECRETS_TO_GENERATE) {
    check(`${spec.key} présent dans la copie`, Boolean(copyEnv[spec.key]));
    check(`${spec.key} DIFFÉRENT de celui de la source`,
      copyEnv[spec.key] !== sourceEnv[spec.key]);
    const expectedLength = spec.encoding === 'hex' ? spec.bytes * 2 : undefined;
    if (expectedLength) {
      check(`${spec.key} : longueur attendue (${expectedLength})`,
        copyEnv[spec.key].length === expectedLength);
    }
  }
  const raw = fs.readFileSync(path.join(destRoot, 'backend', '.env'), 'utf8');
  check('aucun secret de la source ne subsiste dans le .env de la copie',
    SECRETS_TO_GENERATE.every((s) => !sourceEnv[s.key] || !raw.includes(sourceEnv[s.key])));

  // Deux duplications successives ne doivent jamais produire les mêmes secrets.
  const a = generateProjectSecrets();
  const b = generateProjectSecrets();
  check('deux copies reçoivent des secrets différents',
    Object.keys(a).every((k) => a[k] !== b[k]));
}

section('Bases : distinctes, et réellement créées');
{
  const copyEnv = readEnv(path.join(destRoot, 'backend', '.env'));
  check('DB_TEST réécrite', copyEnv.DB_TEST === 'panel_copie_test');
  check('DB_PROD réécrite', copyEnv.DB_PROD === 'panel_copie_prod');
  check('bases TEST et PROD distinctes', copyEnv.DB_TEST !== copyEnv.DB_PROD);
  check('bases différentes de celles de la source',
    copyEnv.DB_TEST !== sourceEnv.DB_TEST && copyEnv.DB_PROD !== sourceEnv.DB_PROD);

  const { MongoClient } = await import(
    // Le paquet vit dans backend/node_modules : on le résout explicitement.
    (await import('node:url')).pathToFileURL(
      (await import('node:module')).createRequire(
        new URL('../backend/package.json', import.meta.url),
      ).resolve('mongodb'),
    ).href
  );
  const client = new MongoClient(mongoUri);
  await client.connect();
  const { databases } = await client.db().admin().listDatabases();
  const names = databases.map((d) => d.name);
  check('base TEST réellement créée', names.includes('panel_copie_test'));
  check('base PROD réellement créée', names.includes('panel_copie_prod'));
  await client.close();
}

section('Identité : la copie ne se prend pas pour sa source');
{
  const copyEnv = readEnv(path.join(destRoot, 'backend', '.env'));
  check('nom du projet réécrit', copyEnv.PANEL_NAME === 'Panel Copie Recette');
  check('dépôt GitHub de la COPIE, jamais celui de la source',
    copyEnv.PROJECT_GITHUB_REPOSITORY_URL === 'https://github.com/exemple/panel-copie.git');
  /**
   * L'IDENTITÉ DU PREMIER DÉVELOPPEUR, PAS SON SECRET (lot 2C).
   *
   * Ce contrôle lisait `SEED_DEV_EMAIL`. Le couple d'amorçage a été remplacé :
   * l'assistant écrit `FIRST_DEV_EMAIL` / `FIRST_DEV_NAME`, et le secret n'est
   * plus écrit nulle part — il se choisit par le lien d'activation.
   */
  check('identité du premier développeur, propre à la copie',
    copyEnv.FIRST_DEV_EMAIL === 'dev@copie.test');
  check('…avec son nom, tel qu’il a été saisi',
    (copyEnv.FIRST_DEV_NAME ?? '').replace(/^"|"$/g, '') === 'Developpeuse de recette');
  check('…et AUCUNE identité d’amorçage héritée de la source',
    copyEnv.SEED_DEV_EMAIL === undefined);
  check('variables non concernées préservées',
    copyEnv.MONGODB_URI !== undefined && copyEnv.ENV !== undefined);
}

section('Validité : la copie est du code exécutable');
{
  // Analyse syntaxique de l'ensemble du backend copié — sans dépendances.
  const backendSrc = path.join(destRoot, 'backend', 'src');
  const files = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.js')) files.push(full);
    }
  };
  walk(backendSrc);
  const broken = [];
  for (const file of files) {
    try {
      execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
    } catch {
      broken.push(path.relative(destRoot, file));
    }
  }
  check(`les ${files.length} fichiers du backend copié sont syntaxiquement valides${broken.length ? ` — ${broken.join(', ')}` : ''}`,
    broken.length === 0);

  // INSTALLATION RÉELLE des dépendances de la copie — sans elle, la copie
  // n'est pas exécutable (le `node_modules` n'est volontairement pas copié).
  // C'est le geste qu'un développeur ferait après une duplication.
  let installed = true;
  try {
    execFileSync('npm', ['ci', '--omit=dev', '--no-audit', '--no-fund'], {
      cwd: path.join(destRoot, 'backend'), stdio: 'pipe', shell: process.platform === 'win32',
      timeout: 600_000,
    });
  } catch (err) {
    installed = false;
    console.error(`     (npm ci a échoué : ${String(err.message).slice(0, 200)})`);
  }
  check('les dépendances de la copie s’installent depuis SON lockfile', installed);

  // La configuration de la copie doit se charger et refuser les cas invalides :
  // c'est la preuve que la copie « démarre » au sens fail-closed du standard.
  const envUrl = (await import('node:url')).pathToFileURL(
    path.join(backendSrc, 'config', 'env.js'),
  ).href;
  const copyEnv = readEnv(path.join(destRoot, 'backend', '.env'));
  /**
   * L'ENVIRONNEMENT DU HARNAIS N'EST PAS CELUI DE LA COPIE.
   *
   * Ce processus a chargé le `.env` de la SOURCE : `process.env` porte donc
   * ses identifiants d'amorçage. Les laisser filtrer ferait juger la copie sur
   * des valeurs qu'elle ne possède pas — et, en `ENV=PROD`, la ferait refuser
   * pour une raison qui n'est pas la sienne. On les retire explicitement : une
   * copie fraîche n'en a aucun.
   */
  const environnementHarnais = { ...process.env };
  delete environnementHarnais.SEED_DEV_EMAIL;
  delete environnementHarnais.SEED_DEV_PASSWORD;

  const baseEnv = {
    ...environnementHarnais,
    PANEL_SKIP_DOTENV: '1',
    ENV: 'TEST',
    MONGODB_URI: mongoUri,
    DB_TEST: copyEnv.DB_TEST,
    DB_PROD: copyEnv.DB_PROD,
    JWT_SECRET: copyEnv.JWT_SECRET,
    JWT_EXPIRES_IN: copyEnv.JWT_EXPIRES_IN || '12h',
    BRIDGE_ENCRYPTION_KEY: copyEnv.BRIDGE_ENCRYPTION_KEY,
    /**
     * AUCUN MOT DE PASSE D'AMORÇAGE N'EST REPRIS — il n'y en a plus.
     *
     * `SEED_DEV_PASSWORD` figure dans `ENV_KEYS_TO_STRIP` : le `.env` d'une
     * copie n'en porte pas, et `copyEnv.SEED_DEV_PASSWORD` est donc `undefined`
     * par construction. On charge la configuration SANS lui, ce qui est
     * précisément l'état réel d'une copie fraîche. Le refus en mode PROD des
     * identifiants de développement connus reste éprouvé plus bas, en les
     * fournissant explicitement.
     */
  };
  check('le `.env` de la copie ne porte AUCUN mot de passe d’amorçage',
    copyEnv.SEED_DEV_PASSWORD === undefined && copyEnv.SEED_ADMIN_PASSWORD === undefined);
  check('…mais il porte bien l’IDENTITÉ du premier développeur',
    copyEnv.FIRST_DEV_EMAIL === 'dev@copie.test');
  const loadConfig = (overrides = {}) => {
    const env = { ...baseEnv, ...overrides };
    for (const [k, v] of Object.entries(overrides)) if (v === undefined) delete env[k];
    const script = `import(${JSON.stringify(envUrl)}).then((m) => console.log(m.config.dbName));`;
    try {
      const out = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
        env, encoding: 'utf8', stdio: 'pipe',
      });
      return { ok: true, dbName: out.trim().split('\n').pop() };
    } catch {
      return { ok: false };
    }
  };

  const ok = loadConfig();
  check('la configuration de la copie se charge avec SES secrets', ok.ok === true);
  check('…et sélectionne SA base de test', ok.dbName === 'panel_copie_test');
  check('ENV=PROD sélectionne SA base de production',
    loadConfig({ ENV: 'PROD' }).dbName === 'panel_copie_prod');
  check('la copie refuse en PROD les identifiants seed de développement',
    loadConfig({ ENV: 'PROD', SEED_DEV_EMAIL: 'dev@panel.test', SEED_DEV_PASSWORD: 'motdepasse-test' }).ok === false);
  check('la copie reste fail-closed (secret retiré → refus)',
    loadConfig({ JWT_SECRET: undefined }).ok === false);
}

section('Nettoyage');
{
  await fsp.rm(workDir, { recursive: true, force: true });
  await fsp.rm(sentinellePath, { force: true });
  check('la sentinelle est retirée de la source', !fs.existsSync(sentinellePath));
  check('dossier temporaire supprimé', !fs.existsSync(workDir));
  check('aucune trace dans le dépôt', !fs.existsSync(path.join(projectRoot, '..', folderName)));
}

await stopMemoryMongo();
finish();
