import { randomUUID } from 'node:crypto';

import ApiError from '../../../utils/ApiError.js';
import logger from '../../../utils/logger.js';
import PanelPaymentRequest, {
  PAYMENT_REQUEST_STATUS,
  PAYMENT_REQUEST_SOURCES,
  TERMINAL_STATUSES,
  canTransition,
  isPayable,
} from '../../../models/PanelPaymentRequest.model.js';
import { EVENT_TYPES } from '../../../models/PanelSupervision.model.js';
import { recordEvent } from '../../supervision/timeline.service.js';
import { getProjectOrThrow } from '../../registry/projectRegistry.service.js';
import { runtimeEnvironment } from '../../integratedApi/environment.js';
import {
  computeTax, isUsableTaxRate, normalizeCurrency, parseAmountToCents,
} from '../money.js';
import { PanelProjectContract } from '../../../models/PanelProjectProjection.model.js';

/**
 * LES DEMANDES DE PAIEMENT — réclamer, sans jamais constater (L10.5).
 *
 * ══ LA RÈGLE QUI TIENT TOUT LE LOT ══════════════════════════════════════════
 *
 * **CE MODULE N'ÉCRIT JAMAIS DANS LE LEDGER.** Pas une ligne, pas une
 * exception, pas « juste pour que l'écran soit à jour ».
 *
 * La tentation est pourtant naturelle : la demande passe `PAID`, on tient le
 * montant, le projet et la date — pourquoi ne pas créer le revenu ici ? Parce
 * que le webhook Stripe va le créer aussi, par la projection L10.3, et qu'on
 * aurait alors DEUX revenus pour un euro. C'est exactement le défaut que L10.3
 * a été écrit pour rendre impossible, et le contourner depuis un autre module
 * le réintroduirait par la porte de derrière.
 *
 * Le sens de la flèche est donc l'inverse de l'intuition :
 *
 *   Stripe → fait canonique → projection L10.3 → FinancialTransaction
 *                                     │
 *                                     └──► la demande APPREND qu'elle est payée
 *
 * La demande ne produit pas le revenu ; elle en reçoit l'identité.
 *
 * ══ L'AUTORITÉ DU MONTANT ══════════════════════════════════════════════════
 *
 * Elle est ICI, et nulle part ailleurs. Le projet n'envoie jamais de montant :
 * il désigne une demande, et le Panel lit le sien. C'est ce qui empêche un
 * navigateur de transformer 500 € en 5 € — voir `resolveServiceAmount()`.
 */

/** Bornes de saisie. Un intervalle de relance hors de là est une faute de frappe. */
export const REMINDER_INTERVAL_MIN_DAYS = 1;
export const REMINDER_INTERVAL_MAX_DAYS = 90;
export const DEFAULT_REMINDER_INTERVAL_DAYS = 7;

const nowIso = () => new Date().toISOString();
const JOUR_MS = 24 * 60 * 60 * 1000;

/* -------------------------------------------------------------------------- */
/*  ÉCRITURE                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * CRÉE une demande — et l'envoie, si c'est ce qu'on a demandé.
 *
 * ══ POURQUOI L'ENVOI EST UN PARAMÈTRE ET NON UNE SECONDE FONCTION ══════════
 *
 * L'écran n'a qu'un bouton : « Envoyer ». Le brouillon existe au modèle parce
 * qu'une machine d'état a besoin d'un point de départ, et parce qu'un envoi qui
 * échoue à mi-chemin doit laisser quelque chose derrière lui — pas parce qu'un
 * opérateur voudra un jour enregistrer sans envoyer.
 */
export async function createPaymentRequest(payload = {}, actor = {}) {
  const projet = await getProjectOrThrow(String(payload.projectId ?? '').trim());

  const label = requireLabel(payload.label);
  const netAmountCents = parseAmountToCents(payload.netAmount ?? payload.amount, 'montant HT');
  if (netAmountCents <= 0) {
    throw ApiError.badRequest(
      'PANEL_PAYMENT_REQUEST_AMOUNT_INVALID',
      'Le montant HT doit être strictement positif.',
    );
  }

  /**
   * LE SNAPSHOT FISCAL EST PRIS ICI, ET UNE SEULE FOIS.
   *
   * Le taux vient du contrat, par la projection. Un contrat qui n'en porte pas
   * fait REFUSER la création — jamais de repli à 20 %. Voir `resolveTaxRate`.
   */
  const taxRate = await resolveTaxRate(projet.projectId);
  const fiscal = computeTax({ netCents: netAmountCents, taxRate });

  const document = await PanelPaymentRequest.create({
    paymentRequestId: randomUUID(),
    projectId: projet.projectId,
    projectNameSnapshot: projet.projectName ?? null,
    label,
    description: String(payload.description ?? '').trim().slice(0, 2000),
    netAmountCents: fiscal.netCents,
    taxRate: fiscal.taxRate,
    taxAmountCents: fiscal.taxCents,
    grossAmountCents: fiscal.grossCents,
    currency: normalizeCurrency(payload.currency),
    status: PAYMENT_REQUEST_STATUS.DRAFT,
    source: PAYMENT_REQUEST_SOURCES.MANUAL,
    reminders: normalizeReminders(payload.reminders),
    createdBy: actor.email ?? null,
    history: [{ at: nowIso(), from: null, to: PAYMENT_REQUEST_STATUS.DRAFT, reason: 'CREATED', actor: actor.email ?? null }],
  });

  await trace(document, EVENT_TYPES.PAYMENT_REQUEST_CREATED, 'INFO',
    `Prestation « ${label} » créée : ${formatAmount(fiscal.netCents, document.currency)} HT `
    + `+ TVA ${fiscal.taxRate} % = ${formatAmount(fiscal.grossCents, document.currency)} TTC.`, actor);

  if (payload.send === false) return document;
  return sendPaymentRequest(document.paymentRequestId, actor);
}

