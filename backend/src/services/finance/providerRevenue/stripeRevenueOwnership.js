/**
 * À QUI APPARTIENT CE REVENU — le résolveur unique (L10.7).
 *
 * ══ LE DÉFAUT QUI A RENDU CE MODULE NÉCESSAIRE ══════════════════════════════
 *
 * L'appartenance d'un fait de revenu se lisait sur UNE SEULE ressource, celle
 * que le normalisateur avait retenue sur la charge utile : l'abonnement d'une
 * facture, ou son intention de paiement à plat. Deux champs Stripe, et rien
 * derrière eux.
 *
 * Stripe a retiré le second. Depuis `2025-04-30.basil`, une facture ne porte
 * plus `payment_intent` à plat. Une prestation ponctuelle — `mode: payment`
 * avec `invoice_creation` — n'a par nature aucun abonnement. Les deux seules
 * filiations tombaient donc ensemble, et le fait partait en :
 *
 *     projectionStatus = UNOWNED
 *     projectionReason = NO_OWNERSHIP_RESOURCE
 *
 * alors même que le Panel SAVAIT à qui appartenait ce paiement : il avait créé
 * la session, il l'avait liée, et il avait adopté son intention. La preuve
 * existait, en base, écrite de sa propre main. Personne n'allait la chercher.
 *
 * ══ LA DOCTRINE ════════════════════════════════════════════════════════════
 *
 *   Quand le Panel a DÉJÀ appris qu'une ressource Stripe appartient à un
 *   projet, tout événement ultérieur doit résoudre l'appartenance depuis ce
 *   graphe interne AVANT de conclure UNOWNED.
 *
 * Le fournisseur annonce des faits ; il n'est pas l'annuaire de nos clients.
 * Un champ qu'il déplace ne doit pas pouvoir effacer une appartenance que nous
 * avons établie nous-mêmes, transactionnellement, à la création.
 *
 * ══ CE QUI EST UNE PREUVE, ET CE QUI N'EN EST JAMAIS UNE ═══════════════════
 *
 * Une preuve est un LIEN (`PanelStripeResourceBinding`) : une ligne écrite par
 * le Panel au moment où il a créé la ressource, ou adoptée par filiation
 * désignée par Stripe sur un objet déjà possédé. Elle est unique par
 * `{environnement, type, identifiant}` — la base l'arbitre, pas une lecture.
 *
 * Ne sont PAS des preuves, et n'entrent donc dans aucun candidat :
 *
 *   · `metadata.panelProjectId`   éditable depuis le tableau de bord Stripe ;
 *                                 elle reste lue, mais pour CORROBORER — un
 *                                 désaccord se journalise (`claimMismatch`),
 *                                 il ne décide pas ;
 *   · l'e-mail, le nom, la description, le montant — aucun n'est corrélable ;
 *   · le CLIENT (`cus_…`). Et c'est le refus le plus important de ce module :
 *     voir plus bas.
 *
 * ══ POURQUOI LE CLIENT EST EXCLU, ALORS QU'IL EST POURTANT LIÉ ═════════════
 *
 * Un `cus_…` porte bien un lien unique dans notre registre. Il serait donc
 * TECHNIQUEMENT résolvable. Il est exclu quand même, pour une raison de
 * nature :
 *
 * Une session, une intention, une facture, un abonnement sont des objets de
 * PAIEMENT : chacun désigne une transaction précise, et son propriétaire est
 * celui de cette transaction. Un client est un objet de RELATION : il vit
 * au-dessus des paiements, il leur survit, et rien ne garantit que le prochain
 * euro qu'il verse concerne le même projet que le précédent.
 *
 * Résoudre par le client reviendrait à répondre « le projet qui a utilisé ce
 * client la dernière fois » — précisément le rapprochement ambigu que la
 * doctrine interdit. Le but est de supprimer les faux `UNOWNED`, jamais de
 * fabriquer des faux propriétaires : un revenu attribué au mauvais projet est
 * une faute comptable bien plus coûteuse qu'un revenu non attribué, parce
 * qu'elle est silencieuse et qu'elle fausse deux bilans à la fois.
 *
 * ══ EN L'ABSENCE DE PREUVE ══════════════════════════════════════════════════
 *
 * `UNOWNED` reste la bonne réponse. Elle est diagnosticable, réversible, et la
 * réconciliation la reprendra dès qu'un lien apparaîtra. Une mauvaise
 * attribution, elle, ne se reprend pas : personne ne va la chercher.
 */
