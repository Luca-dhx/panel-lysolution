// READINESS — score de préparation d'un projet.
//
// Service PUR. Le score est CALCULÉ, jamais fixé : il est entièrement dérivé
// de critères pondérés, et chaque critère porte son état ET sa raison.
//
// ── LA FORMULE ──────────────────────────────────────────────────────────────
//   score = Σ(poids × facteur(état)) / Σ(poids des critères ÉVALUABLES) × 100
//
//   facteurs : PASS = 1 · WARN = 0.5 · FAIL = 0 · UNKNOWN = 0.25
//
// Deux décisions structurantes, toutes deux discutables et donc documentées :
//
// 1. UNKNOWN vaut 0,25 et non 0. Ne pas savoir n'est pas équivalent à être
//    en panne. Mais ce n'est pas neutre non plus : un projet non instrumenté
//    ne peut pas prétendre au même score qu'un projet vérifié.
//
// 2. Un critère NON APPLICABLE (`SKIP`) sort du dénominateur. Sans cela, un
//    projet sans certificat publié serait pénalisé pour un critère qui ne le
//    concerne pas — le score cesserait de vouloir dire quelque chose.
//
// Un critère BLOQUANT en échec plafonne le score : on ne peut pas être « prêt
// à 90 % » si le pont est incompatible. Le plafond est explicite et expliqué.
import { VERDICT, isBlocking } from './compatibility.service.js';

export const CRITERION_STATE = Object.freeze({
  PASS: 'PASS',
  WARN: 'WARN',
  FAIL: 'FAIL',
  UNKNOWN: 'UNKNOWN',
  SKIP: 'SKIP',
});

const FACTOR = Object.freeze({
  [CRITERION_STATE.PASS]: 1,
  [CRITERION_STATE.WARN]: 0.5,
  [CRITERION_STATE.UNKNOWN]: 0.25,
  [CRITERION_STATE.FAIL]: 0,
});

/** Plafond appliqué au score quand un critère bloquant échoue. */
export const BLOCKING_CEILING = 40;

/**
 * CATALOGUE DES CRITÈRES — déclaratif, comme les règles.
 *
 * `weight`   importance relative ; seuls les rapports comptent
 * `blocking` un échec plafonne le score global
 * `evaluate(ctx)` → { state, reason }
 */
