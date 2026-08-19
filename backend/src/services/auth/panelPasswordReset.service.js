import crypto from 'node:crypto';

import config from '../../config/env.js';
import ApiError from '../../utils/ApiError.js';
import logger from '../../utils/logger.js';
import { nowIso } from '../../bridge/bridgeContract.js';
import PanelUser from '../../models/PanelUser.model.js';
import PanelPasswordResetRequest, {
  PASSWORD_RESET_REQUEST_STATUS,
} from '../../models/PanelPasswordResetRequest.model.js';
import { invokeCapability } from '../capabilities/capabilityGateway.service.js';
import { INVOCATION_SOURCES } from '../capabilities/invocationContext.js';
import { resolveFrontendUrl } from '../network/networkConfig.service.js';
import { maskEmail } from '../integratedApi/brevo/brevoTransport.js';
import {
  PANEL_PASSWORD_POLICY,
  assertPanelPasswordPolicy,
  hashPassword,
  normalizePanelEmail,
} from './panelUsers.service.js';

export const PASSWORD_RESET_TEMPLATE_CODE = 'PASSWORD_RESET_REQUEST';
export const PASSWORD_RESET_ROUTE = '/reset-password';
export const PASSWORD_RESET_TOKEN_TTL_MINUTES = 30;
export const PASSWORD_RESET_EMAIL_COOLDOWN_MS = 60_000;
export const PASSWORD_RESET_EMAIL_WINDOW_MS = 30 * 60_000;
export const PASSWORD_RESET_EMAIL_MAX = 3;
export const PASSWORD_RESET_IP_WINDOW_MS = 15 * 60_000;
export const PASSWORD_RESET_IP_MAX = 10;

const GENERIC_RESPONSE = Object.freeze({
  accepted: true,
  message: 'Si un compte correspond à cette adresse, un e-mail de réinitialisation vous sera envoyé.',
});

const TEST_DEPS = {
  invokeCapabilityImpl: invokeCapability,
  resolveFrontendUrlImpl: resolveFrontendUrl,
};

let runtimeDeps = { ...TEST_DEPS };

export function __setPasswordResetTestDeps(overrides = {}) {
  runtimeDeps = { ...runtimeDeps, ...overrides };
}

export function __resetPasswordResetTestDeps() {
  runtimeDeps = { ...TEST_DEPS };
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value ?? '')).digest('hex');
}

function hashOpaque(value) {
  const clean = String(value ?? '').trim().toLowerCase();
  return clean ? sha256(clean) : '';
}

export function hashPasswordResetToken(token) {
  return sha256(token);
}

function buildResetRequestId() {
  return `password-reset-${crypto.randomUUID()}`;
}

function addMinutes(iso, minutes) {
  return new Date(Date.parse(iso) + (minutes * 60_000)).toISOString();
}

function isExpired(iso) {
  if (!iso) return true;
  const value = Date.parse(String(iso));
  return !Number.isFinite(value) || value <= Date.now();
}

