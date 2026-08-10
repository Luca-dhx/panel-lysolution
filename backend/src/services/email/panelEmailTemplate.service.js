// L'AUTORITÉ DE CONTENU DU PANEL — lire, écrire, rendre (L8.3).
//
// docs/architecture/BREVO_CONTROL_PLANE.md §« Templates ».
//
// ── LA RÈGLE D'HÉRITAGE, ET POURQUOI ELLE EST DANS UNE SEULE FONCTION ───────
//
//   contenu du projet   →  s'il existe
//   défaut de plateforme →  sinon
//   défaut du registre   →  si la base est vide (premier démarrage)
//
// Trois sources, une seule résolution : `resolveTemplate()`. Deux endroits qui
// choisiraient « quel contenu » finiraient par ne pas choisir le même, et
// l'aperçu montrerait autre chose que ce qui part.
//
// ── CE QUE LE MANAGER PEUT, ET CE QU'IL NE PEUT PAS ─────────────────────────
//
// Il peut réécrire ENTIÈREMENT un sujet et un HTML. Il ne peut NI inventer un
// code de template, NI inventer une variable : les deux produiraient une erreur
// silencieuse — un template que personne n'appelle, ou un trou à l'exécution.
// Le registre code-first tranche, la base ne fait que porter le texte.
import ApiError from '../../utils/ApiError.js';
import logger from '../../utils/logger.js';
import { nowIso } from '../../bridge/bridgeContract.js';
import PanelEmailTemplate from '../../models/PanelEmailTemplate.model.js';
import PanelEmailTemplateVersion from '../../models/PanelEmailTemplateVersion.model.js';
import {
  EMAIL_TEMPLATE_IDS,
  getTemplateDefinition,
  isKnownTemplateId,
  variablesFor,
} from './panelEmailTemplateRegistry.js';
import { validateTemplate } from './panelEmailTemplateValidator.js';
import { renderTemplate, EmailRenderError } from './panelEmailTemplateRenderer.js';
import { EMAIL_TEMPLATE_ERROR_CODES as E, MAX_TEMPLATE_VERSION_HISTORY } from '../../utils/panelEmailTemplateConstants.js';

/* -------------------------------------------------------------------------- */
/*  CATALOGUE                                                                 */
/* -------------------------------------------------------------------------- */

export function assertKnownTemplate(templateCode) {
  if (!isKnownTemplateId(templateCode)) {
    throw ApiError.notFound(
      'PANEL_EMAIL_TEMPLATE_UNKNOWN',
      `Modèle inconnu : « ${templateCode} ». Le registre est code-first — il ne s’enrichit pas depuis la base.`,
    );
  }
  return getTemplateDefinition(templateCode);
}

/** Les codes canoniques. Aucun n'est un identifiant de modèle Brevo. */
export function listTemplateCodes() {
  return [...EMAIL_TEMPLATE_IDS];
}

/** Les définitions, dans l'ordre STABLE du registre — celui des écrans. */
function listTemplateDefinitions() {
  return EMAIL_TEMPLATE_IDS.map((code) => getTemplateDefinition(code));
}

/* -------------------------------------------------------------------------- */
/*  AMORÇAGE                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Pose les défauts de plateforme manquants. IDEMPOTENT, et NON destructif :
 * un contenu déjà écrit n'est jamais réécrit — il a été rédigé par un humain,
 * et un déploiement ne doit pas l'effacer.
 */
export async function seedPlatformTemplates() {
  let created = 0;
  let existing = 0;

  for (const definition of listTemplateDefinitions()) {
    const present = await PanelEmailTemplate
      .findOne({ templateCode: definition.templateId, projectId: null }).lean();
    if (present) { existing += 1; continue; }

    const at = nowIso();
    await PanelEmailTemplate.create({
      templateCode: definition.templateId,
      projectId: null,
      name: definition.defaultName,
      description: definition.defaultDescription,
      subject: definition.defaultSubject,
      html: definition.defaultHtml,
      enabled: true,
      version: 1,
      createdAt: at,
      updatedAt: at,
    });
    await PanelEmailTemplateVersion.create({
      templateCode: definition.templateId,
      projectId: null,
      version: 1,
      name: definition.defaultName,
      description: definition.defaultDescription,
      subject: definition.defaultSubject,
      html: definition.defaultHtml,
      enabled: true,
      origin: 'BOOTSTRAP',
      createdAt: at,
    });
    created += 1;
  }

  if (created) logger.info(`[email] ${created} modèle(s) de plateforme amorcé(s).`);
  return { created, existing };
}

/* -------------------------------------------------------------------------- */
/*  RÉSOLUTION                                                                */
/* -------------------------------------------------------------------------- */

/**
 * LE CONTENU QUI PART RÉELLEMENT, pour ce projet.
 *
 * `projectId` peut être `null` — on lit alors le défaut de plateforme. C'est
 * la même fonction dans les deux cas, ce qui garantit que l'aperçu d'un DEV et
 * l'envoi d'un projet passent par le même chemin.
 */
