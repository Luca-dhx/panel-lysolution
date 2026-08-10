// CATALOGUE DE CAPACITÉS BREVO — l'intention métier, jamais l'API (L8).
//
// docs/architecture/BREVO_CONTROL_PLANE.md §« Capacités ».
//
// ── CE QUE LE PROJET DEMANDE, ET CE QU'IL N'OBTIENT JAMAIS ──────────────────
//
//   il demande   :  « envoie cette notification à cette personne »
//   il n'obtient :  la clé API, l'URL de l'API, un client Brevo, un templateId
//                   Brevo, l'adresse expéditrice, le choix de l'environnement.
//
// Une capacité est une INTENTION. Si le Panel remplaçait Brevo par un autre
// routeur d'e-mails demain, aucune de ces définitions ne changerait — c'est le
// seul test qui prouve qu'on a nommé le métier et pas le fournisseur.
//
// ── AUCUNE CAPACITÉ INVENTÉE ────────────────────────────────────────────────
//
// L'inventaire du 2026-08-10 (deux dépôts, recherche `brevo|sendinblue|sms|
// whatsapp|contact|campaign|template|sender`) ne trouve QUE de l'e-mail
// transactionnel : `POST /v3/smtp/email`, `GET /v3/account` et `/v3/webhooks`.
// Aucun SMS, aucun WhatsApp, aucune liste de contacts, aucune campagne
// marketing n'est appelé nulle part. Déclarer `sms.send` ici afficherait à
// l'écran une capacité sans driver, sans test et sans usage.
//
// ── PÉRIMÈTRE L8 ────────────────────────────────────────────────────────────
//
// DÉCLARATIF. Aucune capacité n'est invocable : la passerelle d'invocation
// appartient à L3, et ce lot ne la crée pas. Ce fichier fixe le contrat que L3
// devra honorer, et il est testé pour ça.
import { getProviderDefinition } from '../providerRegistry.js';

/* -------------------------------------------------------------------------- */
/*  VOCABULAIRE                                                               */
/* -------------------------------------------------------------------------- */

/**
 * D'où vient l'environnement d'une exécution.
 *
 * Une seule valeur est admise, et c'est tout l'objet du plan de contrôle : le
 * projet ne choisit pas le monde dans lequel son e-mail part. La doctrine
 * elle-même (`activeMode` global, TEST/PROD) appartient à L1/L1.75 — L8 se
 * contente de déclarer qu'il la CONSOMME et ne la redéfinit pas.
 */
export const ENVIRONMENT_SOURCES = Object.freeze({
  /** Résolu par `integratedApi/environment.js` depuis le runtime du Panel. */
  CONTROL_PLANE: 'CONTROL_PLANE',
});

/**
 * Force de la garantie d'idempotence — et il faut savoir la dire honnêtement.
 *
 * `PROVIDER_ENFORCED` : le fournisseur déduplique lui-même (Stripe et sa
 * `Idempotency-Key`). Rejouer est sûr.
 *
 * `CALLER_ENFORCED`   : le fournisseur ne déduplique RIEN ; c'est l'appelant
 *                       qui tient un registre et refuse le second envoi. La
 *                       garantie s'arrête là où son registre s'arrête —
 *                       typiquement, à la fenêtre de crash (§H).
 */
export const IDEMPOTENCY_STRENGTHS = Object.freeze({
  PROVIDER_ENFORCED: 'PROVIDER_ENFORCED',
  CALLER_ENFORCED: 'CALLER_ENFORCED',
});

/**
 * Qui détient la vérité d'un contenu de message.
 *
 * `PANEL` : le contenu vit chez nous, versionné, validé, relu en revue de code
 *           ou en base sous contrôle. C'est le seul choix retenu (§C).
 * `PROVIDER` : le contenu vit chez Brevo, éditable depuis leur interface, hors
 *           de nos versions et de notre validation. REFUSÉ — mais nommé, parce
 *           qu'un jour quelqu'un proposera de « juste utiliser un templateId ».
 */
export const TEMPLATE_AUTHORITIES = Object.freeze({
  PANEL: 'PANEL',
  PROVIDER: 'PROVIDER',
});

