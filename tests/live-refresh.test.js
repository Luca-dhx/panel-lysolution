/**
 * RAFRAÎCHISSEMENT SILENCIEUX — ce que l'utilisateur doit NE PAS voir.
 *
 * Le sondage des projets était visible : la liste disparaissait et revenait
 * toutes les sept secondes, les compteurs du tableau de bord repassaient à
 * « … », la page semblait se recharger seule. Ces contrôles verrouillent le
 * comportement inverse, en exécutant le vrai hook — pas en lisant sa source.
 */
import { check, finish, section } from './helpers/harness.js';
import { mount } from './helpers/reactHarness.mjs';

/* ── Environnement navigateur minimal ────────────────────────────────────── */
const listeners = new Map();
globalThis.window = {
  addEventListener: (type, fn) => listeners.set(type, fn),
  removeEventListener: (type) => listeners.delete(type),
};

// Minuteur PILOTÉ : on déclenche les cycles nous-mêmes, aucune attente réelle.
let timerCallback = null;
let timerCleared = 0;
const realSetInterval = globalThis.setInterval;
const realClearInterval = globalThis.clearInterval;
globalThis.setInterval = (fn) => { timerCallback = fn; return 424242; };
globalThis.clearInterval = (id) => { if (id === 424242) { timerCleared += 1; timerCallback = null; } };
const tick = () => { timerCallback?.(); };

const { useLiveQuery } = await import('@/lib/useLiveQuery');
const { reconcileProjects } = await import('@/lib/useProjects');

const project = (id, name, extra = {}) => ({ projectId: id, projectName: name, ...extra });

/* ────────────────────────────────────────────────────────────────────────── */
section('1. Premier chargement : le seul moment où un chargement est légitime');
{
  let resolveFirst;
  const view = mount(() => useLiveQuery(() => new Promise((r) => { resolveFirst = r; }), {
    intervalMs: 7000, fallbackError: 'échec',
  }));

  check('avant toute réponse : chargement initial annoncé',
    view.result.isInitialLoading === true && view.result.data === null);
  check('…et ce n’est PAS un rafraîchissement', view.result.isRefreshing === false);

  resolveFirst([project('p1', 'Garage du Nord')]);
  await view.flush();

  check('après la réponse : les données sont là', view.result.data?.length === 1);
  check('…et le chargement initial est terminé', view.result.isInitialLoading === false);
  view.unmount();
}

section('2. Rafraîchissement : l’ancien contenu ne disparaît JAMAIS');
{
  let resolveNext;
  let call = 0;
  const view = mount(() => useLiveQuery(() => {
    call += 1;
    if (call === 1) return Promise.resolve([project('p1', 'Garage du Nord')]);
    return new Promise((r) => { resolveNext = r; });
  }, { intervalMs: 7000, fallbackError: 'échec' }));
  await view.flush();

  const before = view.result.data;
  tick(); // cycle de sondage
  await view.flush(2);

  check('pendant le rafraîchissement, les données restent affichées',
    view.result.data === before && view.result.data?.length === 1);
  check('…aucun retour à l’état de chargement initial',
    view.result.isInitialLoading === false);
  check('…et le rafraîchissement est signalé séparément',
    view.result.isRefreshing === true);

  resolveNext([project('p1', 'Garage du Sud')]);
  await view.flush();

  check('la nouvelle valeur est appliquée',
    view.result.data?.[0]?.projectName === 'Garage du Sud');
  check('le signal de rafraîchissement retombe', view.result.isRefreshing === false);

  // Aucun rendu intermédiaire n'a montré une liste vide ou nulle.
  const traversedEmpty = view.renders
    .slice(view.renders.findIndex((r) => r.data !== null))
    .some((r) => r.data === null || r.data.length === 0);
  check('AUCUN rendu ne repasse par un état vide', traversedEmpty === false);
  view.unmount();
}

section('3. Un rafraîchissement raté ne détruit pas une page déjà lue');
{
  let call = 0;
  const view = mount(() => useLiveQuery(() => {
    call += 1;
    if (call === 1) return Promise.resolve([project('p1', 'Garage du Nord')]);
    return Promise.reject(new Error('réseau coupé'));
  }, { intervalMs: 7000, fallbackError: 'Erreur inattendue.' }));
  await view.flush();

  tick();
  await view.flush();

  check('les dernières données connues sont conservées',
    view.result.data?.[0]?.projectName === 'Garage du Nord');
  check('aucune erreur bloquante n’est levée', view.result.error === null);
  check('l’écran n’est pas repassé en chargement', view.result.isInitialLoading === false);

  // On retente au cycle suivant, sans intervention.
  const callsBefore = call;
  tick();
  await view.flush();
  check('un nouvel essai a bien lieu au cycle suivant', call > callsBefore);
  view.unmount();
}

