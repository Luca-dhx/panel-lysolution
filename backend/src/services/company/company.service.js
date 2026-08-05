// SERVICE ENTREPRISE — Phase 4, LOTS 2 et 3.
//
// L'entreprise est la source de vérité de tout ce qui n'appartient pas à un
// projet : identité, marque, mentions légales, paramètres. Les projets ne la
// devinent pas — ils la reçoivent.
//
// ── SAISIR N'EST PAS PUBLIER ────────────────────────────────────────────────
// Deux actes distincts, et c'est délibéré :
//
//   · `updateCompany()` modifie le BROUILLON. Rien ne part.
//   · `publishConfiguration()` fige une VERSION et la diffuse au parc.
//
// Sans cette séparation, corriger une faute de frappe dans une adresse
// déclencherait une synchronisation vers tout le parc. Pire : un opérateur à
// mi-chemin d'une refonte de marque diffuserait un état incohérent. On
// publie quand on a fini, pas à chaque frappe.
//
// Conséquence assumée : un projet peut afficher une configuration plus
// ancienne que ce que montre l'écran d'administration. C'est visible — la
// version publiée et la date de publication sont affichées — et c'est
// préférable à une diffusion continue non maîtrisée.
import { randomUUID } from 'node:crypto';

import PanelCompany from '../../models/PanelCompany.model.js';
import PanelCompanyVersion from '../../models/PanelCompanyVersion.model.js';
import ApiError from '../../utils/ApiError.js';
import config from '../../config/env.js';
import { nowIso } from '../../bridge/bridgeContract.js';
import { listProjects } from '../registry/projectRegistry.service.js';
import { emitChange } from '../sync/syncCore.service.js';
import { recordEvent, EVENT_TYPES } from '../supervision/timeline.service.js';
import { validateCompanyInput } from './company.validation.js';

/** Type d'entité de synchronisation portant l'entreprise. */
const COMPANY_ENTITY = 'DEV_COMPANY';

/* -------------------------------------------------------------------------- */
/*  RÉSOLUTION DU TENANT                                                      */
/* -------------------------------------------------------------------------- */

/**
 * LE POINT MONO-TENANT DE TOUT LE PANEL.
 *
 * Cette fonction — et elle seule — suppose qu'il n'y a qu'une entreprise.
 * Tout le reste du code manipule un `companyId` explicite. Le jour où un
 * second tenant apparaît, c'est ici que la résolution change (en-tête,
 * sous-domaine, appartenance de l'utilisateur), et nulle part ailleurs.
 */
export async function getActiveCompany() {
  return PanelCompany.findOne({ active: true }).lean();
}

export async function getActiveCompanyOrThrow() {
  const company = await getActiveCompany();
  if (!company) {
    throw ApiError.notFound('PANEL_COMPANY_NOT_CONFIGURED',
      'Aucune entreprise n’est configurée : le Panel ne peut pas se présenter aux projets tant qu’il ne sait pas qui il représente.');
  }
  return company;
}

export async function getCompanyOrThrow(companyId) {
  const company = await PanelCompany.findOne({ companyId }).lean();
  if (!company) throw ApiError.notFound('PANEL_COMPANY_NOT_FOUND', 'Entreprise inconnue.');
  return company;
}

export function listCompanies() {
  return PanelCompany.find().sort({ createdAt: 1 }).lean();
}

/* -------------------------------------------------------------------------- */
/*  ÉCRITURE                                                                  */
/* -------------------------------------------------------------------------- */

/** Crée l'entreprise. Elle naît NON publiée : saisir n'est pas diffuser. */
/**
 * L'IDENTIFIANT INTERNE — dérivé du nom, jamais demandé.
 *
 * Il voyage jusqu'aux projets et doit rester stable et unique, mais rien
 * n'oblige un utilisateur à l'inventer : c'est une contrainte de machine, pas
 * une décision d'entreprise. On le dérive du nom, et on le rend unique en
 * suffixant si besoin.
 */
async function derivedSlug(nom) {
  const base = String(nom ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')   // accents
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50) || 'entreprise';

  let candidat = base;
  // Boucle bornée : au-delà, c'est un symptôme, pas un cas d'usage.
  for (let n = 2; n <= 50; n += 1) {
    if (!(await PanelCompany.exists({ slug: candidat }))) return candidat;
    candidat = `${base}-${n}`.slice(0, 60);
  }
  throw ApiError.conflict('PANEL_COMPANY_SLUG_EXHAUSTED',
    'Identifiant introuvable : trop d’entreprises portent déjà ce nom.');
}

