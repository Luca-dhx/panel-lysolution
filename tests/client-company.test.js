/**
 * L'ENTREPRISE CLIENTE — l'autorité de l'identité juridique du client.
 *
 * ══ CE QUE CETTE SUITE VERROUILLE ═══════════════════════════════════════════
 *
 * Le défaut d'origine, tel qu'il s'est vu sur une facture réelle :
 *
 *     Facture QWSK7ZZY-0004
 *     Facturer à : CTR-2026-0002
 *
 * Une RÉFÉRENCE DE CONTRAT en guise de raison sociale, aucune adresse, aucun
 * SIREN, aucune ventilation de TVA. Le Panel connaissait des sites, pas des
 * sociétés — et sa seule identité disponible au moment de créer le client
 * Stripe était la référence du contrat.
 *
 * Les contrôles portent donc sur trois choses, dans cet ordre :
 *
 *   1. LA DONNÉE       une fiche cliente existe, est validée, et refuse ce qui
 *                      ne peut pas figurer sur une facture ;
 *   2. LE VERDICT      « peut-on facturer ? » et « peut-on signer ? » sont deux
 *                      questions distinctes, calculées à un seul endroit ;
 *   3. LA CONSÉQUENCE  sans identité, AUCUN paiement et AUCUNE signature — et
 *                      le refus est backend, pas une couleur de bouton.
 *
 * Plus l'immuabilité : modifier une fiche ne réécrit jamais un instantané déjà
 * figé, sans quoi une facture de mars afficherait l'adresse de septembre.
 */
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  check, connectTestDatabase, finish, section, setTestEnv,
  startMemoryMongo, startServer, stopMemoryMongo,
} from './helpers/harness.js';

setTestEnv();
await startMemoryMongo();
await connectTestDatabase();

const { config } = await import('../backend/src/config/env.js');

/**
 * LE STOCKAGE PRIVÉ EST DÉTOURNÉ VERS UN DOSSIER JETABLE — même porte que le
 * runtime (`config.paths`), donc même chemin de code. Une recette qui laisse
 * des fichiers derrière elle finit par ressembler à des données réelles.
 */
const DOSSIER_PRIVE = await fsp.mkdtemp(path.join(os.tmpdir(), 'panel-client-'));
config.paths = { ...(config.paths ?? {}), privateMedia: DOSSIER_PRIVE };

const { createApp } = await import('../backend/src/app.js');
const { seedFromEnv, createUser } = await import('../backend/src/services/auth/panelUsers.service.js');
const PanelProject = (await import('../backend/src/models/PanelProject.model.js')).default;
const PanelMedia = (await import('../backend/src/models/PanelMedia.model.js')).default;
const { PanelProjectContract } = await import('../backend/src/models/PanelProjectProjection.model.js');
const { resetSyncCore, pullForProject } = await import('../backend/src/services/sync/syncCore.service.js');
const validation = await import('../backend/src/services/clientCompany/clientCompany.validation.js');
const readiness = await import('../backend/src/services/clientCompany/clientCompanyReadiness.js');
const snapshot = await import('../backend/src/services/clientCompany/clientLegalSnapshot.js');
const checkoutAuthority = await import('../backend/src/services/integratedApi/stripe/stripeCheckoutAuthority.js');
const customerAuthority = await import('../backend/src/services/integratedApi/stripe/stripeCustomerAuthority.js');
const fiscal = await import('../backend/src/services/contract/contractFiscalLine.js');

await resetSyncCore();
await seedFromEnv();
await createUser({
  email: 'admin@panel.test', password: 'motdepasse-admin', displayName: 'Gestion', role: 'ADMIN',
});

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
    createdAt: now, updatedAt: now,
    pairing: { status: 'PAIRED' }, runtime: { environment: 'TEST' },
  });
};
const PROJET_A = 'garage-nord';
const PROJET_B = 'garage-sud';
await declarer(PROJET_A, 'Garage du Nord');
await declarer(PROJET_B, 'Garage du Sud');

