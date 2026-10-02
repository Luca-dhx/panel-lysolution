// STRIPE — paiement des COMMISSIONS d'un projet (billing.checkout.create, type COMMISSION).
//
// Ce que cette suite prouve :
//
//   SCHÉMA       un paiement de commissions porte ses lignes, et seul lui
//   CALCUL       chaque ligne vaut base × taux, sinon refus ; total = somme des lignes
//   PLAFONDS     taux ≤ 50 %, doublons de vente refusés
//   CONTRAT      la garde d'appartenance du contrat s'applique comme aux autres types
//   FACTURE      une ligne par vente, TVA du contrat, facture émise après paiement,
//                metadata qui disent au projet quelle commission est soldée
//
// Aucun réseau ni base : les lectures (entreprise cliente, contrat) sont injectées.
import { check, finish, section, setTestEnv } from './helpers/harness.js';

setTestEnv();

const capabilities = await import('../backend/src/services/integratedApi/stripe/stripeCapabilities.js');
const authority = await import('../backend/src/services/integratedApi/stripe/stripeCheckoutAuthority.js');

const schema = capabilities.STRIPE_CAPABILITIES['billing.checkout.create']?.inputSchema;

const entree = (over = {}) => ({
  paymentType: 'COMMISSION',
  contractRef: 'ct-a',
  successUrl: 'https://manager.test/commerce/commissions?paiement=retour',
  cancelUrl: 'https://manager.test/commerce/commissions?paiement=annule',
  operationId: 'commission-checkout-0123456789abcdef',
  commission: {
    commissionRef: 'cm-2026-09',
    periodKey: '2026-09',
    ratePercent: 10,
    lines: [
      { saleRef: 's1', saleNumber: 'BS-001', basisCents: 12000, amountCents: 1200 },
      { saleRef: 's2', saleNumber: 'BS-002', basisCents: 4999, amountCents: 500 },
    ],
  },
  ...over,
});

const lookups = {
  lookupClientCompany: async () => ({ billing: { ready: true, missing: [] }, state: 'READY' }),
  lookupContract: async () => ({ sourceContractId: 'ct-a', reference: 'CTR-2026-0001', taxRate: 20 }),
};
const resoudre = (input) => authority.resolveCheckoutIntent({ projectId: 'p1', environment: 'TEST', input, ...lookups });
const refuse = async (fn) => { try { await fn(); return null; } catch (e) { return e; } };

section('SCHÉMA');
{
  check('le schéma de billing.checkout.create est trouvé', Boolean(schema?.safeParse));
  check('paiement de commissions valide accepté', schema.safeParse(entree()).success);
  check('COMMISSION sans lignes → refusé', !schema.safeParse(entree({ commission: undefined })).success);
  check('lignes sur un autre type → refusées', !schema.safeParse(entree({ paymentType: 'LAUNCH_FEE' })).success);
  check('taux > 50 % → refusé', !schema.safeParse(entree({ commission: { ...entree().commission, ratePercent: 60 } })).success);
  check('clé inconnue dans une ligne → refusée', !schema.safeParse(entree({ commission: { ...entree().commission, lines: [{ saleRef: 's', saleNumber: 'n', basisCents: 1, amountCents: 1, total: 9 }] } })).success);
  check('période mal formée → refusée', !schema.safeParse(entree({ commission: { ...entree().commission, periodKey: 'sept' } })).success);
}

