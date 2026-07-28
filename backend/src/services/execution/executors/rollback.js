// EXÉCUTEUR — ROLLBACK.
//
// Le moteur de déploiement porte déjà toute la logique de rollback (Phase 2E,
// 26 checks) : vérification d'intégrité avant bascule, repointage atomique,
// relance du service, contrôle de santé, restauration automatique en cas
// d'échec. Cet exécuteur ne la réimplémente pas — il la pilote.
import { PHASE } from '../execution-log.service.js';
import { infrastructureReadiness, refuseRealExecution } from './_infrastructure.js';

export const id = 'rollback';

export function simulate({ parameters, record, log, services }) {
  const { releaseId } = parameters;
  log.info(PHASE.STEP, `Construction du plan de retour vers la release ${releaseId}.`);
  const plan = services.buildRollbackPlan({ releaseId });
  return {
    plan: plan.map((phase) => ({
      step: phase.step,
      description: phase.description,
      commandCount: phase.commands?.length ?? 0,
    })),
    summary: `Reviendrait ${record?.projectName} à la release ${releaseId}, avec vérification d’intégrité puis contrôle de santé.`,
  };
}

export async function execute({ action, parameters, log, credentials }) {
  const readiness = infrastructureReadiness({ credentials });
  if (!readiness.ok) refuseRealExecution({ action, log, readiness });
  log.info(PHASE.STEP, `Rollback réel vers ${parameters.releaseId}…`);
  throw new Error(
    'Le transport SSH du moteur de déploiement n’a pas encore été éprouvé en recette (33_VPS_ACCEPTANCE.md).',
  );
}

export default { id, simulate, execute };
