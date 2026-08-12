// REGISTRE FINANCIER — surface interne /api. Aucun pont, aucun fournisseur :
// ces mouvements appartiennent au Panel, et à personne d'autre.
import { ok, created } from '../utils/apiResponse.js';
import {
  bulkSoftDelete,
  countBulkScope,
  createManualTransaction,
  getTransaction,
  listTransactions,
  softDeleteTransaction,
  updateManualTransaction,
} from '../services/finance/financialTransactions.service.js';
import { summarize, summarizeByProject } from '../services/finance/financialSummary.service.js';

/** L'auteur d'une écriture comptable. Jamais anonyme. */
const actorOf = (req) => ({
  userId: req.panelUser?.userId ?? null,
  email: req.panelUser?.email ?? null,
  role: req.panelUser?.role ?? null,
});

/**
 * Les critères de lecture, tels qu'ils arrivent de la barre d'adresse.
 *
 * Aucune valeur par défaut n'est posée ICI : les défauts appartiennent au
 * service (portée, période, tri), pour que l'API HTTP et un futur appel
 * interne se comportent exactement pareil. Le contrôleur ne fait que traduire
 * des chaînes de requête en champs nommés.
 */
const criteriaOf = (req) => {
  const q = req.query ?? {};
  return {
    scope: q.scope ?? undefined,
    projectId: q.projectId ?? null,
    period: q.period ?? undefined,
    start: q.start ?? undefined,
    end: q.end ?? undefined,
    category: q.category ?? null,
    flow: q.flow ?? null,
    search: q.search ?? null,
    sort: q.sort ?? undefined,
    limit: q.limit ?? undefined,
    // Une case explicitement cochée, jamais un défaut : les mouvements
    // supprimés restent auditables, mais ne s'invitent pas dans une lecture.
    includeDeleted: q.includeDeleted === 'true' || q.includeDeleted === '1',
  };
};

/* ── Lecture ───────────────────────────────────────────────────────────────── */

export async function transactions(req, res) {
  return ok(res, await listTransactions(criteriaOf(req)));
}

export async function transaction(req, res) {
  return ok(res, { transaction: await getTransaction(req.params.transactionId) });
}

/**
 * LE RÉSUMÉ — revenus, coûts, net, et les points du graphique.
 *
 * Servi par une route distincte de la liste, et c'est délibéré : la liste est
 * bornée à une page, le résumé porte sur TOUT ce que le filtre retient. Les
 * fondre obligerait soit à tronquer le total, soit à charger tout le registre
 * pour afficher vingt lignes.
 */
export async function summary(req, res) {
  return ok(res, await summarize(criteriaOf(req)));
}

export async function byProject(req, res) {
  return ok(res, { items: await summarizeByProject(criteriaOf(req)) });
}

/**
 * COMBIEN une suppression en masse retirerait — sans rien retirer.
 *
 * Cette route existe pour que la confirmation puisse annoncer un NOMBRE. « Tout
 * supprimer » sans dire combien est une question à laquelle personne ne peut
 * répondre en connaissance de cause.
 */
export async function bulkScope(req, res) {
  const scope = req.query?.scope;
  const projectId = req.query?.projectId ?? null;
  return ok(res, { scope, projectId, count: await countBulkScope({ scope, projectId }) });
}

/* ── Écriture ──────────────────────────────────────────────────────────────── */

export async function addTransaction(req, res) {
  const document = await createManualTransaction(req.body ?? {}, actorOf(req));
  return created(res, { transaction: await getTransaction(document.transactionId) });
}

export async function editTransaction(req, res) {
  const document = await updateManualTransaction(
    req.params.transactionId,
    req.body ?? {},
    actorOf(req),
  );
  return ok(res, { transaction: await getTransaction(document.transactionId) });
}

export async function removeTransaction(req, res) {
  const document = await softDeleteTransaction(
    req.params.transactionId,
    { reason: req.body?.reason ?? null },
    actorOf(req),
  );
  return ok(res, { transaction: await getTransaction(document.transactionId) });
}

export async function removeAll(req, res) {
  const { scope, projectId = null, reason = null, confirm } = req.body ?? {};
  return ok(res, await bulkSoftDelete({ scope, projectId, reason, confirm }, actorOf(req)));
}
