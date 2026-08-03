// ÉCOSYSTÈME DE BOUT EN BOUT — Phase 4, LOT 9.
//
// ── CE QUI REND CE TEST DIFFÉRENT DE TOUS LES AUTRES ────────────────────────
// Tous les tests précédents éprouvaient UN côté à la fois, l'autre étant
// simulé. Ici, les DEUX backends réels tournent simultanément, sur deux
// ports, avec deux bases MongoDB distinctes, et ne se parlent que par HTTP.
//
//   · aucun client simulé — le vrai ProjectBridgeClient, le vrai PanelClient ;
//   · aucun store en mémoire — deux bases séparées, comme en production ;
//   · aucune fonction interne appelée d'un côté à l'autre ;
//   · le SEUL point de contact est le réseau.
//
// Si le contrat diverge entre les deux dépôts, ce test échoue. C'est
// précisément ce qu'aucun test unilatéral ne peut détecter.
//
// ── CE QUE CE TEST NE PROUVE PAS ────────────────────────────────────────────
// Il tourne sur 127.0.0.1. Il ne prouve donc RIEN sur le DNS, les
// certificats, nginx, PM2 ou un pare-feu. C'est l'objet de la recette VPS
// (33_VPS_ACCEPTANCE.md), qui exige une cible réelle.
// Ce qu'il prouve est le protocole, et il le prouve entièrement.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

import { check, finish, section } from './helpers/harness.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const panelRoot = path.resolve(here, '..');
const projectRoot = path.resolve(panelRoot, '..', 'SB Auto 06');

/* ══════════════════════════════════════════════════════════════════════════ */
section('Préparation — les deux projets doivent être présents');

const projectPresent = fs.existsSync(path.join(projectRoot, 'backend', 'src', 'app.js'));
if (!projectPresent) {
  // OUTIL D'ATELIER : les deux dépôts sont indépendants et peuvent être
  // clonés séparément. On SAUTE proprement plutôt que d'échouer — un dépôt
  // seul reste parfaitement valide.
  console.log(`  ~ SB Auto 06 introuvable en ${projectRoot} — test d'écosystème SAUTÉ.`);
  console.log('    (les deux dépôts sont indépendants ; ce test n’a de sens que côte à côte)');
  process.exit(0);
}
check('les deux dépôts sont côte à côte', true);

/* ── Bases MongoDB : deux serveurs distincts ─────────────────────────────── */
const requirePanel = createRequire(path.join(panelRoot, 'backend', 'package.json'));
const { MongoMemoryServer } = await import(
  pathToFileURL(requirePanel.resolve('mongodb-memory-server')).href
);

const panelMongo = await MongoMemoryServer.create();
const projectMongo = await MongoMemoryServer.create();
check('deux bases MongoDB distinctes démarrées',
  panelMongo.getUri() !== projectMongo.getUri());

/* ══════════════════════════════════════════════════════════════════════════ */
section('Démarrage du PANEL (backend réel, port réel)');

// L'environnement du Panel est posé AVANT tout import : config/env.js est
// fail-closed et lit process.env à l'évaluation du module.
process.env.PANEL_SKIP_DOTENV = '1';
process.env.ENV = 'TEST';
process.env.MONGODB_URI = panelMongo.getUri();
process.env.DB_TEST = 'panel_e2e';
process.env.DB_PROD = 'panel_e2e_prod';
process.env.JWT_SECRET = 'panel-e2e-jwt-secret-0123456789abcdef0123456789abcdef';
process.env.JWT_EXPIRES_IN = '12h';
process.env.BRIDGE_ENCRYPTION_KEY = 'a'.repeat(64);
process.env.SEED_DEV_EMAIL = 'dev@panel.test';
process.env.SEED_DEV_PASSWORD = 'motdepasse-e2e';
process.env.PANEL_NAME = 'Panel L.Y Solution';
process.env.HEARTBEAT_INTERVAL_S = '60';

const { connectDatabase } = await import('../backend/src/config/db.js');
await connectDatabase();
const { createApp } = await import('../backend/src/app.js');
const { seedFromEnv } = await import('../backend/src/services/auth/panelUsers.service.js');
await seedFromEnv();

