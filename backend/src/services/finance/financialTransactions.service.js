/**
 * REGISTRE FINANCIER — écriture, lecture, correction, retrait.
 *
 * ══ AUCUN FOURNISSEUR N'EST APPELÉ DEPUIS CE FICHIER ════════════════════════
 *
 * Ni Stripe, ni la passerelle de capacités, ni le pont, ni le moindre `fetch`.
 * Le registre est une DESTINATION métier : quelque chose se produit ailleurs,
 * et une ligne s'inscrit ici. L'inverse — un service comptable qui interroge un
 * fournisseur pour savoir ce qu'il doit écrire — est exactement la construction
 * qui rend un bilan dépendant de la disponibilité d'une API tierce.
 *
 * Le lot suivant branchera Stripe en AMONT (événement fournisseur → plan de
 * contrôle → mouvement canonique), sans que rien ici n'ait à changer : il
 * suffira d'appeler une création avec `origin: STRIPE` et une provenance
 * renseignée. C'est la seule raison pour laquelle la création interne
 * (`recordTransaction`) est séparée de la création MANUELLE.
 *
 * ══ CE QU'ON PEUT MODIFIER, ET CE QU'ON NE POURRA PAS ═══════════════════════
 *
 * Un mouvement MANUEL se corrige : il a été saisi par un humain, qui se trompe
 * de montant, de date ou de projet. Refuser la correction ne rend pas le
 * registre plus vrai — il le fige sur l'erreur, et pousse à saisir une
 * contre-écriture bricolée pour la compenser.
 *
 * Un mouvement d'origine AUTOMATIQUE ne se corrigera pas. Il constate ce qu'un
 * fournisseur a fait ; le corriger à la main ferait diverger le registre de la
 * réalité bancaire, en silence. La distinction est posée MAINTENANT
 * (`assertEditable`), avant qu'aucune source automatique n'existe — parce
 * qu'elle sera impossible à introduire après coup sans casser des écrans.
 */
import { randomUUID } from 'node:crypto';

import ApiError from '../../utils/ApiError.js';
import {
  CATEGORIES,
  CATEGORY_VALUES,
  FLOWS,
  FLOW_IMPOSED_BY_CATEGORY,
  FLOW_VALUES,
  ORIGINS,
  ORIGIN_VALUES,
  STATUSES,
  PanelFinancialTransaction,
} from '../../models/PanelFinancialTransaction.model.js';
import { EVENT_TYPES } from '../../models/PanelSupervision.model.js';
import logger from '../../utils/logger.js';
import { recordEvent } from '../supervision/timeline.service.js';
import { getProjectOrThrow } from '../registry/projectRegistry.service.js';
import { normalizeCurrency, parseAmountToCents } from './money.js';
import { dateFilterFor, parseBusinessDate, resolvePeriod } from './period.js';

/**
 * LES CATÉGORIES OFFERTES À LA SAISIE — deux, et pas quatre.
 *
 * `REFUND` existe au modèle mais ne se saisit pas : un remboursement se
 * RATTACHE à un paiement (`parentTransactionId`), et ce paiement n'existe pas
 * encore dans le registre — aucune source ne l'y écrit. Laisser saisir un
 * remboursement orphelin fabriquerait des lignes qui ressemblent au futur sans
 * en avoir les garanties, et qu'il faudrait reprendre au lot L10.4.
 *
 * `ADJUSTMENT` est écarté pour la raison inverse : c'est une écriture de
 * correction comptable, et tant que la correction directe d'une ligne manuelle
 * est permise, elle n'a aucun emploi.
 */
export const MANUAL_CATEGORIES = Object.freeze([CATEGORIES.REVENUE, CATEGORIES.COST]);

/** Portées de lecture. Explicites : aucune ne se déduit d'un paramètre absent. */
export const SCOPES = Object.freeze({
  /** Tout le registre — projets et L.Y Solution. La page Finances globale. */
  ALL: 'all',
  /** Un projet nommé. Exige `projectId`. */
  PROJECT: 'project',
  /** Les mouvements propres à L.Y Solution (`projectId: null`). */
  COMPANY: 'company',
});
export const SCOPE_VALUES = Object.freeze(Object.values(SCOPES));

const SORTS = Object.freeze({
  DATE_DESC: { effectiveDate: -1, _id: -1 },
  DATE_ASC: { effectiveDate: 1, _id: 1 },
  AMOUNT_DESC: { amountCents: -1, _id: -1 },
  AMOUNT_ASC: { amountCents: 1, _id: 1 },
});
export const SORT_VALUES = Object.freeze(Object.keys(SORTS));

/** Borne de lecture — une page d'écran, jamais un registre entier en mémoire. */
const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 1000;

/* ── Rattachement ──────────────────────────────────────────────────────────── */

/**
 * VALIDE LE RATTACHEMENT et rend le couple `{ projectId, projectNameSnapshot }`.
 *
 * Un `projectId` absent, nul ou vide se lit « L.Y Solution » — c'est un
 * rattachement, pas une omission. Un `projectId` RENSEIGNÉ, en revanche, doit
 * exister au registre : sans ce contrôle, une faute de frappe créerait un
 * mouvement rattaché à un projet fantôme, invisible sur toutes les fiches et
 * pourtant compté dans le bénéfice global. Ce serait la pire des deux erreurs
 * possibles — un écart réel, sans aucun écran pour le montrer.
 */
