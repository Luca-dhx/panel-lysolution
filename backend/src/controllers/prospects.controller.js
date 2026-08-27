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