let panelServer = await listen(createApp());
const PANEL_URL = `http://127.0.0.1:${panelServer.port}`;
check(`Panel démarré sur ${PANEL_URL}`, panelServer.port > 0);

const panelHealth = await http('GET', `${PANEL_URL}/health`);
check('le Panel répond sur /health', panelHealth.status === 200);

const login = await http('POST', `${PANEL_URL}/api/auth/login`, {
  body: { email: 'dev@panel.test', password: 'motdepasse-e2e' },
});
check('connexion DEV au Panel', login.status === 200 && Boolean(login.json?.data?.token));
const AUTH = { authorization: `Bearer ${login.json.data.token}` };

/* ══════════════════════════════════════════════════════════════════════════ */
section('LOT 2 — Création de l’entreprise');

const companyPayload = {
  slug: 'ly-solution',
  environment: 'TEST',
  identity: {
    name: 'L.Y Solution',
    legalName: 'L.Y Solution SAS',
    tagline: 'Sites vitrines et outils de gestion',
    description: 'Conception de sites vitrines et de leurs outils d’administration.',
  },
  branding: {
    logoUrl: 'https://cdn.exemple.test/logo.svg',
    primaryColor: '#1b4dff',
    secondaryColor: '#0f1420',
    fontFamily: 'Inter',
  },
  domains: { primaryDomain: 'ly-solution.test', websiteUrl: 'https://ly-solution.test' },
  contacts: { email: 'contact@ly-solution.test', phone: '+33 1 23 45 67 89' },
  legal: { legalForm: 'SAS', siret: '12345678901234', vatNumber: 'FR12345678901' },
};

const created = await http('POST', `${PANEL_URL}/api/company`, { headers: AUTH, body: companyPayload });
check('POST /api/company → 201', created.status === 201);
check('…l’entreprise n’est PAS encore publiée', created.json?.data?.publishedVersion === null);
check('…les paramètres reçoivent leurs défauts',
  created.json?.data?.settings?.locale === 'fr-FR' && created.json.data.settings.currency === 'EUR');

const refused = await http('POST', `${PANEL_URL}/api/company`, {
  headers: AUTH,
  body: { ...companyPayload, slug: 'AUTRE MAJUSCULE' },
});
check('une entreprise invalide est refusée en nommant le champ',
  refused.status === 400 && /slug/.test(refused.json?.message ?? ''));

/* ══════════════════════════════════════════════════════════════════════════ */
section('LOT 3 — Publication versionnée');

const publishNothing = await http('POST', `${PANEL_URL}/api/company/publish`, {
  headers: AUTH, body: {},
});
check('publier sans raison est refusé en l’expliquant',
  publishNothing.status === 400 && /raison/.test(publishNothing.json?.message ?? ''));

const published = await http('POST', `${PANEL_URL}/api/company/publish`, {
  headers: AUTH, body: { reason: 'Première publication de l’identité de l’entreprise.' },
});
check('POST /publish → 201', published.status === 201);
check('…version 1', published.json?.data?.version === 1);

const again = await http('POST', `${PANEL_URL}/api/company/publish`, {
  headers: AUTH, body: { reason: 'Rien changé.' },
});
check('republier sans changement est refusé', again.status === 409);

/* ══════════════════════════════════════════════════════════════════════════ */
section('LOT 4 — API intégrée et autorisation nominative');

const apiCreated = await http('POST', `${PANEL_URL}/api/company/integrated-apis`, {
  headers: AUTH,
  body: { key: 'stripe', label: 'Stripe', provider: 'STRIPE', category: 'PAYMENT' },
});
check('POST /integrated-apis → 201', apiCreated.status === 201);
const apiId = apiCreated.json?.data?.apiId;

const creds = await http('PUT', `${PANEL_URL}/api/company/integrated-apis/${apiId}/credentials/TEST`, {
  headers: AUTH,
  body: { values: { publishableKey: 'pk_test_e2e_public', secretKey: 'sk_test_e2e_secret' } },
});
check('PUT credentials → 200', creds.status === 200);
check('…les VALEURS ne ressortent jamais de /api',
  !JSON.stringify(creds.json).includes('sk_test_e2e_secret')
  && !JSON.stringify(creds.json).includes('pk_test_e2e_public'));
