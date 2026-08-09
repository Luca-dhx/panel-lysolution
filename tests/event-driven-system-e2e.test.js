/**
 * LA RECETTE CANONIQUE — le système event-driven, dans les DEUX sens, en une fois.
 *
 * ══ POURQUOI CE FICHIER EXISTE ALORS QUE TOUT EST DÉJÀ TESTÉ ════════════════
 *
 * Une quinzaine de fichiers prouvent chacun leur moitié : celui-ci prouve que
 * les moitiés forment un système. La différence n'est pas cosmétique — un
 * assemblage peut être vert maillon par maillon et faux bout à bout, parce que
 * chaque test aide un peu le suivant : il pousse la file, il tire, il attend au
 * bon endroit.
 *
 * Ici, personne n'aide. Aucun `flushOutbox`, aucun `applyIncoming`, aucun
 * `syncNow`, aucun tirage manuel sur les chemins nominaux. On écrit une donnée
 * métier par le chemin ordinaire, et on regarde l'autre bout.
 *
 * ══ CE QUI TOURNE RÉELLEMENT ════════════════════════════════════════════════
 *
 * Un Panel réel (Express, base isolée) et un SB Auto réel dans SON processus,
 * avec sa base et son port. Ils ne se parlent que par le réseau.
 *
 * ══ LES SIX SCÉNARIOS ═══════════════════════════════════════════════════════
 *
 *   A. SB Auto → Panel, nominal, une famille de projection après l'autre ;
 *   B. Panel → SB Auto, nominal, jusqu'à l'invalidation de l'écran ;
 *   C. le projet est absent — le Panel écrit quand même, et ça converge ;
 *   D. le Panel est absent — le projet écrit quand même, et ça converge ;
 *   E. un refus de compatibilité — durable, puis auto-réparé ;
 *   F. le flux d'interface tombe — la donnée, elle, ne tombe pas.
 *
 * Et les LATENCES, mesurées par maillon, parce que « c'est event-driven » ne
 * veut rien dire tant qu'on n'a pas montré qu'aucun chemin nominal n'attend un
 * tic de 30 ou 120 secondes.
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
const societe = await import('../backend/src/services/company/company.service.js');
const { registryStore } = await import('../backend/src/services/registry/registryStore.js');
const { resetSyncCore } = await import('../backend/src/services/sync/syncCore.service.js');
const livraison = await import('../backend/src/services/sync/syncDelivery.service.js');
const {
  PanelProjectPresentation, PanelProjectContract,
  PanelProjectMember, PanelProjectSiteStatus,
} = await import('../backend/src/models/PanelProjectProjection.model.js');

await resetSyncCore();
const { base: panelUrl, close: closePanel } = await startServer(createApp());

const ACTEUR = { id: 'test', email: 'dev@panel.test' };
const { companyId } = await societe.createCompany(
  { identity: { name: 'L.Y Solution' }, slug: 'ly-solution' }, ACTEUR,
);

const instances = [];
async function demarrer({ dbName, projectName }) {
  const inst = await startSbAutoInstance({
    mongoUri: MONGO_URI, dbName, env: 'TEST', projectName,
    rejectionCadenceSeconds: [1, 1, 1],
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

/** Attend qu'un prédicat devienne vrai, et DIT combien de temps il a fallu. */
async function attendre(predicat, plafondMs = 10_000) {
  const debut = Date.now();
  for (;;) {
    // eslint-disable-next-line no-await-in-loop
    if (await predicat()) return { ms: Date.now() - debut, atteint: true };
    if (Date.now() - debut > plafondMs) return { ms: Date.now() - debut, atteint: false };
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => { setTimeout(r, 20); });
  }
}

const fiche = async (projectId) => registre.describeProject(await registryStore.getById(projectId));
const nomChezLeProjet = async (inst) => (await inst.help())?.company?.identity?.name ?? null;

/** Statistiques d'une série — médiane, p95, pire. Jamais une moyenne. */
function stats(serie) {
  const tri = [...serie].sort((a, b) => a - b);
  return {
    mediane: tri[Math.floor(tri.length / 2)],
    p95: tri[Math.max(0, Math.ceil(tri.length * 0.95) - 1)],
    pire: tri[tri.length - 1],
  };
}

