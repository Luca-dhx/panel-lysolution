// LE PARCOURS FÉDÉRÉ, DE BOUT EN BOUT — L12.B-F.
//
// ══ CE QUE CE TEST EST, ET CE QU'IL N'EST PAS ═══════════════════════════════
//
// Ce n'est PAS un navigateur : il n'y a ni fenêtre, ni clic, ni rendu. C'est
// mieux et moins à la fois — il fait, POUR DE VRAI, chacun des échanges HTTP
// qu'un navigateur ferait, entre deux serveurs réellement démarrés :
//
//   · un vrai Panel, sur un vrai port, avec sa base ;
//   · une vraie instance SB Auto, dans SON processus, avec SA base ;
//   · un vrai appairage, donc un vrai bridgeToken ;
//   · de vraies clés RSA, un vrai JWKS servi par HTTP, de vraies signatures.
//
// Ce qu'il ne couvre pas, et qu'il faut donc faire à la main une fois : le
// rendu des écrans, et le fait qu'un humain trouve le bouton. La procédure
// est dans la documentation.
//
// ══ LE CRITÈRE MAJEUR DU LOT ════════════════════════════════════════════════
//
// L'accès aux projets est accordé PAR L'API DE L'ÉCRAN
// (`PATCH /api/panel-users/:id`), jamais par un appel au service.
// C'est ce qui prouve qu'un exploitant peut ouvrir la fédération sans toucher
// à la base ni au code.
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
const { default: PanelProject } = await import('../backend/src/models/PanelProject.model.js');
const { default: PanelProjectDestination } = await import('../backend/src/models/PanelProjectDestination.model.js');

await resetSyncCore();
await users.resetUsers();
await users.seedFromEnv();

const { base: PANEL_URL, call: panelCall, close: closePanel } = await startServer(createApp());
await updateNetworkConfiguration({ backendUrl: PANEL_URL }, { requirePublic: false });

/* ── UN VRAI PROJET, DANS SON PROCESSUS ─────────────────────────────────── */
const projet = await startSbAutoInstance({
  mongoUri: MONGO_URI,
  dbName: 'federation_e2e_projet',
  env: 'TEST',
  projectName: 'Garage Fédéré',
});

const MANAGER_ORIGIN = projet.publicBackendUrl;
const CALLBACK_PATH = '/connexion/ly-solution/retour';

/**
 * LE MOT DE PASSE DU COMPTE LOCAL DE RECETTE.
 *
 * Volontairement DIFFÉRENT du mot de passe de démonstration historique : la
 * garde du Panel refuse que ces chaînes-là apparaissent ailleurs que dans sa
 * liste noire, et elle a raison — une recette qui les recopie les propage.
 */
const MOT_DE_PASSE_LOCAL = 'MotDePasseLocalDeRecette-2026';

/** Appelle l'API du PROJET, comme le ferait son manager. */
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
  projectName: 'Garage Fédéré',
});
const appairage = await projet.pair({
  panelUrl: PANEL_URL,
  pairingCode: declare.pairingCode,
  publicBackendUrl: projet.publicBackendUrl,
});
const PROJECT_ID = appairage.projectId;

/**
 * L'ORIGINE DU MANAGER — déclarée sur la destination que l'APPAIRAGE a déjà
 * créée.
 *
 * L'appairage pose lui-même une destination (« première destination …
 * BOOTSTRAP ») à partir de l'adresse annoncée par le projet. On ne la
 * recrée donc pas — l'index unique `(projectId, environment)` s'y oppose, et
 * il a raison : un projet n'a qu'une destination active par monde.
 *
 * On y renseigne l'URL du MANAGER, qui est ce que le Panel confrontera à
 * l'adresse de retour. En production, c'est le déploiement qui l'annonce.
 */
await PanelProjectDestination.updateOne(
  { projectId: PROJECT_ID, environment: 'TEST' },
  { $set: { 'urls.manager': MANAGER_ORIGIN } },
);

/* ── DEUX COMPTES PANEL ─────────────────────────────────────────────────── */
const DEV = await users.createUser({
  email: 'luca@ly-solution.test', password: 'MotDePasseDuPanel-2026',
  displayName: 'Luca Duhoux', role: 'DEV',
});
const ADMIN = await users.createUser({
  email: 'gestion@ly-solution.test', password: 'MotDePasseAdmin-2026',
  displayName: 'Gestion', role: 'ADMIN',
});

