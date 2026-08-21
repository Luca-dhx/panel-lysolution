// SURFACE « CLIENTS » (/api/client-companies) — les entreprises clientes.
//
// ══ CE QUE CE CONTRÔLEUR GARANTIT, ET QUE LE SERVICE NE PEUT PAS ════════════
//
// Deux choses, toutes deux propres à HTTP :
//
//   1. LE RELAIS MÉDIA. Un document déposé depuis une instance qui n'est pas
//      l'autorité doit partir vers celle qui stocke — sans quoi le descripteur
//      (écrit dans la base PARTAGÉE) désignerait un fichier qui n'existe que
//      sur un poste de développement. Même geste que `upload.routes.js` pour
//      les images, et pour la même raison.
//
//   2. LA SORTIE D'UN DOCUMENT PRIVÉ. `attachment`, `nosniff`, `no-store`, et
//      le nom sous ses DEUX formes (RFC 6266 / RFC 5987) — sans quoi un Kbis
//      d'« Août » s'enregistrerait sous « AoÃ»t.pdf ».
//
// Aucune règle métier ici : la validation, l'appartenance et les traces
// appartiennent aux services.
import { created, ok } from '../utils/apiResponse.js';
import ApiError from '../utils/ApiError.js';
import {
  archiveClientCompany,
  createClientCompany,
  deleteClientCompany,
  getClientCompanyDetail,
  linkProjectToClientCompany,
  listClientCompanies,
  restoreClientCompany,
  unlinkProjectFromClientCompany,
  updateClientCompany,
} from '../services/clientCompany/clientCompany.service.js';
import {
  attachClientDocument,
  detachClientDocument,
  readClientDocument,
} from '../services/clientCompany/clientDocuments.service.js';
import { relayToAuthority, resolveMediaAuthority } from '../services/upload/mediaAuthority.js';

function actorOf(req) {
  return { userId: req.panelUser.userId, userEmail: req.panelUser.email, role: req.panelUser.role };
}

/* -------------------------------------------------------------------------- */
/*  FICHES                                                                    */
/* -------------------------------------------------------------------------- */

export async function list(req, res) {
  const clientCompanies = await listClientCompanies({
    search: req.query?.search ?? '',
    /**
     * Le filtre d'état est une ÉNUMÉRATION, jamais une chaîne libre relayée
     * jusqu'à Mongo. `undefined` (le défaut) rend tout, archives comprises :
     * l'écran choisit ce qu'il montre, l'API ne décide pas à sa place.
     */
    status: ['ACTIVE', 'ARCHIVED'].includes(req.query?.status) ? req.query.status : null,
  });
  return ok(res, { clientCompanies });
}

export async function detail(req, res) {
  return ok(res, { clientCompany: await getClientCompanyDetail(req.params.clientCompanyId) });
}

export async function create(req, res) {
  return created(res, await createClientCompany(req.body ?? {}, actorOf(req)));
}

export async function update(req, res) {
  return ok(res, await updateClientCompany(req.params.clientCompanyId, req.body ?? {}, actorOf(req)));
}

export async function archive(req, res) {
  return ok(res, await archiveClientCompany(req.params.clientCompanyId, actorOf(req)));
}

export async function restore(req, res) {
  return ok(res, await restoreClientCompany(req.params.clientCompanyId, actorOf(req)));
}

export async function remove(req, res) {
  return ok(res, await deleteClientCompany(req.params.clientCompanyId, actorOf(req)));
}

/* -------------------------------------------------------------------------- */
/*  RATTACHEMENT                                                              */
/* -------------------------------------------------------------------------- */

/**
 * RATTACHE un projet — le corps porte le projet, l'adresse porte l'entreprise.
 *
 * On aurait pu écrire `PATCH /api/projects/:id { clientCompanyId }`. La forme
 * retenue place le geste dans le domaine qui en est l'AUTORITÉ : c'est
 * l'entreprise qui acquiert un projet, et la route de projet n'a pas à savoir
 * ce qu'est un client légal.
 */
export async function linkProject(req, res) {
  const projectId = String(req.body?.projectId ?? '').trim();
  if (!projectId) {
    throw ApiError.badRequest('PANEL_PROJECT_ID_REQUIRED', 'Un identifiant de projet est requis.');
  }
  return ok(res, await linkProjectToClientCompany(
    projectId, req.params.clientCompanyId, actorOf(req),
  ));
}

export async function unlinkProject(req, res) {
  return ok(res, await unlinkProjectFromClientCompany(req.params.projectId, actorOf(req)));
}

/* -------------------------------------------------------------------------- */
/*  DOCUMENTS                                                                 */
/* -------------------------------------------------------------------------- */

/** Le seul en-tête relayé : l'identité de l'appelant. */
const identite = (req) => {
  const jeton = req.get('authorization');
  return jeton ? { authorization: jeton } : {};
};

