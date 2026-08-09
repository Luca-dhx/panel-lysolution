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

/* ══════════════════════════════════════════════════════════════════════════ */
/*  LES AUTRES FRONTIÈRES — même méthode, mêmes conséquences                   */
/*                                                                            */
/*  Ce fichier n'éprouvait que `PROJECT_PRESENTATION`, parce que c'est là que  */
/*  le défaut avait été trouvé. Or la leçon n'était pas « ce payload-là est    */
/*  fragile » : c'était « personne ne compare l'ÉMETTEUR au SCHÉMA du          */
/*  DESTINATAIRE ». Trois frontières restaient donc dans l'angle mort exact    */
/*  que ce contrôle avait été créé pour fermer.                                */
/*                                                                            */
/*  Un refus y coûterait la même chose : l'entrée sort de la file, plus rien   */
/*  ne la rejoue, et le Panel affiche indéfiniment une valeur périmée sans     */
/*  qu'aucun écran ne le signale.                                             */
/* ══════════════════════════════════════════════════════════════════════════ */

const {
  contractPayloadSchema, siteStatusPayloadSchema, teamMemberPayloadSchema,
} = await import(
  pathToFileURL(path.join(panelRoot, 'backend/src/bridge/bridgeContract.js')).href
);

const Contract = (await import(SB('src/models/Contract.model.js'))).default
  ?? (await import(SB('src/models/Contract.model.js'))).Contract;
const { SiteStatus } = await import(SB('src/models/SiteStatus.model.js'));
const { User } = await import(SB('src/models/User.model.js'));
const teamSync = await import(SB('src/services/projectBridge/teamSync.service.js'));

/**
 * Éprouve UNE projection contre LE schéma qui l'accepte ou la refuse.
 *
 * ── UN TOMBSTONE N'EST PAS UN PAYLOAD VIDE ────────────────────────────────
 *
 * « Aucun contrat » ne se projette pas comme un objet aux champs absents : il
 * se projette comme un EFFACEMENT — `deleted: true`, `payload: null`. Soumettre
 * cette forme au schéma d'objet reviendrait à exiger du produit qu'il publie un
 * contrat inexistant.
 *
 * On vérifie donc l'autre invariant, qui est le vrai : un tombstone est ENTIER.
 * Une moitié — `deleted` sans `payload: null`, ou l'inverse — ferait écrire au
 * Panel un état vide en croyant appliquer une donnée.
 */
function eprouver(titre, projection, schema) {
  if (projection.deleted === true || projection.payload === null) {
    const entier = projection.deleted === true && projection.payload === null;
    if (entier) {
      console.log(`[payload-drift] ✓ ${titre} — EFFACEMENT (tombstone entier)`);
    } else {
      echecs += 1;
      console.error(`[payload-drift] ✗ ${titre} — tombstone À MOITIÉ : `
        + `deleted=${projection.deleted}, payload=${JSON.stringify(projection.payload)}`);
    }
    return;
  }
  const parsed = schema.safeParse(projection.payload);
  if (parsed.success) {
    console.log(`[payload-drift] ✓ ${titre} — ${Object.keys(projection.payload ?? {}).join(', ')}`);
    return;
  }
  echecs += 1;
  console.error(`[payload-drift] ✗ ${titre}`);
  console.error(`               clés émises : ${Object.keys(projection.payload ?? {}).join(', ')}`);
  for (const issue of parsed.error.errors) {
    console.error(`               · ${issue.path.join('.') || '(racine)'} : ${issue.message}`);
  }
  console.error('               → l\'émetteur publie ce que le destinataire refuse.');
}

/* ── CONTRAT ─────────────────────────────────────────────────────────────── */
{
  // Aucun contrat : le Panel doit tout de même recevoir une photographie
  // valide — c'est l'état d'un projet qui vient d'être appairé.
  eprouver('contrat : aucun (projet neuf)',
    await projectSync.buildContractProjection(), contractPayloadSchema);

  /**
   * UN CONTRAT VIVANT, avec sa tarification et son document — les champs qui
   * n'existent QU'EN PRODUCTION. Une fixture nue reproduirait exactement
   * l'angle mort que ce fichier est censé fermer.
   */
  await Contract.create({
    reference: 'CTR-DRIFT-1',
    status: 'ACTIVE',
    environment: 'TEST',
    pricing: {
      launchFee: { enabled: true, amountExcludingTax: 90000, taxRate: 20, taxAmount: 18000, amountIncludingTax: 108000, currency: 'EUR' },
      subscription: { enabled: true, amountExcludingTax: 9900, taxRate: 20, taxAmount: 1980, amountIncludingTax: 11880, currency: 'EUR', interval: 'MONTH' },
    },
    stripe: { subscription: { subscriptionId: 'sub_drift', currentPeriodEnd: new Date(Date.now() + 30 * 864e5) } },
    document: { originalFilename: 'contrat.pdf', originalUploadedAt: new Date() },
  });
  eprouver('contrat : ACTIF, tarifé, avec document',
    await projectSync.buildContractProjection(), contractPayloadSchema);

  // Et un contrat TERMINÉ : la projection publie alors une date de fin, donc
  // une forme différente. Deux états, deux formes, deux contrôles.
  await Contract.updateMany({}, { $set: { status: 'ENDED', 'stripe.subscription.endedAt': new Date() } });
  eprouver('contrat : TERMINÉ (historique publié)',
    await projectSync.buildContractProjection(), contractPayloadSchema);
}

/* ── ÉTAT DU SITE ────────────────────────────────────────────────────────── */
{
  eprouver('état du site : par défaut',
    await projectSync.buildSiteStatusProjection(), siteStatusPayloadSchema);

  const site = await getSingleton(SiteStatus);
  site.set({
    status: 'SUSPENDED',
    suspensionSource: 'TECHNICAL',
    suspensionReason: 'Maintenance planifiée',
    contractProtectionEnabled: true,
  });
  await site.save();
  eprouver('état du site : SUSPENDU pour cause technique, protection active',
    await projectSync.buildSiteStatusProjection(), siteStatusPayloadSchema);
}

/* ── MEMBRE D'ÉQUIPE ─────────────────────────────────────────────────────── */
{
  const membre = await User.create({
    email: 'equipe@garage.fr', name: 'Camille Dupont', role: 'ADMIN', password: 'motdepasse-drift',
  });
  eprouver('membre d’équipe : fiche complète',
    teamSync.buildMemberProjection(membre), teamMemberPayloadSchema);

  /**
   * ET SON TOMBSTONE. Un départ n'est pas une absence de projection : c'est
   * une projection qui dit « cette personne n'est plus là ». Si le schéma la
   * refusait, un membre parti resterait affiché indéfiniment côté Panel.
   */
  const pierre = teamSync.buildMemberTombstone(teamSync.memberEntityId(membre._id));
  const tombstoneAccepte = pierre.payload === null || pierre.deleted === true;
  if (tombstoneAccepte) {
    console.log('[payload-drift] ✓ membre d’équipe : départ (tombstone, payload nul)');
  } else {
    echecs += 1;
    console.error('[payload-drift] ✗ membre d’équipe : le départ ne se présente pas comme un tombstone');
  }
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
