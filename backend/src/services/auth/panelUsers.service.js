// Utilisateurs du Panel v1 — docs/architecture/04_AUTHENTICATION.md §2.
// Deux rôles (ADMIN, DEV superset), persistance MongoDB, mots de passe
// scrypt (crypto natif). Le RBAC complet attend la Phase 4+ et remplacera
// `role` sans toucher au reste.
import crypto from 'node:crypto';
import config from '../../config/env.js';
import { newBridgeId, nowIso } from '../../bridge/bridgeContract.js';
import PanelUser from '../../models/PanelUser.model.js';
import ApiError from '../../utils/ApiError.js';
import logger from '../../utils/logger.js';
import { PANEL_ROLES, PANEL_ROLE_VALUES, isPanelRole } from './panelRoles.js';

/**
 * LES RÔLES SONT RÉEXPORTÉS, PAS REDÉFINIS.
 *
 * `PANEL_ROLES` était déclaré ici, et une bonne moitié du backend l'importe de
 * ce module. La définition a déménagé dans `panelRoles.js` — qui porte aussi
 * l'ÉCHELLE, ce qu'un objet de constantes ne savait pas dire — mais l'adresse
 * historique reste valable : casser vingt imports pour un déplacement de
 * fichier n'apprend rien à personne.
 */
export { PANEL_ROLES, PANEL_ROLE_VALUES };
export const PANEL_PASSWORD_POLICY = Object.freeze({ minLength: 10 });

const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1 };

export function normalizePanelEmail(email) {
  return String(email ?? '').trim().toLowerCase();
}

export function assertPanelPasswordPolicy(password) {
  const value = String(password ?? '');
  if (value.length < PANEL_PASSWORD_POLICY.minLength) {
    throw new Error(`Mot de passe refusé : ${PANEL_PASSWORD_POLICY.minLength} caractères minimum.`);
  }
  return value;
}

export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const derived = crypto.scryptSync(String(password), salt, 32, SCRYPT_PARAMS);
  return `${salt.toString('hex')}.${derived.toString('hex')}`;
}

export function verifyPassword(password, stored) {
  const [saltHex, derivedHex] = String(stored).split('.');
  const derived = crypto.scryptSync(String(password), Buffer.from(saltHex, 'hex'), 32, SCRYPT_PARAMS);
  return crypto.timingSafeEqual(derived, Buffer.from(derivedHex, 'hex'));
}

/** Les modes d'accès aux projets. Voir `PanelUser.model.js` pour la doctrine. */
export const PROJECT_ACCESS_MODES = Object.freeze({
  NONE: 'NONE',
  EXPLICIT: 'EXPLICIT',
  ALL_PAIRED: 'ALL_PAIRED',
});

export async function createUser({ email, password, displayName, role }) {
  const normalized = normalizePanelEmail(email);
  const user = {
    userId: newBridgeId(),
    email: normalized,
    displayName: displayName ?? normalized,
    role,
    enabled: true,
    // Aucun accès projet à la création — même pour un DEV. L'accès est un ACTE.
    projectAccess: { mode: PROJECT_ACCESS_MODES.NONE, projectIds: [] },
    tokenVersion: 0,
    passwordHash: hashPassword(password),
    createdAt: nowIso(),
  };
  await PanelUser.create(user);
  return toPublicUser(user);
}

/**
 * UN MOT DE PASSE QUE PERSONNE NE CONNAÎT, PAS MÊME NOUS.
 *
 * ══ POURQUOI UN COMPTE CRÉÉ N'A PAS DE MOT DE PASSE CHOISI ══════════════════
 *
 * Un administrateur qui crée un compte ne doit jamais pouvoir se connecter à
 * la place de son titulaire. Les trois raccourcis habituels sont tous refusés
 * ici, et pour la même raison — ils font transiter un secret par un humain :
 *
 *   · mot de passe universel      il finit par être réutilisé partout ;
 *   · mot de passe temporaire     affiché, donc copié, donc conservé ;
 *   · mot de passe semé           écrit dans une configuration, donc versionné.
 *
 * On pose donc 48 octets aléatoires que personne ne lit, jamais rendus, jamais
 * journalisés. Le compte est réel, il est actif, et il est INACCESSIBLE tant
 * que son titulaire n'a pas pris possession par le lien d'activation — c'est-à-
 * dire par le parcours de réinitialisation, qui existe déjà et qui est éprouvé.
 *
 * ── POURQUOI PAS UN ÉTAT `PENDING_ACTIVATION` ───────────────────────────────
 *
 * Parce qu'il faudrait alors décider ce qu'un compte « en attente » a le droit
 * de faire, l'écrire dans chaque garde, et le tenir à jour. Or la réponse est
 * déjà portée par les faits : un compte dont personne ne connaît le mot de
 * passe ne se connecte pas. Ajouter un état parallèle créerait une seconde
 * vérité sur la même question — et deux vérités finissent par diverger.
 *
 * `passwordChangedAt` reste `null` : c'est le FAIT observable qui distingue un
 * compte pris en main d'un compte encore muet, et les écrans le lisent tel
 * quel. Ce n'est pas une garde, c'est une information.
 */
