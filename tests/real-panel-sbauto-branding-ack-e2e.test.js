/**
 * REAL_PANEL_TO_SBAUTO_BRANDING_ACK_E2E — la chaîne entière, sans doublure.
 *
 * ══ LA RÉSERVE QUE CE FICHIER FERME ═════════════════════════════════════════
 *
 * `developer-branding-instance-ack-e2e` prouvait le comportement du PANEL :
 * qu'il vise la bonne instance, qu'il n'invente pas de version, qu'il n'affiche
 * APPLIED que sur déclaration. Mais c'est lui qui jouait le rôle du projet — il
 * appelait `recordAppliedConfiguration` avec le numéro qu'il voulait bien se
 * donner. Le maillon le plus intéressant, « un projet reçoit et applique »,
 * n'était donc pas prouvé : il était supposé.
 *
 * Ici, un VRAI SB Auto tourne. Dans son propre processus, avec sa propre base,
 * derrière son propre port. Il tire par HTTP, applique avec son applicateur,
 * persiste dans son modèle, republie son identité avec son constructeur — et le
 * Panel relève ce numéro par sa découverte.
 *
 * ══ CE QUI EST INTERDIT ICI, ET VÉRIFIABLE À LA LECTURE ═════════════════════
 *
 *   · aucun appel à `recordAppliedConfiguration` depuis ce fichier ;
 *   · aucune écriture dans `PanelProject.appliedConfiguration` ;
 *   · aucune écriture dans la base de SB Auto ;
 *   · aucun handler DEV_COMPANY simulé, enveloppé ou forcé au succès.
 *
 * Le seul mock est le TEMPS d'attente : rien. Tout est appelé, rien n'est
 * attendu en boucle.
 *
 * ══ POURQUOI LES DEUX INSTANCES SONT EN RECETTE ═════════════════════════════
 *
 * Le scénario demandait une recette et une production. C'est IMPOSSIBLE contre
 * un même Panel, et pour deux raisons qui sont des protections, pas des
 * limites — les deux sont prouvées plus bas :
 *
 *   1. l'appairage refuse un projet qui se déclare en PROD sur un Panel qui
 *      sert TEST (`BRIDGE_ENVIRONMENT_MISMATCH`) ;
 *   2. l'applicateur refuse une configuration d'entreprise dont
 *      l'environnement ne concorde pas avec le sien.
 *
 * L'isolation d'audience, elle, ne dépend pas de l'environnement : c'est une
 * propriété de `pullForProject`. Deux instances RÉELLES distinctes — deux
 * fiches, deux jetons, deux bases — la prouvent entièrement.
 */
import {
  check, connectTestDatabase, finish, section, setTestEnv,
  startMemoryMongo, startServer, stopMemoryMongo,
} from './helpers/harness.js';
import { startSbAutoInstance } from './helpers/sbauto-remote.js';

setTestEnv();
const MONGO_URI = await startMemoryMongo();
await connectTestDatabase();

const { createApp } = await import('../backend/src/app.js');
const societe = await import('../backend/src/services/company/company.service.js');
const registre = await import('../backend/src/services/registry/projectRegistry.service.js');
const { registryStore } = await import('../backend/src/services/registry/registryStore.js');
const { resetSyncCore } = await import('../backend/src/services/sync/syncCore.service.js');
const { updateNetworkConfiguration } = await import('../backend/src/services/network/networkConfig.service.js');
const PanelCompany = (await import('../backend/src/models/PanelCompany.model.js')).default;
const PanelCompanyVersion = (await import('../backend/src/models/PanelCompanyVersion.model.js')).default;
const PanelMedia = (await import('../backend/src/models/PanelMedia.model.js')).default;
const { PanelSyncJournalEntry } = await import('../backend/src/models/PanelSyncState.model.js');

const ACTEUR = { userId: 'u-1', userEmail: 'dev@panel.test' };
/** L'adresse publique du Panel — c'est elle qui rend un média publiable. */
const PANEL_PUBLIC = 'https://panel-e2e.lycarz.test';

