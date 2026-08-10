// REGISTRE DES CAPACITÉS WEBHOOK — L5 du plan de contrôle IntegratedAPI.
//
// docs/architecture/WEBHOOK_CONTROL_PLANE.md · roadmap §8, §13 (L5).
//
// ── CE N'EST PAS UN SECOND REGISTRE ─────────────────────────────────────────
//
// `providerRegistry.js` reste L'AUTORITÉ : lui seul décide quels fournisseurs
// existent, et lui seul déclare `supportsWebhookReconciliation` et
// `webhookSecretReturnedAtCreationOnly`. Ce fichier ne redéclare aucun de ces
// faits — il décrit COMMENT le webhook se gère quand le registre a dit qu'il
// se gère : quelle route l'écoute, quels événements on souscrit, quel schéma
// de signature s'applique, quel rôle du coffre porte le secret.
//
// L'alignement des deux fichiers n'est pas une convention d'écriture : il est
// VÉRIFIÉ à l'import (`assertRegistryAlignment`). Un descripteur qui prétend
// gérer un webhook que le registre déclare absent fait échouer le démarrage,
// pas un test lointain.
//
// ── LES DIFFÉRENCES SONT DES CAPACITÉS, PAS DES `if` ────────────────────────
//
// Stripe ne relit pas son secret. Brevo ne signe rien. Yousign a deux hôtes.
// Hostinger n'a pas de webhook du tout. Ces quatre faits sont des CHAMPS ici,
// consommés par le réconciliateur, l'endpoint entrant et l'écran. Aucun de ces
// trois consommateurs n'écrit `if (provider === 'STRIPE')`.
//
// ── CE QUE CE FICHIER NE CONTIENT PAS ───────────────────────────────────────
//
// Aucun secret, aucune clé, aucune URL absolue. La callback se CALCULE depuis
// la configuration canonique du Panel (`webhookCallback.js`) — le registre
// n'en connaît que le segment de route.
import { createHash } from 'node:crypto';

import { ENVIRONMENTS, getProviderDefinition, listProviderDefinitions, credentialRole } from '../integratedApi/providerRegistry.js';
/**
 * CONNAISSANCE BREVO — livrée par L8, consommée ici.
 *
 * L8 possède le fournisseur ; L5 possède le moteur. Redéclarer la liste des
 * événements ou les particularités de l'API Brevo dans ce fichier créerait
 * deux vérités destinées à diverger — et c'est justement ce que le lot Brevo a
 * pris soin d'éviter en publiant un module déclaratif.
 */
import {
  SUBSCRIBED_EVENTS as BREVO_SUBSCRIBED_EVENTS,
  BREVO_WEBHOOK_FACTS,
  compareSubscribedEvents,
  normalizeBrevoEvent,
  buildEventIdentity as buildBrevoEventIdentity,
  parseEventDate as parseBrevoEventDate,
} from '../integratedApi/brevo/brevoEventMapping.js';
/** Même raison : la forme canonique d'un `message-id` appartient au lot Brevo. */
import { normalizeProviderMessageId } from '../integratedApi/brevo/brevoTransport.js';

/* -------------------------------------------------------------------------- */
/*  VOCABULAIRE FERMÉ                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Comment un appel entrant se PROUVE.
 *
 * La distinction entre `HMAC_*` et `SHARED_SECRET_BEARER` n'est pas cosmétique :
 * un webhook HMAC est *prouvé* (seul le détenteur du secret a pu produire la
 * signature de CE corps), un webhook Bearer est seulement *authentifié* (le
 * porteur du jeton, quel qu'il soit). Le second est plus faible, et le code
 * doit pouvoir le dire — pas prétendre à une garantie qu'il n'a pas.
 */
