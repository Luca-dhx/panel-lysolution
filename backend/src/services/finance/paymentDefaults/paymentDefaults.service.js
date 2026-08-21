import { randomUUID } from 'node:crypto';

import logger from '../../../utils/logger.js';
import PanelPaymentDefault, {
  PAYMENT_DEFAULT_STATUS,
  demandsSuspension,
  isLive,
} from '../../../models/PanelPaymentDefault.model.js';
import { EVENT_TYPES } from '../../../models/PanelSupervision.model.js';
import { recordEvent } from '../../supervision/timeline.service.js';
import registryStore from '../../registry/registryStore.js';
import { PanelProjectContract } from '../../../models/PanelProjectProjection.model.js';

/**
 * LES DÉFAUTS DE PAIEMENT D'ABONNEMENT (L10.6).
 *
 * ══ CE QUE CE MODULE NE FAIT PAS, ET C'EST L'ESSENTIEL ══════════════════════
 *
 * Il ne déclenche AUCUNE tentative de collecte. Pas une, jamais, sous aucune
 * condition. Stripe est l'unique ordonnanceur des tentatives : il retente selon
 * les réglages de relance du compte, et publie lui-même la date de la suivante.
 *
 * Un `POST /v1/invoices/{id}/pay` émis depuis ici entrerait en course avec la
 * tentative que Stripe a déjà programmée sur la même facture — deux débits pour
 * un impayé. Aucune clé d'idempotence ne protège de cela : les deux actes
 * seraient distincts et tous deux légitimes du point de vue du fournisseur.
 *
 * Il ne suspend rien non plus. Il CONSTATE qu'une grâce a expiré ; c'est SB Auto
 * qui recalcule l'accessibilité de son site, parce que lui seul connaît les
 * autres causes en vigueur — une maintenance technique, un contrat éteint.
 *
 * ══ CE DONT IL EST BIEN AUTORITÉ ════════════════════════════════════════════
 *
 * Le DÉLAI DE GRÂCE. Combien de temps L.Y Solution laisse un client en défaut
 * avant de demander la fermeture. C'est une décision commerciale, Stripe n'en
 * sait rien, et le projet n'a pas à la prendre.
 *
 * ══ ET IL N'ÉCRIT JAMAIS AU LEDGER ══════════════════════════════════════════
 *
 * Un impayé n'est ni un coût ni un revenu : c'est l'ABSENCE d'un revenu, et une
 * absence ne s'inscrit pas. Le revenu naîtra du paiement réel, par L10.3, comme
 * tout encaissement Stripe. Voir la même règle en L10.5 pour les prestations.
 */

/**
 * LA BORNE HAUTE D'UNE POLITIQUE DE GRÂCE, EN JOURS.
 *
 * Un an. Au-delà, ce n'est plus une grâce mais une gratuité, et la valeur
 * trahit une faute de frappe plutôt qu'une intention commerciale.
 *
 * ══ IL N'EXISTE AUCUNE VALEUR PAR DÉFAUT, ET C'EST DÉLIBÉRÉ ════════════════
 *
 * Une première version portait ici `DEFAULT_GRACE_DAYS = 7`, lu sur la fiche du
 * projet. C'était le même défaut que `CONTRACT_PAYMENT_GRACE_DAYS` côté projet :
 * une valeur que personne n'a décidée, appliquée à tout le parc.
 *
 * Sept jours auraient fermé des sites à une date que nul n'a fixée. Zéro les
 * aurait fermés au premier prélèvement refusé. Les deux sont des décisions
 * commerciales, et aucune ne se déduit du code.
 *
 * La politique vit donc sur le CONTRAT, et son absence se lit « non
 * configurée » — jamais « zéro ».
 */
export const MAX_GRACE_DAYS = 365;

const JOUR_MS = 24 * 60 * 60 * 1000;
const nowIso = () => new Date().toISOString();

/**
 * QUELLE GRÂCE POUR CE PROJET ? — lue au CONTRAT, jamais supposée.
 *
 * ══ CE QUE SIGNIFIE `null`, ET CE QUE LE SYSTÈME EN FAIT ═══════════════════
 *
 * « Aucune politique n'a été fixée pour ce contrat. » Le Panel en tire la seule
 * conséquence sûre : il OUVRE l'incident, le suit, l'affiche — et ne le fera
 * JAMAIS expirer automatiquement. La fermeture du site reste une décision
 * humaine tant que personne n'a écrit de règle.
 *
 * C'est un comportement NON AUTOMATISÉ, pas un comportement permissif : la
 * dette reste parfaitement visible, elle cesse simplement de fermer un site
 * toute seule.
 *
 * @returns {Promise<number|null>} jours entiers, ou `null` si non configurée
 */
export async function resolveGraceDays(projectId) {
  const contrat = await PanelProjectContract.findOne({ projectId })
    .select('paymentGraceDays').lean();

  const jours = contrat?.paymentGraceDays;
  if (!Number.isInteger(jours) || jours < 0 || jours > MAX_GRACE_DAYS) return null;
  return jours;
}

/* -------------------------------------------------------------------------- */
/*  OBSERVATION DES FAITS STRIPE                                              */
/* -------------------------------------------------------------------------- */

/**
 * UN ÉCHEC DE PRÉLÈVEMENT — ouvre l'incident, ou l'enrichit.
 *
 * ══ POURQUOI LA MÊME FONCTION POUR LE PREMIER ET LE QUATRIÈME ÉCHEC ═════════
 *
 * Parce que Stripe n'en fait pas la différence, et nous non plus. Une facture
 * d'abonnement produit un `invoice.payment_failed` à CHAQUE tentative. Ils
 * décrivent le même impayé, et créer un incident par événement ferait croire à
 * quatre impayés là où il n'y en a qu'un.
 *
 * L'index unique `(environment, invoiceId)` tranche. Le premier échec insère et
 * FIGE l'échéance ; les suivants ne font qu'actualiser ce que Stripe raconte de
 * ses propres tentatives.
 *
 * ══ L'ÉCHÉANCE EST ANCRÉE SUR LE PREMIER ÉCHEC ══════════════════════════════
 *
 * Jamais sur le dernier. C'est le piège le plus naturel du lot : ancrer sur le
 * dernier échec ferait repousser la date à chaque tentative de Stripe, et la
 * grâce n'expirerait JAMAIS. Le site resterait ouvert indéfiniment sur un
 * impayé, sans que rien ne le signale.
 *
 * NE LÈVE JAMAIS : appelée depuis la réception d'un webhook, qui ne doit pas
 * répondre 500 — Stripe rejouerait en boucle.
 *
 * @param {object} fait  déjà normalisé, jamais la charge utile brute
 */
