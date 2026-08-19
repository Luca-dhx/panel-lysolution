// LE SOCLE DE CONFIANCE DE LA FÉDÉRATION — L12.A.
//
// ══ CE QUE CETTE RECETTE DOIT PROUVER ═══════════════════════════════════════
//
// Le LOT 2A ne branche AUCUN projet. Son seul livrable est une affirmation
// signée, et la seule façon de qualifier une affirmation est de tenter de la
// falsifier. Cette suite est donc majoritairement une suite d'ÉCHECS
// ATTENDUS : chaque contrôle vert est une attaque qui n'aboutit pas.
//
// ══ POURQUOI LE VÉRIFICATEUR VIT ICI, ET PAS DANS UN PROJET ═════════════════
//
// Parce qu'un vérificateur écrit en même temps que son premier consommateur
// n'est jamais mis en défaut : il est seulement mis d'accord avec lui. En
// l'éprouvant avant qu'un projet en dépende, on garde la possibilité qu'il ait
// tort. Il servira de spécification exécutable au LOT 2B.
//
// ══ LES CLÉS SONT ÉPHÉMÈRES ════════════════════════════════════════════════
//
// Aucune clé privée n'est écrite dans ce dépôt : chaque exécution génère la
// sienne, en base mémoire. Une clé de test committée finit toujours par être
// copiée dans un environnement qui n'est pas un test.
import crypto from 'node:crypto';
import { createRequire } from 'node:module';

import {
  check, connectTestDatabase, finish, section, setTestEnv,
  startMemoryMongo, stopMemoryMongo, startServer,
} from './helpers/harness.js';

setTestEnv();
await startMemoryMongo();
await connectTestDatabase();

/**
 * `jsonwebtoken` est une dépendance DU BACKEND, et `tests/` vit à côté, pas
 * dedans. On emprunte donc sa résolution — comme le font déjà les recettes
 * d'écosystème — plutôt que d'ajouter la dépendance une seconde fois : deux
 * exemplaires pourraient diverger de version, et la recette éprouverait alors
 * une bibliothèque que la production n'utilise pas.
 */
const jwt = createRequire(new URL('../backend/package.json', import.meta.url))('jsonwebtoken');

const { createApp } = await import('../backend/src/app.js');
const users = await import('../backend/src/services/auth/panelUsers.service.js');
const registry = await import('../backend/src/services/registry/projectRegistry.service.js');
const keys = await import('../backend/src/services/federation/federationKeys.service.js');
const federation = await import('../backend/src/services/federation/federationAssertion.service.js');
const { FEDERATION_ERROR_CODES: E } = await import('../backend/src/services/federation/federationErrors.js');
const { default: PanelUser } = await import('../backend/src/models/PanelUser.model.js');
const { default: PanelProject } = await import('../backend/src/models/PanelProject.model.js');
const { default: PanelFederationKey } = await import('../backend/src/models/PanelFederationKey.model.js');
const { PanelEvent } = await import('../backend/src/models/PanelSupervision.model.js');

await PanelFederationKey.syncIndexes();
await users.resetUsers();
await users.seedFromEnv();

const { call, close } = await startServer(createApp());

/** Un projet APPAIRÉ, par écriture directe : le pont n'est pas le sujet ici. */
async function projet(nom, status = 'PAIRED') {
  const declared = await registry.declareProject({
    publicBackendUrl: `https://${nom}.test`,
    projectName: nom,
  });
  await PanelProject.updateOne(
    { projectId: declared.record.projectId },
    { $set: { 'pairing.status': status } },
  );
  return declared.record.projectId;
}

const PROJET_A = await projet('projet-a');
const PROJET_B = await projet('projet-b');
const PROJET_DECLARE = await projet('projet-declare', 'DECLARED');
const PROJET_REVOQUE = await projet('projet-revoque', 'REVOKED');

/** Un compte DEV autorisé sur tout le parc — le cas nominal. */
const DEV = await users.createUser({
  email: 'dev-federe@panel.test', password: 'DevFedere-2026', displayName: 'Dev Fédéré', role: 'DEV',
});
await users.setProjectAccess(DEV.userId, { mode: 'ALL_PAIRED' });

/* ══════════════════════════════════════════════════════════════════════════
   1. LE COMPTE — enabled et projectAccess, deux notions distinctes.
   ══════════════════════════════════════════════════════════════════════════ */
