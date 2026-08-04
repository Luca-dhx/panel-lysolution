/**
 * RÉUNIONS ET ÉVÉNEMENTS — deux objets, deux natures.
 *
 * Ce que ces contrôles verrouillent : qu'une réunion échue devienne « à
 * confirmer » sans jamais être déclarée tenue, qu'elle n'engendre QU'UN seul
 * événement en attente, qu'un report ne laisse aucun doublon, qu'un projet ne
 * voie jamais l'historique d'un autre — et qu'aucun pont ne soit appelé.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  check,
  connectTestDatabase,
  finish,
  section,
  setTestEnv,
  startMemoryMongo,
  startServer,
  stopMemoryMongo,
} from './helpers/harness.js';

setTestEnv();
await startMemoryMongo();
await connectTestDatabase();

const { createApp } = await import('../backend/src/app.js');
const { seedFromEnv } = await import('../backend/src/services/auth/panelUsers.service.js');
const { PanelMeeting } = await import('../backend/src/models/PanelMeeting.model.js');
const { PanelProjectEvent } = await import('../backend/src/models/PanelProjectEvent.model.js');
const meetings = await import('../backend/src/services/events/meetings.service.js');
const events = await import('../backend/src/services/events/events.service.js');
const scheduler = await import('../backend/src/services/events/eventScheduler.js');
const { migrateLegacyEvents, migrateParticipants } = await import('../backend/src/services/events/eventsMigration.js');

await seedFromEnv();
await PanelProjectEvent.init(); // l'index unique doit exister AVANT les tests
const { call, close } = await startServer(createApp());

const login = await call('POST', '/api/auth/login', {
  body: { email: 'dev@panel.test', password: 'motdepasse-test' },
});
const AUTH = { authorization: `Bearer ${login.json.data.token}` };

const dans = (minutes) => new Date(Date.now() + minutes * 60_000).toISOString();
const P1 = 'projet-un';
const P2 = 'projet-deux';

/* ────────────────────────────────────────────────────────────────────────── */
section('1. Une réunion se PLANIFIE — objet d’agenda');
{
  const res = await call('POST', '/api/meetings', {
    headers: AUTH,
    body: {
      projectId: P1, projectName: 'SB Auto 07', title: 'Point mensuel',
      description: 'Ordre du jour : contrat, roadmap',
      scheduledAt: dans(60), durationMinutes: 45,
      mode: 'REMOTE', remoteKind: 'VIDEO', meetingUrl: 'https://visio.exemple.fr/point',
      participants: [{ type: 'EXTERNAL', name: 'Client', email: 'client@atelier.test' }],
    },
  });
  check('la réunion est créée', res.status === 201);
  check('…en PLANNED', res.json.data.meeting.status === 'PLANNED');
  check('…avec son ordre du jour', res.json.data.meeting.description.includes('roadmap'));
  check('…en distanciel, par visioconférence',
    res.json.data.meeting.mode === 'REMOTE' && res.json.data.meeting.remoteKind === 'VIDEO');
  check('…avec son lien', res.json.data.meeting.meetingUrl === 'https://visio.exemple.fr/point');
  check('aucun événement n’est créé à la planification',
    (await PanelProjectEvent.countDocuments({ projectId: P1 })) === 0);

  const sansDate = await call('POST', '/api/meetings', {
    headers: AUTH, body: { projectId: P1, title: 'Sans date' },
  });
  check('une réunion sans date est refusée', sansDate.status === 400);
  const sansJwt = await call('POST', '/api/meetings', { body: { projectId: P1 } });
  check('…et sans authentification', sansJwt.status === 401);
}

section('2. À l’échéance : « à confirmer », JAMAIS « tenue »');
{
  await PanelMeeting.deleteMany({});
  await PanelProjectEvent.deleteMany({});
  const echue = await meetings.createMeeting({
    projectId: P1, projectName: 'SB Auto 07', title: 'Réunion d’hier', scheduledAt: dans(-30),
    mode: 'ONSITE', address: '12 rue des Garages',
  }, { email: 'dev@panel.test' });
  const future = await meetings.createMeeting({
    projectId: P1, title: 'Réunion de demain', scheduledAt: dans(600),
    mode: 'ONSITE', address: '12 rue des Garages',
  }, { email: 'dev@panel.test' });

  const res = await meetings.convertDueMeetings();
  check('une réunion est convertie', res.meetings === 1);
  check('…et UN seul événement est créé', res.events === 1);

  const apres = await PanelMeeting.findById(echue._id).lean();
  check('la réunion passe DONE_PENDING_CONFIRMATION', apres.status === 'DONE_PENDING_CONFIRMATION');
  check('LE POINT CENTRAL : elle n’est PAS déclarée tenue', apres.status !== 'CONFIRMED');
  check('la réunion future ne bouge pas',
    (await PanelMeeting.findById(future._id).lean()).status === 'PLANNED');

  const evt = await PanelProjectEvent.findOne({ sourceMeetingId: String(echue._id) }).lean();
  check('l’événement lié est EN ATTENTE', evt.status === 'PENDING_CONFIRMATION');
  check('…de type MEETING_OCCURRED', evt.type === 'MEETING_OCCURRED');
  check('…rattaché à sa réunion', evt.sourceMeetingId === String(echue._id));
  check('…et daté de l’heure prévue',
    new Date(evt.occurredAt).getTime() === new Date(apres.scheduledAt).getTime());
}

