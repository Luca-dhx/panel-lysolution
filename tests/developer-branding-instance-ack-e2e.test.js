/**
 * DIFFUSION DU BRANDING — SUIVIE PAR INSTANCE, SUR PREUVE D'APPLICATION.
 *
 * ══ LA RÉSERVE QUE CE FICHIER FERME ═════════════════════════════════════════
 *
 * La correction précédente a supprimé « enregistrez de nouveau », mais l'état
 * de diffusion restait GLOBAL : il ne disait pas QUELLE instance était en
 * retard. Or une fiche du registre est UNE instance — la recette et la
 * production d'un même projet sont deux fiches, deux jetons, deux runtimes.
 * Un seul booléen pour les deux ne peut être qu'à moitié vrai.
 *
 * ══ CE QUI FAIT PREUVE, ET RIEN D'AUTRE ═════════════════════════════════════
 *
 * `appliedConfiguration.companyVersion` : le numéro que le PROJET déclare
 * avoir appliqué. C'est la seule information du registre que le Panel ne peut
 * pas déduire — il sait ce qu'il a émis, pas ce qui a pris effet.
 *
 * Ne comptent PAS comme accusé : une écriture partie, un 200 de transport, un
 * battement sans numéro, un horodatage de tentative. Les tests ci-dessous le
 * vérifient en laissant délibérément une instance sans déclaration.
 */
import {
  check, connectTestDatabase, finish, section, setTestEnv,
  startMemoryMongo, stopMemoryMongo,
} from './helpers/harness.js';

setTestEnv();
await startMemoryMongo();
await connectTestDatabase();

const societe = await import('../backend/src/services/company/company.service.js');
const registre = await import('../backend/src/services/registry/projectRegistry.service.js');
const { registryStore } = await import('../backend/src/services/registry/registryStore.js');
const PanelCompany = (await import('../backend/src/models/PanelCompany.model.js')).default;
const PanelCompanyVersion = (await import('../backend/src/models/PanelCompanyVersion.model.js')).default;
const PanelMedia = (await import('../backend/src/models/PanelMedia.model.js')).default;
const { PanelSyncJournalEntry } = await import('../backend/src/models/PanelSyncState.model.js');

const ACTEUR = { userId: 'u-1', userEmail: 'dev@panel.test' };
const CLE = 'sb-auto';

async function partirDeZero() {
  await PanelCompany.deleteMany({});
  await PanelCompanyVersion.deleteMany({});
  await PanelMedia.deleteMany({});
  await PanelSyncJournalEntry.deleteMany({});
  await registryStore.clear();
  const { companyId } = await societe.createCompany(
    { identity: { name: 'L.Y Solution' }, slug: 'ly-solution' }, ACTEUR,
  );
  return companyId;
}

/** Une INSTANCE appairée — jeton propre, runtime propre, environnement propre. */
async function instance({ id, environment, vivante = true }) {
  const at = new Date().toISOString();
  await registryStore.insert({
    projectId: id,
    projectKey: `${CLE}-${environment.toLowerCase()}`,
    projectKeySource: 'BRIDGE_KEY',
    logicalProjectKey: CLE,
    declaredEnvironment: environment,
    projectName: 'SB Auto',
    createdAt: at, updatedAt: at,
    pairing: {
      status: 'PAIRED', pairingCodeHash: null, pairingCodeExpiresAt: null,
      // Deux instances, deux jetons : jamais le même.
      bridgeTokenHash: `hash-${id}`, bridgeTokenEncrypted: `chiffre-${id}`,
      pairedAt: at, revokedAt: null,
    },
    runtime: {
      environment,
      softwareVersion: '1.0.0', contractVersion: '1.4.0',
      publicBackendUrl: `https://api.${environment.toLowerCase()}.example.com`,
      // Une instance hors ligne n'a plus donné signe de vie depuis longtemps.
      lastHeartbeatAt: vivante
        ? at
        : new Date(Date.now() - 30 * 24 * 3600_000).toISOString(),
      lastHealth: null, bridgeStats: null,
    },
    manifest: null, manifestSource: null,
  });
  return id;
}

