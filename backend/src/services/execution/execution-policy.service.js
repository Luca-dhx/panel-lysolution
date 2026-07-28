// MOTEUR DE POLITIQUES — Phase 3C.
//
// C'est le gardien : aucune exécution ne démarre sans avoir passé toutes les
// politiques déclarées par son action. Le moteur ne connaît AUCUNE action en
// particulier — il lit le descripteur et applique.
//
// ── LA RÈGLE D'EXPLICATION ──────────────────────────────────────────────────
// Jamais « Action refusée. »
// Toujours « Action refusée parce que… », avec le fait constaté.
//
// Chaque refus porte un code stable, un message qui nomme la cause, et la
// valeur observée. C'est la même exigence qu'en Phase 3B, appliquée au
// pilotage.
//
// Service PUR : aucune E/S. Il reçoit un contexte déjà chargé.

export const RISK = Object.freeze({
  NONE: 'NONE',
  LOW: 'LOW',
  MEDIUM: 'MEDIUM',
  HIGH: 'HIGH',
  CRITICAL: 'CRITICAL',
});

export const RISK_ORDER = Object.freeze([RISK.NONE, RISK.LOW, RISK.MEDIUM, RISK.HIGH, RISK.CRITICAL]);

/** Codes de refus — stables, réutilisables par l'interface et les tests. */
export const DENIAL = Object.freeze({
  UNKNOWN_ACTION: 'EXEC_UNKNOWN_ACTION',
  PARAMETERS_INVALID: 'EXEC_PARAMETERS_INVALID',
  ENVIRONMENT_FORBIDDEN: 'EXEC_ENVIRONMENT_FORBIDDEN',
  PREREQUISITE_UNMET: 'EXEC_PREREQUISITE_UNMET',
  READINESS_TOO_LOW: 'EXEC_READINESS_TOO_LOW',
  BLOCKING_DIAGNOSTIC: 'EXEC_BLOCKING_DIAGNOSTIC',
  COMPATIBILITY_BLOCKING: 'EXEC_COMPATIBILITY_BLOCKING',
  EXCLUSIVITY_CONFLICT: 'EXEC_EXCLUSIVITY_CONFLICT',
  PROJECT_UNKNOWN: 'EXEC_PROJECT_UNKNOWN',
});

const deny = (code, message, facts = {}) => ({ ok: false, code, message, facts });
const allow = (message, facts = {}) => ({ ok: true, message, facts });

/**
 * ÉVALUE toutes les politiques d'une action contre un contexte.
 *
 * @param {object} action     descripteur du registre
 * @param {object} context    { record, project, health, diagnosis, parameters,
 *                              activeExecutions, mode, now }
 * @returns {{ ok, checks[], denials[], summary }}
 */
