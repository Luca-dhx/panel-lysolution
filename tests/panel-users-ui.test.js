/**
 * L'ÉCRAN DES COMPTES L.Y SOLUTION — L12.B-F.
 *
 * ══ CE QUE CETTE SUITE GARDE ════════════════════════════════════════════════
 *
 * Un écran qui accorde un droit CHEZ UN CLIENT. Trois propriétés le rendent
 * sûr, et aucune n'est évidente à la relecture :
 *
 *   · le SERVEUR décide — l'écran n'est jamais l'autorité, et ses refus sont
 *     éprouvés ici par de vraies requêtes HTTP ;
 *   · `enabled` et `projectAccess` restent DEUX réglages distincts — les
 *     fondre ferait croire qu'activer un compte l'autorise quelque part ;
 *   · on ne s'accorde rien à soi-même, et l'écran le dit au lieu de le
 *     découvrir au clic.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  check, connectTestDatabase, finish, section, setTestEnv,
  startMemoryMongo, startServer, stopMemoryMongo,
} from './helpers/harness.js';

setTestEnv();
await startMemoryMongo();
await connectTestDatabase();

const racine = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const lire = (relatif) => fs.readFileSync(path.join(racine, relatif), 'utf8');

const page = lire('frontend/src/pages/PanelUsersPage.tsx');
const app = lire('frontend/src/App.tsx');
const nav = lire('frontend/src/config/nav.ts');
const api = lire('frontend/src/lib/api.ts');
const styles = lire('frontend/src/styles.css');

const { createApp } = await import('../backend/src/app.js');
const users = await import('../backend/src/services/auth/panelUsers.service.js');
const registre = await import('../backend/src/services/registry/projectRegistry.service.js');
const { default: PanelProject } = await import('../backend/src/models/PanelProject.model.js');

await users.resetUsers();
await users.seedFromEnv();

const { call, close } = await startServer(createApp());

/**
 * L'OPÉRATEUR EST SOUVERAIN — l'écriture a quitté les comptes DEV (LOT
 * SUPER_ADMIN). Voir `panelUsers.routes.js` pour la doctrine.
 */
const OPS = await users.createUser({
  email: 'ops@panel.test', password: 'Operateur-2026', displayName: 'Opérateur', role: 'SUPER_ADMIN',
});
const CIBLE = await users.createUser({
  email: 'cible@panel.test', password: 'Cible-2026', displayName: 'Développeuse', role: 'DEV',
});
const GESTION = await users.createUser({
  email: 'gestion@panel.test', password: 'Gestion-2026', displayName: 'Gestion', role: 'ADMIN',
});

async function jeton(email, password) {
  const r = await call('POST', '/api/auth/login', { body: { email, password } });
  return { authorization: `Bearer ${r.json?.data?.token}` };
}
const AUTH = await jeton('ops@panel.test', 'Operateur-2026');

const appaire = await registre.declareProject({
  publicBackendUrl: 'https://garage-ui.test', projectName: 'Garage UI',
});
await PanelProject.updateOne(
  { projectId: appaire.record.projectId },
  { $set: { 'pairing.status': 'PAIRED' } },
);
const declare = await registre.declareProject({
  publicBackendUrl: 'https://jamais.test', projectName: 'Jamais appairé',
});

/* ══════════════════════════════════════════════════════════════════════════
   1. L'ÉCRAN EXISTE ET EST RÉSERVÉ AUX DEV.
   ══════════════════════════════════════════════════════════════════════════ */
section('1 · Une surface d’administration, réservée aux comptes DEV');
{
  check('la route est déclarée sous la garde DEV',
    app.includes('<Route path="/panel-users" element={dev(<PanelUsersPage />)} />'));
  check('…et l’écran figure dans la navigation DEV',
    nav.includes("to: '/panel-users'") && nav.includes('devOnly: true'));

  check('le client expose la lecture et l’administration complète',
    api.includes('listPanelUsers') && api.includes('listAccessibleProjects')
    && api.includes('createPanelUser') && api.includes('updatePanelUser')
    && api.includes('deletePanelUser') && api.includes('sendPanelUserInvitation'));
  check('…et plus aucune route par champ',
    !api.includes('/project-access') && !api.includes('}/enabled'));

  const anonyme = await call('GET', '/api/panel-users');
  check('la liste est refusée sans session', anonyme.status === 401);

  const parAdmin = await call('GET', '/api/panel-users', {
    headers: await jeton('gestion@panel.test', 'Gestion-2026'),
  });
  check('…et refusée à un ADMIN', parAdmin.status === 403);

  const parDev = await call('GET', '/api/panel-users', {
    headers: await jeton('cible@panel.test', 'Cible-2026'),
  });
  check('un DEV la lit', parDev.status === 200);
}

