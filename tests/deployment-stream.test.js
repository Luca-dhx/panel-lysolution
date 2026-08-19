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

/* ────────────────────────────────────────────────────────────────────────── */
section('9. Étapes émises coup sur coup : l’ordre d’écriture suit l’ordre d’émission');
{
  // ── LA RÉGRESSION VERROUILLÉE ICI ────────────────────────────────────────
  // Le moteur émet `running` puis l'état terminal de la MÊME étape. Quand un
  // vrai travail les sépare (build, pipeline distant), la première écriture a
  // le temps de se déposer. Quand rien ne les sépare — préflight, finalisation
  // — les deux écritures partaient en parallèle et se doublaient : `running`
  // se déposait parfois APRÈS `ok`. L'étape restait « en cours », et
  // `finalizeRun` requalifie tout `running` résiduel en `error` : des étapes
  // ROUGES sur un déploiement réussi à 20/20.
  //
  // Les sections précédentes ne pouvaient pas le voir : elles attendent chaque
  // `recordStep`. C'est justement l'absence d'attente qui était le défaut.
  const runId = await newRun();

  // Câblage du worker : file sérialisée, dans l'ordre d'émission.
  let queue = Promise.resolve();
  const emit = (step) => { queue = queue.then(() => runs.recordStep(runId, step)); return queue; };

  const BACK_TO_BACK = ['ssh.connect', 'server.preflight', 'remote.safety', 'deployment.finalize'];
  for (const id of BACK_TO_BACK) {
    emit({ id, status: 'running' });   // volontairement NON attendu
    emit({ id, status: 'ok' });        // idem : c'est le cas qui régressait
  }
  await queue;

  const materialized = (await PanelDeploymentRun.findOne({ runId }).select('steps').lean()).steps;
  const stuck = materialized.filter((s) => BACK_TO_BACK.includes(s.id) && s.status !== 'ok');
  check(`aucune étape ne reste « en cours »${stuck.length ? ` — ${stuck.map((s) => `${s.id}:${s.status}`).join(', ')}` : ''}`,
    stuck.length === 0);

  // Le journal doit raconter la même histoire, dans le même ordre : pour
  // chaque étape, `running` AVANT son état terminal. Un journal qui annonce la
  // fin avant le début ne peut pas être rejoué par un client reconnecté.
  const { events } = await runs.readEventsSince(runId, 0);
  const stepEvents = events.filter((e) => e.kind === 'step');
  const outOfOrder = BACK_TO_BACK.filter((id) => {
    const seqs = stepEvents.filter((e) => e.payload.id === id);
    return seqs.length !== 2 || seqs[0].payload.status !== 'running' || seqs[1].payload.status !== 'ok';
  });
  check(`le journal ordonne running → ok pour chaque étape${outOfOrder.length ? ` — ${outOfOrder.join(', ')}` : ''}`,
    outOfOrder.length === 0);

  // Et la conclusion ne doit noircir personne.
  await runs.finalizeRun(runId, { status: 'ok', summary: 'Déploiement réussi.' });
  const finalSteps = (await PanelDeploymentRun.findOne({ runId }).select('steps').lean()).steps;
  const red = finalSteps.filter((s) => s.status === 'error');
  check(`après finalizeRun, aucune étape rouge sur un run réussi${red.length ? ` — ${red.map((s) => s.id).join(', ')}` : ''}`,
    red.length === 0);
  check('les étapes jamais émises restent « sautées », pas en erreur',
    finalSteps.filter((s) => !BACK_TO_BACK.includes(s.id)).every((s) => s.status === 'skipped'));
}

