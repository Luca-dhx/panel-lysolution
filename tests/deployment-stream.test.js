// FLUX REPRENABLE DU SUIVI DE DÉPLOIEMENT.
//
// ── LE PROBLÈME QUE CETTE ARCHITECTURE RÉSOUT ───────────────────────────────
// SB Auto diffuse son déploiement depuis la requête HTTP qui l'exécute : son
// backend n'est jamais l'application déployée, la connexion survit donc.
// Le Panel se déploie LUI-MÊME : à `services.start`, PM2 redémarre le processus
// qui servirait le flux. Un flux « à la SB Auto » mourrait au milieu.
//
// D'où un flux alimenté par un JOURNAL PERSISTÉ, écrit par le worker détaché :
// le client se reconnecte avec le dernier `seq` reçu et reprend exactement où
// il en était. Ce test prouve les quatre garanties : ordre, pas de perte, pas
// de doublon, reprise après coupure.
import { check, finish, section, setTestEnv, startMemoryMongo, connectTestDatabase, stopMemoryMongo } from './helpers/harness.js';

setTestEnv();
await startMemoryMongo();
await connectTestDatabase();

const runs = await import('../backend/src/services/deployment/deploymentRun.service.js');
const { CANONICAL_STEPS } = await import('../backend/src/deployment-engine/steps.js');
const PanelDeploymentRun = (await import('../backend/src/models/PanelDeploymentRun.model.js')).default;

const TARGET = { targetId: 't-1', name: 'TEST', url: 'https://panel.exemple.com', host: 'panel.exemple.com', environment: 'TEST' };
const newRun = () => runs.createRun({ target: TARGET, operationType: 'DEPLOYMENT' });

/* ────────────────────────────────────────────────────────────────────────── */
section('1. Checklist complète dès la création — aucune ligne n’apparaîtra ensuite');
{
  const runId = await newRun();
  const doc = await PanelDeploymentRun.findOne({ runId }).lean();
  check('toutes les étapes canoniques sont présentes dès la création',
    doc.steps.length === CANONICAL_STEPS.length);
  check('elles sont dans l’ordre canonique',
    doc.steps.map((s) => s.id).join(',') === CANONICAL_STEPS.map((s) => s.id).join(','));
  check('toutes en attente', doc.steps.every((s) => s.status === 'pending'));
  check('le journal démarre vide, curseur à 0', (doc.events ?? []).length === 0 && (doc.eventSeq ?? 0) === 0);
}

/* ────────────────────────────────────────────────────────────────────────── */
section('2. Ordre garanti et séquence monotone');
{
  const runId = await newRun();
  for (const id of ['deployment.initialize', 'ssh.connect', 'artifact.build']) {
    await runs.recordStep(runId, { id, status: 'running' });
    await runs.recordStep(runId, { id, status: 'ok' });
  }
  const { events, lastSeq } = await runs.readEventsSince(runId, 0);

  check('un évènement par transition (6)', events.filter((e) => e.kind === 'step').length === 6);
  check('les seq sont strictement croissants',
    events.every((e, i) => i === 0 || e.seq > events[i - 1].seq));
  check('les seq sont sans trou (1..N)',
    events.map((e) => e.seq).join(',') === events.map((_, i) => i + 1).join(','));
  check('lastSeq correspond au dernier évènement', lastSeq === events[events.length - 1].seq);
  check('l’ordre des transitions est celui de l’émission',
    events.map((e) => `${e.payload.id}:${e.payload.status}`).join(' ')
      === 'deployment.initialize:running deployment.initialize:ok ssh.connect:running ssh.connect:ok artifact.build:running artifact.build:ok');
}

/* ────────────────────────────────────────────────────────────────────────── */
section('3. Reprise après coupure : aucune perte, aucun doublon');
{
  const runId = await newRun();
  await runs.recordStep(runId, { id: 'deployment.initialize', status: 'ok' });
  await runs.recordStep(runId, { id: 'ssh.connect', status: 'running' });

  // Le client a reçu jusqu'ici, puis le backend redémarre (auto-déploiement).
  const premier = await runs.readEventsSince(runId, 0);
  const dernierRecu = premier.events[premier.events.length - 1].seq;

  // Pendant la coupure, le worker détaché CONTINUE d'écrire.
  await runs.recordStep(runId, { id: 'ssh.connect', status: 'ok' });
  await runs.recordStep(runId, { id: 'server.preflight', status: 'running' });
  await runs.recordStep(runId, { id: 'server.preflight', status: 'ok' });

  // Reconnexion avec le curseur.
  const reprise = await runs.readEventsSince(runId, dernierRecu);

  check('la reprise ne renvoie AUCUN évènement déjà reçu',
    reprise.events.every((e) => e.seq > dernierRecu));
  check('la reprise renvoie TOUT ce qui a été produit pendant la coupure',
    reprise.events.length === 3);
  check('aucun trou entre la coupure et la reprise',
    reprise.events[0].seq === dernierRecu + 1);

  // Union des deux lectures == journal complet, sans doublon.
  const complet = await runs.readEventsSince(runId, 0);
  const union = [...premier.events, ...reprise.events].map((e) => e.seq);
  check('coupure + reprise reconstituent exactement le journal',
    union.join(',') === complet.events.map((e) => e.seq).join(','));
  check('aucun seq dupliqué', new Set(union).size === union.length);
}

