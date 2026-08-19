/**
 * L10.7 — L'APPARTENANCE D'UN REVENU SE RÉSOUT SUR LE GRAPHE INTERNE.
 *
 * ══ LE DÉFAUT QUE CETTE SUITE VERROUILLE ════════════════════════════════════
 *
 * Un paiement TEST réellement encaissé pour une prestation ponctuelle produisait
 * un `PanelProviderRevenueFact` en `UNOWNED / NO_OWNERSHIP_RESOURCE`, donc
 * aucune transaction au registre financier — alors que le Panel possédait la
 * session qui avait produit ce paiement.
 *
 * Cause : la résolution ne consultait qu'UNE ressource, retenue sur la charge
 * utile. Stripe a retiré `invoice.payment_intent` à plat (>= 2025-04-30.basil),
 * et une prestation ponctuelle n'a par nature aucun abonnement. Les deux seules
 * filiations tombaient ensemble.
 *
 * ══ CE QUE CES CONTRÔLES PROUVENT ═══════════════════════════════════════════
 *
 *   · qu'une facture de forme MODERNE (règlements sous `payments.data[]`)
 *     retrouve son intention de paiement ;
 *   · qu'une session possédée fasse ADOPTER la facture qu'elle désigne ;
 *   · que les quatre ordres d'arrivée réalistes convergent vers le MÊME
 *     résultat — un revenu, une transaction ;
 *   · qu'un fait classé `UNOWNED` redevienne projetable quand la preuve
 *     arrive plus tard (réconciliation, sans intervention humaine) ;
 *   · que l'absence de preuve reste `UNOWNED` — le correctif ne fabrique
 *     JAMAIS un propriétaire ;
 *   · que le CLIENT ne soit jamais une preuve d'appartenance ;
 *   · que l'idempotence tienne sous rejeu, quel que soit l'ordre.
 */
import {
  check,
  connectTestDatabase,
  finish,
  section,
  setTestEnv,
  startMemoryMongo,
  stopMemoryMongo,
} from './helpers/harness.js';

setTestEnv();
await startMemoryMongo();
await connectTestDatabase();

const PanelProject = (await import('../backend/src/models/PanelProject.model.js')).default;
const PanelProviderRevenueFact = (await import('../backend/src/models/PanelProviderRevenueFact.model.js')).default;
const { PanelFinancialTransaction } = await import('../backend/src/models/PanelFinancialTransaction.model.js');
const normalizer = await import('../backend/src/services/finance/providerRevenue/stripeRevenueNormalizer.js');
const projection = await import('../backend/src/services/finance/providerRevenue/revenueProjection.service.js');
const ownership = await import('../backend/src/services/finance/providerRevenue/stripeRevenueOwnership.js');
const bindings = await import('../backend/src/services/integratedApi/stripe/stripeResourceBinding.js');

await PanelProviderRevenueFact.init();
await PanelFinancialTransaction.init();

const PROJET = 'atelier-nord';
const AUTRE = 'atelier-sud';
for (const [id, nom] of [[PROJET, 'Atelier du Nord'], [AUTRE, 'Atelier du Sud']]) {
  const now = new Date().toISOString();
  // eslint-disable-next-line no-await-in-loop
  await PanelProject.create({
    projectId: id, projectKey: id, projectName: nom,
    createdAt: now, updatedAt: now, pairing: { status: 'PAIRED' }, runtime: { environment: 'TEST' },
  });
}

const S = (iso) => Math.floor(new Date(iso).getTime() / 1000);
const evt = (type, objet, id = null) => ({
  id: id ?? `evt_${Math.random().toString(36).slice(2, 12)}`,
  type,
  created: S('2026-08-19T10:00:00Z'),
  data: { object: objet },
});

const lier = (projectId, resourceType, resourceId) => bindings.bindResource({
  projectId, environment: 'TEST', resourceType, resourceId, source: 'PANEL_CREATED',
});

const recevoir = (type, objet, eventId) => projection.recordStripeRevenueEvent({
  environment: 'TEST', eventType: type, payload: evt(type, objet, eventId),
  providerEventId: eventId ?? `evt_${type}_${objet.id}`,
});

/**
 * LA FACTURE DE FORME MODERNE — celle qui a produit le défaut.
 *
 * Aucun `subscription` (prestation ponctuelle), aucun `payment_intent` à plat
 * (Stripe l'a retiré). L'intention n'existe plus que sous `payments.data[]`.
 */
