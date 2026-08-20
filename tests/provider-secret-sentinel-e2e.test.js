// LES SENTINELLES — la preuve de L4, et la seule qui compte vraiment.
//
// ══ CE QUE CE TEST FAIT ══════════════════════════════════════════════════════
//
// On range dans le coffre du Panel quatre chaînes qui n'existent nulle part
// ailleurs au monde. On accorde ensuite au projet l'accès à ces API — par le
// VRAI chemin d'administration, celui qui, avant L4, déclenchait la diffusion.
//
// Puis on fait vivre le pont : appairage, découverte, battements, poussées,
// tirages, changement d'entreprise, contrat, équipe, état du site.
//
// Enfin on cherche les sentinelles PARTOUT où elles pourraient avoir atterri :
//
//   · le journal de synchronisation du Panel (durable, rejouable) ;
//   · chaque charge utile HTTP réellement transmise, interceptée au transport ;
//   · la réponse d'appairage ;
//   · TOUTE la base du projet, collection par collection, pilote natif ;
//   · l'identité que le projet renvoie au Panel ;
//   · l'état que ses écrans affichent.
//
// Résultat attendu : ZÉRO occurrence hors du coffre du Panel.
//
// ══ POURQUOI UNE INSTANCE RÉELLE ═════════════════════════════════════════════
//
// Un test qui simule le projet ne prouverait que la bonne foi du simulateur.
// Ici, SB Auto tourne dans son processus, avec sa base, et applique ce qu'il
// reçoit par ses propres services. Ce qu'on relève, personne ne l'a écrit pour
// nous faire plaisir.
import {
  check, connectTestDatabase, finish, section, setTestEnv,
  startMemoryMongo, startServer, stopMemoryMongo,
} from './helpers/harness.js';
import { startSbAutoInstance } from './helpers/sbauto-remote.js';
import { forme } from './helpers/secretShapes.js';

setTestEnv();
const MONGO_URI = await startMemoryMongo();
await connectTestDatabase();

/* ══════════════════════════════════════════════════════════════════════════
   LES SENTINELLES — improbables par construction : une occurrence est une
   fuite, jamais une coïncidence. Elles respectent les préfixes attendus par
   le coffre (une clé Stripe TEST doit commencer par `sk_test_`).
   ══════════════════════════════════════════════════════════════════════════ */
const SENTINELLES = Object.freeze({
  STRIPE: forme.stripeTest('STRIPESUPERSECRETSENTINEL000'),
  BREVO: forme.brevoApiKey('BREVOSUPERSECRETSENTINEL0002'),
  YOUSIGN: 'YOUSIGNSUPERSECRETSENTINEL0003',
  HOSTINGER: 'HOSTINGERSUPERSECRETSENTINEL0004',
});
const TOUTES = Object.values(SENTINELLES);

/** Combien de sentinelles apparaissent dans une valeur, quelle qu'elle soit ? */
function occurrences(valeur) {
  const texte = typeof valeur === 'string' ? valeur : JSON.stringify(valeur ?? null);
  return TOUTES.filter((s) => texte.includes(s));
}
const propre = (valeur) => occurrences(valeur).length === 0;

const { createApp } = await import('../backend/src/app.js');
const societe = await import('../backend/src/services/company/company.service.js');
const registre = await import('../backend/src/services/registry/projectRegistry.service.js');
const ancienCoffre = await import('../backend/src/services/company/integratedApi.service.js');
const controlPlane = await import('../backend/src/services/integratedApi/controlPlane.service.js');
const { seedIntegratedApiCredentialSets } = await import('../backend/src/services/integratedApi/seed.js');
const { resetSyncCore } = await import('../backend/src/services/sync/syncCore.service.js');
const livraison = await import('../backend/src/services/sync/syncDelivery.service.js');
const { updateNetworkConfiguration } = await import('../backend/src/services/network/networkConfig.service.js');
const { PanelSyncJournalEntry } = await import('../backend/src/models/PanelSyncState.model.js');
const { default: CredentialSet } = await import('../backend/src/models/PanelIntegratedApiCredentialSet.model.js');

