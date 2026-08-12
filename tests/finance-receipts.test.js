/**
 * L10.2 — JUSTIFICATIFS PRIVÉS : le protocole Media, étendu et verrouillé.
 *
 * Ce que ces contrôles verrouillent :
 *
 *   · qu'un justificatif ne soit JAMAIS joignable sans authentification —
 *     ni par `/uploads/…`, ni par une adresse dérivée, ni par le protocole
 *     Media lui-même, qui refuse d'en produire une ;
 *   · qu'il ne parte JAMAIS vers le `shared/uploads` d'une destination au
 *     moment d'un déploiement, ce qui le rendrait public par la bande ;
 *   · que le type soit mesuré sur les OCTETS, jamais cru sur l'extension ;
 *   · que le nom déposé par l'utilisateur ne serve JAMAIS de chemin ;
 *   · qu'un `mediaId` d'une autre transaction ne mène nulle part ;
 *   · que la pièce SURVIVE à une révision rétroactive et à l'annulation du
 *     cycle courant — les deux cas où un « supprimer/recréer » l'aurait perdue ;
 *   · que le fichier vive dans le stockage PERSISTANT, en local comme après
 *     déploiement, par le même chemin de code.
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  check,
  connectTestDatabase,
  finish,
  section,
  setTestEnv,
  startMemoryMongo,
  startServer,
  stopMemoryMongo,
} from './helpers/harness.js';

setTestEnv();
await startMemoryMongo();
await connectTestDatabase();

const { config } = await import('../backend/src/config/env.js');

/**
 * LE STOCKAGE PRIVÉ EST DÉTOURNÉ VERS UN DOSSIER JETABLE.
 *
 * On n'écrit pas dans le `storage/` du dépôt : une recette qui laisse des
 * fichiers derrière elle finit par ressembler à des données réelles. Le
 * détournement passe par `config.paths`, c'est-à-dire par la MÊME porte que le
 * runtime — la recette n'emprunte donc pas un chemin de code différent.
 */
const DOSSIER_PRIVE = await fsp.mkdtemp(path.join(os.tmpdir(), 'panel-recu-'));
config.paths = { ...(config.paths ?? {}), privateMedia: DOSSIER_PRIVE };

const { createApp } = await import('../backend/src/app.js');
const { seedFromEnv, createUser } = await import('../backend/src/services/auth/panelUsers.service.js');
const PanelProject = (await import('../backend/src/models/PanelProject.model.js')).default;
const PanelMedia = (await import('../backend/src/models/PanelMedia.model.js')).default;
const { PanelFinancialTransaction } = await import('../backend/src/models/PanelFinancialTransaction.model.js');
const recurring = await import('../backend/src/services/finance/recurringCosts.service.js');
const privateMedia = await import('../backend/src/services/upload/privateMedia.service.js');
const documentValidation = await import('../backend/src/services/upload/documentValidation.js');
const mediaDescriptor = await import('../backend/src/services/upload/mediaDescriptor.service.js');

await seedFromEnv();
await createUser({ email: 'admin@panel.test', password: 'motdepasse-admin', displayName: 'Gestion', role: 'ADMIN' });
await PanelFinancialTransaction.init();

const { base, call, close } = await startServer(createApp());
const connexion = async (email, password) => {
  const res = await call('POST', '/api/auth/login', { body: { email, password } });
  return `Bearer ${res.json.data.token}`;
};
const DEV = await connexion('dev@panel.test', 'motdepasse-test');
const ADMIN = await connexion('admin@panel.test', 'motdepasse-admin');

const declarer = async (projectId, projectName) => {
  const now = new Date().toISOString();
  await PanelProject.create({
    projectId, projectKey: projectId, projectName,
    createdAt: now, updatedAt: now, pairing: { status: 'DECLARED' }, runtime: {},
  });
};
const PROJET_A = 'atelier-nord';
const PROJET_B = 'atelier-sud';
await declarer(PROJET_A, 'Atelier du Nord');
await declarer(PROJET_B, 'Atelier du Sud');

