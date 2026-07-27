import { ok } from '../utils/apiResponse.js';
import { buildHealth, buildVersion } from '../services/health/health.service.js';

export function health(_req, res) {
  return ok(res, buildHealth());
}

export async function version(_req, res) {
  return ok(res, await buildVersion());
}
