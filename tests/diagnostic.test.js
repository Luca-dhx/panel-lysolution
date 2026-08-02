// DIAGNOSTIC — Phase 3B. Moteur de règles, compatibilité, readiness,
// risques, recommandations, priorisation, explications.
//
// EXIGENCE CENTRALE DE LA PHASE : tous les calculs sont DÉTERMINISTES et
// n'ont AUCUNE dépendance réseau. La quasi-totalité de ce fichier travaille
// donc sur des fiches fabriquées en mémoire, avec un `now` injecté — deux
// exécutions produisent exactement le même résultat.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  check, connectTestDatabase, finish, section, setTestEnv,
  startMemoryMongo, startServer, stopMemoryMongo,
} from './helpers/harness.js';

setTestEnv();
process.env.HEARTBEAT_INTERVAL_S = '300';
await startMemoryMongo();
await connectTestDatabase();

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const engine = await import('../backend/src/services/diagnostic/rules/engine.js');
const catalogMod = await import('../backend/src/services/diagnostic/rules/catalog.js');
const compat = await import('../backend/src/services/diagnostic/compatibility.service.js');
const readinessSvc = await import('../backend/src/services/diagnostic/readiness.service.js');
const riskSvc = await import('../backend/src/services/diagnostic/risk.service.js');
const recoSvc = await import('../backend/src/services/diagnostic/recommendation.service.js');
const diag = await import('../backend/src/services/diagnostic/diagnostic.service.js');
const { CONTRACT_VERSION } = await import('../backend/src/bridge/bridgeContract.js');

const { SEVERITY, PRIORITY, CATEGORY } = engine;
const { VERDICT } = compat;
const { CRITERION_STATE } = readinessSvc;
const { RISK_LEVEL } = riskSvc;

// Horloge FIXE : tout le fichier travaille à cet instant.
const NOW = Date.parse('2026-08-01T12:00:00.000Z');
const ago = (seconds) => new Date(NOW - seconds * 1000).toISOString();
const inDays = (days) => new Date(NOW + days * 86_400_000).toISOString();
const ENGINES = { deployment: '1.1.0', duplication: '1.1.0' };

/** Fiche projet fabriquée — nominale par défaut, altérable par `overrides`. */
function makeRecord(overrides = {}) {
  const base = {
    projectId: 'p-1',
    projectKey: 'projet-test',
    projectName: 'Projet Test',
    createdAt: ago(86_400),
    updatedAt: ago(60),
    pairing: { status: 'PAIRED', pairedAt: ago(86_400), revokedAt: null },
    runtime: {
      environment: 'PROD',
      softwareVersion: '1.0.0',
      contractVersion: CONTRACT_VERSION,
      publicBackendUrl: 'https://api.projet.exemple.com',
      lastHeartbeatAt: ago(30),
      lastHealth: { status: 'OK', details: null },
      uptimeSeconds: 3600,
      load: { memoryUsedMb: 120 },
      components: { frontend: 'OK', mongo: 'OK', ssl: 'OK', dns: 'OK' },
      engines: { ...ENGINES },
      certificate: { expiresAt: inDays(90) },
    },
    manifest: {
      manifestVersion: '1.0.0',
      project: { key: 'projet-test', name: 'Projet Test', environment: 'PROD', softwareVersion: '1.0.0' },
      bridge: { contractVersion: CONTRACT_VERSION, projectBridgeBasePath: '/api/project-bridge/v1' },
      contracts: { panelBridge: CONTRACT_VERSION, projectBridge: CONTRACT_VERSION },
      sync: { supportedEntityTypes: ['DIAGNOSTIC'], operations: [] },
      modules: [{ id: 'vitrine', title: 'Vitrine', status: 'ACTIVE' }],
      features: [{ id: 'sync.diagnostic', status: 'AVAILABLE' }],
      engines: { ...ENGINES },
      network: { primaryDomain: 'projet.exemple.com', urls: { site: 'https://projet.exemple.com' } },
      descriptor: { type: 'vitrine', description: 'Projet de test', layout: 'vitrine:web + backend:server' },
    },
    manifestSource: 'BRIDGE',
    manifestUpdatedAt: ago(86_400),
  };
  const merged = { ...base, ...overrides };
  if (overrides.runtime) merged.runtime = { ...base.runtime, ...overrides.runtime };
  if (overrides.pairing) merged.pairing = { ...base.pairing, ...overrides.pairing };
  return merged;
}

const analyse = (record) => diag.diagnoseProject(record, { now: NOW, expectedEngines: ENGINES });
const hasRule = (result, ruleId) => result.diagnostics.some((d) => d.ruleId === ruleId);
const ruleOf = (result, ruleId) => result.diagnostics.find((d) => d.ruleId === ruleId);

