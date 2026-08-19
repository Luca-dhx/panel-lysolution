// LA FAÇADE D'ÉDITION — catalogue, aperçu, readiness, test, historique (L11.1).
//
// docs/email/EMAIL_TEMPLATE_MULTI_PROJECT_IMPLEMENTATION_REPORT.md §« Éditeur ».
//
// ── CE QUI A CHANGÉ ─────────────────────────────────────────────────────────
//
// Toutes les fonctions prennent désormais une PORTÉE. Avant L11.1, quatre
// d'entre elles codaient `projectId: null` en dur — dont
// `getEditableTemplateVersion` et `restoreEditableTemplateVersion`, qui
// passaient littéralement `{}`. Conséquence : une portée projet, une fois
// créée, était irrestaurable depuis l'IHM (incohérence n°10 de l'audit).
//
// ── LA PORTÉE VIENT DE L'APPELANT, ET L'APPELANT VIENT DU SERVEUR ───────────
//
// Ce module ne lit AUCUN paramètre de requête. Il reçoit un objet de portée
// déjà construit et déjà validé par `resolveScope` (middleware), qui est le
// seul endroit du Panel où une chaîne venue du réseau devient une portée.
import crypto from 'node:crypto';

import ApiError from '../../utils/ApiError.js';
import logger from '../../utils/logger.js';
import { describeAvailability } from '../integratedApi/controlPlane.service.js';
import { runtimeEnvironment } from '../integratedApi/environment.js';
import { invokeCapability } from '../capabilities/capabilityGateway.service.js';
import { INVOCATION_SOURCES } from '../capabilities/invocationContext.js';
import { CAPABILITY_ERROR_CODES } from '../capabilities/capabilityErrors.js';
import { describeGlobalSender, resolveGlobalSender } from './panelGlobalSender.service.js';
import {
  assertKnownTemplate,
  declaredCodesForProject,
  describeTemplates,
  draftTemplate,
  getVersion,
  listVersions,
  previewTemplate,
  restoreVersion,
  saveTemplate,
} from './panelEmailTemplate.service.js';
import { templateDefinition } from './panelEmailTemplateDefinitions.js';
import { SCOPE_TYPES, describeScope, panelScope } from './panelEmailTemplateScope.js';
import { sampleVariablesFor, variablesFor } from './panelEmailTemplateRegistry.js';
import { validateTemplate } from './panelEmailTemplateValidator.js';
import { renderTemplate, EmailRenderError } from './panelEmailTemplateRenderer.js';
import PanelProject from '../../models/PanelProject.model.js';
import { PanelProjectEmailTemplateUsage } from '../../models/PanelProjectProjection.model.js';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function serializeVariables(templateCode) {
  return variablesFor(templateCode).map((variable) => ({
    key: variable.key,
    label: variable.label,
    description: variable.description,
    type: variable.type,
    required: variable.required,
  }));
}

function serializeValidation(templateCode, template) {
  return validateTemplate({
    templateId: templateCode,
    subject: template.subject,
    html: template.html,
  });
}

/** La portée, telle qu'un écran l'affiche. Jamais un identifiant nu. */
function serializeScope(scope) {
  return {
    scopeType: scope.scopeType,
    scopeId: scope.scopeId,
    label: describeScope(scope),
  };
}

function renderErrorPayload(error) {
  return {
    code: error?.code ?? 'PANEL_EMAIL_TEMPLATE_RENDER_FAILED',
    message: error?.message ?? 'Rendu impossible.',
    details: error instanceof EmailRenderError ? error.details : [],
  };
}

function blocker(code, message) {
  return { code, message };
}

function providerReadinessBlocker(availability) {
  switch (availability.reason) {
    case 'NOT_CONFIGURED':
      return blocker(
        'PROVIDER_NOT_CONFIGURED',
        'Brevo n’est pas configuré ou ses identifiants ne sont pas complets dans le Panel.',
      );
    case 'NOT_VALIDATED':
    case 'VALIDATION_STALE':
      return blocker(
        'PROVIDER_NOT_VALIDATED',
        'Brevo est configuré mais sa validation n’est pas encore considérée fiable sur cette instance.',
      );
    case 'INVALID_CREDENTIALS':
      return blocker(
        'PROVIDER_INVALID_CREDENTIALS',
        'Brevo refuse les identifiants enregistrés : le test d’envoi doit être rejoué après correction.',
      );
    case 'PROVIDER_UNREACHABLE':
      return blocker(
        'PROVIDER_UNREACHABLE',
        'Brevo est actuellement injoignable depuis cette instance du Panel.',
      );
    default:
      return blocker('PROVIDER_UNAVAILABLE', 'Brevo n’est pas disponible pour cet envoi.');
  }
}