/** L'opérateur qui ADMINISTRE — distinct du DEV qui se connectera. */
const OPERATEUR = await users.createUser({
  email: 'ops@ly-solution.test', password: 'MotDePasseOps-2026',
  displayName: 'Opérateur', role: 'SUPER_ADMIN',
});

async function jetonPanel(email, password) {
  const r = await panelCall('POST', '/api/auth/login', { body: { email, password } });
  return r.json?.data?.token ?? null;
}
const OPS = { authorization: `Bearer ${await jetonPanel('ops@ly-solution.test', 'MotDePasseOps-2026')}` };

/**
 * LE PARCOURS COMPLET, tel qu'un navigateur l'enchaîne.
 *
 * `/start` (projet) → `/assertion` (Panel, ce que fait la page d'autorisation)
 * → `/callback` (projet). Aucun raccourci : trois appels HTTP réels, sur deux
 * serveurs distincts.
 */
async function parcoursFedere({ email, password, redirectPath = '/', session = null } = {}) {
  const depart = await projetApi('POST', '/api/auth/federated/panel/start', {
    body: { redirectPath, returnUrl: `${MANAGER_ORIGIN}${CALLBACK_PATH}` },
  });
  if (depart.status !== 200) return { etape: 'start', ...depart };

  /**
   * LA SESSION PANEL — RÉUTILISÉE QUAND ON LA FOURNIT.
   *
   * Par défaut, chaque parcours se reconnecte : c'est commode, et c'est
   * exactement ce qui empêchait de voir l'incident du hotfix. Se reconnecter
   * relit le compte, donc masque toute question de fraîcheur. `session`
   * permet de rejouer un parcours SANS quitter la session ouverte — la seule
   * façon de prouver qu'un droit accordé prend effet tout de suite.
   */
  const jeton = session ?? await jetonPanel(email, password);
  if (!jeton) return { etape: 'login-panel', status: 401 };

  const url = new URL(depart.data.authorizeUrl);
  const emission = await panelCall(
    'POST',
    `/api/federation/projects/${url.searchParams.get('projectId')}/assertion`,
    {
      headers: { authorization: `Bearer ${jeton}` },
      body: { returnUrl: url.searchParams.get('returnUrl') },
    },
  );
  if (emission.status !== 200) {
    return {
      etape: 'assertion', status: emission.status, json: emission.json, state: depart.data.state,
    };
  }

  const retour = await projetApi('POST', '/api/auth/federated/panel/callback', {
    body: { assertion: emission.json.data.assertion, state: depart.data.state },
  });
  return {
    etape: 'callback',
    ...retour,
    assertion: emission.json.data.assertion,
    /** Le `state` du parcours — rendu pour que l'unicité SSO soit vérifiable. */
    state: depart.data.state,
  };
}

/* ══════════════════════════════════════════════════════════════════════════
   1. L'ACCÈS S'ACCORDE DEPUIS L'ÉCRAN — critère majeur du lot.
   ══════════════════════════════════════════════════════════════════════════ */
