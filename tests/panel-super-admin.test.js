/**
 * LE RÔLE SOUVERAIN DU PANEL — LOT SUPER_ADMIN.
 *
 * ══ CE QUE CETTE SUITE GARDE ════════════════════════════════════════════════
 *
 * Un troisième rôle ne s'ajoute pas à une énumération : il change la nature de
 * chaque comparaison de rôle déjà écrite. Avec deux valeurs, `role === 'DEV'`
 * EST une hiérarchie ; avec trois, la même ligne enferme dehors le rôle le plus
 * élevé — sans erreur, sans message, sans rien à voir dans un journal.
 *
 * Quatre familles de contrôles, et aucune n'est redondante :
 *
 *   · L'ÉCHELLE      `SUPER_ADMIN ≥ DEV` sur les surfaces techniques, et
 *                    `ADMIN` toujours dehors ;
 *   · LA SOUVERAINETÉ création, rôle, activation, accès, suppression — sur
 *                    n'importe quelle cible, y compris un autre souverain et
 *                    soi-même. Aucune garde de cible, c'est une décision ;
 *   · LA PROJECTION  ce que le Panel dit aux projets — jamais `SUPER_ADMIN` ;
 *   · LES SECRETS    aucun mot de passe n'entre ni ne sort de cette surface.
 */
import { createRequire } from 'node:module';

import {
  check, connectTestDatabase, finish, section, setTestEnv, simulateRestart,
  startMemoryMongo, startServer, stopMemoryMongo,
} from './helpers/harness.js';

/**
 * `jsonwebtoken` est une dépendance DU BACKEND, et `tests/` vit à côté, pas
 * dedans : on la résout depuis son `package.json` plutôt que d'en ajouter une
 * copie au dépôt de tests.
 */
const jwt = createRequire(new URL('../backend/package.json', import.meta.url))('jsonwebtoken');

setTestEnv();
await startMemoryMongo();
await connectTestDatabase();

const { createApp } = await import('../backend/src/app.js');
const users = await import('../backend/src/services/auth/panelUsers.service.js');
const roles = await import('../backend/src/services/auth/panelRoles.js');
const registre = await import('../backend/src/services/registry/projectRegistry.service.js');
const { default: PanelProject } = await import('../backend/src/models/PanelProject.model.js');
const { default: PanelUser } = await import('../backend/src/models/PanelUser.model.js');
const { PanelEvent, EVENT_TYPES } = await import('../backend/src/models/PanelSupervision.model.js');
const reset = await import('../backend/src/services/auth/panelPasswordReset.service.js');

await users.resetUsers();

/**
 * L'E-MAIL D'ACTIVATION EST INTERCEPTÉ, PAS DÉSACTIVÉ.
 *
 * On veut prouver qu'un lien PART, qu'il porte un jeton à usage unique, et que
 * ce jeton suffit à prendre possession du compte. Court-circuiter l'envoi
 * prouverait seulement que la fonction a été appelée.
 */
const courrier = [];
reset.__setPasswordResetTestDeps({
  resolveFrontendUrlImpl: async () => ({ url: 'https://panel.test' }),
  invokeCapabilityImpl: async ({ payload }) => {
    courrier.push({
      to: payload.recipient.email,
      resetUrl: payload.variables['auth.resetUrl'],
    });
    return { result: { providerMessageId: `msg-${courrier.length}` } };
  },
});

const { call, close } = await startServer(createApp());

async function jetonDe(email, password) {
  const r = await call('POST', '/api/auth/login', { body: { email, password } });
  return r.json?.data?.token ?? null;
}
const bearer = (jeton) => ({ authorization: `Bearer ${jeton}` });

/* ── LE PARC ─────────────────────────────────────────────────────────────── */
const demo = await registre.declareProject({
  publicBackendUrl: 'https://demo-sb-auto.test', projectName: 'Demo SB Auto',
});
const SB_AUTO = demo.record.projectId;
await PanelProject.updateOne({ projectId: SB_AUTO }, { $set: { 'pairing.status': 'PAIRED' } });
const RETOUR = 'https://demo-sb-auto.test/connexion/ly-solution/retour';

/* ── LES COMPTES DE DÉPART ───────────────────────────────────────────────── */
const ROI = await users.createUser({
  email: 'roi@panel.test', password: 'Souverain-2026', displayName: 'Souverain', role: 'SUPER_ADMIN',
});
const DEV = await users.createUser({
  email: 'dev@panel.test', password: 'Developpeur-2026', displayName: 'Développeuse', role: 'DEV',
});
const GESTION = await users.createUser({
  email: 'gestion@panel.test', password: 'Gestion-2026', displayName: 'Gestion', role: 'ADMIN',
});

const ROI_TOKEN = await jetonDe('roi@panel.test', 'Souverain-2026');
const SUPER = bearer(ROI_TOKEN);
const DEV_H = bearer(await jetonDe('dev@panel.test', 'Developpeur-2026'));
const ADMIN_H = bearer(await jetonDe('gestion@panel.test', 'Gestion-2026'));

/* ══════════════════════════════════════════════════════════════════════════
   1. L'ÉNUMÉRATION, ET SA SEULE DÉFINITION.
   ══════════════════════════════════════════════════════════════════════════ */
