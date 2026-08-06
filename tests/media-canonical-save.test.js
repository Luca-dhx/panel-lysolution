// MÉDIAS DU PANEL PAR ENVIRONNEMENT — import, enregistrement, publication.
//
// ══ LE DÉFAUT CORRIGÉ ═══════════════════════════════════════════════════════
//
// Une première correction avait fait de l'URL ABSOLUE l'identité d'un média :
// la fiche la stockait, et l'enregistrement était REFUSÉ tant qu'aucune adresse
// publique n'existait. Conséquence directe, constatée : sur un poste en
// ENV=TEST, l'import du logo réussissait mais la sauvegarde échouait avec
// « Le Panel ne connaît pas encore son adresse publique ». Un Panel de recette
// devenait impossible à configurer AVANT sa première mise en ligne — c'est-à-
// dire au seul moment où on le configure.
//
// ══ LE MODÈLE DE VÉRITÉ ═════════════════════════════════════════════════════
//
// L'identité d'un média est son DESCRIPTEUR : clé d'objet, empreinte,
// environnement, type, dimensions. L'URL en est DÉRIVÉE à la lecture, contre la
// destination ACTIVE du moment. Une fiche n'a donc jamais à être réécrite — ni
// au premier déploiement, ni lors d'un changement de domaine.
//
// ══ CE QUI EST PROUVÉ ICI ═══════════════════════════════════════════════════
//
//  1. TEST local sans destination → import ET enregistrement réussissent ;
//  2. l'aperçu local fonctionne, en `/uploads/…` ;
//  3. aucune URL canonique n'est exigée pour enregistrer ;
//  4. une destination TEST ACTIVE → l'URL https absolue est résolue ;
//  5. PROD reste étanche de TEST ;
//  6. une destination RETIRÉE n'est jamais utilisée ;
//  7. aucune adresse locale ne part vers un projet via le Bridge ;
//  8. l'ancien format `logoUrl` seul reste lisible et publiable ;
//  9. la validation refuse toujours ce qu'elle refusait — elle n'est pas
//     assouplie sur les URL absolues.
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

const DOSSIER = await fs.mkdtemp(path.join(os.tmpdir(), 'panel-medias-'));
const { config } = await import('../backend/src/config/env.js');
config.paths = { ...(config.paths ?? {}), uploads: DOSSIER };

const upload = await import('../backend/src/services/upload/upload.service.js');
const descripteurs = await import('../backend/src/services/upload/mediaDescriptor.service.js');
const { validateCompanyInput } = await import('../backend/src/services/company/company.validation.js');
const company = await import('../backend/src/services/company/company.service.js');
const PanelCompany = (await import('../backend/src/models/PanelCompany.model.js')).default;
const PanelMedia = (await import('../backend/src/models/PanelMedia.model.js')).default;
const PanelDeploymentTarget = (await import('../backend/src/models/PanelDeploymentTarget.model.js')).default;

const { createRequire } = await import('node:module');
const { pathToFileURL } = await import('node:url');
const requireBackend = createRequire(new URL('../backend/package.json', import.meta.url));
const sharp = (await import(pathToFileURL(requireBackend.resolve('sharp')).href)).default;

const image = async (r, g, b) => sharp({
  create: { width: 40, height: 24, channels: 3, background: { r, g, b } },
}).png().toBuffer();

const HOTE_TEST = 'https://recette.panel.ly-solution.com';
const HOTE_PROD = 'https://panel.ly-solution.com';

/** Une destination du Panel, telle que le cycle de vie l'enregistre. */
let compteurHote = 0;
const poserDestination = async ({ environment, url, lifecycleStatus = 'ACTIVE', state = 'DEPLOYED' }) => {
  compteurHote += 1;
  const at = new Date().toISOString();
  return PanelDeploymentTarget.create({
    targetId: `t-${environment}-${compteurHote}`,
    name: `Panel ${environment}`,
    url,
    // L'hôte est unique parmi les destinations non supprimées : chaque appel
    // en pose donc un distinct, sinon l'index partiel refuserait l'écriture.
    host: `h-${compteurHote}.exemple`,
    type: 'subdomain',
    backendPort: 5100 + compteurHote,
    environment,
    lifecycleStatus,
    state,
    lastDeployedAt: at,
    createdAt: at,
    updatedAt: at,
  });
};