/* ────────────────────────────────────────────────────────────────────────── */
section('10. Le câblage réel sérialise les écritures et pose la barrière');
{
  /**
   * ══ CE QUI RESTE D'UNE GARDE STRUCTURELLE, ET CE QUI L'A REMPLACÉE ════════
   *
   * Cette section relisait le TEXTE de `deploy-worker.js` — un point d'entrée
   * qui lit son environnement et sort par `process.exit()`, donc inéprouvable
   * autrement. Une expression régulière ne dit pourtant rien de ce que le
   * texte FAIT : elle aurait continué de passer sur un `drain()` appelé au
   * mauvais moment.
   *
   * L'orchestration vit désormais dans `deploymentJob.service.js`, et
   * `deployment-durable-recorder.test.js` la met RÉELLEMENT en panne sur le
   * chemin de production : journal perdu avant la bascule, après, à la
   * conclusion. Ce qui subsiste ici est le seul invariant qu'un comportement
   * ne montre pas — que le point d'entrée ne se soit pas remis à orchestrer
   * dans son coin.
   */
  const fs = await import('node:fs');
  const path = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const worker = fs.readFileSync(path.join(root, 'backend/src/scripts/deploy-worker.js'), 'utf8');
  const job = fs.readFileSync(path.join(root, 'backend/src/services/deployment/deploymentJob.service.js'), 'utf8');

  check('le worker n’écrit plus aucune étape lui-même',
    !/recordStep/.test(worker) && !/finalizeRun/.test(worker));
  check('…il délègue l’orchestration au service éprouvable',
    /runDeploymentJob\(/.test(worker));

  check('les écritures d’étapes passent par le journal durable',
    /createDurableRecorder\(runId/.test(job) && /recorder\.recordStep\(step\)/.test(job));
  check('la file est vidée AVANT la conclusion',
    /await recorder\.drain\(\);[\s\S]{0,2000}?await recorder\.finalize\(/.test(job));
  check('…et la barrière de publication est fournie au moteur',
    /assertDurable: \(\) => recorder\.assertDurable\(\)/.test(job));
  check('…aucune écriture d’étape n’est plus avalée en silence',
    !/recordStep[\s\S]{0,80}catch\(\(\) => \{\}\)/.test(job));
  check('la conclusion n’est plus enveloppée dans un catch muet',
    !/catch\s*\{\s*\/\/[^\n]*\n\s*\}/.test(job.replace(/\/\*[\s\S]*?\*\//g, '')));
}

/* ────────────────────────────────────────────────────────────────────────── */
section('11. LE FLUX HTTP RÉEL — coupé en plein vol, repris sans trou');
{
  /**
   * ══ L'INCIDENT QUE CETTE SECTION FERME ═════════════════════════════════════
   *
   *     [vite] http proxy error:
   *     /api/deployment/runs/<uuid>/stream?since=0 — read ECONNRESET
   *
   * Un déploiement en cours, le backend qui redémarre (c'est le PROPRE de
   * l'auto-déploiement du Panel), et la connexion du navigateur qui tombe.
   *
   * Les sections précédentes éprouvaient la reprise sur la PRIMITIVE
   * (`readEventsSince`). Elles ne disaient rien de la ROUTE — celle qui a
   * réellement cassé. Or c'est là que se joue le contrat : le curseur `since`
   * voyage en query string, la réponse est un flux NDJSON tenu ouvert, et une
   * coupure y ressemble à une fin de réponse normale.
   *
   * On coupe donc pour de vrai — au milieu du flux, côté client — et on
   * rouvre avec le dernier `seq` REÇU, comme le fait l'écran.
   */
  const { seedFromEnv } = await import('../backend/src/services/auth/panelUsers.service.js');
  await seedFromEnv();
  const { createApp } = await import('../backend/src/app.js');
  const { startServer } = await import('./helpers/harness.js');
  const { base, call, close } = await startServer(createApp());

  const login = await call('POST', '/api/auth/login', {
    body: { email: 'dev@panel.test', password: 'motdepasse-test' },
  });
  const jeton = login.json?.data?.token;
  check('une session DEV est ouverte pour lire le flux', typeof jeton === 'string');

  const runId = await newRun();
  await runs.recordStep(runId, { id: 'deployment.initialize', status: 'running' });
  await runs.recordStep(runId, { id: 'deployment.initialize', status: 'ok' });
  await runs.recordStep(runId, { id: 'ssh.connect', status: 'running' });

  /**
   * Lit le flux NDJSON et rend la main après `stopApres` évènements PORTEURS.
   *
   * Les `ping` sont écartés à dessein : ce sont des battements de maintien de
   * connexion, qui REPÈTENT le curseur courant sans rien apporter. Le client
   * réel ne fait pas autre chose (`Math.max(curseur, evt.seq)`), et les compter
   * comme des évènements ferait lire un doublon là où il n'y a qu'un souffle.
   */
  const lireFlux = async (since, stopApres) => {
    const controleur = new AbortController();
    const res = await fetch(`${base}/api/deployment/runs/${runId}/stream?since=${since}`, {
      headers: { authorization: `Bearer ${jeton}` },
      signal: controleur.signal,
    });
    const recus = [];
    const lecteur = res.body.getReader();
    const decodeur = new TextDecoder();
    let tampon = '';
    try {
      while (recus.length < stopApres) {
        const { done, value } = await lecteur.read();
        if (done) break;
        tampon += decodeur.decode(value, { stream: true });
        let nl = tampon.indexOf('\n');
        while (nl !== -1 && recus.length < stopApres) {
          const ligne = tampon.slice(0, nl).trim();
          tampon = tampon.slice(nl + 1);
          if (ligne) {
            const evt = JSON.parse(ligne);
            if (evt.kind !== 'ping') recus.push(evt);
          }
          nl = tampon.indexOf('\n');
        }
      }
    } finally {
      // LA COUPURE : le client s'en va sans prévenir — exactement ce que fait
      // un onglet fermé, un proxy qui tombe, ou un backend qui redémarre.
      controleur.abort();
    }
    return { status: res.status, recus };
  };

  const premier = await lireFlux(0, 3);
  check(`le flux répond et diffuse (${premier.status})`, premier.status === 200 && premier.recus.length === 3);
  const dernierRecu = premier.recus[premier.recus.length - 1].seq;
  check('chaque ligne porte son numéro de séquence',
    premier.recus.every((e) => typeof e.seq === 'number'));

  /**
   * PENDANT LA COUPURE, LE WORKER CONTINUE — c'est tout l'intérêt d'un journal
   * durable. Personne ne lit, et le déploiement avance quand même.
   */
  await runs.recordStep(runId, { id: 'ssh.connect', status: 'ok' });
  await runs.recordStep(runId, { id: 'server.preflight', status: 'running' });
  await runs.recordStep(runId, { id: 'server.preflight', status: 'ok' });

  const reprise = await lireFlux(dernierRecu, 3);
  check('la reprise rend exactement ce qui a été manqué', reprise.recus.length === 3);
  check('…aucun évènement déjà reçu n’est renvoyé',
    reprise.recus.every((e) => e.seq > dernierRecu));
  check('…et la suite est CONTIGUË — aucun trou',
    reprise.recus[0].seq === dernierRecu + 1);

  const union = [...premier.recus, ...reprise.recus].map((e) => e.seq);
  check('coupure + reprise reconstituent le journal, sans doublon',
    new Set(union).size === union.length
    && union.join(',') === union.slice().sort((a, b) => a - b).join(','));

  /**
   * ET LE RUN SURVIT À LA COUPURE — c'est ce que l'écran relit au rafraîchis-
   * sement : il ne relance rien, il retrouve.
   */
  const relu = await call('GET', `/api/deployment/runs/${runId}`, {
    headers: { authorization: `Bearer ${jeton}` },
  });
  check('un rafraîchissement retrouve le run existant', relu.status === 200 && relu.json.data.runId === runId);
  check('…toujours en cours, jamais recommencé', relu.json.data.status === 'running');
  check('…avec l’avancement déjà acquis',
    relu.json.data.steps.find((s) => s.id === 'server.preflight')?.status === 'ok');

  /** Et sans session, le flux n'est pas une porte ouverte. */
  const anonyme = await fetch(`${base}/api/deployment/runs/${runId}/stream?since=0`);
  check(`le flux reste fermé sans jeton (${anonyme.status})`, anonyme.status === 401);
  await anonyme.body?.cancel();

  await close();
}

await stopMemoryMongo();
finish();