section('1 · Un troisième rôle, défini une seule fois');
{
  check('l’échelle connaît les trois rôles',
    roles.PANEL_ROLE_VALUES.length === 3
    && roles.PANEL_ROLE_VALUES.includes('SUPER_ADMIN'));

  /**
   * LE SCHÉMA DÉRIVE DE L'ÉCHELLE — il ne la recopie pas.
   *
   * C'est le contrôle qui empêche le défaut classique : le service accepte le
   * nouveau rôle, le schéma le refuse, et l'erreur apparaît à l'écriture, loin
   * de la décision.
   */
  const enumSchema = PanelUser.schema.path('role').enumValues;
  check('…et le schéma Mongoose porte EXACTEMENT la même liste',
    enumSchema.length === roles.PANEL_ROLE_VALUES.length
    && roles.PANEL_ROLE_VALUES.every((r) => enumSchema.includes(r)));

  check('SUPER_ADMIN ≥ DEV pour les capacités développeur',
    roles.isPanelDeveloper('SUPER_ADMIN') && roles.isPanelDeveloper('DEV')
    && !roles.isPanelDeveloper('ADMIN'));
  check('…et seul SUPER_ADMIN administre les comptes',
    roles.administersPanelUsers('SUPER_ADMIN')
    && !roles.administersPanelUsers('DEV')
    && !roles.administersPanelUsers('ADMIN'));
  check('le rôle projeté vers les projets est DEV, et rien d’autre',
    roles.FEDERATED_PROJECT_ROLE === 'DEV');
}

/* ══════════════════════════════════════════════════════════════════════════
   2. LA PROMOTION D'AMORÇAGE — idempotente, et minimale.
   ══════════════════════════════════════════════════════════════════════════ */
section('2 · luca.duhoux@gmail.com est promu, sans rien d’autre');
{
  check('l’adresse d’amorçage est nommée en clair',
    users.SOVEREIGN_BOOTSTRAP_EMAIL === 'luca.duhoux@gmail.com');

  /** BASE VIERGE : on ne fabrique pas un compte souverain de toutes pièces. */
  const surRien = await users.promotePanelSuperAdmin();
  check('sur une base sans ce compte, la promotion ne CRÉE rien',
    surRien.found === false && surRien.promoted === false);
  check('…et aucun compte n’est apparu',
    (await PanelUser.countDocuments({ email: users.SOVEREIGN_BOOTSTRAP_EMAIL })) === 0);

  /** LE CAS RÉEL : le compte existe déjà, en DEV, avec des accès et un mdp. */
  const luca = await users.createUser({
    email: 'Luca.Duhoux@Gmail.com', password: 'MotDePasseDeLuca-2026',
    displayName: 'Luca Duhoux', role: 'DEV',
  });
  await users.setProjectAccess(luca.userId, { mode: 'EXPLICIT', projectIds: [SB_AUTO] });
  const avant = await PanelUser.findOne({ userId: luca.userId }).lean();

  const promotion = await users.promotePanelSuperAdmin();
  check('le compte existant est PROMU',
    promotion.found === true && promotion.promoted === true);

  const apres = await PanelUser.findOne({ userId: luca.userId }).lean();
  check('base : le rôle est SUPER_ADMIN', apres.role === 'SUPER_ADMIN');
  check('…l’adresse a été normalisée à la création', apres.email === 'luca.duhoux@gmail.com');

  /**
   * CE QUE LA PROMOTION N'A PAS TOUCHÉ — et chaque absence est un contrôle.
   *
   * Un backfill qui « remettrait les choses en ordre » prendrait des décisions
   * que personne n'a prises. Et un `tokenVersion` incrémenté déconnecterait
   * quelqu'un pour lui avoir donné plus.
   */
  check('le mot de passe est INCHANGÉ', apres.passwordHash === avant.passwordHash);
  check('les accès projets sont INCHANGÉS',
    JSON.stringify(apres.projectAccess) === JSON.stringify(avant.projectAccess));
  check('l’activation est INCHANGÉE', apres.enabled === avant.enabled);
  check('tokenVersion n’a PAS bougé', apres.tokenVersion === avant.tokenVersion);

  /** IDEMPOTENCE — rejouée deux fois, la promotion ne fait plus rien. */
  const rejeu = await users.promotePanelSuperAdmin();
  check('rejouée, la promotion est un no-op explicite',
    rejeu.alreadySuperAdmin === true && rejeu.promoted === false);

  const complet = await users.bootstrapPanelAccounts();
  check('l’amorçage complet est lui aussi idempotent',
    complet.sovereign.alreadySuperAdmin === true);

  /**
   * LA PROMOTION SURVIT À UN REDÉMARRAGE — c'est une écriture en base, pas un
   * état de processus. On coupe la connexion applicative et on la rétablit sur
   * la MÊME base : ce qui survit est ce qui est réellement persisté.
   */
  await simulateRestart();
  const apresRedemarrage = await PanelUser.findOne({ email: 'luca.duhoux@gmail.com' }).lean();
  check('le rôle souverain est PERSISTÉ, pas en mémoire',
    apresRedemarrage.role === 'SUPER_ADMIN');

  /** LA SESSION DE LUCA GAGNE LE RÔLE SANS RECONNEXION. */
  const sessionLuca = await jetonDe('luca.duhoux@gmail.com', 'MotDePasseDeLuca-2026');
  const moi = await call('GET', '/api/panel-users/me', { headers: bearer(sessionLuca) });
  check('sa session lit le rôle souverain', moi.json?.data?.role === 'SUPER_ADMIN');

  /** On le retire du jeu : la suite éprouve des comptes dédiés. */
  await PanelUser.deleteOne({ userId: luca.userId });
}

