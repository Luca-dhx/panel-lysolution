// L'INSTANTANÉ LÉGAL — ce qui a été utilisé, pas ce qui est vrai aujourd'hui.
//
// ══ LE PROBLÈME, EN UNE PHRASE ══════════════════════════════════════════════
//
// Une SARL déménage six mois après avoir été facturée. Si la facture lisait
// l'entreprise EN DIRECT, elle afficherait la nouvelle adresse — et
// prétendrait qu'un document émis en mars portait une adresse qui n'existait
// qu'en septembre. Ce n'est pas un détail d'affichage : une facture est une
// pièce comptable, et sa réécriture rétroactive est précisément ce que la
// conservation des pièces interdit.
//
// ══ POURQUOI CE MODULE EST SI PETIT ═════════════════════════════════════════
//
// Parce que le mécanisme existe déjà, deux fois, et qu'il a fait ses preuves :
//
//   · `Contract.signersSnapshot` fige l'identité des deux parties à la
//     validation du contrat, côté projet ;
//   · `PanelFinancialTransaction` fige le nom du projet au moment du mouvement.
//
// Ce module ne fait qu'ÉTENDRE cette discipline à l'identité juridique du
// client. Il ne crée aucune collection, aucun versionnement, aucun cycle de
// vie : un instantané est une valeur, on la recopie là où l'acte est écrit.
//
// ══ CE QU'IL NE FAUT SURTOUT PAS FAIRE ══════════════════════════════════════
//
// Stocker `clientCompanyId` seul dans une facture et « aller chercher le reste
// au moment d'afficher ». C'est exactement la dépendance dynamique que ce
// module existe pour empêcher — et elle est d'autant plus dangereuse qu'elle
// paraît propre : une clé étrangère, une jointure, et six mois plus tard des
// factures qui ont changé toutes seules.
//
// L'identifiant est conservé À CÔTÉ de l'instantané, jamais à sa place : il
// répond à « de quelle fiche cela vient-il ? », ce qu'un instantané ne sait
// pas dire. Deux questions, deux champs.
import { effectiveBillingAddress } from './clientCompanyReadiness.js';

/** Une adresse figée — la même forme que le modèle, sans rien de plus. */
function figerAdresse(adresse) {
  if (!adresse) return null;
  const valeur = {
    line1: adresse.line1 ?? null,
    line2: adresse.line2 ?? null,
    postalCode: adresse.postalCode ?? null,
    city: adresse.city ?? null,
    country: adresse.country ?? null,
  };
  // Une adresse dont aucun champ n'est renseigné n'est pas « une adresse vide » :
  // c'est l'absence d'adresse, et l'écrire ainsi évite d'afficher quatre lignes
  // blanches sur un document.
  return Object.values(valeur).some((v) => v !== null && String(v).trim() !== '') ? valeur : null;
}

/**
 * FIGE l'identité juridique d'une entreprise cliente pour un acte donné.
 *
 * ── CE QUI EST RETENU, ET RIEN D'AUTRE ──────────────────────────────────────
 *
 * Ce qu'un document légal doit porter : qui est le client, où il est, comment
 * il s'identifie auprès de l'administration, et à qui la facture est adressée.
 *
 * Ce qui est délibérément EXCLU :
 *
 *   · `notes` — une note interne de gestion n'a rien à faire dans une pièce
 *     remise au client ;
 *   · `documents[]` — des Kbis figés dans chaque facture pèseraient sans rien
 *     prouver de plus ;
 *   · `status` — l'archivage est un état de la RELATION, pas du document.
 *
 * ── L'ADRESSE EST DÉJÀ RÉSOLUE ──────────────────────────────────────────────
 *
 * `billingAddress` porte ici l'adresse EFFECTIVE (celle de facturation, ou
 * celle du siège à défaut). L'instantané doit se lire seul : y recopier la
 * règle de substitution obligerait chaque lecteur — un PDF, un écran, un
 * export comptable — à la réappliquer, et l'un d'eux l'oublierait.
 *
 * @param {object|null} company  la fiche `PanelClientCompany`
 * @param {{at?: string}} [options] l'instant de l'acte — jamais deviné ici
 * @returns {object|null} l'instantané, ou `null` si aucune entreprise
 */
export function buildClientLegalSnapshot(company, { at = null } = {}) {
  if (!company?.clientCompanyId) return null;

  return {
    /** D'OÙ cela vient — à côté de l'instantané, jamais à sa place. */
    clientCompanyId: company.clientCompanyId,
    /** La version de la fiche au moment de l'acte : de quoi rejouer un écart. */
    version: company.publishedVersion ?? 0,
    capturedAt: at,

    legalName: company.legalName ?? null,
    tradingName: company.tradingName ?? null,
    legalForm: company.legalForm ?? null,
    siren: company.siren ?? null,
    siret: company.siret ?? null,
    vatNumber: company.vatNumber ?? null,
    registrationCity: company.registrationCity ?? null,

    registeredOffice: figerAdresse(company.registeredOffice),
    billingAddress: figerAdresse(effectiveBillingAddress(company)),

    billingEmail: company.billingEmail ?? null,
    phone: company.phone ?? null,
  };
}

/**
 * FIGE le signataire contractuel du client.
 *
 * ══ POURQUOI IL EST SÉPARÉ DE L'IDENTITÉ ════════════════════════════════════
 *
 * Ils n'ont ni le même cycle de vie ni le même consommateur. Une facture n'a
 * aucun besoin de savoir qui signe ; une demande de signature n'a aucun besoin
 * du numéro de TVA. Les fondre en un seul objet ferait voyager l'adresse
 * e-mail d'une personne physique dans chaque facture archivée — une donnée
 * personnelle transportée sans raison, qu'il faudrait ensuite justifier.
 *
 * `companyName` est recopié ICI parce que le fournisseur de signature l'affiche
 * à côté du nom du signataire : « Jean Dupont, SARL DUPONT AUTOMOBILES ». Sans
 * lui, l'instantané de signature ne se lirait pas seul.
 *
 * @returns {object|null} `null` si l'entreprise n'a désigné personne
 */
export function buildClientSignerSnapshot(company) {
  const signataire = company?.contractualSigner ?? null;
  const prenom = String(signataire?.firstName ?? '').trim();
  const nom = String(signataire?.lastName ?? '').trim();
  const courriel = String(signataire?.email ?? '').trim().toLowerCase();

  /**
   * UN SIGNATAIRE INCOMPLET N'EST PAS UN SIGNATAIRE.
   *
   * Rendre un objet à moitié rempli laisserait l'appelant décider si « pas de
   * nom de famille » est acceptable — et le premier appelant pressé déciderait
   * que oui. `null` ne se discute pas, et la garde de readiness a déjà dit
   * lequel des trois champs manquait.
   */
  if (!prenom || !nom || !courriel) return null;

  return {
    firstName: prenom,
    lastName: nom,
    jobTitle: String(signataire.jobTitle ?? '').trim() || null,
    email: courriel,
    phone: String(signataire.phone ?? '').trim() || null,
    companyName: company.legalName ?? null,
    clientCompanyId: company.clientCompanyId ?? null,
  };
}

export default { buildClientLegalSnapshot, buildClientSignerSnapshot };
