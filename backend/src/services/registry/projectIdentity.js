// ============================================================================
// IDENTITÉ TECHNIQUE D'UN PROJET — source UNIQUE de la clé et de l'URL
// normalisée. Aucun autre fichier ne fabrique de projectKey.
//
// ── POURQUOI LA CLÉ N'EST PLUS SAISIE ───────────────────────────────────────
// Le projet est propriétaire de sa propre clé : il la dérive de son nom
// (`deriveProjectKey` côté projet) et l'annonce au bootstrap, où le Panel la
// confronte à sa fiche. Faire saisir cette clé à la main, c'était demander à
// un humain de deviner une valeur déjà calculée ailleurs — et transformer la
// moindre faute de frappe en « code d'appairage invalide », message qui
// n'indique jamais la vraie cause.
//
// Depuis le contrat 1.4.0, le ping public annonce cette clé : le Panel la LIT
// au lieu de la deviner. Les replis ci-dessous n'existent que pour les projets
// parlant encore 1.3.x, et la clé posée est de toute façon RÉCONCILIÉE avec
// celle que le projet annonce au bootstrap.
// ============================================================================

/** Forme imposée à toute clé du registre (identique au miroir de contrat). */
export const PROJECT_KEY_RE = /^[a-z0-9][a-z0-9-]{1,118}[a-z0-9]$/;

/**
 * Slug kebab-case — MÊME algorithme que le `deriveProjectKey` des projets
 * (« Mon Projet 06 » -> « mon-projet-06 »). Les deux côtés doivent produire
 * la même clé à partir du même nom, sans quoi la réconciliation aurait du
 * travail là où elle ne devrait rien avoir à faire.
 */
export function slugify(value) {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * URL de backend sous forme CANONIQUE — la même adresse écrite de dix façons
 * doit donner une seule chaîne, sinon la détection de doublons est aveugle :
 * schéma et hôte en minuscules, port par défaut retiré, barre finale retirée.
 *
 * @returns {string|null} `null` si ce n'est pas une URL http(s) exploitable.
 */
export function normalizeBackendUrl(url) {
  if (typeof url !== 'string' || url.trim().length === 0) return null;
  let parsed;
  try {
    parsed = new URL(url.trim());
  } catch {
    return null;
  }
  if (!/^https?:$/.test(parsed.protocol)) return null;

  const defaultPort = parsed.protocol === 'https:' ? '443' : '80';
  const port = parsed.port && parsed.port !== defaultPort ? `:${parsed.port}` : '';
  const path = parsed.pathname.replace(/\/+$/, '');
  return `${parsed.protocol}//${parsed.hostname.toLowerCase()}${port}${path}`;
}

/**
 * CLÉ TECHNIQUE d'un projet — déterministe, stable, jamais saisie.
 *
 * Ordre de préférence, du plus autoritaire au plus dégradé :
 *   1. la clé annoncée par le projet lui-même (ping >= 1.4.0) — la seule qui
 *      soit vraie par construction ;
 *   2. le nom que le projet se donne (ping >= 1.4.0), slugifié comme il le
 *      ferait lui-même ;
 *   3. le nom saisi par l'utilisateur, slugifié ;
 *   4. l'hôte de l'URL normalisée — dernier recours, mais STABLE : c'est
 *      l'adresse même du projet, pas une valeur d'ambiance.
 *
 * Aucune horloge, aucun aléa, aucun compteur : deux appels identiques rendent
 * la même clé. C'est ce qui rend « deux clics » inoffensif.
 *
 * @returns {{ projectKey: string, source: 'BRIDGE_KEY'|'BRIDGE_NAME'|'NAME'|'URL' }}
 */
export function generateProjectKey({ bridgeIdentity = null, projectName = null, publicBackendUrl = null } = {}) {
  const candidates = [
    ['BRIDGE_KEY', slugify(bridgeIdentity?.projectKey)],
    ['BRIDGE_NAME', slugify(bridgeIdentity?.projectName)],
    ['NAME', slugify(projectName)],
    ['URL', slugify(new URL(normalizeBackendUrl(publicBackendUrl) ?? 'http://x').hostname)],
  ];

  for (const [source, candidate] of candidates) {
    if (PROJECT_KEY_RE.test(candidate)) return { projectKey: candidate, source };
  }
  return null;
}

/**
 * Nom lisible retenu pour la fiche. Le projet a le dernier mot sur son propre
 * nom quand il l'annonce ; la saisie de l'utilisateur ne sert qu'à nommer un
 * projet qui ne se nomme pas encore (contrat 1.3.x) — ou à le renommer
 * délibérément.
 */
export function resolveProjectName({ bridgeIdentity = null, projectName = null, publicBackendUrl = null } = {}) {
  const typed = typeof projectName === 'string' ? projectName.trim() : '';
  if (typed.length > 0) return typed;
  const announced = typeof bridgeIdentity?.projectName === 'string' ? bridgeIdentity.projectName.trim() : '';
  if (announced.length > 0) return announced;
  const normalized = normalizeBackendUrl(publicBackendUrl);
  return normalized ? new URL(normalized).hostname : null;
}

export default { generateProjectKey, normalizeBackendUrl, resolveProjectName, slugify, PROJECT_KEY_RE };