import {
  findBinding,
  STRIPE_RESOURCE_TYPES,
} from '../../integratedApi/stripe/stripeResourceBinding.js';
import { CANONICAL_TYPES } from './stripeRevenueNormalizer.js';

/** Pourquoi une résolution n'a rien rendu. Nommé : un `null` ne se diagnostique pas. */
export const OWNERSHIP_OUTCOME = Object.freeze({
  /** Un lien possédé a été trouvé. */
  RESOLVED: 'RESOLVED',
  /** Des candidats existaient, aucun n'est (encore) lié. */
  NO_BINDING: 'NO_BINDING',
  /** Le fait ne présente AUCUNE ressource corrélable. Rien à chercher. */
  NO_CANDIDATE: 'NO_CANDIDATE',
  /** Un lien existe mais il est neutralisé — ce n'est pas « inconnu ». */
  REVOKED: 'REVOKED',
});

/**
 * LES CANDIDATS D'UN FAIT, DANS UN ORDRE DÉTERMINISTE.
 *
 * ══ POURQUOI L'ORDRE EST FIGÉ, ET POURQUOI CELUI-CI ════════════════════════
 *
 * Deux exécutions sur le même fait doivent rendre le même propriétaire, même
 * si le graphe s'est enrichi entre-temps. Un ordre variable ferait dépendre le
 * résultat de l'instant de la lecture — et rendrait un rejeu non reproductible,
 * ce qui est le contraire de ce qu'on attend d'une projection financière.
 *
 * L'ordre va du plus SPÉCIFIQUE au plus GÉNÉRAL, c'est-à-dire du lien qui
 * désigne exactement cette transaction vers celui qui désigne la relation
 * commerciale qui la contient :
 *
 *   1. la ressource retenue par le normalisateur — c'est la filiation que
 *      Stripe DÉSIGNE lui-même sur la charge utile ; quand elle existe et
 *      qu'elle est liée, il n'y a rien à chercher ailleurs ;
 *   2. l'objet canonique LUI-MÊME — une facture ou une session que le Panel
 *      possède directement. C'est la voie ouverte par L10.7 : la session
 *      apprend au Panel quelle facture elle produit, et la facture devient
 *      possédée avant même d'être payée ;
 *   3. l'ABONNEMENT — il ne produit que les factures d'UN contrat ;
 *   4. l'INTENTION DE PAIEMENT — un `pi_…` est un règlement et un seul ;
 *   5. la SESSION — créée et liée par le Panel pour un projet nommé (L6.2B).
 *
 * Le client n'apparaît nulle part. Voir l'en-tête du module.
 */
export function ownershipCandidates(fait) {
  const candidats = [];
  /**
   * `related` DISTINGUE UNE ATTENTE D'UNE IMPASSE.
   *
   * Un candidat APPARENTÉ — abonnement, intention, session — est une ressource
   * TIERCE que quelqu'un d'autre peut encore faire adopter : la session qui
   * arrive, l'abonnement qui se lie. Tant qu'il en existe un, « pas de lien »
   * veut dire « pas ENCORE », et le fait doit être RETENU (`PENDING`).
   *
   * L'objet canonique lui-même n'est pas apparenté : personne n'ira lier une
   * facture que plus aucune session ne désigne. Quand il est le seul candidat
   * et qu'il n'est pas lié, « pas de lien » veut dire « rien à attendre », et
   * le verdict honnête est `UNOWNED`.
   *
   * La nuance décide de ce que lit un exploitant : une file d'attente
   * normale, ou une anomalie à instruire. Les deux restent réexaminées par la
   * convergence — se tromper ici retarde un diagnostic, jamais un revenu.
   */
  const ajouter = (resourceType, resourceId, related) => {
    if (!resourceType || !resourceId) return;
    // Un même identifiant ne se cherche pas deux fois.
    const deja = candidats.find((c) => c.resourceType === resourceType && c.resourceId === resourceId);
    if (deja) {
      // Apparenté par l'une des voies suffit à le rendre apparenté.
      if (related) deja.related = true;
      return;
    }
    candidats.push({ resourceType, resourceId, related: Boolean(related) });
  };

  const corr = fait?.corroboration ?? {};

  /**
   * L'objet canonique lui-même — repéré d'abord pour que la ressource retenue
   * par le normalisateur, si elle le désigne, n'hérite pas d'`related: true`.
   */
  const estSoiMeme = (resourceType, resourceId) => (
    (fait?.objectType === CANONICAL_TYPES.INVOICE
      && resourceType === STRIPE_RESOURCE_TYPES.INVOICE && resourceId === fait.objectId)
    || (fait?.objectType === CANONICAL_TYPES.CHECKOUT_SESSION
      && resourceType === STRIPE_RESOURCE_TYPES.CHECKOUT_SESSION && resourceId === fait.objectId)
  );

  // 1. Ce que le normalisateur a retenu sur la charge utile.
  ajouter(
    fait?.ownershipResourceType,
    fait?.ownershipResourceId,
    !estSoiMeme(fait?.ownershipResourceType, fait?.ownershipResourceId),
  );

  // 2. L'objet canonique lui-même, quand le Panel peut le posséder.
  if (fait?.objectType === CANONICAL_TYPES.INVOICE) {
    ajouter(STRIPE_RESOURCE_TYPES.INVOICE, fait.objectId, false);
  }
  if (fait?.objectType === CANONICAL_TYPES.CHECKOUT_SESSION) {
    ajouter(STRIPE_RESOURCE_TYPES.CHECKOUT_SESSION, fait.objectId, false);
  }

  // 3 → 5. Les identités secondaires, déjà conservées par le normalisateur.
  ajouter(STRIPE_RESOURCE_TYPES.SUBSCRIPTION, corr.subscriptionId, true);
  ajouter(STRIPE_RESOURCE_TYPES.PAYMENT_INTENT, corr.paymentIntentId, true);
  ajouter(STRIPE_RESOURCE_TYPES.CHECKOUT_SESSION, corr.checkoutSessionId, true);

  return candidats;
}