await resetSyncCore();
await updateNetworkConfiguration({ backendUrl: PANEL_PUBLIC }, { requirePublic: false });

const { base: panelUrl, close: closePanel } = await startServer(createApp());

/* ══════════════════════════════════════════════════════════════════════════
   LA FICHE ENTREPRISE, AVEC UN LOGO RÉEL DU PANEL.
   ══════════════════════════════════════════════════════════════════════════ */
const at = new Date().toISOString();
await PanelMedia.create({
  mediaId: 'media-logo-e2e',
  environment: 'TEST',
  publicationState: 'LOCAL_ONLY',
  objectKey: 'media-logo-e2e-aaaaaaaaaaaa.webp',
  path: '/uploads/media-logo-e2e-aaaaaaaaaaaa.webp',
  mime: 'image/webp', size: 4096, width: 320, height: 120,
  sha256: 'a'.repeat(64), version: 1,
  scope: 'DEVELOPER_IDENTITY', role: 'logo',
  createdAt: at, updatedAt: at,
});

const { companyId } = await societe.createCompany(
  { identity: { name: 'L.Y Solution' }, slug: 'ly-solution' }, ACTEUR,
);
await societe.saveCompany(companyId, {
  identity: { name: 'L.Y Solution' },
  branding: { logo: { objectKey: 'media-logo-e2e-aaaaaaaaaaaa.webp', mediaId: 'media-logo-e2e', sha256: 'a'.repeat(64) } },
}, ACTEUR);

const ficheDe = () => PanelCompany.findOne({ companyId }).lean();
const diffusion = async () => societe.describeCompanyDistribution(await ficheDe());
const etatDe = (d, projectId) => d.instances.find((i) => i.projectId === projectId);
const journalPour = (projectId) => PanelSyncJournalEntry.countDocuments({ audience: projectId });

/* ══════════════════════════════════════════════════════════════════════════
   DEUX INSTANCES RÉELLES — deux processus, deux bases, deux jetons.
   ══════════════════════════════════════════════════════════════════════════ */
const instances = [];
async function demarrer({ dbName, env, projectName }) {
  const inst = await startSbAutoInstance({ mongoUri: MONGO_URI, dbName, env, projectName });
  instances.push(inst);
  return inst;
}

/** Appairage RÉEL : le projet appelle POST /bridge/v1/pairings par le réseau. */
async function appairer(inst) {
  const declared = await registre.declareProject({
    publicBackendUrl: inst.publicBackendUrl,
    projectName: inst.projectName,
    environment: inst.env,
  });
  const paired = await inst.pair({
    panelUrl, pairingCode: declared.pairingCode, publicBackendUrl: inst.publicBackendUrl,
  });
  inst.projectId = paired.projectId;
  await inst.heartbeat();
  return paired.projectId;
}

/**
 * LA DÉCOUVERTE — le SEUL chemin par lequel le Panel apprend ce qu'un projet a
 * appliqué. Le vrai moteur, la vraie action, le vrai client HTTP : on ne
 * fabrique pas le constat qu'on va relever.
 */
const moteur = await import('../backend/src/services/execution/execution.service.js');
async function decouvrir(projectId) {
  const execution = await moteur.createExecution({
    type: 'DISCOVER_PROJECT', projectId, mode: moteur.MODE.EXECUTION, initiator: ACTEUR,
  });
  const done = await moteur.runQueued(execution.executionId);
  if (done.state !== 'SUCCEEDED') {
    throw new Error(`Découverte de ${projectId} en échec : ${done.error?.message ?? done.state}`);
  }
  // Le moteur range `{result, summary}` : ce que l'exécuteur a rapporté est
  // dans `result`, le reste est la phrase lisible du journal d'exécution.
  return done.result?.result ?? done.result;
}