section('3. Conversion IDEMPOTENTE — aucun doublon possible');
{
  const avant = await PanelProjectEvent.countDocuments({});
  check('un second passage ne convertit rien', (await meetings.convertDueMeetings()).meetings === 0);
  check('…et ne crée aucun événement', (await PanelProjectEvent.countDocuments({})) === avant);

  const [a, b] = await Promise.all([scheduler.runEventCycle(), scheduler.runEventCycle()]);
  check('deux cycles simultanés ne se marchent pas dessus',
    a.skipped === true || b.skipped === true || (a.meetings === 0 && b.meetings === 0));
  check('…et le compte d’événements est inchangé',
    (await PanelProjectEvent.countDocuments({})) === avant);

  check('le minuteur démarre', scheduler.startEventScheduler({ intervalMs: 60_000 }) !== null);
  check('l’arrêt est propre', scheduler.stopEventScheduler() === true);
  check('…et un second arrêt ne fait rien', scheduler.stopEventScheduler() === false);
}

section('4. « Oui, elle a eu lieu »');
{
  const evt = await PanelProjectEvent.findOne({ status: 'PENDING_CONFIRMATION' }).lean();
  const res = await call('POST', `/api/events/${evt._id}/confirm`, {
    headers: AUTH,
    body: {
      notes: 'Tour d’horizon du trimestre',
      outcome: 'Client satisfait',
      nextActions: ['Envoyer le devis'],
      participants: [{ type: 'EXTERNAL', name: 'Client', email: 'client@atelier.test' }],
      occurredAt: dans(-25),
    },
  });
  check('l’événement est confirmé', res.json.data.event.status === 'CONFIRMED');
  check('…de type MEETING_OCCURRED', res.json.data.event.type === 'MEETING_OCCURRED');
  check('…avec son compte rendu', res.json.data.event.notes.includes('trimestre'));
  check('…l’heure RÉELLE, différente de l’heure prévue',
    new Date(res.json.data.event.occurredAt).getTime() !== new Date(evt.occurredAt).getTime());
  check('…et l’auteur de la confirmation',
    res.json.data.event.confirmedBy === 'dev@panel.test');

  const rejeu = await call('POST', `/api/events/${evt._id}/confirm`, { headers: AUTH, body: {} });
  check('un événement classé ne se reclasse pas', rejeu.status === 409);
}

section('5. « Non » — le motif décide de MISSED ou CANCELLED');
{
  const preparer = async (titre) => {
    const m = await meetings.createMeeting(
      { projectId: P1, title: titre, scheduledAt: dans(-10), mode: 'ONSITE', address: 'Sur place' }, { email: 'dev@panel.test' },
    );
    await meetings.convertDueMeetings();
    return PanelProjectEvent.findOne({ sourceMeetingId: String(m._id) }).lean();
  };

  const absent = await preparer('Client absent');
  const r1 = await call('POST', `/api/events/${absent._id}/miss`, {
    headers: AUTH, body: { reason: 'CLIENT_ABSENT', notes: 'Personne sur place' },
  });
  check('client absent → MISSED', r1.json.data.event.status === 'MISSED');
  check('…avec son motif', r1.json.data.event.missedReason === 'CLIENT_ABSENT');

  const equipe = await preparer('Équipe absente');
  const r2 = await call('POST', `/api/events/${equipe._id}/miss`, {
    headers: AUTH, body: { reason: 'TEAM_ABSENT' },
  });
  check('équipe absente → MISSED', r2.json.data.event.status === 'MISSED');

  const annulee = await preparer('Annulée la veille');
  const r3 = await call('POST', `/api/events/${annulee._id}/miss`, {
    headers: AUTH, body: { reason: 'CANCELLED' },
  });
  check('annulée → CANCELLED, pas MISSED', r3.json.data.event.status === 'CANCELLED');

  const inconnu = await preparer('Motif inconnu');
  const r4 = await call('POST', `/api/events/${inconnu._id}/miss`, {
    headers: AUTH, body: { reason: 'PARCE_QUE' },
  });
  check('un motif hors liste est refusé', r4.status === 400);
}

section('6. Reporter : deux réunions liées, AUCUN doublon');
{
  await PanelMeeting.deleteMany({});
  await PanelProjectEvent.deleteMany({});
  const initiale = await meetings.createMeeting({
    projectId: P1, projectName: 'SB Auto 07', title: 'Revue de contrat',
    scheduledAt: dans(-5),
    participants: [{ type: 'EXTERNAL', name: 'Client', email: 'client@atelier.test' }],
    mode: 'ONSITE', address: '12 rue des Garages',
  }, { email: 'dev@panel.test' });
  await meetings.convertDueMeetings();
  check('une confirmation est en attente',
    (await PanelProjectEvent.countDocuments({ status: 'PENDING_CONFIRMATION' })) === 1);

  const res = await call('POST', `/api/meetings/${initiale._id}/reschedule`, {
    headers: AUTH, body: { scheduledAt: dans(2880), reason: 'Client indisponible' },
  });
  check('le report réussit', res.status === 200);
  const { previous, next } = res.json.data;
  check('l’ancienne réunion est RESCHEDULED', previous.status === 'RESCHEDULED');
  check('…et pointe vers la nouvelle', previous.rescheduledToMeetingId === next._id);
  check('la nouvelle est PLANNED', next.status === 'PLANNED');
  check('…et pointe vers l’ancienne', next.rescheduledFromMeetingId === previous._id);
  check('…en gardant intitulé et participants',
    next.title === 'Revue de contrat' && next.participants.length === 1);
  check('…avec le MÊME identifiant de participant qu’avant le report',
    next.participants[0].id === previous.participants[0].id);

  check('AUCUNE confirmation orpheline ne subsiste',
    (await PanelProjectEvent.countDocuments({ status: 'PENDING_CONFIRMATION' })) === 0);
  check('…et aucun doublon dans l’historique',
    (await PanelProjectEvent.countDocuments({})) === 0);
}

