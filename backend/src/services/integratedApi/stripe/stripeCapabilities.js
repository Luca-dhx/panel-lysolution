// CAPACITÉS STRIPE — les contrats, avant tout cutover (L6.1).
//
// docs/architecture/STRIPE_L6_1_CONTROL_PLANE_FOUNDATION_REPORT.md §« Capacités ».
//
// ── CE FICHIER NE MIGRE RIEN ────────────────────────────────────────────────
//
// Il POSE les contrats : ce qu'une capacité accepte, ce qu'elle rend, ce
// qu'elle exige avant d'agir. Aucune n'est déclarée servie — l'ancrage
// d'appartenance des ressources Stripe n'existe pas encore côté Panel
// (`stripeResourceOwnership.js`), et servir sans lui donnerait à un projet le
// pouvoir d'agir sur les objets d'un autre.
//
// ── LES CAPACITÉS VIENNENT DU RUNTIME RÉEL ──────────────────────────────────
//
// L'audit du 2026-08-10 relève exactement treize méthodes appelées côté projet.
// On n'en contractualise ici que celles qui correspondent à un ACTE MÉTIER
// distinct — pas les primitives internes qu'un acte compose.
//
// Ainsi `createProduct` et `createPrice` n'ont pas de capacité : elles ne sont
// jamais un but, seulement les deux étapes que `ensureProductAndPrice` traverse
// pour figer le tarif d'un abonnement. Les exposer donnerait au projet un
// pouvoir qu'il n'a jamais demandé — créer des produits arbitraires sur le
// compte Stripe de la plateforme.
//
// De même, `billing.refund` n'est PAS déclarée : aucun code du parc n'appelle
// `refunds.create`. L'événement `charge.refunded` est consommé — donc un
// remboursement peut arriver, mais toujours depuis le tableau de bord Stripe.
// Contractualiser un remboursement que personne n'émet créerait la capacité la
// plus dangereuse du système pour un usage qui n'existe pas.
import { z } from 'zod';

import { getProviderDefinition } from '../providerRegistry.js';
import { CAPABILITY_EFFECTS } from '../commercialReadiness.js';
import { STRIPE_RESOURCE_KINDS } from './stripeResourceOwnership.js';

/* -------------------------------------------------------------------------- */
/*  SCHÉMAS                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * `operationId` — l'identité de l'ACTE MÉTIER, fournie par le projet.
 *
 * Plus long que pour les autres fournisseurs (16 caractères minimum) : sur un
 * provider financier, deux actes distincts qui se retrouveraient avec la même
 * identité produiraient soit un paiement manquant, soit un doublon. On force
 * une identité assez large pour être réellement unique.
 */
const operationId = z.string().trim().min(16).max(96);

/** Identifiants Stripe — forme contrôlée, appartenance vérifiée plus loin. */
const subscriptionId = z.string().trim().regex(/^sub_[A-Za-z0-9_]+$/, 'Identifiant d’abonnement invalide.');
const customerId = z.string().trim().regex(/^cus_[A-Za-z0-9_]+$/, 'Identifiant de client invalide.');
const checkoutSessionId = z.string().trim().regex(/^cs_[A-Za-z0-9_]+$/, 'Identifiant de session invalide.');

/**
 * `strict()` partout. Les champs explicitement REFUSÉS, et pourquoi :
 *
 *   `mode`, `environment`, `livemode`  le monde appartient au Panel (L2) ;
 *   `secretKey`, `apiKey`              le projet n'en détient plus ;
 *   `account`, `stripeAccount`         Connect n'est pas utilisé, et l'ouvrir
 *                                      permettrait d'agir sur un autre compte ;
 *   `amount` libre sur une lecture     une lecture ne porte pas de montant.
 */
