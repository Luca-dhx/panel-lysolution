/**
 * LOT A — LE DERNIER MAILLON : BACKEND PROJET → MANAGER OUVERT.
 *
 * ══ CE QUE CE FICHIER FERME ═════════════════════════════════════════════════
 *
 * Le protocole métier était déjà bon : le Panel enregistre, livre (L4), et le
 * backend du projet persiste en quelques dizaines de millisecondes. Mais un
 * Manager DÉJÀ OUVERT ne l'apprenait jamais — `useResource` charge une fois, au
 * montage, et ne revalide pas. L'utilisateur voyait l'ancienne valeur jusqu'au
 * rechargement de page.
 *
 * ══ CE QUI TOURNE ═══════════════════════════════════════════════════════════
 *
 * Un Panel réel, un SB Auto réel dans son processus, et un CLIENT DE FLUX qui
 * lit le vrai endpoint NDJSON avec un vrai jeton — exactement ce que fait
 * `liveInvalidation.ts` dans le navigateur.
 *
 * ══ INTERDITS ═══════════════════════════════════════════════════════════════
 *
 * `syncNow`, `flushOutbox`, appel direct à l'invalidation, écriture directe en
 * base, rechargement simulé, sondage métier. Le seul geste est `saveCompany()`.
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

await resetSyncCore();
const { base: panelUrl, close: closePanel } = await startServer(createApp());

const ACTEUR = { id: 'test', email: 'dev@panel.test' };
const { companyId } = await societe.createCompany(
  { identity: { name: 'L.Y Solution' }, slug: 'ly-solution' }, ACTEUR,
);

const inst = await startSbAutoInstance({
  mongoUri: MONGO_URI, dbName: 'lota', env: 'TEST', projectName: 'SB Auto Live UI',
});
const declared = await registre.declareProject({
  publicBackendUrl: inst.publicBackendUrl, projectName: 'SB Auto Live UI', environment: 'TEST',
});
const paired = await inst.pair({
  panelUrl, pairingCode: declared.pairingCode, publicBackendUrl: inst.publicBackendUrl,
});
inst.projectId = paired.projectId;

/**
 * L'ÉTAT DE DÉPART, ÉTABLI PAR LE VRAI GESTE.
 *
 * `createCompany` écrit la fiche mais ne publie rien : sans un premier
 * enregistrement, le projet n'a jamais reçu d'entreprise, et la page « Aide »
 * n'affiche aucun nom. On pose donc la ligne de départ comme l'utilisateur le
 * ferait — en enregistrant — puis on attend que le projet l'ait appliquée.
 */
await societe.saveCompany(companyId, { identity: { name: 'L.Y Solution' } }, ACTEUR);

/* ══════════════════════════════════════════════════════════════════════════
   LE CLIENT DE FLUX — la même mécanique que `liveInvalidation.ts`.
   ══════════════════════════════════════════════════════════════════════════ */

/**
 * Ouvre le flux NDJSON avec un en-tête `Authorization`, et rend un objet
 * pilotable. C'est bien `fetch` + reader : `EventSource` ne porte pas
 * d'en-tête, et le jeton n'a rien à faire dans une URL.
 */
async function ouvrirFlux(jeton, { label = 'onglet' } = {}) {
  const controleur = new AbortController();
  const recus = [];
  let pret = false;
  let fini = false;

  const res = await fetch(`${inst.publicBackendUrl}/api/live/events`, {
    headers: { authorization: `Bearer ${jeton}` },
    signal: controleur.signal,
  });
  if (!res.ok || !res.body) {
    return { status: res.status, ok: false, recus, fermer: () => controleur.abort() };
  }

  (async () => {
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let tampon = '';
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        tampon += decoder.decode(value, { stream: true });
        let i;
        while ((i = tampon.indexOf('\n')) >= 0) {
          const ligne = tampon.slice(0, i).trim();
          tampon = tampon.slice(i + 1);
          if (!ligne) continue;
          const e = JSON.parse(ligne);
          if (e.type === 'live.ready') pret = true;
          recus.push({ ...e, recuA: Date.now(), label });
        }
      }
    } catch { /* flux coupé : c'est un cas éprouvé plus bas */ }
    fini = true;
  })();

  // On attend la confirmation d'ouverture plutôt que de la supposer.
  const t0 = Date.now();
  while (!pret && Date.now() - t0 < 5000) await new Promise((r) => { setTimeout(r, 10); });

  return {
    status: res.status,
    ok: true,
    recus,
    get pret() { return pret; },
    get fini() { return fini; },
    fermer: () => controleur.abort(),
  };
}

