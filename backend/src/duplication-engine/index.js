/**
 * Point d'entrée public du MOTEUR DE DUPLICATION (UI-agnostic).
 *
 * Le moteur de duplication crée un NOUVEAU projet à partir du projet courant
 * (il n'existe pas de projet maître). Il prépare tout ce dont la copie a
 * besoin pour vivre — bases, secrets, configuration — puis s'arrête : il ne
 * déploie jamais lui-même. Le déploiement est la responsabilité du
 * `deployment-engine`, appelé ensuite, séparément.
 *
 * Dépendance assumée vers `deployment-engine` : la duplication réutilise ses
 * primitives locales (racine de projet, exécution de commandes). C'est la
 * seule direction autorisée — le moteur de déploiement n'importe jamais le
 * moteur de duplication.
 */
export {
  generateProjectSecrets,
  duplicateProject,
  validateDuplicationInput,
  rewriteEnv,
  quoteEnvValue,
  sanitizeFolderName,
  COPY_DENYLIST,
} from './duplication.js';