check('…seuls les noms de clés et leurs empreintes sont rendus',
  creds.json?.data?.credentials?.TEST?.keys?.join() === 'publishableKey,secretKey'
  && Object.keys(creds.json.data.credentials.TEST.fingerprints).length === 2);

/* ══════════════════════════════════════════════════════════════════════════ */
section('LOT 5 — Déclaration du projet et sonde AVANT appairage');

// La déclaration part désormais de l'ADRESSE : elle a donc lieu APRÈS le
// démarrage du projet, plus avant. C'est aussi l'ordre réel d'un opérateur —
// on ne déclare pas une adresse dont on ignore ce qu'elle répond.
const probeDead = await http('POST', `${PANEL_URL}/api/projects/probe`, {
  headers: AUTH, body: { url: 'http://127.0.0.1:1' },
});
check('sonder une adresse morte donne un constat, pas une erreur',
  probeDead.status === 200 && probeDead.json?.data?.reachable === false);
check('…en disant quoi vérifier', /DNS|démarré|adresse/.test(probeDead.json.data.reason));

/* ══════════════════════════════════════════════════════════════════════════ */
section('Démarrage du PROJET (backend réel, base distincte, autre port)');

// Le projet tourne dans un processus séparé : ses variables d'environnement
// et ses singletons Mongoose ne doivent PAS entrer en collision avec ceux du
// Panel, qui vivent déjà dans ce processus.
let projectProc = await startProject({
  projectRoot,
  mongoUri: projectMongo.getUri(),
  panelUrl: PANEL_URL,
});
check(`projet démarré sur ${projectProc.baseUrl}`, projectProc.port > 0);

const projectPing = await http('GET', `${projectProc.baseUrl}/api/project-bridge/v1/ping`, {
  headers: { 'x-bridge-contract-version': '1.3.0' },
});
check('le ProjectBridge du projet répond', projectPing.status === 200);
check('…et se déclare NON appairé', projectPing.json?.data?.paired === false);

const probeAlive = await http('POST', `${PANEL_URL}/api/projects/probe`, {
  headers: AUTH, body: { url: projectProc.baseUrl },
});
check('la sonde reconnaît un ProjectBridge vivant',
  probeAlive.status === 200 && probeAlive.json?.data?.isProjectBridge === true);
check('…lit sa version de contrat dans l’en-tête',
  probeAlive.json.data.contractVersion === '1.4.0');
check('…et la juge compatible', probeAlive.json.data.compatible === true);
check('…en concluant qu’il est prêt pour l’appairage',
  /prêt pour l’appairage/.test(probeAlive.json.data.reason));
// Contrat >= 1.4.0 : le projet se NOMME sur son ping public. C'est ce qui
// permet de ne plus faire saisir sa clé.
check('…et le projet annonce son identité sans être appairé',
  probeAlive.json.data.bridgeIdentity?.projectKey === 'sb-auto-06'
  && typeof probeAlive.json.data.bridgeIdentity?.projectName === 'string');

// DÉCLARATION — aucune clé transmise. Le corps contient volontairement un
// `projectKey` fantaisiste : le backend doit l'IGNORER et dériver la clé de
// l'identité annoncée par le projet.
const declared = await http('POST', `${PANEL_URL}/api/projects`, {
  headers: AUTH,
  body: { url: projectProc.baseUrl, projectKey: 'cle-imposee-par-le-client' },
});
check('POST /api/projects → 201', declared.status === 201);
const projectId = declared.json?.data?.project?.projectId;
const pairingCode = declared.json?.data?.pairingCode;
check('…un code d’appairage à usage unique est délivré', typeof pairingCode === 'string' && pairingCode.length > 0);
check('…la clé vient du PROJET, pas du client',
  declared.json?.data?.project?.projectKey === 'sb-auto-06');
check('…et le nom aussi, sans avoir été saisi',
  declared.json?.data?.project?.projectName === 'SB Auto 06');

// Deux clics = un seul projet : la seconde déclaration est refusée.
const twice = await http('POST', `${PANEL_URL}/api/projects`, {
  headers: AUTH, body: { url: projectProc.baseUrl },
});
check('déclarer deux fois la même adresse → refus',
  twice.status === 409 && twice.json?.code === 'PANEL_PROJECT_ALREADY_DECLARED');

