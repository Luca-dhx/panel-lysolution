/**
 * DnsProvider SIMULÉ, en mémoire — pour les tests (aucun appel réseau).
 * Modélise une zone avec des enregistrements et enregistre les mutations.
 */
import { DnsProvider } from './DnsProvider.js';
import { findBestManagedZone, resolveZone } from './zoneResolver.js';

export class MockDnsProvider extends DnsProvider {
  /**
   * @param {object} opts
   * @param {string[]} [opts.zones]   noms de zones gérées
   * @param {Object<string, object[]>} [opts.records]  zone -> [{name,type,ttl,contents}]
   * @param {boolean} [opts.credentialsOk]
   * @param {Object<string,string>} [opts.resolution]  hostname -> ip publique
   */
  constructor(opts = {}) {
    super();
    this.zones = (opts.zones || []).map((z) => z.toLowerCase());
    this.records = {};
    for (const [z, recs] of Object.entries(opts.records || {})) this.records[z.toLowerCase()] = recs.map((r) => ({ ...r }));
    this.credentialsOk = opts.credentialsOk !== false;
    this.resolution = opts.resolution || {};
    this.mutations = [];
  }

  get name() {
    return 'mock';
  }

  async verifyCredentials() {
    if (!this.credentialsOk) return { ok: false, message: 'Clé invalide.', details: {} };
    return { ok: true, message: `OK (${this.zones.length} zones).`, details: { domainsCount: this.zones.length, sampleDomains: this.zones.slice(0, 5) } };
  }

  async listZones() {
    return this.zones.map((name) => ({ name }));
  }

  async findBestZone(hostname) {
    const managed = findBestManagedZone(hostname, this.zones);
    if (managed) return { ...managed, source: 'managed' };
    const psl = resolveZone(hostname);
    return { zone: psl.zone, relativeName: psl.relativeName, source: 'psl' };
  }

  async listRecords(zone) {
    return (this.records[zone.toLowerCase()] || []).map((r) => ({ name: r.name, type: (r.type || 'A').toUpperCase(), ttl: r.ttl ?? null, contents: r.contents || [] }));
  }

  async ensureRecord({ zone, name, type = 'A', ttl, content, overwrite = true }) {
    const z = zone.toLowerCase();
    this.records[z] = this.records[z] || [];
    const existing = this.records[z].find((r) => r.name === name && (r.type || 'A').toUpperCase() === type);
    if (existing && overwrite) {
      existing.contents = [content];
      existing.ttl = ttl ?? existing.ttl;
    } else if (!existing) {
      this.records[z].push({ name, type, ttl: ttl ?? 300, contents: [content] });
    }
    this.mutations.push({ zone, name, type, content, ttl });
    return { recordId: `mock-${name}-${type}`, ttlApplied: ttl ?? 300 };
  }

  async verifyResolution(hostname, expectedIp) {
    const ip = this.resolution[hostname];
    return { resolves: Boolean(ip), pointsToVps: ip === expectedIp, addresses: ip ? [ip] : [], expectedIp, error: null };
  }
}

export default MockDnsProvider;
