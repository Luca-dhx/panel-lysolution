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
//   BLOCKED    on a refusé d'essayer (droit, ouverture commerciale)
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
  /** Connue, mais pas encore branchée sur un adaptateur. */
  NOT_AVAILABLE: 'CAPABILITY_NOT_AVAILABLE',
  /** Ce projet n'a pas reçu le droit d'invoquer cette capacité. */
  NOT_GRANTED: 'CAPABILITY_NOT_GRANTED',
  /** Écriture réelle refusée tant que l'instance n'est pas ouverte (L1.75). */
  BLOCKED_PREOPENING: 'CAPABILITY_BLOCKED_PREOPENING',
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
});

/** Statut HTTP de chaque refus. Le choix compte : il pilote les reprises. */
const HTTP_STATUS = Object.freeze({
  [CAPABILITY_ERROR_CODES.UNKNOWN]: 404,
  [CAPABILITY_ERROR_CODES.NOT_AVAILABLE]: 409,
  [CAPABILITY_ERROR_CODES.NOT_GRANTED]: 403,
  [CAPABILITY_ERROR_CODES.BLOCKED_PREOPENING]: 409,
  [CAPABILITY_ERROR_CODES.PROVIDER_UNAVAILABLE]: 502,
  // 504 et non 502 : le projet doit pouvoir distinguer « il a dit non » de
  // « il n'a rien dit », parce que la seconde interdit un rejeu aveugle.
  [CAPABILITY_ERROR_CODES.TIMEOUT]: 504,
  [CAPABILITY_ERROR_CODES.INPUT_INVALID]: 400,
  [CAPABILITY_ERROR_CODES.ENVIRONMENT_MISMATCH]: 409,
  [CAPABILITY_ERROR_CODES.CREDENTIALS_MISSING]: 409,
  [CAPABILITY_ERROR_CODES.PROJECT_SCOPE_MISMATCH]: 403,
});

/** Issue associée à chaque refus — ce que le journal enregistre. */
const OUTCOME_BY_CODE = Object.freeze({
  [CAPABILITY_ERROR_CODES.UNKNOWN]: CAPABILITY_OUTCOMES.FAILED,
  [CAPABILITY_ERROR_CODES.NOT_AVAILABLE]: CAPABILITY_OUTCOMES.FAILED,
  [CAPABILITY_ERROR_CODES.NOT_GRANTED]: CAPABILITY_OUTCOMES.BLOCKED,
  [CAPABILITY_ERROR_CODES.BLOCKED_PREOPENING]: CAPABILITY_OUTCOMES.BLOCKED,
  [CAPABILITY_ERROR_CODES.PROVIDER_UNAVAILABLE]: CAPABILITY_OUTCOMES.FAILED,
  // Le seul refus qui n'affirme RIEN sur ce qui s'est passé chez le fournisseur.
  [CAPABILITY_ERROR_CODES.TIMEOUT]: CAPABILITY_OUTCOMES.UNKNOWN,
  [CAPABILITY_ERROR_CODES.INPUT_INVALID]: CAPABILITY_OUTCOMES.FAILED,
  [CAPABILITY_ERROR_CODES.ENVIRONMENT_MISMATCH]: CAPABILITY_OUTCOMES.FAILED,
  [CAPABILITY_ERROR_CODES.CREDENTIALS_MISSING]: CAPABILITY_OUTCOMES.FAILED,
  [CAPABILITY_ERROR_CODES.PROJECT_SCOPE_MISMATCH]: CAPABILITY_OUTCOMES.BLOCKED,
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
  `La capacité « ${code} » est déclarée mais pas encore servie par le Panel.`,
  reason ? { reason } : null,
);

export const capabilityNotGranted = (code, projectId) => new CapabilityError(
  CAPABILITY_ERROR_CODES.NOT_GRANTED,
  `Le projet « ${projectId} » n’a pas reçu le droit d’invoquer « ${code} ».`,
);

export const capabilityBlockedPreopening = (code, effect) => new CapabilityError(
  CAPABILITY_ERROR_CODES.BLOCKED_PREOPENING,
  `Refusé : « ${code} » engage une action réelle (${effect}) et cette instance n’est pas encore ouverte commercialement.`,
  { effect },
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
  capabilityNotGranted,
  capabilityBlockedPreopening,
  capabilityInputInvalid,
  capabilityCredentialsMissing,
  capabilityProjectScopeMismatch,
};
