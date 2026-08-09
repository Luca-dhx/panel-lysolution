/**
 * BASELINE ÉVÉNEMENTIELLE — LOT L0 : reproduire, mesurer, ne rien conclure.
 *
 * ══ CE QUE CE FICHIER FAIT, ET CE QU'IL REFUSE DE FAIRE ═════════════════════
 *
 * Il mesure le temps réel entre un `Company.save()` côté SB Auto et l'instant
 * où l'API du Panel rend la nouvelle valeur. Rien d'autre.
 *
 * INTERDIT ici, et c'est tout le propos :
 *   · `syncNow()` / `runSyncCycle` appelés à la main ;
 *   · `flushOutbox()` appelé à la main ;
 *   · `applyIncoming` appelé à la main ;
 *   · une projection fabriquée par le test ;
 *   · `recordAppliedConfiguration` appelé à la main.
 *
 * Le test n'a le droit que de RENOMMER et de LIRE. Tout ce qui se produit
 * entre les deux est déclenché par le runtime lui-même.
 *
 * ══ POURQUOI L'ORDONNANCEUR EST ALLUMÉ ══════════════════════════════════════
 *
 * Le harnais historique le coupait pour savoir qui déclenchait quoi. C'était
 * lisible, et c'était précisément l'angle mort : la poussée immédiate ne peut
 * être concurrencée QUE par un cycle périodique en vol. Un test qui ne peut pas
 * produire la concurrence ne peut pas prouver qu'elle est traitée.
 *
 * On l'allume donc, et à une cadence AGRESSIVE (§ « cadence serrée ») : c'est
 * la seule façon de rendre l'entrelacement fréquent au lieu d'accidentel.
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
const { PanelSyncReceipt } = await import('../backend/src/models/PanelSyncState.model.js');

await resetSyncCore();
const { base: panelUrl, close: closePanel } = await startServer(createApp());

/** La lecture de la fiche — exactement celle que sert `GET /api/projects/:id`. */
const ficheApi = async (projectId) =>
  registre.describeProject(await registryStore.getById(projectId));

/**
 * ATTEND UNE VALEUR — en sondant la LECTURE, jamais en poussant quoi que ce
 * soit. Le sondage est celui de l'observateur, pas du transport : il ne
 * déclenche aucune synchronisation.
 */
/**
 * LA DERNIÈRE ÉCRITURE, UNE FOIS SON SORT SCELLÉ.
 *
 * ── POURQUOI ON NE PEUT PAS LIRE LA FILE TOUT DE SUITE ──────────────────────
 * Le Panel écrit la projection AVANT de répondre ; le nom apparaît donc dans
 * son API pendant que l'accusé est encore sur le fil. Échantillonner la file à
 * cet instant précis attrape un `SENDING` parfaitement normal et fait échouer
 * un test qui n'a rien constaté d'anormal.
 *
 * On attend donc que l'entrée quitte les états DE TRANSIT. Ce qui est éprouvé
 * — « acquittée, et pas refusée » — n'est en rien affaibli : c'est justement
 * l'état terminal qui distingue les deux.
 */
async function derniereEcritureScellee(inst, plafondMs = 10_000) {
  const debut = Date.now();
  for (;;) {
    const file = await inst.outboxDump();
    const derniere = file[file.length - 1];
    const enTransit = !derniere || ['PENDING', 'SENDING'].includes(derniere.status);
    if (!enTransit || Date.now() - debut > plafondMs) return derniere;
    await new Promise((r) => { setTimeout(r, 25); });
  }
}

async function attendreNom(projectId, attendu, plafondMs) {
  const debut = Date.now();
  for (;;) {
    const fiche = await ficheApi(projectId);
    if (fiche.name === attendu) return { ms: Date.now() - debut, atteint: true, fiche };
    if (Date.now() - debut > plafondMs) return { ms: Date.now() - debut, atteint: false, fiche };
    await new Promise((r) => { setTimeout(r, 25); });
  }
}

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

const mesures = [];

const A = await demarrer({ dbName: 'edsb_a', projectName: 'SB Auto Baseline' });