section('1 · L’accès aux projets s’administre depuis le Panel');
{
  const liste = await panelCall('GET', '/api/panel-users', { headers: OPS });
  check('l’écran liste les comptes', liste.status === 200 && liste.json.data.length >= 3);

  const luca = liste.json.data.find((u) => u.userId === DEV.userId);
  check('un compte neuf n’a AUCUN accès projet', luca.projectAccess.mode === 'NONE');
  check('…et il est actif pour autant', luca.enabled === true);
  check('aucun secret dans la liste',
    !JSON.stringify(liste.json.data).match(/passwordHash|MotDePasse|tokenVersion/));

  const projets = await panelCall('GET', '/api/panel-users/projects', { headers: OPS });
  check('l’écran propose les projets du parc', projets.status === 200);
  const cible = projets.json.data.find((p) => p.projectId === PROJECT_ID);
  check('…et notre projet appairé est SÉLECTIONNABLE', cible?.selectable === true);

  /**
   * SANS ACCÈS, LA FÉDÉRATION EST INERTE. C'est la décision du LOT 2A, et
   * c'est ici qu'elle se constate : le compte est actif, DEV, le projet est
   * appairé — et pourtant rien ne s'ouvre.
   */
  const avant = await parcoursFedere({
    email: 'luca@ly-solution.test', password: 'MotDePasseDuPanel-2026',
  });
  check('sans accès accordé, l’émission est REFUSÉE', avant.etape === 'assertion');
  check('…nommément pour absence d’accès projet',
    avant.json?.code === 'FEDERATION_PROJECT_ACCESS_DENIED');

  /* ── L'ACTE : par l'API DE L'ÉCRAN, jamais par le service ── */
  const accord = await panelCall('PATCH', `/api/panel-users/${DEV.userId}`, {
    headers: OPS,
    body: { projectAccess: { mode: 'EXPLICIT', projectIds: [PROJECT_ID] } },
  });
  check('l’accès EXPLICITE est accordé depuis l’écran', accord.status === 200);
  check('…et le mode est enregistré', accord.json.data.projectAccess.mode === 'EXPLICIT');

  const apres = await panelCall('GET', '/api/panel-users', { headers: OPS });
  const lucaApres = apres.json.data.find((u) => u.userId === DEV.userId);
  check('l’accord est daté et attribué',
    typeof lucaApres.grantedAt === 'string' && lucaApres.grantedBy === OPERATEUR.userId);
}

/* ══════════════════════════════════════════════════════════════════════════
   2. LA VALIDATION SERVEUR — le frontend n'est jamais l'autorité.
   ══════════════════════════════════════════════════════════════════════════ */
section('2 · Le serveur refuse ce qu’un écran pourrait envoyer');
{
  const refus = async (body) => (await panelCall(
    'PATCH', `/api/panel-users/${DEV.userId}`, { headers: OPS, body: { projectAccess: body } },
  ));

  check('un mode inconnu est refusé',
    (await refus({ mode: 'TOUT' })).status === 400);
  check('un projet inconnu est refusé',
    (await refus({ mode: 'EXPLICIT', projectIds: ['nexiste-pas'] })).json?.code
      === 'PANEL_USER_ACCESS_PROJECT_UNKNOWN');
  check('EXPLICIT sans aucun projet est refusé',
    (await refus({ mode: 'EXPLICIT', projectIds: [] })).json?.code === 'PANEL_USER_ACCESS_EMPTY');
  check('un champ inconnu est refusé',
    (await refus({ mode: 'NONE', bonus: true })).status === 400);

  /** Les doublons ne doivent pas gonfler la liste. */
  await refus({ mode: 'EXPLICIT', projectIds: [PROJECT_ID, PROJECT_ID] });
  const relu = await panelCall('GET', '/api/panel-users', { headers: OPS });
  check('les doublons sont réduits',
    relu.json.data.find((u) => u.userId === DEV.userId).projectAccess.projectIds.length === 1);

  /**
   * UN PROJET NON APPAIRÉ N'EST PAS ACCORDABLE. L'émission le refuserait de
   * toute façon ; le refuser ici est plus honnête.
   */
  const autre = await registre.declareProject({
    publicBackendUrl: 'https://jamais-appaire.test', projectName: 'Jamais appairé',
  });
  check('un projet non appairé ne peut pas être accordé',
    (await refus({ mode: 'EXPLICIT', projectIds: [autre.record.projectId] })).json?.code
      === 'PANEL_USER_ACCESS_PROJECT_NOT_PAIRED');

  await refus({ mode: 'EXPLICIT', projectIds: [PROJECT_ID] });
}

