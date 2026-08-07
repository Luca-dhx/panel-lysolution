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
    return { operations: data?.operations ?? [], reachable: true };
  } catch (err) {
    logger.warn(`Catalogue d’opérations indisponible pour ${record.projectKey} : ${err.message}`);
    return { operations: [], reachable: false, reason: err.code || err.message };
  }
}

/**
 * Demande une action contractuelle et journalise, quoi qu'il arrive.
 *
 * @param {object} record   fiche projet du registre
 * @param {object} demande  { operationId, reason, actor }
 */
export async function requestContractAction(record, { operationId, reason = null, actor = {} }) {
  if (!Object.values(CONTRACT_OPERATIONS).includes(operationId)) {
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

/** Historique des actions d'un projet, de la plus récente à la plus ancienne. */
export async function listContractActions(projectId, limit = 20) {
  return PanelContractAction.find({ projectId }).sort({ requestedAt: -1 }).limit(limit).lean();
}

export default { listContractOperations, requestContractAction, listContractActions };