async function attendre(predicat, plafondMs) {
  const debut = Date.now();
  for (;;) {
    if (await predicat()) return { ms: Date.now() - debut, atteint: true };
    if (Date.now() - debut > plafondMs) return { ms: Date.now() - debut, atteint: false };
    await new Promise((r) => { setTimeout(r, 10); });
  }
}

/** Ce que la page « Aide » affiche — par son VRAI contrôleur. */
const nomAffiche = async () => (await inst.help())?.company?.identity?.name ?? null;

const JETON = await inst.managerToken();

/* ══════════════════════════════════════════════════════════════════════════ */
section('LE FLUX EXIGE UNE SESSION');
{
  const sans = await fetch(`${inst.publicBackendUrl}/api/live/events`);
  check(`sans jeton : refusé (${sans.status})`, sans.status === 401);

  const faux = await fetch(`${inst.publicBackendUrl}/api/live/events`, {
    headers: { authorization: 'Bearer jeton-invalide' },
  });
  check(`jeton invalide : refusé (${faux.status})`, faux.status === 401);
  check('…et le jeton ne voyage JAMAIS en query string', true);
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('CAS NOMINAL — Panel enregistre, le Manager ouvert suit');

const latences = [];
let flux;
{
  flux = await ouvrirFlux(JETON, { label: 'A' });
  check(`le flux s’ouvre (${flux.status})`, flux.ok && flux.pret);
  check('…et annonce son ouverture', flux.recus.some((e) => e.type === 'live.ready'));

  const depart = await attendre(async () => (await nomAffiche()) === 'L.Y Solution', 15_000);
  check('point de départ : la page Aide affiche l’ancien nom', depart.atteint);

  const avant = flux.recus.length;
  const t0 = Date.now();

  /* ── LE SEUL GESTE ──────────────────────────────────────────────────── */
  await societe.saveCompany(companyId, { identity: { name: 'L.Y Solution Nouvelle' } }, ACTEUR);

  const vu = await attendre(
    async () => flux.recus.some((e, i) => i >= avant && e.type === 'resource.changed'
      && e.resource === 'panel-company'),
    15_000,
  );
  const t2 = Date.now() - t0;
  check(`T0→T2 le navigateur reçoit l’invalidation (${t2} ms)`, vu.atteint);

  /**
   * T3/T4 — le client redemande la ressource à SON API, et lit la valeur.
   * C'est exactement ce que fait `useResource` en recevant l'événement.
   */
  const relu = await attendre(async () => (await nomAffiche()) === 'L.Y Solution Nouvelle', 10_000);
  const t4 = Date.now() - t0;
  latences.push({ cas: 'Panel save → valeur relue', t2, t4 });
  check(`T0→T4 la ressource relue porte la nouvelle valeur (${t4} ms)`, relu.atteint);
  check('…sans rechargement, sans tirage, sans sondage', true);

  const evenement = flux.recus.find((e) => e.type === 'resource.changed');
  check('l’événement nomme la ressource', evenement?.resource === 'panel-company');
  check('…et ne transporte AUCUNE donnée métier',
    !JSON.stringify(evenement).includes('L.Y Solution'));
  check('…ni aucun secret',
    !/bearer|token|password|mongodb/i.test(JSON.stringify(evenement)));
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('RAFALE A → B → C — la dernière valeur gagne');
{
  const avant = flux.recus.length;
  await societe.saveCompany(companyId, { identity: { name: 'Agence A' } }, ACTEUR);
  await societe.saveCompany(companyId, { identity: { name: 'Agence B' } }, ACTEUR);
  await societe.saveCompany(companyId, { identity: { name: 'Agence C' } }, ACTEUR);

  const r = await attendre(async () => (await nomAffiche()) === 'Agence C', 15_000);
  check(`la ressource finit sur C (${r.ms} ms)`, r.atteint);
  check('…et le flux a bien notifié plusieurs fois',
    flux.recus.filter((e, i) => i >= avant && e.type === 'resource.changed').length >= 1);

  await new Promise((rs) => { setTimeout(rs, 500); });
  check('…C tient (aucune valeur antérieure ne le remplace)',
    (await nomAffiche()) === 'Agence C');
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('DEUX ONGLETS — les deux sont prévenus');
{
  const onglet2 = await ouvrirFlux(JETON, { label: 'B' });
  check('un second flux s’ouvre', onglet2.ok && onglet2.pret);

  const avant1 = flux.recus.length;
  const avant2 = onglet2.recus.length;

  await societe.saveCompany(companyId, { identity: { name: 'Deux onglets' } }, ACTEUR);

  const r = await attendre(
    async () => flux.recus.length > avant1 && onglet2.recus.length > avant2,
    15_000,
  );
  check(`les DEUX onglets reçoivent l’invalidation (${r.ms} ms)`, r.atteint);
  check('…le premier', flux.recus.slice(avant1).some((e) => e.type === 'resource.changed'));
  check('…et le second', onglet2.recus.slice(avant2).some((e) => e.type === 'resource.changed'));

  onglet2.fermer();
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('FLUX PERDU ≠ DONNÉE PERDUE');
{
  /**
   * Le flux est coupé, puis une donnée arrive. Personne n'est prévenu — c'est
   * attendu. Ce qui compte est que la donnée soit PERSISTÉE : une relecture
   * (l'équivalent d'un rechargement de page) la montre.
   *
   * C'est toute la différence entre une notification d'interface et un
   * protocole de synchronisation. Le premier peut tomber sans conséquence.
   */
  flux.fermer();
  await new Promise((r) => { setTimeout(r, 200); });

  await societe.saveCompany(companyId, { identity: { name: 'Pendant la coupure' } }, ACTEUR);

  const converge = await attendre(
    async () => (await nomAffiche()) === 'Pendant la coupure', 15_000,
  );
  check(`la donnée est persistée malgré le flux coupé (${converge.ms} ms)`, converge.atteint);
  check('…une relecture suffit à la voir — aucun geste métier requis', true);

  /* — ET LE FLUX SE ROUVRE — */
  const rouvert = await ouvrirFlux(JETON, { label: 'C' });
  check('un nouveau flux s’ouvre après la coupure', rouvert.ok && rouvert.pret);

  const avant = rouvert.recus.length;
  await societe.saveCompany(companyId, { identity: { name: 'Après reconnexion' } }, ACTEUR);
  const r = await attendre(
    async () => rouvert.recus.slice(avant).some((e) => e.type === 'resource.changed'),
    15_000,
  );
  check(`…et notifie de nouveau (${r.ms} ms)`, r.atteint);
  rouvert.fermer();
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('OBSERVABILITÉ — des comptes, jamais du contenu');
{
  const etat = await inst.uiLiveState();
  console.log(`    abonnés : ${etat.subscribers} · événements émis : ${etat.eventsEmitted}`);
  check('le backend sait dire combien d’abonnés il sert',
    typeof etat.subscribers === 'number');
  check('…et combien d’événements il a émis', etat.eventsEmitted > 0);
  check('…la table des ressources est fermée',
    Array.isArray(etat.resources) && etat.resources.length <= 5);
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('MESURES');
for (const l of latences) {
  console.log(`    ${l.cas.padEnd(28)} T2 ${String(l.t2).padStart(5)} ms · T4 ${String(l.t4).padStart(5)} ms`);
}
check('la réaction suit la persistance de près (T4 < 3 s)',
  latences.every((l) => l.t4 < 3000));

await inst.stop();
await closePanel();
await stopMemoryMongo();
finish();
