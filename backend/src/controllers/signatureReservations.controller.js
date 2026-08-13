// RÉSERVATIONS DE SIGNATURE — le contrôleur, et rien de plus (R10.5C).
//
// Aucune règle métier ici : ni décision de blocage, ni verdict d'ancienneté, ni
// audit. Il lit une requête, appelle l'autorité, rend son verdict.
import { ok } from '../utils/apiResponse.js';
import {
  listPendingReservations,
  releaseReservation,
} from '../services/integratedApi/yousign/signatureReservations.service.js';

/** GET — les réservations en attente, éventuellement filtrées par projet. */
export async function getPendingReservations(req, res) {
  const reservations = await listPendingReservations({
    projectId: req.query?.projectId ?? null,
  });
  return ok(res, { reservations });
}

/**
 * POST — libère une réservation bloquée. DEV uniquement (monté ainsi).
 *
 * Le motif vit dans le CORPS et non dans l'URL : il est obligatoire, parfois
 * long, et n'a rien à faire dans un journal d'accès HTTP.
 */
export async function postReleaseReservation(req, res) {
  return ok(res, await releaseReservation({
    operationId: req.params.operationId,
    reason: req.body?.reason,
    actor: {
      userId: req.panelUser?.userId ?? null,
      userEmail: req.panelUser?.email ?? null,
    },
  }));
}

export default { getPendingReservations, postReleaseReservation };
