// JOURNAL D'EXÉCUTION — Phase 3C.
//
// Le journal n'est pas un confort de débogage : c'est la PIÈCE D'AUDIT. Il
// doit permettre de répondre, des mois plus tard, à « qui a fait quoi, quand,
// pourquoi, et avec quel résultat ».
//
// Il enregistre chaque PHASE du cycle de vie, dans l'ordre, avec son
// horodatage. Une exécution sans journal complet est une exécution non
// auditable — donc un défaut.
//
// ── SÉCURITÉ ────────────────────────────────────────────────────────────────
// Aucun secret ne doit atterrir dans un journal qu'on relira des mois plus
// tard. Toute donnée jointe passe par un masquage systématique.
import { nowIso } from '../../bridge/bridgeContract.js';

/** Phases canoniques du cycle de vie — ordre d'apparition attendu. */
export const PHASE = Object.freeze({
  CREATION: 'CREATION',
  VALIDATION: 'VALIDATION',
  CONFIRMATION: 'CONFIRMATION',
  QUEUE: 'QUEUE',
  START: 'START',
  STEP: 'STEP',
  RESULT: 'RESULT',
  COMPENSATION: 'COMPENSATION',
  END: 'END',
});

export const PHASE_ORDER = Object.freeze([
  PHASE.CREATION, PHASE.VALIDATION, PHASE.CONFIRMATION, PHASE.QUEUE,
  PHASE.START, PHASE.STEP, PHASE.RESULT, PHASE.COMPENSATION, PHASE.END,
]);

/**
 * Clés dont la VALEUR ne doit jamais apparaître en clair dans un journal.
 * Le masquage est fait sur le NOM de la clé : c'est plus sûr que d'essayer
 * de reconnaître un secret à sa forme.
 */
const SECRET_KEY_RE = /secret|password|token|key|credential|passphrase|mongodb_uri|authorization/i;

/** Motifs de valeurs sensibles reconnaissables même sous une clé anodine. */
const SECRET_VALUE_PATTERNS = [
  /mongodb(\+srv)?:\/\/[^\s"']*@[^\s"']*/gi,   // URI Mongo avec credentials
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, // JWT
  /\bBearer\s+[A-Za-z0-9._-]{16,}/gi,
  /\b[0-9a-f]{64,}\b/gi,                        // clés/hashs hexadécimaux longs
];

const REDACTED = '«redacted»';

/** Masque récursivement toute donnée jointe à une entrée de journal. */
export function redact(value, depth = 0) {
  if (depth > 8) return REDACTED;
  if (value === null || value === undefined) return value;

  if (typeof value === 'string') {
    let out = value;
    for (const pattern of SECRET_VALUE_PATTERNS) out = out.replace(pattern, REDACTED);
    return out;
  }
  if (typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((item) => redact(item, depth + 1));

  return Object.fromEntries(
    Object.entries(value).map(([key, val]) => [
      key,
      SECRET_KEY_RE.test(key) ? REDACTED : redact(val, depth + 1),
    ]),
  );
}

/** Construit une entrée de journal — toujours horodatée, toujours masquée. */
export function entry({ phase, message, level = 'INFO', data = null, at = nowIso() }) {
  return { at, phase, level, message, data: data === null ? null : redact(data) };
}

/**
 * Journal d'une exécution — accumulateur en mémoire, écrit par le moteur.
 *
 * Volontairement passif : il n'écrit pas lui-même en base. C'est le service
 * d'exécution qui décide quand persister, ce qui garantit qu'une entrée ne
 * peut pas être écrite sans que l'exécution correspondante le soit aussi.
 */
export function createLog(existing = []) {
  const entries = [...existing];
  const append = (phase, message, options = {}) => {
    const record = entry({ phase, message, ...options });
    entries.push(record);
    return record;
  };
  return {
    entries,
    append,
    info: (phase, message, data) => append(phase, message, { level: 'INFO', data }),
    warn: (phase, message, data) => append(phase, message, { level: 'WARNING', data }),
    error: (phase, message, data) => append(phase, message, { level: 'ERROR', data }),
    toArray: () => [...entries],
  };
}

/**
 * Vérifie qu'un journal raconte une histoire COMPLÈTE et cohérente.
 *
 * Utilisé par les tests et par l'écran d'audit : un journal incomplet
 * signale un chemin de code qui a oublié de se déclarer.
 */
export function auditLog(log, { finalState } = {}) {
  const problems = [];
  const phases = log.map((e) => e.phase);

  if (!phases.includes(PHASE.CREATION)) problems.push('création non journalisée');
  if (!phases.includes(PHASE.VALIDATION)) problems.push('validation non journalisée');

  // Une exécution qui a démarré doit avoir une fin journalisée.
  if (phases.includes(PHASE.START) && !phases.includes(PHASE.END)) {
    problems.push('démarrage journalisé sans fin');
  }
  // Toute exécution arrivée à un état final doit se terminer par END.
  const settled = ['SUCCEEDED', 'FAILED', 'CANCELLED', 'ROLLED_BACK', 'TIMEOUT'];
  if (finalState && settled.includes(finalState) && !phases.includes(PHASE.END)) {
    problems.push(`état final ${finalState} sans entrée de fin`);
  }

  // Ordre chronologique strict.
  for (let i = 1; i < log.length; i += 1) {
    if (log[i].at < log[i - 1].at) {
      problems.push(`entrée ${i} antérieure à la précédente`);
      break;
    }
  }

  for (const e of log) {
    if (!e.phase || !e.message || !e.at) problems.push('entrée incomplète (phase, message et horodatage requis)');
    if (!PHASE_ORDER.includes(e.phase)) problems.push(`phase inconnue : ${e.phase}`);
  }

  return { complete: problems.length === 0, problems, entryCount: log.length, phases: [...new Set(phases)] };
}

/** Rendu texte du journal — pour un export d'audit lisible. */
export function renderLog(log) {
  return log
    .map((e) => {
      const mark = { INFO: ' ', WARNING: '!', ERROR: '✗' }[e.level] ?? ' ';
      const data = e.data ? ` ${JSON.stringify(e.data)}` : '';
      return `${e.at} ${mark} [${e.phase}] ${e.message}${data}`;
    })
    .join('\n');
}

export default { PHASE, PHASE_ORDER, createLog, entry, redact, auditLog, renderLog };
