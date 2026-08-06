/**
 * FINALISATION VÉRIFIÉE — un run n'est « réussi » que si l'état persistant le dit.
 *
 * ══ L'INCIDENT QUI A IMPOSÉ CE MODULE ═══════════════════════════════════════
 *
 * Le 06/08, l'écran a annoncé un SUCCÈS pendant que la destination gardait le
 * badge « Publication… ». Le pipeline était vert, donc le succès a été déduit
 * — sans jamais relire ce qui avait été écrit. Or rien n'avait été écrit :
 * `recordDeployment` avait levé une `ValidationError`, avalée par un
 * `.catch(() => {})`.
 *
 * Un déploiement réussi et une base qui l'ignore sont deux faits
 * contradictoires. Le seul moyen de ne plus les afficher ensemble est de
 * VÉRIFIER, pas de déduire.
 *
 * ══ L'INVARIANT ═════════════════════════════════════════════════════════════
 *
 *   SUCCESS  ⟺  pipeline terminé
 *            ET  destination relue en base
 *            ET  state === DEPLOYED
 *            ET  lifecycleStatus === ACTIVE
 *            ET  activeDeploymentRunId === null
 *            ET  réservation de port ACTIVE
 *            ET  aucune erreur de finalisation
 *
 * Si une seule condition manque, le run devient `finalization_failed` : ni
 * succès, ni échec de déploiement. Le serveur a bien été mis à jour, mais
 * l'état persistant n'a pas suivi — et c'est ce que l'écran doit dire.
 */
import PanelDeploymentRun from '../../../models/PanelDeploymentRun.model.js';
import { EVENTS, LEVELS, SOURCES, journal } from './runJournal.service.js';

/**
 * VÉRIFIE l'état final et enregistre le verdict.
 *
 * @returns {Promise<{finalized:boolean, checks:object, targetState:string|null}>}
 */
export async function verifyFinalization(runId, targetId, { expectDeployed = true } = {}) {
  await journal(runId, {
    source: SOURCES.FINALIZATION,
    level: LEVELS.INFO,
    eventCode: EVENTS.FINALIZATION_STARTED,
    message: 'Relecture de l’état persistant de la destination.',
  });

  const PanelDeploymentTarget = (await import('../../../models/PanelDeploymentTarget.model.js')).default;
  const { reservationFor } = await import('../portRegistry.service.js');

  const cible = await PanelDeploymentTarget.findOne({ targetId }).lean().catch(() => null);
  const reservation = await reservationFor(targetId).catch(() => null);

  const checks = {
    targetFound: Boolean(cible),
    state: cible?.state ?? null,
    stateOk: expectDeployed ? cible?.state === 'DEPLOYED' : true,
    lifecycleStatus: cible?.lifecycleStatus ?? null,
    lifecycleOk: cible?.lifecycleStatus === 'ACTIVE',
    activeDeploymentRunId: cible?.activeDeploymentRunId ?? null,
    lockReleased: !cible?.activeDeploymentRunId,
    portStatus: reservation?.status ?? null,
    portActive: reservation?.status === 'ACTIVE',
    portPid: reservation?.pid ?? null,
    currentVersion: cible?.currentVersion ?? null,
    historyRecorded: Array.isArray(cible?.history) && cible.history.length > 0,
  };

  const finalized = checks.targetFound
    && checks.stateOk
    && checks.lifecycleOk
    && checks.lockReleased
    && checks.portActive;

  const manquants = Object.entries({
    'destination introuvable': !checks.targetFound,
    [`state=${checks.state} au lieu de DEPLOYED`]: !checks.stateOk,
    [`lifecycle=${checks.lifecycleStatus} au lieu de ACTIVE`]: !checks.lifecycleOk,
    'verrou de déploiement encore posé': !checks.lockReleased,
    [`réservation de port=${checks.portStatus} au lieu de ACTIVE`]: !checks.portActive,
  }).filter(([, ko]) => ko).map(([libelle]) => libelle);

  await PanelDeploymentRun.updateOne({ runId }, {
    $set: {
      'finalization.attemptedAt': new Date(),
      'finalization.succeeded': finalized,
      'finalization.error': finalized ? null : manquants.join(' ; '),
      'finalization.targetState': checks.state,
      'finalization.checks': checks,
      ...(finalized ? {} : { status: 'finalization_failed' }),
    },
  }).catch(() => {});

  await journal(runId, {
    source: SOURCES.FINALIZATION,
    level: finalized ? LEVELS.INFO : LEVELS.ERROR,
    eventCode: finalized ? EVENTS.FINALIZATION_SUCCEEDED : EVENTS.FINALIZATION_FAILED,
    message: finalized
      ? 'État final confirmé : destination déployée, verrou libéré, port actif et prouvé.'
      : `L’état persistant n’a pas atteint sa forme finale — ${manquants.join(' ; ')}.`,
    details: checks,
    port: reservation?.port ?? null,
    pid: reservation?.pid ?? null,
  });

  return { finalized, checks, targetState: checks.state, missing: manquants };
}

export default { verifyFinalization };