const invoiceListInput = z.object({
  /** L'un OU l'autre — la validation croisée est plus bas. */
  customerId: customerId.optional(),
  subscriptionId: subscriptionId.optional(),
  limit: z.number().int().min(1).max(100).optional(),
  operationId,
}).strict().refine(
  (value) => Boolean(value.customerId) !== Boolean(value.subscriptionId),
  { message: 'Fournir exactement un client OU un abonnement.' },
);

const subscriptionRetrieveInput = z.object({ subscriptionId, operationId }).strict();

const checkoutRetrieveInput = z.object({ checkoutSessionId, operationId }).strict();

/**
 * `billing.checkout.create` — le contrat le plus délicat du lot.
 *
 * Le projet décrit l'INTENTION (quel contrat, quel type de paiement, où
 * revenir) ; il ne décrit ni le prix, ni le client Stripe, ni la devise. Le
 * montant vient de la projection de contrat que le Panel détient déjà : laisser
 * le projet l'annoncer permettrait de facturer un euro un contrat à mille.
 */
const checkoutCreateInput = z.object({
  /** Référence du contrat, telle que le Panel la connaît par projection. */
  contractRef: z.string().trim().min(1).max(64),
  paymentType: z.enum(['LAUNCH_FEE', 'SUBSCRIPTION']),
  successUrl: z.string().trim().url().max(2048),
  cancelUrl: z.string().trim().url().max(2048),
  /**
   * CORROBORATION — recopiée dans les metadata Stripe, jamais interrogée (L6.2B).
   *
   * Le journal de paiement du projet se rattache aux objets Stripe par
   * `metadata.paymentId` depuis l'origine ; couper ce fil casserait la
   * réconciliation historique sans rien gagner. Mais ces valeurs ne décident de
   * RIEN : les metadata Stripe s'éditent depuis le tableau de bord, et
   * l'autorité d'appartenance reste le registre de liens de L6.2A.
   *
   * Volontairement close et courte : c'est une référence opaque, pas un canal.
   */
  correlation: z.object({
    paymentRef: z.string().trim().min(1).max(64).optional(),
  }).strict().optional(),
  operationId,
}).strict();

const subscriptionCancelInput = z.object({ subscriptionId, operationId }).strict();

/* -------------------------------------------------------------------------- */
/*  SORTIES                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Ce qui revient au projet : un CONSTAT métier, jamais l'objet Stripe brut.
 *
 * Un objet Stripe complet porte le client, ses adresses, ses moyens de
 * paiement, et l'identifiant du compte. Le relayer ferait traverser au pont des
 * données personnelles qu'aucune capacité n'a promises.
 */
const invoiceView = z.object({
  invoiceId: z.string(),
  number: z.string().nullable(),
  status: z.string().nullable(),
  amountDue: z.number().nullable(),
  amountPaid: z.number().nullable(),
  currency: z.string().nullable(),
  createdAt: z.number().nullable(),
  hostedInvoiceUrl: z.string().nullable(),
  invoicePdfUrl: z.string().nullable(),
}).strict();

const invoiceListOutput = z.object({
  invoices: z.array(invoiceView),
  hasMore: z.boolean(),
}).strict();

const subscriptionView = z.object({
  subscriptionId: z.string(),
  status: z.string(),
  cancelAtPeriodEnd: z.boolean(),
  currentPeriodEnd: z.number().nullable(),
  currency: z.string().nullable(),
}).strict();

/**
 * VUE DE LECTURE — établie sur ce que le projet CONSOMME, pas sur ce que Stripe
 * expose (L6.2C).
 *
 * `paymentIntentId` et `customerId` s'ajoutent au contrat L6.1 parce que le
 * filet de réconciliation du projet en a besoin : sans eux, il marquerait un
 * paiement PAYÉ sans savoir quelle transaction l'a payé, et le journal
 * affirmerait plus qu'il ne sait.
 *
 * Rien d'autre ne s'y ajoute. Notamment pas les metadata : elles sont
 * corroboratives par nature (éditables depuis le tableau de bord), et les
 * rendre inviterait un appelant à s'en servir comme d'une autorité.
 */