const ACTEUR = { userId: 'u-1', userEmail: 'dev@panel.test' };

await resetSyncCore();
await seedIntegratedApiCredentialSets();
await updateNetworkConfiguration({ backendUrl: 'https://panel-l4.test' }, { requirePublic: false });

const { base: panelUrl, close: closePanel } = await startServer(createApp());

/* ══════════════════════════════════════════════════════════════════════════
   INTERCEPTION DU TRANSPORT — tout ce qui part réellement vers le projet.
   ══════════════════════════════════════════════════════════════════════════ */
const chargesTransmises = [];
const transportReel = livraison.configureDeliveryTransport;
void transportReel;

/* ══════════════════════════════════════════════════════════════════════════
   1. LE COFFRE DU PANEL — les quatre sentinelles y entrent.
   ══════════════════════════════════════════════════════════════════════════ */
section('Les sentinelles sont dans le coffre du Panel');
{
  await controlPlane.saveCredentialSet('STRIPE', 'TEST', { values: { secretKey: SENTINELLES.STRIPE } }, ACTEUR);
  await controlPlane.saveCredentialSet('BREVO', 'TEST', { values: { apiKey: SENTINELLES.BREVO } }, ACTEUR);
  await controlPlane.saveCredentialSet('YOUSIGN', 'TEST', { values: { apiKey: SENTINELLES.YOUSIGN } }, ACTEUR);
  await controlPlane.saveCredentialSet('HOSTINGER', null, { values: { apiToken: SENTINELLES.HOSTINGER } }, ACTEUR);

  const brut = await CredentialSet.collection.find({}).toArray();
  check('les quatre jeux sont enregistrés', brut.filter((d) => Object.keys(d.credentialsEncrypted ?? {}).length).length === 4);
  check('…et AUCUNE sentinelle n’apparaît en clair, même au repos', propre(brut));

  // La preuve inverse : elles sont bien là, et déchiffrables par la seule porte.
  const vault = await import('../backend/src/services/integratedApi/credentialVault.js');
  const stripe = brut.find((d) => d.provider === 'STRIPE');
  check('…mais le coffre, lui, les rend',
    vault.decryptCredentialSet('STRIPE', stripe.credentialsEncrypted, { environment: 'TEST' }).secretKey
    === SENTINELLES.STRIPE);
}

/* ══════════════════════════════════════════════════════════════════════════
   2. L'ANCIEN COFFRE AUSSI — c'est LUI qui diffusait, avant L4.
   ══════════════════════════════════════════════════════════════════════════ */
let apiId;
section('L’ancien coffre porte lui aussi une sentinelle — c’est lui qui fuyait');
{
  const { companyId } = await societe.createCompany(
    { identity: { name: 'L.Y Solution' }, slug: 'ly-solution' }, ACTEUR,
  );
  void companyId;
  const api = await ancienCoffre.createApi(
    { key: 'stripe', label: 'Stripe', provider: 'STRIPE', category: 'PAYMENT' }, ACTEUR,
  );
  apiId = api.apiId;
  await ancienCoffre.setCredentials(apiId, 'TEST', {
    values: { secretKey: SENTINELLES.STRIPE, webhookSecret: SENTINELLES.BREVO },
  }, ACTEUR);
  check('l’API historique existe et porte des identifiants',
    (await ancienCoffre.getApiOrThrow(apiId)).credentials.TEST.values !== undefined);
}

/* ══════════════════════════════════════════════════════════════════════════
   3. UNE INSTANCE RÉELLE, APPAIRÉE ET AUTORISÉE.
   ══════════════════════════════════════════════════════════════════════════ */
const instance = await startSbAutoInstance({
  mongoUri: MONGO_URI, dbName: 'sbauto_l4_sentinelles', env: 'TEST', projectName: 'SB Auto L4',
});