/**
 * Ce que le Panel garde d'une exécution, et ce qu'il laisse au projet (§I).
 *
 * Le plan de contrôle est un TRANSPORT. Il n'est pas le CRM : recopier chez lui
 * le destinataire, le contenu et le statut lu par l'utilisateur créerait un
 * second historique métier à réconcilier — et deux historiques qui divergent
 * valent moins qu'un seul.
 */
export const PERSISTENCE_OWNERS = Object.freeze({
  /** Diagnostic d'exécution : issue technique, identifiant fournisseur, durée. */
  PANEL: 'PANEL',
  /** Communication métier : destinataire, contenu, statut affiché à l'humain. */
  PROJECT: 'PROJECT',
});

/* -------------------------------------------------------------------------- */
/*  ERREURS CANONIQUES                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Codes d'erreur d'une capacité — STABLES, fermés, indépendants de Brevo.
 *
 * Ils décrivent une SITUATION, pas un statut HTTP : un projet qui les lit ne
 * doit pas apprendre l'existence d'un 402 Brevo pour comprendre que le compte
 * n'a plus de crédits.
 */
export const CAPABILITY_ERROR_CODES = Object.freeze({
  /** La capacité n'existe pas pour ce fournisseur. */
  CAPABILITY_UNSUPPORTED: 'CAPABILITY_UNSUPPORTED',
  /** Le projet n'a pas le droit d'invoquer cette capacité. */
  CAPABILITY_FORBIDDEN: 'CAPABILITY_FORBIDDEN',
  /** Entrée invalide : champ requis manquant, type inattendu, adresse illisible. */
  INPUT_INVALID: 'INPUT_INVALID',
  /** Aucun jeu d'identifiants exploitable pour cet environnement. */
  PROVIDER_NOT_AVAILABLE: 'PROVIDER_NOT_AVAILABLE',
  /** Le fournisseur refuse la requête pour une raison définitive (clé, expéditeur). */
  PROVIDER_REJECTED: 'PROVIDER_REJECTED',
  /** Le fournisseur est indisponible ou limite le débit. Reprise possible. */
  PROVIDER_UNAVAILABLE: 'PROVIDER_UNAVAILABLE',
  /** Le fournisseur a répondu hors contrat (2xx sans identifiant de message). */
  PROVIDER_CONTRACT_VIOLATION: 'PROVIDER_CONTRACT_VIOLATION',
  /** Aucune réponse : l'exécution a peut-être eu lieu. Voir `outcome` (§H). */
  PROVIDER_OUTCOME_UNKNOWN: 'PROVIDER_OUTCOME_UNKNOWN',
  /** L'identité expéditrice de ce projet n'est pas configurée ou pas exploitable. */
  SENDER_IDENTITY_MISSING: 'SENDER_IDENTITY_MISSING',
  /** Le contenu demandé n'appartient pas à ce projet (ou n'existe pas). */
  TEMPLATE_NOT_FOUND: 'TEMPLATE_NOT_FOUND',
  /** Demande adressée à un Panel qui ne sert pas cet environnement. */
  ENVIRONMENT_MISMATCH: 'INTEGRATED_API_ENVIRONMENT_MISMATCH',
});

/* -------------------------------------------------------------------------- */
/*  POLITIQUE DE PIÈCES JOINTES (§L)                                          */
/* -------------------------------------------------------------------------- */

/**
 * Aucune capacité n'accepte de pièce jointe aujourd'hui — l'inventaire n'en
 * trouve aucune sur le chemin e-mail (les seules pièces jointes du parc sont
 * des documents de signature Yousign, hors périmètre L8).
 *
 * Le contrat FUTUR est fixé ici plutôt que découvert plus tard sous pression :
 * une capacité ne recevra jamais un chemin de fichier. Un chemin fourni par un
 * projet est une lecture arbitraire du disque du Panel, c'est-à-dire une faille,
 * et aucune validation de chaîne ne la referme durablement.
 */
export const ATTACHMENT_POLICY = Object.freeze({
  supported: false,
  /** Interdit ABSOLU, aujourd'hui et demain. */
  acceptsFilesystemPath: false,
  /** La seule forme admissible : une référence opaque au registre de médias. */
  futureReferenceKind: 'MEDIA_REF',
  /** Vérifiée avant toute lecture : le média appartient-il à CE projet ? */
  requiresOwnershipCheck: true,
  maxBytes: 5 * 1024 * 1024,
  allowedMimeTypes: Object.freeze(['application/pdf', 'image/png', 'image/jpeg']),
});

