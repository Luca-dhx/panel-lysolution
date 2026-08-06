import mongoose from 'mongoose';

/**
 * TENTATIVE DE DÉPLOIEMENT — la trace qui existe AVANT le run.
 *
 * ══ LE MANQUE QU'ELLE COMBLE ════════════════════════════════════════════════
 *
 * Un `DeploymentRun` n'est créé qu'une fois la requête acceptée : cible
 * résolue, prérequis locaux vérifiés, en-têtes envoyés. Tout ce qui échoue
 * AVANT ne laissait aucune trace.
 *
 * C'est exactement ce qui s'est produit le 06/08 : un premier clic a rendu un
 * HTTP 500, aucun run n'a été créé, et la cause est restée indémontrable. La
 * seule conclusion possible était « aucun run n'a été créé, donc on ne sait
 * pas » — ce qui n'est pas un diagnostic.
 *
 * Une tentative est ouverte dès la PREMIÈRE ligne de la requête. Elle porte
 * son propre journal, et se rattache au run dès qu'il existe : les deux
 * moitiés de l'histoire se recollent.
 *
 * ══ CE QU'ELLE NE CONTIENT JAMAIS ═══════════════════════════════════════════
 *
 * Aucun secret : tout ce qui y entre passe par le sanitizer central. Le mot de
 * passe SSH voyage dans le corps de ces requêtes — il ne doit pas survivre à
 * la ligne qui le lit.
 */
const journalEntrySchema = new mongoose.Schema(
  {
    at: { type: Date, required: true },
    source: { type: String, required: true },
    level: { type: String, default: 'info' },
    eventCode: { type: String, required: true },
    stepId: { type: String, default: null },
    message: { type: String, default: null },
    details: { type: mongoose.Schema.Types.Mixed, default: null },
    pid: { type: Number, default: null },
    port: { type: Number, default: null },
    processName: { type: String, default: null },
    requestId: { type: String, default: null },
    errorCode: { type: String, default: null },
    stack: { type: String, default: null },
  },
  { _id: false },
);

const attemptSchema = new mongoose.Schema(
  {
    /** Relie la trace aux entrées de journal émises pendant la requête. */
    requestId: { type: String, required: true, index: true },
    route: { type: String, required: true },
    method: { type: String, required: true },

    /** La cible visée, quand la requête a eu le temps de la résoudre. */
    /** L'identifiant de destination du Panel est une chaîne (UUID), pas un ObjectId. */
    target: { type: String, default: null, index: true },
    /** Le run, dès qu'il existe. `null` signifie « la panne l'a précédé ». */
    run: { type: String, default: null, index: true },

    user: { type: String, default: null },
    status: { type: String, enum: ['open', 'closed', 'failed'], default: 'open', index: true },
    httpStatus: { type: Number, default: null },

    startedAt: { type: Date, required: true },
    finishedAt: { type: Date, default: null },

    journal: { type: [journalEntrySchema], default: [] },
  },
  { timestamps: true },
);

/**
 * Les tentatives sont un filet de diagnostic, pas un archivage.
 *
 * Sans expiration, elles s'accumuleraient indéfiniment pour un usage qui ne
 * dépasse jamais quelques jours. 30 jours couvrent largement le délai entre un
 * incident et son analyse.
 */
attemptSchema.index({ startedAt: 1 }, { expireAfterSeconds: 30 * 24 * 3600 });

export const PanelDeploymentAttempt = mongoose.model('PanelDeploymentAttempt', attemptSchema);
export default PanelDeploymentAttempt;