const factureModerne = (suffixe, overrides = {}) => ({
  id: `in_${suffixe}`,
  object: 'invoice',
  amount_due: 4900, amount_paid: 4900, total: 4900, currency: 'eur',
  number: `FA-2026-${suffixe}`, status: 'paid',
  customer: `cus_${suffixe}`,
  payments: { data: [{ payment: { type: 'payment_intent', payment_intent: `pi_${suffixe}` } }] },
  hosted_invoice_url: 'https://invoice.stripe.com/i/acct_x/test',
  invoice_pdf: 'https://pay.stripe.com/invoice/acct_x/test/pdf',
  created: S('2026-08-19T09:59:00Z'),
  status_transitions: { paid_at: S('2026-08-19T10:00:00Z') },
  lines: { data: [{ description: 'Prestation ponctuelle' }] },
  livemode: false,
  metadata: { panelProjectId: PROJET },
  ...overrides,
});

const sessionPrestation = (suffixe, overrides = {}) => ({
  id: `cs_${suffixe}`,
  object: 'checkout.session', mode: 'payment', payment_status: 'paid',
  amount_total: 4900, currency: 'eur', created: S('2026-08-19T09:58:00Z'),
  customer: `cus_${suffixe}`, payment_intent: `pi_${suffixe}`, invoice: `in_${suffixe}`,
  subscription: null, livemode: false,
  metadata: { panelProjectId: PROJET },
  ...overrides,
});

const faitDe = (objectId) => PanelProviderRevenueFact.findOne({ objectId }).lean();
const txDe = (externalId) => PanelFinancialTransaction.countDocuments({ 'provenance.externalId': externalId });

