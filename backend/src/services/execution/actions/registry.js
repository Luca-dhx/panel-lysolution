// REGISTRE DÉCLARATIF DES ACTIONS — Phase 3C.
//
// ── LE CONTRAT D'EXTENSIBILITÉ ──────────────────────────────────────────────
// Ajouter une action à l'écosystème ne doit demander QUE trois choses :
//   1. son DESCRIPTEUR (ici) ;
//   2. son EXÉCUTEUR (`executors/<action>.js`) ;
//   3. ses POLITIQUES (déclarées dans le descripteur).
//
// Aucune modification du cœur. Le moteur ne contient aucun `switch` sur un
// type d'action, aucune branche `if (action === 'DEPLOY')`. Il lit ce
// registre, applique les politiques, appelle l'exécuteur.
//
// C'est vérifié par un test : le cœur ne doit citer aucun identifiant
// d'action.
import { RISK } from '../execution-policy.service.js';
import { outboundBaseUrl } from '../../registry/projectDestination.service.js';

/**
 * FORME D'UN DESCRIPTEUR
 *
 * {
 *   type            identifiant stable, jamais réutilisé
 *   label           libellé lisible
 *   description     ce que l'action fait, en une phrase
 *   category        regroupement d'interface
 *   target          'PROJECT' | 'PANEL' — sur quoi porte l'action
 *
 *   policy: {
 *     requiresConfirmation  bool
 *     allowedEnvironments   ['TEST','PROD']
 *     risk                  RISK.*
 *     rollbackable          bool
 *     timeoutMs             délai maximal d'exécution
 *     exclusive             bool — une seule à la fois sur la même cible
 *     exclusivityScope      'PROJECT' | 'GLOBAL'
 *     requiredReadiness     score minimal (null = aucun)
 *     blockOnDiagnostics    identifiants de règles 3B qui interdisent l'action
 *     prerequisites[]       { id, label, check(ctx) → {ok, reason} }
 *     confirmationsRequired nombre de confirmations (1 aujourd'hui, ≥2 plus tard)
 *   }
 *
 *   parameters      schéma déclaratif { nom: { required, type, description } }
 *   executor        identifiant du module d'exécution
 *   simulatable     bool — l'action sait-elle produire un plan sans agir ?
 *   futureActions[] étiquettes 3B qui mènent à cette action
 * }
 */

const ALWAYS_OK = { ok: true, reason: 'Prérequis satisfait.' };

/** Prérequis réutilisables — déclarés une fois, référencés partout. */
export const PREREQUISITES = Object.freeze({
  PAIRED: {
    id: 'paired',
    label: 'Projet appairé',
    check: (ctx) => (ctx.record?.pairing?.status === 'PAIRED'
      ? ALWAYS_OK
      : { ok: false, reason: `Le projet doit être appairé (statut actuel : ${ctx.record?.pairing?.status ?? 'inconnu'}).` }),
  },
  REACHABLE: {
    id: 'reachable',
    label: 'Projet joignable',
    check: (ctx) => (outboundBaseUrl(ctx.record)
      ? ALWAYS_OK
      : { ok: false, reason: 'Aucune URL publique connue pour ce projet : il ne peut pas être contacté.' }),
  },
  ONLINE: {
    id: 'online',
    label: 'Projet en ligne',
    check: (ctx) => (ctx.health?.liveness === 'ONLINE'
      ? ALWAYS_OK
      : { ok: false, reason: `Le projet doit émettre un signal récent (vivacité actuelle : ${ctx.health?.liveness ?? 'inconnue'}).` }),
  },
  COMPATIBLE_BRIDGE: {
    id: 'compatible-bridge',
    label: 'Contrat de pont compatible',
    check: (ctx) => {
      const axis = ctx.diagnosis?.compatibility?.axes?.find((a) => a.axis === 'bridge');
      if (!axis) return { ok: false, reason: 'Compatibilité de pont non évaluée.' };
      if (axis.verdict === 'INCOMPATIBLE' || axis.verdict === 'VERSION_TOO_OLD') {
        return { ok: false, reason: axis.reason };
      }
      return ALWAYS_OK;
    },
  },
  MANIFEST_PRESENT: {
    id: 'manifest-present',
    label: 'Manifest connu',
    check: (ctx) => (ctx.record?.manifest
      ? ALWAYS_OK
      : { ok: false, reason: 'Aucun Manifest publié : le Panel ne connaît pas la composition du projet.' }),
  },
  HAS_PREVIOUS_RELEASE: {
    id: 'has-previous-release',
    label: 'Release précédente disponible',
    check: (ctx) => (ctx.parameters?.releaseId
      ? ALWAYS_OK
      : { ok: false, reason: 'Aucune release cible indiquée : préciser vers quelle release revenir.' }),
  },
});

