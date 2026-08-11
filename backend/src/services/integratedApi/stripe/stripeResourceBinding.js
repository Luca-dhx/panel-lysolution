// L'AUTORITÉ D'APPARTENANCE STRIPE — une seule source de vérité (L6.2A).
//
// docs/architecture/STRIPE_L6_2A_RESOURCE_OWNERSHIP_REPORT.md.
//
// ── QUATRE VERBES, ET RIEN D'AUTRE ──────────────────────────────────────────
//
//   bindResource        le Panel a créé une ressource → il enregistre le lien
//   assertOwnedResource « ce projet peut-il agir sur cette ressource ? »
//   findBinding         lecture interne, sans jugement
//   listOwnedResourceIds ce que le projet possède — pour contraindre une requête
//
// ── FAIL CLOSED, ET INDISTINGUABLE ──────────────────────────────────────────
//
// Un refus ne dit jamais POURQUOI de façon exploitable : « inconnue » et
// « appartient à un autre » rendent le même code et le même message. Les
// distinguer donnerait un oracle d'existence — on présente `cus_X`, et la
// nuance du refus dit si `cus_X` existe chez nous. C'est déjà trop.
//
// ── CE QUI N'EST JAMAIS UNE PREUVE ──────────────────────────────────────────
//
// Le `projectId` du corps de la requête. Le contexte de la passerelle porte le
// projet authentifié ; ce module ne reçoit que lui, et n'accepte aucune autre
// source. La signature l'impose : il n'y a pas de paramètre par lequel un
// appelant pourrait proposer un projet différent.
import ApiError from '../../../utils/ApiError.js';
import logger from '../../../utils/logger.js';
import { nowIso } from '../../../bridge/bridgeContract.js';
import PanelStripeResourceBinding, {
  STRIPE_RESOURCE_TYPES,
  STRIPE_RESOURCE_TYPE_VALUES,
  BINDING_SOURCES,
} from '../../../models/PanelStripeResourceBinding.model.js';

export { STRIPE_RESOURCE_TYPES, STRIPE_RESOURCE_TYPE_VALUES, BINDING_SOURCES };

/** Le seul code rendu à un projet. Volontairement unique — voir plus haut. */
export const STRIPE_RESOURCE_NOT_OWNED = 'STRIPE_RESOURCE_NOT_OWNED';

/** Motifs INTERNES d'un refus. Journalisés, jamais rendus au projet. */
export const REFUSAL_REASONS = Object.freeze({
  MALFORMED_ID: 'MALFORMED_ID',
  UNKNOWN_TYPE: 'UNKNOWN_TYPE',
  NO_BINDING: 'NO_BINDING',
  OTHER_PROJECT: 'OTHER_PROJECT',
  REVOKED: 'REVOKED',
});

/**
 * Préfixes attendus, par famille. Servent à REFUSER tôt — jamais à autoriser.
 * Qu'un identifiant commence par `sub_` ne dit rien de son propriétaire ; mais
 * présenter un client là où un abonnement est attendu révèle une confusion
 * qu'il vaut mieux arrêter avant d'interroger la base.
 */
export const RESOURCE_ID_PREFIXES = Object.freeze({
  [STRIPE_RESOURCE_TYPES.CUSTOMER]: 'cus_',
  [STRIPE_RESOURCE_TYPES.CHECKOUT_SESSION]: 'cs_',
  [STRIPE_RESOURCE_TYPES.SUBSCRIPTION]: 'sub_',
  [STRIPE_RESOURCE_TYPES.PAYMENT_INTENT]: 'pi_',
  [STRIPE_RESOURCE_TYPES.INVOICE]: 'in_',
  [STRIPE_RESOURCE_TYPES.PRODUCT]: 'prod_',
  [STRIPE_RESOURCE_TYPES.PRICE]: 'price_',
});

export function looksLikeResource(resourceType, resourceId) {
  const prefix = RESOURCE_ID_PREFIXES[resourceType];
  if (!prefix) return false;
  const id = String(resourceId ?? '').trim();
  return id.startsWith(prefix) && id.length > prefix.length;
}

/** Masque d'affichage — assez pour reconnaître, jamais assez pour désigner. */
export function maskResourceId(resourceId) {
  const id = String(resourceId ?? '').trim();
  if (!id) return '';
  const underscore = id.indexOf('_');
  const prefix = underscore > 0 ? id.slice(0, underscore + 1) : '';
  return `${prefix}••••${id.slice(-4)}`;
}

