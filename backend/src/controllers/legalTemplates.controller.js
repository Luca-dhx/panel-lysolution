// LES DOCUMENTS LÉGAUX — surface interne `/api/legal-templates` et
// `/api/host-companies`.
//
// Les contrôleurs ne portent AUCUNE règle : ils traduisent une requête HTTP en
// appel de service et rendent l'enveloppe. Toute décision — validation, refus
// de suppression, publication — vit dans `services/legal/`, où elle est
// testable sans serveur.
import { created, ok } from '../utils/apiResponse.js';
import ApiError from '../utils/ApiError.js';
import { LEGAL_VARIABLES, VARIABLE_SOURCE_LABELS } from '../services/legal/legalVariableRegistry.js';
import legalTemplates from '../services/legal/legalTemplate.service.js';
import hostCompanies from '../services/legal/hostCompany.service.js';
import {
  ASSIGNMENT_FIELD,
  resolveDocument,
  resolveLegalContext,
} from '../services/legal/legalDocumentResolver.js';
import { republishFleet, republishTemplate } from '../services/legal/legalDocumentPublisher.js';
import PanelProject from '../models/PanelProject.model.js';
import config from '../config/env.js';

/** L'acteur — jamais deviné : c'est l'authentification qui l'établit. */
function actorOf(req) {
  return req.panelUser ? { userId: req.panelUser.userId, email: req.panelUser.email } : null;
}

/* -------------------------------------------------------------------------- */
/*  LE REGISTRE                                                               */
/* -------------------------------------------------------------------------- */

/**
 * LA PALETTE « + Insérer une donnée ».
 *
 * Servie par le backend et non recopiée dans le frontend : le registre est
 * code-first et fait autorité. Deux copies divergeraient à la première
 * variable ajoutée, et l'éditeur proposerait alors une donnée que le
 * validateur refuse — ou l'inverse, ce qui est pire.
 */
export const variables = async (req, res) => ok(res, {
  sources: VARIABLE_SOURCE_LABELS,
  variables: LEGAL_VARIABLES,
});

/* -------------------------------------------------------------------------- */
/*  CATALOGUE                                                                 */
/* -------------------------------------------------------------------------- */

export const list = async (req, res) => ok(res, {
  templates: await legalTemplates.listTemplates({ type: req.query.type ?? null }),
});

export const detail = async (req, res) => ok(
  res,
  await legalTemplates.getTemplateDetail(req.params.legalTemplateId),
);

export const create = async (req, res) => created(
  res,
  await legalTemplates.createTemplate(req.body ?? {}, actorOf(req)),
);

export const update = async (req, res) => ok(
  res,
  await legalTemplates.updateTemplate(req.params.legalTemplateId, req.body ?? {}, actorOf(req)),
);

/**
 * PUBLIER — le service reçoit le republieur par injection.
 *
 * Le passer ici, plutôt que de le laisser s'importer, casse le cycle
 * `service → publisher → service`. Node résout un cycle par un module à moitié
 * initialisé, c'est-à-dire par une fonction `undefined` au premier appel — en
 * production, sur le geste qui met des mentions légales en ligne.
 */
export const publish = async (req, res) => ok(
  res,
  await legalTemplates.publishTemplate(
    req.params.legalTemplateId,
    actorOf(req),
    { republish: republishTemplate },
  ),
);

export const archive = async (req, res) => ok(
  res,
  await legalTemplates.archiveTemplate(req.params.legalTemplateId, actorOf(req)),
);

export const restore = async (req, res) => ok(
  res,
  await legalTemplates.restoreTemplate(req.params.legalTemplateId, actorOf(req)),
);

export const remove = async (req, res) => ok(
  res,
  await legalTemplates.deleteTemplate(req.params.legalTemplateId),
);

export const versions = async (req, res) => ok(res, {
  versions: await legalTemplates.listVersions(req.params.legalTemplateId),
});

export const restoreVersion = async (req, res) => ok(
  res,
  await legalTemplates.restoreVersion(
    req.params.legalTemplateId,
    Number(req.params.version),
    actorOf(req),
  ),
);

/* -------------------------------------------------------------------------- */
/*  APERÇU                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * L'APERÇU AVEC LES DONNÉES RÉELLES D'UN PROJET.
 *
 * ══ POURQUOI IL SERT LE BROUILLON ══════════════════════════════════════════
 *
 * C'est tout l'objet de l'aperçu : voir ce qu'on s'apprête à publier. Servir
 * `publishedContent` montrerait ce qui est DÉJÀ en ligne, c'est-à-dire
 * l'inverse de ce qu'on vient chercher.
 *
 * ══ POURQUOI IL PASSE PAR LE MÊME RÉSOLVEUR QUE LA PUBLICATION ═════════════
 *
 * Pour que ce qu'on relit soit EXACTEMENT ce qui partira — mêmes valeurs, même
 * règle de conditionnalité, mêmes blocs retirés. Un aperçu qui aurait son
 * propre rendu finirait par mentir, et l'on publierait à l'aveugle en croyant
 * l'inverse.
 *
 * ══ LA COMPLÉTUDE VOYAGE AVEC L'APERÇU ═════════════════════════════════════
 *
 * Un bloc retiré est INVISIBLE — c'est le but. Sans le décompte à côté, on ne
 * saurait pas distinguer « ce template n'a pas de section TVA » de « le numéro
 * de TVA de ce client n'est pas renseigné ».
 */
