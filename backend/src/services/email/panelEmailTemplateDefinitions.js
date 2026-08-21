// LE CONTRAT FONCTIONNEL D'UN CODE — une définition, N présentations (L11.1).
//
// docs/email/EMAIL_TEMPLATE_MULTI_PROJECT_IMPLEMENTATION_REPORT.md §« Contrat ».
//
// ── LA DISTINCTION QUE CE MODULE INTRODUIT ──────────────────────────────────
//
//   TemplateDefinition  le CONTRAT d'un code : quelles variables ce message
//                       transporte, lesquelles sont obligatoires, à quoi il
//                       sert, et dans quelles portées il a le droit d'exister.
//                       Vit dans le CODE. Une seule par code, pour tout le parc.
//
//   TemplateInstance    la PRÉSENTATION : sujet, HTML, activation, version.
//                       Vit en BASE, par (portée, code). Autant qu'il y a de
//                       portées.
//
// Avant L11.1 les deux étaient confondues : le registre portait le contrat ET
// le HTML par défaut, et rien ne disait qu'ils n'avaient pas la même durée de
// vie. Le HTML par défaut reste au registre — c'est le contenu d'amorçage —
// mais il n'est plus la SOURCE DE VÉRITÉ du contrat : le validateur et le
// renderer interrogent désormais la définition, pas le document.
//
// ── OPTION A DU LOT, ASSUMÉE ────────────────────────────────────────────────
//
// Le contrat de variables est PLATEFORME, pas scopé (§6 du lot, option A de
// l'audit). Trois projets peuvent écrire trois HTML entièrement différents pour
// `PASSWORD_RESET_REQUEST` ; aucun ne peut inventer `supportPhone`.
//
// C'est une contrainte, et elle est délibérée : les VALEURS des variables sont
// produites par le code métier du projet (`emailVariableResolvers`), et un
// contrat scopé exigerait que ce code sache, projet par projet, quoi produire.
// Le jour où un projet aura un besoin réel de diverger, l'option B se posera
// sur `TemplateDefinition` — qui est précisément l'endroit prévu pour la porter.
//
// ── LA CLASSIFICATION EST ÉTABLIE PAR LES APPELANTS, JAMAIS PAR LE NOM ──────
//
// Chaque entrée porte ses `callers` : les fichiers réels qui invoquent le code,
// relevés par recensement (§Phase 3 du lot). `SITE_SUSPENDED_MANUAL_ADMIN` est
// PROJECT non parce qu'il « sonne projet », mais parce que son unique appelant
// est `PROJECT/services/siteSuspensionNotice.service.js`.
//
// ── POURQUOI AUCUN NOM DE CLIENT N'APPARAÎT ICI ─────────────────────────────
//
// Les appelants côté projet sont nommés `PROJECT/…`, jamais par le nom d'un
// client. Le Panel sert un PARC : y inscrire l'identité d'un client ferait de
// ce registre une pièce spécifique, que le prochain projet devrait modifier
// pour exister. La garde d'architecture le vérifie, et elle a raison — le
// recensement nominatif appartient au rapport d'implémentation, pas au code.
import ApiError from '../../utils/ApiError.js';
import {
  EMAIL_TEMPLATE_IDS,
  getTemplateDefinition,
  isKnownTemplateId,
  variablesFor,
} from './panelEmailTemplateRegistry.js';
import { SCOPE_ERROR_CODES, SCOPE_TYPES, assertScopeCoherent, describeScope } from './panelEmailTemplateScope.js';

/** Familles fonctionnelles. Sert à trier les écrans, jamais à décider. */
export const TEMPLATE_CATEGORIES = Object.freeze({
  AUTH: 'AUTH',
  CONTACT: 'CONTACT',
  CONTRACT: 'CONTRACT',
  BILLING: 'BILLING',
  LIFECYCLE: 'LIFECYCLE',
  TECHNICAL: 'TECHNICAL',
});

