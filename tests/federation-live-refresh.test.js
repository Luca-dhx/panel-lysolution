/**
 * L'AUTORISATION FÉDÉRÉE EST VIVANTE — LOT 2B HOTFIX.
 *
 * ══ L'INCIDENT QUE CETTE SUITE VERROUILLE ═══════════════════════════════════
 *
 * Un développeur se voit refuser l'entrée dans un projet ; on lui accorde
 * « tous les projets appairés » depuis l'écran des comptes ; il réessaie
 * aussitôt — et lit le MÊME refus. Rien, dans ce parcours, ne devrait exiger
 * une reconnexion, une attente, ni un rechargement.
 *
 * ══ CE QUE CHAQUE MOITIÉ PROUVE, ET POURQUOI IL EN FAUT DEUX ════════════════
 *
 * L'autorisation traverse deux mondes, et un cache dans l'un suffit à figer la
 * décision de l'autre :
 *
 *   · LE SERVEUR — l'autorité. Il doit RELIRE le compte à chaque émission, dans
 *     les deux sens, et `ALL_PAIRED` doit rester une question posée au parc et
 *     non une liste figée à l'octroi. Éprouvé ici sur un vrai Panel HTTP, avec
 *     UNE SEULE session Panel du début à la fin — c'est tout l'enjeu : la
 *     recette qui se reconnecte entre deux essais ne prouve rien.
 *
 *   · L'ÉCRAN — jamais l'autorité, mais parfaitement capable de conserver la
 *     réponse d'autrui. Le hook est EXÉCUTÉ, pas relu : un contrôle de source
 *     ne dirait pas si une nouvelle tentative repose la question.
 */
import { register } from 'node:module';

import {
  check, connectTestDatabase, finish, section, setTestEnv,
  startMemoryMongo, startServer, stopMemoryMongo,
} from './helpers/harness.js';
import { mount } from './helpers/reactHarness.mjs';

register('./helpers/frontendLoader.mjs', import.meta.url);

setTestEnv();
await startMemoryMongo();
await connectTestDatabase();

const { createApp } = await import('../backend/src/app.js');
const users = await import('../backend/src/services/auth/panelUsers.service.js');
const registre = await import('../backend/src/services/registry/projectRegistry.service.js');
const { default: PanelProject } = await import('../backend/src/models/PanelProject.model.js');
const { default: PanelUser } = await import('../backend/src/models/PanelUser.model.js');

await users.resetUsers();

/**
 * DEUX COMPTES, ET LA SÉPARATION N'EST PAS DÉCORATIVE.
 *
 * L'administration des accès est SOUVERAINE : seul un SUPER_ADMIN écrit. La
 * recette reflète donc la vie réelle — un souverain accorde, un développeur se
 * connecte. Accorder depuis le compte DEV qui fédère serait refusé par la
 * route elle-même, et ne prouverait rien de la fraîcheur.
 */
const OPERATEUR = await users.createUser({
  email: 'ops@panel.test', password: 'Operateur-2026', displayName: 'Opérateur', role: 'SUPER_ADMIN',
});
const DEV = await users.createUser({
  email: 'dev@panel.test', password: 'Developpeur-2026', displayName: 'Développeur', role: 'DEV',
});

const { call, close } = await startServer(createApp());

async function jetonDe(email, password) {
  const r = await call('POST', '/api/auth/login', { body: { email, password } });
  return r.json?.data?.token ?? null;
}

/* ── LE PARC : un projet appairé, un projet qui ne l'est pas ENCORE ──────── */
const demo = await registre.declareProject({
  publicBackendUrl: 'https://demo-sb-auto.test', projectName: 'Demo SB Auto',
});
const SB_AUTO = demo.record.projectId;
await PanelProject.updateOne({ projectId: SB_AUTO }, { $set: { 'pairing.status': 'PAIRED' } });

const autre = await registre.declareProject({
  publicBackendUrl: 'https://kwash.test', projectName: 'Kwash',
});
const KWASH = autre.record.projectId;
await PanelProject.updateOne({ projectId: KWASH }, { $set: { 'pairing.status': 'PAIRED' } });

/** Déclaré, jamais appairé — il ne le deviendra qu'à la section « dynamique ». */
const tardif = await registre.declareProject({
  publicBackendUrl: 'https://tardif.test', projectName: 'Projet tardif',
});
const TARDIF = tardif.record.projectId;

const OPS = { authorization: `Bearer ${await jetonDe('ops@panel.test', 'Operateur-2026')}` };

