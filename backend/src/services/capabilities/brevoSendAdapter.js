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
import {
  renderForSend, EMAIL_TEMPLATE_NOT_CONFIGURED, EMAIL_TEMPLATE_NOT_DECLARED,
} from '../email/panelEmailTemplate.service.js';
import { describeScope, scopeOfInvocationContext } from '../email/panelEmailTemplateScope.js';
import { resolveForProject, resolveForPanel } from '../email/panelSenderIdentity.service.js';
import {
  CAPABILITY_ERROR_CODES,
  CapabilityError,
  capabilityProjectScopeMismatch,
} from './capabilityErrors.js';

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
 * Traduit un refus de PRÉPARATION — modèle, variables, expéditeur.
 *
 * Aucun de ces refus n'a atteint le fournisseur : ils sont tous actionnables
 * par un humain, et le code rendu doit dire LEQUEL. Un `INPUT_INVALID` fait
 * corriger l'appel ; un `NOT_AVAILABLE` fait corriger une configuration ; un
 * `PROJECT_SCOPE_MISMATCH` est une tentative d'usurpation, et se lit comme
 * telle dans le journal.
 */
export function translatePreparation(error, capability) {
  if (error instanceof CapabilityError) return error;
  const code = error?.code ?? '';

  // Le projet a nommé un modèle qui n'existe pas, ou omis une variable requise.
  if (code === 'PANEL_EMAIL_TEMPLATE_UNKNOWN'
    || code === 'PANEL_EMAIL_TEMPLATE_INVALID'
    || String(code).startsWith('TEMPLATE_')
    || String(code).startsWith('RENDER_')) {
    return new CapabilityError(
      CAPABILITY_ERROR_CODES.INPUT_INVALID,
      `Entrée refusée pour « ${capability.code} » : ${error?.message ?? 'modèle ou variables non conformes.'}`,
      { reason: code || 'TEMPLATE_OR_VARIABLES' },
    );
  }

  // Le modèle existe mais a été coupé : ce n'est pas l'appel qui est fautif.
  if (code === 'PANEL_EMAIL_TEMPLATE_DISABLED') {
    return new CapabilityError(
      CAPABILITY_ERROR_CODES.NOT_AVAILABLE,
      `Le modèle demandé par « ${capability.code} » est désactivé : aucun envoi n’est effectué.`,
      { reason: 'TEMPLATE_DISABLED' },
    );
  }

  /**
   * AUCUN MODÈLE DANS CETTE PORTÉE — le refus qui remplace le repli (L11.1).
   *
   * ── POURQUOI `NOT_AVAILABLE` ET PAS `INPUT_INVALID` ───────────────────────
   *
   * L'appel du projet est PARFAITEMENT correct : le code existe, les variables
   * sont bonnes, l'identité est prouvée. Ce qui manque est une CONFIGURATION —
   * le contenu de ce projet n'a jamais été écrit. `INPUT_INVALID` enverrait le
   * projet corriger son code, où il ne trouverait rien ; `NOT_AVAILABLE` dit la
   * vérité : quelqu'un doit remplir un écran.
   *
   * Ce refus est la contrepartie ASSUMÉE du lot : des envois qui « marchaient »
   * échouent désormais. C'est le but — ils partaient avec le texte du Panel sous
   * le nom d'un client.
   */
  /**
   * LE PROJET NE DÉCLARE PLUS CE MODÈLE — un refus qui doit se DIRE.
   *
   * ── POURQUOI PAS `INPUT_INVALID`, QUI ÉTAIT LA RÉPONSE PAR DÉFAUT ─────────
   *
   * Faute d'être nommé ici, ce refus retombait dans la traduction générique :
   * « Entrée non conforme au contrat de "email.send_template" ». C'est faux sur
   * les deux plans. L'entrée est parfaitement conforme — le code existe, les
   * variables sont bonnes — et surtout ce message envoie corriger un appel qui
   * n'a rien à corriger. Pendant ce temps, la vraie cause — ce projet a cessé
   * de déclarer ce modèle — n'apparaissait nulle part.
   *
   * `NOT_AVAILABLE` dit ce qui est vrai : le refus ne vient pas de l'appel mais
   * de la DÉCLARATION, et c'est elle qu'il faut changer — dans le projet, qui
   * en est l'auteur, jamais dans le Panel, qui ne fait que s'y conformer.
   */
  if (code === EMAIL_TEMPLATE_NOT_DECLARED) {
    return new CapabilityError(
      CAPABILITY_ERROR_CODES.NOT_AVAILABLE,
      `Ce projet ne déclare pas le modèle demandé par « ${capability.code} » : aucun envoi n’est effectué. `
      + 'La liste des modèles consommés est déclarée par le projet lui-même — c’est là qu’elle se corrige.',
      { reason: EMAIL_TEMPLATE_NOT_DECLARED },
    );
  }

  if (code === EMAIL_TEMPLATE_NOT_CONFIGURED) {
    return new CapabilityError(
      CAPABILITY_ERROR_CODES.NOT_AVAILABLE,
      `Aucun modèle n’est configuré pour cette portée : « ${capability.code} » ne peut pas s’exécuter. `
      + 'Le contenu du Panel n’est jamais servi à la place de celui d’un projet.',
      { reason: EMAIL_TEMPLATE_NOT_CONFIGURED },
    );
  }

  // Un projet qui réclame l'identité d'un autre : refus sec, et nommé.
  if (code === 'SENDER_IDENTITY_SCOPE_VIOLATION') {
    return capabilityProjectScopeMismatch();
  }

  /**
   * L'EXPÉDITEUR GLOBAL MANQUE — une CONFIGURATION manque, pas une clé (R10.4).
   *
   * Ce refus vaut pour TOUT le parc d'un coup : sans expéditeur global, aucun
   * projet n'envoie. C'est voulu — un repli silencieux ferait partir des
   * e-mails sous une adresse que personne n'a choisie — et c'est la raison pour
   * laquelle le message nomme l'écran à remplir plutôt que le projet appelant,
   * qui n'y peut rien.
   */
  if (String(code).startsWith('PANEL_GLOBAL_SENDER_')) {
    return new CapabilityError(
      CAPABILITY_ERROR_CODES.NOT_AVAILABLE,
      `Aucun expéditeur global exploitable : « ${capability.code} » ne peut pas s’exécuter. `
      + 'Renseignez « Expéditeur e-mail » dans le Panel.',
      { reason: code },
    );
  }

  // Identité absente ou inexploitable : une CONFIGURATION manque, pas une clé.
  if (String(code).startsWith('SENDER_IDENTITY_')
    || code === 'PANEL_INTEGRATED_API_ENVIRONMENT_REQUIRED') {
    return new CapabilityError(
      CAPABILITY_ERROR_CODES.NOT_AVAILABLE,
      `Aucune identité expéditrice exploitable pour ce projet : « ${capability.code} » ne peut pas s’exécuter.`,
      { reason: code || 'SENDER_IDENTITY_MISSING' },
    );
  }

  // Inconnu : on ne prétend pas savoir, et on ne l'impute pas au fournisseur.
  return new CapabilityError(
    CAPABILITY_ERROR_CODES.INPUT_INVALID,
    `Préparation impossible pour « ${capability.code} ».`,
    { reason: code || 'PREPARATION_FAILED' },
  );
}

