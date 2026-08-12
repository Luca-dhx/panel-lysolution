import { randomUUID } from 'node:crypto';

import logger from '../../../utils/logger.js';
import registryStore from '../../registry/registryStore.js';
import {
  PanelProjectMember,
  PanelProjectPresentation,
} from '../../../models/PanelProjectProjection.model.js';
import { invokeCapability } from '../../capabilities/capabilityGateway.service.js';
import { INVOCATION_SOURCES } from '../../capabilities/invocationContext.js';

/**
 * LES MESSAGES D'UNE PRESTATION (L10.5).
 *
 * ══ AUCUN APPEL BREVO ICI, ET C'EST UNE FRONTIÈRE ══════════════════════════
 *
 * Pas de `/v3/smtp/email`, pas de clé, pas d'URL de fournisseur. L8.4C a
 * centralisé les envois métier derrière la capacité `email.send_template`, et
 * ce module s'en sert comme n'importe quel autre appelant : il apporte un code
 * de template, un destinataire et des variables.
 *
 * Rouvrir un chemin local ici aurait annulé tout ce que L8.4C a acquis — une
 * seule identité d'expéditeur, un seul journal de livraison, un seul endroit où
 * une clé existe. Et le jour d'un incident, c'est le chemin local qui aurait
 * servi, sans que rien ne le signale.
 *
 * ══ L'APPELANT EST LE PANEL, PAS LE PROJET ═════════════════════════════════
 *
 * `PANEL_INTERNAL`, comme le remboursement de L10.4 : c'est L.Y Solution qui
 * réclame son argent, le projet ne demande rien. La source ne relâche que
 * l'octroi — le reste (identité d'expéditeur, rendu, coffre, journal)
 * s'applique à l'identique.
 *
 * ══ UN ÉCHEC N'EST JAMAIS BLOQUANT ═════════════════════════════════════════
 *
 * Cette fonction LÈVE, et son appelant attrape. La créance, elle, est déjà
 * écrite : une boîte pleine ou un Brevo indisponible ne doit pas faire
 * disparaître une somme due. Le client la verra dans son espace de toute façon
 * — l'e-mail prévient, il ne facture pas.
 */

const CAPABILITY = 'email.send_template';

const TEMPLATES = Object.freeze({
  CREATED: 'PAYMENT_REQUEST_CREATED',
  REMINDER: 'PAYMENT_REQUEST_REMINDER',
});

/**
 * À QUI ÉCRIT-ON ? — aux ADMIN du projet, et à personne d'autre.
 *
 * ══ POURQUOI PAS UNE ADRESSE SAISIE À LA MAIN ══════════════════════════════
 *
 * Parce qu'elle vieillirait. Les membres du projet sont PROJETÉS depuis le
 * projet lui-même et suivent ses changements : un gérant qui part cesse de
 * recevoir les factures sans que personne n'ait à y penser.
 *
 * ══ POURQUOI PAS LES DEV ═══════════════════════════════════════════════════
 *
 * Un compte DEV est un opérateur technique — souvent nous. Lui envoyer la
 * demande de paiement du client ferait partir la facture chez son émetteur.
 *
 * Repli : l'adresse de contact de la présentation commerciale, qui est celle
 * que le site publie. Si aucune des deux n'existe, on refuse d'inventer —
 * envoyer « au hasard » une somme due est pire que ne pas envoyer.
 */
export async function resolveRecipients(projectId) {
  const membres = await PanelProjectMember.find({ projectId, role: 'ADMIN' })
    .select('email name').lean();

  const destinataires = membres
    .filter((m) => typeof m.email === 'string' && m.email.includes('@'))
    .map((m) => ({ email: m.email.trim().toLowerCase(), name: m.name ?? undefined }));

  if (destinataires.length > 0) return destinataires;

  const presentation = await PanelProjectPresentation.findOne({ projectId })
    .select('contacts').lean();
  const secours = presentation?.contacts?.email;
  if (typeof secours === 'string' && secours.includes('@')) {
    return [{ email: secours.trim().toLowerCase() }];
  }
  return [];
}

/**
 * ENVOIE le message d'une prestation — création ou relance.
 *
 * @param {object} document  la demande, telle qu'en base
 * @param {{kind: 'CREATED'|'REMINDER'}} options
 * @throws {Error} si aucun destinataire, ou si la passerelle refuse
 */
