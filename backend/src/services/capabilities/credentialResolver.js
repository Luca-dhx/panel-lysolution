// RÉSOLUTION DES IDENTIFIANTS — la seule porte, et elle ne s'ouvre qu'ici (L3).
//
// docs/architecture/CAPABILITY_GATEWAY.md §« Identifiants ».
//
// ── CE QUI SORT DE CE MODULE, ET CE QUI N'EN SORT JAMAIS ────────────────────
//
//   sort      →  un objet de valeurs en clair, passé DIRECTEMENT à l'adaptateur
//   ne sort   →  vers un contrôleur, une réponse, un journal, un événement,
//                une erreur, ou quoi que ce soit qui traverse le pont
//
// La valeur de retour n'a qu'un destinataire légitime : `providerAdapters`.
// Elle ne doit pas être stockée, sérialisée, ni même passée à une fonction qui
// pourrait la sérialiser. C'est pour cela que la passerelle l'obtient et la
// consomme dans la même expression, sans jamais la nommer dans un contexte
// plus large.
//
// ── POURQUOI ON LIT LE COFFRE L1, ET PAS L'ANCIEN MODÈLE ────────────────────
//
// `PanelIntegratedApi.credentials` (modèle legacy) existe encore et contient
// peut-être des valeurs. Il n'est PAS interrogé : c'est le modèle dont L4 a
// supprimé la diffusion, dont personne ne garantit la fraîcheur, et dont la
// portée (`mode` libre) contredit la doctrine d'environnement de L2. Une seule
// autorité : `PanelIntegratedApiCredentialSet`.
import PanelIntegratedApiCredentialSet, {
  CREDENTIAL_SET_STATUS,
} from '../../models/PanelIntegratedApiCredentialSet.model.js';
import { getProviderDefinition } from '../integratedApi/providerRegistry.js';
import {
  resolveIntegratedApiEnvironment,
} from '../integratedApi/environment.js';
import {
  decryptCredentialSet,
  isConfigured,
  requiredFingerprint,
} from '../integratedApi/credentialVault.js';
import { CAPABILITY_ERROR_CODES, CapabilityError, capabilityCredentialsMissing } from './capabilityErrors.js';

/** Pourquoi un jeu n'est pas exploitable. Codes stables, pour le diagnostic. */
export const CREDENTIAL_REFUSAL = Object.freeze({
  NOT_CONFIGURED: 'NOT_CONFIGURED',
  NOT_VALIDATED: 'NOT_VALIDATED',
  INVALID: 'INVALID_CREDENTIALS',
  PROVIDER_UNREACHABLE: 'PROVIDER_UNREACHABLE',
  VALIDATION_STALE: 'VALIDATION_STALE',
});

/**
 * L'environnement du jeu d'identifiants à utiliser — jamais un champ de requête.
 *
 * Il est DÉRIVÉ de deux choses, et de rien d'autre :
 *
 *   1. la portée du fournisseur décide s'il y a un monde (`environment.js`) ;
 *   2. le contexte porte celui du PROJET pour qui on agit — constaté à
 *      l'appairage, tenu à jour par le battement, lu dans le registre du Panel.
 *
 * Pour un fournisseur à compte unique, la réponse est `null` : lui inventer
 * deux mondes dédoublerait un portefeuille unique.
 *
 * ── CE QUI A DISPARU D'ICI, ET POURQUOI ────────────────────────────────────
 *
 * `assertEnvironmentServed(environment)` refusait tout monde différent de celui
 * du Panel. C'était la garde qui empêchait « exécuter une action PROD depuis un
 * Panel TEST » — et elle avait un sens tant que rien d'autre n'ancrait
 * l'environnement à une identité vérifiée.
 *
 * Elle interdisait aussi la seule chose qu'un plan de contrôle doit savoir
 * faire : servir un projet de PRODUCTION et un projet de RECETTE depuis la même
 * instance, chacun sur son monde. L'ancrage est désormais plus solide qu'un
 * `.env` de processus — c'est la fiche du projet, écrite par le Panel — et
 * c'est elle qui décide.
 *
 * La garde reste EN PLACE là où elle protège vraiment : le provisionnement des
 * identifiants (`assertAdministrableEnvironment`) et la disponibilité déclarée
 * par le Panel pour lui-même (`describeAvailability`).
 */
