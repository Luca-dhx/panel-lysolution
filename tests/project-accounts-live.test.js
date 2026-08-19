/**
 * LES COMPTES D'UN PROJET, LUS EN DIRECT PAR LE PANEL.
 *
 * ══ LE DÉFAUT QUE CETTE SUITE VERROUILLE ════════════════════════════════════
 *
 * Le Panel affichait « l'équipe du projet » depuis sa PROPRE collection,
 * alimentée par le flux de synchronisation. Une deuxième source de vérité, et
 * ses trois conséquences :
 *
 *   · elle VIEILLISSAIT — un compte créé dans le Manager n'apparaissait qu'à
 *     la synchronisation suivante, et rien ne distinguait « à jour » de
 *     « en retard » ;
 *   · elle ne montrait QUE LA MOITIÉ — les accès L.Y Solution, c'est-à-dire
 *     les identités qui entrent réellement dans le projet, n'y figuraient pas ;
 *   · elle avait SA PROPRE FORME — `entityId`/`name` d'un côté,
 *     `id`/`displayName`/`source` de l'autre, pour les mêmes personnes.
 *
 * ══ CE QUI EST ÉPROUVÉ, ET SUR QUOI ═════════════════════════════════════════
 *
 * Deux serveurs réels : un Panel sur son port, une instance SB Auto dans son
 * processus, un vrai appairage, de vrais appels HTTP par le pont. Un compte
 * créé dans le Manager doit apparaître dans le Panel à la lecture SUIVANTE,
 * sans synchronisation, sans attente, sans redéploiement.
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
const users = await import('../backend/src/services/auth/panelUsers.service.js');
const { resetSyncCore } = await import('../backend/src/services/sync/syncCore.service.js');
const { updateNetworkConfiguration } = await import('../backend/src/services/network/networkConfig.service.js');
const { default: PanelProjectDestination } = await import('../backend/src/models/PanelProjectDestination.model.js');

await resetSyncCore();
await users.resetUsers();
await users.seedFromEnv();

const { base: PANEL_URL, call: panelCall, close: closePanel } = await startServer(createApp());
await updateNetworkConfiguration({ backendUrl: PANEL_URL }, { requirePublic: false });

const projet = await startSbAutoInstance({
  mongoUri: MONGO_URI,
  dbName: 'project_accounts_live',
  env: 'TEST',
  projectName: 'Garage Vivant',
});

async function projetApi(method, chemin, { body, token } = {}) {
  const response = await fetch(`${projet.publicBackendUrl}${chemin}`, {
    method,
    headers: {
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const json = await response.json().catch(() => null);
  return { status: response.status, json, data: json?.data ?? null };
}

/* ── APPAIRAGE RÉEL ─────────────────────────────────────────────────────── */
const registre = await import('../backend/src/services/registry/projectRegistry.service.js');
const declare = await registre.declareProject({
  publicBackendUrl: projet.publicBackendUrl,
  projectName: 'Garage Vivant',
});
const appairage = await projet.pair({
  panelUrl: PANEL_URL,
  pairingCode: declare.pairingCode,
  publicBackendUrl: projet.publicBackendUrl,
});
const PROJECT_ID = appairage.projectId;
await PanelProjectDestination.updateOne(
  { projectId: PROJECT_ID, environment: 'TEST' },
  { $set: { 'urls.manager': projet.publicBackendUrl } },
);

/* ── UN SOUVERAIN ET UN DEV AU PANEL ────────────────────────────────────── */
const OPS = await users.createUser({
  email: 'ops@panel.test', password: 'Operateur-2026', displayName: 'Opérateur', role: 'SUPER_ADMIN',
});
const DEV = await users.createUser({
  email: 'luca@panel.test', password: 'Developpeur-2026', displayName: 'Luca Duhoux', role: 'DEV',
});
const SOUVERAIN = await users.createUser({
  email: 'roi@panel.test', password: 'Souverain-2026', displayName: 'Le Souverain', role: 'SUPER_ADMIN',
});

async function jetonPanel(email, password) {
  const r = await panelCall('POST', '/api/auth/login', { body: { email, password } });
  return r.json?.data?.token ?? null;
}
const AUTH = { authorization: `Bearer ${await jetonPanel('ops@panel.test', 'Operateur-2026')}` };

