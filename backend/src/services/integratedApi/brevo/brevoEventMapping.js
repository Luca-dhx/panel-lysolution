// ÉVÉNEMENTS BREVO — la table de correspondance, et rien d'autre (L8).
//
// docs/architecture/BREVO_CONTROL_PLANE.md §« Webhooks ».
//
// ── CE FICHIER NE RÉCONCILIE RIEN ───────────────────────────────────────────
//
// Le registre de webhooks, le réconciliateur, le modèle de liaison, les
// endpoints publics et l'idempotence générique appartiennent à L5
// (`services/webhooks/`). Ce module est la CONNAISSANCE BREVO dont L5 a besoin :
// quel vocabulaire souscrire, comment le comparer, et ce que chaque événement
// signifie. Il est importable par L5 ; il n'importe rien de L5.
//
// ── DEUX VOCABULAIRES POUR LE MÊME ÉVÉNEMENT ────────────────────────────────
//
// C'est la première source de bugs de ce fournisseur :
//
//   CONFIG-TIME  (camelCase)  ce qu'on ENVOIE à `POST /v3/webhooks`
//                             → `hardBounce`, `uniqueOpened`, `click`
//   PAYLOAD-TIME (snake_case) ce qu'on REÇOIT dans le champ `event`
//                             → `hard_bounce`, `unique_opened`, `invalid_email`
//
// Comparer les deux littéralement produit une divergence permanente. Tout
// passe donc par une forme canonique.
//
// ── PROVENANCE ──────────────────────────────────────────────────────────────
//
// Ce n'est pas de la doctrine : c'est le fruit d'un diagnostic mené contre
// l'API réelle côté projet (SB Auto, `utils/brevoTransactionalEventRegistry.js`,
// 2026-07-19), qui a coûté plusieurs jours et dont les deux écarts avec la
// documentation officielle sont notés ci-dessous. Les reperdre coûterait autant.

/* -------------------------------------------------------------------------- */
/*  FORME CANONIQUE                                                           */
/* -------------------------------------------------------------------------- */

/** Types normalisés — la SEULE forme que le reste du plan de contrôle manipule. */
export const BREVO_EVENT_TYPES = Object.freeze({
  /** `request` : Brevo a accepté la demande d'envoi. Pas une livraison. */
  ACCEPTED: 'ACCEPTED',
  DELIVERED: 'DELIVERED',
  DEFERRED: 'DEFERRED',
  SOFT_BOUNCE: 'SOFT_BOUNCE',
  HARD_BOUNCE: 'HARD_BOUNCE',
  BLOCKED: 'BLOCKED',
  SPAM: 'SPAM',
  INVALID: 'INVALID',
  ERROR: 'ERROR',
  UNSUBSCRIBED: 'UNSUBSCRIBED',
  OPENED: 'OPENED',
  UNIQUE_OPENED: 'UNIQUE_OPENED',
  /** Ouverture par un proxy de confidentialité (Apple MPP) : pas une lecture. */
  PROXY_OPEN: 'PROXY_OPEN',
  UNIQUE_PROXY_OPEN: 'UNIQUE_PROXY_OPEN',
  CLICKED: 'CLICKED',
});

/**
 * Correspondance vers le vocabulaire NORMALISÉ du plan de contrôle (roadmap
 * §8.6). Au-delà de la passerelle, plus aucun code ne connaît le mot
 * « hardBounce » — c'est ce qui rend un changement de fournisseur possible.
 *
 * Seuls DEUX événements portent une conséquence métier. Les autres alimentent
 * un suivi de délivrabilité : les projeter tous sur des événements métier
 * inventerait des faits que personne n'attend.
 */
export const CONTROL_PLANE_EVENTS = Object.freeze({
  [BREVO_EVENT_TYPES.DELIVERED]: 'EMAIL_DELIVERED',
  [BREVO_EVENT_TYPES.HARD_BOUNCE]: 'EMAIL_BOUNCED',
  [BREVO_EVENT_TYPES.SOFT_BOUNCE]: 'EMAIL_BOUNCED',
  [BREVO_EVENT_TYPES.BLOCKED]: 'EMAIL_BOUNCED',
  [BREVO_EVENT_TYPES.INVALID]: 'EMAIL_BOUNCED',
  [BREVO_EVENT_TYPES.SPAM]: 'EMAIL_BOUNCED',
});

/**
 * Événements d'ENGAGEMENT : historisés, jamais promus en changement d'état.
 * Une ouverture n'est pas une preuve de lecture, un clic pas une preuve
 * d'intention — et un pixel bloqué par le client de messagerie ne prouve rien
 * du tout.
 */
