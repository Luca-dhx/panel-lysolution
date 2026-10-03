/**
 * LES TO-DO LISTS — un jour, des cases, et la coche qui ne se perd pas.
 *
 * ══ CE QUE CETTE RECETTE VERROUILLE ═════════════════════════════════════════
 *
 * 1. LA DATE EST UN JOUR CIVIL `AAAA-MM-JJ`. Un instant UTC rangerait la liste
 *    la veille sur un serveur réglé en UTC ; un jour qui n'existe pas est refusé.
 * 2. COCHER TOUCHE UN SEUL ÉLÉMENT. Deux coches concurrentes sur la même liste
 *    doivent survivre toutes les deux.
 * 3. ÉDITER CONSERVE LES COCHES. Renommer une liste ne remet pas à zéro ce qui
 *    était fait, ni la date de coche.
 * 4. LE FILTRE PAR BORNES rend les listes d'un mois, triées par jour.
 */
import {
  check, connectTestDatabase, finish, section, setTestEnv,
  startMemoryMongo, startServer, stopMemoryMongo,
} from './helpers/harness.js';

setTestEnv();
await startMemoryMongo();
await connectTestDatabase();

const { createApp } = await import('../backend/src/app.js');
const { seedFromEnv } = await import('../backend/src/services/auth/panelUsers.service.js');

await seedFromEnv();
const { call, close } = await startServer(createApp());

const login = await call('POST', '/api/auth/login', {
  body: { email: 'dev@panel.test', password: 'motdepasse-test' },
});
const AUTH = { authorization: `Bearer ${login.json.data.token}` };
const creer = (body) => call('POST', '/api/todo-lists', { headers: AUTH, body });

section('0. Les routes sont gardées');
{
  const anonyme = await call('GET', '/api/todo-lists');
  check('sans jeton : 401', anonyme.status === 401);
}

section('1. Créer — un titre et un jour civil');
let listeId;
let itemIds;
{
  const sansTitre = await creer({ date: '2026-10-14' });
  check('un titre est requis', sansTitre.status === 400 && sansTitre.json.code === 'PANEL_TODO_TITLE_REQUIRED');

  const sansDate = await creer({ title: 'X' });
  check('une date est requise', sansDate.status === 400 && sansDate.json.code === 'PANEL_TODO_DATE_INVALID');

  const inexistante = await creer({ title: 'X', date: '2026-02-30' });
  check('un jour qui n’existe pas est refusé', inexistante.status === 400 && inexistante.json.code === 'PANEL_TODO_DATE_INVALID');

  const instant = await creer({ title: 'X', date: '2026-10-14T22:30:00.000Z' });
  check('un instant n’est pas un jour', instant.status === 400);

  const r = await creer({
    title: '  Rendez-vous client  ',
    date: '2026-10-14',
    color: 'green',
    items: [{ label: 'Préparer le devis' }, { label: '' }, { label: 'Imprimer', done: true }, { label: 'Envoyer' }],
  });
  check('création : 201', r.status === 201);
  const l = r.json.data.todoList;
  listeId = l._id;
  itemIds = l.items.map((i) => i.id);
  check('le titre est nettoyé', l.title === 'Rendez-vous client');
  check('la date reste le jour saisi, sans fuseau', l.date === '2026-10-14');
  check('les lignes vides sont écartées', l.items.length === 3);
  check('chaque élément reçoit un identifiant', itemIds.every(Boolean) && new Set(itemIds).size === 3);
  check('un élément coché à la création porte sa date de coche', l.items[1].done === true && l.items[1].doneAt);

  const couleur = await creer({ title: 'Y', date: '2026-10-14', color: 'fluo' });
  check('une couleur inconnue est refusée', couleur.status === 400 && couleur.json.code === 'PANEL_TODO_COLOR_UNKNOWN');
}

section('2. Cocher — un élément à la fois, sans perdre la coche voisine');
{
  const [a, b] = await Promise.all([
    call('PATCH', `/api/todo-lists/${listeId}/items/${itemIds[0]}`, { headers: AUTH, body: { done: true } }),
    call('PATCH', `/api/todo-lists/${listeId}/items/${itemIds[2]}`, { headers: AUTH, body: { done: true } }),
  ]);
  check('les deux coches répondent 200', a.status === 200 && b.status === 200);
  const relue = await call('GET', `/api/todo-lists/${listeId}`, { headers: AUTH });
  const items = relue.json.data.todoList.items;
  check('les deux coches concurrentes ont survécu', items.every((i) => i.done === true));
  check('la coche est attribuée', items[0].doneBy === 'dev@panel.test');

  const decoche = await call('PATCH', `/api/todo-lists/${listeId}/items/${itemIds[0]}`, { headers: AUTH, body: { done: false } });
  check('décocher efface la date de coche', decoche.json.data.todoList.items[0].done === false
    && decoche.json.data.todoList.items[0].doneAt === null);

  const inconnu = await call('PATCH', `/api/todo-lists/${listeId}/items/nimporte`, { headers: AUTH, body: { done: true } });
  check('un élément inconnu : 404', inconnu.status === 404);
  const flou = await call('PATCH', `/api/todo-lists/${listeId}/items/${itemIds[0]}`, { headers: AUTH, body: { done: 'oui' } });
  check('`done` doit être un booléen', flou.status === 400);
}

section('3. Éditer — l’ordre change, les coches restent');
{
  const avant = (await call('GET', `/api/todo-lists/${listeId}`, { headers: AUTH })).json.data.todoList;
  const imprime = avant.items.find((i) => i.id === itemIds[1]);
  const r = await call('PATCH', `/api/todo-lists/${listeId}`, {
    headers: AUTH,
    body: {
      title: 'Rendez-vous Dupont',
      date: '2026-10-15',
      items: [
        { id: itemIds[2], label: 'Envoyer', done: true },
        { id: itemIds[1], label: 'Imprimer en deux exemplaires', done: true },
        { label: 'Nouveau', done: false },
      ],
    },
  });
  check('édition : 200', r.status === 200);
  const l = r.json.data.todoList;
  check('le nouvel ordre est celui du tableau', l.items[0].id === itemIds[2] && l.items[1].id === itemIds[1]);
  check('un élément retiré disparaît', !l.items.some((i) => i.id === itemIds[0]));
  check('la date de coche d’un élément renommé est conservée',
    new Date(l.items[1].doneAt).getTime() === new Date(imprime.doneAt).getTime());
  check('la liste a changé de jour', l.date === '2026-10-15');
}

section('4. Lister par bornes, puis supprimer');
{
  await creer({ title: 'Novembre', date: '2026-11-02' });
  await creer({ title: 'Début octobre', date: '2026-10-01' });
  const octobre = await call('GET', '/api/todo-lists?from=2026-10-01&to=2026-10-31', { headers: AUTH });
  const dates = octobre.json.data.todoLists.map((l) => l.date);
  check('seules les listes du mois sont rendues', dates.every((d) => d.startsWith('2026-10')));
  check('…triées par jour', dates.join() === [...dates].sort().join());

  const suppr = await call('DELETE', `/api/todo-lists/${listeId}`, { headers: AUTH });
  check('suppression : 200', suppr.status === 200 && suppr.json.data.deleted === true);
  const encore = await call('DELETE', `/api/todo-lists/${listeId}`, { headers: AUTH });
  check('une seconde suppression : 404', encore.status === 404);
}

await close();
await stopMemoryMongo();
finish();
