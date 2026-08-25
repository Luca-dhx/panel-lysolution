// L'ENTREPRISE HÉBERGEUSE — lecture, écriture, résolution de l'hébergeur actif.
//
// Surface volontairement pauvre : il n'y a rien à calculer ici. Une fiche
// d'hébergeur est de la donnée saisie, contrôlée à l'entrée, et republiée vers
// le parc quand elle change — parce qu'elle figure sur les mentions légales de
// chaque site.
import { randomUUID } from 'node:crypto';

import config from '../../config/env.js';
import ApiError from '../../utils/ApiError.js';
import PanelHostCompany, {
  HOST_COMPANY_STATUS,
} from '../../models/PanelHostCompany.model.js';
import { nowIso } from '../../bridge/bridgeContract.js';

/** Bornes de saisie — larges, mais fermées. */
const MAX = Object.freeze({ NAME: 200, SHORT: 120, LONG: 500, NOTES: 2000 });

function text(value, { field, max = MAX.SHORT, required = false }) {
  const cleaned = String(value ?? '').trim();
  if (!cleaned) {
    if (required) {
      throw ApiError.badRequest('HOST_COMPANY_FIELD_REQUIRED', `${field} est obligatoire.`, { field });
    }
    return null;
  }
  if (cleaned.length > max) {
    throw ApiError.badRequest(
      'HOST_COMPANY_FIELD_TOO_LONG',
      `${field} dépasse ${max} caractères.`,
      { field, max },
    );
  }
  /**
   * AUCUNE BALISE, ICI NON PLUS.
   *
   * Ces valeurs s'affichent sur des pages publiques via le document résolu.
   * Le contrôle est le même que pour le contenu d'un template : la donnée est
   * propre EN BASE, et aucun rendu n'a à la défaire.
   */
  if (/[<>]/.test(cleaned)) {
    throw ApiError.badRequest(
      'HOST_COMPANY_FIELD_MARKUP',
      `${field} : les caractères « < » et « > » ne sont pas autorisés.`,
      { field },
    );
  }
  return cleaned;
}

async function opaqueId() {
  for (let essai = 0; essai < 5; essai += 1) {
    const candidat = `hc${randomUUID().replace(/-/g, '').slice(0, 20)}`;
    // eslint-disable-next-line no-await-in-loop
    if (!(await PanelHostCompany.exists({ hostCompanyId: candidat }))) return candidat;
  }
  throw ApiError.conflict('HOST_COMPANY_ID_EXHAUSTED', 'Identifiant introuvable : anomalie.');
}

function normalize(input) {
  return {
    legalName: text(input?.legalName, { field: 'La raison sociale', max: MAX.NAME, required: true }),
    tradingName: text(input?.tradingName, { field: "Le nom d'usage", max: MAX.NAME }),
    legalForm: text(input?.legalForm, { field: 'La forme juridique' }),
    registrationNumber: text(input?.registrationNumber, { field: "Le numéro d'immatriculation" }),
    address: {
      line1: text(input?.address?.line1, { field: "L'adresse", max: MAX.NAME }),
      line2: text(input?.address?.line2, { field: "Le complément d'adresse", max: MAX.NAME }),
      postalCode: text(input?.address?.postalCode, { field: 'Le code postal', max: 20 }),
      city: text(input?.address?.city, { field: 'La ville' }),
      country: text(input?.address?.country, { field: 'Le pays' }),
      countryCode: (text(input?.address?.countryCode, { field: 'Le code pays', max: 2 }) ?? '')
        .toUpperCase() || null,
    },
    email: text(input?.email, { field: "L'adresse e-mail" })?.toLowerCase() ?? null,
    phone: text(input?.phone, { field: 'Le téléphone' }),
    website: text(input?.website, { field: 'Le site web', max: MAX.LONG }),
    source: text(input?.source, { field: 'La source', max: MAX.LONG }),
    /**
     * LA DATE DE VÉRIFICATION EST SAISIE, JAMAIS DÉDUITE DE L'ENREGISTREMENT.
     *
     * Les confondre ferait passer une correction de faute de frappe pour un
     * contrôle des mentions légales de l'hébergeur. Le champ répond à « quand
     * a-t-on vérifié ces données à la source ? », pas à « quand a-t-on touché
     * cette fiche ? » — la seconde est déjà `updatedAt`.
     */
    verifiedAt: text(input?.verifiedAt, { field: 'La date de vérification', max: 40 }),
    notes: text(input?.notes, { field: 'Les notes', max: MAX.NOTES }),
  };
}