export function resolveCredentialEnvironment(context, capability) {
  const definition = getProviderDefinition(capability.provider);
  /**
   * ── L'ENVIRONNEMENT DU CONTEXTE EST L'ENTRÉE, PLUS LE `config.env` ───────
   *
   * `context.environment` porte le monde du PROJET pour qui l'appel a lieu
   * (`resolveInstanceEnvironment`), ou celui du Panel pour une capacité qu'il
   * exerce pour lui-même. C'est cette valeur qui entre dans la résolution.
   *
   * Avant ce lot, la primitive relisait `config.env` de son côté et le
   * contexte l'avait relu du sien : la comparaison qui suivait était donc
   * toujours vraie, et la « défense en profondeur » ne défendait rien —
   * elle comparait une valeur à elle-même.
   */
  const environment = resolveIntegratedApiEnvironment({
    providerDefinition: definition,
    projectEnvironment: context.environment ?? null,
  });

  // `null` = fournisseur à compte unique : rien à confronter, il n'a pas de monde.
  if (environment === null) return null;

  /**
   * La confrontation garde son sens pour les fournisseurs à deux mondes : elle
   * vérifie que la résolution n'a pas dérivé du monde demandé. Elle n'est plus
   * tautologique — la primitive peut désormais rendre autre chose que le
   * runtime, et c'est précisément ce qu'on veut constater.
   */
  if (environment !== context.environment) {
    throw new CapabilityError(
      CAPABILITY_ERROR_CODES.ENVIRONMENT_MISMATCH,
      `Refusé : le contexte porte ${context.environment}, la résolution fournisseur rend ${environment}.`,
      { contextEnvironment: context.environment, resolvedEnvironment: environment },
    );
  }
  return environment;
}

/**
 * Charge et DÉCHIFFRE le jeu d'identifiants d'une capacité.
 *
 * ── LA DOCTRINE DE DISPONIBILITÉ ────────────────────────────────────────────
 *
 * On exige `VALID` et une empreinte à jour, pas seulement « rempli ». Trois
 * raisons, dans l'ordre de gravité :
 *
 *  · une clé jamais testée peut être une faute de frappe, et l'erreur sortirait
 *    alors chez le fournisseur au lieu d'être visible dans l'écran qui l'a
 *    saisie ;
 *  · une clé remplacée après un test réussi n'est plus celle qui a été prouvée,
 *    et afficher un feu vert pour elle serait un mensonge daté ;
 *  · un jeu `ERROR` signifie « on n'a pas pu savoir » — c'est justement le cas
 *    où il ne faut pas tenter une écriture réelle en aveugle.
 *
 * C'est strict, et c'est assumé : la réparation est un clic sur « Tester » dans
 * le plan de contrôle, avec un message qui dit quoi faire.
 *
 * @returns {Promise<{values: object, environment: string|null, credentialSetId: string}>}
 *   `values` ne doit JAMAIS quitter l'appelant direct.
 */
export async function resolveCredentialsForCapability(context, capability) {
  const provider = capability.provider;
  const definition = getProviderDefinition(provider);
  if (!definition) {
    throw capabilityCredentialsMissing(capability.code, provider, 'UNKNOWN_PROVIDER');
  }

  const environment = resolveCredentialEnvironment(context, capability);

  const document = await PanelIntegratedApiCredentialSet.findOne({
    provider,
    environment: environment ?? null,
    projectId: null,
  }).lean();

  if (!document || !isConfigured(provider, document.credentialsEncrypted)) {
    throw capabilityCredentialsMissing(capability.code, provider, CREDENTIAL_REFUSAL.NOT_CONFIGURED);
  }

  const stamped = document.lastValidatedFingerprint ?? '';
  const current = requiredFingerprint(provider, document.credentialsEncrypted);
  if (stamped && current && stamped !== current) {
    throw capabilityCredentialsMissing(capability.code, provider, CREDENTIAL_REFUSAL.VALIDATION_STALE);
  }

  if (document.status !== CREDENTIAL_SET_STATUS.VALID) {
    const reason = document.status === CREDENTIAL_SET_STATUS.INVALID
      ? CREDENTIAL_REFUSAL.INVALID
      : document.status === CREDENTIAL_SET_STATUS.ERROR
        ? CREDENTIAL_REFUSAL.PROVIDER_UNREACHABLE
        : CREDENTIAL_REFUSAL.NOT_VALIDATED;
    throw capabilityCredentialsMissing(capability.code, provider, reason);
  }

  // Le déchiffrement a lieu ICI, au plus tard, et les valeurs ne survivent pas
  // à l'appel de l'adaptateur.
  const values = decryptCredentialSet(provider, document.credentialsEncrypted, { environment });

  return {
    values,
    environment,
    credentialSetId: document.credentialSetId,
  };
}

export default {
  CREDENTIAL_REFUSAL,
  resolveCredentialEnvironment,
  resolveCredentialsForCapability,
};