async function resolveOwnership(projectId) {
  if (projectId === undefined || projectId === null || String(projectId).trim() === '') {
    return { projectId: null, projectNameSnapshot: null };
  }
  const record = await getProjectOrThrow(String(projectId).trim());
  return { projectId: record.projectId, projectNameSnapshot: record.projectName ?? null };
}

/* ── Taxonomie ─────────────────────────────────────────────────────────────── */

/**
 * Vérifie la cohérence des deux axes, et DÉDUIT le sens quand il est imposé.
 *
 * Le schéma Mongoose sait valider chaque champ isolément ; il ne sait pas dire
 * qu'un `REVENUE` en `OUTFLOW` est absurde. La contrainte croisée vit donc ici,
 * en un seul endroit, traversée par toutes les écritures.
 */
function resolveTaxonomy(category, flow) {
  if (!CATEGORY_VALUES.includes(category)) {
    throw ApiError.badRequest(
      'PANEL_FINANCE_CATEGORY_UNKNOWN',
      `Catégorie inconnue : ${category}. Attendu : ${CATEGORY_VALUES.join(', ')}.`,
    );
  }
  const impose = FLOW_IMPOSED_BY_CATEGORY[category];
  if (impose) {
    // Un sens explicite qui CONTREDIT la catégorie est un refus, jamais une
    // correction silencieuse : l'appelant croit une chose, le registre en
    // écrirait une autre.
    if (flow && flow !== impose) {
      throw ApiError.badRequest(
        'PANEL_FINANCE_FLOW_INCONSISTENT',
        `Un mouvement de catégorie ${category} est toujours ${impose}.`,
      );
    }
    return impose;
  }
  if (!FLOW_VALUES.includes(flow)) {
    throw ApiError.badRequest(
      'PANEL_FINANCE_FLOW_REQUIRED',
      `La catégorie ${category} n'impose pas de sens : précisez ${FLOW_VALUES.join(' ou ')}.`,
    );
  }
  return flow;
}

function requireLabel(value) {
  const label = String(value ?? '').trim();
  if (!label) {
    throw ApiError.badRequest('PANEL_FINANCE_LABEL_REQUIRED', 'Un nom est requis.');
  }
  if (label.length > 160) {
    throw ApiError.badRequest('PANEL_FINANCE_LABEL_TOO_LONG', 'Le nom dépasse 160 caractères.');
  }
  return label;
}

/* ── Écriture ──────────────────────────────────────────────────────────────── */

/**
 * ÉCRITURE INTERNE — le seul point par lequel une ligne entre au registre.
 *
 * Non exposé par l'API : `origin` et `provenance` sont des faits de système,
 * jamais des champs de formulaire. Un client HTTP qui pourrait poser
 * `origin: STRIPE` fabriquerait des revenus qui ressemblent à s'y méprendre à
 * de vrais encaissements.
 *
 * C'est CETTE fonction que le lot Stripe appellera. Elle ne connaît aucun
 * fournisseur : elle prend une provenance déjà résolue, et l'inscrit.
 */
export async function recordTransaction({
  projectId = null,
  projectNameSnapshot = null,
  category,
  flow = null,
  origin = ORIGINS.MANUAL,
  status = STATUSES.RECORDED,
  label,
  description = '',
  amountCents,
  currency,
  effectiveDate,
  parentTransactionId = null,
  provenance = {},
  actor = {},
}) {
  if (!ORIGIN_VALUES.includes(origin)) {
    throw ApiError.badRequest('PANEL_FINANCE_ORIGIN_UNKNOWN', `Origine inconnue : ${origin}.`);
  }
  const document = await PanelFinancialTransaction.create({
    transactionId: randomUUID(),
    projectId,
    projectNameSnapshot,
    flow: resolveTaxonomy(category, flow),
    category,
    origin,
    status,
    label: requireLabel(label),
    description: String(description ?? '').trim(),
    amountCents,
    currency: normalizeCurrency(currency),
    effectiveDate,
    parentTransactionId,
    provenance: {
      provider: provenance.provider ?? null,
      environment: provenance.environment ?? null,
      externalId: provenance.externalId ?? null,
      externalKind: provenance.externalKind ?? null,
    },
    createdBy: actor.email ?? null,
    updatedBy: actor.email ?? null,
  });

  await journal(EVENT_TYPES.FINANCIAL_TRANSACTION_CREATED, document, actor, {
    summary: `Mouvement « ${document.label} » enregistré.`,
  });
  return document;
}

/**
 * SAISIE MANUELLE — le seul flux d'écriture ouvert par l'API en L10.1.
 *
 * Elle n'accepte ni origine, ni provenance, ni transaction parente : trois
 * champs qu'aucun humain ne renseigne, et dont l'ouverture donnerait à un
 * navigateur le pouvoir de contrefaire un encaissement fournisseur.
 */