/* ══════════════════════════════════════════════════════════════════════════
   3. L'ÉCHELLE SUR LES SURFACES TECHNIQUES.
   ══════════════════════════════════════════════════════════════════════════ */
section('3 · Un SUPER_ADMIN franchit toutes les portes d’un DEV');
{
  const portes = ['/api/panel-users', '/api/panel-users/projects', '/api/supervision/dashboard'];
  for (const porte of portes) {
    const parSuper = await call('GET', porte, { headers: SUPER });
    const parDev = await call('GET', porte, { headers: DEV_H });
    const parAdmin = await call('GET', porte, { headers: ADMIN_H });
    check(`${porte} — ouverte au SUPER_ADMIN`, parSuper.status !== 403);
    check(`${porte} — …et au DEV`, parDev.status !== 403);
    check(`${porte} — …et FERMÉE à l’ADMIN`, parAdmin.status === 403);
  }

  /** Son propre profil reste ouvert à TOUS, ADMIN compris. */
  check('un ADMIN lit toujours son propre profil',
    (await call('GET', '/api/panel-users/me', { headers: ADMIN_H })).status === 200);
}

/* ══════════════════════════════════════════════════════════════════════════
   4. LA CRÉATION — sans mot de passe, avec invitation.
   ══════════════════════════════════════════════════════════════════════════ */
section('4 · Créer un compte n’expose aucun mot de passe');
let CREE = { ADMIN: null, DEV: null, SUPER_ADMIN: null };
{
  for (const role of ['ADMIN', 'DEV', 'SUPER_ADMIN']) {
    const r = await call('POST', '/api/panel-users', {
      headers: SUPER,
      body: { email: `${role.toLowerCase()}@nouveau.test`, displayName: `Nouveau ${role}`, role },
    });
    check(`un SUPER_ADMIN crée un compte ${role}`, r.status === 200 && r.json?.data?.role === role);
    CREE[role] = r.json?.data ?? null;
  }

  check('le compte créé n’est PAS encore activé', CREE.DEV?.activated === false);
  check('…et l’invitation est partie', CREE.DEV?.invitation?.sent === true);
  check('la réponse ne contient AUCUN mot de passe',
    !/password|hash|secret/i.test(JSON.stringify(CREE)));

  const enBase = await PanelUser.findOne({ email: 'dev@nouveau.test' }).lean();
  check('base : un mot de passe existe bel et bien', typeof enBase.passwordHash === 'string');
  check('…et il n’a jamais été choisi par personne', enBase.passwordChangedAt === null);

  /**
   * LE COMPTE EST INACCESSIBLE TANT QU'IL N'EST PAS ACTIVÉ.
   *
   * Contrôle par la NÉGATIVE, sur les mots de passe qu'un raccourci aurait pu
   * poser : chaîne vide, adresse, rôle, une valeur de démonstration.
   */
  for (const tentative of ['', 'dev@nouveau.test', 'DEV', 'motdepasse-test', 'Nouveau DEV']) {
    const essai = await call('POST', '/api/auth/login', {
      body: { email: 'dev@nouveau.test', password: tentative },
    });
    if (essai.status === 200) check(`un mot de passe devinable ouvre le compte (« ${tentative} »)`, false);
  }
  check('aucun mot de passe devinable n’ouvre le compte créé', true);

  /* ── LA PRISE DE POSSESSION, POUR DE VRAI ── */
  const invitation = courrier.find((c) => c.to === 'dev@nouveau.test');
  check('un lien d’activation a été adressé au titulaire', Boolean(invitation?.resetUrl));
  const jeton = new URL(invitation.resetUrl).searchParams.get('token');
  const prise = await call('POST', '/api/auth/reset-password', {
    body: { token: jeton, password: 'MonPropreMotDePasse-2026', passwordConfirmation: 'MonPropreMotDePasse-2026' },
  });
  check('le titulaire choisit SON mot de passe par ce lien', prise.status === 200);
  const connexion = await call('POST', '/api/auth/login', {
    body: { email: 'dev@nouveau.test', password: 'MonPropreMotDePasse-2026' },
  });
  check('…et se connecte', connexion.status === 200);
  const relu = await call('GET', '/api/panel-users', { headers: SUPER });
  check('…l’écran le voit désormais activé',
    relu.json.data.find((u) => u.email === 'dev@nouveau.test')?.activated === true);

  /** Le jeton d'activation ne sert qu'une fois — l'anti-rejeu du parcours. */
  const rejeu = await call('POST', '/api/auth/reset-password', {
    body: { token: jeton, password: 'UneAutreTentative-2026' },
  });
  check('le lien d’activation ne resert pas', rejeu.status === 400);

  /* ── DEUX COMPTES NE PARTAGENT PAS UNE ADRESSE ── */
  const doublon = await call('POST', '/api/panel-users', {
    headers: SUPER, body: { email: 'dev@nouveau.test', displayName: 'Doublon', role: 'DEV' },
  });
  check('une adresse déjà prise est REFUSÉE',
    doublon.status === 409 && doublon.json?.code === 'PANEL_USER_EMAIL_TAKEN');

  /* ── LE CORPS EST FERMÉ ── */
  const force = await call('POST', '/api/panel-users', {
    headers: SUPER,
    body: { email: 'force@nouveau.test', displayName: 'Forcé', role: 'DEV', password: 'choisi-par-admin' },
  });
  check('un mot de passe proposé à la création est REFUSÉ',
    force.status === 400 && force.json?.code === 'PANEL_USER_FORBIDDEN_FIELD');
  const roleInconnu = await call('POST', '/api/panel-users', {
    headers: SUPER, body: { email: 'x@nouveau.test', displayName: 'Inconnu', role: 'ROOT' },
  });
  check('un rôle inconnu est REFUSÉ', roleInconnu.status === 400);
}

