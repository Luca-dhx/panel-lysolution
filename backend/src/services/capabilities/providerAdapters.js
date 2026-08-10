// ADAPTATEURS — le seul endroit qui connaît un fournisseur (L3).
//
// docs/architecture/CAPABILITY_GATEWAY.md §« Adaptateurs ».
//
// ── UNE TABLE, PAS UN `switch` ──────────────────────────────────────────────
//
// Un aiguillage géant dans le contrôleur grossit à chaque migration, mélange
// les fournisseurs dans une même fonction, et finit par contenir la logique
// métier qu'il était censé router. Ici, une capacité pointe une fonction ; le
// jour où Stripe arrive, on ajoute une ligne et un fichier, et rien d'autre ne
// bouge.
//
// ── CE QU'UN ADAPTATEUR REÇOIT, ET CE QU'IL REND ────────────────────────────
//
//   reçoit  →  { definition, context, credentials, input }
//   rend    →  la SORTIE MÉTIER de la capacité, validée par son schéma
//   lève    →  CapabilityError, jamais une erreur de fournisseur brute
//
// `credentials` entre ici et n'en ressort pas. Aucun adaptateur ne le renvoie,
// ne le journalise, ni ne l'attache à une erreur.
//
// ── POURQUOI LE TRANSPORT BREVO N'EST PAS RÉÉCRIT ───────────────────────────
//
// L8 a livré `integratedApi/brevo/brevoTransport.js` : délais bornés, erreurs
// typées, aucun secret journalisé, distinction entre « il a dit non » et « il
// n'a rien dit ». L'adaptateur ci-dessous ne fait que TRADUIRE ses refus en
// vocabulaire de passerelle. En écrire un second serait créer une seconde
// vérité sur le même fournisseur.
import {
  describeAccount,
  BrevoTransportError,
  TRANSPORT_CODES,
  OUTCOMES as TRANSPORT_OUTCOMES,
} from '../integratedApi/brevo/brevoTransport.js';
import {
  CAPABILITY_ERROR_CODES,
  CapabilityError,
  capabilityNotAvailable,
} from './capabilityErrors.js';

/* -------------------------------------------------------------------------- */
/*  TRADUCTION DES REFUS FOURNISSEUR                                          */
/* -------------------------------------------------------------------------- */

/**
 * Traduit une erreur de transport en refus de passerelle.
 *
 * ── LA SEULE DISTINCTION QUI COMPTE VRAIMENT ────────────────────────────────
 *
 * `TIMEOUT` ne devient PAS `PROVIDER_UNAVAILABLE`. Le premier laisse l'action
 * dans un état indécidable — la requête a pu aboutir et seule la réponse se
 * perdre ; le second affirme que rien n'a eu lieu. Un projet qui les confond
 * rejoue une écriture réelle et la double. La passerelle porte donc la nuance
 * jusqu'au code d'erreur, et jusqu'à l'issue journalisée.
 *
 * ── CE QUI NE TRAVERSE PAS ──────────────────────────────────────────────────
 *
 * Le message du fournisseur n'est jamais relayé. Il peut contenir un
 * identifiant de compte, une URL interne, ou n'importe quoi qu'on n'a pas relu.
 * On garde son STATUT HTTP dans les détails — un nombre ne fuit rien — et on
 * formule le reste nous-mêmes.
 */
export function translateTransportError(error, capability) {
  if (!(error instanceof BrevoTransportError)) {
    // Erreur non typée : on ne sait pas ce qui s'est passé, donc on ne prétend
    // pas le savoir. `PROVIDER_UNAVAILABLE` est le refus le plus prudent qui
    // reste honnête.
    return new CapabilityError(
      CAPABILITY_ERROR_CODES.PROVIDER_UNAVAILABLE,
      `L’exécution de « ${capability.code} » a échoué chez le fournisseur.`,
    );
  }

  if (error.code === TRANSPORT_CODES.TIMEOUT || error.outcome === TRANSPORT_OUTCOMES.UNKNOWN) {
    return new CapabilityError(
      CAPABILITY_ERROR_CODES.TIMEOUT,
      `Le fournisseur n’a pas répondu pour « ${capability.code} » : l’issue est indéterminée.`,
      { httpStatus: error.httpStatus ?? null, replaySafe: false },
    );
  }

  if (error.code === TRANSPORT_CODES.MISSING_CREDENTIALS) {
    return new CapabilityError(
      CAPABILITY_ERROR_CODES.CREDENTIALS_MISSING,
      `Identifiants incomplets pour ${capability.provider}.`,
    );
  }

  if (error.code === TRANSPORT_CODES.INPUT_INVALID) {
    return new CapabilityError(
      CAPABILITY_ERROR_CODES.INPUT_INVALID,
      `Entrée refusée par l’adaptateur de « ${capability.code} ».`,
    );
  }

  return new CapabilityError(
    CAPABILITY_ERROR_CODES.PROVIDER_UNAVAILABLE,
    `Le fournisseur a refusé « ${capability.code} ».`,
    { httpStatus: error.httpStatus ?? null },
  );
}