export const ENGAGEMENT_EVENTS = Object.freeze([
  BREVO_EVENT_TYPES.OPENED,
  BREVO_EVENT_TYPES.UNIQUE_OPENED,
  BREVO_EVENT_TYPES.PROXY_OPEN,
  BREVO_EVENT_TYPES.UNIQUE_PROXY_OPEN,
  BREVO_EVENT_TYPES.CLICKED,
]);

/**
 * Table brut → canonique. La CLÉ est réduite (minuscule, sans séparateur) pour
 * absorber d'un coup les deux vocabulaires ET les variations de casse, sans
 * pour autant accepter n'importe quoi : seule une clé listée est reconnue.
 */
const RAW_TO_CANONICAL = Object.freeze({
  request: BREVO_EVENT_TYPES.ACCEPTED,
  /** `sent` n'est jamais RENVOYÉ tel quel (voir SUBSCRIBED_EVENTS) — reconnu par prudence. */
  sent: BREVO_EVENT_TYPES.ACCEPTED,
  delivered: BREVO_EVENT_TYPES.DELIVERED,
  deferred: BREVO_EVENT_TYPES.DEFERRED,
  softbounce: BREVO_EVENT_TYPES.SOFT_BOUNCE,
  hardbounce: BREVO_EVENT_TYPES.HARD_BOUNCE,
  blocked: BREVO_EVENT_TYPES.BLOCKED,
  spam: BREVO_EVENT_TYPES.SPAM,
  invalid: BREVO_EVENT_TYPES.INVALID,
  invalidemail: BREVO_EVENT_TYPES.INVALID,
  error: BREVO_EVENT_TYPES.ERROR,
  unsubscribed: BREVO_EVENT_TYPES.UNSUBSCRIBED,
  opened: BREVO_EVENT_TYPES.OPENED,
  uniqueopened: BREVO_EVENT_TYPES.UNIQUE_OPENED,
  proxyopen: BREVO_EVENT_TYPES.PROXY_OPEN,
  uniqueproxyopen: BREVO_EVENT_TYPES.UNIQUE_PROXY_OPEN,
  click: BREVO_EVENT_TYPES.CLICKED,
  clicks: BREVO_EVENT_TYPES.CLICKED,
});

/** Réduit une valeur brute à sa clé de comparaison. */
function comparisonKey(raw) {
  return String(raw ?? '').trim().toLowerCase().replace(/[-_\s]/g, '');
}

/**
 * Normalise une valeur d'événement Brevo, config-time OU payload-time.
 * @returns {{known: boolean, canonical: string|null, raw: string}}
 */
export function normalizeBrevoEvent(raw) {
  const text = String(raw ?? '');
  const canonical = RAW_TO_CANONICAL[comparisonKey(text)] ?? null;
  return { known: canonical !== null, canonical, raw: text };
}

/** Un événement d'engagement ne change jamais l'état d'une livraison. */
export function isEngagementEvent(canonical) {
  return ENGAGEMENT_EVENTS.includes(canonical);
}

/** L'événement métier normalisé du plan de contrôle, ou `null` (§8.6). */
export function toControlPlaneEvent(canonical) {
  return CONTROL_PLANE_EVENTS[canonical] ?? null;
}

/* -------------------------------------------------------------------------- */
/*  SOUSCRIPTION                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Ce qu'il faut souscrire à la création du webhook (`events`, camelCase).
 *
 * ── POURQUOI `sent` EST ABSENT, ET DOIT LE RESTER ───────────────────────────
 *
 * Diagnostic réel contre l'API : quand on souscrit `sent`, `GET /v3/webhooks`
 * renvoie `request` À SA PLACE. La comparaison voit donc l'événement souscrit
 * éternellement « manquant », déclare une divergence, met à jour, Brevo
 * re-collapse — et la boucle « Actif → Désynchronisé » ne s'arrête jamais.
 * `request` couvre déjà l'acceptation. On ne souscrit que ce qui fait
 * l'aller-retour proprement.
 *
 * ── POURQUOI `error` EST PRÉSENT ────────────────────────────────────────────
 *
 * Il est absent de la liste documentée côté configuration, mais Brevo
 * l'accepte et le CONSERVE (constaté dans `GET /v3/webhooks`). Il livre les
 * erreurs asynchrones, qu'on perdrait sinon.
 */
export const SUBSCRIBED_EVENTS = Object.freeze([
  'request',
  'delivered',
  'deferred',
  'softBounce',
  'hardBounce',
  'blocked',
  'spam',
  'invalid',
  'error',
  'unsubscribed',
  'opened',
  'uniqueOpened',
  'click',
]);