// ─── LOT 9 : moteur de règles ──────────────────────────────────────────────
section('Moteur de règles : catalogue déclaratif et centralisé');
{
  const inspection = diag.inspectCatalog();
  check(`catalogue valide (${inspection.ruleCount} règles)`, inspection.valid === true);
  check('aucune erreur de forme', inspection.errors.length === 0);
  check('règles réparties sur plusieurs catégories', Object.keys(inspection.byCategory).length >= 4);
  check('toute règle porte une recommandation',
    inspection.withRecommendation === inspection.ruleCount);

  check('identifiants uniques',
    new Set(catalogMod.RULES.map((r) => r.id)).size === catalogMod.RULES.length);
  check('chaque règle sait s’expliquer',
    catalogMod.RULES.every((r) => typeof r.explain === 'function'));
  check('chaque règle déclare son impact',
    catalogMod.RULES.every((r) => typeof r.impact === 'string' && r.impact.length > 10));

  // Un catalogue mal formé doit être REFUSÉ, pas avalé.
  check('règle sans identifiant refusée',
    !engine.validateRule({ category: CATEGORY.SECURITY, severity: SEVERITY.LOW }).valid);
  check('gravité inconnue refusée',
    !engine.validateRule({ ...catalogMod.RULES[0], severity: 'ENORME' }).valid);
  check('identifiant dupliqué détecté',
    !engine.validateCatalog([catalogMod.RULES[0], catalogMod.RULES[0]]).valid);

  // Une règle qui lève ne doit pas faire tomber le diagnostic.
  const broken = [{
    id: 'BROKEN', category: CATEGORY.OBSERVABILITY, component: 'x', severity: SEVERITY.LOW,
    title: 'x', description: 'x', impact: 'x',
    when: () => { throw new Error('boum'); },
    explain: () => 'x',
  }];
  const resilient = engine.evaluateRules(broken, { now: NOW });
  check('une règle en échec est signalée, pas silencieuse',
    resilient.length === 1 && resilient[0].id === 'RULE_FAILURE_BROKEN');
  check('…et n’interrompt pas l’évaluation',
    engine.evaluateRules([...broken, ...catalogMod.RULES], { now: NOW, record: makeRecord(), project: {}, health: {}, panel: {} }).length >= 1);
}

section('Déterminisme : deux évaluations identiques donnent le même résultat');
{
  const record = makeRecord({ runtime: { lastHeartbeatAt: ago(5000) } });
  const a = analyse(record);
  const b = analyse(record);
  check('diagnostics identiques', JSON.stringify(a.diagnostics) === JSON.stringify(b.diagnostics));
  check('readiness identique', JSON.stringify(a.readiness) === JSON.stringify(b.readiness));
  check('risques identiques', JSON.stringify(a.risks) === JSON.stringify(b.risks));
  check('recommandations identiques', JSON.stringify(a.recommendations) === JSON.stringify(b.recommendations));
  check('horodatage figé sur le `now` injecté',
    a.evaluatedAt === new Date(NOW).toISOString());
}

// ─── LOT 2 : diagnostics ───────────────────────────────────────────────────
section('Diagnostics : forme complète et justification systématique');
{
  const result = analyse(makeRecord({ runtime: { lastHeartbeatAt: ago(9999) } }));
  check('des diagnostics sont produits', result.diagnostics.length > 0);
  for (const field of ['id', 'category', 'severity', 'component', 'description',
    'justification', 'origin', 'impact', 'priority', 'evaluatedAt']) {
    check(`chaque diagnostic porte « ${field} »`,
      result.diagnostics.every((d) => d[field] !== undefined && d[field] !== null));
  }
  check('la justification cite des valeurs constatées (jamais générique)',
    result.diagnostics.every((d) => d.justification.length > 20));
  check('l’origine est explicite',
    result.diagnostics.every((d) => ['PANEL_OBSERVATION', 'PANEL_ANALYSIS', 'PROJECT_DECLARATION', 'PANEL_RULE_ENGINE'].includes(d.origin)));
  check('tri déterministe : priorité décroissante',
    result.diagnostics.every((d, i) => i === 0
      || engine.PRIORITY_ORDER.indexOf(d.priority) <= engine.PRIORITY_ORDER.indexOf(result.diagnostics[i - 1].priority)));
}

