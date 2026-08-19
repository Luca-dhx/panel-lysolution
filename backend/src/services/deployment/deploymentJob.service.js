/**
 * ══ LE TRAVAIL DE DÉPLOIEMENT — L'ORCHESTRATION, HORS DU POINT D'ENTRÉE ═════
 *
 * ── POURQUOI CE MODULE EXISTE ──────────────────────────────────────────────
 *
 * Toute cette séquence vivait dans `scripts/deploy-worker.js` : ouverture du
 * journal, exécution, drainage, conclusion, enregistrement sur la destination,
 * vérification finale. Un script de point d'entrée, qui lit son environnement
 * et termine par `process.exit()` — donc INÉPROUVABLE. La seule garde possible
 * était une expression régulière sur son texte, et une garde qui relit du texte
 * ne dit rien de ce que le texte FAIT.
 *
 * C'est exactement l'orchestration qu'il fallait pouvoir mettre en panne :
 * « le journal tombe entre l'artefact et la bascule », « la conclusion échoue
 * alors que la production est saine », « l'erreur métier ne doit pas être
 * effacée par la panne qui la suit ». Aucune de ces phrases ne s'éprouve sur un
 * fichier lu comme une chaîne de caractères.
 *
 * Le worker garde donc ce qui lui appartient — lire l'environnement, effacer le
 * secret, ouvrir sa base, poser les gardes du process, sortir — et la recette
 * emprunte ICI le chemin réel, sans copie et sans dérivation possible.
 *
 * ── LES DEUX COUTURES D'INJECTION, ET LEUR JUSTIFICATION ───────────────────
 *
 *   `recorderStore`  le magasin d'écritures durables. Une panne de persistance
 *                    ne se provoque pas en production, et un `if (test)` dans
 *                    le runtime rouvrirait précisément le trou qu'on ferme.
 *   `engine`         la même couture que `executeOperation` expose déjà, et
 *                    pour la même raison : le transport.
 *
 * Aucune des deux ne modifie une décision : la doctrine de durabilité, la
 * frontière de publication et la conclusion sont les mêmes objets, empruntés
 * par le même chemin.
 */
import { EVENTS, LEVELS, SOURCES, journal } from './forensics/runJournal.service.js';
import { verifyFinalization } from './forensics/finalization.service.js';
import { createDurableRecorder } from './runRecorder.service.js';
import { RECORDER_ERRORS, RecorderUnavailableError, redactRecorderCause } from './recorderErrors.js';
import * as runs from './deploymentRun.service.js';
import * as targets from './deploymentTarget.service.js';

/** Cadence du battement de cœur — c'est lui qui rend un run orphelin détectable. */
const HEARTBEAT_MS = 5_000;

/**
 * Exécute une opération de déploiement de bout en bout.
 *
 * @returns {Promise<{outcome:object, durability:object, finalized:boolean,
 *                    finalizationError:object|null, targetRecorded:boolean}>}
 */