/**
 * ══ LA SESSION PANEL DU DÉVELOPPEUR — OUVERTE UNE FOIS, ET JAMAIS RENOUVELÉE ═
 *
 * C'est la variable de contrôle de toute la suite. Chaque tentative de
 * fédération, de la première à la dernière, présente CE jeton-ci. Le jour où
 * quelqu'un ajoutera une reconnexion « pour faire propre », la moitié des
 * contrôles cesseront de prouver ce qu'ils prétendent — d'où cette insistance.
 */
const SESSION_PANEL = await jetonDe('dev@panel.test', 'Developpeur-2026');
const DEV_SESSION = { authorization: `Bearer ${SESSION_PANEL}` };

/** Ce que fait la page d'autorisation, et rien d'autre. */
function tenterFederation(projectId, retour) {
  return call('POST', `/api/federation/projects/${projectId}/assertion`, {
    headers: DEV_SESSION,
    body: { returnUrl: retour, state: 'e'.repeat(43) },
  });
}
const RETOUR_SB = 'https://demo-sb-auto.test/connexion/ly-solution/retour';
const RETOUR_KWASH = 'https://kwash.test/connexion/ly-solution/retour';
const RETOUR_TARDIF = 'https://tardif.test/connexion/ly-solution/retour';

/** L'ACTE d'administration, par l'API DE L'ÉCRAN — jamais par le service. */
function accorder(projectAccess) {
  return call('PATCH', `/api/panel-users/${DEV.userId}`, { headers: OPS, body: { projectAccess } });
}

/** L'état RÉELLEMENT persisté, relu en base. */
function enBase() {
  return PanelUser.findOne({ userId: DEV.userId }).lean();
}

/* ══════════════════════════════════════════════════════════════════════════
   1. LES QUATRE ÉTATS, À L'INSTANT DU REFUS.
   ══════════════════════════════════════════════════════════════════════════ */
section('1 · SCÉNARIO A — sans accès, la fédération est refusée');
let versionInitiale = null;
{
  const avant = await enBase();
  versionInitiale = avant.tokenVersion ?? 0;
  check('base : le compte neuf est en NONE', (avant.projectAccess?.mode ?? 'NONE') === 'NONE');
  check('base : …et il est actif, et DEV', avant.enabled !== false && avant.role === 'DEV');

  const refus = await tenterFederation(SB_AUTO, RETOUR_SB);
  check('l’émission est REFUSÉE', refus.status === 403);
  check('…nommément pour absence d’accès projet',
    refus.json?.code === 'FEDERATION_PROJECT_ACCESS_DENIED');

  /**
   * LA SESSION PANEL N'EMBARQUE AUCUN DROIT PROJET.
   *
   * Si elle en portait une copie, c'est elle qu'il faudrait rafraîchir — et le
   * seul moyen de le faire serait de se reconnecter. Le contrôle vaut donc
   * doctrine : la session prouve QUI, jamais QUOI.
   */
  const [, corps] = SESSION_PANEL.split('.');
  const claims = JSON.parse(Buffer.from(corps, 'base64url').toString('utf8'));
  check('la session Panel ne porte AUCUN projectAccess',
    !Object.prototype.hasOwnProperty.call(claims, 'projectAccess'));
  check('…ni aucun rôle projet, ni aucune liste de projets',
    !JSON.stringify(claims).includes(SB_AUTO));

  /** Une réponse d'autorisation ne se met jamais en cache. */
  check('la réponse d’autorisation est `no-store`',
    /no-store/.test(refus.headers?.get?.('cache-control') ?? ''));
}

/* ══════════════════════════════════════════════════════════════════════════
   2. L'INCIDENT EXACT.
   ══════════════════════════════════════════════════════════════════════════ */
