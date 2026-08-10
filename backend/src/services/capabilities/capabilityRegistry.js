// REGISTRE DES CAPACITÉS — ce que les projets peuvent DEMANDER (L3).
//
// docs/architecture/CAPABILITY_GATEWAY.md §« Registre ».
//
// ── CODE-FIRST, ET C'EST UN INVARIANT ───────────────────────────────────────
//
// Rien en base ne peut ajouter, retirer ni modifier une capacité. Une capacité
// enregistrable depuis Mongo serait une porte ouverte sans adaptateur, sans
// politique commerciale et sans test — et un projet finirait par l'invoquer.
//
// ── CE REGISTRE NE RÉINVENTE RIEN ───────────────────────────────────────────
//
// Il AGRÈGE trois autorités déjà écrites, et ne les redéfinit jamais :
//
//   providerRegistry.js       → quel fournisseur, quelle portée
//   commercialReadiness.js    → quel EFFET réel (donc quelle politique L1.75)
//   brevo/brevoCapabilities.js → le contrat métier Brevo, écrit par L8
//
// `assertRegistryAlignment()` échoue si l'une diverge. C'est ce contrôle, et
// non la discipline, qui garantit qu'on ne se retrouvera pas avec une capacité
// dont l'écran promet une chose et dont la politique en décide une autre.
//
// ── DÉCLARÉE ≠ SERVIE ───────────────────────────────────────────────────────
//
// Une capacité `migrated: false` est CONNUE : sa politique, son effet et son
// fournisseur sont établis, et l'écran peut l'annoncer comme « pas encore
// migrée ». Elle n'est simplement branchée sur aucun adaptateur, et son
// invocation est refusée par `CAPABILITY_NOT_AVAILABLE`. Les taire produirait
// un `CAPABILITY_UNKNOWN` mensonger : la capacité existe, elle n'est pas prête.
import { z } from 'zod';

import { getProviderDefinition } from '../integratedApi/providerRegistry.js';
import { CAPABILITY_EFFECTS, EFFECT } from '../integratedApi/commercialReadiness.js';
import { BREVO_CAPABILITY_CODES } from '../integratedApi/brevo/brevoCapabilities.js';

/* -------------------------------------------------------------------------- */
/*  IDEMPOTENCE                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Ce qu'on peut se permettre quand une invocation tourne mal.
 *
 * Une stratégie unique serait fausse dans les deux sens : appliquée partout,
 * elle interdirait de relire un compte après un hoquet réseau ; assouplie
 * partout, elle enverrait deux fois le même e-mail.
 */
export const IDEMPOTENCY = Object.freeze({
  /** Rien à protéger : l'appel ne change rien. Relire est gratuit. */
  NONE: 'NONE',
  /** Sans effet de bord observable : rejouer est sûr, même après un doute. */
  SAFE_RETRY: 'SAFE_RETRY',
  /**
   * Le fournisseur n'offre aucune clé d'idempotence : un délai dépassé laisse
   * l'action dans un état INDÉCIDABLE, et le rejeu est un arbitrage humain.
   */
  UNKNOWN_ON_TIMEOUT: 'UNKNOWN_ON_TIMEOUT',
  /** Le fournisseur déduplique lui-même (en-tête d'idempotence). */
  PROVIDER_IDEMPOTENT: 'PROVIDER_IDEMPOTENT',
});

/* -------------------------------------------------------------------------- */
/*  PERMISSIONS                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Permissions portées par une capacité. Elles ne remplacent PAS l'octroi
 * (`capabilityGrants`) : l'octroi dit QUI, la permission dit QUOI — et permet
 * de raisonner par famille sans réénumérer les codes un à un.
 */
export const PERMISSIONS = Object.freeze({
  EMAIL_SEND: 'email:send',
  EMAIL_VERIFY: 'email:verify',
  BILLING_READ: 'billing:read',
  BILLING_WRITE: 'billing:write',
  SIGNATURE_READ: 'signature:read',
  SIGNATURE_WRITE: 'signature:write',
  DNS_WRITE: 'dns:write',
});

/* -------------------------------------------------------------------------- */
/*  SCHÉMAS D'ENTRÉE                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Adresse de destinataire — la seule donnée personnelle qu'une capacité
 * d'e-mail accepte, et elle est validée avant d'aller où que ce soit.
 */
const recipientSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  name: z.string().trim().max(120).optional(),
});

/**
 * `strict()` PARTOUT, et c'est le cœur de la garantie.
 *
 * Zod ignore les clés inconnues par défaut : un projet pourrait envoyer
 * `{ recipient, environment: 'PROD', apiKey: '…' }` sans que rien ne proteste.
 * Les champs seraient inertes — mais leur présence signalerait à quiconque lit
 * le code du projet qu'ils font peut-être quelque chose, et un jour quelqu'un
 * les brancherait. Un refus explicite tue l'idée à la racine.
 */
const emailSenderVerifyInput = z.object({
  /**
   * FACULTATIF — et c'est la sémantique réellement servie qui le veut.
   *
   * L'adaptateur LIT le compte chez Brevo (`GET /v3/account`) : il n'envoie
   * rien, donc personne ne reçoit rien, donc il n'y a pas de destinataire. Le
   * rendre obligatoire forçait l'appelant à inventer une adresse pour un appel
   * qui ne l'utilise pas — et le diagnostic de connexion du Manager, qui n'en
   * a aucune sous la main, aurait échoué sur une validation d'entrée en
   * laissant croire que la connexion, elle, était en cause.
   *
   * Il reste accepté et VALIDÉ quand il est fourni : le jour où cette capacité
   * enverra réellement un message de contrôle (contrat L8 §« sender.verify »),
   * l'entrée n'aura pas à changer de forme.
   */
  recipient: recipientSchema.optional(),
  /**
   * Clé d'idempotence FOURNIE PAR LE PROJET. Il est le seul à savoir que deux
   * clics sont la même intention ; le Panel ne peut que le constater trop tard.
   */
  operationId: z.string().trim().min(8).max(64),
}).strict();

const emailSendTemplateInput = z.object({
  templateRef: z.string().trim().min(1).max(120),
  recipient: recipientSchema,
  variables: z.record(z.union([z.string(), z.number(), z.boolean()])).optional(),
  replyTo: recipientSchema.optional(),
  operationId: z.string().trim().min(8).max(64),
}).strict();

/* -------------------------------------------------------------------------- */
/*  SCHÉMAS DE SORTIE                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Ce qui revient au projet. Volontairement étroit : la sortie d'une capacité
 * est un CONSTAT métier, pas une transcription de la réponse du fournisseur.
 * Y laisser passer un objet brut ferait fuir, tôt ou tard, un identifiant de
 * compte, une URL interne ou un message qu'on n'a pas relu.
 */
const emailSenderVerifyOutput = z.object({
  provider: z.literal('BREVO'),
  reachable: z.boolean(),
  /** Nom public du compte chez le fournisseur. Aucun secret. */
  accountLabel: z.string().nullable(),
  checkedAt: z.string(),
}).strict();

const emailSendTemplateOutput = z.object({
  status: z.enum(['ACCEPTED', 'ALREADY_SENT']),
  providerMessageId: z.string().nullable(),
  operationId: z.string(),
}).strict();

/* -------------------------------------------------------------------------- */
/*  DÉFINITIONS                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Construit une définition. `effect` n'est PAS un paramètre : il est lu dans
 * `commercialReadiness.CAPABILITY_EFFECTS`, seule autorité. Le dupliquer ici
 * créerait deux vérités dont l'une déciderait si de l'argent réel bouge.
 */
function capability(code, options) {
  const provider = options.provider;
  const definition = getProviderDefinition(provider);
  return Object.freeze({
    code,
    provider,
    /** Portée du fournisseur (ENVIRONMENT | PANEL_GLOBAL) — registre L1. */
    scope: definition?.scope ?? null,
    /** Nature de l'effet réel — table L1.75, jamais recopiée. */
    effectNature: CAPABILITY_EFFECTS[code] ?? null,
    label: options.label,
    /** Branchée sur un adaptateur ? `false` = déclarée, pas encore servie. */
    migrated: options.migrated === true,
    inputSchema: options.inputSchema ?? null,
    outputSchema: options.outputSchema ?? null,
    timeoutMs: options.timeoutMs,
    idempotency: options.idempotency,
    requiredPermissions: Object.freeze([...(options.requiredPermissions ?? [])]),
    /** Note d'audit pour les capacités non migrées : ce qui les retient. */
    migrationNote: options.migrationNote ?? null,
  });
}

