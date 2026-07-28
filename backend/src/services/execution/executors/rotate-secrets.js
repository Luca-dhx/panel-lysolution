// EXÉCUTEUR — ROTATE_SECRETS.
//
// L'action la plus dangereuse du registre, et sa politique le reflète :
// risque CRITICAL, TEST uniquement, confirmation obligatoire, préparation
// minimale de 70 %.
//
// La simulation énonce explicitement les CONSÉQUENCES, parce qu'une rotation
// de clé de chiffrement n'est pas réversible : les données déjà chiffrées
// deviennent illisibles. Un opérateur doit lire cela AVANT de confirmer.
import { PHASE } from '../execution-log.service.js';
import { ExecutorUnavailableError } from './_infrastructure.js';

export const id = 'rotate-secrets';

/** Conséquences déclarées par secret — affichées AVANT toute confirmation. */
const CONSEQUENCES = Object.freeze({
  JWT_SECRET: 'Toutes les sessions en cours sont invalidées : les utilisateurs devront se reconnecter.',
  BRIDGE_ENCRYPTION_KEY: 'Les bridgeTokens chiffrés deviennent illisibles : TOUS les projets appairés devront être ré-appairés.',
  INTEGRATED_API_ENCRYPTION_KEY: 'Les credentials IntegratedAPI chiffrés deviennent illisibles : ils devront être ressaisis.',
});

export function simulate({ parameters, record, log }) {
  const secrets = parameters.secrets ?? [];
  log.warn(PHASE.STEP, `Rotation simulée de ${secrets.length} secret(s) — opération IRRÉVERSIBLE en exécution réelle.`);

  const consequences = secrets.map((secret) => ({
    secret,
    consequence: CONSEQUENCES[secret] ?? 'Conséquence inconnue : ce secret n’est pas au catalogue.',
  }));
  for (const item of consequences) log.warn(PHASE.STEP, `${item.secret} : ${item.consequence}`);

  return {
    plan: [
      { step: 'generate', description: 'Générer des secrets neufs (source cryptographique sûre)' },
      { step: 'write-env', description: 'Écrire le .env de la cible' },
      { step: 'restart', description: 'Redémarrer le service pour recharger la configuration' },
      { step: 'verify', description: 'Vérifier la santé après redémarrage' },
    ],
    consequences,
    // Aucune valeur de secret n'apparaît jamais, même en simulation.
    summary: `Régénérerait ${secrets.length} secret(s) sur ${record?.projectName}. Opération irréversible.`,
  };
}

export async function execute({ log }) {
  const message =
    'Exécution réelle impossible parce que la rotation de secrets exige un accès au .env de la cible '
    + 'et un redémarrage de service — capacités qui dépendent de la recette VPS, restée ouverte. '
    + 'Cette action est par ailleurs limitée à TEST par sa politique.';
  log.error(PHASE.RESULT, message);
  throw new ExecutorUnavailableError('EXEC_INFRASTRUCTURE_UNAVAILABLE', message, {
    documentation: 'docs/architecture/33_VPS_ACCEPTANCE.md',
  });
}

export default { id, simulate, execute };