/**
 * ENVOIE — la demande devient due, visible, et relançable.
 *
 * ══ L'ORDRE, ET CE QUI PEUT ÉCHOUER SANS TOUT ANNULER ═══════════════════════
 *
 *   1. l'ÉTAT bascule en base — c'est la créance, et elle doit survivre à tout ;
 *   2. le monde est FIGÉ ;
 *   3. les relances sont armées ;
 *   4. la projection part vers le projet   — best-effort, rattrapée ;
 *   5. l'e-mail part                       — best-effort, jamais bloquant.
 *
 * Les étapes 4 et 5 ne peuvent PAS annuler les trois premières. Un serveur SMTP
 * en panne ne doit pas faire disparaître une somme due : la créance existe,
 * l'opérateur la voit, le client la verra dès que la projection convergera, et
 * la relance suivante repartira. Perdre la créance parce qu'un e-mail n'est pas
 * parti serait échanger un incident visible contre un trou invisible.
 */
export async function sendPaymentRequest(paymentRequestId, actor = {}) {
  const document = await loadOrThrow(paymentRequestId);

  if (document.status === PAYMENT_REQUEST_STATUS.OPEN) return document;
  assertTransition(document, PAYMENT_REQUEST_STATUS.OPEN);

  document.status = PAYMENT_REQUEST_STATUS.OPEN;
  document.sentAt = new Date();
  /** Le monde est CONSTATÉ à l'envoi, jamais choisi. Il ne bougera plus. */
  document.environment = runtimeEnvironment();
  if (document.reminders?.enabled) {
    document.reminders.nextAt = new Date(Date.now() + intervalMs(document.reminders));
  }
  pushHistory(document, PAYMENT_REQUEST_STATUS.OPEN, 'SENT', actor);
  await document.save();

  await trace(document, EVENT_TYPES.PAYMENT_REQUEST_SENT, 'INFO',
    `Prestation « ${document.label} » envoyée au projet (${formatAmount(document.grossAmountCents, document.currency)} TTC).`,
    actor);

  /**
   * LES DEUX EFFETS DE BORD, ISOLÉS CHACUN DANS SON PROPRE FILET.
   *
   * Séparés, et non groupés dans un seul `try` : un échec de projection ne doit
   * pas empêcher l'e-mail, ni l'inverse. Ce sont deux promesses distinctes.
   */
  await publishToProject(document).catch((err) => {
    logger.warn(`[finance] projection de la demande ${document.paymentRequestId} impossible — ${err.message}. La convergence la reprendra.`);
  });
  await notifyCreated(document, actor).catch((err) => {
    logger.warn(`[finance] e-mail de prestation impossible — ${err.message}. La créance reste due et payable.`);
  });

  return document;
}

/**
 * ANNULE une demande non payée.
 *
 * ══ CE QUE CELA VEUT DIRE CHEZ STRIPE : RIEN, ET C'EST DÉMONTRABLE ══════════
 *
 * Une Checkout Session n'est pas une créance chez Stripe — c'est une INTENTION
 * de paiement, qui expire d'elle-même (24 h) et n'encaisse rien tant que le
 * client n'a pas payé. Il n'existe donc aucun acte fournisseur à émettre pour
 * annuler une demande : rien n'a été promis à Stripe qu'il faille défaire.
 *
 * Ce qui empêche réellement un paiement tardif n'est pas un appel à Stripe,
 * c'est notre propre refus : la session est retirée de la projection, le
 * bouton disparaît du Manager, et la passerelle refuse d'en rouvrir une (voir
 * `resolveServiceAmount`, qui exige un état payable).
 *
 * Reste le cas limite, et il est traité : un client qui aurait gardé l'onglet
 * Stripe ouvert peut encore payer. L'argent entre alors réellement — le nier
 * serait pire que l'accepter. Le webhook L10.3 projette le revenu, et la
 * demande passe `PAID` malgré l'annulation, avec la trace de l'incohérence.
 * Voir `markPaidFromFact()`.
 */