export async function createManualTransaction(input = {}, actor = {}) {
  const category = String(input.category ?? '').toUpperCase();
  if (!MANUAL_CATEGORIES.includes(category)) {
    throw ApiError.badRequest(
      'PANEL_FINANCE_CATEGORY_NOT_MANUAL',
      `Une saisie manuelle est un revenu ou un coût (${MANUAL_CATEGORIES.join(', ')}). `
      + 'Les remboursements et corrections viendront de leur source, pas d’un formulaire.',
    );
  }

  const ownership = await resolveOwnership(input.projectId);

  return recordTransaction({
    ...ownership,
    category,
    origin: ORIGINS.MANUAL,
    status: STATUSES.RECORDED,
    label: input.label,
    description: input.description ?? '',
    amountCents: parseAmountToCents(input.amount, 'montant'),
    currency: input.currency ?? undefined,
    effectiveDate: parseBusinessDate(input.effectiveDate, 'date'),
    actor,
  });
}

/* ── Correction ────────────────────────────────────────────────────────────── */

/** Charge un mouvement par son identité publique, ou refuse. */
async function loadOrThrow(transactionId) {
  const document = await PanelFinancialTransaction.findOne({ transactionId });
  if (!document) {
    throw ApiError.notFound('PANEL_FINANCE_TRANSACTION_NOT_FOUND', 'Mouvement introuvable.');
  }
  return document;
}

/**
 * « Ce mouvement se corrige-t-il ? » — une question, un endroit.
 *
 * Deux refus, et ils ne disent pas la même chose : un mouvement supprimé se
 * restaure d'abord (rien ne le permet en L10.1, donc il est définitivement
 * clos) ; un mouvement automatique ne se corrige jamais à la main.
 */
export function editability(document) {
  if (document.deletedAt) {
    return {
      editable: false,
      code: 'PANEL_FINANCE_TRANSACTION_DELETED',
      reason: 'Ce mouvement est supprimé : il ne participe plus aux totaux et ne se modifie plus.',
    };
  }
  if (document.origin !== ORIGINS.MANUAL) {
    return {
      editable: false,
      code: 'PANEL_FINANCE_TRANSACTION_NOT_MANUAL',
      reason: `Ce mouvement vient de ${document.origin} : il constate un fait externe et ne se corrige pas à la main.`,
    };
  }
  return { editable: true, code: null, reason: null };
}

function assertEditable(document) {
  const verdict = editability(document);
  if (!verdict.editable) throw ApiError.conflict(verdict.code, verdict.reason);
}

/**
 * CORRIGER une saisie manuelle.
 *
 * Chaque champ SENSIBLE modifié — montant, catégorie, date d'effet,
 * rattachement — part au journal avec son avant et son après. Une correction
 * de libellé n'a pas besoin de ce traitement ; un montant qui passe de 249 € à
 * 2 490 € en a absolument besoin.
 */
export async function updateManualTransaction(transactionId, patch = {}, actor = {}) {
  const document = await loadOrThrow(transactionId);
  assertEditable(document);

  const avant = {
    category: document.category,
    amountCents: document.amountCents,
    effectiveDate: document.effectiveDate,
    projectId: document.projectId,
  };

  if (patch.label !== undefined) document.label = requireLabel(patch.label);
  if (patch.description !== undefined) document.description = String(patch.description ?? '').trim();
  if (patch.amount !== undefined) document.amountCents = parseAmountToCents(patch.amount, 'montant');
  if (patch.currency !== undefined) document.currency = normalizeCurrency(patch.currency);
  if (patch.effectiveDate !== undefined) {
    document.effectiveDate = parseBusinessDate(patch.effectiveDate, 'date');
  }
  if (patch.category !== undefined) {
    const category = String(patch.category).toUpperCase();
    if (!MANUAL_CATEGORIES.includes(category)) {
      throw ApiError.badRequest(
        'PANEL_FINANCE_CATEGORY_NOT_MANUAL',
        `Une saisie manuelle est un revenu ou un coût (${MANUAL_CATEGORIES.join(', ')}).`,
      );
    }
    document.category = category;
    // Le sens SUIT la catégorie, il ne se saisit jamais séparément — sinon un
    // « coût » pourrait rester en INFLOW et augmenter le bénéfice.
    document.flow = resolveTaxonomy(category, null);
  }
  if (patch.projectId !== undefined) {
    const ownership = await resolveOwnership(patch.projectId);
    document.projectId = ownership.projectId;
    document.projectNameSnapshot = ownership.projectNameSnapshot;
  }

  document.updatedBy = actor.email ?? null;
  await document.save();

  const changements = {};
  if (avant.category !== document.category) {
    changements.category = { from: avant.category, to: document.category };
  }
  if (avant.amountCents !== document.amountCents) {
    changements.amountCents = { from: avant.amountCents, to: document.amountCents };
  }
  if (avant.effectiveDate?.getTime() !== document.effectiveDate?.getTime()) {
    changements.effectiveDate = {
      from: avant.effectiveDate?.toISOString() ?? null,
      to: document.effectiveDate?.toISOString() ?? null,
    };
  }
  if (avant.projectId !== document.projectId) {
    changements.projectId = { from: avant.projectId, to: document.projectId };
  }

  await journal(EVENT_TYPES.FINANCIAL_TRANSACTION_UPDATED, document, actor, {
    summary: `Mouvement « ${document.label} » corrigé.`,
    extra: { changes: changements },
  });
  return document;
}

