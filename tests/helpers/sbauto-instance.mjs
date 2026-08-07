/**
 * UNE INSTANCE RÉELLE DE SB AUTO — son processus, sa base, son port.
 *
 * ══ POURQUOI UN PROCESSUS SÉPARÉ, ET PAS UN IMPORT ══════════════════════════
 *
 * Un projet est une INSTANCE, et trois choses en font le tour, toutes trois
 * uniques par processus :
 *
 *   · `config.env`     — TEST ou PROD, lu une fois au chargement ;
 *   · `pairingStore`   — UN appairage, en cache RAM, partagé par les deux ponts ;
 *   · la connexion Mongo — UNE base, et la configuration d'entreprise y est un
 *     document SINGLETON.
 *
 * Importer deux fois les mêmes modules dans un seul processus ne donnerait donc
 * pas deux instances : cela donnerait une instance qui se contredit. Chaque
 * instance vit ici dans son propre processus, avec sa propre base, et parle au
 * Panel par le RÉSEAU — c'est-à-dire exactement comme en production.
 *
 * ══ CE QUI EST RÉEL, ET C'EST TOUT LE PROPOS ════════════════════════════════
 *
 *   · `PanelBridge` + `HttpPanelClient` — le vrai transport, le vrai curseur,
 *     le vrai anti-écho, la vraie idempotence par writeId ;
 *   · `applyCompanyChange` / `applyCompanyProfile` — le vrai applicateur de
 *     DEV_COMPANY, avec ses gardes d'environnement et de version ;
 *   · `PanelCompanyConfiguration` — la vraie persistance de l'état appliqué ;
 *   · `describeAppliedConfiguration` — la vraie construction de l'accusé ;
 *   · le routeur `projectBridge` — la vraie surface HTTP que le Panel interroge
 *     pour lire `/identity`.
 *
 * Aucun de ces maillons n'est doublé, enveloppé ni raccourci. Le harnais ne
 * fait que deux choses : câbler ce que `config/bootstrap.js` câble au
 * démarrage, et rendre l'instance PILOTABLE depuis le test (« tire », « bats
 * du cœur », « montre ton état »).
 *
 * ══ LE PILOTAGE ════════════════════════════════════════════════════════════
 *
 * Canal IPC de `child_process.fork` : le parent envoie `{id, cmd, ...}`, on
 * répond `{id, ok, data}` ou `{id, ok:false, error}`. Aucune commande
 * n'écrit à la place d'un service — elles appellent les services.
 */
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import fs from 'node:fs/promises';

const cfg = JSON.parse(process.env.SBAUTO_HARNESS ?? '{}');

/* ══════════════════════════════════════════════════════════════════════════
   1. L'ENVIRONNEMENT DE L'INSTANCE — posé AVANT tout import de son code.
      `config/env.js` est fail-closed : il refuse de démarrer sans ENV, sans
      URI et sans nom de base. C'est ce qui rend une instance non ambiguë.
   ══════════════════════════════════════════════════════════════════════════ */
process.env.ENV = cfg.env;
process.env.MONGODB_URI = cfg.mongoUri;
process.env.DB_TEST = cfg.dbName;
process.env.DB_PROD = cfg.dbName;
process.env.CONTROL_DB_NAME = `${cfg.dbName}_control`;
process.env.JWT_SECRET = 'sbauto-e2e-jwt-secret-0123456789abcdef0123456789';
process.env.PROJECT_NAME = cfg.projectName;
// Aucun ordonnanceur : c'est le TEST qui décide quand une instance tire, sinon
// on ne saurait pas ce qui a déclenché quoi.
process.env.PANEL_SCHEDULER_ENABLED = 'false';
// Aucun appairage automatique au chargement : il est commandé explicitement.
process.env.PANEL_URL = '';
process.env.PANEL_PAIRING_CODE = '';

const backend = cfg.sbautoBackend;
const requireSb = createRequire(path.join(backend, 'package.json'));
const SB = (rel) => pathToFileURL(path.join(backend, rel)).href;
const dep = async (name) => import(pathToFileURL(requireSb.resolve(name)).href);

