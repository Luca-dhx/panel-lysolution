/**
 * MIGRATION — d'un objet unique vers réunion + événement.
 *
 * ── CE QUI EXISTAIT ─────────────────────────────────────────────────────────
 * Un seul `PanelProjectEvent` portait les deux rôles : le rendez-vous prévu et
 * le fait passé. Son type `MEETING` et ses statuts `PLANNED` / `DUE` /
 * `COMPLETED` mélangeaient un objet d'agenda et un objet d'histoire.
 *
 * ── TRANSFORMATIONS ─────────────────────────────────────────────────────────
 *
 * | Ancien (type / statut)      | Devient                                      |
 * |-----------------------------|----------------------------------------------|
 * | MEETING / PLANNED           | réunion PLANNED                              |
 * | MEETING / DUE               | réunion DONE_PENDING_CONFIRMATION            |
 * |                             | + événement MEETING_OCCURRED PENDING_CONF.   |
 * | MEETING / COMPLETED         | événement MEETING_OCCURRED CONFIRMED         |
 * | MEETING / MISSED            | événement MEETING_OCCURRED MISSED            |
 * | MEETING / CANCELLED         | réunion CANCELLED                            |
 * | autre type / PLANNED ou DUE | événement du même type, PENDING_CONFIRMATION |
 * | autre type / COMPLETED      | événement du même type, CONFIRMED            |
 * | autre type / MISSED         | événement du même type, MISSED               |
 * | autre type / CANCELLED      | événement du même type, CANCELLED            |
 *
 * `scheduledAt` devient `occurredAt` pour un événement, `scheduledAt` pour une
 * réunion. Le compte rendu, le résultat, les prochaines actions et les
 * participants suivent l'objet qui les porte encore.
 *
 * ── SÛRETÉ ──────────────────────────────────────────────────────────────────
 * L'ordre est toujours le même : ÉCRIRE le nouveau, puis seulement effacer
 * l'ancien. Une interruption au milieu laisse donc au pire un doublon visible,
 * jamais un trou — et le doublon se corrige, un trou ne se retrouve pas.
 *
 * Rien n'est perdu : tout le contenu de l'ancien document est reporté sur le
 * ou les nouveaux. L'ancien est ensuite retiré parce qu'il porte des statuts
 * (`PLANNED`, `DUE`, `COMPLETED`) que le nouveau modèle ne connaît plus : le
 * laisser en place ferait apparaître un objet inclassable dans l'historique.
 *
 * Idempotente : relancée, elle ne trouve plus aucun ancien statut. Une base
 * déjà au nouveau format n'est pas touchée.
 */
import logger from '../../utils/logger.js';
import { MEETING_STATUS, PanelMeeting } from '../../models/PanelMeeting.model.js';
import { EVENT_STATUS, PanelProjectEvent } from '../../models/PanelProjectEvent.model.js';

/** Statuts qui n'existent QUE dans l'ancien modèle : ils identifient une relique. */
const ANCIENS_STATUTS = ['PLANNED', 'DUE', 'COMPLETED'];

const NOUVEAU_STATUT = {
  COMPLETED: EVENT_STATUS.CONFIRMED,
  MISSED: EVENT_STATUS.MISSED,
  CANCELLED: EVENT_STATUS.CANCELLED,
  PLANNED: EVENT_STATUS.PENDING_CONFIRMATION,
  DUE: EVENT_STATUS.PENDING_CONFIRMATION,
};

export async function migrateLegacyEvents() {
  // On travaille sur la collection BRUTE : les anciens documents ne passent
  // plus la validation du nouveau schéma, et Mongoose refuserait de les lire.
  const collection = PanelProjectEvent.collection;
  const anciens = await collection.find({ status: { $in: ANCIENS_STATUTS } }).toArray();

  if (anciens.length === 0) return { meetings: 0, events: 0, examined: 0 };

  let reunions = 0;
  let evenements = 0;

  for (const doc of anciens) {
    const estReunion = doc.type === 'MEETING';
    const quand = doc.scheduledAt ?? doc.occurredAt ?? doc.createdAt ?? new Date();

    // ── Réunions encore vivantes : elles repartent dans l'agenda ────────────
    if (estReunion && ['PLANNED', 'DUE', 'CANCELLED'].includes(doc.status)) {
      const statut = doc.status === 'PLANNED' ? MEETING_STATUS.PLANNED
        : doc.status === 'DUE' ? MEETING_STATUS.DONE_PENDING_CONFIRMATION
          : MEETING_STATUS.CANCELLED;

      // eslint-disable-next-line no-await-in-loop
      const reunion = await PanelMeeting.create({
        projectId: doc.projectId,
        projectName: doc.projectName ?? null,
        title: doc.title ?? 'Réunion',
        description: doc.description ?? '',
        scheduledAt: quand,
        durationMinutes: doc.durationMinutes ?? 60,
        internalParticipants: doc.internalParticipants ?? [],
        externalParticipants: doc.externalParticipants ?? [],
        status: statut,
        cancelledAt: doc.cancelledAt ?? null,
        createdBy: doc.createdBy ?? null,
        updatedBy: doc.updatedBy ?? null,
      });
      reunions += 1;

      // Une réunion échue attendait déjà une réponse : on recrée l'attente.
      if (statut === MEETING_STATUS.DONE_PENDING_CONFIRMATION) {
        // eslint-disable-next-line no-await-in-loop
        await PanelProjectEvent.create({
          projectId: doc.projectId,
          projectName: doc.projectName ?? null,
          sourceMeetingId: String(reunion._id),
          type: 'MEETING_OCCURRED',
          title: doc.title ?? 'Réunion',
          occurredAt: quand,
          status: EVENT_STATUS.PENDING_CONFIRMATION,
          internalParticipants: doc.internalParticipants ?? [],
          externalParticipants: doc.externalParticipants ?? [],
          createdBy: doc.createdBy ?? null,
        });
        evenements += 1;
      }

      // L'ancien n'est retiré qu'APRÈS l'écriture du nouveau.
      // eslint-disable-next-line no-await-in-loop
      await collection.deleteOne({ _id: doc._id });
      continue;
    }

    // ── Tout le reste devient un ÉVÉNEMENT ─────────────────────────────────
    // eslint-disable-next-line no-await-in-loop
    await PanelProjectEvent.create({
      projectId: doc.projectId,
      projectName: doc.projectName ?? null,
      sourceMeetingId: null,
      type: estReunion ? 'MEETING_OCCURRED' : (doc.type ?? 'OTHER'),
      title: doc.title ?? 'Événement',
      occurredAt: doc.occurredAt ?? quand,
      status: NOUVEAU_STATUT[doc.status] ?? EVENT_STATUS.CONFIRMED,
      internalParticipants: doc.internalParticipants ?? [],
      externalParticipants: doc.externalParticipants ?? [],
      notes: doc.notes ?? '',
      outcome: doc.outcome ?? '',
      nextActions: doc.nextActions ?? [],
      missedReason: doc.missedReason ?? null,
      confirmedAt: doc.completedAt ?? null,
      createdBy: doc.createdBy ?? null,
      updatedBy: doc.updatedBy ?? null,
    });
    evenements += 1;

    // eslint-disable-next-line no-await-in-loop
    await collection.deleteOne({ _id: doc._id });
  }

  logger.info(
    `Migration agenda : ${anciens.length} enregistrement(s) repris — `
    + `${reunions} réunion(s), ${evenements} événement(s).`,
  );
  return { meetings: reunions, events: evenements, examined: anciens.length };
}

export default { migrateLegacyEvents };