section('1 · Le compte porte son état et son contrat d’accès');
{
  const stored = await PanelUser.findOne({ userId: DEV.userId }).lean();
  check('un compte neuf est ACTIF', stored.enabled === true);
  check('…et n’a AUCUN accès projet par défaut — l’accès est un ACTE',
    (await PanelUser.findOne({ email: process.env.SEED_DEV_EMAIL }).lean()).projectAccess.mode === 'NONE');

  /**
   * LE BACKFILL EST DÉTERMINISTE : un compte antérieur au champ décrit une
   * personne en exercice. Un défaut fermé aurait verrouillé tout le monde au
   * déploiement — un fail-closed qui coupe tout et ne protège de rien.
   */
  await PanelUser.collection.updateOne(
    { userId: DEV.userId },
    { $unset: { enabled: '', projectAccess: '' } },
  );
  const rapport = await users.backfillPanelUserAccess();
  const apres = await PanelUser.findOne({ userId: DEV.userId }).lean();
  check('le backfill rouvre un compte antérieur', apres.enabled === true && rapport.enabled >= 1);
  check('…et ne lui accorde AUCUN accès projet', apres.projectAccess.mode === 'NONE');
  check('rejoué, il ne modifie plus rien',
    (await users.backfillPanelUserAccess()).enabled === 0);

  await users.setProjectAccess(DEV.userId, { mode: 'ALL_PAIRED' });

  /**
   * DÉSACTIVER FAIT DEUX GESTES. Sans l'incrément de version, le compte ne
   * pourrait plus se reconnecter mais ses sessions ouvertes vivraient jusqu'à
   * expiration — or on désactive quand on veut que ça s'arrête maintenant.
   */
  const avant = (await PanelUser.findOne({ userId: DEV.userId }).lean()).tokenVersion;
  await users.setUserEnabled(DEV.userId, false);
  const desactive = await PanelUser.findOne({ userId: DEV.userId }).lean();
  check('désactiver ferme le compte ET révoque les sessions',
    desactive.enabled === false && desactive.tokenVersion === avant + 1);

  check('un compte désactivé ne s’authentifie plus',
    (await users.authenticate('dev-federe@panel.test', 'DevFedere-2026')) === null);

  await users.setUserEnabled(DEV.userId, true);
  const reactive = await PanelUser.findOne({ userId: DEV.userId }).lean();
  check('réactiver rouvre le compte…', reactive.enabled === true);
  check('…SANS ressusciter les anciennes sessions', reactive.tokenVersion === avant + 1);
  check('…et l’authentification refonctionne',
    (await users.authenticate('dev-federe@panel.test', 'DevFedere-2026')) !== null);
}

/* ══════════════════════════════════════════════════════════════════════════
   2. LES CLÉS — asymétriques, kid obligatoire, privée jamais publiée.
   ══════════════════════════════════════════════════════════════════════════ */
section('2 · La clé privée ne sort jamais, la publique est publiable');
{
  /**
   * ══ POURQUOI RS256, PROUVÉ PAR L'EXÉCUTION ════════════════════════════════
   *
   * Le lot demande EdDSA « si jsonwebtoken le supporte proprement ». Ce
   * contrôle est la preuve qu'il ne le supporte pas — et il échouera le jour
   * où ce sera faux, ce qui est exactement le signal qu'il faudra revoir le
   * choix.
   */
  let eddsa = null;
  try {
    jwt.sign({ a: 1 }, crypto.generateKeyPairSync('ed25519').privateKey, { algorithm: 'EdDSA' });
  } catch (err) { eddsa = err; }
  check('EdDSA n’est PAS servi par jsonwebtoken — d’où RS256', eddsa !== null);

  const active = await keys.ensureActiveKey();
  check('une clé active est posée au premier besoin', active.status === 'ACTIVE');
  check('…avec un kid', typeof active.kid === 'string' && active.kid.length > 8);
  check('…et l’algorithme asymétrique retenu', active.algorithm === 'RS256');

  check('l’amorçage est idempotent',
    (await keys.ensureActiveKey()).kid === active.kid);

  const stored = await PanelFederationKey.findOne({ kid: active.kid }).lean();
  check('la clé PRIVÉE est chiffrée au repos',
    typeof stored.privateKeyEncrypted === 'string'
    && !stored.privateKeyEncrypted.includes('BEGIN')
    && stored.privateKeyEncrypted.split('.').length === 3);
  check('la clé PUBLIQUE est en clair — elle est faite pour être connue',
    stored.publicKeyPem.includes('BEGIN PUBLIC KEY'));

  const jwks = await keys.publicJwks();
  const jwk = jwks.keys.find((k) => k.kid === active.kid);
  check('le JWKS publie la clé', Boolean(jwk));
  check('…au format RSA, avec kid/use/alg',
    jwk.kty === 'RSA' && jwk.use === 'sig' && jwk.alg === 'RS256' && jwk.kid === active.kid);
  check('AUCUNE composante privée ne fuit dans le JWKS',
    !('d' in jwk) && !('p' in jwk) && !('q' in jwk) && !('dp' in jwk) && !('qi' in jwk));

  const serialise = JSON.stringify(jwks);
  check('…ni le moindre PEM privé', !serialise.includes('PRIVATE'));

  /** Le catalogue d'exploitation ne rend pas davantage. */
  const catalogue = JSON.stringify(await keys.describeKeys());
  check('le catalogue de clés ne porte ni PEM ni chiffré',
    !catalogue.includes('BEGIN') && !catalogue.includes('privateKey'));
}

/* ══════════════════════════════════════════════════════════════════════════
   3. LE JEU DE CLÉS EST PUBLIC — un vérificateur n’est pas un utilisateur.
   ══════════════════════════════════════════════════════════════════════════ */
section('3 · Le JWKS se lit sans session');
{
  const anonyme = await call('GET', '/api/federation/.well-known/jwks.json');
  check('le JWKS répond SANS authentification', anonyme.status === 200);
  check('…et porte des clés', Array.isArray(anonyme.json?.keys) && anonyme.json.keys.length >= 1);
  check('…sans aucune composante privée',
    !JSON.stringify(anonyme.json).match(/"d"\s*:|PRIVATE/));

  const cataloguePrive = await call('GET', '/api/federation/keys');
  check('le catalogue de clés, lui, EXIGE une session', cataloguePrive.status === 401);

  const emissionAnonyme = await call('POST', `/api/federation/projects/${PROJET_A}/assertion`);
  check('l’émission exige une session', emissionAnonyme.status === 401);
}

