// ÉVÉNEMENT FOURNISSEUR REÇU — la primitive d'idempotence (L5).
//
// docs/architecture/WEBHOOK_CONTROL_PLANE.md §« Idempotence ».
//
// ── CE QUE CE MODÈLE EST ────────────────────────────────────────────────────
//
// Un REGISTRE DE RÉCEPTION, et rien de plus. Il répond à une question :
// « ai-je déjà vu cet événement ? ». Les fournisseurs rejouent — Stripe avec
// backoff, Yousign avec `auto_retry`, Brevo à sa guise — et un rejeu ne doit
// pas produire deux fois le même effet.
//
// ── CE QUE CE MODÈLE N'EST PAS ──────────────────────────────────────────────
//
// Ce n'est PAS un bus métier. Aucun `PAYMENT_SUCCEEDED`, aucun dispatch, aucune
// normalisation vers un vocabulaire de capacité : cela appartient à L6/L7/L8,
// qui possèdent les providers correspondants. L5 fournit la primitive sur
// laquelle ils s'appuieront ; construire leur table de correspondance ici
// reviendrait à cacher trois lots dans celui-ci.
//
// ── LE CORPS N'EST PAS CONSERVÉ ─────────────────────────────────────────────
//
// `payloadHash` seulement. Le corps d'un webhook porte des données
// personnelles ; le garder exigerait une durée de rétention, une politique
// d'effacement et une raison. L'empreinte suffit à ce que ce registre doit
// faire : distinguer un rejeu identique d'un événement neuf.
import mongoose from 'mongoose';

import { ENVIRONMENTS } from '../services/integratedApi/providerRegistry.js';

/**
 * ══ ÉTAT D'UN ÉVÉNEMENT REÇU — ET NON « ISSUE D'UNE RÉCEPTION » ═════════════
 *
 * ── LE DÉFAUT QUE CETTE MACHINE FERME ──────────────────────────────────────
 *
 * Il n'y avait que `RECEIVED` et `DUPLICATE`, et la seule question posée était
 * « la ligne existe-t-elle ? ». La réponse était traitée comme définitive :
 *
 *     webhook → ligne RECEIVED écrite → crash du process
 *             → Stripe rejoue → E11000 → duplicate = true
 *             → aucun effet métier, JAMAIS
 *
 * La ligne prouvait qu'on avait VU l'événement, pas qu'on l'avait APPLIQUÉ. Le
 * rejeu du fournisseur — la seule chance de rattrapage, et il l'offrait
 * gratuitement — était refusé au nom d'une idempotence qui ne protégeait plus
 * rien.
 *
 *     L'EXISTENCE D'UNE LIGNE N'EST PAS LA PREUVE D'UN TRAITEMENT.
 *
 * ── LA MACHINE ─────────────────────────────────────────────────────────────
 *
 *   RECEIVED  ──claim──▶  PROCESSING  ──▶  PROCESSED     terminal
 *                              │      ──▶  IGNORED       terminal
 *                              │      ──▶  FAILED        reprenable
 *                              │      ──▶  DEAD_LETTER   terminal, supervisé
 *                              │
 *                              └── bail expiré ──▶ reprenable
 *
 * Un seul état autorise la réponse « doublon, rien à faire » : `PROCESSED`.
 * `IGNORED` et `DEAD_LETTER` sont terminaux aussi, mais pour d'autres raisons —
 * l'un parce qu'il n'y avait rien à faire, l'autre parce qu'on a renoncé et
 * qu'on l'a DIT.
 */
export const WEBHOOK_EVENT_STATUS = Object.freeze({
  /** Enregistré, jamais réclamé. Reprenable dès qu'il a vieilli. */
  RECEIVED: 'RECEIVED',
  /** Réclamé par un processus, sous bail. Un second n'y touche pas. */
  PROCESSING: 'PROCESSING',
  /** Appliqué. **Le seul état où un rejeu est un doublon sûr.** */
  PROCESSED: 'PROCESSED',
  /** Reçu, sans effet à produire (hors périmètre, mode inactif). Terminal. */
  IGNORED: 'IGNORED',
  /** Échec REPRENABLE : dépendance indisponible, redémarrage, délai dépassé. */
  FAILED: 'FAILED',
  /**
   * On renonce, et on le dit. Erreur terminale, ou trop de tentatives.
   *
   * Jamais silencieux : c'est ce qui distingue un abandon assumé d'un
   * événement perdu. La supervision le porte, avec son dernier motif.
   */
  DEAD_LETTER: 'DEAD_LETTER',
  /**
   * HÉRITÉ — jamais écrit par ce code, jamais supprimé de l'énumération.
   *
   * Aucune ligne ne l'a jamais porté : le doublon était l'insertion REFUSÉE,
   * qui par définition n'écrit rien. Le retirer ferait échouer la validation
   * d'un document historique qu'on aurait mal lu ; le garder ne coûte rien.
   */
  DUPLICATE: 'DUPLICATE',
});