export const SIGNATURE_SCHEMES = Object.freeze({
  /** `Stripe-Signature: t=…,v1=…` — HMAC-SHA256 sur `t.corpsBrut`. */
  HMAC_SHA256_STRIPE: 'HMAC_SHA256_STRIPE',
  /** HMAC-SHA256 hexadécimal du corps brut, dans un en-tête dédié. */
  HMAC_SHA256_BODY: 'HMAC_SHA256_BODY',
  /** `Authorization: Bearer <secret>` — authentifié, jamais prouvé. */
  SHARED_SECRET_BEARER: 'SHARED_SECRET_BEARER',
  /** Le fournisseur n'offre aucun moyen de vérification. */
  NONE: 'NONE',
});

/** D'où vient le secret de vérification — la contrainte qui pilote la rotation. */
export const SECRET_DELIVERY = Object.freeze({
  /** Le fournisseur le rend UNE FOIS, à la création. Perdu = recréer. */
  AT_CREATION_ONLY: 'AT_CREATION_ONLY',
  /** C'est NOUS qui le posons : rotation possible sans recréer l'endpoint. */
  CALLER_SUPPLIED: 'CALLER_SUPPLIED',
  /** Le fournisseur le relit à la demande. Aucun fournisseur actuel. */
  READABLE: 'READABLE',
  /** Pas de secret du tout. */
  NONE: 'NONE',
});

/** Comment on identifie un événement pour l'idempotence (§J). */
export const EVENT_ID_STRATEGIES = Object.freeze({
  /** Le fournisseur fournit un identifiant d'événement stable. */
  PROVIDER_FIELD: 'PROVIDER_FIELD',
  /**
   * Aucun identifiant, mais une clé COMPOSITE reconstructible depuis le corps.
   * Plus robuste que l'empreinte : elle survit à une re-sérialisation par le
   * fournisseur (espaces, ordre des clés) qui changerait l'empreinte sans que
   * l'événement, lui, ait changé.
   */
  PROVIDER_COMPOSITE: 'PROVIDER_COMPOSITE',
  /** Dernier recours : empreinte du corps brut reçu. */
  PAYLOAD_DIGEST: 'PAYLOAD_DIGEST',
});

/**
 * COMPARAISON D'ÉVÉNEMENTS PAR DÉFAUT — une inclusion, pas une égalité.
 *
 * Un événement DÉSIRÉ mais absent manque : c'est une divergence. Un événement
 * EN TROP n'en est pas une. Les fournisseurs normalisent, regroupent et
 * renomment leurs libellés ; traiter chaque écart d'étiquette comme une dérive
 * produirait un `update` à chaque passage, éternellement.
 */
/**
 * Fenêtre de tolérance par défaut après une rotation de secret.
 *
 * Quinze minutes : la valeur établie par l'audit Brevo (L8,
 * `rotationWindowMs`), reprise comme défaut parce que le problème est le même
 * partout — un fournisseur qui réessaie avec backoff peut livrer un événement
 * plusieurs minutes après l'avoir produit. Plus court perdrait des événements ;
 * beaucoup plus long garderait un secret retiré vivant sans raison.
 */
const DEFAULT_ROTATION_WINDOW_MS = 15 * 60 * 1000;

function defaultCompareEvents(remoteEvents, desiredEvents) {
  const present = new Set(remoteEvents ?? []);
  if (present.has('*')) return { aligned: true, missing: [] };
  const missing = (desiredEvents ?? []).filter((event) => !present.has(event));
  return { aligned: missing.length === 0, missing };
}

/* -------------------------------------------------------------------------- */
/*  DESCRIPTEURS                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Un descripteur de capacité webhook.
 *
 * `supported: false` est un état de PREMIÈRE CLASSE : un fournisseur sans
 * webhook doit se déclarer, pas s'absenter. Une absence se confond avec un
 * oubli, et l'écran finirait par afficher « inconnu » là où la réponse exacte
 * est « ce fournisseur n'en a pas ».
 */
