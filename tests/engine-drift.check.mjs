// Contrôle de dérive des MOTEURS STANDARDS de l'écosystème.
//
// Règle d'architecture (Phase 2D) : le CŒUR des deux moteurs est identique
// dans tous les projets. Ce qui distingue un projet passe par
// `config/`, `templates/` et `adapters/` — jamais par un fork du cœur.
//
// Ce contrôle est un OUTIL D'ATELIER : il compare les moteurs de ce dépôt à
// ceux du projet de référence quand celui-ci est présent dans le workspace,
// et se retire proprement (exit 0, SKIP) sinon. Il ne crée AUCUNE dépendance
// runtime : rien dans backend/src ne lit le dépôt voisin.
//
// Il vérifie deux choses distinctes :
//   1. le cœur n'a pas dérivé (comparaison octet, fins de ligne normalisées) ;
//   2. les fichiers légitimement spécifiques existent bien et diffèrent
//      (un profil identique signifierait que le projet n'a pas été adapté).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const referenceRoot = process.env.ENGINE_REFERENCE_DIR
  ? path.resolve(process.env.ENGINE_REFERENCE_DIR)
  : path.resolve(projectRoot, '..', 'SB Auto 06', 'backend', 'src');

const localRoot = path.join(projectRoot, 'backend', 'src');

const ENGINES = ['deployment-engine', 'duplication-engine'];

// Fichiers dont la divergence est ATTENDUE et documentée.
const PROJECT_SPECIFIC = new Set([
  path.join('deployment-engine', 'config', 'project.profile.js'),
  path.join('deployment-engine', 'engine.manifest.json'),
  path.join('duplication-engine', 'config', 'duplication.profile.js'),
  path.join('duplication-engine', 'engine.manifest.json'),
]);

if (!fs.existsSync(referenceRoot)) {
  console.log(`[engine-drift] SKIP : projet de référence introuvable (${referenceRoot}).`);
  console.log('[engine-drift] Le contrôle ne tourne que dans le workspace d’audit.');
  process.exit(0);
}

const normalize = (text) => text.replace(/\r\n/g, '\n');

function listFiles(root, engine) {
  const base = path.join(root, engine);
  if (!fs.existsSync(base)) return [];
  const out = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else out.push(path.relative(root, full));
    }
  };
  walk(base);
  return out.sort();
}

let failures = 0;
const fail = (message) => { failures += 1; console.error(`  ✗ ${message}`); };
const pass = (message) => console.log(`  ✓ ${message}`);

for (const engine of ENGINES) {
  console.log(`\n━━━ ${engine} ━━━`);
  const localFiles = listFiles(localRoot, engine);
  const refFiles = listFiles(referenceRoot, engine);

  if (localFiles.length === 0) { fail(`${engine} absent de ce projet.`); continue; }
  if (refFiles.length === 0) { fail(`${engine} absent du projet de référence.`); continue; }

  // 1. Même inventaire de fichiers — un fichier en trop ou en moins est une
  //    dérive structurelle, même si le contenu commun est identique.
  const onlyLocal = localFiles.filter((f) => !refFiles.includes(f));
  const onlyRef = refFiles.filter((f) => !localFiles.includes(f));
  if (onlyLocal.length === 0 && onlyRef.length === 0) {
    pass(`inventaire identique (${localFiles.length} fichiers)`);
  } else {
    if (onlyLocal.length) fail(`fichiers présents ici seulement : ${onlyLocal.join(', ')}`);
    if (onlyRef.length) fail(`fichiers présents dans la référence seulement : ${onlyRef.join(', ')}`);
  }

  // 2. Le cœur ne doit pas avoir dérivé.
  const common = localFiles.filter((f) => refFiles.includes(f));
  const core = common.filter((f) => !PROJECT_SPECIFIC.has(f));
  const drifted = core.filter((f) =>
    normalize(fs.readFileSync(path.join(localRoot, f), 'utf8'))
      !== normalize(fs.readFileSync(path.join(referenceRoot, f), 'utf8')));
  if (drifted.length === 0) {
    pass(`cœur identique à la référence (${core.length} fichiers)`);
  } else {
    fail(`cœur dérivé sur ${drifted.length} fichier(s) : ${drifted.join(', ')}`);
    console.error('     → un correctif doit être porté dans les DEUX projets, ou');
    console.error('       la différence doit sortir vers config/ · templates/ · adapters/.');
  }

  // 3. Les fichiers spécifiques doivent exister ET différer.
  for (const specific of PROJECT_SPECIFIC) {
    if (!specific.startsWith(engine + path.sep)) continue;
    const localPath = path.join(localRoot, specific);
    const refPath = path.join(referenceRoot, specific);
    if (!fs.existsSync(localPath)) { fail(`fichier de personnalisation manquant : ${specific}`); continue; }
    if (!fs.existsSync(refPath)) continue;
    if (normalize(fs.readFileSync(localPath, 'utf8')) === normalize(fs.readFileSync(refPath, 'utf8'))) {
      fail(`${specific} est identique à la référence : le projet n’a pas été adapté.`);
    } else {
      pass(`${path.basename(specific)} personnalisé pour ce projet`);
    }
  }

  // 4. Les deux moteurs déclarent la même VERSION de standard.
  const manifestPath = path.join(engine, 'engine.manifest.json');
  const localManifest = JSON.parse(fs.readFileSync(path.join(localRoot, manifestPath), 'utf8'));
  const refManifest = JSON.parse(fs.readFileSync(path.join(referenceRoot, manifestPath), 'utf8'));
  if (localManifest.version === refManifest.version) {
    pass(`version de moteur alignée (${localManifest.version})`);
  } else {
    fail(`versions divergentes : ici ${localManifest.version}, référence ${refManifest.version}`);
  }
  if (localManifest.engine !== engine) fail(`engine.manifest.json : nom incohérent (${localManifest.engine})`);
}

console.log('');
if (failures > 0) {
  console.error(`[engine-drift] ${failures} dérive(s) détectée(s).`);
  process.exit(1);
}
console.log('[engine-drift] Aucun écart : les moteurs respectent le standard.');
process.exit(0);
