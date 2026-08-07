/**
 * DIFFUSION DU BRANDING DÉVELOPPEUR — enregistrer n'est pas diffuser.
 *
 * ══ L'INCIDENT REPRODUIT ════════════════════════════════════════════════════
 *
 * Dans « Mon entreprise », remplacer le logo puis cliquer sur « Enregistrer »
 * faisait apparaître :
 *
 *   « La dernière diffusion n'a pas abouti. Les projets appliquent encore la
 *     version 2. Enregistrez de nouveau pour les mettre à jour. »
 *
 * Enregistrer de nouveau reproduisait exactement le même écran. Le seul geste
 * proposé était le seul qui ne pouvait pas aider.
 *
 * ══ LA CAUSE, ET ELLE N'A RIEN D'UN HASARD ══════════════════════════════════
 *
 * `companyPublishedProfile` ne publie un média que s'il est SERVI par une
 * destination active — sinon `publishableDescriptor` rend `null`, à juste
 * titre : `/uploads/…` ne signifie rien depuis le serveur d'un client.
 *
 * Sur une instance sans destination active — un Panel de développement, ou un
 * Panel jamais déployé — TOUS les médias de marque valent donc `null` dans la
 * charge utile publiée. Deux logos DIFFÉRENTS produisent alors une charge
 * utile IDENTIQUE :
 *
 *   payload(logo A) === payload(logo B)   →   diff vide
 *                                         →   NOTHING_TO_PUBLISH
 *                                         →   published: false
 *
 * Et comme `updateCompany` a déjà avancé `updatedAt` sans que `publishedAt`
 * bouge, la fiche se déclarait éternellement « non publiée » :
 *
 *   hasUnpublishedChanges = updatedAt > publishedAt
 *
 * Ce calcul compare une date de SAUVEGARDE LOCALE à une date de PUBLICATION.
 * Ce sont deux concepts différents ; leur différence ne dit rien de ce que les
 * projets ont reçu.
 */
import {
  check, connectTestDatabase, finish, section, setTestEnv,
  startMemoryMongo, stopMemoryMongo,
} from './helpers/harness.js';

setTestEnv();
await startMemoryMongo();
await connectTestDatabase();

const societe = await import('../backend/src/services/company/company.service.js');
const PanelCompany = (await import('../backend/src/models/PanelCompany.model.js')).default;
const PanelCompanyVersion = (await import('../backend/src/models/PanelCompanyVersion.model.js')).default;
const PanelMedia = (await import('../backend/src/models/PanelMedia.model.js')).default;
const { registryStore } = await import('../backend/src/services/registry/registryStore.js');

const ACTEUR = { userId: 'u-1', userEmail: 'dev@panel.test' };

/** Un média de marque tel que l'import du Panel le crée. */
async function media(objectKey, sha) {
  const at = new Date().toISOString();
  await PanelMedia.create({
    mediaId: `id-${objectKey}`,
    environment: 'TEST',
    publicationState: 'LOCAL_ONLY',
    objectKey,
    path: `/uploads/${objectKey}`,
    mime: 'image/webp',
    size: 1234,
    width: 200, height: 80,
    sha256: sha,
    version: 1,
    scope: 'DEVELOPER_IDENTITY',
    role: 'logo',
    createdAt: at, updatedAt: at,
  });
  return { objectKey, mediaId: `id-${objectKey}`, sha256: sha };
}