/* ══════════════════════════════════════════════════════════════════════════
   4. L’ÉMISSION NOMINALE — et ce que l’assertion affirme exactement.
   ══════════════════════════════════════════════════════════════════════════ */
section('4 · Une assertion nominale, et son contrat');
let assertionA = null;
{
  const emise = await federation.issueProjectAssertion({
    panelUserId: DEV.userId, projectId: PROJET_A,
  });
  assertionA = emise.assertion;

  check('l’assertion est délivrée', typeof assertionA === 'string');
  check('…pour CE projet', emise.audience === PROJET_A);
  check('…par CE Panel', emise.issuer === 'urn:ly-solution:panel');
  check('…avec le kid de la clé signante', typeof emise.kid === 'string');
  check('…et un jti unique', typeof emise.jti === 'string' && emise.jti.length >= 20);

  const decode = jwt.decode(assertionA, { complete: true });
  check('LE KID EST DANS L’EN-TÊTE — le vérificateur choisit sa clé avant de faire confiance',
    decode.header.kid === emise.kid);
  check('…et l’algorithme annoncé est asymétrique', decode.header.alg === 'RS256');

  const c = decode.payload;
  check('sub identifie le PanelUser', c.sub === DEV.userId && c.panelUserId === DEV.userId);
  check('le type de principal est déclaré', c.principalType === 'PANEL_USER');
  check('le rôle est porté', c.role === 'DEV');
  check('l’environnement est porté', c.environment === 'TEST');
  check('la version de session est portée', Number.isInteger(c.tokenVersion));

  const dureeSecondes = c.exp - c.iat;
  check('LA DURÉE DE VIE EST COURTE (2-5 min)', dureeSecondes >= 120 && dureeSecondes <= 300);

  /**
   * L'ASSERTION NE PORTE AUCUN SECRET, ET AUCUNE DONNÉE PÉRIMABLE. Le nom et
   * l'adresse viendront de la projection du LOT 2B, où ils pourront être
   * corrigés — les figer ici en ferait des copies périmées.
   */
  const brut = JSON.stringify(c);
  check('aucun mot de passe, aucun hash, aucun jeton de reset',
    !brut.includes('password') && !brut.includes('Hash') && !brut.includes('reset'));
  check('aucune adresse e-mail dans l’assertion', !brut.includes('@'));

  const verdict = await federation.verifyProjectAssertion(assertionA, { audience: PROJET_A });
  check('LE VÉRIFICATEUR L’ACCEPTE pour son projet', verdict.valid === true);
  check('…et rend les claims', verdict.claims.sub === DEV.userId);
}

/* ══════════════════════════════════════════════════════════════════════════
   5. AUDIENCE — le refus qui porte toute l’isolation multi-projets.
   ══════════════════════════════════════════════════════════════════════════ */
section('5 · Une assertion de A ne vaut RIEN chez B');
{
  const surB = await federation.verifyProjectAssertion(assertionA, { audience: PROJET_B });
  check('A → B est REFUSÉ', surB.valid === false);
  check('…et le motif nomme l’audience', surB.reasonCode === E.ASSERTION_WRONG_AUDIENCE);

  const emiseB = await federation.issueProjectAssertion({
    panelUserId: DEV.userId, projectId: PROJET_B,
  });
  check('B → B est ACCEPTÉ',
    (await federation.verifyProjectAssertion(emiseB.assertion, { audience: PROJET_B })).valid === true);
  check('B → A est REFUSÉ',
    (await federation.verifyProjectAssertion(emiseB.assertion, { audience: PROJET_A })).valid === false);

  check('deux émissions successives ne partagent PAS leur jti',
    emiseB.jti !== (await federation.issueProjectAssertion({
      panelUserId: DEV.userId, projectId: PROJET_B,
    })).jti);
}

/* ══════════════════════════════════════════════════════════════════════════
   6. ALTÉRATION — signer est la seule façon d’affirmer.
   ══════════════════════════════════════════════════════════════════════════ */
