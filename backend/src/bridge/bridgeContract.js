// ============================================================================
// MIROIR EXÉCUTABLE des contrats OpenAPI v1.4.0 des ponts.
//   docs/spec/PanelBridge.openapi.yaml   (le Panel SERT ce contrat)
//   docs/spec/ProjectBridge.openapi.yaml (le Panel CONSOMME ce contrat)
// Toute requête entrante sur /bridge/v1 est validée par ce fichier ; toute
// évolution passe d'abord par les specs (ratifiées dans le projet modèle) —
// tests/bridge-conformity.test.js verrouille l'accord specs ↔ miroir.
// Ce module ne dépend de rien d'autre que zod et node:crypto.
//
// Historique : 1.0.0 (Phase 1) — surface initiale ; 1.1.0 (Phase 2A, ADDITIF)
// — BootstrapRequest.manifest optionnel + GET /manifest côté ProjectBridge
// (schéma ProjectManifest identique aux deux specs) ; 1.2.0 (Phase 3A,
// ADDITIF) — supervision en LECTURE SEULE : Heartbeat.runtime (uptime,
// charge, composants), Heartbeat.engines, ProjectManifest.engines /
// .network / .descriptor. Tous OPTIONNELS ; 1.3.0 (Phase 4, ADDITIF) —
// DÉCOUVERTE DESCENDANTE : BootstrapResponse.company / .integratedApis /
// .syncCursor, et Identity.appliedConfiguration côté ProjectBridge (ce que le
// projet a réellement appliqué). Tous OPTIONNELS ; 1.4.0 (ADDITIF) — IDENTITÉ
// AU PING : PingResponse.projectKey / .projectName côté ProjectBridge. Le
// Panel reconnaît un projet AVANT l'appairage au lieu d'en faire ressaisir la
// clé — `/identity` exige un bridgeToken qui n'existe pas encore à ce moment.
// Tous OPTIONNELS.
// ============================================================================
import crypto from 'node:crypto';
import { z } from 'zod';

export const CONTRACT_VERSION = '1.4.0';
export const CONTRACT_VERSION_HEADER = 'x-bridge-contract-version';

// Version du FORMAT de manifeste (indépendante de la version du contrat).
export const MANIFEST_FORMAT_VERSION = '1.0.0';

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
  manifest: '/api/project-bridge/v1/manifest',
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
  // >= 1.4.x — IDENTITE COMMERCIALE poussee par le projet. Le manifeste
  // ne la porte qu'au (re)chargement ; cette entite la fait remonter a
  // CHAQUE modification, sans action humaine.
  'PROJECT_PRESENTATION',
]);

// Types réellement APPLIQUÉS par ce Panel — les autres répondent REJECTED
// (BRIDGE_ENTITY_TYPE_UNSUPPORTED), jamais un 500. Cette liste DOIT rester
// alignée sur la table de projecteurs (`services/sync/projectors.js`) : elle
// est ce que le Panel déclare, la table est ce qu'il sait faire. Un test de
// synchronisation vérifie qu'elles ne divergent pas.
export const APPLIED_ENTITY_TYPES = Object.freeze([
  'DIAGNOSTIC',
  'PROJECT_PRESENTATION',
  'CONTRACT',
  'TEAM_MEMBER',
]);

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