/* ══════════════════════════════════════════════════════════════════════════ */
section('SB_AUTO_SAVE_PUSHES_IMMEDIATELY — ordonnanceur ÉTEINT (référence)');
{
  const t0 = Date.now();
  await A.renameCompany({ name: 'Baseline 01' });
  const r = await attendreNom(A.projectId, 'Baseline 01', 15_000);
  mesures.push({ cas: 'ordonnanceur éteint', ms: r.ms, atteint: r.atteint });

  check(`la fiche du Panel affiche la nouvelle valeur sans aucun appel manuel (${r.ms} ms)`,
    r.atteint);
  check('…et la source est la projection, pas le manifeste',
    r.fiche.presentationSource === 'PROJECTION');
  // Le Panel écrit la projection AVANT de répondre : le nom est visible
  // pendant que l'accusé est encore sur le fil. On laisse l'écriture aller au
  // bout de son sort avant de juger la file. Voir `derniereEcritureScellee`.
  await derniereEcritureScellee(A);
  check('…l’outbox s’est vidée d’elle-même', (await A.outboxPending()) === 0);
  const t5 = Date.now() - t0;
  console.log(`    T0→T5 = ${t5} ms (fenêtre de regroupement 500 ms incluse)`);
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('LA CHAÎNE, MAILLON PAR MAILLON — horodatages réels');
{
  const t0 = new Date();
  await A.renameCompany({ name: 'Baseline 02' });
  const r = await attendreNom(A.projectId, 'Baseline 02', 15_000);
  check(`la valeur arrive (${r.ms} ms)`, r.atteint);

  const derniere = await derniereEcritureScellee(A);
  const recu = await PanelSyncReceipt.findOne({ projectId: A.projectId, writeId: derniere?.writeId }).lean();
  const projection = await PanelProjectPresentation.findOne({ projectId: A.projectId }).lean();

  const ms = (d) => (d ? new Date(d).getTime() - t0.getTime() : null);
  console.log('    T0 commit métier      : 0 ms');
  console.log(`    T1 outbox créée       : ${ms(derniere?.createdAt)} ms`);
  console.log(`    T2 requête partie     : ${ms(derniere?.lastAttemptAt)} ms`);
  console.log(`    T3 reçue par le Panel : ${ms(recu?.receivedAt)} ms`);
  console.log(`    T4 projection écrite  : ${ms(projection?.updatedAt)} ms`);
  console.log(`    T5 API Panel expose   : ${r.ms} ms`);
  console.log(`    tentatives            : ${derniere?.attempts}`);
  console.log(`    statut final          : ${derniere?.status}`);

  check('T1 — une entrée durable a été créée par le runtime', Boolean(derniere?.createdAt));
  check('T2 — une tentative de livraison a eu lieu', Boolean(derniere?.lastAttemptAt));
  check('T3 — le Panel a consigné un reçu pour CE writeId', Boolean(recu));
  check('T4 — la projection porte la nouvelle valeur',
    projection?.companyName === 'Baseline 02');
  check('l’écriture a été acquittée, pas seulement envoyée',
    derniere?.status === 'ACKNOWLEDGED');
  check('…en UNE seule tentative sur un environnement sain', derniere?.attempts === 1);
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('NO_POLLING_REQUIRED_FOR_NOMINAL_LIVE_SYNC — ordonnanceur ALLUMÉ, cadence serrée');
{
  /**
   * CADENCE SERRÉE, ET C'EST DÉLIBÉRÉ.
   *
   * À 30 s, l'entrelacement entre un cycle périodique et une poussée immédiate
   * est un accident qu'un test ne rencontre jamais. À 150 ms, il est la règle :
   * si la poussée immédiate peut être affamée par le cycle, cette section le
   * montre. Si elle ne le peut pas, elle le prouve.
   */
  await A.startScheduler({ heartbeatMs: 200, syncMs: 150 });

  const latences = [];
  let pire = 0;
  for (let i = 0; i < 6; i += 1) {
    const nom = `Cadence ${i}`;
    const t0 = Date.now();
    await A.renameCompany({ name: nom });
    const r = await attendreNom(A.projectId, nom, 20_000);
    const total = Date.now() - t0;
    latences.push(total);
    pire = Math.max(pire, total);
    check(`itération ${i} — livrée sans intervention (${total} ms)`, r.atteint);
  }
  mesures.push({ cas: 'ordonnanceur 150 ms', ms: pire, atteint: true });
  console.log(`    latences : ${latences.join(' / ')} ms — pire cas ${pire} ms`);

  /**
   * LE SEUIL EST UNE OBSERVATION, PAS UN SLA.
   *
   * 3 s laisse largement place à la fenêtre de regroupement (500 ms) et à un
   * aller-retour local. Ce qu'on cherche à détecter est d'un autre ordre : un
   * changement livré au TIC SUIVANT plutôt que tout de suite.
   */
  check(`aucune livraison n’a attendu un tic périodique (pire cas ${pire} ms < 3000 ms)`,
    pire < 3000);

  const etat = await A.schedulerState();
  console.log(`    cycles de synchronisation tentés : ${etat.sync.attempts}`);
  check('…alors que des cycles périodiques ont bien tourné en parallèle',
    etat.sync.attempts > 3);
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('PUSH_IN_FLIGHT_DOES_NOT_DROP_NEW_CHANGE — A → B → C → D en rafale');
{
  const t0 = Date.now();
  await A.renameCompany({ name: 'Rafale A' });
  await A.renameCompany({ name: 'Rafale B' });
  await A.renameCompany({ name: 'Rafale C' });
  await A.renameCompany({ name: 'Rafale D' });

  const r = await attendreNom(A.projectId, 'Rafale D', 20_000);
  const total = Date.now() - t0;
  mesures.push({ cas: 'rafale A→D', ms: total, atteint: r.atteint });

  check(`LE PANEL FINIT SUR D (${total} ms)`, r.atteint);
  check('…et n’est pas resté sur un état intermédiaire',
    !['Rafale A', 'Rafale B', 'Rafale C'].includes(r.fiche.name));
  await derniereEcritureScellee(A);
  check('…l’outbox est vide', (await A.outboxPending()) === 0);

  /**
   * AUCUN RETOUR EN ARRIÈRE. On relit une seconde fois, après un délai : si une
   * écriture périmée traînait encore en file, elle réécrirait un ancien nom.
   */
  await new Promise((rs) => { setTimeout(rs, 1500); });
  check('…et D tient dans la durée (aucune écriture périmée ne le remplace)',
    (await ficheApi(A.projectId)).name === 'Rafale D');
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('HEARTBEAT_DOES_NOT_ADVANCE_BUSINESS_ACK — sous ordonnanceur réel');
{
  const avant = await ficheApi(A.projectId);
  await new Promise((r) => { setTimeout(r, 900); }); // plusieurs battements à 200 ms
  const apres = await ficheApi(A.projectId);

  check('le dernier contact a avancé (l’ordonnanceur bat)',
    apres.dates.lastHeartbeatAt !== avant.dates.lastHeartbeatAt);
  check('…la fraîcheur métier, elle, n’a pas bougé',
    apres.dates.lastBusinessSyncAt === avant.dates.lastBusinessSyncAt);
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('UN PROJET QUI A UN LOGO — la configuration de TOUTE production');

/**
 * ══ CE QUE CETTE SECTION A PROUVÉ, ET CE QU'ELLE GARDE ══════════════════════
 *
 * Tout ce qui précède passait déjà — et pourtant le symptôme était réel en
 * production. La seule différence structurelle entre l'instance de ce harnais
 * et une instance déployée tenait en une ligne de configuration : une
 * entreprise de production a un LOGO.
 *
 * `describeProjectPresentation` publie alors le DESCRIPTEUR complet du média
 * (`logo`, `favicon`). Le schéma du Panel, `.strict()`, ne connaissait que
 * `logoUrl` / `faviconUrl` : toute présentation d'une instance déployée était
 * donc REFUSÉE, définitivement et en silence. C'est la cause qu'a isolée L0.
 *
 * Le lot L1 a fermé l'écart. Cette section VERROUILLE le résultat : elle
 * échouera de nouveau le jour où l'émetteur publiera un champ que le contrat
 * ignore — c'est-à-dire le jour où le même défaut reviendrait.
 *
 * (La preuve détaillée du refus, de sa visibilité et de sa réparation vit
 * dans `project-presentation-media-contract-e2e.test.js`.)
 */
{
  await A.setCompanyLogo({ url: 'https://cdn.exemple.fr/logo.png' });

  const projection = await A.buildPresentation();
  const clefs = Object.keys(projection.payload ?? {});
  console.log(`    clés publiées par le projet : ${clefs.join(', ')}`);
  check('le projet publie bien un descripteur de média (`logo`)',
    Object.prototype.hasOwnProperty.call(projection.payload ?? {}, 'logo'));

  const t0 = Date.now();
  await A.renameCompany({ name: 'Avec logo' });
  const r = await attendreNom(A.projectId, 'Avec logo', 8_000);
  const latence = Date.now() - t0;
  mesures.push({ cas: 'projet AVEC logo', ms: latence, atteint: r.atteint });

  const derniere = await derniereEcritureScellee(A);
  console.log(`    statut de l’écriture : ${derniere?.status} · tentatives ${derniere?.attempts}`);

  check(`COMPANY_CHANGE_IS_LIVE avec média (${latence} ms)`, r.atteint);
  check('…l’écriture est ACQUITTÉE, pas refusée', derniere?.status === 'ACKNOWLEDGED');
  check('…le descripteur a traversé le pont',
    (await ficheApi(A.projectId)).presentation?.logo?.url === 'https://cdn.exemple.fr/logo.png');
  check('…et aucun refus n’est ouvert', (await A.outboxHealth()).rejected === 0);
}

await A.stopScheduler();

/* ══════════════════════════════════════════════════════════════════════════ */
section('MESURES');
for (const m of mesures) {
  console.log(`    ${m.cas.padEnd(24)} ${String(m.ms).padStart(6)} ms  ${m.atteint ? '' : '(NON ATTEINT)'}`);
}

for (const inst of instances) await inst.stop();
await closePanel();
await stopMemoryMongo();
finish();
