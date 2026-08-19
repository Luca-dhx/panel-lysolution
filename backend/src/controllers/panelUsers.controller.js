// L'ADMINISTRATION DES COMPTES PANEL (L12.B-F, L12.C, LOT SUPER_ADMIN).
//
// docs/auth/PANEL_FEDERATED_DEV_IDENTITY_IMPLEMENTATION.md §« PROJECT ACCESS UI ».
//
// ══ POURQUOI CETTE SURFACE N'EXISTAIT PAS ═══════════════════════════════════
//
// Jusqu'ici, un compte Panel se créait par un script (`dev-account.js`) ou par
// l'amorçage. C'était tenable tant que « avoir un compte » était la seule
// chose qu'on pouvait décider à son sujet.
//
// La fédération a changé cela : un compte porte désormais un ACCÈS AUX PROJETS
// D'AUTRUI. Le lot SUPER_ADMIN va au bout : un compte se CRÉE, se MODIFIE et se
// SUPPRIME depuis le Panel. Un parc dont les identités ne s'administrent qu'en
// base est un parc dont personne ne peut répondre à « qui a accès à quoi ».
//
// ══ QUI PEUT QUOI — ET POURQUOI CE DÉPLACEMENT ══════════════════════════════
//
//   TOUT COMPTE   son propre profil (`/me`), et rien d'autre.
//   DEV           LIT l'annuaire (`GET /`, `GET /projects`). N'écrit rien.
//   SUPER_ADMIN   tout. Création, rôle, activation, accès projets, suppression,
//                 sur n'importe quelle cible — y compris un autre SUPER_ADMIN,
//                 y compris lui-même.
//
// ── CE QUE DEV A PERDU, ET POURQUOI CE N'EST PAS UNE RÉGRESSION ─────────────
//
// Un DEV pouvait activer/désactiver un compte et accorder un accès projet. La
// garde qui rendait cela acceptable était `PANEL_USER_SELF_GRANT` : « on ne
// s'accorde rien à soi-même, demandez à un collègue ». Elle fonctionnait, mais
// elle reposait sur une hypothèse fragile — que tout DEV soit également
// légitime à décider qui entre chez quel client.
//
// Avec un rôle souverain explicite, cette hypothèse n'a plus lieu d'être :
// l'autorisation d'entrer chez un client est une décision de gouvernance, pas
// une opération de développement. DEV garde tout ce dont le développement a
// besoin — les surfaces techniques, et l'accès aux projets qu'on lui a
// accordés. Il ne garde pas le pouvoir de se le faire accorder par un pair.
//
// Conséquence directe : la garde `PANEL_USER_SELF_GRANT` n'a plus de sujet.
// Elle est remplacée par une règle plus forte — seul SUPER_ADMIN écrit, et
// pour lui l'auto-attribution est EXPLICITEMENT permise (voir plus bas).
import { z } from 'zod';

import { ok } from '../utils/apiResponse.js';
import ApiError from '../utils/ApiError.js';
import {
  PANEL_ROLE_VALUES,
  PROJECT_ACCESS_MODES,
  createInvitedUser,
  deleteUser,
  getUserById,
  listUsers,
  normalizePanelEmail,
  updateUserAdministration,
} from '../services/auth/panelUsers.service.js';
import { requestPasswordReset } from '../services/auth/panelPasswordReset.service.js';
import { recordEvent, EVENT_TYPES } from '../services/supervision/timeline.service.js';
import PanelProject from '../models/PanelProject.model.js';
import PanelUser from '../models/PanelUser.model.js';

/** `GET /api/panel-users` */
export async function listPanelUsers(_req, res) {
  return ok(res, await listUsers());
}

