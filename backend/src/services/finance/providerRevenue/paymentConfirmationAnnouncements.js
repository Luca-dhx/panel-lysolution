/**
 * L12 — « UN PROJET DU PARC A PAYÉ ». L'annonce aux exploitants du Panel.
 *
 * ══ LE DÉCLENCHEUR, ET POURQUOI CELUI-LÀ EXACTEMENT ═════════════════════════
 *
 * Le fait fournisseur vient de devenir PROJETÉ. Pas « la session a réussi »,
 * pas « le navigateur est revenu », pas « une redirection porte un
 * session_id » : le Panel a reçu un événement SIGNÉ, a prouvé l'appartenance
 * de la ressource par son registre de liens, et a écrit un mouvement au
 * registre financier. C'est le seul instant où l'on peut dire « ce projet a
 * payé » sans rien supposer.
 *
 * La conséquence tient en une phrase, et c'est celle qui compte : fermer
 * l'onglet Stripe avant la redirection ne change RIEN. L'annonce part quand
 * même, parce qu'elle ne dépend d'aucun navigateur.
 *
 * ══ POURQUOI ELLE EST ÉMISE PAR LE PANEL, ET NON PAR LE PROJET ══════════════
 *
 * Parce que son destinataire est un exploitant de L.Y Solution et que son sujet
 * est un CLIENT. Un projet qui l'émettrait parlerait de lui-même à quelqu'un
 * d'autre — et il faudrait lui confier la liste des comptes du Panel. La
 * confirmation AU CLIENT, elle, reste au projet : c'est lui qui a le contrat,
 * l'identité et l'espace de facturation. Deux messages, deux émetteurs, deux
 * publics, aucun recouvrement.
 *
 * ══ EXACTEMENT UNE FOIS, SANS PRIMITIVE NOUVELLE ════════════════════════════
 *
 * Deux verrous déjà éprouvés se superposent, et ce module n'en invente aucun :
 *
 *  1. LA PROJECTION. Un fait ne devient PROJETÉ qu'une fois — l'index unique
 *     `{provider, environment, objectType, objectId}` garantit qu'un règlement
 *     annoncé par quatre événements Stripe ne produit qu'un fait, donc qu'une
 *     entrée ici.
 *  2. L'ACTE D'ENVOI. `PanelCapabilityOperation` porte un index unique
 *     `(projectId, capability, operationId)`. Notre `operationId` dérive du
 *     MOUVEMENT et du DESTINATAIRE — jamais d'une horloge, jamais d'un
 *     compteur. Rejoué, il rend `ALREADY_SENT` sans rien réexpédier.
 *
 * ══ CE MODULE NE FAIT JAMAIS ÉCHOUER UN ENCAISSEMENT ════════════════════════
 *
 * Ni exception, ni retour d'erreur vers la projection. Un revenu correctement
 * écrit ne doit pas être perdu parce qu'un fournisseur d'e-mails était à terre.
 */
import logger from '../../../utils/logger.js';
import config from '../../../config/env.js';
import PanelUser from '../../../models/PanelUser.model.js';
import { PANEL_ROLES } from '../../auth/panelRoles.js';
import registryStore from '../../registry/registryStore.js';
import { resolveFrontendUrl } from '../../network/networkConfig.service.js';
import { invokeCapability } from '../../capabilities/capabilityGateway.service.js';
import { INVOCATION_SOURCES } from '../../capabilities/invocationContext.js';
import { CANONICAL_TYPES } from './stripeRevenueNormalizer.js';

const CAPABILITY = 'email.send_template';

export const PAYMENT_CONFIRMED_PANEL_TEMPLATE = 'PROJECT_PAYMENT_CONFIRMED_SUPER_ADMIN';

/** Le public de cette annonce. Un `operationId` par mouvement ET par destinataire. */
export const AUDIENCE = 'super-admin';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * L'IDENTITÉ DURABLE D'UN ENVOI — exportée pour que la recette la recalcule
 * plutôt que de la deviner.
 *
 * `pay-ok` nomme le FAIT (un encaissement confirmé) ; `transactionId` nomme le
 * MOUVEMENT ; l'index nomme le destinataire logique. Aucune horloge n'entre
 * dans cette clé : un `Date.now()` produirait un acte neuf à chaque passage, et
 * un rattrapage réexpédierait tout le parc.
 */
export function paymentConfirmationOperationId(transactionId, index = 0) {
  return `pay-ok-${transactionId}-${AUDIENCE}-${index}`.slice(0, 64);
}

