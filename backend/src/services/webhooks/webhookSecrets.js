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
 * Les secrets EN CLAIR acceptables MAINTENANT — pour vérifier un appel entrant.
 *
 * ── POURQUOI UNE LISTE, ET PAS UNE VALEUR ───────────────────────────────────
 *
 * Le jour où le secret change, des événements sont DÉJÀ EN VOL : produits par
 * le fournisseur avant la rotation, livrés après, signés de l'ancien secret.
 * Les refuser en 401 les perd définitivement — aucun fournisseur ne rejoue un
 * événement qu'il croit livré-et-refusé pour de bon.
 *
 * L'ancien secret reste donc accepté pendant `secretRotationWindowMs`, et pas
 * une seconde de plus : la fenêtre est bornée par `rotatedAt`, jamais ouverte
 * « en attendant ».
 *
 * @param {object} [options]
 * @param {string|null} [options.rotatedAt]  horodatage ISO de la rotation
 * @param {number} [options.now]             injectable pour la recette
 */
export async function loadVerificationSecrets(provider, environment, { rotatedAt = null, now = Date.now() } = {}) {
  const capability = webhookCapability(provider);
  if (!capability?.secretRole) return [];
  const document = await findCredentialSet(provider, environment);
  const stored = toPlainObject(document?.credentialsEncrypted);
  if (!stored[capability.secretRole]?.encrypted) return [];

  const values = decryptCredentialSet(provider, document.credentialsEncrypted, { environment });
  const current = values[capability.secretRole];
  if (!current) return [];

  const previous = capability.secretPreviousRole ? values[capability.secretPreviousRole] : null;
  if (!previous || !isRotationWindowOpen(capability, rotatedAt, now)) return [current];

  // L'ordre compte pour la lisibilité, pas pour la sécurité : les deux sont
  // comparés à temps constant, et le premier qui correspond gagne.
  return current === previous ? [current] : [current, previous];
}

/** La fenêtre de tolérance est-elle encore ouverte ? Fermée par défaut. */
export function isRotationWindowOpen(capability, rotatedAt, now = Date.now()) {
  if (!rotatedAt) return false;
  const started = Date.parse(rotatedAt);
  if (!Number.isFinite(started)) return false;
  return now - started < (capability?.secretRotationWindowMs ?? 0);
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
 * ROTATION — le nouveau secret prend la place, l'ancien recule d'un cran.
 *
 * ── CE QUE CETTE FONCTION GARANTIT ──────────────────────────────────────────
 *
 * À aucun instant le Panel ne perd la capacité de vérifier un appel : l'ancien
 * secret est écrit AVANT que le nouveau ne le remplace, dans la même écriture.
 * Un processus tué au milieu laisse donc soit l'ancien état complet, soit le
 * nouveau — jamais un coffre sans secret du tout.
 *
 * L'appelant est responsable d'horodater la rotation sur le binding
 * (`secretRotatedAt`) : c'est cette date qui referme la fenêtre. Sans elle, la
 * fenêtre reste FERMÉE — le défaut sûr.
 *
 * @returns {Promise<{role: string, rotated: boolean, at: string}>}
 *   `rotated: false` = première pose, il n'y avait rien à faire reculer.
 */
export async function rotateWebhookSecret(provider, environment, secret) {
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
      `Rotation refusée pour ${provider} : un secret vide ne vérifie rien.`,
    );
  }

  const existing = await findCredentialSet(provider, environment);
  const stored = toPlainObject(existing?.credentialsEncrypted);
  const hadCurrent = Boolean(stored[capability.secretRole]?.encrypted);

  const values = { [capability.secretRole]: secret };
  if (hadCurrent && capability.secretPreviousRole) {
    // On déplace la valeur CHIFFRÉE telle quelle plutôt que de la déchiffrer
    // pour la rechiffrer : moins de manipulations en clair, moins d'occasions
    // de la laisser traîner dans une variable.
    stored[capability.secretPreviousRole] = { ...stored[capability.secretRole] };
  }

  const { stored: next } = encryptCredentialValues({
    provider: definition.code,
    current: stored,
    values,
    environment,
    actor: 'WEBHOOK_CONTROL_PLANE',
  });

  const at = nowIso();
  await PanelIntegratedApiCredentialSet.updateOne(
    { provider: definition.code, environment, projectId: null },
    {
      $set: { credentialsEncrypted: next, updatedAt: at },
      $setOnInsert: {
        credentialSetId: `${definition.code}-${environment}-webhook`,
        scope: definition.scope,
        createdAt: at,
      },
    },
    { upsert: true },
  );

  return { role: capability.secretRole, rotated: hadCurrent, at };
}

/**
 * Efface le secret retiré une fois la fenêtre close.
 *
 * Un secret qu'on n'accepte plus n'a AUCUNE raison de rester en base : le
 * garder n'ajoute qu'une valeur à protéger. L'effacement est idempotent, et
 * rendu `false` quand il n'y avait rien à faire.
 */
export async function purgeExpiredPreviousSecret(provider, environment, { rotatedAt = null, now = Date.now() } = {}) {
  const capability = webhookCapability(provider);
  if (!capability?.secretPreviousRole) return { purged: false };
  if (isRotationWindowOpen(capability, rotatedAt, now)) return { purged: false };

  const document = await findCredentialSet(provider, environment);
  const stored = toPlainObject(document?.credentialsEncrypted);
  if (!stored[capability.secretPreviousRole]) return { purged: false };

  await PanelIntegratedApiCredentialSet.updateOne(
    { provider: capability.provider, environment, projectId: null },
    {
      $unset: { [`credentialsEncrypted.${capability.secretPreviousRole}`]: '' },
      $set: { updatedAt: nowIso() },
    },
  );
  return { purged: true };
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
  isRotationWindowOpen,
  storeWebhookSecret,
  rotateWebhookSecret,
  purgeExpiredPreviousSecret,
  generateSharedSecret,
  secretToSupplyAtCreation,
};