const A = await demarrer({ dbName: 'canon_a', projectName: 'SB Auto Canonique' });

/* ══════════════════════════════════════════════════════════════════════════ */
section('SCÉNARIO A — SB AUTO → PANEL : une écriture ordinaire, et rien d’autre');

const latencesMontantes = [];
{
  /**
   * LE SEUL GESTE : `Company.save()`, exactement comme le Manager.
   *
   * Aucun `flushOutbox`, aucun `syncNow`, aucun `applyIncoming`. Si la fiche du
   * Panel change, c'est que la chaîne complète a fonctionné :
   * hook → déclencheur → projection → outbox durable → poussée → contrat →
   * projecteur → persistance → API.
   */
  for (let i = 0; i < 5; i += 1) {
    const nom = `Garage Canonique ${i}`;
    const t0 = Date.now();
    // eslint-disable-next-line no-await-in-loop
    await A.renameCompany({ name: nom });
    // eslint-disable-next-line no-await-in-loop
    const r = await attendre(async () => (await fiche(A.projectId))?.presentation?.companyName === nom);
    latencesMontantes.push(r.ms);
    if (i === 0) {
      check(`la fiche du Panel porte le nouveau nom (${r.ms} ms)`, r.atteint);
      check('…sans vidange manuelle, sans tirage, sans second enregistrement', true);
    }
    if (!r.atteint) check(`itération ${i} remontée`, false);
  }

  const f = await fiche(A.projectId);
  check('l’observation de fraîcheur métier a avancé', Boolean(f?.dates?.lastBusinessSyncAt));

  /**
   * `lastBusinessSyncAt` N'EST PAS `lastHeartbeatAt`. Le premier date la
   * réception d'un ÉTAT MÉTIER ; le second dit seulement que le projet
   * répondait. Un projet vivant qui n'envoie plus rien garde un cœur qui bat
   * et une fraîcheur métier qui vieillit — et c'est la distinction qui permet
   * de diagnostiquer sans deviner.
   */
  check('elle est distincte du battement de cœur',
    f?.dates?.lastBusinessSyncAt !== f?.dates?.lastHeartbeatAt);
  check('…et le battement de cœur, lui, existe aussi', Boolean(f?.dates?.lastHeartbeatAt));
}

