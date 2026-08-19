import { z } from 'zod';
import ApiError from '../utils/ApiError.js';
import { ok } from '../utils/apiResponse.js';
import { authenticate, authenticateForSession } from '../services/auth/panelUsers.service.js';
import { issueUserToken } from '../services/auth/panelToken.service.js';
import {
  passwordResetResponse,
  requestPasswordReset,
  resetPasswordWithToken,
} from '../services/auth/panelPasswordReset.service.js';

const loginSchema = z
  .object({
    email: z.string().trim().email(),
    password: z.string().min(1),
  })
  .strict();

const forgotPasswordSchema = z
  .object({
    email: z.string().trim().email(),
  })
  .strict();

const resetPasswordSchema = z
  .object({
    token: z.string().min(1),
    password: z.string().min(1),
    passwordConfirmation: z.string().min(1).optional(),
  })
  .strict();

export async function login(req, res) {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) {
    throw ApiError.badRequest('PANEL_INVALID_PAYLOAD', 'email et password sont requis.');
  }
  const user = await authenticateForSession(parsed.data.email, parsed.data.password);
  if (!user) {
    throw ApiError.unauthorized('PANEL_INVALID_CREDENTIALS', 'Identifiants invalides.');
  }
  const { tokenVersion, ...publicUser } = user;
  return ok(res, { token: issueUserToken(user), user: publicUser });
}

export async function forgotPassword(req, res) {
  const parsed = forgotPasswordSchema.safeParse(req.body);
  if (!parsed.success) {
    throw ApiError.badRequest('PANEL_INVALID_PAYLOAD', 'Adresse e-mail invalide.');
  }
  await requestPasswordReset({
    email: parsed.data.email,
    ip: req.ip,
  });
  return ok(res, passwordResetResponse());
}

export async function resetPassword(req, res) {
  const parsed = resetPasswordSchema.safeParse(req.body);
  if (!parsed.success) {
    throw ApiError.badRequest('PANEL_INVALID_PAYLOAD', 'token et password sont requis.');
  }
  const result = await resetPasswordWithToken(parsed.data);
  return ok(res, result);
}

export function me(req, res) {
  return ok(res, { user: req.panelUser });
}
