// `email.send_template` — l'exécutant, et les trois autorités qu'il consulte.
//
// docs/architecture/BREVO_CONTROL_PLANE.md §« Envoi ».
//
// ── L'ORDRE DES RÉSOLUTIONS, ET POURQUOI CELUI-LÀ ───────────────────────────
//
//   1. le MODÈLE       autorité Panel, résolu pour CE projet
//   2. l'EXPÉDITEUR    identité du projet AUTHENTIFIÉ, dans le monde servi
//   3. le RENDU        sujet + HTML, produits ici
//   4. le TRANSPORT    clé du coffre, jamais celle d'un projet
//
// Le rendu vient APRÈS l'expéditeur : un modèle valide dont l'expéditeur
// manque ne doit pas être rendu pour rien, et surtout l'erreur rendue doit
// nommer la vraie cause. Un rendu réussi suivi d'un « expéditeur absent »
// enverrait chercher du côté du contenu.
//
// ── CE QUI NE PEUT PAS ARRIVER ICI ──────────────────────────────────────────
//
// Aucun `templateId` Brevo ne part : le corps porte `subject` + `htmlContent`
// rendus par nous (contrat L8, `forbiddenBodyFields`). Aucun expéditeur venu
// de la charge utile n'est honoré. Aucun `projectId` autre que l'authentifié
// n'est consulté — il n'est même pas lu.
import {
  sendTransactionalEmail,
  BrevoTransportError,
  TRANSPORT_CODES,
  OUTCOMES as TRANSPORT_OUTCOMES,
} from '../integratedApi/brevo/brevoTransport.js';
import { renderForSend } from '../email/panelEmailTemplate.service.js';
import { resolveForProject } from '../email/panelSenderIdentity.service.js';
import { CAPABILITY_ERROR_CODES, CapabilityError } from './capabilityErrors.js';

/**
 * Traduit un refus de transport en refus de passerelle.
 *
 * ── LA DISTINCTION QUI PORTE TOUT LE LOT ────────────────────────────────────
 *
 * `TIMEOUT` et `MALFORMED_RESPONSE` ne deviennent PAS `PROVIDER_UNAVAILABLE`.
 * Les deux laissent l'envoi dans un état INDÉCIDABLE — la requête a pu aboutir
 * et seule la réponse se perdre, ou Brevo a accepté sans rendre d'identifiant.
 * `PROVIDER_UNAVAILABLE` affirmerait que rien n'est parti ; un projet qui le
 * croit rejoue, et double un e-mail chez une personne réelle.
 */
function translate(error, capability) {
  if (!(error instanceof BrevoTransportError)) {
    return new CapabilityError(
      CAPABILITY_ERROR_CODES.PROVIDER_UNAVAILABLE,
      `L’exécution de « ${capability.code} » a échoué chez le fournisseur.`,
    );
  }

  const indecidable = error.outcome === TRANSPORT_OUTCOMES.UNKNOWN
    || error.code === TRANSPORT_CODES.TIMEOUT
    || error.code === TRANSPORT_CODES.MALFORMED_RESPONSE;

  if (indecidable) {
    return new CapabilityError(
      CAPABILITY_ERROR_CODES.TIMEOUT,
      `Le fournisseur n’a pas confirmé « ${capability.code} » : l’issue est indéterminée, `
      + 'et l’envoi ne doit pas être rejoué automatiquement.',
      { httpStatus: error.httpStatus ?? null, replaySafe: false },
    );
  }

  if (error.code === TRANSPORT_CODES.MISSING_CREDENTIALS) {
    return new CapabilityError(
      CAPABILITY_ERROR_CODES.CREDENTIALS_MISSING,
      `Identifiants incomplets pour ${capability.provider}.`,
    );
  }
  if (error.code === TRANSPORT_CODES.INPUT_INVALID) {
    return new CapabilityError(
      CAPABILITY_ERROR_CODES.INPUT_INVALID,
      `Entrée refusée par l’adaptateur de « ${capability.code} ».`,
    );
  }

  // Refus CERTAIN du fournisseur : rien n'est parti, la cause est chez nous ou
  // chez lui, et un rejeu explicite après correction est légitime.
  return new CapabilityError(
    CAPABILITY_ERROR_CODES.PROVIDER_UNAVAILABLE,
    `Le fournisseur a refusé « ${capability.code} ».`,
    { httpStatus: error.httpStatus ?? null },
  );
}

/**
 * Envoie une notification depuis un modèle DÉTENU PAR LE PANEL.
 *
 * @returns {Promise<{status: string, providerMessageId: string|null, operationId: string}>}
 */
export async function brevoSendTemplate({ definition, context, credentials, input, fetchImpl }) {
  /**
   * L'EXPÉDITEUR D'ABORD — et il vient du contexte AUTHENTIFIÉ.
   *
   * `context.projectId` est celui que le bridgeToken a prouvé. La charge utile
   * n'a aucun champ pour en proposer un autre (schéma `strict()`), et même si
   * elle en avait un, il ne serait pas lu ici : la garde du contrat L8 refuse
   * sur égalité manquée, elle ne choisit pas le plus permissif.
   */
  const sender = await resolveForProject({
    authenticatedProjectId: context.projectId,
    environment: context.environment,
  });

  // LE RENDU — par l'autorité Panel, avec le contenu de CE projet.
  const rendered = await renderForSend({
    templateCode: input.templateCode,
    projectId: context.projectId,
    variables: input.variables ?? {},
  });

  try {
    const outcome = await sendTransactionalEmail({
      credentials: { apiKey: credentials.apiKey, baseUrl: credentials.baseUrl },
      sender: { email: sender.fromEmail, name: sender.fromName },
      recipient: input.recipient,
      subject: rendered.subject,
      htmlContent: rendered.html,
      ...(rendered.text ? { textContent: rendered.text } : {}),
      /**
       * `replyTo` du projet s'il est fourni, sinon celui de l'identité. Le
       * premier est une donnée d'exécution (« répondre au demandeur »), le
       * second une configuration (« répondre au SAV ») : l'un ne remplace pas
       * l'autre, il le précise.
       */
      ...(input.replyTo ?? sender.replyTo ? { replyTo: input.replyTo ?? sender.replyTo } : {}),
      /**
       * L'identifiant d'OPÉRATION part comme étiquette. Seconde poignée de
       * corrélation : si l'identifiant de message se perdait, l'événement
       * fournisseur porterait encore de quoi retrouver l'exécution.
       */
      tags: [`op:${input.operationId}`],
      timeoutMs: definition.timeoutMs,
      ...(fetchImpl ? { fetchImpl } : {}),
    });

    return {
      status: 'ACCEPTED',
      providerMessageId: outcome.providerMessageId,
      operationId: input.operationId,
    };
  } catch (error) {
    if (error instanceof CapabilityError) throw error;
    throw translate(error, definition);
  }
}

export default { brevoSendTemplate };