export const CRITERIA = Object.freeze([
  {
    id: 'bridge',
    label: 'Pont établi',
    weight: 10,
    blocking: true,
    evaluate: (ctx) => {
      const status = ctx.record?.pairing?.status;
      if (status === 'PAIRED') return { state: CRITERION_STATE.PASS, reason: 'Appairage actif.' };
      if (status === 'REVOKED') return { state: CRITERION_STATE.FAIL, reason: 'Appairage révoqué : le projet n’est plus supervisé.' };
      return { state: CRITERION_STATE.FAIL, reason: 'Projet déclaré mais jamais appairé.' };
    },
  },
  {
    id: 'compatibility',
    label: 'Compatibilité de l’écosystème',
    weight: 10,
    blocking: true,
    evaluate: (ctx) => {
      const c = ctx.compatibility;
      if (!c) return { state: CRITERION_STATE.UNKNOWN, reason: 'Compatibilité non évaluée.' };
      if (isBlocking(c.verdict)) return { state: CRITERION_STATE.FAIL, reason: c.reason };
      if (c.verdict === VERDICT.COMPATIBLE) return { state: CRITERION_STATE.PASS, reason: c.reason };
      if (c.verdict === VERDICT.UNKNOWN) return { state: CRITERION_STATE.UNKNOWN, reason: c.reason };
      return { state: CRITERION_STATE.WARN, reason: c.reason };
    },
  },
  {
    id: 'heartbeat',
    label: 'Signal de vie',
    weight: 9,
    blocking: true,
    evaluate: (ctx) => {
      switch (ctx.health?.liveness) {
        case 'ONLINE': return { state: CRITERION_STATE.PASS, reason: 'Signal reçu dans les délais.' };
        case 'STALE': return { state: CRITERION_STATE.WARN, reason: 'Dernier signal au-delà de la cadence attendue.' };
        case 'OFFLINE': return { state: CRITERION_STATE.FAIL, reason: 'Aucun signal depuis le seuil hors ligne.' };
        case 'NEVER_SEEN': return { state: CRITERION_STATE.FAIL, reason: 'Appairé, mais aucun signal jamais reçu.' };
        default: return { state: CRITERION_STATE.SKIP, reason: 'Projet non appairé : aucun signal attendu.' };
      }
    },
  },
  {
    id: 'backend',
    label: 'Backend',
    weight: 8,
    blocking: false,
    evaluate: (ctx) => {
      const status = ctx.record?.runtime?.lastHealth?.status;
      if (status === 'OK') return { state: CRITERION_STATE.PASS, reason: 'Le projet se déclare en bonne santé.' };
      if (status === 'DEGRADED') {
        return {
          state: CRITERION_STATE.WARN,
          reason: ctx.record.runtime.lastHealth.details || 'Le projet se déclare dégradé.',
        };
      }
      return { state: CRITERION_STATE.UNKNOWN, reason: 'Aucune santé publiée par le projet.' };
    },
  },
  {
    id: 'manifest',
    label: 'Manifest',
    weight: 7,
    blocking: false,
    evaluate: (ctx) => {
      if (!ctx.record?.manifest) return { state: CRITERION_STATE.FAIL, reason: 'Aucun Manifest publié ni saisi.' };
      if (ctx.record.manifestSource === 'MANUAL') {
        return { state: CRITERION_STATE.WARN, reason: 'Manifest saisi manuellement : il peut diverger du projet réel.' };
      }
      return { state: CRITERION_STATE.PASS, reason: 'Manifest transmis par le pont : il fait autorité.' };
    },
  },
  {
    id: 'engines',
    label: 'Moteurs standards',
    weight: 7,
    blocking: false,
    evaluate: (ctx) => {
      const axes = (ctx.compatibility?.axes ?? []).filter(
        (a) => a.axis === 'deploymentEngine' || a.axis === 'duplicationEngine',
      );
      if (axes.length === 0) return { state: CRITERION_STATE.UNKNOWN, reason: 'Versions de moteurs non évaluées.' };
      if (axes.some((a) => isBlocking(a.verdict))) {
        return { state: CRITERION_STATE.FAIL, reason: axes.find((a) => isBlocking(a.verdict)).reason };
      }
      if (axes.every((a) => a.verdict === VERDICT.COMPATIBLE)) {
        return { state: CRITERION_STATE.PASS, reason: 'Les deux moteurs sont alignés sur le standard.' };
      }
      if (axes.every((a) => a.verdict === VERDICT.UNKNOWN)) {
        return { state: CRITERION_STATE.UNKNOWN, reason: 'Le projet ne publie pas ses versions de moteurs.' };
      }
      return {
        state: CRITERION_STATE.WARN,
        reason: axes.filter((a) => a.verdict !== VERDICT.COMPATIBLE).map((a) => a.reason).join(' '),
      };
    },
  },
  {
    id: 'ssl',
    label: 'Certificat TLS',
    weight: 8,
    blocking: false,
    evaluate: (ctx) => {
      const expiry = ctx.record?.runtime?.certificate?.expiresAt;
      const declared = ctx.record?.runtime?.components?.ssl;
      if (expiry) {
        const days = Math.floor((new Date(expiry).getTime() - ctx.now) / 86_400_000);
        if (days < 0) return { state: CRITERION_STATE.FAIL, reason: `Certificat expiré depuis ${Math.abs(days)} jour(s).` };
        const threshold = ctx.panel?.certificateWarningDays ?? 21;
        if (days <= threshold) return { state: CRITERION_STATE.WARN, reason: `Certificat expirant dans ${days} jour(s).` };
        return { state: CRITERION_STATE.PASS, reason: `Certificat valide encore ${days} jour(s).` };
      }
      if (declared) return declaredState(declared, 'SSL');
      return { state: CRITERION_STATE.UNKNOWN, reason: 'Le projet ne publie ni état SSL ni date d’expiration.' };
    },
  },
  {
    id: 'dns',
    label: 'DNS et domaine',
    weight: 5,
    blocking: false,
    evaluate: (ctx) => {
      const declared = ctx.record?.runtime?.components?.dns;
      if (declared) return declaredState(declared, 'DNS');
      if (ctx.project?.primaryDomain) {
        return { state: CRITERION_STATE.UNKNOWN, reason: `Domaine connu (${ctx.project.primaryDomain}) mais état DNS non publié.` };
      }
      return { state: CRITERION_STATE.UNKNOWN, reason: 'Ni domaine ni état DNS publiés.' };
    },
  },
  {
    id: 'mongo',
    label: 'Base de données',
    weight: 8,
    blocking: false,
    evaluate: (ctx) => {
      const declared = ctx.record?.runtime?.components?.mongo;
      if (declared) return declaredState(declared, 'Base');
      return { state: CRITERION_STATE.UNKNOWN, reason: 'Le projet ne publie pas l’état de sa base.' };
    },
  },
  {
    id: 'frontend',
    label: 'Frontend',
    weight: 5,
    blocking: false,
    evaluate: (ctx) => {
      const declared = ctx.record?.runtime?.components?.frontend;
      if (declared) return declaredState(declared, 'Frontend');
      return { state: CRITERION_STATE.UNKNOWN, reason: 'Le projet ne publie pas l’état de son frontend.' };
    },
  },
  {
    id: 'components',
    label: 'Instrumentation',
    weight: 4,
    blocking: false,
    evaluate: (ctx) => {
      const declared = ctx.record?.runtime?.components;
      const count = declared ? Object.keys(declared).length : 0;
      if (count === 0) return { state: CRITERION_STATE.UNKNOWN, reason: 'Le projet ne publie l’état d’aucun composant.' };
      if (Object.values(declared).some((s) => s === 'ERROR')) {
        return { state: CRITERION_STATE.FAIL, reason: 'Au moins un composant publié est en erreur.' };
      }
      if (Object.values(declared).some((s) => s === 'WARNING' || s === 'UNKNOWN')) {
        return { state: CRITERION_STATE.WARN, reason: `${count} composant(s) publié(s), dont au moins un non nominal.` };
      }
      return { state: CRITERION_STATE.PASS, reason: `${count} composant(s) publié(s), tous nominaux.` };
    },
  },
  {
    id: 'network',
    label: 'Identité réseau',
    weight: 3,
    blocking: false,
    evaluate: (ctx) => {
      if (ctx.project?.primaryDomain) {
        return { state: CRITERION_STATE.PASS, reason: `Domaine public déclaré : ${ctx.project.primaryDomain}.` };
      }
      return { state: CRITERION_STATE.UNKNOWN, reason: 'Le projet ne publie pas son domaine public.' };
    },
  },
]);

