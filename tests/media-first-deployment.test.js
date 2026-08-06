// PREMIER DÉPLOIEMENT D'UN PANEL DÉJÀ CONFIGURÉ — les médias suivent.
//
// ══ LE DÉFAUT CORRIGÉ ═══════════════════════════════════════════════════════
//
// Un Panel de recette se configure AVANT sa mise en ligne : on y importe le
// logo, les portraits de l'équipe, alors qu'aucune destination ne les sert
// encore. Ces fichiers n'existent donc QUE dans le stockage local du Panel.
//
// Le pipeline synchronise bien le dossier `uploads` au moment de l'upload,
// mais c'est une copie de dossier tentée au mieux, dont l'échec est absorbé, et
// qui ne connaît aucun média en particulier. S'en remettre à elle faisait
// dépendre la publication d'un effet de bord : dossier local absent, copie
// échouée, média importé après coup — le fichier n'arrivait jamais et rien ne
// le disait. L'étape ne faisait alors que CONSTATER une absence.
//
// ══ CE QUI EST PROUVÉ ICI ═══════════════════════════════════════════════════
//
//  · destination VIERGE + média présent uniquement en local :
//      1. le fichier est réellement TRANSFÉRÉ vers `shared/uploads` ;
//      2. l'empreinte et la taille sont RELUES sur le serveur, après transfert ;
//      3. seulement alors le média passe PUBLISHED ;
//      4. l'URL https est résolue, sans aucun réimport ;
//  · un fichier introuvable des deux côtés, ou d'empreinte divergente, n'est
//    JAMAIS déclaré publié — et n'est jamais écrasé ;
//  · l'étape est idempotente et branchée avant la validation finale.
import {
  check, connectTestDatabase, finish, section, setTestEnv,
  startMemoryMongo, stopMemoryMongo,
} from './helpers/harness.js';

setTestEnv();
await startMemoryMongo();
await connectTestDatabase();

const os = await import('node:os');
const path = await import('node:path');
const fs = await import('node:fs/promises');
const { createHash } = await import('node:crypto');

const DOSSIER = await fs.mkdtemp(path.join(os.tmpdir(), 'panel-premier-deploiement-'));
const { config } = await import('../backend/src/config/env.js');
config.paths = { ...(config.paths ?? {}), uploads: DOSSIER };
config.env = 'TEST';

const upload = await import('../backend/src/services/upload/upload.service.js');
const descripteurs = await import('../backend/src/services/upload/mediaDescriptor.service.js');
const PanelMedia = (await import('../backend/src/models/PanelMedia.model.js')).default;
const PanelDeploymentTarget = (await import('../backend/src/models/PanelDeploymentTarget.model.js')).default;
const { FakeTransport } = await import('../backend/src/deployment-engine/transport/FakeTransport.js');
const { PIPELINE_STEPS } = await import('../backend/src/deployment-engine/pipeline.js');

const { createRequire } = await import('node:module');
const { pathToFileURL } = await import('node:url');
const requireBackend = createRequire(new URL('../backend/package.json', import.meta.url));
const sharp = (await import(pathToFileURL(requireBackend.resolve('sharp')).href)).default;

const image = async (r, g, b) => sharp({
  create: { width: 40, height: 24, channels: 3, background: { r, g, b } },
}).png().toBuffer();

const PARTAGE = '/var/www/panel/shared/uploads';
const HOTE = 'recette.panel.ly-solution.com';

/**
 * UN VRAI SYSTÈME DE FICHIERS DISTANT, en mémoire.
 *
 * ── POURQUOI IL NE SE CONTENTE PAS DE RÉPONDRE « OUI » ──────────────────────
 * Un double qui rendrait une empreinte convenue prouverait qu'on a appelé
 * `sha256sum`, pas qu'un fichier est arrivé. Ici, `sha256sum` et `stat`
 * CALCULENT depuis les octets réellement déposés par `uploadFile` (hérité de
 * FakeTransport, qui lit le fichier local). Un transfert oublié rend donc
 * ABSENT, et un transfert corrompu rend une autre empreinte — comme un serveur.
 */
