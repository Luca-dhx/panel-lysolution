// LES IDENTIFIANTS D'UNE ENTREPRISE CLIENTE — un carnet rangé par fiche.
//
// Un identifiant est NOMMÉ (« Stripe », « OVH », « Boîte Gmail ») et porte une
// liste libre de champs `nom → valeur` (« mail », « mot de passe », « clé API »).
// C'est un outil d'organisation de l'agence : aucun code ne s'en sert pour
// appeler un fournisseur — c'est le rôle du coffre du plan de contrôle.
//
// ══ CE QUI EST GARANTI ══════════════════════════════════════════════════════
//
//   · Chaque VALEUR est chiffrée au repos (AES-256-GCM, `panelCrypto`). Les
//     noms restent en clair : ils servent à s'y retrouver et ne valent rien.
//   · Rien ne sort par la fiche (`describeClientCompany`) ni vers un projet
//     (`publishedProfile`) : ces deux vues sont des listes blanches.
//   · Aucune valeur n'est journalisée — seuls les noms et les identifiants
//     techniques apparaissent dans les traces.
import { randomUUID } from 'node:crypto';

import ApiError from '../../utils/ApiError.js';
import logger from '../../utils/logger.js';
import PanelClientCompany from '../../models/PanelClientCompany.model.js';
import { nowIso } from '../../bridge/bridgeContract.js';
import { decryptSecret, encryptSecret } from '../../utils/panelCrypto.js';
import { getClientCompanyOrThrow } from './clientCompany.service.js';

export const CREDENTIAL_LIMITS = Object.freeze({
  maxCredentials: 100,
  maxFields: 40,
  maxNameLength: 120,
  maxValueLength: 5000,
});

function invalide(message) {
  return ApiError.badRequest('PANEL_CLIENT_CREDENTIAL_INVALID', message);
}

/**
 * Valide et normalise `{ name, fields: [{ fieldId?, name, value }] }`.
 *
 * Une ligne entièrement vide (ni nom ni valeur) est ÉCARTÉE : c'est la ligne
 * qu'on ajoute « au cas où » dans l'écran, pas une donnée. Une valeur sans nom,
 * elle, est refusée — on ne saurait plus ce qu'elle désigne.
 */
export function validateCredentialInput(body) {
  const name = String(body?.name ?? '').trim();
  if (!name) throw invalide('Donnez un nom à cet identifiant (ex. « Stripe »).');
  if (name.length > CREDENTIAL_LIMITS.maxNameLength) {
    throw invalide(`Nom trop long (${CREDENTIAL_LIMITS.maxNameLength} caractères au plus).`);
  }

  const brutes = Array.isArray(body?.fields) ? body.fields : [];
  const fields = [];
  for (const brut of brutes) {
    const fieldName = String(brut?.name ?? '').trim();
    const value = String(brut?.value ?? '');
    if (!fieldName && !value.trim()) continue;
    if (!fieldName) throw invalide('Chaque valeur doit porter un nom de champ (ex. « mail »).');
    if (fieldName.length > CREDENTIAL_LIMITS.maxNameLength) {
      throw invalide(`Nom de champ trop long : « ${fieldName.slice(0, 30)}… ».`);
    }
    if (value.length > CREDENTIAL_LIMITS.maxValueLength) {
      throw invalide(`Valeur du champ « ${fieldName} » trop longue.`);
    }
    const fieldId = typeof brut?.fieldId === 'string' && /^[\w-]{1,64}$/.test(brut.fieldId)
      ? brut.fieldId
      : randomUUID();
    fields.push({ fieldId, name: fieldName, value });
  }
  if (fields.length > CREDENTIAL_LIMITS.maxFields) {
    throw invalide(`${CREDENTIAL_LIMITS.maxFields} champs au plus par identifiant.`);
  }
  return { name, fields };
}

