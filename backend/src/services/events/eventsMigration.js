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
import { mergeParticipants, participantsFromLegacy } from './participants.js';

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
        participants: participantsFromLegacy(doc),
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
          participants: participantsFromLegacy(doc),
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
      participants: participantsFromLegacy(doc),
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

/**
 * MIGRATION DES PARTICIPANTS — du texte séparé par des virgules vers une liste.
 *
 * ── CE QUI EXISTAIT ─────────────────────────────────────────────────────────
 * Deux champs par réunion et par événement : `internalParticipants` (des objets
 * nom/courriel) et `externalParticipants`, un tableau de chaînes que l'interface
 * remplissait en découpant un champ texte sur les virgules. Rien n'empêchait
 * qu'une seule entrée contienne « Jean Dupont, Marie Martin ».
 *
 * ── TRANSFORMATION ──────────────────────────────────────────────────────────
 *
 * | Ancien                                | Devient                            |
 * |---------------------------------------|------------------------------------|
 * | externalParticipants: ['a@b.fr']      | { EXTERNAL, name: 'a@b.fr', email } |
 * | externalParticipants: ['Jean, Marie'] | DEUX participants EXTERNAL         |
 * | internalParticipants: [{name, email}] | { INTERNAL, name, email }          |
 * | valeur vide ou blanche                | rien — elle ne désignait personne   |
 *
 * Une ancienne valeur à virgules devient PLUSIEURS participants : c'est ce
 * qu'elle voulait dire. Les nouvelles saisies, elles, refusent la virgule —
 * l'API ne laisse pas refabriquer la chaîne qu'on vient de démonter.
 *
 * ── SÛRETÉ ──────────────────────────────────────────────────────────────────
 * Un seul `updateOne` par document écrit la nouvelle liste ET retire les
 * anciens champs : il n'existe aucun instant où l'un est parti sans que l'autre
 * soit arrivé. Rien n'est perdu — tout ce que l'ancienne donnée disait se
 * retrouve dans un participant, y compris une adresse électronique seule, qui
 * devient à la fois le courriel et le nom affiché faute d'en savoir plus.
 *
 * ── IDEMPOTENTE ─────────────────────────────────────────────────────────────
 * Le filtre exige la PRÉSENCE d'un ancien champ : après un passage, il n'en
 * reste aucun, un second passage n'examine donc rien. Et si une exécution est
 * interrompue entre deux documents, la reprise ne voit que ceux qui n'ont pas
 * encore été traités. Une base déjà convertie n'est jamais touchée.
 *
 * Le cas tordu — un document portant DÉJÀ des participants et ENCORE un ancien
 * champ — se règle par fusion sans doublon, jamais par écrasement : personne ne
 * disparaît, et personne n'apparaît deux fois.
 */
export async function migrateParticipants() {
  let examines = 0;
  let convertis = 0;
  let participants = 0;

  for (const model of [PanelMeeting, PanelProjectEvent]) {
    // Collection BRUTE : les anciens champs ne font plus partie du schéma,
    // Mongoose ne les lirait tout simplement pas.
    const collection = model.collection;
    // eslint-disable-next-line no-await-in-loop
    const anciens = await collection.find({
      $or: [
        { internalParticipants: { $exists: true } },
        { externalParticipants: { $exists: true } },
      ],
    }).toArray();
    examines += anciens.length;

    for (const doc of anciens) {
      const liste = mergeParticipants(doc.participants ?? [], participantsFromLegacy(doc));
      // eslint-disable-next-line no-await-in-loop
      await collection.updateOne(
        { _id: doc._id },
        {
          $set: { participants: liste },
          $unset: { internalParticipants: '', externalParticipants: '' },
        },
      );
      convertis += 1;
      participants += liste.length;
    }
  }

  if (examines > 0) {
    logger.info(
      `Migration des participants : ${convertis} objet(s) repris — ${participants} participant(s) structuré(s).`,
    );
  }
  return { examined: examines, converted: convertis, participants };
}

export default { migrateLegacyEvents, migrateParticipants };
