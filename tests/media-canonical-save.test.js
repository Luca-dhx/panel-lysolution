// IMPORT D'UN MÉDIA PUIS ENREGISTREMENT DE LA FICHE — la chaîne complète.
//
// ══ LE DÉFAUT CORRIGÉ ═══════════════════════════════════════════════════════
//
// L'import rendait un chemin RELATIF (`/uploads/<clé>.webp`). L'écran le
// recopiait tel quel dans la fiche d'entreprise, et l'enregistrement échouait :
// la validation exige une URL ABSOLUE en https, et `new URL('/uploads/x')` ne
// s'analyse pas.
//
// L'import réussissait donc, la persistance non — et le refus parlait de
// `branding.logoUrl`, un champ que l'utilisateur n'avait jamais saisi. Rien ne
// reliait la cause à l'effet.
//
// ══ CE QUI EST PROUVÉ ICI ══════════════════════════════════════════════════
//
//  · l'import rend l'adresse CANONIQUE en plus du chemin de stockage ;
//  · cette adresse passe la validation, telle quelle, sans l'assouplir ;
//  · le chemin relatif, lui, est toujours REFUSÉ — la validation n'a pas bougé ;
//  · la même adresse est enregistrée que le Panel serve en local ou déployé ;
//  · un média du Panel reste reconnu comme tel, avec toutes ses métadonnées,
//    même désigné par son URL absolue.
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

const DOSSIER = await fs.mkdtemp(path.join(os.tmpdir(), 'panel-canonique-'));
const { config } = await import('../backend/src/config/env.js');
config.paths = { ...(config.paths ?? {}), uploads: DOSSIER };

const upload = await import('../backend/src/services/upload/upload.service.js');
const descripteurs = await import('../backend/src/services/upload/mediaDescriptor.service.js');
const reseau = await import('../backend/src/services/network/networkConfig.service.js');
const { validateCompanyInput } = await import('../backend/src/services/company/company.validation.js');
const company = await import('../backend/src/services/company/company.service.js');
const PanelCompany = (await import('../backend/src/models/PanelCompany.model.js')).default;

const { createRequire } = await import('node:module');
const { pathToFileURL } = await import('node:url');
const requireBackend = createRequire(new URL('../backend/package.json', import.meta.url));
const sharp = (await import(pathToFileURL(requireBackend.resolve('sharp')).href)).default;

const image = async (r, g, b) => sharp({
  create: { width: 40, height: 24, channels: 3, background: { r, g, b } },
}).png().toBuffer();

/** L'adresse publique du Panel, telle que le déploiement l'écrit. */
const poserAdresse = (url) =>
  reseau.updateNetworkConfiguration({ backendUrl: url }, { requirePublic: false });

const CANONIQUE = 'https://api.panel.ly-solution.com';

