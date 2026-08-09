// LA FRONTIÈRE — aucun identifiant fournisseur ne traverse le pont.
//
// docs/architecture/INTEGRATED_API_CONTROL_PLANE_ROADMAP.md — lot L4.
//
// ── LA RÈGLE, EN UNE LIGNE ──────────────────────────────────────────────────
//
//   BRIDGE PAYLOADS MUST NEVER CONTAIN PROVIDER CREDENTIALS
//
// ── POURQUOI UNE GARDE, ET PAS SEULEMENT UNE SUPPRESSION ────────────────────
//
// L4 retire le code qui déchiffrait des secrets pour les envoyer aux projets.
// Cela suffit… aujourd'hui. Mais rien n'empêcherait quelqu'un de le réécrire
// dans six mois, de bonne foi, pour « simplifier un appel ». Une suppression
// se défait ; une garde refuse.
//
// Elle est posée à l'UNIQUE point d'émission (`syncCore.emitChange`) et sur la
// réponse d'appairage — les deux seules portes par lesquelles une donnée du
// Panel atteint un projet.
//
// ── ELLE S'APPUIE SUR LE REGISTRE, PAS SUR UNE LISTE DE MOTS ────────────────
//
// Le jour où un cinquième fournisseur déclare :
//
//     credentialRole: { code: 'privateToken', secret: true }
//
// la frontière le sait immédiatement, sans qu'on ait pensé à l'ajouter ici.
// C'est la seule forme de garde qui survit au fournisseur suivant.
//
// Les listes de mots ci-dessous ne sont qu'un FILET SUPPLÉMENTAIRE, pour les
// secrets qui n'appartiennent à aucun fournisseur (mot de passe, jeton de
// pont). Elles complètent le registre, elles ne le remplacent pas.
import {
  listProviderDefinitions,
  PROVIDER_DEFINITIONS,
} from '../services/integratedApi/providerRegistry.js';

/**
 * Noms de champ interdits qui ne viennent d'AUCUN registre.
 *
 * Un `password` ou un `bridgeToken` n'est pas un identifiant fournisseur, mais
 * il n'a rien à faire dans une charge utile métier non plus.
 */
const GENERIC_FORBIDDEN_FIELDS = Object.freeze([
  'password',
  'passwordhash',
  'bridgetoken',
  'bridgetokenencrypted',
  'encryptedcredentials',
  'credentialsencrypted',
  'privatekey',
]);

/**
 * Préfixes de VALEUR reconnaissables — le filet de dernier recours.
 *
 * Une clé peut fuir sous un nom innocent (`value`, `data`, `note`). Ces motifs
 * la reconnaissent à sa forme, indépendamment du champ qui la porte.
 * Volontairement stricts : ils exigent une longueur plausible, pour ne pas
 * refuser une documentation qui cite « sk_test_ » en exemple.
 */
const SECRET_VALUE_PATTERNS = Object.freeze([
  { name: 'clé Stripe', re: /\bsk_(test|live)_[A-Za-z0-9]{8,}/ },
  { name: 'secret de webhook Stripe', re: /\bwhsec_[A-Za-z0-9]{8,}/ },
  { name: 'clé API Brevo', re: /\bxkeysib-[A-Za-z0-9]{16,}/ },
]);

/** Profondeur maximale d'inspection — un garde-fou, pas une limite métier. */
const MAX_DEPTH = 12;

/* -------------------------------------------------------------------------- */
/*  VOCABULAIRE DÉRIVÉ DU REGISTRE                                            */
/* -------------------------------------------------------------------------- */

/**
 * Les noms de rôles CONFIDENTIELS de tous les fournisseurs déclarés.
 *
 * Recalculé à chaque appel : le registre est gelé, mais un test qui y injecte
 * un fournisseur fictif doit être vu immédiatement. Le coût est nul (quatre
 * entrées) et la garantie vaut mieux qu'un cache.
 */
export function forbiddenCredentialRoles() {
  const codes = new Set(GENERIC_FORBIDDEN_FIELDS);
  for (const definition of listProviderDefinitions()) {
    for (const role of definition.credentialRoles) {
      if (role.secret) codes.add(role.code.toLowerCase());
    }
  }
  return codes;
}

/**
 * Les noms de rôles explicitement PUBLIABLES.
 *
 * `publishableKey` contient le mot « key » et finirait refusée par n'importe
 * quelle heuristique de mots — alors qu'elle est faite pour être servie à un
 * navigateur. Le registre tranche, et lui seul.
 */
export function publishableCredentialRoles() {
  const codes = new Set();
  for (const definition of listProviderDefinitions()) {
    for (const role of definition.credentialRoles) {
      if (!role.secret) codes.add(role.code.toLowerCase());
    }
  }
  return codes;
}

