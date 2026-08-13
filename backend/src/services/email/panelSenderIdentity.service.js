// EXPÉDITEUR SERVI — le `From` global, le `Reply-To` du projet (L8.3 → R10.4).
//
// docs/architecture/BREVO_CONTROL_PLANE.md §« Expéditeurs ».
//
// ── CE MODULE NE REDÉFINIT RIEN ─────────────────────────────────────────────
//
// `brevo/brevoSenderIdentity.js` (L8) porte le CONTRAT : forme, validation,
// garde de portée. `email/panelGlobalSender.service.js` (R10.4) porte l'AUTORITÉ
// sur le `From`. Ce module ne fait que les JOINDRE au stockage — sans réécrire
// une seule de leurs règles : les redéclarer ferait diverger la validation du
// contrat qu'elle est censée appliquer.
//
// ── LA GARDE DE PORTÉE RESTE LA RAISON D'ÊTRE DU MODULE ─────────────────────
//
// Un projet ne peut atteindre QUE sa propre adresse de réponse, dans le monde
// servi. Ce n'est pas une politesse : un projet capable de désigner le
// `Reply-To` d'un autre détournerait sa correspondance — les réponses de ses
// clients arriveraient chez lui.
import ApiError from '../../utils/ApiError.js';
import logger from '../../utils/logger.js';
import { nowIso } from '../../bridge/bridgeContract.js';
import PanelProjectSenderIdentity from '../../models/PanelProjectSenderIdentity.model.js';
import {
  SENDER_IDENTITY_CODES,
  SENDER_IDENTITY_SHAPE,
  assertProjectScope,
} from '../integratedApi/brevo/brevoSenderIdentity.js';
import { resolveGlobalSender } from './panelGlobalSender.service.js';
import { ENVIRONMENTS } from '../integratedApi/providerRegistry.js';

/**
 * LA SOURCE du `Reply-To` — un couple exact, aucun repli.
 *
 * Un repli « sur le projet voisin » ou « sur la plateforme » ferait router les
 * réponses d'un client vers une boîte que personne n'a désignée.
 */
async function lookup({ projectId, environment }) {
  return PanelProjectSenderIdentity.findOne({ projectId, environment }).lean();
}

/**
 * Résout l'expéditeur à utiliser pour un projet, dans le monde SERVI.
 *
 * ══ DEUX AUTORITÉS, ET UNE SEULE DÉCIDE DU `From` (R10.4) ══════════════════
 *
 *   `From`      →  configuration GLOBALE du Panel. Identique pour tout le
 *                  parc, et pour le Panel lui-même. Absente = REFUS.
 *   `Reply-To`  →  configuration du PROJET authentifié. Facultative : sans
 *                  elle, les réponses arrivent au support de la plateforme,
 *                  ce qui est un défaut acceptable — un `From` par défaut ne
 *                  l'aurait pas été.
 *
 * La garde de portée du contrat L8 est CONSERVÉE telle quelle. Elle protège
 * désormais le `Reply-To` plutôt que le `From`, et l'enjeu reste le même : un
 * projet capable de désigner l'adresse de réponse d'un autre détournerait sa
 * correspondance.
 *
 * @returns {Promise<{projectId: string|null, environment: string,
 *   fromEmail: string, fromName: string, replyTo: {email, name?}|null}>}
 */
export async function resolveForProject({ authenticatedProjectId, requestedProjectId = null, environment }) {
  const projectId = assertProjectScope({ authenticatedProjectId, requestedProjectId });
  const global = await resolveGlobalSender();
  return {
    projectId,
    environment,
    fromEmail: global.senderEmail,
    fromName: global.senderName,
    replyTo: await resolveReplyTo({ projectId, environment }),
  };
}

/**
 * L'expéditeur du PANEL POUR LUI-MÊME — aucune fiche projet dans l'affaire.
 *
 * Le Panel écrit à ses propres exploitants (test d'expéditeur, notifications
 * internes). Il n'a pas de `Reply-To` de projet, et surtout : il emprunte
 * exactement le même `From` que tout le reste du parc. Une seconde source pour
 * « les e-mails du Panel » serait la deuxième vérité que R10.4 interdit.
 */
export async function resolveForPanel() {
  const global = await resolveGlobalSender();
  return {
    projectId: null,
    environment: null,
    fromEmail: global.senderEmail,
    fromName: global.senderName,
    replyTo: null,
  };
}

/**
 * Le `Reply-To` d'un projet, ou `null`.
 *
 * Ne LÈVE JAMAIS pour une absence : un projet sans adresse de réponse est un
 * cas normal, pas une panne. Une adresse ILLISIBLE, en revanche, est écartée
 * plutôt que transmise — Brevo la refuserait, et le refus porterait alors sur
 * l'envoi entier au lieu d'un en-tête accessoire.
 */
export async function resolveReplyTo({ projectId, environment }) {
  if (!projectId || !environment) return null;
  const stored = await lookup({ projectId, environment });
  const email = String(stored?.replyToEmail ?? '').trim().toLowerCase();
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return null;
  const name = String(stored?.replyToName ?? '').trim();
  return name ? { email, name } : { email };
}