section('6 · Un jeton modifié ne passe pas');
{
  const [entete, charge, signature] = assertionA.split('.');
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const charges = JSON.parse(Buffer.from(charge, 'base64url').toString('utf8'));

  for (const [nom, modif] of [
    ['sub', { ...charges, sub: 'un-autre-compte', panelUserId: 'un-autre-compte' }],
    ['aud', { ...charges, aud: PROJET_B }],
    ['role', { ...charges, role: 'ADMIN' }],
    ['tokenVersion', { ...charges, tokenVersion: 999 }],
    ['exp', { ...charges, exp: charges.exp + 86_400 }],
  ]) {
    const falsifie = `${entete}.${b64(modif)}.${signature}`;
    const verdict = await federation.verifyProjectAssertion(falsifie, { audience: PROJET_A });
    check(`« ${nom} » modifié sans resignature est REFUSÉ`, verdict.valid === false);
  }

  /**
   * CONFUSION D'ALGORITHME — l'attaque classique du format : présenter un
   * jeton `alg: none`, ou signé en HMAC avec la clé PUBLIQUE comme secret.
   * Le vérificateur IMPOSE l'algorithme de la clé, il ne le lit jamais du jeton.
   */
  const sansAlg = `${b64({ alg: 'none', kid: JSON.parse(Buffer.from(entete, 'base64url')).kid })}.${charge}.`;
  check('un jeton « alg: none » est REFUSÉ',
    (await federation.verifyProjectAssertion(sansAlg, { audience: PROJET_A })).valid === false);

  const cle = await PanelFederationKey.findOne({ status: 'ACTIVE' }).lean();
  const hmac = jwt.sign(charges, cle.publicKeyPem, {
    algorithm: 'HS256', header: { kid: cle.kid }, noTimestamp: true,
  });
  check('un jeton HMAC signé avec la clé PUBLIQUE est REFUSÉ',
    (await federation.verifyProjectAssertion(hmac, { audience: PROJET_A })).valid === false);

  for (const [nom, valeur] of [['vide', ''], ['non-jeton', 'bonjour'], ['nul', null]]) {
    check(`une entrée ${nom} est refusée proprement`,
      (await federation.verifyProjectAssertion(valeur, { audience: PROJET_A })).valid === false);
  }
}

/* ══════════════════════════════════════════════════════════════════════════
   7. EXPIRATION — horloge simulée, jamais une attente réelle.
   ══════════════════════════════════════════════════════════════════════════ */
section('7 · Une assertion périmée ne vaut plus rien');
{
  const maintenant = Date.now();
  const dansCinqMinutes = maintenant + 5 * 60 * 1000;

  check('valide à l’instant', (await federation.verifyProjectAssertion(
    assertionA, { audience: PROJET_A, now: maintenant },
  )).valid === true);

  const perimee = await federation.verifyProjectAssertion(
    assertionA, { audience: PROJET_A, now: dansCinqMinutes },
  );
  check('REFUSÉE cinq minutes plus tard', perimee.valid === false);
  check('…et le motif est l’expiration', perimee.reasonCode === E.ASSERTION_EXPIRED);

  /**
   * TOLÉRANCE D'HORLOGE : deux machines qui ne sont pas à la même seconde ne
   * doivent pas produire un refus. Vingt secondes après l'expiration, on
   * accepte encore ; largement au-delà, non.
   */
  const claims = jwt.decode(assertionA);
  check('une dérive de quelques secondes est tolérée',
    (await federation.verifyProjectAssertion(assertionA, {
      audience: PROJET_A, now: (claims.exp + 10) * 1000,
    })).valid === true);
}

/* ══════════════════════════════════════════════════════════════════════════
   8. AUTORISATION — cinq refus, cinq causes nommées.
   ══════════════════════════════════════════════════════════════════════════ */
section('8 · L’émission refuse, et dit pourquoi');
{
  const refus = async (fn) => { try { await fn(); return null; } catch (e) { return e; } };

  // COMPTE DÉSACTIVÉ
  await users.setUserEnabled(DEV.userId, false);
  const desactive = await refus(() => federation.issueProjectAssertion({
    panelUserId: DEV.userId, projectId: PROJET_A,
  }));
  check('compte désactivé → refus nommé', desactive?.reasonCode === E.USER_DISABLED);
  await users.setUserEnabled(DEV.userId, true);
  check('réactivé → émission de nouveau possible',
    (await federation.issueProjectAssertion({ panelUserId: DEV.userId, projectId: PROJET_A })).assertion.length > 0);

  // RÔLE — décision documentée : seul DEV, ADMIN refusé.
  const admin = await users.createUser({
    email: 'admin-federe@panel.test', password: 'AdminFedere-2026', displayName: 'Admin', role: 'ADMIN',
  });
  await users.setProjectAccess(admin.userId, { mode: 'ALL_PAIRED' });
  const roleRefuse = await refus(() => federation.issueProjectAssertion({
    panelUserId: admin.userId, projectId: PROJET_A,
  }));
  check('un ADMIN du Panel n’obtient PAS d’accès développeur projet',
    roleRefuse?.reasonCode === E.ROLE_FORBIDDEN);

  // ACCÈS PROJET — le contrat explicite.
  const sansAcces = await users.createUser({
    email: 'dev-sans-acces@panel.test', password: 'SansAcces-2026', displayName: 'Dev', role: 'DEV',
  });
  const accesRefuse = await refus(() => federation.issueProjectAssertion({
    panelUserId: sansAcces.userId, projectId: PROJET_A,
  }));
  check('un DEV SANS accès déclaré est refusé — le rôle ne suffit pas',
    accesRefuse?.reasonCode === E.PROJECT_ACCESS_DENIED);

  await users.setProjectAccess(sansAcces.userId, { mode: 'EXPLICIT', projectIds: [PROJET_A] });
  check('accès EXPLICITE sur A → A passe',
    (await federation.issueProjectAssertion({ panelUserId: sansAcces.userId, projectId: PROJET_A })).assertion.length > 0);
  const horsListe = await refus(() => federation.issueProjectAssertion({
    panelUserId: sansAcces.userId, projectId: PROJET_B,
  }));
  check('…et B, hors de sa liste, est refusé', horsListe?.reasonCode === E.PROJECT_ACCESS_DENIED);

  // APPAIRAGE
  const declare = await refus(() => federation.issueProjectAssertion({
    panelUserId: DEV.userId, projectId: PROJET_DECLARE,
  }));
  check('projet DECLARED → refus', declare?.reasonCode === E.PROJECT_NOT_PAIRED);
  const revoque = await refus(() => federation.issueProjectAssertion({
    panelUserId: DEV.userId, projectId: PROJET_REVOQUE,
  }));
  check('projet REVOKED → refus', revoque?.reasonCode === E.PROJECT_NOT_PAIRED);

  const inconnu = await refus(() => federation.issueProjectAssertion({
    panelUserId: DEV.userId, projectId: 'nexiste-pas',
  }));
  check('projet inconnu → refus', inconnu?.reasonCode === E.PROJECT_UNKNOWN);

  // ENVIRONNEMENT
  await PanelProject.updateOne({ projectId: PROJET_A }, { $set: { 'runtime.environment': 'PROD' } });
  const monde = await refus(() => federation.issueProjectAssertion({
    panelUserId: DEV.userId, projectId: PROJET_A,
  }));
  check('une fiche qui déclare un autre monde → refus', monde?.reasonCode === E.ENVIRONMENT_MISMATCH);
  await PanelProject.updateOne({ projectId: PROJET_A }, { $set: { 'runtime.environment': null } });
}