/* -------------------------------------------------------------------------- */
/*  BREVO                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * `email.sender.verify` — la première capacité réellement servie.
 *
 * Elle LIT le compte chez Brevo (`GET /v3/account`). Rien n'est créé, rien
 * n'est envoyé, personne ne reçoit de message. C'est ce qui la rend éligible
 * comme première migration : son échec ne prive aucun utilisateur d'une
 * notification, et son rejeu ne peut produire aucun doublon.
 *
 * La sortie est un CONSTAT métier — « ce projet peut écrire, oui ou non » —
 * et non une transcription de la réponse de Brevo. `accountLabel` est le nom
 * public du compte, celui qu'un opérateur reconnaît ; il ne porte aucun secret.
 */
async function brevoSenderVerify({ credentials, definition, fetchImpl }) {
  const account = await describeAccount({
    credentials: { apiKey: credentials.apiKey, baseUrl: credentials.baseUrl },
    timeoutMs: definition.timeoutMs,
    ...(fetchImpl ? { fetchImpl } : {}),
  });

  return {
    provider: 'BREVO',
    reachable: account.ok === true,
    accountLabel: account.account ?? null,
    /**
     * L'instant du CONSTAT, pas celui de la requête. Le projet s'en sert pour
     * afficher « vérifié il y a 4 minutes » sans tenir sa propre horloge ;
     * `operationId` reste sa clé de corrélation, et la passerelle le lui rend.
     */
    checkedAt: new Date().toISOString(),
  };
}

/* -------------------------------------------------------------------------- */
/*  LA TABLE                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Capacité → exécutant. FERMÉE, et volontairement courte.
 *
 * Une capacité absente d'ici n'est pas servie, quoi qu'en dise son registre :
 * c'est la table qui décide de ce qui s'exécute réellement, et le contrôle
 * d'alignement vérifie que `migrated: true` et présence ici coïncident.
 */
const ADAPTERS = Object.freeze({
  'email.sender.verify': brevoSenderVerify,
});

export function hasAdapter(code) {
  return Object.hasOwn(ADAPTERS, String(code));
}

export function listAdaptedCapabilities() {
  return Object.keys(ADAPTERS);
}

/**
 * Exécute une capacité chez son fournisseur.
 *
 * @param {object} args
 * @param {object} args.definition   définition du registre
 * @param {object} args.context      contexte d'invocation (jamais transmis à l'adaptateur brut)
 * @param {object} args.credentials  valeurs en clair — n'en ressortent pas
 * @param {object} args.input        entrée DÉJÀ validée par le schéma
 * @param {Function} [args.fetchImpl] injectable : les tests ne sortent pas sur le réseau
 * @returns {Promise<object>} sortie métier, non encore validée par son schéma
 * @throws {CapabilityError}
 */
export async function executeCapability({ definition, context, credentials, input, fetchImpl }) {
  const adapter = ADAPTERS[definition.code];
  if (!adapter) {
    // Cas impossible si l'alignement tient : la passerelle a déjà refusé une
    // capacité non migrée. On refuse quand même — une garde qui ne sert jamais
    // coûte une ligne, une garde manquante coûte un appel non prévu.
    throw capabilityNotAvailable(definition.code, 'NO_ADAPTER');
  }

  try {
    return await adapter({ definition, context, credentials, input, fetchImpl });
  } catch (error) {
    if (error instanceof CapabilityError) throw error;
    throw translateTransportError(error, definition);
  }
}

/**
 * Les adaptateurs et le registre disent-ils la même chose ?
 *
 * Deux dérives possibles : une capacité annoncée servie sans exécutant (l'appel
 * échouerait tard, avec un message obscur), et un exécutant pour une capacité
 * annoncée non migrée (un chemin d'exécution qu'aucun écran ne mentionne).
 *
 * @returns {string[]} problèmes, vide si tout s'accorde.
 */
export function assertAdapterAlignment(definitions) {
  const problems = [];
  for (const definition of definitions) {
    if (definition.migrated && !hasAdapter(definition.code)) {
      problems.push(`« ${definition.code} » est déclarée migrée mais n’a aucun adaptateur.`);
    }
    if (!definition.migrated && hasAdapter(definition.code)) {
      problems.push(`« ${definition.code} » a un adaptateur mais n’est pas déclarée migrée.`);
    }
  }
  return problems;
}

export default {
  executeCapability,
  hasAdapter,
  listAdaptedCapabilities,
  assertAdapterAlignment,
  translateTransportError,
};