/* -------------------------------------------------------------------------- */
/*  LES ACTIONS                                                               */
/* -------------------------------------------------------------------------- */

export const ACTIONS = Object.freeze([
  {
    type: 'CHECK_HEALTH',
    label: 'Contrôler la santé',
    description: 'Interroge le projet pour obtenir son état de santé immédiat.',
    category: 'DIAGNOSTIC',
    target: 'PROJECT',
    executor: 'check-health',
    simulatable: true,
    futureActions: ['DIAGNOSE_REMOTE'],
    parameters: {},
    policy: {
      // La seule action en lecture du registre : aucune confirmation.
      requiresConfirmation: false,
      allowedEnvironments: ['TEST', 'PROD'],
      risk: RISK.NONE,
      rollbackable: false,
      timeoutMs: 30_000,
      exclusive: false,
      exclusivityScope: 'PROJECT',
      requiredReadiness: null,
      blockOnDiagnostics: [],
      prerequisites: [PREREQUISITES.PAIRED, PREREQUISITES.REACHABLE],
      confirmationsRequired: 0,
    },
  },
  {
    type: 'REFRESH_MANIFEST',
    label: 'Rafraîchir le Manifest',
    description: 'Relit le Manifest officiel publié par le projet et met à jour le registre.',
    category: 'DIAGNOSTIC',
    target: 'PROJECT',
    executor: 'refresh-manifest',
    simulatable: true,
    futureActions: ['FETCH_MANIFEST'],
    parameters: {},
    policy: {
      requiresConfirmation: false,
      allowedEnvironments: ['TEST', 'PROD'],
      risk: RISK.LOW,
      rollbackable: false,
      timeoutMs: 30_000,
      exclusive: false,
      exclusivityScope: 'PROJECT',
      requiredReadiness: null,
      blockOnDiagnostics: [],
      prerequisites: [PREREQUISITES.PAIRED, PREREQUISITES.REACHABLE, PREREQUISITES.COMPATIBLE_BRIDGE],
      confirmationsRequired: 0,
    },
  },
  {
    // PHASE 4 — ajoutée sans toucher une seule ligne du cœur du moteur.
    // C'est la vérification, en conditions réelles, du contrat
    // d'extensibilité annoncé en Phase 3C : un descripteur, un exécuteur.
    type: 'DISCOVER_PROJECT',
    label: 'Découvrir le projet',
    description: 'Interroge le projet sur son identité, son Manifest, sa santé, ses opérations et ce qu’il a réellement appliqué.',
    category: 'DIAGNOSTIC',
    target: 'PROJECT',
    executor: 'discover-project',
    simulatable: true,
    futureActions: ['FETCH_MANIFEST', 'DIAGNOSE_REMOTE'],
    parameters: {},
    policy: {
      // Lecture seule côté projet : aucune confirmation.
      requiresConfirmation: false,
      allowedEnvironments: ['TEST', 'PROD'],
      risk: RISK.LOW,
      rollbackable: false,
      timeoutMs: 60_000,
      exclusive: false,
      exclusivityScope: 'PROJECT',
      requiredReadiness: null,
      blockOnDiagnostics: [],
      prerequisites: [PREREQUISITES.PAIRED, PREREQUISITES.REACHABLE],
      confirmationsRequired: 0,
    },
  },
  {
    type: 'DEPLOY',
    label: 'Déployer',
    description: 'Construit un artefact et le met en ligne sur la cible, via le moteur de déploiement du projet.',
    category: 'DEPLOYMENT',
    target: 'PROJECT',
    executor: 'deploy',
    simulatable: true,
    futureActions: [],
    parameters: {
      host: { required: true, type: 'string', description: 'Domaine cible du déploiement.' },
      environment: { required: true, type: 'enum', values: ['TEST', 'PROD'], description: 'Environnement déployé.' },
    },
    policy: {
      requiresConfirmation: true,
      allowedEnvironments: ['TEST', 'PROD'],
      risk: RISK.HIGH,
      rollbackable: true,
      timeoutMs: 30 * 60_000,
      exclusive: true,
      exclusivityScope: 'PROJECT',
      // Un projet dont la préparation est faible ne se déploie pas.
      requiredReadiness: 70,
      blockOnDiagnostics: ['CONTRACT_MAJOR_MISMATCH', 'DEPLOYMENT_ENGINE_MAJOR_DRIFT'],
      prerequisites: [PREREQUISITES.PAIRED, PREREQUISITES.MANIFEST_PRESENT, PREREQUISITES.COMPATIBLE_BRIDGE],
      confirmationsRequired: 1,
    },
  },
  {
    type: 'ROLLBACK',
    label: 'Revenir à une release précédente',
    description: 'Repointe la release active vers une version antérieure, avec contrôle de santé.',
    category: 'DEPLOYMENT',
    target: 'PROJECT',
    executor: 'rollback',
    simulatable: true,
    futureActions: [],
    parameters: {
      releaseId: { required: true, type: 'string', description: 'Identifiant de la release cible.' },
    },
    policy: {
      requiresConfirmation: true,
      allowedEnvironments: ['TEST', 'PROD'],
      risk: RISK.HIGH,
      rollbackable: false, // un rollback ne se rollback pas : on redéploie
      timeoutMs: 10 * 60_000,
      exclusive: true,
      exclusivityScope: 'PROJECT',
      requiredReadiness: null, // on doit pouvoir revenir même depuis un état dégradé
      blockOnDiagnostics: [],
      prerequisites: [PREREQUISITES.PAIRED, PREREQUISITES.HAS_PREVIOUS_RELEASE],
      confirmationsRequired: 1,
    },
  },
  {
    type: 'UPDATE_BRIDGE',
    label: 'Mettre à jour le contrat de pont',
    description: 'Porte le miroir de contrat du projet vers la version servie par le Panel.',
    category: 'MAINTENANCE',
    target: 'PROJECT',
    executor: 'update-bridge',
    simulatable: true,
    futureActions: ['PLAN_CONTRACT_UPGRADE'],
    parameters: {
      targetVersion: { required: false, type: 'string', description: 'Version visée (défaut : celle du Panel).' },
    },
    policy: {
      requiresConfirmation: true,
      allowedEnvironments: ['TEST', 'PROD'],
      risk: RISK.MEDIUM,
      rollbackable: true,
      timeoutMs: 15 * 60_000,
      exclusive: true,
      exclusivityScope: 'PROJECT',
      requiredReadiness: 50,
      blockOnDiagnostics: [],
      prerequisites: [PREREQUISITES.PAIRED],
      confirmationsRequired: 1,
    },
  },
  {
    type: 'UPDATE_DEPLOYMENT_ENGINE',
    label: 'Mettre à jour le moteur de déploiement',
    description: 'Porte le cœur du moteur de déploiement vers la version standard, sans toucher au profil.',
    category: 'MAINTENANCE',
    target: 'PROJECT',
    executor: 'update-engine',
    simulatable: true,
    futureActions: ['PLAN_ENGINE_UPGRADE', 'PLAN_ENGINE_MIGRATION'],
    parameters: {
      engine: { required: false, type: 'enum', values: ['deployment'], description: 'Moteur concerné.' },
      targetVersion: { required: false, type: 'string', description: 'Version visée.' },
    },
    policy: {
      requiresConfirmation: true,
      allowedEnvironments: ['TEST', 'PROD'],
      risk: RISK.MEDIUM,
      rollbackable: true,
      timeoutMs: 15 * 60_000,
      exclusive: true,
      exclusivityScope: 'PROJECT',
      requiredReadiness: 50,
      blockOnDiagnostics: [],
      prerequisites: [PREREQUISITES.PAIRED],
      confirmationsRequired: 1,
    },
  },
  {
    type: 'UPDATE_DUPLICATION_ENGINE',
    label: 'Mettre à jour le moteur de duplication',
    description: 'Porte le cœur du moteur de duplication vers la version standard, sans toucher au profil.',
    category: 'MAINTENANCE',
    target: 'PROJECT',
    executor: 'update-engine',
    simulatable: true,
    futureActions: ['PLAN_ENGINE_UPGRADE', 'PLAN_ENGINE_MIGRATION'],
    parameters: {
      engine: { required: false, type: 'enum', values: ['duplication'], description: 'Moteur concerné.' },
      targetVersion: { required: false, type: 'string', description: 'Version visée.' },
    },
    policy: {
      requiresConfirmation: true,
      allowedEnvironments: ['TEST', 'PROD'],
      risk: RISK.MEDIUM,
      rollbackable: true,
      timeoutMs: 15 * 60_000,
      exclusive: true,
      exclusivityScope: 'PROJECT',
      requiredReadiness: 50,
      blockOnDiagnostics: [],
      prerequisites: [PREREQUISITES.PAIRED],
      confirmationsRequired: 1,
    },
  },
  {
    type: 'ROTATE_SECRETS',
    label: 'Faire tourner les secrets',
    description: 'Régénère les secrets du projet (signature de session, chiffrement au repos).',
    category: 'SECURITY',
    target: 'PROJECT',
    executor: 'rotate-secrets',
    simulatable: true,
    futureActions: [],
    parameters: {
      secrets: { required: true, type: 'array', description: 'Secrets à régénérer.' },
    },
    policy: {
      requiresConfirmation: true,
      // Volontairement limité à TEST tant qu'une recette PROD n'a pas eu lieu :
      // une rotation de clé de chiffrement rend illisibles les données déjà
      // chiffrées et impose un ré-appairage du parc.
      allowedEnvironments: ['TEST'],
      risk: RISK.CRITICAL,
      rollbackable: false,
      timeoutMs: 10 * 60_000,
      exclusive: true,
      exclusivityScope: 'PROJECT',
      requiredReadiness: 70,
      blockOnDiagnostics: [],
      prerequisites: [PREREQUISITES.PAIRED, PREREQUISITES.ONLINE],
      // Prêt pour la double validation : la politique le déclare, le moteur
      // l'applique déjà, il suffira de passer ce nombre à 2.
      confirmationsRequired: 1,
    },
  },
]);

