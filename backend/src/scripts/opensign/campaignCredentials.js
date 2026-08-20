// LES IDENTIFIANTS DE LA CAMPAGNE — lus au coffre, jamais ailleurs.
//
// Campagne de migration Yousign → OpenSign.
//
// ══ POURQUOI CE MODULE EXISTE ═══════════════════════════════════════════════
//
// Les scripts de recette ont besoin du jeton pour appeler le fournisseur. La
// tentation évidente est de le poser dans une variable d'environnement « le
// temps de la campagne » — et c'est exactement ainsi qu'un jeton finit dans un
// historique de shell, un fichier `.env` non ignoré, ou la sortie d'un `ps`.
//
// Le coffre du Panel EST la source. Un script qui en sort passe par ici, et par
// nulle part ailleurs.
//
// Ce module ne rend jamais les valeurs à l'appelant sous une forme
// journalisable : il rend l'objet `credentials` que le transport consomme, et
// une DESCRIPTION séparée qui, elle, est sûre à afficher.
import ApiError from '../../utils/ApiError.js';
import PanelIntegratedApiCredentialSet from '../../models/PanelIntegratedApiCredentialSet.model.js';
import { decryptCredentialSet } from '../../services/integratedApi/credentialVault.js';
import { checkHostForEnvironment } from '../../services/integratedApi/providerRegistry.js';

export const CAMPAIGN_ENVIRONMENT = 'TEST';

/**
 * Charge les identifiants OpenSign du bac à sable.
 *
 * @returns {Promise<{credentials: {apiToken: string, baseUrl: string},
 *                    webhookSecret: string|null,
 *                    describe: () => object}>}
 */
export async function loadOpenSignSandboxCredentials() {
  const document = await PanelIntegratedApiCredentialSet.findOne({
    provider: 'OPENSIGN', environment: CAMPAIGN_ENVIRONMENT, projectId: null,
  }).lean();

  if (!document) {
    throw ApiError.badRequest(
      'OPENSIGN_CREDENTIAL_SET_MISSING',
      'Aucun jeu OPENSIGN/TEST en base : le plan de contrôle n’a pas été amorcé.',
    );
  }

  const values = decryptCredentialSet('OPENSIGN', document.credentialsEncrypted, {
    environment: CAMPAIGN_ENVIRONMENT,
  });

  if (!values.apiToken) {
    throw ApiError.badRequest(
      'OPENSIGN_TOKEN_MISSING',
      'Le jeton OpenSign TEST n’est pas renseigné dans le Panel.',
    );
  }

  /**
   * L'HÔTE EST REVÉRIFIÉ ICI, ET CE N'EST PAS REDONDANT.
   *
   * Le coffre refuse déjà un hôte incohérent à l'ÉCRITURE. Mais un script de
   * campagne peut tourner des semaines après la saisie, sur une base restaurée
   * ou modifiée à la main. Envoyer un jeton de bac à sable à l'hôte de
   * production ne produit pas un message clair : il produit un refus
   * d'authentification qui ressemble à un jeton mort, et on cherche du mauvais
   * côté pendant une heure.
   */
  const baseUrl = values.baseUrl;
  const ecart = checkHostForEnvironment('OPENSIGN', 'baseUrl', CAMPAIGN_ENVIRONMENT, baseUrl);
  if (ecart) {
    throw ApiError.badRequest(
      'OPENSIGN_WRONG_HOST',
      `L’URL de base du jeu TEST vise « ${ecart.actual ?? '(illisible)'} » ; `
      + `attendu « ${ecart.expected} ». Aucune recette ne part sur cet hôte.`,
    );
  }

  return {
    credentials: { apiToken: values.apiToken, baseUrl },
    /** La clé de vérification du webhook — absente tant qu'elle n'est pas saisie. */
    webhookSecret: values.webhookSecret ?? null,
    /** Ce qu'on a le droit d'afficher. Aucune valeur secrète n'y figure. */
    describe: () => ({
      provider: 'OPENSIGN',
      environment: CAMPAIGN_ENVIRONMENT,
      baseUrl,
      status: document.status,
      apiTokenConfigured: true,
      webhookSecretConfigured: Boolean(values.webhookSecret),
    }),
  };
}

export default { loadOpenSignSandboxCredentials, CAMPAIGN_ENVIRONMENT };
