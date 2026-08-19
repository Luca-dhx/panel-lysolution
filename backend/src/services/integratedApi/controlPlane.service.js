// PLAN DE CONTRÔLE INTEGRATEDAPI — l'API métier unique du Panel (L1).
//
// docs/architecture/INTEGRATED_API_CONTROL_PLANE_ROADMAP.md §13 (L1).
//
// ── UNE SEULE PORTE ─────────────────────────────────────────────────────────
//
// Les contrôleurs n'appellent NI le modèle, NI le coffre, NI le registre. Ils
// appellent ce service. La raison est simple : le jour où un contrôleur
// manipule `credentialsEncrypted` directement, il finit par le sérialiser.
//
//   listProviders()          le catalogue + l'état de chaque jeu
//   getProvider(code)        un fournisseur et ses jeux, masqués
//   getCredentialSet()       un jeu, masqué
//   saveCredentialSet()      écriture partielle, jamais destructive
//   validateCredentialSet()  un appel réel, en lecture seule
//   describeAvailability()   « puis-je compter sur ce fournisseur, ici ? »
//
// ── CE QUE CE SERVICE NE FAIT PAS, EN L1 ────────────────────────────────────
//
// Il n'exécute AUCUNE action métier. Il ne parle à AUCUN projet. Il ne crée
// AUCUN webhook. `describeAvailability()` prépare la passerelle de capacités
// (L3) : elle répond à la question, elle n'agit pas.
import ApiError from '../../utils/ApiError.js';
import logger from '../../utils/logger.js';
import { nowIso } from '../../bridge/bridgeContract.js';
import PanelIntegratedApiCredentialSet, {
  CREDENTIAL_SET_STATUS,
} from '../../models/PanelIntegratedApiCredentialSet.model.js';
import { recordEvent, EVENT_TYPES } from '../supervision/timeline.service.js';
import {
  SCOPES,
  getProviderDefinition,
  listProviderDefinitions,
  describeProviderDefinition,
  environmentsFor,
  secretRoleCodes,
} from './providerRegistry.js';
import {
  assertAdministrableEnvironment,
  assertEnvironmentServed,
  resolveIntegratedApiEnvironment,
  runtimeEnvironment,
} from './environment.js';
import {
  encryptCredentialValues,
  maskCredentialSet,
  isConfigured,
  requiredFingerprint,
  newCredentialSetId,
} from './credentialVault.js';
import { validateCredentials, VALIDATION_STATUS, hasValidator } from './providerValidation.js';
import { reconcileProviderWebhook } from '../webhooks/webhookReconciler.js';

/* -------------------------------------------------------------------------- */
/*  REGISTRE                                                                  */
/* -------------------------------------------------------------------------- */

export function getProviderDefinitionOrThrow(code) {
  const definition = getProviderDefinition(code);
  if (!definition) {
    throw ApiError.notFound(
      'PANEL_INTEGRATED_API_UNKNOWN_PROVIDER',
      `Fournisseur inconnu : « ${code} ». Le registre est code-first — il ne s’enrichit pas depuis la base.`,
    );
  }
  return definition;
}

/* -------------------------------------------------------------------------- */
/*  LECTURE                                                                   */
/* -------------------------------------------------------------------------- */

/** Critère d'unicité d'un jeu. Un seul endroit le connaît. */
function keyFor(definition, environment, projectId = null) {
  return { provider: definition.code, environment: environment ?? null, projectId: projectId ?? null };
}

/**
 * Vue publique d'un jeu — masquée, jamais de valeur confidentielle.
 * `document` peut être `null` : un jeu non encore créé est un état normal,
 * pas une absence à signaler.
 */