/* ══════════════════════════════════════════════════════════════════════════
   SON PROPRE PROFIL — une surface DISTINCTE, et c'est tout l'enjeu (L12.C).

   ══ TROIS DROITS, ET ILS NE SE CONFONDENT PAS ═══════════════════════════════

     SELF_PROFILE_WRITE          modifier SES données personnelles
     PANEL_USER_ADMIN_WRITE      administrer un compte — SUPER_ADMIN seul
     PROJECT_ACCESS_ADMIN_WRITE  accorder un accès CHEZ UN CLIENT — idem

   Tout compte possède le premier sur lui-même. C'est pour cela que `/me` ne
   réutilise PAS `PATCH /:userId` : faire dépendre l'édition personnelle des
   routes d'administration obligerait à les ouvrir à leur propre cible.

   Un SUPER_ADMIN, lui, possède les trois. Il édite donc son nom par `/me` OU
   par la surface d'administration — même donnée, deux chemins, aucune
   duplication de formulaire à l'écran (voir `PanelUsersPage`).

   ══ L'IDENTITÉ VIENT DE LA SESSION, JAMAIS DE L'URL ═════════════════════════

   Il n'y a pas de `:userId` dans ces chemins. `req.panelUser.userId` est le
   seul sujet possible : aucun paramètre ne permet d'en désigner un autre.
   ══════════════════════════════════════════════════════════════════════════ */

/**
 * `GET /api/panel-users/me`
 *
 * Ouverte à TOUT compte du Panel, ADMIN compris : consulter son propre profil
 * n'est pas une opération technique. Seule l'administration l'est.
 */
export async function getOwnProfile(req, res) {
  const user = await getUserById(req.panelUser.userId);
  if (!user) throw ApiError.notFound('PANEL_USER_UNKNOWN', 'Compte introuvable.');

  /**
   * LES PROJETS SONT NOMMÉS, PAS SEULEMENT LISTÉS.
   *
   * L'écran doit pouvoir écrire « Demo SB Auto » plutôt qu'un UUID. Résoudre
   * les noms ici évite que l'écran ait besoin de la liste complète du parc —
   * qu'il n'a pas le droit de lire s'il n'est pas développeur.
   */
  const ids = user.projectAccess?.projectIds ?? [];
  const projets = ids.length
    ? await PanelProject.find({ projectId: { $in: ids } }).select('projectId projectName').lean()
    : [];

  return ok(res, {
    ...user,
    projectAccess: {
      ...user.projectAccess,
      /** Uniquement pour l'affichage — la portée reste portée par les IDs. */
      projects: ids.map((id) => ({
        projectId: id,
        projectName: projets.find((p) => p.projectId === id)?.projectName ?? id,
      })),
    },
  });
}

/** Le SEUL champ qu'un compte peut modifier sur lui-même. Voir le service. */
const ownProfileInput = z.object({
  displayName: z.string().trim().min(2).max(120),
}).strict();

/**
 * `PATCH /api/panel-users/me`
 *
 * `strict()` fait ici tout le travail de la doctrine : un corps portant `role`,
 * `enabled`, `projectAccess` ou `tokenVersion` est REFUSÉ — pas ignoré. Un
 * champ ignoré en silence laisse l'appelant croire qu'il a agi, et invite le
 * prochain développeur à le brancher « puisqu'il était déjà envoyé ».
 *
 * Y compris pour un SUPER_ADMIN : cette route-ci est la surface PERSONNELLE,
 * et elle reste étroite pour tout le monde. Sa souveraineté s'exerce sur la
 * surface d'administration, où l'acte est journalisé comme tel.
 */
