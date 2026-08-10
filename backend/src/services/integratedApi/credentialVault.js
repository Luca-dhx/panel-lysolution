// LE COFFRE — chiffrement, masquage, et la seule porte de déchiffrement.
//
// docs/architecture/INTEGRATED_API_CONTROL_PLANE_ROADMAP.md §12.1.
//
// ── TROIS FONCTIONS, ET UNE SEULE QUI DÉCHIFFRE ─────────────────────────────
//
//   encryptCredentialValues()  clair  → chiffré      (écriture)
//   maskCredentialSet()        chiffré → présentable (lecture publique)
//   decryptCredentialSet()     chiffré → clair       (SEULE porte de sortie)
//
// `decryptCredentialSet` est volontairement courte et unique : c'est le point
// à relire quand on doute de l'étanchéité. Ses appelants légitimes sont
// comptés — la validation de connexion (L1) et, plus tard, la passerelle de
// capacités (L3). Aucun contrôleur, aucune route, aucun sérialiseur.
//
// ── LE PIÈGE ÉVITÉ ──────────────────────────────────────────────────────────
//
// Un formulaire d'administration masque les secrets. S'il renvoie des champs
// vides et qu'on les écrit, il EFFACE les clés à chaque enregistrement. Ici,
// une valeur vide ne touche à rien : pour retirer un identifiant, il faut le
// NOMMER dans `remove`. C'est le comportement de l'ancien service du Panel,
// et il était juste.
import { createHash, randomUUID } from 'node:crypto';

import ApiError from '../../utils/ApiError.js';
import { encryptSecret, decryptSecret } from '../../utils/panelCrypto.js';
import { nowIso } from '../../bridge/bridgeContract.js';
import {
  administrableRoles,
  credentialRole,
  credentialRoles,
  requiredRoleCodes,
  defaultRoleValue,
} from './providerRegistry.js';

/** Empreinte NON réversible. Constate un changement, ne permet pas de lire. */
export function fingerprint(value) {
  return createHash('sha256').update(String(value), 'utf8').digest('hex').slice(0, 12);
}

/** Quatre derniers caractères — reconnaître une clé sans pouvoir s'en servir. */
function lastFourOf(value) {
  const text = String(value);
  return text.length >= 8 ? text.slice(-4) : '';
}

/** Mongoose rend des Map ; les objets nus sont plus simples à manipuler. */
export function toPlainObject(value) {
  if (!value) return {};
  if (value instanceof Map) return Object.fromEntries(value);
  if (typeof value.toObject === 'function') return value.toObject();
  return { ...value };
}

/** Identifiant d'un jeu — stable, opaque, sans information métier. */
export function newCredentialSetId() {
  return randomUUID();
}

/* -------------------------------------------------------------------------- */
/*  ÉCRITURE                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Applique un lot de valeurs sur un jeu existant.
 *
 * @param {object} args
 * @param {string} args.provider
 * @param {object} args.current      `credentialsEncrypted` actuel (objet nu)
 * @param {object} args.values       { rôle: valeur en clair }
 * @param {string[]} args.remove     rôles à retirer explicitement
 * @param {string|null} args.environment  pour valider les préfixes attendus
 * @param {string|null} args.actor
 * @returns {{stored: object, written: string[], removed: string[]}}
 */
export function encryptCredentialValues({
  provider,
  current = {},
  values = {},
  remove = [],
  environment = null,
  actor = null,
}) {
  const stored = { ...toPlainObject(current) };
  const written = [];
  const removed = [];
  const at = nowIso();

  for (const [roleCode, raw] of Object.entries(values)) {
    // Une valeur absente CONSERVE l'existante. Voir l'entête : sans cette
    // règle, un formulaire masqué efface le coffre à chaque sauvegarde.
    if (raw === undefined || raw === null || String(raw).trim() === '') continue;

    const definition = credentialRole(provider, roleCode);
    if (!definition) {
      throw ApiError.badRequest(
        'PANEL_INTEGRATED_API_ROLE_UNKNOWN',
        `Enregistrement refusé : « ${roleCode} » n’est pas un identifiant de ${provider}.`,
      );
    }

    const value = String(raw).trim();
    assertExpectedPrefix({ provider, definition, value, environment });

    stored[roleCode] = {
      encrypted: encryptSecret(value),
      fingerprint: fingerprint(value),
      // Un rôle public n'a pas besoin d'être reconnu par ses quatre derniers
      // caractères : sa valeur est rendue en clair par le masquage.
      lastFour: definition.secret ? lastFourOf(value) : '',
      secret: definition.secret,
      updatedAt: at,
      updatedBy: actor,
    };
    written.push(roleCode);
  }

  for (const roleCode of remove) {
    if (stored[roleCode] !== undefined) {
      delete stored[roleCode];
      removed.push(roleCode);
    }
  }

  return { stored, written, removed };
}