/* -------------------------------------------------------------------------- */
/*  DÉFINITIONS                                                               */
/* -------------------------------------------------------------------------- */

function field(name, type, options = {}) {
  return Object.freeze({
    name,
    type,
    required: options.required === true,
    /** Le champ porte-t-il une donnée personnelle ? Pilote le journal. */
    personalData: options.personalData === true,
    description: options.description ?? '',
  });
}

/**
 * `email.send_template` — LA capacité du lot.
 *
 * ── LE DESTINATAIRE N'EST JAMAIS DANS LE CONTENU ────────────────────────────
 *
 * Le projet fournit une adresse à l'exécution ; le contenu, lui, ne porte
 * aucune adresse. SB Auto a construit tout son module e-mail sur cette
 * séparation (`emailRecipientResolvers.js`), et la perdre rendrait une adresse
 * de destinataire éditable depuis une interface web.
 *
 * ── L'EXPÉDITEUR N'EST PAS UN PARAMÈTRE ─────────────────────────────────────
 *
 * `sender` est ABSENT de l'entrée, volontairement. Il est résolu par le Panel
 * à partir du projet authentifié (§D/§E). Un projet qui pourrait choisir son
 * expéditeur pourrait écrire au nom d'un autre.
 */
const EMAIL_SEND_TEMPLATE = Object.freeze({
  code: 'email.send_template',
  label: 'Envoyer une notification depuis un modèle',
  provider: 'BREVO',
  /** Intention métier : ce que la capacité PROMET, sans nommer Brevo. */
  intent: 'Remettre une notification à un destinataire, à partir d’un modèle détenu par le Panel.',

  input: Object.freeze([
    field('templateRef', 'string', {
      required: true,
      description: 'Référence d’un modèle du Panel. JAMAIS un identifiant de modèle Brevo.',
    }),
    field('recipient', 'object', {
      required: true,
      personalData: true,
      description: '{ email, name? } — résolu par le projet à l’exécution, jamais stocké dans le modèle.',
    }),
    field('variables', 'object', {
      required: false,
      personalData: true,
      description: 'Valeurs des variables déclarées par le modèle. Aucune clé non déclarée n’est rendue.',
    }),
    field('replyTo', 'object', {
      required: false,
      personalData: true,
      description: '{ email, name? } — à qui répondre. Distinct de l’expéditeur, qui n’est pas un paramètre.',
    }),
    field('operationId', 'string', {
      required: true,
      description: 'Identifiant d’opération du projet. C’est LUI la clé d’idempotence (§H).',
    }),
  ]),

  output: Object.freeze([
    field('status', 'string', { required: true, description: 'ACCEPTED | ALREADY_SENT | UNKNOWN.' }),
    field('providerMessageId', 'string', {
      required: false,
      description: 'Identifiant du fournisseur, conservé sous forme canonique — la poignée de corrélation du suivi.',
    }),
    field('operationId', 'string', { required: true, description: 'Rendu tel quel, pour rapprochement côté projet.' }),
  ]),

  errors: Object.freeze([
    CAPABILITY_ERROR_CODES.INPUT_INVALID,
    CAPABILITY_ERROR_CODES.CAPABILITY_FORBIDDEN,
    CAPABILITY_ERROR_CODES.PROVIDER_NOT_AVAILABLE,
    CAPABILITY_ERROR_CODES.PROVIDER_REJECTED,
    CAPABILITY_ERROR_CODES.PROVIDER_UNAVAILABLE,
    CAPABILITY_ERROR_CODES.PROVIDER_CONTRACT_VIOLATION,
    CAPABILITY_ERROR_CODES.PROVIDER_OUTCOME_UNKNOWN,
    CAPABILITY_ERROR_CODES.SENDER_IDENTITY_MISSING,
    CAPABILITY_ERROR_CODES.TEMPLATE_NOT_FOUND,
    CAPABILITY_ERROR_CODES.ENVIRONMENT_MISMATCH,
  ]),

  idempotency: Object.freeze({
    /**
     * Brevo n'expose AUCUNE clé d'idempotence sur `POST /v3/smtp/email`
     * (contrairement à Stripe et son en-tête `Idempotency-Key`). La déduplication
     * est donc entièrement la nôtre : un index unique sur `operationId`, et une
     * fenêtre de crash qu'aucune ruse ne referme (§H).
     */
    strength: IDEMPOTENCY_STRENGTHS.CALLER_ENFORCED,
    keyField: 'operationId',
    providerHeader: null,
    /** Le seul arbitrage possible : signaler plutôt que risquer un doublon. */
    ambiguousResolution: 'FAIL_VISIBLE_NEVER_AUTO_RETRY',
  }),

  timeoutMs: 15_000,
  /** Rejouer un envoi accepté enverrait un second e-mail. Jamais automatiquement. */
  retryOnUnknownOutcome: false,

  permission: 'email:send',
  environmentSource: ENVIRONMENT_SOURCES.CONTROL_PLANE,
  templateAuthority: TEMPLATE_AUTHORITIES.PANEL,
  /** Résolue depuis le projet AUTHENTIFIÉ, jamais depuis la charge utile (§E). */
  senderIdentityScope: 'PROJECT_AUTHENTICATED',
  attachments: ATTACHMENT_POLICY,

  /** Ce que le journal du Panel garde. Aucune adresse en clair, aucun contenu. */
  audit: Object.freeze([
    'provider', 'environment', 'projectId', 'capability', 'operationId',
    'outcome', 'providerMessageId', 'httpStatus', 'durationMs', 'errorCode',
  ]),

  persistence: Object.freeze({
    [PERSISTENCE_OWNERS.PANEL]: Object.freeze([
      'diagnostic d’exécution', 'identifiant de message fournisseur', 'issue technique datée',
    ]),
    [PERSISTENCE_OWNERS.PROJECT]: Object.freeze([
      'communication métier', 'destinataire', 'contenu rendu', 'statut lu par l’utilisateur',
    ]),
  }),

  /** Correspondance fournisseur — la SEULE ligne de ce fichier qui parle Brevo. */
  providerMapping: Object.freeze({
    method: 'POST',
    path: '/smtp/email',
    /**
     * `templateId` est INTERDIT dans le corps envoyé à Brevo : il ferait sortir
     * le contenu de nos versions et le rendrait éditable depuis leur interface.
     * On envoie `subject` + `htmlContent` rendus par le Panel.
     */
    forbiddenBodyFields: Object.freeze(['templateId']),
    responseIdField: 'messageId',
  }),
});