/* ══════════════════════════════════════════════════════════════════════════
   5. LA MODIFICATION — quatre champs, et rien d'autre.
   ══════════════════════════════════════════════════════════════════════════ */
section('5 · Modifier un compte, y compris un autre souverain');
{
  const patch = (userId, body, headers = SUPER) =>
    call('PATCH', `/api/panel-users/${userId}`, { headers, body });

  check('modifier un ADMIN', (await patch(CREE.ADMIN.userId, { displayName: 'Gestionnaire' })).status === 200);
  check('modifier un DEV', (await patch(CREE.DEV.userId, { displayName: 'Développeur' })).status === 200);
  check('modifier un AUTRE SUPER_ADMIN',
    (await patch(CREE.SUPER_ADMIN.userId, { displayName: 'Second souverain' })).status === 200);
  check('modifier les accès d’un autre SUPER_ADMIN',
    (await patch(CREE.SUPER_ADMIN.userId, { projectAccess: { mode: 'ALL_PAIRED' } })).status === 200);
  check('RÉTROGRADER un autre SUPER_ADMIN',
    (await patch(CREE.SUPER_ADMIN.userId, { role: 'DEV' })).status === 200);
  check('…et le repromouvoir',
    (await patch(CREE.SUPER_ADMIN.userId, { role: 'SUPER_ADMIN' })).status === 200);

  /* ── LES CHAMPS INTERDITS SONT REFUSÉS, PAS IGNORÉS ── */
  for (const champ of [
    { passwordHash: 'x' }, { tokenVersion: 9 }, { userId: 'autre' },
    { createdAt: '2020-01-01' }, { email: 'nouvelle@adresse.test' },
  ]) {
    const r = await patch(CREE.DEV.userId, champ);
    check(`le champ « ${Object.keys(champ)[0]} » est REFUSÉ`,
      r.status === 400 && r.json?.code === 'PANEL_USER_FORBIDDEN_FIELD');
  }
  const injecte = await patch(CREE.DEV.userId, {
    projectAccess: { mode: 'ALL_PAIRED', grantedBy: 'quelqu-un-d-autre' },
  });
  check('un `grantedBy` injecté est REFUSÉ', injecte.status === 400);

  /* ── LE SERVEUR CALCULE LA TRACE ── */
  await patch(CREE.DEV.userId, { projectAccess: { mode: 'EXPLICIT', projectIds: [SB_AUTO] } });
  const trace = (await PanelUser.findOne({ userId: CREE.DEV.userId }).lean()).projectAccess;
  check('`grantedBy` est l’acteur souverain', trace.grantedBy === ROI.userId);
  check('…et `grantedAt` est daté par le serveur', typeof trace.grantedAt === 'string');

  /* ── L'ÉTAT ── */
  const versionInitiale = (await PanelUser.findOne({ userId: CREE.DEV.userId }).lean()).tokenVersion;
  const desactive = await patch(CREE.DEV.userId, { enabled: false });
  check('désactiver un compte', desactive.status === 200 && desactive.json.data.enabled === false);
  check('…coupe sa session (tokenVersion incrémenté)',
    (await PanelUser.findOne({ userId: CREE.DEV.userId }).lean()).tokenVersion === versionInitiale + 1);
  await patch(CREE.DEV.userId, { enabled: true });
  check('réactiver ne ressuscite PAS les anciennes sessions',
    (await PanelUser.findOne({ userId: CREE.DEV.userId }).lean()).tokenVersion === versionInitiale + 1);

  /* ── UN CHANGEMENT DE RÔLE NE CASSE AUCUNE SESSION ── */
  const versionAvant = (await PanelUser.findOne({ userId: CREE.DEV.userId }).lean()).tokenVersion;
  await patch(CREE.DEV.userId, { role: 'ADMIN' });
  await patch(CREE.DEV.userId, { role: 'DEV' });
  check('un changement de rôle n’incrémente PAS tokenVersion',
    (await PanelUser.findOne({ userId: CREE.DEV.userId }).lean()).tokenVersion === versionAvant);
}

