/**
 * L12 — LES DEUX SUITES D'UN ENCAISSEMENT PROUVÉ : la facture, et l'annonce.
 *
 * ══ CE QUE CETTE SUITE VERROUILLE ═══════════════════════════════════════════
 *
 * Deux transactions Stripe réelles ont vécu dans le registre financier avec
 * leur adresse de facture — et sans la facture. `invoiceDocument.pdfUrl` était
 * conservé, `receipt.mediaId` restait vide, et l'écran des finances proposait
 * un encaissement sans pièce. Une adresse signée chez un tiers n'est pas un
 * justificatif : elle expire, et une facture se conserve des années.
 *
 * Personne, par ailleurs, n'apprenait qu'un client du parc avait payé. Le
 * livret le montrait à qui allait le consulter ; rien ne le PORTAIT.
 *
 * Sont donc éprouvés ici :
 *
 *   · l'archivage réel du PDF dans le protocole Media du Panel, au MÊME endroit
 *     que les justificatifs déposés à la main ;
 *   · son IDEMPOTENCE — trois passages, une seule copie, une seule empreinte ;
 *   · le refus d'écraser une pièce déposée par un humain ;
 *   · le rattrapage des encaissements déjà projetés sans pièce ;
 *   · l'absence de facture chez le fournisseur, qui est un ÉTAT et non un échec ;
 *   · les destinataires de l'annonce — TOUS les SUPER_ADMIN, jamais « le
 *     premier trouvé », jamais un ADMIN ni un DEV ;
 *   · l'identité d'acte de l'envoi, qui ne contient aucune horloge.
 *
 * Aucun réseau vers le fournisseur : le téléchargement est doublé. Ce qu'on
 * éprouve est la CHAÎNE — décision, stockage, rattachement, idempotence — pas
 * la capacité de Node à faire un GET.
 */
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  check,
  connectTestDatabase,
  finish,
  section,
  setTestEnv,
  startMemoryMongo,
} from './helpers/harness.js';

setTestEnv();
await startMemoryMongo();
await connectTestDatabase();

const { config } = await import('../backend/src/config/env.js');
const DOSSIER_PRIVE = await fsp.mkdtemp(path.join(os.tmpdir(), 'panel-facture-'));
config.paths = { ...(config.paths ?? {}), privateMedia: DOSSIER_PRIVE };

const PanelProviderRevenueFact = (await import('../backend/src/models/PanelProviderRevenueFact.model.js')).default;
const { PROJECTION_STATUS } = await import('../backend/src/models/PanelProviderRevenueFact.model.js');
const { PanelFinancialTransaction, CATEGORIES, FLOWS, ORIGINS } = await import(
  '../backend/src/models/PanelFinancialTransaction.model.js'
);
const PanelMedia = (await import('../backend/src/models/PanelMedia.model.js')).default;
const PanelUser = (await import('../backend/src/models/PanelUser.model.js')).default;
const { createUser, seedFromEnv } = await import('../backend/src/services/auth/panelUsers.service.js');
const archival = await import('../backend/src/services/finance/providerRevenue/invoiceArchival.service.js');
const annonces = await import(
  '../backend/src/services/finance/providerRevenue/paymentConfirmationAnnouncements.js'
);
const receipts = await import('../backend/src/services/finance/receipts.service.js');

await PanelFinancialTransaction.init();
await PanelProviderRevenueFact.init();

/* ──────────────────────────────────────────────────────────────────────────
   UN VRAI PDF, ET UN FOURNISSEUR DOUBLÉ.

   Le PDF est minimal mais AUTHENTIQUE : il commence par `%PDF-`, ce que la
   validation lit sur les octets. Un buffer arbitraire serait refusé — et c'est
   précisément le contrôle qu'on veut voir s'exercer.
   ────────────────────────────────────────────────────────────────────────── */

const PDF = Buffer.concat([
  Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n', 'latin1'),
]);

/**
 * LE FOURNISSEUR EST INJECTÉ, PAS REMPLACÉ GLOBALEMENT.
 *
 * Écraser `globalThis.fetch` aurait doublé le fournisseur pour TOUT ce qui
 * tourne dans ce processus — le pont, le relais média, l'envoi d'e-mail — et
 * un oubli de restauration aurait contaminé la suite suivante. Le transport
 * accepte un `fetchImpl` précisément pour que la recette n'ait pas à faire ça.
 */