/* ── Retrait ───────────────────────────────────────────────────────────────── */

/**
 * SUPPRESSION LOGIQUE — la ligne quitte les totaux, jamais la base.
 *
 * Rejouer la suppression d'un mouvement déjà supprimé n'est PAS une erreur :
 * l'état visé est atteint. Lever ici ferait échouer un double-clic sur un
 * bouton, ce qui est l'usage normal d'un bouton.
 */
export async function softDeleteTransaction(transactionId, { reason = null } = {}, actor = {}) {
  const document = await loadOrThrow(transactionId);
  if (document.deletedAt) return document;

  await assertNoLivingRefunds(document);

  document.deletedAt = new Date();
  document.deletedBy = actor.email ?? null;
  document.deletionReason = reason ? String(reason).trim() : null;
  await document.save();

  await journal(EVENT_TYPES.FINANCIAL_TRANSACTION_DELETED, document, actor, {
    severity: 'WARNING',
    summary: `Mouvement « ${document.label} » retiré des totaux.`,
    extra: { reason: document.deletionReason },
  });
  return document;
}

/**
 * UN ENCAISSEMENT REMBOURSÉ NE SE RETIRE PAS SEUL (L10.4).
 *
 * ══ LA FALSIFICATION QUE CETTE GARDE FERME ══════════════════════════════════
 *
 * Un revenu de 500 €, remboursé de 100 €, laisse deux lignes : `+500 INFLOW` et
 * `−100 OUTFLOW`. Retirer la première sans la seconde ne produit pas « rien » —
 * il produit un net de **−100 €** sur une opération qui, dans la réalité, a
 * rapporté 400 €. Le registre affirmerait alors une perte qui n'a jamais eu
 * lieu, et personne ne saurait d'où elle vient : la ligne qui l'expliquait a
 * disparu.
 *
 * C'est pire qu'un chiffre faux — c'est un chiffre faux SANS trace. La
 * suppression est donc refusée tant qu'un remboursement vivant s'y rattache.
 *
 * ══ POURQUOI PAS UNE CASCADE ════════════════════════════════════════════════
 *
 * Retirer automatiquement les enfants effacerait un mouvement d'argent RÉEL —
 * les 100 € sont bien repartis chez le client — sur une décision que personne
 * n'a prise explicitement. Une cascade silencieuse sur des sommes est
 * exactement ce qu'un registre comptable ne doit jamais faire. On refuse, on
 * nomme, et l'opérateur tranche.
 */
async function assertNoLivingRefunds(document) {
  if (document.category === CATEGORIES.REFUND) return;

  const vivants = await PanelFinancialTransaction.countDocuments({
    parentTransactionId: document.transactionId,
    category: CATEGORIES.REFUND,
    deletedAt: null,
  });
  if (vivants === 0) return;

  throw ApiError.conflict(
    'PANEL_FINANCE_TRANSACTION_HAS_REFUNDS',
    `Ce mouvement porte ${vivants} remboursement(s) : le retirer laisserait des sorties `
    + 'sans l’encaissement qui les explique, et le résultat afficherait une perte qui n’a '
    + 'pas eu lieu. Retirez d’abord les remboursements, si c’est bien ce que vous voulez.',
    { refunds: vivants },
  );
}

/** Le mot que l'utilisateur doit RETAPER pour une suppression en masse. */
export const BULK_CONFIRMATION = 'SUPPRIMER';

/**
 * SUPPRESSION EN MASSE — bornée par une portée EXPLICITE.
 *
 * ══ CE QUE CETTE FONCTION NE FERA JAMAIS ════════════════════════════════════
 *
 * `deleteMany({})`. Ni par défaut, ni par omission d'un paramètre, ni parce
 * qu'un filtre est arrivé vide. La portée n'a pas de valeur par défaut : une
 * requête qui ne la précise pas est REFUSÉE. C'est la seule protection qui
 * tient, parce qu'elle ne dépend d'aucune vigilance à l'appel.
 *
 * ══ TROIS PORTÉES, ÉTANCHES ═════════════════════════════════════════════════
 *
 *   `project` + projectId   les mouvements de CE projet, et d'aucun autre.
 *   `company`               les mouvements propres à L.Y Solution.
 *   `all`                   tout le registre — le geste le plus lourd du Panel.
 *
 * Depuis la fiche du projet A, la portée est `project` et le filtre porte
 * `projectId: A`. Aucune combinaison de paramètres ne permet d'y atteindre le
 * projet B : ce n'est pas un contrôle ajouté au filtre, c'est le filtre.
 *
 * ══ TOUTES PÉRIODES CONFONDUES, ET C'EST DIT ════════════════════════════════
 *
 * La suppression en masse ignore la période affichée. Supprimer « ce qui est à
 * l'écran » serait un piège : deux utilisateurs sur deux filtres différents
 * appuieraient sur le même bouton et n'effaceraient pas la même chose. L'écran
 * annonce donc le nombre EXACT de lignes concernées, tel que rendu par
 * `countBulkScope`, avant de demander confirmation.
 *
 * ══ POURQUOI ELLE N'A PAS BESOIN DE LA GARDE UNITAIRE (L10.4) ═══════════════
 *
 * La suppression d'une seule ligne refuse de retirer un encaissement qui porte
 * des remboursements vivants : elle laisserait des sorties orphelines, et le
 * résultat afficherait une perte qui n'a pas eu lieu.
 *
 * Ici, le problème ne se pose pas — et ce n'est pas une chance, c'est la portée
 * qui le garantit. Un remboursement porte le MÊME `projectId` que l'encaissement
 * qu'il défait : il n'existe aucune portée (`project`, `company`, `all`) qui
 * retienne l'un sans l'autre. Le couple part ensemble, ou reste ensemble, et le
 * net ne peut donc pas basculer du mauvais côté.
 *
 * ══ CE QUE « TOUT SUPPRIMER » NE FAIT PAS, ET NE PEUT PAS FAIRE ═════════════
 *
 * Il ne rembourse rien, il n'annule rien chez Stripe, et il ne « défait » aucun
 * remboursement déjà émis. L'argent rendu l'est resté. Vider le livret retire
 * des LIGNES d'un registre ; le monde extérieur, lui, ne s'en aperçoit pas.
 *
 * Il ne détruit pas non plus les faits fournisseur : ceux-ci vivent dans leur
 * propre inbox, et leur clé d'identité externe reste occupée par la pierre
 * tombale de la transaction. C'est ce qui empêche un rejeu de webhook de
 * ressusciter demain ce qu'on vient d'effacer — voir `upsertTransaction`.
 */
