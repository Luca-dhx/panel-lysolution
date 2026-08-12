/**
 * COÛTS RÉCURRENTS — la règle, ses révisions, son arrêt, et ses occurrences.
 *
 * ══ AUCUN FOURNISSEUR N'EST APPELÉ DEPUIS CE FICHIER ════════════════════════
 *
 * Ni Stripe, ni la passerelle de capacités, ni le pont, ni le moindre `fetch`.
 * Un coût récurrent est une règle interne : « ce fournisseur nous prélève tant,
 * tous les mois ». Personne n'est interrogé pour le savoir.
 *
 * ══ LA MATÉRIALISATION CONVERGE, ELLE NE S'ORDONNANCE PAS ═══════════════════
 *
 * `materializeDueOccurrences` est IDEMPOTENTE et RATTRAPANTE : elle crée tout
 * ce qui est dû et qui n'existe pas encore, quel que soit le temps écoulé
 * depuis le dernier passage. Un Panel éteint quatre mois produit, au retour,
 * quatre occurrences distinctes — chacune à sa vraie date, chacune une seule
 * fois.
 *
 * Elle est appelée à trois endroits, et c'est délibéré :
 *
 *   · à CHAQUE LECTURE financière — c'est la garantie réelle. Les totaux
 *     affichés sont donc toujours à jour, même si rien n'a tourné entre-temps ;
 *   · au DÉMARRAGE du serveur, et par un ordonnanceur horaire — pour que
 *     l'écriture ait lieu même sans lecteur ;
 *   · explicitement, par la recette.
 *
 * Aucun de ces déclencheurs n'est nécessaire aux autres. Un ordonnanceur qui
 * serait la seule garantie transformerait une minute d'indisponibilité à
 * minuit en un mois manquant.
 */
import { randomUUID } from 'node:crypto';

import ApiError from '../../utils/ApiError.js';
import logger from '../../utils/logger.js';
import {
  EDIT_MODES, EDIT_MODE_VALUES, PanelRecurringCost, RECURRING_SCOPES,
  RECURRING_SCOPE_VALUES, RECURRING_STATUS, STOP_MODES, STOP_MODE_VALUES,
} from '../../models/PanelRecurringCost.model.js';
import {
  CATEGORIES, FLOWS, ORIGINS, STATUSES, PanelFinancialTransaction,
} from '../../models/PanelFinancialTransaction.model.js';
import { EVENT_TYPES } from '../../models/PanelSupervision.model.js';
import { recordEvent } from '../supervision/timeline.service.js';
import { getProjectOrThrow } from '../registry/projectRegistry.service.js';
import { normalizeCurrency, parseAmountToCents } from './money.js';
import { parseBusinessDate } from './period.js';
import {
  anchorOf, currentCycleAt, cycleKeyOf, dueCycles, MAX_CATCHUP_CYCLES,
  nextOccurrenceAfter, normalizeRecurrence,
} from './recurrence.js';

/**
 * LA BORNE « AUCUN CYCLE » — antérieure à toute clé réelle.
 *
 * Un arrêt demandé avant même la première échéance doit produire une règle qui
 * ne générera JAMAIS rien. `null` ne pouvait pas le dire : il signifie « pas de
 * borne », donc l'inverse. Cette sentinelle se compare comme n'importe quelle
 * autre clé (`'0000-00-00' < '2026-08-01'`), ce qui évite un cas particulier
 * dans chaque comparaison.
 */
export const NO_CYCLE = '0000-00-00';

/* ── Validation d'entrée ───────────────────────────────────────────────────── */

async function resolveScope({ scope, projectId }) {
  const s = String(scope ?? '').toUpperCase();
  if (!RECURRING_SCOPE_VALUES.includes(s)) {
    throw ApiError.badRequest(
      'PANEL_RECURRING_SCOPE_UNKNOWN',
      `Portée inconnue : ${scope}. Attendu : ${RECURRING_SCOPE_VALUES.join(', ')}.`,
    );
  }
  if (s === RECURRING_SCOPES.COMPANY) {
    return { scope: s, projectId: null, projectNameSnapshot: null };
  }
  const brut = String(projectId ?? '').trim();
  if (!brut) {
    throw ApiError.badRequest(
      'PANEL_RECURRING_PROJECT_REQUIRED',
      'Un coût récurrent de portée PROJECT exige un projet.',
    );
  }
  const record = await getProjectOrThrow(brut);
  return { scope: s, projectId: record.projectId, projectNameSnapshot: record.projectName ?? null };
}

