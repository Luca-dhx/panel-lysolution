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

export const CONTRACT_VERSION = '1.5.0';
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
  /**
   * PASSERELLE DE CAPACITÉS (1.5.0). `{code}` est un paramètre de chemin — le
   * seul de cette surface, et il porte un VERBE MÉTIER, jamais un fournisseur.
   * Un chemin par capacité serait plus « REST » et forcerait à modifier le
   * contrat à chaque migration ; ici, le registre du Panel décide seul de ce
   * qui existe, et le contrat n'a pas à le savoir.
   */
  capabilityInvoke: '/bridge/v1/capabilities/{code}/invoke',
  /**
   * LE SECRET DE VÉRIFICATION D'UN PROJET (L6.3A).
   *
   * Le seul chemin par lequel un secret descend vers un projet — et il ne
   * transporte que celui-là. Aucun identifiant de projet dans l'URL : celui qui
   * fait autorité vient du jeton de pont.
   */
  webhookVerificationSecret: '/bridge/v1/webhooks/{provider}/verification-secret',
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
  /**
   * L'environnement du PROJET ne correspond pas à celui de CETTE instance de
   * Panel. Le domaine choisit l'instance physique ; l'environnement déclaré
   * prouve qu'on parle du même monde. Voir `assertEnvironmentMatches`.
   */
  ENVIRONMENT_MISMATCH: 'BRIDGE_ENVIRONMENT_MISMATCH',
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
  'BRIDGE_ENVIRONMENT_MISMATCH',
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

/**
 * Le sens PROJET ajoute `ENTITY_TYPE_UNSUPPORTED`, juste APRÈS `INVALID_PAYLOAD`.
 *
 * ── POURQUOI PLUS PAR INDICE ────────────────────────────────────────────────
 * L'insertion se faisait par position (`slice(0, 6)`). Ajouter un code au
 * catalogue parent déplaçait donc le point d'insertion sans que rien ne le
 * signale, et les deux énumérations cessaient de correspondre à leurs specs —
 * ce qui s'est produit au premier ajout. On insère désormais par NOM : le
 * catalogue peut grandir sans casser le dérivé.
 */