// ProjectManifest (schéma IDENTIQUE dans les deux specs). Le Panel est un
// LECTEUR TOLÉRANT : les champs requis par la spec sont exigés, mais les
// propriétés additionnelles d'une mineure de format plus récente sont
// tolérées (pas de .strict() — l'OpenAPI ne déclare pas
// additionalProperties: false sur ces objets).
export const projectManifestSchema = z.object({
  manifestVersion: semver,
  project: z.object({
    key: z.string().min(3).max(120),
    name: z.string().min(1),
    environment: z.enum(['TEST', 'PROD']),
    softwareVersion: z.string().min(1),
  }),
  bridge: z.object({
    contractVersion: semver,
    projectBridgeBasePath: z.string().min(1),
  }),
  contracts: z.object({
    panelBridge: semver,
    projectBridge: semver,
  }),
  sync: z.object({
    supportedEntityTypes: z.array(z.enum(SYNC_ENTITY_TYPES)),
    operations: z.array(z.string()),
  }),
  modules: z.array(
    z.object({
      id: z.string().min(1),
      title: z.string().min(1),
      status: z.enum(['ACTIVE', 'OPTIONAL']),
    }),
  ),
  features: z.array(
    z.object({
      id: z.string().min(1),
      status: z.enum(['AVAILABLE', 'RESERVED']),
    }),
  ),
  // Contrat >= 1.2.0 — supervision en lecture seule : tous optionnels.
  engines: z.object({ deployment: semver.optional(), duplication: semver.optional() }).optional(),
  network: z
    .object({
      primaryDomain: z.string().nullable().optional(),
      urls: z.record(z.string().min(1), z.string()).optional(),
    })
    .optional(),
  // PRÉSENTATION (>= 1.4.x, ADDITIF) — l'identité COMMERCIALE du projet.
  // Sans elle, le Panel affichait le nom technique du projet et l'URL de son
  // API comme s'il s'agissait du client et de son site. Tous les champs sont
  // optionnels : un projet qui ne publie rien reste pleinement conforme, et
  // l'absence se distingue d'une valeur vide.
  //
  // `logoUrl` / `faviconUrl` sont TOUJOURS des URL absolues joignables : le
  // projet résout lui-même ses chemins locaux contre son propre domaine public
  // — la convention est documentée côté projet modèle. Le Panel se contente de
  // pointer l'adresse distante : il ne copie ni ne stocke aucun média.
  presentation: z
    .object({
      companyName: z.string().min(1).optional(),
      tagline: z.string().min(1).optional(),
      logoUrl: z.string().url().optional(),
      faviconUrl: z.string().url().optional(),
      contacts: z
        .object({
          email: z.string().min(1).optional(),
          phone: z.string().min(1).optional(),
          website: z.string().min(1).optional(),
        })
        .strict()
        .optional(),
    })
    .strict()
    .optional(),
  descriptor: z
    .object({
      // Nom LISIBLE du projet, tel qu'il se nomme (>= 1.4.x).
      name: z.string().min(1).optional(),
      type: z.string().optional(),
      description: z.string().optional(),
      layout: z.string().optional(),
    })
    .optional(),
});

