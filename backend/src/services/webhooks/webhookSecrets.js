// SECRETS DE WEBHOOK — le coffre du Panel, et lui seul (L5).
//
// docs/architecture/WEBHOOK_CONTROL_PLANE.md §« Secrets ».
//
// ── CINQ CAS, ET ILS NE SE TRAITENT PAS PAREIL ──────────────────────────────
//
//   A. secret rendu À LA CRÉATION SEULEMENT   Stripe (whsec_…), Yousign
//   B. secret RELISIBLE à la demande          aucun fournisseur actuel
//   C. pas de HMAC, jeton partagé             Brevo — c'est NOUS qui le posons
//   D. signature asymétrique                  aucun fournisseur actuel
//   E. pas de webhook du tout                 Hostinger
//
// Le cas A dicte toute la mécanique : si le secret local manque alors que
// l'endpoint distant existe, il n'y a AUCUN moyen honnête de le récupérer. La
// seule réparation est de recréer NOTRE endpoint pour en obtenir un neuf.
// Prétendre qu'un endpoint est « configuré » sans savoir vérifier ses appels
// serait le pire des états : vert à l'écran, sourd en réalité.
//
// Le cas C est l'inverse : nous frappons le jeton, donc nous pouvons le
// remplacer par un simple `update` — sans jamais perdre la capacité de
// vérifier, puisque l'ancien reste valable jusqu'à ce que le nouveau soit
// accepté par le fournisseur.
//
// ── OÙ LE SECRET NE VA JAMAIS ───────────────────────────────────────────────
//
// Pas dans un journal. Pas dans une réponse d'API. Pas dans le pont. Pas dans
// un diagnostic. Pas dans le binding. Les fonctions de ce fichier rendent soit
// la valeur (à un appelant interne compté), soit un BOOLÉEN — jamais un masque,
// jamais une empreinte partielle, parce qu'aucun écran n'en a besoin.
import { randomBytes } from 'node:crypto';

import { nowIso } from '../../bridge/bridgeContract.js';
import PanelIntegratedApiCredentialSet from '../../models/PanelIntegratedApiCredentialSet.model.js';
import {
  decryptCredentialSet,
  encryptCredentialValues,
  toPlainObject,
} from '../integratedApi/credentialVault.js';
import { getProviderDefinition } from '../integratedApi/providerRegistry.js';
import { webhookCapability, SECRET_DELIVERY } from './webhookRegistry.js';
import { WebhookError, WEBHOOK_DIAGNOSTIC } from './webhookDiagnostics.js';

/** Le jeu d'identifiants d'un fournisseur pour un monde donné, ou `null`. */
async function findCredentialSet(provider, environment) {
  return PanelIntegratedApiCredentialSet.findOne({
    provider: String(provider).toUpperCase(),
    environment,
    projectId: null,
  }).lean();
}

/**
 * Identifiants EN CLAIR d'un fournisseur — pour un pilote de webhook.
 *
 * Appelant légitime unique : `webhookReconciler.js`. Les valeurs ne vivent que
 * dans la portée de l'appel, ne sont jamais retournées à un contrôleur, et ne
 * traversent aucune frontière réseau autre que celle du fournisseur lui-même.
 */
export async function loadProviderCredentials(provider, environment) {
  const document = await findCredentialSet(provider, environment);
  if (!document) {
    throw new WebhookError(
      WEBHOOK_DIAGNOSTIC.WEBHOOK_CREDENTIALS_MISSING,
      `Aucun jeu d’identifiants ${provider} pour ${environment}.`,
    );
  }
  return decryptCredentialSet(provider, document.credentialsEncrypted, { environment });
}

/** Le secret de vérification est-il en place ? Un booléen, jamais la valeur. */
export async function hasWebhookSecret(provider, environment) {
  const capability = webhookCapability(provider);
  if (!capability?.secretRole) return false;
  const document = await findCredentialSet(provider, environment);
  const stored = toPlainObject(document?.credentialsEncrypted);
  return Boolean(stored[capability.secretRole]?.encrypted);
}

/**
 * Le secret EN CLAIR — pour la vérification d'un appel entrant, et rien d'autre.
 *
 * Rendu sous forme de LISTE de candidats. Aujourd'hui elle en contient zéro ou
 * un ; la forme prépare la fenêtre de rotation (accepter l'ancien secret le
 * temps que les événements en vol se vident) sans que la vérification n'ait à
 * changer de signature le jour où on l'ouvrira.
 */