export const PROJECT_BRIDGE_ERROR_ENUM = Object.freeze(
  PANEL_BRIDGE_ERROR_ENUM.flatMap((code) => (
    code === BRIDGE_ERROR_CODES.INVALID_PAYLOAD
      ? [code, BRIDGE_ERROR_CODES.ENTITY_TYPE_UNSUPPORTED]
      : [code]
  )),
);

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
  // Conflit : les deux cotes sont sains, mais ils ne parlent pas du meme monde.
  [BRIDGE_ERROR_CODES.ENVIRONMENT_MISMATCH]: 409,
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
  /**
   * >= 1.4.x — ETAT D'ACCESSIBILITE DU SITE, pousse par le projet.
   *
   * AGREGAT DISTINCT DE `CONTRACT`, et il doit le rester. Une suspension
   * TECHNIQUE (maintenance) n'a aucun rapport avec un contrat : la
   * transporter sous l'etiquette contractuelle ferait afficher « probleme de
   * contrat » devant une operation de maintenance, et inversement. Le statut
   * du site est DERIVE des deux causes, mais il n'appartient a aucune.
   */
  'PROJECT_SITE_STATUS',
  /**
   * >= 1.6.x — RETOUR DE LIVRAISON D'UN E-MAIL, poussé par le Panel (L8.4C).
   *
   * Depuis que les envois partent du compte Brevo du Panel, les webhooks de
   * livraison suivent le COMPTE et n'atteignent plus le projet. Cette entité
   * est le chemin de retour : elle porte un verbe métier déjà normalisé
   * (`EMAIL_DELIVERED` / `EMAIL_BOUNCED`), jamais un événement brut du
   * fournisseur — le projet n'a pas à connaître le vocabulaire de Brevo pour
   * savoir qu'un message est arrivé.
   */
  'EMAIL_DELIVERY_EVENT',
  /**
   * >= 1.7.x — LE RETOUR DE SIGNATURE, poussé par le Panel (R10.5C).
   *
   * Même raison d'être que `EMAIL_DELIVERY_EVENT`, et même leçon : après
   * cutover, les webhooks Yousign suivent le COMPTE, donc le Panel. Sans cette
   * entité, un contrat signé resterait « en cours » côté projet, et un projet
   * éteint au mauvais moment perdrait le fait définitivement.
   *
   * Elle porte un fait NORMALISÉ — `SIGNATURE_SIGNER_SIGNED`,
   * `SIGNATURE_COMPLETED`, `SIGNATURE_FAILED` — jamais l'événement brut du
   * fournisseur : le projet n'a pas à connaître le vocabulaire de Yousign pour
   * savoir qu'un contrat est signé.
   */
  'SIGNATURE_EVENT',
  /**
   * >= 1.7.x — UNE PRESTATION À PAYER, poussée par le Panel (L10.5).
   *
   * DISTINCTE de `INVOICE` et de `PAYMENT`, et elle doit le rester. Ces deux-là
   * décrivent ce qui a EU LIEU — une facture Stripe émise, un paiement encaissé.
   * Celle-ci décrit ce qui est RÉCLAMÉ : une somme due, qui n'a produit aucune
   * facture et aucun encaissement, et qui n'en produira peut-être jamais.
   *
   * Les confondre aurait fait apparaître, dans l'historique de facturation du
   * client, des factures qui n'existent pas.
   *
   * La charge utile est volontairement PAUVRE : un nom, un montant, un état, et
   * le document Stripe une fois payé. Aucun identifiant fournisseur, aucune URL
   * de session — celle-ci est périssable et se demande au moment du clic.
   */
  'PAYMENT_REQUEST',
  /**
   * >= 1.7.x — UNE CAUSE DE SUSPENSION, poussée par le Panel (L10.6).
   *
   * Elle transporte un FAIT COMMERCIAL — « le défaut de paiement est actif » —
   * jamais un état de site. Le Panel décide de la politique de grâce ; le projet
   * reste l'autorité de son accessibilité et combine cette cause avec les
   * siennes (maintenance technique, contrat éteint).
   *
   * Un ordre `status: SUSPENDED` aurait créé un second maître, et une
   * régularisation aurait pu rouvrir un site en maintenance.
   */
  'PAYMENT_DEFAULT_CAUSE',
  /**
   * >= 1.7.x — L'INCIDENT DE PAIEMENT LUI-MÊME, poussé par le Panel (L10.6B-3).
   *
   * ══ POURQUOI IL NE POUVAIT PAS EMPRUNTER `PAYMENT_DEFAULT_CAUSE` ══════════
   *
   * Parce que `active`, sur ce type-là, a une signification EXACTE et vérifiable
   * dans le code du projet : elle est écrite dans `siteStatus.paymentDefault`,
   * puis le moteur de réconciliation en tire l'accessibilité. C'est une ENTRÉE
   * DE MOTEUR.
   *
   * Or un incident EXISTE avant que la cause ne devienne active — c'est tout
   * l'objet du délai de grâce. Le transporter par la cause aurait imposé l'un
   * de ces deux mensonges :
   *
   *   `active: true` pendant la grâce   fermer le site pendant la grâce, soit
   *                                     exactement ce que la grâce empêche ;
   *
   *   `active: false` avec des données  l'applicateur de cause remet à néant
   *                                     tout le contexte quand la cause est
   *                                     inactive — l'incident arriverait et
   *                                     disparaîtrait dans la même écriture.
   *
   * Et, structurellement : `SiteStatus` est un SINGLETON avec UN sous-document
   * de cause, alors qu'un projet peut connaître plusieurs incidents successifs.
   * Un singleton n'héberge pas un historique.
   *
   * Les deux types sont donc ORTHOGONAUX, et le resteront :
   *
   *   CAUSE      « faut-il fermer ? »        → entrée du moteur, singleton
   *   INCIDENT   « que se passe-t-il ? »     → observation, collection
   *
   * L'incident porte `causeActive` en LECTURE — pour que l'écran puisse
   * expliquer ce qu'il montre — jamais comme autorité : l'accessibilité se lit
   * dans `SiteStatus`, et nulle part ailleurs.
   */
  'PAYMENT_DEFAULT_INCIDENT',
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
  'PROJECT_SITE_STATUS',
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
    /**
     * QUI DÉTIENT CE MÉDIA — ADDITIF, déclaré, jamais déduit.
     *
     * ── LE DÉFAUT QUE CE CHAMP FERME ──────────────────────────────────────
     * Les deux côtés du pont décrivaient leurs médias de la même façon : clé
     * d'objet, empreinte, dimensions. Le lecteur concluait donc « média du
     * projet » sur la simple présence d'une clé, et recomposait l'adresse
     * contre le domaine du CLIENT. Le logo du développeur, servi par le Panel,
     * devenait `https://<client>/uploads/<clé du Panel>` — un 404.
     *
     * `PANEL` : le média reste sur le Panel et garde l'adresse qu'il publie.
     * `PROJECT` : le média suit la destination active du projet.
     *
     * Optionnel pour la LECTURE des projections antérieures — l'autorité leur
     * est alors donnée par le schéma du champ qui les porte. Toute émission
     * nouvelle le renseigne.
     */
    authority: z.enum(['PANEL', 'PROJECT']).nullable().optional(),
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
    /**
     * Servi par une destination ACTIVE — relevé sur le serveur, jamais déduit.
     * Un descripteur `LOCAL_ONLY` décrit un média qui existe, mais que
     * personne d'autre ne peut encore atteindre.
     */
    publicationState: z.enum(['LOCAL_ONLY', 'PUBLISHED']).nullable().optional(),
    /** Vrai pour une URL externe dont le Panel n'a aucune métadonnée. */
    external: z.boolean().optional(),
  })
  .passthrough();

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
      /**
       * ADDITIF — le descripteur complet annoncé par le PROJET.
       *
       * Le Panel en publiait déjà vers les projets ; il n'en recevait aucun.
       * Le Bridge était asymétrique : le même objet ne se décrivait pas de la
       * même façon selon le sens de circulation. Optionnel : un projet
       * antérieur reste pleinement conforme.
       */
      logo: mediaDescriptorSchema.optional(),
      favicon: mediaDescriptorSchema.optional(),
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
        /**
         * ── CE QUE « CONNECTÉ » NE DISAIT PAS (>= 1.4.x, ADDITIF) ───────────
         *
         * Une instance dont toutes les écritures métier sont REFUSÉES bat
         * parfaitement : le battement prouve qu'on répond, jamais qu'on livre.
         * La fiche restait verte devant une donnée figée depuis des semaines.
         *
         * Ces deux champs portent le fait manquant. Ni charge utile, ni
         * secret : un compte, un code, une date. Optionnels — le silence d'un
         * projet antérieur ne vaut pas « aucun refus », seulement « ne sait
         * pas dire », et l'écran doit faire la différence.
         */
        rejectedCount: z.number().int().min(0).optional(),
        oldestRejection: z
          .object({
            entityType: z.string().min(1),
            failureClass: z.string().min(1).nullable().optional(),
            code: z.string().min(1).nullable().optional(),
            since: isoDate.nullable().optional(),
            rejections: z.number().int().min(0).optional(),
          })
          .strict()
          .optional(),
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
    /**
     * ADRESSES HÉRITÉES — dérivées du descripteur, conservées pour un Panel
     * antérieur. Elles ne font PAS autorité : voir `logo` / `favicon`.
     *
     * Elles restent des URL ABSOLUES. Un média est affiché depuis une autre
     * origine que celle qui l'a produit ; un chemin relatif y donne une image
     * cassée, et l'émetteur ne le publie donc pas (il omet le champ).
     */
    logoUrl: z.string().url().optional(),
    faviconUrl: z.string().url().optional(),
    /**
     * ── LE DESCRIPTEUR EST LA SOURCE CANONIQUE, ET IL MANQUAIT ICI ──────────
     *
     * ══ LE DÉFAUT QUE CES DEUX LIGNES FERMENT ═══════════════════════════════
     *
     * Le descripteur média a été ajouté au Bridge dans le sens Panel → projet,
     * puis accepté sur le MANIFESTE d'un projet (`projectManifestSchema
     * .presentation.logo`). Il n'a jamais été ajouté ici, sur la PROJECTION —
     * le seul des trois chemins qui soit vivant.
     *
     * Or `describeProjectPresentation` le publie « en additif » depuis le même
     * moment. Ce schéma étant `.strict()`, toute instance disposant d'un logo
     * — c'est-à-dire toute instance de production — voyait sa présentation
     * REFUSÉE avec `ENTITY_PAYLOAD_INVALID`. L'écriture sortait de la file du
     * projet, rien ne la rejouait, et la fiche restait sur l'ancien nom
     * indéfiniment. Le symptôme observé était « la synchronisation n'est pas
     * live » ; la cause était un champ de trop dans un schéma fermé.
     *
     * ══ POURQUOI ON N'OUVRE PAS LE SCHÉMA ═══════════════════════════════════
     *
     * `.passthrough()` aurait fait passer ce payload — et tous les suivants,
     * y compris celui qui transporterait un jour un secret par mégarde. La
     * fermeture est la protection ; ce qui manquait n'était pas la souplesse,
     * c'était l'accord entre l'émetteur et le validateur sur un champ DÉJÀ
     * émis. On nomme donc le champ, on ne retire pas la garde.
     *
     * `authority` reste déclarée par l'émetteur (`PROJECT` ici) et n'est jamais
     * déduite : c'est elle qui décide contre quelle origine l'adresse se
     * résout.
     */
    logo: mediaDescriptorSchema.nullable().optional(),
    favicon: mediaDescriptorSchema.nullable().optional(),
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
/**
 * PROJECT_SITE_STATUS — « ce site est-il accessible, et sinon pourquoi ? »
 *
 * ══ POURQUOI CE N'EST PAS UN CHAMP DU CONTRAT ═══════════════════════════════
 *
 * L'accessibilité a DEUX causes indépendantes : une suspension TECHNIQUE
 * (maintenance, décidée par un opérateur) et une cause CONTRACTUELLE (aucun
 * contrat vivant alors que la protection est active). Ranger cela sous
 * `CONTRACT` ferait afficher « problème de contrat » devant une maintenance —
 * et rendrait la fiche incapable de dire pourquoi un site est coupé.
 *
 * ══ LE VERDICT ET SA CAUSE VOYAGENT ENSEMBLE ════════════════════════════════
 *
 * `accessible` résume ; `suspensionSource` explique. Publier le seul résumé
 * forcerait le Panel à deviner la cause, et il devinerait faux un jour sur
 * deux. `NONE` est une réponse à part entière : « rien ne suspend ce site ».
 *
 * `contractProtectionEnabled` est un RÉGLAGE, pas une conséquence : il reste
 * vrai même quand il ne produit aucun effet (site protégé, contrat honoré).
 * C'est lui que la carte du Panel donne à basculer.
 */
