// DIAGNOSTIC WEBHOOK — le catalogue FERMÉ des codes, et rien d'autre.
//
// docs/architecture/WEBHOOK_CONTROL_PLANE.md §« Politique d'échec ».
//
// ── POURQUOI UN CATALOGUE, ET PAS DES CHAÎNES LIBRES ────────────────────────
//
// Un message d'erreur se lit une fois, en français, par un humain. Un CODE se
// filtre, s'agrège, se teste et se compare dans le temps. Quand un webhook
// tombe à trois heures du matin, la question n'est pas « qu'est-ce que le
// fournisseur a dit », c'est « est-ce le même incident qu'avant-hier ».
//
// ── UN MESSAGE NE PORTE JAMAIS DE SECRET ────────────────────────────────────
//
// `safeMessage()` est la seule fabrique de message autorisée dans ce dossier.
// Elle tronque, elle retire les motifs de clés connus, et elle ne fait
// confiance à aucun texte venu d'un fournisseur.

/** États d'un binding. Vocabulaire FERMÉ — l'écran et les tests s'y adossent. */
export const WEBHOOK_STATUS = Object.freeze({
  /** Le fournisseur n'a pas de webhook. Aucun binding n'est écrit. */
  UNSUPPORTED: 'UNSUPPORTED',
  /** Rien n'a encore été tenté, ou les prérequis manquent (clé, URL publique). */
  PENDING: 'PENDING',
  /** Une réconciliation est EN COURS. Persisté avant tout appel distant. */
  RECONCILING: 'RECONCILING',
  /** L'état observé chez le fournisseur correspond à l'état désiré. */
  READY: 'READY',
  /** L'endpoint existe mais diverge (URL, événements, désactivé). */
  DRIFTED: 'DRIFTED',
  /** Utilisable, mais quelque chose mérite d'être regardé (secret absent…). */
  WARNING: 'WARNING',
  /** On n'a pas pu savoir : fournisseur injoignable, clé refusée, plafond. */
  ERROR: 'ERROR',
});

export const WEBHOOK_STATUS_VALUES = Object.freeze(Object.values(WEBHOOK_STATUS));

/**
 * Codes de diagnostic. Chacun désigne UNE cause, et une seule.
 *
 * `WEBHOOK_REMOTE_UNREACHABLE` ≠ `WEBHOOK_AUTH_INVALID` : le premier se répare
 * en attendant, le second se répare en changeant une clé. Les confondre sous un
 * « erreur webhook » ferait chercher au mauvais endroit.
 */
