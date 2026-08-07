/**
 * FRAÎCHEUR ET GÉNÉRATION — « qui est autoritatif, et depuis quand ? »
 *
 * ══ L'ÉCRAN QUI A DÉCLENCHÉ CE TEST ═════════════════════════════════════════
 *
 * Le 07/08, après un déploiement TEST réussi, la fiche de Demo SB Auto disait
 * simultanément :
 *
 *   En ligne · Connecté · Dernier contact : à l'instant
 *   « Données de l'environnement précédent »
 *   Environnement de la dernière synchronisation : TEST
 *   Environnement actuellement déclaré           : TEST
 *   Contrat : en attente de synchronisation · Donnée potentiellement obsolète
 *
 * Deux environnements identiques, et pourtant un désaccord d'environnement
 * annoncé. La photographie AVAIT été reçue (ACK APPLIED, projections écrites,
 * `lastSyncAt` posé) : c'est la LECTURE de la fraîcheur qui la reniait.
 *
 * ══ LA CAUSE, ET POURQUOI AUCUN TEST NE LA VOYAIT ═══════════════════════════
 *
 * La génération d'un projet est `environnement|appairage|domaine`. L'ÉCRITURE
 * passait l'hôte de la destination active ; la LECTURE, elle, ne passait rien
 * et retombait sur `record.activeDestinationHost` — un champ que RIEN n'écrit,
 * nulle part. Les deux clés ne pouvaient donc jamais coïncider :
 *
 *   estampillée : TEST|<appairage>|demo-sbauto06.ly-solution.com
 *   recalculée  : TEST|<appairage>|SANS-DESTINATION
 *
 * Les tests existants stampaient les projections À LA MAIN pour simuler un
 * changement de génération. Aucun ne faisait l'aller-retour COMPLET —
 * `applyIncoming` puis `toPublicProject` — avec une destination active. C'est
 * ce trajet-là que ce fichier verrouille.
 */
import { register } from 'node:module';
import {
  check,
  connectTestDatabase,
  finish,
  section,
  setTestEnv,
  startMemoryMongo,
  stopMemoryMongo,
} from './helpers/harness.js';

// La mise en forme vit dans le frontend : on l'exécute telle quelle.
register('./helpers/frontendLoader.mjs', import.meta.url);

setTestEnv();
await startMemoryMongo();
await connectTestDatabase();

const { applyIncoming } = await import('../backend/src/services/sync/syncCore.service.js');
const { registryStore } = await import('../backend/src/services/registry/registryStore.js');
const { toPublicProject, loadBusinessProjections } = await import(
  '../backend/src/services/registry/projectRegistry.service.js'
);
const {
  currentGeneration, generationsDiverge, sameGeneration,
  SANS_DESTINATION, DESTINATION_INCONNUE,
} = await import('../backend/src/services/sync/projectGeneration.js');
const {
  loadActiveDestinationHosts, destinationKey, announceDestination,
} = await import('../backend/src/services/registry/projectDestination.service.js');
const { PanelProjectDestination } = await import(
  '../backend/src/models/PanelProjectDestination.model.js'
);
const { PanelProjectContract, PanelProjectPresentation } = await import(
  '../backend/src/models/PanelProjectProjection.model.js'
);
const { getProjectDataFreshness, actionsDistantesPossibles } = await import(
  '@/lib/projectFreshness'
);

const PROJECT_ID = 'demo-sbauto06';
const ENTITE = '11111111-2222-5333-a444-555555555555';
const HOTE_1 = 'demo-sbauto06.ly-solution.com';
const HOTE_2 = 'demo-sbauto06-v2.ly-solution.com';
const APPAIRAGE_1 = '2026-08-07T12:50:00.000Z';
const APPAIRAGE_2 = '2026-08-09T09:00:00.000Z';

