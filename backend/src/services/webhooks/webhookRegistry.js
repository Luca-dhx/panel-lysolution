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
  /**
   * LE SECRET NE PASSE PAS PAR L'API — il naît dans la console du fournisseur
   * et n'en sort que par un copier-coller humain (OpenSign).
   *
   * ══ POURQUOI CETTE QUATRIÈME VALEUR EXISTE ═════════════════════════════════
   *
   * Les trois précédentes décrivent toutes un secret que le PLAN DE CONTRÔLE
   * peut obtenir seul : au vol à la création, en le posant lui-même, ou en le
   * relisant. Elles pilotent donc une RÉPARATION AUTOMATIQUE — et c'est là que
   * le rangement approximatif coûte cher :
   *
   *   rangé en AT_CREATION_ONLY  → le réconciliateur RECRÉE l'endpoint pour
   *                                capturer un secret qui n'arrivera jamais.
   *                                Boucle infinie de recréation, sur une
   *                                ressource qui, chez OpenSign, est unique par
   *                                compte : chaque passage écrase l'URL en
   *                                place.
   *   rangé en CALLER_SUPPLIED   → il tente une rotation par une route qui
   *                                n'existe pas.
   *   rangé en NONE              → l'écran affiche « aucune vérification
   *                                possible » alors qu'OpenSign signe
   *                                réellement en HMAC-SHA256.
   *
   * `OUT_OF_BAND` dit la seule chose vraie : la vérification EXISTE, le secret
   * est ABSENT tant qu'un humain ne l'a pas saisi, et aucune réparation
   * automatique n'est possible. Le réconciliateur laisse alors le binding en
   * WARNING avec le motif exact — un état stable, lisible, et actionnable en
   * une minute par l'exploitant.
   */
  OUT_OF_BAND: 'OUT_OF_BAND',
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
    /**
     * LE FOURNISSEUR SAIT-IL STOCKER UNE DESCRIPTION D'ENDPOINT ?
     *
     * ══ CE QUE CE DRAPEAU EXISTE POUR EMPÊCHER ════════════════════════════
     *
     * La description n'est pas décorative : elle porte le JETON
     * D'APPARTENANCE, c'est-à-dire la preuve qui autorise une suppression.
     * `computeDrift` la compare donc, et un écart déclenche un `update`.
     *
     * Chez un fournisseur qui n'a pas ce champ — OpenSign — la comparaison
     * oppose une description désirée non vide à une description observée
     * toujours vide. La divergence est PERPÉTUELLE : le réconciliateur
     * réécrirait l'unique URL du compte à chaque passage, sans jamais
     * converger, et le binding resterait éternellement en DRIFTED.
     *
     * `false` dit la seule chose vraie : ce champ n'existe pas chez ce
     * fournisseur, il n'y a donc rien à comparer — et l'appartenance ne repose
     * plus que sur l'identifiant persisté, ce qui est déclaré et non subi.
     */
    supportsDescription: supported ? options.supportsDescription !== false : false,
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

/*
 * `YOUSIGN_EVENTS` A ÉTÉ RETIRÉ.
 *
 * Cette liste était la SOUSCRIPTION demandée à l'ancien fournisseur. Son
 * descripteur ne demande plus rien : la garder aurait laissé croire qu'une
 * souscription existe quelque part, et le prochain lecteur aurait cherché où.
 *
 * Le vocabulaire lui-même n'est pas perdu : la TRADUCTION de ces événements
 * vers les faits métier vit dans `signatureEventDispatch.js`, où elle sert
 * encore à relire un événement reçu autrefois.
 */

/**
 * ÉVÉNEMENTS OPENSIGN — les cinq que le fournisseur émet, et il les émet TOUS.
 *
 * Ce n'est pas une souscription : OpenSign n'offre aucun moyen d'en choisir un
 * sous-ensemble. Cette liste DÉCRIT donc ce qui arrivera sur l'endpoint, et
 * sert au diagnostic ; elle ne demande rien au fournisseur.
 *
 * Noter l'absence de `revoked` : la documentation d'aide l'annonce dans sa
 * liste (« Document Revoked or Declined ») mais ne publie AUCUN exemple de
 * charge utile pour lui, et la référence API ne documente que cinq événements,
 * `declined` compris. Deux hypothèses tiennent — la révocation émet `declined`,
 * ou elle émet un `revoked` non documenté — et rien dans la doc ne tranche.
 * On ne l'invente donc pas ici : c'est une observation à faire en bac à sable,
 * pas une déclaration à écrire de mémoire. Le mapping métier, lui, saura
 * traiter les deux libellés.
 */