/**
 * Événements config-time dont l'aller-retour est CONSTATÉ propre. Référence en
 * lecture seule : un événement souscrit absent d'ici reviendra sous une autre
 * forme, ou pas du tout, et produira une divergence permanente.
 */
export const ROUND_TRIP_SAFE_EVENTS = Object.freeze([
  'request', 'delivered', 'hardBounce', 'softBounce', 'blocked', 'spam',
  'invalid', 'deferred', 'click', 'opened', 'uniqueOpened', 'unsubscribed', 'error',
]);

/** Événements qu'il ne faut JAMAIS souscrire, et la raison de chacun. */
export const FORBIDDEN_SUBSCRIPTIONS = Object.freeze({
  sent: 'Brevo le renvoie collapsé en « request » : divergence permanente garantie.',
});

/* -------------------------------------------------------------------------- */
/*  COMPARAISON — ce que L5 doit appeler plutôt qu'une égalité de tableaux     */
/* -------------------------------------------------------------------------- */

function canonicalSet(events) {
  const out = new Set();
  for (const event of events ?? []) {
    const { canonical } = normalizeBrevoEvent(event);
    if (canonical) out.add(canonical);
  }
  return out;
}

/**
 * Le webhook distant écoute-t-il tout ce qu'on attend de lui ?
 *
 * ── UNE INCLUSION, PAS UNE ÉGALITÉ ──────────────────────────────────────────
 *
 * Trois propriétés voulues, et chacune corrige un faux positif observé :
 *
 *   · l'ORDRE ne compte pas ;
 *   · un événement EN PLUS chez Brevo (qu'il ajoute de lui-même) n'est PAS une
 *     divergence — c'est un sur-ensemble ;
 *   · une variation de casse ou de graphie n'est pas une différence.
 *
 * Une égalité stricte de tableaux, ou même une comparaison de tailles,
 * déclarerait « désynchronisé » un webhook parfaitement fonctionnel.
 *
 * @returns {{aligned: boolean, missing: string[], extra: string[]}}
 *   `missing` en forme CANONIQUE — c'est la seule liste actionnable.
 */
export function compareSubscribedEvents(remoteEvents, desiredEvents = SUBSCRIBED_EVENTS) {
  const remote = canonicalSet(remoteEvents);
  const desired = canonicalSet(desiredEvents);
  const missing = [...desired].filter((event) => !remote.has(event));
  const extra = [...remote].filter((event) => !desired.has(event));
  return { aligned: missing.length === 0, missing, extra };
}

/* -------------------------------------------------------------------------- */
/*  IDENTITÉ D'UN ÉVÉNEMENT                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Brevo ne fournit AUCUN identifiant d'événement stable — ni `id`, ni
 * `event_id`. L'idempotence ne peut donc pas s'appuyer sur le fournisseur.
 *
 * Une empreinte du corps brut suffit contre une REPRISE de Brevo (il renvoie
 * les mêmes octets), mais elle est fragile : un corps réordonné produirait une
 * empreinte différente pour le même fait. La clé COMPOSÉE ci-dessous est celle
 * éprouvée côté projet — elle est stable quelles que soient la sérialisation et
 * l'ordre des champs.
 *
 * Aucune adresse en clair n'y entre : le destinataire est haché par l'appelant.
 */
export const EVENT_IDENTITY = Object.freeze({
  providerSuppliesEventId: false,
  /** Champs du corps qui composent la clé, dans cet ordre. */
  compositeKeyFields: Object.freeze([
    'environment', 'providerMessageId', 'canonicalEvent', 'occurredAtMs', 'recipientHash',
  ]),
  /** Le repli si un champ manque : empreinte du corps BRUT, jamais du corps parsé. */
  fallback: 'RAW_BODY_DIGEST',
});

/**
 * Compose la clé d'idempotence d'un événement Brevo.
 *
 * Volontairement une fonction PURE : L5 en reste le seul utilisateur, décide où
 * la stocker et quel index l'impose. L8 ne crée aucun modèle d'événement.
 */
export function buildEventIdentity({ environment, providerMessageId, canonicalEvent, occurredAt, recipientHash }) {
  const occurredAtMs =
    occurredAt instanceof Date && !Number.isNaN(occurredAt.getTime()) ? occurredAt.getTime() : 0;
  return [
    environment || 'no-env',
    providerMessageId || 'no-msg',
    canonicalEvent || 'no-event',
    occurredAtMs,
    recipientHash || 'no-rcpt',
  ].join('|');
}

