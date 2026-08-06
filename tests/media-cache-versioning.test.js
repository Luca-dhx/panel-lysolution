// CACHE ET VERSIONNEMENT PAR EMPREINTE — LOT 7.
//
// ══ LA RÈGLE ═══════════════════════════════════════════════════════════════
//
// Une ancienne image ne doit JAMAIS réapparaître après remplacement ou
// suppression.
//
// ══ CE QUI NE MARCHAIT PAS ═════════════════════════════════════════════════
//
// Le nom d'un média était `<préfixe>-<horodatage>-<aléa>.webp`. Rien, dans
// cette adresse, ne dépendait du CONTENU. Un cache ne pouvait donc pas savoir
// qu'il détenait une version périmée, et le seul recours était un paramètre
// temporel collé à l'URL — c'est-à-dire une adresse qui change sans que
// l'image change : un cache qui ne sert jamais, et qui ne garantit rien.
//
// ══ CE QUI EST PROUVÉ ICI ══════════════════════════════════════════════════
//
// L'adresse EST le contenu : `<mediaId>-<empreinte courte>.webp`. Un contenu
// différent a forcément une autre adresse ; une adresse donnée ne peut plus
// jamais désigner autre chose. Le fichier est alors légitimement « immutable »,
// une référence supprimée répond 410, et le JSON qui transporte les adresses
// n'est jamais mis en cache — sans quoi on aurait rendu les images immuables
// pour les faire ressusciter par la porte d'à côté.
import {
  check, connectTestDatabase, finish, section, setTestEnv,
  startMemoryMongo, startServer, stopMemoryMongo,
} from './helpers/harness.js';

setTestEnv();
await startMemoryMongo();
await connectTestDatabase();

const os = await import('node:os');
const path = await import('node:path');
const fs = await import('node:fs/promises');

const DOSSIER = await fs.mkdtemp(path.join(os.tmpdir(), 'panel-cache-'));

const { config } = await import('../backend/src/config/env.js');
config.paths = { ...(config.paths ?? {}), uploads: DOSSIER };

const upload = await import('../backend/src/services/upload/upload.service.js');
const descripteurs = await import('../backend/src/services/upload/mediaDescriptor.service.js');
const PanelMedia = (await import('../backend/src/models/PanelMedia.model.js')).default;
const createApp = (await import('../backend/src/app.js')).default;

const { createRequire } = await import('node:module');
const { pathToFileURL } = await import('node:url');
const requireBackend = createRequire(new URL('../backend/package.json', import.meta.url));
const sharp = (await import(pathToFileURL(requireBackend.resolve('sharp')).href)).default;

const image = (r, g, b) => sharp({
  create: { width: 32, height: 32, channels: 3, background: { r, g, b } },
}).png().toBuffer();

const rouge = await image(220, 30, 30);
const bleue = await image(30, 30, 220);