export async function patchOwnProfile(req, res) {
  const parsed = ownProfileInput.safeParse(req.body ?? {});
  if (!parsed.success) {
    const champs = parsed.error.issues
      .filter((issue) => issue.code === 'unrecognized_keys')
      .flatMap((issue) => issue.keys ?? []);

    throw ApiError.badRequest(
      champs.length ? 'PANEL_USER_SELF_FORBIDDEN_FIELD' : 'PANEL_USER_INPUT_INVALID',
      champs.length
        ? `Ces champs ne se modifient pas depuis votre profil : ${champs.join(', ')}. `
          + 'Les privilèges sont accordés depuis l’administration des comptes.'
        : 'Nom affiché invalide (2 à 120 caractères).',
    );
  }

  const resultat = await updateUserAdministration(
    req.panelUser.userId,
    { displayName: parsed.data.displayName },
    { userId: req.panelUser.userId, userEmail: req.panelUser.email },
  );
  if (!resultat) throw ApiError.notFound('PANEL_USER_UNKNOWN', 'Compte introuvable.');

  /**
   * OBSERVABILITÉ — l'acteur et la cible sont le même compte, et c'est
   * précisément ce qui distingue cet événement d'une administration.
   *
   * Aucun mot de passe, aucun jeton : seul le champ touché est nommé.
   */
  await recordEvent({
    projectId: null,
    type: EVENT_TYPES.PANEL_USER_PROFILE_UPDATED,
    source: 'PANEL',
    severity: 'INFO',
    summary: `${resultat.after.email} a modifié son profil.`,
    data: {
      actorUserId: req.panelUser.userId,
      targetUserId: resultat.after.userId,
      fields: Object.keys(parsed.data),
    },
  }).catch(() => {});

  return ok(res, resultat.after);
}

/**
 * LES PROJETS SÉLECTIONNABLES — et pourquoi cette liste est côté serveur.
 *
 * L'écran doit proposer des cases à cocher. S'il construisait la liste
 * lui-même, il pourrait proposer un projet révoqué — et l'opérateur croirait
 * avoir accordé un accès qui ne s'ouvrira jamais. Le serveur dit donc quels
 * projets sont RÉELLEMENT éligibles, avec leur statut d'appairage à l'appui.
 */
export async function listAccessibleProjects(_req, res) {
  const projects = await PanelProject
    .find({})
    .select('projectId projectName pairing.status runtime.environment')
    .sort({ projectName: 1 })
    .lean();

  return ok(res, projects.map((project) => ({
    projectId: project.projectId,
    projectName: project.projectName || project.projectId,
    pairingStatus: project.pairing?.status ?? null,
    environment: project.runtime?.environment ?? null,
    /**
     * SÉLECTIONNABLE ⇔ APPAIRÉ. Un projet `DECLARED` n'a pas encore de pont,
     * un `REVOKED` n'en a plus : l'émission d'assertion les refuse tous deux.
     * Les proposer à la sélection ferait cocher une case sans effet.
     */
    selectable: project.pairing?.status === 'PAIRED',
  })));
}

/* ══════════════════════════════════════════════════════════════════════════
   L'ADMINISTRATION — SUPER_ADMIN uniquement, sans exception de cible.
   ══════════════════════════════════════════════════════════════════════════ */

const projectAccessInput = z.object({
  mode: z.enum([
    PROJECT_ACCESS_MODES.NONE,
    PROJECT_ACCESS_MODES.EXPLICIT,
    PROJECT_ACCESS_MODES.ALL_PAIRED,
  ]),
  /**
   * FACULTATIF, et lu UNIQUEMENT en mode EXPLICIT. Le service l'écarte de
   * lui-même dans les deux autres modes : conserver une liste en `ALL_PAIRED`
   * ferait croire à une restriction qui n'existe pas.
   */
  projectIds: z.array(z.string().trim().min(1)).max(500).optional(),
}).strict();

