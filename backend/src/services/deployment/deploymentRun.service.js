// RUNS DE DÉPLOIEMENT — Phase 4.
//
// Ce module est écrit par DEUX processus distincts :
//   · le backend du Panel, qui crée le run puis le LIT ;
//   · le worker détaché, qui l'exécute et l'ÉCRIT au fil de l'eau.
//
// Toutes les écritures sont donc des mises à jour ATOMIQUES ciblées
// (`updateOne` avec `$set`/`$push`), jamais un `save()` sur un document
// chargé en mémoire. Deux processus sauvegardant le même document se
// écraseraient mutuellement — et l'un des deux perdrait la trace de ce qu'il
// vient de faire.
import { randomUUID } from 'node:crypto';

import PanelDeploymentRun from '../../models/PanelDeploymentRun.model.js';
import ApiError from '../../utils/ApiError.js';
import { nowIso } from '../../bridge/bridgeContract.js';
import { CANONICAL_STEPS, PUBLICATION, publicationVerdict } from '../../deployment-engine/steps.js';
import { DEPROVISION_STEPS } from '../../deployment-engine/deprovision.js';
import { RecorderUnavailableError, redactRecorderCause } from './recorderErrors.js';

/** Un journal ne doit pas faire exploser la limite BSON de 16 Mo. */
/** Borne du journal reprenable (suffisant pour un déploiement complet). */
const MAX_EVENTS = 2000;
const MAX_LOG_ENTRIES = 2000;
const MAX_LOG_MESSAGE = 2000;

/**
 * Au-delà de ce silence, un run « en cours » est considéré ORPHELIN : son
 * processus est mort sans conclure. Le worker bat toutes les 5 s ; on laisse
 * une marge large, car un build local peut monopoliser la boucle
 * d'événements.
 */
export const HEARTBEAT_TIMEOUT_MS = 90_000;

/* -------------------------------------------------------------------------- */
/*  CYCLE DE VIE                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Crée un run, checklist DÉJÀ POSÉE.
 *
 * Les étapes canoniques sont inscrites en `pending` dès la création, avant
 * même que le worker ne démarre. L'interface affiche donc la liste complète
 * immédiatement, et l'opérateur voit d'emblée ce qui va se passer — plutôt
 * qu'une page vide qui se remplit peu à peu et laisse croire que rien ne
 * commence.
 *
 * La liste vient du MOTEUR (`deployment-engine/steps.js`), pas d'une copie :
 * si le pipeline gagne une étape, elle apparaît ici le jour même.
 */
export async function createRun({
  target, operationType, user = null, selfDeployment = false,
}) {
  const runId = randomUUID();
  // Le RETRAIT a sa propre checklist canonique, elle aussi tenue par le
  // moteur : l'opérateur doit voir d'emblée ce qui va être fait sur son
  // serveur — arrêt, port, routage, quarantaine, suppression, vérification.
  const catalogue = operationType === 'DEPLOYMENT'
    ? CANONICAL_STEPS
    : (operationType === 'DEPROVISION' ? DEPROVISION_STEPS : null);
  const checklist = catalogue
    ? catalogue.map((step, order) => ({
      id: step.id,
      label: step.label,
      order,
      status: 'pending',
      startedAt: null,
      finishedAt: null,
      durationMs: null,
      message: null,
      errorCode: null,
    }))
    : [];

  /**
   * ══ RIEN NE COMMENCE SANS JOURNAL ═══════════════════════════════════════
   *
   * C'est la PREMIÈRE écriture durable du déploiement, et la seule qui n'ait
   * aucune raison d'être tolérante : à ce stade, rien n'a encore été touché —
   * ni DNS, ni SSH, ni un octet sur le serveur. Un run qui n'existe pas en base
   * est un déploiement dont personne ne pourra jamais dire ce qu'il a fait ;
   * mieux vaut ne pas le commencer.
   *
   * L'erreur est TYPÉE et CAVIARDÉE : une `MongooseServerSelectionError` porte
   * l'URI de connexion dans son message, et cette route la rendrait telle
   * quelle à un navigateur.
   */
  try {
    await PanelDeploymentRun.create({
      runId,
      targetId: target.targetId,
      targetName: target.name,
      url: target.url,
      host: target.host,
      environment: target.environment,
      operationType,
      status: 'running',
      steps: checklist,
      startedAt: nowIso(),
      user,
      selfDeployment,
    });
  } catch (err) {
    throw new RecorderUnavailableError(
      'Opération refusée : le journal de déploiement n’a pas pu être ouvert. '
      + 'Rien n’a été modifié — ni le domaine, ni le serveur.',
      { cause: redactRecorderCause(err) },
    );
  }
  return runId;
}