/**
 * LES PORTÉES ADMINISTRABLES — ce que le sélecteur de l'écran propose.
 *
 * Le Panel DEV administre tout le parc : la portée PANEL, et une portée par
 * projet du registre. C'est le serveur qui énumère, jamais l'écran : une liste
 * construite côté client serait une liste qu'un client peut inventer.
 */
export async function listAdministrableScopes() {
  /**
   * `commercialState` A ÉTÉ RETIRÉ DE CETTE PROJECTION.
   *
   * Le champ accompagnait le statut d'appairage dans le sélecteur de portée. Il
   * a quitté le schéma `PanelProject` avec la suppression de l'ouverture
   * commerciale : le `select()` ne ramenait plus rien, et chaque portée sortait
   * d'ici avec `commercialState: null`. Un champ toujours nul est pire qu'un
   * champ absent — il se lit comme une information, et invite à « réparer » ce
   * qui a été délibérément supprimé. Aucun écran ne le consommait.
   */
  const projects = await PanelProject
    .find({})
    .select('projectId projectName pairing.status')
    .sort({ projectName: 1 })
    .lean();

  /** Une seule requête pour tout le parc — jamais une par projet. */
  const declarations = await PanelProjectEmailTemplateUsage
    .find({}).select('projectId templateCodes revision declaredAt lastReconciliation').lean();
  const declarationsParProjet = new Map(declarations.map((d) => [d.projectId, {
    templateCodes: d.templateCodes ?? [],
    count: (d.templateCodes ?? []).length,
    revision: d.revision,
    declaredAt: d.declaredAt ?? null,
    unknown: d.lastReconciliation?.unknown ?? [],
    forbidden: d.lastReconciliation?.forbidden ?? [],
    reconciledAt: d.lastReconciliation?.at ?? null,
  }]));

  return [
    {
      scopeType: SCOPE_TYPES.PANEL,
      scopeId: null,
      label: 'Panel — L.Y Solution',
      pairingStatus: null,
    },
    ...projects.map((project) => ({
      scopeType: SCOPE_TYPES.PROJECT,
      scopeId: project.projectId,
      label: project.projectName || project.projectId,
      pairingStatus: project.pairing?.status ?? null,
      /**
       * CE QUE CE PROJET DÉCLARE UTILISER — pour que le sélecteur puisse dire
       * « 9 modèles utilisés » sans ouvrir la portée, et surtout pour rendre
       * visible le cas qui compte : un projet qui n'a jamais déclaré.
       *
       * `null` se lit « ce projet n'a rien annoncé » — un projet antérieur au
       * lot, ou éteint depuis. Ce n'est PAS « zéro modèle », et l'écran ne doit
       * pas les confondre.
       */
      declaration: declarationsParProjet.get(project.projectId) ?? null,
    })),
  ];
}

export async function listEditableTemplates(scope) {
  const templates = await describeTemplates(scope);
  return templates.map((template) => {
    const validation = serializeValidation(template.templateCode, template);
    return {
      templateId: template.templateCode,
      name: template.label,
      description: template.description,
      enabled: template.enabled,
      /** Aucune instance dans cette portée : l'écran doit le montrer, pas le masquer. */
      configured: template.configured,
      valid: validation.valid,
      errorCount: validation.errors.length,
      variableCount: template.variables.length,
      version: template.version,
      source: template.source,
      category: template.category,
      scopes: template.scopes,
      scope: serializeScope(scope),
      /**
       * CE PROJET LE DÉCLARE-T-IL ENCORE ? — trois valeurs, trois sens.
       *
       *   true   le projet l'utilise : modèle ACTIF, à présenter en premier ;
       *   false  il ne l'utilise plus : contenu conservé, rangé à part ;
       *   null   aucune déclaration reçue — le projet n'a rien dit, et l'écran
       *          n'a donc rien à ranger. À ne surtout pas lire comme `false`.
       */
      declared: template.declared ?? null,
      updatedAt: template.updatedAt,
    };
  });
}