export async function recordInvoiceFailure(fait) {
  try {
    const { environment, invoiceId } = fait;
    if (!environment || !invoiceId) return { recorded: false, reason: 'MALFORMED' };

    const panelProject = fait.projectId ? await registryStore.getById(fait.projectId) : null;
    if (!panelProject) {
      /**
       * Un échec dont on ne sait pas à qui il appartient ne peut pas ouvrir
       * d'incident : on ne saurait ni quelle politique appliquer, ni quel site
       * fermer. Il est journalisé et abandonné — l'appartenance des faits
       * Stripe est résolue en amont, par le registre de liens (L6.2A).
       */
      logger.warn(
        `[finance] échec de prélèvement sans projet résolu — facture ${invoiceId} `
        + `(${environment}). Aucun incident ouvert.`,
      );
      return { recorded: false, reason: 'PROJECT_UNKNOWN' };
    }

    const graceDays = await resolveGraceDays(fait.projectId);
    const echecLe = fait.failedAt ?? new Date();
    const paymentDefaultId = randomUUID();

    /**
     * SANS POLITIQUE, PAS D'ÉCHÉANCE — donc aucune expiration automatique.
     *
     * L'incident existe quand même : la dette est réelle et doit se voir. Ce
     * qui n'existe pas, c'est la date à laquelle on fermerait le site — parce
     * que personne ne l'a fixée.
     */
    const echeance = graceDays === null
      ? null
      : new Date(echecLe.getTime() + graceDays * JOUR_MS);

    /**
     * `$setOnInsert` SUR TOUT CE QUI EST FIGÉ — la politique et l'échéance.
     *
     * Un second échec ne doit réécrire ni l'un ni l'autre : ce sont les termes
     * annoncés au client au moment où l'incident s'est ouvert.
     */
    /**
     * L'ÉCRITURE DIT ELLE-MÊME SI ELLE A OUVERT L'INCIDENT.
     *
     * ══ CE QUE LE COMPTE D'HISTORIQUE PRÉTENDAIT ═══════════════════════════
     *
     * L'ouverture se déduisait de `history.length === 1`. Or l'historique n'est
     * écrit qu'au `$setOnInsert` : les échecs suivants ne l'allongent pas. Sa
     * longueur restait donc 1 à la deuxième tentative, à la troisième, et à
     * chaque relivraison du même webhook.
     *
     * Conséquence mesurée sur l'environnement de recette : TROIS événements
     * `PAYMENT_DEFAULT_OPENED` pour un impayé qui ne s'est ouvert qu'une fois.
     * La chronologie du Panel annonçait trois ouvertures, et `opened` mentait
     * à tous ses appelants.
     *
     * `upsertedCount` est la seule réponse vraie : il vaut 1 quand ce document
     * vient d'être INSÉRÉ, et 0 quand il existait déjà. C'est atomique, ça ne
     * dépend d'aucune convention d'historique, et une course perdue (E11000)
     * rend `undefined` — donc pas d'ouverture, ce qui est exact : le gagnant
     * l'a tracée.
     */
    const ecriture = await PanelPaymentDefault.updateOne(
      { environment, invoiceId },
      {
        $setOnInsert: {
          paymentDefaultId,
          projectId: fait.projectId,
          contractId: fait.contractId ?? null,
          subscriptionId: fait.subscriptionId ?? null,
          graceDaysSnapshot: graceDays,
          graceDeadlineAt: echeance,
          firstFailedAt: echecLe,
          status: PAYMENT_DEFAULT_STATUS.OPEN,
          history: [{ at: nowIso(), from: null, to: PAYMENT_DEFAULT_STATUS.OPEN, reason: 'FIRST_FAILURE' }],
        },
        /**
         * CE QUI S'ACTUALISE À CHAQUE ÉCHEC — uniquement ce que STRIPE raconte
         * de ses propres tentatives. Aucun de ces champs ne pilote quoi que ce
         * soit : ils s'affichent.
         */
        $set: {
          lastFailedAt: echecLe,
          nextPaymentAttemptAt: fait.nextPaymentAttemptAt ?? null,
          attemptCount: Number.isInteger(fait.attemptCount) ? fait.attemptCount : 0,
          lastFailureCode: fait.failureCode ?? null,
          amountDueCents: Number.isInteger(fait.amountDueCents) ? fait.amountDueCents : 0,
          currency: fait.currency ?? 'EUR',
          invoiceNumber: fait.invoiceNumber ?? null,
          hostedInvoiceUrl: fait.hostedInvoiceUrl ?? null,
          invoicePdfUrl: fait.invoicePdfUrl ?? null,
          ...(fait.paymentIntentId ? { paymentIntentId: fait.paymentIntentId } : {}),
        },
      },
      { upsert: true },
    ).catch(async (err) => {
      /** Course perdue : un autre écrivain vient d'ouvrir le même incident. */
      if (err?.code !== 11000) throw err;
    });

    const incident = await PanelPaymentDefault.findOne({ environment, invoiceId }).lean();

    /**
     * ══ L'INCIDENT PART VERS LE PROJET DÈS LE PREMIER ÉCHEC (L10.6B-3) ═══════
     *
     * AVANT le filtre d'échec tardif ci-dessous, et c'est délibéré : le `$set`
     * plus haut a pu actualiser `attemptCount` et `nextPaymentAttemptAt` même
     * sur un incident déjà résolu. Publier l'état RELU garde le Manager
     * convergent sur ce que Stripe raconte, sans rien rouvrir — le `status`
     * publié reste celui de la base.
     *
     * Et c'est ici, et non à l'expiration, que le blocage de la passe
     * précédente se referme : jusque-là, le projet n'apprenait l'existence d'un
     * impayé qu'au moment où son site fermait. Le client découvrait donc
     * l'incident et la sanction dans le même écran, alors qu'il avait eu sept
     * jours pour l'éviter.
     */
    await publishIncidentBestEffort(incident, 'échec de prélèvement');

    /**
     * UN ÉCHEC TARDIF NE ROUVRE PAS UN INCIDENT RÉSOLU.
     *
     * Stripe livre dans le désordre : un `invoice.payment_failed` de la
     * troisième tentative peut arriver APRÈS le `invoice.paid` de la quatrième.
     * Rouvrir l'incident ferait fermer un site dont la facture est réglée.
     */
    if (!isLive(incident.status)) {
      logger.info(
        `[finance] échec tardif sur un incident ${incident.status} — `
        + `facture ${invoiceId} (${environment}). Ignoré.`,
      );
      return { recorded: true, paymentDefaultId: incident.paymentDefaultId, ignored: true };
    }

    const premier = ecriture?.upsertedCount === 1;
    if (premier) {
      await trace(incident, EVENT_TYPES.PAYMENT_DEFAULT_OPENED, 'WARNING',
        `Prélèvement échoué — ${formatAmount(incident.amountDueCents, incident.currency)} dus. `
        + (incident.graceDeadlineAt
          ? `Grâce de ${graceDays} jour(s), échéance le ${formatDate(incident.graceDeadlineAt)}.`
          : 'Aucun délai de grâce configuré sur le contrat : aucune suspension '
            + 'automatique ne sera demandée.'));
    }

    return { recorded: true, paymentDefaultId: incident.paymentDefaultId, opened: premier };
  } catch (err) {
    logger.error(`[finance] défaut de paiement non enregistré — ${err?.message ?? 'erreur inconnue'}.`);
    return { recorded: false, reason: 'FAILED' };
  }
}