section('7. Annuler une réunion');
{
  await PanelMeeting.deleteMany({});
  await PanelProjectEvent.deleteMany({});
  const m = await meetings.createMeeting(
    { projectId: P1, title: 'À annuler', scheduledAt: dans(120), mode: 'ONSITE', address: 'Sur place' }, { email: 'dev@panel.test' },
  );
  const res = await call('POST', `/api/meetings/${m._id}/cancel`, {
    headers: AUTH, body: { reason: 'Plus d’objet' },
  });
  check('la réunion est annulée', res.json.data.meeting.status === 'CANCELLED');
  check('…avec son motif', res.json.data.meeting.cancelReason === 'Plus d’objet');
  check('…et aucun événement n’en découle',
    (await PanelProjectEvent.countDocuments({})) === 0);

  const rejeu = await call('POST', `/api/meetings/${m._id}/cancel`, { headers: AUTH, body: {} });
  check('une réunion annulée ne se réannule pas', rejeu.status === 409);
}

section('8. Présentiel / distanciel : validation et NETTOYAGE');
{
  await PanelMeeting.deleteMany({});

  const sansAdresse = await call('POST', '/api/meetings', {
    headers: AUTH,
    body: { projectId: P1, title: 'Sans adresse', scheduledAt: dans(60), mode: 'ONSITE' },
  });
  check('présentiel sans adresse : refusé', sansAdresse.status === 400);

  const sansKind = await call('POST', '/api/meetings', {
    headers: AUTH,
    body: { projectId: P1, title: 'Distanciel flou', scheduledAt: dans(60), mode: 'REMOTE' },
  });
  check('distanciel sans préciser appel ou visio : refusé', sansKind.status === 400);

  const sansNumero = await call('POST', '/api/meetings', {
    headers: AUTH,
    body: {
      projectId: P1, title: 'Appel', scheduledAt: dans(60),
      mode: 'REMOTE', remoteKind: 'CALL', phone: '  ',
    },
  });
  check('appel sans numéro : refusé', sansNumero.status === 400);

  const urlNue = await call('POST', '/api/meetings', {
    headers: AUTH,
    body: {
      projectId: P1, title: 'Visio', scheduledAt: dans(60),
      mode: 'REMOTE', remoteKind: 'VIDEO', meetingUrl: 'visio.exemple.fr',
    },
  });
  check('visio avec une URL invalide : refusée', urlNue.status === 400);

  const enClair = await call('POST', '/api/meetings', {
    headers: AUTH,
    body: {
      projectId: P1, title: 'Visio', scheduledAt: dans(60),
      mode: 'REMOTE', remoteKind: 'VIDEO', meetingUrl: 'http://visio.exemple.fr/x',
    },
  });
  check('visio en http non chiffré : refusée', enClair.status === 400);

  const presentiel = await call('POST', '/api/meetings', {
    headers: AUTH,
    body: {
      projectId: P1, title: 'Chez le client', scheduledAt: dans(120),
      mode: 'ONSITE', address: '12 rue des Garages', addressComplement: 'Batiment B',
      accessNotes: 'Sonner a l atelier',
    },
  });
  check('présentiel complet accepté', presentiel.status === 201);
  check('…avec son complément et ses indications',
    presentiel.json.data.meeting.addressComplement === 'Batiment B'
    && presentiel.json.data.meeting.accessNotes === 'Sonner a l atelier');

  const id = presentiel.json.data.meeting._id;
  const versVisio = await call('PUT', `/api/meetings/${id}`, {
    headers: AUTH,
    body: { mode: 'REMOTE', remoteKind: 'VIDEO', meetingUrl: 'https://visio.exemple.fr/abc' },
  });
  check('bascule vers la visioconférence', versVisio.json.data.meeting.remoteKind === 'VIDEO');
  check('…l’adresse est EFFACÉE', versVisio.json.data.meeting.address === '');
  check('…le complément aussi', versVisio.json.data.meeting.addressComplement === '');
  check('…et les indications d’accès également', versVisio.json.data.meeting.accessNotes === '');

  const versAppel = await call('PUT', `/api/meetings/${id}`, {
    headers: AUTH,
    body: { mode: 'REMOTE', remoteKind: 'CALL', phone: '0102030405' },
  });
  check('bascule visio → appel', versAppel.json.data.meeting.remoteKind === 'CALL');
  check('…l’URL de visio est EFFACÉE', versAppel.json.data.meeting.meetingUrl === '');
  check('…et le numéro est conservé', versAppel.json.data.meeting.phone === '0102030405');

  const retour = await call('PUT', `/api/meetings/${id}`, {
    headers: AUTH, body: { mode: 'ONSITE', address: '3 place du Marché' },
  });
  check('retour au présentiel', retour.json.data.meeting.mode === 'ONSITE');
  check('…le téléphone est EFFACÉ', retour.json.data.meeting.phone === '');
  check('…et l’URL aussi', retour.json.data.meeting.meetingUrl === '');
}