function capability(code, options = {}) {
  const supported = options.supported === true;
  return Object.freeze({
    provider: code,
    supported,
    /** Segment de route de la callback. Jamais une URL, jamais un domaine. */
    callbackSlug: options.callbackSlug ?? code.toLowerCase(),
    supportsList: supported && options.supportsList !== false,
    supportsCreate: supported && options.supportsCreate !== false,
    supportsUpdate: supported && options.supportsUpdate !== false,
    supportsDelete: supported && options.supportsDelete !== false,
    /** Le fournisseur sait-il relire le secret d'un endpoint existant ? */
    supportsSecretReadback: options.secretDelivery === SECRET_DELIVERY.READABLE,
    supportsSignatureVerification:
      supported && (options.signatureScheme ?? SIGNATURE_SCHEMES.NONE) !== SIGNATURE_SCHEMES.NONE,
    /**
     * Le fournisseur distingue-t-il lui-même TEST et PROD sur un même compte ?
     * `false` (le cas général ici) signifie : deux comptes, deux jeux de clés —
     * et donc deux endpoints qui ne peuvent PAS se voir l'un l'autre.
     */
    environmentAware: supported ? options.environmentAware === true : false,
    signatureScheme: options.signatureScheme ?? SIGNATURE_SCHEMES.NONE,
    /** En-tête portant la preuve. `null` pour `NONE`. */
    signatureHeader: options.signatureHeader ?? null,
    secretDelivery: options.secretDelivery ?? SECRET_DELIVERY.NONE,
    /** Rôle du coffre Panel qui porte le secret. Vérifié contre le registre. */
    secretRole: options.secretRole ?? null,
    /**
     * Rôle portant le secret RETIRÉ, accepté pendant la fenêtre de rotation.
     *
     * Il existe pour TOUS les fournisseurs à secret, pas seulement Brevo : la
     * fenêtre naît de la rotation elle-même, pas d'une particularité. Chez
     * Stripe et Yousign, le secret change en recréant l'endpoint — et entre le
     * moment où le nouveau secret est en coffre et celui où l'ancien endpoint
     * disparaît, des événements signés de l'ancien secret arrivent sur LA MÊME
     * URL. Sans tolérance, ils repartent en 401 et sont perdus.
     */
    secretPreviousRole: options.secretPreviousRole
      ?? (options.secretRole ? `${options.secretRole}Previous` : null),
    /**
     * Durée pendant laquelle le secret retiré reste accepté.
     * Pour Brevo, la valeur vient du lot L8 (`rotationWindowMs`).
     */
    secretRotationWindowMs: options.secretRotationWindowMs ?? DEFAULT_ROTATION_WINDOW_MS,
    /** Rôle du coffre portant la clé d'API nécessaire aux appels d'administration. */
    apiCredentialRole: options.apiCredentialRole ?? null,
    eventIdStrategy: options.eventIdStrategy ?? EVENT_ID_STRATEGIES.PAYLOAD_DIGEST,
    /** Chemins successifs essayés pour l'identifiant d'événement. */
    eventIdFields: Object.freeze([...(options.eventIdFields ?? [])]),
    /** Chemins successifs essayés pour le type d'événement. */
    eventTypeFields: Object.freeze([...(options.eventTypeFields ?? [])]),
    /**
     * Événements SOUSCRITS par le plan de contrôle.
     *
     * C'est une surface d'ABONNEMENT, pas un aiguillage métier : L5 souscrit,
     * journalise et déduplique. Le routage vers une capacité projet appartient
     * à L6/L7/L8, et rien ici ne le pré-empte.
     */
    desiredEvents: Object.freeze([...(options.desiredEvents ?? [])]),
    /**
     * Plafond d'endpoints documenté par le fournisseur, par compte.
     * `null` = non documenté publiquement. Consommé par le préflight (§L).
     */
    remoteEndpointLimit: options.remoteEndpointLimit ?? null,
    /**
     * Comparateur d'événements PROPRE AU FOURNISSEUR.
     *
     * Brevo re-collapse certains libellés (`sent` → `request`) : une
     * comparaison naïve verrait un événement éternellement « manquant » et
     * repousserait un `update` à chaque passage. Le comparateur est donc une
     * CAPACITÉ, pas un `if (provider === 'BREVO')` planté dans le moteur.
     */
    compareEvents: options.compareEvents ?? defaultCompareEvents,
    /**
     * Clé d'idempotence composite, quand le fournisseur n'offre pas
     * d'identifiant d'événement. Rend `null` si le corps ne permet pas de la
     * composer — l'appelant retombe alors sur l'empreinte du corps brut.
     */
    eventIdentity: options.eventIdentity ?? null,
    /**
     * Réponses d'erreur qui signifient en réalité « liste vide ».
     * Sans elles, la PREMIÈRE configuration serait impossible : le moteur
     * croirait le fournisseur cassé et n'oserait rien créer.
     */
    emptyListSignals: Object.freeze([...(options.emptyListSignals ?? [])]),
    /** Pourquoi ce fournisseur n'a pas de webhook — affiché tel quel. */
    unsupportedReason: options.unsupportedReason ?? null,
  });
}