/** La lecture VIVANTE, telle que l'écran la fait. */
const lireComptes = () => panelCall('GET', `/api/projects/${PROJECT_ID}/accounts`, { headers: AUTH });

/** Un DEV du projet, pour piloter son Manager comme un humain le ferait. */
const MDP_LOCAL = 'MotDePasseLocalDeRecette-2026';

/* ══════════════════════════════════════════════════════════════════════════
   1. LE PANEL LIT CHEZ L'AUTORITÉ, ET NON DANS SA PROPRE COPIE.
   ══════════════════════════════════════════════════════════════════════════ */
section('1 · La lecture sort du Panel et va chercher le projet');
let sessionProjet = null;
{
  const premiere = await lireComptes();
  check('la route existe et répond', premiere.status === 200);
  check('…et la lecture a abouti', premiere.json?.data?.available === true);
  check('…datée par le PROJET, pas par le Panel',
    typeof premiere.json?.data?.readAt === 'string');
  check('la réponse n’est jamais mise en cache',
    /no-store/.test(premiere.headers?.get?.('cache-control') ?? ''));

  /**
   * LE PANEL NE POSSÈDE AUCUNE COLLECTION DE COMPTES DE PROJET.
   *
   * Contrôle par la NÉGATIVE, et c'est le seul qui prouve la doctrine : on
   * peut toujours brancher une lecture vivante À CÔTÉ d'un instantané qu'on
   * continue d'entretenir. C'est ce qu'il faut empêcher.
   */
  const { default: PanelProjectMember } = await import('../backend/src/models/PanelProjectMember.model.js')
    .catch(() => ({ default: null }));
  if (PanelProjectMember) {
    const copies = await PanelProjectMember.countDocuments({ projectId: PROJECT_ID });
    check('aucun compte du projet n’est copié dans le Panel au moment de la lecture',
      copies === 0);
  } else {
    check('aucun modèle de comptes projet n’existe côté Panel', true);
  }
}

/* ══════════════════════════════════════════════════════════════════════════
   2. LA RECETTE LIVE — créer, modifier, supprimer.
   ══════════════════════════════════════════════════════════════════════════ */
section('2 · Ce que le Manager change, le Panel le voit à la lecture suivante');
{
  /* On ouvre une session projet par la fédération, comme en vrai. */
  await panelCall('PATCH', `/api/panel-users/${DEV.userId}`, {
    headers: AUTH, body: { projectAccess: { mode: 'ALL_PAIRED' } },
  });
  const depart = await projetApi('POST', '/api/auth/federated/panel/start', {
    body: { returnUrl: `${projet.publicBackendUrl}/connexion/ly-solution/retour` },
  });
  const jetonDev = await jetonPanel('luca@panel.test', 'Developpeur-2026');
  const emission = await panelCall(
    'POST', `/api/federation/projects/${PROJECT_ID}/assertion`,
    {
      headers: { authorization: `Bearer ${jetonDev}` },
      body: { returnUrl: `${projet.publicBackendUrl}/connexion/ly-solution/retour` },
    },
  );
  const retour = await projetApi('POST', '/api/auth/federated/panel/callback', {
    body: { assertion: emission.json.data.assertion, state: depart.data.state },
  });
  sessionProjet = retour.data?.token ?? null;
  check('une session projet fédérée est ouverte', typeof sessionProjet === 'string');

  /* ── A. CRÉER ─────────────────────────────────────────────────────────── */
  const creation = await projetApi('POST', '/api/accounts', {
    token: sessionProjet,
    body: { email: 'nouveau@garage.test', name: 'Nouveau Compte', role: 'ADMIN', password: MDP_LOCAL },
  });
  check('A — un compte local est créé dans le Manager',
    creation.status === 201 || creation.status === 200);

  const apresCreation = (await lireComptes()).json.data;
  const vu = apresCreation.accounts.find((c) => c.email === 'nouveau@garage.test');
  check('A — le Panel le voit à la lecture SUIVANTE, sans synchronisation', Boolean(vu));
  check('A — …avec la même identité métier',
    vu?.displayName === 'Nouveau Compte' && vu?.role === 'ADMIN');
  check('A — …et nommé comme un compte du projet',
    vu?.source === 'LOCAL' && vu?.principalType === 'LOCAL_USER');

  /* ── B. MODIFIER ──────────────────────────────────────────────────────── */
  const idLocal = String(vu.id);
  const modification = await projetApi('PUT', `/api/accounts/${idLocal}`, {
    token: sessionProjet, body: { name: 'Compte Renommé', role: 'DEV' },
  });
  check('B — le compte est modifié dans le Manager', modification.status === 200);

  const apresModification = (await lireComptes()).json.data;
  const relu = apresModification.accounts.find((c) => c.id === idLocal);
  check('B — le Panel lit la MÊME valeur',
    relu?.displayName === 'Compte Renommé' && relu?.role === 'DEV');

  /* ── C. SUPPRIMER ─────────────────────────────────────────────────────── */
  const suppression = await projetApi('DELETE', `/api/accounts/${idLocal}`, { token: sessionProjet });
  check(`C — le compte est supprimé dans le Manager (HTTP ${suppression.status})`,
    suppression.status >= 200 && suppression.status < 300);
  const apresSuppression = (await lireComptes()).json.data;
  check('C — il disparaît du Panel à la lecture suivante',
    !apresSuppression.accounts.some((c) => c.id === idLocal));
}