section('2 · SCÉNARIO B — NONE → ALL_PAIRED, même session, effet immédiat');
{
  const octroi = await accorder({ mode: 'ALL_PAIRED' });
  check('l’écran accorde « tous les projets appairés »', octroi.status === 200);

  const apres = await enBase();
  check('base : le mode est bien persisté', apres.projectAccess?.mode === 'ALL_PAIRED');
  check('base : …et AUCUNE liste n’a été figée',
    (apres.projectAccess?.projectIds ?? []).length === 0);

  /**
   * LA VERSION DE SESSION N'A PAS BOUGÉ — et c'est la doctrine, pas un oubli.
   *
   * Incrémenter `tokenVersion` sur un changement d'ACCÈS invaliderait la
   * session Panel de l'intéressé : il faudrait se reconnecter pour profiter
   * d'un droit qu'on vient de recevoir. Or `tokenVersion` répond à « faut-il
   * déconnecter partout MAINTENANT » — question de RÉVOCATION D'IDENTITÉ, à
   * laquelle « on lui ouvre un projet de plus » n'est pas une réponse.
   *
   * Le retrait d'accès, lui, n'a pas besoin de cet incrément non plus : les
   * sessions PROJET ouvertes sont coupées par l'introspection, qui relit
   * l'accès courant. Rien n'exige donc de casser la session PANEL.
   */
  check('modifier l’accès n’incrémente PAS tokenVersion',
    (apres.tokenVersion ?? 0) === versionInitiale);

  const nouvelEssai = await tenterFederation(SB_AUTO, RETOUR_SB);
  check('MÊME session Panel : la nouvelle tentative est ACCORDÉE',
    nouvelEssai.status === 200);
  check('…avec une assertion pour CE projet',
    nouvelEssai.json?.data?.audience === SB_AUTO
    && typeof nouvelEssai.json?.data?.assertion === 'string');
}

/* ══════════════════════════════════════════════════════════════════════════
   3. LA FRAÎCHEUR VA DANS LES DEUX SENS.
   ══════════════════════════════════════════════════════════════════════════ */
section('3 · SCÉNARIO C — ALL_PAIRED → NONE, refus immédiat');
{
  const retrait = await accorder({ mode: 'NONE' });
  check('l’écran retire tout accès', retrait.status === 200);
  check('base : le mode est revenu à NONE',
    (await enBase()).projectAccess?.mode === 'NONE');

  const refus = await tenterFederation(SB_AUTO, RETOUR_SB);
  check('MÊME session Panel : la tentative suivante est REFUSÉE',
    refus.status === 403 && refus.json?.code === 'FEDERATION_PROJECT_ACCESS_DENIED');
}

/* ══════════════════════════════════════════════════════════════════════════
   4. LE MODE EXPLICITE DÉSIGNE, ET N'ÉTEND PAS.
   ══════════════════════════════════════════════════════════════════════════ */
section('4 · SCÉNARIOS D & E — EXPLICIT ne couvre que ce qu’il nomme');
{
  check('l’accès explicite à Demo SB Auto est accordé',
    (await accorder({ mode: 'EXPLICIT', projectIds: [SB_AUTO] })).status === 200);
  check('D — le projet nommé est ACCORDÉ',
    (await tenterFederation(SB_AUTO, RETOUR_SB)).status === 200);

  const voisin = await tenterFederation(KWASH, RETOUR_KWASH);
  check('E — un AUTRE projet est REFUSÉ',
    voisin.status === 403 && voisin.json?.code === 'FEDERATION_PROJECT_ACCESS_DENIED');
}

/* ══════════════════════════════════════════════════════════════════════════
   5. ALL_PAIRED EST UNE QUESTION, PAS UN INSTANTANÉ.
   ══════════════════════════════════════════════════════════════════════════ */
section('5 · SCÉNARIOS F & G — ALL_PAIRED suit l’appairage, dans les deux sens');
{
  check('« tous les projets appairés » est accordé',
    (await accorder({ mode: 'ALL_PAIRED' })).status === 200);

  /**
   * F — le projet n'est pas appairé : ALL_PAIRED ne l'invente pas.
   * On le prouve sur le projet TARDIF, resté `DECLARED` depuis le départ.
   */
  const pasAppaire = await tenterFederation(TARDIF, RETOUR_TARDIF);
  check('F — ALL_PAIRED n’ouvre PAS un projet non appairé',
    pasAppaire.status === 403 && pasAppaire.json?.code === 'FEDERATION_PROJECT_NOT_PAIRED');

  /** …ni un projet dont l'appairage a été RÉVOQUÉ depuis. */
  await PanelProject.updateOne({ projectId: KWASH }, { $set: { 'pairing.status': 'REVOKED' } });
  const revoque = await tenterFederation(KWASH, RETOUR_KWASH);
  check('F — …ni un projet dont l’appairage est révoqué',
    revoque.status === 403 && revoque.json?.code === 'FEDERATION_PROJECT_NOT_PAIRED');

  /**
   * G — LE PROJET EST APPAIRÉ APRÈS L'OCTROI.
   *
   * C'est LA preuve que le mode n'a pas été traduit en liste au moment de
   * l'enregistrement : aucune liste écrite avant ne pourrait contenir ce
   * projet-là, puisqu'il n'était pas appairable.
   */
  await PanelProject.updateOne({ projectId: TARDIF }, { $set: { 'pairing.status': 'PAIRED' } });
  check('G — appairé APRÈS l’octroi, le projet est ACCORDÉ sans nouvel acte',
    (await tenterFederation(TARDIF, RETOUR_TARDIF)).status === 200);

  const stocke = await enBase();
  check('…et rien n’a été figé en base entre-temps',
    stocke.projectAccess?.mode === 'ALL_PAIRED'
    && (stocke.projectAccess?.projectIds ?? []).length === 0);

  await PanelProject.updateOne({ projectId: KWASH }, { $set: { 'pairing.status': 'PAIRED' } });
}

