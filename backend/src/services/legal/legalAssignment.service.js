// L'AFFECTATION DES DOCUMENTS LÉGAUX À UN PROJET.
//
// ══ LE GESTE LE PLUS SIMPLE DU CHANTIER, ET LE PLUS GARDÉ ═══════════════════
//
// « Mentions légales : [ Template standard vitrine ▾ ] ». Un menu déroulant,
// deux lignes, un bouton. Derrière, quatre contrôles, parce que ce menu décide
// de ce qui s'affiche sur le site d'un client :
//
//   1. le template EXISTE et appartient à CE MONDE (TEST / PROD) ;
//   2. son TYPE correspond au champ — on n'assigne pas une politique de
//      confidentialité au champ « mentions légales » ;
//   3. il est ASSIGNABLE — un brouillon n'a rien à servir, l'assigner
//      laisserait une page vide ;
//   4. la publication suit IMMÉDIATEMENT — sinon l'écran annoncerait un
//      changement que le site ignore.
//
// Le quatrième point est le critère d'acceptation central du chantier : changer
// l'affectation depuis le Panel doit se voir sur le site sans reconstruire quoi
// que ce soit.
import config from '../../config/env.js';
import ApiError from '../../utils/ApiError.js';
import PanelProject from '../../models/PanelProject.model.js';
import PanelLegalTemplate, {
  LEGAL_DOCUMENT_TYPE_VALUES,
  LEGAL_TEMPLATE_STATUS,
} from '../../models/PanelLegalTemplate.model.js';
import { contentVariableKeys } from './legalTemplate.validation.js';
import {
  ASSIGNMENT_FIELD,
  assignedTemplate,
  describeCompleteness,
  resolveLegalContext,
} from './legalDocumentResolver.js';
import { publishAllForProject, publishDocument } from './legalDocumentPublisher.js';

async function getProjectOrThrow(projectId) {
  const project = await PanelProject.findOne({ projectId }).lean();
  if (!project) throw ApiError.notFound('PANEL_PROJECT_NOT_FOUND', 'Projet inconnu.');
  return project;
}

/**
 * LA SECTION « Documents légaux » DE LA FICHE PROJET.
 *
 * Elle répond à trois questions, et à rien d'autre :
 *
 *   · quel template est assigné, et dans quel état est-il ?
 *   · les données nécessaires sont-elles disponibles ?
 *   · s'il en manque, où va-t-on les corriger ?
 *
 * Le troisième point est ce qui rend l'avertissement utile : « ⚠ Ce template
 * utilise 1 information non renseignée » sans destination serait un reproche.
 * `completeness.missing[].source` porte l'autorité à corriger, et l'écran en
 * déduit le lien.
 */
export async function describeProjectLegalDocuments(projectId) {
  const project = await getProjectOrThrow(projectId);
  const context = await resolveLegalContext(projectId);

  const documents = {};
  for (const type of LEGAL_DOCUMENT_TYPE_VALUES) {
    const assignedId = project[ASSIGNMENT_FIELD[type]] ?? null;

    /**
     * ON LIT LE TEMPLATE ASSIGNÉ MÊME S'IL N'EST PAS SERVABLE.
     *
     * `assignedTemplate()` rend `null` pour un brouillon — c'est la bonne
     * décision pour SERVIR. Ce n'est pas la bonne pour AFFICHER : un écran qui
     * montrerait « aucun template » alors qu'un brouillon est assigné
     * empêcherait de comprendre pourquoi la page est absente, et inviterait à
     * réassigner ce qui l'est déjà.
     */
    const raw = assignedId
      ? await PanelLegalTemplate.findOne({
        legalTemplateId: assignedId,
        environment: config.env,
      }).lean()
      : null;

    const servable = raw ? await assignedTemplate(project, type) : null;
    const content = servable?.publishedContent ?? raw?.publishedContent ?? raw?.content ?? null;
    const completeness = content
      ? describeCompleteness(contentVariableKeys(content), context.values)
      : null;

    documents[type] = {
      type,
      templateId: assignedId,
      template: raw
        ? {
          legalTemplateId: raw.legalTemplateId,
          name: raw.name,
          status: raw.status,
          version: raw.version ?? 0,
          publishedAt: raw.publishedAt ?? null,
          updatedAt: raw.updatedAt,
        }
        : null,
      /** `true` seulement si le document part réellement vers le site. */
      served: Boolean(servable && servable.publishedContent),
      /**
       * La RAISON d'un document absent — jamais un simple `false`. Un écran ne
       * peut pas expliquer ce qu'on ne lui dit pas, et l'opérateur resterait
       * devant une page vide sans savoir qui la répare.
       */
      blockedReason: (() => {
        if (!assignedId) return 'NO_ASSIGNMENT';
        if (!raw) return 'TEMPLATE_MISSING';
        if (raw.status === LEGAL_TEMPLATE_STATUS.DRAFT) return 'TEMPLATE_DRAFT';
        if (!raw.publishedContent) return 'TEMPLATE_NEVER_PUBLISHED';
        return null;
      })(),
      completeness,
    };
  }

  return {
    projectId: project.projectId,
    projectName: project.projectName ?? project.projectKey,
    clientCompanyId: project.clientCompanyId ?? null,
    authorities: context.authorities,
    documents,
  };
}

