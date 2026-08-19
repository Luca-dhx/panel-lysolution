// L'INTROSPECTION D'IDENTITÉ — surface de pont (L12.B).
//
// ══ CE QUE CETTE ROUTE PERMET, ET CE QU'ELLE FERME ══════════════════════════
//
// Elle permet à un projet de demander « ce développeur a-t-il ENCORE le droit
// d'être chez moi ? » — la question sans laquelle une session fédérée ne
// pourrait être coupée qu'en éditant la base du projet à la main.
//
// Elle ferme l'énumération : le projet ne nomme pas SON projet (il vient du
// jeton), et la réponse ne distingue jamais « ce compte n'existe pas » de
// « ce compte n'a pas accès ici ». Un projet compromis ne peut donc pas
// dresser la liste des employés de L.Y Solution en essayant des identifiants.
//
// ══ POURQUOI POST, POUR UNE LECTURE ═════════════════════════════════════════
//
// Parce que la requête porte un identifiant d'utilisateur et une version de
// session. En GET, les deux finiraient dans les journaux d'accès de tous les
// intermédiaires, et dans l'historique des outils de diagnostic. Le verbe dit
// « lecture » ; le corps garde ses paramètres hors des URL.
import { z } from 'zod';

import { ok } from '../utils/apiResponse.js';
import ApiError from '../utils/ApiError.js';
import { introspectPrincipal } from '../services/federation/federationIntrospection.service.js';

/**
 * `strict()` — un projet qui enverrait `projectId` serait refusé.
 *
 * Ce n'est pas une coquetterie : le seul projet dont il puisse parler est le
 * sien, et un champ toléré ferait croire qu'il peut en désigner un autre.
 */
const introspectionInput = z.object({
  panelUserId: z.string().trim().min(1).max(128),
  /**
   * FACULTATIF, et les deux cas ont un sens distinct :
   *   absent  → « cette personne a-t-elle accès ? »
   *   présent → « …et la session bâtie sur CETTE version tient-elle encore ? »
   */
  tokenVersion: z.number().int().min(0).nullable().optional(),
}).strict();

/** `POST /bridge/v1/federation/introspect` */
export async function introspectFederatedPrincipal(req, res) {
  const projectId = req.bridgeProject?.projectId ?? null;
  if (!projectId) {
    // La route est montée sous `requireBridgeAuth` : ne peut arriver qu'en cas
    // d'erreur de montage. On refuse plutôt que d'introspecter sans périmètre.
    throw ApiError.unauthorized('BRIDGE_UNAUTHORIZED', 'Projet non authentifié.');
  }

  const parsed = introspectionInput.safeParse(req.body ?? {});
  if (!parsed.success) {
    throw ApiError.badRequest(
      'BRIDGE_INVALID_PAYLOAD',
      'Entrée d’introspection non conforme.',
      { issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), code: i.code })) },
    );
  }

  const verdict = await introspectPrincipal({
    panelUserId: parsed.data.panelUserId,
    // Le périmètre vient du JETON. Il n'y a aucun paramètre pour en proposer un autre.
    projectId,
    expectedTokenVersion: parsed.data.tokenVersion ?? null,
  });

  /**
   * LE MOTIF NE DESCEND PAS.
   *
   * Le Panel le journalise ; le projet reçoit `active: false`. Lui rendre
   * « USER_DISABLED » plutôt que « ACCESS_DENIED » lui apprendrait l'existence
   * d'un compte auquel il n'a pas affaire — et sa réaction doit être la même
   * dans tous les cas : fermer la session.
   */
  return ok(res, verdict.active
    ? { active: true, principal: verdict.principal }
    : { active: false });
}

export default { introspectFederatedPrincipal };