/**
 * LA FACTURE EST PAYÉE — l'incident se résout, quoi qu'il fût devenu.
 *
 * ══ Y COMPRIS APRÈS EXPIRATION DE LA GRÂCE ═════════════════════════════════
 *
 * Un client qui régularise après la fermeture de son site doit voir son
 * incident résolu et la cause de suspension retirée. Refuser au motif que la
 * grâce est passée le laisserait fermé après avoir payé.
 *
 * ══ CE QUE CETTE FONCTION N'ÉCRIT PAS ══════════════════════════════════════
 *
 * Le revenu. Il naît du fait Stripe, par la projection L10.3 — l'incident en
 * APPREND l'identité, exactement comme une prestation de L10.5. L'écrire ici
 * produirait un second exemplaire au premier webhook.
 *
 * Et pas davantage l'état du site : retirer la cause est un SIGNAL vers SB Auto,
 * qui recalculera. Voir `describeSuspensionSignals`.
 *
 * Idempotente : rejouée sur un incident résolu, elle ne fait rien.
 */
export async function resolveInvoiceDefault({
  environment, invoiceId, transactionId = null, paidAt = null,
}) {
  if (!environment || !invoiceId) return null;

  const incident = await PanelPaymentDefault.findOne({ environment, invoiceId });
  if (!incident) return null;

  if (transactionId) incident.transactionId = transactionId;

  if (!isLive(incident.status)) {
    await incident.save();
    return incident;
  }

  const precedent = incident.status;
  const apresSuspension = precedent === PAYMENT_DEFAULT_STATUS.GRACE_EXPIRED;

  incident.status = PAYMENT_DEFAULT_STATUS.RESOLVED;
  incident.resolvedAt = paidAt ? new Date(paidAt) : new Date();
  incident.resolution = apresSuspension ? 'PAID_AFTER_GRACE' : 'PAID_WITHIN_GRACE';
  /**
   * L'ÉCHÉANCE N'A PLUS DE SENS. On ne l'efface pas — elle est l'histoire de
   * l'incident — mais l'ordonnanceur ne la verra plus : il ne lit que les
   * incidents VIVANTS.
   */
  incident.history.push({
    at: nowIso(), from: precedent, to: PAYMENT_DEFAULT_STATUS.RESOLVED,
    reason: incident.resolution,
  });
  if (incident.history.length > 30) incident.history = incident.history.slice(-30);
  await incident.save();

  await trace(incident, EVENT_TYPES.PAYMENT_DEFAULT_RESOLVED, 'INFO',
    apresSuspension
      ? `Impayé régularisé APRÈS l'échéance — la cause de suspension pour défaut de paiement est levée.`
      : `Impayé régularisé dans le délai de grâce.`);

  /**
   * LE RETRAIT DE LA CAUSE — et RIEN de plus.
   *
   * On n'envoie pas « réactive le site » : le projet recombinera ses causes et
   * décidera. Si une maintenance technique subsiste, il restera fermé, et c'est
   * la bonne réponse. Le Panel n'a jamais su, et n'a pas à savoir, ce qui
   * bloque un site en dehors de l'impayé qu'il suit.
   *
   * Émis même quand l'incident n'était encore qu'`OPEN` : il n'y avait alors
   * aucune cause active côté projet, et le retrait est un non-événement — ce
   * qui est exactement le comportement idempotent attendu.
   */
  await publishCause(incident).catch((err) => {
    logger.warn(
      `[finance] retrait de cause non émis pour ${incident.paymentDefaultId} — `
      + `${err?.message ?? 'erreur inconnue'}. Le rattrapage le reprendra.`,
    );
  });

  /**
   * ET L'INCIDENT RÉSOLU, POUR QUE LE CLIENT LE LISE (L10.6B-3).
   *
   * Le retrait de cause dit au MOTEUR de recalculer ; il ne dit rien à
   * l'écran du client. Sans cette seconde publication, la facturation du
   * Manager resterait bloquée sur « paiement en échec » alors que le
   * prélèvement est passé.
   *
   * `RESOLVED` ne dit PAS « site accessible » : si une maintenance technique
   * subsiste, le site reste fermé, et c'est `SiteStatus` — pas cet incident —
   * qui l'établit.
   */
  await publishIncidentBestEffort(incident, 'régularisation');

  return incident;
}

/**
 * L'ABONNEMENT S'ÉTEINT — l'incident se ferme SANS avoir été payé.
 *
 * Distinct de `RESOLVED`, et la nuance compte : personne n'a payé. Les confondre
 * ferait croire à une régularisation dans tout écran qui compte les résolutions.
 */
export async function closeInvoiceDefault({ environment, invoiceId, reason = 'SUBSCRIPTION_ENDED' }) {
  const incident = await PanelPaymentDefault.findOne({ environment, invoiceId });
  if (!incident || !isLive(incident.status)) return incident ?? null;

  const precedent = incident.status;
  incident.status = PAYMENT_DEFAULT_STATUS.CLOSED;
  incident.resolvedAt = new Date();
  incident.resolution = reason;
  incident.history.push({ at: nowIso(), from: precedent, to: PAYMENT_DEFAULT_STATUS.CLOSED, reason });
  await incident.save();

  /**
   * FERMÉ SANS PAIEMENT — et le client doit pouvoir le lire aussi.
   *
   * Distinct de `RESOLVED`, et la nuance voyage : personne n'a payé. Un écran
   * qui compterait les deux ensemble annoncerait une régularisation qui n'a
   * jamais eu lieu.
   */
  await publishIncidentBestEffort(incident.toObject(), 'clôture sans paiement');

  return incident;
}

/* -------------------------------------------------------------------------- */
/*  LA GRÂCE — la seule chose que le Panel ORDONNE                            */
/* -------------------------------------------------------------------------- */

/**
 * LES GRÂCES ÉCHUES BASCULENT — et pas une minute avant.
 *
 * ══ LA BORNE EST STRICTE, ET ELLE EST TESTÉE ═══════════════════════════════
 *
 *     échéance 08/08 10:00
 *     à 09:59  → rien
 *     à 10:00  → basculement
 *
 * Aucune notion de « fin de journée » : une grâce de sept jours ouverte à 10 h
 * expire à 10 h, pas à minuit. Arrondir à la journée offrirait jusqu'à quatorze
 * heures de service gratuit sans que personne ne l'ait décidé.
 *
 * ══ LA RÉSERVATION EST ATOMIQUE ════════════════════════════════════════════
 *
 * `findOneAndUpdate` reconditionné sur `status: OPEN` : huit ordonnanceurs
 * simultanés ne produisent qu'UN basculement, donc une seule demande de
 * suspension, donc une seule notification.
 *
 * Appelée par l'ordonnanceur financier existant — pas par un minuteur à elle.
 * L'échéance vit en base ; un redémarrage ne perd rien.
 */
