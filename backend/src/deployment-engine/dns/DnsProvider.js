/**
 * Interface DnsProvider — abstraction fournisseur DNS.
 *
 * Le pipeline de déploiement dépend de CETTE interface, jamais du client
 * Hostinger directement. Hostinger est la première implémentation concrète ;
 * d'autres (Cloudflare, OVH…) pourraient s'ajouter sans toucher au moteur.
 *
 * Méthodes :
 *  - verifyCredentials() -> { ok, message, details }   (non destructif)
 *  - listZones()         -> [{ name }]                 (domaines gérés)
 *  - findBestZone(host)  -> { zone, relativeName }|null (zone la plus spécifique)
 *  - listRecords(zone)   -> [{ name, type, ttl, contents: string[] }]
 *  - ensureRecord(input) -> { action, ... }            (idempotent, cf. ensureDns)
 *  - verifyResolution(host, ip, opts) -> { resolves, pointsToVps, addresses }
 */
export class DnsProvider {
  get name() {
    return 'abstract';
  }
  // eslint-disable-next-line no-unused-vars
  async verifyCredentials() {
    throw new Error('verifyCredentials non implémenté');
  }
  async listZones() {
    throw new Error('listZones non implémenté');
  }
  // eslint-disable-next-line no-unused-vars
  async listRecords(zone) {
    throw new Error('listRecords non implémenté');
  }
  // eslint-disable-next-line no-unused-vars
  async ensureRecord(input) {
    throw new Error('ensureRecord non implémenté');
  }
}

export default DnsProvider;
