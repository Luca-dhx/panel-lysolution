// Noyau de synchronisation du Panel — docs/architecture/03_PANEL_BRIDGE.md §4.
// Implémente les cinq règles minimales (idempotence, LWW, tombstones,
// anti-écho, identités UUID) et RIEN au-delà.
// Phase 2B : seul DIAGNOSTIC est appliqué ; le journal d'émission existe mais
// reste vide tant qu'aucun domaine n'est synchronisé.
import {
  ACK_STATUS,
  APPLIED_ENTITY_TYPES,
  BRIDGE_ERROR_CODES,
  BridgeError,
  EMITTERS,
  newBridgeId,
  nowIso,
} from '../../bridge/bridgeContract.js';

// Mémoire d'idempotence, par projet :
//   seenWriteIds : Set<writeId> déjà traités (fonde l'ack DUPLICATE)
//   lastModified : Map<'entityType/entityId', modifiedAt> (fonde l'ack IGNORED)
const receivedByProject = new Map();

// Journal ordonné des écritures émises côté Panel (alimente GET /sync/pull).
const journal = [];
let nextSeq = 1;

// Écritures DIAGNOSTIC appliquées — observabilité et tests.
const appliedDiagnostics = [];

function receivedState(projectId) {
  let state = receivedByProject.get(projectId);
  if (!state) {
    state = { seenWriteIds: new Set(), lastModified: new Map() };
    receivedByProject.set(projectId, state);
  }
  return state;
}

function entityKey(change) {
  return `${change.entityType}/${change.entityId}`;
}

// Applique un lot d'écritures poussé par un projet. Accusé PAR écriture —
// jamais un échec global silencieux.
export function applyIncoming(projectId, changes) {
  const state = receivedState(projectId);
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

    if (state.seenWriteIds.has(change.writeId)) {
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
        message: `entityType ${change.entityType} non synchronisé en Phase 2B.`,
      });
      continue;
    }

    const key = entityKey(change);
    const known = state.lastModified.get(key);
    if (known && new Date(change.modifiedAt).getTime() <= new Date(known).getTime()) {
      state.seenWriteIds.add(change.writeId);
      results.push({ writeId: change.writeId, status: ACK_STATUS.IGNORED, code: null, message: null });
      continue;
    }

    state.seenWriteIds.add(change.writeId);
    state.lastModified.set(key, change.modifiedAt);
    appliedDiagnostics.push({ projectId, change, receivedAt: nowIso() });
    results.push({ writeId: change.writeId, status: ACK_STATUS.APPLIED, code: null, message: null });
  }

  return { results };
}

// Point d'émission côté Panel — utilisé par les lots de Phase 3 (et par les
// tests, avec DIAGNOSTIC). `originProjectId` identifie l'émetteur d'ORIGINE
// quand l'écriture rediffuse une modification arrivée d'un projet (anti-écho).
export function emitChange({
  entityType,
  entityId,
  deleted = false,
  payload = null,
  modifiedAt = nowIso(),
  emitter = EMITTERS.PANEL,
  originProjectId = null,
  writeId = newBridgeId(),
}) {
  const entry = {
    seq: nextSeq++,
    originProjectId,
    change: { writeId, entityType, entityId, deleted, payload, modifiedAt, emitter },
  };
  journal.push(entry);
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
export function pullForProject(projectId, { cursor, limit }) {
  const afterSeq = decodeCursor(cursor);
  const eligible = journal.filter(
    (entry) => entry.seq > afterSeq && entry.originProjectId !== projectId,
  );
  const page = eligible.slice(0, limit);
  const lastSeq = page.length > 0 ? page[page.length - 1].seq : afterSeq;
  return {
    changes: page.map((entry) => entry.change),
    cursor: encodeCursor(lastSeq),
    hasMore: eligible.length > page.length,
  };
}

// Observabilité (fiche projet, tests).
export function getDiagnosticsFor(projectId) {
  return appliedDiagnostics.filter((item) => item.projectId === projectId);
}

// Réinitialisation complète — réservée aux tests.
export function resetSyncCore() {
  receivedByProject.clear();
  journal.length = 0;
  appliedDiagnostics.length = 0;
  nextSeq = 1;
}
