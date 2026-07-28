// EXÉCUTEUR — UPDATE_BRIDGE.
//
// Porte le miroir de contrat d'un projet vers la version servie par le Panel.
// C'est une opération sur le DÉPÔT du projet, pas sur son runtime : elle
// suppose un accès au dépôt et une chaîne de tests verte côté projet.
import { PHASE } from '../execution-log.service.js';
import { ExecutorUnavailableError } from './_infrastructure.js';

export const id = 'update-bridge';

export function simulate({ parameters, record, log, services }) {
  const current = record?.runtime?.contractVersion ?? 'inconnue';
  const target = parameters.targetVersion ?? services.panelContractVersion;
  log.info(PHASE.STEP, `Comparaison des versions : projet ${current}, cible ${target}.`);
  return {
    plan: [
      { step: 'fetch-specs', description: 'Récupérer les specs OpenAPI ratifiées du projet de référence' },
      { step: 'copy-specs', description: 'Recopier les specs verbatim dans le dépôt du projet' },
      { step: 'update-mirror', description: `Porter le miroir exécutable en ${target}` },
      { step: 'run-tests', description: 'Exécuter la suite de conformité du projet' },
      { step: 'verify', description: 'Vérifier l’absence de dérive contractuelle' },
    ],
    summary: `Porterait le contrat de ${record?.projectName} de ${current} vers ${target}.`,
  };
}

export async function execute({ log }) {
  const message =
    'Exécution réelle impossible parce que le Panel n’a pas d’accès en écriture au dépôt du projet. '
    + 'Cette action suppose un canal d’intégration (accès Git, ou opération portée par le projet '
    + 'lui-même) qui n’existe pas encore dans l’écosystème.';
  log.error(PHASE.RESULT, message);
  throw new ExecutorUnavailableError('EXEC_REPOSITORY_ACCESS_UNAVAILABLE', message, {
    documentation: 'docs/architecture/32_ENGINE_RELEASE_PROCESS.md',
  });
}

export default { id, simulate, execute };
