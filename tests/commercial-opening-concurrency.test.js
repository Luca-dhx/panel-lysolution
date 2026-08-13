// OUVERTURE COMMERCIALE — LE GESTE EST RÉCLAMÉ, PAS SEULEMENT ÉCRIT (R10.4).
//
// ══ CE QUE CE FICHIER FERME ═════════════════════════════════════════════════
//
// L3.1 lisait la fiche, vérifiait la transition et les prérequis, PUIS écrivait
// sans condition. Tout ce raisonnement portait sur un instantané : deux
// requêtes simultanées le franchissaient toutes les deux, écrivaient toutes les
// deux, et journalisaient toutes les deux.
//
// L'état final était juste — les deux visaient LIVE — donc rien ne cassait
// visiblement. Ce qui cassait, c'est la CHRONOLOGIE : deux `COMMERCIAL_OPENED`
// pour un seul geste. Or c'est exactement là qu'on vient lire « quand cette
// instance a-t-elle été ouverte, et par qui ». Un doublon y transforme un clic
// en incident à instruire.
//
// On éprouve ici les quatre formes du même problème :
//
//   double clic ×8       →  un seul événement
//   concurrence ×8       →  un seul événement
//   rejeu après coup     →  aucun événement de plus
//   course inverse       →  refus net, jamais un état fantôme
//
// ══ ET CE QUI NE DOIT PAS CHANGER ═══════════════════════════════════════════
//
// Aucun appel fournisseur, dans aucun de ces scénarios. L'ouverture LÈVE une
// interdiction, elle n'agit pas — et le compteur de sorties réseau doit rester
// à zéro même sous huit requêtes concurrentes.
import {
  check, connectTestDatabase, finish, section, setTestEnv,
  startMemoryMongo, stopMemoryMongo,
} from './helpers/harness.js';

setTestEnv();
process.env.ENV = 'PROD';
process.env.DB_PROD = 'panel_prod_commercial_concurrency';
process.env.SEED_DEV_EMAIL = 'exploitation@ly-solution.test';
process.env.SEED_DEV_PASSWORD = 'commercial-concurrency-2026-XyZ';

await startMemoryMongo();
await connectTestDatabase();

const service = await import('../backend/src/services/capabilities/commercialReadiness.service.js');
const registryStore = (await import('../backend/src/services/registry/registryStore.js')).default;
const { PanelEvent, EVENT_TYPES } = await import('../backend/src/models/PanelSupervision.model.js');

const ACTEUR = { userId: 'u-dev', userEmail: 'dev@panel.test' };

/**
 * Toute sortie réseau est une anomalie dans ce fichier : l'ouverture ne touche
 * aucun fournisseur. Le compteur est global et vérifié à la fin.
 */
let appelsFournisseur = 0;
const fetchOriginal = globalThis.fetch;
globalThis.fetch = async (...args) => {
  appelsFournisseur += 1;
  return fetchOriginal?.(...args);
};

async function projet(projectId, { commercialState = null } = {}) {
  const at = new Date().toISOString();
  await registryStore.remove(projectId);
  await registryStore.insert({
    projectId,
    projectKey: projectId,
    projectName: `Instance ${projectId}`,
    createdAt: at,
    updatedAt: at,
    pairing: { status: 'PAIRED', bridgeTokenHash: 'h', pairedAt: at },
    runtime: { environment: 'PROD' },
    commercialState,
  });
  const destinations = await import('../backend/src/services/registry/projectDestination.service.js');
  await destinations.announceDestination({
    record: await registryStore.getById(projectId),
    urls: {
      website: `https://${projectId}.test`,
      manager: `https://manager.${projectId}.test`,
      backend: `https://api.${projectId}.test`,
    },
    source: 'PRESENTATION',
  });
  return registryStore.getById(projectId);
}

/** Les événements d'ouverture/fermeture d'une fiche, dans l'ordre. */
async function evenements(projectId, type) {
  return PanelEvent.find({ projectId, type }).sort({ at: 1 }).lean();
}

