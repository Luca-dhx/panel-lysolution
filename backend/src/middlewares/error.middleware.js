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

  // BASE DE DONNÉES INJOIGNABLE — 503, pas 500.
  //
  // Quand MongoDB tombe pendant que le serveur tourne, Mongoose ne lève pas
  // tout de suite : il met l'opération en TAMPON, puis expire au bout de dix
  // secondes. Sans le cas ci-dessous, l'opérateur voyait « Erreur interne »
  // après dix secondes d'attente — indiscernable d'un bogue applicatif, et
  // sans aucune piste pour corriger.
  //
  // Un 503 nommé lui dit ce qui se passe et ce qu'il doit vérifier. Ce n'est
  // pas une erreur de sa saisie : ce serait mentir que de la lui reprocher.
  const database = describeDatabaseFailure(err);
  if (database) {
    logger.error(`Base indisponible sur ${req.method} ${req.path} : ${err?.message ?? err}`);
    return res.status(503).json({
      success: false,
      code: 'PANEL_DATABASE_UNAVAILABLE',
      message: database,
    });
  }

  // La stack complète part dans les journaux du serveur — jamais dans la
  // réponse, qui pourrait révéler la structure interne à un tiers.
  logger.error(`Erreur non gérée sur ${req.method} ${req.path} : ${err?.message ?? err}`);
  if (err?.stack) logger.error(err.stack);
  const onBridge = req.path.startsWith('/bridge/');
  return res.status(500).json({
    success: false,
    code: onBridge ? BRIDGE_ERROR_CODES.INTERNAL : 'PANEL_INTERNAL',
    message: 'Erreur interne.',
  });
}

/**
 * Reconnaît une panne de base de données et rend un message actionnable.
 *
 * Trois formes rencontrées, selon le moment de la panne :
 *   · `MongooseError` « buffering timed out » — la base est tombée pendant
 *     que le serveur tournait, l'opération a attendu puis expiré ;
 *   · `MongoNetworkError` / `MongoServerSelectionError` — injoignable au
 *     moment de l'appel ;
 *   · `ECONNREFUSED` — rien n'écoute sur le port.
 *
 * @returns {string|null} message pour l'opérateur, ou null si autre chose
 */
function describeDatabaseFailure(err) {
  const name = err?.name ?? '';
  const message = String(err?.message ?? '');

  const buffering = /buffering timed out/i.test(message);
  const selection = name === 'MongooseServerSelectionError' || name === 'MongoServerSelectionError';
  const network = name === 'MongoNetworkError' || /ECONNREFUSED|ENOTFOUND|ETIMEDOUT/i.test(message);

  if (!buffering && !selection && !network) return null;

  if (buffering) {
    return 'Opération impossible parce que la base de données ne répond plus : '
      + 'la requête a attendu dix secondes puis expiré. Vérifiez que MongoDB est démarré '
      + 'et joignable à l’adresse configurée (MONGODB_URI), puis réessayez. '
      + 'Votre saisie n’est pas en cause.';
  }
  return 'Opération impossible parce que la base de données est injoignable. '
    + 'Vérifiez que MongoDB est démarré et que MONGODB_URI pointe vers la bonne adresse. '
    + 'Votre saisie n’est pas en cause.';
}