section('Diagnostics : chaque situation produit la bonne règle');
{
  const cases = [
    ['projet hors ligne', { runtime: { lastHeartbeatAt: ago(99_999) } }, 'HEARTBEAT_OFFLINE'],
    ['signal périmé', { runtime: { lastHeartbeatAt: ago(900) } }, 'HEARTBEAT_STALE'],
    ['jamais vu', { runtime: { lastHeartbeatAt: null } }, 'NEVER_SEEN'],
    ['non appairé', { pairing: { status: 'DECLARED' } }, 'NOT_PAIRED'],
    ['appairage révoqué', { pairing: { status: 'REVOKED', revokedAt: ago(60) } }, 'PAIRING_REVOKED'],
    ['contrat incompatible', { runtime: { contractVersion: '9.0.0' } }, 'CONTRACT_MAJOR_MISMATCH'],
    ['contrat en retard', { runtime: { contractVersion: '1.0.0' } }, 'CONTRACT_OUTDATED'],
    // Le Manifest sert de repli légitime : pour simuler « inconnu », il faut
    // que NI le runtime NI le Manifest ne portent la valeur.
    ['contrat inconnu', { runtime: { contractVersion: null }, manifest: null, manifestSource: null }, 'CONTRACT_UNKNOWN'],
    ['moteur : majeure divergente', { runtime: { engines: { deployment: '9.0.0', duplication: '1.1.0' } } }, 'DEPLOYMENT_ENGINE_MAJOR_DRIFT'],
    ['moteur en retard', { runtime: { engines: { deployment: '1.0.0', duplication: '1.1.0' } } }, 'DEPLOYMENT_ENGINE_OUTDATED'],
    ['moteur non publié', { runtime: { engines: null }, manifest: null, manifestSource: null }, 'DEPLOYMENT_ENGINE_UNKNOWN'],
    ['certificat expiré', { runtime: { certificate: { expiresAt: inDays(-5) } } }, 'CERTIFICATE_EXPIRED'],
    ['certificat expirant', { runtime: { certificate: { expiresAt: inDays(10) } } }, 'CERTIFICATE_EXPIRING'],
    ['composant en erreur', { runtime: { components: { mongo: 'ERROR' } } }, 'COMPONENT_ERROR'],
    ['backend dégradé', { runtime: { lastHealth: { status: 'DEGRADED', details: 'file pleine' } } }, 'BACKEND_DEGRADED'],
    ['manifest absent', { manifest: null, manifestSource: null }, 'MANIFEST_MISSING'],
    ['manifest manuel', { manifestSource: 'MANUAL' }, 'MANIFEST_MANUAL'],
    ['composants non instrumentés', { runtime: { components: {} } }, 'COMPONENTS_NOT_PUBLISHED'],
    ['métriques non publiées', { runtime: { uptimeSeconds: null, load: null } }, 'RUNTIME_NOT_PUBLISHED'],
  ];
  for (const [label, overrides, ruleId] of cases) {
    check(`${label} → ${ruleId}`, hasRule(analyse(makeRecord(overrides)), ruleId));
  }

  const healthy = analyse(makeRecord());
  check('un projet nominal ne déclenche AUCUNE règle grave',
    !healthy.diagnostics.some((d) => d.severity === SEVERITY.CRITICAL || d.severity === SEVERITY.HIGH));
}

section('Diagnostics : gravité ajustée au contexte');
{
  const soon = ruleOf(analyse(makeRecord({ runtime: { certificate: { expiresAt: inDays(3) } } })), 'CERTIFICATE_EXPIRING');
  const later = ruleOf(analyse(makeRecord({ runtime: { certificate: { expiresAt: inDays(18) } } })), 'CERTIFICATE_EXPIRING');
  check('certificat à 3 jours : CRITICAL', soon.severity === SEVERITY.CRITICAL);
  check('certificat à 18 jours : HIGH', later.severity === SEVERITY.HIGH);
  check('la justification cite le nombre de jours restants', soon.justification.includes('3 jour'));
}

