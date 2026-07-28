// Noyau de synchronisation du Panel — docs/architecture/03_PANEL_BRIDGE.md §4.
// Implémente les cinq règles minimales (idempotence, LWW, tombstones,
// anti-écho, identités UUID) et RIEN au-delà.
// Persistance MongoDB : l'idempotence, l'état LWW et le journal d'émission
// survivent à un redémarrage (une relivraison après reboot répond DUPLICATE,
// jamais une double application).
// Seul DIAGNOSTIC est appliqué ; les types réservés répondent REJECTED.
import {
  ACK_STATUS,
  APPLIED_ENTITY_TYPES,
  BRIDGE_ERROR_CODES,
  BridgeError,
  EMITTERS,
  newBridgeId,
  nowIso,
} from '../../bridge/bridgeContract.js';
import {
  PanelCounter,
  PanelDiagnostic,
  PanelSyncEntityState,
  PanelSyncJournalEntry,
  PanelSyncReceipt,
} from '../../models/PanelSyncState.model.js';

const JOURNAL_SEQ_KEY = 'syncJournalSeq';

async function nextJournalSeq() {
  const counter = await PanelCounter.findOneAndUpdate(
    { key: JOURNAL_SEQ_KEY },
    { $inc: { value: 1 } },
    { new: true, upsert: true },
  ).lean();
  return counter.value;
}

// Applique un lot d'écritures poussé par un projet. Accusé PAR écriture —
// jamais un échec global silencieux.
export async function applyIncoming(projectId, changes) {
  const results = [];

  for (const change of changes) {
    // Sémantique du contrat, vérifiée par écriture (la forme l'a déjà été).
    if (change.deleted === true && change.payload != null) {
      results.push({
        writeId: change.writeId,
        status: ACK_STATUS.REJECTED,
        code: BRIDGE_ERROR_CODES.INVALID_PAYLOAD,
        message: 'Un tombstone (deleted=true) doit porter un payload null.',
      });
      continue;
    }
    if (change.emitter !== EMITTERS.PROJECT) {
      results.push({
        writeId: change.writeId,
        status: ACK_STATUS.REJECTED,
        code: BRIDGE_ERROR_CODES.INVALID_PAYLOAD,
        message: 'Un push de projet ne transporte que des écritures emitter=PROJECT.',
      });
      continue;
    }

    if (await PanelSyncReceipt.exists({ projectId, writeId: change.writeId })) {
      results.push({ writeId: change.writeId, status: ACK_STATUS.DUPLICATE, code: null, message: null });
      continue;
    }

    if (!APPLIED_ENTITY_TYPES.includes(change.entityType)) {
      // Type réservé à un lot de Phase 3 : refus propre, writeId NON consigné
      // (le jour où le lot est livré, une relivraison sera appliquée).
      results.push({
        writeId: change.writeId,
        status: ACK_STATUS.REJECTED,
        code: BRIDGE_ERROR_CODES.ENTITY_TYPE_UNSUPPORTED,
        message: `entityType ${change.entityType} non synchronisé dans cette version du Panel.`,
      });
      continue;
    }

    const known = await PanelSyncEntityState.findOne({
      projectId,
      entityType: change.entityType,
      entityId: change.entityId,
    }).lean();
    if (known && new Date(change.modifiedAt).getTime() <= new Date(known.modifiedAt).getTime()) {
      await PanelSyncReceipt.create({ projectId, writeId: change.writeId, receivedAt: nowIso() });
      results.push({ writeId: change.writeId, status: ACK_STATUS.IGNORED, code: null, message: null });
      continue;
    }

    await PanelSyncReceipt.create({ projectId, writeId: change.writeId, receivedAt: nowIso() });
    await PanelSyncEntityState.updateOne(
      { projectId, entityType: change.entityType, entityId: change.entityId },
      { $set: { modifiedAt: change.modifiedAt } },
      { upsert: true },
    );
    await PanelDiagnostic.create({ projectId, change, receivedAt: nowIso() });
    results.push({ writeId: change.writeId, status: ACK_STATUS.APPLIED, code: null, message: null });
  }

  return { results };
}