/* ══════════════════════════════════════════════════════════════════════════
   9. TOKENVERSION — relue à l’émission, jamais reçue de l’appelant.
   ══════════════════════════════════════════════════════════════════════════ */
section('9 · La version de session est LUE, pas fournie');
{
  await PanelUser.updateOne({ userId: DEV.userId }, { $set: { tokenVersion: 4 } });
  const t1 = await federation.issueProjectAssertion({ panelUserId: DEV.userId, projectId: PROJET_A });
  check('l’assertion porte la version courante (4)', jwt.decode(t1.assertion).tokenVersion === 4);

  await PanelUser.updateOne({ userId: DEV.userId }, { $set: { tokenVersion: 5 } });
  const t2 = await federation.issueProjectAssertion({ panelUserId: DEV.userId, projectId: PROJET_A });
  check('après incrément, l’émission suivante porte 5 — la valeur est LIVE',
    jwt.decode(t2.assertion).tokenVersion === 5);
  check('…et l’ancienne assertion porte toujours 4, elle est un fait daté',
    jwt.decode(t1.assertion).tokenVersion === 4);
}

/* ══════════════════════════════════════════════════════════════════════════
   10. ROTATION — le format la permet, et une clé inconnue est refusée.
   ══════════════════════════════════════════════════════════════════════════ */
section('10 · La rotation est possible sans coupure');
{
  const avant = await keys.ensureActiveKey();
  const assertionAncienne = (await federation.issueProjectAssertion({
    panelUserId: DEV.userId, projectId: PROJET_A,
  })).assertion;

  // Étape 1-2 : la nouvelle est publiée AVANT de signer quoi que ce soit.
  const nouvelle = await keys.createKey({ activate: false });
  const jwksDeux = await keys.publicJwks();
  check('les DEUX clés sont publiées pendant le recouvrement',
    jwksDeux.keys.some((k) => k.kid === avant.kid) && jwksDeux.keys.some((k) => k.kid === nouvelle.kid));

  // Étape 3 : bascule.
  await keys.activateKey(nouvelle.kid);
  const assertionNouvelle = (await federation.issueProjectAssertion({
    panelUserId: DEV.userId, projectId: PROJET_A,
  })).assertion;
  check('les nouvelles assertions portent la NOUVELLE clé',
    jwt.decode(assertionNouvelle, { complete: true }).header.kid === nouvelle.kid);

  /**
   * ÉTAPE 4 — LE RECOUVREMENT EST LA RAISON D'ÊTRE DE LA MANŒUVRE : les
   * assertions déjà en vol restent vérifiables pendant leurs trois minutes.
   * Sans lui, toute rotation serait une coupure, donc une rotation qu'on ne
   * fait jamais.
   */
  check('les assertions déjà émises restent VALIDES',
    (await federation.verifyProjectAssertion(assertionAncienne, { audience: PROJET_A })).valid === true);
  check('une seule clé signe à la fois',
    (await PanelFederationKey.countDocuments({ status: 'ACTIVE' })) === 1);

  // Une clé qui n'a jamais existé : refus net, distinct d'une signature fausse.
  const inconnue = jwt.sign(
    { principalType: 'PANEL_USER', panelUserId: DEV.userId, role: 'DEV', tokenVersion: 5, jti: 'x' },
    crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey,
    { algorithm: 'RS256', issuer: 'urn:ly-solution:panel', audience: PROJET_A, subject: DEV.userId,
      expiresIn: 120, header: { kid: 'fed-inexistante' } },
  );
  const verdictInconnue = await federation.verifyProjectAssertion(inconnue, { audience: PROJET_A });
  check('une clé INCONNUE est refusée', verdictInconnue.valid === false);
  check('…et le motif la distingue d’une signature fausse',
    verdictInconnue.reasonCode === E.ASSERTION_UNKNOWN_KEY);
}