export async function cancelPaymentRequest(paymentRequestId, { reason = null } = {}, actor = {}) {
  const document = await loadOrThrow(paymentRequestId);

  if (document.status === PAYMENT_REQUEST_STATUS.CANCELED) return document;
  if (document.status === PAYMENT_REQUEST_STATUS.PAID) {
    throw ApiError.conflict(
      'PANEL_PAYMENT_REQUEST_ALREADY_PAID',
      'Cette prestation est payée : elle ne s’annule pas. Un remboursement se fait depuis le revenu correspondant.',
    );
  }
  assertTransition(document, PAYMENT_REQUEST_STATUS.CANCELED);

  document.status = PAYMENT_REQUEST_STATUS.CANCELED;
  document.canceledAt = new Date();
  document.canceledBy = actor.email ?? null;
  document.cancelReason = reason ? String(reason).trim().slice(0, 500) : null;
  /** Plus aucune relance : l'arrêt est un effet de l'état, pas une tâche. */
  document.reminders.nextAt = null;
  pushHistory(document, PAYMENT_REQUEST_STATUS.CANCELED, 'CANCELED', actor);
  await document.save();

  await trace(document, EVENT_TYPES.PAYMENT_REQUEST_CANCELED, 'WARNING',
    `Prestation « ${document.label} » annulée.`, actor);

  await publishToProject(document).catch(() => null);
  return document;
}

/* -------------------------------------------------------------------------- */
/*  L'AUTORITÉ DU MONTANT                                                     */
/* -------------------------------------------------------------------------- */

/**
 * QUE DOIT PAYER CE PROJET, POUR CETTE DEMANDE ?
 *
 * ══ LA FONCTION QUI FERME L'ATTAQUE PAR LA CHARGE UTILE ════════════════════
 *
 * Le projet envoie un identifiant de demande, JAMAIS un montant. C'est ici, et
 * seulement ici, que le chiffre est lu — dans le document du Panel. Un client
 * qui remplacerait `500` par `5` dans la requête ne modifierait rien : il n'y a
 * aucun montant dans la requête à modifier.
 *
 * Trois refus, et ils sont NOMMÉS séparément pour l'exploitant tout en rendant
 * au projet un message unique — un projet n'a pas à apprendre l'existence des
 * demandes des autres en comparant des messages d'erreur.
 *
 * @throws {Error} `code` porte le motif interne
 */
export async function resolveServiceAmount({ projectId, paymentRequestId }) {
  const refus = (code) => {
    const err = new Error('Aucune prestation à payer ne correspond à cette référence.');
    err.code = code;
    return err;
  };

  const document = await PanelPaymentRequest.findOne({ paymentRequestId }).lean();

  /** Inexistante et « pas à vous » se lisent PAREIL. Voir la doctrine L6.2A. */
  if (!document) throw refus('PAYMENT_REQUEST_UNKNOWN');
  if (document.projectId !== projectId) throw refus('PAYMENT_REQUEST_NOT_OWNED');

  if (!isPayable(document.status)) throw refus('PAYMENT_REQUEST_NOT_PAYABLE');

  /**
   * LE MONDE DOIT CONCORDER. Une demande de recette payée en production
   * encaisserait de l'argent réel pour un essai.
   */
  const monde = runtimeEnvironment();
  if (document.environment && document.environment !== monde) {
    throw refus('PAYMENT_REQUEST_ENVIRONMENT_MISMATCH');
  }

  return {
    paymentRequestId: document.paymentRequestId,
    label: document.label,
    description: document.description,
    /**
     * CE QUE STRIPE DÉBITERA — LE TTC, jamais le HT.
     *
     * Un client paie ce qu'il doit, taxe comprise. Rendre le HT ici aurait
     * débité 500 € pour une facture de 600 : la prestation s'afficherait
     * soldée, et il manquerait 100 € en banque à chaque fois.
     */
    amountCents: document.grossAmountCents,
    netAmountCents: document.netAmountCents,
    taxRate: document.taxRate,
    taxAmountCents: document.taxAmountCents,
    currency: document.currency,
    checkoutAttempt: document.checkoutAttempt ?? 0,
  };
}

/**
 * LE TAUX DE TVA APPLICABLE À CE PROJET — lu au contrat, jamais supposé.
 *
 * ══ POURQUOI UN REFUS PLUTÔT QU'UN REPLI ═══════════════════════════════════
 *
 * Il aurait été facile d'écrire `?? 20`. C'est le taux français, il l'est
 * depuis 2014, et la ligne aurait passé toute la recette.
 *
 * Elle aurait aussi facturé un taux que PERSONNE n'a décidé. Le jour où un
 * projet relève d'un autre régime — taux réduit, autoliquidation, client hors
 * UE — le Panel émettrait des factures fausses en silence, et l'erreur se
 * découvrirait à un contrôle fiscal plutôt qu'à l'écran.
 *
 * Un refus, lui, se voit immédiatement et se corrige en une minute : renseigner
 * le taux sur le contrat, côté projet, là où il a un sens. Le Panel ne détient
 * aucune fiscalité propre, et ce lot ne lui en donne pas.
 */