/** Une fiche COMPLÈTE, cohérente — SIREN Luhn-valide, SIRET et TVA dérivés. */
const FICHE = Object.freeze({
  legalName: 'SARL RECETTE AUTOMOBILE',
  tradingName: 'Auto Recette',
  legalForm: 'SARL',
  siren: '732829320',
  siret: '73282932000074',
  vatNumber: 'FR44732829320',
  registrationCity: 'Nice',
  registeredOffice: {
    line1: '12 avenue de la Recette', postalCode: '06000', city: 'Nice', country: 'FR',
  },
  billingEmail: 'facturation@recette.test',
  phone: '+33 4 00 00 00 00',
  contractualSigner: {
    firstName: 'Camille', lastName: 'Recette', jobTitle: 'Gérante',
    email: 'camille.recette@recette.test',
  },
});

const creer = (patch = {}, auth = DEV) =>
  call('POST', '/api/client-companies', { headers: { authorization: auth }, body: { ...FICHE, ...patch } });

/* ══════════════════════════════════════════════════════════════════════════ */
section('1. La validation — ce qui ne peut pas figurer sur une facture est refusé');
{
  const luhn = validation.satisfiesLuhn;
  check('un SIREN valide satisfait la clé de contrôle', luhn('732829320'));
  check('une inversion de chiffres est prise', !luhn('732829302'));
  check('l’exception documentée de La Poste est admise', luhn('356000000'));

  const refus = (patch) => validation.validateClientCompanyInput({ ...FICHE, ...patch });
  check('SIREN à 8 chiffres → refusé', !refus({ siren: '73282932' }).valid);
  check('SIREN dont la clé est fausse → refusé', !refus({ siren: '732829321' }).valid);
  check('SIREN imprimé avec des espaces → ACCEPTÉ (copier-coller réel)',
    refus({ siren: '732 829 320' }).valid);
  check('SIRET qui ne commence pas par le SIREN → refusé',
    !refus({ siret: '99999999900011' }).valid);
  check('TVA française qui ne finit pas par le SIREN → refusé',
    !refus({ vatNumber: 'FR44999999999' }).valid);
  check('pays hors ISO à deux lettres → refusé',
    !refus({ registeredOffice: { ...FICHE.registeredOffice, country: 'France' } }).valid);
  check('e-mail de facturation invalide → refusé', !refus({ billingEmail: 'pas-un-email' }).valid);
  check('raison sociale absente → refusé', !refus({ legalName: '' }).valid);
  /**
   * L'EFFACEMENT EST UNE INTENTION, PAS UNE ERREUR. Une fiche doit pouvoir être
   * enregistrée en cours de saisie : c'est la READINESS qui juge la complétude,
   * pas la validation.
   */
  check('SIREN vidé → accepté (fiche en cours de saisie)', refus({ siren: '' }).valid);
  check('signataire absent → accepté', refus({ contractualSigner: null }).valid);
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('2. Le verdict — deux questions, jamais fondues en une');
let clientId = null;
{
  const complete = await creer();
  check('création acceptée (201)', complete.status === 201);
  clientId = complete.json.data.clientCompany.clientCompanyId;
  const vue = complete.json.data.clientCompany;
  check('…et elle est PRÊTE', vue.readiness.ready === true);
  check('…facturation et signature prêtes toutes deux',
    vue.readiness.billing.ready && vue.readiness.signing.ready);
  check('…l’adresse de facturation EFFECTIVE retombe sur le siège',
    vue.billingAddressEffective?.city === 'Nice' && vue.billingAddress === null);

  const sansSiren = readiness.describeClientCompanyReadiness({
    ...FICHE, clientCompanyId: 'x', status: 'ACTIVE', siren: null,
  });
  check('sans SIREN → facturation IMPOSSIBLE', sansSiren.billing.ready === false);
  check('…mais la SIGNATURE reste possible', sansSiren.signing.ready === true);
  check('…et le motif nomme le SIREN', sansSiren.billing.missing.includes('SIREN'));

  const sansSignataire = readiness.describeClientCompanyReadiness({
    ...FICHE, clientCompanyId: 'x', status: 'ACTIVE', contractualSigner: null,
  });
  check('sans signataire → signature IMPOSSIBLE', sansSignataire.signing.ready === false);
  check('…mais la FACTURATION reste possible', sansSignataire.billing.ready === true);

  const sansAdresse = readiness.describeClientCompanyReadiness({
    ...FICHE, clientCompanyId: 'x', status: 'ACTIVE', registeredOffice: null, billingAddress: null,
  });
  check('sans aucune adresse → facturation impossible', sansAdresse.billing.ready === false);

  const archivee = readiness.describeClientCompanyReadiness({
    ...FICHE, clientCompanyId: 'x', status: 'ARCHIVED',
  });
  check('archivée → prête à RIEN, même complète', !archivee.billing.ready && !archivee.signing.ready);
  check('…et le motif le dit franchement', archivee.archived === true);

  const aucune = readiness.describeClientCompanyReadiness(null);
  check('aucune entreprise → MISSING_COMPANY', aucune.state === 'MISSING_COMPANY');
  check('…jamais « prête » par défaut', aucune.ready === false);
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('3. Le rattachement — une entreprise, plusieurs projets');
{
  const a = await call('POST', `/api/client-companies/${clientId}/projects`, {
    headers: { authorization: DEV }, body: { projectId: PROJET_A },
  });
  check('projet A rattaché', a.status === 200 && a.json.data.linked === true);

  const b = await call('POST', `/api/client-companies/${clientId}/projects`, {
    headers: { authorization: DEV }, body: { projectId: PROJET_B },
  });
  check('projet B rattaché à la MÊME entreprise', b.status === 200);

  const fiche = await call('GET', `/api/client-companies/${clientId}`, {
    headers: { authorization: ADMIN },
  });
  check('la fiche liste ses DEUX projets', fiche.json.data.clientCompany.projects.length === 2);

  /**
   * LE PROJET REÇOIT SON IDENTITÉ IMMÉDIATEMENT — sans quoi sa page « Mon
   * entreprise » resterait vide jusqu'à la prochaine modification de la fiche,
   * et ses boutons de paiement resteraient bloqués après un rattachement fait.
   */
  const page = await pullForProject(PROJET_A, { limit: 50 });
  const publiees = page.changes.filter((c) => c.entityType === 'CLIENT_COMPANY');
  check('l’entreprise est PUBLIÉE au projet dès le rattachement', publiees.length >= 1);
  check('…avec sa raison sociale', publiees.at(-1).payload.legalName === FICHE.legalName);
  check('…et son verdict de complétude', publiees.at(-1).payload.readiness?.ready === true);
  /**
   * LA NOTE INTERNE NE FRANCHIT JAMAIS LE PONT : c'est une appréciation sur un
   * client, et le client la lirait.
   */
  check('la note interne NE part PAS au projet', !('notes' in publiees.at(-1).payload));
  check('les documents NE partent PAS au projet', !('documents' in publiees.at(-1).payload));

  /**
   * L'ÉCRITURE EST NOMINATIVE : le SIREN d'un client n'a aucune raison
   * d'atteindre les autres projets du parc.
   */
  const { PanelSyncJournalEntry } = await import('../backend/src/models/PanelSyncState.model.js');
  const journal = await PanelSyncJournalEntry.find({ 'change.entityType': 'CLIENT_COMPANY' }).lean();
  check('chaque écriture nomme SON destinataire',
    journal.length > 0 && journal.every((e) => e.audience !== null));
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('4. Le paiement — NO CLIENT COMPANY, NO PAYMENT');
{
  const semer = async (projectId, contractId) => {
    await PanelProjectContract.updateOne(
      { projectId },
      {
        $set: {
          projectId, hasCurrent: true, sourceContractId: contractId, status: 'ACTIVE',
          reference: 'CTR-2026-0002', taxRate: 20,
          pricing: {
            launchFee: {
              amountIncludingTax: 9599, amountExcludingTax: 7999, taxAmount: 1600,
              taxRate: 20, currency: 'EUR',
            },
            subscription: null,
          },
          sourceModifiedAt: new Date().toISOString(),
          receivedAt: new Date().toISOString(),
        },
      },
      { upsert: true },
    );
  };
  await semer(PROJET_A, 'ct-a');
  /** Un TROISIÈME projet, volontairement SANS entreprise cliente. */
  const PROJET_C = 'garage-orphelin';
  await declarer(PROJET_C, 'Garage orphelin');
  await semer(PROJET_C, 'ct-c');

  const entree = (contractRef) => ({
    paymentType: 'LAUNCH_FEE',
    contractRef,
    successUrl: 'https://x.test/ok',
    cancelUrl: 'https://x.test/ko',
    operationId: 'op-recette-0123456789abcdef',
  });

  let refus = null;
  try {
    await checkoutAuthority.resolveCheckoutIntent({
      projectId: PROJET_C, environment: 'TEST', input: entree('ct-c'),
    });
  } catch (e) { refus = e; }
  check('projet SANS entreprise → checkout REFUSÉ', Boolean(refus));
  check('…et le motif est ACTIONNABLE', refus?.reason === 'CLIENT_COMPANY_NOT_READY');
  check('…le message dit quoi faire', /entreprise cliente/i.test(refus?.message ?? ''));

  let refusClient = null;
  try {
    await customerAuthority.resolveCustomerIntent({
      projectId: PROJET_C, environment: 'TEST', input: { contractRef: 'ct-c' },
    });
  } catch (e) { refusClient = e; }
  check('…et AUCUN client Stripe ne peut être créé non plus',
    refusClient?.reason === 'CLIENT_COMPANY_NOT_READY');

  const intention = await checkoutAuthority.resolveCheckoutIntent({
    projectId: PROJET_A, environment: 'TEST', input: entree('ct-a'),
  });
  check('projet AVEC entreprise complète → checkout autorisé', Boolean(intention));

  /* ── LA VENTILATION — ce que Stripe recevra ─────────────────────────────── */
  const params = intention.paramsFor({ taxRateId: 'txr_test' });
  check('le montant envoyé est le HORS TAXE',
    params.line_items[0].price_data.unit_amount === 7999);
  check('…accompagné d’un taux de TVA exclusif',
    params.line_items[0].tax_rates[0] === 'txr_test');
  check('…et le client débite toujours le TTC du contrat',
    intention.amountIncludingTax === 9599);
  /**
   * LA RÉFÉRENCE DE CONTRAT RESTE — mais comme RÉFÉRENCE COMMERCIALE, jamais
   * comme identité du destinataire. C'est tout le chantier en une assertion.
   */
  check('la référence de contrat figure en champ personnalisé de facture',
    params.invoice_creation.invoice_data.custom_fields?.[0]?.value === 'CTR-2026-0002');
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('5. Le client Stripe — la RAISON SOCIALE, jamais la référence de contrat');
{
  const intention = await customerAuthority.resolveCustomerIntent({
    projectId: PROJET_A, environment: 'TEST', input: { contractRef: 'ct-a' },
  });
  check('le nom envoyé est la RAISON SOCIALE', intention.params.name === FICHE.legalName);
  check('…et surtout PAS la référence de contrat', intention.params.name !== 'CTR-2026-0002');
  check('l’e-mail est celui de FACTURATION', intention.params.email === FICHE.billingEmail);
  check('l’adresse postale traverse', intention.params.address.line1 === FICHE.registeredOffice.line1);
  check('…avec son pays en code ISO', intention.params.address.country === 'FR');
  check('le SIREN accompagne en metadata', intention.params.metadata.clientSiren === FICHE.siren);
  check('la référence de contrat reste une metadata',
    intention.params.metadata.contractReference === 'CTR-2026-0002');
  check('le numéro de TVA sort à part (sous-ressource Stripe)',
    intention.taxIdentity?.type === 'eu_vat' && intention.taxIdentity.value === FICHE.vatNumber);

  /**
   * LE PROJET NE PEUT PLUS INFLUENCER L'IDENTITÉ. Il envoie encore `customer`
   * (un projet non redéployé le fait), et la valeur est IGNORÉE.
   */
  const avecProposition = await customerAuthority.resolveCustomerIntent({
    projectId: PROJET_A,
    environment: 'TEST',
    input: { contractRef: 'ct-a', customer: { name: 'CE QUE LE PROJET PROPOSE', email: 'x@y.fr' } },
  });
  check('la proposition du projet est IGNORÉE',
    avecProposition.params.name === FICHE.legalName && avecProposition.params.email === FICHE.billingEmail);
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('6. La ventilation fiscale — lue, vérifiée, jamais devinée');
{
  const ligne = (patch) => ({
    amountIncludingTax: 9599, amountExcludingTax: 7999, taxAmount: 1600, taxRate: 20,
    currency: 'EUR', ...patch,
  });
  const lue = fiscal.readFiscalLine(ligne());
  check('HT + TVA = TTC', lue.netCents + lue.taxCents === lue.grossCents);
  check('…et le taux est celui de la ligne', lue.taxRate === 20);

  const refuse = (patch) => {
    try { fiscal.readFiscalLine(ligne(patch)); return null; } catch (e) { return e; }
  };
  check('une ligne qui ne s’additionne pas → REFUSÉE',
    refuse({ taxAmount: 1500 })?.reason === 'CONTRACT_TAX_BREAKDOWN_INCOHERENT');
  check('un taux incompatible avec le montant de TVA → REFUSÉ',
    refuse({ taxRate: 5.5 })?.reason === 'CONTRACT_TAX_BREAKDOWN_INCOHERENT');
  check('une ligne SANS ventilation → refus NOMMÉ, jamais un taux supposé',
    refuse({ amountExcludingTax: null, taxAmount: null, taxRate: null })?.reason
      === 'CONTRACT_TAX_BREAKDOWN_ABSENT');

  /** Le taux du CONTRAT sert de défaut — jamais 20 % en dur. */
  const heritee = fiscal.readFiscalLine(
    { amountIncludingTax: 9599, amountExcludingTax: 7999, taxAmount: 1600, currency: 'EUR' },
    { contractTaxRate: 20 },
  );
  check('le taux du contrat sert de défaut à une ligne qui n’en porte pas', heritee.taxRate === 20);
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('7. L’instantané légal — l’histoire ne se réécrit pas');
{
  const fiche = await call('GET', `/api/client-companies/${clientId}`, {
    headers: { authorization: DEV },
  });
  const avant = snapshot.buildClientLegalSnapshot(fiche.json.data.clientCompany, { at: '2026-03-01T00:00:00.000Z' });
  check('l’instantané porte la raison sociale', avant.legalName === FICHE.legalName);
  check('…le SIREN', avant.siren === FICHE.siren);
  check('…l’adresse de facturation RÉSOLUE', avant.billingAddress.city === 'Nice');
  check('…et il ne porte JAMAIS la note interne', !('notes' in avant));

  const signataireAvant = snapshot.buildClientSignerSnapshot(fiche.json.data.clientCompany);
  check('l’instantané de signataire porte son identité',
    signataireAvant.email === FICHE.contractualSigner.email);
  check('…et la RAISON SOCIALE, pas l’enseigne',
    signataireAvant.companyName === FICHE.legalName);

  /* L'entreprise déménage et change de gérant. */
  const apresPatch = await call('PATCH', `/api/client-companies/${clientId}`, {
    headers: { authorization: DEV },
    body: {
      registeredOffice: { line1: '99 boulevard Neuf', postalCode: '06200', city: 'Nice', country: 'FR' },
      contractualSigner: { firstName: 'Alex', lastName: 'Nouveau', email: 'alex@recette.test', jobTitle: 'Gérant' },
    },
  });
  check('la modification est acceptée', apresPatch.status === 200);
  const apres = snapshot.buildClientLegalSnapshot(apresPatch.json.data.clientCompany, { at: '2026-09-01T00:00:00.000Z' });
  check('le NOUVEL instantané porte la nouvelle adresse', apres.billingAddress.line1 === '99 boulevard Neuf');
  /**
   * L'ANCIEN N'A PAS BOUGÉ. C'est toute la raison d'être de l'instantané : une
   * facture de mars ne doit pas afficher l'adresse de septembre.
   */
  check('l’ANCIEN instantané est INTACT', avant.billingAddress.line1 === '12 avenue de la Recette');
  check('…et son ancien signataire aussi', signataireAvant.lastName === 'Recette');
  check('la version publiée a MONTÉ',
    apresPatch.json.data.clientCompany.publishedVersion > 1);
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('8. Les documents — privés, rattachés, sans aucune URL');
{
  const PDF = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.from('kbis'), Buffer.from('\n%%EOF\n')]);
  const form = new FormData();
  form.append('file', new Blob([PDF]), 'scan0012.pdf');
  form.append('label', 'Kbis 2026');
  form.append('type', 'KBIS');
  const depot = await fetch(`${base}/api/client-companies/${clientId}/documents`, {
    method: 'POST', headers: { authorization: DEV }, body: form,
  });
  const depotJson = await depot.json();
  check('dépôt accepté (201)', depot.status === 201);
  const documents = depotJson.data.clientCompany.documents;
  check('le document est rattaché à la fiche', documents.length === 1);
  check('…sous le nom donné par l’opérateur', documents[0].label === 'Kbis 2026');
  /**
   * AUCUNE URL. Un document client vit dans le stockage privé : en publier une,
   * même relative, inviterait à la mettre dans un `<a href>` — et ce lien
   * finirait hors de toute session.
   */
  check('…et SANS aucune adresse', !('url' in documents[0]) && !('path' in documents[0]));

  const media = await PanelMedia.findOne({ scope: 'CLIENT_COMPANY_DOCUMENT' }).lean();
  check('le média est PRIVÉ', media?.visibility === 'PRIVATE');
  check('…et il ne vit pas dans l’espace servi', !String(media?.path ?? '').startsWith('/uploads'));
  check('…il n’est jamais « publié »', media?.publicationState === 'LOCAL_ONLY');

  const lecture = await fetch(
    `${base}/api/client-companies/${clientId}/documents/${documents[0].documentId}`,
    { headers: { authorization: ADMIN } },
  );
  check('un compte de GESTION peut le télécharger', lecture.status === 200);
  check('…en pièce jointe, jamais dans l’origine du Panel',
    (lecture.headers.get('content-disposition') ?? '').startsWith('attachment'));
  const octets = Buffer.from(await lecture.arrayBuffer());
  check('…et les octets sont EXACTEMENT ceux déposés', octets.equals(PDF));

  const sansJeton = await fetch(
    `${base}/api/client-companies/${clientId}/documents/${documents[0].documentId}`,
  );
  check('sans jeton → refusé', sansJeton.status === 401);

  /** Un identifiant emprunté à une autre fiche ne mène nulle part. */
  const autre = await creer({ legalName: 'SARL AUTRE', siren: null, siret: null, vatNumber: null });
  const vol = await fetch(
    `${base}/api/client-companies/${autre.json.data.clientCompany.clientCompanyId}`
    + `/documents/${documents[0].documentId}`,
    { headers: { authorization: DEV } },
  );
  check('un documentId d’une AUTRE fiche → 404', vol.status === 404);
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('9. Les permissions — lire est un travail de gestion, écrire non');
{
  const lecture = await call('GET', '/api/client-companies', { headers: { authorization: ADMIN } });
  check('un compte ADMIN peut LIRE la liste', lecture.status === 200);

  const ecriture = await call('POST', '/api/client-companies', {
    headers: { authorization: ADMIN }, body: FICHE,
  });
  check('…mais pas CRÉER', ecriture.status === 403);

  const modification = await call('PATCH', `/api/client-companies/${clientId}`, {
    headers: { authorization: ADMIN }, body: { phone: '+33 1 00 00 00 00' },
  });
  check('…ni MODIFIER', modification.status === 403);

  const sans = await call('GET', '/api/client-companies');
  check('sans jeton → refusé', sans.status === 401);
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('10. L’archivage et la suppression — aucune cascade destructive');
{
  const suppression = await call('DELETE', `/api/client-companies/${clientId}`, {
    headers: { authorization: DEV },
  });
  check('une entreprise AVEC projets ne se supprime pas', suppression.status === 409);
  check('…et le message propose l’archivage',
    /archivez/i.test(suppression.json.message ?? ''));

  const archive = await call('POST', `/api/client-companies/${clientId}/archive`, {
    headers: { authorization: DEV },
  });
  check('l’archivage est accepté', archive.status === 200);
  check('…la fiche devient NON PRÊTE', archive.json.data.clientCompany.readiness.ready === false);
  /**
   * LES PROJETS RESTENT RATTACHÉS. Les détacher effacerait l'information
   * « ce site appartenait à ce client » — précisément ce qu'on vient chercher
   * dans une archive.
   */
  check('…mais ses projets restent rattachés',
    archive.json.data.clientCompany.projects.length === 2);

  let refus = null;
  try {
    await checkoutAuthority.resolveCheckoutIntent({
      projectId: PROJET_A,
      environment: 'TEST',
      input: {
        paymentType: 'LAUNCH_FEE', contractRef: 'ct-a',
        successUrl: 'https://x.test/ok', cancelUrl: 'https://x.test/ko',
        operationId: 'op-recette-0123456789abcdef',
      },
    });
  } catch (e) { refus = e; }
  check('entreprise ARCHIVÉE → plus aucun paiement', refus?.reason === 'CLIENT_COMPANY_NOT_READY');

  const restauration = await call('POST', `/api/client-companies/${clientId}/restore`, {
    headers: { authorization: DEV },
  });
  check('la réactivation est possible', restauration.json.data.clientCompany.status === 'ACTIVE');
  check('…et la fiche redevient prête', restauration.json.data.clientCompany.readiness.ready === true);

  /* Le détachement suspend le projet, sans toucher à la fiche. */
  const detache = await call('DELETE', `/api/client-companies/projects/${PROJET_B}`, {
    headers: { authorization: DEV },
  });
  check('un projet se détache', detache.json.data.unlinked === true);
  const apres = await call('GET', `/api/client-companies/${clientId}`, {
    headers: { authorization: DEV },
  });
  check('…et la fiche n’en compte plus qu’un', apres.json.data.clientCompany.projects.length === 1);

  const tombstone = await pullForProject(PROJET_B, { limit: 50 });
  const retraits = tombstone.changes.filter((c) => c.entityType === 'CLIENT_COMPANY' && c.deleted);
  check('le projet détaché APPREND qu’il n’a plus de client', retraits.length >= 1);
}

await close();
await fsp.rm(DOSSIER_PRIVE, { recursive: true, force: true });
await stopMemoryMongo();
finish();