/* ══════════════════════════════════════════════════════════════════════════ */
section('LOT 5 — APPAIRAGE RÉEL (le projet appelle le Panel)');

const paired = await http('POST', `${projectProc.baseUrl}/api/panel-connection/pair`, {
  headers: projectProc.auth,
  body: { panelUrl: PANEL_URL, pairingCode, publicBackendUrl: projectProc.baseUrl },
});
check('POST /panel-connection/pair → 201', paired.status === 201);
check('…le projet connaît désormais le nom du Panel',
  paired.json?.data?.panelName === 'Panel L.Y Solution');

// ── DÉCOUVERTE DESCENDANTE (contrat 1.3.0) ──────────────────────────────
check('le projet a reçu l’ENTREPRISE dès l’appairage',
  paired.json?.data?.discovered?.company === 'L.Y Solution');
check('…dans sa version publiée', paired.json.data.discovered.companyVersion === 1);
check('…mais AUCUNE API : elle ne lui est pas encore accordée',
  paired.json.data.discovered.integratedApis.length === 0);

const afterPairing = await http('GET', `${PANEL_URL}/api/projects/${projectId}`, { headers: AUTH });
check('le Panel voit le projet APPAIRÉ',
  afterPairing.json?.data?.project?.pairing?.status === 'PAIRED');
check('…avec l’URL publique du projet, qui lui permettra de le rappeler',
  afterPairing.json.data.project.runtime.publicBackendUrl === projectProc.baseUrl);
check('…et son Manifest transmis par le pont',
  afterPairing.json.data.project.manifestSource === 'BRIDGE');

/* ══════════════════════════════════════════════════════════════════════════ */
section('LOT 6 — Heartbeat réel et supervision vivante');

const beat = await http('POST', `${projectProc.baseUrl}/api/panel-connection/sync-now`, {
  headers: projectProc.auth, body: {},
});
check('le projet envoie un heartbeat à la demande',
  beat.status === 200 && beat.json?.data?.heartbeat?.delivered === true);

const fleet = await http('GET', `${PANEL_URL}/api/supervision/fleet`, { headers: AUTH });
const row = fleet.json?.data?.items?.find((p) => p.projectId === projectId);
check('le projet apparaît au parc', Boolean(row));
check('…EN LIGNE, sur la foi d’un heartbeat réel', row?.liveness === 'ONLINE');
check('…avec ses versions de moteurs publiées',
  afterPairing.json.data.project.manifest?.engines?.deployment === '1.1.0');

const dashboard = await http('GET', `${PANEL_URL}/api/supervision/dashboard`, { headers: AUTH });
check('le tableau de bord compte 1 projet en ligne',
  dashboard.json?.data?.totals?.online === 1 && dashboard.json.data.totals.paired === 1);

/* ══════════════════════════════════════════════════════════════════════════ */
section('LOT 5 — DÉCOUVERTE COMPLÈTE par le moteur d’exécution');

const discovery = await http('POST', `${PANEL_URL}/api/executions`, {
  headers: AUTH,
  body: { type: 'DISCOVER_PROJECT', projectId, mode: 'EXECUTION' },
});
check('l’action DISCOVER_PROJECT s’exécute réellement',
  discovery.status === 201 && discovery.json?.data?.state === 'SUCCEEDED');
check('…elle a lu l’identité du projet',
  discovery.json.data.result.result?.identity?.projectKey === 'sb-auto-06');
check('…et enregistré son Manifest', discovery.json.data.result.result.manifestStored === true);
check('…et relevé la CONVERGENCE : version d’entreprise appliquée',
  discovery.json.data.result.result.appliedConfiguration?.companyVersion === 1);
check('…sans erreur de lecture', discovery.json.data.result.result.failures.length === 0);

/* ══════════════════════════════════════════════════════════════════════════ */
section('LOT 4 — Autorisation d’une API et livraison NOMINATIVE');

const granted = await http('POST', `${PANEL_URL}/api/company/integrated-apis/${apiId}/grants`, {
  headers: AUTH,
  body: { projectId, keys: ['publishableKey'] },
});
check('l’accès est accordé au projet, restreint à UNE clé', granted.status === 201);