/* ══════════════════════════════════════════════════════════════════════════
   2. LES VRAIS MODULES DU PROJET.
   ══════════════════════════════════════════════════════════════════════════ */
const mongoose = (await dep('mongoose')).default;
const express = (await dep('express')).default;

const { connectDatabase } = await import(SB('src/config/db.js'));
const { config } = await import(SB('src/config/env.js'));
const panelConfiguration = await import(
  SB('src/services/panelConfiguration/panelConfiguration.service.js')
);
const projectBridgeService = await import(
  SB('src/services/projectBridge/projectBridge.service.js')
);
const bridgeRuntime = await import(SB('src/services/panelBridge/bridgeRuntime.js'));
const projectBridgeRoutes = (await import(SB('src/routes/projectBridge.routes.js'))).default;
const { errorHandler } = await import(SB('src/middlewares/error.middleware.js'));
const { PanelCompanyConfiguration, PanelProvidedApi } = await import(
  SB('src/models/PanelConfiguration.model.js')
);
const ProjectMedia = (await import(SB('src/models/ProjectMedia.model.js'))).default;

let server = null;
let port = null;

/* ══════════════════════════════════════════════════════════════════════════
   3. LE CÂBLAGE — celui de `config/bootstrap.js`, à l'identique.
      Les DEUX chemins d'arrivée d'une configuration (le Panel LIVRE, ou le
      projet TIRE) sont branchés sur les MÊMES applicateurs : sinon le
      résultat dépendrait de la façon dont la donnée est arrivée.
   ══════════════════════════════════════════════════════════════════════════ */
function wire() {
  projectBridgeService.configureProjectBridge({
    changeAppliers: {
      DEV_COMPANY: panelConfiguration.applyCompanyChange,
      INTEGRATED_API_CONFIG: panelConfiguration.applyIntegratedApiChange,
    },
    appliedConfigurationProvider: panelConfiguration.describeAppliedConfiguration,
  });

  bridgeRuntime.configureBridgeRuntime({
    identityProvider: projectBridgeService.getBridgeIdentity,
    manifestProvider: projectBridgeService.buildProjectManifest,
    applyHandlers: {
      DEV_COMPANY: panelConfiguration.applyCompanyChange,
      INTEGRATED_API_CONFIG: panelConfiguration.applyIntegratedApiChange,
    },
    discoveryApplier: async ({ company, integratedApis }) => {
      if (company) await panelConfiguration.applyCompanyProfile(company, 'BOOTSTRAP');
      for (const api of integratedApis ?? []) {
        await panelConfiguration.applyIntegratedApi(api);
      }
    },
  });
}

