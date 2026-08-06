// LES MÉDIAS DOIVENT S'AFFICHER EN DÉVELOPPEMENT COMME EN PRODUCTION.
//
// ── LE DÉFAUT VERROUILLÉ ICI ────────────────────────────────────────────────
// Le serveur de développement relayait `/api` au backend, mais pas `/uploads`.
//
// L'import d'un logo réussissait pourtant de bout en bout : l'appel partait sur
// `/api/uploads/image`, relayé ; le backend écrivait le fichier et rendait un
// chemin RELATIF. Mais l'aperçu demandait ensuite cette adresse au serveur Vite,
// qui ne connaît pas ce dossier — il appliquait son repli d'application monopage
// et répondait `index.html`.
//
// Ce qui rendait le défaut coûteux à trouver : le statut était **200**. Pas de
// 404, pas d'erreur CORS, pas de message en console. Une image cassée, et rien
// qui désigne la cause. Le fichier existait, l'API était correcte ; seul le
// chemin de LECTURE n'était pas relayé.
//
// Mesuré avant le correctif :  GET :5273/uploads/logo…  → 200 text/html   560 o
// Mesuré après               :  GET :5273/uploads/logo…  → 200 image/webp 22228 o
// Et un fichier absent redevient un vrai 404, au lieu d'un 200 trompeur.
import { check, section, finish } from './helpers/harness.js';

const fs = await import('node:fs/promises');
const path = await import('node:path');
const { fileURLToPath } = await import('node:url');

const racine = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const lire = (rel) => fs.readFile(path.join(racine, rel), 'utf8');

/* -------------------------------------------------------------------------- */
section('1. Le serveur de développement relaie les médias');
{
  const config = await lire('frontend/vite.config.ts');

  // Le code seul : un commentaire qui décrit le défaut n'est pas le correctif.
  const nu = config.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

  check('le proxy déclare /uploads', /'\/uploads':/.test(nu));
  check('…vers le backend local', /'\/uploads':\s*'http:\/\/localhost:4100'/.test(nu));

  // Les trois chemins servis par le backend doivent tous être relayés. En
  // oublier un reproduit exactement le même défaut sur une autre surface.
  for (const chemin of ['/api', '/health', '/uploads']) {
    check(`${chemin} est relayé`, new RegExp(`'${chemin}':`).test(nu));
  }

  // Tous vers la MÊME origine : deux backends en développement, ce serait deux
  // vérités, et l'aperçu pourrait diverger de ce que l'API vient d'écrire.
  const cibles = [...nu.matchAll(/'(?:\/api|\/health|\/uploads)':\s*'([^']+)'/g)].map((m) => m[1]);
  check('tous vers le même backend', cibles.length === 3 && new Set(cibles).size === 1);
}

/* -------------------------------------------------------------------------- */
section('2. Le backend sert bien ce que le proxy relaie');
{
  const app = await lire('backend/src/app.js');

  check('le dossier des médias est servi en statique',
    /app\.use\('\/uploads', express\.static\(uploadsDir\(\)/.test(app));
  check('…publiquement, sans jeton',
    !/app\.use\('\/uploads',[\s\S]{0,80}requirePanel/.test(app));

  // `fallthrough: true` laisse un fichier absent poursuivre jusqu'au
  // gestionnaire d'erreurs, qui rend un 404 JSON explicite. Sans lui, express
  // rendrait sa propre page HTML — le même mensonge que celui de Vite.
  check('un média absent tombe sur le 404 canonique', /fallthrough: true/.test(app));
  check('aucun listing de dossier', /index: false/.test(app));
  check('les fichiers cachés sont refusés', /dotfiles: 'deny'/.test(app));

  // Le chemin est celui du service, jamais une constante recopiée : en
  // production c'est un lien vers `shared/uploads`, hors des releases.
  check('le chemin vient du service d’upload',
    /import \{ uploadsDir \} from '\.\/services\/upload\/upload\.service\.js'/.test(app));
}

/* -------------------------------------------------------------------------- */
section('3. L’URL rendue par l’API reste relative');
{
  const service = await lire('backend/src/services/upload/upload.service.js');

  // Une URL absolue figée dans la base survivrait à un changement de domaine et
  // pointerait sur l'ancien. Le chemin relatif, lui, suit toujours son origine.
  // On vérifie la RÈGLE, pas une expression littérale : le chemin rendu est
  // construit à partir du préfixe public, et l'import ne rend jamais d'adresse
  // absolue. Verrouiller la forme exacte du `return` interdisait au service
  // d'évoluer — l'import rend désormais aussi un descripteur de média.
  check('l’upload rend un chemin relatif',
    /const chemin = `\$\{UPLOADS_PUBLIC_PREFIX\}\/\$\{unique\}`/.test(service)
    && /url: chemin,/.test(service));
  check('…et jamais une adresse absolue',
    !/return \{[^}]*url: `https?:/.test(service));
  check('le préfixe est celui servi en statique',
    /UPLOADS_PUBLIC_PREFIX = '\/uploads'/.test(service));

  // La résolution en absolu n'a lieu qu'à la PUBLICATION, quand le média part
  // vers d'autres origines.
  check('l’absolu n’est calculé qu’à la publication',
    /export async function resolvePublicMediaUrl/.test(service));
  check('…depuis le résolveur réseau canonique',
    /resolveBackendUrl\(\)/.test(service));
}

finish();