const OPENSIGN_EVENTS = Object.freeze([
  'created',
  'viewed',
  'signed',
  'completed',
  'declined',
]);

/**
 * IDENTITÉ D'UN ÉVÉNEMENT OPENSIGN — composite, faute d'identifiant.
 *
 * ══ CE QUI ENTRE DANS LA CLÉ, ET POURQUOI CHAQUE MORCEAU EST NÉCESSAIRE ═════
 *
 *   environnement  deux mondes, deux comptes : rien n'interdit au même
 *                  `objectId` d'exister des deux côtés.
 *   event          `viewed` puis `signed` sur le même document au même instant
 *                  sont deux faits distincts.
 *   objectId       le document. C'est la seule référence stable du fournisseur.
 *   acteur         l'e-mail du signataire concerné, HACHÉ. Sans lui, deux
 *                  signataires qui signent dans la même seconde produisent la
 *                  même clé, et le second est perdu en silence — c'est-à-dire
 *                  que le contrat reste éternellement à moitié signé.
 *   horodatage     le champ propre à l'événement (`signedAt`, `viewedAt`…).
 *
 * ── POURQUOI L'HORODATAGE N'EST PAS PARSÉ ───────────────────────────────────
 *
 * OpenSign date ses événements en RFC 1123 avec un fuseau EN TOUTES LETTRES
 * (« Fri, 16 May 2025 16:18:16 IST », « GMT+9:30 »). `Date.parse` rend `NaN`
 * sur la plupart de ces abréviations, et selon le moteur. Une clé bâtie sur un
 * horodatage parsé serait donc tantôt correcte, tantôt `NaN` — et deux
 * événements distincts partageraient alors la même identité.
 *
 * On garde la CHAÎNE, normalisée. Elle est stable pour un événement donné :
 * c'est tout ce que l'idempotence demande.
 *
 * ── AUCUNE ADRESSE N'ENTRE EN CLAIR ─────────────────────────────────────────
 *
 * Même règle que chez Brevo : la clé ne doit pas devenir un annuaire. Elle
 * porte une empreinte tronquée, qui distingue sans permettre de retrouver.
 */
