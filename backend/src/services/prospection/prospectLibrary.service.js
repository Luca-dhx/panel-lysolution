/**
 * LES DOSSIERS ET LES MODÈLES D'ACCROCHE.
 *
 * ══ TROIS RÈGLES QUI NE SE NÉGOCIENT PAS ════════════════════════════════════
 *
 * 1. SUPPRIMER UN DOSSIER NE SUPPRIME RIEN D'AUTRE. Ses sous-dossiers et son
 *    contenu REMONTENT d'un cran. Un rangement n'est pas une corbeille, et
 *    perdre douze prospects parce qu'on a retiré un intitulé serait une
 *    catastrophe silencieuse.
 *
 * 2. UN DOSSIER NE PEUT PAS DEVENIR SON PROPRE ANCÊTRE. Sans cette garde, un
 *    déplacement mal visé détache une branche entière de la racine : elle
 *    n'apparaît plus nulle part, alors qu'elle existe toujours en base.
 *
 * 3. LES DEUX ARBRES NE SE MÉLANGENT PAS. Un dossier de modèles n'accueille
 *    pas de prospects, et l'inverse est vrai aussi.
 */
import ApiError from '../../utils/ApiError.js';
import {
  FOLDER_KIND,
  FOLDER_KIND_VALUES,
  PanelProspectFolder,
} from '../../models/PanelProspectFolder.model.js';
import { PanelProspectTemplate } from '../../models/PanelProspectTemplate.model.js';
import { PanelProspect } from '../../models/PanelProspect.model.js';

const texte = (valeur, defaut = '') => (
  typeof valeur === 'string' ? valeur.trim() : defaut
);

function normaliserKind(valeur) {
  if (!FOLDER_KIND_VALUES.includes(valeur)) {
    throw ApiError.badRequest(
      'PANEL_FOLDER_KIND_UNKNOWN',
      'Un dossier range des prospects ou des modèles.',
    );
  }
  return valeur;
}

async function chargerDossier(folderId) {
  const dossier = await PanelProspectFolder.findById(folderId).catch(() => null);
  if (!dossier) throw ApiError.notFound('PANEL_FOLDER_NOT_FOUND', 'Dossier introuvable.');
  return dossier;
}

/**
 * LE PARENT EXISTE, ET IL EST DU MÊME ARBRE.
 *
 * `null` est une réponse valide — c'est la racine, pas une absence de réponse.
 */
async function verifierParent(parentId, kind) {
  if (parentId === null || parentId === undefined || parentId === '') return null;
  const parent = await PanelProspectFolder.findById(texte(parentId)).catch(() => null);
  if (!parent) {
    throw ApiError.badRequest('PANEL_FOLDER_PARENT_NOT_FOUND', 'Dossier parent introuvable.');
  }
  if (parent.kind !== kind) {
    throw ApiError.badRequest(
      'PANEL_FOLDER_KIND_MISMATCH',
      'Un dossier ne peut pas être rangé dans l’arbre de l’autre famille.',
    );
  }
  return String(parent._id);
}

/**
 * LA DESCENDANCE D'UN DOSSIER, LUI COMPRIS.
 *
 * ══ POURQUOI ON LA CALCULE EN MÉMOIRE ══════════════════════════════════════
 *
 * L'arbre entier d'une famille tient en quelques dizaines de nœuds : le lire
 * d'un coup coûte une requête, là où une remontée récursive en coûterait une
 * par niveau. La borne `garde` n'est pas de la superstition — elle ferme le cas
 * d'un cycle déjà présent en base, qu'une version antérieure aurait pu écrire.
 */
async function descendance(dossier) {
  const tous = await PanelProspectFolder.find({ kind: dossier.kind }).lean();
  const parEnfant = new Map();
  for (const f of tous) {
    const parent = f.parentId ?? '__racine__';
    parEnfant.set(parent, [...(parEnfant.get(parent) ?? []), String(f._id)]);
  }

  const vus = new Set([String(dossier._id)]);
  const file = [String(dossier._id)];
  let garde = 0;
  while (file.length && garde < 10_000) {
    garde += 1;
    const courant = file.shift();
    for (const enfant of parEnfant.get(courant) ?? []) {
      if (vus.has(enfant)) continue;
      vus.add(enfant);
      file.push(enfant);
    }
  }
  return vus;
}

export async function listFolders({ kind = null } = {}) {
  const filtre = kind ? { kind: normaliserKind(kind) } : {};
  return PanelProspectFolder.find(filtre).sort({ name: 1 }).lean();
}

export async function createFolder(data = {}, actor = {}) {
  const name = texte(data.name);
  if (!name) throw ApiError.badRequest('PANEL_FOLDER_NAME_REQUIRED', 'Un nom est requis.');
  const kind = normaliserKind(data.kind);
  const parentId = await verifierParent(data.parentId, kind);

  return PanelProspectFolder.create({
    name: name.slice(0, 120),
    parentId,
    kind,
    createdBy: actor.email ?? null,
    updatedBy: actor.email ?? null,
  });
}

