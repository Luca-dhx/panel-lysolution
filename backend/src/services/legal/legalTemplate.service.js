// LE CATALOGUE DES TEMPLATES LÉGAUX — création, édition, publication, retrait.
//
// ══ CE QUE CE SERVICE PROTÈGE ═══════════════════════════════════════════════
//
// Un document juridique en ligne sur des sites de clients. Trois gardes en
// découlent, et aucune n'est cosmétique :
//
//   1. ON NE PUBLIE PAS PAR ACCIDENT. `content` est le brouillon, servi à
//      personne ; `publishedContent` est ce que les sites affichent. Publier
//      est un geste distinct, daté, versionné, tracé.
//
//   2. ON NE SUPPRIME PAS UN TEMPLATE UTILISÉ. La suppression est REFUSÉE tant
//      qu'un projet le référence, et l'erreur NOMME les projets. Un « êtes-vous
//      sûr ? » n'aurait rien protégé : personne ne peut savoir, devant une
//      modale, quels sites vont perdre leur page.
//
//   3. ON NE RETIRE PAS LE SOL SOUS UN SITE. `archive` sort du catalogue actif
//      sans cesser de servir les projets déjà rattachés. C'est la sortie
//      honorable — celle qu'on propose à la place de la suppression.
//
// ══ LA PUBLICATION EST LE SEUL MOMENT OÙ LE PARC BOUGE ══════════════════════
//
// Enregistrer un brouillon n'envoie rien. Publier republie vers TOUS les
// projets rattachés, en une écriture par projet. C'est cette republication qui
// rend le système dynamique : corriger une phrase la fait apparaître sur les
// sites sans reconstruire un seul frontend.
import { randomUUID } from 'node:crypto';

import config from '../../config/env.js';
import ApiError from '../../utils/ApiError.js';
import logger from '../../utils/logger.js';
import PanelProject from '../../models/PanelProject.model.js';
import PanelLegalTemplate, {
  LEGAL_DOCUMENT_TYPES,
  LEGAL_TEMPLATE_STATUS,
} from '../../models/PanelLegalTemplate.model.js';
import PanelLegalTemplateVersion from '../../models/PanelLegalTemplateVersion.model.js';
import { nowIso } from '../../bridge/bridgeContract.js';
import {
  assertKnownType,
  contentVariableKeys,
  validateContent,
} from './legalTemplate.validation.js';
import { ASSIGNMENT_FIELD } from './legalDocumentResolver.js';

/* -------------------------------------------------------------------------- */
/*  IDENTITÉ                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * L'IDENTIFIANT — OPAQUE, jamais dérivé du nom.
 *
 * Même raison que partout ailleurs dans ce Panel : le nom est une donnée
 * MÉTIER qui se corrige (« Mentions légales — vitrine » devient « … — vitrine
 * FR »), l'identifiant est une donnée TECHNIQUE qui voyage jusqu'aux projets et
 * entre dans des affectations persistées. Les lier ferait dépendre une clé
 * d'une information faite pour bouger.
 */
async function opaqueId() {
  for (let essai = 0; essai < 5; essai += 1) {
    const candidat = `lt${randomUUID().replace(/-/g, '').slice(0, 20)}`;
    // eslint-disable-next-line no-await-in-loop
    if (!(await PanelLegalTemplate.exists({ legalTemplateId: candidat }))) return candidat;
  }
  throw ApiError.conflict(
    'LEGAL_TEMPLATE_ID_EXHAUSTED',
    'Identifiant interne introuvable après plusieurs tirages : anomalie à signaler.',
  );
}

/* -------------------------------------------------------------------------- */
/*  LECTURE                                                                   */
/* -------------------------------------------------------------------------- */

export async function getTemplateOrThrow(legalTemplateId) {
  const template = await PanelLegalTemplate.findOne({ legalTemplateId }).lean();
  if (!template) {
    throw ApiError.notFound('LEGAL_TEMPLATE_NOT_FOUND', 'Template légal inconnu.');
  }
  /**
   * LE MONDE DOIT CONCORDER, MÊME EN LECTURE.
   *
   * Les deux environnements partagent parfois un cluster. Rendre un template
   * de production depuis une instance de recette permettrait de l'assigner à
   * un projet de recette — et de publier sur un site d'essai un texte relu
   * pour la production, ou l'inverse. Le refus est indistinct d'un
   * « inconnu » : une instance n'a pas à apprendre le contenu de l'autre.
   */
  if (template.environment !== config.env) {
    throw ApiError.notFound('LEGAL_TEMPLATE_NOT_FOUND', 'Template légal inconnu.');
  }
  return template;
}