export async function resolveTemplate(templateCode, { projectId = null } = {}) {
  const definition = assertKnownTemplate(templateCode);

  const own = projectId
    ? await PanelEmailTemplate.findOne({ templateCode, projectId }).lean()
    : null;
  const platform = await PanelEmailTemplate.findOne({ templateCode, projectId: null }).lean();
  const stored = own ?? platform;

  if (stored) {
    return {
      templateCode,
      /** D'où vient le texte — un exploitant doit pouvoir le lire. */
      source: own ? 'PROJECT' : 'PLATFORM',
      name: stored.name,
      description: stored.description,
      subject: stored.subject,
      html: stored.html,
      enabled: stored.enabled,
      version: stored.version,
      updatedAt: stored.updatedAt,
    };
  }

  /**
   * Base vide — premier démarrage, ou amorçage jamais joué. On rend le défaut
   * du REGISTRE plutôt que d'échouer : un e-mail attendu ne doit pas être
   * perdu parce qu'une migration n'a pas tourné. Le rendu reste identique,
   * puisque c'est ce même défaut que le seed aurait écrit.
   */
  return {
    templateCode,
    source: 'REGISTRY_DEFAULT',
    name: definition.defaultName,
    description: definition.defaultDescription,
    subject: definition.defaultSubject,
    html: definition.defaultHtml,
    enabled: true,
    version: 0,
    updatedAt: null,
  };
}

/* -------------------------------------------------------------------------- */
/*  RENDU                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Rend un template pour un envoi RÉEL.
 *
 * Un template désactivé fait ÉCHOUER l'appel : le refus est explicite, jamais
 * un envoi silencieusement sauté. Couper un e-mail est une décision — la
 * découvrir dans l'absence de message n'en est pas une.
 */
export async function renderForSend({ templateCode, projectId, variables = {} }) {
  const template = await resolveTemplate(templateCode, { projectId });

  if (!template.enabled) {
    throw ApiError.conflict(
      'PANEL_EMAIL_TEMPLATE_DISABLED',
      `Le modèle « ${templateCode} » est désactivé : aucun envoi n’est effectué.`,
    );
  }

  try {
    const rendered = renderTemplate({
      templateId: templateCode,
      template: { subject: template.subject, html: template.html },
      variables,
    });
    return { ...rendered, version: template.version, source: template.source };
  } catch (error) {
    const details = error instanceof EmailRenderError ? error.details : [];
    throw ApiError.badRequest(
      error?.code ?? E.RENDER_FAILED,
      `Rendu impossible pour « ${templateCode} ».`,
      details,
    );
  }
}

/**
 * APERÇU — même moteur, données d'exemple.
 *
 * Il passe par `renderTemplate` et non par une simulation : un aperçu qui
 * emprunterait un chemin plus permissif montrerait un rendu que l'envoi
 * refuserait, et l'on croirait le template bon.
 */
export async function previewTemplate(templateCode, { projectId = null, variables = null } = {}) {
  const definition = assertKnownTemplate(templateCode);
  const template = await resolveTemplate(templateCode, { projectId });
  const rendered = renderTemplate({
    templateId: templateCode,
    template: { subject: template.subject, html: template.html },
    variables: variables ?? definition.sampleVariables,
  });
  return { ...rendered, source: template.source, version: template.version };
}

/* -------------------------------------------------------------------------- */
/*  ÉCRITURE                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Enregistre un contenu — pour la plateforme, ou pour UN projet.
 *
 * ── LE JETON D'ÉDITION ──────────────────────────────────────────────────────
 * `expectedVersion` refuse une écriture bâtie sur un contenu périmé. Deux DEV
 * qui éditent le même modèle en même temps ne doivent pas silencieusement
 * s'écraser : le second est refusé et relit.
 */
export async function saveTemplate(templateCode, { projectId = null, subject, html, name, description, enabled, expectedVersion }, actor = {}) {
  assertKnownTemplate(templateCode);

  const current = await resolveTemplate(templateCode, { projectId });
  const next = {
    name: name ?? current.name,
    description: description ?? current.description,
    subject: subject ?? current.subject,
    html: html ?? current.html,
    enabled: enabled === undefined ? current.enabled : Boolean(enabled),
  };

  if (expectedVersion !== undefined && Number(expectedVersion) !== current.version) {
    throw ApiError.conflict(
      'PANEL_EMAIL_TEMPLATE_VERSION_CONFLICT',
      `Ce modèle a été modifié depuis votre dernière lecture (version ${current.version}). Relisez avant d’enregistrer.`,
    );
  }

  // La validation porte sur le CONTENU FUSIONNÉ, pas sur les champs reçus :
  // écrire un sujet valide sur un HTML devenu invalide doit échouer.
  const verdict = validateTemplate({ templateId: templateCode, subject: next.subject, html: next.html });
  if (!verdict.valid) {
    throw ApiError.badRequest(
      'PANEL_EMAIL_TEMPLATE_INVALID',
      'Modèle refusé : le contenu ne respecte pas les règles de sécurité ou de variables.',
      verdict.errors,
    );
  }

  const at = nowIso();
  const version = current.version + 1;
  const actorId = actor.userId ?? null;

  await PanelEmailTemplate.updateOne(
    { templateCode, projectId },
    {
      $set: { ...next, version, updatedAt: at, updatedBy: actorId },
      $setOnInsert: { createdAt: at },
    },
    { upsert: true },
  );

  await PanelEmailTemplateVersion.create({
    templateCode, projectId, version, ...next,
    changedBy: actorId,
    changedByLabel: actor.userEmail ?? '',
    origin: 'EDIT',
    createdAt: at,
  });

  await pruneHistory(templateCode, projectId);

  // On NOMME ce qui a été touché, jamais son contenu : un sujet rendu porterait
  // le nom d'un destinataire.
  logger.info(
    `[email] modèle ${templateCode}${projectId ? ` (projet ${projectId})` : ' (plateforme)'} `
    + `enregistré en version ${version}.`,
  );

  return resolveTemplate(templateCode, { projectId });
}