export async function resolveTaxRate(projectId) {
  const contrat = await PanelProjectContract.findOne({ projectId })
    .select('taxRate').lean();

  if (!contrat || !isUsableTaxRate(contrat.taxRate)) {
    throw ApiError.conflict(
      'PANEL_PAYMENT_REQUEST_TAX_RATE_UNKNOWN',
      'Le taux de TVA de ce projet n’est pas connu du Panel. Il vient du contrat : '
      + 'renseignez-le côté projet, puis réessayez. Aucun taux par défaut n’est appliqué.',
      { projectId },
    );
  }
  return contrat.taxRate;
}

/**
 * FIGE l'identité juridique du client de ce projet, à cet instant.
 *
 * Import DYNAMIQUE : le domaine financier ne doit pas tirer l'entreprise
 * cliente dans son graphe de chargement — c'est la même discipline que celle
 * qui garde le plan de contrôle Stripe hors du domaine financier.
 *
 * Rend `null` quand aucune entreprise n'est rattachée. Ce n'est pas un cas à
 * traiter ici : l'ouverture du paiement l'aura déjà refusée bien avant.
 */
async function figerIdentiteCliente(projectId) {
  const [{ resolveClientCompanyReadiness }, { buildClientLegalSnapshot }] = await Promise.all([
    import('../../clientCompany/clientCompanyReadiness.js'),
    import('../../clientCompany/clientLegalSnapshot.js'),
  ]);
  const verdict = await resolveClientCompanyReadiness({ projectId });
  return buildClientLegalSnapshot(verdict.company, { at: nowIso() });
}

/**
 * ENREGISTRE la session ouverte pour cette demande.
 *
 * Appelée après l'ouverture, jamais avant : ce qu'on note ici est un FAIT
 * fournisseur, pas une intention. L'intention, elle, est l'existence même de la
 * demande — écrite bien avant tout appel.
 */
export async function attachCheckoutSession({ paymentRequestId, checkoutSessionId, url }) {
  const document = await PanelPaymentRequest.findOne({ paymentRequestId });
  if (!document) return null;

  document.stripe.checkoutSessionId = checkoutSessionId ?? document.stripe.checkoutSessionId;
  document.stripe.checkoutUrl = url ?? document.stripe.checkoutUrl;

  /**
   * ── L'INSTANTANÉ LÉGAL, FIGÉ ICI ET UNE SEULE FOIS ────────────────────────
   *
   * C'est l'instant où la facture est décidée : la session part chez le
   * fournisseur avec une identité de client, et c'est celle-là que le document
   * portera. La figer maintenant rend la facture relisible dans dix ans, quelle
   * que soit la fiche du Panel entre-temps.
   *
   * `if (!document.clientLegal)` : une seconde tentative de paiement sur la
   * même prestation ne réécrit rien. Deux essais doivent porter la même
   * identité, sans quoi le mot « instantané » ne veut plus rien dire.
   *
   * Best-effort ASSUMÉ, comme le reste de cette fonction : la session EXISTE
   * déjà chez Stripe. Faire échouer l'enregistrement d'un paiement réellement
   * ouvert parce qu'on n'a pas su recopier une adresse ferait payer au client
   * une erreur d'écriture de notre côté. L'absence se verra — elle ne se
   * devinera pas.
   */
  if (!document.clientLegal) {
    const fige = await figerIdentiteCliente(document.projectId).catch((error) => {
      logger.warn(
        `[prestation] instantané légal non capturé pour ${document.paymentRequestId} : `
        + `${error?.message ?? 'erreur inconnue'}.`,
      );
      return null;
    });
    if (fige) document.clientLegal = fige;
  }

  /**
   * L'état ne recule JAMAIS. Une session ouverte sur une demande déjà payée —
   * possible si le webhook a doublé la réponse — ne doit pas la rouvrir.
   */
  if (canTransition(document.status, PAYMENT_REQUEST_STATUS.PAYMENT_PENDING)
    && document.status !== PAYMENT_REQUEST_STATUS.PAID) {
    document.status = PAYMENT_REQUEST_STATUS.PAYMENT_PENDING;
    pushHistory(document, PAYMENT_REQUEST_STATUS.PAYMENT_PENDING, 'CHECKOUT_OPENED', {});
  }
  await document.save();

  await trace(document, EVENT_TYPES.PAYMENT_REQUEST_PAYMENT_STARTED, 'INFO',
    `Paiement ouvert pour « ${document.label} ».`, {});

  await publishToProject(document).catch(() => null);
  return document;
}