/**
 * LES SUPER_ADMIN DU PANEL — recalculés à chaque envoi, jamais listés en dur.
 *
 * ══ POURQUOI SUPER_ADMIN, ET NON « TOUS LES COMPTES » ══════════════════════
 *
 * Parce que la question posée est « qui doit apprendre qu'un client du parc a
 * payé ». C'est une information de DIRECTION : le chiffre d'affaires, sa
 * répartition, le rythme des encaissements. Un compte ADMIN administre des
 * projets ; un compte DEV les répare. Ni l'un ni l'autre n'a à connaître le
 * revenu d'un client — et le leur envoyer par commodité serait une fuite qu'on
 * aurait choisie.
 *
 * ══ POURQUOI JAMAIS « LE PREMIER TROUVÉ » ══════════════════════════════════
 *
 * Un `findOne()` aurait fonctionné tant qu'il n'y a qu'un compte, et cessé
 * silencieusement le jour où un second arrive : le nouveau ne recevrait rien,
 * et personne ne s'en apercevrait. On envoie à TOUS ceux qui portent le rôle,
 * dédupliqués par adresse.
 *
 * `enabled: true` est vérifié : un compte désactivé n'est plus un destinataire,
 * et le champ existe réellement sur le modèle — ce n'est pas une notion
 * inventée ici.
 */
export async function resolvePanelSuperAdmins() {
  const comptes = await PanelUser
    .find({ role: PANEL_ROLES.SUPER_ADMIN, enabled: true })
    .select('email displayName')
    .lean();

  const vus = new Set();
  const sortie = [];
  for (const compte of comptes) {
    const email = String(compte?.email || '').trim().toLowerCase();
    if (!email || !EMAIL_RE.test(email)) continue;
    if (vus.has(email)) continue;
    vus.add(email);
    const name = String(compte?.displayName || '').trim();
    sortie.push(name ? { email, name } : { email });
  }
  return sortie;
}

/**
 * CE QUI A ÉTÉ PAYÉ, dit en français et sans nommer le fournisseur.
 *
 * Le type vient de la corroboration que le Panel a lui-même apposée sur la
 * session (`metadata.paymentType`), et à défaut de la nature de l'objet
 * canonique. Un abonnement se reconnaît à ce qu'il porte un abonnement ; un
 * paiement unique à ce qu'il n'en porte pas.
 */
export function describePaymentKind(fait) {
  const declare = String(fait?.corroboration?.paymentType || '').toUpperCase();
  if (declare === 'LAUNCH_FEE') return 'Frais de lancement';
  if (declare === 'SUBSCRIPTION') return 'Abonnement';
  if (fait?.corroboration?.paymentRequestId) return 'Prestation';
  if (fait?.corroboration?.subscriptionId) return 'Abonnement';
  if (fait?.objectType === CANONICAL_TYPES.INVOICE) return 'Facture';
  return 'Paiement';
}

/**
 * L'ADRESSE DU MOUVEMENT DANS LE PANEL — d'où la facture se télécharge.
 *
 * ══ POURQUOI PAS L'ADRESSE DU PDF CHEZ LE FOURNISSEUR ═══════════════════════
 *
 * Parce qu'elle est signée et périssable, et qu'un e-mail se relit des mois
 * plus tard. Le lien pointe donc vers l'écran des finances du Panel, qui sert
 * la copie archivée par une route contrôlée. C'est aussi la seule forme qui
 * respecte la politique d'accès : l'adresse du fournisseur, elle, ouvre le
 * document à quiconque la détient.
 *
 * `null` quand aucune adresse publique n'est résolue — l'annonce est alors
 * refusée plutôt qu'expédiée avec un bouton mort.
 */
async function transactionUrl(transactionId) {
  const { url } = await resolveFrontendUrl();
  if (!url) return null;
  return `${String(url).replace(/\/+$/, '')}/finances?transaction=${encodeURIComponent(transactionId)}`;
}

/**
 * UN ENVOI, et ce qu'on en retient.
 *
 * La distinction des deux issues d'échec appartient à la passerelle et n'est
 * pas redécidée ici : un refus franc est rejouable, un délai dépassé ne l'est
 * pas. On relaie `replaySafe`, on ne le recalcule pas.
 */
async function envoyer({ recipient, variables, operationId }) {
  try {
    const res = await invokeCapability({
      code: CAPABILITY,
      /**
       * `PANEL_SELF` — et c'est le cœur du choix de portée.
       *
       * Cette source construit un contexte SANS projet : la portée résolue est
       * donc `PANEL`, l'expéditeur est celui de L.Y Solution, et le modèle lu
       * est l'unique instance de portée plateforme. Passer par `PANEL_INTERNAL`
       * avec la fiche du projet aurait fait chercher une instance PROJET de ce
       * code — laquelle n'existe pas, ne doit pas exister, et dont l'absence se
       * serait manifestée par un refus incompréhensible.
       */
      source: INVOCATION_SOURCES.PANEL_SELF,
      payload: { templateRef: PAYMENT_CONFIRMED_PANEL_TEMPLATE, recipient, variables, operationId },
    });
    return { ok: true, status: res?.result?.status ?? 'ACCEPTED', operationId, recipient: recipient.email };
  } catch (err) {
    return {
      ok: false,
      operationId,
      recipient: recipient.email,
      errorCode: err?.code ?? 'UNKNOWN_ERROR',
      replaySafe: err?.replaySafe !== false,
    };
  }
}

