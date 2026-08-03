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
const { migrateLegacyEvents } = await import('../backend/src/services/events/eventsMigration.js');

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
      externalParticipants: ['client@garage.test'],
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
      externalParticipants: ['client@garage.test'],
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
    scheduledAt: dans(-5), externalParticipants: ['client@garage.test'],
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
    next.title === 'Revue de contrat' && next.externalParticipants.length === 1);

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
      durationMinutes: 30, externalParticipants: ['client@garage.test'], createdAt: new Date(),
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
  check('…en gardant ses participants', aVenir.externalParticipants.length === 1);

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

scheduler.stopEventScheduler();
await close();
await stopMemoryMongo();
finish();