/* -------------------------------------------------------------------------- */
/*  LA CONVERGENCE DEPUIS LE FAIT FOURNISSEUR                                 */
/* -------------------------------------------------------------------------- */

/**
 * LA DEMANDE APPREND QU'ELLE EST PAYÉE — depuis le fait, jamais depuis le web.
 *
 * ══ QUI APPELLE, ET POURQUOI CE SENS-LÀ ════════════════════════════════════
 *
 * La projection L10.3, une fois le revenu écrit. Pas le contrôleur de retour
 * `?success=true` : un navigateur n'est jamais une preuve de paiement — la
 * chaîne d'URL se tape à la main. Pas non plus le webhook directement : il
 * passe déjà par la projection, et lui donner un second consommateur ferait
 * deux chemins à maintenir en accord.
 *
 * ══ POURQUOI CETTE FONCTION N'ÉCRIT AUCUN REVENU ═══════════════════════════
 *
 * Parce qu'à l'instant où elle est appelée, il existe DÉJÀ — c'est lui qui
 * l'appelle. Elle en reçoit l'identité, et c'est tout ce dont l'écran a besoin
 * pour relier la prestation à la ligne du livret.
 *
 * Idempotente : rejouée sur une demande déjà payée, elle ne fait rien.
 *
 * @returns {Promise<object|null>} la demande, ou `null` si le fait n'en désigne aucune
 */
export async function markPaidFromFact({
  paymentRequestId = null, checkoutSessionId = null, paymentIntentId = null,
  transactionId = null, environment = null, invoiceDocument = null, paidAt = null,
}) {
  const critere = paymentRequestId ? { paymentRequestId }
    : checkoutSessionId ? { 'stripe.checkoutSessionId': checkoutSessionId }
      : paymentIntentId ? { 'stripe.paymentIntentId': paymentIntentId }
        : null;
  if (!critere) return null;

  const document = await PanelPaymentRequest.findOne(critere);
  if (!document) return null;

  /**
   * LE MONDE DOIT CONCORDER — un fait de recette ne solde pas une demande de
   * production, même si les identifiants se ressemblent.
   */
  if (environment && document.environment && document.environment !== environment) {
    logger.warn(
      `[finance] fait ${environment} présenté à la demande ${document.paymentRequestId} `
      + `(${document.environment}) : ignoré.`,
    );
    return null;
  }

  /** Ce qui s'enrichit même sur une demande déjà payée : les références. */
  if (paymentIntentId) document.stripe.paymentIntentId = paymentIntentId;
  if (checkoutSessionId) document.stripe.checkoutSessionId = checkoutSessionId;
  /**
   * CHAQUE RÉFÉRENCE DE FACTURE EST REPRISE INDÉPENDAMMENT.
   *
   * Elles l'étaient toutes sous condition de l'identifiant, et c'était un
   * défaut : un fait qui portait la page hébergée et le PDF sans porter l'`id`
   * ne transmettait RIEN, et la prestation s'affichait sans document alors que
   * Stripe en avait émis un. Trois champs, trois conditions.
   */
  if (invoiceDocument?.invoiceId) document.stripe.invoiceId = invoiceDocument.invoiceId;
  if (invoiceDocument?.hostedUrl) document.stripe.hostedInvoiceUrl = invoiceDocument.hostedUrl;
  if (invoiceDocument?.pdfUrl) document.stripe.invoicePdfUrl = invoiceDocument.pdfUrl;
  if (transactionId) document.transactionId = transactionId;

  if (document.status === PAYMENT_REQUEST_STATUS.PAID) {
    await document.save();
    await publishToProject(document).catch(() => null);
    return document;
  }

  /**
   * PAYÉE MALGRÉ UNE ANNULATION — le cas limite, et on ne le nie pas.
   *
   * Un client qui avait gardé l'onglet Stripe ouvert peut payer après une
   * annulation. L'argent est réellement arrivé : refuser de l'inscrire ferait
   * diverger le Panel de la banque. On l'inscrit, et on le SIGNALE fort — c'est
   * un incident commercial, pas un incident technique.
   */
  const annulee = document.status === PAYMENT_REQUEST_STATUS.CANCELED
    || document.status === PAYMENT_REQUEST_STATUS.EXPIRED;
  if (annulee) {
    logger.error(
      `[finance] PAIEMENT SUR UNE DEMANDE ${document.status} — ${document.paymentRequestId} `
      + `(projet ${document.projectId}). L'argent est arrivé : la demande passe PAYÉE.`,
    );
  }

  const precedent = document.status;
  document.status = PAYMENT_REQUEST_STATUS.PAID;
  document.paidAt = paidAt ? new Date(paidAt) : new Date();
  /** L'arrêt des relances est un EFFET de l'état, jamais une tâche à penser. */
  document.reminders.nextAt = null;
  pushHistory(document, PAYMENT_REQUEST_STATUS.PAID, annulee ? 'PAID_AFTER_CANCEL' : 'PAID', {});
  await document.save();

  await trace(document, EVENT_TYPES.PAYMENT_REQUEST_PAID, annulee ? 'WARNING' : 'INFO',
    annulee
      ? `Prestation « ${document.label} » payée alors qu'elle était ${precedent}.`
      : `Prestation « ${document.label} » payée (${formatAmount(document.grossAmountCents, document.currency)} TTC).`,
    {});

  await publishToProject(document).catch(() => null);
  return document;
}

