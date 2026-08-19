// LA RÉCURRENCE CONTRACTUELLE, CÔTÉ PANEL — lecture, tarif, grammaire.
//
// ══ CE QUE CETTE SUITE GARDE ═════════════════════════════════════════════════
//
// Un contrat ne dit plus « mensuel » ou « annuel » : il dit « tous les N mois »
// ou « tous les N ans ». Le Panel est celui qui CRÉE le tarif Stripe à partir de
// cette phrase — c'est donc ici que l'erreur coûterait le plus cher, et c'est
// ici qu'elle serait la plus silencieuse.
//
// Trois invariants, et chacun corrige un défaut qui ne se serait pas vu :
//
//   1. LA CLÉ DU TARIF PORTE L'INTERVALLE. « 900 € tous les mois » et « 900 €
//      tous les 3 mois » partagent contrat, montant, devise et unité. Sans le
//      nombre de pas dans la clé, ils auraient partagé le PRICE — et un
//      changement de périodicité aurait réutilisé le tarif de l'ancienne. Un
//      Price réutilisé est le cas NORMAL de cette fonction : rien n'aurait
//      alerté.
//
//   2. `interval_count` PART CHEZ LE FOURNISSEUR. Un contrat trimestriel dont
//      l'appel n'emporte pas le compte devient, chez Stripe, un abonnement
//      MENSUEL au montant du trimestre. Le client paie trois fois trop souvent.
//
//   3. UNE PROJECTION SANS PÉRIODICITÉ FAIT REFUSER. Supposer « mensuel »
//      reviendrait à décider, à la place du contrat, de la fréquence à laquelle
//      un client est débité. On refuse, comme on refuse déjà un montant absent.
//
// Aucune base de données : `resolvePriceIntent` accepte son lecteur de
// projection en paramètre, et la récurrence est une affaire de calcul pur.
import { check, finish, section } from './helpers/harness.js';

const {
  readRecurrence, describeRecurrence, recurrenceLabelOf, toStripeRecurring,
} = await import('../backend/src/services/contract/contractRecurrence.js');

const {
  resolvePriceIntent, priceOperationId, PRICE_REFUSALS,
} = await import('../backend/src/services/integratedApi/stripe/stripePriceAuthority.js');

/** Une projection de contrat minimale, dont on ne fait varier que l'abonnement. */
const projectionAvec = (subscription) => ({
  sourceContractId: 'ctr-1',
  reference: 'CTR-2026-0001',
  document: { version: 3 },
  pricing: { subscription },
});

const intentPour = (subscription) => resolvePriceIntent({
  projectId: 'prj-1',
  environment: 'TEST',
  contractRef: 'ctr-1',
  lookupContract: async () => projectionAvec(subscription),
});

const ABONNEMENT = { amountIncludingTax: 90000, currency: 'EUR' };

