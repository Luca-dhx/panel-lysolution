// Surface ENTREPRISE (/api/company) — Phase 4, LOTS 2, 3 et 4.
//
// Deux familles de routes, deux natures :
//   · l'entreprise et sa configuration versionnée ;
//   · les APIs intégrées et leurs autorisations.
//
// RÈGLE DE SÉCURITÉ TENUE ICI : aucune réponse de ce contrôleur ne contient
// une valeur d'identifiant. Les projections passent toutes par
// `describeApi()`, qui ne rend que des noms de clés et des empreintes. Un
// test le vérifie sur la réponse HTTP réelle, pas seulement sur le service.
import { created, ok } from '../utils/apiResponse.js';
import ApiError from '../utils/ApiError.js';
import {
  createCompany,
  describeCompany,
  describeCompanyPublication,
  describeCompanyDistribution,
  republishCurrentConfiguration,
  companyMediaResolution,
  getActiveCompany,
  getCompanyOrThrow,
  getPublishedConfiguration,
  getVersion,
  listVersions,
  publishConfiguration,
  restoreVersion,
  saveCompany,
  updateCompany,
} from '../services/company/company.service.js';
import {
  createApi,
  deleteApi,
  grantAccess,
  grantsForProject,
  listApis,
  revokeAccess,
  setCredentials,
  updateApi,
} from '../services/company/integratedApi.service.js';

function actorOf(req) {
  return { userId: req.panelUser.userId, userEmail: req.panelUser.email, role: req.panelUser.role };
}

/** Résout l'entreprise visée. Un seul tenant aujourd'hui — voir 57. */
async function targetCompany(req) {
  if (req.params.companyId) return getCompanyOrThrow(req.params.companyId);
  const company = await getActiveCompany();
  if (!company) {
    throw ApiError.notFound('PANEL_COMPANY_NOT_CONFIGURED',
      'Aucune entreprise n’est configurée : le Panel ne sait pas encore qui il représente.');
  }
  return company;
}

/* -------------------------------------------------------------------------- */
/*  ENTREPRISE                                                                */
/* -------------------------------------------------------------------------- */

/**
 * L'entreprise active. Répond 200 avec `company: null` plutôt que 404 :
 * « pas encore configurée » est un état normal du premier démarrage, pas une
 * erreur — l'écran doit pouvoir proposer la création sans traiter un échec.
 */
export async function current(_req, res) {
  const company = await getActiveCompany();
  if (!company) return ok(res, { company: null, published: null });
  const published = await getPublishedConfiguration(company.companyId);
  /**
   * L'ÉTAT DE DIFFUSION EST CALCULÉ, PAS DÉDUIT D'UNE HORLOGE.
   *
   * L'écran affichait « la dernière diffusion n'a pas abouti » sur la foi de
   * `updatedAt > publishedAt` — deux dates de natures différentes. Il lit
   * désormais un verdict obtenu en comparant la fiche à la version publiée.
   */
  const diffusion = await describeCompanyPublication(company);
  return ok(res, {
    company: {
      ...describeCompany(company),
      hasUnpublishedChanges: diffusion.state === 'PENDING',
    },
    /** L'état de diffusion, nommé : NEVER_PUBLISHED · PENDING · PUBLISHED. */
    publication: diffusion,
    /**
     * L'APPLICATION, INSTANCE PAR INSTANCE — sur preuve déclarée.
     *
     * Un booléen global ne dit jamais LAQUELLE est en retard, alors que c'est
     * exactement ce qu'il faut savoir pour agir. La recette et la production
     * d'un même projet sont deux fiches : elles ont chacune leur état.
     */
    distribution: await describeCompanyDistribution(company),
    // Les adresses d'affichage des médias — dérivées à la lecture, jamais
    // stockées. Voir `companyMediaResolution`.
    media: await companyMediaResolution(company),
    published: published
      ? { version: published.version, publishedAt: published.publishedAt, reason: published.reason }
      : null,
  });
}

/**
 * CRÉER — et diffuser aussitôt.
 *
 * Une entreprise créée mais non publiée n’existe pour aucun projet : elle
 * n’était visible que dans le Panel, avec un bandeau expliquant qu’il fallait
 * encore faire un second geste. Créer, c’est déclarer qui l’on est ; il n’y a
 * rien à retenir avant de le dire.
 */