export async function expireDueGracePeriods({ now = new Date(), limit = 100 } = {}) {
  const echues = await PanelPaymentDefault.find({
    status: PAYMENT_DEFAULT_STATUS.OPEN,
    /**
     * `$ne: null` EST LOAD-BEARING, et l'omettre serait catastrophique.
     *
     * En BSON, `null` précède les dates dans l'ordre de comparaison : un
     * `$lte: now` seul CAPTURERAIT les incidents sans échéance. Un contrat sans
     * politique de grâce verrait donc son site fermé au premier prélèvement
     * refusé — précisément la décision que personne n'a prise.
     */
    graceDeadlineAt: { $ne: null, $lte: now },
  }).sort({ graceDeadlineAt: 1 }).limit(limit).select('paymentDefaultId').lean();

  let expired = 0;
  for (const { paymentDefaultId } of echues) {
    const bascule = await PanelPaymentDefault.findOneAndUpdate(
      {
        paymentDefaultId,
        /** LA RECONDITION : payé entre-temps ⇒ aucune bascule, aucune demande. */
        status: PAYMENT_DEFAULT_STATUS.OPEN,
        graceDeadlineAt: { $ne: null, $lte: now },
      },
      {
        $set: {
          status: PAYMENT_DEFAULT_STATUS.GRACE_EXPIRED,
          suspensionRequestedAt: now,
        },
        $push: {
          history: {
            $each: [{
              at: nowIso(),
              from: PAYMENT_DEFAULT_STATUS.OPEN,
              to: PAYMENT_DEFAULT_STATUS.GRACE_EXPIRED,
              reason: 'GRACE_DEADLINE_REACHED',
            }],
            $slice: -30,
          },
        },
      },
      { new: true },
    );
    if (!bascule) continue;

    expired += 1;
    await trace(bascule, EVENT_TYPES.PAYMENT_DEFAULT_GRACE_EXPIRED, 'ERROR',
      `Délai de grâce écoulé sans paiement — ${formatAmount(bascule.amountDueCents, bascule.currency)} `
      + 'restent dus. La fermeture du site est demandée au projet.');

    /**
     * LA CAUSE PART VERS LE PROJET — après la bascule, jamais avant.
     *
     * L'ordre compte : la réservation atomique au-dessus est ce qui garantit
     * qu'un seul ordonnanceur bascule. Émettre avant elle enverrait autant de
     * causes que de workers, et le projet appliquerait huit fois la même chose.
     *
     * Best-effort : le journal du pont conserve l'écriture, et le rattrapage la
     * livrera. Un incident dont la cause n'a pas pu partir reste `GRACE_EXPIRED`
     * — la republication le reprendra.
     */
    await publishCause(bascule).catch((err) => {
      logger.warn(
        `[finance] cause de suspension non émise pour ${bascule.paymentDefaultId} — `
        + `${err?.message ?? 'erreur inconnue'}. Le rattrapage la reprendra.`,
      );
    });

    /**
     * ET L'INCIDENT, AVEC SA DEMANDE MAIS SANS SA CONFIRMATION (L10.6B-3).
     *
     * `suspensionRequestedAt` vient d'être écrite ; `suspensionConfirmedAt`
     * reste `null` jusqu'à ce que le projet publie son instantané. Le Manager
     * doit lire cet écart et écrire « suspension en cours d'application », pas
     * « site suspendu » — la fermeture n'est pas encore un fait, et le projet
     * peut parfaitement être hors ligne.
     */
    await publishIncidentBestEffort(bascule.toObject(), 'expiration de grâce');
  }

  if (expired) logger.warn(`[finance] ${expired} délai(s) de grâce échu(s).`);
  return { examined: echues.length, expired };
}

/* -------------------------------------------------------------------------- */
/*  LE SIGNAL VERS LE PROJET                                                  */
/* -------------------------------------------------------------------------- */

/**
 * PUBLIE LA CAUSE VERS LE PROJET (L10.6).
 *
 * ══ UNE CAUSE, JAMAIS UN ORDRE ═════════════════════════════════════════════
 *
 * La charge utile dit « le défaut de paiement est actif — ou ne l'est plus —
 * pour ce projet ». Elle ne dit jamais `SUSPENDED`, et c'est ce qui empêche le
 * second maître : le projet combine cette cause avec les siennes et tranche
 * seul, ce qui est son rôle.
 *
 * ══ L'IDENTITÉ QUI REND L'ÉMISSION IDEMPOTENTE ═════════════════════════════
 *
 * `entityId = paymentDefaultId`. Un incident, une entité, quel que soit le
 * nombre de fois qu'on la publie. Deux passages d'ordonnanceur, un push doublé,
 * un rattrapage après une absence : le projet reçoit le même état et
 * l'applicateur le remplace — aucun second effet.
 *
 * C'est aussi pour cela que le contenu est un ÉTAT COMPLET et non un delta. Un
 * « passe à actif » supposerait que le projet ait déjà la ligne et dans le bon
 * état ; deux livraisons dans le désordre le laisseraient incohérent sans que
 * personne ne le sache.
 *
 * ══ LE PROJET HORS LIGNE ═══════════════════════════════════════════════════
 *
 * `emitChange` journalise avant de livrer. Un projet éteint au moment de
 * l'expiration recevra la cause à son prochain `sync/pull`, par le MÊME
 * applicateur que la livraison directe — aucune règle métier dupliquée entre
 * les deux voies.
 *
 * NE LÈVE PAS : l'appelant est un chemin métier, et une cause non émise se
 * rattrape. Perdre la bascule parce qu'un projet est injoignable serait échanger
 * un incident visible contre un impayé silencieux.
 */
async function publishCause(incident) {
  const { emitChange } = await import('../../sync/syncCore.service.js');
  const actif = demandsSuspension(incident.status);

  await emitChange({
    entityType: 'PAYMENT_DEFAULT_CAUSE',
    /** L'INCIDENT est l'entité. Une identité stable pour toute sa vie. */
    entityId: incident.paymentDefaultId,
    /**
     * NOMMÉE, TOUJOURS. Une cause de suspension diffusée au parc apprendrait à
     * chaque projet que les autres ne paient pas.
     */
    audience: incident.projectId,
    payload: {
      paymentDefaultId: incident.paymentDefaultId,
      projectId: incident.projectId,
      contractId: incident.contractId ?? null,
      active: actif,
      /** Le motif EXACT du contrat de service. Jamais reformulé. */
      reason: 'Défaut de paiement',
      since: actif ? (incident.suspensionRequestedAt ?? incident.graceDeadlineAt) : null,
      amountDueCents: actif ? (incident.amountDueCents ?? 0) : 0,
      /** Contexte d'audit — le projet l'affiche, il n'en décide rien. */
      invoiceId: incident.invoiceId ?? null,
      invoiceNumber: incident.invoiceNumber ?? null,
      firstFailedAt: incident.firstFailedAt ?? null,
      graceDeadlineAt: incident.graceDeadlineAt ?? null,
      resolvedAt: actif ? null : (incident.resolvedAt ?? null),
    },
    modifiedAt: new Date(incident.updatedAt ?? Date.now()).toISOString(),
  });
}

