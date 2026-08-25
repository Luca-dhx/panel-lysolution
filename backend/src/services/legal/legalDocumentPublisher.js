// LA PUBLICATION D'UN DOCUMENT LÉGAL VERS UN PROJET.
//
// ══ LE POINT UNIQUE PAR LEQUEL UN DOCUMENT ATTEINT UN SITE ══════════════════
//
// Quatre événements déclenchent une publication, et tous passent par ici :
//
//   · on PUBLIE un template          → tous les projets qui l'utilisent ;
//   · on ASSIGNE un template          → ce projet ;
//   · on RETIRE une affectation       → ce projet (tombstone) ;
//   · une DONNÉE d'entreprise change  → les projets concernés.
//
// Un cinquième chemin existait dans toutes les architectures qui ont eu ce
// problème : la vitrine appelant le Panel à l'affichage. Il n'existe pas ici,
// et c'est délibéré (voir la doctrine de `LEGAL_DOCUMENT` au contrat).
//
// ══ POURQUOI UN COMPTEUR PAR PROJET, ET NON LA VERSION DU TEMPLATE ══════════
//
// L'applicateur du projet écarte les écritures plus anciennes que celle qu'il
// applique déjà — c'est la garde qui empêche un rattrapage désordonné de faire
// clignoter la page entre trois versions.
//
// Cette garde compare des NUMÉROS. Si le numéro était `templateVersion`,
// basculer un projet du template A (version 4) vers le template B (version 1)
// produirait une écriture « version 1 » que le projet rejetterait comme
// périmée : le site continuerait d'afficher A, et rien n'indiquerait pourquoi.
// C'est exactement le scénario du test dynamique sans rebuild.
//
// `documentVersion` est donc un compteur PAR PROJET ET PAR TYPE, monotone, qui
// s'incrémente à chaque publication quelle qu'en soit la cause. Il ne décrit
// pas le template : il décrit la suite des documents qu'un projet a reçus.
import config from '../../config/env.js';
import logger from '../../utils/logger.js';
import PanelProject from '../../models/PanelProject.model.js';
import { LEGAL_DOCUMENT_TYPE_VALUES } from '../../models/PanelLegalTemplate.model.js';
import {
  legalDocumentPayloadSchema,
  nowIso,
  stableBridgeId,
} from '../../bridge/bridgeContract.js';
import { emitChange } from '../sync/syncCore.service.js';
import PanelLegalDocumentState from '../../models/PanelLegalDocumentState.model.js';
import {
  ASSIGNMENT_FIELD,
  assignedTemplate,
  resolveDocument,
  resolveLegalContext,
} from './legalDocumentResolver.js';

export const LEGAL_DOCUMENT_ENTITY = 'LEGAL_DOCUMENT';

/**
 * L'IDENTIFIANT D'ENTITÉ — dérivé de `(projectId, type)`, jamais du template.
 *
 * ══ POURQUOI PAS DU TEMPLATE ═══════════════════════════════════════════════
 *
 * Parce que changer l'affectation d'un projet doit REMPLACER son document, pas
 * en ajouter un second. Un `entityId` dérivé du template ferait coexister, dans
 * la base du projet, le document de l'ancien template et celui du nouveau — et
 * la page afficherait celui que la lecture trouve en premier.
 *
 * Dérivé du projet ET du type, il y a exactement deux entités légales par
 * projet, pour toujours, et chaque publication écrase la précédente.
 *
 * UUID v5 : même graine, même résultat. L'idempotence du pont — qui repose sur
 * `entityId` — est préservée sans stocker un second identifiant à tenir
 * cohérent. Le contrat impose un UUID ; un identifiant métier émis tel quel
 * ferait REJETER l'écriture à l'arrivée, et un rejet de lecture est une perte
 * définitive.
 */
function bridgeEntityId(projectId, type) {
  return stableBridgeId(`legal-document:${projectId}:${type}`);
}

/** Incrémente et rend le compteur de publication d'un couple (projet, type). */
async function nextDocumentVersion(projectId, type) {
  const state = await PanelLegalDocumentState.findOneAndUpdate(
    { projectId, type },
    {
      $inc: { documentVersion: 1 },
      $setOnInsert: { projectId, type, createdAt: nowIso() },
      $set: { updatedAt: nowIso() },
    },
    { upsert: true, new: true },
  ).lean();
  return state.documentVersion;
}