export async function createInvitedUser({ email, displayName, role }) {
  const normalized = normalizePanelEmail(email);
  if (!isPanelRole(role)) {
    throw new Error(`Rôle inconnu : « ${role} ».`);
  }
  const user = {
    userId: newBridgeId(),
    email: normalized,
    displayName: String(displayName ?? '').trim() || normalized,
    role,
    enabled: true,
    projectAccess: { mode: PROJECT_ACCESS_MODES.NONE, projectIds: [] },
    tokenVersion: 0,
    /** Inconnaissable. Aucun appelant ne le reçoit, aucun journal ne l'écrit. */
    passwordHash: hashPassword(crypto.randomBytes(48).toString('base64url')),
    passwordChangedAt: null,
    createdAt: nowIso(),
  };
  await PanelUser.create(user);
  return toPublicUser(user);
}

/**
 * BACKFILL des deux champs de L12.A — déterministe et idempotent.
 *
 * `enabled: true` sur les comptes antérieurs : ce sont des comptes en exercice,
 * et un défaut fermé les aurait tous verrouillés au déploiement.
 * `projectAccess: NONE` : personne n'a jamais eu d'accès fédéré, donc personne
 * n'en gagne un par migration.
 */
export async function backfillPanelUserAccess() {
  const enabled = await PanelUser.updateMany(
    { enabled: { $exists: false } },
    { $set: { enabled: true } },
  );
  const access = await PanelUser.updateMany(
    { projectAccess: { $exists: false } },
    { $set: { projectAccess: { mode: PROJECT_ACCESS_MODES.NONE, projectIds: [] } } },
  );
  const total = (enabled.modifiedCount ?? 0) + (access.modifiedCount ?? 0);
  if (total) logger.info(`[auth] ${total} champ(s) d’accès posé(s) sur des comptes antérieurs à L12.A.`);
  return { enabled: enabled.modifiedCount ?? 0, projectAccess: access.modifiedCount ?? 0 };
}

/**
 * ACTIVE ou DÉSACTIVE un compte.
 *
 * ── POURQUOI LES DEUX GESTES ENSEMBLE ───────────────────────────────────────
 *
 * Désactiver incrémente AUSSI `tokenVersion`. Sans cela, le compte ne pourrait
 * plus se reconnecter mais ses sessions ouvertes vivraient jusqu'à expiration —
 * or on désactive précisément quand on veut que ça s'arrête maintenant.
 *
 * Réactiver ne touche PAS `tokenVersion` : les sessions d'avant la désactivation
 * ne doivent pas ressusciter.
 */
export async function setUserEnabled(userId, enabled, actor = {}) {
  const update = enabled
    ? { $set: { enabled: true } }
    : { $set: { enabled: false }, $inc: { tokenVersion: 1 } };

  const user = await PanelUser.findOneAndUpdate({ userId }, update, { new: true }).lean();
  if (!user) return null;

  logger.info(
    `[auth] compte ${user.email} ${enabled ? 'réactivé' : 'DÉSACTIVÉ'}`
    + `${actor.userEmail ? ` par ${actor.userEmail}` : ''}.`,
  );
  return toPublicUser(user);
}

/**
 * Accorde ou retire l'accès aux projets. C'est le contrat explicite qu'exige la
 * fédération : sans lui, aucune assertion n'est émise, même pour un DEV actif.
 */