let appelsFournisseur = 0;
const fournisseurDouble = async (url) => {
  appelsFournisseur += 1;
  if (String(url).includes('/introuvable')) {
    return { ok: false, status: 404, headers: new Map(), arrayBuffer: async () => new ArrayBuffer(0) };
  }
  return {
    ok: true,
    status: 200,
    headers: new Map([['content-type', 'application/octet-stream']]),
    arrayBuffer: async () => PDF.buffer.slice(PDF.byteOffset, PDF.byteOffset + PDF.byteLength),
  };
};
const injecte = { fetchImpl: fournisseurDouble };

let n = 0;
async function encaissementProjete({ pdfUrl = 'https://pay.exemple.test/facture/pdf', projectId = 'projet-recette' } = {}) {
  n += 1;
  const transactionId = `tx-recette-${n}`;
  const factId = `fact-recette-${n}`;

  await PanelFinancialTransaction.create({
    transactionId,
    projectId,
    flow: FLOWS.INFLOW,
    category: CATEGORIES.REVENUE,
    origin: ORIGINS.STRIPE,
    label: `Abonnement — recette ${n}`,
    amountCents: 9599,
    currency: 'EUR',
    effectiveDate: new Date(),
    provenance: {
      provider: 'STRIPE', environment: 'TEST', externalId: `in_recette_${n}`, externalKind: 'INVOICE',
    },
    createdBy: 'stripe',
  });

  await PanelProviderRevenueFact.create({
    factId,
    provider: 'STRIPE',
    environment: 'TEST',
    objectType: 'INVOICE',
    objectId: `in_recette_${n}`,
    kind: 'REVENUE',
    amountCents: 9599,
    currency: 'EUR',
    occurredAt: new Date(),
    label: `Abonnement — recette ${n}`,
    projectId,
    ownership: 'OWNED',
    projectionStatus: PROJECTION_STATUS.PROJECTED,
    transactionId,
    invoiceDocument: {
      invoiceId: `in_recette_${n}`, number: `RCT-000${n}`, hostedUrl: 'https://invoice.exemple.test/h', pdfUrl,
    },
    corroboration: { paymentType: 'SUBSCRIPTION' },
    firstSeenAt: new Date().toISOString(),
    lastSeenAt: new Date().toISOString(),
  });

  return { factId, transactionId };
}

// ═══════════════════════════════════════════════════════════════════════════
section('1 · LA FACTURE DEVIENT UNE PIÈCE DÉTENUE, PAS UNE ADRESSE');
{
  const { factId, transactionId } = await encaissementProjete();
  const r = await archival.archiveInvoiceForFact(factId, injecte);

  check('la facture est archivée', r.outcome === archival.ARCHIVE_OUTCOME.ARCHIVED);
  check('…et rattachée au mouvement', r.transactionId === transactionId);

  const media = await PanelMedia.findOne({ mediaId: r.mediaId }).lean();
  check('le média existe', Boolean(media));
  check('son type est MESURÉ sur les octets, pas déclaré', media.mime === 'application/pdf');
  check('il est PRIVÉ', media.visibility === 'PRIVATE');
  check('il ne vit PAS dans l’espace servi publiquement', !String(media.path).startsWith('/uploads'));
  check('il porte la MÊME portée qu’un justificatif déposé à la main',
    media.scope === receipts.RECEIPT_SCOPE && media.role === receipts.RECEIPT_ROLE);
  check('son nom est celui que cherche un comptable — le numéro de facture',
    String(media.originalFilename).includes('RCT-0001'));

  const tx = await PanelFinancialTransaction.findOne({ transactionId }).lean();
  check('le mouvement désigne la pièce', tx.receipt.mediaId === r.mediaId);
  check('l’acte de rattachement est daté', Boolean(tx.receipt.attachedAt));
  check('…et son ORIGINE est nommée, jamais une personne', tx.receipt.attachedBy === 'stripe');

  const fait = await PanelProviderRevenueFact.findOne({ factId }).lean();
  check('l’empreinte est conservée sur le fait', fait.invoiceArchive.sha256 === media.sha256);
  check('l’adresse d’origine est conservée', Boolean(fait.invoiceArchive.sourceUrl));
  check('le moment du téléchargement est conservé', Boolean(fait.invoiceArchive.downloadedAt));
  check('le type et le poids sont conservés',
    fait.invoiceArchive.mime === 'application/pdf' && fait.invoiceArchive.bytes === PDF.length);

  /** La pièce se lit par la route du MOUVEMENT — c'est elle qui autorise. */
  const lu = await receipts.readReceipt(transactionId, {});
  check('la pièce se relit par le chemin des justificatifs', lu.buffer.equals(PDF));
  check('…et un mediaId étranger n’y mène pas',
    await receipts.readReceipt(transactionId, { mediaId: 'un-autre' }).then(() => false, () => true));
}

