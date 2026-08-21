// L'E-MAIL DE TEST — la chaîne réelle, et rien qu'elle (R10.4).
//
// docs/architecture/BREVO_CONTROL_PLANE.md §« Test d'expéditeur ».
//
// ══ LA RÈGLE QUI DÉFINIT CE MODULE ══════════════════════════════════════════
//
//   Panel → modèle de test → email.send_template → coffre → Brevo
//         → providerMessageId → webhook → état de livraison
//
// Chaque flèche est la VRAIE. Aucun appel Brevo direct, aucun corps fabriqué à
// la main, aucun expéditeur passé en paramètre, aucune clé lue ici.
//
// ── POURQUOI C'EST LA SEULE FORME UTILE ─────────────────────────────────────
//
// Un diagnostic qui emprunte un chemin plus court ne teste pas ce qu'on lui
// demande : il teste son propre chemin. Un `GET /account` réussit avec une clé
// valide alors même que l'expéditeur n'est pas configuré, que le modèle est
// désactivé, que la capacité n'est pas migrée ou que l'ouverture commerciale
// refuse l'effet. Il rendrait « vert » quatre fois là où un envoi réel échoue —
// et c'est exactement le genre de vert qui fait déployer.
//
// ── CE QUE LE TEST DISTINGUE, ET POURQUOI CHAQUE ÉTAT COMPTE ────────────────
//
//   REFUSED    rien n'est parti, la cause est chez nous, un humain peut agir
//   UNKNOWN    le fournisseur n'a rien dit — l'envoi a PEUT-ÊTRE eu lieu
//   ACCEPTED   pris en charge, mais PAS arrivé : Brevo accepte puis rejette
//   DELIVERED  un webhook l'a confirmé — la seule preuve qui vaille
//   BOUNCED    un webhook a dit que ça n'arriverait pas
//
// Réduire cela à « ok / pas ok » ferait relancer un envoi INDÉCIDABLE, donc
// écrire deux fois à une personne réelle.
import crypto from 'node:crypto';

import ApiError from '../../utils/ApiError.js';
import logger from '../../utils/logger.js';
import { nowIso } from '../../bridge/bridgeContract.js';
import PanelEmailSenderTest, {
  SENDER_TEST_STATUS,
  SENDER_TEST_WEBHOOK_STATUS,
} from '../../models/PanelEmailSenderTest.model.js';
import { invokeCapability } from '../capabilities/capabilityGateway.service.js';
import { INVOCATION_SOURCES } from '../capabilities/invocationContext.js';
import { CAPABILITY_ERROR_CODES } from '../capabilities/capabilityErrors.js';
import { runtimeEnvironment } from '../integratedApi/environment.js';
import { resolveGlobalSender, describeGlobalSender } from './panelGlobalSender.service.js';
import { getActiveCompany } from '../company/company.service.js';

/** Le modèle emprunté. Un seul, et il vit dans le registre comme les autres. */
export const TEST_TEMPLATE_CODE = 'PANEL_EMAIL_SENDER_TEST';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Les refus qui laissent l'issue INDÉCIDABLE.
 *
 * `TIMEOUT` est le cas d'école : la requête a pu aboutir et seule la réponse se
 * perdre. Le ranger avec les refus certains ferait afficher « rien n'est
 * parti » à quelqu'un dont le message est peut-être déjà arrivé — et l'inviter
 * à recommencer.
 */
const INDECIDABLE = new Set([CAPABILITY_ERROR_CODES.TIMEOUT]);

/* -------------------------------------------------------------------------- */
/*  ENVOI                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Envoie un e-mail de test par la chaîne réelle.
 *
 * @param {{recipientEmail: string, actor?: object}} args
 * @returns {Promise<object>} le rapport complet — voir `describeTest`.
 */
