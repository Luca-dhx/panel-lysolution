// RISQUES — service PUR.
//
// Un risque n'est pas un diagnostic : le diagnostic dit **ce qui est**, le
// risque dit **ce qui peut arriver et à quel point ça coûterait**.
//
// Chaque risque est CALCULÉ à partir d'un diagnostic, jamais listé en dur.
// Sa cotation combine deux dimensions :
//
//   probabilité — quelle chance que le problème se matérialise ?
//   impact      — quelle gravité si c'est le cas ?
//
// Ces deux dimensions sont dérivées de la gravité du diagnostic et du
// contexte (PROD/TEST). Le produit donne un score, le score donne un niveau.
import { SEVERITY, SEVERITY_WEIGHT } from './rules/engine.js';

export const RISK_LEVEL = Object.freeze({
  CRITICAL: 'CRITICAL',
  HIGH: 'HIGH',
  MEDIUM: 'MEDIUM',
  LOW: 'LOW',
  INFO: 'INFO',
});

export const RISK_LEVEL_ORDER = Object.freeze([
  RISK_LEVEL.INFO, RISK_LEVEL.LOW, RISK_LEVEL.MEDIUM, RISK_LEVEL.HIGH, RISK_LEVEL.CRITICAL,
]);

/**
 * Probabilité de matérialisation, dérivée de la nature du diagnostic.
 *
 * Certains diagnostics décrivent un problème DÉJÀ matérialisé (un certificat
 * expiré, un projet hors ligne) : leur probabilité est de 1. D'autres
 * décrivent une exposition (un certificat expirant, un moteur en retard) :
 * leur probabilité dépend de l'échéance.
 */
export function probabilityOf(diagnostic) {
  // Un fait déjà constaté est certain, par définition.
  const REALISED = new Set([
    'HEARTBEAT_OFFLINE', 'CERTIFICATE_EXPIRED', 'CONTRACT_MAJOR_MISMATCH',
    'COMPONENT_ERROR', 'NEVER_SEEN', 'MANIFEST_MISSING',
    'DEPLOYMENT_ENGINE_MAJOR_DRIFT', 'DUPLICATION_ENGINE_MAJOR_DRIFT',
  ]);
  if (REALISED.has(diagnostic.ruleId)) return { value: 1, reason: 'Le problème est déjà constaté, pas seulement probable.' };

  // Certificat expirant : la probabilité croît à mesure que l'échéance approche.
  if (diagnostic.ruleId === 'CERTIFICATE_EXPIRING') {
    const days = diagnostic.facts?.daysLeft ?? 30;
    const value = days <= 3 ? 0.95 : days <= 7 ? 0.8 : days <= 14 ? 0.6 : 0.4;
    return { value, reason: `Échéance dans ${days} jour(s) : la probabilité croît avec l’approche du terme.` };
  }

  // Signal périmé : peut se rétablir seul, ou basculer hors ligne.
  if (diagnostic.ruleId === 'HEARTBEAT_STALE') {
    return { value: 0.5, reason: 'Le signal peut se rétablir seul, ou se dégrader jusqu’au hors ligne.' };
  }

  // Défaut d'observabilité : le risque n'est pas que ça casse, mais qu'on ne
  // le voie pas si ça casse. Probabilité modérée, impact réel.
  if (diagnostic.category === 'OBSERVABILITY') {
    return { value: 0.35, reason: 'Le défaut d’instrumentation ne cause pas la panne : il en retarde la détection.' };
  }

  // Sinon : proportionnelle à la gravité.
  const value = Math.min(0.9, 0.2 + SEVERITY_WEIGHT[diagnostic.severity] / 20);
  return { value, reason: `Probabilité dérivée de la gravité ${diagnostic.severity}.` };
}

/**
 * Impact — la gravité du diagnostic, amplifiée en production.
 *
 * Un même défaut ne coûte pas la même chose selon l'environnement : c'est la
 * seule variable contextuelle du calcul, et elle est explicite.
 */
export function impactOf(diagnostic, { environment } = {}) {
  const base = SEVERITY_WEIGHT[diagnostic.severity] ?? 0;
  const isProd = environment === 'PROD';
  const multiplier = isProd ? 1.5 : 1;
  return {
    value: base * multiplier,
    reason: isProd
      ? `Gravité ${diagnostic.severity} (poids ${base}), amplifiée × 1,5 car le projet est en PRODUCTION.`
      : `Gravité ${diagnostic.severity} (poids ${base}), environnement ${environment ?? 'inconnu'} : aucune amplification.`,
  };
}

/** Niveau de risque à partir du score. Seuils fixes, documentés. */
export function levelOf(score) {
  if (score >= 12) return RISK_LEVEL.CRITICAL;
  if (score >= 7) return RISK_LEVEL.HIGH;
  if (score >= 3) return RISK_LEVEL.MEDIUM;
  if (score >= 1) return RISK_LEVEL.LOW;
  return RISK_LEVEL.INFO;
}

/**
 * Transforme un diagnostic en risque coté.
 *
 * Le résultat porte TOUT le calcul : probabilité, impact, score, niveau, et
 * les raisons de chacun. Un opérateur peut refaire le calcul à la main.
 */
export function assessRisk(diagnostic, context = {}) {
  const probability = probabilityOf(diagnostic);
  const impact = impactOf(diagnostic, context);
  const score = Math.round(probability.value * impact.value * 100) / 100;
  return {
    id: `RISK_${diagnostic.ruleId}`,
    diagnosticId: diagnostic.id,
    ruleId: diagnostic.ruleId,
    title: diagnostic.title,
    category: diagnostic.category,
    component: diagnostic.component,
    level: levelOf(score),
    score,
    probability: probability.value,
    probabilityReason: probability.reason,
    impact: impact.value,
    impactReason: impact.reason,
    // L'exposition : ce qui se passe si rien n'est fait.
    exposure: diagnostic.impact,
    justification: diagnostic.justification,
    evaluatedAt: diagnostic.evaluatedAt,
  };
}

/** Risques d'un projet, du plus coté au moins coté (tri déterministe). */
export function assessRisks(diagnostics, context = {}) {
  return diagnostics
    .map((d) => assessRisk(d, context))
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
}

/** Synthèse des risques d'un ensemble (projet ou parc). */
export function summariseRisks(risks) {
  const byLevel = risks.reduce((acc, r) => ({ ...acc, [r.level]: (acc[r.level] ?? 0) + 1 }), {});
  const highest = risks.reduce(
    (top, r) => (RISK_LEVEL_ORDER.indexOf(r.level) > RISK_LEVEL_ORDER.indexOf(top) ? r.level : top),
    RISK_LEVEL.INFO,
  );
  return {
    total: risks.length,
    highest: risks.length > 0 ? highest : null,
    // Score cumulé : distingue « un gros risque » de « dix petits ».
    aggregate: Math.round(risks.reduce((sum, r) => sum + r.score, 0) * 100) / 100,
    byLevel: {
      critical: byLevel[RISK_LEVEL.CRITICAL] ?? 0,
      high: byLevel[RISK_LEVEL.HIGH] ?? 0,
      medium: byLevel[RISK_LEVEL.MEDIUM] ?? 0,
      low: byLevel[RISK_LEVEL.LOW] ?? 0,
      info: byLevel[RISK_LEVEL.INFO] ?? 0,
    },
  };
}

export default { RISK_LEVEL, assessRisk, assessRisks, summariseRisks, probabilityOf, impactOf, levelOf };
