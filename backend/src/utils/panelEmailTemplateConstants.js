// CONSTANTES DES TEMPLATES E-MAIL — l’autorité du Panel (L8.3).
//
// ══ CE FICHIER EST UN DÉPLACEMENT D'AUTORITÉ, PAS UNE COPIE ══════════════════
//
// L8 a tranché : `TEMPLATE_AUTHORITIES.PANEL`. Le contenu des e-mails vit
// désormais ICI — versionné, validé, rendu par le Panel — et le corps envoyé à
// Brevo porte `subject` + `htmlContent`, jamais un `templateId` du fournisseur
// qui ferait sortir le contenu de nos versions.
//
// Ce module vient du dépôt PROJET (`backend/src/utils/emailTemplateConstants.js`). Il n'est PAS
// dupliqué pour le plaisir : l'autorité change de côté, et le moteur suit le
// contenu qu'il rend. Le jour où l'envoi projet sera retiré (L10), l'exemplaire
// d'origine partira avec lui — c'est le sens du déplacement.
//
// Aucune règle n'a été assouplie au passage. Ce qui suit est le module éprouvé
// du projet, à l'identique sauf ses imports.

/**
 * Constantes du système de templates e-mail.
 *
 * CODE-FIRST, comme les événements : les identifiants de template et les variables
 * autorisées vivent dans le CODE. La base ne stocke que ce qu'un humain a écrit
 * (nom, description, sujet, HTML, actif) — jamais la liste de ce qui existe.
 *
 * POURQUOI : un template est appelé par du code métier qui lui passe des valeurs
 * précises. Laisser le Manager créer un identifiant produirait un template que
 * personne n'appelle ; laisser le Manager déclarer une variable produirait un
 * trou à l'exécution. Les deux erreurs sont silencieuses — donc interdites par
 * construction.
 */

/**
 * Types de variable. Le type décide de la CONVERSION et de l'ÉCHAPPEMENT.
 *
 * Tout est échappé par défaut. `SAFE_HTML` est la seule exception, et elle est
 * explicite dans le registre : une variable ne peut pas devenir du HTML par
 * accident.
 */
/**
 * CLASSE DE RÉTENTION d'un template — combien de temps sa trace mérite d'être
 * gardée. Reprise de `domainEventConstants.js` du projet, réduite aux trois
 * valeurs réellement portées par les templates : importer tout le vocabulaire
 * des événements de domaine ferait entrer ici une notion qui n'a rien à voir
 * avec le contenu d'un e-mail.
 */
export const RETENTION_CLASS = Object.freeze({
  /** Trace de conformité / sécurité. Conservation longue (≈ 3 ans). */
  AUDIT: 'AUDIT',
  /** Exploitation courante, diagnostic (≈ 12 mois). */
  OPERATIONAL: 'OPERATIONAL',
  /** Bruit technique, purge rapide (≈ 30 jours). */
  TRANSIENT: 'TRANSIENT',
});

export const VARIABLE_TYPE = Object.freeze({
  TEXT: 'TEXT',
  EMAIL: 'EMAIL',
  PHONE: 'PHONE',
  DATE: 'DATE',
  DATETIME: 'DATETIME',
  /** Entier en CENTIMES (convention money.js). Jamais un flottant. */
  MONEY: 'MONEY',
  URL: 'URL',
  BOOLEAN: 'BOOLEAN',
  /** HTML pré-validé, inséré sans échappement. À n'utiliser qu'à bon escient. */
  SAFE_HTML: 'SAFE_HTML',
});

/**
 * Codes d'erreur STABLES du système de templates. Le Manager s'appuie sur EUX,
 * jamais sur le texte d'un message.
 */
