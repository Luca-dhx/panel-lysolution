// Authentification de la surface /bridge/v1 : Bearer bridgeToken → fiche
// projet appairée (hash SHA-256, comparaison temps constant). Pose
// req.bridgeProject. Totalement disjointe du JWT des utilisateurs du Panel.
import { BRIDGE_ERROR_CODES, BridgeError } from '../bridge/bridgeContract.js';
import { authenticateBridgeToken } from '../services/pairing/pairing.service.js';

export async function requireBridgeAuth(req, _res, next) {
  const header = req.get('authorization') ?? '';
  const token = header.startsWith('Bearer ') ? header.slice('Bearer '.length).trim() : null;
  const record = token ? await authenticateBridgeToken(token) : null;
  if (!record) {
    return next(
      new BridgeError(
        BRIDGE_ERROR_CODES.UNAUTHORIZED,
        'Credentials de pont invalides ou révoqués.',
      ),
    );
  }
  req.bridgeProject = record;
  return next();
}

export default requireBridgeAuth;
