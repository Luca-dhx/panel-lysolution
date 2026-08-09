// DÉRIVE DE PAYLOAD — le contrôle dont l'absence a coûté le plus cher.
//
// ══ CE QU'IL VÉRIFIE, ET POURQUOI AUCUN AUTRE NE LE FAISAIT ══════════════════
//
// `spec-drift` compare les specs OpenAPI des DEUX dépôts entre elles. Elles
// étaient identiques — et toutes deux muettes sur le payload de
// PROJECT_PRESENTATION. Le contrôle était donc vert pendant que l'émetteur
// publiait un champ (`logo`) que le validateur du destinataire refusait.
//
// Personne ne comparait le CODE ÉMETTEUR au SCHÉMA RÉCEPTEUR. C'est ce que fait
// ce fichier : il construit une projection avec le vrai constructeur de SB Auto,
// et la soumet au vrai schéma Zod du Panel.
//
// ══ POURQUOI PLUSIEURS CONFIGURATIONS ════════════════════════════════════════
//
// Le défaut n'apparaissait QUE si l'entreprise avait un logo — c'est-à-dire
// jamais en recette, toujours en production. Un contrôle qui n'éprouve qu'une
// fixture vide reproduit exactement l'angle mort qu'il est censé fermer. On
// balaie donc les configurations qui changent la FORME du payload.
//
// Outil d'atelier : il se retire proprement si le dépôt voisin est absent.
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { pathToFileURL } from 'node:url';

const panelRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sbautoBackend = process.env.SBAUTO_BACKEND_DIR
  ? path.resolve(process.env.SBAUTO_BACKEND_DIR)
  : path.resolve(panelRoot, '..', 'SB Auto 06', 'backend');

if (!fs.existsSync(sbautoBackend)) {
  console.log(`[payload-drift] SKIP : projet modèle introuvable (${sbautoBackend}).`);
  process.exit(0);
}

process.env.PANEL_SKIP_DOTENV = '1';
process.env.ENV = 'TEST';
process.env.MONGODB_URI = process.env.MONGODB_URI ?? 'mongodb://127.0.0.1:27017';
process.env.DB_TEST = 'panel_payload_drift';
process.env.DB_PROD = 'panel_payload_drift';
process.env.JWT_SECRET = 'panel-test-jwt-secret-0123456789abcdef0123456789abcdef';
process.env.BRIDGE_ENCRYPTION_KEY = 'a'.repeat(64);
process.env.PANEL_NAME = 'Panel (payload-drift)';

// Les contrôles vivent hors de `backend/` : la dépendance se résout depuis
// `backend/node_modules`, explicitement.
const { createRequire } = await import('node:module');
const requirePanel = createRequire(path.join(panelRoot, 'backend', 'package.json'));
const { MongoMemoryServer } = await import(
  pathToFileURL(requirePanel.resolve('mongodb-memory-server')).href
);
const mongo = await MongoMemoryServer.create();

const SB = (rel) => pathToFileURL(path.join(sbautoBackend, rel)).href;

// L'instance SB Auto tourne dans CE processus : on ne lui demande que de
// CONSTRUIRE une projection, jamais de la livrer.
process.env.MONGODB_URI = mongo.getUri();
process.env.DB_TEST = 'sbauto_payload_drift';
process.env.DB_PROD = 'sbauto_payload_drift';
process.env.CONTROL_DB_NAME = 'sbauto_payload_drift_control';
process.env.PROJECT_NAME = 'Projet Dérive';
process.env.PANEL_SCHEDULER_ENABLED = 'false';
process.env.PANEL_URL = '';
process.env.PANEL_PAIRING_CODE = '';

const { connectDatabase, disconnectDatabase } = await import(SB('src/config/db.js'));
await connectDatabase();

const { getSingleton } = await import(SB('src/utils/singleton.js'));
const { Company } = await import(SB('src/models/Company.model.js'));
const SystemConfiguration = (await import(SB('src/models/SystemConfiguration.model.js'))).default;
const projectSync = await import(SB('src/services/projectBridge/projectSync.service.js'));