export async function bulkSoftDelete({ scope, projectId = null, reason = null, confirm } = {}, actor = {}) {
  const { filtre, cible } = await bulkScopeFilter(scope, projectId);

  if (String(confirm ?? '') !== BULK_CONFIRMATION) {
    throw ApiError.badRequest(
      'PANEL_FINANCE_BULK_CONFIRMATION_REQUIRED',
      `Cette suppression exige une confirmation explicite : saisissez « ${BULK_CONFIRMATION} ».`,
    );
  }

  const result = await PanelFinancialTransaction.updateMany(
    { ...filtre, deletedAt: null },
    {
      $set: {
        deletedAt: new Date(),
        deletedBy: actor.email ?? null,
        deletionReason: reason ? String(reason).trim() : null,
      },
    },
  );

  const deleted = result.modifiedCount ?? 0;
  // Le journal reçoit UNE entrée pour le geste, pas une par ligne : c'est la
  // décision qui est imputable, et une rafale de trois cents entrées noierait
  // la chronologie du projet sans rien apprendre de plus.
  //
  // Il consigne le projet RÉSOLU, jamais la chaîne reçue : la trace doit
  // désigner la même fiche que le filtre qui vient de s'appliquer.
  await recordEvent({
    projectId: cible,
    type: EVENT_TYPES.FINANCIAL_TRANSACTION_DELETED,
    source: 'PANEL',
    severity: 'WARNING',
    summary: `${deleted} mouvement(s) retirés des totaux (portée ${scope}).`,
    data: {
      bulk: true,
      scope,
      projectId: cible,
      deleted,
      reason: reason ? String(reason).trim() : null,
      actor: actor.email ?? null,
    },
  });

  /**
   * LES RÈGLES RÉCURRENTES SURVIVENT — et le résultat le dit.
   *
   * Vider le livret n'arrête aucun abonnement. Les occurrences déjà produites
   * ne ressuscitent pas (leur clé de cycle reste occupée, voir l'index unique),
   * mais les cycles À VENIR seront matérialisés normalement. L'appelant reçoit
   * le nombre de règles concernées pour pouvoir le dire à l'écran.
   */
  const { PanelRecurringCost, RECURRING_STATUS } = await import('../../models/PanelRecurringCost.model.js');
  const activeRecurringCosts = await PanelRecurringCost.countDocuments({
    ...filtre,
    status: RECURRING_STATUS.ACTIVE,
  });

  return { deleted, scope, projectId: cible, activeRecurringCosts };
}

/**
 * Le filtre d'une portée de masse — la portée est OBLIGATOIRE et vérifiée.
 *
 * Rend AUSSI le projet résolu : c'est lui qui part au journal, pour que la
 * trace et le filtre ne puissent pas désigner deux choses différentes.
 */
async function bulkScopeFilter(scope, projectId) {
  switch (scope) {
    case SCOPES.PROJECT: {
      const ownership = await resolveOwnership(projectId);
      if (!ownership.projectId) {
        throw ApiError.badRequest(
          'PANEL_FINANCE_SCOPE_PROJECT_REQUIRED',
          'La portée « projet » exige un projet.',
        );
      }
      return { filtre: { projectId: ownership.projectId }, cible: ownership.projectId };
    }
    case SCOPES.COMPANY:
      return { filtre: { projectId: null }, cible: null };
    case SCOPES.ALL:
      return { filtre: {}, cible: null };
    default:
      throw ApiError.badRequest(
        'PANEL_FINANCE_SCOPE_REQUIRED',
        `Précisez la portée de la suppression : ${SCOPE_VALUES.join(', ')}.`,
      );
  }
}