export async function createCompany(input, actor = {}) {
  /**
   * LE MODE N'EST PAS UN CHOIX D'UTILISATEUR.
   *
   * L'environnement est celui du Panel qui tourne : un Panel de recette ne
   * peut pas héberger une entreprise de production, et lui poser la question
   * revenait à lui demander de deviner une contrainte technique — avec le
   * risque de se tromper une fois pour toutes.
   *
   * L'identifiant se dérive du nom pour la même raison.
   */
  const demande = { ...(input ?? {}) };
  demande.environment = config.env;
  if (!demande.slug) demande.slug = await derivedSlug(demande.identity?.name);

  const validation = validateCompanyInput(demande, { creating: true });
  if (!validation.valid) {
    throw ApiError.badRequest('PANEL_COMPANY_INVALID',
      `Entreprise refusée parce que ${validation.errors.length} champ(s) sont invalides : ${validation.errors.join(' ')}`,
      { errors: validation.errors });
  }
  const value = validation.value;

  if (await PanelCompany.exists({ slug: value.slug })) {
    throw ApiError.conflict('PANEL_COMPANY_SLUG_TAKEN',
      `Entreprise refusée parce que l’identifiant « ${value.slug} » est déjà utilisé.`);
  }
  // Une seule entreprise ACTIVE dans cette phase — le refus est explicite
  // plutôt que silencieusement désactivant l'existante.
  if (value.active !== false && await PanelCompany.exists({ active: true })) {
    throw ApiError.conflict('PANEL_COMPANY_ALREADY_ACTIVE',
      'Entreprise refusée parce qu’une entreprise active existe déjà : cette phase n’en gère qu’une.');
  }

  const at = nowIso();
  const company = await PanelCompany.create({
    ...value,
    companyId: randomUUID(),
    publishedVersion: null,
    publishedAt: null,
    createdAt: at,
    updatedAt: at,
    updatedBy: actor.userId ?? null,
  });

  await recordEvent({
    projectId: null,
    type: EVENT_TYPES.COMPANY_CREATED,
    source: 'PANEL',
    summary: `Entreprise « ${value.identity.name} » créée (${value.environment}).`,
    data: { companyId: company.companyId, slug: value.slug },
  });

  return company.toObject();
}

/** Met à jour le brouillon. Aucune diffusion. */
export async function updateCompany(companyId, patch, actor = {}) {
  const current = await getCompanyOrThrow(companyId);
  const merged = mergeDeep(stripMeta(current), patch);

  const validation = validateCompanyInput(merged, { creating: false });
  if (!validation.valid) {
    throw ApiError.badRequest('PANEL_COMPANY_INVALID',
      `Modification refusée parce que ${validation.errors.length} champ(s) sont invalides : ${validation.errors.join(' ')}`,
      { errors: validation.errors });
  }

  if (validation.value.slug !== current.slug
    && await PanelCompany.exists({ slug: validation.value.slug, companyId: { $ne: companyId } })) {
    throw ApiError.conflict('PANEL_COMPANY_SLUG_TAKEN',
      `Modification refusée parce que l’identifiant « ${validation.value.slug} » est déjà utilisé.`);
  }

  await PanelCompany.updateOne(
    { companyId },
    { $set: { ...validation.value, updatedAt: nowIso(), updatedBy: actor.userId ?? null } },
  );
  return getCompanyOrThrow(companyId);
}

/* -------------------------------------------------------------------------- */
/*  PUBLICATION                                                               */
/* -------------------------------------------------------------------------- */

/**
 * PUBLIE la configuration : fige une version immuable et la diffuse.
 *
 * La diffusion passe par le journal de synchronisation en `audience: null`
 * (tout le parc) : l'identité de l'entreprise n'est pas un secret, tous les
 * projets appairés la reçoivent. Les IntegratedAPI, elles, sont nominatives
 * — voir `integratedApi.service.js`.
 *
 * @param {string} reason  pourquoi cette version existe — exigé
 */