export function openSignEventIdentity(payload, { environment }) {
  const event = String(payload?.event ?? '').trim().toLowerCase();
  const objectId = String(payload?.objectId ?? '').trim();
  if (!event || !objectId) return null;

  const acteur = payload?.viewedBy
    ?? payload?.declinedBy
    ?? payload?.signer?.email
    ?? '';
  const horodatage = payload?.signedAt
    ?? payload?.viewedAt
    ?? payload?.declinedAt
    ?? payload?.completedAt
    ?? payload?.createdAt
    ?? '';

  const empreinte = acteur
    ? createHash('sha256').update(String(acteur).trim().toLowerCase()).digest('hex').slice(0, 16)
    : '';

  return `opensign:${[
    String(environment ?? '').toUpperCase(),
    event,
    objectId,
    empreinte,
    String(horodatage).trim().toLowerCase(),
  ].join(':')}`;
}

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

  /**
   * YOUSIGN — RETIRÉ. Plus de webhook, et plus de secret pour en vérifier un.
   *
   * ══ CE QU'IL Y AVAIT ICI, ET POURQUOI IL N'Y EST PLUS ════════════════
   *
   * Un descripteur complet : schéma de signature, en-tête, rôles de secret,
   * cinq événements souscrits. Il décrivait un endpoint à réconcilier.
   *
   * Il n'y a plus rien à réconcilier : les rôles de credential ont disparu du
   * registre avec le fournisseur, donc le secret aussi — et un descripteur qui
   * annonce `HMAC_SHA256_BODY` sans secret pour le vérifier décrit une garde
   * qui n'existe plus. Le contrôle de cohérence entre les deux registres l'a
   * dit immédiatement, et il avait raison.
   *
   * ══ MESURÉ AVANT DE RETIRER ══════════════════════════════════
   *
   * Sur les deux bases, la liaison portait `remoteWebhookId: null` : AUCUN
   * endpoint n'a jamais été créé chez ce fournisseur — son bac à sable refuse
   * la création par API, et la production n'a jamais eu de clé. Il n'y a donc
   * rien à débrancher de son côté, et le retrait est entièrement local.
   *
   * `supported: false` reste un état de PREMIÈRE CLASSE : il dit « pas de
   * webhook ici » là où une absence d'entrée dirait « fournisseur inconnu ».
   */
  YOUSIGN: capability('YOUSIGN', {
    supported: false,
    unsupportedReason:
      'Fournisseur retiré (2026-08). Aucun endpoint n’a jamais été enregistré '
      + 'chez lui, et il n’a plus de secret : il n’y a rien à réconcilier ni à '
      + 'vérifier. Les événements de signature arrivent désormais du fournisseur '
      + 'actif.',
  }),

  /**
   * OPENSIGN — un webhook UNIQUE par compte, signé, sans abonnement.
   *
   * ══ TROIS DIFFÉRENCES STRUCTURELLES, ET AUCUNE N'EST COSMÉTIQUE ═══════════
   *
   * 1. LA RESSOURCE EST UN SINGLETON. `GET/POST/DELETE /webhook` — pas de
   *    liste, pas d'identifiant d'endpoint. L'identité de l'endpoint EST le
   *    jeton qui l'interroge. Le pilote distant rend donc un identifiant
   *    SYNTHÉTIQUE et STABLE, parce que le réconciliateur en a besoin d'un pour
   *    raisonner — et non parce qu'OpenSign en aurait un qu'on aurait manqué.
   *
   * 2. AUCUN ABONNEMENT À DES ÉVÉNEMENTS. OpenSign envoie ses cinq événements,
   *    ou aucun. `desiredEvents` est donc une DOCUMENTATION de ce qu'on va
   *    recevoir, pas une intention à faire respecter — d'où un comparateur qui
   *    ne signale jamais de dérive d'événements. Le comparateur par défaut
   *    verrait cinq événements éternellement « manquants » et déclencherait un
   *    `update` à chaque passage, c'est-à-dire une réécriture perpétuelle de
   *    l'unique URL du compte.
   *
   * 3. LE SECRET NE VIENT PAS DE L'API. Voir `SECRET_DELIVERY.OUT_OF_BAND`.
   *
   * ══ ET UNE QUATRIÈME, QUI EST UNE CONTRAINTE D'EXPLOITATION ══════════════
   *
   * Un compte = une URL. Deux Panels (recette et production) NE PEUVENT PAS
   * partager un compte OpenSign : le second écraserait le webhook du premier.
   * La séparation TEST/PROD par jeton et par hôte n'est donc pas seulement
   * imposée par le fournisseur — elle est la seule chose qui rende la
   * cohabitation possible. `remoteEndpointLimit: 1` fait dire cela au préflight
   * plutôt qu'à un incident.
   */
  OPENSIGN: capability('OPENSIGN', {
    supported: true,
    callbackSlug: 'opensign',
    /** HMAC-SHA256 hexadécimal du corps BRUT — exactement le schéma générique. */
    signatureScheme: SIGNATURE_SCHEMES.HMAC_SHA256_BODY,
    signatureHeader: 'x-webhook-signature',
    secretDelivery: SECRET_DELIVERY.OUT_OF_BAND,
    secretRole: 'webhookSecret',
    secretPreviousRole: 'webhookSecretPrevious',
    apiCredentialRole: 'apiToken',
    /**
     * Deux mondes, deux comptes : le jeton Sandbox et le jeton Live ne se
     * voient pas, et chacun porte SA propre URL de webhook. Le fournisseur ne
     * distingue donc rien lui-même sur un compte donné — c'est la séparation
     * des comptes qui fait le travail, comme chez Yousign.
     */
    environmentAware: true,
    /**
     * AUCUN IDENTIFIANT D'ÉVÉNEMENT dans la charge utile — vérifié sur les cinq
     * exemples officiels. Sans clé composite, l'idempotence retomberait sur
     * l'empreinte du corps brut, et deux événements légitimes strictement
     * identiques (même document, même signataire, même horodatage à la seconde)
     * seraient confondus — ou, pire, une re-sérialisation par le fournisseur
     * ferait passer un rejeu pour une nouveauté.
     */
    eventIdStrategy: EVENT_ID_STRATEGIES.PROVIDER_COMPOSITE,
    eventIdentity: openSignEventIdentity,
    eventTypeFields: ['event'],
    desiredEvents: OPENSIGN_EVENTS,
    /**
     * Il n'y a rien à souscrire : toute liste observée est conforme par
     * construction. Répondre `aligned: true` n'est pas une complaisance, c'est
     * le constat exact — la seule dérive possible chez OpenSign est celle de
     * l'URL, et `computeDrift` la voit sans nous.
     */
    compareEvents: () => ({ aligned: true, missing: [] }),
    /** Aucun champ de description chez OpenSign — voir `capability()`. */
    supportsDescription: false,
    /** Une seule URL par compte. Documenté, et vérifié par le préflight. */
    remoteEndpointLimit: 1,
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