const checkoutView = z.object({
  checkoutSessionId: z.string(),
  status: z.string().nullable(),
  paymentStatus: z.string().nullable(),
  /** L'URL n'est rendue QUE tant que la session est ouverte. */
  url: z.string().nullable(),
  expiresAt: z.number().nullable(),
  paymentIntentId: z.string().nullable(),
  customerId: z.string().nullable(),
}).strict();

const checkoutCreateOutput = z.object({
  checkoutSessionId: z.string(),
  /**
   * NULLABLE, et c'est un fait métier (corrigé en L6.2B).
   *
   * Stripe cesse de rendre une URL dès que la session est complétée ou expirée.
   * Le contrat L6.1 la promettait toujours présente : sur une REPRISE d'acte
   * déjà payé, il aurait fallu inventer une chaîne, et le projet aurait envoyé
   * un client vers un lien mort en croyant l'envoyer payer.
   */
  url: z.string().nullable(),
  /**
   * L'ÉTAT, parce qu'une reprise doit pouvoir se raconter.
   *
   * Ce n'est pas l'ouverture d'une capacité de lecture : c'est la description
   * de l'objet que CET appel vient de produire ou de retrouver. Sans elle, un
   * `REUSED` sans URL serait indistinguable d'une panne.
   */
  status: z.string().nullable(),
  paymentStatus: z.string().nullable(),
  /**
   * LES DEUX OBJETS QUE LA SESSION A ELLE-MÊME PRODUITS.
   *
   * Ils ne sont pas une lecture offerte au projet : ce sont les sous-produits
   * de l'acte qu'il vient de demander, et ils lui appartiennent au même titre
   * que la session. Sans eux, la réparation d'un webhook perdu marquerait un
   * paiement PAYÉ sans savoir quelle transaction l'a payé — un journal qui
   * affirme plus qu'il ne sait.
   *
   * `null` tant que la session est ouverte : Stripe ne les attribue qu'au
   * paiement. Aucun secret : ce sont des identifiants d'objets, pas des clés.
   */
  paymentIntentId: z.string().nullable(),
  customerId: z.string().nullable(),
  /** `REUSED` quand l'acte avait déjà produit sa session — voir L6.2B §reprise. */
  creation: z.enum(['CREATED', 'REUSED']),
  operationId: z.string(),
}).strict();

/* -------------------------------------------------------------------------- */
/*  DÉFINITIONS                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Effets PROPOSÉS pour les codes que la table de L1.75 ne connaît pas encore.
 *
 * Même dispositif qu'en L9 : la table officielle l'emporte dès qu'elle connaît
 * un code, et `validateStripeCapabilities()` échoue si les deux divergent.
 * Les codes déjà présents (`billing.checkout.create`,
 * `billing.subscription.cancel_at_period_end`, `billing.invoice.list`,
 * `billing.subscription.reconcile`) ne figurent PAS ici : ils ont leur autorité.
 */
/**
 * FAMILLES DE RESSOURCES QUE LE PANEL SAIT DÉJÀ POSSÉDER (L6.2C).
 *
 * ══ POURQUOI CETTE LISTE, ET POURQUOI ELLE EST COURTE ═══════════════════════
 *
 * Une capacité qui exige de POSSÉDER un objet Stripe ne peut être servie que si
 * le Panel en crée — et donc en lie — au moins un. Sans cela, elle serait ou
 * bien toujours refusée, ou bien, bien pire, servie en faisant confiance à
 * l'identifiant que le projet présente.
 *
 * `CHECKOUT_SESSION` y entre parce que L6.2B en crée et les lie à la création.
 * `CUSTOMER`, `SUBSCRIPTION`, `INVOICE`, `PAYMENT_INTENT` n'y sont pas : le
 * Panel n'en a jamais créé, donc le registre de liens n'en contient aucun.
 *
 * Cette liste se lit comme une DETTE : chaque famille qui s'y ajoute débloque
 * les capacités qui l'exigeaient, et pas une de plus.
 */
