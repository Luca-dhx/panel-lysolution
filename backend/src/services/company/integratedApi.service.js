// SERVICE INTEGRATED API — Phase 4, LOT 4.
//
// Le Panel est le COFFRE des accès tiers de l'entreprise. Les projets ne
// détiennent plus leurs propres clés : ils reçoivent celles auxquelles ils
// sont autorisés, dans le mode qui correspond au leur.
//
// ── LES QUATRE RÈGLES ───────────────────────────────────────────────────────
//
//  1. Un secret est chiffré au repos (AES-256-GCM, clé du Panel).
//  2. Un secret ne sort JAMAIS par /api. L'administration voit le
//     fournisseur, le mode, les empreintes, les autorisations — pas les
//     valeurs.
//  3. Un secret ne part vers un projet que s'il lui est nommément accordé,
//     et par une écriture de journal qui porte SON identifiant en
//     destinataire (`audience`). Un autre projet ne peut pas la tirer.
//  4. Le mode suit le PROJET, pas le Panel : un projet en TEST reçoit les
//     identifiants TEST, quoi qu'affiche l'écran d'administration. C'est
//     exactement le genre de confusion qui met une clé de production dans un
//     site de recette.
//
// Les quatre sont vérifiées par test.
import { randomUUID, createHash } from 'node:crypto';

import PanelIntegratedApi from '../../models/PanelIntegratedApi.model.js';
import ApiError from '../../utils/ApiError.js';
import { nowIso } from '../../bridge/bridgeContract.js';
import { encryptSecret, decryptSecret } from '../../utils/panelCrypto.js';
import { getProjectOrThrow, listProjects } from '../registry/projectRegistry.service.js';
import { emitChange } from '../sync/syncCore.service.js';
import { recordEvent, EVENT_TYPES } from '../supervision/timeline.service.js';
import { getActiveCompanyOrThrow } from './company.service.js';

const API_ENTITY = 'INTEGRATED_API_CONFIG';
const KEY_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/* -------------------------------------------------------------------------- */
/*  LECTURE                                                                   */
/* -------------------------------------------------------------------------- */

export async function listApis(companyId) {
  const apis = await PanelIntegratedApi.find({ companyId }).sort({ key: 1 }).lean();
  return apis.map(describeApi);
}

export async function getApiOrThrow(apiId) {
  const api = await PanelIntegratedApi.findOne({ apiId }).lean();
  if (!api) throw ApiError.notFound('PANEL_INTEGRATED_API_NOT_FOUND', 'API intégrée inconnue.');
  return api;
}

/**
 * Vue d'administration. Ne contient AUCUNE valeur de secret — seulement le
 * nom des clés renseignées et leur empreinte courte, ce qui suffit à vérifier
 * qu'on a bien remplacé une clé sans jamais la révéler.
 */
export function describeApi(api) {
  const modeView = (mode) => {
    const set = api.credentials?.[mode] ?? {};
    const values = toObject(set.values);
    const fingerprints = toObject(set.fingerprints);
    return {
      configured: Object.keys(values).length > 0,
      keys: Object.keys(values).sort(),
      fingerprints,
      updatedAt: set.updatedAt ?? null,
    };
  };
  return {
    apiId: api.apiId,
    companyId: api.companyId,
    key: api.key,
    label: api.label,
    provider: api.provider,
    description: api.description,
    category: api.category,
    mode: api.mode,
    enabled: api.enabled,
    settings: api.settings ?? {},
    credentials: { TEST: modeView('TEST'), PROD: modeView('PROD') },
    grants: (api.grants ?? []).map((g) => ({
      projectId: g.projectId,
      projectName: g.projectName,
      keys: g.keys ?? [],
      grantedAt: g.grantedAt,
    })),
    createdAt: api.createdAt,
    updatedAt: api.updatedAt,
  };
}

/* -------------------------------------------------------------------------- */
/*  ÉCRITURE                                                                  */
/* -------------------------------------------------------------------------- */

