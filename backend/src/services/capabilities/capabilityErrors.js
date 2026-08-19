// REFUS DE LA PASSERELLE — un vocabulaire fermé, et rien qui fuite (L3).
//
// docs/architecture/CAPABILITY_GATEWAY.md §« Modèle d'échec ».
//
// ── POURQUOI DES CODES À NOUS, ET PAS CEUX DU FOURNISSEUR ───────────────────
//
// Un projet qui lit `402` apprend que Brevo facture au crédit. Un projet qui
// lit `CAPABILITY_PROVIDER_UNAVAILABLE` apprend ce qu'il doit faire : réessayer
// plus tard. Le premier couple le métier au fournisseur du jour ; le second
// survit à son remplacement.
//
// ── TROIS RÉPONSES, PAS DEUX ────────────────────────────────────────────────
//
//   SUCCEEDED  l'action a eu lieu, on en a la preuve
//   FAILED     l'action n'a PAS eu lieu, on en a la preuve
//   UNKNOWN    on ne sait pas — et c'est un résultat, pas une panne du code
//   BLOCKED    on a refusé d'essayer (appartenance, périmètre, concurrence)
//
// `UNKNOWN` existe parce qu'un délai dépassé n'est pas un échec constaté : la
// requête a pu aboutir chez le fournisseur et seule la réponse se perdre. Le
// ranger dans `FAILED` conduirait un appelant à rejouer, donc à doubler une
// action réelle. C'est l'invariant hérité de L8, et la passerelle le porte.
import ApiError from '../../utils/ApiError.js';

/** Issue d'une invocation. Journalisée telle quelle, rendue au projet. */
export const CAPABILITY_OUTCOMES = Object.freeze({
  SUCCEEDED: 'SUCCEEDED',
  FAILED: 'FAILED',
  UNKNOWN: 'UNKNOWN',
  BLOCKED: 'BLOCKED',
});

/**
 * Codes de refus — FERMÉS. Chacun désigne UNE cause, et le projet peut agir
 * différemment selon laquelle.
 */
export const CAPABILITY_ERROR_CODES = Object.freeze({
  /** Le code demandé n'existe dans aucun registre. Fail closed. */
  UNKNOWN: 'CAPABILITY_UNKNOWN',
  /**
   * DÉFAILLANCE INTERNE, ET PLUS UN ÉTAT DE DÉPLOIEMENT.
   *
   * Ce code signifiait « déclarée mais pas encore servie » — l'état
   * intermédiaire supprimé par la simplification. Il ne subsiste que pour deux
   * incidents qui ne devraient jamais se produire : un adaptateur manquant
   * malgré le contrôle d'alignement, et une sortie qui viole son propre
   * contrat. Aucun n'est réparable depuis le projet ; les deux sont des bogues
   * du Panel.
   */
  NOT_AVAILABLE: 'CAPABILITY_NOT_AVAILABLE',
  /** Le fournisseur n'a pas répondu, ou a répondu qu'il ne pouvait pas. */
  PROVIDER_UNAVAILABLE: 'CAPABILITY_PROVIDER_UNAVAILABLE',
  /** Aucune réponse dans le délai. L'action a PEUT-ÊTRE eu lieu. */
  TIMEOUT: 'CAPABILITY_TIMEOUT',
  /** L'entrée ne respecte pas le contrat de la capacité. */
  INPUT_INVALID: 'CAPABILITY_INPUT_INVALID',
  /** L'environnement demandé n'est pas celui que sert cette instance. */
  ENVIRONMENT_MISMATCH: 'CAPABILITY_ENVIRONMENT_MISMATCH',
  /** Aucun jeu d'identifiants exploitable dans le coffre du Panel. */
  CREDENTIALS_MISSING: 'CAPABILITY_CREDENTIALS_MISSING',
  /** La charge utile désigne un autre projet que celui authentifié. */
  PROJECT_SCOPE_MISMATCH: 'CAPABILITY_PROJECT_SCOPE_MISMATCH',
  /**
   * Une exécution portant CE MÊME `operationId` est déjà en cours.
   *
   * Ce n'est ni un échec, ni un succès : c'est un refus de DOUBLER. L'appelant
   * doit attendre et relire, jamais réessayer immédiatement — sans quoi deux
   * clics rapides produiraient deux e-mails.
   */
  /**
   * LA RESSOURCE N'EST PAS LA SIENNE — et ce code ne dit rien de plus (L6.2C).
   *
   * Un seul code pour TROIS situations : la ressource est inconnue du Panel,
   * elle appartient à un autre projet, ou son lien a été révoqué. Les
   * distinguer donnerait un oracle d'existence — on présenterait des
   * identifiants au hasard et la nuance du refus dirait lesquels existent.
   *
   * C'est désormais LE refus d'autorisation de la passerelle. Il coexistait
   * avec `NOT_GRANTED`, qui parlait du droit d'invoquer un VERBE quand
   * celui-ci parle de l'APPARTENANCE d'un OBJET ; la distinction a disparu avec
   * les octrois, et c'est la bonne moitié qui reste — un verbe accordé n'a
   * jamais empêché personne de désigner la ressource d'autrui.
   */
  RESOURCE_NOT_OWNED: 'CAPABILITY_RESOURCE_NOT_OWNED',
  OPERATION_IN_FLIGHT: 'CAPABILITY_OPERATION_IN_FLIGHT',
  /**
   * Une tentative antérieure sur cet `operationId` s'est terminée sans qu'on
   * puisse savoir si le fournisseur avait accepté. Aucun rejeu automatique
   * n'est permis : trancher est un arbitrage humain.
   */
  OPERATION_UNRESOLVED: 'CAPABILITY_OPERATION_UNRESOLVED',
});

