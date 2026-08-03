// SÉPARATION GESTION / DÉVELOPPEUR — ce que voit un ADMIN, ce qu'il ne peut
// pas atteindre, et le vocabulaire des écrans métier.
//
// ── CE QUI EST VÉRIFIÉ, ET COMMENT ──────────────────────────────────────────
// Le dépôt n'embarque aucun moteur de rendu React (les suites sont des runners
// node autonomes) : ces contrôles portent donc sur les SOURCES, comme le fait
// déjà `architecture.test.js`. Ils restent mordants — ajouter une route
// technique sans garde, ou faire réapparaître « heartbeat » sur un écran
// métier, les fait échouer.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { check, finish, section } from './helpers/harness.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

const nav = read('frontend/src/config/nav.ts');
const app = read('frontend/src/App.tsx');
const layout = read('frontend/src/components/Layout.tsx');

/** Entrées de menu extraites du source, avec leur section et leur `devOnly`. */
function navItems() {
  return [...nav.matchAll(/\{\s*to:\s*'([^']+)',\s*label:\s*'([^']+)',\s*section:\s*'([^']+)'(,\s*devOnly:\s*true)?\s*\}/g)]
    .map((m) => ({ to: m[1], label: m[2], section: m[3], devOnly: Boolean(m[4]) }));
}

/* ────────────────────────────────────────────────────────────────────────── */
section('1. Deux espaces, et le menu reflète la règle');
{
  const items = navItems();
  const gestion = items.filter((i) => i.section === 'GESTION');
  const dev = items.filter((i) => i.section === 'DEVELOPPEUR');

  check('les deux sections existent', gestion.length > 0 && dev.length > 0);
  check('aucune entrée de Gestion n’est réservée aux DEV',
    gestion.every((i) => !i.devOnly));
  check('TOUTE entrée Développeur est marquée devOnly',
    dev.every((i) => i.devOnly));

  // Un ADMIN ne doit voir que la Gestion. C'est le filtre `navItemsFor`.
  check('le filtre du menu ne garde les entrées DEV que pour un DEV',
    /!item\.devOnly \|\| role === 'DEV'/.test(nav));
  check('la barre latérale utilise ce filtre, jamais NAV_ITEMS brut',
    layout.includes('navItemsFor(') && !/NAV_ITEMS\.map/.test(layout));

  const gestionLabels = gestion.map((i) => i.label);
  check(`Gestion = Tableau de bord, Projets clients, Mon entreprise — ${gestionLabels.join(', ')}`,
    gestionLabels.join('|') === 'Tableau de bord|Projets clients|Mon entreprise');

  const devPaths = dev.map((i) => i.to);
  check('les 7 entrées techniques sont dans Développeur',
    ['/supervision', '/bridges', '/pairings', '/versions', '/integrated-apis', '/deployment', '/actions']
      .every((p) => devPaths.includes(p)));
  check('/integrated-apis est enfin branché au menu', devPaths.includes('/integrated-apis'));
  check('aucun mot d’infrastructure dans les libellés de Gestion',
    !/bridge|manifest|appairage|version|supervision|déploiement|exécution/i.test(gestionLabels.join(' ')));
}

/* ────────────────────────────────────────────────────────────────────────── */
section('2. Les routes techniques sont INTERDITES, pas seulement masquées');
{
  // Chaque route du routeur, avec son élément.
  const routes = [...app.matchAll(/<Route\s+path="([^"]+)"\s+element=\{([\s\S]*?)\}\s*\/>/g)]
    .map((m) => ({ path: m[1], element: m[2].trim() }));

  // `*` est le repli global (redirection), `/login` est hors coquille : ni
  // l'un ni l'autre n'est une surface technique à garder.
  const BUSINESS = ['/', '/projects', '/projects/:projectId', '/company', '/panel'];
  const technical = routes.filter(
    (r) => !BUSINESS.includes(r.path) && r.path !== '/login' && r.path !== '*',
  );

  check(`le routeur déclare ${routes.length} routes sous la coquille`, routes.length >= 15);
  check('CHAQUE route technique passe par la garde DEV',
    technical.length > 0 && technical.every((r) => r.element.startsWith('dev(')));

  const unguarded = technical.filter((r) => !r.element.startsWith('dev('));
  check(`aucune route technique laissée ouverte${unguarded.length ? ` — ${unguarded.map((r) => r.path).join(', ')}` : ''}`,
    unguarded.length === 0);

  check('aucune route métier n’est gardée par erreur',
    routes.filter((r) => BUSINESS.includes(r.path)).every((r) => !r.element.startsWith('dev(')));

  // La garde renvoie un ADMIN vers son tableau de bord, elle ne le laisse pas
  // sur un écran vide ni sur une erreur.
  const guard = read('frontend/src/auth/RequireDev.tsx');
  check('la garde refuse tout rôle autre que DEV', /user\?\.role !== 'DEV'/.test(guard));
  check('…et redirige vers l’accueil', /<Navigate to="\/" replace \/>/.test(guard));
}

/* ────────────────────────────────────────────────────────────────────────── */
section('3. Anciennes URLs : les favoris continuent de fonctionner');
{
  check('/panel redirige vers le tableau de bord',
    /<Route path="\/panel" element=\{<Navigate to="\/" replace \/>\} \/>/.test(app));
  check('le doublon /panel ne rend plus DashboardPage en double',
    (app.match(/element=\{<DashboardPage \/>\}/g) || []).length === 1);
  check('toute URL inconnue retombe sur l’accueil',
    /<Route path="\*" element=\{<Navigate to="\/" replace \/>\} \/>/.test(app));
}

/* ────────────────────────────────────────────────────────────────────────── */
section('4. Aucun vocabulaire d’infrastructure sur les écrans métier');
{
  // Ce qu'un commercial ne doit jamais lire. On inspecte le TEXTE RENDU
  // (littéraux JSX et chaînes), pas les identifiants de code : `projectKey`
  // reste une propriété légitime, ce qui compte est ce qui s'affiche.
  const INTERDITS = [
    'heartbeat', 'liveness', 'readiness', 'manifest', 'contractVersion',
    'projectKey', 'endpoint', 'bridge', 'appairage', 'diagnostic',
  ];

  /**
   * Texte RÉELLEMENT rendu.
   *
   * On raisonne LIGNE À LIGNE plutôt que d'essayer d'équilibrer les accolades :
   * une passe qui supprime tous les blocs `{…}` effacerait aussi le JSX
   * conditionnel (`{isDev ? (<Card>…)}`), c'est-à-dire précisément l'écran
   * qu'on veut inspecter. On écarte donc les lignes de CODE (comparaisons,
   * fonctions fléchées, itérations, déclarations) et on lit le reste.
   */
  const CODE_LINE =
    /===|=>|\?\?|\.filter\(|\.map\(|\.sort\(|\.runtime\.|\.pairing\.|\.descriptor\.|^\s*(import|const|let|type|interface|export|function)\b/;

  const visibleText = (source) => {
    const kept = source
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .filter((l) => !/^\s*\/\//.test(l))
      .filter((l) => !CODE_LINE.test(l))
      .join('\n');

    // Uniquement ce qui s'affiche : nœuds de texte JSX et attributs de libellé.
    const jsxText = [...kept.matchAll(/>([^<>{}]+)</g)].map((m) => m[1]);
    const labels = [...kept.matchAll(/(?:title|placeholder|hint|label)="([^"]+)"/g)].map((m) => m[1]);
    return [...jsxText, ...labels].join(' ');
  };

  for (const page of ['DashboardPage', 'ProjectsPage']) {
    const text = visibleText(read(`frontend/src/pages/${page}.tsx`));
    const found = INTERDITS.filter((t) => new RegExp(t, 'i').test(text));
    check(`${page} : aucun terme technique visible${found.length ? ` — ${found.join(', ')}` : ''}`,
      found.length === 0);
  }

  // La fiche projet porte les DEUX onglets dans un seul fichier : on n'inspecte
  // que la partie métier, jusqu'à la frontière de l'onglet Développeur.
  const detail = read('frontend/src/pages/ProjectDetailPage.tsx');
  const businessPart = detail.slice(0, detail.indexOf('function DeveloperTab'));
  const foundDetail = INTERDITS.filter((t) => new RegExp(t, 'i').test(visibleText(businessPart)));
  check(`Fiche projet, partie métier : aucun terme technique visible${foundDetail.length ? ` — ${foundDetail.join(', ')}` : ''}`,
    foundDetail.length === 0);

  // Seuls les libellés de GESTION sont contraints : « Appairages » et
  // « Connexions techniques » sont légitimes dans l'espace Développeur.
  const gestionLabels = navItems().filter((i) => i.section === 'GESTION').map((i) => i.label).join(' ');
  check('les libellés de Gestion non plus',
    !INTERDITS.some((t) => new RegExp(t, 'i').test(gestionLabels)));
}

/* ────────────────────────────────────────────────────────────────────────── */
section('5. Fiche projet : l’onglet Développeur n’existe que pour un DEV');
{
  const detail = read('frontend/src/pages/ProjectDetailPage.tsx');
  check('l’onglet est rendu sous condition de rôle',
    /\{isDev \? \(\s*<button/.test(detail));
  check('…et son contenu aussi, jamais seulement l’onglet',
    /tab === 'dev' && isDev/.test(detail));
  check('le rôle vient de la garde unique, pas d’un test local',
    detail.includes("from '@/auth/RequireDev'"));

  // Le technique est REGROUPÉ, pas dispersé : la vue d'ensemble ne doit pas
  // afficher clé, versions ni manifeste.
  const businessPart = detail.slice(detail.indexOf('function OverviewTab'), detail.indexOf('function DeveloperTab'));
  check('la vue d’ensemble n’affiche ni clé ni versions',
    !/projectKey|versions\.|contractVersion/.test(businessPart));

  check('le JSON brut du manifeste est replié par défaut',
    /useState\(false\)[\s\S]*rawOpen \? \(/.test(detail) || /rawOpen \? 'Masquer le JSON'/.test(detail));
  check('…et une lecture structurée le précède',
    detail.indexOf('Fiche technique du projet') < detail.indexOf('Manifest brut'));
}

/* ────────────────────────────────────────────────────────────────────────── */
section('6. Types frontend alignés sur ce que le backend renvoie déjà');
{
  const types = read('frontend/src/types.ts');
  const backend = read('backend/src/services/registry/projectRegistry.service.js');
  const projection = backend.slice(backend.indexOf('export function toPublicProject'));
  const served = [...projection.slice(0, projection.indexOf('\n}')).matchAll(/^\s{4}([a-zA-Z]+):/gm)]
    .map((m) => m[1]);

  const missing = served.filter((f) => !new RegExp(`^\\s{2}${f}[?]?:`, 'm').test(types));
  check(`le type PublicProject déclare les ${served.length} champs servis${missing.length ? ` — manquants : ${missing.join(', ')}` : ''}`,
    missing.length === 0);

  for (const field of ['descriptor', 'secondsSinceLastHeartbeat', 'manifestUpdatedAt', 'appliedConfiguration', 'note']) {
    check(`…dont ${field}`, new RegExp(`^\\s{2}${field}[?]?:`, 'm').test(types));
  }
}

/* ────────────────────────────────────────────────────────────────────────── */
section('7. Le nom affiché ne retombe jamais sur une valeur technique par défaut');
{
  const presentation = read('frontend/src/lib/projectPresentation.ts');
  check('l’ordre de repli est explicite et documenté',
    presentation.includes('descriptor?.name') && presentation.includes('projectName')
    && presentation.includes('projectKey'));
  check('la clé technique n’est qu’un DERNIER recours',
    presentation.indexOf('descriptor?.name') < presentation.indexOf('return project.projectKey'));
  check('les états sont traduits, pas affichés bruts',
    /'Connecté'/.test(presentation) && /'Ne communique plus'/.test(presentation));
  check('les alertes sont des phrases, pas des codes',
    presentation.includes('Le site ne communique plus avec le Panel'));
}

finish();
