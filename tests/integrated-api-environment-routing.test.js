// ROUTAGE D'ENVIRONNEMENT — invariant PROJECT_ENVIRONMENT_RESOLVES_PROVIDER_ENVIRONMENT.
//
// C'est le test qui justifie tout le chantier : l'environnement d'une
// intégration se DÉDUIT, il ne se choisit pas. Aucun hostname, aucun
// `activeMode`, aucun paramètre venu d'un frontend, aucun champ de requête.
//
// ══ CE QUE L'INVARIANT DISAIT, ET CE QU'IL DIT MAINTENANT ══════════════════
//
//   avant   environnement fournisseur = ENV du runtime du PANEL
//   après   environnement fournisseur = ENV du PROJET pour qui on agit,
//           et celui du Panel seulement quand aucun projet n'est en cause
//
// La règle d'avant était vraie tant qu'un Panel ne servait qu'un monde et que
// tous ses projets le partageaient — ce qui est le cas aujourd'hui, et ce qui
// rendait le défaut INVISIBLE. Le jour où le Panel passe en PROD, un projet de
// recette verrait sa capacité Stripe résolue vers le compte de PRODUCTION, ou
// refusée sans recours.
//
// Il couvre aussi la distinction qui rend la doctrine tenable :
//   · ADMINISTRER le jeu PROD depuis un Panel TEST  → autorisé (provisionnement)
//   · EXÉCUTER en PROD depuis un Panel TEST         → refusé (fail closed)
import { check, finish, section, setTestEnv } from './helpers/harness.js';

setTestEnv(); // ENV=TEST — cette instance sert TEST, et rien d'autre.

const { SCOPES, getProviderDefinition } = await import(
  '../backend/src/services/integratedApi/providerRegistry.js'
);
const {
  INTEGRATED_API_ENVIRONMENT_MISMATCH,
  runtimeEnvironment,
  resolveIntegratedApiEnvironment,
  resolveEnvironmentForProvider,
  assertEnvironmentServed,
  assertAdministrableEnvironment,
} = await import('../backend/src/services/integratedApi/environment.js');

function refuses(fn, code) {
  try {
    fn();
    return false;
  } catch (err) {
    return err?.code === code;
  }
}

section('Le runtime est la seule entrée');
{
  check('cette instance sert TEST', runtimeEnvironment() === 'TEST');

  for (const code of ['STRIPE', 'BREVO', 'YOUSIGN']) {
    check(`${code} : runtime TEST → jeu TEST`,
      resolveEnvironmentForProvider(code) === 'TEST');
  }

  // Le runtime est injecté ici UNIQUEMENT pour prouver la règle : en
  // exploitation, il vient toujours de `config.env`.
  for (const code of ['STRIPE', 'BREVO', 'YOUSIGN']) {
    check(`${code} : runtime PROD → jeu PROD`,
      resolveIntegratedApiEnvironment({
        providerDefinition: getProviderDefinition(code),
        runtimeEnvironment: 'PROD',
      }) === 'PROD');
  }
}

section('PANEL_GLOBAL_PROVIDER_HAS_NO_ENVIRONMENT');
{
  const hostinger = getProviderDefinition('HOSTINGER');
  check('HOSTINGER est global', hostinger.scope === SCOPES.PANEL_GLOBAL);
  check('runtime TEST → aucun environnement',
    resolveIntegratedApiEnvironment({ providerDefinition: hostinger, runtimeEnvironment: 'TEST' }) === null);
  check('runtime PROD → aucun environnement non plus',
    resolveIntegratedApiEnvironment({ providerDefinition: hostinger, runtimeEnvironment: 'PROD' }) === null);
  // Lui inventer deux jeux dédoublerait un compte unique : le DNS d'un domaine
  // de recette et celui d'un domaine de production vivent au même endroit.
}

