/**
 * RÉUNIONS — l'agenda de l'équipe.
 *
 * ── AUCUN PONT ──────────────────────────────────────────────────────────────
 * Rien ici n'appelle un projet. Ce sont nos rendez-vous, pas les siens.
 *
 * ── LA CONVERSION, ET POURQUOI ELLE EST LE CŒUR ─────────────────────────────
 * À l'échéance, une réunion ne devient pas « tenue » : elle devient « à
 * confirmer », et engendre UN événement en attente. C'est cet événement que
 * l'opérateur classera. La réunion, elle, a fini son travail d'agenda.
 *
 * Un seul événement par réunion, garanti par un index unique sur
 * `sourceMeetingId` : deux cycles concurrents ne peuvent pas créer deux
 * confirmations pour le même rendez-vous.
 */
import ApiError from '../../utils/ApiError.js';
import logger from '../../utils/logger.js';
import {
  MEETING_MODES,
  MEETING_STATUS,
  MEETING_TRANSITIONS,
  PanelMeeting,
  REMOTE_KINDS,
} from '../../models/PanelMeeting.model.js';
import { applyPatch } from './revisions.js';
import { normalizeParticipants, refuseLegacyParticipants } from './participants.js';
import { EVENT_STATUS, PanelProjectEvent } from '../../models/PanelProjectEvent.model.js';

function transition(meeting, to) {
  const autorisees = MEETING_TRANSITIONS[meeting.status] ?? [];
  if (!autorisees.includes(to)) {
    throw ApiError.conflict(
      'PANEL_MEETING_TRANSITION_FORBIDDEN',
      `Une réunion ${meeting.status} ne peut pas passer à ${to}.`,
    );
  }
  meeting.status = to;
  return meeting;
}

/**
 * NORMALISE le mode et EFFACE les champs incompatibles.
 *
 * Les effacer plutôt que les masquer : une adresse laissée sur une
 * visioconférence finit par être lue comme le lieu du rendez-vous, et un
 * numéro oublié sur un présentiel fait appeler quelqu'un pour rien.
 *
 * @returns {object} les champs de lieu, prêts à être appliqués
 */
export function normalizeMode(data) {
  const mode = MEETING_MODES.includes(data.mode) ? data.mode : 'ONSITE';

  if (mode === 'ONSITE') {
    const address = String(data.address ?? '').trim();
    if (!address) {
      throw ApiError.badRequest(
        'PANEL_MEETING_ADDRESS_REQUIRED',
        'Une réunion en présentiel demande une adresse.',
      );
    }
    return {
      mode,
      address,
      addressComplement: String(data.addressComplement ?? '').trim(),
      accessNotes: String(data.accessNotes ?? '').trim(),
      remoteKind: null,
      phone: '',
      meetingUrl: '',
    };
  }

  const remoteKind = REMOTE_KINDS.includes(data.remoteKind) ? data.remoteKind : null;
  if (!remoteKind) {
    throw ApiError.badRequest(
      'PANEL_MEETING_REMOTE_KIND_REQUIRED',
      'Précisez s’il s’agit d’un appel ou d’une visioconférence.',
    );
  }

  if (remoteKind === 'CALL') {
    const phone = String(data.phone ?? '').trim();
    if (!phone) {
      throw ApiError.badRequest(
        'PANEL_MEETING_PHONE_REQUIRED',
        'Un appel demande un numéro de téléphone.',
      );
    }
    return {
      mode, remoteKind, phone, meetingUrl: '',
      address: '', addressComplement: '', accessNotes: '',
    };
  }

  const meetingUrl = String(data.meetingUrl ?? '').trim();
  let url;
  try {
    url = new URL(meetingUrl);
  } catch {
    url = null;
  }
  // HTTPS, ou un schéma d'application réellement utilisé pour la visio. Un
  // `http://` en clair est refusé : un lien de réunion transporte un jeton.
  const schemasAcceptes = ['https:', 'msteams:', 'zoommtg:', 'webex:'];
  if (!url || !schemasAcceptes.includes(url.protocol)) {
    throw ApiError.badRequest(
      'PANEL_MEETING_URL_INVALID',
      'Le lien de visioconférence doit être une adresse https (ou un lien d’application reconnu).',
    );
  }
  return {
    mode, remoteKind, meetingUrl, phone: '',
    address: '', addressComplement: '', accessNotes: '',
  };
}