/**
 * PUBLIE L'INCIDENT VERS LE PROJET (L10.6B-3).
 *
 * ══ POURQUOI UN SECOND TYPE, ET NON UN CHAMP DE PLUS SUR LA CAUSE ══════════
 *
 * `PAYMENT_DEFAULT_CAUSE.active` a une signification EXACTE, démontrable
 * depuis l'applicateur du projet : elle est écrite dans
 * `siteStatus.paymentDefault.active`, puis `reconcileSiteStatus()` en tire
 * l'accessibilité. C'est une ENTRÉE DE MOTEUR, pas une nouvelle.
 *
 * Faire porter l'incident par ce type-là menait donc à deux impasses, et il
 * n'y en avait pas de troisième :
 *
 *   `active: true` pendant la grâce   fermerait le site pendant la grâce.
 *                                     C'est exactement ce que la grâce existe
 *                                     pour empêcher.
 *
 *   `active: false` pendant la grâce  correct pour le moteur — mais
 *                                     l'applicateur de cause REMET À NÉANT
 *                                     tout le reste dans ce cas (`since: null`,
 *                                     `paymentDefaultId: null`,
 *                                     `amountDueCents: 0`). Le Manager
 *                                     recevrait l'incident et le perdrait dans
 *                                     la même écriture.
 *
 * Et une raison structurelle par-dessus : `SiteStatus` est un SINGLETON, avec
 * UN sous-document `paymentDefault`. Un projet peut avoir plusieurs incidents
 * successifs — deux périodes d'abonnement impayées sont deux factures, donc
 * deux incidents, et l'historique doit les distinguer. Un singleton ne peut pas
 * héberger une collection.
 *
 * D'où DEUX types, aux rôles disjoints et jamais interchangeables :
 *
 *   PAYMENT_DEFAULT_CAUSE      une ENTRÉE du moteur de suspension.
 *                              Émise quand la cause devient — ou cesse d'être —
 *                              applicable. Sa cible est le singleton.
 *
 *   PAYMENT_DEFAULT_INCIDENT   une OBSERVATION, en lecture seule.
 *                              Émise à CHAQUE évolution de l'incident, dès le
 *                              premier échec. Sa cible est une collection.
 *                              Elle ne touche jamais l'accessibilité.
 *
 * ══ `causeActive` N'EST PAS UNE SECONDE AUTORITÉ ═══════════════════════════
 *
 * L'incident transporte `causeActive` pour que l'écran puisse expliquer
 * pourquoi il montre — ou ne montre pas — une suspension. Il ne le transporte
 * PAS pour que quelqu'un s'en serve : l'accessibilité du site reste lue dans
 * `SiteStatus`, décidée par le moteur du projet. Un écran qui conclurait
 * « causeActive donc site fermé » se tromperait le jour où une maintenance
 * technique tomberait en même temps.
 *
 * ══ ÉTAT COMPLET, JAMAIS UN DELTA ══════════════════════════════════════════
 *
 * Comme la cause, et pour la même raison. Un « attemptCount + 1 » supposerait
 * que le projet ait déjà la ligne et dans le bon état ; deux livraisons
 * arrivées dans le désordre le laisseraient faux sans que personne ne le voie.
 * Ici chaque livraison porte l'incident ENTIER, et l'applicateur remplace.
 */
async function publishIncident(incident) {
  const { emitChange } = await import('../../sync/syncCore.service.js');

  await emitChange({
    entityType: 'PAYMENT_DEFAULT_INCIDENT',
    /** LA MÊME IDENTITÉ QUE LA CAUSE — un incident, une entité, pour sa vie. */
    entityId: incident.paymentDefaultId,
    /** NOMMÉE : un impayé diffusé au parc apprendrait à chacun celui des autres. */
    audience: incident.projectId,
    payload: {
      paymentDefaultId: incident.paymentDefaultId,
      projectId: incident.projectId,
      contractId: incident.contractId ?? null,
      invoiceId: incident.invoiceId ?? null,
      /**
       * CE QUE CE RÈGLEMENT PAIE — porté, plus déduit.
       *
       * Le projet nomme la prestation dans sa relance : « votre abonnement »
       * plutôt que « votre facture ». Sans cette identité il ne pouvait rien
       * affirmer et retombait sur un mot générique — juste, mais inutile au
       * client qui a plusieurs lignes chez nous.
       *
       * Aujourd'hui tout incident naît d'une facture d'abonnement (le
       * normalisateur écarte le reste). Transmettre l'identité plutôt que de
       * supposer ce fait évite que l'ouverture du périmètre transforme une
       * supposition juste en affirmation fausse.
       */
      subscriptionId: incident.subscriptionId ?? null,

      status: incident.status,

      // ── CE QUE STRIPE FAIT, ET QU'ON REGARDE ────────────────────────────
      /**
       * RECOPIÉ, JAMAIS ESTIMÉ. Le Manager affichera « prévue par Stripe »,
       * jamais « nous retenterons » : le Panel n'ordonnance aucune tentative,
       * et le laisser croire ferait attendre au client un geste que personne
       * ne fera.
       */
      attemptCount: incident.attemptCount ?? 0,
      nextPaymentAttemptAt: iso(incident.nextPaymentAttemptAt),
      firstFailedAt: iso(incident.firstFailedAt),
      lastFailedAt: iso(incident.lastFailedAt),

      // ── CE DONT LE PANEL EST AUTORITÉ ───────────────────────────────────
      /**
       * `null` TRAVERSE LE PONT COMME `null`, et surtout pas comme `0`.
       * Les deux sont des décisions opposées : aucune politique d'un côté,
       * aucune clémence de l'autre. Les confondre ferait promettre une
       * fermeture automatique là où il n'y en aura jamais.
       */
      graceDaysSnapshot: Number.isInteger(incident.graceDaysSnapshot)
        ? incident.graceDaysSnapshot
        : null,
      graceDeadlineAt: iso(incident.graceDeadlineAt),

      // ── CE QUI EST DÛ ───────────────────────────────────────────────────
      amountDueCents: incident.amountDueCents ?? 0,
      currency: incident.currency ?? 'EUR',
      invoiceNumber: incident.invoiceNumber ?? null,
      /** La facture du client lui appartient — adresses Stripe, jamais copie. */
      hostedInvoiceUrl: incident.hostedInvoiceUrl ?? null,
      invoicePdfUrl: incident.invoicePdfUrl ?? null,

      // ── LA SUSPENSION : DEMANDÉE, CONFIRMÉE, RETIRÉE ────────────────────
      /**
       * TROIS DATES, TROIS AFFIRMATIONS DIFFÉRENTES. Le Manager doit pouvoir
       * dire « suspension en cours d'application » sans jamais affirmer
       * « site suspendu » avant que le projet ne l'ait constaté lui-même.
       */
      suspensionRequestedAt: iso(incident.suspensionRequestedAt),
      suspensionConfirmedAt: iso(incident.suspensionConfirmedAt),
      causeRemovalConfirmedAt: iso(incident.causeRemovalConfirmedAt),

      resolvedAt: iso(incident.resolvedAt),
      resolution: incident.resolution ?? null,

      /**
       * OBSERVATION, PAS AUTORITÉ. Rigoureusement la même valeur que
       * `PAYMENT_DEFAULT_CAUSE.active` — dérivée de la même fonction, pour
       * qu'aucune des deux ne puisse dériver de l'autre.
       */
      causeActive: demandsSuspension(incident.status),
      reason: 'Défaut de paiement',
    },
    /**
     * L'HORLOGE DE L'ORDRE. C'est elle que l'applicateur du projet compare
     * pour refuser un retardataire : une livraison plus ancienne que l'état
     * déjà appliqué ne doit rien défaire.
     */
    modifiedAt: new Date(incident.updatedAt ?? Date.now()).toISOString(),
  });
}

/**
 * PUBLIE L'INCIDENT — sans jamais faire échouer le chemin métier.
 *
 * Un impayé enregistré vaut mieux qu'un impayé perdu parce que le projet était
 * injoignable : le journal du pont conserve l'écriture et le rattrapage la
 * livrera. C'est la même politique que pour la cause.
 */
async function publishIncidentBestEffort(incident, contexte) {
  if (!incident) return;
  await publishIncident(incident).catch((err) => {
    logger.warn(
      `[finance] projection d'incident non émise (${contexte}) pour `
      + `${incident.paymentDefaultId} — ${err?.message ?? 'erreur inconnue'}. `
      + 'Le rattrapage la reprendra.',
    );
  });
}