export const EMAIL_TEMPLATE_ERROR_CODES = Object.freeze({
  UNKNOWN_TEMPLATE: 'UNKNOWN_TEMPLATE',
  TEMPLATE_DISABLED: 'TEMPLATE_DISABLED',
  /** Le template persisté ne passe pas le validator : aucun rendu possible. */
  TEMPLATE_INVALID: 'TEMPLATE_INVALID',
  SUBJECT_EMPTY: 'SUBJECT_EMPTY',
  SUBJECT_TOO_LONG: 'SUBJECT_TOO_LONG',
  HTML_EMPTY: 'HTML_EMPTY',
  HTML_TOO_LONG: 'HTML_TOO_LONG',
  FORBIDDEN_TAG: 'FORBIDDEN_TAG',
  FORBIDDEN_ATTRIBUTE: 'FORBIDDEN_ATTRIBUTE',
  DANGEROUS_URL: 'DANGEROUS_URL',
  UNKNOWN_VARIABLE: 'UNKNOWN_VARIABLE',
  MISSING_REQUIRED_VARIABLE: 'MISSING_REQUIRED_VARIABLE',
  INVALID_PLACEHOLDER: 'INVALID_PLACEHOLDER',
  UNRESOLVED_PLACEHOLDER: 'UNRESOLVED_PLACEHOLDER',
  INVALID_VARIABLE_VALUE: 'INVALID_VARIABLE_VALUE',
  VERSION_CONFLICT: 'VERSION_CONFLICT',
  UNKNOWN_VERSION: 'UNKNOWN_VERSION',
});

/** Codes d'erreur STABLES de la livraison. */
export const EMAIL_DELIVERY_ERROR_CODES = Object.freeze({
  /** Brevo absent du catalogue IntegratedAPI, désactivé, ou aucun mode actif. */
  PROVIDER_NOT_CONFIGURED: 'PROVIDER_NOT_CONFIGURED',
  /** Clé API absente pour le mode actif. */
  PROVIDER_KEY_MISSING: 'PROVIDER_KEY_MISSING',
  /**
   * Clé présente mais test de connexion jamais réussi pour ce mode
   * (`IntegratedApi.modes[mode].verified`). DISTINCT de l'expéditeur vérifié :
   * l'un prouve que la CLÉ fonctionne, l'autre que la BOÎTE nous appartient.
   */
  PROVIDER_NOT_VERIFIED: 'PROVIDER_NOT_VERIFIED',
  /** Le template n'existe pas encore en base (bootstrap non exécuté). */
  TEMPLATE_NOT_FOUND: 'TEMPLATE_NOT_FOUND',
  /** Le template est désactivé : aucun envoi, jamais silencieusement. */
  TEMPLATE_DISABLED: 'TEMPLATE_DISABLED',
  /**
   * Aucune adresse expéditrice enregistrée POUR LE MODE ACTIF. Seul motif de
   * refus local côté expéditeur : la « vérification » de l'adresse s'administre
   * chez Brevo et n'est plus recopiée ici (cf. EmailReadinessService).
   */
  SENDER_NOT_CONFIGURED: 'SENDER_NOT_CONFIGURED',
  RECIPIENT_INVALID: 'RECIPIENT_INVALID',
  NO_RECIPIENT: 'NO_RECIPIENT',
  TEMPLATE_INVALID: 'TEMPLATE_INVALID',
  RENDER_FAILED: 'RENDER_FAILED',
  UNKNOWN_RESOLVER: 'UNKNOWN_RESOLVER',
  PROVIDER_ERROR: 'PROVIDER_ERROR',
  NETWORK_ERROR: 'NETWORK_ERROR',
  RATE_LIMITED: 'RATE_LIMITED',
  /**
   * Le suivi de livraison n'est pas opérationnel : l'envoi est REFUSÉ AVANT tout
   * appel au fournisseur. Rien n'a été envoyé, rien n'a été accepté. Retryable :
   * la cause est transitoire par nature (webhook à réparer, tunnel à relancer) et
   * la reprise doit être automatique dès que la joignabilité revient.
   *
   * C'est le `failureCode` porté par une livraison `PRECONDITION_FAILED`. À ne
   * pas confondre avec `BREVO_TRACKING_REQUIRED`, qui est le code de l'erreur
   * HTTP 409 rendue à un APPELANT : l'un décrit l'état d'une livraison, l'autre
   * répond à une requête.
   */
  NOT_OPERATIONAL: 'BREVO_NOT_OPERATIONAL',
});