await http('POST', `${projectProc.baseUrl}/api/panel-connection/sync-now`, {
  headers: projectProc.auth, body: {},
});

const projectStatus = await http('GET', `${projectProc.baseUrl}/api/panel-connection/status`, {
  headers: projectProc.auth,
});
const receivedApi = projectStatus.json?.data?.integratedApis?.find((a) => a.key === 'stripe');
check('le projet a REÇU l’API par synchronisation', Boolean(receivedApi));
check('…en mode TEST, celui de SON environnement', receivedApi?.mode === 'TEST');
check('…restreinte à la seule clé accordée',
  receivedApi?.credentialKeys?.join() === 'publishableKey');
check('…et la clé SECRÈTE, non accordée, n’a jamais été livrée',
  !receivedApi?.credentialKeys?.includes('secretKey'));
check('l’état du projet n’expose aucune valeur de secret',
  !JSON.stringify(projectStatus.json).includes('pk_test_e2e_public')
  && !JSON.stringify(projectStatus.json).includes('sk_test_e2e_secret'));

check('le projet a bien appliqué l’entreprise reçue',
  projectStatus.json?.data?.company?.identity?.name === 'L.Y Solution');
check('…avec sa marque', projectStatus.json.data.company.branding.primaryColor === '#1b4dff');

/* ══════════════════════════════════════════════════════════════════════════ */
section('LOT 6 — Changement de configuration, propagation, convergence');

const updated = await http('PATCH', `${PANEL_URL}/api/company`, {
  headers: AUTH,
  body: { branding: { primaryColor: '#c0392b' }, identity: { tagline: 'Nouvelle signature' } },
});
check('modification du brouillon acceptée', updated.status === 200);
check('…et signalée comme NON publiée', updated.json?.data?.hasUnpublishedChanges === true);

const statusBefore = await http('GET', `${projectProc.baseUrl}/api/panel-connection/status`, {
  headers: projectProc.auth,
});
check('le projet n’a PAS bougé : saisir n’est pas publier',
  statusBefore.json.data.company.branding.primaryColor === '#1b4dff');

const v2 = await http('POST', `${PANEL_URL}/api/company/publish`, {
  headers: AUTH, body: { reason: 'Changement de couleur primaire et de signature.' },
});
check('publication de la version 2', v2.status === 201 && v2.json.data.version === 2);
check('…avec le différentiel calculé', v2.json.data.changes.length === 2);
check('…qui nomme les chemins modifiés',
  v2.json.data.changes.some((c) => c.path === 'branding.primaryColor' && c.to === '#c0392b'));

await http('POST', `${projectProc.baseUrl}/api/panel-connection/sync-now`, {
  headers: projectProc.auth, body: {},
});
const statusAfter = await http('GET', `${projectProc.baseUrl}/api/panel-connection/status`, {
  headers: projectProc.auth,
});
check('le projet a reçu la version 2', statusAfter.json.data.company.version === 2);
check('…et appliqué la nouvelle couleur',
  statusAfter.json.data.company.branding.primaryColor === '#c0392b');

const reDiscovery = await http('POST', `${PANEL_URL}/api/executions`, {
  headers: AUTH,
  body: { type: 'DISCOVER_PROJECT', projectId, mode: 'EXECUTION' },
});
check('le Panel CONSTATE la convergence en version 2',
  reDiscovery.json?.data?.result?.result?.appliedConfiguration?.companyVersion === 2);
check('…et voit l’API intégrée reçue',
  reDiscovery.json.data.result.result.appliedConfiguration.integratedApiKeys.join() === 'stripe');

/* ══════════════════════════════════════════════════════════════════════════ */
section('LOT 6 — Idempotence : resynchroniser ne réapplique rien');

const before = statusAfter.json.data.company.appliedAt;
await http('POST', `${projectProc.baseUrl}/api/panel-connection/sync-now`, {
  headers: projectProc.auth, body: {},
});
const idem = await http('GET', `${projectProc.baseUrl}/api/panel-connection/status`, {
  headers: projectProc.auth,
});
check('une seconde synchronisation ne réapplique pas la même version',
  idem.json.data.company.appliedAt === before && idem.json.data.company.version === 2);