/** Les états d'où plus rien ne repart. Un rejeu s'y arrête. */
export const WEBHOOK_TERMINAL_STATUSES = Object.freeze([
  WEBHOOK_EVENT_STATUS.PROCESSED,
  WEBHOOK_EVENT_STATUS.IGNORED,
  WEBHOOK_EVENT_STATUS.DEAD_LETTER,
]);

/** Les états d'où un travail abandonné peut être repris. */
export const WEBHOOK_RECLAIMABLE_STATUSES = Object.freeze([
  WEBHOOK_EVENT_STATUS.RECEIVED,
  WEBHOOK_EVENT_STATUS.FAILED,
  WEBHOOK_EVENT_STATUS.PROCESSING, // uniquement si le bail a expiré
]);

export const WEBHOOK_EVENT_STATUS_VALUES = Object.freeze(Object.values(WEBHOOK_EVENT_STATUS));

const providerWebhookEventSchema = new mongoose.Schema(
  {
    provider: { type: String, required: true, uppercase: true, trim: true },
    environment: { type: String, required: true, enum: [...ENVIRONMENTS] },

    /**
     * Identifiant d'événement CÔTÉ FOURNISSEUR, ou empreinte du corps brut
     * quand le fournisseur n'en fournit aucun (Brevo). Dans les deux cas :
     * stable pour un même événement, différent pour deux événements distincts.
     */
    providerEventId: { type: String, required: true },

    /** Le binding par lequel il est entré — le lien vers le plan de contrôle. */
    bindingId: { type: String, default: null },

    /** Type BRUT du fournisseur, conservé pour le forensic. Jamais traduit ici. */
    eventType: { type: String, default: '' },

    /** Empreinte du corps brut. Jamais le corps. */
    payloadHash: { type: String, default: '' },

    /**
     * L'appel a-t-il été PROUVÉ cryptographiquement ?
     *
     * `false` n'implique pas « rejeté » : un webhook Brevo authentifié par
     * jeton partagé est accepté et marqué non prouvé. La nuance est conservée
     * en base parce qu'elle change la confiance qu'on peut lui accorder, et
     * qu'un jour on voudra la retrouver.
     */
    signatureVerified: { type: Boolean, default: false },

    status: {
      type: String,
      enum: WEBHOOK_EVENT_STATUS_VALUES,
      default: WEBHOOK_EVENT_STATUS.RECEIVED,
    },

    /**
     * À QUI EST CET ÉVÉNEMENT ? — résolu par le LIEN, jamais par le corps (L6.2C).
     *
     * `null` n'est pas un défaut : c'est le cas normal pour un fournisseur dont
     * l'appartenance ne se résout pas encore, et pour toute ressource que le
     * Panel n'a pas lui-même créée. Une valeur ici signifie « le Panel PROUVE
     * que cette ressource est à ce projet », et rien de moins.
     */
    projectId: { type: String, default: null },

    /**
     * Le VERDICT d'appartenance, conservé même quand il est négatif.
     *
     * C'est ce qui rend un événement non attribué INVESTIGABLE plutôt que
     * perdu : on sait qu'il est arrivé, on sait qu'il a été vérifié, et on sait
     * pourquoi personne ne l'a reçu.
     */
    ownership: { type: String, default: null },

    /** Les metadata désignaient-elles un autre projet que le lien ? */
    claimMismatch: { type: Boolean, default: false },

    /**
     * IL A UNE VALEUR PAR DÉFAUT, ET CE N'EST PAS UN CONFORT.
     *
     * La réclamation (`webhookLease.js`) tente TOUJOURS une insertion, et
     * compte sur le refus E11000 pour détecter un rejeu. Sans défaut ici,
     * Mongoose validait AVANT d'atteindre l'index : la reprise recevait une
     * `ValidationError` au lieu du doublon attendu, et levait — c'est-à-dire
     * qu'elle échouait précisément sur le chemin qu'elle existe pour couvrir.
     */
    receivedAt: { type: String, required: true, default: () => new Date().toISOString() },

    /** Quand l'événement a CESSÉ d'être en cours — quelle qu'en soit l'issue. */
    processedAt: { type: String, default: null },

    /* ── LE BAIL — ce qui distingue « en cours » de « abandonné » ─────────── */

    /**
     * QUI travaille dessus, en ce moment. `hôte:pid:démarrage`.
     *
     * Le nonce de démarrage est ce qui compte : un processus redémarré porte
     * le même hôte et parfois le même pid, mais jamais le même nonce. Sans
     * lui, un processus ressuscité se reconnaîtrait comme propriétaire d'un
     * bail qu'il a perdu en mourant.
     */
    leaseOwner: { type: String, default: null },

    /** Début de la tentative en cours. Diagnostic : « depuis quand ? ». */
    processingStartedAt: { type: String, default: null },

    /**
     * Au-delà de cet instant, le travail est réputé ABANDONNÉ.
     *
     * Ce n'est pas une supposition sur la lenteur d'un handler : c'est la
     * frontière au-delà de laquelle continuer d'attendre coûte plus cher que
     * de reprendre. Voir `webhookLease.js` pour le choix de la durée.
     */
    leaseExpiresAt: { type: String, default: null },

    /**
     * Nombre de RÉCLAMATIONS, pas de livraisons.
     *
     * Un fournisseur qui rejoue vingt fois un événement déjà `PROCESSED`
     * n'incrémente rien : il n'a rien réclamé. Ce compteur ne monte que quand
     * quelqu'un s'est engagé à faire le travail — c'est ce qui en fait un
     * détecteur d'événement toxique plutôt qu'un compteur de trafic.
     */
    processingAttempts: { type: Number, default: 0 },

    /**
     * Le dernier échec, avec sa CLASSIFICATION.
     *
     * `retryable` est le champ qui décide : sans lui, un payload malformé et
     * une base momentanément injoignable auraient le même destin — soit la
     * boucle infinie, soit l'abandon d'un événement parfaitement rattrapable.
     *
     * Jamais de corps d'événement ici, jamais de secret : un code, un message
     * tronqué, un instant.
     */
    lastError: {
      code: { type: String, default: null },
      message: { type: String, default: null },
      retryable: { type: Boolean, default: null },
      at: { type: String, default: null },
    },
  },
  { minimize: false, versionKey: false },
);