/**
 * Statuts de livraison.
 *
 * ⚠️ `SENT` ET `DELIVERED` NE SONT PAS LA MÊME CHOSE — c'est la distinction la
 * plus importante de ce module :
 *
 *  - `SENT`      : Brevo a ACCEPTÉ l'envoi et renvoyé un `messageId`. C'est tout
 *                  ce que notre code peut constater. La boîte du destinataire
 *                  n'est PAS encore concernée.
 *  - `DELIVERED` : le serveur du destinataire a accepté le message. SEUL un
 *                  webhook Brevo peut l'affirmer, et il l'affirme : le suivi est
 *                  en place, et même OBLIGATOIRE avant tout envoi.
 *
 * Écrire « délivré » sur la foi d'un 201 serait un mensonge : un e-mail accepté
 * par Brevo peut parfaitement rebondir trente secondes plus tard.
 *
 * ─── L'INVARIANT ────────────────────────────────────────────────────────────
 *
 * DELIVERED, DEFERRED, BOUNCED, SOFT_BOUNCED, HARD_BOUNCED, INVALID, SPAM,
 * ERROR, BLOCKED et UNSUBSCRIBED constatent ce qui s'est passé CHEZ LE
 * DESTINATAIRE : seul un webhook fournisseur peut les écrire, parce que seul
 * lui l'a observé. Le code d'envoi n'écrit que PENDING, SENDING, SENT, FAILED
 * et PRECONDITION_FAILED — les cinq états dont il est le témoin direct.
 *
 * Aucun écran ne doit donc affirmer une réception sans preuve fournisseur.
 */
export const DELIVERY_STATUS = Object.freeze({
  /** Créée, pas encore tentée. */
  PENDING: 'PENDING',
  /** Appel fournisseur en cours (fenêtre de crash). */
  SENDING: 'SENDING',
  /** Brevo a accepté et renvoyé un messageId. N'implique AUCUNE réception. */
  SENT: 'SENT',
  /** Échec de l'appel d'envoi (voir `lastErrorSafe.retryable`). PAS un webhook. */
  FAILED: 'FAILED',
  /**
   * NOTRE système a refusé d'envoyer : une précondition n'était pas réunie (à ce
   * jour, suivi de livraison non opérationnel). Rien n'a été tenté chez Brevo.
   *
   * ⚠️ DISTINCT de `FAILED`, et la distinction est le cœur de ce statut. `FAILED`
   * dit « l'envoi a été tenté et a échoué » — il oriente vers le fournisseur, le
   * réseau, l'adresse. `PRECONDITION_FAILED` dit « nous n'avons rien tenté » : la
   * cause est chez nous, et le geste aussi. Les confondre enverrait chercher la
   * panne du mauvais côté, exactement comme confondre NETWORK_ERROR et
   * SERVICE_UNAVAILABLE.
   *
   * ⚠️ DISTINCT de `BLOCKED`, qui appartient au fournisseur : `BLOCKED` est écrit
   * par l'événement webhook `blocked` (destinataire sur liste de blocage Brevo)
   * et compte comme un REJET DE LIVRAISON. Réutiliser ce statut ici ferait
   * classer un refus interne en rejet de destinataire.
   *
   * Non terminal : la précondition est transitoire, la reprise est automatique.
   */
  PRECONDITION_FAILED: 'PRECONDITION_FAILED',
  /** `blocked` reçu par WEBHOOK : destinataire bloqué côté Brevo. */
  BLOCKED: 'BLOCKED',
  /** Réception confirmée par WEBHOOK (`delivered`). Jamais écrit sans événement. */
  DELIVERED: 'DELIVERED',
  /**
   * Umbrella de rebond — CONSERVÉ pour compatibilité. Le suivi réel écrit
   * désormais `SOFT_BOUNCED` / `HARD_BOUNCED`. Aucun code neuf n'écrit `BOUNCED`.
   */
  BOUNCED: 'BOUNCED',

  // ── Statuts écrits par le suivi réel (webhooks transactionnels Brevo) ──────
  /** `deferred` : report temporaire côté serveur destinataire. Toujours en vol. */
  DEFERRED: 'DEFERRED',
  /** `soft_bounce` : échec POTENTIELLEMENT temporaire (boîte pleine, indispo…). */
  SOFT_BOUNCED: 'SOFT_BOUNCED',
  /** `hard_bounce` : échec PERMANENT (adresse inexistante, domaine invalide). */
  HARD_BOUNCED: 'HARD_BOUNCED',
  /** `invalid_email` : adresse rejetée comme invalide par Brevo. */
  INVALID: 'INVALID',
  /** `spam` : le destinataire (ou son serveur) a signalé l'e-mail comme spam. */
  SPAM: 'SPAM',
  /** `error` : erreur fournisseur signalée après acceptation. */
  ERROR: 'ERROR',
  /** `unsubscribed` : désinscription du destinataire. */
  UNSUBSCRIBED: 'UNSUBSCRIBED',
});
export const DELIVERY_STATUS_VALUES = Object.values(DELIVERY_STATUS);