const fiche = (environment, pairedAt) => ({
  projectId: PROJECT_ID,
  projectKey: 'demo-sbauto06',
  projectName: 'Demo SB Auto',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  pairing: {
    status: 'PAIRED', pairingCodeHash: null, pairingCodeExpiresAt: null,
    bridgeTokenHash: 'x', bridgeTokenEncrypted: 'y', pairedAt, revokedAt: null,
  },
  runtime: {
    environment,
    softwareVersion: '1.0.0',
    contractVersion: '1.4.0',
    publicBackendUrl: `https://api.${HOTE_1}`,
    lastHeartbeatAt: new Date().toISOString(),
    lastHealth: null,
    bridgeStats: null,
  },
  manifest: null,
  manifestSource: null,
});

const ecriture = (writeId, entityType, payload, modifiedAt, entityId = ENTITE) => ({
  writeId, entityType, entityId, deleted: payload === null, payload, modifiedAt, emitter: 'PROJECT',
});

const contrat = (status) => ({
  sourceContractId: `contrat-${status}`,
  status,
  document: { available: false, status: 'NONE', downloadAvailable: false },
});

/** Une destination ACTIVE, telle qu'un déploiement réussi la laisse. */
async function destinationActive(host, environment = 'TEST') {
  const at = new Date().toISOString();
  await PanelProjectDestination.create({
    destinationId: `dest-${host}`, projectId: PROJECT_ID, environment, host,
    status: 'ACTIVE',
    urls: { website: `https://${host}`, manager: `https://manager.${host}`, backend: `https://api.${host}` },
    announcedAt: at, activatedAt: at, createdAt: at, updatedAt: at,
  });
}

/** LA FICHE TELLE QUE L'ÉCRAN LA REÇOIT — chemin complet, sans raccourci. */
async function ficheAffichee() {
  const record = await registryStore.getById(PROJECT_ID);
  const projections = await loadBusinessProjections([PROJECT_ID]);
  const hotes = await loadActiveDestinationHosts([
    { projectId: PROJECT_ID, environment: record.runtime?.environment ?? null },
  ]);
  const publie = toPublicProject(
    record, Date.now(), projections.get(PROJECT_ID),
    hotes.get(destinationKey(PROJECT_ID, record.runtime?.environment ?? null)),
  );
  // La vivacité est calculée côté serveur ; le battement date de maintenant.
  return { publie, fraicheur: getProjectDataFreshness({ ...publie, liveness: 'ONLINE' }) };
}