/** Résout en `{ok}` ou `{code}` — jamais de rejet non capturé. */
async function tenter(projectId, state, reason) {
  try {
    const vue = await service.setCommercialReadiness(projectId, state, { actor: ACTEUR, reason });
    return { ok: true, state: vue.state };
  } catch (err) {
    return { ok: false, code: err?.code ?? 'UNEXPECTED' };
  }
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('DOUBLE_CLIC — huit fois le même geste, une seule ouverture');
{
  const projectId = 'p-double-clic';
  await projet(projectId);

  /**
   * Huit requêtes lancées ENSEMBLE, sans await intermédiaire : c'est la seule
   * façon de reproduire la fenêtre entre la lecture et l'écriture. Les lancer
   * en série les ferait toutes passer par la branche « déjà dans cet état »,
   * qui n'a jamais été le problème.
   */
  const resultats = await Promise.all(
    Array.from({ length: 8 }, () => tenter(projectId, 'LIVE', 'recette validée')),
  );

  check('les huit tentatives aboutissent (aucune n’échoue à l’utilisateur)',
    resultats.every((r) => r.ok === true));
  check('…et toutes rendent le même état', resultats.every((r) => r.state === 'LIVE'));

  const record = await registryStore.getById(projectId);
  check('l’état persisté est LIVE', record.commercialState === 'LIVE');

  const ouvertures = await evenements(projectId, EVENT_TYPES.COMMERCIAL_OPENED);
  check('NO_DUPLICATE_TIMELINE — un seul événement d’ouverture pour huit clics',
    ouvertures.length === 1);
  check('…et il porte la transition réelle',
    ouvertures[0]?.data?.previous === 'PREOPENING' && ouvertures[0]?.data?.next === 'LIVE');
  check('…attribué à l’acteur', ouvertures[0]?.data?.actor === 'u-dev');
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('REJEU — redemander après coup ne réécrit rien');
{
  const projectId = 'p-rejeu';
  await projet(projectId);

  await tenter(projectId, 'LIVE', 'première ouverture');
  const avant = await registryStore.getById(projectId);

  // Quatre rejeux SÉRIELS, longtemps après : le cas « un client réessaie ».
  for (let i = 0; i < 4; i += 1) await tenter(projectId, 'LIVE', `rejeu ${i}`);

  const apres = await registryStore.getById(projectId);
  const ouvertures = await evenements(projectId, EVENT_TYPES.COMMERCIAL_OPENED);

  check('le rejeu reste idempotent', apres.commercialState === 'LIVE');
  check('…sans second événement', ouvertures.length === 1);
  check('…et sans réécrire la date de décision',
    apres.commercialStateUpdatedAt === avant.commercialStateUpdatedAt);
  check('…ni le motif d’origine',
    apres.commercialStateReason === avant.commercialStateReason);
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('COURSE_INVERSE — ouvrir et refermer en même temps ne produit pas de fantôme');
{
  const projectId = 'p-course-inverse';
  await projet(projectId, { commercialState: 'PREOPENING' });

  /**
   * Une ouverture et une fermeture lancées ensemble. L'une des deux DOIT
   * perdre : rendre « ouvert » à qui vient de fermer afficherait un état que
   * personne ne retrouverait en rechargeant.
   *
   * On n'impose pas laquelle gagne — c'est une course, et le départager
   * arbitrairement serait tester l'ordonnanceur, pas la garde.
   */
  const [ouvrir, fermer] = await Promise.all([
    tenter(projectId, 'LIVE', 'ouverture'),
    tenter(projectId, 'PREOPENING', 'fermeture'),
  ]);

  const record = await registryStore.getById(projectId);
  const effectif = service.effectiveCommercialState(record);

  const gagnants = [ouvrir, fermer].filter((r) => r.ok);
  const perdants = [ouvrir, fermer].filter((r) => !r.ok);

  check('au moins une tentative aboutit', gagnants.length >= 1);
  /**
   * CE QU'ON N'EXIGE PAS, ET POURQUOI.
   *
   * On n'exige pas que chaque réponse égale l'état final. Sous une vraie
   * course, la demande qui ne change rien (« mets-le en PREOPENING » alors
   * qu'il l'est déjà) répond juste au moment où elle regarde ; l'autre bascule
   * ensuite. Aucune sérialisation ne rend cela faux, et l'imposer testerait
   * l'ordonnanceur plutôt que la garde.
   *
   * Ce qui DOIT tenir, c'est qu'aucune réponse n'invente un état : chacune est
   * l'un des deux états légitimes, et la base est dans l'un d'eux.
   */
  check('aucune réponse n’annonce un état inventé',
    gagnants.every((r) => r.state === 'LIVE' || r.state === 'PREOPENING'));
  check('la base est dans l’un des deux états demandés',
    effectif === 'LIVE' || effectif === 'PREOPENING');
  check('un éventuel perdant est refusé explicitement, jamais en silence',
    perdants.every((r) => r.code === 'PANEL_COMMERCIAL_STATE_CONCURRENT_CHANGE'
      || r.code === 'PANEL_COMMERCIAL_STATE_TRANSITION_INVALID'));

  const ouvertures = await evenements(projectId, EVENT_TYPES.COMMERCIAL_OPENED);
  const fermetures = await evenements(projectId, EVENT_TYPES.COMMERCIAL_CLOSED);
  check('la chronologie ne contient jamais deux fois le même basculement',
    ouvertures.length <= 1 && fermetures.length <= 1);
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('CYCLE — refermer puis rouvrir reste traçable, sans doublon');
{
  const projectId = 'p-cycle';
  await projet(projectId);

  await tenter(projectId, 'LIVE', 'ouverture 1');
  await Promise.all(Array.from({ length: 8 }, () => tenter(projectId, 'PREOPENING', 'incident')));
  await tenter(projectId, 'LIVE', 'ouverture 2');

  const ouvertures = await evenements(projectId, EVENT_TYPES.COMMERCIAL_OPENED);
  const fermetures = await evenements(projectId, EVENT_TYPES.COMMERCIAL_CLOSED);

  check('deux ouvertures distinctes sont bien deux événements', ouvertures.length === 2);
  check('…et les huit fermetures simultanées n’en font qu’un', fermetures.length === 1);

  const record = await registryStore.getById(projectId);
  check('l’état final est celui du dernier geste', record.commercialState === 'LIVE');
  check('…et le motif est celui du dernier geste',
    record.commercialStateReason === 'ouverture 2');
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('ÉCRITURE_CONDITIONNELLE — la primitive de stockage refuse un état périmé');
{
  const projectId = 'p-cas';
  await projet(projectId, { commercialState: 'PREOPENING' });
  const at = new Date().toISOString();

  const gagne = await registryStore.setCommercialState(projectId, {
    state: 'LIVE', at, by: 'u-dev', reason: null, expected: 'PREOPENING',
  });
  check('l’écriture qui connaît l’état courant réussit', gagne === true);

  const perd = await registryStore.setCommercialState(projectId, {
    state: 'LIVE', at, by: 'u-autre', reason: 'périmé', expected: 'PREOPENING',
  });
  check('CAS_REJECTS_STALE — celle qui part d’un état périmé n’écrit rien', perd === false);

  const record = await registryStore.getById(projectId);
  check('…et la fiche a gardé l’auteur du geste gagnant',
    record.commercialStateUpdatedBy === 'u-dev');
  check('…sans absorber le motif du perdant', record.commercialStateReason === null);
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('JAMAIS_DÉCIDÉ — `null` en base se réclame comme un état à part entière');
{
  const projectId = 'p-jamais-decide';
  await projet(projectId, { commercialState: null });

  const record = await registryStore.getById(projectId);
  check('l’état stocké est bien nul', (record.commercialState ?? null) === null);
  check('…mais l’état effectif est PREOPENING',
    service.effectiveCommercialState(record) === 'PREOPENING');

  /**
   * La subtilité que cette section verrouille : le filtre d'écriture porte sur
   * l'état STOCKÉ (`null`), pas sur l'état EFFECTIF (`PREOPENING`). Filtrer sur
   * le second ne matcherait aucune fiche jamais décidée — et l'ouverture
   * échouerait silencieusement sur exactement les instances neuves, c'est-à-dire
   * toutes celles qu'on ouvre pour la première fois.
   */
  const resultats = await Promise.all(
    Array.from({ length: 8 }, () => tenter(projectId, 'LIVE', 'première décision')),
  );
  check('une fiche jamais décidée s’ouvre', resultats.every((r) => r.ok === true));

  const ouvertures = await evenements(projectId, EVENT_TYPES.COMMERCIAL_OPENED);
  check('…une seule fois', ouvertures.length === 1);
  check('…et la vue ne dit plus « jamais décidée »',
    service.describeCommercialReadiness(await registryStore.getById(projectId)).neverDecided === false);
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('AUCUN_EFFET_EXTERNE — ouvrir ne parle à personne');
{
  check('NO_PROVIDER_CALL — aucune sortie réseau pendant tout ce fichier',
    appelsFournisseur === 0);
}

globalThis.fetch = fetchOriginal;
await stopMemoryMongo();
finish();