/**
 * CE QU'UNE SUPPRESSION EN MASSE RETIRERAIT — et ce qu'elle NE retirerait PAS.
 *
 * ══ POURQUOI LES RÈGLES RÉCURRENTES SONT COMPTÉES ICI (L10.2) ═══════════════
 *
 * « Tout supprimer » vide le LEDGER. Il ne touche pas aux règles de coût
 * récurrent : une règle n'est pas un mouvement, et l'arrêter serait une seconde
 * décision, que personne n'a prise en cliquant sur ce bouton.
 *
 * La conséquence est contre-intuitive, et c'est précisément pour cela qu'elle
 * doit être ANNONCÉE : les règles actives continueront de produire des coûts
 * après le vidage, et la première relecture d'écran en matérialisera de
 * nouveaux. Un utilisateur qui découvre ça tout seul conclut à un bogue.
 *
 * On ne « corrige » donc pas le comportement — on le dit. Arrêter une règle
 * reste un geste explicite, avec son propre choix de portée temporelle.
 */
export async function countBulkScope({ scope, projectId = null } = {}) {
  const { filtre } = await bulkScopeFilter(scope, projectId);
  const { PanelRecurringCost, RECURRING_STATUS } = await import('../../models/PanelRecurringCost.model.js');

  const [count, activeRecurringCosts] = await Promise.all([
    PanelFinancialTransaction.countDocuments({ ...filtre, deletedAt: null }),
    PanelRecurringCost.countDocuments({ ...filtre, status: RECURRING_STATUS.ACTIVE }),
  ]);
  return { count, activeRecurringCosts };
}

/* ── Lecture ───────────────────────────────────────────────────────────────── */

/**
 * Construit le filtre Mongo d'une demande de lecture.
 *
 * Exporté parce que l'agrégateur DOIT utiliser exactement le même : deux
 * constructions parallèles de « ce qui compte » finiraient par diverger, et le
 * total affiché ne correspondrait plus à la liste affichée juste en dessous.
 */
export async function buildQueryFilter({
  scope = SCOPES.ALL,
  projectId = null,
  period,
  start,
  end,
  category = null,
  flow = null,
  search = null,
  includeDeleted = false,
  now,
} = {}) {
  if (!SCOPE_VALUES.includes(scope)) {
    throw ApiError.badRequest(
      'PANEL_FINANCE_SCOPE_UNKNOWN',
      `Portée inconnue : ${scope}. Attendu : ${SCOPE_VALUES.join(', ')}.`,
    );
  }

  const filtre = {};

  if (scope === SCOPES.PROJECT) {
    const ownership = await resolveOwnership(projectId);
    if (!ownership.projectId) {
      throw ApiError.badRequest(
        'PANEL_FINANCE_SCOPE_PROJECT_REQUIRED',
        'La portée « projet » exige un projet.',
      );
    }
    filtre.projectId = ownership.projectId;
  } else if (scope === SCOPES.COMPANY) {
    filtre.projectId = null;
  }

  // Le défaut est SANS supprimés : un total et une liste ne doivent jamais
  // avoir à se souvenir de l'exclure.
  if (!includeDeleted) filtre.deletedAt = null;

  const resolved = resolvePeriod({ period, start, end, now });
  Object.assign(filtre, dateFilterFor(resolved));

  /**
   * UNE CATÉGORIE, OU PLUSIEURS SÉPARÉES PAR UNE VIRGULE (L10.4).
   *
   * ══ POURQUOI CE PLURIEL EST DEVENU NÉCESSAIRE ═════════════════════════════
   *
   * Le sous-onglet « Revenus » filtrait sur `REVENUE`, et cela suffisait tant
   * que rien d'autre ne concernait un encaissement. Un remboursement est
   * pourtant de catégorie `REFUND` : sur ce filtre-là, il devient INVISIBLE, et
   * l'écran des revenus montre 500 € encaissés sans dire que 100 sont repartis.
   *
   * L'alternative aurait été de le ranger en `COST` pour qu'il apparaisse
   * quelque part. C'est précisément ce que la doctrine interdit : il gonflerait
   * les charges et fausserait toute analyse de marge. Le filtre s'élargit donc,
   * plutôt que la taxonomie ne se déforme.
   */
  if (category) {
    const valeurs = String(category).split(',').map((c) => c.trim().toUpperCase()).filter(Boolean);
    const inconnue = valeurs.find((v) => !CATEGORY_VALUES.includes(v));
    if (inconnue || valeurs.length === 0) {
      throw ApiError.badRequest(
        'PANEL_FINANCE_CATEGORY_UNKNOWN',
        `Catégorie inconnue : ${inconnue ?? category}.`,
      );
    }
    filtre.category = valeurs.length === 1 ? valeurs[0] : { $in: valeurs };
  }

  if (flow) {
    const valeur = String(flow).toUpperCase();
    if (!FLOW_VALUES.includes(valeur)) {
      throw ApiError.badRequest('PANEL_FINANCE_FLOW_UNKNOWN', `Sens inconnu : ${valeur}.`);
    }
    filtre.flow = valeur;
  }

  const terme = String(search ?? '').trim();
  if (terme) {
    // Échappement des métacaractères : une recherche sur « 249 € (+) » ne doit
    // pas devenir une expression rationnelle invalide, encore moins une
    // expression coûteuse fabriquée depuis la barre de recherche.
    const echappe = terme.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const motif = new RegExp(echappe, 'i');
    filtre.$or = [{ label: motif }, { description: motif }, { projectNameSnapshot: motif }];
  }

  return { filtre, resolved };
}