/**
 * « Utilisé par N projets » — la question que la suppression pose.
 *
 * Elle interroge les DEUX champs d'affectation en un seul `$or` : un template
 * de type PRIVACY_POLICY ne peut en principe être assigné qu'au champ privacy,
 * mais compter sur cette discipline pour décider d'une SUPPRESSION serait
 * imprudent. On compte ce qui référence, pas ce qui devrait référencer.
 */
export async function projectsUsingTemplate(legalTemplateId) {
  return PanelProject.find({
    $or: [
      { legalNoticeTemplateId: legalTemplateId },
      { privacyPolicyTemplateId: legalTemplateId },
    ],
  })
    .select('projectId projectKey projectName')
    .sort({ projectName: 1 })
    .lean();
}

/** La vue de catalogue d'un template — sans son contenu, qui est volumineux. */
export function describeTemplate(template, usageCount = 0) {
  return {
    legalTemplateId: template.legalTemplateId,
    name: template.name,
    type: template.type,
    description: template.description ?? '',
    status: template.status,
    version: template.version ?? 0,
    publishedAt: template.publishedAt ?? null,
    /**
     * `hasUnpublishedChanges` répond à la seule question qui compte devant un
     * catalogue : « ce que je vois en ligne est-il ce que je viens d'écrire ? ».
     * Le calculer ici plutôt qu'à l'écran évite deux implémentations de la
     * comparaison — et une comparaison de brouillon qui diverge est pire que
     * pas de comparaison du tout.
     */
    hasUnpublishedChanges: hasUnpublishedChanges(template),
    updatedAt: template.updatedAt,
    updatedBy: template.updatedBy ?? null,
    usageCount,
  };
}

function stableJson(value) {
  return JSON.stringify(value ?? null, (key, val) => {
    if (val && typeof val === 'object' && !Array.isArray(val)) {
      return Object.keys(val).sort().reduce((acc, k) => { acc[k] = val[k]; return acc; }, {});
    }
    return val;
  });
}

export function hasUnpublishedChanges(template) {
  if (!template.publishedContent) return Boolean(template.content?.sections?.length);
  return stableJson(normalizeForCompare(template.content))
    !== stableJson(normalizeForCompare(template.publishedContent));
}

/**
 * La comparaison ignore les identifiants de bloc.
 *
 * Ils sont tirés à la création et recopiés par l'éditeur, mais un bloc
 * fraîchement ajouté puis annulé peut faire varier l'ensemble sans qu'aucun
 * texte n'ait changé. Comparer les identifiants ferait donc clignoter le badge
 * « modifications non publiées » sur un document identique.
 */
function normalizeForCompare(content) {
  return {
    title: content?.title ?? '',
    sections: (content?.sections ?? []).map((s) => ({
      heading: s.heading ?? '',
      blocks: (s.blocks ?? []).map((b) => ({
        type: b.type,
        text: b.text ?? '',
        items: b.items ?? [],
        fields: (b.fields ?? []).map((f) => ({ label: f.label ?? '', value: f.value ?? '' })),
      })),
    })),
  };
}

export async function listTemplates({ type = null } = {}) {
  const query = { environment: config.env };
  if (type) query.type = assertKnownType(type);

  const templates = await PanelLegalTemplate.find(query)
    .sort({ type: 1, name: 1 })
    .lean();

  /**
   * LE DÉCOMPTE D'USAGE EN UNE SEULE REQUÊTE, pas une par template.
   *
   * Le catalogue en compte une poignée aujourd'hui ; une requête par ligne
   * serait invisible. Elle le resterait jusqu'au jour où elle ne le serait
   * plus, et personne ne remonterait jusqu'ici pour comprendre pourquoi un
   * écran d'administration met deux secondes à s'ouvrir.
   */
  const projects = await PanelProject.find({
    $or: [
      { legalNoticeTemplateId: { $ne: null } },
      { privacyPolicyTemplateId: { $ne: null } },
    ],
  })
    .select('legalNoticeTemplateId privacyPolicyTemplateId')
    .lean();

  const usage = new Map();
  for (const project of projects) {
    for (const id of [project.legalNoticeTemplateId, project.privacyPolicyTemplateId]) {
      if (id) usage.set(id, (usage.get(id) ?? 0) + 1);
    }
  }

  return templates.map((t) => describeTemplate(t, usage.get(t.legalTemplateId) ?? 0));
}