/**
 * `email.sender.verify` — prouver que la chaîne d'envoi fonctionne.
 *
 * Elle existe déjà côté projet sous la forme de l'« envoi de test » du Manager,
 * et c'est la seule preuve qui vaille : ni `/senders` ni `/domains` ne disent
 * si un e-mail PART réellement. Le contenu est fixe et technique — d'où
 * l'absence de `templateRef`.
 */
const EMAIL_SENDER_VERIFY = Object.freeze({
  code: 'email.sender.verify',
  label: 'Vérifier la chaîne d’envoi',
  provider: 'BREVO',
  intent: 'Constater, par un envoi réel, que ce projet peut remettre un e-mail.',

  input: Object.freeze([
    field('recipient', 'object', {
      required: true,
      personalData: true,
      description: '{ email } — adresse de contrôle. Jamais un envoi automatique.',
    }),
    field('operationId', 'string', { required: true, description: 'Clé d’idempotence (§H).' }),
  ]),
  output: Object.freeze([
    field('status', 'string', { required: true, description: 'ACCEPTED | UNKNOWN — jamais « livré ».' }),
    field('providerMessageId', 'string', { required: false }),
  ]),
  errors: Object.freeze([
    CAPABILITY_ERROR_CODES.INPUT_INVALID,
    CAPABILITY_ERROR_CODES.CAPABILITY_FORBIDDEN,
    CAPABILITY_ERROR_CODES.PROVIDER_NOT_AVAILABLE,
    CAPABILITY_ERROR_CODES.PROVIDER_REJECTED,
    CAPABILITY_ERROR_CODES.PROVIDER_UNAVAILABLE,
    CAPABILITY_ERROR_CODES.PROVIDER_CONTRACT_VIOLATION,
    CAPABILITY_ERROR_CODES.PROVIDER_OUTCOME_UNKNOWN,
    CAPABILITY_ERROR_CODES.SENDER_IDENTITY_MISSING,
    CAPABILITY_ERROR_CODES.ENVIRONMENT_MISMATCH,
  ]),
  idempotency: Object.freeze({
    strength: IDEMPOTENCY_STRENGTHS.CALLER_ENFORCED,
    keyField: 'operationId',
    providerHeader: null,
    ambiguousResolution: 'FAIL_VISIBLE_NEVER_AUTO_RETRY',
  }),
  timeoutMs: 15_000,
  retryOnUnknownOutcome: false,
  permission: 'email:verify',
  environmentSource: ENVIRONMENT_SOURCES.CONTROL_PLANE,
  templateAuthority: TEMPLATE_AUTHORITIES.PANEL,
  senderIdentityScope: 'PROJECT_AUTHENTICATED',
  attachments: ATTACHMENT_POLICY,
  audit: Object.freeze([
    'provider', 'environment', 'projectId', 'capability', 'operationId',
    'outcome', 'providerMessageId', 'httpStatus', 'durationMs', 'errorCode',
  ]),
  persistence: Object.freeze({
    [PERSISTENCE_OWNERS.PANEL]: Object.freeze(['issue du contrôle', 'identifiant de message fournisseur']),
    [PERSISTENCE_OWNERS.PROJECT]: Object.freeze(['affichage « votre configuration fonctionne »']),
  }),
  providerMapping: Object.freeze({
    method: 'POST',
    path: '/smtp/email',
    forbiddenBodyFields: Object.freeze(['templateId']),
    responseIdField: 'messageId',
  }),
});