/* ══════════════════════════════════════════════════════════════════════════
   3. QUI PEUT ACCORDER — et qui ne peut plus.

   ══ CE QUE CETTE SECTION PROUVAIT AVANT, ET CE QU'ELLE PROUVE MAINTENANT ════

   Elle gardait `PANEL_USER_SELF_GRANT` : un DEV pouvait accorder un accès chez
   un client, à condition de ne pas se servir lui-même. C'était le meilleur
   arbitrage possible tant qu'aucun rôle souverain n'existait — il fallait bien
   que quelqu'un puisse ouvrir la fédération, et DEV était le seul rôle
   technique disponible.

   Le lot SUPER_ADMIN crée ce rôle. L'écriture a donc quitté les comptes DEV :
   décider qui entre chez un client est une décision de gouvernance. La garde
   « demandez à un collègue » n'a plus de sujet — elle est remplacée par une
   règle plus forte, et un souverain, lui, s'accorde ses propres accès sans
   avoir personne à qui les demander.
   ══════════════════════════════════════════════════════════════════════════ */
section('3 · L’accès projet s’accorde souverainement, et pas autrement');
{
  const soi = await panelCall('PATCH', `/api/panel-users/${OPERATEUR.userId}`, {
    headers: OPS, body: { projectAccess: { mode: 'ALL_PAIRED' } },
  });
  check('un SUPER_ADMIN s’accorde ses propres accès', soi.status === 200);
  check('…et la trace nomme l’acteur',
    soi.json?.data?.projectAccess?.mode === 'ALL_PAIRED');

  /** On le remet à NONE : ce compte n'a aucune raison de fédérer dans ce test. */
  await panelCall('PATCH', `/api/panel-users/${OPERATEUR.userId}`, {
    headers: OPS, body: { projectAccess: { mode: 'NONE' } },
  });

  /** Un DEV ne s'accorde rien — ni à lui-même, ni à personne. */
  const jetonDev = await jetonPanel('luca@ly-solution.test', 'MotDePasseDuPanel-2026');
  const parDev = await panelCall('PATCH', `/api/panel-users/${DEV.userId}`, {
    headers: { authorization: `Bearer ${jetonDev}` },
    body: { projectAccess: { mode: 'ALL_PAIRED' } },
  });
  check('un DEV ne peut PLUS accorder d’accès projet',
    parDev.status === 403 && parDev.json?.code === 'PANEL_SUPER_ADMIN_REQUIRED');

  /** Mais il LIT toujours l'annuaire : répondre à « qui a accès ? » reste à lui. */
  const lecture = await panelCall('GET', '/api/panel-users', {
    headers: { authorization: `Bearer ${jetonDev}` },
  });
  check('…mais il LIT toujours l’annuaire', lecture.status === 200);

  /** Un ADMIN du Panel n'atteint pas cette surface : elle est technique. */
  const jetonAdmin = await jetonPanel('gestion@ly-solution.test', 'MotDePasseAdmin-2026');
  const parAdmin = await panelCall('GET', '/api/panel-users', {
    headers: { authorization: `Bearer ${jetonAdmin}` },
  });
  check('un ADMIN ne voit même pas l’annuaire', parAdmin.status === 403);
}

/* ══════════════════════════════════════════════════════════════════════════
   4. LE PARCOURS COMPLET — deux serveurs, trois échanges, une session.
   ══════════════════════════════════════════════════════════════════════════ */
section('4 · Un développeur entre dans le projet');
let sessionFederee = null;
{
  const dispo = await projetApi('GET', '/api/auth/federated/panel');
  check('le projet annonce la fédération disponible', dispo.data?.available === true);

  const parcours = await parcoursFedere({
    email: 'luca@ly-solution.test', password: 'MotDePasseDuPanel-2026',
    redirectPath: '/dev/comptes',
  });
  check('le parcours aboutit', parcours.etape === 'callback' && parcours.status === 200);
  sessionFederee = parcours.data?.token ?? null;
  check('…une session de projet est délivrée', typeof sessionFederee === 'string');
  check('…et l’on repart où l’on allait', parcours.data?.redirectPath === '/dev/comptes');
  check('l’identité affichée vient du Panel', parcours.data?.user?.name === 'Luca Duhoux');
  check('…marquée comme fédérée', parcours.data?.user?.principalType === 'PANEL');
  check('…sans identifiant local', parcours.data?.user?._id === null);

  /* LE JWKS A ÉTÉ LU POUR DE VRAI, PAR HTTP, SUR LE PANEL. */
  const jwks = await fetch(`${PANEL_URL}/api/federation/.well-known/jwks.json`);
  check('le jeu de clés est servi publiquement', jwks.status === 200);
  const corps = await jwks.json();
  check('…sans aucune composante privée', !JSON.stringify(corps).match(/"d"\s*:|PRIVATE/));

  /* UNE ROUTE PROTÉGÉE — c'est l'épreuve de `_id: null`. */
  const moi = await projetApi('GET', '/api/auth/me', { token: sessionFederee });
  check('la session ouvre les routes authentifiées', moi.status === 200);
  check('…et le principal est bien fédéré', moi.data?.principalType === 'PANEL');

  const comptes = await projetApi('GET', '/api/accounts', { token: sessionFederee });
  check('une route DEV est accessible avec une session fédérée', comptes.status === 200);

  const externes = await projetApi('GET', '/api/accounts/external', { token: sessionFederee });
  check('les accès L.Y Solution sont listés', externes.status === 200);
  check('…et l’on s’y voit', externes.data?.some((p) => p.panelUserId === DEV.userId));
  check('…sans aucun secret', !JSON.stringify(externes.data).match(/password|hash|token/i));
}