/** La fiche complète — contenu compris. C'est ce que l'éditeur ouvre. */
export async function getTemplateDetail(legalTemplateId) {
  const template = await getTemplateOrThrow(legalTemplateId);
  const projects = await projectsUsingTemplate(legalTemplateId);
  return {
    ...describeTemplate(template, projects.length),
    content: template.content ?? { title: '', sections: [] },
    publishedContent: template.publishedContent ?? null,
    variableKeys: contentVariableKeys(template.content),
    projects: projects.map((p) => ({
      projectId: p.projectId,
      projectKey: p.projectKey,
      projectName: p.projectName ?? p.projectKey,
    })),
  };
}

/* -------------------------------------------------------------------------- */
/*  ÉCRITURE                                                                  */
/* -------------------------------------------------------------------------- */

function assertName(name) {
  const value = String(name ?? '').trim();
  if (value.length < 3) {
    throw ApiError.badRequest(
      'LEGAL_TEMPLATE_NAME_REQUIRED',
      'Le nom du template doit comporter au moins 3 caractères.',
    );
  }
  if (value.length > 160) {
    throw ApiError.badRequest('LEGAL_TEMPLATE_NAME_TOO_LONG', 'Nom trop long (160 caractères).');
  }
  return value;
}

export async function createTemplate(input, actor = null) {
  const type = assertKnownType(input?.type);
  const name = assertName(input?.name);
  const content = validateContent(input?.content ?? { title: defaultTitle(type), sections: [] });
  const at = nowIso();

  const template = await PanelLegalTemplate.create({
    legalTemplateId: await opaqueId(),
    name,
    type,
    description: String(input?.description ?? '').trim().slice(0, 500),
    content,
    /**
     * UN TEMPLATE NAÎT EN BROUILLON, TOUJOURS.
     *
     * Le créer actif ferait d'un formulaire à moitié rempli un document
     * assignable — et il suffirait d'un clic dans la fiche projet pour le
     * mettre en ligne. La publication doit rester un geste qu'on décide.
     */
    status: LEGAL_TEMPLATE_STATUS.DRAFT,
    version: 0,
    publishedContent: null,
    environment: config.env,
    createdAt: at,
    updatedAt: at,
    createdBy: actor?.email ?? null,
    updatedBy: actor?.email ?? null,
  });

  return getTemplateDetail(template.legalTemplateId);
}

function defaultTitle(type) {
  return type === LEGAL_DOCUMENT_TYPES.PRIVACY_POLICY
    ? 'Politique de confidentialité'
    : 'Mentions légales';
}

/**
 * ENREGISTRE LE BROUILLON. N'envoie RIEN au parc — c'est tout l'intérêt.
 *
 * Le type n'est PAS modifiable. Un template de mentions légales assigné au
 * champ « mentions légales » de quatre projets, qui deviendrait une politique
 * de confidentialité, publierait le mauvais document sur quatre sites sans
 * qu'aucun d'eux n'ait rien changé. Changer de type, c'est créer un template.
 */
export async function updateTemplate(legalTemplateId, input, actor = null) {
  const existing = await getTemplateOrThrow(legalTemplateId);

  if (input?.type && assertKnownType(input.type) !== existing.type) {
    throw ApiError.badRequest(
      'LEGAL_TEMPLATE_TYPE_IMMUTABLE',
      "Le type d'un template ne change pas : créez-en un nouveau.",
      { current: existing.type },
    );
  }

  const patch = { updatedAt: nowIso(), updatedBy: actor?.email ?? null };
  if (input?.name !== undefined) patch.name = assertName(input.name);
  if (input?.description !== undefined) {
    patch.description = String(input.description ?? '').trim().slice(0, 500);
  }
  if (input?.content !== undefined) patch.content = validateContent(input.content);

  await PanelLegalTemplate.updateOne({ legalTemplateId }, { $set: patch });
  return getTemplateDetail(legalTemplateId);
}

/**
 * PUBLIE — le seul geste qui atteint les sites.
 *
 * Trois effets, dans cet ordre et pas un autre :
 *
 *   1. le brouillon devient `publishedContent` ;
 *   2. la version s'incrémente et l'historique reçoit une ligne ;
 *   3. les projets rattachés sont republiés.
 *
 * L'ordre compte : republier AVANT d'écrire enverrait l'ancien contenu, et
 * l'écran annoncerait une publication qui n'a pas eu lieu.
 *
 * La republication est déléguée par INJECTION (`republish`) plutôt qu'importée.
 * Le publieur importe ce service pour lire les affectations ; s'importer l'un
 * l'autre créerait un cycle que Node résout par un module à moitié initialisé —
 * c'est-à-dire par une fonction `undefined` au premier appel, en production.
 */