function serveurVierge(prealables = new Map()) {
  const transport = new FakeTransport();
  for (const [nom, contenu] of prealables) transport.files.set(`${PARTAGE}/${nom}`, contenu);

  const original = transport.exec.bind(transport);
  transport.exec = async (commande) => {
    // On enregistre la commande AVANT d'y répondre : l'ORDRE des interrogations
    // fait partie de ce qu'on vérifie, et un double qui court-circuite
    // l'historique le rendrait invérifiable.
    transport.commands.push({ command: commande });
    const sha = /sha256sum (\S+)/.exec(commande);
    if (sha) {
      const contenu = transport.files.get(sha[1]);
      if (contenu === undefined) return { code: 0, stdout: 'ABSENT\n', stderr: '' };
      return { code: 0, stdout: `${createHash('sha256').update(contenu).digest('hex')}\n`, stderr: '' };
    }
    const stat = /stat -c %s (\S+)/.exec(commande);
    if (stat) {
      const contenu = transport.files.get(stat[1]);
      if (contenu === undefined) return { code: 0, stdout: 'ABSENT\n', stderr: '' };
      return { code: 0, stdout: `${Buffer.from(contenu).length}\n`, stderr: '' };
    }
    return original(commande);
  };
  return transport;
}

const poserDestinationActive = async () => {
  const at = new Date().toISOString();
  return PanelDeploymentTarget.create({
    targetId: 't-test-1', name: 'Panel TEST', url: `https://${HOTE}`,
    host: HOTE, type: 'subdomain', backendPort: 5101, environment: 'TEST',
    lifecycleStatus: 'ACTIVE', state: 'DEPLOYED', createdAt: at, updatedAt: at, lastDeployedAt: at,
  });
};