export async function sendTestEmail({ recipientEmail, actor = {} } = {}) {
  const recipient = String(recipientEmail ?? '').trim().toLowerCase();
  if (!recipient || !EMAIL_RE.test(recipient)) {
    throw ApiError.badRequest(
      'PANEL_EMAIL_TEST_RECIPIENT_INVALID',
      'Destinataire illisible : indiquez une adresse à laquelle vous avez accès.',
    );
  }

  /**
   * L'EXPÉDITEUR EST RÉSOLU AVANT LA DEMANDE, ET C'EST DÉLIBÉRÉ.
   *
   * La capacité le résoudrait elle-même — c'est même ce qu'elle fera. Mais un
   * refus pour expéditeur manquant ressortirait alors en `NOT_AVAILABLE`, un
   * code que l'écran devrait deviner. Le résoudre ici rend le refus IMMÉDIAT et
   * NOMMÉ, sans avoir créé la moindre trace d'un envoi qui n'aura pas lieu.
   *
   * Ce n'est pas un contournement : la capacité refera exactement la même
   * résolution, et c'est SA valeur qui part. Celle-ci ne sert qu'à échouer tôt
   * et à figer ce que le rapport affichera.
   */
  const sender = await resolveGlobalSender();

  const environment = runtimeEnvironment();
  const testId = crypto.randomUUID();
  const requestedAt = nowIso();

  /**
   * LA DEMANDE DURABLE EXISTE AVANT L'APPEL — la règle des écritures répétables.
   *
   * Un processus tué entre l'acceptation par Brevo et l'écriture du résultat
   * laisse une trace `REQUESTED` : on saura qu'un envoi a peut-être eu lieu.
   * Créer le document APRÈS aurait effacé jusqu'à la question.
   */
  await PanelEmailSenderTest.create({
    testId,
    environment,
    recipientEmail: recipient,
    senderEmail: sender.senderEmail,
    senderName: sender.senderName,
    templateCode: TEST_TEMPLATE_CODE,
    provider: 'BREVO',
    status: SENDER_TEST_STATUS.REQUESTED,
    webhookStatus: SENDER_TEST_WEBHOOK_STATUS.NOT_APPLICABLE,
    requestedAt,
    requestedBy: actor.userId ?? null,
  });

  try {
    const outcome = await invokeCapability({
      code: 'email.send_template',
      /**
       * AUCUNE FICHE PROJET — et c'est le point entier de `PANEL_SELF`. Le
       * Panel écrit à ses propres exploitants ; lui prêter la fiche d'un client
       * ferait décider de cet envoi par l'ouverture commerciale et les octrois
       * d'un projet qui n'y est pour rien.
       */
      panelProject: null,
      source: INVOCATION_SOURCES.PANEL_SELF,
      payload: {
        templateRef: TEST_TEMPLATE_CODE,
        recipient: { email: recipient },
        variables: {
          'sender.name': sender.senderName,
          'sender.email': sender.senderEmail,
          'test.environment': environment,
          'test.requestedAt': requestedAt,
        },
        // `operationId` = `testId` : une seule identité pour un seul acte.
        operationId: testId,
      },
    });

    const providerMessageId = outcome?.result?.providerMessageId ?? null;
    await PanelEmailSenderTest.updateOne(
      { testId },
      {
        $set: {
          status: SENDER_TEST_STATUS.ACCEPTED,
          providerMessageId,
          acceptedAt: nowIso(),
          /**
           * Un retour n'est attendu QUE si le fournisseur nous a rendu un
           * identifiant de message : sans lui, aucun webhook ne pourra être
           * rattaché, et afficher « en attente » ferait patienter pour rien.
           */
          webhookStatus: providerMessageId
            ? SENDER_TEST_WEBHOOK_STATUS.PENDING
            : SENDER_TEST_WEBHOOK_STATUS.NOT_APPLICABLE,
          // L'expéditeur RÉELLEMENT utilisé, tel que la capacité l'a résolu.
          ...(outcome?.result?.sender
            ? {
              senderEmail: outcome.result.sender.email,
              senderName: outcome.result.sender.name,
            }
            : {}),
        },
      },
    );
    logger.info(`[email] test d’expédition ${testId} accepté par le fournisseur (${environment}).`);
  } catch (error) {
    const code = error?.code ?? 'UNEXPECTED';
    await PanelEmailSenderTest.updateOne(
      { testId },
      {
        $set: {
          status: INDECIDABLE.has(code) ? SENDER_TEST_STATUS.UNKNOWN : SENDER_TEST_STATUS.REFUSED,
          webhookStatus: SENDER_TEST_WEBHOOK_STATUS.NOT_APPLICABLE,
          errorCode: code,
          /**
           * NOTRE phrase, jamais celle du fournisseur. La sienne peut porter un
           * identifiant de compte ou une URL interne, et ce champ finit dans un
           * rapport que des humains se transmettent.
           */
          errorMessage: String(error?.message ?? '').slice(0, 500),
        },
      },
    );
    logger.warn(`[email] test d’expédition ${testId} non abouti — ${code}.`);
  }

  return describeTest(testId);
}

