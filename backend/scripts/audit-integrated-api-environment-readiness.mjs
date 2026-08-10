#!/usr/bin/env node
// AUDIT DU PARC — l'instance est-elle prête pour « runtime ENV = provider ENV » ?
//
// docs/architecture/INTEGRATED_API_CONTROL_PLANE_ROADMAP.md — lot L1.5.
//
// ── LA QUESTION, ET RIEN QU'ELLE ────────────────────────────────────────────
//
// Le lot L2 révoquera `activeMode` : l'environnement d'un fournisseur sera
// déduit du runtime, sans qu'aucun humain puisse en décider. Avant de livrer
// une rupture pareille, une seule chose compte :
//
//     qu'est-ce que cette règle casserait AUJOURD'HUI ?
//
// Ce script répond, sur les bases RÉELLES, sans rien y écrire.
//
// ── LECTURE SEULE, ET C'EST VÉRIFIABLE ──────────────────────────────────────
//
// Il n'utilise que `listDatabases`, `listCollections`, `find`, `countDocuments`
// et `distinct`. Aucun `save`, aucun `update*`, aucun `delete*`, aucun
// `createIndex`, aucun appel fournisseur. Il n'importe AUCUN modèle mongoose —
// donc aucun hook, aucune migration, aucun seed ne peut se déclencher.
//
// ── AUCUN SECRET N'EST LU, ET ENCORE MOINS IMPRIMÉ ──────────────────────────
//
// Les credentials ne sont jamais déchiffrés : on ne relève que leur PRÉSENCE.
// Les valeurs chiffrées elles-mêmes ne sortent pas de la fonction qui les
// compte. Une empreinte, un `lastFour`, une clé : rien de tout cela n'est
// affiché.
//
// ── SON CODE DE SORTIE ──────────────────────────────────────────────────────
//
// 0 quand l'AUDIT a abouti — même s'il a trouvé vingt écarts. Un écart est un
// constat, pas une panne : le faire échouer rendrait le script inutilisable
// dans la seule situation où il sert à quelque chose.
// 1 uniquement si l'audit lui-même n'a pas pu se faire (base injoignable,
// configuration absente).
//
// Usage :
//   node backend/scripts/audit-integrated-api-environment-readiness.mjs
//   … --json                 sortie machine, pour archivage
//   … --uri <mongodb://…>    surcharge l'URI (défaut : backend/.env du Panel)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BACKEND = path.resolve(HERE, '..');
const PANEL_ROOT = path.resolve(BACKEND, '..');
const PROJECT_ROOT = path.resolve(PANEL_ROOT, '..', 'SB Auto 06');

const require = createRequire(path.join(BACKEND, 'package.json'));
const { MongoClient } = require('mongodb');

const ARGS = process.argv.slice(2);
const flag = (name) => {
  const index = ARGS.indexOf(`--${name}`);
  return index === -1 ? undefined : ARGS[index + 1];
};
const has = (name) => ARGS.includes(`--${name}`);
const JSON_OUTPUT = has('json');

/* -------------------------------------------------------------------------- */
/*  CONFIGURATION — lue des `.env`, jamais devinée                            */
/* -------------------------------------------------------------------------- */