section('4. Échec du PREMIER chargement : là, il faut le dire');
{
  const view = mount(() => useLiveQuery(() => Promise.reject(new Error('boum')), {
    intervalMs: 7000, fallbackError: 'Erreur inattendue.',
  }));
  await view.flush();
  check('sans rien à montrer, l’erreur est annoncée', typeof view.result.error === 'string');
  check('…et le chargement initial est terminé', view.result.isInitialLoading === false);
  view.unmount();
}

section('5. Un seul sondage à la fois, un seul minuteur');
{
  let inFlight = 0;
  let maxParallel = 0;
  let calls = 0;
  const view = mount(() => useLiveQuery(() => {
    calls += 1;
    inFlight += 1;
    maxParallel = Math.max(maxParallel, inFlight);
    return new Promise((r) => setImmediate(() => { inFlight -= 1; r([project('p1', 'A')]); }));
  }, { intervalMs: 7000, fallbackError: 'échec' }));
  await view.flush();

  const before = calls;
  // Le minuteur et le retour sur la fenêtre tombent au même instant.
  tick();
  listeners.get('focus')?.();
  tick();
  check('deux déclencheurs simultanés ne produisent qu’une requête',
    calls === before + 1);
  check('aucune requête ne se chevauche', maxParallel === 1);
  await view.flush();

  view.unmount();
  const afterUnmount = calls;
  tick();
  listeners.get('focus')?.();
  await view.flush(2);
  check('le minuteur est nettoyé au démontage', timerCleared >= 1);
  check('…et l’écouteur de fenêtre aussi', listeners.has('focus') === false);
  check('plus aucune requête après démontage', calls === afterUnmount);
}

section('6. Changer de ressource repart sur un vrai premier chargement');
{
  let key = 'p1';
  let resolveIt;
  const view = mount(() => useLiveQuery(() => new Promise((r) => { resolveIt = r; }), {
    intervalMs: 7000, fallbackError: 'échec', key,
  }));
  resolveIt(project('p1', 'Premier'));
  await view.flush();
  check('la première fiche est chargée', view.result.data?.projectId === 'p1');

  key = 'p2';
  view.rerender(); // comme un rendu provoqué par la navigation vers une autre fiche
  await view.flush(2);
  check('changer de projet redonne un chargement initial',
    view.result.isInitialLoading === true && view.result.data === null);
  resolveIt(project('p2', 'Second'));
  await view.flush();
  check('…puis affiche la nouvelle fiche', view.result.data?.projectId === 'p2');
  view.unmount();
}

section('7. Liste stable : les projets inchangés gardent leur identité');
{
  const a = project('p1', 'A');
  const b = project('p2', 'B');
  const previous = [a, b];

  const identical = reconcileProjects(previous, [project('p1', 'A'), project('p2', 'B')]);
  check('rien n’a changé → le tableau précédent est rendu tel quel',
    identical === previous);

  const oneChanged = reconcileProjects(previous, [project('p1', 'A'), project('p2', 'B bis')]);
  check('un seul projet modifié → nouveau tableau', oneChanged !== previous);
  check('…le projet INCHANGÉ garde sa référence', oneChanged[0] === a);
  check('…seul le projet modifié est remplacé', oneChanged[1] !== b);
  check('…et sa nouvelle valeur est bien appliquée', oneChanged[1].projectName === 'B bis');

  const reordered = reconcileProjects(previous, [project('p2', 'B'), project('p1', 'A')]);
  check('un changement d’ordre est bien pris en compte', reordered[0] === b);

  const removed = reconcileProjects(previous, [project('p1', 'A')]);
  check('une suppression est bien prise en compte', removed.length === 1);

  check('les clés React restent les identifiants de projet',
    previous.every((p) => typeof p.projectId === 'string' && p.projectId.length > 0));
}

globalThis.setInterval = realSetInterval;
globalThis.clearInterval = realClearInterval;
finish();
