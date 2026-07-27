/**
 * ensureDnsRecord — logique IDEMPOTENTE, sûre vis-à-vis des conflits, et
 * consciente des wildcards. Opère sur un DnsProvider abstrait (jamais couplée à
 * Hostinger). Ne mute JAMAIS un enregistrement tiers sans accord explicite.
 *
 * Résultat `action` :
 *   - 'none'            : rien à faire (déjà correct).
 *   - 'create'          : enregistrement créé par le moteur.
 *   - 'update'          : enregistrement corrigé (uniquement si allowOverwrite).
 *   - 'wildcard_covers' : une wildcard *.<zone> pointe déjà vers l'IP attendue.
 *   - 'conflict'        : bloqué (CNAME, IP différente, A multiples…). `reason`.
 */

/** Normalise un tableau d'enregistrements (contents en minuscule non requis pour IP). */
function findRecords(records, name) {
  return (records || []).filter((r) => (r.name || '').toLowerCase() === name.toLowerCase());
}

/**
 * @param {object} args
 * @param {import('./DnsProvider.js').DnsProvider} args.provider
 * @param {string} args.zone
 * @param {string} args.relativeName  (« @ » pour l'apex)
 * @param {string} args.expectedIp
 * @param {string} [args.recordType]  défaut 'A'
 * @param {number} [args.ttl]
 * @param {boolean} [args.allowOverwrite] corriger un enregistrement existant divergent
 * @param {object[]} [args.records]   enregistrements déjà lus (évite un GET redondant)
 * @param {boolean} [args.dryRun]     calcule l'action SANS muter (planification)
 * @returns {Promise<object>} détail structuré (pour le rapport)
 */
export async function ensureDnsRecord({ provider, zone, relativeName, expectedIp, recordType = 'A', ttl, allowOverwrite = false, records, dryRun = false }) {
  const list = records || (await provider.listRecords(zone));
  const same = findRecords(list, relativeName);
  const wildcard = findRecords(list, '*').find((r) => r.type === recordType);

  const cname = same.find((r) => (r.type || '').toUpperCase() === 'CNAME');
  const aRec = same.find((r) => (r.type || '').toUpperCase() === recordType);

  const base = { zone, name: relativeName, hostname: relativeName === '@' ? zone : `${relativeName}.${zone}`, type: recordType, expectedIp, ttlRequested: ttl ?? null };

  // 1. CNAME au même nom : conflit (un A et un CNAME ne coexistent pas).
  if (cname) {
    return { ...base, action: 'conflict', reason: 'CNAME_CONFLICT', previous: cname.contents, message: `Un enregistrement CNAME existe déjà pour ${base.hostname}.` };
  }

  // 2. A existant.
  if (aRec) {
    const contents = aRec.contents || [];
    if (contents.length === 1 && contents[0] === expectedIp) {
      return { ...base, action: 'none', reason: 'already_correct', recordId: aRec.id ?? null, ttlApplied: aRec.ttl ?? null, previous: contents };
    }
    if (contents.length > 1) {
      return { ...base, action: 'conflict', reason: 'MULTIPLE_A', previous: contents, message: `Plusieurs enregistrements A existent pour ${base.hostname}.` };
    }
    // A unique mais IP différente.
    if (!allowOverwrite) {
      return { ...base, action: 'conflict', reason: 'WRONG_IP', previous: contents, message: `${base.hostname} pointe vers ${contents[0]} au lieu de ${expectedIp}.` };
    }
    if (dryRun) return { ...base, action: 'update', reason: 'would_correct', previous: contents, managedByEngine: true, planned: true };
    const res = await provider.ensureRecord({ zone, name: relativeName, type: recordType, ttl, content: expectedIp, overwrite: true });
    return { ...base, action: 'update', reason: 'corrected', previous: contents, recordId: res?.recordId ?? null, ttlApplied: res?.ttlApplied ?? null, managedByEngine: true };
  }

  // 3. Pas de A exact : une wildcard couvre-t-elle déjà l'IP ?
  if (wildcard && (wildcard.contents || []).includes(expectedIp)) {
    return { ...base, action: 'wildcard_covers', reason: 'wildcard', wildcardContents: wildcard.contents, message: `Couvert par *.${zone} → ${expectedIp}. Résolution publique vérifiée séparément.` };
  }

  // 4. Rien : on crée.
  if (dryRun) return { ...base, action: 'create', reason: 'would_create', managedByEngine: true, planned: true };
  const res = await provider.ensureRecord({ zone, name: relativeName, type: recordType, ttl, content: expectedIp, overwrite: true });
  return { ...base, action: 'create', reason: 'created', recordId: res?.recordId ?? null, ttlApplied: res?.ttlApplied ?? null, managedByEngine: true };
}

export default ensureDnsRecord;