export async function createApi(input, actor = {}) {
  const company = await getActiveCompanyOrThrow();
  const key = String(input?.key ?? '').trim().toLowerCase();
  if (!KEY_RE.test(key)) {
    throw ApiError.badRequest('PANEL_INTEGRATED_API_KEY_INVALID',
      `API refusée parce que l’identifiant « ${input?.key ?? ''} » n’est pas un slug (minuscules, chiffres, tirets).`);
  }
  if (!input?.label || !input?.provider) {
    throw ApiError.badRequest('PANEL_INTEGRATED_API_INCOMPLETE',
      'API refusée parce que le libellé et le fournisseur sont obligatoires.');
  }
  if (await PanelIntegratedApi.exists({ companyId: company.companyId, key })) {
    throw ApiError.conflict('PANEL_INTEGRATED_API_KEY_TAKEN',
      `API refusée parce que l’identifiant « ${key} » est déjà utilisé par cette entreprise.`);
  }

  const at = nowIso();
  const api = await PanelIntegratedApi.create({
    apiId: randomUUID(),
    companyId: company.companyId,
    key,
    label: String(input.label).trim(),
    provider: String(input.provider).trim(),
    description: input.description ?? null,
    category: input.category ?? 'OTHER',
    mode: input.mode === 'PROD' ? 'PROD' : 'TEST',
    enabled: input.enabled !== false,
    settings: input.settings ?? {},
    createdAt: at,
    updatedAt: at,
    updatedBy: actor.userId ?? null,
  });
  return describeApi(api.toObject());
}

/**
 * Enregistre les identifiants d'un mode.
 *
 * Une valeur vide n'efface pas : elle laisse la clé existante en place. Sans
 * cela, un formulaire d'administration qui masque les secrets les effacerait
 * à chaque enregistrement — c'est le piège classique de ce genre d'écran.
 * Pour retirer une clé, il faut la nommer dans `remove`.
 */
export async function setCredentials(apiId, mode, { values = {}, remove = [] }, actor = {}) {
  if (mode !== 'TEST' && mode !== 'PROD') {
    throw ApiError.badRequest('PANEL_INTEGRATED_API_MODE_INVALID',
      `Enregistrement refusé parce que le mode « ${mode} » n’existe pas : TEST ou PROD attendus.`);
  }
  const api = await getApiOrThrow(apiId);
  const current = api.credentials?.[mode] ?? {};
  const storedValues = toObject(current.values);
  const storedPrints = toObject(current.fingerprints);

  for (const [name, value] of Object.entries(values)) {
    if (value === undefined || value === null || value === '') continue;
    if (!KEY_RE.test(name) && !/^[A-Za-z][A-Za-z0-9_]*$/.test(name)) {
      throw ApiError.badRequest('PANEL_INTEGRATED_API_FIELD_INVALID',
        `Enregistrement refusé parce que le nom de champ « ${name} » n’est pas un identifiant simple.`);
    }
    storedValues[name] = encryptSecret(String(value));
    storedPrints[name] = fingerprint(String(value));
  }
  for (const name of remove) {
    delete storedValues[name];
    delete storedPrints[name];
  }

  const at = nowIso();
  await PanelIntegratedApi.updateOne({ apiId }, {
    $set: {
      [`credentials.${mode}.values`]: storedValues,
      [`credentials.${mode}.fingerprints`]: storedPrints,
      [`credentials.${mode}.updatedAt`]: at,
      updatedAt: at,
      updatedBy: actor.userId ?? null,
    },
  });

  // Les projets qui consomment cette API doivent recevoir la nouvelle clé —
  // sinon ils continueraient d'appeler le fournisseur avec l'ancienne.
  await republishToGrantees(apiId);
  return describeApi(await getApiOrThrow(apiId));
}

/** Empreinte non réversible — permet de constater un changement, pas de lire. */
function fingerprint(value) {
  return createHash('sha256').update(value).digest('hex').slice(0, 8);
}

export async function updateApi(apiId, patch, actor = {}) {
  const api = await getApiOrThrow(apiId);
  const allowed = ['label', 'description', 'category', 'mode', 'enabled', 'settings'];
  const update = {};
  for (const field of allowed) {
    if (patch[field] !== undefined) update[field] = patch[field];
  }
  if (update.mode !== undefined && update.mode !== 'TEST' && update.mode !== 'PROD') {
    throw ApiError.badRequest('PANEL_INTEGRATED_API_MODE_INVALID',
      `Modification refusée parce que le mode « ${update.mode} » n’existe pas.`);
  }
  await PanelIntegratedApi.updateOne({ apiId }, {
    $set: { ...update, updatedAt: nowIso(), updatedBy: actor.userId ?? null },
  });
  await republishToGrantees(apiId);
  void api;
  return describeApi(await getApiOrThrow(apiId));
}

