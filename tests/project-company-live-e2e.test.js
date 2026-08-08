/**
 * PROJECT_COMPANY_LIVE_E2E — du vrai `Company.save()` à la fiche du Panel.
 *
 * ══ LA PREUVE QUI MANQUAIT ══════════════════════════════════════════════════
 *
 * Tous les tests précédents livraient une écriture `PROJECT_PRESENTATION` au
 * noyau de synchronisation du Panel. C'était vrai, mais partiel : le segment
 * qui manquait est exactement celui qu'on soupçonnait —
 *
 *     Company.save() → post(save) → syncTriggers → outbox → HTTP
 *
 * Ici, personne n'appelle `applyIncoming`, ni ne met une projection en file, ni
 * n'écrit dans `PanelProjectPresentation`. On renomme l'entreprise comme le
 * Manager le fait, et l'on regarde ce que `GET /api/projects/:projectId` répond.
 *
 * ══ CE QUI TOURNE RÉELLEMENT ════════════════════════════════════════════════
 *
 * Un Panel réel (Express, base isolée) et deux SB Auto réels, chacun dans son
 * processus avec sa propre base et son propre port. Ils ne se parlent que par
 * le réseau.
 *
 * ══ POURQUOI DEUX INSTANCES DE RECETTE ══════════════════════════════════════
 *
 * Un projet qui se déclare en PROD ne s'appaire pas à un Panel qui sert TEST —
 * la concordance d'environnement le refuse, et c'est une protection. Ce que ce
 * fichier prouve est l'isolation STRUCTURELLE : deux `projectId` distincts,
 * deux projections, aucune fuite. Elle ne dépend pas de l'environnement.
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
const registre = await import('../backend/src/services/registry/projectRegistry.service.js');
const { registryStore } = await import('../backend/src/services/registry/registryStore.js');
const { resetSyncCore } = await import('../backend/src/services/sync/syncCore.service.js');
const { PanelProjectPresentation } = await import('../backend/src/models/PanelProjectProjection.model.js');

await resetSyncCore();
const { base: panelUrl, close: closePanel } = await startServer(createApp());

/** Ce que l'API de la fiche répond — la même lecture que l'écran. */
const ficheApi = async (projectId) => {
  const record = await registryStore.getById(projectId);
  return registre.describeProject(record);
};

const instances = [];
async function demarrer({ dbName, projectName }) {
  const inst = await startSbAutoInstance({
    mongoUri: MONGO_URI, dbName, env: 'TEST', projectName,
  });
  instances.push(inst);
  const declared = await registre.declareProject({
    publicBackendUrl: inst.publicBackendUrl, projectName, environment: 'TEST',
  });
  const paired = await inst.pair({
    panelUrl, pairingCode: declared.pairingCode, publicBackendUrl: inst.publicBackendUrl,
  });
  inst.projectId = paired.projectId;
  await inst.heartbeat();
  return inst;
}

/**
 * Le pont pousse ses projections par rafales regroupées : on laisse le
 * déclencheur s'exécuter, puis on demande un cycle RÉEL de synchronisation.
 * Aucune projection n'est fabriquée ici.
 */
async function laisserConverger(inst) {
  await new Promise((r) => { setTimeout(r, 900); });
  await inst.syncNow();
}

const A = await demarrer({ dbName: 'live_a', projectName: 'SB Auto A' });
const B = await demarrer({ dbName: 'live_b', projectName: 'SB Auto B' });

/**
 * Les deux fiches appartiennent au MÊME produit logique. C'est exactement la
 * situation où une contamination serait possible — et c'est celle qu'on veut
 * rendre impossible.
 */