/* ══════════════════════════════════════════════════════════════════════════
   11. LA SURFACE HTTP — la session décide, jamais le corps.
   ══════════════════════════════════════════════════════════════════════════ */
section('11 · L’identité ne se déclare pas dans le corps');
{
  const connexion = await call('POST', '/api/auth/login', {
    body: { email: 'dev-federe@panel.test', password: 'DevFedere-2026' },
  });
  const AUTH = { authorization: `Bearer ${connexion.json?.data?.token}` };

  const ok = await call('POST', `/api/federation/projects/${PROJET_A}/assertion`, { headers: AUTH });
  check('un DEV authentifié obtient son assertion', ok.status === 200);
  check('…pour le projet du CHEMIN', ok.json?.data?.audience === PROJET_A);
  check('…et la réponse ne porte aucune clé privée',
    !JSON.stringify(ok.json).includes('PRIVATE'));

  for (const champ of ['panelUserId', 'role', 'tokenVersion', 'sub', 'exp', 'kid']) {
    const force = await call('POST', `/api/federation/projects/${PROJET_A}/assertion`, {
      headers: AUTH, body: { [champ]: 'valeur-choisie' },
    });
    check(`« ${champ} » dans le corps fait ÉCHOUER l’appel`,
      force.status === 400 && force.json?.code === 'FEDERATION_IDENTITY_IN_BODY');
  }

  /**
   * L'ASSERTION EST CELLE DE L'APPELANT, TOUJOURS. Il n'y a aucun paramètre
   * par lequel demander celle de quelqu'un d'autre : le sujet vient de la
   * session, pas de la requête.
   */
  const rendue = jwt.decode(ok.json.data.assertion);
  check('le sujet est l’appelant lui-même', rendue.sub === DEV.userId);

  // Un compte désactivé pendant sa session ne passe plus la porte.
  await users.setUserEnabled(DEV.userId, false);
  const apresDesactivation = await call('POST', `/api/federation/projects/${PROJET_A}/assertion`, { headers: AUTH });
  check('désactiver le compte invalide sa session EN COURS',
    apresDesactivation.status === 401);
  await users.setUserEnabled(DEV.userId, true);
}

/* ══════════════════════════════════════════════════════════════════════════
   12. OBSERVABILITÉ — on sait qui a obtenu quoi, jamais le jeton.
   ══════════════════════════════════════════════════════════════════════════ */
section('12 · Le journal répond « qui, pour quel projet, pourquoi »');
{
  const emis = await PanelEvent.find({ type: 'FEDERATED_ASSERTION_ISSUED' }).lean();
  const refuses = await PanelEvent.find({ type: 'FEDERATED_ASSERTION_DENIED' }).lean();

  check('les émissions sont journalisées', emis.length >= 1);
  check('les refus aussi', refuses.length >= 1);
  check('un refus porte TOUJOURS sa cause',
    refuses.every((e) => typeof e.data?.reasonCode === 'string' && e.data.reasonCode.length > 0));
  check('une émission porte le kid, le jti et l’expiration',
    emis.every((e) => e.data?.kid && e.data?.jti && e.data?.expiresAt));

  const journal = JSON.stringify([...emis, ...refuses]);
  check('AUCUNE assertion brute n’est journalisée',
    !journal.includes('eyJ') && !journal.match(/\.[A-Za-z0-9_-]{40,}\./));
  check('aucune clé privée, aucun mot de passe',
    !journal.includes('PRIVATE') && !journal.includes('password'));
}

/* ══════════════════════════════════════════════════════════════════════════
   13. AUCUN SECRET DANS LE DÉPÔT — et `123dev` est sous surveillance.
   ══════════════════════════════════════════════════════════════════════════ */