/**
 * Le worker s'annonce : c'est lui qui tient désormais la plume.
 *
 * ── POURQUOI ELLE REND SI ELLE A TROUVÉ SON RUN ────────────────────────────
 *
 * Un `updateOne` qui ne trouve rien ne lève pas : il rend `matchedCount: 0`, en
 * silence. Un worker lancé pour un run qui n'existe pas — création refusée,
 * document effacé — déployait donc pour de bon, en écrivant chacune de ses
 * étapes dans le vide. Le fait est RENDU pour que l'appelant puisse s'arrêter
 * là où l'arrêt ne coûte encore rien.
 */
export async function attachWorker(runId, pid) {
  const res = await PanelDeploymentRun.updateOne(
    { runId },
    { $set: { workerPid: pid, workerHeartbeatAt: nowIso() } },
  );
  return { attached: (res?.matchedCount ?? res?.n ?? 0) > 0 };
}

export async function heartbeat(runId) {
  await PanelDeploymentRun.updateOne({ runId }, { $set: { workerHeartbeatAt: nowIso() } });
}

/**
 * Enregistre l'avancement d'une étape.
 *
 * Idempotent par `id` : le moteur émet plusieurs fois la même étape (running
 * puis ok), et la seconde émission doit MODIFIER la première, pas en ajouter
 * une seconde. Sans cela la checklist afficherait chaque étape en double.
 */
export async function recordStep(runId, { id, label, status, message = null, errorCode = null }) {
  const at = nowIso();
  // Le journal reçoit le changement AVANT la matérialisation : un client
  // reconnecté rejoue exactement la même suite d'états que le direct.
  await appendEvent(runId, 'step', { id, label, status, message, errorCode });
  const doc = await PanelDeploymentRun.findOne({ runId }).select('steps').lean();
  if (!doc) return;

  const index = doc.steps.findIndex((s) => s.id === id);
  if (index === -1) {
    await PanelDeploymentRun.updateOne({ runId }, {
      $push: {
        steps: {
          id,
          label: label ?? id,
          order: doc.steps.length,
          status: status ?? 'running',
          startedAt: at,
          finishedAt: status && status !== 'running' ? at : null,
          durationMs: null,
          message,
          errorCode,
        },
      },
      $set: { workerHeartbeatAt: at },
    });
    return;
  }

  const previous = doc.steps[index];
  const finished = status && status !== 'running';
  // La checklist est PRÉ-REMPLIE à la création du run, avec `startedAt: null`.
  // Cette branche ne posait jamais `startedAt` : `previous.startedAt` restait
  // donc nul pour TOUTE étape canonique, et la durée calculée plus bas valait
  // systématiquement `null`. Aucune étape d'un déploiement n'avait de durée.
  const startedAt = previous.startedAt ?? (status === 'running' ? at : null);
  await PanelDeploymentRun.updateOne({ runId }, {
    $set: {
      [`steps.${index}.status`]: status ?? previous.status,
      [`steps.${index}.label`]: label ?? previous.label,
      [`steps.${index}.message`]: message ?? previous.message,
      [`steps.${index}.errorCode`]: errorCode ?? previous.errorCode,
      ...(previous.startedAt ? {} : { [`steps.${index}.startedAt`]: startedAt ?? at }),
      ...(finished
        ? {
          [`steps.${index}.finishedAt`]: at,
          // Repli sur `at` : une étape franchie en une seule émission (`skipped`,
          // ou terminée avant d'être vue « running ») a une durée de 0, pas null.
          [`steps.${index}.durationMs`]: Date.parse(at) - Date.parse(startedAt ?? at),
        }
        : {}),
      workerHeartbeatAt: at,
    },
  });
}

