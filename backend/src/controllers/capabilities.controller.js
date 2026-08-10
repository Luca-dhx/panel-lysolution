// Contrôleurs de la passerelle de capacités — fins, comme le reste du pont.
//
// ── CE QUE CE FICHIER NE CONTIENT PAS ───────────────────────────────────────
//
// Aucun `switch` sur le fournisseur, aucune lecture du coffre, aucune décision
// d'environnement, aucune règle commerciale. Le jour où un contrôleur manipule
// un credential, il finit par le sérialiser — c'est la même raison qui garde
// `controlPlane.service.js` seul devant le coffre en L1.
//
// Il fait trois choses : lire le code dans l'URL, passer la fiche AUTHENTIFIÉE
// (jamais le corps) à la passerelle, et rendre l'enveloppe.
import { ok } from '../utils/apiResponse.js';
import { assertNoProviderSecrets } from '../bridge/providerSecretGuard.js';
import { invokeCapability } from '../services/capabilities/capabilityGateway.service.js';
import { getCapabilityGrants, setCapabilityGrants } from '../services/capabilities/capabilityGrants.js';
import { describeCapabilities } from '../services/capabilities/capabilityRegistry.js';

/* -------------------------------------------------------------------------- */
/*  SURFACE DE PONT — /bridge/v1                                              */
/* -------------------------------------------------------------------------- */

/**
 * `POST /bridge/v1/capabilities/:code/invoke`
 *
 * `req.bridgeProject` vient de `requireBridgeAuth` : c'est LA source
 * d'autorité. Le corps n'est transmis que comme entrée métier — la passerelle
 * refuse elle-même tout `projectId` divergent qu'il porterait.
 */
export async function invoke(req, res) {
  const result = await invokeCapability({
    code: req.params.code,
    panelProject: req.bridgeProject,
    payload: req.body ?? {},
    // Corrélation de bout en bout : si le projet fournit un identifiant de
    // requête, on le reprend plutôt que d'en inventer un second qu'il ne
    // pourrait pas rapprocher de son propre journal.
    requestId: req.get('x-request-id') || undefined,
  });

  /**
   * DÉFENSE EN PROFONDEUR — la garde L4, sur la dernière porte du pont.
   *
   * Le schéma de sortie de la capacité est déjà `strict()` : rien d'inattendu
   * ne devrait arriver ici. Mais c'est exactement ce qu'on disait de la
   * diffusion d'identifiants avant L4, et la leçon de ce lot-là tient en une
   * ligne : une suppression se défait, une garde refuse.
   *
   * Elle dérive du registre des fournisseurs, donc elle connaîtra le cinquième
   * sans qu'on ait pensé à l'ajouter. Le coût est une inspection d'objet ;
   * le bénéfice est qu'aucun adaptateur futur ne pourra faire fuir une clé en
   * la rangeant dans un champ que son schéma autorise.
   */
  assertNoProviderSecrets(result, { label: 'capability' });
  return ok(res, result);
}

/* -------------------------------------------------------------------------- */
/*  SURFACE D'ADMINISTRATION — /api                                           */
/* -------------------------------------------------------------------------- */

/** Le catalogue complet — ce que l'écran du plan de contrôle affiche. */
export function catalogue(_req, res) {
  return ok(res, { capabilities: describeCapabilities() });
}

/** Les octrois d'un projet, et tout ce qu'on POURRAIT lui accorder. */
export async function grants(req, res) {
  return ok(res, await getCapabilityGrants(req.params.projectId));
}

/**
 * Remplace les octrois d'un projet. DEV uniquement (monté ainsi) : accorder une
 * capacité, c'est ouvrir un chemin vers un fournisseur réel.
 */
export async function putGrants(req, res) {
  return ok(res, await setCapabilityGrants(
    req.params.projectId,
    req.body?.capabilities,
    { userId: req.panelUser?.userId ?? null },
  ));
}

export default { invoke, catalogue, grants, putGrants };
