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

/**
 * Les CLÉS écrites dépendent du projet de destination : c'est le schéma de SON
 * `SystemConfiguration`, pas une donnée du moteur. Le profil les déclare via
 * `RUNTIME_NETWORK_URLS` ; on valide donc les clés RÉELLEMENT produites.
 */
const keysOf = (urls) => Object.keys(urls || {});

/** Valide un jeu d'URLs. `requirePublic` refuse localhost/http en destination publique. */
export function validateNetworkUrls(urls, { requirePublic = true } = {}) {
  const bad = [];
  const local = [];
  const KEYS = keysOf(urls);
  if (!KEYS.length) throw new RuntimeConfigError('RUNTIME_CONFIG_INVALID', 'Aucune URL réseau à publier (profil sans RUNTIME_NETWORK_URLS ?).', { invalid: [] });
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

/**
 * URLs canoniques d'une destination, DÉRIVÉES DU PROFIL.
 *
 * `RUNTIME_NETWORK_URLS` du profil décrit quelle clé du `SystemConfiguration`
 * de la destination reçoit quelle URL :
 *   { websiteUrl: { app: '<id>' }, backendUrl: { api: true }, … }
 * Le moteur ne connaît donc aucune clé applicative en propre : un projet sans
 * espace de gestion n'écrit tout simplement pas de `managerUrl`.
 */
export function deriveNetworkUrls({ siteHost, apiHost, topology, map } = {}) {
  const site = `https://${siteHost}`;
  const spec = map ?? topology?.runtimeNetworkUrls ?? null;
  if (!spec) {
    // Profil muet : on publie au minimum le site et l'API (aucune invention).
    return { websiteUrl: site, backendUrl: apiHost ? `https://${apiHost}` : site };
  }
  const urls = {};
  for (const [key, ref] of Object.entries(spec)) {
    if (ref?.api) {
      urls[key] = apiHost ? `https://${apiHost}` : site;
    } else if (ref?.app) {
      const host = topology?.hosts?.[ref.app];
      // Une clé qui référence une application absente du profil est une
      // incohérence de configuration : on le dit, on n'invente pas d'hôte.
      if (!host) throw new RuntimeConfigError('RUNTIME_CONFIG_INVALID', `RUNTIME_NETWORK_URLS.${key} référence l’application « ${ref.app} », absente de la topologie.`, { key, app: ref.app });
      urls[key] = `https://${host}`;
    } else if (ref?.site) {
      urls[key] = site;
    }
  }
  return urls;
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
    // On n'écrit QUE les clés produites par le profil de la destination.
    const set = { updatedAt: stamp };
    for (const [k, v] of Object.entries(urls)) set[`network.${k}`] = v;
    if (existing) {
      await coll.updateOne({ _id: existing._id }, { $set: set });
    } else {
      created = true;
      await coll.insertOne({ network: { ...urls }, createdAt: stamp, updatedAt: stamp });
    }

    // RELECTURE : source de vérité, valide ce qui a réellement atterri.
    const after = await coll.findOne({});
    const all = after?.network || {};
    // On ne relit QUE ce qu'on a écrit : une clé étrangère au profil de cette
    // destination ne doit pas faire échouer la synchronisation.
    const got = Object.fromEntries(Object.keys(urls).map((k) => [k, all[k]]));
    for (const k of Object.keys(urls)) {
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

/** Résumé NON sensible pour le rapport : les clés réellement publiées. */
export function describeRuntimeConfig(result) {
  return { ...result.urls, created: result.created };
}

export default { syncRuntimeNetworkConfiguration, validateNetworkUrls, deriveNetworkUrls, describeRuntimeConfig, RuntimeConfigError };
