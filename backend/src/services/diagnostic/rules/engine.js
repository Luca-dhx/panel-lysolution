// MOTEUR DE RÈGLES — le cœur de la Phase 3B.
//
// Principe : toute la connaissance du Panel sur « ce qui va mal et pourquoi »
// vit dans UN catalogue déclaratif (`catalog.js`). Ce fichier ne contient que
// la mécanique d'évaluation — il ne sait rien du métier.
//
// Conséquence recherchée : ajouter un diagnostic = ajouter une entrée au
// catalogue. Jamais un `if` dispersé dans un service, jamais une chaîne de
// caractères codée en dur dans une page.
//
// PURETÉ TOTALE : aucune E/S, aucun accès réseau, aucune écriture, aucune
// horloge implicite (`now` est toujours injecté). Deux évaluations du même
// contexte produisent exactement le même résultat.

/** Gravités, de la plus faible à la plus forte. */
export const SEVERITY = Object.freeze({
  INFO: 'INFO',
  LOW: 'LOW',
  MEDIUM: 'MEDIUM',
  HIGH: 'HIGH',
  CRITICAL: 'CRITICAL',
});

export const SEVERITY_ORDER = Object.freeze([
  SEVERITY.INFO, SEVERITY.LOW, SEVERITY.MEDIUM, SEVERITY.HIGH, SEVERITY.CRITICAL,
]);

/** Poids numérique d'une gravité — sert au tri et au calcul de priorité. */
export const SEVERITY_WEIGHT = Object.freeze({
  [SEVERITY.INFO]: 0,
  [SEVERITY.LOW]: 1,
  [SEVERITY.MEDIUM]: 3,
  [SEVERITY.HIGH]: 7,
  [SEVERITY.CRITICAL]: 12,
});

/** Catégories de diagnostic — catalogue fermé, additif. */
export const CATEGORY = Object.freeze({
  CONNECTIVITY: 'CONNECTIVITY',
  COMPATIBILITY: 'COMPATIBILITY',
  SECURITY: 'SECURITY',
  CONFIGURATION: 'CONFIGURATION',
  OBSERVABILITY: 'OBSERVABILITY',
  LIFECYCLE: 'LIFECYCLE',
});

/** Niveaux de priorité opérationnelle (LOT 7). */
export const PRIORITY = Object.freeze({
  WATCH: 'WATCH',       // à surveiller
  FIX: 'FIX',           // à corriger
  URGENT: 'URGENT',     // urgent
  CRITICAL: 'CRITICAL', // critique
});

export const PRIORITY_ORDER = Object.freeze([
  PRIORITY.WATCH, PRIORITY.FIX, PRIORITY.URGENT, PRIORITY.CRITICAL,
]);

export function worstSeverity(severities) {
  return severities.reduce(
    (worst, s) => (SEVERITY_ORDER.indexOf(s) > SEVERITY_ORDER.indexOf(worst) ? s : worst),
    SEVERITY.INFO,
  );
}

export function highestPriority(priorities) {
  return priorities.reduce(
    (top, p) => (PRIORITY_ORDER.indexOf(p) > PRIORITY_ORDER.indexOf(top) ? p : top),
    PRIORITY.WATCH,
  );
}

/**
 * FORME D'UNE RÈGLE — contrat que toute entrée du catalogue doit respecter.
 *
 * {
 *   id            identifiant stable, jamais réutilisé après suppression
 *   category      CATEGORY.*
 *   component     composant concerné ('bridge', 'ssl', 'deploymentEngine'…)
 *   severity      SEVERITY.* — gravité NOMINALE
 *   title         libellé court, lisible
 *   description   ce que la règle constate, en une phrase
 *   impact        conséquence concrète si rien n'est fait
 *   when(ctx)     → false | true | { severity?, facts? }
 *                 `false` = la règle ne s'applique pas ; un objet permet
 *                 d'ajuster la gravité selon la situation
 *   explain(ctx, facts) → chaîne : POURQUOI ce diagnostic existe, avec les
 *                 valeurs constatées. C'est l'exigence « aucun diagnostic
 *                 magique ».
 *   recommendation(ctx, facts) → { action, benefit, risk, prerequisites[],
 *                 futureAction } — jamais exécutée dans cette phase.
 *   readiness     { criterion, blocks } — lien avec le score de préparation
 * }
 */

const REQUIRED_RULE_FIELDS = ['id', 'category', 'component', 'severity', 'title', 'description', 'impact', 'when', 'explain'];

/** Valide une règle — un catalogue mal formé est un défaut, pas une surprise. */
export function validateRule(rule) {
  const errors = [];
  for (const field of REQUIRED_RULE_FIELDS) {
    if (rule?.[field] === undefined || rule?.[field] === null) errors.push(`champ manquant : ${field}`);
  }
  if (rule?.severity && !SEVERITY_ORDER.includes(rule.severity)) {
    errors.push(`gravité inconnue : ${rule.severity}`);
  }
  if (rule?.category && !Object.values(CATEGORY).includes(rule.category)) {
    errors.push(`catégorie inconnue : ${rule.category}`);
  }
  if (rule?.when && typeof rule.when !== 'function') errors.push('when doit être une fonction');
  if (rule?.explain && typeof rule.explain !== 'function') errors.push('explain doit être une fonction');
  if (rule?.recommendation !== undefined && typeof rule.recommendation !== 'function') {
    errors.push('recommendation doit être une fonction');
  }
  return { valid: errors.length === 0, errors };
}

