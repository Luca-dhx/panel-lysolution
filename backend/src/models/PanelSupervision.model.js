// Collections de SUPERVISION — Phase 3A.
//
// Discipline de la phase : le Panel OBSERVE. Ces documents ne décrivent que
// ce que les projets ont publié (heartbeats) ou ce que le Panel a constaté
// de leur publication (événements de chronologie). Aucun n'est une intention,
// aucun n'induit une action distante.
import mongoose from 'mongoose';

/**
 * Historique des heartbeats reçus, par projet.
 *
 * Conservé pour lire une TENDANCE (le projet redémarre-t-il en boucle ? sa
 * mémoire dérive-t-elle ?), pas seulement le dernier état. La rétention est
 * bornée par `HEARTBEAT_HISTORY_SIZE`.
 */
const heartbeatSchema = new mongoose.Schema(
  {
    projectId: { type: String, required: true },
    receivedAt: { type: String, required: true },
    sentAt: { type: String, required: true },
    softwareVersion: { type: String, default: null },
    environment: { type: String, enum: ['TEST', 'PROD', null], default: null },
    healthStatus: { type: String, enum: ['OK', 'DEGRADED', null], default: null },
    healthDetails: { type: String, default: null },
    // Contrat ≥ 1.2.0, tout optionnel : un projet plus ancien n'en publie pas.
    uptimeSeconds: { type: Number, default: null },
    load: { type: mongoose.Schema.Types.Mixed, default: null },
    components: { type: mongoose.Schema.Types.Mixed, default: null },
    engines: { type: mongoose.Schema.Types.Mixed, default: null },
    bridgeStats: { type: mongoose.Schema.Types.Mixed, default: null },
  },
  { minimize: false, versionKey: false },
);
heartbeatSchema.index({ projectId: 1, receivedAt: -1 });

/**
 * Chronologie — le Panel n'INVENTE aucun événement.
 *
 * Chaque entrée est soit une déclaration du projet (heartbeat, bootstrap),
 * soit un CONSTAT de changement entre deux publications successives
 * (« la version a changé », « le projet est réapparu »). L'origine est
 * toujours explicite.
 */
const eventSchema = new mongoose.Schema(
  {
    // `null` depuis la Phase 4 : un événement peut concerner le Panel
    // lui-même (publication d'une configuration d'entreprise) et non un
    // projet. Le distinguer d'un projet inconnu importe — d'où null plutôt
    // qu'une valeur sentinelle.
    projectId: { type: String, default: null },
    occurredAt: { type: String, required: true },
    type: { type: String, required: true },
    // PROJECT : le projet l'a déclaré · PANEL_OBSERVATION : constat du Panel
    // en comparant deux publications · PANEL : acte délibéré d'un opérateur
    // du Panel (Phase 4 — le Panel agit désormais).
    source: { type: String, enum: ['PROJECT', 'PANEL_OBSERVATION', 'PANEL'], required: true },
    severity: { type: String, enum: ['INFO', 'WARNING', 'ERROR'], default: 'INFO' },
    summary: { type: String, required: true },
    data: { type: mongoose.Schema.Types.Mixed, default: null },
  },
  { minimize: false, versionKey: false },
);
eventSchema.index({ projectId: 1, occurredAt: -1 });

export const PanelHeartbeat = mongoose.model('PanelHeartbeat', heartbeatSchema);
export const PanelEvent = mongoose.model('PanelEvent', eventSchema);

