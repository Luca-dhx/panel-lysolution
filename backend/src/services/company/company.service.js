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
import { resolvePublicMediaUrl } from '../upload/upload.service.js';

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
 * L'IDENTIFIANT INTERNE — OPAQUE, et totalement indépendant du nom.
 *
 * ── POURQUOI IL N'EST PAS DÉRIVÉ DU NOM ─────────────────────────────────────
 * Le nom est une donnée MÉTIER : il se corrige, il change au rebranding, il
 * porte des accents et des homonymies. L'identifiant est une donnée TECHNIQUE :
 * il voyage jusqu'aux projets et doit rester stable à vie. Les lier revenait à
 * faire dépendre une clé d'une information faite pour bouger — et à laisser
 * deviner, depuis l'identifiant, un nom que l'entreprise a peut-être changé.
 *
 * Il est donc tiré au hasard, jamais reconstruit, jamais modifiable, et jamais
 * affiché. Une collision reste théoriquement possible : on la traite plutôt
 * que de la supposer impossible.
 */
async function opaqueSlug() {
  // 20 caractères base36 tirés d'un UUID : assez court pour un identifiant,
  // assez large pour ne jamais avoir à y penser.
  const tirage = () => randomUUID().replace(/-/g, '').slice(0, 20);

  for (let essai = 0; essai < 5; essai += 1) {
    const candidat = `c${tirage()}`;
    if (!(await PanelCompany.exists({ slug: candidat }))) return candidat;
  }
  throw ApiError.conflict('PANEL_COMPANY_SLUG_EXHAUSTED',
    'Identifiant interne introuvable après plusieurs tirages : anomalie à signaler.');
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
  if (!demande.slug) demande.slug = await opaqueSlug();

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

  /**
   * L'IDENTIFIANT NE BOUGE PAS — quoi qu'on envoie.
   *
   * Il voyage jusqu'aux projets, qui s'y réfèrent : le changer reviendrait à
   * remplacer l'entreprise par une autre à leurs yeux. Renommer l'entreprise
   * n'y touche donc pas, et une charge utile qui prétendrait le modifier est
   * ignorée en silence plutôt que refusée — ce n'est pas une erreur de
   * l'utilisateur, c'est un champ qu'il n'a jamais eu à connaître.
   */
  merged.slug = current.slug;
  merged.environment = current.environment;

  const validation = validateCompanyInput(merged, { creating: false });
  if (!validation.valid) {
    throw ApiError.badRequest('PANEL_COMPANY_INVALID',
      `Modification refusée parce que ${validation.errors.length} champ(s) sont invalides : ${validation.errors.join(' ')}`,
      { errors: validation.errors });
  }

  await PanelCompany.updateOne(
    { companyId },
    { $set: { ...validation.value, updatedAt: nowIso(), updatedBy: actor.userId ?? null } },
  );
  return getCompanyOrThrow(companyId);
}

/**
 * ENREGISTRER — c’est-à-dire DIFFUSER. Un seul geste.
 *
 * ── CE QUI A ÉTÉ SUPPRIMÉ, ET POURQUOI ─────────────────────────────────────
 * L’écran distinguait « enregistrer un brouillon » de « publier », le second
 * exigeant une justification écrite. Deux gestes pour une intention unique :
 * décrire son entreprise. Le brouillon n’était utile à personne — il ne
 * servait qu’à créer un état où ce qu’on voit à l’écran n’est pas ce que les
 * projets appliquent, c’est-à-dire exactement le malentendu qu’on cherchait
 * à éviter.
 *
 * Enregistrer écrit la fiche ET publie la version. Le versionnement reste
 * entier : chaque enregistrement fige une version immuable avec son diff.
 *
 * Enregistrer sans avoir rien changé ne DOIT PAS échouer : c’est un geste
 * anodin, pas une erreur. On le dit, on ne le punit pas.
 */
const RIEN_A_PUBLIER = 'PANEL_COMPANY_NOTHING_TO_PUBLISH';