function requireLabel(value) {
  const label = String(value ?? '').trim();
  if (!label) throw ApiError.badRequest('PANEL_RECURRING_LABEL_REQUIRED', 'Un nom est requis.');
  if (label.length > 160) {
    throw ApiError.badRequest('PANEL_RECURRING_LABEL_TOO_LONG', 'Le nom dépasse 160 caractères.');
  }
  return label;
}

/* ── Résolution des révisions ──────────────────────────────────────────────── */

/**
 * LA RÉVISION QUI S'APPLIQUE À UN CYCLE — la dernière qui prend effet avant lui.
 *
 * Fonction PURE, et c'est ce qui rend l'historique explicable : donnée une
 * règle et un cycle, la réponse est la même aujourd'hui, dans six mois, et pour
 * quiconque la pose. Aucune mutation vivante n'entre dans le calcul.
 *
 * Les révisions sont triées par cycle d'effet PUIS par rang : deux révisions
 * effectives au même cycle sont départagées par leur ordre d'écriture — la plus
 * récente gagne, ce qui est le comportement attendu d'une correction.
 */
export function resolveEffectiveRevision(definition, cycleKey) {
  const revisions = [...(definition.revisions ?? [])].sort((a, b) => (
    a.effectiveFromCycleKey === b.effectiveFromCycleKey
      ? a.revision - b.revision
      : a.effectiveFromCycleKey.localeCompare(b.effectiveFromCycleKey)
  ));
  let retenue = null;
  for (const revision of revisions) {
    if (revision.effectiveFromCycleKey <= cycleKey) retenue = revision;
  }
  // Aucune révision antérieure : c'est la PREMIÈRE qui vaut. Le cas se produit
  // pour un cycle situé avant la plus ancienne date d'effet — impossible
  // aujourd'hui, puisque la révision initiale part de l'ancre, mais rendre
  // `null` ici ferait échouer une matérialisation au lieu de la faire.
  return retenue ?? revisions[0] ?? null;
}

/**
 * LE CYCLE À PARTIR DUQUEL UNE MODIFICATION S'APPLIQUE.
 *
 * ══ LES TROIS SÉMANTIQUES, ÉNONCÉES SANS AMBIGUÏTÉ ══════════════════════════
 *
 * Exemple de référence — mensuel, ancré au 1er août, nous sommes le 15
 * septembre, les occurrences d'août et de septembre existent :
 *
 *   NEXT        « prochaine récurrence »
 *               → effet au 1er octobre.
 *               août 49 · septembre 49 · octobre 59 · suivantes 59
 *               AUCUNE occurrence matérialisée n'est touchée.
 *
 *   CURRENT     « récurrence précédente »
 *               → effet au 1er septembre, le cycle COURANT.
 *               août 49 · septembre 59 · octobre 59 · suivantes 59
 *               L'occurrence de septembre est RÉVISÉE — elle existe déjà.
 *
 *   FROM_START  « depuis le début »
 *               → effet au 1er août, le tout premier cycle.
 *               août 59 · septembre 59 · octobre 59 · suivantes 59
 *               TOUTES les occurrences vivantes sont révisées.
 *
 * ── POURQUOI « PRÉCÉDENTE » DÉSIGNE LE CYCLE COURANT ────────────────────────
 * Parce que c'est ce que l'utilisateur voit. Le 15 septembre, la « récurrence
 * précédente » est la dernière ligne apparue dans son livret — celle du 1er
 * septembre. Le cycle d'août n'est pas « précédent », il est ancien.
 *
 * ── AVANT LE PREMIER CYCLE ──────────────────────────────────────────────────
 * Une règle dont l'ancre est dans le futur n'a ni cycle courant ni cycle
 * suivant matérialisable : les trois modes retombent sur le premier cycle.
 * C'est la seule réponse qui ne perde rien.
 */
export function resolveEditBoundary(definition, { mode, now }) {
  const m = String(mode ?? '').toUpperCase();
  if (!EDIT_MODE_VALUES.includes(m)) {
    throw ApiError.badRequest(
      'PANEL_RECURRING_EDIT_MODE_UNKNOWN',
      `Mode d'application inconnu : ${mode}. Attendu : ${EDIT_MODE_VALUES.join(', ')}.`,
    );
  }
  const premier = cycleKeyOf(anchorOf(definition.startAt));
  if (m === EDIT_MODES.FROM_START) return { mode: m, effectiveFromCycleKey: premier };

  const args = {
    startAt: definition.startAt,
    recurrence: definition.recurrence,
    now,
    untilCycleKey: definition.effectiveUntilCycleKey,
  };

  if (m === EDIT_MODES.CURRENT) {
    const courant = currentCycleAt(args);
    return { mode: m, effectiveFromCycleKey: courant?.key ?? premier };
  }

  const suivant = nextOccurrenceAfter(args);
  if (!suivant) {
    throw ApiError.conflict(
      'PANEL_RECURRING_NO_NEXT_CYCLE',
      'Cette récurrence n’a plus de prochaine échéance : la modification n’aurait aucun effet.',
    );
  }
  return { mode: m, effectiveFromCycleKey: suivant.key };
}