/**
 * L'IDEMPOTENCE EST PORTÉE PAR L'INDEX, PAS PAR UN `findOne` PRÉALABLE.
 *
 * Deux livraisons concurrentes du même événement — cas réel avec le backoff
 * d'un fournisseur — passeraient toutes deux un test d'existence avant que
 * l'une ait écrit. Seule une contrainte unique en base tranche : la seconde
 * insertion reçoit un E11000, et c'est CE refus qui prouve le doublon.
 *
 * La clé inclut l'environnement : un même identifiant d'événement peut exister
 * dans deux comptes fournisseur distincts.
 */
providerWebhookEventSchema.index(
  { provider: 1, environment: 1, providerEventId: 1 },
  { unique: true, name: 'uniq_provider_environment_event' },
);

/** Lecture d'exploitation : « qu'a-t-on reçu récemment sur ce binding ? ». */
providerWebhookEventSchema.index({ bindingId: 1, receivedAt: -1 }, { name: 'binding_recent' });

/**
 * Exploitation L6.2C : « qu'a reçu ce projet ? » et « qu'est-ce qui n'a été
 * attribué à personne ? ». La seconde est la plus importante — c'est la file
 * d'attente d'un diagnostic, et elle doit rester lisible sans balayage.
 */
providerWebhookEventSchema.index(
  { provider: 1, environment: 1, ownership: 1, receivedAt: -1 },
  { name: 'ownership_recent' },
);

/**
 * LA FILE DE REPRISE — « qu'est-ce qui traîne, et depuis quand ? ».
 *
 * C'est la question que pose l'amorçage à chaque démarrage, et le balayage de
 * veille à chaque passage. Elle porte sur toute la collection et doit rester
 * lisible sans parcours complet : la file utile est minuscule (zéro, la
 * plupart du temps), la collection ne cesse de grandir.
 */
providerWebhookEventSchema.index(
  { status: 1, leaseExpiresAt: 1, receivedAt: 1 },
  { name: 'reprise_par_etat' },
);

export const PanelProviderWebhookEvent = mongoose.model(
  'PanelProviderWebhookEvent',
  providerWebhookEventSchema,
);

export default PanelProviderWebhookEvent;