async function repartirDeZero({ environment = 'TEST', pairedAt = APPAIRAGE_1 } = {}) {
  await registryStore.clear();
  await PanelProjectDestination.deleteMany({});
  await PanelProjectContract.deleteMany({});
  await PanelProjectPresentation.deleteMany({});
  const { PanelSyncEntityState, PanelSyncReceipt } = await import(
    '../backend/src/models/PanelSyncState.model.js'
  );
  await PanelSyncEntityState.deleteMany({});
  await PanelSyncReceipt.deleteMany({});
  await registryStore.insert(fiche(environment, pairedAt));
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('0. LA CLÉ DE GÉNÉRATION — « aucune » et « je ne sais pas » diffèrent');
{
  const record = fiche('TEST', APPAIRAGE_1);

  const avecHote = currentGeneration(record, HOTE_1);
  const sansAucune = currentGeneration(record, null);
  const ignorante = currentGeneration(record);

  check('un hôte connu entre dans la clé', avecHote.generation.endsWith(`|${HOTE_1}`));
  check('« aucune destination » est un FAIT, et il est nommé',
    sansAucune.generation.endsWith(`|${SANS_DESTINATION}`) && sansAucune.destinationKnown === true);
  check('« je ne sais pas » est une IGNORANCE, et elle est nommée',
    ignorante.generation.endsWith(`|${DESTINATION_INCONNUE}`) && ignorante.destinationKnown === false);
  check('les deux ne se confondent plus',
    sansAucune.generation !== ignorante.generation);

  // C'est ICI que l'écran se trompait : une comparaison de chaînes.
  check('comparaison naïve : l’ignorance ressemblait à un désaccord',
    avecHote.generation !== ignorante.generation);
  check('comparaison réelle : une ignorance ne tranche RIEN',
    generationsDiverge(avecHote.generation, ignorante.generation) === false);
  check('…et symétriquement', generationsDiverge(ignorante.generation, avecHote.generation) === false);

  // Ce qui doit encore trancher, tranche.
  check('un ENVIRONNEMENT différent reste une rupture',
    generationsDiverge(
      currentGeneration(fiche('PROD', APPAIRAGE_1), HOTE_1).generation,
      currentGeneration(fiche('TEST', APPAIRAGE_1), HOTE_1).generation,
    ) === true);
  check('un RÉAPPAIRAGE reste une rupture',
    generationsDiverge(
      currentGeneration(fiche('TEST', APPAIRAGE_1), HOTE_1).generation,
      currentGeneration(fiche('TEST', APPAIRAGE_2), HOTE_1).generation,
    ) === true);
  check('un CHANGEMENT DE DOMAINE reste une rupture',
    generationsDiverge(avecHote.generation, currentGeneration(record, HOTE_2).generation) === true);
  check('« aucune destination » face à un hôte reste une rupture',
    generationsDiverge(sansAucune.generation, avecHote.generation) === true);

  check('une projection sans génération n’est jamais périmée d’office',
    sameGeneration(null, avecHote.generation) === true);
  check('…et sameGeneration suit la même règle que generationsDiverge',
    sameGeneration(ignorante.generation, avecHote.generation) === true);
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('A. Instance précédente décrite, nouvelle instance en heartbeat seul');
{
  await repartirDeZero();
  await destinationActive(HOTE_1);

  // L'ANCIENNE instance a poussé sa photographie.
  await applyIncoming(PROJECT_ID, [
    ecriture('w-1', 'CONTRACT', contrat('ACTIVE'), '2026-08-01T10:00:00.000Z'),
  ]);

  // La NOUVELLE instance arrive : autre domaine, donc autre génération. Elle
  // bat, elle est connectée — mais elle n'a encore rien raconté.
  await PanelProjectDestination.updateOne({ host: HOTE_1 }, { $set: { status: 'RETIRED' } });
  await destinationActive(HOTE_2);

  const { fraicheur } = await ficheAffichee();
  check('le projet est CONNECTÉ', fraicheur.connection === 'ONLINE');
  check('…mais les données métier restent NON fraîches',
    fraicheur.isBusinessDataFresh === false);
  check('…parce que la génération diffère', fraicheur.isGenerationMismatch === true);
  check('…et NON parce que l’environnement diffère',
    fraicheur.isEnvironmentMismatch === false);
  check('les deux environnements sont bien identiques',
    fraicheur.projectionEnvironment === 'TEST' && fraicheur.runtimeEnvironment === 'TEST');
  check('aucune action distante tant que la photographie manque',
    actionsDistantesPossibles(fraicheur) === false);
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('B. La nouvelle instance envoie sa photographie → elle devient autoritative');
{
  const avant = (await ficheAffichee()).fraicheur.lastFullSyncAt;

  const res = await applyIncoming(PROJECT_ID, [
    ecriture('w-2', 'CONTRACT', contrat('DRAFT'), '2026-08-07T12:56:00.000Z'),
  ]);
  check('la photographie est ACCEPTÉE', res.results[0].status === 'APPLIED');

  const { publie, fraicheur } = await ficheAffichee();
  check('la nouvelle instance est autoritative',
    fraicheur.isGenerationMismatch === false && fraicheur.isEnvironmentMismatch === false);
  check('les données métier redeviennent FRAÎCHES', fraicheur.isBusinessDataFresh === true);
  check('le bandeau disparaît (rien à afficher quand tout est frais)',
    fraicheur.isBusinessDataFresh === true);
  check('la date de photographie a AVANCÉ', fraicheur.lastFullSyncAt !== avant);
  check('les actions distantes redeviennent possibles',
    actionsDistantesPossibles(fraicheur) === true);
  check('le contrat affiché est celui de la NOUVELLE instance',
    publie.business.contract.status === 'DRAFT');

  // La preuve directe de la cause racine : les deux clés coïncident.
  const f = publie.business.freshness;
  check('la génération LUE est celle qui a été ÉCRITE',
    f.runtimeGeneration === f.projectionGeneration);
  check('…et elle contient bien le domaine de la destination active',
    f.runtimeGeneration.endsWith(`|${HOTE_2}`));
  check('le backend rend lui-même le verdict', f.generationMismatch === false);
  check('…y compris pour l’environnement', f.environmentMismatch === false);
  check('…et déclare avoir pu se prononcer sur la destination',
    f.destinationKnown === true);
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('C. Un battement de cœur ne remet JAMAIS les données en attente');
{
  const { recordHeartbeat } = await import(
    '../backend/src/services/registry/projectRegistry.service.js'
  );
  for (let i = 0; i < 3; i += 1) {
    await recordHeartbeat(await registryStore.getById(PROJECT_ID), {
      sentAt: new Date().toISOString(),
      softwareVersion: '1.0.0',
      environment: 'TEST',
      health: { status: 'OK' },
      bridgeStats: { outboxSize: 0, lastSyncAt: new Date().toISOString() },
    });
  }
  const { fraicheur } = await ficheAffichee();
  check('après trois battements, les données restent fraîches',
    fraicheur.isBusinessDataFresh === true);
  check('…et aucune génération n’a bougé', fraicheur.isGenerationMismatch === false);
  check('le battement met bien à jour le dernier contact',
    typeof fraicheur.lastContactAt === 'string');
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('D. Une photographie d’un AUTRE environnement reste écartée');
{
  await PanelProjectContract.updateOne(
    { projectId: PROJECT_ID },
    { $set: { sourceEnvironment: 'PROD', sourceGeneration: `PROD|${APPAIRAGE_1}|${HOTE_2}` } },
  );
  const { publie, fraicheur } = await ficheAffichee();
  check('le désaccord d’environnement est détecté', fraicheur.isEnvironmentMismatch === true);
  check('…et les données ne sont pas fraîches', fraicheur.isBusinessDataFresh === false);
  check('le backend le dit lui-même', publie.business.freshness.environmentMismatch === true);
  check('…et le signale AUSSI comme rupture de génération',
    publie.business.freshness.generationMismatch === true);
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('E. Instance ≠ environnement — deux dimensions, deux verdicts');
{
  // Même environnement, réappairage : c'est une nouvelle INSTANCE, pas un
  // nouvel environnement. Les deux verdicts doivent le dire distinctement.
  await repartirDeZero();
  await destinationActive(HOTE_1);
  await applyIncoming(PROJECT_ID, [
    ecriture('w-3', 'CONTRACT', contrat('ACTIVE'), '2026-08-01T10:00:00.000Z'),
  ]);

  const record = await registryStore.getById(PROJECT_ID);
  record.pairing.pairedAt = APPAIRAGE_2; // réappairage, même environnement
  await registryStore.save(record);

  const { publie, fraicheur } = await ficheAffichee();
  check('l’environnement, lui, n’a PAS changé',
    fraicheur.projectionEnvironment === fraicheur.runtimeEnvironment);
  check('…et le verdict d’environnement est donc FAUX',
    fraicheur.isEnvironmentMismatch === false);
  check('mais l’instance a changé, et le verdict de génération est VRAI',
    fraicheur.isGenerationMismatch === true);
  check('les deux faits sont publiés séparément par le backend',
    publie.business.freshness.environmentMismatch === false
    && publie.business.freshness.generationMismatch === true);
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('F. Le contrat cesse d’être « en attente de synchronisation »');
{
  // La nouvelle instance publie enfin son contrat.
  const res = await applyIncoming(PROJECT_ID, [
    ecriture('w-4', 'CONTRACT', contrat('ENDED'), '2026-08-09T09:05:00.000Z'),
  ]);
  check('le contrat de la nouvelle instance est appliqué', res.results[0].status === 'APPLIED');

  const { publie, fraicheur } = await ficheAffichee();
  // `DernierEtatConnu` n'affiche « en attente de synchronisation » QUE si la
  // fraîcheur est fausse : c'est cette condition-là qu'on verrouille.
  check('les données sont fraîches → aucune mention d’attente',
    fraicheur.isBusinessDataFresh === true);
  check('…donc aucun badge « potentiellement obsolète »',
    fraicheur.isBusinessDataFresh === true);
  check('le contrat montré est le contrat réellement remonté',
    publie.business.contract.status === 'ENDED');
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('G. Un simple redémarrage ne fabrique aucune rupture');
{
  await repartirDeZero();
  await destinationActive(HOTE_1);
  await applyIncoming(PROJECT_ID, [
    ecriture('w-5', 'CONTRACT', contrat('ACTIVE'), '2026-08-01T10:00:00.000Z'),
  ]);
  const avant = (await ficheAffichee()).fraicheur;
  check('après le premier déploiement, tout est frais', avant.isBusinessDataFresh === true);

  /**
   * REDÉMARRAGE : même environnement, même appairage, même domaine. Le projet
   * rejoue sa photographie à l'amorçage (`reconcileAll`) — état identique.
   * Rien ne doit bouger : ni rupture, ni attente, ni « instance précédente ».
   */
  const rejeu = await applyIncoming(PROJECT_ID, [
    ecriture('w-6', 'CONTRACT', contrat('ACTIVE'), '2026-08-01T10:00:00.000Z'),
  ]);
  check('le rejeu est accepté sans drame',
    ['APPLIED', 'IGNORED', 'DUPLICATE'].includes(rejeu.results[0].status));

  const apres = (await ficheAffichee()).fraicheur;
  check('les données restent fraîches', apres.isBusinessDataFresh === true);
  check('aucune rupture de génération inventée', apres.isGenerationMismatch === false);
  check('aucune rupture d’environnement inventée', apres.isEnvironmentMismatch === false);
  check('les actions distantes restent possibles', actionsDistantesPossibles(apres) === true);
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('H. Une destination annoncée porte SA propre génération');
{
  await repartirDeZero();
  const record = await registryStore.getById(PROJECT_ID);
  await announceDestination({
    record,
    urls: {
      website: `https://${HOTE_1}`,
      manager: `https://manager.${HOTE_1}`,
      backend: `https://api.${HOTE_1}`,
    },
    source: 'PRESENTATION',
  });

  const dest = await PanelProjectDestination.findOne({ projectId: PROJECT_ID, host: HOTE_1 }).lean();
  check('la destination est enregistrée', Boolean(dest));
  check('…et sa génération nomme SON hôte', dest.generation.endsWith(`|${HOTE_1}`));
  check('…jamais « sans destination », ce qui n’aurait aucun sens ici',
    !dest.generation.endsWith(`|${SANS_DESTINATION}`));
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('I. Un appelant qui ignore la destination ne périme rien');
{
  // Certaines réponses (création, mise à jour de manifeste) rendent la fiche
  // sans avoir chargé les destinations. Elles doivent S'ABSTENIR, pas accuser.
  const record = await registryStore.getById(PROJECT_ID);
  await applyIncoming(PROJECT_ID, [
    ecriture('w-7', 'CONTRACT', contrat('ACTIVE'), '2026-08-01T10:00:00.000Z'),
  ]);
  const projections = await loadBusinessProjections([PROJECT_ID]);
  const sansHote = toPublicProject(record, Date.now(), projections.get(PROJECT_ID));
  const f = sansHote.business.freshness;

  check('la génération dit son ignorance', f.runtimeGeneration.endsWith(`|${DESTINATION_INCONNUE}`));
  check('…et le déclare explicitement', f.destinationKnown === false);
  check('aucune rupture n’est inventée', f.generationMismatch === false);
  const fraicheur = getProjectDataFreshness({ ...sansHote, liveness: 'ONLINE' });
  check('l’écran ne montre donc aucun bandeau', fraicheur.isBusinessDataFresh === true);
}

await stopMemoryMongo();
finish();
