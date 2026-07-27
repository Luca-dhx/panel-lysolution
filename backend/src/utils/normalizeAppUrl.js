// Normalisation d'une URL d'application — repris du projet modèle
// (backend/src/utils/normalizeAppUrl.js) : une URL d'app est une ORIGINE,
// rien de plus. Pas de chemin, pas de query, pas de credentials.
export function normalizeAppUrl(value) {
  const raw = String(value ?? '').trim();
  if (!raw) throw new Error('URL vide.');
  if (raw.length > 2048) throw new Error('URL trop longue.');

  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`URL invalide : ${raw}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('URL invalide : protocole http ou https attendu.');
  }
  if (url.username || url.password) {
    throw new Error('URL invalide : credentials interdits.');
  }
  if (url.pathname !== '/' || url.search || url.hash) {
    throw new Error('URL invalide : origine attendue (ni chemin, ni query, ni fragment).');
  }
  return url.origin;
}

export function safeNormalizeAppUrl(value) {
  try {
    return normalizeAppUrl(value);
  } catch {
    return null;
  }
}

// Une URL est publiquement joignable si elle est en HTTPS et ne désigne pas
// une adresse locale — condition exigée en PROD.
export function isPubliclyReachableUrl(value) {
  const normalized = safeNormalizeAppUrl(value);
  if (!normalized) return false;
  const { protocol, hostname } = new URL(normalized);
  if (protocol !== 'https:') return false;
  if (hostname === 'localhost' || hostname.endsWith('.local')) return false;
  if (/^127\./.test(hostname) || hostname === '0.0.0.0' || hostname === '::1') return false;
  return true;
}
