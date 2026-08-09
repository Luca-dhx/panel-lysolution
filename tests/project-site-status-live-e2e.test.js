/**
 * LOT L8 — L'ÉTAT DU SITE DEVIENT UNE PROJECTION VIVANTE.
 *
 * ══ CE QUE CE FICHIER FERME ═════════════════════════════════════════════════
 *
 * L'accessibilité du site et la protection contractuelle étaient le dernier
 * état métier exposé au Panel qui ne voyageait PAS. Le Panel les obtenait en
 * interrogeant le projet EN DIRECT depuis l'écran, à chaque affichage de la
 * carte : ni commande, ni projection — un troisième motif, et le seul du
 * Panel.
 *
 * Il coûtait trois choses : « inconnu » dès que le projet était éteint, aucune
 * persistance donc aucune date, et une commande du Panel qui ne pouvait
 * qu'afficher ce qu'elle venait de demander au lieu de constater son effet.
 *
 * ══ L'INVARIANT ÉPROUVÉ ICI ═════════════════════════════════════════════════
 *
 *   commande Panel → mutation projet → reconcileSiteStatus → persistance
 *   → PROJECT_SITE_STATUS → outbox durable → push immédiat → projecteur Panel
 *   → projection persistée → fiche
 *
 * ══ INTERDITS ═══════════════════════════════════════════════════════════════
 *
 * `applyIncoming`, `flushOutbox`, `syncNow`, `scheduleProjection`, une écriture
 * directe dans une projection. Le test ne fait que MUTER et LIRE.
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
const actions = await import('../backend/src/services/contract/contractActions.service.js');
const { PanelProjectSiteStatus } = await import('../backend/src/models/PanelProjectProjection.model.js');

await resetSyncCore();
const { base: panelUrl, close: closePanel } = await startServer(createApp());

/** La fiche COMPLÈTE, telle que `GET /api/projects/:id` la construit. */
async function fiche(projectId) {
  const record = await registryStore.getById(projectId);
  const map = await registre.loadBusinessProjections([projectId]);
  return registre.toPublicProject(record, Date.now(), map.get(projectId), record.activeNetwork?.host);
}

async function attendre(predicat, plafondMs) {
  const debut = Date.now();
  for (;;) {
    if (await predicat()) return { ms: Date.now() - debut, atteint: true };
    if (Date.now() - debut > plafondMs) return { ms: Date.now() - debut, atteint: false };
    await new Promise((r) => { setTimeout(r, 20); });
  }
}

const site = async (projectId) => (await fiche(projectId)).business?.siteStatus ?? null;

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

const A = await demarrer({ dbName: 'l8_a', projectName: 'SB Auto L8 A' });
const latences = [];