export const CAPABILITY_DEFINITIONS = Object.freeze({
  /* ── Brevo — le contrat vient de L8, la passerelle le sert ──────────────── */

  'email.sender.verify': capability('email.sender.verify', {
    provider: 'BREVO',
    label: 'Vérifier la chaîne d’envoi',
    /**
     * LA PREMIÈRE, ET C'EST DÉLIBÉRÉ (recommandation L8 §13).
     *
     * Elle lit le compte chez le fournisseur : rien n'est créé, rien n'est
     * envoyé, personne ne reçoit de message. Son échec ne prive aucun
     * utilisateur d'une notification attendue, et son rejeu ne peut pas
     * produire de doublon. C'est la seule capacité dont on peut se permettre
     * qu'elle se trompe pendant qu'on éprouve le chemin complet.
     */
    migrated: true,
    inputSchema: emailSenderVerifyInput,
    outputSchema: emailSenderVerifyOutput,
    timeoutMs: 10_000,
    // Lecture pure : rejouer est sans conséquence, même après un délai dépassé.
    idempotency: IDEMPOTENCY.SAFE_RETRY,
    requiredPermissions: [PERMISSIONS.EMAIL_VERIFY],
  }),

  'email.send_template': capability('email.send_template', {
    provider: 'BREVO',
    label: 'Envoyer une notification depuis un modèle',
    migrated: false,
    inputSchema: emailSendTemplateInput,
    outputSchema: emailSendTemplateOutput,
    timeoutMs: 15_000,
    // Brevo n'expose aucune clé d'idempotence sur /v3/smtp/email (audit L8 §7).
    idempotency: IDEMPOTENCY.UNKNOWN_ON_TIMEOUT,
    requiredPermissions: [PERMISSIONS.EMAIL_SEND],
    /**
     * Cette note s'AFFICHE. Elle ne nomme donc aucun projet : le Panel sert un
     * parc, et un opérateur d'une autre instance lirait ici le nom d'un client
     * qui n'est pas le sien. La garde d'architecture le vérifie sur les
     * chaînes, pas seulement sur les commentaires — et elle a bien fait.
     */
    migrationNote:
      'Exige le magasin de modèles et d’identités expéditrices du Panel (L8 §15, réserve 2). '
      + 'Le chemin local du projet reste la seule voie d’envoi.',
  }),

  /* ── Stripe — audité, pas migré (L6) ────────────────────────────────────── */

  'billing.invoice.list': capability('billing.invoice.list', {
    provider: 'STRIPE',
    label: 'Lister les factures',
    migrated: false,
    timeoutMs: 15_000,
    idempotency: IDEMPOTENCY.SAFE_RETRY,
    requiredPermissions: [PERMISSIONS.BILLING_READ],
    migrationNote: 'L6. Lecture pure — la plus simple à basculer en premier.',
  }),
  'billing.subscription.reconcile': capability('billing.subscription.reconcile', {
    provider: 'STRIPE',
    label: 'Réconcilier un abonnement',
    migrated: false,
    timeoutMs: 20_000,
    idempotency: IDEMPOTENCY.SAFE_RETRY,
    requiredPermissions: [PERMISSIONS.BILLING_READ],
    migrationNote: 'L6. Réparation d’un webhook perdu : doit rester rejouable.',
  }),
  'billing.customer.ensure': capability('billing.customer.ensure', {
    provider: 'STRIPE',
    label: 'Garantir l’existence d’un client',
    migrated: false,
    timeoutMs: 15_000,
    // Stripe accepte `Idempotency-Key` : la déduplication est chez lui.
    idempotency: IDEMPOTENCY.PROVIDER_IDEMPOTENT,
    requiredPermissions: [PERMISSIONS.BILLING_WRITE],
    migrationNote: 'L6.',
  }),
  'billing.checkout.create': capability('billing.checkout.create', {
    provider: 'STRIPE',
    label: 'Ouvrir une session de paiement',
    migrated: false,
    timeoutMs: 20_000,
    idempotency: IDEMPOTENCY.PROVIDER_IDEMPOTENT,
    requiredPermissions: [PERMISSIONS.BILLING_WRITE],
    migrationNote: 'L6. FINANCIAL_WRITE : bloquée en pré-ouverture, migrée ou non.',
  }),
  'billing.subscription.cancel_at_period_end': capability('billing.subscription.cancel_at_period_end', {
    provider: 'STRIPE',
    label: 'Résilier en fin de période',
    migrated: false,
    timeoutMs: 20_000,
    idempotency: IDEMPOTENCY.PROVIDER_IDEMPOTENT,
    requiredPermissions: [PERMISSIONS.BILLING_WRITE],
    migrationNote: 'L6.',
  }),
  'billing.refund': capability('billing.refund', {
    provider: 'STRIPE',
    label: 'Rembourser',
    migrated: false,
    timeoutMs: 20_000,
    idempotency: IDEMPOTENCY.PROVIDER_IDEMPOTENT,
    requiredPermissions: [PERMISSIONS.BILLING_WRITE],
    migrationNote: 'L6. Premier usage NEUF du plan de contrôle : aucun code projet ne le fait.',
  }),

  /* ── Yousign — audité, pas migré (L7) ───────────────────────────────────── */

  'signature.document.download': capability('signature.document.download', {
    provider: 'YOUSIGN',
    label: 'Télécharger un document signé',
    migrated: false,
    timeoutMs: 30_000,
    idempotency: IDEMPOTENCY.SAFE_RETRY,
    requiredPermissions: [PERMISSIONS.SIGNATURE_READ],
    migrationNote: 'L7. Rend un binaire : la passerelle devra porter un transport non-JSON.',
  }),
  'signature.request.create': capability('signature.request.create', {
    provider: 'YOUSIGN',
    label: 'Demander une signature',
    migrated: false,
    timeoutMs: 30_000,
    // Aucune clé d'idempotence documentée : un doublon crée une seconde
    // demande de signature chez une personne réelle.
    idempotency: IDEMPOTENCY.UNKNOWN_ON_TIMEOUT,
    requiredPermissions: [PERMISSIONS.SIGNATURE_WRITE],
    migrationNote: 'L7. Hôtes d’API à revérifier après le rebranding Youtrust.',
  }),

  /* ── Hostinger — audité, pas migré (L9) ─────────────────────────────────── */

  'dns.record.ensure': capability('dns.record.ensure', {
    provider: 'HOSTINGER',
    label: 'Garantir un enregistrement DNS',
    migrated: false,
    timeoutMs: 30_000,
    // Poser deux fois le même enregistrement aboutit au même état.
    idempotency: IDEMPOTENCY.SAFE_RETRY,
    requiredPermissions: [PERMISSIONS.DNS_WRITE],
    migrationNote:
      'L9. Le seul consommateur est le moteur de déploiement du Panel lui-même : '
      + 'c’est une implémentation, pas une migration — aucun projet ne l’invoquera.',
  }),
});