const P = SCOPE_TYPES.PANEL;
const J = SCOPE_TYPES.PROJECT;

/**
 * QUI POSSÈDE LA COMMUNICATION — code par code, appelant par appelant.
 *
 * `scopes` liste les portées dans lesquelles une instance a le droit d'exister.
 * Deux portées pour un même code n'est PAS une ambiguïté : c'est le cœur du lot.
 * `PASSWORD_RESET_REQUEST` est envoyé par le Panel à ses exploitants ET par
 * chaque projet à ses utilisateurs — deux communications distinctes, deux
 * propriétaires, deux documents.
 *
 * `provisionForProjects` dit si une instance projet doit être POSÉE d'office
 * quand un projet est ouvert au contenu scopé. Un code PANEL pur ne l'est
 * jamais ; un code PROJECT pur l'est toujours, faute de quoi son premier envoi
 * échouerait en `EMAIL_TEMPLATE_NOT_CONFIGURED`.
 */
export const TEMPLATE_OWNERSHIP = Object.freeze({
  PASSWORD_RESET_REQUEST: {
    scopes: [P, J],
    category: TEMPLATE_CATEGORIES.AUTH,
    provisionForProjects: true,
    reason:
      'Deux communications distinctes portent le même contrat : le Panel écrit à ses exploitants, '
      + 'chaque projet écrit à ses propres utilisateurs sous son propre branding.',
    callers: [
      'Panel/services/auth/panelPasswordReset.service.js',
      'PROJECT/services/auth.service.js',
    ],
  },

  /**
   * L'ACTIVATION DU PREMIER ACCÈS D'ADMINISTRATION D'UN PROJET (LOT 2C).
   *
   * ── POURQUOI PROJECT, ALORS QUE L.Y SOLUTION DUPLIQUE LE PROJET ───────────
   *
   * C'est bien L.Y Solution qui crée le compte, et la tentation est d'en faire
   * une communication PANEL. Elle échoue au seul critère qui vaille : QUI PARLE
   * À QUI. Le destinataire est l'administrateur DE CE PROJET, l'accès qu'il
   * ouvre est celui DE CE PROJET, et le message porte le nom et l'apparence DE
   * CE PROJET. Le Panel n'est ici que le transporteur — comme pour la
   * réinitialisation de mot de passe, dont ce code est le jumeau.
   *
   * `provisionForProjects` est donc VRAI, et ce n'est pas une commodité : c'est
   * le tout premier e-mail qu'un projet neuf émet. S'il n'était pas posé
   * d'avance, la duplication échouerait en `EMAIL_TEMPLATE_NOT_CONFIGURED` —
   * et le projet naîtrait sans aucun accès d'administration.
   */
  DEV_ACCOUNT_ACTIVATION: {
    scopes: [J],
    category: TEMPLATE_CATEGORIES.AUTH,
    provisionForProjects: true,
    reason:
      'Ouvre le PREMIER accès d’administration d’un projet dupliqué. Destinataire projet, '
      + 'branding projet, accès projet — le Panel n’en est que le transporteur, exactement '
      + 'comme pour la réinitialisation de mot de passe.',
    callers: ['PROJECT/services/localDevBootstrap.service.js'],
  },

  CONTACT_ADMIN_NOTIFICATION: {
    scopes: [J],
    category: TEMPLATE_CATEGORIES.CONTACT,
    provisionForProjects: true,
    reason:
      'Un visiteur écrit au commerçant. La communication appartient au projet de bout en bout — '
      + 'le Panel n’en est que le transporteur.',
    callers: ['PROJECT/utils/domainEventActionRegistry.js#notify-admins-contact-submitted'],
  },

  CONTRACT_CANCELLATION_ADMIN_CONFIRMATION: {
    scopes: [J],
    category: TEMPLATE_CATEGORIES.CONTRACT,
    provisionForProjects: true,
    reason:
      'Confirmation adressée aux administrateurs du projet client. Destinataire projet, '
      + 'ton projet, propriétaire projet.',
    callers: ['PROJECT/utils/domainEventActionRegistry.js#notify-admins-cancellation (déclarée, désactivée)'],
  },

  CONTRACT_CANCELLATION_DEV_NOTIFICATION: {
    scopes: [P],
    category: TEMPLATE_CATEGORIES.CONTRACT,
    provisionForProjects: false,
    reason:
      'CAS D’ÉCOLE DU §16 DU LOT : l’événement vient d’un projet, les variables aussi, et le '
      + 'template reste PANEL — parce que le destinataire et l’émetteur de la communication sont '
      + 'L.Y Solution. L’ownership suit la communication, jamais l’origine des variables.',
    callers: ['PROJECT/utils/domainEventActionRegistry.js#notify-devs-cancellation (déclarée, désactivée)'],
  },

  EMAIL_SENDER_VERIFICATION_TEST: {
    scopes: [J],
    category: TEMPLATE_CATEGORIES.TECHNICAL,
    provisionForProjects: true,
    reason:
      'Éprouve la chaîne d’envoi D’UN PROJET, déclenché depuis le manager de ce projet, reçu par '
      + 'l’exploitant de ce projet. Classé PROJECT plutôt que SHARED : le §9 du lot interdit '
      + 'd’introduire une portée SHARED sans cas réel, et il n’y en a pas.',
    callers: ['PROJECT/services/email/emailModule.js', 'PROJECT/services/email/emailVariableResolvers.js'],
  },

  SITE_SUSPENDED_MANUAL_ADMIN: {
    scopes: [J],
    category: TEMPLATE_CATEGORIES.LIFECYCLE,
    provisionForProjects: true,
    reason:
      'Le projet annonce à ses propres administrateurs la suspension décidée manuellement. '
      + 'À ne pas confondre avec les deux annonces d’impayé, qui partent du Panel.',
    callers: ['PROJECT/services/siteSuspensionNotice.service.js'],
  },

  PAYMENT_REQUEST_CREATED: {
    scopes: [P],
    category: TEMPLATE_CATEGORIES.BILLING,
    provisionForProjects: false,
    reason: 'Facturation L.Y Solution vers son client. Aucun projet ne l’invoque.',
    callers: ['Panel/services/finance/paymentRequests/paymentRequestEmails.js'],
  },

  PAYMENT_REQUEST_REMINDER: {
    scopes: [P],
    category: TEMPLATE_CATEGORIES.BILLING,
    provisionForProjects: false,
    reason: 'Relance de facturation L.Y Solution. Aucun projet ne l’invoque.',
    callers: ['Panel/services/finance/paymentRequests/paymentRequestEmails.js'],
  },

  SITE_SUSPENDED_PAYMENT_DEFAULT_CLIENT: {
    scopes: [P],
    category: TEMPLATE_CATEGORIES.BILLING,
    provisionForProjects: false,
    reason:
      'L.Y Solution annonce à son client la suspension pour impayé. C’est la parole du '
      + 'prestataire, pas celle du site suspendu.',
    callers: ['Panel/services/finance/paymentDefaults/paymentDefaultAnnouncements.js'],
  },

  SITE_SUSPENDED_PAYMENT_DEFAULT_TEAM: {
    scopes: [P],
    category: TEMPLATE_CATEGORIES.BILLING,
    provisionForProjects: false,
    reason: 'Notification interne à l’équipe L.Y Solution.',
    callers: ['Panel/services/finance/paymentDefaults/paymentDefaultAnnouncements.js'],
  },

  PANEL_EMAIL_SENDER_TEST: {
    scopes: [P],
    category: TEMPLATE_CATEGORIES.TECHNICAL,
    provisionForProjects: false,
    reason: 'Éprouve l’expéditeur global depuis le Panel, pour le Panel.',
    callers: ['Panel/services/email/panelEmailSenderTest.service.js'],
  },

  /* ── LE CYCLE DE VIE D'UN PAIEMENT, CÔTÉ CLIENT ────────────────────────── */
  //
  // Les quatre codes suivants sont PROJECT au sens strict du §16 : le
  // destinataire est le client du projet, le ton est celui du site, et le
  // message porte son apparence. L.Y Solution n'est que le transporteur —
  // exactement comme pour `CONTACT_ADMIN_NOTIFICATION`.
  //
  // `provisionForProjects: true` pour les quatre : ce sont des messages du
  // parcours NORMAL d'un projet en exploitation. Sans instance posée d'avance,
  // le premier encaissement d'un projet neuf échouerait en
  // `EMAIL_TEMPLATE_NOT_CONFIGURED` — c'est-à-dire au pire moment.

  /**
   * REMPLACÉ PAR `PAYMENT_CONFIRMED_ADMIN` (L12) — conservé, jamais supprimé.
   *
   * ── POURQUOI IL RESTE AU REGISTRE ────────────────────────────────────────
   *
   * Un `templateCode` voyage dans les journaux d'envoi pour toujours, et les
   * instances que les projets en ont reçues portent leur contenu et leurs
   * versions. Le retirer du code rendrait illisible tout l'historique qui le
   * nomme, et ferait échouer la relecture d'un envoi passé.
   *
   * `callers` est vide, et c'est le SIGNAL : plus aucun chemin métier ne
   * l'appelle. Les projets cessent de le déclarer à leur prochain démarrage,
   * il quitte leur vue active, son historique reste. Voir docs/PROTOCOL.md
   * § « RETIRER un modèle d'un projet ».
   *
   * `provisionForProjects` repasse à FAUX : un projet neuf n'a aucune raison
   * de recevoir d'office une instance d'un modèle que personne n'envoie plus.
   */
  CONTRACT_PAYMENT_RECEIVED_ADMIN: {
    scopes: [J],
    category: TEMPLATE_CATEGORIES.BILLING,
    provisionForProjects: false,
    retired: true,
    reason:
      'RETIRÉ (L12) au profit de PAYMENT_CONFIRMED_ADMIN, qui couvre tous les types de '
      + 'règlement et porte le lien de facture. Conservé pour la lisibilité des envois passés '
      + 'et des instances déjà posées.',
    callers: [],
  },

  /**
   * LA CONFIRMATION D'ENCAISSEMENT AU CLIENT — un seul modèle, tous les types.
   *
   * PROJECT sans hésitation : l'émetteur est le projet, le destinataire est SON
   * client, le message porte SON identité et SON apparence. Le Panel n'est ici
   * que le transporteur, exactement comme pour la réinitialisation de mot de
   * passe.
   */
  PAYMENT_CONFIRMED_ADMIN: {
    scopes: [J],
    category: TEMPLATE_CATEGORIES.BILLING,
    provisionForProjects: true,
    reason:
      'Le projet confirme un encaissement à SON client, sous SON identité, et lui donne sa '
      + 'facture. Un seul modèle pour les frais de lancement, l’abonnement et toute prestation '
      + 'à venir : la seule différence entre eux tient dans deux variables.',
    callers: [
      'PROJECT/utils/domainEventActionRegistry.js#notify-admins-launch-fee-paid',
      'PROJECT/utils/domainEventActionRegistry.js#notify-admins-subscription-paid',
    ],
  },

  CONTRACT_PAYMENT_OVERDUE_ADMIN: {
    scopes: [J],
    category: TEMPLATE_CATEGORIES.BILLING,
    provisionForProjects: true,
    reason:
      'Premier échec de prélèvement, annoncé PENDANT que le service fonctionne. Ne double '
      + 'aucun message du Panel : SITE_SUSPENDED_PAYMENT_DEFAULT_CLIENT ne parle qu’une fois '
      + 'le site déjà fermé.',
    callers: ['PROJECT/utils/domainEventActionRegistry.js#notify-admins-payment-overdue'],
  },

  CONTRACT_PAYMENT_OVERDUE_CRITICAL_ADMIN: {
    scopes: [J],
    category: TEMPLATE_CATEGORIES.BILLING,
    provisionForProjects: true,
    reason:
      'Dernier avertissement AVANT fermeture. C’est précisément l’instant que le Panel ne '
      + 'couvre pas : lui annonce la fermeture une fois confirmée.',
    callers: ['PROJECT/utils/domainEventActionRegistry.js#notify-admins-payment-overdue-critical'],
  },

  CONTRACT_PAYMENT_RECOVERED_ADMIN: {
    scopes: [J],
    category: TEMPLATE_CATEGORIES.BILLING,
    provisionForProjects: true,
    reason:
      'Referme le cycle d’impayé. Sans lui, le dernier message conservé par un client '
      + 'régularisé resterait une menace de fermeture.',
    callers: ['PROJECT/utils/domainEventActionRegistry.js#notify-admins-payment-recovered'],
  },

  /**
   * L'ALERTE TECHNIQUE — SECOND CAS D'ÉCOLE DU §16.
   *
   * L'événement naît dans un projet, ses variables aussi, et le code reste
   * PANEL : l'émetteur et le destinataire de cette communication sont
   * L.Y Solution. Un développeur NATIF du projet peut la recevoir — cela ne
   * change rien, pas plus que pour `CONTRACT_CANCELLATION_DEV_NOTIFICATION` :
   * ce qui décide, c'est QUI PARLE À QUI, pas où le fait est né.
   *
   * `provisionForProjects: false` : aucune instance projet n'a de sens pour un
   * message que le client ne doit jamais voir ni pouvoir éditer.
   */
  PLATFORM_INCIDENT_DEV_ALERT: {
    scopes: [P],
    category: TEMPLATE_CATEGORIES.TECHNICAL,
    provisionForProjects: false,
    reason:
      'Communication technique de L.Y Solution vers les développeurs responsables d’un '
      + 'projet — natifs et fédérés. Nomme des composants internes : elle ne porte jamais '
      + 'l’apparence du client.',
    callers: ['PROJECT/utils/domainEventActionRegistry.js#notify-devs-platform-incident'],
  },

  /**
   * UN PROJET DU PARC A PAYÉ — communication de L.Y Solution à L.Y Solution.
   *
   * ── POURQUOI `provisionForProjects: false`, ET POURQUOI ÇA COMPTE ────────
   *
   * Poser une instance de ce modèle chez chaque projet donnerait à chaque
   * client le droit d'éditer un message qui parle de LUI à quelqu'un d'AUTRE.
   * Ce n'est pas une commodité qu'on refuse : c'est une confusion de propriété
   * qu'on interdit. Une garde de recette le vérifie.
   *
   * Son unique appelant vit dans le Panel, sur le fait financier PROJETÉ — pas
   * sur un retour de navigateur, pas sur un événement du projet.
   */
  PROJECT_PAYMENT_CONFIRMED_SUPER_ADMIN: {
    scopes: [P],
    category: TEMPLATE_CATEGORIES.BILLING,
    provisionForProjects: false,
    reason:
      'Le Panel prévient SES exploitants qu’un client du parc a réglé. Le destinataire est '
      + 'un SUPER_ADMIN de L.Y Solution, le contenu nomme un client : rien de tout cela '
      + 'n’appartient au projet, et ce message ne porte jamais son apparence.',
    callers: ['Panel/services/finance/providerRevenue/paymentConfirmationAnnouncements.js'],
  },
});