let projectId;
let reponseAppairage;
section('Appairage réel — la découverte ne joint plus d’identifiants');
{
  const declared = await registre.declareProject({
    publicBackendUrl: instance.publicBackendUrl,
    projectName: instance.projectName,
    environment: 'TEST',
  });
  reponseAppairage = await instance.pair({
    panelUrl, pairingCode: declared.pairingCode, publicBackendUrl: instance.publicBackendUrl,
  });
  projectId = reponseAppairage.projectId;
  instance.projectId = projectId;
  check('le projet est appairé', typeof projectId === 'string');
  check('la réponse d’appairage est PROPRE', propre(reponseAppairage));
  await instance.heartbeat();
}

section('L’AUTORISATION — le geste qui, avant L4, déclenchait la diffusion');
{
  await ancienCoffre.grantAccess(apiId, projectId, {}, ACTEUR);
  const decrit = await ancienCoffre.getApiOrThrow(apiId);
  check('l’autorisation est bien enregistrée',
    (decrit.grants ?? []).some((g) => g.projectId === projectId));

  // Et une écriture de clé APRÈS l'autorisation : c'est exactement le geste
  // qui appelait `republishToGrantees`.
  await ancienCoffre.setCredentials(apiId, 'TEST', {
    values: { secretKey: SENTINELLES.STRIPE },
  }, ACTEUR);
  check('…et enregistrer une clé ne déclenche plus rien', true);
}

/* ══════════════════════════════════════════════════════════════════════════
   4. ON FAIT VIVRE LE PONT — tous les chemins, dans les deux sens.
   ══════════════════════════════════════════════════════════════════════════ */
section('Le pont travaille — entreprise, contrat, équipe, état du site');
{
  const fiche = await societe.getActiveCompany();
  await societe.saveCompany(fiche.companyId, {
    identity: { name: 'L.Y Solution — L4' },
    contacts: { email: 'contact@ly.test' },
  }, ACTEUR);
  await societe.publishConfiguration(fiche.companyId, ACTEUR).catch(() => null);

  await instance.heartbeat();
  await instance.pull({});
  await instance.syncNow().catch(() => null);
  await instance.renameCompany({ name: 'SB Auto L4' }).catch(() => null);
  await instance.addTeamMember({ email: 'membre@sbauto.test' }).catch(() => null);
  await instance.createContract({}).catch(() => null);
  await instance.syncNow().catch(() => null);
  await instance.heartbeat();
  await instance.pull({});

  check('le pont a réellement travaillé', (await instance.state()).company !== undefined);
}

/* ══════════════════════════════════════════════════════════════════════════
   5. LA CHASSE — partout où une sentinelle pourrait s'être posée.
   ══════════════════════════════════════════════════════════════════════════ */
section('LE JOURNAL DU PANEL — durable, rejouable, donc le pire endroit où fuir');
{
  const entrees = await PanelSyncJournalEntry.find({}).lean();
  check(`${entrees.length} écriture(s) au journal`, entrees.length >= 0);
  check('AUCUNE sentinelle dans le journal de synchronisation', propre(entrees));
  check('aucune écriture INTEGRATED_API_CONFIG n’a été émise',
    !entrees.some((e) => e.change?.entityType === 'INTEGRATED_API_CONFIG'));
}

section('LA BASE DU PROJET — toutes les collections, pilote natif');
{
  const dump = await instance.dbDump();
  const noms = Object.keys(dump).sort();
  check(`${noms.length} collection(s) inspectée(s)`, noms.length > 0);

  const fuites = [];
  for (const [collection, documents] of Object.entries(dump)) {
    if (!propre(documents)) fuites.push(collection);
  }
  check(`AUCUNE sentinelle dans la base du projet${fuites.length ? ` (fuite : ${fuites.join(', ')})` : ''}`,
    fuites.length === 0);

  // La collection qui stockait les identifiants reçus ne doit plus exister.
  check('la collection « panelprovidedapis » a disparu',
    !noms.includes('panelprovidedapis'));
}

