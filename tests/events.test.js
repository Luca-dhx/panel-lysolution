/**
 * AGENDA ET ÉVÉNEMENTS DE SUIVI — la propriété du Panel, et le temps qui passe.
 *
 * Ce que ces contrôles verrouillent : qu'une heure atteinte ne confirme JAMAIS
 * une réunion, que la détection d'échéance soit idempotente, que « plus tard »
 * ne se transforme pas en harcèlement, qu'un report relie les deux dates dans
 * les deux sens — et qu'aucun pont ne soit jamais appelé.
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
const { PanelProjectEvent } = await import('../backend/src/models/PanelProjectEvent.model.js');
const events = await import('../backend/src/services/events/events.service.js');
const scheduler = await import('../backend/src/services/events/eventScheduler.js');

await seedFromEnv();
const { call, close } = await startServer(createApp());

const login = await call('POST', '/api/auth/login', {
  body: { email: 'dev@panel.test', password: 'motdepasse-test' },
});
const AUTH = { authorization: `Bearer ${login.json.data.token}` };

const dans = (minutes) => new Date(Date.now() + minutes * 60_000).toISOString();
const PROJET = 'projet-agenda-1';

/* ────────────────────────────────────────────────────────────────────────── */
section('1. Planifier un événement');
{
  const res = await call('POST', '/api/events', {
    headers: AUTH,
    body: {
      projectId: PROJET, projectName: 'SB Auto 07', type: 'MEETING',
      title: 'Point mensuel', scheduledAt: dans(60), durationMinutes: 30,
      externalParticipants: ['client@garage.test'],
    },
  });
  check('l’événement est créé', res.status === 201);
  check('…en PLANNED', res.json.data.event.status === 'PLANNED');
  check('…avec son type', res.json.data.event.type === 'MEETING');
  check('…et une première transition journalisée',
    res.json.data.event.transitions.length === 1
    && res.json.data.event.transitions[0].to === 'PLANNED');
  check('…portant son initiateur',
    res.json.data.event.transitions[0].actorEmail === 'dev@panel.test');

  const sansTitre = await call('POST', '/api/events', {
    headers: AUTH, body: { projectId: PROJET, scheduledAt: dans(60) },
  });
  check('un événement sans intitulé est refusé', sansTitre.status === 400);

  const sansDate = await call('POST', '/api/events', {
    headers: AUTH, body: { projectId: PROJET, title: 'Sans date' },
  });
  check('…sans date aussi', sansDate.status === 400);

  const sansJwt = await call('POST', '/api/events', { body: { projectId: PROJET } });
  check('…et sans authentification', sansJwt.status === 401);
}

section('2. L’heure atteinte rend DÛ, jamais RÉALISÉ');
{
  await PanelProjectEvent.deleteMany({});
  const passe = await events.createEvent({
    projectId: PROJET, title: 'Réunion d’hier', scheduledAt: dans(-30),
  }, { email: 'dev@panel.test' });
  const futur = await events.createEvent({
    projectId: PROJET, title: 'Réunion de demain', scheduledAt: dans(600),
  }, { email: 'dev@panel.test' });

  const marques = await events.markDueEvents();
  check('l’événement échu passe à DUE', marques === 1);
  check('…et c’est bien lui',
    (await PanelProjectEvent.findById(passe._id).lean()).status === 'DUE');
  check('LE POINT CENTRAL : il n’est PAS marqué réalisé',
    (await PanelProjectEvent.findById(passe._id).lean()).status !== 'COMPLETED');
  check('…l’événement futur ne bouge pas',
    (await PanelProjectEvent.findById(futur._id).lean()).status === 'PLANNED');

  const transitions = (await PanelProjectEvent.findById(passe._id).lean()).transitions;
  check('la transition automatique est journalisée',
    transitions.at(-1).from === 'PLANNED' && transitions.at(-1).to === 'DUE');
  check('…sans auteur humain, mais avec un rôle SYSTEM',
    transitions.at(-1).actorEmail === null && transitions.at(-1).actorRole === 'SYSTEM');
}

