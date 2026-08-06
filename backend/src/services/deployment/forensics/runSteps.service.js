/**
 * PERSISTANCE DES ÉTAPES ET REPRISE DES RUNS ORPHELINS.
 *
 * ══ L'INVARIANT ═════════════════════════════════════════════════════════════
 *
 *   Toute étape passée à RUNNING finit par un état terminal.
 *
 * Il paraît évident ; il ne l'était pas. Les transitions ne voyageaient que
 * dans le flux NDJSON : si le navigateur se fermait ou si le backend
 * redémarrait, la dernière étape restait `running` pour toujours, et l'écran
 * affichait un chargement éternel sur une opération terminée depuis
 * longtemps. Constaté le 06/08 : un run figé sur `ssh.connect` pendant
 * 8 min 36 s, jusqu'à ce qu'un redémarrage le libère.
 *
 * ══ CE QUI CHANGE ═══════════════════════════════════════════════════════════
 *
 * Chaque transition est ÉCRITE en base, en plus d'être émise. Et au démarrage,
 * tout run resté `running` est repris : son étape active passe `interrupted`,
 * le run est clos, et la raison est journalisée. Un chargement éternel devient
 * impossible — pas par surveillance, par construction.
 */
import PanelDeploymentRun from '../../../models/PanelDeploymentRun.model.js';
import { EVENTS, LEVELS, SOURCES, journal } from './runJournal.service.js';

/** Le statut d'étape → l'évènement de journal correspondant. */
const EVENEMENT = Object.freeze({
  running: EVENTS.STEP_STARTED,
  ok: EVENTS.STEP_SUCCEEDED,
  warning: EVENTS.STEP_WARNING,
  error: EVENTS.STEP_FAILED,
  skipped: EVENTS.STEP_SKIPPED,
  interrupted: EVENTS.STEP_INTERRUPTED,
});

const NIVEAU = Object.freeze({
  running: LEVELS.INFO,
  ok: LEVELS.INFO,
  warning: LEVELS.WARNING,
  error: LEVELS.ERROR,
  skipped: LEVELS.DEBUG,
  interrupted: LEVELS.WARNING,
});

/**
 * ENREGISTRE une transition d'étape — en base ET au journal.
 *
 * Écriture par opérateurs atomiques : le pipeline, le transport et le
 * middleware HTTP écrivent en même temps. Un `save()` relirait le document
 * entier et perdrait les écritures concurrentes.
 */
export async function recordStep(runId, {
  stepId, label = null, status, publicMessage = null, technicalMessage = null,
  errorCode = null, durationMs = null, details = null,
}) {
  if (!runId || !stepId || !status) return null;
  const maintenant = new Date();

  try {
    // L'étape existe-t-elle déjà dans le tableau ? On met à jour, sinon on ajoute.
    const maj = await PanelDeploymentRun.updateOne(
      { runId, 'steps.id': stepId },
      {
        $set: {
          'steps.$.status': status,
          'steps.$.label': label ?? undefined,
          'steps.$.publicMessage': publicMessage,
          'steps.$.technicalMessage': technicalMessage,
          'steps.$.errorCode': errorCode,
          ...(status === 'running' ? { 'steps.$.startedAt': maintenant } : { 'steps.$.finishedAt': maintenant }),
          ...(durationMs !== null ? { 'steps.$.durationMs': durationMs } : {}),
          currentStepId: status === 'running' ? stepId : null,
        },
      },
    );

    if (maj.matchedCount === 0) {
      await PanelDeploymentRun.updateOne({ runId }, {
        $push: {
          steps: {
            id: stepId, label, status,
            startedAt: status === 'running' ? maintenant : null,
            finishedAt: status === 'running' ? null : maintenant,
            durationMs, publicMessage, technicalMessage, errorCode,
          },
        },
        $set: { currentStepId: status === 'running' ? stepId : null },
      });
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`[forensique] étape « ${stepId} » non persistée : ${err.message}`);
  }

  await journal(runId, {
    source: SOURCES.ENGINE,
    level: NIVEAU[status] ?? LEVELS.INFO,
    eventCode: EVENEMENT[status] ?? EVENTS.STEP_STARTED,
    stepId,
    message: publicMessage ?? label ?? stepId,
    errorCode,
    details: details ?? (durationMs !== null ? { durationMs } : null),
  });

  return { stepId, status };
}

/**
 * REPREND les runs laissés « en cours » par un process qui n'est plus là.
 *
 * ── POURQUOI AU DÉMARRAGE, ET PAS SUR MINUTERIE ─────────────────────────────
 * Un run `running` n'est orphelin que si le process qui l'exécutait a disparu.
 * Le seul instant où l'on en est certain est le démarrage d'un NOUVEAU
 * process : aucun run antérieur ne peut encore être en cours, puisque son
 * exécutant est mort. Une minuterie, elle, devrait deviner un délai — et
 * finirait par tuer un déploiement lent mais vivant.
 *
 * L'étape active est marquée `interrupted`, jamais `error` : elle n'a pas
 * échoué, elle a été coupée. Confondre les deux ferait chercher une cause
 * technique là où il n'y a qu'un redémarrage.
 */
export async function recoverOrphanRuns({ reason = 'process_restart' } = {}) {
  const orphelins = await PanelDeploymentRun.find({ status: 'running' })
    .select('runId targetId currentStepId steps startedAt operationType')
    .lean();

  const repris = [];
  for (const run of orphelins) {
    const enCours = (run.steps || []).filter((s) => s.status === 'running');
    const maintenant = new Date();

    for (const s of enCours) {
      await PanelDeploymentRun.updateOne(
        { runId: run.runId, 'steps.id': s.id },
        { $set: { 'steps.$.status': 'interrupted', 'steps.$.finishedAt': maintenant } },
      ).catch(() => {});
    }

    await PanelDeploymentRun.updateOne({ runId: run.runId }, {
      $set: {
        status: 'interrupted',
        finishedAt: maintenant,
        durationMs: run.startedAt ? maintenant - new Date(run.startedAt) : null,
        currentStepId: null,
        summary: 'Interrompu : le processus qui exécutait cette opération a été redémarré.',
      },
    }).catch(() => {});

    await journal(run.runId, {
      source: SOURCES.SYSTEM,
      level: LEVELS.WARNING,
      eventCode: EVENTS.RUN_INTERRUPTED_BY_PROCESS_RESTART,
      stepId: run.currentStepId ?? enCours[0]?.id ?? null,
      message: 'Le processus exécutant ce déploiement a été redémarré : le run est clos comme interrompu.',
      details: {
        reason,
        interruptedSteps: enCours.map((s) => s.id),
        newPid: process.pid,
        operationType: run.operationType,
      },
      pid: process.pid,
    });

    repris.push({ runId: run.runId, steps: enCours.map((s) => s.id) });
  }

  return { recovered: repris.length, runs: repris };
}

export default { recordStep, recoverOrphanRuns };
