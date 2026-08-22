/**
 * L10.6B-3 — TRADUIRE UN INCIDENT EN QUELQUE CHOSE QU'ON PEUT LIRE.
 *
 * ══ POURQUOI CE MODULE EXISTE, ET POURQUOI IL EST CÔTÉ SERVEUR ══════════════
 *
 * Parce que sinon il serait dans React, et React recalculerait alors des états
 * métier à partir d'approximations. Une échéance de grâce reconstruite depuis
 * `firstFailedAt + paymentGraceDays` afficherait la politique COURANTE du
 * contrat sur un incident qui en a figé une autre — et annoncerait au client
 * une date de fermeture que le moteur n'appliquera jamais.
 *
 * Ce module est PUR : aucune base, aucun réseau, aucune horloge implicite.
 * Il prend ce que les autorités ont décidé et le met en mots. Rien de plus.
 *
 * ══ QUATRE DIMENSIONS, ET ON NE LES FUSIONNE JAMAIS ════════════════════════
 *
 *   PAIEMENT            en échec  /  régularisé
 *   GRÂCE               non configurée  /  en cours  /  expirée
 *   CAUSE               absente  /  demandée  /  appliquée  /  retirée
 *   ACCESSIBILITÉ       le site répond, ou non — et pourquoi
 *
 * Les réduire à un badge unique produirait des phrases fausses. L'état qui
 * l'établit :
 *
 *     Paiement        : régularisé
 *     Défaut paiement : retiré
 *     Site            : suspendu
 *     Autre cause     : maintenance technique
 *
 * Un badge vert « tout va bien » y serait un mensonge ; un badge rouge
 * « impayé » aussi. Les deux affirmations sont vraies EN MÊME TEMPS, et
 * l'écran doit pouvoir les dire toutes les deux.
 */

/* -------------------------------------------------------------------------- */
/*  VOCABULAIRE                                                               */
/* -------------------------------------------------------------------------- */

/** Le motif canonique. Défini une fois, jamais reformulé, jamais traduit. */
export const REASON_LABEL = 'Défaut de paiement';

export const PAYMENT_STATE = Object.freeze({ FAILED: 'FAILED', SETTLED: 'SETTLED', ENDED: 'ENDED' });
export const GRACE_STATE = Object.freeze({
  UNCONFIGURED: 'UNCONFIGURED', RUNNING: 'RUNNING', EXPIRED: 'EXPIRED', NOT_APPLICABLE: 'NOT_APPLICABLE',
});
export const CAUSE_STATE = Object.freeze({
  NONE: 'NONE', REQUESTED: 'REQUESTED', APPLIED: 'APPLIED', REMOVED: 'REMOVED',
});
export const SITE_STATE = Object.freeze({
  ACCESSIBLE: 'ACCESSIBLE', SUSPENDED: 'SUSPENDED', UNKNOWN: 'UNKNOWN',
});

const PAYMENT_LABELS = Object.freeze({
  FAILED: 'Paiement en échec',
  SETTLED: 'Paiement régularisé',
  ENDED: 'Abonnement terminé sans règlement',
});

const GRACE_LABELS = Object.freeze({
  UNCONFIGURED: 'Aucun délai de grâce configuré',
  RUNNING: 'Délai de grâce en cours',
  EXPIRED: 'Délai de grâce expiré',
  NOT_APPLICABLE: 'Sans objet',
});

const CAUSE_LABELS = Object.freeze({
  NONE: 'Aucune suspension demandée',
  REQUESTED: "Suspension en cours d'application",
  APPLIED: 'Site suspendu pour défaut de paiement',
  REMOVED: 'Défaut de paiement retiré',
});

const SITE_LABELS = Object.freeze({
  ACCESSIBLE: 'Site accessible',
  SUSPENDED: 'Site suspendu',
  UNKNOWN: 'État du site inconnu',
});

/** Les autres causes, nommées pour un humain. */
const OTHER_CAUSE_LABELS = Object.freeze({
  technical: 'Maintenance technique',
  contract: 'Aucun contrat en cours',
});

/* -------------------------------------------------------------------------- */
/*  DIMENSIONS                                                                */
/* -------------------------------------------------------------------------- */