async function ficheNeuve() {
  await PanelCompany.deleteMany({});
  await PanelCompanyVersion.deleteMany({});
  await PanelMedia.deleteMany({});
  await registryStore.clear();
  const { companyId } = await societe.createCompany(
    { identity: { name: 'L.Y Solution' }, slug: 'ly-solution' },
    ACTEUR,
  );
  return companyId;
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('LA CAUSE — sans destination active, deux logos donnent la MÊME charge utile');
{
  const companyId = await ficheNeuve();
  const A = await media('logo-a.webp', 'a'.repeat(64));
  const B = await media('logo-b.webp', 'b'.repeat(64));

  await societe.saveCompany(companyId, { branding: { logo: A } }, ACTEUR);
  const apresA = await PanelCompany.findOne({ companyId }).lean();
  const payloadA = await societe.companyPublishedProfile(apresA);

  await societe.saveCompany(companyId, { branding: { logo: B } }, ACTEUR);
  const apresB = await PanelCompany.findOne({ companyId }).lean();
  const payloadB = await societe.companyPublishedProfile(apresB);

  check('la fiche porte bien DEUX logos différents au fil du temps',
    apresA.branding.logo.objectKey === 'logo-a.webp'
    && apresB.branding.logo.objectKey === 'logo-b.webp');

  /**
   * LE CŒUR DU DÉFAUT : aucune destination active ne sert ces médias, donc
   * aucun descripteur n'est publiable, donc les deux charges utiles sont
   * identiques. C'est un fait du modèle — pas un bug à corriger ici.
   */
  check('aucun descripteur n’est publiable sans destination active',
    payloadA.branding.logo === null && payloadB.branding.logo === null);
  check('…deux logos différents produisent donc une charge utile IDENTIQUE',
    JSON.stringify(payloadA.branding) === JSON.stringify(payloadB.branding));
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('NO_SECOND_SAVE_FOR_COMPANY_PUBLICATION — le bug exact, verrouillé');
{
  const companyId = await ficheNeuve();
  const A = await media('logo-a.webp', 'a'.repeat(64));
  const B = await media('logo-b.webp', 'b'.repeat(64));

  const premier = await societe.saveCompany(companyId, { branding: { logo: A } }, ACTEUR);
  check('le premier enregistrement publie une version', premier.published === true);
  const v1 = premier.version;

  /**
   * ── LE GESTE QUI DÉCLENCHAIT LE BANDEAU ──────────────────────────────────
   * On remplace le logo. La charge utile publiée ne bouge pas (cause
   * ci-dessus), mais la FICHE, elle, a changé.
   */
  const second = await societe.saveCompany(companyId, { branding: { logo: B } }, ACTEUR);

  check('l’enregistrement RÉUSSIT', second.saved === true);
  check('…et ne se présente jamais comme un échec de diffusion',
    second.company.hasUnpublishedChanges === false);
  check('…aucune version n’est inventée pour une charge utile identique',
    second.version === v1);

  /**
   * L'ASSERTION QUI EMPÊCHE LE RETOUR DU BUG.
   *
   * C'est exactement la sortie que l'écran consomme : si
   * `hasUnpublishedChanges` redevenait vrai ici, la bannière « Enregistrez de
   * nouveau » réapparaîtrait, et cliquer de nouveau ne changerait rien.
   */
  const relue = await societe.describeCompany(await PanelCompany.findOne({ companyId }).lean());
  check('la fiche relue ne réclame PAS un second enregistrement',
    relue.hasUnpublishedChanges === false);

  // Et un troisième enregistrement ne crée toujours pas de version fantôme.
  const troisieme = await societe.saveCompany(companyId, { branding: { logo: A } }, ACTEUR);
  check('un enregistrement de plus ne fabrique pas de version supplémentaire',
    troisieme.version === v1);
  check('…et ne rallume pas la bannière',
    troisieme.company.hasUnpublishedChanges === false);
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('UNE VRAIE MODIFICATION MÉTIER CRÉE UNE VERSION — une seule');
{
  const companyId = await ficheNeuve();
  const premier = await societe.saveCompany(companyId, { identity: { name: 'Agence A' } }, ACTEUR);
  check('première publication', premier.published === true && premier.version === 1);

  const second = await societe.saveCompany(companyId, { identity: { name: 'Agence B' } }, ACTEUR);
  check('un changement RÉEL crée la version suivante', second.version === 2);
  check('…une seule fois', (await PanelCompanyVersion.countDocuments({ companyId })) === 2);
  check('…et la fiche est à jour', second.company.hasUnpublishedChanges === false);

  // Ré-enregistrer sans rien changer ne crée pas de version 3.
  const identique = await societe.saveCompany(companyId, { identity: { name: 'Agence B' } }, ACTEUR);
  check('ré-enregistrer à l’identique ne crée aucune version',
    identique.version === 2
    && (await PanelCompanyVersion.countDocuments({ companyId })) === 2);
  check('…et ne se présente pas comme un échec', identique.saved === true);
  check('…ni comme des modifications non diffusées',
    identique.company.hasUnpublishedChanges === false);
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('LA FRAÎCHEUR NE SE DÉDUIT PLUS DE DEUX DATES DE NATURES DIFFÉRENTES');
{
  const companyId = await ficheNeuve();
  await societe.saveCompany(companyId, { identity: { name: 'Agence' } }, ACTEUR);

  /**
   * On simule ce que faisait n'importe quelle écriture technique : avancer
   * `updatedAt` sans toucher au contenu publié. L'ancien calcul en concluait
   * « les projets n'ont pas la dernière version », ce qui est faux.
   */
  await PanelCompany.updateOne(
    { companyId },
    { $set: { updatedAt: new Date(Date.now() + 60_000).toISOString() } },
  );
  const fiche = await PanelCompany.findOne({ companyId }).lean();

  check('une date de sauvegarde plus récente ne vaut PAS une diffusion manquée',
    (await societe.describeCompany(fiche)).hasUnpublishedChanges === false);
  check('…alors que la comparaison naïve, elle, conclurait le contraire',
    fiche.updatedAt > fiche.publishedAt);
}


/* ══════════════════════════════════════════════════════════════════════════ */
section('REDIFFUSION — retransmet N, sans jamais fabriquer N+1');
{
  const companyId = await ficheNeuve();
  await societe.saveCompany(companyId, { identity: { name: 'Agence' } }, ACTEUR);
  const deuxieme = await societe.saveCompany(companyId, { identity: { name: 'Agence Deux' } }, ACTEUR);
  const N = deuxieme.version;
  check('deux enregistrements metier donnent la version 2', N === 2);

  /**
   * On rediffuse trois fois de suite. Chaque appel doit renvoyer LA MEME
   * version : c est tout l interet de separer enregistrer de diffuser.
   */
  const r1 = await societe.republishCurrentConfiguration(companyId);
  const r2 = await societe.republishCurrentConfiguration(companyId);
  const r3 = await societe.republishCurrentConfiguration(companyId);

  check('la rediffusion renvoie la version en vigueur',
    r1.version === N && r2.version === N && r3.version === N);
  check('…et n en cree jamais une autre',
    (await PanelCompanyVersion.countDocuments({ companyId })) === 2);

  const apres = await PanelCompany.findOne({ companyId }).lean();
  check('la fiche reste sur la meme version', apres.publishedVersion === N);
  check('…et son contenu metier n a pas bouge',
    apres.identity.name === 'Agence Deux');
  check('…et elle ne reclame aucun enregistrement',
    (await societe.describeCompanyPublication(apres)).state === 'PUBLISHED');

  /**
   * AUCUN MEDIA N EST RECREE par une rediffusion : elle renvoie la charge
   * utile TELLE QU ELLE A ETE PUBLIEE, elle ne la recalcule pas.
   */
  check('aucun media n est fabrique par une rediffusion',
    (await PanelMedia.countDocuments({})) === 0);
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('L ETAT DE DIFFUSION SE CALCULE, IL NE SE DEVINE PAS');
{
  const companyId = await ficheNeuve();
  const vierge = await PanelCompany.findOne({ companyId }).lean();
  check('une fiche jamais publiee le dit',
    (await societe.describeCompanyPublication(vierge)).state === 'NEVER_PUBLISHED');

  await societe.saveCompany(companyId, { identity: { name: 'Agence' } }, ACTEUR);
  const publiee = await PanelCompany.findOne({ companyId }).lean();
  const etat = await societe.describeCompanyPublication(publiee);
  check('une fiche publiee et inchangee est A JOUR', etat.state === 'PUBLISHED');
  check('…sans ecart en attente', etat.pendingChanges.length === 0);

  /**
   * On modifie la fiche SANS publier : c est le seul vrai cas ou il reste
   * quelque chose a diffuser.
   */
  await societe.updateCompany(companyId, { identity: { name: 'Agence Trois' } }, ACTEUR);
  const modifiee = await PanelCompany.findOne({ companyId }).lean();
  const enAttente = await societe.describeCompanyPublication(modifiee);
  check('une modification non publiee est EN ATTENTE', enAttente.state === 'PENDING');
  check('…et l ecart est nomme', enAttente.pendingChanges.length > 0);
}

await stopMemoryMongo();
finish();
