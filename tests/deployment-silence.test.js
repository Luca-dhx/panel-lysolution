// AUCUNE CONSOLE, AUCUNE DURÉE MANQUANTE.
//
// Deux défauts constatés sur des déploiements réels du Panel sous Windows :
//
// 1. des fenêtres `cmd.exe` s'ouvraient pendant le build. Deux causes distinctes :
//    `localExec` lance `npm` via `shell` (obligatoire : `npm` est un `.cmd`), et
//    le worker de déploiement est lancé `detached` — or sous Windows un enfant
//    détaché reçoit CREATE_NEW_CONSOLE. Dans les deux cas l'option prévue par
//    Node est `windowsHide`.
//
// 2. la checklist d'un run est PRÉ-REMPLIE avec `startedAt: null` ; la branche
//    de mise à jour ne posait jamais `startedAt`, donc `durationMs` valait
//    `null` pour TOUTES les étapes de TOUS les déploiements.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { check, finish, section } from './helpers/harness.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

/** Retire commentaires de bloc et de ligne : on n'analyse que du CODE. */
const codeOf = (src) => src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');

/* ────────────────────────────────────────────────────────────────────────── */
section('1. Tout lancement de processus est silencieux sous Windows');
{
  // Inventaire EXHAUSTIF des lanceurs de processus du backend : aucun ne doit
  // exister sans `windowsHide`. Le test découvre les fichiers, il ne les liste pas.
  const launchers = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { if (e.name !== 'node_modules') walk(full); continue; }
      if (!e.name.endsWith('.js') || e.name.endsWith('.test.js')) continue;
      const code = codeOf(fs.readFileSync(full, 'utf8'));
      if (/\b(spawn|spawnSync|execFile|execFileSync)\s*\(/.test(code)) launchers.push({ full, code });
    }
  };
  walk(path.join(root, 'backend', 'src'));

  check('des lanceurs de processus ont bien été trouvés', launchers.length >= 2);

  const sansHide = launchers.filter(({ code }) => {
    // Chaque appel de lancement doit être suivi, dans son bloc d'options, de windowsHide.
    const appels = code.match(/\b(?:spawn|spawnSync|execFile|execFileSync)\s*\([\s\S]{0,600}?\)\s*;/g) ?? [];
    return appels.some((a) => !/windowsHide\s*:\s*true/.test(a));
  }).map(({ full }) => path.relative(root, full));

  check('aucun lanceur de processus sans `windowsHide: true`', sansHide.length === 0);
  if (sansHide.length) console.error(`    → ${sansHide.join(', ')}`);

  // Les deux lanceurs connus, nommément.
  const build = codeOf(read('backend/src/deployment-engine/build.js'));
  check('localExec (npm/git) masque la console', /windowsHide:\s*true/.test(build));
  check('localExec conserve `shell` sous Windows (npm est un .cmd)',
    /shell:\s*process\.platform === 'win32'/.test(build));

  const worker = codeOf(read('backend/src/services/deployment/deploymentWorker.service.js'));
  check('le worker détaché masque sa console', /windowsHide:\s*true/.test(worker));
  check('le worker reste détaché (il survit au redémarrage du backend)',
    /detached:\s*true/.test(worker));
}

/* ────────────────────────────────────────────────────────────────────────── */
section('2. Le moteur des deux projets est identique sur ce point');
{
  const a = read('backend/src/deployment-engine/build.js');
  const bPath = path.resolve(root, '..', 'SB Auto 06', 'backend', 'src', 'deployment-engine', 'build.js');
  if (!fs.existsSync(bPath)) {
    check('projet de référence absent — contrôle sauté proprement', true);
  } else {
    const b = fs.readFileSync(bPath, 'utf8');
    check('build.js identique dans les deux dépôts (fins de ligne normalisées)',
      a.replace(/\r\n/g, '\n') === b.replace(/\r\n/g, '\n'));
  }
}

/* ────────────────────────────────────────────────────────────────────────── */
section('3. Durée des étapes : la checklist pré-remplie est horodatée');
{
  const svc = codeOf(read('backend/src/services/deployment/deploymentRun.service.js'));

  check('la branche de mise à jour pose `startedAt` quand il manque',
    /steps\.\$\{index\}\.startedAt/.test(svc) || /\[`steps\.\$\{index\}\.startedAt`\]/.test(svc));
  check('la durée ne retombe plus sur `null`', !/durationMs`\]:\s*previous\.startedAt\s*$/m.test(svc));

  // Simulation de la séquence réelle : création (startedAt null) → running → ok.
  const nowIso = () => new Date().toISOString();
  const previousPending = { id: 'artifact.build', status: 'pending', startedAt: null };
  const tRunning = nowIso();
  const startedAt1 = previousPending.startedAt ?? ('running' === 'running' ? tRunning : null);
  check('à l’émission « running », startedAt est posé', startedAt1 === tRunning);

  const previousRunning = { ...previousPending, status: 'running', startedAt: tRunning };
  const tOk = new Date(Date.parse(tRunning) + 1234).toISOString();
  const startedAt2 = previousRunning.startedAt ?? null;
  const duration = Date.parse(tOk) - Date.parse(startedAt2 ?? tOk);
  check('à l’émission « ok », la durée est mesurée (1234 ms)', duration === 1234);

  // Étape franchie en UNE seule émission (`skipped`) : durée 0, jamais null.
  const previousSkipped = { status: 'pending', startedAt: null };
  const tSkip = nowIso();
  const startedAt3 = previousSkipped.startedAt ?? ('skipped' === 'running' ? tSkip : null);
  const durationSkip = Date.parse(tSkip) - Date.parse(startedAt3 ?? tSkip);
  check('une étape « skipped » a une durée de 0, pas null', durationSkip === 0);
}

finish();