/* -------------------------------------------------------------------------- */
/*  RETOUR DE LIVRAISON                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Rattache un événement de livraison au test qui l'a produit.
 *
 * Appelé par l'aiguillage des webhooks quand l'opération corrélée appartient au
 * périmètre du Panel. NE LÈVE JAMAIS : un endpoint public qui lève produit une
 * 500, et une 500 fait rejouer le fournisseur en boucle.
 *
 * @returns {Promise<{applied: boolean, reason?: string}>}
 */
export async function applyDeliveryEvent({
  operationId, event, providerEvent = null, occurredAt = null, reason = null,
}) {
  try {
    const status = event === 'EMAIL_DELIVERED'
      ? SENDER_TEST_STATUS.DELIVERED
      : event === 'EMAIL_BOUNCED'
        ? SENDER_TEST_STATUS.BOUNCED
        : null;
    if (!status) return { applied: false, reason: 'EVENT_NOT_PROJECTED' };

    const result = await PanelEmailSenderTest.updateOne(
      { testId: operationId },
      {
        $set: {
          status,
          webhookStatus: SENDER_TEST_WEBHOOK_STATUS.RECEIVED,
          lastWebhookAt: occurredAt ?? nowIso(),
          lastWebhookEvent: providerEvent,
          lastWebhookReason: reason ? String(reason).slice(0, 200) : null,
        },
      },
    );
    if (result.matchedCount === 0) return { applied: false, reason: 'NO_MATCHING_TEST' };
    logger.info(`[email] test d’expédition ${operationId} : ${status} (webhook).`);
    return { applied: true };
  } catch (error) {
    logger.warn(`[email] retour de livraison non appliqué au test — ${error?.message ?? 'inconnu'}.`);
    return { applied: false, reason: 'APPLY_FAILED' };
  }
}

/* -------------------------------------------------------------------------- */
/*  LECTURE ET RAPPORT                                                        */
/* -------------------------------------------------------------------------- */

/** Le dernier test, ou `null`. Sert au rechargement de l'écran. */
export async function describeLastTest() {
  const last = await PanelEmailSenderTest.findOne({}).sort({ requestedAt: -1 }).lean();
  return last ? buildReport(last) : null;
}

/**
 * Un test précis — c'est ce que l'écran RELIT pour suivre l'arrivée du webhook,
 * sans jamais renvoyer le message.
 */
export async function describeTest(testId) {
  const stored = await PanelEmailSenderTest.findOne({ testId }).lean();
  if (!stored) {
    throw ApiError.notFound('PANEL_EMAIL_TEST_UNKNOWN', 'Aucun test d’expédition sous cet identifiant.');
  }
  return buildReport(stored);
}

/**
 * LE JOURNAL — une ligne par étape franchie, dans l'ordre de la chaîne.
 *
 * Il est DÉRIVÉ de l'état persisté, jamais accumulé pendant l'exécution : un
 * journal écrit au fil de l'eau serait perdu au rechargement de la page, et
 * l'écran afficherait alors moins d'informations en relisant qu'en envoyant.
 */
