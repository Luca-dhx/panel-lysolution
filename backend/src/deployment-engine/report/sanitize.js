/**
 * REDACTION / SANITISATION centrale des rapports de déploiement.
 *
 * Le rapport technique doit être TRÈS détaillé mais ne JAMAIS contenir de secret :
 * mot de passe VPS, JWT, cookies, secrets de session, clés API (Stripe/Yousign/
 * Brevo…), URI Mongo avec identifiants, contenu de .env, clés privées, en-têtes
 * Authorization, etc.
 *
 * Deux niveaux de défense :
 *   1. par MOTIF : détecte les formes typiques de secrets dans les chaînes,
 *      commandes, stdout/stderr, URLs, en-têtes, stacks ;
 *   2. par VALEUR EXACTE : on enregistre les secrets connus au runtime (mot de
 *      passe VPS, JWT_SECRET, MONGODB_URI…) et on les efface partout où ils
 *      apparaissent — la garantie la plus forte.
 *
 * Les clés d'objet sensibles voient leur valeur entièrement remplacée.
 */

/** Clés d'objet dont la valeur est toujours masquée. */
const SECRET_KEY_RE = /(pass(word|phrase)?|secret|token|jwt|api[-_]?key|authorization|cookie|credential|private[-_]?key|mongo(db)?[-_]?uri|session)/i;

/** Motifs de valeurs à masquer (ordre important). */
const VALUE_PATTERNS = [
  // Clés privées PEM (multi-lignes).
  { re: /-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g, to: '[REDACTED_PRIVATE_KEY]' },
  // JWT (header.payload.signature).
  { re: /eyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}/g, to: '[REDACTED_TOKEN]' },
  // En-tête Authorization / Bearer.
  { re: /(authorization\s*[:=]\s*)(bearer\s+)?[A-Za-z0-9._~+/=-]{8,}/gi, to: '$1[REDACTED_TOKEN]' },
  { re: /\bbearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, to: 'Bearer [REDACTED_TOKEN]' },
  // Identifiants dans une URI (scheme://user:pass@host).
  { re: /([a-z][a-z0-9+.-]*:\/\/[^:/\s@]+:)[^@/\s]+(@)/gi, to: '$1[REDACTED_PASSWORD]$2' },
  // URI Mongo avec identifiants (au cas où le motif ci-dessus ne couvre pas).
  { re: /(mongodb(\+srv)?:\/\/)[^@\s]+@/gi, to: '$1[REDACTED_CREDENTIALS]@' },
  // Clés Stripe.
  { re: /\b(sk|rk|pk|whsec)_(live|test)_[A-Za-z0-9]{6,}/g, to: '[REDACTED_SECRET]' },
  // Affectations d'environnement sensibles : NOM_SECRET=valeur.
  {
    re: /\b([A-Z0-9_]*(?:PASSWORD|SECRET|TOKEN|APIKEY|API_KEY|PRIVATE|CREDENTIAL|ENCRYPTION_KEY|WEBHOOK)[A-Z0-9_]*)\s*=\s*("?)([^\s"']+)\2/g,
    to: '$1=[REDACTED_SECRET]',
  },
  // Options de commande : --password X, -p=X, --token X…
  {
    re: /(--?(?:password|pass|token|secret|api[-_]?key|auth)\b)(\s+|=)("?)([^\s"']+)\3/gi,
    to: '$1$2[REDACTED_SECRET]',
  },
];

/** Tronque une chaîne en conservant début + fin, avec marqueur explicite. */
export function truncate(str, max = 4000) {
  const s = String(str ?? '');
  if (s.length <= max) return s;
  const head = Math.ceil(max * 0.6);
  const tail = Math.floor(max * 0.3);
  return `${s.slice(0, head)}\n…[${s.length - head - tail} caractères tronqués]…\n${s.slice(-tail)}`;
}

/**
 * Crée un redacteur. `extraSecrets` = valeurs exactes à effacer partout
 * (mot de passe VPS, secrets d'environnement…).
 */
export function createRedactor(extraSecrets = []) {
  const secrets = new Set();
  const addSecret = (v) => {
    if (typeof v === 'string' && v.length >= 4) secrets.add(v);
  };
  extraSecrets.forEach(addSecret);

  const scrubExact = (s) => {
    let out = s;
    for (const sec of secrets) {
      if (out.includes(sec)) out = out.split(sec).join('[REDACTED_SECRET]');
    }
    return out;
  };

  const redactString = (input) => {
    if (input == null) return input;
    let s = String(input);
    for (const { re, to } of VALUE_PATTERNS) s = s.replace(re, to);
    return scrubExact(s);
  };

  /** Comme redactString mais pensé pour une commande shell (mêmes règles). */
  const redactCommand = (cmd) => redactString(cmd);

  /** Redaction profonde d'une valeur quelconque (objets/tableaux/chaînes). */
  const redactValue = (value, keyHint = '') => {
    if (value == null) return value;
    if (typeof value === 'string') {
      if (keyHint && SECRET_KEY_RE.test(keyHint)) return '[REDACTED_SECRET]';
      return redactString(value);
    }
    if (typeof value === 'number' || typeof value === 'boolean') return value;
    if (Array.isArray(value)) return value.map((v) => redactValue(v));
    if (typeof value === 'object') {
      const out = {};
      for (const [k, v] of Object.entries(value)) {
        out[k] = SECRET_KEY_RE.test(k) ? (typeof v === 'string' ? '[REDACTED_SECRET]' : redactValue(v, k)) : redactValue(v, k);
      }
      return out;
    }
    return value;
  };

  return { redactString, redactCommand, redactValue, addSecret, truncate };
}

/** Redacteur par défaut sans secret exact enregistré (motifs uniquement). */
export const defaultRedactor = createRedactor();

export default { createRedactor, defaultRedactor, truncate };