const BINDABLE_KINDS = Object.freeze([STRIPE_RESOURCE_KINDS.CHECKOUT_SESSION]);

const PROPOSED_EFFECTS = Object.freeze({
  'billing.checkout.retrieve': 'READ_ONLY',
  'billing.subscription.retrieve': 'READ_ONLY',
});

function capability(code, options) {
  const definition = getProviderDefinition('STRIPE');
  return Object.freeze({
    code,
    provider: 'STRIPE',
    scope: definition?.scope ?? null,
    effectNature: CAPABILITY_EFFECTS[code] ?? PROPOSED_EFFECTS[code] ?? null,
    label: options.label,
    /**
     * AUCUNE n'était servie en L6.1, et ce n'était pas un oubli : le lien
     * d'appartenance manquait. L6.2A l'a livré, L6.2B en sert la première —
     * celle, et la seule, qui ne dépend d'aucun objet Stripe préexistant.
     *
     * Les autres restent fermées : elles exigent un lien vers un client ou un
     * abonnement que le Panel n'a encore jamais créé, et
     * `validateStripeCapabilities()` refuse qu'on l'oublie.
     */
    migrated: options.migrated === true,
    inputSchema: options.inputSchema,
    outputSchema: options.outputSchema,
    timeoutMs: options.timeoutMs,
    idempotency: options.idempotency,
    requiredPermissions: Object.freeze([...options.requiredPermissions]),
    migrationNote: options.migrationNote,
    /** Famille de ressource dont l'appartenance doit être prouvée. */
    resourceKind: options.resourceKind ?? null,
    requiresResourceOwnership: Boolean(options.resourceKind),
    /**
     * L'acte est-il financier ? Distinct de `effectNature`, qui décrit l'effet
     * sur le monde : `cancel_at_period_end` est FINANCIAL_WRITE et pourtant
     * réversible, tandis qu'une lecture de facture ne l'est pas du tout. Ce
     * drapeau pilote la doctrine de rejeu, pas la politique commerciale.
     */
    financial: options.financial === true,
  });
}

