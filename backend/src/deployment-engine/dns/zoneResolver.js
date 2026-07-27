/**
 * Résolution de zone DNS à partir d'un hostname, via Public Suffix List (tldts).
 *
 * On NE suppose PAS que la zone = les deux derniers segments (faux pour co.uk,
 * com.br, etc.). tldts embarque la PSL et donne le domaine « registrable ».
 *
 * Exemples :
 *   demo-sbauto.lycarz.com          -> zone lycarz.com,      relatif demo-sbauto
 *   manager.demo-sbauto.lycarz.com  -> zone lycarz.com,      relatif manager.demo-sbauto
 *   exemple.co.uk                   -> zone exemple.co.uk,   relatif @
 *   www.client.fr                   -> zone client.fr,       relatif www
 *
 * Si une liste de zones réellement gérées est fournie (findBestManagedZone), on
 * choisit la zone gérée la PLUS SPÉCIFIQUE qui est un suffixe de l'hôte.
 */
import { parse } from 'tldts';
import { ValidationError } from '../errors.js';

/** Nom relatif d'un hostname dans une zone (« @ » pour l'apex). */
export function relativeName(hostname, zone) {
  const h = hostname.toLowerCase();
  const z = zone.toLowerCase();
  if (h === z) return '@';
  if (h.endsWith(`.${z}`)) return h.slice(0, h.length - z.length - 1);
  return null; // l'hôte n'appartient pas à la zone
}

/**
 * Analyse un hostname et déduit la zone registrable + le nom relatif.
 * @returns {{ hostname:string, zone:string, relativeName:string, isIp:boolean }}
 * @throws ValidationError si l'hôte est invalide / une IP / localhost.
 */
export function resolveZone(hostname) {
  if (!hostname || typeof hostname !== 'string') throw new ValidationError('Hostname manquant.');
  const host = hostname.trim().toLowerCase();
  const info = parse(host);
  if (info.isIp) throw new ValidationError('Une adresse IP directe n’a pas de zone DNS gérable.');
  if (!info.domain || !info.domainWithoutSuffix) {
    // localhost, TLD nu, hôte invalide…
    throw new ValidationError(`Impossible de déterminer la zone DNS de « ${hostname} ».`);
  }
  const zone = info.domain; // domaine registrable (eTLD+1) — la zone gérable
  return { hostname: host, zone, relativeName: relativeName(host, zone) ?? '@', isIp: false };
}

/**
 * Parmi des zones réellement gérées, choisit la plus spécifique couvrant l'hôte.
 * @param {string} hostname
 * @param {string[]} managedZones
 * @returns {{ zone:string, relativeName:string }|null}
 */
export function findBestManagedZone(hostname, managedZones = []) {
  const host = hostname.trim().toLowerCase();
  const candidates = managedZones
    .map((z) => z.toLowerCase())
    .filter((z) => host === z || host.endsWith(`.${z}`))
    .sort((a, b) => b.length - a.length); // la plus longue (plus spécifique) d'abord
  if (candidates.length === 0) return null;
  const zone = candidates[0];
  return { zone, relativeName: relativeName(host, zone) ?? '@' };
}

export default { resolveZone, relativeName, findBestManagedZone };