/**
 * LE PAIEMENT.
 *
 * `nextPaymentAttemptAt` est une OBSERVATION de Stripe. L'écran doit dire
 * « prévue par Stripe », jamais « nous retenterons » : le Panel n'ordonnance
 * aucune tentative, et laisser croire le contraire ferait attendre au client
 * une action que personne ne déclenchera.
 *
 * Une date absente ne veut pas dire « aucune tentative prévue ». Elle veut
 * dire que Stripe ne l'a pas communiquée. La nuance est tout l'écart entre
 * une information et une promesse.
 */
function describePayment(incident) {
  const state = incident.status === 'RESOLVED'
    ? PAYMENT_STATE.SETTLED
    : incident.status === 'CLOSED'
      ? PAYMENT_STATE.ENDED
      : PAYMENT_STATE.FAILED;

  const nextKnown = Boolean(incident.nextPaymentAttemptAt);
  return {
    state,
    label: PAYMENT_LABELS[state],
    firstFailedAt: incident.firstFailedAt ?? null,
    lastFailedAt: incident.lastFailedAt ?? null,
    amountDueCents: incident.amountDueCents ?? 0,
    currency: incident.currency ?? 'EUR',
    invoiceNumber: incident.invoiceNumber ?? null,
    hostedInvoiceUrl: incident.hostedInvoiceUrl ?? null,
    invoicePdfUrl: incident.invoicePdfUrl ?? null,
    /** Observations Stripe — recopiées, jamais estimées. */
    attemptCount: incident.attemptCount ?? 0,
    nextPaymentAttemptAt: incident.nextPaymentAttemptAt ?? null,
    nextAttemptKnown: nextKnown,
    nextAttemptLabel: nextKnown
      ? 'Prochaine tentative prévue par Stripe'
      : 'Prochaine tentative non communiquée',
    resolvedAt: incident.resolvedAt ?? null,
  };
}

/**
 * LA GRÂCE.
 *
 * `null` et `0` sont deux décisions OPPOSÉES, et l'écran doit les dire
 * différemment :
 *
 *   null → aucune politique. Le site ne sera pas fermé automatiquement.
 *   0    → aucune clémence. L'échéance tombe dès l'échec.
 *
 * Les confondre ferait promettre une suspension automatique là où il n'y en
 * aura jamais, ou l'inverse.
 *
 * @param {Date|string|null} now  l'instant de référence, TOUJOURS fourni par
 *   l'appelant. Aucune horloge implicite : ce module doit rester pur.
 */
function describeGrace(incident, now) {
  const jours = incident.graceDaysSnapshot;
  const echeance = incident.graceDeadlineAt ?? null;
  const configuree = Number.isInteger(jours);

  if (!configuree || !echeance) {
    return {
      state: GRACE_STATE.UNCONFIGURED,
      label: GRACE_LABELS.UNCONFIGURED,
      graceDaysSnapshot: configuree ? jours : null,
      graceDeadlineAt: null,
      note: 'Aucun délai de grâce automatique n’est configuré pour cet incident. '
        + 'Le site ne sera pas suspendu automatiquement pour ce défaut.',
    };
  }

  const expiree = new Date(echeance).getTime() <= new Date(now).getTime();
  return {
    state: expiree ? GRACE_STATE.EXPIRED : GRACE_STATE.RUNNING,
    label: expiree ? GRACE_LABELS.EXPIRED : GRACE_LABELS.RUNNING,
    graceDaysSnapshot: jours,
    graceDeadlineAt: echeance,
    note: jours === 0
      ? 'Délai de grâce : 0 jour — suspension automatique possible dès l’échec '
        + 'selon l’état du cycle.'
      : null,
  };
}

/**
 * LA CAUSE FINANCIÈRE — demandée, appliquée, ou retirée.
 *
 * ══ LA DISTINCTION QUI PORTE TOUT LE LOT ═══════════════════════════════════
 *
 *   suspensionRequestedAt    le Panel a RÉCLAMÉ la fermeture
 *   suspensionConfirmedAt    le projet l'a réellement APPLIQUÉE
 *
 * Entre les deux il y a un projet qui peut être hors ligne. Afficher la
 * demande comme un fait ferait lire « site suspendu » à un client dont le
 * site répond encore parfaitement.
 *
 * Et la preuve d'application n'est JAMAIS `suspensionSource` : sous
 * maintenance, la cause dominante reste `TECHNICAL` alors que la nôtre est
 * bel et bien appliquée. C'est l'instantané `causes.paymentDefault` qui fait
 * foi — décidé par le moteur du projet, jamais recalculé ici.
 */
