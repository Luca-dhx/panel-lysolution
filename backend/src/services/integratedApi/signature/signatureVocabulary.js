// LE VOCABULAIRE DE LA SIGNATURE — celui des PROJETS, pas celui d'un fournisseur.
//
// docs/integrated-api/OPENSIGN_MIGRATION_CAMPAIGN.md.
//
// ══ LA FUITE QUE CE MODULE FERME ════════════════════════════════════════════
//
// Jusqu'ici, le Panel rendait le `status` de Yousign TEL QUEL — `ongoing`,
// `done`, `canceled` — et c'est SB Auto qui le traduisait, avec sa propre table.
// Le contrat de capacité se disait générique tout en transportant le lexique
// d'un fournisseur précis.
//
// Ce n'était pas visible tant qu'il n'y en avait qu'un. Ça le devient
// immédiatement avec un second : OpenSign dit `in-progress`, `completed`,
// `declined`. Un projet qui traduit le vocabulaire de Yousign lit alors
// « inconnu » sur chaque état — sans erreur, sans journal, sans rien. Le
// contrat resterait « en cours » pour toujours, et personne ne saurait
// pourquoi.
//
// ══ LA RÈGLE ═══════════════════════════════════════════════════════════════
//
//   Le Panel TRADUIT. Le projet lit un vocabulaire qui ne change pas quand le
//   fournisseur change — c'est la définition même d'une capacité générique.
//
// ══ POURQUOI CES SIX ÉTATS, ET PAS D'AUTRES ═════════════════════════════════
//
// Ce sont ceux que le parcours métier distingue RÉELLEMENT — ils existaient
// déjà dans SB Auto (`SIGNATURE_STATUS`), inchangés depuis l'origine. Les
// reprendre à l'identique n'est pas une coïncidence : c'est ce qui rend la
// bascule invisible côté projet.
//
// On ne les enrichit pas « au cas où ». Un état de plus est un état que chaque
// consommateur devra apprendre à ignorer.

/** L'état d'une DEMANDE de signature. Fermé. */
export const SIGNATURE_REQUEST_STATE = Object.freeze({
  /** Préparée, pas encore partie. Aucun signataire sollicité. */
  DRAFT: 'DRAFT',
  /** En cours : au moins un signataire peut agir. */
  ONGOING: 'ONGOING',
  /** Tous ont signé. Le document signé existe. */
  DONE: 'DONE',
  /** Refusée par un signataire, ou révoquée par l'émetteur. */
  DECLINED: 'DECLINED',
  /** Le délai est passé sans que tous aient signé. */
  EXPIRED: 'EXPIRED',
  /** Retirée avant terme par le plan de contrôle. */
  CANCELED: 'CANCELED',
  /** Le fournisseur a rendu un état qu'on ne sait pas traduire. */
  UNKNOWN: 'UNKNOWN',
});

export const SIGNATURE_REQUEST_STATE_VALUES = Object.freeze(
  Object.values(SIGNATURE_REQUEST_STATE),
);

/** L'état d'UN SIGNATAIRE dans une demande. Fermé. */
export const SIGNER_STATE = Object.freeze({
  /** Sollicité, n'a rien fait. */
  PENDING: 'PENDING',
  /** A ouvert le document, n'a pas signé. */
  VIEWED: 'VIEWED',
  SIGNED: 'SIGNED',
  DECLINED: 'DECLINED',
  UNKNOWN: 'UNKNOWN',
});

export const SIGNER_STATE_VALUES = Object.freeze(Object.values(SIGNER_STATE));

/**
 * Les tables de traduction, PAR FOURNISSEUR.
 *
 * Elles vivent ensemble et non dans chaque adaptateur : c'est ce qui permet de
 * VOIR, en une page, qu'aucun état de fournisseur ne tombe dans le vide, et de
 * comparer deux fournisseurs sans ouvrir deux fichiers.
 *
 * ── CE QUI EST DÉLIBÉRÉMENT ABSENT ─────────────────────────────────────────
 *
 * Aucune correspondance « par défaut sur le mot le plus proche ». Un état non
 * listé rend `UNKNOWN`, et `UNKNOWN` est un état de PREMIÈRE CLASSE : il dit
 * « le fournisseur a répondu quelque chose que nous ne savons pas lire », ce
 * qui est une information. Deviner produirait la même chose sans le dire.
 */