export const CAPABILITY_CODES = Object.freeze(Object.keys(CAPABILITY_DEFINITIONS));

/* -------------------------------------------------------------------------- */
/*  ACCÈS                                                                     */
/* -------------------------------------------------------------------------- */

export function isKnownCapability(code) {
  return typeof code === 'string' && Object.hasOwn(CAPABILITY_DEFINITIONS, code);
}

/** Définition, ou `null`. L'appelant décide si l'absence est une erreur. */
export function getCapabilityDefinition(code) {
  return isKnownCapability(code) ? CAPABILITY_DEFINITIONS[code] : null;
}

/** Toutes les définitions, dans un ordre STABLE — celui des écrans. */
export function listCapabilityDefinitions() {
  return CAPABILITY_CODES.map((code) => CAPABILITY_DEFINITIONS[code]);
}

/** Celles réellement servies aujourd'hui. */
export function listMigratedCapabilities() {
  return listCapabilityDefinitions().filter((c) => c.migrated);
}

export function capabilitiesForProvider(provider) {
  const code = String(provider ?? '').toUpperCase();
  return listCapabilityDefinitions().filter((c) => c.provider === code);
}

/**
 * Vue publique — ce que rend l'API et ce que montre l'écran.
 *
 * Ni schéma zod, ni note interne : un schéma sérialisé n'aide personne à
 * l'écran, et l'exposer inviterait un client à le réimplémenter au lieu de
 * lire le contrat.
 */