/* -------------------------------------------------------------------------- */
/*  L'ERREUR                                                                  */
/* -------------------------------------------------------------------------- */

export class ProviderSecretLeakError extends Error {
  constructor(reason, path) {
    // Le message NOMME le champ fautif et son chemin — jamais sa valeur.
    // Une erreur qui recopierait le secret pour l'expliquer le journaliserait.
    super(
      `Émission refusée : la charge utile contient ${reason} en « ${path} ». `
      + 'Aucun identifiant fournisseur ne traverse le pont (lot L4).',
    );
    this.name = 'ProviderSecretLeakError';
    this.code = 'PANEL_BRIDGE_PROVIDER_SECRET_LEAK';
    this.path = path;
    this.reason = reason;
  }
}

/* -------------------------------------------------------------------------- */
/*  LA GARDE                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Inspecte une charge utile et LÈVE si elle contient un identifiant
 * fournisseur.
 *
 * @param {unknown} payload  n'importe quelle valeur sérialisable
 * @param {{label?: string}} [options]  étiquette du chemin racine (diagnostic)
 * @returns {unknown} la charge utile, inchangée — pour un usage en pipeline
 * @throws {ProviderSecretLeakError}
 */
export function assertNoProviderSecrets(payload, { label = 'payload' } = {}) {
  const forbidden = forbiddenCredentialRoles();
  const publishable = publishableCredentialRoles();
  walk(payload, label, 0, forbidden, publishable, new Set());
  return payload;
}

function walk(value, path, depth, forbidden, publishable, seen) {
  if (value === null || value === undefined) return;
  if (depth > MAX_DEPTH) return;

  if (typeof value === 'string') {
    assertValueShape(value, path);
    return;
  }
  if (typeof value !== 'object') return;

  // Les cycles n'existent pas dans une charge utile JSON, mais une garde qui
  // boucle indéfiniment serait pire que la fuite qu'elle cherche.
  if (seen.has(value)) return;
  seen.add(value);

  if (Array.isArray(value)) {
    value.forEach((item, index) => walk(item, `${path}[${index}]`, depth + 1, forbidden, publishable, seen));
    return;
  }

  // Une Map mongoose se sérialise comme un objet : on l'inspecte pareil.
  const entries = value instanceof Map ? [...value.entries()] : Object.entries(value);

  for (const [key, child] of entries) {
    const childPath = `${path}.${key}`;
    const normalized = String(key).toLowerCase();

    // Le registre l'a déclaré publiable : on ne le refuse pas sur son nom.
    // Sa VALEUR reste inspectée par `walk` — une clé secrète rangée sous
    // « publishableKey » serait attrapée par sa forme.
    if (!publishable.has(normalized) && forbidden.has(normalized) && !isEmpty(child)) {
      throw new ProviderSecretLeakError(`le champ interdit « ${key} »`, childPath);
    }

    walk(child, childPath, depth + 1, forbidden, publishable, seen);
  }
}

/** Un champ interdit mais VIDE n'est pas une fuite — c'est un reste de forme. */
function isEmpty(value) {
  if (value === null || value === undefined) return true;
  if (typeof value === 'string') return value.trim() === '';
  if (Array.isArray(value)) return value.length === 0;
  if (value instanceof Map) return value.size === 0;
  if (typeof value === 'object') return Object.keys(value).length === 0;
  return false;
}

function assertValueShape(text, path) {
  for (const { name, re } of SECRET_VALUE_PATTERNS) {
    if (re.test(text)) {
      throw new ProviderSecretLeakError(`une ${name} reconnaissable à sa forme`, path);
    }
  }
}

/**
 * Variante NON levante — pour un diagnostic ou un test qui veut constater
 * plutôt qu'interrompre.
 * @returns {{clean: boolean, reason?: string, path?: string}}
 */
export function inspectForProviderSecrets(payload, options) {
  try {
    assertNoProviderSecrets(payload, options);
    return { clean: true };
  } catch (err) {
    if (err instanceof ProviderSecretLeakError) {
      return { clean: false, reason: err.reason, path: err.path };
    }
    throw err;
  }
}

/** Le vocabulaire, pour les tests et la documentation. */
export const GUARD_VOCABULARY = Object.freeze({
  genericForbiddenFields: GENERIC_FORBIDDEN_FIELDS,
  valuePatterns: SECRET_VALUE_PATTERNS.map((p) => p.name),
  providers: Object.keys(PROVIDER_DEFINITIONS),
});

export default {
  assertNoProviderSecrets,
  inspectForProviderSecrets,
  forbiddenCredentialRoles,
  publishableCredentialRoles,
  ProviderSecretLeakError,
  GUARD_VOCABULARY,
};