export async function publishConfiguration(companyId, { reason }, actor = {}) {
  if (!reason || !String(reason).trim()) {
    throw ApiError.badRequest('PANEL_COMPANY_PUBLISH_REASON_REQUIRED',
      'Publication refusée parce qu’aucune raison n’a été fournie : une version sans raison ne se relit pas dans six mois.');
  }

  const company = await getCompanyOrThrow(companyId);
  const payload = await companyPublishedProfile(company);

  const previous = company.publishedVersion === null
    ? null
    : await PanelCompanyVersion.findOne({ companyId, version: company.publishedVersion }).lean();

  const changes = diffPayloads(previous?.payload ?? null, payload);
  if (previous && changes.length === 0) {
    throw ApiError.conflict('PANEL_COMPANY_NOTHING_TO_PUBLISH',
      `Publication refusée parce que la configuration est identique à la version ${previous.version} déjà publiée.`);
  }

  const version = (company.publishedVersion ?? 0) + 1;
  const at = nowIso();

  await PanelCompanyVersion.create({
    companyId,
    version,
    payload: { ...payload, version },
    reason: String(reason).trim(),
    changes,
    publishedAt: at,
    publishedBy: actor.userId ?? null,
    publishedByEmail: actor.userEmail ?? null,
  });

  await PanelCompany.updateOne(
    { companyId },
    { $set: { publishedVersion: version, publishedAt: at, updatedAt: at, updatedBy: actor.userId ?? null } },
  );

  const recipients = await broadcastCompany(companyId, { ...payload, version }, at);

  await recordEvent({
    projectId: null,
    type: EVENT_TYPES.COMPANY_PUBLISHED,
    source: 'PANEL',
    summary: `Configuration d’entreprise publiée en version ${version} — ${changes.length} changement(s), ${recipients} projet(s) destinataire(s).`,
    data: { companyId, version, changeCount: changes.length, recipients },
  });

  return { version, publishedAt: at, changes, recipients };
}

/** Diffuse la configuration publiée à tout le parc appairé. */
async function broadcastCompany(companyId, payload, modifiedAt) {
  const projects = (await listProjects()).filter((p) => p.pairing?.status === 'PAIRED');
  await emitChange({
    entityType: COMPANY_ENTITY,
    entityId: companyId,
    payload,
    modifiedAt,
    audience: null, // l'identité de l'entreprise n'est pas nominative
  });
  return projects.length;
}

/**
 * REPUBLIE une version antérieure.
 *
 * On ne « revient » pas à une version : on en publie une NOUVELLE portant
 * l'ancien contenu. Le compteur reste monotone, l'historique reste linéaire,
 * et le retour en arrière est lui-même tracé — un retour effacé serait une
 * perte d'audit.
 */
export async function restoreVersion(companyId, version, actor = {}) {
  const snapshot = await PanelCompanyVersion.findOne({ companyId, version }).lean();
  if (!snapshot) {
    throw ApiError.notFound('PANEL_COMPANY_VERSION_NOT_FOUND',
      `Restauration refusée parce que la version ${version} n’existe pas.`);
  }
  const company = await getCompanyOrThrow(companyId);
  if (company.publishedVersion === version) {
    throw ApiError.conflict('PANEL_COMPANY_VERSION_ALREADY_ACTIVE',
      `Restauration refusée parce que la version ${version} est déjà publiée.`);
  }

  const restored = restorableFields(snapshot.payload);
  await PanelCompany.updateOne({ companyId }, { $set: { ...restored, updatedAt: nowIso(), updatedBy: actor.userId ?? null } });

  return publishConfiguration(companyId, { reason: `Retour à la version ${version}.` }, actor);
}

export function listVersions(companyId, limit = 50) {
  return PanelCompanyVersion.find({ companyId })
    .sort({ version: -1 })
    .limit(Math.min(limit, 200))
    .lean();
}

export async function getVersion(companyId, version) {
  const snapshot = await PanelCompanyVersion.findOne({ companyId, version }).lean();
  if (!snapshot) throw ApiError.notFound('PANEL_COMPANY_VERSION_NOT_FOUND', `Version ${version} inconnue.`);
  return snapshot;
}

/** La configuration publiée — celle que les projets appliquent réellement. */
export async function getPublishedConfiguration(companyId) {
  const company = await getCompanyOrThrow(companyId);
  if (company.publishedVersion === null) return null;
  return PanelCompanyVersion.findOne({ companyId, version: company.publishedVersion }).lean();
}

/* -------------------------------------------------------------------------- */
/*  PROJECTIONS                                                               */
/* -------------------------------------------------------------------------- */

/**
 * CE QU'UN PROJET REÇOIT.
 *
 * Tout ce qui figure ici est destiné à être affiché publiquement par un site
 * vitrine : identité, marque, contacts, mentions légales. Rien de secret n'y
 * transite — les identifiants d'API ont leur propre canal, nominatif.
 *
 * C'est aussi la charge utile versionnée : ce que le Panel fige est
 * exactement ce que les projets appliquent, sans transformation
 * intermédiaire qui pourrait diverger.
 */