/** Une date en ISO, ou `null`. Jamais `undefined` : le pont sérialise en JSON. */
const iso = (valeur) => (valeur ? new Date(valeur).toISOString() : null);

/**
 * REPUBLIE les causes vivantes d'un projet — le rattrapage explicite.
 *
 * Le canal garantit la livraison de ce qui a été ÉMIS, pas la présence de ce
 * qui existait avant que le projet n'écoute. Un projet réappairé doit retrouver
 * la cause qui ferme son site, sans quoi il se rouvrirait tout seul.
 *
 * ══ ET LES INCIDENTS AVEC ═══════════════════════════════════════════════════
 *
 * Les causes republiées sont les `GRACE_EXPIRED` — celles qui ferment. Les
 * INCIDENTS republiés sont tous les VIVANTS, `OPEN` compris : un projet qui
 * revient pendant une grâce doit retrouver son incident, sinon son client
 * verrait un espace de facturation serein sur un prélèvement refusé.
 */
export async function republishPaymentDefaultCauses(projectId) {
  const actifs = await PanelPaymentDefault.find({
    projectId,
    status: PAYMENT_DEFAULT_STATUS.GRACE_EXPIRED,
  }).lean();

  for (const incident of actifs) await publishCause(incident).catch(() => null);

  const vivants = await PanelPaymentDefault.find({
    projectId,
    status: { $in: [PAYMENT_DEFAULT_STATUS.OPEN, PAYMENT_DEFAULT_STATUS.GRACE_EXPIRED] },
  }).lean();

  for (const incident of vivants) await publishIncidentBestEffort(incident, 'rattrapage');

  return { published: actifs.length, incidents: vivants.length };
}

/**
 * CE QUE LE PROJET DOIT SAVOIR — une CAUSE, jamais un état de site.
 *
 * ══ POURQUOI UNE CAUSE ET NON UN ORDRE ═════════════════════════════════════
 *
 * Le Panel n'a pas l'autorité sur l'accessibilité d'un site. Lui envoyer
 * `status: SUSPENDED` créerait un second maître : deux systèmes décideraient de
 * la même chose, et le jour où une maintenance technique serait en cours,
 * l'ordre du Panel la lèverait ou serait levé par elle — dans les deux cas, une
 * décision que personne n'a prise.
 *
 * Le Panel dit donc : « pour ce projet, la cause PAYMENT_DEFAULT est active ».
 * SB Auto l'ajoute à ses conditions et recalcule. Une maintenance technique
 * simultanée survit à la régularisation, parce qu'elle est une AUTRE condition.
 *
 * @returns {Promise<{active: boolean, reason: string, since: Date|null,
 *   paymentDefaultId: string|null, amountDueCents: number}>}
 */
export async function describePaymentDefaultCause(projectId, environment) {
  const bloquant = await PanelPaymentDefault.findOne({
    projectId,
    environment,
    status: PAYMENT_DEFAULT_STATUS.GRACE_EXPIRED,
  }).sort({ graceDeadlineAt: 1 }).lean();

  if (!bloquant) {
    return {
      active: false,
      /** LE MOTIF EXACT EXIGÉ PAR LE CDC, même à l'état inactif : un seul texte. */
      reason: 'Défaut de paiement',
      since: null,
      paymentDefaultId: null,
      amountDueCents: 0,
    };
  }
  return {
    active: true,
    reason: 'Défaut de paiement',
    since: bloquant.suspensionRequestedAt ?? bloquant.graceDeadlineAt,
    paymentDefaultId: bloquant.paymentDefaultId,
    amountDueCents: bloquant.amountDueCents,
  };
}

/* -------------------------------------------------------------------------- */
/*  LA BOUCLE DE CONFIRMATION                                                 */
/* -------------------------------------------------------------------------- */

/**
 * LE PROJET A PARLÉ — on confronte nos incidents à SON état réel (L10.6A).
 *
 * ══ POURQUOI `suspensionSource` NE PEUT PAS SERVIR DE PREUVE ═══════════════
 *
 *     technicalActive = true      →  accessible       = false
 *     paymentDefault  = true         suspensionSource = TECHNICAL
 *
 * Dans cet état, notre cause EST appliquée. Elle n'est simplement pas celle
 * qu'on affiche, parce que la maintenance prime. Conclure de
 * `suspensionSource !== 'PAYMENT_DEFAULT'` que le projet n'a pas pris notre
 * cause en compte serait faux — et ferait relancer indéfiniment une demande
 * déjà honorée.
 *
 * La preuve est donc `causes.paymentDefault`, et rien d'autre.
 *
 * ══ TROIS AFFIRMATIONS DISTINCTES, ET ON NE LES CONFOND PAS ════════════════
 *
 *   cause appliquée    `causes.paymentDefault === true`
 *   site fermé         `accessible === false`
 *   cause retirée      `causes.paymentDefault === false`
 *
 * La confirmation de SUSPENSION exige les deux premières. Le retrait n'exige
 * QUE la troisième : exiger `accessible === true` serait refuser de constater
 * un retrait parfaitement réel quand une maintenance subsiste.
 *
 * ══ UN SNAPSHOT SANS `causes` NE PROUVE RIEN ═══════════════════════════════
 *
 * Une projection antérieure à ce lot n'en porte pas. On refuse alors de
 * conclure plutôt que de supposer : `undefined` se lit « je ne sais pas », et
 * la confirmation attendra le snapshot suivant.
 *
 * @param {object} snapshot  la projection PROJECT_SITE_STATUS, telle que reçue
 */