export const WEBHOOK_DIAGNOSTIC = Object.freeze({
  /** Ce fournisseur n'a pas de webhook — un constat, pas une panne. */
  WEBHOOK_UNSUPPORTED: 'WEBHOOK_UNSUPPORTED',
  /** Le jeu d'identifiants n'a pas la clé d'API nécessaire aux appels. */
  WEBHOOK_CREDENTIALS_MISSING: 'WEBHOOK_CREDENTIALS_MISSING',
  /** Aucune URL publique n'est résolue : rien à enregistrer chez le fournisseur. */
  WEBHOOK_CALLBACK_NOT_PUBLIC: 'WEBHOOK_CALLBACK_NOT_PUBLIC',
  /** On a demandé la callback d'un monde que cette instance ne sert pas. */
  WEBHOOK_CALLBACK_ENVIRONMENT_MISMATCH: 'WEBHOOK_CALLBACK_ENVIRONMENT_MISMATCH',
  /** L'endpoint distant pointe ailleurs que la callback canonique. */
  WEBHOOK_CALLBACK_MISMATCH: 'WEBHOOK_CALLBACK_MISMATCH',
  /** Le fournisseur ne répond pas (réseau, délai dépassé). */
  WEBHOOK_REMOTE_UNREACHABLE: 'WEBHOOK_REMOTE_UNREACHABLE',
  /** Le fournisseur refuse nos identifiants (401/403). */
  WEBHOOK_AUTH_INVALID: 'WEBHOOK_AUTH_INVALID',
  /** Le fournisseur a répondu une erreur qui n'est ni un refus ni un délai. */
  WEBHOOK_REMOTE_ERROR: 'WEBHOOK_REMOTE_ERROR',
  /** Plafond d'endpoints atteint (Stripe : 16 par compte). */
  WEBHOOK_REMOTE_LIMIT_REACHED: 'WEBHOOK_REMOTE_LIMIT_REACHED',
  /**
   * LE FOURNISSEUR N'OFFRE PAS CETTE OPÉRATION DANS CE MONDE — ce n'est ni une
   * panne, ni un défaut de droit, et surtout pas notre faute.
   *
   * ══ LE CAS RÉEL QUI A CRÉÉ CE CODE ════════════════════════════════════════
   *
   * Yousign refuse la CRÉATION de souscriptions webhook par l'API dans son bac
   * à sable, et le dit lui-même : « This operation is not available in
   * Sandbox. You can create Webhook Subscriptions for Sandbox environment only
   * from the application, and not from the API. »
   *
   * Il répond par un 403, et un 403 tombait jusqu'ici dans
   * `WEBHOOK_AUTH_INVALID`. L'opérateur lisait donc « authentification
   * invalide » pour une clé parfaitement valide, qui lit d'ailleurs la liste
   * des souscriptions sans difficulté — et il partait régénérer une clé qui
   * n'aurait rien changé.
   *
   * ── LE GESTE ATTENDU N'EST PAS DE RÉESSAYER ────────────────────────────────
   *
   * Il est d'aller créer la souscription dans la CONSOLE du fournisseur. Le
   * Panel la reprendra ensuite par sa réconciliation. C'est pour cela que ce
   * code existe séparément : il appelle une action humaine précise, là où
   * `WEBHOOK_REMOTE_ERROR` invite à réessayer indéfiniment.
   */
  WEBHOOK_REMOTE_UNSUPPORTED_IN_ENVIRONMENT: 'WEBHOOK_REMOTE_UNSUPPORTED_IN_ENVIRONMENT',
  /** L'état observé diverge de l'état désiré. */
  WEBHOOK_DRIFT: 'WEBHOOK_DRIFT',
  /** L'endpoint existe, mais aucun secret ne permet de vérifier ses appels. */
  WEBHOOK_SIGNATURE_CONFIGURATION_INVALID: 'WEBHOOK_SIGNATURE_CONFIGURATION_INVALID',
  /** Une signature entrante n'a pas pu être vérifiée. */
  WEBHOOK_SIGNATURE_REJECTED: 'WEBHOOK_SIGNATURE_REJECTED',
  /** Un appel entrant est arrivé sans binding connu du plan de contrôle. */
  WEBHOOK_BINDING_UNKNOWN: 'WEBHOOK_BINDING_UNKNOWN',
  /** Le segment de callback ne désigne aucun fournisseur géré. */
  WEBHOOK_PROVIDER_UNKNOWN: 'WEBHOOK_PROVIDER_UNKNOWN',
  /** Une réconciliation antérieure s'est interrompue sans conclure. */
  WEBHOOK_RECONCILE_INTERRUPTED: 'WEBHOOK_RECONCILE_INTERRUPTED',
});

export const WEBHOOK_DIAGNOSTIC_VALUES = Object.freeze(Object.values(WEBHOOK_DIAGNOSTIC));

/**
 * ERREUR TYPÉE d'un pilote ou du réconciliateur.
 *
 * Elle ne traverse jamais la frontière HTTP telle quelle : l'endpoint entrant
 * répond des statuts neutres, et l'API de diagnostic rend `{code, message}`.
 */
export class WebhookError extends Error {
  constructor(code, message, details = null) {
    super(safeMessage(message));
    this.name = 'WebhookError';
    this.code = WEBHOOK_DIAGNOSTIC_VALUES.includes(code) ? code : WEBHOOK_DIAGNOSTIC.WEBHOOK_REMOTE_ERROR;
    this.details = details;
  }
}

/**
 * Motifs de secrets connus — retirés de tout message avant journalisation.
 *
 * La liste n'est pas exhaustive et ne peut pas l'être : c'est une seconde
 * barrière. La première reste de ne jamais mettre un secret dans un message.
 */
const SECRET_PATTERNS = [
  /\bsk_(?:test|live)_[A-Za-z0-9]+/g,
  /\bwhsec_[A-Za-z0-9]+/g,
  /\bpk_(?:test|live)_[A-Za-z0-9]+/g,
  /\bxkeysib-[A-Za-z0-9-]+/g,
  /\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi,
];