/**
 * PUBLIE UN TYPE DE DOCUMENT VERS UN PROJET.
 *
 * Rend `{ published, reason }`. Ne LÈVE que sur une anomalie de contrat — une
 * charge utile non conforme est un défaut de ce module, pas une situation
 * d'exploitation. Les situations d'exploitation (pas d'affectation, template en
 * brouillon, aucune entreprise cliente) rendent `published: false` avec une
 * raison lisible : elles n'ont pas à faire échouer l'enregistrement qui les a
 * déclenchées.
 */
export async function publishDocument(projectId, type, { context = null } = {}) {
  const project = await PanelProject.findOne({ projectId }).lean();
  if (!project) return { published: false, reason: 'PROJECT_NOT_FOUND' };

  const template = await assignedTemplate(project, type);

  /**
   * PAS D'AFFECTATION — ON EFFACE, ON NE LAISSE PAS TRAÎNER.
   *
   * Retirer l'affectation d'un projet doit faire disparaître sa page, sinon
   * l'ancien document resterait servi indéfiniment et personne ne saurait d'où
   * il vient. Le tombstone est le seul moyen de le dire à un projet : une
   * absence d'écriture ne se distingue pas d'une panne de synchronisation.
   */
  if (!template) {
    await emitChange({
      entityType: LEGAL_DOCUMENT_ENTITY,
      entityId: bridgeEntityId(projectId, type),
      deleted: true,
      payload: null,
      modifiedAt: nowIso(),
      audience: projectId,
    });
    return { published: false, reason: 'NO_ASSIGNMENT', tombstoned: true };
  }

  let resolved;
  try {
    resolved = await resolveDocument({ projectId, template, context });
  } catch (err) {
    // `LEGAL_TEMPLATE_NOT_PUBLISHED` est le seul cas attendu : un template
    // assigné puis dépublié. On ne pousse rien — et surtout on n'efface rien :
    // le dernier document valide reste en ligne, ce qui vaut mieux qu'une page
    // vide sur une obligation légale.
    return { published: false, reason: err.code ?? 'RESOLUTION_FAILED' };
  }

  const { document } = resolved;

  /**
   * UN DOCUMENT SANS SECTION NE PART PAS.
   *
   * Il peut arriver : un template dont TOUS les blocs référencent des données
   * manquantes se résout en document vide. Le publier remplacerait une page
   * correcte par une page blanche — le contraire de ce que la règle de
   * conditionnalité cherche à protéger. On refuse, avec une raison que l'écran
   * de complétude explique déjà.
   */
  if (!document.sections.length) {
    return { published: false, reason: 'DOCUMENT_EMPTY', completeness: resolved.completeness };
  }

  const documentVersion = await nextDocumentVersion(projectId, type);

  const payload = {
    type: document.type,
    /**
     * LE PROJET EST RÉPÉTÉ DANS LA CHARGE UTILE — seconde barrière.
     *
     * L'audience de l'écriture décide déjà de qui reçoit quoi ; c'est la
     * barrière qui compte, et elle est portée par le journal. Celle-ci est une
     * VÉRIFICATION CROISÉE : le projet compare ce champ à sa propre identité et
     * REFUSE un document qui ne le nomme pas. Une erreur d'audience — un
     * `projectId` mal passé, un rejeu vers le mauvais destinataire — devient
     * alors un refus bruyant au lieu d'un affichage silencieux des mentions
     * légales d'un autre client.
     *
     * Deux barrières indépendantes pour la même garantie, chacune tenue par un
     * côté différent : c'est la leçon de l'incident FJ / KleenPro.
     */
    projectId,
    templateId: document.templateId,
    templateName: document.templateName,
    templateVersion: document.templateVersion ?? 0,
    documentVersion,
    environment: config.env,
    title: document.title,
    sections: document.sections,
    updatedAt: document.updatedAt,
  };

  /**
   * ON RELIT NOTRE PROPRE PRODUCTION AVANT DE L'ÉMETTRE.
   *
   * Le projet valide à l'arrivée en `.strict()`. Une charge utile non conforme
   * y serait ÉCARTÉE, et un rejet de lecture est une perte définitive : le
   * curseur avance, le Panel ne relivre pas. Le site resterait sans mentions
   * légales pendant que tout paraîtrait normal côté Panel.
   *
   * L'échec est donc immédiat, ici, chez le producteur.
   */
  legalDocumentPayloadSchema.parse(payload);

  await emitChange({
    entityType: LEGAL_DOCUMENT_ENTITY,
    entityId: bridgeEntityId(projectId, type),
    payload,
    modifiedAt: nowIso(),
    audience: projectId,
  });

  return { published: true, documentVersion, templateVersion: payload.templateVersion };
}