/**
 * Ajoute un évènement au JOURNAL REPRENABLE, avec un numéro de séquence
 * monotone.
 *
 * L'attribution du numéro et l'ajout se font dans UNE SEULE opération Mongo
 * (pipeline d'agrégation) : `eventSeq` est lu, incrémenté et appliqué côté
 * serveur. Deux écritures simultanées — deux workers, deux étapes émises dans
 * la même milliseconde — ne peuvent donc pas recevoir le même numéro, là où un
 * `findOne` suivi d'un `updateOne` en donnerait deux identiques.
 */
export async function appendEvent(runId, kind, payload) {
  const at = nowIso();
  await PanelDeploymentRun.updateOne({ runId }, [
    { $set: { eventSeq: { $add: [{ $ifNull: ['$eventSeq', 0] }, 1] } } },
    {
      $set: {
        workerHeartbeatAt: at,
        events: {
          // Borné : un run très long ne doit pas faire enfler le document.
          // On conserve la FIN du journal — c'est elle que rejoue un client
          // qui se reconnecte.
          $slice: [
            { $concatArrays: [{ $ifNull: ['$events', []] }, [{ seq: '$eventSeq', at, kind, payload }]] },
            -MAX_EVENTS,
          ],
        },
      },
    },
  ]);
}

/** Ajoute une ligne de journal, bornée en taille et en nombre. */
export async function appendLog(runId, message, level = 'INFO') {
  const entry = {
    at: nowIso(),
    level,
    message: String(message).slice(0, MAX_LOG_MESSAGE),
  };
  await PanelDeploymentRun.updateOne({ runId }, {
    $push: { log: { $each: [entry], $slice: -MAX_LOG_ENTRIES } },
    $set: { workerHeartbeatAt: entry.at },
  });
  await appendEvent(runId, 'log', entry);
}

/**
 * Lit le journal À PARTIR d'un curseur — c'est la primitive de REPRISE.
 *
 * `since` est le dernier `seq` réellement reçu par le client. On rend
 * strictement les évènements postérieurs : aucun doublon, aucune perte.
 * `truncated` signale qu'un client trop en retard a dépassé la borne du
 * journal ; il doit alors recharger l'état complet plutôt que rejouer.
 */
export async function readEventsSince(runId, since = 0) {
  const doc = await PanelDeploymentRun.findOne({ runId })
    .select('events eventSeq status')
    .lean();
  if (!doc) return null;
  const events = (doc.events ?? []).filter((e) => e.seq > since);
  const oldest = (doc.events ?? [])[0]?.seq ?? 0;
  return {
    events,
    lastSeq: doc.eventSeq ?? 0,
    status: doc.status,
    truncated: since > 0 && oldest > since + 1,
  };
}

/**
 * Conclut un run. Après cet appel, plus rien ne doit l'écrire.
 *
 * Les étapes restées `pending` deviennent `skipped` : un déploiement qui
 * échoue à la configuration nginx n'a pas « en attente » ses étapes
 * suivantes — elles n'auront jamais lieu. Les laisser en attente
 * laisserait croire que quelque chose peut encore se produire.
 */