export async function saveCompany(companyId, patch, actor = {}) {
  const company = await updateCompany(companyId, patch, actor);
  try {
    const result = await publishConfiguration(companyId, {}, actor);
    const frais = await getCompanyOrThrow(companyId);
    return {
      company: describeCompany(frais),
      media: await companyMediaResolution(frais),
      published: true,
      ...result,
    };
  } catch (err) {
    if (err?.code === RIEN_A_PUBLIER) {
      return {
        company: describeCompany(company),
        media: await companyMediaResolution(company),
        published: false,
        version: company.publishedVersion,
        changes: [],
        recipients: 0,
      };
    }
    throw err;
  }
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
 * ── LA JUSTIFICATION N’EST PLUS DEMANDÉE ───────────────────────────────────
 * Publier exigeait une phrase saisie à la main. En pratique elle valait
 * « maj », « correction », « test » — un péage sans information, franchi
 * machinalement, qui transformait un enregistrement en formalité.
 *
 * Le versionnement, lui, reste entier : chaque publication fige une version
 * immuable, datée, attribuée, avec le DIFF exact des champs modifiés. C’est
 * ce diff qui se relit dans six mois — il dit ce qui a changé, ce qu’une
 * phrase libre ne disait jamais vraiment.
 *
 * @param {string} [reason]  motif facultatif ; à défaut, il est déduit du diff
 */
export async function publishConfiguration(companyId, { reason } = {}, actor = {}) {

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
    // Trace lisible sans rien demander : ce qui a changé, et combien.
    reason: String(reason ?? '').trim() || resumerChangements(changes),
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

/**
 * RÉSUMÉ AUTOMATIQUE d’une publication — ce qui remplace la phrase saisie.
 *
 * Il nomme les blocs touchés plutôt que de compter des champs : « identité,
 * équipe » se relit, « 7 changements » non. Au-delà de trois blocs on abrège,
 * parce qu’une énumération complète cesse d’être lisible.
 */
function resumerChangements(changes) {
  if (!changes?.length) return 'Première publication.';
  const blocs = [...new Set(changes.map((c) => String(c.path ?? c.field ?? '').split('.')[0]).filter(Boolean))];
  if (!blocs.length) return `${changes.length} changement(s).`;
  const nommes = blocs.slice(0, 3).join(', ');
  return blocs.length > 3
    ? `Modification de ${nommes} et ${blocs.length - 3} autre(s) bloc(s).`
    : `Modification de ${nommes}.`;
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
    // L’ÉQUIPE — publiée avec le reste. Les membres retirés voyagent aussi :
    // c’est le projet qui décide de ne pas les afficher, et un membre
    // réactivé n’a alors pas à être ressaisi.
    team: (company.team || []).map((m) => ({
      ...plain(m),
      references: (m.references || []).map((r) => plain(r)),
    })),
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
  const { publishableDescriptor } = await import('../upload/mediaDescriptor.service.js');

  /**
   * LE DESCRIPTEUR CANONIQUE ACCOMPAGNE L'URL — il ne la remplace pas.
   *
   * ── CE QUE L'URL SEULE NE DISAIT PAS ────────────────────────────────────
   * Un projet qui recevait `logoUrl` ne pouvait savoir ni si l'image avait
   * changé (aucune empreinte), ni son type réel, ni ses dimensions, ni si la
   * projection reçue était plus récente que celle déjà appliquée. Il ne
   * pouvait que recharger l'adresse et espérer — d'où des images remplacées
   * qui restaient affichées depuis le cache.
   *
   * ── POURQUOI LES DEUX ───────────────────────────────────────────────────
   * `logoUrl` reste publié : un projet antérieur au descripteur continue de
   * fonctionner sans rien changer. La migration se fait projet par projet, et
   * aucun écran ne casse le jour où le Panel se met à en dire davantage.
   *
   * ── LA SUPPRESSION EST PUBLIÉE, PAS OMISE ───────────────────────────────
   * Un média retiré donne `null` — explicitement. La charge utile est une
   * PHOTOGRAPHIE complète : c'est cette valeur nulle qui remplace l'ancien
   * descripteur chez le projet. L'omettre laisserait l'ancienne image en
   * place indéfiniment.
   */
  /**
   * LE DESCRIPTEUR EN FICHE FAIT AUTORITÉ ; l'URL historique n'est qu'un repli
   * pour les fiches antérieures au descripteur.
   *
   * Et rien n'est publié tant qu'aucune destination active ne sert le média :
   * `/uploads/…` n'existe pas depuis le serveur d'un client, et
   * `http://localhost` encore moins. Le projet garde alors sa projection
   * précédente — ce qui vaut mieux qu'une image cassée.
   */
  const [logo, logoDark, favicon] = await Promise.all([
    publishableDescriptor(branding.logo?.objectKey ?? branding.logoUrl, { role: 'logo' }),
    publishableDescriptor(branding.logoDark?.objectKey ?? branding.logoDarkUrl, { role: 'logo-dark' }),
    publishableDescriptor(branding.favicon?.objectKey ?? branding.faviconUrl, { role: 'favicon' }),
  ]);

  return {
    ...profil,
    branding: {
      ...branding,
      /**
       * L'URL HISTORIQUE ne part que si elle est réellement PUBLIQUE.
       *
       * Elle vient du descripteur publiable, jamais du champ stocké : ce
       * dernier porte un chemin de stockage (`/uploads/…`) qui ne signifie
       * rien depuis le serveur d'un client. `null` tant qu'aucune destination
       * ne sert le média — et un projet qui reçoit `null` garde sa projection
       * précédente plutôt que d'afficher un lien mort.
       */
      logoUrl: logo?.url ?? null,
      logoDarkUrl: logoDark?.url ?? null,
      faviconUrl: favicon?.url ?? null,
      // ADDITIF : le descripteur complet, à côté de l'URL historique.
      logo,
      logoDark,
      favicon,
    },
    // Les portraits suivent exactement la règle du logo.
    team: await Promise.all((profil.team || []).map(async (m) => {
      const photo = await publishableDescriptor(m.photo?.objectKey ?? m.photoUrl, { role: 'team-photo' });
      return { ...m, photoUrl: photo?.url ?? null, photo };
    })),
  };
}

/**
 * LES ADRESSES D'AFFICHAGE DES MÉDIAS DE LA FICHE — dérivées, jamais stockées.
 *
 * ── POURQUOI UN BLOC À PART, ET PAS UN CHAMP DANS LE DESCRIPTEUR ────────────
 * Le descripteur est ce que l'écran RENVOIE au serveur en enregistrant. Y
 * glisser une adresse calculée la ferait écrire en base au premier
 * enregistrement — et l'on se retrouverait exactement avec ce qu'on vient de
 * supprimer : une URL figée dans une fiche.
 *
 * Ce bloc est donc parallèle, indexé par le chemin du descripteur. Il est
 * consultable en lecture et ignoré à l'écriture.
 *
 * L'unique producteur d'adresse reste `resolvePanelMediaUrl` : un second endroit qui
 * concatènerait un domaine et un chemin finirait par en diverger.
 */
export async function companyMediaResolution(company) {
  const { resolvePanelMediaUrl } = await import('../upload/mediaDescriptor.service.js');
  const environment = company.environment;
  const cibles = [
    ['branding.logo', company.branding?.logo],
    ['branding.logoDark', company.branding?.logoDark],
    ['branding.favicon', company.branding?.favicon],
    ...(company.team || []).map((m, i) => [`team.${i}.photo`, m.photo]),
  ].filter(([, d]) => d?.objectKey);

  const resolus = await Promise.all(cibles.map(async ([chemin, descripteur]) => {
    const { url, absolute, reason } = await resolvePanelMediaUrl(plain(descripteur), environment);
    return [chemin, {
      url,
      // « Servi par une destination » — pas « enregistré ». Un média local est
      // parfaitement valide ; il n'est simplement encore visible que d'ici.
      published: absolute,
      reason,
    }];
  }));
  return Object.fromEntries(resolus);
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
  createCompany, updateCompany, saveCompany, publishConfiguration, restoreVersion,
  listVersions, getVersion, getPublishedConfiguration,
  companyPublicProfile, describeCompany, diffPayloads,
};