export async function deleteApi(apiId) {
  const api = await getApiOrThrow(apiId);
  // Révoquer avant de supprimer : les projets doivent apprendre que l'accès
  // disparaît, sinon ils garderaient une clé morte indéfiniment.
  for (const grant of api.grants ?? []) {
    await emitRevocation(api, grant.projectId);
  }
  await PanelIntegratedApi.deleteOne({ apiId });
  return { deleted: true, revoked: (api.grants ?? []).length };
}

/* -------------------------------------------------------------------------- */
/*  AUTORISATIONS                                                             */
/* -------------------------------------------------------------------------- */

/**
 * ACCORDE l'accès à un projet.
 *
 * `keys` restreint ce que le projet reçoit. Vide = toutes les clés du mode.
 * C'est ce qui permet de donner la clé publique d'un fournisseur de paiement
 * sans donner la clé secrète.
 */
export async function grantAccess(apiId, projectId, { keys = [] } = {}, actor = {}) {
  const api = await getApiOrThrow(apiId);
  const project = await getProjectOrThrow(projectId);
  if (project.pairing?.status !== 'PAIRED') {
    throw ApiError.conflict('PANEL_INTEGRATED_API_PROJECT_NOT_PAIRED',
      `Autorisation refusée parce que le projet « ${project.projectName} » n’est pas appairé : il n’a aucun canal pour recevoir la configuration.`);
  }
  if ((api.grants ?? []).some((g) => g.projectId === projectId)) {
    throw ApiError.conflict('PANEL_INTEGRATED_API_ALREADY_GRANTED',
      `Autorisation refusée parce que « ${project.projectName} » est déjà autorisé sur cette API.`);
  }

  await PanelIntegratedApi.updateOne({ apiId }, {
    $push: {
      grants: {
        projectId,
        projectName: project.projectName,
        keys,
        grantedAt: nowIso(),
        grantedBy: actor.userId ?? null,
      },
    },
    $set: { updatedAt: nowIso() },
  });

  await publishToProject(await getApiOrThrow(apiId), project);
  await recordEvent({
    projectId,
    type: EVENT_TYPES.INTEGRATED_API_GRANTED,
    source: 'PANEL',
    summary: `Accès accordé à l’API « ${api.label} »${keys.length ? ` (${keys.length} clé(s))` : ''}.`,
    data: { apiId, key: api.key, keys },
  });
  return describeApi(await getApiOrThrow(apiId));
}

export async function revokeAccess(apiId, projectId) {
  const api = await getApiOrThrow(apiId);
  if (!(api.grants ?? []).some((g) => g.projectId === projectId)) {
    throw ApiError.notFound('PANEL_INTEGRATED_API_GRANT_NOT_FOUND',
      'Révocation refusée parce que ce projet n’est pas autorisé sur cette API.');
  }
  await PanelIntegratedApi.updateOne({ apiId }, {
    $pull: { grants: { projectId } },
    $set: { updatedAt: nowIso() },
  });
  await emitRevocation(api, projectId);
  await recordEvent({
    projectId,
    type: EVENT_TYPES.INTEGRATED_API_REVOKED,
    source: 'PANEL',
    summary: `Accès révoqué sur l’API « ${api.label} ».`,
    data: { apiId, key: api.key },
  });
  return describeApi(await getApiOrThrow(apiId));
}

/* -------------------------------------------------------------------------- */
/*  DIFFUSION                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * CE QU'UN PROJET REÇOIT — la seule fonction du Panel qui déchiffre des
 * secrets pour les envoyer ailleurs. Elle est volontairement courte et
 * unique : c'est le point à relire quand on doute de l'étanchéité.
 *
 * Le mode est celui du PROJET. Un projet en TEST ne peut pas recevoir les
 * identifiants PROD, même si l'API est en mode PROD côté Panel.
 */
