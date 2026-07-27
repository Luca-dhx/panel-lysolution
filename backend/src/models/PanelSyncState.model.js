// État persistant du noyau de synchronisation — quatre collections :
//  - réceptions (idempotence par writeId → ack DUPLICATE après redémarrage) ;
//  - état par entité (LWW → ack IGNORED) ;
//  - journal ordonné des écritures émises côté Panel (GET /sync/pull) ;
//  - compteur de séquence du journal.
// Les écritures DIAGNOSTIC appliquées sont conservées pour l'observabilité.
import mongoose from 'mongoose';

const receiptSchema = new mongoose.Schema(
  {
    projectId: { type: String, required: true },
    writeId: { type: String, required: true },
    receivedAt: { type: String, required: true },
  },
  { versionKey: false },
);
receiptSchema.index({ projectId: 1, writeId: 1 }, { unique: true });

const entityStateSchema = new mongoose.Schema(
  {
    projectId: { type: String, required: true },
    entityType: { type: String, required: true },
    entityId: { type: String, required: true },
    modifiedAt: { type: String, required: true },
  },
  { versionKey: false },
);
entityStateSchema.index({ projectId: 1, entityType: 1, entityId: 1 }, { unique: true });

const journalEntrySchema = new mongoose.Schema(
  {
    seq: { type: Number, required: true, unique: true },
    originProjectId: { type: String, default: null },
    change: { type: mongoose.Schema.Types.Mixed, required: true },
  },
  { minimize: false, versionKey: false },
);

const counterSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, unique: true },
    value: { type: Number, required: true, default: 0 },
  },
  { versionKey: false },
);

const diagnosticSchema = new mongoose.Schema(
  {
    projectId: { type: String, required: true },
    change: { type: mongoose.Schema.Types.Mixed, required: true },
    receivedAt: { type: String, required: true },
  },
  { minimize: false, versionKey: false },
);
diagnosticSchema.index({ projectId: 1 });

export const PanelSyncReceipt = mongoose.model('PanelSyncReceipt', receiptSchema);
export const PanelSyncEntityState = mongoose.model('PanelSyncEntityState', entityStateSchema);
export const PanelSyncJournalEntry = mongoose.model('PanelSyncJournalEntry', journalEntrySchema);
export const PanelCounter = mongoose.model('PanelCounter', counterSchema);
export const PanelDiagnostic = mongoose.model('PanelDiagnostic', diagnosticSchema);