export async function runDeploymentJob({
  runId, targetId, operationType,
  sshPassword = null, releaseId = null, user = null, apiPid = null, options = {},
  recorderStore = undefined,
  engine = null,
  logger = console,
}) {
  /**
   * ══ LE JOURNAL S'OUVRE AVANT QUE QUOI QUE CE SOIT NE BOUGE ════════════════
   *
   * `attachWorker` est la première écriture du processus qui déploie. Si elle
   * échoue, la base est déjà hors d'atteinte : continuer reviendrait à ouvrir
   * une session SSH et à muter un domaine sans plus rien pouvoir en écrire.
   * On s'arrête ici, où l'arrêt ne coûte rien — aucun DNS, aucune commande
   * distante, aucun octet transféré.
   */
  try {
    const { attached } = await runs.attachWorker(runId, process.pid);
    /**
     * UN RUN QUI N'EXISTE PAS N'EST PAS UN RUN SILENCIEUX — c'est un refus.
     *
     * `updateOne` sur un document absent ne lève pas. Sans ce contrôle, un
     * worker lancé pour un run jamais créé (ou effacé entre-temps) déployait
     * réellement, en écrivant chacune de ses étapes dans le vide.
     */
    if (!attached) throw new Error(`run ${runId} introuvable en base`);
  } catch (err) {
    const refus = new RecorderUnavailableError(
      'Déploiement refusé : le journal durable est inaccessible. '
      + 'Rien n’a été modifié — ni le domaine, ni le serveur.',
      { cause: redactRecorderCause(err) },
    );
    logger.error?.(`[durabilité] run ${runId} — ${refus.message} (${refus.cause})`);
    return {
      outcome: {
        status: 'error',
        summary: refus.message,
        error: { code: refus.code, message: refus.message },
      },
      durability: { complete: false, error: { code: RECORDER_ERRORS.UNAVAILABLE, reason: refus.cause } },
      finalized: false,
      finalizationError: { code: RECORDER_ERRORS.UNAVAILABLE, reason: refus.cause },
      targetRecorded: false,
      startedWork: false,
    };
  }

  await journal(runId, {
    source: SOURCES.WORKER,
    level: LEVELS.INFO,
    eventCode: 'WORKER_STARTED',
    message: `Worker détaché démarré (pid ${process.pid}).`,
    details: { pid: process.pid, operation: operationType },
    pid: process.pid,
  });

  /**
   * LE BATTEMENT — la SEULE écriture dont l'échec doit rester muet, et ce
   * silence EST le mécanisme : un battement qui ne se dépose plus est
   * exactement ce qui rend ce run détectable comme orphelin au démarrage
   * suivant. Le rattraper bruyamment ne réparerait rien ; l'attendre
   * retarderait le déploiement au rythme de la base.
   */
  const beat = setInterval(() => { void runs.heartbeat(runId).catch(() => {}); }, HEARTBEAT_MS);
  beat.unref?.();

  /**
   * LE JOURNAL DURABLE DU RUN — une file, deux régimes, une frontière.
   * Voir `runRecorder.service.js` : c'est lui qui porte la doctrine.
   */
  const recorder = createDurableRecorder(runId, recorderStore ? { store: recorderStore } : {});

  let outcome = { status: 'error', summary: null, error: null };

  try {
    const target = await targets.getTargetOrThrow(targetId);
    const { executeOperation } = await import('./deploymentExecutor.service.js');

    outcome = await executeOperation({
      operationType,
      target,
      sshPassword,
      releaseId,
      runId,
      options,
      apiPid,
      user,
      ...(engine ? { engine } : {}),
      onStep: (step) => recorder.recordStep(step),
      onLog: (message, level) => recorder.recordLog(message, level),
      /**
       * LA BARRIÈRE DE PUBLICATION — le moteur la pose, l'écrivain y répond.
       * C'est lui qui écrit, donc lui seul qui sait si l'écriture a eu lieu.
       */
      assertDurable: () => recorder.assertDurable(),
    });
  } catch (err) {
    // Une erreur ici est déjà un échec de déploiement : on la consigne au lieu
    // de laisser le processus mourir en silence, ce qui laisserait le run
    // « en cours » jusqu'au prochain démarrage du backend.
    recorder.recordLog(`Erreur inattendue : ${err.message}`, 'ERROR');
    outcome = {
      status: 'error',
      summary: `Déploiement interrompu par une erreur inattendue : ${err.message}`,
      error: { code: err.code ?? 'WORKER_UNEXPECTED', message: err.message },
    };
  } finally {
    clearInterval(beat);
  }

  /**
   * ON ATTEND QUE LA FILE SOIT VIDE AVANT DE CONCLURE.
   *
   * `finalizeRun` requalifie en erreur toute étape encore `running` : conclure
   * pendant qu'une écriture est en vol condamnerait une étape déjà terminée.
   */
  await recorder.drain();

  /**
   * ══ LA PERTE DE DURABILITÉ EST DITE, PAS TUE ══════════════════════════════
   *
   * Après publication, le déploiement a eu lieu ; sa chronologie, elle, est
   * trouée. Il est INTERDIT d'en conclure que rien n'a été publié — et il est
   * tout aussi interdit de se taire : on relirait plus tard une timeline
   * incomplète en la croyant fidèle.
   */
  const perteTardive = recorder.lateFailure();
  if (perteTardive) {
    recorder.recordLog(
      `Journal du déploiement incomplet : l'étape « ${perteTardive.stepId} » n'a pas pu être `
      + 'enregistrée (la version, elle, a bien été publiée). '
      + 'Vérifiez l’état réel du site avant toute relance.',
      'WARNING',
    );
    await recorder.drain();
  }

  const conclusion = await recorder.finalize(outcome);

  /**
   * ══ LA CONCLUSION A ÉCHOUÉ — ET LA PRODUCTION, ELLE, PEUT ÊTRE SAINE ══════
   *
   * Ce cas était avalé par un `catch {}` muet, sous le prétexte que « le run
   * sera vu comme orphelin au prochain démarrage ». C'est vrai, et insuffisant
   * pour deux raisons :
   *
   *   · l'enregistrement sur la DESTINATION était emporté dans le même bloc.
   *     Un déploiement parfaitement réussi laissait donc sa destination figée
   *     sur « Publication… », indéfiniment — et la seule chose qui n'avait pas
   *     marché était l'écriture d'un résumé ;
   *   · plus rien, nulle part, ne portait la cause. Ni la base (inaccessible,
   *     par hypothèse), ni la console.
   *
   * On écrit donc la trace là où elle survit à la panne — la sortie d'erreur du
   * processus — puis on POURSUIT : la destination et la vérification finale
   * sont d'autres documents, et rien ne dit qu'ils souffrent de la même panne.
   */
  if (!conclusion.finalized) {
    logger.error?.(
      `[durabilité] run ${runId} NON CONCLU : ${conclusion.error?.reason ?? 'cause inconnue'}. `
      + `publication=${recorder.published() ? 'FRANCHIE' : 'NON ATTEINTE'} `
      + `issue=${outcome.status} — réconciliation requise au prochain démarrage.`,
    );
  }

  /**
   * C'est CET appel qui fait passer la destination de « Publication… » à
   * « En ligne ». Il doit donc précéder toute vérification de cet état — et il
   * a lieu que la conclusion du run ait abouti ou non.
   */
  let targetRecorded = false;
  try {
    // `recordDeployment` rend `null` si la fiche a disparu : ce n'est pas une
    // erreur, mais ce n'est pas un enregistrement non plus. Le dire.
    const ecrit = await targets.recordDeployment(targetId, {
      operationType,
      ok: outcome.status === 'ok',
      version: outcome.version ?? null,
      releaseId: outcome.releaseId ?? null,
      user,
      durationMs: null,
      error: outcome.error,
      steps: outcome.steps ?? [],
    });
    targetRecorded = ecrit !== null;
  } catch (err) {
    // Pas de `catch {}` muet : c'est l'écriture dont l'échec silencieux avait
    // produit un écran de succès en face d'une destination figée.
    logger.error?.(
      `[durabilité] run ${runId} — état de la destination ${targetId} NON enregistré : `
      + `${redactRecorderCause(err)}.`,
    );
    await journal(runId, {
      source: SOURCES.FINALIZATION,
      level: LEVELS.ERROR,
      eventCode: EVENTS.FINALIZATION_FAILED,
      message: 'L’état de la destination n’a pas pu être enregistré.',
      errorCode: RECORDER_ERRORS.PERSISTENCE_LOST,
      details: { reason: redactRecorderCause(err) },
    });
  }

  /**
   * L'INVARIANT DU SUCCÈS — vérifié, jamais déduit, et vérifié APRÈS coup.
   *
   * Un pipeline vert ne suffit pas : on RELIT la destination et la réservation
   * de port. Vérifier AVANT d'écrire ne prouve rien — cela invente un échec,
   * et c'est ainsi qu'un déploiement réussi a été classé « finalisation non
   * vérifiée » le 06/08.
   */
  if (outcome?.status === 'ok') {
    await verifyFinalization(runId, targetId).catch((err) => {
      logger.error?.(`[durabilité] run ${runId} — vérification finale impossible : ${redactRecorderCause(err)}.`);
      return null;
    });
  }

  return {
    outcome,
    durability: conclusion.durability,
    finalized: conclusion.finalized,
    finalizationError: conclusion.error,
    targetRecorded,
    startedWork: true,
  };
}

export default { runDeploymentJob };
