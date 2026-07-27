// Contrôle de dérive des contrats OpenAPI — les copies du Panel doivent
// rester identiques aux specs MAÎTRESSES du projet modèle
// (SB Auto 06/docs/panelXvitrine/spec/).
//
// Ce contrôle est un outil d'atelier : il compare les copies présentes dans
// le workspace quand le dépôt voisin est disponible, et se retire proprement
// (exit 0, message SKIP) sinon. Il ne crée AUCUNE dépendance runtime : rien
// dans backend/src ne lit le dépôt voisin.
//
// Deux niveaux :
//  1. comparaison octet-par-octet (après normalisation des fins de ligne) ;
//  2. comparaison SÉMANTIQUE (version, chemins, codes d'erreur, entityTypes,
//     en-tête de contrat, schémas nommés) — pour qualifier la dérive quand
//     les octets diffèrent.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const panelRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const referenceDir = process.env.SPEC_REFERENCE_DIR
  ? path.resolve(process.env.SPEC_REFERENCE_DIR)
  : path.resolve(panelRoot, '..', 'SB Auto 06', 'docs', 'panelXvitrine', 'spec');

const FILES = ['PanelBridge.openapi.yaml', 'ProjectBridge.openapi.yaml'];

if (!fs.existsSync(referenceDir)) {
  console.log(`[spec-drift] SKIP : specs maîtresses introuvables (${referenceDir}).`);
  console.log('[spec-drift] Le contrôle ne tourne que dans le workspace d’audit (dépôt voisin présent).');
  process.exit(0);
}

const normalize = (text) => text.replace(/\r\n/g, '\n');

function semantics(text) {
  return {
    version: (text.match(/^\s{2}version:\s*(\S+)/m) ?? [])[1] ?? null,
    paths: [...text.matchAll(/^ {2}(\/[^\s:]+):\s*$/gm)].map((m) => m[1]).sort(),
    errorCodes: [...new Set([...text.matchAll(/BRIDGE_[A-Z_]+/g)].map((m) => m[0]))].sort(),
    entityTypes: [...new Set([...text.matchAll(/^\s+- ([A-Z][A-Z_]+)$/gm)].map((m) => m[1]))].sort(),
    contractHeader: text.includes('X-Bridge-Contract-Version'),
    schemas: [...text.matchAll(/^ {4}([A-Za-z]+):\s*$/gm)].map((m) => m[1]).sort(),
  };
}

let failures = 0;
for (const file of FILES) {
  const localPath = path.join(panelRoot, 'docs', 'spec', file);
  const masterPath = path.join(referenceDir, file);
  if (!fs.existsSync(masterPath)) {
    console.error(`[spec-drift] ✗ spec maîtresse absente : ${masterPath}`);
    failures += 1;
    continue;
  }
  const local = normalize(fs.readFileSync(localPath, 'utf8'));
  const master = normalize(fs.readFileSync(masterPath, 'utf8'));

  if (local === master) {
    console.log(`[spec-drift] ✓ ${file} : identique à la spec maîtresse.`);
    continue;
  }

  failures += 1;
  console.error(`[spec-drift] ✗ ${file} : la copie du Panel diffère de la spec maîtresse.`);
  const a = semantics(local);
  const b = semantics(master);
  for (const key of Object.keys(a)) {
    const same = JSON.stringify(a[key]) === JSON.stringify(b[key]);
    if (!same) {
      console.error(`  · divergence sémantique « ${key} » :`);
      console.error(`      Panel : ${JSON.stringify(a[key])}`);
      console.error(`      Maître: ${JSON.stringify(b[key])}`);
    }
  }
  console.error('  → Rappel de gouvernance : la référence est le projet modèle ;');
  console.error('    recopier la spec maîtresse verbatim, jamais l’inverse (docs/spec/README.md).');
}

process.exit(failures === 0 ? 0 : 1);