/**
 * RESTAURE une version — en en créant une NOUVELLE.
 *
 * On ne remonte pas le temps : l'historique est un fait daté. Une restauration
 * malheureuse doit pouvoir être annulée à son tour, ce qu'un écrasement
 * interdirait.
 */
export async function restoreVersion(templateCode, version, { projectId = null } = {}, actor = {}) {
  assertKnownTemplate(templateCode);
  const source = await PanelEmailTemplateVersion
    .findOne({ templateCode, projectId, version: Number(version) }).lean();
  if (!source) {
    throw ApiError.notFound(
      'PANEL_EMAIL_TEMPLATE_VERSION_UNKNOWN',
      `Version ${version} introuvable pour « ${templateCode} ».`,
    );
  }

  const current = await resolveTemplate(templateCode, { projectId });
  const at = nowIso();
  const nextVersion = current.version + 1;

  await PanelEmailTemplate.updateOne(
    { templateCode, projectId },
    {
      $set: {
        name: source.name, description: source.description,
        subject: source.subject, html: source.html, enabled: source.enabled,
        version: nextVersion, updatedAt: at, updatedBy: actor.userId ?? null,
      },
      $setOnInsert: { createdAt: at },
    },
    { upsert: true },
  );
  await PanelEmailTemplateVersion.create({
    templateCode, projectId, version: nextVersion,
    name: source.name, description: source.description,
    subject: source.subject, html: source.html, enabled: source.enabled,
    changedBy: actor.userId ?? null, changedByLabel: actor.userEmail ?? '',
    origin: 'RESTORE', restoredFromVersion: source.version,
    createdAt: at,
  });
  await pruneHistory(templateCode, projectId);

  return resolveTemplate(templateCode, { projectId });
}

/** L'historique ne grossit pas sans fin : au-delà du plafond, le plus ancien part. */
async function pruneHistory(templateCode, projectId) {
  const total = await PanelEmailTemplateVersion.countDocuments({ templateCode, projectId });
  if (total <= MAX_TEMPLATE_VERSION_HISTORY) return;
  const surplus = await PanelEmailTemplateVersion
    .find({ templateCode, projectId })
    .sort({ version: 1 })
    .limit(total - MAX_TEMPLATE_VERSION_HISTORY)
    .select('_id')
    .lean();
  await PanelEmailTemplateVersion.deleteMany({ _id: { $in: surplus.map((v) => v._id) } });
}

export async function listVersions(templateCode, { projectId = null, limit = 20 } = {}) {
  assertKnownTemplate(templateCode);
  return PanelEmailTemplateVersion
    .find({ templateCode, projectId })
    .sort({ version: -1 })
    .limit(Math.min(Number(limit) || 20, MAX_TEMPLATE_VERSION_HISTORY))
    .lean();
}

/* -------------------------------------------------------------------------- */
/*  VUE                                                                       */
/* -------------------------------------------------------------------------- */

/** Le catalogue tel qu'un écran d'édition le consomme. */
export async function describeTemplates({ projectId = null } = {}) {
  const items = [];
  for (const definition of listTemplateDefinitions()) {
    const resolved = await resolveTemplate(definition.templateId, { projectId });
    items.push({
      templateCode: definition.templateId,
      label: definition.defaultName,
      description: resolved.description,
      subject: resolved.subject,
      enabled: resolved.enabled,
      version: resolved.version,
      source: resolved.source,
      updatedAt: resolved.updatedAt,
      retentionClass: definition.retentionClass ?? null,
      /** Les variables AUTORISÉES — l'écran les rend, il ne les devine pas. */
      variables: variablesFor(definition.templateId).map((v) => ({
        key: v.key, label: v.label, description: v.description,
        type: v.type, required: v.required,
      })),
    });
  }
  return items;
}

export default {
  listTemplateCodes,
  assertKnownTemplate,
  seedPlatformTemplates,
  resolveTemplate,
  renderForSend,
  previewTemplate,
  saveTemplate,
  restoreVersion,
  listVersions,
  describeTemplates,
};