/**
 * LES CHAMPS QU'UN ADMINISTRATEUR PEUT ÉCRIRE — et la liste est FERMÉE.
 *
 * ── CE QUE `.strict()` REFUSE, ET POURQUOI CHAQUE REFUS COMPTE ──────────────
 *
 *   `passwordHash`   un secret ne se pose pas par une API d'administration ;
 *   `tokenVersion`   un compteur de révocation, pas une préférence ;
 *   `userId`         l'identité d'un document ne se réécrit pas ;
 *   `createdAt`      un fait daté ne se corrige pas ;
 *   `email`          identifiant de connexion — le changer sans procédure de
 *                    vérification ferait perdre son compte à qui se trompe de
 *                    frappe. Aucune telle procédure n'existe : le champ est
 *                    donc en LECTURE SEULE, et l'écran le dit ;
 *   `grantedAt/By`   calculés par le serveur. Les accepter du corps ferait
 *                    d'une trace d'audit une donnée déclarative.
 *
 * `.strict()` REFUSE au lieu d'ignorer : un champ ignoré en silence laisse
 * l'appelant croire qu'il a agi.
 */
const administrationInput = z.object({
  displayName: z.string().trim().min(2).max(120).optional(),
  role: z.enum([...PANEL_ROLE_VALUES]).optional(),
  enabled: z.boolean().optional(),
  projectAccess: projectAccessInput.optional(),
}).strict();

const creationInput = z.object({
  email: z.string().trim().min(3).max(254).email(),
  displayName: z.string().trim().min(2).max(120),
  role: z.enum([...PANEL_ROLE_VALUES]),
}).strict();

function inputRefuse(parsed, fallback) {
  const champs = parsed.error.issues
    .filter((issue) => issue.code === 'unrecognized_keys')
    .flatMap((issue) => issue.keys ?? []);
  return ApiError.badRequest(
    champs.length ? 'PANEL_USER_FORBIDDEN_FIELD' : 'PANEL_USER_INPUT_INVALID',
    champs.length
      ? `Ces champs ne s’administrent pas : ${champs.join(', ')}.`
      : fallback,
    { issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), code: i.code })) },
  );
}

/**
 * LES IDENTIFIANTS DE PROJET SONT VÉRIFIÉS CONTRE LE REGISTRE, UN PAR UN.
 *
 * Le frontend n'est jamais l'autorité : un identifiant inconnu, mal formé ou
 * révoqué doit être refusé ICI. Accepter un projet inexistant créerait un accès
 * que rien n'ouvrira jamais — et personne ne comprendrait pourquoi la connexion
 * échoue, puisque l'écran, lui, montrerait une case cochée.
 */
async function validerProjets(projectAccess) {
  if (projectAccess.mode !== PROJECT_ACCESS_MODES.EXPLICIT) return [];

  const demandes = [...new Set((projectAccess.projectIds ?? []).map(String))];
  if (demandes.length === 0) {
    throw ApiError.badRequest(
      'PANEL_USER_ACCESS_EMPTY',
      'Le mode « projets sélectionnés » exige au moins un projet. Choisissez « aucun accès » pour tout retirer.',
    );
  }

  const connus = await PanelProject
    .find({ projectId: { $in: demandes } })
    .select('projectId pairing.status')
    .lean();

  const inconnus = demandes.filter((id) => !connus.some((p) => p.projectId === id));
  if (inconnus.length) {
    throw ApiError.badRequest(
      'PANEL_USER_ACCESS_PROJECT_UNKNOWN',
      `Projet(s) inconnu(s) : ${inconnus.join(', ')}.`,
    );
  }

  /**
   * UN PROJET NON APPAIRÉ N'EST PAS SÉLECTIONNABLE.
   *
   * L'émission d'assertion le refuserait de toute façon. Le refuser ici est
   * plus honnête : l'opérateur apprend tout de suite que ce projet ne peut pas
   * recevoir d'accès, plutôt que de le découvrir à la première tentative de
   * connexion d'un développeur.
   */
  const nonAppaires = connus.filter((p) => p.pairing?.status !== 'PAIRED');
  if (nonAppaires.length) {
    throw ApiError.badRequest(
      'PANEL_USER_ACCESS_PROJECT_NOT_PAIRED',
      `Projet(s) non appairé(s), donc inaccessible(s) : ${nonAppaires.map((p) => p.projectId).join(', ')}.`,
    );
  }

  return demandes;
}