function describeCredentialSet(definition, environment, document) {
  const credentials = maskCredentialSet(
    definition.code,
    document?.credentialsEncrypted,
    { environment },
  );
  const configured = document ? isConfigured(definition.code, document.credentialsEncrypted) : false;

  /**
   * LA VALIDATION EST-ELLE ENCORE VRAIE ?
   *
   * Un verdict « valide » qui date d'une clé remplacée depuis est pire qu'une
   * absence de verdict : il affiche un feu vert pour une clé morte. On compare
   * donc l'empreinte des rôles requis d'aujourd'hui à celle estampillée lors
   * de la validation.
   */
  const currentFingerprint = document ? requiredFingerprint(definition.code, document.credentialsEncrypted) : '';
  const stamped = document?.lastValidatedFingerprint ?? '';
  const validationStale = Boolean(
    stamped && currentFingerprint && stamped !== currentFingerprint,
  );

  return {
    credentialSetId: document?.credentialSetId ?? null,
    provider: definition.code,
    scope: definition.scope,
    environment: environment ?? null,
    projectId: document?.projectId ?? null,
    configured,
    status: effectiveStatus(document, configured, validationStale),
    storedStatus: document?.status ?? CREDENTIAL_SET_STATUS.EMPTY,
    validationStale,
    lastValidatedAt: document?.lastValidatedAt ?? null,
    lastValidationCode: document?.lastValidationCode ?? null,
    lastValidationMessage: document?.lastValidationMessage ?? '',
    lastValidationDurationMs: document?.lastValidationDurationMs ?? null,
    lastValidationDetails: document?.lastValidationDetails ?? null,
    credentials,
    updatedAt: document?.updatedAt ?? null,
  };
}

/**
 * L'état RENDU, qui n'est pas toujours l'état STOCKÉ.
 *
 * Une clé remplacée après une validation réussie ramène le jeu à
 * « CONFIGURED » : on ne ment pas sur la fraîcheur d'une preuve.
 */
function effectiveStatus(document, configured, validationStale) {
  if (!document) return CREDENTIAL_SET_STATUS.EMPTY;
  // Un jeu incomplet est EMPTY, même s'il contient déjà quelques valeurs :
  // « à moitié rempli » n'est pas un état exploitable, et le présenter comme
  // configuré ferait croire qu'il ne manque qu'un test.
  if (!configured) return CREDENTIAL_SET_STATUS.EMPTY;
  if (validationStale) return CREDENTIAL_SET_STATUS.CONFIGURED;
  return document.status ?? CREDENTIAL_SET_STATUS.CONFIGURED;
}

/** Un fournisseur, avec tous ses jeux (un par environnement, ou un seul). */
export async function getProvider(code) {
  const definition = getProviderDefinitionOrThrow(code);
  const environments = environmentsFor(definition.code);
  const documents = await PanelIntegratedApiCredentialSet
    .find({ provider: definition.code })
    .lean();

  const credentialSets = environments.map((environment) => {
    const document = documents.find((d) => (d.environment ?? null) === environment) ?? null;
    return describeCredentialSet(definition, environment, document);
  });

  return {
    definition: describeProviderDefinition(definition.code, {
      environment: definition.scope === SCOPES.ENVIRONMENT ? runtimeEnvironment() : null,
    }),
    /** L'environnement que CETTE instance sert. Un constat, pas un choix. */
    runtimeEnvironment: runtimeEnvironment(),
    /** Celui qu'une action métier utiliserait ici — `null` si global. */
    effectiveEnvironment: resolveIntegratedApiEnvironment({ providerDefinition: definition }),
    validatable: hasValidator(definition.code),
    credentialSets,
  };
}

/** Le catalogue complet — c'est ce que rend la page d'administration. */
export async function listProviders() {
  const definitions = listProviderDefinitions();
  const documents = await PanelIntegratedApiCredentialSet.find({}).lean();

  return definitions.map((definition) => {
    const environments = environmentsFor(definition.code);
    const credentialSets = environments.map((environment) => {
      const document = documents.find(
        (d) => d.provider === definition.code && (d.environment ?? null) === environment,
      ) ?? null;
      return describeCredentialSet(definition, environment, document);
    });
    return {
      definition: describeProviderDefinition(definition.code, {
        environment: definition.scope === SCOPES.ENVIRONMENT ? runtimeEnvironment() : null,
      }),
      runtimeEnvironment: runtimeEnvironment(),
      effectiveEnvironment: resolveIntegratedApiEnvironment({ providerDefinition: definition }),
      validatable: hasValidator(definition.code),
      credentialSets,
    };
  });
}

/** Un jeu précis, masqué. */
export async function getCredentialSet(code, environmentInput) {
  const definition = getProviderDefinitionOrThrow(code);
  const environment = assertAdministrableEnvironment(normalizeEnvironment(environmentInput), definition);
  const document = await PanelIntegratedApiCredentialSet.findOne(keyFor(definition, environment)).lean();
  return describeCredentialSet(definition, environment, document);
}

