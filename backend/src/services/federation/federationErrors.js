// LES REFUS DE LA FÉDÉRATION — nommés, stables, actionnables (L12.A).
//
// ── POURQUOI DES CODES, ET PAS DES MESSAGES ─────────────────────────────────
//
// Le projet qui recevra ces refus au LOT 2B doit pouvoir décider quoi faire :
// réessayer, renvoyer vers le Panel, ou afficher « demandez un accès ». Un
// message français ne permet aucune de ces décisions ; un code oui.
//
// ── DEUX FAMILLES, ET LA FRONTIÈRE COMPTE ───────────────────────────────────
//
//   ÉMISSION      le Panel refuse de délivrer. Il connaît le demandeur, il
//                 sait exactement pourquoi, et il peut le dire — c'est un
//                 opérateur authentifié qui lit.
//
//   VÉRIFICATION  quelqu'un présente une assertion. On ne sait pas qui. Les
//                 motifs restent nommés pour le journal, mais un vérificateur
//                 ne doit jamais les renvoyer tels quels à un porteur anonyme :
//                 « mauvaise audience » lui apprendrait pour quel projet
//                 l'assertion est valable.
export const FEDERATION_ERROR_CODES = Object.freeze({
  /* ── Émission ─────────────────────────────────────────────────────────── */
  /** Le compte existe mais a été désactivé. */
  USER_DISABLED: 'FEDERATION_USER_DISABLED',
  /** Le rôle Panel ne donne pas l'accès DEV aux projets. */
  ROLE_FORBIDDEN: 'FEDERATION_ROLE_FORBIDDEN',
  /** Le compte n'a aucun accès, ou pas à CE projet. */
  PROJECT_ACCESS_DENIED: 'FEDERATION_PROJECT_ACCESS_DENIED',
  /** Le projet n'existe pas au registre. */
  PROJECT_UNKNOWN: 'FEDERATION_PROJECT_UNKNOWN',
  /** Le projet existe mais son appairage n'autorise pas l'accès. */
  PROJECT_NOT_PAIRED: 'FEDERATION_PROJECT_NOT_PAIRED',
  /** La fiche du projet déclare un monde que cette instance ne sert pas. */
  ENVIRONMENT_MISMATCH: 'FEDERATION_ENVIRONMENT_MISMATCH',
  /** Aucune clé signante : configuration incomplète, pas faute du demandeur. */
  KEY_UNAVAILABLE: 'FEDERATION_KEY_UNAVAILABLE',

  /* ── Vérification ─────────────────────────────────────────────────────── */
  /** Jeton illisible, en-tête absent, ou algorithme non servi. */
  ASSERTION_MALFORMED: 'FEDERATION_ASSERTION_MALFORMED',
  /** `kid` absent du jeu de clés — clé inconnue, retirée, ou forgée. */
  ASSERTION_UNKNOWN_KEY: 'FEDERATION_ASSERTION_UNKNOWN_KEY',
  /** La signature ne correspond pas : contenu altéré, ou clé étrangère. */
  ASSERTION_INVALID_SIGNATURE: 'FEDERATION_ASSERTION_INVALID_SIGNATURE',
  /** Passée `exp`. */
  ASSERTION_EXPIRED: 'FEDERATION_ASSERTION_EXPIRED',
  /** Émise pour un AUTRE projet. Le refus qui porte l'isolation. */
  ASSERTION_WRONG_AUDIENCE: 'FEDERATION_ASSERTION_WRONG_AUDIENCE',
  /** Émise par un autre émetteur que ce Panel. */
  ASSERTION_WRONG_ISSUER: 'FEDERATION_ASSERTION_WRONG_ISSUER',
  /** Le contenu est signé mais ne respecte pas le contrat de claims. */
  ASSERTION_CONTRACT_VIOLATION: 'FEDERATION_ASSERTION_CONTRACT_VIOLATION',
});

/**
 * Une décision de refus, telle que le journal la porte.
 *
 * `reasonCode` est le seul champ que l'observabilité doit lire pour compter les
 * refus par cause. Le message est pour un humain, et il change ; le code non.
 */
export class FederationDenied extends Error {
  constructor(reasonCode, message, details = null) {
    super(message);
    this.name = 'FederationDenied';
    this.code = reasonCode;
    this.reasonCode = reasonCode;
    this.details = details;
  }
}

export default { FEDERATION_ERROR_CODES, FederationDenied };
