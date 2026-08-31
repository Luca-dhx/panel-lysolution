// LA PROSPECTION — surface interne /api/prospects.
//
// Aucun appel de pont : ces fiches appartiennent au Panel et n'en sortent pas.
import { created, ok } from '../utils/apiResponse.js';
import {
  createProspect,
  deleteProspect,
  describeProspect,
  listProspects,
  setProspectStatus,
  summarizeProspects,
  updateProspect,
} from '../services/prospection/prospects.service.js';
import {
  appliquerImport,
  planifierImport,
} from '../services/prospection/prospectImport.service.js';

/** L'auteur d'une décision. Jamais anonyme. */
const actorOf = (req) => ({
  email: req.panelUser?.email ?? null,
  role: req.panelUser?.role ?? null,
});

export async function list(req, res) {
  const { status = null, type = null } = req.query ?? {};
  const [prospects, summary] = await Promise.all([
    listProspects({ status, type }),
    summarizeProspects(),
  ]);
  return ok(res, { prospects, summary });
}

export async function detail(req, res) {
  return ok(res, await describeProspect(req.params.prospectId));
}

export async function create(req, res) {
  return created(res, { prospect: await createProspect(req.body ?? {}, actorOf(req)) });
}

export async function update(req, res) {
  return ok(res, { prospect: await updateProspect(req.params.prospectId, req.body ?? {}, actorOf(req)) });
}

/**
 * Le STATUT a sa propre route, et ce n'est pas une coquetterie REST.
 *
 * Il se pilote depuis une liste déroulante posée sur une LIGNE de tableau —
 * pas depuis le formulaire d'édition. Le faire passer par le `PATCH` général
 * aurait obligé l'écran à renvoyer la fiche entière pour bouger un curseur, et
 * à écraser au passage ce qu'un autre poste venait d'y écrire.
 */
export async function changeStatus(req, res) {
  return ok(res, {
    prospect: await setProspectStatus(req.params.prospectId, req.body ?? {}, actorOf(req)),
  });
}

export async function remove(req, res) {
  return ok(res, await deleteProspect(req.params.prospectId));
}

/**
 * L'APERÇU D'UN IMPORT — ce qui changerait, si l'on validait.
 *
 * ── POURQUOI C'EST UN `POST` ────────────────────────────────────────────────
 * Rien n'est écrit, mais le document à examiner ne tient pas dans une adresse :
 * il porte des messages entiers, parfois des milliers de caractères. Un `GET`
 * aurait demandé de le hacher dans la requête, et les journaux d'accès
 * auraient conservé le texte des accroches commerciales.
 */
export async function previewImport(req, res) {
  const { document = null, prospectId = null, mode = null } = req.body ?? {};
  return ok(res, { plan: await planifierImport({ document, prospectId, mode }, actorOf(req)) });
}

/**
 * L'IMPORT — la seule route de cette surface qui écrit dans TROIS collections.
 *
 * Le plan renvoyé est RECALCULÉ ici : celui qu'a vu l'écran n'est jamais
 * réutilisé. Une confirmation ne transporte pas une écriture, elle l'autorise.
 */
export async function applyImport(req, res) {
  const { document = null, prospectId = null, mode = null } = req.body ?? {};
  const { prospect, plan } = await appliquerImport({ document, prospectId, mode }, actorOf(req));
  return ok(res, { prospect, plan });
}