section('3. Le détecteur d’échéance est IDEMPOTENT');
{
  const avant = await PanelProjectEvent.findOne({ status: 'DUE' }).lean();
  check('un second passage ne marque rien', (await events.markDueEvents()) === 0);
  const apres = await PanelProjectEvent.findById(avant._id).lean();
  check('…et n’ajoute aucune transition en double',
    apres.transitions.length === avant.transitions.length);

  // Deux cycles concurrents : le second s'efface plutôt que de doubler.
  const [a, b] = await Promise.all([scheduler.runEventCycle(), scheduler.runEventCycle()]);
  check('deux cycles simultanés ne se marchent pas dessus',
    a.skipped === true || b.skipped === true || (a.due === 0 && b.due === 0));

  check('le minuteur démarre', scheduler.startEventScheduler({ intervalMs: 60_000 }) !== null);
  check('…et ne se dédouble pas', scheduler.isEventSchedulerRunning() === true);
  check('l’arrêt est propre', scheduler.stopEventScheduler() === true);
  check('…et un second arrêt ne fait rien', scheduler.stopEventScheduler() === false);
}

section('4. Confirmation : « oui, elle a eu lieu »');
{
  const du = await PanelProjectEvent.findOne({ status: 'DUE' }).lean();
  const res = await call('POST', `/api/events/${du._id}/complete`, {
    headers: AUTH,
    body: {
      notes: 'Tour d’horizon du trimestre',
      outcome: 'Client satisfait',
      nextActions: ['Envoyer le devis', 'Rappeler en septembre'],
      externalParticipants: ['client@garage.test'],
      occurredAt: dans(-25),
    },
  });
  check('l’événement est confirmé', res.status === 200 && res.json.data.event.status === 'COMPLETED');
  check('…avec son compte rendu', res.json.data.event.notes === 'Tour d’horizon du trimestre');
  check('…ses prochaines actions', res.json.data.event.nextActions.length === 2);
  check('…et l’heure RÉELLE, différente de l’heure prévue',
    res.json.data.event.occurredAt !== res.json.data.event.scheduledAt);

  const rejeu = await call('POST', `/api/events/${du._id}/complete`, { headers: AUTH, body: {} });
  check('un événement classé ne se reclasse pas', rejeu.status === 409);
  check('…avec un code explicite', rejeu.json.code === 'PANEL_EVENT_TRANSITION_FORBIDDEN');
}

section('5. « Non, elle n’a pas eu lieu » — le motif décide');
{
  await PanelProjectEvent.deleteMany({});
  const faire = async (titre) => {
    const e = await events.createEvent({ projectId: PROJET, title: titre, scheduledAt: dans(-10) },
      { email: 'dev@panel.test' });
    await events.markDueEvents();
    return e;
  };

  const absent = await faire('Client absent');
  const r1 = await call('POST', `/api/events/${absent._id}/miss`, {
    headers: AUTH, body: { reason: 'CLIENT_ABSENT', notes: 'Personne au rendez-vous' },
  });
  check('un client absent → MISSED', r1.json.data.event.status === 'MISSED');
  check('…avec son motif', r1.json.data.event.missedReason === 'CLIENT_ABSENT');

  const annulee = await faire('Annulée la veille');
  const r2 = await call('POST', `/api/events/${annulee._id}/miss`, {
    headers: AUTH, body: { reason: 'CANCELLED' },
  });
  check('une annulation → CANCELLED, pas MISSED', r2.json.data.event.status === 'CANCELLED');
  check('…horodatée', typeof r2.json.data.event.cancelledAt === 'string');

  const inconnu = await faire('Motif inconnu');
  const r3 = await call('POST', `/api/events/${inconnu._id}/miss`, {
    headers: AUTH, body: { reason: 'PARCE_QUE' },
  });
  check('un motif hors liste est refusé', r3.status === 400);
}