// Le VRAI schéma du destinataire — celui qui accepte ou refuse en production.
const { projectPresentationPayloadSchema } = await import(
  pathToFileURL(path.join(panelRoot, 'backend/src/bridge/bridgeContract.js')).href
);

/**
 * LES CONFIGURATIONS QUI CHANGENT LA FORME DU PAYLOAD.
 * Chacune correspond à un parc réel : une instance neuve, une instance
 * déployée avec son logo, une instance dont les adresses publiques sont
 * connues.
 */
const CONFIGURATIONS = [
  {
    titre: 'entreprise nue (instance de recette)',
    company: { name: 'Garage', tagline: '', logos: {} },
    network: {},
  },
  {
    titre: 'entreprise AVEC LOGO (toute instance déployée)',
    company: { name: 'Garage', logos: { header: 'https://cdn.exemple.fr/logo.png' } },
    network: {},
  },
  {
    titre: 'logo + favicon',
    company: {
      name: 'Garage',
      logos: {
        header: 'https://cdn.exemple.fr/logo.png',
        favicon: 'https://cdn.exemple.fr/favicon.png',
      },
    },
    network: {},
  },
  {
    titre: 'identité complète + réseau + contacts',
    company: {
      name: 'Garage du Nord',
      tagline: 'Votre auto, notre métier',
      logos: { header: 'https://cdn.exemple.fr/logo.png' },
    },
    /**
     * Les contacts s'ACTIVENT dans le catalogue existant — on n'en fabrique
     * pas un de toutes pièces. Le catalogue porte le libellé, l'icône et le
     * genre de chaque entrée : les recopier ici en inventerait une seconde
     * définition, et le contrôle éprouverait sa propre fixture au lieu du
     * produit.
     */
    contacts: { email: 'contact@garage.fr', phone: '0102030405' },
    network: {
      websiteUrl: 'https://garage.fr',
      managerUrl: 'https://manager.garage.fr',
      backendUrl: 'https://api.garage.fr',
    },
  },
];

let echecs = 0;

for (const cas of CONFIGURATIONS) {
  const company = await getSingleton(Company);
  company.set({ tagline: '', ...cas.company });
  // Activation des contacts DANS le catalogue livré, jamais à côté.
  for (const entree of company.media ?? []) {
    const valeur = cas.contacts?.[entree.key];
    entree.value = valeur ?? '';
    entree.enabled = Boolean(valeur);
  }
  await company.save();

  const cfg = await getSingleton(SystemConfiguration);
  cfg.set({ network: cas.network });
  await cfg.save();

  const projection = await projectSync.buildPresentationProjection();
  const parsed = projectPresentationPayloadSchema.safeParse(projection.payload);

  if (parsed.success) {
    console.log(`[payload-drift] ✓ ${cas.titre} — ${Object.keys(projection.payload).join(', ')}`);
    continue;
  }

  echecs += 1;
  console.error(`[payload-drift] ✗ ${cas.titre}`);
  console.error(`               clés émises : ${Object.keys(projection.payload).join(', ')}`);
  for (const issue of parsed.error.errors) {
    console.error(`               · ${issue.path.join('.') || '(racine)'} : ${issue.message}`);
  }
  console.error('               → l\'émetteur publie ce que le destinataire refuse.');
  console.error('               → corriger le SCHÉMA et la SPEC, jamais l\'émetteur seul.');
}

await disconnectDatabase();
await mongo.stop();

if (echecs > 0) {
  console.error(`\n[payload-drift] ${echecs} configuration(s) produisent un payload REFUSÉ.`);
  console.error('[payload-drift] C\'est exactement le défaut qui a figé le nom des fiches :');
  console.error('[payload-drift] une écriture refusée sort de la file et rien ne la rejoue.');
  process.exit(1);
}
console.log('\n[payload-drift] ✓ toutes les configurations produisent un payload conforme.');
