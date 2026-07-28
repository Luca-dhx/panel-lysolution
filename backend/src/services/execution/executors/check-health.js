// EXÉCUTEUR — CHECK_HEALTH.
//
// Contrat d'un exécuteur (voir 46_ACTION_REGISTRY.md) :
//   simulate(ctx) → { plan[], summary }        décrit sans agir
//   execute(ctx)  → { result, summary }        agit réellement
//
// `ctx` fournit { record, project, parameters, log, signal, client }.
// `client` est le SEUL moyen de parler à un projet : c'est le
// ProjectBridgeClient, injecté par le moteur. Un exécuteur ne l'instancie
// jamais lui-même — c'est ce qui garantit qu'aucun appel ne contourne le
// moteur.
import { PHASE } from '../execution-log.service.js';

export const id = 'check-health';

export function simulate({ record, log }) {
  const url = record?.runtime?.publicBackendUrl;
  log.info(PHASE.STEP, 'Simulation : aucun appel réseau ne sera effectué.');
  return {
    plan: [
      { step: 'connect', description: `Ouvrir une requête vers ${url}` },
      { step: 'health', description: 'Appeler GET /api/project-bridge/v1/health' },
      { step: 'record', description: 'Restituer l’état renvoyé, sans rien modifier' },
    ],
    summary: `Interrogerait la santé de ${record?.projectName} sur ${url}.`,
  };
}

export async function execute({ record, client, log }) {
  log.info(PHASE.STEP, `Interrogation de la santé de ${record.projectName}…`);
  const health = await client.getHealth();
  log.info(PHASE.STEP, 'Réponse reçue.', { status: health?.status ?? null });
  return {
    result: { health },
    summary: `Santé rapportée : ${health?.status ?? 'inconnue'}.`,
  };
}

export default { id, simulate, execute };