section('9. Tout reste MODIFIABLE, et tout est tracé');
{
  await PanelMeeting.deleteMany({});
  await PanelProjectEvent.deleteMany({});

  const future = await meetings.createMeeting(
    { projectId: P1, title: 'Point futur', scheduledAt: dans(600), mode: 'ONSITE', address: 'A' },
    { email: 'dev@panel.test' },
  );
  const r1 = await call('PUT', `/api/meetings/${future._id}`, {
    headers: AUTH, body: { title: 'Point futur corrigé', reason: 'Erreur de frappe' },
  });
  check('une réunion future est modifiable', r1.json.data.meeting.title === 'Point futur corrigé');
  const rev1 = r1.json.data.meeting.revisions.at(-1);
  check('…avec son auteur', rev1.actorEmail === 'dev@panel.test');
  check('…son motif', rev1.reason === 'Erreur de frappe');
  check('…l’ancienne et la nouvelle valeur',
    rev1.changes[0].field === 'title' && rev1.changes[0].from === 'Point futur'
    && rev1.changes[0].to === 'Point futur corrigé');

  const passee = await meetings.createMeeting(
    { projectId: P1, title: 'Point passé', scheduledAt: dans(-60), mode: 'ONSITE', address: 'A' },
    { email: 'dev@panel.test' },
  );
  await meetings.convertDueMeetings();
  const r2 = await call('PUT', `/api/meetings/${passee._id}`, {
    headers: AUTH, body: { durationMinutes: 90 },
  });
  check('une réunion PASSÉE reste modifiable', r2.json.data.meeting.durationMinutes === 90);

  const evt = await PanelProjectEvent.findOne({ sourceMeetingId: String(passee._id) }).lean();
  await call('POST', `/api/events/${evt._id}/confirm`, { headers: AUTH, body: { notes: 'RAS' } });

  const r3 = await call('PUT', `/api/events/${evt._id}`, {
    headers: AUTH, body: { notes: 'Compte rendu complété', reason: 'Oubli' },
  });
  check('un événement CONFIRMÉ reste modifiable',
    r3.json.data.event.notes === 'Compte rendu complété');
  check('…et l’historique s’allonge au lieu de se réécrire',
    r3.json.data.event.revisions.length === 1
    && r3.json.data.event.revisions[0].changes[0].from === 'RAS');

  const r4 = await call('PUT', `/api/events/${evt._id}`, {
    headers: AUTH,
    body: { status: 'MISSED', missedReason: 'CLIENT_ABSENT', reason: 'Info du lendemain' },
  });
  check('un événement confirmé peut être RECLASSÉ', r4.json.data.event.status === 'MISSED');
  check('…et la correction est tracée',
    r4.json.data.event.revisions.at(-1).changes.some((c) => c.field === 'status'));
  check('…sans perdre les corrections précédentes', r4.json.data.event.revisions.length === 2);
}

section('9 bis. « Me le rappeler plus tard » n’existe plus');
{
  const evt = await PanelProjectEvent.findOne({}).lean();
  const snooze = await call('POST', `/api/events/${evt._id}/snooze`, { headers: AUTH });
  check('la route de rappel différé a disparu', snooze.status === 404);
}

section('10. Saisir un événement PASSÉ à la main');
{
  const res = await call('POST', '/api/events', {
    headers: AUTH,
    body: {
      projectId: P1, projectName: 'SB Auto 07', type: 'CALL',
      title: 'Appel de suivi', occurredAt: dans(-120),
      notes: 'Point rapide', outcome: 'RAS',
    },
  });
  check('l’événement passé est créé', res.status === 201);
  check('…directement CONFIRMÉ — celui qui saisit constate',
    res.json.data.event.status === 'CONFIRMED');
  check('…sans réunion source', res.json.data.event.sourceMeetingId === null);
  check('…et avec son auteur', res.json.data.event.confirmedBy === 'dev@panel.test');

  const reserve = await call('POST', '/api/events', {
    headers: AUTH,
    body: { projectId: P1, type: 'MEETING_OCCURRED', title: 'Fausse réunion', occurredAt: dans(-60) },
  });
  check('on ne fabrique pas une réunion tenue à la main', reserve.status === 400);
}