/** L'acteur, tel qu'il apparaîtra au journal. Jamais plus que ces deux champs. */
function acteurDe(req) {
  return { userId: req.panelUser.userId, userEmail: req.panelUser.email };
}

async function journaliser(type, { req, cible, summary, data }) {
  await recordEvent({
    projectId: null,
    type,
    source: 'PANEL',
    severity: type === EVENT_TYPES.PANEL_USER_DELETED ? 'WARNING' : 'INFO',
    summary,
    data: {
      actorUserId: req.panelUser.userId,
      actorEmail: req.panelUser.email,
      targetUserId: cible.userId,
      /**
       * L'ADRESSE EN INSTANTANÉ — pour que le journal survive au compte.
       *
       * Un événement qui ne porterait qu'un `targetUserId` deviendrait
       * illisible à la seconde où le compte est supprimé : plus rien ne
       * permettrait de dire de qui il parlait. On fige donc l'adresse et le
       * nom au moment de l'acte. Ce ne sont pas des secrets, et c'est la
       * seule chose qui rend une chronologie d'identités exploitable.
       */
      targetEmail: cible.email,
      targetDisplayName: cible.displayName,
      ...data,
    },
  }).catch(() => {});
}

/**
 * `POST /api/panel-users` — CRÉER UN COMPTE.
 *
 * ══ AUCUN MOT DE PASSE N'EST DEMANDÉ, NI RENDU, NI AFFICHÉ ══════════════════
 *
 * Le compte naît avec un secret aléatoire que personne ne lit (voir
 * `createInvitedUser`), puis on déclenche le parcours de réinitialisation
 * EXISTANT — jeton aléatoire, empreinte en base, TTL 30 minutes, usage unique,
 * e-mail par la passerelle de capacités, page de choix du mot de passe avec
 * double saisie. Le titulaire prend possession de son compte sans que
 * l'administrateur ait jamais connu son mot de passe.
 *
 * ── POURQUOI RÉUTILISER LA RÉINITIALISATION PLUTÔT QU'UN FLUX D'INVITATION ──
 *
 * Parce qu'un second parcours de prise de possession serait un second endroit
 * où se tromper sur la durée de vie d'un jeton, sur son unicité, sur son
 * hachage. Le parcours existant est éprouvé par sa propre suite ; un clone
 * « pour l'invitation » divergerait au premier correctif appliqué à un seul
 * des deux.
 *
 * ── L'ENVOI PEUT ÉCHOUER SANS ANNULER LA CRÉATION ───────────────────────────
 *
 * Le compte est créé d'abord. Si l'e-mail ne part pas — passerelle muette,
 * URL frontend absente, quota fournisseur — la réponse le DIT, et
 * l'administrateur peut relancer l'invitation. Annuler la création rendrait
 * l'opération dépendante d'un tiers, et laisserait l'écran sans rien à montrer.
 */
export async function postPanelUser(req, res) {
  const parsed = creationInput.safeParse(req.body ?? {});
  if (!parsed.success) throw inputRefuse(parsed, 'Nom, adresse e-mail ou rôle invalide.');

  const email = normalizePanelEmail(parsed.data.email);
  const existant = await PanelUser.findOne({ email }).select('userId').lean();
  if (existant) {
    throw ApiError.conflict(
      'PANEL_USER_EMAIL_TAKEN',
      'Un compte utilise déjà cette adresse e-mail.',
    );
  }

  const cree = await createInvitedUser({
    email,
    displayName: parsed.data.displayName,
    role: parsed.data.role,
  });

  await journaliser(EVENT_TYPES.PANEL_USER_CREATED, {
    req,
    cible: cree,
    summary: `Compte ${cree.email} créé avec le rôle ${cree.role}.`,
    data: { role: cree.role },
  });

  const invitation = await envoyerInvitation({ req, email });
  return ok(res, { ...cree, activated: false, invitation });
}

