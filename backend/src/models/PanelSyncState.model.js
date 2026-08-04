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
    /**
     * La GÉNÉRATION de la source au moment de l'écriture retenue.
     *
     * Le curseur du dernier-écrit-gagne compare des dates ; comparer des dates
     * n'a de sens qu'à l'intérieur d'une même génération. Un projet redéployé
     * de PROD vers TEST repart d'une autre base : son contrat peut être plus
     * ANCIEN que celui qu'il remplace, et devait pourtant gagner.
     */
    generation: { type: String, default: null },
  },
  { versionKey: false },
);
entityStateSchema.index({ projectId: 1, entityType: 1, entityId: 1 }, { unique: true });

const journalEntrySchema = new mongoose.Schema(
  {
    seq: { type: Number, required: true, unique: true },
    originProjectId: { type: String, default: null },
    // DESTINATAIRE (Phase 4). `null` = diffusion à tout le parc ; un
    // projectId = écriture réservée à CE projet.
    //
    // Sans ce champ, un projet tirerait tout le journal — donc les
    // identifiants d'API destinés à un autre. L'autorisation ne peut pas
    // être un filtre appliqué à la lecture par le projet : elle doit être
    // portée par l'écriture, côté Panel.
    audience: { type: String, default: null },
    change: { type: mongoose.Schema.Types.Mixed, required: true },
  },
  { minimize: false, versionKey: false },
);
journalEntrySchema.index({ audience: 1, seq: 1 });

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