section('13 · Le lot n’introduit aucun secret, et surveille le legacy');
{
  const fs = await import('node:fs');
  const path = await import('node:path');
  const url = await import('node:url');
  const racine = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..');

  const fichiers = [];
  (function parcourir(dossier) {
    for (const entree of fs.readdirSync(dossier, { withFileTypes: true })) {
      if (entree.name === 'node_modules' || entree.name.startsWith('.')) continue;
      const complet = path.join(dossier, entree.name);
      if (entree.isDirectory()) parcourir(complet);
      else if (/\.(js|mjs|ts|tsx|json)$/.test(entree.name)) fichiers.push(complet);
    }
  })(racine);

  const avecPem = fichiers.filter((f) => /BEGIN (RSA )?PRIVATE KEY/.test(fs.readFileSync(f, 'utf8')));
  check(`AUCUNE clé privée committée (${avecPem.map((f) => path.relative(racine, f)).join(', ') || 'aucune'})`,
    avecPem.length === 0);

  const source = fs.readFileSync(
    path.join(racine, 'backend/src/services/federation/federationAssertion.service.js'), 'utf8',
  );
  check('le service d’assertion ne journalise jamais le jeton',
    !/logger\.[a-z]+\([^)]*\btoken\b/.test(source) && !/logger\.[a-z]+\([^)]*assertion\b/.test(source));

  /**
   * ══ `123dev` — GARDE DE NON-PROPAGATION (Phase 25) ═════════════════════════
   *
   * Le mot de passe DEV historique vit dans le dépôt VOISIN, et son retrait est
   * le LOT 2C : ce lot-ci ne doit rien casser chez les projets existants. Ce
   * contrôle ne le supprime donc pas — il vérifie qu'il n'entre pas ICI, dans
   * le Panel, à la faveur de la fédération.
   *
   * ── LA DISTINCTION QUI A FAILLI M'ÉCHAPPER ────────────────────────────────
   *
   * Une première version de ce contrôle signalait `config/env.js` et
   * `config.test.js` — c'est-à-dire la LISTE NOIRE qui refuse ces mots de passe
   * en PROD, et la recette qui l'éprouve. Le garde-fou punissait le Panel pour
   * s'être défendu.
   *
   * Une chaîne n'est pas un secret par sa valeur mais par son USAGE. On
   * distingue donc les deux, et on va plus loin : on EXIGE que la liste noire
   * existe. La supprimer ferait échouer ce contrôle, ce qui est exactement le
   * signal voulu.
   */
  const listeNoire = fs.readFileSync(path.join(racine, 'backend/src/config/env.js'), 'utf8');
  check('le Panel REFUSE les mots de passe de démonstration en PROD',
    /KNOWN_SEED_PASSWORDS/.test(listeNoire) && listeNoire.includes('123dev'));

  /** Les seuls fichiers autorisés à NOMMER ces chaînes, et pourquoi. */
  const AUTORISES = [
    // La liste noire elle-même : elle doit les nommer pour les refuser.
    path.join('backend', 'src', 'config', 'env.js'),
    /**
     * LA LISTE NOIRE DÉDIÉE — elle a quitté `env.js` pour son propre module.
     * Elle NOMME ces valeurs pour les REFUSER, jamais pour les écrire : c'est
     * exactement la distinction que ce contrôle prétend faire, et son en-tête
     * l'explique mieux que ce commentaire.
     */
    path.join('backend', 'src', 'utils', 'universalSecrets.js'),
    // La recette qui prouve que la liste noire fonctionne.
    path.join('tests', 'config.test.js'),
    // Ce fichier — il en parle pour les surveiller.
    path.join('tests', 'federation-assertion.test.js'),
  ];

  /**
   * ══ UN COMMENTAIRE N'EST PAS UN USAGE ═══════════════════════════════════
   *
   * Le contrôle lisait le fichier BRUT. Un module qui explique, en toutes
   * lettres, « on refuse `123admin` quelle que soit sa longueur » était donc
   * signalé comme s'il s'en servait — et la seule façon de le taire aurait été
   * d'effacer l'explication, c'est-à-dire de rendre le code moins clair pour
   * satisfaire un test.
   *
   * On retire donc les commentaires avant de chercher. Ce qui reste est du
   * CODE, et une de ces chaînes dans du code est bien un usage.
   */
  const sansCommentaires = (code) => code
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');

  const avecLegacy = fichiers
    .filter((f) => !AUTORISES.some((autorise) => f.endsWith(autorise)))
    .filter((f) => /123dev|123admin/.test(sansCommentaires(fs.readFileSync(f, 'utf8'))));
  check(`aucun mot de passe legacy n’est UTILISÉ dans le Panel (${avecLegacy.map((f) => path.relative(racine, f)).join(', ') || 'aucun'})`,
    avecLegacy.length === 0);
}

/* ══════════════════════════════════════════════════════════════════════════
   14. L'ADRESSE DE RETOUR — la redirection ouverte qui aurait livré le jeton.
   ══════════════════════════════════════════════════════════════════════════ */
