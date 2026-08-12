import logger from '../../../utils/logger.js';
import { emitChange } from '../../sync/syncCore.service.js';
import PanelPaymentRequest from '../../../models/PanelPaymentRequest.model.js';
import { toProjectProjection } from './paymentRequests.service.js';

/**
 * LA PRESTATION VUE PAR LE PROJET (L10.5).
 *
 * ══ POURQUOI AUCUN CANAL NEUF N'A ÉTÉ CRÉÉ ══════════════════════════════════
 *
 * Le Manager ne lit pas la base du Panel, et il ne l'interroge pas non plus par
 * HTTP à chaque affichage. Il lit SA propre base, alimentée par le canal de
 * synchronisation qui existe depuis la Phase 1 du pont — celui qui porte déjà
 * l'entreprise, la configuration des API et les retours de livraison d'e-mail.
 *
 * Trois choses viennent gratuitement avec ce choix, et chacune aurait coûté un
 * lot à réécrire :
 *
 *   · le JOURNAL — une livraison manquée se rattrape au `sync/pull` suivant,
 *     donc un projet éteint pendant un paiement converge à son retour ;
 *   · l'ACCUSÉ par écriture — le Panel sait ce qui a été appliqué, et ce qui
 *     ne l'a pas été ;
 *   · l'AUDIENCE — une écriture nommant son destinataire ne part qu'à lui.
 *
 * ══ CE QUI TRAVERSE, ET CE QUI RESTE ═══════════════════════════════════════
 *
 * `toProjectProjection` taille la charge utile : ni identifiant Stripe, ni URL
 * de session, ni historique, ni auteur. Le projet reçoit ce qu'il doit
 * AFFICHER — un nom, un montant, un état — et de quoi demander à payer.
 *
 * L'URL de paiement, en particulier, ne traverse jamais. Elle est périssable :
 * la projeter ferait afficher un bouton menant à une session morte. Le Manager
 * la demande au clic, et le Panel en ouvre — ou en retrouve — une.
 */

export const PAYMENT_REQUEST_ENTITY = 'PAYMENT_REQUEST';

/**
 * POUSSE l'état courant d'une demande vers son projet.
 *
 * ══ POURQUOI L'ÉTAT COMPLET, ET NON UN DELTA ═══════════════════════════════
 *
 * Une écriture qui dirait « passée à PAID » obligerait le projet à posséder
 * déjà la ligne, et à l'avoir dans le bon état. Deux livraisons arrivées dans
 * le désordre — ce qui arrive — le laisseraient incohérent sans qu'il le sache.
 *
 * L'état complet est IDEMPOTENT par construction : rejouer la même écriture ne
 * change rien, et une livraison manquée est réparée par la suivante.
 *
 * NE LÈVE PAS. L'appelant est un chemin métier — envoi, paiement, annulation —
 * et aucun d'eux ne doit échouer parce qu'un projet est injoignable. Le journal
 * garde l'écriture ; le rattrapage la livrera.
 */
export async function publishPaymentRequest(document) {
  const brut = typeof document.toObject === 'function' ? document.toObject() : document;

  try {
    await emitChange({
      entityType: PAYMENT_REQUEST_ENTITY,
      entityId: brut.paymentRequestId,
      /**
       * L'AUDIENCE EST NOMMÉE, TOUJOURS. Une prestation porte un montant dû par
       * UN client : la diffuser au parc apprendrait à chaque projet ce que les
       * autres paient.
       */
      audience: brut.projectId,
      payload: toProjectProjection(brut),
      modifiedAt: new Date(brut.updatedAt ?? Date.now()).toISOString(),
    });
  } catch (err) {
    logger.warn(
      `[finance] écriture de prestation non émise — ${brut.paymentRequestId} `
      + `(projet ${brut.projectId}) : ${err?.message ?? 'erreur inconnue'}.`,
    );
  }
}

/**
 * REPUBLIE les prestations d'un projet — le rattrapage explicite.
 *
 * ══ QUAND ELLE SERT ════════════════════════════════════════════════════════
 *
 * À l'appairage d'un projet, et après une restauration : le canal garantit la
 * livraison de ce qui a été ÉMIS, pas la présence de ce qui existait avant que
 * le projet n'écoute. Un client réappairé doit retrouver ses prestations dues.
 *
 * Bornée aux demandes VIVANTES et récentes. Republier dix ans d'historique
 * payé remplirait la base du projet d'informations qu'aucun écran ne montre.
 */
export async function republishPaymentRequests(projectId, { limit = 100 } = {}) {
  const items = await PanelPaymentRequest.find({ projectId })
    .sort({ createdAt: -1 }).limit(limit).lean();

  let published = 0;
  for (const item of items) {
    await publishPaymentRequest(item);
    published += 1;
  }
  return { published };
}

export default { PAYMENT_REQUEST_ENTITY, publishPaymentRequest, republishPaymentRequests };