function buildJournal(stored) {
  const lignes = [];
  const parti = stored.status !== SENDER_TEST_STATUS.REFUSED
    && stored.status !== SENDER_TEST_STATUS.REQUESTED;

  lignes.push({
    state: 'PASS',
    label: 'Configuration résolue',
    detail: `${stored.senderName ?? '—'} <${stored.senderEmail ?? '—'}>`,
  });
  lignes.push({ state: 'PASS', label: 'Template résolu', detail: stored.templateCode });

  /**
   * Capacité, coffre et fournisseur ne sont pas journalisés séparément par la
   * passerelle : elle rend UN refus, avec le code de l'étape qui a refusé. On
   * déduit donc leur état de ce code plutôt que de prétendre les avoir observés
   * un par un — inventer trois lignes vertes qu'on n'a pas mesurées serait pire
   * que d'en montrer une seule qui dit vrai.
   */
  const refusAvantProvider = new Set([
    CAPABILITY_ERROR_CODES.NOT_AVAILABLE,
    CAPABILITY_ERROR_CODES.INPUT_INVALID,
    CAPABILITY_ERROR_CODES.CREDENTIALS_MISSING,
  ]);
  const code = stored.errorCode ?? null;

  lignes.push({
    state: code && refusAvantProvider.has(code) ? 'FAIL' : 'PASS',
    label: 'Capability autorisée',
    detail: code && refusAvantProvider.has(code) ? code : 'email.send_template',
  });
  lignes.push({
    state: code === CAPABILITY_ERROR_CODES.CREDENTIALS_MISSING ? 'FAIL' : 'PASS',
    label: 'Credential Brevo résolu côté Panel',
    detail: code === CAPABILITY_ERROR_CODES.CREDENTIALS_MISSING
      ? 'Aucun jeu d’identifiants exploitable'
      : 'Coffre du Panel',
  });
  lignes.push({
    state: parti ? 'PASS' : stored.status === SENDER_TEST_STATUS.UNKNOWN ? 'PENDING' : 'FAIL',
    label: 'Provider accepté',
    detail: stored.status === SENDER_TEST_STATUS.UNKNOWN
      ? 'Aucune réponse — issue indéterminée'
      : parti ? 'Message pris en charge' : (code ?? 'Refusé'),
  });
  lignes.push({
    state: stored.providerMessageId ? 'PASS' : parti ? 'FAIL' : 'PENDING',
    label: 'providerMessageId enregistré',
    detail: stored.providerMessageId ?? '—',
  });
  lignes.push({
    state: stored.webhookStatus === SENDER_TEST_WEBHOOK_STATUS.RECEIVED ? 'PASS' : 'PENDING',
    label: 'Webhook',
    detail: stored.webhookStatus === SENDER_TEST_WEBHOOK_STATUS.RECEIVED
      ? `${stored.lastWebhookEvent ?? 'reçu'} — ${stored.lastWebhookAt ?? ''}`.trim()
      : stored.webhookStatus === SENDER_TEST_WEBHOOK_STATUS.PENDING
        ? 'Attendu — actualisez pour vérifier'
        : 'Sans objet — rien n’est parti',
  });
  lignes.push({
    state: stored.status === SENDER_TEST_STATUS.DELIVERED ? 'PASS'
      : stored.status === SENDER_TEST_STATUS.BOUNCED ? 'FAIL' : 'PENDING',
    label: 'Livraison confirmée',
    detail: stored.status === SENDER_TEST_STATUS.DELIVERED ? 'Remis au destinataire'
      : stored.status === SENDER_TEST_STATUS.BOUNCED
        ? (stored.lastWebhookReason ?? 'Non remis')
        : 'Pas encore confirmée',
  });

  return lignes;
}

/**
 * LE RAPPORT COPIABLE — texte brut, sans secret, prêt pour un ticket.
 *
 * Il est construit ICI et non dans l'écran : un rapport assemblé côté navigateur
 * dépendrait de ce que l'écran a bien voulu recevoir, et deux versions du
 * Panel produiraient deux rapports différents pour le même incident.
 */