export const siteStatusPayloadSchema = z
  .object({
    accessible: z.boolean(),
    status: z.enum(['ACTIVE', 'SUSPENDED']),
    suspensionSource: z.enum(['NONE', 'TECHNICAL', 'CONTRACT', 'PAYMENT_DEFAULT']),
    /** Motif LISIBLE, tel que le projet le formule. Jamais reconstruit ici. */
    reason: z.string().min(1).optional(),
    suspendedAt: isoDate.nullable().optional(),
    contractProtectionEnabled: z.boolean(),
    /** La cause technique, publiée à part : elle prime sur tout le reste. */
    technicalSuspension: z.boolean(),
    /**
     * L'INSTANTANÉ DES CAUSES ACTIVES (L10.6A) — toutes, pas la dominante.
     *
     * `suspensionSource` ne nomme que celle qui prime à l'affichage. Une
     * maintenance technique ET un impayé coexistent parfaitement, et c'est la
     * maintenance qui s'affiche : un Panel qui en conclurait que sa cause
     * financière n'a pas été appliquée se tromperait.
     *
     * OPTIONNEL — une projection antérieure à ce lot n'en porte pas, et l'on ne
     * périme pas ce qui a déjà été reçu. Son absence se lit « je ne sais pas »,
     * jamais « aucune cause ».
     */
    causes: z
      .object({
        technical: z.boolean(),
        contract: z.boolean(),
        paymentDefault: z.boolean(),
      })
      .strict()
      .optional(),
  })
  .strict();

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
     * LE TAUX DE TVA EFFECTIF — en POURCENTAGE (L10.5).
     *
     * `optional()` parce qu'une projection antérieure à ce lot n'en porte pas,
     * et `nullable()` parce qu'un contrat peut légitimement n'en avoir aucun.
     *
     * Les deux se lisent PAREIL côté Panel : « taux inconnu ». Et un taux
     * inconnu ne devient jamais 20 % par défaut — il fait REFUSER la création
     * d'une prestation, avec un message qui dit quoi corriger. Un repli
     * implicite aurait facturé un client à un taux que personne n'a décidé.
     */
    taxRate: z.number().min(0).max(100).nullable().optional(),
    /**
     * LE DÉLAI DE GRÂCE, EN JOURS ENTIERS (L10.6B-1).
     *
     * `nullable` parce qu'un contrat peut légitimement n'avoir aucune politique,
     * et `optional` parce qu'une projection antérieure au lot n'en porte pas.
     * Les deux se lisent PAREIL : « non configurée » — et le Panel ne suspend
     * alors jamais automatiquement.
     *
     * Borné à un an : au-delà, une grâce n'est plus une grâce, c'est une
     * gratuité, et la valeur trahit une faute de frappe.
     */
    paymentGraceDays: z.number().int().min(0).max(365).nullable().optional(),
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
