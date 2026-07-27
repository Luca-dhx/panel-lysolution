// ============================================================================
// MIROIR EXÉCUTABLE des contrats OpenAPI v1.0.0 des ponts.
//   docs/spec/PanelBridge.openapi.yaml   (le Panel SERT ce contrat)
//   docs/spec/ProjectBridge.openapi.yaml (le Panel CONSOMME ce contrat)
// Toute requête entrante sur /bridge/v1 est validée par ce fichier ; toute
// évolution passe d'abord par les specs (ratifiées dans le projet modèle) —
// tests/bridge-conformity.test.js verrouille l'accord specs ↔ miroir.
// Ce module ne dépend de rien d'autre que zod et node:crypto.
// ============================================================================
import crypto from 'node:crypto';
import { z } from 'zod';

export const CONTRACT_VERSION = '1.0.0';
export const CONTRACT_VERSION_HEADER = 'x-bridge-contract-version';

export const SEMVER_RE = /^\d+\.\d+\.\d+$/;

// ---------------------------------------------------------------- routes ----
// Chemins servis par le Panel (contrat PanelBridge).
export const PANEL_API_ROUTES = Object.freeze({
  ping: '/bridge/v1/ping',
  pairings: '/bridge/v1/pairings',
  pairingCurrent: '/bridge/v1/pairings/current',
  heartbeats: '/bridge/v1/heartbeats',
  syncPush: '/bridge/v1/sync/push',
  syncPull: '/bridge/v1/sync/pull',
});

// Chemins exposés par chaque projet (contrat ProjectBridge), consommés par
// ProjectBridgeClient. `{operationId}` est un paramètre de chemin.
export const PROJECT_API_ROUTES = Object.freeze({
  ping: '/api/project-bridge/v1/ping',
  identity: '/api/project-bridge/v1/identity',
  health: '/api/project-bridge/v1/health',
  syncPush: '/api/project-bridge/v1/sync/push',
  syncPull: '/api/project-bridge/v1/sync/pull',
  operations: '/api/project-bridge/v1/operations',
  operationInvoke: '/api/project-bridge/v1/operations/{operationId}/invoke',
  unpair: '/api/project-bridge/v1/unpair',
});

// ---------------------------------------------------------------- erreurs ---
export const BRIDGE_ERROR_CODES = Object.freeze({
  UNAUTHORIZED: 'BRIDGE_UNAUTHORIZED',
  PAIRING_CODE_INVALID: 'BRIDGE_PAIRING_CODE_INVALID',
  ALREADY_PAIRED: 'BRIDGE_ALREADY_PAIRED',
  NOT_PAIRED: 'BRIDGE_NOT_PAIRED',
  CONTRACT_VERSION_UNSUPPORTED: 'BRIDGE_CONTRACT_VERSION_UNSUPPORTED',
  INVALID_PAYLOAD: 'BRIDGE_INVALID_PAYLOAD',
  ENTITY_TYPE_UNSUPPORTED: 'BRIDGE_ENTITY_TYPE_UNSUPPORTED',
  OPERATION_UNKNOWN: 'BRIDGE_OPERATION_UNKNOWN',
  OPERATION_FAILED: 'BRIDGE_OPERATION_FAILED',
  RATE_LIMITED: 'BRIDGE_RATE_LIMITED',
  INTERNAL: 'BRIDGE_INTERNAL',
});

// Catalogues exacts des deux specs (le sens Panel n'inclut pas
// ENTITY_TYPE_UNSUPPORTED dans son enum d'ErrorResponse — il n'apparaît que
// comme code d'accusé REJECTED ; le sens Projet l'inclut).
export const PANEL_BRIDGE_ERROR_ENUM = Object.freeze([
  'BRIDGE_UNAUTHORIZED',
  'BRIDGE_PAIRING_CODE_INVALID',
  'BRIDGE_ALREADY_PAIRED',
  'BRIDGE_NOT_PAIRED',
  'BRIDGE_CONTRACT_VERSION_UNSUPPORTED',
  'BRIDGE_INVALID_PAYLOAD',
  'BRIDGE_OPERATION_UNKNOWN',
  'BRIDGE_OPERATION_FAILED',
  'BRIDGE_RATE_LIMITED',
  'BRIDGE_INTERNAL',
]);

export const PROJECT_BRIDGE_ERROR_ENUM = Object.freeze([
  ...PANEL_BRIDGE_ERROR_ENUM.slice(0, 6),
  'BRIDGE_ENTITY_TYPE_UNSUPPORTED',
  ...PANEL_BRIDGE_ERROR_ENUM.slice(6),
]);

// Codes d'erreur locaux (jamais sur le réseau) : états constatés par le
// client sortant du Panel.
export const LOCAL_ERROR_CODES = Object.freeze({
  PROJECT_UNREACHABLE: 'PROJECT_UNREACHABLE',
});

