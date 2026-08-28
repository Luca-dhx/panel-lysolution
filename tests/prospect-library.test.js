/**
 * LES DOSSIERS ET LES MODÈLES D'ACCROCHE.
 *
 * ══ CE QUE CETTE RECETTE VERROUILLE ═════════════════════════════════════════
 *
 * 1. SUPPRIMER UN DOSSIER NE SUPPRIME RIEN D'AUTRE. Ses sous-dossiers et son
 *    contenu REMONTENT d'un cran. Un rangement n'est pas une corbeille, et
 *    perdre douze prospects parce qu'on a retiré un intitulé serait une
 *    catastrophe silencieuse.
 *
 * 2. UN DOSSIER NE DEVIENT PAS SON PROPRE ANCÊTRE. Sans cette garde, un
 *    déplacement mal visé détache une branche entière de la racine : elle
 *    n'apparaît plus nulle part, alors qu'elle existe toujours en base.
 *
 * 3. LES DEUX ARBRES NE SE MÉLANGENT PAS. Un modèle rangé dans un dossier de
 *    prospects serait invisible dans les deux écrans à la fois.
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

const creerDossier = (body) => call('POST', '/api/prospect-folders', { headers: AUTH, body });
const creerModele = (body) => call('POST', '/api/prospect-templates', { headers: AUTH, body });

/* ────────────────────────────────────────────────────────────────────────── */
section('1. Deux arbres, et ils ne se mélangent pas');
{
  const sansNom = await creerDossier({ kind: 'PROSPECT' });
  check('un nom est requis', sansNom.status === 400
    && sansNom.json.code === 'PANEL_FOLDER_NAME_REQUIRED');

  const sansFamille = await creerDossier({ name: 'Orphelin' });
  check('une famille est requise', sansFamille.status === 400
    && sansFamille.json.code === 'PANEL_FOLDER_KIND_UNKNOWN');

  const restos = await creerDossier({ name: 'Restaurants', kind: 'PROSPECT' });
  check('un dossier de prospects se crée', restos.status === 201);
  check('…et naît à la racine', restos.json.data.folder.parentId === null);

  const accroches = await creerDossier({ name: 'Accroches froides', kind: 'TEMPLATE' });

  /**
   * UN ARBRE N'ACCUEILLE PAS L'AUTRE. « Restaurants » range des prospects,
   * « Accroches froides » range des modèles : croiser les deux obligerait à
   * filtrer partout, puis à expliquer un jour pourquoi un modèle est apparu
   * dans le dossier d'un client.
   */
  const croise = await creerDossier({
    name: 'Impossible', kind: 'TEMPLATE', parentId: restos.json.data.folder._id,
  });
  check('un dossier ne se range pas dans l’arbre de l’autre famille',
    croise.status === 400 && croise.json.code === 'PANEL_FOLDER_KIND_MISMATCH');

  const liste = await call('GET', '/api/prospect-folders?kind=PROSPECT', { headers: AUTH });
  check('la liste est bornée à sa famille',
    liste.json.data.folders.length === 1
    && liste.json.data.folders[0].name === 'Restaurants');

  globalThis.__restos = restos.json.data.folder._id;
  globalThis.__accroches = accroches.json.data.folder._id;
}

/* ────────────────────────────────────────────────────────────────────────── */
section('2. Un dossier ne devient pas son propre ancêtre');
{
  const paris = await creerDossier({
    name: 'Paris', kind: 'PROSPECT', parentId: globalThis.__restos,
  });
  check('un sous-dossier se crée', paris.json.data.folder.parentId === globalThis.__restos);

  const inconnu = await creerDossier({
    name: 'Perdu', kind: 'PROSPECT', parentId: '000000000000000000000000',
  });
  check('un parent introuvable est refusé', inconnu.status === 400
    && inconnu.json.code === 'PANEL_FOLDER_PARENT_NOT_FOUND');

  /**
   * LE CYCLE. Déplacer « Restaurants » dans « Restaurants/Paris » détacherait
   * la branche entière de la racine : elle n'apparaîtrait plus nulle part, tout
   * en existant toujours en base.
   */
  const cycle = await call('PATCH', `/api/prospect-folders/${globalThis.__restos}`, {
    headers: AUTH, body: { parentId: paris.json.data.folder._id },
  });
  check('un dossier ne se range pas dans l’un des siens',
    cycle.status === 400 && cycle.json.code === 'PANEL_FOLDER_CYCLE');

  const surSoi = await call('PATCH', `/api/prospect-folders/${globalThis.__restos}`, {
    headers: AUTH, body: { parentId: globalThis.__restos },
  });
  check('…ni dans lui-même', surSoi.status === 400 && surSoi.json.code === 'PANEL_FOLDER_CYCLE');

  /* REMONTER À LA RACINE reste possible : ce n'est pas un cycle. */
  const racine = await call('PATCH', `/api/prospect-folders/${paris.json.data.folder._id}`, {
    headers: AUTH, body: { parentId: null },
  });
  check('remonter à la racine est permis', racine.json.data.folder.parentId === null);
  await call('PATCH', `/api/prospect-folders/${paris.json.data.folder._id}`, {
    headers: AUTH, body: { parentId: globalThis.__restos },
  });
  globalThis.__paris = paris.json.data.folder._id;
}