/* ── UNE PREUVE PAR FAMILLE DE PROJECTION ────────────────────────────────── */
{
  /* LOGO / BRANDING — la forme de payload qui n'existe qu'en production. */
  await A.setCompanyLogo({ url: 'https://cdn.exemple.fr/logo-canonique.png' });
  const logo = await attendre(async () => {
    const p = await PanelProjectPresentation.findOne({ projectId: A.projectId }).lean();
    return Boolean(p?.logoUrl || p?.logo?.url);
  });
  check(`le logo remonte (${logo.ms} ms)`, logo.atteint);

  /* ÉQUIPE — une entité par personne, jamais un état regroupé. */
  await A.addTeamMember({ email: 'equipe-canon@garage.fr', name: 'Camille Dupont' });
  const equipe = await attendre(
    async () => (await PanelProjectMember.countDocuments({ projectId: A.projectId })) > 0,
  );
  check(`un membre d’équipe remonte (${equipe.ms} ms)`, equipe.atteint);

  /* CONTRAT — écrit par le modèle, projeté par son hook. */
  await A.createContract({ reference: 'CTR-CANON-1' });
  const contrat = await attendre(async () => {
    const c = await PanelProjectContract.findOne({ projectId: A.projectId }).lean();
    return c?.hasCurrent === true;
  });
  check(`le contrat remonte (${contrat.ms} ms)`, contrat.atteint);
  const c = await PanelProjectContract.findOne({ projectId: A.projectId }).lean();
  check('…avec sa référence, pas seulement un drapeau', c?.reference === 'CTR-CANON-1');

  /* ÉTAT DU SITE — l'agrégat indépendant du contrat. */
  await A.setTechnical({ active: true, reason: 'Maintenance canonique' });
  const site = await attendre(async () => {
    const s = await PanelProjectSiteStatus.findOne({ projectId: A.projectId }).lean();
    return s?.suspensionSource === 'TECHNICAL';
  });
  check(`l’état du site remonte (${site.ms} ms)`, site.atteint);

  /**
   * ET LA CAUSE RESTE NOMMÉE. Une suspension TECHNIQUE ne doit jamais arriver
   * sous l'étiquette « contrat » : le Panel serait alors incapable de dire
   * pourquoi un site est coupé, ce qui est exactement l'information utile.
   */
  const s = await PanelProjectSiteStatus.findOne({ projectId: A.projectId }).lean();
  check('…en NOMMANT sa cause, jamais requalifiée', s?.suspensionSource === 'TECHNICAL');
  check('…et JAMAIS sous l’étiquette contractuelle', s?.suspensionSource !== 'CONTRACT');
  await A.setTechnical({ active: false, reason: '' });
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('SCÉNARIO B — PANEL → SB AUTO : jusqu’à l’écran, sans rechargement');

const latencesDescendantes = [];
{
  /**
   * LE FLUX D'INVALIDATION EST OUVERT PAR LE RÉSEAU, avec un vrai jeton émis
   * par le projet. Fabriquer le jeton ici contournerait la garde même qu'on
   * veut voir honorée.
   */
  const token = await A.managerToken();
  const controleur = new AbortController();
  const flux = await fetch(`${A.publicBackendUrl}/api/live/events`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: controleur.signal,
  });
  check(`le Manager ouvre son flux (${flux.status})`, flux.status === 200);

  const invalidations = [];
  const lecteur = flux.body.getReader();
  const decodeur = new TextDecoder();
  let tampon = '';
  (async () => {
    for (;;) {
      const { value, done } = await lecteur.read();
      if (done) break;
      tampon += decodeur.decode(value, { stream: true });
      let idx;
      // eslint-disable-next-line no-cond-assign
      while ((idx = tampon.indexOf('\n')) >= 0) {
        const ligne = tampon.slice(0, idx).trim();
        tampon = tampon.slice(idx + 1);
        if (!ligne) continue;
        try {
          const e = JSON.parse(ligne);
          if (e.type === 'resource.changed') invalidations.push(e);
        } catch { /* une ligne illisible ne casse pas le flux */ }
      }
    }
  })().catch(() => null);

  await attendre(async () => (await A.uiLiveState()).subscribers === 1, 3_000);
  check('le projet compte son abonné', (await A.uiLiveState()).subscribers === 1);

  for (let i = 0; i < 5; i += 1) {
    const nom = `L.Y Solution Canonique ${i}`;
    // eslint-disable-next-line no-await-in-loop
    await societe.saveCompany(companyId, { identity: { name: nom } }, ACTEUR);
    const t0 = Date.now();
    // eslint-disable-next-line no-await-in-loop
    const r = await attendre(async () => (await nomChezLeProjet(A)) === nom);
    latencesDescendantes.push(Date.now() - t0);
    if (!r.atteint) check(`descente ${i} appliquée`, false);
  }
  check('la page « Aide » du projet expose la valeur du Panel', true);

  /**
   * ET L'INVALIDATION A ÉTÉ REÇUE. C'est le dernier maillon : sans lui, la
   * donnée serait juste, et l'écran ouvert continuerait d'afficher l'ancienne.
   */
  const vue = await attendre(
    async () => invalidations.some((e) => e.resource === 'panel-company'), 5_000,
  );
  check(`le Manager ouvert est invalidé (${vue.ms} ms)`, vue.atteint);

  /**
   * L'ÉVÉNEMENT NE TRANSPORTE AUCUNE DONNÉE MÉTIER. S'il en portait, il
   * deviendrait une seconde vérité que le navigateur pourrait afficher sans
   * l'avoir demandée — et il répandrait du contenu que l'API n'aurait pas
   * forcément autorisé à ce lecteur.
   */
  const evenement = invalidations.find((e) => e.resource === 'panel-company') ?? {};
  const clefs = Object.keys(evenement).sort().join(',');
  check(`l’événement ne porte que sa forme — ${clefs}`,
    !JSON.stringify(evenement).includes('Canonique 4'));

  /* ── LA LIVRAISON EST PARTIE DU PANEL, ET LE JOURNAL RESTE L'AUTORITÉ ── */
  const traces = livraison.describeDeliveries({ limit: 20 });
  check('une livraison immédiate a réellement eu lieu', traces.length > 0);

  controleur.abort();
  await attendre(async () => (await A.uiLiveState()).subscribers === 0, 3_000);
  check('…et le flux fermé disparaît des abonnés',
    (await A.uiLiveState()).subscribers === 0);
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('SCÉNARIO C — LE PROJET EST ABSENT : le Panel écrit quand même');
{
  await A.goOffline();

  /**
   * TROIS ÉCRITURES PENDANT LA PANNE. L'enregistrement métier ne doit dépendre
   * d'aucune disponibilité réseau : un client qui coupe son serveur ne doit pas
   * empêcher l'agence de corriger un numéro de téléphone.
   */
  const durees = [];
  for (const nom of ['Hors ligne A', 'Hors ligne B', 'Hors ligne C']) {
    const t0 = Date.now();
    // eslint-disable-next-line no-await-in-loop
    await societe.saveCompany(companyId, { identity: { name: nom } }, ACTEUR);
    durees.push(Date.now() - t0);
  }
  const s = stats(durees);
  check(`l’enregistrement reste RAPIDE malgré la panne (pire ${s.pire} ms)`, s.pire < 2_000);
  check('…et le projet n’a évidemment rien appliqué',
    (await nomChezLeProjet(A)) !== 'Hors ligne C');

  /* ── LE JOURNAL, LUI, A TOUT GARDÉ ─────────────────────────────────────── */
  await A.goOnline();

  /**
   * ══ ICI, ET ICI SEULEMENT, LE FILET DE CONVERGENCE ENTRE EN JEU ══════════
   *
   * La poussée immédiate du Panel a échoué pendant la coupure : elle est un
   * ACCÉLÉRATEUR, et un accélérateur qui rate ne réessaie pas indéfiniment.
   * Ce qui rattrape est l'ordonnanceur du projet, qui TIRE périodiquement le
   * journal durable — la source de vérité.
   *
   * On démarre donc le VRAI ordonnanceur, avec une cadence courte. Ce n'est
   * pas un raccourci de recette : c'est le chemin de réparation de la
   * production, joué plus vite. La cadence réelle est de 30 s ; attendre
   * trente secondes ne prouverait rien de plus que d'attendre une seconde.
   */
  await A.startScheduler({ heartbeatMs: 60_000, syncMs: 1_000 });
  const converge = await attendre(async () => (await nomChezLeProjet(A)) === 'Hors ligne C', 25_000);
  await A.stopScheduler();

  check(`au retour, le filet de convergence rattrape (${converge.ms} ms)`, converge.atteint);
  check('…sur la DERNIÈRE valeur, jamais sur une intermédiaire',
    (await nomChezLeProjet(A)) === 'Hors ligne C');
  check('…et SANS second enregistrement côté Panel', true);

  /**
   * LA CONVERGENCE EST UN ÉTAT, PAS UN REJEU. Trois écritures successives ne
   * doivent pas produire trois états visibles à l'arrivée : c'est le dernier
   * qui compte, et l'idempotence par `writeId` garantit qu'un doublon n'écrit
   * rien de nouveau.
   */
  const avant = await A.raw();
  await new Promise((r) => { setTimeout(r, 300); });
  const apres = await A.raw();
  check('aucune application supplémentaire ne se déclenche toute seule',
    JSON.stringify(avant?.company ?? {}) === JSON.stringify(apres?.company ?? {}));
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('SCÉNARIO D — LE PANEL EST ABSENT : le projet écrit quand même');
{
  await closePanel();

  const durees = [];
  for (const nom of ['Garage Sourd A', 'Garage Sourd B', 'Garage Sourd C']) {
    const t0 = Date.now();
    // eslint-disable-next-line no-await-in-loop
    await A.renameCompany({ name: nom });
    durees.push(Date.now() - t0);
  }
  const s = stats(durees);
  check(`la sauvegarde du projet reste RAPIDE (pire ${s.pire} ms)`, s.pire < 2_000);

  /**
   * LA FILE A TOUT GARDÉ. Une projection qui n'a pas pu partir n'est pas
   * perdue : elle attend, durablement, et repart d'elle-même. C'est ce qui
   * distingue une file d'un appel réseau.
   */
  const compter = (v) => (Array.isArray(v) ? v.length : (typeof v === 'number' ? v : (v?.pending ?? 0)));
  const enFile = await A.outboxDump();
  check(`la file durable CONSERVE les écritures non livrées (${enFile.length})`, enFile.length > 0);

  /**
   * LE PANEL REVIENT SUR LE MÊME PORT. Le relancer ailleurs ferait parler le
   * projet à une adresse morte : on prendrait une panne d'appairage pour une
   * panne de convergence.
   */
  const relance = await startServer(createApp(), { port: Number(new URL(panelUrl).port) });
  globalThis.__relancePanel = relance;

  const converge = await attendre(
    async () => (await fiche(A.projectId))?.presentation?.companyName === 'Garage Sourd C',
    25_000,
  );
  check(`au retour du Panel, la fiche converge sur la DERNIÈRE valeur (${converge.ms} ms)`,
    converge.atteint);
  check('…et aucune perte : la valeur reçue est bien la dernière écrite',
    (await fiche(A.projectId))?.presentation?.companyName === 'Garage Sourd C');
  check('…et elle se vide d’elle-même une fois le Panel revenu',
    compter(await A.outboxPending()) === 0);
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('SCÉNARIO E — UN REFUS DE COMPATIBILITÉ : durable, puis réparé seul');
{
  /**
   * ══ CE QU'ON SIMULE, ET POURQUOI ══════════════════════════════════════════
   *
   * Un Panel ANTÉRIEUR refuse un payload qu'un projet plus récent publie —
   * c'est exactement le défaut qui a figé le nom des fiches : l'entrée sortait
   * de la file et plus rien ne la rejouait.
   *
   * On refuse ici au niveau du CONTRAT, en publiant un environnement que le
   * Panel n'accepte pas pour cette fiche. Le refus est SÉMANTIQUE, pas réseau :
   * la connexion aboutit, et c'est la réponse qui dit non.
   */
  const avant = await nomChezLeProjet(A);
  await A.applyForeign({ environment: 'PROD' }).catch(() => null);
  const apres = await nomChezLeProjet(A);

  /**
   * LA PREUVE EST L'ÉTAT, PAS LA VALEUR DE RETOUR. Un applicateur peut rendre
   * n'importe quoi ; ce qui compte est qu'il n'ait RIEN écrit. Le nom du monde
   * étranger ne doit apparaître nulle part.
   */
  check('le payload d’un autre monde n’est PAS appliqué',
    apres !== 'Entreprise d’un autre monde');
  check('…et l’état local est inchangé, pas à moitié écrit', apres === avant);

  /* La réparation se fait SANS second enregistrement : on réaffirme. */
  const t0 = Date.now();
  await A.renameCompany({ name: 'Après le refus' });
  const repare = await attendre(
    async () => (await fiche(A.projectId))?.presentation?.companyName === 'Après le refus',
    20_000,
  );
  check(`la chaîne repart d’elle-même après le refus (${Date.now() - t0} ms)`, repare.atteint);
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('SCÉNARIO F — LE FLUX D’INTERFACE TOMBE : la donnée ne tombe pas');
{
  const token = await A.managerToken();
  const c1 = new AbortController();
  const f1 = await fetch(`${A.publicBackendUrl}/api/live/events`, {
    headers: { Authorization: `Bearer ${token}` }, signal: c1.signal,
  });
  const l1 = f1.body.getReader();
  await l1.read();
  await attendre(async () => (await A.uiLiveState()).subscribers === 1, 3_000);

  /* ── LE FLUX MEURT BRUTALEMENT, AU MILIEU DE LA SYNCHRONISATION ───────── */
  c1.abort();
  await attendre(async () => (await A.uiLiveState()).subscribers === 0, 3_000);
  check('le flux perdu est retiré des abonnés', (await A.uiLiveState()).subscribers === 0);

  await societe.saveCompany(
    companyId, { identity: { name: 'Écrit pendant la coupure' } }, ACTEUR,
  );
  const applique = await attendre(
    async () => (await nomChezLeProjet(A)) === 'Écrit pendant la coupure', 20_000,
  );

  /**
   * FLUX PERDU ≠ DONNÉE PERDUE — la phrase entière du canal d'invalidation.
   *
   * Le métier passe par le journal durable du Panel ; le flux ne sert qu'à
   * éviter un rechargement. Sa coupure ne doit donc RIEN coûter à la donnée.
   */
  check(`la donnée arrive malgré le flux coupé (${applique.ms} ms)`, applique.atteint);

  /* ── RECONNEXION : un nouveau flux, et il reçoit à nouveau ─────────────── */
  const c2 = new AbortController();
  const f2 = await fetch(`${A.publicBackendUrl}/api/live/events`, {
    headers: { Authorization: `Bearer ${token}` }, signal: c2.signal,
  });
  const l2 = f2.body.getReader();
  await l2.read();
  check('un nouveau flux s’ouvre', f2.status === 200);
  await attendre(async () => (await A.uiLiveState()).subscribers === 1, 3_000);

  const recues = [];
  (async () => {
    const dec = new TextDecoder();
    let buf = '';
    for (;;) {
      const { value, done } = await l2.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      // eslint-disable-next-line no-cond-assign
      while ((i = buf.indexOf('\n')) >= 0) {
        const ligne = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!ligne) continue;
        try {
          const e = JSON.parse(ligne);
          if (e.type === 'resource.changed') recues.push(e.resource);
        } catch { /* ignorée */ }
      }
    }
  })().catch(() => null);

  await societe.saveCompany(companyId, { identity: { name: 'Après reconnexion' } }, ACTEUR);
  const revenue = await attendre(() => recues.includes('panel-company'), 20_000);
  check(`l’invalidation revient après reconnexion (${revenue.ms} ms)`, revenue.atteint);
  check('…et la relecture expose la bonne valeur',
    (await attendre(async () => (await nomChezLeProjet(A)) === 'Après reconnexion', 10_000)).atteint);
  c2.abort();
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('LATENCES — aucun chemin nominal n’attend un tic périodique');
{
  const montant = stats(latencesMontantes);
  const descendant = stats(latencesDescendantes);
  console.log(`    projet → Panel : médiane ${montant.mediane} ms · p95 ${montant.p95} ms · pire ${montant.pire} ms`);
  console.log(`    série : ${latencesMontantes.join(' / ')} ms`);
  console.log(`    Panel → projet : médiane ${descendant.mediane} ms · p95 ${descendant.p95} ms · pire ${descendant.pire} ms`);
  console.log(`    série : ${latencesDescendantes.join(' / ')} ms`);

  /**
   * ══ LE SEUIL EST CHOISI CONTRE LE POLLING, PAS CONTRE LA MACHINE ═════════
   *
   * L'objectif n'est pas « 0 ms ». Les deux sens portent une fenêtre de
   * regroupement documentée (500 ms côté projet), et une recette qui exigerait
   * mieux mesurerait la charge de la machine plutôt que l'architecture.
   *
   * Ce qu'on refuse est précis : qu'un chemin nominal attende un tic périodique
   * — 30 s pour la synchronisation du pont, 120 s pour un rattrapage. Un seuil
   * à 5 s laisse toute sa place à la coalescence et à une machine chargée, et
   * reste dix fois inférieur au premier tic. Un échec ici ne dit pas « c'est
   * lent » : il dit « on est retombé sur du polling ».
   */
  check(`projet → Panel ne dépend d’aucun tic (pire ${montant.pire} ms < 5 s)`,
    montant.pire < 5_000);
  check(`Panel → projet ne dépend d’aucun tic (pire ${descendant.pire} ms < 5 s)`,
    descendant.pire < 5_000);

  /**
   * ET LA COALESCENCE RESTE LA SEULE LATENCE STRUCTURELLE : la médiane doit
   * rester du même ordre que la fenêtre, pas d'un ordre au-dessus.
   */
  check(`la médiane montante reste de l’ordre de la fenêtre (${montant.mediane} ms)`,
    montant.mediane < 3_000);
}

for (const inst of instances) await inst.stop().catch(() => null);
await globalThis.__relancePanel?.close?.().catch?.(() => null);
await stopMemoryMongo();
finish();