const STATUS_BY_CODE = Object.freeze({
  [BRIDGE_ERROR_CODES.UNAUTHORIZED]: 401,
  [BRIDGE_ERROR_CODES.PAIRING_CODE_INVALID]: 401,
  [BRIDGE_ERROR_CODES.ALREADY_PAIRED]: 409,
  [BRIDGE_ERROR_CODES.NOT_PAIRED]: 503,
  [BRIDGE_ERROR_CODES.CONTRACT_VERSION_UNSUPPORTED]: 409,
  [BRIDGE_ERROR_CODES.INVALID_PAYLOAD]: 400,
  [BRIDGE_ERROR_CODES.ENTITY_TYPE_UNSUPPORTED]: 422,
  [BRIDGE_ERROR_CODES.OPERATION_UNKNOWN]: 404,
  [BRIDGE_ERROR_CODES.OPERATION_FAILED]: 422,
  [BRIDGE_ERROR_CODES.RATE_LIMITED]: 429,
  [BRIDGE_ERROR_CODES.INTERNAL]: 500,
  [LOCAL_ERROR_CODES.PROJECT_UNREACHABLE]: 503,
});

export class BridgeError extends Error {
  constructor(code, message, extra = null) {
    super(message);
    this.name = 'BridgeError';
    this.code = code;
    this.statusCode = STATUS_BY_CODE[code] ?? 500;
    this.details = extra ? { code, ...extra } : { code };
  }
}

// ------------------------------------------------------------------- sync ---
export const SYNC_ENTITY_TYPES = Object.freeze([
  'DIAGNOSTIC',
  'CONTRACT',
  'INVOICE',
  'PAYMENT',
  'CONTRACT_DOCUMENT',
  'DEV_COMPANY',
  'TEAM_MEMBER',
  'EMAIL_TEMPLATE',
  'INTEGRATED_API_CONFIG',
  'INTEGRATED_API_MODE',
  'EVENT',
  'MEETING',
]);

// Seuls types appliqués en Phase 2B — les autres répondent REJECTED
// (BRIDGE_ENTITY_TYPE_UNSUPPORTED), jamais un 500.
export const APPLIED_ENTITY_TYPES = Object.freeze(['DIAGNOSTIC']);

export const EMITTERS = Object.freeze({ PANEL: 'PANEL', PROJECT: 'PROJECT' });

export const ACK_STATUS = Object.freeze({
  APPLIED: 'APPLIED',
  DUPLICATE: 'DUPLICATE',
  IGNORED: 'IGNORED',
  REJECTED: 'REJECTED',
});

// ---------------------------------------------------------------- schémas ---
const semver = z.string().regex(SEMVER_RE, 'version sémantique attendue (x.y.z)');
const isoDate = z.string().datetime({ offset: true });

export const bootstrapRequestSchema = z
  .object({
    contractVersion: semver,
    projectKey: z.string().min(3).max(120),
    projectName: z.string().min(1),
    environment: z.enum(['TEST', 'PROD']),
    softwareVersion: z.string().min(1),
    publicBackendUrl: z.string().url().nullable().optional(),
    pairingCode: z.string().min(1),
  })
  .strict();

export const heartbeatSchema = z
  .object({
    sentAt: isoDate,
    softwareVersion: z.string().min(1),
    environment: z.enum(['TEST', 'PROD']),
    health: z
      .object({
        status: z.enum(['OK', 'DEGRADED']),
        details: z.string().nullable().optional(),
      })
      .strict(),
    bridgeStats: z
      .object({
        outboxSize: z.number().int().min(0).optional(),
        lastSyncAt: isoDate.nullable().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export const syncChangeSchema = z
  .object({
    writeId: z.string().uuid(),
    entityType: z.enum(SYNC_ENTITY_TYPES),
    entityId: z.string().uuid(),
    deleted: z.boolean(),
    payload: z.unknown().nullable().optional(),
    modifiedAt: isoDate,
    emitter: z.enum([EMITTERS.PANEL, EMITTERS.PROJECT]),
  })
  .strict();

export const syncPushRequestSchema = z
  .object({
    changes: z.array(syncChangeSchema).min(1).max(500),
  })
  .strict();

export const syncPullQuerySchema = z
  .object({
    cursor: z.string().min(1).optional(),
    limit: z.coerce.number().int().min(1).max(500).default(100),
  })
  .strict();

// ------------------------------------------------------------- utilitaires --
export function parseOrThrow(schema, value, label) {
  const result = schema.safeParse(value);
  if (!result.success) {
    const issues = result.error.issues.map((issue) => ({
      path: issue.path.join('.'),
      code: issue.code,
      message: issue.message,
    }));
    throw new BridgeError(
      BRIDGE_ERROR_CODES.INVALID_PAYLOAD,
      `${label} non conforme au contrat.`,
      { issues },
    );
  }
  return result.data;
}

export function isContractCompatible(version) {
  if (typeof version !== 'string' || !SEMVER_RE.test(version.trim())) return false;
  return version.trim().split('.')[0] === CONTRACT_VERSION.split('.')[0];
}

export function newBridgeId() {
  return crypto.randomUUID();
}

export function nowIso() {
  return new Date().toISOString();
}