section('Rien d’autre que le runtime ne peut décider');
{
  const stripe = getProviderDefinition('STRIPE');

  check('un fournisseur inconnu ne se résout pas',
    refuses(() => resolveIntegratedApiEnvironment({ providerDefinition: null }),
      'PANEL_INTEGRATED_API_UNKNOWN_PROVIDER'));

  check('un runtime invalide est refusé, jamais deviné',
    refuses(() => resolveIntegratedApiEnvironment({
      providerDefinition: stripe, runtimeEnvironment: 'STAGING',
    }), 'PANEL_INTEGRATED_API_RUNTIME_ENVIRONMENT_INVALID'));

  check('un runtime vide est refusé',
    refuses(() => resolveIntegratedApiEnvironment({
      providerDefinition: stripe, runtimeEnvironment: '',
    }), 'PANEL_INTEGRATED_API_RUNTIME_ENVIRONMENT_INVALID'));

  // La signature elle-même reste une garantie : il n'y a AUCUN paramètre par
  // lequel un appelant DEMANDERAIT un monde. `projectEnvironment` n'en est pas
  // un — il ne vient pas de l'appelant mais du registre du Panel.
  check('resolveIntegratedApiEnvironment n’accepte pas d’environnement demandé',
    !/requestedEnvironment|desiredEnvironment/.test(resolveIntegratedApiEnvironment.toString()));
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('LA MATRICE CROISÉE — le résultat ne dépend QUE du projet');
{
  /**
   * Quatre combinaisons, sur les quatre fournisseurs à deux mondes réellement
   * déclarés au catalogue. Le runtime du Panel est INJECTÉ : c'est la seule
   * façon d'éprouver un Panel PROD sans en démarrer un, et AUCUN appel n'est
   * fait à un fournisseur.
   */
  const DUAL = ['STRIPE', 'BREVO', 'OPENSIGN'];
  const monde = (code, panelEnv, projetEnv) => resolveIntegratedApiEnvironment({
    providerDefinition: getProviderDefinition(code),
    runtimeEnvironment: panelEnv,
    projectEnvironment: projetEnv,
  });

  for (const code of DUAL) {
    check(`${code} — Panel TEST + Projet TEST → TEST`, monde(code, 'TEST', 'TEST') === 'TEST');
    check(`${code} — Panel TEST + Projet PROD → PROD`, monde(code, 'TEST', 'PROD') === 'PROD');
    check(`${code} — Panel PROD + Projet TEST → TEST`, monde(code, 'PROD', 'TEST') === 'TEST');
    check(`${code} — Panel PROD + Projet PROD → PROD`, monde(code, 'PROD', 'PROD') === 'PROD');
    check(`${code} — le monde du Panel ne change RIEN`,
      monde(code, 'TEST', 'TEST') === monde(code, 'PROD', 'TEST')
      && monde(code, 'TEST', 'PROD') === monde(code, 'PROD', 'PROD'));
  }

  /**
   * SANS PROJET — une capacité que le Panel exerce POUR LUI-MÊME. C'est le seul
   * cas où son propre monde décide, et il reste servi.
   */
  check('aucun projet en cause → le monde du Panel reprend la main',
    monde('STRIPE', 'TEST', null) === 'TEST' && monde('STRIPE', 'PROD', null) === 'PROD');

  /**
   * FOURNISSEUR À COMPTE UNIQUE — il n'hérite d'aucun monde, ni du projet ni du
   * Panel. `null` est la réponse exacte : c'est elle qui empêche un
   * `environment` fantôme d'entrer dans une clé d'identifiants.
   */
  const unique = (panelEnv, projetEnv) => resolveIntegratedApiEnvironment({
    providerDefinition: getProviderDefinition('HOSTINGER'),
    runtimeEnvironment: panelEnv,
    projectEnvironment: projetEnv,
  });
  check('HOSTINGER (compte unique) → null, quelles que soient les combinaisons',
    unique('TEST', 'TEST') === null && unique('PROD', 'PROD') === null
    && unique('TEST', 'PROD') === null && unique('PROD', 'TEST') === null);
  check('…le modèle du fournisseur est respecté, jamais substitué par PANEL_ENV',
    getProviderDefinition('HOSTINGER').scope === SCOPES.PANEL_GLOBAL);

  /** Un environnement de projet qui n'existe pas est REFUSÉ, pas remplacé. */
  check('un environnement de projet invalide est refusé',
    refuses(() => resolveIntegratedApiEnvironment({
      providerDefinition: getProviderDefinition('STRIPE'),
      projectEnvironment: 'STAGING',
    }), 'PANEL_INTEGRATED_API_PROJECT_ENVIRONMENT_INVALID'));
}

section('FAIL CLOSED — assertEnvironmentServed');
{
  check('TEST demandé depuis un Panel TEST : accepté',
    assertEnvironmentServed('TEST') === 'TEST');

  check('PROD demandé depuis un Panel TEST : REFUSÉ',
    refuses(() => assertEnvironmentServed('PROD'), INTEGRATED_API_ENVIRONMENT_MISMATCH));

  check('TEST demandé depuis un Panel PROD : REFUSÉ',
    refuses(() => assertEnvironmentServed('TEST', { runtimeEnvironment: 'PROD' }),
      INTEGRATED_API_ENVIRONMENT_MISMATCH));

  check('le refus est un 409, pas un 400', (() => {
    try { assertEnvironmentServed('PROD'); return false; } catch (err) { return err.statusCode === 409; }
  })());

  check('le code canonique est INTEGRATED_API_ENVIRONMENT_MISMATCH',
    INTEGRATED_API_ENVIRONMENT_MISMATCH === 'INTEGRATED_API_ENVIRONMENT_MISMATCH');

  check('un fournisseur global n’a rien à vérifier',
    assertEnvironmentServed(null) === null);

  // Aucun repli : le refus ne bascule jamais silencieusement sur l'autre monde.
  check('aucun repli sur l’autre environnement', (() => {
    try { assertEnvironmentServed('PROD'); return false; } catch { return true; }
  })());
}

section('ADMINISTRER ≠ EXÉCUTER — la distinction qui tient la doctrine');
{
  const stripe = getProviderDefinition('STRIPE');
  const hostinger = getProviderDefinition('HOSTINGER');

  // Provisionnement : préparer les DEUX jeux depuis une seule instance est
  // légitime, sinon le Panel PROD ne pourrait jamais être configuré.
  check('administrer le jeu TEST depuis un Panel TEST : autorisé',
    assertAdministrableEnvironment('TEST', stripe) === 'TEST');
  check('administrer le jeu PROD depuis un Panel TEST : AUTORISÉ (provisionnement)',
    assertAdministrableEnvironment('PROD', stripe) === 'PROD');

  // …mais l'exécution, elle, reste refusée. Les deux affirmations coexistent,
  // et c'est exactement le point.
  check('…alors qu’EXÉCUTER en PROD reste refusé',
    refuses(() => assertEnvironmentServed('PROD'), INTEGRATED_API_ENVIRONMENT_MISMATCH));

  check('administrer sans préciser l’environnement : refusé pour un provider ENVIRONMENT',
    refuses(() => assertAdministrableEnvironment(null, stripe),
      'PANEL_INTEGRATED_API_ENVIRONMENT_REQUIRED'));
  check('un environnement inventé est refusé',
    refuses(() => assertAdministrableEnvironment('STAGING', stripe),
      'PANEL_INTEGRATED_API_ENVIRONMENT_REQUIRED'));

  check('un provider global n’accepte AUCUN environnement',
    refuses(() => assertAdministrableEnvironment('TEST', hostinger),
      'PANEL_INTEGRATED_API_ENVIRONMENT_UNEXPECTED'));
  check('…et se contente de null', assertAdministrableEnvironment(null, hostinger) === null);
}

section('MANAGER_RUNTIME_IS_NOT_MIGRATED_IN_L1');
{
  // L1 pose la primitive ; il ne coupe RIEN. La preuve est négative : le Panel
  // n'a introduit aucune notion d'`activeMode`, et n'en lit aucune.
  const source = [
    resolveIntegratedApiEnvironment.toString(),
    assertEnvironmentServed.toString(),
    assertAdministrableEnvironment.toString(),
  ].join('\n');
  check('aucune notion d’activeMode dans le résolveur', !/activeMode/i.test(source));
  check('aucune lecture de hostname', !/hostname|req\.host|origin/i.test(source));
}

finish();