section('14 · On ne renvoie le navigateur que vers une origine CONNUE');
{
  /**
   * ══ LA FAILLE QUE CETTE SECTION FERME ══════════════════════════════════════
   *
   * Le parcours se termine par une redirection qui TRANSPORTE l'assertion. Si
   * l'adresse de retour venait de l'appelant sans contrôle, il suffirait de
   * forger un lien vers le Panel avec `returnUrl` chez soi et de l'envoyer à un
   * développeur déjà connecté : le Panel émettrait une assertion parfaitement
   * valide — pour un projet auquel ce développeur a réellement accès — et la
   * livrerait à l'attaquant. Rien n'aurait été forcé ; on l'aurait donnée.
   *
   * C'est une redirection ouverte, en pire : le butin voyage avec la victime.
   */
  const { default: PanelProjectDestination } = await import('../backend/src/models/PanelProjectDestination.model.js');
  const returnUrls = await import('../backend/src/services/federation/federationReturnUrl.js');

  const connexion = await call('POST', '/api/auth/login', {
    body: { email: 'dev-federe@panel.test', password: 'DevFedere-2026' },
  });
  const AUTH = { authorization: `Bearer ${connexion.json?.data?.token}` };

  /**
   * UNE ORIGINE ÉTRANGÈRE EST REFUSÉE, MÊME QUAND LE PROJET EN A DE CONNUES.
   *
   * `PROJET_A` a été déclaré avec un `publicBackendUrl` : il possède donc déjà
   * une origine légitime. C'est le cas nominal, et le plus intéressant — un
   * projet sans aucune origine est trivialement fermé.
   */
  const etrangere = await call('POST', `/api/federation/projects/${PROJET_A}/assertion`, {
    headers: AUTH, body: { returnUrl: 'https://malveillant.test/vol' },
  });
  check('une origine étrangère est REFUSÉE',
    etrangere.status === 400
    && etrangere.json?.code === returnUrls.RETURN_URL_ERRORS.UNKNOWN_ORIGIN);

  /**
   * LE `publicBackendUrl` EST LE FILET DOCUMENTÉ — pour les projets dont
   * aucune destination n'est encore enregistrée, où manager et backend
   * partagent l'origine.
   */
  const parLeBackend = await call('POST', `/api/federation/projects/${PROJET_A}/assertion`, {
    headers: AUTH, body: { returnUrl: 'https://projet-a.test/connexion/ly-solution/retour' },
  });
  check('l’adresse publique du projet vaut origine connue', parLeBackend.status === 200);

  // Une destination enregistrée — c'est ce qu'un déploiement pose.
  const maintenant = new Date().toISOString();
  await PanelProjectDestination.create({
    destinationId: crypto.randomUUID(),
    projectId: PROJET_A,
    environment: 'TEST',
    host: 'manager.client.test',
    urls: { manager: 'https://manager.client.test', backend: 'https://api.client.test' },
    status: 'ACTIVE',
    announcedAt: maintenant,
    createdAt: maintenant,
    updatedAt: maintenant,
  });

  const legitime = await call('POST', `/api/federation/projects/${PROJET_A}/assertion`, {
    headers: AUTH, body: { returnUrl: 'https://manager.client.test/connexion/ly-solution/retour' },
  });
  check('une adresse de l’origine connue est ACCEPTÉE', legitime.status === 200);
  check('…et le Panel rend une adresse RECOMPOSÉE',
    legitime.json?.data?.returnUrl === 'https://manager.client.test/connexion/ly-solution/retour');

  /**
   * LA QUERY ET LE FRAGMENT REÇUS SONT JETÉS. Un `returnUrl` portant déjà
   * `?assertion=…` ou un fragment servirait à masquer ce qu'on s'apprête à y
   * ajouter, ou à fabriquer un `Referer` choisi par l'appelant.
   */
  const bruite = await call('POST', `/api/federation/projects/${PROJET_A}/assertion`, {
    headers: AUTH,
    body: { returnUrl: 'https://manager.client.test/retour?assertion=faux#x' },
  });
  check('la query et le fragment reçus sont ÉCARTÉS',
    bruite.json?.data?.returnUrl === 'https://manager.client.test/retour');

  /** Le cœur : toutes les façons de sortir de l'origine connue. */
  const attaques = [
    ['une autre origine', 'https://malveillant.test/vol'],
    ['un sous-domaine qui préfixe', 'https://manager.client.test.malveillant.test/vol'],
    ['le même hôte en http', 'http://manager.client.test/retour'],
    ['un autre port', 'https://manager.client.test:8443/retour'],
    ['un schéma javascript', 'javascript:alert(1)'],
    ['une donnée en ligne', 'data:text/html,<script>1</script>'],
    ['une adresse relative', '//malveillant.test/vol'],
    ['une chaîne illisible', 'pas-une-url'],
  ];
  for (const [nom, url] of attaques) {
    const refus = await call('POST', `/api/federation/projects/${PROJET_A}/assertion`, {
      headers: AUTH, body: { returnUrl: url },
    });
    check(`${nom} → REFUSÉ`, refus.status === 400);
  }

  /**
   * L'ORIGINE D'UN PROJET N'AUTORISE PAS CELLE D'UN AUTRE. C'est l'isolation
   * de la Phase 7, appliquée à l'adresse de retour.
   */
  const chezLeVoisin = await call('POST', `/api/federation/projects/${PROJET_B}/assertion`, {
    headers: AUTH, body: { returnUrl: 'https://manager.client.test/retour' },
  });
  check('l’origine de A ne vaut PAS pour B',
    chezLeVoisin.status === 400
    && chezLeVoisin.json?.code === returnUrls.RETURN_URL_ERRORS.UNKNOWN_ORIGIN);

  /**
   * LA BOUCLE LOCALE EN CLAIR RESTE TOLÉRÉE — et seulement elle. En
   * développement tout se passe sur `localhost` ; ailleurs, une assertion qui
   * voyage en clair est une assertion lue.
   */
  const localVerdict = await returnUrls.validateReturnUrl('http://localhost:5174/retour', {
    projectId: PROJET_A,
  });
  check('http sur localhost passe le SCHÉMA (refusé seulement sur l’origine)',
    localVerdict.reasonCode === returnUrls.RETURN_URL_ERRORS.UNKNOWN_ORIGIN);
  const distantClair = await returnUrls.validateReturnUrl('http://manager.client.test/x', {
    projectId: PROJET_A,
  });
  check('…tandis qu’un http DISTANT est refusé sur le SCHÉMA, avant même l’origine',
    distantClair.reasonCode === returnUrls.RETURN_URL_ERRORS.INSECURE);

  /**
   * ENFIN : l'émission SANS adresse de retour reste possible. C'est le chemin
   * d'un opérateur qui demande une assertion depuis un outil, sans navigateur.
   */
  const sansRetour = await call('POST', `/api/federation/projects/${PROJET_A}/assertion`, {
    headers: AUTH, body: {},
  });
  check('une émission sans adresse de retour reste permise',
    sansRetour.status === 200 && sansRetour.json?.data?.returnUrl === null);
}

await close();
await stopMemoryMongo();
finish();
