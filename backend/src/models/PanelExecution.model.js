// EXÉCUTIONS — Phase 3C.
//
// Une exécution est la trace COMPLÈTE d'une opération pilotée : ce qui a été
// demandé, par qui, validé comment, confirmé par qui, exécuté quand, avec
// quel résultat. Elle survit à tout : c'est la matière de l'audit.
//
// Le journal est embarqué dans le document plutôt que dans une collection
// séparée : une entrée de journal n'a aucun sens hors de son exécution, et
// on veut pouvoir lire l'ensemble d'un seul coup.
import mongoose from 'mongoose';

const logEntrySchema = new mongoose.Schema(
  {
    at: { type: String, required: true },
    phase: { type: String, required: true },
    level: { type: String, enum: ['INFO', 'WARNING', 'ERROR'], default: 'INFO' },
    message: { type: String, required: true },
    data: { type: mongoose.Schema.Types.Mixed, default: null },
  },
  { _id: false, minimize: false },
);

const confirmationSchema = new mongoose.Schema(
  {
    at: { type: String, required: true },
    userId: { type: String, required: true },
    userEmail: { type: String, default: null },
    decision: { type: String, enum: ['APPROVED', 'REJECTED'], required: true },
    comment: { type: String, default: null },
  },
  { _id: false },
);

const executionSchema = new mongoose.Schema(
  {
    executionId: { type: String, required: true, unique: true },
    type: { type: String, required: true },
    // Cible : un projet, ou le Panel lui-même.
    projectId: { type: String, default: null },
    projectName: { type: String, default: null },
    environment: { type: String, enum: ['TEST', 'PROD', null], default: null },

    // SIMULATION par défaut — jamais l'inverse.
    mode: { type: String, enum: ['SIMULATION', 'EXECUTION'], required: true, default: 'SIMULATION' },

    parameters: { type: mongoose.Schema.Types.Mixed, default: {} },

    // Qui a demandé. Un pilotage sans initiateur identifié n'est pas auditable.
    initiator: {
      userId: { type: String, required: true },
      userEmail: { type: String, default: null },
      role: { type: String, default: null },
    },

    state: { type: String, required: true },
    // Historique COMPLET des transitions, avec leur raison déclarée.
    stateHistory: {
      type: [new mongoose.Schema({
        at: { type: String, required: true },
        from: { type: String, default: null },
        to: { type: String, required: true },
        reason: { type: String, default: null },
      }, { _id: false })],
      default: [],
    },

    validation: { type: mongoose.Schema.Types.Mixed, default: null },
    confirmations: { type: [confirmationSchema], default: [] },
    confirmationsRequired: { type: Number, default: 0 },

    createdAt: { type: String, required: true },
    startedAt: { type: String, default: null },
    finishedAt: { type: String, default: null },
    durationMs: { type: Number, default: null },

    result: { type: mongoose.Schema.Types.Mixed, default: null },
    error: { type: mongoose.Schema.Types.Mixed, default: null },
    log: { type: [logEntrySchema], default: [] },

    attempt: { type: Number, default: 1 },
    // Corrélation : relie les exécutions d'une même campagne, ou une
    // compensation à l'exécution qu'elle répare.
    correlationId: { type: String, default: null },
    parentExecutionId: { type: String, default: null },

    timeoutMs: { type: Number, default: null },
    cancellationRequested: { type: Boolean, default: false },
  },
  { minimize: false, versionKey: false },
);

executionSchema.index({ createdAt: -1 });
executionSchema.index({ projectId: 1, createdAt: -1 });
executionSchema.index({ state: 1 });
executionSchema.index({ correlationId: 1 });

export default mongoose.model('PanelExecution', executionSchema);