/* ══════════════════════════════════════════════════════════════════════════
   6. LES GARDES QUI NE DOIVENT PAS AVOIR ÉTÉ AFFAIBLIES.
   ══════════════════════════════════════════════════════════════════════════ */
section('6 · Ce que la fraîcheur n’a pas le droit d’ouvrir');
{
  /**
   * UN SOUVERAIN S'ACCORDE SES PROPRES ACCÈS — c'est la doctrine du lot
   * SUPER_ADMIN, et elle remplace l'ancienne garde `PANEL_USER_SELF_GRANT`.
   * Celle-ci répartissait un pouvoir souverain entre pairs DEV ; il est
   * désormais nommé, et son titulaire n'a personne à qui le demander.
   */
  const soi = await call('PATCH', `/api/panel-users/${OPERATEUR.userId}`, {
    headers: OPS, body: { projectAccess: { mode: 'ALL_PAIRED' } },
  });
  check('un SUPER_ADMIN s’accorde ses propres accès', soi.status === 200);

  const jetonAdmin = await (async () => {
    await users.createUser({
      email: 'gestion@panel.test', password: 'Gestion-2026', displayName: 'Gestion', role: 'ADMIN',
    });
    return jetonDe('gestion@panel.test', 'Gestion-2026');
  })();
  const parAdmin = await call('PATCH', `/api/panel-users/${DEV.userId}`, {
    headers: { authorization: `Bearer ${jetonAdmin}` }, body: { projectAccess: { mode: 'NONE' } },
  });
  check('un ADMIN ne peut toujours pas accorder d’accès projet', parAdmin.status === 403);

  /** Et un DEV non plus : l'écriture a quitté les comptes développeur. */
  const parDev = await call('PATCH', `/api/panel-users/${DEV.userId}`, {
    headers: DEV_SESSION, body: { projectAccess: { mode: 'ALL_PAIRED' } },
  });
  check('un DEV ne s’accorde PAS ses propres accès',
    parDev.status === 403 && parDev.json?.code === 'PANEL_SUPER_ADMIN_REQUIRED');

  /** L'identité ne se déclare pas dans le corps — même en réessayant. */
  const forge = await call('POST', `/api/federation/projects/${SB_AUTO}/assertion`, {
    headers: DEV_SESSION,
    body: { returnUrl: RETOUR_SB, projectAccess: { mode: 'ALL_PAIRED' } },
  });
  check('un corps qui porte projectAccess est REFUSÉ',
    forge.status === 400 && forge.json?.code === 'FEDERATION_IDENTITY_IN_BODY');

  /** Une adresse de retour étrangère au projet reste refusée. */
  const ailleurs = await call('POST', `/api/federation/projects/${SB_AUTO}/assertion`, {
    headers: DEV_SESSION, body: { returnUrl: 'https://ailleurs.test/vol' },
  });
  check('une adresse de retour inconnue reste REFUSÉE', ailleurs.status === 400);
}

/* ══════════════════════════════════════════════════════════════════════════
   7. L'OBSERVABILITÉ DU REFUS ET DE L'ACCORD.
   ══════════════════════════════════════════════════════════════════════════ */