/* ══════════════════════════════════════════════════════════════════════════
   6. LA SOUVERAINETÉ SUR SOI-MÊME.
   ══════════════════════════════════════════════════════════════════════════ */
section('6 · Un souverain s’administre lui-même');
{
  const surMoi = (body) => call('PATCH', `/api/panel-users/${ROI.userId}`, { headers: SUPER, body });

  check('il change son propre nom affiché',
    (await surMoi({ displayName: 'Souverain renommé' })).status === 200);
  check('il s’accorde ALL_PAIRED',
    (await surMoi({ projectAccess: { mode: 'ALL_PAIRED' } })).status === 200);

  const trace = (await PanelUser.findOne({ userId: ROI.userId }).lean()).projectAccess;
  check('…et la trace le désigne LUI comme acteur', trace.grantedBy === ROI.userId);

  /** L'auto-attribution prend effet TOUT DE SUITE, dans la même session. */
  const aussitot = await call('POST', `/api/federation/projects/${SB_AUTO}/assertion`, {
    headers: SUPER, body: { returnUrl: RETOUR },
  });
  check('sa fédération est autorisée immédiatement, sans reconnexion', aussitot.status === 200);

  await surMoi({ projectAccess: { mode: 'NONE' } });
  const apresRetrait = await call('POST', `/api/federation/projects/${SB_AUTO}/assertion`, {
    headers: SUPER, body: { returnUrl: RETOUR },
  });
  check('…et se la retirer la referme immédiatement',
    apresRetrait.status === 403
    && apresRetrait.json?.code === 'FEDERATION_PROJECT_ACCESS_DENIED');

  /**
   * SE RÉTROGRADER EST AUTORISÉ, ET LA CONSÉQUENCE EST IMMÉDIATE.
   *
   * Aucune garde ne l'empêche. On le prouve, puis on rend le rôle par la base —
   * ce qui est exactement la seule issue restante quand on s'est démis, et
   * c'est la conséquence documentée.
   */
  const auto = await surMoi({ role: 'DEV' });
  check('un souverain PEUT se rétrograder', auto.status === 200);
  const ensuite = await call('PATCH', `/api/panel-users/${CREE.ADMIN.userId}`, {
    headers: SUPER, body: { displayName: 'Trop tard' },
  });
  check('…et perd la souveraineté à la requête SUIVANTE, sans reconnexion',
    ensuite.status === 403 && ensuite.json?.code === 'PANEL_SUPER_ADMIN_REQUIRED');
  check('…tout en gardant les surfaces développeur',
    (await call('GET', '/api/panel-users', { headers: SUPER })).status === 200);

  await PanelUser.updateOne({ userId: ROI.userId }, { $set: { role: 'SUPER_ADMIN' } });
  check('le rôle rendu en base est repris sans reconnexion',
    (await call('PATCH', `/api/panel-users/${CREE.ADMIN.userId}`, {
      headers: SUPER, body: { displayName: 'De nouveau' },
    })).status === 200);
}

/* ══════════════════════════════════════════════════════════════════════════
   7. CE QUE ADMIN ET DEV NE PEUVENT PAS.
   ══════════════════════════════════════════════════════════════════════════ */
section('7 · L’administration a quitté ADMIN et DEV');
{
  const cible = CREE.ADMIN.userId;
  const refus = [
    ['créer', 'POST', '/api/panel-users', { email: 'x@y.test', displayName: 'X Y', role: 'DEV' }],
    ['modifier', 'PATCH', `/api/panel-users/${cible}`, { displayName: 'Renommé' }],
    ['promouvoir', 'PATCH', `/api/panel-users/${cible}`, { role: 'SUPER_ADMIN' }],
    ['accorder un accès', 'PATCH', `/api/panel-users/${cible}`, { projectAccess: { mode: 'ALL_PAIRED' } }],
    ['supprimer', 'DELETE', `/api/panel-users/${cible}`, undefined],
    ['inviter', 'POST', `/api/panel-users/${cible}/invitation`, {}],
  ];

  for (const [libelle, methode, chemin, corps] of refus) {
    const parDev = await call(methode, chemin, { headers: DEV_H, ...(corps ? { body: corps } : {}) });
    const parAdmin = await call(methode, chemin, { headers: ADMIN_H, ...(corps ? { body: corps } : {}) });
    check(`un DEV ne peut pas ${libelle}`,
      parDev.status === 403 && parDev.json?.code === 'PANEL_SUPER_ADMIN_REQUIRED');
    check(`un ADMIN ne peut pas ${libelle}`, parAdmin.status === 403);
  }

  /** Ce qu'un DEV garde : la lecture, et son propre nom. */
  check('un DEV lit toujours l’annuaire',
    (await call('GET', '/api/panel-users', { headers: DEV_H })).status === 200);
  check('…et corrige toujours son propre nom',
    (await call('PATCH', '/api/panel-users/me', {
      headers: DEV_H, body: { displayName: 'Développeuse senior' },
    })).status === 200);
  check('…mais pas son propre rôle par cette porte',
    (await call('PATCH', '/api/panel-users/me', {
      headers: DEV_H, body: { role: 'SUPER_ADMIN' },
    })).status === 400);
}