/** Résolveurs de destinataires connus (code-first). */
export const RECIPIENT_RESOLVER = Object.freeze({
  /** Tous les comptes ADMIN. */
  ADMIN_EMAILS: 'ADMIN_EMAILS',
  /** Tous les comptes DEV. */
  DEV_EMAILS: 'DEV_EMAILS',
  /**
   * Destinataires MÉTIER des nouvelles demandes de contact :
   * `Company.contactNotificationRecipients`, avec fallback documenté sur
   * l'adresse support. Séparé d'ADMIN_EMAILS : le commerçant choisit QUI est
   * prévenu, sans que cela dépende de la liste des comptes du Manager.
   */
  CONTACT_NOTIFICATION_RECIPIENTS: 'CONTACT_NOTIFICATION_RECIPIENTS',
  /**
   * Adresse fournie explicitement. RÉSERVÉ à la route DEV de test : aucune
   * action du registre d'événements ne doit l'utiliser, sans quoi un événement
   * métier pourrait écrire lui-même son destinataire — exactement ce que la
   * séparation template/destinataire interdit.
   */
  EXPLICIT_TEST_RECIPIENT: 'EXPLICIT_TEST_RECIPIENT',
});

/** Résolveurs interdits aux actions d'événement (cf. EXPLICIT_TEST_RECIPIENT). */
export const TEST_ONLY_RESOLVERS = Object.freeze([RECIPIENT_RESOLVER.EXPLICIT_TEST_RECIPIENT]);

// --- Bornes ------------------------------------------------------------------

export const MAX_SUBJECT_LENGTH = 300;

/**
 * Gmail TRONQUE un e-mail au-delà d'environ 102 ko et affiche « [Message
 * tronqué] ». On plafonne en dessous : un template plus gros serait accepté ici
 * puis mutilé chez le destinataire, ce qui est pire qu'un refus franc.
 */
export const MAX_HTML_LENGTH = 100_000;

/** Longueur maximale du nom et de la description (Manager). */
export const MAX_NAME_LENGTH = 120;
export const MAX_DESCRIPTION_LENGTH = 400;

/** Nombre de versions conservées par template (les plus ANCIENNES sont purgées). */
export const MAX_TEMPLATE_VERSION_HISTORY = 50;

// --- Sécurité HTML -----------------------------------------------------------