// Point d'émission côté Panel — utilisé par les lots de Phase 3 (et par les
// tests, avec DIAGNOSTIC). `originProjectId` identifie l'émetteur d'ORIGINE
// quand l'écriture rediffuse une modification arrivée d'un projet (anti-écho).
export async function emitChange({
  entityType,
  entityId,
  deleted = false,
  payload = null,
  modifiedAt = nowIso(),
  emitter = EMITTERS.PANEL,
  originProjectId = null,
  // Destinataire — null = tout le parc, sinon un projectId. Une écriture
  // portant des identifiants doit TOUJOURS nommer son destinataire.
  audience = null,
  writeId = newBridgeId(),
}) {
  const entry = {
    seq: await nextJournalSeq(),
    originProjectId,
    audience,
    change: { writeId, entityType, entityId, deleted, payload, modifiedAt, emitter },
  };
  await PanelSyncJournalEntry.create(entry);
  return entry;
}

function encodeCursor(seq) {
  return Buffer.from(String(seq), 'utf8').toString('base64url');
}

function decodeCursor(cursor) {
  if (cursor === undefined) return 0;
  const decoded = Buffer.from(String(cursor), 'base64url').toString('utf8');
  if (!/^\d+$/.test(decoded)) {
    throw new BridgeError(BRIDGE_ERROR_CODES.INVALID_PAYLOAD, 'Curseur de pull invalide.');
  }
  return Number(decoded);
}

// Page ordonnée des écritures à destination d'un projet. Curseur opaque ;
// anti-écho : les écritures dont ce projet est l'émetteur d'origine sont
// exclues.
//
// FILTRE DE DESTINATAIRE (Phase 4) : un projet reçoit les écritures diffusées
// (`audience: null`) et celles qui lui sont nommément destinées. Jamais celles
// d'un autre projet — c'est ce qui rend l'autorisation des IntegratedAPI
// effective plutôt que déclarative.
export async function pullForProject(projectId, { cursor, limit }) {
  const afterSeq = decodeCursor(cursor);
  const query = {
    seq: { $gt: afterSeq },
    originProjectId: { $ne: projectId },
    $or: [{ audience: null }, { audience: projectId }],
  };
  const page = await PanelSyncJournalEntry.find(query).sort({ seq: 1 }).limit(limit).lean();
  const eligibleCount = await PanelSyncJournalEntry.countDocuments(query);
  const lastSeq = page.length > 0 ? page[page.length - 1].seq : afterSeq;
  return {
    changes: page.map((entry) => entry.change),
    cursor: encodeCursor(lastSeq),
    hasMore: eligibleCount > page.length,
  };
}

/**
 * Curseur de la TÊTE du journal — joint au bootstrap (contrat >= 1.3.0) pour
 * qu'un projet fraîchement appairé ne rejoue pas la configuration qu'il vient
 * de recevoir dans la réponse.
 */
export async function currentCursor() {
  const last = await PanelSyncJournalEntry.findOne().sort({ seq: -1 }).select('seq').lean();
  return encodeCursor(last?.seq ?? 0);
}

// Observabilité (fiche projet, tests).
export async function getDiagnosticsFor(projectId) {
  return PanelDiagnostic.find({ projectId }).lean();
}

// Réinitialisation complète — réservée aux tests.
export async function resetSyncCore() {
  await Promise.all([
    PanelSyncReceipt.deleteMany({}),
    PanelSyncEntityState.deleteMany({}),
    PanelSyncJournalEntry.deleteMany({}),
    PanelDiagnostic.deleteMany({}),
    PanelCounter.deleteMany({ key: JOURNAL_SEQ_KEY }),
  ]);
}