section('7 · Le journal nomme l’état qui a décidé, et aucun secret');
{
  const capture = [];
  const vrai = console.log;
  console.log = (...args) => { capture.push(args.join(' ')); vrai(...args); };

  await accorder({ mode: 'NONE' });
  await tenterFederation(SB_AUTO, RETOUR_SB);
  await accorder({ mode: 'ALL_PAIRED' });
  const accorde = await tenterFederation(SB_AUTO, RETOUR_SB);

  console.log = vrai;

  const lignes = capture.filter((l) => l.includes('[federation]'));
  const refus = lignes.map((l) => l.slice(l.indexOf('{'))).map((s) => {
    try { return JSON.parse(s); } catch { return null; }
  }).filter(Boolean);

  const denie = refus.find((o) => o.event === 'FEDERATION_PROJECT_ACCESS_DENIED');
  check('le refus est journalisé sous son nom', Boolean(denie));
  check('…avec l’acteur, le projet, le mode et l’appairage',
    denie?.actorUserId === DEV.userId
    && denie?.projectId === SB_AUTO
    && denie?.projectAccessMode === 'NONE'
    && denie?.projectPaired === true);

  const octroi = refus.find((o) => o.event === 'FEDERATION_PROJECT_ACCESS_GRANTED');
  check('l’accord est journalisé sous son nom', Boolean(octroi));
  check('…avec l’acteur, le projet et le mode',
    octroi?.actorUserId === DEV.userId
    && octroi?.projectId === SB_AUTO
    && octroi?.projectAccessMode === 'ALL_PAIRED');

  const brut = lignes.join('\n');
  check('aucune assertion, aucun jeton, aucun secret au journal',
    !brut.includes(accorde.json?.data?.assertion ?? '§')
    && !brut.includes(SESSION_PANEL)
    && !/PRIVATE KEY|password|Developpeur-2026/i.test(brut));
}

await close();
await stopMemoryMongo();

/* ══════════════════════════════════════════════════════════════════════════
   8. L'ÉCRAN — EXÉCUTÉ, PAS RELU.
   ══════════════════════════════════════════════════════════════════════════ */
const { useFederationAuthorize } = await import('@/lib/useFederationAuthorize');

/**
 * UN BANC D'ESSAI MINIMAL — l'émetteur est observé, jamais simulé à moitié.
 *
 * `issue` compte ses appels et rend ce que la recette décide À CET INSTANT :
 * c'est ainsi qu'on éprouve un changement d'avis du serveur entre deux
 * tentatives, ce qu'aucune valeur figée ne permettrait.
 */
function banc({ verdicts }) {
  const appels = [];
  const redirections = [];
  let restaurer = null;

  const deps = {
    issue: async (projectId, input) => {
      appels.push({ projectId, ...input });
      const verdict = verdicts[Math.min(appels.length - 1, verdicts.length - 1)];
      if (verdict instanceof Error) throw verdict;
      return verdict;
    },
    redirect: (url) => redirections.push(url),
    describeError: (err) => (err instanceof Error ? err.message : 'échec'),
    onRestore: (listener) => { restaurer = listener; return () => { restaurer = null; }; },
  };

  return { deps, appels, redirections, restore: () => restaurer?.() };
}

const REFUS = new Error('Ce compte n’a pas d’accès déclaré à ce projet.');
const ACCORD = { assertion: 'jeton.signé.par.le.panel', returnUrl: 'https://demo-sb-auto.test/retour' };