// ═══════════════════════════════════════════════════════════════════════════
section('2 · TROIS PASSAGES, UNE SEULE COPIE');
{
  /**
   * Le scénario réel : `invoice.paid` rejoué, la réconciliation qui repasse, le
   * Panel redémarré. Trois entrées dans la même fonction, et un seul fichier.
   */
  const { factId, transactionId } = await encaissementProjete();
  appelsFournisseur = 0;

  const un = await archival.archiveInvoiceForFact(factId, injecte);
  const deux = await archival.archiveInvoiceForFact(factId, injecte);
  const trois = await archival.archiveInvoiceForFact(factId, injecte);

  check('le premier passage archive', un.outcome === archival.ARCHIVE_OUTCOME.ARCHIVED);
  check('les suivants CONSTATENT, ils ne réécrivent pas',
    deux.outcome === archival.ARCHIVE_OUTCOME.ALREADY_ARCHIVED
    && trois.outcome === archival.ARCHIVE_OUTCOME.ALREADY_ARCHIVED);
  check('…et rendent la MÊME pièce', deux.mediaId === un.mediaId && trois.mediaId === un.mediaId);
  check('le fournisseur n’a été sollicité qu’UNE fois', appelsFournisseur === 1);

  check('un seul média pour ce mouvement',
    (await PanelMedia.countDocuments({ mediaId: un.mediaId })) === 1);

  const tx = await PanelFinancialTransaction.findOne({ transactionId }).lean();
  check('une seule association', tx.receipt.mediaId === un.mediaId);

  const fait = await PanelProviderRevenueFact.findOne({ factId }).lean();
  check('une seule empreinte', fait.invoiceArchive.sha256 === un.sha256);
}

// ═══════════════════════════════════════════════════════════════════════════
section('3 · UNE PIÈCE DÉPOSÉE PAR UN HUMAIN N’EST JAMAIS ÉCRASÉE');
{
  const { factId, transactionId } = await encaissementProjete();

  /** Un opérateur attache SA pièce avant que le fournisseur n'ait été lu. */
  const depose = await receipts.attachReceipt(
    transactionId, { buffer: PDF, filename: 'avoir-consolide.pdf' }, { email: 'gestion@panel.test' },
  );

  const r = await archival.archiveInvoiceForFact(factId, injecte);
  check('l’archivage se retire', r.outcome === archival.ARCHIVE_OUTCOME.RECEIPT_ALREADY_PRESENT);

  const tx = await PanelFinancialTransaction.findOne({ transactionId }).lean();
  check('la pièce de l’opérateur est intacte', tx.receipt.mediaId === depose.receipt.mediaId);
  check('…et son auteur aussi', tx.receipt.attachedBy === 'gestion@panel.test');
}

// ═══════════════════════════════════════════════════════════════════════════
section('4 · PAS DE FACTURE CHEZ LE FOURNISSEUR — un état, pas un échec');
{
  const { factId } = await encaissementProjete({ pdfUrl: null });
  const r = await archival.archiveInvoiceForFact(factId, injecte);
  check('l’absence de facture est NOMMÉE', r.outcome === archival.ARCHIVE_OUTCOME.NO_PROVIDER_INVOICE);
  check('aucune pièce n’est fabriquée', r.mediaId === null);
}