function declaredState(status, label) {
  switch (status) {
    case 'OK': return { state: CRITERION_STATE.PASS, reason: `${label} : état OK publié par le projet.` };
    case 'WARNING': return { state: CRITERION_STATE.WARN, reason: `${label} : état WARNING publié par le projet.` };
    case 'ERROR': return { state: CRITERION_STATE.FAIL, reason: `${label} : état ERROR publié par le projet.` };
    default: return { state: CRITERION_STATE.UNKNOWN, reason: `${label} : état inconnu publié par le projet.` };
  }
}

/**
 * SCORE DE PRÉPARATION d'un projet.
 *
 * @param {object} context { project, record, health, compatibility, panel, now }
 * @returns {{ score, level, criteria, blockedBy, formula }}
 */
export function computeReadiness(context) {
  const criteria = CRITERIA.map((criterion) => {
    const { state, reason } = criterion.evaluate(context);
    return {
      id: criterion.id,
      label: criterion.label,
      weight: criterion.weight,
      blocking: criterion.blocking,
      state,
      reason,
      // Contribution réelle au score — rend le calcul auditable ligne à ligne.
      contribution: state === CRITERION_STATE.SKIP ? null : criterion.weight * FACTOR[state],
    };
  });

  const scored = criteria.filter((c) => c.state !== CRITERION_STATE.SKIP);
  const totalWeight = scored.reduce((sum, c) => sum + c.weight, 0);
  const earned = scored.reduce((sum, c) => sum + c.contribution, 0);
  const rawScore = totalWeight === 0 ? 0 : Math.round((earned / totalWeight) * 100);

  const blockedBy = criteria.filter((c) => c.blocking && c.state === CRITERION_STATE.FAIL);
  const score = blockedBy.length > 0 ? Math.min(rawScore, BLOCKING_CEILING) : rawScore;

  return {
    score,
    rawScore,
    level: levelOf(score, blockedBy.length > 0),
    blockedBy: blockedBy.map((c) => ({ id: c.id, label: c.label, reason: c.reason })),
    criteria,
    formula: {
      description: 'score = Σ(poids × facteur) / Σ(poids évaluables) × 100',
      factors: { PASS: 1, WARN: 0.5, UNKNOWN: 0.25, FAIL: 0 },
      earnedWeight: Math.round(earned * 100) / 100,
      totalWeight,
      skipped: criteria.filter((c) => c.state === CRITERION_STATE.SKIP).map((c) => c.id),
      ceilingApplied: blockedBy.length > 0 ? BLOCKING_CEILING : null,
    },
    evaluatedAt: new Date(context.now).toISOString(),
  };
}

/** Niveau lisible correspondant au score. */
export function levelOf(score, blocked = false) {
  if (blocked) return 'BLOCKED';
  if (score >= 90) return 'READY';
  if (score >= 70) return 'NEARLY_READY';
  if (score >= 50) return 'PARTIAL';
  return 'NOT_READY';
}

/** Readiness moyenne du parc — moyenne simple, chaque projet compte autant. */
export function computeFleetReadiness(readinessList) {
  if (readinessList.length === 0) {
    return { average: null, level: null, projects: 0, blocked: 0, distribution: {} };
  }
  const average = Math.round(
    readinessList.reduce((sum, r) => sum + r.score, 0) / readinessList.length,
  );
  const distribution = readinessList.reduce(
    (acc, r) => ({ ...acc, [r.level]: (acc[r.level] ?? 0) + 1 }),
    {},
  );
  return {
    average,
    level: levelOf(average),
    projects: readinessList.length,
    blocked: readinessList.filter((r) => r.blockedBy.length > 0).length,
    distribution,
  };
}

export default { CRITERIA, CRITERION_STATE, computeReadiness, computeFleetReadiness, levelOf, BLOCKING_CEILING };