export async function finalizeRun(runId, {
  status, summary = null, error = null, version = null, releaseId = null, deployedUrl = null,
  structuredReport = null, markdownReport = null,
  journalComplete = true, journalDegradedAtStepId = null,
  /**
   * LA PANNE DE PERSISTANCE VOYAGE À CÔTÉ, JAMAIS À LA PLACE.
   *
   * `error` est l'erreur PRIMAIRE : ce qui a réellement fait échouer le
   * déploiement. Écraser `npm ci a échoué` par « le journal est tombé » ferait
   * chercher la panne dans la base alors qu'elle est sur le serveur.
   */
  persistenceError = null,
}) {
  const doc = await PanelDeploymentRun.findOne({ runId }).select('startedAt steps').lean();
  if (!doc) return null;
  const at = nowIso();

  const steps = (doc.steps ?? []).map((step) => (
    step.status === 'pending' || step.status === 'running'
      ? { ...step, status: step.status === 'running' ? 'error' : 'skipped', finishedAt: at }
      : step
  ));

  // La conclusion REQUALIFIE des étapes (pending → skipped, running → error).
  // Ces transitions doivent figurer au JOURNAL, sinon un client qui le rejoue
  // n'atteint jamais l'état final affiché : le journal mentirait par omission.
  for (const step of steps) {
    const before = (doc.steps ?? []).find((s) => s.id === step.id);
    if (before && before.status !== step.status) {
      await appendEvent(runId, 'step', {
        id: step.id, label: step.label, status: step.status, message: step.message, errorCode: step.errorCode,
      });
    }
  }
  await appendEvent(runId, 'status', { status, summary });

  /**
   * CE QUE LE PUBLIC A VU — déduit des ÉTAPES, jamais du verdict global.
   *
   * Un run en échec peut parfaitement avoir publié : c'est même le cas qui
   * compte. Lire `status` pour en décider reviendrait à réécrire l'histoire
   * dans le sens le plus rassurant.
   */
  const verdict = publicationVerdict(steps);

  await PanelDeploymentRun.updateOne({ runId }, {
    $set: {
      publication: {
        state: verdict.state,
        boundaryStepId: verdict.boundaryStepId,
        journalComplete: journalComplete !== false,
        degradedAtStepId: journalDegradedAtStepId,
      },
      status,
      summary,
      error,
      persistenceError,
      version,
      releaseId,
      deployedUrl,
      steps,
      structuredReport,
      markdownReport,
      finishedAt: at,
      durationMs: Date.parse(at) - Date.parse(doc.startedAt),
      workerPid: null,
    },
  });
  return PanelDeploymentRun.findOne({ runId }).lean();
}

/* -------------------------------------------------------------------------- */
/*  LECTURE                                                                   */
/* -------------------------------------------------------------------------- */

export async function getRunOrThrow(runId) {
  const doc = await PanelDeploymentRun.findOne({ runId }).lean();
  if (!doc) throw ApiError.notFound('PANEL_RUN_NOT_FOUND', 'Exécution de déploiement inconnue.');
  return describeRun(doc);
}

/**
 * Vue complète d'un run.
 *
 * Un run `running` dont le battement est trop ancien est présenté comme
 * INTERROMPU — sans modifier la base. La lecture ne doit pas avoir d'effet de
 * bord, et un worker simplement lent ne doit pas être condamné par une
 * consultation d'écran.
 */