function chiffrer(fields) {
  return fields.map((f) => ({ fieldId: f.fieldId, name: f.name, valueEncrypted: encryptSecret(f.value) }));
}

/** La vue rendue à l'écran — valeurs déchiffrées, réservée aux comptes DEV. */
export function describeCredential(c) {
  return {
    credentialId: c.credentialId,
    name: c.name,
    fields: (c.fields ?? []).map((f) => {
      let value = '';
      let unreadable = false;
      try {
        value = decryptSecret(f.valueEncrypted);
      } catch {
        // Clé de chiffrement changée ou valeur altérée : on le DIT, sans faire
        // tomber tout le carnet pour un seul champ.
        unreadable = true;
      }
      return { fieldId: f.fieldId, name: f.name, value, unreadable };
    }),
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
    updatedBy: c.updatedBy ?? null,
  };
}

function credentialOfOrThrow(fiche, credentialId) {
  const c = (fiche.credentials ?? []).find((x) => x.credentialId === credentialId);
  if (!c) throw ApiError.notFound('PANEL_CLIENT_CREDENTIAL_NOT_FOUND', 'Identifiant introuvable.');
  return c;
}

export async function listClientCredentials(clientCompanyId) {
  const fiche = await getClientCompanyOrThrow(clientCompanyId);
  const liste = [...(fiche.credentials ?? [])]
    .sort((a, b) => a.name.localeCompare(b.name, 'fr', { sensitivity: 'base' }));
  return { legalName: fiche.legalName, credentials: liste.map(describeCredential) };
}

export async function createClientCredential(clientCompanyId, body, actor = {}) {
  const fiche = await getClientCompanyOrThrow(clientCompanyId);
  if ((fiche.credentials ?? []).length >= CREDENTIAL_LIMITS.maxCredentials) {
    throw invalide(`${CREDENTIAL_LIMITS.maxCredentials} identifiants au plus par entreprise.`);
  }
  const { name, fields } = validateCredentialInput(body);
  const at = nowIso();
  const entree = {
    credentialId: randomUUID(),
    name,
    fields: chiffrer(fields),
    createdAt: at,
    updatedAt: at,
    updatedBy: actor.userEmail ?? null,
  };
  await PanelClientCompany.updateOne({ clientCompanyId }, { $push: { credentials: entree } });
  logger.info(`[client-credentials] « ${name} » créé sur ${clientCompanyId} par ${actor.userEmail ?? '?'}.`);
  return describeCredential(entree);
}

export async function updateClientCredential(clientCompanyId, credentialId, body, actor = {}) {
  const fiche = await getClientCompanyOrThrow(clientCompanyId);
  const existant = credentialOfOrThrow(fiche, credentialId);
  const { name, fields } = validateCredentialInput(body);
  const at = nowIso();
  const maj = {
    ...existant,
    name,
    fields: chiffrer(fields),
    updatedAt: at,
    updatedBy: actor.userEmail ?? null,
  };
  await PanelClientCompany.updateOne(
    { clientCompanyId, 'credentials.credentialId': credentialId },
    { $set: { 'credentials.$': maj } },
  );
  logger.info(`[client-credentials] « ${name} » modifié sur ${clientCompanyId} par ${actor.userEmail ?? '?'}.`);
  return describeCredential(maj);
}

export async function deleteClientCredential(clientCompanyId, credentialId, actor = {}) {
  const fiche = await getClientCompanyOrThrow(clientCompanyId);
  const existant = credentialOfOrThrow(fiche, credentialId);
  await PanelClientCompany.updateOne({ clientCompanyId }, { $pull: { credentials: { credentialId } } });
  logger.info(
    `[client-credentials] « ${existant.name} » supprimé de ${clientCompanyId} par ${actor.userEmail ?? '?'}.`,
  );
  return { deleted: true, credentialId };
}

export default {
  listClientCredentials,
  createClientCredential,
  updateClientCredential,
  deleteClientCredential,
};
