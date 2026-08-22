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
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  check, connectTestDatabase, finish, section, setTestEnv,
  startMemoryMongo, startServer, stopMemoryMongo,
} from './helpers/harness.js';

setTestEnv();
await startMemoryMongo();
await connectTestDatabase();

const RACINE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
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

  /**
   * ── CHAQUE ÉCRITURE EST CONFORME AU CONTRAT — LE CONTRÔLE QUI MANQUAIT ──
   *
   * ══ L'INCIDENT ════════════════════════════════════════════════════════
   *
   * `entityId` recevait `clientCompanyId` — un identifiant opaque court, pas
   * un UUID. Le Panel journalisait sans broncher ; le projet, qui valide en
   * `.strict()`, ÉCARTAIT l'écriture. Or une écriture écartée à la lecture
   * est une PERTE DÉFINITIVE : le curseur avance, le Panel ne relivre pas.
   * L'entreprise cliente n'arrivait jamais, paiements et signatures
   * restaient bloqués, et rien côté Panel ne paraissait anormal.
   *
   * ══ POURQUOI CE CONTRÔLE-CI, ET PAS UN ASSERT SUR LA FORME DE L'UUID ══
   *
   * Parce qu'il relit la production RÉELLE avec le schéma que le PROJET
   * applique. Un contrôle sur la forme aurait vérifié ce qu'on croit ; 
   * celui-ci vérifie ce que l'autre bout exigera.
   */
  const { syncChangeSchema } = await import('../backend/src/bridge/bridgeContract.js');
  const nonConformes = journal
    .map((e) => ({ e, r: syncChangeSchema.safeParse(e.change) }))
    .filter((x) => !x.r.success);
  check('chaque écriture publiée est LISIBLE par un projet conforme',
    nonConformes.length === 0);

  /**
   * L'IDENTIFIANT MÉTIER RESTE LISIBLE DANS LA CHARGE UTILE.
   *
   * La dérivation ne doit pas rendre la corrélation humaine impossible :
   * sans `clientCompanyId` dans le payload, plus personne ne saurait relier
   * une écriture du journal à une fiche du Panel.
   */
  check('l’identifiant métier voyage dans la charge utile',
    journal.filter((e) => !e.change.deleted)
      .every((e) => typeof e.change.payload?.clientCompanyId === 'string'));

  /**
   * LE RETRAIT DÉSIGNE LA MÊME ENTITÉ QUE LA PUBLICATION.
   *
   * Deux dérivations différentes produiraient un tombstone qui ne désigne
   * rien : le projet garderait une entreprise que le Panel croit retirée.
   */
  const parEntreprise = new Map();
  for (const e of journal) {
    if (e.change.deleted) continue;
    parEntreprise.set(e.change.payload.clientCompanyId, e.change.entityId);
  }
  const pierres = journal.filter((e) => e.change.deleted);
  check('un retrait porte l’identité d’entité de la publication',
    pierres.every((e) => [...parEntreprise.values()].includes(e.change.entityId)));
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('3 bis. L’émission — une écriture non conforme NE NAÎT PAS');
{
  /**
   * La garde vit dans `emitChange`, l'unique naissance d'une écriture. La
   * placer là la rend valable pour TOUS les types, y compris ceux qui
   * n'existent pas encore — et un producteur fautif échoue chez lui, tout de
   * suite, plutôt que des semaines plus tard à l'autre bout.
   */
  const { emitChange } = await import('../backend/src/services/sync/syncCore.service.js');
  const { PanelSyncJournalEntry } = await import('../backend/src/models/PanelSyncState.model.js');

  const avant = await PanelSyncJournalEntry.countDocuments();
  let refusee = null;
  try {
    await emitChange({
      entityType: 'CLIENT_COMPANY',
      entityId: 'cc217bdccb550b4514ae7b',   // l'identifiant métier, pas un UUID
      payload: { clientCompanyId: 'cc217bdccb550b4514ae7b' },
      audience: 'p-quelconque',
    });
  } catch (e) { refusee = e; }
  const apres = await PanelSyncJournalEntry.countDocuments();

  check('un entityId qui n’est pas un UUID est REFUSÉ', refusee !== null);
  check('le refus nomme le champ fautif',
    /entityId/.test(refusee?.message ?? ''));
  check('le refus explique la conséquence (aucune relivraison)',
    /relivr/i.test(refusee?.message ?? ''));
  check('AUCUNE trace n’est laissée dans le journal', apres === avant);

  /**
   * La dérivation, elle, passe — et elle est STABLE : même graine, même
   * identifiant, sans quoi l'idempotence du pont ne tiendrait pas d'un
   * redémarrage à l'autre.
   */
  const { stableBridgeId } = await import('../backend/src/bridge/bridgeContract.js');
  const u1 = stableBridgeId('client-company:cc217bdccb550b4514ae7b');
  const u2 = stableBridgeId('client-company:cc217bdccb550b4514ae7b');
  check('la dérivation produit un UUID', /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(u1));
  check('la dérivation est STABLE', u1 === u2);
  check('deux entreprises ne partagent pas une identité',
    u1 !== stableBridgeId('client-company:cc999999999999999999999'));
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
section('6 bis. Les DEUX lignes du contrat mènent à un paiement — pas seulement une');
{
  /**
   * ── LE DÉFAUT QUE CETTE SECTION VERROUILLE ────────────────────────────────
   *
   * La ventilation fiscale était éprouvée sur les frais de lancement, et sur
   * eux SEULS. L'abonnement emprunte un AUTRE module — `stripePriceAuthority`
   * plutôt que `stripeCheckoutAuthority` — et personne n'avait vérifié qu'il
   * lisait la même ventilation.
   *
   * En recette réelle, les deux ont échoué ensemble : le projet ne publiait
   * pas `amountExcludingTax`, et NI les frais de lancement NI l'abonnement
   * n'étaient encaissables. Une seule des deux branches était gardée ; elle
   * n'aurait de toute façon rien dit de l'autre.
   */
  const CONTRAT = 'ct-fiscal-deux-lignes';
  const LANCEMENT = { net: 29000, tva: 5800, ttc: 34800 };
  const ABONNEMENT = { net: 83988, tva: 16798, ttc: 100786 };

  const projeter = async (pricing) => {
    await PanelProjectContract.updateOne(
      { projectId: PROJET_A },
      {
        $set: {
          projectId: PROJET_A, hasCurrent: true, sourceContractId: CONTRAT, status: 'ACTIVE',
          reference: 'CTR-FISCAL', taxRate: 20,
          pricing,
          sourceModifiedAt: new Date().toISOString(),
          receivedAt: new Date().toISOString(),
        },
      },
      { upsert: true },
    );
  };

  const COMPLET = {
    launchFee: {
      amountIncludingTax: LANCEMENT.ttc, amountExcludingTax: LANCEMENT.net,
      taxAmount: LANCEMENT.tva, taxRate: 20, currency: 'EUR',
    },
    subscription: {
      amountIncludingTax: ABONNEMENT.ttc, amountExcludingTax: ABONNEMENT.net,
      taxAmount: ABONNEMENT.tva, taxRate: 20, currency: 'EUR',
      recurrence: { unit: 'YEAR', interval: 1 }, interval: 'YEAR',
    },
  };

  const priceAuthority = await import('../backend/src/services/integratedApi/stripe/stripePriceAuthority.js');
  const entreeLancement = (operationId) => ({
    paymentType: 'LAUNCH_FEE', contractRef: CONTRAT,
    successUrl: 'https://x.test/ok', cancelUrl: 'https://x.test/ko',
    operationId,
  });
  const refuse = async (fn) => { try { await fn(); return null; } catch (e) { return e; } };

  await projeter(COMPLET);

  /* ── A. FRAIS DE LANCEMENT ─────────────────────────────────────────────── */
  const frais = await checkoutAuthority.resolveCheckoutIntent({
    projectId: PROJET_A, environment: 'TEST', input: entreeLancement('op-fiscal-lancement-000001'),
  });
  const paramsFrais = frais.paramsFor({ taxRateId: 'txr_fiscal' });
  check('frais de lancement : Stripe reçoit le HORS TAXE',
    paramsFrais.line_items[0].price_data.unit_amount === LANCEMENT.net);
  check('frais de lancement : un taux EXCLUSIF accompagne le montant',
    paramsFrais.line_items[0].tax_rates?.[0] === 'txr_fiscal');
  check('frais de lancement : le total débité reste le TTC du contrat',
    frais.amountIncludingTax === LANCEMENT.ttc);
  check('frais de lancement : HT + TVA = TTC',
    frais.fiscal.netCents + frais.fiscal.taxCents === frais.fiscal.grossCents);
  check('frais de lancement : aucune double TVA — le TTC n’est jamais envoyé comme HT',
    paramsFrais.line_items[0].price_data.unit_amount !== LANCEMENT.ttc);

  /* ── B. ABONNEMENT ─────────────────────────────────────────────────────── */
  const abo = await priceAuthority.resolvePriceIntent({
    projectId: PROJET_A, environment: 'TEST', contractRef: CONTRAT,
  });
  check('abonnement : le Price porte le HORS TAXE', abo.amount === ABONNEMENT.net);
  check('abonnement : HT + TVA = TTC',
    abo.fiscal.netCents + abo.fiscal.taxCents === abo.fiscal.grossCents
    && abo.fiscal.grossCents === ABONNEMENT.ttc);
  check('abonnement : le taux est celui du contrat, jamais supposé', abo.fiscal.taxRate === 20);
  check('abonnement : la TVA correspond au taux annoncé',
    abo.fiscal.taxCents === Math.round((abo.fiscal.netCents * abo.fiscal.taxRate) / 100));
  const paramsPrice = abo.priceParamsFor('prod_test');
  check('abonnement : le Price déclare son montant EXCLUSIF de taxe',
    paramsPrice.unit_amount === ABONNEMENT.net && paramsPrice.tax_behavior === 'exclusive');
  check('abonnement : aucune double TVA — le TTC n’entre pas dans le tarif',
    paramsPrice.unit_amount !== ABONNEMENT.ttc);

  /* ── C. LE DÉFAUT LUI-MÊME, SUR LES DEUX LIGNES ────────────────────────── */
  /**
   * La forme EXACTE que le projet publiait avant ce lot : un TTC, un taux de
   * contrat, et rien d'autre. Les deux branches doivent refuser — et refuser en
   * NOMMANT la ventilation absente, jamais en supposant un taux.
   */
  await projeter({
    launchFee: { amountIncludingTax: LANCEMENT.ttc, currency: 'EUR' },
    subscription: {
      amountIncludingTax: ABONNEMENT.ttc, currency: 'EUR',
      recurrence: { unit: 'YEAR', interval: 1 }, interval: 'YEAR',
    },
  });

  const refusFrais = await refuse(() => checkoutAuthority.resolveCheckoutIntent({
    projectId: PROJET_A, environment: 'TEST', input: entreeLancement('op-fiscal-absent-000001'),
  }));
  check('sans ventilation, les frais de lancement sont REFUSÉS', Boolean(refusFrais));
  check('…en nommant la ventilation absente',
    /ventilation fiscale/i.test(refusFrais?.message ?? ''));

  const refusAbo = await refuse(() => priceAuthority.resolvePriceIntent({
    projectId: PROJET_A, environment: 'TEST', contractRef: CONTRAT,
  }));
  check('…et l’abonnement AUSSI', Boolean(refusAbo));
  check('…en nommant la ventilation, jamais en supposant un taux',
    /ventilation fiscale/i.test(refusAbo?.message ?? ''));

  /**
   * ── AUCUN REPLI FISCAL IMPLICITE ──────────────────────────────────────────
   *
   * Le contrat porte pourtant `taxRate: 20`. La tentation était d'en déduire le
   * HT (`TTC / 1,2`) : la formule est juste, et son résultat peut différer d'un
   * centime de ce que le contrat a calculé — le contrat part du HT et arrondit
   * la TVA, la déduction part du TTC et arrondit le HT. Un écart d'un centime
   * entre le contrat SIGNÉ et la facture ÉMISE est indéfendable.
   */
  check('un taux disponible ne suffit PAS à fabriquer un HT',
    Boolean(refusFrais) && Boolean(refusAbo));

  /* ── D. UNE INCOHÉRENCE RESTE BLOQUANTE ────────────────────────────────── */
  await projeter({
    launchFee: {
      amountIncludingTax: LANCEMENT.ttc, amountExcludingTax: LANCEMENT.net,
      taxAmount: 999, taxRate: 20, currency: 'EUR',
    },
    subscription: null,
  });
  const refusIncoherent = await refuse(() => checkoutAuthority.resolveCheckoutIntent({
    projectId: PROJET_A, environment: 'TEST', input: entreeLancement('op-fiscal-incoherent-0001'),
  }));
  check('une ligne qui ne s’additionne pas ne devient JAMAIS une facture',
    Boolean(refusIncoherent));
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

/* ══════════════════════════════════════════════════════════════════════════ */
section('11. LA MATRICE DE DISPONIBILITÉ — cinq états, deux verdicts');
{
  /**
   * ── POURQUOI UNE MATRICE, ET PAS CINQ CONTRÔLES ÉPARS ────────────────────
   *
   * Les deux verdicts — facturer, signer — se ressemblent assez pour qu’on les
   * confonde, et diffèrent assez pour que les confondre bloque un client sans
   * raison. Les écrire côte à côte rend la différence LISIBLE : chaque ligne se
   * lit comme une phrase, et un futur lecteur voit d’un coup ce qui change.
   *
   * Le tableau est celui du cahier des charges du lot, repris tel quel.
   */
  const { describeClientCompanyReadiness } = readiness;

  const fiche = (surcharges = {}) => ({
    clientCompanyId: 'cc-matrice',
    status: 'ACTIVE',
    legalName: 'SARL MATRICE',
    siren: '732829320',
    billingEmail: 'facturation@matrice.test',
    registeredOffice: {
      line1: '1 rue du Contrôle', postalCode: '06000', city: 'Nice', country: 'FR',
    },
    billingAddress: null,
    contractualSigner: {
      firstName: 'Camille', lastName: 'Matrice', email: 'camille@matrice.test',
    },
    ...surcharges,
  });

  const CAS = [
    {
      nom: 'CAS 1 — aucune entreprise',
      entreprise: null,
      facturer: false, signer: false, etat: 'MISSING_COMPANY',
    },
    {
      nom: 'CAS 2 — entreprise facturable, AUCUN signataire',
      entreprise: fiche({ contractualSigner: null }),
      facturer: true, signer: false, etat: 'MISSING_SIGNER',
    },
    {
      nom: 'CAS 3 — signataire présent, facturation INCOMPLÈTE',
      entreprise: fiche({ siren: null }),
      facturer: false, signer: true, etat: 'MISSING_BILLING_IDENTITY',
    },
    {
      nom: 'CAS 4 — entreprise complète',
      entreprise: fiche(),
      facturer: true, signer: true, etat: 'READY',
    },
    {
      nom: 'CAS 5 — entreprise ARCHIVÉE',
      entreprise: fiche({ status: 'ARCHIVED' }),
      facturer: false, signer: false, etat: 'MISSING_COMPANY',
    },
  ];

  for (const cas of CAS) {
    const verdict = describeClientCompanyReadiness(cas.entreprise);
    check(`${cas.nom} → facturer ${cas.facturer ? 'AUTORISÉ' : 'BLOQUÉ'}`,
      verdict.billing.ready === cas.facturer);
    check(`${cas.nom} → signer ${cas.signer ? 'AUTORISÉ' : 'BLOQUÉ'}`,
      verdict.signing.ready === cas.signer);
    check(`${cas.nom} → état « ${cas.etat} »`, verdict.state === cas.etat);
  }

  /**
   * ── CE QUE LA MATRICE PROUVE EN CREUX ───────────────────────────────────
   *
   * Les cas 2 et 3 sont symétriques et OPPOSÉS. Un verdict unique les
   * rendrait identiques — « dossier incomplet » — et bloquerait dans les deux
   * cas les DEUX actes. C’est exactement la confusion que la séparation évite.
   */
  const sansSignataire = describeClientCompanyReadiness(fiche({ contractualSigner: null }));
  const sansSiren = describeClientCompanyReadiness(fiche({ siren: null }));
  check('les deux incomplétudes ne bloquent PAS le même acte',
    sansSignataire.billing.ready !== sansSiren.billing.ready
    && sansSignataire.signing.ready !== sansSiren.signing.ready);
  check('…et chacune NOMME ce qui lui manque',
    sansSignataire.signing.missing.length > 0 && sansSiren.billing.missing.length > 0);
  check('…sans jamais accuser l’autre acte',
    sansSignataire.billing.missing.length === 0 && sansSiren.signing.missing.length === 0);
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('12. LE SENS DE LA FLÈCHE — Stripe n’écrit JAMAIS l’identité légale');
{
  /**
   * ── L'INVARIANT QUE CETTE SECTION REND STRUCTUREL ─────────────────────────
   *
   *     PanelClientCompany  ──▶  Stripe Customer
   *
   * Jamais l'inverse. Le client Stripe est une PROJECTION de la fiche légale ;
   * en faire une source réécrirait la raison sociale, le SIREN ou l'adresse de
   * facturation d'après ce qu'un client aurait tapé dans un portail.
   *
   * Le portail vient d'être fermé en écriture sur ces champs (voir
   * `stripePortalAuthority.js`). Ce contrôle ferme l'autre moitié : même si
   * Stripe annonçait une modification, RIEN dans le Panel ne saurait
   * l'appliquer à la fiche.
   */
  const source = (rel) => fs.readFileSync(path.join(RACINE, rel), 'utf8');

  /**
   * `customer.updated` N'EST PAS SOUSCRIT — et c'est la garantie la plus forte.
   *
   * Une garde qui filtrerait l'événement pourrait être contournée par un ajout
   * distrait. Ne pas le recevoir du tout ne se contourne pas : il faudrait
   * l'ajouter à la souscription, ce que ce contrôle refuse.
   */
  const registreWebhooks = source('backend/src/services/webhooks/webhookRegistry.js');
  const evenements = /const STRIPE_EVENTS = Object\.freeze\(\[([\s\S]*?)\]\)/.exec(registreWebhooks)?.[1] ?? '';
  check('`customer.updated` n’est pas souscrit par le Panel',
    !/customer\.updated/.test(evenements));
  check('…et les trois événements d’abonnement le sont, eux',
    /customer\.subscription\.created/.test(evenements)
    && /customer\.subscription\.updated/.test(evenements)
    && /customer\.subscription\.deleted/.test(evenements));

  /**
   * AUCUN CHEMIN DE RÉCEPTION N'ÉCRIT LA FICHE.
   *
   * On balaie les modules qui traitent ce qui ARRIVE du fournisseur. Le seul
   * usage légitime de la fiche y serait une LECTURE — et il n'y en a aucune :
   * ces modules n'ont pas à la connaître.
   */
  const receptions = [
    'backend/src/services/webhooks/stripeEventRouting.js',
    'backend/src/services/webhooks/webhookIngest.js',
    'backend/src/services/webhooks/providerWebhookAdapters.js',
    'backend/src/services/finance/providerRevenue/revenueProjection.service.js',
    'backend/src/services/finance/providerRevenue/stripeRevenueNormalizer.js',
    'backend/src/services/finance/providerRevenue/providerSettlement.service.js',
  ];
  const ecrivains = receptions.filter((rel) => {
    const contenu = source(rel);
    return /PanelClientCompany|clientCompany\.service|updateClientCompany/.test(contenu);
  });
  check(`aucun chemin de réception Stripe n’atteint la fiche cliente${ecrivains.length ? ` — ${ecrivains.join(', ')}` : ''}`,
    ecrivains.length === 0);

  /**
   * LE PORTAIL LUI-MÊME REFUSE L'ÉDITION — au niveau de la configuration.
   *
   * C'est la moitié amont : Stripe n'annoncera même pas la modification, parce
   * que l'écran ne la proposera pas.
   */
  const autorite = await import('../backend/src/services/integratedApi/stripe/stripePortalAuthority.js');
  const cible = autorite.portalConfigurationParams();
  check('le portail n’autorise AUCUNE modification de l’identité client',
    cible.features.customer_update.enabled === false
    && cible.features.customer_update.allowed_updates.length === 0);
  check('…ni aucun changement d’offre', cible.features.subscription_update.enabled === false);
  check('…mais bien le moyen de paiement', cible.features.payment_method_update.enabled === true);
  check('…et la résiliation, à l’échéance',
    cible.features.subscription_cancel.enabled === true
    && cible.features.subscription_cancel.mode === 'at_period_end');

  /**
   * UNE CONFIGURATION QUI AUTORISERAIT L'ÉDITION EST DÉTECTÉE COMME UNE DÉRIVE.
   *
   * C'est ce qui rend la garantie DURABLE : un réglage repris à la main dans le
   * tableau de bord ne reste pas en place, et le motif nomme le champ ouvert.
   */
  const derive = autorite.portalConfigurationDrift({
    features: {
      customer_update: { enabled: true, allowed_updates: ['name', 'address'] },
      payment_method_update: { enabled: true },
      invoice_history: { enabled: true },
      subscription_cancel: { enabled: true, mode: 'at_period_end' },
      subscription_update: { enabled: false },
    },
  });
  check('une configuration qui rouvre l’identité légale est signalée', derive.length === 1);
  check('…et le motif NOMME les champs ouverts',
    /customer_update/.test(derive[0]) && /name, address/.test(derive[0]));

  const conforme = autorite.portalConfigurationDrift({
    features: {
      customer_update: { enabled: false, allowed_updates: [] },
      payment_method_update: { enabled: true },
      invoice_history: { enabled: true },
      subscription_cancel: { enabled: true, mode: 'at_period_end' },
      subscription_update: { enabled: false },
    },
  });
  check('la cible, elle, ne dérive de rien', conforme.length === 0);

  /**
   * UNE RÉSILIATION IMMÉDIATE PAR DÉFAUT EST AUSSI UNE DÉRIVE.
   *
   * Elle retirerait un service déjà payé et poserait la question du prorata —
   * une décision commerciale qu'aucun clic de portail ne doit prendre.
   */
  const immediate = autorite.portalConfigurationDrift({
    features: {
      customer_update: { enabled: false, allowed_updates: [] },
      payment_method_update: { enabled: true },
      invoice_history: { enabled: true },
      subscription_cancel: { enabled: true, mode: 'immediately' },
      subscription_update: { enabled: false },
    },
  });
  check('un mode de résiliation IMMÉDIAT est signalé', immediate.length === 1);
  check('…en disant que la période en cours est payée', /payée/.test(immediate[0]));
}

await close();
await fsp.rm(DOSSIER_PRIVE, { recursive: true, force: true });
await stopMemoryMongo();
finish();