export async function setProjectAccess(userId, { mode, projectIds = [] }, actor = {}) {
  if (!Object.values(PROJECT_ACCESS_MODES).includes(mode)) {
    throw new Error(`Mode d’accès inconnu : « ${mode} ».`);
  }
  const user = await PanelUser.findOneAndUpdate(
    { userId },
    {
      $set: {
        projectAccess: {
          mode,
          // On ne conserve la liste QUE là où elle est lue : la garder en
          // ALL_PAIRED ferait croire à une restriction qui n'existe pas.
          projectIds: mode === PROJECT_ACCESS_MODES.EXPLICIT ? [...new Set(projectIds.map(String))] : [],
          grantedAt: nowIso(),
          grantedBy: actor.userId ?? null,
        },
      },
    },
    { new: true },
  ).lean();
  return user ? toPublicUser(user) : null;
}

/**
 * L'ÉCRITURE ADMINISTRATIVE — quatre champs, un seul geste, une seule trace.
 *
 * ══ POURQUOI UN `updateUserAdministration` ALORS QUE `updateUser` GÉNÉRIQUE
 *    EST EXPLICITEMENT REFUSÉ PLUS BAS ═══════════════════════════════════════
 *
 * La règle écrite dans `updateOwnProfile` — « pas de patch générique » — vise
 * un danger précis : qu'un jour un appelant transmette le corps d'une requête,
 * et que `role`, `enabled` ou `projectAccess` deviennent modifiables par leur
 * propriétaire. Elle ne dit pas qu'aucune fonction n'a le droit d'écrire
 * plusieurs champs ; elle dit que la SURFACE PERSONNELLE n'en a pas le droit.
 *
 * Ici, la surface est souveraine par construction : la route exige
 * `SUPER_ADMIN`. Le danger n'est donc plus la confusion des sujets, c'est la
 * DISPERSION — trois routes séparées pour trois champs, c'est trois
 * événements d'audit pour une seule décision d'un opérateur, et un état
 * intermédiaire observable entre deux d'entre elles.
 *
 * Les champs sont nommés un par un, et rien d'autre n'est lu : il n'y a pas de
 * `...patch` à déstructurer, donc rien à oublier de filtrer.
 *
 * ── CE QUE LE SERVEUR CALCULE, ET QUE L'APPELANT NE PEUT PAS PROPOSER ───────
 *
 * `grantedAt` et `grantedBy`. Les accepter du corps ferait d'une trace d'audit
 * une donnée déclarative — c'est-à-dire plus une trace du tout.
 *
 * @returns {Promise<{before: object, after: object, changes: object}|null>}
 */