/**
 * GARDE-FOU DE PRÉFIXE — détecte une clé de production saisie en recette.
 *
 * Ce n'est pas une validation cryptographique, c'est le filet qui rattrape le
 * copier-coller. Un `sk_live_` collé dans le jeu TEST est refusé AVANT d'être
 * chiffré : une fois en base, on ne saurait plus le distinguer.
 */
function assertExpectedPrefix({ provider, definition, value, environment }) {
  if (!definition.prefixByEnvironment || !environment) {
    if (definition.prefixHint && !value.startsWith(definition.prefixHint)) {
      throw ApiError.badRequest(
        'PANEL_INTEGRATED_API_PREFIX_UNEXPECTED',
        `Enregistrement refusé : « ${definition.label} » commence normalement par « ${definition.prefixHint} ».`,
      );
    }
    return;
  }
  const expected = definition.prefixByEnvironment[environment];
  if (!expected || value.startsWith(expected)) return;

  const otherEnvironment = Object.entries(definition.prefixByEnvironment)
    .find(([env, prefix]) => env !== environment && value.startsWith(prefix));

  if (otherEnvironment) {
    throw ApiError.badRequest(
      'PANEL_INTEGRATED_API_PREFIX_WRONG_ENVIRONMENT',
      `Enregistrement refusé : cette clé ${provider} est une clé ${otherEnvironment[0]}, `
      + `et vous configurez le jeu ${environment}. C’est exactement la confusion qui met `
      + `une clé de production dans une recette.`,
    );
  }
  throw ApiError.badRequest(
    'PANEL_INTEGRATED_API_PREFIX_UNEXPECTED',
    `Enregistrement refusé : « ${definition.label} » en ${environment} commence normalement par « ${expected} ».`,
  );
}

/* -------------------------------------------------------------------------- */
/*  LECTURE PUBLIQUE                                                          */
/* -------------------------------------------------------------------------- */

/**
 * VUE PRÉSENTABLE d'un jeu — ce que l'API a le droit de rendre.
 *
 * Un rôle confidentiel n'expose que son empreinte et ses quatre derniers
 * caractères. Un rôle public (clé publiable, URL de base) expose sa valeur :
 * la masquer n'apporterait aucune sécurité — une clé publiable est faite pour
 * être servie à un navigateur — et empêcherait de la relire.
 *
 * La distinction vient du registre, jamais d'une décision locale.
 */
export function maskCredentialSet(provider, credentialsEncrypted, { environment = null } = {}) {
  const stored = toPlainObject(credentialsEncrypted);
  const view = {};

  // Les rôles `internal` n'ont pas de vue — pas même « non configuré ».
  // Annoncer leur EXISTENCE serait déjà dire quelque chose du coffre : un
  // secret retiré et encore accepté quelques minutes n'est l'affaire de
  // personne d'autre que du vérificateur de signature.
  for (const role of administrableRoles(provider)) {
    const entry = stored[role.code];
    if (!entry) {
      view[role.code] = {
        configured: false,
        secret: role.secret,
        fingerprint: null,
        maskedValue: null,
        value: null,
        defaultValue: defaultRoleValue(provider, role.code, environment),
        updatedAt: null,
      };
      continue;
    }
    // On se fie au drapeau FIGÉ à l'écriture, pas au registre courant : une
    // valeur écrite comme confidentielle ne redevient jamais lisible.
    const isSecret = entry.secret !== false;
    view[role.code] = {
      configured: true,
      secret: isSecret,
      fingerprint: entry.fingerprint || null,
      maskedValue: isSecret ? maskFromLastFour(entry.lastFour) : null,
      value: isSecret ? null : safeDecrypt(entry.encrypted),
      defaultValue: defaultRoleValue(provider, role.code, environment),
      updatedAt: entry.updatedAt ?? null,
    };
  }
  return view;
}