/**
 * ANNONCE UN ENCAISSEMENT QUI VIENT D'ÊTRE PROJETÉ.
 *
 * NE LÈVE JAMAIS — voir l'en-tête. L'appelant est la projection, elle-même sur
 * le chemin d'un webhook.
 *
 * @param {object} args
 * @param {object} args.fait          le fait fournisseur, déjà projeté
 * @param {object} args.transaction   le mouvement écrit au registre
 * @returns {Promise<{attempted:number, sent:number, failed:number, reason?:string, results:object[]}>}
 */
export async function announcePaymentConfirmed({ fait, transaction } = {}) {
  const vide = { attempted: 0, sent: 0, failed: 0, results: [] };
  try {
    if (!fait || !transaction?.transactionId) return { ...vide, reason: 'NOTHING_TO_ANNOUNCE' };

    const destinataires = await resolvePanelSuperAdmins();
    if (destinataires.length === 0) {
      /**
       * AUCUN SUPER_ADMIN JOIGNABLE — un état, pas une erreur.
       *
       * Le revenu est écrit, le mouvement est lisible dans l'écran. On trace
       * l'absence pour qu'elle se voie, on ne la subit pas en silence.
       */
      logger.warn(
        `[finance] encaissement ${transaction.transactionId} non annoncé — `
        + 'aucun compte SUPER_ADMIN joignable. Le mouvement, lui, est écrit.',
      );
      return { ...vide, reason: 'NO_RECIPIENT' };
    }

    const lien = await transactionUrl(transaction.transactionId);
    if (!lien) {
      /**
       * SANS ADRESSE PUBLIQUE, ON N'ENVOIE PAS. Le modèle exige un lien de
       * mouvement, et le rendu le refuserait vide — ce qui est exactement le
       * comportement voulu : un bouton mort dans une notification interne
       * apprend à ignorer les notifications.
       */
      logger.warn(
        `[finance] encaissement ${transaction.transactionId} non annoncé — `
        + "aucune URL publique du Panel n'est résolue (Configuration système → Réseau).",
      );
      return { ...vide, reason: 'NO_PANEL_URL' };
    }

    const projet = await registryStore.getById(fait.projectId).catch(() => null);
    const nomProjet = projet?.projectName || projet?.name || transaction.projectNameSnapshot || fait.projectId;

    const variables = {
      'project.name': String(nomProjet),
      'project.id': String(fait.projectId),
      'payment.kind': describePaymentKind(fait),
      'payment.label': String(transaction.label || fait.label || 'Encaissement'),
      'payment.amountIncludingTax': {
        amount: Number(transaction.amountCents ?? fait.amountCents ?? 0),
        currency: String(transaction.currency || fait.currency || 'EUR'),
      },
      'payment.paidOn': new Date(transaction.effectiveDate ?? fait.occurredAt ?? Date.now()).toISOString(),
      /** Le monde du RUNTIME — jamais `livemode`, qui vient du corps reçu. */
      'payment.environment': config.env,
      'transaction.id': String(transaction.transactionId),
      'transaction.url': lien,
      /**
       * « aucune » plutôt qu'une chaîne vide : la variable est obligatoire, et
       * un paiement unique sans `invoice_creation` n'a réellement PAS de
       * facture. Le dire est une information ; l'omettre serait un trou.
       */
      'invoice.reference': fait.invoiceDocument?.number
        || fait.invoiceDocument?.invoiceId
        || 'aucune',
    };

    const resultats = [];
    for (const [index, recipient] of destinataires.entries()) {
      // eslint-disable-next-line no-await-in-loop
      resultats.push(await envoyer({
        recipient,
        variables,
        operationId: paymentConfirmationOperationId(transaction.transactionId, index),
      }));
    }

    const envoyes = resultats.filter((r) => r.ok).length;
    if (envoyes < resultats.length) {
      logger.warn(
        `[finance] annonce d'encaissement ${transaction.transactionId} — `
        + `${envoyes}/${resultats.length} expédiée(s). Le mouvement reste écrit.`,
      );
    }
    return {
      attempted: resultats.length,
      sent: envoyes,
      failed: resultats.length - envoyes,
      results: resultats,
    };
  } catch (err) {
    logger.error(
      `[finance] annonce d'encaissement impossible — ${err?.message ?? 'erreur inconnue'}. `
      + 'Le revenu, lui, est projeté.',
    );
    return { ...vide, reason: 'ANNOUNCE_FAILED' };
  }
}

export default {
  AUDIENCE,
  PAYMENT_CONFIRMED_PANEL_TEMPLATE,
  announcePaymentConfirmed,
  describePaymentKind,
  paymentConfirmationOperationId,
  resolvePanelSuperAdmins,
};