// ═══════════════════════════════════════════════════════════════════════════
section('5 · UN ÉCHEC DE TÉLÉCHARGEMENT NE DÉFAIT PAS LE REVENU');
{
  const { factId, transactionId } = await encaissementProjete({
    pdfUrl: 'https://pay.exemple.test/introuvable',
  });
  const r = await archival.archiveInvoiceForFact(factId, injecte);

  check('l’échec est rendu, jamais levé', r.outcome === archival.ARCHIVE_OUTCOME.FAILED);
  check('…avec son motif', String(r.reason).includes('404'));

  /** Le transport refuse AUSSI ce qui n'est pas une adresse suivable. */
  const transport = await import('../backend/src/services/integratedApi/stripe/stripeDocumentTransport.js');
  for (const adresse of ['http://pas-de-tls.test/x.pdf', 'file:///etc/passwd', '/relatif.pdf', '']) {
    // eslint-disable-next-line no-await-in-loop
    const refuse = await transport.downloadProviderDocument({ url: adresse, ...injecte })
      .then(() => null, (e) => e?.code);
    check(`« ${adresse || '(vide)'} » n’est pas suivie`,
      refuse === transport.DOCUMENT_TRANSPORT_CODES.UNSUPPORTED_URL);
  }

  const tx = await PanelFinancialTransaction.findOne({ transactionId }).lean();
  check('le mouvement est intact', tx.amountCents === 9599 && tx.deletedAt === null);

  const fait = await PanelProviderRevenueFact.findOne({ factId }).lean();
  check('la tentative est comptée', fait.invoiceArchive.attempts === 1);
  check('le motif est inscrit, pas muet', Boolean(fait.invoiceArchive.lastError));

  /** On ne réessaie pas indéfiniment : au-delà du plafond, on cesse tout seul. */
  for (let i = 0; i < archival.MAX_TENTATIVES_ARCHIVAGE; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await archival.archiveInvoiceForFact(factId, injecte);
  }
  const apres = await archival.archiveInvoiceForFact(factId, injecte);
  check('au-delà du plafond, on n’insiste plus automatiquement',
    apres.outcome === archival.ARCHIVE_OUTCOME.ABANDONED);
}

// ═══════════════════════════════════════════════════════════════════════════
section('6 · LE RATTRAPAGE REPREND LES ENCAISSEMENTS DÉJÀ PROJETÉS');
{
  /**
   * LE CAS DES DEUX TRANSACTIONS RÉELLES : projetées avant que l'archivage
   * n'existe, donc sans pièce et sans tentative. Le rattrapage doit les
   * retrouver sans qu'on les lui désigne.
   */
  await PanelProviderRevenueFact.deleteMany({});
  await PanelFinancialTransaction.deleteMany({});
  await PanelMedia.deleteMany({});

  const a = await encaissementProjete();
  const b = await encaissementProjete();
  const c = await encaissementProjete({ pdfUrl: null }); // sans facture : ignoré

  const rapport = await archival.backfillMissingInvoiceArchives({ limit: 50, ...injecte });
  check('le rattrapage n’examine que ce qui a une facture à archiver', rapport.examined === 2);
  check('les deux sont archivées', rapport.archived === 2);
  check('aucun échec', rapport.failed === 0);

  for (const { transactionId } of [a, b]) {
    // eslint-disable-next-line no-await-in-loop
    const tx = await PanelFinancialTransaction.findOne({ transactionId }).lean();
    check(`« ${transactionId} » porte désormais sa pièce`, Boolean(tx.receipt.mediaId));
  }
  const sansFacture = await PanelFinancialTransaction.findOne({ transactionId: c.transactionId }).lean();
  check('celui sans facture reste sans pièce, et c’est correct', sansFacture.receipt.mediaId === null);

  const second = await archival.backfillMissingInvoiceArchives({ limit: 50, ...injecte });
  check('un second passage ne trouve plus rien', second.examined === 0 && second.archived === 0);

  const faitA = await PanelProviderRevenueFact.findOne({ factId: a.factId }).lean();
  const description = await archival.describeInvoiceArchive(a.transactionId);
  check('la description dit ce que le fournisseur a émis',
    description.providerInvoiceNumber === faitA.invoiceDocument.number);
  check('…et l’identifiant de la facture du fournisseur',
    description.providerInvoiceId === faitA.invoiceDocument.invoiceId);
  check('…et que la copie est disponible', description.available === true);
}