/** Lecture minimale d'un `.env`. On ne charge rien dans `process.env`. */
function readEnvFile(file) {
  if (!fs.existsSync(file)) return {};
  const out = {};
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    out[match[1]] = match[2].trim().replace(/^["']|["']$/g, '');
  }
  return out;
}

/** L'hôte d'une URI, SANS identifiants — journalisable sans rien divulguer. */
function describeHost(uri) {
  const withoutScheme = String(uri).replace(/^mongodb(\+srv)?:\/\//, '');
  const afterCredentials = withoutScheme.includes('@')
    ? withoutScheme.slice(withoutScheme.indexOf('@') + 1)
    : withoutScheme;
  return afterCredentials.split(/[/?]/)[0] || 'hôte inconnu';
}

const panelEnv = readEnvFile(path.join(BACKEND, '.env'));
const projectEnv = readEnvFile(path.join(PROJECT_ROOT, 'backend', '.env'));

const URI = flag('uri') ?? panelEnv.MONGODB_URI ?? '';
if (!URI) {
  console.error('[audit] Aucune MONGODB_URI : renseignez backend/.env ou passez --uri.');
  process.exit(1);
}

/**
 * LES BASES DU PARC — celles qu'on SAIT nommer.
 *
 * Le script liste aussi toutes les bases du cluster (§ « bases inconnues ») :
 * une instance oubliée est exactement le genre de chose qui fait échouer une
 * bascule de doctrine, et elle ne se trouve pas en relisant un `.env`.
 */
const PANEL_DATABASES = [
  { name: panelEnv.DB_TEST, environment: 'TEST' },
  { name: panelEnv.DB_PROD, environment: 'PROD' },
].filter((d) => d.name);

const PROJECT_DATABASES = [
  { name: projectEnv.DB_TEST, environment: 'TEST', project: 'SB Auto 06' },
  { name: projectEnv.DB_PROD, environment: 'PROD', project: 'SB Auto 06' },
].filter((d) => d.name);

/* -------------------------------------------------------------------------- */
/*  PRIMITIVES DE LECTURE                                                     */
/* -------------------------------------------------------------------------- */

/** `true` si la collection existe — évite un `find` sur du néant. */
async function collectionExists(db, name) {
  const found = await db.listCollections({ name }, { nameOnly: true }).toArray();
  return found.length > 0;
}

async function safeFind(db, name, query = {}, options = {}) {
  if (!(await collectionExists(db, name))) return null;
  return db.collection(name).find(query, options).toArray();
}

/** Le document le plus récent selon un champ de date, ou `null`. */
async function latest(db, name, dateField, query = {}) {
  if (!(await collectionExists(db, name))) return null;
  const rows = await db.collection(name)
    .find(query, { projection: { [dateField]: 1 } })
    .sort({ [dateField]: -1 }).limit(1).toArray();
  return rows[0]?.[dateField] ?? null;
}

const iso = (value) => {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toISOString();
};

/**
 * PRÉSENCE d'un credential — jamais sa valeur.
 *
 * Le registre local range les identifiants en `modes.<MODE>.credentials`, une
 * Map de `{ encryptedValue, lastFour }`. On compte les entrées non vides et on
 * rend leurs NOMS. Rien d'autre ne sort d'ici.
 */
function credentialPresence(modeState) {
  const credentials = modeState?.credentials ?? {};
  const names = Object.entries(credentials)
    .filter(([, entry]) => Boolean(entry?.encryptedValue))
    .map(([name]) => name)
    .sort();
  return { present: names.length > 0, count: names.length, names };
}

/* -------------------------------------------------------------------------- */
/*  L'AUDIT                                                                   */
/* -------------------------------------------------------------------------- */

/** Fournisseurs dont l'environnement suivra le runtime en L2. */
const ENVIRONMENT_PROVIDERS = ['STRIPE', 'BREVO', 'YOUSIGN'];
/** Fournisseur global — hors de toute logique TEST/PROD (audit §3). */
const GLOBAL_PROVIDERS = ['HOSTINGER'];

/** Catégories de la matrice (mission L1.5, phase 3). Fermées. */
const MISMATCH = Object.freeze({
  CLEAN: 'CLEAN',
  LEGACY_MISMATCH: 'LEGACY_MISMATCH',
  CREDENTIAL_MISSING_FOR_TARGET_ENV: 'CREDENTIAL_MISSING_FOR_TARGET_ENV',
  BOTH_PRESENT: 'BOTH_PRESENT',
  PROVIDER_NOT_CONFIGURED: 'PROVIDER_NOT_CONFIGURED',
  UNKNOWN: 'UNKNOWN',
});

/**
 * VIVACITÉ d'une base de projet.
 *
 * Une base peut exister sans qu'aucune instance ne la serve : un déploiement
 * remplacé laisse la sienne derrière lui, intacte. Classer ses écarts comme
 * bloquants ferait échouer une bascule pour un monde qui n'existe plus — et,
 * pire, masquerait les écarts réels dans le bruit.
 *
 * Le seuil est volontairement large : une instance vivante écrit au moins un
 * battement ou une projection par jour.
 */
const DORMANT_AFTER_DAYS = 3;

const LIVENESS = Object.freeze({
  LIVE: 'LIVE',
  DORMANT: 'DORMANT',
  EMPTY: 'EMPTY',
});

/** Verdict de bascule (phase 7). Fermé. */
const READINESS = Object.freeze({
  READY_FOR_L2: 'READY_FOR_L2',
  NEEDS_CREDENTIAL_CONFIGURATION: 'NEEDS_CREDENTIAL_CONFIGURATION',
  NEEDS_MODE_CORRECTION: 'NEEDS_MODE_CORRECTION',
  NEEDS_MANUAL_REVIEW: 'NEEDS_MANUAL_REVIEW',
});

/**
 * Classe UN couple (instance, fournisseur).
 *
 * `expectedMode` est l'environnement de l'INSTANCE : c'est toute la règle de
 * L2. Le reste n'est que la description de l'écart.
 */
function classify({ runtimeEnvironment, activeMode, testPresent, prodPresent, configured }) {
  const expectedMode = runtimeEnvironment;
  if (!configured) {
    return { expectedMode, mismatch: MISMATCH.PROVIDER_NOT_CONFIGURED, readiness: READINESS.NEEDS_CREDENTIAL_CONFIGURATION };
  }
  if (!activeMode) {
    return { expectedMode, mismatch: MISMATCH.UNKNOWN, readiness: READINESS.NEEDS_MANUAL_REVIEW };
  }

  const targetPresent = expectedMode === 'TEST' ? testPresent : prodPresent;

  if (activeMode !== expectedMode) {
    // Le cas qui justifie ce lot : la bascule CHANGERAIT le compte utilisé.
    return {
      expectedMode,
      mismatch: MISMATCH.LEGACY_MISMATCH,
      readiness: targetPresent ? READINESS.NEEDS_MODE_CORRECTION : READINESS.NEEDS_CREDENTIAL_CONFIGURATION,
    };
  }
  if (!targetPresent) {
    return { expectedMode, mismatch: MISMATCH.CREDENTIAL_MISSING_FOR_TARGET_ENV, readiness: READINESS.NEEDS_CREDENTIAL_CONFIGURATION };
  }
  if (testPresent && prodPresent) {
    // Conforme aujourd'hui, mais le jeu de l'autre monde dort dans la base
    // d'une instance qui ne s'en servira jamais : à retirer en L10.
    return { expectedMode, mismatch: MISMATCH.BOTH_PRESENT, readiness: READINESS.READY_FOR_L2 };
  }
  return { expectedMode, mismatch: MISMATCH.CLEAN, readiness: READINESS.READY_FOR_L2 };
}

/** Le parc Panel : une ligne par instance appairée ou déclarée. */
async function auditPanelDatabase(client, { name, environment }) {
  const db = client.db(name);
  const exists = (await client.db('admin').admin().listDatabases())
    .databases.some((d) => d.name === name);

  const projects = (await safeFind(db, 'panelprojects')) ?? [];
  const credentialSets = (await safeFind(db, 'panelintegratedapicredentialsets')) ?? [];
  const legacyApis = (await safeFind(db, 'panelintegratedapis')) ?? [];

  return {
    database: name,
    declaredEnvironment: environment,
    exists,
    instances: projects.map((p) => ({
      projectId: p.projectId,
      projectKey: p.projectKey,
      projectName: p.projectName,
      environment: p.runtime?.environment ?? null,
      declaredEnvironment: p.declaredEnvironment ?? null,
      pairing: p.pairing?.status ?? null,
      softwareVersion: p.runtime?.softwareVersion ?? null,
      publicBackendUrl: p.runtime?.publicBackendUrl ?? null,
      lastHeartbeatAt: iso(p.runtime?.lastHeartbeatAt),
      lastBusinessSyncAt: iso(p.runtime?.lastBusinessSyncAt),
      appliedIntegratedApiCount: p.appliedConfiguration?.integratedApiCount ?? null,
    })),
    controlPlane: credentialSets.map((s) => ({
      provider: s.provider,
      scope: s.scope,
      environment: s.environment ?? null,
      status: s.status,
      // PRÉSENCE seulement — jamais une valeur, jamais une empreinte.
      configuredRoles: Object.keys(s.credentialsEncrypted ?? {}).sort(),
      lastValidatedAt: iso(s.lastValidatedAt),
      lastValidationCode: s.lastValidationCode ?? null,
    })),
    legacyVault: legacyApis.map((a) => ({
      key: a.key,
      provider: a.provider,
      mode: a.mode,
      grants: (a.grants ?? []).map((g) => g.projectId),
      testRoles: Object.keys(a.credentials?.TEST?.values ?? {}).length,
      prodRoles: Object.keys(a.credentials?.PROD?.values ?? {}).length,
    })),
  };
}

/**
 * DATE DE LA DERNIÈRE ÉCRITURE, toutes collections confondues.
 *
 * On ne se fie à aucune collection en particulier : c'est justement quand on
 * se trompe de témoin qu'on déclare morte une base qui vit.
 */
async function lastActivityOf(db, collections) {
  let latest = null;
  let where = null;
  for (const name of collections) {
    for (const field of ['updatedAt', 'createdAt', 'receivedAt', 'occurredAt']) {
      const rows = await db.collection(name)
        .find({ [field]: { $exists: true } }, { projection: { [field]: 1 } })
        .sort({ [field]: -1 }).limit(1).toArray()
        .catch(() => []);
      const value = rows[0]?.[field];
      if (!value) continue;
      const at = new Date(value);
      if (Number.isNaN(at.getTime())) break;
      if (!latest || at > latest) { latest = at; where = `${name}.${field}`; }
      break;
    }
  }
  return { at: latest, where };
}

/** Une instance de projet : ses fournisseurs, leurs modes, et les preuves d'usage. */
async function auditProjectDatabase(client, { name, environment, project }) {
  const db = client.db(name);
  const collections = (await db.listCollections({}, { nameOnly: true }).toArray()).map((c) => c.name);
  if (collections.length === 0) {
    return { database: name, project, declaredEnvironment: environment, exists: false, providers: [], evidence: {} };
  }

  const integrations = (await safeFind(db, 'integratedapis')) ?? [];
  const pairings = (await safeFind(db, 'bridgepairings')) ?? [];
  const systemConfig = (await safeFind(db, 'systemconfigurations')) ?? [];

  const activity = await lastActivityOf(db, collections);
  const ageDays = activity.at ? (Date.now() - activity.at.getTime()) / 86_400_000 : Infinity;
  const liveness = !activity.at ? LIVENESS.EMPTY
    : ageDays <= DORMANT_AFTER_DAYS ? LIVENESS.LIVE : LIVENESS.DORMANT;

  /**
   * L'ENVIRONNEMENT RÉEL DE L'INSTANCE.
   *
   * Il n'est écrit nulle part dans la base — c'est `config.env`, une variable
   * de processus. On retient donc le nom de la base, qui est la convention du
   * parc (`*_test` / `*_prod`), et on le signale comme DÉDUIT : le seul
   * constat direct viendrait d'une instance en cours d'exécution.
   */
  const runtimeEnvironment = environment;

  /* ── Preuves d'usage — par MODE, jamais par activeMode ─────────────────── */
  const evidence = {
    STRIPE: {
      lastPaymentMode: null, lastPaymentAt: null,
      modesSeen: collections.includes('payments')
        ? (await db.collection('payments').distinct('providerMode')).sort() : [],
      paymentCount: collections.includes('payments') ? await db.collection('payments').countDocuments() : 0,
      lastWebhookAt: iso(await latest(db, 'webhookevents', 'receivedAt', { provider: 'STRIPE' })),
    },
    BREVO: {
      modesSeen: collections.includes('emaildeliveries')
        ? (await db.collection('emaildeliveries').distinct('providerMode')).sort() : [],
      deliveryCount: collections.includes('emaildeliveries') ? await db.collection('emaildeliveries').countDocuments() : 0,
      lastDeliveryAt: iso(await latest(db, 'emaildeliveries', 'createdAt')),
      webhookModesSeen: collections.includes('brevowebhookevents')
        ? (await db.collection('brevowebhookevents').distinct('providerMode')).sort() : [],
      lastWebhookAt: iso(await latest(db, 'brevowebhookevents', 'receivedAt')),
    },
    YOUSIGN: {
      lastWebhookAt: iso(await latest(db, 'webhookevents', 'receivedAt', { provider: 'YOUSIGN' })),
      webhookCount: collections.includes('webhookevents')
        ? await db.collection('webhookevents').countDocuments({ provider: 'YOUSIGN' }) : 0,
    },
  };

  if (collections.includes('payments')) {
    const rows = await db.collection('payments')
      .find({}, { projection: { providerMode: 1, environment: 1, createdAt: 1 } })
      .sort({ createdAt: -1 }).limit(1).toArray();
    evidence.STRIPE.lastPaymentMode = rows[0]?.providerMode ?? null;
    evidence.STRIPE.lastPaymentAt = iso(rows[0]?.createdAt);
  }

  const providers = integrations.map((doc) => {
    const test = credentialPresence(doc.modes?.TEST);
    const prod = credentialPresence(doc.modes?.PROD);
    const isGlobal = GLOBAL_PROVIDERS.includes(doc.provider);

    const base = {
      provider: doc.provider,
      enabled: doc.enabled !== false,
      activeMode: doc.activeMode ?? null,
      modeUpdatedAt: iso(doc.modeUpdatedAt),
      scopeInL2: isGlobal ? 'PANEL_GLOBAL' : 'ENVIRONMENT',
      test: {
        present: test.present, roleCount: test.count, roles: test.names,
        configured: Boolean(doc.modes?.TEST?.configured),
        verified: Boolean(doc.modes?.TEST?.verified),
        lastTestedAt: iso(doc.modes?.TEST?.lastTestedAt),
        lastTestStatus: doc.modes?.TEST?.lastTestStatus ?? null,
        webhookLastReceivedAt: iso(doc.modes?.TEST?.webhook?.lastReceivedAt),
      },
      prod: {
        present: prod.present, roleCount: prod.count, roles: prod.names,
        configured: Boolean(doc.modes?.PROD?.configured),
        verified: Boolean(doc.modes?.PROD?.verified),
        lastTestedAt: iso(doc.modes?.PROD?.lastTestedAt),
        lastTestStatus: doc.modes?.PROD?.lastTestStatus ?? null,
        webhookLastReceivedAt: iso(doc.modes?.PROD?.webhook?.lastReceivedAt),
      },
    };

    if (isGlobal) {
      // Un fournisseur global n'a pas de « bon » environnement : la matrice
      // TEST/PROD ne s'y applique pas, et l'y forcer inventerait un écart.
      return {
        ...base, expectedMode: null, mismatch: 'N/A_GLOBAL',
        readiness: READINESS.READY_FOR_L2, blocking: false,
      };
    }

    const verdict = classify({
      runtimeEnvironment,
      activeMode: doc.activeMode ?? null,
      testPresent: test.present,
      prodPresent: prod.present,
      configured: Boolean(doc.modes?.TEST?.configured || doc.modes?.PROD?.configured),
    });

    /**
     * Un écart sur une base DORMANTE reste RAPPORTÉ — on ne l'efface pas, il
     * redeviendrait vrai le jour où l'on ressusciterait cette base. Mais il ne
     * bloque pas la bascule : aucune instance ne le subit aujourd'hui.
     */
    if (liveness !== LIVENESS.LIVE && verdict.readiness !== READINESS.READY_FOR_L2) {
      return { ...base, ...verdict, blocking: false, readiness: READINESS.NEEDS_MANUAL_REVIEW };
    }
    return { ...base, ...verdict, blocking: verdict.readiness !== READINESS.READY_FOR_L2 };
  });

  return {
    database: name,
    project,
    declaredEnvironment: environment,
    runtimeEnvironment,
    runtimeEnvironmentSource: 'DEDUIT_DU_NOM_DE_BASE',
    exists: true,
    liveness,
    lastActivityAt: iso(activity.at),
    lastActivityWhere: activity.where,
    collectionCount: collections.length,
    paired: pairings.length > 0,
    pairing: pairings.map((p) => ({
      panelName: p.panelName ?? null,
      panelUrl: p.panelUrl ?? null,
      projectId: p.projectId ?? null,
      pairedAt: iso(p.pairedAt),
    })),
    network: systemConfig[0]?.network
      ? {
        backendUrl: systemConfig[0].network.backendUrl ?? null,
        managerUrl: systemConfig[0].network.managerUrl ?? null,
        websiteUrl: systemConfig[0].network.websiteUrl ?? null,
      }
      : null,
    providers,
    evidence,
  };
}

/* -------------------------------------------------------------------------- */
/*  RENDU                                                                     */
/* -------------------------------------------------------------------------- */

function pad(value, width) {
  const text = value === null || value === undefined ? '—' : String(value);
  return text.length >= width ? text.slice(0, width) : text + ' '.repeat(width - text.length);
}

function renderTable(rows) {
  const columns = [
    ['INSTANCE', 14], ['VIE', 7], ['ENV', 4], ['PROVIDER', 9], ['ACTIF', 5],
    ['TEST', 6], ['PROD', 6], ['PANEL CIBLE', 11], ['DERNIER USAGE', 20],
    ['STATUT', 26], ['ACTION AVANT L2', 30], ['BLOQUANT', 8],
  ];
  console.log(columns.map(([label, width]) => pad(label, width)).join(' │ '));
  console.log(columns.map(([, width]) => '─'.repeat(width)).join('─┼─'));
  for (const row of rows) {
    console.log([
      pad(row.instance, 14), pad(row.liveness, 7), pad(row.env, 4), pad(row.provider, 9),
      pad(row.activeMode, 5), pad(row.testCred, 6), pad(row.prodCred, 6),
      pad(row.panelTargetCred, 11), pad(row.lastUsed, 20), pad(row.status, 26),
      pad(row.action, 30), pad(row.blocking ? 'OUI' : 'non', 8),
    ].join(' │ '));
  }
}

/* -------------------------------------------------------------------------- */
/*  MAIN                                                                      */
/* -------------------------------------------------------------------------- */

const client = new MongoClient(URI, { serverSelectionTimeoutMS: 15_000, readPreference: 'primaryPreferred' });

try {
  await client.connect();
} catch (err) {
  console.error(`[audit] Connexion impossible à ${describeHost(URI)} : ${err.message}`);
  process.exit(1);
}

try {
  const listing = await client.db('admin').admin().listDatabases();
  const allDatabases = listing.databases.map((d) => d.name)
    .filter((n) => !['admin', 'local', 'config'].includes(n));

  const known = new Set([...PANEL_DATABASES, ...PROJECT_DATABASES].map((d) => d.name));
  const unknown = allDatabases.filter((n) => !known.has(n));

  const panels = [];
  for (const target of PANEL_DATABASES) panels.push(await auditPanelDatabase(client, target));
  const projects = [];
  for (const target of PROJECT_DATABASES) projects.push(await auditProjectDatabase(client, target));

  /* ── Table finale (phase 11) ─────────────────────────────────────────── */
  const rows = [];
  for (const instance of projects) {
    if (!instance.exists) continue;
    for (const provider of instance.providers) {
      const panelSet = panels
        .flatMap((p) => p.controlPlane)
        .find((s) => s.provider === provider.provider
          && (s.environment ?? null) === (provider.expectedMode ?? null));

      const usage = provider.provider === 'STRIPE'
        ? (instance.evidence.STRIPE.lastPaymentMode
          ? `${instance.evidence.STRIPE.lastPaymentMode} · ${(instance.evidence.STRIPE.lastPaymentAt ?? '').slice(0, 10)}`
          : 'UNKNOWN')
        : provider.provider === 'BREVO'
          ? (instance.evidence.BREVO.modesSeen.length
            ? `${instance.evidence.BREVO.modesSeen.join('+')} · ${(instance.evidence.BREVO.lastDeliveryAt ?? '').slice(0, 10)}`
            : 'UNKNOWN')
          : provider.provider === 'YOUSIGN'
            ? (instance.evidence.YOUSIGN.webhookCount
              ? `webhook · ${(instance.evidence.YOUSIGN.lastWebhookAt ?? '').slice(0, 10)}`
              : 'UNKNOWN')
            : 'N/A';

      rows.push({
        instance: `${instance.database}`,
        liveness: instance.liveness,
        blocking: provider.blocking === true,
        env: instance.runtimeEnvironment,
        provider: provider.provider,
        activeMode: provider.activeMode,
        testCred: provider.test.present ? `${provider.test.roleCount}` : 'absent',
        prodCred: provider.prod.present ? `${provider.prod.roleCount}` : 'absent',
        panelTargetCred: panelSet
          ? `${panelSet.status}${panelSet.configuredRoles.length ? ` (${panelSet.configuredRoles.length})` : ''}`
          : 'aucun jeu',
        lastUsed: usage,
        status: provider.mismatch,
        action: provider.readiness,
      });
    }
  }

  const rapport = {
    generatedAt: new Date().toISOString(),
    cluster: describeHost(URI),
    databasesOnCluster: allDatabases,
    unknownDatabases: unknown,
    panels,
    projects,
    matrix: rows,
  };

  if (JSON_OUTPUT) {
    console.log(JSON.stringify(rapport, null, 2));
  } else {
    console.log(`\n══ AUDIT DU PARC — ${rapport.generatedAt} ══`);
    console.log(`Cluster : ${rapport.cluster}`);
    console.log(`Bases présentes : ${allDatabases.join(', ') || '(aucune)'}`);
    console.log(`Bases INCONNUES du parc déclaré : ${unknown.length ? unknown.join(', ') : 'aucune'}`);

    for (const panel of panels) {
      console.log(`\n── PANEL ${panel.declaredEnvironment} · base « ${panel.database} » ${panel.exists ? '' : '(ABSENTE)'}`);
      console.log(`   instances déclarées : ${panel.instances.length}`);
      for (const i of panel.instances) {
        console.log(`     · ${i.projectName} [${i.environment ?? 'env. inconnu'}] ${i.pairing}`
          + ` · ${i.publicBackendUrl ?? 'sans adresse'}`
          + ` · battement ${i.lastHeartbeatAt ?? 'jamais'}`);
      }
      console.log(`   plan de contrôle : ${panel.controlPlane.length} jeu(x)`);
      for (const s of panel.controlPlane) {
        console.log(`     · ${pad(s.provider, 10)} ${pad(s.environment ?? 'GLOBAL', 7)} ${pad(s.status, 12)}`
          + ` ${s.configuredRoles.length} rôle(s)${s.lastValidatedAt ? ` · validé ${s.lastValidatedAt}` : ''}`);
      }
      if (panel.legacyVault.length) {
        console.log(`   ancien coffre : ${panel.legacyVault.length} entrée(s)`);
        for (const a of panel.legacyVault) {
          console.log(`     · ${a.key} (${a.provider}) mode=${a.mode}`
            + ` TEST:${a.testRoles} PROD:${a.prodRoles} · ${a.grants.length} autorisation(s)`);
        }
      }
    }

    for (const p of projects) {
      console.log(`\n── PROJET ${p.project ?? ''} · base « ${p.database} » ${p.exists ? '' : '(ABSENTE)'}`);
      if (!p.exists) continue;
      console.log(`   environnement : ${p.runtimeEnvironment} (${p.runtimeEnvironmentSource})`);
      console.log(`   vivacité : ${p.liveness} · dernière écriture ${p.lastActivityAt ?? 'jamais'}`
        + `${p.lastActivityWhere ? ` (${p.lastActivityWhere})` : ''}`);
      console.log(`   appairé : ${p.paired ? p.pairing.map((x) => `${x.panelName ?? '?'} @ ${x.panelUrl ?? '?'}`).join(', ') : 'non'}`);
      if (p.network) console.log(`   URLs : backend=${p.network.backendUrl ?? '—'} manager=${p.network.managerUrl ?? '—'}`);
      console.log(`   fournisseurs : ${p.providers.length}`);
    }

    console.log('\n══ MATRICE ══\n');
    if (rows.length === 0) console.log('(aucun couple instance × fournisseur)');
    else renderTable(rows);

    const parStatut = rows.reduce((acc, r) => { acc[r.status] = (acc[r.status] ?? 0) + 1; return acc; }, {});
    const parAction = rows.reduce((acc, r) => { acc[r.action] = (acc[r.action] ?? 0) + 1; return acc; }, {});
    console.log(`\nÉcarts : ${JSON.stringify(parStatut)}`);
    console.log(`Actions : ${JSON.stringify(parAction)}`);
    console.log('\nRappel : un écart n’est pas une panne. Ce script sort en 0 quoi qu’il trouve.');
  }
} catch (err) {
  console.error(`[audit] L’audit a échoué : ${err.message}`);
  process.exitCode = 1;
} finally {
  await client.close();
}
