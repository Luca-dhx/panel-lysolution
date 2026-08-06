// DESTINATION UNIQUE PAR ENVIRONNEMENT — et un seul résolveur d'URL.
//
// ══ LE DÉFAUT TRAITÉ ═══════════════════════════════════════════════════════
//
// Le Panel connaissait TROIS adresses par projet, écrites à trois moments :
//
//   · `runtime.publicBackendUrl` — posée au BOOTSTRAP, jamais revue ensuite,
//     puisque le battement de cœur ne transporte aucune URL ;
//   · `manifest.network.urls`    — photographie prise à l'appairage ;
//   · la projection `PROJECT_PRESENTATION.network` — poussée à CHAQUE
//     modification métier.
//
// Un projet qui change de domaine sans se réappairer — même base, donc même
// jeton — ne rafraîchit que la troisième. Les écrans lisaient des sources
// différentes : la vitrine passait au nouveau domaine, le backend et le
// domaine principal restaient sur l'ancien, et le Panel APPELAIT l'ancien pour
// les contrats et la santé.
//
// Constaté en base le 2026-08-06 sur « Demo SB Auto » : présentation sur
// `demo-sbauto06.ly-solution.com`, runtime et manifeste sur
// `demo-sbauto.lycarz.com` — même génération, donc rien pour les départager.
//
// ══ CE QUI EST PROUVÉ ICI ══════════════════════════════════════════════════
//
//  · une seule destination ACTIVE par projet ET par environnement ;
//  · TEST et PROD en ont chacun une, indépendamment ;
//  · une migration ne bascule qu'une fois la photographie complète ;
//  · toutes les vues lisent la MÊME source, sans repli sur le manifeste ;
//  · la reprise de l'existant tranche par la DATE, sans rien inventer ;
//  · le Panel n'expose aucune action de déploiement.
import {
  check, connectTestDatabase, finish, rejectsWith, section, setTestEnv,
  startMemoryMongo, stopMemoryMongo,
} from './helpers/harness.js';

setTestEnv();
await startMemoryMongo();
await connectTestDatabase();

const destinations = await import('../backend/src/services/registry/projectDestination.service.js');
const { registryStore } = await import('../backend/src/services/registry/registryStore.js');
const { describeProject } = await import('../backend/src/services/registry/projectRegistry.service.js');
const { currentGeneration } = await import('../backend/src/services/sync/projectGeneration.js');
const PanelProject = (await import('../backend/src/models/PanelProject.model.js')).default;
const PanelProjectDestination = (await import('../backend/src/models/PanelProjectDestination.model.js')).default;
const { PanelProjectPresentation } = await import('../backend/src/models/PanelProjectProjection.model.js');

const { DESTINATION_STATUS } = destinations;

const ANCIEN = 'demo-sbauto.lycarz.com';
const NOUVEAU = 'demo-sbauto06.ly-solution.com';

const urlsDe = (hote) => ({
  website: `https://${hote}`,
  manager: `https://manager.${hote}`,
  backend: `https://api.${hote}`,
});