/* ══════════════════════════════════════════════════════════════════════════ */
section('LA VALIDATION N’A PAS BOUGÉ — elle refuse toujours le relatif');
{
  const refuse = (valeur) => {
    const res = validateCompanyInput({
      slug: 'agence', environment: 'TEST',
      identity: { name: 'Agence' },
      branding: { logoUrl: valeur },
    });
    return res.ok === false || res.valid === false || Boolean(res.errors?.length);
  };

  check('un chemin relatif est REFUSÉ', refuse('/uploads/abc-123456789012.webp'));
  check('une valeur sans schéma est REFUSÉE', refuse('api.panel.ly-solution.com/uploads/x.webp'));
  check('une URL http distante est REFUSÉE', refuse('http://panel.ly-solution.com/uploads/x.webp'));
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('IMPORT — l’adresse canonique accompagne le chemin de stockage');
{
  await poserAdresse(CANONIQUE);
  const res = await upload.processImage(await image(220, 30, 30), { role: 'logo' });

  check('le chemin de stockage reste RELATIF', res.url.startsWith('/uploads/'));
  check('…et l’adresse canonique est ABSOLUE',
    res.canonicalUrl === `${CANONIQUE}${res.url}`);
  check('…en https', res.canonicalUrl.startsWith('https://'));
  check('…sans localhost', !/localhost|127\.0\.0\.1/.test(res.canonicalUrl));

  // CE QUE L'ÉCRAN ENREGISTRE PASSE LA VALIDATION, telle qu'elle est.
  const valide = validateCompanyInput({
    slug: 'agence', environment: 'TEST',
    identity: { name: 'Agence' },
    branding: { logoUrl: res.canonicalUrl },
  });
  check('l’adresse canonique passe la validation de la fiche',
    (valide.ok ?? valide.valid ?? true) !== false && !(valide.errors?.length));

  // …et le chemin relatif, lui, ne passe toujours pas.
  const invalide = validateCompanyInput({
    slug: 'agence', environment: 'TEST',
    identity: { name: 'Agence' },
    branding: { logoUrl: res.url },
  });
  check('…là où le chemin relatif est refusé',
    (invalide.ok === false) || (invalide.valid === false) || Boolean(invalide.errors?.length));

  // Un réimport du MÊME fichier rend aussi l'adresse canonique.
  const encore = await upload.processImage(await image(220, 30, 30), { role: 'logo' });
  check('un réimport dédupliqué rend lui aussi l’adresse canonique',
    encore.deduplicated === true && encore.canonicalUrl === res.canonicalUrl);
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('LOCAL ET DÉPLOYÉ — la même adresse est enregistrée');
{
  /**
   * L'autorité média est UNIQUE : un Panel local relaie l'import au Panel
   * déployé, qui répond avec SON adresse canonique. Des deux côtés, la fiche
   * reçoit donc la même valeur — ce qui se vérifie ici en résolvant contre la
   * même adresse canonique, comme le fait le relais.
   */
  await poserAdresse(CANONIQUE);
  const depuisDeploye = await upload.processImage(await image(30, 30, 220), { role: 'logo' });

  const depuisLocal = await descripteurs.publishableDescriptor(depuisDeploye.url, { role: 'logo' });
  check('l’adresse est identique quelle que soit l’instance qui sert',
    depuisLocal.url === depuisDeploye.canonicalUrl);
  check('…et ne porte jamais l’adresse du poste',
    !/localhost|127\.0\.0\.1/.test(depuisLocal.url));
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('UN MÉDIA DU PANEL RESTE RECONNU, même désigné en absolu');
{
  await poserAdresse(CANONIQUE);
  const importe = await upload.processImage(await image(10, 190, 10), { role: 'logo' });

  // C'est la valeur que la fiche porte désormais : l'URL absolue.
  const d = await descripteurs.publishableDescriptor(importe.canonicalUrl, { role: 'logo' });
  check('le descripteur est produit depuis l’URL absolue', d !== null);
  check('…et ce n’est PAS un média « externe »', d.external === false);
  check('…il porte son identité', d.mediaId === importe.media.mediaId);
  check('…son empreinte', d.sha256 === importe.media.sha256);
  check('…son type réel', d.mime === 'image/webp');
  check('…et ses dimensions', d.width === 40 && d.height === 24);

  check('la clé d’objet se lit dans une URL absolue',
    descripteurs.objectKeyOf(importe.canonicalUrl) === importe.filename);
  check('…comme dans un chemin relatif',
    descripteurs.objectKeyOf(importe.url) === importe.filename);
  check('…une URL étrangère ne donne aucune clé',
    descripteurs.objectKeyOf('https://cdn.exemple.com/logo.png') === null);
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('ENREGISTREMENT RÉEL — la fiche accepte ce que l’import a rendu');
{
  await PanelCompany.deleteMany({});
  await poserAdresse(CANONIQUE);

  const logo = await upload.processImage(await image(120, 120, 200), { role: 'logo' });
  const fiche = await company.createCompany({
    slug: 'ly-solution', environment: 'TEST',
    identity: { name: 'L.Y Solution' },
    branding: { logoUrl: logo.canonicalUrl },
  }, { userId: 'u-1' });

  check('la fiche s’enregistre avec l’adresse importée',
    fiche.branding.logoUrl === logo.canonicalUrl);

  const enBase = await PanelCompany.findOne({ companyId: fiche.companyId }).lean();
  check('…et c’est bien cette valeur qui est en base',
    enBase.branding.logoUrl === logo.canonicalUrl);
  check('AUCUN chemin relatif n’est persisté',
    !enBase.branding.logoUrl.startsWith('/uploads/'));
  check('AUCUN localhost n’est persisté',
    !/localhost|127\.0\.0\.1/.test(enBase.branding.logoUrl));

  // La publication continue de produire un descripteur COMPLET.
  const publie = await company.companyPublishedProfile(enBase);
  check('la publication garde l’adresse canonique',
    publie.branding.logoUrl === logo.canonicalUrl);
  check('…avec son descripteur complet',
    publie.branding.logo?.sha256 === logo.media.sha256);
  check('…reconnu comme média du Panel, pas comme URL externe',
    publie.branding.logo.external === false);
}

await fs.rm(DOSSIER, { recursive: true, force: true });
await stopMemoryMongo();
finish();