/** Liste des mouvements — bornée, triée, jamais le registre entier. */
export async function listTransactions(demande = {}) {
  const { filtre, resolved } = await buildQueryFilter(demande);
  const tri = SORTS[String(demande.sort ?? 'DATE_DESC').toUpperCase()] ?? SORTS.DATE_DESC;
  const limite = Math.min(Math.max(1, Number(demande.limit) || DEFAULT_LIMIT), MAX_LIMIT);

  const [items, total] = await Promise.all([
    PanelFinancialTransaction.find(filtre).sort(tri).limit(limite).lean(),
    PanelFinancialTransaction.countDocuments(filtre),
  ]);

  return {
    items: await decorate(items.map(toPublicTransaction)),
    // `total` compte TOUT ce que le filtre retient ; `items` s'arrête à la
    // borne. L'écran doit pouvoir dire « 200 des 431 » plutôt que laisser
    // croire que le registre s'arrête là.
    total,
    limit: limite,
    truncated: total > items.length,
    period: publicPeriod(resolved),
  };
}

/** Un mouvement, par son identité publique. */
export async function getTransaction(transactionId) {
  const document = await loadOrThrow(transactionId);
  const [enrichi] = await decorate([toPublicTransaction(document.toObject())]);
  return enrichi;
}

/**
 * COMPLÈTE les mouvements avec le DESCRIPTEUR de leur justificatif.
 *
 * ══ POURQUOI UNE JOINTURE PLUTÔT QU'UNE RECOPIE ═════════════════════════════
 *
 * Le nom du fichier, son type et son poids appartiennent au protocole Media.
 * Les recopier sur la transaction au moment du rattachement en ferait une
 * seconde vérité, qui divergerait dès le premier remplacement de pièce — et
 * l'écran afficherait alors « facture-aout.pdf » sur un document qui n'existe
 * plus sous ce nom.
 *
 * ══ UNE SEULE REQUÊTE POUR TOUTE LA PAGE ════════════════════════════════════
 *
 * Les identifiants sont collectés puis interrogés en un `$in`. Une requête par
 * ligne ferait un N+1 sur un livret de coûts, qui est précisément l'écran où
 * les justificatifs sont nombreux.
 */
/**
 * L'ENRICHISSEMENT COMPLET D'UNE LECTURE — justificatif, puis remboursements.
 *
 * ══ POURQUOI L'ÉTAT DE REMBOURSEMENT N'EST PAS SUR LA TRANSACTION ══════════
 *
 * Parce qu'il n'est pas une propriété du mouvement : c'est une SOMME de ses
 * enfants. Le stocker ferait un solde, et un solde se désynchronise à la
 * première écriture arrivée par une voie imprévue — un webhook, un rejeu, une
 * suppression. Il se recalcule donc à la lecture, en une requête pour toute la
 * page, exactement comme la jointure des justificatifs juste au-dessus.
 *
 * ══ AUCUN APPEL FOURNISSEUR ═══════════════════════════════════════════════
 *
 * Tout vient du registre. Un écran financier ne parle jamais à Stripe — la
 * règle centrale de L10.3, et L10.4 ne l'entame pas.
 */
async function decorate(transactions) {
  const avecPieces = await withReceipts(transactions);
  const { withRefundState } = await import('./refunds/refundOrchestration.service.js');
  return withRefundState(avecPieces);
}

async function withReceipts(transactions) {
  const ids = transactions.map((t) => t.receipt?.mediaId).filter(Boolean);
  if (ids.length === 0) return transactions;

  const PanelMedia = (await import('../../models/PanelMedia.model.js')).default;
  const medias = await PanelMedia.find({ mediaId: { $in: ids } })
    .select('mediaId originalFilename mime size sha256 createdAt createdBy deletedAt')
    .lean();
  const par = new Map(medias.map((m) => [m.mediaId, m]));

  return transactions.map((t) => {
    if (!t.receipt?.mediaId) return t;
    const media = par.get(t.receipt.mediaId);
    // Un descripteur introuvable ou supprimé ne fait pas disparaître le
    // rattachement : l'écran doit pouvoir dire « pièce référencée, document
    // indisponible » plutôt que « aucune pièce », qui serait faux.
    return {
      ...t,
      receipt: {
        ...t.receipt,
        filename: media?.originalFilename ?? null,
        mime: media?.mime ?? null,
        size: media?.size ?? null,
        available: Boolean(media) && !media.deletedAt,
      },
    };
  });
}

/**
 * PROJECTION PUBLIQUE — ce que l'API rend, et rien de plus.
 *
 * `_id` ne sort pas : l'identité publique est `transactionId`. La provenance
 * n'est rendue que si elle porte quelque chose — un écran de mouvement manuel
 * ne doit pas afficher quatre lignes « — » qui ressemblent à des champs Stripe
 * en attente. Il n'y a rien en attente : il n'y a rien du tout.
 */
