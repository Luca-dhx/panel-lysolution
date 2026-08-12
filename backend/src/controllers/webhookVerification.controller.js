// LA PORTE ÉTROITE — livrer un secret de VÉRIFICATION à son projet (L6.3A).
//
// ══ POURQUOI UNE ROUTE À PART, ET PAS UN CHAMP DANS UNE RÉPONSE ═════════════
//
// La tentation était de rendre le secret dans le résultat de la capacité
// `webhook.endpoint.ensure` : un champ de plus, aucune route à écrire. Elle a
// été écartée pour une raison précise.
//
// Le résultat d'une capacité traverse `assertNoProviderSecrets`, la garde L4
// qui refuse tout identifiant fournisseur. Y glisser un `whsec_` aurait exigé
// de la désactiver pour ce cas — c'est-à-dire d'ajouter un drapeau qui, une
// fois écrit, se serait propagé à la capacité suivante et à celle d'après.
// Une garde qu'on peut désactiver n'est plus une garde.
//
// Cette route fait l'inverse. Elle ne transporte QUE cela, et elle le vérifie :
// `assertVerificationSecretOnly` exige une charge d'exactement un champ, dont
// le nom est un rôle déclaré `verificationOnly` au registre, et dont la valeur
// a la forme d'un secret de signature. Une clé d'appel rangée sous ce nom est
// refusée par sa forme ; un champ en plus est refusé par le compte.
//
// ══ CE QUE LE PROJET NE PEUT PAS FAIRE ══════════════════════════════════════
//
// Il ne nomme pas le projet dont il veut le secret : `projectId` vient du jeton
// de pont, posé par `requireBridgeAuth`. Il ne nomme pas non plus l'endpoint.
// La seule chose qu'il puisse demander est « le mien », et il n'a aucun moyen
// d'en désigner un autre.
import { ok } from '../utils/apiResponse.js';
import ApiError from '../utils/ApiError.js';
import { assertVerificationSecretOnly } from '../bridge/providerSecretGuard.js';
import {
  readProjectVerificationSecret,
  markVerificationSecretDelivered,
} from '../services/webhooks/projectWebhookSecrets.js';
import { runtimeEnvironment } from '../services/integratedApi/environment.js';
import logger from '../utils/logger.js';

/** Les fournisseurs dont un projet peut recevoir un secret de vérification. */
const LIVRABLES = Object.freeze(new Set(['STRIPE']));

/**
 * `GET /bridge/v1/webhooks/:provider/verification-secret`
 *
 * Rend le secret courant, ou 404 s'il n'y en a pas — jamais un secret vide,
 * jamais celui d'un autre monde, jamais celui d'un autre projet.
 */
export async function fetchVerificationSecret(req, res) {
  const projectId = req.bridgeProject?.projectId ?? null;
  if (!projectId) {
    // Ne devrait pas arriver : la route est montée sous `requireBridgeAuth`.
    // Le vérifier quand même coûte une ligne et ferme la seule façon dont
    // cette route pourrait devenir anonyme — un remontage distrait.
    throw ApiError.unauthorized('Jeton de pont requis.');
  }

  const provider = String(req.params.provider ?? '').toUpperCase();
  if (!LIVRABLES.has(provider)) {
    /**
     * Une liste fermée, et non « tout fournisseur qui aurait un secret ».
     * Aujourd'hui Stripe est le seul dont les événements vont directement au
     * projet ; ouvrir la route aux autres livrerait le secret d'endpoints qui
     * pointent vers le Panel, et que le projet n'a aucune raison de vérifier.
     */
    throw ApiError.notFound(
      'PANEL_WEBHOOK_VERIFICATION_UNAVAILABLE',
      `Aucun secret de vérification n’est livrable pour ${provider}.`,
    );
  }

  /**
   * LE MONDE VIENT DU PANEL, pas de la demande.
   *
   * Un projet TEST qui réclamerait le secret PROD obtiendrait de quoi vérifier
   * des événements de production — donc de quoi les traiter. L'environnement
   * est celui que CE Panel sert, et il n'est pas négociable.
   */
  const environment = runtimeEnvironment();

  const found = await readProjectVerificationSecret({ projectId, provider, environment });
  if (!found) {
    throw ApiError.notFound(
      'PANEL_WEBHOOK_VERIFICATION_SECRET_MISSING',
      'Aucun secret de vérification n’est enregistré pour ce projet : '
      + 'demandez d’abord le provisionnement de l’endpoint.',
    );
  }

  const payload = { [found.role]: found.secret };

  /**
   * LA GARDE DU CANAL — posée ici, sur ce que l'on s'apprête RÉELLEMENT à
   * écrire, et non sur ce qu'on croit avoir construit. C'est la différence
   * entre une intention et une vérification.
   */
  assertVerificationSecretOnly(payload, { label: 'verification' });

  await markVerificationSecretDelivered({ projectId, provider, environment });
  // Le journal dit QU'IL Y A eu livraison, à qui, et pour quel monde. Jamais
  // la valeur, jamais ses quatre derniers caractères — un journal se recopie.
  logger.info(
    `[webhooks] secret de vérification livré à ${projectId} (${provider}, ${environment}).`,
  );

  return ok(res, payload);
}

export default { fetchVerificationSecret };
