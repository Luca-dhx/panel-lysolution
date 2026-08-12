import mongoose from 'mongoose';

/**
 * COÛT RÉCURRENT — une RÈGLE, jamais un mouvement.
 *
 * ══ LA DISTINCTION QUI FONDE TOUT LE LOT ════════════════════════════════════
 *
 *     « Brevo, 49 € HT, tous les mois, depuis le 1er août »
 *
 * n'est pas une dépense. C'est une règle qui en PRODUIT, une par échéance :
 *
 *     01/08  −49 €      ← FinancialTransaction, durable
 *     01/09  −49 €      ← FinancialTransaction, durable
 *     01/10  −49 €      ← FinancialTransaction, durable
 *
 * Chacune de ces lignes existe VRAIMENT dans le ledger. Aucune n'est
 * recalculée à l'affichage.
 *
 * ══ POURQUOI PAS UN CALCUL À L'AFFICHAGE ════════════════════════════════════
 *
 * On aurait pu ne stocker que la règle et projeter les coûts passés au moment
 * de lire. C'est plus court à écrire, et faux pour trois raisons :
 *
 *   · un justificatif s'attache à une OCCURRENCE — une projection n'a pas
 *     d'identité à laquelle accrocher une facture d'août ;
 *   · modifier le montant réécrirait le passé, silencieusement : le bilan de
 *     l'an dernier changerait parce qu'un abonnement a augmenté aujourd'hui ;
 *   · un cycle annulé (« arrêt actuel ») n'aurait aucun endroit où être annulé.
 *
 * Le ledger reste donc la vérité des mouvements COMPTABILISÉS, et cette
 * définition n'est que leur source.
 *
 * ══ LE PASSÉ NE SE MUTE PAS : IL SE VERSIONNE ═══════════════════════════════
 *
 * `amountCents` n'est pas un champ de ce document. S'il l'était, le modifier
 * changerait implicitement ce que la règle « a toujours valu », et les trois
 * modes de modification exigés par le cahier des charges (précédente,
 * prochaine, depuis le début) deviendraient indistinguables.
 *
 * La règle porte donc une suite de RÉVISIONS, chacune valable à partir d'un
 * cycle donné :
 *
 *     révision 1 · à partir de 2026-08-01 · 49 €
 *     révision 2 · à partir de 2026-10-01 · 59 €
 *
 * « Quel montant pour le cycle d'octobre ? » a alors UNE réponse, calculable,
 * explicable, et identique pour tout le monde — y compris six mois plus tard.
 *
 * La suite est APPEND-ONLY : on n'édite jamais une révision passée, on en
 * ajoute une qui prend effet plus tôt ou plus tard. C'est ce qui rend
 * l'historique auditable sans journal externe.
 */

export const RECURRING_SCOPES = Object.freeze({ PROJECT: 'PROJECT', COMPANY: 'COMPANY' });
export const RECURRING_SCOPE_VALUES = Object.freeze(Object.values(RECURRING_SCOPES));

export const RECURRING_STATUS = Object.freeze({ ACTIVE: 'ACTIVE', STOPPED: 'STOPPED' });
export const RECURRING_STATUS_VALUES = Object.freeze(Object.values(RECURRING_STATUS));

/**
 * QUAND UNE MODIFICATION PREND EFFET — les trois choix du cahier des charges.
 *
 * Ils ne sont pas des libellés d'écran : chacun se traduit par un CYCLE
 * D'EFFET précis, calculé par `resolveEditBoundary`, et c'est ce cycle qui est
 * inscrit dans la révision.
 */
export const EDIT_MODES = Object.freeze({
  /** À partir du cycle courant — celui déjà matérialisé, qui sera RÉVISÉ. */
  CURRENT: 'CURRENT',
  /** À partir du prochain cycle — rien de matérialisé ne bouge. */
  NEXT: 'NEXT',
  /** À partir du tout premier cycle — toutes les occurrences sont révisées. */
  FROM_START: 'FROM_START',
});
export const EDIT_MODE_VALUES = Object.freeze(Object.values(EDIT_MODES));

/** QUAND UN ARRÊT PREND EFFET — les deux choix du cahier des charges. */
export const STOP_MODES = Object.freeze({
  /** Le cycle courant est retiré des totaux, et rien de plus n'est produit. */
  CURRENT: 'CURRENT',
  /** Le cycle courant reste ; plus rien après lui. */
  NEXT: 'NEXT',
});
export const STOP_MODE_VALUES = Object.freeze(Object.values(STOP_MODES));

/**
 * UNE RÉVISION — ce que la règle vaut À PARTIR d'un cycle.
 *
 * `effectiveFromCycleKey` est INCLUSIF et porte une clé de cycle (`AAAA-MM-JJ`),
 * pas une date libre : une révision prend effet sur des ÉCHÉANCES, jamais au
 * milieu d'un cycle. Une date libre aurait obligé chaque lecture à décider
 * elle-même si le cycle du 1er octobre est « avant ou après le 15 octobre »,
 * et deux lectures auraient fini par répondre différemment.
 */
