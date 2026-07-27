/**
 * Synchronisation de la CONFIGURATION RÉSEAU d'exécution après un déploiement.
 *
 * Écrit `network.{backendUrl,managerUrl,websiteUrl}` dans le singleton
 * `SystemConfiguration` de la base de la DESTINATION (jamais la base locale du
 * moteur). Idempotent, auditable, rejouable, avec RELECTURE de validation.
 *
 * Pourquoi côté destination : un déploiement PROD piloté depuis un backend de
 * contrôle en ENV=TEST doit mettre à jour DB_PROD (la base du site déployé), pas
 * DB_TEST. La base cible est résolue depuis le `.env` distant (MONGODB_URI + nom
 * de base selon l'ENV visé), pas depuis `config` du moteur.
 *
 * Sécurité : sur une destination PUBLIQUE, on REFUSE toute URL localhost/127.0.0.1
 * ou http:// (le site est servi en HTTPS ; une URL locale casserait les médias et
 * les liens — Mixed Content). Aucune valeur secrète n'est manipulée ici.
 */

export class RuntimeConfigError extends Error {
  constructor(code, message, details = null) {
    super(message);
    this.name = 'RuntimeConfigError';
    this.code = code;
    this.details = details;
  }
}

const KEYS = ['backendUrl', 'managerUrl', 'websiteUrl'];

/** Valide un jeu d'URLs. `requirePublic` refuse localhost/http en destination publique. */
export function validateNetworkUrls(urls, { requirePublic = true } = {}) {
  const bad = [];
  const local = [];
  for (const k of KEYS) {
    const v = urls?.[k];
    if (!v || typeof v !== 'string') { bad.push(k); continue; }
    let u;
    try { u = new URL(v); } catch { bad.push(k); continue; }
    if (requirePublic) {
      const host = u.hostname.toLowerCase();
      if (u.protocol !== 'https:') local.push(`${k}=${v} (non https)`);
      else if (host === 'localhost' || host === '127.0.0.1' || host === '0.0.0.0' || host === '::1') local.push(`${k}=${v} (locale)`);
    }
  }
  if (bad.length) throw new RuntimeConfigError('RUNTIME_CONFIG_INVALID', `URLs réseau invalides ou absentes : ${bad.join(', ')}.`, { invalid: bad });
  if (local.length) throw new RuntimeConfigError('RUNTIME_CONFIG_STILL_LOCAL', `URLs réseau locales/non sécurisées interdites en destination publique : ${local.join(', ')}.`, { local });
}

/** URLs canoniques d'une destination (pas encore de sous-domaine api. dédié). */
export function deriveNetworkUrls({ siteHost, managerHost, apiHost } = {}) {
  const site = `https://${siteHost}`;
  return {
    backendUrl: apiHost ? `https://${apiHost}` : site, // /api proxifié sur l'hôte du site tant qu'il n'y a pas d'api.<domaine>
    managerUrl: `https://${managerHost || `manager.${siteHost}`}`,
    websiteUrl: site,
  };
}

/** Connexion native par défaut à la base de la destination. */
async function defaultConnect({ mongoUri, dbName }) {
  const { MongoClient } = await import('mongodb');
  const client = new MongoClient(mongoUri, { serverSelectionTimeoutMS: 10_000 });
  await client.connect();
  return {
    collection: (name) => client.db(dbName).collection(name),
    close: () => client.close(),
  };
}

/**
 * Écrit + relit la configuration réseau dans la base de la destination.
 * @param {object} args
 * @param {string} args.mongoUri
 * @param {string} args.dbName            Base de la destination (DB_PROD/DB_TEST).
 * @param {object} args.urls              { backendUrl, managerUrl, websiteUrl }
 * @param {boolean} [args.requirePublic]  Refuse localhost/http (défaut true).
 * @param {Function} [args.connect]       Fabrique de connexion (injectable tests).
 * @param {string} [args.now]            Horodatage ISO (injectable tests).
 * @returns {Promise<{ok:true, urls:object, created:boolean}>}
 */
export async function syncRuntimeNetworkConfiguration({ mongoUri, dbName, urls, requirePublic = true, connect = defaultConnect, now } = {}) {
  validateNetworkUrls(urls, { requirePublic });
  if (!mongoUri || !dbName) throw new RuntimeConfigError('RUNTIME_CONFIG_SYNC_FAILED', 'Base de destination non résolue (mongoUri/dbName).');

  let conn;
  try {
    conn = await connect({ mongoUri, dbName });
  } catch (err) {
    throw new RuntimeConfigError('RUNTIME_CONFIG_SYNC_FAILED', `Connexion à la base de destination impossible : ${err.message}.`);
  }

  try {
    const coll = conn.collection('systemconfigurations');
    const stamp = now || new Date().toISOString();
    const existing = await coll.findOne({});
    let created = false;
    const set = { 'network.backendUrl': urls.backendUrl, 'network.managerUrl': urls.managerUrl, 'network.websiteUrl': urls.websiteUrl, updatedAt: stamp };
    if (existing) {
      await coll.updateOne({ _id: existing._id }, { $set: set });
    } else {
      created = true;
      await coll.insertOne({ network: { ...urls }, createdAt: stamp, updatedAt: stamp });
    }

    // RELECTURE : source de vérité, valide ce qui a réellement atterri.
    const after = await coll.findOne({});
    const got = after?.network || {};
    for (const k of KEYS) {
      if (got[k] !== urls[k]) {
        throw new RuntimeConfigError('RUNTIME_CONFIG_READBACK_FAILED', `Relecture incohérente pour ${k} : écrit "${urls[k]}", relu "${got[k] ?? '(absent)'}".`, { key: k });
      }
    }
    validateNetworkUrls(got, { requirePublic }); // la relecture ne doit pas être locale
    return { ok: true, urls: got, created };
  } catch (err) {
    if (err instanceof RuntimeConfigError) throw err;
    throw new RuntimeConfigError('RUNTIME_CONFIG_SYNC_FAILED', `Écriture de la configuration réseau impossible : ${err.message}.`);
  } finally {
    await conn.close?.();
  }
}

/** Résumé NON sensible pour le rapport. */
export function describeRuntimeConfig(result) {
  return { backendUrl: result.urls.backendUrl, managerUrl: result.urls.managerUrl, websiteUrl: result.urls.websiteUrl, created: result.created };
}

export default { syncRuntimeNetworkConfiguration, validateNetworkUrls, deriveNetworkUrls, describeRuntimeConfig, RuntimeConfigError };