/**
 * LA DÉFINITION D'UN CODE — le contrat, sans une ligne de HTML.
 *
 * Rend `null` pour un code inconnu : l'appelant décide s'il refuse (le service)
 * ou s'il l'ignore (un écran d'introspection).
 */
export function templateDefinition(templateCode) {
  if (!isKnownTemplateId(templateCode)) return null;
  const registry = getTemplateDefinition(templateCode);
  const ownership = TEMPLATE_OWNERSHIP[templateCode];
  const variables = variablesFor(templateCode);

  return Object.freeze({
    templateCode,
    description: registry.defaultDescription,
    category: ownership?.category ?? TEMPLATE_CATEGORIES.TECHNICAL,
    /** Les variables que ce message transporte. Le HTML peut n'en utiliser qu'une partie. */
    allowedVariables: Object.freeze(variables.map((v) => v.key)),
    /** Celles dont l'absence fait ÉCHOUER le rendu — jamais un trou silencieux. */
    requiredVariables: Object.freeze(variables.filter((v) => v.required).map((v) => v.key)),
    /** Les portées dans lesquelles une instance a le droit d'exister. */
    scopes: Object.freeze([...(ownership?.scopes ?? [P])]),
    provisionForProjects: Boolean(ownership?.provisionForProjects),
    retentionClass: registry.retentionClass ?? null,
    ownershipReason: ownership?.reason ?? '',
    callers: Object.freeze([...(ownership?.callers ?? [])]),
  });
}