/* ── Fabriques d'octets — de VRAIS en-têtes, pas des chaînes quelconques ──── */
const PDF = (corps = 'facture') => Buffer.concat([
  Buffer.from('%PDF-1.7\n'), Buffer.from(corps), Buffer.from('\n%%EOF\n'),
]);
const PNG = () => Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 7),
]);
const EXECUTABLE = () => Buffer.concat([Buffer.from('MZ'), Buffer.alloc(64, 0)]);
const HTML = () => Buffer.from('<html><script>alert(1)</script></html>');

/** Envoi multipart — le vrai chemin du navigateur, pas un raccourci JSON. */
async function televerser(transactionId, buffer, filename, auth = DEV) {
  const form = new FormData();
  form.append('file', new Blob([buffer]), filename);
  const res = await fetch(`${base}/api/finances/transactions/${transactionId}/receipt`, {
    method: 'POST',
    headers: auth ? { authorization: auth } : {},
    body: form,
  });
  let json = null;
  try { json = await res.json(); } catch { json = null; }
  return { status: res.status, json };
}

async function telecharger(transactionId, auth = DEV) {
  const res = await fetch(`${base}/api/finances/transactions/${transactionId}/receipt`, {
    headers: auth ? { authorization: auth } : {},
  });
  const octets = res.ok ? Buffer.from(await res.arrayBuffer()) : null;
  let json = null;
  if (!res.ok) { try { json = await res.json(); } catch { json = null; } }
  return { status: res.status, headers: res.headers, buffer: octets, json };
}