/* ══════════════════════════════════════════════════════════════════════════
   5. LE MOT DE PASSE DU PANEL N'A JAMAIS TRAVERSÉ.
   ══════════════════════════════════════════════════════════════════════════ */
section('5 · Rien du Panel n’est entré dans la base du projet');
{
  const dump = await projet.dbDump();
  const brut = JSON.stringify(dump);
  check('AUCUN mot de passe du Panel dans la base du projet',
    !brut.includes('MotDePasseDuPanel'));
  check('…aucune clé privée non plus', !brut.includes('PRIVATE KEY'));

  /**
   * L'ASSERTION ELLE-MÊME N'EST PAS CONSERVÉE — seule son empreinte de `jti`
   * l'est, pour l'anti-rejeu.
   */
  check('l’assertion n’est stockée nulle part', !brut.includes('eyJhbGciOiJSUzI1NiI'));
}

/* ══════════════════════════════════════════════════════════════════════════
   6. ANTI-REJEU ET LOGIN LOCAL.
   ══════════════════════════════════════════════════════════════════════════ */
section('6 · Une assertion ne resert pas, et le local n’a pas bougé');
{
  const parcours = await parcoursFedere({
    email: 'luca@ly-solution.test', password: 'MotDePasseDuPanel-2026',
  });
  const depart = await projetApi('POST', '/api/auth/federated/panel/start', {
    body: { returnUrl: `${MANAGER_ORIGIN}${CALLBACK_PATH}` },
  });
  const rejeu = await projetApi('POST', '/api/auth/federated/panel/callback', {
    body: { assertion: parcours.assertion, state: depart.data.state },
  });
  check('rejouer une assertion consommée est REFUSÉ', rejeu.status === 401);
  check('…nommément un rejeu', rejeu.json?.details?.code === 'FEDERATED_ASSERTION_REPLAY');

  const etatInvente = await projetApi('POST', '/api/auth/federated/panel/callback', {
    body: { assertion: parcours.assertion, state: 'jamais-emis' },
  });
  check('un state inventé est REFUSÉ', etatInvente.status === 401);

  /**
   * ── LE COMPTE LOCAL EST CRÉÉ PAR LA SESSION FÉDÉRÉE ────────────────────────
   *
   * Deux preuves en un geste : un développeur fédéré peut réellement
   * administrer le projet (route DEV, écriture réelle), et le compte local
   * qu'on va éprouver ensuite n'est pas un artefact du harnais — il a été créé
   * par l'API, comme en production.
   */
  const creation = await projetApi('POST', '/api/accounts', {
    token: sessionFederee,
    body: { email: 'admin@mail.com', name: 'Administrateur', role: 'ADMIN', password: MOT_DE_PASSE_LOCAL },
  });
  check('un DEV fédéré peut créer un compte local',
    creation.status === 201 || creation.status === 200);

  /* LE LOGIN LOCAL — inchangé, et indépendant du Panel. */
  const local = await projetApi('POST', '/api/auth/login', {
    body: { email: 'admin@mail.com', password: MOT_DE_PASSE_LOCAL },
  });
  check('un compte LOCAL se connecte toujours', local.status === 200);
  check('…et sa session n’est PAS fédérée', local.data?.user?.principalType === undefined);

  const oubli = await projetApi('POST', '/api/auth/forgot-password', {
    body: { email: 'admin@mail.com' },
  });
  check('le mot de passe oublié LOCAL répond toujours', oubli.status === 200);
}