/** Statut HTTP de chaque refus. Le choix compte : il pilote les reprises. */
const HTTP_STATUS = Object.freeze({
  [CAPABILITY_ERROR_CODES.UNKNOWN]: 404,
  [CAPABILITY_ERROR_CODES.NOT_AVAILABLE]: 409,
  [CAPABILITY_ERROR_CODES.PROVIDER_UNAVAILABLE]: 502,
  // 504 et non 502 : le projet doit pouvoir distinguer « il a dit non » de
  // « il n'a rien dit », parce que la seconde interdit un rejeu aveugle.
  [CAPABILITY_ERROR_CODES.TIMEOUT]: 504,
  [CAPABILITY_ERROR_CODES.INPUT_INVALID]: 400,
  [CAPABILITY_ERROR_CODES.ENVIRONMENT_MISMATCH]: 409,
  [CAPABILITY_ERROR_CODES.CREDENTIALS_MISSING]: 409,
  [CAPABILITY_ERROR_CODES.PROJECT_SCOPE_MISMATCH]: 403,
  // 409 : l'état actuel de la ressource interdit l'action. Un 429 dirait
  // « ralentis », ce qui inviterait à réessayer — exactement ce qu'il ne faut pas.
  [CAPABILITY_ERROR_CODES.RESOURCE_NOT_OWNED]: 403,
  [CAPABILITY_ERROR_CODES.OPERATION_IN_FLIGHT]: 409,
  [CAPABILITY_ERROR_CODES.OPERATION_UNRESOLVED]: 409,
});

/** Issue associée à chaque refus — ce que le journal enregistre. */
const OUTCOME_BY_CODE = Object.freeze({
  [CAPABILITY_ERROR_CODES.UNKNOWN]: CAPABILITY_OUTCOMES.FAILED,
  [CAPABILITY_ERROR_CODES.NOT_AVAILABLE]: CAPABILITY_OUTCOMES.FAILED,
  [CAPABILITY_ERROR_CODES.PROVIDER_UNAVAILABLE]: CAPABILITY_OUTCOMES.FAILED,
  // Le seul refus qui n'affirme RIEN sur ce qui s'est passé chez le fournisseur.
  [CAPABILITY_ERROR_CODES.TIMEOUT]: CAPABILITY_OUTCOMES.UNKNOWN,
  [CAPABILITY_ERROR_CODES.INPUT_INVALID]: CAPABILITY_OUTCOMES.FAILED,
  [CAPABILITY_ERROR_CODES.ENVIRONMENT_MISMATCH]: CAPABILITY_OUTCOMES.FAILED,
  [CAPABILITY_ERROR_CODES.CREDENTIALS_MISSING]: CAPABILITY_OUTCOMES.FAILED,
  [CAPABILITY_ERROR_CODES.PROJECT_SCOPE_MISMATCH]: CAPABILITY_OUTCOMES.BLOCKED,
  // Rien n'a été tenté, et surtout : le fournisseur n'a pas été touché.
  [CAPABILITY_ERROR_CODES.RESOURCE_NOT_OWNED]: CAPABILITY_OUTCOMES.BLOCKED,
  // Rien n'a été tenté : l'exécution appartient à quelqu'un d'autre.
  [CAPABILITY_ERROR_CODES.OPERATION_IN_FLIGHT]: CAPABILITY_OUTCOMES.BLOCKED,
  // L'issue d'AVANT reste inconnue — et le refus d'aujourd'hui le dit.
  [CAPABILITY_ERROR_CODES.OPERATION_UNRESOLVED]: CAPABILITY_OUTCOMES.UNKNOWN,
});

