// Invariants d'architecture du Panel — vérifiés sur le code source lui-même.
// Ces règles ne sont pas des conventions de style : les enfreindre casse
// l'indépendance des deux dépôts ou la frontière du pont.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { check, finish, section } from './helpers/harness.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const backendSrc = path.join(root, 'backend', 'src');
const frontendSrc = path.join(root, 'frontend', 'src');

function sourceFiles(dir, extensions) {
  const files = [];
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === 'dist') continue;
        walk(full);
      } else if (extensions.some((ext) => entry.name.endsWith(ext))) {
        files.push(full);
      }
    }
  };
  walk(dir);
  return files;
}

// Les MOTEURS STANDARDS (deployment-engine, duplication-engine) sont un
// composant vendu avec le projet, dont le cœur est identique dans tous les
// projets de l'écosystème (Phase 2D). Les leur appliquer les invariants du
// code APPLICATIF du Panel forcerait un fork de ce cœur — exactement ce que
// le standard interdit. Ils ont leurs propres invariants (§ Moteurs standards)
// et leur propre contrôle de dérive (tests/engine-drift.check.mjs).
const ENGINE_DIRS = ['deployment-engine', 'duplication-engine'];
const isEngineFile = (file) =>
  ENGINE_DIRS.some((dir) => path.relative(backendSrc, file).split(path.sep)[0] === dir);

const allBackendFiles = sourceFiles(backendSrc, ['.js']);
const backendFiles = allBackendFiles.filter((file) => !isEngineFile(file));
const engineFiles = allBackendFiles.filter(isEngineFile);
const frontendFiles = sourceFiles(frontendSrc, ['.ts', '.tsx']);
const deployFiles = sourceFiles(path.join(root, 'deploy'), ['.mjs']);
const testFiles = sourceFiles(path.join(root, 'tests'), ['.js', '.mjs']);

const rel = (file) => path.relative(root, file).replace(/\\/g, '/');
const read = (file) => fs.readFileSync(file, 'utf8');

// Les commentaires citent légitimement le projet modèle (« même convention
// que SB Auto 06 ») : c'est de la documentation, pas une dépendance. Les
// invariants de CODE se vérifient donc sur la source décommentée.
const code = (file) => read(file)
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:])\/\/.*$/gm, '$1');

const importsOf = (file) => [...read(file).matchAll(/(?:from|import)\s+['"]([^'"]+)['"]/g)].map((m) => m[1]);