/** Toutes les définitions, dans l'ordre STABLE du registre. */
export function listTemplateDefinitions() {
  return EMAIL_TEMPLATE_IDS.map((code) => templateDefinition(code));
}

/** Les codes dont une instance peut exister dans cette portée. */
export function codesForScopeType(scopeType) {
  return EMAIL_TEMPLATE_IDS.filter((code) => templateDefinition(code).scopes.includes(scopeType));
}

/** Les codes à POSER d'office quand un projet est ouvert au contenu scopé. */
export function codesToProvisionForProjects() {
  return EMAIL_TEMPLATE_IDS.filter((code) => templateDefinition(code).provisionForProjects);
}

/**
 * CE CODE A-T-IL LE DROIT D'EXISTER DANS CETTE PORTÉE ?
 *
 * ── POURQUOI CETTE GARDE, ALORS QUE LA PORTÉE EST DÉJÀ VALIDÉE ─────────────
 *
 * `assertScopeUsable` répond à « ce projet existe-t-il ». Celle-ci répond à
 * « cette communication lui appartient-elle ». Sans elle, un DEV pourrait créer
 * `PROJECT/<un client>/PAYMENT_REQUEST_CREATED` : un document que le runtime ne
 * consulterait jamais — la facturation part du Panel, en portée PANEL — mais
 * qu'un exploitant éditerait en croyant changer quelque chose. C'est exactement
 * la « surface fantôme » de l'audit, déplacée d'un cran.
 */