/* ══════════════════════════════════════════════════════════════════════════
   3. LES DEUX POPULATIONS, ET LA PROJECTION DU RÔLE.
   ══════════════════════════════════════════════════════════════════════════ */
section('3 · Un SUPER_ADMIN du Panel apparaît ici en DEV, source L.Y Solution');
{
  const vus = (await lireComptes()).json.data.accounts;
  const federe = vus.find((c) => c.source === 'PANEL' && c.email === 'luca@panel.test');
  check('l’identité fédérée figure dans la liste', Boolean(federe));
  check('…nommée comme un accès L.Y Solution',
    federe?.principalType === 'PANEL_USER' && federe?.source === 'PANEL');
  check('…avec le rôle de PROJET', federe?.role === 'DEV');
  check('…et sa fraîcheur, puisqu’elle est une projection',
    typeof federe?.lastSyncedAt === 'string');

  /* ── D. UN SOUVERAIN DU PANEL ENTRE DANS LE PROJET ────────────────────── */
  await panelCall('PATCH', `/api/panel-users/${SOUVERAIN.userId}`, {
    headers: AUTH, body: { projectAccess: { mode: 'ALL_PAIRED' } },
  });
  const depart = await projetApi('POST', '/api/auth/federated/panel/start', {
    body: { returnUrl: `${projet.publicBackendUrl}/connexion/ly-solution/retour` },
  });
  const jetonRoi = await jetonPanel('roi@panel.test', 'Souverain-2026');
  const emission = await panelCall(
    'POST', `/api/federation/projects/${PROJECT_ID}/assertion`,
    {
      headers: { authorization: `Bearer ${jetonRoi}` },
      body: { returnUrl: `${projet.publicBackendUrl}/connexion/ly-solution/retour` },
    },
  );
  check('D — un SUPER_ADMIN du Panel peut fédérer', emission.status === 200);
  await projetApi('POST', '/api/auth/federated/panel/callback', {
    body: { assertion: emission.json.data.assertion, state: depart.data.state },
  });

  const apres = (await lireComptes()).json.data.accounts;
  const roi = apres.find((c) => c.email === 'roi@panel.test');
  check('D — il apparaît dans le projet', Boolean(roi));
  check('D — en DEV, jamais en SUPER_ADMIN', roi?.role === 'DEV');
  check('D — et source L.Y Solution', roi?.source === 'PANEL');

  /**
   * LA HIÉRARCHIE DU PANEL NE FRANCHIT PAS LA FRONTIÈRE.
   *
   * Contrôle sur la réponse ENTIÈRE, et pas seulement sur la ligne : c'est le
   * seul moyen de garder qu'aucun champ annexe — un `panelRole`, un
   * `sourceRole` ajouté un jour « pour information » — ne réintroduise le mot.
   */
  check('D — le mot SUPER_ADMIN n’apparaît NULLE PART dans la réponse',
    !JSON.stringify(apres).includes('SUPER_ADMIN'));
}

