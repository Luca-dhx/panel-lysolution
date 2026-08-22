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
  /**
   * Le Panel agissant POUR LUI-MÊME — aucun projet dans l'affaire (R10.4).
   *
   * ── EN QUOI C'EST DIFFÉRENT DE `PANEL_INTERNAL` ──────────────────────────
   *
   * `PANEL_INTERNAL` est le Panel agissant pour UN projet : rembourser un
   * client, dans la fiche de ce client. Le projet reste le périmètre — monde,
   * coffre, appartenance et journal en dépendent.
   *
   * `PANEL_SELF` n'a pas de périmètre projet du tout. C'est le Panel écrivant à
   * ses propres exploitants : l'e-mail de test de l'expéditeur global, et les
   * notifications internes qui suivront. Lui inventer une fiche projet serait
   * pire que de l'assumer — on choisirait un projet arbitraire, dont l'état
   * d'ouverture et les octrois décideraient d'un envoi qui ne le concerne pas.
   */
  PANEL_SELF: 'PANEL_SELF',
});

/**
 * LE PÉRIMÈTRE RÉSERVÉ DU PANEL — jamais un identifiant de projet.
 *
 * Il ne sert qu'à PARTITIONNER : le registre d'opérations et le journal
 * d'audit ont besoin d'une clé, et deux actes du Panel ne doivent pas se
 * confondre avec ceux d'un projet. Il n'est JAMAIS utilisé pour chercher une
 * fiche, résoudre une identité ou lire un octroi — les doubles tirets rendent
 * d'ailleurs une collision improbable, et un test vérifie qu'aucune fiche ne
 * le porte.
 */
export const PANEL_SELF_SCOPE = '__panel_self__';

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
    /**
     * La fiche complète — lue par les adaptateurs pour établir l'APPARTENANCE
     * des ressources. Ne sort jamais vers le projet.
     */
    panelProject,
    requestId: requestId || crypto.randomUUID(),
    source,
    startedAt: Date.now(),
  });
}

/**
 * Contexte du Panel agissant POUR LUI-MÊME (R10.4).
 *
 * L'environnement est celui du RUNTIME, exactement comme pour un projet : il
 * n'y a qu'un monde servi par instance de Panel, et il ne se choisit pas.
 */
export function buildPanelSelfContext({ requestId = null } = {}) {
  return Object.freeze({
    /**
     * `null`, et non le périmètre réservé : tout code qui chercherait une fiche
     * doit échouer franchement plutôt que de trouver un pseudo-projet.
     */
    projectId: null,
    projectName: 'Panel',
    /** Le périmètre de PARTITION — registre d'opérations et journal, rien d'autre. */
    scope: PANEL_SELF_SCOPE,
    environment: runtimeEnvironment(),
    panelProject: null,
    requestId: requestId || crypto.randomUUID(),
    source: INVOCATION_SOURCES.PANEL_SELF,
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
 * ══ L'ENVIRONNEMENT D'UN PROJET — SON FAIT, PAS CELUI DU PANEL ══════════════
 *
 * ── CE QUI ÉTAIT ÉCRIT ICI, ET POURQUOI C'ÉTAIT UN DÉFAUT ──────────────────
 *
 * La fonction rendait `runtimeEnvironment()` — le monde du PANEL — et se
 * servait de la déclaration du projet comme d'un simple VETO : si elle
 * différait, refus. Le monde du projet n'était donc jamais l'autorité ; il
 * n'était qu'une condition d'admission.
 *
 * Tant qu'un Panel TEST ne sert que des projets TEST, les deux valeurs
 * coïncident et le défaut ne se voit pas. Le jour où le Panel passe en PROD,
 * un projet de recette voit sa capacité Stripe résolue vers le compte de
 * PRODUCTION — ou refusée sans recours. Dans les deux cas, une propriété qui
 * n'appartient pas au projet aurait décidé à sa place.
 *
 * ── CE QUI LA REMPLACE ─────────────────────────────────────────────────────
 *
 * La fiche parle. `runtime.environment` vient du registre du Panel, constaté à
 * l'appairage et tenu à jour par le battement — **jamais** d'un champ de la
 * requête. Un projet TEST qui écrirait `environment: PROD` dans son corps ne
 * serait pas cru : ce champ n'est pas lu ici, et ne l'a jamais été.
 *
 * ── ET SI LE PROJET N'A JAMAIS PARLÉ ? ─────────────────────────────────────
 *
 * `null` n'est pas un désaccord, c'est une absence — un projet appairé qui
 * n'a pas encore déclaré son monde. On retombe alors sur celui du Panel, faute
 * de mieux, et c'est la seule substitution qui subsiste. Elle est étroite,
 * nommée, et disparaît au premier battement.
 */
export function resolveInstanceEnvironment(panelProject) {
  const served = runtimeEnvironment();
  const declared = panelProject?.runtime?.environment ?? null;
  return declared ?? served;
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
    requestId: context.requestId,
    source: context.source,
  };
}

/**
 * La clé de PARTITION d'un contexte — pour le registre d'opérations et l'audit.
 *
 * Un projet est partitionné par son identifiant ; le Panel par son périmètre
 * réservé. Une seule fonction pour les deux, afin qu'aucun appelant n'ait à
 * choisir — et qu'aucun n'écrive `context.projectId ?? 'panel'` de son côté.
 */
export function partitionKey(context) {
  return context?.projectId ?? context?.scope ?? PANEL_SELF_SCOPE;
}

export default {
  INVOCATION_SOURCES,
  PANEL_SELF_SCOPE,
  buildInvocationContext,
  buildPanelSelfContext,
  partitionKey,
  assertProjectScope,
  resolveInstanceEnvironment,
  describeContext,
};
