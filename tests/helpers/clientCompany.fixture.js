// UNE ENTREPRISE CLIENTE DE TEST — complète, cohérente, et RATTACHÉE.
//
// ══ POURQUOI CE FICHIER EXISTE ══════════════════════════════════════════════
//
// Depuis le chantier « entreprise cliente », AUCUN paiement et AUCUNE signature
// ne peuvent être ouverts pour un projet sans identité légale de client. C'est
// la garde centrale du lot, et elle est autoritative côté backend.
//
// Conséquence pour les recettes automatisées : tout test qui ouvre un paiement
// doit d'abord rattacher une entreprise. Recopier cette préparation dans chaque
// fichier aurait produit huit variantes, dont deux auraient fini incomplètes —
// et leur échec aurait ressemblé à une régression du paiement plutôt qu'à un
// oubli de fixture.
//
// ══ LES VALEURS SONT COHÉRENTES, ET C'EST NÉCESSAIRE ════════════════════════
//
// La validation vérifie que le SIRET commence par le SIREN et que le numéro de
// TVA français se termine par lui. Des valeurs prises au hasard seraient
// REFUSÉES — ce qui est le comportement voulu, mais rendrait la fixture
// inutilisable. Celles-ci sont construites pour passer, et la clé de Luhn du
// SIREN est vérifiée par le test dédié.
//
// Rien ici ne désigne une entreprise réelle : `SIREN` et `SIRET` sont des
// valeurs de test, et le nom porte la mention « RECETTE ».
import PanelClientCompany from '../../backend/src/models/PanelClientCompany.model.js';
import PanelProject from '../../backend/src/models/PanelProject.model.js';

/**
 * UN SIREN DE TEST QUI SATISFAIT LUHN.
 *
 * `732829320` est le SIREN de démonstration utilisé par la documentation
 * publique de l'INSEE pour illustrer la clé de contrôle. Il n'identifie aucune
 * entreprise dans ce parc, et il passe la validation — c'est exactement ce
 * qu'on attend d'une valeur de fixture.
 */
export const SIREN_TEST = '732829320';
/** Même SIREN + un NIC dont la somme de Luhn tombe juste sur 14 chiffres. */
export const SIRET_TEST = '73282932000074';
export const TVA_TEST = 'FR44732829320';

/**
 * Crée une entreprise cliente COMPLÈTE et la rattache à un projet.
 *
 * @param {object} args
 * @param {string} args.projectId        le projet à rattacher
 * @param {string} [args.legalName]
 * @param {boolean} [args.withSigner]    faux pour éprouver le refus de signature
 * @param {boolean} [args.withBilling]   faux pour éprouver le refus de paiement
 * @returns {Promise<object>} la fiche créée (document brut)
 */
export async function seedClientCompany({
  projectId,
  legalName = 'SARL RECETTE AUTOMOBILE',
  withSigner = true,
  withBilling = true,
  environment = 'TEST',
} = {}) {
  const at = new Date().toISOString();
  const fiche = await PanelClientCompany.create({
    clientCompanyId: `cc-test-${Math.random().toString(36).slice(2, 12)}`,
    legalName,
    tradingName: 'Recette Auto',
    legalForm: 'SARL',
    siren: withBilling ? SIREN_TEST : null,
    siret: withBilling ? SIRET_TEST : null,
    vatNumber: withBilling ? TVA_TEST : null,
    registrationCity: 'Nice',
    registeredOffice: {
      line1: '12 avenue de la Recette',
      line2: null,
      postalCode: '06000',
      city: 'Nice',
      country: 'FR',
    },
    billingAddress: null,
    billingEmail: withBilling ? 'facturation@recette.test' : null,
    phone: '+33 4 00 00 00 00',
    website: null,
    administrativeContact: { name: null, email: null, phone: null },
    contractualSigner: withSigner
      ? {
        firstName: 'Camille',
        lastName: 'Recette',
        jobTitle: 'Gérante',
        email: 'camille.recette@recette.test',
        phone: '',
      }
      : null,
    documents: [],
    status: 'ACTIVE',
    notes: null,
    environment,
    publishedVersion: 1,
    publishedAt: at,
    createdAt: at,
    updatedAt: at,
    createdBy: 'fixture',
    updatedBy: 'fixture',
  });

  if (projectId) {
    await PanelProject.updateOne(
      { projectId },
      { $set: { clientCompanyId: fiche.clientCompanyId } },
    );
  }
  return fiche.toObject();
}

/**
 * GARANTIT qu'un projet a une entreprise cliente — sans en créer deux.
 *
 * Les recettes sèment souvent plusieurs contrats successifs pour un même
 * projet (résiliation puis nouvel engagement). Appeler `seedClientCompany` à
 * chaque fois créerait autant de fiches, dont une seule serait rattachée : le
 * test passerait, et la base de recette porterait des orphelines qui
 * fausseraient tout comptage.
 */
export async function ensureClientCompany(projectId, options = {}) {
  const projet = await PanelProject.findOne({ projectId }).select('clientCompanyId').lean();
  if (projet?.clientCompanyId) {
    return PanelClientCompany.findOne({ clientCompanyId: projet.clientCompanyId }).lean();
  }
  return seedClientCompany({ projectId, ...options });
}

/**
 * LA VENTILATION FISCALE D'UNE LIGNE DE FIXTURE — cohérente par construction.
 *
 * ══ POURQUOI ELLE EST CALCULÉE ET NON ÉCRITE À LA MAIN ══════════════════════
 *
 * Le Panel REFUSE une ligne dont `HT + TVA ≠ TTC` ou dont la TVA ne correspond
 * pas au taux annoncé. Des nombres saisis à la main dans huit fixtures
 * finiraient par en violer une, et le test échouerait sur la garde plutôt que
 * sur ce qu'il éprouve.
 *
 * On part du TTC — c'est ce que les fixtures historiques portent — et l'on
 * retrouve le HT par la même formule que le projet : `HT = TTC - TVA`, avec
 * `TVA = round(HT × taux)`. La recherche est directe : `HT = round(TTC × 100 /
 * (100 + taux))`, puis l'on VÉRIFIE, et l'on ajuste d'un centime si l'arrondi
 * inverse ne retombe pas — ce qui arrive pour certains montants.
 */
export function ventilationDepuisTTC(grossCents, taxRate = 20) {
  let net = Math.round((grossCents * 100) / (100 + taxRate));
  for (let essai = 0; essai < 3; essai += 1) {
    const tax = Math.round((net * taxRate) / 100);
    if (net + tax === grossCents) return { net, tax, taxRate };
    net += net + tax > grossCents ? -1 : 1;
  }
  throw new Error(`Ventilation introuvable pour ${grossCents} à ${taxRate} %.`);
}

/** Une ligne tarifaire complète, prête pour une projection de contrat. */
export function ligneTarifaire(grossCents, { taxRate = 20, currency = 'EUR', ...extra } = {}) {
  const { net, tax } = ventilationDepuisTTC(grossCents, taxRate);
  return {
    amountIncludingTax: grossCents,
    amountExcludingTax: net,
    taxAmount: tax,
    taxRate,
    currency,
    ...extra,
  };
}

export default {
  seedClientCompany,
  ensureClientCompany,
  ligneTarifaire,
  ventilationDepuisTTC,
  SIREN_TEST,
  SIRET_TEST,
  TVA_TEST,
};