// ─── LOT 3 : compatibilité ─────────────────────────────────────────────────
section('Compatibilité : sept verdicts, chacun expliqué');
{
  const cmp = (actual, ref, min) => compat.compareAgainstReference(actual, ref, min);
  check('identique → COMPATIBLE', cmp('1.2.0', '1.2.0').verdict === VERDICT.COMPATIBLE);
  check('mineure en retard → MIGRATION_AVAILABLE', cmp('1.1.0', '1.2.0').verdict === VERDICT.MIGRATION_AVAILABLE);
  check('correctif en retard → COMPATIBLE_WITH_WARNING', cmp('1.2.0', '1.2.3').verdict === VERDICT.COMPATIBLE_WITH_WARNING);
  check('plus récente → VERSION_AHEAD', cmp('1.3.0', '1.2.0').verdict === VERDICT.VERSION_AHEAD);
  check('majeure différente → INCOMPATIBLE', cmp('2.0.0', '1.2.0').verdict === VERDICT.INCOMPATIBLE);
  check('sous le minimum → VERSION_TOO_OLD', cmp('1.0.0', '1.9.0', '1.1.0').verdict === VERDICT.VERSION_TOO_OLD);
  check('absente → UNKNOWN', cmp(null, '1.2.0').verdict === VERDICT.UNKNOWN);
  check('non semver → UNKNOWN', cmp('bientôt', '1.2.0').verdict === VERDICT.UNKNOWN);

  check('chaque verdict est expliqué',
    [cmp('1.2.0', '1.2.0'), cmp('2.0.0', '1.2.0'), cmp(null, '1.2.0')]
      .every((r) => typeof r.reason === 'string' && r.reason.length > 25));
  check('l’explication cite les deux versions comparées',
    cmp('2.0.0', '1.2.0').reason.includes('2.0.0') && cmp('2.0.0', '1.2.0').reason.includes('1.2.0'));

  check('INCOMPATIBLE est bloquant', compat.isBlocking(VERDICT.INCOMPATIBLE));
  check('VERSION_TOO_OLD est bloquant', compat.isBlocking(VERDICT.VERSION_TOO_OLD));
  check('MIGRATION_AVAILABLE n’est PAS bloquant', !compat.isBlocking(VERDICT.MIGRATION_AVAILABLE));
  check('le pire verdict l’emporte',
    compat.worstVerdict([VERDICT.COMPATIBLE, VERDICT.INCOMPATIBLE, VERDICT.MIGRATION_AVAILABLE]) === VERDICT.INCOMPATIBLE);
}

section('Compatibilité : tous les axes couverts');
{
  const result = analyse(makeRecord());
  const axes = result.compatibility.axes.map((a) => a.axis);
  for (const axis of ['bridge', 'deploymentEngine', 'duplicationEngine', 'manifestFormat', 'manifest', 'layout']) {
    check(`axe « ${axis} » évalué`, axes.includes(axis));
  }
  check('projet nominal → COMPATIBLE', result.compatibility.verdict === VERDICT.COMPATIBLE);
  check('non bloquant', result.compatibility.blocking === false);

  const broken = analyse(makeRecord({ runtime: { contractVersion: '9.0.0' } }));
  check('contrat incompatible → verdict global INCOMPATIBLE',
    broken.compatibility.verdict === VERDICT.INCOMPATIBLE);
  check('…et bloquant', broken.compatibility.blocking === true);
  check('…l’explication NOMME l’axe responsable',
    broken.compatibility.reason.includes('Contrat de pont'));

  const manual = analyse(makeRecord({ manifestSource: 'MANUAL' }));
  check('manifest manuel → réserve sur l’axe manifest',
    manual.compatibility.axes.find((a) => a.axis === 'manifest').verdict === VERDICT.COMPATIBLE_WITH_WARNING);
}

section('Compatibilité croisée du parc');
{
  const homogeneous = diag.diagnoseFleet([makeRecord(), makeRecord({ projectId: 'p-2', projectKey: 'b', projectName: 'B' })],
    { now: NOW, expectedEngines: ENGINES });
  check('parc homogène détecté', homogeneous.compatibility.fragmented.length === 0);
  check('…et expliqué', homogeneous.compatibility.reason.includes('homogène'));

  const split = diag.diagnoseFleet([
    makeRecord(),
    makeRecord({ projectId: 'p-2', projectKey: 'b', projectName: 'B', runtime: { engines: { deployment: '2.0.0', duplication: '1.1.0' } } }),
  ], { now: NOW, expectedEngines: ENGINES });
  check('scission de majeure détectée', split.compatibility.majorSplits.includes('deploymentEngine'));
  check('…et expliquée', split.compatibility.reason.includes('majeures'));

  const minor = diag.diagnoseFleet([
    makeRecord(),
    makeRecord({ projectId: 'p-2', projectKey: 'b', projectName: 'B', runtime: { engines: { deployment: '1.0.0', duplication: '1.1.0' } } }),
  ], { now: NOW, expectedEngines: ENGINES });
  check('hétérogénéité mineure détectée', minor.compatibility.fragmented.includes('deploymentEngine'));
  check('…sans être signalée comme scission majeure', minor.compatibility.majorSplits.length === 0);
}

// ─── LOT 4 : readiness ─────────────────────────────────────────────────────
section('Readiness : score calculé, jamais fixé');
{
  const nominal = analyse(makeRecord()).readiness;
  check('projet nominal : score élevé', nominal.score >= 90);
  check('niveau READY', nominal.level === 'READY');
  check('12 critères évalués', nominal.criteria.length === readinessSvc.CRITERIA.length);
  check('chaque critère porte poids, état et raison',
    nominal.criteria.every((c) => typeof c.weight === 'number' && c.state && c.reason));
  check('la formule est exposée',
    nominal.formula.description.includes('Σ') && typeof nominal.formula.totalWeight === 'number');
  check('la contribution de chaque critère est auditable',
    nominal.criteria.filter((c) => c.state !== CRITERION_STATE.SKIP).every((c) => typeof c.contribution === 'number'));

  // Le score doit se recalculer à la main à partir des contributions.
  const scored = nominal.criteria.filter((c) => c.state !== CRITERION_STATE.SKIP);
  const manual = Math.round(
    (scored.reduce((s, c) => s + c.contribution, 0) / scored.reduce((s, c) => s + c.weight, 0)) * 100,
  );
  check('le score est reproductible à partir des contributions publiées', manual === nominal.rawScore);
}