export async function publishTemplate(legalTemplateId, actor = null, { republish = null } = {}) {
  const template = await getTemplateOrThrow(legalTemplateId);
  const content = validateContent(template.content);

  if (!content.sections.length) {
    throw ApiError.badRequest(
      'LEGAL_TEMPLATE_EMPTY',
      'Un document vide ne se publie pas : ajoutez au moins une section.',
    );
  }
  if (!content.title) {
    throw ApiError.badRequest(
      'LEGAL_TEMPLATE_TITLE_REQUIRED',
      'Le document doit porter un titre — il s’affiche en tête de la page publique.',
    );
  }

  const version = (template.version ?? 0) + 1;
  const at = nowIso();

  await PanelLegalTemplate.updateOne(
    { legalTemplateId },
    {
      $set: {
        content,
        publishedContent: content,
        version,
        publishedAt: at,
        status: LEGAL_TEMPLATE_STATUS.ACTIVE,
        updatedAt: at,
        updatedBy: actor?.email ?? null,
      },
    },
  );

  await PanelLegalTemplateVersion.create({
    legalTemplateId,
    version,
    name: template.name,
    type: template.type,
    description: template.description ?? '',
    content,
    changedBy: actor?.userId ?? null,
    changedByLabel: actor?.email ?? '',
    origin: 'PUBLISH',
    createdAt: at,
  });

  let recipients = 0;
  if (republish) {
    recipients = await republish(legalTemplateId).catch((err) => {
      /**
       * UNE REPUBLICATION QUI ÉCHOUE NE DÉFAIT PAS LA PUBLICATION.
       *
       * Le contenu est écrit, versionné, tracé : le défaire laisserait le
       * Panel dans un état que l'historique contredit. La livraison, elle, a
       * une file durable et un rattrapage au tirage — un projet injoignable
       * recevra le document à son prochain cycle. Refuser la publication pour
       * un projet éteint bloquerait les autres.
       */
      logger.warn(`[legal] Republication partielle du template ${legalTemplateId} : ${err.message}`);
      return 0;
    });
  }

  logger.info(
    `[legal] Template « ${template.name} » publié en version ${version} `
    + `(${recipients} projet(s) republié(s)).`,
  );

  return { ...(await getTemplateDetail(legalTemplateId)), recipients };
}

/**
 * ARCHIVE — retire du catalogue actif, ne retire RIEN aux sites servis.
 *
 * C'est la nuance essentielle, et elle est délibérée : `assignedTemplate()`
 * sert un template ARCHIVED. Archiver dit « n'assignez plus celui-ci », pas
 * « effacez la page de ceux qui l'utilisent ». Un document juridique retiré
 * sous les pieds d'un site en production serait un défaut plus grave que le
 * document vieillissant qu'on cherchait à retirer.
 */
export async function archiveTemplate(legalTemplateId, actor = null) {
  const template = await getTemplateOrThrow(legalTemplateId);
  if (template.status === LEGAL_TEMPLATE_STATUS.ARCHIVED) return getTemplateDetail(legalTemplateId);

  await PanelLegalTemplate.updateOne(
    { legalTemplateId },
    {
      $set: {
        status: LEGAL_TEMPLATE_STATUS.ARCHIVED,
        updatedAt: nowIso(),
        updatedBy: actor?.email ?? null,
      },
    },
  );
  return getTemplateDetail(legalTemplateId);
}

/** DÉSARCHIVE — retour au catalogue actif. Ne republie rien : rien n'a changé. */
export async function restoreTemplate(legalTemplateId, actor = null) {
  const template = await getTemplateOrThrow(legalTemplateId);
  await PanelLegalTemplate.updateOne(
    { legalTemplateId },
    {
      $set: {
        /**
         * Un template jamais publié redevient BROUILLON, pas ACTIF. Le
         * désarchiver ne peut pas lui inventer un contenu publié qu'il n'a
         * jamais eu.
         */
        status: template.publishedContent
          ? LEGAL_TEMPLATE_STATUS.ACTIVE
          : LEGAL_TEMPLATE_STATUS.DRAFT,
        updatedAt: nowIso(),
        updatedBy: actor?.email ?? null,
      },
    },
  );
  return getTemplateDetail(legalTemplateId);
}

