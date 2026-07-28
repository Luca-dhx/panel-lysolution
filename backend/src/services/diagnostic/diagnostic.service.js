// DIAGNOSTIC — l'orchestrateur de la Phase 3B.
//
// Assemble : contexte → règles → diagnostics → compatibilité → readiness →
// risques → recommandations → priorité globale.
//
// PURETÉ : ce module ne fait AUCUNE E/S. Il reçoit un contexte déjà chargé et
// rend un objet. C'est ce qui rend tous les calculs déterministes et
// testables sans base ni réseau — `now` est toujours injecté.
//
// LECTURE SEULE : rien ici n'écrit, ne contacte un projet, ni ne déclenche
// quoi que ce soit.
import { CONTRACT_VERSION, MANIFEST_FORMAT_VERSION } from '../../bridge/bridgeContract.js';
import { buildProjectHealth } from '../supervision/health.service.js';
import { livenessThresholds } from '../supervision/liveness.service.js';
import { describeProject } from '../registry/projectRegistry.service.js';
import config from '../../config/env.js';

import { RULES } from './rules/catalog.js';
import {
  evaluateRules, highestPriority, PRIORITY, PRIORITY_ORDER, SEVERITY,
  validateCatalog, worstSeverity,
} from './rules/engine.js';
import { assessCompatibility, assessFleetCompatibility, VERDICT } from './compatibility.service.js';
import { computeFleetReadiness, computeReadiness } from './readiness.service.js';
import { assessRisks, summariseRisks } from './risk.service.js';
import { buildFleetRecommendations, buildRecommendations } from './recommendation.service.js';

/**
 * RÉFÉRENCES de l'écosystème, telles que le Panel les connaît.
 *
 * Le Panel se compare à lui-même : ce qu'il embarque définit le standard
 * courant. Il ne l'impose à personne — il constate les écarts.
 */
export function panelReference(expectedEngines = {}) {
  return {
    contractVersion: CONTRACT_VERSION,
    // Minimum supporté : même majeure, première mineure. Sous ce seuil, le
    // support n'est plus assuré.
    minimumContractVersion: `${CONTRACT_VERSION.split('.')[0]}.0.0`,
    manifestFormatVersion: MANIFEST_FORMAT_VERSION,
    engines: expectedEngines,
    minimumEngineVersion: null,
    thresholds: livenessThresholds(),
    certificateWarningDays: config.certificateWarningDays,
  };
}

/**
 * Construit le contexte d'analyse d'un projet — la SEULE entrée des règles.
 * Tout ce dont une règle a besoin doit s'y trouver : c'est ce qui garantit
 * qu'aucune règle n'ira chercher une donnée ailleurs.
 */
export function buildContext(record, { now = Date.now(), expectedEngines = {} } = {}) {
  const panel = panelReference(expectedEngines);
  const project = describeProject(record);
  const health = buildProjectHealth(record, {
    now,
    panelContractVersion: panel.contractVersion,
    expectedEngines,
  });
  return { now, record, project, health, panel };
}

/**
 * DIAGNOSTIC COMPLET d'un projet.
 *
 * @param {object} record  fiche projet
 * @param {object} options { now, expectedEngines, rules }
 */
export function diagnoseProject(record, { now = Date.now(), expectedEngines = {}, rules = RULES } = {}) {
  const context = buildContext(record, { now, expectedEngines });

  // 1. Compatibilité — calculée avant les règles : certaines s'y adossent,
  //    et la readiness en dépend.
  const compatibility = assessCompatibility(context);
  const enriched = { ...context, compatibility };

  // 2. Diagnostics — évaluation du catalogue déclaratif.
  const diagnostics = evaluateRules(rules, enriched);

  // 3. Readiness — score pondéré, calculé, jamais fixé.
  const readiness = computeReadiness(enriched);

  // 4. Risques — cotation probabilité × impact de chaque diagnostic.
  const risks = assessRisks(diagnostics, { environment: context.project.environment });

  // 5. Recommandations — fusionnées par action.
  const recommendations = buildRecommendations(diagnostics, { now });

  // 6. Priorité globale du projet.
  const priority = diagnostics.length > 0
    ? highestPriority(diagnostics.map((d) => d.priority))
    : PRIORITY.WATCH;

  return {
    projectId: record.projectId,
    projectName: record.projectName,
    slug: record.projectKey,
    environment: context.project.environment,
    // Résumé : ce qu'on lit en premier sur la fiche.
    summary: summarise({ diagnostics, compatibility, readiness, risks, priority, health: context.health }),
    diagnostics,
    compatibility,
    readiness,
    risks: { items: risks, ...summariseRisks(risks) },
    recommendations,
    priority,
    evaluatedAt: new Date(now).toISOString(),
  };
}

/**
 * RÉSUMÉ lisible — la réponse aux questions que pose la phase :
 * pourquoi ce projet est-il en WARNING ? est-il prêt ? quels risques ?
 *
 * Chaque phrase est CONSTRUITE à partir des calculs, jamais choisie dans une
 * liste de messages pré-écrits.
 */