export async function getEditableTemplate(templateCode, scope) {
  assertKnownTemplate(templateCode);
  const template = await draftTemplate(templateCode, scope);
  const contract = templateDefinition(templateCode);

  /**
   * L'écran de détail doit pouvoir dire « ce projet ne déclare plus ce
   * modèle ». Sans cela, il afficherait un contenu parfaitement valide sans
   * jamais mentionner que tout envoi en est refusé.
   */
  const declares = scope.scopeType === SCOPE_TYPES.PROJECT
    ? await declaredCodesForProject(scope.scopeId)
    : null;

  return {
    templateId: templateCode,
    declared: declares === null ? null : declares.includes(templateCode),
    name: template.name,
    description: template.description,
    subject: template.subject,
    html: template.html,
    enabled: template.enabled,
    configured: template.configured,
    version: template.version,
    source: template.source,
    scope: serializeScope(scope),
    /** Le CONTRAT — ce que ce code transporte, quelle que soit la portée. */
    contract: {
      category: contract.category,
      scopes: contract.scopes,
      allowedVariables: contract.allowedVariables,
      requiredVariables: contract.requiredVariables,
      ownershipReason: contract.ownershipReason,
    },
    updatedAt: template.updatedAt,
    validation: serializeValidation(templateCode, template),
    variables: serializeVariables(templateCode),
  };
}

export async function updateEditableTemplate(templateCode, scope, patch, actor = {}) {
  await saveTemplate(templateCode, scope, patch, actor);
  return getEditableTemplate(templateCode, scope);
}

export async function previewEditableTemplate(templateCode, scope, draft = {}) {
  assertKnownTemplate(templateCode);
  const stored = await draftTemplate(templateCode, scope);
  const subject = draft.subject ?? stored.subject;
  const html = draft.html ?? stored.html;
  const validation = validateTemplate({ templateId: templateCode, subject, html });
  const sampleVariables = Object.fromEntries(sampleVariablesFor(templateCode));

  if (!validation.valid) {
    return {
      templateId: templateCode,
      scope: serializeScope(scope),
      subject: null,
      html: null,
      validation,
      sampleVariables,
      renderError: null,
    };
  }

  try {
    const rendered = renderTemplate({
      templateId: templateCode,
      template: { subject, html },
      variables: sampleVariablesFor(templateCode),
    });
    return {
      templateId: templateCode,
      scope: serializeScope(scope),
      subject: rendered.subject,
      html: rendered.html,
      usedVariables: rendered.usedVariables,
      version: stored.version,
      configured: stored.configured,
      validation,
      sampleVariables,
      renderError: null,
    };
  } catch (error) {
    return {
      templateId: templateCode,
      scope: serializeScope(scope),
      subject: null,
      html: null,
      validation,
      sampleVariables,
      renderError: renderErrorPayload(error),
    };
  }
}

export async function describeTemplateReadiness(templateCode, scope) {
  assertKnownTemplate(templateCode);
  const [template, sender, availability] = await Promise.all([
    draftTemplate(templateCode, scope),
    describeGlobalSender(),
    describeAvailability('BREVO'),
  ]);

  const validation = serializeValidation(templateCode, template);
  const blockers = [];
  const warnings = [];

  /**
   * L'ABSENCE D'INSTANCE EST UN BLOCAGE, PAS UN AVERTISSEMENT (L11.1).
   *
   * C'est la contrepartie visible du fail-closed : un modèle non configuré pour
   * cette portée ne partira pas, et l'écran doit le dire AVANT que le DEV ne
   * saisisse une adresse de test — pas après un refus de la passerelle.
   */
  if (!template.configured && scope.scopeType === SCOPE_TYPES.PROJECT) {
    blockers.push(blocker(
      'TEMPLATE_NOT_CONFIGURED',
      `Aucun modèle « ${templateCode} » n’est configuré pour ${describeScope(scope)} : `
      + 'enregistrez-en un. Le contenu du Panel ne sera jamais servi à sa place.',
    ));
  }
  if (!template.enabled) {
    blockers.push(blocker('TEMPLATE_DISABLED', `Le template « ${templateCode} » est désactivé.`));
  }
  if (!validation.valid) {
    blockers.push(blocker(
      'TEMPLATE_INVALID',
      `Le template « ${templateCode} » contient ${validation.errors.length} erreur(s) de validation.`,
    ));
  }
  if (!sender.configured) {
    blockers.push(blocker(
      'SENDER_NOT_CONFIGURED',
      sender.problems.join(' ') || 'Aucun expéditeur global exploitable n’est configuré.',
    ));
  }
  if (!availability.available) {
    blockers.push(providerReadinessBlocker(availability));
  }

  return {
    ready: blockers.length === 0,
    blockers,
    warnings,
    context: {
      provider: 'BREVO',
      providerMode: availability.environment ?? runtimeEnvironment(),
      sender: {
        email: sender.senderEmail,
        name: sender.senderName,
      },
      scope: serializeScope(scope),
      template: {
        templateId: templateCode,
        version: template.version,
        enabled: template.enabled,
        configured: template.configured,
        name: template.name,
      },
    },
  };
}

