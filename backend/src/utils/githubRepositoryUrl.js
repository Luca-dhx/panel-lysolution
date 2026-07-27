/**
 * URL CANONIQUE du dépôt GitHub d'une instance (`PROJECT_GITHUB_REPOSITORY_URL`).
 *
 * Forme canonique du projet : `https://github.com/<owner>/<repo>.git` — HTTPS,
 * suffixe `.git` (c'est la forme du remote réel et du guide VPS, prête pour un
 * `git clone`). Les saisies sont NORMALISÉES vers cette forme ; tout le reste
 * est refusé — jamais de credentials, jamais d'hébergeur tiers, jamais d'URL
 * partielle. Aucun token n'est accepté ni journalisé.
 */

const OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/; // règles de nommage GitHub
const REPO_RE = /^[A-Za-z0-9._-]{1,100}$/;

/**
 * Normalise une saisie vers la forme canonique, ou lève une Error au message
 * actionnable (sans jamais réfléchir la valeur complète si elle peut contenir
 * un credential).
 *
 * @param {string} value
 * @returns {string} `https://github.com/<owner>/<repo>.git`
 */
export function normalizeGithubRepositoryUrl(value) {
  const raw = String(value ?? '').trim().replace(/\s+/g, '');
  if (!raw) throw new Error("URL du dépôt GitHub requise.");

  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('URL invalide — attendu : https://github.com/organisation/nom-du-repo.git');
  }

  if (url.protocol !== 'https:') {
    throw new Error('Seul HTTPS est accepté (pas de git@, file:, http:…).');
  }
  if (url.username || url.password) {
    // Jamais de credentials/token dans l'URL — et on ne cite PAS la valeur.
    throw new Error("L'URL ne doit contenir aucun identifiant ni token.");
  }
  const host = url.hostname.toLowerCase();
  if (host !== 'github.com' && host !== 'www.github.com') {
    throw new Error('Seules les URL github.com sont acceptées.');
  }
  if (url.search || url.hash) {
    throw new Error("L'URL ne doit contenir ni paramètres ni fragment.");
  }

  const segments = url.pathname.split('/').filter(Boolean);
  if (segments.length !== 2) {
    throw new Error('URL incomplète — attendu : https://github.com/<propriétaire>/<dépôt>.');
  }
  const owner = segments[0];
  let repo = segments[1].replace(/\.git$/i, '');
  if (!OWNER_RE.test(owner)) throw new Error('Propriétaire GitHub invalide.');
  if (!repo || !REPO_RE.test(repo)) throw new Error('Nom de dépôt GitHub invalide.');

  return `https://github.com/${owner}/${repo}.git`;
}

/**
 * Validation non levante : `{ valid, normalized, error }`.
 */
export function validateGithubRepositoryUrl(value) {
  try {
    return { valid: true, normalized: normalizeGithubRepositoryUrl(value), error: null };
  } catch (err) {
    return { valid: false, normalized: null, error: err.message };
  }
}

export default { normalizeGithubRepositoryUrl, validateGithubRepositoryUrl };
