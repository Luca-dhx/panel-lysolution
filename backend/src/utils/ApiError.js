// Erreurs de la surface interne /api (catalogue PANEL_*).
// Les erreurs de la surface /bridge/v1 utilisent BridgeError (bridgeContract.js).
export class ApiError extends Error {
  constructor(statusCode, code, message, details = null) {
    super(message);
    this.name = 'ApiError';
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }

  static badRequest(code, message, details = null) {
    return new ApiError(400, code, message, details);
  }

  static unauthorized(code, message) {
    return new ApiError(401, code, message);
  }

  static forbidden(code, message) {
    return new ApiError(403, code, message);
  }

  static notFound(code, message) {
    return new ApiError(404, code, message);
  }

  static conflict(code, message, details = null) {
    return new ApiError(409, code, message, details);
  }
}

export default ApiError;