const revisionSchema = new mongoose.Schema(
  {
    /** Rang, à partir de 1. Monotone, jamais réutilisé, jamais renuméroté. */
    revision: { type: Number, required: true },

    /** Le premier cycle auquel cette révision s'applique. Inclus. */
    effectiveFromCycleKey: { type: String, required: true },

    // ── CE QUE LA RÈGLE VAUT SUR CETTE PLAGE ──────────────────────────────
    label: { type: String, required: true, trim: true },
    description: { type: String, default: '' },
    amountCents: { type: Number, required: true },

    /**
     * COMMENT CETTE RÉVISION A ÉTÉ DEMANDÉE.
     *
     * Conservé parce que le cycle d'effet seul ne dit pas l'INTENTION : une
     * révision effective au premier cycle peut venir d'un « depuis le début »
     * délibéré ou d'une correction de saisie faite le jour même. Six mois plus
     * tard, seule l'intention explique la manœuvre.
     */
    mode: { type: String, enum: [...EDIT_MODE_VALUES, null], default: null },
    reason: { type: String, default: null },

    createdAt: { type: String, required: true },
    createdBy: { type: String, default: null },
  },
  { _id: false },
);

const recurringCostSchema = new mongoose.Schema(
  {
    /** Identité publique stable — jamais `_id`, qui est un détail de stockage. */
    recurringCostId: { type: String, required: true, unique: true },

    /**
     * PORTÉE — la même doctrine que le ledger, et le même nul signifiant.
     *
     * `PROJECT` exige un `projectId` ; `COMPANY` exige qu'il soit nul. Les deux
     * champs pourraient se déduire l'un de l'autre, et c'est justement pour
     * cela que la portée est ÉCRITE : « aucun projet » et « projet oublié » se
     * ressemblent trop dans un filtre pour qu'on les laisse se confondre.
     */
    scope: { type: String, enum: RECURRING_SCOPE_VALUES, required: true },
    projectId: { type: String, default: null },
    /** Instantané pour l'audit — jamais l'autorité. Voir le ledger, même règle. */
    projectNameSnapshot: { type: String, default: null },

    currency: { type: String, required: true, default: 'EUR' },

    /** `tous les <interval> <unit>` — sémantique calendaire : `recurrence.js`. */
    recurrence: {
      unit: { type: String, enum: ['DAY', 'MONTH', 'YEAR'], required: true },
      interval: { type: Number, required: true },
    },

    /**
     * L'ANCRE de la suite d'échéances — et la PREMIÈRE d'entre elles.
     *
     * La première occurrence a lieu le jour du démarrage, pas un cycle plus
     * tard : un abonnement souscrit le 1er août est facturé le 1er août.
     *
     * Toutes les échéances suivantes sont calculées DEPUIS cette ancre, jamais
     * depuis la précédente — c'est ce qui restaure le 31 après un mois court
     * (voir `recurrence.js`). Modifier `startAt` renommerait donc tous les
     * cycles : c'est refusé dès qu'une occurrence existe.
     */
    startAt: { type: Date, required: true },

    status: { type: String, enum: RECURRING_STATUS_VALUES, required: true, default: RECURRING_STATUS.ACTIVE },

    /**
     * LE DERNIER CYCLE QUE CETTE RÈGLE PRODUIRA — posé par un arrêt.
     *
     * `null` tant qu'elle est active. Une fois posé, il borne la génération à
     * la SOURCE : le matérialiseur ne calcule même plus les cycles au-delà.
     * Une borne appliquée seulement à l'affichage aurait laissé la génération
     * continuer, et la reprise après une panne aurait ressuscité des cycles
     * qu'on croyait arrêtés.
     */
    effectiveUntilCycleKey: { type: String, default: null },

    stoppedAt: { type: String, default: null },
    stoppedBy: { type: String, default: null },
    stopMode: { type: String, enum: [...STOP_MODE_VALUES, null], default: null },
    stopReason: { type: String, default: null },

    /**
     * LE DERNIER CYCLE MATÉRIALISÉ — un curseur d'AVANCEMENT, pas une preuve.
     *
     * Il évite de reparcourir tout l'historique à chaque passage du
     * matérialiseur. Il ne garantit RIEN à lui seul : la garantie d'unicité est
     * l'index unique `{sourceId, cycleKey}` du ledger, qui tient même si ce
     * curseur est faux, absent ou concurrent. Un curseur qui serait la seule
     * protection produirait un doublon au premier redémarrage mal placé.
     */
    lastMaterializedCycleKey: { type: String, default: null },

    /** APPEND-ONLY. La révision effective d'un cycle se RÉSOUT, ne se lit pas. */
    revisions: { type: [revisionSchema], default: [] },

    createdAt: { type: String, required: true },
    createdBy: { type: String, default: null },
    updatedAt: { type: String, required: true },
    updatedBy: { type: String, default: null },
  },
  { minimize: false, versionKey: false },
);

/**
 * INDEX — deux, et chacun sert une lecture réellement écrite.
 *
 * Le listing des règles se fait par portée (fiche projet, ou page globale), et
 * le matérialiseur balaie les règles ACTIVES. Rien d'autre n'interroge cette
 * collection.
 */
recurringCostSchema.index({ projectId: 1, status: 1 });
recurringCostSchema.index({ status: 1 });

export const PanelRecurringCost = mongoose.model('PanelRecurringCost', recurringCostSchema);

export default PanelRecurringCost;