/* ══════════════════════════════════════════════════════════════════════════ */
section('LOT 4 — Révocation : l’accès disparaît réellement');

const revoked = await http(
  'DELETE',
  `${PANEL_URL}/api/company/integrated-apis/${apiId}/grants/${projectId}`,
  { headers: AUTH },
);
check('révocation acceptée', revoked.status === 200);

await http('POST', `${projectProc.baseUrl}/api/panel-connection/sync-now`, {
  headers: projectProc.auth, body: {},
});
const afterRevoke = await http('GET', `${projectProc.baseUrl}/api/panel-connection/status`, {
  headers: projectProc.auth,
});
check('le projet a OUBLIÉ l’API révoquée',
  (afterRevoke.json.data.integratedApis ?? []).length === 0);

/* ══════════════════════════════════════════════════════════════════════════ */
section('LOT 1B — Synchronisation AUTOMATIQUE de l’identité et du contrat');

// Le Panel ne doit plus dépendre d'un « Rafraîchir le Manifest » : une
// modification faite dans le Manager doit remonter d'elle-même.
const PanelPresentation = (await import('../backend/src/models/PanelProjectProjection.model.js'))
  .PanelProjectPresentation;
const PanelContract = (await import('../backend/src/models/PanelProjectProjection.model.js'))
  .PanelProjectContract;

/** Attend qu'une condition devienne vraie — la synchronisation est asynchrone. */
async function eventually(label, predicate, { timeoutMs = 15_000, stepMs = 400 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    // eslint-disable-next-line no-await-in-loop
    if (await predicate()) return true;
    if (Date.now() > deadline) {
      console.error(`    (délai dépassé : ${label})`);
      return false;
    }
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setTimeout(r, stepMs));
  }
}

// L'amorçage post-appairage a déjà dû livrer identité et contrat.
check('après appairage, l’identité est arrivée SANS action manuelle',
  await eventually('présentation initiale', async () =>
    (await PanelPresentation.countDocuments({ projectId })) === 1));

// ── Modification RÉELLE via la route du Manager ──────────────────────────
const NOUVEAU_NOM = 'Garage du Nord — Synchro Auto';
const majCompany = await http('PUT', `${projectProc.baseUrl}/api/company`, {
  headers: projectProc.auth,
  body: { name: NOUVEAU_NOM, tagline: 'Entretien et réparation depuis 1998' },
});
check('la sauvegarde du Manager réussit immédiatement', majCompany.status === 200);

const t0 = Date.now();
const nomArrive = await eventually('nom commercial', async () => {
  const p = await PanelPresentation.findOne({ projectId }).lean();
  return p?.companyName === NOUVEAU_NOM;
});
check('le nom commercial remonte AUTOMATIQUEMENT au Panel', nomArrive);
if (nomArrive) console.log(`    (propagation observée en ~${Date.now() - t0} ms)`);

const projete = await PanelPresentation.findOne({ projectId }).lean();
check('…avec le slogan', projete?.tagline === 'Entretien et réparation depuis 1998');
check('…et aucun clic « Rafraîchir le Manifest » n’a été nécessaire', true);

// ── LE CHEMIN DE LECTURE : ce que l'écran reçoit RÉELLEMENT ──────────────
// Projeter en base ne suffit pas. Tant que GET /api/projects ne rend pas la
// valeur, l'utilisateur ne voit rien — et c'est indiscernable d'une
// synchronisation en panne.
const liste = await http('GET', `${PANEL_URL}/api/projects`, { headers: AUTH });
const fiche = liste.json?.data?.projects?.find((p) => p.projectId === projectId);
check('GET /api/projects expose le nouveau nom commercial',
  fiche?.business?.presentation?.companyName === NOUVEAU_NOM);
check('…et le slogan', fiche?.business?.presentation?.tagline === 'Entretien et réparation depuis 1998');

// La PREUVE que la projection prime : le manifeste, lui, n'a pas bougé.
check('le manifeste porte encore l’ANCIENNE identité',
  fiche?.manifest?.presentation?.companyName !== NOUVEAU_NOM);
check('…donc la valeur affichée vient bien de la projection, pas du manifeste',
  fiche?.business?.presentation?.companyName !== fiche?.manifest?.presentation?.companyName);