export async function createMeeting(data, actor = {}) {
  const {
    projectId, projectName = null, title, description = '',
    scheduledAt, durationMinutes = 60,
    participants = [],
    rescheduledFromMeetingId = null,
  } = data ?? {};

  refuseLegacyParticipants(data ?? {});
  if (!projectId) throw ApiError.badRequest('PANEL_MEETING_PROJECT_REQUIRED', 'Projet requis.');
  if (!title || !String(title).trim()) {
    throw ApiError.badRequest('PANEL_MEETING_TITLE_REQUIRED', 'Un intitulé est requis.');
  }
  if (!scheduledAt || Number.isNaN(new Date(scheduledAt).getTime())) {
    throw ApiError.badRequest('PANEL_MEETING_DATE_REQUIRED', 'Une date et une heure sont requises.');
  }

  return PanelMeeting.create({
    projectId,
    projectName,
    title: String(title).trim(),
    description,
    scheduledAt: new Date(scheduledAt),
    durationMinutes,
    ...normalizeMode(data ?? {}),
    participants: normalizeParticipants(participants),
    rescheduledFromMeetingId,
    status: MEETING_STATUS.PLANNED,
    createdBy: actor.email ?? null,
    updatedBy: actor.email ?? null,
  });
}

async function loadOrThrow(meetingId) {
  const meeting = await PanelMeeting.findById(meetingId);
  if (!meeting) throw ApiError.notFound('PANEL_MEETING_NOT_FOUND', 'Réunion introuvable.');
  return meeting;
}

/**
 * MODIFIER une réunion — passée comme future, quel que soit son statut.
 *
 * Une erreur de saisie se corrige. Ce qui protège l'histoire n'est pas
 * l'interdiction mais la trace : chaque champ touché est consigné avec son
 * avant et son après.
 */
export async function updateMeeting(meetingId, data = {}, actor = {}) {
  refuseLegacyParticipants(data);
  const meeting = await loadOrThrow(meetingId);
  const patch = {};

  if (data.title !== undefined) {
    const title = String(data.title).trim();
    if (!title) throw ApiError.badRequest('PANEL_MEETING_TITLE_REQUIRED', 'Un intitulé est requis.');
    patch.title = title;
  }
  if (data.description !== undefined) patch.description = data.description;
  if (data.scheduledAt !== undefined) {
    if (Number.isNaN(new Date(data.scheduledAt).getTime())) {
      throw ApiError.badRequest('PANEL_MEETING_DATE_REQUIRED', 'Date invalide.');
    }
    patch.scheduledAt = new Date(data.scheduledAt);
  }
  if (data.durationMinutes !== undefined) patch.durationMinutes = Number(data.durationMinutes);
  // La liste entière est remplacée : ajouter, corriger et retirer un
  // participant sont trois formes du même geste côté écran, et un correctif
  // partiel demanderait de rejouer des opérations dans l'ordre.
  if (data.participants !== undefined) patch.participants = normalizeParticipants(data.participants);

  // Le mode se corrige d'un bloc : changer d'avis sur le lieu doit effacer ce
  // qui n'a plus de sens, pas empiler deux réponses contradictoires.
  if (data.mode !== undefined) Object.assign(patch, normalizeMode({ ...meeting.toObject(), ...data }));

  const modifies = applyPatch(meeting, patch, { actor, reason: data.reason ?? null });
  await meeting.save();
  return { meeting, modifies };
}

export async function cancelMeeting(meetingId, { reason = null } = {}, actor = {}) {
  const meeting = await loadOrThrow(meetingId);
  transition(meeting, MEETING_STATUS.CANCELLED);
  meeting.cancelledAt = new Date();
  meeting.cancelReason = reason;
  meeting.updatedBy = actor.email ?? null;
  await meeting.save();

  // Une réunion annulée n'a plus rien à confirmer : l'attente disparaît.
  await PanelProjectEvent.deleteOne({
    sourceMeetingId: String(meeting._id),
    status: EVENT_STATUS.PENDING_CONFIRMATION,
  });
  return meeting;
}

/**
 * REPORT — l'ancienne réunion est close, une nouvelle naît, les deux se citent.
 *
 * L'événement de confirmation éventuellement créé à l'échéance est SUPPRIMÉ.
 * Un événement consigne ce qui s'est passé ; une réunion reportée n'a rien
 * produit à consigner. Le laisser aurait fabriqué un doublon dans l'historique
 * — et une question à laquelle personne ne peut répondre. La trace du report
 * vit dans les deux réunions, qui se pointent l'une l'autre.
 */
