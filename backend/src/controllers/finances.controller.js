// REGISTRE FINANCIER — surface interne /api. Aucun pont, aucun fournisseur :
// ces mouvements appartiennent au Panel, et à personne d'autre.
import ApiError from '../utils/ApiError.js';
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
import {
  createRecurringCost,
  getRecurringCost,
  listRecurringCosts,
  materializeAllDue,
  reviseRecurringCost,
  stopRecurringCost,
} from '../services/finance/recurringCosts.service.js';
import {
  attachReceipt, detachReceipt, readReceipt,
} from '../services/finance/receipts.service.js';
import {
  convergePendingRevenue,
  describeProviderFact,
  listUnprojectedFacts,
} from '../services/finance/providerRevenue/revenueProjection.service.js';

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

/**
 * LA CONVERGENCE A LIEU AVANT CHAQUE LECTURE FINANCIÈRE — et c'est la garantie.
 *
 * ══ POURQUOI ICI, ET PAS SEULEMENT DANS UN ORDONNANCEUR ═════════════════════
 *
 * Un ordonnanceur qui serait la seule source de matérialisation ferait dépendre
 * l'exactitude d'un bilan de la disponibilité d'un processus à un instant
 * précis. Une minute d'arrêt à minuit, un redéploiement, une panne : le cycle
 * du mois manquerait, et rien ne le rattraperait avant le mois suivant.
 *
 * En matérialisant à la LECTURE, on obtient l'inverse : ce que quelqu'un
 * regarde est, par construction, à jour au moment où il le regarde. Le
 * rattrapage de quatre mois d'arrêt se fait à la première ouverture d'écran.
 *
 * L'ordonnanceur reste utile — il écrit même sans lecteur — mais il n'est plus
 * la garantie, seulement une commodité.
 *
 * ── LE COÛT, ET POURQUOI IL EST NÉGLIGEABLE ─────────────────────────────────
 * Sans cycle dû, la fonction lit les règles actives de la portée et n'écrit
 * rien. Avec des cycles dus, elle écrit exactement ce qui manque, une fois.
 *
 * ── L'ÉCHEC N'EMPÊCHE PAS DE LIRE ───────────────────────────────────────────
 * Une matérialisation impossible ne doit pas rendre le livret illisible : on
 * journalise et l'on sert ce qui existe. Le passage suivant réessaiera.
 */
async function converge(req) {
  const q = req.query ?? {};
  try {
    await materializeAllDue({
      scope: q.scope ?? null,
      projectId: q.projectId ?? null,
    });
  } catch (err) {
    const { default: logger } = await import('../utils/logger.js');
    logger.warn(`[finance] Convergence des récurrences impossible : ${err.message}`);
  }

  /**
   * LES REVENUS FOURNISSEUR CONVERGENT AUSSI À LA LECTURE (L10.3).
   *
   * ══ POURQUOI, ALORS QUE LA PROJECTION A LIEU À LA RÉCEPTION ═══════════════
   *
   * Parce qu'un fait peut arriver AVANT son propriétaire. Stripe n'ordonne pas
   * ses livraisons : une facture peut précéder la session qui a fait adopter
   * l'abonnement. Le fait est alors retenu, et il attend.
   *
   * La réception le reprend dès l'adoption ; cette passe-ci est le filet pour
   * tout ce qui n'aurait pas eu de déclencheur — un lien créé par un autre
   * chemin, une panne pendant la convergence, un import.
   *
   * Ce n'est PAS une lecture de Stripe. Aucun appel fournisseur : on rejoue une
   * résolution d'appartenance sur des faits déjà reçus.
   */
  try {
    await convergePendingRevenue({});
  } catch (err) {
    const { default: logger } = await import('../utils/logger.js');
    logger.warn(`[finance] Convergence des revenus fournisseur impossible : ${err.message}`);
  }
}

/* ── Lecture ───────────────────────────────────────────────────────────────── */