/* -------------------------------------------------------------------------- */
/*  CRÉATION                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * L'INDEX DOIT EXISTER AVANT LA PREMIÈRE ÉCRITURE.
 *
 * Toute la garantie d'unicité repose sur `stripe_resource_unique` — mais
 * Mongoose construit ses index en TÂCHE DE FOND, après la connexion. Une
 * liaison écrite dans les premières secondes de vie du processus pourrait donc
 * passer alors que l'index n'existe pas encore : deux projets se verraient
 * attribuer la même ressource, et l'index refuserait ensuite de se construire,
 * en silence.
 *
 * On attend donc, une fois et une seule. Le coût est payé au premier lien ; la
 * garantie, elle, cesse d'être une question de calendrier.
 *
 * (Le même piège avait été trouvé côté projet sur l'idempotence des webhooks
 * Brevo — c'est la seconde fois qu'il se présente, et la seconde fois qu'il se
 * corrige de la même façon.)
 */
let indexesReady = null;
function ensureIndexes() {
  indexesReady ??= PanelStripeResourceBinding.init();
  return indexesReady;
}

/** Réinitialise l'attente — réservé aux tests qui recréent une base. */
export function _resetIndexReadinessForTests() {
  indexesReady = null;
}

/** Ce qu'une création a réellement fait — le rejeu doit pouvoir le distinguer. */
export const BIND_OUTCOMES = Object.freeze({
  CREATED: 'CREATED',
  /** Le lien existait déjà, à l'identique. Un rejeu, pas un doublon. */
  ALREADY_BOUND: 'ALREADY_BOUND',
});

/**
 * Enregistre le lien d'une ressource que le Panel vient de créer.
 *
 * ── L'ÉCRITURE EST TENTÉE AVANT TOUTE LECTURE ───────────────────────────────
 *
 * C'est l'index unique qui arbitre, pas un `findOne` suivi d'un `create` : deux
 * appels concurrents pour la même ressource passeraient tous deux la lecture,
 * et la garantie reposerait sur la chance. Ici, la base en refuse un — et c'est
 * ce refus qu'on interprète.
 *
 * ── LA FENÊTRE QU'ON NE PEUT PAS FERMER, ET CE QU'ON EN FAIT ────────────────
 *
 * Stripe crée l'objet, puis le lien s'écrit. Entre les deux, le processus peut
 * mourir : la ressource existe chez le fournisseur et n'appartient à personne
 * chez nous. Mongo et Stripe n'ont pas de transaction commune — la fenêtre est
 * IRRÉDUCTIBLE, et la masquer serait pire que la nommer.
 *
 * Ce qu'on en fait, et qui rend la conséquence bénigne :
 *
 *  1. l'orphelin n'est accessible à PERSONNE — fail closed, donc aucun projet
 *     ne peut s'en emparer ;
 *  2. l'opération reste dans le registre d'idempotence à l'état non résolu, et
 *     porte la même `Idempotency-Key` : la rejouer rend LE MÊME objet Stripe,
 *     et cette seconde tentative écrit le lien manquant ;
 *  3. si le rejeu n'a jamais lieu, l'orphelin reste inerte — un client Stripe
 *     sans abonnement ne coûte rien et ne fait rien.
 *
 * La récupération est donc le REJEU DE LA MÊME OPÉRATION, jamais une adoption
 * a posteriori sur foi d'un identifiant présenté.
 *
 * @returns {Promise<{outcome: string, binding: object}>}
 */
export async function bindResource({
  projectId, environment, resourceType, resourceId,
  source = BINDING_SOURCES.PANEL_CREATED, createdByOperationId = null, proof = null,
}) {
  assertBindArguments({ projectId, environment, resourceType, resourceId });
  await ensureIndexes();

  const at = nowIso();
  const document = {
    projectId,
    environment,
    resourceType,
    resourceId: String(resourceId).trim(),
    source,
    createdByOperationId,
    proof: {
      stripeMetadataContractId: proof?.stripeMetadataContractId ?? null,
      matchedProjectionContractId: proof?.matchedProjectionContractId ?? null,
      approvedBy: proof?.approvedBy ?? null,
    },
    revokedAt: null,
    revokedReason: null,
    createdAt: at,
    updatedAt: at,
  };

  try {
    const created = await PanelStripeResourceBinding.create(document);
    // On NOMME la ressource masquée : un journal d'appartenance n'a pas besoin
    // de l'identifiant complet pour être exploitable.
    logger.info(
      `[stripe-binding] ${resourceType} ${maskResourceId(resourceId)} → ${projectId} (${environment}, ${source})`,
    );
    return { outcome: BIND_OUTCOMES.CREATED, binding: created.toObject() };
  } catch (err) {
    if (err?.code !== 11000) throw err;

    /**
     * L'index a tranché. Reste à savoir ce qu'il a refusé : un rejeu du même
     * acte, ou une tentative de s'approprier la ressource d'un autre.
     */
    const existing = await PanelStripeResourceBinding.findOne({
      environment, resourceType, resourceId: String(resourceId).trim(),
    }).lean();

    if (existing && existing.projectId === projectId) {
      return { outcome: BIND_OUTCOMES.ALREADY_BOUND, binding: existing };
    }

    /**
     * CONFLIT D'APPARTENANCE — le seul cas où ce module élève la voix.
     *
     * Il ne devrait jamais se produire : une ressource créée par le Panel pour
     * un projet ne peut pas être créée une seconde fois pour un autre. S'il se
     * produit, c'est soit une collision d'identifiants (impossible chez
     * Stripe), soit un défaut de notre côté — et dans les deux cas, refuser est
     * la seule issue sûre.
     */
    logger.warn(
      `[stripe-binding] CONFLIT — ${resourceType} ${maskResourceId(resourceId)} `
      + `déjà lié à un autre projet (${environment}).`,
    );
    throw new ApiError(409, 'STRIPE_RESOURCE_ALREADY_BOUND',
      'Cette ressource Stripe est déjà attribuée à un autre projet.',
      { resourceType, environment });
  }
}