/* ══════════════════════════════════════════════════════════════════════════ */
section('1. Le normalisateur retrouve l’intention là où Stripe la range MAINTENANT');
{
  const { paymentIntentIdOfInvoice } = normalizer;

  check('forme historique — `payment_intent` à plat',
    paymentIntentIdOfInvoice({ payment_intent: 'pi_plat' }) === 'pi_plat');

  check('forme MODERNE — sous `payments.data[].payment.payment_intent`',
    paymentIntentIdOfInvoice({
      payments: { data: [{ payment: { payment_intent: 'pi_moderne' } }] },
    }) === 'pi_moderne');

  check('le champ à plat garde la priorité quand les deux existent',
    paymentIntentIdOfInvoice({
      payment_intent: 'pi_plat',
      payments: { data: [{ payment: { payment_intent: 'pi_moderne' } }] },
    }) === 'pi_plat');

  check('une facture qui n’en porte AUCUNE rend `null` — jamais une invention',
    paymentIntentIdOfInvoice({ id: 'in_x', customer: 'cus_x' }) === null);

  const { fact } = normalizer.normalizeStripeRevenueEvent({
    eventType: 'invoice.paid',
    payload: evt('invoice.paid', factureModerne('n1')),
    environment: 'TEST',
  });
  check('…et la facture moderne désigne donc bien une ressource porteuse',
    fact?.ownershipVia?.resourceType === 'PAYMENT_INTENT'
    && fact.ownershipVia.resourceId === 'pi_n1');
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('2. Le résolveur : ce qui est une preuve, et ce qui n’en est pas une');
{
  const candidats = ownership.ownershipCandidates({
    objectType: 'INVOICE', objectId: 'in_c1', environment: 'TEST',
    ownershipResourceType: 'PAYMENT_INTENT', ownershipResourceId: 'pi_c1',
    corroboration: {
      subscriptionId: 'sub_c1', paymentIntentId: 'pi_c1',
      checkoutSessionId: 'cs_c1', customerId: 'cus_c1',
    },
  });
  const types = candidats.map((c) => c.resourceType);

  check('la ressource désignée par le normalisateur passe en PREMIER',
    types[0] === 'PAYMENT_INTENT' && candidats[0].resourceId === 'pi_c1');
  check('l’objet canonique lui-même est candidat', types.includes('INVOICE'));
  check('l’abonnement est candidat', types.includes('SUBSCRIPTION'));
  check('la session est candidate', types.includes('CHECKOUT_SESSION'));
  check('le CLIENT n’est JAMAIS candidat — un client n’est pas un paiement',
    !types.includes('CUSTOMER'));
  check('aucun doublon dans la liste de candidats',
    new Set(candidats.map((c) => `${c.resourceType}:${c.resourceId}`)).size === candidats.length);

  const aucun = ownership.ownershipCandidates({
    objectType: 'INVOICE', objectId: 'in_vide', corroboration: {},
  });
  check('une facture sans aucune identité corrélable ne propose qu’elle-même',
    aucun.length === 1 && aucun[0].resourceType === 'INVOICE');
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('3. ORDRE A — la session arrive AVANT sa facture');
{
  await lier(PROJET, 'CHECKOUT_SESSION', 'cs_a1');

  await recevoir('checkout.session.completed', sessionPrestation('a1'), 'evt_cs_a1');
  const lienFacture = await bindings.findBinding({
    environment: 'TEST', resourceType: 'INVOICE', resourceId: 'in_a1',
  });
  check('la session possédée fait ADOPTER la facture qu’elle désigne',
    lienFacture?.projectId === PROJET
    && lienFacture.source === 'LEARNED_FROM_WEBHOOK'
    && lienFacture.proof?.derivedFromResourceId === 'cs_a1');

  const r = await recevoir('invoice.paid', factureModerne('a1'), 'evt_in_a1');
  check('la facture est projetée immédiatement', r.status === 'PROJECTED');

  const fait = await faitDe('in_a1');
  check('le fait est OWNED sur le bon projet',
    fait.ownership === 'OWNED' && fait.projectId === PROJET);
  check('…et une transaction existe', (await txDe('in_a1')) === 1);
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('4. ORDRE B — la facture arrive AVANT sa session (le cas du défaut)');
{
  await lier(PROJET, 'CHECKOUT_SESSION', 'cs_b1');

  const r1 = await recevoir('invoice.paid', factureModerne('b1'), 'evt_in_b1');
  check('sans preuve encore disponible, le fait est RETENU — jamais perdu',
    r1.status === 'PENDING' && r1.reason === 'NO_BINDING');
  check('…et rien n’est écrit au registre', (await txDe('in_b1')) === 0);

  await recevoir('checkout.session.completed', sessionPrestation('b1'), 'evt_cs_b1');

  const fait = await faitDe('in_b1');
  check('l’arrivée de la session PROJETTE le revenu retenu',
    fait.projectionStatus === 'PROJECTED' && fait.projectId === PROJET);
  check('…et une seule transaction existe', (await txDe('in_b1')) === 1);
  check('le fait porte la ressource par laquelle la preuve a été faite',
    Boolean(fait.ownershipResourceType) && Boolean(fait.ownershipResourceId));
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('5. ORDRE C — `payment_intent.succeeded` intercalé ne change rien');
{
  await lier(PROJET, 'CHECKOUT_SESSION', 'cs_c2');

  await recevoir('payment_intent.succeeded', { id: 'pi_c2', object: 'payment_intent' }, 'evt_pi_c2');
  await recevoir('invoice.paid', factureModerne('c2'), 'evt_in_c2');
  await recevoir('checkout.session.completed', sessionPrestation('c2'), 'evt_cs_c2');
  await recevoir('payment_intent.succeeded', { id: 'pi_c2', object: 'payment_intent' }, 'evt_pi_c2b');

  const fait = await faitDe('in_c2');
  check('le revenu est projeté une fois la preuve arrivée',
    fait.projectionStatus === 'PROJECTED' && fait.projectId === PROJET);
  check('UNE seule transaction malgré quatre annonces', (await txDe('in_c2')) === 1);
  check('aucun fait n’a été créé pour l’intention corroborative',
    (await PanelProviderRevenueFact.countDocuments({ objectId: 'pi_c2' })) === 0);
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('5 bis. LA CHARGE UTILE RÉELLE — celle que Stripe envoie vraiment');
{
  /**
   * ══ RELEVÉ SUR LE COMPTE TEST, API `2026-06-24.dahlia` ═══════════════════
   *
   * Un `invoice.paid` produit par une session `mode: payment` +
   * `invoice_creation` ne porte AUCUNE identité corrélable :
   *
   *     subscription    champ ABSENT
   *     payment_intent  champ ABSENT
   *     charge          champ ABSENT
   *     payments        champ ABSENT
   *     parent          null
   *     metadata        {}
   *
   * Lire un emplacement de plus sur la facture ne sauve donc RIEN : il n'y a
   * rien à y lire. C'est la raison pour laquelle la correction ne pouvait pas
   * être un champ de repli, et devait être le graphe interne.
   *
   * Le `checkout.session.completed`, lui, porte `invoice` ET `payment_intent` :
   * c'est le SEUL endroit où les deux identités se rencontrent, et donc le seul
   * instant où l'appartenance peut être transmise.
   */
  const factureNue = {
    id: 'in_reel', object: 'invoice',
    amount_due: 100, amount_paid: 100, total: 100, currency: 'eur',
    number: 'FA-REEL-0001', status: 'paid',
    customer: 'cus_reel',
    parent: null,
    metadata: {},
    hosted_invoice_url: 'https://invoice.stripe.com/i/acct_x/reel',
    invoice_pdf: 'https://pay.stripe.com/invoice/acct_x/reel/pdf',
    created: S('2026-08-19T11:20:42Z'),
    status_transitions: { paid_at: S('2026-08-19T11:20:42Z') },
    lines: { data: [{ description: 'Sonde mecanique' }] },
    livemode: false,
  };

  const { fact } = normalizer.normalizeStripeRevenueEvent({
    eventType: 'invoice.paid',
    payload: evt('invoice.paid', factureNue),
    environment: 'TEST',
  });
  check('la facture réelle ne désigne AUCUNE ressource porteuse',
    fact?.ownershipVia === null);
  check('…et aucune intention n’est corroborée non plus',
    fact?.corroboration?.paymentIntentId === null);

  /** Arrivée SEULE, elle est donc sans appartenance prouvable. */
  const r1 = await recevoir('invoice.paid', factureNue, 'evt_in_reel');
  check('seule, elle part en UNOWNED — c’est le défaut, à l’identique',
    r1.status === 'UNOWNED' && r1.reason === 'NO_OWNERSHIP_RESOURCE');
  check('…et rien n’est écrit au registre', (await txDe('in_reel')) === 0);

  /**
   * LA SESSION ARRIVE — possédée par le Panel depuis sa création (L6.2B).
   * Charge utile réelle : elle porte `invoice` et `payment_intent`.
   */
  await lier(PROJET, 'CHECKOUT_SESSION', 'cs_reel');
  const sessionReelle = {
    id: 'cs_reel', object: 'checkout.session', mode: 'payment',
    payment_status: 'paid', amount_total: 100, currency: 'eur',
    created: S('2026-08-19T11:20:39Z'),
    customer: 'cus_reel',
    payment_intent: 'pi_reel',
    invoice: 'in_reel',
    subscription: null, livemode: false, metadata: {},
  };
  await recevoir('checkout.session.completed', sessionReelle, 'evt_cs_reel');

  const lienFacture = await bindings.findBinding({
    environment: 'TEST', resourceType: 'INVOICE', resourceId: 'in_reel',
  });
  check('la session fait ADOPTER la facture — le seul chaînon possible',
    lienFacture?.projectId === PROJET);

  const apres = await faitDe('in_reel');
  check('le revenu UNOWNED est repris et PROJETÉ',
    apres.projectionStatus === 'PROJECTED' && apres.projectId === PROJET);
  check('…et exactement une transaction existe', (await txDe('in_reel')) === 1);
  check('la preuve est tracée sur le fait',
    apres.ownershipResourceType === 'INVOICE' && apres.ownershipResourceId === 'in_reel');
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('6. IDEMPOTENCE — rejouer les trois événements dans le désordre');
{
  await lier(PROJET, 'CHECKOUT_SESSION', 'cs_d1');

  const rejeu = [
    () => recevoir('invoice.paid', factureModerne('d1'), 'evt_in_d1'),
    () => recevoir('checkout.session.completed', sessionPrestation('d1'), 'evt_cs_d1'),
    () => recevoir('payment_intent.succeeded', { id: 'pi_d1', object: 'payment_intent' }, 'evt_pi_d1'),
  ];
  // Trois passes complètes, dans trois ordres différents.
  for (const ordre of [[0, 1, 2], [2, 0, 1], [1, 2, 0]]) {
    for (const i of ordre) {
      // eslint-disable-next-line no-await-in-loop
      await rejeu[i]();
    }
  }

  check('UN seul fait logique', (await PanelProviderRevenueFact.countDocuments({ objectId: 'in_d1' })) === 1);
  check('UNE seule transaction financière', (await txDe('in_d1')) === 1);
  const fait = await faitDe('in_d1');
  check('le montant n’a pas bougé au rejeu', fait.amountCents === 4900);
  check('le statut final est PROJECTED', fait.projectionStatus === 'PROJECTED');
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('7. RÉCONCILIATION TARDIVE — un `UNOWNED` n’est plus un état terminal');
{
  /**
   * Une facture SANS aucune identité corrélable : ni abonnement, ni intention
   * (nulle part), ni session. Elle part donc en `UNOWNED / NO_OWNERSHIP_RESOURCE`
   * — c'est le verdict correct au moment où elle arrive.
   */
  const orpheline = factureModerne('e1', { payments: { data: [] }, customer: 'cus_e1' });
  const r1 = await recevoir('invoice.paid', orpheline, 'evt_in_e1');
  check('sans aucune ressource corrélable, le fait est UNOWNED',
    r1.status === 'UNOWNED' && r1.reason === 'NO_OWNERSHIP_RESOURCE');

  /**
   * La preuve arrive PLUS TARD, par un second événement qui, lui, porte
   * l'intention. L'enrichissement du fait la conserve.
   */
  await lier(PROJET, 'PAYMENT_INTENT', 'pi_e1');
  await recevoir('invoice.paid', factureModerne('e1'), 'evt_in_e1_bis');

  const apres = await faitDe('in_e1');
  check('la convergence générale reprend le fait et le PROJETTE',
    apres.projectionStatus === 'PROJECTED' && apres.projectId === PROJET);
  check('…sans aucune intervention manuelle, et sans doublon',
    (await txDe('in_e1')) === 1);
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('8. RÉCONCILIATION PAR BALAYAGE — les `UNOWNED` historiques repartent');
{
  const bloquee = factureModerne('f1', { payments: { data: [] }, customer: 'cus_f1' });
  await recevoir('invoice.paid', bloquee, 'evt_in_f1');
  await PanelProviderRevenueFact.updateOne(
    { objectId: 'in_f1' },
    { $set: { 'corroboration.paymentIntentId': 'pi_f1' } },
  );

  const avant = await faitDe('in_f1');
  check('le fait est bien bloqué avant la preuve', avant.projectionStatus === 'UNOWNED');

  await lier(PROJET, 'PAYMENT_INTENT', 'pi_f1');
  const res = await projection.convergePendingRevenue({ limit: 200 });

  const apres = await faitDe('in_f1');
  check('le balayage général réexamine les UNOWNED et les projette',
    apres.projectionStatus === 'PROJECTED' && res.projected >= 1);
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('9. NÉGATIF — l’absence de preuve ne devient JAMAIS une appartenance');
{
  /**
   * Un paiement dont AUCUNE ressource n'est liée : le client existe, il est
   * même connu d'un autre projet, et les metadata revendiquent un projet. Rien
   * de tout cela n'est une preuve.
   */
  await lier(AUTRE, 'CUSTOMER', 'cus_g1');

  const inconnue = factureModerne('g1', {
    customer: 'cus_g1',
    payments: { data: [{ payment: { payment_intent: 'pi_g1' } }] },
    metadata: { panelProjectId: PROJET },
  });
  const r = await recevoir('invoice.paid', inconnue, 'evt_in_g1');

  check('un paiement sans lien reste NON projeté', r.status !== 'PROJECTED');
  const fait = await faitDe('in_g1');
  check('…et n’est attribué à AUCUN projet', !fait.projectId);
  check('le CLIENT lié à un autre projet n’a rien attribué',
    fait.projectId !== AUTRE);
  check('la revendication des metadata n’a rien attribué non plus',
    fait.projectId !== PROJET);
  check('aucune transaction n’a été écrite', (await txDe('in_g1')) === 0);

  const verdict = await ownership.resolveStripeRevenueOwnership(fait);
  check('le résolveur dit « pas de lien », pas « propriétaire probable »',
    verdict.outcome === 'NO_BINDING' && verdict.projectId === null);
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('10. Un lien RÉVOQUÉ n’est pas un lien inconnu');
{
  await lier(PROJET, 'CHECKOUT_SESSION', 'cs_h1');
  await bindings.revokeBinding({
    environment: 'TEST', resourceType: 'CHECKOUT_SESSION', resourceId: 'cs_h1',
    reason: 'RECETTE',
  });

  const fait = {
    environment: 'TEST', objectType: 'CHECKOUT_SESSION', objectId: 'cs_h1',
    ownershipResourceType: 'CHECKOUT_SESSION', ownershipResourceId: 'cs_h1',
    corroboration: {},
  };
  const verdict = await ownership.resolveStripeRevenueOwnership(fait);
  check('un lien révoqué se distingue d’une absence de lien',
    verdict.outcome === 'REVOKED' && verdict.revokedVia?.resourceId === 'cs_h1');
}

await stopMemoryMongo();
finish();