section('6. Report : deux dates, deux liens');
{
  await PanelProjectEvent.deleteMany({});
  const initial = await events.createEvent({
    projectId: PROJET, projectName: 'SB Auto 07', title: 'Revue de contrat',
    scheduledAt: dans(-5), externalParticipants: ['client@garage.test'],
  }, { email: 'dev@panel.test' });
  await events.markDueEvents();

  const res = await call('POST', `/api/events/${initial._id}/reschedule`, {
    headers: AUTH, body: { scheduledAt: dans(2880), reason: 'Client indisponible' },
  });
  check('le report réussit', res.status === 200);
  const { previous, next } = res.json.data;
  check('l’ancien est CLOS', previous.status === 'CANCELLED');
  check('…et pointe vers le nouveau', previous.rescheduledToEventId === next._id);
  check('le nouveau est PLANNED', next.status === 'PLANNED');
  check('…et pointe vers l’ancien', next.reportOfEventId === previous._id);
  check('…en gardant l’intitulé et les participants',
    next.title === 'Revue de contrat' && next.externalParticipants.length === 1);
  check('le motif du report est journalisé',
    previous.transitions.at(-1).reason === 'Client indisponible');
}

section('7. « Me le rappeler plus tard » ne harcèle pas');
{
  await PanelProjectEvent.deleteMany({});
  const e = await events.createEvent({
    projectId: PROJET, title: 'À confirmer', scheduledAt: dans(-15),
  }, { email: 'dev@panel.test' });
  await events.markDueEvents();

  check('il apparaît dans les confirmations en attente',
    (await events.listPendingConfirmations()).length === 1);

  const res = await call('POST', `/api/events/${e._id}/snooze`, { headers: AUTH });
  check('le report de relance réussit', res.status === 200);
  check('…l’événement RESTE dû', res.json.data.event.status === 'DUE');
  check('…mais disparaît des relances immédiates',
    (await events.listPendingConfirmations()).length === 0);
  check('…et revient à l’échéance de la relance',
    (await events.listPendingConfirmations(new Date(Date.now() + 3 * 3600_000))).length === 1);

  const planifie = await events.createEvent({
    projectId: PROJET, title: 'Pas encore dû', scheduledAt: dans(600),
  }, { email: 'dev@panel.test' });
  const refus = await call('POST', `/api/events/${planifie._id}/snooze`, { headers: AUTH });
  check('on ne repousse pas un événement qui n’est pas dû', refus.status === 409);
}

section('8. Lectures : agenda, fiche projet, tableau de bord');
{
  await PanelProjectEvent.deleteMany({});
  await events.createEvent({ projectId: PROJET, title: 'Demain', scheduledAt: dans(1440) }, {});
  const echu = await events.createEvent({ projectId: PROJET, title: 'Échu', scheduledAt: dans(-20) }, {});
  await events.markDueEvents();
  const fini = await events.createEvent({ projectId: PROJET, title: 'Fini', scheduledAt: dans(-2880) }, {});
  await events.markDueEvents();
  await events.completeEvent(fini._id, {}, { email: 'dev@panel.test' });

  const aVenir = await call('GET', '/api/events?scope=upcoming', { headers: AUTH });
  check('« à venir » ne montre que le futur non classé',
    aVenir.json.data.events.every((x) => x.status === 'PLANNED' || x.status === 'DUE'));

  const aConfirmer = await call('GET', '/api/events?scope=to_confirm', { headers: AUTH });
  check('« à confirmer » ne montre que les DUE',
    aConfirmer.json.data.events.length === 1
    && aConfirmer.json.data.events[0]._id === String(echu._id));

  const passes = await call('GET', '/api/events?scope=past', { headers: AUTH });
  check('« passés » ne montre que les événements classés',
    passes.json.data.events.every((x) => ['COMPLETED', 'MISSED', 'CANCELLED'].includes(x.status)));

  const fiche = await call('GET', `/api/events/project/${PROJET}`, { headers: AUTH });
  check('la fiche projet donne le prochain événement', fiche.json.data.next?.title === 'Demain');
  check('…ceux à confirmer', fiche.json.data.toConfirm.length === 1);
  check('…et l’historique', fiche.json.data.history.length === 1);

  const attente = await call('GET', '/api/events/pending', { headers: AUTH });
  check('le tableau de bord voit les confirmations en attente',
    attente.json.data.events.length === 1);
}

