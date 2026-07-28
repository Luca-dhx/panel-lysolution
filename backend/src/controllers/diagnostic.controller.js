// Surface de DIAGNOSTIC (/api/diagnostic) — Phase 3B, LECTURE SEULE.
//
// Comme la supervision, toutes les routes sont des GET. La différence est la
// nature du travail : la supervision RESTITUE ce qui a été observé, le
// diagnostic ANALYSE ce qui a été observé. Ni l'une ni l'autre ne contacte
// un projet ni n'écrit quoi que ce soit.
//
// Les calculs sont refaits à chaque appel, à partir de l'état en base : rien
// n'est mis en cache, rien n'est matérialisé. Un diagnostic est toujours le
// reflet de l'instant, jamais un souvenir.
import { ok } from '../utils/apiResponse.js';
import { getProjectOrThrow, listProjects } from '../services/registry/projectRegistry.service.js';
import { expectedEngineVersions } from '../services/supervision/fleet.service.js';
import { diagnoseFleet, diagnoseProject, inspectCatalog, panelReference } from '../services/diagnostic/diagnostic.service.js';
import { RULES } from '../services/diagnostic/rules/catalog.js';
import { CRITERIA } from '../services/diagnostic/readiness.service.js';

/** Diagnostic complet du parc — niveau 0 de l'analyse. */
export async function fleetDiagnostic(_req, res) {
  const records = await listProjects();
  return ok(res, diagnoseFleet(records, { expectedEngines: expectedEngineVersions() }));
}

/** Diagnostic complet d'un projet — niveau 2. */
export async function projectDiagnostic(req, res) {
  const record = await getProjectOrThrow(req.params.projectId);
  return ok(res, diagnoseProject(record, { expectedEngines: expectedEngineVersions() }));
}

/** Compatibilité seule — utile pour une vue ciblée. */
export async function projectCompatibility(req, res) {
  const record = await getProjectOrThrow(req.params.projectId);
  const diagnosis = diagnoseProject(record, { expectedEngines: expectedEngineVersions() });
  return ok(res, { projectId: record.projectId, ...diagnosis.compatibility });
}

/** Readiness seule, avec le détail de chaque critère et la formule. */
export async function projectReadiness(req, res) {
  const record = await getProjectOrThrow(req.params.projectId);
  const diagnosis = diagnoseProject(record, { expectedEngines: expectedEngineVersions() });
  return ok(res, { projectId: record.projectId, ...diagnosis.readiness });
}

/** Risques seuls, cotés et expliqués. */
export async function projectRisks(req, res) {
  const record = await getProjectOrThrow(req.params.projectId);
  const diagnosis = diagnoseProject(record, { expectedEngines: expectedEngineVersions() });
  return ok(res, { projectId: record.projectId, ...diagnosis.risks });
}

/** Recommandations seules. */
export async function projectRecommendations(req, res) {
  const record = await getProjectOrThrow(req.params.projectId);
  const diagnosis = diagnoseProject(record, { expectedEngines: expectedEngineVersions() });
  return ok(res, { projectId: record.projectId, items: diagnosis.recommendations });
}

/**
 * LE CATALOGUE DE RÈGLES, exposé en lecture.
 *
 * C'est ce qui rend le moteur auditable : un opérateur peut lire les règles
 * qui s'appliquent, sans ouvrir le code. Les fonctions (`when`, `explain`)
 * ne sont pas sérialisables et ne sont donc pas exposées — seule leur
 * déclaration l'est.
 */
export function catalog(_req, res) {
  return ok(res, {
    ...inspectCatalog(RULES),
    reference: panelReference(expectedEngineVersions()),
    rules: RULES.map((rule) => ({
      id: rule.id,
      category: rule.category,
      component: rule.component,
      severity: rule.severity,
      title: rule.title,
      description: rule.description,
      impact: rule.impact,
      origin: rule.origin ?? 'PANEL_ANALYSIS',
      readiness: rule.readiness ?? null,
      hasRecommendation: typeof rule.recommendation === 'function',
    })),
    readinessCriteria: CRITERIA.map((c) => ({
      id: c.id,
      label: c.label,
      weight: c.weight,
      blocking: c.blocking,
    })),
  });
}