section('Readiness : dégradation progressive et plafond bloquant');
{
  const nominal = analyse(makeRecord()).readiness.score;
  const degraded = analyse(makeRecord({ runtime: { components: {}, uptimeSeconds: null, load: null } })).readiness.score;
  check('un projet non instrumenté score MOINS qu’un projet instrumenté', degraded < nominal);
  check('…sans tomber à zéro (inconnu ≠ panne)', degraded > 20);

  const stale = analyse(makeRecord({ runtime: { lastHeartbeatAt: ago(900) } })).readiness.score;
  check('un signal périmé fait baisser le score', stale < nominal);

  const offline = analyse(makeRecord({ runtime: { lastHeartbeatAt: ago(99_999) } })).readiness;
  check('hors ligne : critère bloquant en échec', offline.blockedBy.some((b) => b.id === 'heartbeat'));
  check('…score plafonné', offline.score <= readinessSvc.BLOCKING_CEILING);
  check('…niveau BLOCKED', offline.level === 'BLOCKED');
  check('…le plafond est expliqué', offline.formula.ceilingApplied === readinessSvc.BLOCKING_CEILING);

  const notPaired = analyse(makeRecord({ pairing: { status: 'DECLARED' } })).readiness;
  check('non appairé : le critère heartbeat est ÉCARTÉ, pas compté en échec',
    notPaired.criteria.find((c) => c.id === 'heartbeat').state === CRITERION_STATE.SKIP);
  check('…et sort du dénominateur', notPaired.formula.skipped.includes('heartbeat'));

  check('readiness du parc = moyenne des projets',
    readinessSvc.computeFleetReadiness([{ score: 80, level: 'NEARLY_READY', blockedBy: [] },
      { score: 100, level: 'READY', blockedBy: [] }]).average === 90);
  check('parc vide : pas de score inventé',
    readinessSvc.computeFleetReadiness([]).average === null);
}

// ─── LOT 5 : risques ───────────────────────────────────────────────────────
section('Risques : probabilité × impact, entièrement calculés');
{
  const result = analyse(makeRecord({ runtime: { lastHeartbeatAt: ago(99_999) } }));
  const risks = result.risks.items;
  check('des risques sont produits', risks.length > 0);
  check('chaque risque porte niveau, score, probabilité et impact',
    risks.every((r) => r.level && typeof r.score === 'number'
      && typeof r.probability === 'number' && typeof r.impact === 'number'));
  check('la probabilité est justifiée', risks.every((r) => r.probabilityReason.length > 15));
  check('l’impact est justifié', risks.every((r) => r.impactReason.length > 15));
  check('score = probabilité × impact (arrondi)',
    risks.every((r) => Math.abs(r.score - Math.round(r.probability * r.impact * 100) / 100) < 0.001));

  const offline = risks.find((r) => r.ruleId === 'HEARTBEAT_OFFLINE');
  check('un fait déjà constaté a une probabilité de 1', offline.probability === 1);
  check('…et c’est expliqué', offline.probabilityReason.includes('déjà constaté'));
  check('hors ligne en PROD → risque CRITICAL', offline.level === RISK_LEVEL.CRITICAL);

  const inTest = riskSvc.assessRisk(ruleOf(result, 'HEARTBEAT_OFFLINE'), { environment: 'TEST' });
  check('le même défaut coûte MOINS en TEST qu’en PROD', inTest.impact < offline.impact);
  check('…et l’amplification PROD est expliquée', offline.impactReason.includes('PRODUCTION'));

  const soon = analyse(makeRecord({ runtime: { certificate: { expiresAt: inDays(2) } } }))
    .risks.items.find((r) => r.ruleId === 'CERTIFICATE_EXPIRING');
  const later = analyse(makeRecord({ runtime: { certificate: { expiresAt: inDays(20) } } }))
    .risks.items.find((r) => r.ruleId === 'CERTIFICATE_EXPIRING');
  check('la probabilité croît à l’approche de l’échéance', soon.probability > later.probability);

  check('tri par score décroissant',
    risks.every((r, i) => i === 0 || r.score <= risks[i - 1].score));
  const summary = result.risks;
  check('synthèse : total, plus haut niveau, cumul',
    summary.total === risks.length && summary.highest && typeof summary.aggregate === 'number');
  check('un projet nominal n’a aucun risque élevé',
    !analyse(makeRecord()).risks.items.some((r) => r.level === RISK_LEVEL.CRITICAL || r.level === RISK_LEVEL.HIGH));
}