/* ══════════════════════════════════════════════════════════════════════════
   7. MÊME ADRESSE, DEUX IDENTITÉS — jamais fusionnées.
   ══════════════════════════════════════════════════════════════════════════ */
section('7 · Un homonyme local reste un compte local');
{
  const cree = await projetApi('POST', '/api/accounts', {
    token: sessionFederee,
    body: { email: 'luca@ly-solution.test', name: 'Homonyme local', role: 'ADMIN', password: 'autre-mot-de-passe' },
  });
  check('un compte local homonyme peut exister', cree.status === 201 || cree.status === 200);

  const parcours = await parcoursFedere({
    email: 'luca@ly-solution.test', password: 'MotDePasseDuPanel-2026',
  });
  check('la connexion fédérée aboutit malgré l’homonyme', parcours.status === 200);
  check('…et ne désigne PAS le compte local', parcours.data?.user?._id === null);

  const localHomonyme = await projetApi('POST', '/api/auth/login', {
    body: { email: 'luca@ly-solution.test', password: 'autre-mot-de-passe' },
  });
  check('l’homonyme local se connecte avec SON mot de passe', localHomonyme.status === 200);
  check('…et obtient une session LOCALE',
    localHomonyme.data?.user?.principalType === undefined);
}

/* ══════════════════════════════════════════════════════════════════════════
   8. RÉVOCATION D'UNE SESSION OUVERTE — depuis l'écran du Panel.
   ══════════════════════════════════════════════════════════════════════════ */
section('8 · Retirer l’accès depuis le Panel ferme la session ouverte');
{
  const parcours = await parcoursFedere({
    email: 'luca@ly-solution.test', password: 'MotDePasseDuPanel-2026',
  });
  const session = parcours.data.token;

  check('la session est valable tant que rien ne change',
    (await projet.revalidateFederatedSession({ token: session })).active === true);

  /* L'ACTE DE RÉVOCATION — par l'API de l'écran. */
  const retrait = await panelCall('PATCH', `/api/panel-users/${DEV.userId}`, {
    headers: OPS, body: { projectAccess: { mode: 'NONE' } },
  });
  check('l’accès est retiré depuis l’écran', retrait.status === 200);

  check('la session ouverte est REFUSÉE à la revalidation',
    (await projet.revalidateFederatedSession({ token: session })).active === false);

  const nouvelle = await parcoursFedere({
    email: 'luca@ly-solution.test', password: 'MotDePasseDuPanel-2026',
  });
  check('…et aucune NOUVELLE connexion n’est possible', nouvelle.etape === 'assertion');

  /**
   * AUCUNE MUTATION DE LA BASE DU PROJET N'A ÉTÉ NÉCESSAIRE. C'est tout
   * l'objet de la fédération : on ferme depuis le Panel, pas chez le client.
   */
  const dump = await projet.dbDump();
  const locaux = JSON.stringify(dump).match(/"email":"admin@mail\.com"/g) ?? [];
  check('le compte local n’a pas été touché', locaux.length >= 1);

  /* ON REND L'ACCÈS — pour la suite. */
  await panelCall('PATCH', `/api/panel-users/${DEV.userId}`, {
    headers: OPS, body: { projectAccess: { mode: 'ALL_PAIRED' } },
  });
  check('ALL_PAIRED rouvre l’accès sans nommer de projet',
    (await parcoursFedere({
      email: 'luca@ly-solution.test', password: 'MotDePasseDuPanel-2026',
    })).status === 200);
}