/**
 * LES BORNES D'UN ARRÊT — jusqu'où la règle produit, et ce qu'elle retire.
 *
 * ══ LES DEUX SÉMANTIQUES ════════════════════════════════════════════════════
 *
 * Même exemple : mensuel, ancré au 1er août, nous sommes le 15 septembre,
 * l'occurrence de septembre existe.
 *
 *   NEXT      « prochaine »
 *             septembre RESTE dans les totaux.
 *             Aucune occurrence d'octobre ni au-delà ne sera produite.
 *             → untilCycleKey = 2026-09-01, rien à annuler.
 *
 *   CURRENT   « actuelle »
 *             septembre est RETIRÉ des totaux — c'est ce que demande le cahier
 *             des charges : « ça retire du livret le coût automatique du cycle
 *             actuel ».
 *             Aucune occurrence d'octobre ni au-delà ne sera produite.
 *             Août reste : un arrêt ne réécrit pas l'histoire.
 *             → untilCycleKey = 2026-09-01, cycle annulé = 2026-09-01.
 *
 * Dans les deux cas la borne est le cycle COURANT : c'est elle qui empêche la
 * génération future, y compris après un redémarrage. Le retrait du cycle
 * courant est une SUPPRESSION LOGIQUE de son occurrence — la ligne quitte les
 * totaux, le document et son justificatif restent.
 *
 * ── ARRÊT AVANT LA PREMIÈRE ÉCHÉANCE ────────────────────────────────────────
 * La règle n'a jamais rien produit : la borne devient `NO_CYCLE`, et elle ne
 * produira jamais rien. Il n'y a rien à annuler.
 */
export function resolveStopBoundary(definition, { mode, now }) {
  const m = String(mode ?? '').toUpperCase();
  if (!STOP_MODE_VALUES.includes(m)) {
    throw ApiError.badRequest(
      'PANEL_RECURRING_STOP_MODE_UNKNOWN',
      `Mode d'arrêt inconnu : ${mode}. Attendu : ${STOP_MODE_VALUES.join(', ')}.`,
    );
  }
  const courant = currentCycleAt({
    startAt: definition.startAt,
    recurrence: definition.recurrence,
    now,
    untilCycleKey: definition.effectiveUntilCycleKey,
  });

  if (!courant) return { mode: m, untilCycleKey: NO_CYCLE, cancelCycleKey: null };
  return {
    mode: m,
    untilCycleKey: courant.key,
    cancelCycleKey: m === STOP_MODES.CURRENT ? courant.key : null,
  };
}

/* ── Création ──────────────────────────────────────────────────────────────── */

/**
 * CRÉE une règle de coût récurrent.
 *
 * Aucun justificatif n'est accepté ici, et c'est une décision de modèle : un
 * justificatif documente un PAIEMENT, et une règle n'en est pas un. La facture
 * d'août et celle de septembre sont deux documents distincts, attachés à deux
 * occurrences distinctes. Un champ « justificatif » sur la définition aurait
 * forcément fini par désigner l'un des deux mois — et à faire croire qu'il
 * valait pour tous.
 */
export async function createRecurringCost(input = {}, actor = {}, { now = new Date() } = {}) {
  const portee = await resolveScope(input);
  const recurrence = normalizeRecurrence(input.recurrence ?? {});
  const startAt = parseBusinessDate(input.startAt, 'date de démarrage');
  const label = requireLabel(input.label);
  const amountCents = parseAmountToCents(input.amount, 'montant');
  const currency = normalizeCurrency(input.currency);
  const at = new Date().toISOString();

  const definition = await PanelRecurringCost.create({
    recurringCostId: randomUUID(),
    ...portee,
    currency,
    recurrence,
    startAt,
    status: RECURRING_STATUS.ACTIVE,
    revisions: [{
      revision: 1,
      // La première révision part de l'ancre : la règle vaut ce montant depuis
      // son tout premier cycle, ce qui est la seule lecture possible.
      effectiveFromCycleKey: cycleKeyOf(anchorOf(startAt)),
      label,
      description: String(input.description ?? '').trim(),
      amountCents,
      mode: null,
      reason: null,
      createdAt: at,
      createdBy: actor.email ?? null,
    }],
    createdAt: at,
    createdBy: actor.email ?? null,
    updatedAt: at,
    updatedBy: actor.email ?? null,
  });

  await journal('created', definition, actor, {
    summary: `Coût récurrent « ${label} » créé.`,
    extra: { recurrence, amountCents, startAt: startAt.toISOString() },
  });

  // On matérialise TOUT DE SUITE : une règle démarrant aujourd'hui ou dans le
  // passé doit produire ses occurrences sans attendre une relecture d'écran.
  await materializeDueOccurrences(definition.recurringCostId, { now, actor });
  // La PROJECTION PUBLIQUE, jamais le document brut : le montant courant se
  // résout depuis les révisions, et un appelant qui recevrait le document nu
  // devrait refaire ce calcul — donc, un jour, différemment.
  return toPublicRecurringCost(await loadOrThrow(definition.recurringCostId), { now });
}

