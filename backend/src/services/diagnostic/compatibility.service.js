// COMPATIBILITÉ — le projet parle-t-il la même langue que l'écosystème ?
//
// Service PUR : aucune E/S, aucun réseau, aucune écriture. Toutes les
// comparaisons sont faites sur des versions déjà reçues.
//
// Chaque verdict est EXPLIQUÉ : on ne dit jamais « incompatible » sans dire
// quelles valeurs ont été comparées et selon quelle règle.
import { compareVersions, parseVersion } from './rules/catalog.js';

/** Verdicts possibles, du meilleur au pire. */
export const VERDICT = Object.freeze({
  COMPATIBLE: 'COMPATIBLE',
  COMPATIBLE_WITH_WARNING: 'COMPATIBLE_WITH_WARNING',
  MIGRATION_AVAILABLE: 'MIGRATION_AVAILABLE',
  VERSION_AHEAD: 'VERSION_AHEAD',
  VERSION_TOO_OLD: 'VERSION_TOO_OLD',
  INCOMPATIBLE: 'INCOMPATIBLE',
  UNKNOWN: 'UNKNOWN',
});

const VERDICT_ORDER = Object.freeze([
  VERDICT.COMPATIBLE,
  VERDICT.MIGRATION_AVAILABLE,
  VERDICT.COMPATIBLE_WITH_WARNING,
  VERDICT.VERSION_AHEAD,
  VERDICT.UNKNOWN,
  VERDICT.VERSION_TOO_OLD,
  VERDICT.INCOMPATIBLE,
]);

/** Le verdict global est le PIRE des verdicts individuels. */
export function worstVerdict(verdicts) {
  return verdicts.reduce(
    (worst, v) => (VERDICT_ORDER.indexOf(v) > VERDICT_ORDER.indexOf(worst) ? v : worst),
    VERDICT.COMPATIBLE,
  );
}

/** Un verdict bloque-t-il l'interopérabilité ? */
export function isBlocking(verdict) {
  return verdict === VERDICT.INCOMPATIBLE || verdict === VERDICT.VERSION_TOO_OLD;
}

/**
 * Compare une version de projet à une version de référence, selon la règle
 * semver de l'écosystème : **même majeure exigée**, mineure inférieure
 * tolérée (les évolutions sont additives).
 *
 * @param {string|null} actual     version embarquée par le projet
 * @param {string|null} reference  version de référence (Panel / standard)
 * @param {string|null} minimum    version minimale supportée, si connue
 */
export function compareAgainstReference(actual, reference, minimum = null) {
  const a = parseVersion(actual);
  const r = parseVersion(reference);

  if (!actual) {
    return {
      verdict: VERDICT.UNKNOWN,
      reason: 'Le projet n’a pas publié cette version : la compatibilité ne peut pas être établie.',
      actual: null,
      reference: reference ?? null,
    };
  }
  if (!a) {
    return {
      verdict: VERDICT.UNKNOWN,
      reason: `La valeur publiée « ${actual} » n’est pas une version sémantique valide.`,
      actual,
      reference: reference ?? null,
    };
  }
  if (!r) {
    return {
      verdict: VERDICT.UNKNOWN,
      reason: 'Aucune version de référence n’est connue du Panel : aucune comparaison possible.',
      actual,
      reference: null,
    };
  }

  if (a.major !== r.major) {
    return {
      verdict: VERDICT.INCOMPATIBLE,
      reason: `Majeures différentes : projet ${actual}, référence ${reference}. Une majeure est une rupture par définition — l’interopérabilité n’est pas garantie.`,
      actual,
      reference,
    };
  }

  if (minimum && compareVersions(actual, minimum) < 0) {
    return {
      verdict: VERDICT.VERSION_TOO_OLD,
      reason: `Version ${actual} antérieure au minimum supporté ${minimum} : le support n’est plus assuré.`,
      actual,
      reference,
      minimum,
    };
  }

  const cmp = compareVersions(actual, reference);
  if (cmp === 0) {
    return {
      verdict: VERDICT.COMPATIBLE,
      reason: `Version ${actual} identique à la référence.`,
      actual,
      reference,
    };
  }
  if (cmp > 0) {
    return {
      verdict: VERDICT.VERSION_AHEAD,
      reason: `Le projet (${actual}) est plus récent que la référence (${reference}) : c’est le Panel qui est en retard. Les échanges fonctionnent, mais le Panel ignore les champs qu’il ne connaît pas.`,
      actual,
      reference,
    };
  }

  // Mineure ou correctif en retard : compatible, une migration existe.
  const behindMinor = a.minor < r.minor;
  return {
    verdict: behindMinor ? VERDICT.MIGRATION_AVAILABLE : VERDICT.COMPATIBLE_WITH_WARNING,
    reason: behindMinor
      ? `Version ${actual} en retard sur ${reference} (mineure). Les évolutions étant additives, les échanges fonctionnent ; une mise à jour apporterait les capacités ajoutées depuis.`
      : `Version ${actual} en retard sur ${reference} (correctif). Les échanges fonctionnent ; la mise à jour apporte des corrections.`,
    actual,
    reference,
  };
}

/**
 * COMPATIBILITÉ COMPLÈTE d'un projet, axe par axe.
 *
 * @param {object} context { project, record, panel }
 * @returns {{ verdict, blocking, axes: object[], reason }}
 */