/**
 * Balises INTERDITES dans un template e-mail.
 *
 * `script` va de soi. Les autres méritent leur place :
 *  - `iframe`/`frame`/`frameset`/`object`/`embed`/`applet` : contenu actif embarqué ;
 *  - `svg`/`math` : peuvent contenir du script, et sont des vecteurs de mXSS ;
 *  - `base` : réécrirait la résolution de toutes les URLs relatives ;
 *  - `link` : ressource externe (CSS) — aucun client e-mail sérieux ne la charge ;
 *  - `form`/`input`/`button`/`select`/`textarea` : un formulaire dans un e-mail est
 *    un motif de hameçonnage, et les clients le neutralisent de toute façon.
 *
 * `style` est AUTORISÉE : les requêtes média (`@media`) sont le seul moyen de
 * rendre un e-mail responsive, et CSS n'exécute pas de JavaScript dans un client
 * moderne (`expression()` est mort avec IE).
 */
export const FORBIDDEN_TAGS = Object.freeze([
  'script', 'iframe', 'frame', 'frameset', 'object', 'embed', 'applet',
  'svg', 'math', 'base', 'link', 'form', 'input', 'button', 'select', 'textarea',
  'noscript', 'template', 'portal',
]);

/**
 * Attributs INTERDITS.
 *
 * Tout `on*` est refusé par motif (`onclick`, `onerror`, `onload`…) : les énumérer
 * serait une liste à trous. Les autres sont des vecteurs nommés.
 */
export const FORBIDDEN_ATTRIBUTE_PATTERNS = Object.freeze([
  /^on[a-z]+$/i, // onclick, onerror, onload, onmouseover…
]);
export const FORBIDDEN_ATTRIBUTES = Object.freeze([
  'srcdoc', 'formaction', 'xlink:href', 'http-equiv', 'ping',
]);

/** Attributs susceptibles de porter une URL — donc à contrôler. */
export const URL_ATTRIBUTES = Object.freeze(['href', 'src', 'action', 'background', 'cite', 'poster']);

/**
 * Schémas d'URL INTERDITS. `data:` est refusé sauf image (cf. DATA_IMAGE_RE) :
 * `data:text/html` est un contournement direct de l'interdiction d'iframe.
 */
export const DANGEROUS_URL_SCHEMES = Object.freeze([
  'javascript:', 'vbscript:', 'file:', 'about:', 'blob:',
]);

/** Seules données inline tolérées : des images bitmap. */
export const DATA_IMAGE_RE = /^data:image\/(png|jpe?g|gif|webp);base64,/i;

/**
 * Syntaxe d'un placeholder : `{{segment.segment}}`, rien d'autre.
 *
 * Chaque segment commence par une lettre puis n'accepte que lettres/chiffres/`_`.
 * Conséquence VOULUE : `__proto__` (commence par `_`), `{{a["b"]}}`, `{{a()}}`,
 * `{{a b}}` ne matchent pas — ils sont donc signalés comme placeholders invalides
 * plutôt que silencieusement ignorés.
 *
 * Il n'y a NI expression, NI condition, NI boucle, NI helper. C'est délibéré :
 * un moteur qui évalue est un moteur qu'on peut détourner.
 */
export const PLACEHOLDER_RE = /\{\{\s*([A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)*)\s*\}\}/g;

/**
 * Détecte TOUT `{{ … }}`, y compris malformé — sert à repérer ce que
 * `PLACEHOLDER_RE` a refusé, au lieu de le laisser passer en texte brut.
 */
export const ANY_MUSTACHE_RE = /\{\{([^{}]*)\}\}/g;

/** Symboles monétaires. Repli : le code ISO lui-même (« 1 234,56 CHF »). */
export const CURRENCY_SYMBOL = Object.freeze({ EUR: '€', USD: '$', GBP: '£' });

/** Fuseau de référence pour DATE/DATETIME. */
export const DISPLAY_TIME_ZONE = 'Europe/Paris';