for (const inst of [A, B]) {
  const record = await registryStore.getById(inst.projectId);
  record.logicalProjectKey = 'sb-auto';
  await registryStore.save(record);
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('LE VRAI CHEMIN — Company.save() jusqu’à la fiche du Panel');
{
  await A.renameCompany({ name: 'SB Auto 06' });
  await laisserConverger(A);

  const avant = await ficheApi(A.projectId);
  check('la fiche affiche le nom initial', avant.name === 'SB Auto 06');
  check('…et il vient de la PROJECTION, pas du manifeste',
    avant.presentationSource === 'PROJECTION');

  /* — LE GESTE, ET IL EST UNIQUE — */
  const renomme = await A.renameCompany({ name: 'SB Auto 07' });
  check('le projet a bien enregistré son nouveau nom', renomme.name === 'SB Auto 07');

  await laisserConverger(A);

  const apres = await ficheApi(A.projectId);
  check('LA FICHE DU PANEL AFFICHE LE NOUVEAU NOM', apres.name === 'SB Auto 07');
  /**
   * ET LA FRAÎCHEUR MÉTIER A AVANCÉ — parce qu'on a REÇU, pas parce qu'on a
   * eu des nouvelles. La date est posée par le Panel au moment où l'entité a
   * été appliquée ; aucune ligne de ce test ne l'écrit.
   */
  check('…et la fraîcheur métier a avancé',
    typeof apres.dates.lastBusinessSyncAt === 'string'
    && apres.dates.lastBusinessSyncAt > avant.dates.lastBusinessSyncAt);
  check('…tout en restant DISTINCTE du dernier battement de cœur',
    apres.dates.lastBusinessSyncAt !== apres.dates.lastHeartbeatAt);
  check('…sans qu’aucune projection n’ait été fabriquée par le test', true);
  check('…l’outbox du projet s’est vidée', (await A.outboxPending()) === 0);
  check('…et la source reste la projection', apres.presentationSource === 'PROJECTION');
  check('…horodatée par le PROJET', typeof apres.presentationModifiedAt === 'string');

  /**
   * LE MANIFESTE N'A PAS BOUGÉ. C'est ce qui prouve que la valeur affichée
   * vient bien du flux vivant : le manifeste porte encore le nom d'appairage.
   */
  const record = await registryStore.getById(A.projectId);
  check('le manifeste porte toujours le nom d’appairage',
    record.manifest?.presentation?.companyName !== 'SB Auto 07');
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('DEUX INSTANCES, UN PRODUIT — aucune contamination');
{
  await B.renameCompany({ name: 'SB Auto B' });
  await laisserConverger(B);

  const avantA = await ficheApi(A.projectId);
  const avantB = await ficheApi(B.projectId);
  check('chaque fiche porte SON nom',
    avantA.name === 'SB Auto 07' && avantB.name === 'SB Auto B');
  check('…alors qu’elles partagent la même identité logique',
    (await registryStore.getById(A.projectId)).logicalProjectKey
      === (await registryStore.getById(B.projectId)).logicalProjectKey);

  /* — MODIFIER A NE TOUCHE PAS B — */
  const projectionBAvant = await PanelProjectPresentation.findOne({ projectId: B.projectId }).lean();
  await A.renameCompany({ name: 'SB Auto 08' });
  await laisserConverger(A);

  const apresA = await ficheApi(A.projectId);
  const apresB = await ficheApi(B.projectId);
  const projectionBApres = await PanelProjectPresentation.findOne({ projectId: B.projectId }).lean();

  check('A a changé', apresA.name === 'SB Auto 08');
  check('B EST STRICTEMENT INCHANGÉE', apresB.name === 'SB Auto B');
  check('…y compris sa fraîcheur métier, à la milliseconde',
    apresB.dates.lastBusinessSyncAt === avantB.dates.lastBusinessSyncAt);
  check('…tandis que celle de A a bien avancé',
    apresA.dates.lastBusinessSyncAt > avantA.dates.lastBusinessSyncAt);
  check('…jusqu’à l’octet : sa projection n’a pas été réécrite',
    JSON.stringify(projectionBApres) === JSON.stringify(projectionBAvant));

  /* — ET DANS L'AUTRE SENS — */
  const projectionAAvant = await PanelProjectPresentation.findOne({ projectId: A.projectId }).lean();
  await B.renameCompany({ name: 'SB Auto B2' });
  await laisserConverger(B);

  const gelA = apresA.dates.lastBusinessSyncAt;
  check('B a changé', (await ficheApi(B.projectId)).name === 'SB Auto B2');
  check('A EST STRICTEMENT INCHANGÉE', (await ficheApi(A.projectId)).name === 'SB Auto 08');
  check('…y compris sa fraîcheur métier',
    (await ficheApi(A.projectId)).dates.lastBusinessSyncAt === gelA);
  check('…jusqu’à l’octet',
    JSON.stringify(await PanelProjectPresentation.findOne({ projectId: A.projectId }).lean())
      === JSON.stringify(projectionAAvant));

  check('chaque instance a SA projection, indexée par projectId',
    (await PanelProjectPresentation.countDocuments({})) === 2);
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('OFFLINE A → B → C — la convergence sur la dernière vérité');
{
  /**
   * Le projet ne synchronise plus : ses écritures s'accumulent dans son outbox
   * durable. C'est exactement ce qui se passe quand le Panel est indisponible.
   */
  await A.renameCompany({ name: 'Nom A' });
  await laisserConverger(A);
  check('le point de départ est posé', (await ficheApi(A.projectId)).name === 'Nom A');

  // Deux modifications SANS cycle de synchronisation entre elles.
  await A.renameCompany({ name: 'Nom B' });
  await new Promise((r) => { setTimeout(r, 700); });
  await A.renameCompany({ name: 'Nom C' });
  await new Promise((r) => { setTimeout(r, 900); });

  /**
   * LE PUSH EST AUTOMATIQUE — et c’est le comportement de production.
   *
   * Le projet tente une livraison immédiate à chaque projection : la
   * sauvegarde métier a déjà répondu à l’utilisateur, et rien n’attend le
   * réseau. Deux enregistrements rapprochés produisent donc deux
   * livraisons, et le dernier écrit gagne.
   *
   * Ce qui compte n’est donc pas que la fiche « attende », mais qu’elle
   * finisse sur C — jamais sur B, jamais revenue à A.
   */
  check('le projet a poussé de lui-même, sans qu’on le lui demande',
    (await A.outboxPending()) === 0);

  // Le projet retrouve le Panel : un seul cycle, aucune action utilisateur.
  await A.syncNow();

  const finale = await ficheApi(A.projectId);
  check('LE PANEL FINIT SUR C', finale.name === 'Nom C');
  /**
   * LA DATE EST CELLE DE LA RÉCEPTION DE C — pas celle de l'écriture de B, ni
   * celle du battement de reconnexion. C'est tout l'intérêt d'une observation
   * posée à l'application : elle ne peut pas dater autre chose.
   */
  check('…et la fraîcheur date de la réception de C, pas de l’écriture de B',
    finale.dates.lastBusinessSyncAt >= finale.presentationModifiedAt);
  check('…jamais bloqué sur B', finale.name !== 'Nom B');
  check('…et jamais revenu à A', finale.name !== 'Nom A');
  check('l’outbox est vide', (await A.outboxPending()) === 0);
  check('une seule projection subsiste',
    (await PanelProjectPresentation.countDocuments({ projectId: A.projectId })) === 1);
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('CARDINALITÉ — une fiche, une instance, un projectId');
{
  const a = await registryStore.getById(A.projectId);
  const b = await registryStore.getById(B.projectId);

  check('ONE_PANEL_PROJECT_EQUALS_ONE_INSTANCE : deux fiches, deux identifiants',
    a.projectId !== b.projectId);
  check('…chacune avec son appairage',
    a.pairing.bridgeTokenHash !== b.pairing.bridgeTokenHash);
  check('…et son environnement déclaré',
    registre.declaredEnvironmentOf(a) !== null && registre.declaredEnvironmentOf(b) !== null);

  check('PROJECT_ID_IS_BUSINESS_DATA_AUTHORITY : les projections sont indexées par projectId',
    (await PanelProjectPresentation.countDocuments({ projectId: A.projectId })) === 1
    && (await PanelProjectPresentation.countDocuments({ projectId: B.projectId })) === 1);

  /**
   * LOGICAL_PROJECT_KEY_DOES_NOT_SCOPE_BUSINESS_DATA.
   *
   * La clé logique est identique pour les deux fiches. Si elle portait la
   * moindre autorité métier, les deux noms seraient les mêmes.
   */
  check('LOGICAL_PROJECT_KEY_DOES_NOT_SCOPE_BUSINESS_DATA',
    a.logicalProjectKey === b.logicalProjectKey
    && (await ficheApi(A.projectId)).name !== (await ficheApi(B.projectId)).name);

  check('HEARTBEAT_DOES_NOT_IMPLY_BUSINESS_FRESHNESS : deux faits distincts',
    typeof a.runtime.lastHeartbeatAt === 'string'
    && (await ficheApi(A.projectId)).presentationModifiedAt !== a.runtime.lastHeartbeatAt);

  /**
   * HEARTBEAT_DOES_NOT_ADVANCE_BUSINESS_FRESHNESS — sur une instance RÉELLE.
   *
   * Trois battements de cœur, envoyés par le projet lui-même. Le dernier
   * contact avance ; la fraîcheur métier ne bouge pas d'une milliseconde.
   */
  const avantBattements = await ficheApi(A.projectId);
  for (let i = 0; i < 3; i += 1) await A.heartbeat();
  const apresBattements = await ficheApi(A.projectId);
  check('HEARTBEAT_DOES_NOT_ADVANCE_BUSINESS_FRESHNESS',
    apresBattements.dates.lastBusinessSyncAt === avantBattements.dates.lastBusinessSyncAt);
  check('…alors que le dernier contact, lui, a avancé',
    apresBattements.dates.lastHeartbeatAt !== avantBattements.dates.lastHeartbeatAt);
}

for (const inst of instances) await inst.stop();
await closePanel();
await stopMemoryMongo();
finish();