export function assertScopeAllowedForCode(templateCode, scope) {
  assertScopeCoherent(scope);
  const definition = templateDefinition(templateCode);

  if (!definition) {
    throw ApiError.notFound(
      'PANEL_EMAIL_TEMPLATE_UNKNOWN',
      `Modèle inconnu : « ${templateCode} ». Le registre est code-first — il ne s’enrichit pas depuis la base.`,
    );
  }

  if (!definition.scopes.includes(scope.scopeType)) {
    throw ApiError.badRequest(
      SCOPE_ERROR_CODES.FORBIDDEN_FOR_CODE,
      `« ${templateCode} » n’a pas d’instance en portée ${describeScope(scope)} : `
      + `cette communication appartient à ${definition.scopes.join(' et ')}. ${definition.ownershipReason}`,
    );
  }

  return definition;
}

/**
 * Cohérence de la classification — exercée par les tests.
 *
 * Elle garde trois choses qu'un humain casse en éditant ce fichier : un code du
 * registre oublié ici, une entrée qui ne correspond à aucun code, et une
 * classification `provisionForProjects` posée sur un code qui n'accepte pas la
 * portée PROJECT (elle poserait à chaque projet un document interdit).
 */
export function validateOwnershipClassification() {
  const problems = [];

  for (const code of EMAIL_TEMPLATE_IDS) {
    const ownership = TEMPLATE_OWNERSHIP[code];
    if (!ownership) {
      problems.push(`${code} : aucune classification d’ownership. Un code non classé n’a pas de portée.`);
      continue;
    }
    if (!Array.isArray(ownership.scopes) || ownership.scopes.length === 0) {
      problems.push(`${code} : aucune portée déclarée.`);
    }
    for (const scopeType of ownership.scopes ?? []) {
      if (scopeType !== P && scopeType !== J) problems.push(`${code} : portée inconnue « ${scopeType} ».`);
    }
    if (ownership.provisionForProjects && !ownership.scopes?.includes(J)) {
      problems.push(`${code} : provisionForProjects sans portée PROJECT.`);
    }
    if (!ownership.reason) problems.push(`${code} : classification sans motif écrit.`);

    /**
     * ══ UN CODE SANS APPELANT : FAUTE, OU RETRAIT DÉCLARÉ ? ═════════════════
     *
     * L'invariant d'origine était bon et le reste : une classification sans
     * appelant recensé n'est fondée sur RIEN — au mieux sur le nom du code, ce
     * que tout ce module existe pour interdire.
     *
     * Mais il rendait le RETRAIT impossible à exprimer. Un code remplacé garde
     * sa définition — son historique appartient aux projets qui l'ont utilisé,
     * et un envoi passé doit rester relisible — tout en n'ayant plus aucun
     * appelant. Sans marqueur, il ne restait que deux mauvaises issues :
     * supprimer la définition (et rendre l'historique illisible), ou inscrire
     * un appelant imaginaire pour faire taire le contrôle.
     *
     * `retired: true` est donc une DÉCLARATION, pas une exemption : elle exige
     * son propre motif, et elle interdit le provisionnement — un code retiré
     * qu'on poserait encore sur les projets neufs ne serait pas retiré.
     */
    const retire = ownership.retired === true;
    if (!Array.isArray(ownership.callers)
      || (ownership.callers.length === 0 && !retire)) {
      problems.push(`${code} : classification sans appelant recensé — elle serait fondée sur le nom.`);
    }
    if (retire && ownership.callers.length > 0) {
      problems.push(`${code} : déclaré retiré, mais des appelants sont recensés. L’un des deux ment.`);
    }
    if (retire && ownership.provisionForProjects) {
      problems.push(`${code} : déclaré retiré, et pourtant provisionné d’office. Un code retiré ne se pose plus.`);
    }
  }

  for (const code of Object.keys(TEMPLATE_OWNERSHIP)) {
    if (!isKnownTemplateId(code)) problems.push(`${code} : classé, mais absent du registre.`);
  }

  return problems;
}

/** Introspection SÛRE — la table de classification telle qu'un écran l'affiche. */
export function describeOwnership() {
  return listTemplateDefinitions().map((definition) => ({
    templateCode: definition.templateCode,
    category: definition.category,
    scopes: definition.scopes,
    provisionForProjects: definition.provisionForProjects,
    reason: definition.ownershipReason,
    callers: definition.callers,
    /** Conservé pour l'historique, plus appelé par personne. Voir le validateur. */
    retired: TEMPLATE_OWNERSHIP[definition.templateCode]?.retired === true,
    allowedVariables: definition.allowedVariables,
    requiredVariables: definition.requiredVariables,
  }));
}

export default {
  TEMPLATE_CATEGORIES,
  TEMPLATE_OWNERSHIP,
  assertScopeAllowedForCode,
  codesForScopeType,
  codesToProvisionForProjects,
  describeOwnership,
  listTemplateDefinitions,
  templateDefinition,
  validateOwnershipClassification,
};
