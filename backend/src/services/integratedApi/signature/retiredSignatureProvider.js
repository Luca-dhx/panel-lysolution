/**
 * LE FOURNISSEUR DE SIGNATURE RETIRÉ — il répond encore, et il répond NON.
 *
 * ══ CE QUI A ÉTÉ SUPPRIMÉ, ET POURQUOI CE MODULE LE REMPLACE ════════════════
 *
 * `yousignTransport.js` et `yousignAdapters.js` n'existent plus. C'étaient les
 * seuls endroits du Panel qui parlaient HTTP à l'ancien fournisseur : un
 * client, une orchestration en cinq appels, et la lecture de sa clé.
 *
 * On ne les a pas simplement effacés. Le domaine « signature » a DEUX
 * exécutants possibles dans les liens d'appartenance déjà écrits, et le
 * contrôle d'alignement de `providerAdapters.js` exige que chacun serve TOUS
 * les actes. Une table absente aurait produit, sur une demande de 2025, une
 * exception nue (`table[code] is not a function`) au pire endroit : en
 * production, sans message, devant quelqu'un qui cherche son contrat.
 *
 * ══ POURQUOI LE RETRAIT EST SANS RISQUE, ET COMMENT ON LE SAIT ══════════════
 *
 * Mesuré avant de supprimer quoi que ce soit, sur les DEUX bases (TEST et
 * PROD) — `tools/opensign/inventaireLiens.mjs` :
 *
 *     demandes vivantes chez l'ancien fournisseur : 0
 *     liens antérieurs au champ `provider`        : 0
 *
 * Aucun engagement en cours n'a donc été abandonné. Si ce compte avait été
 * différent, le retrait aurait dû attendre — c'est la seule raison pour
 * laquelle cet inventaire existe.
 *
 * ══ « LES CONTRATS HISTORIQUES RESTENT LISIBLES » — ET ILS LE SONT ══════════
 *
 * Pas grâce à ce module : grâce au fait qu'un contrat signé est ARCHIVÉ dans le
 * projet à l'achèvement (`contract.document.signedFilename`). Sa lecture ne
 * dépend d'aucun fournisseur, et c'est ce qui rend ce retrait possible.
 *
 * Ce que ce module garantit, c'est qu'un appel qui viserait tout de même
 * l'ancien fournisseur obtienne une PHRASE, pas un plantage — et une phrase qui
 * dit où regarder.
 */
import {
  CAPABILITY_ERROR_CODES,
  CapabilityError,
} from '../../capabilities/capabilityErrors.js';

/** Le fournisseur que ce module remplace. Nommé une fois. */
export const RETIRED_SIGNATURE_PROVIDER = 'YOUSIGN';

/**
 * Le motif, stable et unique.
 *
 * Un motif par acte aurait laissé croire que certains actes pourraient
 * revenir. Aucun ne reviendra : c'est le fournisseur qui est parti.
 */
export const RETIRED_PROVIDER_REASON = 'SIGNATURE_PROVIDER_RETIRED';

/**
 * Les six actes du domaine. La liste est écrite ici plutôt que dérivée d'une
 * autre table : ce module doit rester lisible seul, et le contrôle
 * d'alignement se chargera de dire si elle diverge.
 */
const ACTES = Object.freeze([
  'signature.request.open',
  'signature.request.retrieve',
  'signature.signer.retrieve',
  'signature.document.download',
  'signature.certificate.download',
  'signature.request.cancel',
]);

/**
 * Ce qu'on répond, acte par acte — parce que l'action à mener n'est pas la
 * même, et qu'un message générique laisse l'appelant sans issue.
 */
const CONSEIL = Object.freeze({
  'signature.request.open':
    'Cette demande vise un fournisseur retiré. Une nouvelle signature part '
    + 'chez le fournisseur actif : relancez la depuis le contrat.',
  'signature.request.retrieve':
    'Cette demande a été servie par un fournisseur retiré : son état ne peut '
    + 'plus être relu. L’état enregistré au moment de l’achèvement fait foi.',
  'signature.signer.retrieve':
    'Les liens de signature de ce fournisseur ont expiré avec lui. Une '
    + 'nouvelle demande est le seul moyen de faire signer aujourd’hui.',
  'signature.document.download':
    'Ce contrat a été signé chez un fournisseur retiré. Son PDF signé a été '
    + 'archivé dans le projet à l’achèvement : c’est là qu’il se lit.',
  'signature.certificate.download':
    'Ce fournisseur ne publiait pas de certificat d’audit par cette voie, et '
    + 'il est retiré. La preuve d’audit vit dans l’espace de son compte.',
  'signature.request.cancel':
    'Cette demande ne peut plus être annulée chez un fournisseur retiré. '
    + 'Si elle est encore ouverte, elle doit être close depuis son espace.',
});

const refuser = (code, signatureRequestId) => {
  throw new CapabilityError(
    CAPABILITY_ERROR_CODES.NOT_AVAILABLE,
    CONSEIL[code] ?? 'Le fournisseur qui servait cette demande a été retiré.',
    {
      reason: RETIRED_PROVIDER_REASON,
      retiredProvider: RETIRED_SIGNATURE_PROVIDER,
      capability: code,
      signatureRequestId: signatureRequestId ?? null,
    },
  );
};

/**
 * La table, servie à `providerAdapters.js` sous le nom du fournisseur retiré.
 *
 * Chaque entrée REFUSE. Aucune ne lit de credential, aucune n'ouvre de
 * connexion — c'est ce qui fait de ce module un retrait et non un sursis.
 */
export const RETIRED_SIGNATURE_ADAPTERS = Object.freeze(
  Object.fromEntries(ACTES.map((code) => [
    code,
    async ({ input } = {}) => refuser(code, input?.signatureRequestId),
  ])),
);

export default { RETIRED_SIGNATURE_ADAPTERS, RETIRED_SIGNATURE_PROVIDER, RETIRED_PROVIDER_REASON };