const detail = await http('GET', `${PANEL_URL}/api/projects/${projectId}`, { headers: AUTH });
check('GET /api/projects/:id expose la même valeur',
  detail.json?.data?.project?.business?.presentation?.companyName === NOUVEAU_NOM);

// ── Coupure du Panel, modification, redémarrage du projet ────────────────
await panelServer.close();

const horsLigne = await http('PUT', `${projectProc.baseUrl}/api/company`, {
  headers: projectProc.auth,
  body: { name: 'Garage du Nord — Hors ligne', tagline: 'Modifié Panel éteint' },
});
check('Panel ÉTEINT : la sauvegarde métier réussit quand même', horsLigne.status === 200);

// On laisse la mise en file se faire, puis on redémarre le projet : l'outbox
// est durable, elle doit survivre.
await new Promise((r) => setTimeout(r, 1500));
await projectProc.stop();
// Le projet redémarre AVEC son ordonnanceur — c'est la configuration réelle,
// et c'est lui qui doit rattraper tout seul. Cadence courte pour ne pas faire
// durer la recette ; en production elle se compte en dizaines de secondes.
const projectAgain = await startProject({
  projectRoot,
  mongoUri: projectMongo.getUri(),
  panelUrl: PANEL_URL,
  env: { PANEL_SCHEDULER_ENABLED: 'true', PANEL_SYNC_INTERVAL_S: '2', PANEL_HEARTBEAT_INTERVAL_S: '5' },
});
check('le projet redémarre', projectAgain.port > 0);

// Le Panel revient. Aucune action humaine : le rattrapage doit se faire seul.
const panelBack = await listen(createApp(), panelServer.port);
check('le Panel redémarre sur le même port', panelBack.port === panelServer.port);

const rattrape = await eventually('rattrapage après reconnexion', async () => {
  const p = await PanelPresentation.findOne({ projectId }).lean();
  return p?.companyName === 'Garage du Nord — Hors ligne';
}, { timeoutMs: 40_000, stepMs: 1000 });
check('RATTRAPAGE : la modification faite Panel éteint finit par arriver', rattrape);

await panelBack.close();
await projectAgain.stop();
// On rend la main au scénario suivant avec un Panel vivant et le projet initial.
const panelResumed = await listen(createApp(), panelServer.port);
projectProc = await startProject({
  projectRoot, mongoUri: projectMongo.getUri(), panelUrl: PANEL_URL,
});
panelServer = panelResumed;

/* ══════════════════════════════════════════════════════════════════════════ */
section('LOT 6 — Récupération après interruption du Panel');

await panelServer.close();
const beatWhileDown = await http('POST', `${projectProc.baseUrl}/api/panel-connection/sync-now`, {
  headers: projectProc.auth, body: {},
});
check('Panel éteint : le projet ne tombe pas',
  beatWhileDown.status === 200 && beatWhileDown.json.data.heartbeat.delivered === false);
check('…et le dit sans inventer', typeof beatWhileDown.json.data.heartbeat.reason === 'string');

const siteUp = await http('GET', `${projectProc.baseUrl}/api/project-bridge/v1/ping`, {
  headers: { 'x-bridge-contract-version': '1.3.0' },
});
check('AUTONOMIE : le projet continue de servir sans Panel', siteUp.status === 200);

const stillConfigured = await http('GET', `${projectProc.baseUrl}/api/panel-connection/status`, {
  headers: projectProc.auth,
});
check('…en gardant l’identité de l’entreprise, Panel éteint',
  stillConfigured.json.data.company?.identity?.name === 'L.Y Solution');

// Le Panel revient sur le MÊME port : c'est ce que verrait un redémarrage.
const panelAgain = await listen(createApp(), panelServer.port);
check('le Panel redémarre sur le même port', panelAgain.port === panelServer.port);

const reconnected = await http('POST', `${projectProc.baseUrl}/api/panel-connection/sync-now`, {
  headers: projectProc.auth, body: {},
});
check('RECONNEXION automatique : le heartbeat repasse',
  reconnected.json?.data?.heartbeat?.delivered === true);
check('…sans réappairage : le bridgeToken a survécu des deux côtés',
  reconnected.json.data.sync?.pulled?.reason !== 'BRIDGE_NOT_PAIRED');