/** Une fiche projet telle que le registre la porte. */
async function creerProjet({ projectId = 'p-1', environment = 'TEST', pairedAt = '2026-08-04T17:37:22.545Z' } = {}) {
  await PanelProject.create({
    projectId,
    projectKey: `cle-${projectId}`,
    projectName: `Projet ${projectId}`,
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
    pairing: { status: 'PAIRED', pairedAt },
    runtime: { environment },
  });
  return registryStore.getById(projectId);
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('NORMALISATION — l’hôte est canonique, le préfixe d’API ne compte pas');
{
  check('l’hôte vient du site quand il est connu',
    destinations.destinationHostOf(urlsDe(NOUVEAU)) === NOUVEAU);
  check('…du backend sinon, préfixe d’API retiré',
    destinations.destinationHostOf({ backend: `https://api.${NOUVEAU}` }) === NOUVEAU);
  check('…et du Manager en dernier recours',
    destinations.destinationHostOf({ manager: `https://manager.${NOUVEAU}` }) === NOUVEAU);
  check('une adresse relative ne donne aucun hôte',
    destinations.destinationHostOf({ website: '/uploads' }) === null);

  check('une photographie complète ne manque de rien',
    destinations.missingKeys(urlsDe(NOUVEAU)).length === 0);
  check('…une annonce partielle dit ce qui manque',
    destinations.missingKeys({ backend: `https://api.${NOUVEAU}` }).join(',') === 'website,manager');
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('PREMIÈRE DESTINATION — activée, même incomplète');
{
  await PanelProject.deleteMany({});
  await PanelProjectDestination.deleteMany({});
  const record = await creerProjet();

  const res = await destinations.announceDestination({
    record, urls: { backend: `https://api.${ANCIEN}` }, source: 'BOOTSTRAP',
  });
  check('une première annonce ACTIVE la destination', res.action === 'ACTIVATED');
  check('…même partielle — sans quoi le projet n’aurait aucune adresse',
    res.missing.includes('website'));

  const active = await destinations.activeDestination('p-1', 'TEST');
  check('la destination est active', active.status === DESTINATION_STATUS.ACTIVE);
  check('…sur le bon hôte', active.host === ANCIEN);
  check('…et sait par quel canal elle a été annoncée', active.announcedBy === 'BOOTSTRAP');

  // Une annonce du MÊME hôte complète sans rien basculer.
  const complet = await destinations.announceDestination({
    record, urls: urlsDe(ANCIEN), source: 'PRESENTATION',
  });
  check('une annonce du même hôte rafraîchit', complet.action === 'REFRESHED');
  const apres = await destinations.activeDestination('p-1', 'TEST');
  check('…et complète ce qui manquait', apres.missing.length === 0);
  check('…sans changer d’identité de destination',
    apres.destinationId === active.destinationId);
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('MIGRATION — on ne bascule qu’une fois la photographie complète');
{
  const record = await registryStore.getById('p-1');

  // Annonce PARTIELLE d'un nouvel hôte : rien ne bascule.
  const partielle = await destinations.announceDestination({
    record, urls: { backend: `https://api.${NOUVEAU}` }, source: 'PRESENTATION',
  });
  check('une migration annoncée partiellement reste EN ATTENTE',
    partielle.action === 'PENDING');
  check('…et dit ce qui manque', partielle.missing.length === 2);

  const toujours = await destinations.activeDestination('p-1', 'TEST');
  check('l’ancienne destination reste ACTIVE tant qu’on n’a pas tout reçu',
    toujours.host === ANCIEN);

  const enAttente = await PanelProjectDestination.findOne({
    projectId: 'p-1', status: DESTINATION_STATUS.PENDING,
  }).lean();
  check('la nouvelle attend, sans être lue', enAttente.host === NOUVEAU);
  check('…et sait quelle destination elle remplacera',
    enAttente.previousDestinationId === toujours.destinationId);

  // Photographie COMPLÈTE : la bascule a lieu.
  const complete = await destinations.announceDestination({
    record, urls: urlsDe(NOUVEAU), source: 'PRESENTATION',
  });
  check('une photographie complète déclenche la bascule', complete.action === 'MIGRATED');
  check('…en nommant l’hôte quitté', complete.from === ANCIEN);

  const active = await destinations.activeDestination('p-1', 'TEST');
  check('la nouvelle destination est ACTIVE', active.host === NOUVEAU);

  const ancienne = await PanelProjectDestination.findOne({ projectId: 'p-1', host: ANCIEN }).lean();
  check('l’ancienne passe RETIRED — jamais supprimée',
    ancienne.status === DESTINATION_STATUS.RETIRED);
  check('…avec sa date de retrait', typeof ancienne.retiredAt === 'string');
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('UNE SEULE ACTIVE — l’index l’interdit, pas seulement le code');
{
  await PanelProjectDestination.init();
  let doublon = null;
  try {
    await PanelProjectDestination.create({
      destinationId: 'doublon', projectId: 'p-1', environment: 'TEST',
      host: 'autre.exemple.com', status: DESTINATION_STATUS.ACTIVE,
      announcedAt: new Date().toISOString(),
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    });
  } catch (err) { doublon = err.code; }
  check('deux destinations ACTIVE pour un même environnement sont REFUSÉES',
    doublon === 11000);

  const actives = await PanelProjectDestination.countDocuments({
    projectId: 'p-1', environment: 'TEST', status: DESTINATION_STATUS.ACTIVE,
  });
  check('…il n’en reste qu’une', actives === 1);
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('TEST ET PROD — chacun sa destination active');
{
  await PanelProject.deleteMany({});
  await PanelProjectDestination.deleteMany({});

  const test = await creerProjet({ projectId: 'p-env', environment: 'TEST' });
  await destinations.announceDestination({ record: test, urls: urlsDe('demo.exemple.com'), source: 'PRESENTATION' });

  // Le même projet, vu en PROD : le registre ne porte qu'un environnement à la
  // fois, on simule donc la bascule d'environnement de la fiche.
  await PanelProject.updateOne({ projectId: 'p-env' }, { $set: { 'runtime.environment': 'PROD' } });
  const prod = await registryStore.getById('p-env');
  await destinations.announceDestination({ record: prod, urls: urlsDe('exemple.com'), source: 'PRESENTATION' });

  const enTest = await destinations.activeDestination('p-env', 'TEST');
  const enProd = await destinations.activeDestination('p-env', 'PROD');
  check('TEST a sa destination active', enTest?.host === 'demo.exemple.com');
  check('PROD a la sienne', enProd?.host === 'exemple.com');
  check('…et elles coexistent sans se gêner', enTest.destinationId !== enProd.destinationId);

  const par = await destinations.describeByEnvironment('p-env');
  check('l’écran reçoit les deux environnements séparément',
    par.TEST.active.host === 'demo.exemple.com' && par.PROD.active.host === 'exemple.com');
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('RÉSOLVEUR UNIQUE — toutes les vues lisent la même chose');
{
  await PanelProject.deleteMany({});
  await PanelProjectDestination.deleteMany({});

  // Une fiche telle qu'elle était : trois adresses, deux hôtes.
  await PanelProject.create({
    projectId: 'p-mix', projectKey: 'mix', projectName: 'Demo SB Auto',
    createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-05T20:38:04.169Z',
    pairing: { status: 'PAIRED', pairedAt: '2026-08-04T17:37:22.545Z' },
    runtime: { environment: 'TEST', publicBackendUrl: `https://api.${ANCIEN}` },
    manifest: { network: { primaryDomain: ANCIEN, urls: urlsDe(ANCIEN) } },
    manifestSource: 'BRIDGE', manifestUpdatedAt: '2026-08-04T17:37:22.545Z',
  });

  const record = await registryStore.getById('p-mix');
  await destinations.announceDestination({ record, urls: urlsDe(NOUVEAU), source: 'PRESENTATION' });

  const resolu = await registryStore.getById('p-mix');
  const d = describeProject(resolu);

  check('le domaine principal vient de la destination active', d.primaryDomain === NOUVEAU);
  check('…et non du manifeste, resté sur l’ancien hôte',
    d.primaryDomain !== ANCIEN);
  check('l’URL du site vient de la destination', d.urls.website === `https://${NOUVEAU}`);
  check('…celle du Manager aussi', d.urls.manager === `https://manager.${NOUVEAU}`);
  check('…celle du backend aussi', d.urls.backend === `https://api.${NOUVEAU}`);
  check('l’origine de l’adresse est annoncée', d.networkSource === 'DESTINATION_ACTIVE');

  // LES TROIS ADRESSES SONT COHÉRENTES ENTRE ELLES.
  const hotes = new Set(Object.values(d.urls).map((u) => new URL(u).hostname.replace(/^(api|manager)\./, '')));
  check('les trois adresses désignent UN SEUL hôte', hotes.size === 1);

  // L'APPEL SORTANT suit la destination, plus le champ figé au bootstrap.
  check('les appels sortants visent la destination active',
    destinations.outboundBaseUrl(resolu) === `https://api.${NOUVEAU}`);
  check('…et surtout plus l’adresse du bootstrap',
    resolu.runtime.publicBackendUrl === `https://api.${ANCIEN}`
    && destinations.outboundBaseUrl(resolu) !== resolu.runtime.publicBackendUrl);

  // AUCUNE DESTINATION → aucune adresse. « Inconnu » est une réponse.
  await PanelProjectDestination.deleteMany({ projectId: 'p-mix' });
  const orphelin = await registryStore.getById('p-mix');
  const sansDest = describeProject(orphelin);
  check('sans destination active, aucune URL n’est inventée',
    sansDest.urls === null && sansDest.primaryDomain === null);
  check('…et la raison est dite', sansDest.networkSource === 'AUCUNE_DESTINATION_ACTIVE');
  check('…l’ancien manifeste n’est PAS ressorti en secours',
    destinations.outboundBaseUrl(orphelin) === null);
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('GÉNÉRATION — un déménagement rend les anciennes projections périmées');
{
  const record = {
    runtime: { environment: 'TEST' },
    pairing: { pairedAt: '2026-08-04T17:37:22.545Z' },
  };
  const avant = currentGeneration(record, ANCIEN).generation;
  const apres = currentGeneration(record, NOUVEAU).generation;

  check('la destination entre dans la clé de génération', avant !== apres);
  check('…l’environnement et l’appairage n’y suffisaient pas',
    avant.startsWith('TEST|2026-08-04T17:37:22.545Z')
    && apres.startsWith('TEST|2026-08-04T17:37:22.545Z'));
  check('une génération sans destination reste stable',
    currentGeneration(record).generation === currentGeneration(record, null).generation);
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('REPRISE — la date tranche, rien n’est inventé');
{
  await PanelProject.deleteMany({});
  await PanelProjectDestination.deleteMany({});
  await PanelProjectPresentation.deleteMany({});

  // La fiche RÉELLE de Demo SB Auto, telle qu'elle a été lue en base.
  await PanelProject.create({
    projectId: 'e43de003-c6ef-41ed-8ac7-72197f6abe59',
    projectKey: 'projet-sans-nom', projectName: 'Demo SB Auto',
    createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-05T20:38:04.169Z',
    pairing: { status: 'PAIRED', pairedAt: '2026-08-04T17:37:22.545Z' },
    runtime: {
      environment: 'TEST',
      publicBackendUrl: `https://api.${ANCIEN}`,
      lastHeartbeatAt: '2026-08-05T20:38:04.169Z',
    },
    manifest: { network: { primaryDomain: ANCIEN, urls: urlsDe(ANCIEN) } },
    manifestSource: 'BRIDGE', manifestUpdatedAt: '2026-08-04T17:37:22.545Z',
  });
  await PanelProjectPresentation.create({
    projectId: 'e43de003-c6ef-41ed-8ac7-72197f6abe59',
    network: urlsDe(NOUVEAU),
    sourceModifiedAt: '2026-08-05T17:43:50.231Z',
    receivedAt: '2026-08-05T17:54:04.792Z',
  });

  // SIMULATION d'abord : une reprise qui écrit avant d'avoir été relue est une
  // reprise qu'on n'a pas relue.
  const simulation = await destinations.reconcileDestinations({ dryRun: true });
  check('la simulation n’écrit rien', simulation.activated === 0);
  check('…mais NOMME la divergence', simulation.divergences.length === 1);
  const div = simulation.divergences[0];
  check('…en disant ce qui est retenu', div.retained.host === NOUVEAU);
  check('…par quel canal', div.retained.source === 'PRESENTATION');
  check('…et ce qui est écarté', div.superseded.every((s) => s.host === ANCIEN));
  check('…rien n’a été créé', (await PanelProjectDestination.countDocuments({})) === 0);

  const rapport = await destinations.reconcileDestinations();
  check('la reprise active la destination la plus RÉCEMMENT annoncée',
    rapport.activated === 1);
  const active = await destinations.activeDestination('e43de003-c6ef-41ed-8ac7-72197f6abe59', 'TEST');
  check('…c’est-à-dire le nouvel hôte', active.host === NOUVEAU);
  check('…et l’ancien est conservé en RETIRED', rapport.retired === 1);

  const ancienne = await PanelProjectDestination.findOne({ host: ANCIEN }).lean();
  check('l’ancien hôte reste consultable', ancienne.status === DESTINATION_STATUS.RETIRED);
  check('…avec la date à laquelle il avait été annoncé',
    ancienne.announcedAt === '2026-08-04T17:37:22.545Z');

  // NI LE MANIFESTE NI LE RUNTIME NE SONT RÉÉCRITS : on ne réécrit pas ce que
  // le projet a dit, on cesse simplement de le lire comme une adresse.
  const fiche = await PanelProject.findOne({ projectId: 'e43de003-c6ef-41ed-8ac7-72197f6abe59' }).lean();
  check('le manifeste n’est pas réécrit',
    fiche.manifest.network.primaryDomain === ANCIEN);
  check('…ni le runtime', fiche.runtime.publicBackendUrl === `https://api.${ANCIEN}`);

  const encore = await destinations.reconcileDestinations();
  check('la reprise est idempotente',
    encore.activated === 0 && encore.alreadyKnown === 1);
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('CYCLE DE VIE — les deux seules actions humaines');
{
  const ancienne = await PanelProjectDestination.findOne({ host: ANCIEN }).lean();

  const vide = await destinations.markDestinationEmpty(ancienne.destinationId, { actor: 'dev@test' });
  check('une destination RETIRÉE peut être déclarée vide', vide.status === 'EMPTY');
  check('…et propose alors sa suppression', vide.canDelete === true);

  const supprimee = await destinations.deleteDestination(ancienne.destinationId, { actor: 'dev@test' });
  check('une destination VIDE se supprime', supprimee.status === 'DELETED');

  const survit = await PanelProjectDestination.findOne({ destinationId: ancienne.destinationId }).lean();
  check('…la fiche SURVIT — audit et historique conservés', survit !== null);
  check('…avec sa date de suppression', typeof survit.deletedAt === 'string');

  // L'ordre est imposé : on ne supprime pas ce qu'on n'a pas constaté vide.
  const active = await destinations.activeDestination('e43de003-c6ef-41ed-8ac7-72197f6abe59', 'TEST');
  check('une destination ACTIVE ne se déclare pas vide',
    await rejectsWith(() => destinations.markDestinationEmpty(active.destinationId),
      'PANEL_DESTINATION_NOT_RETIRED'));
  check('…ni ne se supprime',
    await rejectsWith(() => destinations.deleteDestination(active.destinationId),
      'PANEL_DESTINATION_NOT_EMPTY'));
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('LE PANEL NE DÉPLOIE PAS — aucune surface ne le laisse croire');
{
  const fs = await import('node:fs');
  const lire = (rel) => fs.readFileSync(new URL(rel, import.meta.url), 'utf8');

  const service = lire('../backend/src/services/registry/projectDestination.service.js');
  check('le service des destinations n’ouvre aucune connexion',
    !/fetch\(|ProjectBridgeClient|SshTransport|exec\(/.test(service));
  check('…et n’active aucune destination de sa propre initiative',
    !/deploy|redeploy|migrate\(/i.test(service.replace(/migration|migrations|MIGRATED/gi, '')));

  const routes = lire('../backend/src/routes/projects.routes.js');
  check('aucune route de déploiement sur un projet',
    !/deploy|redeploy|migrate/i.test(routes));
  check('…seulement vider et supprimer une destination',
    /destinations\/:destinationId\/empty/.test(routes)
    && /destinations\/:destinationId'/.test(routes));

  const ecran = lire('../frontend/src/pages/ProjectDetailPage.tsx');
  const carte = ecran.slice(ecran.indexOf('function DestinationsCard'));
  check('l’écran n’offre AUCUN bouton Déployer / Redéployer / Migrer',
    !/>\s*(Déployer|Redéployer|Migrer)\s*</.test(carte));
  check('…il n’offre que « Déclarer vide » et « Supprimer la destination »',
    /Déclarer vide/.test(carte) && /Supprimer la destination/.test(carte));
  check('…et dit explicitement que le Panel ne déploie pas',
    /n’effectue aucun déploiement/.test(carte));

  // AUCUNE VUE NE LIT PLUS UNE AUTRE SOURCE.
  const presentation = lire('../frontend/src/lib/projectPresentation.ts');
  check('les adresses ne lisent plus la projection poussée',
    !/business\?\.presentation\?\.network/.test(presentation));
  // Le motif vise le CODE : les fichiers expliquent en commentaire pourquoi ils
  // ne lisent plus ce champ, et cette explication ne doit pas être confondue
  // avec une lecture.
  const sansCommentaires = (src) => src.replace(/\{\/\*[\s\S]*?\*\/\}|\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
  const bridges = sansCommentaires(lire('../frontend/src/pages/BridgesPage.tsx'));
  check('la page Bridges ne lit plus runtime.publicBackendUrl',
    !/runtime\.publicBackendUrl/.test(bridges));
  check('…elle lit le résolveur commun',
    /projectTechnicalUrls\(project\)\.backend/.test(bridges));
  const fiche = sansCommentaires(lire('../frontend/src/pages/ProjectDetailPage.tsx'));
  check('la fiche technique n’a plus de repli sur runtime.publicBackendUrl',
    !/runtime\.publicBackendUrl/.test(fiche));
}

await stopMemoryMongo();
finish();