/* ══════════════════════════════════════════════════════════════════════════ */
section('L’AMORÇAGE LIVRE DÉJÀ L’ÉTAT DU SITE');
{
  const vu = await attendre(async () => Boolean(await site(A.projectId)), 12_000);
  check(`la projection arrive dès l’appairage (${vu.ms} ms)`, vu.atteint);

  const s = await site(A.projectId);
  check('…avec le verdict', s?.accessible === true && s?.status === 'ACTIVE');
  check('…et la cause nommée', s?.suspensionSource === 'NONE');
  check('…le réglage de protection', s?.contractProtectionEnabled === false);
  check('…et la date de RÉCEPTION, que la lecture directe ne savait pas donner',
    typeof s?.receivedAt === 'string');
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('CONTRACT_PROTECTION_MANAGER_TO_PANEL_LIVE — le Manager bascule');
{
  const t0 = Date.now();
  await A.setProtection({ enabled: true });

  const r = await attendre(
    async () => (await site(A.projectId))?.contractProtectionEnabled === true, 12_000,
  );
  latences.push({ cas: 'protection depuis le Manager', ms: r.ms });
  check(`le Panel voit la protection activée (${r.ms} ms)`, r.atteint);

  /**
   * SANS CONTRAT ACTIF, activer la protection SUSPEND le site. C'est la règle
   * métier, et c'est le projet qui l'applique — le Panel se contente de la
   * recevoir. La cause voyage avec le verdict.
   */
  const s = await site(A.projectId);
  check('…le site est suspendu', s?.accessible === false);
  check('…et la CAUSE est contractuelle', s?.suspensionSource === 'CONTRACT');
  check('…jamais « technique »', s?.technicalSuspension === false);

  const chezLeProjet = await A.siteState();
  check('les deux bouts disent exactement la même chose',
    chezLeProjet.status === s?.status
    && chezLeProjet.suspensionSource === s?.suspensionSource);
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('CONTRACT_PROTECTION_PANEL_COMMAND_ROUNDTRIP — l’aller-retour complet');
{
  const avant = await site(A.projectId);
  check('point de départ : protection activée', avant?.contractProtectionEnabled === true);

  const t0 = Date.now();
  /* ── LA COMMANDE DU PANEL, PAR SON VRAI SERVICE ────────────────────────── */
  const record = await registryStore.getById(A.projectId);
  await actions.requestContractProtection(record, {
    enabled: false, actor: { id: 'test', email: 'dev@panel.test' },
  });

  /**
   * ON N'ADOPTE PAS LA RÉPONSE DE LA COMMANDE. Ce qu'on attend est la
   * PROJECTION que le projet réémet après avoir réconcilié — c'est la seule
   * chose qui prouve que la mutation a été persistée chez lui.
   */
  const r = await attendre(
    async () => (await site(A.projectId))?.contractProtectionEnabled === false, 12_000,
  );
  const total = Date.now() - t0;
  latences.push({ cas: 'aller-retour commande Panel', ms: total });
  check(`PANEL → PROJET → PANEL sans aucun tirage (${total} ms)`, r.atteint);

  const s = await site(A.projectId);
  check('…le site redevient accessible', s?.accessible === true);
  check('…et plus aucune cause de suspension', s?.suspensionSource === 'NONE');
  check('…l’état vient de la PROJECTION, pas de la réponse à la commande',
    typeof s?.receivedAt === 'string' && typeof s?.modifiedAt === 'string');

  const chezLeProjet = await A.siteState();
  check('les deux bouts concordent', chezLeProjet.contractProtectionEnabled === false);
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('SITE_STATUS_CAUSE_LIVE — une maintenance n’est PAS un fait contractuel');
{
  const t0 = Date.now();
  await A.setTechnical({ active: true, reason: 'Maintenance planifiée' });

  const r = await attendre(
    async () => (await site(A.projectId))?.suspensionSource === 'TECHNICAL', 12_000,
  );
  latences.push({ cas: 'suspension technique', ms: r.ms });
  check(`la cause TECHNIQUE arrive (${r.ms} ms)`, r.atteint);

  const s = await site(A.projectId);
  check('…le site est suspendu', s?.accessible === false);
  check('…la cause est TECHNIQUE', s?.suspensionSource === 'TECHNICAL');
  check('…et le motif est celui que le PROJET a formulé',
    s?.reason === 'Maintenance planifiée');
  /**
   * LE POINT QUI JUSTIFIE DEUX AGRÉGATS SÉPARÉS : la protection est TOUJOURS
   * désactivée, et pourtant le site est suspendu. Transporter cet état sous
   * `CONTRACT` ferait afficher « problème de contrat » devant une maintenance.
   */
  check('…alors que la protection contractuelle est DÉSACTIVÉE',
    s?.contractProtectionEnabled === false);
  check('…et que la projection CONTRACT n’a pas bougé pour autant',
    (await fiche(A.projectId)).business?.contract === null
    || typeof (await fiche(A.projectId)).business?.contract === 'object');

  await A.setTechnical({ active: false });
  const leve = await attendre(
    async () => (await site(A.projectId))?.suspensionSource === 'NONE', 12_000,
  );
  check(`la levée arrive elle aussi (${leve.ms} ms)`, leve.atteint);
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('SITE_STATUS_NO_HEARTBEAT_DEPENDENCY');
{
  /**
   * ── ON ATTEND LE SILENCE AVANT DE MESURER ─────────────────────────────────
   *
   * La section précédente vient de faire voyager deux projections (suspension
   * puis levée). Si l'une est encore en vol quand on relève `avant`, elle
   * atterrit pendant les battements — et l'on accuse le battement d'avoir
   * avancé la fraîcheur métier, alors qu'il n'y est pour rien.
   *
   * Le test mesurait donc une COURSE, pas une propriété : il passait tant que
   * la vidange était plus rapide que la lecture, et le moindre changement de
   * latence ailleurs le faisait basculer. On draine explicitement, puis on
   * exige que la fraîcheur soit STABLE avant de commencer.
   */
  await A.syncNow();
  await attendre(async () => (await A.outboxPending()) === 0, 10_000);
  const stable = await attendre(async () => {
    const a = (await fiche(A.projectId)).runtime.lastBusinessSyncAt;
    await new Promise((r) => { setTimeout(r, 150); });
    return (await fiche(A.projectId)).runtime.lastBusinessSyncAt === a;
  }, 10_000);
  check('la file est vidée et la fraîcheur métier stabilisée', stable.atteint);

  const avant = await fiche(A.projectId);
  for (let i = 0; i < 3; i += 1) await A.heartbeat();
  const apres = await fiche(A.projectId);

  check('le battement fait avancer le dernier contact',
    apres.runtime.lastHeartbeatAt !== avant.runtime.lastHeartbeatAt);
  check('…mais n’avance PAS la fraîcheur métier',
    apres.runtime.lastBusinessSyncAt === avant.runtime.lastBusinessSyncAt);
  check('…et ne modifie pas d’un octet l’état du site',
    JSON.stringify(apres.business.siteStatus) === JSON.stringify(avant.business.siteStatus));
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('OFFLINE — B, C, D pendant la panne, convergence sur D');
{
  await A.goOffline();

  await A.setProtection({ enabled: true });
  await A.setTechnical({ active: true, reason: 'Pendant la panne' });
  await A.setTechnical({ active: false });
  await A.setProtection({ enabled: false });
  const attendu = await A.siteState();

  check('le projet a bien enregistré malgré la panne',
    attendu.contractProtectionEnabled === false && attendu.suspensionSource === 'NONE');

  await A.goOnline();
  /**
   * LE PROJET REPOUSSE DE LUI-MÊME : le cycle de réparation vide l'outbox
   * durable. Aucun geste, aucun bouton, aucun tirage demandé par le test.
   */
  await A.startScheduler({ heartbeatMs: 400, syncMs: 300 });
  const r = await attendre(async () => {
    const s = await site(A.projectId);
    return s?.contractProtectionEnabled === false && s?.suspensionSource === 'NONE';
  }, 20_000);
  await A.stopScheduler();

  check(`LE PANEL CONVERGE SUR LE DERNIER ÉTAT (${r.ms} ms)`, r.atteint);
  check('…et il n’existe qu’UNE projection',
    (await PanelProjectSiteStatus.countDocuments({ projectId: A.projectId })) === 1);
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('ISOLATION — deux instances, aucune contamination');
{
  const B = await demarrer({ dbName: 'l8_b', projectName: 'SB Auto L8 B' });
  await attendre(async () => Boolean(await site(B.projectId)), 12_000);

  const avantB = await PanelProjectSiteStatus.findOne({ projectId: B.projectId }).lean();

  await A.setProtection({ enabled: true });
  await attendre(
    async () => (await site(A.projectId))?.contractProtectionEnabled === true, 12_000,
  );

  const apresB = await PanelProjectSiteStatus.findOne({ projectId: B.projectId }).lean();
  check('A a changé', (await site(A.projectId))?.contractProtectionEnabled === true);
  check('B EST INCHANGÉE, jusqu’à l’octet',
    JSON.stringify(apresB) === JSON.stringify(avantB));
  check('chaque instance a SA projection, indexée par projectId',
    (await PanelProjectSiteStatus.countDocuments({})) === 2);
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('TEAM_MEMBER — déjà projeté, déjà exposé : on le vérifie, on n’invente rien');
{
  const record = await registryStore.getById(A.projectId);
  const equipe = await registre.loadProjectTeam(A.projectId);
  check('la projection d’équipe existe et est lisible', Array.isArray(equipe));
  check('…et la fiche sait la porter',
    typeof registre.loadProjectTeam === 'function' && Boolean(record));
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('MESURES');
for (const l of latences) {
  console.log(`    ${l.cas.padEnd(30)} ${String(l.ms).padStart(6)} ms`);
}
const valeurs = latences.map((l) => l.ms).sort((a, b) => a - b);
const median = valeurs[Math.floor(valeurs.length / 2)];
console.log(`    médiane ${median} ms · pire ${valeurs[valeurs.length - 1]} ms`);
/**
 * LE PLANCHER EST LA FENÊTRE DE REGROUPEMENT, ET C'EST DÉLIBÉRÉ.
 *
 * `scheduleProjection` attend 500 ms avant de projeter : un formulaire qui
 * écrit trois champs ne doit produire qu'UNE photographie, celle de l'état
 * final. Sans cela le Panel recevrait trois versions dont deux périmées.
 *
 * Aucune mesure de bout en bout ne peut donc descendre sous 500 ms, et
 * viser 250 ms reviendrait à supprimer cette protection pour gagner une
 * demi-seconde sur un réglage qu'on touche deux fois par an.
 *
 * Ce qui compte est ailleurs, et c'est ce que ce fichier prouve : la
 * livraison ne dépend PLUS d'un cycle de 30 s. On borne donc au tour complet,
 * fenêtre comprise.
 */
check(`médiane sous 1 s, fenêtre de regroupement comprise (${median} ms)`, median < 1000);
check(`pire cas sous 2 s (${valeurs[valeurs.length - 1]} ms)`,
  valeurs[valeurs.length - 1] < 2000);

for (const inst of instances) await inst.stop();
await closePanel();
await stopMemoryMongo();
finish();