const BY_TYPE = new Map(ACTIONS.map((action) => [action.type, action]));

export function getAction(type) {
  return BY_TYPE.get(type) ?? null;
}

export function listActions() {
  return [...ACTIONS];
}

/** Actions atteignables depuis une étiquette de recommandation 3B. */
export function actionsForFutureAction(futureAction) {
  return ACTIONS.filter((action) => (action.futureActions ?? []).includes(futureAction));
}

const REQUIRED_FIELDS = ['type', 'label', 'description', 'category', 'target', 'executor', 'policy'];
const REQUIRED_POLICY = [
  'requiresConfirmation', 'allowedEnvironments', 'risk', 'rollbackable',
  'timeoutMs', 'exclusive', 'confirmationsRequired',
];

/**
 * Valide le registre — un descripteur incomplet est un défaut de
 * standardisation, détecté par les tests et non en production.
 */
export function validateRegistry(actions = ACTIONS) {
  const errors = [];
  const seen = new Set();

  for (const action of actions) {
    for (const field of REQUIRED_FIELDS) {
      if (action?.[field] === undefined) errors.push(`${action?.type ?? '(sans type)'} : champ manquant « ${field} »`);
    }
    for (const field of REQUIRED_POLICY) {
      if (action?.policy?.[field] === undefined) {
        errors.push(`${action?.type} : politique incomplète, « ${field} » manquant`);
      }
    }
    if (action?.type) {
      if (seen.has(action.type)) errors.push(`type dupliqué : ${action.type}`);
      seen.add(action.type);
    }
    if (action?.policy?.allowedEnvironments?.length === 0) {
      errors.push(`${action.type} : aucun environnement autorisé — l’action serait inexécutable`);
    }
    if (action?.policy?.requiresConfirmation && action?.policy?.confirmationsRequired < 1) {
      errors.push(`${action.type} : confirmation exigée mais confirmationsRequired < 1`);
    }
    if (!action?.policy?.requiresConfirmation && action?.policy?.confirmationsRequired > 0) {
      errors.push(`${action.type} : confirmationsRequired > 0 mais confirmation non exigée`);
    }
    if (action?.policy?.timeoutMs !== undefined && action.policy.timeoutMs <= 0) {
      errors.push(`${action.type} : timeout non positif`);
    }
    for (const [name, spec] of Object.entries(action?.parameters ?? {})) {
      if (spec?.required === undefined || !spec?.type) {
        errors.push(`${action.type} : paramètre « ${name} » incomplet (required et type attendus)`);
      }
    }
  }

  return { valid: errors.length === 0, errors, actionCount: actions.length };
}