/** Réémet la réponse de l'autorité sans la réinterpréter. */
async function rendreAmont(res, amont) {
  const type = amont.headers.get('content-type') || 'application/json';
  /**
   * UN DOCUMENT N'EST PAS DU TEXTE.
   *
   * Le relais des images lit `text()` parce que l'autorité y répond du JSON.
   * Ici la réponse peut être un PDF : le relire en texte le corromprait
   * silencieusement — l'utilisateur téléchargerait un fichier de la bonne
   * taille apparente et illisible. On relaie donc les OCTETS, et l'on recopie
   * les en-têtes qui décident de leur sort.
   */
  const octets = Buffer.from(await amont.arrayBuffer());
  const disposition = amont.headers.get('content-disposition');
  if (disposition) res.setHeader('Content-Disposition', disposition);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  return res.status(amont.status).type(type).send(octets);
}

export async function uploadDocument(req, res) {
  if (!req.file) {
    throw ApiError.badRequest('PANEL_DOCUMENT_EMPTY', 'Aucun fichier reçu.');
  }
  const { clientCompanyId } = req.params;
  const { authority, isAuthority } = await resolveMediaAuthority();

  if (!isAuthority) {
    /**
     * INSTANCE CLIENTE — on relaie, on n'écrit pas.
     *
     * Le fichier est déjà en mémoire : on le réémet tel que l'appelant l'a
     * envoyé, métadonnées comprises. C'est l'autorité qui validera les octets,
     * écrira le média ET référencera le document sur la fiche — les deux
     * gestes doivent se produire du même côté, sinon la fiche pointerait vers
     * un fichier absent.
     */
    const corps = new FormData();
    corps.append(
      'file',
      new Blob([req.file.buffer], { type: req.file.mimetype || 'application/octet-stream' }),
      req.file.originalname || 'document',
    );
    for (const cle of ['label', 'type', 'documentDate']) {
      if (req.body?.[cle] !== undefined && req.body[cle] !== null) {
        corps.append(cle, String(req.body[cle]));
      }
    }
    const amont = await relayToAuthority(
      authority,
      `/api/client-companies/${encodeURIComponent(clientCompanyId)}/documents`,
      { method: 'POST', headers: identite(req), body: corps },
    );
    return rendreAmont(res, amont);
  }

  await attachClientDocument(
    clientCompanyId,
    {
      buffer: req.file.buffer,
      filename: req.file.originalname,
      meta: {
        label: req.body?.label,
        type: req.body?.type,
        documentDate: req.body?.documentDate,
      },
    },
    actorOf(req),
  );
  return created(res, { clientCompany: await getClientCompanyDetail(clientCompanyId) });
}

/**
 * TÉLÉCHARGE un document — la SEULE voie de sortie.
 *
 * Aucun chemin disque, aucune clé d'objet, aucune URL n'accompagne les octets.
 * `attachment` et `nosniff` interdisent l'ouverture DANS l'origine du Panel :
 * un PDF y serait inoffensif aujourd'hui, l'en-tête sera déjà en place le jour
 * où un type s'ajoutera à la table.
 */
export async function downloadDocument(req, res) {
  const { clientCompanyId, documentId } = req.params;
  const { authority, isAuthority } = await resolveMediaAuthority();

  if (!isAuthority) {
    const amont = await relayToAuthority(
      authority,
      `/api/client-companies/${encodeURIComponent(clientCompanyId)}`
      + `/documents/${encodeURIComponent(documentId)}`,
      { method: 'GET', headers: identite(req) },
    );
    return rendreAmont(res, amont);
  }

  const { entry, media, buffer } = await readClientDocument(clientCompanyId, documentId);

  /**
   * LE NOM RENDU EST CELUI DU DOCUMENT, pas celui du fichier déposé.
   *
   * L'opérateur a nommé la pièce (« Kbis 2026 ») ; le nom du fichier d'origine
   * est souvent « scan0012.pdf ». On rend le premier, avec l'extension du type
   * RÉELLEMENT mesuré — jamais celle du nom déposé, qui n'est pas une preuve.
   */
  const extension = String(media.originalFilename ?? '').split('.').pop() || 'pdf';
  const nom = `${String(entry.label).replace(/["\\/:*?<>|]/g, '')}.${extension}`;
  const repliAscii = nom.replace(/[^ -~]/g, '_');

  res.setHeader('Content-Type', media.mime);
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="${repliAscii}"; filename*=UTF-8''${encodeURIComponent(nom)}`,
  );
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'private, no-store');
  return res.send(buffer);
}

export async function removeDocument(req, res) {
  const { clientCompanyId, documentId } = req.params;
  const { authority, isAuthority } = await resolveMediaAuthority();

  if (!isAuthority) {
    const amont = await relayToAuthority(
      authority,
      `/api/client-companies/${encodeURIComponent(clientCompanyId)}`
      + `/documents/${encodeURIComponent(documentId)}`,
      { method: 'DELETE', headers: identite(req) },
    );
    return rendreAmont(res, amont);
  }

  await detachClientDocument(clientCompanyId, documentId, actorOf(req));
  return ok(res, { clientCompany: await getClientCompanyDetail(clientCompanyId) });
}