function describeCause(incident, causes) {
  const retiree = Boolean(incident.causeRemovalConfirmedAt)
    || (causes && causes.paymentDefault === false && Boolean(incident.suspensionRequestedAt));

  if (retiree) {
    return {
      state: CAUSE_STATE.REMOVED,
      label: CAUSE_LABELS.REMOVED,
      requestedAt: incident.suspensionRequestedAt ?? null,
      confirmedAt: incident.suspensionConfirmedAt ?? null,
      removalConfirmedAt: incident.causeRemovalConfirmedAt ?? null,
      appliedNow: false,
    };
  }

  if (incident.suspensionConfirmedAt) {
    return {
      state: CAUSE_STATE.APPLIED,
      label: CAUSE_LABELS.APPLIED,
      requestedAt: incident.suspensionRequestedAt ?? null,
      confirmedAt: incident.suspensionConfirmedAt,
      removalConfirmedAt: null,
      appliedNow: causes ? causes.paymentDefault === true : true,
    };
  }

  if (incident.suspensionRequestedAt) {
    return {
      state: CAUSE_STATE.REQUESTED,
      label: CAUSE_LABELS.REQUESTED,
      requestedAt: incident.suspensionRequestedAt,
      confirmedAt: null,
      removalConfirmedAt: null,
      appliedNow: false,
      note: 'La suspension a été demandée au site. Elle n’est pas encore confirmée '
        + 'par celui-ci.',
    };
  }

  return {
    state: CAUSE_STATE.NONE,
    label: CAUSE_LABELS.NONE,
    requestedAt: null,
    confirmedAt: null,
    removalConfirmedAt: null,
    appliedNow: false,
  };
}

/**
 * L'ACCESSIBILITÉ — reflétée, jamais calculée.
 *
 * La conjonction `!technical && contractHonoured && !paymentDefault` vit dans
 * `reconcileSiteStatus()` côté projet, et NULLE PART ailleurs. Une seconde
 * formule ici finirait par diverger de la première, et l'écran annoncerait un
 * site fermé qui répond, ou l'inverse.
 *
 * Sans instantané, on répond `UNKNOWN`. Une absence de donnée n'est pas une
 * affirmation métier : « je ne sais pas » n'est pas « le site va bien ».
 */
function describeSite(siteStatus) {
  if (!siteStatus || typeof siteStatus.accessible !== 'boolean') {
    return {
      state: SITE_STATE.UNKNOWN,
      label: SITE_LABELS.UNKNOWN,
      accessible: null,
      otherCauses: [],
      note: 'Le site n’a pas encore publié son état. Aucune conclusion n’en est tirée.',
    };
  }

  const causes = siteStatus.causes ?? null;
  const autres = [];
  if (causes) {
    if (causes.technical === true) autres.push({ key: 'technical', label: OTHER_CAUSE_LABELS.technical });
    if (causes.contract === true) autres.push({ key: 'contract', label: OTHER_CAUSE_LABELS.contract });
  }

  return {
    state: siteStatus.accessible ? SITE_STATE.ACCESSIBLE : SITE_STATE.SUSPENDED,
    label: siteStatus.accessible ? SITE_LABELS.ACCESSIBLE : SITE_LABELS.SUSPENDED,
    accessible: siteStatus.accessible,
    /**
     * La cause DOMINANTE est une étiquette d'affichage, jamais une preuve.
     * Elle est publiée telle quelle pour que l'écran puisse expliquer ce que
     * le site affiche lui-même à ses visiteurs.
     */
    dominantSource: siteStatus.suspensionSource ?? null,
    otherCauses: autres,
    causesKnown: Boolean(causes),
  };
}

/* -------------------------------------------------------------------------- */
/*  POLITIQUE FIGÉE CONTRE POLITIQUE COURANTE                                 */
/* -------------------------------------------------------------------------- */

