// PLANS D'EXÉCUTION — Phase 3C.
//
// La simulation doit dire ce qui SERAIT fait, pas une approximation
// rassurante. Ces plans sont donc DÉRIVÉS des moteurs eux-mêmes : les étapes
// viennent de `PIPELINE_STEPS` et de la procédure de rollback réelle, pas
// d'une liste recopiée à la main qui divergerait au premier changement.
//
// Si le moteur gagne une étape, le plan de simulation la montre le jour même.
import { PIPELINE_STEPS } from '../../deployment-engine/pipeline.js';
import { planMigration } from '../../deployment-engine/migrations/index.js';

/**
 * Description de chaque étape du pipeline. Les IDENTIFIANTS viennent du
 * moteur ; seules les phrases sont ici. Une étape non décrite reste visible
 * dans le plan (avec une description générique) plutôt que d'être masquée.
 */
const STEP_DESCRIPTIONS = Object.freeze({
  upload: 'Téléverser l’artefact construit dans une nouvelle release',
  dirs: 'Créer l’arborescence de la release sur la cible',
  nginx: 'Écrire et tester la configuration nginx du domaine',
  certbot: 'Obtenir ou renouveler le certificat TLS',
  reload: 'Recharger nginx sans coupure',
  pm2: 'Redémarrer le backend sous PM2',
  health: 'Contrôler la santé locale du backend',
  runtime_config: 'Publier la configuration runtime (URLs dérivées du domaine)',
  validate: 'Valider le déploiement de bout en bout depuis l’extérieur',
});

/** Étapes du rollback, dans l'ordre où `rollbackToRelease` les enregistre. */
const ROLLBACK_STEPS = Object.freeze([
  ['rollback.inspect', 'Lister les releases présentes et identifier l’active'],
  ['rollback.resolve', 'Résoudre la release cible'],
  ['rollback.verify', 'Vérifier l’intégrité de la release cible AVANT toute bascule'],
  ['rollback.activate', 'Repointer le lien « current » et redémarrer le backend'],
  ['rollback.health', 'Contrôler la santé après bascule'],
  ['rollback.restore', 'En cas d’échec : restaurer automatiquement la release précédente'],
]);

/** Plan de déploiement — la construction locale précède le pipeline distant. */
export function buildDeploymentPlan({ host, environment }) {
  return [
    { step: 'build', description: `Construire l’artefact pour ${host} en ${environment}`, commands: [] },
    ...PIPELINE_STEPS.map((step) => ({
      step,
      description: STEP_DESCRIPTIONS[step] ?? `Étape « ${step} » du pipeline de déploiement`,
      commands: [],
    })),
  ];
}

/** Plan de rollback. */
export function buildRollbackPlan({ releaseId }) {
  return ROLLBACK_STEPS.map(([step, description]) => ({
    step,
    description: step === 'rollback.resolve'
      ? `Résoudre la release cible ${releaseId}`
      : description,
    commands: [],
  }));
}

/** Plan de migration d'un moteur — délégué au catalogue du moteur. */
export function planEngineMigration({ fromVersion, toVersion, context = {} }) {
  return planMigration({ fromVersion, toVersion, context });
}

export { PIPELINE_STEPS };
export default { buildDeploymentPlan, buildRollbackPlan, planEngineMigration, PIPELINE_STEPS };