const REQUEST_STATE_BY_PROVIDER = Object.freeze({
  YOUSIGN: Object.freeze({
    draft: SIGNATURE_REQUEST_STATE.DRAFT,
    ongoing: SIGNATURE_REQUEST_STATE.ONGOING,
    approval: SIGNATURE_REQUEST_STATE.ONGOING,
    done: SIGNATURE_REQUEST_STATE.DONE,
    declined: SIGNATURE_REQUEST_STATE.DECLINED,
    rejected: SIGNATURE_REQUEST_STATE.DECLINED,
    expired: SIGNATURE_REQUEST_STATE.EXPIRED,
    canceled: SIGNATURE_REQUEST_STATE.CANCELED,
    deleted: SIGNATURE_REQUEST_STATE.CANCELED,
  }),
  OPENSIGN: Object.freeze({
    draft: SIGNATURE_REQUEST_STATE.DRAFT,
    'in-progress': SIGNATURE_REQUEST_STATE.ONGOING,
    inprogress: SIGNATURE_REQUEST_STATE.ONGOING,
    sent: SIGNATURE_REQUEST_STATE.ONGOING,
    completed: SIGNATURE_REQUEST_STATE.DONE,
    /**
     * ⚠️ MESURÉ, ET CONTRE-INTUITIF : une RÉVOCATION place le document en
     * `declined` chez OpenSign, pas dans un état « revoked » distinct.
     * (Recette du lot 1 : `POST /document/{id}` → `GET` rend `declined`.)
     *
     * On ne corrige pas cette confusion ici. Du point de vue du contrat, refus
     * et révocation ont la même conséquence — le parcours s'arrête et redevient
     * relançable — et inventer une distinction que le fournisseur ne tient pas
     * ferait promettre une information qu'on n'a pas.
     */
    declined: SIGNATURE_REQUEST_STATE.DECLINED,
    revoked: SIGNATURE_REQUEST_STATE.DECLINED,
    expired: SIGNATURE_REQUEST_STATE.EXPIRED,
  }),
});

/**
 * Traduit l'état d'une demande.
 *
 * @param {string} provider
 * @param {string} raw l'état tel que le fournisseur l'écrit
 * @returns {string} une valeur de `SIGNATURE_REQUEST_STATE`
 */
export function toRequestState(provider, raw) {
  const table = REQUEST_STATE_BY_PROVIDER[String(provider ?? '').toUpperCase()];
  if (!table) return SIGNATURE_REQUEST_STATE.UNKNOWN;
  return table[String(raw ?? '').trim().toLowerCase()] ?? SIGNATURE_REQUEST_STATE.UNKNOWN;
}

/**
 * L'état d'un signataire, DÉDUIT de ce que le fournisseur expose.
 *
 * OpenSign ne publie pas d'état de signataire : il publie une PISTE D'AUDIT,
 * `[{email, viewed, signed}]`, où chaque champ est un horodatage ou une chaîne
 * vide. L'état s'en déduit, et cette déduction n'est pas une supposition : elle
 * lit des faits datés.
 *
 * @param {{viewed?: string, signed?: string, declined?: string}} trace
 */
export function signerStateFromAuditTrace(trace) {
  if (!trace) return SIGNER_STATE.UNKNOWN;
  if (String(trace.declined ?? '').trim()) return SIGNER_STATE.DECLINED;
  if (String(trace.signed ?? '').trim()) return SIGNER_STATE.SIGNED;
  if (String(trace.viewed ?? '').trim()) return SIGNER_STATE.VIEWED;
  return SIGNER_STATE.PENDING;
}

/** Traduit l'état d'un signataire Yousign (`initiated`, `signed`, `declined`…). */
export function toSignerState(provider, raw) {
  if (String(provider ?? '').toUpperCase() !== 'YOUSIGN') return SIGNER_STATE.UNKNOWN;
  switch (String(raw ?? '').trim().toLowerCase()) {
    case 'initiated':
    case 'notified':
    case 'processing':
      return SIGNER_STATE.PENDING;
    case 'consent_given':
    case 'verified':
    case 'link_opened':
      return SIGNER_STATE.VIEWED;
    case 'signed':
      return SIGNER_STATE.SIGNED;
    case 'declined':
    case 'aborted':
    case 'error':
      return SIGNER_STATE.DECLINED;
    default:
      return SIGNER_STATE.UNKNOWN;
  }
}

/** Un état est-il TERMINAL ? Le parcours ne peut plus avancer. */
export function isTerminalRequestState(state) {
  return [
    SIGNATURE_REQUEST_STATE.DONE,
    SIGNATURE_REQUEST_STATE.DECLINED,
    SIGNATURE_REQUEST_STATE.EXPIRED,
    SIGNATURE_REQUEST_STATE.CANCELED,
  ].includes(state);
}

export default {
  SIGNATURE_REQUEST_STATE,
  SIGNATURE_REQUEST_STATE_VALUES,
  SIGNER_STATE,
  SIGNER_STATE_VALUES,
  toRequestState,
  toSignerState,
  signerStateFromAuditTrace,
  isTerminalRequestState,
};