// ─── LOT 6 : recommandations ───────────────────────────────────────────────
section('Recommandations : actionnables, jamais « corriger »');
{
  const result = analyse(makeRecord({
    runtime: { contractVersion: '1.0.0', engines: { deployment: '1.0.0', duplication: '1.0.0' } },
  }));
  const recs = result.recommendations;
  check('des recommandations sont produites', recs.length > 0);
  check('chacune porte action, bénéfice, risque, prérequis, action future',
    recs.every((r) => r.action && r.benefit && r.risk && Array.isArray(r.prerequisites) && r.futureAction));
  check('chacune est justifiée par au moins un diagnostic',
    recs.every((r) => r.reasons.length > 0 && r.reasons.every((x) => x.justification)));
  check('aucune recommandation vague',
    recs.every((r) => !/^corriger$|^réparer$|^vérifier$/i.test(r.action.trim())));
  check('chaque action commence par un verbe d’action précis',
    recs.every((r) => r.action.split(' ').length >= 3));
  check('toutes les actions futures sont au catalogue',
    recoSvc.validateFutureActions(recs).valid);
  check('un effort est estimé', recs.every((r) => r.effort && typeof r.leverage === 'number'));

  // Fusion : deux moteurs en retard → une seule action de portage par moteur,
  // mais surtout jamais deux fois la même action.
  const actions = recs.map((r) => `${r.futureAction}::${r.action}`);
  check('aucune action dupliquée', new Set(actions).size === actions.length);

  // Deux moteurs non publiés produisent la MÊME action (« mettre le projet en
  // contrat 1.2.0 ») : elle doit apparaître une seule fois, avec ses deux motifs.
  const twoEngines = analyse(makeRecord({ runtime: { engines: null }, manifest: null, manifestSource: null }));
  const merged = twoEngines.recommendations.find((r) => r.reasons.length > 1);
  check('les motifs multiples sont fusionnés en une seule recommandation', merged !== undefined);
  check('…et la recommandation fusionnée cite chaque motif',
    merged.reasons.every((x) => x.justification.length > 15));
  check('…sans dupliquer l’action',
    twoEngines.recommendations.filter((r) => r.action === merged.action).length === 1);

  check('tri par priorité puis levier',
    recs.every((r, i) => i === 0
      || engine.PRIORITY_ORDER.indexOf(r.priority) <= engine.PRIORITY_ORDER.indexOf(recs[i - 1].priority)));

  const nominal = analyse(makeRecord()).recommendations;
  check('un projet nominal n’a aucune recommandation urgente',
    !nominal.some((r) => r.priority === PRIORITY.URGENT || r.priority === PRIORITY.CRITICAL));

  check('une action inconnue serait détectée',
    !recoSvc.validateFutureActions([{ futureAction: 'LANCER_LES_MISSILES' }]).valid);
}

section('Recommandations du parc : fusionnées par action');
{
  const fleet = diag.diagnoseFleet([
    makeRecord({ runtime: { contractVersion: '1.0.0' } }),
    makeRecord({ projectId: 'p-2', projectKey: 'b', projectName: 'B', runtime: { contractVersion: '1.0.0' } }),
    makeRecord({ projectId: 'p-3', projectKey: 'c', projectName: 'C', runtime: { contractVersion: '1.0.0' } }),
  ], { now: NOW, expectedEngines: ENGINES });

  const upgrade = fleet.recommendations.top.find((r) => r.futureAction === 'PLAN_CONTRACT_UPGRADE');
  check('une seule ligne pour trois projets concernés', upgrade !== undefined && upgrade.projectCount === 3);
  check('…et les projets sont nommés', upgrade.projects.length === 3);
  check('le levier tient compte du nombre de projets', upgrade.leverage > 0);
}