/**
 * Date FOURNISSEUR d'un événement — Brevo emploie quatre champs selon le cas.
 *
 * `ts_epoch` est en millisecondes, `ts` et `ts_event` en secondes, `date` en
 * ISO. Multiplier des millisecondes par mille place l'événement en l'an 56000
 * et casse silencieusement tout tri chronologique.
 *
 * @returns {Date|null}
 */
export function parseEventDate(payload) {
  if (!payload || typeof payload !== 'object') return null;
  if (payload.ts_epoch != null) {
    const ms = Number(payload.ts_epoch);
    if (Number.isFinite(ms) && ms > 0) return new Date(ms);
  }
  for (const key of ['ts_event', 'ts']) {
    if (payload[key] != null) {
      const seconds = Number(payload[key]);
      if (Number.isFinite(seconds) && seconds > 0) return new Date(seconds * 1000);
    }
  }
  if (payload.date) {
    const date = new Date(payload.date);
    if (!Number.isNaN(date.getTime())) return date;
  }
  return null;
}

/* -------------------------------------------------------------------------- */
/*  CE QUE BREVO EXIGE, ET CE QU'IL N'OFFRE PAS                               */
/* -------------------------------------------------------------------------- */

/**
 * Particularités du fournisseur que le réconciliateur générique de L5 doit
 * connaître pour ne pas se tromper. Déclaratif : L5 lit, L8 n'agit pas.
 *
 * Sources : documentation officielle « Secure webhook calls »
 * (developers.brevo.com), et diagnostic réel côté projet.
 */
export const BREVO_WEBHOOK_FACTS = Object.freeze({
  /** Aucune signature cryptographique. Un appel est authentifié, jamais prouvé. */
  signatureScheme: 'SHARED_SECRET_BEARER',
  cryptographicProof: false,
  /** `auth: { type: 'bearer', token }` à la création ET à la mise à jour. */
  authBodyField: 'auth',
  /** Alternative documentée, à NE PAS utiliser : le secret finirait dans les journaux d'accès. */
  rejectedAlternatives: Object.freeze(['identifiants dans l’URL (https://user:pass@…)']),
  /** Complément recommandé par Brevo, jamais suffisant seul. */
  ipAllowlistAvailable: true,

  /** C'est NOUS qui posons le secret : la rotation ne recrée pas l'endpoint. */
  secretDelivery: 'CALLER_SUPPLIED',
  /**
   * MAIS la rotation ouvre une fenêtre : les appels déjà en vol portent encore
   * l'ancien jeton. Sans tolérance, ils sont rejetés en 401 et les événements
   * de cette fenêtre sont perdus définitivement.
   */
  rotationRequiresPreviousSecretWindow: true,
  rotationWindowMs: 15 * 60 * 1000,

  /** Filtrer, sinon les webhooks marketing/inbound passent pour des endpoints étrangers. */
  listQuery: '/webhooks?type=transactional',
  webhookTypes: Object.freeze(['transactional', 'marketing', 'inbound']),
  /**
   * Un compte SANS webhook répond 400/404 « Webhook record does not exist ».
   * Ce n'est pas une panne : c'est une liste vide. Les confondre rend la
   * PREMIÈRE configuration impossible — le réconciliateur croit le fournisseur
   * cassé et n'ose rien créer.
   */
  emptyListLooksLikeError: true,
  emptyListSignals: Object.freeze(['does not exist', 'not exist', 'not found', 'no webhook', 'document_not_found']),

  /** Aucun plafond d'endpoints documenté publiquement (contrairement à Stripe). */
  remoteEndpointLimit: null,
  /** Aucun sandbox : un compte TEST et un compte PROD sont deux comptes distincts. */
  environmentAware: false,
  /** Aucune API d'événement de test : la seule sonde possible est notre propre URL. */
  providerTestEventApi: false,
  /** Brevo réessaie ; la politique exacte n'est pas documentée. */
  providerRetries: true,
});

export default {
  BREVO_EVENT_TYPES,
  CONTROL_PLANE_EVENTS,
  ENGAGEMENT_EVENTS,
  SUBSCRIBED_EVENTS,
  ROUND_TRIP_SAFE_EVENTS,
  FORBIDDEN_SUBSCRIPTIONS,
  EVENT_IDENTITY,
  BREVO_WEBHOOK_FACTS,
  normalizeBrevoEvent,
  isEngagementEvent,
  toControlPlaneEvent,
  compareSubscribedEvents,
  buildEventIdentity,
  parseEventDate,
};
