// PREMIER DÉPLOIEMENT D'UN PANEL DÉJÀ CONFIGURÉ — les médias suivent.
//
// ══ LE DÉFAUT CORRIGÉ ═══════════════════════════════════════════════════════
//
// Un Panel de recette se configure AVANT sa mise en ligne : on y importe le
// logo, les portraits de l'équipe, alors qu'aucune destination ne les sert
// encore. Ces fichiers n'existaient donc que sur le poste. Le jour du premier
// déploiement, le site partait avec des images absentes — et il fallait tout
// réimporter depuis l'interface déployée, geste que rien n'annonçait.
//
// ══ CE QUI EST PROUVÉ ICI ═══════════════════════════════════════════════════
//
//  4. au premier déploiement, les médias locaux sont constatés sur la
//     destination et deviennent publiables — sans aucun réimport ;
//  5. l'empreinte est RELUE sur le serveur : un fichier absent ou divergent
//     n'est jamais déclaré publié ;
//  · l'étape est idempotente, et n'écrase jamais un fichier distant ;
//  · elle est branchée dans le pipeline AVANT la validation finale.
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

const DOSSIER = await fs.mkdtemp(path.join(os.tmpdir(), 'panel-premier-deploiement-'));
const { config } = await import('../backend/src/config/env.js');
config.paths = { ...(config.paths ?? {}), uploads: DOSSIER };
config.env = 'TEST';

const upload = await import('../backend/src/services/upload/upload.service.js');
const descripteurs = await import('../backend/src/services/upload/mediaDescriptor.service.js');
const PanelMedia = (await import('../backend/src/models/PanelMedia.model.js')).default;
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
 * UN SERVEUR DISTANT SIMULÉ — il répond à `sha256sum`, et rien d'autre.
 *
 * C'est exactement ce que l'étape interroge : l'empreinte du fichier tel qu'il
 * se trouve sur la destination. Simuler davantage donnerait l'illusion de
 * vérifier plus, sans rien vérifier de plus.
 */