/**
 * L'incident a figé sa politique ; le contrat a pu changer depuis.
 *
 * On affiche les DEUX, et on dit laquelle s'applique. Recalculer l'incident
 * avec la politique courante ferait glisser une échéance déjà annoncée — et
 * fermerait un site à une date que personne n'a communiquée.
 */
export function describePolicyDrift({ graceDaysSnapshot, contractPaymentGraceDays }) {
  const fige = Number.isInteger(graceDaysSnapshot) ? graceDaysSnapshot : null;
  const courant = Number.isInteger(contractPaymentGraceDays) ? contractPaymentGraceDays : null;

  if (fige === courant) return { drifted: false, snapshot: fige, current: courant, note: null };

  return {
    drifted: true,
    snapshot: fige,
    current: courant,
    note: 'La modification s’appliquera aux prochains incidents. '
      + 'Le délai d’un incident déjà ouvert reste inchangé.',
  };
}

/* -------------------------------------------------------------------------- */
/*  POINT D'ENTRÉE                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Met un incident en mots, sur quatre dimensions indépendantes.
 *
 * @param {object}  incident     un `toPublicPaymentDefault`
 * @param {object}  [siteStatus] l'instantané publié par le projet, si connu
 * @param {Date|string} now      instant de référence, explicite
 * @param {number|null} [contractPaymentGraceDays] la politique COURANTE
 */
export function describeIncidentForDisplay(incident, {
  siteStatus = null, now = new Date(), contractPaymentGraceDays = undefined,
} = {}) {
  const payment = describePayment(incident);
  const grace = describeGrace(incident, now);
  const cause = describeCause(incident, siteStatus?.causes ?? null);
  const site = describeSite(siteStatus);

  const policy = contractPaymentGraceDays === undefined
    ? null
    : describePolicyDrift({
      graceDaysSnapshot: incident.graceDaysSnapshot,
      contractPaymentGraceDays,
    });

  /**
   * LE TITRE — une phrase, pas un verdict global.
   *
   * Il nomme la dimension la plus actionnable pour le lecteur, et n'efface
   * jamais les trois autres, qui restent affichées à côté de lui.
   */
  const headline = cause.state === CAUSE_STATE.APPLIED
    ? CAUSE_LABELS.APPLIED
    : cause.state === CAUSE_STATE.REQUESTED
      ? CAUSE_LABELS.REQUESTED
      : payment.state === PAYMENT_STATE.SETTLED
        ? PAYMENT_LABELS.SETTLED
        : grace.state === GRACE_STATE.EXPIRED
          ? GRACE_LABELS.EXPIRED
          : PAYMENT_LABELS.FAILED;

  return {
    paymentDefaultId: incident.paymentDefaultId,
    status: incident.status,
    reasonLabel: REASON_LABEL,
    headline,
    payment,
    grace,
    cause,
    site,
    policy,
    /**
     * PEUT-ON RETENTER ? — ce que l’écran a besoin de savoir pour décider
     * s’il affiche le bouton, et pourquoi il ne l’affiche pas.
     *
     * Ce n’est PAS la garde : celle-ci vit dans le service, et surtout dans
     * l’autorité Stripe qui relit la facture à l’instant du clic. Un écran
     * décide de ce qu’il montre ; il ne décide jamais de ce qui est permis.
     */
    retry: describeRetryEligibility(incident),
    /**
     * RÉFÉRENCES TECHNIQUES — derrière « Détails », jamais dans la lecture
     * courante. Un identifiant de fournisseur sert au support, pas au client.
     */
    technical: {
      paymentDefaultId: incident.paymentDefaultId,
      contractId: incident.contractId ?? null,
      invoiceId: incident.invoiceId ?? null,
      subscriptionId: incident.subscriptionId ?? null,
      paymentIntentId: incident.paymentIntentId ?? null,
      transactionId: incident.transactionId ?? null,
      lastFailureCode: incident.lastFailureCode ?? null,
      environment: incident.environment ?? null,
    },
  };
}

export default {
  describeIncidentForDisplay,
  describePolicyDrift,
  REASON_LABEL,
  PAYMENT_STATE,
  GRACE_STATE,
  CAUSE_STATE,
  SITE_STATE,
};import { describeRetryEligibility } from './paymentRetry.service.js';