function assertBindArguments({ projectId, environment, resourceType, resourceId }) {
  if (!projectId) {
    throw ApiError.badRequest('STRIPE_BINDING_INVALID', 'Aucun projet : un lien sans propriétaire n’a pas de sens.');
  }
  if (!environment) {
    throw ApiError.badRequest('STRIPE_BINDING_INVALID', 'Aucun environnement : le monde ne se devine pas.');
  }
  if (!STRIPE_RESOURCE_TYPE_VALUES.includes(resourceType)) {
    throw ApiError.badRequest('STRIPE_BINDING_INVALID', `Type de ressource inconnu : « ${resourceType} ».`);
  }
  if (!looksLikeResource(resourceType, resourceId)) {
    throw ApiError.badRequest('STRIPE_BINDING_INVALID', `Identifiant incompatible avec le type ${resourceType}.`);
  }
}

/* -------------------------------------------------------------------------- */
/*  LECTURE                                                                   */
/* -------------------------------------------------------------------------- */

/** Le lien, ou `null`. Aucun jugement — l'appelant décide. */
export async function findBinding({ environment, resourceType, resourceId }) {
  if (!looksLikeResource(resourceType, resourceId)) return null;
  return PanelStripeResourceBinding.findOne({
    environment, resourceType, resourceId: String(resourceId).trim(),
  }).lean();
}

/**
 * LE LIEN LAISSÉ PAR UN ACTE — la trace qui rend une reprise sûre (L6.2B).
 *
 * ══ POURQUOI CETTE LECTURE EXISTE ═══════════════════════════════════════════
 *
 * Entre « Stripe a créé la session » et « le Panel a écrit le lien », il y a une
 * fenêtre qu'aucune transaction ne referme (L6.2A §fenêtre). Le lot suivant a
 * besoin de la rendre REPRENABLE, et une reprise a besoin d'une question
 * précise : « cet acte a-t-il déjà produit une ressource ? ».
 *
 * `createdByOperationId` porte la réponse. Il est écrit dans le MÊME document
 * que l'identifiant Stripe : soit les deux existent, soit aucun. Il n'y a donc
 * pas d'état intermédiaire où l'on saurait qu'un acte a eu lieu sans savoir ce
 * qu'il a produit.
 *
 * ══ POURQUOI LE PROJET ET LE MONDE SONT DANS LE FILTRE ══════════════════════
 *
 * `operationId` est frappé par le PROJET : deux projets peuvent légitimement
 * choisir le même. Chercher sans le projet ferait converger la reprise de l'un
 * vers la session de l'autre — exactement le vol que L6.2A rend impossible.
 */
export async function findBindingByOperation({ projectId, environment, resourceType, operationId }) {
  if (!projectId || !environment || !operationId) return null;
  return PanelStripeResourceBinding.findOne({
    projectId, environment, resourceType, createdByOperationId: String(operationId).trim(),
  }).lean();
}

/**
 * Verdict d'appartenance, structuré. Ne lève pas : un écran de diagnostic doit
 * pouvoir expliquer un refus sans rejouer la logique.
 */