export function describeCapability(code) {
  const capability = getCapabilityDefinition(code);
  if (!capability) return null;
  return {
    code: capability.code,
    label: capability.label,
    provider: capability.provider,
    scope: capability.scope,
    effectNature: capability.effectNature,
    migrated: capability.migrated,
    invocable: capability.migrated,
    idempotency: capability.idempotency,
    timeoutMs: capability.timeoutMs,
    requiredPermissions: [...capability.requiredPermissions],
    migrationNote: capability.migrationNote,
  };
}

export function describeCapabilities() {
  return CAPABILITY_CODES.map((code) => describeCapability(code));
}

/* -------------------------------------------------------------------------- */
/*  ALIGNEMENT — le contrôle qui empêche deux vérités                         */
/* -------------------------------------------------------------------------- */

/**
 * Les registres racontent-ils la même histoire ?
 *
 * Quatre divergences possibles, et chacune est un incident réel en puissance :
 *
 *  · une capacité sans effet déclaré  → la politique commerciale ne la voit
 *    pas, et une écriture financière passerait en pré-ouverture ;
 *  · un effet déclaré sans capacité   → une politique orpheline, donc morte ;
 *  · un fournisseur inconnu du registre L1 → aucun credential ne sera trouvé ;
 *  · une capacité annoncée par un fournisseur mais absente d'ici → l'écran
 *    promet ce que la passerelle ne sait pas faire.
 *
 * @returns {string[]} problèmes, vide si tout s'accorde.
 */
export function assertRegistryAlignment() {
  const problems = [];

  for (const capability of listCapabilityDefinitions()) {
    if (!capability.effectNature) {
      problems.push(`« ${capability.code} » n’a aucun effet déclaré dans commercialReadiness.`);
    } else if (!Object.values(EFFECT).includes(capability.effectNature)) {
      problems.push(`« ${capability.code} » porte un effet inconnu : ${capability.effectNature}.`);
    }
    if (!getProviderDefinition(capability.provider)) {
      problems.push(`« ${capability.code} » désigne un fournisseur absent du registre L1 : ${capability.provider}.`);
    }
    // Une capacité servie sans contrat d'entrée accepterait n'importe quoi.
    if (capability.migrated && (!capability.inputSchema || !capability.outputSchema)) {
      problems.push(`« ${capability.code} » est servie sans schéma d’entrée ou de sortie.`);
    }
    if (!Object.values(IDEMPOTENCY).includes(capability.idempotency)) {
      problems.push(`« ${capability.code} » porte une stratégie d’idempotence inconnue.`);
    }
    if (!Number.isFinite(capability.timeoutMs) || capability.timeoutMs <= 0) {
      problems.push(`« ${capability.code} » n’a pas de délai d’attente exploitable.`);
    }
    if (capability.requiredPermissions.length === 0) {
      problems.push(`« ${capability.code} » n’exige aucune permission.`);
    }
  }

  for (const code of Object.keys(CAPABILITY_EFFECTS)) {
    if (!isKnownCapability(code)) {
      problems.push(`commercialReadiness déclare « ${code} » — absent du registre des capacités.`);
    }
  }

  // Le catalogue Brevo de L8 est la source du contrat métier Brevo : la
  // passerelle le SERT, elle ne le redéfinit pas.
  for (const code of BREVO_CAPABILITY_CODES) {
    if (!isKnownCapability(code)) {
      problems.push(`le catalogue Brevo (L8) déclare « ${code} » — absent du registre des capacités.`);
    }
  }
  for (const capability of capabilitiesForProvider('BREVO')) {
    if (!BREVO_CAPABILITY_CODES.includes(capability.code)) {
      problems.push(`« ${capability.code} » est déclarée Brevo ici, mais absente du catalogue L8.`);
    }
  }

  for (const definition of ['STRIPE', 'BREVO', 'YOUSIGN', 'HOSTINGER'].map(getProviderDefinition)) {
    for (const code of definition.capabilities) {
      if (!isKnownCapability(code)) {
        problems.push(`${definition.code} annonce « ${code} » — absent du registre des capacités.`);
      }
    }
  }

  return problems;
}

export default {
  IDEMPOTENCY,
  PERMISSIONS,
  CAPABILITY_DEFINITIONS,
  CAPABILITY_CODES,
  isKnownCapability,
  getCapabilityDefinition,
  listCapabilityDefinitions,
  listMigratedCapabilities,
  capabilitiesForProvider,
  describeCapability,
  describeCapabilities,
  assertRegistryAlignment,
};