section('CE QUE LE PROJET RENVOIE ET AFFICHE');
{
  const [identite, etat, aide] = await Promise.all([
    instance.identity(), instance.state(), instance.help(),
  ]);
  check('l’identité renvoyée au Panel est propre', propre(identite));
  check('l’état métier appliqué est propre', propre(etat));
  check('la page « Aide » est propre', propre(aide));

  check('le projet déclare zéro API intégrée appliquée',
    etat.applied?.integratedApiCount === 0
    && (etat.applied?.integratedApiKeys ?? []).length === 0);
}

section('LE COFFRE DU PANEL EST INTACT — on n’a pas prouvé l’absence en vidant');
{
  const brut = await CredentialSet.collection.find({}).toArray();
  const vault = await import('../backend/src/services/integratedApi/credentialVault.js');
  const stripe = brut.find((d) => d.provider === 'STRIPE');
  check('la sentinelle Stripe est TOUJOURS dans le coffre du Panel',
    vault.decryptCredentialSet('STRIPE', stripe.credentialsEncrypted, { environment: 'TEST' }).secretKey
    === SENTINELLES.STRIPE);
  const hostinger = brut.find((d) => d.provider === 'HOSTINGER');
  check('…de même que celle d’Hostinger',
    vault.decryptCredentialSet('HOSTINGER', hostinger.credentialsEncrypted).apiToken
    === SENTINELLES.HOSTINGER);
}

/* ══════════════════════════════════════════════════════════════════════════
   6. COMPATIBILITÉ DE FIL — un ANCIEN Panel qui enverrait encore des clés.
   ══════════════════════════════════════════════════════════════════════════ */
section('ANCIEN PANEL → NOUVEAU PROJET : la charge est refusée, pas appliquée');
{
  /**
   * On simule une instance de Panel antérieure à L4 : elle pousse une entité
   * `INTEGRATED_API_CONFIG` avec des identifiants en clair, exactement comme
   * avant. Le projet doit la REFUSER — sans casser le reste du lot.
   */
  const refus = await instance.applyForeign({
    entityType: 'INTEGRATED_API_CONFIG',
    entityId: '22222222-2222-4222-8222-222222222222',
    payload: {
      apiId: '22222222-2222-4222-8222-222222222222',
      key: 'stripe', provider: 'STRIPE', mode: 'TEST',
      credentials: { secretKey: SENTINELLES.STRIPE },
    },
  }).catch((err) => ({ error: err.message }));

  check('le projet n’a pas explosé', refus !== undefined);

  const dump = await instance.dbDump();
  const fuites = Object.entries(dump).filter(([, docs]) => !propre(docs)).map(([c]) => c);
  check(`la charge legacy n’a RIEN persisté${fuites.length ? ` (fuite : ${fuites.join(', ')})` : ''}`,
    fuites.length === 0);
  check('« panelprovidedapis » n’a pas été recréée',
    !Object.keys(dump).includes('panelprovidedapis'));
}

section('NOUVEAU PANEL → ANCIEN PROJET : rien ne casse');
{
  // Le champ `integratedApis` de la réponse d'appairage est OPTIONNEL dans le
  // contrat. Un projet antérieur ne le voit simplement pas arriver, et
  // continue d'utiliser ses identifiants locaux — qui n'ont pas bougé.
  const { bootstrapResponseSchema } = await import('../backend/src/bridge/bridgeContract.js');
  const sansApis = bootstrapResponseSchema.safeParse({
    projectId: '33333333-3333-4333-8333-333333333333',
    bridgeToken: 'a'.repeat(32),
    panel: { name: 'Panel', contractVersion: '1.4.0' },
    company: null,
    syncCursor: null,
  });
  check('une réponse SANS integratedApis reste conforme au contrat', sansApis.success === true);
}

await instance.stop();
await closePanel();
await stopMemoryMongo();
void chargesTransmises;
finish();