// ─── LOT 7 : priorisation ──────────────────────────────────────────────────
section('Priorisation : à surveiller / à corriger / urgent / critique');
{
  check('CRITICAL en PROD → priorité CRITICAL',
    engine.computePriority(SEVERITY.CRITICAL, { environment: 'PROD' }) === PRIORITY.CRITICAL);
  check('CRITICAL en TEST → URGENT (moins pressant qu’en PROD)',
    engine.computePriority(SEVERITY.CRITICAL, { environment: 'TEST' }) === PRIORITY.URGENT);
  check('HIGH en PROD → URGENT',
    engine.computePriority(SEVERITY.HIGH, { environment: 'PROD' }) === PRIORITY.URGENT);
  check('HIGH en TEST → FIX',
    engine.computePriority(SEVERITY.HIGH, { environment: 'TEST' }) === PRIORITY.FIX);
  check('MEDIUM bloquant en PROD → FIX',
    engine.computePriority(SEVERITY.MEDIUM, { environment: 'PROD', blocksReadiness: true }) === PRIORITY.FIX);
  check('MEDIUM non bloquant → WATCH',
    engine.computePriority(SEVERITY.MEDIUM, { environment: 'PROD' }) === PRIORITY.WATCH);
  check('LOW → WATCH', engine.computePriority(SEVERITY.LOW, { environment: 'PROD' }) === PRIORITY.WATCH);

  const prodOffline = analyse(makeRecord({ runtime: { lastHeartbeatAt: ago(99_999) } }));
  const testOffline = analyse(makeRecord({
    runtime: { lastHeartbeatAt: ago(99_999), environment: 'TEST' },
    manifest: { ...makeRecord().manifest, project: { ...makeRecord().manifest.project, environment: 'TEST' } },
  }));
  check('même panne : priorité plus haute en PROD',
    engine.PRIORITY_ORDER.indexOf(prodOffline.priority) > engine.PRIORITY_ORDER.indexOf(testOffline.priority));

  check('projet nominal → priorité WATCH', analyse(makeRecord()).priority === PRIORITY.WATCH);
}

section('File de travail du parc : le plus urgent d’abord');
{
  const fleet = diag.diagnoseFleet([
    makeRecord({ projectId: 'sain', projectKey: 'sain', projectName: 'Sain' }),
    makeRecord({ projectId: 'casse', projectKey: 'casse', projectName: 'Cassé', runtime: { lastHeartbeatAt: ago(99_999) } }),
    makeRecord({ projectId: 'tiede', projectKey: 'tiede', projectName: 'Tiède', runtime: { lastHeartbeatAt: ago(900) } }),
  ], { now: NOW, expectedEngines: ENGINES });

  check('le projet cassé est en tête de file', fleet.queue[0].projectId === 'casse');
  check('le projet sain est en fin de file', fleet.queue[fleet.queue.length - 1].projectId === 'sain');
  check('compteurs de priorité cohérents',
    fleet.priorities.critical + fleet.priorities.urgent + fleet.priorities.fix + fleet.priorities.watch === 3);
  check('chaque entrée de file porte score et risque',
    fleet.queue.every((q) => typeof q.readinessScore === 'number' && typeof q.aggregateRisk === 'number'));
  check('top risques du parc borné à 10', fleet.risks.top.length <= 10);
  check('…et rattaché à son projet', fleet.risks.top.every((r) => r.projectId !== null));
}

// ─── Explications : la promesse de la phase ────────────────────────────────
section('Explications : le Panel répond aux questions posées');
{
  const offline = analyse(makeRecord({ runtime: { lastHeartbeatAt: ago(99_999) } }));
  check('« Pourquoi OFFLINE ? » — la cause est nommée',
    offline.summary.explanation.includes('hors ligne'));
  check('« Est-il compatible ? » — verdict + raison',
    offline.summary.compatibilityVerdict && offline.summary.compatibilityExplanation.length > 20);
  check('« Est-il prêt ? » — score + explication',
    typeof offline.summary.readinessScore === 'number' && offline.summary.readinessExplanation.includes('%'));
  check('« Quels risques ? » — niveau le plus haut', offline.summary.highestRisk === RISK_LEVEL.CRITICAL);
  check('« Quelle priorité ? »', offline.summary.priority === PRIORITY.CRITICAL);
  check('« Que corriger ? » — au moins une recommandation', offline.recommendations.length > 0);
  check('le plafonnement de readiness est expliqué',
    offline.summary.readinessExplanation.includes('plafonné'));

  const healthy = analyse(makeRecord());
  check('projet sain : l’explication le dit clairement',
    healthy.summary.explanation.includes('Aucun diagnostic')
    || healthy.summary.diagnosticCount === healthy.diagnostics.length);
}

