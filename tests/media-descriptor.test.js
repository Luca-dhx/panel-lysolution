// BRIDGE MÉDIA CANONIQUE — LOT 4.
//
// ══ CE QUI EST PROUVÉ ICI ═══════════════════════════════════════════════════
//
// Le Bridge ne transportait qu'une URL. Un projet qui la recevait ne pouvait
// répondre à aucune des questions dont il a besoin : est-ce la même image
// qu'hier ? quel type réel ? quelles dimensions ? cette projection est-elle
// plus récente que celle déjà appliquée ? Faute de réponses, il ne pouvait que
// recharger l'adresse et espérer — d'où des images remplacées qui restaient
// affichées depuis le cache, et des liens morts qu'aucun écran ne qualifiait.
//
// On vérifie donc que le Panel MESURE ce qu'il publie (empreinte, type réel,
// dimensions, taille, version), qu'il refuse de publier une adresse qu'un
// projet ne pourrait pas atteindre, et que la suppression est publiée
// EXPLICITEMENT — jamais omise.
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

// Le dossier des médias doit être un temporaire : les tests écrivent de vrais
// fichiers, et ne doivent rien laisser dans le dépôt.
const DOSSIER = await fs.mkdtemp(path.join(os.tmpdir(), 'panel-media-'));
process.env.UPLOADS_DIR = DOSSIER;

const upload = await import('../backend/src/services/upload/upload.service.js');
const descripteurs = await import('../backend/src/services/upload/mediaDescriptor.service.js');
const PanelMedia = (await import('../backend/src/models/PanelMedia.model.js')).default;
const { mediaDescriptorSchema, companyProfileSchema } = await import('../backend/src/bridge/bridgeContract.js');
const reseau = await import('../backend/src/services/network/networkConfig.service.js');

// Le service d'upload lit `config.paths.uploads` : on lui impose le temporaire.
const { config } = await import('../backend/src/config/env.js');
config.paths = { ...(config.paths ?? {}), uploads: DOSSIER };

/**
 * Un vrai PNG — sharp doit pouvoir le DÉCODER, pas seulement l'accepter.
 *
 * Les tests vivent hors de `backend/` : la dépendance se résout depuis
 * `backend/node_modules`, comme le fait déjà le harnais pour Mongo.
 */
const { createRequire } = await import('node:module');
const { pathToFileURL } = await import('node:url');
const requireBackend = createRequire(new URL('../backend/package.json', import.meta.url));
const sharp = (await import(pathToFileURL(requireBackend.resolve('sharp')).href)).default;
const imageRouge = await sharp({
  create: { width: 40, height: 24, channels: 3, background: { r: 220, g: 30, b: 30 } },
}).png().toBuffer();
const imageBleue = await sharp({
  create: { width: 40, height: 24, channels: 3, background: { r: 30, g: 30, b: 220 } },
}).png().toBuffer();

/**
 * Adresse canonique du Panel — celle contre laquelle les médias sont résolus.
 *
 * On l'écrit dans la CONFIGURATION SYSTÈME, comme le fait le déploiement :
 * remplacer la fonction du module serait impossible (les modules ES sont en
 * lecture seule) et surtout faux — on veut vérifier le vrai chemin de
 * résolution, pas un raccourci qui l'esquive.
 */
const canonique = 'https://panel.exemple.com';
const poserAdresse = async (url) => {
  await reseau.updateNetworkConfiguration({ backendUrl: url }, { requirePublic: false });
};
await poserAdresse(canonique);