function buildPlainText(stored, journal) {
  const l = (label, value) => `${label.padEnd(22)}${value ?? '—'}`;
  return [
    '=== TEST D’EXPÉDITION — PANEL ===',
    l('status', stored.status),
    l('environment', stored.environment),
    l('recipient', stored.recipientEmail),
    l('sender name', stored.senderName),
    l('sender email', stored.senderEmail),
    l('template code', stored.templateCode),
    l('operationId', stored.testId),
    l('deliveryId', stored.testId),
    l('provider', stored.provider),
    l('providerMessageId', stored.providerMessageId),
    l('requested at', stored.requestedAt),
    l('accepted at', stored.acceptedAt),
    l('last webhook', stored.lastWebhookAt
      ? `${stored.lastWebhookAt} (${stored.lastWebhookEvent ?? '—'})`
      : null),
    l('delivery status', stored.status),
    l('webhook status', stored.webhookStatus),
    l('error code', stored.errorCode),
    l('error message', stored.errorMessage),
    '',
    '--- journal ---',
    ...journal.map((e) => `[${e.state}] ${e.label}${e.detail ? ` — ${e.detail}` : ''}`),
  ].join('\n');
}

function buildReport(stored) {
  const journal = buildJournal(stored);
  return {
    testId: stored.testId,
    status: stored.status,
    environment: stored.environment,
    recipient: stored.recipientEmail,
    sender: { email: stored.senderEmail, name: stored.senderName },
    templateCode: stored.templateCode,
    operationId: stored.testId,
    deliveryId: stored.testId,
    provider: stored.provider,
    providerMessageId: stored.providerMessageId,
    requestedAt: stored.requestedAt,
    acceptedAt: stored.acceptedAt,
    lastWebhookAt: stored.lastWebhookAt,
    lastWebhookEvent: stored.lastWebhookEvent,
    lastWebhookReason: stored.lastWebhookReason,
    webhookStatus: stored.webhookStatus,
    errorCode: stored.errorCode,
    errorMessage: stored.errorMessage,
    journal,
    /** Le texte que l'opérateur colle dans un ticket. */
    plainText: buildPlainText(stored, journal),
  };
}

/**
 * LE CONTACT PUBLIC, LU DEPUIS L'IDENTITÉ — pas recopié.
 *
 * ══ POURQUOI IL APPARAÎT SUR CET ÉCRAN-LÀ ═══════════════════════════════════
 *
 * Parce que c'est ici qu'on le confond. L'écran annonce « Adresse d'expédition
 * (From / support) » : un opérateur qui la remplit croit légitimement avoir
 * renseigné l'adresse à laquelle ses clients écriront. Ce sont deux choses —
 * l'une peut être une boîte technique jamais relevée. Les montrer côte à côte
 * est le seul endroit où la distinction se voit au moment où elle compte.
 *
 * ══ MONTRÉ ICI, STOCKÉ AILLEURS ═════════════════════════════════════════════
 *
 * La valeur reste sur l'entreprise du Panel — l'autorité d'identité, celle qui
 * est publiée aux projets. La recopier dans la configuration d'expéditeur
 * créerait la seconde vérité que cet écran existe pour empêcher.
 */
async function describePublicContact() {
  const company = await getActiveCompany();
  const adresse = company?.contacts?.publicContactEmail ?? null;
  return {
    email: adresse,
    /* « À renseigner » n'est pas une erreur : c'est une décision d'identité
       qui appartient à l'opérateur, et personne d'autre ne peut la prendre. */
    configured: Boolean(adresse),
    companyId: company?.companyId ?? null,
    companyName: company?.identity?.name ?? null,
    /* Ce qui change quand elle est absente — écrit ici, pas deviné à l'écran. */
    consequence: adresse
      ? null
      : 'Tant qu’elle est vide, les e-mails clients qui l’exigent sont REFUSÉS à l’envoi plutôt qu’expédiés sans adresse de réponse.',
  };
}

/** Vue d'ensemble de l'écran : la configuration, le contact public, le dernier test. */
export async function describeSenderScreen() {
  return {
    configuration: await describeGlobalSender(),
    publicContact: await describePublicContact(),
    environment: runtimeEnvironment(),
    lastTest: await describeLastTest(),
  };
}

export default {
  TEST_TEMPLATE_CODE,
  sendTestEmail,
  applyDeliveryEvent,
  describeTest,
  describeLastTest,
  describeSenderScreen,
};