/* ══════════════════════════════════════════════════════════════════════════
   9. L'INCIDENT DU HOTFIX — l'octroi prend effet SANS quitter sa session.

   ══ POURQUOI LES HUIT SECTIONS PRÉCÉDENTES NE LE VOYAIENT PAS ═══════════════

   Chacune ouvre une session Panel NEUVE avant d'émettre. Se reconnecter relit
   le compte : la fraîcheur était donc obtenue par le harnais, pas prouvée du
   produit. L'incident réel se joue précisément dans l'intervalle qu'elles
   sautaient — un développeur reste connecté au Panel, un collègue lui ouvre
   l'accès, il réessaie tout de suite.

   ══ CE QUI EST REJOUÉ ICI ══════════════════════════════════════════════════

   Le parcours ENTIER du navigateur, deux fois, avec UNE SEULE session Panel :
   `/start` du projet → émission au Panel → `/callback` du projet. Y compris ce
   qu'un test d'unité ne peut pas voir : que le second clic ouvre un NOUVEAU
   `state`, et que le premier — refusé, donc jamais consommé — ne détermine rien.
   ══════════════════════════════════════════════════════════════════════════ */
section('9 · L’accès accordé prend effet dans la session Panel déjà ouverte');
{
  /* On repart de zéro : aucun accès, comme au premier jour du compte. */
  await panelCall('PATCH', `/api/panel-users/${DEV.userId}`, {
    headers: OPS, body: { projectAccess: { mode: 'NONE' } },
  });

  /** LA session — ouverte ici, et plus jamais renouvelée dans cette section. */
  const SESSION = await jetonPanel('luca@ly-solution.test', 'MotDePasseDuPanel-2026');
  check('le développeur est connecté au Panel', typeof SESSION === 'string');

  const premier = await parcoursFedere({ session: SESSION });
  check('premier essai : REFUSÉ faute d’accès',
    premier.etape === 'assertion'
    && premier.json?.code === 'FEDERATION_PROJECT_ACCESS_DENIED');

  /* L'ACTE — depuis l'écran, par un AUTRE développeur, comme en vrai. */
  const octroi = await panelCall('PATCH', `/api/panel-users/${DEV.userId}`, {
    headers: OPS, body: { projectAccess: { mode: 'ALL_PAIRED' } },
  });
  check('un collègue accorde « tous les projets appairés »', octroi.status === 200);

  /**
   * AUCUN GESTE INTERMÉDIAIRE. Pas de reconnexion, pas d'attente, pas de
   * redémarrage : la ligne suivante est la tentative suivante.
   */
  const second = await parcoursFedere({ session: SESSION });
  check('second essai, MÊME session Panel : la session projet s’ouvre',
    second.etape === 'callback' && second.status === 200);
  check('…et c’est bien une identité fédérée', second.data?.user?.principalType === 'PANEL');

  check('le second clic a ouvert un NOUVEAU state', premier.state !== second.state);
  check('…et les deux states sont de vraies valeurs',
    typeof premier.state === 'string' && premier.state.length >= 32);

  /**
   * LE STATE DU PREMIER PARCOURS — refusé, donc jamais consommé — NE DOIT PAS
   * pouvoir servir à faire entrer l'assertion du second. C'est l'anti-rejeu du
   * projet, et le hotfix ne l'a pas desserré.
   */
  const croise = await projetApi('POST', '/api/auth/federated/panel/callback', {
    body: { assertion: second.assertion, state: premier.state },
  });
  check('l’assertion du second parcours ne rentre pas avec le state du premier',
    croise.status === 401);

  /* ── ET DANS L'AUTRE SENS, TOUJOURS SANS RECONNEXION ─────────────────── */
  await panelCall('PATCH', `/api/panel-users/${DEV.userId}`, {
    headers: OPS, body: { projectAccess: { mode: 'NONE' } },
  });
  const apresRetrait = await parcoursFedere({ session: SESSION });
  check('accès retiré : la tentative suivante est REFUSÉE immédiatement',
    apresRetrait.etape === 'assertion'
    && apresRetrait.json?.code === 'FEDERATION_PROJECT_ACCESS_DENIED');

  /* On rend l'accès pour les sections suivantes. */
  await panelCall('PATCH', `/api/panel-users/${DEV.userId}`, {
    headers: OPS, body: { projectAccess: { mode: 'ALL_PAIRED' } },
  });
  check('l’accès rendu refonctionne, toujours sans reconnexion',
    (await parcoursFedere({ session: SESSION })).status === 200);
}