export async function updateUserAdministration(userId, patch = {}, actor = {}) {
  const before = await PanelUser.findOne({ userId }).lean();
  if (!before) return null;

  const set = {};
  const changes = {};

  if (patch.displayName !== undefined) {
    const nom = String(patch.displayName).trim();
    if (nom.length < 2 || nom.length > 120) {
      throw ApiError.badRequest(
        'PANEL_USER_DISPLAY_NAME_INVALID',
        'Le nom affiché doit comporter entre 2 et 120 caractères.',
      );
    }
    if (nom !== before.displayName) {
      set.displayName = nom;
      changes.displayName = { before: before.displayName, after: nom };
    }
  }

  if (patch.role !== undefined) {
    if (!isPanelRole(patch.role)) {
      throw ApiError.badRequest('PANEL_USER_ROLE_UNKNOWN', `Rôle inconnu : « ${patch.role} ».`);
    }
    if (patch.role !== before.role) {
      set.role = patch.role;
      changes.role = { before: before.role, after: patch.role };
    }
  }

  if (patch.enabled !== undefined && Boolean(patch.enabled) !== (before.enabled !== false)) {
    set.enabled = Boolean(patch.enabled);
    changes.enabled = { before: before.enabled !== false, after: Boolean(patch.enabled) };
  }

  if (patch.projectAccess !== undefined) {
    const mode = patch.projectAccess.mode;
    if (!Object.values(PROJECT_ACCESS_MODES).includes(mode)) {
      throw new Error(`Mode d’accès inconnu : « ${mode} ».`);
    }
    set.projectAccess = {
      mode,
      // La liste n'est conservée QUE là où elle est lue. Voir `setProjectAccess`.
      projectIds: mode === PROJECT_ACCESS_MODES.EXPLICIT
        ? [...new Set((patch.projectAccess.projectIds ?? []).map(String))]
        : [],
      grantedAt: nowIso(),
      grantedBy: actor.userId ?? null,
    };
    changes.projectAccess = {
      before: {
        mode: before.projectAccess?.mode ?? PROJECT_ACCESS_MODES.NONE,
        projectIds: before.projectAccess?.projectIds ?? [],
      },
      after: { mode: set.projectAccess.mode, projectIds: set.projectAccess.projectIds },
    };
  }

  if (Object.keys(set).length === 0) {
    return { before, after: toPublicUser(before), changes };
  }

  /**
   * DÉSACTIVER COUPE LES SESSIONS — réactiver ne les ressuscite pas.
   *
   * Même geste que `setUserEnabled`, et pour la même raison : sans l'incrément,
   * le compte ne pourrait plus se reconnecter mais ses sessions ouvertes
   * vivraient jusqu'à expiration, or on désactive précisément quand on veut que
   * ça s'arrête maintenant.
   *
   * ── ET POURQUOI UN CHANGEMENT DE RÔLE N'INCRÉMENTE RIEN ────────────────────
   *
   * Parce que l'autorité relit le rôle en base à chaque requête
   * (`requirePanelUser`). Un compte rétrogradé perd ses droits à la requête
   * SUIVANTE, sans reconnexion — invalider sa session en plus le déconnecterait
   * pour rien, et lui ferait croire à une panne plutôt qu'à une décision.
   */
  const update = changes.enabled?.after === false
    ? { $set: set, $inc: { tokenVersion: 1 } }
    : { $set: set };

  const after = await PanelUser.findOneAndUpdate({ userId }, update, { new: true }).lean();
  if (!after) return null;

  logger.info(
    `[auth] compte ${after.email} modifié (${Object.keys(changes).join(', ') || 'aucun champ'})`
    + `${actor.userEmail ? ` par ${actor.userEmail}` : ''}.`,
  );
  return { before, after: toPublicUser(after), changes };
}

/**
 * SUPPRIME un compte du Panel — définitivement.
 *
 * ══ CE QUI DISPARAÎT, ET CE QUI RESTE ═══════════════════════════════════════
 *
 * Disparaît : le document `PanelUser`, donc le mot de passe, le rôle, l'état,
 * les accès projets. Conséquences immédiates et voulues — `requirePanelUser`
 * ne trouve plus le compte (401 à la requête suivante), l'émission d'assertion
 * refuse, et l'introspection répond `active: false`, ce qui ferme les sessions
 * projet ouvertes à leur prochaine revalidation.
 *
 * RESTE : tout le journal. Les événements portent `actorUserId` et
 * `targetEmail` en instantané — une chronologie qui perdrait ses acteurs à
 * chaque départ ne serait plus un journal d'audit, seulement une liste de
 * gestes anonymes. Aucun compte LOCAL d'aucun projet n'est touché : ils
 * n'appartiennent pas au Panel, et la fédération n'en a jamais créé.
 */
export async function deleteUser(userId) {
  const user = await PanelUser.findOne({ userId }).lean();
  if (!user) return null;
  await PanelUser.deleteOne({ userId });
  logger.info(`[auth] compte ${user.email} SUPPRIMÉ définitivement.`);
  return toPublicUser(user);
}

/**
 * LE COMPTE SOUVERAIN D'AMORÇAGE.
 *
 * Nommé ici, en clair, et c'est délibéré : ce n'est pas un secret, c'est une
 * DÉCISION d'exploitation. La cacher dans une variable d'environnement la
 * rendrait modifiable sans revue, et invisible à la lecture du code — pour une
 * information qui décide qui gouverne le Panel.
 */
export const SOVEREIGN_BOOTSTRAP_EMAIL = 'luca.duhoux@gmail.com';