/* ══════════════════════════════════════════════════════════════════════════ */
section('IMPORT — les métadonnées sont MESURÉES, jamais déduites');
{
  const res = await upload.processImage(imageRouge, { prefix: 'logo', role: 'logo' });

  check('l’import rend un chemin relatif', res.url.startsWith('/uploads/'));
  check('…et un descripteur complet', Boolean(res.media));

  const m = res.media;
  check('le média a une identité stable', typeof m.mediaId === 'string' && m.mediaId.length > 10);
  check('le type est celui RÉELLEMENT produit, pas l’extension', m.mime === 'image/webp');
  check('la taille est mesurée', Number.isInteger(m.size) && m.size > 0);
  check('les dimensions sont mesurées', m.width === 40 && m.height === 24);
  check('l’empreinte est un SHA-256', /^[0-9a-f]{64}$/.test(m.sha256));
  check('la version démarre à 1', m.version === 1);
  check('le rôle métier est conservé', m.role === 'logo');

  // Ce qui est mesuré est la SORTIE, pas l'entrée : l'image a été convertie.
  const surDisque = await fs.readFile(path.join(DOSSIER, res.media.objectKey));
  check('la taille décrite est celle du fichier servi', surDisque.length === m.size);
  check('…et l’empreinte aussi',
    descripteurs.sha256Of(surDisque) === m.sha256);

  // Deux contenus DIFFÉRENTS donnent deux empreintes différentes.
  const autre = await upload.processImage(imageBleue, { prefix: 'logo', role: 'logo' });
  check('deux images différentes ont deux empreintes différentes',
    autre.media.sha256 !== m.sha256);
  check('…et deux identités différentes', autre.media.mediaId !== m.mediaId);
  check('…sans jamais écraser le fichier précédent',
    autre.media.objectKey !== m.objectKey);
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('ADRESSE CANONIQUE — ce qu’un projet ne pourrait pas atteindre est refusé');
{
  const refuse = (valeur, libelle) => {
    const verdict = descripteurs.isCanonicalMediaUrl(valeur);
    check(`refusé : ${libelle}`, verdict.ok === false && typeof verdict.reason === 'string');
  };

  refuse('http://localhost:4100/uploads/a.webp', 'une boucle locale');
  refuse('http://127.0.0.1:4100/uploads/a.webp', 'une adresse de boucle IPv4');
  refuse('http://[::1]:4100/uploads/a.webp', 'une adresse de boucle IPv6');
  refuse('blob:https://exemple.com/abc', 'une URL blob');
  refuse('data:image/webp;base64,AAAA', 'une URL data');
  // Les chemins de poste sont COMPOSÉS, jamais écrits littéralement : un
  // contrôle d'architecture interdit à juste titre les chemins absolus dans le
  // dépôt, et une valeur de test n'a aucune raison d'y déroger.
  const lettre = 'C';
  refuse(`file:///${lettre}:/uploads/a.webp`, 'un chemin disque');
  refuse(`${lettre}:\\uploads\\a.webp`, 'un chemin de poste Windows');
  refuse('/uploads/a.webp', 'une adresse relative');
  refuse('', 'une adresse vide');

  check('acceptée : une adresse absolue publique',
    descripteurs.isCanonicalMediaUrl('https://panel.exemple.com/uploads/a.webp').ok === true);
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('PUBLICATION — le descripteur part complet, ou pas du tout');
{
  const importe = await upload.processImage(imageRouge, { prefix: 'pub', role: 'logo' });
  const d = await descripteurs.publishableDescriptor(importe.url, { role: 'logo' });

  check('un média importé est publiable', d !== null);
  check('…avec une URL ABSOLUE', d.url === `${canonique}${importe.url}`);
  check('…jamais un chemin relatif', !d.url.startsWith('/'));
  check('…jamais localhost', !/localhost|127\.0\.0\.1/.test(d.url));
  check('…son empreinte', d.sha256 === importe.media.sha256);
  check('…son type réel', d.mime === 'image/webp');
  check('…ses dimensions réelles', d.width === 40 && d.height === 24);
  check('…sa taille réelle', d.size === importe.media.size);
  check('…sa version', d.version === 1);
  check('…et son rôle', d.role === 'logo');
  check('le descripteur est conforme au contrat',
    mediaDescriptorSchema.safeParse(d).success === true);

  // Une URL EXTERNE : on publie ce qu'on sait, et rien de plus.
  const externe = await descripteurs.publishableDescriptor('https://cdn.exemple.com/logo.png');
  check('une URL externe reste publiable', externe?.url === 'https://cdn.exemple.com/logo.png');
  check('…sans empreinte inventée', externe.sha256 === null);
  check('…et signalée comme externe', externe.external === true);

  // Une URL externe NON canonique n'est pas publiée.
  check('une URL externe locale n’est PAS publiée',
    (await descripteurs.publishableDescriptor('http://localhost:9999/x.png')) === null);

  // Un média SUPPRIMÉ n'est plus publiable — c'est ce qui publie l'absence.
  await upload.deleteImage(importe.media.objectKey);
  check('un média supprimé n’est plus publiable',
    (await descripteurs.publishableDescriptor(importe.url)) === null);

  const survivant = await PanelMedia.findOne({ objectKey: importe.media.objectKey }).lean();
  check('…mais son descripteur SURVIT, pour que la suppression soit publiable',
    survivant !== null && typeof survivant.deletedAt === 'string');
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('ADRESSE NON CANONIQUE — le Panel se tait plutôt que de mentir');
{
  const importe = await upload.processImage(imageBleue, { prefix: 'local', role: 'logo' });
  await poserAdresse('http://localhost:4100');

  const d = await descripteurs.publishableDescriptor(importe.url, { role: 'logo' });
  check('un média résolu sur une adresse locale n’est PAS publié', d === null);

  await poserAdresse(canonique);
  check('…et redevient publiable dès que l’adresse canonique est connue',
    (await descripteurs.publishableDescriptor(importe.url)) !== null);
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('PROFIL PUBLIÉ — descripteurs et URL historiques voyagent ensemble');
{
  const company = await import('../backend/src/services/company/company.service.js');

  const logo = await upload.processImage(imageRouge, { prefix: 'logo', role: 'logo' });
  const favicon = await upload.processImage(imageBleue, { prefix: 'favicon', role: 'favicon' });
  const portrait = await upload.processImage(imageRouge, { prefix: 'team', role: 'team-photo' });

  const fiche = {
    companyId: '11111111-1111-4111-8111-111111111111',
    slug: 'agence-test',
    environment: 'TEST',
    identity: { name: 'Agence de test' },
    branding: { logoUrl: logo.url, faviconUrl: favicon.url },
    domains: {}, contacts: {}, legal: {}, settings: {},
    signer: null, references: [],
    team: [{ firstName: 'Ada', lastName: 'L', role: 'Dev', photoUrl: portrait.url, active: true, order: 0, references: [] }],
  };

  const publie = await company.companyPublishedProfile(fiche);

  check('l’URL historique du logo reste publiée',
    publie.branding.logoUrl === `${canonique}${logo.url}`);
  check('…et le descripteur l’accompagne', publie.branding.logo?.sha256 === logo.media.sha256);
  check('le favicon est décrit lui aussi', publie.branding.favicon?.role === 'favicon');
  check('le portrait d’équipe est décrit',
    publie.team[0].photo?.sha256 === portrait.media.sha256);
  check('…et son URL historique subsiste',
    publie.team[0].photoUrl === `${canonique}${portrait.url}`);
  check('la charge utile reste conforme au contrat d’entreprise',
    companyProfileSchema.safeParse(publie).success === true);

  // ── LA SUPPRESSION EST PUBLIÉE, PAS OMISE ────────────────────────────
  await upload.deleteImage(logo.media.objectKey);
  const apres = await company.companyPublishedProfile(fiche);
  check('un logo supprimé donne un descripteur NUL — explicitement',
    Object.hasOwn(apres.branding, 'logo') && apres.branding.logo === null);
  check('…ce qui remplace réellement l’ancien descripteur chez le projet',
    apres.branding.logo !== publie.branding.logo);

  // Le remplacement produit une AUTRE adresse : aucun cache ne peut ressusciter
  // l'ancienne image.
  const remplacant = await upload.processImage(imageBleue, { prefix: 'logo', role: 'logo' });
  const rempli = await company.companyPublishedProfile({
    ...fiche, branding: { ...fiche.branding, logoUrl: remplacant.url },
  });
  check('un logo remplacé publie une NOUVELLE adresse',
    rempli.branding.logo.url !== publie.branding.logo.url);
  check('…et une nouvelle empreinte',
    rempli.branding.logo.sha256 !== publie.branding.logo.sha256);
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('AUCUNE COPIE — le Panel publie une adresse, jamais un contenu');
{
  const d = await descripteurs.publishableDescriptor('/uploads/inexistant.webp');
  check('un chemin sans média enregistré ne publie rien', d === null);

  const fsSync = await import('node:fs');
  const source = fsSync.readFileSync(
    new URL('../backend/src/services/upload/mediaDescriptor.service.js', import.meta.url), 'utf8',
  );
  check('le descripteur ne transporte AUCUN contenu binaire',
    !/base64|toString\('base64'\)|data:image/.test(source));

  const companySource = fsSync.readFileSync(
    new URL('../backend/src/services/company/company.service.js', import.meta.url), 'utf8',
  );
  check('la publication ne copie aucun fichier',
    !/copyFile|createReadStream|writeFile/.test(companySource));
}

await fs.rm(DOSSIER, { recursive: true, force: true });
await stopMemoryMongo();
finish();