function resetUrlFrom(baseUrl, token) {
  const url = new URL(baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`);
  const pathname = url.pathname.replace(/\/$/, '');
  url.pathname = `${pathname}${PASSWORD_RESET_ROUTE}`;
  url.search = '';
  url.searchParams.set('token', token);
  return url.toString();
}

function companyName() {
  return config.panelName.replace(/^Panel\s+/i, '').trim() || 'L.Y Solution';
}

async function logAttempt(payload) {
  await PanelPasswordResetRequest.create(payload);
}

async function updateAttempt(requestId, update) {
  await PanelPasswordResetRequest.updateOne({ requestId }, update);
}

async function assertRateLimit({ normalizedEmail, ip }) {
  const now = Date.now();
  const emailHash = hashOpaque(normalizedEmail);
  const ipHash = hashOpaque(ip);
  const emailSince = new Date(now - PASSWORD_RESET_EMAIL_WINDOW_MS).toISOString();
  const ipSince = new Date(now - PASSWORD_RESET_IP_WINDOW_MS).toISOString();

  const [recentEmailAttempts, recentIpAttempts] = await Promise.all([
    PanelPasswordResetRequest
      .find({ emailHash, requestedAt: { $gte: emailSince } })
      .sort({ requestedAt: -1 })
      .lean(),
    ipHash
      ? PanelPasswordResetRequest.countDocuments({ ipHash, requestedAt: { $gte: ipSince } })
      : Promise.resolve(0),
  ]);

  if (recentIpAttempts >= PASSWORD_RESET_IP_MAX) {
    throw new ApiError(
      429,
      'PASSWORD_RESET_RATE_LIMITED',
      'Trop de demandes de réinitialisation. Veuillez patienter avant de réessayer.',
    );
  }

  if (recentEmailAttempts.length >= PASSWORD_RESET_EMAIL_MAX) {
    throw new ApiError(
      429,
      'PASSWORD_RESET_RATE_LIMITED',
      'Trop de demandes de réinitialisation. Veuillez patienter avant de réessayer.',
    );
  }

  const latest = recentEmailAttempts[0];
  if (latest?.requestedAt && (now - Date.parse(latest.requestedAt)) < PASSWORD_RESET_EMAIL_COOLDOWN_MS) {
    throw new ApiError(
      429,
      'PASSWORD_RESET_RATE_LIMITED',
      'Une demande vient déjà d’être prise en charge. Veuillez patienter avant de réessayer.',
    );
  }
}

async function buildFrontendResetUrl(rawToken) {
  const resolved = await runtimeDeps.resolveFrontendUrlImpl();
  const frontendUrl = resolved?.url ?? null;
  if (!frontendUrl) {
    throw ApiError.conflict(
      'PANEL_FRONTEND_URL_UNAVAILABLE',
      'Impossible de construire le lien de réinitialisation : aucune URL frontend exploitable n’est configurée.',
    );
  }
  return {
    frontendUrl,
    resetUrl: resetUrlFrom(frontendUrl, rawToken),
  };
}

export function passwordResetResponse() {
  return { ...GENERIC_RESPONSE };
}

export async function requestPasswordReset({ email, ip = '', actor = null } = {}) {
  const normalizedEmail = normalizePanelEmail(email);
  if (!normalizedEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) {
    throw ApiError.badRequest('PASSWORD_RESET_EMAIL_INVALID', 'Adresse e-mail invalide.');
  }

  const requestedAt = nowIso();
  const emailHash = hashOpaque(normalizedEmail);
  const emailMasked = maskEmail(normalizedEmail);
  const ipHash = hashOpaque(ip);

  try {
    await assertRateLimit({ normalizedEmail, ip });
  } catch (error) {
    const requestId = buildResetRequestId();
    await logAttempt({
      requestId,
      userId: null,
      emailHash,
      emailMasked,
      ipHash,
      templateCode: PASSWORD_RESET_TEMPLATE_CODE,
      provider: 'BREVO',
      status: PASSWORD_RESET_REQUEST_STATUS.RATE_LIMITED,
      requestedAt,
      errorCode: error.code ?? 'PASSWORD_RESET_RATE_LIMITED',
      errorMessage: error.message,
    });
    throw error;
  }

  const user = await PanelUser.findOne({ email: normalizedEmail }).lean();
  const requestId = buildResetRequestId();

  if (!user) {
    await logAttempt({
      requestId,
      userId: null,
      emailHash,
      emailMasked,
      ipHash,
      templateCode: PASSWORD_RESET_TEMPLATE_CODE,
      provider: 'BREVO',
      status: PASSWORD_RESET_REQUEST_STATUS.IGNORED_UNKNOWN_ACCOUNT,
      requestedAt,
    });
    return passwordResetResponse();
  }

  const rawToken = crypto.randomBytes(32).toString('hex');
  const tokenHash = hashPasswordResetToken(rawToken);
  const expiresAt = addMinutes(requestedAt, PASSWORD_RESET_TOKEN_TTL_MINUTES);
  const { frontendUrl, resetUrl } = await buildFrontendResetUrl(rawToken);

  await logAttempt({
    requestId,
    userId: user.userId,
    emailHash,
    emailMasked,
    ipHash,
    templateCode: PASSWORD_RESET_TEMPLATE_CODE,
    provider: 'BREVO',
    frontendUrl,
    resetRoute: PASSWORD_RESET_ROUTE,
    tokenTtlMinutes: PASSWORD_RESET_TOKEN_TTL_MINUTES,
    status: PASSWORD_RESET_REQUEST_STATUS.REQUESTED,
    requestedAt,
  });

  await PanelUser.updateOne(
    { userId: user.userId },
    {
      $set: {
        passwordResetRequestId: requestId,
        passwordResetTokenHash: tokenHash,
        passwordResetExpiresAt: expiresAt,
        passwordResetRequestedAt: requestedAt,
      },
    },
  );

  try {
    const accepted = await runtimeDeps.invokeCapabilityImpl({
      code: 'email.send_template',
      panelProject: null,
      source: INVOCATION_SOURCES.PANEL_SELF,
      payload: {
        templateRef: PASSWORD_RESET_TEMPLATE_CODE,
        recipient: { email: user.email, name: user.displayName || user.email },
        variables: {
          'company.name': companyName(),
          'user.name': user.displayName || user.email,
          'auth.resetUrl': resetUrl,
          'auth.expiresMinutes': String(PASSWORD_RESET_TOKEN_TTL_MINUTES),
        },
        operationId: requestId,
      },
    });

    await updateAttempt(requestId, {
      $set: {
        status: PASSWORD_RESET_REQUEST_STATUS.EMAIL_ACCEPTED,
        providerMessageId: accepted?.result?.providerMessageId ?? null,
      },
    });
    logger.info(`[auth] password reset accepted for ${emailMasked} (${requestId}).`);
  } catch (error) {
    const code = error?.code ?? 'UNEXPECTED';
    const unknown = error?.replaySafe === false;
    await updateAttempt(requestId, {
      $set: {
        status: unknown
          ? PASSWORD_RESET_REQUEST_STATUS.EMAIL_UNKNOWN
          : PASSWORD_RESET_REQUEST_STATUS.EMAIL_REFUSED,
        errorCode: code,
        errorMessage: String(error?.message ?? '').slice(0, 300),
      },
    });
    logger.warn(`[auth] password reset not confirmed for ${emailMasked} (${requestId}) — ${code}.`);
  }

  void actor;
  return passwordResetResponse();
}

function passwordResetInvalid() {
  return ApiError.badRequest(
    'PASSWORD_RESET_TOKEN_INVALID',
    'Ce lien de réinitialisation n’est plus valide.',
  );
}

function passwordResetExpired() {
  return ApiError.badRequest(
    'PASSWORD_RESET_TOKEN_EXPIRED',
    'Ce lien de réinitialisation a expiré. Veuillez demander un nouveau lien.',
  );
}

export async function resetPasswordWithToken({
  token,
  password,
  passwordConfirmation = undefined,
} = {}) {
  const rawToken = String(token ?? '').trim();
  if (!rawToken) {
    throw ApiError.badRequest('PASSWORD_RESET_TOKEN_REQUIRED', 'Lien de réinitialisation incomplet.');
  }
  if (passwordConfirmation !== undefined && String(passwordConfirmation) !== String(password)) {
    throw ApiError.badRequest(
      'PASSWORD_RESET_PASSWORD_MISMATCH',
      'Les mots de passe ne correspondent pas.',
    );
  }

  try {
    assertPanelPasswordPolicy(password);
  } catch (error) {
    throw ApiError.badRequest(
      'PASSWORD_RESET_PASSWORD_POLICY',
      `Mot de passe refusé : ${PANEL_PASSWORD_POLICY.minLength} caractères minimum.`,
      { minLength: PANEL_PASSWORD_POLICY.minLength },
    );
  }

  const tokenHash = hashPasswordResetToken(rawToken);
  const stored = await PanelUser.findOne({ passwordResetTokenHash: tokenHash }).lean();
  if (!stored?.passwordResetRequestId) throw passwordResetInvalid();
  if (isExpired(stored.passwordResetExpiresAt)) throw passwordResetExpired();

  const nextPasswordHash = hashPassword(password);
  const completedAt = nowIso();
  const nextTokenVersion = (stored.tokenVersion ?? 0) + 1;

  const result = await PanelUser.updateOne(
    {
      userId: stored.userId,
      passwordResetRequestId: stored.passwordResetRequestId,
      passwordResetTokenHash: tokenHash,
      passwordResetExpiresAt: stored.passwordResetExpiresAt,
    },
    {
      $set: {
        passwordHash: nextPasswordHash,
        passwordChangedAt: completedAt,
        tokenVersion: nextTokenVersion,
      },
      $unset: {
        passwordResetRequestId: '',
        passwordResetTokenHash: '',
        passwordResetExpiresAt: '',
        passwordResetRequestedAt: '',
      },
    },
  );

  if (result.matchedCount === 0 || result.modifiedCount === 0) throw passwordResetInvalid();

  await updateAttempt(stored.passwordResetRequestId, {
    $set: {
      status: PASSWORD_RESET_REQUEST_STATUS.COMPLETED,
      completedAt,
    },
  });

  logger.info(`[auth] password reset completed for ${maskEmail(stored.email)} (${stored.passwordResetRequestId}).`);
  return { reset: true };
}

export async function applyPasswordResetDeliveryEvent({
  operationId,
  event,
  providerEvent = null,
  occurredAt = null,
  reason = null,
} = {}) {
  const status = event === 'EMAIL_DELIVERED'
    ? PASSWORD_RESET_REQUEST_STATUS.EMAIL_DELIVERED
    : event === 'EMAIL_BOUNCED'
      ? PASSWORD_RESET_REQUEST_STATUS.EMAIL_BOUNCED
      : null;
  if (!status || !operationId) return { applied: false, reason: 'EVENT_NOT_PROJECTED' };

  const current = await PanelPasswordResetRequest.findOne({ requestId: operationId }).lean();
  if (!current) return { applied: false, reason: 'NO_MATCHING_REQUEST' };

  const update = {
    status: current.status === PASSWORD_RESET_REQUEST_STATUS.COMPLETED
      ? PASSWORD_RESET_REQUEST_STATUS.COMPLETED
      : status,
    lastWebhookAt: occurredAt ?? nowIso(),
    lastWebhookEvent: providerEvent,
    lastWebhookReason: reason ? String(reason).slice(0, 200) : null,
  };
  const result = await PanelPasswordResetRequest.updateOne({ requestId: operationId }, { $set: update });
  return { applied: result.matchedCount > 0 };
}

export async function describePasswordResetRequest(requestId) {
  const stored = await PanelPasswordResetRequest.findOne({ requestId }).lean();
  return stored ?? null;
}

export default {
  PASSWORD_RESET_TEMPLATE_CODE,
  PASSWORD_RESET_ROUTE,
  PASSWORD_RESET_TOKEN_TTL_MINUTES,
  PASSWORD_RESET_EMAIL_COOLDOWN_MS,
  PASSWORD_RESET_EMAIL_WINDOW_MS,
  PASSWORD_RESET_EMAIL_MAX,
  PASSWORD_RESET_IP_WINDOW_MS,
  PASSWORD_RESET_IP_MAX,
  hashPasswordResetToken,
  passwordResetResponse,
  requestPasswordReset,
  resetPasswordWithToken,
  applyPasswordResetDeliveryEvent,
  describePasswordResetRequest,
  __setPasswordResetTestDeps,
  __resetPasswordResetTestDeps,
};
