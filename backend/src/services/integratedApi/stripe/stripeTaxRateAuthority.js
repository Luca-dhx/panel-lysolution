// LE TAUX DE TVA CHEZ LE FOURNISSEUR — un objet, pas un calcul.
//
// ══ LE PROBLÈME QUE CE MODULE RÉSOUT ════════════════════════════════════════
//
// Une facture française doit porter quatre chiffres : le montant HORS TAXE, le
// TAUX, le MONTANT DE TVA et le TOTAL. Stripe ne les imprime que s'il SAIT
// qu'une taxe s'applique — et il ne le devine pas.
//
// Avant ce chantier, le Panel envoyait un montant TTC sans rien dire de la
// taxe. Stripe imprimait donc, très logiquement :
//
//     Montant     95,99 €
//     Sous-total  95,99 €
//     Total       95,99 €
//
// Trois fois le même nombre, aucune mention de TVA. Ce n'est pas un défaut
// d'affichage : c'est une facture qui ne dit pas ce que la loi lui demande de
// dire.
//
// ══ POURQUOI UN `TaxRate` EXPLICITE, ET NON `automatic_tax` ═════════════════
//
// `automatic_tax` délègue à Stripe Tax le CALCUL du taux à partir de l'adresse
// du client. C'est un produit payant, il exige une adresse validée et des
// inscriptions fiscales déclarées par juridiction — et surtout, il DÉCIDE du
// taux.
//
// Or le taux est déjà décidé : il est écrit dans le CONTRAT, il a été accepté
// par le client, il figure dans le PDF qu'il a signé. Laisser un tiers le
// recalculer, c'est accepter qu'il en trouve un autre — et découvrir l'écart
// sur une facture, devant le client.
//
// Un `TaxRate` explicite en `inclusive: false`, appliqué à un montant HORS
// TAXE, produit exactement la ventilation attendue sans qu'aucune décision
// fiscale ne quitte le contrat.
//
// ══ POURQUOI CE N'EST PAS UNE RESSOURCE DE PROJET ═══════════════════════════
//
// Le registre de liens (`PanelStripeResourceBinding`) répond à « à quel projet
// appartient cette ressource ? ». La question n'a pas de sens pour un taux de
// TVA : « TVA 20 % » n'appartient à personne, c'est une entrée de catalogue du
// COMPTE, partagée par tous les clients de ce compte. L'y inscrire créerait un
// propriétaire là où il n'y en a pas, et le premier projet à l'obtenir
// interdirait aux autres de le réutiliser.
//
// La convergence passe donc par ce que Stripe expose lui-même : on LIT le
// catalogue, on retrouve le taux, on ne le crée que s'il manque.
import logger from '../../../utils/logger.js';
import { createTaxRate, listTaxRates } from './stripeTransport.js';

/**
 * MÉMOIRE DE PROCESSUS — `(monde, taux) → identifiant`.
 *
 * ══ POURQUOI UN CACHE EST SÛR ICI, ALORS QU'IL NE L'EST PRESQUE JAMAIS ══════
 *
 * Un `TaxRate` Stripe est IMMUABLE sur ses termes : ni le pourcentage, ni le
 * caractère inclusif, ni le pays ne se modifient. Un identifiant retenu pour
 * « 20 %, exclusif, FR » désignera donc éternellement la même chose. Il n'y a
 * aucune invalidation à prévoir, et donc aucune fenêtre où le cache mentirait.
 *
 * Ce qu'il évite : un aller-retour `GET /v1/tax_rates` devant CHAQUE client qui
 * paie. Ce qu'il ne fait pas : décider. Un processus neuf relit le catalogue,
 * et retrouve exactement le même objet.
 *
 * Il n'est pas persisté, et ne doit pas l'être : une base partagée entre TEST
 * et un compte Stripe changé ferait resservir un identifiant qui n'existe plus.
 * La source de vérité reste le catalogue du fournisseur.
 */
const memoire = new Map();

/** Clé de mémoire — le monde en fait partie : deux comptes, deux catalogues. */
function cleMemoire({ environment, percentage, country }) {
  return `${environment}|${percentage}|${country}`;
}

/**
 * LE NOM AFFICHÉ SUR LA FACTURE.
 *
 * Stripe imprime `display_name` suivi du pourcentage : « TVA (20 %) ». Le mot
 * est en FRANÇAIS parce que la facture l'est — écrire « VAT » sur une facture
 * française émise par une société française à un client français serait une
 * anglicisation gratuite d'une mention légale.
 *
 * Il entre aussi dans la RECHERCHE de convergence, ci-dessous : deux taux de
 * même pourcentage mais de noms différents sont deux entrées de catalogue, et
 * l'on veut retomber sur la nôtre.
 */
export const TAX_RATE_DISPLAY_NAME = 'TVA';

/**
 * Un taux du catalogue correspond-il EXACTEMENT à ce qu'on cherche ?
 *
 * Les quatre termes sont comparés, et aucun n'est facultatif :
 *
 *   percentage   évidemment ;
 *   inclusive    un taux INCLUSIF appliqué à un HT sous-facturerait la TVA —
 *                le client paierait 79,99 € au lieu de 95,99 € ;
 *   country      la mention légale n'est pas la même d'un pays à l'autre ;
 *   active       un taux archivé est refusé par Stripe à l'usage.
 *
 * Le nom n'est PAS comparé : un exploitant a le droit de renommer une entrée
 * depuis le tableau de bord, et exiger notre libellé ferait créer un doublon à
 * chaque fois qu'il le fait.
 */