export async function confirmFromSiteStatus({ projectId, snapshot }) {
  const causes = snapshot?.causes ?? null;
  if (!causes || typeof causes.paymentDefault !== 'boolean') {
    return { confirmed: 0, removed: 0, reason: 'NO_CAUSE_SNAPSHOT' };
  }

  const applique = causes.paymentDefault === true;
  const ferme = snapshot.accessible === false;
  /**
   * L'HORODATAGE DU SNAPSHOT, pour écarter un retardataire. Le pont porte déjà
   * `sourceModifiedAt` : on ne fabrique pas une seconde horloge.
   */
  const vu = snapshot.sourceModifiedAt ? new Date(snapshot.sourceModifiedAt) : new Date();

  let confirmed = 0;
  let removed = 0;
  /** Les incidents que CET appel vient de faire basculer — voir plus bas. */
  const confirmes = [];
  /** Ceux dont le RETRAIT vient d'être constaté — republiés eux aussi. */
  const retires = [];

  if (applique && ferme) {
    /**
     * CONFIRMATION DE FERMETURE — sur les incidents qui l'ont DEMANDÉE.
     *
     * `suspensionConfirmedAt: null` dans le filtre : la PREMIÈRE confirmation
     * fait foi. Un snapshot rejoué ne réécrit pas la date, sans quoi l'écran
     * afficherait une fermeture qui rajeunirait à chaque livraison.
     */
    /**
     * ══ POURQUOI UN `findOneAndUpdate` PAR INCIDENT, ET NON UN `updateMany` ═══
     *
     * L10.6A se contentait d'un compteur : il suffisait à dire « c'est
     * confirmé ». L10.6B-2 doit en plus savoir QUELS incidents viennent de
     * basculer, parce que chaque bascule produit une activité et des
     * notifications qui doivent partir EXACTEMENT UNE FOIS.
     *
     * Un `updateMany` rend `modifiedCount` — un nombre, pas des identités. En
     * relisant ensuite les incidents confirmés, on ne saurait pas distinguer
     * ceux que CET appel vient de faire basculer de ceux qu'un appel concurrent
     * (ou un snapshot rejoué une milliseconde plus tôt) avait déjà confirmés.
     * On enverrait alors deux fois le même e-mail.
     *
     * Ici, c'est l'écriture atomique qui arbitre : le filtre exige
     * `suspensionConfirmedAt: null`, donc UN SEUL appelant obtient le document
     * en retour. Celui qui l'obtient est celui qui a fait la transition, et
     * c'est lui — et lui seul — qui notifie.
     */
    const candidats = await PanelPaymentDefault.find({
      projectId,
      status: PAYMENT_DEFAULT_STATUS.GRACE_EXPIRED,
      suspensionRequestedAt: { $ne: null },
      suspensionConfirmedAt: null,
    }).select('_id').lean();

    for (const { _id } of candidats) {
      // eslint-disable-next-line no-await-in-loop
      const gagne = await PanelPaymentDefault.findOneAndUpdate(
        { _id, suspensionConfirmedAt: null },
        { $set: { suspensionConfirmedAt: vu } },
        { new: true },
      ).lean();
      if (gagne) confirmes.push(gagne);
    }
    confirmed = confirmes.length;
  }

  if (!applique) {
    /**
     * CONFIRMATION DE RETRAIT — et surtout PAS de réactivation.
     *
     * On ne regarde pas `accessible` : une maintenance technique peut fort bien
     * maintenir le site fermé, et notre cause n'en est pas moins retirée.
     * Confondre les deux ferait attendre éternellement une réactivation qui ne
     * nous concerne pas.
     *
     * Restreint aux incidents RÉSOLUS : un incident encore `GRACE_EXPIRED` dont
     * la cause serait absente du snapshot décrit un projet qui ne l'a pas
     * encore appliquée, pas un retrait.
     */
    const aRetirer = await PanelPaymentDefault.find({
      projectId,
      status: PAYMENT_DEFAULT_STATUS.RESOLVED,
      suspensionRequestedAt: { $ne: null },
      causeRemovalConfirmedAt: null,
    }).select('_id').lean();

    const r = await PanelPaymentDefault.updateMany(
      {
        projectId,
        status: PAYMENT_DEFAULT_STATUS.RESOLVED,
        suspensionRequestedAt: { $ne: null },
        causeRemovalConfirmedAt: null,
      },
      { $set: { causeRemovalConfirmedAt: vu } },
    );
    removed = r.modifiedCount ?? 0;
    if (removed > 0) retires.push(...aRetirer.map((d) => d._id));
  }

  if (confirmed || removed) {
    logger.info(
      `[finance] état de site confirmé pour ${projectId} — `
      + `${confirmed} fermeture(s) confirmée(s), ${removed} cause(s) retirée(s) `
      + `(accessible=${snapshot.accessible}, paymentDefault=${applique}).`,
    );
  }

  /**
   * ══ LES EFFETS DE BORD DE LA CONFIRMATION (L10.6B-2) ═══════════════════════
   *
   * Activité d'exploitation et notifications. Ils sont ICI, et non chez
   * l'appelant, pour deux raisons :
   *
   *  · c'est le seul endroit qui connaisse la TRANSITION — la bascule que cet
   *    appel vient de gagner atomiquement, par opposition à un état déjà
   *    confirmé qu'un rejeu relirait ;
   *  · `confirmFromSiteStatus` est traversé par la livraison immédiate comme
   *    par le rattrapage hors ligne. Un seul chemin, donc un seul effet.
   *
   * `catch` global et délibéré : une notification est une CONSÉQUENCE de la
   * suspension, jamais une condition. Si l'annonce échoue, la fermeture reste
   * vraie, la confirmation reste écrite, et rien ne revient en arrière.
   */
  if (confirmes.length > 0) {
    const { announceConfirmedSuspensions } = await import('./paymentDefaultAnnouncements.js');
    await announceConfirmedSuspensions({ projectId, incidents: confirmes }).catch((err) => {
      logger.error(
        `[finance] annonce de suspension impossible pour ${projectId} — ${err?.message}. `
        + 'La suspension et sa confirmation restent acquises.',
      );
    });
  }

  /**
   * ══ LA BOUCLE SE REFERME — L'INCIDENT REPART, CONFIRMÉ (L10.6B-3) ══════════
   *
   * Le projet a publié son instantané ; le Panel vient d'y lire la preuve et
   * d'écrire `suspensionConfirmedAt` — ou `causeRemovalConfirmedAt`. Cette
   * date n'existe QUE côté Panel : sans cette republication, le Manager
   * garderait éternellement « suspension en cours d'application » sur un site
   * fermé depuis une semaine.
   *
   * Elle est ici, avec les annonces, et pour la même raison : c'est le seul
   * endroit qui connaisse la TRANSITION, et il est traversé aussi bien par la
   * livraison immédiate que par le rattrapage hors ligne.
   *
   * Republier n'a AUCUN effet sur l'accessibilité — l'incident est une
   * observation. Le cycle ne peut donc pas s'entretenir lui-même : cette
   * écriture ne provoque aucun nouvel instantané de site.
   */
  const abasculer = [...confirmes.map((i) => i._id), ...retires];
  if (abasculer.length > 0) {
    const relus = await PanelPaymentDefault.find({ _id: { $in: abasculer } }).lean();
    for (const incident of relus) {
      // eslint-disable-next-line no-await-in-loop
      await publishIncidentBestEffort(incident, 'confirmation de site');
    }
  }

  return { confirmed, removed, reason: null, confirmedIncidents: confirmes };
}

/* -------------------------------------------------------------------------- */
/*  LECTURE                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * LES INCIDENTS D'UN PROJET, MIS EN MOTS POUR UN ÉCRAN (L10.6B-3).
 *
 * ══ POURQUOI LA TRADUCTION EST ICI ET NON DANS REACT ═══════════════════════
 *
 * Parce qu'une échéance de grâce reconstruite dans un navigateur depuis
 * `firstFailedAt + contrat.paymentGraceDays` afficherait la politique COURANTE
 * sur un incident qui en a figé une autre — et annoncerait au client une date
 * de fermeture que le moteur n'appliquera jamais. La règle du lot est simple :
 * l'écran REND une vérité, il ne la recrée pas.
 *
 * ══ UNE LECTURE, ET RIEN QU'UNE LECTURE ════════════════════════════════════
 *
 * Aucun appel fournisseur, aucun e-mail, aucune écriture. Ouvrir l'écran ne
 * doit RIEN déclencher : une page qui ordonnancerait en se rafraîchissant
 * ferait dépendre le métier de qui regarde, et à quelle fréquence.
 *
 * @param {string} projectId
 * @param {{now?: Date|string}} [options] instant de référence, explicite
 */