/** Message SÛR : tronqué, débarrassé des motifs de clés, jamais `undefined`. */
export function safeMessage(input, { max = 300 } = {}) {
  let text = String(input ?? '').replace(/\s+/g, ' ').trim();
  for (const pattern of SECRET_PATTERNS) text = text.replace(pattern, '[secret masqué]');
  if (text.length > max) text = `${text.slice(0, max - 1)}…`;
  return text;
}

/**
 * Le statut qu'un code IMPLIQUE.
 *
 * Un seul endroit décide, parce que la question « est-ce grave ? » se pose à
 * trois endroits (réconciliateur, écran, rapport de déploiement) et qu'ils
 * doivent répondre pareil.
 */
export function statusForDiagnostic(code) {
  switch (code) {
    case WEBHOOK_DIAGNOSTIC.WEBHOOK_UNSUPPORTED:
      return WEBHOOK_STATUS.UNSUPPORTED;
    case WEBHOOK_DIAGNOSTIC.WEBHOOK_CREDENTIALS_MISSING:
    /**
     * `PENDING` et non `ERROR` : rien n'est cassé, il manque un geste humain
     * dans la console du fournisseur. Le classer en erreur ferait clignoter
     * une alerte pour un état qu'aucun réessai ne résoudra.
     */
    case WEBHOOK_DIAGNOSTIC.WEBHOOK_REMOTE_UNSUPPORTED_IN_ENVIRONMENT:
    case WEBHOOK_DIAGNOSTIC.WEBHOOK_CALLBACK_NOT_PUBLIC:
      // Ce n'est pas une panne : c'est un prérequis non encore rempli. Le
      // signaler en ERROR ferait sonner une alarme pour un Panel qu'on vient
      // d'installer et dont personne n'a encore saisi la clé.
      return WEBHOOK_STATUS.PENDING;
    case WEBHOOK_DIAGNOSTIC.WEBHOOK_DRIFT:
    case WEBHOOK_DIAGNOSTIC.WEBHOOK_CALLBACK_MISMATCH:
      return WEBHOOK_STATUS.DRIFTED;
    case WEBHOOK_DIAGNOSTIC.WEBHOOK_SIGNATURE_CONFIGURATION_INVALID:
      return WEBHOOK_STATUS.WARNING;
    default:
      return WEBHOOK_STATUS.ERROR;
  }
}

/**
 * POLITIQUE D'ÉCHEC — un webhook ne casse jamais un déploiement.
 *
 * Roadmap §8.4 : aucun fournisseur ne justifie de bloquer une release. Mais
 * « ne bloque pas » n'est pas « on s'en fiche » : la gravité module l'alerte,
 * pas le passage.
 */
export const WEBHOOK_SEVERITY = Object.freeze({
  INFO: 'INFO',
  WARNING: 'WARNING',
  /** Visible dans le rapport de déploiement, sans le faire échouer. */
  DEPLOYED_WITH_WARNING: 'DEPLOYED_WITH_WARNING',
});

/**
 * Gravité d'un état, PAR FOURNISSEUR.
 *
 * Stripe et Yousign portent un état métier (un paiement encaissé, un contrat
 * signé) : un événement perdu laisse une incohérence qu'un humain devra
 * rattraper. Brevo ne porte que de la délivrabilité : le perdre dégrade le
 * suivi, jamais un état métier.
 */
const BUSINESS_CRITICAL = Object.freeze(new Set(['STRIPE', 'YOUSIGN']));

export function severityFor(provider, status) {
  if (status === WEBHOOK_STATUS.READY || status === WEBHOOK_STATUS.UNSUPPORTED) {
    return WEBHOOK_SEVERITY.INFO;
  }
  return BUSINESS_CRITICAL.has(String(provider).toUpperCase())
    ? WEBHOOK_SEVERITY.DEPLOYED_WITH_WARNING
    : WEBHOOK_SEVERITY.WARNING;
}

/** Un déploiement doit-il échouer à cause de cet état ? Jamais. Testé. */
export function blocksDeployment() {
  return false;
}

export default {
  WEBHOOK_STATUS,
  WEBHOOK_STATUS_VALUES,
  WEBHOOK_DIAGNOSTIC,
  WEBHOOK_DIAGNOSTIC_VALUES,
  WEBHOOK_SEVERITY,
  WebhookError,
  safeMessage,
  statusForDiagnostic,
  severityFor,
  blocksDeployment,
};