export async function loadVerificationSecrets(provider, environment) {
  const capability = webhookCapability(provider);
  if (!capability?.secretRole) return [];
  const document = await findCredentialSet(provider, environment);
  const stored = toPlainObject(document?.credentialsEncrypted);
  if (!stored[capability.secretRole]?.encrypted) return [];
  const values = decryptCredentialSet(provider, document.credentialsEncrypted, { environment });
  const secret = values[capability.secretRole];
  return secret ? [secret] : [];
}

/**
 * Persiste un secret de webhook dans le coffre.
 *
 * ── POURQUOI PAS `saveCredentialSet()` ──────────────────────────────────────
 *
 * Cette écriture est celle d'un rôle `autoManaged` : elle vient de la machine,
 * pas d'un formulaire. `saveCredentialSet()` remet à zéro la preuve de
 * validation à chaque passage — ce qui est juste quand un humain remplace une
 * clé secrète, et faux ici : capturer le `whsec_…` d'un endpoint ne dit RIEN
 * sur la validité de la `sk_live_…` qui l'a créé. Passer par la porte des
 * humains ferait donc repasser au rouge un fournisseur parfaitement valide, à
 * chaque réconciliation.
 *
 * On réutilise en revanche le chiffrement, le garde-fou de préfixe et le
 * format de stockage du coffre : le secret n'est pas écrit autrement que les
 * autres, il est seulement écrit par un autre appelant.
 */
export async function storeWebhookSecret(provider, environment, secret) {
  const capability = webhookCapability(provider);
  const definition = getProviderDefinition(provider);
  if (!capability?.secretRole || !definition) {
    throw new WebhookError(
      WEBHOOK_DIAGNOSTIC.WEBHOOK_UNSUPPORTED,
      `Aucun rôle de secret déclaré pour ${provider}.`,
    );
  }
  if (!secret) {
    throw new WebhookError(
      WEBHOOK_DIAGNOSTIC.WEBHOOK_SIGNATURE_CONFIGURATION_INVALID,
      `Secret vide refusé pour ${provider} : un endpoint sans secret n’est pas vérifiable.`,
    );
  }

  const existing = await findCredentialSet(provider, environment);
  const { stored } = encryptCredentialValues({
    provider: definition.code,
    current: existing?.credentialsEncrypted,
    values: { [capability.secretRole]: secret },
    environment,
    actor: 'WEBHOOK_CONTROL_PLANE',
  });

  const at = nowIso();
  await PanelIntegratedApiCredentialSet.updateOne(
    { provider: definition.code, environment, projectId: null },
    {
      $set: { credentialsEncrypted: stored, updatedAt: at },
      $setOnInsert: {
        credentialSetId: `${definition.code}-${environment}-webhook`,
        scope: definition.scope,
        createdAt: at,
      },
    },
    { upsert: true },
  );

  // On NOMME le rôle, jamais sa valeur — la même discipline que le coffre.
  return { role: capability.secretRole, storedAt: at };
}

/**
 * Frappe un jeton partagé pour un fournisseur qui n'en fournit pas (cas C).
 *
 * 32 octets aléatoires en base64url : assez long pour qu'une comparaison à
 * temps constant soit la seule attaque, assez court pour tenir dans un en-tête
 * `Authorization` sans encodage supplémentaire.
 */
export function generateSharedSecret() {
  return randomBytes(32).toString('base64url');
}

/**
 * Quel secret utiliser à la CRÉATION d'un endpoint ?
 *
 * `null` quand le fournisseur le fabrique lui-même (cas A) : c'est sa réponse
 * qui l'apportera. Une valeur quand c'est à nous de le poser (cas C).
 */
export function secretToSupplyAtCreation(capability) {
  return capability.secretDelivery === SECRET_DELIVERY.CALLER_SUPPLIED
    ? generateSharedSecret()
    : null;
}

export default {
  loadProviderCredentials,
  hasWebhookSecret,
  loadVerificationSecrets,
  storeWebhookSecret,
  generateSharedSecret,
  secretToSupplyAtCreation,
};
