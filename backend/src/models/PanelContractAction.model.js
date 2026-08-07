import mongoose from 'mongoose';

/**
 * JOURNAL DES ACTIONS CONTRACTUELLES demandées depuis le Panel.
 *
 * ── POURQUOI UN JOURNAL DÉDIÉ ───────────────────────────────────────────────
 * Résilier engage. Six mois plus tard, la seule question qui vaudra est « qui
 * a demandé quoi, quand, et qu'a répondu le projet ». Le journal d'exécution
 * du moteur de déploiement ne répond pas à celle-là : il modélise des runs
 * avec approbations et simulation, une machinerie sans rapport avec une
 * demande unique adressée à un projet.
 *
 * On consigne AVANT d'appeler et on complète APRÈS : une demande partie dont
 * la réponse s'est perdue doit laisser une trace, sinon l'incident le plus
 * grave — « on ne sait pas si c'est passé » — serait le seul à ne rien écrire.
 *
 * Ce journal n'est PAS la vérité du contrat. Le projet reste l'autorité ; ce
 * qu'on garde ici, c'est l'intention et la réponse.
 */
const contractActionSchema = new mongoose.Schema(
  {
    projectId: { type: String, required: true, index: true },
    projectName: { type: String, default: null },
    environment: { type: String, default: null },

    operationId: { type: String, required: true },
    invocationId: { type: String, required: true, unique: true },

    // Qui a demandé. Jamais « le système » : une résiliation a un auteur.
    actor: {
      userId: { type: String, default: null },
      email: { type: String, default: null },
      role: { type: String, default: null },
    },
    reason: { type: String, default: null },

    contract: {
      sourceContractId: { type: String, default: null },
      reference: { type: String, default: null },
      previousStatus: { type: String, default: null },
      newStatus: { type: String, default: null },
      endsAt: { type: String, default: null },
    },

    /**
     * PROTECTION CONTRACTUELLE — renseigné pour la seule opération de réglage.
     *
     * Additif : les actions de résiliation le laissent à `null`, et les lignes
     * antérieures à ce champ restent lisibles telles quelles. `requested` est
     * l'intention, `applied` ce que le projet a CONSTATÉ après réconciliation —
     * les confondre laisserait croire qu'une demande vaut un effet.
     */
    protection: {
      requested: { type: Boolean, default: null },
      applied: { type: Boolean, default: null },
      siteStatus: { type: String, default: null },
      suspensionSource: { type: String, default: null },
    },

    outcome: {
      type: String,
      enum: ['REQUESTED', 'SUCCEEDED', 'FAILED'],
      default: 'REQUESTED',
      index: true,
    },
    errorCode: { type: String, default: null },
    errorMessage: { type: String, default: null },

    requestedAt: { type: String, required: true },
    completedAt: { type: String, default: null },
  },
  { minimize: false, versionKey: false },
);

contractActionSchema.index({ projectId: 1, requestedAt: -1 });

export const PanelContractAction = mongoose.model('PanelContractAction', contractActionSchema);

export default { PanelContractAction };
