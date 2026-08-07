/**
 * ACTIONS CONTRACTUELLES — le Panel DEMANDE, le projet décide.
 *
 * ── LA LIGNE À NE PAS FRANCHIR ──────────────────────────────────────────────
 * Rien ici ne modifie la projection du contrat. Le Panel n'écrit pas
 * « résilié » dans sa copie : il invoque une opération du projet, et attend
 * que la nouvelle vérité lui revienne par la synchronisation, comme toute
 * autre modification. Écrire localement produirait un écran qui affiche
 * « résilié » pendant qu'un abonnement continue d'être prélevé.
 *
 * ── LA GARDE DE PRODUCTION ──────────────────────────────────────────────────
 * Elle est double, volontairement. Le projet ne PUBLIE `contract.cancel_now`
 * que dans un environnement de test, et le refuse de toute façon s'il est
 * invoqué hors test. Le Panel, lui, refuse d'émettre la demande vers un projet
 * qu'il sait en production. Une seule garde suffirait sur le papier ; deux
 * suffisent quand l'une des deux est mal déployée.
 */
import { randomUUID } from 'node:crypto';
import ApiError from '../../utils/ApiError.js';
import logger from '../../utils/logger.js';
import ProjectBridgeClient from '../../bridge/ProjectBridgeClient.js';
import { getOutboundBridgeToken } from '../pairing/pairing.service.js';
import { PanelContractAction } from '../../models/PanelContractAction.model.js';
import { PanelProjectContract } from '../../models/PanelProjectProjection.model.js';
import { outboundBaseUrl } from '../registry/projectDestination.service.js';

const nowIso = () => new Date().toISOString();

export const CONTRACT_OPERATIONS = Object.freeze({
  CANCEL_AT_PERIOD_END: 'contract.cancel_at_period_end',
  CANCEL_NOW: 'contract.cancel_now',
  SET_PROTECTION: 'contract.set_protection',
});

/** Un projet non appairé n'a pas de pont : la demande n'a nulle part où aller. */
function clientFor(record) {
  const bridgeToken = record.pairing?.status === 'PAIRED' ? getOutboundBridgeToken(record) : null;
  if (!bridgeToken) {
    throw ApiError.conflict(
      'PANEL_PROJECT_NOT_PAIRED',
      'Ce projet n’est pas relié : aucune action contractuelle ne peut lui être transmise.',
    );
  }
  if (!outboundBaseUrl(record)) {
    throw ApiError.conflict(
      'PANEL_PROJECT_UNREACHABLE',
      'L’adresse du projet est inconnue : impossible de lui transmettre la demande.',
    );
  }
  return new ProjectBridgeClient({
    baseUrl: outboundBaseUrl(record),
    bridgeToken,
  });
}

/**
 * Ce que le projet accepte AUJOURD'HUI. On ne devine pas : on demande.
 *
 * Un projet injoignable rend une liste vide plutôt qu'une erreur — l'écran
 * doit pouvoir dire « actions indisponibles », pas se casser.
 */
export async function listContractOperations(record) {
  try {
    const data = await clientFor(record).listOperations();
    return {
      operations: data?.operations ?? [],
      reachable: true,
      /**
       * L'état de la protection voyage avec le catalogue — voir la note du
       * projet : la projection CONTRACT s'efface quand il n'y a aucun contrat,
       * or c'est justement là que ce réglage décide de l'accès. `null` quand le
       * projet ne le publie pas (version antérieure) : l'écran dira « inconnu »
       * plutôt que d'inventer « désactivé ».
       */
      contractProtection: data?.contractProtection ?? null,
    };
  } catch (err) {
    logger.warn(`Catalogue d’opérations indisponible pour ${record.projectKey} : ${err.message}`);
    return {
      operations: [], reachable: false, contractProtection: null, reason: err.code || err.message,
    };
  }
}

/**
 * Demande une action contractuelle et journalise, quoi qu'il arrive.
 *
 * @param {object} record   fiche projet du registre
 * @param {object} demande  { operationId, reason, actor }
 */
export async function requestContractAction(record, { operationId, reason = null, actor = {} }) {
  /**
   * Cette voie ne transporte que les RÉSILIATIONS.
   *
   * Le réglage de la protection a la sienne (`requestContractProtection`), et
   * ce n'est pas de la cosmétique : cette fonction exige un contrat, journalise
   * des transitions de statut et applique la garde de production. Y faire
   * passer un réglage produirait une ligne de journal qui décrit une
   * résiliation qui n'a pas eu lieu.
   */
  const CANCELLATIONS = [
    CONTRACT_OPERATIONS.CANCEL_AT_PERIOD_END,
    CONTRACT_OPERATIONS.CANCEL_NOW,
  ];
  if (!CANCELLATIONS.includes(operationId)) {
    throw ApiError.badRequest(
      'PANEL_CONTRACT_OPERATION_UNKNOWN',
      'Action contractuelle inconnue.',
    );
  }

  const environment = record.runtime?.environment ?? null;
  if (operationId === CONTRACT_OPERATIONS.CANCEL_NOW && environment !== 'TEST') {
    throw ApiError.forbidden(
      'PANEL_CONTRACT_IMMEDIATE_CANCEL_FORBIDDEN',
      'La résiliation immédiate est réservée aux projets de test. '
      + 'En production, seule la résiliation à l’échéance est possible.',
    );
  }

  const projection = await PanelProjectContract.findOne({ projectId: record.projectId }).lean();
  const invocationId = randomUUID();

  // Consigné AVANT l'appel : une demande partie dont la réponse se perd doit
  // laisser une trace. Sans cela, le cas le plus grave serait le seul muet.
  const journal = await PanelContractAction.create({
    projectId: record.projectId,
    projectName: record.projectName ?? null,
    environment,
    operationId,
    invocationId,
    actor: {
      userId: actor.userId ?? null,
      email: actor.email ?? null,
      role: actor.role ?? null,
    },
    reason,
    contract: {
      sourceContractId: projection?.sourceContractId ?? null,
      reference: projection?.reference ?? null,
      previousStatus: projection?.status ?? null,
      newStatus: null,
      endsAt: null,
    },
    outcome: 'REQUESTED',
    requestedAt: nowIso(),
  });

  try {
    const result = await clientFor(record).invokeOperation(operationId, {
      invocationId,
      params: reason ? { reason } : {},
    });
    journal.contract.newStatus = result?.contract?.newStatus ?? null;
    journal.contract.endsAt = result?.contract?.endsAt ?? null;
    journal.contract.previousStatus = result?.contract?.previousStatus
      ?? journal.contract.previousStatus;
    journal.outcome = 'SUCCEEDED';
    journal.completedAt = nowIso();
    await journal.save();

    logger.info(
      `Action contractuelle ${operationId} sur ${record.projectKey} : `
      + `${journal.contract.previousStatus} -> ${journal.contract.newStatus}.`,
    );
    return { action: journal.toObject(), result };
  } catch (err) {
    journal.outcome = 'FAILED';
    journal.errorCode = err.code || err.details?.code || null;
    journal.errorMessage = err.message || null;
    journal.completedAt = nowIso();
    await journal.save();

    throw ApiError.conflict(
      'PANEL_CONTRACT_ACTION_FAILED',
      `Le projet a refusé l’action : ${err.message}`,
    );
  }
}