/* ══════════════════════════════════════════════════════════════════════════
   2. NONE PAR DÉFAUT — le rôle ne suffit pas.
   ══════════════════════════════════════════════════════════════════════════ */
section('2 · Un compte neuf n’a aucun accès projet');
{
  const liste = (await call('GET', '/api/panel-users', { headers: AUTH })).json.data;
  check('tous les comptes partent de NONE',
    liste.every((u) => u.projectAccess.mode === 'NONE'));
  check('…y compris les DEV', liste.filter((u) => u.role === 'DEV').length >= 2);
  check('…et ils sont pourtant tous actifs', liste.every((u) => u.enabled === true));

  check('l’écran écrit la sémantique de chaque mode',
    page.includes('MODE_HINT') && page.includes('C’est le réglage par défaut'));
  check('…et dit qu’ALL_PAIRED est DYNAMIQUE',
    page.includes('Ce n’est pas une liste figée'));
}

/* ══════════════════════════════════════════════════════════════════════════
   3. LE SERVEUR DÉCIDE — l'écran n'est jamais l'autorité.
   ══════════════════════════════════════════════════════════════════════════ */
section('3 · Chaque entrée est vérifiée côté serveur');
{
  const put = (body, userId = CIBLE.userId) =>
    call('PATCH', `/api/panel-users/${userId}`, { headers: AUTH, body: { projectAccess: body } });

  check('un mode inconnu est refusé', (await put({ mode: 'TOUT' })).status === 400);
  check('un champ inconnu est refusé', (await put({ mode: 'NONE', extra: 1 })).status === 400);
  check('…et un champ inconnu au premier niveau aussi',
    (await call('PATCH', `/api/panel-users/${CIBLE.userId}`, {
      headers: AUTH, body: { passwordHash: 'x' },
    })).status === 400);
  check('un projet inconnu est refusé',
    (await put({ mode: 'EXPLICIT', projectIds: ['inconnu'] })).json?.code
      === 'PANEL_USER_ACCESS_PROJECT_UNKNOWN');
  check('EXPLICIT sans projet est refusé',
    (await put({ mode: 'EXPLICIT', projectIds: [] })).json?.code === 'PANEL_USER_ACCESS_EMPTY');
  check('un projet NON APPAIRÉ est refusé',
    (await put({ mode: 'EXPLICIT', projectIds: [declare.record.projectId] })).json?.code
      === 'PANEL_USER_ACCESS_PROJECT_NOT_PAIRED');
  check('un compte inconnu est refusé',
    (await put({ mode: 'NONE' }, 'aucun-compte')).status === 404);

  const ok = await put({ mode: 'EXPLICIT', projectIds: [appaire.record.projectId] });
  check('un projet appairé est ACCEPTÉ', ok.status === 200);
  check('…et le mode est enregistré', ok.json.data.projectAccess.mode === 'EXPLICIT');

  /**
   * LA LISTE EST ÉCARTÉE HORS D'EXPLICIT. La garder en `ALL_PAIRED` ferait
   * croire à une restriction qui n'existe pas.
   */
  const tous = await put({ mode: 'ALL_PAIRED', projectIds: [appaire.record.projectId] });
  check('ALL_PAIRED n’emporte aucune liste', tous.json.data.projectAccess.projectIds.length === 0);
}

/* ══════════════════════════════════════════════════════════════════════════
   4. LA TRACE — qui a accordé, quand.
   ══════════════════════════════════════════════════════════════════════════ */
section('4 · Un accès accordé est daté et attribué');
{
  const liste = (await call('GET', '/api/panel-users', { headers: AUTH })).json.data;
  const cible = liste.find((u) => u.userId === CIBLE.userId);
  check('l’accord porte sa date', typeof cible.grantedAt === 'string');
  check('…et son auteur', cible.grantedBy === OPS.userId);
  check('l’écran affiche cette trace', page.includes('Accordé le') && page.includes('grantedBy'));

  check('aucun secret ne descend à l’écran',
    !JSON.stringify(liste).match(/passwordHash|tokenVersion|resetToken/));
}

