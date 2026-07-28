// SOCLE COMMUN aux exécuteurs qui pilotent une INFRASTRUCTURE distante
// (déploiement, rollback, portage de moteur, rotation de secrets).
//
// ── POSITION HONNÊTE DE LA PHASE 3C ─────────────────────────────────────────
// Ces actions savent toutes SIMULER : elles produisent un plan réel, calculé
// par le moteur de déploiement embarqué. C'est vérifiable et testé.
//
// Leur EXÉCUTION réelle exige deux choses que le Panel ne détient pas encore :
//   1. des identifiants SSH pour la cible (jamais stockés par le Panel) ;
//   2. une recette VPS validée (ouverte depuis la Phase 2E).
//
// Plutôt que de laisser croire à une capacité qui n'existe pas, ces
// exécuteurs REFUSENT explicitement l'exécution réelle en nommant ce qui
// manque. Le jour où la recette est faite et où un coffre d'identifiants
// existe, seul ce fichier change — ni le moteur, ni le registre.
import { PHASE } from '../execution-log.service.js';

/** Erreur d'exécution portant un code stable et une cause nommée. */
export class ExecutorUnavailableError extends Error {
  constructor(code, message, details = null) {
    super(message);
    this.name = 'ExecutorUnavailableError';
    this.code = code;
    this.details = details;
  }
}

/**
 * Prérequis d'infrastructure — vérifiés au moment de l'exécution réelle.
 * @returns {{ ok: boolean, missing: string[], reason: string }}
 */
export function infrastructureReadiness({ credentials } = {}) {
  const missing = [];
  if (!credentials?.sshHost) missing.push('adresse SSH du serveur cible');
  if (!credentials?.sshUser) missing.push('utilisateur SSH');
  if (!credentials?.sshPassword) missing.push('secret d’authentification SSH');
  return {
    ok: missing.length === 0,
    missing,
    reason: missing.length === 0
      ? 'Identifiants d’infrastructure disponibles.'
      : `Identifiants d’infrastructure incomplets : ${missing.join(', ')}.`,
  };
}

/**
 * Refus d'exécution réelle, formulé selon la règle de la phase :
 * jamais « impossible », toujours « impossible parce que… ».
 */
export function refuseRealExecution({ action, log, readiness }) {
  const message =
    `Exécution réelle impossible parce que ${readiness.reason} `
    + 'Le Panel ne conserve aucun identifiant d’infrastructure : ils doivent lui être '
    + 'fournis pour la durée de l’opération. La recette VPS (33_VPS_ACCEPTANCE.md) '
    + 'reste par ailleurs ouverte — aucune exécution réelle ne devrait avoir lieu avant.';
  log.error(PHASE.RESULT, message, { action: action?.type ?? null, missing: readiness.missing });
  throw new ExecutorUnavailableError('EXEC_INFRASTRUCTURE_UNAVAILABLE', message, {
    missing: readiness.missing,
    documentation: 'docs/architecture/33_VPS_ACCEPTANCE.md',
  });
}

export default { ExecutorUnavailableError, infrastructureReadiness, refuseRealExecution };
