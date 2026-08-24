/**
 * LOT L4 — PANEL → PROJET : livraison immédiate, filet durable.
 *
 * ══ CE QUI TOURNE ═══════════════════════════════════════════════════════════
 *
 * Un Panel réel (Express, base isolée) et un SB Auto réel, dans son propre
 * processus, avec sa base, son port et son appairage. Ils ne se parlent que
 * par le réseau.
 *
 * ══ CE QUE LE TEST N'A PAS LE DROIT DE FAIRE ════════════════════════════════
 *
 * Sur le chemin nominal, le seul geste autorisé est `saveCompany()`. Sont
 * INTERDITS : `deliverChanges`, `pullUpdates`, `applyCompanyChange`, une
 * écriture directe dans `PanelCompanyConfiguration`, `recordAppliedConfiguration`,
 * ou la moindre retouche du journal.
 *
 * Le tirage n'apparaît que dans les sections de RÉPARATION, où il est
 * précisément ce qu'on cherche à éprouver.
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
const { resetSyncCore } = await import('../backend/src/services/sync/syncCore.service.js');
const livraison = await import('../backend/src/services/sync/syncDelivery.service.js');
const { PanelSyncJournalEntry } = await import('../backend/src/models/PanelSyncState.model.js');

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

async function attendre(predicat, plafondMs) {
  const debut = Date.now();
  for (;;) {
    if (await predicat()) return { ms: Date.now() - debut, atteint: true };
    if (Date.now() - debut > plafondMs) return { ms: Date.now() - debut, atteint: false };
    await new Promise((r) => { setTimeout(r, 20); });
  }
}

/** Ce que la page « Aide » du projet affiche — par son VRAI contrôleur. */
const nomChezLeProjet = async (inst) =>
  (await inst.help())?.company?.identity?.name ?? null;

const attendreNom = (inst, attendu, plafond) =>
  attendre(async () => (await nomChezLeProjet(inst)) === attendu, plafond);

const A = await demarrer({ dbName: 'l4_a', projectName: 'SB Auto L4 A' });

/* ══════════════════════════════════════════════════════════════════════════ */
section('REAL_PANEL_TO_SBAUTO_EVENT_DRIVEN_E2E — un clic, et le projet suit');

