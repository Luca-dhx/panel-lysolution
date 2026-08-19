// LA FÉDÉRATION D'IDENTITÉ — surface HTTP (L12.A).
//
// Deux surfaces de natures OPPOSÉES vivent dans ce fichier, et la distinction
// gouverne tout leur montage :
//
//   PUBLIQUE   le jeu de clés. Il ne contient que des clés publiques, il doit
//              être joignable par un projet qui n'est pas encore authentifié,
//              et le cacher ne protégerait rien : une clé publique est faite
//              pour être connue.
//
//   OPÉRATEUR  l'émission d'assertion. Elle exige une session Panel, et elle
//              ne lit du corps AUCUNE identité — ni utilisateur, ni rôle, ni
//              version. Tout vient de la session prouvée et de la base.
import { ok } from '../utils/apiResponse.js';
import ApiError from '../utils/ApiError.js';
import { publicJwks, describeKeys } from '../services/federation/federationKeys.service.js';
import {
  ASSERTION_TTL_SECONDS,
  FEDERATION_ISSUER,
  issueProjectAssertion,
} from '../services/federation/federationAssertion.service.js';
import { FederationDenied } from '../services/federation/federationErrors.js';
import { validateReturnUrl } from '../services/federation/federationReturnUrl.js';

/**
 * `GET /api/federation/.well-known/jwks.json`
 *
 * ── POURQUOI UN CONTRAT DÉDIÉ, ET PAS LE BOOTSTRAP DU PONT ─────────────────
 *
 * Le lot l'interdit explicitement, et il a raison sur deux plans :
 *
 *   · TECHNIQUE — `bootstrapResponseSchema` est `.strict()`. Y glisser une clé
 *     imposerait un incrément de version du contrat de pont, donc de rendre
 *     incompatibles des projets qui n'ont rien demandé.
 *
 *   · DE FOND — le bootstrap est un acte d'APPAIRAGE, joué une fois. Une clé
 *     tourne. Attacher un objet qui change à un événement qui n'arrive qu'une
 *     fois, c'est garantir qu'on ne pourra jamais le mettre à jour.
 *
 * Le cache est court : une clé retirée doit disparaître des vérificateurs en
 * minutes, pas en heures. `public` parce qu'il n'y a rien à protéger.
 */
export async function getJwks(_req, res) {
  const jwks = await publicJwks();
  res.set('cache-control', 'public, max-age=300');
  return res.json(jwks);
}

/** Le catalogue des clés, pour un opérateur. Aucune clé privée n'y figure. */
export async function listFederationKeys(_req, res) {
  return ok(res, await describeKeys());
}

/**
 * `POST /api/federation/projects/:projectId/assertion`
 *
 * ── CE QUE LE CORPS NE PEUT PAS DIRE ───────────────────────────────────────
 *
 * Rien. Le corps n'est pas lu du tout, et c'est la forme la plus sûre de la
 * règle : `panelUserId` vient de la session que `requirePanelUser` a prouvée,
 * `role` et `tokenVersion` sont relus en base au moment de signer, et le projet
 * vient du chemin, validé côté serveur contre le registre.
 *
 * Un corps qui porterait l'un de ces champs est donc inerte — mais on le refuse
 * quand même : un champ toléré finit par être branché « puisqu'il était déjà
 * envoyé ». C'est la leçon du lot précédent, appliquée ici d'avance.
 */
const FORBIDDEN_BODY_FIELDS = Object.freeze([
  'panelUserId', 'userId', 'sub', 'role', 'tokenVersion', 'enabled', 'projectAccess', 'kid', 'exp',
]);

export async function postProjectAssertion(req, res) {
  const found = FORBIDDEN_BODY_FIELDS
    .filter((field) => Object.prototype.hasOwnProperty.call(req.body ?? {}, field));
  if (found.length) {
    throw ApiError.badRequest(
      'FEDERATION_IDENTITY_IN_BODY',
      'L’identité d’une assertion ne se déclare pas dans le corps : elle est dérivée de la session '
      + `Panel et relue en base. Champs refusés : ${found.join(', ')}.`,
    );
  }

  /**
   * L'ADRESSE DE RETOUR — VALIDÉE AVANT D'ÉMETTRE, JAMAIS APRÈS.
   *
   * ── LA FAILLE QUE CET ORDRE FERME ─────────────────────────────────────────
   *
   * Le parcours se termine par une redirection qui TRANSPORTE l'assertion. Une
   * adresse de retour non contrôlée suffirait à se la faire livrer : on forge
   * un lien vers le Panel avec `returnUrl` chez soi, on l'envoie à un
   * développeur déjà connecté, et le Panel émet puis délivre une assertion
   * parfaitement valide. Rien n'aurait été forcé — on l'aurait donnée.
   *
   * Valider AVANT d'émettre évite en plus de laisser une trace d'émission pour
   * un jeton qui ne partira pas : le journal doit refléter ce qui a eu lieu.
   */
  let returnUrl = null;
  if (req.body?.returnUrl !== undefined) {
    const verdict = await validateReturnUrl(req.body.returnUrl, { projectId: req.params.projectId });
    if (!verdict.valid) {
      throw ApiError.badRequest(
        verdict.reasonCode,
        'Adresse de retour refusée : elle doit appartenir à une origine que le Panel connaît '
        + 'déjà pour ce projet.',
      );
    }
    returnUrl = verdict.url;
  }

  try {
    const issued = await issueProjectAssertion({
      // La session prouvée — jamais une valeur de requête.
      panelUserId: req.panelUser.userId,
      projectId: req.params.projectId,
      requestedBy: req.panelUser.email ?? null,
    });
    return ok(res, {
      ...issued,
      /** Recomposée par le Panel, jamais celle qu'on a reçue. */
      returnUrl,
      issuer: FEDERATION_ISSUER,
      ttlSeconds: ASSERTION_TTL_SECONDS,
    });
  } catch (error) {
    /**
     * UN REFUS DE FÉDÉRATION EST UN 403, PAS UN 500.
     *
     * L'appelant est un opérateur authentifié du Panel : lui dire POURQUOI est
     * utile et sans risque — il connaît déjà l'existence du projet, puisqu'il
     * vient de le nommer depuis un écran qui le lui a montré.
     */
    if (error instanceof FederationDenied) {
      throw ApiError.forbidden(error.reasonCode, error.message);
    }
    throw error;
  }
}

export default { getJwks, listFederationKeys, postProjectAssertion };