try {
  /* ───────────────────────────────────────────────────────────────────────── */
  section('1. Lecture — la priorité est fixe, et le silence est dit');

  check(
    'récurrence complète : elle fait foi',
    JSON.stringify(readRecurrence({ recurrence: { unit: 'MONTH', interval: 3 } }))
    === JSON.stringify({ unit: 'MONTH', interval: 3 }),
  );
  check(
    'récurrence présente : elle bat l’héritage contradictoire',
    JSON.stringify(readRecurrence({ interval: 'YEAR', recurrence: { unit: 'MONTH', interval: 3 } }))
    === JSON.stringify({ unit: 'MONTH', interval: 3 }),
  );
  check(
    'héritage seul : « MONTH » se lit « tous les 1 mois »',
    JSON.stringify(readRecurrence({ interval: 'MONTH' })) === JSON.stringify({ unit: 'MONTH', interval: 1 }),
  );
  check(
    'héritage seul : « YEAR » se lit « tous les 1 an »',
    JSON.stringify(readRecurrence({ interval: 'YEAR' })) === JSON.stringify({ unit: 'YEAR', interval: 1 }),
  );
  /**
   * `null`, et surtout pas « tous les mois ». Combler ce trou ferait facturer
   * à une fréquence que personne n'a décidée — voir l'en-tête.
   */
  check('rien d’exploitable : null, jamais un défaut', readRecurrence({}) === null);
  check('ligne absente : null', readRecurrence(null) === null);
  check('unité inconnue : null (WEEK n’est pas une offre)',
    readRecurrence({ recurrence: { unit: 'WEEK', interval: 1 } }) === null);
  check('intervalle nul : null (une récurrence à 0 ne s’échoit jamais)',
    readRecurrence({ recurrence: { unit: 'MONTH', interval: 0 } }) === null);
  check('intervalle décimal : null',
    readRecurrence({ recurrence: { unit: 'MONTH', interval: 1.5 } }) === null);

  /* ───────────────────────────────────────────────────────────────────────── */
  section('2. Grammaire — « tous les 1 mois » ne se dit pas');

  check('1 MONTH → Tous les mois', describeRecurrence({ unit: 'MONTH', interval: 1 }) === 'Tous les mois');
  check('3 MONTH → Tous les 3 mois', describeRecurrence({ unit: 'MONTH', interval: 3 }) === 'Tous les 3 mois');
  check('1 YEAR → Tous les ans', describeRecurrence({ unit: 'YEAR', interval: 1 }) === 'Tous les ans');
  check('3 YEAR → Tous les 3 ans', describeRecurrence({ unit: 'YEAR', interval: 3 }) === 'Tous les 3 ans');
  check('aucune récurrence → aucun libellé', describeRecurrence(null) === null);

  // Le projet publie déjà sa phrase : c'est la même donnée, dite par celui qui
  // la détient. On la préfère, et l'on sait la reconstruire sans elle.
  check(
    'libellé publié par le projet : préféré',
    recurrenceLabelOf({ recurrenceLabel: 'Tous les 3 mois', recurrence: { unit: 'MONTH', interval: 3 } })
    === 'Tous les 3 mois',
  );
  check(
    'projection antérieure sans libellé : reconstruit',
    recurrenceLabelOf({ recurrence: { unit: 'YEAR', interval: 2 } }) === 'Tous les 2 ans',
  );

  /* ───────────────────────────────────────────────────────────────────────── */
  section('3. Traduction Stripe — mécanique, sans plan prédéfini');

  check('MONTH+1 → month / 1',
    JSON.stringify(toStripeRecurring({ unit: 'MONTH', interval: 1 })) === JSON.stringify({ interval: 'month', interval_count: 1 }));
  check('MONTH+3 → month / 3',
    JSON.stringify(toStripeRecurring({ unit: 'MONTH', interval: 3 })) === JSON.stringify({ interval: 'month', interval_count: 3 }));
  check('MONTH+12 → month / 12 (et NON year/1 : ce n’est pas au Panel de convertir)',
    JSON.stringify(toStripeRecurring({ unit: 'MONTH', interval: 12 })) === JSON.stringify({ interval: 'month', interval_count: 12 }));
  check('YEAR+2 → year / 2',
    JSON.stringify(toStripeRecurring({ unit: 'YEAR', interval: 2 })) === JSON.stringify({ interval: 'year', interval_count: 2 }));

  /* ───────────────────────────────────────────────────────────────────────── */
  section('4. LA CLÉ DU TARIF — l’intervalle en fait partie');

  const cleMensuelle = priceOperationId({
    environment: 'TEST', contractId: 'ctr-1', interval: 'month', intervalCount: 1, amount: 90000, currency: 'EUR',
  });
  const cleTrimestrielle = priceOperationId({
    environment: 'TEST', contractId: 'ctr-1', interval: 'month', intervalCount: 3, amount: 90000, currency: 'EUR',
  });
  /**
   * LE CŒUR DE LA SUITE. Tout est identique sauf le nombre de pas ; si les deux
   * clés se confondaient, passer d'un mensuel à un trimestriel réutiliserait le
   * Price mensuel, et le client resterait débité tous les mois.
   */
  check('mensuel et trimestriel de MÊME montant : deux clés DISTINCTES', cleMensuelle !== cleTrimestrielle);
  check('la clé reste lisible dans le registre', cleTrimestrielle.includes(':monthx3:'));

  /**
   * LA CONTINUITÉ DU PARC. Toutes les liaisons déjà en base portent la forme
   * SANS suffixe, et sont toutes en `intervalCount = 1`. Suffixer sans
   * condition les aurait toutes renommées : le Panel aurait recréé un Price
   * identique pour chaque contrat du parc, en une seule migration.
   */
  check('un mensuel garde la clé HISTORIQUE (aucun Price recréé sur le parc)',
    cleMensuelle === `stripe-price:TEST:ctr-1:month:90000:eur`);
  check('`intervalCount` absent : même clé qu’un compte de 1',
    priceOperationId({ environment: 'TEST', contractId: 'ctr-1', interval: 'month', amount: 90000, currency: 'EUR' })
    === cleMensuelle);
  check('aucune collision possible : « month » n’est jamais « monthx3 »',
    !cleMensuelle.startsWith(cleTrimestrielle) && !cleTrimestrielle.includes(':month:'));
  check(
    'la devise reste normalisée (deux graphies ne font pas deux tarifs)',
    priceOperationId({ environment: 'TEST', contractId: 'c', interval: 'month', intervalCount: 1, amount: 1, currency: 'EUR' })
    === priceOperationId({ environment: 'TEST', contractId: 'c', interval: 'month', intervalCount: 1, amount: 1, currency: 'eur' }),
  );

  /* ───────────────────────────────────────────────────────────────────────── */
  section('5. L’INTENTION DE TARIF — ce qui part réellement chez Stripe');

  const trimestriel = await intentPour({ ...ABONNEMENT, recurrence: { unit: 'MONTH', interval: 3 } });
  check('termes rendus : unité', trimestriel.interval === 'month');
  check('termes rendus : nombre de pas', trimestriel.intervalCount === 3);
  const paramsTrim = trimestriel.priceParamsFor('prod_1');
  check(
    'l’appel Stripe emporte interval_count=3',
    paramsTrim.recurring.interval === 'month' && paramsTrim.recurring.interval_count === 3,
  );
  check('le montant reste celui de L’ÉCHÉANCE, jamais ramené au mois',
    paramsTrim.unit_amount === 90000);

  const triennal = await intentPour({ ...ABONNEMENT, recurrence: { unit: 'YEAR', interval: 3 } });
  check('trois ans : year / 3',
    triennal.priceParamsFor('p').recurring.interval === 'year'
    && triennal.priceParamsFor('p').recurring.interval_count === 3);

  /**
   * `interval_count` est transmis MÊME à 1. Stripe le suppose quand il manque,
   * et dépendre d'un défaut du fournisseur pour une période facturée revient à
   * ne pas l'avoir décidée.
   */
  const mensuel = await intentPour({ ...ABONNEMENT, recurrence: { unit: 'MONTH', interval: 1 } });
  check('mensuel : interval_count=1 transmis explicitement',
    mensuel.priceParamsFor('p').recurring.interval_count === 1);

  // Un projet non encore redéployé n'envoie que l'unité : il reste facturable.
  const herite = await intentPour({ ...ABONNEMENT, interval: 'YEAR' });
  check('projection héritée (unité seule) : lue « tous les 1 an », toujours facturable',
    herite.interval === 'year' && herite.intervalCount === 1);

  /* ───────────────────────────────────────────────────────────────────────── */
  section('6. LE REFUS — on ne suppose pas une fréquence');

  const refus = async (subscription, quoi) => {
    try {
      await intentPour(subscription);
      check(`${quoi} : REFUSÉ`, false);
    } catch (e) {
      check(`${quoi} : refusé (${e.reason})`, e.reason === PRICE_REFUSALS.SUBSCRIPTION_PRICE_ABSENT);
    }
  };

  await refus({ ...ABONNEMENT }, 'aucune périodicité projetée');
  await refus({ ...ABONNEMENT, recurrence: { unit: 'WEEK', interval: 1 } }, 'unité inconnue');
  await refus({ ...ABONNEMENT, recurrence: { unit: 'MONTH', interval: 0 } }, 'intervalle nul');
  await refus({ amountIncludingTax: 0, currency: 'EUR', recurrence: { unit: 'MONTH', interval: 3 } }, 'montant nul');
} finally {
  finish();
}