/** `''`, `'null'` et `undefined` désignent tous « pas d'environnement ». */
function normalizeEnvironment(value) {
  if (value === undefined || value === null || value === '' || value === 'null') return null;
  return String(value).toUpperCase();
}

function touchesHumanManagedRole(definition, roles) {
  return roles.some((code) => definition.credentialRoles.some(
    (role) => role.code === code && role.autoManaged !== true,
  ));
}

function shouldScheduleManagedWebhookReconciliation(definition, environment, touchedRoles) {
  if (!definition.supportsWebhookReconciliation) return false;
  if (!touchesHumanManagedRole(definition, touchedRoles)) return false;
  if (definition.scope === SCOPES.ENVIRONMENT) return environment === runtimeEnvironment();
  return true;
}

export function scheduleManagedWebhookReconciliation({
  definition,
  environment,
  touchedRoles,
  reconcileWebhook = reconcileProviderWebhook,
}) {
  if (!shouldScheduleManagedWebhookReconciliation(definition, environment, touchedRoles)) {
    return false;
  }

  const args = { provider: definition.code };
  if (environment) args.environment = environment;

  void Promise.resolve()
    .then(() => reconcileWebhook(args))
    .then((report) => {
      logger.info(
        `[integrated-api] ${definition.code}${environment ? ` (${environment})` : ''} : `
        + `réconciliation webhook déclenchée après mise à jour des identifiants`
        + `${report?.status ? ` (${report.status})` : ''}.`,
      );
    })
    .catch((err) => {
      logger.warn(
        `[integrated-api] ${definition.code}${environment ? ` (${environment})` : ''} : `
        + `réconciliation webhook post-save impossible (${err.message}).`,
      );
    });

  return true;
}

/* -------------------------------------------------------------------------- */
/*  ÉCRITURE                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Enregistre des identifiants.
 *
 * Écriture PARTIELLE et non destructive : une valeur absente conserve
 * l'existante, et retirer une clé exige de la nommer dans `remove`.
 *
 * ── CE QUI SE PASSE APRÈS UNE ÉCRITURE ──────────────────────────────────────
 * Le jeu redevient CONFIGURED (ou EMPTY) : une preuve de validité ne survit
 * pas au remplacement de la clé qu'elle prouvait. Il faut re-tester.
 *
 * ── CE QUI NE SE PASSE PAS ──────────────────────────────────────────────────
 * Rien n'est diffusé à quiconque. Contrairement à l'ancien service du Panel,
 * enregistrer une clé ici ne déclenche AUCUNE rediffusion vers les projets.
 * C'est la règle du plan de contrôle, et elle est vérifiée par test.
 */
export async function saveCredentialSet(
  code,
  environmentInput,
  { values = {}, remove = [], reconcileWebhook = reconcileProviderWebhook } = {},
  actor = {},
) {
  const definition = getProviderDefinitionOrThrow(code);
  const environment = assertAdministrableEnvironment(normalizeEnvironment(environmentInput), definition);
  const at = nowIso();
  const actorId = actor.userId ?? null;

  const existing = await PanelIntegratedApiCredentialSet.findOne(keyFor(definition, environment)).lean();

  const { stored, written, removed } = encryptCredentialValues({
    provider: definition.code,
    current: existing?.credentialsEncrypted,
    values,
    remove,
    environment,
    actor: actorId,
  });

  if (written.length === 0 && removed.length === 0) {
    throw ApiError.badRequest(
      'PANEL_INTEGRATED_API_NOTHING_TO_SAVE',
      'Enregistrement refusé : aucune valeur fournie et aucune clé nommée pour retrait.',
    );
  }

  const configured = isConfigured(definition.code, stored);
  const hasAny = Object.keys(stored).length > 0;
  const status = !hasAny
    ? CREDENTIAL_SET_STATUS.EMPTY
    : configured
      ? CREDENTIAL_SET_STATUS.CONFIGURED
      : CREDENTIAL_SET_STATUS.EMPTY;

  await PanelIntegratedApiCredentialSet.updateOne(
    keyFor(definition, environment),
    {
      $set: {
        scope: definition.scope,
        credentialsEncrypted: stored,
        status,
        updatedAt: at,
        updatedBy: actorId,
        // La preuve tombe avec la clé qu'elle prouvait.
        lastValidatedFingerprint: '',
      },
      $setOnInsert: {
        credentialSetId: newCredentialSetId(),
        createdAt: at,
      },
    },
    { upsert: true },
  );

  // On NOMME les rôles touchés, jamais leurs valeurs.
  logger.info(
    `[integrated-api] ${definition.code}${environment ? ` (${environment})` : ''} : `
    + `${written.length} identifiant(s) enregistré(s)${written.length ? ` [${written.join(', ')}]` : ''}`
    + `${removed.length ? `, ${removed.length} retiré(s) [${removed.join(', ')}]` : ''}.`,
  );

  await recordEvent({
    projectId: null,
    type: EVENT_TYPES.INTEGRATED_API_CREDENTIALS_UPDATED,
    source: 'PANEL',
    summary: `Identifiants ${definition.label}${environment ? ` (${environment})` : ''} mis à jour`
      + ` — ${written.length} enregistré(s), ${removed.length} retiré(s).`,
    data: { provider: definition.code, environment, written, removed, scope: definition.scope },
  }).catch(() => {});

  scheduleManagedWebhookReconciliation({
    definition,
    environment,
    touchedRoles: [...written, ...removed],
    reconcileWebhook,
  });

  return getCredentialSet(definition.code, environment);
}