/** La surface HTTP que le Panel interroge — le vrai routeur, les vraies gardes. */
function serve() {
  const app = express();
  app.use(express.json());
  app.use('/api/project-bridge/v1', projectBridgeRoutes);
  app.use(errorHandler);
  return new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

/** L'inventaire du dossier d'imports — pour prouver qu'aucun fichier n'y arrive. */
async function uploadsSnapshot() {
  try {
    return (await fs.readdir(config.paths.uploads)).sort();
  } catch {
    return [];
  }
}

const bridge = () => bridgeRuntime.getPanelBridge();

/* ══════════════════════════════════════════════════════════════════════════
   4. LES COMMANDES — chacune appelle un service, aucune n'écrit à sa place.
   ══════════════════════════════════════════════════════════════════════════ */
const COMMANDS = {
  async boot() {
    await connectDatabase();
    // Une base coupée doit ÉCHOUER, pas attendre : c'est ce qui rend la panne
    // d'écriture observable dans le test d'échec d'application.
    mongoose.set('bufferCommands', false);
    await PanelCompanyConfiguration.deleteMany({});
    await PanelProvidedApi.deleteMany({});
    wire();
    port = await serve();
    return { port, env: config.env, dbName: config.dbName, projectName: config.projectName };
  },

  async pair({ panelUrl, pairingCode, publicBackendUrl }) {
    const result = await bridgeRuntime.pairWithPanel({ panelUrl, pairingCode, publicBackendUrl });
    return { projectId: result.projectId, panelName: result.panelName ?? null };
  },

  async heartbeat() {
    const identity = await projectBridgeService.getBridgeIdentity();
    return bridge().heartbeat({
      softwareVersion: identity.softwareVersion,
      environment: identity.environment,
    });
  },

  /** LE VRAI RATTRAPAGE — curseur, anti-écho, idempotence, handlers. */
  async pull({ limit = 100 } = {}) {
    return bridge().pullUpdates({ limit });
  },

  /** L'ÉTAT MÉTIER RÉELLEMENT APPLIQUÉ, tel que les écrans du projet le lisent. */
  async state() {
    const b = bridge();
    return {
      company: await panelConfiguration.getCompanyConfiguration(),
      applied: await panelConfiguration.describeAppliedConfiguration({
        lastSyncAt: b?.lastSyncAt ?? null,
      }),
      bridge: b ? b.getStatus() : null,
      projectMediaCount: await ProjectMedia.countDocuments({}),
      uploads: await uploadsSnapshot(),
      configurationCount: await PanelCompanyConfiguration.countDocuments({}),
    };
  },

  /** Le document brut — pour comparer un avant et un après, champ par champ. */
  async raw() {
    return PanelCompanyConfiguration.findOne({ key: 'SINGLETON' }).lean();
  },

  /** L'IDENTITÉ TELLE QUE LE PANEL LA LIRA — construite par le vrai service. */
  async identity() {
    return projectBridgeService.getBridgeIdentity();
  },

  /**
   * CE QUE LA PAGE « AIDE » AFFICHE — par son vrai contrôleur.
   *
   * Pas une relecture du modèle : le handler HTTP réel, celui que le Manager
   * appelle. Ce qui sort d'ici est, mot pour mot, ce que le client voit.
   */
  async help() {
    const ctrl = await import(SB('src/controllers/panelBridge.controller.js'));
    let charge = null;
    const res = { json(body) { charge = body; return this; }, status() { return this; } };
    await ctrl.company({}, res, () => {});
    return charge?.data ?? charge;
  },

  /**
   * ISOLATION TEST/PROD — éprouvée sur le VRAI applicateur.
   *
   * Une configuration d'un autre monde doit être refusée par le projet
   * lui-même, et pas seulement filtrée en amont : mentions légales, domaines
   * et contacts réels s'afficheraient sur un site de recette.
   */
  async applyForeign({ environment }) {
    const courante = await panelConfiguration.getCompanyConfiguration();
    return panelConfiguration.applyCompanyProfile({
      companyId: courante?.companyId ?? '00000000-0000-4000-8000-000000000000',
      slug: 'monde-etranger',
      environment,
      version: 9999,
      identity: { name: 'Entreprise d’un autre monde' },
    }, 'SYNC');
  },

  /**
   * PANNE D'ÉCRITURE RÉELLE — la base est coupée.
   *
   * Aucun applicateur n'est remplacé, aucun handler n'est enveloppé : c'est le
   * VRAI `applyCompanyChange` qui s'exécute, et c'est sa persistance qui
   * échoue. Un faux handler qui lève prouverait qu'on sait lever ; couper la
   * base prouve ce qu'il advient d'une application qui n'aboutit pas.
   */
  async severDatabase() {
    await mongoose.connection.close();
    return { connected: mongoose.connection.readyState === 1 };
  },

  async restoreDatabase() {
    await connectDatabase();
    mongoose.set('bufferCommands', false);
    return { connected: mongoose.connection.readyState === 1 };
  },

  async stop() {
    try { await new Promise((r) => (server ? server.close(r) : r())); } catch { /* déjà fermé */ }
    try { await mongoose.disconnect(); } catch { /* déjà déconnectée */ }
    setTimeout(() => process.exit(0), 20).unref?.();
    return { stopped: true };
  },
};

process.on('message', async (msg) => {
  const { id, cmd, args } = msg ?? {};
  const handler = COMMANDS[cmd];
  if (!handler) {
    process.send({ id, ok: false, error: `Commande inconnue : ${cmd}` });
    return;
  }
  try {
    process.send({ id, ok: true, data: (await handler(args ?? {})) ?? null });
  } catch (err) {
    process.send({
      id, ok: false,
      error: err?.message ?? String(err),
      code: err?.code ?? null,
    });
  }
});

process.send({ ready: true });
