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

/* -------------------------------------------------------------------------- */
/*  LE CANAL DE VÉRIFICATION — UNE PORTE, PAS UNE BRÈCHE (L6.3A)              */
/* -------------------------------------------------------------------------- */

/**
 * Les rôles qui NE SERVENT QU'À VÉRIFIER — dérivés du registre, jamais listés.
 */
export function verificationOnlyRoles() {
  const codes = new Set();
  for (const definition of listProviderDefinitions()) {
    for (const role of definition.credentialRoles) {
      if (role.secret && role.verificationOnly) codes.add(role.code.toLowerCase());
    }
  }
  return codes;
}

/** Un rôle de vérification livré au projet ressemble-t-il à ce qu'il prétend ? */
const VERIFICATION_VALUE_PATTERNS = Object.freeze([/^whsec_[A-Za-z0-9_-]{8,}$/]);

export class VerificationChannelViolation extends Error {
  constructor(reason, path) {
    super(
      `Livraison refusée : ${reason} en « ${path} ». Le canal de vérification ne `
      + 'transporte QU’un secret de signature, et rien d’autre (lot L6.3A).',
    );
    this.name = 'VerificationChannelViolation';
    this.code = 'PANEL_BRIDGE_VERIFICATION_CHANNEL_VIOLATION';
    this.path = path;
    this.reason = reason;
  }
}

/**
 * LA GARDE DU CANAL ÉTROIT.
 *
 * ══ CE QU'ELLE N'EST PAS ════════════════════════════════════════════════════
 *
 * Elle n'assouplit RIEN. `assertNoProviderSecrets` reste absolue partout où
 * elle était posée — journal de synchronisation, résultat de capacité,
 * appairage. Aucun `allowSecrets`, aucune exception « sauf Stripe », aucun
 * drapeau qui se propage.
 *
 * ══ CE QU'ELLE EST ══════════════════════════════════════════════════════════
 *
 * Une garde PLUS STRICTE, posée sur une seule route, qui exige que la charge
 * utile soit exactement :
 *
 *     { <rôle de vérification> : "<valeur de la bonne forme>" }
 *
 * et rien de plus. Un champ en trop, un rôle qui n'est pas déclaré
 * `verificationOnly` au registre, une valeur qui n'a pas la forme attendue,
 * une clé d'API glissée à côté : tout est refusé.
 *
 * Le renversement est le point : ailleurs on interdit une liste de choses ;
 * ici on n'autorise qu'une seule chose. Une porte dont on connaît la forme
 * exacte est plus sûre qu'un mur percé d'une exception, parce qu'elle ne peut
 * pas servir à faire passer autre chose.
 *
 * @param {unknown} payload
 * @param {{label?: string}} [options]
 * @throws {VerificationChannelViolation}
 */
export function assertVerificationSecretOnly(payload, { label = 'delivery' } = {}) {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new VerificationChannelViolation('la charge n’est pas un objet simple', label);
  }
  const permis = verificationOnlyRoles();
  const entrees = Object.entries(payload);
  if (entrees.length !== 1) {
    throw new VerificationChannelViolation(
      `la charge porte ${entrees.length} champs au lieu d’un seul`, label,
    );
  }
  const [cle, valeur] = entrees[0];
  const chemin = `${label}.${cle}`;
  if (!permis.has(String(cle).toLowerCase())) {
    throw new VerificationChannelViolation(
      `« ${cle} » n’est pas un rôle de vérification déclaré au registre`, chemin,
    );
  }
  if (typeof valeur !== 'string' || !valeur) {
    throw new VerificationChannelViolation('la valeur n’est pas une chaîne non vide', chemin);
  }
  if (!VERIFICATION_VALUE_PATTERNS.some((re) => re.test(valeur))) {
    /**
     * La forme est vérifiée pour empêcher le cas qui compte : un `sk_…` rangé
     * sous le nom `webhookSecret`. Le nom autorise, la forme confirme — les
     * deux, parce que l'un sans l'autre se contourne.
     */
    throw new VerificationChannelViolation(
      'la valeur n’a pas la forme d’un secret de signature', chemin,
    );
  }
  return payload;
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
  verificationOnlyRoles,
  assertVerificationSecretOnly,
  ProviderSecretLeakError,
  VerificationChannelViolation,
  GUARD_VOCABULARY,
};