/**
 * ENVOI DE TEST — la chaîne d'exécution RÉELLE, y compris pour une portée projet.
 *
 * ── POURQUOI PASSER PAR LA PASSERELLE, ET PAS PAR UN ENVOI DIRECT ──────────
 *
 * Un corps fabriqué à la volée réussirait là où un envoi réel échouerait : il
 * sauterait la résolution scopée, la validation des variables, l'expéditeur et
 * le coffre. Le test-send du Panel était déjà exemplaire sur ce point — L11.1
 * ne fait que l'étendre aux portées projet, sans créer de second chemin.
 *
 * ── COMMENT UNE PORTÉE PROJET EST TESTÉE SANS FALSIFIER L'IDENTITÉ ─────────
 *
 * `PANEL_INTERNAL` : le Panel agit POUR un projet, sans que le projet demande
 * rien — exactement la source prévue pour le remboursement depuis l'onglet
 * Finances. Le projet reste le périmètre entier (monde, coffre, journal), et la
 * portée du modèle en découle par `scopeOfInvocationContext`. Le seul relâchement
 * est l'octroi, qui répond à « ce projet peut-il DEMANDER ceci » — question sans
 * objet quand c'est un opérateur du Panel qui clique.
 */
export async function sendTemplateTestEmail(templateCode, scope, recipientEmail) {
  assertKnownTemplate(templateCode);
  const recipient = String(recipientEmail ?? '').trim().toLowerCase();
  if (!recipient || !EMAIL_RE.test(recipient)) {
    throw ApiError.badRequest(
      'PANEL_EMAIL_TEMPLATE_TEST_RECIPIENT_INVALID',
      `Adresse destinataire invalide : « ${recipientEmail ?? ''} ».`,
    );
  }

  const readiness = await describeTemplateReadiness(templateCode, scope);
  if (!readiness.ready) {
    throw ApiError.conflict(
      'PANEL_EMAIL_TEMPLATE_TEST_NOT_READY',
      'Le template ne peut pas être envoyé en l’état.',
      readiness,
    );
  }

  const sender = await resolveGlobalSender();
  const operationId = `panel-template-test-${crypto.randomUUID()}`;

  const panelProject = scope.scopeType === SCOPE_TYPES.PROJECT
    ? await PanelProject.findOne({ projectId: scope.scopeId }).lean()
    : null;

  if (scope.scopeType === SCOPE_TYPES.PROJECT && !panelProject) {
    throw ApiError.notFound(
      'PANEL_EMAIL_TEMPLATE_SCOPE_PROJECT_UNKNOWN',
      `Aucun projet « ${scope.scopeId} » au registre : aucun envoi de test ne peut être fait pour lui.`,
    );
  }

  try {
    const outcome = await invokeCapability({
      code: 'email.send_template',
      panelProject,
      source: panelProject ? INVOCATION_SOURCES.PANEL_INTERNAL : INVOCATION_SOURCES.PANEL_SELF,
      payload: {
        templateRef: templateCode,
        recipient: { email: recipient },
        variables: Object.fromEntries(sampleVariablesFor(templateCode)),
        operationId,
      },
    });

    logger.info(`[email] test du template ${templateCode} (${describeScope(scope)}) accepté (${operationId}).`);
    return {
      operationId,
      templateId: templateCode,
      scope: serializeScope(scope),
      providerMessageId: outcome?.result?.providerMessageId ?? null,
      /** LA PORTÉE ET LA VERSION RÉELLEMENT EXPÉDIÉES — rendues par l'adaptateur. */
      templateScope: outcome?.result?.templateScope ?? null,
      templateScopeId: outcome?.result?.templateScopeId ?? null,
      templateVersion: outcome?.result?.templateVersion ?? null,
      sender: outcome?.result?.sender ?? {
        email: sender.senderEmail,
        name: sender.senderName,
      },
      message: 'L’e-mail a été accepté par Brevo pour envoi.',
      readiness,
    };
  } catch (error) {
    if (error?.code === CAPABILITY_ERROR_CODES.TIMEOUT) {
      throw ApiError.conflict(
        'PANEL_EMAIL_TEMPLATE_TEST_UNKNOWN',
        'Issue indéterminée : la plateforme n’a pas pu confirmer si le message est parti.',
      );
    }
    throw ApiError.badRequest(
      error?.code ?? 'PANEL_EMAIL_TEMPLATE_TEST_REFUSED',
      error?.message ?? 'L’envoi de test a été refusé.',
    );
  }
}