export const preview = async (req, res) => {
  const template = await legalTemplates.getTemplateOrThrow(req.params.legalTemplateId);
  const projectId = String(req.query.projectId ?? '').trim();

  if (!projectId) {
    throw ApiError.badRequest(
      'LEGAL_PREVIEW_PROJECT_REQUIRED',
      'Choisissez un projet pour visualiser le document avec ses vraies données.',
    );
  }

  const resolved = await resolveDocument({ projectId, template, preview: true });
  return ok(res, {
    document: resolved.document,
    completeness: resolved.completeness,
    authorities: resolved.context.authorities,
    project: {
      projectId: resolved.context.projectId,
      projectName: resolved.context.projectName,
      clientCompanyId: resolved.context.clientCompanyId,
    },
  });
};

/**
 * LES PROJETS PROPOSABLES À L'APERÇU.
 *
 * Ceux du monde courant, avec leur entreprise cliente quand elle existe. Un
 * projet sans entreprise reste proposable : l'aperçu montrera alors ce qui
 * manque, ce qui est précisément l'information utile.
 */
export const previewTargets = async (req, res) => {
  const projects = await PanelProject.find({})
    .select('projectId projectKey projectName clientCompanyId legalNoticeTemplateId privacyPolicyTemplateId')
    .sort({ projectName: 1 })
    .lean();
  return ok(res, {
    projects: projects.map((p) => ({
      projectId: p.projectId,
      projectKey: p.projectKey,
      projectName: p.projectName ?? p.projectKey,
      hasClientCompany: Boolean(p.clientCompanyId),
      assigned: {
        LEGAL_NOTICE: p.legalNoticeTemplateId ?? null,
        PRIVACY_POLICY: p.privacyPolicyTemplateId ?? null,
      },
    })),
  });
};

/** La complétude d'un projet — sans template : « quelles données a-t-on ? ». */
export const projectContext = async (req, res) => {
  const context = await resolveLegalContext(req.params.projectId);
  return ok(res, {
    projectId: context.projectId,
    projectName: context.projectName,
    authorities: context.authorities,
    /**
     * Les VALEURS sont rendues, et c'est assumé : cette surface est l'API
     * INTERNE du Panel, gardée par un jeton d'opérateur. Elle sert l'écran qui
     * dit « SIRET du client : renseigné / non renseigné ». Ne rendre que des
     * booléens obligerait à rouvrir la fiche pour vérifier une valeur suspecte.
     */
    values: context.values,
  });
};

/* -------------------------------------------------------------------------- */
/*  HÉBERGEUR                                                                 */
/* -------------------------------------------------------------------------- */

export const listHosts = async (req, res) => ok(res, {
  hosts: await hostCompanies.listHostCompanies(),
  active: await hostCompanies.activeHostCompany(),
  environment: config.env,
});

export const createHost = async (req, res) => {
  const host = await hostCompanies.createHostCompany(req.body ?? {}, actorOf(req));
  /**
   * TOUT LE PARC EST REPUBLIÉ APRÈS UN CHANGEMENT D'HÉBERGEUR.
   *
   * L'hébergeur figure sur les mentions légales de CHAQUE site. Sans
   * republication, la fiche serait à jour au Panel et fausse partout ailleurs —
   * et rien à l'écran ne le signalerait, puisque le Panel n'affiche que ce
   * qu'il sait.
   *
   * Non bloquant : la file de synchronisation est durable et rattrape au
   * tirage. Refuser l'enregistrement parce qu'un projet est éteint punirait la
   * saisie d'une panne qui n'a rien à voir.
   */
  await republishFleet().catch(() => 0);
  return created(res, host);
};

export const updateHost = async (req, res) => {
  const host = await hostCompanies.updateHostCompany(
    req.params.hostCompanyId,
    req.body ?? {},
    actorOf(req),
  );
  await republishFleet().catch(() => 0);
  return ok(res, host);
};

export const setHostStatus = async (req, res) => {
  const host = await hostCompanies.setHostCompanyStatus(
    req.params.hostCompanyId,
    String(req.body?.status ?? '').toUpperCase(),
    actorOf(req),
  );
  await republishFleet().catch(() => 0);
  return ok(res, host);
};

export { ASSIGNMENT_FIELD };
