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

/**
 * Âge maximal d'un battement de cœur pour tenir l'exécutant pour vivant.
 *
 * Le worker bat toutes les 5 s ; 90 s laisse passer un redémarrage de l'API,
 * une pause du planificateur ou une base momentanément lente sans conclure à
 * tort qu'il est mort. La valeur est celle qui sert déjà à `finalizeOrphanRuns`
 * — deux seuils différents pour la même question finiraient par se contredire.
 */
export const HEARTBEAT_TIMEOUT_MS = 90_000;

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
 * Une minuterie devrait deviner un délai, et finirait par tuer un déploiement
 * lent mais vivant.
 *
 * ── CE QUE CETTE FONCTION A LONGTEMPS SUPPOSÉ À TORT ────────────────────────
 * Elle traitait TOUT run « en cours » comme orphelin, au motif qu'un nouveau
 * process implique la mort de l'ancien. C'est faux ici : le déploiement du
 * Panel ne vit pas dans l'API, mais dans un worker DÉTACHÉ qui lui survit.
 * Redémarrer l'API — ce que le Panel fait en se déployant lui-même — faisait
 * donc déclarer « interrompu » un déploiement qui se poursuivait, quelques
 * millisecondes après avoir journalisé que le redémarrage était attendu et
 * confirmé. Le run réel `add86c82` s'est arrêté exactement là.
 *
 * ── LA PREUVE EXIGÉE MAINTENANT ─────────────────────────────────────────────
 * On ne clôt un run que si son exécutant est PROUVÉ mort, et la preuve est le
 * battement de cœur qu'il écrit toutes les 5 secondes. Sans preuve, on laisse
 * le run tel quel : un run vivant faussement clos est irrécupérable, alors
 * qu'un run mort laissé ouvert sera repris au démarrage suivant. L'erreur
 * qu'on refuse n'est pas la même des deux côtés, et c'est délibéré.
 *
 * L'étape active est marquée `interrupted`, jamais `error` : elle n'a pas
 * échoué, elle a été coupée.
 *
 * @param {object}  args
 * @param {string} [args.reason]        motif journalisé
 * @param {string} [args.runRepris]     run dont le marqueur vient d'être consommé
 * @param {number} [args.toleranceMs]   âge maximal d'un battement de cœur
 */
export async function recoverOrphanRuns({
  reason = 'process_restart', runRepris = null, toleranceMs = HEARTBEAT_TIMEOUT_MS,
} = {}) {
  const candidats = await PanelDeploymentRun.find({ status: 'running' })
    .select('runId targetId currentStepId steps startedAt operationType workerPid workerHeartbeatAt')
    .lean();

  const limite = Date.now() - toleranceMs;
  const vivant = (run) => {
    const battement = run.workerHeartbeatAt ? new Date(run.workerHeartbeatAt).getTime() : null;
    return Number.isFinite(battement) && battement !== null && battement >= limite;
  };

  const orphelins = [];
  const survivants = [];
  for (const run of candidats) (vivant(run) ? survivants : orphelins).push(run);

  /**
   * LE RUN QUI A SURVÉCU AU REDÉMARRAGE ATTENDU — on le DIT.
   *
   * Sans cette entrée, le journal montrait le redémarrage confirmé puis plus
   * rien jusqu'à la fin : impossible de distinguer « le worker continue » de
   * « personne ne reprend la main ». C'est l'évènement que le contrat interdit
   * de voir remplacé par une interruption.
   */
  for (const run of survivants) {
    await journal(run.runId, {
      source: SOURCES.SYSTEM,
      level: LEVELS.INFO,
      eventCode: EVENTS.RUN_RESUMED_AFTER_EXPECTED_RESTART,
      stepId: run.currentStepId ?? null,
      message: run.runId === runRepris
        ? 'Le redémarrage était attendu et le worker y a survécu : le déploiement se poursuit sans interruption.'
        : 'Ce déploiement est toujours exécuté par son worker : le redémarrage de l’API ne l’a pas interrompu.',
      details: {
        reason,
        marqueurConsomme: run.runId === runRepris,
        workerPid: run.workerPid ?? null,
        workerHeartbeatAt: run.workerHeartbeatAt ?? null,
        newPid: process.pid,
      },
      pid: process.pid,
    });
  }

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

  return {
    recovered: repris.length,
    runs: repris,
    // Ce qu'on a délibérément ÉPARGNÉ : sans ce compte, une reprise qui ne
    // ferme rien est indistinguable d'une reprise qui n'a rien trouvé.
    preserved: survivants.length,
    preservedRuns: survivants.map((r) => r.runId),
  };
}

export default { recordStep, recoverOrphanRuns };