/* -------------------------------------------------------------------------- */
/*  RELANCES                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * ENVOIE les relances dues — et pas une de plus.
 *
 * ══ LA COURSE QUE CETTE FONCTION FERME ═════════════════════════════════════
 *
 * L'ordonnanceur sélectionne une demande `OPEN` dont la relance est due. Entre
 * cette sélection et l'envoi, le webhook de paiement arrive et la passe `PAID`.
 * Sans précaution, le client reçoit « vous nous devez 500 € » cinq secondes
 * après avoir payé.
 *
 * La parade tient en une requête : la réservation est ATOMIQUE et RECONDITION-
 * NÉE sur l'état. `findOneAndUpdate` ne rend la demande que si elle est
 * TOUJOURS `OPEN` au moment où il écrit — et il avance `nextAt` dans le même
 * geste, ce qui empêche aussi deux instances d'envoyer la même relance.
 *
 * L'e-mail part donc APRÈS que l'état a été confirmé, pas avant.
 */
export async function sendDueReminders({ limit = 50, now = new Date() } = {}) {
  const dues = await PanelPaymentRequest.find({
    status: PAYMENT_REQUEST_STATUS.OPEN,
    'reminders.enabled': true,
    'reminders.nextAt': { $ne: null, $lte: now },
  }).sort({ 'reminders.nextAt': 1 }).limit(limit).select('paymentRequestId').lean();

  let sent = 0;
  for (const { paymentRequestId } of dues) {
    const reserve = await PanelPaymentRequest.findOneAndUpdate(
      {
        paymentRequestId,
        /** LA RECONDITION : payée entre-temps ⇒ aucune réservation, aucun envoi. */
        status: PAYMENT_REQUEST_STATUS.OPEN,
        'reminders.enabled': true,
        'reminders.nextAt': { $ne: null, $lte: now },
      },
      /**
       * MISE À JOUR PAR PIPELINE — pour que la PROCHAINE échéance se calcule
       * depuis l'intervalle du document, dans l'écriture même qui réserve.
       *
       * Un `$set` ordinaire ne sait pas lire `$reminders.intervalDays` ; il
       * aurait fallu réserver, relire, puis réécrire — et cette fenêtre entre
       * les deux écritures est exactement celle où une seconde instance
       * enverrait la même relance.
       */
      [{
        $set: {
          'reminders.lastSentAt': now,
          'reminders.nextAt': {
            $add: [
              now,
              { $multiply: [{ $ifNull: ['$reminders.intervalDays', DEFAULT_REMINDER_INTERVAL_DAYS] }, JOUR_MS] },
            ],
          },
          'reminders.count': { $add: [{ $ifNull: ['$reminders.count', 0] }, 1] },
          'reminders.lastError': null,
        },
      }],
      { new: true },
    );
    if (!reserve) continue;

    try {
      await notifyReminder(reserve);
      sent += 1;
      await trace(reserve, EVENT_TYPES.PAYMENT_REQUEST_REMINDER_SENT, 'INFO',
        `Relance n°${reserve.reminders.count} pour « ${reserve.label} ».`, {});
    } catch (err) {
      /**
       * L'ÉCHEC NE REMET RIEN EN FILE IMMÉDIATE, et c'est voulu. Une boîte
       * pleine ferait sinon repartir la relance à chaque tour d'ordonnanceur —
       * une tempête d'e-mails pour un incident qui ne se résout pas plus vite.
       */
      await PanelPaymentRequest.updateOne(
        { paymentRequestId },
        { $set: { 'reminders.lastError': String(err?.message ?? 'inconnu').slice(0, 300) } },
      );
      await trace(reserve, EVENT_TYPES.PAYMENT_REQUEST_REMINDER_FAILED, 'WARNING',
        `Relance impossible pour « ${reserve.label} » : ${err?.message ?? 'erreur inconnue'}.`, {});
    }
  }
  return { examined: dues.length, sent };
}

/* -------------------------------------------------------------------------- */
/*  LECTURE                                                                   */
/* -------------------------------------------------------------------------- */

export async function listPaymentRequests({ projectId = null, includeTerminal = true } = {}) {
  const filtre = {};
  if (projectId) filtre.projectId = projectId;
  if (!includeTerminal) filtre.status = { $nin: TERMINAL_STATUSES };

  const items = await PanelPaymentRequest.find(filtre).sort({ createdAt: -1 }).limit(500).lean();
  return items.map(toPublicPaymentRequest);
}

