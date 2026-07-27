// Enveloppes d'erreur des deux surfaces :
//   { success: false, code, message, details? }
// BridgeError (catalogue BRIDGE_*) et ApiError (catalogue PANEL_*) portent
// leur statut ; tout le reste est un 500 au message générique (jamais de
// stack ni de détail interne vers l'extérieur).
import { ZodError } from 'zod';
import { BRIDGE_ERROR_CODES, BridgeError } from '../bridge/bridgeContract.js';
import ApiError from '../utils/ApiError.js';
import logger from '../utils/logger.js';

export function notFoundHandler(req, res) {
  res.status(404).json({
    success: false,
    code: 'NOT_FOUND',
    message: `Route inconnue : ${req.method} ${req.path}`,
  });
}

// eslint-disable-next-line no-unused-vars
export function errorHandler(err, req, res, _next) {
  if (err instanceof BridgeError) {
    return res.status(err.statusCode).json({
      success: false,
      code: err.code,
      message: err.message,
      details: err.details ?? null,
    });
  }

  if (err instanceof ApiError) {
    return res.status(err.statusCode).json({
      success: false,
      code: err.code,
      message: err.message,
      details: err.details ?? null,
    });
  }

  if (err instanceof ZodError) {
    return res.status(400).json({
      success: false,
      code: 'VALIDATION_ERROR',
      message: 'Payload invalide.',
      details: err.issues.map((issue) => ({
        path: issue.path.join('.'),
        code: issue.code,
        message: issue.message,
      })),
    });
  }

  // Un corps JSON illisible (express.json) est une erreur du client.
  if (err?.type === 'entity.parse.failed') {
    const onBridge = req.path.startsWith('/bridge/');
    return res.status(400).json({
      success: false,
      code: onBridge ? BRIDGE_ERROR_CODES.INVALID_PAYLOAD : 'PANEL_INVALID_JSON',
      message: 'Corps de requête JSON illisible.',
    });
  }

  logger.error(`Erreur non gérée sur ${req.method} ${req.path} : ${err?.message ?? err}`);
  const onBridge = req.path.startsWith('/bridge/');
  return res.status(500).json({
    success: false,
    code: onBridge ? BRIDGE_ERROR_CODES.INTERNAL : 'PANEL_INTERNAL',
    message: 'Erreur interne.',
  });
}