/* -------------------------------------------------------------------------- */
/*  VALIDATION                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Teste un jeu contre le fournisseur — appel RÉEL, en lecture seule.
 *
 * Le verdict est persisté quelle qu'en soit l'issue : c'est quand ça échoue
 * qu'on veut une trace datée, avec le code du fournisseur.
 *
 * `fetchImpl` est injectable pour que les tests ne sortent pas sur le réseau.
 */
export async function validateCredentialSet(code, environmentInput, { actor = {}, fetchImpl } = {}) {
  const definition = getProviderDefinitionOrThrow(code);
  const environment = assertAdministrableEnvironment(normalizeEnvironment(environmentInput), definition);

  const document = await PanelIntegratedApiCredentialSet.findOne(keyFor(definition, environment)).lean();

  /**
   * UN JEU INCOMPLET N'EST PAS UNE PANNE DE FOURNISSEUR.
   *
   * Le seed crée les jeux vides d'avance : leur simple existence ne prouve
   * donc rien. On refuse ici, avec un code clair, plutôt que d'appeler le
   * fournisseur pour rien et d'estampiller le jeu en ERROR — un état réservé
   * à « on n'a pas pu savoir », pas à « on n'a pas encore rempli le
   * formulaire ».
   */
  if (!document || !isConfigured(definition.code, document.credentialsEncrypted)) {
    throw ApiError.conflict(
      'PANEL_INTEGRATED_API_NOT_CONFIGURED',
      `Test impossible : les identifiants requis de ${definition.label}`
      + `${environment ? ` en ${environment}` : ''} ne sont pas tous renseignés.`,
    );
  }

  const outcome = await validateCredentials({
    provider: definition.code,
    environment,
    credentialsEncrypted: document.credentialsEncrypted,
    ...(fetchImpl ? { fetchImpl } : {}),
  });

  const at = nowIso();
  const status = outcome.status === VALIDATION_STATUS.VALID
    ? CREDENTIAL_SET_STATUS.VALID
    : outcome.status === VALIDATION_STATUS.INVALID
      ? CREDENTIAL_SET_STATUS.INVALID
      : CREDENTIAL_SET_STATUS.ERROR;

  await PanelIntegratedApiCredentialSet.updateOne(
    keyFor(definition, environment),
    {
      $set: {
        status,
        lastValidatedAt: at,
        lastValidationCode: outcome.code,
        lastValidationMessage: outcome.message,
        lastValidationDurationMs: outcome.durationMs ?? null,
        lastValidationDetails: outcome.details ?? null,
        // Estampille : le verdict porte sur CES valeurs, pas sur des futures.
        // Vide en cas d'échec — il n'y a alors aucune preuve à dater.
        lastValidatedFingerprint: outcome.status === VALIDATION_STATUS.VALID
          ? requiredFingerprint(definition.code, document.credentialsEncrypted)
          : '',
        updatedAt: at,
      },
    },
  );

  /**
   * OBSERVABILITÉ — provider, environnement, portée, issue, durée, code.
   * JAMAIS une clé, un jeton, un secret. Le diagnostic du fournisseur est
   * déjà tronqué et exempt de secret par construction.
   */
  const observation = {
    provider: definition.code,
    environment,
    scope: definition.scope,
    status,
    code: outcome.code,
    durationMs: outcome.durationMs ?? null,
    validatedAt: at,
    actor: actor.userId ?? null,
  };
  logger.info(`[integrated-api] validation ${JSON.stringify(observation)}`);

  await recordEvent({
    projectId: null,
    type: outcome.status === VALIDATION_STATUS.VALID
      ? EVENT_TYPES.INTEGRATED_API_VALIDATION_SUCCEEDED
      : EVENT_TYPES.INTEGRATED_API_VALIDATION_FAILED,
    source: 'PANEL',
    severity: outcome.status === VALIDATION_STATUS.VALID ? 'INFO' : 'WARNING',
    summary: `${definition.label}${environment ? ` (${environment})` : ''} : ${outcome.message}`,
    data: observation,
  }).catch(() => {});

  return {
    ...(await getCredentialSet(definition.code, environment)),
    validation: {
      status: outcome.status,
      code: outcome.code,
      message: outcome.message,
      durationMs: outcome.durationMs ?? null,
      details: outcome.details ?? null,
    },
  };
}