/**
 * `POST /api/panel-users/:userId/invitation` — (RE)ENVOYER le lien d'activation.
 *
 * Le même geste que « mot de passe oublié », déclenché par un administrateur.
 * Il n'apprend rien à l'administrateur : la réponse ne dit que si l'envoi a été
 * ACCEPTÉ, jamais le jeton, jamais le lien.
 */
export async function postPanelUserInvitation(req, res) {
  const cible = await getUserById(req.params.userId);
  if (!cible) throw ApiError.notFound('PANEL_USER_UNKNOWN', 'Compte introuvable.');

  const invitation = await envoyerInvitation({ req, email: cible.email });
  return ok(res, { userId: cible.userId, email: cible.email, invitation });
}

async function envoyerInvitation({ req, email }) {
  try {
    await requestPasswordReset({ email, ip: req.ip ?? '', actor: acteurDe(req) });
    return { sent: true, code: null };
  } catch (error) {
    /**
     * L'ÉCHEC EST NOMMÉ, PAS AVALÉ.
     *
     * Un « compte créé » qui tairait l'absence d'e-mail laisserait
     * l'administrateur attendre une activation qui n'arrivera jamais. Le code
     * est celui de la passerelle — jamais un message brut de fournisseur, qui
     * pourrait porter une adresse ou une clé.
     */
    return { sent: false, code: error?.code ?? 'PANEL_INVITATION_NOT_SENT' };
  }
}

/**
 * `PATCH /api/panel-users/:userId` — MODIFIER UN COMPTE.
 *
 * ══ AUCUNE PROTECTION DE CIBLE, ET C'EST UNE DÉCISION ═══════════════════════
 *
 * Un SUPER_ADMIN modifie un autre SUPER_ADMIN. Il se modifie lui-même. Il peut
 * se retirer son propre rôle souverain, ou se désactiver. Aucune garde du type
 * « il doit rester un Super Admin » n'est posée.
 *
 * Ce choix se défend : une garde de ce genre protège d'une maladresse et
 * empêche une décision légitime — céder la souveraineté, fermer un compte de
 * transition. Elle donne surtout une fausse assurance, car elle ne couvre pas
 * les autres façons de perdre l'accès (base restaurée, e-mail perdu). La
 * protection réelle est ailleurs : une confirmation explicite à l'écran, qui
 * NOMME la conséquence.
 *
 * Conséquences assumées, et vérifiées par la suite :
 *   · se rétrograder      → la requête SUIVANTE est refusée sur les surfaces
 *                           souveraines. Pas de reconnexion, pas de session
 *                           cassée : l'autorité relit le rôle en base.
 *   · se désactiver       → `tokenVersion` incrémenté, session coupée
 *                           immédiatement, reconnexion impossible.
 *   · retirer le dernier  → le Panel peut se retrouver sans SUPER_ADMIN. Aucun
 *     SUPER_ADMIN            écran ne le rouvrira ; il faudra une promotion en
 *                            base ou un redémarrage avec le compte d'amorçage.
 */