// ═══════════════════════════════════════════════════════════════════════════
section('7 · L’ANNONCE VA À TOUS LES SUPER_ADMIN, ET À EUX SEULS');
{
  await seedFromEnv();
  await createUser({
    email: 'patron@panel.test', password: 'motdepasse-patron', displayName: 'Direction', role: 'SUPER_ADMIN',
  });
  await createUser({
    email: 'gestion@panel.test', password: 'motdepasse-gestion', displayName: 'Gestion', role: 'ADMIN',
  });
  await createUser({
    email: 'technique@panel.test', password: 'motdepasse-technic', displayName: 'Technique', role: 'DEV',
  });

  const destinataires = await annonces.resolvePanelSuperAdmins();
  const adresses = destinataires.map((d) => d.email).sort();

  check('au moins un SUPER_ADMIN est trouvé', adresses.length >= 1);
  check('aucun ADMIN n’y figure', !adresses.includes('gestion@panel.test'));
  check('aucun DEV n’y figure', !adresses.includes('technique@panel.test'));
  check('le SUPER_ADMIN ajouté y figure', adresses.includes('patron@panel.test'));

  /**
   * « LE PREMIER TROUVÉ » EST LA FAUTE QU'ON REFUSE.
   *
   * Un `findOne()` aurait fonctionné tant qu'il n'y a qu'un compte, puis cessé
   * en silence le jour d'un second. On ajoute donc un second SUPER_ADMIN et on
   * vérifie qu'il entre dans la liste — c'est le seul contrôle qui distingue
   * une résolution correcte d'un accident.
   */
  await createUser({
    email: 'associe@panel.test', password: 'motdepasse-associe', displayName: 'Associé', role: 'SUPER_ADMIN',
  });
  const apres = (await annonces.resolvePanelSuperAdmins()).map((d) => d.email);
  check('un SECOND SUPER_ADMIN est prévenu, lui aussi', apres.includes('associe@panel.test'));

  /** Un compte désactivé n'est plus un destinataire. */
  await PanelUser.updateOne({ email: 'associe@panel.test' }, { $set: { enabled: false } });
  const filtres = (await annonces.resolvePanelSuperAdmins()).map((d) => d.email);
  check('un compte désactivé sort de la liste', !filtres.includes('associe@panel.test'));

  /** Aucune adresse en double, même si deux comptes la partagent. */
  check('les adresses sont dédupliquées', new Set(filtres).size === filtres.length);
}

// ═══════════════════════════════════════════════════════════════════════════
section('8 · L’IDENTITÉ D’UN ENVOI NE CONTIENT AUCUNE HORLOGE');
{
  /**
   * C'est ce qui rend l'exactement-une-fois possible. Une clé qui porterait
   * `Date.now()` produirait un acte NEUF à chaque passage : un rattrapage
   * réexpédierait tout le parc, et l'index d'unicité ne pourrait rien y faire.
   */
  const a = annonces.paymentConfirmationOperationId('tx-abc', 0);
  const b = annonces.paymentConfirmationOperationId('tx-abc', 0);
  const c = annonces.paymentConfirmationOperationId('tx-abc', 1);
  const d = annonces.paymentConfirmationOperationId('tx-def', 0);

  check('deux calculs donnent la MÊME identité', a === b);
  check('deux destinataires donnent deux identités', a !== c);
  check('deux mouvements donnent deux identités', a !== d);
  check('elle nomme le mouvement', a.includes('tx-abc'));
  check('elle tient dans la borne de la capacité', a.length <= 64 && a.length >= 8);

  /** Le TYPE de règlement se dit en français, sans nommer le fournisseur. */
  check('un règlement de frais de lancement se nomme',
    annonces.describePaymentKind({ corroboration: { paymentType: 'LAUNCH_FEE' } }) === 'Frais de lancement');
  check('un règlement d’abonnement se nomme',
    annonces.describePaymentKind({ corroboration: { subscriptionId: 'sub_x' } }) === 'Abonnement');
  check('une prestation se nomme',
    annonces.describePaymentKind({ corroboration: { paymentRequestId: 'pr_x' } }) === 'Prestation');
}

// ═══════════════════════════════════════════════════════════════════════════
section('9 · LE MODÈLE DU PANEL N’EST JAMAIS POSÉ CHEZ UN PROJET');
{
  const { templateDefinition } = await import('../backend/src/services/email/panelEmailTemplateDefinitions.js');

  const panel = templateDefinition(annonces.PAYMENT_CONFIRMED_PANEL_TEMPLATE);
  check('le modèle du Panel existe au registre', Boolean(panel));
  check('…il est de portée PANEL, et d’elle seule',
    panel.scopes.length === 1 && panel.scopes[0] === 'PANEL');
  check('…et n’est JAMAIS provisionné pour un projet', panel.provisionForProjects === false);

  const projet = templateDefinition('PAYMENT_CONFIRMED_ADMIN');
  check('le modèle du client existe au registre', Boolean(projet));
  check('…il est de portée PROJECT', projet.scopes.length === 1 && projet.scopes[0] === 'PROJECT');
  check('…le lien de facture y est OBLIGATOIRE',
    projet.requiredVariables.includes('payment.invoiceUrl'));
  check('…tout comme la nature du règlement, qui rend le modèle générique',
    projet.requiredVariables.includes('payment.kind')
    && projet.requiredVariables.includes('payment.period'));
}

// ---------------------------------------------------------------------------
await fsp.rm(DOSSIER_PRIVE, { recursive: true, force: true });
finish();