export function buildApiPayloadFor(api, project) {
  const grant = (api.grants ?? []).find((g) => g.projectId === project.projectId);
  if (!grant) return null;

  const projectMode = project.runtime?.environment === 'PROD' ? 'PROD' : 'TEST';
  const set = api.credentials?.[projectMode] ?? {};
  const stored = toObject(set.values);

  // Restriction par clé : vide = tout ce que le mode contient.
  const allowedNames = grant.keys?.length > 0
    ? grant.keys.filter((name) => stored[name] !== undefined)
    : Object.keys(stored);

  const credentials = {};
  for (const name of allowedNames) credentials[name] = decryptSecret(stored[name]);

  return {
    apiId: api.apiId,
    key: api.key,
    label: api.label,
    provider: api.provider,
    category: api.category,
    enabled: api.enabled,
    // Le mode EFFECTIVEMENT servi, pour que le projet puisse le vérifier et
    // refuser s'il ne correspond pas au sien.
    mode: projectMode,
    settings: api.settings ?? {},
    credentials,
    updatedAt: api.updatedAt,
  };
}

/** Émet la configuration d'une API vers UN projet nommé. */
async function publishToProject(api, project) {
  const payload = buildApiPayloadFor(api, project);
  if (payload === null) return false;
  await emitChange({
    entityType: API_ENTITY,
    // L'identité de l'entité est celle de l'API, pas du couple API×projet :
    // le contrat exige un UUID, et le destinataire est déjà porté par
    // `audience`. Un projet ne voit jamais que sa propre version.
    entityId: api.apiId,
    payload,
    // NOMINATIF — c'est ce qui rend l'autorisation effective.
    audience: project.projectId,
  });
  return true;
}

/** Tombstone : l'accès disparaît, le projet doit oublier la clé. */
async function emitRevocation(api, projectId) {
  await emitChange({
    entityType: API_ENTITY,
    entityId: api.apiId,
    deleted: true,
    payload: null,
    audience: projectId,
  });
}

/** Rediffuse une API à tous ses bénéficiaires — après un changement de clé. */
export async function republishToGrantees(apiId) {
  const api = await getApiOrThrow(apiId);
  const projects = await listProjects();
  let published = 0;
  for (const grant of api.grants ?? []) {
    const project = projects.find((p) => p.projectId === grant.projectId);
    if (!project || project.pairing?.status !== 'PAIRED') continue;
    if (await publishToProject(api, project)) published += 1;
  }
  if (published > 0) {
    await recordEvent({
      projectId: null,
      type: EVENT_TYPES.INTEGRATED_API_PUBLISHED,
      source: 'PANEL',
      summary: `API « ${api.label} » rediffusée à ${published} projet(s).`,
      data: { apiId, key: api.key, published },
    });
  }
  return published;
}

/**
 * Toutes les APIs auxquelles un projet a droit — utilisé à l'appairage pour
 * qu'il parte avec sa configuration complète, sans attendre un premier pull.
 */
export async function apisForProject(project) {
  const apis = await PanelIntegratedApi.find({
    'grants.projectId': project.projectId,
    enabled: true,
  }).lean();
  return apis.map((api) => buildApiPayloadFor(api, project)).filter(Boolean);
}

/** Les autorisations d'un projet, sans aucun secret — pour l'écran projet. */
export async function grantsForProject(projectId) {
  const apis = await PanelIntegratedApi.find({ 'grants.projectId': projectId }).lean();
  return apis.map((api) => {
    const grant = api.grants.find((g) => g.projectId === projectId);
    return {
      apiId: api.apiId,
      key: api.key,
      label: api.label,
      provider: api.provider,
      category: api.category,
      enabled: api.enabled,
      keys: grant.keys ?? [],
      grantedAt: grant.grantedAt,
    };
  });
}

/** Mongoose rend des Map : les objets nus sont plus simples à manipuler. */
function toObject(value) {
  if (!value) return {};
  if (value instanceof Map) return Object.fromEntries(value);
  return { ...value };
}

export default {
  listApis, getApiOrThrow, describeApi, createApi, updateApi, deleteApi,
  setCredentials, grantAccess, revokeAccess, republishToGrantees,
  apisForProject, grantsForProject, buildApiPayloadFor,
};