export async function getPaymentRequest(paymentRequestId) {
  const document = await loadOrThrow(paymentRequestId);
  return toPublicPaymentRequest(document.toObject());
}

/**
 * LA PROJECTION PUBLIQUE — ce que le Panel rend à ses propres écrans.
 *
 * Les identifiants Stripe y figurent : cet écran est celui d'un opérateur, et
 * il est le seul endroit où quelqu'un vient rapprocher une ligne du tableau de
 * bord Stripe. L'interface les range derrière un dépliant, elle ne les cache
 * pas — voir la projection destinée au PROJET, qui, elle, n'en porte aucun.
 */
export function toPublicPaymentRequest(document) {
  return {
    paymentRequestId: document.paymentRequestId,
    projectId: document.projectId,
    projectNameSnapshot: document.projectNameSnapshot ?? null,
    label: document.label,
    description: document.description ?? '',
    /** LE SNAPSHOT, tel qu'il a ete fige a la creation. Jamais recalcule. */
    netAmountCents: document.netAmountCents,
    taxRate: document.taxRate,
    taxAmountCents: document.taxAmountCents,
    grossAmountCents: document.grossAmountCents,
    currency: document.currency,
    /**
     * L'IDENTITÉ JURIDIQUE FIGÉE À L'OUVERTURE DU PAIEMENT.
     *
     * Rendue telle quelle, sans recomposition : c'est ce que la facture porte,
     * et un écran qui la relit doit voir ce que le document AFFIRME, pas ce que
     * la fiche dit aujourd'hui. `null` tant qu'aucun paiement n'a été ouvert —
     * la prestation est alors un brouillon, sans destinataire figé.
     */
    clientLegal: document.clientLegal ?? null,
    status: document.status,
    environment: document.environment ?? null,
    payable: isPayable(document.status),
    stripe: {
      checkoutSessionId: document.stripe?.checkoutSessionId ?? null,
      paymentIntentId: document.stripe?.paymentIntentId ?? null,
      invoiceId: document.stripe?.invoiceId ?? null,
      hostedInvoiceUrl: document.stripe?.hostedInvoiceUrl ?? null,
      invoicePdfUrl: document.stripe?.invoicePdfUrl ?? null,
    },
    transactionId: document.transactionId ?? null,
    reminders: {
      enabled: Boolean(document.reminders?.enabled),
      intervalDays: document.reminders?.intervalDays ?? DEFAULT_REMINDER_INTERVAL_DAYS,
      nextAt: document.reminders?.nextAt ?? null,
      lastSentAt: document.reminders?.lastSentAt ?? null,
      count: document.reminders?.count ?? 0,
      lastError: document.reminders?.lastError ?? null,
    },
    history: document.history ?? [],
    createdBy: document.createdBy ?? null,
    createdAt: document.createdAt,
    sentAt: document.sentAt ?? null,
    paidAt: document.paidAt ?? null,
    canceledAt: document.canceledAt ?? null,
    cancelReason: document.cancelReason ?? null,
  };
}

/**
 * LA PROJECTION DESTINÉE AU PROJET — volontairement PAUVRE.
 *
 * ══ CE QU'ELLE NE PORTE PAS, ET POURQUOI ═══════════════════════════════════
 *
 * Aucun identifiant Stripe, aucune URL de session, aucun historique, aucun
 * auteur. Le projet n'a pas besoin de savoir avec quel compte on encaisse, ni
 * qui a saisi la prestation, ni combien de relances sont parties. Lui donner
 * ces informations n'aiderait aucun écran et ferait fuiter l'organisation
 * interne de L.Y Solution dans une base qu'on ne contrôle pas.
 *
 * L'URL de paiement en particulier est ABSENTE : elle est périssable, et la
 * projeter ferait afficher un bouton qui mène à une session morte. Le Manager
 * la demande au moment du clic, et le Panel en ouvre une fraîche.
 */
export function toProjectProjection(document) {
  return {
    paymentRequestId: document.paymentRequestId,
    label: document.label,
    description: document.description ?? '',
    /**
     * LA VENTILATION TRAVERSE, et c'est necessaire : le client a le droit de
     * savoir ce qu'il paie en HT et combien de taxe s'y ajoute. C'est ce que
     * sa facture portera, et l'ecran doit dire la meme chose qu'elle.
     */
    netAmountCents: document.netAmountCents,
    taxRate: document.taxRate,
    taxAmountCents: document.taxAmountCents,
    grossAmountCents: document.grossAmountCents,
    currency: document.currency,
    status: document.status,
    payable: isPayable(document.status),
    /** Le document Stripe, s'il existe : le client a le droit de sa facture. */
    invoiceUrl: document.stripe?.hostedInvoiceUrl ?? null,
    invoicePdfUrl: document.stripe?.invoicePdfUrl ?? null,
    issuedAt: document.sentAt ?? document.createdAt ?? null,
    paidAt: document.paidAt ?? null,
  };
}