export function assessCompatibility(context) {
  const { project, record, panel } = context;
  const versions = project?.versions ?? {};
  const axes = [];

  // — Contrat de pont ------------------------------------------------------
  axes.push({
    axis: 'bridge',
    label: 'Contrat de pont',
    ...compareAgainstReference(versions.contract, panel?.contractVersion, panel?.minimumContractVersion),
  });

  // — Moteurs standards ----------------------------------------------------
  axes.push({
    axis: 'deploymentEngine',
    label: 'Moteur de déploiement',
    ...compareAgainstReference(versions.deploymentEngine, panel?.engines?.deployment, panel?.minimumEngineVersion),
  });
  axes.push({
    axis: 'duplicationEngine',
    label: 'Moteur de duplication',
    ...compareAgainstReference(versions.duplicationEngine, panel?.engines?.duplication, panel?.minimumEngineVersion),
  });

  // — Format de Manifest ---------------------------------------------------
  axes.push({
    axis: 'manifestFormat',
    label: 'Format de Manifest',
    ...compareAgainstReference(versions.manifestFormat, panel?.manifestFormatVersion),
  });

  // — Manifest : présence et autorité --------------------------------------
  if (!record?.manifest) {
    axes.push({
      axis: 'manifest',
      label: 'Manifest',
      verdict: VERDICT.UNKNOWN,
      reason: 'Aucun Manifest publié : les capacités et la topologie du projet sont inconnues.',
      actual: null,
      reference: null,
    });
  } else if (record.manifestSource === 'MANUAL') {
    axes.push({
      axis: 'manifest',
      label: 'Manifest',
      verdict: VERDICT.COMPATIBLE_WITH_WARNING,
      reason: 'Manifest saisi manuellement : il peut diverger de la réalité du projet sans être détecté.',
      actual: 'MANUAL',
      reference: 'BRIDGE',
    });
  } else {
    axes.push({
      axis: 'manifest',
      label: 'Manifest',
      verdict: VERDICT.COMPATIBLE,
      reason: 'Manifest transmis par le pont : il fait autorité et ne peut pas diverger.',
      actual: 'BRIDGE',
      reference: 'BRIDGE',
    });
  }

  // — Layout : topologie déclarée ------------------------------------------
  if (!project?.layout) {
    axes.push({
      axis: 'layout',
      label: 'Topologie',
      verdict: VERDICT.UNKNOWN,
      reason: 'Le projet ne déclare pas sa topologie : le Panel ne sait pas de quelles applications il se compose.',
      actual: null,
      reference: null,
    });
  } else {
    axes.push({
      axis: 'layout',
      label: 'Topologie',
      verdict: VERDICT.COMPATIBLE,
      reason: `Topologie déclarée : ${project.layout}.`,
      actual: project.layout,
      reference: null,
    });
  }

  const verdict = worstVerdict(axes.map((a) => a.verdict));
  const blockingAxes = axes.filter((a) => isBlocking(a.verdict));

  return {
    verdict,
    blocking: blockingAxes.length > 0,
    axes,
    // Explication globale : elle NOMME l'axe responsable, jamais un verdict nu.
    reason: blockingAxes.length > 0
      ? `Incompatibilité bloquante sur : ${blockingAxes.map((a) => a.label).join(', ')}.`
      : verdict === VERDICT.COMPATIBLE
        ? 'Tous les axes sont alignés sur les références de l’écosystème.'
        : `Compatible, avec des réserves sur : ${axes.filter((a) => a.verdict !== VERDICT.COMPATIBLE).map((a) => a.label).join(', ')}.`,
  };
}

/**
 * COMPATIBILITÉ CROISÉE du parc — pas seulement projet ↔ Panel, mais aussi
 * projet ↔ projet. Un parc où chaque projet est compatible avec le Panel
 * mais où trois majeures de moteur coexistent est un parc fragmenté.
 */
export function assessFleetCompatibility(assessments) {
  const verdicts = assessments.map((a) => a.compatibility.verdict);
  const distinct = (axis, pick) => {
    const values = new Set();
    for (const a of assessments) {
      const value = pick(a);
      if (value) values.add(value);
    }
    return { axis, values: [...values].sort() };
  };

  const spreads = [
    distinct('bridge', (a) => a.project?.versions?.contract),
    distinct('deploymentEngine', (a) => a.project?.versions?.deploymentEngine),
    distinct('duplicationEngine', (a) => a.project?.versions?.duplicationEngine),
  ];

  const fragmented = spreads.filter((s) => s.values.length > 1);
  const majorSplits = spreads.filter(
    (s) => new Set(s.values.map((v) => parseVersion(v)?.major).filter((m) => m !== undefined)).size > 1,
  );

  return {
    verdict: worstVerdict(verdicts.length > 0 ? verdicts : [VERDICT.COMPATIBLE]),
    projects: assessments.length,
    blocking: assessments.filter((a) => a.compatibility.blocking).length,
    spreads,
    fragmented: fragmented.map((s) => s.axis),
    majorSplits: majorSplits.map((s) => s.axis),
    reason: majorSplits.length > 0
      ? `Le parc est scindé sur plusieurs majeures : ${majorSplits.map((s) => s.axis).join(', ')}. Les procédures standards ne s’appliquent pas uniformément.`
      : fragmented.length > 0
        ? `Le parc est hétérogène (mineures multiples) sur : ${fragmented.map((s) => s.axis).join(', ')}.`
        : assessments.length === 0
          ? 'Aucun projet à comparer.'
          : 'Le parc est homogène : toutes les versions sont alignées.',
  };
}

export default { VERDICT, assessCompatibility, assessFleetCompatibility, compareAgainstReference, worstVerdict, isBlocking };