/* ══════════════════════════════════════════════════════════════════════════ */
section('Nettoyage');

await panelAgain.close();
await projectProc.stop();
const { disconnectDatabase } = await import('../backend/src/config/db.js');
await disconnectDatabase();
await panelMongo.stop();
await projectMongo.stop();
check('les deux backends et les deux bases sont arrêtés', true);

finish();

/* ══════════════════════════════════════════════════════════════════════════ */
/*  OUTILLAGE                                                                */
/* ══════════════════════════════════════════════════════════════════════════ */

/** Écoute sur un port libre (ou imposé) et rend de quoi le fermer. */
async function listen(app, port = 0) {
  const server = await new Promise((resolve) => {
    const s = app.listen(port, '127.0.0.1', () => resolve(s));
  });
  return {
    port: server.address().port,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

/** Requête HTTP réelle — aucune fonction interne n'est appelée. */
async function http(method, url, { headers = {}, body } = {}) {
  const res = await fetch(url, {
    method,
    headers: body !== undefined ? { 'content-type': 'application/json', ...headers } : headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  return { status: res.status, json };
}

/**
 * Démarre le backend du PROJET dans un PROCESSUS SÉPARÉ.
 *
 * Indispensable : les deux backends déclarent des modèles Mongoose sur le
 * même registre global et lisent process.env à l'import. Les charger dans le
 * même processus les ferait se marcher dessus — et le test ne prouverait plus
 * que deux applications distinctes savent se parler.
 */
async function startProject({ projectRoot: root, mongoUri, panelUrl, env: envOverrides = {} }) {
  const { spawn } = await import('node:child_process');
  const bootPath = path.join(here, 'helpers', 'project-e2e-boot.mjs');

  const child = spawn(process.execPath, [bootPath], {
    cwd: path.join(root, 'backend'),
    env: {
      ...process.env,
      ENV: 'TEST',
      MONGODB_URI: mongoUri,
      DB_TEST: 'sbauto_e2e',
      DB_PROD: 'sbauto_e2e_prod',
      CONTROL_DB_NAME: 'sbauto_e2e_control',
      JWT_SECRET: 'projet-e2e-jwt-secret-0123456789abcdef0123456789',
      INTEGRATED_API_ENCRYPTION_KEY: 'b'.repeat(64),
      PROJECT_NAME: 'SB Auto 06',
      SEED_DEV_EMAIL: 'dev@projet.test',
      SEED_DEV_PASSWORD: 'motdepasse-e2e',
      PANEL_URL: panelUrl,
      // Pas de code : l'appairage est déclenché explicitement par le test,
      // pour qu'on voie l'appel HTTP réel se produire.
      PANEL_PAIRING_CODE: '',
      // Ordonnanceur coupé : le test déclenche les cycles lui-même, sinon
      // des minuteurs de fond rendraient les assertions non déterministes.
      PANEL_SCHEDULER_ENABLED: 'false',
      PORT: '0',
      ...envOverrides,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const port = await new Promise((resolve, reject) => {
    let buffer = '';
    const timer = setTimeout(
      () => reject(new Error(`le projet n'a pas démarré à temps :\n${buffer}`)),
      90_000,
    );
    child.stdout.on('data', (chunk) => {
      buffer += chunk.toString();
      const match = buffer.match(/E2E_PROJECT_PORT=(\d+)/);
      if (match) {
        clearTimeout(timer);
        resolve(Number(match[1]));
      }
    });
    child.stderr.on('data', (chunk) => { buffer += chunk.toString(); });
    child.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`le projet s'est arrêté (code ${code}) :\n${buffer}`));
    });
  });

  const baseUrl = `http://127.0.0.1:${port}`;
  const projectLogin = await http('POST', `${baseUrl}/api/auth/login`, {
    body: { email: 'dev@projet.test', password: 'motdepasse-e2e' },
  });
  const token = projectLogin.json?.data?.token ?? projectLogin.json?.token;

  return {
    port,
    baseUrl,
    auth: { authorization: `Bearer ${token}` },
    stop: () => new Promise((resolve) => {
      child.once('exit', resolve);
      child.kill();
    }),
  };
}