section('Le transport réseau vers les projets est exclusif');
{
  const offenders = backendFiles.filter(
    (file) => /\bfetch\s*\(/.test(read(file)) && !file.endsWith('ProjectBridgeClient.js'),
  );
  check(`aucun appel réseau hors ProjectBridgeClient${offenders.length ? ` — ${offenders.map(rel)}` : ''}`,
    offenders.length === 0);

  const clientImporters = backendFiles.filter((file) => {
    if (file.endsWith('ProjectBridgeClient.js')) return false;
    return importsOf(file).some((source) => source.includes('ProjectBridgeClient'));
  });
  // Seuls les contrôleurs orchestrent un appel sortant : aucun service
  // métier ne doit tenir un client de pont.
  const allowed = ['backend/src/controllers/projects.controller.js'];
  const unexpected = clientImporters.map(rel).filter((file) => !allowed.includes(file));
  check(`seuls les contrôleurs prévus utilisent le client${unexpected.length ? ` — ${unexpected}` : ''}`,
    unexpected.length === 0);
}

section('Une seule porte pour l’environnement');
{
  const offenders = backendFiles.filter(
    (file) => /process\.env[.[]/.test(read(file)) && !file.endsWith(path.join('config', 'env.js')),
  );
  check(`seul config/env.js lit process.env${offenders.length ? ` — ${offenders.map(rel)}` : ''}`,
    offenders.length === 0);
}

section('Aucune dépendance vers le dépôt voisin');
{
  const runtimeFiles = [...backendFiles, ...frontendFiles];
  const offenders = runtimeFiles.filter((file) => /SB Auto|sbauto|panelXvitrine/i.test(code(file)));
  check(`aucune référence au dépôt voisin dans le code applicatif${offenders.length ? ` — ${offenders.map(rel)}` : ''}`,
    offenders.length === 0);

  const escaping = [...runtimeFiles, ...deployFiles].filter((file) =>
    importsOf(file).some((source) => source.startsWith('../../../../')),
  );
  check('aucun import ne sort du dépôt', escaping.length === 0);

  // Le contrôle de dérive des specs est le SEUL fichier autorisé à ACCÉDER
  // au dépôt voisin (chemin de système de fichiers) — outil d'atelier,
  // jamais du runtime. Citer « SB Auto 06 » dans une fixture ou une règle
  // d'interdiction ne crée aucune dépendance.
  const PATH_TO_NEIGHBOUR = /['"`][^'"`]*\.\.[\\/]+SB Auto|panelXvitrine[\\/]/i;
  const workspaceAware = [...testFiles, ...backendFiles, ...frontendFiles, ...deployFiles]
    .filter((file) => !file.endsWith('architecture.test.js')) // le contrôleur ne s'audite pas lui-même
    .filter((file) => PATH_TO_NEIGHBOUR.test(read(file)));
  check(`seul le contrôle de dérive accède au dépôt voisin${workspaceAware.length > 1 ? ` — ${workspaceAware.map(rel)}` : ''}`,
    workspaceAware.length === 1 && workspaceAware[0].endsWith('spec-drift.check.mjs'));
  check('aucun fichier applicatif n’accède au dépôt voisin',
    ![...backendFiles, ...frontendFiles].some((file) => PATH_TO_NEIGHBOUR.test(read(file))));
  check('…et il se retire proprement si le voisin est absent',
    read(path.join(root, 'tests', 'spec-drift.check.mjs')).includes('SKIP'));
}

section('Aucun chemin absolu du poste de travail');
{
  const all = [...backendFiles, ...frontendFiles, ...deployFiles, ...testFiles];
  // Lettre de lecteur Windows (C:\ ou C:/) et racines POSIX d'utilisateur.
  const ABSOLUTE_RE = /(^|[^A-Za-z0-9])[A-Za-z]:[\\/]|\/Users\/[a-zA-Z]|\/home\/[a-z]/;
  const offenders = all.filter((file) => ABSOLUTE_RE.test(code(file)));
  check(`aucun chemin absolu de poste${offenders.length ? ` — ${offenders.map(rel)}` : ''}`,
    offenders.length === 0);
}

section('Le Panel reste générique : aucun projet nommé dans sa logique');
{
  const offenders = [...backendFiles, ...frontendFiles].filter((file) =>
    /sb[- ]?auto|garage/i.test(code(file)),
  );
  check(`aucune logique spécifique à un projet${offenders.length ? ` — ${offenders.map(rel)}` : ''}`,
    offenders.length === 0);
}

section('Le frontend passe par le client d’API centralisé');
{
  const offenders = frontendFiles.filter((file) => {
    if (file.endsWith(path.join('lib', 'api.ts'))) return false;
    return /\bfetch\s*\(/.test(read(file));
  });
  check(`aucun fetch hors lib/api.ts${offenders.length ? ` — ${offenders.map(rel)}` : ''}`,
    offenders.length === 0);

  const hardcoded = frontendFiles.filter((file) => /https?:\/\/(?!localhost)/.test(read(file)));
  check(`aucune URL absolue codée en dur dans le frontend${hardcoded.length ? ` — ${hardcoded.map(rel)}` : ''}`,
    hardcoded.length === 0);
}

section('Les secrets ne sortent jamais par une API');
{
  const registry = read(path.join(backendSrc, 'services', 'registry', 'projectRegistry.service.js'));
  const publicProjection = registry.slice(registry.indexOf('export function toPublicProject'));
  check('la projection publique n’expose aucun hash',
    !publicProjection.includes('bridgeTokenHash') && !publicProjection.includes('pairingCodeHash'));
  check('la projection publique n’expose aucune valeur chiffrée',
    !publicProjection.includes('bridgeTokenEncrypted'));

  const pairing = read(path.join(backendSrc, 'services', 'pairing', 'pairing.service.js'));
  check('le déchiffrement du token a un seul point d’entrée nommé',
    (pairing.match(/decryptSecret\(/g) ?? []).length === 1
    && pairing.includes('export function getOutboundBridgeToken'));

  const users = read(path.join(backendSrc, 'services', 'auth', 'panelUsers.service.js'));
  check('la projection utilisateur n’expose pas le hash du mot de passe',
    read(path.join(backendSrc, 'services', 'auth', 'panelUsers.service.js'))
      .slice(users.indexOf('export function toPublicUser'))
      .includes('passwordHash') === false);
}

section('Moteurs standards : embarqués, autonomes, personnalisés par configuration');
{
  check('les deux moteurs sont présents dans le projet',
    ENGINE_DIRS.every((dir) => fs.existsSync(path.join(backendSrc, dir))));

  for (const dir of ENGINE_DIRS) {
    const manifestPath = path.join(backendSrc, dir, 'engine.manifest.json');
    check(`${dir} déclare sa version (engine.manifest.json)`, fs.existsSync(manifestPath));
    if (!fs.existsSync(manifestPath)) continue;
    const manifest = JSON.parse(read(manifestPath));
    check(`${dir} : manifeste complet`,
      manifest.engine === dir
      && /^\d+\.\d+\.\d+$/.test(manifest.version)
      && Array.isArray(manifest.compatibleProjects)
      && typeof manifest.description === 'string'
      && typeof manifest.lastStandardization === 'string');
  }

  // Un moteur embarqué ne doit dépendre QUE de lui-même, de l'autre moteur et
  // de node/npm : jamais d'un service du projet hôte, sans quoi il ne serait
  // plus duplicable tel quel.
  const forbidden = engineFiles.filter((file) => {
    return importsOf(file).some((src) => {
      if (!src.startsWith('.')) return false; // paquets npm : autorisés
      const resolved = path.resolve(path.dirname(file), src);
      const rel = path.relative(backendSrc, resolved).split(path.sep)[0];
      // `utils/` est toléré : ce sont des primitives pures, dupliquées avec le moteur.
      return !ENGINE_DIRS.includes(rel) && rel !== 'utils';
    });
  });
  check(`aucun moteur ne dépend d'un service du projet hôte${forbidden.length ? ` — ${forbidden.map(rel)}` : ''}`,
    forbidden.length === 0);

  // Tout ce qui est propre au projet vit dans config/ — jamais dans le cœur.
  const profile = path.join(backendSrc, 'deployment-engine', 'config', 'project.profile.js');
  check('le profil de projet existe', fs.existsSync(profile));
  check('le profil porte le slug de CE projet', read(profile).includes("PROJECT_SLUG = 'panel'"));
  const coreFiles = engineFiles.filter((f) => !f.includes(`${path.sep}config${path.sep}`));
  const slugInCore = coreFiles.filter((f) => /PROJECT_SLUG\s*=\s*'/.test(code(f)));
  check(`le slug n'est jamais redéfini dans le cœur${slugInCore.length ? ` — ${slugInCore.map(rel)}` : ''}`,
    slugInCore.length === 0);
}

section('Le miroir de contrat reste autonome');
{
  const contract = read(path.join(backendSrc, 'bridge', 'bridgeContract.js'));
  const imports = [...contract.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((m) => m[1]);
  check(`le miroir ne dépend que de zod et node: — ${imports.join(', ')}`,
    imports.every((source) => source === 'zod' || source.startsWith('node:')));
}

finish();