export async function transactions(req, res) {
  await converge(req);
  return ok(res, await listTransactions(criteriaOf(req)));
}

/**
 * LE DÉTAIL D'UN MOUVEMENT — enrichi du fait fournisseur, s'il en a un.
 *
 * ══ POURQUOI SEULEMENT ICI ══════════════════════════════════════════════════
 *
 * Les identifiants Stripe n'ont rien à faire dans une liste : une colonne de
 * `pi_3Q7x…` rendrait le livret illisible pour la seule personne qui, une fois
 * par trimestre, veut rapprocher une ligne du tableau de bord Stripe. Ils sont
 * donc chargés à la demande, sur l'écran qui les cherche.
 *
 * Ce n'est PAS une lecture de Stripe : le fait a été normalisé à la réception
 * et vit en base. Cet écran fonctionne fournisseur indisponible.
 */
export async function transaction(req, res) {
  const mouvement = await getTransaction(req.params.transactionId);
  return ok(res, {
    transaction: mouvement,
    providerFact: await describeProviderFact(mouvement),
  });
}

/**
 * LES FAITS FOURNISSEUR NON PROJETÉS — la file de diagnostic d'un exploitant.
 *
 * « De l'argent est arrivé chez Stripe et n'apparaît pas dans le Panel » est la
 * question qu'on posera, et elle mérite une réponse autre qu'un balayage de
 * journaux. Chaque ligne porte son motif : ressource sans lien, lien révoqué,
 * devise non gérée, monde qui ne concorde pas.
 *
 * Réservée aux comptes DEV : ce sont des identités techniques de fournisseur.
 */
export async function unprojectedRevenue(_req, res) {
  const faits = await listUnprojectedFacts({});
  return ok(res, {
    items: faits.map((f) => ({
      factId: f.factId,
      environment: f.environment,
      objectType: f.objectType,
      objectId: f.objectId,
      amountCents: f.amountCents,
      currency: f.currency,
      occurredAt: f.occurredAt ? new Date(f.occurredAt).toISOString() : null,
      projectionStatus: f.projectionStatus,
      projectionReason: f.projectionReason,
      ownershipResourceType: f.ownershipResourceType,
      lastSeenAt: f.lastSeenAt,
    })),
  });
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
  await converge(req);
  return ok(res, await summarize(criteriaOf(req)));
}