function correspond(taux, { percentage, country }) {
  return taux?.active === true
    && taux?.inclusive === false
    && Number(taux?.percentage) === Number(percentage)
    && String(taux?.country ?? '').toUpperCase() === String(country).toUpperCase();
}

/**
 * GARANTIT qu'un taux de TVA existe chez le fournisseur, et rend son identifiant.
 *
 * ══ LES DEUX BARRIÈRES ══════════════════════════════════════════════════════
 *
 *   1. LE CATALOGUE. On lit `GET /v1/tax_rates` et on cherche les termes
 *      exacts. C'est ce qui empêche un « TVA 20 % » de plus à chaque paiement —
 *      Stripe ne déduplique rien, et un catalogue pollué rend illisible le
 *      tableau de bord comptable en quelques semaines.
 *
 *   2. LA CLÉ D'IDEMPOTENCE. Si la lecture n'a rien trouvé mais qu'un autre
 *      appel concurrent vient de créer le taux, la même clé rend le MÊME objet
 *      au lieu d'en produire un second.
 *
 * ══ CE VERBE NE FAIT PAS PARTIE DU CATALOGUE DE CAPACITÉS ═══════════════════
 *
 * Aucun projet ne peut le demander. Ce n'est pas une intention métier d'un
 * projet — c'est une conséquence interne de la construction d'un paiement, et
 * l'exposer permettrait à un projet de peupler le catalogue fiscal du compte.
 *
 * @param {object} args
 * @param {object} args.credentials
 * @param {'TEST'|'PROD'} args.environment
 * @param {number} args.percentage  le taux en POURCENTAGE (20 vaut 20 %)
 * @param {string} [args.country]   code ISO du pays d'imposition
 * @returns {Promise<string>} l'identifiant `txr_…`
 */
export async function ensureTaxRate({
  credentials, environment, percentage, country = 'FR', timeoutMs, fetchImpl,
}) {
  const taux = Number(percentage);
  if (!Number.isFinite(taux) || taux < 0 || taux > 100) {
    throw new Error(`Taux de TVA hors bornes : ${percentage}`);
  }

  const cle = cleMemoire({ environment, percentage: taux, country });
  if (memoire.has(cle)) return memoire.get(cle);

  const { taxRates } = await listTaxRates({ credentials, timeoutMs, fetchImpl });
  const connu = taxRates.find((t) => correspond(t, { percentage: taux, country }));
  if (connu?.id) {
    memoire.set(cle, connu.id);
    return connu.id;
  }

  /**
   * LA CLÉ EST DÉRIVÉE DES TERMES, jamais tirée au sort.
   *
   * Elle doit être reproductible SANS lecture de base : c'est exactement au
   * rejeu qui suit une coupure qu'on en a le plus besoin, et un identifiant
   * stocké puis relu serait indisponible à ce moment-là. Les termes suffisent —
   * ils sont ce qui définit l'objet.
   */
  const idempotencyKey = `pcp_taxrate_${environment}_${String(taux).replace('.', '_')}_${country}`
    .toLowerCase();

  const cree = await createTaxRate({
    credentials,
    params: {
      display_name: TAX_RATE_DISPLAY_NAME,
      percentage: taux,
      /**
       * EXCLUSIF — le montant auquel il s'applique est un HORS TAXE.
       *
       * C'est le choix qui produit la ventilation attendue : Stripe imprime
       * « Sous-total 79,99 € · TVA (20 %) 16,00 € · Total 95,99 € ». Un taux
       * inclusif produirait « Total 79,99 € dont 13,33 € de TVA » — c'est-à-dire
       * un débit inférieur de seize euros à ce que le contrat prévoit.
       */
      inclusive: false,
      country: String(country).toUpperCase(),
      /** `VAT` est le vocabulaire de Stripe ; il conditionne l'affichage légal. */
      tax_type: 'vat',
      description: `TVA ${taux} % — ${country}`,
    },
    idempotencyKey,
    timeoutMs,
    fetchImpl,
  });

  const id = cree.taxRate?.id;
  if (!id) {
    /**
     * 2xx sans identifiant : Stripe a peut-être créé le taux. On ne prétend pas
     * savoir, et l'on ne mémorise rien — le passage suivant relira le catalogue
     * et le retrouvera s'il existe.
     */
    throw new Error('Stripe a répondu sans identifiant de taux de TVA : issue indéterminée.');
  }

  logger.info(`[stripe] taux de TVA ${taux} % (${country}) garanti — ${id} (${environment}).`);
  memoire.set(cle, id);
  return id;
}

/** Vide la mémoire — tests uniquement. En exploitation elle n'a rien à purger. */
export function resetTaxRateMemoryForTests() {
  memoire.clear();
}

export default { TAX_RATE_DISPLAY_NAME, ensureTaxRate, resetTaxRateMemoryForTests };
