/**
 * RÉSOLUTION des modules frontend pour les runners node.
 *
 * Deux redirections, et rien de plus :
 *   `react`      → le micro-exécuteur de hooks (aucun moteur de rendu ici) ;
 *   `@/...`      → `frontend/src/...`, l'alias que Vite résout à la build.
 *
 * Le code testé n'est PAS modifié pour être testable : il est chargé tel quel,
 * dans ses propres imports.
 */
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..');
const HARNESS = pathToFileURL(path.join(here, 'reactHarness.mjs')).href;

export async function resolve(specifier, context, nextResolve) {
  if (specifier === 'react') return { url: HARNESS, shortCircuit: true };
  if (specifier.startsWith('@/')) {
    const target = path.join(root, 'frontend', 'src', specifier.slice(2));
    // Les sources sont en .ts : node les exécute via --experimental-strip-types.
    const withExt = /\.[a-z]+$/.test(target) ? target : `${target}.ts`;
    return { url: pathToFileURL(withExt).href, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