export function describeRun(doc) {
  const stale = doc.status === 'running'
    && doc.workerHeartbeatAt
    && Date.now() - Date.parse(doc.workerHeartbeatAt) > HEARTBEAT_TIMEOUT_MS;

  return {
    /**
     * LE JOURNAL FORENSIQUE — ce qui rend un incident lisible sans terminal.
     *
     * Il part tel qu'il a été écrit : les entrées ont traversé le sanitizer au
     * moment de leur création, côté serveur. Le refiltrer ici laisserait croire
     * que la base contient des secrets — elle n'en contient pas, et c'est là
     * que la garantie doit être tenue.
     */
    journal: (doc.journal ?? []).map((e) => ({
      at: e.at, source: e.source, level: e.level, eventCode: e.eventCode,
      stepId: e.stepId ?? null, message: e.message ?? null, details: e.details ?? null,
      pid: e.pid ?? null, port: e.port ?? null, processName: e.processName ?? null,
      requestId: e.requestId ?? null, errorCode: e.errorCode ?? null, stack: e.stack ?? null,
    })),
    /** Le verdict de finalisation — pourquoi un succès n'en est pas un. */
    finalization: doc.finalization?.attemptedAt ? {
      attemptedAt: doc.finalization.attemptedAt,
      succeeded: doc.finalization.succeeded,
      error: doc.finalization.error ?? null,
      targetState: doc.finalization.targetState ?? null,
      checks: doc.finalization.checks ?? null,
    } : null,

    runId: doc.runId,
    targetId: doc.targetId,
    targetName: doc.targetName,
    url: doc.url,
    host: doc.host,
    environment: doc.environment,
    operationType: doc.operationType,
    status: stale ? 'interrupted' : doc.status,
    staleWorker: Boolean(stale),
    steps: doc.steps ?? [],
    log: doc.log ?? [],
    /**
     * CE QUE LE PUBLIC A VU, ET SI ON A SU L'ÉCRIRE — deux faits distincts que
     * l'écran doit pouvoir montrer ensemble.
     *
     * Un run peut être en ERREUR et avoir PUBLIÉ ; il peut avoir publié et
     * n'avoir pas su le journaliser. Ne rendre que `status` obligeait l'écran
     * à deviner, et le pire conseil possible dans ce cas — « relancez » —
     * était aussi le plus naturel.
     */
    publication: {
      state: doc.publication?.state ?? PUBLICATION.NOT_REACHED,
      boundaryStepId: doc.publication?.boundaryStepId ?? null,
      journalComplete: doc.publication?.journalComplete !== false,
      degradedAtStepId: doc.publication?.degradedAtStepId ?? null,
    },
    /** La panne de journal, à CÔTÉ de `error` — jamais à sa place. */
    persistenceError: doc.persistenceError ?? null,
    startedAt: doc.startedAt,
    finishedAt: doc.finishedAt,
    durationMs: doc.durationMs,
    version: doc.version,
    releaseId: doc.releaseId,
    deployedUrl: doc.deployedUrl,
    summary: stale && !doc.summary
      ? 'Le processus de déploiement ne donne plus signe de vie. Son issue est INCONNUE : vérifiez l’état réel du serveur avant de relancer.'
      : doc.summary,
    error: doc.error,
    user: doc.user,
    selfDeployment: doc.selfDeployment === true,
    workerHeartbeatAt: doc.workerHeartbeatAt,
    // Le rapport — produit par le moteur, masqué, prêt à être copié tel quel.
    structuredReport: doc.structuredReport ?? null,
    markdownReport: doc.markdownReport ?? null,
    // Avancement, pour la barre de progression. Calculé à la lecture : le
    // stocker obligerait à le recalculer à chaque écriture d'étape.
    progress: computeProgress(doc.steps ?? []),
  };
}

/** Part des étapes tranchées — `pending` et `running` ne comptent pas. */
function computeProgress(steps) {
  if (steps.length === 0) return { done: 0, total: 0, percent: 0 };
  const done = steps.filter((s) => ['ok', 'warning', 'error', 'skipped'].includes(s.status)).length;
  return { done, total: steps.length, percent: Math.round((done / steps.length) * 100) };
}

/** Résumé de ligne — pour les listes. */
export function summariseRun(doc) {
  const full = describeRun(doc);
  return {
    runId: full.runId,
    targetId: full.targetId,
    targetName: full.targetName,
    environment: full.environment,
    operationType: full.operationType,
    status: full.status,
    startedAt: full.startedAt,
    finishedAt: full.finishedAt,
    durationMs: full.durationMs,
    version: full.version,
    user: full.user,
    stepCount: full.steps.length,
    selfDeployment: full.selfDeployment,
  };
}

export async function listRuns({ targetId = null, limit = 30 } = {}) {
  const query = targetId ? { targetId } : {};
  const docs = await PanelDeploymentRun.find(query)
    .sort({ startedAt: -1 })
    .limit(Math.min(limit, 200))
    .lean();
  return docs.map(summariseRun);
}

/** Le run en cours sur une destination, s'il y en a un. */
export async function activeRunFor(targetId) {
  const doc = await PanelDeploymentRun.findOne({ targetId, status: 'running' })
    .sort({ startedAt: -1 })
    .lean();
  if (!doc) return null;
  const described = describeRun(doc);
  return described.status === 'running' ? described : null;
}