/* ══════════════════════════════════════════════════════════════════════════
   5. ON NE S'ACCORDE RIEN À SOI-MÊME.
   ══════════════════════════════════════════════════════════════════════════ */
section('5 · Le bénéficiaire peut être l’auteur — s’il est souverain');
{
  /**
   * ══ CE QUE CETTE SECTION GARDAIT, ET CE QU'ELLE GARDE MAINTENANT ══════════
   *
   * Elle gardait `PANEL_USER_SELF_GRANT` : un DEV ne s'ouvrait pas un client
   * à lui-même, il le demandait à un collègue. C'était le meilleur arbitrage
   * possible tant qu'aucun rôle souverain n'existait — le pouvoir d'accorder
   * était réparti entre pairs, et la garde empêchait qu'il devienne un
   * self-service.
   *
   * Le lot SUPER_ADMIN nomme ce pouvoir. Il n'est plus réparti : un souverain
   * n'a personne à qui demander, et lui interdire de s'accorder un accès
   * n'ajouterait aucune sécurité — il lui suffirait de promouvoir un complice.
   * Ce que la section garde désormais, c'est que PERSONNE D'AUTRE ne peut.
   */
  const soi = await call('PATCH', `/api/panel-users/${OPS.userId}`, {
    headers: AUTH, body: { projectAccess: { mode: 'ALL_PAIRED' } },
  });
  check('un SUPER_ADMIN s’accorde ses propres accès', soi.status === 200);
  check('…et la trace le désigne LUI comme auteur',
    (await call('GET', '/api/panel-users', { headers: AUTH })).json.data
      .find((u) => u.userId === OPS.userId).grantedBy === OPS.userId);

  const DEV_H = await jeton('cible@panel.test', 'Cible-2026');
  check('un DEV ne s’accorde RIEN',
    (await call('PATCH', `/api/panel-users/${CIBLE.userId}`, {
      headers: DEV_H, body: { projectAccess: { mode: 'ALL_PAIRED' } },
    })).json?.code === 'PANEL_SUPER_ADMIN_REQUIRED');
  check('…ni ne se promeut',
    (await call('PATCH', `/api/panel-users/${CIBLE.userId}`, {
      headers: DEV_H, body: { role: 'SUPER_ADMIN' },
    })).status === 403);

  /** L'écran ne propose l'administration qu'au souverain. */
  check('l’écran conditionne TOUTES les actions à la souveraineté',
    page.includes('const souverain = administersPanelUsers(moi?.role)')
    && page.includes('souverain ? ('));
  check('…et dit à un DEV qu’il est en lecture seule', page.includes('Lecture seule'));

  /** On remet le souverain à NONE : il n'a pas à fédérer dans cette suite. */
  await call('PATCH', `/api/panel-users/${OPS.userId}`, {
    headers: AUTH, body: { projectAccess: { mode: 'NONE' } },
  });
}

/* ══════════════════════════════════════════════════════════════════════════
   6. DEUX RÉGLAGES DISTINCTS.
   ══════════════════════════════════════════════════════════════════════════ */
section('6 · « Compte actif » et « accès aux projets » ne se confondent pas');
{
  /**
   * DÉSACTIVER FAIT DEUX GESTES — `enabled: false` ET incrément de version.
   * Sans le second, le compte ne pourrait plus se reconnecter mais ses
   * sessions vivraient.
   */
  const off = await call('PATCH', `/api/panel-users/${CIBLE.userId}`, {
    headers: AUTH, body: { enabled: false },
  });
  check('un compte se désactive', off.status === 200 && off.json.data.enabled === false);

  const relu = (await call('GET', '/api/panel-users', { headers: AUTH })).json.data
    .find((u) => u.userId === CIBLE.userId);
  check('…sans perdre son accès projet — les deux sont distincts',
    relu.projectAccess.mode === 'ALL_PAIRED' && relu.enabled === false);

  await call('PATCH', `/api/panel-users/${CIBLE.userId}`, {
    headers: AUTH, body: { enabled: true },
  });

  check('l’écran sépare visuellement les deux réglages',
    page.includes('Compte actif') && page.includes('Accès aux projets')
    && styles.includes('.panel-user-access'));
}

/* ══════════════════════════════════════════════════════════════════════════
   7. CE QUE L'ÉCRAN PROPOSE, ET CE QU'IL REFUSE DE PROPOSER.
   ══════════════════════════════════════════════════════════════════════════ */
