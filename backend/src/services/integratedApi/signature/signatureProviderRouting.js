// QUI EXÉCUTE CETTE SIGNATURE ? — l'aiguillage, et il est EXPLICITE.
//
// docs/integrated-api/OPENSIGN_MIGRATION_CAMPAIGN.md.
//
// ══ LE PROBLÈME QUE CE MODULE RÉSOUT ════════════════════════════════════════
//
// Après la bascule, deux populations de demandes coexistent, et elles ne
// coexisteront pas quelques jours : un contrat signé chez Yousign doit rester
// relisible aussi longtemps qu'il a une valeur juridique.
//
//   OUVRIR    n'a qu'une réponse : le fournisseur ACTIF. Une nouvelle demande
//             part chez OpenSign, aujourd'hui et pour toutes les suivantes.
//
//   RELIRE, ANNULER, TÉLÉCHARGER  nomment une demande EXISTANTE. La réponse est
//             donc portée par la demande elle-même, pas par une préférence
//             globale.
//
// ══ CE QUI EST INTERDIT, ET POURQUOI ════════════════════════════════════════
//
//   « ESSAYER OPENSIGN, PUIS YOUSIGN »
//
// C'est la solution qui vient naturellement, et elle est fausse pour trois
// raisons cumulatives :
//
//  1. sur un identifiant inconnu du premier, on interroge le second avec les
//     identifiants d'un compte qui ne le connaît pas davantage : deux refus,
//     aucune information, latence doublée ;
//  2. le premier appel PART. Sur une annulation, « essayer » signifie tenter
//     d'annuler chez un fournisseur qui n'a rien à annuler — et un jour, chez
//     un fournisseur qui a quelque chose d'autre sous le même identifiant ;
//  3. le repli masque la vraie panne. Un OpenSign momentanément injoignable
//     ferait basculer silencieusement sur Yousign, et l'exploitation ne verrait
//     jamais l'incident.
//
// Le fournisseur est donc LU sur le lien d'appartenance, écrit avant le premier
// appel. Une demande sans lien n'est pas « probablement Yousign » : elle est
// inconnue, et l'appartenance la refuse déjà pour cette raison.
import PanelSignatureBinding from '../../../models/PanelSignatureBinding.model.js';

/**
 * LE FOURNISSEUR ACTIF — code-first, une seule ligne, aucune bascule à chaud.
 *
 * ══ POURQUOI PAS UN RÉGLAGE EN BASE ════════════════════════════════════════
 *
 * Un sélecteur administrable aurait l'air plus souple. Il rendrait surtout
 * possible d'ouvrir une signature chez un fournisseur dont personne n'a vérifié
 * qu'il est configuré, testé et joignable — et de le faire depuis un écran, en
 * un clic, sans revue.
 *
 * Changer de fournisseur est un acte d'architecture : il se relit dans un
 * diff, il se date, et il passe par les tests qui l'accompagnent. C'est
 * exactement la doctrine du registre des fournisseurs lui-même.
 */
export const ACTIVE_SIGNATURE_PROVIDER = 'OPENSIGN';

/**
 * LE FOURNISSEUR DES DEMANDES ANTÉRIEURES AU CHAMP `provider`.
 *
 * Les liens écrits avant l'introduction du champ n'en portent pas. Ils sont
 * TOUS Yousign — c'était le seul fournisseur de signature du parc. Ce n'est
 * donc pas une supposition mais un fait historique, et la migration l'inscrit
 * une fois pour toutes ; cette constante ne sert qu'aux liens qu'elle n'aurait
 * pas atteints.
 */
export const LEGACY_SIGNATURE_PROVIDER = 'YOUSIGN';

/**
 * Le fournisseur qui détient une demande, ou `null` si elle est inconnue.
 *
 * `null` n'est PAS un motif de repli : c'est ce que l'appartenance refusera
 * juste après, avec son propre message. Rendre le fournisseur actif « à tout
 * hasard » enverrait un identifiant étranger chez un fournisseur réel.
 */
export async function providerOfSignatureRequest({ environment, signatureRequestId }) {
  const id = String(signatureRequestId ?? '').trim();
  if (!id) return null;
  const lien = await PanelSignatureBinding.findOne({
    environment, resourceId: id,
  }).select('provider').lean();
  if (!lien) return null;
  return lien.provider ?? LEGACY_SIGNATURE_PROVIDER;
}

/**
 * L'exécutant d'une invocation de capacité.
 *
 * @param {object} context   contexte d'invocation (porte l'environnement)
 * @param {object} input     entrée DÉJÀ validée
 * @param {string} fallback  le fournisseur déclaré au registre — utilisé quand
 *   l'entrée ne nomme aucune demande (le cas de l'ouverture), et quand la
 *   demande est inconnue (l'appartenance tranchera).
 */
export async function resolveSignatureProvider(context, input, fallback = ACTIVE_SIGNATURE_PROVIDER) {
  if (!input?.signatureRequestId) return fallback;
  const detenteur = await providerOfSignatureRequest({
    environment: context.environment,
    signatureRequestId: input.signatureRequestId,
  });
  return detenteur ?? fallback;
}

export default {
  ACTIVE_SIGNATURE_PROVIDER,
  LEGACY_SIGNATURE_PROVIDER,
  providerOfSignatureRequest,
  resolveSignatureProvider,
};