/**
 * Ce qui est configuré pour ce projet — l'adresse de réponse, et le `From`
 * GLOBAL qui s'appliquera. Sans lever.
 *
 * Le `From` figure dans la vue alors qu'il n'appartient pas à ce projet, et
 * c'est délibéré : l'écran qui montre « à qui l'on répond » doit montrer « au
 * nom de qui l'on écrit », sinon l'opérateur croit configurer l'expéditeur.
 * Il est marqué comme venant d'ailleurs (`fromSource: 'GLOBAL'`).
 */
export async function describeForProject(projectId, environment) {
  const stored = await lookup({ projectId, environment });
  const replyTo = await resolveReplyTo({ projectId, environment });

  let from = null;
  let fromProblem = null;
  try {
    const global = await resolveGlobalSender();
    from = { email: global.senderEmail, name: global.senderName };
  } catch (error) {
    // L'absence d'expéditeur global n'est pas un défaut de CE projet : on la
    // rapporte sans la lui imputer, et sans faire échouer la lecture.
    fromProblem = error?.code ?? 'PANEL_GLOBAL_SENDER_NOT_CONFIGURED';
  }

  return {
    projectId,
    environment,
    /** Le `From` ne se configure pas ici — il est rappelé, et son origine dite. */
    fromSource: 'GLOBAL',
    from,
    fromProblem,
    /** Ce que CE projet configure réellement. */
    replyTo,
    configured: Boolean(replyTo),
    code: SENDER_IDENTITY_CODES.OK,
    problems: [],
    updatedAt: stored?.updatedAt ?? null,
    updatedBy: stored?.updatedBy ?? null,
  };
}

/**
 * Enregistre l'ADRESSE DE RÉPONSE d'un projet — geste d'ADMINISTRATION du Panel.
 *
 * ── CE QUE CETTE FONCTION REFUSE DÉSORMAIS (R10.4) ──────────────────────────
 *
 * `fromEmail` et `fromName`. Les accepter en silence — même pour les ignorer —
 * laisserait un appelant croire qu'il configure l'expéditeur d'un projet, et
 * ferait diverger ce qu'il a saisi de ce qui part réellement. Un refus nommé
 * envoie sur le bon écran.
 */
export async function saveSenderIdentity(projectId, environment, input = {}, actor = {}) {
  if (!ENVIRONMENTS.includes(environment)) {
    throw ApiError.badRequest(
      'PANEL_SENDER_IDENTITY_ENVIRONMENT_INVALID',
      `Environnement invalide : « ${environment} ». TEST ou PROD attendus.`,
    );
  }
  for (const forbidden of SENDER_IDENTITY_SHAPE.forbidden) {
    if (input[forbidden] !== undefined) {
      throw ApiError.badRequest(
        SENDER_IDENTITY_CODES.INVALID,
        `Le champ « ${forbidden} » n’a rien à faire dans une configuration d’expéditeur : `
        + 'les secrets vivent dans le coffre, pas dans une configuration métier.',
      );
    }
  }
  for (const global of ['fromEmail', 'fromName', 'senderEmail', 'senderName']) {
    if (input[global] !== undefined) {
      throw ApiError.badRequest(
        'PANEL_PROJECT_FROM_NOT_CONFIGURABLE',
        `« ${global} » ne se configure pas par projet : l’expéditeur du parc est global `
        + '(écran « Expéditeur e-mail »). Un projet ne configure que son adresse de réponse.',
      );
    }
  }

  const replyToEmail = String(input.replyToEmail ?? '').trim().toLowerCase();
  const replyToName = String(input.replyToName ?? '').trim();
  if (replyToEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(replyToEmail)) {
    throw ApiError.badRequest(
      SENDER_IDENTITY_CODES.INVALID,
      'Adresse de réponse illisible.',
    );
  }

  const at = nowIso();
  await PanelProjectSenderIdentity.updateOne(
    { projectId, environment },
    {
      $set: { replyToEmail, replyToName, updatedAt: at, updatedBy: actor.userId ?? null },
      $setOnInsert: { createdAt: at },
    },
    { upsert: true },
  );

  // L'adresse de réponse est publique par nature — elle figure dans chaque
  // e-mail envoyé. La journaliser n'expose rien qu'un destinataire ne voie.
  logger.info(
    `[email] adresse de réponse ${projectId}/${environment} enregistrée `
    + `(${replyToEmail || 'aucune — les réponses iront au support'}).`,
  );
  return describeForProject(projectId, environment);
}

export async function removeSenderIdentity(projectId, environment) {
  const result = await PanelProjectSenderIdentity.deleteOne({ projectId, environment });
  return { removed: result.deletedCount > 0 };
}

/** Toute la configuration d'un projet — les deux mondes, pour l'écran. */
export async function listForProject(projectId) {
  const items = [];
  for (const environment of ENVIRONMENTS) {
    items.push(await describeForProject(projectId, environment));
  }
  return items;
}

export default {
  resolveForProject,
  resolveForPanel,
  resolveReplyTo,
  describeForProject,
  saveSenderIdentity,
  removeSenderIdentity,
  listForProject,
};