/**
 * Événements STRIPE souscrits par le plan de contrôle.
 *
 * Repris du registre code-first de SB Auto (`stripeEventRegistry.js`) : ce sont
 * les événements dont un projet du parc a réellement besoin. Les souscrire ici
 * ne déplace AUCUN traitement — l'endpoint Panel les reçoit, les déduplique et
 * les journalise ; SB Auto continue de recevoir les siens sur son propre
 * endpoint pendant toute la coexistence (roadmap L5, « Migration »).
 */
const STRIPE_EVENTS = Object.freeze([
  'checkout.session.completed',
  'checkout.session.async_payment_succeeded',
  'checkout.session.async_payment_failed',
  'checkout.session.expired',
  'payment_intent.succeeded',
  'payment_intent.payment_failed',
  'charge.refunded',
  'invoice.finalized',
  'invoice.paid',
  'invoice.payment_failed',
  'customer.subscription.created',
  'customer.subscription.updated',
  'customer.subscription.deleted',
]);

const YOUSIGN_EVENTS = Object.freeze([
  'signer.done',
  'signature_request.done',
  'signature_request.declined',
  'signature_request.expired',
  'signature_request.canceled',
]);

/**
 * IDENTITÉ D'UN ÉVÉNEMENT BREVO — clé composite publiée par L8.
 *
 * Brevo ne fournit aucun identifiant d'événement. L8 a établi la clé qui le
 * remplace : environnement + `message-id` + événement canonique + date +
 * empreinte du destinataire. Elle survit à une re-sérialisation par le
 * fournisseur, là où l'empreinte du corps brut, elle, changerait.
 *
 * Le destinataire n'est JAMAIS conservé en clair : seule son empreinte entre
 * dans la clé, et la clé elle-même ne permet pas de le retrouver.
 */
function brevoEventIdentity(payload, { environment }) {
  /**
   * LE `message-id` EST NORMALISÉ, ET C'EST INDISPENSABLE.
   *
   * Brevo livre le même identifiant tantôt `<abc@bar>`, tantôt `abc@bar`
   * (exigence nº11 de l'audit L8). Composer la clé sur la graphie BRUTE ferait
   * qu'un rejeu écrit autrement produirait une clé différente — donc un
   * événement « neuf », donc l'effet appliqué deux fois. Toute l'idempotence
   * tombe sur ce détail de format.
   */
  const messageId = normalizeProviderMessageId(payload?.['message-id'] ?? payload?.messageId ?? '');
  const { canonical } = normalizeBrevoEvent(payload?.event ?? '');
  const recipient = payload?.email ?? payload?.to ?? '';
  if (!messageId && !canonical) return null;
  return `brevo:${buildBrevoEventIdentity({
    environment,
    providerMessageId: messageId,
    canonicalEvent: canonical,
    occurredAt: parseBrevoEventDate(payload),
    recipientHash: recipient
      ? createHash('sha256').update(String(recipient).trim().toLowerCase()).digest('hex').slice(0, 16)
      : '',
  })}`;
}