/* ── Matérialisation ───────────────────────────────────────────────────────── */

async function loadOrThrow(recurringCostId) {
  const doc = await PanelRecurringCost.findOne({ recurringCostId }).lean();
  if (!doc) {
    throw ApiError.notFound('PANEL_RECURRING_NOT_FOUND', 'Coût récurrent introuvable.');
  }
  return doc;
}

/**
 * CRÉE LES OCCURRENCES DUES — une fois chacune, quoi qu'il arrive.
 *
 * ══ L'IDEMPOTENCE N'EST PAS DANS CE CODE ════════════════════════════════════
 *
 * Elle est dans l'index unique `{sourceId, cycleKey}` du ledger. Ce service
 * demande une écriture conditionnelle (`upsert` + `$setOnInsert`) ; la base
 * tranche. Deux appels simultanés, deux processus, un retry après coupure : le
 * premier insère, les autres n'insèrent rien. C'est la seule construction qui
 * résiste à une vraie concurrence — un `findOne` suivi d'un `create` laisse
 * passer les deux quand ils se croisent entre les deux instructions.
 *
 * ══ CE QU'ELLE NE COMPRESSE JAMAIS ══════════════════════════════════════════
 *
 * Quatre mois de retard produisent QUATRE lignes, à leurs quatre dates. Une
 * ligne unique de quatre fois le montant serait plus simple et fausserait le
 * graphique, les périodes, et tout rapprochement bancaire.
 *
 * @returns {{created:number, skipped:number, overflow:boolean, remaining:number}}
 */
export async function materializeDueOccurrences(recurringCostId, { now = new Date(), actor = {} } = {}) {
  const definition = await loadOrThrow(recurringCostId);
  const rapport = {
    recurringCostId, created: 0, skipped: 0, overflow: false, remaining: 0,
  };

  // Une règle arrêtée avant sa première échéance ne produit rien, jamais.
  if (definition.effectiveUntilCycleKey === NO_CYCLE) return rapport;

  const { cycles, overflow, remaining } = dueCycles({
    startAt: definition.startAt,
    recurrence: definition.recurrence,
    now,
    /**
     * On repart du DERNIER CYCLE CONNU, inclus — pas du suivant.
     *
     * Le recouvrement d'un cycle coûte une écriture conditionnelle sans effet,
     * et il répare le cas où le curseur a avancé sans que l'écriture ait abouti
     * (coupure entre les deux). Repartir du suivant aurait laissé ce trou
     * définitivement ouvert.
     */
    fromCycleKey: definition.lastMaterializedCycleKey,
    untilCycleKey: definition.effectiveUntilCycleKey,
  });
  rapport.overflow = overflow;
  rapport.remaining = remaining;

  if (overflow) {
    // On le DIT. Une borne qui écarte des cycles en silence ferait disparaître
    // des mois entiers d'un bilan sans qu'aucun écran ne puisse l'expliquer.
    logger.warn(
      `[finance] Récurrence ${recurringCostId} : ${MAX_CATCHUP_CYCLES} cycles matérialisés, `
      + `${remaining} encore en retard. Ils le seront au passage suivant.`,
    );
  }

  for (const cycle of cycles) {
    const revision = resolveEffectiveRevision(definition, cycle.key);
    if (!revision) continue;

    const cree = await upsertOccurrence({ definition, cycle, revision, actor });
    if (cree) rapport.created += 1;
    else rapport.skipped += 1;
  }

  const dernier = cycles.at(-1)?.key ?? null;
  if (dernier && dernier !== definition.lastMaterializedCycleKey) {
    await PanelRecurringCost.updateOne(
      { recurringCostId },
      { $set: { lastMaterializedCycleKey: dernier, updatedAt: new Date().toISOString() } },
    );
  }

  if (rapport.created) {
    await recordEvent({
      projectId: definition.projectId ?? null,
      type: EVENT_TYPES.FINANCIAL_TRANSACTION_CREATED,
      source: 'PANEL',
      severity: 'INFO',
      summary: `${rapport.created} occurrence(s) de « ${currentLabel(definition)} » portée(s) au registre.`,
      data: {
        recurringCostId,
        materialized: rapport.created,
        origin: ORIGINS.RECURRING_COST,
      },
    }).catch(() => null);
  }

  return rapport;
}

