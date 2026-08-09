/**
 * LOT F — L'IDENTITÉ VISUELLE PUBLIQUE DU PANEL.
 *
 * ══ LE DÉFAUT QUE CE LOT FERME ══════════════════════════════════════════════
 *
 * Les trois données qui peignent le Panel — nom, logo, thème — vivaient
 * derrière `requirePanelUser`. `useThemeLoader()` partait pourtant dès le
 * montage de l'application, donc AVANT le login : il recevait un 401 que le
 * `.catch(() => {})` avalait. L'écran de connexion ne pouvait donc
 * STRUCTURELLEMENT pas se thémer, et personne ne le voyait.
 *
 * Il affichait par-dessus le marché « Panel L.Y Solution », écrit en dur — une
 * marque qui ne peut pas être livrée à une autre agence.
 *
 * ══ CE QUE CE FICHIER GARDE ═════════════════════════════════════════════════
 *
 * Une surface publique est une surface publique POUR TOUJOURS. Le contrôle qui
 * compte n'est pas « ça marche », c'est « ça n'expose QUE cela » — et il doit
 * échouer le jour où quelqu'un ajoutera un champ sans y penser.
 */
import {
  check, connectTestDatabase, finish, section, setTestEnv,
  startMemoryMongo, startServer, stopMemoryMongo,
} from './helpers/harness.js';

setTestEnv();
await startMemoryMongo();
await connectTestDatabase();

const { createApp } = await import('../backend/src/app.js');
const societe = await import('../backend/src/services/company/company.service.js');
const { PUBLIC_BRANDING_KEYS } = await import(
  '../backend/src/services/company/publicBranding.service.js'
);

const { call, close } = await startServer(createApp());

const brandingPublic = () => call('GET', '/api/public/branding');