/* ══════════════════════════════════════════════════════════════════════════
   8. LA FÉDÉRATION — ce que les projets reçoivent.
   ══════════════════════════════════════════════════════════════════════════ */
section('8 · Un SUPER_ADMIN entre dans un projet comme DEV');
{
  const assertion = await import('../backend/src/services/federation/federationAssertion.service.js');
  const decode = (jwt) => JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString('utf8'));

  const federer = (headers) => call('POST', `/api/federation/projects/${SB_AUTO}/assertion`, {
    headers, body: { returnUrl: RETOUR },
  });

  /* SUPER_ADMIN sans accès → refusé. Le rôle ne suffit JAMAIS. */
  check('SUPER_ADMIN sans projectAccess est REFUSÉ',
    (await federer(SUPER)).json?.code === 'FEDERATION_PROJECT_ACCESS_DENIED');

  await call('PATCH', `/api/panel-users/${ROI.userId}`, {
    headers: SUPER, body: { projectAccess: { mode: 'ALL_PAIRED' } },
  });
  const emise = await federer(SUPER);
  check('SUPER_ADMIN + ALL_PAIRED est ACCORDÉ', emise.status === 200);

  const claims = decode(emise.json.data.assertion);
  check('l’assertion porte role=DEV', claims.role === 'DEV');
  check('…et JAMAIS SUPER_ADMIN', !JSON.stringify(claims).includes('SUPER_ADMIN'));
  check('…tout en désignant le bon compte', claims.panelUserId === ROI.userId);

  const verdict = await assertion.verifyProjectAssertion(emise.json.data.assertion, { audience: SB_AUTO });
  check('le vérificateur de référence l’accepte', verdict.valid === true);

  /**
   * UNE ASSERTION QUI PORTERAIT LE RÔLE RÉEL EST REFUSÉE.
   *
   * C'est le contrôle qui rend la projection obligatoire plutôt que
   * conventionnelle : si un jour quelqu'un recopie `user.role` dans les claims,
   * cette ligne le refuse au lieu de le laisser arriver chez le client.
   */
  const keys = await import('../backend/src/services/federation/federationKeys.service.js');
  const cle = await keys.signingKey();
  const forgee = jwt.sign(
    { principalType: 'PANEL_USER', panelUserId: ROI.userId, role: 'SUPER_ADMIN', tokenVersion: 0, jti: 'x' },
    cle.privateKeyPem,
    {
      algorithm: cle.algorithm, issuer: assertion.FEDERATION_ISSUER, audience: SB_AUTO,
      subject: ROI.userId, expiresIn: 180, keyid: cle.kid, header: { kid: cle.kid },
    },
  );
  const refusee = await assertion.verifyProjectAssertion(forgee, { audience: SB_AUTO });
  check('une assertion portant SUPER_ADMIN est REFUSÉE',
    refusee.valid === false && refusee.reasonCode === 'FEDERATION_ASSERTION_CONTRACT_VIOLATION');

  /* ADMIN → refusé, même avec un projectAccess posé en base. */
  await PanelUser.updateOne(
    { userId: GESTION.userId },
    { $set: { projectAccess: { mode: 'ALL_PAIRED', projectIds: [] } } },
  );
  const parAdmin = await federer(ADMIN_H);
  check('un ADMIN porteur d’un projectAccess reste REFUSÉ', parAdmin.status === 403);

  /* L'introspection répond la même chose, et projette elle aussi. */
  const introspection = await import('../backend/src/services/federation/federationIntrospection.service.js');
  const vu = await introspection.introspectPrincipal({ panelUserId: ROI.userId, projectId: SB_AUTO });
  check('l’introspection accepte le souverain', vu.active === true);
  check('…et lui projette role=DEV', vu.principal.role === 'DEV');
  const vuAdmin = await introspection.introspectPrincipal({
    panelUserId: GESTION.userId, projectId: SB_AUTO,
  });
  check('…et refuse l’ADMIN', vuAdmin.active === false);
}

/* ══════════════════════════════════════════════════════════════════════════
   9. LES TRANSITIONS DE RÔLE, EN VIVANT.
   ══════════════════════════════════════════════════════════════════════════ */