/* ────────────────────────────────────────────────────────────────────────── */
section('4. Concurrence : deux écrivains ne partagent jamais un numéro');
{
  const runId = await newRun();
  // 40 écritures lancées SANS attente entre elles : c'est le cas d'un worker
  // qui émet plusieurs étapes dans la même milliseconde.
  await Promise.all(
    Array.from({ length: 40 }, (_, i) => runs.appendEvent(runId, 'log', { i })),
  );
  const { events, lastSeq } = await runs.readEventsSince(runId, 0);
  const seqs = events.map((e) => e.seq);

  check('40 évènements écrits', events.length === 40);
  check('40 numéros DISTINCTS (attribution atomique)', new Set(seqs).size === 40);
  check('la suite est complète 1..40', [...seqs].sort((a, b) => a - b).join(',') === Array.from({ length: 40 }, (_, i) => i + 1).join(','));
  check('le compteur final vaut 40', lastSeq === 40);
}

/* ────────────────────────────────────────────────────────────────────────── */
section('5. L’état courant reste cohérent avec le journal');
{
  const runId = await newRun();
  await runs.recordStep(runId, { id: 'artifact.build', status: 'running' });
  await new Promise((r) => { setTimeout(r, 30); });
  await runs.recordStep(runId, { id: 'artifact.build', status: 'ok' });
  await runs.appendLog(runId, 'construction terminée', 'INFO');

  const doc = await PanelDeploymentRun.findOne({ runId }).lean();
  const step = doc.steps.find((s) => s.id === 'artifact.build');

  check('la checklist reflète l’état final', step.status === 'ok');
  check('la ligne n’a PAS changé de place',
    doc.steps.map((s) => s.id).join(',') === CANONICAL_STEPS.map((s) => s.id).join(','));
  check('la durée est mesurée (non nulle)', typeof step.durationMs === 'number' && step.durationMs >= 20);
  check('le journal contient aussi la ligne de log',
    doc.events.some((e) => e.kind === 'log' && e.payload.message === 'construction terminée'));
  check('un client parti de 0 rejoue exactement la même suite',
    doc.events.filter((e) => e.kind === 'step').map((e) => e.payload.status).join(',') === 'running,ok');
}

/* ────────────────────────────────────────────────────────────────────────── */
section('6. Client trop en retard : on demande un rechargement, on ne ment pas');
{
  const runId = await newRun();
  await runs.appendEvent(runId, 'log', { a: 1 });
  await runs.appendEvent(runId, 'log', { a: 2 });
  // Journal tronqué simulé : le plus ancien conservé est postérieur au curseur.
  await PanelDeploymentRun.updateOne({ runId }, { $set: { events: [{ seq: 50, at: new Date().toISOString(), kind: 'log', payload: {} }], eventSeq: 50 } });
  const r = await runs.readEventsSince(runId, 2);
  check('un curseur dépassé est signalé (truncated)', r.truncated === true);

  const frais = await runs.readEventsSince(runId, 49);
  check('un curseur récent n’est pas signalé comme tronqué', frais.truncated === false);
}

/* -------------------------------------------------------------------------- */
section('7. Troncature : le serveur donne le curseur de reprise (sinon le suivi gèle)');
{
  const runId = await newRun();
  await runs.appendEvent(runId, 'log', { a: 1 });
  await PanelDeploymentRun.updateOne({ runId }, { $set: { events: [{ seq: 90, at: new Date().toISOString(), kind: 'log', payload: {} }], eventSeq: 90 } });

  const r = await runs.readEventsSince(runId, 1);
  check('la troncature est signalée', r.truncated === true);
  check('…et `lastSeq` est fourni pour reprendre', typeof r.lastSeq === 'number' && r.lastSeq === 90);

  // Le piège : reprendre à une valeur arbitrairement grande fige le suivi,
  // car le serveur ne rend que les évènements STRICTEMENT postérieurs.
  await runs.appendEvent(runId, 'log', { a: 2 });
  const gele = await runs.readEventsSince(runId, Number.MAX_SAFE_INTEGER);
  check('un curseur infini ne rendrait PLUS JAMAIS d’évènement', gele.events.length === 0);
  const correct = await runs.readEventsSince(runId, r.lastSeq);
  check('…alors que le curseur donné par le serveur reprend bien', correct.events.length === 1);
}

/* -------------------------------------------------------------------------- */
section('8. Conclusion : le journal seul suffit à reconstruire l’état final');
{
  const runId = await newRun();
  await runs.recordStep(runId, { id: 'deployment.initialize', status: 'ok' });
  await runs.recordStep(runId, { id: 'artifact.build', status: 'running' });

  await runs.finalizeRun(runId, { status: 'error', summary: 'échec build' });

  const doc = await PanelDeploymentRun.findOne({ runId }).lean();
  const { events } = await runs.readEventsSince(runId, 0);

  // Rejeu du journal seul, à partir d'une checklist neuve.
  const rejoue = new Map(CANONICAL_STEPS.map((s) => [s.id, 'pending']));
  for (const e of events) if (e.kind === 'step') rejoue.set(e.payload.id, e.payload.status);

  const reel = new Map(doc.steps.map((s) => [s.id, s.status]));
  const divergents = [...reel.entries()].filter(([id, st]) => rejoue.get(id) !== st).map(([id]) => id);

  check('l’étape en cours a été requalifiée en erreur',
    doc.steps.find((s) => s.id === 'artifact.build').status === 'error');
  check('les étapes jamais atteintes sont ignorées, pas laissées en attente',
    doc.steps.find((s) => s.id === 'public.healthcheck').status === 'skipped');
  check('le journal REJOUÉ donne exactement l’état final affiché', divergents.length === 0);
  if (divergents.length) console.error(`    → divergent : ${divergents.slice(0, 5).join(', ')}`);
  check('le statut final figure au journal',
    events.some((e) => e.kind === 'status' && e.payload.status === 'error'));
}

await stopMemoryMongo();
finish();