section('8 · La page d’autorisation ne conserve jamais un verdict');
{
  /* ── 8.1 UNE TENTATIVE = UNE SEULE DEMANDE ────────────────────────────── */
  /** Le serveur refuse la première tentative, puis l'accès est accordé. */
  const b = banc({ verdicts: [REFUS, ACCORD] });
  const params = { projectId: 'p', state: 's1', returnUrl: 'https://demo-sb-auto.test/retour' };
  const vue = mount(() => useFederationAuthorize(params, b.deps));
  await vue.flush();

  check('le refus du serveur est affiché', vue.result.error === REFUS.message);
  check('…et l’état le nomme', vue.result.status === 'DENIED');

  vue.rerender();
  vue.rerender();
  await vue.flush();
  check('des rendus supplémentaires n’émettent PAS de seconde demande',
    b.appels.length === 1);

  /* ── 8.2 UN NOUVEAU `state` = UNE NOUVELLE ÉVALUATION ─────────────────── */
  /**
   * C'EST L'INCIDENT, RÉDUIT À SON MÉCANISME.
   *
   * Le verrou d'unicité d'origine ne se relevait jamais : la seconde tentative
   * — nouveau `state`, accès désormais accordé — se heurtait à lui et
   * réaffichait le refus d'avant SANS demander quoi que ce soit au serveur.
   */
  params.state = 's2';
  vue.rerender();
  await vue.flush();

  check('une nouvelle tentative REPOSE la question au serveur', b.appels.length === 2);
  check('…et l’ancien refus a disparu de l’écran', vue.result.error === null);
  check('…et le serveur ayant changé d’avis, on part', b.redirections.length === 1);
  check('…vers l’adresse recomposée par le serveur, assertion dans le fragment',
    b.redirections[0].startsWith('https://demo-sb-auto.test/retour#')
    && b.redirections[0].includes('assertion=jeton.sign')
    && b.redirections[0].includes('state=s2'));
  vue.unmount();

  /* ── 8.3 LE RETOUR DEPUIS LE CACHE DE NAVIGATION ──────────────────────── */
  /**
   * Le navigateur peut rendre le document tel qu'il l'avait mis de côté : état
   * React intact, aucun effet rejoué. Un écran d'autorisation qui s'en
   * accommoderait afficherait un verdict rendu avant l'octroi.
   */
  const c = banc({ verdicts: [REFUS, ACCORD] });
  const p2 = { projectId: 'p', state: 's3', returnUrl: 'https://demo-sb-auto.test/retour' };
  const vue2 = mount(() => useFederationAuthorize(p2, c.deps));
  await vue2.flush();
  check('premier passage : refusé', vue2.result.error === REFUS.message);

  c.restore();
  await vue2.flush();
  check('restauration : la question est REPOSÉE', c.appels.length === 2);
  check('…et l’accès entre-temps accordé fait partir', c.redirections.length === 1);
  check('…sans que le refus d’avant ait été réaffiché', vue2.result.error === null);
  vue2.unmount();

  /* ── 8.4 RÉESSAYER, SANS RECHARGER NI RELANCER DEPUIS LE PROJET ───────── */
  const d = banc({ verdicts: [REFUS, ACCORD] });
  const p3 = { projectId: 'p', state: 's4', returnUrl: 'https://demo-sb-auto.test/retour' };
  const vue3 = mount(() => useFederationAuthorize(p3, d.deps));
  await vue3.flush();
  check('refusé une première fois', vue3.result.status === 'DENIED');

  vue3.result.retry();
  await vue3.flush();
  check('« Réessayer » interroge le serveur, il ne rejoue pas le verdict',
    d.appels.length === 2 && d.redirections.length === 1);
  vue3.unmount();

  /* ── 8.5 UNE RÉPONSE PÉRIMÉE NE PEINT JAMAIS L'ÉCRAN ──────────────────── */
  /**
   * Relancer pendant qu'une demande est en vol crée deux réponses pour un seul
   * écran. Si la plus ANCIENNE — un refus — arrivait en dernier, elle
   * recouvrirait l'accord. Le jeton de tentative l'en empêche.
   */
  let libererPremier;
  const appelsTardifs = [];
  const depsTardives = {
    issue: async (projectId, input) => {
      appelsTardifs.push(input.state);
      if (appelsTardifs.length === 1) {
        await new Promise((r) => { libererPremier = r; });
        throw REFUS;
      }
      return ACCORD;
    },
    redirect: () => {},
    describeError: (err) => (err instanceof Error ? err.message : 'échec'),
  };
  const p4 = { projectId: 'p', state: 's5', returnUrl: 'https://demo-sb-auto.test/retour' };
  const vue4 = mount(() => useFederationAuthorize(p4, depsTardives));
  await vue4.flush(2);

  p4.state = 's6';
  vue4.rerender();
  await vue4.flush();

  libererPremier();
  await vue4.flush();

  check('la réponse d’une tentative périmée est JETÉE', vue4.result.error === null);
  check('…et c’est bien la tentative récente qui a été servie',
    appelsTardifs.length === 2 && appelsTardifs[1] === 's6');
  vue4.unmount();

  /* ── 8.6 UN LIEN INCOMPLET RESTE UN LIEN INCOMPLET ────────────────────── */
  const e = banc({ verdicts: [ACCORD] });
  const p5 = { projectId: 'p', state: null, returnUrl: 'https://demo-sb-auto.test/retour' };
  const vue5 = mount(() => useFederationAuthorize(p5, e.deps));
  await vue5.flush();
  check('sans `state`, rien n’est demandé au serveur', e.appels.length === 0);
  check('…et l’écran le dit', vue5.result.status === 'INCOMPLETE');

  p5.state = 's7';
  vue5.rerender();
  await vue5.flush();
  check('le lien complété est aussitôt évalué',
    e.appels.length === 1 && vue5.result.error === null);
  vue5.unmount();
}

finish();