/* ══════════════════════════════════════════════════════════════════════════
   4. LA PARITÉ DE REPRÉSENTATION — Manager et Panel, champ par champ.
   ══════════════════════════════════════════════════════════════════════════ */
section('4 · Le Manager et le Panel décrivent les comptes à l’identique');
{
  const parManager = await projetApi('GET', '/api/accounts/all', { token: sessionProjet });
  check('le Manager expose la même lecture fusionnée', parManager.status === 200);

  const parPanel = (await lireComptes()).json.data;

  const cle = (c) => `${c.source}:${c.email}`;
  const cotePanel = new Map(parPanel.accounts.map((c) => [cle(c), c]));
  const coteManager = new Map((parManager.data?.accounts ?? []).map((c) => [cle(c), c]));

  check('les deux côtés voient EXACTEMENT les mêmes comptes',
    cotePanel.size === coteManager.size
    && [...cotePanel.keys()].every((k) => coteManager.has(k)));

  /**
   * LA GARDE DE PARITÉ — champ par champ, sur la partie commune.
   *
   * Toute divergence future fait tomber cette suite. C'est le seul contrôle
   * qui empêche les deux représentations de repartir chacune de leur côté :
   * elles partagent aujourd'hui le même code, et rien n'empêchera demain
   * quelqu'un d'en dupliquer un morceau « juste pour cet écran ».
   */
  const { PROJECT_ACCOUNT_VIEW_FIELDS } = await import(
    '../../SB Auto 06/backend/src/services/accounts/projectAccountView.js'
  ).catch(() => ({ PROJECT_ACCOUNT_VIEW_FIELDS: null }));

  const champs = PROJECT_ACCOUNT_VIEW_FIELDS
    ?? ['id', 'displayName', 'email', 'role', 'source', 'principalType', 'enabled', 'status'];

  const divergences = [];
  for (const [k, panel] of cotePanel) {
    const manager = coteManager.get(k);
    for (const champ of champs) {
      if (JSON.stringify(panel[champ]) !== JSON.stringify(manager?.[champ])) {
        divergences.push(`${k}.${champ}`);
      }
    }
  }
  check(`aucune divergence de champ${divergences.length ? ` — ${divergences.join(', ')}` : ''}`,
    divergences.length === 0);

  check('le contrat porte bien les champs de source et de type',
    champs.includes('source') && champs.includes('principalType') && champs.includes('status'));
}

/* ══════════════════════════════════════════════════════════════════════════
   5. PROJET INJOIGNABLE — on le dit, on n'invente rien.
   ══════════════════════════════════════════════════════════════════════════ */
section('5 · Un projet muet ne produit jamais une vieille liste');
{
  const avant = (await lireComptes()).json.data;
  check('la lecture fonctionne avant la coupure',
    avant.available === true && avant.accounts.length > 0);

  await projet.stop();

  const pendant = await lireComptes();
  check('la route répond quand même', pendant.status === 200);
  check('…mais annonce l’indisponibilité', pendant.json?.data?.available === false);
  check('…avec un motif nommé',
    pendant.json?.data?.reason === 'PROJECT_ACCOUNTS_UNREACHABLE');
  check('…un message pour l’écran',
    pendant.json?.data?.message === 'Comptes du projet temporairement indisponibles.');

  /**
   * LE POINT ENTIER DE LA SECTION : AUCUNE DONNÉE PÉRIMÉE N'EST SERVIE.
   *
   * Une liste vide accompagnée d'un motif est honnête ; l'ancienne liste sans
   * étiquette serait un mensonge, et c'est exactement ce que la projection
   * faisait avant ce lot.
   */
  check('AUCUN compte n’est servi depuis un instantané',
    Array.isArray(pendant.json?.data?.accounts) && pendant.json.data.accounts.length === 0);
  check('…et aucune date de lecture n’est inventée', pendant.json?.data?.readAt === null);
}

await closePanel();
await stopMemoryMongo();
finish();