const sansDestination = () => PanelDeploymentTarget.deleteMany({});

/* ══════════════════════════════════════════════════════════════════════════ */
section('1 · TEST LOCAL SANS DESTINATION — importer ET enregistrer réussissent');
{
  await sansDestination();
  config.env = 'TEST';

  const logo = await upload.processImage(await image(220, 30, 30), { role: 'logo' });

  check('l’import réussit sans aucune destination déployée', Boolean(logo.filename));
  check('le média est estampillé de l’environnement courant', logo.media.environment === 'TEST');
  check('…et déclaré LOCAL_ONLY — un état normal, pas une erreur',
    logo.media.publicationState === 'LOCAL_ONLY');

  // 2 · L'APERÇU LOCAL fonctionne : le Panel sert ses propres médias.
  check('2 · l’aperçu est le chemin de stockage local', logo.publicUrl === `/uploads/${logo.filename}`);
  check('…et le chemin rendu reste relatif', logo.url.startsWith('/uploads/'));

  // 3 · AUCUNE URL CANONIQUE N'EST EXIGÉE pour enregistrer.
  const descripteur = logo.descriptor;
  check('3 · le descripteur porte l’identité du média', descripteur.objectKey === logo.filename);
  check('…son empreinte', descripteur.sha256 === logo.media.sha256);
  check('…son environnement', descripteur.environment === 'TEST');
  check('…ses dimensions', descripteur.width === 40 && descripteur.height === 24);
  check('…et AUCUNE adresse', !('url' in descripteur));

  const valide = validateCompanyInput({
    slug: 'agence', environment: 'TEST',
    identity: { name: 'Agence' },
    branding: { logoUrl: logo.url, logo: descripteur },
  });
  check('la fiche passe la validation SANS adresse publique',
    valide.valid === true && valide.errors.length === 0);

  await PanelCompany.deleteMany({});
  const fiche = await company.createCompany({
    slug: 'ly-solution', environment: 'TEST',
    identity: { name: 'L.Y Solution' },
    branding: { logoUrl: logo.url, logo: descripteur },
  }, { userId: 'u-1' });

  check('…et s’enregistre réellement', fiche.branding.logo?.objectKey === logo.filename);

  const enBase = await PanelCompany.findOne({ companyId: fiche.companyId }).lean();
  check('c’est le DESCRIPTEUR qui est persisté', enBase.branding.logo.sha256 === logo.media.sha256);
  check('AUCUNE adresse absolue n’est persistée dans la fiche',
    !/^https?:\/\//i.test(enBase.branding.logoUrl));
  check('AUCUN localhost n’est persisté', !/localhost|127\.0\.0\.1/.test(enBase.branding.logoUrl ?? ''));

  // 7 · RIEN N'EST PUBLIÉ tant qu'aucune destination ne sert le média.
  const publie = await company.companyPublishedProfile(enBase);
  check('7 · aucune adresse locale ne part vers un projet', publie.branding.logoUrl === null);
  check('…et aucun descripteur publiable n’est produit', publie.branding.logo === null);
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('4 · DESTINATION TEST ACTIVE — l’URL https absolue est résolue');
{
  await sansDestination();
  config.env = 'TEST';
  const logo = await upload.processImage(await image(30, 30, 220), { role: 'logo' });

  const avant = await descripteurs.resolveMediaUrl(logo.media, 'TEST');
  check('sans destination, l’adresse reste locale', avant.absolute === false);
  check('…et le dit', avant.reason === 'LOCAL_SANS_DESTINATION');

  await poserDestination({ environment: 'TEST', url: HOTE_TEST });

  const apres = await descripteurs.resolveMediaUrl(logo.media, 'TEST');
  check('4 · avec une destination ACTIVE, l’adresse devient absolue', apres.absolute === true);
  check('…en https', apres.url.startsWith('https://'));
  check('…sur la destination TEST', apres.url === `${HOTE_TEST}/uploads/${logo.filename}`);
  check('…sans localhost', !/localhost|127\.0\.0\.1/.test(apres.url));

  // LA FICHE N'A PAS BOUGÉ : c'est la résolution qui a changé.
  const d = await descripteurs.publishableDescriptor(logo.url, { role: 'logo' });
  check('le descripteur publiable est produit depuis le chemin stocké', d !== null);
  check('…et ce n’est PAS un média « externe »', d.external === false);
  check('…il porte son identité', d.mediaId === logo.media.mediaId);
  check('…son empreinte', d.sha256 === logo.media.sha256);
  check('…son type réel', d.mime === 'image/webp');
  check('…et ses dimensions', d.width === 40 && d.height === 24);
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('5 · PROD EST ÉTANCHE DE TEST');
{
  await sansDestination();
  config.env = 'TEST';
  const enTest = await upload.processImage(await image(10, 190, 10), { role: 'logo' });

  await poserDestination({ environment: 'PROD', url: HOTE_PROD });

  const croise = await descripteurs.resolveMediaUrl(enTest.media, 'PROD');
  check('5 · un média TEST n’est jamais résolu en PROD', croise.url === null);
  check('…et le refus est nommé', croise.reason === 'ENVIRONNEMENT_DIFFERENT');

  const dansSonMonde = await descripteurs.resolveMediaUrl(enTest.media, 'TEST');
  check('…tandis qu’en TEST, sans destination TEST, il reste local',
    dansSonMonde.absolute === false && dansSonMonde.url.startsWith('/uploads/'));

  // Et l'inverse : un média PROD ne descend pas en TEST.
  config.env = 'PROD';
  const enProd = await upload.processImage(await image(190, 10, 190), { role: 'logo' });
  check('un média importé en PROD est estampillé PROD', enProd.media.environment === 'PROD');
  check('…et résolu sur la destination PROD',
    (await descripteurs.resolveMediaUrl(enProd.media, 'PROD')).url === `${HOTE_PROD}/uploads/${enProd.filename}`);
  check('…jamais sur celle de TEST',
    (await descripteurs.resolveMediaUrl(enProd.media, 'TEST')).url === null);
  config.env = 'TEST';
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('6 · UNE DESTINATION RETIRÉE N’EST JAMAIS UTILISÉE');
{
  await sansDestination();
  config.env = 'TEST';
  const logo = await upload.processImage(await image(90, 90, 90), { role: 'logo' });

  for (const etat of ['DEPROVISIONING', 'EMPTY', 'DELETED', 'DEPROVISION_FAILED']) {
    await sansDestination();
    await poserDestination({ environment: 'TEST', url: HOTE_TEST, lifecycleStatus: etat });
    const r = await descripteurs.resolveMediaUrl(logo.media, 'TEST');
    check(`6 · une destination ${etat} ne sert aucune adresse`, r.absolute === false);
  }

  // Une destination ACTIVE mais pas encore DÉPLOYÉE ne sert rien non plus :
  // l'adresse existe sur le papier, le fichier n'y est pas.
  await sansDestination();
  await poserDestination({ environment: 'TEST', url: HOTE_TEST, state: 'DEPLOYING' });
  check('…ni une destination ACTIVE en cours de déploiement',
    (await descripteurs.resolveMediaUrl(logo.media, 'TEST')).absolute === false);
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('8 · L’ANCIEN FORMAT `logoUrl` SEUL RESTE LISIBLE');
{
  await sansDestination();
  config.env = 'TEST';
  const logo = await upload.processImage(await image(200, 200, 40), { role: 'logo' });
  await poserDestination({ environment: 'TEST', url: HOTE_TEST });

  // Une fiche ANTÉRIEURE au descripteur : elle ne porte qu'une adresse.
  await PanelCompany.deleteMany({});
  const ancienne = await company.createCompany({
    slug: 'heritage', environment: 'TEST',
    identity: { name: 'Héritage' },
    branding: { logoUrl: `${HOTE_TEST}/uploads/${logo.filename}` },
  }, { userId: 'u-1' });

  check('8 · une fiche sans descripteur s’enregistre encore', ancienne.branding.logoUrl !== null);

  const publie = await company.companyPublishedProfile(
    await PanelCompany.findOne({ companyId: ancienne.companyId }).lean(),
  );
  check('…et publie un descripteur COMPLET, reconstruit depuis l’adresse',
    publie.branding.logo?.sha256 === logo.media.sha256);
  check('…reconnu comme média du Panel, pas comme URL externe',
    publie.branding.logo.external === false);
  check('…avec l’adresse résolue contre la destination du moment',
    publie.branding.logoUrl === `${HOTE_TEST}/uploads/${logo.filename}`);

  // La clé d'objet se lit sous ses trois formes.
  check('la clé d’objet se lit dans une URL absolue',
    descripteurs.objectKeyOf(`${HOTE_TEST}/uploads/${logo.filename}`) === logo.filename);
  check('…comme dans un chemin relatif',
    descripteurs.objectKeyOf(logo.url) === logo.filename);
  check('…une URL étrangère ne donne aucune clé',
    descripteurs.objectKeyOf('https://cdn.exemple.com/logo.png') === null);
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('9 · LA VALIDATION N’EST PAS ASSOUPLIE');
{
  const refus = (branding) => {
    const res = validateCompanyInput({
      slug: 'agence', environment: 'TEST',
      identity: { name: 'Agence' },
      branding,
    });
    return res.valid === false && res.errors.length > 0;
  };

  check('une URL http distante est toujours REFUSÉE',
    refus({ logoUrl: 'http://panel.ly-solution.com/uploads/x.webp' }));
  check('une valeur sans schéma est toujours REFUSÉE',
    refus({ logoUrl: 'panel.ly-solution.com/uploads/x.webp' }));
  check('une remontée de répertoire est REFUSÉE',
    refus({ logoUrl: '/uploads/../../etc/passwd' }));
  check('un chemin hors du stockage des médias est REFUSÉ',
    refus({ logoUrl: '/etc/passwd' }));
  check('un descripteur dont la clé contient un séparateur est REFUSÉ',
    refus({ logo: { objectKey: 'a/b.webp' } }));
  check('un descripteur dont l’empreinte n’en est pas une est REFUSÉ',
    refus({ logo: { objectKey: 'a.webp', sha256: 'pas-une-empreinte' } }));

  // CE QUI EST AUTORISÉ, et qui ne l'était plus : le chemin de stockage.
  const local = validateCompanyInput({
    slug: 'agence', environment: 'TEST',
    identity: { name: 'Agence' },
    branding: { logoUrl: '/uploads/abc-123456789012.webp' },
  });
  check('le chemin de stockage local est ACCEPTÉ', local.valid === true);
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('DÉDUPLICATION — le même contenu ne crée jamais un second objet');
{
  await sansDestination();
  config.env = 'TEST';
  const un = await upload.processImage(await image(7, 77, 177), { role: 'logo' });
  const deux = await upload.processImage(await image(7, 77, 177), { role: 'logo' });

  check('un réimport du même contenu rend le média existant', deux.deduplicated === true);
  check('…la même clé d’objet', deux.filename === un.filename);
  check('…et le même descripteur stable', deux.descriptor.sha256 === un.descriptor.sha256);
  check('un seul objet en base',
    (await PanelMedia.countDocuments({ sha256: un.media.sha256, deletedAt: null })) === 1);
}

await fs.rm(DOSSIER, { recursive: true, force: true });
await stopMemoryMongo();
finish();