export async function describeOwnership({ projectId, environment, resourceType, resourceId }) {
  const base = { allowed: false, resourceType, resourceId: String(resourceId ?? '').trim() };

  if (!STRIPE_RESOURCE_TYPE_VALUES.includes(resourceType)) {
    return { ...base, reason: REFUSAL_REASONS.UNKNOWN_TYPE };
  }
  if (!looksLikeResource(resourceType, resourceId)) {
    return { ...base, reason: REFUSAL_REASONS.MALFORMED_ID };
  }

  const binding = await findBinding({ environment, resourceType, resourceId });
  if (!binding) return { ...base, reason: REFUSAL_REASONS.NO_BINDING };
  if (binding.projectId !== projectId) return { ...base, reason: REFUSAL_REASONS.OTHER_PROJECT };
  if (binding.revokedAt) return { ...base, reason: REFUSAL_REASONS.REVOKED };

  return { ...base, allowed: true, reason: null, source: binding.source, boundAt: binding.createdAt };
}

/**
 * Variante levante, pour un adaptateur.
 *
 * Le message est le MÊME quel que soit le motif : « inconnue », « à un autre »
 * et « révoquée » sont indistinguables côté projet. Le motif réel part au
 * journal, où il sert au diagnostic sans servir de sonde.
 */
export async function assertOwnedResource({ projectId, environment, resourceType, resourceId }) {
  const verdict = await describeOwnership({ projectId, environment, resourceType, resourceId });
  if (verdict.allowed) return verdict;

  logger.warn(
    `[stripe-binding] refus ${verdict.reason} — ${resourceType} `
    + `${maskResourceId(resourceId)} demandé par ${projectId} (${environment}).`,
  );
  throw new ApiError(403, STRIPE_RESOURCE_NOT_OWNED,
    'Ressource Stripe inconnue ou non autorisée pour ce projet.',
    { resourceType });
}

/**
 * Les identifiants qu'un projet possède, par famille.
 *
 * ── À QUOI CELA SERT, ET À QUOI CELA NE SERT PAS ────────────────────────────
 *
 * Cela sert à CONTRAINDRE une requête sortante — demander à Stripe les factures
 * d'un client qu'on possède, plutôt que lister le compte et trier après coup.
 *
 * Cela ne sert PAS à filtrer une réponse déjà obtenue : un filtre a posteriori
 * suppose qu'on a d'abord demandé plus que son dû, et il suffit d'un oubli dans
 * le filtre pour que le surplus traverse.
 */
export async function listOwnedResourceIds({ projectId, environment, resourceType }) {
  const bindings = await PanelStripeResourceBinding.find({
    projectId, environment, resourceType, revokedAt: null,
  }).select('resourceId').lean();
  return bindings.map((b) => b.resourceId);
}

/**
 * Neutralise un lien SANS le réattribuer.
 *
 * L'identifiant reste pris : personne ne peut révoquer puis rebinder vers un
 * autre projet. C'est ce qui distingue une neutralisation d'une suppression.
 */
export async function revokeBinding({ environment, resourceType, resourceId, reason = null }) {
  const at = nowIso();
  const result = await PanelStripeResourceBinding.updateOne(
    { environment, resourceType, resourceId: String(resourceId).trim(), revokedAt: null },
    { $set: { revokedAt: at, revokedReason: reason, updatedAt: at } },
  );
  return { revoked: result.modifiedCount === 1 };
}

/* -------------------------------------------------------------------------- */
/*  DIAGNOSTIC                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Ce qu'un écran a le droit de montrer : des nombres et des types.
 *
 * Jamais la liste des identifiants. Un inventaire des clients d'un compte
 * Stripe n'a rien à faire sur un écran d'administration — et ce que personne
 * n'affiche ne peut pas fuir par une capture d'écran.
 */
export async function describeBindingInventory({ projectId = null } = {}) {
  const filter = projectId ? { projectId } : {};
  const rows = await PanelStripeResourceBinding.find(filter)
    .select('projectId environment resourceType revokedAt')
    .lean();

  const par = new Map();
  for (const row of rows) {
    const key = `${row.environment}|${row.resourceType}`;
    const entry = par.get(key) ?? { environment: row.environment, resourceType: row.resourceType, active: 0, revoked: 0 };
    if (row.revokedAt) entry.revoked += 1;
    else entry.active += 1;
    par.set(key, entry);
  }
  return {
    projectId,
    total: rows.length,
    byEnvironmentAndType: [...par.values()].sort(
      (a, b) => a.environment.localeCompare(b.environment) || a.resourceType.localeCompare(b.resourceType),
    ),
  };
}

export default {
  STRIPE_RESOURCE_TYPES,
  STRIPE_RESOURCE_TYPE_VALUES,
  BINDING_SOURCES,
  BIND_OUTCOMES,
  REFUSAL_REASONS,
  STRIPE_RESOURCE_NOT_OWNED,
  looksLikeResource,
  maskResourceId,
  bindResource,
  findBinding,
  findBindingByOperation,
  describeOwnership,
  assertOwnedResource,
  listOwnedResourceIds,
  revokeBinding,
  describeBindingInventory,
};
