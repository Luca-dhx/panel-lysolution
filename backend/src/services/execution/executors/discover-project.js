// EXÉCUTEUR — DISCOVER_PROJECT.
//
// Interroge un projet appairé sur TOUT ce qu'il sait dire de lui-même, et
// range le résultat dans le registre du Panel.
//
//   /identity   → version, environnement, et (contrat >= 1.3.0) la
//                 CONVERGENCE : quelle configuration il a réellement appliquée
//   /manifest   → moteurs, modules, capacités, réseau, layout
//   /health     → état immédiat
//   /operations → catalogue d'opérations invocables
//
// C'est ce qui remplace la découverte « par déduction ». Le Panel ne devine
// rien : il demande, et il écrit ce qu'on lui répond.
//
// N'écrit QUE dans la base du Panel — comme `refresh-manifest`. Découvrir un
// projet ne le modifie pas.
import { PHASE } from '../execution-log.service.js';
import { outboundBaseUrl } from '../../registry/projectDestination.service.js';

export const id = 'discover-project';

export function simulate({ record, log }) {
  const url = outboundBaseUrl(record);
  log.info(PHASE.STEP, 'Simulation : aucun appel réseau ne sera effectué.');
  return {
    plan: [
      { step: 'identity', description: `Lire GET ${url}/api/project-bridge/v1/identity` },
      { step: 'manifest', description: 'Relire le Manifest officiel et le valider' },
      { step: 'health', description: 'Relever l’état de santé immédiat' },
      { step: 'operations', description: 'Lister les opérations invocables' },
      { step: 'store', description: 'Enregistrer le tout dans le registre du Panel' },
    ],
    summary: `Découvrirait ${record?.projectName} : identité, Manifest, santé, opérations.`,
  };
}

export async function execute({ record, client, log, services }) {
  const discovered = {};
  const failures = [];

  // Chaque lecture est indépendante : un projet qui ne sait pas encore servir
  // /operations doit quand même livrer son identité. Un échec partiel est une
  // découverte partielle, pas un échec de découverte.
  const read = async (name, fn) => {
    try {
      discovered[name] = await fn();
      log.info(PHASE.STEP, `${name} : lu.`);
    } catch (err) {
      failures.push(`${name} (${err.code ?? err.message})`);
      log.warn(PHASE.STEP, `${name} : illisible — ${err.message}`);
    }
  };

  await read('identity', () => client.getIdentity());
  await read('manifest', () => client.getManifest());
  await read('health', () => client.getHealth());
  await read('operations', () => client.listOperations());

  if (!discovered.identity && !discovered.manifest) {
    throw new Error(
      `Découverte impossible parce que le projet n’a répondu ni sur son identité ni sur son Manifest : ${failures.join(', ')}.`,
    );
  }

  // Le Manifest fait foi quand il est là — c'est le canal officiel.
  if (discovered.manifest) {
    const validation = services.validateManifest(discovered.manifest);
    if (!validation.valid) {
      log.warn(PHASE.STEP, `Manifest non conforme, non enregistré : ${validation.errors.map((e) => e.path).join(', ')}`);
    } else {
      await services.setManifestFromBridge(record, validation.manifest);
      log.info(PHASE.STEP, `Manifest ${validation.manifest.manifestVersion} enregistré.`);
    }
  }

  // CONVERGENCE (contrat >= 1.3.0) : ce que le projet a appliqué. C'est la
  // seule information que le Panel ne peut pas déduire de ce qu'il a émis.
  const applied = discovered.identity?.appliedConfiguration ?? null;
  if (applied) {
    await services.recordAppliedConfiguration(record, applied);
    log.info(PHASE.STEP,
      `Convergence : entreprise version ${applied.companyVersion ?? '—'}, ${applied.integratedApiCount ?? 0} API(s) intégrée(s).`);
  } else {
    log.info(PHASE.STEP, 'Le projet ne publie pas encore sa convergence (contrat antérieur à 1.3.0).');
  }

  return {
    result: {
      identity: discovered.identity ?? null,
      appliedConfiguration: applied,
      health: discovered.health ?? null,
      operations: discovered.operations?.operations?.map((o) => o.id) ?? [],
      manifestStored: Boolean(discovered.manifest),
      failures,
    },
    summary: failures.length === 0
      ? `${record.projectName} découvert intégralement.`
      : `${record.projectName} découvert partiellement — ${failures.length} lecture(s) en échec : ${failures.join(', ')}.`,
  };
}

export default { id, simulate, execute };