section('9. AUCUN pont n’est appelé — jamais');
{
  const racine = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const lire = (rel) => fs.readFileSync(path.join(racine, rel), 'utf8');
  const sources = [
    'backend/src/services/events/events.service.js',
    'backend/src/services/events/eventScheduler.js',
    'backend/src/controllers/events.controller.js',
    'backend/src/models/PanelProjectEvent.model.js',
  ].map(lire).join('\n');

  check('aucun client de pont importé', !/ProjectBridgeClient/.test(sources));
  check('aucune projection métier touchée', !/PanelProjectContract|PanelProjectPresentation/.test(sources));
  check('aucune mise en file de synchronisation', !/outbox|emitChange|sync\/push/i.test(sources));
  check('aucune notion d’entité de contrat', !/entityType|writeId/.test(sources));
}

section('10. Les écrans montrent l’agenda — sans clignoter');
{
  const racine = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const lire = (rel) => fs.readFileSync(path.join(racine, rel), 'utf8');

  const nav = lire('frontend/src/config/nav.ts');
  check('une entrée « Agenda et événements » existe dans GESTION',
    /to: '\/agenda'[\s\S]{0,80}section: 'GESTION'/.test(nav));
  check('…et elle n’est PAS réservée aux DEV',
    !/to: '\/agenda'[\s\S]{0,120}devOnly/.test(nav));

  const app = lire('frontend/src/App.tsx');
  check('la route est déclarée', app.includes('path="/agenda"'));

  const agenda = lire('frontend/src/pages/AgendaPage.tsx');
  for (const filtre of ['today', 'upcoming', 'to_confirm', 'past']) {
    check(`filtre « ${filtre} » présent`, agenda.includes(`'${filtre}'`));
  }
  check('bouton « Planifier un événement »', agenda.includes('Planifier un événement'));

  const fiche = lire('frontend/src/pages/ProjectDetailPage.tsx');
  check('la fiche projet montre prochain, à confirmer et historique',
    fiche.includes('Prochain rendez-vous') && fiche.includes('Historique')
    && fiche.includes('EventConfirmation'));

  const dashboard = lire('frontend/src/pages/DashboardPage.tsx');
  check('le tableau de bord montre la journée et les confirmations',
    dashboard.includes('Confirmations en attente') && dashboard.includes('Aujourd’hui')
    && dashboard.includes('Prochains rendez-vous'));

  const confirmation = lire('frontend/src/components/EventConfirmation.tsx');
  check('la boîte pose les QUATRE réponses',
    /a eu lieu/.test(confirmation) && /n’a pas eu lieu/.test(confirmation)
    && /Reporter/.test(confirmation) && /rappeler plus tard/.test(confirmation));

  // Le sondage passe par la lecture vivante : jamais d'écran vidé, jamais de
  // filtre perdu, un seul minuteur nettoyé au démontage.
  const hook = lire('frontend/src/lib/useEvents.ts');
  check('les écrans utilisent la lecture silencieuse', hook.includes('useLiveQuery'));
  check('…et ne posent aucun minuteur à eux', !/setInterval/.test(hook));
  for (const [nom, source] of [['agenda', agenda], ['tableau de bord', dashboard]]) {
    check(`${nom} : aucun sondage visible`, !/setInterval|setTimeout/.test(source));
  }

  const front = [agenda, fiche, dashboard, confirmation, hook].join(' ');
  check('aucun WebSocket maison', !/WebSocket|EventSource/.test(front));
}

scheduler.stopEventScheduler();
await close();
await stopMemoryMongo();
finish();