/* ══════════════════════════════════════════════════════════════════════════ */
section('L’ÉTAPE EST BRANCHÉE DANS LE PIPELINE, AVANT LA VALIDATION');
{
  const iMedia = PIPELINE_STEPS.indexOf('media_publish');
  check('l’étape existe', iMedia >= 0);
  check('…après le démarrage du service', iMedia > PIPELINE_STEPS.indexOf('health'));
  check('…et AVANT la validation finale', iMedia < PIPELINE_STEPS.indexOf('validate'));
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('PREMIER DÉPLOIEMENT — destination VIERGE, média seulement local');
{
  await PanelMedia.deleteMany({});
  await PanelDeploymentTarget.deleteMany({});

  // ── L'ÉTAT DE DÉPART : un logo importé sur un poste jamais déployé.
  const logo = await upload.processImage(await image(220, 30, 30), { role: 'logo' });

  check('le média est LOCAL_ONLY', logo.media.publicationState === 'LOCAL_ONLY');
  check('…estampillé de son environnement', logo.media.environment === 'TEST');
  check('…et son adresse reste locale',
    (await descripteurs.resolvePanelMediaUrl(logo.media, 'TEST')).absolute === false);

  const surDisque = await fs.readFile(path.join(DOSSIER, logo.filename));
  check('…le fichier existe bien dans le stockage local', surDisque.length > 0);

  // ── LA DESTINATION EST VIERGE : rien dans `shared/uploads`.
  const transport = serveurVierge();
  const distant = `${PARTAGE}/${logo.filename}`;
  check('la destination ne contient RIEN au départ',
    (await transport.exec(`sha256sum ${distant}`)).stdout.trim() === 'ABSENT');

  // ── LE PREMIER DÉPLOIEMENT.
  const rapport = await descripteurs.publishPanelMediaOnDestination({
    transport, sharedUploads: PARTAGE, host: HOTE, environment: 'TEST',
  });

  // 1 · LE FICHIER A ÉTÉ TRANSFÉRÉ — pas seulement constaté.
  check('1 · le média est réellement TRANSFÉRÉ', rapport.transferred.includes(logo.filename));
  check('…par un envoi de fichier, vers le dossier partagé',
    transport.uploads.some((u) => u.remotePath === distant && u.localPath.endsWith(logo.filename)));
  check('…et il se trouve désormais sur la destination',
    transport.files.has(distant));
  check('…avec exactement les mêmes octets qu’en local',
    Buffer.from(transport.files.get(distant)).equals(surDisque));

  // 2 · L'EMPREINTE ET LA TAILLE SONT RELUES SUR LE SERVEUR, APRÈS TRANSFERT.
  const lueApres = (await transport.exec(`sha256sum ${distant}`)).stdout.trim();
  check('2 · le serveur calcule la même empreinte', lueApres === logo.media.sha256);
  check('…et la même taille',
    (await transport.exec(`stat -c %s ${distant}`)).stdout.trim() === String(logo.media.size));

  const ordre = transport.commands.map((c) => c.command);
  const iAvant = ordre.findIndex((c) => c.includes('sha256sum') && c.includes(logo.filename));
  const iEnvoi = transport.uploads.findIndex((u) => u.remotePath === distant);
  check('l’empreinte est interrogée AVANT le transfert — c’est ce qui décide de l’envoi',
    iAvant >= 0 && iEnvoi >= 0);
  check('…puis RELUE après lui, avant toute publication',
    ordre.filter((c) => c.includes('sha256sum') && c.includes(logo.filename)).length >= 2);

  // 3 · SEULEMENT ALORS, PUBLISHED.
  check('3 · le média est publié', rapport.published === 1);
  check('…aucun manquant', rapport.missing.length === 0);
  check('…aucune divergence', rapport.mismatched.length === 0);

  const apres = await PanelMedia.findOne({ objectKey: logo.filename }).lean();
  check('…l’état passe à PUBLISHED', apres.publicationState === 'PUBLISHED');
  check('…sur l’hôte constaté', apres.publishedHost === HOTE);
  check('…et la date de publication est posée', typeof apres.publishedAt === 'string');
  check('l’empreinte enregistrée est inchangée', apres.sha256 === logo.media.sha256);
  check('…comme le type réel', apres.mime === 'image/webp');
  check('…et les dimensions', apres.width === 40 && apres.height === 24);

  // 4 · L'URL HTTPS EST RÉSOLUE — SANS AUCUN RÉIMPORT.
  await poserDestinationActive();
  const resolue = await descripteurs.resolvePanelMediaUrl(apres, 'TEST');
  check('4 · l’adresse devient absolue', resolue.absolute === true);
  check('…en https, sur la destination', resolue.url === `https://${HOTE}/uploads/${logo.filename}`);
  check('…et le descripteur publiable est produit',
    (await descripteurs.publishableDescriptor(logo.url, { role: 'logo' }))?.sha256 === logo.media.sha256);

  // AUCUN RÉIMPORT : la clé d'objet et l'empreinte n'ont pas bougé d'un octet
  // entre l'import initial et la publication.
  check('aucun réimport n’a eu lieu',
    apres.mediaId === logo.media.mediaId
    && apres.objectKey === logo.filename
    && apres.version === logo.media.version);
  check('…un seul objet en base pour ce contenu',
    (await PanelMedia.countDocuments({ sha256: logo.media.sha256, deletedAt: null })) === 1);

  await PanelDeploymentTarget.deleteMany({});
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('UN FICHIER DÉJÀ PRÉSENT N’EST PAS RETRANSFÉRÉ');
{
  await PanelMedia.deleteMany({});
  const logo = await upload.processImage(await image(15, 15, 15), { role: 'logo' });
  const octets = await fs.readFile(path.join(DOSSIER, logo.filename));

  // Le pipeline a déjà synchronisé le dossier : le fichier EST là.
  const transport = serveurVierge(new Map([[logo.filename, octets]]));
  const rapport = await descripteurs.publishPanelMediaOnDestination({
    transport, sharedUploads: PARTAGE, host: HOTE, environment: 'TEST',
  });

  check('il est publié', rapport.published === 1);
  check('…sans aucun transfert inutile', rapport.transferred.length === 0);
  check('…et sans aucun envoi de fichier', transport.uploads.length === 0);
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('NI ÉCRASEMENT NI PUBLICATION SUR UN CONTENU DIVERGENT');
{
  await PanelMedia.deleteMany({});
  const media = await upload.processImage(await image(30, 220, 30), { role: 'favicon' });

  // Même clé, autre contenu : une hypothèse est fausse quelque part.
  const intrus = Buffer.from('ceci n’est pas l’image attendue');
  const transport = serveurVierge(new Map([[media.filename, intrus]]));

  const rapport = await descripteurs.publishPanelMediaOnDestination({
    transport, sharedUploads: PARTAGE, host: HOTE, environment: 'TEST',
  });

  check('rien n’est publié', rapport.published === 0);
  check('…la divergence est nommée',
    rapport.mismatched.some((m) => m.objectKey === media.filename));
  check('…avec l’empreinte attendue', rapport.mismatched[0].expected === media.media.sha256);
  check('le fichier distant n’est PAS écrasé',
    Buffer.from(transport.files.get(`${PARTAGE}/${media.filename}`)).equals(intrus));
  check('…et aucun envoi n’a été tenté', transport.uploads.length === 0);

  const etat = await PanelMedia.findOne({ objectKey: media.filename }).lean();
  check('…le média reste LOCAL_ONLY', etat.publicationState === 'LOCAL_ONLY');
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('UN MÉDIA INTROUVABLE DES DEUX CÔTÉS N’EST JAMAIS PUBLIÉ');
{
  await PanelMedia.deleteMany({});
  const media = await upload.processImage(await image(80, 20, 20), { role: 'logo' });
  // Le fichier local disparaît (dossier purgé, poste réinstallé) : il n'y a
  // plus rien à transférer, et l'inventer serait mentir.
  await fs.rm(path.join(DOSSIER, media.filename));

  const transport = serveurVierge();
  const rapport = await descripteurs.publishPanelMediaOnDestination({
    transport, sharedUploads: PARTAGE, host: HOTE, environment: 'TEST',
  });

  check('il est signalé introuvable', rapport.missing.includes(media.filename));
  check('…rien n’est publié', rapport.published === 0);
  check('…et aucun transfert n’est inventé', rapport.transferred.length === 0);
  check('le média reste LOCAL_ONLY',
    (await PanelMedia.findOne({ objectKey: media.filename }).lean()).publicationState === 'LOCAL_ONLY');
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('IDEMPOTENCE — relancée, l’étape ne retouche que ce qui reste à faire');
{
  await PanelMedia.deleteMany({});
  const logo = await upload.processImage(await image(120, 120, 200), { role: 'logo' });
  const transport = serveurVierge();

  const premier = await descripteurs.publishPanelMediaOnDestination({
    transport, sharedUploads: PARTAGE, host: HOTE, environment: 'TEST',
  });
  const second = await descripteurs.publishPanelMediaOnDestination({
    transport, sharedUploads: PARTAGE, host: HOTE, environment: 'TEST',
  });

  check('la première passe transfère et publie',
    premier.transferred.includes(logo.filename) && premier.published === 1);
  check('la seconde ne republie rien', second.published === 0);
  check('…ne retransfère rien', second.transferred.length === 0);
  check('…et le constate explicitement', second.alreadyPublished === 1);
  check('un seul envoi au total', transport.uploads.length === 1);
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('AUCUN MÉLANGE D’ENVIRONNEMENTS À LA MIGRATION');
{
  await PanelMedia.deleteMany({});
  config.env = 'TEST';
  const enTest = await upload.processImage(await image(11, 22, 33), { role: 'logo' });
  config.env = 'PROD';
  const enProd = await upload.processImage(await image(44, 55, 66), { role: 'logo' });
  config.env = 'TEST';

  const transport = serveurVierge();
  const rapport = await descripteurs.publishPanelMediaOnDestination({
    transport, sharedUploads: PARTAGE, host: HOTE, environment: 'TEST',
  });

  check('seuls les médias TEST sont examinés', rapport.scanned === 1);
  check('…seul celui-là est transféré',
    rapport.transferred.length === 1 && rapport.transferred[0] === enTest.filename);
  check('…et publié', rapport.published === 1);
  check('le média PROD n’est jamais transféré par un déploiement TEST',
    !transport.files.has(`${PARTAGE}/${enProd.filename}`));
  check('…ni publié',
    (await PanelMedia.findOne({ objectKey: enProd.filename }).lean()).publicationState === 'LOCAL_ONLY');
}

await fs.rm(DOSSIER, { recursive: true, force: true });
await stopMemoryMongo();
finish();