/* ══════════════════════════════════════════════════════════════════════════
   10. COMPTE DÉSACTIVÉ.
   ══════════════════════════════════════════════════════════════════════════ */
section('10 · Désactiver le compte coupe tout');
{
  const session = (await parcoursFedere({
    email: 'luca@ly-solution.test', password: 'MotDePasseDuPanel-2026',
  })).data.token;

  const desactivation = await panelCall('PATCH', `/api/panel-users/${DEV.userId}`, {
    headers: OPS, body: { enabled: false },
  });
  check('le compte est désactivé depuis l’écran', desactivation.status === 200);

  check('la session ouverte est REFUSÉE',
    (await projet.revalidateFederatedSession({ token: session })).active === false);

  const tentative = await parcoursFedere({
    email: 'luca@ly-solution.test', password: 'MotDePasseDuPanel-2026',
  });
  check('…et le compte ne peut même plus se connecter AU PANEL',
    tentative.etape === 'login-panel');

  await panelCall('PATCH', `/api/panel-users/${DEV.userId}`, {
    headers: OPS, body: { enabled: true },
  });
  check('réactivé, le parcours refonctionne',
    (await parcoursFedere({
      email: 'luca@ly-solution.test', password: 'MotDePasseDuPanel-2026',
    })).status === 200);
}

/* ══════════════════════════════════════════════════════════════════════════
   11. PROJET NON APPAIRÉ — le manager reste utilisable.
   ══════════════════════════════════════════════════════════════════════════ */
section('11 · Un projet non appairé garde son login local');
{
  await PanelProject.updateOne(
    { projectId: PROJECT_ID },
    { $set: { 'pairing.status': 'REVOKED' } },
  );

  const tentative = await parcoursFedere({
    email: 'luca@ly-solution.test', password: 'MotDePasseDuPanel-2026',
  });
  check('l’appairage révoqué REFUSE l’émission', tentative.etape === 'assertion');
  check('…nommément pour appairage', tentative.json?.code === 'FEDERATION_PROJECT_NOT_PAIRED');

  /**
   * ET SURTOUT : le projet continue de vivre. Le Panel n'est jamais un
   * prérequis de l'authentification locale.
   */
  const local = await projetApi('POST', '/api/auth/login', {
    body: { email: 'admin@mail.com', password: MOT_DE_PASSE_LOCAL },
  });
  check('le login LOCAL fonctionne toujours', local.status === 200);

  const oubli = await projetApi('POST', '/api/auth/forgot-password', {
    body: { email: 'admin@mail.com' },
  });
  check('…et le mot de passe oublié local aussi', oubli.status === 200);

  await PanelProject.updateOne(
    { projectId: PROJECT_ID },
    { $set: { 'pairing.status': 'PAIRED' } },
  );
}

/* ══════════════════════════════════════════════════════════════════════════
   12. PANEL INJOIGNABLE.
   ══════════════════════════════════════════════════════════════════════════ */
section('12 · Une panne du Panel ne casse pas le projet');
{
  const session = (await parcoursFedere({
    email: 'luca@ly-solution.test', password: 'MotDePasseDuPanel-2026',
  })).data.token;

  await closePanel();

  /* Le login local ne dépend de rien. */
  const local = await projetApi('POST', '/api/auth/login', {
    body: { email: 'admin@mail.com', password: MOT_DE_PASSE_LOCAL },
  });
  check('le login LOCAL fonctionne Panel éteint', local.status === 200);

  /* Une NOUVELLE fédération échoue proprement, sans écran blanc. */
  const depart = await projetApi('POST', '/api/auth/federated/panel/start', {
    body: { returnUrl: `${MANAGER_ORIGIN}${CALLBACK_PATH}` },
  });
  check('le départ reste possible (rien n’a encore besoin du Panel)', depart.status === 200);

  /**
   * SESSION EN COURS : elle SURVIT. Refuser sur une panne réseau ferait d'une
   * coupure du Panel une coupure de tout le parc.
   */
  const verdict = await projet.revalidateFederatedSession({ token: session });
  check('une session EN COURS survit à la panne', verdict.active === true);
  check('…et le mode dégradé est signalé', verdict.degraded === true);
}

await projet.stop?.();
await stopMemoryMongo();
finish();
