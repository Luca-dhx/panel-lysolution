// Constantes partagées du Panel.

/**
 * Valeurs par défaut du document `SystemConfiguration.network` créé dans une
 * base fraîchement initialisée (duplication, premier démarrage).
 *
 * `null` et non une URL locale : « non configuré » doit rester distinguable
 * de « configuré sur une valeur locale » — c'est ce qui fait fonctionner la
 * règle de priorité du résolveur d'URL
 * (docs/architecture/24_ENVIRONMENT_AND_DOMAINS.md §3). Le déploiement
 * renseigne ces champs avec le domaine choisi.
 */
export const NETWORK_DEFAULTS = Object.freeze({
  backendUrl: null,
  frontendUrl: null,
});

export default { NETWORK_DEFAULTS };