/**
 * Refus d'invocation.
 *
 * `details` est volontairement PAUVRE : un nom de champ, un code de politique,
 * jamais un corps de réponse fournisseur, jamais une URL, jamais une clé. Le
 * fournisseur peut écrire ce qu'il veut dans ses erreurs ; nous n'en relayons
 * que ce que nous avons nous-mêmes formulé.
 */
export class CapabilityError extends ApiError {
  constructor(code, message, details = null) {
    super(HTTP_STATUS[code] ?? 500, code, message, details);
    this.name = 'CapabilityError';
    this.outcome = OUTCOME_BY_CODE[code] ?? CAPABILITY_OUTCOMES.FAILED;
  }

  /** Un rejeu automatique est-il SÛR ? Jamais sur une issue inconnue. */
  get replaySafe() {
    return this.outcome !== CAPABILITY_OUTCOMES.UNKNOWN;
  }
}

/** Fabriques nommées — le code d'appel se lit sans consulter la table. */
export const capabilityUnknown = (code) => new CapabilityError(
  CAPABILITY_ERROR_CODES.UNKNOWN,
  `Capacité inconnue : « ${code} ». Le registre est code-first : il ne s’enrichit pas depuis la base.`,
);

export const capabilityNotAvailable = (code, reason) => new CapabilityError(
  CAPABILITY_ERROR_CODES.NOT_AVAILABLE,
  `La capacité « ${code} » n’a pas pu être exécutée : défaillance interne du Panel.`,
  reason ? { reason } : null,
);

export const capabilityInputInvalid = (code, issues) => new CapabilityError(
  CAPABILITY_ERROR_CODES.INPUT_INVALID,
  `Entrée non conforme au contrat de « ${code} ».`,
  { issues },
);

export const capabilityCredentialsMissing = (code, provider, reason) => new CapabilityError(
  CAPABILITY_ERROR_CODES.CREDENTIALS_MISSING,
  `Aucun identifiant exploitable pour ${provider} sur cette instance.`,
  { provider, reason },
);

export const capabilityOperationInFlight = (code, operationId) => new CapabilityError(
  CAPABILITY_ERROR_CODES.OPERATION_IN_FLIGHT,
  `Une exécution de « ${code} » portant l’identifiant d’opération « ${operationId} » est déjà en cours : `
  + 'le Panel refuse de la doubler.',
  { operationId },
);

export const capabilityOperationUnresolved = (code, operationId) => new CapabilityError(
  CAPABILITY_ERROR_CODES.OPERATION_UNRESOLVED,
  `Une tentative antérieure de « ${code} » (opération « ${operationId} ») s’est terminée sans issue `
  + 'connue : elle a pu aboutir. Aucun rejeu automatique — l’arbitrage est humain.',
  { operationId },
);

/**
 * Refus d'appartenance — UNE seule formulation, quel que soit le motif réel.
 *
 * Le message ne nomme ni le propriétaire, ni le type de refus, ni même le fait
 * que la ressource existe quelque part. Le motif véritable part au journal du
 * Panel, où il sert au diagnostic sans servir de sonde.
 */
export const capabilityResourceNotOwned = (code) => new CapabilityError(
  CAPABILITY_ERROR_CODES.RESOURCE_NOT_OWNED,
  `Ressource inconnue ou non autorisée pour ce projet (« ${code} »).`,
);

export const capabilityProjectScopeMismatch = () => new CapabilityError(
  CAPABILITY_ERROR_CODES.PROJECT_SCOPE_MISMATCH,
  'Refusé : la demande désigne un autre projet que celui authentifié par le pont.',
);

export default {
  CAPABILITY_OUTCOMES,
  CAPABILITY_ERROR_CODES,
  CapabilityError,
  capabilityUnknown,
  capabilityNotAvailable,
  capabilityInputInvalid,
  capabilityCredentialsMissing,
  capabilityProjectScopeMismatch,
  capabilityOperationInFlight,
  capabilityOperationUnresolved,
  capabilityResourceNotOwned,
};