/**
 * FINALISE les runs orphelins — appelé au démarrage du backend.
 *
 * C'est exactement le cas de l'auto-déploiement réussi : le Panel a été
 * redémarré par sa propre mise en ligne. Si le worker a conclu avant, il n'y
 * a rien à faire. S'il est mort avec le processus, ce run doit cesser
 * d'apparaître « en cours » indéfiniment.
 *
 * On ne le déclare NI réussi NI échoué : `interrupted`. Trancher serait
 * inventer.
 */
export async function finalizeOrphanRuns() {
  const cutoff = new Date(Date.now() - HEARTBEAT_TIMEOUT_MS).toISOString();
  const orphans = await PanelDeploymentRun.find({
    status: 'running',
    $or: [{ workerHeartbeatAt: null }, { workerHeartbeatAt: { $lt: cutoff } }],
  }).select('runId steps').lean();

  for (const orphan of orphans) {
    /**
     * ══ « INCONNU » N'EST PAS « RIEN N'A EU LIEU » ══════════════════════════
     *
     * Un run interrompu peut parfaitement avoir publié : c'est même le cas qui
     * compte. Le processus meurt pendant l'installation des dépendances, la
     * bascule de release est FAITE depuis longtemps, et le site sert déjà la
     * nouvelle version.
     *
     * La reprise lisait ce cas comme les autres et n'écrivait qu'un statut.
     * On relit donc l'étape frontière — la seule chose qui puisse trancher — et
     * on inscrit son verdict. C'est cette information, et elle seule, qui
     * permettra à la réconciliation du prochain lot de savoir s'il faut aller
     * VÉRIFIER le serveur ou simplement relancer.
     *
     * Le journal est marqué INCOMPLET sans hésitation : un worker mort n'a pas
     * écrit sa fin, donc la chronologie s'arrête avant la vérité.
     */
    const verdict = publicationVerdict(orphan.steps ?? []);
    const publie = verdict.state === PUBLICATION.OCCURRED;
    const peutEtrePublie = verdict.state === PUBLICATION.POSSIBLE;

    await PanelDeploymentRun.updateOne({ runId: orphan.runId }, {
      $set: {
        status: 'interrupted',
        finishedAt: nowIso(),
        workerPid: null,
        'publication.state': verdict.state,
        'publication.boundaryStepId': verdict.boundaryStepId,
        'publication.journalComplete': false,
        'publication.degradedAtStepId': verdict.boundaryStepId,
        summary: 'Exécution interrompue : le processus n’a pas conclu. '
          + (publie
            ? 'La nouvelle version A ÉTÉ MISE EN LIGNE avant l’interruption — '
              + 'le site la sert probablement déjà. Vérifiez son état réel AVANT de relancer : '
              + 'relancer sans vérifier redéploierait par-dessus une version en service.'
            : peutEtrePublie
              ? 'La mise en ligne avait COMMENCÉ et son issue est inconnue. '
                + 'Vérifiez l’état réel du serveur avant de relancer.'
              : 'La mise en ligne n’avait pas commencé : le site sert toujours sa version précédente.'),
      },
    });
  }
  return orphans.length;
}

/**
 * ── OÙ EST PASSÉE LA FILE D'ÉCRITURES ──────────────────────────────────────
 *
 * Elle vivait ici, sous le nom `createStepJournal`. Elle a rejoint
 * `runRecorder.service.js` avec ce qui lui manquait : la mémoire de ses échecs,
 * les deux régimes séparés par la frontière de publication, la conclusion, et
 * un contrat éprouvable seul. Ce module reste ce qu'il doit être — les
 * PRIMITIVES d'écriture du run — et ne décide plus de doctrine.
 */

export default {
  createRun, attachWorker, heartbeat, recordStep, appendLog, appendEvent, readEventsSince, finalizeRun,
  getRunOrThrow, describeRun, summariseRun, listRuns, activeRunFor, finalizeOrphanRuns,
  HEARTBEAT_TIMEOUT_MS,
};
