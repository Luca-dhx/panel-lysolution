// Catalogue officiel des capacités — code-first, la référence de
// docs/architecture/21_PROJECT_CAPABILITIES.md §2.
// Évolution ADDITIVE uniquement : on ajoute, on ne renomme ni ne supprime.
// `panelModules` : modules d'interface du Panel que la capacité activera
// (Phase 3+) — vide pour les domaines de catégorie 1, jamais administrés ici.
export const CAPABILITIES_CATALOG = Object.freeze({
  supportsCompany: { label: 'Entreprise cliente', panelModules: [] },
  supportsServices: { label: 'Services & prestations', panelModules: [] },
  supportsBookings: { label: 'Réservations', panelModules: [] },
  supportsGallery: { label: 'Galerie / avant-après / avis', panelModules: [] },
  supportsContracts: { label: 'Contrats', panelModules: ['contracts'] },
  supportsInvoices: { label: 'Factures', panelModules: ['invoices'] },
  supportsPayments: { label: 'Paiements / mensualités', panelModules: ['payments'] },
  supportsStripe: { label: 'IntegratedAPI Stripe', panelModules: ['integrated-api'] },
  supportsBrevo: { label: 'IntegratedAPI Brevo', panelModules: ['integrated-api'] },
  supportsYousign: { label: 'IntegratedAPI Yousign', panelModules: ['integrated-api'] },
  supportsCRM: { label: 'CRM', panelModules: ['crm'] },
});

export const KNOWN_CAPABILITIES = Object.freeze(Object.keys(CAPABILITIES_CATALOG));

export default CAPABILITIES_CATALOG;