export async function rescheduleMeeting(meetingId, { scheduledAt, reason = null }, actor = {}) {
  if (!scheduledAt || Number.isNaN(new Date(scheduledAt).getTime())) {
    throw ApiError.badRequest('PANEL_MEETING_DATE_REQUIRED', 'Une nouvelle date est requise.');
  }
  const ancienne = await loadOrThrow(meetingId);

  const nouvelle = await createMeeting({
    projectId: ancienne.projectId,
    projectName: ancienne.projectName,
    title: ancienne.title,
    description: ancienne.description,
    scheduledAt,
    durationMinutes: ancienne.durationMinutes,
    mode: ancienne.mode,
    address: ancienne.address,
    addressComplement: ancienne.addressComplement,
    accessNotes: ancienne.accessNotes,
    remoteKind: ancienne.remoteKind,
    phone: ancienne.phone,
    meetingUrl: ancienne.meetingUrl,
    // Les mêmes personnes, avec les mêmes identifiants : reporter ne rebat pas
    // les cartes, c'est le même rendez-vous un autre jour.
    participants: ancienne.toObject().participants,
    rescheduledFromMeetingId: String(ancienne._id),
  }, actor);

  transition(ancienne, MEETING_STATUS.RESCHEDULED);
  ancienne.rescheduledToMeetingId = String(nouvelle._id);
  ancienne.cancelReason = reason;
  ancienne.updatedBy = actor.email ?? null;
  await ancienne.save();

  await PanelProjectEvent.deleteOne({
    sourceMeetingId: String(ancienne._id),
    status: EVENT_STATUS.PENDING_CONFIRMATION,
  });

  return { previous: ancienne, next: nouvelle };
}

/* ── Échéances ────────────────────────────────────────────────────────────── */

/**
 * Toute réunion dont l'heure est venue passe « à confirmer » et engendre son
 * événement en attente.
 *
 * IDEMPOTENT deux fois plutôt qu'une : le filtre exige `PLANNED` — un second
 * passage ne trouve plus rien — et l'index unique sur `sourceMeetingId` refuse
 * un second événement même si deux cycles se croisaient.
 */
export async function convertDueMeetings(now = new Date()) {
  const echues = await PanelMeeting.find({
    status: MEETING_STATUS.PLANNED,
    scheduledAt: { $lte: now },
  });

  let crees = 0;
  for (const meeting of echues) {
    meeting.status = MEETING_STATUS.DONE_PENDING_CONFIRMATION;
    // eslint-disable-next-line no-await-in-loop
    await meeting.save();

    try {
      // eslint-disable-next-line no-await-in-loop
      await PanelProjectEvent.create({
        projectId: meeting.projectId,
        projectName: meeting.projectName,
        sourceMeetingId: String(meeting._id),
        type: 'MEETING_OCCURRED',
        title: meeting.title,
        occurredAt: meeting.scheduledAt,
        status: EVENT_STATUS.PENDING_CONFIRMATION,
        // Les personnes attendues deviennent les personnes présumées présentes.
        // La confirmation permettra de corriger la liste, une par une.
        participants: meeting.toObject().participants,
        createdBy: null, // la conversion n'a pas d'auteur humain
      });
      crees += 1;
    } catch (err) {
      // 11000 : la confirmation existe déjà. C'est le résultat voulu.
      if (err?.code !== 11000) throw err;
    }
  }

  if (echues.length > 0) {
    logger.info(`${echues.length} réunion(s) passée(s) « à confirmer » (${crees} nouvelle(s)).`);
  }
  return { meetings: echues.length, events: crees };
}

/* ── Lectures ─────────────────────────────────────────────────────────────── */

export async function listMeetings({ projectId = null, scope = 'upcoming', limit = 100 } = {}) {
  const maintenant = new Date();
  const filtre = projectId ? { projectId } : {};

  if (scope === 'upcoming') {
    filtre.status = MEETING_STATUS.PLANNED;
    filtre.scheduledAt = { $gte: maintenant };
  } else if (scope === 'today') {
    const debut = new Date(maintenant); debut.setHours(0, 0, 0, 0);
    const fin = new Date(maintenant); fin.setHours(23, 59, 59, 999);
    filtre.scheduledAt = { $gte: debut, $lte: fin };
  } else if (scope === 'to_confirm') {
    filtre.status = MEETING_STATUS.DONE_PENDING_CONFIRMATION;
  } else if (scope === 'past') {
    filtre.scheduledAt = { $lt: maintenant };
  }

  const tri = scope === 'past' ? { scheduledAt: -1 } : { scheduledAt: 1 };
  return PanelMeeting.find(filtre).sort(tri).limit(limit).lean();
}

export default {
  createMeeting,
  updateMeeting,
  normalizeMode,
  cancelMeeting,
  rescheduleMeeting,
  convertDueMeetings,
  listMeetings,
};
