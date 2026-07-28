// RECOMMANDATIONS — service PUR.
//
// ── LA RÈGLE ────────────────────────────────────────────────────────────────
// Le Panel ne dit jamais « corriger ». Il dit CE QU'IL FAUT FAIRE :
// « Mettre à jour le contrat de pont en 1.2.0 », « Renouveler le certificat ».
//
// Une recommandation utile répond à cinq questions :
//   quoi ?      `action`
//   pourquoi ?  `justification` — reprise du diagnostic qui l'a produite
//   pour quoi ? `benefit`
//   à quel prix ? `risk`
//   et avant ?  `prerequisites`
//
// ── CE QUE CE SERVICE NE FAIT PAS ───────────────────────────────────────────
// Il n'exécute RIEN. `futureAction` est une ÉTIQUETTE, pas un point d'entrée :
// elle existe pour que la Phase 3C (pilotage) sache à quoi rattacher chaque
// recommandation, sans avoir à réinterpréter du texte libre.
import { PRIORITY, PRIORITY_ORDER, SEVERITY_WEIGHT } from './rules/engine.js';
import { FUTURE_ACTIONS } from './rules/catalog.js';

/** Effort estimé — grossier et assumé comme tel : il sert à ordonner. */
export const EFFORT = Object.freeze({
  TRIVIAL: 'TRIVIAL',   // quelques minutes, sans risque
  SMALL: 'SMALL',       // une intervention ciblée
  MEDIUM: 'MEDIUM',     // une intervention + recette
  LARGE: 'LARGE',       // un chantier (migration majeure)
});

const EFFORT_WEIGHT = Object.freeze({
  [EFFORT.TRIVIAL]: 1,
  [EFFORT.SMALL]: 2,
  [EFFORT.MEDIUM]: 4,
  [EFFORT.LARGE]: 8,
});

/**
 * Effort déduit de l'action future. Une migration majeure est un chantier ;
 * un renouvellement de certificat, une commande.
 */
export function effortOf(futureAction) {
  switch (futureAction) {
    case 'RENEW_CERTIFICATE':
    case 'ISSUE_PAIRING_CODE':
    case 'FETCH_MANIFEST':
      return EFFORT.TRIVIAL;
    case 'DIAGNOSE_REMOTE':
    case 'PLAN_INSTRUMENTATION':
      return EFFORT.SMALL;
    case 'PLAN_CONTRACT_UPGRADE':
    case 'PLAN_PANEL_UPGRADE':
    case 'PLAN_ENGINE_UPGRADE':
      return EFFORT.MEDIUM;
    case 'PLAN_CONTRACT_MIGRATION':
    case 'PLAN_ENGINE_MIGRATION':
      return EFFORT.LARGE;
    default:
      return EFFORT.MEDIUM;
  }
}

/**
 * Construit les recommandations d'un projet à partir de ses diagnostics.
 *
 * Deux diagnostics peuvent produire la MÊME action (par exemple, deux
 * moteurs en retard mènent tous deux à un portage). On les FUSIONNE : une
 * recommandation par action, avec toutes ses justifications. Sans cela, une
 * fiche projet afficherait cinq fois « mettre à jour le contrat ».
 */