section('7 · Seuls les projets réellement accordables sont cochables');
{
  const projets = (await call('GET', '/api/panel-users/projects', { headers: AUTH })).json.data;
  const appaireVu = projets.find((p) => p.projectId === appaire.record.projectId);
  const declareVu = projets.find((p) => p.projectId === declare.record.projectId);

  check('un projet appairé est sélectionnable', appaireVu.selectable === true);
  check('un projet non appairé ne l’est PAS', declareVu.selectable === false);
  check('…mais il reste VISIBLE', Boolean(declareVu));

  check('l’écran ne coche que les sélectionnables',
    page.includes('projets.filter((p) => p.selectable)'));
  check('…et montre les autres, sans case',
    page.includes('panel-user-project-off') && page.includes('aucun accès possible'));

  /**
   * UN ACCÈS POSÉ SUR UN RÔLE QUI NE FÉDÈRE PAS N'OUVRE RIEN.
   *
   * L'écran ne MASQUE plus le réglage — un souverain doit pouvoir le lire et le
   * corriger sur n'importe quel compte — mais il DIT qu'il restera sans effet.
   * Masquer aurait fait croire que le champ n'existe pas ; se taire aurait fait
   * croire à une panne le jour où quelqu'un le constate.
   */
  check('l’écran annonce un accès sans effet plutôt que de le masquer',
    page.includes('n’ouvre aucun projet') && page.includes('isPanelDeveloper(user.role)'));
}

/* ══════════════════════════════════════════════════════════════════════════
   8. SON PROPRE PROFIL — un droit personnel, jamais un privilège (L12.C).
   ══════════════════════════════════════════════════════════════════════════ */