export const STRIPE_CAPABILITIES = Object.freeze({
  /* ── LECTURES ─────────────────────────────────────────────────────────── */

  'billing.invoice.list': capability('billing.invoice.list', {
    label: 'Lister les factures d’un contrat',
    inputSchema: invoiceListInput,
    outputSchema: invoiceListOutput,
    timeoutMs: 20_000,
    idempotency: 'SAFE_RETRY',
    requiredPermissions: ['billing:read'],
    resourceKind: STRIPE_RESOURCE_KINDS.CUSTOMER,
    migrationNote:
      'Contrat posé. Bloquée par l’absence de lien projet ↔ client Stripe côté Panel.',
  }),

  'billing.subscription.retrieve': capability('billing.subscription.retrieve', {
    label: 'Lire l’état d’un abonnement',
    inputSchema: subscriptionRetrieveInput,
    outputSchema: subscriptionView,
    timeoutMs: 20_000,
    idempotency: 'SAFE_RETRY',
    requiredPermissions: ['billing:read'],
    resourceKind: STRIPE_RESOURCE_KINDS.SUBSCRIPTION,
    migrationNote: 'Contrat posé. Bloquée par l’absence de lien projet ↔ abonnement.',
  }),

  'billing.checkout.retrieve': capability('billing.checkout.retrieve', {
    label: 'Lire l’état d’une session de paiement',
    inputSchema: checkoutRetrieveInput,
    outputSchema: checkoutView,
    timeoutMs: 20_000,
    idempotency: 'SAFE_RETRY',
    requiredPermissions: ['billing:read'],
    resourceKind: STRIPE_RESOURCE_KINDS.CHECKOUT_SESSION,
    /**
     * C'est la lecture du parcours de retour de paiement — celle qui, côté
     * projet, a déjà provoqué une boucle d'interrogation. La migrer ne doit pas
     * servir de prétexte à refondre ce parcours : mêmes appels, même cadence.
     */
    /**
     * SERVIE depuis L6.2C. Elle est la première capacité du parc dont
     * l'autorisation repose sur une APPARTENANCE PROUVÉE plutôt que sur un
     * simple octroi : posséder l'identifiant ne suffit pas, il faut que le
     * Panel ait lui-même lié la ressource au projet demandeur.
     *
     * La cadence d'interrogation du parcours de retour n'a pas été touchée :
     * les mêmes appels, aux mêmes moments, par une autre porte.
     */
    migrated: true,
    migrationNote: null,
  }),

  /* ── ÉCRITURES FINANCIÈRES ────────────────────────────────────────────── */

  'billing.checkout.create': capability('billing.checkout.create', {
    label: 'Ouvrir une session de paiement',
    inputSchema: checkoutCreateInput,
    outputSchema: checkoutCreateOutput,
    timeoutMs: 25_000,
    /**
     * Stripe déduplique sur `Idempotency-Key`, et c'est la garantie la plus
     * forte du parc : deux appels de la même clé rendent la MÊME session, pas
     * deux paiements. Encore faut-il que la clé soit stable — c'est le rôle du
     * registre d'opérations du Panel, pas du hasard.
     */
    idempotency: 'PROVIDER_IDEMPOTENT',
    requiredPermissions: ['billing:write'],
    financial: true,
    /**
     * Aucune ressource préexistante à posséder : la session est créée. Mais le
     * CONTRAT, lui, doit appartenir au projet — vérifié par la projection, pas
     * par un identifiant Stripe.
     */
    resourceKind: null,
    /**
     * SERVIE depuis L6.2B — et c'est justement `resourceKind: null` qui l'a
     * rendue migrable la première : elle ne consomme aucun objet Stripe
     * préexistant, elle en CRÉE un. Sa contrepartie est qu'elle doit lier ce
     * qu'elle crée, immédiatement, sans quoi la ressource serait orpheline.
     */
    migrated: true,
    migrationNote: null,
  }),

  'billing.subscription.cancel_at_period_end': capability('billing.subscription.cancel_at_period_end', {
    label: 'Résilier un abonnement en fin de période',
    inputSchema: subscriptionCancelInput,
    outputSchema: subscriptionView,
    timeoutMs: 25_000,
    idempotency: 'PROVIDER_IDEMPOTENT',
    requiredPermissions: ['billing:write'],
    financial: true,
    resourceKind: STRIPE_RESOURCE_KINDS.SUBSCRIPTION,
    migrationNote:
      'ÉCRITURE FINANCIÈRE — L6.2. Convergente (poser deux fois le même drapeau '
      + 'donne le même état), mais elle décide de ne plus prélever : c’est un engagement.',
  }),
});

export const STRIPE_CAPABILITY_CODES = Object.freeze(Object.keys(STRIPE_CAPABILITIES));

export function isStripeCapability(code) {
  return typeof code === 'string' && Object.hasOwn(STRIPE_CAPABILITIES, code);
}

export function getStripeCapability(code) {
  return isStripeCapability(code) ? STRIPE_CAPABILITIES[code] : null;
}

/**
 * Cohérence du catalogue. Ce que cette fonction refuse est exactement ce qui,
 * sur un provider financier, coûterait de l'argent réel.
 */