export function describeHostCompany(fiche) {
  return {
    hostCompanyId: fiche.hostCompanyId,
    legalName: fiche.legalName,
    tradingName: fiche.tradingName ?? null,
    legalForm: fiche.legalForm ?? null,
    registrationNumber: fiche.registrationNumber ?? null,
    address: {
      line1: fiche.address?.line1 ?? null,
      line2: fiche.address?.line2 ?? null,
      postalCode: fiche.address?.postalCode ?? null,
      city: fiche.address?.city ?? null,
      country: fiche.address?.country ?? null,
      countryCode: fiche.address?.countryCode ?? null,
    },
    email: fiche.email ?? null,
    phone: fiche.phone ?? null,
    website: fiche.website ?? null,
    source: fiche.source ?? null,
    verifiedAt: fiche.verifiedAt ?? null,
    notes: fiche.notes ?? null,
    status: fiche.status,
    createdAt: fiche.createdAt,
    updatedAt: fiche.updatedAt,
    updatedBy: fiche.updatedBy ?? null,
  };
}

export async function listHostCompanies() {
  const fiches = await PanelHostCompany.find({ environment: config.env })
    .sort({ status: 1, legalName: 1 })
    .lean();
  return fiches.map(describeHostCompany);
}

export async function getHostCompanyOrThrow(hostCompanyId) {
  const fiche = await PanelHostCompany.findOne({ hostCompanyId }).lean();
  if (!fiche || fiche.environment !== config.env) {
    throw ApiError.notFound('HOST_COMPANY_NOT_FOUND', 'Hébergeur inconnu.');
  }
  return fiche;
}

/**
 * L'HÉBERGEUR ACTIF — celui que les documents légaux citent.
 *
 * Le plus ANCIEN actif, et non le plus récent : pendant une migration, les
 * deux fiches coexistent, et c'est l'hébergeur en place qui doit continuer
 * d'être cité jusqu'à ce que l'ancienne soit archivée. Prendre le plus récent
 * ferait basculer les mentions légales du parc à la seconde où quelqu'un saisit
 * une fiche de préparation.
 */
export async function activeHostCompany() {
  const fiche = await PanelHostCompany.findOne({
    environment: config.env,
    status: HOST_COMPANY_STATUS.ACTIVE,
  })
    .sort({ createdAt: 1 })
    .lean();
  return fiche ? describeHostCompany(fiche) : null;
}

export async function createHostCompany(input, actor = null) {
  const valeur = normalize(input);
  const at = nowIso();
  const fiche = await PanelHostCompany.create({
    ...valeur,
    hostCompanyId: await opaqueId(),
    status: HOST_COMPANY_STATUS.ACTIVE,
    environment: config.env,
    createdAt: at,
    updatedAt: at,
    createdBy: actor?.email ?? null,
    updatedBy: actor?.email ?? null,
  });
  return describeHostCompany(fiche.toObject());
}

export async function updateHostCompany(hostCompanyId, input, actor = null) {
  await getHostCompanyOrThrow(hostCompanyId);
  const valeur = normalize(input);
  await PanelHostCompany.updateOne(
    { hostCompanyId },
    { $set: { ...valeur, updatedAt: nowIso(), updatedBy: actor?.email ?? null } },
  );
  return describeHostCompany(await getHostCompanyOrThrow(hostCompanyId));
}

export async function setHostCompanyStatus(hostCompanyId, status, actor = null) {
  await getHostCompanyOrThrow(hostCompanyId);
  if (!Object.values(HOST_COMPANY_STATUS).includes(status)) {
    throw ApiError.badRequest('HOST_COMPANY_STATUS_UNKNOWN', 'Statut inconnu.');
  }
  await PanelHostCompany.updateOne(
    { hostCompanyId },
    { $set: { status, updatedAt: nowIso(), updatedBy: actor?.email ?? null } },
  );
  return describeHostCompany(await getHostCompanyOrThrow(hostCompanyId));
}

export default {
  listHostCompanies,
  getHostCompanyOrThrow,
  activeHostCompany,
  createHostCompany,
  updateHostCompany,
  setHostCompanyStatus,
  describeHostCompany,
};