/**
 * PROMEUT un compte EXISTANT au rôle souverain. Idempotent, et minimal.
 *
 * ══ CE QU'IL NE FAIT PAS, ET POURQUOI CHAQUE ABSENCE COMPTE ═════════════════
 *
 *   · IL NE CRÉE PAS DE COMPTE. Sur une base vierge, il n'y a personne à
 *     promouvoir — et fabriquer un compte souverain avec un mot de passe
 *     qu'il faudrait bien poser quelque part réintroduirait exactement le
 *     secret semé que la création par invitation existe pour supprimer.
 *
 *   · IL NE TOUCHE NI `passwordHash`, NI `projectAccess`, NI `enabled`. Une
 *     promotion est un changement de RÔLE. Un backfill qui en profiterait pour
 *     « remettre les choses en ordre » ferait des décisions que personne n'a
 *     prises.
 *
 *   · IL N'INCRÉMENTE PAS `tokenVersion`. L'autorité relit le rôle en base à
 *     chaque requête : la session en cours gagne le rôle sans se reconnecter.
 *     L'invalider serait déconnecter quelqu'un pour lui avoir donné plus.
 *
 * L'idempotence est portée par le FILTRE, pas par une lecture préalable :
 * `role: { $ne: SUPER_ADMIN }` ne modifie rien s'il l'est déjà, et deux
 * démarrages simultanés ne peuvent pas se marcher dessus.
 */
export async function promotePanelSuperAdmin(email = SOVEREIGN_BOOTSTRAP_EMAIL) {
  const normalized = normalizePanelEmail(email);
  const existing = await PanelUser.findOne({ email: normalized }).select('userId role').lean();
  if (!existing) {
    return { email: normalized, found: false, promoted: false, alreadySuperAdmin: false };
  }
  if (existing.role === PANEL_ROLES.SUPER_ADMIN) {
    return { email: normalized, found: true, promoted: false, alreadySuperAdmin: true };
  }

  const result = await PanelUser.updateOne(
    { email: normalized, role: { $ne: PANEL_ROLES.SUPER_ADMIN } },
    { $set: { role: PANEL_ROLES.SUPER_ADMIN } },
  );
  const promoted = (result.modifiedCount ?? 0) > 0;
  if (promoted) {
    logger.info(`[auth] ${normalized} promu SUPER_ADMIN (rôle souverain du Panel).`);
  }
  return { email: normalized, found: true, promoted, alreadySuperAdmin: false };
}

/**
 * L'AMORÇAGE DES COMPTES — tout ce qui doit être vrai à chaque démarrage.
 *
 * Regroupé ici pour une raison simple : `backfillPanelUserAccess()` existait
 * depuis L12.A et n'était appelé PAR AUCUN démarrage — seulement par sa suite
 * de tests. Un backfill que rien n'exécute est un backfill qui n'a pas eu lieu.
 * Les deux gestes sont idempotents et sans effet sur une base déjà à jour.
 */
export async function bootstrapPanelAccounts() {
  const access = await backfillPanelUserAccess();
  const sovereign = await promotePanelSuperAdmin();
  return { access, sovereign };
}

/**
 * UN COMPTE DÉSACTIVÉ NE S'AUTHENTIFIE PAS — et le refus est indistinguable
 * d'un mauvais mot de passe.
 *
 * Rendre `null` plutôt qu'une erreur nommée est délibéré : « ce compte est
 * désactivé » est une information sur l'existence d'un compte, et un écran de
 * connexion ne doit pas en donner. Le journal, lui, sait faire la différence.
 */
function usable(user) {
  return Boolean(user) && user.enabled !== false;
}

export async function authenticate(email, password) {
  const user = await PanelUser.findOne({ email: normalizePanelEmail(email) }).lean();
  if (!usable(user)) return null;
  if (!verifyPassword(password, user.passwordHash)) return null;
  return toPublicUser(user);
}

export async function authenticateForSession(email, password) {
  const user = await PanelUser.findOne({ email: normalizePanelEmail(email) }).lean();
  if (!usable(user)) return null;
  if (!verifyPassword(password, user.passwordHash)) return null;
  return { ...toPublicUser(user), tokenVersion: user.tokenVersion ?? 0 };
}

export async function getStoredUserById(userId) {
  return PanelUser.findOne({ userId }).lean();
}

export async function getUserById(userId) {
  const user = await getStoredUserById(userId);
  return user ? toPublicUser(user) : null;
}