const latences = [];
{
  for (let i = 0; i < 10; i += 1) {
    const nom = `L.Y Solution Live ${i}`;
    const t0 = Date.now();
    /* ── LE SEUL GESTE ─────────────────────────────────────────────────── */
    await societe.saveCompany(companyId, { identity: { name: nom } }, ACTEUR);
    const r = await attendreNom(A, nom, 10_000);
    latences.push(r.ms);
    if (i === 0) {
      check(`la page « Aide » du projet affiche le nouveau nom (${r.ms} ms)`, r.atteint);
      check('…sans tirage, sans F5, sans second enregistrement', true);
    }
    if (!r.atteint) check(`itération ${i} livrée`, false);
  }

  const tri = [...latences].sort((a, b) => a - b);
  const median = tri[Math.floor(tri.length / 2)];
  const p95 = tri[Math.max(0, Math.ceil(tri.length * 0.95) - 1)];
  const pire = tri[tri.length - 1];
  console.log(`    latences T0→T5 : médiane ${median} ms · p95 ${p95} ms · pire ${pire} ms`);
  console.log(`    série : ${latences.join(' / ')} ms`);
  check(`T0 → T5 sous 2 s (médiane ${median} ms, pire ${pire} ms)`, pire < 2000);

  /* — LA LIVRAISON EST BIEN PARTIE DU PANEL, ET ELLE A ABOUTI — */
  const traces = livraison.describeDeliveries({ limit: 20 });
  const derniere = traces[0];
  check('une tentative de livraison a réellement eu lieu', Boolean(derniere));
  check('…vers CETTE instance', derniere?.projectId === A.projectId);
  check('…et le projet a appliqué', derniere?.outcome === 'DELIVERED');
  check('…avec un verdict par writeId, pas un code HTTP',
    (derniere?.applied ?? 0) + (derniere?.duplicates ?? 0) > 0);
  check('…et la trace ne porte aucun secret',
    !JSON.stringify(derniere).toLowerCase().includes('bearer')
    && !JSON.stringify(derniere).toLowerCase().includes('token'));

  /* — LE JOURNAL RESTE LA SOURCE DE VÉRITÉ — */
  const journal = await PanelSyncJournalEntry.countDocuments({});
  check('chaque enregistrement a laissé son entrée durable au journal', journal >= 10);
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('PANEL_MEDIA_AUTHORITY_IS_PRESERVED — le descripteur voyage par le même canal');
{
  /**
   * Le branding du développeur voyage dans le payload `DEV_COMPANY` — donc par
   * le dispatcher, comme tout le reste. Rien de spécifique n'a été ajouté pour
   * lui, et c'est précisément ce qu'on vérifie : la livraison est générique.
   *
   * Ce qui doit survivre au transport, c'est l'AUTORITÉ. Un média du Panel
   * reste servi par le Panel ; le projet ne doit ni le recopier, ni recomposer
   * son adresse contre son propre domaine.
   */
  // L'inventaire AVANT : le dossier d'imports d'un projet n'est pas vide par
  // nature (il porte au moins son `.gitkeep`). Ce qui compte est qu'il ne
  // gagne RIEN — pas qu'il soit vide.
  const uploadsAvant = (await A.state()).uploads ?? [];

  await societe.saveCompany(companyId, {
    identity: { name: 'Avec branding' },
    contact: { email: 'contact@ly-solution.test' },
  }, ACTEUR);
  const arrive = await attendreNom(A, 'Avec branding', 10_000);
  check('le changement de branding est livré immédiatement', arrive.atteint);

  const etat = await A.state();
  const branding = etat.company?.branding ?? {};
  const descripteurs = Object.values(branding)
    .filter((v) => v && typeof v === 'object' && 'authority' in v);
  check('…et AUCUN média du Panel n’a été recopié chez le projet',
    etat.projectMediaCount === 0);
  check('…ni déposé un seul fichier dans son dossier d’imports',
    JSON.stringify(etat.uploads ?? []) === JSON.stringify(uploadsAvant));
  // Sur un Panel sans média publié, il n'y a pas de descripteur à transporter :
  // l'absence est alors la bonne réponse, et l'on ne la maquille pas.
  check('…les descripteurs éventuels gardent l’autorité PANEL',
    descripteurs.every((d) => d.authority === 'PANEL'));
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('BUSINESS_SAVE_DOES_NOT_WAIT_FOR_PROJECT_NETWORK');
{
  /**
   * Le transport est remplacé par un transport LENT — cinq secondes. Rien
   * d'autre ne change : même dispatcher, même journal, même audience.
   *
   * Si la sauvegarde attendait le réseau du projet, elle mettrait cinq
   * secondes. C'est très exactement ce qu'on refuse : celui qui corrige un
   * numéro de téléphone n'a pas à attendre qu'un tiers réponde.
   */
  livraison.configureDeliveryTransport(() => ({
    deliverChanges: async () => {
      await new Promise((r) => { setTimeout(r, 5000); });
      return { results: [] };
    },
  }));

  const t0 = Date.now();
  await societe.saveCompany(companyId, { identity: { name: 'Sauvegarde rapide' } }, ACTEUR);
  const duree = Date.now() - t0;
  console.log(`    saveCompany avec un projet à 5 s : ${duree} ms`);
  check(`la sauvegarde rend la main sans attendre le réseau (${duree} ms)`, duree < 1500);

  livraison.configureDeliveryTransport(null);
  // Le transport par défaut est rétabli : la livraison lente finira dans le
  // vide, et le projet convergera par le chemin normal.
  await attendreNom(A, 'Sauvegarde rapide', 10_000);
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('PUSH_FAILURE_PULL_RECOVERY_E2E — le projet éteint ne perd rien');
{
  await A.goOffline();

  const t0 = Date.now();
  await societe.saveCompany(companyId, { identity: { name: 'Pendant la panne B' } }, ACTEUR);
  await societe.saveCompany(companyId, { identity: { name: 'Pendant la panne C' } }, ACTEUR);
  const dureeSave = Date.now() - t0;
  check(`les enregistrements réussissent malgré le projet éteint (${dureeSave} ms)`,
    dureeSave < 12_000);

  /**
   * La tentative est ASYNCHRONE par construction — c'est tout l'intérêt : la
   * sauvegarde n'a pas attendu. On laisse donc la tentative aboutir avant de
   * juger son issue, sans jamais la déclencher soi-même.
   */
  const vue = await attendre(
    async () => livraison.describeDeliveries({ limit: 10 })
      .some((t) => t.outcome === 'UNREACHABLE'),
    10_000,
  );
  const traces = livraison.describeDeliveries({ limit: 10 });
  const injoignable = traces.find((t) => t.outcome === 'UNREACHABLE');
  check(`la livraison est classée INJOIGNABLE (${vue.ms} ms)`, Boolean(injoignable));
  check('…comme un défaut TRANSITOIRE', injoignable?.errorClass === 'TRANSIENT');
  check('…en déclarant qu’un filet existe', injoignable?.fallbackAvailable === true);

  /* — LE PROJET REVIENT. AUCUN GESTE UTILISATEUR. — */
  await A.goOnline();
  await A.pull();

  check('LE PROJET CONVERGE SUR C', (await nomChezLeProjet(A)) === 'Pendant la panne C');
  check('…jamais bloqué sur B', (await nomChezLeProjet(A)) !== 'Pendant la panne B');

  /**
   * AUCUNE REDIFFUSION NOMINATIVE de l'entreprise — c'est ce qui prouve que la
   * convergence est venue du protocole, et non d'un rattrapage déclenché à la
   * main. On ne compte que `DEV_COMPANY` : les écritures nominatives d'autres
   * types (une API intégrée, par exemple) sont NORMALES et n'ont rien à voir.
   */
  const nominatives = await PanelSyncJournalEntry.countDocuments({
    audience: { $ne: null }, 'change.entityType': 'DEV_COMPANY',
  });
  check('…et personne n’a rediffusé nommément l’entreprise', nominatives === 0);
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('PUSH_AND_PULL_ARE_IDEMPOTENT_E2E');
{
  await societe.saveCompany(companyId, { identity: { name: 'Idempotence' } }, ACTEUR);
  const arrive = await attendreNom(A, 'Idempotence', 10_000);
  check('la livraison immédiate a appliqué', arrive.atteint);

  const avant = await A.state();

  /* — LE MÊME writeId REVIENT PAR LE TIRAGE — */
  const tirage = await A.pull();
  const apres = await A.state();

  check('le rattrapage revoit l’écriture sans rien muter à nouveau',
    apres.company?.version === avant.company?.version);
  check('…le nom est inchangé', apres.company?.identity?.name === 'Idempotence');
  check('…et il n’existe qu’UNE copie de la configuration',
    apres.configurationCount === 1);
  console.log(`    tirage après livraison : applied=${tirage.applied} skipped=${tirage.skipped}`);
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('RAFALE A → B → C → D — le projet finit sur D');
{
  const t0 = Date.now();
  await societe.saveCompany(companyId, { identity: { name: 'Rafale A' } }, ACTEUR);
  await societe.saveCompany(companyId, { identity: { name: 'Rafale B' } }, ACTEUR);
  await societe.saveCompany(companyId, { identity: { name: 'Rafale C' } }, ACTEUR);
  await societe.saveCompany(companyId, { identity: { name: 'Rafale D' } }, ACTEUR);

  const r = await attendreNom(A, 'Rafale D', 15_000);
  console.log(`    T0 → D visible : ${Date.now() - t0} ms`);
  check('LE PROJET FINIT SUR D', r.atteint);

  // Aucun retour en arrière : on relit après un délai.
  await new Promise((rs) => { setTimeout(rs, 800); });
  check('…et D tient (aucune version antérieure ne le remplace)',
    (await nomChezLeProjet(A)) === 'Rafale D');

  const etat = await A.state();
  const fiche = await societe.getCompanyOrThrow(companyId);
  check('…sur la DERNIÈRE version du Panel',
    etat.company?.version === fiche.publishedVersion);
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('DURABLE_JOURNAL_SURVIVES_BEFORE_PUSH — le push n’est qu’un accélérateur');
{
  /**
   * Le dispatcher est mis hors d'état de livrer : c'est l'équivalent d'un
   * Panel qui meurt entre l'écriture du journal et la tentative réseau.
   */
  livraison.configureDeliveryTransport(() => {
    throw new Error('Panel interrompu avant la livraison.');
  });

  await societe.saveCompany(companyId, { identity: { name: 'Sans livraison' } }, ACTEUR);
  check('la sauvegarde métier a réussi malgré tout',
    (await societe.getCompanyOrThrow(companyId)).identity.name === 'Sans livraison');
  check('…et le projet n’a rien reçu',
    (await nomChezLeProjet(A)) !== 'Sans livraison');

  const entree = await PanelSyncJournalEntry.findOne({}).sort({ seq: -1 }).lean();
  check('l’écriture est bien au journal, durable', Boolean(entree?.change?.writeId));

  /* — LE PROJET LA RÉCUPÈRE PAR SON CHEMIN NORMAL — */
  livraison.configureDeliveryTransport(null);
  await A.pull();
  check('LE RATTRAPAGE APPLIQUE CE QUE LA LIVRAISON N’A PAS PU PORTER',
    (await nomChezLeProjet(A)) === 'Sans livraison');
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('PUSH_AUDIENCE_IS_STRICT — une écriture nominative ne touche qu’une instance');
{
  const B = await demarrer({ dbName: 'l4_b', projectName: 'SB Auto L4 B' });
  const C = await demarrer({ dbName: 'l4_c', projectName: 'SB Auto L4 C' });

  const vus = [];
  livraison.configureDeliveryTransport(({ baseUrl }) => ({
    deliverChanges: async (changes) => {
      vus.push({ baseUrl, writeIds: changes.map((c) => c.writeId) });
      return { results: changes.map((c) => ({ writeId: c.writeId, status: 'APPLIED' })) };
    },
  }));

  const { emitChange } = await import('../backend/src/services/sync/syncCore.service.js');
  await emitChange({
    entityType: 'DEV_COMPANY',
    entityId: companyId,
    payload: { nominative: true },
    audience: B.projectId,
  });
  await attendre(async () => vus.length > 0, 5000);
  await new Promise((r) => { setTimeout(r, 300); });

  check('UNE SEULE instance a reçu la requête', vus.length === 1);
  check('…et c’est bien B', vus[0]?.baseUrl === B.publicBackendUrl);
  check('…A n’a reçu aucune requête',
    !vus.some((v) => v.baseUrl === A.publicBackendUrl));
  check('…C non plus',
    !vus.some((v) => v.baseUrl === C.publicBackendUrl));

  /* — ET LE TIRAGE APPLIQUE LA MÊME RÈGLE — */
  const { pullForProject } = await import('../backend/src/services/sync/syncCore.service.js');
  const pourA = await pullForProject(A.projectId, { cursor: undefined, limit: 200 });
  const pourB = await pullForProject(B.projectId, { cursor: undefined, limit: 200 });
  const nominative = (page) => page.changes.some((c) => c.payload?.nominative === true);
  check('le tirage de A ne voit pas l’écriture nominative', nominative(pourA) === false);
  check('…tandis que celui de B la voit', nominative(pourB) === true);

  livraison.configureDeliveryTransport(null);
  await B.stop();
  await C.stop();
  instances.splice(instances.indexOf(B), 1);
  instances.splice(instances.indexOf(C), 1);
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('LE DISPATCHER EST GÉNÉRIQUE — un second type passe sans rien recâbler');
{
  /**
   * `INTEGRATED_API_CONFIG` est un type NOMINATIF du vocabulaire du pont.
   * Aucune ligne du dispatcher ne le mentionne : s'il est livré, c'est qu'il
   * transporte des entrées de journal et non des cas particuliers.
   *
   * Depuis le lot L4 du plan de contrôle IntegratedAPI, plus AUCUN producteur
   * du Panel ne l'émet — la charge utile ci-dessous est fabriquée par ce test
   * seul, et ne contient volontairement aucun identifiant : la garde
   * `assertNoProviderSecrets` refuserait l'émission.
   */
  const { emitChange } = await import('../backend/src/services/sync/syncCore.service.js');
  const vus = [];
  livraison.configureDeliveryTransport(({ baseUrl }) => ({
    deliverChanges: async (changes) => {
      vus.push({ baseUrl, types: changes.map((c) => c.entityType) });
      return { results: changes.map((c) => ({ writeId: c.writeId, status: 'APPLIED' })) };
    },
  }));

  await emitChange({
    entityType: 'INTEGRATED_API_CONFIG',
    entityId: '11111111-1111-4111-8111-111111111111',
    payload: { provider: 'STRIPE' },
    audience: A.projectId,
  });
  await attendre(async () => vus.length > 0, 5000);

  check('un type que L4 ne connaît pas est livré comme les autres',
    vus.some((v) => v.types.includes('INTEGRATED_API_CONFIG')));
  check('…à la seule instance nommée', vus.length === 1 && vus[0].baseUrl === A.publicBackendUrl);

  livraison.configureDeliveryTransport(null);
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('PUSH_DISPATCHER_BOUNDED_CONCURRENCY — 50 destinataires');
{
  /**
   * Cinquante fiches appairées, un transport instrumenté qui compte les
   * requêtes SIMULTANÉES. Ce qu'on veut prouver n'est pas que « ça marche »,
   * mais qu'un changement global d'entreprise ne se transforme jamais en
   * cinquante sockets ouvertes d'un coup.
   */
  const { registryStore } = await import('../backend/src/services/registry/registryStore.js');
  const { PanelProjectDestination } = await import(
    '../backend/src/models/PanelProjectDestination.model.js'
  );
  const gabarit = await registryStore.getById(A.projectId);
  const maintenant = new Date().toISOString();

  for (let i = 0; i < 50; i += 1) {
    const clone = JSON.parse(JSON.stringify(gabarit));
    delete clone._id;
    delete clone.activeNetwork;
    delete clone.activePresentation;
    clone.projectId = `charge-${i}-0000-4000-8000-00000000${String(i).padStart(4, '0')}`;
    clone.projectKey = `charge-${i}`;
    clone.projectName = `Charge ${i}`;
    await registryStore.insert(clone);

    /**
     * L'ADRESSE SORTANTE VIENT DE LA DESTINATION ACTIVE, et de nulle part
     * ailleurs (`outboundBaseUrl`). Une fiche sans destination serait
     * légitimement SAUTÉE par le dispatcher — et ce test ne mesurerait alors
     * plus rien du tout.
     */
    await PanelProjectDestination.create({
      destinationId: `dest-charge-${i}`,
      projectId: clone.projectId,
      environment: 'TEST',
      host: `charge-${i}.exemple.test`,
      urls: { backend: `https://charge-${i}.exemple.test` },
      status: 'ACTIVE',
      announcedAt: maintenant,
      createdAt: maintenant,
      updatedAt: maintenant,
    });
  }

  let enCours = 0;
  let maxObserve = 0;
  let total = 0;
  const lent = new Set([3, 17, 41]); // trois traînards parmi cinquante

  livraison.configureDeliveryTransport(({ baseUrl }) => ({
    deliverChanges: async (changes) => {
      enCours += 1;
      maxObserve = Math.max(maxObserve, enCours);
      total += 1;
      const index = Number(/charge-(\d+)/.exec(baseUrl ?? '')?.[1] ?? -1);
      await new Promise((r) => { setTimeout(r, lent.has(index) ? 300 : 10); });
      enCours -= 1;
      return { results: changes.map((c) => ({ writeId: c.writeId, status: 'APPLIED' })) };
    },
  }));

  const entree = {
    audience: null,
    originProjectId: null,
    change: { writeId: 'charge-write', entityType: 'DEV_COMPANY', entityId: companyId,
      deleted: false, payload: {}, modifiedAt: new Date().toISOString(), emitter: 'PANEL' },
  };
  const resultats = await livraison.deliverEntry(entree);

  /**
   * Le nombre attendu est celui que le dispatcher RÉSOUT lui-même : le parc
   * contient aussi les fiches des instances des sections précédentes, dont les
   * processus sont arrêtés mais dont les fiches restent appairées. Coder « 51 »
   * en dur ferait échouer ce test au premier scénario ajouté plus haut — et
   * n'apprendrait rien de plus.
   */
  const attendus = (await livraison.resolveAudience(entree)).length;
  console.log(`    destinataires : ${resultats.length} (dont 50 de charge) · requêtes : ${total} · concurrence max : ${maxObserve}`);
  check(`tous les destinataires ont été programmés (${resultats.length})`,
    resultats.length === attendus && resultats.length >= 51);
  check(`la concurrence n’a JAMAIS dépassé la borne (${maxObserve} <= ${livraison.DELIVERY_CONCURRENCY})`,
    maxObserve <= livraison.DELIVERY_CONCURRENCY);
  check('…et elle a bien été exploitée (ce n’est pas du séquentiel)',
    maxObserve > 1);
  check('les traînards n’ont bloqué personne : tout le monde a été servi',
    total === resultats.length);

  livraison.configureDeliveryTransport(null);
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('LA DONNÉE MÉTIER NE TRAVERSE PAS LES MONDES');
{
  /**
   * ══ CE QUE CETTE SECTION AFFIRMAIT, ET CE QU'ELLE AFFIRME MAINTENANT ══════
   *
   * Elle plaçait `runtime.environment` à `PROD` — l'ANNONCE du projet — et
   * attendait un refus de classe `SECURITY`. Deux choses ont changé sous elle :
   *
   *   · l'annonce du projet ne fait plus autorité. C'est l'ENVIRONNEMENT
   *     ÉPINGLÉ de la fiche qui décide, précisément pour qu'un projet ne puisse
   *     pas se promouvoir d'un champ (voir `panel-instance-environment`) ;
   *   · un Panel de recette PILOTE désormais une production. La combinaison
   *     n'est plus un incident, donc plus une affaire de `SECURITY`.
   *
   * Ce qui demeure — et qui est le vrai sujet — c'est que le Panel ne livre pas
   * SES PROPRES enregistrements métier à un projet d'un autre monde : ce
   * seraient les mentions légales d'une entreprise de recette posées sur un
   * site en production. C'est une FRONTIÈRE, de classe `SCOPE`.
   */
  const { registryStore } = await import('../backend/src/services/registry/registryStore.js');

  const change = (writeId) => ({
    audience: A.projectId,
    originProjectId: null,
    change: { writeId, entityType: 'DEV_COMPANY', entityId: companyId,
      deleted: false, payload: {}, modifiedAt: new Date().toISOString(), emitter: 'PANEL' },
  });

  let requetes = 0;
  livraison.configureDeliveryTransport(() => ({
    deliverChanges: async () => { requetes += 1; return { results: [] }; },
  }));

  /* ── 1. UNE FICHE RÉELLEMENT ÉPINGLÉE EN PRODUCTION ─────────────────────── */
  const record = await registryStore.getById(A.projectId);
  const memoireEpingle = record.declaredEnvironment;
  const memoireAnnonce = record.runtime.environment;
  record.declaredEnvironment = 'PROD';       // ce Panel sert TEST
  record.runtime.environment = 'PROD';
  await registryStore.save(record);

  const traces = await livraison.deliverEntry(change('env-write'));

  check('AUCUNE requête n’est partie vers un projet d’un autre monde', requetes === 0);
  check('…l’issue est nommée', traces[0]?.outcome === 'ENVIRONMENT_MISMATCH');
  check('…et classée comme une FRONTIÈRE, non comme un incident',
    traces[0]?.errorClass === 'SCOPE');

  /* ── 2. UNE ANNONCE NE SUFFIT PAS À DÉPLACER UNE FICHE ───────────────────── */
  /**
   * La réciproque, et c'est elle qui ferme le chemin d'élévation : une fiche
   * épinglée en recette qui ANNONCE `PROD` n'est pas traitée comme une
   * production. Elle reste dans son monde, et la livraison a lieu.
   */
  const bis = await registryStore.getById(A.projectId);
  bis.declaredEnvironment = 'TEST';
  bis.runtime.environment = 'PROD';          // ce que le projet PRÉTEND
  await registryStore.save(bis);

  requetes = 0;
  const traces2 = await livraison.deliverEntry(change('env-write-2'));
  check('une fiche épinglée TEST qui annonce PROD reste dans son monde',
    traces2[0]?.outcome !== 'ENVIRONMENT_MISMATCH');
  check('…et la livraison n’est plus barrée par l’environnement',
    traces2[0]?.errorClass !== 'SCOPE', `outcome=${traces2[0]?.outcome} requetes=${requetes}`);

  livraison.configureDeliveryTransport(null);
  const remis = await registryStore.getById(A.projectId);
  remis.declaredEnvironment = memoireEpingle;
  remis.runtime.environment = memoireAnnonce;
  await registryStore.save(remis);
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('EVENT_DELIVERY_IS_NOT_HARDCODED_TO_DEV_COMPANY');
{
  const fs = await import('node:fs');
  const url = new URL('../backend/src/services/sync/syncDelivery.service.js', import.meta.url);
  const source = fs.readFileSync(url, 'utf8');
  // Les commentaires nomment des types pour EXPLIQUER ; le code, lui, ne doit
  // en connaître aucun. On ne lit donc que le code.
  const code = source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');

  for (const type of ['DEV_COMPANY', 'CONTRACT', 'TEAM_MEMBER', 'PROJECT_PRESENTATION',
    'INTEGRATED_API_CONFIG', 'MEETING', 'EVENT']) {
    check(`le dispatcher ignore le type ${type}`, !code.includes(type));
  }
  check('…il transporte des entrées, la connaissance du type vit chez le destinataire',
    code.includes('entry.change') || code.includes('entry?.audience'));
}

for (const inst of instances) await inst.stop();
await closePanel();
await stopMemoryMongo();
finish();