export async function patchPanelUser(req, res) {
  const parsed = administrationInput.safeParse(req.body ?? {});
  if (!parsed.success) throw inputRefuse(parsed, 'Entrée d’administration non conforme.');
  if (Object.keys(parsed.data).length === 0) {
    throw ApiError.badRequest('PANEL_USER_INPUT_EMPTY', 'Aucun champ à modifier.');
  }

  const cible = await getUserById(req.params.userId);
  if (!cible) throw ApiError.notFound('PANEL_USER_UNKNOWN', 'Compte introuvable.');

  const patch = { ...parsed.data };
  if (patch.projectAccess) {
    patch.projectAccess = {
      mode: patch.projectAccess.mode,
      projectIds: await validerProjets(patch.projectAccess),
    };
  }

  const resultat = await updateUserAdministration(cible.userId, patch, acteurDe(req));
  if (!resultat) throw ApiError.notFound('PANEL_USER_UNKNOWN', 'Compte introuvable.');

  const { changes, after } = resultat;

  /**
   * UN ÉVÉNEMENT PAR NATURE DE CHANGEMENT, ET NON UN SEUL FOURRE-TOUT.
   *
   * « Qui a promu qui » et « qui a ouvert quel client à qui » sont deux
   * questions d'enquête différentes, et un exploitant doit pouvoir filtrer sur
   * l'une sans lire le contenu de l'autre. Le `PANEL_USER_UPDATED` générique
   * reste pour les modifications de forme — un nom corrigé.
   */
  if (changes.role) {
    await journaliser(EVENT_TYPES.PANEL_USER_ROLE_CHANGED, {
      req,
      cible: after,
      summary: `Rôle de ${after.email} : ${changes.role.before} → ${changes.role.after}.`,
      data: { before: changes.role.before, after: changes.role.after },
    });
  }
  if (changes.enabled) {
    await journaliser(EVENT_TYPES.PANEL_USER_ENABLED_CHANGED, {
      req,
      cible: after,
      summary: `Compte ${after.email} ${changes.enabled.after ? 'réactivé' : 'DÉSACTIVÉ'}.`,
      data: { before: changes.enabled.before, after: changes.enabled.after },
    });
  }
  if (changes.projectAccess) {
    await journaliser(EVENT_TYPES.PANEL_USER_PROJECT_ACCESS_CHANGED, {
      req,
      cible: after,
      summary: `Accès projets de ${after.email} : ${changes.projectAccess.before.mode}`
        + ` → ${changes.projectAccess.after.mode}.`,
      data: {
        before: changes.projectAccess.before,
        after: changes.projectAccess.after,
        selfGrant: after.userId === req.panelUser.userId,
      },
    });
  }
  if (changes.displayName) {
    await journaliser(EVENT_TYPES.PANEL_USER_UPDATED, {
      req,
      cible: after,
      summary: `Nom affiché de ${after.email} modifié.`,
      data: { fields: ['displayName'] },
    });
  }

  return ok(res, { ...after, changed: Object.keys(changes) });
}

/**
 * `DELETE /api/panel-users/:userId` — SUPPRIMER UN COMPTE.
 *
 * Y compris un autre SUPER_ADMIN, y compris le dernier, y compris SOI-MÊME.
 * Voir `patchPanelUser` pour la doctrine ; voir `deleteUser` pour ce qui
 * disparaît et ce qui reste. Le journal, lui, garde tout — et porte l'adresse
 * en instantané, précisément pour rester lisible après la suppression.
 */
export async function deletePanelUser(req, res) {
  const cible = await getUserById(req.params.userId);
  if (!cible) throw ApiError.notFound('PANEL_USER_UNKNOWN', 'Compte introuvable.');

  const supprime = await deleteUser(cible.userId);
  if (!supprime) throw ApiError.notFound('PANEL_USER_UNKNOWN', 'Compte introuvable.');

  await journaliser(EVENT_TYPES.PANEL_USER_DELETED, {
    req,
    cible: supprime,
    summary: `Compte ${supprime.email} (${supprime.role}) SUPPRIMÉ.`,
    data: {
      role: supprime.role,
      /** Un opérateur qui se supprime lui-même est un fait qu'on veut retrouver. */
      selfDeletion: supprime.userId === req.panelUser.userId,
    },
  });

  return ok(res, {
    userId: supprime.userId,
    email: supprime.email,
    deleted: true,
    /** L'écran doit savoir qu'il vient de fermer SA propre session. */
    selfDeletion: supprime.userId === req.panelUser.userId,
  });
}

export default {
  deletePanelUser,
  getOwnProfile,
  listAccessibleProjects,
  listPanelUsers,
  patchOwnProfile,
  patchPanelUser,
  postPanelUser,
  postPanelUserInvitation,
};
