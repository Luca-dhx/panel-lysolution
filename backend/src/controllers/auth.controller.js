import { z } from 'zod';
import ApiError from '../utils/ApiError.js';
import { ok } from '../utils/apiResponse.js';
import { authenticate } from '../services/auth/panelUsers.service.js';
import { issueUserToken } from '../services/auth/panelToken.service.js';

const loginSchema = z
  .object({
    email: z.string().email(),
    password: z.string().min(1),
  })
  .strict();

export function login(req, res) {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) {
    throw ApiError.badRequest('PANEL_INVALID_PAYLOAD', 'email et password sont requis.');
  }
  const user = authenticate(parsed.data.email, parsed.data.password);
  if (!user) {
    throw ApiError.unauthorized('PANEL_INVALID_CREDENTIALS', 'Identifiants invalides.');
  }
  return ok(res, { token: issueUserToken(user), user });
}

export function me(req, res) {
  return ok(res, { user: req.panelUser });
}
