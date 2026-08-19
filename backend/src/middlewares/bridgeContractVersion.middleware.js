// Garde de version du contrat de pont — appliquée à TOUT le routeur
// /bridge/v1, ping compris (comportement identique au ProjectBridge du
// projet modèle) : l'en-tête de réponse est posé avant toute validation ;
// l'absence d'en-tête de requête vaut incompatibilité (409).
import {
  BRIDGE_ERROR_CODES,
  BridgeError,
  CONTRACT_VERSION,
  CONTRACT_VERSION_HEADER,
  isContractCompatible,
} from '../bridge/bridgeContract.js';

export function bridgeContractVersionGuard(req, res, next) {
  res.setHeader(CONTRACT_VERSION_HEADER, CONTRACT_VERSION);
  const requested = req.get(CONTRACT_VERSION_HEADER);
  if (!isContractCompatible(requested)) {
    // Le message DIT ce qui a été reçu et ce qui était attendu : « aucune »
    // (en-tête absent, donc un client qui ne l'émet pas) ne se diagnostique
    // pas comme « 2.0.0 » (majeures divergentes, donc miroirs à porter).
    // Miroir exact du message du ProjectBridge côté projet.
    return next(
      new BridgeError(
        BRIDGE_ERROR_CODES.CONTRACT_VERSION_UNSUPPORTED,
        `Version majeure du contrat non supportée (reçu : ${requested ?? 'aucune'}, attendu : ${CONTRACT_VERSION}).`,
      ),
    );
  }
  /**
   * ══ LA VERSION NÉGOCIÉE EST RETENUE, PAS SEULEMENT VÉRIFIÉE ═══════════════
   *
   * Cette garde lisait l'en-tête, jugeait la compatibilité, puis l'oubliait.
   * La conséquence se voyait ailleurs : la fiche d'un projet portait la version
   * relevée AU MOMENT DE L'APPAIRAGE, et rien ne la rafraîchissait ensuite. Un
   * projet monté de 1.4.0 à 1.8.0 continuait donc d'être affiché en 1.4.0 —
   * pendant qu'il parlait 1.8.0 à chaque requête, sous les yeux de cette garde.
   *
   * On la pose sur la requête. Ce qui la persiste décide plus loin ; ici, on se
   * contente de ne plus jeter ce qu'on vient de lire.
   */
  req.bridgeContractVersion = requested;
  return next();
}

export default bridgeContractVersionGuard;
