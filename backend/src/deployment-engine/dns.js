/**
 * Contrôles DNS (Cas 2 : domaine client).
 *
 * Le moteur ne MODIFIE JAMAIS le DNS. Il se contente de VÉRIFIER, pour un
 * domaine client (ex: sbauto06.fr), que :
 *   - le domaine résout (enregistrement A/AAAA existant) ;
 *   - il pointe bien vers l'IP publique du VPS cible.
 *
 * Pour un sous-domaine de wildcard géré (Cas 1), aucun contrôle DNS n'est requis
 * (le wildcard *.base pointe déjà sur le VPS). C'est `parseTargetUrl` qui pose
 * `requiresDnsCheck`.
 */
import dns from 'node:dns/promises';

/** Résout un hôte en adresses IPv4/IPv6. Ne lève pas : retourne des listes vides. */
export async function resolveHost(host) {
  const out = { v4: [], v6: [], error: null };
  try {
    out.v4 = await dns.resolve4(host);
  } catch (err) {
    if (err.code !== 'ENODATA' && err.code !== 'ENOTFOUND') out.error = err.code || 'DNS_ERROR';
  }
  try {
    out.v6 = await dns.resolve6(host);
  } catch {
    /* IPv6 optionnel */
  }
  return out;
}

/**
 * Vérifie qu'un domaine pointe vers l'IP attendue du VPS.
 * @param {string} host       Domaine client à vérifier.
 * @param {string} expectedIp IP publique du VPS (résolue depuis l'hôte SSH).
 * @returns {Promise<{resolves:boolean, pointsToVps:boolean, addresses:string[], expectedIp:string, error:string|null}>}
 */
export async function checkDomainPointsToVps(host, expectedIp) {
  const { v4, v6, error } = await resolveHost(host);
  const addresses = [...v4, ...v6];
  const resolves = addresses.length > 0;
  const pointsToVps = Boolean(expectedIp) && addresses.includes(expectedIp);
  return { resolves, pointsToVps, addresses, expectedIp: expectedIp || null, error };
}

/**
 * Résout l'IP publique du VPS à partir de son hôte SSH. Si l'hôte est déjà une
 * IP littérale, on la retourne telle quelle.
 */
export async function resolveVpsIp(sshHost) {
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(sshHost)) return sshHost;
  const { v4 } = await resolveHost(sshHost);
  return v4[0] || null;
}

export default { resolveHost, checkDomainPointsToVps, resolveVpsIp };