export async function create(req, res) {
  const company = await createCompany(req.body ?? {}, actorOf(req));
  return created(res, await saveCompany(company.companyId, {}, actorOf(req)));
}

/**
 * ENREGISTRER — c’est-à-dire DIFFUSER.
 *
 * Il n’y a plus de brouillon : ce que l’écran montre est ce que les projets
 * appliquent. La version est figée à chaque enregistrement, avec son diff ;
 * aucune justification n’est demandée.
 */
export async function update(req, res) {
  const company = await targetCompany(req);
  return ok(res, await saveCompany(company.companyId, req.body ?? {}, actorOf(req)));
}

/* -------------------------------------------------------------------------- */
/*  CONFIGURATION VERSIONNÉE                                                  */
/* -------------------------------------------------------------------------- */

export async function publish(req, res) {
  const company = await targetCompany(req);
  return created(res, await publishConfiguration(company.companyId, { reason: req.body?.reason }, actorOf(req)));
}

/**
 * REDIFFUSE la version en vigueur — sans rien enregistrer.
 *
 * L'écran proposait « Enregistrez de nouveau » quand une diffusion n'avait pas
 * abouti. C'était le mauvais geste : enregistrer touche la fiche et peut créer
 * une version, alors que seul le transport avait manqué. Cette action ne fait
 * qu'une chose, et elle est rejouable sans effet de bord.
 */
export async function republish(req, res) {
  const company = await targetCompany(req);
  return ok(res, await republishCurrentConfiguration(company.companyId));
}

export async function versions(req, res) {
  const company = await targetCompany(req);
  const items = await listVersions(company.companyId, Number(req.query.limit ?? 50));
  return ok(res, {
    currentVersion: company.publishedVersion,
    items: items.map((v) => ({
      version: v.version,
      reason: v.reason,
      publishedAt: v.publishedAt,
      publishedBy: v.publishedByEmail ?? v.publishedBy,
      changeCount: v.changes.length,
      current: v.version === company.publishedVersion,
    })),
  });
}

/** Le détail d'une version — l'instantané complet et son différentiel. */
export async function version(req, res) {
  const company = await targetCompany(req);
  return ok(res, await getVersion(company.companyId, Number(req.params.version)));
}

export async function restore(req, res) {
  const company = await targetCompany(req);
  return created(res, await restoreVersion(company.companyId, Number(req.params.version), actorOf(req)));
}

/* -------------------------------------------------------------------------- */
/*  INTEGRATED API                                                            */
/* -------------------------------------------------------------------------- */

export async function apis(req, res) {
  const company = await targetCompany(req);
  return ok(res, { items: await listApis(company.companyId) });
}

export async function createIntegratedApi(req, res) {
  return created(res, await createApi(req.body ?? {}, actorOf(req)));
}

export async function updateIntegratedApi(req, res) {
  return ok(res, await updateApi(req.params.apiId, req.body ?? {}, actorOf(req)));
}

export async function removeIntegratedApi(req, res) {
  return ok(res, await deleteApi(req.params.apiId));
}

/**
 * Enregistre des identifiants. Le corps porte des secrets en clair : c'est le
 * seul endroit de la surface /api où cela arrive, et c'est inévitable — il
 * faut bien les saisir une fois. Ils sont chiffrés immédiatement et ne
 * ressortent jamais.
 */
export async function putCredentials(req, res) {
  const { values = {}, remove = [] } = req.body ?? {};
  return ok(res, await setCredentials(
    req.params.apiId,
    req.params.mode,
    { values, remove },
    actorOf(req),
  ));
}

export async function grant(req, res) {
  const { projectId, keys = [] } = req.body ?? {};
  if (!projectId) {
    throw ApiError.badRequest('PANEL_INTEGRATED_API_PROJECT_REQUIRED',
      'Autorisation refusée parce qu’aucun projet n’a été désigné.');
  }
  return created(res, await grantAccess(req.params.apiId, projectId, { keys }, actorOf(req)));
}

export async function revoke(req, res) {
  return ok(res, await revokeAccess(req.params.apiId, req.params.projectId));
}

/** Les autorisations d'un projet — pour la fiche projet. Aucun secret. */
export async function projectGrants(req, res) {
  return ok(res, { items: await grantsForProject(req.params.projectId) });
}