/* -------------------------------------------------------------------------- */
/*  DISPONIBILITÉ — la question que posera la passerelle de capacités (L3)     */
/* -------------------------------------------------------------------------- */

/**
 * « Puis-je compter sur ce fournisseur, sur CETTE instance, maintenant ? »
 *
 * L'environnement n'est PAS un paramètre : il est résolu depuis le runtime.
 * C'est délibéré — c'est la signature qui rend impossible de demander PROD
 * depuis une instance TEST, et elle doit rester ainsi quand L3 s'en servira.
 *
 * `assertEnvironmentServed` est appelé même si la résolution vient du runtime :
 * défense en profondeur, et le test qui la couvre documente l'invariant.
 */
export async function describeAvailability(code) {
  const definition = getProviderDefinitionOrThrow(code);
  const environment = resolveIntegratedApiEnvironment({ providerDefinition: definition });
  assertEnvironmentServed(environment);

  const document = await PanelIntegratedApiCredentialSet.findOne(keyFor(definition, environment)).lean();
  const configured = document ? isConfigured(definition.code, document.credentialsEncrypted) : false;
  const stale = Boolean(
    document?.lastValidatedFingerprint
    && requiredFingerprint(definition.code, document?.credentialsEncrypted)
    && document.lastValidatedFingerprint !== requiredFingerprint(definition.code, document.credentialsEncrypted),
  );

  const available = configured && document?.status === CREDENTIAL_SET_STATUS.VALID && !stale;

  return {
    provider: definition.code,
    label: definition.label,
    scope: definition.scope,
    environment,
    runtimeEnvironment: runtimeEnvironment(),
    available,
    reason: available ? null
      : !document ? 'NOT_CONFIGURED'
        : !configured ? 'NOT_CONFIGURED'
          : stale ? 'VALIDATION_STALE'
            : document.status === CREDENTIAL_SET_STATUS.INVALID ? 'INVALID_CREDENTIALS'
              : document.status === CREDENTIAL_SET_STATUS.ERROR ? 'PROVIDER_UNREACHABLE'
                : 'NOT_VALIDATED',
    lastValidatedAt: document?.lastValidatedAt ?? null,
    /** Prévues pour L3. Aucune n'est invocable aujourd'hui. */
    capabilities: [...definition.capabilities],
    capabilitiesInvocable: false,
  };
}

/** Disponibilité de tous les fournisseurs — le diagnostic d'ensemble. */
export async function describeAllAvailability() {
  const results = [];
  for (const definition of listProviderDefinitions()) {
    results.push(await describeAvailability(definition.code));
  }
  return results;
}

/**
 * Sûreté de dernier recours : la liste des rôles confidentiels d'un
 * fournisseur. Utilisée par les tests de non-fuite pour savoir QUOI chercher
 * dans une réponse d'API — l'invariant se vérifie, il ne se déclare pas.
 */
export { secretRoleCodes };

export default {
  getProviderDefinitionOrThrow,
  listProviders,
  getProvider,
  getCredentialSet,
  saveCredentialSet,
  scheduleManagedWebhookReconciliation,
  validateCredentialSet,
  describeAvailability,
  describeAllAvailability,
};