/**
 * ASSIGNE (ou retire) les templates d'un projet, puis publie.
 *
 * `undefined` laisse le champ inchangé ; `null` RETIRE l'affectation. La
 * distinction compte : un écran qui n'envoie qu'un des deux champs ne doit pas
 * effacer l'autre, et un opérateur qui choisit « Aucun » doit pouvoir le faire.
 */
export async function assignProjectLegalDocuments(projectId, input, actor = null) {
  const project = await getProjectOrThrow(projectId);
  const patch = {};
  const touched = [];

  for (const type of LEGAL_DOCUMENT_TYPE_VALUES) {
    const field = ASSIGNMENT_FIELD[type];
    if (!(field in (input ?? {}))) continue;

    const requested = input[field];
    if (requested === null || requested === '') {
      patch[field] = null;
      touched.push(type);
      continue;
    }

    const template = await PanelLegalTemplate.findOne({
      legalTemplateId: String(requested),
      environment: config.env,
    }).lean();

    if (!template) {
      throw ApiError.badRequest(
        'LEGAL_TEMPLATE_NOT_FOUND',
        'Template légal inconnu — il a pu être supprimé depuis le chargement de cet écran.',
        { field },
      );
    }
    /**
     * LE TYPE DOIT CORRESPONDRE AU CHAMP.
     *
     * Sans ce contrôle, une politique de confidentialité assignée au champ
     * « mentions légales » serait servie sur `/mentions-legales` avec le titre
     * « Politique de confidentialité ». Rien n'échouerait ; la page serait
     * simplement fausse, sur un document juridique.
     */
    if (template.type !== type) {
      throw ApiError.badRequest(
        'LEGAL_TEMPLATE_TYPE_MISMATCH',
        `Ce template est de type ${template.type} : il ne peut pas servir de ${type}.`,
        { field, expected: type, received: template.type },
      );
    }
    /**
     * UN BROUILLON N'EST PAS ASSIGNABLE.
     *
     * `assignedTemplate()` refuserait déjà de le servir — la page serait
     * simplement absente. Refuser ICI dit POURQUOI, au moment où quelqu'un
     * peut encore le publier. Un archivé, lui, reste assignable : il sert déjà
     * des projets, et l'interdire créerait deux régimes selon qu'on assigne
     * avant ou après l'archivage.
     */
    if (template.status === LEGAL_TEMPLATE_STATUS.DRAFT) {
      throw ApiError.badRequest(
        'LEGAL_TEMPLATE_NOT_PUBLISHED',
        `« ${template.name} » est un brouillon : publiez-le avant de l'assigner.`,
        { field, legalTemplateId: template.legalTemplateId },
      );
    }

    patch[field] = template.legalTemplateId;
    touched.push(type);
  }

  if (Object.keys(patch).length > 0) {
    await PanelProject.updateOne({ projectId }, { $set: patch });
  }

  /**
   * LA PUBLICATION SUIT L'ENREGISTREMENT, ET DANS CET ORDRE.
   *
   * Publier avant d'écrire enverrait l'ANCIENNE affectation : le site
   * afficherait le template précédent tandis que la fiche annoncerait le
   * nouveau — l'écart le plus difficile à diagnostiquer qui soit, puisque les
   * deux côtés paraissent cohérents avec eux-mêmes.
   */
  const published = {};
  for (const type of touched) {
    published[type] = await publishDocument(projectId, type);
  }

  return {
    ...(await describeProjectLegalDocuments(projectId)),
    published,
    actor: actor?.email ?? null,
    previous: {
      legalNoticeTemplateId: project.legalNoticeTemplateId ?? null,
      privacyPolicyTemplateId: project.privacyPolicyTemplateId ?? null,
    },
  };
}

/** Force une republication des deux documents — bouton « Resynchroniser ». */
export async function resyncProjectLegalDocuments(projectId) {
  await getProjectOrThrow(projectId);
  return publishAllForProject(projectId);
}

export default {
  describeProjectLegalDocuments,
  assignProjectLegalDocuments,
  resyncProjectLegalDocuments,
};
