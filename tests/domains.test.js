// Domaines et URLs : une seule source de vérité, une règle de priorité
// claire, aucun domaine codé en dur, un CORS dérivé des URLs configurées.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  check,
  connectTestDatabase,
  finish,
  rejectsWith,
  section,
  setTestEnv,
  simulateRestart,
  startMemoryMongo,
  stopMemoryMongo,
} from './helpers/harness.js';

setTestEnv();
process.env.CORS_ORIGINS = 'https://outil-interne.exemple.com';
await startMemoryMongo();
await connectTestDatabase();

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const network = await import('../backend/src/services/network/networkConfig.service.js');
const cors = await import('../backend/src/middlewares/cors.middleware.js');
const { normalizeAppUrl, isPubliclyReachableUrl } = await import(
  '../backend/src/utils/normalizeAppUrl.js'
);
const SystemConfiguration = (await import('../backend/src/models/SystemConfiguration.model.js')).default;

section('Normalisation : une URL d’application est une ORIGINE');
{
  check('trailing slash normalisé', normalizeAppUrl('https://panel.exemple.com/') === 'https://panel.exemple.com');
  check('casse de l’hôte normalisée', normalizeAppUrl('https://Panel.Exemple.COM') === 'https://panel.exemple.com');
  check('port conservé', normalizeAppUrl('http://localhost:4100') === 'http://localhost:4100');
  for (const [label, value] of [
    ['chemin', 'https://panel.exemple.com/admin'],
    ['query', 'https://panel.exemple.com/?a=1'],
    ['fragment', 'https://panel.exemple.com/#x'],
    ['credentials', 'https://user:pass@panel.exemple.com'],
    ['protocole ftp', 'ftp://panel.exemple.com'],
    ['valeur vide', '   '],
    ['texte libre', 'panel.exemple.com'],
  ]) {
    let refused = false;
    try { normalizeAppUrl(value); } catch { refused = true; }
    check(`${label} refusé`, refused);
  }
}

section('Joignabilité publique (exigence PROD)');
{
  check('https public → joignable', isPubliclyReachableUrl('https://panel.exemple.com'));
  check('http refusé', !isPubliclyReachableUrl('http://panel.exemple.com'));
  check('localhost refusé', !isPubliclyReachableUrl('https://localhost:4100'));
  check('127.0.0.1 refusé', !isPubliclyReachableUrl('https://127.0.0.1'));
  check('.local refusé', !isPubliclyReachableUrl('https://panel.local'));
}

section('Règle de priorité : base > .env > défaut local');
{
  await SystemConfiguration.deleteMany({});
  const noConfig = await network.resolveBackendUrl();
  check('sans configuration ni PUBLIC_URL : défaut local',
    noConfig.url === 'http://localhost:4100' && noConfig.source === 'LOCAL_DEFAULT');

  await network.updateNetworkConfiguration({
    backendUrl: 'https://panel.exemple.com',
    frontendUrl: 'https://app.panel.exemple.com',
  }, { requirePublic: false });

  const stored = await network.resolveBackendUrl();
  check('la configuration système l’emporte',
    stored.url === 'https://panel.exemple.com' && stored.source === 'SYSTEM_CONFIGURATION');
  const frontend = await network.resolveFrontendUrl();
  check('frontendUrl résolue depuis la base', frontend.url === 'https://app.panel.exemple.com');

  await simulateRestart();
  const afterRestart = await network.resolveBackendUrl();
  check('la configuration survit au redémarrage', afterRestart.url === 'https://panel.exemple.com');
}

section('CORS : dérivé des URLs configurées + origines statiques');
{
  const origins = await cors.refreshAllowedOrigins();
  check('frontend configuré autorisé', origins.includes('https://app.panel.exemple.com'));
  check('backend configuré autorisé', origins.includes('https://panel.exemple.com'));
  check('origine statique du .env conservée', origins.includes('https://outil-interne.exemple.com'));
  check('origine inconnue refusée', !cors.isOriginAllowed('https://pirate.exemple.com'));
  check('aucun doublon', new Set(origins).size === origins.length);

  await network.updateNetworkConfiguration(
    { frontendUrl: 'https://nouveau.exemple.com' }, { requirePublic: false },
  );
  await cors.refreshAllowedOrigins();
  check('le CORS suit un changement de domaine', cors.isOriginAllowed('https://nouveau.exemple.com'));
  check('l’ancienne origine n’est plus autorisée', !cors.isOriginAllowed('https://app.panel.exemple.com'));
}

section('Écriture : validations');
{
  check('URL invalide refusée', await rejectsWith(
    () => network.updateNetworkConfiguration({ backendUrl: 'pas-une-url' }, { requirePublic: false }),
    'PANEL_NETWORK_URL_INVALID',
  ));
  check('URL locale refusée quand le public est exigé (règle PROD)', await rejectsWith(
    () => network.updateNetworkConfiguration({ backendUrl: 'http://localhost:4100' }, { requirePublic: true }),
    'PANEL_NETWORK_URL_NOT_PUBLIC',
  ));
  check('payload vide refusé', await rejectsWith(
    () => network.updateNetworkConfiguration({}, { requirePublic: false }),
    'PANEL_NETWORK_URL_REQUIRED',
  ));
}

section('Aucun domaine codé en dur dans le code applicatif');
{
  // Deux interdits distincts :
  //  1. AUCUN domaine public ni nom de projet, nulle part — le Panel est
  //     générique ; SB Auto 06 est « un projet conforme parmi N ».
  //  2. Aucune URL localhost hors des deux fichiers qui, par nature, en
  //     parlent : le résolveur (repli de développement) et le normaliseur
  //     (règle de joignabilité publique).
  const LOCALHOST_ALLOWED = [
    path.join('services', 'network', 'networkConfig.service.js'),
    path.join('utils', 'normalizeAppUrl.js'),
  ];
  // Les moteurs standards sont exclus : leur cœur est identique dans tous les
  // projets, et leurs valeurs par défaut (bases wildcard) vivent dans leur
  // profil — vérifié par tests/architecture.test.js et engine-drift.check.mjs.
  const ENGINE_DIRS = ['deployment-engine', 'duplication-engine'];
  const offenders = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.js')) {
        const content = fs.readFileSync(full, 'utf8');
        const rel = path.relative(path.join(root, 'backend', 'src'), full);
        if (ENGINE_DIRS.includes(rel.split(path.sep)[0])) continue;
        if (/ly-solution\.com|sb-?auto|sbauto/i.test(content)) {
          offenders.push(`${rel} (domaine public ou projet nommé)`);
        }
        if (/https?:\/\/localhost/.test(content) && !LOCALHOST_ALLOWED.includes(rel)) {
          offenders.push(`${rel} (URL localhost hors résolveur)`);
        }
      }
    }
  };
  walk(path.join(root, 'backend', 'src'));
  check(`aucun domaine ni nom de projet codé en dur${offenders.length ? ` — ${offenders.join(', ')}` : ''}`,
    offenders.length === 0);

  const envExample = fs.readFileSync(path.join(root, 'backend', '.env.example'), 'utf8');
  check('.env.example ne fige aucun domaine de production',
    !/ly-solution\.com/.test(envExample));
}

await stopMemoryMongo();
finish();