section('CALCUL ET PLAFONDS');
{
  const intention = await resoudre(entree());
  check('intention résolue', Boolean(intention));
  check('le total est la somme des lignes vérifiées (1 700 c HT)', intention.fiscal.netCents === 1700);
  check('…et la TVA du contrat s’y applique (2 040 c TTC)', intention.amountIncludingTax === 2040);
  check('le taux de TVA vient du contrat', intention.fiscal.taxRate === 20);

  const faux = await refuse(() => resoudre(entree({ commission: { ...entree().commission, lines: [{ saleRef: 's1', saleNumber: 'BS-001', basisCents: 12000, amountCents: 120 }] } })));
  check('montant qui ne vaut pas base × taux → refus COMMISSION_INVALID', faux?.reason === 'COMMISSION_INVALID');
  check('…le message nomme la vente', /BS-001/.test(faux?.message ?? ''));

  const arrondi = await resoudre(entree({ commission: { ...entree().commission, lines: [{ saleRef: 's3', saleNumber: 'BS-003', basisCents: 4995, amountCents: 499 }] } }));
  check('un centime d’arrondi est toléré', Boolean(arrondi));

  const mixte = await resoudre(entree({ commission: { ...entree().commission, lines: [
    { saleRef: 's1', saleNumber: 'BS-001', basisCents: 10000, amountCents: 1000 },
    { saleRef: 's2', saleNumber: 'BS-002', basisCents: 10000, amountCents: 1500, ratePercent: 15 },
  ] } }));
  check('taux propre à une ligne (règle changée en cours de mois) accepté', mixte?.fiscal.netCents === 2500);
  const mixteFaux = await refuse(() => resoudre(entree({ commission: { ...entree().commission, lines: [
    { saleRef: 's2', saleNumber: 'BS-002', basisCents: 10000, amountCents: 1500 },
  ] } })));
  check('…mais sans son taux, la même ligne est refusée', mixteFaux?.reason === 'COMMISSION_INVALID');
  check('taux de ligne > 50 % → refusé par le schéma', !schema.safeParse(entree({ commission: { ...entree().commission, lines: [{ saleRef: 's', saleNumber: 'n', basisCents: 100, amountCents: 60, ratePercent: 60 }] } })).success);

  const doublon = await refuse(() => resoudre(entree({ commission: { ...entree().commission, lines: [entree().commission.lines[0], entree().commission.lines[0]] } })));
  check('même vente deux fois → refus', doublon?.reason === 'COMMISSION_INVALID');
}

section('CONTRAT');
{
  const autre = await refuse(() => resoudre(entree({ contractRef: 'ct-autre' })));
  check('contrat d’un autre → refus CONTRACT_NOT_OWNED', autre?.reason === 'CONTRACT_NOT_OWNED');
  const sansTva = await refuse(() => authority.resolveCheckoutIntent({
    projectId: 'p1', environment: 'TEST', input: entree(),
    lookupClientCompany: lookups.lookupClientCompany,
    lookupContract: async () => ({ sourceContractId: 'ct-a', reference: 'CTR', taxRate: null }),
  }));
  check('contrat sans TVA exploitable → refus explicite', sansTva?.reason === 'COMMISSION_INVALID');
}

section('FACTURE');
{
  const intention = await resoudre(entree());
  const params = intention.paramsFor({ taxRateId: 'txr_test' });
  check('paiement unique (mode payment)', params.mode === 'payment');
  check('une ligne Stripe par vente', params.line_items.length === 2);
  check('…nommée avec le numéro de vente', params.line_items[0].price_data.product_data.name === 'Commission vente BS-001');
  check('…montant hors taxe de la commission', params.line_items[1].price_data.unit_amount === 500);
  check('…TVA exclusive du contrat', params.line_items[0].tax_rates[0] === 'txr_test');
  check('facture émise après paiement (invoice_creation)', params.invoice_creation?.enabled === true);
  check('metadata : type COMMISSION', params.metadata.paymentType === 'COMMISSION');
  check('metadata : la commission soldée et sa période', params.metadata.commissionId === 'cm-2026-09' && params.metadata.periodKey === '2026-09');
  check('…recopiées sur la facture', params.invoice_creation.invoice_data.metadata.commissionId === 'cm-2026-09');
  check('…et sur le paiement', params.payment_intent_data.metadata.commissionId === 'cm-2026-09');
  check('la facture porte la période en tête', params.invoice_creation.invoice_data.custom_fields.some((f) => f.name === 'Période' && f.value === '2026-09'));
}

finish();