export const BREVO_CAPABILITIES = Object.freeze({
  [EMAIL_SEND_TEMPLATE.code]: EMAIL_SEND_TEMPLATE,
  [EMAIL_SENDER_VERIFY.code]: EMAIL_SENDER_VERIFY,
});

export const BREVO_CAPABILITY_CODES = Object.freeze(Object.keys(BREVO_CAPABILITIES));

/* -------------------------------------------------------------------------- */
/*  ACCÈS                                                                     */
/* -------------------------------------------------------------------------- */

export function isBrevoCapability(code) {
  return typeof code === 'string' && Object.hasOwn(BREVO_CAPABILITIES, code);
}

/** Définition d'une capacité, ou `null`. L'appelant décide si l'absence est une erreur. */
export function getBrevoCapability(code) {
  return isBrevoCapability(code) ? BREVO_CAPABILITIES[code] : null;
}

export function listBrevoCapabilities() {
  return BREVO_CAPABILITY_CODES.map((code) => BREVO_CAPABILITIES[code]);
}

/**
 * Vue publique — ce qu'un écran de diagnostic peut montrer.
 *
 * Ni chemin d'API, ni correspondance fournisseur : une page d'administration
 * n'a pas besoin de savoir que la capacité tape sur `/smtp/email`, et l'y faire
 * figurer inviterait quelqu'un à s'en servir.
 */
export function describeBrevoCapability(code) {
  const capability = getBrevoCapability(code);
  if (!capability) return null;
  return {
    code: capability.code,
    label: capability.label,
    intent: capability.intent,
    provider: capability.provider,
    permission: capability.permission,
    environmentSource: capability.environmentSource,
    templateAuthority: capability.templateAuthority,
    senderIdentityScope: capability.senderIdentityScope,
    idempotency: { ...capability.idempotency },
    timeoutMs: capability.timeoutMs,
    attachmentsSupported: capability.attachments.supported,
    errors: [...capability.errors],
    /** L8 est déclaratif : la passerelle d'invocation appartient à L3. */
    invocable: false,
  };
}

/**
 * DÉRIVE ENTRE DEUX REGISTRES — le contrôle qui évite deux vérités.
 *
 * `providerRegistry.BREVO.capabilities` est la liste que l'écran d'administration
 * affiche (L1). Ce fichier est la liste que L3 devra savoir exécuter. Si les
 * deux divergent, l'interface promet une capacité que la passerelle ne connaît
 * pas — ou l'inverse. Le test appelle cette fonction ; elle ne corrige rien,
 * elle constate.
 *
 * @returns {string[]} problèmes, vide si les deux registres s'accordent.
 */
