// EXÉCUTEUR — UPDATE_DEPLOYMENT_ENGINE et UPDATE_DUPLICATION_ENGINE.
//
// Un SEUL exécuteur sert les deux actions : elles ne diffèrent que par leur
// paramètre `engine`. C'est une illustration directe du contrat
// d'extensibilité — deux descripteurs, un exécuteur, zéro ligne de cœur.
//
// Le portage suit la procédure documentée en 32 : copier le cœur, jamais
// `config/`, exécuter le plan de migration, vérifier l'absence de dérive.
import { PHASE } from '../execution-log.service.js';
import { ExecutorUnavailableError } from './_infrastructure.js';

export const id = 'update-engine';

export function simulate({ action, parameters, record, log, services }) {
  // Le moteur concerné est déduit du DESCRIPTEUR appelant : aucune logique
  // spécifique à une action n'est codée en dur ici.
  const engine = parameters.engine
    ?? action.parameters?.engine?.values?.[0]
    ?? 'deployment';
  const current = record?.runtime?.engines?.[engine] ?? 'inconnue';
  const target = parameters.targetVersion ?? services.panelEngineVersions?.[engine] ?? 'standard';

  log.info(PHASE.STEP, `Moteur « ${engine} » : version projet ${current}, cible ${target}.`);
  const migrations = services.planEngineMigration
    ? services.planEngineMigration({ fromVersion: current, toVersion: target })
    : { pending: [], migrations: [] };
  log.info(PHASE.STEP, `${migrations.pending?.length ?? 0} migration(s) en attente.`);

  return {
    plan: [
      { step: 'copy-core', description: 'Copier le cœur du moteur de référence (jamais config/)' },
      { step: 'run-migrations', description: `Exécuter les migrations ${current} → ${target}` },
      { step: 'manual-steps', description: 'Traiter les étapes manuelles signalées par le rapport' },
      { step: 'drift-check', description: 'Vérifier l’absence de dérive du cœur' },
      { step: 'run-tests', description: 'Exécuter la suite du projet' },
    ],
    migrations: migrations.migrations ?? [],
    summary: `Porterait le moteur « ${engine} » de ${record?.projectName} de ${current} vers ${target}.`,
  };
}

export async function execute({ log }) {
  const message =
    'Exécution réelle impossible parce que le Panel n’a pas d’accès en écriture au dépôt du projet. '
    + 'Le portage d’un moteur modifie des fichiers versionnés : il relève d’un canal d’intégration '
    + 'qui n’existe pas encore dans l’écosystème.';
  log.error(PHASE.RESULT, message);
  throw new ExecutorUnavailableError('EXEC_REPOSITORY_ACCESS_UNAVAILABLE', message, {
    documentation: 'docs/architecture/31_ENGINE_MIGRATIONS.md',
  });
}

export default { id, simulate, execute };