/** Valide les paramètres fournis contre le schéma déclaré. */
export function validateParameters(action, parameters = {}) {
  const errors = [];
  const schema = action?.parameters ?? {};

  for (const [name, spec] of Object.entries(schema)) {
    const value = parameters[name];
    if (spec.required && (value === undefined || value === null || value === '')) {
      errors.push(`Paramètre obligatoire manquant : « ${name} » (${spec.description ?? spec.type}).`);
      continue;
    }
    if (value === undefined || value === null) continue;
    if (spec.type === 'enum' && !spec.values.includes(value)) {
      errors.push(`Paramètre « ${name} » : valeur « ${value} » hors des choix autorisés (${spec.values.join(', ')}).`);
    }
    if (spec.type === 'array' && !Array.isArray(value)) {
      errors.push(`Paramètre « ${name} » : tableau attendu.`);
    }
    if (spec.type === 'string' && typeof value !== 'string') {
      errors.push(`Paramètre « ${name} » : chaîne attendue.`);
    }
  }

  const unknown = Object.keys(parameters).filter((name) => !schema[name]);
  if (unknown.length > 0) {
    errors.push(`Paramètre(s) inconnu(s) : ${unknown.join(', ')}.`);
  }

  return { valid: errors.length === 0, errors };
}

export default { ACTIONS, getAction, listActions, validateRegistry, validateParameters, actionsForFutureAction, PREREQUISITES };