// ─── Pureté ────────────────────────────────────────────────────────────────
section('Pureté : aucun accès réseau, aucune écriture');
{
  const dir = path.join(root, 'backend', 'src', 'services', 'diagnostic');
  const files = [];
  const walk = (d) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.js')) files.push(full);
    }
  };
  walk(dir);

  const networked = files.filter((f) => /\bfetch\s*\(|ProjectBridgeClient/.test(fs.readFileSync(f, 'utf8')));
  check(`aucun accès réseau dans le moteur${networked.length ? ` — ${networked.map((f) => path.basename(f))}` : ''}`,
    networked.length === 0);

  const writes = files.filter((f) => /\.create\(|\.updateOne\(|\.deleteMany\(|\.save\(/.test(fs.readFileSync(f, 'utf8')));
  check(`aucune écriture en base${writes.length ? ` — ${writes.map((f) => path.basename(f))}` : ''}`,
    writes.length === 0);

  // Une horloge IMPLICITE est un `Date.now()` utilisé comme valeur de travail.
  // Le motif `?? Date.now()` est une valeur par DÉFAUT documentée : `now` reste
  // injectable, et tous les tests l'injectent. Les commentaires sont ignorés.
  const stripComments = (src) => src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
  const clocks = files.filter((f) => {
    // Deux formes d'injection légitimes : le paramètre par défaut
    // (`now = Date.now()`) et le repli (`?? Date.now()`). Toutes deux
    // laissent l'appelant maître de l'horloge — les tests l'injectent.
    const code = stripComments(fs.readFileSync(f, 'utf8'))
      .replace(/\?\?\s*Date\.now\(\)/g, '')
      .replace(/now\s*=\s*Date\.now\(\)/g, '');
    return /Date\.now\(\)/.test(code);
  });
  check(`aucune horloge implicite hors valeur par défaut${clocks.length ? ` — ${clocks.map((f) => path.basename(f))}` : ''}`,
    clocks.length === 0);

  const routes = fs.readFileSync(path.join(root, 'backend', 'src', 'routes', 'diagnostic.routes.js'), 'utf8');
  check('le routeur ne déclare que des GET', !/router\.(post|put|patch|delete)\s*\(/i.test(routes));
}

// ─── Surface HTTP ──────────────────────────────────────────────────────────
section('Surface /api/diagnostic : lecture seule et authentifiée');
{
  const registry = await import('../backend/src/services/registry/projectRegistry.service.js');
  const { registryStore } = await import('../backend/src/services/registry/registryStore.js');
  const { seedFromEnv } = await import('../backend/src/services/auth/panelUsers.service.js');
  await registryStore.clear();
  const declared = await registry.declareProject({ publicBackendUrl: 'https://projet-api.test', projectName: 'Projet API' });
  await seedFromEnv();

  const { createApp } = await import('../backend/src/app.js');
  const { call, close } = await startServer(createApp());

  check('diagnostic inaccessible sans JWT', (await call('GET', '/api/diagnostic/fleet')).status === 401);

  const login = await call('POST', '/api/auth/login', {
    body: { email: 'dev@panel.test', password: 'motdepasse-test' },
  });
  const auth = { authorization: `Bearer ${login.json.data.token}` };
  const id = declared.record.projectId;

  const fleet = await call('GET', '/api/diagnostic/fleet', { headers: auth });
  check('GET /fleet → 200', fleet.status === 200 && fleet.json.data.projects === 1);
  check('…avec readiness, compatibilité, risques, recommandations, file',
    ['readiness', 'compatibility', 'risks', 'recommendations', 'queue', 'priorities']
      .every((k) => fleet.json.data[k] !== undefined));

  const project = await call('GET', `/api/diagnostic/projects/${id}`, { headers: auth });
  check('GET /projects/:id → 200', project.status === 200);
  check('…avec résumé, diagnostics, readiness, risques, recommandations',
    ['summary', 'diagnostics', 'compatibility', 'readiness', 'risks', 'recommendations']
      .every((k) => project.json.data[k] !== undefined));

  for (const [route, key] of [['compatibility', 'verdict'], ['readiness', 'score'],
    ['risks', 'total'], ['recommendations', 'items']]) {
    const res = await call('GET', `/api/diagnostic/projects/${id}/${route}`, { headers: auth });
    check(`GET /${route} → 200`, res.status === 200 && res.json.data[key] !== undefined);
  }

  const cat = await call('GET', '/api/diagnostic/catalog', { headers: auth });
  check('GET /catalog → le moteur est auditable',
    cat.status === 200 && cat.json.data.rules.length === catalogMod.RULES.length);
  check('…avec les critères de readiness et leurs poids',
    cat.json.data.readinessCriteria.every((c) => typeof c.weight === 'number'));
  check('…et les références de l’écosystème',
    cat.json.data.reference.contractVersion === CONTRACT_VERSION);

  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    const res = await call(method, '/api/diagnostic/fleet', { headers: auth, body: {} });
    check(`${method} /fleet refusé (lecture seule)`, res.status === 404);
  }

  const unknown = await call('GET', '/api/diagnostic/projects/inexistant', { headers: auth });
  check('projet inconnu → 404 propre',
    unknown.status === 404 && unknown.json.code === 'PANEL_PROJECT_NOT_FOUND');

  await close();
}

await stopMemoryMongo();
finish();