export function validateStripeCapabilities() {
  const problems = [];
  for (const [code, definition] of Object.entries(STRIPE_CAPABILITIES)) {
    if (definition.code !== code) problems.push(`code incohérent : « ${code} ».`);
    if (definition.provider !== 'STRIPE') problems.push(`${code} : fournisseur inattendu.`);
    if (!definition.effectNature) problems.push(`${code} : aucun effet déclaré.`);

    const officiel = CAPABILITY_EFFECTS[code];
    if (officiel && officiel !== definition.effectNature) {
      problems.push(`${code} : effet proposé « ${definition.effectNature} » ≠ table L1.75 « ${officiel} ».`);
    }

    // Stripe est à portée ENVIRONMENT : deux comptes, deux mondes.
    if (definition.scope !== 'ENVIRONMENT') {
      problems.push(`${code} : Stripe doit rester ENVIRONMENT (trouvé « ${definition.scope} »).`);
    }
    if (!definition.inputSchema || !definition.outputSchema) {
      problems.push(`${code} : contrat d’entrée ou de sortie manquant.`);
    }
    /**
     * LA RÈGLE A CHANGÉ DE FORME, PAS DE FOND (L6.2B).
     *
     * En L6.1 elle disait « aucune n'est servie », faute d'ancrage
     * d'appartenance. L'ancrage existe désormais, mais il ne contient encore
     * AUCUN client ni abonnement : une capacité qui exige de posséder un objet
     * préexistant serait donc servie pour être toujours refusée — ou, bien
     * pire, servie en faisant confiance à l'identifiant fourni.
     *
     * La règle devient donc : on ne sert que ce qui n'exige aucune possession
     * préalable. Elle se lèvera d'elle-même, capacité par capacité, quand le
     * Panel créera lui-même les clients et les abonnements.
     */
    if (definition.migrated
      && definition.requiresResourceOwnership
      && !BINDABLE_KINDS.includes(definition.resourceKind)) {
      problems.push(`${code} : servie alors qu’aucun lien vers ${definition.resourceKind} n’existe encore.`);
    }
    // Une écriture financière servie doit lier ce qu'elle crée : sans preuve
    // d'appartenance, la ressource produite n'appartiendrait à personne.
    if (definition.migrated && definition.financial && definition.idempotency !== 'PROVIDER_IDEMPOTENT') {
      problems.push(`${code} : écriture financière servie sans idempotence fournisseur.`);
    }

    const shape = definition.inputSchema?._def?.schema?.shape ?? definition.inputSchema?.shape ?? {};

    // Le monde n'est JAMAIS une entrée.
    for (const forbidden of ['mode', 'environment', 'livemode', 'stripeEnvironment']) {
      if (Object.hasOwn(shape, forbidden)) problems.push(`${code} : « ${forbidden} » ne peut pas être une entrée.`);
    }
    // Aucun credential, aucun compte tiers.
    for (const forbidden of ['secretKey', 'apiKey', 'credentials', 'account', 'stripeAccount', 'baseUrl']) {
      if (Object.hasOwn(shape, forbidden)) problems.push(`${code} : « ${forbidden} » ne peut pas être une entrée.`);
    }
    // Le montant ne vient jamais du projet : il vient de la projection.
    for (const forbidden of ['amount', 'unitAmount', 'price', 'currency']) {
      if (Object.hasOwn(shape, forbidden)) {
        problems.push(`${code} : « ${forbidden} » ne peut pas venir du projet (§ montant).`);
      }
    }
    if (!Object.hasOwn(shape, 'operationId')) {
      problems.push(`${code} : toute capacité financière doit porter un operationId.`);
    }
    // Une ÉCRITURE financière sans idempotence fournisseur est un doublon en
    // attente. Une lecture n'a pas ce problème : la rejouer ne produit rien.
    if (definition.financial && definition.idempotency !== 'PROVIDER_IDEMPOTENT') {
      problems.push(`${code} : écriture financière sans idempotence fournisseur.`);
    }
  }
  return problems;
}

export default {
  STRIPE_CAPABILITIES,
  STRIPE_CAPABILITY_CODES,
  isStripeCapability,
  getStripeCapability,
  validateStripeCapabilities,
};
