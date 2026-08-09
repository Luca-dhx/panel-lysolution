// SURFACE /api DU PLAN DE CONTRÔLE INTEGRATEDAPI — L1.
//
// Le contrôleur ne connaît NI le chiffrement, NI le modèle Mongo, NI le
// registre. Il traduit une requête HTTP en appel de service, et rend ce que le
// service a jugé présentable. C'est ce qui garantit qu'aucune valeur
// confidentielle ne peut fuir par ici : il n'y a pas accès.
import controlPlane from '../services/integratedApi/controlPlane.service.js';
import ApiError from '../utils/ApiError.js';
import { ok } from '../utils/apiResponse.js';

/** GET /api/integrated-apis — le catalogue et l'état de chaque jeu. */
export async function list(_req, res) {
  return ok(res, { items: await controlPlane.listProviders() });
}

/** GET /api/integrated-apis/availability — le diagnostic d'ensemble. */
export async function availability(_req, res) {
  return ok(res, { items: await controlPlane.describeAllAvailability() });
}

/** GET /api/integrated-apis/:provider */
export async function detail(req, res) {
  return ok(res, await controlPlane.getProvider(req.params.provider));
}

/**
 * PUT /api/integrated-apis/:provider/credentials
 *
 * Corps : `{ environment: 'TEST'|'PROD'|null, values: {...}, remove: [...] }`
 *
 * ── POURQUOI L'ENVIRONNEMENT EST DANS LE CORPS, ET CE QUE ÇA NE VEUT PAS DIRE ─
 *
 * Il y est parce que l'administration doit pouvoir PRÉPARER les deux jeux
 * depuis une seule instance. C'est du provisionnement.
 *
 * Ce n'est PAS un sélecteur d'exécution. Aucune action métier n'acceptera
 * jamais un environnement venu du client : elle le résoudra depuis le runtime
 * (`resolveIntegratedApiEnvironment`). La distinction est documentée dans
 * `environment.js`, et c'est la seule qui empêche ce chantier d'être décoratif.
 */
export async function putCredentials(req, res) {
  const { environment = null, values, remove } = req.body ?? {};
  if (values !== undefined && (typeof values !== 'object' || Array.isArray(values) || values === null)) {
    throw ApiError.badRequest(
      'PANEL_INTEGRATED_API_VALUES_INVALID',
      'Enregistrement refusé : « values » doit être un objet { rôle: valeur }.',
    );
  }
  if (remove !== undefined && !Array.isArray(remove)) {
    throw ApiError.badRequest(
      'PANEL_INTEGRATED_API_REMOVE_INVALID',
      'Enregistrement refusé : « remove » doit être un tableau de noms de rôles.',
    );
  }
  const result = await controlPlane.saveCredentialSet(
    req.params.provider,
    environment,
    { values: values ?? {}, remove: remove ?? [] },
    { userId: req.panelUser?.userId ?? null },
  );
  return ok(res, result);
}

/**
 * POST /api/integrated-apis/:provider/validate
 *
 * Appel RÉEL au fournisseur, en lecture seule. Aucun paiement, aucun e-mail,
 * aucune signature, aucun webhook. Le verdict est persisté quelle qu'en soit
 * l'issue.
 */
export async function validate(req, res) {
  const { environment = null } = req.body ?? {};
  const result = await controlPlane.validateCredentialSet(req.params.provider, environment, {
    actor: { userId: req.panelUser?.userId ?? null },
  });
  return ok(res, result);
}

export default { list, availability, detail, putCredentials, validate };