export async function byProject(req, res) {
  await converge(req);
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
  const { count, activeRecurringCosts } = await countBulkScope({ scope, projectId });
  // `activeRecurringCosts` n'est pas décoratif : vider le livret n'arrête aucun
  // abonnement, et l'écran doit le dire AVANT le clic, pas après.
  return ok(res, { scope, projectId, count, activeRecurringCosts });
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

/* ── Coûts récurrents — les RÈGLES, distinctes du ledger ───────────────────── */

export async function recurringCosts(req, res) {
  await converge(req);
  const q = req.query ?? {};
  return ok(res, {
    items: await listRecurringCosts({
      scope: q.scope ?? 'all',
      projectId: q.projectId ?? null,
      includeStopped: q.includeStopped !== 'false',
    }),
  });
}

export async function recurringCost(req, res) {
  return ok(res, { recurringCost: await getRecurringCost(req.params.recurringCostId) });
}

export async function addRecurringCost(req, res) {
  const definition = await createRecurringCost(req.body ?? {}, actorOf(req));
  return created(res, { recurringCost: definition });
}

/**
 * MODIFIER — le corps porte le MODE d'application, et il est obligatoire.
 *
 * Il n'y a pas de défaut : « à partir de quand ? » n'a pas de réponse évidente,
 * et en choisir une à la place de l'utilisateur reviendrait à réécrire son
 * historique sans le lui demander.
 */
export async function editRecurringCost(req, res) {
  const resultat = await reviseRecurringCost(
    req.params.recurringCostId,
    req.body ?? {},
    actorOf(req),
  );
  return ok(res, {
    recurringCost: await getRecurringCost(req.params.recurringCostId),
    revision: resultat.revision,
    revisedOccurrences: resultat.revisedOccurrences,
    unchanged: resultat.unchanged,
  });
}

export async function stopRecurring(req, res) {
  const { mode, reason = null } = req.body ?? {};
  const resultat = await stopRecurringCost(
    req.params.recurringCostId,
    { mode, reason },
    actorOf(req),
  );
  return ok(res, {
    recurringCost: await getRecurringCost(req.params.recurringCostId),
    untilCycleKey: resultat.untilCycleKey,
    cancelledOccurrences: resultat.cancelled,
  });
}

/* ── Justificatifs — protocole Media PRIVÉ ─────────────────────────────────── */

export async function uploadReceipt(req, res) {
  if (!req.file) {
    throw ApiError.badRequest('PANEL_DOCUMENT_EMPTY', 'Aucun fichier reçu.');
  }
  const { transaction } = await attachReceipt(
    req.params.transactionId,
    { buffer: req.file.buffer, filename: req.file.originalname },
    actorOf(req),
  );
  return created(res, { transaction: await getTransaction(transaction.transactionId) });
}

/**
 * TÉLÉCHARGE le justificatif — la SEULE voie de sortie d'un document privé.
 *
 * ══ CE QUE CETTE RÉPONSE NE CONTIENT JAMAIS ═════════════════════════════════
 *
 * Aucun chemin disque, aucune clé d'objet, aucune URL. L'octet du fichier et le
 * nom que l'utilisateur a déposé — rien de plus. Révéler la clé d'objet
 * n'ouvrirait aucune porte (le dossier n'est servi par personne) mais
 * renseignerait sur l'arborescence, ce qui n'apporte rien à personne d'honnête.
 *
 * `attachment` et `nosniff` sont là pour la même raison : un document ne doit
 * jamais s'ouvrir DANS l'origine du Panel. Un PDF ou une image y seraient
 * inoffensifs ; le jour où un type s'ajoutera à la table, l'en-tête sera déjà
 * en place.
 */
export async function downloadReceipt(req, res) {
  const { media, buffer } = await readReceipt(req.params.transactionId);
  const nom = (media.originalFilename || 'justificatif').replace(/"/g, '');

  /**
   * DEUX FORMES DE NOM, ET IL FAUT LES DEUX (RFC 6266 / RFC 5987).
   *
   * ══ LE DÉFAUT QUE CELA FERME ═══════════════════════════════════════════
   *
   * Un en-tête HTTP transporte des OCTETS interprétés en latin-1. Écrire
   * `filename="Facture Août.pdf"` y place de l'UTF-8 brut, que le navigateur
   * relit caractère par caractère : l'utilisateur enregistre
   * « Facture AoÃ»t.pdf ». Le fichier est intact, son nom ne l'est pas — et
   * c'est le cas NORMAL en français, pas un cas limite.
   *
   *   `filename`   repli ASCII, pour les clients anciens. Tout octet non
   *                imprimable y devient `_` : lisible, sans promesse fausse.
   *   `filename*`  la forme encodée, que tous les navigateurs actuels
   *                préfèrent quand elle est présente.
   *
   * Les deux sont émises : la seconde seule perdrait les clients qui ne la
   * connaissent pas, la première seule perdrait les accents.
   */
  const repliAscii = nom.replace(/[^ -~]/g, '_');
  res.setHeader('Content-Type', media.mime);
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="${repliAscii}"; filename*=UTF-8''${encodeURIComponent(nom)}`,
  );
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'private, no-store');
  return res.send(buffer);
}

export async function removeReceipt(req, res) {
  const { transaction } = await detachReceipt(req.params.transactionId, actorOf(req));
  return ok(res, { transaction: await getTransaction(transaction.transactionId) });
}
