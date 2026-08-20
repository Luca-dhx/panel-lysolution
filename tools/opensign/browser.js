// LE NAVIGATEUR DE RECETTE — résolu depuis le backend, où il est installé.
//
// Campagne de migration Yousign → OpenSign.
//
// ══ POURQUOI CE MODULE D'UNE LIGNE UTILE EXISTE ═════════════════════════════
//
// L'outillage de campagne vit hors de `backend/` — c'est ce qui lui permet de
// contenir un hôte de production ou de lire l'environnement sans affaiblir les
// gardes d'architecture du Panel. Mais Playwright, lui, est une dépendance de
// DÉVELOPPEMENT du backend : `import 'playwright'` depuis `tools/` ne le trouve
// pas, et l'échec arrive au milieu d'une recette, après qu'un document a déjà
// été créé chez le fournisseur.
//
// La résolution explicite règle cela une fois. C'est exactement ce que fait
// déjà `tests/helpers/harness.js` pour `mongodb-memory-server` : même problème,
// même remède, et le remède est nommé plutôt que recopié.
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

export async function chargerChromium() {
  const require = createRequire(new URL('../../backend/package.json', import.meta.url));
  let chemin;
  try {
    chemin = require.resolve('playwright');
  } catch {
    throw new Error(
      'Playwright est absent. Installez-le côté backend :\n'
      + '  cd backend && npm install --save-dev playwright && npx playwright install chromium',
    );
  }
  /**
   * PLAYWRIGHT EST UN MODULE COMMONJS.
   *
   * Importé depuis un module ES, ses exports nommés ne sont pas toujours
   * dépliés : selon la version, `chromium` se trouve à la racine de l'espace de
   * noms ou sous `default`. Ne lire que la première forme rend `undefined`, et
   * l'erreur (« reading 'launch' of undefined ») arrive une minute plus tard,
   * après qu'un document a déjà été créé chez le fournisseur.
   */
  const module = await import(pathToFileURL(chemin).href);
  const chromium = module.chromium ?? module.default?.chromium;
  if (!chromium) throw new Error('Playwright chargé, mais son moteur Chromium est introuvable.');
  return chromium;
}

export default { chargerChromium };
