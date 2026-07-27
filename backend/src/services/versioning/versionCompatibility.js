// Compatibilité de versions — règles communes à tout le Panel.
// Contrat de pont : même MAJEURE exigée des deux côtés ; une mineure
// supérieure côté serveur est acceptable (évolutions additives uniquement).
const SEMVER_RE = /^\d+\.\d+\.\d+$/;

export function isValidSemver(value) {
  return typeof value === 'string' && SEMVER_RE.test(value.trim());
}

export function parseSemver(value) {
  if (!isValidSemver(value)) return null;
  const [major, minor, patch] = value.trim().split('.').map(Number);
  return { major, minor, patch };
}

export function compareSemver(a, b) {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa || !pb) return null;
  for (const part of ['major', 'minor', 'patch']) {
    if (pa[part] !== pb[part]) return pa[part] < pb[part] ? -1 : 1;
  }
  return 0;
}

export function sameMajor(a, b) {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa || !pb) return false;
  return pa.major === pb.major;
}

// Un client (projet) est compatible avec un serveur (Panel, ou l'inverse) si
// les deux parlent la même majeure. Toute valeur non semver est incompatible.
export function isContractCompatible(clientVersion, serverVersion) {
  return sameMajor(clientVersion, serverVersion);
}

// Photographie de la dérive d'un ensemble de versions (parc de projets) :
//   { total, unknown, distinct: {version: count}, latest, outdated }
// `unknown` compte les versions absentes/invalides (« jamais vu »).
export function describeDrift(versions) {
  const distinct = {};
  let unknown = 0;
  for (const version of versions) {
    if (!isValidSemver(version)) {
      unknown += 1;
      continue;
    }
    const key = version.trim();
    distinct[key] = (distinct[key] ?? 0) + 1;
  }
  const sorted = Object.keys(distinct).sort((a, b) => compareSemver(a, b));
  const latest = sorted.length > 0 ? sorted[sorted.length - 1] : null;
  const outdated = sorted
    .slice(0, -1)
    .reduce((count, version) => count + distinct[version], 0);
  return { total: versions.length, unknown, distinct, latest, outdated };
}