export function companyPublicProfile(company) {
  return {
    companyId: company.companyId,
    slug: company.slug,
    environment: company.environment,
    identity: plain(company.identity),
    branding: plain(company.branding),
    domains: plain(company.domains),
    contacts: plain(company.contacts),
    legal: plain(company.legal),
    settings: plain(company.settings),
    // Identité DÉVELOPPEUR — le Panel en est l'autorité.
    signer: plain(company.signer) ?? null,
    references: (company.references || []).map((r) => plain(r)),
  };
}

/**
 * LE PROFIL TEL QU'IL PART VERS LES PROJETS.
 *
 * Les médias sont stockés en chemin relatif (`/uploads/…`) : le Panel les sert
 * lui-même, et un changement de domaine ne casse aucune fiche. Mais ce sont
 * les PROJETS qui les affichent, depuis d'autres origines — un chemin relatif
 * y pointerait sur le site du client.
 *
 * La résolution en URL absolue n'a donc lieu qu'ICI, au moment de figer une
 * version. La vue d'administration, elle, garde le chemin relatif : le Panel
 * est sa propre origine, et le réécrire n'apporterait rien.
 *
 * L'adresse vient de `resolveBackendUrl()` — la configuration réseau écrite
 * par le déploiement depuis le domaine de la cible. Aucune variable dédiée :
 * une variable de plus est une variable qu'on oublie.
 */
export async function companyPublishedProfile(company) {
  const profil = companyPublicProfile(company);
  const branding = profil.branding || {};
  return {
    ...profil,
    branding: {
      ...branding,
      logoUrl: await resolvePublicMediaUrl(branding.logoUrl),
      faviconUrl: await resolvePublicMediaUrl(branding.faviconUrl),
    },
  };
}

/** Vue d'administration — ajoute l'état de publication. */
export function describeCompany(company) {
  return {
    ...companyPublicProfile(company),
    active: company.active,
    publishedVersion: company.publishedVersion,
    publishedAt: company.publishedAt,
    // Un brouillon modifié après la dernière publication : l'écran doit le
    // dire, sinon l'opérateur croit avoir diffusé ce qu'il vient de saisir.
    hasUnpublishedChanges: company.publishedAt !== null
      && company.updatedAt > company.publishedAt,
    createdAt: company.createdAt,
    updatedAt: company.updatedAt,
    updatedBy: company.updatedBy,
  };
}

/* -------------------------------------------------------------------------- */
/*  OUTILS                                                                    */
/* -------------------------------------------------------------------------- */

const META_FIELDS = ['_id', 'companyId', 'publishedVersion', 'publishedAt', 'createdAt', 'updatedAt', 'updatedBy'];
const RESTORABLE = ['slug', 'environment', 'identity', 'branding', 'domains', 'contacts', 'legal', 'settings'];

function stripMeta(company) {
  const copy = { ...company };
  for (const field of META_FIELDS) delete copy[field];
  return copy;
}

function restorableFields(payload) {
  return Object.fromEntries(RESTORABLE.filter((f) => payload[f] !== undefined).map((f) => [f, payload[f]]));
}

/** Mongoose rend des sous-documents : on veut des objets nus, comparables. */
function plain(value) {
  if (value === null || value === undefined) return null;
  return JSON.parse(JSON.stringify(value));
}

/** Fusion profonde — un patch partiel ne doit pas effacer ce qu'il ignore. */
function mergeDeep(base, patch) {
  const out = { ...base };
  for (const [key, value] of Object.entries(patch ?? {})) {
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      out[key] = mergeDeep(plain(base?.[key]) ?? {}, value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

/**
 * Différentiel entre deux instantanés, à plat.
 *
 * Calculé à la publication et figé dans la version : recalculer un
 * différentiel a posteriori donnerait un résultat dépendant du code du jour,
 * pas de ce qui s'est réellement passé.
 */
export function diffPayloads(before, after, prefix = '') {
  const changes = [];
  const keys = new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})]);
  for (const key of [...keys].sort()) {
    if (key === 'version') continue;
    const path = prefix ? `${prefix}.${key}` : key;
    const from = before?.[key] ?? null;
    const to = after?.[key] ?? null;
    const bothObjects = from && to && typeof from === 'object' && typeof to === 'object'
      && !Array.isArray(from) && !Array.isArray(to);
    if (bothObjects) {
      changes.push(...diffPayloads(from, to, path));
    } else if (JSON.stringify(from) !== JSON.stringify(to)) {
      changes.push({ path, from, to });
    }
  }
  return changes;
}

export default {
  getActiveCompany, getActiveCompanyOrThrow, getCompanyOrThrow, listCompanies,
  createCompany, updateCompany, publishConfiguration, restoreVersion,
  listVersions, getVersion, getPublishedConfiguration,
  companyPublicProfile, describeCompany, diffPayloads,
};