function serveurAvec(fichiers) {
  const transport = new FakeTransport();
  transport.on(/sha256sum/, {});
  const original = transport.exec.bind(transport);
  transport.exec = async (commande) => {
    const m = /sha256sum (\S+)/.exec(commande);
    if (m) {
      const nom = m[1].split('/').pop();
      return { code: 0, stdout: fichiers.has(nom) ? `${fichiers.get(nom)}\n` : 'ABSENT\n', stderr: '' };
    }
    return original(commande);
  };
  return transport;
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('L’ÉTAPE EST BRANCHÉE DANS LE PIPELINE, AVANT LA VALIDATION');
{
  const iMedia = PIPELINE_STEPS.indexOf('media_publish');
  check('l’étape existe', iMedia >= 0);
  check('…après le démarrage du service', iMedia > PIPELINE_STEPS.indexOf('health'));
  check('…et AVANT la validation finale', iMedia < PIPELINE_STEPS.indexOf('validate'));
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('4 · PREMIER DÉPLOIEMENT — le média local devient publiable');
{
  await PanelMedia.deleteMany({});
  const logo = await upload.processImage(await image(220, 30, 30), { role: 'logo' });

  check('avant déploiement, le média est LOCAL_ONLY', logo.media.publicationState === 'LOCAL_ONLY');
  check('…et son adresse reste locale',
    (await descripteurs.resolveMediaUrl(logo.media, 'TEST')).absolute === false);

  // Le pipeline a déjà transféré le dossier `uploads` : le fichier EST là.
  const transport = serveurAvec(new Map([[logo.filename, logo.media.sha256]]));

  const rapport = await descripteurs.verifyPanelMediaOnDestination({
    transport, sharedUploads: PARTAGE, host: HOTE, environment: 'TEST',
  });

  check('4 · le média est constaté sur la destination', rapport.published === 1);
  check('…aucun manquant', rapport.missing.length === 0);
  check('…aucune divergence', rapport.mismatched.length === 0);

  const apres = await PanelMedia.findOne({ objectKey: logo.filename }).lean();
  check('…il devient PUBLISHED', apres.publicationState === 'PUBLISHED');
  check('…sur l’hôte constaté', apres.publishedHost === HOTE);
  check('…et la date de publication est posée', typeof apres.publishedAt === 'string');

  // 5 · L'EMPREINTE EST LA MÊME — le fichier n'a pas été retouché en chemin.
  check('5 · l’empreinte enregistrée est inchangée', apres.sha256 === logo.media.sha256);
  check('…comme le type réel', apres.mime === 'image/webp');
  check('…et les dimensions', apres.width === 40 && apres.height === 24);

  // AUCUN RÉIMPORT : la fiche n'a pas bougé, seule la résolution change.
  const { PanelDeploymentTarget } = { PanelDeploymentTarget: (await import('../backend/src/models/PanelDeploymentTarget.model.js')).default };
  const at = new Date().toISOString();
  await PanelDeploymentTarget.create({
    targetId: 't-test-1', name: 'Panel TEST', url: `https://${HOTE}`,
    host: HOTE, type: 'subdomain', backendPort: 5101, environment: 'TEST',
    lifecycleStatus: 'ACTIVE', state: 'DEPLOYED', createdAt: at, updatedAt: at, lastDeployedAt: at,
  });

  const resolue = await descripteurs.resolveMediaUrl(apres, 'TEST');
  check('l’adresse devient absolue SANS réimport',
    resolue.url === `https://${HOTE}/uploads/${logo.filename}`);
  check('…et le descripteur publiable est produit',
    (await descripteurs.publishableDescriptor(logo.url, { role: 'logo' }))?.sha256 === logo.media.sha256);

  await PanelDeploymentTarget.deleteMany({});
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('5 · UN FICHIER ABSENT OU DIVERGENT N’EST JAMAIS DÉCLARÉ PUBLIÉ');
{
  await PanelMedia.deleteMany({});
  const absent = await upload.processImage(await image(30, 30, 220), { role: 'logo' });
  const divergent = await upload.processImage(await image(30, 220, 30), { role: 'favicon' });

  const transport = serveurAvec(new Map([
    // Le second est là, mais son contenu n'est pas celui qu'on a mesuré.
    [divergent.filename, 'f'.repeat(64)],
  ]));

  const rapport = await descripteurs.verifyPanelMediaOnDestination({
    transport, sharedUploads: PARTAGE, host: HOTE, environment: 'TEST',
  });

  check('les deux médias sont examinés', rapport.scanned === 2);
  check('aucun n’est publié', rapport.published === 0);
  check('…l’absent est nommé', rapport.missing.includes(absent.filename));
  check('…le divergent aussi', rapport.mismatched.some((m) => m.objectKey === divergent.filename));
  check('…avec l’empreinte attendue et celle trouvée',
    rapport.mismatched[0].expected === divergent.media.sha256
    && rapport.mismatched[0].found === 'f'.repeat(64));

  const etats = await PanelMedia.find({}).lean();
  check('aucun des deux n’a changé d’état',
    etats.every((m) => m.publicationState === 'LOCAL_ONLY'));

  // ON N'ÉCRASE RIEN : deux contenus différents sous une même clé signifient
  // qu'une hypothèse est fausse. La corriger d'office effacerait la trace.
  check('aucune écriture distante n’a été tentée',
    transport.commands.every((c) => !/cp |scp |mv |tee /.test(String(c.command ?? c))));
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('IDEMPOTENCE — relancée, l’étape ne retouche que ce qui reste à faire');
{
  await PanelMedia.deleteMany({});
  const logo = await upload.processImage(await image(120, 120, 200), { role: 'logo' });
  const transport = serveurAvec(new Map([[logo.filename, logo.media.sha256]]));

  const premier = await descripteurs.verifyPanelMediaOnDestination({
    transport, sharedUploads: PARTAGE, host: HOTE, environment: 'TEST',
  });
  const second = await descripteurs.verifyPanelMediaOnDestination({
    transport, sharedUploads: PARTAGE, host: HOTE, environment: 'TEST',
  });

  check('la première passe publie', premier.published === 1);
  check('la seconde ne republie rien', second.published === 0);
  check('…et le constate explicitement', second.alreadyPublished === 1);
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

  const transport = serveurAvec(new Map([
    [enTest.filename, enTest.media.sha256],
    [enProd.filename, enProd.media.sha256],
  ]));

  const rapport = await descripteurs.verifyPanelMediaOnDestination({
    transport, sharedUploads: PARTAGE, host: HOTE, environment: 'TEST',
  });

  check('seuls les médias TEST sont examinés', rapport.scanned === 1);
  check('…et publiés', rapport.published === 1);

  const prod = await PanelMedia.findOne({ objectKey: enProd.filename }).lean();
  check('le média PROD n’est jamais publié par un déploiement TEST',
    prod.publicationState === 'LOCAL_ONLY');
}

await fs.rm(DOSSIER, { recursive: true, force: true });
await stopMemoryMongo();
finish();