export const WEBHOOK_CAPABILITIES = Object.freeze({
  STRIPE: capability('STRIPE', {
    supported: true,
    callbackSlug: 'stripe',
    signatureScheme: SIGNATURE_SCHEMES.HMAC_SHA256_STRIPE,
    signatureHeader: 'stripe-signature',
    secretDelivery: SECRET_DELIVERY.AT_CREATION_ONLY,
    secretRole: 'webhookSecret',
    apiCredentialRole: 'secretKey',
    // `livemode` distingue les deux mondes SUR L'OBJET, mais les endpoints sont
    // cloisonnés par la clé (`sk_test_` / `sk_live_`) : un endpoint TEST est
    // invisible depuis une clé PROD. Deux comptes logiques, donc.
    environmentAware: false,
    eventIdStrategy: EVENT_ID_STRATEGIES.PROVIDER_FIELD,
    eventIdFields: ['id'],
    eventTypeFields: ['type'],
    desiredEvents: STRIPE_EVENTS,
    // Plafond DOCUMENTÉ (roadmap §8.2). C'est l'argument de la centralisation :
    // un endpoint Panel par environnement, quel que soit le nombre de projets.
    remoteEndpointLimit: 16,
  }),

  /**
   * BREVO — descripteur DÉRIVÉ de `brevoEventMapping.js` (lot L8).
   *
   * Aucune de ces valeurs n'est retapée à la main : la liste d'événements, le
   * schéma d'authentification, l'absence de plafond, le piège de la liste vide
   * viennent du module que le lot Brevo a publié pour ce lot-ci. Deux vérités
   * pour un même fournisseur finiraient par diverger, et c'est le webhook qui
   * en paierait le prix.
   */
  BREVO: capability('BREVO', {
    supported: true,
    callbackSlug: 'brevo',
    // Brevo ne signe RIEN (roadmap §8.2, note 2). Le jeton partagé authentifie
    // le porteur, il ne prouve pas le corps. Le dire ici évite qu'un écran
    // affiche « signature vérifiée » pour une garantie qui n'existe pas.
    signatureScheme: SIGNATURE_SCHEMES[BREVO_WEBHOOK_FACTS.signatureScheme],
    signatureHeader: 'authorization',
    secretDelivery: SECRET_DELIVERY[BREVO_WEBHOOK_FACTS.secretDelivery],
    secretRole: 'webhookSecret',
    apiCredentialRole: 'apiKey',
    environmentAware: BREVO_WEBHOOK_FACTS.environmentAware,
    eventIdStrategy: EVENT_ID_STRATEGIES.PROVIDER_COMPOSITE,
    eventIdentity: brevoEventIdentity,
    eventTypeFields: ['event'],
    desiredEvents: BREVO_SUBSCRIBED_EVENTS,
    // Une inclusion CANONIQUE : `sent` revient collapsé en `request`, et une
    // comparaison littérale boucherait le réconciliateur pour toujours.
    compareEvents: (remote, desired) => {
      const { aligned, missing } = compareSubscribedEvents(remote, desired);
      return { aligned, missing };
    },
    emptyListSignals: BREVO_WEBHOOK_FACTS.emptyListSignals,
    remoteEndpointLimit: BREVO_WEBHOOK_FACTS.remoteEndpointLimit,
    // La fenêtre vient de l'audit L8, pas d'une valeur choisie ici.
    secretRotationWindowMs: BREVO_WEBHOOK_FACTS.rotationWindowMs,
  }),

  YOUSIGN: capability('YOUSIGN', {
    supported: true,
    callbackSlug: 'yousign',
    signatureScheme: SIGNATURE_SCHEMES.HMAC_SHA256_BODY,
    signatureHeader: 'x-yousign-signature',
    secretDelivery: SECRET_DELIVERY.AT_CREATION_ONLY,
    secretRole: 'webhookSecret',
    apiCredentialRole: 'apiKey',
    // Le drapeau `sandbox` existe sur la SOUSCRIPTION, mais les hôtes d'API et
    // les clés sont distincts : la séparation reste imposée par le fournisseur.
    environmentAware: true,
    eventIdStrategy: EVENT_ID_STRATEGIES.PROVIDER_FIELD,
    eventIdFields: ['event_id', 'id'],
    eventTypeFields: ['event_name', 'event'],
    desiredEvents: YOUSIGN_EVENTS,
    remoteEndpointLimit: null,
  }),

  HOSTINGER: capability('HOSTINGER', {
    supported: false,
    unsupportedReason:
      'Hostinger n’expose aucun webhook (audit §8.2). Aucun endpoint n’est '
      + 'créé, aucun binding n’est écrit : un binding vide se lirait comme un '
      + 'webhook en panne.',
  }),
});