/** Publie LES DEUX types pour un projet. Utilisé après un changement de données. */
export async function publishAllForProject(projectId) {
  /**
   * LE CONTEXTE EST RÉSOLU UNE FOIS POUR LES DEUX DOCUMENTS.
   *
   * Ce sont trois lectures de base par document, et surtout : deux résolutions
   * séparées pourraient tomber de part et d'autre d'une modification de fiche
   * cliente, et publier deux documents qui ne décrivent pas la même entreprise.
   */
  const context = await resolveLegalContext(projectId).catch(() => null);
  const results = {};
  for (const type of LEGAL_DOCUMENT_TYPE_VALUES) {
    // eslint-disable-next-line no-await-in-loop
    results[type] = await publishDocument(projectId, type, { context });
  }
  return results;
}

/**
 * REPUBLIE un template vers TOUS les projets qui l'utilisent.
 *
 * Une écriture par projet, et non une diffusion générale : c'est le prix de la
 * confidentialité, et il est dérisoire. Un template est partagé par une
 * poignée de projets, et chacun reçoit un document résolu avec SES données —
 * une diffusion générale n'aurait de toute façon aucun sens ici, puisque le
 * contenu diffère par destinataire.
 */
export async function republishTemplate(legalTemplateId) {
  const projects = await PanelProject.find({
    $or: [
      { legalNoticeTemplateId: legalTemplateId },
      { privacyPolicyTemplateId: legalTemplateId },
    ],
  })
    .select('projectId legalNoticeTemplateId privacyPolicyTemplateId')
    .lean();

  let recipients = 0;
  for (const project of projects) {
    for (const type of LEGAL_DOCUMENT_TYPE_VALUES) {
      if (project[ASSIGNMENT_FIELD[type]] !== legalTemplateId) continue;
      // eslint-disable-next-line no-await-in-loop
      const result = await publishDocument(project.projectId, type);
      if (result.published) recipients += 1;
      else {
        logger.warn(
          `[legal] ${project.projectId} / ${type} non republié : ${result.reason}.`,
        );
      }
    }
  }
  return recipients;
}

/**
 * REPUBLIE les projets rattachés à une entreprise cliente.
 *
 * Corriger l'adresse d'un client doit mettre à jour ses mentions légales sans
 * qu'on ait à rouvrir l'éditeur de templates. C'est ce qui rend la donnée
 * réellement centrale : un seul endroit à corriger, quel que soit le nombre de
 * documents qui la citent.
 */
export async function republishForClientCompany(clientCompanyId) {
  const projects = await PanelProject.find({ clientCompanyId }).select('projectId').lean();
  let recipients = 0;
  for (const project of projects) {
    // eslint-disable-next-line no-await-in-loop
    const results = await publishAllForProject(project.projectId);
    recipients += Object.values(results).filter((r) => r.published).length;
  }
  return recipients;
}

/**
 * REPUBLIE TOUT LE PARC — après un changement d'hébergeur ou d'identité
 * développeur, qui concernent tous les projets à la fois.
 *
 * Seuls les projets AYANT une affectation sont visités : republier un projet
 * sans document produirait deux tombstones par projet à chaque enregistrement
 * de la fiche « Mon entreprise », c'est-à-dire du bruit durable dans le journal
 * de synchronisation de tout le parc.
 */
export async function republishFleet() {
  const projects = await PanelProject.find({
    $or: [
      { legalNoticeTemplateId: { $ne: null } },
      { privacyPolicyTemplateId: { $ne: null } },
    ],
  })
    .select('projectId')
    .lean();

  let recipients = 0;
  for (const project of projects) {
    // eslint-disable-next-line no-await-in-loop
    const results = await publishAllForProject(project.projectId);
    recipients += Object.values(results).filter((r) => r.published).length;
  }
  return recipients;
}

export default {
  LEGAL_DOCUMENT_ENTITY,
  publishDocument,
  publishAllForProject,
  republishTemplate,
  republishForClientCompany,
  republishFleet,
};