section('11. Un projet ne voit JAMAIS l’historique d’un autre');
{
  await PanelProjectEvent.deleteMany({});
  await events.createPastEvent(
    { projectId: P1, type: 'CALL', title: 'Appel projet UN', occurredAt: dans(-60) }, {},
  );
  await events.createPastEvent(
    { projectId: P2, type: 'MEAL', title: 'Déjeuner projet DEUX', occurredAt: dans(-60) }, {},
  );

  const un = await call('GET', `/api/events?projectId=${P1}`, { headers: AUTH });
  check('la fiche du projet UN ne montre que ses événements',
    un.json.data.events.length === 1 && un.json.data.events[0].projectId === P1);

  const resume = await call('GET', `/api/events/project/${P2}`, { headers: AUTH });
  check('le résumé du projet DEUX ne montre que les siens',
    resume.json.data.history.every((e) => e.projectId === P2));
  check('…et il y en a bien un', resume.json.data.history.length === 1);

  const sansProjet = await call('GET', '/api/events', { headers: AUTH });
  check('sans projet, la lecture est REFUSÉE plutôt que globale',
    sansProjet.status === 400 && sansProjet.json.code === 'PANEL_EVENT_PROJECT_REQUIRED');

  const global = await call('GET', '/api/events?scope=all', { headers: AUTH });
  check('la vue globale existe, mais se demande explicitement',
    global.status === 200 && global.json.data.events.length === 2);

  const filtre = await call('GET', `/api/events?projectId=${P1}&type=CALL`, { headers: AUTH });
  check('le filtre par type fonctionne', filtre.json.data.events.length === 1);
  const vide = await call('GET', `/api/events?projectId=${P1}&type=MEAL`, { headers: AUTH });
  check('…et ne ramène rien quand rien ne correspond', vide.json.data.events.length === 0);
}

section('12. Migration de l’ancien modèle — rien n’est perdu');
{
  await PanelMeeting.deleteMany({});
  await PanelProjectEvent.deleteMany({});

  // Anciens documents, écrits en BRUT : ils ne passeraient plus le schéma.
  await PanelProjectEvent.collection.insertMany([
    {
      projectId: P1, projectName: 'SB Auto 07', type: 'MEETING', status: 'PLANNED',
      title: 'Réunion à venir', scheduledAt: new Date(Date.now() + 3600_000),
      durationMinutes: 30, externalParticipants: ['client@atelier.test'], createdAt: new Date(),
    },
    {
      projectId: P1, type: 'MEETING', status: 'DUE',
      title: 'Réunion échue', scheduledAt: new Date(Date.now() - 3600_000), createdAt: new Date(),
    },
    {
      projectId: P1, type: 'MEETING', status: 'COMPLETED',
      title: 'Réunion tenue', scheduledAt: new Date(Date.now() - 86400_000),
      notes: 'Compte rendu conservé', outcome: 'Accord', nextActions: ['Relancer'],
      completedAt: new Date(), createdAt: new Date(),
    },
    {
      projectId: P2, type: 'CALL', status: 'COMPLETED',
      title: 'Appel ancien', scheduledAt: new Date(Date.now() - 7200_000),
      notes: 'Bref', createdAt: new Date(),
    },
  ]);

  const res = await migrateLegacyEvents();
  check('les quatre enregistrements sont repris', res.examined === 4);
  check('…deux deviennent des réunions', res.meetings === 2);

  const aVenir = await PanelMeeting.findOne({ title: 'Réunion à venir' }).lean();
  check('la réunion future redevient une RÉUNION PLANNED', aVenir?.status === 'PLANNED');
  check('…en gardant ses participants, désormais structurés',
    aVenir.participants.length === 1 && aVenir.participants[0].email === 'client@atelier.test');

  const echue = await PanelMeeting.findOne({ title: 'Réunion échue' }).lean();
  check('la réunion échue redevient DONE_PENDING_CONFIRMATION',
    echue?.status === 'DONE_PENDING_CONFIRMATION');
  const attente = await PanelProjectEvent.findOne({ sourceMeetingId: String(echue._id) }).lean();
  check('…et retrouve sa confirmation en attente',
    attente?.status === 'PENDING_CONFIRMATION' && attente.type === 'MEETING_OCCURRED');

  const tenue = await PanelProjectEvent.findOne({ title: 'Réunion tenue' }).lean();
  check('la réunion tenue devient un ÉVÉNEMENT MEETING_OCCURRED',
    tenue?.type === 'MEETING_OCCURRED' && tenue.status === 'CONFIRMED');
  check('…avec son compte rendu INTACT', tenue.notes === 'Compte rendu conservé');
  check('…son résultat', tenue.outcome === 'Accord');
  check('…et ses prochaines actions', tenue.nextActions.length === 1);

  const appel = await PanelProjectEvent.findOne({ title: 'Appel ancien' }).lean();
  check('un ancien appel garde son type', appel?.type === 'CALL' && appel.status === 'CONFIRMED');
  check('…et son projet', appel.projectId === P2);

  check('AUCUN ancien statut ne subsiste',
    (await PanelProjectEvent.countDocuments({ status: { $in: ['PLANNED', 'DUE', 'COMPLETED'] } })) === 0);
  check('plus aucun type MEETING dans les événements',
    (await PanelProjectEvent.countDocuments({ type: 'MEETING' })) === 0);

  const rejeu = await migrateLegacyEvents();
  check('relancer la migration ne fait rien', rejeu.examined === 0);
}

section('13. AUCUN pont n’est appelé — jamais');
{
  const racine = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const lire = (rel) => fs.readFileSync(path.join(racine, rel), 'utf8');
  const sources = [
    'backend/src/services/events/events.service.js',
    'backend/src/services/events/meetings.service.js',
    'backend/src/services/events/eventScheduler.js',
    'backend/src/services/events/eventsMigration.js',
    'backend/src/services/events/participants.js',
    'backend/src/controllers/events.controller.js',
    'backend/src/models/PanelProjectEvent.model.js',
    'backend/src/models/PanelMeeting.model.js',
  ].map(lire).join('\n');

  check('aucun client de pont importé', !/ProjectBridgeClient/.test(sources));
  check('aucune projection métier touchée',
    !/PanelProjectContract|PanelProjectPresentation|PanelProjectMember/.test(sources));
  check('aucune mise en file de synchronisation', !/outbox|emitChange|sync\/push/i.test(sources));
  check('aucune notion d’entité de contrat', !/entityType|writeId/.test(sources));
}