/**
 * RÉGLAGE DE LA PROTECTION CONTRACTUELLE — même doctrine que la résiliation :
 * le Panel DEMANDE, le projet applique et rend l'état constaté.
 *
 * ── AUCUNE COPIE LOCALE ─────────────────────────────────────────────────────
 * Rien n'est écrit dans une projection. La valeur affichée par le Panel est
 * relue au projet à chaque ouverture de la fiche (catalogue d'opérations) : il
 * ne peut donc pas exister un « Panel dit ON, Manager dit OFF ». Ce qu'on
 * garde ici est l'INTENTION et la RÉPONSE, dans le journal d'actions — pas la
 * valeur elle-même.
 *
 * ── PERMISSION ──────────────────────────────────────────────────────────────
 * Le projet authentifie le pont, pas l'humain : il accorde sa confiance au
 * jeton du Panel. C'est donc au Panel de porter la règle d'accès, et la route
 * qui appelle cette fonction est réservée aux comptes DEV.
 *
 * @param {object} record   fiche projet du registre
 * @param {{enabled: boolean, actor?: object}} demande
 */
export async function requestContractProtection(record, { enabled, actor = {} }) {
  if (typeof enabled !== 'boolean') {
    throw ApiError.badRequest(
      'PANEL_CONTRACT_PROTECTION_INVALID',
      'Le champ « enabled » (booléen) est requis.',
    );
  }

  const environment = record.runtime?.environment ?? null;
  const projection = await PanelProjectContract.findOne({ projectId: record.projectId }).lean();
  const invocationId = randomUUID();

  // Consigné AVANT l'appel : une demande partie dont la réponse se perd doit
  // laisser une trace, comme pour les résiliations.
  const journal = await PanelContractAction.create({
    projectId: record.projectId,
    projectName: record.projectName ?? null,
    environment,
    operationId: CONTRACT_OPERATIONS.SET_PROTECTION,
    invocationId,
    actor: {
      userId: actor.userId ?? null,
      email: actor.email ?? null,
      role: actor.role ?? null,
    },
    contract: {
      sourceContractId: projection?.sourceContractId ?? null,
      reference: projection?.reference ?? null,
      previousStatus: projection?.status ?? null,
      newStatus: null,
      endsAt: null,
    },
    protection: { requested: enabled, applied: null, siteStatus: null, suspensionSource: null },
    outcome: 'REQUESTED',
    requestedAt: nowIso(),
  });

  try {
    const result = await clientFor(record).invokeOperation(CONTRACT_OPERATIONS.SET_PROTECTION, {
      invocationId,
      params: { enabled },
    });

    const applique = result?.contractProtection ?? null;
    journal.protection.applied = typeof applique?.enabled === 'boolean' ? applique.enabled : null;
    journal.protection.siteStatus = applique?.siteStatus ?? null;
    journal.protection.suspensionSource = applique?.suspensionSource ?? null;
    journal.outcome = 'SUCCEEDED';
    journal.completedAt = nowIso();
    await journal.save();

    logger.info(
      `Protection contractuelle ${enabled ? 'activée' : 'désactivée'} sur ${record.projectKey} : `
      + `site ${applique?.siteStatus ?? '?'} (source ${applique?.suspensionSource ?? '?'}).`,
    );
    return { action: journal.toObject(), contractProtection: applique };
  } catch (err) {
    journal.outcome = 'FAILED';
    journal.errorCode = err.code || err.details?.code || null;
    journal.errorMessage = err.message || null;
    journal.completedAt = nowIso();
    await journal.save();

    throw ApiError.conflict(
      'PANEL_CONTRACT_PROTECTION_FAILED',
      `Le projet a refusé le réglage : ${err.message}`,
    );
  }
}

/** Historique des actions d'un projet, de la plus récente à la plus ancienne. */
export async function listContractActions(projectId, limit = 20) {
  return PanelContractAction.find({ projectId }).sort({ requestedAt: -1 }).limit(limit).lean();
}

export default {
  listContractOperations,
  requestContractAction,
  requestContractProtection,
  listContractActions,
};
