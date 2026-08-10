// IDENTITÉS EXPÉDITRICES — le stockage que L8 avait laissé à écrire (L8.3).
//
// docs/architecture/BREVO_CONTROL_PLANE.md §« Expéditeurs ».
//
// ── CE MODULE NE REDÉFINIT RIEN ─────────────────────────────────────────────
//
// `brevo/brevoSenderIdentity.js` (L8) porte le CONTRAT : forme, validation,
// garde de portée. Il ne persistait rien — `lookup` était injecté, et le
// stockage laissé à qui écrirait les modèles. C'est ce qu'on branche ici, sans
// réécrire une seule des règles : les redéclarer ferait diverger la validation
// du contrat qu'elle est censée appliquer.
//
// ── LA GARDE DE PORTÉE EST LA RAISON D'ÊTRE DU MODULE ───────────────────────
//
// Un projet ne peut atteindre QUE son identité, dans le monde servi. Ce n'est
// pas une politesse : l'adresse expéditrice est ce que voit le destinataire.
// Un projet capable de choisir celle d'un autre pourrait écrire en son nom —
// à ses clients, avec sa réputation de domaine.
import ApiError from '../../utils/ApiError.js';
import logger from '../../utils/logger.js';
import { nowIso } from '../../bridge/bridgeContract.js';
import PanelProjectSenderIdentity from '../../models/PanelProjectSenderIdentity.model.js';
import {
  SENDER_IDENTITY_CODES,
  SENDER_IDENTITY_SHAPE,
  validateSenderIdentity,
  resolveSenderIdentity as resolveWithContract,
  describeSenderIdentity,
} from '../integratedApi/brevo/brevoSenderIdentity.js';
import { ENVIRONMENTS } from '../integratedApi/providerRegistry.js';

/**
 * LA SOURCE — branchée sur le contrat L8 comme `lookup`.
 *
 * Volontairement étroite : elle lit un couple exact et ne connaît aucun repli.
 * Un repli « sur l'identité de plateforme » serait tentant et faux — il ferait
 * partir un e-mail sous une adresse que le projet n'a jamais choisie.
 */
async function lookup({ projectId, environment }) {
  return PanelProjectSenderIdentity.findOne({ projectId, environment }).lean();
}

/**
 * Résout l'identité d'un projet dans le monde SERVI.
 *
 * `requestedProjectId` est ce que la charge utile prétend. Le contrat L8 refuse
 * s'il diverge du projet authentifié — plutôt que de l'ignorer en silence :
 * un projet qui envoie un identifiant étranger a un bug ou une intention, et
 * les deux méritent une trace.
 */
export async function resolveForProject({ authenticatedProjectId, requestedProjectId = null, environment }) {
  return resolveWithContract({ authenticatedProjectId, requestedProjectId, environment, lookup });
}

/** L'identité existe-t-elle et est-elle exploitable ? Sans lever. */
export async function describeForProject(projectId, environment) {
  const stored = await lookup({ projectId, environment });
  const verdict = validateSenderIdentity(stored);
  if (!verdict.valid) {
    return { projectId, environment, configured: Boolean(stored), code: verdict.code, problems: verdict.problems, identity: null };
  }
  return {
    projectId,
    environment,
    configured: true,
    code: SENDER_IDENTITY_CODES.OK,
    problems: [],
    identity: describeSenderIdentity({
      projectId,
      environment,
      fromEmail: stored.fromEmail,
      fromName: stored.fromName,
      replyTo: stored.replyToEmail ? { email: stored.replyToEmail, name: stored.replyToName } : null,
    }),
    verifiedAtProvider: Boolean(stored.verifiedAtProvider),
    verifiedAt: stored.verifiedAt ?? null,
  };
}

/**
 * Enregistre l'identité d'un projet — geste d'ADMINISTRATION du Panel.
 *
 * Les champs interdits par le contrat (`apiKey`, `webhookSecret`…) sont refusés
 * AVANT écriture. Ce n'est pas une redondance avec la validation : celle-ci
 * dirait « problème », celle-là dit LEQUEL, et empêche qu'un secret entre dans
 * une collection qui n'est pas faite pour en porter.
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
        `Le champ « ${forbidden} » n’a rien à faire dans une identité expéditrice : `
        + 'les secrets vivent dans le coffre, pas dans une configuration métier.',
      );
    }
  }

  const candidate = {
    fromEmail: input.fromEmail,
    fromName: input.fromName,
    replyToEmail: input.replyToEmail ?? '',
    replyToName: input.replyToName ?? '',
  };
  const verdict = validateSenderIdentity(candidate);
  if (!verdict.valid) {
    throw ApiError.badRequest(verdict.code, `Identité expéditrice refusée : ${verdict.problems.join(' ')}`);
  }

  const at = nowIso();
  await PanelProjectSenderIdentity.updateOne(
    { projectId, environment },
    {
      $set: {
        fromEmail: String(candidate.fromEmail).trim().toLowerCase(),
        fromName: String(candidate.fromName).trim(),
        replyToEmail: String(candidate.replyToEmail).trim().toLowerCase(),
        replyToName: String(candidate.replyToName).trim(),
        updatedAt: at,
        updatedBy: actor.userId ?? null,
        /**
         * Toute modification d'adresse invalide la preuve de reconnaissance :
         * Brevo valide une ADRESSE, pas une ligne de base. La conserver ferait
         * croire qu'une nouvelle adresse est déjà autorisée à expédier.
         */
        verifiedAtProvider: false,
        verifiedAt: null,
      },
      $setOnInsert: { createdAt: at },
    },
    { upsert: true },
  );

  // L'adresse expéditrice est publique par nature — elle figure dans chaque
  // e-mail envoyé. La journaliser n'expose rien qu'un destinataire ne voie.
  logger.info(`[email] identité expéditrice ${projectId}/${environment} enregistrée (${candidate.fromEmail}).`);
  return describeForProject(projectId, environment);
}

/** Marque l'adresse comme reconnue par le fournisseur. Constat, pas décision. */
export async function markVerifiedAtProvider(projectId, environment, verified = true) {
  const at = nowIso();
  await PanelProjectSenderIdentity.updateOne(
    { projectId, environment },
    { $set: { verifiedAtProvider: Boolean(verified), verifiedAt: verified ? at : null, updatedAt: at } },
  );
  return describeForProject(projectId, environment);
}

export async function removeSenderIdentity(projectId, environment) {
  const result = await PanelProjectSenderIdentity.deleteOne({ projectId, environment });
  return { removed: result.deletedCount > 0 };
}

/** Toutes les identités d'un projet — les deux mondes, pour l'écran. */
export async function listForProject(projectId) {
  const items = [];
  for (const environment of ENVIRONMENTS) {
    items.push(await describeForProject(projectId, environment));
  }
  return items;
}

export default {
  resolveForProject,
  describeForProject,
  saveSenderIdentity,
  markVerifiedAtProvider,
  removeSenderIdentity,
  listForProject,
};