export function toPublicUser(user) {
  return {
    userId: user.userId,
    email: user.email,
    displayName: user.displayName,
    role: user.role,
    /**
     * `!== false` et non `?? true` : un document antérieur au backfill n'a pas
     * le champ, et il décrit un compte en exercice. Écrire `Boolean(enabled)`
     * l'aurait désactivé silencieusement.
     */
    enabled: user.enabled !== false,
    projectAccess: {
      mode: user.projectAccess?.mode ?? PROJECT_ACCESS_MODES.NONE,
      projectIds: user.projectAccess?.projectIds ?? [],
    },
  };
}

// Compte DEV seed — créé uniquement si AUCUN utilisateur n'existe (jamais
// d'écrasement d'un compte réel). Les règles de robustesse PROD sont
// appliquées en amont par config/env.js (fail-closed au démarrage).
export async function seedFromEnv() {
  if (await PanelUser.exists({})) return;
  if (!config.seedDevEmail || !config.seedDevPassword) {
    logger.warn('Aucun compte seed configuré (SEED_DEV_EMAIL/PASSWORD) : connexion impossible.');
    return;
  }
  await createUser({
    email: config.seedDevEmail,
    password: config.seedDevPassword,
    displayName: 'Développeur',
    role: PANEL_ROLES.DEV,
  });

  // Le journal doit permettre de se connecter sans lire le code. En TEST
  // avec le repli, on affiche l'adresse ET le mot de passe : il est public,
  // il figure dans ce dépôt, le masquer n'aurait aucune valeur de sécurité
  // et coûterait l'usage. Avec un mot de passe fourni, on ne l'affiche pas.
  if (config.seedDevIsDefault) {
    logger.warn(
      `Compte DEV de développement créé — ${config.seedDevEmail} / ${config.seedDevPassword}. `
      + 'Identifiants PUBLICS, valables en ENV=TEST uniquement. '
      + 'Définissez SEED_DEV_EMAIL et SEED_DEV_PASSWORD pour les vôtres.',
    );
  } else {
    logger.info(`Compte DEV créé : ${config.seedDevEmail} (mot de passe : SEED_DEV_PASSWORD).`);
  }
}

/**
 * CRÉE OU RÉINITIALISE le compte de développement — TEST uniquement.
 *
 * `seedFromEnv()` ne s'exécute que sur une base VIERGE : c'est ce qui
 * garantit qu'il n'écrase jamais un compte réel. La contrepartie est qu'un
 * développeur ayant oublié son mot de passe se retrouve enfermé dehors,
 * avec pour seule issue de vider la collection à la main.
 *
 * Cette fonction est cette issue, rendue explicite et bornée : elle refuse
 * de s'exécuter en PROD, où réinitialiser un mot de passe par une commande
 * locale serait une porte dérobée.
 */
export async function ensureDevAccount({ email, password } = {}) {
  if (config.isProd) {
    throw new Error(
      'Réinitialisation refusée parce que ENV=PROD : cette commande est réservée au développement.',
    );
  }
  const targetEmail = String(email ?? config.seedDevEmail ?? '').trim().toLowerCase();
  const targetPassword = password ?? config.seedDevPassword;
  if (!targetEmail || !targetPassword) {
    throw new Error(
      'Réinitialisation impossible parce qu’aucun identifiant n’est disponible : '
      + 'renseignez SEED_DEV_EMAIL et SEED_DEV_PASSWORD, ou passez-les en arguments.',
    );
  }

  const existing = await PanelUser.findOne({ email: targetEmail }).lean();
  if (existing) {
    await PanelUser.updateOne(
      { email: targetEmail },
      {
        $set: {
          passwordHash: hashPassword(targetPassword),
          role: PANEL_ROLES.DEV,
          passwordChangedAt: nowIso(),
        },
        $inc: { tokenVersion: 1 },
        $unset: {
          passwordResetRequestId: '',
          passwordResetTokenHash: '',
          passwordResetExpiresAt: '',
          passwordResetRequestedAt: '',
        },
      },
    );
    return { email: targetEmail, created: false, reset: true };
  }
  await createUser({
    email: targetEmail,
    password: targetPassword,
    displayName: 'Développeur',
    role: PANEL_ROLES.DEV,
  });
  return { email: targetEmail, created: true, reset: false };
}