export function evaluatePolicy(action, context = {}) {
  const checks = [];
  const policy = action?.policy ?? {};

  // — 1. L'action existe ---------------------------------------------------
  if (!action) {
    const denial = deny(DENIAL.UNKNOWN_ACTION, 'Action refusée parce qu’elle n’existe pas dans le registre.');
    return { ok: false, checks: [{ id: 'action', label: 'Action connue', ...denial }], denials: [denial], summary: denial.message };
  }
  checks.push({ id: 'action', label: 'Action connue', ...allow(`Action « ${action.label} » trouvée au registre.`) });

  // — 2. Le projet existe --------------------------------------------------
  if (action.target === 'PROJECT' && !context.record) {
    checks.push({
      id: 'project',
      label: 'Projet cible',
      ...deny(DENIAL.PROJECT_UNKNOWN, 'Action refusée parce qu’aucun projet cible n’a été fourni.'),
    });
  } else {
    checks.push({
      id: 'project',
      label: 'Projet cible',
      ...allow(action.target === 'PROJECT'
        ? `Projet « ${context.record.projectName} » identifié.`
        : 'Action portant sur le Panel lui-même.'),
    });
  }

  // — 3. Environnement autorisé -------------------------------------------
  const environment = context.project?.environment ?? context.record?.runtime?.environment ?? null;
  const allowedEnvs = policy.allowedEnvironments ?? [];
  if (!environment) {
    checks.push({
      id: 'environment',
      label: 'Environnement',
      ...deny(DENIAL.ENVIRONMENT_FORBIDDEN,
        'Action refusée parce que l’environnement du projet est inconnu : impossible de vérifier qu’elle y est autorisée.',
        { allowed: allowedEnvs }),
    });
  } else if (!allowedEnvs.includes(environment)) {
    checks.push({
      id: 'environment',
      label: 'Environnement',
      ...deny(DENIAL.ENVIRONMENT_FORBIDDEN,
        `Action refusée parce qu’elle n’est autorisée qu’en ${allowedEnvs.join(' ou ')}, et que ce projet est en ${environment}.`,
        { environment, allowed: allowedEnvs }),
    });
  } else {
    checks.push({
      id: 'environment',
      label: 'Environnement',
      ...allow(`Autorisée en ${environment}.`, { environment }),
    });
  }

  // — 4. Prérequis ---------------------------------------------------------
  for (const prerequisite of policy.prerequisites ?? []) {
    let result;
    try {
      result = prerequisite.check(context);
    } catch (err) {
      result = { ok: false, reason: `Prérequis non évaluable : ${err.message}` };
    }
    checks.push({
      id: `prerequisite:${prerequisite.id}`,
      label: prerequisite.label,
      ...(result.ok
        ? allow(result.reason ?? 'Satisfait.')
        : deny(DENIAL.PREREQUISITE_UNMET,
          `Action refusée parce que le prérequis « ${prerequisite.label} » n’est pas satisfait : ${result.reason}`,
          { prerequisite: prerequisite.id })),
    });
  }

  // — 5. Préparation minimale ---------------------------------------------
  if (policy.requiredReadiness !== null && policy.requiredReadiness !== undefined) {
    const score = context.diagnosis?.readiness?.score;
    if (score === undefined) {
      checks.push({
        id: 'readiness',
        label: 'Préparation',
        ...deny(DENIAL.READINESS_TOO_LOW,
          'Action refusée parce que la préparation du projet n’a pas pu être évaluée.',
          { required: policy.requiredReadiness }),
      });
    } else if (score < policy.requiredReadiness) {
      checks.push({
        id: 'readiness',
        label: 'Préparation',
        ...deny(DENIAL.READINESS_TOO_LOW,
          `Action refusée parce que la préparation du projet est de ${score} %, en dessous du minimum de ${policy.requiredReadiness} % exigé par cette action.`,
          { score, required: policy.requiredReadiness }),
      });
    } else {
      checks.push({
        id: 'readiness',
        label: 'Préparation',
        ...allow(`Préparation de ${score} %, au-dessus du minimum de ${policy.requiredReadiness} %.`, { score }),
      });
    }
  }

  // — 6. Compatibilité bloquante ------------------------------------------
  if (context.diagnosis?.compatibility?.blocking) {
    checks.push({
      id: 'compatibility',
      label: 'Compatibilité',
      ...deny(DENIAL.COMPATIBILITY_BLOCKING,
        `Action refusée parce que le projet présente une incompatibilité bloquante : ${context.diagnosis.compatibility.reason}`,
        { verdict: context.diagnosis.compatibility.verdict }),
    });
  } else if (context.diagnosis?.compatibility) {
    checks.push({
      id: 'compatibility',
      label: 'Compatibilité',
      ...allow(context.diagnosis.compatibility.reason,
        { verdict: context.diagnosis.compatibility.verdict }),
    });
  }

  // — 7. Diagnostics interdisant l'action ---------------------------------
  const blocking = policy.blockOnDiagnostics ?? [];
  if (blocking.length > 0) {
    const present = (context.diagnosis?.diagnostics ?? []).filter((d) => blocking.includes(d.ruleId));
    if (present.length > 0) {
      checks.push({
        id: 'diagnostics',
        label: 'Diagnostics bloquants',
        ...deny(DENIAL.BLOCKING_DIAGNOSTIC,
          `Action refusée parce que ${present.length} diagnostic(s) l’interdisent : ${present.map((d) => `${d.title} (${d.justification})`).join(' · ')}`,
          { diagnostics: present.map((d) => d.ruleId) }),
      });
    } else {
      checks.push({
        id: 'diagnostics',
        label: 'Diagnostics bloquants',
        ...allow('Aucun diagnostic interdisant cette action.'),
      });
    }
  }

  // — 8. Exclusivité -------------------------------------------------------
  if (policy.exclusive) {
    const scope = policy.exclusivityScope ?? 'PROJECT';
    const conflicting = (context.activeExecutions ?? []).filter((exec) => {
      if (exec.id === context.executionId) return false;
      if (scope === 'GLOBAL') return true;
      return exec.projectId === context.record?.projectId;
    });
    if (conflicting.length > 0) {
      const other = conflicting[0];
      checks.push({
        id: 'exclusivity',
        label: 'Exclusivité',
        ...deny(DENIAL.EXCLUSIVITY_CONFLICT,
          `Action refusée parce qu’une autre exécution est déjà en cours sur cette cible : « ${other.type} » (${other.state}, démarrée le ${other.createdAt}).`,
          { conflictingId: other.id, conflictingType: other.type, scope }),
      });
    } else {
      checks.push({
        id: 'exclusivity',
        label: 'Exclusivité',
        ...allow(`Aucune exécution concurrente sur la portée ${scope}.`),
      });
    }
  }

  const denials = checks.filter((c) => !c.ok);
  return {
    ok: denials.length === 0,
    checks,
    denials,
    // Le résumé énonce TOUTES les causes, pas seulement la première : un
    // opérateur qui corrige un point ne doit pas découvrir le suivant après.
    summary: denials.length === 0
      ? `Toutes les politiques de « ${action.label} » sont satisfaites.`
      : denials.map((d) => d.message).join(' '),
  };
}

/** L'action exige-t-elle une confirmation, et combien ? */
export function confirmationRequirement(action) {
  const policy = action?.policy ?? {};
  return {
    required: policy.requiresConfirmation === true,
    count: policy.confirmationsRequired ?? 0,
    risk: policy.risk ?? RISK.NONE,
  };
}

/** Comparaison de niveaux de risque. */
export function isRiskier(a, b) {
  return RISK_ORDER.indexOf(a) > RISK_ORDER.indexOf(b);
}

export default { RISK, RISK_ORDER, DENIAL, evaluatePolicy, confirmationRequirement, isRiskier };