export function capabilityRegistryDrift() {
  const declared = getProviderDefinition('BREVO')?.capabilities ?? [];
  const problems = [];
  for (const code of declared) {
    if (!isBrevoCapability(code)) {
      problems.push(`providerRegistry déclare « ${code} » — absent du catalogue L8.`);
    }
  }
  for (const code of BREVO_CAPABILITY_CODES) {
    if (!declared.includes(code)) {
      problems.push(`le catalogue L8 déclare « ${code} » — absent de providerRegistry.`);
    }
  }
  return problems;
}

/**
 * Cohérence interne du catalogue — ce qu'un humain casse en éditant ce fichier.
 *
 * @returns {string[]} problèmes, vide si tout est cohérent.
 */
export function validateBrevoCapabilities() {
  const problems = [];
  for (const [code, capability] of Object.entries(BREVO_CAPABILITIES)) {
    if (capability.code !== code) {
      problems.push(`code incohérent : clé « ${code} », valeur « ${capability.code} ».`);
    }
    if (capability.provider !== 'BREVO') {
      problems.push(`${code} : provider attendu BREVO, trouvé « ${capability.provider} ».`);
    }
    if (capability.environmentSource !== ENVIRONMENT_SOURCES.CONTROL_PLANE) {
      problems.push(`${code} : l’environnement doit venir du plan de contrôle.`);
    }
    if (capability.templateAuthority !== TEMPLATE_AUTHORITIES.PANEL) {
      problems.push(`${code} : l’autorité du contenu doit rester au Panel (§C).`);
    }
    if (!capability.providerMapping.forbiddenBodyFields.includes('templateId')) {
      problems.push(`${code} : « templateId » doit rester interdit dans le corps envoyé à Brevo.`);
    }
    // Une capacité sans clé d'idempotence, c'est un doublon qui attend son tour.
    if (!capability.idempotency.keyField) {
      problems.push(`${code} : aucune clé d’idempotence déclarée.`);
    }
    if (!capability.input.some((f) => f.name === capability.idempotency.keyField)) {
      problems.push(`${code} : la clé d’idempotence « ${capability.idempotency.keyField} » n’est pas une entrée.`);
    }
    // L'expéditeur n'est JAMAIS une entrée : ce serait pouvoir écrire au nom d'un autre.
    if (capability.input.some((f) => ['sender', 'from', 'fromEmail', 'senderEmail'].includes(f.name))) {
      problems.push(`${code} : l’expéditeur ne peut pas être un paramètre d’entrée (§D).`);
    }
    // Aucune entrée ne peut désigner un fichier du disque du Panel (§L).
    if (capability.input.some((f) => /path|filepath|filename|localFile/i.test(f.name))) {
      problems.push(`${code} : aucune entrée ne peut porter un chemin de fichier (§L).`);
    }
    if (capability.attachments.acceptsFilesystemPath) {
      problems.push(`${code} : la politique de pièces jointes accepte un chemin — interdit (§L).`);
    }
    if (capability.retryOnUnknownOutcome) {
      problems.push(`${code} : un rejeu automatique sur issue inconnue produirait un doublon (§H).`);
    }
    if (!Number.isFinite(capability.timeoutMs) || capability.timeoutMs <= 0) {
      problems.push(`${code} : délai d’attente absent ou invalide.`);
    }
    if (!capability.audit.includes('operationId') || !capability.audit.includes('environment')) {
      problems.push(`${code} : le journal doit porter au moins operationId et environment.`);
    }
    // Un journal qui nomme un champ de contenu ou une adresse est une fuite.
    for (const entry of capability.audit) {
      if (/recipient|email|content|html|subject|variables/i.test(entry)) {
        problems.push(`${code} : le journal ne doit pas porter « ${entry} » (donnée personnelle).`);
      }
    }
  }
  return problems;
}

export default {
  BREVO_CAPABILITIES,
  BREVO_CAPABILITY_CODES,
  CAPABILITY_ERROR_CODES,
  ENVIRONMENT_SOURCES,
  IDEMPOTENCY_STRENGTHS,
  TEMPLATE_AUTHORITIES,
  PERSISTENCE_OWNERS,
  ATTACHMENT_POLICY,
  isBrevoCapability,
  getBrevoCapability,
  listBrevoCapabilities,
  describeBrevoCapability,
  capabilityRegistryDrift,
  validateBrevoCapabilities,
};