export function toPublicTransaction(document) {
  const provenance = document.provenance ?? {};
  const renseignee = Boolean(
    provenance.provider || provenance.environment || provenance.externalId || provenance.externalKind,
  );
  const verdict = editability(document);
  return {
    transactionId: document.transactionId,
    projectId: document.projectId ?? null,
    projectNameSnapshot: document.projectNameSnapshot ?? null,
    flow: document.flow,
    category: document.category,
    origin: document.origin,
    status: document.status,
    label: document.label,
    description: document.description ?? '',
    amountCents: document.amountCents,
    currency: document.currency,
    effectiveDate: toIso(document.effectiveDate),
    parentTransactionId: document.parentTransactionId ?? null,
    provenance: renseignee
      ? {
        provider: provenance.provider ?? null,
        environment: provenance.environment ?? null,
        externalId: provenance.externalId ?? null,
        externalKind: provenance.externalKind ?? null,
      }
      : null,

    /* ── L10.2 — l'occurrence et sa pièce ─────────────────────────────── */

    /** La règle qui a produit ce mouvement, `null` pour une saisie manuelle. */
    sourceId: document.sourceId ?? null,
    /** Le cycle matérialisé — c'est aussi la moitié de sa clé d'unicité. */
    cycleKey: document.cycleKey ?? null,
    sourceRevision: document.sourceRevision ?? null,

    /**
     * LE JUSTIFICATIF — une RÉFÉRENCE, jamais une adresse.
     *
     * `null` quand il n'y en a pas : un objet vide se lirait comme « une pièce
     * existe mais n'a pas chargé ». Le détail du document (nom, type, poids)
     * est ajouté par `withReceipts`, qui interroge le protocole Media — il
     * n'est pas recopié sur la transaction, qui divergerait au premier
     * remplacement.
     *
     * Il n'y a AUCUN champ d'URL ici, et il ne doit jamais y en avoir : un
     * justificatif ne se télécharge que par la route authentifiée du mouvement.
     */
    receipt: document.receipt?.mediaId
      ? {
        mediaId: document.receipt.mediaId,
        attachedAt: toIso(document.receipt.attachedAt),
        attachedBy: document.receipt.attachedBy ?? null,
      }
      : null,
    deletedAt: toIso(document.deletedAt),
    deletedBy: document.deletedBy ?? null,
    deletionReason: document.deletionReason ?? null,
    createdBy: document.createdBy ?? null,
    updatedBy: document.updatedBy ?? null,
    createdAt: toIso(document.createdAt),
    updatedAt: toIso(document.updatedAt),
    editable: verdict.editable,
    notEditableReason: verdict.reason,
  };
}

/** Les bornes résolues, telles que l'écran doit les afficher. */
export function publicPeriod(resolved) {
  return {
    period: resolved.period,
    startsAt: toIso(resolved.startsAt),
    endsAt: toIso(resolved.endsAt),
    timezone: resolved.timezone,
    granularity: resolved.granularity,
  };
}

const toIso = (value) => (value ? new Date(value).toISOString() : null);

/* ── Journal ───────────────────────────────────────────────────────────────── */

/**
 * ÉCRIT AU JOURNAL D'ACTIVITÉ EXISTANT — sans en créer un second.
 *
 * La chronologie du Panel (`PanelEvent`) accueille déjà les actes d'opérateur,
 * avec `source: 'PANEL'` et un `projectId` nullable. C'est exactement la forme
 * dont ces trois événements ont besoin, et elle est déjà lue par les écrans de
 * supervision : y brancher les finances leur donne une place, plutôt qu'un
 * journal parallèle que personne n'irait ouvrir.
 *
 * ── CE QUI NE PART JAMAIS AU JOURNAL ────────────────────────────────────────
 * Aucune charge utile fournisseur, aucun identifiant externe, aucun secret. Le
 * `data` porte l'identité du mouvement, sa taxonomie, son montant en centimes
 * et son origine — de quoi expliquer un total, jamais de quoi rejouer un
 * paiement.
 *
 * ── ET SI LE JOURNAL ÉCHOUE ? ───────────────────────────────────────────────
 * Le mouvement reste écrit. Une chronologie indisponible ne doit pas annuler
 * une saisie comptable déjà validée : l'écriture est le fait, la trace en est
 * le commentaire. L'échec part dans les journaux du serveur.
 */
async function journal(type, document, actor, { severity = 'INFO', summary, extra = {} } = {}) {
  try {
    await recordEvent({
      projectId: document.projectId ?? null,
      type,
      source: 'PANEL',
      severity,
      summary,
      data: {
        transactionId: document.transactionId,
        flow: document.flow,
        category: document.category,
        origin: document.origin,
        amountCents: document.amountCents,
        currency: document.currency,
        effectiveDate: toIso(document.effectiveDate),
        actor: actor.email ?? null,
        ...extra,
      },
    });
  } catch (err) {
    logger.error(`Journal financier indisponible pour ${document.transactionId} : ${err?.message ?? err}`);
  }
}

export default {
  MANUAL_CATEGORIES,
  SCOPES,
  SCOPE_VALUES,
  SORT_VALUES,
  BULK_CONFIRMATION,
  recordTransaction,
  createManualTransaction,
  updateManualTransaction,
  softDeleteTransaction,
  bulkSoftDelete,
  countBulkScope,
  listTransactions,
  getTransaction,
  buildQueryFilter,
  toPublicTransaction,
  publicPeriod,
  editability,
};