/** Le libellé courant d'une règle — la dernière révision écrite. */
export function currentLabel(definition) {
  const revisions = definition.revisions ?? [];
  return revisions.at(-1)?.label ?? '(sans nom)';
}

/** La révision courante — celle qui vaut pour les cycles à venir. */
export function currentRevision(definition) {
  const revisions = [...(definition.revisions ?? [])].sort((a, b) => a.revision - b.revision);
  return revisions.at(-1) ?? null;
}

/**
 * ÉCRIT UNE OCCURRENCE si elle n'existe pas. Rend `true` si elle a été créée.
 *
 * `$setOnInsert` sur TOUS les champs : une occurrence déjà présente n'est
 * jamais retouchée par la matérialisation, même si la règle a changé depuis.
 * Réviser le passé est un geste EXPLICITE de l'utilisateur (voir
 * `reviseRecurringCost`), jamais un effet de bord d'une relecture d'écran.
 */
async function upsertOccurrence({ definition, cycle, revision, actor }) {
  try {
    const res = await PanelFinancialTransaction.updateOne(
      { sourceId: definition.recurringCostId, cycleKey: cycle.key },
      {
        $setOnInsert: {
          transactionId: randomUUID(),
          projectId: definition.projectId ?? null,
          projectNameSnapshot: definition.projectNameSnapshot ?? null,
          flow: FLOWS.OUTFLOW,
          category: CATEGORIES.COST,
          origin: ORIGINS.RECURRING_COST,
          status: STATUSES.RECORDED,
          // L'INSTANTANÉ : ces valeurs sont celles de la révision applicable AU
          // MOMENT du cycle. Elles ne suivront plus la définition.
          label: revision.label,
          description: revision.description ?? '',
          amountCents: revision.amountCents,
          currency: definition.currency,
          effectiveDate: cycle.at,
          sourceId: definition.recurringCostId,
          cycleKey: cycle.key,
          sourceRevision: revision.revision,
          parentTransactionId: null,
          provenance: {
            provider: null, environment: null, externalId: null, externalKind: null,
          },
          receipt: { mediaId: null, attachedAt: null, attachedBy: null },
          deletedAt: null,
          deletedBy: null,
          deletionReason: null,
          createdBy: actor.email ?? 'système',
          updatedBy: actor.email ?? 'système',
          /**
           * `createdAt`/`updatedAt` sont ABSENTS d'ici, volontairement.
           *
           * Le schéma porte `timestamps: true` : Mongoose les pose lui-même sur
           * l'insertion. Les écrire aussi produirait deux ordres d'écriture sur
           * le même chemin — que MongoDB refuse (« would create a conflict »),
           * et la matérialisation échouerait entièrement.
           */
        },
      },
      { upsert: true },
    );
    return (res.upsertedCount ?? 0) > 0;
  } catch (err) {
    /**
     * COLLISION DE CLÉ — c'est le résultat NORMAL d'une course gagnée par
     * l'autre. L'occurrence existe : l'objectif est atteint, il n'y a pas
     * d'incident. Toute autre erreur remonte.
     */
    if (err?.code === 11000) return false;
    throw err;
  }
}

/** Matérialise toutes les règles ACTIVES — le rattrapage global. */
export async function materializeAllDue({ now = new Date(), scope = null, projectId = null } = {}) {
  const filtre = { status: RECURRING_STATUS.ACTIVE };
  if (scope === 'project' && projectId) filtre.projectId = projectId;
  if (scope === 'company') filtre.projectId = null;

  const definitions = await PanelRecurringCost.find(filtre).select('recurringCostId').lean();
  const rapport = { definitions: definitions.length, created: 0, overflow: 0 };
  for (const { recurringCostId } of definitions) {
    try {
      const r = await materializeDueOccurrences(recurringCostId, { now });
      rapport.created += r.created;
      if (r.overflow) rapport.overflow += 1;
    } catch (err) {
      // Une règle en défaut ne doit pas empêcher les autres de converger.
      logger.warn(`[finance] Matérialisation impossible pour ${recurringCostId} : ${err.message}`);
    }
  }
  return rapport;
}

/* ── Modification ──────────────────────────────────────────────────────────── */