/* ══════════════════════════════════════════════════════════════════════════ */
section('L’ADRESSE EST LE CONTENU');
{
  const a = await upload.processImage(rouge, { role: 'logo' });

  check('le nom porte l’identité du média et l’empreinte de son contenu',
    /^[0-9a-f-]{36}-[0-9a-f]{12}\.webp$/.test(a.filename));
  check('…et l’empreinte du nom est bien celle du contenu',
    descripteurs.shortHashOf(a.filename) === a.media.sha256.slice(0, 12));

  check('aucun horodatage dans le nom', !/\d{10,}/.test(a.filename.replace(/[0-9a-f-]{36}/, '')));
  check('aucun paramètre temporel dans l’adresse', !a.url.includes('?'));

  const b = await upload.processImage(bleue, { role: 'logo' });
  check('un contenu DIFFÉRENT a forcément une autre adresse', b.url !== a.url);
  check('…et une autre empreinte', b.media.sha256 !== a.media.sha256);
  check('…l’ancien fichier n’a PAS été écrasé',
    (await fs.readdir(DOSSIER)).includes(a.filename));

  // L'adresse ne peut plus jamais désigner autre chose : c'est ce qui rend
  // l'immuabilité honnête.
  const contenu = await fs.readFile(path.join(DOSSIER, a.filename));
  check('l’adresse d’origine sert toujours le même contenu',
    descripteurs.sha256Of(contenu) === a.media.sha256);
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('RÉIMPORT DU MÊME FICHIER — dédupliqué, et scopé');
{
  const premier = await upload.processImage(rouge, { role: 'logo' });
  const second = await upload.processImage(rouge, { role: 'logo' });

  check('réimporter le même fichier est possible', Boolean(second.url));
  check('…et rend le MÊME objet', second.url === premier.url);
  check('…sans créer de doublon sur le disque', second.filename === premier.filename);
  check('…la déduplication est annoncée', second.deduplicated === true);
  check('…et l’identité du média ne change pas',
    second.media.mediaId === premier.media.mediaId);

  // La déduplication est SCOPÉE : un même contenu dans une autre portée reste
  // un autre objet. Sans cela, supprimer l'un ferait disparaître l'autre.
  const autrePortee = await upload.processImage(rouge, { role: 'logo', scope: 'AUTRE_PORTEE' });
  check('un même contenu dans une AUTRE portée reste un autre objet',
    autrePortee.url !== premier.url);
  check('…avec sa propre identité', autrePortee.media.mediaId !== premier.media.mediaId);
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('REMPLACEMENT ET SUPPRESSION — rien ne ressuscite');
{
  const ancien = await upload.processImage(await image(10, 200, 10), { role: 'logo' });
  const remplacant = await upload.processImage(await image(200, 200, 10), { role: 'logo' });

  check('un remplacement produit une NOUVELLE adresse', remplacant.url !== ancien.url);

  await upload.deleteImage(ancien.filename);
  const restant = await fs.readdir(DOSSIER);
  check('le fichier remplacé peut être retiré', !restant.includes(ancien.filename));
  check('…sans toucher au remplaçant', restant.includes(remplacant.filename));

  const trace = await PanelMedia.findOne({ objectKey: ancien.filename }).lean();
  check('le descripteur du média supprimé SURVIT — pour pouvoir répondre 410',
    trace !== null && typeof trace.deletedAt === 'string');

  // Réimporter le même contenu après suppression recrée un objet : la
  // déduplication ne ressuscite jamais un média retiré.
  const reimport = await upload.processImage(await image(10, 200, 10), { role: 'logo' });
  check('réimporter un contenu supprimé recrée un objet', reimport.deduplicated !== true);
  check('…à une adresse neuve', reimport.url !== ancien.url);
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('NOMS ACCEPTÉS — la forme historique reste supprimable');
{
  // Des fichiers portant l'ancien nom existent sur les serveurs déployés :
  // cesser de les reconnaître les rendrait indestructibles.
  const historique = `logo-${'1'.repeat(13)}-123456789.webp`;
  await fs.writeFile(path.join(DOSSIER, historique), Buffer.from('x'));
  const res = await upload.deleteImage(historique);
  check('un média au nom HISTORIQUE reste supprimable', res.deleted === true);

  const refuse = async (nom) => {
    try { await upload.deleteImage(nom); return null; } catch (err) { return err.code; }
  };
  check('un nom hors des deux formes est refusé',
    (await refuse('quelconque.webp')) === 'PANEL_MEDIA_INVALID_NAME');
  check('…une remontée de répertoire aussi',
    (await refuse('../secret.webp')) === 'PANEL_MEDIA_INVALID_NAME');
  check('…un séparateur aussi',
    (await refuse('sous/dossier.webp')) === 'PANEL_MEDIA_INVALID_NAME');
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('EN-TÊTES — immuable pour un média, jamais pour le JSON qui le porte');
{
  const app = createApp();
  const { call, close } = await startServer(app);

  const media = await upload.processImage(await image(90, 90, 200), { role: 'logo' });

  const reponse = await call('GET', media.url);
  check('un média est servi', reponse.status === 200 || reponse.status === 304);
  const cache = reponse.headers.get('cache-control') ?? '';
  check('…avec un cache d’un an', /max-age=31536000/.test(cache));
  check('…déclaré immuable', /immutable/.test(cache));
  check('…et public', /public/.test(cache));

  // Un nom HISTORIQUE ne peut pas être déclaré immuable : son adresse ne
  // dépend pas de son contenu.
  const historique = `logo-${'2'.repeat(13)}-987654321.webp`;
  await fs.writeFile(path.join(DOSSIER, historique), Buffer.from('y'));
  const ancienne = await call('GET', `/uploads/${historique}`);
  check('un nom historique n’est PAS déclaré immuable',
    !/immutable/.test(ancienne.headers.get('cache-control') ?? ''));

  // LE JSON QUI TRANSPORTE LES ADRESSES N'EST JAMAIS MIS EN CACHE.
  const json = await call('GET', '/api/company');
  check('une réponse JSON de l’API n’est jamais stockée',
    /no-store/.test(json.headers.get('cache-control') ?? ''));

  // RÉFÉRENCE SUPPRIMÉE → 410, pas un 404 muet.
  await upload.deleteImage(media.filename);
  const partie = await call('GET', media.url);
  check('une référence supprimée répond 410 Gone', partie.status === 410);
  check('…avec un code lisible', partie.json?.code === 'PANEL_MEDIA_GONE');
  check('…et sans jamais être mise en cache',
    /no-store/.test(partie.headers.get('cache-control') ?? ''));

  // Une adresse qui n'a JAMAIS existé reste un 404 : la distinction compte.
  const jamais = await call('GET', '/uploads/00000000-0000-4000-8000-000000000000-abcdefabcdef.webp');
  check('une adresse jamais existée reste un 404', jamais.status === 404);

  await close();
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('AUCUNE VERSION TEMPORELLE — ni dans le code, ni dans les adresses');
{
  const fsSync = await import('node:fs');
  const lire = (rel) => fsSync.readFileSync(new URL(rel, import.meta.url), 'utf8');

  const service = lire('../backend/src/services/upload/upload.service.js');
  check('le nom d’un média ne dépend plus de l’horloge',
    !/Date\.now\(\)/.test(service));
  check('…ni du hasard seul', !/Math\.random\(\)/.test(service));
  check('…il dépend de l’empreinte du contenu',
    /objectKeyFor\(\{ mediaId, sha256: empreinte \}\)/.test(service));

  const descripteur = lire('../backend/src/services/upload/mediaDescriptor.service.js');
  check('l’adresse publiée ne porte aucun paramètre anti-cache',
    !/\?v=|\?t=|cacheBust/.test(descripteur));

  const front = lire('../frontend/src/components/company/DeveloperIdentity.tsx');
  check('l’aperçu ne colle aucun paramètre temporel à l’adresse',
    !/\?t=\$\{|\?v=\$\{|Date\.now\(\)/.test(front));
  check('…aucune URL blob n’est conservée', !/createObjectURL/.test(front));
  check('…et un média indisponible a un repli propre',
    /onError=/.test(front) && /Image indisponible/.test(front));
}

await fs.rm(DOSSIER, { recursive: true, force: true });
await stopMemoryMongo();
finish();