/* -------------------------------------------------------------------------- */
/*  INTERNES                                                                  */
/* -------------------------------------------------------------------------- */

async function loadOrThrow(paymentRequestId) {
  const document = await PanelPaymentRequest.findOne({ paymentRequestId });
  if (!document) {
    throw ApiError.notFound('PANEL_PAYMENT_REQUEST_NOT_FOUND', 'Prestation introuvable.');
  }
  return document;
}

function assertTransition(document, to) {
  if (!canTransition(document.status, to)) {
    throw ApiError.conflict(
      'PANEL_PAYMENT_REQUEST_TRANSITION_REFUSED',
      `Une prestation ${document.status} ne peut pas devenir ${to}.`,
      { from: document.status, to },
    );
  }
}

function pushHistory(document, to, reason, actor) {
  document.history.push({
    at: nowIso(),
    from: document.history.at(-1)?.to ?? null,
    to,
    reason,
    actor: actor?.email ?? null,
  });
  /** Bornée : au-delà de trente, c'est une boucle, pas un besoin. */
  if (document.history.length > 30) document.history = document.history.slice(-30);
}

function requireLabel(value) {
  const label = String(value ?? '').trim();
  if (!label) throw ApiError.badRequest('PANEL_PAYMENT_REQUEST_LABEL_REQUIRED', 'Un nom est requis.');
  if (label.length > 160) {
    throw ApiError.badRequest('PANEL_PAYMENT_REQUEST_LABEL_TOO_LONG', 'Le nom dépasse 160 caractères.');
  }
  return label;
}

function normalizeReminders(input) {
  const enabled = input?.enabled === true;
  if (!enabled) return { enabled: false, intervalDays: DEFAULT_REMINDER_INTERVAL_DAYS };

  const jours = Number(input?.intervalDays ?? DEFAULT_REMINDER_INTERVAL_DAYS);
  if (!Number.isInteger(jours) || jours < REMINDER_INTERVAL_MIN_DAYS || jours > REMINDER_INTERVAL_MAX_DAYS) {
    throw ApiError.badRequest(
      'PANEL_PAYMENT_REQUEST_REMINDER_INTERVAL_INVALID',
      `L'intervalle de relance doit être un nombre entier de jours entre ${REMINDER_INTERVAL_MIN_DAYS} et ${REMINDER_INTERVAL_MAX_DAYS}.`,
    );
  }
  return { enabled: true, intervalDays: jours };
}

const intervalDaysOf = (reminders) => {
  const jours = Number(reminders?.intervalDays);
  return Number.isInteger(jours) && jours > 0 ? jours : DEFAULT_REMINDER_INTERVAL_DAYS;
};
const intervalMs = (reminders) => intervalDaysOf(reminders) * JOUR_MS;

const formatAmount = (cents, currency) =>
  new Intl.NumberFormat('fr-FR', { style: 'currency', currency: currency || 'EUR' })
    .format(cents / 100);

/** La chronologie du projet. Un fait métier, jamais un événement Stripe brut. */
async function trace(document, type, severity, summary, actor) {
  await recordEvent({
    projectId: document.projectId,
    type,
    source: 'PANEL',
    severity,
    summary,
    data: {
      paymentRequestId: document.paymentRequestId,
      netAmountCents: document.netAmountCents,
      taxRate: document.taxRate,
      grossAmountCents: document.grossAmountCents,
      currency: document.currency,
      status: document.status,
      actor: actor?.email ?? null,
    },
  }).catch(() => null);
}

/**
 * LES DEUX EFFETS DE BORD, CHARGÉS À LA DEMANDE.
 *
 * Import dynamique pour la même raison que la jointure des justificatifs : ce
 * service ne doit pas tirer la passerelle de capacités et le pont dans son
 * graphe de dépendances au chargement. Il les appelle, il n'en dépend pas.
 */
async function publishToProject(document) {
  const { publishPaymentRequest } = await import('./paymentRequestProjection.js');
  return publishPaymentRequest(document);
}

async function notifyCreated(document, actor) {
  const { sendPaymentRequestEmail } = await import('./paymentRequestEmails.js');
  return sendPaymentRequestEmail(document, { kind: 'CREATED', actor });
}

async function notifyReminder(document) {
  const { sendPaymentRequestEmail } = await import('./paymentRequestEmails.js');
  return sendPaymentRequestEmail(document, { kind: 'REMINDER' });
}

export default {
  PAYMENT_REQUEST_STATUS,
  createPaymentRequest,
  sendPaymentRequest,
  cancelPaymentRequest,
  resolveServiceAmount,
  attachCheckoutSession,
  markPaidFromFact,
  sendDueReminders,
  listPaymentRequests,
  getPaymentRequest,
  toPublicPaymentRequest,
  toProjectProjection,
};