section('9 · Changer de rôle change tout, à la requête suivante');
{
  const cobaye = await users.createUser({
    email: 'cobaye@panel.test', password: 'Cobaye-2026', displayName: 'Cobaye', role: 'DEV',
  });
  await call('PATCH', `/api/panel-users/${cobaye.userId}`, {
    headers: SUPER, body: { projectAccess: { mode: 'ALL_PAIRED' } },
  });
  /** UNE session, ouverte une fois, pour toute la section. */
  const SESSION = bearer(await jetonDe('cobaye@panel.test', 'Cobaye-2026'));
  const federer = () => call('POST', `/api/federation/projects/${SB_AUTO}/assertion`, {
    headers: SESSION, body: { returnUrl: RETOUR },
  });
  const devenir = (role) => call('PATCH', `/api/panel-users/${cobaye.userId}`, {
    headers: SUPER, body: { role },
  });

  check('DEV : la fédération est ouverte', (await federer()).status === 200);

  await devenir('ADMIN');
  /**
   * DEUX GARDES REFUSENT, ET ON LES ÉPROUVE TOUTES LES DEUX.
   *
   * La ROUTE d'émission est montée derrière `requirePanelDeveloper` : c'est
   * elle qui répond en premier, et son code est `PANEL_FORBIDDEN`. Le SERVICE
   * revérifie le rôle, parce qu'il est appelable autrement — et son refus
   * porte `FEDERATION_ROLE_FORBIDDEN`. Ne contrôler que la route laisserait la
   * défense en profondeur non éprouvée ; ne contrôler que le service ne dirait
   * rien de ce qu'un navigateur reçoit.
   */
  const parLaRoute = await federer();
  check('DEV → ADMIN : la fédération se ferme immédiatement',
    parLaRoute.status === 403 && parLaRoute.json?.code === 'PANEL_FORBIDDEN');

  const assertionService = await import('../backend/src/services/federation/federationAssertion.service.js');
  const refusService = await assertionService
    .issueProjectAssertion({ panelUserId: cobaye.userId, projectId: SB_AUTO })
    .then(() => null)
    .catch((err) => err?.reasonCode ?? null);
  check('…et le service le refuse aussi, nommément sur le rôle',
    refusService === 'FEDERATION_ROLE_FORBIDDEN');

  check('…et les surfaces techniques aussi',
    (await call('GET', '/api/panel-users', { headers: SESSION })).status === 403);

  await devenir('SUPER_ADMIN');
  check('ADMIN → SUPER_ADMIN : la fédération se rouvre, sans reconnexion',
    (await federer()).status === 200);
  check('…et la souveraineté est acquise dans la MÊME session',
    (await call('PATCH', `/api/panel-users/${cobaye.userId}`, {
      headers: SESSION, body: { displayName: 'Cobaye souverain' },
    })).status === 200);

  await devenir('DEV');
  check('SUPER_ADMIN → DEV : la fédération reste ouverte', (await federer()).status === 200);
  check('…mais la souveraineté est perdue',
    (await call('POST', '/api/panel-users', {
      headers: SESSION, body: { email: 'z@z.test', displayName: 'Z Z', role: 'DEV' },
    })).status === 403);

  /** L'introspection suit — une session projet ouverte serait coupée. */
  const introspection = await import('../backend/src/services/federation/federationIntrospection.service.js');
  await devenir('ADMIN');
  check('rétrogradé, le principal fédéré devient INACTIF',
    (await introspection.introspectPrincipal({
      panelUserId: cobaye.userId, projectId: SB_AUTO,
    })).active === false);

  await PanelUser.deleteOne({ userId: cobaye.userId });
}

/* ══════════════════════════════════════════════════════════════════════════
   10. LA SUPPRESSION.
   ══════════════════════════════════════════════════════════════════════════ */
section('10 · Supprimer, y compris un souverain, y compris soi-même');
{
  const introspection = await import('../backend/src/services/federation/federationIntrospection.service.js');

  /* ── UN COMPTE SUPPRIMÉ N'EST PLUS PERSONNE ── */
  const condamne = await users.createUser({
    email: 'condamne@panel.test', password: 'Condamne-2026', displayName: 'Condamné', role: 'DEV',
  });
  await call('PATCH', `/api/panel-users/${condamne.userId}`, {
    headers: SUPER, body: { projectAccess: { mode: 'ALL_PAIRED' } },
  });
  const SA_SESSION = bearer(await jetonDe('condamne@panel.test', 'Condamne-2026'));
  check('sa session fonctionne avant',
    (await call('GET', '/api/panel-users/me', { headers: SA_SESSION })).status === 200);

  const suppression = await call('DELETE', `/api/panel-users/${condamne.userId}`, { headers: SUPER });
  check('un SUPER_ADMIN supprime un DEV', suppression.status === 200);
  check('…et l’écran sait que ce n’était pas lui', suppression.json?.data?.selfDeletion === false);
  check('sa session Panel est morte',
    (await call('GET', '/api/panel-users/me', { headers: SA_SESSION })).status === 401);
  check('aucune nouvelle fédération n’est possible',
    (await call('POST', `/api/federation/projects/${SB_AUTO}/assertion`, {
      headers: SA_SESSION, body: { returnUrl: RETOUR },
    })).status === 401);
  check('sa session PROJET se ferme à la revalidation',
    (await introspection.introspectPrincipal({
      panelUserId: condamne.userId, projectId: SB_AUTO,
    })).active === false);

  /* ── UN AUTRE SOUVERAIN ── */
  check('un SUPER_ADMIN supprime un ADMIN',
    (await call('DELETE', `/api/panel-users/${CREE.ADMIN.userId}`, { headers: SUPER })).status === 200);
  check('un SUPER_ADMIN supprime un autre SUPER_ADMIN',
    (await call('DELETE', `/api/panel-users/${CREE.SUPER_ADMIN.userId}`, { headers: SUPER })).status === 200);
  check('supprimer un compte déjà supprimé est un 404 franc',
    (await call('DELETE', `/api/panel-users/${CREE.SUPER_ADMIN.userId}`, { headers: SUPER })).status === 404);

  /* ── LE JOURNAL SURVIT AUX COMPTES ── */
  const trace = await PanelEvent
    .findOne({ type: EVENT_TYPES.PANEL_USER_DELETED, 'data.targetUserId': condamne.userId })
    .lean();
  check('la suppression est journalisée', Boolean(trace));
  check('…et le journal garde l’adresse en instantané',
    trace?.data?.targetEmail === 'condamne@panel.test');
  check('…ainsi que l’acteur', trace?.data?.actorUserId === ROI.userId);
}