/* -------------------------------------------------------------------------- */
/*  ALIGNEMENT AVEC L'AUTORITÉ                                                */
/* -------------------------------------------------------------------------- */

/**
 * LE REGISTRE FOURNISSEUR A LE DERNIER MOT.
 *
 * Trois dérives possibles, trois refus :
 *  1. un descripteur pour un fournisseur inconnu du registre ;
 *  2. un fournisseur du registre sans descripteur (l'oubli silencieux) ;
 *  3. un descripteur qui contredit `supportsWebhookReconciliation` ou
 *     `webhookSecretReturnedAtCreationOnly`.
 *
 * Vérifié à l'IMPORT : une contradiction arrête le processus au démarrage,
 * là où elle est lisible, plutôt qu'à la première réconciliation.
 */
export function assertRegistryAlignment() {
  const problems = [];

  for (const code of Object.keys(WEBHOOK_CAPABILITIES)) {
    if (!getProviderDefinition(code)) {
      problems.push(`« ${code} » n’existe pas dans providerRegistry.js.`);
    }
  }

  for (const definition of listProviderDefinitions()) {
    const cap = WEBHOOK_CAPABILITIES[definition.code];
    if (!cap) {
      problems.push(`« ${definition.code} » n’a aucun descripteur webhook (même « supported: false » manque).`);
      continue;
    }
    if (cap.supported !== Boolean(definition.supportsWebhookReconciliation)) {
      problems.push(
        `« ${definition.code} » : le registre dit supportsWebhookReconciliation=`
        + `${Boolean(definition.supportsWebhookReconciliation)}, le descripteur dit supported=${cap.supported}.`,
      );
    }
    if (!cap.supported) continue;

    const atCreationOnly = cap.secretDelivery === SECRET_DELIVERY.AT_CREATION_ONLY;
    if (atCreationOnly !== Boolean(definition.webhookSecretReturnedAtCreationOnly)) {
      problems.push(
        `« ${definition.code} » : le registre dit webhookSecretReturnedAtCreationOnly=`
        + `${Boolean(definition.webhookSecretReturnedAtCreationOnly)}, le descripteur dit ${cap.secretDelivery}.`,
      );
    }
    for (const [label, roleCode] of [
      ['secretRole', cap.secretRole],
      // Sans ce rôle, la rotation devient impossible SANS PERTE : les
      // événements en vol au moment du changement repartiraient en 401.
      ['secretPreviousRole', cap.secretPreviousRole],
      ['apiCredentialRole', cap.apiCredentialRole],
    ]) {
      if (!roleCode) {
        problems.push(`« ${definition.code} » : ${label} est requis pour un fournisseur supporté.`);
      } else if (!credentialRole(definition.code, roleCode)) {
        problems.push(`« ${definition.code} » : ${label}=« ${roleCode} » n’est pas un rôle du registre.`);
      }
    }
    if (cap.desiredEvents.length === 0) {
      problems.push(`« ${definition.code} » : aucun événement souscrit — un endpoint sans événement ne reçoit rien.`);
    }
  }

  const slugs = Object.values(WEBHOOK_CAPABILITIES).filter((c) => c.supported).map((c) => c.callbackSlug);
  if (new Set(slugs).size !== slugs.length) {
    problems.push('Deux fournisseurs partagent le même segment de callback : le provider deviendrait ambigu.');
  }

  if (problems.length) {
    throw new Error(
      'Registre webhook incohérent avec providerRegistry.js :\n  - ' + problems.join('\n  - '),
    );
  }
  return true;
}