section('14. Les écrans séparent l’agenda de l’histoire');
{
  const racine = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const lire = (rel) => fs.readFileSync(path.join(racine, rel), 'utf8');

  const nav = lire('frontend/src/config/nav.ts');
  check('« Agenda et événements » est en Gestion',
    /to: '\/agenda'[\s\S]{0,80}section: 'GESTION'/.test(nav));

  const agenda = lire('frontend/src/pages/AgendaPage.tsx');
  check('l’agenda a une section « Réunions à venir »', agenda.includes('Réunions à venir'));
  check('…une section « Réunions à confirmer »', agenda.includes('Réunions à confirmer'));
  check('…et une section « Événements récents »', agenda.includes('Événements récents'));

  const fiche = lire('frontend/src/pages/ProjectDetailPage.tsx');
  check('la fiche projet a un onglet Événements',
    /'events'/.test(fiche) && fiche.includes('Événements'));
  check('…qui lit les événements DU projet courant',
    /useProjectEvents\(project\.projectId\)|useProjectEvents\(projectId\)/.test(fiche));
  check('…avec un bouton pour planifier une réunion', fiche.includes('Planifier une réunion'));
  check('…et un bouton pour ajouter un événement passé', fiche.includes('Ajouter un événement passé'));

  const front = [agenda, fiche].join(' ');
  check('aucun sondage visible', !/setInterval|setTimeout/.test(front));
  check('aucun WebSocket maison', !/WebSocket|EventSource/.test(front));
}

