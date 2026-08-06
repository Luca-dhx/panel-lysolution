// Noyau de synchronisation du Panel — docs/architecture/03_PANEL_BRIDGE.md §4.
// Implémente les cinq règles minimales (idempotence, LWW, tombstones,
// anti-écho, identités UUID) et RIEN au-delà.
// Persistance MongoDB : l'idempotence, l'état LWW et le journal d'émission
// survivent à un redémarrage (une relivraison après reboot répond DUPLICATE,
// jamais une double application).
// Seul DIAGNOSTIC est appliqué ; les types réservés répondent REJECTED.
import { ENTITY_PAYLOAD_INVALID, PROJECTORS, needsRepair } from './projectors.js';
import { currentGeneration, stampOf } from './projectGeneration.js';
import {
  activeDestination, announceDestination,
} from '../registry/projectDestination.service.js';
import { registryStore } from '../registry/registryStore.js';
import logger from '../../utils/logger.js';
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
/**
 * LA DESTINATION QUE CE LOT ANNONCE — extraite, jamais devinée.
 *
 * Seule une `PROJECT_PRESENTATION` non supprimée porte les adresses du projet.
 * Un tombstone n'annonce rien : effacer la présentation ne signifie pas que le
 * projet a déménagé, et en déduire une migration serait inventer.
 *
 * L'annonce ne casse jamais la synchronisation : si elle échoue, le lot
 * s'applique quand même et l'incident est journalisé. Perdre des écritures
 * métier parce qu'une adresse est mal formée serait un remède pire que le mal.
 */
async function announceFromChanges(record, changes) {
  if (!record) return;
  const presentation = [...changes]
    .reverse()
    .find((c) => c.entityType === 'PROJECT_PRESENTATION' && c.deleted !== true && c.payload?.network);
  if (!presentation) return;

  try {
    await announceDestination({
      record,
      urls: presentation.payload.network,
      source: 'PRESENTATION',
    });
  } catch (err) {
    logger.warn(`[destination] Annonce impossible pour ${record.projectId} : ${err.message}`);
  }
}

