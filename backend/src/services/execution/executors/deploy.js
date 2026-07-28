// EXÉCUTEUR — DEPLOY.
//
// La simulation est RÉELLE : elle construit le plan complet via le moteur de
// déploiement embarqué (`deployment-engine`), avec le domaine et
// l'environnement demandés. Ce qui s'affiche est ce qui serait exécuté.
import { PHASE } from '../execution-log.service.js';
import { infrastructureReadiness, refuseRealExecution } from './_infrastructure.js';

export const id = 'deploy';

export function simulate({ parameters, record, log, services }) {
  const { host, environment } = parameters;
  log.info(PHASE.STEP, `Construction du plan de déploiement pour ${host} (${environment}).`);

  const plan = services.buildDeploymentPlan({ host, environment });
  log.info(PHASE.STEP, `${plan.length} étapes planifiées.`, { steps: plan.map((p) => p.step) });

  return {
    plan: plan.map((phase) => ({
      step: phase.step,
      description: phase.description,
      commandCount: phase.commands?.length ?? 0,
    })),
    summary: `Déploierait ${record?.projectName} sur ${host} en ${environment} — ${plan.length} étapes.`,
  };
}

export async function execute({ action, parameters, log, credentials }) {
  const readiness = infrastructureReadiness({ credentials });
  if (!readiness.ok) refuseRealExecution({ action, log, readiness });

  // Chemin réel : le moteur de déploiement prend le relais. Il est déjà
  // testé (Phases 2D/2E) ; c'est son transport SSH qui reste à éprouver.
  log.info(PHASE.STEP, `Déploiement réel vers ${parameters.host}…`);
  throw new Error(
    'Le transport SSH du moteur de déploiement n’a pas encore été éprouvé en recette (33_VPS_ACCEPTANCE.md).',
  );
}

export default { id, simulate, execute };