// L'invariant se vérifie à l'import, pas à l'usage.
assertRegistryAlignment();

/* -------------------------------------------------------------------------- */
/*  ACCÈS                                                                     */
/* -------------------------------------------------------------------------- */

/** Descripteur d'un fournisseur, ou `null` s'il est inconnu du registre. */
export function webhookCapability(code) {
  if (typeof code !== 'string') return null;
  return WEBHOOK_CAPABILITIES[code.toUpperCase()] ?? null;
}

/** Tous les descripteurs, dans l'ordre STABLE du registre fournisseur. */
export function listWebhookCapabilities() {
  return listProviderDefinitions().map((d) => WEBHOOK_CAPABILITIES[d.code]);
}

/** Ceux qui gèrent réellement un webhook — ce que le réconciliateur parcourt. */
export function listManagedWebhookCapabilities() {
  return listWebhookCapabilities().filter((c) => c.supported);
}

export function isWebhookSupported(code) {
  return Boolean(webhookCapability(code)?.supported);
}

/**
 * Fournisseur DÉSIGNÉ par un segment de callback.
 *
 * Le provider doit être déterminable SANS AMBIGUÏTÉ depuis l'URL : c'est ce qui
 * permet de choisir le schéma de signature avant même d'avoir lu le corps.
 * Un segment inconnu rend `null` — l'endpoint répondra 404, jamais un « au
 * pif, disons Stripe ».
 */
export function capabilityByCallbackSlug(slug) {
  const wanted = String(slug ?? '').toLowerCase();
  if (!wanted) return null;
  return listManagedWebhookCapabilities().find((c) => c.callbackSlug === wanted) ?? null;
}

/* -------------------------------------------------------------------------- */
/*  PREUVE D'APPARTENANCE                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Préfixe de description CANONIQUE d'un endpoint posé par un Panel.
 *
 * Il déclare l'intention (« un Panel gère ceci »), il ne prouve RIEN : un autre
 * Panel — recette, instance d'un autre client, ancienne installation — écrirait
 * exactement le même préfixe. C'est le jeton d'appartenance qui prouve, pas la
 * phrase (`ownershipToken`, cf. `webhookOwnership.js`).
 */
export function ownershipPrefix(provider, environment) {
  return `PANEL_CONTROL_PLANE_${String(provider).toUpperCase()}_${String(environment).toUpperCase()}`;
}

/** Description complète posée chez le fournisseur : préfixe + jeton. */
export function ownershipDescription(provider, environment, ownershipToken) {
  const prefix = ownershipPrefix(provider, environment);
  return ownershipToken ? `${prefix}#${ownershipToken}` : prefix;
}

/** Les environnements pour lesquels un webhook peut exister. */
export function webhookEnvironments() {
  return [...ENVIRONMENTS];
}

export default {
  SIGNATURE_SCHEMES,
  SECRET_DELIVERY,
  EVENT_ID_STRATEGIES,
  WEBHOOK_CAPABILITIES,
  assertRegistryAlignment,
  webhookCapability,
  listWebhookCapabilities,
  listManagedWebhookCapabilities,
  isWebhookSupported,
  capabilityByCallbackSlug,
  ownershipPrefix,
  ownershipDescription,
  webhookEnvironments,
};