// jamais un échec global silencieux.
export async function applyIncoming(projectId, changes) {
  const results = [];

  /**
   * LA GÉNÉRATION DE LA SOURCE — lue UNE fois pour tout le lot.
   *
   * Elle dit de quel monde viennent ces écritures : quel environnement, quel
   * appairage. C'est elle qui permet de distinguer « une écriture plus
   * ancienne » — qu'on écarte — d'« une écriture venue d'un autre monde », qui
   * remplace tout ce que le précédent avait laissé.
   */
  const record = await registryStore.getById(projectId);

  /**
   * LA DESTINATION ANNONCÉE PAR CE LOT — avant d'appliquer quoi que ce soit.
   *
   * ── POURQUOI ICI, ET AVANT ────────────────────────────────────────────────
   * Une projection `PROJECT_PRESENTATION` porte les trois adresses du projet.
   * C'est aujourd'hui le SEUL canal qui suit un changement de domaine : le
   * battement de cœur ne transporte aucune URL, et le manifeste n'est relu
   * qu'à l'appairage. Lire cette annonce APRÈS avoir appliqué le lot ferait
   * estampiller les projections avec l'ancienne génération — donc les rendre
   * périmées à l'instant même où elles arrivent.
   *
   * Le Panel ne déploie rien pour autant : il enregistre ce que le projet
   * déclare, et arbitre l'état de ses destinations.
   */
  await announceFromChanges(record, changes);

  const destination = await activeDestination(record?.projectId, record?.runtime?.environment);
  const generation = currentGeneration(record, destination?.host ?? null);
  const stamp = stampOf(record, nowIso(), destination?.host ?? null);

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

    // Déjà vue — sauf si la projection correspondante MANQUE. Un accusé ne doit
    // jamais retirer une écriture de la file du projet tant que rien n'a été
    // écrit ici : ce serait perdre la donnée en silence, définitivement.
    if (await PanelSyncReceipt.exists({ projectId, writeId: change.writeId })
        && !(await needsRepair(projectId, change))) {
      results.push({ writeId: change.writeId, status: ACK_STATUS.DUPLICATE, code: null, message: null });
      continue;
    }

    if (!PROJECTORS[change.entityType]) {
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
    /**
     * CHANGEMENT DE GÉNÉRATION — le dernier-écrit-gagne ne s'applique plus.
     *
     * Comparer deux dates suppose qu'elles mesurent la même histoire. Après un
     * redéploiement de PROD vers TEST, ce n'est plus vrai : la nouvelle
     * instance repart d'une autre base, et son contrat — pourtant le seul
     * valable — peut porter une date plus ancienne que celui qu'il remplace.
     * Le Panel l'écartait alors comme « périmé », et gardait indéfiniment
     * l'état PROD.
     *
     * Une écriture venue d'une génération différente de celle du curseur gagne
     * donc toujours. À l'intérieur d'une même génération, rien ne change.
     */
    const nouvelleGeneration = Boolean(known)
      && Boolean(known.generation)
      && known.generation !== generation.generation;

    /**
     * PERDANTE DU DERNIER-ÉCRIT-GAGNE — mais seulement si elle est STRICTEMENT
     * plus ancienne.
     *
     * La comparaison était `<=`, et cela a coûté cher : une écriture portant le
     * MÊME horodatage que le curseur était écartée, alors qu'elle disait autre
     * chose. C'est exactement ce qui se passe quand la FORME de la photographie
     * change sans que la donnée métier ne bouge — un contrat résilié republié
     * avec, cette fois, la distinction courant/historique. Le Panel accusait
     * réception, la file se vidait, et la nouvelle information était perdue pour
     * de bon.
     *
     * Une écriture déjà vue est écartée plus haut, sur son `writeId` : à égalité
     * d'horodatage, un writeId différent est une information nouvelle, pas un
     * doublon.
     */
    if (known && !nouvelleGeneration
        && new Date(change.modifiedAt).getTime() < new Date(known.modifiedAt).getTime()
        && !(await needsRepair(projectId, change))) {
      await PanelSyncReceipt.create({ projectId, writeId: change.writeId, receivedAt: nowIso() });
      results.push({ writeId: change.writeId, status: ACK_STATUS.IGNORED, code: null, message: null });
      continue;
    }

    // PROJECTION — le seul endroit spécifique au type, et il est délégué.
    // Un payload non conforme est REJETÉ avant toute écriture : ni reçu, ni
    // état d'entité, ni projection partielle. Le writeId n'est pas consigné,
    // de sorte qu'une correction du projet soit relivrée et appliquée.
    try {
      await PROJECTORS[change.entityType]({ projectId, change, stamp });
    } catch (err) {
      results.push({
        writeId: change.writeId,
        status: ACK_STATUS.REJECTED,
        code: err?.details?.code ?? ENTITY_PAYLOAD_INVALID,
        message: err?.message ?? 'Payload refusé.',
      });
      continue;
    }

    // `updateOne` + upsert plutôt que `create` : une réparation rejoue un
    // writeId déjà consigné, et un reçu en double ne doit pas faire échouer
    // l'écriture qu'on vient précisément de réussir.
    await PanelSyncReceipt.updateOne(
      { projectId, writeId: change.writeId },
      { $setOnInsert: { projectId, writeId: change.writeId, receivedAt: nowIso() } },
      { upsert: true },
    );
    // Le curseur du dernier-écrit-gagne n'AVANCE jamais à reculons : une
    // réparation peut rejouer un état plus ancien que le curseur connu, et le
    // rabaisser rouvrirait la porte à des écritures déjà écartées.
    const avance = !known
      || nouvelleGeneration
      || new Date(change.modifiedAt).getTime() > new Date(known.modifiedAt).getTime();
    if (avance) {
      await PanelSyncEntityState.updateOne(
        { projectId, entityType: change.entityType, entityId: change.entityId },
        { $set: { modifiedAt: change.modifiedAt, generation: generation.generation } },
        { upsert: true },
      );
    }
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
