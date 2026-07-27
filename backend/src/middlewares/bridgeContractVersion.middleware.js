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
    return next(
      new BridgeError(
        BRIDGE_ERROR_CODES.CONTRACT_VERSION_UNSUPPORTED,
        'Version majeure du contrat non supportée.',
      ),
    );
  }
  return next();
}

export default bridgeContractVersionGuard;