/**
 * MODIFIE une règle, à partir d'un cycle CHOISI par l'utilisateur.
 *
 * ══ CE QUI EST RÉVISÉ, ET CE QUI NE L'EST JAMAIS ════════════════════════════
 *
 * Les occurrences VIVANTES à partir du cycle d'effet reçoivent le nouveau
 * libellé, la nouvelle description et le nouveau montant. Elles gardent :
 *
 *   · leur identifiant — aucun lien externe ne se casse ;
 *   · leur JUSTIFICATIF — la facture d'août reste attachée à août, quoi qu'on
 *     fasse au montant ; c'est le point qu'un « supprimer puis recréer » aurait
 *     détruit sans bruit ;
 *   · leur date de cycle ;
 *   · leur date de création et leur auteur d'origine.
 *
 * Les occurrences ANNULÉES ne sont pas touchées : elles constatent ce qui a été
 * retiré, à la valeur qu'il avait alors. Les réécrire changerait un fait clos.
 *
 * ══ UNE RÈGLE ARRÊTÉE NE SE MODIFIE PAS ═════════════════════════════════════
 *
 * Décision de ce lot, énoncée plutôt que subie : `STOPPED` est fonctionnellement
 * immuable. Rouvrir une règle arrêtée obligerait à décider ce que deviennent les
 * cycles écoulés depuis l'arrêt — des trous ? un rattrapage rétroactif ? — et
 * toute réponse implicite serait une surprise. Pour reprendre un abonnement, on
 * en crée un nouveau, avec sa propre ancre. Rien n'est perdu, tout est lisible.
 */
export async function reviseRecurringCost(recurringCostId, patch = {}, actor = {}, { now = new Date() } = {}) {
  const definition = await loadOrThrow(recurringCostId);
  if (definition.status !== RECURRING_STATUS.ACTIVE) {
    throw ApiError.conflict(
      'PANEL_RECURRING_STOPPED',
      'Cette récurrence est arrêtée : elle ne se modifie plus. Créez-en une nouvelle pour reprendre.',
    );
  }

  const { mode, effectiveFromCycleKey } = resolveEditBoundary(definition, { mode: patch.mode, now });
  const courante = currentRevision(definition);

  const label = patch.label !== undefined ? requireLabel(patch.label) : courante.label;
  const description = patch.description !== undefined
    ? String(patch.description ?? '').trim()
    : (courante.description ?? '');
  const amountCents = patch.amount !== undefined
    ? parseAmountToCents(patch.amount, 'montant')
    : courante.amountCents;

  const inchange = label === courante.label
    && description === (courante.description ?? '')
    && amountCents === courante.amountCents;
  if (inchange) {
    // Enregistrer une révision identique polluerait l'historique d'une décision
    // qui n'en est pas une, et ferait croire à un changement à qui le relira.
    return { definition, revision: null, revisedOccurrences: 0, unchanged: true };
  }

  const at = new Date().toISOString();
  const revision = {
    revision: (courante?.revision ?? 0) + 1,
    effectiveFromCycleKey,
    label,
    description,
    amountCents,
    mode,
    reason: patch.reason ? String(patch.reason).trim() : null,
    createdAt: at,
    createdBy: actor.email ?? null,
  };

  await PanelRecurringCost.updateOne(
    { recurringCostId },
    { $push: { revisions: revision }, $set: { updatedAt: at, updatedBy: actor.email ?? null } },
  );

  /**
   * LES OCCURRENCES DÉJÀ MATÉRIALISÉES SONT RÉVISÉES — par une MISE À JOUR.
   *
   * Ni suppression, ni recréation : le justificatif, l'identifiant et l'audit
   * survivent. `updatedBy`/`updatedAt` disent qui a révisé et quand ;
   * `sourceRevision` dit laquelle des révisions est appliquée. L'historique se
   * reconstruit depuis la suite des révisions, qui est append-only.
   */
  const majorees = await PanelFinancialTransaction.updateMany(
    {
      sourceId: recurringCostId,
      cycleKey: { $gte: effectiveFromCycleKey },
      deletedAt: null,
    },
    {
      $set: {
        label,
        description,
        amountCents,
        sourceRevision: revision.revision,
        updatedBy: actor.email ?? null,
        updatedAt: new Date(),
      },
    },
  );

  await journal('updated', await loadOrThrow(recurringCostId), actor, {
    summary: `Coût récurrent « ${label} » modifié à partir du cycle ${effectiveFromCycleKey}.`,
    extra: {
      mode,
      effectiveFromCycleKey,
      revision: revision.revision,
      amountCents,
      revisedOccurrences: majorees.modifiedCount ?? 0,
    },
  });

  return {
    definition: await loadOrThrow(recurringCostId),
    revision,
    revisedOccurrences: majorees.modifiedCount ?? 0,
    unchanged: false,
  };
}