/**
 * SUPPRIME — REFUSÉ dès qu'un projet référence le template.
 *
 * L'erreur NOMME les projets. C'est ce qui distingue un refus utile d'un mur :
 * l'opérateur sait immédiatement quoi réassigner, ou qu'il voulait en réalité
 * archiver. Le message le lui propose.
 */
export async function deleteTemplate(legalTemplateId) {
  await getTemplateOrThrow(legalTemplateId);
  const projects = await projectsUsingTemplate(legalTemplateId);

  if (projects.length > 0) {
    throw ApiError.conflict(
      'LEGAL_TEMPLATE_IN_USE',
      `Utilisé par ${projects.length} projet(s) : archivez-le plutôt que de le supprimer.`,
      {
        usageCount: projects.length,
        projects: projects.map((p) => ({
          projectId: p.projectId,
          projectName: p.projectName ?? p.projectKey,
        })),
        suggestion: 'ARCHIVE',
      },
    );
  }

  await PanelLegalTemplate.deleteOne({ legalTemplateId });
  /**
   * L'HISTORIQUE PART AVEC LE TEMPLATE — et seulement dans ce cas.
   *
   * Il n'est conservable que rattaché : orphelin, il désignerait un
   * `legalTemplateId` que plus rien ne résout, et le premier écran qui
   * tenterait de l'afficher échouerait sans qu'on comprenne pourquoi. Une
   * suppression n'est possible que sur un template QUE PERSONNE N'UTILISE :
   * aucun site n'a donc jamais servi ce contenu.
   */
  await PanelLegalTemplateVersion.deleteMany({ legalTemplateId });
  return { deleted: true };
}

/** L'historique des publications — le plus récent d'abord. */
export async function listVersions(legalTemplateId) {
  await getTemplateOrThrow(legalTemplateId);
  const versions = await PanelLegalTemplateVersion.find({ legalTemplateId })
    .sort({ version: -1 })
    .limit(50)
    .lean();
  return versions.map((v) => ({
    version: v.version,
    createdAt: v.createdAt,
    changedByLabel: v.changedByLabel ?? '',
    origin: v.origin,
    restoredFromVersion: v.restoredFromVersion ?? null,
  }));
}

/**
 * RESTAURE une version dans le BROUILLON — jamais directement en ligne.
 *
 * L'opérateur relit, puis publie s'il le veut. Restaurer en ligne d'un clic
 * remettrait un ancien texte sur des sites de clients sans qu'il ait été relu
 * une seule fois — et une restauration se déclenche précisément dans les
 * moments où l'on est pressé.
 */
export async function restoreVersion(legalTemplateId, version, actor = null) {
  await getTemplateOrThrow(legalTemplateId);
  const snapshot = await PanelLegalTemplateVersion.findOne({ legalTemplateId, version }).lean();
  if (!snapshot) {
    throw ApiError.notFound('LEGAL_TEMPLATE_VERSION_NOT_FOUND', 'Version inconnue.');
  }
  await PanelLegalTemplate.updateOne(
    { legalTemplateId },
    {
      $set: {
        content: validateContent(snapshot.content),
        updatedAt: nowIso(),
        updatedBy: actor?.email ?? null,
      },
    },
  );
  return getTemplateDetail(legalTemplateId);
}

/**
 * LES TEMPLATES ASSIGNABLES d'un type — ACTIFS uniquement.
 *
 * Un brouillon n'y figure pas : il n'a pas de contenu publié, et l'assigner
 * laisserait une page vide. Un archivé non plus — c'est le sens de l'archive.
 * Le sélecteur de la fiche projet ne montre donc que ce qui peut réellement
 * être servi.
 */
export async function assignableTemplates(type) {
  const value = assertKnownType(type);
  const templates = await PanelLegalTemplate.find({
    environment: config.env,
    type: value,
    status: LEGAL_TEMPLATE_STATUS.ACTIVE,
  })
    .sort({ name: 1 })
    .lean();
  return templates.map((t) => describeTemplate(t));
}

export { ASSIGNMENT_FIELD };

export default {
  listTemplates,
  getTemplateDetail,
  getTemplateOrThrow,
  createTemplate,
  updateTemplate,
  publishTemplate,
  archiveTemplate,
  restoreTemplate,
  deleteTemplate,
  listVersions,
  restoreVersion,
  assignableTemplates,
  projectsUsingTemplate,
};