/* ══════════════════════════════════════════════════════════════════════════
   11. LE DERNIER SOUVERAIN, ET L'AUTO-SUPPRESSION.
   ══════════════════════════════════════════════════════════════════════════ */
section('11 · Rien n’empêche de se supprimer, ni de retirer le dernier');
{
  /**
   * CHOIX DE PRODUIT, ASSUMÉ ET DOCUMENTÉ.
   *
   * Aucune garde « il doit rester un Super Admin ». Elle protégerait d'une
   * maladresse en empêchant une décision légitime — céder la souveraineté,
   * fermer un compte de transition — et donnerait une fausse assurance, car
   * elle ne couvre aucune des autres façons de perdre l'accès. La protection
   * est une confirmation à l'écran qui NOMME la conséquence.
   */
  const restants = await PanelUser.countDocuments({ role: 'SUPER_ADMIN' });
  check('il ne reste QU’UN seul souverain', restants === 1);

  const auto = await call('DELETE', `/api/panel-users/${ROI.userId}`, { headers: SUPER });
  check('le DERNIER SUPER_ADMIN peut se supprimer lui-même', auto.status === 200);
  check('…et l’écran est prévenu que c’était lui', auto.json?.data?.selfDeletion === true);
  check('sa session est morte à l’instant',
    (await call('GET', '/api/panel-users/me', { headers: SUPER })).status === 401);
  check('le Panel n’a plus AUCUN souverain — état assumé',
    (await PanelUser.countDocuments({ role: 'SUPER_ADMIN' })) === 0);
  check('…et plus aucun écran ne permet d’en désigner un',
    (await call('POST', '/api/panel-users', {
      headers: DEV_H, body: { email: 'sauveur@panel.test', displayName: 'Sauveur', role: 'SUPER_ADMIN' },
    })).status === 403);

  /** L'issue documentée : l'amorçage. Il promeut un compte EXISTANT. */
  await users.createUser({
    email: 'luca.duhoux@gmail.com', password: 'MotDePasseDeLuca-2026',
    displayName: 'Luca Duhoux', role: 'DEV',
  });
  const secours = await users.bootstrapPanelAccounts();
  check('un redémarrage rend la souveraineté au compte d’amorçage',
    secours.sovereign.promoted === true);
  check('…et le Panel a de nouveau un souverain',
    (await PanelUser.countDocuments({ role: 'SUPER_ADMIN' })) === 1);
}

/* ══════════════════════════════════════════════════════════════════════════
   12. LE JOURNAL, ET CE QU'IL NE CONTIENT PAS.
   ══════════════════════════════════════════════════════════════════════════ */
section('12 · Chaque acte laisse une trace, aucune ne porte de secret');
{
  const attendus = [
    EVENT_TYPES.PANEL_USER_CREATED,
    EVENT_TYPES.PANEL_USER_UPDATED,
    EVENT_TYPES.PANEL_USER_ROLE_CHANGED,
    EVENT_TYPES.PANEL_USER_ENABLED_CHANGED,
    EVENT_TYPES.PANEL_USER_PROJECT_ACCESS_CHANGED,
    EVENT_TYPES.PANEL_USER_DELETED,
  ];
  for (const type of attendus) {
    check(`le journal porte ${type}`, (await PanelEvent.countDocuments({ type })) > 0);
  }

  const roleChange = await PanelEvent.findOne({ type: EVENT_TYPES.PANEL_USER_ROLE_CHANGED }).lean();
  check('un changement de rôle porte l’avant ET l’après',
    typeof roleChange?.data?.before === 'string' && typeof roleChange?.data?.after === 'string');

  const accesChange = await PanelEvent
    .findOne({ type: EVENT_TYPES.PANEL_USER_PROJECT_ACCESS_CHANGED, 'data.selfGrant': true })
    .lean();
  check('une auto-attribution est identifiable comme telle', Boolean(accesChange));

  const tout = JSON.stringify(
    await PanelEvent.find({ type: { $in: attendus } }).lean(),
  );
  check('aucun mot de passe, aucune empreinte, aucun jeton au journal',
    !/passwordHash|Souverain-2026|Developpeur-2026|MonPropreMotDePasse|resetUrl|token=/i.test(tout));

  /** Et l'annuaire lui-même ne rend rien de sensible. */
  const luca = await jetonDe('luca.duhoux@gmail.com', 'MotDePasseDeLuca-2026');
  const annuaire = await call('GET', '/api/panel-users', { headers: bearer(luca) });
  check('l’annuaire ne rend ni empreinte ni tokenVersion',
    !/passwordHash|tokenVersion|passwordReset/i.test(JSON.stringify(annuaire.json.data)));
}

reset.__resetPasswordResetTestDeps();
await close();
await stopMemoryMongo();
finish();