/* ── Arrêt ─────────────────────────────────────────────────────────────────── */

/**
 * ARRÊTE une règle — « actuelle » ou « prochaine ».
 *
 * Le cycle courant retiré par un arrêt « actuelle » l'est par SUPPRESSION
 * LOGIQUE : il quitte les totaux et les listes, son document et son
 * justificatif restent. C'est la doctrine du lot L10.1, réutilisée telle
 * quelle — un fait financier ne s'efface pas.
 */
export async function stopRecurringCost(recurringCostId, { mode, reason = null } = {}, actor = {}, { now = new Date() } = {}) {
  const definition = await loadOrThrow(recurringCostId);
  if (definition.status !== RECURRING_STATUS.ACTIVE) {
    throw ApiError.conflict('PANEL_RECURRING_ALREADY_STOPPED', 'Cette récurrence est déjà arrêtée.');
  }

  const { untilCycleKey, cancelCycleKey } = resolveStopBoundary(definition, { mode, now });
  const at = new Date().toISOString();

  await PanelRecurringCost.updateOne(
    { recurringCostId },
    {
      $set: {
        status: RECURRING_STATUS.STOPPED,
        effectiveUntilCycleKey: untilCycleKey,
        stoppedAt: at,
        stoppedBy: actor.email ?? null,
        stopMode: String(mode).toUpperCase(),
        stopReason: reason ? String(reason).trim() : null,
        updatedAt: at,
        updatedBy: actor.email ?? null,
      },
    },
  );

  let cancelled = 0;
  if (cancelCycleKey) {
    const res = await PanelFinancialTransaction.updateOne(
      { sourceId: recurringCostId, cycleKey: cancelCycleKey, deletedAt: null },
      {
        $set: {
          deletedAt: new Date(),
          deletedBy: actor.email ?? null,
          deletionReason: reason
            ? `Arrêt de la récurrence (cycle courant) — ${String(reason).trim()}`
            : 'Arrêt de la récurrence (cycle courant).',
          updatedAt: new Date(),
        },
      },
    );
    cancelled = res.modifiedCount ?? 0;
  }

  await journal('stopped', await loadOrThrow(recurringCostId), actor, {
    severity: 'WARNING',
    summary: `Coût récurrent « ${currentLabel(definition)} » arrêté (${String(mode).toUpperCase()}).`,
    extra: { mode: String(mode).toUpperCase(), untilCycleKey, cancelCycleKey, cancelledOccurrences: cancelled },
  });

  return { definition: await loadOrThrow(recurringCostId), untilCycleKey, cancelCycleKey, cancelled };
}

/* ── Lecture ───────────────────────────────────────────────────────────────── */

/**
 * LA LISTE DES RÈGLES — distincte du ledger, et c'est tout l'enjeu.
 *
 * Le ledger montre des MOUVEMENTS comptabilisés ; cette liste montre des
 * RÈGLES. Les mélanger ferait apparaître une dépense future à côté de dépenses
 * réelles, et le total ne voudrait plus rien dire.
 *
 * `nextOccurrence` est rendu pour l'affichage. Il n'entre dans AUCUN agrégat —
 * voir l'agrégateur, qui ne somme que des transactions matérialisées.
 */
export async function listRecurringCosts({ scope = 'all', projectId = null, includeStopped = true, now = new Date() } = {}) {
  const filtre = {};
  if (scope === 'project') {
    const brut = String(projectId ?? '').trim();
    if (!brut) {
      throw ApiError.badRequest(
        'PANEL_RECURRING_PROJECT_REQUIRED',
        'La portée « projet » exige un projet.',
      );
    }
    filtre.projectId = brut;
  } else if (scope === 'company') {
    filtre.projectId = null;
  }
  if (!includeStopped) filtre.status = RECURRING_STATUS.ACTIVE;

  const definitions = await PanelRecurringCost.find(filtre).sort({ createdAt: -1 }).lean();
  return definitions.map((d) => toPublicRecurringCost(d, { now }));
}

export async function getRecurringCost(recurringCostId, { now = new Date() } = {}) {
  return toPublicRecurringCost(await loadOrThrow(recurringCostId), { now });
}