export async function updateFolder(folderId, data = {}, actor = {}) {
  const dossier = await chargerDossier(folderId);

  if (data.name !== undefined) {
    const name = texte(data.name);
    if (!name) throw ApiError.badRequest('PANEL_FOLDER_NAME_REQUIRED', 'Un nom est requis.');
    dossier.name = name.slice(0, 120);
  }

  if (data.parentId !== undefined) {
    const cible = await verifierParent(data.parentId, dossier.kind);
    /**
     * UN DOSSIER NE DEVIENT PAS SON PROPRE ANCÊTRE.
     *
     * Sans cette garde, déplacer « Restaurants » dans « Restaurants/Paris »
     * détacherait la branche entière de la racine : elle n'apparaîtrait plus
     * nulle part, tout en existant toujours en base.
     */
    if (cible !== null) {
      const interdits = await descendance(dossier);
      if (interdits.has(cible)) {
        throw ApiError.badRequest(
          'PANEL_FOLDER_CYCLE',
          'Un dossier ne peut pas être rangé dans lui-même ni dans l’un des siens.',
        );
      }
    }
    dossier.parentId = cible;
  }

  dossier.updatedBy = actor.email ?? null;
  await dossier.save();
  return dossier;
}

/**
 * SUPPRIMER UN DOSSIER — ET REMONTER CE QU'IL CONTENAIT.
 *
 * Les sous-dossiers prennent son parent ; les prospects ou les modèles aussi.
 * Rien n'est effacé d'autre que la ligne du dossier lui-même.
 */
export async function deleteFolder(folderId) {
  const dossier = await chargerDossier(folderId);
  const id = String(dossier._id);
  const versLeHaut = dossier.parentId ?? null;

  await PanelProspectFolder.updateMany({ parentId: id }, { $set: { parentId: versLeHaut } });

  if (dossier.kind === FOLDER_KIND.TEMPLATE) {
    await PanelProspectTemplate.updateMany({ folderId: id }, { $set: { folderId: versLeHaut } });
  } else {
    await PanelProspect.updateMany({ folderId: id }, { $set: { folderId: versLeHaut } });
  }

  await dossier.deleteOne();
  return { deleted: true, folderId: id, movedTo: versLeHaut };
}

/* ══════════════════════════════════════════════════════════════════════════
   LES MODÈLES D'ACCROCHE
   ══════════════════════════════════════════════════════════════════════════ */

async function verifierDossierDeModele(folderId) {
  if (folderId === null || folderId === undefined || folderId === '') return null;
  const dossier = await PanelProspectFolder.findById(texte(folderId)).catch(() => null);
  if (!dossier || dossier.kind !== FOLDER_KIND.TEMPLATE) {
    throw ApiError.badRequest(
      'PANEL_TEMPLATE_FOLDER_INVALID',
      'Un modèle se range dans un dossier de modèles.',
    );
  }
  return String(dossier._id);
}

export async function listTemplates({ folderId = undefined } = {}) {
  const filtre = {};
  /* `folderId=null` demande explicitement la RACINE ; ne rien passer demande
     tout l'arbre. Les deux questions sont différentes. */
  if (folderId === null) filtre.folderId = null;
  else if (folderId) filtre.folderId = texte(folderId);
  return PanelProspectTemplate.find(filtre).sort({ title: 1 }).lean();
}

export async function createTemplate(data = {}, actor = {}) {
  const title = texte(data.title);
  if (!title) throw ApiError.badRequest('PANEL_TEMPLATE_TITLE_REQUIRED', 'Un titre est requis.');

  return PanelProspectTemplate.create({
    title: title.slice(0, 200),
    channel: texte(data.channel).slice(0, 120),
    description: texte(data.description).slice(0, 2000),
    body: data.body === undefined || data.body === null ? '' : String(data.body).slice(0, 20000),
    folderId: await verifierDossierDeModele(data.folderId),
    createdBy: actor.email ?? null,
    updatedBy: actor.email ?? null,
  });
}

export async function updateTemplate(templateId, data = {}, actor = {}) {
  const modele = await PanelProspectTemplate.findById(templateId).catch(() => null);
  if (!modele) throw ApiError.notFound('PANEL_TEMPLATE_NOT_FOUND', 'Modèle introuvable.');

  if (data.title !== undefined) {
    const title = texte(data.title);
    if (!title) throw ApiError.badRequest('PANEL_TEMPLATE_TITLE_REQUIRED', 'Un titre est requis.');
    modele.title = title.slice(0, 200);
  }
  if (data.channel !== undefined) modele.channel = texte(data.channel).slice(0, 120);
  if (data.description !== undefined) modele.description = texte(data.description).slice(0, 2000);
  if (data.body !== undefined) modele.body = String(data.body ?? '').slice(0, 20000);
  if (data.folderId !== undefined) modele.folderId = await verifierDossierDeModele(data.folderId);

  modele.updatedBy = actor.email ?? null;
  await modele.save();
  return modele;
}

export async function deleteTemplate(templateId) {
  const modele = await PanelProspectTemplate.findById(templateId).catch(() => null);
  if (!modele) throw ApiError.notFound('PANEL_TEMPLATE_NOT_FOUND', 'Modèle introuvable.');
  const id = String(modele._id);
  await modele.deleteOne();
  return { deleted: true, templateId: id };
}

/**
 * LE DOSSIER D'UN PROSPECT.
 *
 * Vérifié dans le service de prospection à l'écriture, et ici pour la lecture
 * de l'arbre : un prospect rangé dans un dossier de MODÈLES serait invisible
 * dans les deux écrans à la fois.
 */
export async function verifierDossierDeProspect(folderId) {
  if (folderId === null || folderId === undefined || folderId === '') return null;
  const dossier = await PanelProspectFolder.findById(texte(folderId)).catch(() => null);
  if (!dossier || dossier.kind !== FOLDER_KIND.PROSPECT) {
    throw ApiError.badRequest(
      'PANEL_PROSPECT_FOLDER_INVALID',
      'Un prospect se range dans un dossier de prospects.',
    );
  }
  return String(dossier._id);
}
