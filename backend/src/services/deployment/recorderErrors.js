/**
 * ══ LES ÉCHECS DE DURABILITÉ, TYPÉS — ET SANS SECRET ════════════════════════
 *
 * Ils vivent dans leur propre module pour une raison mécanique : le journal
 * durable (`runRecorder.service.js`) écrit PAR le service de run
 * (`deploymentRun.service.js`), et ce dernier a besoin des mêmes types pour
 * refuser l'ouverture d'un run. Les loger dans l'un ou l'autre créerait un
 * cycle d'import entre deux modules qui n'ont aucune raison de se connaître.
 *
 * Ces codes voyagent jusqu'à l'écran, jusqu'au rapport et jusqu'au verdict de
 * publication (`steps.js` les reconnaît comme des REFUS PRONONCÉS AVANT TOUTE
 * TENTATIVE). Ils doivent donc être stables — et ne rien porter d'autre.
 */

export const RECORDER_ERRORS = Object.freeze({
  /** Le journal n'a pas pu être OUVERT : le run n'existe pas durablement. */
  UNAVAILABLE: 'DEPLOYMENT_RECORDER_UNAVAILABLE',
  /** Une écriture d'étape a été refusée AVANT la frontière de publication. */
  WRITE_FAILED: 'DEPLOYMENT_RECORDER_WRITE_FAILED',
  /** La chronologie est trouée : le déploiement a eu lieu, son journal non. */
  PERSISTENCE_LOST: 'DEPLOYMENT_PERSISTENCE_LOST',
});

/** Les deux régimes, nommés — c'est ce que lit un rapport, pas un booléen. */
export const DURABILITY_PHASE = Object.freeze({
  PRE_PUBLICATION: 'PRE_PUBLICATION',
  POST_PUBLICATION: 'POST_PUBLICATION',
});

/**
 * LA CAUSE D'ORIGINE EST CONSERVÉE, JAMAIS PUBLIÉE TELLE QUELLE.
 *
 * Un message de pilote Mongo porte volontiers l'URI de connexion, donc des
 * identifiants. On n'en garde qu'un motif borné et caviardé : assez pour
 * diagnostiquer, rien pour se connecter.
 */
export function redactRecorderCause(err) {
  return String(err?.message || err || 'écriture refusée')
    .replace(/mongodb(\+srv)?:\/\/[^\s'"]+/gi, 'mongodb://«caviardé»')
    .slice(0, 200);
}

/** Le run n'a pas pu être ouvert durablement — aucune mutation ne doit suivre. */
export class RecorderUnavailableError extends Error {
  constructor(message, { cause = null } = {}) {
    super(message);
    this.name = 'RecorderUnavailableError';
    this.code = RECORDER_ERRORS.UNAVAILABLE;
    this.cause = cause;
  }
}

/** Une écriture d'étape a été perdue avant la frontière — publication refusée. */
export class RecorderWriteError extends Error {
  constructor(message, { stepId = null, cause = null } = {}) {
    super(message);
    this.name = 'RecorderWriteError';
    this.code = RECORDER_ERRORS.WRITE_FAILED;
    this.stepId = stepId;
    this.cause = cause;
  }
}

export default {
  RECORDER_ERRORS, DURABILITY_PHASE, redactRecorderCause,
  RecorderUnavailableError, RecorderWriteError,
};