/**
 * LE TROMBINOSCOPE DES COMPTES PANEL — pour l'écran d'administration (L12.B-F).
 *
 * ── CE QU'IL NE REND PAS ────────────────────────────────────────────────────
 *
 * Ni `passwordHash`, ni les champs de réinitialisation, ni `tokenVersion`. Le
 * premier est un secret ; les deuxièmes en sont l'antichambre ; le troisième
 * est un compteur interne qu'un écran ne saurait qu'afficher sans le
 * comprendre, et qu'un opérateur finirait par vouloir « remettre à zéro ».
 *
 * `toPublicUser` est déjà cette projection sûre : on la réutilise plutôt que
 * d'en écrire une seconde, qui divergerait.
 */
export async function listUsers() {
  const users = await PanelUser.find({}).sort({ role: 1, email: 1 }).lean();
  return users.map((user) => ({
    ...toPublicUser(user),
    createdAt: user.createdAt,
    /**
     * Un FAIT daté, utile à l'exploitation : « ce compte a-t-il déjà changé son
     * mot de passe ? ». Ce n'est pas un secret, et son absence est parlante.
     */
    passwordChangedAt: user.passwordChangedAt ?? null,
    /**
     * LE COMPTE A-T-IL ÉTÉ PRIS EN MAIN ?
     *
     * Dérivé, jamais stocké : un compte créé par invitation porte un mot de
     * passe que personne ne connaît, et `passwordChangedAt` reste `null` tant
     * que son titulaire n'a pas suivi le lien d'activation. Le FAIT répond
     * donc déjà à la question, et un second champ à tenir à jour finirait par
     * le contredire.
     *
     * Ce n'est PAS une garde — rien ne s'appuie dessus pour autoriser quoi que
     * ce soit. C'est une information d'écran : « cette personne n'est jamais
     * venue, faut-il lui renvoyer son invitation ? ».
     */
    activated: Boolean(user.passwordChangedAt),
    grantedAt: user.projectAccess?.grantedAt ?? null,
    grantedBy: user.projectAccess?.grantedBy ?? null,
  }));
}

/**
 * MODIFIE SON PROPRE PROFIL — et rien d'autre (L12.C).
 *
 * ══ POURQUOI UNE FONCTION SÉPARÉE, ET NON UN `updateUser` GÉNÉRIQUE ═════════
 *
 * Un `updateUser(userId, patch)` serait la porte ouverte : il suffirait qu'un
 * jour un appelant lui transmette le corps d'une requête pour que `role`,
 * `enabled` ou `projectAccess` deviennent modifiables par leur propriétaire.
 * La garde ne serait alors plus dans le modèle mais dans la vigilance de
 * chaque appelant — c'est-à-dire nulle part.
 *
 * Cette fonction ne sait écrire QU'UN champ. Il n'y a pas de patch à
 * déstructurer, donc rien à oublier de filtrer.
 *
 * ══ POURQUOI `displayName` SEUL ════════════════════════════════════════════
 *
 * C'est le seul champ de `PanelUser` qui soit à la fois personnel et sans
 * conséquence :
 *
 *   `email`        identifiant de connexion — le changer sans procédure de
 *                  vérification ferait perdre son compte à qui se trompe de
 *                  frappe. Aucune telle procédure n'existe (cf. rapport).
 *   `role`         un privilège.
 *   `enabled`      un privilège.
 *   `projectAccess` un privilège CHEZ UN CLIENT.
 *   `tokenVersion` un compteur de révocation, pas une préférence.
 *   `passwordHash` se change par le parcours de réinitialisation, jamais ici.
 */
export async function updateOwnProfile(userId, { displayName }) {
  const nom = String(displayName ?? '').trim();
  if (nom.length < 2 || nom.length > 120) {
    throw ApiError.badRequest(
      'PANEL_USER_DISPLAY_NAME_INVALID',
      'Le nom affiché doit comporter entre 2 et 120 caractères.',
    );
  }

  const user = await PanelUser.findOneAndUpdate(
    { userId },
    { $set: { displayName: nom } },
    { new: true },
  ).lean();
  if (!user) return null;

  // On NOMME le compte, jamais son contenu sensible.
  logger.info(`[auth] ${user.email} a modifié son nom affiché.`);
  return toPublicUser(user);
}

export async function resetUsers() {
  await PanelUser.deleteMany({});
}