/* ────────────────────────────────────────────────────────────────────────── */
section('15. Participants : une LISTE d’items, jamais une chaîne');
{
  await PanelMeeting.deleteMany({});
  await PanelProjectEvent.deleteMany({});

  // ── Ajouter plusieurs participants ──────────────────────────────────────
  const cree = await call('POST', '/api/meetings', {
    headers: AUTH,
    body: {
      projectId: P1, title: 'Point d’équipe', scheduledAt: dans(60),
      mode: 'ONSITE', address: '3 place du Marché',
      participants: [
        { type: 'INTERNAL', name: 'Chef de projet', email: 'CHEF@panel.test' },
        { type: 'EXTERNAL', name: 'Client', phone: '06 12 34 56 78' },
        { type: 'EXTERNAL', name: 'Comptable', email: 'compta@atelier.test' },
      ],
    },
  });
  check('trois participants sont enregistrés', cree.json.data.meeting.participants.length === 3);
  const trio = cree.json.data.meeting.participants;
  check('…chacun avec un identifiant PROPRE',
    new Set(trio.map((p) => p.id)).size === 3 && trio.every((p) => typeof p.id === 'string' && p.id));
  check('…son type', trio[0].type === 'INTERNAL' && trio[1].type === 'EXTERNAL');
  check('…son nom, son courriel, son téléphone',
    trio[0].email === 'chef@panel.test' && trio[1].phone === '06 12 34 56 78');
  check('les anciens champs n’existent plus sur l’objet rendu',
    cree.json.data.meeting.externalParticipants === undefined
    && cree.json.data.meeting.internalParticipants === undefined);

  const meetingId = cree.json.data.meeting._id;

  // ── Supprimer UN SEUL participant ───────────────────────────────────────
  const restants = trio.filter((p) => p.id !== trio[1].id);
  const apresRetrait = await call('PUT', `/api/meetings/${meetingId}`, {
    headers: AUTH, body: { participants: restants },
  });
  const apres = apresRetrait.json.data.meeting.participants;
  check('un participant se retire seul', apres.length === 2);
  check('…et les autres gardent leur identité',
    apres.map((p) => p.id).join('|') === restants.map((p) => p.id).join('|'));
  check('…le retrait est tracé comme toute correction',
    apresRetrait.json.data.meeting.revisions.at(-1).changes.some((c) => c.field === 'participants'));

  // ── Modifier un participant, sans toucher aux autres ────────────────────
  const modifie = apres.map((p) => (p.id === apres[1].id ? { ...p, name: 'Comptable en chef' } : p));
  const apresEdition = await call('PUT', `/api/meetings/${meetingId}`, {
    headers: AUTH, body: { participants: modifie },
  });
  const edites = apresEdition.json.data.meeting.participants;
  check('un participant se modifie individuellement', edites[1].name === 'Comptable en chef');
  check('…en gardant son identifiant', edites[1].id === apres[1].id);
  check('…sans altérer son voisin', edites[0].name === apres[0].name);

  // ── Persistance et relecture ────────────────────────────────────────────
  const relu = await call('GET', `/api/meetings?scope=upcoming&projectId=${P1}`, { headers: AUTH });
  const enBase = relu.json.data.meetings.find((m) => m._id === meetingId);
  check('la liste relue est identique à celle enregistrée',
    JSON.stringify(enBase.participants) === JSON.stringify(edites));
  check('…et rien n’est stocké en clair dans un champ texte',
    (await PanelMeeting.findById(meetingId).lean()).participants.every(
      (p) => typeof p === 'object' && typeof p.name === 'string'),
  );

  // ── Aucun item vide persisté ────────────────────────────────────────────
  const avecVides = await call('PUT', `/api/meetings/${meetingId}`, {
    headers: AUTH,
    body: {
      participants: [
        ...edites,
        { type: 'EXTERNAL', name: '   ', email: '', phone: '' },
        { type: 'EXTERNAL' },
      ],
    },
  });
  check('une ligne vide n’est JAMAIS persistée',
    avecVides.json.data.meeting.participants.length === 2);

  // ── Aucun séparateur manuel ─────────────────────────────────────────────
  const virgule = await call('PUT', `/api/meetings/${meetingId}`, {
    headers: AUTH, body: { participants: [{ type: 'EXTERNAL', name: 'Jean, Marie' }] },
  });
  check('un nom à virgules est REFUSÉ', virgule.status === 400);
  check('…avec un code qui dit quoi faire',
    virgule.json.code === 'PANEL_PARTICIPANT_SEPARATOR');

  const chaine = await call('PUT', `/api/meetings/${meetingId}`, {
    headers: AUTH, body: { participants: 'Jean, Marie' },
  });
  check('une chaîne à la place de la liste est refusée',
    chaine.status === 400 && chaine.json.code === 'PANEL_PARTICIPANTS_FORMAT');

  const ancienChamp = await call('POST', '/api/meetings', {
    headers: AUTH,
    body: {
      projectId: P1, title: 'Ancien client', scheduledAt: dans(60),
      mode: 'ONSITE', address: 'A', externalParticipants: ['Jean, Marie'],
    },
  });
  check('l’ancien champ est refusé plutôt qu’ignoré en silence',
    ancienChamp.status === 400 && ancienChamp.json.code === 'PANEL_PARTICIPANTS_LEGACY');

  const typeInconnu = await call('PUT', `/api/meetings/${meetingId}`, {
    headers: AUTH, body: { participants: [{ type: 'PARTENAIRE', name: 'X' }] },
  });
  check('un type de participant hors liste est refusé', typeInconnu.status === 400);

  // ── La liste suit la réunion jusqu’à la confirmation ────────────────────
  const tenue = await meetings.createMeeting({
    projectId: P1, title: 'Réunion tenue', scheduledAt: dans(-15),
    mode: 'ONSITE', address: 'A',
    participants: [
      { type: 'EXTERNAL', name: 'Client' },
      { type: 'INTERNAL', name: 'Chef de projet' },
    ],
  }, { email: 'dev@panel.test' });
  await meetings.convertDueMeetings();
  const attente = await PanelProjectEvent.findOne({ sourceMeetingId: String(tenue._id) }).lean();
  check('l’événement en attente hérite des participants prévus',
    attente.participants.length === 2);
  check('…avec les mêmes identifiants',
    attente.participants[0].id === tenue.toObject().participants[0].id);

  const confirme = await call('POST', `/api/events/${attente._id}/confirm`, {
    headers: AUTH,
    body: { participants: attente.participants.filter((p) => p.type === 'EXTERNAL') },
  });
  check('confirmer permet de retirer un absent', confirme.json.data.event.participants.length === 1);
  check('…et de garder qui était là',
    confirme.json.data.event.participants[0].name === 'Client');
}