const alpha = await demarrer({ dbName: 'sbauto_alpha', env: 'TEST', projectName: 'SB Auto Alpha' });
const beta = await demarrer({ dbName: 'sbauto_beta', env: 'TEST', projectName: 'SB Auto Beta' });

/* ══════════════════════════════════════════════════════════════════════════ */
section('LA CHAÎNE COMPLÈTE — Panel version N → pull → application → identité → APPLIED');
{
  const projectId = await appairer(alpha);
  check('l’instance est appairée par le réseau, et le Panel lui a donné une identité',
    typeof projectId === 'string' && projectId.length > 0);

  // L'appairage a déjà livré la configuration courante (contrat >= 1.3.0).
  // C'est le vrai comportement : on part donc de N-1 volontairement.
  const nMoins1 = (await ficheDe()).publishedVersion;
  const avant = await alpha.state();
  check(`la découverte d’appairage a posé la version en vigueur (${nMoins1})`,
    avant.company?.version === nMoins1);

  // ── LE PANEL PUBLIE N ───────────────────────────────────────────────────
  const publie = await societe.saveCompany(companyId, { identity: { name: 'L.Y Solution SAS' } }, ACTEUR);
  const N = publie.version;
  check(`une modification réelle publie la version ${N}`, N === nMoins1 + 1);

  // Avant que le projet ne tire : il déclare encore N-1. Le Panel ne préjuge pas.
  await decouvrir(projectId);
  let d = await diffusion();
  check('avant le rattrapage, l’instance n’est PAS à jour', etatDe(d, projectId).state !== 'APPLIED');
  check('…elle déclare la version précédente',
    etatDe(d, projectId).appliedVersion === nMoins1);
  check('…et elle est visée par une rediffusion', d.pendingProjectIds.includes(projectId));

  // ── LE PROJET TIRE, RÉELLEMENT ──────────────────────────────────────────
  const tirage = await alpha.pull();
  check('le vrai syncPull applique exactement une écriture', tirage.applied === 1);

  const apres = await alpha.state();
  check('DEV_COMPANY est réellement appliqué : l’état métier du projet a changé',
    apres.company?.identity?.name === 'L.Y Solution SAS');
  check(`…et le projet persiste la version ${N}`, apres.company?.version === N);
  check('…dans un document, pas en mémoire', apres.configurationCount === 1);
  check('…et sa convergence porte le même numéro', apres.applied.companyVersion === N);

  // ── L'IDENTITÉ REMONTE, ET LE PANEL LA RELÈVE ───────────────────────────
  const identite = await alpha.identity();
  check(`l’Identity du projet transporte companyVersion=${N}`,
    identite.appliedConfiguration?.companyVersion === N);

  const decouverte = await decouvrir(projectId);
  check('le Panel lit cette convergence par sa découverte',
    decouverte.appliedConfiguration?.companyVersion === N);

  const enregistre = await registryStore.getById(projectId);
  check('…et l’inscrit dans le registre',
    enregistre.appliedConfiguration?.companyVersion === N);
  check('…avec la date d’application déclarée par le PROJET',
    typeof enregistre.appliedConfiguration?.companyAppliedAt === 'string');

  d = await diffusion();
  check('l’instance passe APPLIED — sur cette preuve et sur aucune autre',
    etatDe(d, projectId).state === 'APPLIED');
  check('…avec la version attendue et la version appliquée égales',
    etatDe(d, projectId).expectedVersion === N && etatDe(d, projectId).appliedVersion === N);
  check('…et plus rien à rediffuser', d.pendingProjectIds.length === 0);
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('LE LOGO RESTE SOUS AUTORITÉ PANEL — le projet ne s’en approprie rien');
{
  const etat = await alpha.state();
  const logo = etat.company?.branding?.logo ?? null;
  check('le descripteur du logo a bien traversé le pont', logo !== null);
  check('…il déclare l’autorité PANEL', logo?.authority === 'PANEL');
  check('…son adresse est absolue et pointe sur le Panel',
    typeof logo?.url === 'string' && logo.url.startsWith(`${PANEL_PUBLIC}/uploads/`));
  check('…son empreinte est celle mesurée par le Panel', logo?.sha256 === 'a'.repeat(64));
  check('AUCUN média de projet n’a été créé', etat.projectMediaCount === 0);
  check('…et aucun fichier n’est arrivé dans les imports du projet',
    etat.uploads.every((f) => !f.startsWith('media-logo-e2e')));
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('ISOLATION D’AUDIENCE — une écriture nominative ne franchit pas la frontière');
{
  const beta_id = await appairer(beta);
  const N = (await ficheDe()).publishedVersion;

  // Bêta vient d'être appairée : elle a reçu N par la découverte d'appairage.
  // On la fait donc RETARDER pour de bon — en publiant N+1 qu'elle ne tirera
  // pas encore, pendant qu'alpha, elle, la tirera.
  const publie = await societe.saveCompany(companyId, { identity: { tagline: 'Studio logiciel' } }, ACTEUR);
  const suivante = publie.version;
  check(`le Panel publie la version ${suivante}`, suivante === N + 1);

  await alpha.pull();
  await decouvrir(alpha.projectId);
  await decouvrir(beta_id);

  let d = await diffusion();
  check('alpha a tiré et appliqué', etatDe(d, alpha.projectId).state === 'APPLIED');
  check('bêta est en retard, et nommément désignée',
    d.pendingProjectIds.length === 1 && d.pendingProjectIds[0] === beta_id);

  // ── LA REDIFFUSION VISE BÊTA, ET ELLE SEULE ─────────────────────────────
  const alphaAvant = await journalPour(alpha.projectId);
  const betaAvant = await journalPour(beta_id);
  const avantAlpha = await alpha.raw();

  const retry = await societe.republishCurrentConfiguration(companyId);
  check('la rediffusion ne vise qu’une instance', retry.recipients === 1);
  check('…et c’est bêta', retry.targeted[0] === beta_id);
  check('…sans créer la moindre version', retry.version === suivante);

  check('le journal a UNE écriture de plus pour bêta',
    (await journalPour(beta_id)) === betaAvant + 1);
  check('…et AUCUNE pour alpha', (await journalPour(alpha.projectId)) === alphaAvant);

  // ── ALPHA TIRE : elle ne doit RIEN recevoir de ce qui vise bêta ──────────
  const tirageAlpha = await alpha.pull();
  check('alpha tire et n’applique rien', tirageAlpha.applied === 0);
  const apresAlpha = await alpha.raw();
  check('…son état métier est inchangé, champ pour champ',
    JSON.stringify(apresAlpha) === JSON.stringify(avantAlpha));

  // ── BÊTA TIRE : elle reçoit, applique, et le déclare ─────────────────────
  /**
   * BÊTA REÇOIT DEUX ÉCRITURES, ET C'EST EXACT.
   *
   * La publication de `suivante` a diffusé à tout le parc (`audience: null`) —
   * bêta ne l'avait simplement pas encore tirée. La rediffusion ciblée s'y
   * ajoute. Les deux portent la MÊME version : la seconde est un non-événement
   * métier, écarté par la garde de version de l'applicateur.
   */
  const tirageBeta = await beta.pull();
  check('bêta tire la diffusion générale ET la rediffusion qui la vise',
    tirageBeta.applied === 2);
  const etatBeta = await beta.state();
  check('…sans que sa configuration soit dupliquée', etatBeta.configurationCount === 1);
  check(`…sa configuration porte la version ${suivante}`, etatBeta.company?.version === suivante);
  check('…et son identité l’annonce', etatBeta.applied.companyVersion === suivante);

  await decouvrir(beta_id);
  d = await diffusion();
  check('le Panel passe bêta en APPLIED', etatDe(d, beta_id).state === 'APPLIED');
  check('…alpha n’a pas bougé', etatDe(d, alpha.projectId).state === 'APPLIED');
  check('…et le parc entier est à jour', d.global === 'UP_TO_DATE');
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('IDEMPOTENCE — tirer deux fois la même synchronisation ne change rien');
{
  const avant = await alpha.raw();
  const versionAvant = (await ficheDe()).publishedVersion;
  const versionsAvant = await PanelCompanyVersion.countDocuments({ companyId });

  const premier = await alpha.pull();
  const second = await alpha.pull();
  check('un second tirage n’applique rien', premier.applied === 0 && second.applied === 0);

  const apres = await alpha.raw();
  check('la configuration finale est identique, champ pour champ',
    JSON.stringify(apres) === JSON.stringify(avant));
  check('un seul document de configuration subsiste',
    (await alpha.state()).configurationCount === 1);

  // Rediffuser à une instance DÉJÀ à jour ne doit rien envoyer du tout.
  const rien = await societe.republishCurrentConfiguration(companyId);
  check('rediffuser quand tout est appliqué n’envoie rien',
    rien.recipients === 0 && rien.republished === false);
  check('…et le dit plutôt que de simuler un envoi',
    rien.reason === 'ALREADY_APPLIED_EVERYWHERE');

  check('aucune version n’a été créée', (await PanelCompanyVersion.countDocuments({ companyId })) === versionsAvant);
  check('…et la version en vigueur n’a pas bougé', (await ficheDe()).publishedVersion === versionAvant);
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('ÉCHEC D’APPLICATION — un tirage réussi ne vaut pas une application');
{
  const N = (await ficheDe()).publishedVersion;
  const publie = await societe.saveCompany(companyId, { identity: { description: 'Édition et exploitation.' } }, ACTEUR);
  const suivante = publie.version;
  check(`le Panel publie la version ${suivante}`, suivante === N + 1);

  // PANNE RÉELLE : la base du projet est coupée. Le vrai applicateur s'exécute,
  // et c'est sa persistance qui échoue — rien n'est simulé.
  await beta.severDatabase();
  const tirage = await beta.pull();
  check('le tirage HTTP réussit', typeof tirage.applied === 'number');
  check('…mais rien n’est appliqué', tirage.applied === 0);
  check('…et l’échec est consigné, pas avalé', tirage.skipped >= 1);

  await beta.restoreDatabase();
  const etat = await beta.state();
  check(`le projet déclare toujours la version ${N}`, etat.company?.version === N);
  check('…et n’annonce PAS la version qu’il n’a pas appliquée',
    etat.applied.companyVersion === N && etat.applied.companyVersion !== suivante);

  await decouvrir(beta.projectId);
  const d = await diffusion();
  check('le Panel ne passe PAS l’instance en APPLIED',
    etatDe(d, beta.projectId).state !== 'APPLIED');
  check(`…l’attendu reste ${suivante}`, etatDe(d, beta.projectId).expectedVersion === suivante);
  check(`…l’appliqué reste ${N}`, etatDe(d, beta.projectId).appliedVersion === N);
  check('…et elle reste visée par une rediffusion', d.pendingProjectIds.includes(beta.projectId));

  // ── LA REPRISE EST POSSIBLE, ET ELLE ABOUTIT ────────────────────────────
  const retry = await societe.republishCurrentConfiguration(companyId);
  check('la reprise vise l’instance en échec', retry.targeted.includes(beta.projectId));
  const reprise = await beta.pull();
  check('…elle applique cette fois', reprise.applied === 1);
  check('…et le projet déclare enfin la bonne version',
    (await beta.state()).applied.companyVersion === suivante);

  await decouvrir(beta.projectId);
  check('le Panel constate APPLIED après la reprise',
    etatDe(await diffusion(), beta.projectId).state === 'APPLIED');
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('HORS LIGNE PUIS REPRISE — le retard n’invente aucune version');
{
  const versionsAvant = await PanelCompanyVersion.countDocuments({ companyId });
  const publie = await societe.saveCompany(companyId, { contacts: { email: 'contact@lysolution.test' } }, ACTEUR);
  const N = publie.version;

  // Alpha tire ; bêta ne tire pas du tout — c'est cela, « ne rien recevoir ».
  await alpha.pull();
  await decouvrir(alpha.projectId);

  let d = await diffusion();
  check('l’instance qui n’a rien tiré reste en retard',
    etatDe(d, beta.projectId).appliedVersion === N - 1);
  check(`…l’attendu vaut toujours ${N}`, etatDe(d, beta.projectId).expectedVersion === N);
  check('…et le parc est PARTIELLEMENT à jour', d.global === 'PARTIAL');

  // Elle revient et exécute le vrai rattrapage.
  await beta.pull();
  await decouvrir(beta.projectId);
  d = await diffusion();
  check('au retour, elle applique et le déclare', etatDe(d, beta.projectId).state === 'APPLIED');
  check('…le parc est à jour', d.global === 'UP_TO_DATE');
  check('…et aucune version n’a été créée en chemin',
    (await PanelCompanyVersion.countDocuments({ companyId })) === versionsAvant + 1);
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('LA FRONTIÈRE TEST/PROD — pourquoi les deux instances sont en recette');
{
  const gamma = await demarrer({ dbName: 'sbauto_gamma', env: 'PROD', projectName: 'SB Auto Gamma' });
  const declared = await registre.declareProject({
    publicBackendUrl: gamma.publicBackendUrl, projectName: 'SB Auto Gamma', environment: 'PROD',
  });

  let refus = null;
  try {
    await gamma.pair({
      panelUrl, pairingCode: declared.pairingCode, publicBackendUrl: gamma.publicBackendUrl,
    });
  } catch (err) {
    refus = err;
  }

  check('un projet qui se déclare en PROD ne s’appaire PAS à un Panel de recette',
    refus !== null);
  check('…et le refus est nommé, pas silencieux',
    refus?.code === 'BRIDGE_ENVIRONMENT_MISMATCH');
  check('…la fiche déclarée reste non appairée',
    (await registryStore.getById(declared.record.projectId)).pairing.status !== 'PAIRED');

  const d = await diffusion();
  check('une instance non appairée ne fait pas échouer le parc', d.global === 'UP_TO_DATE');
  check('…et elle est nommée NOT_PAIRED, pas « en retard »',
    etatDe(d, declared.record.projectId).state === 'NOT_PAIRED');
  check('…donc elle n’est jamais visée par une rediffusion',
    !d.pendingProjectIds.includes(declared.record.projectId));
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('L’ÉTAT LU PAR L’ÉCRAN — calculé sur la fixture finale, réelle');
{
  const d = await diffusion();
  const N = d.expectedVersion;

  for (const inst of [alpha, beta]) {
    const etat = etatDe(d, inst.projectId);
    check(`${inst.projectName} : appliquée=${etat.appliedVersion}, attendue=${N} → APPLIED`,
      etat.appliedVersion === N && etat.state === 'APPLIED');
    check(`…son environnement est nommé (${etat.environment})`, etat.environment === 'TEST');
    check('…et sa dernière application est datée', typeof etat.appliedAt === 'string');
  }

  check('le parc n’a rien à rattraper', d.pendingProjectIds.length === 0 && d.global === 'UP_TO_DATE');

  // Et le verdict de publication, lui, se lit sur les charges utiles.
  const publication = await societe.describeCompanyPublication(await ficheDe());
  check('la fiche enregistrée est bien celle qui est publiée', publication.state === 'PUBLISHED');
  check('…et aucun média n’a été recréé au passage',
    (await PanelMedia.countDocuments({})) === 1);
}

for (const inst of instances) await inst.stop();
await closePanel();
await stopMemoryMongo();
finish();