export async function describeProjectPaymentDefaults(projectId, { now = new Date() } = {}) {
  const { describeIncidentForDisplay } = await import('./paymentDefaultPresentation.js');
  const { PanelProjectSiteStatus } = await import(
    '../../../models/PanelProjectProjection.model.js'
  );

  const [documents, site, contrat] = await Promise.all([
    PanelPaymentDefault.find({ projectId }).sort({ firstFailedAt: -1 }).limit(100).lean(),
    /**
     * L'INSTANTANÉ DU PROJET — ou son ABSENCE, qui est une réponse aussi.
     * Sans lui, la présentation répond `UNKNOWN` sur l'accessibilité plutôt
     * que de supposer. « Je ne sais pas » n'est pas « le site va bien ».
     */
    PanelProjectSiteStatus.findOne({ projectId }).lean(),
    PanelProjectContract.findOne({ projectId }).select('paymentGraceDays').lean(),
  ]);

  /**
   * LA POLITIQUE COURANTE, passée à côté du snapshot et JAMAIS à sa place.
   * L'écran affichera les deux quand elles diffèrent — « incident : 7 jours,
   * contrat : 15 » — au lieu de recalculer une échéance déjà annoncée.
   */
  const politiqueCourante = Number.isInteger(contrat?.paymentGraceDays)
    ? contrat.paymentGraceDays
    : null;

  const items = documents.map((document) => {
    const incident = toPublicPaymentDefault(document);
    return {
      incident,
      display: describeIncidentForDisplay(incident, {
        siteStatus: site ?? null,
        now,
        contractPaymentGraceDays: politiqueCourante,
      }),
    };
  });

  /**
   * L'INCIDENT ACTIF — le premier VIVANT, le plus récent d'abord.
   *
   * Il est désigné par son identité de `PaymentDefault`, jamais par son
   * contrat : un même contrat peut porter plusieurs incidents successifs, et
   * les fusionner par `contractId` en effacerait un.
   */
  const actif = items.find((i) => isLive(i.incident.status)) ?? null;

  return {
    projectId,
    active: actif,
    items,
    /** L'état du site, tel que le projet l'a publié. `null` = jamais reçu. */
    siteStatusKnown: Boolean(site),
    contractPaymentGraceDays: politiqueCourante,
  };
}

export async function listPaymentDefaults({ projectId = null, liveOnly = false } = {}) {
  const filtre = {};
  if (projectId) filtre.projectId = projectId;
  if (liveOnly) {
    filtre.status = { $in: [PAYMENT_DEFAULT_STATUS.OPEN, PAYMENT_DEFAULT_STATUS.GRACE_EXPIRED] };
  }
  const items = await PanelPaymentDefault.find(filtre)
    .sort({ firstFailedAt: -1 }).limit(200).lean();
  return items.map(toPublicPaymentDefault);
}

/**
 * LA PROJECTION PUBLIQUE.
 *
 * `nextPaymentAttemptAt` est annoncée pour ce qu'elle est : la prochaine
 * tentative de STRIPE. L'écran ne doit jamais laisser croire que le Panel la
 * programme, ni qu'un opérateur peut l'avancer.
 */
export function toPublicPaymentDefault(document) {
  return {
    paymentDefaultId: document.paymentDefaultId,
    projectId: document.projectId,
    contractId: document.contractId ?? null,
    environment: document.environment,
    status: document.status,
    amountDueCents: document.amountDueCents ?? 0,
    currency: document.currency ?? 'EUR',
    invoiceNumber: document.invoiceNumber ?? null,
    hostedInvoiceUrl: document.hostedInvoiceUrl ?? null,
    invoicePdfUrl: document.invoicePdfUrl ?? null,
    firstFailedAt: document.firstFailedAt,
    lastFailedAt: document.lastFailedAt ?? null,
    /** Recopiée de Stripe. Le Panel ne l'a ni choisie ni programmée. */
    nextPaymentAttemptAt: document.nextPaymentAttemptAt ?? null,
    attemptCount: document.attemptCount ?? 0,
    graceDaysSnapshot: document.graceDaysSnapshot,
    graceDeadlineAt: document.graceDeadlineAt,
    /**
     * ══ LES TROIS DATES QUE L10.6B-3 A DÛ AJOUTER ═════════════════════════════
     *
     * La projection publique n'exposait que `suspensionRequestedAt`. Un écran
     * ne pouvait donc PAS distinguer « le Panel a réclamé la fermeture » de
     * « le site est réellement fermé » — et aurait affiché une suspension
     * comme un fait alors qu'elle n'était qu'une intention. C'est exactement
     * la confusion que L10.6A a passé un lot entier à supprimer côté moteur.
     *
     *   suspensionRequestedAt    l'INTENTION du Panel
     *   suspensionConfirmedAt    l'OBSERVATION du résultat côté projet
     *   causeRemovalConfirmedAt  notre cause a été retirée — pas « site rouvert »
     */
    suspensionRequestedAt: document.suspensionRequestedAt ?? null,
    suspensionConfirmedAt: document.suspensionConfirmedAt ?? null,
    causeRemovalConfirmedAt: document.causeRemovalConfirmedAt ?? null,
    /**
     * Références techniques. Réservées au volet « Détails » de l'écran : un
     * identifiant de fournisseur n'a rien à faire dans la lecture courante,
     * mais tout à faire dans un ticket de support.
     */
    invoiceId: document.invoiceId ?? null,
    subscriptionId: document.subscriptionId ?? null,
    paymentIntentId: document.paymentIntentId ?? null,
    lastFailureCode: document.lastFailureCode ?? null,
    resolvedAt: document.resolvedAt ?? null,
    resolution: document.resolution ?? null,
    transactionId: document.transactionId ?? null,
    demandsSuspension: demandsSuspension(document.status),
    history: document.history ?? [],
  };
}

/* -------------------------------------------------------------------------- */
/*  INTERNES                                                                  */
/* -------------------------------------------------------------------------- */

const formatAmount = (cents, currency) =>
  new Intl.NumberFormat('fr-FR', { style: 'currency', currency: currency || 'EUR' })
    .format((cents ?? 0) / 100);

const formatDate = (date) =>
  new Intl.DateTimeFormat('fr-FR', { dateStyle: 'long', timeStyle: 'short', timeZone: 'Europe/Paris' })
    .format(new Date(date));

/** La chronologie du projet — un fait métier, jamais un événement Stripe brut. */
async function trace(incident, type, severity, summary) {
  await recordEvent({
    projectId: incident.projectId,
    type,
    source: 'PANEL',
    severity,
    summary,
    data: {
      paymentDefaultId: incident.paymentDefaultId,
      invoiceNumber: incident.invoiceNumber ?? null,
      amountDueCents: incident.amountDueCents ?? 0,
      currency: incident.currency ?? 'EUR',
      graceDeadlineAt: incident.graceDeadlineAt,
      attemptCount: incident.attemptCount ?? 0,
    },
  }).catch(() => null);
}

export default {
  PAYMENT_DEFAULT_STATUS,
  MAX_GRACE_DAYS,
  resolveGraceDays,
  recordInvoiceFailure,
  resolveInvoiceDefault,
  closeInvoiceDefault,
  expireDueGracePeriods,
  describePaymentDefaultCause,
  confirmFromSiteStatus,
  republishPaymentDefaultCauses,
  listPaymentDefaults,
  describeProjectPaymentDefaults,
  toPublicPaymentDefault,
};
