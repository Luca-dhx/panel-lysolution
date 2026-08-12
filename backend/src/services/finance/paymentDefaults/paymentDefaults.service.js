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
 * LE DÉLAI DE GRÂCE PAR DÉFAUT DU PARC, EN JOURS.
 *
 * ══ POURQUOI UNE CONSTANTE ICI, ET NON UNE VARIABLE D'ENVIRONNEMENT ═════════
 *
 * `CONTRACT_PAYMENT_GRACE_DAYS` existe côté projet depuis longtemps et n'est LU
 * NULLE PART : une configuration morte que tout le monde croit active. La
 * reprendre aurait recréé deux autorités pour une seule question.
 *
 * Cette valeur-ci est un défaut de PARC, pas une configuration : elle s'applique
 * à un projet dont personne n'a encore décidé la politique. Elle est visible
 * dans le code, versionnée, et un projet qui veut autre chose le dit sur sa
 * fiche — voir `resolveGraceDays`.
 *
 * Sept jours : une semaine laisse passer un week-end et un renouvellement de
 * carte, ce qui couvre la quasi-totalité des impayés involontaires.
 */
export const DEFAULT_GRACE_DAYS = 7;
export const MAX_GRACE_DAYS = 90;

const JOUR_MS = 24 * 60 * 60 * 1000;
const nowIso = () => new Date().toISOString();

/**
 * COMBIEN DE GRÂCE POUR CE PROJET ?
 *
 * Lue sur la fiche du Panel, qui est l'autorité de la politique commerciale.
 * Absente, on retombe sur le défaut du parc — et c'est acceptable ICI, alors
 * que le taux de TVA de L10.5 refusait tout repli : une grâce trop généreuse
 * coûte quelques jours d'hébergement, un taux de TVA inventé produit une
 * facture fausse.
 */
export function resolveGraceDays(panelProject) {
  const configure = panelProject?.paymentPolicy?.graceDays;
  if (Number.isInteger(configure) && configure >= 0 && configure <= MAX_GRACE_DAYS) {
    return configure;
  }
  return DEFAULT_GRACE_DAYS;
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

    const graceDays = resolveGraceDays(panelProject);
    const echecLe = fait.failedAt ?? new Date();
    const paymentDefaultId = randomUUID();

    /**
     * `$setOnInsert` SUR TOUT CE QUI EST FIGÉ — la politique et l'échéance.
     *
     * Un second échec ne doit réécrire ni l'un ni l'autre : ce sont les termes
     * annoncés au client au moment où l'incident s'est ouvert.
     */
    await PanelPaymentDefault.updateOne(
      { environment, invoiceId },
      {
        $setOnInsert: {
          paymentDefaultId,
          projectId: fait.projectId,
          contractId: fait.contractId ?? null,
          subscriptionId: fait.subscriptionId ?? null,
          graceDaysSnapshot: graceDays,
          graceDeadlineAt: new Date(echecLe.getTime() + graceDays * JOUR_MS),
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

    const premier = incident.history?.length === 1;
    if (premier) {
      await trace(incident, EVENT_TYPES.PAYMENT_DEFAULT_OPENED, 'WARNING',
        `Prélèvement échoué — ${formatAmount(incident.amountDueCents, incident.currency)} dus. `
        + `Grâce de ${graceDays} jour(s), échéance le ${formatDate(incident.graceDeadlineAt)}.`);
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
    graceDeadlineAt: { $lte: now },
  }).sort({ graceDeadlineAt: 1 }).limit(limit).select('paymentDefaultId').lean();

  let expired = 0;
  for (const { paymentDefaultId } of echues) {
    const bascule = await PanelPaymentDefault.findOneAndUpdate(
      {
        paymentDefaultId,
        /** LA RECONDITION : payé entre-temps ⇒ aucune bascule, aucune demande. */
        status: PAYMENT_DEFAULT_STATUS.OPEN,
        graceDeadlineAt: { $lte: now },
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
 * REPUBLIE les causes vivantes d'un projet — le rattrapage explicite.
 *
 * Le canal garantit la livraison de ce qui a été ÉMIS, pas la présence de ce
 * qui existait avant que le projet n'écoute. Un projet réappairé doit retrouver
 * la cause qui ferme son site, sans quoi il se rouvrirait tout seul.
 */
export async function republishPaymentDefaultCauses(projectId) {
  const actifs = await PanelPaymentDefault.find({
    projectId,
    status: PAYMENT_DEFAULT_STATUS.GRACE_EXPIRED,
  }).lean();

  for (const incident of actifs) await publishCause(incident).catch(() => null);
  return { published: actifs.length };
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

  if (applique && ferme) {
    /**
     * CONFIRMATION DE FERMETURE — sur les incidents qui l'ont DEMANDÉE.
     *
     * `suspensionConfirmedAt: null` dans le filtre : la PREMIÈRE confirmation
     * fait foi. Un snapshot rejoué ne réécrit pas la date, sans quoi l'écran
     * afficherait une fermeture qui rajeunirait à chaque livraison.
     */
    const r = await PanelPaymentDefault.updateMany(
      {
        projectId,
        status: PAYMENT_DEFAULT_STATUS.GRACE_EXPIRED,
        suspensionRequestedAt: { $ne: null },
        suspensionConfirmedAt: null,
      },
      { $set: { suspensionConfirmedAt: vu } },
    );
    confirmed = r.modifiedCount ?? 0;
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
  }

  if (confirmed || removed) {
    logger.info(
      `[finance] état de site confirmé pour ${projectId} — `
      + `${confirmed} fermeture(s) confirmée(s), ${removed} cause(s) retirée(s) `
      + `(accessible=${snapshot.accessible}, paymentDefault=${applique}).`,
    );
  }
  return { confirmed, removed, reason: null };
}

/* -------------------------------------------------------------------------- */
/*  LECTURE                                                                   */
/* -------------------------------------------------------------------------- */

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
    suspensionRequestedAt: document.suspensionRequestedAt ?? null,
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
  DEFAULT_GRACE_DAYS,
  resolveGraceDays,
  recordInvoiceFailure,
  resolveInvoiceDefault,
  closeInvoiceDefault,
  expireDueGracePeriods,
  describePaymentDefaultCause,
  confirmFromSiteStatus,
  republishPaymentDefaultCauses,
  listPaymentDefaults,
  toPublicPaymentDefault,
};