section('8 · Un compte peut corriger son nom, et rien d’autre');
{
  const editeur = lire('frontend/src/components/PanelUserProfileEditor.tsx');
  const layout = lire('frontend/src/components/Layout.tsx');
  const page = lire('frontend/src/pages/PanelUsersPage.tsx');
  const profil = lire('frontend/src/pages/MyProfilePage.tsx');

  /* ── LA LECTURE ────────────────────────────────────────────────────────── */
  const moi = await call('GET', '/api/panel-users/me', { headers: AUTH });
  check('un DEV lit son propre profil', moi.status === 200);
  check('…et c’est bien le sien', moi.json.data.userId === OPS.userId);
  check('…sans aucun secret',
    !JSON.stringify(moi.json.data).match(/passwordHash|tokenVersion|resetToken/));

  /**
   * OUVERTE AUX ADMIN AUSSI. Corriger son nom n'est pas une opération
   * technique : la placer sous la garde DEV interdirait à un ADMIN de le
   * faire, et ferait dépendre un droit PERSONNEL d'un privilège
   * d'ADMINISTRATION.
   */
  const parAdmin = await call('GET', '/api/panel-users/me', {
    headers: await jeton('gestion@panel.test', 'Gestion-2026'),
  });
  check('un ADMIN lit AUSSI son profil', parAdmin.status === 200);
  check('…alors que l’administration lui reste fermée',
    (await call('GET', '/api/panel-users', {
      headers: await jeton('gestion@panel.test', 'Gestion-2026'),
    })).status === 403);

  const anonyme = await call('GET', '/api/panel-users/me');
  check('…mais rien sans session', anonyme.status === 401);

  /* ── L'ÉCRITURE AUTORISÉE ──────────────────────────────────────────────── */
  const renomme = await call('PATCH', '/api/panel-users/me', {
    headers: AUTH, body: { displayName: 'Opérateur renommé' },
  });
  check('un DEV modifie son nom affiché', renomme.status === 200);
  check('…et le changement est persisté',
    (await call('GET', '/api/panel-users/me', { headers: AUTH })).json.data.displayName
      === 'Opérateur renommé');

  check('un nom vide est refusé',
    (await call('PATCH', '/api/panel-users/me', { headers: AUTH, body: { displayName: ' ' } })).status === 400);

  /* ── LES ÉCRITURES INTERDITES — le cœur du lot ─────────────────────────── */
  for (const [nom, corps] of [
    ['role', { role: 'ADMIN' }],
    ['enabled', { enabled: false }],
    ['projectAccess', { projectAccess: { mode: 'ALL_PAIRED' } }],
    ['projectIds', { projectIds: [appaire.record.projectId] }],
    ['tokenVersion', { tokenVersion: 0 }],
    ['email', { email: 'autre@panel.test' }],
    ['userId', { userId: 'quelqu-un-dautre' }],
  ]) {
    const refus = await call('PATCH', '/api/panel-users/me', {
      headers: AUTH, body: { displayName: 'Tentative', ...corps },
    });
    check(`« ${nom} » est REFUSÉ depuis son profil`,
      refus.status === 400 && refus.json?.code === 'PANEL_USER_SELF_FORBIDDEN_FIELD');
  }

  const apres = await call('GET', '/api/panel-users/me', { headers: AUTH });
  check('…et AUCUNE de ces tentatives n’a rien changé',
    apres.json.data.role === 'SUPER_ADMIN' && apres.json.data.enabled === true
    && apres.json.data.displayName === 'Opérateur renommé');

  /**
   * ══ L'INVARIANT MAJEUR TIENT TOUJOURS ═════════════════════════════════════
   *
   * Le nouveau droit personnel ne doit JAMAIS se lire « administrer son
   * PanelUser ». Pouvoir changer son nom et pouvoir s'ouvrir un client sont
   * deux choses sans rapport, et la seconde reste fermée.
   */
  const DEV_H2 = await jeton('cible@panel.test', 'Cible-2026');
  const autoGrant = await call('PATCH', `/api/panel-users/${CIBLE.userId}`, {
    headers: DEV_H2, body: { projectAccess: { mode: 'ALL_PAIRED' } },
  });
  check('un DEV ne s’accorde rien, malgré le droit personnel',
    autoGrant.status === 403 && autoGrant.json?.code === 'PANEL_SUPER_ADMIN_REQUIRED');
  const autoOff2 = await call('PATCH', `/api/panel-users/${CIBLE.userId}`, {
    headers: DEV_H2, body: { enabled: false },
  });
  check('…ni ne se désactive', autoOff2.status === 403);

  /* ── UNE SEULE IMPLÉMENTATION ──────────────────────────────────────────── */
  check('l’éditeur de profil est un composant PARTAGÉ',
    profil.includes('PanelUserProfileEditor') && editeur.includes('export function PanelUserProfileEditor'));
  check('…et l’écran des comptes n’en réimplémente PAS un second',
    !page.includes('displayName') || !page.includes('updateOwnProfile'));
  check('sur sa propre ligne, un non-souverain va à la MÊME surface profil',
    page.includes('to="/mon-profil"') && page.includes('Modifier mon profil'));
  check('…et un souverain édite sa propre ligne comme les autres',
    !page.includes('disabled={estMoi}') && page.includes('— vous'));

  /* ── LA BARRE LATÉRALE ─────────────────────────────────────────────────── */
  check('la barre latérale porte « Mon profil »',
    layout.includes('Mon profil') && layout.includes('to="/mon-profil"'));
  check('…JUSTE AU-DESSUS de la déconnexion',
    layout.indexOf('to="/mon-profil"') < layout.indexOf('Déconnexion')
    && layout.indexOf('Déconnexion') - layout.indexOf('to="/mon-profil"') < 400);

  /* ── LES PRIVILÈGES SONT MONTRÉS, JAMAIS ÉDITABLES ─────────────────────── */
  check('l’éditeur affiche les privilèges en LECTURE',
    editeur.includes('Privilèges') && editeur.includes('par un compte'));
  check('…sans aucun contrôle modifiable dessus',
    !editeur.includes('setPanelUserProjectAccess') && !editeur.includes('type="radio"')
    && !editeur.includes('type="checkbox"'));
  check('l’adresse e-mail est en lecture seule',
    editeur.includes('readOnly') && editeur.includes('sert à se connecter'));
  check('le mot de passe passe par le parcours de réinitialisation existant',
    editeur.includes('api.forgotPassword') && !editeur.includes('currentPassword'));

  /* ── OBSERVABILITÉ ─────────────────────────────────────────────────────── */
  const { PanelEvent } = await import('../backend/src/models/PanelSupervision.model.js');
  const evenements = await PanelEvent.find({ type: 'PANEL_USER_PROFILE_UPDATED' }).lean();
  check('la modification personnelle est journalisée', evenements.length >= 1);
  check('…avec le même compte comme acteur ET cible',
    evenements.every((e) => e.data?.actorUserId === e.data?.targetUserId));
  check('…et sans aucun secret',
    !JSON.stringify(evenements).match(/password|hash|token|Operateur-2026/i));
}

await close();
await stopMemoryMongo();
finish();