/**
 * RÉSOUT L'APPARTENANCE D'UN FAIT DE REVENU — sur le graphe interne, et lui seul.
 *
 * N'appelle PAS Stripe. Ne lit aucune métadonnée pour décider. Ne devine rien.
 *
 * @param {object} fait  le fait tel qu'il est persisté (`PanelProviderRevenueFact`)
 * @returns {Promise<{
 *   outcome: string,
 *   projectId: string|null,
 *   via: {resourceType:string, resourceId:string}|null,
 *   candidates: Array<{resourceType:string, resourceId:string}>,
 *   revokedVia: {resourceType:string, resourceId:string}|null,
 * }>}
 */
export async function resolveStripeRevenueOwnership(fait) {
  const candidates = ownershipCandidates(fait);
  /**
   * Y A-T-IL ENCORE QUELQUE CHOSE À ATTENDRE ? Voir `ownershipCandidates`.
   * C'est ce booléen qui distingue une file d'attente d'une impasse.
   */
  const hasRelatedCandidate = candidates.some((c) => c.related);
  const vide = {
    projectId: null, via: null, candidates, hasRelatedCandidate, revokedVia: null,
  };

  if (candidates.length === 0) {
    return { ...vide, outcome: OWNERSHIP_OUTCOME.NO_CANDIDATE };
  }

  /**
   * UN LIEN RÉVOQUÉ EST UNE RÉPONSE, PAS UN SILENCE.
   *
   * On le retient sans s'arrêter dessus : un candidat plus loin dans l'ordre
   * peut être parfaitement valide. Mais si AUCUN ne l'est, il faut pouvoir
   * dire « neutralisé » plutôt que « inconnu » — les deux appellent des gestes
   * opposés côté exploitation.
   */
  let revokedVia = null;

  for (const candidat of candidates) {
    // eslint-disable-next-line no-await-in-loop
    const lien = await findBinding({
      environment: fait.environment,
      resourceType: candidat.resourceType,
      resourceId: candidat.resourceId,
    }).catch(() => null);

    if (!lien) continue;
    if (lien.revokedAt) {
      revokedVia = revokedVia ?? candidat;
      continue;
    }

    return {
      outcome: OWNERSHIP_OUTCOME.RESOLVED,
      projectId: lien.projectId,
      via: { resourceType: candidat.resourceType, resourceId: candidat.resourceId },
      candidates,
      hasRelatedCandidate,
      revokedVia,
    };
  }

  if (revokedVia) {
    return { ...vide, outcome: OWNERSHIP_OUTCOME.REVOKED, revokedVia };
  }
  return { ...vide, outcome: OWNERSHIP_OUTCOME.NO_BINDING };
}

export default {
  OWNERSHIP_OUTCOME,
  ownershipCandidates,
  resolveStripeRevenueOwnership,
};