export async function sendPaymentRequestEmail(document, { kind = 'CREATED' } = {}) {
  const brut = typeof document.toObject === 'function' ? document.toObject() : document;

  const panelProject = await registryStore.getById(brut.projectId);
  if (!panelProject) throw new Error(`Projet inconnu : ${brut.projectId}.`);

  const destinataires = await resolveRecipients(brut.projectId);
  if (destinataires.length === 0) {
    throw new Error('Aucune adresse ADMIN connue pour ce projet : rien n’a été envoyé.');
  }

  const variables = buildVariables(brut, panelProject);
  const templateRef = TEMPLATES[kind] ?? TEMPLATES.CREATED;

  /**
   * UN ENVOI PAR DESTINATAIRE, ET UNE IDENTITÉ D'ACTE PAR ENVOI.
   *
   * `email.send_template` est `UNKNOWN_ON_TIMEOUT` : Brevo n'offre aucune clé
   * d'idempotence, et c'est le registre d'opérations du Panel qui empêche le
   * doublon. Il lui faut donc une identité STABLE par message — celle-ci
   * dérive de la demande, du type de message et du numéro de relance.
   *
   * Conséquence voulue : rejouer la MÊME relance ne renvoie rien, tandis que
   * la relance suivante, qui porte un numéro différent, part normalement.
   */
  const identite = kind === 'REMINDER'
    ? `pr-reminder-${brut.paymentRequestId}-${brut.reminders?.count ?? 0}`
    : `pr-created-${brut.paymentRequestId}`;

  const echecs = [];
  for (const [index, destinataire] of destinataires.entries()) {
    try {
      await invokeCapability({
        code: CAPABILITY,
        panelProject,
        source: INVOCATION_SOURCES.PANEL_INTERNAL,
        payload: {
          templateRef,
          recipient: destinataire,
          variables,
          operationId: `${identite}-${index}`.slice(0, 64),
        },
      });
    } catch (err) {
      echecs.push(`${destinataire.email} : ${err?.message ?? 'erreur inconnue'}`);
    }
  }

  /**
   * UN SEUL destinataire joignable suffit à considérer le message passé. Les
   * autres échecs sont journalisés — ils intéressent l'exploitant, pas la
   * machine d'état de la créance.
   */
  if (echecs.length === destinataires.length) {
    throw new Error(echecs.join(' ; '));
  }
  if (echecs.length > 0) {
    logger.warn(`[finance] prestation ${brut.paymentRequestId} — envois partiels : ${echecs.join(' ; ')}`);
  }
  return { sent: destinataires.length - echecs.length, failed: echecs.length };
}

/**
 * LES VARIABLES DU TEMPLATE — formatées ICI, jamais dans le HTML.
 *
 * Un montant est un entier de centimes partout dans le parc (doctrine L10.1) ;
 * il ne devient « 500,00 € » qu'au moment de s'afficher. Laisser le template
 * faire la division rouvrirait le calcul monétaire en virgule flottante à
 * l'endroit le moins contrôlé du système.
 */
function buildVariables(document, panelProject) {
  const montant = new Intl.NumberFormat('fr-FR', {
    style: 'currency', currency: document.currency || 'EUR',
  }).format(document.grossAmountCents / 100);

  const emisLe = new Intl.DateTimeFormat('fr-FR', { dateStyle: 'long', timeZone: 'Europe/Paris' })
    .format(new Date(document.sentAt ?? document.createdAt ?? Date.now()));

  return {
    'company.name': panelProject.projectName ?? document.projectNameSnapshot ?? 'votre site',
    'payment.label': document.label,
    'payment.description': document.description ?? '',
    'payment.amount': montant,
    /**
     * LE LIEN MÈNE À L'ESPACE DU CLIENT, JAMAIS À STRIPE.
     *
     * Une URL de session Stripe expire en quelques heures : mise dans un
     * e-mail, elle serait morte avant la première relance. Le Manager, lui,
     * demande une session fraîche au moment du clic.
     */
    'payment.url': billingUrlOf(panelProject),
    'payment.issuedOn': emisLe,
    'developer.companyName': 'L.Y Solution',
  };
}

/**
 * L'adresse de l'espace de facturation du client.
 *
 * Le repli n'est pas un lien mort : l'adresse du Manager telle que le projet
 * l'a déclarée, sans le chemin. Mieux vaut envoyer quelqu'un sur sa page
 * d'accueil que sur une URL fabriquée qui n'existe peut-être pas.
 */
function billingUrlOf(panelProject) {
  const manager = panelProject?.network?.manager
    ?? panelProject?.publicBackendUrl
    ?? '';
  const base = String(manager).replace(/\/+$/, '');
  return base ? `${base}/factures` : '';
}

/** L'identité d'acte d'un envoi, exposée pour la recette. */
export const emailOperationId = (paymentRequestId, kind, count = 0) =>
  (kind === 'REMINDER'
    ? `pr-reminder-${paymentRequestId}-${count}`
    : `pr-created-${paymentRequestId}`);

export default { TEMPLATES, resolveRecipients, sendPaymentRequestEmail, emailOperationId };