/** Types d'événements de chronologie — catalogue fermé, additif. */
export const EVENT_TYPES = Object.freeze({
  PROJECT_DECLARED: 'PROJECT_DECLARED',
  PROJECT_PAIRED: 'PROJECT_PAIRED',
  PROJECT_UNPAIRED: 'PROJECT_UNPAIRED',
  HEARTBEAT_RECEIVED: 'HEARTBEAT_RECEIVED',
  VERSION_CHANGED: 'VERSION_CHANGED',
  ENGINE_VERSION_CHANGED: 'ENGINE_VERSION_CHANGED',
  DEPLOYMENT_DETECTED: 'DEPLOYMENT_DETECTED',
  BRIDGE_RECONNECTED: 'BRIDGE_RECONNECTED',
  HEALTH_CHANGED: 'HEALTH_CHANGED',
  MANIFEST_UPDATED: 'MANIFEST_UPDATED',
  ENVIRONMENT_CHANGED: 'ENVIRONMENT_CHANGED',
  // Phase 4 — l'entreprise et sa configuration.
  COMPANY_CREATED: 'COMPANY_CREATED',
  COMPANY_PUBLISHED: 'COMPANY_PUBLISHED',
  INTEGRATED_API_GRANTED: 'INTEGRATED_API_GRANTED',
  INTEGRATED_API_REVOKED: 'INTEGRATED_API_REVOKED',
  /**
   * RETIRÉ EN L4 — plus aucune écriture ne l'émet.
   *
   * Il datait de l'époque où enregistrer une clé la rediffusait aux projets.
   * Cette diffusion n'existe plus. Le type reste au catalogue parce que des
   * chronologies en production le portent : le retirer rendrait illisibles des
   * événements déjà écrits, pour un gain nul.
   */
  INTEGRATED_API_PUBLISHED: 'INTEGRATED_API_PUBLISHED',
  PROJECT_DISCOVERED: 'PROJECT_DISCOVERED',
  /**
   * L12.A — ACCÈS DÉVELOPPEUR FÉDÉRÉ, délivré ou refusé.
   *
   * Deux types et non un seul avec une issue en donnée : un refus d'accès est
   * ce qu'un exploitant vient chercher, et il doit pouvoir le filtrer sans lire
   * le contenu de chaque événement. Le refus porte toujours son `reasonCode`.
   *
   * Ces événements ne portent JAMAIS l'assertion elle-même — seulement son
   * `jti`, son `kid` et sa date d'expiration.
   */
  /**
   * L12.C — UN COMPTE A MODIFIÉ SON PROPRE PROFIL.
   *
   * Distinct d'une administration : l'acteur et la cible sont le même compte.
   * Les confondre dans un seul type empêcherait de répondre à « qui a changé
   * quoi sur qui », qui est la seule question qu'un journal d'identité doit
   * savoir trancher.
   */
  PANEL_USER_PROFILE_UPDATED: 'PANEL_USER_PROFILE_UPDATED',
  /**
   * LOT SUPER_ADMIN — L'ADMINISTRATION DES IDENTITÉS DU PANEL.
   *
   * ── POURQUOI SIX TYPES ET NON UN SEUL `PANEL_USER_ADMINISTERED` ────────────
   *
   * Parce que ce ne sont pas six variantes d'un même acte, ce sont six
   * questions d'enquête distinctes : « qui a promu qui », « qui a ouvert quel
   * client à qui », « qui a été supprimé et par qui ». Un exploitant doit
   * pouvoir filtrer sur l'une sans lire le contenu de toutes les autres — un
   * type unique avec l'acte en donnée l'obligerait à ouvrir chaque événement.
   *
   * ── CE QUE LEUR `data` PORTE, ET CE QU'ELLE NE PORTERA JAMAIS ──────────────
   *
   * Porte : `actorUserId`, `actorEmail`, `targetUserId`, `targetEmail`,
   * `targetDisplayName`, et le avant/après du seul champ concerné. L'adresse
   * et le nom de la cible sont figés EN INSTANTANÉ — un événement qui ne
   * porterait qu'un identifiant deviendrait illisible à la seconde où le
   * compte est supprimé, ce qui est précisément le moment où l'on relit le
   * journal.
   *
   * Ne porte jamais : mot de passe, empreinte, jeton de session, jeton de
   * réinitialisation, assertion.
   */
  PANEL_USER_CREATED: 'PANEL_USER_CREATED',
  PANEL_USER_UPDATED: 'PANEL_USER_UPDATED',
  PANEL_USER_ROLE_CHANGED: 'PANEL_USER_ROLE_CHANGED',
  PANEL_USER_ENABLED_CHANGED: 'PANEL_USER_ENABLED_CHANGED',
  PANEL_USER_PROJECT_ACCESS_CHANGED: 'PANEL_USER_PROJECT_ACCESS_CHANGED',
  PANEL_USER_DELETED: 'PANEL_USER_DELETED',
  FEDERATED_ASSERTION_ISSUED: 'FEDERATED_ASSERTION_ISSUED',
  FEDERATED_ASSERTION_DENIED: 'FEDERATED_ASSERTION_DENIED',
  /**
   * L10.6B-2 — UN IMPAYÉ A RÉELLEMENT FERMÉ UN SITE.
   *
   * Écrit à la CONFIRMATION, quand le projet a renvoyé son état et prouvé que
   * la cause financière est appliquée — jamais à la demande de suspension.
   * `suspensionRequestedAt` dit ce que le Panel a réclamé ;
   * `suspensionConfirmedAt` dit ce qui s'est réellement produit. Journaliser
   * la première ferait apparaître dans la chronologie des fermetures qui
   * n'ont peut-être jamais eu lieu.
   *
   * Ce journal est l'ACTIVITÉ D'OPÉRATEUR, borné à `timelineHistorySize`. La
   * preuve durable de l'incident reste `PanelPaymentDefault`, qui n'est jamais
   * élagué : un défaut de paiement de l'an dernier doit rester démontrable
   * longtemps après que son événement a quitté la chronologie.
   */
  PROJECT_SITE_SUSPENDED_PAYMENT_DEFAULT: 'PROJECT_SITE_SUSPENDED_PAYMENT_DEFAULT',
  // L1 — plan de contrôle IntegratedAPI. Ces événements ne concernent aucun
  // projet (`projectId: null`) : ils décrivent le Panel administrant son
  // propre coffre. Leur `data` ne porte QUE des noms de rôles et des codes.
  INTEGRATED_API_CREDENTIALS_UPDATED: 'INTEGRATED_API_CREDENTIALS_UPDATED',
  INTEGRATED_API_VALIDATION_SUCCEEDED: 'INTEGRATED_API_VALIDATION_SUCCEEDED',
  INTEGRATED_API_VALIDATION_FAILED: 'INTEGRATED_API_VALIDATION_FAILED',
  /**
   * L3 — passerelle de capacités. Deux types, et la séparation compte.
   *
   * Une INVOCATION est un fait d'exploitation ; un REFUS est un fait aussi,
   * mais c'est celui qu'on relit quand quelque chose ne marche pas. Les fondre
   * en un seul type obligerait à filtrer sur `data` pour répondre à « pourquoi
   * ce projet n'arrive-t-il pas à envoyer ? » — la question la plus fréquente
   * qu'on posera à ce journal.
   *
   * Aucun de leurs `data` ne porte de secret : provider, environnement, code
   * de capacité, issue, durée. Jamais de clé, jamais d'entrée métier, jamais
   * d'adresse.
   *
   * ── TROIS TYPES ONT ÉTÉ RETIRÉS DE CE CATALOGUE ───────────────────────────
   *
   *   CAPABILITY_GRANTS_UPDATED   un opérateur venait de cocher des cases
   *   COMMERCIAL_OPENED           un opérateur venait d'ouvrir le commerce
   *   COMMERCIAL_CLOSED           …ou de le refermer
   *
   * Les trois traçaient des GESTES DE CONFIGURATION qui n'existent plus. Ils
   * sont supprimés du vocabulaire et non conservés « au cas où » : un type
   * d'événement que plus rien n'émet finit par être réutilisé pour autre chose,
   * et la chronologie d'un projet ancien deviendrait alors illisible.
   *
   * Les événements DÉJÀ ÉCRITS en base ne sont pas effacés — ils racontent des
   * décisions réellement prises, et une chronologie qu'on réécrit ne vaut plus
   * rien. Le champ `type` n'est pas contraint par une énumération Mongoose, ils
   * restent donc lisibles tels quels.
   */
  CAPABILITY_INVOKED: 'CAPABILITY_INVOKED',
  CAPABILITY_REFUSED: 'CAPABILITY_REFUSED',
  /**
   * L10.1 — le registre financier.
   *
   * Trois types, parce que les trois questions qu'on posera à ce journal sont
   * distinctes : « qui a saisi cette ligne ? », « qui l'a corrigée, et
   * qu'y avait-il avant ? », « qui l'a retirée du bénéfice, et pourquoi ? ».
   * Un type unique obligerait à filtrer sur `data` pour répondre à la
   * troisième — celle qui compte le jour où un total change sans explication.
   *
   * `projectId` vaut `null` pour un mouvement propre à L.Y Solution : c'est le
   * même nul que le modèle, et il se lit pareil.
   *
   * Leur `data` porte l'identifiant du mouvement, sa taxonomie, son montant en
   * centimes et son origine. JAMAIS de charge utile fournisseur, jamais de
   * secret : un journal de chronologie se lit à plusieurs, un secret ne se
   * lit pas.
   */
  FINANCIAL_TRANSACTION_CREATED: 'FINANCIAL_TRANSACTION_CREATED',
  FINANCIAL_TRANSACTION_UPDATED: 'FINANCIAL_TRANSACTION_UPDATED',
  FINANCIAL_TRANSACTION_DELETED: 'FINANCIAL_TRANSACTION_DELETED',
  /**
   * L10.5 — LES PRESTATIONS FACTURÉES. Six types, et le découpage compte.
   *
   * Ils décrivent l'ARGENT RÉCLAMÉ, jamais l'argent constaté : ce dernier a
   * déjà ses trois types au-dessus. Les fondre aurait rendu impossible la
   * question la plus fréquente — « qu'ai-je facturé qui n'est pas rentré ? ».
   *
   * Aucun n'est un événement Stripe recopié. `PAYMENT_REQUEST_PAID` ne dit pas
   * « checkout.session.completed reçu » : il dit qu'une prestation nommée a été
   * réglée. La chronologie d'un projet parle métier, et un opérateur qui la
   * relit ne devrait jamais avoir à connaître le vocabulaire du fournisseur.
   */
  PAYMENT_REQUEST_CREATED: 'PAYMENT_REQUEST_CREATED',
  PAYMENT_REQUEST_SENT: 'PAYMENT_REQUEST_SENT',
  /** Une session de paiement s'est ouverte. Le client est devant sa carte. */
  PAYMENT_REQUEST_PAYMENT_STARTED: 'PAYMENT_REQUEST_PAYMENT_STARTED',
  PAYMENT_REQUEST_PAID: 'PAYMENT_REQUEST_PAID',
  PAYMENT_REQUEST_CANCELED: 'PAYMENT_REQUEST_CANCELED',
  PAYMENT_REQUEST_REMINDER_SENT: 'PAYMENT_REQUEST_REMINDER_SENT',
  /** Un e-mail perdu est un FAIT, pas un silence. La créance, elle, reste due. */
  PAYMENT_REQUEST_REMINDER_FAILED: 'PAYMENT_REQUEST_REMINDER_FAILED',
  /**
   * L10.6 — LES DÉFAUTS DE PAIEMENT D'ABONNEMENT. Trois types, trois faits.
   *
   * `OPENED` est l'impayé constaté ; `GRACE_EXPIRED` est la seule décision que
   * le Panel prenne dans tout ce cycle ; `RESOLVED` est la régularisation.
   *
   * Il n'existe volontairement AUCUN type « tentative » : le Panel ne retente
   * rien. Stripe est l'unique ordonnanceur des tentatives de collecte, et
   * inscrire ses essais dans la chronologie du projet ferait croire l'inverse.
   */
  PAYMENT_DEFAULT_OPENED: 'PAYMENT_DEFAULT_OPENED',
  PAYMENT_DEFAULT_GRACE_EXPIRED: 'PAYMENT_DEFAULT_GRACE_EXPIRED',
  PAYMENT_DEFAULT_RESOLVED: 'PAYMENT_DEFAULT_RESOLVED',
  /**
   * L'ENTREPRISE CLIENTE — l'identité juridique à qui l'on facture.
   *
   * ── POURQUOI LE RATTACHEMENT A SON PROPRE TYPE ────────────────────────────
   *
   * Parce qu'il change QUI SERA FACTURÉ et QUI SIGNERA les prochains actes
   * d'un projet. C'est la décision la plus lourde de ce domaine, et c'est la
   * première qu'on relira le jour où une facture partira au mauvais nom. La
   * noyer dans un `CLIENT_COMPANY_UPDATED` générique obligerait à ouvrir
   * chaque événement pour retrouver celui qui compte.
   *
   * `projectId` vaut `null` pour la création et la mise à jour d'une fiche —
   * elle n'appartient à aucun projet en particulier — et porte le projet pour
   * les deux événements de rattachement, qui, eux, sont des faits de projet.
   *
   * Leur `data` porte des identifiants, une raison sociale et un SIREN. Jamais
   * de note interne, jamais de document, jamais d'adresse e-mail de personne
   * physique : une chronologie se lit à plusieurs.
   */
  CLIENT_COMPANY_CREATED: 'CLIENT_COMPANY_CREATED',
  CLIENT_COMPANY_UPDATED: 'CLIENT_COMPANY_UPDATED',
  CLIENT_COMPANY_ARCHIVED: 'CLIENT_COMPANY_ARCHIVED',
  CLIENT_COMPANY_RESTORED: 'CLIENT_COMPANY_RESTORED',
  CLIENT_COMPANY_LINKED: 'CLIENT_COMPANY_LINKED',
  CLIENT_COMPANY_UNLINKED: 'CLIENT_COMPANY_UNLINKED',
  CLIENT_COMPANY_DOCUMENT_ADDED: 'CLIENT_COMPANY_DOCUMENT_ADDED',
  CLIENT_COMPANY_DOCUMENT_REMOVED: 'CLIENT_COMPANY_DOCUMENT_REMOVED',
  /**
   * LE PONT D'UN PROJET NE CONSOMME PLUS — et il ne le disait à personne.
   *
   * ── LE DÉFAUT QUE CE TYPE REND VISIBLE ────────────────────────────────────
   *
   * Un projet a tourné 91 cycles avec `applied: 0`, `lastError: null` et
   * `bridge.state: DEGRADED`. Rien n'avait échoué au sens du transport : c'est
   * précisément pourquoi rien ne s'affichait. Le seul mécanisme DURABLE de
   * propagation Panel → projet était hors service, en silence.
   *
   * `DEGRADED` est écrit quand le constat franchit un seuil ; `RECOVERED`
   * quand la consommation repart. Deux types plutôt qu'un avec une issue en
   * donnée : on relit un journal pour trouver les pannes, pas pour filtrer les
   * rétablissements.
   */
  /**
   * L12.1 — UN INCIDENT TECHNIQUE DURABLE RAPPORTÉ PAR UN PROJET.
   *
   * Écrit à la réception de l'entité `PLATFORM_INCIDENT`, AVANT toute
   * tentative d'alerte : le suivi doit porter l'incident même si l'e-mail
   * échoue. Un incident qui n'existe qu'à travers un e-mail parti disparaît
   * exactement le jour où l'envoi tombe en panne — c'est-à-dire le jour où on
   * en a le plus besoin.
   */
  PLATFORM_INCIDENT_RAISED: 'PLATFORM_INCIDENT_RAISED',

  /**
   * ══ UN ÉVÉNEMENT FOURNISSEUR QUI NE S'APPLIQUE PAS ═══════════════════════
   *
   * `WEBHOOK_PROCESSING_FAILED` — une tentative a échoué. Reprenable : le
   * prochain rejeu ou le prochain démarrage la reprendra. C'est un avertissement,
   * pas une perte.
   *
   * `WEBHOOK_PROCESSING_STUCK` — on a RENONCÉ (`DEAD_LETTER`) : erreur
   * terminale, ou plafond de tentatives atteint. Il n'y aura pas de reprise
   * automatique, et quelqu'un doit regarder.
   *
   * ── POURQUOI DEUX TYPES, ET PAS UN SEUL AVEC DEUX SÉVÉRITÉS ──────────────
   *
   * Parce qu'on ne les relit pas pour la même raison. Le premier documente une
   * turbulence — utile en forensic, sans action. Le second est une file de
   * travail humaine, et devoir la reconstituer en filtrant sur une sévérité
   * revient à ne pas l'avoir.
   *
   * NI CORPS, NI SECRET : identifiant, type, tentatives, âge, motif tronqué.
   * Le corps d'un événement Stripe porte des identités et des montants ; une
   * chronologie de supervision n'a aucune raison de les conserver.
   */
  WEBHOOK_PROCESSING_FAILED: 'WEBHOOK_PROCESSING_FAILED',
  WEBHOOK_PROCESSING_STUCK: 'WEBHOOK_PROCESSING_STUCK',
  PROJECT_BRIDGE_DEGRADED: 'PROJECT_BRIDGE_DEGRADED',
  PROJECT_BRIDGE_RECOVERED: 'PROJECT_BRIDGE_RECOVERED',
});

export default { PanelHeartbeat, PanelEvent, EVENT_TYPES };
