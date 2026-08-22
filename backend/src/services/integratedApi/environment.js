// RÉSOLUTION DE L'ENVIRONNEMENT D'UNE INTÉGRATION — la primitive canonique.
//
// docs/architecture/INTEGRATED_API_CONTROL_PLANE_ROADMAP.md §7.
//
// ══ QUI CHOISIT TEST OU PROD ══════════════════════════════════════
//
//   pour une capacité AGISSANT POUR UN PROJET  →  l'environnement du PROJET
//   pour une capacité propre au PANEL           →  l'environnement du PANEL
//   pour un fournisseur à compte unique         →  aucun des deux : `null`
//
// ── CE QUI ÉTAIT ÉCRIT ICI, ET POURQUOI C'ÉTAIT UN DÉFAUT ──────────────────
//
//     environnement d'une intégration = ENV du runtime du Panel
//
// La règle était vraie tant qu'un Panel ne servait qu'un monde et que tous ses
// projets le partageaient — ce qui est le cas aujourd'hui, et ce qui rend le
// défaut INVISIBLE. Le jour où le Panel passe en PROD, un projet de recette
// verrait sa capacité Stripe résolue vers le compte de PRODUCTION, ou refusée
// sans recours. Dans les deux cas, la décision aurait été prise par une
// propriété qui n'appartient pas au projet.
//
// L'environnement d'un projet est un FAIT DE SON IDENTITÉ, constaté à
// l'appairage et tenu à jour par le registre du Panel. Il ne vient jamais d'une
// charge utile : un projet TEST qui écrirait `environment: PROD` dans son corps
// de requête ne serait pas cru — c'est la fiche qui parle, pas l'appelant.
//
// Pas le domaine. Pas un en-tête. Pas un paramètre du frontend. Pas un
// `activeMode` choisi à la main. Pas une préférence d'écran. Et désormais :
// pas le `config.env` du Panel, dès lors qu'un projet est en cause.
//
// ── POURQUOI CETTE FONCTION EXISTE, PLUTÔT QU'UN `config.env` PARTOUT ───────
//
// Parce que la règle n'est pas « c'est toujours config.env » : un fournisseur
// `PANEL_GLOBAL` n'a PAS d'environnement, et écrire `TEST` dans son jeu
// d'identifiants créerait deux jeux là où le fournisseur n'en connaît qu'un.
// La nuance tient en trois lignes, mais elle doit tenir à UN endroit.
//
// ── PÉRIMÈTRE L1 ────────────────────────────────────────────────────────────
//
// Cette primitive est écrite et testée. Elle n'est PAS encore branchée sur les
// chemins métier historiques des projets : SB Auto continue d'utiliser son
// `activeMode` local, et ce lot n'y touche pas (compatibilité L1, §13 de la
// mission). La rupture aura lieu en L2, après inventaire réel du parc.
import config from '../../config/env.js';
import ApiError from '../../utils/ApiError.js';
import { SCOPES, ENVIRONMENTS, getProviderDefinition } from './providerRegistry.js';

/**
 * Code d'erreur CANONIQUE d'un désaccord d'environnement.
 *
 * Un seul code, pour que le refus soit reconnaissable partout — journal,
 * interface, tests, support. Il vaut aussi bien pour « on m'a demandé PROD
 * depuis un Panel TEST » que pour « ce jeu d'identifiants n'est pas de ce
 * monde ».
 */
export const INTEGRATED_API_ENVIRONMENT_MISMATCH = 'INTEGRATED_API_ENVIRONMENT_MISMATCH';

/** L'environnement que CETTE instance de Panel sert. Le seul fait qui compte. */
export function runtimeEnvironment() {
  return config.env; // 'TEST' | 'PROD', validé fail-closed au démarrage
}

/**
 * Environnement du jeu d'identifiants à utiliser pour un fournisseur.
 *
 * @param {object} args
 * @param {object} args.providerDefinition  définition issue du registre
 * @param {'TEST'|'PROD'} [args.runtimeEnvironment]  injectable pour les tests ;
 *   en exploitation, c'est TOUJOURS `config.env`.
 * @returns {'TEST'|'PROD'|null} `null` pour un fournisseur PANEL_GLOBAL.
 */
