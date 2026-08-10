// IDENTITÉ EXPÉDITRICE — l'invariant que tout le lot protège (L8).
//
// docs/architecture/BREVO_CONTROL_PLANE.md §« Expéditeurs ».
//
// ── LA CONFUSION QU'IL FAUT RENDRE IMPOSSIBLE ───────────────────────────────
//
//   AUTORITÉ DE CREDENTIAL   « avec quel compte Brevo parle-t-on ? »
//                            → une par ENVIRONNEMENT, détenue par le Panel,
//                              chiffrée, jamais visible d'un projet.
//
//   IDENTITÉ EXPÉDITRICE     « au nom de qui écrit-on ? »
//                            → une par PROJET, purement métier, sans secret,
//                              parfaitement lisible.
//
// Centraliser la clé n'oblige en RIEN à uniformiser l'expéditeur. Un seul
// compte Brevo peut légitimement porter dix identités : chaque garage écrit à
// ses clients sous son propre nom. Confondre les deux mènerait à un plan de
// contrôle qui envoie tous les e-mails de tous les projets depuis la même
// adresse — techniquement propre, commercialement absurde.
//
// ── L'AUTRE CONFUSION : L'EXPÉDITEUR N'EST PAS LE DESTINATAIRE ──────────────
//
// L'adresse d'expédition sert aussi de contact support affiché. Elle ne doit
// JAMAIS servir de destinataire de repli : s'auto-notifier masque l'absence de
// destinataire réel, et personne ne s'aperçoit que plus rien n'arrive.
//
// ── PÉRIMÈTRE L8 ────────────────────────────────────────────────────────────
//
// Ce module ne persiste RIEN et ne déclare aucun schéma : le stockage de la
// configuration métier par projet est une décision de modèle, et la poser
// pendant que L5 écrit ses propres modèles créerait un conflit pour rien. On
// fixe ici le CONTRAT — forme, validation, portée — que le stockage devra
// honorer. La recherche est injectée (`lookup`).
import ApiError from '../../../utils/ApiError.js';

/** Ce qui rend une identité utilisable. Fermé : l'écran traduit chaque code. */
export const SENDER_IDENTITY_CODES = Object.freeze({
  OK: 'OK',
  /** Aucune identité configurée pour ce projet dans cet environnement. */
  NOT_CONFIGURED: 'SENDER_IDENTITY_MISSING',
  /** Configurée mais inexploitable (adresse illisible, nom vide). */
  INVALID: 'SENDER_IDENTITY_INVALID',
  /** Un projet a demandé l'identité d'un autre. Refus sec. */
  SCOPE_VIOLATION: 'SENDER_IDENTITY_SCOPE_VIOLATION',
});

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Forme attendue d'une identité expéditrice. Aucun secret, par construction :
 * si un champ confidentiel apparaissait ici, il traverserait le pont le jour où
 * un écran de projet afficherait son expéditeur.
 */
export const SENDER_IDENTITY_SHAPE = Object.freeze({
  required: Object.freeze(['fromEmail', 'fromName']),
  optional: Object.freeze(['replyToEmail', 'replyToName']),
  /** Vérifié par test : aucune de ces clés n'a le droit d'exister ici. */
  forbidden: Object.freeze(['apiKey', 'webhookSecret', 'secretKey', 'apiToken', 'password']),
});

/**
 * Valide une identité SANS rien décider d'autre.
 *
 * @returns {{valid: boolean, code: string, problems: string[]}}
 */
export function validateSenderIdentity(identity) {
  const problems = [];
  if (!identity || typeof identity !== 'object') {
    return { valid: false, code: SENDER_IDENTITY_CODES.NOT_CONFIGURED, problems: ['Aucune identité fournie.'] };
  }
  const fromEmail = String(identity.fromEmail ?? '').trim().toLowerCase();
  const fromName = String(identity.fromName ?? '').trim();

  if (!fromEmail) problems.push('Adresse expéditrice absente.');
  else if (!EMAIL_RE.test(fromEmail)) problems.push('Adresse expéditrice illisible.');
  // Un nom vide ferait afficher l'adresse brute dans la boîte du destinataire.
  // Ce n'est pas bloquant chez Brevo, ça l'est pour la crédibilité du message.
  if (!fromName) problems.push('Nom d’expéditeur absent.');

  const replyToEmail = String(identity.replyToEmail ?? '').trim().toLowerCase();
  if (replyToEmail && !EMAIL_RE.test(replyToEmail)) problems.push('Adresse de réponse illisible.');

  for (const forbidden of SENDER_IDENTITY_SHAPE.forbidden) {
    if (identity[forbidden] !== undefined) {
      problems.push(`Le champ « ${forbidden} » n’a rien à faire dans une identité expéditrice.`);
    }
  }

  if (problems.length > 0) {
    const code = fromEmail || fromName ? SENDER_IDENTITY_CODES.INVALID : SENDER_IDENTITY_CODES.NOT_CONFIGURED;
    return { valid: false, code, problems };
  }
  return { valid: true, code: SENDER_IDENTITY_CODES.OK, problems: [] };
}

