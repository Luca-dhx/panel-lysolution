// CONTEXTE D'INVOCATION — d'où vient l'autorité, et d'où elle ne vient pas (L3).
//
// docs/architecture/CAPABILITY_GATEWAY.md §« Contexte ».
//
// ── LA RÈGLE, EN UNE LIGNE ──────────────────────────────────────────────────
//
//   TOUT CE QUI FAIT AUTORITÉ VIENT DU JETON DE PONT ET DU RUNTIME.
//   RIEN NE VIENT DE LA CHARGE UTILE.
//
// Le projet apporte deux choses : le NOM d'une capacité, et son entrée métier.
// Il n'apporte ni son identité, ni son monde, ni son état d'ouverture — trois
// informations qu'il connaît pourtant, et qu'il serait naturel de lui demander.
//
// ── POURQUOI REFUSER UN `projectId` QUI CONCORDE ────────────────────────────
//
// On ne le refuse pas : `assertProjectScope` accepte la redondance et refuse la
// DIVERGENCE. La nuance compte — un client qui répète son identifiant a un
// style, un client qui en envoie un autre a un bug ou une intention. Les deux
// méritent d'être traités différemment, et le second mérite une trace.
//
// ── POURQUOI DEUX SOURCES POUR L'ENVIRONNEMENT ──────────────────────────────
//
// L'environnement servi est celui du RUNTIME du Panel (doctrine L2). La fiche
// du projet en porte un aussi, relevé à l'appairage. Ils DOIVENT concorder —
// `pairing.bootstrap` le vérifie déjà, fail closed. On le revérifie ici parce
// qu'une fiche peut avoir été écrite avant cette garde, et parce qu'une
// vérification qui ne coûte rien à l'exécution vaut mieux qu'une hypothèse.
import crypto from 'node:crypto';

import { runtimeEnvironment } from '../integratedApi/environment.js';
import {
  DEFAULT_COMMERCIAL_STATE,
  COMMERCIAL_STATE_VALUES,
} from '../integratedApi/commercialReadiness.js';
import {
  CAPABILITY_ERROR_CODES,
  CapabilityError,
  capabilityProjectScopeMismatch,
} from './capabilityErrors.js';

/** D'où part l'invocation. Le journal doit pouvoir le dire. */
export const INVOCATION_SOURCES = Object.freeze({
  /** Un projet appairé, par la surface /bridge/v1. Le seul cas aujourd'hui. */
  PROJECT_BRIDGE: 'PROJECT_BRIDGE',
  /**
   * Le Panel agissant POUR un projet, sans que le projet demande rien.
   *
   * Prévue de longue date pour le moteur de déploiement, cette source est
   * servie depuis L10.4 par le remboursement Stripe : un opérateur clique dans
   * l'onglet Finances d'un projet, et le projet n'a aucun pont dans l'affaire.
   *
   * Elle ne relâche qu'UNE chose dans la passerelle : l'octroi, qui répond à
   * « ce projet peut-il demander ceci » — question sans objet ici. Le projet
   * reste le périmètre entier : appartenance, monde, coffre et journal.
   */
  PANEL_INTERNAL: 'PANEL_INTERNAL',
});

/**
 * Construit le contexte d'une invocation à partir de la fiche AUTHENTIFIÉE.
 *
 * @param {object} args
 * @param {object} args.panelProject  fiche rendue par `requireBridgeAuth`
 * @param {object} [args.payload]     corps de la requête, NON fiable
 * @param {string} [args.requestId]   identifiant de corrélation
 * @param {string} [args.source]      INVOCATION_SOURCES
 * @returns {{projectId, projectName, environment, commercialState, panelProject,
 *   requestId, source, startedAt}}
 * @throws {CapabilityError} scope ou environnement incohérents
 */
export function buildInvocationContext({
  panelProject,
  payload = {},
  requestId = null,
  source = INVOCATION_SOURCES.PROJECT_BRIDGE,
} = {}) {
  if (!panelProject?.projectId) {
    // Ne peut arriver que si la garde d'authentification a été contournée —
    // c'est-à-dire jamais, sauf erreur de montage. On refuse plutôt que de
    // fabriquer un contexte anonyme qui trouverait quand même des credentials.
    throw capabilityProjectScopeMismatch();
  }

  const projectId = String(panelProject.projectId);
  assertProjectScope(projectId, payload);

  const environment = resolveInstanceEnvironment(panelProject);

  return Object.freeze({
    projectId,
    projectName: panelProject.projectName ?? null,
    /** Le monde fournisseur. Constaté, jamais choisi. */
    environment,
    /** L'ouverture commerciale. `null` en base se lit « jamais décidée ». */
    commercialState: resolveCommercialState(panelProject),
    /** La fiche complète — pour les octrois. Ne sort jamais vers le projet. */
    panelProject,
    requestId: requestId || crypto.randomUUID(),
    source,
    startedAt: Date.now(),
  });
}

/**
 * La charge utile prétend-elle parler d'un autre projet ?
 *
 * Trois champs sont inspectés parce que trois conventions existent dans le
 * parc. Les ignorer serait accepter qu'un jour l'un d'eux soit branché.
 */
export function assertProjectScope(authenticatedProjectId, payload = {}) {
  for (const field of ['projectId', 'project_id', 'projectKey']) {
    const claimed = payload?.[field];
    if (claimed === undefined || claimed === null || claimed === '') continue;
    if (String(claimed) !== authenticatedProjectId) throw capabilityProjectScopeMismatch();
  }
  return authenticatedProjectId;
}

/**
 * L'environnement de CETTE instance — et la preuve que la fiche est d'accord.
 *
 * `runtime.environment` est `null` tant que le projet n'a jamais parlé : ce
 * n'est pas un désaccord, c'est une absence, et un projet authentifié qui
 * invoque est par définition en train de parler. On ne bloque donc que sur une
 * valeur PRÉSENTE et DIFFÉRENTE.
 */
export function resolveInstanceEnvironment(panelProject) {
  const served = runtimeEnvironment();
  const declared = panelProject?.runtime?.environment ?? null;

  if (declared && declared !== served) {
    throw new CapabilityError(
      CAPABILITY_ERROR_CODES.ENVIRONMENT_MISMATCH,
      `Refusé : cette instance de Panel sert ${served}, la fiche du projet déclare ${declared}.`,
      { served, declared },
    );
  }
  return served;
}

/**
 * L'état d'ouverture retenu pour la décision.
 *
 * Une valeur absente ou inconnue retombe sur le défaut FERMÉ. Une base
 * corrompue, une migration à moitié faite ou une faute de frappe ne doivent
 * jamais ouvrir le commerce par accident.
 */
export function resolveCommercialState(panelProject) {
  const stored = panelProject?.commercialState ?? null;
  return COMMERCIAL_STATE_VALUES.includes(stored) ? stored : DEFAULT_COMMERCIAL_STATE;
}

/**
 * Projection SÛRE du contexte — celle qui part au journal et à l'audit.
 *
 * `panelProject` est retiré : il porte les hachages d'appairage et la copie
 * chiffrée du jeton de pont. Un journal n'est pas un endroit pour ça, même
 * chiffré, et une fiche entière sérialisée finit toujours par être recopiée
 * quelque part.
 */
export function describeContext(context) {
  return {
    projectId: context.projectId,
    environment: context.environment,
    commercialState: context.commercialState,
    requestId: context.requestId,
    source: context.source,
  };
}

export default {
  INVOCATION_SOURCES,
  buildInvocationContext,
  assertProjectScope,
  resolveInstanceEnvironment,
  resolveCommercialState,
  describeContext,
};