/** « •••• 4xK2 » — assez pour reconnaître, jamais assez pour utiliser. */
export function maskFromLastFour(lastFour) {
  return lastFour ? `••••••••${lastFour}` : '••••••••';
}

/**
 * Déchiffrement TOLÉRANT réservé aux valeurs PUBLIQUES.
 *
 * Une clé de chiffrement changée rend le coffre illisible. Pour une valeur
 * publique, on préfère afficher « valeur illisible » plutôt que faire échouer
 * la page entière : l'opérateur doit pouvoir voir l'état du système au moment
 * précis où quelque chose ne va pas.
 */
function safeDecrypt(encrypted) {
  try {
    return decryptSecret(encrypted);
  } catch {
    return null;
  }
}

/* -------------------------------------------------------------------------- */
/*  DÉCHIFFREMENT — LA SEULE PORTE                                            */
/* -------------------------------------------------------------------------- */

/**
 * Rend les identifiants EN CLAIR.
 *
 * ── APPELANTS LÉGITIMES, ET AUCUN AUTRE ─────────────────────────────────────
 *   · `providerValidation.js`  — teste une connexion (L1)
 *   · la passerelle de capacités — exécutera les appels métier (L3)
 *
 * Jamais un contrôleur. Jamais une route. Jamais un sérialiseur. Jamais un
 * journal. Le résultat de cette fonction ne doit pas traverser une frontière
 * réseau, dans quelque sens que ce soit.
 *
 * Les valeurs par défaut du registre COMPLÈTENT le résultat : une URL de base
 * non saisie vaut celle du catalogue. Un driver ne code donc jamais d'URL.
 */
export function decryptCredentialSet(provider, credentialsEncrypted, { environment = null } = {}) {
  const stored = toPlainObject(credentialsEncrypted);
  const values = {};

  for (const role of credentialRoles(provider)) {
    const entry = stored[role.code];
    if (entry?.encrypted) {
      try {
        values[role.code] = decryptSecret(entry.encrypted);
        continue;
      } catch (err) {
        // 500 et non 400 : le coffre est illisible, ce n'est pas la faute de
        // l'appelant. Le message nomme la cause la plus probable sans jamais
        // révéler ce qu'il tentait de lire.
        throw new ApiError(
          500,
          'PANEL_INTEGRATED_API_DECRYPT_FAILED',
          `Déchiffrement impossible pour ${provider}.${role.code} — la clé de chiffrement du Panel a-t-elle changé ?`,
          { cause: err?.message },
        );
      }
    }
    const fallback = defaultRoleValue(provider, role.code, environment);
    if (fallback !== null) values[role.code] = fallback;
  }
  return values;
}

/* -------------------------------------------------------------------------- */
/*  ÉTAT                                                                      */
/* -------------------------------------------------------------------------- */

/** Tous les rôles requis sont-ils présents ? */
export function isConfigured(provider, credentialsEncrypted) {
  const stored = toPlainObject(credentialsEncrypted);
  const required = requiredRoleCodes(provider);
  if (required.length === 0) return Object.keys(stored).length > 0;
  return required.every((code) => Boolean(stored[code]?.encrypted));
}

/**
 * Empreinte de l'ENSEMBLE des rôles requis.
 *
 * Elle prouve qu'une validation réussie porte sur les valeurs actuellement en
 * place. Sans elle, « valide » pourrait dater d'une clé remplacée depuis —
 * l'écran afficherait un feu vert pour une clé morte.
 *
 * Chaîne vide si la configuration est incomplète : il n'y a alors rien à
 * prouver.
 */
export function requiredFingerprint(provider, credentialsEncrypted) {
  const stored = toPlainObject(credentialsEncrypted);
  const required = requiredRoleCodes(provider).slice().sort();
  if (required.length === 0) return '';
  const parts = [];
  for (const code of required) {
    const entry = stored[code];
    if (!entry?.fingerprint) return '';
    parts.push(`${code}:${entry.fingerprint}`);
  }
  return createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 16);
}

export default {
  fingerprint,
  newCredentialSetId,
  toPlainObject,
  encryptCredentialValues,
  maskCredentialSet,
  maskFromLastFour,
  decryptCredentialSet,
  isConfigured,
  requiredFingerprint,
};