export const bootstrapRequestSchema = z
  .object({
    contractVersion: semver,
    projectKey: z.string().min(3).max(120),
    projectName: z.string().min(1),
    environment: z.enum(['TEST', 'PROD']),
    softwareVersion: z.string().min(1),
    publicBackendUrl: z.string().url().nullable().optional(),
    pairingCode: z.string().min(1),
    // Contrat ≥ 1.1.0 : le projet se présente complètement dès l'appairage.
    manifest: projectManifestSchema.optional(),
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
    // Contrat >= 1.2.0 — SUPERVISION EN LECTURE SEULE. Tous optionnels : un
    // projet qui ne les publie pas reste pleinement conforme.
    runtime: z
      .object({
        uptimeSeconds: z.number().int().min(0).optional(),
        startedAt: isoDate.nullable().optional(),
        load: z
          .object({
            cpuPercent: z.number().min(0).optional(),
            memoryUsedMb: z.number().min(0).optional(),
            memoryTotalMb: z.number().min(0).optional(),
          })
          .strict()
          .optional(),
        components: z.record(z.string().min(1), z.enum(['OK', 'WARNING', 'ERROR', 'UNKNOWN'])).optional(),
      })
      .strict()
      .optional(),
    engines: z
      .object({ deployment: semver.optional(), duplication: semver.optional() })
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

/**
 * PAYLOADS MÉTIER — le transport reste générique (`payload: z.unknown()`),
 * mais chaque type appliqué valide STRICTEMENT son contenu avant projection.
 *
 * Sans cela, un projet plus récent — ou fautif — écrirait n'importe quoi dans
 * les collections du Panel, et l'erreur ne se verrait qu'à l'affichage. Un
 * payload non conforme est REJETÉ, sans écriture partielle.
 */
export const projectPresentationPayloadSchema = z
  .object({
    companyName: z.string().min(1).optional(),
    tagline: z.string().min(1).optional(),
    logoUrl: z.string().url().optional(),
    faviconUrl: z.string().url().optional(),
    contacts: z
      .object({
        email: z.string().min(1).optional(),
        phone: z.string().min(1).optional(),
        website: z.string().min(1).optional(),
      })
      .strict()
      .optional(),
    project: z
      .object({
        name: z.string().min(1).optional(),
        description: z.string().min(1).optional(),
      })
      .strict()
      .optional(),
    network: z
      .object({
        website: z.string().min(1).optional(),
        manager: z.string().min(1).optional(),
        backend: z.string().min(1).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

/**
 * CONTRAT projeté — strictement ce que le Panel affiche. Pas de date
 * d'expiration : elle n'existe nulle part, et l'inventer serait pire que de
 * ne rien montrer.
 */
/**
 * TEAM_MEMBER — l'équipe du projet, telle que le projet la tient.
 *
 * Schéma FERMÉ, et c'est ici que se joue la protection : un projet qui
 * publierait par mégarde un mot de passe haché, un jeton ou un secret verrait
 * son écriture REFUSÉE. La liste blanche vaut mieux qu'une liste noire — on
 * n'a pas à deviner le nom du champ sensible de demain.
 *
 * Ni `lastLoginAt` ni statut actif : le modèle source ne les porte pas.
 */
export const teamMemberPayloadSchema = z
  .object({
    sourceUserId: z.string().min(1),
    email: z.string().min(1),
    name: z.string().min(1).optional(),
    role: z.string().min(1),
    createdAt: z.string().nullable().optional(),
  })
  .strict();

/** Métadonnées d'un document contractuel — partagées par le courant et l'histoire. */
const contractDocumentSchema = z
    .object({
      available: z.boolean(),
      /**
       * L'état RÉEL du document, tel que le projet le constate en croisant
       * sa base et son stockage. `UNAVAILABLE` n'est pas `NONE` : le premier
       * dit « référencé mais introuvable », le second « jamais produit ».
       */
      status: z.enum(['NONE', 'GENERATED', 'PENDING_SIGNATURE', 'SIGNED', 'UNAVAILABLE']),
      downloadAvailable: z.boolean(),
      filename: z.string().min(1).optional(),
      contentType: z.string().min(1).optional(),
      pages: z.number().int().nonnegative().optional(),
      sha256: z.string().nullable().optional(),
      version: z.number().int().nonnegative().optional(),
      /** Le parcours EXIGE-t-il une signature ? Absent = ancienne projection. */
      signatureRequired: z.boolean().optional(),
      signatureStatus: z.string().min(1).optional(),
      signedAt: z.string().nullable().optional(),
      generatedAt: z.string().nullable().optional(),
      downloadPath: z.string().startsWith('/').optional(),
    })
    .strict();

/** Montants d'un contrat — mêmes règles pour le courant et pour l'histoire. */
const contractPricingSchema = z
  .object({
    subscription: z
      .object({
        amountIncludingTax: z.number().nullable().optional(),
        currency: z.string().nullable().optional(),
        interval: z.string().nullable().optional(),
      })
      .strict()
      .optional(),
    launchFee: z
      .object({
        amountIncludingTax: z.number().nullable().optional(),
        currency: z.string().nullable().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export const contractPayloadSchema = z
  .object({
    /**
     * Y A-T-IL UN CONTRAT ACTUEL ? — dit franchement, jamais deviné.
     *
     * La projection ne transportait qu'un contrat « choisi ». Quand le projet
     * n'en avait plus aucun en cours, elle envoyait quand même le dernier
     * modifié — donc un contrat résilié — et le Panel l'affichait comme
     * l'engagement du moment, abonnement et document compris. Le contrat le
     * plus récent n'est pas forcément le contrat actuel.
     *
     * Absent des projections antérieures à cette notion : on ne périme pas ce
     * qui a été reçu avant, le champ est donc optionnel.
     */
    hasCurrentContract: z.boolean().optional(),
    /** Les champs suivants décrivent le contrat ACTUEL, quand il en existe un. */
    sourceContractId: z.string().min(1).optional(),
    status: z.string().min(1).optional(),
    reference: z.string().nullable().optional(),
    /**
     * MÉTADONNÉES du document contractuel — jamais le fichier.
     *
     * Le PDF reste chez le projet, dans son stockage privé. Le Panel en garde
     * de quoi DIRE ce qui existe et un chemin d'API pour aller le chercher.
     * `downloadPath` est une route du projet, pas un chemin disque : exposer
     * un chemin de fichier dans un espace métier serait une fuite, et
     * deviendrait faux au premier changement d'hébergement.
     */
    document: contractDocumentSchema.optional(),
    createdAt: z.string().nullable().optional(),
    activatedAt: z.string().nullable().optional(),
    pricing: contractPricingSchema.optional(),
    /**
     * L'HISTOIRE — les contrats terminés, du plus récent au plus ancien.
     *
     * Ils restent entièrement consultables : référence, statut terminal,
     * dates, montants, document. Rien n'y est inventé — un motif de
     * résiliation que le projet ne conserve pas n'est pas publié.
     */
    previousContracts: z
      .array(
        z
          .object({
            sourceContractId: z.string().min(1),
            status: z.string().min(1),
            reference: z.string().nullable().optional(),
            createdAt: z.string().nullable().optional(),
            activatedAt: z.string().nullable().optional(),
            endedAt: z.string().nullable().optional(),
            cancellationReason: z.string().nullable().optional(),
            document: contractDocumentSchema.optional(),
            pricing: contractPricingSchema.optional(),
          })
          .strict(),
      )
      .optional(),
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

// ------------------------------------------------- découverte (>= 1.3.0) ----
// Le Panel SERT ces charges utiles ; il ne les reçoit jamais. Les valider ici
// n'est donc pas une garde d'entrée mais une garantie de SORTIE : ce que le
// Panel promet dans sa spec est ce qu'il envoie réellement.

/**
 * DESCRIPTEUR MÉDIA CANONIQUE (>= 1.5.0, ADDITIF).
 *
 * ── CE QUE L'URL SEULE NE DISAIT PAS ────────────────────────────────────────
 * Le Bridge ne transportait qu'une adresse. Un projet qui la recevait ne
 * pouvait savoir ni si l'image avait changé (aucune empreinte), ni son type
 * réel, ni ses dimensions, ni si la projection reçue était plus récente que
 * celle qu'il appliquait déjà. Il ne pouvait que recharger l'adresse et
 * espérer — d'où des images remplacées qui restaient affichées depuis le
 * cache, et des liens morts qu'aucun écran ne savait qualifier.
 *
 * ── ADDITIF, DONC SANS RUPTURE ──────────────────────────────────────────────
 * Le descripteur ACCOMPAGNE `logoUrl` / `photoUrl` / `faviconUrl` ; il ne les
 * remplace pas. Un projet antérieur continue de fonctionner sans rien changer,
 * et la migration se fait projet par projet.
 *
 * `url` est TOUJOURS absolue et canonique : jamais une boucle locale, jamais
 * un chemin disque, jamais un `blob:`. Un projet affiche ce média depuis une
 * AUTRE origine que le Panel — une adresse locale y donne une image cassée.
 *
 * `null` est une valeur SIGNIFIANTE : elle publie la SUPPRESSION du média.
 * L'omettre laisserait l'ancien descripteur en place chez le projet.
 */
export const mediaDescriptorSchema = z
  .object({
    /** Identité stable du média. `null` pour une URL externe non gérée. */
    mediaId: z.string().nullable().optional(),
    url: z.string().url(),
    mime: z.string().nullable().optional(),
    size: z.number().int().nonnegative().nullable().optional(),
    width: z.number().int().positive().nullable().optional(),
    height: z.number().int().positive().nullable().optional(),
    /** Empreinte du CONTENU — ce qui distingue « même image » d'« autre ». */
    sha256: z.string().nullable().optional(),
    /** Monotone : un projet refuse une projection plus ancienne. */
    version: z.number().int().nonnegative().nullable().optional(),
    updatedAt: z.string().nullable().optional(),
    role: z.string().nullable().optional(),
    /** Vrai pour une URL externe dont le Panel n'a aucune métadonnée. */
    external: z.boolean().optional(),
  })
  .passthrough();

export const companyProfileSchema = z
  .object({
    companyId: z.string().uuid(),
    slug: z.string().min(2),
    environment: z.enum(['TEST', 'PROD']),
    version: z.number().int().positive().optional(),
    identity: z.object({
      name: z.string().min(1),
      legalName: z.string().nullable().optional(),
      tagline: z.string().nullable().optional(),
      description: z.string().nullable().optional(),
    }),
    branding: z.record(z.string(), z.any()).optional(),
    domains: z.record(z.string(), z.any()).optional(),
    contacts: z.record(z.string(), z.any()).optional(),
    legal: z.record(z.string(), z.any()).optional(),
    settings: z.record(z.string(), z.any()).optional(),
    // ADDITIF : un projet antérieur les ignore sans rien casser. Le Panel est
    // désormais l'autorité de l'identité développeur — signataire compris.
    signer: z.record(z.string(), z.any()).nullable().optional(),
    references: z.array(z.record(z.string(), z.any())).optional(),
    // L'ÉQUIPE — additive elle aussi. Un Panel antérieur ne l'envoie pas, et
    // le projet affiche alors une équipe vide : une information manquante,
    // jamais une équipe inventée.
    team: z.array(z.record(z.string(), z.any())).optional(),
  })
  .passthrough();

export const integratedApiConfigSchema = z
  .object({
    apiId: z.string().uuid(),
    key: z.string().min(1),
    label: z.string().optional(),
    provider: z.string().min(1),
    category: z.string().optional(),
    enabled: z.boolean().optional(),
    mode: z.enum(['TEST', 'PROD']),
    settings: z.record(z.string(), z.any()).optional(),
    credentials: z.record(z.string(), z.string()),
    updatedAt: z.string().optional(),
  })
  .passthrough();

/**
 * Ce que le Panel renvoie au bootstrap. Les trois derniers champs sont
 * additifs 1.3.0 : un projet 1.2.x les ignore sans rien casser.
 */
export const bootstrapResponseSchema = z
  .object({
    projectId: z.string().uuid(),
    bridgeToken: z.string().min(16),
    panel: z.object({ name: z.string(), contractVersion: semver }),
    company: companyProfileSchema.nullable().optional(),
    integratedApis: z.array(integratedApiConfigSchema).optional(),
    syncCursor: z.string().nullable().optional(),
  })
  .strict();

/**
 * Ce qu'un projet déclare avoir APPLIQUÉ (ProjectBridge >= 1.3.0). Le Panel
 * le CONSOMME : ce schéma est donc, lui, une vraie garde d'entrée — mais
 * tolérante, un projet plus récent pouvant en dire davantage.
 */
export const appliedConfigurationSchema = z
  .object({
    companyId: z.string().nullable().optional(),
    companySlug: z.string().nullable().optional(),
    companyVersion: z.number().int().nullable().optional(),
    companyAppliedAt: z.string().nullable().optional(),
    integratedApiCount: z.number().int().min(0).optional(),
    integratedApiKeys: z.array(z.string()).optional(),
    lastSyncAt: z.string().nullable().optional(),
  })
  .passthrough();

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