/**
 * LA GARDE DE PORTÉE — le projet AUTHENTIFIÉ décide, la charge utile jamais.
 *
 * Le `projectId` du contexte authentifié est la seule autorité. Un `projectId`
 * présent dans le corps de la requête n'est pas une information, c'est une
 * proposition : s'il diverge, on refuse plutôt que de choisir. Accepter le plus
 * permissif des deux serait précisément l'usurpation qu'on cherche à rendre
 * impossible.
 *
 * Refuser sur ÉGALITÉ manquée, et non ignorer silencieusement, est délibéré :
 * un projet qui envoie un identifiant étranger a un bug ou une intention, et
 * les deux méritent une trace.
 *
 * @param {{authenticatedProjectId: string, requestedProjectId?: string|null}} args
 * @returns {string} l'identifiant à utiliser — toujours celui du contexte.
 */
export function assertProjectScope({ authenticatedProjectId, requestedProjectId = null }) {
  const authenticated = String(authenticatedProjectId ?? '').trim();
  if (!authenticated) {
    throw ApiError.badRequest(
      SENDER_IDENTITY_CODES.SCOPE_VIOLATION,
      'Aucun projet authentifié : l’identité expéditrice ne peut pas être résolue.',
    );
  }
  const requested = requestedProjectId === null || requestedProjectId === undefined
    ? ''
    : String(requestedProjectId).trim();

  if (requested && requested !== authenticated) {
    throw ApiError.forbidden(
      SENDER_IDENTITY_CODES.SCOPE_VIOLATION,
      'Refusé : la demande désigne un autre projet que celui authentifié.',
    );
  }
  return authenticated;
}

/**
 * Résout l'identité expéditrice d'un projet, dans l'environnement SERVI.
 *
 * ── L'ENVIRONNEMENT N'EST PAS UN PARAMÈTRE LIBRE ────────────────────────────
 *
 * Il est passé par l'appelant parce que la doctrine TEST/PROD appartient à
 * L1/L1.75 et sera résolue par `integratedApi/environment.js`. Ce module le
 * CONSOMME, il ne le choisit pas et ne le devine pas — d'où le refus net quand
 * il manque, plutôt qu'un repli sur TEST qui enverrait un jour un e-mail de
 * production depuis une identité de recette.
 *
 * @param {object} args
 * @param {string} args.authenticatedProjectId
 * @param {string} [args.requestedProjectId]  ce que la charge utile prétend.
 * @param {'TEST'|'PROD'} args.environment    résolu par le plan de contrôle.
 * @param {(args: {projectId: string, environment: string}) => Promise<object|null>} args.lookup
 * @returns {Promise<{projectId, environment, fromEmail, fromName, replyTo: object|null}>}
 */
export async function resolveSenderIdentity({
  authenticatedProjectId,
  requestedProjectId = null,
  environment,
  lookup,
}) {
  const projectId = assertProjectScope({ authenticatedProjectId, requestedProjectId });

  if (!environment) {
    throw ApiError.badRequest(
      'PANEL_INTEGRATED_API_ENVIRONMENT_REQUIRED',
      'Environnement non résolu : l’identité expéditrice ne se devine pas.',
    );
  }
  if (typeof lookup !== 'function') {
    throw ApiError.badRequest(
      'PANEL_BREVO_SENDER_LOOKUP_MISSING',
      'Aucune source d’identité expéditrice fournie.',
    );
  }

  const stored = await lookup({ projectId, environment });
  const verdict = validateSenderIdentity(stored);
  if (!verdict.valid) {
    throw ApiError.conflict(
      verdict.code,
      `Identité expéditrice inexploitable pour ce projet en ${environment} : ${verdict.problems.join(' ')}`,
    );
  }

  const fromEmail = String(stored.fromEmail).trim().toLowerCase();
  const replyToEmail = String(stored.replyToEmail ?? '').trim().toLowerCase();

  return {
    projectId,
    environment,
    fromEmail,
    // Brevo retombe lui-même sur l'adresse quand le nom manque ; on fait pareil,
    // pour que le rendu soit le même quel que soit le chemin.
    fromName: String(stored.fromName).trim() || fromEmail,
    replyTo: replyToEmail
      ? { email: replyToEmail, name: String(stored.replyToName ?? '').trim() || undefined }
      : null,
  };
}

/**
 * Vue SÛRE d'une identité, pour un écran de diagnostic.
 *
 * L'adresse expéditrice n'est PAS masquée : elle est publique par nature —
 * elle figure dans chaque e-mail envoyé, et la cacher à l'opérateur qui la
 * configure n'apporterait rien qu'une gêne.
 */
export function describeSenderIdentity(identity) {
  if (!identity) return null;
  return {
    projectId: identity.projectId,
    environment: identity.environment,
    fromEmail: identity.fromEmail,
    fromName: identity.fromName,
    replyToEmail: identity.replyTo?.email ?? null,
  };
}

export default {
  SENDER_IDENTITY_CODES,
  SENDER_IDENTITY_SHAPE,
  validateSenderIdentity,
  assertProjectScope,
  resolveSenderIdentity,
  describeSenderIdentity,
};