/* ────────────────────────────────────────────────────────────────────────── */
section('16. Migration des anciens participants — rien n’est perdu');
{
  await PanelMeeting.deleteMany({});
  await PanelProjectEvent.deleteMany({});

  // Documents au format PRÉCÉDENT (réunion / événement déjà séparés, mais
  // participants encore en texte) : écrits en brut, le schéma ne les connaît
  // plus.
  const { insertedIds } = await PanelMeeting.collection.insertMany([
    {
      projectId: P1, title: 'Réunion héritée', scheduledAt: new Date(Date.now() + 3600_000),
      durationMinutes: 60, mode: 'ONSITE', address: 'A', status: 'PLANNED',
      externalParticipants: ['Jean Dupont, Marie Martin', 'client@atelier.test'],
      internalParticipants: [{ name: 'Chef de projet', email: 'chef@panel.test' }],
      revisions: [], createdAt: new Date(),
    },
    {
      projectId: P1, title: 'Réunion sans personne', scheduledAt: new Date(Date.now() + 7200_000),
      durationMinutes: 60, mode: 'ONSITE', address: 'A', status: 'PLANNED',
      externalParticipants: ['', '   '], internalParticipants: [],
      revisions: [], createdAt: new Date(),
    },
  ]);
  await PanelProjectEvent.collection.insertOne({
    projectId: P1, type: 'CALL', status: 'CONFIRMED', title: 'Appel hérité',
    occurredAt: new Date(Date.now() - 3600_000),
    externalParticipants: ['Paul; Sophie'], internalParticipants: [],
    nextActions: [], revisions: [], createdAt: new Date(),
  });

  const res = await migrateParticipants();
  check('les trois objets sont examinés', res.examined === 3);
  check('…et repris', res.converted === 3);

  const heritee = await PanelMeeting.findById(insertedIds[0]).lean();
  check('une chaîne à virgules devient PLUSIEURS participants',
    heritee.participants.filter((p) => p.name === 'Jean Dupont' || p.name === 'Marie Martin').length === 2);
  check('…une adresse seule garde son courriel',
    heritee.participants.some((p) => p.email === 'client@atelier.test'));
  check('…un interne reste interne',
    heritee.participants.some((p) => p.type === 'INTERNAL' && p.name === 'Chef de projet'));
  check('…tout le monde est là : rien n’a été perdu', heritee.participants.length === 4);
  check('…chacun avec un identifiant',
    heritee.participants.every((p) => typeof p.id === 'string' && p.id.length > 0));
  check('…et plus aucune valeur ne contient de séparateur',
    heritee.participants.every((p) => !/[,;]/.test(`${p.name}${p.email ?? ''}${p.phone ?? ''}`)));
  check('les anciens champs ont disparu du document',
    heritee.externalParticipants === undefined && heritee.internalParticipants === undefined);

  const vide = await PanelMeeting.findById(insertedIds[1]).lean();
  check('une chaîne vide ne fabrique aucun participant fantôme',
    vide.participants.length === 0);

  const appel = await PanelProjectEvent.findOne({ title: 'Appel hérité' }).lean();
  check('les événements sont migrés comme les réunions', appel.participants.length === 2);
  check('…le point-virgule sépare aussi', appel.participants[1].name === 'Sophie');

  // ── Idempotence ─────────────────────────────────────────────────────────
  const avant = JSON.stringify((await PanelMeeting.findById(insertedIds[0]).lean()).participants);
  const rejeu = await migrateParticipants();
  check('relancer la migration n’examine plus rien', rejeu.examined === 0);
  check('…et ne touche à aucun participant',
    JSON.stringify((await PanelMeeting.findById(insertedIds[0]).lean()).participants) === avant);

  // Une reprise INTERROMPUE : le document porte déjà sa liste ET un ancien
  // champ. La fusion ne doit ni écraser, ni dupliquer.
  await PanelMeeting.collection.updateOne(
    { _id: insertedIds[0] },
    { $set: { externalParticipants: ['Jean Dupont', 'Nouveau venu'] } },
  );
  await migrateParticipants();
  const fusionne = await PanelMeeting.findById(insertedIds[0]).lean();
  check('une reprise interrompue ne duplique personne',
    fusionne.participants.filter((p) => p.name === 'Jean Dupont').length === 1);
  check('…et n’en perd aucun', fusionne.participants.length === 5);
}

/* ────────────────────────────────────────────────────────────────────────── */
section('17. Les écrans n’offrent plus aucun séparateur à saisir');
{
  const racine = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const lire = (rel) => fs.readFileSync(path.join(racine, rel), 'utf8');

  const composant = lire('frontend/src/components/Participants.tsx');
  const formulaires = lire('frontend/src/components/EventForms.tsx');
  const confirmation = lire('frontend/src/components/EventConfirmation.tsx');
  const listes = lire('frontend/src/components/EventLists.tsx');
  const ecrans = [formulaires, confirmation].join('\n');

  check('plus aucune consigne « séparés par des virgules »',
    !/virgule/i.test(ecrans));
  check('…ni découpage d’une saisie sur les virgules',
    !/split\(','\)/.test(ecrans) && !/split\(','\)/.test(composant));

  check('un bouton AJOUTE un participant', composant.includes('Ajouter un participant'));
  check('…un bouton en RETIRE un seul', /Retirer/.test(composant) && /filter\(\(p\) => p\.id !== id\)/.test(composant));
  check('…et la modification se fait champ par champ',
    /participants\.map\(\(p\) => \(p\.id === id \? remplacant : p\)\)/.test(composant));
  check('chaque ligne est identifiée, jamais par sa position',
    /key=\{p\.id\}/.test(composant) && !/key=\{index\}/.test(composant));
  check('aucune ligne vide n’est envoyée', composant.includes('participantsPrets'));
  check('les trois écrans de saisie utilisent le MÊME composant',
    (formulaires.match(/ParticipantsField/g) || []).length >= 2
    && confirmation.includes('ParticipantsField'));

  check('l’agenda affiche les participants d’une réunion',
    /ParticipantsSummary participants=\{meeting\.participants\}/.test(listes));
  check('…et l’historique ceux d’un événement',
    /ParticipantsSummary participants=\{event\.participants\}/.test(listes));
  check('l’affichage ne recolle jamais les noms avec un séparateur',
    !/participants[\s\S]{0,40}\.join\(/.test(listes) && !/\.join\(', '\)/.test(composant));

  // Le composant réutilise le design system : aucune classe inventée hors CSS.
  const css = lire('frontend/src/components.css');
  check('les blocs de participants sont stylés dans la couche commune',
    css.includes('.participant {') && css.includes('.participants {'));
  check('…et passent en une colonne sur mobile',
    /@media \(max-width: 900px\)[\s\S]*?\.participant \{\s*grid-template-columns: 1fr;/.test(css));
  check('le composant s’appuie sur les classes existantes (segmented, field, btn)',
    composant.includes('className="field"') && composant.includes('segment')
    && composant.includes('btn btn-secondary btn-small'));
  check('aucune dépendance ajoutée',
    !/from '(?!@\/|react|\.)/.test(composant));
}

scheduler.stopEventScheduler();
await close();
await stopMemoryMongo();
finish();