export function summarise({ diagnostics, compatibility, readiness, risks, priority, health }) {
  const blocking = diagnostics.filter((d) => d.severity === SEVERITY.CRITICAL || d.severity === SEVERITY.HIGH);
  const riskSummary = summariseRisks(risks);

  // « Pourquoi cet état ? » — on nomme les causes, on ne qualifie pas.
  const causes = blocking.length > 0
    ? blocking.slice(0, 3).map((d) => d.title)
    : diagnostics.slice(0, 3).map((d) => d.title);

  const statusExplanation = health.status === 'OK' && diagnostics.length === 0
    ? 'Aucun diagnostic : le projet ne présente aucun écart détectable.'
    : causes.length > 0
      ? `État ${health.status} expliqué par : ${causes.join(' · ')}.`
      : `État ${health.status}, sans diagnostic associé.`;

  return {
    healthStatus: health.status,
    liveness: health.liveness,
    priority,
    readinessScore: readiness.score,
    readinessLevel: readiness.level,
    compatibilityVerdict: compatibility.verdict,
    compatibilityBlocking: compatibility.blocking,
    diagnosticCount: diagnostics.length,
    blockingCount: blocking.length,
    highestRisk: riskSummary.highest,
    topRecommendationCount: diagnostics.filter((d) => d.recommendation).length,
    // Les trois phrases qui répondent aux questions de la phase.
    explanation: statusExplanation,
    compatibilityExplanation: compatibility.reason,
    readinessExplanation: readiness.blockedBy.length > 0
      ? `Score plafonné à ${readiness.score} % : ${readiness.blockedBy.map((b) => b.label).join(', ')} en échec bloquant.`
      : `Score de ${readiness.score} % — ${describeReadiness(readiness.level)}.`,
  };
}

function describeReadiness(level) {
  switch (level) {
    case 'READY': return 'le projet est prêt pour la production';
    case 'NEARLY_READY': return 'le projet est presque prêt, quelques points restent à traiter';
    case 'PARTIAL': return 'plusieurs critères importants ne sont pas satisfaits';
    case 'BLOCKED': return 'un critère bloquant empêche toute mise en production';
    default: return 'le projet n’est pas prêt pour la production';
  }
}

/**
 * DIAGNOSTIC DU PARC — agrégat, plus compatibilité croisée entre projets.
 *
 * @param {object[]} records fiches projets
 */
export function diagnoseFleet(records, { now = Date.now(), expectedEngines = {}, rules = RULES } = {}) {
  const assessments = records.map((record) => {
    const diagnosis = diagnoseProject(record, { now, expectedEngines, rules });
    return { ...diagnosis, project: describeProject(record) };
  });

  const allRisks = assessments.flatMap((a) => a.risks.items);
  const readinessList = assessments.map((a) => a.readiness);
  const fleetRecommendations = buildFleetRecommendations(
    assessments.map((a) => ({
      projectId: a.projectId,
      projectName: a.projectName,
      recommendations: a.recommendations,
    })),
  );

  const byPriority = assessments.reduce(
    (acc, a) => ({ ...acc, [a.priority]: (acc[a.priority] ?? 0) + 1 }),
    {},
  );

  return {
    generatedAt: new Date(now).toISOString(),
    projects: assessments.length,
    readiness: computeFleetReadiness(readinessList),
    compatibility: assessFleetCompatibility(assessments),
    risks: {
      ...summariseRisks(allRisks),
      // Top risques du parc : les plus cotés, tous projets confondus.
      top: allRisks
        .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
        .slice(0, 10)
        .map((risk) => ({
          ...risk,
          projectId: assessments.find((a) => a.risks.items.includes(risk))?.projectId ?? null,
          projectName: assessments.find((a) => a.risks.items.includes(risk))?.projectName ?? null,
        })),
    },
    recommendations: {
      total: fleetRecommendations.length,
      top: fleetRecommendations.slice(0, 10),
    },
    priorities: {
      critical: byPriority[PRIORITY.CRITICAL] ?? 0,
      urgent: byPriority[PRIORITY.URGENT] ?? 0,
      fix: byPriority[PRIORITY.FIX] ?? 0,
      watch: byPriority[PRIORITY.WATCH] ?? 0,
    },
    // Projets classés par urgence — la file de travail de l'opérateur.
    queue: assessments
      .map((a) => ({
        projectId: a.projectId,
        projectName: a.projectName,
        slug: a.slug,
        environment: a.environment,
        priority: a.priority,
        readinessScore: a.readiness.score,
        readinessLevel: a.readiness.level,
        compatibilityVerdict: a.compatibility.verdict,
        highestRisk: a.risks.highest,
        diagnosticCount: a.diagnostics.length,
        aggregateRisk: a.risks.aggregate,
      }))
      .sort((a, b) => {
        const byPrio = PRIORITY_ORDER.indexOf(b.priority) - PRIORITY_ORDER.indexOf(a.priority);
        if (byPrio !== 0) return byPrio;
        if (b.aggregateRisk !== a.aggregateRisk) return b.aggregateRisk - a.aggregateRisk;
        return a.projectName.localeCompare(b.projectName);
      }),
  };
}

/** Santé du catalogue lui-même — un catalogue mal formé est un défaut. */
export function inspectCatalog(rules = RULES) {
  const validation = validateCatalog(rules);
  return {
    valid: validation.valid,
    errors: validation.errors,
    ruleCount: rules.length,
    byCategory: rules.reduce((acc, r) => ({ ...acc, [r.category]: (acc[r.category] ?? 0) + 1 }), {}),
    bySeverity: rules.reduce((acc, r) => ({ ...acc, [r.severity]: (acc[r.severity] ?? 0) + 1 }), {}),
    withRecommendation: rules.filter((r) => typeof r.recommendation === 'function').length,
  };
}

export { RULES, VERDICT, PRIORITY, SEVERITY, worstSeverity };
export default { diagnoseProject, diagnoseFleet, buildContext, panelReference, inspectCatalog, summarise };
