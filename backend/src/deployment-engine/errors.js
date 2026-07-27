/**
 * Erreurs typées du moteur de déploiement.
 *
 * Un `DeploymentError` porte un `code` machine (stable, testable) et un
 * `step` optionnel (l'étape du pipeline où l'échec s'est produit). Le moteur
 * NE dépend d'aucune couche HTTP : la conversion en réponse API se fait dans
 * les routes. Aucun secret n'est jamais placé dans un message d'erreur.
 */
export class DeploymentError extends Error {
  /**
   * @param {string} code   Code machine stable (ex: 'PREFLIGHT_FAILED').
   * @param {string} message Message lisible (jamais de secret).
   * @param {object} [meta]  Contexte non sensible (step, détails structurés).
   */
  constructor(code, message, meta = {}) {
    super(message);
    this.name = 'DeploymentError';
    this.code = code;
    this.step = meta.step || null;
    this.details = meta.details || null;
  }
}

/** Échec bloquant : on refuse tout demi-déploiement (règle du cahier des charges). */
export class PreflightError extends DeploymentError {
  constructor(message, failedChecks = []) {
    super('PREFLIGHT_FAILED', message, { step: 'preflight', details: { failedChecks } });
    this.name = 'PreflightError';
    this.failedChecks = failedChecks;
  }
}

/** Validation d'entrée (URL invalide, nom de projet interdit, cible en double…). */
export class ValidationError extends DeploymentError {
  constructor(message, details = null) {
    super('VALIDATION_ERROR', message, { details });
    this.name = 'ValidationError';
  }
}

export default DeploymentError;