export function resolveIntegratedApiEnvironment({
  providerDefinition,
  runtimeEnvironment: runtime = runtimeEnvironment(),
  /**
   * L'ENVIRONNEMENT DU PROJET POUR QUI ON AGIT — l'autorité, quand il existe.
   *
   * `null` signifie « aucun projet en cause » : une capacité que le Panel
   * exerce pour lui-même. C'est le SEUL cas où son propre monde décide.
   *
   * Il vient du registre (`PanelProject.runtime.environment`), constaté à
   * l'appairage et tenu à jour par le battement — jamais d'un champ de la
   * requête. Un projet TEST qui réclamerait PROD ne serait pas cru.
   */
  projectEnvironment = null,
} = {}) {
  if (!providerDefinition) {
    throw ApiError.badRequest(
      'PANEL_INTEGRATED_API_UNKNOWN_PROVIDER',
      'Résolution impossible : fournisseur inconnu du registre.',
    );
  }
  if (!ENVIRONMENTS.includes(runtime)) {
    // Ne peut arriver qu'en test mal câblé : `config.env` est validé au boot.
    throw ApiError.badRequest(
      'PANEL_INTEGRATED_API_RUNTIME_ENVIRONMENT_INVALID',
      `Environnement de runtime invalide : « ${runtime} ». TEST ou PROD attendus.`,
    );
  }

  if (projectEnvironment !== null && !ENVIRONMENTS.includes(projectEnvironment)) {
    throw ApiError.badRequest(
      'PANEL_INTEGRATED_API_PROJECT_ENVIRONMENT_INVALID',
      `Environnement de projet invalide : « ${projectEnvironment} ». TEST ou PROD attendus.`,
    );
  }

  switch (providerDefinition.scope) {
    case SCOPES.PANEL_GLOBAL:
      /**
       * ── UN COMPTE UNIQUE N'A PAS DE MONDE, ET ON NE LUI EN INVENTE PAS ────
       *
       * Le modèle du fournisseur fait foi : Hostinger n'a qu'un portefeuille.
       * Lui attribuer `TEST` ou `PROD` dédoublerait un compte unique et
       * créerait un jeu d'identifiants que personne ne remplirait jamais.
       *
       * Surtout : on ne substitue PAS `config.env` en douce parce qu'il faut
       * bien mettre quelque chose. `null` est la réponse exacte, et c'est
       * elle qui empêche un `environment` fantôme d'entrer dans une clé.
       */
      return null;
    case SCOPES.ENVIRONMENT:
    case SCOPES.PROJECT_ENVIRONMENT:
      /**
       * ── LE PROJET DÉCIDE, ET LE PANEL SEULEMENT À DÉFAUT ─────────────────
       *
       * Un fournisseur à deux mondes (Stripe, Brevo, OpenSign) est résolu par
       * l'environnement de celui POUR QUI on agit. Le `runtime` ne reprend la
       * main que lorsqu'aucun projet n'est en cause — une capacité que le
       * Panel exerce pour lui-même, où son monde est effectivement le sujet.
       *
       * L'ordre de ces deux termes EST l'invariant du lot. L'inverser
       * rendrait le Panel maître d'une décision qui appartient au projet, et
       * le défaut resterait invisible tant que les deux coïncident.
       */
      return projectEnvironment ?? runtime;
    case SCOPES.PROJECT:
      return null;
    default:
      throw ApiError.badRequest(
        'PANEL_INTEGRATED_API_SCOPE_UNSUPPORTED',
        `Portée inconnue : « ${providerDefinition.scope} ».`,
      );
  }
}

/** Raccourci depuis un code de fournisseur. */
export function resolveEnvironmentForProvider(providerCode, options = {}) {
  return resolveIntegratedApiEnvironment({
    providerDefinition: getProviderDefinition(providerCode),
    ...options,
  });
}

/**
 * FAIL CLOSED — l'environnement demandé est-il celui que nous servons ?
 *
 * Utilisé par toute exécution métier future (L3). Le refus est un 409 : ce
 * n'est pas une requête malformée, c'est une demande légitime adressée à la
 * mauvaise instance.
 *
 * Aucun repli, aucun défaut, aucun basculement silencieux. Si l'on hésite, on
 * refuse : c'est exactement la classe d'accident qu'on cherche à rendre
 * impossible (une clé de production dans une recette).
 */
export function assertEnvironmentServed(requested, { runtimeEnvironment: runtime = runtimeEnvironment() } = {}) {
  // `null` = fournisseur global : rien à vérifier, il n'a pas de monde.
  if (requested === null || requested === undefined) return null;
  if (requested !== runtime) {
    throw ApiError.conflict(
      INTEGRATED_API_ENVIRONMENT_MISMATCH,
      `Refusé : cette instance de Panel sert ${runtime}, le jeu d’identifiants demandé est ${requested}.`,
    );
  }
  return requested;
}

/**
 * L'environnement demandé par une interface d'ADMINISTRATION est-il légitime ?
 *
 * ── LA DISTINCTION QUI FAIT TOUT ────────────────────────────────────────────
 *
 * Configurer les identifiants PROD depuis le Panel TEST est LÉGITIME : il faut
 * bien pouvoir préparer les deux jeux. Ce n'est pas une action métier, c'est
 * du provisionnement.
 *
 * EXÉCUTER une action métier en PROD depuis le Panel TEST ne l'est jamais.
 * C'est `assertEnvironmentServed` qui l'interdit, et rien d'autre.
 *
 * Confondre les deux est l'erreur qui rendrait tout le chantier décoratif.
 * D'où deux fonctions, deux noms, et ce commentaire.
 *
 * NOTE D'EXPLOITATION : chaque instance de Panel ne détenant que ce qu'on y
 * saisit, les identifiants doivent être renseignés DEUX FOIS — une fois dans
 * le Panel TEST, une fois dans le Panel PROD (audit §9.4).
 */
export function assertAdministrableEnvironment(requested, providerDefinition) {
  if (!providerDefinition) {
    throw ApiError.badRequest(
      'PANEL_INTEGRATED_API_UNKNOWN_PROVIDER',
      'Fournisseur inconnu du registre.',
    );
  }
  const global = providerDefinition.scope === SCOPES.PANEL_GLOBAL;

  if (global) {
    if (requested !== null && requested !== undefined && requested !== '') {
      throw ApiError.badRequest(
        'PANEL_INTEGRATED_API_ENVIRONMENT_UNEXPECTED',
        `« ${providerDefinition.label} » est global : il n’a pas d’environnement, et ${requested} n’a donc pas de sens.`,
      );
    }
    return null;
  }

  if (!ENVIRONMENTS.includes(requested)) {
    throw ApiError.badRequest(
      'PANEL_INTEGRATED_API_ENVIRONMENT_REQUIRED',
      `« ${providerDefinition.label} » est configuré par environnement : précisez TEST ou PROD.`,
    );
  }
  return requested;
}

export default {
  INTEGRATED_API_ENVIRONMENT_MISMATCH,
  runtimeEnvironment,
  resolveIntegratedApiEnvironment,
  resolveEnvironmentForProvider,
  assertEnvironmentServed,
  assertAdministrableEnvironment,
};