export async function listEditableTemplateVersions(templateCode, scope) {
  assertKnownTemplate(templateCode);
  const versions = await listVersions(templateCode, scope);
  return versions.map((version) => ({
    version: version.version,
    name: version.name,
    description: version.description,
    enabled: version.enabled,
    origin: version.origin,
    restoredFromVersion: version.restoredFromVersion ?? null,
    changedByLabel: version.changedByLabel ?? '',
    createdAt: version.createdAt,
  }));
}

export async function getEditableTemplateVersion(templateCode, scope, version) {
  assertKnownTemplate(templateCode);
  const document = await getVersion(templateCode, scope, version);

  if (!document) {
    throw ApiError.notFound(
      'PANEL_EMAIL_TEMPLATE_VERSION_UNKNOWN',
      `Version ${version} introuvable pour « ${templateCode} » en portée ${describeScope(scope)}.`,
    );
  }

  return {
    templateId: templateCode,
    scope: serializeScope(scope),
    version: document.version,
    name: document.name,
    description: document.description,
    subject: document.subject,
    html: document.html,
    enabled: document.enabled,
    origin: document.origin,
    restoredFromVersion: document.restoredFromVersion ?? null,
    changedByLabel: document.changedByLabel ?? '',
    createdAt: document.createdAt,
    validation: validateTemplate({
      templateId: templateCode,
      subject: document.subject,
      html: document.html,
    }),
  };
}

export async function restoreEditableTemplateVersion(templateCode, scope, version, actor = {}) {
  await restoreVersion(templateCode, scope, version, actor);
  return getEditableTemplate(templateCode, scope);
}

/**
 * L'APERÇU D'UN CODE DANS TOUTES SES PORTÉES — la recette du §25, en lecture.
 *
 * Un opérateur qui doute (« SB Auto reçoit-il vraiment SON texte ? ») lit ici
 * les trois documents côte à côte, avec leur sujet et leur version. Aucun rendu
 * n'est fait : ce sont des sujets STOCKÉS, jamais des sujets rendus, qui
 * porteraient le nom d'un destinataire.
 */
export async function compareScopesForCode(templateCode) {
  assertKnownTemplate(templateCode);
  const contract = templateDefinition(templateCode);
  const scopes = await listAdministrableScopes();

  const rows = [];
  for (const entry of scopes) {
    const scope = entry.scopeType === SCOPE_TYPES.PANEL
      ? panelScope()
      : { scopeType: SCOPE_TYPES.PROJECT, scopeId: entry.scopeId };
    if (!contract.scopes.includes(scope.scopeType)) continue;

    const template = await draftTemplate(templateCode, scope);
    rows.push({
      scope: serializeScope(scope),
      label: entry.label,
      configured: template.configured,
      subject: template.subject,
      version: template.version,
      enabled: template.enabled,
      source: template.source,
      updatedAt: template.updatedAt,
    });
  }

  return { templateId: templateCode, contract, rows };
}

export default {
  compareScopesForCode,
  describeTemplateReadiness,
  getEditableTemplate,
  getEditableTemplateVersion,
  listAdministrableScopes,
  listEditableTemplateVersions,
  listEditableTemplates,
  previewEditableTemplate,
  restoreEditableTemplateVersion,
  sendTemplateTestEmail,
  updateEditableTemplate,
};
