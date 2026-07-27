/**
 * Vérification de la PROPAGATION DNS publique.
 *
 * Trois états distincts, jamais confondus :
 *   1. succès de l'appel API Hostinger (mutation acceptée) ;
 *   2. visibilité dans la zone (relecture après écriture) ;
 *   3. RÉSOLUTION DNS PUBLIQUE effective (ce module).
 *
 * On interroge la résolution publique du hostname, avec tentatives bornées et
 * intervalle progressif, sans jamais attendre indéfiniment (timeout global).
 */
import { checkDomainPointsToVps } from '../dns.js';

/**
 * @param {string} hostname
 * @param {string} expectedIp
 * @param {object} [opts]
 * @param {number} [opts.timeoutMs]  budget global (déf. 120 s)
 * @param {number} [opts.minIntervalMs] intervalle initial (déf. 3 s)
 * @param {number} [opts.maxIntervalMs] intervalle max (déf. 15 s)
 * @param {(evt:object)=>void} [opts.onAttempt]
 * @param {(host:string, ip:string)=>Promise<object>} [opts.resolver] mesure de résolution (déf. DNS réel)
 * @returns {Promise<{resolved:boolean, pointsToVps:boolean, addresses:string[], attempts:number, elapsedMs:number, timedOut:boolean}>}
 */
export async function waitForResolution(hostname, expectedIp, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? 120_000;
  const minInterval = opts.minIntervalMs ?? 3_000;
  const maxInterval = opts.maxIntervalMs ?? 15_000;
  const resolver = opts.resolver || checkDomainPointsToVps;
  const startedAt = Date.now();
  let attempts = 0;
  let last = { resolves: false, pointsToVps: false, addresses: [] };
  while (Date.now() - startedAt < timeoutMs) {
    attempts += 1;
    last = await resolver(hostname, expectedIp);
    opts.onAttempt?.({ attempt: attempts, ...last, elapsedMs: Date.now() - startedAt });
    if (last.pointsToVps) {
      return { resolved: true, pointsToVps: true, addresses: last.addresses, attempts, elapsedMs: Date.now() - startedAt, timedOut: false };
    }
    const interval = Math.min(maxInterval, minInterval * 2 ** (attempts - 1));
    if (Date.now() - startedAt + interval >= timeoutMs) break;
    await sleep(interval);
  }
  return {
    resolved: last.resolves,
    pointsToVps: false,
    addresses: last.addresses,
    attempts,
    elapsedMs: Date.now() - startedAt,
    timedOut: true,
  };
}

function sleep(ms) {
  return new Promise((r) => {
    const t = setTimeout(r, ms);
    t.unref?.();
  });
}

export default { waitForResolution };