/**
 * Envoie une notification depuis un modèle DÉTENU PAR LE PANEL.
 *
 * @returns {Promise<{status: string, providerMessageId: string|null, operationId: string}>}
 */
export async function brevoSendTemplate({ definition, context, credentials, input, fetchImpl }) {
  let sender;
  let rendered;

  /**
   * ── CE QUI SE PASSE AVANT LE FOURNISSEUR NE LUI EST PAS IMPUTÉ ────────────
   *
   * Un modèle inconnu, une variable manquante, un expéditeur non configuré :
   * rien de tout cela n'est une panne de Brevo, et rien n'est encore parti.
   * Les laisser tomber dans le traducteur de transport les aurait tous
   * ressortis en « fournisseur indisponible » — un diagnostic qui envoie
   * chercher la panne à l'autre bout du monde, et qui invite à réessayer une
   * configuration qui ne se réparera pas toute seule.
   */
  try {
    /**
     * L'EXPÉDITEUR D'ABORD — `From` GLOBAL, `Reply-To` du projet (R10.4).
     *
     * `context.projectId` est celui que le bridgeToken a prouvé. La charge
     * utile n'a aucun champ pour en proposer un autre (schéma `strict()`), et
     * même si elle en avait un, il ne serait pas lu ici : la garde du contrat
     * L8 refuse sur égalité manquée, elle ne choisit pas le plus permissif.
     *
     * Quand le Panel écrit pour LUI-MÊME (`PANEL_SELF`), il n'y a pas de
     * projet — donc pas de `Reply-To`, et le MÊME `From` que tout le reste du
     * parc. C'est le point entier de R10.4 : l'e-mail de test emprunte la
     * chaîne réelle, pas une chaîne parallèle qui prouverait autre chose.
     */
    sender = context.projectId === null
      ? await resolveForPanel()
      : await resolveForProject({
        authenticatedProjectId: context.projectId,
        environment: context.environment,
      });

    /**
     * LA PORTÉE — DÉDUITE DU CONTEXTE, JAMAIS DE LA CHARGE UTILE (Phase 7).
     *
     * `context.projectId` est celui que le jeton de pont a PROUVÉ. Le contrat
     * d'entrée de la capacité ne porte aucun champ de portée, et il est
     * `strict()` : un projet qui en inventerait un serait refusé au schéma,
     * avant d'arriver ici. Le fil transporte un CODE NU — et c'est plus sûr que
     * de transporter une portée, puisqu'une portée transportée est une portée
     * qu'on peut réécrire.
     */
    const scope = scopeOfInvocationContext(context);

    // LE RENDU — par l'autorité Panel, avec le contenu de CETTE portée.
    rendered = await renderForSend({
      // `templateRef` sur le fil (contrat L8), `templateCode` dans l'autorité
      // Panel : le même objet, nommé selon le côté où l'on se trouve.
      templateCode: input.templateRef,
      scope,
      variables: input.variables ?? {},
    });
  } catch (error) {
    throw translatePreparation(error, definition);
  }

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
      // Le fait constaté, pas la configuration : c'est SOUS CETTE ADRESSE que
      // le message est parti, et c'est ce que le suivi du projet doit montrer.
      sender: { email: sender.fromEmail, name: sender.fromName },
      /**
       * QUEL DOCUMENT EXACT EST PARTI (Phases 13 et 14).
       *
       * L'audit avait relevé que le journal ne permettait pas de répondre
       * après coup à « quel template, pour quel projet, quelle version ». Et
       * que le projet persistait sur sa livraison une `templateVersion` LOCALE
       * — un numéro qui n'était jamais parti. Les deux se corrigent au même
       * endroit : le seul composant qui SAIT est celui qui vient de rendre.
       *
       * Ce sont des FAITS CONSTATÉS, pas des configurations. Ils ne révèlent
       * rien : ni adresse, ni contenu, ni secret.
       */
      templateCode: rendered.templateCode,
      templateScope: rendered.scopeType,
      templateScopeId: rendered.scopeId,
      templateVersion: rendered.version,
      templateSource: rendered.source,
      // Le sujet EXACT remis au fournisseur — pas celui d'une copie locale.
      subject: rendered.subject,
    };
  } catch (error) {
    if (error instanceof CapabilityError) throw error;
    throw translate(error, definition);
  }
}

export default { brevoSendTemplate, translatePreparation };