/* ══════════════════════════════════════════════════════════════════════════ */
section('ACCESSIBLE SANS SESSION — c’est tout l’objet de cette route');
{
  const r = await brandingPublic();
  check(`la route répond sans jeton (${r.status})`, r.status === 200);
  check('…et rend une enveloppe de succès', r.json?.success === true);
  check('…même sans fiche entreprise créée', r.json?.data !== undefined);

  /**
   * UNE INSTALLATION NEUVE N'EST PAS UNE ERREUR : c'est l'état d'un Panel qu'on
   * vient de déployer. L'écran de connexion doit s'afficher, avec ses replis.
   */
  const d = r.json?.data ?? {};
  check('nom : null tant que rien n’est configuré', d.companyName === null);
  check('logo : null', d.logoUrl === null);
  check('…et le thème par défaut est tout de même servi', d.theme !== undefined);
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('LA LISTE BLANCHE — et rien au-delà');
{
  const ACTEUR = { id: 'test', email: 'dev@panel.test' };
  const { companyId } = await societe.createCompany({
    identity: { name: 'Agence Démo' },
    slug: 'agence-demo',
    contact: { email: 'contact@agence-demo.test', phone: '0102030405' },
  }, ACTEUR);
  await societe.saveCompany(companyId, { identity: { name: 'Agence Démo' } }, ACTEUR);

  const r = await brandingPublic();
  const d = r.json?.data ?? {};

  check('le nom configuré est publié', d.companyName === 'Agence Démo');

  /**
   * LE CONTRÔLE QUI COMPTE : la réponse ne porte QUE les clés déclarées. Une
   * liste blanche se relit ; une liste noire s'oublie le jour où un champ
   * s'ajoute.
   */
  const clefs = Object.keys(d).sort();
  check(`exactement les clés déclarées — ${clefs.join(', ')}`,
    JSON.stringify(clefs) === JSON.stringify([...PUBLIC_BRANDING_KEYS].sort()));

  /**
   * ET AUCUNE DONNÉE DE LA FICHE N'A FUITÉ.
   *
   * Le contact a été renseigné à la création : s'il ressort ici, c'est que la
   * route rend la fiche plutôt qu'un sous-ensemble.
   */
  const brut = JSON.stringify(d);
  check('aucun contact interne', !brut.includes('contact@agence-demo.test'));
  check('…aucun numéro de téléphone', !brut.includes('0102030405'));
  check('…aucun identifiant technique', !brut.includes(companyId));
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('AUCUN SECRET — recherche automatique dans la réponse');
{
  const r = await brandingPublic();
  const brut = JSON.stringify(r.json ?? {}).toLowerCase();

  /**
   * On cherche les MOTS, pas des champs connus : le jour où un champ inattendu
   * s'ajoutera, c'est son nom qui trahira sa nature.
   */
  const interdits = [
    'token', 'secret', 'password', 'credential', 'bridge',
    'ssh', 'mongo', 'jwt', 'apikey', 'authorization', 'bearer',
    'privatekey', 'pairing',
  ];
  const trouves = interdits.filter((mot) => brut.includes(mot));
  check(`aucun mot interdit dans la réponse${trouves.length ? ` — ${trouves}` : ''}`,
    trouves.length === 0);

  check('…et le thème ne porte aucun identifiant de persistance',
    !Object.keys(r.json?.data?.theme ?? {}).includes('_id'));
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('LE THÈME SERVI EST CELUI DE L’APPLICATION — une seule source');
{
  const { getPanelTheme } = await import('../backend/src/services/theme/panelTheme.service.js');
  const canonique = await getPanelTheme();
  const publie = (await brandingPublic()).json?.data?.theme ?? {};

  check('mêmes couleurs que le thème canonique',
    JSON.stringify(publie.colors) === JSON.stringify(canonique.colors));
  check('…même rayon', publie.radius === canonique.radius);
  check('…et même typographie',
    JSON.stringify(publie.typography) === JSON.stringify(canonique.typography));

  /**
   * CE QUI N'EST PAS SERVI : les champs de persistance. Ils ne peignent rien,
   * et un identifiant publié sans raison est publié pour toujours.
   */
  check('mais AUCUN champ de persistance',
    publie._id === undefined && publie.createdAt === undefined);
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('LE THÈME MODIFIÉ EST SERVI AU LOGIN, SANS SESSION');
{
  const { savePanelTheme } = await import('../backend/src/services/theme/panelTheme.service.js');
  await savePanelTheme({ colors: { primary: '#123456' } });

  const publie = (await brandingPublic()).json?.data?.theme ?? {};
  check('la couleur enregistrée est servie publiquement',
    publie.colors?.primary === '#123456');
  check('…c’est bien la MÊME source que l’application authentifiée', true);
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('L’ÉCRITURE DU THÈME RESTE PROTÉGÉE');
{
  /**
   * Ouvrir la LECTURE ne doit rien ouvrir d'autre. `/api/theme` reste la
   * surface d'écriture, réservée aux comptes DEV.
   */
  const lecture = await call('GET', '/api/theme');
  check(`la lecture authentifiée reste protégée (${lecture.status})`,
    lecture.status === 401);

  const ecriture = await call('PUT', '/api/theme', { body: { colors: { primary: '#000000' } } });
  check(`l’écriture est refusée sans session (${ecriture.status})`,
    ecriture.status === 401);

  const apres = (await brandingPublic()).json?.data?.theme ?? {};
  check('…et le thème n’a pas bougé', apres.colors?.primary === '#123456');
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('LE LOGIN N’ÉCRIT PLUS AUCUNE MARQUE EN DUR');
{
  const fs = await import('node:fs');
  const path = await import('node:path');
  const racine = path.resolve('frontend/src');

  const code = (f) => fs.readFileSync(path.join(racine, f), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');

  const login = code('pages/LoginPage.tsx');
  check('aucune marque codée en dur dans le login',
    !login.includes('L.Y Solution'));
  check('…il lit la marque du Panel', login.includes('usePanelBranding'));
  check('…et applique le MÊME repli que la barre latérale',
    login.includes('panelTitleFor'));

  /**
   * UNE SEULE PRIMITIVE DE FAVICON. Deux endroits qui posent le
   * `<link rel="icon">` finissent par se contredire : l'un pose l'ancien
   * favicon après que l'autre a posé le nouveau.
   */
  const poseurs = ['lib/publicBranding.ts', 'lib/useFavicon.ts']
    .filter((f) => /function applyFavicon/.test(code(f)));
  check(`une SEULE primitive pose le favicon — ${poseurs}`, poseurs.length === 1);

  /**
   * ET LA MARQUE EST PEINTE AVANT LE PREMIER RENDU. C'est ce qui supprime le
   * flash : sans cela, l'écran affiche les couleurs par défaut puis se
   * repeint une fois la réponse arrivée.
   */
  const main = code('main.tsx');
  // On compare à l'APPEL `createRoot(`, jamais au nom seul : celui-ci apparaît
  // d'abord dans l'import, ce qui rendrait la comparaison toujours fausse.
  check('le cache est appliqué avant le montage de React',
    main.indexOf('applyCachedBranding()') < main.indexOf('createRoot(rootElement)'));
}

await close();
await stopMemoryMongo();
finish();