/** La projection publique d'une règle — jamais le document brut. */
export function toPublicRecurringCost(definition, { now = new Date() } = {}) {
  const courante = currentRevision(definition);
  const suivant = definition.status === RECURRING_STATUS.ACTIVE
    ? nextOccurrenceAfter({
      startAt: definition.startAt,
      recurrence: definition.recurrence,
      now,
      untilCycleKey: definition.effectiveUntilCycleKey,
    })
    : null;

  return {
    recurringCostId: definition.recurringCostId,
    scope: definition.scope,
    projectId: definition.projectId ?? null,
    projectNameSnapshot: definition.projectNameSnapshot ?? null,
    label: courante?.label ?? '(sans nom)',
    description: courante?.description ?? '',
    amountCents: courante?.amountCents ?? 0,
    currency: definition.currency,
    recurrence: {
      unit: definition.recurrence.unit,
      interval: definition.recurrence.interval,
    },
    startAt: new Date(definition.startAt).toISOString(),
    status: definition.status,
    /** Prochaine échéance — AFFICHAGE seulement, jamais un agrégat. */
    nextOccurrenceAt: suivant ? suivant.at.toISOString() : null,
    nextOccurrenceCycleKey: suivant?.key ?? null,
    lastMaterializedCycleKey: definition.lastMaterializedCycleKey ?? null,
    effectiveUntilCycleKey: definition.effectiveUntilCycleKey ?? null,
    stoppedAt: definition.stoppedAt ?? null,
    stoppedBy: definition.stoppedBy ?? null,
    stopMode: definition.stopMode ?? null,
    /** L'historique complet — c'est LUI l'archive, pas la chronologie. */
    revisions: (definition.revisions ?? []).map((r) => ({
      revision: r.revision,
      effectiveFromCycleKey: r.effectiveFromCycleKey,
      label: r.label,
      description: r.description ?? '',
      amountCents: r.amountCents,
      mode: r.mode ?? null,
      reason: r.reason ?? null,
      createdAt: r.createdAt,
      createdBy: r.createdBy ?? null,
    })),
    createdAt: definition.createdAt,
    createdBy: definition.createdBy ?? null,
    updatedAt: definition.updatedAt,
    updatedBy: definition.updatedBy ?? null,
  };
}

/* ── Journal ───────────────────────────────────────────────────────────────── */

const TYPES = {
  created: EVENT_TYPES.FINANCIAL_TRANSACTION_CREATED,
  updated: EVENT_TYPES.FINANCIAL_TRANSACTION_UPDATED,
  stopped: EVENT_TYPES.FINANCIAL_TRANSACTION_DELETED,
};

/**
 * COMPLÈTE la chronologie — sans jamais en être la preuve.
 *
 * ══ POURQUOI CE JOURNAL NE SUFFIT PAS, ET NE DOIT PAS SUFFIRE ═══════════════
 *
 * `recordEvent` borne la chronologie à `TIMELINE_HISTORY_SIZE` entrées par
 * projet : c'est un fil d'actualité, pas une archive. Une preuve financière qui
 * n'y vivrait que là s'effacerait au trois-centième événement du projet.
 *
 * La preuve DURABLE vit donc dans les documents eux-mêmes, et suffit à
 * reconstruire l'état :
 *
 *   · `revisions[]` — append-only : qui, quand, quel mode, à partir de quel
 *     cycle, et quelles valeurs. Jamais purgé ;
 *   · `stoppedAt/By/Mode/Reason` sur la règle ;
 *   · sur chaque occurrence : `sourceRevision`, `updatedBy`, `updatedAt`,
 *     `deletedAt/By/Reason`, et la référence de son justificatif ;
 *   · le descripteur `PanelMedia` du justificatif, qui n'est jamais purgé.
 *
 * La chronologie ajoute la lisibilité, pas la garantie. Un échec d'écriture ici
 * n'annule donc rien.
 */
async function journal(genre, definition, actor, { severity = 'INFO', summary, extra = {} } = {}) {
  try {
    await recordEvent({
      projectId: definition.projectId ?? null,
      type: TYPES[genre],
      source: 'PANEL',
      severity,
      summary,
      data: {
        recurringCost: true,
        recurringCostId: definition.recurringCostId,
        scope: definition.scope,
        currency: definition.currency,
        actor: actor.email ?? null,
        ...extra,
      },
    });
  } catch (err) {
    logger.warn(`[finance] Chronologie indisponible pour ${definition.recurringCostId} : ${err.message}`);
  }
}

export default {
  NO_CYCLE,
  createRecurringCost,
  reviseRecurringCost,
  stopRecurringCost,
  materializeDueOccurrences,
  materializeAllDue,
  listRecurringCosts,
  getRecurringCost,
  toPublicRecurringCost,
  resolveEffectiveRevision,
  resolveEditBoundary,
  resolveStopBoundary,
  currentRevision,
  currentLabel,
};