/* ────────────────────────────────────────────────────────────────────────── */
section('3. Les modèles : un titre, et le reste est libre');
{
  const sansTitre = await creerModele({ channel: 'E-mail' });
  check('un titre est requis', sansTitre.status === 400
    && sansTitre.json.code === 'PANEL_TEMPLATE_TITLE_REQUIRED');

  const nu = await creerModele({ title: 'Premier contact' });
  check('un modèle sans dossier est accepté', nu.status === 201);
  check('…et il est à la racine', nu.json.data.template.folderId === null);

  const range = await creerModele({
    title: 'Relance 1',
    channel: 'LinkedIn',
    description: 'Après un premier refus poli.',
    body: 'Bonjour…',
    folderId: globalThis.__accroches,
  });
  check('un modèle se range', range.json.data.template.folderId === globalThis.__accroches);
  check('…et garde ses quatre champs',
    range.json.data.template.channel === 'LinkedIn'
    && range.json.data.template.description === 'Après un premier refus poli.'
    && range.json.data.template.body === 'Bonjour…');

  /**
   * UN MODÈLE NE SE RANGE PAS DANS UN DOSSIER DE PROSPECTS. Il y serait
   * invisible dans les deux écrans à la fois.
   */
  const mauvais = await creerModele({ title: 'X', folderId: globalThis.__restos });
  check('un modèle refuse un dossier de prospects',
    mauvais.status === 400 && mauvais.json.code === 'PANEL_TEMPLATE_FOLDER_INVALID');

  globalThis.__modele = range.json.data.template._id;
}

/* ────────────────────────────────────────────────────────────────────────── */
section('4. Un prospect se range, et refuse l’arbre des modèles');
{
  const p = await call('POST', '/api/prospects', {
    headers: AUTH, body: { name: 'Chez Marcel', folderId: globalThis.__paris },
  });
  check('un prospect se range dans un dossier', p.json.data.prospect.folderId === globalThis.__paris);

  const mauvais = await call('POST', '/api/prospects', {
    headers: AUTH, body: { name: 'Égaré', folderId: globalThis.__accroches },
  });
  check('…et refuse un dossier de modèles',
    mauvais.status === 400 && mauvais.json.code === 'PANEL_PROSPECT_FOLDER_INVALID');

  const sorti = await call('PATCH', `/api/prospects/${p.json.data.prospect._id}`, {
    headers: AUTH, body: { folderId: null },
  });
  check('on peut le sortir de tout dossier', sorti.json.data.prospect.folderId === null);
  await call('PATCH', `/api/prospects/${p.json.data.prospect._id}`, {
    headers: AUTH, body: { folderId: globalThis.__paris },
  });
  globalThis.__prospect = p.json.data.prospect._id;
}

/* ────────────────────────────────────────────────────────────────────────── */
section('5. Supprimer un dossier ne supprime RIEN d’autre');
{
  /*
    L'arbre : Restaurants > Paris > (Chez Marcel).
    On retire « Paris ». Son contenu doit remonter dans « Restaurants ».
  */
  const suppression = await call('DELETE', `/api/prospect-folders/${globalThis.__paris}`, {
    headers: AUTH,
  });
  check('le dossier disparaît', suppression.json.data.deleted === true);
  check('…et le serveur dit où le contenu est parti',
    suppression.json.data.movedTo === globalThis.__restos);

  const prospect = await call('GET', `/api/prospects/${globalThis.__prospect}`, { headers: AUTH });
  check('LE PROSPECT EXISTE TOUJOURS', prospect.status === 200);
  check('…et il a remonté d’un cran, pas disparu',
    prospect.json.data.prospect.folderId === globalThis.__restos);

  /*
    Puis on retire « Restaurants », qui est à la RACINE : son contenu doit se
    retrouver sans dossier, et surtout pas être effacé.
  */
  await call('DELETE', `/api/prospect-folders/${globalThis.__restos}`, { headers: AUTH });
  const apres = await call('GET', `/api/prospects/${globalThis.__prospect}`, { headers: AUTH });
  check('supprimer un dossier racine laisse son contenu sans dossier',
    apres.status === 200 && apres.json.data.prospect.folderId === null);

  /* Le même geste, côté modèles. */
  await call('DELETE', `/api/prospect-folders/${globalThis.__accroches}`, { headers: AUTH });
  const modeles = await call('GET', '/api/prospect-templates', { headers: AUTH });
  const modele = modeles.json.data.templates.find((t) => t._id === globalThis.__modele);
  check('LE MODÈLE EXISTE TOUJOURS', Boolean(modele));
  check('…et il est remonté à la racine', modele.folderId === null);
}

/* ────────────────────────────────────────────────────────────────────────── */
section('6. La garde d’authentification');
{
  const nu = await call('GET', '/api/prospect-folders?kind=PROSPECT');
  check('sans jeton, l’arbre est refusé', nu.status === 401);
  const ecriture = await call('POST', '/api/prospect-templates', { body: { title: 'intrus' } });
  check('…et l’écriture aussi', ecriture.status === 401);
}

await close();
await stopMemoryMongo();
finish();