export function buildRecommendations(diagnostics, context = {}) {
  const byAction = new Map();

  for (const diagnostic of diagnostics) {
    const rec = diagnostic.recommendation;
    if (!rec) continue;

    const key = `${rec.futureAction}::${rec.action}`;
    const existing = byAction.get(key);
    const weight = SEVERITY_WEIGHT[diagnostic.severity] ?? 0;

    if (existing) {
      existing.reasons.push({
        diagnosticId: diagnostic.id,
        severity: diagnostic.severity,
        justification: diagnostic.justification,
      });
      existing.weight += weight;
      // La priorité d'une recommandation fusionnée est la plus haute de ses
      // motifs : on ne dilue jamais une urgence dans une moyenne.
      if (PRIORITY_ORDER.indexOf(diagnostic.priority) > PRIORITY_ORDER.indexOf(existing.priority)) {
        existing.priority = diagnostic.priority;
      }
      continue;
    }

    byAction.set(key, {
      id: `REC_${rec.futureAction}_${diagnostic.ruleId}`,
      action: rec.action,
      benefit: rec.benefit,
      risk: rec.risk,
      prerequisites: rec.prerequisites ?? [],
      futureAction: rec.futureAction,
      effort: effortOf(rec.futureAction),
      component: diagnostic.component,
      category: diagnostic.category,
      priority: diagnostic.priority,
      weight,
      reasons: [{
        diagnosticId: diagnostic.id,
        severity: diagnostic.severity,
        justification: diagnostic.justification,
      }],
    });
  }

  const recommendations = [...byAction.values()].map((rec) => ({
    ...rec,
    // Ratio bénéfice/effort : ce qui rapporte le plus pour le moins de travail
    // remonte en tête. C'est ce qui rend une liste de 15 recommandations
    // exploitable au lieu d'être décourageante.
    leverage: Math.round((rec.weight / EFFORT_WEIGHT[rec.effort]) * 100) / 100,
    evaluatedAt: context.now ? new Date(context.now).toISOString() : undefined,
  }));

  // Tri déterministe : priorité, puis levier, puis identifiant.
  return recommendations.sort((a, b) => {
    const byPriority = PRIORITY_ORDER.indexOf(b.priority) - PRIORITY_ORDER.indexOf(a.priority);
    if (byPriority !== 0) return byPriority;
    if (b.leverage !== a.leverage) return b.leverage - a.leverage;
    return a.id.localeCompare(b.id);
  });
}

/**
 * Recommandations du PARC — fusionnées par action, avec le nombre de projets
 * concernés. « Mettre à jour le contrat » sur 12 projets est UNE ligne, pas
 * douze : c'est ce qui permet de planifier une campagne.
 */
export function buildFleetRecommendations(perProject) {
  const byAction = new Map();

  for (const { projectId, projectName, recommendations } of perProject) {
    for (const rec of recommendations) {
      const key = `${rec.futureAction}::${rec.action}`;
      const existing = byAction.get(key);
      if (existing) {
        existing.projects.push({ projectId, projectName });
        existing.weight += rec.weight;
        if (PRIORITY_ORDER.indexOf(rec.priority) > PRIORITY_ORDER.indexOf(existing.priority)) {
          existing.priority = rec.priority;
        }
        continue;
      }
      byAction.set(key, {
        id: rec.id,
        action: rec.action,
        benefit: rec.benefit,
        risk: rec.risk,
        prerequisites: rec.prerequisites,
        futureAction: rec.futureAction,
        effort: rec.effort,
        category: rec.category,
        priority: rec.priority,
        weight: rec.weight,
        projects: [{ projectId, projectName }],
      });
    }
  }

  return [...byAction.values()]
    .map((rec) => ({
      ...rec,
      projectCount: rec.projects.length,
      // Au niveau du parc, le levier tient compte du nombre de projets
      // concernés : une même action appliquée à 12 projets vaut plus.
      leverage: Math.round((rec.weight * rec.projects.length / EFFORT_WEIGHT[rec.effort]) * 100) / 100,
    }))
    .sort((a, b) => {
      const byPriority = PRIORITY_ORDER.indexOf(b.priority) - PRIORITY_ORDER.indexOf(a.priority);
      if (byPriority !== 0) return byPriority;
      if (b.leverage !== a.leverage) return b.leverage - a.leverage;
      return a.id.localeCompare(b.id);
    });
}

/** Vérifie qu'une recommandation ne renvoie pas vers une action inconnue. */
export function validateFutureActions(recommendations) {
  const unknown = recommendations
    .filter((r) => !FUTURE_ACTIONS.includes(r.futureAction))
    .map((r) => r.futureAction);
  return { valid: unknown.length === 0, unknown: [...new Set(unknown)] };
}

export { PRIORITY };
export default { buildRecommendations, buildFleetRecommendations, effortOf, validateFutureActions, EFFORT };