/**
 * L'INSTANCE DÉCLARE CE QU'ELLE A APPLIQUÉ.
 *
 * C'est exactement le chemin réel : le projet publie son
 * `appliedConfiguration` dans son identité, et le Panel le relève. On appelle
 * le MÊME service que la découverte — pas un raccourci d'écriture directe.
 */
async function declareApplique(projectId, companyVersion) {
  const record = await registryStore.getById(projectId);
  return registre.recordAppliedConfiguration(record, {
    companyId: 'c-1', companySlug: 'ly-solution',
    companyVersion, companyAppliedAt: new Date().toISOString(),
    integratedApiCount: 0, integratedApiKeys: [],
  });
}

const etatDe = (d, projectId) => d.instances.find((i) => i.projectId === projectId);

/* ══════════════════════════════════════════════════════════════════════════ */
section('SCÉNARIO A — une instance TEST reçoit, applique, et le déclare');
{
  const companyId = await partirDeZero();
  await instance({ id: 'sb-test', environment: 'TEST' });

  await societe.saveCompany(companyId, { identity: { name: 'Agence' } }, ACTEUR);
  const v2 = await societe.saveCompany(companyId, { identity: { name: 'Agence Deux' } }, ACTEUR);
  check('la fiche est en version 2', v2.version === 2);

  // AVANT toute déclaration : le Panel ne SAIT pas — il ne prétend pas.
  let d = await societe.describeCompanyDistribution(await PanelCompany.findOne({ companyId }).lean());
  check('sans déclaration, l’instance n’est PAS déclarée à jour',
    etatDe(d, 'sb-test').state !== 'APPLIED');
  check('…son état est « inconnu », pas « appliqué »',
    etatDe(d, 'sb-test').state === 'UNKNOWN');
  check('…et le global n’est pas à jour', d.global !== 'UP_TO_DATE');

  // L'instance applique et le déclare.
  await declareApplique('sb-test', 2);
  d = await societe.describeCompanyDistribution(await PanelCompany.findOne({ companyId }).lean());

  const test = etatDe(d, 'sb-test');
  check('l’instance est APPLIED sur preuve', test.state === 'APPLIED');
  check('…avec la version attendue', test.expectedVersion === 2);
  check('…et la version appliquée', test.appliedVersion === 2);
  check('…et la date d’application relevée', typeof test.appliedAt === 'string');
  check('…son environnement est nommé', test.environment === 'TEST');
  check('le global est À JOUR', d.global === 'UP_TO_DATE');
  check('…et plus rien n’est à rediffuser', d.pendingProjectIds.length === 0);
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('UNE VERSION EN RETARD N’EST JAMAIS PRISE POUR UNE VERSION APPLIQUÉE');
{
  const companyId = await partirDeZero();
  await instance({ id: 'sb-test', environment: 'TEST' });
  await societe.saveCompany(companyId, { identity: { name: 'Agence Un' } }, ACTEUR);
  await declareApplique('sb-test', 1);

  const v2 = await societe.saveCompany(companyId, { identity: { name: 'Agence Deux' } }, ACTEUR);
  const d = await societe.describeCompanyDistribution(await PanelCompany.findOne({ companyId }).lean());

  check('la fiche est passée en version 2', v2.version === 2);
  check('l’instance déclare encore la 1', etatDe(d, 'sb-test').appliedVersion === 1);
  check('…elle est donc EN ATTENTE, pas à jour', etatDe(d, 'sb-test').state === 'PENDING');
  check('…et elle est visée par une rediffusion',
    d.pendingProjectIds.includes('sb-test'));
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('SCÉNARIO B — TEST + PROD : deux instances, deux états indépendants');
{
  const companyId = await partirDeZero();
  await instance({ id: 'sb-test', environment: 'TEST' });
  await instance({ id: 'sb-prod', environment: 'PROD' });

  for (const n of ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J']) {
    await societe.saveCompany(companyId, { identity: { name: `Agence ${n}` } }, ACTEUR);
  }
  let fiche = await PanelCompany.findOne({ companyId }).lean();
  check('dix enregistrements donnent la version 10', fiche.publishedVersion === 10);

  await declareApplique('sb-test', 10);
  await declareApplique('sb-prod', 10);

  const onze = await societe.saveCompany(companyId, { identity: { name: 'Agence Onze' } }, ACTEUR);
  check('une modification donne la version 11', onze.version === 11);

  /* ── CAS A — les deux acquittent ─────────────────────────────────────── */
  await declareApplique('sb-test', 11);
  await declareApplique('sb-prod', 11);
  let d = await societe.describeCompanyDistribution(await PanelCompany.findOne({ companyId }).lean());
  check('CAS A : les deux instances sont APPLIED',
    etatDe(d, 'sb-test').state === 'APPLIED' && etatDe(d, 'sb-prod').state === 'APPLIED');
  check('CAS A : global À JOUR', d.global === 'UP_TO_DATE');

  /* ── CAS B — PROD reste en arrière ───────────────────────────────────── */
  await declareApplique('sb-prod', 10);
  d = await societe.describeCompanyDistribution(await PanelCompany.findOne({ companyId }).lean());

  check('CAS B : TEST reste APPLIED', etatDe(d, 'sb-test').state === 'APPLIED');
  check('CAS B : PROD est EN ATTENTE', etatDe(d, 'sb-prod').state === 'PENDING');
  check('CAS B : global PARTIEL', d.global === 'PARTIAL');
  check('CAS B : seule PROD est visée',
    d.pendingProjectIds.length === 1 && d.pendingProjectIds[0] === 'sb-prod');

  /* ── LE RETRY CIBLE ──────────────────────────────────────────────────── */
  await PanelSyncJournalEntry.deleteMany({});
  const retry = await societe.republishCurrentConfiguration(companyId);

  check('la rediffusion ne vise qu’une instance', retry.recipients === 1);
  check('…et c’est PROD', retry.targeted.join() === 'sb-prod');
  check('…la version reste 11', retry.version === 11);

  const emises = await PanelSyncJournalEntry.find({}).lean();
  check('UNE seule écriture a été émise', emises.length === 1);
  check('…nominativement adressée à PROD', emises[0].audience === 'sb-prod');
  check('…TEST n’a rien reçu', !emises.some((e) => e.audience === 'sb-test'));
  check('…et la charge utile porte bien la version 11',
    emises[0].change.payload.version === 11);

  /* ── PROD acquitte à son tour ────────────────────────────────────────── */
  await declareApplique('sb-prod', 11);
  d = await societe.describeCompanyDistribution(await PanelCompany.findOne({ companyId }).lean());
  check('après acquittement, global À JOUR', d.global === 'UP_TO_DATE');

  /* ── L'INVARIANT DE VERSION ──────────────────────────────────────────── */
  fiche = await PanelCompany.findOne({ companyId }).lean();
  check('la version n’a pas bougé d’un cran', fiche.publishedVersion === 11);
  check('…et le nombre de versions en base le confirme',
    (await PanelCompanyVersion.countDocuments({ companyId })) === 11);
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('CAS C — une instance NON APPAIRÉE ne met personne en échec');
{
  const companyId = await partirDeZero();
  await instance({ id: 'sb-test', environment: 'TEST' });

  // La production existe au registre mais n'a jamais été reliée.
  const at = new Date().toISOString();
  await registryStore.insert({
    projectId: 'sb-prod', projectKey: `${CLE}-prod`, projectKeySource: 'BRIDGE_KEY',
    logicalProjectKey: CLE, declaredEnvironment: 'PROD', projectName: 'SB Auto',
    createdAt: at, updatedAt: at,
    pairing: {
      status: 'DECLARED', pairingCodeHash: null, pairingCodeExpiresAt: null,
      bridgeTokenHash: null, bridgeTokenEncrypted: null, pairedAt: null, revokedAt: null,
    },
    runtime: {
      environment: null, softwareVersion: null, contractVersion: null,
      publicBackendUrl: null, lastHeartbeatAt: null, lastHealth: null, bridgeStats: null,
    },
    manifest: null, manifestSource: null,
  });

  await societe.saveCompany(companyId, { identity: { name: 'Agence' } }, ACTEUR);
  await declareApplique('sb-test', 1);

  const d = await societe.describeCompanyDistribution(await PanelCompany.findOne({ companyId }).lean());
  check('la production est NON APPAIRÉE', etatDe(d, 'sb-prod').state === 'NOT_PAIRED');
  check('…ce qui n’est PAS un échec : le global reste à jour', d.global === 'UP_TO_DATE');
  check('…et elle n’est jamais visée par une rediffusion',
    !d.pendingProjectIds.includes('sb-prod'));

  const rien = await societe.republishCurrentConfiguration(companyId);
  check('rediffuser quand tout est appliqué n’envoie RIEN',
    rien.recipients === 0 && rien.republished === false);
  check('…et le dit explicitement', rien.reason === 'ALREADY_APPLIED_EVERYWHERE');
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('OFFLINE — reliée, en retard, et plus aucun signe de vie');
{
  const companyId = await partirDeZero();
  await instance({ id: 'sb-test', environment: 'TEST' });
  await instance({ id: 'sb-prod', environment: 'PROD', vivante: false });

  await societe.saveCompany(companyId, { identity: { name: 'Agence Un' } }, ACTEUR);
  await declareApplique('sb-test', 1);
  await declareApplique('sb-prod', 1);
  await societe.saveCompany(companyId, { identity: { name: 'Agence Deux' } }, ACTEUR);
  // TEST est vivante : elle applique et le declare. PROD, muette, reste en 1.
  await declareApplique('sb-test', 2);

  let d = await societe.describeCompanyDistribution(await PanelCompany.findOne({ companyId }).lean());
  const prod = etatDe(d, 'sb-prod');
  check('une instance muette et en retard est HORS LIGNE', prod.state === 'OFFLINE');
  check('…on conserve la version attendue', prod.expectedVersion === 2);
  check('…ET la version précédemment appliquée', prod.appliedVersion === 1);
  check('…le global est partiel', d.global === 'PARTIAL');

  /**
   * PROD revient : la rediffusion lui envoie la version COURANTE, et rien
   * d'autre. Aucune version nouvelle n'est fabriquée par ce retour.
   */
  const avant = await PanelCompanyVersion.countDocuments({ companyId });
  await societe.republishCurrentConfiguration(companyId);
  await declareApplique('sb-prod', 2);

  d = await societe.describeCompanyDistribution(await PanelCompany.findOne({ companyId }).lean());
  check('après son retour, PROD est APPLIED', etatDe(d, 'sb-prod').state === 'APPLIED');
  check('…le global redevient à jour', d.global === 'UP_TO_DATE');
  check('…et AUCUNE version n’a été créée entre-temps',
    (await PanelCompanyVersion.countDocuments({ companyId })) === avant);
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('L’INVARIANT DE VERSION — trois rediffusions, zéro incrément');
{
  const companyId = await partirDeZero();
  await instance({ id: 'sb-test', environment: 'TEST' });
  await societe.saveCompany(companyId, { identity: { name: 'Agence Un' } }, ACTEUR);
  const v3 = await societe.saveCompany(companyId, { identity: { name: 'Agence Deux' } }, ACTEUR);
  check('la fiche est en version 2', v3.version === 2);

  // L'instance ne déclare rien : elle reste en retard, donc visée.
  const r1 = await societe.republishCurrentConfiguration(companyId);
  const r2 = await societe.republishCurrentConfiguration(companyId);
  const r3 = await societe.republishCurrentConfiguration(companyId);

  check('les trois rediffusions renvoient la même version',
    r1.version === 2 && r2.version === 2 && r3.version === 2);
  check('…le compteur de versions ne bouge pas',
    (await PanelCompanyVersion.countDocuments({ companyId })) === 2);
  check('…la fiche non plus',
    (await PanelCompany.findOne({ companyId }).lean()).publishedVersion === 2);
  check('…et aucun média n’a été recréé',
    (await PanelMedia.countDocuments({})) === 0);
}

await stopMemoryMongo();
finish();