/** Un mouvement manuel de coût, prêt à recevoir sa pièce. */
async function coutManuel(projectId, label = 'Facture fournisseur') {
  const res = await call('POST', '/api/finances/transactions', {
    headers: { authorization: DEV },
    body: {
      projectId, category: 'COST', label, amount: '49',
      effectiveDate: new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Paris' }).format(new Date()),
    },
  });
  return res.json.data.transaction;
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('1. Le type est MESURÉ sur les octets, jamais cru sur l’extension');
{
  const { sniffDocumentMime, validateDocument, safeOriginalFilename } = documentValidation;

  check('un PDF est reconnu', sniffDocumentMime(PDF()) === 'application/pdf');
  check('un PNG est reconnu', sniffDocumentMime(PNG()) === 'image/png');
  check('un exécutable n’est reconnu comme rien', sniffDocumentMime(EXECUTABLE()) === null);
  check('du HTML non plus', sniffDocumentMime(HTML()) === null);

  const refuse = (buffer) => {
    try { validateDocument(buffer, { role: 'receipt' }); return false; } catch { return true; }
  };
  check('un exécutable RENOMMÉ .pdf est refusé', refuse(EXECUTABLE()));
  check('du HTML renommé .pdf est refusé', refuse(HTML()));
  check('un fichier vide est refusé', refuse(Buffer.alloc(0)));
  check('un fichier trop volumineux est refusé', refuse(Buffer.concat([PDF(), Buffer.alloc(11 * 1024 * 1024)])));

  const mesure = validateDocument(PDF(), { role: 'receipt' });
  check('l’extension de STOCKAGE vient du type mesuré', mesure.extension === 'pdf');

  check('un nom avec traversée est neutralisé',
    !safeOriginalFilename('../../etc/passwd').includes('/')
    && !safeOriginalFilename('..\\..\\windows\\system32').includes('\\'));
  check('…et ne commence jamais par un point', !safeOriginalFilename('...cache').startsWith('.'));
  check('un nom vide retombe sur un défaut', safeOriginalFilename('') === 'document');
}

section('2. Téléverser un justificatif sur une occurrence');
{
  const def = await recurring.createRecurringCost({
    scope: 'PROJECT', projectId: PROJET_A, label: 'Brevo', amount: '49',
    recurrence: { unit: 'MONTH', interval: 1 },
    startAt: new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Paris' }).format(new Date()),
  }, { email: 'dev@panel.test' });

  const occurrence = await PanelFinancialTransaction.findOne({ sourceId: def.recurringCostId }).lean();
  check('une occurrence existe', Boolean(occurrence));
  check('…sans justificatif au départ', !occurrence.receipt?.mediaId);

  const envoi = await televerser(occurrence.transactionId, PDF('facture-aout'), 'Facture Août 2026.pdf');
  check('le téléversement aboutit', envoi.status === 201);

  const transaction = envoi.json.data.transaction;
  check('la transaction porte désormais une référence de média',
    Boolean(transaction.receipt?.mediaId));
  check('…et le NOM déposé, pour le rendre plus tard',
    transaction.receipt.filename === 'Facture Août 2026.pdf');
  check('…avec son type et son poids mesurés',
    transaction.receipt.mime === 'application/pdf' && transaction.receipt.size > 0);
  check('…et l’acte de rattachement daté et imputé',
    transaction.receipt.attachedAt && transaction.receipt.attachedBy === 'dev@panel.test');

  check('AUCUNE URL n’est publiée dans la réponse',
    !JSON.stringify(transaction.receipt).toLowerCase().includes('http')
    && !JSON.stringify(transaction.receipt).includes('/uploads'));
  check('…ni aucun chemin disque',
    !JSON.stringify(transaction.receipt).includes('storage/')
    && !JSON.stringify(transaction.receipt).includes(DOSSIER_PRIVE));

  const media = await PanelMedia.findOne({ mediaId: transaction.receipt.mediaId }).lean();
  check('le descripteur suit le protocole Media', Boolean(media));
  check('…marqué PRIVATE', media.visibility === 'PRIVATE');
  check('…avec son empreinte du contenu', /^[0-9a-f]{64}$/.test(media.sha256));
  check('…son environnement', media.environment === 'TEST');
  check('…sa portée métier', media.scope === 'FINANCIAL_RECEIPT');
  check('…une clé d’objet CALCULÉE, sans rapport avec le nom déposé',
    media.objectKey.endsWith('.pdf')
    && !media.objectKey.toLowerCase().includes('facture')
    && !media.objectKey.includes(' '));
  check('…et un chemin qui ne passe PAS par /uploads',
    !media.path.startsWith('/uploads') && media.path.startsWith('storage/media/'));

  const surDisque = path.join(DOSSIER_PRIVE, media.objectKey);
  check('le fichier est écrit dans le stockage privé', fs.existsSync(surDisque));
  check('…octet pour octet, sans réencodage',
    Buffer.compare(fs.readFileSync(surDisque), PDF('facture-aout')) === 0);
}

section('3. Télécharger — authentifié, en pièce jointe, jamais en ligne');
{
  const t = await coutManuel(PROJET_A, 'Hébergement');
  await televerser(t.transactionId, PDF('recu'), 'reçu.pdf');

  const anonyme = await telecharger(t.transactionId, null);
  check('SANS JETON : refusé', anonyme.status === 401);

  const admin = await telecharger(t.transactionId, ADMIN);
  check('un compte ADMIN télécharge', admin.status === 200);

  const dev = await telecharger(t.transactionId, DEV);
  check('un compte DEV aussi', dev.status === 200);
  check('…et reçoit les octets exacts', Buffer.compare(dev.buffer, PDF('recu')) === 0);
  check('…avec le bon type', dev.headers.get('content-type') === 'application/pdf');
  check('…en PIÈCE JOINTE, jamais affiché dans l’origine du Panel',
    /^attachment;/.test(dev.headers.get('content-disposition') ?? ''));
  /**
   * LE NOM ACCENTUÉ VOYAGE ENCODÉ (RFC 5987), avec un repli ASCII.
   * Sans cela, le navigateur enregistrerait « reÃ§u.pdf ».
   */
  const disposition = dev.headers.get('content-disposition') ?? '';
  check('…sous le nom déposé, encodé pour l’en-tête',
    disposition.includes(`filename*=UTF-8''${encodeURIComponent('reçu.pdf')}`));
  check('…avec un repli ASCII lisible pour les clients anciens',
    /filename="re_u\.pdf"/.test(disposition));
  check('…sans reniflage de type', dev.headers.get('x-content-type-options') === 'nosniff');
  check('…et sans mise en cache', /no-store/.test(dev.headers.get('cache-control') ?? ''));

  const sansPiece = await coutManuel(PROJET_A, 'Sans pièce');
  const vide = await telecharger(sansPiece.transactionId);
  check('un mouvement sans justificatif rend 404', vide.status === 404);

  const inconnu = await telecharger('mouvement-inexistant');
  check('un mouvement inconnu rend 404', inconnu.status === 404);
}

section('4. Cross-project : un mediaId d’ailleurs ne mène nulle part');
{
  const a = await coutManuel(PROJET_A, 'Pièce de A');
  const b = await coutManuel(PROJET_B, 'Sans pièce chez B');
  const envoi = await televerser(a.transactionId, PDF('secret-de-A'), 'a.pdf');
  const mediaDeA = envoi.json.data.transaction.receipt.mediaId;

  const parB = await telecharger(b.transactionId);
  check('la transaction de B n’a pas de pièce : 404', parB.status === 404);

  // On tente d'obtenir la pièce de A EN PASSANT par la transaction de B.
  const res = await fetch(
    `${base}/api/finances/transactions/${b.transactionId}/receipt?mediaId=${mediaDeA}`,
    { headers: { authorization: DEV } },
  );
  check('…et fournir le mediaId de A ne l’ouvre pas davantage', res.status === 404);

  const { readReceipt } = await import('../backend/src/services/finance/receipts.service.js');
  const refuse = await readReceipt(b.transactionId, { mediaId: mediaDeA })
    .then(() => false).catch((err) => err.code === 'PANEL_FINANCE_RECEIPT_ABSENT'
      || err.code === 'PANEL_FINANCE_RECEIPT_MISMATCH');
  check('le service refuse explicitement l’appariement croisé', refuse === true);

  const parA = await telecharger(a.transactionId);
  check('…tandis que par SA transaction, la pièce de A s’ouvre', parA.status === 200);
}

section('5. AUCUNE route publique ne sert un justificatif');
{
  const t = await coutManuel(PROJET_A, 'Publique ?');
  const envoi = await televerser(t.transactionId, PDF('confidentiel'), 'confidentiel.pdf');
  const media = await PanelMedia.findOne({ mediaId: envoi.json.data.transaction.receipt.mediaId }).lean();

  const parUploads = await fetch(`${base}/uploads/${media.objectKey}`);
  check('`/uploads/<clé>` ne sert PAS ce document',
    parUploads.status === 404 || parUploads.status === 410);

  const parStorage = await fetch(`${base}/storage/media/${media.objectKey}`);
  check('`/storage/…` n’est monté nulle part', parStorage.status === 404);

  const parChemin = await fetch(`${base}/${media.path}`);
  check('le chemin du descripteur n’est pas une adresse servie', parChemin.status === 404);

  const traversee = await fetch(`${base}/uploads/..%2fstorage%2fmedia%2f${media.objectKey}`);
  check('aucune traversée depuis /uploads', traversee.status >= 400);

  /**
   * LE PROTOCOLE MEDIA LUI-MÊME REFUSE DE PRODUIRE UNE ADRESSE.
   * C'est le point unique : aucun écran, aucune projection ne peut en obtenir
   * une, même en la demandant.
   */
  const resolue = await mediaDescriptor.resolvePanelMediaUrl(media, 'TEST');
  check('`resolvePanelMediaUrl` rend null pour un média privé', resolue.url === null);
  check('…et le DIT', resolue.reason === 'MEDIA_PRIVE');

  const publiable = await mediaDescriptor.publishableDescriptor(media.objectKey);
  check('aucun descripteur publiable n’en est dérivé', publiable === null);
}

section('6. Un justificatif ne part JAMAIS vers une destination au déploiement');
{
  const t = await coutManuel(PROJET_A, 'Au déploiement');
  const envoi = await televerser(t.transactionId, PDF('ne-doit-pas-partir'), 'x.pdf');
  const mediaId = envoi.json.data.transaction.receipt.mediaId;
  const media = await PanelMedia.findOne({ mediaId }).lean();

  // Un transport factice : il enregistre tout ce qu'on lui demande d'envoyer.
  const envois = [];
  const transport = {
    exec: async () => ({ stdout: 'ABSENT' }),
    uploadFile: async (local, distant) => { envois.push({ local, distant }); },
  };

  const rapport = await mediaDescriptor.publishPanelMediaOnDestination({
    transport,
    sharedUploads: '/var/www/panel/shared/uploads',
    host: 'exemple.test',
    environment: 'TEST',
  });

  check('le média privé n’est même pas INSPECTÉ',
    !rapport.missing.includes(media.objectKey));
  check('…il n’est pas transféré vers shared/uploads',
    !envois.some((e) => e.distant.includes(media.objectKey)));
  check('…et il n’est jamais marqué publié',
    (await PanelMedia.findOne({ mediaId }).lean()).publicationState === 'LOCAL_ONLY');
}

section('7. La pièce SURVIT à une révision rétroactive');
{
  const def = await recurring.createRecurringCost({
    scope: 'COMPANY', label: 'Avec pièces', amount: '49',
    recurrence: { unit: 'MONTH', interval: 1 }, startAt: '2026-06-01',
  }, { email: 'dev@panel.test' }, { now: new Date('2026-08-05T10:00:00Z') });

  const occurrences = await PanelFinancialTransaction.find({ sourceId: def.recurringCostId }).sort({ cycleKey: 1 }).lean();
  check('trois occurrences existent', occurrences.length === 3);

  const juin = occurrences[0];
  const envoi = await televerser(juin.transactionId, PDF('facture-juin'), 'juin.pdf');
  const mediaJuin = envoi.json.data.transaction.receipt.mediaId;
  check('juin reçoit sa facture', Boolean(mediaJuin));

  await recurring.reviseRecurringCost(def.recurringCostId, {
    mode: 'FROM_START', amount: '59',
  }, { email: 'dev@panel.test' }, { now: new Date('2026-08-05T10:00:00Z') });

  const juinApres = await PanelFinancialTransaction.findOne({ transactionId: juin.transactionId }).lean();
  check('le montant de juin est bien révisé', juinApres.amountCents === 5900);
  check('LA FACTURE DE JUIN EST TOUJOURS ATTACHÉE À JUIN',
    juinApres.receipt.mediaId === mediaJuin);
  check('…l’identifiant de la ligne n’a pas changé', juinApres.transactionId === juin.transactionId);

  const relu = await telecharger(juin.transactionId);
  check('…et elle se télécharge toujours', relu.status === 200);
  check('…avec les mêmes octets', Buffer.compare(relu.buffer, PDF('facture-juin')) === 0);
}

section('8. La pièce SURVIT à l’annulation du cycle courant');
{
  const def = await recurring.createRecurringCost({
    scope: 'COMPANY', label: 'Annulée mais justifiée', amount: '30',
    recurrence: { unit: 'MONTH', interval: 1 }, startAt: '2026-07-01',
  }, { email: 'dev@panel.test' }, { now: new Date('2026-08-20T10:00:00Z') });

  const aout = await PanelFinancialTransaction.findOne({ sourceId: def.recurringCostId, cycleKey: '2026-08-01' }).lean();
  await televerser(aout.transactionId, PDF('facture-aout-annulee'), 'aout.pdf');

  await recurring.stopRecurringCost(def.recurringCostId, { mode: 'CURRENT', reason: 'Résiliation' },
    { email: 'dev@panel.test' }, { now: new Date('2026-08-20T10:00:00Z') });

  const apres = await PanelFinancialTransaction.findOne({ transactionId: aout.transactionId }).lean();
  check('le cycle d’août est bien retiré des totaux', Boolean(apres.deletedAt));
  check('LA FACTURE N’EST PAS PERDUE', Boolean(apres.receipt.mediaId));

  const media = await PanelMedia.findOne({ mediaId: apres.receipt.mediaId }).lean();
  check('…son descripteur est intact', Boolean(media) && !media.deletedAt);

  const telechargement = await telecharger(aout.transactionId);
  check('…et elle reste TÉLÉCHARGEABLE pour l’audit', telechargement.status === 200);
  check('…octets identiques',
    Buffer.compare(telechargement.buffer, PDF('facture-aout-annulee')) === 0);

  const ajout = await televerser(aout.transactionId, PDF('nouvelle'), 'nouvelle.pdf');
  check('en revanche, on n’attache plus de pièce à un mouvement supprimé',
    ajout.status === 409);
}

section('9. Remplacer et retirer une pièce');
{
  const t = await coutManuel(PROJET_A, 'Remplacement');
  const premier = await televerser(t.transactionId, PDF('v1'), 'v1.pdf');
  const media1 = premier.json.data.transaction.receipt.mediaId;

  const second = await televerser(t.transactionId, PDF('v2'), 'v2.pdf');
  const media2 = second.json.data.transaction.receipt.mediaId;
  check('le remplacement change de média', media1 !== media2);
  check('…et la transaction pointe sur le nouveau',
    second.json.data.transaction.receipt.filename === 'v2.pdf');

  const telechargement = await telecharger(t.transactionId);
  check('…c’est bien le nouveau qui se télécharge',
    Buffer.compare(telechargement.buffer, PDF('v2')) === 0);

  const ancien = await PanelMedia.findOne({ mediaId: media1 }).lean();
  check('L’ANCIEN DESCRIPTEUR SURVIT — on saura qu’il y a eu remplacement',
    Boolean(ancien) && Boolean(ancien.deletedAt));
  check('…et son fichier est retiré du disque',
    !fs.existsSync(path.join(DOSSIER_PRIVE, ancien.objectKey)));

  const retrait = await call('DELETE', `/api/finances/transactions/${t.transactionId}/receipt`, {
    headers: { authorization: DEV },
  });
  check('le retrait explicite aboutit', retrait.status === 200);
  check('…et la transaction n’a plus de pièce', retrait.json.data.transaction.receipt === null);
  const apresRetrait = await telecharger(t.transactionId);
  check('…le téléchargement rend 404', apresRetrait.status === 404);
}

section('10. Refus d’envoi : type, taille, mouvement inconnu, sans jeton');
{
  const t = await coutManuel(PROJET_A, 'Refus');

  const executable = await televerser(t.transactionId, EXECUTABLE(), 'facture.pdf');
  check('un exécutable déguisé en PDF est refusé',
    executable.status === 415 && executable.json.code === 'PANEL_DOCUMENT_TYPE_UNSUPPORTED');
  check('…et le message dit que le contrôle porte sur le CONTENU',
    /contenu du fichier/.test(executable.json.message));

  const html = await televerser(t.transactionId, HTML(), 'facture.pdf');
  check('du HTML aussi', html.status === 415);

  const gros = await televerser(t.transactionId, Buffer.concat([PDF(), Buffer.alloc(11 * 1024 * 1024)]), 'gros.pdf');
  check('un document de 11 Mo est refusé', gros.status === 413);

  const inconnu = await televerser('mouvement-inexistant', PDF(), 'x.pdf');
  check('un mouvement inconnu est refusé', inconnu.status === 404);

  const sansJeton = await televerser(t.transactionId, PDF(), 'x.pdf', null);
  check('sans jeton, refusé', sansJeton.status === 401);

  check('aucun fichier n’a été écrit par ces refus',
    fs.readdirSync(DOSSIER_PRIVE).every((f) => !f.includes('facture.pdf') && !f.includes('gros')));

  const image = await televerser(t.transactionId, PNG(), 'photo-recu.png');
  check('une image de reçu est acceptée', image.status === 201);
  check('…avec son type réel', image.json.data.transaction.receipt.mime === 'image/png');
}

section('11. Localhost et déployé : le MÊME chemin de code');
{
  const racine = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const lire = (rel) => fs.readFileSync(path.join(racine, rel), 'utf8');

  const env = lire('backend/src/config/env.js');
  check('le stockage privé est déclaré dans la configuration',
    /privateMedia:\s*path\.resolve\(process\.cwd\(\), 'storage', 'media'\)/.test(env));

  const store = lire('backend/src/services/upload/privateMedia.service.js');
  const codeStore = store.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  check('AUCUNE branche « si localhost » dans la couche Media',
    !/localhost|127\.0\.0\.1|isProd|NODE_ENV/i.test(codeStore));

  const finance = lire('backend/src/services/finance/receipts.service.js')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  check('…ni dans le code financier', !/localhost|isProd|NODE_ENV/i.test(finance));
  check('le code financier n’écrit AUCUN fichier lui-même',
    !/writeFile|createWriteStream|mkdir/.test(finance));
  check('…et ne connaît aucun chemin de disque', !/uploads|storage\//.test(finance));

  /**
   * LA PERSISTANCE APRÈS DÉPLOIEMENT — prouvée sur la configuration réelle,
   * pas sur une intention. Trois faits, et il faut les trois.
   */
  const pipeline = lire('backend/src/deployment-engine/pipeline.js');
  check('1. le déploiement lie `backend/storage` au partagé persistant',
    /ln -sfn \$\{sharedRoot\}\/storage \$\{backendDir\}\/storage/.test(pipeline));
  check('…et crée le dossier partagé', /mkdir -p \$\{sharedRoot\}\/storage/.test(pipeline));

  const build = lire('backend/src/deployment-engine/build.js');
  check('2. `storage` est EXCLU de l’artefact de build — rien ne l’écrase',
    /BACKEND_EXCLUDE_DIRS[\s\S]{0,120}'storage'/.test(build));

  const nginx = lire('backend/src/deployment-engine/nginx.js');
  check('3. AUCUN bloc `location` ne dessert `/storage`',
    !/location\s+\/storage/.test(nginx));
  check('…alors que `/uploads/` en a un, lui — la différence est le point',
    /location \/uploads\//.test(nginx));
}

section('12. Garde structurelle : interdiction de réintroduire un chemin brut');
{
  const racine = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const modele = fs.readFileSync(path.join(racine, 'backend/src/models/PanelFinancialTransaction.model.js'), 'utf8');
  const code = modele.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

  check('la transaction ne porte AUCUN champ d’URL de justificatif',
    !/receiptUrl|receiptPath|fileUrl|filePath|documentUrl/i.test(code));
  check('…elle ne référence que l’abstraction Media',
    /receipt:\s*\{[\s\S]{0,200}mediaId/.test(code));

  const schema = PanelFinancialTransaction.schema.paths;
  const suspects = Object.keys(schema).filter((p) => /url|path|filename/i.test(p));
  check(`aucun chemin ni URL dans le schéma${suspects.length ? ` — ${suspects}` : ''}`,
    suspects.length === 0);

  // La preuve par l'exemple : ce que le protocole rend ne contient jamais
  // d'adresse, quelles que soient les données.
  const media = await PanelMedia.findOne({ visibility: 'PRIVATE', deletedAt: null }).lean();
  const descripteur = privateMedia.privateDescriptorOf(media);
  check('le descripteur privé ne porte ni URL ni clé d’objet',
    !('url' in descripteur) && !('path' in descripteur) && !('objectKey' in descripteur));
  check('…seulement identité, nom, type, poids et empreinte',
    descripteur.mediaId && descripteur.filename && descripteur.mime && descripteur.sha256);
}

section('13. Le descripteur référencé mais absent du disque se DIT');
{
  const t = await coutManuel(PROJET_A, 'Fichier perdu');
  const envoi = await televerser(t.transactionId, PDF('perdu'), 'perdu.pdf');
  const media = await PanelMedia.findOne({ mediaId: envoi.json.data.transaction.receipt.mediaId }).lean();

  // On simule une perte de stockage : le descripteur reste, le fichier part.
  fs.rmSync(path.join(DOSSIER_PRIVE, media.objectKey));

  const res = await telecharger(t.transactionId);
  check('ce n’est PAS un 404 « rien n’a jamais existé »', res.status !== 404);
  check('…c’est un incident de stockage, nommé comme tel', res.status === 503);

  /**
   * LA LISTE, ELLE, NE PEUT PAS LE SAVOIR — et c'est assumé.
   *
   * Vérifier la présence du fichier sur disque pour chaque ligne d'un livret
   * coûterait un accès par ligne, sur l'écran qui en compte le plus. La liste
   * dit donc ce qu'elle SAIT : la pièce est référencée et son descripteur est
   * intact. L'incident de stockage, lui, est nommé au téléchargement — le seul
   * moment où l'on touche réellement le fichier.
   */
  const liste = await call('GET', `/api/finances/transactions?scope=project&projectId=${PROJET_A}&period=ALL`, {
    headers: { authorization: DEV },
  });
  const ligne = liste.json.data.items.find((i) => i.transactionId === t.transactionId);
  check('la liste continue d’annoncer la pièce référencée',
    ligne.receipt?.mediaId === media.mediaId && ligne.receipt.available === true);
  check('…et c’est le TÉLÉCHARGEMENT qui nomme l’incident',
    res.json?.code === 'PANEL_MEDIA_FILE_MISSING');
}

await close();
await stopMemoryMongo();
await fsp.rm(DOSSIER_PRIVE, { recursive: true, force: true });
finish();