/** Valide un catalogue entier : formes correctes + identifiants uniques. */
export function validateCatalog(rules) {
  const errors = [];
  const seen = new Set();
  for (const rule of rules) {
    const result = validateRule(rule);
    if (!result.valid) errors.push(`${rule?.id ?? '(sans id)'} : ${result.errors.join(', ')}`);
    if (rule?.id) {
      if (seen.has(rule.id)) errors.push(`identifiant dupliqué : ${rule.id}`);
      seen.add(rule.id);
    }
  }
  return { valid: errors.length === 0, errors };
}

/**
 * Priorité opérationnelle d'un diagnostic.
 *
 * La gravité dit « à quel point c'est grave ». La priorité dit « dans quel
 * ordre s'en occuper » — elle tient compte du contexte : un même problème
 * n'a pas le même degré d'urgence en PROD et en TEST.
 */
export function computePriority(severity, { environment, blocksReadiness = false } = {}) {
  const isProd = environment === 'PROD';
  if (severity === SEVERITY.CRITICAL) return isProd ? PRIORITY.CRITICAL : PRIORITY.URGENT;
  if (severity === SEVERITY.HIGH) return isProd ? PRIORITY.URGENT : PRIORITY.FIX;
  if (severity === SEVERITY.MEDIUM) return blocksReadiness && isProd ? PRIORITY.FIX : PRIORITY.WATCH;
  return PRIORITY.WATCH;
}

/**
 * ÉVALUE le catalogue contre un contexte de projet.
 *
 * @param {object[]} rules   catalogue déclaratif
 * @param {object} context   { project, health, now, panel, … } — voir catalog.js
 * @returns {object[]} diagnostics complets et explicités
 */
export function evaluateRules(rules, context) {
  const diagnostics = [];
  const evaluatedAt = new Date(context.now ?? Date.now()).toISOString();

  for (const rule of rules) {
    let outcome;
    try {
      outcome = rule.when(context);
    } catch (err) {
      // Une règle qui lève est un défaut du catalogue, pas du projet observé.
      // On le signale explicitement plutôt que de l'avaler.
      diagnostics.push({
        id: `RULE_FAILURE_${rule.id}`,
        ruleId: rule.id,
        category: CATEGORY.OBSERVABILITY,
        component: 'diagnostic-engine',
        severity: SEVERITY.LOW,
        title: 'Règle de diagnostic en échec',
        description: `La règle ${rule.id} n'a pas pu être évaluée.`,
        justification: `Erreur d'évaluation : ${err.message}`,
        origin: 'PANEL_RULE_ENGINE',
        impact: 'Ce diagnostic est indisponible pour ce projet.',
        recommendation: null,
        priority: PRIORITY.WATCH,
        evaluatedAt,
      });
      continue;
    }
    if (!outcome) continue;

    const facts = typeof outcome === 'object' ? (outcome.facts ?? {}) : {};
    const severity = (typeof outcome === 'object' && outcome.severity) || rule.severity;
    const blocksReadiness = rule.readiness?.blocks === true;

    diagnostics.push({
      id: `${rule.id}`,
      ruleId: rule.id,
      category: rule.category,
      component: rule.component,
      severity,
      title: rule.title,
      description: rule.description,
      // « Aucun diagnostic magique » : la justification cite les valeurs
      // réellement constatées.
      justification: rule.explain(context, facts),
      // D'où vient le fait observé — le Panel ne se prétend jamais source.
      origin: rule.origin ?? 'PANEL_ANALYSIS',
      impact: rule.impact,
      recommendation: rule.recommendation ? rule.recommendation(context, facts) : null,
      priority: computePriority(severity, {
        environment: context.project?.environment,
        blocksReadiness,
      }),
      readinessCriterion: rule.readiness?.criterion ?? null,
      facts,
      evaluatedAt,
    });
  }

  // Tri : priorité décroissante, puis gravité décroissante, puis identifiant
  // (déterminisme total — deux exécutions donnent le même ordre).
  return diagnostics.sort((a, b) => {
    const byPriority = PRIORITY_ORDER.indexOf(b.priority) - PRIORITY_ORDER.indexOf(a.priority);
    if (byPriority !== 0) return byPriority;
    const bySeverity = SEVERITY_ORDER.indexOf(b.severity) - SEVERITY_ORDER.indexOf(a.severity);
    if (bySeverity !== 0) return bySeverity;
    return a.id.localeCompare(b.id);
  });
}

export default {
  SEVERITY, SEVERITY_ORDER, SEVERITY_WEIGHT, CATEGORY, PRIORITY, PRIORITY_ORDER,
  evaluateRules, validateRule, validateCatalog, computePriority,
  worstSeverity, highestPriority,
};
